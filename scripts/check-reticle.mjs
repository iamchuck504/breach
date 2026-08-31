// Regresión visual/funcional: ADS permanece estable en la intención de cámara;
// hip/blindfire proyectan la trayectoria física del muzzle. Blindfire
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

  // Repro exacto: girar de golpe, esperar en low-ready y disparar. Sin ADS,
  // tanto la retícula como el disparo deben seguir el eje físico del barrel.
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
    const oldTracer = E.tracer;
    const oldRandom = Math.random;
    let shotDot = null;
    E.tracer = function(origin, point, emphasized) {
      const expected = G.rig.gunForward(new window.THREE.Vector3()).normalize();
      const actual = point.clone().sub(origin).normalize();
      shotDot = actual.dot(expected);
      return oldTracer.call(this, origin, point, emphasized);
    };
    Math.random = () => 0;
    I._mouseFire = true;
    I.firePressed = true;
    await new Promise((resolve) => setTimeout(resolve, 85));
    I._mouseFire = false;
    await new Promise((resolve) => setTimeout(resolve, 34));
    Math.random = oldRandom;
    E.tracer = oldTracer;

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
      visible: dot.classList.contains('on'),
      shotDot,
      expected,
      actual,
      errorPx: Math.hypot(expected.x - actual.x, expected.y - actual.y),
      centerOffset: Math.hypot(expected.x - innerWidth * 0.5,
        expected.y - innerHeight * 0.5),
      hitDistance: t,
    };
  });

  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  if (!result.visible) throw new Error('la retícula no estaba visible');
  // Exigir paralaje evita que una retícula central pase por casualidad: esta
  // escena debe demostrar que la marca realmente puede abandonar el centro.
  if (result.centerOffset < 4) {
    console.error('RETICLE PARALLAX DEBUG', JSON.stringify(result));
    throw new Error('el escenario no produjo paralaje para validar hip fire');
  }
  if (result.errorPx > 0.75 || result.shotDot < 0.9999) {
    console.error('RETICLE DEBUG', JSON.stringify(result));
    throw new Error('hip fire separó retícula, barrel y trayectoria física');
  }

  // ADS físico: una pared situada solo delante del muzzle no mueve ni cambia
  // la cruz, pero sí debe ganar frente al fondo visible cuando se dispara.
  const ads = await page.evaluate(async () => {
    const G = window.BREACH;
    const W = window.BREACH_WORLD;
    const I = window.BREACH_INPUT;
    G.weapons.cur = 'smg';
    G.player.cam.yaw = 0.35;
    G.player.yaw = 0.35;
    I._mouseAim = true;
    await new Promise((resolve) => setTimeout(resolve, 360));

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
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    I._mouseAim = false;
    return {
      visible: ring.classList.contains('aim'),
      blocked: ring.classList.contains('blocked'),
      actual,
      centerOffset: Math.hypot(actual.x - innerWidth * 0.5, actual.y - innerHeight * 0.5),
    };
  });
  if (!ads.visible || ads.blocked || ads.centerOffset > 0.75) {
    console.error('ADS RETICLE DEBUG', JSON.stringify(ads));
    throw new Error('ADS movió o recoloreó la retícula ante una obstrucción del muzzle');
  }

  // Sniper scoped: la cruz permanece centrada, pero el cover delante del cañón
  // recibe el impacto. Ver el fondo desde cámara nunca concede penetración.
  const sniperCentered = await page.evaluate(async () => {
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
    const expectedPhysicalPoint = muzzle.clone().addScaledVector(
      guidePoint.clone().sub(muzzle).normalize(), 0.8);
    const projected = guidePoint.clone().project(window.BREACH_CAM);
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
      impactWorldError: impact ? impact.distanceTo(expectedPhysicalPoint) : Infinity,
      penetratedToGuide: impact ? impact.distanceTo(guidePoint) < 0.2 : false,
    };
  });
  if (sniperCentered.blocked || sniperCentered.centerOffset > 0.75 ||
      sniperCentered.impactWorldError > 0.14 || sniperCentered.penetratedToGuide) {
    console.error('SNIPER PHYSICAL ADS DEBUG', JSON.stringify(sniperCentered));
    throw new Error('scope del sniper atravesó el cover entre muzzle y objetivo');
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

  // Contrato visual de tercera persona: al apuntar, la cámara puede acercar y
  // reducir FOV, pero su línea central nunca puede atravesar hombro, cabeza,
  // brazos ni arma del jugador local. Este caso evita repetir una ADS
  // técnicamente alineada pero visualmente inutilizable.
  const adsVisibility = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const weapons = ['pistol', 'smg', 'shotgun', 'bazooka', 'sniper'];
    const out = [];
    I._mouseAim = true;
    G.player.state = 'idle';
    G.player.cover = null;
    G.player.cam.pitch = -0.04;
    for (const weapon of weapons) {
      if ((weapon === 'bazooka' || weapon === 'sniper') && !G.weapons.hasWeapon(weapon)) {
        G.weapons.giveSpecial(weapon);
      } else G.weapons.cur = weapon;
      G.weapons.swapT = 0;
      await new Promise((resolve) => setTimeout(resolve, 240));
      G.rig.root.updateWorldMatrix(true, true);
      const ray = G.player.cam.aimRay();
      const caster = new window.THREE.Raycaster(ray.origin, ray.dir, 0.025, 2.8);
      const hits = caster.intersectObject(G.rig.root, true).filter((hit) => {
        const material = hit.object.material;
        if (!hit.object.visible || material?.visible === false || material?.opacity === 0) return false;
        let node = hit.object;
        while (node) {
          if (node === G.rig.nameTag) return false;
          node = node.parent;
        }
        return true;
      });
      const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      const corner = new window.THREE.Vector3();
      G.rig.root.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        let node = obj;
        while (node) {
          if (!node.visible || node === G.rig.nameTag) return;
          node = node.parent;
        }
        obj.geometry.computeBoundingBox();
        const box = obj.geometry.boundingBox;
        if (!box) return;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              corner.set(x, y, z).applyMatrix4(obj.matrixWorld).project(window.BREACH_CAM);
              if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y) ||
                  corner.z < -1.1 || corner.z > 1.1) continue;
              const sx = (corner.x * 0.5 + 0.5) * innerWidth;
              const sy = (-corner.y * 0.5 + 0.5) * innerHeight;
              bounds.left = Math.min(bounds.left, sx);
              bounds.right = Math.max(bounds.right, sx);
              bounds.top = Math.min(bounds.top, sy);
              bounds.bottom = Math.max(bounds.bottom, sy);
            }
          }
        }
      });
      out.push({
        weapon,
        blockers: hits.slice(0, 4).map((hit) => ({
          name: hit.object.name || hit.object.type,
          distance: hit.distance,
        })),
        fov: window.BREACH_CAM.fov,
        bounds,
        rightRatio: bounds.right / innerWidth,
      });
    }
    I._mouseAim = false;
    return out;
  });
  const obscured = adsVisibility.filter((item) => item.blockers.length > 0 ||
    item.fov >= 50 || !Number.isFinite(item.rightRatio) || item.rightRatio > 0.46);
  if (obscured.length) {
    console.error('ADS VISIBILITY DEBUG', JSON.stringify(adsVisibility));
    throw new Error(`ADS obstruido por el jugador: ${obscured.map((v) => v.weapon).join(', ')}`);
  }
  const maxAdsRightRatio = Math.max(...adsVisibility.map((item) => item.rightRatio));

  const hipPhysical = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    const W = window.BREACH_WORLD;
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
      const errors = [];
      const centerOffsets = [];
      for (let frame = 0; frame < 8; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        const r = el.getBoundingClientRect();
        const actual = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        G.rig.root.updateWorldMatrix(true, true);
        const muzzle = G.rig.muzzleWorld(new window.THREE.Vector3()).clone();
        const dir = G.rig.gunForward(new window.THREE.Vector3()).normalize();
        const range = G.weapons.def.range > 0 ? G.weapons.def.range : 60;
        const contact = W.raycastHit(muzzle, dir, range);
        const t = contact?.t ?? W.raycast(muzzle, dir, range) ?? range;
        const projected = muzzle.clone().addScaledVector(dir, t).project(window.BREACH_CAM);
        const expected = {
          x: (projected.x * 0.5 + 0.5) * innerWidth,
          y: (-projected.y * 0.5 + 0.5) * innerHeight,
        };
        errors.push(Math.hypot(actual.x - expected.x, actual.y - expected.y));
        centerOffsets.push(Math.hypot(expected.x - innerWidth * 0.5,
          expected.y - innerHeight * 0.5));
      }
      out.push({
        weapon,
        visible: el.classList.contains('on'),
        maxPhysicalError: Math.max(...errors),
        minCenterOffset: Math.min(...centerOffsets),
      });
    }
    return out;
  });
  const wrongHip = hipPhysical.filter((item) => !item.visible ||
    item.maxPhysicalError > 1.25);
  if (wrongHip.length) {
    console.error('HIP RETICLE PHYSICAL DEBUG', JSON.stringify(hipPhysical));
    throw new Error(`retícula hip no sigue barrel: ${wrongHip.map((v) => v.weapon).join(', ')}`);
  }
  // Con el pitch de este escenario, una pose hip realmente física no puede
  // coincidir con el centro óptico. Esto detecta el error sutil de orientar el
  // propio barrel a cámara y después declarar que la retícula "sigue barrel".
  const centeredHip = hipPhysical.filter((item) => item.minCenterOffset < 4);
  if (centeredHip.length) {
    console.error('HIP RETICLE CENTERED DEBUG', JSON.stringify(hipPhysical));
    throw new Error(`hip fire volvió a comportarse como ADS: ${centeredHip.map((v) => v.weapon).join(', ')}`);
  }
  console.log(`RETICLE OK · barrel ${result.errorPx.toFixed(2)} px · ADS/scope centrados con colisión física · silueta ${(maxAdsRightRatio * 100).toFixed(1)}% · bazooka ${rocketAim.dotExpected.toFixed(5)} · 6 armas físicas`);
} finally {
  await browser?.close();
  server.kill();
}
