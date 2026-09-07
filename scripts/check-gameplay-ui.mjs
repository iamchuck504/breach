import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '8838'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8838/?nolock=1');
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const g = window.BREACH;
    g.mode = 'qa'; // disable Practice's unconditional reserve replenishment
    g.weapons.infinite = false;
    g.weapons.state.smg.mag = 0; g.weapons.state.smg.reserve = 0;
    g.weapons.state.shotgun.mag = 0; g.weapons.state.shotgun.reserve = 4;
    window.BREACH_INPUT.slotPressed = 1;
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.wheel-sector[data-weapon="smg"]').evaluate(e => e.classList.contains('dry')), true);
  assert.equal(await page.locator('.wheel-sector[data-weapon="shotgun"]').evaluate(e => e.classList.contains('needs-reload')), true);
  await mkdir('artifacts/gameplay-tuning', { recursive: true });
  await page.screenshot({ path: 'artifacts/gameplay-tuning/wheel.png' });
  await page.waitForTimeout(600);
  const result = await page.evaluate(async () => {
    const g = window.BREACH, p = g.player;
    const { WeaponDrops } = await import('/src/game/drops.js');
    g.drops = new WeaponDrops(g.rig.root.parent);
    g.drops.spawn('qa-special', 'sniper', p.pos.x, p.pos.z, 'red', 1, 3, 30, p.y);
    await new Promise(r => setTimeout(r, 200));
    return { slots: [...g.weapons.slots], prompt: document.getElementById('pickup-prompt').textContent };
  });
  assert.ok(!result.slots.includes('sniper'));
  assert.ok(result.prompt.includes('SNPR') && result.prompt.includes('replace'));
  await page.screenshot({ path: 'artifacts/gameplay-tuning/prompt.png' });
  await page.evaluate(async () => {
    const { BINDS } = await import('/src/core/bindings.js');
    BINDS.pad.evade = 3;
    window.BREACH_INPUT.lastDevice = 'pad';
  });
  await page.waitForTimeout(60);
  assert.ok((await page.locator('#pickup-prompt').textContent()).includes('[Y]'));
  await page.evaluate(async () => {
    const { BINDS } = await import('/src/core/bindings.js');
    BINDS.kb.evade = 'KeyE';
    window.BREACH_INPUT.lastDevice = 'keyboard';
  });
  await page.waitForTimeout(60);
  assert.ok((await page.locator('#pickup-prompt').textContent()).includes('[E]'));
  await page.evaluate(() => { window.BREACH_INPUT.evadePressed = true; });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.BREACH.weapons.slots.includes('sniper')), true);
  const ammo = await page.evaluate(async () => {
    const g = window.BREACH, p = g.player;
    g.weapons.state.sniper.reserve = 0;
    g.drops.spawn('qa-ammo', 'sniper', p.pos.x, p.pos.z, 'red', 1, 20, 30, p.y);
    await new Promise(r => setTimeout(r, 200));
    const remaining = g.drops.drops.get('qa-ammo');
    return { reserve: g.weapons.state.sniper.reserve, left: remaining.mag + remaining.res };
  });
  assert.equal(ammo.reserve + ammo.left, 21);
  assert.ok(ammo.left > 0);
  assert.deepEqual(errors, []);
  console.log('PASS UI: whole-slot dry/reload states, explicit replacement, partial ammo conservation, no page errors.');
} finally { await browser.close(); server.kill(); }
