// Reproduce episodios de atasco guardados por eval-bots.mjs (frames/*-puntoN.json)
// con un bot solo en el mapa: mismos cuadros (cenital + vista del bot) en los
// mismos instantes, para comparar antes/después con nombres idénticos.
//   node scripts/eval-bots-repro.mjs <mapa> <salida> <episodio.json> [...]
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [MAP, OUTARG, ...files] = process.argv.slice(2);
const OUT = path.resolve(OUTARG);
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT) || 8960;
const eps = files.map((f) => ({ ...JSON.parse(fs.readFileSync(f, 'utf8')), name: path.basename(f, '.json') }));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.addInitScript(() => {
    let s = 7; Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const raf = window.requestAnimationFrame.bind(window); let vt = performance.now();
    const adv = () => { vt += 33.4; raf(adv); }; raf(adv);
    window.requestAnimationFrame = (cb) => raf(() => cb(vt));
  });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=low`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, MAP);
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('btn-lobby-start').click());
  await page.waitForFunction(() => !!window.BREACH.botMatch, null, { timeout: 120000 });
  const src = fs.readFileSync(path.join(root, 'scripts', 'eval-bots-page.js'), 'utf8');
  await page.evaluate(([code]) => (0, eval)(code)({ mode: 'bots', frames: 0, segment: 70 }), [src]);
  await page.evaluate(() => { const M = window.BREACH.botMatch; M.phase = 'playing'; M.phaseT = 0; });
  const res = await page.evaluate((list) => window.__ev.repro(list), eps.map(({ id, bot, x, z, y, team, role, wp, fixed }) => ({ id, bot, x, z, y, team, role, wp, fixed })));
  const frames = await page.evaluate(() => window.__ev.frames.splice(0));
  for (const f of frames) {
    const ep = eps.find((e) => 'r' + e.id === f.ep);
    for (const v of ['top', 'eye']) {
      const jpg = path.join(OUT, `tmp-${v}.jpg`);
      fs.writeFileSync(jpg, Buffer.from(f[v].split(',')[1], 'base64'));
      execFileSync('sips', ['-s', 'format', 'png', jpg, '--out', path.join(OUT, `${ep.name}-${v}-${f.n}.png`)], { stdio: 'ignore' });
      fs.unlinkSync(jpg);
    }
  }
  fs.writeFileSync(path.join(OUT, `${MAP}-repro.json`), JSON.stringify(res.map((r, i) => ({ name: eps[i].name, ...r })), null, 1));
  console.log(JSON.stringify(res));
} finally { await browser.close(); server.kill(); }
