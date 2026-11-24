// Recoger la especial deja el estado del servidor como un cambio REAL a esa
// arma (`w` incluido): el primer tiro inmediato, sin esperar al siguiente
// estado, se acepta; y un cohete nunca reescribe el arma equipada.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eyeAt, launchAt } from './lib-test.mjs';
import WebSocket from 'ws';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';
import { freePort } from './lib-test.mjs';
import { withSamples, nextN } from './lib-fps-sample.mjs';
// el cliente equipa al recibir specialTaken y su muestra del subpaso ya lleva el arma
// NUEVA (NetClient la arma con el jugador del subpaso), aunque su último estado `s` en
// vuelo diga la anterior: el tiro inmediato viaja con esa muestra
const freshSample = (x, z, w) => ({ x, y: 0, z, yaw: 0, st: 'idle', aim: 0, ce: 1, cl: 0, p: 0, sp: 0, ae: 0, w, n: nextN() });
// PRUEBAS (ronda 2 de RED): cada fire/rocket/nade/protoFire humano lleva su muestra `fs`
// (n creciente, w = arma equipada) desde el último estado `s` de ese emisor
const SAMPLED = withSamples((peer, m) => peer.ws.send(JSON.stringify(m)));

// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT_1 = await freePort();
const FREE_PORT_2 = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails.push(name); };
for (const [wep, port] of [['sniper', FREE_PORT_1], ['bazooka', FREE_PORT_2]]) {
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    SPECIAL_FIRST_WEAPON: wep, NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
const peers = [];
function peer(name, action) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), h = [];
  ws.on('message', (raw) => { try { h.push(JSON.parse(raw)); } catch { /* */ } });
  const p = { ws, h, send(m) { SAMPLED(this, m); } };
  peers.push(p);
  return new Promise((r, j) => { ws.once('open', () => { p.send({ t: 'join', action, name, v: 0, hp: 2, fps: 1 }); r(p); }); ws.once('error', j); });
}
try {
  for (let i = 0; i < 80 && !log.includes('BREACH server'); i++) await wait(50);
  const a = await peer('PICK-A', 'create'); await wait(150);
  const b = await peer('PICK-B', 'join'); await wait(150);
  a.send({ t: 'lobbyStart' });
  for (let i = 0; i < 300 && !a.h.find((m) => m.t === 'snap' && m.phase === 'playing'); i++) await wait(50);
  const me = a.h.find((m) => m.t === 'welcome');
  const spot = MAP_RUNTIME.fortaleza.special;
  const state = (w) => a.send({ t: 's', x: spot.x, y: 0, z: spot.z, yaw: 0, st: 'idle', aim: 0, p: 0, w, am: 50, ar: 150, sp: 0 });
  // el host recoge con la ESCOPETA en mano (slot 1): cliente y servidor deben
  // reemplazar el mismo hueco (drop-policy.js)
  state('shotgun'); await wait(300);
  state('shotgun'); a.send({ t: 'fire', w: 'shotgun', o: eyeAt(spot.x, 0, spot.z, 0), p: [spot.x, 1.1, spot.z - 10], d: [] });
  await wait(30);
  a.send({ t: 'takeSpecial' });
  // estado VIEJO en vuelo: el cliente aún no había recibido specialTaken
  state('shotgun');
  for (let i = 0; i < 60 && !a.h.find((m) => m.t === 'specialTaken' && m.id === me.id); i++) await wait(10);
  check(`${wep}: se recoge`, !!a.h.find((m) => m.t === 'specialTaken' && m.id === me.id && m.wep === wep));
  // el cliente equipa al recibir specialTaken y dispara al cuadro siguiente,
  // ANTES de que su siguiente estado (20 Hz) anuncie el arma nueva
  await wait(17);
  if (wep === 'sniper') {
    const n0 = a.h.filter((m) => m.t === 'fire' && m.id === me.id).length;
    a.send({ t: 'fire', w: 'sniper', o: eyeAt(spot.x, 0, spot.z, 0), p: [spot.x, 1.1, spot.z - 20], d: [], fs: freshSample(spot.x, spot.z, 'sniper') });
    await wait(250);
    check('sniper inmediato tras recoger (con un estado viejo en vuelo) → aceptado', a.h.filter((m) => m.t === 'fire' && m.id === me.id).length === n0 + 1);
    // B cae con la escopeta: su drop debe poder reemplazar el sniper (slot 1)
    const bw = b.h.find((m) => m.t === 'welcome');
    b.send({ t: 's', x: spot.x, y: 0, z: spot.z - 4, yaw: 0, st: 'idle', aim: 0, p: 0, w: 'shotgun', am: 8, ar: 24, sp: 0 });
    await wait(5200); // protecciones de spawn
    state('sniper');
    b.send({ t: 's', x: spot.x, y: 0, z: spot.z - 4, yaw: 0, st: 'idle', aim: 0, p: 0, w: 'shotgun', am: 8, ar: 24, sp: 0 });
    await wait(300);
    state('sniper'); a.send({ t: 'fire', w: 'sniper', o: eyeAt(spot.x, 0, spot.z, 0), p: [spot.x, 1.52, spot.z - 4], d: [] });
    a.send({ t: 'hit', target: bw.id, dmg: 1, part: 'head', gib: 0, p: [spot.x, 1.52, spot.z - 4] });
    let drop = null;
    for (let i = 0; i < 60 && !drop; i++) { await wait(30); drop = a.h.find((m) => m.t === 'dropA' && m.wep === 'shotgun'); }
    check('B suelta la escopeta', !!drop, JSON.stringify(a.h.filter((m) => m.t === 'death').at(-1)));
    if (drop) {
      a.send({ t: 's', x: drop.x, y: drop.y || 0, z: drop.z, yaw: 0, st: 'idle', aim: 0, p: 0, w: 'sniper', am: 1, ar: 4, sp: 0 });
      await wait(200);
      // el cliente reemplaza el arma en mano (sniper, slot 1) con su regla
      a.send({ t: 'takeDrop', id: drop.id, replace: true, slot: 1, expected: 'sniper' });
      let give = null;
      for (let i = 0; i < 30 && !give; i++) { await wait(30); give = a.h.find((m) => m.t === 'dropGive' && m.replace); }
      check('el drop reemplaza el MISMO hueco que el cliente (slot 1)', give?.slot === 1 && give?.wep === 'shotgun', JSON.stringify(give));
    }
    for (const p of peers) p.ws.close(); server.kill(); await wait(300);
    continue;
  }
  a.send({ t: 'rocket', cid: 'pick', ...launchAt(spot.x, 0, spot.z, 0), fs: freshSample(spot.x, spot.z, 'bazooka') }); // salida FPS + muestra con el arma nueva
  await wait(250);
  check('cohete inmediato tras recoger → aceptado', !!a.h.find((m) => m.t === 'rocketAck' && m.cid === 'pick'),
    a.h.find((m) => m.t === 'rocketReject') ? 'rechazado' : '');
  // un cohete nunca reescribe el arma equipada: con la SMG publicada, un
  // cohete posterior se rechaza (antes el cohete aceptado ponía w=bazooka)
  state('smg'); await wait(2600);
  a.send({ t: 'rocket', cid: 'smgEquipped', ...launchAt(spot.x, 0, spot.z, 0) }); // salida FPS: ojo + arma
  await wait(250);
  check('cohete con la SMG equipada → rechazado', !!a.h.find((m) => m.t === 'rocketReject' && m.cid === 'smgEquipped'));
} finally {
  for (const p of peers) p.ws.close();
  server.kill();
}
}
if (fails.length) { console.error(`PICKUP FIRE FAILED (${fails.length})`); process.exit(1); }
console.log('PICKUP FIRE OK — la recogida equipa como un cambio real; los proyectiles exigen el arma equipada');
