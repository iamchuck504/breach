// ADS online: el rango y el falloff se miden desde el PLANO del tirador
// (pecho), no desde la cámara que va ~2.2 m por detrás. El cliente ya lo hacía;
// el servidor medía desde la cámara: descartaba el disparo entero cuando el
// último perdigón llegaba al alcance máximo hacia cielo abierto (aunque otros
// perdigones hubieran pegado) y aplicaba menos daño que el que el jugador vio.
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TUNING } from '../src/config/tuning.js';
import { firearmDamage } from '../src/combat/damage.js';
import { adsSetback, shooterPlaneDistance } from '../src/combat/shooter-plane.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8833;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
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
const send = (peer, msg) => peer.ws.send(JSON.stringify(msg));
const hpOf = (snap, id) => snap.ps.find((p) => p.id === id)?.hp;
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const SG = TUNING.weapons.shotgun;
const SETBACK = 2.2; // cámara ADS a nivel, medida por la auditoría
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
  const chest = { x: bx, y: 0, z: az, yaw: Math.PI, aim: 1, p: 0 };
  // el servidor toma aim/pitch del ESTADO del tirador (campo `aim`), no del disparo
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
  const cam0 = () => [bx, 1.6, az - SETBACK];

  // 0) un disparo RECHAZADO (dentro de la cadencia) no puede dejar su claim
  // colgado del disparo anterior, que no pegó a nadie
  send(a, { t: 'fire', w: 'shotgun', o: cam0(), p: [bx + 1.2, 1.4, bz + 6], d: [], fp: ADS, sq: 1 });
  await delay(40);
  send(a, { t: 'fire', w: 'shotgun', o: cam0(), p: [bx, 1.2, bz + 4], d: [], fp: ADS, sq: 2 });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 3, p: torso, sq: 2 });
  check('claim de un disparo rechazado: sin daño', (await readHp()) === 100);
  await cooldown();

  // 1) ADS con la cámara 2.2 m detrás: el último perdigón llega a cielo
  // abierto al alcance máximo del cliente (rango + retroceso desde la cámara)
  const cam = [bx, 1.6, az - SETBACK];
  const up = 8 * Math.PI / 180;
  const reach = SG.range + SETBACK - 0.05;
  const endpoint = [bx, cam[1] + Math.sin(up) * reach, cam[2] + Math.cos(up) * reach];
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: endpoint, d: [], fp: ADS });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 3, p: torso });
  check('ADS: el servidor acepta el disparo cuyo último perdigón llega al alcance máximo', await echo());
  let hp = await readHp();
  const planeAds = shooterPlaneDistance(cam, torso, adsSetback(chest, cam));
  let expected = Math.round(hpB - firearmDamage(SG, planeAds, 'body', 3));
  check('ADS: el impacto parcial aplica el daño que vio el tirador (plano del pecho)',
    Math.abs(hp - expected) <= 1, `hp=${hp} esperado=${expected} (plano ${planeAds.toFixed(2)} m)`);
  hpB = hp;

  // 2) HIP declarando un origen 2.2 m por detrás: sin pose ADS no hay
  // retroceso de cámara que descontar. Más allá del rango → rechazado; dentro,
  // el daño se mide desde el origen declarado.
  // (el historial de ADS dura 300 ms: se espera a que salga)
  await cooldown(); await withState(0, 0); await delay(350);
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: endpoint, d: [], fp: HIP });
  check('HIP con origen desplazado: no gana alcance', !(await echo()));
  await cooldown();
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: [bx, 1.2, bz + 4], d: [], fp: HIP });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 2, p: torso });
  await echo();
  hp = await readHp();
  const raw = Math.hypot(...torso.map((v, i) => v - cam[i]));
  expected = Math.round(hpB - firearmDamage(SG, raw, 'body', 2));
  check('HIP con origen desplazado: el falloff no se reduce', Math.abs(hp - expected) <= 1,
    `hp=${hp} esperado=${expected} (desde el origen ${raw.toFixed(2)} m)`);
  hpB = hp;

  // 3) ADS con un origen 2.5 m al costado: no es una cámara plausible
  // el ADS solo en el HISTORIAL (el estado actual ya soltó el apuntado al
  // disparar): el crédito sale de las poses recientes. Falla si alguien vuelve
  // a mezclar el reloj epoch con el monótono del historial.
  await cooldown(); await withState(1, 0);
  await delay(120); // al menos un snapshot con aim=1 en el historial
  aimState(0, 0);
  await delay(20);
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: endpoint, d: [], fp: ADS });
  check('ADS solo en el historial reciente: conserva el crédito al límite del alcance', await echo());

  // el bit ADS del propio disparo no basta: con el estado en hip, sin crédito
  await cooldown(); await withState(0, 0); await delay(350); // historial sin ADS
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: endpoint, d: [], fp: ADS });
  check('fp.a=1 con el estado en hip: no gana alcance', !(await echo()));
  // cámara real a −30° (mirando abajo): sube por encima del pecho y sigue
  // siendo plausible; el último perdigón a rango + crédito se acepta
  await cooldown();
  const down = -30 * Math.PI / 180;
  await withState(1, down);
  const camDown = [bx, 1.6 * 0.92 - Math.sin(down) * SETBACK, az - Math.cos(down) * SETBACK];
  const cD = adsSetback({ ...chest, p: down }, camDown);
  const dirDown = [0, Math.sin(down), Math.cos(down)];
  const reachDown = SG.range + (cD ? Math.min(3, cD[1] * dirDown[1] + cD[2] * dirDown[2]) : 0) + 1.9;
  send(a, { t: 'fire', w: 'shotgun', o: camDown, p: camDown.map((v, i) => v + dirDown[i] * reachDown), d: [], fp: ADS });
  check('ADS a −30°: la cámara real conserva el crédito', !!cD && await echo(),
    `crédito ${cD ? (cD[1] * dirDown[1] + cD[2] * dirDown[2]).toFixed(2) : 'ninguno'} m`);
  await cooldown(); await withState(1, 0);
  const side = [bx - 2.5, 1.6, az - SETBACK];
  hpB = await readHp(); // la vida se regenera durante las esperas
  send(a, { t: 'fire', w: 'shotgun', o: side, p: [bx, 1.2, bz + 4], d: [], fp: ADS });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 3, p: torso });
  await echo();
  hp = await readHp();
  const rawSide = Math.hypot(...torso.map((v, i) => v - side[i]));
  expected = Math.round(hpB - firearmDamage(SG, rawSide, 'body', 3));
  check('ADS con origen lateral: sin descuento de cámara', Math.abs(hp - expected) <= 1,
    `hp=${hp} esperado=${expected} (desde el origen ${rawSide.toFixed(2)} m)`);
  hpB = hp;

  // 4) claim a 19° del perdigón registrado (cámara de hombro real, 1.08 m):
  // la distancia del remate es la de SU dirección, no la del perdigón
  await cooldown();
  const shoulder = [bx + 1.08, 1.6, az - SETBACK];
  const u = torso.map((v, i) => v - shoulder[i]); const ul = Math.hypot(...u);
  const ang = 19 * Math.PI / 180;
  const reg = [(u[0] * Math.cos(ang) + u[2] * Math.sin(ang)) / ul, u[1] / ul, (-u[0] * Math.sin(ang) + u[2] * Math.cos(ang)) / ul];
  const regEnd = shoulder.map((v, i) => v + reg[i] * 15);
  send(a, { t: 'fire', w: 'shotgun', o: shoulder, p: regEnd, d: [], fp: ADS });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 8, p: torso });
  const death = await waitFor(a, (m) => m.t === 'death' && m.target === b.welcome.id, 1500).catch(() => null);
  const c = adsSetback(chest, shoulder);
  const perClaim = shooterPlaneDistance(shoulder, torso, c);
  const reused = ul - Math.max(0, Math.min(3, c[0] * reg[0] + c[1] * reg[1] + c[2] * reg[2]));
  check('claim a 19°: distancia por perdigón (convención compartida)',
    death && Math.abs(death.dist - perClaim) < 0.02,
    `servidor=${death?.dist} por-claim=${perClaim.toFixed(2)} reutilizando el registrado=${reused.toFixed(2)}`);

  // Contrato que se mantiene: más allá de rango + tolerancia desde el plano, se rechaza.
  await cooldown();
  const far = SG.range + SETBACK + 2.6;
  send(a, { t: 'fire', w: 'shotgun', o: cam, p: [bx, cam[1], cam[2] + far], d: [], fp: ADS });
  check('un endpoint más allá del alcance sigue rechazado', !(await echo()));
} finally {
  a?.ws.close(); b?.ws.close();
  server.kill();
}
if (fails.length) { console.error(`ADS RANGE FAILED (${fails.length})`); process.exit(1); }
console.log('ADS RANGE OK — rango y falloff desde el plano del tirador');
