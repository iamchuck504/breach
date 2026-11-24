// PARIDAD DE ANIMACIÓN: un remoto y un bot deben alimentar su rig con lo
// mismo que el jugador local para la misma acción.
// 1) REMOTO: un Controller real ejecuta una secuencia guionizada (strafe en
//    cover, ADS y blindfire sobre cover bajo, mantle, salto, cuatro vueltas
//    de doble salto, patadas de pared lateral y frontal, dive, patada en
//    carrera y parado, cambio de arma, lanzamiento, recarga, lean en cover
//    alto). Sus snapshots viajan por el servidor real (dos clientes
//    WebSocket, uno actúa y otro observa) y un RemotePlayer real los
//    interpreta. Se compara, por tramo, lo que recibe cada rig.
// 2) BOT: los constructores de parámetros del bot frente a los del jugador
//    en las acciones que hace un bot (cover, asomarse, lean, recarga, cambio,
//    lanzamiento, patada, salto, contexto de muerte) y la cadencia a 30/60/144 Hz.
//   node scripts/check-anim-parity.mjs [--json=salida.json] [--port=FREE_PORT]
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { World } from '../src/world/world.js';
import { Controller } from '../src/player/controller.js';
import { Weapons } from '../src/combat/weapons.js';
import { RemotePlayer } from '../src/player/remote.js';
import { NetClient } from '../src/net/client.js';
import { Bot } from '../src/game/botmatch.js';
import { TUNING } from '../src/config/tuning.js';
import { freePort } from './lib-test.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));
const port = flags.server ? Number(flags.port) || await freePort() : null;
const R = 0.38;
const failures = [];
const report = { remote: {}, bot: {} };
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const yawFromDir = (x, z) => Math.atan2(-x, -z);

// ---------- mundo mínimo: bloque bajo, muro alto y pared lateral ----------
function makeWorld() {
  const w = Object.create(World.prototype);
  const low = { minx: -3, maxx: 3, minz: -6, maxz: -5, h: 1.1 };
  const high = { minx: 6, maxx: 10, minz: -6, maxz: -5, h: 3 };
  const wall = { minx: -15, maxx: -14, minz: -30, maxz: 30, h: 4 };
  w.colliders = [low, high, wall]; w.segmentColliders = [];
  w.faces = [
    { a: { x: -3, z: -5 }, b: { x: 3, z: -5 }, n: { x: 0, z: 1 }, h: 1.1, topY: 1.1, kind: 'low', collider: low },
    { a: { x: 6, z: -5 }, b: { x: 10, z: -5 }, n: { x: 0, z: 1 }, h: 3, topY: 3, kind: 'high', collider: high },
    { a: { x: -14, z: -30 }, b: { x: -14, z: 30 }, n: { x: 1, z: 0 }, h: 4, topY: 4, kind: 'high', collider: wall },
  ];
  w.baseGround = () => 0; w.ceilingHeight = () => Infinity; w.surfaceZones = [];
  return w;
}
const world = makeWorld();
// PRUEBAS (corrida 6): los dobles de partida heredan de BotMatch (el bot ya llama
// métodos suyos, p. ej. _eyeOf para el ojo de la pose difundida); solo se sustituye
// lo que la prueba cuenta (botShoot, etc.)
const { BotMatch: BM_ } = await import('../src/game/botmatch.js');
const matchStub = (o) => Object.assign(Object.create(BM_.prototype), { world, bots: [], motion: new Map(), _clock: 0, external: true, cb: { effects: { tracer() {}, muzzleFlash() {}, impact() {} }, audio: { gun() {}, impact() {} }, humans: () => [] } }, o);
const groundFn = (x, z, y) => world.groundHeight({ x, z }, R, y);

// ---------- transporte ----------
// Por defecto, relé determinista en tiempo virtual que reproduce lo que hace
// server.js con el estado de un jugador (guarda el último 's', lo reenvía en
// el snapshot a 20 Hz sin sincronizar con el cliente, con latencia y
// jitter): así el resultado no depende de la carga de la máquina.
// --server: servidor real y dos clientes WebSocket en tiempo real.
const REAL = !!flags.server;
// versiones mezcladas: old-server no reenvía `rl`; old-client nunca lo manda
const COMPAT = flags.compat || null;
let server = null;
if (REAL) server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: 'ignore',
});
const peers = [];
function connect(name, action) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const p = { ws, id: null, messages: [], on: null };
    peers.push(p);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, action, v: 0, hp: 2, fps: 1 })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (p.on) p.on(m); else p.messages.push(m);
      if (m.t === 'welcome' && !p.id) { p.id = m.id; resolve(p); }
    });
  });
}
async function waitFor(p, pred, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = p.messages.find(pred);
    if (f) return f;
    await delay(20);
  }
  throw new Error('timeout esperando mensaje');
}
// relé virtual: mismos campos y límites que server.js ('s' -> snapshot)
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function relaySnapshot(m) {
  return { id: 'A', x: clampN(m.x, -60, 60), z: clampN(m.z, -60, 60), y: clampN(m.y, 0, 20), yaw: clampN(m.yaw, -10, 10),
    st: m.st && m.st !== 'dead' ? m.st : 'idle', aim: m.aim ? 1 : 0, p: clampN(m.p, -1.6, 1.6),
    ae: clampN(m.ae, -52 * Math.PI / 180, 52 * Math.PI / 180), cl: clampN(m.cl, -1, 1),
    ce: Number.isFinite(m.ce) ? clampN(m.ce, 0, 1) : 1, ...(m.ck ? { ck: m.ck } : {}), w: m.w || 'smg',
    sp: clampN(m.sp, 0, 1), ...(Number.isFinite(m.rl) && COMPAT !== 'old-server' ? { rl: +clampN(m.rl, 0, 1).toFixed(2) } : {}),
    hp: 100, alive: true, inv: 0, bot: 0 };
}

// ---------- jugador local: Controller + Weapons + extras de main.js ----------
const cam = { yaw: 0, pitch: 0,
  flatForward: () => ({ x: -Math.sin(cam.yaw), z: -Math.cos(cam.yaw) }),
  flatRight: () => ({ x: Math.cos(cam.yaw), z: -Math.sin(cam.yaw) }) };
const ctl = new Controller(world, cam, {});
const wep = new Weapons();
wep.infinite = true;
const input = { mv: { x: 0, z: 0 }, aimHeld: false, sprintHeld: false, jumpPressed: false, crouchHeld: false,
  crouchPressed: false, leanAxis: 0, meleePressed: false, moveVec() { return this.mv; } };
const G = { throwT: 0, throwPending: false, firing: false, firePressed: false };

function localParams() {
  return {
    ...ctl.animParams(),
    swapping: wep.swapping, throwT: G.throwT, throwTotal: TUNING.weapons.grenade.throwTime,
    throwReleased: G.throwT > 0 && !G.throwPending,
    reloading: wep.reloading, reloadT: wep.reloading ? 1 - wep.st.reload / wep.def.reloadTime : 0,
    x: ctl.pos.x, z: ctl.pos.z, y: ctl.y,
  };
}
const KEYS = ['state', 'latMove', 'crouch', 'slidePhase', 'vy', 'aim', 'coverAimExposure', 'coverLean', 'mantlePhase', 'evadePhase',
  'meleePhase', 'meleeTackle', 'flipT', 'flipDir', 'flipAxis', 'swapping', 'throwT', 'throwReleased',
  'reloading', 'reloadT', 'pump', 'moveForward', 'moveSide', 'twist', 'groundPitch'];
const pick = (o) => { const r = {}; for (const k of KEYS) r[k] = o[k]; return r; };

// ---------- guion ----------
// PRUEBAS (corrida 6, FPS): el guion usa lo que hoy hace el jugador. Se
// retiraron strafe en cobertura pegada, blindfire, volteretas, patada de pared
// y rodada (mecánicas retiradas: fps-movement afirma que no aparecen); en su
// lugar: andar agachado de lado, asomo sobre LOW (ce), deslizamiento e
// inclinación de pie en la orilla HIGH (cl).
// de cara a la cara, a `gap` del plano, en la posición u a lo largo de ella
const placeFacing = (face, u, gap = R + 0.12) => {
  const ux = face.b.x - face.a.x, uz = face.b.z - face.a.z, l = Math.hypot(ux, uz);
  const yaw = yawFromDir(-face.n.x, -face.n.z);
  ctl.respawn({ x: face.a.x + ux / l * u + face.n.x * gap, z: face.a.z + uz / l * u + face.n.z * gap, yaw });
  cam.yaw = yaw; cam.pitch = 0;
};
const placeOpen = (x, z, camYaw) => { ctl.respawn({ x, z, yaw: camYaw }); cam.yaw = camYaw; cam.pitch = 0; };
// at(a): la pulsación cae en el primer cuadro que cruza el instante a
let tPrevStep = 0, tStep = 0;
const at = (a) => tPrevStep < a && tStep >= a;
const STEPS = [
  { name: 'settle', dur: 0.8, start: () => placeFacing(world.faces[0], 3), input: () => { input.crouchHeld = true; } },
  { name: 'crouch-left', dur: 0.75, input: () => { input.crouchHeld = true; input.mv = { x: -1, z: 0 }; } },
  { name: 'crouch-right', dur: 0.75, input: () => { input.crouchHeld = true; input.mv = { x: 1, z: 0 }; } },
  { name: 'peek-low', dur: 1.0, start: () => placeFacing(world.faces[0], 3), input: () => { input.mv = { x: 0, z: 0 }; input.crouchHeld = true; input.aimHeld = true; } },
  { name: 'mantle', dur: 1.2, start: () => { input.crouchHeld = false; input.aimHeld = false; placeFacing(world.faces[0], 3); },
    input: () => { input.mv = { x: 0, z: 1 }; input.jumpPressed = at(0.05); } },
  { name: 'jump', dur: 1.6, start: () => placeOpen(0, 8, Math.PI), input: (t) => { input.mv = { x: 0, z: t < 1.0 ? 1 : 0 }; input.jumpPressed = at(0.3); } },
  { name: 'slide', dur: 1.6, start: () => placeOpen(0, 12, Math.PI),
    input: (t) => { input.mv = { x: 0, z: t < 1.1 ? 1 : 0 }; input.sprintHeld = t < 0.8; input.crouchPressed = at(0.75); } },
  { name: 'melee-run', dur: 1.6, start: () => placeOpen(0, 8, Math.PI), input: (t) => { input.mv = { x: 0, z: t < 0.9 ? 1 : 0 }; input.sprintHeld = t < 0.9; input.meleePressed = at(0.8); } },
  { name: 'melee-stand', dur: 1.2, start: () => { input.sprintHeld = false; placeOpen(0, 8, Math.PI); }, input: () => { input.mv = { x: 0, z: 0 }; input.meleePressed = at(0.2); } },
  { name: 'swap', dur: 1.2, start: () => wep.startSwap('shotgun') },
  { name: 'throw', dur: 1.8, start: () => wep.startSwap('grenade'), input: () => { G.firePressed = at(0.75); } },
  { name: 'reload', dur: 3.2, start: () => { G.firePressed = false; wep.startSwap('smg'); }, input: () => { if (at(0.7)) { wep.st.mag = 8; wep.startReload(); } } },
  // recarga cancelada por un disparo a media animación (sin gesto final)
  { name: 'reload-cancel', dur: 1.6, input: () => { if (at(0.1)) { wep.st.mag = 10; wep.startReload(); } G.firePressed = at(0.85); } },
  // escopeta: tres cartuchos, ciclo por cartucho y bombeo al terminar
  { name: 'reload-shotgun', dur: 3.0, start: () => { G.firePressed = false; wep.startSwap('shotgun'); },
    input: () => { if (at(0.7)) { wep.st.mag = TUNING.weapons.shotgun.mag - 3; wep.startReload(); } } },
  { name: 'post-shotgun', dur: 0.8, start: () => wep.startSwap('smg') },
  // orilla derecha (b) de la cara HIGH: de pie, apuntando e inclinado a la derecha
  { name: 'high-lean', dur: 1.4, start: () => placeFacing(world.faces[1], 3.65, R + 0.25), input: () => { input.aimHeld = true; input.leanAxis = 1; } },
  { name: 'end', dur: 0.5, input: () => { input.aimHeld = false; input.leanAxis = 0; } },
];

let remote = null, actor = null, observer = null;
const LOCAL = [], REMOTE = [], RELEASES = [];
const DT = 1 / 60;
let si = -1, stepT = 0, simT = 0;
// un paso del jugador local; send(msg) entrega lo que el cliente mandaría
function stepLocal(sendNade) {
  simT += DT;
  tPrevStep = stepT; stepT += DT;
  if (si < 0 || stepT >= STEPS[si].dur) {
    si++; stepT = 0; tPrevStep = -1;
    if (si >= STEPS.length) return false;
    STEPS[si].start?.();
  }
  const S = STEPS[si];
  input.jumpPressed = false; input.crouchPressed = false; input.meleePressed = false;
  tStep = stepT;
  S.input?.(stepT);
  ctl.update(DT, input, G.firing);
  const fired = wep.update(DT, G.firing, G.firePressed, true, ctl.state !== 'melee');
  if (fired && wep.def.thrown) { G.throwT = TUNING.weapons.grenade.throwTime; G.throwPending = true; }
  if (G.throwT > 0) {
    G.throwT = Math.max(0, G.throwT - DT);
    if (G.throwPending && G.throwT <= TUNING.weapons.grenade.throwTime - TUNING.weapons.grenade.throwRelease) {
      G.throwPending = false;
      const f = ctl.facing();
      sendNade({ t: 'nade', o: [ctl.pos.x + f.x * 0.3, ctl.y + 1.5, ctl.pos.z + f.z * 0.3], v: [f.x * 10, 6, f.z * 10] });
      RELEASES.push(simT);
    }
  }
  LOCAL.push({ t: simT, step: S.name, ...pick(localParams()), x: ctl.pos.x, z: ctl.pos.z });
  return true;
}
let seen = {};
const watchRig = () => {
  // lo que el remoto le pasa a su rig (vale también para el RemotePlayer de antes)
  const rigUpdate = remote.rig.update.bind(remote.rig);
  remote.rig.update = (dt, prm) => { seen = prm; const out = rigUpdate(dt, prm); seen = { ...prm, pump: remote.rig._pumpT !== undefined }; return out; };
};
const net = new NetClient();
if (!REAL) {
  // tiempo virtual: cliente a sendHz, servidor a 20 Hz con otra fase, subida
  // 4±9 ms y bajada 6±4 ms (con eso hay snapshots repetidos y saltados)
  remote = new RemotePlayer(new THREE.Scene(), 'A', '', 'red');
  remote.rig.groundFn = groundFn;
  watchRig();
  const inbox = [], deliveries = [];
  net.connected = true;
  const RL_BYTES = [];
  net.ws = { readyState: 1, send: (raw) => {
    const m = JSON.parse(raw);
    if (Number.isFinite(m.rl)) RL_BYTES.push(raw.length - JSON.stringify({ ...m, rl: undefined }).length);
    if (COMPAT === 'old-client') delete m.rl;
    inbox.push({ at: simT + 0.004 + (rnd() - 0.5) * 0.018, m });
  } };

  let serverState = null, nextTick = 0.0031;
  // reloj virtual también para performance.now (el RemotePlayer de antes lo lee)
  let vnow = 0;
  Object.defineProperty(performance, 'now', { value: () => vnow * 1000, configurable: true });
  const sendNade = (m) => inbox.push({ at: simT + 0.004, m });
  while (stepLocal(sendNade)) {
    net.tickState(DT, ctl, wep);
    // servidor: aplica lo que ya llegó, emite en su tick
    inbox.sort((a, b) => a.at - b.at);
    while (nextTick <= simT) {
      while (inbox.length && inbox[0].at <= nextTick) {
        const { m } = inbox.shift();
        if (m.t === 's') serverState = relaySnapshot(m);
        if (m.t === 'nade') deliveries.push({ at: nextTick + 0.006, nade: true });
      }
      if (serverState) deliveries.push({ at: nextTick + 0.006 + rnd() * 0.004, snap: { ...serverState } });
      nextTick += 1 / 20;
    }
    deliveries.sort((a, b) => a.at - b.at);
    while (deliveries.length && deliveries[0].at <= simT) {
      const d = deliveries.shift();
      vnow = d.at;
      if (d.snap) remote.push(d.snap, d.at);
      if (d.nade) remote.applyThrow?.();
    }
    vnow = simT;
    remote.update(DT, null, simT);
    REMOTE.push({ t: simT, ...pick(seen), x: remote.x, z: remote.z });
  }
  report.remote.bytesRlPorEstado = RL_BYTES.length ? Math.max(...RL_BYTES) : 0;
} else try {
  // el servidor puede tardar en escuchar si la máquina está cargada
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((r) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on('open', () => { w.close(); r(true); }); w.on('error', () => r(false)); });
    if (up) break;
    await delay(200);
  }
  actor = await connect('PARITY-A', 'create');
  observer = await connect('PARITY-B', 'join');
  actor.ws.send(JSON.stringify({ t: 'lobbyStart' }));
  await waitFor(actor, (m) => m.t === 'matchStart');
  await waitFor(actor, (m) => m.t === 'start');
  await delay(300);
  net.ws = actor.ws; net.connected = true;
  remote = new RemotePlayer(new THREE.Scene(), actor.id, '', 'red');
  remote.rig.groundFn = groundFn;
  watchRig();
  actor.on = () => {};
  const t0 = performance.now() / 1000;
  observer.on = (m) => {
    const now = performance.now() / 1000 - t0;
    if (m.t === 'snap') for (const p of m.ps || []) { if (p.id === actor.id) { remote.push(p, now); remote.alive = p.alive !== false; } }
    if (m.t === 'nade' && m.id === actor.id) remote.applyThrow?.();
  };
  // tiempo real: pasos fijos de 1/60 s hasta alcanzar el reloj (con la
  // máquina cargada, como un cliente lento: varios pasos y envíos juntos)
  let tPrev = 0;
  outer: while (true) {
    await delay(12);
    const now = performance.now() / 1000 - t0;
    while (simT + DT <= now) {
      if (!stepLocal((m) => actor.ws.send(JSON.stringify(m)))) break outer;
      net.tickState(DT, ctl, wep);
    }
    remote.update(Math.min(0.1, now - tPrev), null, now); tPrev = now;
    REMOTE.push({ t: now, ...pick(seen), x: remote.x, z: remote.z });
  }
} finally {
  for (const p of peers) p.ws.close();
  server?.kill();
}

// RemotePlayer anterior (sin `anim`): capturar lo que le pasa al rig
// (este script también mide el árbol de antes)
if (!REMOTE.length || REMOTE.every((r) => r.state === undefined)) failures.push('remoto: sin parámetros del rig');

// ---------- alineación: retraso del remoto por posición ----------
function sampleLocal(t) {
  let lo = 0, hi = LOCAL.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (LOCAL[m].t < t) lo = m; else hi = m; }
  return LOCAL[hi];
}
let bestD = 0.15, bestE = Infinity;
for (let D = 0.06; D <= 0.34; D += 0.01) {
  let e = 0, n = 0;
  for (const r of REMOTE) {
    if (r.t < 1 || r.t - D < 0) continue;
    const l = sampleLocal(r.t - D);
    const d = Math.hypot(l.x - r.x, l.z - r.z);
    if (d > 2) continue; // teletransportes del guion
    e += d; n++;
  }
  if (n && e / n < bestE) { bestE = e / n; bestD = D; }
}
report.remote.retrasoS = +bestD.toFixed(2);
report.remote.errorPosicionM = +bestE.toFixed(3);

const steps = {};
for (const S of STEPS) {
  const ls = LOCAL.filter((l) => l.step === S.name);
  if (!ls.length) continue;
  steps[S.name] = { t0: ls[0].t, t1: ls[ls.length - 1].t };
}
// pares (local en t − D, remoto en t) dentro del tramo, con margen
function pairs(name, trim0 = 0.15, trim1 = 0) {
  const w = steps[name]; if (!w) return [];
  const out = [];
  for (const r of REMOTE) {
    const tl = r.t - bestD;
    if (tl < w.t0 + trim0 || tl > w.t1 - trim1) continue;
    out.push([sampleLocal(tl), r]);
  }
  return out;
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const mae = (ps, k, when = () => true) => {
  const v = ps.filter(([l, r]) => when(l, r)).map(([l, r]) => Math.abs((+l[k] || 0) - (+r[k] || 0)));
  return v.length ? +mean(v).toFixed(3) : null;
};
const frac = (ps, f) => (ps.length ? +(ps.filter(f).length / ps.length).toFixed(2) : null);
const M = report.remote;
for (const name of ['crouch-left', 'crouch-right']) {
  // andar agachado de lado: el remoto está agachado y se mueve hacia el mismo lado
  const ps = pairs(name, 0.3, 0.05);
  const lm = mean(ps.map(([l]) => l.moveSide)), rm = mean(ps.map(([, r]) => r.moveSide ?? 0));
  M[name] = { moveSideLocal: +lm.toFixed(2), moveSideRemoto: +rm.toFixed(2),
    mismoEstado: frac(ps, ([l, r]) => l.state === r.state), agachadoLocal: frac(ps, ([l]) => l.state === 'crouch') };
  check(M[name].agachadoLocal > 0.85 && M[name].mismoEstado > 0.85 && Math.abs(lm) > 0.6 &&
    Math.sign(lm) === Math.sign(rm) && Math.abs(lm - rm) < 0.3, `remoto ${name}: ${JSON.stringify(M[name])}`);
}
{
  // asomo sobre LOW: la altura de cabeza (ce = coverAimExposure) llega al remoto
  const ps = pairs('peek-low', 0.25);
  M['peek-low'] = { exposicionMAE: mae(ps, 'coverAimExposure'), mismoEstado: frac(ps, ([l, r]) => l.state === r.state),
    exposicionLocalMax: ps.length ? +Math.max(...ps.map(([l]) => l.coverAimExposure ?? 0)).toFixed(2) : null };
  check(M['peek-low'].exposicionLocalMax > 0.9 && M['peek-low'].exposicionMAE < 0.15 && M['peek-low'].mismoEstado > 0.85,
    `remoto asomo sobre LOW: ${JSON.stringify(M['peek-low'])}`);
}
{
  const ps = pairs('slide', 0).filter(([l]) => l.state === 'slide');
  M.slide = { n: ps.length, mismoEstado: frac(ps, ([, r]) => r.state === 'slide') };
  check(ps.length > 10 && M.slide.mismoEstado > 0.8, `remoto deslizamiento: ${JSON.stringify(M.slide)}`);
}
{
  const ps = pairs('mantle', 0).filter(([l, r]) => l.state === 'mantle' && r.state === 'mantle');
  const rs = REMOTE.filter((r) => r.state === 'mantle').map((r) => r.mantlePhase ?? 0.5);
  M.mantle = { faseMAE: mae(ps, 'mantlePhase'), faseRemotaMin: rs.length ? +Math.min(...rs).toFixed(2) : null, faseRemotaMax: rs.length ? +Math.max(...rs).toFixed(2) : null };
  check(ps.length > 5 && M.mantle.faseMAE < 0.15 && M.mantle.faseRemotaMax > 0.8, `remoto mantle: ${JSON.stringify(M.mantle)}`);
}
{
  const ps = pairs('jump', 0.3).filter(([l, r]) => l.state === 'jump' && r.state === 'jump');
  M.jump = { vyMAE: mae(ps, 'vy'), mismoSigno: frac(ps, ([l, r]) => Math.sign(l.vy) === Math.sign(r.vy ?? 0) || Math.abs(l.vy) < 1),
    vyRemotaMax: ps.length ? +Math.max(...ps.map(([, r]) => r.vy ?? 0)).toFixed(2) : null };
  check(ps.length > 10 && M.jump.vyMAE < 1.5 && M.jump.mismoSigno > 0.85, `remoto salto: ${JSON.stringify(M.jump)}`);
}
for (const name of ['melee-run', 'melee-stand']) {
  const ps = pairs(name, 0).filter(([l, r]) => l.state === 'melee' && r.state === 'melee');
  M[name] = { faseMAE: mae(ps, 'meleePhase', (l, r) => Number.isFinite(r.meleePhase)), tackleLocal: ps.some(([l]) => l.meleeTackle), tackleRemoto: ps.some(([, r]) => r.meleeTackle), n: ps.length };
  check(ps.length > 5 && M[name].faseMAE != null && M[name].faseMAE < 0.15 && M[name].tackleLocal === M[name].tackleRemoto, `remoto ${name}: ${JSON.stringify(M[name])}`);
}
{
  const ps = pairs('swap', -0.1);
  const loc = ps.filter(([l]) => l.swapping);
  M.swap = { solape: frac(loc, ([, r]) => r.swapping), remotoS: +(ps.filter(([, r]) => r.swapping).length / 60).toFixed(2), localS: +(loc.length / 60).toFixed(2) };
  check(M.swap.solape >= 0.6, `remoto cambio de arma: ${JSON.stringify(M.swap)}`);
}
{
  const rel = RELEASES[0];
  const after = rel != null ? REMOTE.filter((r) => r.t > rel && r.t < rel + 0.45) : [];
  M.throw = { gestoRemoto: after.some((r) => (r.throwT ?? 0) > 0 && r.throwReleased) };
  check(M.throw.gestoRemoto, 'remoto lanzamiento: sin gesto tras la suelta');
}
{
  // recarga: fase como la del rig local (circular en la escopeta), mismo
  // tramo recargando, gesto final solo si terminó
  const cdiff = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
  for (const name of ['reload', 'reload-cancel', 'reload-shotgun']) {
    const ps = pairs(name, 0.1, 0);
    const both = ps.filter(([l, r]) => l.reloading && r.reloading);
    const rs = REMOTE.filter((r) => r.t - bestD >= steps[name].t0 && r.t - bestD <= steps[name].t1 + 0.6);
    M[name] = { mismoEstado: frac(ps, ([l, r]) => !!l.reloading === !!r.reloading),
      faseMAE: both.length ? +mean(both.map(([l, r]) => cdiff(l.reloadT, r.reloadT))).toFixed(3) : null,
      faseRemotaMax: rs.length ? +Math.max(...rs.map((r) => r.reloading ? r.reloadT : 0)).toFixed(2) : 0,
      bombeoRemoto: rs.some((r) => r.pump) };
  }
  const recargaRemota = REMOTE.some((r) => r.reloading);
  if (COMPAT) {
    M.compat = { modo: COMPAT, recargaDibujada: recargaRemota };
    check(!recargaRemota, `versiones mezcladas (${COMPAT}): se dibujó una recarga sin dato`);
  } else {
    check(M.reload.mismoEstado > 0.85 && M.reload.faseMAE < 0.1 && M.reload.faseRemotaMax > 0.97,
      `remoto recarga SMG: ${JSON.stringify(M.reload)}`);
    check(M['reload-cancel'].mismoEstado > 0.85 && M['reload-cancel'].faseRemotaMax < 0.8,
      `remoto recarga cancelada: ${JSON.stringify(M['reload-cancel'])}`);
    check(M['reload-shotgun'].mismoEstado > 0.85 && M['reload-shotgun'].faseMAE < 0.12 && M['reload-shotgun'].bombeoRemoto,
      `remoto recarga escopeta: ${JSON.stringify(M['reload-shotgun'])}`);
    check(report.remote.bytesRlPorEstado > 0 && report.remote.bytesRlPorEstado <= 12, `rl: ${report.remote.bytesRlPorEstado} bytes`);
  }
}
{
  const ps = pairs('high-lean', 0.35);
  M['high-lean'] = { leanLocal: +mean(ps.map(([l]) => l.coverLean)).toFixed(2), leanRemoto: +mean(ps.map(([, r]) => r.coverLean ?? 0)).toFixed(2), mismoEstado: frac(ps, ([l, r]) => l.state === r.state) };
  check(M['high-lean'].leanLocal > 0.6 && Math.abs(M['high-lean'].leanLocal - M['high-lean'].leanRemoto) < 0.2 && M['high-lean'].mismoEstado > 0.85, `remoto inclinación en orilla HIGH: ${JSON.stringify(M['high-lean'])}`);
}

// ---------- BOT ----------
function makeBot() {
  const bw = Object.assign(makeWorld(), { navigation: null });
  const b = new Bot(new THREE.Scene(), bw, 'b1', '', 'red', { x: 0, z: 0, yaw: 0 }, 0);
  b.rig.groundFn = (x, z, y) => bw.groundHeight({ x, z }, R, y);
  b.fireHoldT = 0; // sin esperar a difundir la pose de nacimiento (no hay red)
  b.poseHeld = 1e9; // ídem: la pose ya salió por botState (aquí no corre el paso de postura)
  return b;
}
const B = report.bot;
// cada bloque por separado: el árbol de antes no tiene algunos métodos
async function block(fn) {
  try { await fn(); } catch (e) { failures.push('bot: ' + e.message.split('\n')[0]); (B.errores ??= []).push(e.message.split('\n')[0]); }
}
// PRUEBAS (corrida 6, FPS): los bots ya no se pegan a la cobertura (sin
// cover_low/cover_high, ganchos/bots.md): se agachan tras LOW, se asoman con ce y
// se inclinan con cl en la orilla HIGH, igual que el jugador. La paridad se
// compara en lo que llega al rig: estado, ce (coverAimExposure) y cl (coverLean).
// Retirado: "de espaldas a la pared" y el strafe pegado (no existen); que el
// bot escondido no vea ni dispare lo afirma check-fps-bots B.
await block(async () => {
  const b = makeBot();
  const f = world.faces[0];
  b.pos = { x: 0, z: -5 + R + 0.12 }; b.yaw = 0; b.rigYaw = 0; b.velX = 0; b.velZ = 0;
  b.aim = false; b.wantCe = 0; b.wantCl = 0;
  let anim, p;
  for (let i = 0; i < 90; i++) { anim = b._posture('idle', 1 / 60); p = b._rigParams(anim, 1 / 60); }
  placeFacing(f, 3); input.mv = { x: 0, z: 0 }; input.aimHeld = false; input.crouchHeld = true; input.leanAxis = 0;
  for (let i = 0; i < 60; i++) ctl.update(1 / 60, input, false);
  let lp = ctl.animParams();
  B.lowEscondido = { bot: `${p.state} ce=${p.coverAimExposure.toFixed(2)}`, jugador: `${lp.state} ce=${lp.coverAimExposure.toFixed(2)}` };
  check(p.state === 'crouch' && p.state === lp.state && Math.abs(p.coverAimExposure - lp.coverAimExposure) < 0.05,
    `bot escondido tras LOW: ${JSON.stringify(B.lowEscondido)}`);
  b.aim = true; b.wantCe = 1;
  for (let i = 0; i < 40; i++) { anim = b._posture('idle', 1 / 60); p = b._rigParams(anim, 1 / 60); }
  input.aimHeld = true;
  for (let i = 0; i < 40; i++) ctl.update(1 / 60, input, false);
  lp = ctl.animParams();
  B.lowAsomado = { bot: `${p.state} aim=${p.aim} ce=${p.coverAimExposure.toFixed(2)}`, jugador: `${lp.state} aim=${lp.aim} ce=${lp.coverAimExposure.toFixed(2)}` };
  // altura efectiva de cabeza: con ce = 1 el bot ya cuenta como de pie (idle) y el
  // jugador sigue en crouch con ce = 1; rig y volumen son el mismo (CONTRATO, RED §1)
  const h = (q) => (q.state === 'crouch' ? q.coverAimExposure : 1);
  check(p.aim === lp.aim && Math.abs(h(p) - h(lp)) < 0.05 && h(lp) > 0.9 &&
    ['crouch', 'idle'].includes(p.state) && ['crouch', 'idle'].includes(lp.state),
    `bot asomado sobre LOW: ${JSON.stringify(B.lowAsomado)}`);
  input.aimHeld = false; input.crouchHeld = false;
});
// orilla HIGH: de pie, apuntando e inclinado al mismo lado que el jugador
await block(async () => {
  const b = makeBot();
  const f = world.faces[1];
  b.pos = { x: 9.65, z: -5 + R + 0.25 }; b.yaw = 0; b.rigYaw = 0; b.velX = 0; b.velZ = 0;
  b.aim = true; b.wantCe = 1; b.wantCl = 1;
  let anim, p;
  for (let i = 0; i < 40; i++) { b.aim = true; anim = b._posture('idle', 1 / 60); p = b._rigParams(anim, 1 / 60); }
  placeFacing(f, 3.65, R + 0.25); input.mv = { x: 0, z: 0 }; input.aimHeld = true; input.leanAxis = 1;
  for (let i = 0; i < 40; i++) ctl.update(1 / 60, input, false);
  const lp = ctl.animParams();
  B.altoLean = { bot: `${p.state} aim=${p.aim} cl=${p.coverLean.toFixed(2)}`, jugador: `${lp.state} aim=${lp.aim} cl=${(+lp.coverLean).toFixed(2)}` };
  check(p.state === lp.state && p.aim === lp.aim && Math.abs(p.coverLean - lp.coverLean) < 0.05,
    `bot inclinado en orilla HIGH: ${JSON.stringify(B.altoLean)}`);
  input.aimHeld = false; input.leanAxis = 0;
});
// recarga y cambio de arma: mismas fases que Weapons
await block(async () => {
  const b = makeBot(); const W = new Weapons(); W.infinite = true;
  b.wep = 'smg'; b.ammo.smg = 5; b._startReload();
  W.st.mag = 5; W.startReload();
  const errs = [];
  for (let i = 0; i < 200; i++) {
    const bp = b._reloadPhase(), wp = W.reloading ? 1 - W.st.reload / W.def.reloadTime : 0;
    if (b.reloadT > 0 && W.reloading) errs.push(Math.abs(bp - wp));
    b._reloadStep(1 / 60); W.update(1 / 60, false, false, true, true);
  }
  B.recarga = { faseMAE: +mean(errs).toFixed(3), n: errs.length };
  check(errs.length > 60 && mean(errs) < 0.03, `bot recarga: ${JSON.stringify(B.recarga)}`);
  // escopeta: ciclo por cartucho, como el jugador
  const bsg = makeBot(), WS = new Weapons(); WS.infinite = true; WS.startSwap('shotgun');
  for (let i = 0; i < 60; i++) WS.update(1 / 60, false, false, true, true);
  const sd = TUNING.weapons.shotgun, miss = sd.mag;
  bsg.wep = 'shotgun'; bsg.ammo.shotgun = sd.mag - miss; bsg._startReload();
  WS.st.mag = sd.mag - miss; WS.startReload();
  const es = [];
  for (let i = 0; i < 300; i++) {
    if (bsg.reloadT > 0 && WS.reloading) es.push(Math.abs(bsg._reloadPhase() - (1 - WS.st.reload / WS.def.reloadTime)));
    bsg._reloadStep(1 / 60); WS.update(1 / 60, false, false, true, true);
  }
  B.recargaEscopeta = { faseMAE: +mean(es).toFixed(3), n: es.length };
  check(es.length > 30 && mean(es) < 0.05, `bot recarga escopeta: ${JSON.stringify(B.recargaEscopeta)}`);
  const b2 = makeBot(); const W2 = new Weapons();
  b2._trySwap('shotgun'); W2.startSwap('shotgun');
  let bs = 0, ws = 0, bSwitch = null, wSwitch = null;
  for (let i = 0; i < 60; i++) {
    b2.swapAnim = Math.max(0, b2.swapAnim - 1 / 60);
    if (b2._swapModel && b2.swapAnim <= 0.55 / 2) { b2.shownWep = b2._swapModel; b2._swapModel = null; }
    W2.update(1 / 60, false, false, true, true);
    if (b2.swapAnim > 0) bs++; if (W2.swapping) ws++;
    if (bSwitch == null && b2.shownWep === 'shotgun') bSwitch = i; if (wSwitch == null && W2.cur === 'shotgun') wSwitch = i;
  }
  B.cambio = { botS: +(bs / 60).toFixed(2), jugadorS: +(ws / 60).toFixed(2), cambioModeloBot: bSwitch, cambioModeloJugador: wSwitch };
  check(Math.abs(bs - ws) <= 2 && bSwitch != null && Math.abs(bSwitch - wSwitch) <= 2, `bot cambio de arma: ${JSON.stringify(B.cambio)}`);
});
// lanzamiento: gesto del jugador, suelta en throwRelease, desde la mano
await block(async () => {
  const b = makeBot();
  let released = null, swappedIn = null;
  // doble de partida que hereda de BotMatch (botThrowSmoke ya llama this._eyeOf)
  const fake = matchStub({ cb: { smoke: { throwNade: (o, v) => { released = { o, v }; } } }, external: false, _nadeSeq: 0 });
  Bot.prototype.constructor; // (sin uso: el método vive en BotMatch)
  const { BotMatch } = await import('../src/game/botmatch.js');
  fake.botReleaseSmoke = BotMatch.prototype.botReleaseSmoke;
  const okStart = BotMatch.prototype.botThrowSmoke.call(fake, b, { x: 0, z: -12 });
  let t = 0, relT = null, startT = null;
  for (let i = 0; i < 160 && okStart; i++) {
    t += 1 / 60;
    b.swapAnim = Math.max(0, b.swapAnim - 1 / 60);
    if (b._swapModel && b.swapAnim <= 0.55 / 2) { b.shownWep = b._swapModel; b._swapModel = null; b.rig.setWeapon(b.shownWep); if (b.shownWep === 'grenade') swappedIn = t; }
    b._stepThrow(1 / 60);
    if (startT == null && b.throwT > 0) startT = t;
    b.rig.setTransform(b.pos.x, b.pos.z, b.rigYaw, b.y);
    b.rig.update(1 / 60, b._rigParams('idle', 1 / 60));
    if (b.throwPlan?.release) { b.throwPlan.release = false; b.throwPlan.pending = false; fake.botReleaseSmoke(b); relT = t; }
  }
  const g = TUNING.weapons.grenade;
  const handY = released ? released.o.y - b.y : null;
  const sp = released ? Math.hypot(released.v.x, released.v.y - g.throwUp, released.v.z) : null;
  B.lanzamiento = { conGranadaEnMano: swappedIn != null, sueltaTrasGestoS: relT != null && startT != null ? +(relT - startT).toFixed(3) : null,
    sueltaJugadorS: g.throwRelease, alturaManoM: handY != null ? +handY.toFixed(2) : null, velocidadSinThrowUp: sp != null ? +sp.toFixed(2) : null,
    vueltaAPrimaria: b.shownWep === 'smg' && !b.throwPlan };
  check(okStart && swappedIn != null && Math.abs(B.lanzamiento.sueltaTrasGestoS - g.throwRelease) < 0.02 &&
    Math.abs(sp - g.throwSpeed) < 0.01 && handY > 1.2 && B.lanzamiento.vueltaAPrimaria, `bot lanzamiento: ${JSON.stringify(B.lanzamiento)}`);
});
// patada: fase como controller.js (fallada y conectada) y patada en carrera
await block(async () => {
  const b = makeBot();
  const ml = TUNING.melee;
  const phases = (hit) => {
    b.meleeT = ml.time; b.meleeEl = 0; b.meleeEntrySpeed = 6; const out = [];
    let hitDone = false;
    while (b.meleeT > 0) {
      b.meleeT -= 1 / 60; b.meleeEl += 1 / 60;
      if (hit && !hitDone && b.meleeT <= ml.time - ml.hitAt) { hitDone = true; b.meleeT = Math.min(b.meleeT, ml.hitRecovery); }
      out.push(b._rigParams('melee', 1 / 60).meleePhase);
    }
    return out;
  };
  const player = (hit) => {
    let mt = 0, end = ml.hitAt + ml.missRecovery; const out = []; let hitDone = false;
    while (mt < end) { mt += 1 / 60; if (hit && !hitDone && mt >= ml.hitAt) { hitDone = true; end = Math.max(mt + ml.hitRecovery, ml.hitAt + ml.hitRecovery); } out.push(Math.min(1, mt / end)); }
    return out;
  };
  const cmp = (a, c) => { const n = Math.min(a.length, c.length); let e = 0; for (let i = 0; i < n; i++) e += Math.abs(a[i] - c[i]); return +(e / n).toFixed(3); };
  B.patada = { faseFalladaMAE: cmp(phases(false), player(false)), faseConectadaMAE: cmp(phases(true), player(true)),
    tackle: b._rigParams('melee', 1 / 60).meleeTackle };
  check(B.patada.faseFalladaMAE < 0.03 && B.patada.faseConectadaMAE < 0.03 && B.patada.tackle === true, `bot patada: ${JSON.stringify(B.patada)}`);
});
// compuertas de disparo (como fire-control del jugador) y munición real
await block(async () => {
  const { BotMatch } = await import('../src/game/botmatch.js');
  const mk = () => { const b = makeBot(); b.reactT = 0; b.yaw = 0; b.rigYaw = 0; b.swapAnim = 0; b._stepDt = 1 / 60; return b; };
  const G1 = {};
  for (const w of ['smg', 'shotgun', 'sniper', 'bazooka']) {
    const b = mk(); let shots = 0;
    const m = matchStub({ botShoot: () => { shots++; return true; }, botFireRocket: () => { shots++; }, rocketPathClear: () => true });
    b.wep = w; b.specialAmmo = 5; b.dazeT = 0.4; b.shotCd = 0; b.burstT = 1; b.pauseT = 0;
    b._fireAt(1 / 60, m, { id: 'e', x: 0, z: -10, y: 0 }, 10);
    G1[w] = shots;
  }
  B.aturdidoDisparos = G1;
  check(Object.values(G1).every((n) => n === 0), `bot aturdido dispara: ${JSON.stringify(G1)}`);
  // humo sobre la línea en el momento del tiro: sin tiro apuntado
  const M2 = Object.create(BotMatch.prototype);
  Object.assign(M2, { world: makeWorld(), external: false, bots: [], motion: new Map(), _clock: 0, playerTeam: 'blue',
    cb: { smoke: { blocksSegment: () => true }, effects: { tracer() {}, muzzleFlash() {}, impact() {} }, audio: {}, player: () => ({ x: 0, z: -6, y: 0, alive: true }), damagePlayer: () => false } });
  const bs = mk();
  B.humoAlDisparar = M2.botShoot(bs, { id: 'player', x: 0, z: -6, y: 0, cx: 0, cy: 1.1, cz: -6, hx: 0, hy: 1.52, hz: -6, hr: 0.22, legacy: true });
  check(B.humoAlDisparar === false, 'bot dispara apuntado a través del humo');
  // cohete y sniper con humo en la línea al lanzar: nada sale, nada se gasta
  {
    const mRock = Object.create(BotMatch.prototype);
    let launched = 0;
    Object.assign(mRock, { world: makeWorld(), external: false, bots: [], _rocketSeq: 0,
      cb: { smoke: { blocksSegment: () => true }, rockets: { fire() { launched++; } }, audio: {} } });
    mRock.rocketPathClear = () => true;
    mRock.botShoot = () => false; // botShoot ya declina con humo (arriba)
    const br = mk(); br.wep = 'bazooka'; br.specialAmmo = 3; br.shotCd = 0;
    br._fireAt(1 / 60, mRock, { id: 'e', x: 0, z: -15, y: 0 }, 15);
    const bsn = mk(); bsn.wep = 'sniper'; bsn.specialAmmo = 3; bsn.shotCd = 0;
    bsn._fireAt(1 / 60, mRock, { id: 'e', x: 0, z: -15, y: 0 }, 15);
    B.humoProyectiles = { cohetesLanzados: launched, municionCohete: br.specialAmmo, municionSniper: bsn.specialAmmo };
    check(launched === 0 && br.specialAmmo === 3 && bsn.specialAmmo === 3, `bot dispara/gasta con humo: ${JSON.stringify(B.humoProyectiles)}`);
  }
  // evidencia de arma: el `w` que difunde el bot (shownWep) cambia ≥0.15 s
  // antes del primer tiro con el arma nueva
  {
    const b = mk(); b.wep = 'smg'; b.ammo.shotgun = 8; b.swapCd = 0; let shotAt = null, wAt = null, t = 0;
    const m = matchStub({ botShoot: () => { if (shotAt == null) shotAt = t; return true; } });
    b._trySwap('shotgun');
    for (let i = 0; i < 90; i++) {
      t += 1 / 60; b.shotCd = Math.max(-0.5, b.shotCd - 1 / 60);
      b.swapAnim = Math.max(0, b.swapAnim - 1 / 60);
      if (b._swapModel && b.swapAnim <= 0.55 / 2) { b.shownWep = b._swapModel; b._swapModel = null; }
      if (wAt == null && b.shownWep === 'shotgun') wAt = t;
      b._fireAt(1 / 60, m, { id: 'e', x: 0, z: -6, y: 0 }, 6);
    }
    B.evidenciaArma = { wDifundido: +wAt.toFixed(3), primerTiro: shotAt != null ? +shotAt.toFixed(3) : null };
    check(shotAt != null && shotAt - wAt >= 0.15, `bot dispara el arma nueva antes de difundirla: ${JSON.stringify(B.evidenciaArma)}`);
  }
  // nacer / ser movido lejos: no dispara hasta que la pose salga por botState
  {
    const b = makeBot(); b.reactT = 0; b.yaw = 0; b.rigYaw = 0; b.swapAnim = 0; b._stepDt = 1 / 60;
    b.respawn({ x: 0, z: 0, yaw: 0 });
    let shots = 0; const m = matchStub({ botShoot: () => { shots++; return true; } });
    b.shotCd = 0; b.burstT = 1; b.pauseT = 0; b.reactT = 0;
    b._fireAt(1 / 60, m, { id: 'e', x: 0, z: -6, y: 0 }, 6);
    B.esperaTrasNacer = { tirosEnElMismoPaso: shots, esperaS: +(2.5 / TUNING.net.sendHz).toFixed(3) };
    check(shots === 0, 'bot dispara en el paso en que nace (pose sin difundir)');
  }
  // escopeta vacía: 8 × reloadTime y la reserva baja; SMG gasta reserva
  const sd = TUNING.weapons.shotgun, md = TUNING.weapons.smg;
  const b = mk(); b.wep = 'shotgun'; b.ammo.shotgun = 0; b._startReload();
  let t = 0; while (b.reloadT > 0 && t < 10) { b._reloadStep(1 / 60); t += 1 / 60; }
  const b2 = mk(); b2.wep = 'smg'; b2.ammo.smg = 10; b2._startReload(); while (b2.reloadT > 0) b2._reloadStep(1 / 60);
  // sin reserva no recarga y cambia a la otra arma
  const b3 = mk(); b3.wep = 'smg'; b3.ammo.smg = 0; b3.reserve.smg = 0; b3.swapCd = 2;
  b3._fireAt(1 / 60, matchStub({ botShoot: () => true }), { id: 'e', x: 0, z: -10, y: 0 }, 10);
  B.municion = { escopetaVaciaS: +t.toFixed(2), jugadorS: +(sd.mag * sd.reloadTime).toFixed(2),
    reservaEscopeta: `${sd.reserve}→${b.reserve.shotgun}`, reservaSMG: `${md.reserve}→${b2.reserve.smg}`,
    secoCambiaA: b3.wep, secoRecarga: b3.reloadT > 0 };
  check(Math.abs(t - sd.mag * sd.reloadTime) < 0.05 && b.ammo.shotgun === sd.mag && b.reserve.shotgun === sd.reserve - sd.mag &&
    b2.ammo.smg === md.mag && b2.reserve.smg === md.reserve - (md.mag - 10) && b3.wep === 'shotgun' && !B.municion.secoRecarga,
    `bot munición: ${JSON.stringify(B.municion)}`);
  // PRUEBAS (corrida 6): "vuelta de bot reconstruible" retirada: los bots ya no hacen voltereta.
});
// origen de los tiros de un bot alojado: lo que el servidor acepta
// (server.js botOriginLegal: ≤1.2 m en planta del cuerpo, 0.3–2.1 m sobre los
// pies, tramo pecho→origen libre); un origen fuera de eso es un tiro rechazado
await block(async () => {
  const { BotMatch } = await import('../src/game/botmatch.js');
  const W = makeWorld();
  const origins = [];
  const M3 = Object.create(BotMatch.prototype);
  Object.assign(M3, { world: W, external: true, bots: [], motion: new Map(), _clock: 0, playerTeam: 'blue', _rocketSeq: 0,
    cb: { effects: { tracer() {}, muzzleFlash() {}, impact() {} }, audio: { gun() {}, impact() {} }, humans: () => [],
      botFire: (bot, o) => origins.push({ o: { x: o.x, y: o.y, z: o.z }, b: { x: bot.pos.x, y: bot.y, z: bot.pos.z } }),
      botRocket: (bot, o) => origins.push({ o, b: { x: bot.pos.x, y: bot.y, z: bot.pos.z } }),
      rockets: { fire() {} } } });
  const cases = [
    ['de pie', (b) => {}],
    ['agachado tras LOW', (b) => { b.pos = { x: 0, z: -4.3 }; b.ce = 0; b.wantCe = 0; b._posture('idle', 1 / 60); }],
    ['asomado sobre LOW', (b) => { b.pos = { x: 0, z: -4.3 }; b.aim = true; b.ce = 1; b.wantCe = 1; b._posture('idle', 1 / 60); }],
    ['en el aire (salto)', (b) => { b.y = 1.2; b.vy = 3; b.grounded = false; }],
  ];
  let bad = 0;
  for (const [, setup] of cases) {
    const b = makeBot(); b.pos = { x: 0, z: 2 }; b.yaw = 0; b.rigYaw = 0; setup(b);
    b.rig.setTransform(b.pos.x, b.pos.z, b.rigYaw, b.y); b.rig.update(1 / 60, b._rigParams('idle', 1 / 60));
    M3.botShoot(b, { id: 'h', x: b.pos.x, z: b.pos.z - 12, y: 0, cx: b.pos.x, cy: 1.1, cz: b.pos.z - 12, hx: b.pos.x, hy: 1.52, hz: b.pos.z - 12, hr: 0.22, legacy: true });
    b.wep = 'bazooka'; M3.botFireRocket(b, { x: b.pos.x, z: b.pos.z - 12, y: 0 });
  }
  const T3 = (await import('three'));
  for (const { o, b } of origins) {
    const rel = o.y - b.y, h = Math.hypot(o.x - b.x, o.z - b.z);
    const a = new T3.Vector3(b.x, b.y + 1.3, b.z), d = new T3.Vector3(o.x - a.x, o.y - a.y, o.z - a.z);
    const len = d.length(); d.normalize();
    const blocked = len > 0.02 && W.raycast(a, d, len - 0.02) !== null;
    if (!(h <= 1.2 && rel >= 0.3 && rel <= 2.1 && !blocked)) bad++;
  }
  B.origenTirosBot = { tiros: origins.length, fueraDeLoQueAceptaElServidor: bad };
  check(origins.length >= 5 && bad === 0, `bot: origen de tiro que el servidor rechazaría: ${JSON.stringify(B.origenTirosBot)}`);
});
// salto (la voltereta se retiró: sin flipAxis/flipDir que comparar)
await block(async () => {
  const b = makeBot();
  b.vy = 4;
  const p = b._rigParams('jump', 1 / 60);
  B.salto = { vy: p.vy, estado: p.state };
  check(p.vy === 4 && p.state === 'jump', `bot salto: ${JSON.stringify(B.salto)}`);
});
// cadencia: arrastre del sobrante, igual a la configurada a cualquier fps
await block(async () => {
  const nominal = TUNING.weapons.smg.rpm / 1.2;
  B.cadenciaSMG = { nominal: +nominal.toFixed(1) };
  for (const hz of [30, 60, 144]) {
    const b = makeBot(); const dt = 1 / hz;
    let shots = 0;
    const match = matchStub({ botShoot: () => { shots++; return true; } });
    b.reactT = 0; b.burstT = 1e9; b.pauseT = 0; b.shotCd = 0; b.ammo.smg = 1e9; b.yaw = 0; b.rigYaw = 0;
    const enemy = { id: 'e', x: 0, z: -10, y: 0 };
    for (let t = 0; t < 30; t += dt) {
      b._stepDt = dt;
      b.shotCd = Math.max(-0.5, b.shotCd - dt);
      b.swapAnim = 0;
      b._fireAt(dt, match, enemy, 10);
    }
    B.cadenciaSMG[`${hz}Hz`] = +(shots / 30 * 60).toFixed(1);
    check(Math.abs(shots / 30 * 60 - nominal) / nominal < 0.02, `bot cadencia SMG a ${hz} Hz: ${(shots / 30 * 60).toFixed(1)} RPM (nominal ${nominal.toFixed(1)})`);
  }
});

if (!COMPAT && !REAL) {
  // versiones mezcladas: el mismo guion con un servidor que no reenvía `rl` y
  // con un cliente que no lo manda; nada se rompe y no se dibuja recarga
  for (const mode of ['old-server', 'old-client']) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--compat=${mode}`], { encoding: 'utf8' });
    report.remote[`compat-${mode}`] = r.status === 0 ? 'ok' : 'fallo';
    if (r.status !== 0) failures.push(`versiones mezcladas ${mode}: ` + (r.stderr.split('\n').filter((x) => x.startsWith(' - ')).join(' | ') || r.stderr.slice(-300)));
  }
}
if (flags.json) fs.writeFileSync(flags.json, JSON.stringify({ report, failures, local: flags.traces ? LOCAL : undefined, remote: flags.traces ? REMOTE : undefined }, null, 1));
console.log(JSON.stringify(report, null, 1));
if (failures.length) {
  console.error('ANIM PARITY ERRORS:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('ANIM PARITY OK · remoto (agachado, asomo, salto, mantle, slide, patada, cambio, lanzamiento, recarga, inclinación) · bot (agachado, asomo, inclinación, recarga, cambio, lanzamiento, patada, cadencia)');
