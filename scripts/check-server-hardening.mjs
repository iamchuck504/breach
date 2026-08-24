// Prueba desde el exterior las defensas HTTP/WS y comprueba que un cliente
// abusivo no tumbe la sala ni pueda teletransportarse.
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAX_WS_PAYLOAD } from '../server/guards.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8810;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += String(d); });
server.stderr.on('data', (d) => { serverLog += String(d); });

function request(method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

class Peer {
  constructor() { this.ws = null; this.history = []; this.waiters = []; }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      this.history.push(msg);
      for (const waiter of [...this.waiters]) {
        if (!waiter.pred(msg)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer); waiter.resolve(msg);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve); this.ws.once('error', reject);
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  next(pred, timeout = 3000, label = 'mensaje') {
    const prior = this.history.find(pred);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve, timer: setTimeout(() => {
        const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout esperando ${label}; recibidos=${this.history.map((m) => m.t).join(',')}`));
      }, timeout) };
      this.waiters.push(waiter);
    });
  }
  close() { this.ws?.close(); }
}

async function abusiveClose(payloads) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  for (const payload of payloads) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(payload);
  }
  return Promise.race([closed, wait(3000).then(() => 0)]);
}

let player;
try {
  for (let i = 0; i < 60 && !serverLog.includes('BREACH server'); i++) await wait(50);
  if (!serverLog.includes('BREACH server')) throw new Error(`el servidor no inició\n${serverLog}`);

  const malformed = await request('GET', '/%E0%A4%A');
  if (malformed.status !== 400) throw new Error(`URL malformada respondió ${malformed.status}`);
  const traversal = await request('GET', '/%2e%2e%2fpackage.json');
  if (traversal.status !== 404 || traversal.body.includes(Buffer.from('"scripts"'))) {
    throw new Error('el servidor permitió salir de dist/');
  }
  const method = await request('POST', '/');
  if (method.status !== 405) throw new Error(`POST respondió ${method.status}`);
  const head = await request('HEAD', '/');
  if (head.status !== 200 || head.body.length !== 0) throw new Error('HEAD no respetó el contrato estático');

  const payloadCode = await abusiveClose(['x'.repeat(MAX_WS_PAYLOAD + 1024)]);
  if (payloadCode !== 1009) throw new Error(`payload excesivo cerró con ${payloadCode}, no 1009`);
  const rateCode = await abusiveClose(Array.from({ length: 420 }, () => '{}'));
  if (rateCode !== 1008) throw new Error(`spam cerró con ${rateCode}, no 1008`);

  player = new Peer(); await player.open();
  player.send({ t: 'join', action: 'create', name: 'HARDENING-QA', v: 0 });
  const welcome = await player.next((m) => m.t === 'welcome', 3000, 'welcome');
  player.send({ t: 'lobbyBotAdd', team: 'blue' });
  await player.next((m) => m.t === 'lobby' && m.bots?.length === 1, 3000, 'lobby con bot');
  player.send({ t: 'lobbyStart' });
  const match = await player.next((m) => m.t === 'matchStart', 3000, 'matchStart');
  await player.next((m) => m.t === 'start', 3000, 'start');
  const self = match.players.find((p) => p.id === welcome.id);
  if (!self) throw new Error('el jugador no apareció en matchStart');

  player.send({ t: 's', x: self.x + 30, y: 0, z: self.z + 30, yaw: 0,
    st: 'run', aim: 0, p: 0, w: 'smg', am: 50, ar: 150, sp: 1 });
  const correction = await player.next((m) => m.t === 'correction', 3000, 'correction');
  if (Math.hypot(correction.x - self.x, correction.z - self.z) > 0.01) {
    throw new Error('la corrección no devolvió la última posición autoritativa');
  }

  const validX = self.x + 0.5;
  player.send({ t: 's', x: validX, y: 0, z: self.z, yaw: 0,
    st: 'run', aim: 0, p: 0, w: 'smg', am: 50, ar: 150, sp: 1 });
  await player.next((m) => m.t === 'snap' && m.ps?.some((p) =>
    p.id === welcome.id && Math.abs(p.x - validX) < 0.01), 3000, 'snap válido');

  const alive = await request('GET', '/index.html');
  if (alive.status !== 200) throw new Error('un cliente abusivo tumbó el servidor');
  console.log('SERVER HARDENING OK · HTTP, payload, rate limit y anti-teleport validados');
} finally {
  player?.close();
  server.kill();
}
