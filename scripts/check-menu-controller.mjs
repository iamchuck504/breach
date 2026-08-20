import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const port = 18840 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 850));

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const state = {
      id: 'BREACH TEST PAD', index: 0, connected: true, mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [state] });
    window.__padButton = (i, down) => {
      state.buttons[i].pressed = down; state.buttons[i].value = down ? 1 : 0;
    };
    window.__padAxis = (i, value) => { state.axes[i] = value; };
  });
  await page.goto(`http://127.0.0.1:${port}/?nolock=1`, { waitUntil: 'networkidle' });

  const tap = async (button) => {
    await page.evaluate(([i, down]) => window.__padButton(i, down), [button, true]);
    // En gameplay headless el render 3D puede bajar de 20 fps; mantener el
    // pulso dos frames evita que el harness sea más rápido que un toque humano.
    await page.waitForTimeout(120);
    await page.evaluate(([i, down]) => window.__padButton(i, down), [button, false]);
    await page.waitForTimeout(75);
  };
  const focus = (selector) => page.$eval(selector, (el) => el.focus());

  await tap(0); // A: splash
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.waitForTimeout(80);
  if (!await page.$eval('body', (el) => el.classList.contains('using-controller'))) {
    throw new Error('el gamepad no activó el modo controller');
  }
  if (!await page.$eval('#btn-bots', (el) => el.classList.contains('menu-nav-focus'))) {
    throw new Error('main menu no restauró el foco principal');
  }
  const focusStyle = await page.$eval('#btn-bots', (el) => ({
    shadow: getComputedStyle(el).boxShadow,
    prompt: getComputedStyle(document.getElementById('menu-prompts')).display,
  }));
  if (!focusStyle.shadow || focusStyle.shadow === 'none' || focusStyle.prompt !== 'flex') {
    throw new Error('el foco/prompts de controller no son suficientemente visibles');
  }

  await tap(13); // D-pad down: VS Bots -> Practice
  if (await page.evaluate(() => document.activeElement?.id) !== 'btn-practice') {
    throw new Error('D-pad vertical no siguió la jerarquía del main menu');
  }
  await tap(12); // back to VS Bots
  await tap(0);  // open local lobby
  await page.waitForSelector('#lobby-card:not(.off)');

  await focus('[data-setting="map"]');
  await tap(15); // right changes selector
  if (await page.$eval('[data-setting="map"]', (el) => el.value) !== 'azoteas') {
    throw new Error('D-pad no modificó el selector de mapa');
  }
  await focus('[data-action="team"][data-team="blue"]');
  await tap(0);
  if (!await page.$eval('[data-action="team"][data-team="blue"]', (el) => el.disabled)) {
    throw new Error('A no ejecutó la selección de Team Blue');
  }
  await tap(1); // B leaves lobby
  await page.waitForSelector('#lobby-card.off', { state: 'attached' });

  await focus('#btn-controls');
  await tap(0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#controls-card')).display === 'block');
  await focus('#sl-pad');
  const before = Number(await page.$eval('#sl-pad', (el) => el.value));
  await tap(15);
  const after = Number(await page.$eval('#sl-pad', (el) => el.value));
  if (!(after > before)) throw new Error('D-pad no modificó el slider');
  await tap(1);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#main-card')).display !== 'none');

  await focus('#btn-character');
  await tap(0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#char-card')).display === 'block');
  await page.waitForSelector('.char-slot');
  await focus('.char-slot');
  await tap(15);
  await tap(0);
  if (!await page.$eval('.char-slot:nth-child(2)', (el) => el.classList.contains('sel'))) {
    throw new Error('selección horizontal de personaje no respondió');
  }
  await tap(1);

  await focus('#btn-practice');
  await tap(0);
  await page.waitForSelector('#menu.off', { state: 'attached' });
  await tap(9); // MENU: pause
  await page.waitForTimeout(160);
  if (!await page.$eval('#menu', (el) => !el.classList.contains('off'))) {
    const state = await page.evaluate(() => ({
      mode: window.BREACH?.mode,
      connected: window.BREACH_INPUT?.pad.connected,
      pressed: [...(window.BREACH_INPUT?.pad.pressed || [])],
      pauseBind: window.BREACH_INPUT ? 9 : null,
    }));
    throw new Error(`MENU no abrió pausa: ${JSON.stringify(state)}`);
  }
  if (await page.evaluate(() => document.activeElement?.id) !== 'btn-resume') {
    throw new Error('pause menu no enfocó Resume');
  }
  await tap(0);
  await page.waitForSelector('#menu.off', { state: 'attached' });

  await tap(9);
  await page.waitForSelector('#menu:not(.off)');
  await page.mouse.move(40, 40);
  await page.waitForTimeout(40);
  if (await page.$eval('body', (el) => el.classList.contains('using-controller'))) {
    throw new Error('mouse no recuperó el modo de input');
  }
  const keyboardPrompts = await page.$eval('#menu-prompts', (el) => getComputedStyle(el).display);
  if (keyboardPrompts !== 'none') throw new Error('prompts de controller siguieron visibles con mouse');
  if (errors.length) throw new Error(errors.join(' · '));
  console.log('MENU CONTROLLER OK · splash/main/lobby/team/settings/character/pause · device swap');
} finally {
  await browser?.close();
  server.kill();
}
