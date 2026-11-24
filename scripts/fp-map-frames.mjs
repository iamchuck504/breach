// CUADROS EN PRIMERA PERSONA de un mapa desde puntos fijos (revisión de mapas
// FPS). Contra el servidor de desarrollo YA abierto; un solo navegador.
//   BASE=http://127.0.0.1:5210 node scripts/fp-map-frames.mjs <vistas.json> <carpeta> [--map=azoteas]
// vistas.json: { "<mapa>": [ { "name": "...", "at": [x, z], "pose": "stand"|"crouch",
//   "look": [x, y, z], "foes": [[x, z, "stand"|"crouch", yaw?], ...] } ] }
// El ojo sale de eyeWorld() (src/combat/hit-pose.js), el mismo que usan la
// cámara, el servidor y los bots; FOV vertical 72 (el de serie del juego).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './lib-chrome.mjs';

const args = process.argv.slice(2);
const [SPEC, OUT_ARG] = args.filter((a) => !a.startsWith('--'));
const only = (args.find((a) => a.startsWith('--map=')) || '').slice(6);
const OUT = path.resolve(OUT_ARG || 'scripts/shots');
const BASE = process.env.BASE || 'http://127.0.0.1:5210';
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const [map, views] of Object.entries(spec)) {
    if (only && map !== only) continue;
    const dir = path.join(OUT, map); fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.goto(`${BASE}/?nolock=1&gfx=high`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.evaluate(() => document.getElementById('btn-enter')?.click());
    await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
    await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, map);
    await page.evaluate(() => document.getElementById('btn-practice').click());
    await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const G = window.BREACH;
      G.player = null;
      if (G.dummies) G.dummies.update = () => {};
      for (const d of G.dummies?.list ?? []) d.rig.root.visible = false;
      if (window.BREACH_VM?.root) window.BREACH_VM.root.visible = false;
      for (const id of ['hud', 'fp-hud', 'reticle']) { const el = document.getElementById(id); if (el) el.style.visibility = 'hidden'; }
      document.body.classList.add('shot-clean');
    });
    for (const v of views) {
      await page.evaluate(async (v) => {
        const { eyeWorld } = await import('/src/combat/hit-pose.js');
        const G = window.BREACH, W = window.BREACH_WORLD, cam = window.BREACH_CAM;
        const ground = (x, z) => W.groundHeight({ x, z }, 0.38, 6);
        const poseOf = (p) => p === 'crouch' ? { st: 'crouch', ce: 0 } : { st: 'idle' };
        const [x, z] = v.at, y = ground(x, z);
        const yaw = Math.atan2(-(v.look[0] - x), -(v.look[2] - z));
        const e = eyeWorld(poseOf(v.pose), x, y, z, yaw);
        // enemigos de referencia: los muñecos de práctica, quietos en su sitio
        const list = G.dummies?.list ?? [];
        list.forEach((d, i) => {
          const f = v.foes?.[i];
          d.rig.root.visible = !!f;
          if (!f) return;
          const fy = ground(f[0], f[1]);
          const fyaw = f[3] ?? Math.atan2(-(x - f[0]), -(z - f[1]));
          d.rig.setTransform(f[0], f[1], fyaw, fy);
          for (let k = 0; k < 30; k++) d.rig.update(1 / 30, { state: f[2] === 'crouch' ? 'crouch' : 'idle', speed: 0, aim: false, aimPitch: 0, coverAimExposure: 0 });
        });
        const apply = () => { cam.up.set(0, 1, 0); cam.fov = 72; cam.updateProjectionMatrix(); cam.position.set(e[0], e[1], e[2]); cam.lookAt(v.look[0], v.look[1], v.look[2]); };
        apply();
        window.__fpFrame = apply;
      }, v);
      // el bucle del juego puede tocar la cámara: se reaplica cada cuadro
      await page.evaluate(() => new Promise((res) => { let n = 0; const tick = () => { window.__fpFrame(); if (++n < 20) requestAnimationFrame(tick); else res(); }; tick(); }));
      await page.evaluate(() => window.__fpFrame());
      await page.locator('#game').screenshot({ path: path.join(dir, `${v.name}.png`) });
      console.log('cuadro', map, v.name);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
