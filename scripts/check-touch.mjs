// CONTROLES TÁCTILES: valida en un contexto móvil emulado (touch real por
// CDP) que la UI aparece, el stick dinámico mueve al jugador, el arrastre
// derecho gira la cámara, FIRE dispara y ADS es toggle. También que en
// desktop (sin toques) la UI NO existe.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8796', '--strictPort'], { stdio: 'ignore', cwd: root });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// ---------- contexto MÓVIL (tablet landscape, touch) ----------
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 720 }, hasTouch: true, isMobile: true,
});
const page = await ctx.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
await page.goto('http://localhost:8796/', { waitUntil: 'networkidle' });
const cdp = await ctx.newCDPSession(page);
const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map(([x, y, id]) => ({ x, y, id: id ?? 1 })),
});

await page.tap('#btn-enter');
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.tap('#btn-practice');
await page.waitForTimeout(2200);

const st0 = await page.evaluate(() => ({
  touchOn: document.body.classList.contains('touch-on'),
  ui: !!document.getElementById('touch-ui'),
  lockDisabled: window.BREACH_INPUT.lockDisabled,
}));
check('modo táctil activo tras el primer toque (UI + sin pointer lock)',
  st0.touchOn && st0.ui && st0.lockDisabled, JSON.stringify(st0));

// stick dinámico: apoyar en zona izquierda y empujar arriba → avanza
const before = await page.evaluate(() => {
  const P = window.BREACH.player;
  P.pos.x = 0; P.pos.z = -10; P.vel.x = 0; P.vel.z = 0;
  P.yaw = Math.PI; P.cam.yaw = Math.PI;
  return { x: P.pos.x, z: P.pos.z };
});
await touch('touchStart', [[220, 560, 1]]);
await touch('touchMove', [[220, 480, 1]]);
await page.waitForTimeout(900);
const mid = await page.evaluate(() => ({
  x: window.BREACH.player.pos.x, z: window.BREACH.player.pos.z,
  idx: window.BREACH_INPUT.pad._idx, id: window.BREACH_INPUT.pad.info?.id ?? '',
  stickShown: document.querySelector('.touch-stick')?.style.display === 'block',
}));
await touch('touchEnd', [[220, 480, 1]]);
const moved = Math.hypot(mid.x - before.x, mid.z - before.z);
check('el stick dinámico mueve al jugador', moved > 0.8, `moved=${moved.toFixed(2)}`);
check('el pad táctil es el elegido', mid.idx === 32 && mid.id.includes('Touch'),
  `idx=${mid.idx}`);
check('la base visual del stick aparece donde apoyas', mid.stickShown === true);

// mirada: arrastre en la zona derecha gira la cámara
const yaw0 = await page.evaluate(() => window.BREACH.player.cam.yaw);
await touch('touchStart', [[820, 360, 2]]);
for (let i = 1; i <= 6; i++) {
  await touch('touchMove', [[820 + i * 30, 360, 2]]);
  await page.waitForTimeout(40);
}
await touch('touchEnd', [[1000, 360, 2]]);
await page.waitForTimeout(200);
const yaw1 = await page.evaluate(() => window.BREACH.player.cam.yaw);
check('el arrastre derecho gira la cámara', Math.abs(yaw1 - yaw0) > 0.05,
  `dyaw=${Math.abs(yaw1 - yaw0).toFixed(3)}`);

// FIRE: mantener el botón dispara (baja munición)
const mag0 = await page.evaluate(() => window.BREACH.weapons.st.mag);
const fireBox = await page.evaluate(() => {
  const r = document.querySelector('.t-fire').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await touch('touchStart', [[fireBox.x, fireBox.y, 3]]);
await page.waitForTimeout(500);
await touch('touchEnd', [[fireBox.x, fireBox.y, 3]]);
await page.waitForTimeout(200);
const mag1 = await page.evaluate(() => window.BREACH.weapons.st.mag);
check('FIRE mantiene el disparo (bajó munición)', mag1 < mag0, `${mag0}→${mag1}`);

// ADS: toggle on/off
const adsBox = await page.evaluate(() => {
  const r = document.querySelector('.t-aim').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await touch('touchStart', [[adsBox.x, adsBox.y, 4]]);
await touch('touchEnd', [[adsBox.x, adsBox.y, 4]]);
await page.waitForTimeout(250);
const aimOn = await page.evaluate(() => window.BREACH_INPUT.pad.aimHeld);
await touch('touchStart', [[adsBox.x, adsBox.y, 4]]);
await touch('touchEnd', [[adsBox.x, adsBox.y, 4]]);
await page.waitForTimeout(250);
const aimOff = await page.evaluate(() => window.BREACH_INPUT.pad.aimHeld);
check('ADS es toggle (on → off)', aimOn === true && aimOff === false,
  `on=${aimOn} off=${aimOff}`);

check('sin errores de página (móvil)', pageErrors === 0, `errores=${pageErrors}`);
await ctx.close();

// ---------- contexto DESKTOP: la UI táctil no debe existir ----------
const desk = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await desk.goto('http://localhost:8796/?nolock=1', { waitUntil: 'networkidle' });
await desk.evaluate(() => document.getElementById('btn-enter')?.click());
await desk.waitForSelector('#splash.off', { state: 'attached' });
const deskState = await desk.evaluate(() => ({
  touchOn: document.body.classList.contains('touch-on'),
  ui: !!document.getElementById('touch-ui'),
}));
check('en desktop la UI táctil no aparece', !deskState.touchOn && !deskState.ui,
  JSON.stringify(deskState));

await browser.close();
server.kill();
await clearClip();
console.log(fails.length ? `FALLOS: ${fails.length}` : 'TOUCH: todo verde');
process.exit(fails.length ? 1 : 0);
