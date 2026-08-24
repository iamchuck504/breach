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
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
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

  // El target rompe su protección para aislar la validación del atacante.
  send(b, firePacket(b, a));
  await delay(80);

  const bx = b.self.x, bz = b.self.z;
  send(a, { t: 's', x: bx, z: bz - 4, y: 0, yaw: 0, st: 'idle', w: 'smg', am: 50, ar: 150 });
  a.self.x = bx; a.self.z = bz - 4;
  await delay(100);

  // Hit sin fire asociado: rechazado.
  send(a, { t: 'hit', target: b.welcome.id, dmg: 120, part: 'head', gib: 1 });
  a.messages.length = 0;
  let snap = await waitFor(a, (m) => m.t === 'snap');
  if (hpOf(snap, b.welcome.id) !== 100) throw new Error('hit sin disparo fue aceptado');

  // Mentir sobre la zona no convierte un impacto de torso en headshot. El
  // servidor ignora además el 120 reclamado y reconstruye los 10 dmg reales.
  send(a, firePacket(a, b));
  send(a, { t: 'hit', target: b.welcome.id, dmg: 120, part: 'head', gib: 1,
    p: [bx, 1.0, bz] });
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap' && hpOf(m, b.welcome.id) < 100);
  if (hpOf(snap, b.welcome.id) !== 90) {
    throw new Error(`zona autoritativa SMG incorrecta: hp=${hpOf(snap, b.welcome.id)}`);
  }

  // Un punto de cabeza real sí usa 1.6x aunque el cliente reclame solo 1 dmg.
  await delay(110);
  send(a, firePacket(a, b));
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'head', gib: 0,
    p: [bx, 1.52, bz] });
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap' && hpOf(m, b.welcome.id) < 90);
  if (hpOf(snap, b.welcome.id) !== 74) {
    throw new Error(`headshot SMG no fue recalculado: hp=${hpOf(snap, b.welcome.id)}`);
  }

  // Repetir el claim sin otro disparo no vuelve a aplicar daño.
  send(a, { t: 'hit', target: b.welcome.id, dmg: 120, part: 'head', gib: 0,
    p: [bx, 1.52, bz] });
  await delay(90);
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap');
  if (hpOf(snap, b.welcome.id) !== 74) throw new Error('claim duplicado aplicó daño');

  // A 80 m la SMG cae a 8 dmg, aunque el cliente intente reclamar 120.
  send(a, { t: 's', x: -40, z: 0, y: 0, yaw: -Math.PI / 2,
    st: 'idle', w: 'smg', am: 48, ar: 150 });
  send(b, { t: 's', x: 40, z: 0, y: 0, yaw: Math.PI / 2,
    st: 'idle', w: 'smg', am: 49, ar: 150 });
  await delay(120);
  send(a, { t: 'fire', w: 'smg', o: [-40, 1.1, 0], p: [40, 1.0, 0], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 120, part: 'body', gib: 0,
    p: [40, 1.0, 0] });
  a.messages.length = 0;
  snap = await waitFor(a, (m) => m.t === 'snap' && hpOf(m, b.welcome.id) < 74);
  if (hpOf(snap, b.welcome.id) !== 66) {
    throw new Error(`falloff SMG autoritativo incorrecto: hp=${hpOf(snap, b.welcome.id)}`);
  }

  // Un remate cercano de escopeta publica el contexto visual autoritativo.
  // Los clientes no deben decidir por su cuenta si una muerte desmiembra.
  send(b, { t: 's', x: bx, z: bz, y: 0, yaw: 0, st: 'idle', w: 'smg', am: 49, ar: 150 });
  send(a, { t: 's', x: bx, z: bz - 1.5, y: 0, yaw: 0, st: 'idle', w: 'shotgun', am: 8, ar: 24 });
  await delay(700);
  send(a, { t: 'fire', w: 'shotgun', o: [bx, 1.1, bz - 1.5], p: [bx, 1.1, bz], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 1,
    pellets: 8, p: [bx, 1.0, bz] });
  const death = await waitFor(a, (m) => m.t === 'death' && m.target === b.welcome.id);
  if (!death.gib || death.hs !== 0 || death.w !== 'shotgun' || death.part !== 'body' ||
      death.dist > 4.2 || death.dmg !== 104) {
    throw new Error('contexto de muerte fuerte incompleto: ' + JSON.stringify(death));
  }

  // El power weapon de la ronda se reclama en su pedestal. El servidor debe
  // validar la cabeza y publicar `hs=1` solo en la muerte letal; el cliente no
  // puede inventar esta reacción visual.
  send(a, { t: 's', x: 2.8, z: 0, y: 0, yaw: 0, st: 'idle', w: 'smg', am: 40, ar: 150 });
  send(a, { t: 'takeSpecial' });
  const special = await waitFor(a, (m) => m.t === 'specialTaken' && m.id === a.welcome.id);
  if (special.wep !== 'sniper') throw new Error('round 1 no entregó sniper');

  // Romper la protección del target y dejar transcurrir la cadencia global
  // desde el disparo de escopeta anterior.
  send(d, firePacket(d, a));
  await delay(1550);
  const dx = d.self.x, dz = d.self.z;
  send(a, { t: 's', x: dx, z: dz - 4, y: 0, yaw: 0,
    st: 'idle', w: 'sniper', am: 1, ar: 5 });
  a.self.x = dx; a.self.z = dz - 4;
  send(a, { t: 'fire', w: 'sniper', o: [dx, 1.1, dz - 4], p: [dx, 1.52, dz], d: [] });
  send(a, { t: 'hit', target: d.welcome.id, dmg: 1, part: 'head', gib: 0,
    p: [dx, 1.52, dz] });
  const sniperDeath = await waitFor(a,
    (m) => m.t === 'death' && m.target === d.welcome.id, 1800);
  if (sniperDeath.hs !== 1 || sniperDeath.gib !== 0 ||
      sniperDeath.w !== 'sniper' || sniperDeath.part !== 'head' ||
      sniperDeath.dmg !== 187 || !Array.isArray(sniperDeath.p) ||
      Math.hypot(sniperDeath.p[0] - dx, sniperDeath.p[1] - 1.52,
        sniperDeath.p[2] - dz) > 0.23) {
    throw new Error('headshot letal de sniper no fue autoritativo: ' + JSON.stringify(sniperDeath));
  }

  // El mismo cliente no puede registrar un rayo al torso y después mover el
  // claim a la cabeza. Esperamos el respawn de B (muerto por la escopeta),
  // rompemos su protección y comprobamos que el server lo degrada a body shot.
  const bRespawn = await waitFor(a,
    (m) => m.t === 'respawn' && m.id === b.welcome.id, 6500);
  b.self = { ...b.self, ...bRespawn.spawn };
  send(b, firePacket(b, a));
  await delay(80);
  const rx = b.self.x, rz = b.self.z;
  send(a, { t: 's', x: rx, z: rz - 4, y: 0, yaw: 0,
    st: 'idle', w: 'sniper', am: 1, ar: 4 });
  a.self.x = rx; a.self.z = rz - 4;
  await delay(80);
  a.messages.length = 0;
  send(a, { t: 'fire', w: 'sniper', o: [rx, 1.1, rz - 4], p: [rx, 1.0, rz], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 999, part: 'head', gib: 0,
    p: [rx, 1.52, rz] });
  const spoofSnap = await waitFor(a,
    (m) => m.t === 'snap' && hpOf(m, b.welcome.id) < 100, 1800);
  if (hpOf(spoofSnap, b.welcome.id) !== 15 ||
      a.messages.some((m) => m.t === 'death' && m.target === b.welcome.id)) {
    throw new Error('claim de cabeza desconectado del rayo fue aceptado');
  }

  console.log('ONLINE FIRE OK · autoridad de hit, gore de escopeta y headshot sniper validados');
} finally {
  a?.ws.close();
  b?.ws.close();
  c?.ws.close();
  d?.ws.close();
  server.kill();
}
