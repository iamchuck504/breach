// Bazooka online end-to-end: el servidor posee vuelo, contacto y splash.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eyeAt, launchAt } from './lib-test.mjs';
import WebSocket from 'ws';
import { freePort } from './lib-test.mjs';
import { withSamples } from './lib-fps-sample.mjs';
// PRUEBAS (ronda 2 de RED): cada fire/rocket/nade/protoFire humano lleva su muestra `fs`
// (n creciente, w = arma equipada) desde el último estado `s` de ese emisor
const SAMPLED = withSamples((peer, m) => peer.ws.send(JSON.stringify(m)));

// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = FREE_PORT;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    SPECIAL_FIRST_WEAPON: 'bazooka', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += String(d); });
server.stderr.on('data', (d) => { log += String(d); });

class Peer {
  constructor() { this.ws = null; this.history = []; this.waiters = []; }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      this.history.push(msg);
      for (const w of [...this.waiters]) {
        if (!w.pred(msg)) continue;
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer); w.resolve(msg);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve); this.ws.once('error', reject);
    });
  }
  send(msg) { SAMPLED(this, msg); }
  next(pred, label, timeout = 3500) {
    const prior = this.history.find(pred); if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve, timer: setTimeout(() => {
        const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout ${label}; recibidos=${this.history.map((m) => m.t).join(',')}`));
      }, timeout) };
      this.waiters.push(waiter);
    });
  }
  clear() { this.history.length = 0; }
  close() { this.ws?.close(); }
}

const state = (peer, x, z, w = 'smg', yaw = 0) => peer.send({
  t: 's', x, y: 0, z, yaw, st: 'idle', aim: 0, p: 0, w, am: 3, ar: 0, sp: 0,
});
const hpOf = (snap, id) => snap.ps.find((p) => p.id === id)?.hp;
let a, b;

try {
  for (let i = 0; i < 60 && !log.includes('BREACH server'); i++) await wait(50);
  if (!log.includes('BREACH server')) throw new Error(`servidor no inició\n${log}`);
  a = new Peer(); b = new Peer(); await a.open(); await b.open();
  a.send({ t: 'join', action: 'create', name: 'ROCKET-A', v: 0, hp: 2, fps: 1 });
  const aw = await a.next((m) => m.t === 'welcome', 'welcome A');
  b.send({ t: 'join', action: 'join', name: 'ROCKET-B', v: 0, hp: 2, fps: 1 });
  const bw = await b.next((m) => m.t === 'welcome', 'welcome B');
  a.send({ t: 'lobbyStart' });
  await a.next((m) => m.t === 'matchStart', 'matchStart');
  await a.next((m) => m.t === 'start', 'start');

  // Expire protection before measuring rocket damage (shots preserve it).
  await wait(5100);
  // A recoge la bazooka autoritativa.
  state(a, 0, 0); await wait(80);
  a.send({ t: 'takeSpecial' });
  await a.next((m) => m.t === 'specialTaken' && m.id === aw.id && m.wep === 'bazooka',
    'bazooka tomada');
  // Estado de un cambio previo al pedestal, aún en tránsito. La posición
  // acredita que el servidor lo procesó antes del snapshot que se comprueba.
  a.send({ t: 'takeSpecial' }); // segundo reclamo, sin respuesta al cliente
  state(a, 0.25, 0, 'pistol');
  const delayed = await a.next(m => m.t === 'snap' && m.ps.some(p => p.id === aw.id && p.x === 0.25),
    'estado previo a la recogida procesado');
  assert.equal(delayed.ps.find(p => p.id === aw.id).w, 'bazooka');
  const refusals = await fetch(`http://127.0.0.1:${port}/test/refusals`);
  assert.equal(refusals.status, 200);
  assert.equal((await refusals.json())['pickup-special'], 1);
  // v3: el obstáculo central es el muro sur de la torre del homenaje (z -5..-4.2)
  state(b, 0, -1.5, 'smg', Math.PI); await wait(80);
  b.send({ t: 'fire', w: 'smg', o: eyeAt(0, 0, -1.5, Math.PI), p: [0, 1.1, 2], d: [] });
  await wait(100);

  // El pilar central debe decidir el contacto, aunque el cliente no envíe
  // jamás un mensaje de explosión.
  state(a, 0, -9, 'bazooka', Math.PI); state(b, 0, -1.5); await wait(100);
  a.clear(); b.clear();
  // PRUEBAS (corrida 6, auditoría): la salida humana FPS la rehace el servidor
  // (ojo + arma, ±0.06 m). Una salida falsa (la vieja de 1.1 m) se RECHAZA por origen…
  a.send({ t: 'rocket', cid: 'badOrigin', o: [0, 1.1, -9], d: [0, 0, 1] });
  const badOrigin = await a.next((m) => m.t === 'rocketReject' && m.cid === 'badOrigin', 'rechazo por origen');
  assert.equal(badOrigin.reason, 'origin', `rechazo con motivo ${badOrigin.reason}`);
  assert.equal(badOrigin.kind, 'bazooka');
  // …y la honesta desde el arma se acepta
  const L0 = launchAt(0, 0, -9, Math.PI);
  a.send({ t: 'rocket', cid: 'blocked', o: L0.o, d: L0.d });
  const ack = await a.next((m) => m.t === 'rocketAck' && m.cid === 'blocked', 'ack');
  const remote = await b.next((m) => m.t === 'rocket' && m.rid === ack.rid, 'relay');
  const blockedBoom = await a.next((m) => m.t === 'rocketBoom' && m.rid === ack.rid,
    'explosión contra pilar');
  assert.equal(remote.id, aw.id);
  assert.equal(blockedBoom.kind, 'world');
  assert.ok(blockedBoom.p[2] < -4.9, `explosión cruzó el muro: ${blockedBoom.p}`);
  await wait(120); a.clear();
  let snap = await a.next((m) => m.t === 'snap', 'snap bloqueado');
  assert.equal(hpOf(snap, bw.id), 100, 'el splash atravesó el pilar central');

  // Ni un segundo launch dentro de cadencia ni el protocolo legado fire+hit
  // pueden fabricar otra explosión o daño.
  a.clear();
  a.send({ t: 'rocket', cid: 'spam', o: L0.o, d: L0.d });
  const rejected = await a.next((m) => m.t === 'rocketReject' && m.cid === 'spam',
    'rechazo por cadencia');
  assert.equal(rejected.cid, 'spam');
  assert.equal(rejected.reason, 'cadence', `rechazo por cadencia con motivo ${rejected.reason}`);
  a.send({ t: 'fire', w: 'bazooka', o: [0, 1, -1.5], p: [0, 1, -1.5], d: [] });
  a.send({ t: 'hit', target: bw.id, dmg: 999, part: 'body', p: [0, 1, -1.5] });
  a.send({ t: 'rocketBoom', p: [0, 1, -1.5], target: bw.id });
  await wait(130); a.clear();
  snap = await a.next((m) => m.t === 'snap', 'snap spoof');
  assert.equal(hpOf(snap, bw.id), 100, 'un cliente fabricó una explosión');

  // Carril limpio: el servidor sigue el proyectil, detecta el cuerpo entre
  // ticks y aplica una sola muerte directa con el mismo punto para todos.
  await wait(1850);
  state(a, 3.8, -3.8, 'bazooka', Math.PI); state(b, 3.8, 3.8); await wait(100);
  a.clear(); b.clear();
  const L1 = launchAt(3.8, 0, -3.8, Math.PI);
  a.send({ t: 'rocket', cid: 'direct', o: L1.o, d: L1.d });
  const directAck = await a.next((m) => m.t === 'rocketAck' && m.cid === 'direct',
    'ack directo');
  const directBoom = await a.next((m) => m.t === 'rocketBoom' && m.rid === directAck.rid,
    'explosión directa');
  const death = await a.next((m) => m.t === 'death' && m.target === bw.id,
    'muerte directa');
  assert.equal(directBoom.direct, 1);
  assert.equal(directBoom.target, bw.id);
  assert.equal(death.w, 'bazooka');
  assert.deepEqual(death.ep, directBoom.p);
  assert.equal(a.history.filter((m) => m.t === 'death' && m.target === bw.id).length, 1,
    'la explosión produjo muertes duplicadas');

  console.log('ROCKET AUTHORITY OK · lanzamiento, pared, fuse, splash y anti-spoof validados');
} finally {
  a?.close(); b?.close(); server.kill();
}
