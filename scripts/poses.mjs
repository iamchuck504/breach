// Verificación de poses del rig: screenshots orbitando al personaje +
// chequeo numérico de que el cañón apunta hacia el facing del personaje.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8792' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const gunCheck = `(() => {
  const G = window.BREACH;
  const R = G.rig;
  const v = new window.THREE.Vector3();
  R.gunForward(v);
  const f = G.player.facing();
  // distancia de cada mano a su ancla en el arma (deben estar EN el arma)
  R.root.updateWorldMatrix(true, true);
  const a = new window.THREE.Vector3(), b = new window.THREE.Vector3();
  const gun = R.activeGun;
  R.armR.hand.getWorldPosition(a); gun.userData.grip.getWorldPosition(b);
  const handR = +a.distanceTo(b).toFixed(3);
  R.armL.hand.getWorldPosition(a); gun.userData.forend.getWorldPosition(b);
  const handL = +a.distanceTo(b).toFixed(3);
  return { dot: +(v.x * f.x + v.z * f.z).toFixed(3), y: +v.y.toFixed(3), state: G.player.animState(), handR, handL };
})()`;

let browser;
const problems = [];
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => problems.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8792/', { waitUntil: 'networkidle' });
  await page.click('#btn-practice');
  await page.waitForTimeout(800);

  // campo abierto + cámara orbitada para ver al personaje de frente-lado
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.pos.x = 0; G.player.pos.z = -6;
    G.player.cam.yaw = Math.PI * 0.72;
    G.player.cam.pitch = -0.15;
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-idle.png') });
  const idle = await page.evaluate(gunCheck);
  console.log('IDLE:', JSON.stringify(idle));
  if (idle.dot < 0.7) problems.push('idle: cañón no apunta al frente (dot=' + idle.dot + ')');

  // el cuerpo debe seguir a la cámara en reposo, con la retícula cerca del centro
  const track = await page.evaluate(() => {
    const G = window.BREACH;
    let d = G.player.cam.yaw - G.player.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const el = document.getElementById('barrel-dot');
    return {
      yawDiff: +Math.abs(d).toFixed(3),
      dotOn: el.classList.contains('on'),
      dx: +(parseFloat(el.style.left) - innerWidth / 2).toFixed(0),
      dy: +(parseFloat(el.style.top) - innerHeight / 2).toFixed(0),
    };
  });
  console.log('TRACK:', JSON.stringify(track));
  if (track.yawDiff > 0.15) problems.push('idle: el cuerpo no sigue a la cámara (yawDiff=' + track.yawDiff + ')');
  if (!track.dotOn || Math.abs(track.dx) > 150 || Math.abs(track.dy) > 150) {
    problems.push('retícula lejos del centro: ' + JSON.stringify(track));
  }

  // ADS
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-aim.png') });
  const aim = await page.evaluate(gunCheck);
  console.log('AIM:', JSON.stringify(aim));
  if (aim.dot < 0.85) problems.push('aim: cañón no apunta al frente (dot=' + aim.dot + ')');
  for (const [nm, st] of [['idle', idle], ['aim', aim]]) {
    if (st.handR > 0.08) problems.push(nm + ': mano derecha fuera del arma (' + st.handR + 'm)');
    if (st.handL > 0.14) problems.push(nm + ': mano izquierda fuera del arma (' + st.handL + 'm)');
  }
  await page.mouse.up({ button: 'right' });

  // roadie (perfil)
  await page.keyboard.down('Shift');
  await page.keyboard.down('a');
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-roadie.png') });
  await page.keyboard.up('a'); await page.keyboard.up('Shift');

  // cover contra el bloque central bajo
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.pos.x = -1.8; G.player.pos.z = -3.2;
    G.player.cam.yaw = Math.PI * 0.65;
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  await page.keyboard.press(' ');
  await page.keyboard.up('w');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-cover.png') });
  const cover = await page.evaluate(`(() => window.BREACH.player.state)()`);
  console.log('COVER STATE:', cover);
} catch (e) {
  problems.push('FATAL: ' + e.message);
} finally {
  await browser?.close();
  server.kill();
}

if (problems.length) {
  for (const p of problems) console.log('PROBLEMA: ' + p);
  process.exit(1);
}
console.log('POSES OK');
