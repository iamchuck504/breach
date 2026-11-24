// Mallas dibujadas y relojes reales, sin renderizador ni servidor.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Frustum, Matrix4, PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TUNING } from '../src/config/tuning.js';
import { SOLDIER_SKINS } from '../src/player/soldier-skins.js';
import { SOLDIER_TEAM } from '../src/player/soldier-bake.js';
import { viewModelUniforms } from '../src/render/pipeline.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import { createViewModel } from '../src/view/fp/viewmodel.js';
import { silhouette } from '../src/view/fp/silhouette.js';
import { blocks, prepare, surfaces } from './lib-fps-hand-geometry.mjs';
import { checkSoldierPalette } from './lib-fps-soldier-parity.mjs';

async function model(url) {
  const bytes = await readFile(url);
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
}
const assets = {};
for (const key of ['arms', 'kick-leg', ...Object.keys(PROFILES)]) {
  assets[key] = await model(new URL(`../public/assets/fp/${key}.glb`, import.meta.url));
}
const source = await model(new URL('../public/assets/characters/blender/soldier-blender-body.glb', import.meta.url));
assets.soldier = source;
for (const name of ['thigh', 'kneecap', 'shin', 'foot']) {
  const original = new Box3().setFromObject(source.getObjectByName(`segment_${name}_R`));
  const baked = new Box3().setFromObject(assets['kick-leg'].getObjectByName(name));
  const expected = original.getSize(new Vector3());
  if (name === 'thigh' || name === 'shin') expected.y *= 0.87;
  assert.ok(baked.getSize(new Vector3()).distanceTo(expected) < 0.0005, `${name}: mismo volumen que el segmento del soldado`);
  if (name === 'foot') assert.ok(Math.abs(baked.min.y - (original.min.y + 0.32)) < 0.0005, 'La bota pivota sobre el tobillo');
}
const vm = createViewModel({ scene: new Scene(), camera: new PerspectiveCamera(72, 16 / 9), assets });
await vm.ready;
assert.ok(vm.setWeapon('smg'), 'Arma equipada para comparar los materiales de la patada');
const { thigh, shin, boot, mesh } = vm.leg;
for (const team of ['red', 'blue']) {
  vm.setTeam(team);
  assert.equal(mesh.material.userData.fpUniforms.uTeam.value.getHex(), SOLDIER_TEAM[team]);
  for (let i = 0; i < SOLDIER_SKINS.length; i++) {
    vm.setVariant(i);
    checkSoldierPalette(vm, assets, i, team);
  }
}
vm.setVariant(0);
const leg = [...surfaces(mesh).values()];
const arms = [...surfaces(vm.armsMesh, bone => !bone.name.includes('grenade')).values()];
const point = new Vector3(), lateral = new Vector3(), forward = new Vector3(0, 0, -1);
const kneePole = new Vector3(0.05, 0.7, -1);
const target = forward.clone().multiplyScalar(2);
const projection = viewModelUniforms.uVMProj.value;
const ml = TUNING.melee;
let near = Infinity, top = -Infinity, tests = 0;

// Leer solo los píxeles que sobreviven a la profundidad del arma y los
// brazos. La esquina reservada cubre vida y munición en las tiras de 720p.
function visibleLeg() {
  const { names, owner, width } = silhouette(vm, projection, 320, 180);
  const shinId = names.indexOf(shin.name), bootId = names.indexOf(boot.name);
  let shinPixels = 0, bootPixels = 0, toeY = 180;
  for (let i = 0; i < owner.length; i++) {
    const y = Math.floor(i / width);
    if (i % width < 96 && y >= 144) continue;
    if (owner[i] === shinId) shinPixels++;
    if (owner[i] === bootId) {
      bootPixels++;
      toeY = Math.min(toeY, y);
    }
  }
  return { shinPixels, bootPixels, toeY };
}

// Si dos cajas de triángulo en el mismo espacio no se tocan, tampoco
// lo hacen sus superficies. El árbol reduce la comprobación a las cajas
// de las piezas que realmente se acercan, incluidos cañón y cargador.
const local = new Matrix4(), box = new Box3();
const screen = new Frustum(), legFrustum = new Frustum(), legProjection = new Matrix4(), common = new Box3();
function apart(a, b, armMatrix) {
  if (!box.copy(a.box).applyMatrix4(local).intersectsBox(b.box)) return true;
  // La bocamanga se prolonga fuera de campo hacia un codo virtual. Solo se
  // dibuja su tramo interior al frustum; el arma se mide entera.
  if (armMatrix && !screen.intersectsBox(common.copy(box).intersect(b.box).applyMatrix4(armMatrix))) return true;
  if (!a.faces) return apart(a.left, b, armMatrix) && apart(a.right, b, armMatrix);
  if (!b.faces) return apart(a, b.left, armMatrix) && apart(a, b.right, armMatrix);
  return a.faces.every(face => {
    if (armMatrix && legFrustum.planes.some(p => p.distanceToPoint(face.tri.a) < 0 &&
      p.distanceToPoint(face.tri.b) < 0 && p.distanceToPoint(face.tri.c) < 0)) return true;
    box.copy(face.box).applyMatrix4(local);
    return b.faces.every(other => !box.intersectsBox(other.box) ||
      (armMatrix && !screen.intersectsBox(common.copy(box).intersect(other.box).applyMatrix4(armMatrix))));
  });
}
function measure(t, end, label) {
  const phase = vm.anim.kick.phase;
  const pelvis = thigh.position, knee = shin.position, ankle = boot.position;
  const scale = 1 / vm.root.scale.x;
  for (const bone of [thigh, shin, boot]) {
    assert.ok(bone.getWorldScale(point).distanceTo(new Vector3(1, 1, 1)) < 1e-6, 'Pierna a la escala del soldado');
  }
  assert.ok(point.copy(pelvis).applyMatrix4(projection).y < -1, 'La cadera queda debajo del borde');
  // Rodilla por delante de la recta cadera-tobillo, del lado del polo
  // original, también en recogida (sin colapso de longitudes o hiperextensión).
  const axis = point.subVectors(ankle, pelvis).normalize();
  const side = lateral.subVectors(knee, pelvis);
  side.addScaledVector(axis, -side.dot(axis));
  assert.ok(side.dot(kneePole) > 0, 'Flexión frontal de rodilla');
  for (const seg of [thigh, shin]) {
    assert.ok(point.set(1, 0, 0).applyQuaternion(seg.quaternion).x > 0.85, 'La placa gira alrededor de la bisagra lateral');
  }
  for (const length of [pelvis.distanceTo(knee), knee.distanceTo(ankle)]) {
    assert.ok(Math.abs(length / scale - 0.32 * 0.87) < 1e-6, 'Las longitudes se conservan durante toda la patada');
  }
  let yMax = -Infinity;
  for (const seg of leg) {
    prepare(seg);
    for (const v of seg.points) {
      point.copy(v).applyMatrix4(seg.bone.matrixWorld);
      near = Math.min(near, -point.z);
      yMax = Math.max(yMax, point.applyMatrix4(projection).y);
    }
    if (phase !== 'strike') assert.ok(!blocks(seg, target), `Retícula ocupada: ${label}`);
  }
  if (t === 0 || end - t < 0.001) assert.ok(yMax < -1, 'Recogida completa fuera de pantalla');
  if (Math.abs(t - ml.hitAt) < 1e-6) {
    assert.ok(yMax > -0.20 && yMax < 0.15, 'La bota llega cerca del centro en el contacto');
    assert.ok(point.set(0, -1, 0).applyQuaternion(boot.quaternion).dot(forward) > 0.85, 'Suela dirigida al blanco');
    top = Math.max(top, yMax);
  }
  assert.ok(near > 0.01, `La geometría cruza el plano cercano: ${label}`);
}

for (const key of Object.keys(PROFILES)) {
  vm.setWeapon(key);
  const weapon = [...surfaces(vm.weapons[key].mesh).values()];
  const nearby = [...weapon.map(surface => ({ surface, arm: false })), ...arms.map(surface => ({ surface, arm: true }))];
  const tris = [mesh, vm.armsMesh, vm.weapons[key].mesh].reduce((n, m) => n + m.geometry.attributes.position.count / 3, 0);
  assert.ok(tris <= 45_000, `${key}: presupuesto de arma, brazos y pierna`);
  for (const hz of [30, 60, 144]) for (const aim01 of [0, 1]) for (const connected of [true, false]) {
    const dt = 1 / hz, end = connected ? ml.hitAt + ml.hitRecovery : ml.time;
    const rest = { aim01, speed: 0, bob: 0 };
    for (let i = 0; i < hz; i++) vm.update(dt, rest);
    const initialGrip = vm.anchorCam('grip', new Vector3()).clone();
    assert.ok(!mesh.visible, 'Oculta en reposo');
    vm.event('meleeStart', { total: ml.time, authoritative: true });
    let hit = false, previous = -dt, chamberView;
    for (let frame = 0; frame <= Math.ceil(end * hz); frame++) {
      // Incluir el instante exacto junto a los cuadros de una pantalla real.
      const elapsed = Math.min(end, frame / hz);
      const times = !hit && elapsed > ml.hitAt ? [ml.hitAt, elapsed] : [elapsed];
      for (const t of times) {
        if (t >= ml.hitAt && !hit) {
          vm.event('meleeHit', { elapsed: ml.hitAt, total: end, connected });
          hit = true;
        }
        vm.update(t - previous, { aim01: 0, speed: 0, meleeElapsed: t, meleeEnd: hit ? end : ml.time });
        previous = t;
        if (t >= end) { assert.ok(!mesh.visible, 'Oculta al terminar'); continue; }
        assert.ok(mesh.visible);
        const label = `${key}/${hz}Hz/ADS${aim01}/${t.toFixed(3)}`;
        measure(t, end, label);
        if (hz === 60 && connected) {
          if (vm.anim.kick.phase === 'windup') chamberView = visibleLeg();
          if (Math.abs(t - ml.hitAt) < 1e-6) {
            const impact = visibleLeg();
            if (!aim01) {
              const grip = vm.anchorCam('grip', point);
              assert.ok(grip.y < initialGrip.y - 0.02 && grip.x > initialGrip.x + 0.01, 'El arma baja y se aparta: ' + label);
            }
            assert.ok(chamberView.shinPixels > 200 && impact.shinPixels > 200, 'Rodillera visible: ' + label);
            assert.ok(impact.bootPixels > 300 && chamberView.toeY - impact.toeY > 22, 'La puntera sube fuera del HUD: ' + label);
          }
        }
        screen.setFromProjectionMatrix(projection);
        for (const { surface: gun, arm } of nearby) {
          prepare(gun);
          if (!gun.scale) continue;
          for (const seg of leg) {
            local.multiplyMatrices(gun.inverse, seg.bone.matrixWorld);
            legFrustum.setFromProjectionMatrix(legProjection.multiplyMatrices(projection, seg.bone.matrixWorld));
            assert.ok(apart(seg.tree, gun.tree, arm ? gun.bone.matrixWorld : null),
              `Solape ${label}: ${seg.bone.name}/${gun.bone.name}`);
          }
        }
        tests++;
      }
    }
    for (let i = 0; i < hz; i++) vm.update(dt, rest);
    assert.ok(vm.anchorCam('grip', point).distanceTo(initialGrip) < 0.002, 'El arma vuelve al agarre inicial: ' + key);
  }
}
vm.dispose();
console.log(`Patada: ${tests} poses de las ocho armas y dos posturas. Distancia mínima al ojo ${(near * 100).toFixed(2)} cm, punta en impacto Y=${top.toFixed(3)} NDC.`);
