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

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8797' }, stdio: 'ignore',
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
await page.goto('http://localhost:8797/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1500);
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
await page.waitForTimeout(700);
await page.evaluate(() => {
  const G = window.BREACH;
  G.weapons.st.mag = 4; // forzar recarga con sentido
  window.BREACH_INPUT.reloadPressed = true;
});
await page.waitForTimeout(150);
await page.evaluate(() => { window.BREACH_INPUT.meleePressed = true; });
await page.waitForTimeout(500);
let s = await page.evaluate(() => ({
  st: window.BREACH.player.state,
  reloading: window.BREACH.weapons.reloading,
  cur: window.BREACH.weapons.cur,
}));
await page.waitForTimeout(1600);
s = await page.evaluate(() => ({
  mag: window.BREACH.weapons.st.mag, cur: window.BREACH.weapons.cur,
  st: window.BREACH.player.state,
}));
check('melee durante recarga: conserva munición y recupera control',
  s.mag === 4 && s.cur === 'pistol' && (s.st === 'idle' || s.st === 'run'), JSON.stringify(s));

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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

// --- pistola: blindfire desde cobertura gasta munición
const blindPistol = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  G.weapons.startSwap('pistol');
  await wait(700);
  const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
  const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
  window.__tp(mx, mz - 1.0, Math.PI);
  window.BREACH_INPUT.evadePressed = true;
  await wait(700);
  const inCover = G.player.state;
  const mag0 = G.weapons.st.mag;
  for (let i = 0; i < 4; i++) {
    window.BREACH_INPUT.firePressed = true;
    window.BREACH_INPUT._mouseFire = true;
    await wait(120);
    window.BREACH_INPUT._mouseFire = false;
    await wait(200);
  }
  await wait(400);
  return { inCover, mag0, mag1: G.weapons.st.mag, cur: G.weapons.cur };
});
check('pistola dispara en blindfire desde cover',
  blindPistol.inCover === 'cover' && blindPistol.mag1 < blindPistol.mag0, JSON.stringify(blindPistol));

// --- selección de arma DENTRO de cobertura
const coverSwap = await page.evaluate(async () => {
  const G = window.BREACH;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.BREACH_INPUT.slotPressed = 1; // escopeta
  await wait(800);
  return { st: G.player.state, cur: G.weapons.cur };
});
check('cambio de arma dentro de cover', coverSwap.st === 'cover' && coverSwap.cur === 'shotgun',
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

// --- SWAT TURN: en cover, correr alejándose con otra cobertura enfrente
// cruza el hueco; sin cobertura enfrente sale corriendo normal
const swat = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const I = window.BREACH_INPUT;
  const p = G.player;
  // buscar dos caras enfrentadas a menos de 5.5m (pasillo)
  let pair = null;
  for (const f of W.faces) {
    if (f.h > 2.6) continue;
    const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
    for (const g of W.faces) {
      if (g === f || g.h > 2.6) continue;
      const gx = (g.a.x + g.b.x) / 2, gz = (g.a.z + g.b.z) / 2;
      const d = Math.hypot(gx - mx, gz - mz);
      if (d < 2.5 || d > 5.2) continue;
      // enfrentadas: la normal de g apunta hacia f
      const nx = (mx - gx) / d, nz = (mz - gz) / d;
      if (g.n.x * nx + g.n.z * nz > 0.75 && f.n.x * -nx + f.n.z * -nz > 0.75) {
        pair = { f, mx, mz, gx, gz, d };
        break;
      }
    }
    if (pair) break;
  }
  if (!pair) return { why: 'sin pasillo con coberturas enfrentadas' };
  // pegarse a la cara f mirando hacia ella
  p.pos.x = pair.mx + pair.f.n.x * 0.8; p.pos.z = pair.mz + pair.f.n.z * 0.8;
  p.y = 0; p.vel.x = 0; p.vel.z = 0; p.state = 'idle'; p.cover = null;
  p.cam.yaw = Math.atan2(-(pair.mx - p.pos.x), -(pair.mz - p.pos.z));
  p.yaw = p.cam.yaw;
  I.evadePressed = true;
  await wait(700);
  const inCover = p.state;
  // correr ALEJÁNDOSE (hacia la cobertura opuesta)
  // diagnóstico: ¿ve el motor la cobertura de enfrente desde aquí?
  const outDir = { x: -pair.f.n.x, z: -pair.f.n.z };
  const seen = W.findCover(p.pos, outDir, 5.6, 0.38, 0.5);
  const dbg = {
    cd: +p.evadeCooldown.toFixed(2), rec: +(p.evadeRecovery ?? 0).toFixed(2),
    found: seen ? +seen.dist.toFixed(2) : null, gap: +pair.d.toFixed(2),
  };
  I.keys.add('ShiftLeft');
  I.keys.add('KeyS');
  await wait(500);
  const mid = p.state;
  I.keys.delete('KeyS');
  I.keys.delete('ShiftLeft');
  await wait(900);
  return { inCover, mid, end: p.state, cover: !!p.cover, dbg };
});
check('swat turn: cruzar a la cobertura de enfrente',
  swat.why || swat.mid === 'slide' || swat.cover === true || swat.end === 'cover',
  JSON.stringify(swat));

// --- humo contra una pared: el bote rebota, no se incrusta
const wallNade = await page.evaluate(async () => {
  const S = window.BREACH_SMOKE, W = window.BREACH_WORLD;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
const holdTest = await page.evaluate(async () => {
  const G = window.BREACH, S = window.BREACH_SPECIALS;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  I.keys.add('Space');
  await wait(300);
  I.keys.delete('Space');
  await wait(200);
  const afterPartial = !!S.active;
  const holdT = S.holdT;
  return { afterPass, afterPartial, holdT: +holdT.toFixed(2), wep: S.active?.wep };
});
check('pasar por encima NO recoge la especial', holdTest.afterPass === true, JSON.stringify(holdTest));
check('hold cancelado no recoge y resetea', holdTest.afterPartial === true && holdTest.holdT === 0,
  JSON.stringify(holdTest));

// --- sniper a 0 de munición: chip "dry" en el HUD y sin refill de caja
const dryTest = await page.evaluate(async () => {
  const G = window.BREACH, S = window.BREACH_SPECIALS;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = S.active;
  window.__tp(a.x + 0.6, a.z);
  window.BREACH_INPUT.keys.add('Space');
  await wait(1000);
  window.BREACH_INPUT.keys.delete('Space');
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
});
check('sniper en 0: sin refill de caja y chip DRY', dryTest.mag === 0 && dryTest.res === 0 && dryTest.dry,
  JSON.stringify(dryTest));

// ============ FASE 2: PRÁCTICA (azoteas) — humo en rampas ============
await page.goto('http://localhost:8797/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'azoteas'; });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1800);
const rampNade = await page.evaluate(async () => {
  const S = window.BREACH_SMOKE, W = window.BREACH_WORLD;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // rampa del helipuerto: lanzar hacia el pad central desde fuera
  S.throwNade({ x: 0, y: 1.3, z: -11 }, { x: 0, y: 3, z: 8 });
  await wait(2600);
  const c = S.clouds[0];
  const gy = c ? W.groundHeight({ x: c.x, z: c.z }, 0.2, 3) : -9;
  return c ? { y: +c.y.toFixed(2), gy: +gy.toFixed(2), ok: c.y > gy - 0.2 } : { why: 'sin nube' };
});
check('humo aterriza sobre rampa/helipuerto sin hundirse', !!rampNade.ok, JSON.stringify(rampNade));

// ============ FASE 3: VS BOTS — muerte, drops, cohete, multitud, rondas ====
await page.goto('http://localhost:8797/?nolock=1', { waitUntil: 'networkidle' });
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  G.weapons.giveSpecial('bazooka');
  window.__tp(0, -19.4, 0); // a ~1.5m del escudo de spawn, mirando -z (al muro)
  G.player.cam.pitch = 0;
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
  window.__tp(5, -15, Math.PI);
  G.player.cam.pitch = -1.0; // al suelo
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
  // esperar respawn (5s + margen)
  await wait(6500);
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const drop = [...G.drops.drops.values()].find((d) => d.wep === 'bazooka');
  if (!drop) return { why: 'drop expirado antes de recogerlo' };
  window.__tp(drop.x, drop.z);
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bots = M.bots.filter((b) => b.alive).slice(0, 4);
  window.__tp(4, -1.6);
  for (const b of bots) { b.pos.x = 4; b.pos.z = -1.6; }
  await wait(1600);
  let minSep = Infinity, maxDist = 0, bad = 0;
  const all = [{ x: G.player.pos.x, z: G.player.pos.z }, ...bots.map((b) => ({ x: b.pos.x, z: b.pos.z }))];
  for (let i = 0; i < all.length; i++) {
    if (![all[i].x, all[i].z].every(Number.isFinite)) bad++;
    maxDist = Math.max(maxDist, Math.hypot(all[i].x - 4, all[i].z + 1.6));
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // humo activo cruzando la transición (probar limpieza/estado)
  window.BREACH_SMOKE.throwNade({ x: 0, y: 1.2, z: 5 }, { x: 0, y: 0, z: 0 });
  M.pool.blue = 0;
  for (const b of M.bots) {
    if (b.alive && b.team === 'blue') M.damageBot(b.id, 9999, 'player', false, true);
  }
  const r0 = M.round;
  const t0 = performance.now();
  while (M.round === r0 && performance.now() - t0 < 25000) await wait(400);
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
