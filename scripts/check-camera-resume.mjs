import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8794',
], { cwd: root, stdio: 'ignore' });

let browser;
try {
  await new Promise((resolve) => setTimeout(resolve, 900));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('http://localhost:8794/?nolock=1', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(1700);

  const result = await page.evaluate(async () => {
    const G = window.BREACH;
    const input = window.BREACH_INPUT;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const moveMouse = (movementX, movementY) => {
      const event = new MouseEvent('mousemove');
      Object.defineProperties(event, {
        movementX: { value: movementX },
        movementY: { value: movementY },
      });
      window.dispatchEvent(event);
    };
    G.player.cam.yaw = 0.42;
    G.player.cam.pitch = -0.12;
    G.player.yaw = 0.42;

    input.onEscape();
    await wait(35);
    const beforeResume = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    input.mouseDX = 4800;
    input.mouseDY = -4800;
    document.getElementById('btn-resume').click();
    await wait(35);
    const afterResume = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };

    // El warp puede llegar DESPUÉS del frame protegido. Antes el test lo
    // inyectaba mientras el guard seguía activo y daba un falso positivo.
    input.discardLookDelta(1);
    await raf();
    await raf();
    const beforeRelock = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    moveMouse(-3600, 3600);
    await raf();
    const afterRelock = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };

    // El movimiento real siguiente sí responde: no dejamos muerto el mouse.
    const beforeRealMove = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    moveMouse(12, 8);
    await raf();
    const afterRealMove = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };

    // Un outlier durante gameplay vivo tampoco puede voltear la cámara. Este
    // caso cubre deltas acumulados por hitch aunque ya se consumió el guard.
    const beforeOutlier = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    moveMouse(1200, -1600);
    await raf();
    const afterOutlier = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };

    // Datos corruptos/no finitos nunca deben contaminar yaw/pitch.
    const beforeInvalid = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    input.mouseDX = Infinity;
    input.mouseDY = NaN;
    await raf();
    const afterInvalid = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    return { beforeResume, afterResume, beforeRelock, afterRelock,
      beforeRealMove, afterRealMove, beforeOutlier, afterOutlier,
      beforeInvalid, afterInvalid, guard: input._lookGuardFrames };
  });

  const angleDelta = (a, b) => Math.abs(a - b);
  const resumeJump = Math.max(angleDelta(result.beforeResume.yaw, result.afterResume.yaw),
    angleDelta(result.beforeResume.pitch, result.afterResume.pitch));
  const relockJump = Math.max(angleDelta(result.beforeRelock.yaw, result.afterRelock.yaw),
    angleDelta(result.beforeRelock.pitch, result.afterRelock.pitch));
  const realMove = Math.max(angleDelta(result.beforeRealMove.yaw, result.afterRealMove.yaw),
    angleDelta(result.beforeRealMove.pitch, result.afterRealMove.pitch));
  const outlierStep = Math.hypot(
    result.afterOutlier.yaw - result.beforeOutlier.yaw,
    result.afterOutlier.pitch - result.beforeOutlier.pitch,
  );
  const invalidStep = Math.max(angleDelta(result.beforeInvalid.yaw, result.afterInvalid.yaw),
    angleDelta(result.beforeInvalid.pitch, result.afterInvalid.pitch));
  const maxStep = 15 * Math.PI / 180;
  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  if (resumeJump > 0.0001) throw new Error(`delta del menú saltó la cámara (${resumeJump})`);
  if (relockJump > 0.0001) throw new Error(`delta tardío de re-lock saltó la cámara (${relockJump})`);
  if (realMove < 0.001) throw new Error('el guard bloqueó también movimiento real posterior');
  if (outlierStep > maxStep + 0.0001) throw new Error(`outlier giró demasiado la cámara (${outlierStep})`);
  if (invalidStep > 0.0001 || !Number.isFinite(result.afterInvalid.yaw) || !Number.isFinite(result.afterInvalid.pitch)) {
    throw new Error('delta no finito contaminó la cámara');
  }
  console.log(`CAMERA INPUT OK · menú ${resumeJump.toFixed(5)} · re-lock ${relockJump.toFixed(5)} · ` +
    `input real ${realMove.toFixed(5)} · outlier ${outlierStep.toFixed(5)} · inválido ${invalidStep.toFixed(5)}`);
} finally {
  await browser?.close();
  server.kill();
}
