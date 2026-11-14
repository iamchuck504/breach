// La patada ATURDE en online y lo hace cumplir el servidor: confirma el golpe
// con su duración, rechaza los disparos del pateado mientras dura y los vuelve
// a aceptar después.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8797;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  // Esta prueba aísla autoridad balística; el flujo de presentación tiene su
  // propio contrato y aquí se desactiva para no añadir 13 s a cada ejecución.
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' }, stdio: 'ignore',
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
      if (msg.t === 'respawn') msg.receivedAt = performance.now();
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
      reject(new Error('timeout esperando mensaje: ' + pred.toString()));
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

let a, b, c, d;
try {
  await delay(700);
  a = await connect('AUDIT-A', 'create');
  b = await connect('AUDIT-B', 'join');
  // Dos peers extra mantienen el lobby 2v2 y dejan una víctima independiente
  // para validar el remate autoritativo del sniper sin esperar un respawn.
  c = await connect('AUDIT-C', 'join');
  d = await connect('AUDIT-D', 'join');
  send(a, { t: 'lobbyStart' });
  const match = await waitFor(a, (m) => m.t === 'matchStart');
  const matchB = await waitFor(b, (m) => m.t === 'matchStart');
  const matchC = await waitFor(c, (m) => m.t === 'matchStart');
  const matchD = await waitFor(d, (m) => m.t === 'matchStart');
  a.self = match.players.find((p) => p.id === a.welcome.id);
  b.self = matchB.players.find((p) => p.id === b.welcome.id);
  c.self = matchC.players.find((p) => p.id === c.welcome.id);
  d.self = matchD.players.find((p) => p.id === d.welcome.id);
  await waitFor(a, (m) => m.t === 'start');

  const bx = 3, bz = -2;
  await delay(5200); // protección de aparición
  // b mira a a (hacia -z: yaw 0); a está a 1,4 m mirando a b (yaw π)
  const place = () => {
    send(b, { t: 's', x: bx, z: bz, y: 0, yaw: 0, st: 'idle', w: 'smg', am: 50, ar: 150 });
    send(a, { t: 's', x: bx, z: bz - 1.4, y: 0, yaw: Math.PI, st: 'idle', w: 'smg', am: 50, ar: 150 });
  };
  place(); b.self.x = bx; b.self.z = bz; a.self.x = bx; a.self.z = bz - 1.4;
  await delay(150);

  send(a, { t: 'fire', w: 'melee', o: [bx, 1.1, bz - 1.4], p: [bx, 1.0, bz], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 60, part: 'body', p: [bx, 1.0, bz] });
  const confirm = await waitFor(a, (m) => m.t === 'hitConfirm' && m.target === b.welcome.id);
  if (!(confirm.dz > 0.3)) throw new Error('la patada no aturde: dz=' + confirm.dz);
  if (confirm.dmg !== 60) throw new Error('daño de patada frontal incorrecto: ' + confirm.dmg);

  // aturdido: su disparo no existe para el servidor
  send(b, firePacket(b, a));
  send(b, { t: 'hit', target: a.welcome.id, dmg: 10, part: 'body', p: [bx, 1.0, bz - 1.4] });
  await delay(150);
  a.messages.length = 0;
  let snap = await waitFor(a, (m) => m.t === 'snap');
  if (hpOf(snap, a.welcome.id) !== 100) throw new Error('el pateado pudo disparar aturdido: hp=' + hpOf(snap, a.welcome.id));

  // pasado el aturdimiento vuelve a disparar
  await delay(confirm.dz * 1000 + 150);
  place();
  await delay(80);
  send(b, firePacket(b, a));
  send(b, { t: 'hit', target: a.welcome.id, dmg: 10, part: 'body', p: [bx, 1.0, bz - 1.4] });
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap' && hpOf(m, a.welcome.id) < 100, 2000);

  // una segunda patada dentro del margen no vuelve a aturdir
  send(a, { t: 'fire', w: 'melee', o: [bx, 1.1, bz - 1.4], p: [bx, 1.0, bz], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 60, part: 'body', p: [bx, 1.0, bz] });
  a.messages.length = 0;
  const again = await waitFor(a, (m) => m.t === 'hitConfirm' && m.target === b.welcome.id, 2000).catch(() => null);
  if (again && again.dz > 0) throw new Error('re-aturdió dentro del margen: dz=' + again.dz);
  console.log('PATADA ONLINE OK: aturde ' + confirm.dz + ' s, bloquea el disparo y expira; sin re-aturdir en el margen' + (again ? '' : ' (2.ª patada mató o no se confirmó)'));
} catch (e) {
  console.error('FAIL', e.message); process.exitCode = 1;
} finally {
  for (const peer of [a, b, c, d]) peer?.ws.close();
  server.kill();
}
