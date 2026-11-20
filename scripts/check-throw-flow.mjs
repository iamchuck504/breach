// Lanzamientos y munición en vuelo con reloj de cuadros MANUAL (sin reloj de
// pared): requestAnimationFrame se conduce con un `now` sintético a 30/60/144
// Hz, así el frame rate es la única variable.
// 1) el humo lanzado en hip sigue al pitch de cámara y su dirección no
//    depende de los fps (antes salía del eje del bote en la mano: +0.18 a 30,
//    −0.24 a 60 y −0.28 a 144 fps, sin importar el pitch);
// 2) con la pausa abierta (práctica) cohetes y humo quedan congelados;
// 3) online, morir a mitad del gesto descarta el bote: al reaparecer no sale
//    ningún humo del cañón de la SMG inicial.
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8844, WS_PORT = 8845;
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(WS_PORT), INTRO_TIME: '0',
    COUNTDOWN_TIME: '0', NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
});
await new Promise((r) => setTimeout(r, 1500));

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

// el loop del juego (`frame`) se conduce a mano; su callback nativo pendiente
// se descarta para no duplicarlo
const manualClock = () => {
  const native = window.requestAnimationFrame.bind(window);
  const queue = [];
  window.__clock = { manual: false, now: 0 };
  window.requestAnimationFrame = (cb) => {
    if (cb.name === 'frame') window.__frameCb = cb;
    if (window.__clock.manual) { if (cb.name !== 'frame') queue.push(cb); return 1; }
    return native((t) => { if (window.__clock.manual && cb.name === 'frame') return; cb(t); });
  };
  window.__manual = () => { window.__clock.manual = true; window.__clock.now = performance.now(); };
  window.__frames = (n, fps, each) => {
    for (let i = 0; i < n; i++) {
      window.__clock.now += 1000 / fps;
      for (const cb of queue.splice(0)) cb(window.__clock.now);
      window.__frameCb(window.__clock.now);
      if (each && each(i) === true) return i + 1;
    }
    return n;
  };
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let pageErrors = 0;
async function newGame() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  await page.addInitScript(manualClock);
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=low`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; document.getElementById('btn-enter')?.click(); });
  await page.waitForSelector('#splash.off', { state: 'attached' });
  return page;
}

let peer;
try {
  // ---------- práctica: lanzamiento hip y pausa ----------
  const page = await newGame();
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.mode === 'practice' && window.BREACH?.player && window.BREACH?.rig,
    null, { timeout: 45000, polling: 100 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__manual(); window.__frames(3, 60); });

  const throws = await page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT, S = window.BREACH_SMOKE;
    for (const d of G.dummies.list) d.alive = false;
    const out = [];
    for (const fps of [30, 60, 144]) for (const pitch of [-0.3, 0, 0.3]) {
      const place = () => {
        // línea larga y abierta de Fortaleza: la guía de cámara queda lejos
        G.player.pos.x = -16; G.player.pos.z = 20; G.player.y = 0;
        G.player.yaw = 0; G.player.cam.yaw = 0; G.player.cam.pitch = pitch;
      };
      place();
      if (G.weapons.cur !== 'grenade') G.weapons.startSwap('grenade');
      window.__frames(Math.ceil(fps * 2), fps, place);
      const n0 = S.projs.length;
      I._mouseFire = true; I.firePressed = true;
      window.__frames(Math.ceil(fps * 1.2), fps, (i) => { place(); if (i === 1) I._mouseFire = false; return S.projs.length > n0; });
      const p = S.projs[S.projs.length - 1];
      out.push(p && S.projs.length > n0 ? { fps, pitch, y: (p.vy - 4.2) / 12, x: p.vx / 12 } : { fps, pitch, error: true });
      S.clear();
    }
    return out;
  });
  check('cada lanzamiento hip produce un bote', throws.every((t) => !t.error), JSON.stringify(throws.filter((t) => t.error)));
  for (const pitch of [-0.3, 0, 0.3]) {
    const row = throws.filter((t) => t.pitch === pitch && !t.error);
    const spread = Math.max(...row.map((t) => t.y)) - Math.min(...row.map((t) => t.y));
    check(`pitch ${pitch}: misma dirección vertical a 30/60/144 fps`, spread < 0.03,
      row.map((t) => `${t.fps}:${t.y.toFixed(3)}`).join(' '));
  }
  const at60 = (pitch) => throws.find((t) => t.fps === 60 && t.pitch === pitch)?.y ?? NaN;
  check('el pitch de cámara gobierna el lanzamiento hip',
    at60(0.3) - at60(-0.3) > 0.45, `−0.3→${at60(-0.3).toFixed(3)} · +0.3→${at60(0.3).toFixed(3)}`);

  // Lanzamientos cerca de geometría: la dirección nunca vuelve hacia el
  // jugador y el bote nunca nace al otro lado del cover.
  const close = await page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT, S = window.BREACH_SMOKE, W = window.BREACH_WORLD, THREE = window.THREE;
    const pick = (lo, hi) => W.colliders.filter((c) => c.h >= lo && c.h <= hi && c.maxx - c.minx > 1.6 && c.maxz - c.minz > 0.3 &&
      Math.abs((c.minz + c.maxz) / 2) < 30 && Math.abs(c.maxx) < 30)
      .find((c) => { const p = { x: c.maxx + 0.45, z: (c.minz + c.maxz) / 2 }; const q = { ...p }; W.resolveCircle(q, 0.38, 0);
        return Math.hypot(q.x - p.x, q.z - p.z) < 0.02 && W.groundHeight(p, 0.38, 0) < 0.05; });
    const high = pick(2.4, 8), low = pick(0.8, 1.25);
    const at = (c) => ({ x: c.maxx + 0.45, z: (c.minz + c.maxz) / 2 });
    const cases = [];
    if (high) {
      cases.push({ name: 'frente a muro a 0.5 m', ...at(high), yaw: Math.PI / 2, pitch: 0 });
      cases.push({ name: 'espalda contra muro', ...at(high), yaw: -Math.PI / 2, pitch: 0 });
      cases.push({ name: 'pegado a cover alto, de lado', ...at(high), yaw: 0, pitch: 0.1 });
      cases.push({ name: 'cover alto a la derecha (lado de la cámara)', ...at(high), yaw: Math.PI, pitch: 0.1 });
      // esquina: la cámara de hombro ve la arista del muro más cerca que la mano
      for (const [dz, yaw] of [[0.25, Math.PI * 0.75], [0.25, Math.PI * 0.9], [-0.25, Math.PI * 0.25], [-0.25, Math.PI * 0.1]]) {
        const z = dz > 0 ? high.maxz + dz : high.minz + dz;
        cases.push({ name: `esquina de cover alto yaw ${(yaw / Math.PI).toFixed(2)}π`, x: high.maxx + 0.45, z, yaw, pitch: 0 });
      }
    }
    if (low) cases.push({ name: 'pegado a cover bajo, de frente', ...at(low), yaw: Math.PI / 2, pitch: 0.15 });
    cases.push({ name: 'apuntando al cielo', x: -16, z: 20, yaw: 0, pitch: 1.2 });
    const out = [];
    for (const k of cases) {
      const place = () => { G.player.pos.x = k.x; G.player.pos.z = k.z; G.player.y = 0;
        G.player.yaw = k.yaw; G.player.cam.yaw = k.yaw; G.player.cam.pitch = k.pitch; };
      place(); window.__frames(100, 60, place);
      const n0 = S.projs.length;
      I._mouseFire = true; I.firePressed = true;
      window.__frames(60, 60, (i) => { place(); if (i === 1) I._mouseFire = false; return S.projs.length > n0; });
      const pr = S.projs[S.projs.length - 1];
      if (!pr || S.projs.length === n0) { out.push({ name: k.name, error: 'sin bote' }); continue; }
      const fwd = new THREE.Vector3(-Math.sin(k.yaw) * Math.cos(k.pitch), Math.sin(k.pitch), -Math.cos(k.yaw) * Math.cos(k.pitch));
      const dir = new THREE.Vector3(pr.vx, pr.vy - 4.2, pr.vz).normalize();
      const chest = new THREE.Vector3(k.x, 1.3, k.z), rel = new THREE.Vector3(pr.x, pr.y, pr.z);
      // el bote ya pudo moverse un paso: se mide su origen registrado si existe
      const o = pr.o ? new THREE.Vector3(pr.o.x, pr.o.y, pr.o.z) : rel;
      const v = o.clone().sub(chest), len = v.length();
      const blocked = len > 0.02 && W.raycast(chest, v.normalize(), len) !== null;
      out.push({ name: k.name, dot: +dir.dot(fwd).toFixed(3), releaseBehindCover: blocked });
      S.clear();
    }
    return { found: { high: !!high, low: !!low }, out };
  });
  check('escenarios de lanzamiento cercano encontrados', close.found.high && close.found.low, JSON.stringify(close.found));
  for (const c of close.out) {
    check(`lanzamiento ${c.name}: sigue a la cámara y nace del lado propio`,
      !c.error && c.dot > 0.5 && !c.releaseBehindCover, JSON.stringify(c));
  }

  const paused = await page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT, S = window.BREACH_SMOKE, R = window.BREACH_ROCKETS;
    const menu = document.getElementById('menu');
    const place = () => { G.player.pos.x = -16; G.player.pos.z = 20; G.player.y = 0; G.player.yaw = 0; G.player.cam.yaw = 0; G.player.cam.pitch = 0.05; };
    place(); window.__frames(100, 60, place); // cooldown del lanzamiento anterior
    I._mouseFire = true; I.firePressed = true; window.__frames(2, 60, place); I._mouseFire = false;
    window.__frames(150, 60, place);
    const cloud = S.clouds[S.clouds.length - 1];
    const c0 = cloud?.t;
    menu.classList.remove('off'); window.__frames(180, 60); menu.classList.add('off');
    const cloudDt = cloud ? cloud.t - c0 : null;
    G.weapons.giveSpecial('bazooka'); window.__frames(30, 60, place);
    const n0 = R.list.length;
    I._mouseFire = true; I.firePressed = true;
    window.__frames(20, 60, () => { place(); I._mouseFire = false; return R.list.length > n0; });
    const rk = R.list[R.list.length - 1];
    const z0 = rk?.z;
    menu.classList.remove('off'); window.__frames(30, 60);
    const res = { cloudDt, rocket: !!rk, rocketDz: rk ? rk.z - z0 : null, rocketAlive: R.list.includes(rk) };
    menu.classList.add('off');
    return res;
  });
  // soltar y volver a pulsar el ratón ENTRE dos pasos (144 Hz): el tiro
  // siguiente no hereda el crédito de cadencia (antes: 90.3 ms vs 96.8)
  const relGap = await page.evaluate(() => {
    const G = window.BREACH, cv = window.BREACH_INPUT.canvas;
    const down = () => cv.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const up = () => window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    const place = () => { G.player.pos.x = -16; G.player.pos.z = 20; G.player.y = 0; G.player.yaw = 0; G.player.cam.yaw = 0; G.player.cam.pitch = 0; };
    // la sección de pausa dejó la bazooka en el slot de la SMG
    if (!G.weapons.hasWeapon('smg')) G.weapons.replaceSlot(G.weapons.slots.indexOf('bazooka'), 'smg');
    G.weapons.startSwap('smg'); window.__frames(120, 60, place);
    let minGap = Infinity; const misses = [];
    // corrida determinista: cd y crédito a cero, gatillo mantenido; devuelve
    // los cuadros de cada tiro. `relAfter` = soltar+pulsar tras ese tiro.
    const run = (relAfter) => {
      G.weapons.state.smg.cd = 0; G.weapons._credit = 0; G.weapons.st.mag = 50;
      down();
      let mag = G.weapons.st.mag, n = 0; const shots = [];
      window.__frames(400, 144, (i) => {
        place(); G.weapons.st.reserve = 999;
        if (G.weapons.st.mag < 10) { G.weapons.st.mag = 50; mag = 50; }
        if (G.weapons.st.mag < mag) { shots.push(i); if (n === relAfter) { up(); down(); } n++; }
        mag = G.weapons.st.mag;
        return shots.length >= 30;
      });
      up(); window.__frames(60, 144, place);
      return shots;
    };
    const dry = run(-1);
    // tiros a los que sigue un intervalo de 13 cuadros (crédito en juego)
    const short = dry.slice(1).map((f, i) => f - dry[i]).map((g, i) => g === 13 ? i : -1).filter((i) => i > 0).slice(0, 4);
    for (const j of short) {
      const wet = run(j);
      const gap = (wet[j + 1] - wet[j]) / 144;
      if (Number.isFinite(gap)) minGap = Math.min(minGap, gap); else misses.push({ j, len: wet.length });
    }
    if (!short.length) misses.push({ dryGaps: dry.slice(1, 12).map((f, i) => f - dry[i]) });
    return { minGap, misses: misses.slice(0, 3) };
  });
  check('soltar y re-pulsar entre pasos no conserva crédito de cadencia',
    relGap.minGap >= 60 / 620 - 1e-6 && relGap.minGap < 1, `${(relGap.minGap * 1000).toFixed(1)} ms (nominal ${(60000 / 620).toFixed(1)}) ${JSON.stringify(relGap.misses)}`);

  // recarga a mitad (antes de meter el cargador) y pausa: la pieza
  // programada se corta y al reanudar se reprograma desde el progreso real
  const reload = await page.evaluate(() => {
    const G = window.BREACH, A = window.BREACH_AUDIO, menu = document.getElementById('menu');
    G.weapons.startSwap('pistol'); window.__frames(60, 60);
    G.weapons.st.mag = 5; G.weapons.startReload();
    const dur = G.weapons.def.reloadTime;
    window.__frames(Math.round(dur * 0.3 * 60), 60);
    const log = [];
    const p0 = A._play.bind(A), s0 = A.engine?.stopTag?.bind(A.engine);
    A._play = (name, o) => { log.push({ k: 'play', name, in: o?.at != null ? +(o.at - A._now()).toFixed(3) : null }); return p0(name, o); };
    if (s0) A.engine.stopTag = (tag, f) => { log.push({ k: 'stop', tag }); return s0(tag, f); };
    const progress = 1 - G.weapons.st.reload / dur;
    menu.classList.remove('off'); window.__frames(120, 60);
    const duringPause = log.slice();
    menu.classList.add('off'); window.__frames(1, 60);
    A._play = p0; if (s0) A.engine.stopTag = s0;
    return { dur, progress, hasEngine: !!A.engine, duringPause, afterResume: log.slice(duringPause.length) };
  });
  const cut = reload.duringPause.some((e) => e.k === 'stop' && e.tag === 'reload');
  const magIn = reload.afterResume.find((e) => e.k === 'play' && e.name === 'mag_in_light');
  const want = (0.55 - reload.progress) * reload.dur;
  check('la pausa corta las piezas de recarga programadas', !reload.hasEngine || cut, JSON.stringify(reload.duringPause));
  check('al reanudar, el cargador suena según el progreso real',
    !reload.hasEngine || (magIn && Math.abs(magIn.in - want) < 0.05),
    `programado en ${magIn?.in} s, esperado ${want.toFixed(3)} s`);

  // escopeta: pausar dentro de los 80 ms entre el último cartucho y el
  // bombeo corta el bombeo y lo reanuda con lo que le faltaba
  const pump = await page.evaluate(() => {
    const G = window.BREACH, A = window.BREACH_AUDIO, menu = document.getElementById('menu');
    if (!A.engine) return { hasEngine: false };
    G.weapons.startSwap('shotgun'); window.__frames(60, 60);
    G.weapons.st.mag = G.weapons.def.mag - 1; G.weapons.startReload();
    const log = [];
    const p0 = A._play.bind(A), s0 = A.engine.stopTag.bind(A.engine), d0 = A.reloadDone.bind(A);
    let doneAt = null;
    A.reloadDone = (w) => { doneAt = A._now(); return d0(w); };
    A._play = (name, o) => { if (name === 'pump') log.push({ k: 'play', in: o?.at != null ? +(o.at - A._now()).toFixed(3) : null }); return p0(name, o); };
    A.engine.stopTag = (tag, f) => { if (tag === 'pump') log.push({ k: 'stop' }); return s0(tag, f); };
    window.__frames(120, 60, () => doneAt !== null);
    menu.classList.remove('off'); window.__frames(60, 60);
    const paused = log.slice();
    menu.classList.add('off'); window.__frames(1, 60);
    A._play = p0; A.engine.stopTag = s0; A.reloadDone = d0;
    return { hasEngine: true, done: doneAt !== null, paused, resumed: log.slice(paused.length) };
  });
  check('pausa justo tras el último cartucho: el bombeo se corta y se reanuda',
    !pump.hasEngine || (pump.done && pump.paused.some((e) => e.k === 'stop') &&
      pump.resumed.some((e) => e.k === 'play' && e.in > 0 && e.in <= 0.08)), JSON.stringify(pump));

  check('el humo no envejece con la pausa abierta', paused.cloudDt === 0, `Δt=${paused.cloudDt}`);
  check('el cohete queda congelado con la pausa abierta',
    paused.rocket && paused.rocketDz === 0 && paused.rocketAlive, JSON.stringify(paused));
  await page.close();

  // ---------- online: morir a mitad del lanzamiento ----------
  const op = await newGame();
  await op.evaluate((port) => {
    document.getElementById('in-name').value = 'THROWER';
    document.getElementById('in-server').value = `ws://127.0.0.1:${port}`;
    document.getElementById('btn-lobby-create').click();
  }, WS_PORT);
  await op.waitForTimeout(800);
  peer = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', action: 'join', name: 'PEER', v: 0 })));
    ws.on('error', reject);
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'welcome') resolve({ ws, id: m.id }); });
  });
  await op.waitForFunction(() => { const b = document.getElementById('btn-lobby-start'); return b && !b.disabled; },
    null, { timeout: 10000, polling: 100 });
  await op.evaluate(() => document.getElementById('btn-lobby-start').click());
  await op.waitForFunction(() => window.BREACH?.mode === 'online' && window.BREACH?.onlinePhase === 'playing' && window.BREACH?.player,
    null, { timeout: 45000, polling: 100 });
  await op.waitForTimeout(600);
  const death = await op.evaluate((peerId) => {
    const G = window.BREACH, I = window.BREACH_INPUT, S = window.BREACH_SMOKE;
    window.__manual(); window.__frames(3, 60);
    const sent = [];
    const send0 = G.net.send.bind(G.net);
    G.net.send = (m) => { if (m.t === 'nade') sent.push(G.weapons.cur); return send0(m); };
    const n0 = S.projs.length;
    G.weapons.startSwap('grenade'); window.__frames(60, 60);
    const equipped = G.weapons.cur;
    I._mouseFire = true; I.firePressed = true; window.__frames(2, 60); I._mouseFire = false;
    window.__frames(6, 60); // antes del release
    const midThrow = G.throwT > 0 && G.throwPending;
    // mensajes reales del servidor, entregados por los handlers del cliente
    G.net.handlers.death({ t: 'death', target: G.net.id, from: peerId, gib: 0, hs: 0, ex: 0, w: 'smg',
      dist: 5, dmg: 20, part: 'body', respawn: 1, kn: 'PEER', kt: 'blue', vn: 'THROWER', vt: 'red' });
    window.__frames(60, 60);
    const deadThrowT = G.throwT;
    G.net.handlers.respawn({ t: 'respawn', id: G.net.id, spawn: { x: G.player.pos.x, z: G.player.pos.z, yaw: 0 } });
    window.__frames(40, 60);
    return { equipped, midThrow, deadThrowT, sent, spawned: S.projs.length - n0 };
  }, peer.id);
  check('el gesto estaba en curso al morir', death.equipped === 'grenade' && death.midThrow, JSON.stringify(death));
  check('la muerte descarta el lanzamiento pendiente', death.deadThrowT === 0, `throwT=${death.deadThrowT}`);
  check('al reaparecer no sale ningún bote', death.sent.length === 0 && death.spawned === 0, JSON.stringify(death));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  peer?.ws.close();
  await browser.close();
  vite.kill(); server.kill();
}
if (fails.length) { console.error(`THROW FLOW FAILED (${fails.length})`); process.exit(1); }
console.log('THROW FLOW OK — lanzamiento por cámara sin depender de fps, pausa y muerte limpias');
