// Verificación de poses del rig: screenshots orbitando al personaje +
// chequeo numérico de que el cañón apunta hacia el facing del personaje.
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

  await page.goto('http://localhost:8792/?nolock=1', { waitUntil: 'networkidle' });
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
  // el paralaje del punto crece cuando el ray pega en geometría cercana
  if (!track.dotOn || Math.abs(track.dx) > 230 || Math.abs(track.dy) > 230) {
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

  // hipfire: DISPARANDO, el cañón debe ser colineal con la línea de tiro real
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.pos.x = 0; P.pos.z = -6; P.cam.pitch = -0.3;
  });
  await page.mouse.down();
  await page.waitForTimeout(400);
  const fireAlign = await page.evaluate(`(() => {
    const G = window.BREACH;
    const v = new window.THREE.Vector3();
    G.rig.gunForward(v);
    const yaw = G.player.cam.yaw, p = G.player.cam.pitch;
    const d = new window.THREE.Vector3(
      -Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
    return +v.dot(d).toFixed(3);
  })()`);
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('FIREALIGN:', JSON.stringify({ dot: fireAlign }));
  if (fireAlign < 0.96) problems.push('hipfire: el cañón no es colineal con el tiro (dot=' + fireAlign + ')');

  // roadie (perfil)
  await page.keyboard.down('Shift');
  await page.keyboard.down('a');
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-roadie.png') });
  await page.keyboard.up('a'); await page.keyboard.up('Shift');

  // cover contra un bloque LOW (1.1) del mapa Fortaleza
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.pos.x = -1.5; G.player.pos.z = -4.4;
    G.player.cam.yaw = 0.2; G.player.yaw = 0.2;
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.press(' ');
  await page.keyboard.up('w');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-cover.png') });
  const cover = await page.evaluate(`(() => {
    const G = window.BREACH;
    G.rig.root.updateWorldMatrix(true, true);
    const v = new window.THREE.Vector3();
    G.rig.head.getWorldPosition(v);
    return { st: G.player.state, anim: G.player.animState(), headTop: +(v.y + 0.34).toFixed(2) };
  })()`);
  console.log('COVER:', JSON.stringify(cover));
  if (cover.anim === 'cover_low' && cover.headTop > 1.08) {
    problems.push('cover bajo: la cabeza asoma sobre el bloque LOW (top=' + cover.headTop + 'm vs 1.1)');
  }
} catch (e) {
  problems.push('FATAL: ' + e.message);
} finally {
  await browser?.close();
  clearClip();
  server.kill();
}

if (problems.length) {
  for (const p of problems) console.log('PROBLEMA: ' + p);
  process.exit(1);
}
console.log('POSES OK');
