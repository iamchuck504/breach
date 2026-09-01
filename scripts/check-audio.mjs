// Verifica que los samples de armas (public/audio) cargan y decodifican
// dentro del juego corriendo.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8790' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8790/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(2000);
const st = await page.evaluate(() => ({
  smg: +(window.BREACH_AUDIO.samples.smg?.duration ?? 0).toFixed(3),
  shotgun: +(window.BREACH_AUDIO.samples.shotgun?.duration ?? 0).toFixed(3),
  sniper: +(window.BREACH_AUDIO.samples.sniper?.duration ?? 0).toFixed(3),
}));
console.log('SAMPLES:', JSON.stringify(st));
await browser.close();
server.kill();
clearClip();
const ok = st.smg > 0.2 && st.smg < 0.35 && st.shotgun > 1.2 && st.shotgun < 1.5 &&
  st.sniper > 2.5 && st.sniper < 3.0;
console.log(ok ? 'AUDIO OK' : 'AUDIO FALLO');
process.exit(ok ? 0 : 1);
