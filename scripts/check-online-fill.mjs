// RELLENO CON BOTS + ENTRAR/SALIR CON LA PARTIDA EMPEZADA (online):
//  - el lobby se completa solo con bots (ajuste "Bots", sin botones uno a uno)
//  - quien entra a una partida empezada releva a un bot y todos reciben aviso
//  - quien se va deja un bot en su lugar; si se va el anfitrión, otro hereda
//    la simulación de los bots
// Sirve dist/: correr `npm run build` antes (npm test ya lo hace).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8815;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, PORT: String(PORT), INTRO_TIME: '1', COUNTDOWN_TIME: '0.5', NODE_ENV: 'test' };
delete env.BREACH_FILL_BOTS; // esta suite prueba el valor por defecto (relleno activo)
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
await wait(750);

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const status = async () => (await fetch(`http://127.0.0.1:${PORT}/status`)).json();
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  let last = await fn();
  while (!last.ok && Date.now() - t0 < ms) { await wait(200); last = await fn(); }
  return last;
};
const statusWhen = (test) => until(async () => { const s = await status(); return { ok: test(s), s }; });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let pageErrors = 0;
async function client(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(([p, n]) => {
    document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
    document.getElementById('btn-online').click();
    const el = document.getElementById('in-online-name');
    el.value = n; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [PORT, name]);
  return page;
}
const lobbyShown = (page) => page.waitForFunction(() =>
  !document.getElementById('lobby-card').classList.contains('off'), null, { timeout: 8000 });
const roster = (page) => page.evaluate(() => {
  const G = window.BREACH;
  return {
    mode: G.mode, phase: G.onlinePhase, host: G.lobby?.hostId === G.net?.id,
    hosted: G.onlineBots?.bots.map((b) => b.id) ?? [],
    remotes: [...G.remotes.values()].map((r) => ({ id: r.id, bot: !!r.bot })),
    rows: G.onlineRows.length,
    hint: document.getElementById('context-hint').textContent,
  };
});

try {
  // --- LOBBY: el relleno completa 4v4 sin tocar nada
  const a = await client('ANA');
  await a.waitForFunction(() => document.getElementById('online-status').dataset.state === 'empty', null, { timeout: 8000 });
  await a.evaluate(() => document.getElementById('btn-lobby-create').click());
  await lobbyShown(a);
  const s1 = await status();
  check('lobby recién creado: 1 humano + 7 bots (4v4 completo)',
    s1.players === 1 && s1.bots === 7 && s1.fillBots === true, JSON.stringify(s1));
  const ui1 = await a.evaluate(() => ({
    addButtons: document.querySelectorAll('#lobby-card [data-action="add"], #lobby-card [data-action="remove"], #lobby-card [data-action="move"]').length,
    fill: document.querySelector('#lobby-card [data-setting="fillBots"]')?.value ?? null,
    startDisabled: document.getElementById('btn-lobby-start').disabled,
    slots: document.querySelectorAll('#lobby-card .lobby-slot:not(.empty)').length,
  }));
  check('lobby online: sin botones de bot uno por uno; ajuste "Bots" presente y listo para iniciar',
    ui1.addButtons === 0 && ui1.fill === 'on' && !ui1.startDisabled && ui1.slots === 8, JSON.stringify(ui1));

  const setFill = (value) => a.evaluate((v) => {
    const sel = document.querySelector('#lobby-card [data-setting="fillBots"]');
    sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await setFill('off');
  const sOff = await statusWhen((s) => s.bots === 0);
  check('"Sin bots" retira todos los bots', sOff.ok && sOff.s.fillBots === false, JSON.stringify(sOff.s));
  await setFill('on');
  const sOn = await statusWhen((s) => s.bots === 7);
  check('"Rellenar" vuelve a completar los equipos', sOn.ok && sOn.s.fillBots === true, JSON.stringify(sOn.s));

  // --- un segundo humano toma el lugar de un bot ya en el lobby
  const b = await client('BETO');
  await b.waitForFunction(() => document.getElementById('online-status').dataset.state === 'lobby', null, { timeout: 8000 });
  await b.evaluate(() => document.getElementById('btn-lobby-join').click());
  await lobbyShown(b);
  const s2 = await status();
  check('lobby: el humano que entra desplaza a un bot (sigue 4v4)',
    s2.players === 2 && s2.bots === 6 && s2.slots === 8, JSON.stringify(s2));

  // C carga y mira la sala ANTES de que empiece la partida (headless: cargar
  // una tercera escena con dos partidas corriendo es demasiado lento)
  const c = await client('CARLA');
  await c.waitForFunction(() => document.getElementById('online-status').dataset.state === 'lobby', null, { timeout: 8000 });

  // --- PARTIDA EMPEZADA
  await a.evaluate(() => document.getElementById('btn-lobby-start').click());
  for (const page of [a, b]) await page.waitForFunction(() =>
    window.BREACH?.mode === 'online' && window.BREACH?.onlinePhase === 'playing', null, { timeout: 20000 });
  const a1 = await roster(a), b1 = await roster(b);
  check('anfitrión simula los 6 bots; el invitado los ve como remotos',
    a1.host && a1.hosted.length === 6 && b1.remotes.filter((r) => r.bot).length === 6 && a1.rows === 8 && b1.rows === 8,
    JSON.stringify({ a: { hosted: a1.hosted.length, rows: a1.rows }, b: { bots: b1.remotes.filter((r) => r.bot).length, rows: b1.rows } }));

  await c.waitForFunction(() => {
    const box = document.getElementById('online-status');
    return box.dataset.state === 'match' && !document.getElementById('btn-lobby-join').disabled;
  }, null, { timeout: 20000 });
  check('pantalla de entrada: partida en curso CON opción de entrar',
    await c.evaluate(() => document.getElementById('online-status').dataset.joinable === '1'));
  await c.evaluate(() => document.getElementById('btn-lobby-join').click());
  await c.waitForFunction(() => window.BREACH?.mode === 'online' && window.BREACH?.onlinePhase === 'playing',
    null, { timeout: 25000 });
  const s3 = await status();
  check('entrar con la partida empezada: releva a un bot (3 humanos + 5 bots)',
    s3.state === 'match' && s3.players === 3 && s3.bots === 5 && s3.slots === 8, JSON.stringify(s3));
  await a.waitForFunction(() => window.BREACH.onlineBots?.bots.length === 5, null, { timeout: 8000 });
  await b.waitForFunction(() => [...window.BREACH.remotes.values()].filter((r) => !r.bot).length === 2, null, { timeout: 8000 });
  const a2 = await roster(a), b2 = await roster(b), c2 = await roster(c);
  check('todos reciben el aviso de quién entró y a qué bot releva',
    /CARLA/.test(a2.hint) && /CARLA/.test(b2.hint) && a2.hint.length > 'CARLA'.length + 8, `"${a2.hint}"`);
  check('el roster queda consistente en los tres clientes (8 lugares)',
    a2.hosted.length === 5 && a2.rows === 8 && b2.rows === 8 && c2.rows === 8 &&
    b2.remotes.length === 7 && c2.remotes.length === 7 && a2.remotes.filter((r) => !r.bot).length === 2,
    JSON.stringify({ a: [a2.hosted.length, a2.remotes.length, a2.rows], b: [b2.remotes.length, b2.rows], c: [c2.remotes.length, c2.rows] }));
  check('quien entra recibe la partida en su fase real (jugando, no en intro)', c2.phase === 'playing' && c2.mode === 'online');

  // --- alguien se va: un bot toma su lugar
  await c.context().close();
  const s4 = await statusWhen((s) => s.players === 2);
  check('salir con la partida empezada: un bot toma el lugar (2 humanos + 6 bots)',
    s4.ok && s4.s.bots === 6 && s4.s.slots === 8 && s4.s.state === 'match', JSON.stringify(s4.s));
  await a.waitForFunction(() => window.BREACH.onlineBots?.bots.length === 6, null, { timeout: 8000 });
  await b.waitForFunction(() => window.BREACH.remotes.size === 7, null, { timeout: 8000 });
  const a3 = await roster(a), b3 = await roster(b);
  check('todos reciben el aviso de quién salió y qué bot lo cubre',
    /CARLA/.test(a3.hint) && /CARLA/.test(b3.hint) && a3.rows === 8 && b3.rows === 8, `"${a3.hint}"`);

  // --- se va el ANFITRIÓN: el invitado hereda la sala y la simulación de bots
  await a.context().close();
  const s5 = await statusWhen((s) => s.players === 1);
  check('se va el anfitrión: la sala sigue, con BETO de anfitrión y 7 bots',
    s5.ok && s5.s.host === 'BETO' && s5.s.bots === 7 && s5.s.state === 'match', JSON.stringify(s5.s));
  await b.waitForFunction(() => window.BREACH.onlineBots?.bots.length === 7, null, { timeout: 8000 });
  const b4 = await roster(b);
  check('el nuevo anfitrión simula a los 7 bots (ninguno queda como remoto huérfano)',
    b4.host && b4.hosted.length === 7 && b4.remotes.length === 0 && b4.rows === 8, JSON.stringify(b4));

  await b.context().close();
  const s6 = await statusWhen((s) => s.state === 'empty');
  check('al salir todos el server queda libre y sin bots', s6.ok && s6.s.bots === 0, JSON.stringify(s6.s));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nRELLENO Y RELEVOS: todo verde');
process.exit(fails.length ? 1 : 0);
