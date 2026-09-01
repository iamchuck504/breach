import { strict as assert } from 'node:assert';
import { Controller, PLAYER_R } from '../src/player/controller.js';
import { World } from '../src/world/world.js';
import { expandedCollisionBoxes } from '../src/world/collision-layouts.js';

// La operación física puede omitir solo el collider de la cara actual.
const current = { minx: 0, maxx: 2, minz: 0, maxz: 2, h: 3 };
const physical = Object.create(World.prototype);
physical.colliders = [current];
physical.segmentColliders = [];
let p = { x: -0.20, z: 1 };
physical.resolveCircle(p, PLAYER_R, 0, current);
assert.deepEqual(p, { x: -0.20, z: 1 },
  'el collider del cover actual no debe pelear con el lean');

const adjacent = { minx: -0.42, maxx: -0.08, minz: 0.78, maxz: 1.22, h: 3 };
physical.colliders.push(adjacent);
p = { x: -0.20, z: 1 };
physical.resolveCircle(p, PLAYER_R, 0, current);
assert(Math.hypot(p.x + 0.20, p.z - 1) > 0.1,
  'ignorar la cara actual no debe atravesar un obstáculo adyacente');

// Contrato del controller: en cover pasa la identidad exacta de su cara al
// resolver, tanto sin input como durante el lean ADS de una esquina.
const calls = [];
const collider = { minx: 0, maxx: 1, minz: 0, maxz: 4, h: 3 };
const world = {
  resolveCircle(point, radius, y, ignored) {
    calls.push({ point: { ...point }, radius, y, ignored });
    if (ignored !== collider) point.x += 0.12; // simula la corrección conflictiva
  },
  groundHeight() { return 0; },
  raycast() { return null; },
  findCover() { return null; },
};
const camera = {
  yaw: Math.PI / 2,
  pitch: 0,
  flatForward() { return { x: -1, z: 0 }; },
  flatRight() { return { x: 0, z: 1 }; },
};
const player = new Controller(world, camera);
player.state = 'cover';
player.cover = {
  a: { x: 0, z: 0 }, b: { x: 0, z: 4 }, n: { x: -1, z: 0 },
  h: 3, kind: 'high', collider,
};
player.pos = { x: -PLAYER_R, z: 0.20 };
const input = {
  moveVec: () => ({ x: 0, z: 0 }),
  aimHeld: true,
  sprintHeld: false,
  jumpPressed: false,
  meleePressed: false,
  evadePressed: false,
};
player.update(1 / 60, input, false);
assert.equal(calls.length, 1, 'cover debe resolver colisión una vez por frame');
assert.equal(calls[0].ignored, collider,
  'controller debe omitir únicamente el collider de su cover actual');
assert(player.pos.x < -0.30,
  'la resolución no debe inyectar una corrección lateral sobre la pose de cover');

// Geometría real de Calle: bus, camión y Jersey. Además del contrato unitario,
// comprobamos que las orillas usadas en el mapa converjan y no alternen entre
// la posición analítica del cover y el empuje circular del mismo objeto.
const calleWorld = Object.create(World.prototype);
calleWorld.colliders = expandedCollisionBoxes('calle');
calleWorld.segmentColliders = [];
calleWorld.surfaceZones = [];
calleWorld.groundHeight = () => 0;
calleWorld.raycast = () => null;

const center = (c) => ({ x: (c.minx + c.maxx) / 2, z: (c.minz + c.maxz) / 2 });
const dimensions = (c) => ({ w: c.maxx - c.minx, d: c.maxz - c.minz });
const findCollider = (label, x, z, w, d) => {
  const found = calleWorld.colliders.find((c) => {
    const p = center(c), size = dimensions(c);
    return Math.abs(p.x - x) < 0.01 && Math.abs(p.z - z) < 0.01 &&
      Math.abs(size.w - w) < 0.01 && Math.abs(size.d - d) < 0.01;
  });
  assert(found, `${label}: falta collider esperado en Calle`);
  return found;
};

// Dimensiones MEDIDAS de la auditoría de hitboxes (bus torso 9.2x2.92,
// edificio 3.0x7.15): la silueta física sigue al mesh real.
const actualCases = [
  { label: 'bus', collider: findCollider('bus', 0, -34.5, 9.2, 2.92), axis: 'x' },
  { label: 'camión', collider: findCollider('camión', -6.5, -1.5, 3.0, 7.15), axis: 'z' },
  { label: 'Jersey', collider: findCollider('Jersey', -6.1, -33.4, 2.4, 0.9), axis: 'x' },
];

const steadyInput = {
  moveVec: () => ({ x: 0, z: 0 }),
  aimHeld: true,
  sprintHeld: false,
  jumpPressed: false,
  meleePressed: false,
  evadePressed: false,
};

for (const test of actualCases) {
  const c = test.collider;
  const face = test.axis === 'x'
    ? { a: { x: c.minx, z: c.maxz }, b: { x: c.maxx, z: c.maxz }, n: { x: 0, z: 1 } }
    : { a: { x: c.maxx, z: c.minz }, b: { x: c.maxx, z: c.maxz }, n: { x: 1, z: 0 } };
  Object.assign(face, {
    h: c.h,
    topY: c.h,
    kind: c.h < 1.35 ? 'low' : 'high',
    collider: c,
  });
  const tx = face.b.x - face.a.x, tz = face.b.z - face.a.z;
  const len = Math.hypot(tx, tz), ux = tx / len, uz = tz / len;

  for (const edge of ['A', 'B']) {
    const actor = new Controller(calleWorld, camera);
    actor.state = 'cover';
    actor.cover = face;
    const initialU = edge === 'A' ? PLAYER_R * 0.75 : len - PLAYER_R * 0.75;
    actor.pos = {
      x: face.a.x + ux * initialU + face.n.x * PLAYER_R,
      z: face.a.z + uz * initialU + face.n.z * PLAYER_R,
    };
    const samples = [];
    for (let frame = 0; frame < 90; frame++) {
      actor.update(1 / 60, steadyInput, false);
      if (frame >= 75) samples.push({ ...actor.pos });
    }
    const span = Math.max(...samples.map((s) => s.x)) - Math.min(...samples.map((s) => s.x)) +
      Math.max(...samples.map((s) => s.z)) - Math.min(...samples.map((s) => s.z));
    assert(span < 0.001,
      `${test.label} orilla ${edge}: la pose no converge (span ${span.toFixed(4)})`);
    assert.equal(actor.state, 'cover', `${test.label} orilla ${edge}: salió de cover sin intención`);
  }
}

console.log('COVER LEAN COLLISION OK · bus/camión/Jersey estables · obstáculos adyacentes activos');
