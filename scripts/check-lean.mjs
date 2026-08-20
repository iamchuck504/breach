// Verifica el shoulder swap: cover en pared alta, asomarse por la orilla
// IZQUIERDA en pantalla → la cámara debe pasar al hombro izquierdo.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8795' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8795/?nolock=1', { waitUntil: 'networkidle' });
await page.click('#btn-enter');
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.click('#btn-practice');
await page.waitForTimeout(600);

// frente al escudo de spawn, extremo +x (= orilla IZQUIERDA en pantalla mirando +z)
await page.evaluate(() => {
  const P = window.BREACH.player;
  P.pos.x = 3.1; P.pos.z = -15.6;
  P.cam.yaw = Math.PI; P.yaw = Math.PI;
});
await page.keyboard.down('w');
await page.waitForTimeout(200);
await page.keyboard.press(' ');
await page.keyboard.up('w');
await page.waitForTimeout(400);
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(700);
const res = await page.evaluate(() => ({
  st: window.BREACH.player.state,
  aim: window.BREACH.player.aim,
  lean: window.BREACH.player.coverLeanAnim,
  camSide: +window.BREACH.player.cam._side.toFixed(2),
}));
console.log('LEAN:', JSON.stringify(res));
await page.screenshot({ path: path.join(root, 'scripts', 'shot-lean.png') });
await page.mouse.up({ button: 'right' });
await browser.close();
clearClip();
server.kill();
if (res.st !== 'cover' || !res.aim || res.camSide > -0.5) {
  console.log('PROBLEMA: swap de hombro no ocurrió');
  process.exit(1);
}
console.log('LEAN OK');
