// Regresión visual/funcional: ADS permanece estable en la intención de cámara;
// todo tiro sin ADS proyecta la trayectoria física desde el muzzle. Blindfire
// contextual amplía este contrato en check-blindfire.
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
    const dot = document.getElementById('barrel-dot');
    const actual = { x: parseFloat(dot.style.left), y: parseFloat(dot.style.top) };
    const rr = window.__rays[80] ?? window.__rays[60];
    const reticlePoint = rr
      ? new window.THREE.Vector3(...rr.origin).addScaledVector(
        new window.THREE.Vector3(...rr.dir), rr.t ?? 60).project(window.BREACH_CAM)
      : null;
    const projectedReticleRay = reticlePoint ? {
      x: (reticlePoint.x * 0.5 + 0.5) * innerWidth,
      y: (-reticlePoint.y * 0.5 + 0.5) * innerHeight,
    } : null;
    return {
      expected: projectedReticleRay, actual,
      errorPx: projectedReticleRay
        ? Math.hypot(projectedReticleRay.x - actual.x, projectedReticleRay.y - actual.y)
        : Infinity,
      centerOffset: projectedReticleRay
        ? Math.hypot(projectedReticleRay.x - innerWidth * 0.5,
          projectedReticleRay.y - innerHeight * 0.5)
        : 0,
      visible: dot.classList.contains('on'),
      rays: window.__rays,
      projectedReticleRay,
    };
  });

  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  if (result.error) throw new Error(result.error);
  if (!result.visible) throw new Error('la retícula no estaba visible');
  // El escenario pega cerca y genera paralaje visible. Si este control no se
  // separa del centro, la prueba dejaría pasar exactamente la regresión de la
  // captura: retícula central y marcas agrupadas a un costado.
  if (result.centerOffset < 4) {
    console.error('RETICLE PARALLAX DEBUG', JSON.stringify(result));
    throw new Error('el escenario no produjo el paralaje necesario para validar la retícula');
  }
  if (result.errorPx > 0.75) {
    console.error('RETICLE DEBUG', JSON.stringify(result));
    throw new Error(`retícula sin ADS se separó ${result.errorPx.toFixed(1)} px de la trayectoria física`);
  }

  // ADS obstruido: la cámara alcanza un punto lejano, pero una pared ficticia
  // queda inmediatamente delante del muzzle. La pared todavía bloquea la
  // balística, pero no puede arrastrar el anillo fuera del centro.
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
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    I._mouseAim = false;
    return {
      visible: ring.classList.contains('aim'),
      actual,
      centerError: Math.hypot(actual.x - innerWidth * 0.5, actual.y - innerHeight * 0.5),
    };
  });
  if (!ads.visible || ads.centerError > 0.75) {
    console.error('ADS RETICLE DEBUG', JSON.stringify(ads));
    throw new Error('una obstrucción física desplazó la retícula ADS');
  }

  // Sniper scoped con paralaje obstruido: la cámara ve el fondo, pero un cover
  // distinto intercepta el rayo desde el cañón. La cruz debe proyectar el mismo
  // punto físico que recibe el decal, no permanecer prometiendo el centro.
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
      reticleError: Math.hypot(actual.x - expected.x, actual.y - expected.y),
      centerOffset: Math.hypot(actual.x - innerWidth / 2, actual.y - innerHeight / 2),
      impactWorldError: impact ? impact.distanceTo(expectedPoint) : Infinity,
    };
  });
  if (sniperBlocked.centerOffset < 4 || sniperBlocked.reticleError > 2.5 ||
      sniperBlocked.impactWorldError > 0.14) {
    console.error('SNIPER BLOCKED RETICLE DEBUG', JSON.stringify(sniperBlocked));
    throw new Error('scope del sniper no representó el impacto físico obstruido');
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
  console.log(`RETICLE OK · barrel ${result.errorPx.toFixed(2)} px · scope obstruido ${sniperBlocked.reticleError.toFixed(2)} px · bazooka guiada ${rocketAim.dotExpected.toFixed(5)} · 5 armas estables`);
} finally {
  await browser?.close();
  server.kill();
}
