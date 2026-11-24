// Altura de los ojos frente a CADA altura de cobertura (PEDIDO §18.3; PRUEBAS,
// corrida 6). check-fps-eye cubre LOW a fondo (agachado tras LOW ni visible ni
// impactable; de pie la cabeza entera asoma) y solo IMPRIME las líneas de MID y
// HIGH; aquí se afirman:
//  1. MID (1.9) y HIGH (3.0): un jugador DE PIE detrás (quieto, apuntando con
//     cada arma, trotando, inclinado sin salir del borde, asomado ce=1) no es
//     visible ni impactable desde ojos de pie ni agachados a 2–40 m; y no ve
//     por encima (su ojo queda bajo el borde).
//  2. Ojo de pie (eyeFromPose, hoy 1.60) VE por encima de LOW y ojo agachado (0.77) NO; ojo de
//     pie NO ve por encima de MID ni de HIGH.
//  3. La regla es simétrica: si desde detrás de una cobertura se ve a alguien,
//     ese alguien ve la cabeza de quien mira (nadie dispara sin exponerse).
// Node puro, geometría sintética (cajas de las alturas del contrato: LOW 1.1, MID 1.9, HIGH 3.0).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/world/world.js';
import { resolveShot } from '../src/combat/ballistics.js';
import { hitFields, eyeWorld, HEAD_R } from '../src/combat/hit-pose.js';

const mkWorld = (h) => {
  const w = Object.create(World.prototype);
  w.fx = 60; w.fz = 60; w.surfaceZones = []; w.segmentColliders = [];
  w.colliders = [{ minx: -3, maxx: 3, minz: -0.6, maxz: 0, h }]; // bloque de 0.6 m de fondo, 6 m de ancho
  return w;
};
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const sees = (world, a, b) => {
  const d = V(b).sub(V(a)), L = d.length();
  return world.raycast(V(a), d.normalize(), L - 1e-3) === null;
};
const P = { x: 0, z: 0.38 }; // pies del que se cubre, mirando al bloque (yaw π: hacia −z)
function headPoints(pose) {
  // como check-fps-eye: las poses de siempre usan el volumen heredado (hit = null)
  const hf = hitFields(pose, P.x, 0, P.z, Math.PI);
  const f = hf.hit ?? (hf.crouch
    ? { hx: P.x, hy: 0.86, hz: P.z, hr: 0.22, ax: P.x, ay: 0.26, az: P.z, bx: P.x, by: 0.6, bz: P.z, br: 0.42 }
    : { hx: P.x, hy: 1.52, hz: P.z, hr: 0.22, ax: P.x, ay: 0.35, az: P.z, bx: P.x, by: 1.3, bz: P.z, br: 0.4 });
  const pts = [];
  for (let i = 0; i < 160; i++) {
    const u = (i + 0.5) / 160, th = Math.acos(1 - 2 * u), ph = i * 2.39996;
    const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    pts.push([f.hx + d[0] * f.hr * 0.999, f.hy + d[1] * f.hr * 0.999, f.hz + d[2] * f.hr * 0.999]);
    for (const k of [0, 0.5, 1]) pts.push([f.ax + (f.bx - f.ax) * k + d[0] * f.br * 0.999, f.ay + (f.by - f.ay) * k + d[1] * f.br * 0.999, f.az + (f.bz - f.az) * k + d[2] * f.br * 0.999]);
  }
  return { f, pts: pts.filter((q) => q[1] > 0.02) };
}
const target = (pose) => ({ id: 't', x: P.x, z: P.z, y: 0, alive: true, ...hitFields(pose, P.x, 0, P.z, Math.PI) });
const shotHits = (world, from, pose, to) => resolveShot(world, [target(pose)], V(from), V(to).sub(V(from)).normalize(), 80).kind === 'player';
// ojos del rival: de pie y agachado (su altura real; el adelanto del ojo no cambia la línea)
const EYE_STAND = eyeWorld({ st: 'idle' }, 0, 0, 0, 0)[1];
const EYE_CROUCH = eyeWorld({ st: 'crouch', ce: 0 }, 0, 0, 0, 0)[1];
// las alturas salen de eyeFromPose (fuente única); solo se exige el orden que da sentido a LOW/MID
assert.ok(EYE_STAND > 1.1 && EYE_STAND < 1.9 && EYE_CROUCH < 1.1, `alturas de ojo fuera de LOW/MID: ${EYE_STAND} / ${EYE_CROUCH}`);

const STANDING = [
  { st: 'idle' }, { st: 'run', sp: 0.6 },
  ...['smg', 'pistol', 'shotgun', 'sniper', 'bazooka'].map((wep) => ({ st: 'idle', aim: true, wep })),
  { st: 'idle', cl: 1 }, { st: 'idle', cl: -1 }, { st: 'idle', aim: true, cl: 1, wep: 'smg' }, { st: 'idle', aim: true, cl: -1, wep: 'smg' },
  { st: 'crouch', aim: true, ce: 1, wep: 'smg' }, // asomo al máximo = de pie con ADS
];
let checked = 0;
const executed = new Map(); // regla: un caso declarado que no se ejecuta es un fallo
for (const [name, h] of [['MID', 1.9], ['HIGH', 3.0]]) {
  const W = mkWorld(h);
  for (const pose of STANDING) {
    const { f, pts } = headPoints(pose);
    assert.ok(f.hy + f.hr < h, `${name}: la cabeza de pie ${JSON.stringify(pose)} asoma (${(f.hy + f.hr).toFixed(2)} ≥ ${h})`);
    for (const eyeY of [EYE_STAND, EYE_CROUCH]) for (const D of [2, 4, 8, 15, 25, 40]) for (const lx of [-2, 0, 2]) {
      const eye = [lx, eyeY, -0.6 - D];
      for (const q of pts) {
        checked++; executed.set(`${name}|${JSON.stringify(pose)}`, (executed.get(`${name}|${JSON.stringify(pose)}`) ?? 0) + 1);
        assert.ok(!sees(W, eye, q), `${name}: de pie ${JSON.stringify(pose)} visible desde ojo ${eyeY.toFixed(2)} a ${D} m`);
        assert.ok(!shotHits(W, eye, pose, q), `${name}: de pie ${JSON.stringify(pose)} impactable desde ojo ${eyeY.toFixed(2)} a ${D} m`);
      }
    }
    // y no ve por encima: su ojo no alcanza ningún punto a la altura de una cabeza al otro lado
    const myEye = eyeWorld(pose, P.x, 0, P.z, Math.PI);
    assert.ok(myEye[1] < h, `${name}: ojo ${myEye[1].toFixed(2)} por encima del borde`);
    for (const D of [2, 8, 25]) for (const y of [0.86, 1.52, 1.74]) {
      assert.ok(!sees(W, myEye, [0, y, -0.6 - D]), `${name}: ${JSON.stringify(pose)} ve por encima (punto a ${y} m, ${D} m)`);
    }
  }
}
assert.equal(executed.size, 2 * STANDING.length, `casos ejecutados ${executed.size} de ${2 * STANDING.length} declarados`);
for (const [k, n] of executed) assert.ok(n > 0, `caso sin rayos: ${k}`);
// 2. ojo de pie ve por encima de LOW, agachado no; de pie no ve por encima de MID/HIGH
{
  const LOW = mkWorld(1.1), MID = mkWorld(1.9);
  const standEye = eyeWorld({ st: 'idle' }, P.x, 0, P.z, Math.PI), crouchEye = eyeWorld({ st: 'crouch', ce: 0 }, P.x, 0, P.z, Math.PI);
  let overLow = 0;
  for (const D of [4, 8, 15, 25, 40]) {
    if (sees(LOW, standEye, [0, 1.52, -0.6 - D])) overLow++;
    assert.ok(!sees(LOW, crouchEye, [0, 1.52, -0.6 - D]), `agachado tras LOW ve una cabeza de pie a ${D} m`);
    assert.ok(!sees(MID, standEye, [0, 1.52, -0.6 - D]), `de pie tras MID ve una cabeza a ${D} m`);
  }
  assert.equal(overLow, 5, `de pie tras LOW no ve por encima (${overLow}/5)`);
}
// 3. simetría tras LOW con asomo: si veo su cabeza, él ve la mía (desde su ojo, al menos un punto de mi cabeza)
{
  const LOW = mkWorld(1.1);
  let pairs = 0;
  for (const ce of [0.25, 0.5, 0.75, 1]) {
    const pose = { st: 'crouch', aim: true, ce, wep: 'smg' };
    const me = eyeWorld(pose, P.x, 0, P.z, Math.PI), { pts } = headPoints(pose);
    for (const D of [4, 8, 15, 25, 40]) for (const lx of [-2, 0, 2]) {
      const rivalEye = [lx, EYE_STAND, -0.6 - D];
      const rivalHead = [lx, 1.52, -0.6 - D];
      if (!sees(LOW, me, rivalHead) && !sees(LOW, me, rivalEye)) continue;
      pairs++;
      assert.ok(pts.some((q) => sees(LOW, rivalEye, q)), `asomo ce=${ce}: veo al rival a ${D} m sin que él vea nada de mí`);
    }
  }
  assert.ok(pairs > 10, `pocos pares de visión para la simetría (${pairs})`);
}
console.log(`FPS COVER HEIGHTS OK · MID/HIGH ocultan de pie (${checked} rayos) · LOW: de pie ve, agachado no · asomo simétrico (HEAD_R ${HEAD_R})`);
