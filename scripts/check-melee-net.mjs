// Autoridad online específica de melee: rango/cono/cadencia, un hit por gesto
// y confirmación replicada para reacciones visuales de todos los clientes.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8803;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: 'ignore',
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const peers = [];

function connect(name, action) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const p = { ws, id: null, messages: [] };
    peers.push(p);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, action, v: 0 })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      p.messages.push(m);
      if (m.t === 'welcome' && !p.id) { p.id = m.id; resolve(p); }
    });
  });
}
const send = (p, m) => p.ws.send(JSON.stringify(m));
async function waitFor(p, pred, timeout = 1800) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = p.messages.find(pred);
    if (found) return found;
    await delay(20);
  }
  throw new Error('timeout esperando mensaje');
}
async function hp(p, id) {
  p.messages.length = 0;
  return (await waitFor(p, (m) => m.t === 'snap')).ps.find((x) => x.id === id)?.hp;
}
const state = (p, x, z, yaw) => send(p, {
  t: 's', x, z, y: 0, yaw, st: 'melee', w: 'smg', am: 50, ar: 200,
});
const strike = (a, b, ax, az, bx, bz) => {
  send(a, { t: 'fire', w: 'melee', o: [ax, 1.08, az], p: [bx, 1.02, bz], d: [] });
  send(a, { t: 'hit', target: b.id, dmg: 60, part: 'body', gib: 0, p: [bx, 1.02, bz] });
};

try {
  await delay(650);
  const a = await connect('MELEE-A', 'create');
  const b = await connect('MELEE-B', 'join');
  send(a, { t: 'lobbyStart' });
  const ma = await waitFor(a, (m) => m.t === 'matchStart');
  await waitFor(b, (m) => m.t === 'matchStart');
  await waitFor(a, (m) => m.t === 'start');
  a.messages.length = 0; b.messages.length = 0;
  // El target rompe su protección de spawn para aislar la autoridad melee.
  state(b, 0, 0, Math.PI);
  await delay(80);
  send(b, { t: 'fire', w: 'smg', o: [0, 1.1, 0], p: [0, 1.1, 6], d: [] });
  await delay(100);

  // Demasiado lejos: ni el fire queda pendiente ni el hit aplica.
  state(a, 0, 3.2, 0); state(b, 0, 0, Math.PI); await delay(140);
  strike(a, b, 0, 3.2, 0, 0);
  await delay(160);
  const farHp = await hp(a, b.id);
  if (farHp !== 100) throw new Error(`melee lejano aceptado: hp=${farHp}`);

  // En rango pero detrás del atacante: el cono del servidor lo rechaza.
  state(a, 0, 0, 0); state(b, 0, 1.2, Math.PI); await delay(140);
  strike(a, b, 0, 0, 0, 1.2);
  await delay(160);
  const backHp = await hp(a, b.id);
  if (backHp !== 100) throw new Error(`melee trasero aceptado: hp=${backHp}`);

  // Frente y en rango: daño autoritativo + evento de reacción.
  await delay(420);
  a.messages.length = 0; b.messages.length = 0;
  state(a, 0, 1.2, 0); state(b, 0, 0, Math.PI); await delay(140);
  strike(a, b, 0, 1.2, 0, 0);
  const confirm = await waitFor(b, (m) => m.t === 'hitConfirm' && m.target === b.id);
  const validHp = await hp(a, b.id);
  if (validHp !== 40 || confirm.w !== 'melee' || confirm.dmg !== 60) {
    throw new Error(`confirmación melee inválida: hp=${validHp} msg=${JSON.stringify(confirm)}`);
  }

  // Repetir el claim o atacar dentro del intervalo no duplica daño.
  send(a, { t: 'hit', target: b.id, dmg: 60, part: 'body', gib: 0, p: [0, 1.02, 0] });
  strike(a, b, 0, 1.2, 0, 0);
  await delay(160);
  const spamHp = await hp(a, b.id);
  if (spamHp !== 40) throw new Error(`spam melee aplicó daño: hp=${spamHp}`);

  console.log('MELEE NET OK · rango/cono/cadencia/confirmación autoritativos');
} finally {
  for (const p of peers) p.ws.close();
  server.kill();
}
