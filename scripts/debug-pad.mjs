// Depuración: inyecta gamepad falso y observa estado/posición frame a frame.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8794' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8794/?nolock=1', { waitUntil: 'networkidle' });
await page.click('#btn-enter');
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.click('#btn-practice');
await page.waitForTimeout(600);

await page.evaluate(() => {
  const fake = {
    id: 'FakePad', connected: true, mapping: 'standard', index: 0,
    axes: [0, -1, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  navigator.getGamepads = () => [fake];
  window.__pad = fake;
});

for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const mv = I.moveVec();
    return {
      conn: I.pad.connected, mv: [+mv.x.toFixed(2), +mv.z.toFixed(2)],
      st: G.player.state,
      pos: [+G.player.pos.x.toFixed(2), +G.player.pos.z.toFixed(2)],
      spd: +G.player.speed.toFixed(2),
    };
  });
  console.log(i, JSON.stringify(s));
}

await browser.close();
clearClip();
server.kill();
