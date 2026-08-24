// La nube online nace y termina exclusivamente por decisión del servidor.
// El cliente solo propone origen/velocidad y puede predecir el mesh del bote.
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8812;
const URL = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Peer {
  constructor(name) { this.name = name; this.history = []; this.waiters = []; }
  async open() {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      this.history.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (msg.t !== w.type || !w.predicate(msg)) continue;
        this.waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve); this.ws.once('error', reject);
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  next(type, predicate = () => true, timeout = 4000) {
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1);
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

const proc = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), INTRO_TIME: '0.03', COUNTDOWN_TIME: '0.03',
    SMOKE_FUSE: '0.35', SMOKE_TIME: '0.3', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', (d) => { log += String(d); });
proc.stderr.on('data', (d) => { log += String(d); });
for (let i = 0; i < 50 && !log.includes('BREACH server'); i++) await wait(50);
if (!log.includes('BREACH server')) { proc.kill(); throw new Error(`server no inició\n${log}`); }

const a = new Peer('ALFA'), b = new Peer('BRAVO');
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures.push(name);
};

try {
  await a.open();
  let p = a.next('welcome');
  a.send({ t: 'join', action: 'create', name: 'ALFA', v: 0 });
  await p;
  await b.open();
  p = b.next('welcome');
  b.send({ t: 'join', action: 'join', name: 'BRAVO', v: 0 });
  const bw = await p;
  await Promise.all([a.next('start'), b.next('start')].map((promise, i) => {
    if (i === 0) a.send({ t: 'lobbyStart' });
    return promise;
  }));

  b.send({ t: 's', x: 10, y: 0, z: 10, yaw: 0, st: 'idle', w: 'grenade' });
  await wait(80);
  const cid = 'client-smoke-1';
  const ackP = b.next('nadeAck', (m) => m.cid === cid);
  const remoteP = a.next('nade', (m) => m.id === bw.id);
  b.send({ t: 'nade', cid, o: [10, 1.2, 10], v: [-5, 4, -6] });
  const [ack, remote] = await Promise.all([ackP, remoteP]);
  check('ack y réplica comparten id autoritativo',
    typeof ack.nid === 'string' && ack.nid === remote.nid,
    JSON.stringify({ ack, remote }));
  check('el tirador no recibe un segundo lanzamiento',
    b.count('nade', (m) => m.id === bw.id) === 0);

  // Un peer no puede fabricar una nube ni escoger su posición.
  const fakeBefore = a.count('smokeStart', (m) => m.nid === 'fake');
  b.send({ t: 'smokeStart', nid: 'fake', p: [50, 50, 50] });
  await wait(80);
  check('mensajes cliente smokeStart son ignorados',
    a.count('smokeStart', (m) => m.nid === 'fake') === fakeBefore);

  const startA = a.next('smokeStart', (m) => m.nid === ack.nid);
  const startB = b.next('smokeStart', (m) => m.nid === ack.nid);
  const [sa, sb] = await Promise.all([startA, startB]);
  check('todos reciben el mismo centro de humo',
    JSON.stringify(sa.p) === JSON.stringify(sb.p) && sa.p.every(Number.isFinite),
    JSON.stringify(sa.p));
  check('el servidor simuló la trayectoria antes de activar',
    Math.hypot(sa.p[0] - 10, sa.p[2] - 10) > 0.2 && sa.p[1] >= 0,
    JSON.stringify(sa.p));

  const endA = a.next('smokeEnd', (m) => m.nid === ack.nid);
  const endB = b.next('smokeEnd', (m) => m.nid === ack.nid);
  await Promise.all([endA, endB]);
  check('el servidor termina y limpia la nube para todos', true);

  const badCid = 'invalid-origin';
  const rejectP = b.next('nadeReject', (m) => m.cid === badCid);
  b.send({ t: 'nade', cid: badCid, o: [60, 1.2, 60], v: [0, 4, -8] });
  const rejected = await rejectP;
  check('lanzamiento inválido recibe rechazo correlacionado', rejected.cid === badCid);
} finally {
  a.close(); b.close(); proc.kill();
}

if (failures.length) {
  console.error(`SMOKE-AUTHORITY: ${failures.length} fallos → ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('SMOKE-AUTHORITY: todo verde');
