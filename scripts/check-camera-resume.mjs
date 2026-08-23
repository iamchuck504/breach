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

    // Simular un movement tardío producido por la recaptura después de que el
    // cambio de pointer-lock ya armó el guard.
    input.discardLookDelta(1);
    const beforeRelock = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    input.mouseDX = -3600;
    input.mouseDY = 3600;
    await wait(35);
    const afterRelock = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };

    // El filtro dura un solo frame: el movimiento real siguiente sí responde.
    const beforeRealMove = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    input.mouseDX = 12;
    input.mouseDY = 8;
    await wait(35);
    const afterRealMove = { yaw: G.player.cam.yaw, pitch: G.player.cam.pitch };
    return { beforeResume, afterResume, beforeRelock, afterRelock,
      beforeRealMove, afterRealMove, guard: input._lookGuardFrames };
  });

  const angleDelta = (a, b) => Math.abs(a - b);
  const resumeJump = Math.max(angleDelta(result.beforeResume.yaw, result.afterResume.yaw),
    angleDelta(result.beforeResume.pitch, result.afterResume.pitch));
  const relockJump = Math.max(angleDelta(result.beforeRelock.yaw, result.afterRelock.yaw),
    angleDelta(result.beforeRelock.pitch, result.afterRelock.pitch));
  const realMove = Math.max(angleDelta(result.beforeRealMove.yaw, result.afterRealMove.yaw),
    angleDelta(result.beforeRealMove.pitch, result.afterRealMove.pitch));
  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  if (resumeJump > 0.0001) throw new Error(`delta del menú saltó la cámara (${resumeJump})`);
  if (relockJump > 0.0001) throw new Error(`delta tardío de re-lock saltó la cámara (${relockJump})`);
  if (realMove < 0.001) throw new Error('el guard bloqueó también movimiento real posterior');
  console.log(`CAMERA RESUME OK · menú ${resumeJump.toFixed(5)} · re-lock ${relockJump.toFixed(5)} · input real ${realMove.toFixed(5)}`);
} finally {
  await browser?.close();
  server.kill();
}
