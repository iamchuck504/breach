// Capturas COMPARABLES de un mapa: una aérea cenital (sin niebla) y varias a
// la altura del jugador desde puntos fijos (ambos spawns, media cancha y un
// flanco). Mismas cámaras siempre, para poner un antes y un después lado a
// lado. Renderiza el código fuente de la rama con Vite, sin abrir ventana.
//
//   node scripts/shot-map-compare.mjs <mapa> <carpeta-de-salida>
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT = process.argv[2] || 'fortaleza';
const OUT = path.resolve(process.argv[3] || path.join(root, 'scripts', 'shots'));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8798;
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
], { env: { ...process.env }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

// [nombre, posición de cámara, punto al que mira]; z negativo = lado rojo
const SHOTS = {
  fortaleza: [
    ['spawn-rojo', [0, 2.6, -25.8], [0, 1.4, -12]],
    ['spawn-azul', [0, 2.6, 25.8], [0, 1.4, 12]],
    ['salida-rojo', [6.3, 2.2, -22.6], [10, 1.2, -8]],
    ['patio-desde-rojo', [-3, 2.4, -18.5], [0, 1, 0]],
    ['centro', [-9, 2.2, -7], [3, 1, 0]],
    ['flanco-oeste', [-18.5, 2.2, -15], [-16, 1.2, 4]],
    ['galeria', [23.7, 4.7, -6], [8, 0.5, 2]],
  ],
  azoteas: [
    ['spawn-rojo', [0, 2.8, -38.8], [0, 1.4, -22]],
    ['spawn-azul', [0, 2.8, 38.8], [0, 1.4, 22]],
    ['salida-rojo', [7.5, 2.2, -33.5], [10, 1.2, -14]],
    ['centro-desde-rojo', [-4, 2.4, -20], [0, 1.2, 0]],
    ['flanco-oeste', [-26, 2.2, -19], [-18, 1.6, 2]],
    ['flanco-este', [24, 2.2, -24], [18, 1.6, 0]],
    ['sobre-entreplanta', [-17.5, 3.5, -1], [0, 1.2, 0]],
  ],
  calle2: [
    ['spawn-rojo', [0, 2.8, -40.6], [0, 1.4, -26]],
    ['spawn-azul', [0, 2.8, 40.6], [0, 1.4, 26]],
    ['salida-rojo', [-9, 2.2, -33], [-4, 1.3, -12]],
    ['avenida', [3, 2.4, -22], [2, 1.3, 0]],
    ['acera-este', [13.2, 2.2, -21.5], [13.2, 1.5, 0]],
    ['centro', [-11, 2.2, -9], [0, 1.2, 1]],
    ['callejon-oeste', [-25.5, 2.2, -17], [-25, 1.4, 4]],
    ['taller-este', [25.5, 2.2, -17], [25, 1.4, 4]],
    ['sobre-remolque', [10.4, 2.75, -17], [4, 1.2, 0]],
  ],
};
const HEIGHT = { fortaleza: 62, azoteas: 92, calle2: 96 };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=high`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, LAYOUT);
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(2500);
await page.evaluate(() => { window.BREACH.player = null; document.getElementById('hud').classList.remove('on'); });

const shoot = async (name, pos, at, { top = false } = {}) => {
  await page.evaluate(([p, a, top]) => {
    const cam = window.BREACH_CAM, scene = window.BREACH_WORLD.scene;
    if (top) { window.__fog = scene.fog; scene.fog = null; cam.up.set(1, 0, 0); cam.fov = 50; }
    else { if (window.__fog !== undefined) scene.fog = window.__fog; cam.up.set(0, 1, 0); cam.fov = 70; }
    cam.updateProjectionMatrix();
    cam.position.set(p[0], p[1], p[2]);
    cam.lookAt(a[0], a[1], a[2]);
  }, [pos, at, top]);
  await page.waitForTimeout(350);
  await page.locator('#game').screenshot({ path: path.join(OUT, `${LAYOUT}-${name}.png`) });
  console.log('shot', name);
};
await shoot('aerea', [0, HEIGHT[LAYOUT], 0], [0, 0, 0], { top: true });
for (const [name, pos, at] of SHOTS[LAYOUT]) await shoot(name, pos, at);
await browser.close();
server.kill();
await clearClip();
