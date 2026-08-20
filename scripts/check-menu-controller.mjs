import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const port = 18840 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(port),
], { cwd: root, stdio: 'ignore' });
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
  const active = () => page.evaluate(() => ({
    tag: document.activeElement?.tagName || '',
    id: document.activeElement?.id || '',
    key: document.activeElement?.dataset?.navKey || '',
    column: document.activeElement?.dataset?.navColumn || '',
    action: document.activeElement?.dataset?.action || '',
    setting: document.activeElement?.dataset?.setting || '',
    marked: document.querySelector('.menu-nav-focus')?.dataset?.navKey || document.querySelector('.menu-nav-focus')?.id || '',
    mode: document.body.classList.contains('using-controller') ? 'controller' : 'keyboard',
  }));
  const expectFocus = async (expected, message) => {
    const got = await active();
    if (!Object.entries(expected).every(([k, v]) => got[k] === v)) {
      throw new Error(`${message}: ${JSON.stringify(got)}`);
    }
  };
  const tilt = async (axis, value, duration = 150) => {
    await page.evaluate(([i, v]) => window.__padAxis(i, v), [axis, value]);
    await page.waitForTimeout(duration);
  };
  const neutral = async () => {
    await page.evaluate(() => { window.__padAxis(0, 0); window.__padAxis(1, 0); });
    await page.waitForTimeout(100);
  };

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
  await expectFocus({ id: 'btn-practice' }, 'D-pad vertical no siguió la jerarquía del main menu');
  await tap(15); // Practice -> Map, relación explícita entre columnas
  await expectFocus({ id: 'btn-map' }, 'derecha desde Practice no llegó a Map');
  await tap(14);
  await expectFocus({ id: 'btn-practice' }, 'izquierda desde Map no regresó a Practice');
  await tap(12); // back to VS Bots
  await expectFocus({ id: 'btn-bots' }, 'arriba no regresó a VS Bots');

  // Deadzone + flanco: una inclinación corta produce exactamente un paso.
  await tilt(1, 0.45, 180); // bajo deadzone
  await expectFocus({ id: 'btn-bots' }, 'el stick se movió dentro de la deadzone');
  await neutral();
  await tilt(1, 0.9, 180);
  await expectFocus({ id: 'btn-practice' }, 'la inclinación inicial no produjo exactamente un paso');
  await tilt(0, 0.95, 120); // cambiar de eje sin neutral no debe relanzar
  await expectFocus({ id: 'btn-practice' }, 'el stick cambió de eje sin volver a neutral');
  await neutral();
  await tap(12);

  await tap(0);  // open local lobby
  await page.waitForSelector('#lobby-card:not(.off)');
  await expectFocus({ id: 'btn-lobby-start' }, 'el lobby no inició en Start Match');
  await tap(12);
  await expectFocus({ setting: 'postMatch' }, 'arriba desde Start no llegó al último ajuste');
  await tap(12);
  await expectFocus({ setting: 'lives' }, 'los ajustes del lobby no siguieron orden vertical');

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
  await expectFocus({ column: 'keyboard' }, 'Controles no inició en la primera asignación de teclado');
  await tap(15);
  await expectFocus({ column: 'controller' }, 'derecha no cruzó a la asignación equivalente del controller');
  const padBinds = await page.$$eval('[data-nav-column="controller"]', (els) => els.length);
  for (let i = 1; i < padBinds; i++) await tap(13);
  await tap(13);
  await expectFocus({ id: 'sl-pad' }, 'abajo desde la columna controller no llegó a Stick Sens.');
  const before = Number(await page.$eval('#sl-pad', (el) => el.value));
  await tap(15);
  const after = Number(await page.$eval('#sl-pad', (el) => el.value));
  if (!(after > before)) throw new Error('D-pad no modificó el slider');
  await tap(1);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#main-card')).display !== 'none');
  await expectFocus({ id: 'btn-controls' }, 'volver de Controles no restauró el botón de origen');

  await focus('#btn-character');
  await tap(0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#char-card')).display === 'block');
  await page.waitForSelector('.char-slot');
  await page.waitForTimeout(350);
  await expectFocus({ key: 'char:0' }, 'Personaje no enfocó el skin seleccionado');
  await tap(15);
  await tap(0);
  if (!await page.$eval('.char-slot:nth-child(2)', (el) => el.classList.contains('sel'))) {
    throw new Error('selección horizontal de personaje no respondió');
  }
  await tap(13);
  await expectFocus({ id: 'btn-char-back' }, 'abajo desde un personaje no llegó a Back');
  await tap(12);
  await expectFocus({ key: 'char:1' }, 'arriba desde Back no volvió al personaje seleccionado');
  await tap(1);
  await expectFocus({ id: 'btn-character' }, 'volver de Personaje no restauró el botón de origen');

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
