// Sanity de sistemas de partida VS BOTS: pedestal especial de la ronda 1
// (sniper), oclusión de humo aplicada a la VISIÓN REAL de los bots, y
// melee correctamente ignorado desde cobertura.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8794' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
await page.goto('http://localhost:8794/?nolock=1', { waitUntil: 'networkidle' });
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

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// 1) ronda 1 → pedestal con SNIPER (la alternancia da bazooka en la 2)
const ped = await page.evaluate(() => ({
  round: window.BREACH.botMatch.round,
  wep: window.BREACH_SPECIALS.active?.wep ?? null,
}));
check('ronda 1 con pedestal de sniper', ped.round === 1 && ped.wep === 'sniper', JSON.stringify(ped));

// 2) humo real bloquea la visión de los bots. Determinista: con la nube ya
// crecida, se TELETRANSPORTA a un bot que ve enemigos al centro de la nube
// y se consulta su visión de forma síncrona (los bots no dejan de moverse,
// así que esperar con la nube fija medía otra cosa).
const smokeRes = await page.evaluate(async () => {
  const M = window.BREACH.botMatch, S = window.BREACH_SMOKE;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  S.throwNade({ x: 0, y: 1.2, z: -4 }, { x: 0, y: 0, z: 0 });
  await wait(2400); // fuse 1.5 + crecimiento
  const c = S.clouds[0];
  if (!c) return { why: 'sin nube' };
  for (let attempt = 0; attempt < 25; attempt++) {
    const bot = M.bots.find((b) => b.alive && M.visibleEnemies(b).length > 0);
    if (bot) {
      const before = M.visibleEnemies(bot).length;
      const ox = bot.pos.x, oz = bot.pos.z, oy = bot.y;
      bot.pos.x = c.x; bot.pos.z = c.z; bot.y = Math.max(0, c.y - 1.3);
      const inside = M.visibleEnemies(bot).length;
      bot.pos.x = ox; bot.pos.z = oz; bot.y = oy;
      return { before, inside, r: +c.r.toFixed(2) };
    }
    await wait(300);
  }
  return { why: 'ningún bot con enemigos visibles' };
});
check('bot tenía enemigos visibles', !!smokeRes && smokeRes.before > 0, JSON.stringify(smokeRes));
check('dentro del humo no ve a NADIE', !!smokeRes && smokeRes.inside === 0, JSON.stringify(smokeRes));

// 3) melee desde cobertura se IGNORA (el arma está contra la pared)
const meleeCover = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
  if (!f) return { why: 'sin cara LOW' };
  const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
  const p = G.player;
  p.pos.x = mx; p.pos.z = mz - 1.0; p.y = 0;
  p.vel.x = 0; p.vel.z = 0;
  p.cam.yaw = Math.PI; p.yaw = Math.PI;
  p.cover = null; p.slide = null; p.dive = null; p.mantle = null;
  p.state = 'idle'; p.stateT = 0;
  window.BREACH_INPUT.evadePressed = true; // entrar a cover
  await wait(700);
  const inCover = p.state;
  window.BREACH_INPUT.meleePressed = true;
  await wait(250);
  return { inCover, after: p.state };
});
check('cover alcanzado para la prueba', meleeCover.inCover === 'cover', JSON.stringify(meleeCover));
check('melee ignorado en cobertura', meleeCover.after === 'cover', JSON.stringify(meleeCover));

// 4) cambio rápido de armas SPAM: sin dobles cambios ni estados rotos
const spam = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let changes = 0;
  let last = G.weapons.cur;
  for (let i = 0; i < 12; i++) {
    I.slotPressed = i % 4;
    I.cycleDir = 1;
    I.swapPressed = true;
    await wait(70);
    if (G.weapons.cur !== last) { changes++; last = G.weapons.cur; }
  }
  await wait(800);
  return { changes, cur: G.weapons.cur, swapping: G.weapons.swapping, slots: G.weapons.slots.length };
});
// 12 pedidos en 840ms con SWAP_TIME 0.55 → como mucho ~2 cambios reales
check('spam de cambio limitado por la animación', spam.changes <= 3 && spam.slots === 4, JSON.stringify(spam));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nMATCH-SYSTEMS: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nMATCH-SYSTEMS: todo verde');
