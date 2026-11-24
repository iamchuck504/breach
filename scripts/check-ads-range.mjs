// ADS online. Corrida 6 (FPS): el disparo sale del OJO y el servidor exige el
// origen a ≤0.4 m de la cabeza del tirador; el crédito por cámara retrasada
// (aimedSetback, shooter-plane.js) ya no existe para clientes FPS. Antes esta
// prueba fijaba ese crédito (rango y falloff desde el plano del pecho con la
// cámara 2.2 m detrás); ahora fija lo contrario: desde el ojo, rango y falloff
// son la distancia real, la cámara de hombro se rechaza (en ADS y en cadera) y
// el alcance no crece por apuntar. Se conservan: claim de un disparo
// rechazado sin daño, distancia por perdigón (convención compartida) y
// endpoint más allá del alcance rechazado.
import { WebSocket } from 'ws';
import { withSamples, nextN } from './lib-fps-sample.mjs';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNING } from '../src/config/tuning.js';
import { firearmDamage } from '../src/combat/damage.js';
import { shooterPlaneDistance } from '../src/combat/shooter-plane.js';
import { eyeWorld } from '../src/combat/hit-pose.js';
import { freePort } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = FREE_PORT;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' }, stdio: 'ignore',
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(name, action) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = { ws, welcome: null, messages: [], waiters: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', action, name, v: 0, hp: 2, fps: 1 })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'welcome' && !peer.welcome) { peer.welcome = msg; resolve(peer); }
      peer.messages.push(msg);
      for (const w of [...peer.waiters]) if (w.pred(msg)) { peer.waiters.splice(peer.waiters.indexOf(w), 1); w.resolve(msg); }
    });
  });
}
function waitFor(peer, pred, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    peer.waiters.push(w);
    setTimeout(() => { const i = peer.waiters.indexOf(w); if (i >= 0) { peer.waiters.splice(i, 1); reject(new Error('timeout')); } }, timeout);
  });
}
// muestra `fs` obligatoria (ronda 2): la añade lib-fps-sample desde el último estado
const send = withSamples((peer, msg) => peer.ws.send(JSON.stringify(msg)));
const hpOf = (snap, id) => snap.ps.find((p) => p.id === id)?.hp;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const SG = TUNING.weapons.shotgun;
const SETBACK = 2.2; // cámara de hombro ADS de la tercera persona
const ADS = { st: 'idle', a: 1, p: 0, ae: 0, cl: 0, ce: 1 };
const HIP = { ...ADS, a: 0 };
let a, b;
try {
  await delay(700);
  a = await connect('ADS-A', 'create');
  b = await connect('ADS-B', 'join');
  send(a, { t: 'lobbyStart' });
  await waitFor(a, (m) => m.t === 'matchStart');
  await delay(300);
  // carril libre de Fortaleza (el mismo de check-online-fire); A mira a +z
  const bx = 3, bz = -2, gap = 6;
  const az = bz - gap;
  const aimState = (aim, p) => send(a, { t: 's', x: bx, z: az, y: 0, yaw: Math.PI, st: 'idle', aim, p,
    w: 'shotgun', am: 8, ar: 24 });
  const withState = async (aim, p) => { aimState(aim, p); await delay(120); };
  const stand = () => {
    send(b, { t: 's', x: bx, z: bz, y: 0, yaw: Math.PI, st: 'idle', w: 'smg', am: 50, ar: 150 });
    aimState(1, 0);
  };
  stand();
  await delay(5300); // fin de la protección de spawn
  stand();
  await delay(150);
  const torso = [bx, 1.0, bz];
  let hpB = 100;
  const readHp = async () => { await delay(120); a.messages.length = 0; return hpOf(await waitFor(a, (m) => m.t === 'snap'), b.welcome.id); };
  const echo = () => waitFor(b, (m) => m.t === 'fire' && m.id === a.welcome.id, 600).then(() => true, () => false);
  const cooldown = () => delay(Math.ceil(60 / SG.rpm * 1000) + 80);
  // ojo del tirador en ADS (el mismo cálculo que la cámara FPS)
  const eye = (aim = true, p = 0) => eyeWorld({ st: 'idle', aim, wep: 'shotgun', pitch: p }, bx, 0, az, Math.PI).map((v) => +v.toFixed(2));
  const cam = [bx, 1.6, az - SETBACK];
  const up = 8 * Math.PI / 180;

  // 0) un disparo RECHAZADO (dentro de la cadencia) no puede dejar su claim
  // colgado del disparo anterior, que no pegó a nadie
  send(a, { t: 'fire', w: 'shotgun', o: eye(), p: [bx + 1.2, 1.4, bz + 6], d: [], fp: ADS, sq: 1 });
  await delay(40);
  send(a, { t: 'fire', w: 'shotgun', o: eye(), p: [bx, 1.2, bz + 4], d: [], fp: ADS, sq: 2 });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 3, p: torso, sq: 2 });
  check('claim de un disparo rechazado: sin daño', (await readHp()) === 100);
  await cooldown();

  // 1) ADS desde el ojo: el último perdigón llega a cielo abierto al alcance
  // máximo (rango + la tolerancia de 2 m de siempre), el impacto parcial
  // aplica el daño de la distancia REAL desde el ojo
  // escopeta FPS (auditoría): `p` es el EJE CENTRAL del cartucho; el eje va
  // al torso y su extremo llega al alcance máximo; los perdigones reclamados
  // caben en el cono del estado (ADS)
  const o1 = eye(), reach = SG.range + 1.9;
  const axis = torso.map((v, i) => v - o1[i]), al = Math.hypot(...axis);
  const endpoint = o1.map((v, i) => v + axis[i] / al * reach);
  send(a, { t: 'fire', w: 'shotgun', o: o1, p: endpoint, d: [], fp: ADS });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 3, p: torso });
  check('ADS desde el ojo: se acepta el disparo cuyo último perdigón llega al alcance', await echo());
  let hp = await readHp();
  const raw1 = Math.hypot(...torso.map((v, i) => v - o1[i]));
  let expected = Math.round(hpB - firearmDamage(SG, raw1, 'body', 3));
  check('ADS desde el ojo: falloff por la distancia real (sin crédito de cámara)',
    Math.abs(hp - expected) <= 1 && Math.abs(shooterPlaneDistance(o1, torso, null) - raw1) < 1e-9, `hp=${hp} esperado=${expected} (${raw1.toFixed(2)} m)`);
  hpB = hp;

  // 2) la cámara de hombro (2.2 m detrás) ya no es un origen: rechazada en
  // ADS y en cadera, aunque el endpoint esté dentro del alcance
  await cooldown();
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: [bx, 1.2, bz + 4], d: [], fp: ADS });
  check('ADS con origen en la cámara de hombro: rechazado', !(await echo()));
  await cooldown(); await withState(0, 0);
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: [bx, 1.2, bz + 4], d: [], fp: HIP });
  check('cadera con origen en la cámara de hombro: rechazado', !(await echo()));
  // y su alcance de antes (rango + 2.2 desde la cámara) tampoco desde el ojo
  await cooldown(); await withState(1, 0);
  const far = SG.range + SETBACK;
  send(a, { t: 'fire', w: 'shotgun', o: eye(), p: [bx, o1[1] + Math.sin(up) * far, o1[2] + Math.cos(up) * far], d: [], fp: ADS });
  check('ADS desde el ojo: el alcance no gana el retroceso de cámara', !(await echo()));

  // 3) mirando abajo (−30°): el ojo sigue dentro de la cabeza y vale
  await cooldown();
  const down = -30 * Math.PI / 180;
  await withState(1, down);
  const oD = eye(true, down), dirDown = [0, Math.sin(down), Math.cos(down)];
  send(a, { t: 'fire', w: 'shotgun', o: oD, p: oD.map((v, i) => v + dirDown[i] * 2.5), d: [], fp: { ...ADS, p: down } });
  check('ADS a −30° desde el ojo: aceptado', await echo());
  await cooldown(); await withState(1, 0);

  // 4) claim a 19° del perdigón registrado: la distancia del remate es la de
  // SU dirección desde el origen (convención compartida por perdigón)
  await cooldown();
  hpB = await readHp();
  const o4 = eye();
  const u = torso.map((v, i) => v - o4[i]); const ul = Math.hypot(...u);
  // claim a 4° del eje (dentro del cono ADS del peor caso + 2°)
  const ang = 4 * Math.PI / 180;
  const reg = [(u[0] * Math.cos(ang) + u[2] * Math.sin(ang)) / ul, u[1] / ul, (-u[0] * Math.sin(ang) + u[2] * Math.cos(ang)) / ul];
  const regEnd = o4.map((v, i) => v + reg[i] * 15);
  send(a, { t: 'fire', w: 'shotgun', o: o4, p: regEnd, d: [], fp: ADS });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 8, p: torso });
  const death = await waitFor(a, (m) => m.t === 'death' && m.target === b.welcome.id, 1500).catch(() => null);
  const perClaim = shooterPlaneDistance(o4, torso, null);
  check('claim a 4° del eje: distancia por perdigón desde el ojo',
    death && Math.abs(death.dist - perClaim) < 0.02, `servidor=${death?.dist} por-claim=${perClaim.toFixed(2)}`);

  // Contrato que se mantiene: más allá de rango + tolerancia, se rechaza.
  await cooldown();
  const beyond = SG.range + 2.6;
  send(a, { t: 'fire', w: 'shotgun', o: eye(), p: [bx, o1[1], o1[2] + beyond], d: [], fp: ADS });
  check('un endpoint más allá del alcance sigue rechazado', !(await echo()));
} finally {
  a?.ws.close(); b?.ws.close();
  server.kill();
}
if (fails.length) { console.error(`ADS RANGE FAILED (${fails.length})`); process.exit(1); }
console.log('ADS RANGE OK — FPS: rango y falloff desde el ojo, sin crédito de cámara');
