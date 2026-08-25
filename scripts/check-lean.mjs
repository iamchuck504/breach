// Verifica el shoulder swap: cover en pared alta, asomarse por la orilla
// IZQUIERDA en pantalla → la cámara debe pasar al hombro izquierdo.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8795' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8795/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
await page.click('#btn-enter');
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.click('#btn-practice');
await page.waitForTimeout(600);

// Forzar una orilla alta real del mapa. La entrada a cover ya tiene su propia
// suite; aquí aislamos el shoulder swap sin depender de coordenadas antiguas.
await page.evaluate(() => {
  const P = window.BREACH.player, W = window.BREACH_WORLD;
  const f = W.faces.find((face) => {
    const len = Math.hypot(face.b.x - face.a.x, face.b.z - face.a.z);
    return face.h > 1.1 && face.h <= 2.6 && len > 3;
  });
  if (!f) throw new Error('No se encontró una orilla alta de prueba');
  const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z;
  const len = Math.hypot(tx, tz), ux = tx / len, uz = tz / len;
  const u = 0.22;
  P.cover = f; P.state = 'cover'; P.stateT = 0;
  P.pos.x = f.a.x + ux * u + f.n.x * 0.38;
  P.pos.z = f.a.z + uz * u + f.n.z * 0.38;
  // Cámara derecha = tangente positiva; en el extremo A esto produce lean -1.
  P.cam.yaw = Math.atan2(-uz, ux); P.yaw = P.cam.yaw;
  P.vel.x = 0; P.vel.z = 0;
});
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(700);
const res = await page.evaluate(() => ({
  st: window.BREACH.player.state,
  aim: window.BREACH.player.aim,
  lean: window.BREACH.player.coverLeanAnim,
  camSide: +window.BREACH.player.cam._side.toFixed(2),
}));
console.log('LEAN:', JSON.stringify(res));
await page.screenshot({ path: path.join(root, 'scripts', 'shot-lean.png') });
await page.mouse.up({ button: 'right' });
await browser.close();
clearClip();
server.kill();
if (res.st !== 'cover' || !res.aim || res.camSide > -0.5) {
  console.log('PROBLEMA: swap de hombro no ocurrió');
  process.exit(1);
}
console.log('LEAN OK');
