// MATRIZ HONESTA (FPS, de punta a punta). Navegador real + servidor real con
// TODAS sus guardas (testPlace solo para colocar los actores) + un proxy WebSocket dentro de la prueba que
// retrasa cada mensaje 0–60 ms (semilla fija, una cola por sentido: nunca
// desordena), a 30 y 60 c/s REALES. Un jugador honesto (A) actúa contra B
// junto a un muro real en las situaciones límite de las auditorías.
// Por escenario: intentos, impactos marcados en local, daño reclamado, daño
// que el servidor aplica (exacto, sin tope) y rechazos del servidor por
// motivo (contador /test/refusals, que debe responder; incluye descartes
// silenciosos). Una espera que no se cumple FALLA el escenario; un escenario
// que no intenta (o no marca, si debe marcar) FALLA.
//   FPS=30|60 · SEEDS=1234,98765 · SPECIALS=sniper,bazooka (por defecto todos)
import assert from 'node:assert/strict';
import { spreadFor } from '../src/combat/weapons.js';
import { STAND } from '../src/combat/hit-pose.js';
import { evaluateBlast } from '../src/combat/blast.js';
import { TUNING } from '../src/config/tuning.js';
import { SMOKE_GRAVITY } from '../src/game/smoke-physics.js';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { CHROME } from './lib-chrome.mjs';
import { actionKeys, freePort, waitHttp, waitGame, untilGame } from './lib-test.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:5200';
const RATES = process.env.FPS ? process.env.FPS.split(',').map(Number) : [30, 60];
const SEEDS = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : [1234, 98765];
const SPECIALS = process.env.SPECIALS ? process.env.SPECIALS.split(',') : ['sniper', 'bazooka'];
assert.ok(RATES.every(rate => rate === 30 || rate === 60), 'FPS debe ser 30 o 60');
assert.ok(SEEDS.every(Number.isSafeInteger), 'semilla entera');
assert.ok(SPECIALS.every(w => ['sniper', 'bazooka'].includes(w)), 'arma especial desconocida');
const fullMatrix = [30,60].every(n => RATES.includes(n)) && [1234,98765].every(n => SEEDS.includes(n)) &&
  ['sniper','bazooka'].every(w => SPECIALS.includes(w));
const fails = [];
const check = (n, ok, x = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!ok) fails.push(n); };

// ---------- proxy: retraso sembrado 0–60 ms, en orden ----------
function startProxy(port, target, seed, stats) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const http = createServer(async (req, res) => {
    try {
      const r = await fetch(`http://127.0.0.1:${target}${req.url}`);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'text/plain', 'access-control-allow-origin': '*' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502); res.end(); }
  });
  http.listen(port, '127.0.0.1');
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (client) => {
    const up = new WebSocket(`ws://127.0.0.1:${target}`);
    // Un temporizador por sentido. Al despertar, entregar en orden todo lo
    // vencido: un temporizador adicional por paquete inventaba más latencia.
    const lane = () => {
      const queue = [];
      let last = 0, seq = 0, done = -1;
      const pump = () => {
        while (queue.length && queue[0].at <= performance.now()) {
          const { fn, n } = queue.shift();
          if (n <= done) stats.reordered++;
          done = n; stats.delivered++; fn();
        }
        if (queue.length) setTimeout(pump, Math.ceil(queue[0].at - performance.now()));
      };
      return fn => {
        last = Math.max(last, performance.now() + rnd() * 60);
        queue.push({ at: last, fn, n: seq++ });
        if (queue.length === 1) pump();
      };
    };
    const toServer = lane(), toClient = lane();
    const pending = [];
    up.on('open', () => { for (const m of pending.splice(0)) up.send(m); });
    client.on('message', (m, bin) => toServer(() => { const d = bin ? m : m.toString(); if (up.readyState === 1) up.send(d); else pending.push(d); }));
    up.on('message', (m, bin) => toClient(() => { if (client.readyState === 1) client.send(bin ? m : m.toString()); }));
    client.on('close', () => up.close()); up.on('close', () => client.close());
    client.on('error', () => {}); up.on('error', () => {});
  });
  return { close: () => { wss.close(); http.close(); } };
}

async function runAt(rate, seed, special) {
  const tag = `${rate} c/s · semilla ${seed} · ${special}`;
  const SPORT = await freePort(), PPORT = await freePort();
  // SIN ALLOW_TEST_TELEPORTS: la guarda de movimiento está activa
  const env = { ...process.env, PORT: String(SPORT), INTRO_TIME: '1', COUNTDOWN_TIME: '0.5', NODE_ENV: 'test',
    BREACH_FILL_BOTS: '0', BREACH_EXPERIMENTAL_STUN: '1', SPECIAL_FIRST_WEAPON: special };
  delete env.ALLOW_TEST_TELEPORTS;
  const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], { cwd: root, env, stdio: 'ignore' });
  let proxy, browser;
  try {
    await waitHttp(`http://127.0.0.1:${SPORT}/status`);
    const stats = { delivered: 0, reordered: 0 };
    proxy = startProxy(PPORT, SPORT, seed, stats);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    let errors = 0;
    const FT = 1000 / rate;
    const refusals = async () => {
      const r = await fetch(`http://127.0.0.1:${SPORT}/test/refusals`, { signal: AbortSignal.timeout(30000) });
      assert.equal(r.status, 200, '/test/refusals');
      const counters = await r.json();
      assert.ok(counters && typeof counters === 'object' && !Array.isArray(counters));
      assert.ok(Object.values(counters).every(n => Number.isSafeInteger(n) && n >= 0));
      return counters;
    };
    await refusals();
    check(`${tag}: responde /test/refusals`, true);
    const client = async (name) => {
      const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { errors++; console.log(name, 'PAGEERROR:', e.message); });
      page.setDefaultTimeout(300000);
      // sin recarga en caliente de Vite (otros editan el árbol durante la prueba)
      await page.addInitScript(() => { const W = window.WebSocket;
        localStorage.setItem('breach.video.scale', '0.5');
        window.WebSocket = function (url, proto) { if (proto === 'vite-hmr' || (Array.isArray(proto) && proto.includes('vite-hmr'))) return { readyState: 3, send() {}, close() {}, addEventListener() {}, removeEventListener() {} }; return new W(url, proto); };
        window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 }); });
      // 30/60 c/s REALES (cuadros retenidos hasta que pasa `ft` real) y una
      // pausa de pestaña simulable (window.__pauseUntil: no se entrega ningún cuadro)
      await page.addInitScript((ft) => { const o = window.requestAnimationFrame.bind(window); let vt = 0, next = null, q = [], armed = false;
        const tick = (ts) => { if (window.__pauseUntil && performance.now() < window.__pauseUntil) { o(tick); return; }
          if (next === null) next = ts; if (ts + 0.5 >= next) { next += ft; if (ts - next > 4 * ft) next = ts + ft; vt = ts; window.__frames = (window.__frames || 0) + 1; const run = q; q = []; armed = false; for (const cb of run) { try { cb(vt); } catch (e) { setTimeout(() => { throw e; }); } } } else o(tick); };
        window.requestAnimationFrame = (cb) => { q.push(cb); if (!armed) { armed = true; o(tick); } return q.length; }; }, FT);
      await page.goto(`${BASE}/?nolock=1&gfx=off`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        // Dos clientes comparten la GPU del runner; la matriz mide la
        // simulación, la red y los cuadros reales. El mapa sigue dibujándose.
        window.BREACH_RENDERER.shadowMap.enabled = false;
        localStorage.setItem('breach.map', 'fortaleza');
        document.getElementById('btn-enter')?.click();
      });
      await page.waitForSelector('#splash.off', { state: 'attached' });
      await page.evaluate(([p, n]) => {
        document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
        document.getElementById('btn-online').click();
        const el = document.getElementById('in-online-name'); el.value = n; el.dispatchEvent(new Event('input', { bubbles: true }));
      }, [PPORT, name]);
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
    const kb = await actionKeys(a, 'crouch', 'evade', 'forward', 'grenade', 'jump', 'leanLeft', 'leanRight', 'melee', 'pickup', 'sprint');

    const game = (page, seconds) => waitGame(page, seconds, { timeout: 60000 });
    const until = async (page, fn, secs, arg) => {
      assert.ok(await untilGame(page, fn, secs, arg), `Condición incumplida tras ${secs} s de juego: ${fn}`);
      return true;
    };
    const playing = page => until(page, () => window.BREACH.onlinePhase === 'playing' && window.BREACH.selfAlive, 60);
    // FIFO: mover la predicción al enviar testPlace, para que ningún estado
    // posterior lleve las coordenadas viejas durante el viaje de la corrección.
    const place = async (page, x, z, y = 0) => {
      await page.evaluate(({x, y, z}) => {
        const {net, player} = window.BREACH;
        window.__placed = null;
        net.resetLife(player); // descarta la pose aún sin enviar del emplazamiento anterior
        player.pos.x = x; player.pos.z = z; player.y = y;
        player.vel.x = player.vel.z = player.vy = 0;
        net.send({t: 'testPlace', x, y, z, yaw: player.yaw});
      }, {x, y, z});
      return until(page, ([x,y,z]) => {
        const m = window.__placed;
        return m && m.x === x && m.y === y && m.z === z;
      }, 3, [x,y,z]);
    };
    const face = (page, yaw, pitch = 0) => page.evaluate(([y, pt]) => { const p = window.BREACH.player; p.cam.yaw = p.yaw = y; p.cam.pitch = pt; }, [yaw, pitch]);

    // sitio: carril de 12 m libre con línea de vista y un muro real a ≤ 0.75 m del costado
    const spot = await a.evaluate(() => {
      const W = window.BREACH_WORLD, V = window.THREE;
      // Un destino admisible para el círculo puede quedar dentro de la
      // holgura de fachada. El controller saca de ahí incluso a un blanco quieto.
      const free = window.__freeGround = (x, z) => {
        const q = {x,z};
        W.resolveCircle(q, 0.38, 0);
        W.resolveFacadeBody(q, 0.38, 0);
        return Math.hypot(q.x-x, q.z-z) < 0.001 && W.groundHeight(q, 0.38, 0) < 0.05;
      };
      for (let z0 = -26; z0 <= 26; z0 += 0.5) for (let x = -24; x <= 24; x += 0.5) {
        if (!free(x,z0) || !free(x,z0+12)) continue;
        let clear = true;
        for (const h of [0.5, 0.8, 1.5]) for (const dx of [-0.4, 0, 0.4]) if (W.raycast(new V.Vector3(x + dx, h, z0), new V.Vector3(0, 0, 1), 12, 0) !== null) clear = false;
        if (!clear) continue;
        const side = [1, -1].find((sx) => W.raycast(new V.Vector3(x, 1.4, z0), new V.Vector3(sx, 0, 0), 0.75, 0) !== null);
        if (!side) continue;
        for (let dz = 0.25; dz < 12 && clear; dz += 0.25) clear = free(x,z0+dz);
        if (clear) return { x, za: z0, zb: z0 + 6, wallSide: side };
      }
      return null;
    });
    check(`${tag}: sitio junto a un muro con línea de vista`, !!spot, JSON.stringify(spot));
    if (!spot) return;
    // cara LOW libre por delante (lanzar por encima de ella agachado y pegado)
    const low = await a.evaluate(([sx, sz]) => {
      const W = window.BREACH_WORLD, V = window.THREE;
      const free = window.__freeGround;
      const choices = [];
      for (const f of W.faces) {
        const width = Math.hypot(f.b.x-f.a.x,f.b.z-f.a.z);
        if (f.kind !== 'low' || f.baseY > 0.05 || width < 2.6) continue;
        const edgeX = (f.a.x+f.b.x)/2, edgeZ = (f.a.z+f.b.z)/2;
        const {x:nx,z:nz} = f.n, x = edgeX+0.4*nx, z = edgeZ+0.4*nz;
        const tx = edgeX-5*nx, tz = edgeZ-5*nz;
        if (!free(x,z) || !free(tx,tz)) continue;
        if (W.raycast(new V.Vector3(x,1.45,z),new V.Vector3(-nx,0,-nz),5.4,0) !== null) continue;
        choices.push({x,z,nx,nz,edgeX,edgeZ,tx,tz,width,yaw:Math.atan2(nx,nz),top:f.topY ?? f.h});
      }
      const face = choices.sort((u,v) => Math.hypot(u.x-sx,u.z-sz)-Math.hypot(v.x-sx,v.z-sz))[0];
      if (!face) return null;
      for (let z = -26; z <= 26; z++) for (let x = -24; x <= 24; x++) {
        if (Math.hypot(x-face.x, z-face.z) > 35 && free(x,z)) return {...face, spectator: {x,z}};
      }
      return null;
    }, [spot.x, spot.za]);

    // Registrar los mensajes reales antes de que los consumidores de UI los
    // transformen. testDamage se emite al descontar HP, antes de topar la vida a cero.
    for (const page of [a,b]) await page.evaluate(() => {
      const G = window.BREACH, n = G.net;
      window.__sent = []; window.__received = []; window.__claims = [];
      const respawns = new Map(), discarded = window.__discardedStates = new Set();
      const hit = n.hit.bind(n);
      n.hit = (target,dmg,...rest) => {
        window.__claims.push({sq:n.shotSeq,target,dmg});
        return hit(target,dmg,...rest);
      };
      const send = n.send.bind(n);
      n.send = m => {
        window.__sent.push({m, life: G.weapons.life, at: performance.now(),
          ...(m.t === 'fire' ? {scope: window.BREACH_VM?.fp2?.vm?.scopeIn01?.()} : {})});
        return send(m);
      };
      let fence;
      const snapshot = n.handlers.snap;
      n.on('testFence', m => { fence = m; });
      n.on('snap', m => {
        snapshot(m);
        window.__snapFence = fence;
      });
      for (const t of ['correction','death','respawn','testDamage','testStateDiscard','fire','nadeAck','nadeReject','rocketReject',
        'rocketBoom','smokeStart','protoEvent','protoState','specialTaken']) {
        const handler = n.handlers[t];
        n.handlers[t] = m => {
          if (t === 'respawn' && m.id === n.id) respawns.set(m.life, window.__sent.length);
          if (t === 'testStateDiscard') {
            const cutoff = respawns.get(m.current);
            const i = window.__sent.findIndex(q => q.m.t === 's' && q.m.n === m.n &&
              q.m.life === m.life && q.life === m.life);
            if (!(i >= 0 && i < cutoff && m.current === m.life + 1) || discarded.has(m.n)) {
              throw new Error('descarte sin postura única anterior a la reaparición: ' + JSON.stringify(m));
            }
            discarded.add(m.n);
          }
          if (t !== 'protoState' || m.projectiles.length) window.__received.push(m);
          if (m.reason === 'testPlace') window.__placed = m;
          return handler?.(m);
        };
      }
    });
    await a.evaluate(id => {
      window.__aimAt = part => {
        const G = window.BREACH, r = G.remotes.get(id), e = window.BREACH_FP.eye;
        if (!r) throw new Error('falta el blanco');
        const dx = r.x - e.x, dy = (r.y ?? 0) + part - e.y, dz = r.z - e.z;
        G.player.cam.yaw = Math.atan2(-dx, -dz);
        G.player.cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      };
      window.__key = (code, down) => {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      };
      // Desde la pulsación hasta la suelta, la página controla el gatillo.
      // Ningún viaje de Playwright puede alargar la ráfaga ni sus posturas.
      window.__hold = (secs, part, crouchKey) => {
        const G = window.BREACH, I = window.BREACH_INPUT, start = G.simClock;
        I.firePressed = true; I._mouseFire = true;
        const tick = () => {
          const elapsed = G.simClock - start;
          if (crouchKey) {
            const down = elapsed >= 0.15 && elapsed < 0.4;
            if (I.keys.has(crouchKey) !== down) window.__key(crouchKey, down);
          }
          if (elapsed >= secs) {
            I._mouseFire = false; I.fireReleased = true;
            return;
          }
          if (part != null) window.__aimAt(part);
          requestAnimationFrame(tick);
        };
        tick();
      };
    }, idB);
    const aim = (part = 1.15) => a.evaluate(h => window.__aimAt(h), part);
    const released = () => until(a, () => !window.BREACH_INPUT._mouseFire, 2);
    const hold = async (secs, part, crouchKey) => {
      await a.evaluate(args => window.__hold(...args), [secs, part, crouchKey]);
      await released();
    };
    const equip = async w => {
      await a.evaluate(w => {
        const W = window.BREACH.weapons;
        if (!W.state[w]) throw new Error('sin arma ' + w);
        if (W.cur !== w) W.startSwap(w);
      }, w);
      return until(a, w => {
        const W = window.BREACH.weapons;
        return W.cur === w && !W.swapping;
      }, 3, w);
    };
    const atRemote = (page, id, x, z, vulnerable) => until(page, ({id,x,z,vulnerable}) => {
      const r = window.BREACH.remotes.get(id);
      return r?.alive && (!vulnerable || !r.inv) && Math.hypot(r.x-x,r.z-z) < 0.08;
    }, 10, {id,x,z,vulnerable});

    const actions = new Set(['fire','rocket','protoFire','nade']);
    const auditRefusals = async expected => {
      // El HTTP puede adelantarse a los recibos FIFO de cualquiera de los dos clientes.
      const deadline = await a.evaluate(() => window.BREACH.simClock + 3);
      let totals, verified;
      do {
        totals = await refusals();
        const counts = await Promise.all([a,b].map(p => p.evaluate(() => window.__discardedStates.size)));
        verified = counts[0] + counts[1];
        if (verified === (totals['state-life'] ?? 0)) break;
        await game(a, 1 / rate);
      } while (await a.evaluate(end => window.BREACH.simClock < end, deadline));
      assert.deepEqual(totals, {...expected, ...(verified ? { 'state-life': verified } : {})}, 'todos los descartes comprobados');
    };
    const run = async (name, fn, { d = 6, kind = 'hit', expectedRefusals = {}, verify } = {}) => {
      console.log(`   ${tag}: ${name}`);
      const r0 = await refusals();
      const need = (ok, message) => { assert.ok(ok, name + ' · ' + message); return true; };
      await playing(a); await playing(b);
      await until(b, () => window.BREACH.selfHp >= 100 && !(window.BREACH.spawnProt > 0), 30);
      need(await a.evaluate(([x,z]) => window.__freeGround(x,z), [spot.x,spot.za+d]), 'destino estable para B');
      await place(a, spot.x, spot.za); await face(a, Math.PI);
      // B ya ve al tirador en la salida antes de ocupar el carril: el cuerpo
      // interpolado de A no puede empujar a B desde el final del slide anterior.
      await atRemote(b, idA, spot.x, spot.za, false);
      await place(b, spot.x, spot.za + d); await face(b, 0);
      await atRemote(a, idB, spot.x, spot.za+d, true);
      const [out, received, marked] = await a.evaluate(() => [window.__sent.length, window.__received.length, window.__claims.length]);
      const remoteStart = await b.evaluate(() => window.__received.length);
      await fn({need});
      // La marca viaja detrás de las acciones de A. El siguiente snapshot
      // incorpora su daño: B empieza el próximo escenario con vida confirmada.
      await a.evaluate(seq => window.BREACH.net.send({t:'testFence', seq}), out);
      await Promise.all([a,b].map(page => until(page, ({id,seq}) =>
        window.__snapFence?.id === id && window.__snapFence.seq === seq,
      3, {id:idA, seq:out})));
      const r1 = await refusals();
      const diff = Object.fromEntries(Object.entries(r1).map(([k,v]) => [k,v-(r0[k] ?? 0)]).filter(([,v]) => v));
      assert.deepEqual(Object.fromEntries(Object.entries(diff).filter(([k]) => k !== 'state-life')),
        expectedRefusals, name + ' · descartes del servidor');
      const sent = await a.evaluate(i => window.__sent.slice(i), out);
      const packets = await a.evaluate(i => window.__received.slice(i), received);
      const remote = await b.evaluate(i => window.__received.slice(i), remoteStart);
      const acts = sent.filter(({m}) => actions.has(m.t));
      const claims = sent.filter(({m}) => m.t === 'hit' && m.target === idB).map(({m}) => [m.sq,m.dmg]);
      const applied = packets.filter(m => m.t === 'testDamage' && m.target === idB);
      const hitscan = applied.filter(m => m.sq != null).map(m => [m.sq,m.dmg]);
      const localDamage = await a.evaluate(([i,id]) => window.__claims.slice(i)
        .filter(c => c.target === id).map(c => [c.sq,c.dmg]), [marked,idB]);
      assert.deepEqual(hitscan, localDamage, name + ' · daño aplicado exacto por tiro, incluso letal');
      assert.deepEqual(hitscan.map(([sq,dmg]) => [sq,Math.round(dmg)]), claims, name + ' · daño entero en el cable');
      if (kind === 'hit') need(claims.length > 0, 'al menos un impacto');
      if (kind === 'pickup') {
        need(sent.some(({m}) => m.t === 'takeSpecial') &&
          packets.some(m => m.t === 'specialTaken' && m.id === idA && m.wep === special), 'recogida confirmada');
      } else need(acts.length > 0, 'acción enviada');
      const localFire = acts.filter(({m}) => m.t === 'fire');
      need(remote.filter(m => m.t === 'fire' && m.id === idA).length === localFire.length, 'cada fire se difundió');
      if (kind === 'auth') {
        need(acts.length === 1 && acts[0].m.t === 'rocket', 'un cohete');
        need(packets.some(m => m.t === 'rocketBoom' && m.id === idA && m.target === idB && m.direct), 'impacto directo en B');
        const expected = evaluateBlast(TUNING.weapons.bazooka,{x:0,y:1,z:0},{x:0,y:0,z:0},
          () => false,{direct:true}).damage; // directo, exposición completa en el carril
        assert.deepEqual(applied.map(m => [m.w,m.dmg]), [['bazooka', expected]]);
      } else assert.deepEqual(applied.filter(m => m.sq == null), [], name + ' · daño sin reclamar en B');
      const rejects = packets.filter(m => ['nadeReject','rocketReject'].includes(m.t));
      need(rejects.length === (expectedRefusals['launch-origin'] ?? 0), 'respuestas de rechazo exactas');
      const result = {acts, packets, sent, claims};
      verify?.(result);
      console.log(`   OK ${name} · intentos ${acts.length} · marcados ${claims.length} · daño reclamado ${claims.reduce((n,c)=>n+c[1],0)} · aplicado ${applied.reduce((n,m)=>n+m.dmg,0)} · rechazos ${JSON.stringify(diff)}`);
      return result;
    };
    const { crouch: crouchB } = await actionKeys(b, 'crouch');
    const lean = spot.wallSide > 0 ? kb.leanLeft : kb.leanRight;

    await equip('smg');
    await run('agacharse/levantarse disparando', async () => {
      await hold(0.6, 1.15, kb.crouch);
      await until(a, () => window.BREACH.player.stanceLow === 0, 1);
    }, {verify: ({acts, sent}) => {
      const down = acts.find(q => q.m.fs?.st === 'crouch' && q.m.fs.ce < 0.5);
      assert.ok(down && sent.some(q => q.m.t === 's' && q.m.st === 'idle' && q.m.n > down.m.fs.n),
        'disparó agachado y volvió a estar de pie');
    }});
    await run('inclinarse hacia el muro', async () => {
      await a.keyboard.down(lean); await game(a, 0.25); await hold(0.4, 1.15); await a.keyboard.up(lean);
    }, {verify: ({acts}) => {
      assert.ok(acts.some(({m}) => -spot.wallSide * m.fs?.cl > 0), 'disparó inclinado hacia el muro');
    }});
    const peek = await run('asomo (agachado + ADS)', async () => {
      assert.ok(low, 'cara LOW con blanco al otro lado');
      await place(b,low.tx,low.tz);
      await atRemote(a,idB,low.tx,low.tz,true);
      await place(a,low.x,low.z);
      await face(a,low.yaw);
      await a.keyboard.down(kb.crouch); await game(a,0.35);
      await a.evaluate(() => { window.BREACH_INPUT._mouseAim = true; });
      await until(a, () => window.BREACH.player.peek > 0.6, 2);
      await hold(0.4, 1.15);
      await a.evaluate(() => { window.BREACH_INPUT._mouseAim = false; });
      await a.keyboard.up(kb.crouch);
    });
    assert.ok(peek.acts.some(({m}) => m.fs?.st === 'crouch' && m.fs.aim && m.fs.ce > 0.6));
    await run('salida de sprint', async (sc) => {
      await a.evaluate(keys => keys.forEach(key => window.__key(key, true)), [kb.forward,kb.sprint]);
      sc.need(await until(a, ({id,keys}) => {
        const G = window.BREACH, p = G.player, distance = G.remotes.get(id).z - p.pos.z;
        if (!(p.state === 'roadie' && p.speed > 6 && distance > 0 && distance <= 4.5)) return false;
        for (const key of keys) window.__key(key, false);
        window.__hold(0.6, 1.15);
        return true;
      }, 3, {id:idB, keys:[kb.sprint,kb.forward]}), 'A sale del sprint a distancia de tiro');
      await released();
    }, { d: 12 });
    await run('esquivar y disparar al terminar', async (sc) => {
      await aim();
      await a.evaluate(({forward,evade}) => {
        window.__key(forward, true);
        window.__key(evade, true); window.__key(evade, false);
      }, kb);
      sc.need(await until(a, key => {
        if (window.BREACH.player.state !== 'dodge') return false;
        window.__key(key, false);
        window.__hold(0.85, 1.15);
        return true;
      }, 1, kb.forward), 'impulso activo');
      await released();
    }, { d: 6, verify: ({acts, sent}) => {
      const entrada = sent.find(({m}) => m.t === 's' && m.st === 'dodge')?.m;
      assert.ok(entrada && acts.length && acts.every(({m}) => m.fs && m.fs.st !== 'dodge' &&
        m.fs.ct >= entrada.ct - entrada.dg + TUNING.dodge.duration + TUNING.weapons.smg.sprintToFire - 0.002),
        'cada tiro tiene una muestra posterior a la frenada y la recuperación');
    }});
    const creditedIn = (scenario, matches) => scenario.acts.some(({m}) =>
      matches(m.fs) && scenario.claims.some(([sq]) => sq === m.sq));

    // A 3 m, 8,84° desde la cadera permiten errar el torso (radio 0,40).
    // Reservar 8 cm para el movimiento del ojo entre el input y el subpaso.
    const maxSpread = spreadFor('smg', {moving:1, sliding:true, sinceSprint:0});
    const shotRange = (STAND.br - 0.08) / Math.tan(maxSpread * Math.PI / 180);
    for (const pauseMs of [0, 400]) {
      const name = pauseMs ? 'pausa de 400 ms a mitad de slide, luego disparar' : 'slide';
      let resumeAt;
      await run(name, async () => {
        const before = await a.evaluate(() => window.__sent.length);
        await until(a, id => {
          const {player:p, weapons:w} = window.BREACH;
          const target = window.BREACH.remotes.get(id);
          return target?.st === 'idle' && !target.aim && p.grounded && p.state === 'idle' && p.slideCd <= 0 &&
            w.cur === 'smg' && w.st.mag > 0 && w.st.cd <= 0 && !w.swapping && !w.reloading;
        }, 3, idB);
        await a.keyboard.down(kb.forward); await a.keyboard.down(kb.sprint);
        try {
          // El flanco se entrega en el cuadro medido: ambos slides entran
          // con la misma distancia restante, independientemente de Playwright.
          await until(a, id => {
            const G = window.BREACH, p = G.player, r = G.remotes.get(id);
            if (p.state !== 'roadie' || p.speed <= 6 || r.z <= p.pos.z || r.z - p.pos.z > 3.4) return false;
            window.BREACH_INPUT.crouchPressed = true;
            return true;
          }, 2, idB);
          if (pauseMs) {
            await until(a, ms => {
              const s = window.BREACH.player.slide;
              if (!s || s.t < 0.15) return false;
              window.__pauseUntil = performance.now() + ms;
              return true;
            }, 1, pauseMs);
            resumeAt = await a.evaluate(() => window.__pauseUntil);
          }
          await until(a, ({id,range,resumeAt}) => {
            const G = window.BREACH, p = G.player, r = G.remotes.get(id);
            if (resumeAt && !window.__sent.some(q => q.at >= resumeAt && q.m.t === 's')) return false;
            if (p.state !== 'slide' || !p.fireAligned()) return false;
            const e = window.BREACH_FP.eye;
            const dx = r.x-e.x, dz = r.z-e.z, dy = r.y+0.85-e.y;
            if (dz <= 0 || Math.hypot(dx,dy,dz) > range) return false;
            p.cam.yaw = Math.atan2(-dx,-dz);
            p.cam.pitch = Math.atan2(dy,Math.hypot(dx,dz));
            window.BREACH_INPUT.firePressed = true;
            return true;
          }, 2, {id:idB, range:shotRange, resumeAt});
          await until(a, i => window.__sent.slice(i).some(q => q.m.t === 'fire'), 1, before);
        } finally {
          await a.keyboard.up(kb.sprint); await a.keyboard.up(kb.forward);
        }
      }, {verify: ({acts, claims, sent}) => {
        assert.equal(acts.length, 1, name + ' · un solo tiro');
        const [{m,at}] = acts;
        assert.ok(m.t === 'fire' && m.w === 'smg' && m.fs.st === 'slide', name);
        assert.ok(claims.some(([sq]) => sq === m.sq), name + ' · daño del tiro en slide');
        if (pauseMs) {
          const poses = sent.filter(q => q.m.t === 's' || q.m.fs);
          const i = poses.findIndex(q => q.at >= resumeAt);
          assert.ok(i > 0 && poses[i].m.t === 's' && poses[i].at - poses[i-1].at >= pauseMs,
            'primer estado tras la pausa real');
          assert.ok(at >= poses[i].at && m.fs.n > poses[i].m.n, 'tiro posterior al estado de reanudación');
        }
      }});
    }
    await run('primer tiro tras cambio de arma', async (sc) => {
      await a.evaluate(() => window.BREACH.weapons.startSwap('pistol'));
      sc.need(await until(a, () => window.BREACH.weapons.cur === 'pistol' && !window.BREACH.weapons.swapping, 2), 'cambio a pistola');
      await hold(0.1, 1.15);
    }, { d: 4 });
    await equip('shotgun');
    const jump = await run('salto desde agachado con escopeta', async () => {
      await a.keyboard.down(kb.crouch);
      const before = await a.evaluate(() => window.__sent.length);
      await until(a, () => {
        const {player:p, weapons:w} = window.BREACH;
        if (!p.grounded || p.stanceLow < 0.99 || !p.fireAligned() || w.st.cd > 0 || w.reloading) return false;
        // El controller salta antes de actualizar el arma en el mismo subpaso.
        window.__aimAt(0.85);
        window.BREACH_INPUT.jumpPressed = window.BREACH_INPUT.firePressed = true;
        return true;
      }, 2);
      await until(a, i => window.__sent.slice(i).some(q => q.m.t === 'fire' && q.m.fs.air === 1), 0.5, before);
      await a.keyboard.up(kb.crouch);
    }, { d: 4 });
    assert.ok(creditedIn(jump, fs => fs.st === 'crouch' && fs.air === 1), 'perdigón acreditado durante el salto desde agachado');
    await equip('smg');
    // C3: golpe con el cuerpo girado respecto a la mirada
    const melee = await run('golpe con el cuerpo girado', async (sc) => {
      await b.keyboard.down(crouchB); await game(b, 0.5);
      sc.need(await place(a, spot.x, spot.za + 4.75), 'A junto a B');
      await aim(0.55);
      // Preparar el ángulo en el subpaso de contacto, después del giro del
      // controller. El selector, la muestra y la acreditación siguen su ruta real.
      await a.evaluate(async id => {
        const {TUNING} = await import('/src/config/tuning.js');
        const G = window.BREACH, p = G.player, update = p.update;
        p.update = function (...args) {
          update.apply(this,args);
          if (this.state !== 'melee' || this.meleeT < TUNING.melee.hitAt) return;
          const target = G.remotes.get(id);
          const bearing = Math.atan2(this.pos.x-target.x, this.pos.z-target.z);
          this.cam.yaw = bearing + 0.60;
          this.yaw = this.cam.yaw + 0.85;
          this.update = update;
        };
      }, idB);
      await a.keyboard.press(kb.melee); await game(a, 0.8);
      await b.keyboard.up(crouchB);
    }, { d: 6 });
    const kick = melee.acts.find(q => q.m.w === 'melee')?.m;
    assert.ok(kick && Math.abs(kick.fs.ae) > 0.75, 'muestra melee con el cuerpo girado');
    const targetYaw = Math.atan2(kick.o[0]-spot.x, kick.o[2]-(spot.za+6));
    assert.ok(Math.cos(targetYaw-kick.fs.yaw) < Math.cos(62*Math.PI/180));
    assert.ok(Math.cos(targetYaw-kick.fs.yaw-kick.fs.ae) >= Math.cos(58*Math.PI/180));
    // C5: lanzar por encima de una cobertura LOW agachado y pegado a ella
    for (const kind of ['grenade', 'frag', 'stun']) {
      const flight = await run(`lanzar ${kind} por encima de LOW, agachado y pegado`, async (sc) => {
        if (!sc.need(!!low, 'hay una cara LOW')) return;
        await place(b, low.spectator.x, low.spectator.z);
        if (kind !== 'grenade') {
          // frag/aturdidora del mapa (pickups de prototipo del servidor)
          const pk = await a.evaluate((k) => (window.BREACH.protoSnapshot?.pickups || []).find((q) => q.kind === k && q.count > 0) ?? null, kind);
          if (!sc.need(!!pk, `pickup de ${kind} en el mapa`)) return;
          sc.need(await place(a, pk.x, pk.z, pk.y), `A llega al pickup de ${kind}`);
          await a.keyboard.press(kb.pickup);
          sc.need(await until(a, (k) => window.BREACH.weapons.state[k]?.mag > 0, 3, kind), `A recoge ${kind}`);
        }
        sc.need(await place(a, low.x, low.z), 'A pegado a la LOW'); await face(a, low.yaw - 1.13, 0.93);
        await a.keyboard.down(kb.crouch); await game(a, 0.4);
        const start = await a.evaluate(() => window.__received.length);
        if (kind === 'grenade') await a.keyboard.press(kb.grenade);
        else { sc.need(await equip(kind), `equipa ${kind}`); await hold(0.1); }
        // Humo y proyectiles se resuelven en el reloj del servidor.
        await until(a, ({start,kind,id}) => {
          const packets = window.__received.slice(start);
          if (kind === 'grenade') return packets.some(m => m.t === 'smokeStart' && m.id === id);
          if (kind === 'frag') return packets.some(m => m.t === 'protoEvent' && m.kind === 'explosion' && m.owner === id);
          return packets.some(m => m.t === 'protoState' && m.projectiles.some(q => q.kind === kind)) &&
            !window.BREACH.protoSnapshot.projectiles.some(q => q.kind === kind);
        }, 5, {start,kind,id:idA});
        await a.keyboard.up(kb.crouch);
      }, { kind: 'throw' });
      const launches = flight.acts.map(q=>q.m);
      assert.equal(launches.length, 1);
      const m = launches[0];
      assert.ok(m.fs.w === kind && m.fs.st === 'crouch' && m.fs.ce < 0.1);
      const side = (x,z) => (x-low.edgeX)*low.nx + (z-low.edgeZ)*low.nz;
      assert.ok(side(m.fs.x,m.fs.z) >= 0.35 && side(m.fs.x,m.fs.z) <= 0.48, 'agachado junto a la cara');
      const far = (x,z) => side(x,z) < -0.05;
      // Cruce por el interior del borde (no alrededor de su extremo).
      const def = TUNING.weapons[kind];
      const speed = kind === 'stun' ? def.projSpeed : def.throwSpeed;
      const v = m.v ?? m.d.map((d,i) => d*speed + (i === 1 ? def.throwUp ?? 0 : 0));
      const inward = -(v[0]*low.nx+v[2]*low.nz);
      assert.ok(inward > 0);
      const t = side(m.o[0],m.o[2])/inward;
      const along = (m.o[0]+t*v[0]-low.edgeX)*low.nz - (m.o[2]+t*v[2]-low.edgeZ)*low.nx;
      const height = m.o[1] + t*v[1] - (kind === 'stun' ? 0 : SMOKE_GRAVITY*t*t/2);
      assert.ok(t >= 0 && Math.abs(along) < low.width/2 && height > low.top, 'vuelo por encima del borde de la cobertura');
      if (kind === 'grenade') {
        const ack = flight.packets.find(p => p.t === 'nadeAck' && p.cid === m.cid);
        assert.ok(ack && flight.packets.some(p => p.t === 'smokeStart' && p.nid === ack.nid && far(p.p[0],p.p[2])), 'el humo llegó al otro lado');
      } else {
        assert.ok(flight.packets.some(p => p.t === 'protoEvent' && p.kind === 'launch' && p.weapon === kind && p.owner === idA && p.cid === m.cid));
        assert.ok(flight.packets.some(p => p.t === 'protoState' &&
          p.projectiles.some(q => q.kind === kind && far(q.x,q.z) && q.y > low.top)), kind + ' sobre la cara');
      }
    }
    await equip('smg');
    // A 2 m incluso el borde del cono de cadera de la SMG quieta cabe en el torso.
    // Un solo impacto en vuelo: la vida del snapshot habilita el siguiente tiro.
    const killA = async (fireOnDeath = false) => {
      await a.evaluate(({killer, fireOnDeath}) => {
        const G = window.BREACH, handlers = G.net.handlers, onDeath = handlers.death;
        window.__sawLocalDeath = false;
        handlers.death = m => {
          onDeath(m);
          if (m.target !== G.net.id || m.from !== killer) return;
          handlers.death = onDeath;
          window.__sawLocalDeath = !G.selfAlive;
          // La ola puede llegar en el mismo cuadro que la muerte. El gatillo de
          // A debe estar pulsado antes de que se procese la reaparición.
          if (fireOnDeath) window.BREACH_INPUT._mouseFire = true;
        };
      }, {killer:idB, fireOnDeath});
      const setup = await b.evaluate(() => ({
        start: window.__received.length, marked: window.__claims.length, deadline: window.BREACH.simClock + 15,
      }));
      const maxRange = (STAND.br - 0.08) / Math.tan(spreadFor('smg') * Math.PI / 180);
      let hpBefore = TUNING.combat.hp + 1;
      for (;;) {
        const result = await b.waitForFunction(({id, start, deadline, hpBefore, maxRange}) => {
          const G = window.BREACH, r = G.remotes.get(id), p = G.player, w = G.weapons;
          if (window.__received.slice(start).some(m => m.t === 'death' && m.target === id && m.from === G.net.id)) return 'death';
          if (G.simClock >= deadline) throw new Error('sin confirmación de muerte de A en 15 s de juego (vida ' + r?.hp + ')');
          if (!r?.alive || r.inv || r.st !== 'idle' || r.aim || !(r.hp > 0 && r.hp < hpBefore)) return false;
          if (p.state !== 'idle' || !p.grounded || w.cur !== 'smg' || w.swapping || w.reloading || w.st.cd > 0) return false;
          const e = window.BREACH_FP.eye, dx = r.x-e.x, dz = r.z-e.z, dy = r.y+0.85-e.y;
          if (Math.hypot(dx, dy, dz) > maxRange) return false;
          p.cam.yaw = Math.atan2(-dx, -dz);
          p.cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          if (!p.fireAligned()) return false;
          window.BREACH_INPUT.firePressed = true;
          return r.hp;
        }, {...setup, id:idA, hpBefore, maxRange}, {polling:'raf'});
        const value = await result.jsonValue();
        await result.dispose();
        if (value === 'death') break;
        hpBefore = value;
      }
      // Esta ráfaga siempre termina en baja. Incluir el último impacto con
      // su daño íntegro aunque a A le quedaran menos puntos de vida.
      const lethal = await b.evaluate(({id,start,marked}) => ({
        applied: window.__received.slice(start).filter(m => m.t === 'testDamage' && m.target === id).map(m => [m.sq,m.dmg]),
        marked: window.__claims.slice(marked).filter(c => c.target === id).map(c => [c.sq,c.dmg]),
      }), {id:idA, start:setup.start, marked:setup.marked});
      assert.ok(lethal.marked.length > 0);
      assert.deepEqual(lethal.applied, lethal.marked, 'daño exacto de B hasta el tiro letal');
      await until(a, () => window.__sawLocalDeath, 3);
    };
    const respawnAfter = oldLife => until(a, old => {
      const G = window.BREACH;
      return G.selfAlive && G.weapons.life > old && window.__received.some(m =>
        m.t === 'respawn' && m.id === G.net.id && m.life === G.weapons.life);
    }, 35, oldLife);
    await run('primer mensaje de la vida = disparo (reaparición real)', async () => {
      const life = await a.evaluate(() => window.BREACH.weapons.life);
      await killA(true);
      await respawnAfter(life);
      await until(a, old => window.__sent.some(q => q.life > old && q.m.t === 'fire'), 3, life);
      const first = await a.evaluate(old => {
        window.BREACH_INPUT._mouseFire = false; window.BREACH_INPUT.fireReleased = true;
        return window.__sent.find(q => q.life > old)?.m;
      }, life);
      assert.ok(first?.t === 'fire' && first.w === 'smg' && first.fs?.w === 'smg');
    }, { d: 2, kind: 'shot' });
    // arma especial de la ronda (del pedestal, recogida de verdad)
    await run(`recoger la especial (${special})`, async (sc) => {
      const S = await a.evaluate(() => { const s = window.BREACH_SPECIALS.active; return s ? { x: s.x, y: s.y, z: s.z, w: s.wep } : null; });
      if (!sc.need(S?.w === special, `pedestal con ${special} (${S?.w})`)) return;
      sc.need(await place(a, S.x + 0.5, S.z, S.y), 'A en el pedestal');
      await a.keyboard.down(kb.pickup);
      sc.need(await until(a, (w) => !!window.BREACH.weapons.state[w], 6, special), `A recoge ${special}`);
      await a.keyboard.up(kb.pickup);
    }, { kind: 'pickup' });
    if (special === 'sniper') {
      await equip('sniper');
      await run('sniper sin mira', async () => {
        await aim(0.85);
        await hold(0.1);
      }, { d: 3, verify: ({acts}) => {
        assert.equal(acts.length, 1);
        const {m} = acts[0];
        assert.ok(m.w === 'sniper' && m.fs.aim === 0 && m.fs.sa === 0, 'tiro de cadera con sniper');
      }});
      // C2: disparo MIENTRAS la mira sube (antes de que entre el scope)
      const rising = await run('sniper durante la subida de la mira', async (sc) => {
        await until(a, () => {
          const w = window.BREACH.weapons;
          return w.cur === 'sniper' && w.st.mag > 0 && !w.reloading && w.st.cd <= 0;
        }, 5);
        await aim(0.85);
        // Pulsar en el mismo cuadro que acredita el umbral: otro viaje de
        // Playwright entre la medida y el click puede dejar entrar el scope.
        const first = await a.evaluate(() => window.__sent.length);
        await until(a, () => {
          // Empezar ADS con el observador instalado: incluso un viaje lento
          // de Playwright no puede saltarse la ventana de la mira.
          window.BREACH_INPUT._mouseAim = true;
          const k = window.BREACH_VM?.fp2?.vm?.scopeIn01?.();
          if (!(k > 0.15 && k < 0.7)) return false;
          window.BREACH_INPUT.firePressed = true;
          return true;
        }, 2);
        await until(a, i => window.__sent.slice(i).some(q => q.m.t === 'fire'), 1, first);
        await a.evaluate(() => { window.BREACH_INPUT._mouseAim = false; });
      }, { d: 3 });
      assert.equal(rising.acts.length, 1);
      const sn = rising.acts[0];
      assert.ok(sn.m.w === 'sniper' && sn.m.fs.aim === 1 && sn.m.fs.sa === 0 && sn.scope > 0 && sn.scope < 0.98);
    } else {
      await equip('bazooka');
      await run('cohete a 3 m en ADS', async () => {
        const start = await a.evaluate(() => {
          window.BREACH_INPUT._mouseAim = true;
          return window.__received.length;
        });
        await until(a, () => window.BREACH.player.aim, 2);
        await hold(0.1, 0.6);
        await a.evaluate(() => { window.BREACH_INPUT._mouseAim = false; });
        await until(a, ({start,id}) => window.__received.slice(start).some(m =>
          (m.t === 'rocketBoom' && m.id === id) || m.t === 'rocketReject'), 3, {start,id:idA});
      }, { d: 3, kind: 'auth' });
    }

    await auditRefusals({});

    // Medir durante el último escenario (sin pausa intencional), incluidos
    // los cuadros de combate y reaparición. Ambos relojes deben avanzar.
    const clockSample = () => a.evaluate(() => ({
      wall: performance.now(), sim: window.BREACH.simClock, frames: window.__frames,
    }));
    const startClock = await clockSample();
    // Control negativo aislado: una suelta real con velocidad inválida da un
    // rechazo real. Retener solo su aplicación local permite entregarlo en una
    // vida posterior sin cambiar el orden del transporte ni inventar un cid.
    await run('rechazo de lanzamiento de la vida anterior tras reaparecer', async () => {
      await equip('grenade');
      const life = await a.evaluate(() => {
        const G = window.BREACH, n = G.net, send = n.send, reject = n.handlers.nadeReject;
        n.send = function(m) {
          if (m.t !== 'nade') return send.call(this,m);
          this.send = send;
          window.__negativeCid = m.cid;
          return send.call(this,{...m,v:[0,0,0]});
        };
        n.handlers.nadeReject = m => {
          if (!window.__negativeCid || m.cid !== window.__negativeCid) return reject(m);
          n.handlers.nadeReject = reject;
          window.__deferredReject = m;
        };
        return G.weapons.life;
      });
      await hold(0.1);
      await until(a, old => {
        const m = window.__deferredReject;
        return m?.reason === 'origin' && m.life === old &&
          window.BREACH.weapons.pendingThrows.includes(m.cid.split(':').pop());
      }, 3, life);
      await killA();
      await respawnAfter(life);
      await equip('grenade');
      // Aplicar la devolución con una suelta NUEVA todavía pendiente, justo
      // antes de procesar su confirmación en el mismo turno del cliente.
      await a.evaluate(() => {
        const {net, weapons: w} = window.BREACH, ack = net.handlers.nadeAck, old = window.__deferredReject;
        net.handlers.nadeAck = m => {
          if (m.id !== net.id || !w.pendingThrows.includes(m.cid?.split(':').pop())) return ack(m);
          net.handlers.nadeAck = ack;
          const before = w.state.grenade.mag, pending = w.pendingThrows;
          net.handlers.nadeReject(old);
          if (m.cid === old.cid || before !== 1 || w.state.grenade.mag !== before ||
              pending.length !== 1 || w.pendingThrows[0] !== pending[0] || w.pendingThrows.length !== 1)
            throw new Error('la devolución antigua alteró la suelta nueva');
          ack(m);
          window.__verifiedAck = m.cid;
        };
      });
      await hold(0.1);
      await until(a, () => window.__verifiedAck && window.BREACH.weapons.state.grenade.mag === 1 &&
        !window.BREACH.weapons.pendingThrows.length && window.__sent.some(q => q.m.t === 'nade' &&
          q.life === window.BREACH.weapons.life && q.m.cid === window.__verifiedAck), 3);
    }, {d: 2, kind: 'throw', expectedRefusals: {'launch-origin': 1}});
    await auditRefusals({'launch-origin': 1});
    check(`${tag}: el proxy no desordena (${stats.delivered} mensajes)`, stats.reordered === 0, String(stats.reordered));
    await a.waitForFunction(t => performance.now() - t >= 3000, startClock.wall);
    const endClock = await clockSample();
    const seconds = (endClock.wall - startClock.wall) / 1000;
    const ratio = (endClock.sim - startClock.sim) / seconds;
    const hz = (endClock.frames - startClock.frames) / seconds;
    check(`${tag}: frecuencia real ${hz.toFixed(1)} c/s`, Math.abs(hz-rate) < rate*0.1);
    check(`${tag}: el juego corre a tiempo real (juego/real ${ratio.toFixed(2)})`, ratio > 0.9 && ratio < 1.1);
    check(`${tag}: sin errores de página`, errors === 0, String(errors));
  } finally {
    await browser?.close();
    proxy?.close();
    server.kill();
  }
}

for (const seed of SEEDS) for (const rate of RATES) for (const special of SPECIALS) {
  try { await runAt(rate, seed, special); }
  catch (err) { check(`${rate} c/s · ${seed} · ${special}`, false, err.stack); }
}
console.log(fails.length ? `FALLAN ${fails.length}: ${fails.slice(0, 12).join(' | ')}${fails.length > 12 ? ' …' : ''}` :
  fullMatrix ? 'FPS HONEST MATRIX OK' : 'FPS HONEST MATRIX · selección parcial OK');
process.exit(fails.length ? 1 : 0);
