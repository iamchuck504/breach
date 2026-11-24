// Construye el mapa con sus tres GLB locales. El doble de canvas solo sustituye la pintura 2D.
import assert from 'node:assert/strict';
import { checkFortalezaOpenings } from './lib-fortaleza-vanos.mjs';
import { readFile } from 'node:fs/promises';
import * as T from 'three';
import { FORT_SHRUB_BEDS } from '../src/world/collision-layouts.js';
import { FORT_GALLERY as G } from '../src/world/fortaleza-galleries.js';
import { World } from '../src/world/world.js';
import { assetIdsForLayout, preloadUrbanAssets } from '../src/world/urban-assets.js';

const pixels = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
const gradient = () => ({ addColorStop() {} });
globalThis.document = { createElement() {
  const canvas = {};
  const context = new Proxy({
    canvas, measureText: t => ({ width: t.length * 8 }), createImageData: pixels,
    getImageData: (x, y, w, h) => pixels(w, h), createLinearGradient: gradient, createRadialGradient: gradient,
  }, { get(target, key) { return target[key] ?? (() => {}); } });
  canvas.getContext = () => context;
  return canvas;
} };
globalThis.location = { search: '', href: 'http://local.invalid/' };
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 1;
globalThis.fetch = async path => {
  assert.match(path, /^\/assets\/calle\/[\w-]+\.glb$/);
  return new Response(await readFile(new URL('../public' + path, import.meta.url)));
};
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
await preloadUrbanAssets(assetIdsForLayout('fortaleza'));
const world = new World(new T.Scene(), 'fortaleza');
world.look.setQuality('high');
world.scene.updateMatrixWorld(true);

// Aserciones sobre los lotes reales, incluida la vegetación fusionada por vértices.
assert(world.mapGroup.getObjectByName('fortaleza-blender-castle'));
assert(world.mapGroup.getObjectByName('fortaleza-galleries').userData.blender);
const beds = FORT_SHRUB_BEDS.flatMap(b => [-1, 1].map(s => ({
  minx: s*b.x-b.w/2, maxx: s*b.x+b.w/2, minz: s*b.z-b.d/2, maxz: s*b.z+b.d/2, h: b.h,
})));
const containsXZ = (b, x, z) => x >= b.minx && x <= b.maxx && z >= b.minz && z <= b.maxz;
const sameBed = (c, b) => ['minx','minz','maxx','maxz','h'].every(k => Math.abs(c[k]-b[k]) < 1e-6);
const EPS = 2e-5;
const expected = new Map([
  ['fort-grass', 180], ['fort-ivy', 13], ['fort-bush', 12], ['fort-shrub-beds', 6],
  ['fort-trunk', 8], ['fort-crown', 24], ['fort-cypress', 4],
]);
const anchors = [];
const counts = new Map();
const v = new T.Vector3(), local = new T.Vector3(), matrix = new T.Matrix4();
const q = new T.Quaternion(), scale = new T.Vector3(), center = new T.Vector3();
function checkPlant(o, merged = false, replacedIvy = true) {
  const name = o.name, geometry = o.geometry, p = geometry.attributes.position;
  const n = o.isInstancedMesh ? o.count : 1;
  counts.set(name, (counts.get(name) ?? 0) + n);
  let drawn = o.material.visible && o.material.colorWrite && o.material.opacity > 0 &&
    o.layers.isEnabled(0) && geometry.drawRange.count > 0;
  for (let parent = o; parent; parent = parent.parent) drawn &&= parent.visible;
  assert(!o.castShadow || drawn, name + ': sombra sin planta');
  assert(drawn || (name === 'fort-ivy' && replacedIvy && world.look.ctx.layers.has('flora')), name);
  if (name === 'fort-grass' || name === 'fort-ivy') {
    assert.equal(o.material.side, T.DoubleSide, name);
    assert(o.material.map && o.material.alphaTest > 0 && o.material.alphaTest < 1, name);
  }
  if (!geometry.boundingSphere) {
    assert(!merged, name + ': falta la esfera de la capa');
    geometry.computeBoundingSphere(); // También la calcula Three para una geometría estática.
  }
  const sphere = o.isInstancedMesh ? o.boundingSphere : geometry.boundingSphere;
  assert(sphere && Number.isFinite(sphere.radius) && sphere.radius > 0, name);
  const wind = geometry.attributes.aLk;
  for (let i = 0; i < n; i++) {
    if (o.isInstancedMesh) o.getMatrixAt(i, matrix);
    else matrix.identity();
    const transform = o.matrixWorld.clone().multiply(matrix);
    transform.decompose(center, q, scale);
    assert(transform.elements.every(Number.isFinite) && scale.toArray().every(s => s > 0), name);
    // La colisión propia del arbusto es precisamente lo que su copa representa.
    // Se comprueban todas las demás cajas, también las que representan otro parterre.
    const shrub = name === 'fort-bush' || name === 'fort-shrub-beds';
    const represented = shrub ? beds.filter(b => containsXZ(b, center.x, center.z)) : [];
    if (shrub) { assert(represented.length, name); anchors.push(center.clone()); }
    const solids = world.colliders.filter(c => !represented.some(b => sameBed(c,b)));
    let highest = -Infinity;
    const vertices = [];
    for (let j = 0; j < p.count; j++) {
      local.fromBufferAttribute(p,j).applyMatrix4(matrix);
      const sway = (wind?.getX(j) ?? 0) * 1.6;
      assert(local.distanceTo(sphere.center) + sway <= sphere.radius + EPS, name + ': recorte');
      v.copy(local).applyMatrix4(o.matrixWorld);
      vertices.push(v.clone());
      const ground = Math.abs(v.x) > world.fx || Math.abs(v.z) > world.fz ? -0.04 : 0;
      highest = Math.max(highest, v.y-ground);
      assert(v.y >= ground-EPS && v.toArray().every(Number.isFinite), name + ': bajo tierra');
      assert(!solids.some(c => v.x > c.minx+EPS && v.x < c.maxx-EPS && v.z > c.minz+EPS &&
        v.z < c.maxz-EPS && v.y > (c.minY ?? 0)+EPS && v.y < c.h-EPS), name + ': dentro de otra caja ' + v.toArray());
    }
    // También el interior del triángulo: una hoja puede cortar una esquina
    // sin que ninguno de sus tres vértices caiga dentro de la caja.
    const tri = new T.Triangle(), extent = new T.Box3();
    const boxes = solids.map(c => new T.Box3(
      new T.Vector3(c.minx+EPS, (c.minY ?? 0)+EPS, c.minz+EPS),
      new T.Vector3(c.maxx-EPS, c.h-EPS, c.maxz-EPS)));
    const index = geometry.index;
    for (let j = 0; j < (index?.count ?? p.count); j += 3) {
      const at = k => index ? index.getX(j+k) : j+k;
      tri.set(vertices[at(0)], vertices[at(1)], vertices[at(2)]);
      extent.makeEmpty().expandByPoint(tri.a).expandByPoint(tri.b).expandByPoint(tri.c);
      assert(!boxes.some(box => box.intersectsBox(extent) && box.intersectsTriangle(tri)),
        name + ': triángulo en piedra ' + tri.a.toArray());
      if (name === 'flora-trees' && wind.getZ(at(0)) === 0) {
        assert(tri.getNormal(v).dot(local.fromBufferAttribute(geometry.attributes.normal,at(0))) > 0,
          'El tronco debe tener la cara visible hacia fuera');
      }
    }
    if (shrub) assert(highest > Math.max(...represented.map(b => b.h)), name + ': copa enterrada en su envolvente');
    assert(highest > 0.02, name + ': planta enterrada');
  }
}

world.mapGroup.traverse(o => { if (expected.has(o.name)) checkPlant(o); });
assert.deepEqual(counts, expected);
const crates = world.mapGroup.getObjectByName('fort-siege-crates');
for (let i = 0; i < crates.count; i++) {
  crates.getMatrixAt(i, matrix);
  anchors.push(new T.Vector3().setFromMatrixPosition(matrix.premultiply(crates.matrixWorld)));
}
for (const b of beds) assert(anchors.some(v => containsXZ(b, v.x, v.z)), 'Parterre invisible ' + JSON.stringify(b));

for (const quality of ['off', 'low', 'medium', 'high', 'ultra']) {
  world.look.setQuality(quality);
  const layer = world.look.group.getObjectByName('look-flora');
  assert.deepEqual(layer.children.map(o => o.name), ['flora-field','flora-climbers','flora-meadow','flora-trees']);
  for (const o of layer.children) {
    assert.equal(o.castShadow, o.name === 'flora-trees');
    if (!o.castShadow) assert.equal(o.material.side, T.DoubleSide);
    checkPlant(o, true);
  }
}

// Una segunda construcción debe conservar tanto las plantas como sus coordenadas.
const grass = w => w.mapGroup.children.filter(o => o.name === 'fort-grass').map(o => o.instanceMatrix.array);
const again = new World(new T.Scene(), 'fortaleza');
again.look.setQuality('ultra');
assert.deepEqual(grass(again), grass(world));
for (const o of world.look.group.getObjectByName('look-flora').children) {
  assert.deepEqual(again.look.group.getObjectByName(o.name).geometry.attributes.position.array, o.geometry.attributes.position.array);
}
// La hiedra de planos solo se oculta cuando existe su relevo en el look.
globalThis.location.search = '?look=classic';
const classic = new World(new T.Scene(), 'fortaleza');
assert(!classic.look.has('fortaleza'));
classic.mapGroup.traverse(o => { if (expected.has(o.name)) checkPlant(o, false, false); });
const identity = world.mapGroup.getObjectByName('map-identity:fortaleza');
const signs = identity.children.filter(o => o.name.startsWith('map-sign:'));
assert.equal(signs.length, 6);
for (const sign of signs) {
  const upper = !sign.name.endsWith(':UPPER WALK');
  const box = new T.Box3().setFromObject(sign);
  if (upper) {
    assert(box.min.y > G.height+G.liza.upperTop);
    assert.equal(sign.position.z, 0);
  } else {
    assert(Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) < G.start);
  }
  const normal = new T.Vector3(0,0,1).applyQuaternion(sign.quaternion);
  assert(normal.x * Math.sign(sign.position.x) * (upper ? 1 : -1) > 0.999);
  const ray = new T.Raycaster(sign.position.clone().addScaledVector(normal, 0.8), normal.clone().negate(), 0, 1);
  assert.equal(ray.intersectObject(sign,true)[0]?.object, sign.children[1], sign.name + ': texto de espaldas');
  const hit = world.raycast(sign.position, normal.negate(), 0.08);
  assert(hit !== null && Math.abs(hit - (upper ? 0.0295 : 0.05)) < 0.001, sign.name + ': sin muro detrás');
}
checkFortalezaOpenings(world);
let meshes=0;
world.mapGroup.traverse(o=>{if(o.isMesh)meshes++;});
assert.equal(meshes,226,'Recuento de Fortaleza con los tres GLB');
console.log('FORTALEZA OK · 24 parterres representados, 90 matas cruzadas, cuatro lotes de flora en cinco calidades · seis rótulos, 226 mallas, diez entradas de torre, diez ventanas y seis pasos de muralla comprobados');
