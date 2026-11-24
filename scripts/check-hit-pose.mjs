// Lo DIBUJADO debe ser lo IMPACTABLE (src/combat/hit-pose.js).
//   node scripts/check-hit-pose.mjs --node-only   contratos puros (cadena test)
//   node scripts/check-hit-pose.mjs               + rig real en el navegador
//                                                 (cadena test:dev, Vite en 5200)
// La parte de navegador habría detectado el defecto de cover bajo: al apuntar
// sobre el bloque el casco dibujado asomaba por encima y ningún rayo frontal
// podía impactarlo porque el volumen seguía siendo el agachado.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/world/world.js';
import { resolveShot, rayCapsule, raySegmentCapsule } from '../src/combat/ballistics.js';
import {
  hitPose, hitFields, placeHitPose, STAND, CROUCH, claimFit, headFit, claimBand,
  claimPose, shapeAt, poseAt, hitAimHeights, setHitModel, viewDelay, CLAIM_JITTER, CLAIM_REWIND_MAX,
  RTT_CAP, ROLL_DUR, volContains,
} from '../src/combat/hit-pose.js';
import { blastBodyHeight } from '../src/combat/blast.js';
import { TUNING } from '../src/config/tuning.js';

// ---------- 1. poses de siempre: exactamente el volumen de siempre ----------
for (const st of ['idle', 'run', 'jump', 'melee', 'dead', 'blind_high_left', 'blind_high_right'])
  assert.equal(hitPose({ st, aim: false, ce: 1 }), STAND, `${st} dejó de usar el volumen de pie`);
for (const st of ['melee', 'dead', 'blind_high_left', 'blind_high_right'])
  assert.equal(hitPose({ st, aim: true, ce: 1 }), STAND, `${st} con aim dejó de usar el volumen de pie`);
assert.equal(hitPose({ st: 'cover_high', aim: true, ce: 0 }), STAND, 'cover alto sin asomarse cambió');
for (const st of ['blind_low_left', 'blind_low_right'])
  assert.equal(hitPose({ st }), CROUCH, `${st}: el blindfire lateral perdió su protección`);
assert.equal(hitPose({ st: 'cover_low', aim: false, ce: 1 }), CROUCH, 'escondido tras cover bajo no es el agachado de siempre');
assert.equal(hitPose({ st: 'cover_low', aim: true }), CROUCH, 'sin `ce` (cliente antiguo) debe valer la regla antigua');

// ---------- 2. la subida sobre cover bajo sigue a la exposición, sin saltos ----------
let prev = hitPose({ st: 'cover_low', aim: true, ce: 0 });
assert.deepEqual([prev.h, prev.a, prev.b, prev.br], [CROUCH.h, CROUCH.a, CROUCH.b, CROUCH.br], 'ce=0 no parte del agachado');
for (let i = 1; i <= 100; i++) {
  const v = hitPose({ st: 'cover_low', aim: true, ce: i / 100 });
  assert.ok(Math.abs(v.h[2] - prev.h[2]) <= 0.012 && Math.abs(v.b[2] - prev.b[2]) <= 0.012, `salto de volumen en ce=${i / 100}`);
  prev = v;
}
assert.ok(prev.h[2] - prev.hr > 1.1, 'apuntando sobre cover bajo la cabeza sigue bajo el borde (1.1 m)');

// ---------- 3. cápsula de eje libre = cápsula vertical de siempre ----------
let rnd = 12345;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
let agree = 0;
for (let i = 0; i < 4000; i++) {
  const o = new THREE.Vector3((rand() - 0.5) * 16, rand() * 3, (rand() - 0.5) * 16);
  if (Math.hypot(o.x, o.z) < 1) continue;
  const d = new THREE.Vector3(-o.x + (rand() - 0.5) * 2, 1.0 - o.y + (rand() - 0.5) * 2, -o.z + (rand() - 0.5) * 2).normalize();
  const t0 = rayCapsule(o, d, 0, 0, 0.35, 1.3, 0.4);
  const legacy = t0 !== null && o.y + d.y * t0 > 1.3 + 0.12 ? null : t0;
  const t1 = raySegmentCapsule(o, d, 0, 0.35, 0, 0, 1.3, 0, 0.4);
  if (legacy !== null) assert.ok(t1 !== null && Math.abs(t1 - legacy) < 1e-6, `cápsula libre distinta de la vertical: ${legacy} vs ${t1}`);
  agree++;
}
assert.ok(agree > 3000);

// ---------- 4. servidor: con las poses de siempre, las reglas de siempre ----------
const oldFit = (crouched, relY, horiz) => relY >= 0.12 && relY <= (crouched ? 1.18 : 1.88) && horiz <= 0.82;
const oldHead = (crouched, relY, horiz) => relY >= (crouched ? 0.66 : 1.30) && relY <= (crouched ? 1.16 : 1.82) && horiz <= 1.25;
for (const [st, crouched] of [['idle', false], ['cover_low', true], ['run', false], ['blind_low_left', true]]) {
  const pose = { at: 0, st, aim: 0, x: 3, y: 0.5, z: -2, yaw: 0.7, cl: 0, p: 0 };
  const { vol } = shapeAt([pose], 0);
  for (let y = -0.2; y <= 2.6; y += 0.04) for (let r = 0; r <= 1.5; r += 0.05) {
    const point = [3 + r * 0.6, 0.5 + y, -2 + r * 0.8];
    assert.equal(claimFit(vol, pose, point) !== null, oldFit(crouched, y, r), `${st}: claim ${y.toFixed(2)}/${r} cambió`);
    assert.equal(headFit(vol, pose, point) !== null, oldHead(crouched, y, r), `${st}: cabeza ${y.toFixed(2)}/${r} cambió`);
  }
}
// historial = poses DIFUNDIDAS a 20 Hz (reloj monótono); el último es el estado actual
const snaps = (from, to, f) => { const h = []; for (let t = from; t <= to + 1e-9; t += 0.05) h.push({ at: +t.toFixed(3), ...f(t) }); return h; };
const upto = (h, t) => h.filter((p) => p.at <= t);
const base = { x: 0, y: 0, z: 0, yaw: 0, p: 0, ae: 0, cl: 0, sp: 0, w: 'smg' };
// apuntando sobre cover bajo: el casco alzado ya es cabeza para el servidor;
// escondido no; sin `ce` (cliente viejo) o tirador con modelo anterior, regla antigua
const up = { ...base, at: 0, st: 'cover_low', aim: 1, ce: 1 };
const upVol = hitPose({ st: 'cover_low', aim: true, ce: 1 }), helmet = [0, upVol.h[2], -upVol.h[0]];
assert.ok(claimPose([up], 1, helmet, { rtt: 0.05 })?.head, 'servidor rechaza el casco alzado');
assert.equal(claimPose([up], 1, helmet, { rtt: 0.05, legacy: true }), null, 'tirador con modelo anterior: debe valer la regla antigua');
for (const hidden of [{ ...up, aim: 0 }, { ...up, ce: 0 }, (({ ce, ...rest }) => rest)(up)])
  assert.equal(claimPose([hidden], 1, helmet, { rtt: 0.05 }), null, 'servidor acepta impactos sobre un agachado escondido');

// ---------- 4b. un instante, el que veía el tirador ----------
// rebobinado: interpDelay + rtt (tope RTT_CAP) ± CLAIM_JITTER
assert.ok(Math.abs(CLAIM_REWIND_MAX - (TUNING.net.interpDelay + RTT_CAP + CLAIM_JITTER)) < 1e-9 && CLAIM_REWIND_MAX <= 0.46);
assert.equal(viewDelay(5), viewDelay(RTT_CAP), 'rtt sin tope');
// cover: tiempo que el casco alzado sigue impactable tras agacharse
const duckTime = (rtt) => {
  const Td = 1.0, h = snaps(0, 2, (t) => (t < Td ? { ...base, st: 'cover_low', aim: 1, ce: 1 } : { ...base, st: 'cover_low', aim: 0, ce: 0 }));
  let last = 0;
  for (let dt = 0; dt <= 1; dt += 0.01) if (claimPose(upto(h, Td + dt), Td + dt, helmet, { rtt })) last = dt;
  return last;
};
assert.ok(duckTime(0.05) <= 0.26, `honesto: casco impactable ${duckTime(0.05).toFixed(2)} s tras agacharse`);
assert.ok(duckTime(3) <= CLAIM_REWIND_MAX + 0.05, `pongs retrasados: ${duckTime(3).toFixed(2)} s`);
// subida: ninguna cabeza mostrada se descarta
{
  const T0 = 1.0, ce = (t) => (t < T0 ? 0 : 1 - Math.exp(-TUNING.cover.aimEnterRate * (t - T0)));
  const r = snaps(0, 2, (t) => ({ ...base, st: 'cover_low', aim: t >= T0 ? 1 : 0, ce: ce(t) }));
  for (const rtt of [0.03, 0.1, 0.2]) for (let v = T0; v <= T0 + 0.5; v += 0.01) {
    const shown = poseAt(r, v), vol = hitPose({ st: 'cover_low', aim: !!shown.aim, ce: shown.ce });
    const shotAt = v + viewDelay(rtt);
    assert.ok(claimPose(upto(r, shotAt), shotAt, [0, vol.h[2], -vol.h[0]], { rtt })?.head,
      `subida: cabeza mostrada (ce ${shown.ce?.toFixed(2)}) descartada, rtt ${rtt}`);
  }
}
// acciones: la cabeza DIBUJADA por el observador valida en cada fase, y la de
// una fase distinta (o de pie) no
const shownHead = (h, st, v, extra = {}) => {
  const vol = shapeAt(h, v).vol; return [vol.h[1] * 1 + 0, vol.h[2], -vol.h[0]];
};
// flip en ambos sentidos: doble salto lateral izquierda/derecha (≥ 5.5 m/s)
for (const dir of [1, -1]) {
  const vx = dir * 6.4, T = 1.0;
  const h = snaps(0, 2.2, (t) => (t < T ? { ...base, st: 'idle', sp: 0 }
    : t < T + ROLL_DUR ? { ...base, st: 'flip', x: vx * (t - T), y: 1, sp: 6.4 / TUNING.move.roadieSpeed } : { ...base, st: 'idle', x: vx * ROLL_DUR }));
  for (let v = T + 0.08; v <= T + ROLL_DUR - 0.05; v += 0.05) {
    const p = poseAt(h, v), sh = shapeAt(h, v), w = placeHitPose(sh.vol, p.x, p.y, p.z, p.yaw);
    const shotAt = v + viewDelay(0.05), res = claimPose(upto(h, shotAt), shotAt, [w.hx, w.hy, w.hz], { rtt: 0.05 });
    assert.ok(res?.head, `flip ${dir > 0 ? 'derecha' : 'izquierda'}: casco mostrado rechazado en fase ${((v - T) / ROLL_DUR).toFixed(2)}`);
  }
  // a media vuelta la cabeza está abajo: una cabeza a altura de pie no vale
  const mid = T + ROLL_DUR / 2, shotAt = mid + viewDelay(0.05), pm = poseAt(h, mid);
  assert.ok(!claimPose(upto(h, shotAt), shotAt, [pm.x, 1 + 1.55, 0], { rtt: 0.05 })?.head, 'flip: cabeza de pie aceptada boca abajo');
}
// mantle: sin volumen extra de media fase; dive sin hueco en la banda de cabeza
for (const [st, dur] of [['mantle', TUNING.mantle.time], ['dive', TUNING.evade.diveTime]]) {
  const T = 1.0, h = snaps(0, 2, (t) => ({ ...base, st: t >= T && t < T + dur ? st : 'idle' }));
  for (let v = T + 0.05; v < T + dur - 0.02; v += 0.03) {
    const sh = shapeAt(h, v), shotAt = v + viewDelay(0.05);
    assert.ok(claimPose(upto(h, shotAt), shotAt, [0, sh.vol.h[2], -sh.vol.h[0]], { rtt: 0.05 })?.head, `${st}: cabeza dibujada rechazada`);
  }
}
{
  const T = 1.0, h = snaps(0, 2, (t) => ({ ...base, st: t >= T && t < T + 0.42 ? 'mantle' : 'idle' }));
  // saliendo del vault (fase 0.9) ya no vale la cabeza agachada de media fase
  const late = T + 0.38, half = hitPose({ st: 'mantle', phase: 0.5 }), shotAt = late + viewDelay(0.05);
  const res = claimPose(upto(h, shotAt), shotAt, [0, half.h[2], -half.h[0]], { rtt: 0.05 });
  assert.ok(!res?.head, 'mantle: se aceptó la cabeza de media fase al salir');
}
// UN instante coherente: cruzó una puerta (x=0) y se agachó en x=3. Ni la
// postura de un momento con la posición de otro, ni snapshots posteriores al
// disparo.
{
  const T1 = 1.0, T2 = 1.3;
  const h = snaps(0, 3, (t) => (t < T1 ? { ...base, st: 'run', x: 0 }
    : t < T2 ? { ...base, st: 'run', x: 3 * (t - T1) / (T2 - T1) } : { ...base, st: 'blind_low_left', x: 3 }));
  const shotAt = T2 + 0.4, crouchHead = [0, CROUCH.h[2], 0];
  assert.equal(claimPose(upto(h, shotAt), shotAt, crouchHead, { rtt: 0.05 }), null, 'puerta: postura agachada aceptada donde estuvo de pie');
  assert.ok(claimPose(upto(h, shotAt), shotAt, [3, CROUCH.h[2], 0], { rtt: 0.05 })?.head, 'puerta: rechazado donde y como se le veía');
  // y donde estaba DE PIE en el instante visto, con la postura de pie, sí
  const seen = T1 - 0.1 + viewDelay(0.05);
  assert.ok(claimPose(upto(h, seen), seen, [0, STAND.h[2], 0], { rtt: 0.05 })?.head, 'puerta: de pie en la puerta rechazado');
  // un snapshot difundido DESPUÉS del disparo no cuenta
  const late = [...upto(h, T1), { ...base, at: T1 + 0.02, st: 'idle', x: 9 }];
  assert.equal(claimPose(late, T1, [9, STAND.h[2], 0], { rtt: 0.05 }), null, 'se usó un snapshot posterior al disparo');
}
// borde del rebobinado: nunca una pose posterior a la recepción del disparo
{
  const pt = [0, STAND.h[2], 0], st = { ...base, st: 'idle' };
  assert.equal(claimPose([], 1, pt, { rtt: 0.05 }), null, 'historial vacío validó un impacto');
  assert.equal(claimPose([{ ...st, at: 1.04 }], 1, pt, { rtt: 0.05 }), null, 'snapshot 40 ms POSTERIOR a la recepción validó el impacto');
  assert.ok(claimPose([{ ...st, at: 0.5 }], 1, pt, { rtt: 0.05 })?.head, 'una sola muestra anterior (pose sostenida) debe validar');
  // recién reaparecido: la pose de reaparición (anterior al disparo) es la que vale
  assert.ok(claimPose([{ ...st, at: 0.99, x: 5 }], 1, [5, STAND.h[2], 0], { rtt: 0.05 })?.head, 'recién reaparecido: pose de reaparición rechazada');
  assert.equal(claimPose([{ ...st, at: 0.5, x: 9 }, { ...st, at: 1.04 }], 1, pt, { rtt: 0.05 }), null, 'se usó la muestra posterior en vez de la anterior');
}
// sniper a quemarropa dentro de la cabeza: cabeza aunque no haya dirección
{
  const st = { ...base, at: 0, st: 'idle' };
  const r = claimPose([st], 1, [0, STAND.h[2], 0], { rtt: 0.05, headOk: () => false, pointBlank: true });
  assert.ok(r?.head, 'quemarropa dentro de la cabeza no cuenta como cabeza');
  assert.ok(!claimPose([st], 1, [0, STAND.h[2], 0], { rtt: 0.05, headOk: () => false })?.head, 'sin quemarropa el rayo del sniper sigue mandando');
}
// Observador remoto: su estado de impacto es función pura de los snapshots.
// Mismo flujo con y sin poses de fuego intercaladas → hitPoseInput idéntico en
// cada cuadro; y el volumen coincide con la reconstrucción del servidor.
{
  const { RemotePlayer } = await import('../src/player/remote.js');
  const stubRig = () => ({ setTransform() {}, update() {}, setWeapon() {}, setProtected() {}, dispose() {}, groundFn: null });
  const RS = TUNING.move.roadieSpeed;
  const streams = {
    flip: (t) => (t < 1 ? { st: 'run', x: -6.4 * (1 - t) * 0.2, sp: 6.4 / RS }
      : t < 1 + ROLL_DUR ? { st: 'flip', x: -6.4 * (t - 1), y: 1, sp: 6.4 / RS } : { st: 'idle', x: -6.4 * ROLL_DUR }),
    mantle: (t) => ({ st: t >= 1 && t < 1.42 ? 'mantle' : 'idle', z: t >= 1 ? -(t - 1) : 0 }),
    dive: (t) => ({ st: t >= 1 && t < 1 + TUNING.evade.diveTime ? 'dive' : 'run', z: -4 * t, sp: 0.6 }),
    // FPS: agacharse (ce = altura de cabeza), asomo con ADS e inclinación
    crouch: (t) => ({ st: t >= 0.8 && t < 1.8 ? 'crouch' : 'idle', ce: t < 0.8 ? 1 : t < 1.4 ? Math.max(0, 1 - (t - 0.8) / 0.18) : Math.min(1, (t - 1.4) / 0.2),
      aim: t >= 1.4 ? 1 : 0, cl: Math.max(-1, Math.min(1, Math.sin(t * 3) * 1.2)), x: 0.5 * t }),
  };
  const round = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(5) : v));
  for (const [name, f] of Object.entries(streams)) {
    const snapsS = [];
    for (let t = 0; t <= 2 + 1e-9; t += 0.05) snapsS.push({ rt: +t.toFixed(3), x: 0, y: 0, z: 0, yaw: 0, aim: 0, p: 0, ae: 0, cl: 0, w: 'smg', sp: 0, ...f(t) });
    const A = new RemotePlayer(null, 'a', 'A', 'red', 0, stubRig()), B = new RemotePlayer(null, 'b', 'B', 'red', 0, stubRig());
    let k = 0, frames = 0, worst = 0;
    for (let now = 0; now <= 2.1; now += 1 / 60) {
      while (k < snapsS.length && snapsS[k].rt <= now) { const { rt, ...sn } = snapsS[k]; A.push(sn, rt); B.push(sn, rt); k++; }
      // poses de fuego intercaladas en B (otro estado, ADS, exposición, asomado)
      if (Math.round(now * 60) % 5 === 0) B.applyFirePose({ st: 'cover_low', a: 1, p: 0.3, ae: 0.2, cl: 1, ce: 0.7 }, 'shotgun');
      A.update(1 / 60, null, now); B.update(1 / 60, null, now);
      if (!A._hitSnap) continue;
      const ia = A.hitPoseInput(), ib = B.hitPoseInput();
      assert.equal(round(ib), round(ia), `${name}: una pose de fuego cambió el estado de impacto (t=${now.toFixed(3)})`);
      // reconstrucción del servidor con el mismo flujo (difundido = recibido)
      const t = now - TUNING.net.interpDelay;
      const hist = snapsS.filter((q) => q.rt <= now).map(({ rt, ...q }) => ({ at: rt, ...q }));
      if (t < hist[0].at) continue;
      const sv = shapeAt(hist, t).vol, rv = hitPose(ia);
      const d = Math.max(...['h', 'a', 'b'].map((key) => Math.hypot(...sv[key].map((x, i) => x - rv[key][i]))));
      worst = Math.max(worst, d); frames++;
    }
    assert.ok(frames > 60 && worst < 0.03, `${name}: observador y servidor difieren ${worst.toFixed(3)} m`);
  }
}
// versiones mezcladas: con un servidor anterior el cliente apunta con la regla antigua
setHitModel(1);
assert.equal(hitFields({ st: 'cover_low', aim: true, ce: 1 }, 0, 0, 0, 0).crouch, true, 'modelo 1: cover_low debe ser agachado');
setHitModel(2);
assert.equal(hitFields({ st: 'cover_low', aim: true, ce: 1 }, 0, 0, 0, 0).crouch, false);
// blast: muestrea a la altura de la pose (alzado sobre cover bajo ≈ de pie)
assert.equal(blastBodyHeight({ blastH: hitAimHeights(STAND).blast }), 1.65);
assert.equal(blastBodyHeight({ blastH: hitAimHeights(CROUCH).blast }), 0.85);
assert.ok(blastBodyHeight({ st: 'cover_low', blastH: hitAimHeights(upVol).blast }) > 1.55, 'blast: el alzado sobre cover bajo se muestrea agachado');
// quemarropa en el servidor: contacto de longitud cero dentro del volumen
{
  const dv = { ...base, at: 0, st: 'idle' };
  const res = claimPose([dv], 1, [0, 0.9, 0], { rtt: 0.05 });
  assert.ok(res?.inside, 'contacto dentro del torso no cuenta como contenido');
  assert.ok(!volContains(STAND, dv, [0.7, 0.9, 0]), 'contacto fuera del cuerpo cuenta como contenido');
}

// ---------- 5. resolveShot con el volumen de la pose, tras un cover de 1.1 m ----------
const world = Object.create(World.prototype);
world.fx = 20; world.fz = 20; world.surfaceZones = []; world.segmentColliders = [];
world.colliders = [{ minx: -2, maxx: 2, minz: -2, maxz: 0, h: 1.1 }];
const target = (pose) => ({ id: 't', x: 0, z: 0.38, y: 0, alive: true, ...hitFields(pose, 0, 0, 0.38, 0) });
const shoot = (tg, y) => {
  const o = new THREE.Vector3(0, 1.5, -12), d = new THREE.Vector3(0, y, 0.38).sub(o).normalize();
  return resolveShot(world, [tg], o, d, 80);
};
const aimTg = target({ st: 'cover_low', aim: true, ce: 1, cl: 0, pitch: 0 });
assert.equal(shoot(aimTg, 1.55).part, 'head', 'casco sobre cover bajo no registra cabeza');
assert.equal(shoot(aimTg, 1.25).part, 'body', 'torso sobre cover bajo no registra cuerpo');
for (const y of [0.4, 0.8, 1.05, 1.2, 1.5, 1.8])
  assert.notEqual(shoot(target({ st: 'cover_low', aim: false }), y).kind, 'player', `escondido impactable desde el frente a ${y}`);
// quemarropa: el origen dentro del volumen (cañón dentro de un rival en dive) impacta
{
  const dv = { id: 'd', x: 0, z: 0, y: 0, alive: true, ...hitFields({ st: 'dive', phase: 0.5 }, 0, 0, 0, 0) };
  const w = dv.hit, o = new THREE.Vector3((w.ax + w.bx) / 2, (w.ay + w.by) / 2, (w.az + w.bz) / 2);
  const r0 = resolveShot({ raycast: () => null }, [dv], o, new THREE.Vector3(1, 0, 0), 50);
  assert.ok(r0.kind === 'player' && r0.t === 0, 'quemarropa dentro de la cápsula no impacta');
  const sp = raySegmentCapsule(o, new THREE.Vector3(0, 0, 1), o.x, o.y, o.z, o.x, o.y, o.z, 0.4);
  assert.equal(sp, 0, 'cápsula degenerada (esfera) con origen dentro no impacta');
  // cápsula vertical, mirando recto abajo desde dentro del torso (antes 0.65 m)
  assert.equal(rayCapsule(new THREE.Vector3(0, 1.0, 0), new THREE.Vector3(0, -1, 0), 0, 0, 0.35, 1.3, 0.4), 0, 'vertical: origen dentro no da 0');
  // y desde arriba entra por la tapa superior (antes devolvía la inferior)
  const top = rayCapsule(new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, -1, 0), 0, 0, 0.35, 1.3, 0.4);
  assert.ok(Math.abs(top - (3 - 1.7)) < 1e-6, `vertical desde arriba: ${top}`);
  const st = { id: 's', x: 0, z: 0, y: 0, alive: true, crouch: false };
  const r1 = resolveShot({ raycast: () => null }, [st], new THREE.Vector3(0, 0.9, 0), new THREE.Vector3(1, 0, 0), 50);
  assert.ok(r1.kind === 'player' && r1.t === 0, 'quemarropa dentro de la cápsula vertical no impacta');
}
const placed = placeHitPose(hitPose({ st: 'dive' }), 0, 0, 0, Math.PI / 2);
assert.ok(placed.hx < -0.3, 'el volumen no gira con el yaw del personaje');
console.log('HIT POSE (contratos) OK · poses de siempre intactas, subida continua, servidor coherente');

if (process.argv.includes('--node-only')) process.exit(0);

// ---------- 6. rig real: lo dibujado contra el volumen ----------
const { chromium } = await import('playwright-core');
const { CHROME } = await import('./lib-chrome.mjs');
const { openPractice, measureStances, STANCES, fitTable } = await import('./calibrate-hit-pose.mjs');
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  await openPractice(page);
  const m = await measureStances(page);
  const fresh = fitTable(m);
  // la tabla del módulo debe corresponder al rig actual (si no: recalibrar)
  const cases = {
    low_aim: { st: 'cover_low', aim: true, ce: 1, pitch: 0 },
    low_aim_down: { st: 'cover_low', aim: true, ce: 1, pitch: -0.55 },
    low_lean_r: { st: 'cover_low', aim: true, ce: 1, cl: 1 }, low_lean_l: { st: 'cover_low', aim: true, ce: 1, cl: -1 },
    high_lean_r: { st: 'cover_high', aim: true, cl: 1 }, high_lean_l: { st: 'cover_high', aim: true, cl: -1 },
    ...Object.fromEntries(['pistol', 'smg', 'shotgun', 'sniper', 'bazooka', 'grenade'].flatMap((wep) => [
      [`ads_${wep}`, { st: 'idle', aim: true, wep }], [`ads_${wep}_down`, { st: 'idle', aim: true, wep, pitch: -0.55 }]])),
    blind_over: { st: 'blind_over', pitch: 0 }, blind_over_down: { st: 'blind_over', pitch: -0.55 }, roadie: { st: 'roadie' }, slide: { st: 'slide' },
    dive_5: { st: 'dive', phase: 0.5 }, mantle_4: { st: 'mantle', phase: 0.4 },
    // FPS (corrida 6): agachado, subida (ce) e inclinación
    crouch_idle: { st: 'crouch', ce: 0 }, crouch_aim: { st: 'crouch', aim: true, ce: 0, wep: 'smg' },
    ...Object.fromEntries([25, 50, 75].flatMap((q) => [[`crouch_idle_${q}`, { st: 'crouch', ce: q / 100 }],
      [`crouch_aim_${q}`, { st: 'crouch', aim: true, ce: q / 100, wep: 'smg' }]])),
  };
  // las posturas de cobertura ya no se pueden asentar con el controlador FPS:
  // sin medida, se conservan (las usan los bots) y no se comparan
  const skipped = Object.keys(cases).filter((k) => !fresh[k]);
  for (const k of skipped) delete cases[k];
  // inclinación: la tabla guarda desplazamientos; se compara la pose entera
  for (const sd of ['r', 'l']) {
    const cl = sd === 'r' ? 1 : -1;
    for (const [base, pose] of [['lean_stand', { st: 'idle' }], ['lean_stand_aim', { st: 'idle', aim: true, wep: 'smg' }],
      ['lean_crouch', { st: 'crouch', ce: 0 }], ['lean_crouch_aim', { st: 'crouch', aim: true, ce: 0, wep: 'smg' }]]) {
      if (!m[`${base}_${sd}`]) continue;
      const v = hitPose({ ...pose, cl }), oh2 = [0, 0, 1.52].map((x, i) => x - m.idle.head[i]);
      const head = m[`${base}_${sd}`].head.map((x, i) => x + oh2[i]);
      const dh = Math.hypot(...v.h.map((x, i) => x - head[i]));
      assert.ok(dh <= 0.08, `${base}_${sd}: la cabeza inclinada no sigue al rig (${dh.toFixed(2)} m)`);
    }
  }
  for (const [k, pose] of Object.entries(cases)) {
    const v = hitPose(pose), f = fresh[k];
    const dh = Math.hypot(...v.h.map((x, i) => x - f.h[i])), db = Math.hypot(...v.b.map((x, i) => x - f.b[i]));
    assert.ok(dh <= 0.08 && db <= 0.1, `${k}: el volumen no sigue al rig (cabeza ${dh.toFixed(2)} m, hombros ${db.toFixed(2)} m): node scripts/calibrate-hit-pose.mjs --write`);
  }
  // la cara (visor) de frente debe caer dentro de la esfera de cabeza: con el
  // ADS perfilado la cabeza gira y el visor se apartaba 0.2 m del centro
  const oh = [0, 0, 1.52].map((v, i) => v - m.idle.head[i]);
  for (const [k, pose] of Object.entries(cases)) {
    const v = hitPose(pose), visor = m[k].visor.map((x, i) => x + oh[i]);
    const off = Math.hypot(visor[1] - v.h[1], visor[2] - v.h[2]);
    assert.ok(off <= v.hr * 0.7, `${k}: el visor dibujado queda a ${off.toFixed(2)} m del centro de la cabeza (de frente)`);
  }
  // casco dibujado por encima del cover bajo al apuntar: dentro de la esfera
  if (m.low_aim) {
    const s = m.low_aim, vol = hitPose(cases.low_aim);
    const top = s.headMax[2], centreY = vol.h[2];
    assert.ok(top > 1.1 && centreY + vol.hr > 1.1 + 0.15, `cover bajo + ADS: casco dibujado hasta ${top.toFixed(2)} m, cabeza impactable hasta ${(centreY + vol.hr).toFixed(2)} m`);
  }
  // FPS: agachado, el casco DIBUJADO queda bajo LOW (1.1): lo escondido se
  // dibuja escondido (anclado como la tabla: idle = 1.52)
  const lift = 1.52 - m.idle.head[2];
  for (const k of ['crouch_idle', 'crouch_aim', 'lean_crouch_r', 'lean_crouch_l', 'lean_crouch_aim_r', 'lean_crouch_aim_l'])
    if (m[k]) assert.ok(m[k].headMax[2] + lift < 1.1, `${k}: casco dibujado a ${(m[k].headMax[2] + lift).toFixed(2)} m, asoma sobre LOW`);
  console.log('HIT POSE (rig real) OK ·', Object.keys(cases).length, 'posturas contra el rig,', Object.keys(STANCES).length, 'medidas',
    skipped.length ? `· sin cobertura en el controlador, conservadas: ${skipped.join(', ')}` : '');
} finally { await browser.close(); }
