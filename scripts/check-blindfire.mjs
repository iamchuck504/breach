// Integración navegador: controller -> pose contextual -> clearance -> arma.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8793',
], { cwd: root, stdio: 'ignore' });

let browser;
try {
  await new Promise((resolve) => setTimeout(resolve, 900));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('http://localhost:8793/?nolock=1', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.getElementById('btn-enter')?.click();
    document.getElementById('btn-practice').click();
  });
  await page.waitForTimeout(1300);

  async function scenario(type, side = 0, pitch = 0) {
    const setup = await page.evaluate(({ type, side, pitch }) => {
      const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
      if (type === 'railing' && W.layout !== 'azoteas') W.setLayout('azoteas');
      const candidates = W.faces.filter((f) => {
        const len = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
        if (len < 2.4 || !f.collider) return false;
        if (type === 'low') return f.kind === 'low';
        if (type === 'high') return f.h > 1.4;
        if (type === 'railing') {
          if (f.kind !== 'railing') return false;
          const mx = (f.a.x + f.b.x) * 0.5 + f.n.x * 0.38;
          const mz = (f.a.z + f.b.z) * 0.5 + f.n.z * 0.38;
          return W.groundHeight({ x: mx, z: mz }, 0.38, 2) > 0.5;
        }
        return false;
      });
      const f = candidates[0];
      if (!f) return { error: `sin face ${type}` };
      const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z;
      const len = Math.hypot(tx, tz), ux = tx / len, uz = tz / len;
      const u = side < 0 ? 0.36 : side > 0 ? len - 0.36 : len * 0.5;
      G.player.pos.x = f.a.x + ux * u + f.n.x * 0.38;
      G.player.pos.z = f.a.z + uz * u + f.n.z * 0.38;
      G.player.y = W.groundHeight(G.player.pos, 0.38, 2);
      G.player.cover = f;
      G.player.state = 'cover';
      G.player.stateT = 0.5;
      G.player.vel.x = G.player.vel.z = 0;
      G.player.firingBlind = 0;
      G.player.blindMode = null;
      G.player._blindModePrev = null;
      G.player.blindPoseExposure = 0;
      const dx = -f.n.x + ux * side * 1.35;
      const dz = -f.n.z + uz * side * 1.35;
      const dl = Math.hypot(dx, dz);
      G.player.yaw = Math.atan2(-f.n.x, -f.n.z);
      G.player.cam.yaw = Math.atan2(-(dx / dl), -(dz / dl));
      G.player.cam.pitch = pitch;
      G.weapons.cur = 'smg';
      G.weapons.state.smg.mag = 50;
      G.weapons.state.smg.cd = 0;
      G.weapons.state.smg.reload = 0;
      I._mouseAim = false;
      I._mouseFire = false;
      I.firePressed = false;
      return { len, faceKind: f.kind, y: G.player.y };
    }, { type, side, pitch });
    if (setup.error) throw new Error(setup.error);
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      window.BREACH_INPUT._mouseFire = true;
      window.BREACH_INPUT.firePressed = true;
    });
    await page.waitForTimeout(620);
    const result = await page.evaluate(() => ({
      mag: window.BREACH.weapons.state.smg.mag,
      anim: window.BREACH.player.animState(),
      mode: window.BREACH.player.blindMode,
      exposure: window.BREACH.player.blindPoseExposure,
    }));
    await page.evaluate(() => { window.BREACH_INPUT._mouseFire = false; });
    await page.waitForTimeout(90);
    return result;
  }

  const results = {
    lowOver: await scenario('low'),
    lowLeft: await scenario('low', -1),
    lowRight: await scenario('low', 1),
    highCenter: await scenario('high'),
    highLeft: await scenario('high', -1),
    highRight: await scenario('high', 1),
    railDown: await scenario('railing', 0, -0.28),
  };
  await scenario('low');
  await page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    G.weapons.state.smg.mag = 50; G.weapons.state.smg.cd = 0;
    I._mouseAim = true; I._mouseFire = true; I.firePressed = true;
  });
  await page.waitForTimeout(430);
  const aimed = await page.evaluate(() => ({
    mag: window.BREACH.weapons.state.smg.mag,
    aim: window.BREACH.player.aim,
    mode: window.BREACH.player.blindMode,
  }));
  await page.evaluate(() => { window.BREACH_INPUT._mouseAim = false; });
  const beforeBlind = aimed.mag;
  await page.waitForTimeout(430);
  const backToBlind = await page.evaluate(() => ({
    mag: window.BREACH.weapons.state.smg.mag,
    aim: window.BREACH.player.aim,
    mode: window.BREACH.player.blindMode,
  }));
  await page.evaluate(() => { window.BREACH_INPUT._mouseFire = false; });
  const fail = [];
  for (const key of ['lowOver', 'lowLeft', 'lowRight', 'highLeft', 'highRight', 'railDown']) {
    if (results[key].mag >= 50) fail.push(`${key} no disparó (${JSON.stringify(results[key])})`);
  }
  if (results.highCenter.mag !== 50 || results.highCenter.mode !== null) {
    fail.push(`highCenter atravesó pared/consumió munición (${JSON.stringify(results.highCenter)})`);
  }
  if (!aimed.aim || aimed.mag >= 50 || aimed.mode !== null) {
    fail.push(`blindfire -> ADS inconsistente (${JSON.stringify(aimed)})`);
  }
  if (backToBlind.aim || !backToBlind.mode || backToBlind.mag >= beforeBlind) {
    fail.push(`ADS -> blindfire inconsistente (${JSON.stringify(backToBlind)})`);
  }
  if (pageErrors.length) fail.push(...pageErrors.map((e) => `page: ${e}`));
  if (fail.length) throw new Error(fail.join(' | '));
  console.log('BLINDFIRE OK · over · low/high L/R · barandal descendente · ADS↔blind · bloqueo alto central');
} finally {
  await browser?.close();
  server.kill();
}
