// BOTS ALOJADOS EN FPS contra el servidor real (corrida 6). Mismo guion que
// check-hosted-bot-fire, pero el humano host se pone DELANTE de un bot (en su
// vista: un bot ya no ve a quien tiene detrás sin oírlo) y además se comprueba
// lo que el servidor DIFUNDE de cada bot: solo estados del contrato de
// postura FPS (idle, run, roadie, jump, crouch, melee, dead; nunca cover_*,
// blind_*, dive ni flip), y cero disparos honestos rechazados (cadencia,
// cambio de arma, munición y origen en el ojo).
//   node scripts/check-fps-bots-hosted.mjs [segundos=60]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
import { freePort } from './lib-test.mjs';
const port = await freePort(); // puerto libre (PRUEBAS: nada de puertos fijos)
const SECONDS = Number(process.argv[2]) || 60;
const CONTRACT = new Set(['idle', 'run', 'roadie', 'jump', 'slide', 'mantle', 'melee', 'dead', 'crouch']);
const botStates = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1',
    BREACH_LOG_FIRE_REJECTS: '1' },
  stdio: ['ignore', 'pipe', 'ignore'],
});
// motivo de cada botFire rechazado (diagnóstico del servidor en pruebas)
const rejectLog = [];
server.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.includes('[botFire rechazado]')) { console.log(l); rejectLog.push(JSON.parse(l.slice(l.indexOf('{')))); } });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const errors = [];
let fail = null, obs = null;
try {
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((r) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on('open', () => { w.close(); r(true); }); w.on('error', () => r(false)); });
    if (up) break;
    await wait(200);
  }
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&gfx=low`, { waitUntil: 'networkidle' });
  await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, 'fortaleza');
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.evaluate((p) => {
    document.getElementById('in-name').value = 'HOST';
    document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
  }, port);
  await page.evaluate(() => document.getElementById('btn-lobby-create').click());
  await page.waitForFunction(() => window.BREACH?.net?.connected && window.BREACH?.lobby?.hostId);
  // observador: otro jugador que solo escucha lo que difunde el servidor
  const relayed = {};
  obs = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => {
    obs.on('open', () => obs.send(JSON.stringify({ t: 'join', name: 'OBS', action: 'join', v: 0, hp: 2, fps: 1 })));
    obs.on('error', rej);
    obs.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { obs.send(JSON.stringify({ t: 'lobbyTeam', team: 'red' })); res(); }
      if (m.t === 'fire' && m.w !== 'melee') relayed[m.id] = (relayed[m.id] || 0) + 1;
      if (m.t === 'snap') for (const p of m.ps || []) if (p.bot) botStates[p.st] = (botStates[p.st] || 0) + 1;
      if (m.t === 'rocket' && m.id) relayed[m.id] = (relayed[m.id] || 0) + 1;
    });
  });
  // equipos parejos: host y observador son rojos, dos bots azules contra ellos
  for (const team of ['blue', 'blue']) { await page.evaluate((t) => window.BREACH.net.lobbyAddBot(t), team); await wait(300); }
  await page.waitForFunction(() => window.BREACH?.lobby?.bots?.length === 2, null, { timeout: 8000 }).catch(async (e) => {
    console.error(JSON.stringify(await page.evaluate(() => window.BREACH.lobby)).slice(0, 600)); throw e; });
  await page.evaluate(() => window.BREACH.net.lobbyStart());
  await page.waitForFunction(() => window.BREACH?.mode === 'online' && window.BREACH?.onlinePhase === 'playing' &&
    window.BREACH?.onlineBots?.bots?.length === 2, null, { timeout: 20000 }).catch(async (e) => {
    console.error(JSON.stringify(await page.evaluate(() => ({ mode: window.BREACH.mode, phase: window.BREACH.onlinePhase,
      bots: window.BREACH.onlineBots?.bots?.length, lobby: window.BREACH.lobby && { bots: window.BREACH.lobby.bots.length, players: window.BREACH.lobby.players.length, v: window.BREACH.lobby.validation } }))));
    throw e;
  });
  await page.evaluate(() => {
    const G = window.BREACH, M = G.onlineBots;
    const S = window.__hb = { sent: {}, reloads: 0, swaps: 0 };
    const bf = G.net.botFire.bind(G.net);
    G.net.botFire = (id, o, p, w, ...r) => { if (w !== 'melee') S.sent[id] = (S.sent[id] || 0) + 1; return bf(id, o, p, w, ...r); };
    const br = G.net.rocket.bind(G.net);
    G.net.rocket = (o, d, cid, pl, botId) => { if (botId) S.sent[botId] = (S.sent[botId] || 0) + 1; return br(o, d, cid, pl, botId); };
    for (const b of M.bots) {
      const sr = b._startReload.bind(b);
      b._startReload = () => { const was = b.reloadT; sr(); if (was <= 0 && b.reloadT > 0) S.reloads++; };
      const bs = b._beginSwap.bind(b);
      b._beginSwap = (w) => { S.swaps++; return bs(w); };
    }
    // cerca del centro: los humanos rojos (quietos en su spawn) son el blanco
    // cargadores casi vacíos al empezar: varias recargas en poco tiempo (el
    // servidor cree que les queda más; quedarse corto nunca es ilegal)
    for (const b of M.bots) { b.ammo.smg = 6; b.ammo.shotgun = 2; }
    M.bots.forEach((b, i) => { b.pos.x = (i - 0.5) * 3; b.pos.z = -9; b.y = 0; });
  });
  const t0 = Date.now();
  let forced = false;
  // duración mínima SECONDS; bajo carga (CI) los bots disparan menos: seguir
  // hasta cumplir el escenario, con tope de 3×SECONDS
  const enough = () => page.evaluate(() => { const S = window.__hb;
    return Object.values(S.sent).reduce((a, n) => a + n, 0) >= 30 && S.reloads >= 2 && S.swaps >= 1; });
  while (Date.now() - t0 < SECONDS * 1000 || (Date.now() - t0 < SECONDS * 3000 && !(await enough()))) {
    await wait(1000);
    // el humano host, al descubierto a ~14 m de los bots: blanco para que disparen
    await page.evaluate(() => { const G = window.BREACH, M = G.onlineBots, b = M.bots.find((x) => x.alive);
      if (!G.player || !b || !G.selfAlive) return;
      // delante del bot (en su vista), en un punto transitable a 10-16 m
      const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw), N = window.BREACH_WORLD.navigation;
      const dx = G.player.pos.x - b.pos.x, dz = G.player.pos.z - b.pos.z, d = Math.hypot(dx, dz);
      if (d > 22 || (dx * fx + dz * fz) / Math.max(0.01, d) < 0.6) {
        for (const r of [14, 12, 16, 10]) { const q = { x: b.pos.x + fx * r, z: b.pos.z + fz * r };
          if (!N || N.walkable(q)) { G.player.pos.x = q.x; G.player.pos.z = q.z; break; } }
      } });
    if (!forced && Date.now() - t0 > SECONDS * 500) {
      forced = true; // un cambio de arma a mitad de partida, seguro
      await page.evaluate(() => { const b = window.BREACH.onlineBots.bots.find((x) => x.alive); if (b) { b.swapCd = 0; b._trySwap(b.wep === 'smg' ? 'shotgun' : 'smg'); } });
    }
  }
  await wait(600);
  const host = await page.evaluate(() => window.__hb);
  const sent = Object.values(host.sent).reduce((a, n) => a + n, 0);
  const got = Object.keys(host.sent).reduce((a, id) => a + Math.min(relayed[id] || 0, host.sent[id]), 0);
  const bad = Object.keys(botStates).filter((k) => !CONTRACT.has(k));
  const res = { segundos: SECONDS, enviados: sent, difundidos: got, rechazados: sent - got, recargas: host.reloads, cambiosDeArma: host.swaps,
    estadosDifundidosDeBots: botStates, errores: errors.slice(0, 3) };
  console.log(JSON.stringify(res));
  if (sent < 30 || host.reloads < 2 || host.swaps < 1) fail = 'escenario insuficiente';
  else if (bad.length) fail = 'el servidor difunde estados de bot fuera del contrato FPS: ' + bad.join(',');
  // rechazos correctos según el servidor: el bot ya había muerto o la ronda terminó
  else if (sent - got - rejectLog.filter((x) => !x.alive || x.dazed || x.stunned || x.phase !== 'playing').length > 0) fail = `${sent - got} disparos de bot rechazados`;
  else if (errors.length) fail = 'errores de página';
} finally {
  obs?.close();
  await browser.close();
  server.kill();
}
if (fail) { console.error('FPS BOTS HOSTED FAIL — ' + fail); process.exit(1); }
console.log('FPS BOTS HOSTED OK · munición, recargas y cambio de arma sin un solo disparo rechazado');
