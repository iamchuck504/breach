// MAPAS v2: comprueba el rediseño de Fortaleza, Azoteas y Calle Cerrada.
//  1. Diseño (sin navegador, sobre la geometría compartida): spawns que no se
//     ven desde la mitad rival, arma especial equidistante, cajas alcanzables,
//     varios carriles en media cancha y poco suelo lejos de un cover.
//  2. Paridad cliente/servidor: la misma altura de suelo y el mismo empuje de
//     colisión en una rejilla de puntos, incluidas rampas y plataformas.
//  3. En juego, con el controlador real: se sube por las rampas, se camina
//     sobre la plataforma, la baranda detiene y da cover, y se vuelve a bajar.
// Sirve dist/: `npm run build` antes.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';
import { analyze, DIMS } from './analyze-map.mjs';
import { serverMapPhysics } from '../server/map-geometry.js';
import { rampsFor, decksFor } from '../src/world/collision-layouts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const MAPS = ['fortaleza', 'azoteas', 'calle2'];

// ---------- 1. diseño ----------
for (const map of MAPS) {
  const r = analyze(map);
  check(`${map}: ningún spawn a la vista desde la mitad rival`, r.spawn.visibleFromEnemyHalfPct <= 0.5, `${r.spawn.visibleFromEnemyHalfPct} %`);
  check(`${map}: al menos 3 salidas del bolsillo de spawn`, r.spawn.exits.length >= 3, r.spawn.exits.join(' | '));
  check(`${map}: arma especial equidistante`, r.fair.special <= 0.5,
    `rojo ${r.routes.special.red.m} m · azul ${r.routes.special.blue.m} m`);
  check(`${map}: arma especial a más de 3 s de sprint de cualquier spawn`, r.routes.special.red.sprint >= 3, `${r.routes.special.red.sprint} s`);
  const crates = r.routes.crates;
  check(`${map}: cajas de munición alcanzables por ambos equipos`,
    crates.every((c) => Number.isFinite(c.red.m) && Number.isFinite(c.blue.m)), JSON.stringify(crates.map((c) => [c.red.m, c.blue.m])));
  // rotación de 180°: lo que un equipo tarda a su caja, el otro lo tarda a la suya
  check(`${map}: cajas equilibradas entre equipos`,
    Math.abs(crates[0].red.m - crates[1].blue.m) <= 1.5 && Math.abs(crates[0].blue.m - crates[1].red.m) <= 1.5,
    JSON.stringify(crates.map((c) => [c.red.m, c.blue.m])));
  check(`${map}: 3 o más carriles en media cancha`, r.lanes['z=0.0'].length >= 3, r.lanes['z=0.0'].join(' | '));
  check(`${map}: poco suelo a más de 4 m de un cover`, r.exposure.over4m <= 9, `${r.exposure.over4m} %`);
  check(`${map}: mezcla de distancias de combate`, r.sightlines.close >= 25 && r.sightlines.mid >= 25 && r.sightlines.long <= 25,
    `corta ${r.sightlines.close} % · media ${r.sightlines.mid} % · larga ${r.sightlines.long} %`);
}
check('azoteas y calle2 tienen plataforma con rampas', rampsFor('azoteas').length === 4 && rampsFor('calle2').length === 4,
  `azoteas ${rampsFor('azoteas').length} · calle2 ${rampsFor('calle2').length}`);

// ---------- 2 y 3. en juego ----------
const PORT = 8826;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });

  for (const map of MAPS) {
    const [fx, fz] = DIMS[map];
    const client = await page.evaluate(([m, fx, fz]) => {
      const W = window.BREACH_WORLD; W.setLayout(m);
      const out = [];
      for (let x = -fx + 0.37; x < fx; x += 0.93) for (let z = -fz + 0.41; z < fz; z += 0.97) for (const y of [0, 1.1, 1.9]) {
        const g = W.groundHeight({ x, z }, 0.38, y);
        const p = { x, z }; W.resolveCircle(p, 0.38, y);
        out.push(+g.toFixed(4), +p.x.toFixed(3), +p.z.toFixed(3));
      }
      return out;
    }, [map, fx, fz]);
    const physics = serverMapPhysics(map);
    let i = 0, diffG = 0, diffP = 0, n = 0, first = '';
    for (let x = -fx + 0.37; x < fx; x += 0.93) for (let z = -fz + 0.41; z < fz; z += 0.97) for (const y of [0, 1.1, 1.9]) {
      const g = physics.groundHeight({ x, z }, 0.38, y);
      const p = { x, z }; physics.resolveCircle(p, 0.38, y);
      if (Math.abs(g - client[i]) > 1e-3) { diffG++; first ||= `suelo en ${x.toFixed(2)},${z.toFixed(2)} y${y}: servidor ${g.toFixed(3)} cliente ${client[i]}`; }
      // el helipuerto tiene barandas en segmentos que el adaptador del servidor no empuja
      if (map !== 'azoteas' && Math.hypot(p.x - client[i + 1], p.z - client[i + 2]) > 2e-3) { diffP++; first ||= `empuje en ${x.toFixed(2)},${z.toFixed(2)} y${y}`; }
      i += 3; n++;
    }
    check(`${map}: suelo y colisión iguales en cliente y servidor`, diffG === 0 && diffP === 0, `${n} puntos · suelo ${diffG} · empuje ${diffP} ${first}`);
  }

  // controlador real: caminar con W mantenida hasta cumplir una condición
  const play = async (map) => {
    await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, map);
    await page.evaluate(() => document.getElementById('btn-practice').click());
    await page.waitForFunction(() => !!window.BREACH.player && window.BREACH.player.canMove !== false, null, { timeout: 15000 });
    await page.waitForTimeout(2600); // retardo de entrada del inicio de ronda
  };
  const walk = async (from, yaw, until, maxMs = 6000, arg = null) => {
    await page.evaluate(([f, yaw]) => {
      const p = window.BREACH.player; p.pos.x = f.x; p.pos.z = f.z; p.y = f.y ?? 0; p.vy = 0; p.grounded = true;
      p.yaw = yaw; p.cam.yaw = yaw; window.__trace = { maxStep: 0, lastY: p.y, maxY: p.y };
      const tick = () => { const q = window.BREACH.player; if (!q || !window.__trace) return; const t = window.__trace;
        t.maxStep = Math.max(t.maxStep, Math.abs(q.y - t.lastY)); t.lastY = q.y; t.maxY = Math.max(t.maxY, q.y); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }, [from, yaw]);
    await page.keyboard.down('KeyW');
    let reached = true;
    try { await page.waitForFunction(until, arg, { timeout: maxMs }); } catch { reached = false; }
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(250);
    return page.evaluate((reached) => { const p = window.BREACH.player, t = window.__trace; window.__trace = null;
      return { reached, x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2), y: +p.y.toFixed(2), maxStep: +t.maxStep.toFixed(2), maxY: +t.maxY.toFixed(2) }; }, reached);
  };
  const NORTH = Math.PI, SOUTH = 0, EAST = -Math.PI / 2;

  // --- Azoteas: entreplanta oeste ---
  await play('azoteas');
  const deck = decksFor('azoteas')[0];
  let r = await walk({ x: deck.x, z: -10.6 }, NORTH, () => window.BREACH.player.pos.z > -1.5);
  check('azoteas: la rampa sur sube a la entreplanta', r.reached && Math.abs(r.y - deck.h) < 0.06 && r.maxStep < 0.45, JSON.stringify(r));
  r = await walk({ x: deck.x, z: 0, y: deck.h }, EAST, () => false, 1300);
  check('azoteas: la baranda detiene sobre la plataforma', r.x < deck.x + deck.w / 2 - 0.5 && Math.abs(r.y - deck.h) < 0.06, JSON.stringify(r));
  r = await walk({ x: deck.x, z: 0, y: deck.h }, NORTH, () => window.BREACH.player.pos.z > 10.2);
  check('azoteas: la rampa norte baja al suelo', r.reached && r.y < 0.06 && r.maxStep < 0.45, JSON.stringify(r));
  r = await walk({ x: deck.x - 6.5, z: 0 }, EAST, () => false, 1400);
  check('azoteas: desde el suelo la plataforma es un muro', r.x < deck.x - deck.w / 2 - 0.3 && r.y < 0.06, JSON.stringify(r));
  r = await walk({ x: deck.x - 4.2, z: -6.5 }, EAST, () => false, 1400);
  check('azoteas: no se sube a la rampa por el costado', r.maxY < 0.5, JSON.stringify(r));
  const rails = await page.evaluate((h) => {
    const W = window.BREACH_WORLD;
    return W.faces.filter((f) => f.baseY === h && Math.abs(f.h - 1.1) < 0.01).length;
  }, deck.h);
  check('azoteas: las barandas dan cover bajo a quien está arriba', rails >= 16, `caras ${rails}`);

  // --- Calle Cerrada: remolque ---
  await play('calle2');
  const trailer = decksFor('calle2')[0];
  r = await walk({ x: trailer.x, z: trailer.z - trailer.d / 2 - 4.2 }, NORTH, (z) => window.BREACH.player.pos.z > z, 6000, trailer.z - 0.6);
  check('calle2: la rampa sube al remolque', r.reached && Math.abs(r.y - trailer.h) < 0.06 && r.maxStep < 0.45, JSON.stringify(r));
  r = await walk({ x: trailer.x, z: trailer.z, y: trailer.h }, NORTH, (z) => window.BREACH.player.pos.z > z, 6000, trailer.z + trailer.d / 2 + 3.6);
  check('calle2: se baja por la otra rampa', r.reached && r.y < 0.06 && r.maxStep < 0.45, JSON.stringify(r));
  r = await walk({ x: trailer.x, z: trailer.z + trailer.d / 2 + 4.2 }, SOUTH, (z) => window.BREACH.player.pos.z < z, 6000, trailer.z + 0.6);
  check('calle2: también se sube desde el otro lado', r.reached && Math.abs(r.y - trailer.h) < 0.06, JSON.stringify(r));

  check('sin errores de página', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close(); server.kill(); await clearClip();
}
if (fails.length) { console.error(`\n✗ MAPAS v2: ${fails.length} fallo(s)`); process.exit(1); }
console.log('\n✓ MAPAS v2 OK');
