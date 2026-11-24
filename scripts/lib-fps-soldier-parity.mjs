// Verifica el arte distribuido y la geometría que acaba en la GPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Box3, Group, Matrix4, ShaderLib, Vector3 } from 'three';
import { readGLB } from './simplify-soldier-art.mjs';
import { bakeSoldierBody, SOLDIER_TEAM } from '../src/player/soldier-bake.js';

const read = name => readGLB(fileURLToPath(new URL('../public/assets/' + name + '.glb', import.meta.url)));
const soldier = read('characters/blender/soldier-blender-body');

function span(data, key, axis) {
  const box = new Box3();
  for (const node of data.json.nodes) {
    if (node.mesh == null || (key && key !== node.name)) continue;
    const pivot = new Vector3().fromArray(node.translation ?? [0, 0, 0]);
    for (const p of data.json.meshes[node.mesh].primitives) {
      const a = data.json.accessors[p.attributes.POSITION];
      for (const point of [a.min, a.max]) box.expandByPoint(new Vector3(...point).add(pivot));
    }
  }
  return box.max[axis] - box.min[axis];
}

const width = span(soldier, 'segment_hand_R', 'x');
const weapons = new Map();
export function checkSoldierScale(vm, key) {
  if (!weapons.has(key)) {
    const fp = read('fp/' + key), world = read('weapons/' + key);
    const axis = vm.prof.thrown ? 'y' : 'z';
    weapons.set(key, { fp: span(fp, null, axis), world: span(world, null, axis) * world.json.nodes[0].extras.worldScale });
  }
  const art = weapons.get(key), scale = vm.arms.seg.R.hand.getWorldScale(new Vector3()).x;
  assert.ok(Math.abs(scale - (vm.prof.triggerArm?.scale ?? 1)) < 1e-6, key + ': soldado a escala natural');
  const gun = vm.weapons[key].partBones.body.bone.getWorldScale(new Vector3());
  assert.ok(Math.abs(gun.x - gun.y) + Math.abs(gun.y - gun.z) < 1e-6, key + ': arma uniforme');
  for (const bone of [...vm.armsMesh.skeleton.bones, ...vm.leg.mesh.skeleton.bones]) {
    const size = bone.getWorldScale(new Vector3());
    const support = vm.prof.supportArm;
    const expected = bone === vm.arms.seg.R.fore ? vm.prof.triggerArm?.sleeveScale ?? 1
      : bone.name.startsWith('fp_R_') ? scale : bone === vm.arms.seg.L.fore ? support?.sleeveScale ?? scale
      : /^fp_(?:hand_L$|L_)/.test(bone.name) ? support?.scale ?? 1 : 1;
    assert.ok(size.distanceTo(new Vector3(expected, expected, expected)) < 1e-6, key + ': grosor de ' + bone.name);
  }
  const third = width / art.world, first = width / (art.fp * gun.z);
  assert.ok(Math.abs(first / third - 1) <= .05, key + ': proporción mano/arma');
  return { key, scale, third, first };
}

// Firma del flujo que recibe la GPU, independiente del reindexado del GLB.
function huella(data, node) {
  const hash = createHash('sha256');
  for (const p of data.json.meshes[node.mesh].primitives) {
    hash.update(data.json.materials[p.material].name);
    const indices = data.accessor(p.indices);
    for (const atributo of ['POSITION', 'NORMAL']) {
      const fuente = data.accessor(p.attributes[atributo]);
      const valores = new Float32Array(3 * indices.length);
      for (const [i, v] of indices.entries()) valores.set(fuente.subarray(v * 3, v * 3 + 3), 3 * i);
      hash.update(Buffer.from(valores.buffer));
    }
  }
  return hash.digest('hex');
}

// Se cruzan las caras orientadas, incluidos duplicados y material de origen.
// Se acepta sólo el redondeo a float32 al cambiar de marco de articulación.
export function checkSoldierTriangles() {
  const coords = new Vector3(), expected = new Map();
  const cell = n => Math.round(n * 100000);
  const indexOf = (p, grid) => {
    const x = cell(p.x), y = cell(p.y), z = cell(p.z);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const el of grid.get([x+a,y+b,z+c].join(',')) ?? []) if (el.p.distanceToSquared(p) < 1e-14) return el.id;
    }
    const id = p.toArray().join(','), k = [x,y,z].join(',');
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ id, p: p.clone() });
    return id;
  };
  function visit(data, n, segment, bind, delta) {
    const row = expected.get(segment);
    for (const p of data.json.meshes[n.mesh].primitives) {
      const positions = data.accessor(p.attributes.POSITION), indices = data.accessor(p.indices);
      const ids = Array.from({ length: positions.length / 3 }, (_, i) => {
        coords.fromArray(positions, i * 3).applyMatrix4(bind);
        return indexOf(coords, row.grid);
      });
      for (let i = 0; i < indices.length; i += 3) {
        const key = [p.material, ids[indices[i]], ids[indices[i+1]], ids[indices[i+2]]].join('/');
        row.faces.set(key, (row.faces.get(key) ?? 0) + delta);
      }
    }
  }
  for (const n of soldier.json.nodes) {
    if (!/^segment_(?:(?:forearm|upper_arm)_[LR]|(?:foot|kneecap|thigh|shin)_R)$/.test(n.name)) continue;
    expected.set(n.name, { grid: new Map(), faces: new Map() });
    visit(soldier, n, n.name, new Matrix4(), 1);
  }
  for (const model of ['arms','kick-leg']) {
    const data = read('fp/' + model);
    for (const n of data.json.nodes) {
      const source = n.extras?.segment;
      if (n.name.startsWith('forearm_') || n.name.startsWith('upper_arm_')) {
        const original = soldier.json.nodes.find(o => o.name === 'segment_' + n.name);
        assert.equal(huella(data, n), huella(soldier, original), n.name + ': huella de geometría y normales del GLB');
      }
      if (expected.has(source)) visit(data, n, source, new Matrix4().fromArray(n.extras.bind), -1);
    }
  }
  for (const [segment, row] of expected) assert.ok([...row.faces.values()].every(count => count === 0), segment + ': mismos triángulos y materiales');
}

// Hornear los segmentos de tercera persona con el código del personaje.
// Un hueso por primitiva identifica el material que llegó al búfer de mundo.
function paletaDelModelo(modelo, team, variant) {
  const root = new Group();
  for (const original of modelo.children) {
    const segmento = new Group();
    segmento.name = original.name;
    root.add(segmento);
    original.traverse(o => {
      if (!o.isMesh) return;
      const hueso = new Group(), copia = o.clone(false);
      hueso.name = o.material.name;
      copia.geometry = o.geometry.clone();
      hueso.add(copia);
      segmento.add(hueso);
    });
  }
  const cuerpo = bakeSoldierBody({ root, team, variant, blenderSoldier: true });
  const { skinIndex, color, aSurf, aDetail } = cuerpo.geometry.attributes;
  const muestras = new Map();
  for (let i = 0; i < skinIndex.count; i++) {
    const id = skinIndex.getX(i);
    if (i && skinIndex.getX(i - 1) === id) continue;
    const hueso = cuerpo.skeleton.bones[id];
    muestras.set(hueso.parent.name + '/' + hueso.name, {
      color: color.array.slice(i * 3, i * 3 + 3),
      surface: aSurf.array.slice(i * 4, i * 4 + 4),
      kind: aDetail.array[i * 2],
    });
  }
  return { material: cuerpo.material, muestras };
}

// Compara cada vértice de cada variante con la paleta del soldado.
export function checkSoldierPalette(vm, assets, variant, team) {
  const { material: world, muestras } = paletaDelModelo(assets.soldier, team, variant);
  for (const [mesh, source] of [[vm.armsMesh, assets.arms], [vm.leg.mesh, assets['kick-leg']]]) {
    assert.equal(mesh.material.userData.fpUniforms.uTeam.value.getHex(), SOLDIER_TEAM[team]);
    const shader = { ...ShaderLib.standard, uniforms: {} };
    mesh.material.onBeforeCompile(shader);
    assert.match(shader.fragmentShader, /float sRim =/);
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'roughness', 'metalness']) {
      assert.equal(mesh.material[key], world[key], key + ': parámetro del material de mundo');
    }
    for (const [key, uniform] of Object.entries(world.userData.soldierUniforms)) {
      assert.equal(shader.uniforms[key], uniform, key + ': uniforme compartido con el modelo');
    }
    if (mesh === vm.armsMesh) {
      assert.equal(shader.uniforms.uVmFill, vm.weapons[vm.key].mesh.material.userData.fpUniforms.uVmFill);
    }
    const { skinIndex, color, aSurf, aDetail, position, normal } = mesh.geometry.attributes;
    const seen = new Map();
    for (let i = 0; i < skinIndex.count; i++) {
      const raiz = mesh.geometry.userData.skinRoots?.[skinIndex.getX(i)];
      const bone = mesh.skeleton.bones[raiz ?? skinIndex.getX(i)];
      if (!seen.has(bone)) {
        const name = bone.name.replace(/^fp_(?:kick_)?/, '').replace(/^fore_/, 'forearm_');
        const nodes = raiz !== undefined ? ['anatomica_' + name[0]] : name === 'shin' ? ['kneecap', 'shin'] : name.startsWith('forearm_') ? [name, name.replace('forearm_', 'upper_arm_')] : [name];
        const runs = [];
        for (const id of nodes) {
          const n = source.getObjectByName(id);
          const region = raiz !== undefined ? 'hand_' + name[0] : id;
          const segmento = 'segment_' + (mesh === vm.armsMesh ? region : id + '_R');
          for (const m of [n, ...n.children].filter(o => o.isMesh && (o === n || o.name.startsWith('m_')))) {
            const muestra = muestras.get(segmento + '/' + m.material.name);
            assert.ok(muestra, segmento + ': material presente en el modelo de mundo');
            runs.push({ ...muestra, geometry: m.geometry, cursor: 0,
              offsetY: id.startsWith('upper_arm_') ? -source.getObjectByName(name).position.y : 0 });
          }
        }
        seen.set(bone, runs);
      }
      const runs = seen.get(bone), r = runs[0];
      assert.ok(r, bone.name + ': primitiva del soldado');
      assert.equal(aDetail.array[i * 2], r.kind, bone.name + ': acabado del soldado');
      assert.ok(r.surface.every((v, j) => v === aSurf.array[i * 4 + j]) &&
        r.color.every((v, j) => v === color.array[i * 3 + j]), bone.name + ': paleta del soldado');
      const index = r.geometry.index.getX(r.cursor++);
      if (raiz !== undefined) for (let j = 0; j < 4; j++) {
        assert.equal(skinIndex.getComponent(i,j) - raiz, r.geometry.attributes._fp_joints.getComponent(index,j));
        assert.equal(mesh.geometry.attributes.skinWeight.getComponent(i,j), r.geometry.attributes._fp_weights.getComponent(index,j));
      }
      for (let j = 0; j < 3; j++) {
        assert.equal(position.getComponent(i, j), Math.fround(r.geometry.attributes.position.getComponent(index, j) + (j === 1 ? r.offsetY : 0)));
        assert.equal(normal.getComponent(i, j), r.geometry.attributes.normal.getComponent(index, j));
      }
      if (r.cursor === r.geometry.index.count) runs.shift();
    }
    for (const runs of seen.values()) assert.equal(runs.length, 0);
  }
}
