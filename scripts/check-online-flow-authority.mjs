// Fase, pose local, vida y respawn online deben venir del servidor. Cambiar
// el reloj/deadline del navegador no puede adelantar movimiento ni disparos.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8813;
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), INTRO_TIME: '1.4', COUNTDOWN_TIME: '0.8',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: 'ignore',
});
await wait(750);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const failures = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures.push(name);
};

async function client(name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate((value) => {
    document.getElementById('in-name').value = value;
    document.getElementById('in-server').value = location.origin.replace('http', 'ws');
  }, name);
  return page;
}

const a = await client('FLOW-A');
const b = await client('FLOW-B');
try {
  await a.evaluate(() => document.getElementById('btn-lobby-create').click());
  await a.waitForTimeout(500);
  await b.evaluate(() => document.getElementById('btn-lobby-join').click());
  await a.waitForFunction(() => {
    const button = document.getElementById('btn-lobby-start');
    return button && !button.disabled;
  }, null, { timeout: 10000 });
  await a.evaluate(() => document.getElementById('btn-lobby-start').click());
  for (const page of [a, b]) await page.waitForFunction(() =>
    window.BREACH?.mode === 'online' && window.BREACH?.onlinePhase === 'intro',
  null, { timeout: 10000 });

  // Conservar el último snapshot crudo para validar el contrato del server.
  await a.evaluate(() => {
    const G = window.BREACH;
    const original = G.net.handlers.snap;
    G.net.handlers.snap = (message) => { window.__FLOW_SNAP = message; original(message); };
  });
  await a.waitForFunction(() => !!window.__FLOW_SNAP);
  const contract = await a.evaluate(() => {
    const G = window.BREACH;
    const me = window.__FLOW_SNAP.ps.find((p) => p.id === G.net.id);
    return { phase: window.__FLOW_SNAP.phase, startsIn: window.__FLOW_SNAP.startsIn,
      alive: me?.alive, resp: me?.resp, rq: me?.rq };
  });
  check('snap publica fase, deadline relativo y estado de respawn',
    contract.phase === 'intro' && contract.startsIn > 0 && contract.alive === true &&
      contract.resp === 0 && contract.rq === 0, JSON.stringify(contract));

  // Incluso anulando el deadline local, intro sigue bloqueado por fase.
  const intro = await a.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    G.onlineStartAt = 0;
    const before = { x: G.player.pos.x, z: G.player.pos.z, mag: G.weapons.st.mag };
    I.keys.add('KeyW'); I._mouseFire = true; I.firePressed = true;
    await new Promise((resolve) => setTimeout(resolve, 320));
    I.keys.delete('KeyW'); I._mouseFire = false;
    return { before, after: { x: G.player.pos.x, z: G.player.pos.z,
      mag: G.weapons.st.mag }, phase: G.onlinePhase };
  });
  check('reloj manipulado no desbloquea intro/countdown',
    intro.phase !== 'playing' && Math.hypot(intro.after.x - intro.before.x,
      intro.after.z - intro.before.z) < 0.03 && intro.after.mag === intro.before.mag,
    JSON.stringify(intro));

  // Ni siquiera un paquete de posición directo puede adelantar la pose que
  // los demás reciben mientras el server continúa en intro/countdown.
  const remoteBefore = await b.evaluate(() => {
    const r = [...window.BREACH.remotes.values()].find((v) => !v.bot);
    return { id: r?.id, x: r?.x, z: r?.z };
  });
  await a.evaluate(() => {
    const G = window.BREACH;
    G.net.send({ t: 's', x: G.player.pos.x + 6, y: G.player.y, z: G.player.pos.z + 6,
      yaw: 0, st: 'run', w: 'smg', am: 50, ar: 150 });
  });
  await a.waitForTimeout(180);
  const remoteAfter = await b.evaluate((id) => {
    const r = window.BREACH.remotes.get(id);
    return { x: r?.x, z: r?.z };
  }, remoteBefore.id);
  check('servidor ignora pose enviada antes de playing',
    Math.hypot(remoteAfter.x - remoteBefore.x, remoteAfter.z - remoteBefore.z) < 0.1,
    JSON.stringify({ remoteBefore, remoteAfter }));

  await a.waitForFunction(() => window.BREACH.onlinePhase === 'playing', null,
    { timeout: 6000 });

  // El intermedio debe bloquear igual aunque no exista deadline pendiente.
  const intermission = await a.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const snapHandler = G.net.handlers.snap;
    G.net.handlers.snap = () => {}; // aislar la fase simulada de snaps `playing`
    G.onlinePhase = 'intermission'; G.onlineStartAt = 0;
    G.weapons.st.cd = 0;
    const before = { x: G.player.pos.x, z: G.player.pos.z, mag: G.weapons.st.mag };
    I.keys.add('KeyW'); I._mouseFire = true; I.firePressed = true;
    await new Promise((resolve) => setTimeout(resolve, 320));
    I.keys.delete('KeyW'); I._mouseFire = false;
    const out = { before, after: { x: G.player.pos.x, z: G.player.pos.z,
      mag: G.weapons.st.mag } };
    G.net.handlers.snap = snapHandler;
    return out;
  });
  check('intermission no mueve ni consume munición local',
    Math.hypot(intermission.after.x - intermission.before.x,
      intermission.after.z - intermission.before.z) < 0.03 &&
      intermission.after.mag === intermission.before.mag,
    JSON.stringify(intermission));

  // Reconciliación directa: una baja sin pool no inventa countdown y un snap
  // vivo posterior recupera un estado controlable coherente.
  const life = await a.evaluate(() => {
    const G = window.BREACH;
    const handler = G.net.handlers.snap;
    handler({ t: 'snap', phase: 'playing', startsIn: 0, lives: G.scores,
      wins: G.onlineWins, ps: [{ id: G.net.id, x: G.player.pos.x, y: G.player.y,
        z: G.player.pos.z, yaw: G.player.yaw, hp: 0, alive: false, resp: 0, rq: 0 }] });
    const dead = { alive: G.selfAlive, pending: G.selfRespawnPending,
      respawnT: G.respawnT, spectator: G.spectator.active, playerDead: G.player.dead };
    handler({ t: 'snap', phase: 'countdown', startsIn: 2, lives: G.scores,
      wins: G.onlineWins, ps: [{ id: G.net.id, x: 1.25, y: 0, z: -3.5,
        yaw: 0, hp: 100, alive: true, resp: 0, rq: 0 }] });
    const alive = { selfAlive: G.selfAlive, pending: G.selfRespawnPending,
      respawnT: G.respawnT, spectator: G.spectator.active,
      x: G.player.pos.x, z: G.player.pos.z };
    return { dead, alive };
  });
  check('snap muerto sin pool muestra eliminación, no respawn falso',
    !life.dead.alive && !life.dead.pending && life.dead.respawnT === 0 &&
      life.dead.spectator && life.dead.playerDead, JSON.stringify(life.dead));
  check('snap vivo reconcilia respawn y pose bloqueada',
    life.alive.selfAlive && !life.alive.pending && life.alive.respawnT === 0 &&
      !life.alive.spectator && Math.abs(life.alive.x - 1.25) < 0.01 &&
      Math.abs(life.alive.z + 3.5) < 0.01, JSON.stringify(life.alive));
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`ONLINE-FLOW: ${failures.length} fallos → ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('ONLINE-FLOW: fase, pose, vida y respawn autoritativos');
