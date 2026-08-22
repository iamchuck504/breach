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
const CHROME = 'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8797' }, stdio: 'ignore',
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
  ['aerea', [0, 44, -40], [0, 0, 2]],
  ['spawn', [-4, 2.2, -19.5], [2, 1.6, -26]],
  ['campo', [8, 2.6, -12], [-4, 1.4, 2]],
  ['fachada-centro', [-10.5, 3.0, -2.5], [-18.5, 3.1, 0]],
  ['fachada-sur', [-10.5, 3.3, -18], [-18.5, 4.2, -23.8]],
  ['fachada-norte', [10.5, 3.0, -7], [18.5, 2.8, -11.8]],
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
