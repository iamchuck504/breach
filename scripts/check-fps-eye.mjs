// Juego limpio FPS (corrida 6): el OJO está dentro de la cabeza replicada y
// la geometría de LOW/esquinas trata igual a quien ve y a quien es visto.
//   node scripts/check-fps-eye.mjs        (Node puro, sin navegador)
// 1. ojo ≤ EYE_MAX (0.12) del centro de la esfera de cabeza en un barrido denso
//    de estados, ce, cl, pitch, ae, armas y transiciones (guarda de postura del
//    servidor + interpolación del rebobinado), y continuidad del ojo.
// 2. agachado tras LOW (1.1 m): ni visible ni impactable desde el frente a la
//    altura de los ojos de otro agachado; no ve por encima. De pie se ve la
//    esfera de cabeza entera por encima del borde. Cifras para un rival de pie.
// 3. inclinarse en una esquina alta: simetría con una cabeza esférica.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/world/world.js';
import { resolveShot } from '../src/combat/ballistics.js';
import {
  hitPose, hitFields, eyeFromPose, eyeWorld, clampToEye, poseAt, shapeAt, EYE_MAX, HEAD_R, LEAN_MAX, CLAIM_JITTER,
} from '../src/combat/hit-pose.js';
import { acceptPosture } from '../server/guards.js';
import { localPose, postureOf, noteSentPose } from '../src/net/client.js';
import { TUNING } from '../src/config/tuning.js';

const out = [];
const note = (s) => { out.push(s); console.log(s); };
const eyeDist = (pose) => {
  const v = hitPose(pose), e = eyeFromPose(pose);
  return Math.hypot(e.f - v.h[0], e.s - v.h[1], e.y - v.h[2]);
};

// ---------- 1. barrido denso ----------
let n = 0, worst = 0, worstPose = null;
const WEPS = ['smg', 'pistol', 'shotgun', 'sniper', 'bazooka', 'grenade'];
for (const st of ['idle', 'run', 'jump', 'crouch', 'roadie', 'dodge', 'slide', 'mantle', 'melee', 'cover_low', 'cover_high', 'blind_over', 'dive', 'flip'])
  for (const aim of [false, true]) for (const wep of WEPS)
    for (let ce = 0; ce <= 1.0001; ce += 0.05) for (let cl = -1; cl <= 1.0001; cl += 0.1)
      for (const pitch of [-1.4, -0.55, -0.2, 0, 0.4, 1.2]) for (const ae of [-0.9, 0, 0.5]) for (const sp of [0, 0.63]) {
        const phase = ['dive', 'mantle', 'flip'].includes(st) ? (ce % 1) : undefined;
        const pose = { st, aim, wep, ce, cl, pitch, ae, phase, sp };
        const d = eyeDist(pose); n++;
        if (d > worst) { worst = d; worstPose = pose; }
      }
assert.ok(worst <= EYE_MAX + 1e-9, `ojo fuera de la cabeza: ${worst.toFixed(4)} m en ${JSON.stringify(worstPose)}`);
note(`1a ojo↔centro de cabeza: ${n} poses, máx ${worst.toFixed(3)} m (tope ${EYE_MAX}, radio ${HEAD_R})`);
// referencias del contrato
const E = (p) => eyeFromPose(p).y;
// ojo ALTO: 0.08 sobre el centro de cabeza (de pie 1.60; agachado = cabeza
// calibrada del rig + 0.08) — enmienda RED §2
const EYE_C = E({ st: 'crouch' }), EYE_S = E({ st: 'idle' });
assert.ok(Math.abs(EYE_S - 1.60) < 1e-9 && Math.abs(EYE_C - (hitPose({ st: 'crouch' }).h[2] + 0.08)) < 1e-9, 'alturas de ojo de referencia');
// casco impactable agachado (esfera) bajo LOW, con y sin ADS e inclinado
for (const pose of [{ st: 'crouch' }, { st: 'crouch', aim: true, wep: 'smg' }, ...[-1, 1].flatMap((cl) => [{ st: 'crouch', cl }, { st: 'crouch', cl, aim: true, wep: 'smg' }])])
  assert.ok(hitPose(pose).h[2] + HEAD_R <= 1.08 + 1e-9, `casco agachado por encima de 1.08: ${JSON.stringify(pose)}`);
note(`1z ojo de pie ${EYE_S.toFixed(2)} · agachado ${EYE_C.toFixed(2)} (cabeza ${hitPose({ st: 'crouch' }).h.map((v) => v.toFixed(2))}, esfera hasta ${(hitPose({ st: 'crouch' }).h[2] + HEAD_R).toFixed(2)})`);
for (const cl of [-1, 1]) for (const st of ['idle', 'crouch']) {
  const d = hitPose({ st, cl }).h[1] - hitPose({ st }).h[1];
  // rig calibrado: 0.20–0.24 de lado según postura; nunca más de LEAN_MAX
  assert.ok(Math.abs(d) <= LEAN_MAX + 0.005 && Math.abs(d) >= 0.18 && Math.sign(d) === cl, `${st} cl=${cl}: cabeza a ${d.toFixed(3)}`);
  assert.ok(hitPose({ st, cl }).b[1] * cl > 0.1, `${st} cl=${cl}: el cuerpo no sigue a la cabeza`);
}
// continuidad: en ce, cl y pitch el ojo se mueve poco por paso (sin saltos)
let jump = 0;
for (const aim of [false, true]) for (const st of ['idle', 'crouch']) {
  let prev = null;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200, pose = { st, aim, wep: 'smg', ce: st === 'crouch' ? t : 1, cl: -1 + 2 * t, pitch: -0.55 + 1.1 * t };
    const e = eyeWorld(pose, 0, 0, 0, 0);
    if (prev) jump = Math.max(jump, Math.hypot(e[0] - prev[0], e[1] - prev[1], e[2] - prev[2]));
    prev = e;
  }
}
assert.ok(jump <= 0.012, `el ojo salta ${jump.toFixed(3)} m en un paso de 0.5 %`);
// ADS sin mover la cámara de lado (la cabeza gira hacia la culata, el ojo no)
const adsShift = Math.max(...WEPS.map((wep) => Math.abs(eyeFromPose({ st: 'idle', aim: true, wep }).s)));
note(`1b continuidad: máx ${(jump * 1000).toFixed(1)} mm por paso de 0.5 % (ce, cl, pitch); ADS desplaza el ojo ≤ ${(adsShift * 100).toFixed(1)} cm de lado`);

// transiciones reales: el controlador (stanceLow 0.18 s, asomo 0.2 s, lean
// 0.16 s) → postureOf (cable) → guarda del servidor → historial a 20 Hz →
// poseAt: el ojo del cliente en t frente a la cabeza que el servidor
// reconstruye en t (interpolada). La cabeza de la propia pose siempre contiene
// el ojo; frente a la rebobinada, la distancia queda bajo el radio de origen.
{
  const fakePlayer = (o) => ({ animState: () => o.st, stanceLow: o.low, lean: o.cl, aim: o.aim, cam: { pitch: 0 } });
  let worstSrv = 0, worstOwn = 0, worstStep = 0;
  // gestos con los tiempos del controlador (tuning.fp), velocidad constante
  const F = TUNING.fp, ramp = (t, t0, dur) => Math.max(0, Math.min(1, (t - t0) / dur));
  const scripts = {
    'agacharse y levantarse': (t) => ({ st: t > 0.3 && t < 1.2 ? 'crouch' : 'idle', low: t < 1.2 ? ramp(t, 0.3, F.crouchTime) : 1 - ramp(t, 1.2, F.crouchTime), cl: 0, aim: false }),
    'asomo sobre LOW': (t) => ({ st: 'crouch', low: t < 0.5 ? ramp(t, 0, F.crouchTime) : t < 1.2 ? 1 - ramp(t, 0.5, F.peekRise) : ramp(t, 1.2, F.peekFall), cl: 0, aim: t >= 0.5 && t < 1.2 }),
    'inclinarse de pie y agachado': (t) => ({ st: t > 1 ? 'crouch' : 'idle', low: ramp(t, 1, F.crouchTime),
      cl: t < 0.5 ? -ramp(t, 0.1, F.leanTime) : t < 1 ? -1 + 2 * ramp(t, 0.5, 2 * F.leanTime) : 1 - 2 * ramp(t, 1.4, 2 * F.leanTime), aim: true }),
    // cambiar de idea a medias: el controlador invierte la rampa donde esté
    'cancelar a medias': (() => { let low = 0, last = 0; return (t) => {
      const want = Math.floor(t / 0.09) % 2, dt = t - last; last = t;
      low = Math.max(0, Math.min(1, low + (want ? 1 : -1) * dt / F.crouchTime));
      return { st: want ? 'crouch' : 'idle', low, cl: 0, aim: false }; }; })(),
  };
  for (const [name, f] of Object.entries(scripts)) {
    const ent = { fps: true }, hist = [];
    // el jugador llega de pie (aparición): la guarda arranca ahí
    acceptPosture(ent, { st: 'idle', aim: false, ce: 1, cl: 0 }, -1);
    for (let t = 0; t <= 2 + 1e-9; t += 1 / 60) {
      const o = f(t), ps = postureOf(fakePlayer(o));
      const pose = { st: ps.st, aim: o.aim, ce: ps.ce, cl: ps.cl, pitch: 0, wep: 'smg' };
      worstOwn = Math.max(worstOwn, eyeDist(pose));
      // tiro en este cuadro: el cliente manda antes un estado fresco y el
      // servidor valida contra la cabeza que la guarda acepta para él
      const probe = { fps: true, postureGuard: { ...ent.postureGuard } };
      const acc = acceptPosture(probe, { st: ps.st, aim: o.aim, ce: ps.ce, cl: ps.cl }, t);
      const hv = hitPose({ st: acc.st, aim: o.aim, ce: acc.ce, cl: acc.cl, pitch: 0, wep: 'smg' }).h;
      const e = eyeWorld(pose, 0, 0, 0, 0), h = [hv[1], hv[2], -hv[0]];
      const dd = Math.hypot(e[0] - h[0], e[1] - h[1], e[2] - h[2]);
      if (process.env.DEBUG && dd > 0.2) console.log(name, t.toFixed(3), JSON.stringify(pose), JSON.stringify(acc), dd.toFixed(3));
      worstSrv = Math.max(worstSrv, dd);
      // estados periódicos a 20 Hz
      if (Math.round(t * 60) % 3 === 0) {
        const a2 = acceptPosture(ent, { st: ps.st, aim: o.aim, ce: ps.ce, cl: ps.cl }, t);
        hist.push({ at: t, x: 0, y: 0, z: 0, yaw: 0, st: a2.st, aim: o.aim ? 1 : 0, ce: a2.ce, cl: a2.cl, p: 0, w: 'smg' });
      }
    }
    // el rebobinado interpola esa historia sin saltos de cabeza > 0.12 m por muestra
    for (let i = 1; i < hist.length; i++) {
      const p = shapeAt(hist, hist[i - 1].at).vol.h, q = shapeAt(hist, hist[i].at).vol.h;
      worstStep = Math.max(worstStep, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
  }
  assert.ok(worstOwn <= EYE_MAX + 1e-9, `transición: ojo a ${worstOwn.toFixed(3)} m de su cabeza`);
  // con la guarda recortando, el ojo queda dentro del radio de origen (0.4)
  assert.ok(worstSrv <= 0.4, `transición: ojo a ${worstSrv.toFixed(3)} m de la cabeza que acepta el servidor`);
  assert.ok(worstStep <= 0.4, `historial: la cabeza salta ${worstStep.toFixed(3)} m entre dos muestras de 20 Hz`);
  note(`1c transiciones (agacharse ${TUNING.fp.crouchTime} s, asomo ${TUNING.fp.peekRise}/${TUNING.fp.peekFall} s, lean ${TUNING.fp.leanTime} s, cancelaciones): ojo ≤ ${worstOwn.toFixed(3)} m de su cabeza; frente a la cabeza que acepta el servidor (guarda 8/s) ≤ ${worstSrv.toFixed(3)} m (tope de origen 0.4); historial ≤ ${worstStep.toFixed(3)} m por muestra`);
}
// cámara suavizada: clampToEye nunca la deja fuera de la bola
{
  let cam = [0, 1.48, 0], w = 0;
  for (let i = 0; i < 400; i++) {
    const t = i / 60, pose = { st: 'crouch', ce: (Math.sin(t * 9) + 1) / 2, cl: Math.sin(t * 5), aim: i % 50 < 25, wep: 'smg' };
    const e = eyeWorld(pose, 0, 0, 0, 0);
    cam = cam.map((v, k) => v + (e[k] - v) * 0.15); // suavizado agresivo
    cam = clampToEye(pose, 0, 0, 0, 0, cam);
    const hv = hitPose(pose).h;
    w = Math.max(w, Math.hypot(cam[0] - hv[1], cam[1] - hv[2], cam[2] + hv[0]));
  }
  assert.ok(w <= EYE_MAX + 1e-9, `clampToEye dejó la cámara a ${w}`);
}
// localPose = postureOf (lo que viaja) para un controlador FPS
assert.deepEqual(localPose({ animState: () => 'idle', stanceLow: 0.4, lean: 0.5, aim: true, cam: { pitch: 0.1 } }, 'smg'),
  { st: 'crouch', aim: true, ce: 0.6, cl: 0.5, pitch: 0.1, wep: 'smg', sp: 0 }, 'levantándose debe viajar como crouch con la altura real');

// ---------- 2. LOW 1.1 m ----------
const mkWorld = (colliders) => {
  const w = Object.create(World.prototype);
  w.fx = 60; w.fz = 60; w.surfaceZones = []; w.segmentColliders = []; w.colliders = colliders;
  return w;
};
// bloque LOW de 0.6 m de fondo (z ∈ [-0.6, 0]); el jugador a 0.38 m detrás
const LOW = mkWorld([{ minx: -3, maxx: 3, minz: -0.6, maxz: 0, h: 1.1 }]);
const P = { x: 0, z: 0.38 };
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const sees = (world, a, b) => {
  const d = V(b).sub(V(a)), L = d.length();
  return world.raycast(V(a), d.normalize(), L - 1e-3) === null;
};
// puntos de la esfera de cabeza + cápsula (muestras superficiales)
function volumePoints(pose, x, z, yaw = Math.PI) {
  const f = hitFields(pose, x, 0, z, yaw), v = f.hit ?? (f.crouch
    ? { hx: x, hy: 0.86, hz: z, hr: 0.22, ax: x, ay: 0.26, az: z, bx: x, by: 0.6, bz: z, br: 0.42 }
    : { hx: x, hy: 1.52, hz: z, hr: 0.22, ax: x, ay: 0.35, az: z, bx: x, by: 1.3, bz: z, br: 0.4 });
  const pts = [];
  for (let i = 0; i < 200; i++) {
    const u = (i + 0.5) / 200, th = Math.acos(1 - 2 * u), ph = i * 2.39996;
    const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    pts.push({ p: [v.hx + d[0] * v.hr * 0.999, v.hy + d[1] * v.hr * 0.999, v.hz + d[2] * v.hr * 0.999], part: 'head' });
    for (const k of [0, 0.5, 1]) pts.push({ p: [v.ax + (v.bx - v.ax) * k + d[0] * v.br * 0.999, v.ay + (v.by - v.ay) * k + d[1] * v.br * 0.999, v.az + (v.bz - v.az) * k + d[2] * v.br * 0.999], part: 'body' });
  }
  // bajo el suelo no hay nada que ver
  return { v, pts: pts.filter((q) => q.p[1] > 0.02) };
}
const target = (pose) => ({ id: 't', x: P.x, z: P.z, y: 0, alive: true, ...hitFields(pose, P.x, 0, P.z, Math.PI) });
const shotHits = (world, from, pose, aimAt) => {
  const d = V(aimAt).sub(V(from)).normalize();
  return resolveShot(world, [target(pose)], V(from), d, 80).kind === 'player';
};
// a) agachado (con y sin inclinación): desde ojos de agachado (0.82) a 2–40 m
//    del frente, nada visible ni impactable
for (const pose of [{ st: 'crouch' }, { st: 'crouch', cl: 1 }, { st: 'crouch', cl: -1 }, { st: 'crouch', aim: true, ce: 0 }]) {
  const { pts } = volumePoints(pose, P.x, P.z);
  for (const D of [2, 4, 8, 15, 25, 40]) for (const lx of [-2, 0, 2]) {
    const eye = [lx, EYE_C, -0.6 - D];
    for (const q of pts) {
      assert.ok(!sees(LOW, eye, q.p), `agachado ${JSON.stringify(pose)} visible desde ojos agachados a ${D} m (${q.part} ${q.p.map((v) => v.toFixed(2))})`);
      assert.ok(!shotHits(LOW, eye, pose, q.p), `agachado ${JSON.stringify(pose)} impactable desde ${D} m (${q.part})`);
    }
  }
}
// b) desde ojos DE PIE: el casco agachado (tope 1.08) asoma por
//    encima del borde trasero en una franja corta: se mide hasta qué distancia
let standSeen = 0, standDepth = 0;
{
  const pose = { st: 'crouch' }, { pts } = volumePoints(pose, P.x, P.z);
  for (let D = 0.5; D <= 40; D += 0.25) {
    const eye = [0, EYE_S, -0.6 - D];
    let hit = false;
    for (const q of pts) if (shotHits(LOW, eye, pose, q.p)) { hit = true; standDepth = Math.max(standDepth, q.p[1]); }
    if (hit) standSeen = Math.max(standSeen, D);
  }
}
note(`2a agachado tras LOW (a 0.38 m del borde): 0 de 1600 muestras impactables desde ojos agachados (${EYE_C.toFixed(2)}) a 2–40 m, con y sin inclinación`);
note(`2b desde ojos DE PIE (${EYE_S.toFixed(2)}) frente al bloque (0.6 m de fondo): ${standSeen ? `impactable hasta ${standSeen} m (asoma la coronilla)` : 'nada impactable a 0.5–40 m'}`);
// c) agachado no ve por encima: su ojo no alcanza la cabeza de un rival de pie
//    ni de uno agachado a nivel del suelo
{
  const eye = eyeWorld({ st: 'crouch' }, P.x, 0, P.z, Math.PI);
  for (const D of [1, 3, 8, 20, 40]) for (const h of [0.86, 1.52, 1.74])
    assert.ok(!sees(LOW, eye, [0, h, -0.6 - D]), `agachado ve por encima del LOW un punto a ${h} m, ${D} m`);
  // ni con el asomo a medias por debajo del borde
  let ceMax = 0;
  for (let ce = 0; ce <= 1.0001; ce += 0.01) {
    const e = eyeWorld({ st: 'crouch', aim: true, ce, wep: 'smg' }, P.x, 0, P.z, Math.PI);
    if (![1, 3, 8, 20].some((D) => sees(LOW, e, [0, 1.52, -0.6 - D]))) ceMax = ce;
  }
  note(`2c agachado: no ve por encima (ojo ${EYE_C.toFixed(2)}); en el asomo empieza a ver una cabeza de pie con ce > ${ceMax.toFixed(2)}`);
  // d) asomo: (i) si su ojo ve el OJO del rival, el rival ve el suyo (mismo
  //    segmento) y su ojo está ≥0.10 m dentro de su esfera: el tiro es cabeza.
  //    (ii) si solo ve el CENTRO de la cabeza del rival, se mide si el rival
  //    impacta algo de su cabeza (no es simétrico: cada ojo está a ≤0.12 m de
  //    su centro).
  let minExposed = Infinity, eyeCases = 0, centreCases = 0, centreNoHit = 0, ceEye = null;
  for (let ce = 0; ce <= 1.0001; ce += 0.01) {
    const pose = { st: 'crouch', aim: true, ce, wep: 'smg' };
    const e = eyeWorld(pose, P.x, 0, P.z, Math.PI);
    const { pts } = volumePoints(pose, P.x, P.z), hs = pts.filter((q) => q.part === 'head');
    for (const D of [1, 3, 8, 20]) {
      const rivalEye = [0, EYE_S, -0.6 - D];
      if (sees(LOW, e, rivalEye)) {
        eyeCases++; if (ceEye === null) ceEye = ce;
        assert.ok(shotHits(LOW, rivalEye, pose, e), `asomo ce ${ce.toFixed(2)}: ve el ojo del rival y su ojo no es impactable`);
        minExposed = Math.min(minExposed, hs.filter((q) => shotHits(LOW, rivalEye, pose, q.p)).length / hs.length);
      } else if (sees(LOW, e, [0, 1.52, -0.6 - D])) {
        centreCases++;
        if (!hs.some((q) => shotHits(LOW, rivalEye, pose, q.p))) centreNoHit++;
      }
    }
  }
  assert.equal(centreNoHit, 0, `asomo: ve el centro de la cabeza del rival sin exponer nada de la suya (${centreNoHit} casos)`);
  note(`2d asomo: ve el ojo del rival desde ce ≥ ${ceEye?.toFixed(2)}; en los ${eyeCases} casos su ojo es impactable desde el rival (cabeza visible ≥ ${(minExposed * 100).toFixed(0)} % de las muestras); en ${centreCases} casos solo ve el centro de la cabeza del rival y aun así el rival impacta parte de la suya`);
}
// f) asomo ce 0→1: ojo y tope de la esfera sin escalones (paso de 0.001)
{
  let de = 0, dt = 0, prevE = null, prevT = null;
  for (const aim of [true, false]) for (let i = 0; i <= 1000; i++) {
    const pose = { st: 'crouch', aim, ce: i / 1000, wep: 'smg' };
    const e = eyeFromPose(pose).y, top = hitPose(pose).h[2] + HEAD_R;
    if (i) { de = Math.max(de, Math.abs(e - prevE)); dt = Math.max(dt, Math.abs(top - prevT)); }
    prevE = e; prevT = top;
  }
  assert.ok(de < 0.004 && dt < 0.004, `asomo con escalón: ojo ${de}, tope ${dt}`);
  note(`2f asomo ce 0→1 (1000 pasos, con y sin ADS): ojo y tope de la esfera continuos, paso máx ${(de * 1000).toFixed(2)} / ${(dt * 1000).toFixed(2)} mm (pendiente ≤ ${(Math.max(de, dt) * 1000).toFixed(1)} m por unidad de ce)`);
  // qué ve agachado por encima de cada cobertura: altura mínima visible a
  // 10 y 30 m más allá de la cara (la arista cercana manda)
  const rows = [];
  for (const [name, H] of [['LOW', 1.1], ['MID', 1.9], ['HIGH', 3.0]]) for (const d of [0.5, 1, 2, 4]) {
    const slope = (H - EYE_C) / d;
    rows.push(`${name}@${d}m: >${(H + slope * 10).toFixed(1)} m a 10 m, >${(H + slope * 30).toFixed(1)} a 30 m`);
  }
  note(`2g agachado (ojo ${EYE_C.toFixed(2)}) por encima de la cobertura ve solo: ${rows.join(' · ')}`);
}
// h) bordes a la altura de la cabeza (techos de coche de calle2: SUV 1.50,
//    sedán 1.57) y exposición en el instante en que el ojo asoma: con una
//    línea de visión horizontal, el ojo ve por encima del borde H cuando
//    y_ojo > H; se expone el casquete de la esfera por encima de H.
{
  const cap = (top, H) => Math.max(0, Math.min(2 * HEAD_R, top - H));
  const rows = [];
  for (const [name, dz] of [['antes (ojo −0.04)', -0.04], ['ahora (ojo +0.08)', EYE_S - hitPose({ st: 'idle' }).h[2]]]) {
    // al asomar: el ojo justo en el borde → centro = H − dz
    const h = HEAD_R - dz; // altura del casquete expuesto
    rows.push(`${name}: ${(h * 100).toFixed(0)} cm de casco (${(100 * h / (2 * HEAD_R)).toFixed(0)} % del área)`);
  }
  // de pie tras un coche: ve un ojo rival de pie por encima, a 2–30 m
  const head = hitPose({ st: 'idle' }).h;
  for (const H of [1.5, 1.57]) {
    const car = mkWorld([{ minx: -1, maxx: 1, minz: -1.9, maxz: 0, h: H }]);
    for (const D of [2, 5, 10, 30]) {
      const me = [0, EYE_S, 0.45], rival = [0, EYE_S, -1.9 - D];
      assert.ok(sees(car, me, rival), `de pie tras techo de ${H} m no ve un ojo de pie a ${D} m`);
    }
    rows.push(`techo ${H} m: ve por encima (ojo ${EYE_S.toFixed(2)}), casco expuesto ${(cap(head[2] + HEAD_R, H) * 100).toFixed(0)} cm`);
  }
  note(`2h al asomar por un borde: ${rows.join(' · ')}`);
}
// e) de pie tras LOW: la esfera de cabeza entera queda por encima del borde y
//    visible desde ojos de pie a 2–40 m
{
  const pose = { st: 'idle' }, { pts } = volumePoints(pose, P.x, P.z), hs = pts.filter((q) => q.part === 'head');
  assert.ok(hitPose(pose).h[2] - HEAD_R > 1.1, 'de pie: la cabeza no está entera sobre LOW');
  let minFrac = 1;
  for (const D of [2, 4, 8, 15, 25, 40]) {
    const eye = [0, EYE_S, -0.6 - D];
    // hemisferio orientado al rival (el resto lo tapa la propia cabeza)
    const front = hs.filter((q) => q.p[2] < P.z);
    const frac = front.filter((q) => sees(LOW, eye, q.p)).length / front.length;
    minFrac = Math.min(minFrac, frac);
  }
  assert.equal(minFrac, 1, `de pie: solo ${(minFrac * 100).toFixed(0)} % del hemisferio frontal de la cabeza a la vista`);
  note(`2e de pie tras LOW: cabeza 1.30–1.74 por encima del borde; 100 % del hemisferio frontal visible desde ojos de pie a 2–40 m`);
}

// ---------- 3. esquina alta: inclinarse ----------
// A detrás de una columna HIGH (3 m) cuya arista está en x=0, z=0; A en
// x=-0.45 (pegado), mirando a -z; se inclina a la derecha (cl 0..1). B en el
// semiplano z<0 a 3–30 m, de pie o agachado, a distintos ángulos.
{
  const COL = mkWorld([{ minx: -3, maxx: 0, minz: -1, maxz: 0, h: 3 }]);
  const A = { x: -0.45, z: 0.6 }, yawA = 0; // adelante = -z
  let pairs = 0, eyeEye = 0, eyeEyeFail = 0, headCase = 0, headFail = 0, eyeSideFail = 0, minDepth = Infinity;
  for (let cl = 0; cl <= 1.0001; cl += 0.05) for (const stA of ['idle', 'crouch']) {
    const pa = { st: stA, cl, aim: true, wep: 'smg', ce: 0 };
    const eA = eyeWorld(pa, A.x, 0, A.z, yawA), vA = hitFields(pa, A.x, 0, A.z, yawA);
    const hA = vA.hit ? [vA.hit.hx, vA.hit.hy, vA.hit.hz] : [A.x, vA.crouch ? 0.86 : 1.52, A.z];
    for (let D = 3; D <= 30; D += 3) for (let ang = -10; ang <= 80; ang += 5) for (const stB of ['idle', 'crouch']) {
      const r = ang * Math.PI / 180, B = { x: Math.sin(r) * D, z: -0.5 - Math.cos(r) * D }, yawB = Math.atan2(B.x - A.x, B.z - A.z);
      const pb = { st: stB, aim: true, wep: 'smg', ce: 0 };
      const eB = eyeWorld(pb, B.x, 0, B.z, yawB), fB = hitFields(pb, B.x, 0, B.z, yawB);
      const hB = fB.hit ? [fB.hit.hx, fB.hit.hy, fB.hit.hz] : [B.x, fB.crouch ? 0.86 : 1.52, B.z];
      pairs++;
      // (i) ojo↔ojo es simétrico, y el ojo de A está ≥0.10 m dentro de su esfera:
      //     si A ve el ojo de B, el tiro de B al ojo de A es cabeza
      if (sees(COL, eA, eB)) {
        eyeEye++;
        const tA = { id: 'A', x: A.x, z: A.z, y: 0, alive: true, ...hitFields(pa, A.x, 0, A.z, yawA) };
        const res = resolveShot(COL, [tA], V(eB), V(eA).sub(V(eB)).normalize(), 80);
        if (!sees(COL, eB, eA) || res.kind !== 'player' || res.part !== 'head') eyeEyeFail++;
        minDepth = Math.min(minDepth, HEAD_R - Math.hypot(eA[0] - hA[0], eA[1] - hA[1], eA[2] - hA[2]));
      }
      // (ii) A ve el CENTRO de la cabeza de B: ¿ve B (desde su ojo) el centro de A?
      if (sees(COL, eA, hB)) {
        headCase++;
        if (!sees(COL, eB, hA)) {
          headFail++;
          // ¿y algún punto de la esfera de A del lado del ojo? (impactable)
          const { pts } = volumePoints(pa, A.x, A.z, yawA);
          const tA = { id: 'A', x: A.x, z: A.z, y: 0, alive: true, ...hitFields(pa, A.x, 0, A.z, yawA) };
          const any = pts.filter((q) => q.part === 'head').some((q) => {
            const res = resolveShot(COL, [tA], V(eB), V(q.p).sub(V(eB)).normalize(), 80);
            return res.kind === 'player' && res.part === 'head';
          });
          if (!any) eyeSideFail++;
        }
      }
    }
  }
  assert.equal(eyeEyeFail, 0, `ojo↔ojo no simétrico en ${eyeEyeFail} casos`);
  assert.equal(eyeSideFail, 0, `A ve la cabeza de B y B no puede impactar NADA de la cabeza de A en ${eyeSideFail} casos`);
  note(`3a esquina alta (${pairs} pares A inclinado × B): A ve el ojo de B en ${eyeEye}; en todos B ve el ojo de A y su tiro es cabeza (ojo ≥ ${minDepth.toFixed(3)} m dentro de la esfera)`);
  note(`3b A ve el CENTRO de la cabeza de B en ${headCase} pares; en ${headFail} (${(100 * headFail / Math.max(1, headCase)).toFixed(1)} %) B no ve el centro de A (los ojos no son el centro: hasta 0.12 m de cada lado), pero en todos B impacta alguna parte de la cabeza de A`);
}
// ---------- 4. cambios de estado: sin saltos de cabeza ni de ojo ----------
// Todos los pares de estados a los que el jugador puede pasar (idle, run,
// roadie, jump, crouch, slide, mantle, melee), con y sin ADS, con
// inclinación y con altura de agachado, y cadenas rápidas (A→B→A con B de
// 0.08 s). Cliente: localPose (instante real del cambio). Servidor: historial
// a 20 Hz → shapeAt (transitionOf). Tope por cuadro (1/60 s): el más rápido
// honesto, agacharse (ver LIMIT). El rig dibuja la
// misma clase de cambio con dos etapas al 90 % en 0.2 s: pico k/e·Δ ≈ 7.1/s·Δ
// (0.43 m → 0.051 m/cuadro); la mezcla de hit-pose (curva suave, 0.2 s) da
// 7.5/s·Δ (0.054 m/cuadro).
{
  const F = TUNING.fp, STATES = ['idle', 'run', 'roadie', 'jump', 'crouch', 'slide', 'mantle', 'melee'];
  // tope: la rampa de agachado honesta con la curva del rig (sube 0.25 m en el
  // primer cuarto de ce, 1.0 m/ce) = 1.0/0.18 s = 5.6 m/s → 0.093 m/cuadro
  // Dos movimientos a la vez (rampa de agachado + desfase de una mezcla, p. ej.
  // sprint → agachado de 0.08 s → sprint) se suman, como en el rig: 0.11.
  const FRAME = 1 / 60, LIMIT = 0.11;
  let worstMantle = 0, worstHead = 0, worstEye = 0, worstIn = 0, worstSrv = 0, worstBlend = 0, worstWhat = '', pairs = 0;
  for (const A of STATES) for (const B of STATES) {
    if (A === B) continue;
    for (const variant of [{ aim: false, cl: 0 }, { aim: true, cl: 0 }, { aim: false, cl: 0.6 }, { aim: true, cl: -0.6 }])
      for (const hold of [0.6, 0.08]) {
        // el vault dura siempre 0.42 s (no se cancela)
        if (B === 'mantle' && hold < TUNING.mantle.time) continue;
        pairs++;
        // controlador simulado: estado por tiempo, stanceLow con su rampa
        const plan = (t) => (t < 0.5 ? A : t < 0.5 + hold ? B : A);
        const player = { aim: variant.aim, cam: { pitch: 0 }, lean: variant.cl, stanceLow: 0, _st: A, _mt: 0,
          animState() { return this._st; }, animParams() { return { mantlePhase: Math.min(1, this._mt / TUNING.mantle.time) }; } };
        let prevH = null, prevE = null, last = -1;
        const hist = [], local = [];
        for (let t = 0; t <= 1.6 + 1e-9; t += FRAME) {
          const st = plan(t);
          if (st !== player._st) { player._st = st; player._mt = 0; }
          player._mt += FRAME;
          const target = st === 'crouch' || st === 'slide' ? 1 : 0;
          const stp = FRAME / F.crouchTime; // controller.js approach()
          player.stanceLow += Math.max(-stp, Math.min(stp, target - player.stanceLow));
          const pose = localPose(player, 'smg', t);
          // lo que NetClient da por enviado en este cuadro (la transición la
          // abre el primer estado enviado con la clave nueva)
          { const { from, fromTo, since, ...raw } = pose; noteSentPose(player, raw, t); }
          const v = hitPose(pose), e = eyeFromPose(pose);
          const eye = [e.f, e.s, e.y];
          worstIn = Math.max(worstIn, Math.hypot(...eye.map((x, i) => x - v.h[i])));
          if (prevH) {
            const dh = Math.hypot(...v.h.map((x, i) => x - prevH[i])), de = Math.hypot(...eye.map((x, i) => x - prevE[i]));
            if (process.env.DEBUG && dh > 0.1) console.log(A, B, JSON.stringify(variant), hold, t.toFixed(3), JSON.stringify({ ...pose, from: pose.from?.st }), v.h.map((x) => x.toFixed(3)).join(','));
            // el vault (mantle, 0.42 s) es más rápido que cualquier mezcla: su
            // curva calibrada sobre el rig va aparte
            if (pose.st === 'mantle') worstMantle = Math.max(worstMantle, dh);
            else if (dh > worstHead) { worstHead = dh; worstWhat = `${A}→${B} ${JSON.stringify(variant)} ${hold}s t=${t.toFixed(2)}`; }
            if (pose.st !== 'mantle') worstEye = Math.max(worstEye, de);
            // parte debida a la MEZCLA de estados (sin la rampa de agachado)
            if (pose.from && pose.st !== 'mantle') worstBlend = Math.max(worstBlend, dh);
          }
          prevH = v.h; prevE = eye;
          local.push({ t, h: v.h });
          // estado difundido a 20 Hz (lo que viaja: postureOf)
          if (Math.round(t * 60) % 3 === 0 && t > last) {
            last = t;
            const ps = postureOf(player);
            hist.push({ at: t, x: 0, y: 0, z: 0, yaw: 0, st: ps.st, aim: variant.aim ? 1 : 0, ce: ps.ce, cl: ps.cl, p: 0, w: 'smg' });
          }
        }
        // servidor/observador: la misma transición reconstruida del historial
        for (const q of local) {
          if (q.t < 0.1 || q.t > hist[hist.length - 1].at) continue;
          // el servidor ya busca el instante en ±CLAIM_JITTER (claimPose): el
          // muestreo a 20 Hz y la entrada a mitad de muestra caben ahí
          let best = Infinity;
          for (let dt = -CLAIM_JITTER; dt <= CLAIM_JITTER + 1e-9; dt += 0.01) {
            const sv = shapeAt(hist, q.t + dt).vol.h;
            best = Math.min(best, Math.hypot(...sv.map((x, i) => x - q.h[i])));
          }
          if (process.env.DEBUG && best > 0.2) console.log('SRV', A, B, JSON.stringify(variant), hold, q.t.toFixed(3), best.toFixed(3), q.h.map((x) => x.toFixed(2)).join(','), shapeAt(hist, q.t).vol.h.map((x) => x.toFixed(2)).join(','));
          worstSrv = Math.max(worstSrv, best);
        }
      }
  }
  assert.ok(worstIn <= EYE_MAX + 1e-9, `cambio de estado: ojo a ${worstIn.toFixed(3)} m de la cabeza`);
  assert.ok(worstHead <= LIMIT && worstEye <= LIMIT, `cambio de estado: la cabeza salta ${worstHead.toFixed(3)} m / el ojo ${worstEye.toFixed(3)} m en un cuadro (${worstWhat})`);
  // cliente frente a servidor: dentro del radio de origen (0.4) con margen; el
  // resto es el redondeo del instante de entrada (±25 ms de 0.2 s)
  assert.ok(worstSrv <= 0.25, `cambio de estado: servidor y cliente difieren ${worstSrv.toFixed(3)} m`);
  assert.ok(worstMantle <= 0.12, `mantle: ${worstMantle}`);
  note(`4 cambios de estado (${pairs} casos: 8 estados × pares × ADS/inclinación × cadena de 0.08 s): cabeza ≤ ${(worstHead * 1000).toFixed(0)} mm/cuadro (${worstWhat}), ojo ≤ ${(worstEye * 1000).toFixed(0)} mm/cuadro, solo mezcla ≤ ${(worstBlend * 1000).toFixed(0)} mm/cuadro (≈${(worstBlend * 60).toFixed(1)} m/s; rig ≈ 3.1 m/s para 0.43 m); ojo ≤ ${worstIn.toFixed(3)} m de la cabeza; servidor vs cliente ≤ ${worstSrv.toFixed(3)} m; dentro del vault (curva del mantle) ≤ ${(worstMantle * 1000).toFixed(0)} mm/cuadro`);
}

// El servidor recibe 400 ms de silencio en plena mezcla. El ojo al disparar
// después de la primera muestra debe seguir el mismo tiempo que el cliente.
{
  const {recordOwnPose, shotPose, eyeWorld} = await import('../src/combat/hit-pose.js');
  const replay = gap => {
    const h = [];
    for (const [ct,st] of [[0,'roadie'],[0.05,'slide'],[0.10,'slide'],[0.13,'slide'],[0.15,'slide']]) {
      recordOwnPose(h,{at:ct+(ct>=0.13?gap:0), ct, st, yaw:0, sp:1, w:'smg'});
    }
    return eyeWorld(shotPose(h),0,0,0,0);
  };
  const expected = replay(0);
  assert.ok(Math.hypot(...replay(0.40).map((v,i) => v-expected[i])) <= 1e-9,
    'el silencio de 400 ms adelantó el ojo del slide');
}
console.log('FPS EYE OK');
