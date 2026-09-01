// Diagnóstico de la cadena de puntería en hipfire: ¿qué eslabón desalinea
// el cañón? (aimRig vs gunMount vs geometría del arma nueva)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8788' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8788/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const P = window.BREACH.player;
  P.pos.x = 0; P.pos.z = -6; P.cam.pitch = -0.3;
  // instrumentar: capturar los params EXACTOS que recibe rig.update
  const R = window.BREACH.rig;
  const orig = R.update.bind(R);
  R.update = (dt, p) => { window.__lastP = p; return orig(dt, p); };
});
await page.mouse.down();
// línea de tiempo: ¿cuándo se enciende firing y hacia dónde va el mount?
const timeline = [];
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(120);
  timeline.push(await page.evaluate(() => {
    const G = window.BREACH, R = G.rig, lp = window.__lastP || {};
    return {
      f: lp.firing ? 1 : 0,
      held: window.BREACH_INPUT.fireHeld ? 1 : 0,
      buf: +G.fireBuffer.toFixed(2),
      rel: G.weapons.reloading ? 1 : 0,
      cd: +G.weapons.st.cd.toFixed(2),
      mx: +R.gunMount.rotation.x.toFixed(2),
      my: +R.gunMount.rotation.y.toFixed(2),
    };
  }));
}
console.log('TIMELINE:', JSON.stringify(timeline));
const d = await page.evaluate(() => {
  const G = window.BREACH, R = G.rig, T = window.THREE;
  const fwd = new T.Vector3();
  R.gunForward(fwd);
  const yaw = G.player.cam.yaw, p = G.player.cam.pitch;
  const dir = new T.Vector3(-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
  // forward del gunMount y del aimRig en mundo (sin la rotación local del arma)
  const q = new T.Quaternion();
  R.gunMount.getWorldQuaternion(q);
  const mountFwd = new T.Vector3(0, 0, -1).applyQuaternion(q);
  R.aimRig.getWorldQuaternion(q);
  const aimFwd = new T.Vector3(0, 0, -1).applyQuaternion(q);
  const gun = R.activeGun;
  const lp = window.__lastP || {};
  return {
    lastParams: { state: lp.state, firing: lp.firing, aim: lp.aim, swapping: lp.swapping, reloading: lp.reloading },
    firingBlind: +G.player.firingBlind.toFixed(2),
    camPitch: p, bodyYaw: +G.player.yaw.toFixed(3), camYaw: +yaw.toFixed(3),
    aimRigRot: R.aimRig.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(3)),
    mountRot: R.gunMount.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(3)),
    mountPos: R.gunMount.position.toArray().map((v) => +v.toFixed(3)),
    gunLocalRot: gun.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(3)),
    gunLocalPos: gun.position.toArray().map((v) => +v.toFixed(3)),
    dotGun: +fwd.dot(dir).toFixed(3),
    dotMount: +mountFwd.dot(dir).toFixed(3),
    dotAim: +aimFwd.dot(dir).toFixed(3),
  };
});
console.log(JSON.stringify(d, null, 1));
await page.mouse.up();
await browser.close();
server.kill();
clearClip();
