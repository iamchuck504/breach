// ARRANQUE DE RONDA: con la tecla de avanzar mantenida desde la cuenta
// regresiva, el personaje debe moverse en cuanto la partida empieza — sin
// segundos muertos ni correcciones del servidor. Cubre online (con bots de
// relleno) y vs bots local. Sirve dist/: correr `npm run build` antes.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8816;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, PORT: String(PORT), INTRO_TIME: '2', COUNTDOWN_TIME: '1', NODE_ENV: 'test' };
delete env.BREACH_FILL_BOTS;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
await wait(750);

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const MAX_DELAY_MS = 350;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let pageErrors = 0;
async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  return page;
}
// Mide, cuadro a cuadro, cuánto pasa entre el desbloqueo de controles y el
// primer desplazamiento real del jugador.
const armProbe = (page, mode) => page.evaluate((mode) => {
  const G = window.BREACH;
  const probe = window.__probe = { unlockedAt: null, movedAt: null, corrections: 0, start: null, frames: 0, worstFrame: 0 };
  const locked = () => (mode === 'online' ? G.onlinePhase !== 'playing' : G.botMatch?.controlsLocked?.() !== false);
  if (G.net?.handlers?.correction) {
    const original = G.net.handlers.correction;
    G.net.handlers.correction = (m) => { probe.corrections++; original(m); };
  }
  let last = performance.now();
  const tick = (t) => {
    if (probe.unlockedAt !== null) { probe.frames++; probe.worstFrame = Math.max(probe.worstFrame, t - last); }
    last = t;
    if (G.player && G.mode === mode) {
      if (probe.unlockedAt === null && !locked()) {
        probe.unlockedAt = t; probe.start = { x: G.player.pos.x, z: G.player.pos.z };
      } else if (probe.unlockedAt !== null && probe.movedAt === null &&
          Math.hypot(G.player.pos.x - probe.start.x, G.player.pos.z - probe.start.z) > 0.3) probe.movedAt = t;
    }
    if (probe.movedAt === null || t - probe.movedAt < 1500) requestAnimationFrame(tick);
    else probe.done = true;
  };
  requestAnimationFrame(tick);
}, mode);
const readProbe = async (page) => {
  await page.waitForFunction(() => window.__probe?.done || (window.__probe?.unlockedAt !== null &&
    performance.now() - window.__probe.unlockedAt > 6000), null, { timeout: 40000 });
  return page.evaluate(() => {
    const p = window.__probe;
    return { delayMs: p.movedAt === null ? null : Math.round(p.movedAt - p.unlockedAt),
      corrections: p.corrections, worstFrameMs: Math.round(p.worstFrame), frames: p.frames };
  });
};

try {
  // --- ONLINE
  const a = await open();
  await a.evaluate((p) => {
    document.getElementById('in-name').value = 'ANA';
    document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
    document.getElementById('btn-lobby-create').click();
  }, PORT);
  await a.waitForFunction(() => {
    const b = document.getElementById('btn-lobby-start');
    return window.BREACH?.lobby?.hostId && !document.getElementById('lobby-card').classList.contains('off') && !b.disabled;
  }, null, { timeout: 10000 });
  await a.evaluate(() => document.getElementById('btn-lobby-start').click());
  await a.waitForFunction(() => window.BREACH?.mode === 'online', null, { timeout: 45000 });
  await armProbe(a, 'online');
  await a.keyboard.down('KeyW'); // mantenida desde la presentación
  const online = await readProbe(a);
  await a.keyboard.up('KeyW');
  check('online: se mueve al instante al empezar la ronda',
    online.delayMs !== null && online.delayMs <= MAX_DELAY_MS, JSON.stringify(online));
  check('online: el servidor no corrige el arranque', online.corrections === 0, JSON.stringify(online));
  await a.close();
  await wait(400);

  // --- VS BOTS local
  const b = await open();
  await b.evaluate(() => document.getElementById('btn-bots').click());
  await b.waitForFunction(() => {
    const s = document.getElementById('btn-lobby-start');
    return window.BREACH?.lobby && !document.getElementById('lobby-card').classList.contains('off') && !s.disabled;
  }, null, { timeout: 10000 });
  await b.evaluate(() => document.getElementById('btn-lobby-start').click());
  await b.waitForFunction(() => window.BREACH?.mode === 'bots' && window.BREACH?.botMatch, null, { timeout: 15000 });
  await armProbe(b, 'bots');
  await b.keyboard.down('KeyW');
  const local = await readProbe(b);
  await b.keyboard.up('KeyW');
  check('vs bots: se mueve al instante al empezar la ronda',
    local.delayMs !== null && local.delayMs <= MAX_DELAY_MS, JSON.stringify(local));
  await b.close();
  await wait(400);

  // --- CAPTURA DEL CURSOR (navegador real): el teclado solo cuenta con el
  //     cursor capturado. Se simula la captura sin pedir un lock de verdad
  //     (regla de las suites: jamás confinar el ratón físico): se sustituye
  //     requestPointerLock por un contador y la concesión se finge con el
  //     evento que emite el navegador.
  const c = await open();
  await c.evaluate(() => {
    const I = window.BREACH_INPUT;
    window.__lock = { requests: 0, beforeStart: null };
    I.canvas.requestPointerLock = () => { window.__lock.requests++; return Promise.resolve(); };
    I.lockDisabled = false; I.locked = false;
    document.getElementById('btn-bots').click();
  });
  await c.waitForFunction(() => {
    const s = document.getElementById('btn-lobby-start');
    return window.BREACH?.lobby && !document.getElementById('lobby-card').classList.contains('off') && !s.disabled;
  }, null, { timeout: 10000 });
  await c.evaluate(() => document.getElementById('btn-lobby-start').click());
  await c.waitForFunction(() => window.BREACH?.mode === 'bots' && window.BREACH?.botMatch, null, { timeout: 15000 });
  await c.keyboard.down('KeyW'); // mantenida SIN captura: hoy por hoy no cuenta todavía
  await c.waitForFunction(() => window.BREACH.botMatch.controlsLocked() === false, null, { timeout: 30000 });
  const grant = await c.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const requestsBeforeStart = window.__lock.requests;
    const start = { x: G.player.pos.x, z: G.player.pos.z };
    // el navegador concede la captura (la pedida durante la cuenta regresiva)
    Object.defineProperty(document, 'pointerLockElement', { get: () => I.canvas, configurable: true });
    document.dispatchEvent(new Event('pointerlockchange'));
    const t0 = performance.now();
    let movedMs = null;
    while (performance.now() - t0 < 2500 && movedMs === null) {
      await new Promise((r) => requestAnimationFrame(r));
      if (Math.hypot(G.player.pos.x - start.x, G.player.pos.z - start.z) > 0.3) movedMs = Math.round(performance.now() - t0);
    }
    delete document.pointerLockElement;
    document.dispatchEvent(new Event('pointerlockchange'));
    return { requestsBeforeStart, movedMs, locked: I.locked };
  });
  await c.keyboard.up('KeyW');
  check('la captura del cursor se pide DURANTE la cuenta regresiva (no al dar la salida)',
    grant.requestsBeforeStart > 0, JSON.stringify(grant));
  check('una tecla mantenida desde antes cuenta en cuanto llega la captura (sin soltarla)',
    grant.movedMs !== null && grant.movedMs <= MAX_DELAY_MS, JSON.stringify(grant));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nARRANQUE DE RONDA: todo verde');
process.exit(fails.length ? 1 : 0);
