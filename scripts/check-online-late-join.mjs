// Entrada a partida empezada en un mapa que el cliente NO tiene cargado, con su
// red limitada por CDP. El anfitrión (A) y un rival (B) son sockets crudos;
// mientras el cliente baja modelos, A toma una caja y mata a B (soltando un
// arma); tras entrar, A toma la otra caja y vuelve a matar. Al final el
// cliente debe tener las mismas cajas, armas en el suelo y jugadores que A.
// Sirve dist/: correr `npm run build` antes.
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eyeAt } from './lib-test.mjs';
import { CHROME } from './lib-chrome.mjs';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';
import { freePort } from './lib-test.mjs';
import { withSamples } from './lib-fps-sample.mjs';
// PRUEBAS (ronda 2 de RED): cada fire/rocket/nade/protoFire humano lleva su muestra `fs`
// (n creciente, w = arma equipada) desde el último estado `s` de ese emisor
const SAMPLED = withSamples((peer, m) => peer.ws.send(JSON.stringify(m)));

// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = FREE_PORT, MAP = process.env.MAP || 'fortaleza', MBPS = Number(process.env.MBPS || 20);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), INTRO_TIME: '0', COUNTDOWN_TIME: '0', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
});
await delay(800);

function connect(name, action) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const peer = { ws, welcome: null, messages: [], crates: {}, drops: new Set(), lastSnap: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', action, name, v: 0, hp: 2, fps: 1 })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome' && !peer.welcome) { peer.welcome = m; resolve(peer); }
      if (m.t === 'crate') peer.crates[m.i] = !!m.up;
      if (m.t === 'dropA') peer.drops.add(m.id);
      if (m.t === 'dropR') peer.drops.delete(m.id);
      if (m.t === 'snap') peer.lastSnap = m;
      peer.messages.push(m);
    });
  });
}
const send = (p, m) => SAMPLED(p, m);
const waitFor = async (p, pred, ms = 4000) => { const t = Date.now(); for (;;) { const m = p.messages.find(pred); if (m) return m; if (Date.now() - t > ms) throw new Error('timeout ' + pred); await delay(25); } };
const killB = async (a, b, bx, bz) => {
  send(b, { t: 's', x: bx, z: bz, y: 0, yaw: 0, st: 'idle', w: 'smg', am: 49, ar: 150 });
  send(a, { t: 's', x: bx, z: bz - 1.5, y: 0, yaw: Math.PI, st: 'idle', w: 'shotgun', am: 8, ar: 24 });
  await delay(700);
  const before = a.messages.length;
  send(a, { t: 'fire', w: 'shotgun', o: eyeAt(bx, 0, bz - 1.5, Math.PI), p: [bx, 1.1, bz], d: [] });
  send(a, { t: 'hit', target: b.welcome.id, dmg: 1, part: 'body', gib: 0, pellets: 8, p: [bx, 1.0, bz] });
  return waitFor(a, (m) => m.t === 'dropA' && a.messages.indexOf(m) >= before, 3000);
};
const takeCrate = async (a, i) => {
  const c = MAP_RUNTIME[MAP].crates[i];
  send(a, { t: 's', x: c.x, z: c.z, y: 0, yaw: 0, st: 'idle', w: 'smg', am: 1, ar: 0, sp: 0 });
  await delay(150);
  send(a, { t: 'crate', i });
  await waitFor(a, (m) => m.t === 'crate' && m.i === i && !m.up, 3000);
};

const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails.push(name); };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const a = await connect('HOST', 'create');
  send(a, { t: 'lobbySettings', settings: { map: MAP } });
  const b = await connect('RIVAL', 'join');
  await delay(300);
  send(a, { t: 'lobbyStart' });
  await waitFor(a, (m) => m.t === 'start', 6000);
  await delay(5300); // escudo de aparición

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=low`, { waitUntil: 'networkidle' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 30, downloadThroughput: MBPS * 125000, uploadThroughput: 2500000 });
  await page.evaluate(() => document.getElementById('btn-enter').click());
  await page.waitForSelector('#splash.off', { state: 'attached', timeout: 60000 });
  const before = await page.evaluate((m) => ({ cached: window.BREACH_ASSETS().cached }), MAP);
  check('el cliente no tiene el mapa al empezar', !before.cached.includes('fortress-kit'), before.cached.join(','));
  await page.evaluate((p) => {
    document.getElementById('btn-online').click();
    document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
    const n = document.getElementById('in-online-name'); n.value = 'LATE'; n.dispatchEvent(new Event('input', { bubbles: true }));
  }, PORT);
  await page.waitForFunction(() => { const b = document.getElementById('btn-lobby-join'); return b && !b.disabled && b.offsetParent; }, null, { timeout: 15000 });
  await page.evaluate(() => document.getElementById('btn-lobby-join').click());
  const t0 = Date.now();
  // mientras baja modelos: caja 0 abajo y un arma en el suelo
  await takeCrate(a, 0);
  await killB(a, b, 3, -2);
  const loading = await page.evaluate(() => ({ mode: window.BREACH.mode, loading: document.body.classList.contains('map-loading') }));
  check('mientras carga aún no entra a la partida', loading.mode !== 'online', JSON.stringify(loading));
  page.on('console', (m) => { if (m.type() !== 'debug') console.log('  consola:', m.text().slice(0, 160)); });
  await page.waitForFunction(() => window.BREACH.mode === 'online' && window.BREACH.crates && window.BREACH.drops, null, { timeout: 60000 }).catch(async (e) => {
    console.log(await page.evaluate(() => ({ mode: window.BREACH.mode, status: document.getElementById('net-status')?.textContent, lobby: !!window.BREACH.lobby, assets: window.BREACH_ASSETS() })));
    throw e; });
  const joinMs = Date.now() - t0;
  const st = await page.evaluate(() => window.BREACH_ASSETS());
  check('entró con el mapa cargado', st.cached.includes('fortress-kit') && !st.failed.length, `${joinMs} ms`);
  // ya dentro: caja 1 y una segunda muerte (si B ya reapareció)
  await delay(300);
  await takeCrate(a, 1);
  await waitFor(b, (m) => m.t === 'respawn' && m.id === b.welcome.id, 12000).catch(() => null);
  await delay(5300);
  await killB(a, b, 3, -2).catch(() => null);
  await delay(600);
  const host = { crates: MAP_RUNTIME[MAP].crates.map((_, i) => a.crates[i] ?? true), drops: [...a.drops].sort(),
    roster: (a.lastSnap?.ps ?? []).map((p) => p.id).filter((id) => id !== a.lastSnap?.you).sort() };
  const late = await page.evaluate(() => { const G = window.BREACH; return {
    id: G.net.id, crates: G.crates.crates.map((c) => c.up), drops: [...G.drops.drops.keys()].sort(),
    remotes: [...G.remotes.keys()].sort(), visible: [...G.remotes.values()].filter((r) => r.rig?.root?.visible !== false).length,
    meshes: (() => { let n = 0; window.BREACH_WORLD.mapGroup.traverse((o) => { if (o.isMesh) n++; }); return n; })() }; });
  const hostRoster = host.roster.filter((id) => id !== late.id);
  const mine = (a.lastSnap?.ps ?? []).map((p) => p.id);
  check('mismas cajas que el anfitrión', JSON.stringify(late.crates) === JSON.stringify(host.crates), `${JSON.stringify(late.crates)} vs ${JSON.stringify(host.crates)}`);
  check('mismas armas en el suelo', JSON.stringify(late.drops) === JSON.stringify(host.drops), `${late.drops} vs ${host.drops}`);
  const expect = mine.filter((id) => id !== late.id).sort();
  check('mismos jugadores', JSON.stringify(late.remotes) === JSON.stringify(expect) && late.visible === late.remotes.length, `${late.remotes} vs ${expect} (visibles ${late.visible})`);
  // mapGroup con los tres GLB cargados: de 229 se restan seis dinteles
  // fundidos en la piedra y se suman dos revestimientos que no proyectan sombra.
  // Los doce apoyos usan el lote de vigas existente.
  check('mallas de Fortaleza completas', late.meshes === 226, String(late.meshes));
  check('sin errores de página', errs.length === 0, errs.join(' | '));
  await ctx.close();
} catch (e) { fails.push(e.message); console.log('FAIL', e.message); }
finally { await browser.close(); server.kill(); }
console.log(fails.length ? `LATE JOIN: ${fails.length} fallos` : 'LATE JOIN OK');
process.exit(fails.length ? 1 : 0);
