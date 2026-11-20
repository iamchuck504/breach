import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
import { CHROME } from './lib-chrome.mjs';
const port = 18840 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(port),
], { cwd: root, stdio: 'ignore' });
for (let i = 0; i < 600; i++) { // Vite listo cuando responde (no tras una espera fija)
  try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch { /* arrancando */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let browser;
try {
  // SWIFT=1 (render por software, como el runner sin GPU), THROTTLE=12 (CPU
  // 12× más lenta por CDP), FRAME_MS=700 (cada cuadro dura eso): condiciones
  // lentas para comprobar que nada depende del reloj de pared.
  browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: process.env.SWIFT ? ['--use-angle=swiftshader', '--disable-gpu'] : [] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(300000);
  if (Number(process.env.THROTTLE) > 1) {
    await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  }
  // Reloj de cuadros: cada cuadro del juego hace UN poll del gamepad, así que
  // las ayudas mantienen botones/ejes durante cuadros, no milisegundos (un
  // botón más corto que un cuadro no lo ve ninguna Gamepad API). __slowFrames
  // fuerza cuadros largos (global con FRAME_MS, o por sección).
  await page.addInitScript((ms) => {
    const native = window.requestAnimationFrame.bind(window);
    window.__slowFrames = ms;
    window.requestAnimationFrame = (cb) => (window.__slowFrames
      ? setTimeout(() => cb(performance.now()), window.__slowFrames) : native(cb));
    window.__frames = 0;
    const tick = () => { window.__frames++; window.requestAnimationFrame(tick); };
    window.requestAnimationFrame(tick);
  }, Number(process.env.FRAME_MS) || 0);
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
    // Historial de foco para diagnosticar fallos que solo ocurren en CI.
    window.__focusLog = [];
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      window.__focusLog.push(`${Math.round(performance.now())} ${el.id || el.dataset?.navKey || el.tagName}`);
      if (window.__focusLog.length > 40) window.__focusLog.shift();
    }, true);
  });
  await page.goto(`http://127.0.0.1:${port}/?nolock=1`, { waitUntil: 'networkidle', timeout: 300000 });

  // espera a que el juego haya corrido `n` cuadros completos desde ahora
  const frames = async (n = 2) => {
    const f0 = await page.evaluate(() => window.__frames);
    await page.waitForFunction((t) => window.__frames >= t, f0 + n, { polling: 20, timeout: 300000 });
  };
  // pulso: abajo durante ≥ 2 cuadros (al menos un poll lo ve pulsado) y ≥ 2
  // cuadros soltado (el poll ve la suelta) — vale con cuadros de 16 o 700 ms
  const tap = async (button) => {
    await page.evaluate(([i, down]) => window.__padButton(i, down), [button, true]);
    await frames(2);
    await page.evaluate(([i, down]) => window.__padButton(i, down), [button, false]);
    await frames(2);
  };
  const tapMirrored = async (button, key) => {
    await page.evaluate(({ button, key }) => {
      window.__padButton(button, true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
      for (let i = 0; i < 5; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, repeat: true, bubbles: true }));
      }
    }, { button, key });
    // pulso de pared A PROPÓSITO (190 ms): con cuadros largos ningún poll lo
    // ve y la flecha espejada debe pagar el paso (menu-controller owedStep)
    await page.waitForTimeout(190);
    await page.evaluate(({ button, key }) => {
      window.__padButton(button, false);
      document.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
    }, { button, key });
    await frames(2);
  };
  // orden inverso: el pad ya movió (lo vio un poll) y la flecha llega después
  const tapMirroredLate = async (button, key) => {
    await page.evaluate((b) => window.__padButton(b, true), button);
    await frames(2);
    await page.evaluate(({ button, key }) => {
      window.__padButton(button, false);
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
    }, { button, key });
    await frames(2);
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
  // Espera acotada: sin GPU (CI) un frame puede durar ~700 ms y la
  // restauración del foco llega uno o dos frames después del gesto.
  // tope: 2.5 s de pared Y al menos 6 cuadros (con cuadros de 700 ms, 2.5 s
  // son 3 cuadros y la restauración de foco puede tardar uno o dos)
  const expectFocus = async (expected, message, timeout = 2500) => {
    const matches = (got) => Object.entries(expected).every(([k, v]) => got[k] === v);
    let got = await active();
    const f0 = await page.evaluate(() => window.__frames);
    for (const t0 = Date.now(); !matches(got) &&
      (Date.now() - t0 < timeout || await page.evaluate((f) => window.__frames < f + 6, f0));) {
      await page.waitForTimeout(50);
      got = await active();
    }
    if (!matches(got)) {
      const log = await page.evaluate(() => window.__focusLog.slice(-15).join(' | '));
      throw new Error(`${message}: ${JSON.stringify(got)}\nfoco reciente: ${log}`);
    }
  };
  // el stick se mantiene CUADROS, no ms: la repetición del menú empieza a
  // 0.46 s de tiempo de juego (dt ≤ 0.1 s por cuadro). Un cuadro basta para que
  // un poll lo vea; dos inclinaciones seguidas suman ≤ 4 cuadros (≤ 0.4 s), así
  // que un runner lento no convierte una inclinación corta en repetición.
  const tilt = async (axis, value) => {
    await page.evaluate(([i, v]) => window.__padAxis(i, v), [axis, value]);
    await frames(1);
  };
  const neutral = async () => {
    await page.evaluate(() => { window.__padAxis(0, 0); window.__padAxis(1, 0); });
    await Promise.all([page.waitForTimeout(100), frames(2)]);
  };

  await tap(0); // A: splash
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await frames(2);
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

  // Arranque frío con Steam/Input mapper: el mismo gesto llega como D-pad y
  // ArrowDown (incluyendo repeats). Debe seguir siendo exactamente un paso.
  await tapMirrored(13, 'ArrowDown');
  await expectFocus({ id: 'btn-practice' }, 'D-pad vertical no siguió la jerarquía del main menu');
  await tap(12);
  await expectFocus({ id: 'btn-bots' }, 'arriba no regresó a VS Bots');

  // Gesto espejado con cuadros MÁS LARGOS que la pulsación (CI sin GPU): en
  // ambos órdenes debe ser exactamente un paso (antes: 0 o 2).
  await page.evaluate(() => { window.__slowFrames = 700; });
  await frames(1);
  await tapMirrored(13, 'ArrowDown');
  await expectFocus({ id: 'btn-practice' }, 'cuadros largos: el gesto espejado no dio exactamente un paso');
  await tapMirroredLate(12, 'ArrowUp');
  await expectFocus({ id: 'btn-bots' }, 'cuadros largos: la flecha tardía duplicó el paso del pad');
  await page.evaluate((ms) => { window.__slowFrames = ms; }, Number(process.env.FRAME_MS) || 0);
  await frames(1);
  await tap(13);
  await expectFocus({ id: 'btn-practice' }, 'abajo desde VS Bots no llegó a Practice');
  await tap(15); // Practice -> Map, relación explícita entre columnas
  await expectFocus({ id: 'btn-map' }, 'derecha desde Practice no llegó a Map');
  await tap(14);
  await expectFocus({ id: 'btn-practice' }, 'izquierda desde Map no regresó a Practice');
  await tap(12); // back to VS Bots
  await expectFocus({ id: 'btn-bots' }, 'arriba no regresó a VS Bots');

  // Deadzone + flanco: una inclinación corta produce exactamente un paso.
  await tilt(1, 0.45); // bajo deadzone
  await expectFocus({ id: 'btn-bots' }, 'el stick se movió dentro de la deadzone');
  await neutral();
  // Inclinación y cambio de eje en UNA secuencia dentro de la página, contada
  // en cuadros: el stick queda inclinado 4 cuadros (≤ 0.4 s de juego, bajo los
  // 0.46 s de la repetición) aunque cada viaje de Playwright tarde mucho.
  const stick = await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const id = () => document.activeElement?.id || '';
    window.__padAxis(1, 0.9); await raf(); await raf();
    const first = id();
    window.__padAxis(0, 0.95); await raf(); await raf(); // cambiar de eje sin neutral
    const afterSwitch = id();
    window.__padAxis(0, 0); window.__padAxis(1, 0); await raf(); await raf();
    return { first, afterSwitch };
  });
  if (stick.first !== 'btn-practice') throw new Error(`la inclinación inicial no produjo exactamente un paso: ${JSON.stringify(stick)}`);
  if (stick.afterSwitch !== 'btn-practice') throw new Error(`el stick cambió de eje sin volver a neutral: ${JSON.stringify(stick)}`);
  await neutral();
  await tap(12);

  await tap(0);  // open local lobby
  await page.waitForFunction(() => !document.getElementById('lobby-card').classList.contains('off'), null, { timeout: 5000, polling: 50 }).catch(() => {});
  await frames(2);
  if (!await page.$eval('#lobby-card', (el) => !el.classList.contains('off'))) {
    const state = await page.evaluate(() => ({
      focus: document.activeElement?.id,
      bodyClass: document.body.className,
      padIndex: window.BREACH_INPUT?.pad?._idx,
      pressed: [...(window.BREACH_INPUT?.pad?.pressed || [])],
      edges: [...(window.BREACH_INPUT?.pad?.justPressed || [])],
    }));
    throw new Error(`A no abrió el lobby local: ${JSON.stringify(state)}`);
  }
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

  // Controles vive bajo Opciones: hub primero, subcard después
  await focus('#btn-options');
  await tap(0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#options-card')).display === 'block');
  await focus('#btn-opt-controls');
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
  await tap(1); // B: controles → hub de Opciones
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#options-card')).display === 'block');
  await tap(1); // B: Opciones → menú principal
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#main-card')).display !== 'none');
  await expectFocus({ id: 'btn-options' }, 'volver de Opciones no restauró el botón de origen');

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
  await page.waitForFunction(() => !document.getElementById('menu').classList.contains('off'), null, { timeout: 5000, polling: 50 }).catch(() => {});
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
  await frames(2);
  if (await page.$eval('body', (el) => el.classList.contains('using-controller'))) {
    throw new Error('mouse no recuperó el modo de input');
  }
  const keyboardPrompts = await page.$eval('#menu-prompts', (el) => getComputedStyle(el).display);
  if (keyboardPrompts !== 'none') throw new Error('prompts de controller siguieron visibles con mouse');

  // Reinicio completo: la inicialización debe conservar el mismo debounce.
  await page.reload({ waitUntil: 'networkidle', timeout: 300000 });
  await tap(0);
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await frames(2);
  await tapMirrored(13, 'ArrowDown');
  await expectFocus({ id: 'btn-practice' }, 'tras reiniciar, una pulsación volvió a producir múltiples saltos');
  if (errors.length) throw new Error(errors.join(' · '));
  console.log('MENU CONTROLLER OK · cold boot/reload · D-pad+Steam dedupe · stick · pantallas · device swap');
} finally {
  await browser?.close();
  server.kill();
}
