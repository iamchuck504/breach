// Observa 30s de partida vs bots y mide: flips aéreos vistos, distancia
// mínima promedio entre compañeros (dispersión) y visitas a cobertura.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = 'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8789' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const LAYOUT = process.argv[2] || 'fortaleza';
await page.goto('http://localhost:8789/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate((l) => { window.BREACH.mapChoice = l; }, LAYOUT);
await page.evaluate(() => document.getElementById('btn-bots').click());
await page.waitForTimeout(1200);

let flips = 0, covers = 0, minDistAcc = 0, samples = 0;
const coverSeen = new Set();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => {
    const bots = window.BREACH.botMatch?.bots ?? [];
    let flip = 0;
    const inCover = [];
    let minD = Infinity;
    for (const b of bots) {
      if (!b.alive) continue;
      if (b.flip) flip++;
      if (b.state === 'cover') inCover.push(b.id);
      for (const o of bots) {
        if (o === b || !o.alive || o.team !== b.team) continue;
        const d = Math.hypot(b.pos.x - o.pos.x, b.pos.z - o.pos.z);
        if (d < minD) minD = d;
      }
    }
    return { flip, inCover, minD: isFinite(minD) ? +minD.toFixed(2) : null };
  });
  flips += s.flip;
  for (const id of s.inCover) coverSeen.add(id);
  if (s.minD !== null) { minDistAcc += s.minD; samples++; }
}
covers = coverSeen.size;
const avgMin = +(minDistAcc / Math.max(1, samples)).toFixed(2);
console.log('AI-CHECK:', JSON.stringify({ flipsVistos: flips, botsQueCubrieron: covers, distMinPromedio: avgMin }));

await browser.close();
server.kill();
clearClip();
