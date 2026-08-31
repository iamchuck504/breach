// Regresión visual/funcional: ADS permanece estable en la intención de cámara;
// Contrato global: la retícula nunca abandona el centro y cámara define el
// objetivo en hip, blindfire, ADS y scope; la balística nace en el muzzle.
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

  // Repro exacto: girar de golpe, esperar en low-ready y disparar. La retícula
  // debe permanecer centrada antes, durante y después del primer tiro.
  await page.evaluate(() => {
    const G = window.BREACH;
    G.weapons.cur = 'smg';
    G.weapons.st.mag = 50;
    G.weapons.st.cd = 0;
    G.player.cam.pitch = -0.48;
    G.player.cam.yaw = 0;
    G.player.yaw = 0;
    for (const d of G.dummies.list) d.alive = false;
  });
  await page.waitForTimeout(100);

  const result = await page.evaluate(async () => {
    const G = window.BREACH;
    G.player.cam.yaw = 1.05;
    G.player.yaw = 1.05;
    const I = window.BREACH_INPUT, W = window.BREACH_WORLD;
    const E = window.BREACH_EFFECTS;
    const dot = document.getElementById('barrel-dot');
    const samples = [];
    const sample = () => {
      const r = dot.getBoundingClientRect();
      samples.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    };
    const oldTracer = E.tracer;
    const oldRandom = Math.random;
    let shotDot = null;
    E.tracer = function(origin, point, emphasized) {
      const ray = G.player.cam.aimRay();
      const contact = W.raycastHit(ray.origin, ray.dir, G.weapons.def.range);
      const t = contact?.t ?? W.raycast(ray.origin, ray.dir, G.weapons.def.range) ??
        G.weapons.def.range;
      const guide = ray.origin.clone().addScaledVector(ray.dir, t);
      const expected = guide.sub(origin).normalize();
      const actual = point.clone().sub(origin).normalize();
      shotDot = actual.dot(expected);
      return oldTracer.call(this, origin, point, emphasized);
    };
    Math.random = () => 0;
    sample();
    I._mouseFire = true;
    I.firePressed = true;
    await new Promise((resolve) => setTimeout(resolve, 85));
    sample();
    I._mouseFire = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    sample();
    Math.random = oldRandom;
    E.tracer = oldTracer;
    const center = { x: innerWidth / 2, y: innerHeight / 2 };
    return {
      visible: dot.classList.contains('on'),
      shotDot,
      maxCenterOffset: Math.max(...samples.map((p) => Math.hypot(p.x - center.x, p.y - center.y))),
      maxDrift: Math.max(...samples.map((p) => Math.hypot(p.x - samples[0].x, p.y - samples[0].y))),
      samples,
    };
  });

  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  if (!result.visible) throw new Error('la retícula no estaba visible');
  if (result.maxCenterOffset > 0.75 || result.maxDrift > 0.25 || result.shotDot < 0.9999) {
    console.error('RETICLE DEBUG', JSON.stringify(result));
    throw new Error('hip fire movió la retícula o no guió el disparo al centro');
  }

  // ADS obstruido: la cámara alcanza un punto lejano, pero una pared ficticia
  // queda inmediatamente delante del muzzle. El anillo conserva el centro y
  // comunica la obstrucción con estado visual, sin saltar por paralaje.
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
    const ray = G.player.cam.aimRay();
    const cameraOrigin = ray.origin.clone();
    const oldRaycastHit = W.raycastHit.bind(W);
    const oldRaycast = W.raycast.bind(W);
    W.raycastHit = (origin, dir, maxDist) => {
      if (origin.distanceTo(cameraOrigin) < 0.08) {
        return { t: Math.min(24, maxDist), normal: { x: 0, y: 0, z: 1 }, surface: 'stone' };
      }
      if (origin.distanceTo(muzzle) < 0.12) {
        const t = Math.min(0.55, maxDist);
        return { t, normal: { x: 0, y: 0, z: 1 }, surface: 'stone' };
      }
      return oldRaycastHit(origin, dir, maxDist);
    };
    W.raycast = () => null;
    await new Promise((resolve) => setTimeout(resolve, 70));

    const ring = document.getElementById('crosshair');
    const rect = ring.getBoundingClientRect();
    const actual = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const guidePoint = cameraOrigin.clone().addScaledVector(ray.dir, 24);
    const physicalDir = guidePoint.clone().sub(muzzle).normalize();
    const expectedPoint = muzzle.clone().addScaledVector(physicalDir, 0.55);
    const projected = expectedPoint.clone().project(window.BREACH_CAM);
    const expected = {
      x: (projected.x * 0.5 + 0.5) * innerWidth,
      y: (-projected.y * 0.5 + 0.5) * innerHeight,
    };
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    I._mouseAim = false;
    return {
      visible: ring.classList.contains('aim'),
      blocked: ring.classList.contains('blocked'),
      actual, expected,
      reticleError: Math.hypot(actual.x - expected.x, actual.y - expected.y),
      centerOffset: Math.hypot(actual.x - innerWidth * 0.5, actual.y - innerHeight * 0.5),
    };
  });
  if (!ads.visible || !ads.blocked || ads.centerOffset > 0.75) {
    console.error('ADS RETICLE DEBUG', JSON.stringify(ads));
    throw new Error('la retícula ADS saltó o no comunicó la obstrucción física');
  }

  // Sniper scoped con paralaje obstruido: la cámara ve el fondo, pero un cover
  // distinto intercepta el rayo desde el cañón. La cruz óptica permanece
  // centrada, marca bloqueo y el decal conserva el contacto físico correcto.
  const sniperBlocked = await page.evaluate(async () => {
    const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
    if (!G.weapons.hasWeapon('sniper')) G.weapons.giveSpecial('sniper');
    else G.weapons.cur = 'sniper';
    G.weapons.swapT = 0;
    G.weapons.state.sniper.mag = 1;
    G.weapons.state.sniper.cd = 0;
    G.weapons.state.sniper.reload = 0;
    G.player.state = 'idle';
    G.player.cover = null;
    G.player.yaw = 0.35;
    G.player.cam.yaw = 0.35;
    G.player.cam.pitch = -0.04;
    for (const d of G.dummies.list) d.alive = false;
    I._mouseAim = true;
    await new Promise((resolve) => setTimeout(resolve, 260));

    G.rig.root.updateWorldMatrix(true, true);
    const muzzle = G.rig.muzzleWorld(new window.THREE.Vector3()).clone();
    const ray = G.player.cam.aimRay();
    const cameraOrigin = ray.origin.clone();
    const farCollider = { id: 'far' }, nearCollider = { id: 'near' };
    const oldRaycastHit = W.raycastHit.bind(W);
    const oldRaycast = W.raycast.bind(W);
    W.raycastHit = (origin, dir, maxDist) => {
      const fromCamera = origin.distanceTo(cameraOrigin) < 0.12;
      const t = Math.min(fromCamera ? 24 : 0.8, maxDist);
      return { t, normal: { x: 0, y: 0, z: 1 }, surface: 'concrete',
        collider: fromCamera ? farCollider : nearCollider };
    };
    W.raycast = () => null;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const guidePoint = cameraOrigin.clone().addScaledVector(ray.dir, 24);
    const physicalDir = guidePoint.clone().sub(muzzle).normalize();
    const expectedPoint = muzzle.clone().addScaledVector(physicalDir, 0.8);
    const projected = expectedPoint.clone().project(window.BREACH_CAM);
    const expected = {
      x: (projected.x * 0.5 + 0.5) * innerWidth,
      y: (-projected.y * 0.5 + 0.5) * innerHeight,
    };
    const el = document.getElementById('scope-reticle');
    const rect = el.getBoundingClientRect();
    const actual = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    let impact = null;
    const oldImpact = window.BREACH_EFFECTS.impact.bind(window.BREACH_EFFECTS);
    window.BREACH_EFFECTS.impact = (point, normal, surface, opts) => {
      impact = point.clone();
      return oldImpact(point, normal, surface, opts);
    };
    I._mouseFire = true;
    I.firePressed = true;
    await new Promise((resolve) => setTimeout(resolve, 90));
    I._mouseFire = false;
    I._mouseAim = false;
    window.BREACH_EFFECTS.impact = oldImpact;
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    return {
      actual, expected,
      blocked: el.classList.contains('blocked'),
      reticleError: Math.hypot(actual.x - expected.x, actual.y - expected.y),
      centerOffset: Math.hypot(actual.x - innerWidth / 2, actual.y - innerHeight / 2),
      impactWorldError: impact ? impact.distanceTo(expectedPoint) : Infinity,
    };
  });
  if (!sniperBlocked.blocked || sniperBlocked.centerOffset > 0.75 ||
      sniperBlocked.impactWorldError > 0.14) {
    console.error('SNIPER BLOCKED RETICLE DEBUG', JSON.stringify(sniperBlocked));
    throw new Error('scope del sniper saltó o perdió el impacto físico obstruido');
  }

  // Bazooka ADS: la cámara define el punto deseado y el cohete sale desde el
  // muzzle hacia ESE punto. Lanzarlo paralelo al eje óptico hace que falle la
  // retícula por paralaje, especialmente al apuntar al suelo o a cover cercano.
  const rocketAim = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const W = window.BREACH_WORLD, R = window.BREACH_ROCKETS;
    if (!G.weapons.hasWeapon('bazooka')) G.weapons.giveSpecial('bazooka');
    else G.weapons.cur = 'bazooka';
    G.weapons.st.mag = 1;
    G.weapons.st.cd = 0;
    G.weapons.st.reload = 0;
    G.player.state = 'idle';
    G.player.yaw = 0.42;
    G.player.cam.yaw = 0.42;
    G.player.cam.pitch = -0.28;
    const alive = G.dummies.list.map((d) => d.alive);
    for (const d of G.dummies.list) d.alive = false;
    I._mouseAim = true;
    await new Promise((resolve) => setTimeout(resolve, 260));

    let captured = null;
    const oldFire = R.fire.bind(R);
    R.fire = (origin, direction) => {
      const ray = G.player.cam.aimRay();
      const hit = W.raycastHit(ray.origin, ray.dir, G.weapons.def.range);
      const point = ray.origin.clone().addScaledVector(ray.dir,
        hit?.t ?? G.weapons.def.range);
      const o = new window.THREE.Vector3(origin.x, origin.y, origin.z);
      const expected = point.sub(o).normalize();
      captured = {
        dotExpected: direction.dot(expected),
        dotCamera: direction.dot(ray.dir),
        origin: o.toArray(),
        direction: direction.toArray(),
        expected: expected.toArray(),
      };
      return null;
    };
    I._mouseFire = true;
    I.firePressed = true;
    await new Promise((resolve) => setTimeout(resolve, 130));
    I._mouseFire = false;
    I._mouseAim = false;
    R.fire = oldFire;
    G.dummies.list.forEach((d, i) => { d.alive = alive[i]; });
    return captured;
  });
  if (!rocketAim || rocketAim.dotExpected < 0.9999) {
    console.error('BAZOOKA ADS DEBUG', JSON.stringify(rocketAim));
    throw new Error('el cohete ADS no salió desde el muzzle hacia el punto de la retícula');
  }
  if (rocketAim.dotCamera > 0.99999) {
    console.error('BAZOOKA PARALLAX DEBUG', JSON.stringify(rocketAim));
    throw new Error('el escenario no produjo paralaje para validar la guía de bazooka');
  }

  // Todas las armas comparten el mismo contrato. Dejamos cámara/stick quietos
  // mientras rig, objetivos y FOV continúan actualizándose; la desviación debe
  // permanecer subpíxel y el sniper usa su cruz óptica equivalente.
  const stability = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const weapons = ['pistol', 'smg', 'shotgun', 'bazooka', 'sniper'];
    const out = [];
    I._mouseAim = true;
    for (const weapon of weapons) {
      if ((weapon === 'bazooka' || weapon === 'sniper') && !G.weapons.hasWeapon(weapon)) {
        G.weapons.giveSpecial(weapon);
      } else {
        G.weapons.cur = weapon;
      }
      G.weapons.swapT = 0;
      await new Promise((resolve) => setTimeout(resolve, 220));
      const scoped = weapon === 'sniper';
      const el = document.getElementById(scoped ? 'scope-reticle' : 'crosshair');
      const points = [];
      for (let frame = 0; frame < 18; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        const r = el.getBoundingClientRect();
        points.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      const maxCenterError = Math.max(...points.map((p) =>
        Math.hypot(p.x - innerWidth * 0.5, p.y - innerHeight * 0.5)));
      const maxDrift = Math.max(...points.map((p) =>
        Math.hypot(p.x - points[0].x, p.y - points[0].y)));
      out.push({ weapon, maxCenterError, maxDrift,
        visible: scoped
          ? document.getElementById('sniper-scope').classList.contains('on')
          : el.classList.contains('aim') });
    }
    I._mouseAim = false;
    return out;
  });
  const unstable = stability.filter((item) => !item.visible ||
    item.maxCenterError > 0.75 || item.maxDrift > 0.25);
  if (unstable.length) {
    console.error('RETICLE STABILITY DEBUG', JSON.stringify(stability));
    throw new Error(`retícula inestable: ${unstable.map((v) => v.weapon).join(', ')}`);
  }

  const hipStability = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const weapons = ['pistol', 'smg', 'shotgun', 'grenade', 'bazooka', 'sniper'];
    const out = [];
    I._mouseAim = false;
    for (const weapon of weapons) {
      if ((weapon === 'bazooka' || weapon === 'sniper') && !G.weapons.hasWeapon(weapon)) {
        G.weapons.giveSpecial(weapon);
      } else G.weapons.cur = weapon;
      G.weapons.swapT = 0;
      await new Promise((resolve) => setTimeout(resolve, 90));
      const el = document.getElementById('barrel-dot');
      const points = [];
      for (let frame = 0; frame < 8; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        const r = el.getBoundingClientRect();
        points.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      out.push({
        weapon,
        visible: el.classList.contains('on'),
        maxCenterError: Math.max(...points.map((p) =>
          Math.hypot(p.x - innerWidth / 2, p.y - innerHeight / 2))),
        maxDrift: Math.max(...points.map((p) =>
          Math.hypot(p.x - points[0].x, p.y - points[0].y))),
      });
    }
    return out;
  });
  const unstableHip = hipStability.filter((item) => !item.visible ||
    item.maxCenterError > 0.75 || item.maxDrift > 0.25);
  if (unstableHip.length) {
    console.error('HIP RETICLE STABILITY DEBUG', JSON.stringify(hipStability));
    throw new Error(`retícula hip inestable: ${unstableHip.map((v) => v.weapon).join(', ')}`);
  }
  console.log(`RETICLE OK · centro fijo ${result.maxCenterOffset.toFixed(2)} px · hip/ADS/scope guiados · bazooka ${rocketAim.dotExpected.toFixed(5)} · 6 armas estables`);
} finally {
  await browser?.close();
  server.kill();
}
