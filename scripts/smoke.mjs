// Smoke test headless: carga el juego, entra a práctica, simula movimiento,
// evade y disparo, y captura screenshots. Reporta errores de consola/página.
// Uso: node scripts/smoke.mjs  (requiere dist/ y server corriendo, o levanta el suyo)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8791' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const errors = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
  });

  await page.goto('http://localhost:8791/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-menu.png') });

  // entrar a práctica
  await page.click('#btn-practice');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-spawn.png') });

  // moverse + roadie + evade + disparo
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-roadie.png') });
  await page.keyboard.press(' ');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-evade.png') });
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-fire.png') });

  // ADS
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-aim.png') });
  await page.mouse.up({ button: 'right' });

  // ---- gamepad simulado: stick izq adelante debe mover al jugador ----
  await page.evaluate(() => {
    const fake = {
      id: 'FakePad', connected: true, mapping: 'standard', index: 0,
      axes: [0, -1, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    navigator.getGamepads = () => [fake];
    window.__pad = fake;
  });
  await page.waitForTimeout(400);
  const padOn = await page.evaluate(() => window.BREACH_INPUT.pad.connected);
  const p0 = await page.evaluate(() => ({ x: window.BREACH.player.pos.x, z: window.BREACH.player.pos.z }));
  await page.waitForTimeout(1000);
  const p1 = await page.evaluate(() => ({ x: window.BREACH.player.pos.x, z: window.BREACH.player.pos.z }));
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  console.log('PAD:', JSON.stringify({ connected: padOn, moved: +moved.toFixed(2) }));
  if (!padOn) errors.push('PAD: no detectado');
  if (moved < 0.4) errors.push('PAD: el stick no movió al jugador (moved=' + moved.toFixed(2) + ')');
  await page.evaluate(() => { window.__pad.axes[1] = 0; });

  // ---- menú de pausa + panel de controles ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const paused = await page.evaluate(() => ({
    menuOpen: !document.getElementById('menu').classList.contains('off'),
    resumeVisible: document.getElementById('btn-resume').style.display !== 'none',
  }));
  console.log('PAUSE:', JSON.stringify(paused));
  if (!paused.menuOpen || !paused.resumeVisible) errors.push('PAUSE: menú/reanudar no visible');
  await page.evaluate(() => document.getElementById('btn-controls').click());
  await page.waitForTimeout(200);
  const ctrls = await page.evaluate(() => ({
    kbRows: document.getElementById('kb-rows').children.length,
    padRows: document.getElementById('pad-rows').children.length,
  }));
  console.log('CONTROLS:', JSON.stringify(ctrls));
  if (ctrls.kbRows !== 8 || ctrls.padRows !== 6) errors.push('CONTROLS: filas esperadas 8/6, got ' + ctrls.kbRows + '/' + ctrls.padRows);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-controls.png') });
  await page.evaluate(() => document.getElementById('btn-back').click());
  await page.evaluate(() => document.getElementById('btn-resume').click());
  await page.waitForTimeout(300);

  // estado del juego para verificación
  const state = await page.evaluate(() => ({
    hudOn: document.getElementById('hud').classList.contains('on'),
    menuOff: document.getElementById('menu').classList.contains('off'),
    ammo: document.getElementById('wep-mag').textContent,
    playerState: window.BREACH.player?.state,
  }));
  console.log('STATE:', JSON.stringify(state));

  // ---- multijugador: dos clientes en el mismo server ----
  const ctx2 = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('P2 PAGEERROR: ' + e.message));
  await p2.goto('http://localhost:8791/', { waitUntil: 'networkidle' });
  for (const pg of [page, p2]) {
    // si el juego está corriendo, abrir el menú con Esc primero
    const menuOff = await pg.evaluate(() => document.getElementById('menu').classList.contains('off'));
    if (menuOff) { await pg.keyboard.press('Escape'); await pg.waitForTimeout(300); }
    await pg.evaluate(() => {
      document.getElementById('in-server').value = 'ws://localhost:8791';
      document.getElementById('btn-online').click();
    });
    await pg.waitForTimeout(800);
  }
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  const mp = {
    p1: await page.evaluate(() => ({ mode: window.BREACH.mode, team: window.BREACH.team, remotes: window.BREACH.remotes.size })),
    p2: await p2.evaluate(() => ({ mode: window.BREACH.mode, team: window.BREACH.team, remotes: window.BREACH.remotes.size })),
  };
  console.log('MP:', JSON.stringify(mp));
  await p2.screenshot({ path: path.join(root, 'scripts', 'shot-mp.png') });
  if (mp.p1.mode !== 'online' || mp.p2.mode !== 'online') errors.push('MP: algún cliente no conectó');
  if (mp.p1.remotes !== 1 || mp.p2.remotes !== 1) errors.push('MP: remotes esperados 1/1, got ' + mp.p1.remotes + '/' + mp.p2.remotes);
  if (mp.p1.team === mp.p2.team) errors.push('MP: ambos en el mismo equipo');
  await ctx2.close();
} catch (e) {
  errors.push('FATAL: ' + e.message);
} finally {
  await browser?.close();
  server.kill();
}

if (errors.length) {
  console.log('ERRORS (' + errors.length + '):');
  for (const e of errors.slice(0, 15)) console.log('  ' + e);
  process.exit(1);
}
console.log('SMOKE OK');
