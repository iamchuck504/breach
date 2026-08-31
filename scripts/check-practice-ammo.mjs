// PRÁCTICA = munición infinita para TODO el arsenal: la reserva nunca baja
// (recargas eternas), la granada se repone sola, y el pedestal reaparece
// alternando sniper↔bazooka al tomarlo. Bots/online conservan munición real.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8798', '--strictPort'], { stdio: 'ignore' });
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

await page.goto('http://localhost:8798/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1800);

// helper: vaciar el cargador y esperar la recarga automática
await page.evaluate(() => {
  window.__fireUntil = async (predicate, ms = 4000) => {
    const I = window.BREACH_INPUT;
    const t0 = performance.now();
    I._mouseFire = true;
    while (!predicate() && performance.now() - t0 < ms) {
      I.firePressed = true;
      await new Promise((r) => setTimeout(r, 40));
    }
    I._mouseFire = false;
    return predicate();
  };
});

// 1) SMG: vaciar el cargador → la recarga rellena y la reserva NO baja
const smg = await page.evaluate(async () => {
  const G = window.BREACH;
  for (const d of G.dummies.list) { d.alive = false; d.respawnT = 9999; }
  G.player.cam.pitch = 0.3; // disparar al aire
  G.weapons.cur = 'smg';
  const reserve0 = G.weapons.st.reserve;
  await window.__fireUntil(() => G.weapons.st.mag === 0, 8000);
  await new Promise((r) => setTimeout(r, 2400)); // reload 1.9s
  return {
    infinite: G.weapons.infinite,
    mag: G.weapons.st.mag, magFull: G.weapons.def.mag,
    reserve: G.weapons.st.reserve, reserve0,
  };
});
check('práctica activa munición infinita', smg.infinite === true);
check('SMG: recarga llena SIN gastar reserva',
  smg.mag === smg.magFull && smg.reserve === smg.reserve0, JSON.stringify(smg));

// 2) GRANADA: lanzar 3 — el contador nunca baja
const nade = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT;
  G.weapons.cur = 'grenade';
  G.weapons.swapT = 0;
  await new Promise((r) => setTimeout(r, 300));
  const magFull = G.weapons.def.mag;
  let thrown = 0;
  for (let i = 0; i < 3; i++) {
    I._mouseFire = true; I.firePressed = true;
    await new Promise((r) => setTimeout(r, 120));
    I._mouseFire = false;
    await new Promise((r) => setTimeout(r, 900)); // gesto + recovery
    thrown++;
  }
  return { thrown, mag: G.weapons.st.mag, magFull };
});
check('granada infinita: el contador se repone al lanzar',
  nade.mag === nade.magFull, JSON.stringify(nade));

// 3) PEDESTAL: tomar el sniper → reaparece con bazooka → tomarla → sniper
const pedestal = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  const S = window.BREACH_SPECIALS;
  const { BINDS } = await import('/src/core/bindings.js');
  const spot = W.specialSpot;
  const seq = [];
  const takeOne = window.__takeSpecial = async () => {
    const offered = S.active?.wep;
    G.player.pos.x = spot.x; G.player.pos.z = spot.z;
    I.keys.add(BINDS.kb.evade);
    const t0 = performance.now();
    while (S.active?.wep === offered && performance.now() - t0 < 2500) {
      await new Promise((r) => setTimeout(r, 50));
    }
    I.keys.delete(BINDS.kb.evade);
    await new Promise((r) => setTimeout(r, 200));
    return offered;
  };
  seq.push({ took: await takeOne(), cur: G.weapons.cur, next: S.active?.wep });
  seq.push({ took: await takeOne(), cur: G.weapons.cur, next: S.active?.wep });
  return seq;
});
check('pedestal de práctica alterna sniper→bazooka→sniper',
  pedestal[0].took === 'sniper' && pedestal[0].next === 'bazooka' &&
  pedestal[1].took === 'bazooka' && pedestal[1].next === 'sniper',
  JSON.stringify(pedestal));

// 4) BAZOOKA (mag 1): disparar y recargar 3 ciclos — nunca se agota
const bazooka = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT;
  G.weapons.cur = 'bazooka';
  G.weapons.swapT = 0;
  G.player.cam.pitch = 0.4;
  await new Promise((r) => setTimeout(r, 300));
  let shots = 0;
  for (let i = 0; i < 3; i++) {
    if (!await window.__fireUntil(() => G.weapons.st.mag === 0, 3000)) break;
    shots++;
    const t0 = performance.now();
    while (G.weapons.st.mag === 0 && performance.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  return { shots, mag: G.weapons.st.mag, reserve: G.weapons.st.reserve };
});
check('bazooka infinita: 3 ciclos de disparo+recarga',
  bazooka.shots === 3 && bazooka.mag >= 1, JSON.stringify(bazooka));

// 5) SNIPER: igual — se toma del pedestal (quedó ofreciéndolo) y dispara sin fin
const sniper = await page.evaluate(async () => {
  const G = window.BREACH;
  await window.__takeSpecial(); // el pedestal ofrecía sniper tras la fase 3
  G.weapons.swapT = 0;
  await new Promise((r) => setTimeout(r, 300));
  let shots = 0;
  for (let i = 0; i < 3; i++) {
    if (!await window.__fireUntil(() => G.weapons.st.mag === 0, 3000)) break;
    shots++;
    const t0 = performance.now();
    while (G.weapons.st.mag === 0 && performance.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  return { shots, mag: G.weapons.st.mag };
});
check('sniper infinito: 3 ciclos de disparo+recarga',
  sniper.shots === 3 && sniper.mag >= 1, JSON.stringify(sniper));

// 6) MODO BOTS: la munición vuelve a ser REAL (la reserva baja al recargar)
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('btn-leave-match')?.click());
await page.waitForTimeout(900);
await page.evaluate(() => document.getElementById('btn-bots').click());
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('btn-lobby-start').click());
await page.waitForFunction(() => window.BREACH.botMatch && window.BREACH.mode === 'bots',
  null, { timeout: 15000 });
await page.waitForFunction(() => {
  const G = window.BREACH;
  return G.player && G.selfAlive && !G.botMatch.controlsLocked?.();
}, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(4500);
const bots = await page.evaluate(async () => {
  const G = window.BREACH;
  G.player.cam.pitch = 0.3;
  const reserve0 = G.weapons.st.reserve;
  await window.__fireUntil(() => G.weapons.st.mag === 0, 9000);
  await new Promise((r) => setTimeout(r, 2400));
  return {
    infinite: G.weapons.infinite,
    reserve: G.weapons.st.reserve, reserve0,
    mag: G.weapons.st.mag,
  };
});
check('vs bots la munición es real (reserva baja al recargar)',
  bots.infinite === false && bots.reserve < bots.reserve0 && bots.mag > 0,
  JSON.stringify(bots));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nPRACTICE-AMMO: todo verde');
await browser.close();
server.kill();
await clearClip();
process.exit(fails.length ? 1 : 0);
