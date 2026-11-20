import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '8838'], { stdio: 'ignore' });
for (let i = 0; i < 600; i++) { // Vite listo cuando responde (no tras una espera fija)
  try { if ((await fetch('http://127.0.0.1:8838/')).ok) break; } catch { /* arrancando */ }
  await new Promise(r => setTimeout(r, 100));
}
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: process.env.SWIFT ? ['--use-angle=swiftshader', '--disable-gpu'] : [] });
// Las esperas son "≥ N cuadros del juego Y ≥ los ms de antes": en un runner sin
// GPU un cuadro puede durar ~700 ms y el HUD/la simulación se actualizan por cuadro.
const framesIn = (n) => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(300000);
  if (Number(process.env.THROTTLE) > 1) {
    await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  }
  if (process.env.FRAME_MS) await page.addInitScript((ms) => {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), ms);
  }, Number(process.env.FRAME_MS));
  const settle = (ms, n = 3) => Promise.all([page.waitForTimeout(ms), page.evaluate(`(${framesIn})(${n})`)]);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8838/?nolock=1', { timeout: 300000 });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { polling: 50 });
  await settle(1200, 4);
  await page.evaluate(() => {
    const g = window.BREACH;
    g.mode = 'qa'; // disable Practice's unconditional reserve replenishment
    g.weapons.infinite = false;
    g.weapons.state.smg.mag = 0; g.weapons.state.smg.reserve = 0;
    g.weapons.state.shotgun.mag = 0; g.weapons.state.shotgun.reserve = 4;
    window.BREACH_INPUT.slotPressed = 1;
  });
  // 2 cuadros exactos (el HUD se pinta por cuadro): con una espera de pared,
  // en un runner lento el cambio de arma y la recarga avanzaban de más
  // y se leen en el MISMO evaluate: cada viaje de Playwright puede durar
  // varios cuadros y el cambio de arma + recarga automática seguir avanzando
  const wheel = await page.evaluate(async (fr) => {
    await (0, eval)(fr)(2);
    const cls = (w) => document.querySelector(`.wheel-sector[data-weapon="${w}"]`)?.classList;
    return { smgDry: !!cls('smg')?.contains('dry'), shotgunNeedsReload: !!cls('shotgun')?.contains('needs-reload') };
  }, `(${framesIn})`);
  assert.equal(wheel.smgDry, true);
  assert.equal(wheel.shotgunNeedsReload, true);
  await mkdir('artifacts/gameplay-tuning', { recursive: true });
  await page.screenshot({ path: 'artifacts/gameplay-tuning/wheel.png' });
  await settle(600);
  const result = await page.evaluate(async () => {
    const g = window.BREACH, p = g.player;
    const { WeaponDrops } = await import('/src/game/drops.js');
    g.drops = new WeaponDrops(g.rig.root.parent);
    g.drops.spawn('qa-special', 'sniper', p.pos.x, p.pos.z, 'red', 1, 3, 30, p.y);
    await Promise.all([new Promise(r => setTimeout(r, 200)),
      new Promise(r => { let k = 0; const f = () => (++k >= 4 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); })]);
    return { slots: [...g.weapons.slots], prompt: document.getElementById('pickup-prompt').textContent };
  });
  assert.ok(!result.slots.includes('sniper'));
  assert.ok(result.prompt.includes('SNPR') && result.prompt.includes('replace'));
  assert.ok(result.prompt.includes('[E]'), 'recoger con E por defecto en teclado');
  await page.screenshot({ path: 'artifacts/gameplay-tuning/prompt.png' });
  await page.evaluate(async () => {
    const { BINDS } = await import('/src/core/bindings.js');
    BINDS.pad.evade = 3;
    window.BREACH_INPUT.lastDevice = 'pad';
  });
  await settle(60);
  assert.ok((await page.locator('#pickup-prompt').textContent()).includes('[Y]'));
  await page.evaluate(async () => {
    const { BINDS } = await import('/src/core/bindings.js');
    BINDS.kb.pickup = 'KeyG'; // recoger tiene tecla propia (E por defecto) y se puede reasignar
    window.BREACH_INPUT.lastDevice = 'keyboard';
  });
  await settle(60);
  assert.ok((await page.locator('#pickup-prompt').textContent()).includes('[G]'));
  await page.evaluate(() => { window.BREACH_INPUT.pickupPressed = true; });
  await settle(150);
  assert.equal(await page.evaluate(() => window.BREACH.weapons.slots.includes('sniper')), true);
  const ammo = await page.evaluate(async () => {
    const g = window.BREACH, p = g.player;
    g.weapons.state.sniper.reserve = 0;
    g.drops.spawn('qa-ammo', 'sniper', p.pos.x, p.pos.z, 'red', 1, 20, 30, p.y);
    await Promise.all([new Promise(r => setTimeout(r, 200)),
      new Promise(r => { let k = 0; const f = () => (++k >= 4 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); })]);
    const remaining = g.drops.drops.get('qa-ammo');
    return { reserve: g.weapons.state.sniper.reserve, left: remaining.mag + remaining.res };
  });
  assert.equal(ammo.reserve + ammo.left, 21);
  assert.ok(ammo.left > 0);
  assert.deepEqual(errors, []);
  console.log('PASS UI: whole-slot dry/reload states, explicit replacement, partial ammo conservation, no page errors.');
} finally { await browser.close(); server.kill(); }
