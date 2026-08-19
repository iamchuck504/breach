// Diagnóstico de ejes del mouse: mueve el mouse (real y sintético) y reporta
// cómo cambian yaw/pitch de la cámara, más el estado de invertY.
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
  env: { ...process.env, PORT: '8793' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://localhost:8793/?nolock=1', { waitUntil: 'networkidle' });
  await page.click('#btn-enter');
  await page.click('#btn-practice');
  await page.waitForTimeout(600);

  const read = () => page.evaluate(() => ({
    yaw: +window.BREACH.player.cam.yaw.toFixed(4),
    pitch: +window.BREACH.player.cam.pitch.toFixed(4),
    invertY: document.pointerLockElement ? undefined : undefined,
  }));
  const invertY = await page.evaluate(() => localStorage.getItem('breach.invertY'));
  const locked = await page.evaluate(() => !!document.pointerLockElement);
  console.log('locked:', locked, '| localStorage invertY:', JSON.stringify(invertY));

  // mouse real
  await page.mouse.move(640, 360);
  let a = await read();
  await page.mouse.move(840, 360, { steps: 4 }); // derecha
  let b = await read();
  console.log('MOUSE DERECHA: dyaw =', +(b.yaw - a.yaw).toFixed(4));

  a = await read();
  await page.mouse.move(840, 560, { steps: 4 }); // abajo (hacia el jugador)
  b = await read();
  console.log('MOUSE ABAJO:   dpitch =', +(b.pitch - a.pitch).toFixed(4), '(+ = mirar ARRIBA)');

  // sintético por si el real no genera movement en headless
  const syn = async (mx, my) => {
    const before = await read();
    await page.evaluate(([x, y]) => {
      window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y }));
    }, [mx, my]);
    await page.waitForTimeout(100);
    const after = await read();
    return { dyaw: +(after.yaw - before.yaw).toFixed(4), dpitch: +(after.pitch - before.pitch).toFixed(4) };
  };
  console.log('SINTETICO dx=+200 (derecha):', JSON.stringify(await syn(200, 0)));
  console.log('SINTETICO dy=+200 (abajo):  ', JSON.stringify(await syn(0, 200)));
} finally {
  await browser?.close();
  clearClip();
  server.kill();
}
