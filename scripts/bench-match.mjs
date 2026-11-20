// COSTO DE RENDER EN UNA PARTIDA REAL: 4v4 con bots, con los ocho soldados,
// sus armas y sus efectos. bench-map.mjs mide el mapa vacío en práctica: sin
// soldados, que son la mayor parte de las llamadas de dibujo.
//   node scripts/bench-match.mjs [mapa] [carpeta de capturas]
// GFX=off|low|medium|high|ultra (por defecto high) · LOOK=classic sin el look
// BASE=http://127.0.0.1:5210 mide contra un servidor de desarrollo ya abierto;
// sin BASE sirve dist/ (correr `npm run build` antes).
// El tiempo de cuadro depende de la máquina y del tope de refresco: sirve para
// comparar corridas hechas en las mismas condiciones.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = process.argv[2] || 'fortaleza';
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const PORT = 8871 + Math.max(0, ['fortaleza', 'azoteas', 'calle2'].indexOf(MAP));
let server = null, base = process.env.BASE;
if (!base) {
  server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 750));
  base = `http://127.0.0.1:${PORT}`;
}
const q = new URLSearchParams({ nolock: '1', gfx: process.env.GFX || 'high' });
if (process.env.LOOK) q.set('look', process.env.LOOK);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.goto(`${base}/?${q}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, MAP);
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('btn-lobby-start').click());
  await page.waitForFunction(() => !!window.BREACH.botMatch, null, { timeout: 120000 });
  await page.waitForTimeout(24000); // presentación, cuenta atrás y primer contacto
  for (const label of ['a', 'b', 'c']) {
    const r = await page.evaluate(async () => {
      const R = window.BREACH_RENDERER;
      const calls = [], tris = [], frames = []; let last = performance.now();
      await new Promise((res) => {
        const tick = (t) => {
          frames.push(t - last); last = t; calls.push(R.info.render.calls); tris.push(R.info.render.triangles);
          if (frames.length < 360) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
      const at = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
      return { calls: at(calls, 0.5), callsMax: at(calls, 1), tris: at(tris, 0.5), msMed: +at(frames, 0.5).toFixed(2), msP95: +at(frames, 0.95).toFixed(2), msP99: +at(frames, 0.99).toFixed(2),
        programs: R.info.programs?.length ?? 0, geometries: R.info.memory.geometries, textures: R.info.memory.textures };
    });
    results.push({ sample: label, ...r });
    if (OUT) await page.screenshot({ path: path.join(OUT, `match-${MAP}-${label}.png`) });
    await page.waitForTimeout(5000);
  }
} finally {
  await browser.close();
  server?.kill();
}
console.log(`PARTIDA ${MAP} · gfx=${process.env.GFX || 'high'}${process.env.LOOK ? ` · look=${process.env.LOOK}` : ''}`);
for (const r of results) console.log(JSON.stringify(r));
if (OUT) fs.writeFileSync(path.join(OUT, `match-${MAP}.json`), JSON.stringify(results, null, 2));
