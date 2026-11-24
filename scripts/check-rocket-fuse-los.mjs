// Espoleta AUTORITATIVA con línea de vista (paridad con special.js offline):
// un cohete que pasa junto a un muro fino no detona sobre el torso que está
// DETRÁS del muro; el mismo paso con el torso a la vista sí detona.
// Fortaleza: el cohete corre a lo largo de x=−22.3; un muro separa el paso
// del torso en x=−21.7 (0.6 m); del otro lado, x=−22.9 queda a la vista.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';
import { freePort, launchAt } from './lib-test.mjs';
import { withSamples } from './lib-fps-sample.mjs';
// PRUEBAS (ronda 2 de RED): cada fire/rocket/nade/protoFire humano lleva su muestra `fs`
// (n creciente, w = arma equipada) desde el último estado `s` de ese emisor
const SAMPLED = withSamples((peer, m) => peer.ws.send(JSON.stringify(m)));

// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = FREE_PORT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    SPECIAL_FIRST_WEAPON: 'bazooka', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
});
let log = '';
server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });

function peer() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`), msgs = [], waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  return {
    ws, msgs, open: () => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }),
    send(m) { SAMPLED(this, m); },
    next: (pred, ms = 3000) => new Promise((res) => {
      const prior = msgs.find(pred); if (prior) return res(prior);
      const w = { pred, res }; waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, ms);
    }),
  };
}
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails.push(name); };
const state = (p, x, z, w = 'smg', yaw = 0, pitch = 0) => p.send({ t: 's', x, y: 0, z, yaw, st: 'idle', aim: 0, p: pitch, w, am: 1, ar: 2, sp: 0 });

let a, b;
try {
  for (let i = 0; i < 80 && !log.includes('BREACH server'); i++) await wait(50);
  a = peer(); b = peer(); await a.open(); await b.open();
  a.send({ t: 'join', action: 'create', name: 'LOS-A', v: 0, hp: 2, fps: 1 });
  const aw = await a.next((m) => m.t === 'welcome');
  b.send({ t: 'join', action: 'join', name: 'LOS-B', v: 0, hp: 2, fps: 1 });
  const bw = await b.next((m) => m.t === 'welcome');
  a.send({ t: 'lobbyStart' });
  await a.next((m) => m.t === 'start', 6000);
  await wait(5200); // protección de spawn
  const spot = MAP_RUNTIME.fortaleza.special;
  state(a, spot.x, spot.z); await wait(100);
  a.send({ t: 'takeSpecial' });
  check('bazooka tomada', !!(await a.next((m) => m.t === 'specialTaken' && m.id === aw.id && m.wep === 'bazooka')));

  const shoot = async (bx, label) => {
    // PRUEBAS (corrida 6): la salida FPS va a la altura del ojo; se apunta un poco hacia
    // abajo para que el cohete pase a la altura del pecho (1.1 m) junto al torso, como antes
    const L0 = launchAt(-22.3, 0, -27.5, Math.PI);
    const pitch = Math.atan2(1.1 - L0.o[1], Math.abs(-22 - L0.o[2]));
    state(a, -22.3, -27.5, 'bazooka', Math.PI, pitch); state(b, bx, -22); await wait(150);
    a.msgs.length = 0;
    { const L = launchAt(-22.3, 0, -27.5, Math.PI, { pitch }); a.send({ t: 'rocket', cid: label, o: L.o, d: L.d }); }
    const ack = await a.next((m) => m.t === 'rocketAck' && m.cid === label);
    return ack && a.next((m) => m.t === 'rocketBoom' && m.rid === ack.rid, 6000);
  };
  // torso a 0.6 m del paso, DETRÁS del muro: no hay detonación directa
  const hidden = await shoot(-21.7, 'hidden');
  check('torso detrás del muro fino: sin detonación directa',
    !!hidden && !(hidden.direct && hidden.target === bw.id), JSON.stringify(hidden && { kind: hidden.kind, target: hidden.target, p: hidden.p }));
  await wait(2300);
  // control: mismo 0.55 m, del lado abierto
  const open = await shoot(-22.9, 'open');
  check('torso a la vista a la misma distancia: detonación directa',
    !!open && open.direct === 1 && open.target === bw.id, JSON.stringify(open && { kind: open.kind, target: open.target }));
} finally {
  a?.ws.close(); b?.ws.close(); server.kill();
}
if (fails.length) { console.error(`ROCKET FUSE LOS FAILED (${fails.length})`); process.exit(1); }
console.log('ROCKET FUSE LOS OK — la espoleta autoritativa exige ver el torso');
