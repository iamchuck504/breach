// Bazooka online end-to-end: el servidor posee vuelo, contacto y splash.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8812;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
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
  send(msg) { this.ws.send(JSON.stringify(msg)); }
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
  a.send({ t: 'join', action: 'create', name: 'ROCKET-A', v: 0 });
  const aw = await a.next((m) => m.t === 'welcome', 'welcome A');
  b.send({ t: 'join', action: 'join', name: 'ROCKET-B', v: 0 });
  const bw = await b.next((m) => m.t === 'welcome', 'welcome B');
  a.send({ t: 'lobbyStart' });
  await a.next((m) => m.t === 'matchStart', 'matchStart');
  await a.next((m) => m.t === 'start', 'start');

  // A recoge la bazooka autoritativa; B rompe protección de spawn.
  state(a, 2.8, 0); await wait(80);
  a.send({ t: 'takeSpecial' });
  await a.next((m) => m.t === 'specialTaken' && m.id === aw.id && m.wep === 'bazooka',
    'bazooka tomada');
  state(b, 0, 4); await wait(80);
  b.send({ t: 'fire', w: 'smg', o: [0, 1.1, 4], p: [0, 1.1, 8], d: [] });
  await wait(100);

  // El pilar central debe decidir el contacto, aunque el cliente no envíe
  // jamás un mensaje de explosión.
  state(a, 0, -4, 'bazooka'); state(b, 0, 4); await wait(100);
  a.clear(); b.clear();
  a.send({ t: 'rocket', cid: 'blocked', o: [0, 1.1, -4], d: [0, 0, 1] });
  const ack = await a.next((m) => m.t === 'rocketAck' && m.cid === 'blocked', 'ack');
  const remote = await b.next((m) => m.t === 'rocket' && m.rid === ack.rid, 'relay');
  const blockedBoom = await a.next((m) => m.t === 'rocketBoom' && m.rid === ack.rid,
    'explosión contra pilar');
  assert.equal(remote.id, aw.id);
  assert.equal(blockedBoom.kind, 'world');
  assert.ok(blockedBoom.p[2] < -0.9, `explosión cruzó el pilar: ${blockedBoom.p}`);
  await wait(120); a.clear();
  let snap = await a.next((m) => m.t === 'snap', 'snap bloqueado');
  assert.equal(hpOf(snap, bw.id), 100, 'el splash atravesó el pilar central');

  // Ni un segundo launch dentro de cadencia ni el protocolo legado fire+hit
  // pueden fabricar otra explosión o daño.
  a.clear();
  a.send({ t: 'rocket', cid: 'spam', o: [0, 1.1, -4], d: [0, 0, 1] });
  const rejected = await a.next((m) => m.t === 'rocketReject' && m.cid === 'spam',
    'rechazo por cadencia');
  assert.equal(rejected.cid, 'spam');
  a.send({ t: 'fire', w: 'bazooka', o: [0, 1, 4], p: [0, 1, 4], d: [] });
  a.send({ t: 'hit', target: bw.id, dmg: 999, part: 'body', p: [0, 1, 4] });
  a.send({ t: 'rocketBoom', p: [0, 1, 4], target: bw.id });
  await wait(130); a.clear();
  snap = await a.next((m) => m.t === 'snap', 'snap spoof');
  assert.equal(hpOf(snap, bw.id), 100, 'un cliente fabricó una explosión');

  // Carril limpio: el servidor sigue el proyectil, detecta el cuerpo entre
  // ticks y aplica una sola muerte directa con el mismo punto para todos.
  await wait(1850);
  state(a, 3, -4, 'bazooka'); state(b, 3, 4); await wait(100);
  a.clear(); b.clear();
  a.send({ t: 'rocket', cid: 'direct', o: [3, 1.1, -4], d: [0, 0, 1] });
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
