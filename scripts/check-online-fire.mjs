// Contrato mínimo de autoridad online: un hit sin disparo no vale; cada tiro
// tiene cadencia, rango temporal, un target por claim y presupuesto de daño.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8794;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = { ws, welcome: null, messages: [], waiters: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, v: 0 })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'welcome' && !peer.welcome) {
        peer.welcome = msg;
        resolve(peer);
      }
      peer.messages.push(msg);
      for (const waiter of [...peer.waiters]) {
        if (waiter.pred(msg)) { peer.waiters.splice(peer.waiters.indexOf(waiter), 1); waiter.resolve(msg); }
      }
    });
  });
}

function waitFor(peer, pred, timeout = 1200) {
  const prior = [...peer.messages].reverse().find(pred);
  if (prior) return Promise.resolve(prior);
  return new Promise((resolve, reject) => {
    const waiter = { pred, resolve };
    peer.waiters.push(waiter);
    setTimeout(() => {
      const i = peer.waiters.indexOf(waiter);
      if (i >= 0) peer.waiters.splice(i, 1);
      reject(new Error('timeout esperando mensaje'));
    }, timeout);
  });
}

const send = (peer, msg) => peer.ws.send(JSON.stringify(msg));
const firePacket = (peer, target) => ({
  t: 'fire', w: 'smg',
  o: [peer.welcome.spawn.x, 1.1, peer.welcome.spawn.z],
  p: [target.welcome.spawn.x, 1.1, target.welcome.spawn.z], d: [],
});
const hpOf = (snap, id) => snap.ps.find((p) => p.id === id)?.hp;

let a, b;
try {
  await delay(700);
  a = await connect('AUDIT-A');
  b = await connect('AUDIT-B');

  // El target rompe su protección para aislar la validación del atacante.
  send(b, firePacket(b, a));
  await delay(80);

  // Hit sin fire asociado: rechazado.
  send(a, { t: 'hit', target: b.welcome.id, dmg: 120, part: 'head', gib: 1 });
  a.messages.length = 0;
  let snap = await waitFor(a, (m) => m.t === 'snap');
  if (hpOf(snap, b.welcome.id) !== 100) throw new Error('hit sin disparo fue aceptado');

  // Un SMG válido no puede reclamar 120: presupuesto máximo = headshot 16.
  send(a, firePacket(a, b));
  send(a, { t: 'hit', target: b.welcome.id, dmg: 120, part: 'head', gib: 1 });
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap' && hpOf(m, b.welcome.id) < 100);
  if (hpOf(snap, b.welcome.id) !== 84) {
    throw new Error(`presupuesto SMG incorrecto: hp=${hpOf(snap, b.welcome.id)}`);
  }

  // Repetir el claim sin otro disparo no vuelve a aplicar daño.
  send(a, { t: 'hit', target: b.welcome.id, dmg: 16, part: 'head', gib: 0 });
  await delay(90);
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap');
  if (hpOf(snap, b.welcome.id) !== 84) throw new Error('claim duplicado aplicó daño');

  console.log('ONLINE FIRE OK · hit huérfano rechazado · daño SMG limitado a 16');
} finally {
  a?.ws.close();
  b?.ws.close();
  server.kill();
}
