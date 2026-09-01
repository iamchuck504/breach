// Contrato end-to-end: World y servidor comparten colliders; un hit no puede
// atravesarlos y el historial breve conserva lag compensation legítima.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright-core';
import { expandedCollisionBoxes, helipadSegments } from '../src/world/collision-layouts.js';
import { mapLineBlocked } from '../server/map-geometry.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8811;
import { CHROME as chrome } from './lib-chrome.mjs';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(mapLineBlocked('fortaleza', [0, 1, -4], [0, 1, 4]), true);
assert.equal(mapLineBlocked('fortaleza', [3, 1, -4], [3, 1, 4]), false);
assert.equal(mapLineBlocked('calle', [0, 1, -38], [0, 1, -31]), true);
assert.equal(mapLineBlocked('calle', [0, 5, -10], [0, 5, 10]), false);
assert.equal(mapLineBlocked('azoteas', [8, 1.5, 0], [0, 1.5, 0]), true);
assert.equal(mapLineBlocked('azoteas', [8, 3, 0], [0, 3, 0]), false);

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
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
      const w = { pred, resolve, timer: setTimeout(() => {
        const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout ${label}; recibidos=${this.history.map((m) => m.t).join(',')}`));
      }, timeout) };
      this.waiters.push(w);
    });
  }
  close() { this.ws?.close(); }
}

const state = (peer, x, z) => peer.send({ t: 's', x, y: 0, z, yaw: 0,
  st: 'idle', aim: 0, p: 0, w: 'smg', am: 50, ar: 150, sp: 0 });
const hpOf = (snap, id) => snap.ps.find((p) => p.id === id)?.hp;
let browser, a, b;

try {
  for (let i = 0; i < 60 && !log.includes('BREACH server'); i++) await wait(50);
  if (!log.includes('BREACH server')) throw new Error(`servidor no inició\n${log}`);

  // Comprobar la fuente compartida contra los colliders que World construye
  // realmente en el navegador, no solo contra otra función Node.
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(`http://127.0.0.1:${port}/?nolock=1`, { waitUntil: 'networkidle' });
  for (const map of ['fortaleza', 'azoteas', 'calle']) {
    const actual = await page.evaluate((layout) => {
      const world = window.BREACH_WORLD;
      world.setLayout(layout, true);
      return {
        boxes: world.colliders.map(({ minx, maxx, minz, maxz, h }) =>
          ({ minx, maxx, minz, maxz, h })),
        segments: world.segmentColliders.map(({ a, b, n, half, h }) => ({ a, b, n, half, h })),
      };
    }, map);
    assert.deepEqual(actual.boxes, expandedCollisionBoxes(map), `${map}: cliente/servidor difieren`);
    assert.deepEqual(actual.segments, map === 'azoteas' ? helipadSegments() : [],
      `${map}: segmentos cliente/servidor difieren`);
  }
  await browser.close(); browser = null;

  a = new Peer(); b = new Peer(); await a.open(); await b.open();
  a.send({ t: 'join', action: 'create', name: 'GEOMETRY-A', v: 0 });
  const aw = await a.next((m) => m.t === 'welcome', 'welcome A');
  b.send({ t: 'join', action: 'join', name: 'GEOMETRY-B', v: 0 });
  const bw = await b.next((m) => m.t === 'welcome', 'welcome B');
  a.send({ t: 'lobbyStart' });
  await a.next((m) => m.t === 'matchStart', 'matchStart');
  await a.next((m) => m.t === 'start', 'start');

  // B rompe protección y ambos se colocan a lados opuestos del pilar central.
  state(b, 0, 4); state(a, 0, -4); await wait(100);
  b.send({ t: 'fire', w: 'smg', o: [0, 1.1, 4], p: [0, 1.1, 8], d: [] });
  await wait(90);

  const fireP = b.next((m) => m.t === 'fire' && m.id === aw.id, 'fire bloqueado');
  a.send({ t: 'fire', w: 'smg', o: [0, 1.1, -4], p: [0, 1, 4],
    d: [[0, 1.1, -0.9], [7, 1, 7]] });
  const clipped = await fireP;
  assert.ok(Math.abs(clipped.p[2] + 0.9) < 0.03, `endpoint no fue recortado: ${clipped.p}`);
  assert.equal(clipped.d?.length, 1, 'se retransmitió un decal sin superficie física');
  a.send({ t: 'hit', target: bw.id, dmg: 999, part: 'body', p: [0, 1, 4] });
  await wait(120);
  a.history.length = 0;
  let snap = await a.next((m) => m.t === 'snap', 'snap hit bloqueado');
  assert.equal(hpOf(snap, bw.id), 100, 'el pilar permitió daño a través de él');

  // Carril limpio: el mismo disparo sí debe causar los 10 puntos reales.
  state(a, 3, -4); state(b, 3, 4); await wait(120);
  a.send({ t: 'fire', w: 'smg', o: [3, 1.1, -4], p: [3, 1, 4], d: [] });
  a.send({ t: 'hit', target: bw.id, dmg: 999, part: 'body', p: [3, 1, 4] });
  a.history.length = 0;
  snap = await a.next((m) => m.t === 'snap' && hpOf(m, bw.id) < 100, 'snap hit limpio');
  assert.equal(hpOf(snap, bw.id), 90, 'un carril limpio fue rechazado');

  // El objetivo se mueve justo después del fire: el punto histórico reciente
  // sigue siendo válido, pero no un punto inventado lejos de cualquier pose.
  await wait(110);
  a.send({ t: 'fire', w: 'smg', o: [3, 1.1, -4], p: [3, 1, 4], d: [] });
  state(b, 3, 5);
  a.send({ t: 'hit', target: bw.id, dmg: 999, part: 'body', p: [3, 1, 4] });
  a.history.length = 0;
  snap = await a.next((m) => m.t === 'snap' && hpOf(m, bw.id) < 90, 'rewind válido');
  assert.equal(hpOf(snap, bw.id), 80, 'lag compensation reciente fue rechazada');

  await wait(110);
  a.send({ t: 'fire', w: 'smg', o: [3, 1.1, -4], p: [6, 1, 4], d: [] });
  a.send({ t: 'hit', target: bw.id, dmg: 999, part: 'body', p: [6, 1, 4] });
  await wait(120); a.history.length = 0;
  snap = await a.next((m) => m.t === 'snap', 'snap punto falso');
  assert.equal(hpOf(snap, bw.id), 80, 'se aceptó un impacto lejos del objetivo');

  console.log('MAP AUTHORITY OK · colliders compartidos, LOS, decals y rewind validados');
} finally {
  a?.close(); b?.close(); await browser?.close(); server.kill();
}
