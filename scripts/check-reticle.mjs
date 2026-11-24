// Regresión visual/funcional de la retícula en PRIMERA PERSONA (PRUEBAS, corrida 6):
// ADS y mira se quedan en el centro (el rayo del tiro sale del ojo por el centro de
// pantalla) aunque haya una pared solo delante de la boca del arma; el sniper pega
// donde promete la cruz; el cohete sale hacia el punto de la retícula.
// Retirado (solo existía en tercera persona): retícula de cadera = proyección del
// cañón físico, paralaje cadera/óptico, "el cuerpo propio no tapa el ADS de hombro"
// y el marcador del cañón por arma. El cuerpo propio ya no se dibuja jugando y el
// tiro en cadera también sale del ojo (check-fps-camera §4, check-fps-shot-instant).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { freePort, waitHttp } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(FREE_PORT),
], { cwd: root, stdio: 'ignore' });

let browser;
try {
  await waitHttp(`http://127.0.0.1:${FREE_PORT}/`);
  browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 880, height: 640 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${FREE_PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.player && window.BREACH_FP?.live && (window.BREACH.simClock ?? 0) > 0.5, null, { timeout: 600000, polling: 'raf' });
  // espera en tiempo de juego dentro de la página
  await page.evaluate(() => { window.__gwait = (ms) => new Promise((r) => { const G = window.BREACH, end = G.simClock + ms / 1000; const f = () => (G.simClock >= end ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }); });

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
    await window.__gwait(360);

    G.rig.root.updateWorldMatrix(true, true);
    const muzzle = (window.BREACH_VM?.muzzleWorld?.(new window.THREE.Vector3()) ?? G.rig.muzzleWorld(new window.THREE.Vector3())).clone();
    const ray = window.BREACH_FP.aimRay();
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
    await window.__gwait(70);

    const ring = document.getElementById('reticle');
    const rect = ring.getBoundingClientRect();
    const actual = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    I._mouseAim = false;
    return {
      visible: ring.classList.contains('on'),
      blocked: ring.classList.contains('blocked'),
      actual,
      centerOffset: Math.hypot(actual.x - innerWidth * 0.5, actual.y - innerHeight * 0.5),
    };
  });
  if (!ads.visible || ads.blocked || ads.centerOffset > 0.75) {
    console.error('ADS RETICLE DEBUG', JSON.stringify(ads));
    throw new Error('ADS movió o recoloreó la retícula ante una obstrucción del muzzle');
  }

  // Con la mira puesta, la bala debe impactar en el punto visible bajo la cruz.
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
    let cameraOrigin = window.BREACH_FP.aimRay().origin;
    const farCollider = { id: 'far' }, nearCollider = { id: 'near' };
    const oldRaycastHit = W.raycastHit.bind(W);
    const oldRaycast = W.raycast.bind(W);
    const rayLog = [];
    W.raycastHit = (origin, dir, maxDist) => {
      const fromCamera = origin.distanceTo(cameraOrigin) < 0.12;
      if (window.__fireLog && rayLog.length < 40) {
        rayLog.push([+origin.distanceTo(cameraOrigin).toFixed(3), +maxDist.toFixed(1),
          fromCamera ? 'cam' : 'near']);
      }
      const t = Math.min(fromCamera ? 24 : 0.8, maxDist);
      return { t, normal: { x: 0, y: 0, z: 1 }, surface: 'concrete',
        collider: fromCamera ? farCollider : nearCollider };
    };
    W.raycast = () => null;
    await new Promise(resolve => requestAnimationFrame(resolve));
    // El HUD se actualiza antes de dibujar el arma del cuadro actual. Tras el
    // cambio, comprobar también que el ocular del sniper sigue alineado.
    const miraLista = () => {
      const vm = window.BREACH_VM.vm;
      return G.scopeActive && vm?.key === 'sniper' && vm.scopeIn01() >= 0.98;
    };
    const deadline = G.simClock + 3;
    while (!miraLista() && G.simClock < deadline) await window.__gwait(1);
    if (!miraLista()) throw new Error('el sniper no llegó a entrar en la mira');
    const ray = window.BREACH_FP.aimRay();
    cameraOrigin = ray.origin;
    const guidePoint = ray.origin.clone().addScaledVector(ray.dir, 24);
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
    // MODELO GEARS (cámara-céntrico): la bala del scope viaja por el EJE
    // ÓPTICO desde la cámara y pega EXACTAMENTE el punto que promete la
    // cruz. El stub tapa a 0.8m todos los rayos que NO son de cámara (el
    // cañón): eso ya no altera el tiro — el arma es cosmética, como en
    // Gears. La cruz permanece centrada e inmutable.
    let fired = false;
    const oldTracer = window.BREACH_EFFECTS.tracer;
    window.BREACH_EFFECTS.tracer = function (o, p2, em) {
      fired = true;
      return oldTracer.call(this, o, p2, em);
    };
    const magBefore = G.weapons.st.mag;
    window.__fireLog = true;
    I._mouseFire = true;
    I.firePressed = true;
    for (let i = 0; i < 20 && !fired; i++) {
      await window.__gwait(25);
    }
    I._mouseFire = false;
    I._mouseAim = false;
    window.BREACH_EFFECTS.tracer = oldTracer;
    window.BREACH_EFFECTS.impact = oldImpact;
    W.raycastHit = oldRaycastHit;
    W.raycast = oldRaycast;
    return {
      actual, expected,
      blocked: el.classList.contains('blocked'),
      fired: G.weapons.st.mag < magBefore,
      scoped: G.lastShot?.scoped,
      reticleError: Math.hypot(actual.x - expected.x, actual.y - expected.y),
      centerOffset: Math.hypot(actual.x - innerWidth / 2, actual.y - innerHeight / 2),
      impactAtPromise: impact ? impact.distanceTo(guidePoint) < 0.25 : false,
      impactDist: impact ? +impact.distanceTo(guidePoint).toFixed(3) : null,
      rayLog,
    };
  });
  if (sniperCentered.blocked || sniperCentered.centerOffset > 0.75 || sniperCentered.reticleError > 0.75 ||
      !sniperCentered.fired || !sniperCentered.scoped || !sniperCentered.impactAtPromise) {
    console.error('SNIPER GEARS ADS DEBUG', JSON.stringify(sniperCentered));
    throw new Error('el scope debe pegar exactamente el punto prometido por la cruz');
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
    // posición despejada FIJA: el aim-over puede diferir el gatillo unos
    // frames si un borde cercano tapa el cañón, y esta fase mide la
    // dirección del cohete, no la espera del gatillo (se restaura al salir:
    // la fase de visibilidad ADS depende de la posición original)
    const prevPos = { x: G.player.pos.x, z: G.player.pos.z };
    G.player.pos.x = 14; G.player.pos.z = 14;
    G.player.yaw = 0.42;
    G.player.cam.yaw = 0.42;
    G.player.cam.pitch = -0.28;
    const alive = G.dummies.list.map((d) => d.alive);
    for (const d of G.dummies.list) d.alive = false;
    I._mouseAim = true;
    await window.__gwait(320);

    let captured = null;
    const oldFire = R.fire.bind(R);
    R.fire = (origin, direction) => {
      const ray = window.BREACH_FP.aimRay();
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
    // el aim-over puede retener el click mientras el arma libra un borde:
    // mantener el gatillo hasta capturar el cohete (tope 500ms)
    for (let i = 0; i < 25 && !captured; i++) {
      await window.__gwait(20);
    }
    I._mouseFire = false;
    I._mouseAim = false;
    R.fire = oldFire;
    G.player.pos.x = prevPos.x; G.player.pos.z = prevPos.z;
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
    // loadout de fábrica: las especiales de los pasos anteriores reemplazaron un hueco
    // (drop-policy) y poner `cur` en un arma sin estado no es un estado del juego
    G.weapons.reset();
    I._mouseAim = true;
    for (const weapon of weapons) {
      if ((weapon === 'bazooka' || weapon === 'sniper') && !G.weapons.hasWeapon(weapon)) {
        G.weapons.giveSpecial(weapon);
      } else {
        G.weapons.cur = weapon;
      }
      G.weapons.swapT = 0;
      await window.__gwait(220);
      const scoped = weapon === 'sniper';
      const el = document.getElementById(scoped ? 'scope-reticle' : 'reticle');
      const points = [];
      for (let frame = 0; frame < 18; frame++) {
        await window.__gwait(16);
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
          : el.classList.contains('on') });
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

  if (pageErrors.length) throw new Error(`errores de página: ${pageErrors.join(' | ')}`);
  console.log(`RETICLE OK · ADS/mira centrados con obstrucción solo en la boca · 5 armas estables · bazuca ${rocketAim.dotExpected.toFixed(5)}`);
} finally {
  await browser?.close();
  server.kill();
}
