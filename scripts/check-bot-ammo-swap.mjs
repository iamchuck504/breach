// Contabilidad autoritativa de disparos de un host y de sus bots:
// (a) un bot alojado no dispara más de un cargador sin la pausa de recarga;
// (b) un bot no cambia de arma sin que su `w` replicado (botState) lo muestre;
// (c) cohetes y humo exigen que el arma replicada sea ESA arma, el disparo de
//     un bot se valida contra su `w` replicado, una recogida solo vale para su
//     arma, la bazooka de bot respeta cargador y recarga, y un frag rechazado
//     no consume horario.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { TUNING } from '../src/config/tuning.js';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8843;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    SPECIAL_FIRST_WEAPON: 'bazooka', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
});
let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails.push(name); };

const history = [];
let ws;
const send = (m) => ws.send(JSON.stringify(m));
const count = (pred) => history.filter(pred).length;
try {
  for (let i = 0; i < 80 && !log.includes('BREACH server'); i++) await wait(50);
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('message', (raw) => { try { history.push(JSON.parse(raw)); } catch { /* */ } });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  send({ t: 'join', action: 'create', name: 'HOST', v: 0 });
  await wait(200);
  const me = history.find((m) => m.t === 'welcome');
  send({ t: 'lobbyBotAdd', team: me.team === 'red' ? 'blue' : 'red' });
  await wait(200);
  send({ t: 'lobbyStart' });
  for (let i = 0; i < 300 && !history.find((m) => m.t === 'snap' && m.phase === 'playing'); i++) await wait(50);
  const snap = history.find((m) => m.t === 'snap' && m.phase === 'playing');
  const bot = snap.ps.find((p) => p.bot);
  const self = snap.ps.find((p) => p.id === me.id);
  await wait(5300); // protección de spawn

  // ---- bot: postura difundida estable y disparos al aire libre
  const bx = bot.x, bz = bot.z;
  let botW = 'smg';
  const botState = () => send({ t: 'botState', bots: [{ id: bot.id, x: bx, y: 0, z: bz, yaw: 0, st: 'idle', aim: 1, p: 0, ae: 0, cl: 0, ce: 1, w: botW, sp: 0 }] });
  const keep = setInterval(botState, 50);
  await wait(400);
  const botShot = (w, k) => send({ t: 'botFire', id: bot.id, o: [bx, 1.35, bz], p: [bx + 0.01 * k, 1.35, bz - 15], w });
  const echoes = () => count((m) => m.t === 'fire' && m.id === bot.id);
  const mag = TUNING.weapons.smg.mag;
  let e0 = echoes();
  for (let k = 0; k < mag; k++) { botShot('smg', k); await wait(110); }
  await wait(150);
  check(`bot: un cargador entero (${mag}) aceptado`, echoes() - e0 === mag, `${echoes() - e0}`);
  e0 = echoes(); botShot('smg', 99); await wait(250);
  check('bot: el tiro 51 sin pausa de recarga se rechaza', echoes() === e0);
  await wait(TUNING.weapons.smg.reloadTime * 1000);
  e0 = echoes(); botShot('smg', 100); await wait(250);
  check('bot: tras el tiempo de recarga vuelve a disparar', echoes() === e0 + 1);
  // cambio de arma sin evidencia replicada
  await wait(700);
  e0 = echoes(); botShot('shotgun', 101); await wait(250);
  check('bot: escopeta sin que su `w` replicado haya cambiado → rechazado', echoes() === e0);
  botW = 'shotgun'; await wait(300);
  e0 = echoes(); botShot('shotgun', 102); await wait(250);
  check('bot: con el cambio replicado y el gesto cumplido → aceptado', echoes() === e0 + 1);
  // (b) el mensaje de disparo trae OTRA arma que la replicada: se valida
  // contra botState, el mensaje no la cambia
  botW = 'smg'; await wait(300);
  e0 = echoes(); botShot('smg', 103); await wait(250);
  check('bot: vuelta a la SMG publicada → aceptado', echoes() === e0 + 1);
  botW = 'shotgun'; await wait(300);
  e0 = echoes(); botShot('smg', 104); await wait(250);
  check('bot: botFire SMG con escopeta replicada → rechazado', echoes() === e0);
  // (a) recogida NO relacionada: el bot recoge la especial y dispara al
  // instante con otra arma (sin estado nuevo de por medio)
  clearInterval(keep);
  const spot = MAP_RUNTIME.fortaleza.special;
  send({ t: 'botState', bots: [{ id: bot.id, x: spot.x, y: 0, z: spot.z, yaw: 0, st: 'idle', aim: 1, p: 0, ae: 0, cl: 0, ce: 1, w: 'shotgun', sp: 0 }] });
  await wait(250);
  send({ t: 'takeSpecial', bot: bot.id }); await wait(60);
  const taken = history.find((m) => m.t === 'specialTaken' && m.id === bot.id);
  check('bot toma la bazooka', taken?.wep === 'bazooka', JSON.stringify(taken));
  e0 = echoes();
  send({ t: 'botFire', id: bot.id, o: [spot.x, 1.35, spot.z], p: [spot.x, 1.35, spot.z - 15], w: 'shotgun' });
  await wait(250);
  check('bot: recoger la bazooka no autoriza un tiro inmediato de escopeta', echoes() === e0);
  // (c) cohete con el instante de cambio de un arma de fuego
  const sx = spot.x, sz = spot.z;
  botW = 'shotgun';
  const keep2 = setInterval(() => send({ t: 'botState', bots: [{ id: bot.id, x: sx, y: 0, z: sz, yaw: 0, st: 'idle', aim: 1, p: 0, ae: 0, cl: 0, ce: 1, w: botW, sp: 0 }] }), 50);
  await wait(400);
  const botRocket = (cid) => send({ t: 'rocket', bot: bot.id, cid, o: [sx, 1.35, sz], d: [0, 0, -1] });
  botRocket('b:w1'); await wait(250);
  check('bot: cohete con la escopeta replicada → rechazado', !!history.find((m) => m.t === 'rocketReject' && m.cid === 'b:w1'));
  botW = 'bazooka'; await wait(300);
  botRocket('b:ok1'); await wait(250);
  check('bot: cohete con la bazooka replicada → aceptado', !!history.find((m) => m.t === 'rocketAck' && m.cid === 'b:ok1'));
  // (e) bazooka de bot: cargador de 1, recarga 2.3 s (la cadencia permite 1.76 s)
  await wait(1800);
  botRocket('b:mag'); await wait(150);
  check('bot: segundo cohete sin el tiempo de recarga → rechazado', !!history.find((m) => m.t === 'rocketReject' && m.cid === 'b:mag'));
  await wait(TUNING.weapons.bazooka.reloadTime * 1000 - 1700);
  botRocket('b:ok2'); await wait(250);
  check('bot: cohete tras la recarga → aceptado', !!history.find((m) => m.t === 'rocketAck' && m.cid === 'b:ok2'));
  clearInterval(keep2);

  // ---- jugador: humo con el instante de cambio de un arma de fuego
  let w = 'smg';
  const px = self.x, pz = self.z;
  const state = (x = px, z = pz) => send({ t: 's', x, y: 0, z, yaw: 0, st: 'idle', aim: 0, p: 0, w, am: 50, ar: 150, sp: 0 });
  state(); await wait(300);
  // (d) primer lanzamiento de la vida con OTRA arma equipada → rechazado
  send({ t: 'nade', cid: 'n:first', o: [px, 1.4, pz], v: [0, 3, -8] }); await wait(200);
  check('humo como primera acción con la SMG equipada → rechazado', !!history.find((m) => m.t === 'nadeReject' && m.cid === 'n:first'));
  const myFires = () => count((m) => m.t === 'fire' && m.id === me.id);
  let f0 = myFires();
  send({ t: 'fire', w: 'smg', o: [px, 1.1, pz], p: [px, 1.1, pz - 10], d: [] }); await wait(150);
  check('jugador: SMG aceptada', myFires() === f0 + 1);
  w = 'shotgun'; state(); await wait(300);
  const nade = (cid) => send({ t: 'nade', cid, o: [px, 1.4, pz], v: [0, 3, -8] });
  nade('n:wrong'); await wait(200);
  check('humo con el instante de cambio de la escopeta → rechazado', !!history.find((m) => m.t === 'nadeReject' && m.cid === 'n:wrong'));
  w = 'grenade'; state(); await wait(300);
  nade('n:ok'); await wait(200);
  check('humo con la granada replicada → aceptado', !!history.find((m) => m.t === 'nadeAck' && m.cid === 'n:ok'));
  // (d) cambiar a otra arma SIN disparar y volver a lanzar: el arma equipada manda
  w = 'smg'; state(); await wait(TUNING.weapons.grenade && 1600);
  nade('n:away'); await wait(200);
  check('humo con la SMG equipada tras cambiar sin disparar → rechazado', !!history.find((m) => m.t === 'nadeReject' && m.cid === 'n:away'));

  // ---- jugador: frag rechazado por el motor no consume horario
  const ps = history.filter((m) => m.t === 'protoState').at(-1);
  const pick = ps?.pickups?.find((p) => p.kind === 'frag' && p.count > 0);
  check('hay un pickup de frag', !!pick);
  if (pick) {
    w = 'smg'; state(pick.x, pick.z); await wait(200);
    send({ t: 'protoClaim', id: pick.id, manual: true }); await wait(250);
    w = 'frag'; state(pick.x, pick.z); await wait(300);
    const inv = () => history.filter((m) => m.t === 'protoInventory' && m.kind === 'frag').at(-1)?.count;
    const before = inv();
    send({ t: 'protoFire', kind: 'frag', o: [pick.x + 9, 1, pick.z], d: [0, 0, -1] }); // origen ilegal
    await wait(200);
    check('frag con origen ilegal: rechazado, sin gastar', inv() === before, `${before}→${inv()}`);
    send({ t: 'protoFire', kind: 'frag', o: [pick.x, (pick.y || 0) + 1.2, pick.z], d: [0, 0, -1] });
    await wait(250);
    check('frag válido justo después del rechazado → aceptado', inv() === before - 1, `${before}→${inv()}`);
  }
} finally {
  ws?.close(); server.kill();
}
if (fails.length) { console.error(`BOT AMMO/SWAP FAILED (${fails.length})`); process.exit(1); }
console.log('BOT AMMO/SWAP OK — cargador de bots, cambio replicado y cohetes bajo la misma regla');
