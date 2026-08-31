// Capturas headless del mapa Fortaleza desde varios ángulos (verificación
// visual del retheme sin abrir ventana). Congela el frame loop del jugador
// (G.player = null) para poder colocar la cámara a mano.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

// El servidor online publica dist/, que puede pertenecer a una build anterior
// o estar bloqueada por el sitio live. Para QA visual necesitamos renderizar
// exactamente el código fuente de esta rama, por eso la captura usa Vite.
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8797', '--strictPort',
], {
  env: { ...process.env }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const LAYOUT = process.argv[2] || 'fortaleza'; // node scripts/shot-map.mjs [mapa]
await page.goto('http://localhost:8797/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate((l) => {
  localStorage.setItem('breach.map', l);
  window.BREACH.mapChoice = l; // G.mapChoice ya se leyó al cargar el módulo
}, LAYOUT);
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1200);

// soltar la cámara: sin G.player el loop no la pisa cada frame
await page.evaluate(() => { window.BREACH.player = null; document.getElementById('hud').classList.remove('on'); });

const shots = LAYOUT === 'azoteas' ? [
  ['aerea', [0, 66, -60], [0, 0, 3]],
  ['spawn', [-5, 2.2, -29.5], [3, 1.6, -39]],
  ['campo', [12, 2.6, -18], [-6, 1.4, 3]],
  ['centro', [10, 3.4, -10], [0, 0.6, 0]],
] : LAYOUT === 'calle' ? [
  ['aerea', [0, 64, -62], [0, 0, 2]],
  ['spawn', [-4, 2.2, -31.5], [2, 1.6, -38]],
  ['campo', [8, 2.6, -24], [-4, 1.4, 2]],
  ['continuidad-sur', [0, 2.4, -40], [0, 2.1, -78]],
  ['continuidad-norte', [0, 2.4, 40], [0, 2.1, 78]],
  ['fachada-centro', [-10.5, 3.0, -2.5], [-18.5, 3.1, 0]],
  ['fachada-sur', [-10.5, 3.3, -30], [-18.5, 4.2, -35.8]],
  ['fachada-norte', [10.5, 3.0, -19], [18.5, 2.8, -23.8]],
  ['bus-frontal', [-10.5, 2.15, -34.5], [0, 1.55, -34.5]],
  ['bus-lateral', [0, 2.15, -27.2], [0, 1.55, -34.5]],
  ['truck-frontal', [-6.5, 2.05, -7.2], [-6.5, 1.45, -1.5]],
  ['truck-lateral', [0.8, 2.05, -1.5], [-6.5, 1.45, -1.5]],
] : [
  ['aerea', [0, 44, -40], [0, 0, 2]],
  ['spawn', [-4, 2.2, -19.5], [2, 1.6, -26]],
  ['campo', [8, 2.6, -12], [-4, 1.4, 2]],
  ['muralla', [-14, 2.0, -12], [-22, 3.4, 6]],
];
for (const [name, pos, at] of shots) {
  await page.evaluate(([p, a]) => {
    const cam = window.BREACH_CAM;
    cam.position.set(p[0], p[1], p[2]);
    cam.lookAt(a[0], a[1], a[2]);
  }, [pos, at]);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(root, 'scripts', `shot-${LAYOUT}-${name}.png`) });
  console.log('shot', name);
}
await browser.close();
server.kill();
clearClip();
