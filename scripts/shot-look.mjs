// CAPTURAS DEL LOOK de un mapa, contra un servidor de desarrollo YA abierto
// (no levanta el suyo: varias capturas pueden correr a la vez).
//   BASE=http://127.0.0.1:5210 node scripts/shot-look.mjs <mapa> <carpeta> [opciones]
//   --look=classic        el mapa como estaba antes del look (para comparar)
//   --life=flora,atmos    solo esas capas de vida ("--life=" = ninguna)
//   --gfx=high            nivel de calidad gráfica (por defecto high)
//   --only=a,b            solo las cámaras con esos nombres
//   --cam=nombre:x,y,z:tx,ty,tz   cámara extra (se puede repetir)
//   --frames=2 --gap=700  varias capturas por cámara, separadas (ver movimiento)
//   --stats               imprime el costo de la capa de look y del cuadro
//   --dump                imprime el inventario de materiales del mapa
//   --player=x,z,yaw      además, una captura en tercera persona con el soldado
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME } from './lib-chrome.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--') && !a.startsWith('--cam=')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));
const [MAP = 'fortaleza', OUT_ARG = 'scripts/shots'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.resolve(OUT_ARG);
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || 'http://127.0.0.1:5210';

// [nombre, posición de cámara, punto al que mira]; z negativo = lado rojo
const CAMS = {
  fortaleza: [
    ['patio', [-9, 2.2, -7], [3, 1, 0]],
    ['patio-largo', [0, 2.6, -19.5], [0, 1.6, 6]],
    ['cobertura', [5.2, 1.7, -11.5], [-2, 0.9, -4]],
    ['torre', [-13, 2.0, 9], [0, 2.2, 0]],
    ['galeria', [23.7, 4.7, -6], [8, 0.5, 2]],
    ['liza-oeste', [-30, 2.0, -20], [-29, 1.4, 4]],
    ['patio-armas', [0, 2.4, -33.5], [0, 1.6, -20]],
    ['muralla', [-12, 6.5, -30], [6, 1, -6]],
    ['panoramica', [-30, 17, -42], [0, 0, -4]],
  ],
};
const cams = [...(CAMS[MAP] ?? [])];
for (const a of args.filter((x) => x.startsWith('--cam='))) {
  const [name, p, t] = a.slice(6).split(':');
  cams.push([name, p.split(',').map(Number), t.split(',').map(Number)]);
}
const only = flags.only ? flags.only.split(',') : null;
const frames = Math.max(1, Number(flags.frames) || 1), gap = Number(flags.gap) || 700;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /\[look\]|THREE\.WebGLProgram|shader/i.test(m.text())) console.log('CONSOLA:', m.text().slice(0, 900)); });
  const q = new URLSearchParams({ nolock: '1', gfx: flags.gfx || 'high' });
  if (flags.look) q.set('look', flags.look);
  if (flags.life !== undefined) q.set('life', flags.life === '1' ? '' : flags.life);
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
  await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, MAP);
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: 60000 });
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    for (const d of window.BREACH.dummies?.list ?? []) { d.alive = false; d.respawnT = 1e9; d.rig.root.visible = false; }
    window.BREACH.player = null; document.getElementById('hud').classList.remove('on');
  });
  if (flags.dump) {
    const rows = await page.evaluate(() => {
      const seen = new Map();
      window.BREACH_WORLD.mapGroup.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          let top = o; while (top.parent && top.parent !== window.BREACH_WORLD.mapGroup) top = top.parent;
          const key = m.uuid;
          const row = seen.get(key) ?? { type: m.type.replace('Mesh', '').replace('Material', ''), name: m.name, color: m.color ? '#' + m.color.getHexString() : '', map: !!m.map, emissive: m.emissive ? '#' + m.emissive.getHexString() : '', transparent: m.transparent, meshes: 0, tris: 0, owner: top.name || o.name || '(sin nombre)', sample: o.name };
          row.meshes++; const g = o.geometry; row.tris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1);
          seen.set(key, row);
        }
      });
      return [...seen.values()].sort((a, b) => b.tris - a.tris);
    });
    for (const r of rows) console.log(JSON.stringify(r));
  }
  for (const [name, pos, at] of cams) {
    if (only && !only.includes(name)) continue;
    await page.evaluate(([p, a]) => {
      const cam = window.BREACH_CAM;
      cam.up.set(0, 1, 0); cam.fov = 70; cam.updateProjectionMatrix();
      cam.position.set(p[0], p[1], p[2]); cam.lookAt(a[0], a[1], a[2]);
    }, [pos, at]);
    await page.waitForTimeout(450);
    for (let i = 0; i < frames; i++) {
      if (i) await page.waitForTimeout(gap);
      const file = path.join(OUT, `${MAP}-${name}${frames > 1 ? `-${i}` : ''}.png`);
      await page.locator('#game').screenshot({ path: file });
    }
    if (flags.stats) {
      const s = await page.evaluate(async () => {
        const R = window.BREACH_RENDERER; let calls = 0, tris = 0; const ms = []; let last = performance.now();
        await new Promise((res) => { const tick = (t) => { ms.push(t - last); last = t; calls = Math.max(calls, R.info.render.calls); tris = Math.max(tris, R.info.render.triangles); if (ms.length < 90) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
        ms.sort((a, b) => a - b);
        return { calls, tris, msMed: +ms[45].toFixed(2), msP95: +ms[85].toFixed(2) };
      });
      console.log('cam', name, JSON.stringify(s));
    } else console.log('shot', name);
  }
  // --player=x,z,yaw[,pitch]: una captura en tercera persona con el soldado en cuadro
  if (flags.player) {
    const [x, z, yaw, pitch = -0.04] = flags.player.split(',').map(Number);
    await page.goto(`${BASE}/?${q}`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.evaluate(() => document.getElementById('btn-enter')?.click());
    await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
    await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, MAP);
    await page.evaluate(() => document.getElementById('btn-practice').click());
    await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: 60000 });
    await page.waitForTimeout(3500);
    await page.evaluate(([x, z, yaw, pitch]) => {
      const G = window.BREACH, W = window.BREACH_WORLD, p = { x, z };
      W.resolveCircle(p, 0.4, 0);
      G.player.pos.x = p.x; G.player.pos.z = p.z; G.player.y = W.groundHeight(p, 0.4, 0);
      G.player.vel.x = G.player.vel.z = 0; G.player.yaw = yaw; G.player.cam.yaw = yaw; G.player.cam.pitch = pitch;
      document.getElementById('hud').style.visibility = 'hidden';
    }, [x, z, yaw, pitch]);
    await page.waitForTimeout(1200);
    await page.locator('#game').screenshot({ path: path.join(OUT, `${MAP}-jugador.png`) });
    console.log('shot jugador');
  }
  if (flags.stats) console.log('look', JSON.stringify(await page.evaluate(() => window.BREACH_WORLD.look.stats())));
} finally {
  await browser.close();
}
