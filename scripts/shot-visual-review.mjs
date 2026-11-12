// REVISIÓN VISUAL: captura cada pantalla del juego (menús, lobby, HUD,
// presentaciones de partida, mapas, tamaños de ventana e idiomas) para
// inspección humana. No afirma nada: solo produce imágenes y avisa de
// desbordes de texto/errores de página que detecta por el camino.
//   node scripts/shot-visual-review.mjs [carpeta de salida]
// Sirve dist/: correr `npm run build` antes.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(root, 'artifacts', 'visual-review'));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8819;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, PORT: String(PORT), INTRO_TIME: '6', COUNTDOWN_TIME: '3', NODE_ENV: 'test' };
delete env.BREACH_FILL_BOTS;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
await wait(750);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const notes = [];
const note = (text) => { notes.push(text); console.log('NOTA:', text); };

async function open({ width = 1280, height = 720, lang = null, name = 'CHUCK' } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(([lang, name]) => {
    if (lang) localStorage.setItem('breach.language', lang);
    if (name) localStorage.setItem('breach.name', name);
  }, [lang, name]);
  const page = await context.newPage();
  page.on('pageerror', (e) => note(`error de página: ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  return page;
}
const enter = async (page) => {
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.waitForTimeout(350);
};
const click = (page, id) => page.evaluate((i) => document.getElementById(i).click(), id);
// Texto que se sale de su caja o elementos cortados por el borde de la ventana.
const overflow = (page, label) => page.evaluate((label) => {
  const out = [];
  const vw = innerWidth;
  for (const el of document.querySelectorAll('#menu .btn, #menu label, #menu h1, #menu .lobby-name, #menu select, #hud .hud-panel, #menu .menu-card, #lobby-card')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (r.right > vw + 1 || r.left < -1) out.push(`${label}: fuera de la ventana → ${el.id || el.className} (${Math.round(r.left)}..${Math.round(r.right)} de ${vw})`);
    if (el.scrollWidth > el.clientWidth + 2 && !['SELECT'].includes(el.tagName) && getComputedStyle(el).overflowX === 'visible' && el.children.length === 0)
      out.push(`${label}: texto desbordado → "${el.textContent.trim().slice(0, 40)}"`);
  }
  return out;
}, label);
const shot = async (page, name, { check = true } = {}) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  if (check) for (const line of await overflow(page, name)) note(line);
  console.log('captura', name);
};
const step = async (label, fn) => { try { await fn(); } catch (e) { note(`${label}: no se pudo capturar (${e.message.split('\n')[0]})`); } };
const calm = (page) => page.evaluate(() => new Promise((res) => {
  let last = performance.now(), ok = 0; const t0 = last;
  const f = (t) => { ok = t - last < 40 ? ok + 1 : 0; last = t; if (ok >= 30 || t - t0 > 7000) res(); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}));

// REVIEW_ONLY=scale: solo la escala de interfaz en cuatro resoluciones.
if (process.env.REVIEW_ONLY === 'scale') {
  try {
    for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
      const tag = `${height}p`;
      const s = await open({ width, height });
      await enter(s);
      await step(`menú ${tag}`, () => shot(s, `80-${tag}-menu`));
      await step(`lobby ${tag}`, async () => { await click(s, 'btn-bots'); await s.waitForTimeout(600); await shot(s, `81-${tag}-lobby`); });
      await step(`partida ${tag}`, async () => {
        await click(s, 'btn-lobby-start');
        await s.waitForFunction(() => window.BREACH?.mode === 'bots', null, { timeout: 40000 });
        await s.waitForTimeout(2500); await shot(s, `82-${tag}-intro`, { check: false });
        await s.waitForFunction(() => window.BREACH.botMatch?.phase === 'playing', null, { timeout: 40000 });
        await calm(s); await s.waitForTimeout(800);
        await s.evaluate(() => { const I = window.BREACH_INPUT; I._mouseAim = true; I.slotPressed = 1; });
        await s.waitForTimeout(300); await shot(s, `83-${tag}-hud`, { check: false });
        await s.evaluate(() => { const I = window.BREACH_INPUT; I._mouseAim = false; I.keys.add('Tab'); });
        await s.waitForTimeout(700); await shot(s, `84-${tag}-scoreboard`, { check: false });
      });
      await s.context().close();
      await wait(300);
    }
  } finally { await browser.close(); server.kill(); await clearClip(); }
  console.log(`\n${notes.length} notas · capturas en ${OUT}`);
  process.exit(0);
}

try {
  // ---------- MENÚS (1280×720, inglés) ----------
  const m = await open();
  await step('splash', async () => { await m.waitForTimeout(400); await shot(m, '01-splash', { check: false }); });
  await enter(m);
  await step('menú principal', () => shot(m, '02-main-menu'));
  await step('opciones', async () => { await click(m, 'btn-options'); await m.waitForTimeout(250); await shot(m, '03-options'); });
  for (const [id, name] of [['btn-opt-audio', '04-options-audio'], ['btn-opt-video', '05-options-video'], ['btn-opt-language', '06-options-language'], ['btn-opt-controls', '07-options-controls']]) {
    await step(name, async () => { await click(m, id); await m.waitForTimeout(300); await shot(m, name); await m.keyboard.press('Escape'); await m.waitForTimeout(200); });
  }
  await step('personaje', async () => {
    await m.keyboard.press('Escape'); await m.waitForTimeout(200);
    await click(m, 'btn-character'); await m.waitForTimeout(1500); await shot(m, '08-character');
    await click(m, 'btn-char-back'); await m.waitForTimeout(200);
  });
  await step('multijugador vacío', async () => {
    await m.evaluate((p) => { document.getElementById('in-server').value = `ws://127.0.0.1:${p}`; }, PORT);
    await click(m, 'btn-online');
    await m.waitForFunction(() => document.getElementById('online-status').dataset.state === 'empty', null, { timeout: 8000 });
    await shot(m, '09-online-empty');
  });
  await step('lobby online', async () => {
    await click(m, 'btn-lobby-create');
    await m.waitForFunction(() => !document.getElementById('lobby-card').classList.contains('off'), null, { timeout: 8000 });
    await m.waitForTimeout(400); await shot(m, '10-lobby-online');
  });
  // segundo cliente: sala abierta vista desde fuera
  const g = await open({ name: 'INVITADO' });
  await enter(g);
  await step('multijugador con sala', async () => {
    await g.evaluate((p) => { document.getElementById('in-server').value = `ws://127.0.0.1:${p}`; }, PORT);
    await click(g, 'btn-online');
    await g.waitForFunction(() => document.getElementById('online-status').dataset.state === 'lobby', null, { timeout: 8000 });
    await shot(g, '11-online-lobby-open');
  });
  await step('presentación online', async () => {
    await click(m, 'btn-lobby-start');
    await m.waitForFunction(() => window.BREACH?.mode === 'online', null, { timeout: 20000 });
    await m.waitForTimeout(2500); await shot(m, '12-match-intro', { check: false });
    await m.waitForFunction(() => window.BREACH.onlinePhase === 'countdown', null, { timeout: 15000 });
    await m.waitForTimeout(1200); await shot(m, '13-match-countdown', { check: false });
    await g.waitForFunction(() => document.getElementById('online-status').dataset.state === 'match', null, { timeout: 15000 });
    await shot(g, '14-online-match-running');
    await m.waitForFunction(() => window.BREACH.onlinePhase === 'playing', null, { timeout: 15000 });
    await m.waitForTimeout(1500); await shot(m, '15-online-hud', { check: false });
  });
  await g.context().close();
  await m.context().close();
  await wait(500);

  // ---------- HUD Y JUEGO (práctica) ----------
  for (const [map, tag] of [['fortaleza', '20'], ['azoteas', '30'], ['calle2', '40']]) {
    const p = await open();
    await p.addInitScript(() => {});
    await p.evaluate((map) => localStorage.setItem('breach.map', map), map);
    await p.reload({ waitUntil: 'networkidle' });
    await enter(p);
    await step(`práctica ${map}`, async () => {
      await click(p, 'btn-practice');
      await p.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: 25000 });
      await calm(p); await p.waitForTimeout(3600); // deja pasar el aviso del eje Y
      await shot(p, `${tag}-${map}-spawn`, { check: false });
      if (map !== 'fortaleza') return;
      await p.evaluate(() => { window.BREACH_INPUT._mouseAim = true; });
      await p.waitForTimeout(700); await shot(p, '21-hud-ads', { check: false });
      await p.evaluate(() => { const I = window.BREACH_INPUT; I._mouseFire = true; I.firePressed = true; });
      await p.waitForTimeout(450); await shot(p, '22-hud-firing', { check: false });
      await p.evaluate(() => { const I = window.BREACH_INPUT; I._mouseFire = false; I._mouseAim = false; I.reloadPressed = true; });
      await p.waitForTimeout(500); await shot(p, '23-hud-reload', { check: false });
      await p.evaluate(() => { window.BREACH_INPUT.slotPressed = 1; });
      await p.waitForTimeout(260); await shot(p, '24-hud-weapon-wheel', { check: false });
      await p.waitForTimeout(900);
      await p.evaluate(() => { window.BREACH.selfHp = 28; window.BREACH.weapons.st.mag = 2; });
      await p.waitForTimeout(300); await shot(p, '25-hud-low-hp-ammo', { check: false });
      await p.keyboard.press('Escape'); await p.waitForTimeout(500); await shot(p, '26-pause-menu');
    });
    await p.context().close();
    await wait(300);
  }

  // ---------- VS BOTS: lobby local, HUD, marcador, espectador, resultados ----------
  const b = await open();
  await enter(b);
  await step('lobby local', async () => { await click(b, 'btn-bots'); await b.waitForTimeout(600); await shot(b, '50-lobby-local'); });
  await step('partida vs bots', async () => {
    await click(b, 'btn-lobby-start');
    await b.waitForFunction(() => window.BREACH?.mode === 'bots' && window.BREACH.botMatch?.phase === 'playing', null, { timeout: 40000 });
    await calm(b); await b.waitForTimeout(1500); await shot(b, '51-bots-hud', { check: false });
    await b.evaluate(() => window.BREACH_INPUT.keys.add('Tab'));
    await b.waitForTimeout(400); await shot(b, '52-scoreboard', { check: false });
    await b.evaluate(() => window.BREACH_INPUT.keys.delete('Tab'));
    await b.evaluate(() => window.BREACH.botMatch.playerSelfDeath?.());
    await b.evaluate(() => { const G = window.BREACH; G.selfAlive = false; G.player.kill?.(); });
    await b.waitForTimeout(2600); await shot(b, '53-death-spectator', { check: false });
    await b.evaluate(() => { const bm = window.BREACH.botMatch; bm._holdRoundResult('red'); });
    await b.waitForTimeout(3200); await shot(b, '54-round-result', { check: false });
    await b.evaluate(() => { const bm = window.BREACH.botMatch; bm.wins.red = Math.floor(bm.roundLimit / 2); });
    await b.waitForFunction(() => window.BREACH.botMatch?.phase === 'playing', null, { timeout: 30000 });
    await b.evaluate(() => window.BREACH.botMatch._holdRoundResult('red'));
    await b.waitForTimeout(4200); await shot(b, '55-match-final', { check: false });
    await b.waitForTimeout(4200); await shot(b, '56-match-final-later', { check: false });
  });
  await b.context().close();

  // ---------- TAMAÑOS DE VENTANA ----------
  for (const [width, height, tag] of [[1920, 1080, 'fhd'], [1024, 640, 'laptop'], [820, 560, 'chico'], [430, 800, 'angosto']]) {
    const r = await open({ width, height });
    await enter(r);
    await step(`menú ${tag}`, () => shot(r, `60-main-${tag}`));
    await step(`lobby ${tag}`, async () => { await click(r, 'btn-bots'); await r.waitForTimeout(500); await shot(r, `61-lobby-${tag}`); await click(r, 'btn-lobby-leave'); await r.waitForTimeout(250); });
    await step(`multijugador ${tag}`, async () => {
      await r.evaluate((p) => { document.getElementById('in-server').value = `ws://127.0.0.1:${p}`; }, PORT);
      await click(r, 'btn-online'); await r.waitForTimeout(900); await shot(r, `62-online-${tag}`);
      await click(r, 'btn-online-back'); await r.waitForTimeout(200);
    });
    if (tag === 'fhd' || tag === 'chico') await step(`hud ${tag}`, async () => {
      await click(r, 'btn-practice');
      await r.waitForFunction(() => window.BREACH?.mode === 'practice', null, { timeout: 25000 });
      await calm(r); await r.waitForTimeout(3600); await shot(r, `63-hud-${tag}`, { check: false });
    });
    await r.context().close();
    await wait(300);
  }

  // ---------- IDIOMAS (textos largos y CJK) ----------
  for (const lang of ['es', 'fr', 'ja']) {
    const l = await open({ lang });
    await enter(l);
    await step(`menú ${lang}`, () => shot(l, `70-main-${lang}`));
    await step(`controles ${lang}`, async () => { await click(l, 'btn-options'); await click(l, 'btn-opt-controls'); await l.waitForTimeout(300); await shot(l, `71-controls-${lang}`); await l.keyboard.press('Escape'); await l.keyboard.press('Escape'); await l.waitForTimeout(250); });
    await step(`lobby ${lang}`, async () => { await click(l, 'btn-bots'); await l.waitForTimeout(500); await shot(l, `72-lobby-${lang}`); await click(l, 'btn-lobby-leave'); await l.waitForTimeout(250); });
    await step(`multijugador ${lang}`, async () => {
      await l.evaluate((p) => { document.getElementById('in-server').value = `ws://127.0.0.1:${p}`; }, PORT);
      await click(l, 'btn-online'); await l.waitForTimeout(900); await shot(l, `73-online-${lang}`);
    });
    await l.context().close();
    await wait(300);
  }
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}
fs.writeFileSync(path.join(OUT, 'notas.txt'), notes.join('\n') + '\n');
console.log(`\n${notes.length} notas automáticas · capturas en ${OUT}`);
