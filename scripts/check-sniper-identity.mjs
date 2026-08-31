// Identidad del sniper en browser: scope/FOV, precisión de estado, cancelación
// de acciones incompatibles, sensibilidad zoom y restauración visual del rig.
// Esta suite no concede comportamiento: observa la integración real del juego.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;
const PORT = '8816';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT }, stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 900));

let browser;
const failures = [];
let pageErrors = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => {
    pageErrors++;
    console.log('PAGEERROR:', error.message);
  });

  await page.goto(`http://localhost:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => !!window.BREACH?.player && !!window.BREACH?.rig,
    null, { timeout: 10000 });
  await page.waitForTimeout(900);

  // Colocar al jugador en un estado estable y entregar el sniper sin depender
  // del tiempo de hold del pedestal; la recogida ya tiene su propia suite.
  await page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT, p = G.player;
    G.selfAlive = true;
    G.spectator.active = false;
    G.spectator.deathHold = 0;
    p.dead = false;
    p.pos.x = 0; p.pos.z = -10; p.y = 0;
    p.vel.x = 0; p.vel.z = 0;
    p.yaw = Math.PI; p.cam.yaw = Math.PI; p.cam.pitch = -0.08;
    p.state = 'idle'; p.stateT = 0;
    p.cover = null; p.coverEntry = null; p.slide = null; p.dive = null; p.mantle = null;
    if (!G.weapons.hasWeapon('sniper')) G.weapons.giveSpecial('sniper');
    else G.weapons.cur = 'sniper';
    G.weapons.swapT = 0;
    G.weapons.state.sniper.mag = 1;
    G.weapons.state.sniper.reserve = 5;
    G.weapons.state.sniper.cd = 0;
    G.weapons.state.sniper.reload = 0;
    I._mouseAim = true;
  });
  // Esperar al estado óptico, no a un número fijo de milisegundos: en una
  // máquina cargada la interpolación conserva el mismo comportamiento pero
  // puede necesitar algunos frames adicionales. Si nunca converge, el check
  // inferior sigue fallando con el FOV real observado.
  await page.waitForFunction(() => Math.abs(window.BREACH_CAM.fov - 20) < 1.2,
    null, { timeout: 1800 }).catch(() => {});

  const scoped = await page.evaluate(() => {
    const G = window.BREACH;
    const scope = document.getElementById('sniper-scope');
    return {
      active: G.scopeActive,
      playerAim: G.player.aim,
      dom: scope.classList.contains('on'),
      display: getComputedStyle(scope).display,
      aria: scope.getAttribute('aria-hidden'),
      fov: window.BREACH_CAM.fov,
      genericReticle: document.getElementById('crosshair').classList.contains('aim'),
    };
  });
  check('ADS del sniper activa el scope propio',
    scoped.active && scoped.playerAim && scoped.dom && scoped.display !== 'none' &&
      scoped.aria === 'false' && !scoped.genericReticle,
    JSON.stringify(scoped));
  check('scope usa zoom óptico real cercano a 20°',
    Math.abs(scoped.fov - 20) < 1.2, `fov=${scoped.fov.toFixed(2)}`);

  // La entrada al hombro es una transición visual breve; medir estabilidad
  // después de que termina evita confundir esa animación intencional con drift.
  await page.waitForTimeout(360);

  // La cruz del scope no deriva ni cambia de color: ADS usa siempre el rayo
  // central y no hereda estados de obstrucción del muzzle.
  const scopeReticle = async () => page.evaluate(() => {
    const el = document.getElementById('scope-reticle');
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      cx: innerWidth / 2,
      cy: innerHeight / 2,
      color: getComputedStyle(el).color,
      blocked: el.classList.contains('blocked'),
      outRange: el.classList.contains('out-range'),
      left: el.style.left,
      top: el.style.top,
    };
  });
  const reticleBefore = await scopeReticle();
  await page.waitForTimeout(140);
  const reticleStill = await scopeReticle();
  const drift = Math.hypot(reticleStill.x - reticleBefore.x,
    reticleStill.y - reticleBefore.y);
  check('retícula scoped permanece estable sin input',
    drift < 0.75,
    JSON.stringify({ before: reticleBefore, still: reticleStill, drift }));

  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.cam.yaw += 0.42;
    G.player.cam.pitch = Math.max(-0.25, G.player.cam.pitch - 0.08);
    G.player.pos.x += 0.35;
  });
  await page.waitForTimeout(140);
  const reticleAfter = await scopeReticle();
  const centered = (v) => Math.hypot(v.x - v.cx, v.y - v.cy) < 0.75;
  check('retícula scoped permanece centrada tras mover la cámara',
    centered(reticleAfter) && reticleAfter.left === '50%' &&
      reticleAfter.top === '50%', JSON.stringify({ before: reticleBefore, after: reticleAfter }));
  check('retícula scoped conserva color y estado central en todo momento',
    reticleBefore.color === reticleStill.color && reticleBefore.color === reticleAfter.color &&
      !reticleBefore.blocked && !reticleStill.blocked && !reticleAfter.blocked &&
      !reticleBefore.outRange && !reticleStill.outRange && !reticleAfter.outRange,
    JSON.stringify({ before: reticleBefore, still: reticleStill, after: reticleAfter }));

  // Disparar no debe cerrar el scope. Además exigimos que el disparo sí haya
  // ocurrido, para no aceptar un falso positivo por un input ignorado.
  const beforeShot = await page.evaluate(() => {
    const G = window.BREACH, E = window.BREACH_EFFECTS;
    G.weapons.state.sniper.mag = 1;
    G.weapons.state.sniper.cd = 0;
    G.weapons.state.sniper.reload = 0;
    E.clearImpacts();
    window.__sniperImpact = null;
    window.__oldSniperImpact = E.impact.bind(E);
    E.impact = (point, normal, surface, options) => {
      window.__sniperImpact = {
        point: point.toArray(), surface, emphasized: !!options?.emphasized,
      };
      return window.__oldSniperImpact(point, normal, surface, options);
    };
    return G.weapons.state.sniper.mag;
  });
  await page.evaluate(() => { window.BREACH_INPUT.firePressed = true; });
  await page.waitForTimeout(65);
  const scopedImpact = await page.evaluate(() => {
    const E = window.BREACH_EFFECTS;
    const puff = E.items.find((it) => it.obj.name === 'sniper-impact-puff');
    const captured = window.__sniperImpact;
    E.impact = window.__oldSniperImpact;
    delete window.__oldSniperImpact;
    return {
      captured,
      scope: window.BREACH.scopeActive,
      dom: document.getElementById('sniper-scope').classList.contains('on'),
      decals: E.decals.activeCount,
      decalVisible: E.decals.mesh.visible &&
        (E.decals.mesh.layers.mask & window.BREACH_CAM.layers.mask) !== 0,
      puffVisible: !!puff?.obj.visible,
      puffDepthWrite: puff?.obj.material?.depthWrite,
    };
  });
  check('impacto scoped crea decal y partículas visibles inmediatamente',
    !!scopedImpact.captured && scopedImpact.captured.emphasized &&
      scopedImpact.scope && scopedImpact.dom && scopedImpact.decals === 1 &&
      scopedImpact.decalVisible && scopedImpact.puffVisible &&
      scopedImpact.puffDepthWrite === false,
    JSON.stringify(scopedImpact));
  await page.waitForTimeout(115);
  const afterShot = await page.evaluate(() => {
    const G = window.BREACH;
    return {
      mag: G.weapons.state.sniper.mag,
      reload: G.weapons.state.sniper.reload,
      scope: G.scopeActive,
      dom: document.getElementById('sniper-scope').classList.contains('on'),
      fov: window.BREACH_CAM.fov,
    };
  });
  check('el sniper realmente dispara durante la prueba',
    beforeShot === 1 && afterShot.mag === 0 && afterShot.reload > 0,
    `mag ${beforeShot}->${afterShot.mag}, reload=${afterShot.reload.toFixed(2)}`);
  check('el scope permanece abierto después de disparar',
    afterShot.scope && afterShot.dom && afterShot.fov < 23,
    JSON.stringify(afterShot));

  // El comienzo, no el punto medio, de un swap debe sacar del scope.
  const swapStarted = await page.evaluate(() => window.BREACH.weapons.startSwap('shotgun'));
  await page.waitForTimeout(70);
  const duringSwap = await page.evaluate(() => ({
    swapping: window.BREACH.weapons.swapping,
    scope: window.BREACH.scopeActive,
    dom: document.getElementById('sniper-scope').classList.contains('on'),
    fov: window.BREACH_CAM.fov,
  }));
  check('weapon switch inicia correctamente', swapStarted && duringSwap.swapping,
    JSON.stringify(duringSwap));
  check('weapon switch cancela el scope desde el primer tramo',
    !duringSwap.scope && !duringSwap.dom && duringSwap.fov > 20.2,
    JSON.stringify(duringSwap));

  await page.waitForFunction(() => !window.BREACH.weapons.swapping,
    null, { timeout: 1800 }).catch(() => {});
  const returnSwapStarted = await page.evaluate(() =>
    window.BREACH.weapons.startSwap('sniper'));
  await page.waitForFunction(() => {
    const G = window.BREACH;
    return G.weapons.cur === 'sniper' && G.scopeActive && window.BREACH_CAM.fov < 22;
  }, null, { timeout: 1500 }).catch(() => {});
  const scopeRecovered = await page.evaluate(() => ({
    cur: window.BREACH.weapons.cur,
    scope: window.BREACH.scopeActive,
    fov: window.BREACH_CAM.fov,
  }));
  check('volver al sniper con Aim mantenido recupera el scope limpio',
    returnSwapStarted && scopeRecovered.cur === 'sniper' &&
      scopeRecovered.scope && scopeRecovered.fov < 22,
    JSON.stringify(scopeRecovered));

  // Melee tiene prioridad visual: la cámara no puede conservar el scope aunque
  // el botón de apuntar permanezca pulsado.
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.state = 'idle'; G.player.stateT = 0; G.player.meleeCd = 0;
    window.BREACH_INPUT.meleePressed = true;
  });
  await page.waitForTimeout(85);
  const melee = await page.evaluate(() => ({
    state: window.BREACH.player.state,
    scope: window.BREACH.scopeActive,
    dom: document.getElementById('sniper-scope').classList.contains('on'),
  }));
  check('melee cancela inmediatamente el scope',
    melee.state === 'melee' && !melee.scope && !melee.dom, JSON.stringify(melee));
  await page.waitForTimeout(720);

  // El ajuste Zoomed debe afectar la cámara real y persistirse. Medimos el
  // mismo delta de mouse con los extremos del slider dentro de un scope.
  const sensitivity = await page.evaluate(() => {
    const G = window.BREACH, cam = G.player.cam;
    const slider = document.getElementById('sl-zoom');
    const original = slider.value;
    const measure = (value) => {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      cam.setScoped(true);
      cam.fov = 20;
      const before = cam.yaw;
      cam.applyMouse(100, 0, false);
      return Math.abs(cam.yaw - before);
    };
    const slow = measure(0.35);
    const fast = measure(1.25);
    const persisted = localStorage.getItem('breach.sens.zoom');
    slider.value = original;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return { slow, fast, ratio: fast / slow, persisted };
  });
  check('Zoomed Sensitivity modifica la rotación scoped',
    sensitivity.fast > sensitivity.slow && sensitivity.ratio > 3.3 && sensitivity.ratio < 3.8,
    JSON.stringify(sensitivity));
  check('Zoomed Sensitivity persiste en preferencias', sensitivity.persisted === '1.25',
    `persisted=${sensitivity.persisted}`);

  // Sanity de ciclo visual: una muerte de sniper confirmada oculta cabeza y
  // el primer update vivo restaura exactamente esa pieza para respawn/reuso.
  const headCycle = await page.evaluate(() => {
    const R = window.BREACH.rig;
    const dead = { state: 'dead', speed: 0, aim: false, aimPitch: 0 };
    const alive = { state: 'idle', speed: 0, aim: false, aimPitch: 0 };
    // Limpiar cualquier ragdoll previo mediante el camino público de update.
    R.update(1 / 60, alive);
    R.setDeathContext({
      weapon: 'sniper', part: 'head', sniperHeadshot: true,
      damage: 187, power: 1, impact: { x: 0, z: 1 }, vel: { x: 0, z: 0 },
    });
    R.update(1 / 60, dead);
    const hidden = !R.head.visible && R._deathHidden.includes(R.head);
    R.update(1 / 60, alive);
    const restored = R.head.visible && R._deathHidden.length === 0 && !R.rag;
    // Un contexto explícitamente no letal no debe desintegrar la cabeza.
    R.setDeathContext({
      weapon: 'sniper', part: 'head', sniperHeadshot: false,
      damage: 85, power: 0.5, impact: { x: 0, z: 1 }, vel: { x: 0, z: 0 },
    });
    R.update(1 / 60, dead);
    const nonLethalVisible = R.head.visible;
    R.update(1 / 60, alive);
    return { hidden, restored, nonLethalVisible, finalVisible: R.head.visible };
  });
  check('headshot letal de sniper oculta la cabeza del rig', headCycle.hidden,
    JSON.stringify(headCycle));
  check('respawn/reuso restaura cabeza y limpia el daño temporal',
    headCycle.restored && headCycle.nonLethalVisible && headCycle.finalVisible,
    JSON.stringify(headCycle));

  // Spectator y muerte se validan separados para saber qué puerta falló.
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.state = 'idle'; G.player.dead = false; G.selfAlive = true;
    G.spectator.active = false; G.spectator.deathHold = 0;
    window.BREACH_INPUT._mouseAim = true;
  });
  await page.waitForTimeout(650);
  await page.evaluate(() => { window.BREACH.spectator.active = true; });
  await page.waitForTimeout(90);
  const spectator = await page.evaluate(() => ({
    scope: window.BREACH.scopeActive,
    dom: document.getElementById('sniper-scope').classList.contains('on'),
    fov: window.BREACH_CAM.fov,
  }));
  check('spectator nunca hereda el scope del jugador observado',
    !spectator.scope && !spectator.dom && spectator.fov > 20.2,
    JSON.stringify(spectator));

  await page.evaluate(() => {
    const G = window.BREACH;
    G.spectator.active = false;
    G.selfAlive = true;
    G.player.dead = false;
    G.player.state = 'idle';
    window.BREACH_INPUT._mouseAim = true;
  });
  await page.waitForTimeout(650);
  await page.evaluate(() => {
    const G = window.BREACH;
    G.selfAlive = false;
    G.player.kill();
  });
  await page.waitForTimeout(90);
  const death = await page.evaluate(() => ({
    dead: window.BREACH.player.dead,
    aim: window.BREACH.player.aim,
    scope: window.BREACH.scopeActive,
    dom: document.getElementById('sniper-scope').classList.contains('on'),
    fov: window.BREACH_CAM.fov,
  }));
  check('muerte cancela scope y estado de aim',
    death.dead && !death.aim && !death.scope && !death.dom && death.fov > 20.2,
    JSON.stringify(death));

  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser?.close();
  server.kill();
  await clearClip();
}

if (failures.length) {
  console.log(`\nSNIPER IDENTITY: ${failures.length} fallos -> ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\nSNIPER IDENTITY: todo verde');
