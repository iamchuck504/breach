// BOTS EN PRIMERA PERSONA (corrida 6): juegan con las reglas del jugador FPS.
// Node puro (mundo sintético con un LOW 1.1 y un HIGH 3.0, rejilla de
// navegación real, bots reales de botmatch.js, azar con semilla). Comprueba:
//  A. partida 2v2 + humano: los bots solo emiten estados del contrato de
//     postura; cada tiro pasa la tabla compartida (fire-gates.js) y el
//     retraso sprint→disparo, sale de una pose ya asentada y del OJO
//     (eyeWorld de su pose), que está dentro de su cabeza replicada.
//  B. tras un LOW: agachado (crouch, ce 0) ni ve ni es visto ni dispara; al
//     asomarse (apuntar) la cabeza sube (ce→1), ve y es visible.
//  C. tras un HIGH: sale a la orilla y se inclina (cl) o da un paso fuera;
//     el humano en ángulo lo ve y él al humano.
//  D. bot alojado: su volumen sigue la mezcla de 0.2 s que reconstruye el
//     servidor de los botState (transitionOf), no un salto.
//  E. percepción honesta: de espaldas no ve; un disparo se oye y gira; a
//     quien se agacha tras el LOW lo pierde, mira su última posición y lo
//     re-adquiere con reacción.
//  F. especiales: cohete nunca a < 8 m ni con humo; el francotirador se
//     guarda de cerca y vuelve de lejos.
//  G. cadencia de la SMG de bot a 30/60/144 Hz y evidencia de cambio de arma
//     (≥0.15 s entre difundir `w` y el primer tiro) con las compuertas nuevas.
//   node scripts/check-fps-bots.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NetClient } from '../src/net/client.js';
import { expandedCollisionBoxes } from '../src/world/collision-layouts.js';
import { botPoseAllowsOrigin, mapPathBlocked } from '../server/map-geometry.js';
import { World } from '../src/world/world.js';
import { GridNavigation } from '../src/world/grid-navigation.js';
import { BotMatch } from '../src/game/botmatch.js';
import * as HP from '../src/combat/hit-pose.js';
import { canFireInState, sprintFireDelay } from '../src/combat/fire-gates.js';
import { TUNING } from '../src/config/tuning.js';

let seed = 7;
Math.random = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const fails = [];
const report = {};
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const CONTRACT = new Set(['dodge', 'idle', 'run', 'roadie', 'jump', 'slide', 'mantle', 'melee', 'dead', 'crouch']);
const DT = 1 / 30;
const LOW = { minx: -3, maxx: 3, minz: -0.5, maxz: 0.5, h: 1.1 };
const HIGH = { minx: 8, maxx: 12, minz: -0.5, maxz: 0.5, h: 3.0 };
function makeWorld() {
  const w = Object.create(World.prototype);
  w.colliders = [LOW, HIGH]; w.segmentColliders = [];
  const faces = [];
  for (const [c, kind] of [[LOW, 'low'], [HIGH, 'high']]) {
    faces.push({ a: { x: c.minx, z: c.maxz }, b: { x: c.maxx, z: c.maxz }, n: { x: 0, z: 1 }, h: c.h, topY: c.h, kind, collider: c });
    faces.push({ a: { x: c.minx, z: c.minz }, b: { x: c.maxx, z: c.minz }, n: { x: 0, z: -1 }, h: c.h, topY: c.h, kind, collider: c });
    faces.push({ a: { x: c.maxx, z: c.minz }, b: { x: c.maxx, z: c.maxz }, n: { x: 1, z: 0 }, h: c.h, topY: c.h, kind, collider: c });
    faces.push({ a: { x: c.minx, z: c.minz }, b: { x: c.minx, z: c.maxz }, n: { x: -1, z: 0 }, h: c.h, topY: c.h, kind, collider: c });
  }
  w.faces = faces; w.fx = 30; w.fz = 30; w.layout = 'lab'; w.customMap = null;
  w.baseGround = () => 0; w.ceilingHeight = () => Infinity; w.surfaceZones = [];
  w.spawns = { red: [0, 1, 2, 3].map((i) => ({ x: -6 + i * 4, z: 24, yaw: 0 })), blue: [0, 1, 2, 3].map((i) => ({ x: -6 + i * 4, z: -24, yaw: Math.PI })) };
  w.navigation = new GridNavigation({ colliders: w.colliders, segments: [], fx: w.fx, fz: w.fz, seeds: [{ x: 0, z: 12 }, { x: 0, z: -12 }], baseGround: () => 0 });
  return w;
}
const noop = new Proxy(function () {}, { get: () => noop, apply: () => undefined });
// humano: volumen y ojo de hit-pose.js
function makeHuman(id, team, x, z, pose = {}) {
  const h = { id, team, x, z, y: 0, yaw: 0, alive: true, pose: { st: 'idle', aim: false, ce: 1, cl: 0, pitch: 0, wep: 'smg', ...pose } };
  h.view = () => ({ id: h.id, team: h.team, x: h.x, z: h.z, y: h.y, alive: h.alive, hp: 100, ...HP.hitFields(h.pose, h.x, h.y, h.z, h.yaw) });
  h.eye = () => HP.eyeWorld(h.pose, h.x, h.y, h.z, h.yaw);
  h.face = (tx, tz) => { h.yaw = Math.atan2(-(tx - h.x), -(tz - h.z)); };
  return h;
}
function hostedMatch(world, bots, humans, extra = {}) {
  const shots = [];
  const cb = {
    effects: noop, audio: noop, hud: noop, smoke: null, specials: null, rockets: { fire() {} },
    humans: () => humans.map((h) => h.view()), playing: () => true, player: () => ({ alive: false }),
    botFire: (bot, o, p, w) => shots.push({ bot, o: [o.x, o.y, o.z], w }),
    botHit: () => {}, botRocket: (bot, o) => shots.push({ bot, o: [o.x, o.y, o.z], w: 'bazooka' }), botNade: () => {},
    ...extra,
  };
  const M = new BotMatch(new THREE.Scene(), world, cb, { external: true, playerTeam: 'red', bots });
  return { M, shots };
}
const pin = (b, x, z, tx, tz) => {
  b.respawn({ x, z, yaw: Math.atan2(-(tx - x), -(tz - z)) });
  b.protT = 0; b.fireHoldT = 0; b.pauseT = 0; b.nadeCd = 999; b.perchCd = 999; b.exitPending = false;
  b.role = 'hold'; b.roleT = 999; b.decisionT = 999; b.repathT = 999;
  b.tacticalGoal = { x, z, role: 'hold' }; b.wp = b.tacticalGoal; b.commitMove = false;
};
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// volumen en mundo de una pose (también las de siempre, que hitFields deja en `hit: null`)
const placed = (pose, b) => HP.placeHitPose(HP.hitPose(pose), b.pos.x, b.y, b.pos.z, b.rigYaw ?? b.yaw);

// ---------- A. partida: estados, compuertas, origen ----------
{
  const world = makeWorld();
  const human = makeHuman('h1', 'red', 0, 20);
  const { M, shots } = hostedMatch(world, [
    { id: 'r1', name: '', team: 'red', spawn: { x: -4, z: 24, yaw: 0 } }, { id: 'r2', name: '', team: 'red', spawn: { x: 4, z: 24, yaw: 0 } },
    { id: 'b1', name: '', team: 'blue', spawn: { x: -4, z: -24, yaw: Math.PI } }, { id: 'b2', name: '', team: 'blue', spawn: { x: 4, z: -24, yaw: Math.PI } },
  ], [human]);
  const seen = {}, rigSeen = {};
  const gateBad = [], originBad = [];
  const shoot = M.botShoot.bind(M);
  M.botShoot = (bot, enemy) => {
    const st = bot.netAnim || 'idle';
    if (!canFireInState(st, bot.wep) || bot.sinceSprint < sprintFireDelay(bot.wep) || bot.poseHeld < 1.5 / TUNING.net.sendHz)
      gateBad.push({ st, wep: bot.wep, since: bot.sinceSprint, held: bot.poseHeld });
    const n = shots.length;
    const eye = bot._eye.slice();
    const r = shoot(bot, enemy);
    if (shots.length > n) {
      const o = shots[shots.length - 1].o;
      M._hitFields(bot);
      const head = placed(bot._posed, bot);
      const dh = Math.hypot(eye[0] - head.hx, eye[1] - head.hy, eye[2] - head.hz);
      if (dist3(o, eye) > 0.02 || dh > HP.EYE_MAX + 0.01) originBad.push({ d: +dist3(o, eye).toFixed(3), dh: +dh.toFixed(3) });
    }
    return r;
  };
  // el humano rojo va y viene por el centro (los azules lo cazan)
  let t = 0;
  for (; t < 120; t += DT) {
    human.x = Math.sin(t * 0.3) * 8; human.z = 6 + Math.cos(t * 0.2) * 6; human.alive = true;
    M.update(DT);
    for (const b of M.bots) {
      const st = b.animState(); seen[st] = (seen[st] || 0) + DT;
      const rp = b._rp?.state; if (rp) rigSeen[rp] = (rigSeen[rp] || 0) + DT;
      // los bots se reviven solos en el laboratorio (no hay servidor)
      if (!b.alive) M.respawnExternal(b.id, b.team === 'red' ? { x: 0, z: 24, yaw: 0 } : { x: 0, z: -24, yaw: Math.PI });
    }
  }
  const bad = Object.keys(seen).filter((s) => !CONTRACT.has(s));
  const badRig = Object.keys(rigSeen).filter((s) => !CONTRACT.has(s));
  report.A = { estados: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, +(100 * v / (4 * t)).toFixed(1)])),
    tiros: shots.length, compuertaRota: gateBad.length, origenFueraDelOjo: originBad.length };
  check(!bad.length && !badRig.length, `A: estados fuera del contrato: ${bad.concat(badRig).join(',')}`);
  check(shots.length > 30, `A: casi no hubo tiros (${shots.length})`);
  check(!gateBad.length, `A: tiros en estados prohibidos: ${JSON.stringify(gateBad.slice(0, 3))}`);
  check(!originBad.length, `A: tiro fuera del ojo: ${JSON.stringify(originBad.slice(0, 3))}`);
  check((seen.roadie ?? 0) > 1, 'A: los bots nunca esprintan');
}

// ---------- B. LOW: agachado escondido, asomo ----------
{
  const world = makeWorld();
  // humano al sur (z = 14), bot al norte del LOW (cara norte z = -0.5)
  const human = makeHuman('h1', 'red', 0.5, 14, { aim: true });
  const { M, shots } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 0.5, z: -1.2 } }], [human]);
  const b = M.bots[0];
  pin(b, 0.5, -1.2, human.x, human.z);
  human.face(b.pos.x, b.pos.z);
  b.state = 'cover'; b.coverPhase = 'hide'; b.coverPhaseT = 0; b.hideFor = 99; b.coverFight = true; b.coverT = 0;
  b.cover = { x: 0.5, z: -1.2, tx: 1, tz: 0, nx: 0, nz: -1, low: true, crouchHide: true, len: 6, kind: 'low' };
  b.coverThreat = { x: human.x, z: human.z }; b.coverCheckT = 99; b.lastThreat = { x: human.x, z: human.z, age: 0.5 };
  let sawH = 0, seenByH = 0, shotsHidden = 0;
  for (let t = 0; t < 2; t += DT) {
    const n = shots.length;
    M.update(DT); b.coverCheckT = 99; b.coverT = 0;
    if (t > 0.5) {
      if (M.nearestVisibleEnemy(b)) sawH++;
      if (M._seesVolume(human.eye(), M.motion.get('b1'))) seenByH++;
      shotsHidden += shots.length - n;
    }
  }
  const hidden = { st: b.animState(), ce: +b.ce.toFixed(2), casco: +(M._hitFields(b), placed(b._posed, b).hy + HP.HEAD_R).toFixed(2), loVe: sawH, esVisto: seenByH, tiros: shotsHidden };
  // asomo: apuntar le levanta por encima del borde
  b.coverPhase = 'peek'; b.coverPhaseT = 0; b.peekFor = 99;
  let upAt = null, sawAt = null, seenAt = null, firstShot = null;
  for (let t = 0; t < 2; t += DT) {
    const n = shots.length;
    M.update(DT); b.coverCheckT = 99; b.coverT = 0;
    if (upAt == null && b.ce > 0.99) upAt = t;
    if (sawAt == null && M.nearestVisibleEnemy(b)) sawAt = t;
    if (seenAt == null && M._seesVolume(human.eye(), M.motion.get('b1'))) seenAt = t;
    if (firstShot == null && shots.length > n) firstShot = t;
  }
  report.B = { escondido: hidden, asomo: { arribaS: upAt && +upAt.toFixed(2), loVeS: sawAt && +sawAt.toFixed(2), esVistoS: seenAt && +seenAt.toFixed(2), primerTiroS: firstShot && +firstShot.toFixed(2), st: b.animState(), aim: b.aim } };
  check(hidden.st === 'crouch' && hidden.ce < 0.02 && hidden.casco < LOW.h, `B: escondido no está agachado bajo el borde: ${JSON.stringify(hidden)}`);
  check(hidden.loVe === 0 && hidden.esVisto === 0 && hidden.tiros === 0, `B: agachado tras el LOW ve/es visto/dispara: ${JSON.stringify(hidden)}`);
  check(upAt != null && upAt < 0.4 && sawAt != null && seenAt != null && firstShot != null && firstShot >= (seenAt ?? 0),
    `B: el asomo no sube, no ve o no es visible: ${JSON.stringify(report.B.asomo)}`);
}

// ---------- C. HIGH: orilla + inclinación ----------
{
  const world = makeWorld();
  // humano al sureste del muro HIGH (x 8..12), bot al norte del muro
  const human = makeHuman('h1', 'red', 16, 12, { aim: true });
  const { M, shots } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 10, z: -1.2 } }], [human]);
  const b = M.bots[0];
  pin(b, 10, -1.2, human.x, human.z);
  human.face(b.pos.x, b.pos.z);
  b.state = 'cover'; b.coverPhase = 'peek'; b.coverPhaseT = 0; b.peekFor = 99; b.coverFight = true; b.coverT = 0; b.peekDir = 1; b.peekOut = 0;
  b.cover = { x: 10, z: -1.2, tx: 1, tz: 0, nx: 0, nz: -1, low: false, crouchHide: false, len: 4, kind: 'high' };
  b.coverThreat = { x: human.x, z: human.z }; b.coverCheckT = 99;
  let maxCl = 0, sawAt = null, seenAt = null, states = new Set();
  for (let t = 0; t < 3; t += DT) {
    M.update(DT); b.coverCheckT = 99; b.coverT = 0;
    maxCl = Math.max(maxCl, Math.abs(b.coverLean));
    states.add(b.animState());
    if (sawAt == null && M.nearestVisibleEnemy(b)) sawAt = t;
    if (seenAt == null && M._seesVolume(human.eye(), M.motion.get('b1'))) seenAt = t;
  }
  report.C = { inclinacionMax: +maxCl.toFixed(2), pasoFuera: b.peekOut, loVeS: sawAt && +sawAt.toFixed(2), esVistoS: seenAt && +seenAt.toFixed(2),
    estados: [...states], orillaX: +b.pos.x.toFixed(2), tiros: shots.length };
  check((maxCl > 0.9 || b.peekOut > 0) && sawAt != null && seenAt != null && [...states].every((s) => CONTRACT.has(s)),
    `C: no se asoma por la orilla del HIGH: ${JSON.stringify(report.C)}`);
}

// ---------- D. bot alojado: mezcla de postura igual que el servidor ----------
{
  const world = makeWorld();
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 0, z: -10 } }], []);
  const b = M.bots[0];
  pin(b, 0, -10, 0, 10);
  const history = [];
  let maxTracked = 0, maxInstant = 0, t = 0, nextSnap = 0;
  // guion de estados: de pie, sprint, de pie, golpe, de pie
  // trotando (sp > 0: el rig y el servidor adelantan la cabeza) entre sprint y golpe
  const script = [[0.4, 'run'], [0.9, 'roadie'], [1.5, 'run'], [1.9, 'melee'], [2.6, 'run']];
  M._clock = 0;
  for (let i = 0; i < 3.2 / DT; i++) {
    t = i * DT; M._clock = t;
    let st = 'idle'; for (const [at, s] of script) if (t >= at) st = s;
    b.netAnim = st; b.aim = false; b.ce = 1; b.coverLean = 0;
    b.velX = st === 'roadie' ? 7 : st === 'run' ? 4.8 : 0; b.velZ = 0;
    const sp = b.pose().sp;
    // botState a 20 Hz, como el servidor lo guarda en el historial
    if (t >= nextSnap - 1e-9) { nextSnap += 1 / TUNING.net.sendHz; history.push({ at: t, x: b.pos.x, y: b.y, z: b.pos.z, yaw: b.rigYaw, st, aim: 0, ce: 1, cl: 0, p: 0, sp, w: 'smg' }); }
    M._hitFields(b); const host = placed(b._posed, b);
    const srv = HP.shapeAt(history, t);
    const sw = HP.placeHitPose(srv.vol, b.pos.x, b.y, b.pos.z, b.rigYaw);
    const inst = placed({ st, aim: false, ce: 1, cl: 0, pitch: 0, wep: 'smg', sp }, b);
    if (t > 0.1) {
      maxTracked = Math.max(maxTracked, Math.hypot(host.hx - sw.hx, host.hy - sw.hy, host.hz - sw.hz));
      maxInstant = Math.max(maxInstant, Math.hypot(inst.hx - sw.hx, inst.hy - sw.hy, inst.hz - sw.hz));
    }
  }
  report.D = { cabezaHostVsServidorMax: +maxTracked.toFixed(3), sinMezclaMax: +maxInstant.toFixed(3) };
  // el servidor reconstruye el instante del cambio a ±25 ms (medio snapshot)
  check(maxTracked < 0.16 && maxTracked < maxInstant * 0.5, `D: el volumen del bot alojado no sigue la mezcla del servidor: ${JSON.stringify(report.D)}`);
}

// ---------- E. percepción honesta ----------
{
  const world = makeWorld();
  const human = makeHuman('h1', 'red', 20, 10);
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 20, z: 0 } }], [human]);
  const b = M.bots[0];
  pin(b, 20, 0, 20, -10); // de espaldas al humano (está 10 m detrás)
  let sawBehind = 0;
  for (let t = 0; t < 1; t += DT) { M.update(DT); b.yaw = Math.atan2(0, 1); if (M.nearestVisibleEnemy(b)) sawBehind++; }
  // dispara: se oye, se gira y lo ve con reacción
  M.noteShot('h1');
  let turnedAt = null;
  for (let t = 0; t < 2.5 && turnedAt == null; t += DT) { M.noteShot('h1'); M.update(DT); if (M.nearestVisibleEnemy(b)) turnedAt = t; }
  // se agacha tras el LOW: lo pierde, mira donde estaba, lo re-adquiere con reacción
  const W2 = makeWorld();
  const h2 = makeHuman('h2', 'red', 0.5, -1.2, { aim: true });
  const { M: M2 } = hostedMatch(W2, [{ id: 'b2', name: '', team: 'blue', spawn: { x: 0.5, z: 13 } }], [h2]);
  const b2 = M2.bots[0];
  pin(b2, 0.5, 13, h2.x, h2.z); h2.face(b2.pos.x, b2.pos.z);
  for (let t = 0; t < 1; t += DT) M2.update(DT);
  const had = !!M2.nearestVisibleEnemy(b2);
  h2.pose = { st: 'crouch', aim: false, ce: 0, cl: 0, pitch: 0, wep: 'smg' };
  let lostAt = null;
  for (let t = 0; t < 1; t += DT) { M2.update(DT); if (lostAt == null && !M2.nearestVisibleEnemy(b2)) lostAt = t; }
  const looking = b2.lastSeen && Math.abs(Math.atan2(Math.sin(b2.yaw - Math.atan2(-(b2.lastSeen.x - b2.pos.x), -(b2.lastSeen.z - b2.pos.z))), Math.cos(b2.yaw - Math.atan2(-(b2.lastSeen.x - b2.pos.x), -(b2.lastSeen.z - b2.pos.z))))) < 0.2;
  h2.pose = { st: 'crouch', aim: true, ce: 1, cl: 0, pitch: 0, wep: 'smg' };
  let react = -1;
  for (let t = 0; t < 0.6 && react < 0; t += DT) { M2.update(DT); if (b2.targetId === 'h2') react = b2.reactT + DT; }
  report.E = { veDeEspaldas: sawBehind, giraAlOirS: turnedAt && +turnedAt.toFixed(2), loTeniaDeFrente: had, loPierdeS: lostAt && +lostAt.toFixed(2),
    miraSuUltimaPosicion: looking, reaccionAlReaparecerS: +react.toFixed(2) };
  check(sawBehind === 0, 'E: ve a quien tiene detrás sin oírlo');
  check(turnedAt != null && turnedAt > 0.25, `E: al oír un disparo no se gira o lo "ve" sin reacción: ${turnedAt}`);
  check(had && lostAt != null && lostAt <= 0.15 && looking, `E: no pierde al que se agacha tras el LOW o no mira su última posición: ${JSON.stringify(report.E)}`);
  check(react >= 0.1, `E: re-adquiere sin reacción: ${react}`);
}

// ---------- F. especiales ----------
{
  const world = makeWorld();
  let rockets = 0;
  const human = makeHuman('h1', 'red', 22, 4);
  const smokeOn = { on: false };
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 22, z: -2 } }], [human],
    { rockets: { fire() { rockets++; } }, smoke: { blocksSegment: () => smokeOn.on } });
  const b = M.bots[0];
  pin(b, 22, -2, human.x, human.z);
  b.wep = 'bazooka'; b.special = 'bazooka'; b.specialAmmo = 4; b.shownWep = 'bazooka'; b.swapCd = 99;
  for (let t = 0; t < 4; t += DT) { M.update(DT); human.alive = true; }
  const close = rockets;
  // a 20 m con humo en la línea: tampoco
  human.z = 18; smokeOn.on = true; rockets = 0;
  for (let t = 0; t < 4; t += DT) M.update(DT);
  const smoked = rockets;
  smokeOn.on = false; rockets = 0;
  for (let t = 0; t < 5; t += DT) M.update(DT);
  const clear = rockets;
  // francotirador: se guarda de cerca, vuelve de lejos
  const b2 = b; pin(b2, 22, -2, 22, 4);
  b2.wep = 'sniper'; b2.special = 'sniper'; b2.specialAmmo = 6; b2.shownWep = 'sniper'; b2.swapCd = 0;
  human.z = 3;
  for (let t = 0; t < 2; t += DT) M.update(DT);
  const nearWep = b2.wep;
  human.z = 22; b2.swapCd = 0;
  for (let t = 0; t < 4; t += DT) M.update(DT);
  const farWep = b2.wep;
  report.F = { cohetesA6m: close, cohetesConHumo: smoked, cohetesA20m: clear, sniperDeCerca: nearWep, sniperDeLejos: farWep };
  check(close === 0 && smoked === 0 && clear > 0, `F: bazooka: ${JSON.stringify(report.F)}`);
  check(nearWep !== 'sniper' && farWep === 'sniper', `F: bandas del francotirador: ${JSON.stringify(report.F)}`);
}

// ---------- H. proyectiles: salida desde el ojo, tramo ojo→salida libre ----------
{
  const world = makeWorld();
  const nades = [], rk = [];
  const human = makeHuman('h1', 'red', 22, 12);
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 22, z: -4, yaw: 0 } }], [human],
    { smoke: { throwNade() {}, blocksSegment: () => false }, botNade: (bot, o) => nades.push({ o: [o.x, o.y, o.z], eye: bot._eye.slice() }),
      botRocket: (bot, o) => rk.push({ o: [o.x, o.y, o.z], eye: bot._eye.slice() }) });
  const b = M.bots[0];
  pin(b, 22, -4, human.x, human.z);
  for (let t = 0; t < 0.5; t += DT) M.update(DT);
  M.botThrowSmoke(b, { x: human.x, z: human.z });
  const net = new NetClient();
  net.send = m => { b.hostedPose = { ...m.bots[0], alive: true }; b.hostedPoseAt = performance.now(); };
  for (let t = 0; t < 2 && !nades.length; t += DT) { net.botState([b]); M.update(DT); }
  b.wep = 'bazooka'; b.special = 'bazooka'; b.specialAmmo = 3; b.shownWep = 'bazooka';
  M.botFireRocket(b, M._enemiesOf(b)[0]);
  const far = [...nades, ...rk].map((q) => +dist3(q.o, q.eye).toFixed(3));
  report.H = { humoSalidaDelOjoM: far.slice(0, nades.length), coheteSalidaDelOjoM: far.slice(nades.length) };
  check(nades.length === 1 && rk.length === 1 && far.every((d) => d <= 0.6), `H: salida de proyectiles lejos del ojo: ${JSON.stringify(report.H)}`);
}

// El bot sube el ojo en los dos subpasos posteriores al snapshot agachado.
{
  const world = makeWorld();
  world.layout = 'fortaleza'; world.colliders = expandedCollisionBoxes(world.layout);
  const x = 12.4, z = -31.55, packets = [], projectiles = [];
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x, z, yaw: 0 } }], [],
    { smoke: { throwNade: o => projectiles.push(o) }, botNade: (_, o) => packets.push([o.x,o.y,o.z]) });
  const b = M.bots[0], net = new NetClient();
  net.send = m => { b.hostedPose = { ...m.bots[0], alive: true }; b.hostedPoseAt = performance.now(); };
  b.shownWep = 'grenade'; b.netAnim = 'crouch'; b.ce = b.coverExposure = 0;
  b.throwPlan = { tx: x, tz: z - 10 };
  net.botState([b]);
  const low = b.hostedPose;
  b.wantCe = 1;
  for (let i = 0; i < 2; i++) b._posture('idle', DT);
  const eye = HP.eyeWorld(b.pose(), x, 0, z, 0), out = [eye[0], eye[1], eye[2] - 0.5];
  assert.ok(!mapPathBlocked(world.layout, eye, out));
  assert.ok(!mapPathBlocked(world.layout, [x, 1.3, z], out));
  assert.equal(botPoseAllowsOrigin(world.layout, low, out), false);
  assert.equal(M.botReleaseSmoke(b), false);
  assert.deepEqual([packets.length, projectiles.length, b.nades], [0, 0, 1]);
  net.botState([b]);
  assert.ok(M.botReleaseSmoke(b));
  assert.deepEqual(packets, [out]);
  assert.ok(botPoseAllowsOrigin(world.layout, b.hostedPose, out));
  assert.equal(M.botReleaseSmoke(b), false);
  assert.deepEqual([packets.length, projectiles.length, b.nades], [1, 1, 0]);
}

// ---------- I. tras un respawn no percibe desde donde estaba ----------
{
  const world = makeWorld();
  // humano al sur del muro HIGH; el bot lo ve desde (10, 8) y reaparece tras el muro (10, -3)
  const human = makeHuman('h1', 'red', 10, 14);
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 10, z: 8, yaw: 0 } }], [human]);
  const b = M.bots[0];
  pin(b, 10, 8, human.x, human.z);
  for (let t = 0; t < 0.5; t += DT) M.update(DT);
  const before = !!M.nearestVisibleEnemy(b);
  M.respawnExternal('b1', { x: 10, z: -3, yaw: 0 }); b.protT = 0; b.fireHoldT = 0;
  const seenRight = !!M.nearestVisibleEnemy(b); // percepción inmediata tras moverse, sin paso de simulación
  let seenLater = 0;
  for (let t = 0; t < 0.5; t += DT) { M.update(DT); if (M.nearestVisibleEnemy(b)) seenLater++; }
  report.I = { loVeiaAntes: before, loVeTrasReaparecer: seenRight, pasosViendoloDespues: seenLater };
  check(before && !seenRight && seenLater === 0, `I: percibe desde su posición anterior tras reaparecer: ${JSON.stringify(report.I)}`);
}

// ---------- G. cadencia y evidencia de arma con las compuertas nuevas ----------
{
  const world = makeWorld();
  const { M } = hostedMatch(world, [{ id: 'b1', name: '', team: 'blue', spawn: { x: 0, z: -10, yaw: 0 } }], []);
  const b = M.bots[0];
  const G = {};
  for (const hz of [30, 60, 144]) {
    pin(b, 0, -10, 0, 0); b.reactT = 0; b.swapAnim = 0; b.ammo.smg = 1e6;
    let shots = 0; const m = { botShoot: () => { shots++; return true; } };
    const dt = 1 / hz;
    for (let i = 0; i < 30 * hz; i++) {
      b._stepDt = dt; b.netAnim = 'idle'; b.poseHeld = 1; b.sinceSprint = 99;
      b.shotCd = Math.max(-0.5, b.shotCd - dt); b.burstT = Math.max(0, b.burstT - dt);
      if (b.burstT === 0 && b.pauseT > 0) b.pauseT -= dt;
      b.burstT = Math.max(b.burstT, 0.5); // ráfaga continua: mide la cadencia, no las pausas
      b._fireAt(dt, m, { id: 'e', x: 0, z: 0, y: 0 }, 10);
    }
    G[hz] = +(shots / 30 * 60).toFixed(1);
  }
  const nominal = TUNING.weapons.smg.rpm / 1.2;
  // evidencia: el primer tiro con el arma nueva sale ≥0.15 s después de difundir `w`
  pin(b, 0, -10, 0, 0); b.reactT = 0; b.ammo.shotgun = 8; b.swapCd = 0;
  let shotAt = null, wAt = null, t = 0;
  const m2 = { botShoot: () => { if (shotAt == null) shotAt = t; return true; } };
  b._trySwap('shotgun');
  for (let i = 0; i < 90; i++) {
    t += 1 / 60; b._stepDt = 1 / 60; b.netAnim = 'idle'; b.poseHeld = 1; b.sinceSprint = 99;
    b.shotCd = Math.max(-0.5, b.shotCd - 1 / 60); b.swapAnim = Math.max(0, b.swapAnim - 1 / 60);
    if (b._swapModel && b.swapAnim <= 0.55 / 2) { b.shownWep = b._swapModel; b._swapModel = null; }
    if (wAt == null && b.shownWep === 'shotgun') wAt = t;
    b._fireAt(1 / 60, m2, { id: 'e', x: 0, z: -4, y: 0 }, 6);
  }
  report.G = { cadenciaSMG_RPM: G, nominalBot: +nominal.toFixed(1), evidenciaArma: { wDifundido: wAt && +wAt.toFixed(3), primerTiro: shotAt && +shotAt.toFixed(3) } };
  check(Object.values(G).every((r) => r > nominal * 0.9 && r <= nominal * 1.02), `G: cadencia de la SMG de bot: ${JSON.stringify(report.G)}`);
  check(shotAt != null && wAt != null && shotAt - wAt >= 0.15, `G: dispara el arma nueva antes de difundirla: ${JSON.stringify(report.G)}`);
}

// El bot solo inicia bajo fuego. Su fase y distancia pasan por el mismo
// integrador que el jugador y mantiene la puerta de fuego hasta frenar.
{
  const { M } = hostedMatch(makeWorld(), [{ id: 'b1', name: '', team: 'blue', spawn: { x: -10, z: 8, yaw: 0 } }], []);
  const b = M.bots[0];
  pin(b, -10, 8, -10, -8);
  b.poseHeld = 1;
  for (let i = 0; i < 120; i++) assert.equal(b._stepDodge(DT, M), false);
  b.recentHit = 0;
  for (let i = 0; i < 300 && !b.dodge; i++) b._stepDodge(DT, M);
  assert.ok(b.dodge);
  let ticks = 1;
  while (b.dodge) {
    assert.equal(b.animState(), 'dodge');
    assert.equal(canFireInState(b.animState(), b.wep), false);
    b._stepDodge(DT, M);
    ticks++;
  }
  assert.ok(Math.abs(ticks * DT - TUNING.dodge.duration) < 1e-6);
  assert.ok(Math.abs(Math.hypot(b.pos.x + 10, b.pos.z - 8) - 3.3) < 1e-6);
  assert.ok(Math.abs(b.dodgeCd - TUNING.dodge.cooldown) < 1e-6);
  b.poseHeld = 1;
  while (b.dodgeCd > 1e-8) assert.equal(b._stepDodge(DT, M), false);
}

console.log(JSON.stringify(report, null, 1));
if (fails.length) { console.error('FALLA check-fps-bots:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('check-fps-bots OK');
