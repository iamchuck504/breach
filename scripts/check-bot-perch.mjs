// PUESTOS ELEVADOS de los bots (mapas v2): en una partida real contra bots,
// alguno debe subir por la rampa a la entreplanta de Azoteas y al remolque de
// Calle Cerrada, quedarse arriba a la altura de la plataforma y volver a
// bajar por una rampa. También vigila que nadie se quede atrapado arriba sin
// un puesto en curso. Sirve dist/: `npm run build` antes.
//   node scripts/check-bot-perch.mjs [mapa ...]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';
import { decksFor } from '../src/world/collision-layouts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = process.argv.length > 2 ? process.argv.slice(2) : ['azoteas', 'calle2'];
const PORT = 8827, LIMIT_S = 100;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const fails = [];
try {
  for (const map of MAPS) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
    await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, map);
    await page.evaluate(() => document.getElementById('btn-enter')?.click());
    await page.waitForSelector('#splash.off', { state: 'attached' });
    await page.evaluate(() => document.getElementById('btn-bots').click());
    await page.waitForTimeout(600);
    await page.evaluate(() => document.getElementById('btn-lobby-start').click());
    await page.waitForFunction(() => window.BREACH.botMatch && !window.BREACH.botMatch.controlsLocked(), null, { timeout: 30000 });
    // el observador vive en la página: muestrea cada cuadro, no cada sondeo
    const decks = decksFor(map).flatMap((d) => (d.mirror ? [1, -1] : [1]).map((s) => ({ x: d.x * s, z: d.z * s, w: d.w, d: d.d, h: d.h })));
    await page.evaluate((decks) => {
      const seen = window.__perch = { approach: 0, up: 0, hold: 0, down: 0, done: 0, holdAtHeight: 0, strandedS: 0, maxStranded: 0, teams: {} };
      const last = new Map(), stranded = new Map();
      let prev = performance.now();
      const tick = (now) => {
        const dt = (now - prev) / 1000; prev = now;
        const M = window.BREACH.botMatch;
        if (M) for (const b of M.bots) {
          if (!b.alive) { last.delete(b.id); stranded.delete(b.id); continue; }
          const phase = b.perch?.phase ?? null, was = last.get(b.id) ?? null;
          if (phase && phase !== was) { seen[phase]++; if (phase === 'hold') seen.teams[b.team] = (seen.teams[b.team] ?? 0) + 1; }
          if (phase === 'hold' && Math.abs(b.y - b.perch.deck.h) < 0.08) seen.holdAtHeight += dt;
          if (was === 'down' && !phase && b.y < 0.1) seen.done++;
          // sobre una plataforma sin puesto en curso (el helipuerto de Azoteas
          // también es suelo elevado, pero se sube y se baja andando)
          const onDeck = decks.some((d) => Math.abs(b.pos.x - d.x) < d.w / 2 && Math.abs(b.pos.z - d.z) < d.d / 2 && Math.abs(b.y - d.h) < 0.2);
          const s = !phase && b.grounded && onDeck ? (stranded.get(b.id) ?? 0) + dt : 0;
          stranded.set(b.id, s); seen.maxStranded = Math.max(seen.maxStranded, s);
          last.set(b.id, phase);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, decks);
    let s = null;
    for (let i = 0; i < LIMIT_S; i++) {
      await page.waitForTimeout(1000);
      s = await page.evaluate(() => ({ ...window.__perch }));
      if (s.done >= 1 && s.holdAtHeight > 3) break;
    }
    const ok = s.hold >= 1 && s.done >= 1 && s.holdAtHeight > 3 && s.maxStranded < 4 && errors.length === 0;
    console.log(`${ok ? 'OK ' : 'FAIL'} ${map}: bots usan el puesto elevado — ${JSON.stringify(s)}${errors.length ? ' · ' + errors[0] : ''}`);
    if (!ok) fails.push(map);
    await page.close();
  }
} finally {
  await browser.close(); server.kill(); await clearClip();
}
if (fails.length) { console.error(`\n✗ PUESTOS ELEVADOS: falla en ${fails.join(', ')}`); process.exit(1); }
console.log('\n✓ PUESTOS ELEVADOS OK');
