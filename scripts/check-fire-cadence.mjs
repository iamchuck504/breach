// Propiedad de la puerta de cadencia del servidor (server/guards.js) sobre
// ventanas MÓVILES, contra la regla de HEAD (intervalo ≥ 82 % del nominal):
// - honesto: Weapons real a 60 Hz con ráfagas y pausas aleatorias, estados a
//   20 Hz, un solo TCP (orden conservado), latencia 40 ms ± 30 ms de jitter y
//   atascos aleatorios de 100–400 ms. Rechazo honesto mucho menor que HEAD.
// - adversario: máximo ritmo, silencio-y-volcado, armas alternadas con `w`
//   falsificado y `sq` repetido/atrasado. En TODA ventana de 100/200/400/
//   1000 ms el máximo de tiros aplicados ≤ lo que permitía HEAD.
// Imprime la tabla. Determinista (PRNG con semilla), sin reloj de pared.
import assert from 'node:assert/strict';
import { Weapons } from '../src/combat/weapons.js';
import { TUNING } from '../src/config/tuning.js';
import * as G from '../server/guards.js';
import { NetClient } from '../src/net/client.js';
import { Controller } from '../src/player/controller.js';
import { sprintFireOk } from '../src/combat/fire-gates.js';

const W = TUNING.weapons;
const WIN = [0.1, 0.2, 0.4, 1];
const iv = (w) => 60 / W[w].rpm;
// HEAD: un solo lastFireAt global medido con el intervalo del arma actual
const HEAD = {
  note() {},
  allow: (e, w, t) => t - (e.last ?? -Infinity) >= iv(w) * 0.82,
  commit: (e, w, t) => { e.last = t; },
};
const NEW = {
  note: G.noteMessageArrival,
  allow: (e, w, t, m) => G.fireCadenceAllows(e, w, iv(w), t, { requireSwapEvidence: true, ...m }),
  commit: (e, w, t, m) => G.commitFireCadence(e, w, iv(w), t, { requireSwapEvidence: true, ...m }),
};

// Una ráfaga empieza en el primer subpaso del cuadro largo. En el cable
// ese tiro sale al final del cuadro; los siguientes ya salen a 30/60 c/s.
for (const rate of [30, 60]) for (const frameMs of [100, 175, 250]) {
  const w = new Weapons(), player = { fps: true };
  w.online = true;
  let wall = 0, ct = 0, arrival = 0, shots = 0, stateTime = 0;
  const deliver = delay => {
    arrival = Math.max(arrival, wall + delay);
    G.noteMessageArrival(player, arrival);
    G.advanceCadenceClock(player, +ct.toFixed(3), arrival);
  };
  deliver(0);
  for (let frame = 0; frame <= rate; frame++) {
    const elapsed = frame ? 1 / rate : frameMs / 1000;
    wall += elapsed;
    for (let left = Math.min(elapsed, 0.1); left > 1e-6;) {
      const step = Math.min(left, 1/30);
      ct += step; left -= step; stateTime += step;
      if (w.update(step, true, false, true, true, left)) {
        // 60 ms para el primer tiro y 0 para los siguientes, siempre FIFO.
        deliver(shots ? 0 : 0.06);
        const meta = { sq: ++shots };
        assert.ok(G.srvBurstAllows(player, 'smg', iv('smg'), arrival),
          `ráfaga honesta rechazada: cuadro de ${frameMs} ms a ${rate} c/s, tiro ${shots}`);
        assert.ok(G.fireCadenceAllows(player, 'smg', iv('smg'), player.cclk, meta));
        G.commitSrvBurst(player, 'smg', arrival);
        G.commitFireCadence(player, 'smg', iv('smg'), player.cclk, meta);
      }
      if (stateTime >= 1 / TUNING.net.sendHz) {
        deliver(0); stateTime %= 1 / TUNING.net.sendHz;
      }
    }
  }
  assert.equal(shots, 11, 'un segundo de fuego sostenido tras el cuadro largo');
  assert.equal(w.st.mag, W.smg.mag - shots);
}
console.log('OK  SMG en línea: cuadros de 100/175/250 ms, 30/60 c/s, difusión FIFO con jitter de 60 ms');

// La transición publica la última postura del sprint al final de un cuadro
// de 100 ms. Aun llegando 60 ms tarde, debe permitir el primer tiro honesto.
{
  const world = { groundHeight: () => 0, resolveCircle() {}, raycast: () => null };
  const cam = { yaw: 0, pitch: 0, flatForward: () => ({x:0,z:-1}), flatRight: () => ({x:1,z:0}) };
  const p = new Controller(world, cam);
  p.respawn({x:0,z:0,yaw:0});
  p.state = 'roadie';
  const input = { moveVec: () => ({x:0,z:0}) };
  let wall = 0.1;
  for (let i = 0; i < 3; i++) p.update(1/30, input, true, (2-i)/30);
  while (!p.fireAligned() && wall < 0.5) {
    p.update(1/60, input, true);
    wall += 1/60;
  }
  assert.ok(p.fireAligned() && sprintFireOk(0.16, wall, 'smg'), 'recuperación tras el sprint entre envíos reales');
}

const maxIn = (times, w) => {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i] - times[j] >= w - 1e-9) j++; best = Math.max(best, i - j + 1); }
  return best;
};

let seed = 20261120;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function honestStream(wep, seconds, { stallRate = 0.3, jitter = 0.03 } = {}) {
  const w = new Weapons(); w.infinite = true;
  if (!w.state[wep]) { w.slots[0] = wep; w.state[wep] = w._freshState(wep); }
  w.cur = wep;
  const out = []; let sq = 0, nextState = 0, holdUntil = 0, pauseUntil = 0, held = false;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    if (held && t >= holdUntil) { held = false; pauseUntil = t + 0.2 + rnd() * 1.3; }
    if (!held && t >= pauseUntil) { held = true; holdUntil = t + 0.3 + rnd() * 2.7; }
    w.st.mag = 999;
    if (!held) w.dropCadenceCredit();
    if (w.update(1 / 60, held && W[wep].auto, held && !W[wep].auto, true)) out.push({ t, shot: true, sq: ++sq });
    if (t >= nextState) { out.push({ t, shot: false }); nextState += 0.05; }
  }
  // red: atascos aleatorios (≈0.3 por segundo, 100–400 ms) y jitter ±30 ms
  const stalls = [];
  for (let t = 0; t < seconds; t += 1) if (rnd() < stallRate) { const s = t + rnd(); stalls.push([s, s + 0.1 + rnd() * 0.3]); }
  let prev = -Infinity;
  return out.map((m) => {
    let a = m.t + 0.04 + (rnd() * 2 - 1) * jitter;
    for (const [s, e] of stalls) if (m.t >= s && m.t < e) a = Math.max(a, e + 0.04);
    prev = Math.max(prev, a);
    return { ...m, a: prev };
  });
}
function runHonest(g, wep, stream) {
  const e = {}; let n = 0, rej = 0;
  for (const m of stream) {
    g.note(e, m.a); if (!m.shot) continue; n++;
    // el arma no cambia en este flujo: su `w` se publicó al empezar
    const meta = { sq: m.sq, wAt: -10, wWeapon: wep };
    if (g.allow(e, wep, m.a, meta)) g.commit(e, wep, m.a, meta); else rej++;
  }
  return 100 * rej / n;
}

// adversarios: devuelven los instantes de tiros APLICADOS
function greedy(g, plan, seconds = 30) {
  const e = {}, applied = []; let sq = 0, wep = plan.weapons[0], wAt = -10;
  for (let t = 0; t < seconds; t += 0.0005) {
    if (plan.silent?.(t)) continue;
    g.note(e, t);
    let meta = { sq: sq + 1, wAt, wWeapon: wep };
    if (g.allow(e, wep, t, meta)) { g.commit(e, wep, t, meta); sq++; applied.push(t); continue; }
    if (plan.replay && sq > 0) { // repetir/atrasar el sq de un tiro ya aceptado
      const old = { sq: sq - (sq > 1 && rnd() < 0.5 ? 1 : 0), wAt, wWeapon: wep };
      if (g.allow(e, wep, t, old)) { g.commit(e, wep, t, old); applied.push(t); }
    }
    if (plan.weapons.length > 1) { // alternar arma: publicar un `w` nuevo y reintentar
      const other = plan.weapons[(plan.weapons.indexOf(wep) + 1) % plan.weapons.length];
      meta = { sq: sq + 1, wAt, wWeapon: wep };
      if (!g.allow(e, wep, t, meta)) { wep = other; wAt = t; }
    }
  }
  return applied;
}

const rows = [];
let failures = 0;
for (const wep of ['smg', 'pistol', 'shotgun', 'sniper']) {
  const secs = wep === 'smg' ? 600 : 1200;
  const honest = honestStream(wep, secs);
  const hNew = runHonest(NEW, wep, honest), hHead = runHonest(HEAD, wep, honest);
  const jit = honestStream(wep, secs, { stallRate: 0 }), clean = honestStream(wep, secs, { stallRate: 0, jitter: 0 });
  const jNew = runHonest(NEW, wep, jit), jHead = runHonest(HEAD, wep, jit);
  const cNew = runHonest(NEW, wep, clean), cHead = runHonest(HEAD, wep, clean);
  const advs = {
    'máximo ritmo': { weapons: [wep] },
    'silencio y volcado': { weapons: [wep], silent: (t) => t % 0.9 < 0.35 },
    'silencio 300 ms': { weapons: [wep], silent: (t) => t % 0.7 < 0.3 },
    'armas alternadas': { weapons: wep === 'pistol' ? ['pistol', 'smg'] : [wep, 'pistol'] },
    'sq repetido': { weapons: [wep], replay: true },
    // arma → cohete → arma: el cohete comparte horario y evidencia de cambio
    'cohete intercalado': { weapons: [wep, 'bazooka'] },
  };
  for (const [name, plan] of Object.entries(advs)) {
    const tn = greedy(NEW, plan), th = greedy(HEAD, plan);
    const nw = WIN.map((w) => maxIn(tn, w)), hd = WIN.map((w) => maxIn(th, w));
    // techo de HEAD para una sola arma en cada ventana (regla del 82 %)
    const ceil = WIN.map((w) => Math.max(hd[WIN.indexOf(w)], G.fireWindowCap(w, Math.min(...plan.weapons.map(iv)))));
    const ok = nw.every((v, i) => v <= ceil[i]);
    if (!ok) failures++;
    rows.push({ wep, adv: name, nuevo: nw.join('/'), head: hd.join('/'), ok });
  }
  // honesto: limpio sin pérdidas; con jitter ±30 ms solo se pierde, como en
  // HEAD, la pareja de apertura comprimida (≤ 1/3 de lo que perdía HEAD); con atascos
  // (0.3/s, 100–400 ms: red mala a propósito) se pierden solo los tiros que
  // el tope de ventana descarta, siempre bastante menos que HEAD
  const okC = cNew <= cHead && cNew < 0.1, okJ = jNew <= jHead / 3 || jNew < 0.5, okS = hNew <= hHead * 0.65 || hNew < 0.5;
  rows.push({ wep, adv: 'HONESTO limpio %', nuevo: cNew.toFixed(2), head: cHead.toFixed(2), ok: okC });
  rows.push({ wep, adv: 'HONESTO jitter ±30 %', nuevo: jNew.toFixed(2), head: jHead.toFixed(2), ok: okJ });
  rows.push({ wep, adv: 'HONESTO jitter+atascos %', nuevo: hNew.toFixed(2), head: hHead.toFixed(2), ok: okS });
  failures += [okC, okJ, okS].filter((v) => !v).length;
}
console.log('arma     caso                  nuevo(100/200/400/1000 ms)   HEAD');
for (const r of rows) console.log(`${r.ok ? 'OK ' : 'FAIL'} ${r.wep.padEnd(8)} ${r.adv.padEnd(22)} ${String(r.nuevo).padEnd(28)} ${r.head}`);
// Bot alojado con cargador real: un host que dispara a máximo ritmo no pasa
// de un cargador sin la pausa de recarga (cota: ciclos de 50 + recarga).
{
  const e = { bot: true, ammoBudget: G.createAmmoBudget() }; let n = 0, sq = 0;
  for (let t = 0; t < 10; t += 0.0005) {
    const m = { sq: sq + 1, wAt: -10, requireSwapEvidence: true };
    if (G.fireCadenceAllows(e, 'smg', iv('smg'), t, m) && G.consumeShotAmmo(e, 'smg', t)) { G.commitFireCadence(e, 'smg', iv('smg'), t, m); sq++; n++; }
  }
  const d = W.smg, cycle = (d.mag - 1) * iv('smg') * 0.82 + d.reloadTime - G.BOT_RELOAD_TOL;
  const bound = d.mag * Math.ceil(10 / cycle);
  assert.ok(n <= bound, `bot SMG: ${n} tiros en 10 s (cota ${bound})`);
  console.log(`OK  bot alojado SMG a máximo ritmo: ${n} tiros en 10 s (cota de cargador ${bound}; sin cargador serían ${Math.floor(10 / (iv('smg') * 0.82))})`);
  // escopeta: un cartucho por cada reloadTime de silencio
  const s2 = { bot: true, ammoBudget: G.createAmmoBudget() };
  // (solo munición: la cadencia va aparte) vaciar el cargador de golpe
  for (let i = 0; i < W.shotgun.mag; i++) assert.ok(G.consumeShotAmmo(s2, 'shotgun', i * 0.05));
  const t8 = (W.shotgun.mag - 1) * 0.05;
  assert.equal(G.consumeShotAmmo(s2, 'shotgun', t8 + 0.2), false, 'escopeta de bot sin cartucho insertado');
  assert.equal(G.consumeShotAmmo(s2, 'shotgun', t8 + W.shotgun.reloadTime), true, 'un cartucho tras su ciclo');
  assert.equal(G.consumeShotAmmo(s2, 'shotgun', t8 + W.shotgun.reloadTime + 0.05), false, 'dos cartuchos con el tiempo de uno');
  console.log('OK  bot alojado escopeta: cartucho a cartucho');
}

// Cambio de arma: hace falta EVIDENCIA de ESTA arma (el `w` replicado pasó a
// ser esta arma después del último tiro con otra, y hace ≥ 0.1 s), no solo
// tiempo transcurrido ni el cambio de otra arma.
{
  const m = (wAt, w, extra = {}) => ({ wAt, wWeapon: w, requireSwapEvidence: true, ...extra });
  const e = {};
  G.commitFireCadence(e, 'smg', iv('smg'), 0, m(-5, 'smg'));
  assert.equal(G.fireCadenceAllows(e, 'sniper', iv('sniper'), 2, m(-5, 'smg')), false, 'sniper sin cambio de arma publicado');
  assert.equal(G.fireCadenceAllows(e, 'sniper', iv('sniper'), 0.56, m(0.275, 'sniper')), true, 'cambio honesto (0.55 s) bloqueado');
  assert.equal(G.fireCadenceAllows(e, 'sniper', iv('sniper'), 0.35, m(0.3, 'sniper')), false, 'disparo a 0.05 s del cambio');
  // adversario: el cambio publicado fue a OTRA arma (escopeta) y dispara cohete
  assert.equal(G.fireCadenceAllows(e, 'bazooka', iv('bazooka'), 0.8, m(0.3, 'shotgun')), false,
    'cohete usando el instante de cambio de un arma de fuego');
  // adversario: recogida NO relacionada (sniper) y disparo inmediato de escopeta
  assert.equal(G.fireCadenceAllows(e, 'shotgun', iv('shotgun'), 0.1, m(0.05, 'sniper', { wInstant: true })), false,
    'una recogida de otra arma autorizó un disparo inmediato');
  // HEAD habría exigido 0.82·intervalo (≈518 ms para la escopeta) y nosotros ≥ eso sin evidencia
  for (let t = 0.05; t < 3; t += 0.05) {
    assert.equal(G.fireCadenceAllows(e, 'shotgun', iv('shotgun'), t, m(-5, 'smg')), false, `escopeta sin evidencia a ${t.toFixed(2)} s`);
  }
  // la recogida de ESTA arma vale una sola vez
  const e3 = {};
  G.commitFireCadence(e3, 'smg', iv('smg'), 5, m(-5, 'smg'));
  const pick = m(5.01, 'sniper', { wInstant: true });
  assert.equal(G.fireCadenceAllows(e3, 'sniper', iv('sniper'), 5.02, pick), true, 'tiro inmediato tras recoger la especial');
  G.commitFireCadence(e3, 'sniper', iv('sniper'), 5.02, pick);
  assert.equal(e3.wInstant, false, 'la recogida no se consumió');
  // Cliente REAL: arma nueva publicada en el primer estado (20 Hz) tras la
  // mitad del gesto y disparo al terminarlo (0.55 s, primer cuadro a 60 Hz),
  // con ±30 ms de jitter y orden TCP: ningún rechazo en 20 000 cambios.
  let rej = 0;
  for (let k = 0; k < 20000; k++) {
    const e2 = {}, T = 10 + k * 3 + rnd() * 0.05;
    G.commitFireCadence(e2, 'smg', iv('smg'), T - 0.01, m(-5, 'smg'));
    const stateSend = Math.ceil((T + 0.275) / 0.05) * 0.05, fireSend = Math.ceil((T + 0.55) * 60) / 60;
    const wAt = stateSend + 0.04 + (rnd() * 2 - 1) * 0.03;
    const fireAt = Math.max(wAt, fireSend + 0.04 + (rnd() * 2 - 1) * 0.03);
    const to = ['shotgun', 'sniper', 'bazooka'][k % 3];
    if (!G.fireCadenceAllows(e2, to, iv(to), fireAt, m(wAt, to))) rej++;
  }
  assert.equal(rej, 0, `${rej} cambios de arma honestos rechazados`);
  console.log('OK  cambio de arma: evidencia de ESTA arma; recogida ajena y cambio ajeno rechazados; 0/20000 cambios honestos rechazados');
}

// Hueco mínimo entre ARMAS DISTINTAS, todos los pares ordenados. "honesto" =
// lo más pronto que el CLIENTE puede encadenarlos, derivado aquí paso a paso
// de su máquina de estados (weapons.js, main.js, controller.js) a 60 y 144 Hz;
// "ahora" = hueco mínimo que acepta la puerta a un adversario con evidencia de
// cambio publicada al instante; HEAD = su puerta global (0 para proyectiles,
// que no tenían puerta cruzada). El suelo nunca rechaza a un honesto: se
// comprueba con 20 000 secuencias por par (±30 ms, atascos de 200 ms).
{
  const ml = TUNING.melee, gr = W.grenade, SW = 0.55;
  const thrown = (w) => w === 'grenade' || w === 'frag';
  const ivOf = (w) => (w === 'melee' ? 0.4 : iv(w));
  // pasos del cliente a `hz` entre la acción A (mensaje) y la B (mensaje)
  const clientGap = (a, b, held, hz) => {
    const dt = 1 / hz, st = (t) => Math.ceil(t / dt - 1e-9) * dt;
    // cambio: arranca en el paso de A, dura SW, el paso final no dispara
    const swapAct = (w) => st(SW) + dt + (thrown(w) ? st(gr.throwRelease) : 0);
    if (b === 'melee') return (thrown(a) ? st(gr.throwTime - gr.throwRelease) : dt) + st(ml.hitAt);
    if (a === 'melee') {
      const rec = st(ml.hitStop) + st(ml.hitRecovery); // golpe conectado: congelación + recovery
      return rec + (b === held ? (thrown(b) ? st(gr.throwRelease) : 0) : swapAct(b));
    }
    return swapAct(b); // tras un arrojadizo el cambio a la primaria es automático en la suelta
  };
  const weps = ['smg', 'shotgun', 'sniper', 'melee', 'grenade', 'frag', 'stun', 'bazooka'];
  const rows = [];
  for (const a of weps) for (const b of weps) {
    if (a === b) continue;
    for (const held of a === 'melee' ? [b, 'smg' === b ? 'shotgun' : 'smg'] : [a]) {
      if (a === 'melee' && b === 'melee') continue;
      const tag = a === 'melee' ? (held === b ? ' (en mano)' : ' (guardada)') : '';
      // límite continuo (los cuadros solo alargan): la cota inferior honesta
      const honest = clientGap(a, b, held, 1e6);
      // adversario: B con su evidencia publicada en t=0 (o arma ya en mano)
      const e = {};
      const prior = a === 'melee' ? held : a;
      if (prior !== 'melee') G.commitFireCadence(e, prior, ivOf(prior), -10, { wAt: -20, wWeapon: prior, requireSwapEvidence: true });
      G.commitFireCadence(e, a, ivOf(a), 0, { wAt: -20, wWeapon: a === 'melee' ? held : a, requireSwapEvidence: true });
      const metaB = { wAt: b === 'melee' || b === held ? -20 : 0.0005, wWeapon: b === 'melee' ? (a === 'melee' ? held : a) : b, requireSwapEvidence: true };
      let now = Infinity;
      for (let t = 0.001; t < 3; t += 0.001) {
        const m = { ...metaB, wAt: metaB.wAt === 0.0005 ? Math.min(t - G.FIRE_SWAP_EVIDENCE, 0.0005) : metaB.wAt };
        if (G.fireCadenceAllows(e, b, ivOf(b), t, m)) { now = t; break; }
      }
      const head = (b === 'melee' || ['smg', 'shotgun', 'sniper', 'pistol'].includes(b)) ? 0.82 * ivOf(b) : 0;
      rows.push({ pair: `${a}→${b}${tag}`, honest, now, head, a, b, held });
      assert.ok(now <= honest + 1e-9, `${a}→${b}${tag}: el suelo (${now}) supera lo honesto (${honest})`);
      assert.ok(now >= honest - G.FIRE_NET_TOL - 0.0015, `${a}→${b}${tag}: suelo ${now} por debajo de honesto − tolerancia`);
    }
  }
  console.log('par                       honesto  ahora   HEAD');
  for (const r of rows) console.log(`${r.pair.padEnd(26)}${r.honest.toFixed(3)}   ${r.now.toFixed(3)}   ${r.head.toFixed(3)}`);

  // honestos a tiempo real: ±30 ms de jitter, orden TCP, estados a 20 Hz.
  // `withStall`: además un atasco de 200 ms DENTRO del cambio (informativo:
  // el suelo cruzado no da crédito de atasco a propósito)
  const runHonest = (withStall) => { let worst = 0, total = 0, rejTotal = 0;
  for (const r of rows) {
    let rej = 0;
    for (let k = 0; k < 20000; k++) {
      const hz = k % 2 ? 60 : 144, t0 = 10 + k * 4;
      const gap = clientGap(r.a, r.b, r.held, hz);
      const tA = t0, tB = t0 + gap;
      // instante en que el cliente publica el arma B (estado tras el cambio de modelo)
      const swapStart = r.a === 'melee' ? tA + (gap - clientGap(r.a, r.held === r.b ? r.b : r.b, r.b, hz)) : tA;
      const publish = (start) => Math.ceil((start + SW / 2) / 0.05) * 0.05;
      const needsSwap = r.b !== 'melee' && !(r.a === 'melee' && r.held === r.b);
      const wSend = needsSwap ? publish(r.a === 'melee' ? tA + st0(r) : (thrown(r.a) ? tA : tA)) : null;
      const msgs = [];
      for (let t = tA - 0.5; t < tB + 0.3; t += 0.05) msgs.push({ t, kind: 'state', w: needsSwap && t >= wSend - 1e-9 ? r.b : null });
      msgs.push({ t: tA, kind: 'A' }, { t: tB, kind: 'B' });
      msgs.sort((x, y) => x.t - y.t);
      const stall = withStall ? tA - 0.15 + rnd() * (tB - tA) : null;
      let prev = -Infinity;
      for (const m of msgs) {
        let a = m.t + 0.04 + (rnd() * 2 - 1) * 0.03;
        if (stall !== null && m.t >= stall && m.t < stall + 0.2) a = Math.max(a, stall + 0.2 + 0.04);
        prev = Math.max(prev, a); m.a = prev;
      }
      const e = {};
      const prior = r.a === 'melee' ? r.held : r.a;
      if (prior !== 'melee') G.commitFireCadence(e, prior, ivOf(prior), tA - 5, { wAt: -20, wWeapon: prior, requireSwapEvidence: true });
      let wAt = -20, wSeq, ok = true;
      for (const m of msgs) {
        G.noteMessageArrival(e, m.a);
        // como server.js: orden de llegada y el silencio del atasco descontado
        if (m.kind === 'state' && m.w && wAt < 0) { wAt = m.a; wSeq = e.msgSeq; }
        if (m.kind === 'A') G.commitFireCadence(e, r.a, ivOf(r.a), m.a, { wAt: -20, wWeapon: r.a === 'melee' ? r.held : r.a, requireSwapEvidence: true });
        if (m.kind === 'B') ok = G.fireCadenceAllows(e, r.b, ivOf(r.b), m.a,
          { wAt: needsSwap ? wAt : -20, wSeq: needsSwap ? wSeq : undefined, wWeapon: r.b === 'melee' ? (r.a === 'melee' ? r.held : r.a) : (needsSwap ? r.b : r.b), requireSwapEvidence: true });
      }
      if (!ok) rej++;
    }
    worst = Math.max(worst, rej); total += 20000; rejTotal += rej;
    if (!withStall) assert.equal(rej, 0, `${r.pair}: ${rej}/20000 secuencias honestas rechazadas`);
  }
  return { worst, rate: 100 * rejTotal / total }; };
  runHonest(false);
  const st = runHonest(true);
  console.log(`INFO honestos con un atasco de 200 ms dentro del cambio: ${st.rate.toFixed(2)} % rechazados (peor par ${(100 * st.worst / 20000).toFixed(1)} %)`);
  // adversario que calla 300 ms antes de A y apila B: el suelo se mantiene
  for (const [a, b, held, want] of [['smg', 'shotgun', 'smg', 0.49], ['melee', 'shotgun', 'shotgun', 0.235], ['melee', 'shotgun', 'smg', 0.785]]) {
    const e = {};
    G.commitFireCadence(e, held, ivOf(held), -10, { wAt: -20, wWeapon: held, requireSwapEvidence: true });
    G.noteMessageArrival(e, -9); G.noteMessageArrival(e, 0); // 9 s de silencio justo antes de A
    G.commitFireCadence(e, a, ivOf(a), 0, { wAt: -20, wWeapon: a === 'melee' ? held : a, requireSwapEvidence: true });
    let first = Infinity;
    for (let t = 0.001; t < 2; t += 0.001) {
      const m = { wAt: b === held ? -20 : 0.001, wSeq: b === held ? undefined : e.msgSeq + 1, wWeapon: b, requireSwapEvidence: true };
      if (G.fireCadenceAllows(e, b, ivOf(b), t, m)) { first = t; break; }
    }
    assert.ok(first >= want - 0.0015, `silencio y apilado ${a}→${b}: ${first} < ${want}`);
    console.log(`OK  silencio y apilado ${a}→${b}${a === 'melee' ? (b === held ? ' (en mano)' : ' (guardada)') : ''}: primer B aceptado a ${first.toFixed(3)} s (suelo ${want})`);
  }
  function st0(r) { // patada → arma guardada: el cambio arranca al salir de melee
    return Math.ceil(TUNING.melee.hitStop * 60) / 60 + Math.ceil(TUNING.melee.hitRecovery * 60) / 60;
  }
  console.log(`OK  honestos: ${rows.length} pares × 20000 (±30 ms de jitter) — 0 rechazados`);
}

// Recoger de nuevo una especial agotada en la misma vida: cargador nuevo
{
  for (const w of ['sniper', 'bazooka']) {
    const b = { bot: true, ammoBudget: G.createAmmoBudget() };
    G.grantWeaponAmmo(b, w);
    let t = 1;
    while (G.consumeShotAmmo(b, w, t)) t += W[w].reloadTime + 0.1;
    assert.equal(b.ammoBudget[w], 0, `${w}: agotada`);
    G.grantWeaponAmmo(b, w); // segunda recogida
    assert.equal(G.consumeShotAmmo(b, w, t + 0.01), true, `${w}: recogida de nuevo y sin poder disparar`);
  }
  // caja de munición: cargadores normales llenos al instante
  const b = { bot: true, ammoBudget: G.createAmmoBudget() };
  for (let i = 0; i < W.smg.mag; i++) G.consumeShotAmmo(b, 'smg', i * 0.1);
  G.refillNormalAmmo(b);
  assert.equal(G.consumeShotAmmo(b, 'smg', W.smg.mag * 0.1), true, 'caja de munición sin cargador lleno');
  console.log('OK  bot: especial re-recogida y caja de munición dan cargador nuevo');
}

// Un host lento envía juntos subpasos distintos. Reproducir los intervalos
// de llegada observados en CI y comprobar también el límite de ráfaga real.
{
  const host = new NetClient();
  const point = { x: 0, y: 1, z: 0 };
  let message;
  host.send = m => { message = m; };
  const fire = (bot, ct, arrival) => {
    host.botFire('b1', point, point, 'smg', [], { simTime: ct });
    assert.equal(message.ct, ct);
    G.advanceCadenceClock(bot, message.ct, arrival);
    const meta = { scheduleNow: bot.cclk };
    if (!G.fireCadenceAllows(bot, 'smg', iv('smg'), arrival, meta)) return false;
    G.commitFireCadence(bot, 'smg', iv('smg'), arrival, meta);
    return true;
  };
  const bot = { bot: true };
  assert.ok(fire(bot, 1, 10));
  assert.ok(fire(bot, 1.117, 10.071));
  assert.ok(fire(bot, 1.233, 10.159));
  const grouped = { bot: true };
  assert.ok(fire(grouped, 1, 20));
  assert.ok(fire(grouped, 1.117, 20));
  assert.equal(fire(grouped, 1.233, 20), false);
  assert.equal(grouped.lastRejectReason, 'window');
  console.log('OK  bot alojado: tiros honestos separados por subpasos y tope de ráfaga por llegada');
}

// Bot alojado: sniper y bazooka también con cargador y recarga
{
  for (const [w, mag] of [['sniper', W.sniper.mag], ['bazooka', W.bazooka.mag]]) {
    const b = { bot: true, ammoBudget: G.createAmmoBudget() };
    G.grantWeaponAmmo(b, w);
    for (let i = 0; i < mag; i++) assert.ok(G.consumeShotAmmo(b, w, 1 + i * 0.01), `${w}: cargador inicial`);
    const last = 1 + (mag - 1) * 0.01;
    assert.equal(G.consumeShotAmmo(b, w, last + 0.5), false, `${w} de bot más allá del cargador sin recargar`);
    assert.equal(G.consumeShotAmmo(b, w, last + W[w].reloadTime - G.BOT_RELOAD_TOL), true, `${w} tras su recarga (holgura ${G.BOT_RELOAD_TOL} s)`);
  }
  // la holgura es la misma para todas: SMG vacía no recarga antes de 1.90 − 0.15 s
  const b = { bot: true, ammoBudget: G.createAmmoBudget() };
  for (let i = 0; i < W.smg.mag; i++) G.consumeShotAmmo(b, 'smg', i * 0.1);
  const last = (W.smg.mag - 1) * 0.1;
  assert.equal(G.consumeShotAmmo(b, 'smg', last + W.smg.reloadTime - G.BOT_RELOAD_TOL - 0.02), false, 'SMG recargada antes de tiempo');
  assert.equal(G.consumeShotAmmo(b, 'smg', last + W.smg.reloadTime - G.BOT_RELOAD_TOL), true);
  console.log(`OK  bot alojado: sniper/bazooka con cargador; holgura de host ${G.BOT_RELOAD_TOL} s igual para todas las armas`);
}
assert.equal(failures, 0, `${failures} filas fuera de la propiedad`);
console.log('FIRE CADENCE OK — honesto mejor que HEAD, adversario ≤ HEAD en toda ventana');
