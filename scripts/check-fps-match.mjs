// Los TRES mapas se cargan y se JUEGAN en primera persona, en una partida 4v4
// con bots, y el render queda dentro de presupuesto (PEDIDO §18.17 y §18.19;
// PRUEBAS, corrida 6). Base: scripts/bench-match.mjs (que solo mide).
// Por mapa (fortaleza, azoteas, calle2):
//  - la partida arranca, la cámara de los ojos está viva y el arma (viewmodel)
//    se dibuja; el viewmodel cumple su presupuesto (≤ 12 llamadas de dibujo,
//    ≤ 45 000 triángulos con las hombreras y los detalles de primer plano);
//  - el jugador anda (W) y dispara (gasta munición) de verdad;
//  - los bots se mueven y solo emiten estados del contrato;
//  - nada se vuelve NaN, el reloj de juego avanza y no hay errores de página;
//  - presupuesto de la escena (llamadas, triángulos, programas): ver BUDGET.
// Todo se mide en CUADROS o tiempo de JUEGO. El tiempo de cuadro solo se
// exige con GPU real (BREACH_PERF_GPU=1, p95 ≤ 33 ms): en un runner sin GPU no
// significa nada. Sirve dist/ (lo construye pretest; a mano: npm run build).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { freePort, waitHttp, waitGame } from './lib-test.mjs';

// Decisión 20: GLB completos, detalle de primer plano y manos articuladas de CRASHTERRA.
const MAX_VM_TRIANGLES = 45_000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = process.argv[2] ? [process.argv[2]] : ['fortaleza', 'azoteas', 'calle2'];
// Presupuesto de REGRESIÓN de la escena completa en partida (gfx=medium,
// 1280×720, con viewmodel): lo medido en este árbol el 2026-11-20 + 25 %
// (fortaleza 447 llamadas / 0.75 M tri / 84 programas; azoteas 471 / 0.60 M / 60;
// calle2 1264 / 0.97 M / 89). Se ajusta solo con una razón escrita.
const BUDGETS = {
  fortaleza: { callsMax: 560, trisMed: 0.95e6, programs: 105 },
  azoteas: { callsMax: 590, trisMed: 0.76e6, programs: 75 },
  calle2: { callsMax: 1580, trisMed: 1.22e6, programs: 112 },
};
const STATES = new Set(['idle', 'run', 'roadie', 'jump', 'crouch', 'slide', 'mantle', 'melee', 'dead']);
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails.push(name); };

const port = await freePort();
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), NODE_ENV: 'test' }, stdio: 'ignore',
});
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  await waitHttp(`http://127.0.0.1:${port}/`);
  for (const MAP of MAPS) {
    const BUDGET = BUDGETS[MAP];
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?nolock=1&gfx=medium`, { waitUntil: 'networkidle', timeout: 600000 });
    await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; document.getElementById('btn-enter')?.click(); }, MAP);
    await page.waitForSelector('#splash.off', { state: 'attached', timeout: 600000 });
    await page.evaluate(() => document.getElementById('btn-bots').click());
    await page.waitForFunction(() => !document.getElementById('btn-lobby-start')?.disabled, null, { timeout: 600000, polling: 'raf' });
    await page.evaluate(() => document.getElementById('btn-lobby-start').click());
    // presentación y cuenta atrás: hasta que los controles se sueltan (estado, no reloj)
    await page.waitForFunction(() => window.BREACH.botMatch && !window.BREACH.botMatch.controlsLocked() && window.BREACH_FP?.live,
      null, { timeout: 900000, polling: 'raf' });
    await waitGame(page, 0.5);
    const loaded = await page.evaluate(() => ({ layout: window.BREACH_WORLD?.layout, bots: window.BREACH.botMatch?.bots?.length ?? 0 }));
    check(`${MAP}: partida cargada con 7 bots`, loaded.layout === MAP && loaded.bots === 7, JSON.stringify(loaded));

    // jugar: andar 1.5 s de juego hacia delante y disparar 0.6 s
    const play = await page.evaluate(async () => {
      const G = window.BREACH, I = window.BREACH_INPUT, p = G.player;
      const gw = (s) => new Promise((r) => { const end = G.simClock + s; const f = () => (G.simClock >= end ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      G.spawnProt = 0;
      const x0 = p.pos.x, z0 = p.pos.z, bots0 = G.botMatch.bots.map((b) => ({ x: b.pos.x, z: b.pos.z }));
      const states = new Set();
      const tick = () => { for (const b of G.botMatch.bots) states.add(b.netAnim || 'idle'); };
      I.keys.add('KeyW');
      for (let i = 0; i < 6; i++) { await gw(0.25); tick(); }
      I.keys.delete('KeyW');
      const moved = Math.hypot(p.pos.x - x0, p.pos.z - z0);
      const mag0 = G.weapons.st.mag;
      I._mouseFire = true; I.firePressed = true;
      await gw(0.6);
      I._mouseFire = false;
      const fired = mag0 - G.weapons.st.mag;
      await gw(1.5); tick();
      const botsMoved = G.botMatch.bots.filter((b, i) => Math.hypot(b.pos.x - bots0[i].x, b.pos.z - bots0[i].z) > 1).length;
      const finite = [p.pos.x, p.pos.z, p.y, window.BREACH_CAM.position.x, window.BREACH_CAM.position.y, window.BREACH_CAM.position.z].every(Number.isFinite);
      return { moved: +moved.toFixed(2), fired, botsMoved, states: [...states], finite, alive: G.selfAlive, clock: +G.simClock.toFixed(1) };
    });
    check(`${MAP}: el jugador anda`, play.moved > 1 || !play.alive, JSON.stringify(play));
    check(`${MAP}: el jugador dispara`, play.fired > 0 || !play.alive, JSON.stringify(play));
    check(`${MAP}: los bots se mueven`, play.botsMoved >= 3, JSON.stringify(play));
    check(`${MAP}: bots solo con estados del contrato`, play.states.every((s) => STATES.has(s)), JSON.stringify(play.states));
    check(`${MAP}: sin NaN`, play.finite, JSON.stringify(play));

    // render: 240 cuadros de partida con la vista de los ojos
    const perf = await page.evaluate(async () => {
      const R = window.BREACH_RENDERER, VM = window.BREACH_VM;
      const calls = [], tris = [], frames = [];
      let last = performance.now(), vmSeen = 0, vmCalls = 0, vmTris = 0;
      await new Promise((res) => {
        const tick = (t) => {
          frames.push(t - last); last = t; calls.push(R.info.render.calls); tris.push(R.info.render.triangles);
          const root = VM?.fp2?.vm?.root;
          if (root?.visible && window.BREACH_FP?.live) {
            vmSeen++;
            let c = 0, tr = 0;
            root.traverse((o) => {
              if (!o.isMesh) return;
              for (let q = o; q; q = q.parent) if (!q.visible) return;
              c++; const g = o.geometry; tr += (g.index ? g.index.count : g.attributes.position.count) / 3;
            });
            vmCalls = Math.max(vmCalls, c); vmTris = Math.max(vmTris, tr);
          }
          if (frames.length < 240) requestAnimationFrame(tick); else res();
        };
        requestAnimationFrame(tick);
      });
      const at = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
      return { vmSeen, vmCalls, vmTris: Math.round(vmTris), callsMax: at(calls, 1), callsMed: at(calls, 0.5), trisMed: at(tris, 0.5),
        programs: R.info.programs?.length ?? 0, msP95: +at(frames.slice(10), 0.95).toFixed(1) };
    });
    console.log(`${MAP} render ${JSON.stringify(perf)}`);
    check(`${MAP}: el arma en primera persona se dibuja`, perf.vmSeen > 120, `${perf.vmSeen}/240 cuadros`);
    check(`${MAP}: viewmodel ≤ 12 llamadas de dibujo`, perf.vmCalls > 0 && perf.vmCalls <= 12, `${perf.vmCalls}`);
    check(`${MAP}: viewmodel ≤ ${MAX_VM_TRIANGLES} triángulos`, perf.vmTris > 0 && perf.vmTris <= MAX_VM_TRIANGLES, `${perf.vmTris}`);
    check(`${MAP}: llamadas de dibujo ≤ ${BUDGET.callsMax}`, perf.callsMax <= BUDGET.callsMax, `${perf.callsMax}`);
    check(`${MAP}: triángulos (mediana) ≤ ${BUDGET.trisMed}`, perf.trisMed <= BUDGET.trisMed, `${perf.trisMed}`);
    check(`${MAP}: programas ≤ ${BUDGET.programs}`, perf.programs <= BUDGET.programs, `${perf.programs}`);
    if (process.env.BREACH_PERF_GPU === '1') check(`${MAP}: p95 de cuadro ≤ 33 ms (GPU)`, perf.msP95 <= 33, `${perf.msP95} ms`);
    check(`${MAP}: sin errores de página`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (fails.length) { console.error(`\nFPS MATCH: ${fails.length} fallos → ${fails.join(' | ')}`); process.exit(1); }
console.log('\nFPS MATCH OK · los tres mapas se juegan en primera persona dentro de presupuesto');
