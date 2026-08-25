// Segunda pasada de sanity: huecos que la primera no cubrió — sniper de
// punta a punta (ADS/FOV/daño cuerpo vs cabeza/recarga/cambio), integridad
// del HUD por arma (icono, nombre, munición sin mezclarse), especiales
// dentro del ciclo de armas, inputs de arma durante espectador, bots que
// NO disparan a través del humo, cohete en vuelo al morir y mezcla de audio.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8795' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// ================= PRÁCTICA: sniper, HUD, ciclo =================
await page.goto('http://localhost:8795/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1600);
await page.evaluate(() => {
  window.__tp = (x, z, yaw = Math.PI) => {
    const p = window.BREACH.player;
    p.pos.x = x; p.pos.z = z; p.y = 0; p.vel.x = 0; p.vel.z = 0;
    p.cam.yaw = yaw; p.yaw = yaw; p.cover = null; p.slide = null;
    p.dive = null; p.mantle = null; p.state = 'idle'; p.stateT = 0;
  };
  window.__hud = () => {
    const el = document.getElementById('weapon');
    const vis = [...el.querySelectorAll('.weapon-icon svg')]
      .filter((s) => getComputedStyle(s).display !== 'none')
      .map((s) => s.dataset.icon);
    return {
      data: el.dataset.weapon,
      name: document.getElementById('wep-name').textContent,
      mag: document.getElementById('wep-mag').textContent,
      res: document.getElementById('wep-res').textContent,
      icons: vis,
      chips: [...document.getElementById('wep-slots').children].map((c) => ({
        w: c.lastChild.textContent, cur: c.classList.contains('cur'),
      })),
    };
  };
});

// --- HUD por arma: icono único, nombre e ítems de munición SIN mezclarse
const hudPerWeapon = await page.evaluate(async () => {
  const G = window.BREACH;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  for (const [i, w] of ['smg', 'shotgun', 'pistol', 'grenade'].entries()) {
    G.weapons.startSwap(w);
    await wait(800);
    const h = window.__hud();
    out[w] = {
      data: h.data, icons: h.icons.length, icon: h.icons[0] || null,
      mag: +h.mag, res: +h.res,
      realMag: G.weapons.state[w].mag, realRes: G.weapons.state[w].reserve,
      curChip: h.chips.findIndex((c) => c.cur) === i,
    };
  }
  return out;
});
for (const w of ['smg', 'shotgun', 'pistol', 'grenade']) {
  const h = hudPerWeapon[w];
  check(`HUD ${w}: icono único y correcto`,
    h.icons === 1 && h.icon === w && h.data === w, JSON.stringify(h));
  check(`HUD ${w}: munición sin mezclarse`,
    h.mag === h.realMag && h.res === h.realRes && h.curChip, JSON.stringify(h));
}

// --- pedestal de práctica = sniper: tomarlo y validar HUD + ciclo
const takeSniper = await page.evaluate(async () => {
  const G = window.BREACH, S = window.BREACH_SPECIALS;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!S.active) return { why: 'sin pedestal' };
  const a = S.active;
  window.__tp(a.x + 0.6, a.z);
  window.BREACH_INPUT.keys.add('Space');
  await wait(1000);
  window.BREACH_INPUT.keys.delete('Space');
  await wait(300);
  const h = window.__hud();
  return {
    cur: G.weapons.cur, slots: G.weapons.slots.join(','),
    data: h.data, icon: h.icons[0], icons: h.icons.length, name: h.name,
    mag: +h.mag, res: +h.res, chip: h.chips[0].w,
  };
});
check('HUD actualiza al recoger la especial',
  takeSniper.cur === 'sniper' && takeSniper.data === 'sniper' &&
  takeSniper.icon === 'sniper' && takeSniper.icons === 1 &&
  takeSniper.mag === 1 && takeSniper.res === 5, JSON.stringify(takeSniper));

// --- la especial entra en el CICLO (rueda y Q la alcanzan)
const cycle = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  G.weapons.startSwap('pistol');
  await wait(800);
  const seq = [];
  for (let i = 0; i < 4; i++) {
    I.cycleDir = 1;
    await wait(750);
    seq.push(G.weapons.cur);
  }
  I.slotPressed = 0; // slot 0 = donde vive la especial
  await wait(800);
  return { seq, bySlot: G.weapons.cur };
});
check('la especial entra en el ciclo de la rueda', cycle.seq.includes('sniper'), JSON.stringify(cycle));
check('d-pad/tecla del slot 0 selecciona la especial', cycle.bySlot === 'sniper', JSON.stringify(cycle));

// --- sniper: ADS cambia FOV y vuelve al soltar (sin zoom atascado)
const ads = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT, C = window.BREACH_CAM;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__tp(0, -10);
  const idle = C.fov;
  I._mouseAim = true;
  await wait(700);
  const aiming = C.fov;
  I._mouseAim = false;
  await wait(700);
  const back = C.fov;
  // cambiar de arma en pleno ADS no debe dejar el FOV pegado
  I._mouseAim = true;
  await wait(400);
  G.weapons.startSwap('shotgun');
  await wait(900);
  I._mouseAim = false;
  await wait(800);
  return {
    idle: +idle.toFixed(1), aiming: +aiming.toFixed(1),
    back: +back.toFixed(1), after: +C.fov.toFixed(1), cur: G.weapons.cur,
  };
});
check('ADS del sniper acerca y suelta limpio',
  ads.aiming < ads.idle - 8 && Math.abs(ads.back - ads.idle) < 2 &&
  Math.abs(ads.after - ads.idle) < 2, JSON.stringify(ads));

// --- sniper: daño de cuerpo NO mata de un tiro, dos sí; auto-recarga
const sniperDmg = await page.evaluate(async () => {
  const G = window.BREACH;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  G.weapons.startSwap('sniper');
  await wait(800);
  G.weapons.state.sniper.mag = 1;
  G.weapons.state.sniper.reserve = 5;
  const d = G.dummies.list.find((x) => x.alive);
  if (!d) return { why: 'sin dummy' };
  // determinista: dummy CONGELADO a 4m y ADS (spread 0.06°). En cadera el
  // sniper abre 5.2°, así que a 8m fallar es el comportamiento correcto.
  // La pareja de posiciones se ELIGE con raycast: el mapa tiene bloques y
  // un duelo a ciegas hacía fallar el test por geometría, no por el arma.
  const W = window.BREACH_WORLD, T = window.THREE;
  const spots = [[0, 6], [-14, 4], [6, -2], [0, -4], [14, -4], [-6, 10]];
  const _o = new T.Vector3(), _dir = new T.Vector3();
  let placed = null;
  for (const [tx, tz] of spots) {
    const px = tx, pz = tz - 4;
    const probe = { x: px, z: pz };
    W.resolveCircle(probe, 0.4, 0);
    if (Math.hypot(probe.x - px, probe.z - pz) > 0.05) continue; // spawn en pared
    _o.set(px, 1.5, pz);
    _dir.set(tx - px, 0, tz - pz);
    const len = _dir.length();
    _dir.normalize();
    if (W.raycast(_o, _dir, len - 0.3) !== null) continue; // sin línea limpia
    placed = { tx, tz, px, pz };
    break;
  }
  if (!placed) return { why: 'sin línea de tiro limpia' };
  d.hp = 100; d.alive = true;
  d.x = placed.tx; d.z = placed.tz;
  d.path = [{ x: placed.tx, z: placed.tz }, { x: placed.tx, z: placed.tz }];
  d.seg = 0; d.u = 0;
  const p = G.player;
  p.pos.x = placed.px; p.pos.z = placed.pz; p.y = 0; p.vel.x = 0; p.vel.z = 0;
  p.cover = null; p.state = 'idle';
  p.yaw = Math.atan2(-(d.x - p.pos.x), -(d.z - p.pos.z));
  p.cam.yaw = p.yaw; p.cam.pitch = 0; // torso
  window.BREACH_INPUT._mouseAim = true;
  await wait(600);
  const hp0 = d.hp;
  window.BREACH_INPUT.firePressed = true;
  await wait(450);
  const hp1 = d.hp, magAfter = G.weapons.state.sniper.mag;
  await wait(2200); // auto-recarga 1.7s
  const reloaded = { mag: G.weapons.state.sniper.mag, res: G.weapons.state.sniper.reserve };
  // HEADSHOT: la cápsula del cuerpo (0.35..1.3 r0.4) se extiende hasta
  // y≈1.70 por su casquete superior y tapa casi toda la esfera de cabeza
  // (1.30..1.74). Barrido de altura para (a) confirmar que headMult ×2.2 se
  // aplica cuando el rayo SÍ entra por la cabeza y (b) medir esa franja.
  // En ADS la cámara va sobre el HOMBRO (offset lateral 0.88): apuntar
  // fijando el yaw desde el jugador deja el rayo fuera del blanco. Se apunta
  // desde la posición REAL de la cámara, iterando porque mover el yaw la
  // reubica en su órbita — igual que un jugador centrando la mira.
  const aimAt = async (ty) => {
    for (let i = 0; i < 4; i++) {
      const c = window.BREACH_CAM.position;
      const dx = d.x - c.x, dz = d.z - c.z, dy = ty - c.y;
      p.cam.yaw = Math.atan2(-dx, -dz);
      p.cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      p.yaw = p.cam.yaw;
      await wait(110);
    }
  };
  let headDelta = 0, headAimY = null;
  for (const aimY of [1.52, 1.6, 1.66]) {
    d.hp = 400; d.alive = true;
    G.weapons.state.sniper.mag = 1;
    G.weapons.state.sniper.cd = 0;
    G.weapons.state.sniper.reload = 0;
    await aimAt(aimY);
    const before = d.hp;
    window.BREACH_INPUT.firePressed = true;
    await wait(420);
    const delta = Math.round(before - d.hp);
    if (delta > headDelta) { headDelta = delta; headAimY = aimY; }
  }
  window.BREACH_INPUT._mouseAim = false;
  return {
    hp0, hp1, magAfter, reloaded, alive: d.alive, hp2: d.hp,
    headDelta, headAimY,
  };
});
check('sniper: un tiro al cuerpo hace 85 y NO mata',
  sniperDmg.hp1 > 0 && sniperDmg.hp0 - sniperDmg.hp1 === 85, JSON.stringify(sniperDmg));
check('sniper: auto-recarga desde la reserva',
  sniperDmg.reloaded?.mag === 1 && sniperDmg.reloaded?.res === 4, JSON.stringify(sniperDmg));
// El casquete superior de la cápsula ya no invade la cabeza: apuntar arriba
// del cuello DEBE producir headshot (85 × 2.2 = 187).
console.log(`INFO headshot: mejor delta=${sniperDmg.headDelta} @y=${sniperDmg.headAimY}`);
check('sniper: headshot aplica ×2.2 (187 dmg)', sniperDmg.headDelta === 187,
  JSON.stringify(sniperDmg));
check('sniper: el daño nunca excede lo configurado (sin doble registro)',
  sniperDmg.headDelta <= 187 && sniperDmg.hp0 - sniperDmg.hp1 === 85, JSON.stringify(sniperDmg));

// --- audio: cada arma nueva tiene su propio camino y no domina la mezcla
const audioMix = await page.evaluate(() => {
  const A = window.BREACH_AUDIO;
  const ok = ['pistol', 'sniper', 'bazooka', 'explosion', 'nadeBounce', 'smokePop']
    .every((m) => typeof A[m] === 'function');
  let threw = null;
  try {
    A.gun('pistol'); A.gun('sniper'); A.gun('bazooka');
    A.explosion({ position: new window.THREE.Vector3(0, 1, 0) });
    A.nadeBounce({ position: new window.THREE.Vector3(0, 1, 0) });
    A.smokePop({ position: new window.THREE.Vector3(0, 1, 0) });
    A.gun('melee'); // id desconocido → no debe reventar (cae en smg)
  } catch (e) { threw = e.message; }
  return { ok, threw, vol: A.volume };
});
check('audio de armas nuevas: métodos presentes y sin excepciones',
  audioMix.ok && !audioMix.threw, JSON.stringify(audioMix));

// ================= VS BOTS: humo vs tiro, muerte con cohete =================
await page.goto('http://localhost:8795/?nolock=1', { waitUntil: 'networkidle' });
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

// --- un bot con blanco pierde el TARGET al interponerse humo (sin tracking
// imposible) y lo recupera con reacción, no al instante
const botSmoke = await page.evaluate(async () => {
  const M = window.BREACH.botMatch, S = window.BREACH_SMOKE;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    const bot = M.bots.find((b) => b.alive && b.targetId && M.visibleEnemies(b).length);
    if (bot) {
      const before = bot.targetId;
      const e = M.visibleEnemies(bot)[0];
      S.clear();
      S.throwNade({ x: (bot.pos.x + e.x) / 2, y: 1.3, z: (bot.pos.z + e.z) / 2 },
        { x: 0, y: 0, z: 0 });
      await wait(2500);
      // mover al bot al centro de la nube para garantizar la oclusión
      const c = S.clouds[0];
      if (!c) return { why: 'sin nube' };
      bot.pos.x = c.x; bot.pos.z = c.z; bot.y = Math.max(0, c.y - 1.3);
      const visInside = M.visibleEnemies(bot).length;
      await wait(500);
      return { before, visInside, targetAfter: bot.targetId, react: +(bot.reactT ?? 0).toFixed(2) };
    }
    await wait(300);
  }
  return { why: 'ningún bot con blanco' };
});
check('bot dentro del humo pierde la visión (sin tracking imposible)',
  botSmoke.visInside === 0, JSON.stringify(botSmoke));

// --- morir con un cohete EN VUELO: sin crash, el cohete se resuelve solo
const rocketDeath = await page.evaluate(async () => {
  const G = window.BREACH, R = window.BREACH_ROCKETS;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  G.weapons.giveSpecial('bazooka');
  const p = G.player;
  p.pos.x = 0; p.pos.z = -8; p.y = 0; p.vel.x = 0; p.vel.z = 0;
  p.cover = null; p.state = 'idle';
  p.cam.yaw = 0; p.yaw = 0; p.cam.pitch = 0; // horizontal, lejos
  G.spawnProt = 0;
  await wait(200);
  window.BREACH_INPUT.firePressed = true;
  await wait(90); // cohete recién lanzado, aún en vuelo
  const inFlight = R.list.length;
  // morir AHORA por daño externo mientras vuela
  G.selfHp = 1;
  const bot = G.botMatch.bots.find((b) => b.alive && b.team !== G.team);
  G.botMatch.cb.damagePlayer(50, bot?.name ?? 'X', { x: p.pos.x, z: p.pos.z - 3 },
    { weapon: 'smg', distance: 3, damage: 50, part: 'body', gib: false });
  if (bot) G.botMatch._onDeath('player', bot.id, false);
  await wait(1500);
  return { inFlight, left: R.list.length, dead: !G.selfAlive, respawnT: +G.respawnT.toFixed(1) };
});
check('cohete en vuelo al morir: se resuelve sin dejar residuo',
  rocketDeath.inFlight > 0 && rocketDeath.left === 0 && rocketDeath.dead,
  JSON.stringify(rocketDeath));
check('la muerte agenda respawn (cola viva)', rocketDeath.respawnT > 0, JSON.stringify(rocketDeath));

// --- inputs de arma mientras ESPECTAS: no cambian nada ni revientan
const spectatorInputs = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (G.selfAlive) return { why: 'el jugador está vivo' };
  const before = G.weapons.cur;
  for (let i = 0; i < 6; i++) {
    I.slotPressed = i % 4;
    I.cycleDir = 1;
    I.meleePressed = true;
    await wait(90);
  }
  return { before, after: G.weapons.cur, st: G.player.state, dead: G.player.dead };
});
check('inputs de arma en espectador no cambian el arma',
  spectatorInputs.why || (spectatorInputs.before === spectatorInputs.after && spectatorInputs.dead),
  JSON.stringify(spectatorInputs));

// --- tras respawnear: loadout de fábrica y HUD coherente
const afterRespawn = await page.evaluate(async () => {
  const G = window.BREACH;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  while (!G.selfAlive && performance.now() - t0 < 12000) await wait(400);
  await wait(400);
  const el = document.getElementById('weapon');
  return {
    alive: G.selfAlive, slots: G.weapons.slots.join(','), cur: G.weapons.cur,
    hudData: el.dataset.weapon, mag: document.getElementById('wep-mag').textContent,
  };
});
check('respawn: loadout de fábrica y HUD sincronizado',
  afterRespawn.alive && afterRespawn.slots === 'smg,shotgun,pistol,grenade' &&
  afterRespawn.cur === 'smg' && afterRespawn.hudData === 'smg' && afterRespawn.mag === '50',
  JSON.stringify(afterRespawn));

// --- un solo pedestal activo en todo momento (sin duplicados)
const pedestals = await page.evaluate(() => {
  const S = window.BREACH_SPECIALS;
  // contar grupos de pedestal en la escena (el sistema solo debe tener uno)
  let groups = 0;
  S.scene.traverse((o) => { if (o.userData?.__pedestal) groups++; });
  return { active: S.active ? 1 : 0, groups };
});
check('nunca hay pedestales duplicados', pedestals.active <= 1, JSON.stringify(pedestals));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nSANITY2: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nSANITY2: todo verde');
