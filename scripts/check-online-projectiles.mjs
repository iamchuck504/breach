// Protocolo online de proyectiles no-hitscan: el servidor debe retransmitir
// cohetes y humo a los OTROS clientes, validar su origen y evitar spam.
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = 8806;
const URL = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Peer {
  constructor(name) {
    this.name = name;
    this.history = [];
    this.waiters = [];
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      this.history.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (msg.t !== w.type || !w.predicate(msg)) continue;
        this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  next(type, predicate = () => true, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`${this.name}: timeout esperando ${type}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  count(type, predicate = () => true) {
    return this.history.filter((m) => m.t === type && predicate(m)).length;
  }

  close() { this.ws?.close(); }
}

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    INTRO_TIME: '0.05',
    COUNTDOWN_TIME: '0.05',
    SPECIAL_FIRST_WEAPON: 'bazooka',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += String(d); });
server.stderr.on('data', (d) => { serverLog += String(d); });
for (let i = 0; i < 50 && !serverLog.includes('BREACH server'); i++) await wait(50);
if (!serverLog.includes('BREACH server')) {
  server.kill();
  throw new Error(`el servidor no inició\n${serverLog}`);
}

const a = new Peer('ALFA');
const b = new Peer('BRAVO');
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures.push(name);
};

try {
  await a.open();
  let welcomeP = a.next('welcome');
  a.send({ t: 'join', action: 'create', name: 'ALFA', v: 0 });
  const aw = await welcomeP;

  await b.open();
  welcomeP = b.next('welcome');
  b.send({ t: 'join', action: 'join', name: 'BRAVO', v: 0 });
  const bw = await welcomeP;

  // Dos bots permiten probar que el host puede anunciar sus proyectiles sin
  // convertir el mensaje `bot` en una vía para clientes normales.
  let lobbyP = a.next('lobby', (m) => m.bots?.length === 1);
  a.send({ t: 'lobbyBotAdd', team: 'red' });
  await lobbyP;
  lobbyP = a.next('lobby', (m) => m.bots?.length === 2);
  a.send({ t: 'lobbyBotAdd', team: 'blue' });
  const lobby = await lobbyP;
  const hostedBot = lobby.bots.find((bot) => bot.team === 'red');

  const starts = [a.next('start'), b.next('start')];
  a.send({ t: 'lobbyStart' });
  await Promise.all(starts);

  // P1 recoge la bazooka de la primera ronda y anuncia el vuelo. El remitente
  // no recibe eco (ya la simuló); P2 sí recibe origen y dirección normalizada.
  a.send({ t: 's', x: 2.8, y: 0, z: 0, yaw: 0, st: 'idle', w: 'smg' });
  await wait(80);
  const takenP = b.next('specialTaken', (m) => m.id === aw.id && m.wep === 'bazooka');
  a.send({ t: 'takeSpecial' });
  await takenP;
  a.send({ t: 's', x: 2.8, y: 0, z: 0, yaw: 0, st: 'idle', w: 'bazooka' });
  await wait(80);

  const rocketP = b.next('rocket', (m) => m.id === aw.id);
  a.send({ t: 'rocket', o: [2.8, 1.25, 0], d: [0, 0, -1] });
  const rocket = await rocketP;
  check('el otro cliente recibe el vuelo de la bazooka',
    rocket.id === aw.id && Math.abs(Math.hypot(...rocket.d) - 1) < 0.001,
    JSON.stringify(rocket));
  await wait(120);
  check('el tirador no recibe un cohete duplicado', a.count('rocket', (m) => m.id === aw.id) === 0);

  // Un jugador sin bazooka no puede inventar el proyectil.
  const invalidRocketCount = a.count('rocket', (m) => m.id === bw.id);
  b.send({ t: 'rocket', o: [0, 1.2, 0], d: [0, 0, -1] });
  await wait(180);
  check('el servidor rechaza cohetes sin bazooka',
    a.count('rocket', (m) => m.id === bw.id) === invalidRocketCount);

  // Humo humano: origen imposible rechazado; dos cargas válidas por vida;
  // una tercera queda bloqueada aunque respete la cadencia.
  b.send({ t: 's', x: 0, y: 0, z: 0, yaw: 0, st: 'idle', w: 'grenade' });
  await wait(80);
  let nadeCount = a.count('nade', (m) => m.id === bw.id);
  b.send({ t: 'nade', o: [40, 1.2, 40], v: [0, 4, -12] });
  await wait(180);
  check('el servidor rechaza humo con origen inventado',
    a.count('nade', (m) => m.id === bw.id) === nadeCount);

  let nadeP = a.next('nade', (m) => m.id === bw.id);
  b.send({ t: 'nade', o: [0, 1.2, 0], v: [0, 4, -12] });
  await nadeP;
  b.send({ t: 'nade', o: [0, 1.2, 0], v: [0, 4, -12] });
  await wait(180);
  check('la cadencia bloquea spam de humo', a.count('nade', (m) => m.id === bw.id) === nadeCount + 1);

  await wait(1120);
  nadeP = a.next('nade', (m) => m.id === bw.id);
  b.send({ t: 'nade', o: [0, 1.2, 0], v: [0, 4, -12] });
  await nadeP;
  await wait(1120);
  nadeCount = a.count('nade', (m) => m.id === bw.id);
  b.send({ t: 'nade', o: [0, 1.2, 0], v: [0, 4, -12] });
  await wait(180);
  check('el servidor limita el humo a dos cargas por vida',
    a.count('nade', (m) => m.id === bw.id) === nadeCount);

  // El bot del host tiene una carga y la retransmisión identifica al bot, no
  // al host. El host queda excluido para no ver una segunda simulación.
  a.send({ t: 'botState', bots: [{ id: hostedBot.id, x: 0, y: 0, z: 0, yaw: 0, st: 'idle', w: 'smg' }] });
  await wait(80);
  const botNadeP = b.next('nade', (m) => m.id === hostedBot.id);
  a.send({ t: 'nade', bot: hostedBot.id, o: [0.4, 1.2, 0], v: [6, 3.36, 0] });
  const botNade = await botNadeP;
  check('el humo de bots online llega a los demás clientes', botNade.id === hostedBot.id);
  check('el host no duplica el humo de su bot', a.count('nade', (m) => m.id === hostedBot.id) === 0);
} finally {
  a.close();
  b.close();
  server.kill();
}

if (failures.length) {
  console.error(`ONLINE-PROJECTILES: ${failures.length} fallos → ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('ONLINE-PROJECTILES: todo verde');
