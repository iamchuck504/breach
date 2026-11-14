// Repaso visual rápido de un mapa: cuatro vistas aéreas, una cenital por
// cuadrante y, por cada rampa, una vista desde el pie y otra desde arriba.
//   node scripts/shot-map-sanity.mjs <mapa> <carpeta>   (requiere dist/)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { rampsFor } from '../src/world/collision-layouts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = process.argv[2] || 'azoteas';
const OUT = path.resolve(process.argv[3] || `artifacts/sanity-${MAP}`);
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8839;
const SHOTS = [];
for (const [i, [sx, sz]] of [[1, 1], [-1, 1], [-1, -1], [1, -1]].entries()) {
  SHOTS.push([`aerea-${i + 1}`, [sx * 34, 26, sz * 46], [0, 0, 0]]);
  SHOTS.push([`cenital-${i + 1}`, [sx * 14, 46, sz * 21], [sx * 14, 0, sz * 20.9]]);
}
rampsFor(MAP).forEach((r, i) => {
  // dir = sentido en que SUBE la rampa a lo largo de su eje
  const ax = r.axis === 'z' ? [0, r.dir] : [r.dir, 0];
  const half = (r.axis === 'z' ? r.d : r.w) / 2;
  const foot = [r.x - ax[0] * (half + 3), r.z - ax[1] * (half + 3)], top = [r.x + ax[0] * (half + 2.5), r.z + ax[1] * (half + 2.5)];
  SHOTS.push([`rampa-${i + 1}-pie`, [foot[0], 1.9, foot[1]], [top[0], r.h + 0.8, top[1]]]);
  SHOTS.push([`rampa-${i + 1}-arriba`, [top[0], r.h + 2.2, top[1]], [foot[0], 0.4, foot[1]]]);
});
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate((m) => { window.BREACH.mapChoice = m; document.getElementById('btn-practice').click(); }, MAP);
  await page.waitForFunction(() => !!window.BREACH.player, null, { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const G = window.BREACH;
    document.getElementById('hud').style.visibility = 'hidden';
    for (const d of G.dummies?.list ?? []) d.rig.root.visible = false;
    const follow = G.player.cam, update = follow.update.bind(follow);
    follow.update = (dt, player) => {
      update(dt, player);
      const v = window.__view; if (!v) return;
      const c = follow.camera;
      c.position.set(...v[0]); c.up.set(0, 1, 0); c.lookAt(...v[1]);
      if (c.fov !== 62) { c.fov = 62; c.far = 400; c.updateProjectionMatrix(); }
    };
  });
  for (const [name, pos, look] of SHOTS) {
    await page.evaluate((v) => { window.__view = v; window.BREACH.rig.root.visible = false; }, [pos, look]);
    await page.waitForTimeout(350);
    await page.locator('#game').screenshot({ path: path.join(OUT, name + '.png') });
  }
  console.log(MAP, SHOTS.length, 'capturas');
} finally {
  await browser.close(); server.kill();
}
