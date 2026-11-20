// CÁMARA: COLISIÓN Y LÍNEAS DE TIRO (sin navegador, geometría exacta).
// 1) La colisión SIEMPRE gana: con paredes finas (hasta 0.08 m, más fina que
//    el collider más fino de los tres mapas, 0.10 m), rincones, techos bajos
//    y deslizando junto a una pared, la cámara nunca queda dentro de una caja
//    ni detrás de ella: los segmentos pivote→cámara y cabeza→cámara están libres.
// 2) En ADS el rayo óptico de la cámara decide los tiros. Junto a una pared
//    trasera y cerca de una esquina delantera, lo que la cámara alcanza a ver
//    (primer contacto del rayo central y blancos visibles) debe ser un
//    subconjunto de lo que veía la cámara de referencia (la anterior a run 4:
//    un rayo pivote→posición deseada, con su mínimo de 0.5 m) cuando esa
//    referencia era legal (no estaba dentro ni detrás de una pared).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShoulderCamera } from '../src/core/camera.js';
import { TUNING } from '../src/config/tuning.js';
import { syncLocalSoldierView } from '../src/player/soldier-bake.js';

// raycast de cajas idéntico a World.raycast (minY = cara inferior)
function makeWorld(boxes) {
  return {
    raycast(origin, dir, maxDist, inflate = 0) {
      let best = null;
      for (const c of boxes) {
        const lo = [c.minx - inflate, c.minY === undefined ? -0.1 : c.minY - inflate, c.minz - inflate];
        const hi = [c.maxx + inflate, c.h + inflate, c.maxz + inflate];
        const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z];
        let tmin = 0, tmax = maxDist, ok = true;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-8) { if (o[a] < lo[a] || o[a] > hi[a]) { ok = false; break; } continue; }
          let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
          if (t1 > t2) [t1, t2] = [t2, t1];
          tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
          if (tmin > tmax) { ok = false; break; }
        }
        if (ok && tmin < maxDist && (best === null || tmin < best)) best = tmin;
      }
      return best;
    },
  };
}
const inside = (boxes, p) => boxes.some((c) => p.x > c.minx && p.x < c.maxx && p.z > c.minz && p.z < c.maxz &&
  p.y < c.h && p.y > (c.minY ?? -0.1));
const _d = new THREE.Vector3();
const clear = (world, a, b) => {
  _d.copy(b).sub(a); const len = _d.length();
  if (len < 1e-6) return true;
  return world.raycast(a, _d.multiplyScalar(1 / len), len, 0) === null;
};

function settle(boxes, { mode = 'normal', pitch = -0.05, x = 0, z = 0, frames = 90, cam = null } = {}) {
  const world = makeWorld(boxes);
  const view = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 300);
  const c = cam ?? new ShoulderCamera(view, world);
  c.world = world;
  const player = {
    pos: { x, z }, y: 0,
    camState: () => (mode === 'normal' ? { mode: 'normal' } : mode === 'cover' ? { mode: 'cover', side: 0 } : { mode: 'aim', side: 1 }),
  };
  c.yaw = 0; c.pitch = pitch;
  for (let i = 0; i < frames; i++) c.update(1 / 60, player);
  return { c, world, player };
}
// referencia: la cámara anterior, en régimen (pivote/hombro/distancia ya asentados)
function headCamera(c, world) {
  const T = TUNING.cam;
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const sh = c._rig.shoulder * c._side, dist = c._rig.dist;
  const desired = new THREE.Vector3(c.pivot.x + sy * cp * dist + cy * sh, c.pivot.y - sp * dist + 0.12, c.pivot.z + cy * cp * dist - sy * sh);
  const dir = desired.clone().sub(c.pivot); const len = dir.length(); dir.normalize();
  const t = world.raycast(c.pivot, dir, len + 0.2, 0.25);
  const free = t !== null && t < len ? Math.max(T.minDist, t - 0.15) / len : 1;
  return c.pivot.clone().addScaledVector(dir, len * free);
}

// ---------------------------------------------------------------- 1) colisión
let cases = 0, badN = 0;
const bad = [];
const legal = (boxes, c, p, label) => {
  cases++;
  const head = new THREE.Vector3(p.pos.x, (p.y ?? 0) + 1.75, p.pos.z);
  const ok = !inside(boxes, c.pos) && clear(makeWorld(boxes), c.pivot, c.pos) && clear(makeWorld(boxes), head, c.pos);
  if (!ok) badN++;
  if (!ok && bad.length < 8) bad.push(`${label} cam=${c.pos.toArray().map((v) => v.toFixed(3))}`);
  return ok;
};
const PITCHES = [-62 * Math.PI / 180, -0.6, -0.05, 0.5, 55 * Math.PI / 180];
const MODES = ['normal', 'aim', 'cover'];
const wall = (z0, th, extra = {}) => ({ minx: -4, maxx: 4, minz: z0, maxz: z0 + th, h: 4, ...extra });
for (const th of [0.08, 0.1, 0.2, 0.5]) for (let d = 0.40; d <= 1.6 + 1e-9; d += 0.04) for (const mode of MODES) for (const pitch of PITCHES) {
  const scen = {
    detras: [wall(d, th)],
    rinconR: [wall(d, th), { minx: d, maxx: d + th, minz: -4, maxz: 4, h: 4 }],
    rinconL: [wall(d, th), { minx: -d - th, maxx: -d, minz: -4, maxz: 4, h: 4 }],
    techo: [wall(d, th), { minx: -4, maxx: 4, minz: -4, maxz: 4, minY: 1.95, h: 1.95 + th }],
    callejon: [{ minx: d, maxx: d + th, minz: -8, maxz: 8, h: 4 }, { minx: -d - th, maxx: -d, minz: -8, maxz: 8, h: 4 }],
  };
  for (const [name, boxes] of Object.entries(scen)) {
    const { c, player } = settle(boxes, { mode, pitch });
    legal(boxes, c, player, `${name} d=${d.toFixed(2)} grosor=${th} ${mode} pitch=${pitch.toFixed(2)}`);
  }
}
// deslizando junto a una pared trasera fina que hace esquina hacia atrás
// (x<0 a 0.42 m, x≥0 a 1.0 m) y luego vuelve: cada cuadro
for (const mode of MODES) {
  const boxes = [{ minx: -6, maxx: 0, minz: 0.42, maxz: 0.5, h: 4 }, { minx: 0, maxx: 0.08, minz: 0.42, maxz: 1.08, h: 4 },
    { minx: 0, maxx: 1.5, minz: 1.0, maxz: 1.08, h: 4 }, { minx: 1.5, maxx: 6, minz: 0.42, maxz: 0.5, h: 4 }, { minx: 1.42, maxx: 1.5, minz: 0.42, maxz: 1.08, h: 4 }];
  const world = makeWorld(boxes);
  const c = new ShoulderCamera(new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 300), world);
  const player = { pos: { x: -3, z: 0 }, y: 0, camState: () => (mode === 'aim' ? { mode: 'aim', side: 1 } : { mode }) };
  c.yaw = 0; c.pitch = -0.05;
  for (let i = 0; i < 400; i++) {
    player.pos.x = -3 + i * 0.012;
    c.update(1 / 60, player);
    legal(boxes, c, player, `deslizando ${mode} x=${player.pos.x.toFixed(2)}`);
  }
}
console.log(`colisión: ${cases} cámaras, ${badN ? badN + ' dentro o detrás de un collider' : 'todas a este lado de la geometría'}`);

// ------------------------------------------------------- 2) líneas de tiro ADS
let compared = 0, headIllegal = 0, centerHits = 0, leakN = 0;
const leaks = [];
const targets = [];
for (let x = -4; x <= 6 + 1e-9; x += 0.25) for (const z of [-6, -10, -15]) for (const y of [1.0, 1.5]) targets.push(new THREE.Vector3(x, y, z));
for (let d = 0.40; d <= 1.4 + 1e-9; d += 0.1) for (let e = -0.6; e <= 1.6 + 1e-9; e += 0.2) for (const side of [-1, 1]) for (const pitch of [-0.1, -0.02, 0.05]) {
  // esquina delantera: caja alta a 1.2–2.2 m delante, con su arista en x=e
  const front = side > 0 ? { minx: -4, maxx: e, minz: -2.2, maxz: -1.2, h: 2.5 } : { minx: e, maxx: 5, minz: -2.2, maxz: -1.2, h: 2.5 };
  const boxes = [wall(d, 0.1), front];
  const { c, world, player } = settle(boxes, { mode: 'aim', pitch });
  const ref = headCamera(c, world);
  const head = new THREE.Vector3(player.pos.x, 1.75, player.pos.z);
  if (inside(boxes, ref) || !clear(world, c.pivot, ref) || !clear(world, head, ref)) { headIllegal++; continue; }
  compared++;
  const ray = c.aimRay();
  const tNew = world.raycast(ray.origin, ray.dir, 80, 0), tRef = world.raycast(ref, ray.dir, 80, 0);
  if (tRef !== null && tRef < 4) {
    centerHits++;
    // la referencia choca con la esquina: la nueva también, y no más lejos
    if (tNew === null || ray.origin.clone().addScaledVector(ray.dir, tNew).z < ref.clone().addScaledVector(ray.dir, tRef).z - 1e-3) {
      if (leaks.length < 8) leaks.push(`rayo central d=${d.toFixed(1)} e=${e.toFixed(1)} lado=${side} pitch=${pitch}`);
    }
  }
  for (const tg of targets) {
    if (clear(world, c.pos, tg) && !clear(world, ref, tg)) {
      leakN++;
      if (leaks.length < 8) leaks.push(`blanco ${tg.toArray()} d=${d.toFixed(1)} e=${e.toFixed(1)} lado=${side} pitch=${pitch} cam=${c.pos.toArray().map((v) => v.toFixed(2))} ref=${ref.toArray().map((v) => v.toFixed(2))}`);
      break;
    }
  }
}
console.log(`líneas ADS: ${compared} posiciones comparadas (${centerHits} con el rayo central en la esquina), ${headIllegal} donde la referencia estaba detrás de la pared`);
assert(compared > 300, 'muy pocas posiciones comparables');
console.log(`líneas ADS: ${leakN ? leakN + ' posiciones con blancos nuevos' : 'ninguna línea nueva'}`);
assert.equal(bad.length, 0, `cámara dentro o detrás de un collider:\n${bad.join('\n')}`);
assert.equal(leaks.length, 0, `la cámara ve/alcanza algo que la referencia no:\n${leaks.join('\n')}`);
// 3) contorno de protección de spawn: visto desde otra cámara ('off') va
// entero aunque la cámara de hombro haya quedado metida en el soldado
const rig = { team: 'red', guns: {}, _outlineMat: { opacity: 0.45 } };
const view = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 300);
syncLocalSoldierView(rig, view, 'near', 1, 1);
const nearOpacity = rig._outlineMat.opacity;
syncLocalSoldierView(rig, view, 'off', 1, 1);
console.log(`contorno: cámara de hombro dentro del soldado ${nearOpacity.toFixed(2)} · otra cámara ${rig._outlineMat.opacity.toFixed(2)}`);
assert.equal(rig._outlineMat.opacity, 0.45, 'en espectador/presentación el contorno debe ir entero');
syncLocalSoldierView(rig, view, 'hidden', 0, 0);
assert.equal(rig._outlineMat.opacity, 0, 'dentro del scope el contorno no se dibuja');
console.log('CAMERA LANES OK · colisión gana a la distancia mínima · ADS no abre líneas de tiro nuevas');
