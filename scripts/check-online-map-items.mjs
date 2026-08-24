// Valida que la autoridad online use las mismas posiciones de pickups que el
// mapa visible. También comprueba que el arma especial no pueda reclamarse a
// distancia antes de aceptar el hold legítimo junto al pedestal.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { MAPS, MAP_RUNTIME } from '../src/game/lobby-rules.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8799;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: 'ignore',
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(700);

function nextMessage(ws, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timeout'));
    }, timeout);
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });
}

async function sendAndWait(ws, payload, predicate, timeout) {
  const pending = nextMessage(ws, predicate, timeout);
  ws.send(JSON.stringify(payload));
  return pending;
}

const failures = [];
try {
  for (const map of MAPS) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const welcome = await sendAndWait(ws, { t: 'join', action: 'create', name: `QA-${map}` }, (m) => m.t === 'welcome');
    await sendAndWait(ws, { t: 'lobbyBotAdd', team: 'blue' },
      (m) => m.t === 'lobby' && m.bots?.some((b) => b.team === 'blue'));
    await sendAndWait(ws, { t: 'lobbySettings', settings: { map } },
      (m) => m.t === 'lobby' && m.settings?.map === map);
    await sendAndWait(ws, { t: 'lobbyStart' }, (m) => m.t === 'start', 6000);

    const runtime = MAP_RUNTIME[map];
    const crate = runtime.crates[0];
    ws.send(JSON.stringify({ t: 's', x: crate.x, z: crate.z, y: 0, yaw: 0,
      st: 'idle', aim: 0, p: 0, w: 'smg', am: 1, ar: 0, sp: 0 }));
    const crateTaken = await sendAndWait(ws, { t: 'crate', i: 0 },
      (m) => m.t === 'crate' && m.i === 0 && m.up === 0).then(() => true, () => false);

    // Desde la caja (lejos del centro) el servidor debe ignorar el reclamo.
    let remoteTaken = false;
    const remoteListener = (raw) => {
      try { if (JSON.parse(raw).t === 'specialTaken') remoteTaken = true; } catch { /* ignore */ }
    };
    ws.on('message', remoteListener);
    ws.send(JSON.stringify({ t: 'takeSpecial' }));
    await wait(250);
    ws.off('message', remoteListener);

    // Sin haber ganado el pedestal, anunciar un sniper debe degradarse a SMG.
    const unauthorizedSnap = nextMessage(ws, (m) => m.t === 'snap' &&
      m.ps?.some((p) => p.id === welcome.id && p.w === 'smg'));
    ws.send(JSON.stringify({ t: 's', x: crate.x, z: crate.z, y: 0, yaw: 0,
      st: 'idle', aim: 0, p: 0, w: 'sniper', am: 1, ar: 5, sp: 0 }));
    const unauthorizedBlocked = await unauthorizedSnap.then(() => true, () => false);

    const special = runtime.special;
    ws.send(JSON.stringify({ t: 's', x: special.x, z: special.z, y: special.y, yaw: 0,
      st: 'idle', aim: 0, p: 0, w: 'smg', am: 1, ar: 0, sp: 0 }));
    const takenMessage = await sendAndWait(ws, { t: 'takeSpecial' },
      (m) => m.t === 'specialTaken').catch(() => null);
    const nearTaken = !!takenMessage;
    const authorizedSnap = nextMessage(ws, (m) => m.t === 'snap' &&
      m.ps?.some((p) => p.id === welcome.id && p.w === takenMessage?.wep));
    ws.send(JSON.stringify({ t: 's', x: special.x, z: special.z, y: special.y, yaw: 0,
      st: 'idle', aim: 0, p: 0, w: takenMessage?.wep || 'sniper', am: 1, ar: 5, sp: 0 }));
    const authorizedAccepted = await authorizedSnap.then(() => true, () => false);

    const ok = crateTaken && !remoteTaken && unauthorizedBlocked && nearTaken && authorizedAccepted;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${map} — crate=${crateTaken} remote=${remoteTaken} ` +
      `unauthorized=${unauthorizedBlocked} near=${nearTaken} authorized=${authorizedAccepted}`);
    if (!ok) failures.push(map);
    ws.close();
    await wait(120);
  }

  // Los bots online deben competir por el MISMO pickup autoritativo: el host
  // puede reclamar en su nombre, pero no conservar una copia para sí mismo.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await sendAndWait(ws, { t: 'join', action: 'create', name: 'QA-BOT' }, (m) => m.t === 'welcome');
  const botLobby = await sendAndWait(ws, { t: 'lobbyBotAdd', team: 'blue' },
    (m) => m.t === 'lobby' && m.bots?.length);
  const botId = botLobby.bots[0].id;
  await sendAndWait(ws, { t: 'lobbyStart' }, (m) => m.t === 'start', 6000);
  const spot = MAP_RUNTIME.fortaleza.special;
  ws.send(JSON.stringify({ t: 'botState', bots: [{ id: botId, x: spot.x, z: spot.z,
    y: spot.y, yaw: 0, st: 'idle', aim: 0, p: 0, w: 'smg', sp: 0 }] }));
  const botTaken = await sendAndWait(ws, { t: 'takeSpecial', bot: botId },
    (m) => m.t === 'specialTaken' && m.id === botId).catch(() => null);
  const botEquipped = nextMessage(ws, (m) => m.t === 'snap' &&
    m.ps?.some((p) => p.id === botId && p.w === botTaken?.wep));
  ws.send(JSON.stringify({ t: 'botState', bots: [{ id: botId, x: spot.x, z: spot.z,
    y: spot.y, yaw: 0, st: 'idle', aim: 0, p: 0, w: botTaken?.wep || 'sniper', sp: 0 }] }));
  const botAuthority = !!botTaken && await botEquipped.then(() => true, () => false);
  let duplicate = false;
  const duplicateListener = (raw) => {
    try { if (JSON.parse(raw).t === 'specialTaken') duplicate = true; } catch { /* ignore */ }
  };
  ws.on('message', duplicateListener);
  ws.send(JSON.stringify({ t: 's', x: spot.x, z: spot.z, y: spot.y, yaw: 0,
    st: 'idle', aim: 0, p: 0, w: 'smg', am: 50, ar: 150, sp: 0 }));
  ws.send(JSON.stringify({ t: 'takeSpecial' }));
  await wait(250);
  ws.off('message', duplicateListener);
  const botOk = botAuthority && !duplicate;
  console.log(`${botOk ? 'OK  ' : 'FAIL'} online bot — authoritative=${botAuthority} duplicate=${duplicate}`);
  if (!botOk) failures.push('online-bot');
  ws.close();
} finally {
  server.kill();
}

if (failures.length) {
  console.log(`\nONLINE MAP ITEMS: fallos en ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nONLINE MAP ITEMS: todo verde');
