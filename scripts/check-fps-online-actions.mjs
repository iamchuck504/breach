// EN LÍNEA DE PUNTA A PUNTA (FPS): dos navegadores en una partida contra un
// servidor local. B observa a A agacharse, inclinarse, deslizar, trepar,
// recargar, cancelar una recarga, cambiar de arma, lanzar y golpear, en el
// rig remoto Y en el volumen impactable; un cartucho de escopeta a 6 m con
// cada perdigón marcado en local acreditado por el servidor; un lanzamiento
// rechazado por el servidor devuelve el bote. Esperas en tiempo de juego o
// cuadros; puertos libres. Página desde el servidor de desarrollo
// (with-dev-server: BASE, por defecto 127.0.0.1:5200).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { actionKeys, freePort, waitHttp, waitFrames, untilGame, waitGame } from './lib-test.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:5200';
const PORT = await freePort();
const env = { ...process.env, PORT: String(PORT), INTRO_TIME: '1', COUNTDOWN_TIME: '0.5', NODE_ENV: 'test',
  BREACH_FILL_BOTS: '0', ALLOW_TEST_TELEPORTS: '1' };
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
await waitHttp(`http://127.0.0.1:${PORT}/status`);

const fails = [];
const check = (n, ok, x = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!ok) fails.push(n); };
let browser, errors = 0;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const client = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors++; console.log(name, 'PAGEERROR:', e.message); });
    page.setDefaultTimeout(600000);
    await page.goto(`${BASE}/?nolock=1&gfx=off`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { localStorage.setItem('breach.map', 'fortaleza'); document.getElementById('btn-enter')?.click(); });
    await page.waitForSelector('#splash.off', { state: 'attached' });
    await page.evaluate(([p, n]) => {
      document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
      document.getElementById('btn-online').click();
      const el = document.getElementById('in-online-name'); el.value = n; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [PORT, name]);
    return page;
  };
  const a = await client('ANA');
  await a.waitForFunction(() => document.getElementById('online-status').dataset.state === 'empty');
  await a.evaluate(() => document.getElementById('btn-lobby-create').click());
  await a.waitForFunction(() => window.BREACH?.lobby?.hostId && !document.getElementById('lobby-card').classList.contains('off'));
  const b = await client('BETO');
  await b.waitForFunction(() => document.getElementById('online-status').dataset.state === 'lobby');
  await b.evaluate(() => document.getElementById('btn-lobby-join').click());
  await a.waitForFunction(() => (window.BREACH.lobby?.players || []).filter((p) => !p.bot).length >= 2 && !document.getElementById('btn-lobby-start').disabled);
  await a.evaluate(() => document.getElementById('btn-lobby-start').click());
  for (const p of [a, b]) await p.waitForFunction(() => window.BREACH?.mode === 'online' && window.BREACH?.onlinePhase === 'playing' && window.BREACH.player);
  const idA = await a.evaluate(() => window.BREACH.net.id), idB = await b.evaluate(() => window.BREACH.net.id);
  check('dos clientes FPS en partida', await a.evaluate(() => window.BREACH.net.fps === true) && await b.evaluate(() => window.BREACH.net.fps === true));

  // a un claro con línea de vista, a 6 m, por la navegación (≤ 7 m/s)
  const spot = await a.evaluate(() => {
    const W = window.BREACH_WORLD, V = window.THREE;
    const free = (x, z) => { const q = { x, z }; W.resolveCircle(q, 0.38, 0); return Math.hypot(q.x - x, q.z - z) < 0.01 && W.groundHeight(q, 0.38, 0) < 0.05; };
    for (let d = 0; d < 20; d += 0.5) for (const x of [d, -d]) {
      if (!free(x, -3) || !free(x, 3)) continue;
      if (W.raycast(new V.Vector3(x, 1.4, -3), new V.Vector3(0, 0, 1), 6, 0) === null) return { x, za: -3, zb: 3 };
    }
    return null;
  });
  check('claro con línea de vista', !!spot, JSON.stringify(spot));
  const glide = (page, tx, tz) => page.evaluate(async ([tx, tz]) => {
    const p = window.BREACH.player, nav = window.BREACH_WORLD.navigation;
    const route = (nav?.path({ x: p.pos.x, z: p.pos.z }, { x: tx, z: tz }, p.y) || []).map((q) => ({ x: q.x, z: q.z }));
    route.push({ x: tx, z: tz });
    for (const wp of route) for (let i = 0; i < 3000; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const dx = wp.x - p.pos.x, dz = wp.z - p.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.08) break;
      const step = Math.min(d, 6 / 60);
      p.pos.x += dx / d * step; p.pos.z += dz / d * step; p.vel.x = p.vel.z = 0;
    }
  }, [tx, tz]);
  await Promise.all([glide(a, spot.x, spot.za), glide(b, spot.x, spot.zb)]);
  await a.evaluate(() => { const p = window.BREACH.player; p.cam.yaw = p.yaw = Math.PI; p.cam.pitch = 0; });
  await b.evaluate(() => { const p = window.BREACH.player; p.cam.yaw = p.yaw = 0; p.cam.pitch = 0; });
  await waitGame(a, 0.5); await waitGame(b, 0.3);

  // lo que B ve de A: estado del rig remoto y volumen impactable
  const seen = () => b.evaluate(async (id) => {
    const HP = await import('/src/combat/hit-pose.js');
    const r = window.BREACH.remotes.get(id); if (!r) return null;
    const vol = HP.hitPose(r.hitPoseInput());
    return { st: r.st, cl: +(r.coverLean ?? 0).toFixed(2), ce: +(r.coverExposure ?? 1).toFixed(2), reloading: !!r.reloading, w: r._lastW,
      headY: +vol.h[2].toFixed(2), headS: +vol.h[1].toFixed(2), rigState: r.rig?._state ?? r.rig?.state ?? null };
  }, idA);
  const waitSeen = async (pred, secs = 3) => {
    for (let t = 0; t < secs * 10; t++) { const s = await seen(); if (s && pred(s)) return s; await waitGame(b, 0.1); }
    return await seen();
  };
  const kb = await actionKeys(a, 'crouch', 'forward', 'grenade', 'jump', 'leanLeft', 'melee', 'reload', 'sprint');

  // agacharse
  await a.keyboard.down(kb.crouch);
  let s = await waitSeen((q) => q.st === 'crouch' && q.ce < 0.2);
  check('B ve a A agachado (rig y volumen bajo)', s?.st === 'crouch' && s.headY < 1.0, JSON.stringify(s));
  await a.keyboard.up(kb.crouch); await waitGame(a, 0.5);
  // inclinarse
  await a.keyboard.down(kb.leanLeft);
  s = await waitSeen((q) => Math.abs(q.cl) > 0.6);
  check('B ve a A inclinado (cabeza desplazada en el volumen)', Math.abs(s?.cl ?? 0) > 0.6 && Math.abs(s.headS) > 0.12, JSON.stringify(s));
  await a.keyboard.up(kb.leanLeft); await waitGame(a, 0.4);
  // deslizar: sprint y agacharse (hacia un lado libre, de vuelta después)
  await a.evaluate(() => { const p = window.BREACH.player; p.cam.yaw = p.yaw = Math.PI / 2; });
  await a.keyboard.down(kb.forward); await a.keyboard.down(kb.sprint);
  await untilGame(a, () => window.BREACH.player.state === 'roadie' && window.BREACH.player.speed > 6, 2);
  await a.keyboard.press(kb.crouch);
  const localSlide = await untilGame(a, () => window.BREACH.player.state === 'slide', 0.5);
  s = await waitSeen((q) => q.st === 'slide', 1.5);
  await a.keyboard.up(kb.sprint); await a.keyboard.up(kb.forward);
  check('B ve a A deslizar', s?.st === 'slide', JSON.stringify({ localSlide, s }));
  await waitGame(a, 0.8);
  // trepar: A junto a una cara LOW, saltando hacia ella
  const low = await a.evaluate(() => {
    const W = window.BREACH_WORLD, p = window.BREACH.player;
    const f = (W.faces || []).filter((q) => q.kind === 'low' && !(q.baseY > 0.05))
      .map((q) => ({ q, x: (q.a.x + q.b.x) / 2 + q.n.x * 0.7, z: (q.a.z + q.b.z) / 2 + q.n.z * 0.7 }))
      .filter((c) => { const t = { x: c.x, z: c.z }; W.resolveCircle(t, 0.38, 0); return Math.hypot(t.x - c.x, t.z - c.z) < 0.01; })
      .sort((u, v) => Math.hypot(u.x - p.pos.x, u.z - p.pos.z) - Math.hypot(v.x - p.pos.x, v.z - p.pos.z))[0];
    return f ? { x: f.x, z: f.z, yaw: Math.atan2(f.q.n.x, f.q.n.z) } : null;
  });
  if (low) {
    await glide(a, low.x, low.z);
    await a.evaluate((y) => { const p = window.BREACH.player; p.cam.yaw = p.yaw = y; p.cam.pitch = 0; }, low.yaw);
    await waitGame(a, 0.3);
    await a.keyboard.down(kb.forward); await a.keyboard.press(kb.jump);
    s = await waitSeen((q) => q.st === 'mantle', 1.5);
    await a.keyboard.up(kb.forward);
    check('B ve a A trepar sobre LOW', s?.st === 'mantle', JSON.stringify(s));
    await waitGame(a, 0.8);
    await glide(a, spot.x, spot.za);
  } else check('cara LOW para trepar', false);
  // recargar (y ver la recarga), y una recarga cancelada (cambio de arma)
  await a.evaluate(() => { const w = window.BREACH.weapons; if (w.st.mag >= w.def.mag) w.st.mag -= 5; });
  await a.keyboard.press(kb.reload);
  s = await waitSeen((q) => q.reloading, 1.5);
  check('B ve a A recargar', !!s?.reloading, JSON.stringify(s));
  await waitGame(a, 3);
  await a.evaluate(() => { const w = window.BREACH.weapons; w.st.mag = Math.max(1, w.st.mag - 5); });
  await a.keyboard.press(kb.reload);
  await waitSeen((q) => q.reloading, 1.5);
  const w0 = (await seen())?.w;
  await a.keyboard.press('Digit2'); // el cambio de arma cancela la recarga
  s = await waitSeen((q) => !q.reloading && q.w && q.w !== w0, 2);
  check('B ve la recarga cancelada y el cambio de arma', !s?.reloading && s?.w && s.w !== w0, JSON.stringify({ w0, s }));
  // golpe (con el cambio de arma ya terminado)
  await untilGame(a, () => !window.BREACH.weapons.swapping, 2); await waitGame(a, 0.3);
  await a.keyboard.press(kb.melee);
  s = await waitSeen((q) => q.st === 'melee', 1);
  check('B ve a A golpear', s?.st === 'melee', JSON.stringify(s));
  await waitGame(a, 0.8);
  // lanzamiento: B ve el bote de humo de A
  const nades0 = await b.evaluate(() => window.BREACH_SMOKE.projs.length + window.BREACH_SMOKE.clouds.length);
  await a.keyboard.press(kb.grenade);
  const thrown = await untilGame(b, (n0) => (window.BREACH_SMOKE.projs.length + window.BREACH_SMOKE.clouds.length) > n0, 3, nades0);
  check('B ve el lanzamiento de A', thrown);
  await waitGame(a, 1.5);

  // escopeta a 6 m: todo perdigón marcado en local se acredita
  await a.evaluate(() => { const w = window.BREACH.weapons; if (w.cur !== 'shotgun' && w.state.shotgun) w.startSwap('shotgun'); });
  await waitGame(a, 0.8);
  await b.waitForFunction(() => !(window.BREACH.spawnProt > 0));
  const hp0 = await b.evaluate(() => window.BREACH.selfHp);
  const claim = await a.evaluate(async (id) => {
    const G = window.BREACH, n = G.net, p = G.player, r = G.remotes.get(id);
    const e = window.BREACH_FP.eye, dx = r.x - e.x, dy = (r.y ?? 0) + 1.1 - e.y, dz = r.z - e.z;
    p.cam.yaw = Math.atan2(-dx, -dz); p.cam.pitch = Math.atan2(dy, Math.hypot(dx, dz)); p.yaw = p.cam.yaw;
    const claims = []; const oh = n.hit.bind(n);
    n.hit = (tid, dmg, part, gib, point, meta) => { claims.push({ tid, dmg, pellets: meta?.pellets ?? 1 }); return oh(tid, dmg, part, gib, point, meta); };
    await new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2)));
    const I = window.BREACH_INPUT; I._mouseFire = true; I.firePressed = true;
    for (let i = 0; i < 6 && !claims.length; i++) await new Promise((r2) => requestAnimationFrame(r2));
    I._mouseFire = false; I.fireReleased = true;
    n.hit = oh;
    return claims;
  }, idB);
  await waitGame(b, 0.6);
  const hp1 = await b.evaluate(() => window.BREACH.selfHp);
  const claimed = claim.filter((c) => c.tid === idB).reduce((t, c) => t + c.dmg, 0);
  const pellets = claim.filter((c) => c.tid === idB).reduce((t, c) => t + c.pellets, 0);
  check('escopeta a 6 m: cada perdigón marcado en local lo acredita el servidor', pellets > 0 && Math.abs((hp0 - hp1) - Math.min(hp0, Math.round(claimed))) <= 1,
    JSON.stringify({ pellets, claimed: Math.round(claimed), hp0, hp1 }));

  // lanzamiento rechazado → el bote vuelve
  const refund = await a.evaluate(async () => {
    const G = window.BREACH, w = G.weapons, n = G.net;
    if (typeof w.refundThrow !== 'function') return { skip: 'sin weapons.refundThrow' };
    const before = w.state.grenade?.mag ?? w.state.smoke?.mag;
    // muestra ilegal: salida a 5 m del ojo (el servidor la rechaza)
    const os = n.send.bind(n);
    n.send = (m) => { if (m?.t === 'nade') m = { ...m, o: [m.o[0] + 5, m.o[1], m.o[2]] }; return os(m); };
    G.weapons.quickThrow();
    for (let i = 0; i < 240; i++) await new Promise((r) => requestAnimationFrame(r));
    n.send = os;
    const after = w.state.grenade?.mag ?? w.state.smoke?.mag;
    return { before, after };
  });
  check('lanzamiento rechazado: el bote vuelve', !refund.skip && refund.after === refund.before, JSON.stringify(refund));
  // rechazo de un lanzamiento DESPUÉS de reaparecer (vida nueva real por el
  // servidor): se reembolsa una vez, con la vida correcta
  const killed = await (async () => {
    await b.evaluate(() => { window.BREACH.spawnProt = 0; const I = window.BREACH_INPUT; I._mouseFire = true; I.firePressed = true; });
    let dead = false;
    for (let i = 0; i < 120 && !dead; i++) {
      await b.evaluate((id) => { const G = window.BREACH, r = G.remotes.get(id), e = window.BREACH_FP.eye, p = G.player; if (!r) return; const dx = r.x - e.x, dy = (r.y ?? 0) + 1.2 - e.y, dz = r.z - e.z; p.cam.yaw = Math.atan2(-dx, -dz); p.cam.pitch = Math.atan2(dy, Math.hypot(dx, dz)); }, idA);
      await waitGame(b, 0.05); dead = await a.evaluate(() => !window.BREACH.selfAlive);
    }
    await b.evaluate(() => { const I = window.BREACH_INPUT; I._mouseFire = false; I.fireReleased = true; });
    return dead;
  })();
  check('B mata a A (vida nueva real)', killed);
  if (killed) {
    await a.waitForFunction(() => window.BREACH.selfAlive && window.BREACH.onlinePhase === 'playing', null, { timeout: 120000 });
    await waitGame(a, 0.5);
    const after = await a.evaluate(async () => {
      const G = window.BREACH, w = G.weapons, n = G.net;
      for (let i = 0; i < 120 && (w.swapping || w.throwing); i++) await new Promise((r) => requestAnimationFrame(r));
      const before = w.state.grenade?.mag; let rej = 0;
      const os = n.send.bind(n); n.send = (m) => { if (m?.t === 'nade') m = { ...m, o: [m.o[0] + 5, m.o[1], m.o[2]] }; return os(m); };
      const h = n.handlers.nadeReject; n.handlers.nadeReject = (m) => { rej++; h?.(m); };
      w.quickThrow();
      for (let i = 0; i < 240; i++) await new Promise((r) => requestAnimationFrame(r));
      n.send = os; n.handlers.nadeReject = h;
      return { before, after: w.state.grenade?.mag, rej, pending: w.pendingThrows?.length ?? null };
    });
    check('rechazo tras reaparecer: reembolso una vez y sin pendientes', after.rej === 1 && after.after === after.before && after.pending === 0, JSON.stringify(after));
  }
  // aturdido durante el gesto (antes de soltar): sin bote, sin coste, sin 'nade'
  const stunned = await a.evaluate(async () => {
    const G = window.BREACH, w = G.weapons, n = G.net;
    for (let i = 0; i < 120 && (w.swapping || w.throwing); i++) await new Promise((r) => requestAnimationFrame(r));
    const before = w.state.grenade?.mag ?? w.state.smoke?.mag; let sent = 0, cancel = 0;
    const os = n.send.bind(n); n.send = (m) => { if (m?.t === 'nade') sent++; return os(m); };
    const off = w.on('throwCancel', () => { cancel++; });
    w.quickThrow();
    for (let i = 0; i < 200 && !(w.throwing && w.cur !== 'smg' && w.cur !== 'shotgun'); i++) await new Promise((r) => requestAnimationFrame(r));
    w.cancelActions(); // lo que hace el aturdimiento (main.js: protoStun)
    for (let i = 0; i < 120; i++) await new Promise((r) => requestAnimationFrame(r));
    n.send = os; off?.();
    return { before, after: w.state.grenade?.mag ?? w.state.smoke?.mag, sent, cancel };
  });
  check('aturdido antes de soltar: no sale, no cuesta, un throwCancel', stunned.sent === 0 && stunned.after === stunned.before && stunned.cancel === 1, JSON.stringify(stunned));
  check('sin errores de página', errors === 0, String(errors));
} finally {
  await browser?.close();
  server.kill();
}
console.log(fails.length ? `FALLAN ${fails.length}: ${fails.join(' | ')}` : 'FPS ONLINE ACTIONS OK');
process.exit(fails.length ? 1 : 0);
