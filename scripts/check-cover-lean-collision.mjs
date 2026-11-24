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

// PRUEBAS (corrida 6, FPS): el "contrato del controller en cover" (identidad
// del collider de la cara, sin corrección lateral sobre la pose pegada) se
// retiró con la cobertura pegada; su garantía (inclinarse no mete la cabeza ni
// empuja el cuerpo) vive en check-fps-movement. La parte de geometría REAL se
// traslada: agachado/de pie, apuntando e inclinado en las orillas reales del
// bus, el camión y la Jersey de calle2, la posición converge sin temblor.
// Geometría real de calle2 (mapa que se juega): bus, camión y Jersey.
const calleWorld = Object.create(World.prototype);
calleWorld.colliders = expandedCollisionBoxes('calle2');
calleWorld.segmentColliders = [];
calleWorld.surfaceZones = [];
calleWorld.faces = []; // solo colisión de cajas: el empuje de fachada lo prueban facade-walking/storefront-cover
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
  assert(found, `${label}: falta collider esperado en calle2`);
  return found;
};

// Dimensiones MEDIDAS de la auditoría de hitboxes (bus torso 9.2x2.92,
// edificio 3.0x7.15): la silueta física sigue al mesh real.
const actualCases = [
  { label: 'bus', collider: findCollider('bus', 0, -34.5, 9.2, 2.92), axis: 'x' },
  { label: 'camión', collider: findCollider('camión', -6.5, -1.5, 3.0, 7.15), axis: 'z' },
  { label: 'Jersey', collider: findCollider('Jersey', -6.1, -33.4, 2.4, 0.9), axis: 'x' },
];


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
    for (const crouch of [true, false]) {
      // mirando a la cara, inclinado hacia fuera de la orilla
      const yaw = Math.atan2(face.n.x, face.n.z);
      const camera = {
        yaw, pitch: 0,
        flatForward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; },
        flatRight() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; },
      };
      const actor = new Controller(calleWorld, camera);
      const initialU = edge === 'A' ? PLAYER_R * 0.75 : len - PLAYER_R * 0.75;
      actor.respawn({
        x: face.a.x + ux * initialU + face.n.x * (PLAYER_R + 0.02),
        z: face.a.z + uz * initialU + face.n.z * (PLAYER_R + 0.02), yaw,
      });
      // lado de la orilla en el marco de la vista: A = izquierda (−1) o derecha
      const right = camera.flatRight();
      const side = Math.sign((ux * right.x + uz * right.z) * (edge === 'A' ? -1 : 1)) || 1;
      const input = {
        moveVec: () => ({ x: 0, z: 0 }), aimHeld: true, sprintHeld: false, jumpPressed: false,
        meleePressed: false, crouchHeld: crouch, crouchPressed: false, leanAxis: side,
      };
      const samples = [];
      for (let frame = 0; frame < 90; frame++) {
        actor.update(1 / 60, input, false);
        if (frame >= 75) samples.push({ ...actor.pos, lean: actor.lean });
      }
      const span = Math.max(...samples.map((s) => s.x)) - Math.min(...samples.map((s) => s.x)) +
        Math.max(...samples.map((s) => s.z)) - Math.min(...samples.map((s) => s.z));
      const leanSpan = Math.max(...samples.map((s) => s.lean)) - Math.min(...samples.map((s) => s.lean));
      const tag = `${test.label} orilla ${edge} ${crouch ? 'agachado' : 'de pie'}`;
      assert(span < 0.001, `${tag}: la posición no converge (span ${span.toFixed(4)})`);
      assert(leanSpan < 0.001, `${tag}: la inclinación tiembla (span ${leanSpan.toFixed(4)})`);
      assert.equal(actor.state, crouch ? 'crouch' : 'idle', `${tag}: estado ${actor.state} sin intención`);
      // nunca dentro del collider del objeto
      const q = actor.pos, cl = c;
      const dx = Math.max(cl.minx - q.x, 0, q.x - cl.maxx), dz = Math.max(cl.minz - q.z, 0, q.z - cl.maxz);
      assert(Math.hypot(dx, dz) >= PLAYER_R - 0.01, `${tag}: el cuerpo entró en el collider`);
    }
  }
}

console.log('COVER LEAN COLLISION OK · bus/camión/Jersey de calle2 estables agachado/de pie inclinado · obstáculos adyacentes activos');
