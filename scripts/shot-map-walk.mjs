// RECORRIDO A PIE de los rincones cerrados o techados de un mapa: en cada
// punto, cuatro vistas a la altura de los ojos (N, E, S, O, algo hacia
// arriba) para cazar huecos de muro o de techo que desde el aire no se ven.
// Deja una hoja por mapa: una fila por punto.
//   node scripts/shot-map-walk.mjs <mapa> <carpeta>   (requiere dist/)
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = process.argv[2] || 'azoteas';
const OUT = path.resolve(process.argv[3] || `artifacts/walk-${MAP}`);
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8840;
// [nombre, x, z, altura del suelo aproximada]
const SPOTS = {
  azoteas: [
    ['bajo-entreplanta-O', -17.5, 0, 0], ['bajo-entreplanta-E', 17.5, 0, 0],
    ['sobre-entreplanta-O', -17.5, 0, 1.9], ['sobre-entreplanta-E', 17.5, 0, 1.9],
    ['helipuerto', 0, 0, 2], ['salida-norte', 0, 34, 0], ['salida-sur', 0, -34, 0],
    ['esquina-NE', 27, 34, 0], ['esquina-SO', -27, -34, 0], ['lateral-O', -28, 12, 0], ['lateral-E', 28, -12, 0],
  ],
  calle2: [
    ['patio-O-centro', -25, 0, 0], ['patio-O-norte', -25, 15, 0], ['patio-O-sur', -25, -15, 0],
    ['patio-E-centro', 25, 0, 0], ['patio-E-norte', 25, 15, 0], ['patio-E-sur', 25, -15, 0],
    ['paso-NO', -19, 18, 0], ['paso-SO', -19, -18, 0], ['paso-NE', 19, 18, 0], ['paso-SE', 19, -18, 0],
    ['calle-norte', 0, 37, 0], ['calle-sur', 0, -37, 0], ['calle-centro', 0, 0, 0],
    ['remolque-E', 10.4, -15.5, 1.1], ['remolque-O', -10.4, 15.5, 1.1],
  ],
  fortaleza: [
    ['galeria-E-centro', 23.7, 0, 3], ['galeria-O-centro', -23.7, 0, 3],
    ['escalera-E-norte', 23.7, 12, 1.5], ['escalera-E-sur', 23.7, -12, 1.5],
    ['escalera-O-norte', -23.7, 12, 1.5], ['escalera-O-sur', -23.7, -12, 1.5],
    ['puerta-escalera-E-norte', 23.7, 17, 0], ['puerta-escalera-O-sur', -23.7, -17, 0],
    ['salida-norte', 0, 23.5, 0], ['salida-sur', 0, -23.5, 0], ['patio-centro', 3, 3, 0],
    ['esquina-NE', 18, 24, 0], ['esquina-SO', -18, -24, 0],
  ],
};
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
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
    const tag = document.createElement('div');
    tag.id = 'walk-tag';
    tag.style.cssText = 'position:fixed;left:8px;top:6px;z-index:99999;font:600 15px Arial;color:#fff;background:rgba(0,0,0,.65);padding:3px 8px;border-radius:4px';
    document.body.appendChild(tag);
    const follow = G.player.cam, update = follow.update.bind(follow);
    follow.update = (dt, player) => {
      update(dt, player);
      const v = window.__view; if (!v) return;
      const c = follow.camera;
      c.position.set(...v[0]); c.up.set(0, 1, 0); c.lookAt(...v[1]);
      if (c.fov !== 80) { c.fov = 80; c.updateProjectionMatrix(); }
    };
  });
  let n = 0;
  const moved = [];
  for (const [name, x, z, y] of SPOTS[MAP]) {
    // el punto se saca de cualquier caja con la propia colisión del juego
    const at = await page.evaluate(([x, z, y]) => {
      const W = window.BREACH.player.world, p = { x, z };
      W.resolveCircle(p, 0.5, y);
      return [p.x, p.z, W.groundHeight(p, 0.38, y + 0.3)];
    }, [x, z, y]);
    if (Math.hypot(at[0] - x, at[1] - z) > 0.05) moved.push(`${name} → ${at[0].toFixed(1)}, ${at[1].toFixed(1)}`);
    for (const [label, dx, dz] of [['N', 0, 1], ['E', 1, 0], ['S', 0, -1], ['O', -1, 0]]) {
      const eye = [at[0], at[2] + 1.6, at[1]];
      await page.evaluate(([v, t]) => { window.__view = v; window.BREACH.rig.root.visible = false; document.getElementById('walk-tag').textContent = t; },
        [[eye, [eye[0] + dx * 5, eye[1] + 1.1, eye[2] + dz * 5]], `${name} · ${label}`]);
      await page.waitForTimeout(260);
      await page.screenshot({ path: path.join(OUT, `f${String(n++).padStart(3, '0')}.png`) });
    }
  }
  if (moved.length) console.log('puntos recolocados fuera de un obstáculo:\n  ' + moved.join('\n  '));
  const rows = SPOTS[MAP].length;
  const half = Math.ceil(rows / 2);
  for (const [i, [from, count]] of [[0, half], [half, rows - half]].entries()) {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-start_number', String(from * 4), '-i', path.join(OUT, 'f%03d.png'),
      '-frames:v', '1', '-vf', `tile=4x${count}`, path.join(OUT, `..`, `${MAP}-recorrido-${i + 1}.png`)]);
    if (r.status !== 0) console.log('ffmpeg:', String(r.stderr).slice(0, 200));
  }
  console.log(MAP, n, 'capturas');
} finally {
  await browser.close(); server.kill();
}
