// Sanity AGRESIVO de la expansión: casos extremos de melee (reload/swap/
// paredes/spam), ciclo completo de pistola, humo contra paredes y en rampas,
// selección en cover, especiales (cancelar hold, pasar por encima, 0 ammo,
// muerte, recuperar primaria de un drop), cohete a quemarropa con autodaño,
// colisión en multitud y alternancia real de rondas R1→R2.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';
import { actionKeys, freePort, untilGame, waitGame } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(FREE_PORT) }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// ============ FASE 1: PRÁCTICA (fortaleza) — armas y humo ============
await page.goto(`http://localhost:${FREE_PORT}/?nolock=1`, { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForFunction(() => window.BREACH?.mode === 'practice' && window.BREACH.player && window.BREACH.weapons);
await page.evaluate(() => {
  window.__tp = (x, z, yaw = Math.PI) => {
    const p = window.BREACH.player;
    p.pos.x = x; p.pos.z = z; p.y = 0; p.vel.x = 0; p.vel.z = 0;
    p.cam.yaw = yaw; p.yaw = yaw; p.cover = null; p.slide = null;
    p.dive = null; p.mantle = null; p.state = 'idle'; p.stateT = 0;
  };
});

// --- melee DURANTE recarga: la interrumpe limpiamente, sin regalar munición
await page.evaluate(() => {
  window.__tp(0, -10);
  const G = window.BREACH;
  G.weapons.startSwap('pistol');
});
// Preparar el cargador de la pistola equipada y dar cada orden en el
// cuadro que cumple su precondición, incluso si la simulación va despacio.
const requestedReload = await untilGame(page, () => {
  const w = window.BREACH.weapons;
  if (w.cur !== 'pistol' || w.swapping) return false;
  w.st.mag = 4;
  window.BREACH_INPUT.reloadPressed = true;
  return true;
}, 2);
const kicked = requestedReload && await untilGame(page, () => {
  if (!window.BREACH.weapons.reloading) return false;
  window.BREACH_INPUT.meleePressed = true;
  return true;
}, 1);
const interrupted = kicked && await untilGame(page, () =>
  window.BREACH.player.state === 'melee' && !window.BREACH.weapons.reloading, 1);
await waitGame(page, 2.1);
let s = await page.evaluate(() => ({
  mag: window.BREACH.weapons.st.mag, cur: window.BREACH.weapons.cur,
  st: window.BREACH.player.state,
}));
check('melee durante recarga: conserva munición y recupera control',
  interrupted && s.mag === 4 && s.cur === 'pistol' && (s.st === 'idle' || s.st === 'run'), JSON.stringify(s));

// --- melee DURANTE cambio de arma: sin estados rotos
await page.evaluate(() => {
  window.__tp(0, -10);
  window.BREACH_INPUT.slotPressed = 0; // pedir smg
});
await page.waitForTimeout(60);
await page.evaluate(() => { window.BREACH_INPUT.meleePressed = true; });
await page.waitForTimeout(1200);
s = await page.evaluate(() => ({
  cur: window.BREACH.weapons.cur, swapping: window.BREACH.weapons.swapping,
  st: window.BREACH.player.state,
}));
check('melee durante swap: el cambio llega a destino',
  s.cur === 'smg' && !s.swapping && s.st !== 'melee', JSON.stringify(s));

// --- melee inmediatamente después de disparar
await page.evaluate(() => {
  window.BREACH_INPUT.firePressed = true;
  window.BREACH_INPUT._mouseFire = true;
});
await page.waitForTimeout(120);
await page.evaluate(() => {
  window.BREACH_INPUT._mouseFire = false;
  window.BREACH_INPUT.meleePressed = true;
});
let sawMelee = false;
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(50);
  if ((await page.evaluate(() => window.BREACH.player.state)) === 'melee') sawMelee = true;
}
check('melee sale justo después de disparar', sawMelee);

// --- pulsaciones repetidas: nunca reinician un gesto activo. Al recuperar
// control sí puede volver a atacar inmediatamente (sin cooldown largo).
const spamRes = await page.evaluate(async () => {
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  let entries = 0, was = '';
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    window.BREACH_INPUT.meleePressed = true;
    await wait(45);
    const st = window.BREACH.player.state;
    if (st === 'melee' && was !== 'melee') entries++;
    was = st;
  }
  return entries;
});
check('melee no se reinicia activo y permite ritmo intencional (≤4 en 1.5s)',
  spamRes >= 2 && spamRes <= 4, `entradas=${spamRes}`);

// --- melee NO atraviesa un muro MID: dummy pegado detrás del muro de base
const wallMelee = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // muro MID de base en (-8.5,-16) 5x1 h1.9 — jugador al sur, dummy al norte
  const d = G.dummies.list.find((x) => x.alive);
  if (!d) return { why: 'sin dummy' };
  d.x = -8.5; d.z = -15.2; // pegado al lado norte del muro
  const hp0 = d.hp;
  window.__tp(-8.5, -16.9, Math.PI); // lado sur, mirando al muro (+z)
  await wait(150);
  window.BREACH_INPUT.meleePressed = true;
  await wait(450);
  return { hp0, hp1: d.hp, dist: Math.hypot(d.x - G.player.pos.x, d.z - G.player.pos.z) };
});
check('melee bloqueado por muro MID', !!wallMelee.hp0 && wallMelee.hp1 === wallMelee.hp0,
  JSON.stringify(wallMelee));

// --- pistola: agachado tras LOW y asomado (ADS) gasta munición. PRUEBAS (corrida
// 6): antes era blindfire desde la cobertura pegada (retirada); la garantía de
// que se puede disparar desde la postura de cobertura pasa al asomo FPS.
const blindPistol = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  G.weapons.startSwap('pistol');
  await wait(700);
  // cara BAJA y ANCHA (≥2 m)
  const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9 &&
    Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z) >= 2);
  const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
  window.__tp(mx, mz - 0.7, Math.PI);
  window.BREACH_INPUT.keys.add('KeyC'); // agacharse (mantener)
  window.BREACH_INPUT._mouseAim = true;  // apuntar: asomo sobre la cara LOW
  await wait(700);
  const inCover = G.player.state, peek = +G.player.peek.toFixed(2);
  const mag0 = G.weapons.st.mag;
  for (let i = 0; i < 4; i++) {
    window.BREACH_INPUT.firePressed = true;
    window.BREACH_INPUT._mouseFire = true;
    await wait(120);
    window.BREACH_INPUT._mouseFire = false;
    await wait(200);
  }
  await wait(400);
  window.BREACH_INPUT._mouseAim = false;
  return { inCover, peek, mag0, mag1: G.weapons.st.mag, cur: G.weapons.cur };
});
check('pistola dispara asomada sobre LOW',
  blindPistol.inCover === 'crouch' && blindPistol.peek > 0.9 && blindPistol.mag1 < blindPistol.mag0, JSON.stringify(blindPistol));

// --- selección de arma agachado tras la cobertura
const coverSwap = await page.evaluate(async () => {
  const G = window.BREACH;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.BREACH_INPUT.slotPressed = 1; // escopeta
  await wait(800);
  const out = { st: G.player.state, cur: G.weapons.cur };
  window.BREACH_INPUT.keys.delete('KeyC');
  return out;
});
check('cambio de arma agachado tras la cobertura', coverSwap.st === 'crouch' && coverSwap.cur === 'shotgun',
  JSON.stringify(coverSwap));

// --- pistola: muzzle sano (posición finita adelante del pecho)
const muzzle = await page.evaluate(() => {
  const G = window.BREACH, T = window.THREE;
  window.__tp(0, -10);
  G.weapons.startSwap('pistol');
  return new Promise((res) => setTimeout(() => {
    const v = new T.Vector3();
    G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
    G.rig.muzzleWorld(v);
    res({
      finite: [v.x, v.y, v.z].every(Number.isFinite),
      dy: +(v.y - G.player.y).toFixed(2),
      d: +Math.hypot(v.x - G.player.pos.x, v.z - G.player.pos.z).toFixed(2),
    });
  }, 800));
});
check('muzzle de pistola sano', muzzle.finite && muzzle.dy > 0.5 && muzzle.dy < 2 && muzzle.d < 1.5,
  JSON.stringify(muzzle));

// --- RECARGA NORMAL: un segundo toque durante el gesto no completa, atasca
// ni altera la duración. La única cancelación válida sigue siendo disparar
// con munición ya disponible o cambiar de arma.
const plainReload = await page.evaluate(async () => {
  const G = window.BREACH;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__tp(0, -10);
  G.weapons.startSwap('smg');
  await wait(700);
  G.weapons.st.mag = 5;
  G.weapons.startReload();
  await wait(90);
  const before = G.weapons.st.reload;
  const magBefore = G.weapons.st.mag;
  const second = G.weapons.startReload();
  const after = G.weapons.st.reload;
  return {
    second, before: +before.toFixed(3), after: +after.toFixed(3),
    magBefore, magAfter: G.weapons.st.mag,
    hasActiveApi: typeof G.weapons.tryActiveReload === 'function',
    hasBonus: 'bonusT' in G.weapons,
    hasJamState: 'jammed' in G.weapons.st || 'active' in G.weapons.st,
  };
});
check('recarga normal: segundo toque no altera el gesto ni conserva mecánica activa',
  plainReload.second === false && plainReload.magBefore === plainReload.magAfter &&
  Math.abs(plainReload.after - plainReload.before) < 0.01 &&
  !plainReload.hasActiveApi && !plainReload.hasBonus && !plainReload.hasJamState,
  JSON.stringify(plainReload));

// --- SWAT TURN retirado (PRUEBAS, corrida 6): la maniobra entre coberturas se
// retiró con la cobertura pegada; el deslizamiento desde sprint (su sustituto)
// lo prueba check-fps-movement (velocidad, duración, salida agachado).

// --- humo contra una pared: el bote rebota, no se incrusta
const wallNade = await page.evaluate(async () => {
  const S = window.BREACH_SMOKE, W = window.BREACH_WORLD;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  S.clear();
  // lanzar de frente contra el muro perimetral oeste
  S.throwNade({ x: -19.5, y: 1.4, z: -10 }, { x: -12, y: 2, z: 0 });
  await wait(700);
  const p = S.projs[0];
  if (!p) return { why: 'explotó antes de medir' };
  const probe = { x: p.x, z: p.z };
  W.resolveCircle(probe, 0.1, p.y);
  return {
    x: +p.x.toFixed(2), vx: +p.vx.toFixed(1),
    inWall: Math.hypot(probe.x - p.x, probe.z - p.z) > 0.05,
  };
});
check('bote de humo rebota en la pared (no se incrusta)',
  !wallNade.why && !wallNade.inWall && wallNade.x > -21, JSON.stringify(wallNade));

// --- varias nubes simultáneas + limpieza total
const multiSmoke = await page.evaluate(async () => {
  const S = window.BREACH_SMOKE;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  S.clear();
  const sceneBefore = window.BREACH_SMOKE.scene.children.length;
  for (let i = 0; i < 5; i++) {
    S.throwNade({ x: -4 + i * 2, y: 1.2, z: -6 }, { x: 0, y: 1.5, z: 2 + i });
  }
  await wait(2600);
  const peakClouds = S.clouds.length;
  await wait(8000); // smokeTime 7 + margen
  return {
    peakClouds, left: S.clouds.length + S.projs.length,
    sceneDelta: window.BREACH_SMOKE.scene.children.length - sceneBefore,
  };
});
check('5 nubes simultáneas y limpieza total',
  multiSmoke.peakClouds >= 4 && multiSmoke.left === 0 && multiSmoke.sceneDelta === 0,
  JSON.stringify(multiSmoke));

// --- especiales: cancelar el hold y pasar por encima NO recoge
const holdTest = await page.evaluate(async (pickup) => {
  const G = window.BREACH, S = window.BREACH_SPECIALS;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  if (!S.active) return { why: 'sin pedestal' };
  const a = S.active;
  // pasar corriendo por encima sin sostener evadir
  window.__tp(a.x - 3, a.z, Math.PI / 2 * 3); // mirando +x
  const I = window.BREACH_INPUT;
  I.keys.add('KeyW');
  await wait(900);
  I.keys.delete('KeyW');
  const afterPass = !!S.active;
  // hold parcial y soltar
  window.__tp(a.x + 0.6, a.z);
  I.keys.add(pickup);
  await wait(300);
  I.keys.delete(pickup);
  await wait(200);
  const afterPartial = !!S.active;
  const holdT = S.holdT;
  return { afterPass, afterPartial, holdT: +holdT.toFixed(2), wep: S.active?.wep };
}, (await actionKeys(page, 'pickup')).pickup);
check('pasar por encima NO recoge la especial', holdTest.afterPass === true, JSON.stringify(holdTest));
check('hold cancelado no recoge y resetea', holdTest.afterPartial === true && holdTest.holdT === 0,
  JSON.stringify(holdTest));

// --- sniper a 0 de munición: chip "dry" en el HUD y sin refill de caja
const dryTest = await page.evaluate(async (pickup) => {
  const G = window.BREACH, S = window.BREACH_SPECIALS;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const a = S.active;
  window.__tp(a.x + 0.6, a.z);
  window.BREACH_INPUT.keys.add(pickup);
  await wait(1000);
  window.BREACH_INPUT.keys.delete(pickup);
  if (G.weapons.cur !== 'sniper') return { why: 'no tomó el sniper' };
  G.weapons.state.sniper.mag = 0;
  G.weapons.state.sniper.reserve = 0;
  G.weapons.refill(); // caja: no debe tocar la especial
  await wait(300);
  const chip = [...document.getElementById('wep-slots').children]
    .find((c) => c.classList.contains('cur'));
  return {
    mag: G.weapons.state.sniper.mag, res: G.weapons.state.sniper.reserve,
    dry: chip?.classList.contains('dry') ?? false,
    slots: G.weapons.slots.join(','),
  };
}, (await actionKeys(page, 'pickup')).pickup);
check('sniper en 0: sin refill de caja y chip DRY', dryTest.mag === 0 && dryTest.res === 0 && dryTest.dry,
  JSON.stringify(dryTest));

// ============ FASE 2: PRÁCTICA (azoteas) — humo en rampas ============
await page.goto(`http://localhost:${FREE_PORT}/?nolock=1`, { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'azoteas'; });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1800);
const rampNade = await page.evaluate(async () => {
  const S = window.BREACH_SMOKE, W = window.BREACH_WORLD;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // rampa del helipuerto: lanzar hacia el pad central desde fuera
  S.throwNade({ x: 0, y: 1.3, z: -11 }, { x: 0, y: 3, z: 8 });
  await wait(2600);
  const c = S.clouds[0];
  const gy = c ? W.groundHeight({ x: c.x, z: c.z }, 0.2, 3) : -9;
  return c ? { y: +c.y.toFixed(2), gy: +gy.toFixed(2), ok: c.y > gy - 0.2 } : { why: 'sin nube' };
});
check('humo aterriza sobre rampa/helipuerto sin hundirse', !!rampNade.ok, JSON.stringify(rampNade));

// ============ FASE 3: VS BOTS — muerte, drops, cohete, multitud, rondas ====
await page.goto(`http://localhost:${FREE_PORT}/?nolock=1`, { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-bots').click());
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('btn-lobby-start').click());
await page.waitForFunction(
  () => window.BREACH.botMatch && !window.BREACH.botMatch.controlsLocked(),
  null, { timeout: 30000 },
);
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.__tp = (x, z, yaw = Math.PI) => {
    const p = window.BREACH.player;
    p.pos.x = x; p.pos.z = z; p.y = 0; p.vel.x = 0; p.vel.z = 0;
    p.cam.yaw = yaw; p.yaw = yaw; p.cover = null; p.slide = null;
    p.dive = null; p.mantle = null; p.state = 'idle'; p.stateT = 0;
  };
});

// --- cohete a QUEMARROPA: explota y hay autodaño real
const pointBlank = await page.evaluate(async () => {
  const G = window.BREACH, R = window.BREACH_ROCKETS;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  G.weapons.giveSpecial('bazooka');
  window.__tp(0, -19.4, 0); // a ~1.5m del escudo de spawn, mirando -z (al muro)
  G.player.cam.pitch = 0;
  // la partida acaba de empezar: la protección de spawn anula el splash propio
  G.spawnProt = 0;
  const hp0 = G.selfHp;
  await wait(200);
  window.BREACH_INPUT.firePressed = true;
  await wait(900);
  return { hp0, hp1: +G.selfHp.toFixed(0), rockets: R.list.length, alive: G.selfAlive };
});
check('cohete a quemarropa: explota y hace AUTODAÑO',
  pointBlank.rockets === 0 && pointBlank.hp1 < pointBlank.hp0, JSON.stringify(pointBlank));

// --- morir con especial en mano: el drop es la especial y el respawn
// restaura el loadout de fábrica
const deathSpecial = await page.evaluate(async () => {
  const G = window.BREACH;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // asegurar bazooka en mano, CARGADA (el tiro anterior la dejó recargando)
  if (!G.weapons.hasWeapon('bazooka')) G.weapons.giveSpecial('bazooka');
  G.weapons.startSwap('bazooka');
  await wait(700);
  G.weapons.state.bazooka.mag = 1;
  G.weapons.state.bazooka.reload = 0;
  G.weapons.state.bazooka.cd = 0;
  const before = [...G.drops.drops.values()].length;
  G.botMatch.cb; // noop
  // daño letal directo por el camino real
  window.BREACH.selfHp = 1;
  const bot = G.botMatch.bots.find((b) => b.alive && b.team === 'blue');
  // usar el camino de daño local (como si un bot disparara)
  const dmgFn = G.botMatch;
  window.__dmg = null;
  // matar vía damagePlayer del cb no es accesible: usar hp=0 + un tiro de bot simulado
  // — en su lugar, dispara el flujo real: bazooka al piso a los pies
  // piso ABIERTO mirando a +z: en (5,-15,yaw 0) el cohete pegaba encima de
  // la plataforma LOW y el borde del bloque bloqueaba el splash hacia el
  // pecho (regla de cover funcionando — no era bug)
  // Al suelo (pitch -1) el cañón ya no baja tanto y el cohete estallaba a
  // >4.2 m: sin splash propio. Mismo tiro a quemarropa que el check de
  // arriba, contra el muro del spawn, que sí garantiza autodaño.
  window.__tp(0, -19.4, 0);
  G.player.cam.pitch = 0;
  G.spawnProt = 0;
  window.BREACH_INPUT.firePressed = true;
  await wait(300);
  const early = {
    rockets: window.BREACH_ROCKETS.list.length,
    mag: G.weapons.state.bazooka?.mag, cd: +G.weapons.state.bazooka?.cd.toFixed(2),
    hp: +G.selfHp.toFixed(1), st: G.player.state, cur: G.weapons.cur,
  };
  await wait(900);
  const drops = [...G.drops.drops.values()].map((d) => d.wep);
  const died = !G.selfAlive || G.player.dead;
  window.__early = early;
  // El respawn llega en oleadas de 10 s (respawn-wave.js) y el drop dura
  // 8 s: estirar su vida para probar la recuperación, y esperar al respawn
  // real en vez de un tiempo fijo.
  for (const d of G.drops.drops.values()) if (d.wep === 'bazooka') d.t = 60;
  for (let i = 0; i < 160 && !(G.selfAlive && !G.player.dead); i++) await wait(100);
  await wait(300);
  return {
    died, drops: drops.slice(-2), before, early,
    slots: G.weapons.slots.join(','), alive: G.selfAlive,
    mag: G.weapons.state.smg?.mag,
  };
});
check('morir con la especial: el drop existe y es la bazooka',
  deathSpecial.died && deathSpecial.drops.includes('bazooka'), JSON.stringify(deathSpecial));
check('respawn restaura el loadout de fábrica',
  deathSpecial.slots === 'smg,shotgun,pistol,grenade' && deathSpecial.mag === 50,
  JSON.stringify(deathSpecial));

const recoveredSpecial = await page.evaluate(async () => {
  const G = window.BREACH;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const drop = [...G.drops.drops.values()].find((d) => d.wep === 'bazooka');
  if (!drop) return { why: 'drop expirado antes de recogerlo' };
  window.__tp(drop.x, drop.z);
  await wait(250);
  // reemplazar un arma por un drop exige pulsar recoger (E; prompt "pickup.replace")
  window.BREACH_INPUT.pickupPressed = true;
  await wait(450);
  return {
    slots: G.weapons.slots.join(','), cur: G.weapons.cur,
    mag: G.weapons.state.bazooka?.mag, res: G.weapons.state.bazooka?.reserve,
    left: [...G.drops.drops.values()].filter((d) => d.wep === 'bazooka').length,
  };
});
check('otro jugador/respawn puede recuperar la especial caída',
  recoveredSpecial.slots?.includes('bazooka') && recoveredSpecial.cur === 'bazooka' &&
  recoveredSpecial.left === 0, JSON.stringify(recoveredSpecial));

// --- multitud en espacio chico: separación sin atascos ni fugas
const crowd = await page.evaluate(async () => {
  const G = window.BREACH, M = G.botMatch;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const bots = M.bots.filter((b) => b.alive).slice(0, 4);
  window.__tp(15, -18); // v3: (4,-1.6) cae ahora en el muro de la torre del homenaje
  for (const b of bots) { b.pos.x = 15; b.pos.z = -18; }
  await wait(1600);
  let minSep = Infinity, maxDist = 0, bad = 0;
  const all = [{ x: G.player.pos.x, z: G.player.pos.z }, ...bots.map((b) => ({ x: b.pos.x, z: b.pos.z }))];
  for (let i = 0; i < all.length; i++) {
    if (![all[i].x, all[i].z].every(Number.isFinite)) bad++;
    maxDist = Math.max(maxDist, Math.hypot(all[i].x - 15, all[i].z + 18));
    for (let j = i + 1; j < all.length; j++) {
      minSep = Math.min(minSep, Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z));
    }
  }
  return { minSep: +minSep.toFixed(2), maxDist: +maxDist.toFixed(1), bad };
});
check('multitud apilada se separa suave (sin fugas ni NaN)',
  crowd.minSep >= 0.45 && crowd.maxDist < 12 && crowd.bad === 0, JSON.stringify(crowd));

// --- fin de ronda: matar todas las vidas azules → R2 con pedestal BAZOOKA
const roundFlip = await page.evaluate(async () => {
  const G = window.BREACH, M = G.botMatch;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // humo activo cruzando la transición (probar limpieza/estado)
  window.BREACH_SMOKE.throwNade({ x: 0, y: 1.2, z: 5 }, { x: 0, y: 0, z: 0 });
  M.pool.blue = 0;
  // Un bot recién respawneado tiene protección (damageBot lo rechaza) y una
  // oleada ya agendada puede traer otro: re-matar en cada vuelta hasta que
  // cambie la ronda (antes fallaba ~1 de cada 2 corridas).
  const killBlue = () => {
    for (const b of M.bots) {
      if (!b.alive || b.team !== 'blue') continue;
      b.protT = 0;
      M.damageBot(b.id, 9999, 'player', false, true);
    }
  };
  const r0 = M.round;
  const t0 = performance.now();
  while (M.round === r0 && performance.now() - t0 < 25000) {
    if (M.phase === 'playing') killBlue();
    await wait(400);
  }
  // esperar a que la ronda 2 libere controles y coloque pedestal
  const t1 = performance.now();
  while ((M.controlsLocked() || G.specialRound !== M.round) && performance.now() - t1 < 20000) await wait(400);
  return {
    round: M.round, specialRound: G.specialRound,
    wep: window.BREACH_SPECIALS.active?.wep ?? null,
    cloudsLeft: window.BREACH_SMOKE.clouds.length + window.BREACH_SMOKE.projs.length,
    rockets: window.BREACH_ROCKETS.list.length,
  };
});
check('la ronda avanzó a R2', roundFlip.round === 2, JSON.stringify(roundFlip));
check('R2 coloca pedestal de BAZOOKA', roundFlip.wep === 'bazooka', JSON.stringify(roundFlip));
console.log('INFO estado tras transición:', JSON.stringify(roundFlip));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nEDGE-CASES: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nEDGE-CASES: todo verde');
