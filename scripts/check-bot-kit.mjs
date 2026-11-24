// Verifica el kit nuevo de los bots: melee a bocajarro (con daño real y sin
// atravesar paredes), humo defensivo al romper contacto, y recogida del
// arma especial del pedestal (solo sniper) con munición contada.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';
import { freePort } from './lib-test.mjs';
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
// Las fases matan bots: garantizar el roster vivo que cada escenario
// necesita (respawnear no altera lo que se está midiendo).
await page.evaluate(() => {
  window.__ensure = (team, n) => {
    const M = window.BREACH.botMatch, W = window.BREACH_WORLD;
    const mine = M.bots.filter((b) => b.team === team);
    let alive = mine.filter((b) => b.alive).length;
    for (const b of mine) {
      if (alive >= n) break;
      if (!b.alive) { b.respawn(W.spawns[team][0]); alive++; }
    }
    for (const b of mine) { b.protT = 0; b.hp = 100; }
    return mine.filter((b) => b.alive).length;
  };
});

// 1) MELEE de bot contra bot: pegados, uno debe golpear y hacer daño
const melee = await page.evaluate(async () => {
  const M = window.BREACH.botMatch;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const a = M.bots.find((b) => b.alive && b.team === 'red');
  const d = M.bots.find((b) => b.alive && b.team === 'blue');
  if (!a || !d) return { why: 'sin pareja' };
  a.protT = 0; d.protT = 0;
  const hp0 = d.hp = 100;
  // los bots REGENERAN (48 hp/s tras 3.6s): medir el MÍNIMO observado, no el
  // valor final, o un golpe real se borra antes de leerlo
  let sawState = false, minHp = 100;
  for (let i = 0; i < 26; i++) {
    // mantenerlos cara a cara a 1.2m en campo abierto
    a.pos.x = 0; a.pos.z = -8; a.y = 0;
    d.pos.x = 0; d.pos.z = -6.8; d.y = 0;
    a.yaw = Math.atan2(-(d.pos.x - a.pos.x), -(d.pos.z - a.pos.z));
    await wait(120);
    if (a.meleeT > 0 || a.netAnim === 'melee') sawState = true;
    minHp = Math.min(minHp, d.hp);
  }
  return { sawState, hp0, minHp: Math.round(minHp), cd: +a.meleeCd.toFixed(2) };
});
check('bot entra en estado melee a bocajarro', melee.sawState === true, JSON.stringify(melee));
check('el melee del bot hace daño real', melee.minHp < melee.hp0, JSON.stringify(melee));

// 2) el melee del bot NO atraviesa una pared MID
// (la pared se busca en la geometría actual: la de (-8.5,-16) desapareció con
// la reforma de Fortaleza y el caso medía el daño de los tiros de otros bots;
// ahora se cuentan los golpes que CONECTAN, no la vida)
const wallMelee = await page.evaluate(async () => {
  const M = window.BREACH.botMatch, W = window.BREACH_WORLD;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const a = M.bots.find((b) => b.alive && b.team === 'red');
  const d = M.bots.find((b) => b.alive && b.team === 'blue');
  if (!a || !d) return { why: 'sin pareja' };
  const wall = W.colliders.find((c) => !c.walkSurface && !c.moveOnly && !c.minY && c.h > 1.3 && c.h < 2.6 &&
    Math.min(c.maxx - c.minx, c.maxz - c.minz) < 1.2 && Math.max(c.maxx - c.minx, c.maxz - c.minz) > 3 &&
    Math.abs((c.minz + c.maxz) / 2) < 20 && Math.abs((c.minx + c.maxx) / 2) < 20);
  if (!wall) return { why: 'sin muro MID' };
  const alongX = wall.maxx - wall.minx > wall.maxz - wall.minz;
  const cx = (wall.minx + wall.maxx) / 2, cz = (wall.minz + wall.maxz) / 2;
  const half = alongX ? (wall.maxz - wall.minz) / 2 : (wall.maxx - wall.minx) / 2;
  let hits = 0, swings = 0;
  const melee = M.botMelee;
  M.botMelee = (bot) => { const r = melee.call(M, bot); if (bot === a) { swings++; if (r.connected) hits++; } return r; };
  for (let i = 0; i < 20; i++) {
    a.pos.x = alongX ? cx : cx - half - 0.45; a.pos.z = alongX ? cz - half - 0.45 : cz; a.y = 0;
    d.pos.x = alongX ? cx : cx + half + 0.45; d.pos.z = alongX ? cz + half + 0.45 : cz; d.y = 0;
    a.yaw = Math.atan2(-(d.pos.x - a.pos.x), -(d.pos.z - a.pos.z));
    a.meleeCd = 0;
    await wait(120);
  }
  M.botMelee = melee;
  return { wall: [cx, cz, wall.h], swings, hits };
});
check('melee de bot bloqueado por muro MID', wallMelee.hits === 0 && !wallMelee.why,
  JSON.stringify(wallMelee));

// 3) HUMO defensivo: bot herido con amenaza a media distancia lo lanza
const smoke = await page.evaluate(async () => {
  const M = window.BREACH.botMatch, S = window.BREACH_SMOKE;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  S.clear();
  const b = M.bots.find((x) => x.alive && x.team === 'red');
  const e = M.bots.find((x) => x.alive && x.team === 'blue');
  if (!b || !e) return { why: 'sin pareja' };
  b.pos.x = 0; b.pos.z = -10; b.y = 0;
  e.pos.x = 0; e.pos.z = 2; e.y = 0;            // ~12m: dentro del rango útil
  b.hp = 20; b.recentHit = 0; b.nades = 1; b.nadeCd = 0;
  b.lastThreat = { x: e.pos.x, z: e.pos.z, age: 0 };
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    if (S.projs.length || S.clouds.length) break;
    await wait(150);
  }
  return { thrown: S.projs.length + S.clouds.length, nades: b.nades, cd: Math.round(b.nadeCd) };
});
check('bot herido lanza humo defensivo', smoke.thrown > 0 && smoke.nades === 0,
  JSON.stringify(smoke));

// 4) ESPECIAL: el bot va al pedestal de sniper, lo toma y lo gasta
const special = await page.evaluate(async () => {
  const M = window.BREACH.botMatch, S = window.BREACH_SPECIALS;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const a = S.active;
  // un bot pudo recogerlo ya jugando durante las fases anteriores (mismo
  // camino real de recogida): entonces se mide con ese dueño
  const pre = M.bots.find((x) => x.alive && x.wep === 'sniper' && x.specialAmmo > 0);
  if (!pre && (!a || a.wep !== 'sniper')) return { why: 'pedestal no es sniper' };
  if (!pre) {
  window.__ensure('red', 2); // las fases anteriores dejan bajas
  // sin rivales en medio: se mide la recogida, no un tiroteo junto al
  // pedestal (desde que los bots pelean de verdad, el que iba a por el arma
  // podía morir antes de llegar y el caso dependía de la suerte)
  for (const e of M.bots) if (e.team !== 'red' && e.alive) { e.alive = false; e.rig.setVisible(false); }
  M.specialSeeker.red = null;
  const near = M.bots.find((x) => x.alive && x.team === 'red');
  if (!near) return { why: 'sin bots rojos' };
  near.hp = 100;
  near.pos.x = a.x - 3; near.pos.z = a.z; near.y = a.y;
  }
  // CUALQUIER bot puede ganar la carrera al pedestal: el dueño es quien
  // completa el hold, no el que yo empujé
  const t0 = performance.now();
  let owner = null;
  while (performance.now() - t0 < 9000 && !owner) {
    owner = M.bots.find((x) => x.wep === 'sniper') ?? null;
    if (!owner) await wait(200);
  }
  const took = !!owner;
  const ammo0 = owner?.specialAmmo ?? 0;
  const pedestalGone = !S.active;
  // gastar la munición: al agotarse debe volver solo a su primaria
  let after = null, ammoAfter = null;
  if (owner) {
    owner.specialAmmo = 1;
    owner.shotCd = 0;
    owner.reactT = 0;
    owner.swapAnim = 0; // el gesto de recogida (como el del jugador) aún podía estar en curso
    owner.fireHoldT = 0; // y la espera a difundir la pose tras moverlo a mano
    window.__ensure(owner.team === 'red' ? 'blue' : 'red', 1);
    const e = M.bots.find((x) => x.alive && x.team !== owner.team);
    if (e) {
      e.pos.x = owner.pos.x; e.pos.z = owner.pos.z + 14;
      owner.yaw = Math.atan2(-(e.pos.x - owner.pos.x), -(e.pos.z - owner.pos.z));
      // PRUEBAS (corrida 6): el tiro se llama a mano, así que se ponen las condiciones
      // que hoy exige un bot honesto (ganchos/bots.md): francotirador con mira, pose
      // ya difundida (asentada) y estado que la tabla de compuertas deja disparar.
      owner.rigYaw = owner.yaw; owner.aim = true; owner.poseHeld = 1e9; owner.netAnim = 'idle'; owner.sinceSprint = 99;
      // el tiro debe SALIR (un tiro declinado por línea tapada ya no gasta
      // munición): lo que se prueba es la vuelta a la primaria tras el último
      const shooting = Object.assign(Object.create(M), { botShoot: () => true });
      owner._fireAt(0.05, shooting, { id: e.id, x: e.pos.x, z: e.pos.z, y: e.y }, 14);
    }
    await wait(300);
    after = owner.wep; ammoAfter = owner.specialAmmo;
  }
  return { took, ammo0, pedestalGone, after, ammoAfter, ownerId: owner?.id ?? null };
});
check('un bot recoge el sniper del pedestal', special.took === true, JSON.stringify(special));
check('el pedestal se consume (uno solo)', special.pedestalGone === true, JSON.stringify(special));
check('al agotar la munición vuelve a su primaria', special.after === 'smg',
  JSON.stringify(special));

// 5) el arma especial NO sobrevive a la muerte del bot
const afterDeath = await page.evaluate(async () => {
  const M = window.BREACH.botMatch;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  window.__ensure('red', 1);
  const b = M.bots.find((x) => x.team === 'red' && x.alive);
  if (!b) return { why: 'sin bots rojos' };
  b.wep = 'sniper'; b.specialAmmo = 4;
  M.damageBot(b.id, 9999, 'player', false, true);
  await wait(200);
  const dead = !b.alive;
  b.respawn(window.BREACH_WORLD.spawns[b.team][0]);
  await wait(200);
  return { dead, wep: b.wep, ammo: b.specialAmmo };
});
check('la especial no sobrevive al respawn del bot',
  !afterDeath.why && afterDeath.wep === 'smg' && afterDeath.ammo === 0,
  JSON.stringify(afterDeath));

// 6) BAZOOKA de bot: no dispara con un compañero en la línea/impacto, sí
// con el camino limpio, y el splash respeta bandos
const rocket = await page.evaluate(async () => {
  const M = window.BREACH.botMatch, R = window.BREACH_ROCKETS;
  // espera en TIEMPO DE JUEGO (G.simClock), no de reloj (PRUEBAS: el CI va ~13× más lento)
  const wait = (ms) => new Promise((r) => { const end = (window.BREACH?.simClock ?? 0) + ms / 1000, t0 = performance.now(); const f = () => ((window.BREACH?.simClock ?? 0) >= end || performance.now() - t0 > 120000 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  R.clear();
  window.__ensure('red', 2);
  window.__ensure('blue', 1);
  const b = M.bots.find((x) => x.alive && x.team === 'red');
  const mate = M.bots.find((x) => x.alive && x.team === 'red' && x !== b);
  const e = M.bots.find((x) => x.alive && x.team === 'blue');
  if (!b || !mate || !e) return { why: 'roster incompleto' };
  // línea de tiro VERIFICADA: el pilar central (0,0) y las coberturas hacen
  // que un duelo a ciegas mida geometría, no la regla de seguridad
  const W = window.BREACH_WORLD, T = window.THREE;
  const _o = new T.Vector3(), _d = new T.Vector3();
  const free = (x, z) => {
    const p = { x, z };
    W.resolveCircle(p, 0.8, 0);
    return Math.hypot(p.x - x, p.z - z) < 0.02;
  };
  const pairs = [[-17, -10, -17, 4], [17, -10, 17, 4], [-14, -10, -14, 4],
    [0, -18, 0, -6], [10, 6, 10, 18], [-6, 10, -6, 20]];
  let spot = null;
  for (const [bx, bz, ex, ez] of pairs) {
    if (!free(bx, bz) || !free(ex, ez)) continue; // nacer pegado a un muro no vale
    _o.set(bx, 1.35, bz);
    _d.set(ex - bx, 0.9 - 1.35, ez - bz);
    const len = _d.length();
    _d.normalize();
    if (W.raycastHit(_o, _d, len - 0.5) === null) { spot = { bx, bz, ex, ez, len }; break; }
  }
  if (!spot) return { why: 'sin línea limpia' };
  b.pos.x = spot.bx; b.pos.z = spot.bz; b.y = 0;
  e.pos.x = spot.ex; e.pos.z = spot.ez; e.y = 0; e.hp = 100; e.protT = 0;
  const enemyRef = { id: e.id, x: e.pos.x, z: e.pos.z, y: e.y };
  const dist = spot.len;
  // compañero JUNTO al enemigo: debe vetar el disparo
  mate.pos.x = e.pos.x + 1; mate.pos.z = e.pos.z;
  const blockedByMate = M.rocketPathClear(b, enemyRef, dist);
  // compañero EN LA LÍNEA de vuelo: también veta
  mate.pos.x = (spot.bx + spot.ex) / 2; mate.pos.z = (spot.bz + spot.ez) / 2;
  const blockedByLine = M.rocketPathClear(b, enemyRef, dist);
  // camino limpio: compañero fuera de la línea y del radio
  mate.pos.x = spot.bx + 14; mate.pos.z = spot.bz - 14;
  const clear = M.rocketPathClear(b, enemyRef, dist);
  // disparo real con camino limpio
  const hpMate0 = mate.hp = 100;
  const hpEnemy0 = e.hp;
  M.botFireRocket(b, enemyRef);
  const flying = R.list.length;
  // los bots SIGUEN moviéndose: congelar a los tres durante el vuelo o el
  // cohete persigue a un blanco que ya se fue (medición inestable)
  for (let i = 0; i < 32; i++) {
    e.pos.x = spot.ex; e.pos.z = spot.ez; e.y = 0;
    mate.pos.x = spot.bx + 14; mate.pos.z = spot.bz - 14;
    b.pos.x = spot.bx; b.pos.z = spot.bz;
    await wait(50);
    if (!R.list.length && i > 4) break;
  }
  return {
    blockedByMate, blockedByLine, clear, flying,
    left: R.list.length, hpEnemy0, hpEnemy: e.hp, hpMate0, hpMate: mate.hp,
  };
});
check('bot NO dispara cohete con compañero en el impacto',
  rocket.blockedByMate === false, JSON.stringify(rocket));
check('bot NO dispara cohete con compañero en la línea',
  rocket.blockedByLine === false, JSON.stringify(rocket));
check('bot SÍ dispara con el camino limpio', rocket.clear === true, JSON.stringify(rocket));
check('el cohete del bot vuela y explota', rocket.flying > 0 && rocket.left === 0,
  JSON.stringify(rocket));
check('el splash del bot daña al enemigo', rocket.hpEnemy < rocket.hpEnemy0,
  JSON.stringify(rocket));
check('el splash del bot NO daña a su compañero lejano',
  rocket.hpMate === rocket.hpMate0, JSON.stringify(rocket));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nBOT-KIT: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nBOT-KIT: todo verde');
