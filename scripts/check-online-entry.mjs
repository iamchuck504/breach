// ENTRADA AL MULTIJUGADOR: la pantalla dedicada pide el nombre, muestra el
// estado real de la sala ANTES de conectar (nadie / sala abierta con quién /
// partida en curso) y ofrece una sola acción acorde. El server expone ese
// estado en /status y nunca deja dos jugadores con el mismo nombre.
// Sirve dist/: correr `npm run build` antes (npm test ya lo hace).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8814;
const SHOT_DIR = process.env.SHOT_DIR || '';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), INTRO_TIME: '4', COUNTDOWN_TIME: '1', NODE_ENV: 'test' },
  stdio: 'ignore',
});
await wait(750);

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const status = async () => (await fetch(`http://127.0.0.1:${PORT}/status`)).json();

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let pageErrors = 0;
async function client() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  // el build normal apunta a :8787 (LAN); el build same-origin lo cubre
  // check-public-server. Aquí se fija el server de esta prueba.
  await page.evaluate((p) => { document.getElementById('in-server').value = `ws://127.0.0.1:${p}`; }, PORT);
  return page;
}
const openCard = (page) => page.evaluate(() => document.getElementById('btn-online').click());
const waitState = (page, state) => page.waitForFunction((s) =>
  document.getElementById('online-status').dataset.state === s, state, { timeout: 8000 });
const typeName = (page, name) => page.evaluate((n) => {
  const el = document.getElementById('in-online-name');
  el.value = n; el.dispatchEvent(new Event('input', { bubbles: true }));
}, name);
const view = (page) => page.evaluate(() => {
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
  return {
    card: shown('online-card'), main: shown('main-card'),
    lobby: !document.getElementById('lobby-card').classList.contains('off'),
    state: document.getElementById('online-status').dataset.state,
    title: document.getElementById('online-state').textContent,
    count: document.getElementById('online-count').textContent,
    roster: [...document.querySelectorAll('#online-roster li')].map((li) => li.textContent),
    create: shown('btn-lobby-create'), join: shown('btn-lobby-join'),
    joinDisabled: document.getElementById('btn-lobby-join').disabled,
    msg: document.getElementById('online-msg').textContent,
    name: document.getElementById('in-online-name').value,
    server: document.getElementById('in-server').value,
  };
});
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};

try {
  const head = await fetch(`http://127.0.0.1:${PORT}/status`);
  const first = await head.json();
  check('/status: server vacío, con CORS abierto',
    first.state === 'empty' && first.players === 0 && first.maxPlayers === 8 &&
    head.headers.get('access-control-allow-origin') === '*', JSON.stringify(first));

  // --- A: nadie en el server → la única acción es CREAR
  const a = await client();
  await openCard(a);
  await waitState(a, 'empty');
  const a0 = await view(a);
  check('MULTIJUGADOR abre su propia pantalla (menú principal oculto)', a0.card && !a0.main);
  check('sin nombre por defecto', a0.name === '', `name="${a0.name}"`);
  check('server vacío: solo se ofrece CREAR', a0.create && !a0.join, JSON.stringify(a0));
  await shot(a, 'online-empty');

  await a.evaluate(() => document.getElementById('btn-lobby-create').click());
  await a.waitForTimeout(500);
  const a1 = await view(a);
  check('sin nombre NO se conecta y se pide el nombre',
    a1.card && !a1.lobby && a1.msg.length > 0 && (await status()).state === 'empty', JSON.stringify(a1));

  await typeName(a, 'ana');
  await a.evaluate(() => document.getElementById('btn-lobby-create').click());
  await a.waitForFunction(() => !document.getElementById('lobby-card').classList.contains('off'), null, { timeout: 8000 });
  const a2 = await view(a);
  check('con nombre: crea la sala y entra al lobby', a2.lobby && !a2.card);
  const s1 = await status();
  check('/status: sala abierta con su anfitrión',
    s1.state === 'lobby' && s1.players === 1 && s1.host === 'ANA' && s1.names[0] === 'ANA', JSON.stringify(s1));

  // --- B: hay sala abierta → ve quién está y la única acción es UNIRSE
  const b = await client();
  await openCard(b);
  await waitState(b, 'lobby');
  const b0 = await view(b);
  check('sala abierta: se ve quién está y cuántos lugares hay',
    b0.roster.includes('ANA') && b0.count === `${s1.players} / 8`, JSON.stringify(b0));
  check('sala abierta: solo se ofrece UNIRSE', b0.join && !b0.joinDisabled && !b0.create);
  await shot(b, 'online-lobby');
  await typeName(b, 'Ana');
  await b.evaluate(() => document.getElementById('btn-lobby-join').click());
  await b.waitForFunction(() => !document.getElementById('lobby-card').classList.contains('off'), null, { timeout: 8000 });
  const s2 = await status();
  check('nombre repetido: el server lo distingue con sufijo',
    s2.players === 2 && s2.names.includes('ANA') && s2.names.includes('ANA 2'), JSON.stringify(s2.names));
  check('el nombre queda guardado para la próxima vez',
    await b.evaluate(() => localStorage.getItem('breach.name')) === 'ANA');

  // --- el anfitrión inicia → C, que miraba la sala, ve el cambio EN VIVO a
  //     partida en curso; sin relleno quedan lugares libres y puede entrar
  const c = await client();
  await openCard(c);
  await waitState(c, 'lobby');
  await a.waitForFunction(() => {
    const button = document.getElementById('btn-lobby-start');
    return button && !button.disabled;
  }, null, { timeout: 10000 });
  await a.evaluate(() => document.getElementById('btn-lobby-start').click());
  await a.waitForFunction(() => window.BREACH?.mode === 'online', null, { timeout: 10000 });
  await c.waitForFunction(() => document.getElementById('online-status').dataset.state === 'match',
    null, { timeout: 20000 });
  const c0 = await view(c);
  check('partida en curso: se actualiza sola y ofrece entrar si hay lugar',
    c0.join && !c0.joinDisabled && !c0.create && c0.roster.length === 2, JSON.stringify(c0));
  await shot(c, 'online-match');

  // --- volver al menú detiene el sondeo y restaura el menú principal
  await c.evaluate(() => document.getElementById('btn-online-back').click());
  const c1 = await view(c);
  check('VOLVER regresa al menú principal', !c1.card && c1.main);

  // --- al salir todos, el server vuelve a quedar libre
  await a.context().close(); await b.context().close();
  let s3 = await status();
  for (let i = 0; i < 20 && s3.state !== 'empty'; i++) { await wait(250); s3 = await status(); }
  check('/status: al salir todos el server queda libre', s3.state === 'empty' && s3.players === 0, JSON.stringify(s3));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nENTRADA ONLINE: todo verde');
process.exit(fails.length ? 1 : 0);
