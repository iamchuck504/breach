// Contrato mínimo de autoridad online: un hit sin disparo no vale; cada tiro
// tiene cadencia, rango temporal, un target por claim y presupuesto de daño.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8794;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  // Esta prueba aísla autoridad balística; el flujo de presentación tiene su
  // propio contrato y aquí se desactiva para no añadir 13 s a cada ejecución.
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0' }, stdio: 'ignore',
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(name, action) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = { ws, welcome: null, messages: [], waiters: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', action, name, v: 0 })));
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
  o: [peer.self.x, 1.1, peer.self.z],
  p: [target.self.x, 1.1, target.self.z], d: [],
});
const hpOf = (snap, id) => snap.ps.find((p) => p.id === id)?.hp;

let a, b;
try {
  await delay(700);
  a = await connect('AUDIT-A', 'create');
  b = await connect('AUDIT-B', 'join');
  send(a, { t: 'lobbyStart' });
  const match = await waitFor(a, (m) => m.t === 'matchStart');
  const matchB = await waitFor(b, (m) => m.t === 'matchStart');
  a.self = match.players.find((p) => p.id === a.welcome.id);
  b.self = matchB.players.find((p) => p.id === b.welcome.id);
  await waitFor(a, (m) => m.t === 'start');

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

  // Un remate cercano de escopeta publica el contexto visual autoritativo.
  // Los clientes no deben decidir por su cuenta si una muerte desmiembra.
  const bx = b.self.x, bz = b.self.z;
  send(a, { t: 's', x: bx, z: bz - 1.5, y: 0, yaw: 0, st: 'idle', w: 'shotgun', am: 8, ar: 24 });
  await delay(700);
  send(a, { t: 'fire', w: 'shotgun', o: [bx, 1.1, bz - 1.5], p: [bx, 1.1, bz], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 104, part: 'body', gib: 1 });
  const death = await waitFor(a, (m) => m.t === 'death' && m.target === b.welcome.id);
  if (!death.gib || death.w !== 'shotgun' || death.part !== 'body' ||
      death.dist > 4.2 || death.dmg !== 104) {
    throw new Error('contexto de muerte fuerte incompleto: ' + JSON.stringify(death));
  }

  console.log('ONLINE FIRE OK · autoridad de hit y contexto de muerte fuerte validados');
} finally {
  a?.ws.close();
  b?.ws.close();
  server.kill();
}
