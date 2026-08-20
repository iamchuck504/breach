// Caso dirigido: fuerza un bot a perseguir un waypoint detrás del escudo de
// spawn de Fortaleza y valida reacción, bypass y memoria de lado fallido.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8793' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:8793/?nolock=1', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    window.BREACH.mapChoice = 'fortaleza';
    document.getElementById('btn-bots').click();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const bm = window.BREACH.botMatch;
    // Esta prueba aísla navegación; salta la presentación inicial sin alterar
    // el comportamiento productivo del match.
    bm.phase = 'playing'; bm.phaseT = 0;
    const bot = bm.bots.find((b) => b.team === 'red');
    window.__stuckBot = bot;
    // El shield del spawn ocupa z=-21.4..-20.4, x=-4..4.
    bot.pos.x = 0; bot.pos.z = -22.05; bot.y = 0;
    bot.state = 'advance'; bot.role = 'advance'; bot.roleT = 99;
    bot.decisionT = 99; bot.repathT = 99; bot.commitMove = true;
    bot.tacticalGoal = { x: 0, z: -15, role: 'advance' };
    bot.wp = bot.tacticalGoal;
    bot.recovery = null; bot.failedRoutes = []; bot._resetProgress();
    // Aislar navegación: durante esta prueba no aparece un blanco que cambie
    // el estado táctico antes de llegar a la pared.
    bm.nearestVisibleEnemy = () => null;
  });

  const started = Date.now();
  let detected = null;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(50);
    detected = await page.evaluate(() => {
      const b = window.__stuckBot;
      return b.recovery ? { side: b.recovery.side, key: b.recovery.key } : null;
    });
    if (detected) break;
  }
  const detectMs = Date.now() - started;
  if (!detected) errors.push('no identificó el obstáculo en 500 ms');

  const memory = detected ? await page.evaluate(() => {
    const b = window.__stuckBot, bm = window.BREACH.botMatch;
    const first = b.recovery;
    b._rememberSideFailure(first);
    b.recovery = null;
    const ok = b._startObstacleRecovery(first.collider, 0, 1, b.tacticalGoal, bm);
    return { ok, first: first.side, second: b.recovery?.side ?? 0 };
  }) : { ok: false, first: 0, second: 0 };
  if (!memory.ok || memory.second !== -memory.first) {
    errors.push(`memoria no cambió de lado (${memory.first} -> ${memory.second})`);
  }

  await page.waitForTimeout(1150);
  const result = await page.evaluate(() => {
    const b = window.__stuckBot;
    return {
      x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2),
      speed: +b.speed.toFixed(2), recovery: b.recovery ? 1 : 0,
      failures: b.failedRoutes.length,
    };
  });
  if (Math.abs(result.x) < 1.4) errors.push(`no rodeó lateralmente la pared (x=${result.x})`);
  console.log('BOT-STUCK:', JSON.stringify({ detectMs, memory, result }));
} finally {
  await browser?.close();
  server.kill();
  clearClip();
}

if (errors.length) {
  console.error('BOT-STUCK ERRORS:');
  errors.forEach((e) => console.error(' - ' + e));
  process.exit(1);
}
console.log('BOT STUCK OK');
