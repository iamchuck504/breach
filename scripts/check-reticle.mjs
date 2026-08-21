// Regresión visual/funcional: después de un giro brusco, un disparo central
// sin spread debe proyectarse exactamente debajo de la retícula hipfire.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8790',
], { cwd: root, stdio: 'ignore' });

let browser;
try {
  await new Promise((resolve) => setTimeout(resolve, 900));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 880, height: 640 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('http://localhost:8790/?nolock=1', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(1800);

  // Inicializar la retícula en una orientación y luego cambiarla de golpe:
  // esto reproduce el lag que mostraba la captura del usuario.
  await page.evaluate(() => {
    const G = window.BREACH;
    G.weapons.cur = 'smg';
    G.weapons.st.mag = 50;
    G.weapons.st.cd = 0;
    G.player.cam.pitch = -0.48;
    G.player.cam.yaw = 0;
    G.player.yaw = 0;
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.cam.yaw = 1.05;
    G.player.yaw = 1.05; // ya alineado: aislar únicamente retícula vs trayectoria
    window.__reticleImpact = null;
    window.__oldImpact = window.BREACH_EFFECTS.impact.bind(window.BREACH_EFFECTS);
    window.BREACH_EFFECTS.impact = (point, normal, surface) => {
      window.__reticleImpact = point.clone();
      return window.__oldImpact(point, normal, surface);
    };
    window.__oldRandom = Math.random;
    window.__rays = {};
    window.__oldRaycastHit = window.BREACH_WORLD.raycastHit.bind(window.BREACH_WORLD);
    window.BREACH_WORLD.raycastHit = (origin, dir, maxDist) => {
      const hit = window.__oldRaycastHit(origin, dir, maxDist);
      if (maxDist === 60 || maxDist === 80) {
        window.__rays[maxDist] = {
          origin: origin.toArray(), dir: dir.toArray(), t: hit?.t ?? null,
        };
      }
      return hit;
    };
    Math.random = () => 0; // pellet central: spread exactamente cero
    window.BREACH_INPUT._mouseFire = true;
    window.BREACH_INPUT.firePressed = true;
  });
  await page.waitForTimeout(55);
  const result = await page.evaluate(() => {
    window.BREACH_INPUT._mouseFire = false;
    Math.random = window.__oldRandom;
    window.BREACH_EFFECTS.impact = window.__oldImpact;
    window.BREACH_WORLD.raycastHit = window.__oldRaycastHit;
    const point = window.__reticleImpact;
    if (!point) return { error: 'el disparo no impactó geometría' };
    const projected = point.clone().project(window.BREACH_CAM);
    const expected = {
      x: (projected.x * 0.5 + 0.5) * innerWidth,
      y: (-projected.y * 0.5 + 0.5) * innerHeight,
    };
    const dot = document.getElementById('barrel-dot');
    const actual = { x: parseFloat(dot.style.left), y: parseFloat(dot.style.top) };
    const rr = window.__rays[60];
    const reticlePoint = rr
      ? new window.THREE.Vector3(...rr.origin).addScaledVector(
        new window.THREE.Vector3(...rr.dir), rr.t ?? 60).project(window.BREACH_CAM)
      : null;
    return {
      expected, actual,
      errorPx: Math.hypot(expected.x - actual.x, expected.y - actual.y),
      visible: dot.classList.contains('on'),
      rays: window.__rays,
      projectedReticleRay: reticlePoint ? {
        x: (reticlePoint.x * 0.5 + 0.5) * innerWidth,
        y: (-reticlePoint.y * 0.5 + 0.5) * innerHeight,
      } : null,
    };
  });

  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  if (result.error) throw new Error(result.error);
  if (!result.visible) throw new Error('la retícula no estaba visible');
  if (result.errorPx > 4) {
    console.error('RETICLE DEBUG', JSON.stringify(result));
    throw new Error(`retícula separada ${result.errorPx.toFixed(1)} px del impacto central`);
  }

  // ADS obstruido: la cámara alcanza un punto lejano, pero una pared ficticia
  // queda inmediatamente delante del muzzle. El anillo debe desplazarse al
  // impacto físico y no quedarse fijo en el centro de la pantalla.
  const ads = await page.evaluate(async () => {
    const G = window.BREACH;
    const W = window.BREACH_WORLD;
    const I = window.BREACH_INPUT;
    G.weapons.cur = 'smg';
    G.player.cam.yaw = 0.35;
    G.player.yaw = 0.35;
    I._mouseAim = true;
    await new Promise((resolve) => setTimeout(resolve, 180));

    G.rig.root.updateWorldMatrix(true, true);
    const muzzle = G.rig.muzzleWorld(new window.THREE.Vector3()).clone();
    const cameraOrigin = G.player.cam.aimRay().origin.clone();
    const oldRaycastHit = W.raycastHit.bind(W);
    const oldRaycast = W.raycast.bind(W);
    let expected = null;
    W.raycastHit = (origin, dir, maxDist) => {
      if (origin.distanceTo(cameraOrigin) < 0.08) {
        return { t: Math.min(24, maxDist), normal: { x: 0, y: 0, z: 1 }, surface: 'stone' };
      }
      if (origin.distanceTo(muzzle) < 0.12) {
        const t = Math.min(0.55, maxDist);
        expected = origin.clone().addScaledVector(dir, t);
        return { t, normal: { x: 0, y: 0, z: 1 }, surface: 'stone' };
      }
      return oldRaycastHit(origin, dir, maxDist);
    };
    W.raycast = () => null;
    await new Promise((resolve) => setTimeout(resolve, 70));

    const ring = document.getElementById('crosshair');
    const projected = expected?.clone().project(window.BREACH_CAM);
    const expectedXY = projected ? {
      x: (projected.x * 0.5 + 0.5) * innerWidth,
      y: (-projected.y * 0.5 + 0.5) * innerHeight,
    } : null;
    const actual = { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) };
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    I._mouseAim = false;
    return {
      visible: ring.classList.contains('aim'),
      expected: expectedXY,
      actual,
      errorPx: expectedXY ? Math.hypot(expectedXY.x - actual.x, expectedXY.y - actual.y) : Infinity,
      movedFromCenter: Math.hypot(actual.x - innerWidth * 0.5, actual.y - innerHeight * 0.5),
    };
  });
  if (!ads.visible || !ads.expected || ads.errorPx > 4 || ads.movedFromCenter < 8) {
    console.error('ADS RETICLE DEBUG', JSON.stringify(ads));
    throw new Error('la retícula ADS no siguió el impacto físico bloqueado desde el muzzle');
  }
  console.log(`RETICLE OK · hip ${result.errorPx.toFixed(2)} px · ADS obstruido ${ads.errorPx.toFixed(2)} px`);
} finally {
  await browser?.close();
  server.kill();
}
