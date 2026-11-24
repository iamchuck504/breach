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
import { CHROME } from './lib-chrome.mjs';
import { freePort, untilGame, waitHttp } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();
const PORT = FREE_PORT;

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT) }, stdio: 'ignore',
});

let browser;
const failures = [];
let pageErrors = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

try {
  await waitHttp(`http://localhost:${PORT}/status`);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => {
    pageErrors++;
    console.log('PAGEERROR:', error.message);
  });

  await page.goto(`http://localhost:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH_FP?.live && window.BREACH?.rig,
    null, { timeout: 30000 });

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
  // La cámara fija el FOV base en su destino al terminar la interpolación.
  // El FOV dibujado se comprueba por separado, incluidos los efectos ópticos.
  const zoomReady = await untilGame(page, () => {
    const G = window.BREACH;
    return G.scopeActive && G.player.cam.fov === G.weapons.def.fovAim;
  }, 3);

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
    zoomReady && Math.abs(scoped.fov - 20) < 1.2, `fov=${scoped.fov.toFixed(2)}`);

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
    // PRUEBAS (corrida 6): con 1 bala el disparo vacía el cargador y arranca la recarga
    // automática, que baja la mira (DECISIONES 17); para probar que DISPARAR no la
    // cierra se dispara con 2
    G.weapons.state.sniper.mag = 2;
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
    beforeShot === 2 && afterShot.mag === 1,
    `mag ${beforeShot}->${afterShot.mag}, reload=${afterShot.reload.toFixed(2)}`);
  check('el scope permanece abierto después de disparar',
    afterShot.scope && afterShot.dom && afterShot.fov < 23,
    JSON.stringify(afterShot));

  // El comienzo, no el punto medio, de un swap debe sacar del scope. Se mide
  // en CUADROS y en tiempo de juego, no en milisegundos de reloj: un runner
  // lento puede tardar más de 70 ms en dibujar un solo cuadro, y la espera
  // fija fallaba sin que el juego hubiera hecho nada mal.
  const duringSwap = await page.evaluate(async () => {
    const G = window.BREACH, W = G.weapons;
    const dom = () => document.getElementById('sniper-scope').classList.contains('on');
    const frame = () => new Promise(requestAnimationFrame);
    const fov0 = window.BREACH_CAM.fov;
    const started = W.startSwap('shotgun');
    const total = W.swapT, swapping = W.swapping;
    let frames = 0, left = 1;
    while (frames < 60 && W.swapping && (G.scopeActive || dom())) { await frame(); frames++; left = W.swapT / total; }
    for (let i = 0; i < 2; i++) await frame(); // el FOV ya debe ir de vuelta
    return { started, swapping, frames, left, scope: G.scopeActive, dom: dom(), fov0, fov: window.BREACH_CAM.fov };
  });
  check('weapon switch inicia correctamente', duringSwap.started && duringSwap.swapping,
    JSON.stringify(duringSwap));
  // left = fracción del swap que quedaba cuando el scope se cerró. Debe
  // cerrarse en el PRIMER cuadro de juego tras iniciar el cambio: el paso de
  // simulación está acotado a 0.1 s y el swap dura 0.55 s, así que incluso en
  // la máquina más lenta queda más del 80 %. Y el FOV ya debe ir de vuelta.
  check('weapon switch cancela el scope desde el primer tramo',
    !duringSwap.scope && !duringSwap.dom && duringSwap.frames <= 1 && duringSwap.left > 0.8 &&
      duringSwap.fov > duringSwap.fov0 + 0.05,
    JSON.stringify(duringSwap));

  const swapDone = await untilGame(page, () => !window.BREACH.weapons.swapping, 3);
  const returnSwapStarted = swapDone && await page.evaluate(() =>
    window.BREACH.weapons.startSwap('sniper'));
  // tope en TIEMPO DE JUEGO (3 s): cambio + subida del ocular + FOV de la mira
  const swapT0 = await page.evaluate(() => window.BREACH.simClock);
  await page.waitForFunction((t0) => {
    const G = window.BREACH;
    return (G.weapons.cur === 'sniper' && G.scopeActive && window.BREACH_CAM.fov < 22) || G.simClock > t0 + 3;
  }, swapT0, { timeout: 600000, polling: 'raf' });
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
  // mismo delta de mouse con los extremos del slider dentro de un scope REAL.
  // PRUEBAS (corrida 6, FPS): la cámara de los ojos rederiva su sensibilidad
  // cada cuadro (lookSensitivity con la mira puesta), así que tras mover el
  // slider se esperan cuadros; el ajuste vive en breach.settings.v1 (sensScope).
  const sensitivity = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT, cam = G.player.cam;
    const frames = (n) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    if (G.weapons.cur !== 'sniper') { G.weapons.startSwap('sniper'); for (let i = 0; i < 400 && (G.weapons.swapping || G.weapons.cur !== 'sniper'); i++) await frames(1); }
    I._mouseAim = true;
    for (let i = 0; i < 600 && !G.scopeActive; i++) await frames(1);
    // la sensibilidad es ∝ FOV: medir con el FOV de la mira ya asentado (20°)
    for (let i = 0; i < 600 && Math.abs(window.BREACH_CAM.fov - 20) > 0.3; i++) await frames(1);
    const scoped = !!G.scopeActive;
    const slider = document.getElementById('sl-zoom');
    const original = slider.value;
    const measure = async (value) => {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await frames(3);
      const before = cam.yaw;
      cam.applyMouse(100, 0, false);
      const d = Math.abs(cam.yaw - before);
      cam.yaw = before;
      return d;
    };
    const slow = await measure(0.35);
    const fast = await measure(1.25);
    let persisted = null;
    try { persisted = JSON.parse(localStorage.getItem('breach.settings.v1') || '{}').sensScope ?? null; } catch { /* sin almacenamiento */ }
    slider.value = original;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    I._mouseAim = false;
    await frames(3);
    return { scoped, slow, fast, ratio: fast / slow, persisted };
  });
  check('Zoomed Sensitivity modifica la rotación scoped',
    sensitivity.scoped && sensitivity.fast > sensitivity.slow && sensitivity.ratio > 3.3 && sensitivity.ratio < 3.8,
    JSON.stringify(sensitivity));
  check('Zoomed Sensitivity persiste en preferencias', Number(sensitivity.persisted) === 1.25,
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
