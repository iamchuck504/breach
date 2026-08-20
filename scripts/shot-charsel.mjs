// Captura la página de selección de personaje y la vista de cámara al
// spawnear (verificación del bolsillo de spawn ampliado).
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
  env: { ...process.env, PORT: '8795' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8795/?nolock=1', { waitUntil: 'networkidle' });
await page.click('#btn-enter');
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.screenshot({ path: path.join(root, 'scripts', 'shot-main-menu.png') });

// página de selección de personaje
await page.evaluate(() => document.getElementById('btn-character').click());
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(root, 'scripts', 'shot-charsel.png') });
const slots = await page.evaluate(() => ({
  slots: document.querySelectorAll('.char-slot').length,
  imgs: [...document.querySelectorAll('.char-slot img')].filter((i) => i.src.length > 200).length,
  sel: document.querySelector('.char-slot.sel')?.dataset.v,
}));
console.log('CHARSEL:', JSON.stringify(slots));

// elegir FANTASMA (v4) y arrancar práctica: vista de cámara en el spawn
await page.evaluate(() => document.querySelectorAll('.char-slot')[4].click());
await page.evaluate(() => document.getElementById('btn-char-back').click());
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1400);
await page.screenshot({ path: path.join(root, 'scripts', 'shot-spawn-cam.png') });
const st = await page.evaluate(() => ({
  variant: window.BREACH.rig.variant,
  camDist: (() => {
    const c = window.BREACH_CAM.position, p = window.BREACH.player.pos;
    return +Math.hypot(c.x - p.x, c.z - p.z).toFixed(2);
  })(),
}));
console.log('SPAWN:', JSON.stringify(st));

await browser.close();
server.kill();
clearClip();
