// INICIO DE PARTIDA CON EL FLUJO REAL DEL RATÓN (sin ?nolock). Las demás
// suites usan ?nolock y no ven lo que vive un jugador en Chrome/Safari: el
// pointer lock solo se concede con una activación de usuario vigente (5 s).
// Aquí requestPointerLock se sustituye por un simulador con esa regla (nunca
// se pide un lock real: no confina el ratón físico) y se juega con clicks y
// teclas reales de Playwright (auto-repeat incluido).
// Sirve dist/ (correr `npm run build` antes) o BASE=http://... para un Vite.
// Robusto en máquinas lentas: TODOS los límites de tiempo se miden en tiempo
// de JUEGO (el mismo dt acotado a 0.1 s por cuadro que usa main.js), nunca en
// reloj de pared; los esperas de pared solo son topes generosos. THROTTLE=12
// emula una CPU 12× más lenta (CDP) para comprobarlo.
import { actionKeys } from './lib-test.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const THROTTLE = Number(process.env.THROTTLE) || 0;
const T = 300000; // tope de pared para esperas (no decide nada: solo evita colgarse)
// Puerto libre elegido por el sistema: con un puerto fijo, dos copias de la
// suite en paralelo (o check-bot-ammo-swap, que usa el mismo) se pisaban el
// servidor y la prueba hablaba con el de la otra copia.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
let server = null, BASE = process.env.BASE;
if (!BASE) {
  const PORT = await freePort();
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'test' };
  delete env.BREACH_FILL_BOTS;
  server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 300; i++) { // listo cuando responde, no tras una espera fija
    try { if ((await fetch(BASE)).ok) break; } catch { /* aún arrancando */ }
    await wait(100);
  }
}

const ONLY = process.env.ONLY || ''; // p. ej. ONLY=CH para depurar secciones
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

// rule: 'gesture' = activación de cualquier click/tecla (Chrome/Safari);
// 'canvas' = el click de START no la otorga (p. ej. la carga tardó > 5 s).
// 'dispatch' = solo se concede si se pide DENTRO de la propagación de un
// evento de confianza (lo estricto: ningún reintento posterior cuenta);
// 'dispatch-nostart' = igual, pero el click de START no sirve (gesto vencido);
// 'canvas-click' = solo el mousedown sobre el canvas (captura retrasada).
function lockSim({ rule, pad }) {
  let el = null, lastAct = -1e9, during = null;
  window.__lock = { requests: 0, granted: 0, log: [] };
  for (const ev of ['mousedown', 'mouseup', 'click', 'keydown']) {
    window.addEventListener(ev, (e) => { if (e.isTrusted && e.key !== 'Escape') during = `${ev}#${e.target?.id || e.target?.tagName}`; }, true);
    // fin de la propagación: después de TODOS los listeners (también los de
    // window registrados más tarde por el juego)
    window.addEventListener(ev, () => { const d = during; setTimeout(() => { if (during === d) during = null; }, 0); });
  }
  for (const ev of ['mousedown', 'keydown'])
    window.addEventListener(ev, (e) => {
      if (!e.isTrusted || e.key === 'Escape') return;
      if (rule === 'canvas' && ev === 'mousedown' && e.target?.tagName !== 'CANVAS') return;
      lastAct = performance.now();
    }, true);
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get() { return el; } });
  const change = (v) => { el = v; document.dispatchEvent(new Event('pointerlockchange')); };
  HTMLCanvasElement.prototype.requestPointerLock = function () {
    window.__lock.requests++;
    const ok = rule === 'dispatch' ? !!during
      : rule === 'dispatch-nostart' ? !!during && !during.includes('btn-lobby-start')
      : rule === 'canvas-click' ? during === 'mousedown#game' // el canvas del juego
      : performance.now() - lastAct <= 5000;
    window.__lock.log.push({ during, ok });
    if (!ok) {
      setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);
      return Promise.reject(new DOMException('sin gesto', 'NotAllowedError'));
    }
    window.__lock.granted++;
    setTimeout(() => change(this), 5);
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function () {
    window.__lock.exits = (window.__lock.exits || 0) + 1;
    window.__lock.lastExit = new Error().stack.split('\n').slice(2, 6).join(' | ');
    if (el) setTimeout(() => change(null), 0);
  };
  if (pad) {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    const gp = pad === 'drift'
      ? { id: 'Xbox Wireless Controller', index: 0, mapping: 'standard', connected: true, axes: [0.05, -0.42, 0.02, 0.03], buttons }
      : pad === 'centred'
        ? { id: 'Xbox Wireless Controller', index: 0, mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons }
        : { id: 'Generic USB HID', index: 0, mapping: '', connected: true, axes: [0, -1, 0, 0, 0, -1], buttons };
    window.__gp = gp;
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [gp] });
  }
}

// Reloj de juego: cada cuadro de rAF suma el mismo dt que main.js (acotado a
// 0.1 s) y anota en qué tiempo de juego cambia la fase de la partida y cuándo
// llega cada keydown de confianza.
function simClock() {
  window.__sim = 0; window.__frame = 0; window.__phaseAt = {}; window.__phaseFrame = {}; window.__keyAt = {}; window.__keyFrame = {};
  let lastT = null, lastPhase = null;
  const native = window.requestAnimationFrame.bind(window);
  const tick = (t) => {
    if (lastT !== null && t !== lastT) window.__sim += Math.max(0, Math.min(0.1, (t - lastT) / 1000));
    lastT = t; window.__frame++;
    const ph = window.BREACH?.botMatch?.phase ?? null;
    if (ph !== lastPhase) {
      lastPhase = ph;
      if (ph && !(ph in window.__phaseAt)) { window.__phaseAt[ph] = window.__sim; window.__phaseFrame[ph] = window.__frame; }
    }
    native(tick);
  };
  native(tick);
  window.addEventListener('keydown', (e) => {
    if (e.isTrusted && !e.repeat) { window.__keyAt[e.code] = window.__sim; window.__keyFrame[e.code] = window.__frame; }
  }, true);
}
const simNow = (page) => page.evaluate(() => window.__sim);
// espera a que pasen `secs` segundos de JUEGO
const waitSim = async (page, secs) => {
  const target = (await simNow(page)) + secs;
  await page.waitForFunction((t) => window.__sim >= t, target, { timeout: T, polling: 'raf' });
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let pageErrors = 0;
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(lockSim, { rule: opts.rule || 'gesture', pad: opts.pad || null });
  await ctx.addInitScript(simClock);
  const page = await ctx.newPage();
  page.setDefaultTimeout(T);
  if (THROTTLE > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  await page.goto(`${BASE}/?gfx=off`, { waitUntil: 'networkidle', timeout: T });
  await page.click('#btn-enter');
  await page.waitForSelector('#splash.off', { state: 'attached' });
  // vigía de avisos: todo lo que pase por la línea de pistas del HUD
  await page.evaluate(() => {
    window.__hints = [];
    const el = document.getElementById('context-hint');
    if (el) new MutationObserver(() => { const tx = el.textContent.trim(); if (tx) window.__hints.push(tx); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
  return { ctx, page };
}
const S = (page) => page.evaluate(() => {
  const G = window.BREACH, I = window.BREACH_INPUT;
  return { mode: G.mode, phase: G.botMatch?.phase ?? null, locked: I.locked, keys: [...I.keys],
    pos: G.player ? [G.player.pos.x, G.player.pos.z] : null, yaw: G.player?.cam.yaw ?? null,
    prompt: document.getElementById('lock-prompt')?.classList.contains('on'),
    skipCue: document.getElementById('skip-cue')?.classList.contains('on'), hints: window.__hints };
});
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
async function clickStart(page) {
  await page.click('#btn-bots');
  await page.waitForFunction(() => !document.getElementById('btn-lobby-start').disabled &&
    !document.getElementById('lobby-card').classList.contains('off'));
  const box = await page.locator('#btn-lobby-start').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return Date.now();
}
const waitPhase = (page, phase) =>
  page.waitForFunction((ph) => window.BREACH?.botMatch?.phase === ph && ph in window.__phaseAt, phase, { timeout: T, polling: 'raf' });
const waitLocked = (page) => page.waitForFunction(() => window.BREACH_INPUT.locked, null, { timeout: T, polling: 'raf' });
// pulsaciones de quien "no responde": solapadas, con auto-repeat y un click
async function mash(page, withClick = true) {
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 4; i++) { await wait(35); await page.keyboard.down('KeyW'); }
  await page.keyboard.down('KeyA'); await wait(70);
  await page.keyboard.up('KeyW'); await page.keyboard.down('KeyD'); await wait(50);
  if (withClick) await page.mouse.click(640, 420);
  await page.keyboard.up('KeyA'); await wait(60); await page.keyboard.up('KeyD');
}
async function restDrift(page, secs = 2) {
  const a = await S(page); await waitSim(page, secs); const b = await S(page);
  return { moved: +dist(a.pos, b.pos).toFixed(2), yaw: +(b.yaw - a.yaw).toFixed(3), keys: b.keys, locked: b.locked };
}

try {
  // --- A. flujo por defecto: captura en el click de START, presentación corta.
  //     Regla 'dispatch': ningún reintento fuera de un gesto se concede, así
  //     que si la captura se mudara del click de START esto falla.
  if (!ONLY || ONLY.includes('A')) {
    const { ctx, page } = await open({ rule: 'dispatch' });
    await clickStart(page);
    await waitPhase(page, 'intro');
    // la captura pedida en el gesto llega (async); la regla 'dispatch' no
    // concede reintentos, así que si llega, vino del click de START
    await page.waitForFunction(() => window.BREACH_INPUT.locked || window.__lock.log.length > 3, null, { timeout: T, polling: 'raf' });
    let s = await S(page);
    check('A: la captura se toma en el click de START (activa durante la presentación)', s.locked,
      JSON.stringify({ locked: s.locked, lock: await page.evaluate(() => window.__lock) }));
    const first = await page.evaluate(() => window.__lock.log[0]);
    check('A: la captura se pide DENTRO del click de START (en su propagación)',
      !!first?.ok && /^(click|mousedown|mouseup)#btn-lobby-start$/.test(first.during || ''), JSON.stringify(first));
    check('A: la presentación muestra cómo saltarla', s.skipCue === true);
    // mover el ratón durante la presentación no gira la cámara del jugador
    const yaw0 = s.yaw;
    for (let i = 0; i < 6; i++) await page.mouse.move(300 + i * 120, 360);
    await waitPhase(page, 'countdown');
    s = await S(page);
    check('A: el ratón en la presentación no gira la cámara escondida', Math.abs(s.yaw - yaw0) < 1e-3, `Δyaw=${(s.yaw - yaw0).toFixed(3)}`);
    await waitPhase(page, 'playing');
    const at = await page.evaluate(() => window.__phaseAt);
    const intro = at.countdown - at.intro, total = at.playing - at.intro;
    check('A: presentación 6 s + cuenta 3 s (tiempo de juego)', Math.abs(intro - 6) < 0.15 && Math.abs(total - 9) < 0.2,
      `intro=${intro.toFixed(2)} s, total=${total.toFixed(2)} s`);
    s = await S(page);
    check('A: al empezar se juega con el ratón capturado y sin aviso de captura', s.locked && !s.prompt);
    await waitSim(page, 3);
    s = await S(page);
    check('A: ningún aviso del eje Y del ratón al empezar', !s.hints.some((h) => /F9|Y AXIS|EJE Y/i.test(h)), JSON.stringify(s.hints));
    await ctx.close();
  }
  // --- B. saltar la presentación
  if (!ONLY || ONLY.includes('B')) {
    const { ctx, page } = await open();
    await clickStart(page);
    await waitPhase(page, 'intro');
    await waitSim(page, 0.6); // pasado el margen anti-rebote del gesto de START
    await page.keyboard.press('Space');
    await waitPhase(page, 'playing');
    const r = await page.evaluate(() => ({ key: window.__keyAt.Space, ...window.__phaseAt,
      frames: window.__phaseFrame.countdown - window.__keyFrame.Space }));
    const toPlay = r.playing - r.key;
    // en CUADROS: el cuadro siguiente al keydown aplica el salto y el vigía lo
    // anota en el otro (con cuadros largos 2 cuadros pueden ser 0.2 s de juego)
    check('B: una tecla salta la presentación al instante (≤ 3 cuadros)', r.frames >= 0 && r.frames <= 3, `${r.frames} cuadros`);
    check('B: con salto, tecla→jugando = cuenta de 3 s', Math.abs(toPlay - 3) < 0.2, `${toPlay.toFixed(2)} s`);
    await ctx.close();
  }
  // --- C. captura denegada en START: aviso claro y respuesta inmediata a la tecla
  if (!ONLY || ONLY.includes('C')) {
    const { ctx, page } = await open({ rule: 'dispatch-nostart' });
    await clickStart(page);
    await waitPhase(page, 'countdown');
    await waitSim(page, 0.3);
    let s = await S(page);
    check('C: sin captura, la cuenta regresiva muestra "clic para jugar"', !s.locked && s.prompt, JSON.stringify({ locked: s.locked, prompt: s.prompt }));
    await waitPhase(page, 'playing');
    await waitSim(page, 1.8); // el jugador aún no hizo nada
    const p0 = (await S(page)).pos;
    await page.keyboard.down('KeyW'); // mantenida, sin soltar
    // primer cuadro en que se desplazó > 0.3 m, en tiempo de juego desde el keydown
    const movedAfter = await page.evaluate(([x0, z0]) => new Promise((resolve) => {
      const k = window.__keyAt.KeyW;
      const look = () => {
        const p = window.BREACH.player.pos;
        if (Math.hypot(p.x - x0, p.z - z0) > 0.3) return resolve(window.__sim - k);
        if (window.__sim - k > 3) return resolve(null);
        requestAnimationFrame(look);
      };
      look();
    }), p0);
    await page.keyboard.up('KeyW');
    s = await S(page);
    const viaKey = await page.evaluate(() => window.__lock.log.some((l) => l.ok && /^keydown#/.test(l.during || '')));
    check('C: la captura se pide dentro del keydown (no por el reintento de 1.6 s)', viaKey);
    // 0.3 m andando desde parado ≈ 0.15-0.2 s de juego; antes (reintento cada 1.6 s) hasta ~1.8 s
    check('C: el personaje responde ≤ 0.4 s de juego tras la primera tecla', movedAfter !== null && movedAfter <= 0.4 && s.locked && !s.prompt,
      `${movedAfter === null ? 'no se movió' : movedAfter.toFixed(3) + ' s'}`);
    await ctx.close();
  }
  // --- D. el jugador "aporrea" teclas en cada ventana del arranque y luego suelta todo
  if (!ONLY || ONLY.includes('D')) {
    const { ctx, page } = await open({ rule: 'canvas' });
    await clickStart(page);
    await waitPhase(page, 'intro');
    await wait(800); await mash(page, false);             // presentación (la salta)
    await waitPhase(page, 'countdown'); await mash(page, false); // cuenta, sin captura
    await waitPhase(page, 'playing'); await mash(page, false);   // jugando, sin captura
    await mash(page, true);                               // click en medio: llega la captura
    // pérdida de foco con una tecla mantenida: su keyup llega con la pausa abierta
    await page.keyboard.down('KeyS');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.up('KeyS');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.keyboard.press('Escape'); // cerrar la pausa
    await waitSim(page, 0.15);
    await page.mouse.click(640, 420); await waitLocked(page);
    const r = await restDrift(page);
    check('D: tras aporrear y soltar, el personaje queda quieto', r.moved < 0.05 && !r.keys.length, JSON.stringify(r));
    await ctx.close();
  }
  // --- E. keyup perdido (macOS no emite keyup mientras Cmd está abajo)
  if (!ONLY || ONLY.includes('E')) {
    const { ctx, page } = await open({ rule: 'canvas' });
    await clickStart(page);
    await waitPhase(page, 'intro');
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'MetaLeft', key: 'Meta' })); // el keyup de W nunca llega
    });
    await waitPhase(page, 'playing');
    await page.mouse.click(640, 420); await waitLocked(page);
    const r = await restDrift(page);
    check('E: una tecla sin keyup no hace caminar solo al personaje', r.moved < 0.05 && r.locked, JSON.stringify(r));
    await ctx.close();
  }
  // --- F. control con stick gastado / dispositivo HID con eje clavado
  if (!ONLY || ONLY.includes('F')) for (const pad of ['drift', 'phantom']) {
    const { ctx, page } = await open({ pad });
    await clickStart(page);
    await page.keyboard.press('Space');
    await waitPhase(page, 'playing');
    const r = await restDrift(page);
    check(`F: pad ${pad} en reposo no mueve al personaje`, r.moved < 0.05, JSON.stringify(r));
    await ctx.close();
  }
  // --- I. jugar solo con el stick derecho cuenta como usar el control: sin
  //     "clic para jugar" aunque el ratón no esté capturado
  if (!ONLY || ONLY.includes('I')) {
    const { ctx, page } = await open({ rule: 'dispatch-nostart', pad: 'centred' });
    await clickStart(page);
    await page.keyboard.press('Space'); // salta la presentación (no da captura: regla)
    await waitPhase(page, 'playing');
    await waitSim(page, 0.3);
    const before = await S(page);
    await page.evaluate(() => { window.__gp.axes[2] = 0.8; });
    await waitSim(page, 0.5);
    const after = await page.evaluate(() => ({ dev: window.BREACH_INPUT.lastDevice,
      prompt: document.getElementById('lock-prompt').classList.contains('on'), yaw: window.BREACH.player.cam.yaw }));
    check('I: sin captura, con teclado/ratón se pide "clic para jugar"', before.prompt === true && !before.locked);
    check('I: girar solo con el stick derecho oculta el aviso y gira la cámara',
      after.dev === 'pad' && !after.prompt && Math.abs(after.yaw - before.yaw) > 0.05, JSON.stringify(after));
    await ctx.close();
  }
  // --- G. práctica: arranque inmediato, sin recordatorio del eje Y
  if (!ONLY || ONLY.includes('G')) {
    const { ctx, page } = await open();
    await page.click('#btn-practice');
    await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: T, polling: 'raf' });
    // sin presentación ni cuenta: el control es inmediato (estructural, no un cronómetro)
    const start = await page.evaluate(() => ({ bm: !!window.BREACH.botMatch,
      flow: document.getElementById('match-flow').classList.contains('on'), lockReq: window.__lock.log[0] || null }));
    await waitLocked(page);
    await waitSim(page, 4);
    const s = await S(page);
    check('G: práctica sin presentación, capturada desde el click', !start.bm && !start.flow && !!start.lockReq?.ok && s.locked, JSON.stringify(start));
    check('G: práctica sin aviso del eje Y', !s.hints.some((h) => /F9|Y AXIS|EJE Y/i.test(h)), JSON.stringify(s.hints));
    await ctx.close();
  }
  // --- H. Tabla de verdad del teclado ante una captura RETRASADA: las teclas
  //     se mantienen sin captura (la pulsación no la concede: 'canvas-click'),
  //     >1 s con auto-repeat solo de la última tecla (como un teclado real), y
  //     la captura llega con un click al canvas. Se mira el estado al llegar
  //     y 1 s después. Práctica: sin bots que interfieran.
  if (!ONLY || ONLY.includes('H')) {
    const { ctx, page } = await open({ rule: 'canvas-click' });
    await page.click('#btn-practice');
    await page.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: T, polling: 'raf' });
    await waitSim(page, 0.8);
    const unlock = async () => {
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => !window.BREACH_INPUT.locked, null, { timeout: T, polling: 'raf' });
    };
    const st = () => page.evaluate(() => {
      const G = window.BREACH, I = window.BREACH_INPUT, p = G.player;
      return { keys: [...I.keys].sort(), sprint: I.sprintHeld, pos: [p.pos.x, p.pos.z], y: p.y, vy: p.vy, state: p.state };
    });
    const synth = (list) => page.evaluate((list) => {
      for (const [type, code, meta] of list) window.dispatchEvent(new KeyboardEvent(type, { code, key: code, metaKey: !!meta }));
    }, list);
    // hold: teclas reales; repeatLast: solo la última repite; pre/post: extras
    async function row(name, { mac = false, hold = [], pre = null, between = null, expectKeys, moves, sprint, noJump }) {
      await unlock();
      await page.evaluate((m) => {
        window.BREACH_INPUT.macKeys = m;
        const W = window.BREACH_WORLD; window.BREACH.player.respawn(W.spawns.red[1]); // cada fila desde el spawn
      }, mac);
      if (pre) await pre();
      for (const k of hold) await page.keyboard.down(k);
      // 2.6 s sin captura: más que cualquier ventana de "frescura" de teclas
      for (let i = 0; i < 52; i++) { await wait(50); if (hold.length) await page.keyboard.down(hold.at(-1)); }
      if (between) await between();
      const before = await st();
      await page.mouse.click(640, 420); await waitLocked(page);
      const atLock = await st();
      // 1 s de JUEGO, con el auto-repeat de la última tecla (no debe disparar acciones)
      const until = (await simNow(page)) + 1;
      while ((await simNow(page)) < until) { await wait(50); if (hold.length) await page.keyboard.down(hold.at(-1)); }
      const later = await st();
      for (const k of [...hold].reverse()) await page.keyboard.up(k);
      await wait(250);
      const moved = dist(atLock.pos, later.pos);
      const ok = JSON.stringify(atLock.keys) === JSON.stringify([...expectKeys].sort()) &&
        (moves ? moved > 0.8 : moved < 0.05) && (sprint === undefined || atLock.sprint === sprint) &&
        (!noJump || (Math.abs(later.y - before.y) < 0.01 && Math.abs(atLock.y - before.y) < 0.01));
      check(`H: ${name}`, ok, JSON.stringify({ keysAtLock: atLock.keys, sprint: atLock.sprint, moved1s: +moved.toFixed(2), dy: +(later.y - before.y).toFixed(3) }));
    }
    await row('W sola mantenida → W activa al capturar, camina', { hold: ['KeyW'], expectKeys: ['KeyW'], moves: true });
    await row('Shift+W (Shift no repite) → corre al capturar', { hold: ['ShiftLeft', 'KeyW'], expectKeys: ['KeyW', 'ShiftLeft'], moves: true, sprint: true });
    await row('W+D (solo D repite) → ambas activas', { hold: ['KeyW', 'KeyD'], expectKeys: ['KeyD', 'KeyW'], moves: true });
    const { jump } = await actionKeys(page, 'jump');
    await row('Salto mantenido → retenido, SIN salto al capturar', { hold: [jump], expectKeys: [jump], moves: false, noJump: true });
    await row('pulsada y soltada antes de la captura → nada', {
      pre: async () => { await page.keyboard.down('KeyW'); await wait(200); await page.keyboard.up('KeyW'); }, expectKeys: [], moves: false });
    await row('macOS: Cmd+W (keyup de W nunca llega) → nada', { mac: true,
      pre: () => synth([['keydown', 'MetaLeft', 1], ['keydown', 'KeyW', 1], ['keyup', 'MetaLeft']]), expectKeys: [], moves: false });
    await row('macOS: W mantenida, Cmd, W soltada con Cmd abajo (keyup perdido) → nada', { mac: true,
      pre: () => synth([['keydown', 'KeyW'], ['keydown', 'MetaLeft', 1], ['keyup', 'MetaLeft']]), expectKeys: [], moves: false });
    await row('macOS: tras el acorde, un repeat de W la restaura sin acción', { mac: true,
      pre: () => synth([['keydown', 'KeyW'], ['keydown', 'MetaLeft', 1], ['keyup', 'MetaLeft']]),
      between: () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', repeat: true }))),
      expectKeys: ['KeyW'], moves: true });
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' })));
    await row('macOS: repeat de salto tras el acorde → retenido, SIN salto', { mac: true,
      pre: () => synth([['keydown', jump], ['keydown', 'MetaLeft', 1], ['keyup', 'MetaLeft']]),
      between: () => page.evaluate(code => window.dispatchEvent(new KeyboardEvent('keydown', { code, repeat: true })), jump),
      expectKeys: [jump], moves: false, noJump: true });
    await synth([['keyup', jump]]);
    await row('Windows/Linux: W mantenida, Win pulsada y soltada → W sigue', { mac: false, hold: ['KeyW'],
      between: () => synth([['keydown', 'MetaLeft', 1], ['keyup', 'MetaLeft']]), expectKeys: ['KeyW'], moves: true });
    await ctx.close();
  }
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser.close();
  server?.kill();
  await clearClip();
}

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nFLUJO REAL DEL RATÓN: todo verde');
process.exit(fails.length ? 1 : 0);
