// SONDA VISUAL: dice qué malla hay en un punto del mapa y cuánto mide, para
// derivar colisión de lo que realmente se dibuja (nunca a ojo).
//   node scripts/probe-visual.mjs <mapa> "x,y,z,dx,dy,dz" ["x,y,z,dx,dy,dz" ...]
// Cada sonda lanza un rayo desde (x,y,z) en la dirección (dx,dy,dz) y reporta
// la primera malla opaca: nombre, cadena de padres, color, caja en mundo de
// la malla y, para mallas grandes (kits fusionados), la extensión LOCAL del
// volumen alrededor del impacto medida con un barrido de rayos.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT = process.argv[2] || 'fortaleza';
const probes = process.argv.slice(3).map((s) => s.split(',').map(Number));
const PORT = 8822;
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
try {
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate((layout) => { window.BREACH.mapChoice = layout; document.getElementById('btn-practice').click(); }, LAYOUT);
  await page.waitForTimeout(3000);
  const out = await page.evaluate((probes) => {
    const W = window.BREACH_WORLD, T = window.THREE;
    const caster = new T.Raycaster();
    caster.camera = window.BREACH_CAM;
    const first = (o, d, far = 60) => {
      caster.set(o, d.clone().normalize()); caster.far = far;
      for (const h of caster.intersectObjects(W.mapGroup.children, true)) {
        if (!h.object.isMesh) continue;
        // Raycaster no mira `visible`: una malla oculta (ella o un ancestro) no es dibujo
        let hidden = false;
        for (let o = h.object; o; o = o.parent) if (o.visible === false) { hidden = true; break; }
        if (hidden) continue;
        const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
        if (m?.transparent) continue;
        return h;
      }
      return null;
    };
    const r2 = (v) => +v.toFixed(2);
    return probes.map(([x, y, z, dx, dy, dz]) => {
      const h = first(new T.Vector3(x, y, z), new T.Vector3(dx, dy, dz));
      if (!h) return { probe: [x, y, z, dx, dy, dz], hit: null };
      const chain = [];
      for (let o = h.object; o && o !== W.mapGroup; o = o.parent) chain.push(o.name || o.type);
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      const box = new T.Box3().setFromObject(h.object);
      // extensión local: barrido top-down en una rejilla de 3 m alrededor del
      // impacto; reúne las celdas con volumen conectado al punto
      const p = h.point, cells = [];
      const down = new T.Vector3(0, -1, 0);
      for (let ax = -3; ax <= 3; ax += 0.1) for (let az = -3; az <= 3; az += 0.1) {
        const t = first(new T.Vector3(p.x + ax, 8, p.z + az), down, 7.9);
        if (t && 8 - t.distance > 0.25 && t.object === h.object) cells.push([p.x + ax, p.z + az, 8 - t.distance]);
      }
      // componente conectada al impacto (vecindad de 0.15 m)
      const seen = new Set(), queue = [];
      let start = -1, best = 1e9;
      cells.forEach((c, i) => { const d = Math.hypot(c[0] - p.x, c[1] - p.z); if (d < best) { best = d; start = i; } });
      if (start >= 0) { seen.add(start); queue.push(start); }
      while (queue.length) {
        const i = queue.pop();
        cells.forEach((c, j) => { if (!seen.has(j) && Math.abs(c[0] - cells[i][0]) < 0.16 && Math.abs(c[1] - cells[i][1]) < 0.16) { seen.add(j); queue.push(j); } });
      }
      const comp = [...seen].map((i) => cells[i]);
      const local = comp.length ? {
        x: [r2(Math.min(...comp.map((c) => c[0]))), r2(Math.max(...comp.map((c) => c[0])))],
        z: [r2(Math.min(...comp.map((c) => c[1]))), r2(Math.max(...comp.map((c) => c[1])))],
        topMax: r2(Math.max(...comp.map((c) => c[2]))), cells: comp.length,
      } : null;
      return {
        probe: [x, y, z, dx, dy, dz], at: [r2(p.x), r2(p.y), r2(p.z)], dist: r2(h.distance),
        chain: chain.join(' < '), material: m?.name || m?.type, color: m?.color ? '#' + m.color.getHexString() : null,
        meshBox: { x: [r2(box.min.x), r2(box.max.x)], y: [r2(box.min.y), r2(box.max.y)], z: [r2(box.min.z), r2(box.max.z)] },
        local,
      };
    });
  }, probes);
  for (const o of out) console.log(JSON.stringify(o));
} finally {
  await browser.close(); server.kill(); await clearClip();
}
