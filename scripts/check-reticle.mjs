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
  await page.evaluate(() => {
    document.getElementById('btn-enter')?.click();
    document.getElementById('btn-practice').click();
  });
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
  console.log(`RETICLE OK · error central ${result.errorPx.toFixed(2)} px`);
} finally {
  await browser?.close();
  server.kill();
}
