// Sanity objetivo de TODOS los mapas: spawns válidos (4 por equipo, dentro
// de límites, libres de geometría y con bolsillo de cámara), cajas de
// munición y pedestal especial accesibles, suelo sólido bajo cada punto,
// simetría de spawns, y ambiente de audio activo por mapa.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8792' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

const MAPS = ['fortaleza', 'azoteas', 'calle', 'metro', 'prision', 'pueblo'];
await page.goto('http://localhost:8792/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });

for (const map of MAPS) {
  const r = await page.evaluate(async (m) => {
    const W = window.BREACH_WORLD, A = window.BREACH_AUDIO;
    W.setLayout(m);
    A.setAmbience(m);
    await new Promise((res) => setTimeout(res, 120));
    const clear = (x, z, rad) => {
      const p = { x, z };
      W.resolveCircle(p, rad, 0);
      return Math.hypot(p.x - x, p.z - z) < 0.02;
    };
    const inBounds = (x, z) => Math.abs(x) <= W.fx && Math.abs(z) <= W.fz;
    const spawnInfo = [];
    for (const team of ['red', 'blue']) {
      for (const s of W.spawns[team]) {
        spawnInfo.push({
          team, x: +s.x.toFixed(1), z: +s.z.toFixed(1),
          clear: clear(s.x, s.z, 0.4),
          bounds: inBounds(s.x, s.z),
          // bolsillo para la cámara (dist 2.7 detrás): sin muro pegado
          pocket: W.fz - Math.abs(s.z),
          ground: +W.groundHeight({ x: s.x, z: s.z }, 0.38, 0.2).toFixed(2),
        });
      }
    }
    // criterio de accesibilidad REAL: que quepa el jugador (PLAYER_R 0.38)
    // con un margen mínimo. Un radio mayor marca como "bloqueada" una caja
    // que solo está CERCA de un bloque bajo, que es legítimo (y deseable).
    const crates = (W.cratePos ?? [{ x: 7, z: 0 }, { x: -7, z: 0 }]).map((c) => ({
      x: c.x, z: c.z, clear: clear(c.x, c.z, 0.4), bounds: inBounds(c.x, c.z),
    }));
    const sp = W.specialSpot;
    const special = sp
      ? { x: sp.x, z: sp.z, clear: clear(sp.x, sp.z, 0.8), bounds: inBounds(sp.x, sp.z) }
      : null;
    // caras de cobertura utilizables por la IA (h <= 2.6) y alturas válidas
    const covers = W.faces.filter((f) => f.h <= 2.6).length;
    // 2.45 m corresponde a los laterales/trasera físicos del refugio de bus:
    // cover alto con la altura real del asset, no un bloque táctico genérico.
    const badHeights = [...new Set(W.faces.map((f) => +f.h.toFixed(2)))]
      .filter((h) => ![1.1, 1.9, 2.45, 3].includes(h));
    return {
      fx: W.fx, fz: W.fz, spawnInfo, crates, special, covers, badHeights,
      ambience: A._ambienceName, layout: W.layout,
    };
  }, map);

  const spawnsOk = r.spawnInfo.length === 8 &&
    r.spawnInfo.every((s) => s.clear && s.bounds && s.pocket >= 1.5 && s.ground < 0.5);
  check(`${map}: 8 spawns libres, dentro de límites y con bolsillo`, spawnsOk,
    spawnsOk ? `pocket min=${Math.min(...r.spawnInfo.map((s) => +s.pocket.toFixed(1)))}`
      : JSON.stringify(r.spawnInfo.filter((s) => !s.clear || !s.bounds || s.pocket < 1.5 || s.ground >= 0.5)));

  // simetría rotacional: cada spawn rojo tiene su espejo azul (-x, -z)
  const red = r.spawnInfo.filter((s) => s.team === 'red');
  const blue = r.spawnInfo.filter((s) => s.team === 'blue');
  const mirrored = red.every((s) => blue.some((b) =>
    Math.abs(b.x + s.x) < 0.05 && Math.abs(b.z + s.z) < 0.05));
  check(`${map}: spawns simétricos entre equipos`, mirrored,
    mirrored ? '' : JSON.stringify({ red, blue }));

  check(`${map}: cajas de munición accesibles`,
    r.crates.every((c) => c.clear && c.bounds), JSON.stringify(r.crates));

  if (r.special) {
    check(`${map}: pedestal especial accesible`, r.special.clear && r.special.bounds,
      JSON.stringify(r.special));
  }

  check(`${map}: alturas tácticas/estructurales válidas`, r.badHeights.length === 0,
    JSON.stringify(r.badHeights));
  check(`${map}: cobertura suficiente para la IA (>=20 caras)`, r.covers >= 20,
    `caras=${r.covers}`);
  if (map === 'calle') check('calle: extensión longitudinal 34×84 activa',
    r.fx === 17 && r.fz === 42, `fx=${r.fx}, fz=${r.fz}`);
  check(`${map}: ambiente de audio activo`, r.ambience === map, `amb=${r.ambience}`);
}

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nMAPS: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nMAPS: todo verde');
