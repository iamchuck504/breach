// ARRANQUE DE RONDA: con la tecla de avanzar mantenida desde la cuenta
// regresiva, el personaje debe moverse en cuanto la partida empieza — sin
// segundos muertos ni correcciones del servidor. Cubre online (con bots de
// relleno) y vs bots local. Sirve dist/: correr `npm run build` antes.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// puerto libre: copias de la suite en paralelo no comparten servidor
const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const env = { ...process.env, PORT: String(PORT), INTRO_TIME: '2', COUNTDOWN_TIME: '1', NODE_ENV: 'test' };
delete env.BREACH_FILL_BOTS;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
for (let i = 0; i < 300; i++) { // listo cuando responde, no tras una espera fija
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* arrancando */ }
  await wait(100);
}

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
// En tiempo de JUEGO (dt por cuadro acotado a 0.1 s, como main.js), no de
// pared: en un runner lento los cuadros duran más, pero el juego no avanza más.
const MAX_DELAY_MS = 350;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let pageErrors = 0;
async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  page.setDefaultTimeout(300000);
  // THROTTLE=12: CPU 12× más lenta (CDP) para comprobar que nada depende del reloj de pared
  const rate = Number(process.env.THROTTLE) || 0;
  if (rate > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle', timeout: 300000 });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  return page;
}
// Mide, cuadro a cuadro, cuánto pasa entre el desbloqueo de controles y el
// primer desplazamiento real del jugador.
const armProbe = (page, mode) => page.evaluate((mode) => {
  const G = window.BREACH;
  const probe = window.__probe = { unlockedAt: null, movedAt: null, corrections: 0, start: null, frames: 0, worstFrame: 0, sim: 0 };
  const locked = () => (mode === 'online' ? G.onlinePhase !== 'playing' : G.botMatch?.controlsLocked?.() !== false);
  if (G.net?.handlers?.correction) {
    const original = G.net.handlers.correction;
    G.net.handlers.correction = (m) => { probe.corrections++; original(m); };
  }
  let last = performance.now();
  const tick = (t) => {
    if (probe.unlockedAt !== null) {
      probe.frames++; probe.worstFrame = Math.max(probe.worstFrame, t - last);
      probe.sim += Math.max(0, Math.min(100, t - last)); // ms de juego
    }
    last = t;
    if (G.player && G.mode === mode) {
      if (probe.unlockedAt === null && !locked()) {
        probe.unlockedAt = t; probe.sim = 0; probe.start = { x: G.player.pos.x, z: G.player.pos.z };
      } else if (probe.unlockedAt !== null && probe.movedAt === null &&
          Math.hypot(G.player.pos.x - probe.start.x, G.player.pos.z - probe.start.z) > 0.3) probe.movedAt = probe.sim;
    }
    if (probe.movedAt === null ? probe.sim < 6000 : probe.sim - probe.movedAt < 1500) requestAnimationFrame(tick);
    else probe.done = true;
  };
  requestAnimationFrame(tick);
}, mode);
const readProbe = async (page) => {
  await page.waitForFunction(() => window.__probe?.done || (window.__probe?.unlockedAt !== null &&
    window.__probe.sim > 6000), null, { timeout: 300000 });
  return page.evaluate(() => {
    const p = window.__probe;
    return { delayMs: p.movedAt === null ? null : Math.round(p.movedAt), // ms de juego
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
  }, null, { timeout: 300000 });
  await a.evaluate(() => document.getElementById('btn-lobby-start').click());
  await a.waitForFunction(() => window.BREACH?.mode === 'online', null, { timeout: 300000 });
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
  }, null, { timeout: 300000 });
  await b.evaluate(() => document.getElementById('btn-lobby-start').click());
  await b.waitForFunction(() => window.BREACH?.mode === 'bots' && window.BREACH?.botMatch, null, { timeout: 300000 });
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
  }, null, { timeout: 300000 });
  await c.evaluate(() => document.getElementById('btn-lobby-start').click());
  await c.waitForFunction(() => window.BREACH?.mode === 'bots' && window.BREACH?.botMatch, null, { timeout: 300000 });
  // mantenida SIN captura, con el auto-repeat de un teclado real: una tecla
  // solo se importa al llegar la captura si sigue viva (keydown/repeat en
  // los últimos 2 s); una sin repeat es un keyup perdido y ya no camina sola
  await c.keyboard.down('KeyW');
  for (let i = 0; i < 600 && await c.evaluate(() => window.BREACH.botMatch.controlsLocked()); i++) {
    await wait(50); await c.keyboard.down('KeyW'); // repeat: true
  }
  const grant = await c.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const requestsBeforeStart = window.__lock.requests;
    const start = { x: G.player.pos.x, z: G.player.pos.z };
    // el navegador concede la captura (la pedida durante la cuenta regresiva)
    Object.defineProperty(document, 'pointerLockElement', { get: () => I.canvas, configurable: true });
    document.dispatchEvent(new Event('pointerlockchange'));
    // ms de JUEGO (dt acotado a 0.1 s por cuadro, como main.js)
    let sim = 0, last = await new Promise((r) => requestAnimationFrame(r));
    let movedMs = null;
    while (sim < 2500 && movedMs === null) {
      const t = await new Promise((r) => requestAnimationFrame(r));
      sim += Math.max(0, Math.min(100, t - last)); last = t;
      if (Math.hypot(G.player.pos.x - start.x, G.player.pos.z - start.z) > 0.3) movedMs = Math.round(sim);
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
