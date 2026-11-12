// COSTO DE RENDER DE UN MAPA: llamadas de dibujo, triángulos, texturas,
// programas y tiempo de cuadro desde poses fijas de cámara. Sirve para
// comparar antes/después de un cambio de arte o iluminación.
//   node scripts/bench-map.mjs [mapa] [carpeta de capturas]
// Sirve dist/: correr `npm run build` antes. El tiempo de cuadro depende de la
// máquina y del navegador sin ventana: úsese para comparar corridas hechas en
// las mismas condiciones, no como cifra absoluta.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = process.argv[2] || 'fortaleza';
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const PORT = 8820;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT) }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));

// x, z, yaw de cámara, pitch. Todas con espacio detrás del jugador: pegada a
// un muro la cámara se mete contra el casco y la captura no sirve.
const POSES = [
  ['patio', 0, 4, 0, -0.04],
  ['base', 6, -22, Math.PI, -0.03],
  ['lateral', -9, 2, -1.2, -0.02],
  ['cobertura', 5, 13, 0.5, -0.06],
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript((map) => localStorage.setItem('breach.map', map), MAP);
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error' || /THREE\.WebGLProgram|shader/i.test(m.text())) console.log('CONSOLA:', m.text().slice(0, 600)); });
page.on('crash', () => console.log('LA PÁGINA SE CAYÓ'));
const results = [];
try {
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: 30000 });
  await page.waitForTimeout(7000); // carga de GLBs, compilación de shaders y aviso inicial
  // sin blancos: cada dummy visible suma decenas de llamadas y, al moverse,
  // hacía que el conteo cambiara de una corrida a otra
  await page.evaluate(() => {
    for (const d of window.BREACH.dummies.list) { d.alive = false; d.respawnT = 1e9; d.rig.root.visible = false; }
  });
  for (const [name, x, z, yaw, pitch] of POSES) {
    const r = await page.evaluate(async ([x, z, yaw, pitch]) => {
      const G = window.BREACH, R = window.BREACH_RENDERER, W = window.BREACH_WORLD;
      const p = { x, z };
      W.resolveCircle(p, 0.4, 0);
      G.player.pos.x = p.x; G.player.pos.z = p.z; G.player.y = W.groundHeight(p, 0.4, 0);
      G.player.vel.x = G.player.vel.z = 0; G.player.yaw = yaw;
      G.player.cam.yaw = yaw; G.player.cam.pitch = pitch;
      await new Promise((res) => setTimeout(res, 900));
      const frames = [];
      let calls = 0, tris = 0, last = performance.now();
      await new Promise((res) => {
        const tick = (t) => {
          frames.push(t - last); last = t;
          calls = Math.max(calls, R.info.render.calls); tris = Math.max(tris, R.info.render.triangles);
          if (frames.length < 240) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
      frames.sort((a, b) => a - b);
      const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
      return { calls, tris, meanMs: +mean.toFixed(2), p95Ms: +frames[Math.floor(frames.length * 0.95)].toFixed(2),
        textures: R.info.memory.textures, geometries: R.info.memory.geometries, programs: R.info.programs?.length ?? 0 };
    }, [x, z, yaw, pitch]);
    results.push({ pose: name, ...r });
    if (OUT) {
      await page.evaluate(() => { document.getElementById('hud').style.visibility = 'hidden'; });
      await page.screenshot({ path: path.join(OUT, `${MAP}-${name}.png`) });
      await page.evaluate(() => { document.getElementById('hud').style.visibility = ''; });
    }
  }
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}
console.log(`MAPA ${MAP}`);
for (const r of results) console.log(JSON.stringify(r));
if (OUT) fs.writeFileSync(path.join(OUT, `${MAP}-bench.json`), JSON.stringify(results, null, 2));
