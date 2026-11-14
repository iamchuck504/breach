// Revisión de las escaleras de las galerías laterales de Fortaleza: capturas
// desde varios puntos y un mapa de alturas del suelo físico en la llegada.
//   node scripts/shot-fort-stairs.mjs <carpeta>   (requiere dist/)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || 'artifacts/fort-stairs');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8838;
// [nombre, posición de cámara, punto al que mira]
const SHOTS = [
  ['subiendo-este-norte', [23.7, 3.4, 13.5], [23.7, 3.6, 7]],
  ['arriba-mirando-escalera', [23.7, 4.7, 4.5], [23.7, 2.6, 10]],
  ['arriba-cenital', [23.7, 5.7, 8.6], [23.7, 3, 8.5]],
  ['subiendo-este-sur', [23.7, 3.4, -13.5], [23.7, 3.6, -7]],
  ['subiendo-oeste-norte', [-23.7, 3.4, 13.5], [-23.7, 3.6, 7]],
  ['llegada-de-lado', [22.3, 4.4, 9.6], [24.6, 3, 7.6]],
  ['techo-desde-escalera', [23.7, 2.2, 12], [23.7, 7, 9.5]],
  ['techo-desde-rellano', [23.7, 4.2, 7], [23.7, 7, 11]],
  ['exterior-patio', [12, 4.5, 16], [22, 4, 11]],
  ['exterior-aereo', [10, 16, 22], [23.7, 5, 11]],
  ['exterior-aereo-fuera', [38, 14, 22], [24, 5, 11]],
  ['pie-escalera', [23.7, 1.7, 19.5], [23.7, 2.5, 12]],
  // con la cámara real del juego: [x, z, y, rumbo]
  ['juego-subiendo', 'player', [23.7, 12.5, 1.27, Math.PI]],
  ['juego-arriba', 'player', [23.7, 8.6, 2.77, Math.PI]],
  ['juego-rellano-mirando-atras', 'player', [23.7, 6.5, 3, 0]],
  ['juego-bajando', 'player', [23.7, 9.5, 2.42, 0]],
];
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
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; document.getElementById('btn-practice').click(); });
  await page.waitForFunction(() => !!window.BREACH.player, null, { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.evaluate((nc) => { window.__nocull = nc; }, process.env.NOCULL === '1');
  await page.evaluate(() => {
    const G = window.BREACH;
    document.getElementById('hud').style.visibility = 'hidden';
    for (const d of G.dummies?.list ?? []) d.rig.root.visible = false;
    G.rig.root.visible = false;
    // diagnóstico: mallas de la galería y si el recorte por cámara las oculta
    const info = [];
    G.player.world.mapGroup.traverse((o) => {
      if (!o.isMesh) return;
      let q = o, inGallery = false; while (q) { if (q.name === 'fortaleza-galleries') inGallery = true; q = q.parent; }
      if (!inGallery) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      info.push([o.name, o.isSkinnedMesh ? 'skinned' : o.isInstancedMesh ? 'inst' : 'mesh', o.material.side, o.material.transparent, [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(1)).join(' ')].join(' | '));
      if (window.__nocull) o.frustumCulled = false;
    });
    window.__info = info;
    const follow = G.player.cam, update = follow.update.bind(follow);
    window.__view = null;
    follow.update = (dt, player) => {
      update(dt, player);
      const v = window.__view; if (!v) return;
      const c = follow.camera;
      c.position.set(...v[0]); c.up.set(0, 1, 0); c.lookAt(...v[1]);
      if (c.fov !== 70) { c.fov = 70; c.updateProjectionMatrix(); }
    };
  });
  for (const [name, pos, look] of SHOTS) {
    if (pos === 'player') await page.evaluate((v) => {
      const G = window.BREACH, q = G.player; window.__view = null; G.rig.root.visible = true;
      q.pos.x = v[0]; q.pos.z = v[1]; q.y = v[2]; q.vy = 0; q.vel.x = q.vel.z = 0; q.grounded = true; q.cover = null;
      q.yaw = v[3]; q.cam.yaw = v[3]; q.cam.pitch = -0.1; q.cam._first = true; q.cam.camera.fov = 60; q.cam.camera.updateProjectionMatrix();
    }, look);
    else await page.evaluate((v) => { window.__view = v; window.BREACH.rig.root.visible = false; }, [pos, look]);
    await page.waitForTimeout(pos === 'player' ? 900 : 350);
    await page.locator('#game').screenshot({ path: path.join(OUT, name + '.png') });
  }
  console.log((await page.evaluate(() => window.__info)).join(String.fromCharCode(10)));
  // alturas del suelo físico en la llegada de la escalera este-norte
  const grid = await page.evaluate(() => {
    const W = window.BREACH.player.world, rows = [];
    for (let z = 11; z >= 5; z -= 0.5) {
      let r = `z ${z.toFixed(1).padStart(5)} |`;
      for (let x = 21.4; x <= 26.01; x += 0.4) {
        const y = z > 9 ? 2 : 3; // altura a la que camina el jugador en ese punto
        r += ' ' + W.groundHeight({ x, z }, 0.38, y).toFixed(1);
      }
      rows.push(r);
    }
    return rows.join('\n');
  });
  console.log('suelo físico (x 21.4 → 26.0, paso 0.4):\n' + grid);
} finally {
  await browser.close(); server.kill();
}
