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
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(1300);

  async function scenario(type, side = 0, pitch = 0, weapon = 'smg') {
    const setup = await page.evaluate(({ type, side, pitch, weapon }) => {
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
      // Aislar geometría/retícula: ningún dummy puede interceptar la línea y
      // convertir una prueba de mundo en una prueba de hitbox móvil.
      for (const d of G.dummies?.list ?? []) {
        d.alive = false;
        d.respawnT = 9999;
      }
      G.weapons.reset();
      if (weapon === 'sniper' || weapon === 'bazooka') G.weapons.giveSpecial(weapon);
      else G.weapons.cur = weapon;
      G.weapons.st.mag = G.weapons.def.mag;
      G.weapons.st.cd = 0;
      G.weapons.st.reload = 0;
      I._mouseAim = false;
      I._mouseFire = false;
      I.firePressed = false;
      return { len, faceKind: f.kind, y: G.player.y, initialMag: G.weapons.st.mag };
    }, { type, side, pitch, weapon });
    if (setup.error) throw new Error(setup.error);
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      window.BREACH_INPUT._mouseFire = true;
      window.BREACH_INPUT.firePressed = true;
    });
    await page.waitForTimeout(620);
    const result = await page.evaluate(() => {
      const G = window.BREACH, W = window.BREACH_WORLD;
      G.rig.root.updateWorldMatrix(true, true);
      const muzzle = G.rig.muzzleWorld(new window.THREE.Vector3()).clone();
      const barrelDir = G.rig.gunForward(new window.THREE.Vector3()).normalize();
      const contact = W.raycastHit(muzzle, barrelDir, G.weapons.def.range);
      const t = contact?.t ?? W.raycast(muzzle, barrelDir, G.weapons.def.range) ??
        G.weapons.def.range;
      const point = muzzle.clone().addScaledVector(barrelDir, t);
      window.BREACH_CAM.updateMatrixWorld(true);
      const projected = point.project(window.BREACH_CAM);
      const expected = {
        x: (projected.x * 0.5 + 0.5) * innerWidth,
        y: (-projected.y * 0.5 + 0.5) * innerHeight,
      };
      const dot = document.getElementById('barrel-dot');
      const rect = dot.getBoundingClientRect();
      const actual = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return {
        weapon: G.weapons.cur,
        mag: G.weapons.st.mag,
        initialMag: G.weapons.def.mag,
        anim: G.player.animState(),
        mode: G.player.blindMode,
        exposure: G.player.blindPoseExposure,
        reticleVisible: dot.classList.contains('on'),
        reticleError: Math.hypot(expected.x - actual.x, expected.y - actual.y),
        centerOffset: Math.hypot(expected.x - innerWidth * 0.5,
          expected.y - innerHeight * 0.5),
        hitDistance: t,
      };
    });
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
  const weaponResults = {};
  for (const weapon of ['pistol', 'smg', 'shotgun', 'sniper', 'bazooka']) {
    weaponResults[weapon] = await scenario('low', 0, -0.08, weapon);
  }
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
    if (results[key].mag >= results[key].initialMag) {
      fail.push(`${key} no disparó (${JSON.stringify(results[key])})`);
    }
    if (!results[key].reticleVisible || results[key].reticleError > 1.25) {
      fail.push(`${key} retícula no coincide con trayectoria (${JSON.stringify(results[key])})`);
    }
  }
  for (const [weapon, result] of Object.entries(weaponResults)) {
    if (result.mag >= result.initialMag) {
      fail.push(`${weapon} no disparó en blindfire (${JSON.stringify(result)})`);
    }
    if (!result.reticleVisible || result.reticleError > 1.25) {
      fail.push(`${weapon} retícula blindfire incorrecta (${JSON.stringify(result)})`);
    }
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
  console.log('BLINDFIRE OK · over · low/high L/R · barandal descendente · 5 armas · ADS↔blind · bloqueo alto central');
} finally {
  await browser?.close();
  server.kill();
}
