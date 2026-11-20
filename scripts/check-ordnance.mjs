// Munición y cadencia sin reloj de pared (pasos fijos):
// - espoleta offline de cohetes: nunca el tirador, su bando ni un cuerpo
//   protegido, y barrida sobre el segmento del paso (un tirón de 2.6 m no
//   atraviesa a un enemigo) hasta el primer contacto con el mundo;
// - cadencia sostenida igual a la configurada a 60/75/144 Hz, sin ningún
//   intervalo individual por debajo de la puerta del servidor;
// - el melee no reinicia la auto-recarga mientras dura el golpe.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Rockets } from '../src/game/special.js';
import { Weapons } from '../src/combat/weapons.js';
import { TUNING } from '../src/config/tuning.js';

// ---------- cohetes ----------
const open = { raycastHit: () => null };
const wallAt = (z) => ({
  raycastHit: (o, d, max) => {
    if (d.z >= 0) return null;
    const t = (z - o.z) / d.z;
    return t >= 0 && t <= max ? { t, normal: { x: 0, y: 0, z: 1 }, surface: 'concrete' } : null;
  },
});
function fly(world, args, targets, dt) {
  const r = new Rockets(new THREE.Scene(), world, null);
  r.fire(...args);
  let boom = null;
  for (let i = 0; i < 400 && !boom; i++) {
    r.update(dt, targets, (p, mine, owner, info) => { boom = { p, kind: info.kind, target: info.targetId ?? null }; });
  }
  return boom;
}
const O = { x: 0, y: 0.9, z: 0 }, D = { x: 0, y: 0, z: -1 };
const me = { id: 'player', team: 'red' };
const enemyFar = { id: 'enemy', x: 0, y: 0, z: -12, alive: true, team: 'blue' };

let b = fly(open, [O, D, true, null, null, false, me],
  [{ id: 'ally', x: 0, y: 0, z: -5, alive: true, team: 'red' }, enemyFar], 1 / 60);
assert.equal(b?.target, 'enemy', `el cohete del jugador fusó sobre un aliado: ${JSON.stringify(b)}`);

b = fly(open, [{ x: 0, y: 1.4, z: 0 }, D, true, null, null, false, me],
  [{ id: 'player', x: 0, y: 0, z: -0.1, alive: true, team: 'red' }, enemyFar], 1 / 60);
assert.equal(b?.target, 'enemy', 'el cohete fusó sobre su propio tirador');

b = fly(open, [O, D, true, null, null, false, me],
  [{ id: 'fresh', x: 0, y: 0, z: -5, alive: true, team: 'blue', protected: true }, enemyFar], 1 / 60);
assert.equal(b?.target, 'enemy', 'la espoleta se activó con un cuerpo protegido');

for (const hz of [10, 30, 60, 144]) {
  b = fly(open, [O, D, true, null, null, false, me],
    [{ id: 'enemy', x: 0.3, y: 0, z: -6.5, alive: true, team: 'blue' }], 1 / hz);
  assert.equal(b?.target, 'enemy', `a ${hz} Hz el cohete atravesó al enemigo`);
  const sep = Math.hypot(b.p.x - 0.3, b.p.y - 0.9, b.p.z + 6.5);
  assert.ok(sep < 0.7 + 1e-9, `a ${hz} Hz detonó fuera del radio de la espoleta: ${sep.toFixed(2)} m`);
}

b = fly(wallAt(-7), [O, D, true, null, null, false, me],
  [{ id: 'enemy', x: 0, y: 0, z: -6.5, alive: true, team: 'blue' }], 0.1);
assert.equal(b?.kind, 'direct', 'un enemigo delante de la pared dentro del mismo paso fue ignorado');
b = fly(wallAt(-4), [O, D, true, null, null, false, me],
  [{ id: 'enemy', x: 0, y: 0, z: -6.5, alive: true, team: 'blue' }], 0.1);
assert.equal(b?.kind, 'world', 'la espoleta atravesó la pared para alcanzar a un enemigo');

// torso 0.45 m DETRÁS de un muro a 4 m: impacta el muro, nunca carne a
// través del cover (empate → contacto estático, y la espoleta exige vista)
for (const hz of [10, 60]) {
  b = fly(wallAt(-4), [O, D, true, null, null, false, me],
    [{ id: 'enemy', x: 0, y: 0, z: -4.45, alive: true, team: 'blue' }], 1 / hz);
  assert.equal(b?.kind, 'world', `a ${hz} Hz la espoleta atravesó el cover: ${JSON.stringify(b)}`);
}

// cohete de bot: el bando viaja en owner (regla anterior intacta)
b = fly(open, [O, D, true, { id: 'b1', team: 'blue', name: 'B' }, null, false],
  [{ id: 'b2', x: 0, y: 0, z: -5, alive: true, team: 'blue' }, { ...enemyFar, id: 'p', team: 'red' }], 1 / 60);
assert.equal(b?.target, 'p', 'un cohete de bot fusó sobre su compañero');
// sin identidad (compatibilidad): fusa con el primero que roza
b = fly(open, [O, D], [{ id: 'victim', x: 0, y: 0, z: -0.26, alive: true }], 0.01);
assert.equal(b?.target, 'victim');

// ---------- cadencia ----------
const MIN_GAP_SERVER = 0.82;
// SMG a 60 Hz queda fuera a propósito: 620 RPM exigiría alternar 6 y 5
// cuadros (0.86× nominal), demasiado cerca de la puerta 0.82 del servidor
// para sobrevivir al jitter; se queda en 600 (6 cuadros), como antes.
for (const [wep, rates] of [['smg', [75, 120, 144]], ['pistol', [60, 75, 144]]]) {
  const def = TUNING.weapons[wep], interval = 60 / def.rpm;
  for (const hz of rates) {
    const w = new Weapons();
    w.infinite = true;
    w.cur = wep;
    const dt = 1 / hz, times = [];
    for (let i = 0; i < 30 * hz; i++) {
      w.st.mag = 999;
      if (w.update(dt, def.auto, !def.auto, true)) times.push(i * dt);
    }
    const rpm = 60 * (times.length - 1) / (times.at(-1) - times[0]);
    const minGap = Math.min(...times.slice(1).map((t, i) => t - times[i])) / interval;
    assert.ok(Math.abs(rpm - def.rpm) <= def.rpm * 0.006,
      `${wep} a ${hz} Hz: ${rpm.toFixed(1)} RPM, configurado ${def.rpm}`);
    assert.ok(minGap >= 0.9 - 1e-6 && minGap >= MIN_GAP_SERVER + 0.05, `${wep} a ${hz} Hz: intervalo mínimo ${minGap.toFixed(3)}× nominal`);
  }
}
{
  // soltar UN cuadro a mitad del cooldown y volver a pulsar: el crédito no
  // sobrevive (antes caía en el cd y daba 83.3 ms contra 96.8 nominales)
  const I = 60 / TUNING.weapons.smg.rpm, dt = 1 / 60;
  let minAcross = Infinity;
  for (let rel = 20; rel < 80; rel++) {
    const w = new Weapons(); w.infinite = true;
    let last = null;
    for (let i = 0; i < 120; i++) {
      w.st.mag = 999;
      if (w.update(dt, i !== rel, false, true)) {
        if (last !== null && last < rel && i > rel) minAcross = Math.min(minAcross, (i - last) * dt);
        last = i;
      }
    }
  }
  assert.ok(minAcross >= I - 1e-9, `crédito conservado tras soltar: ${(minAcross * 1000).toFixed(1)} ms`);
  // interrupciones de manejo también lo descartan
  for (const cut of ['reload', 'swap', 'melee', 'cancel']) {
    const w = new Weapons(); w.infinite = true; w.st.reserve = 999;
    let last = null, gap = Infinity;
    for (let i = 0; i < 90; i++) {
      w.st.mag = 999;
      if (i === 40) {
        if (cut === 'reload') { w.st.mag = 998; w.startReload(); w.st.reload = 1e-4; }
        else if (cut === 'swap') { w.startSwap('pistol'); w.startSwap('smg'); }
        else if (cut === 'cancel') w.cancelActions();
      }
      if (w.update(dt, true, false, true, !(cut === 'melee' && i === 40))) {
        if (last !== null && last < 40 && i >= 40) gap = Math.min(gap, (i - last) * dt);
        last = i;
      }
    }
    assert.ok(gap >= I - 1e-9, `${cut}: el crédito sobrevivió a la interrupción (${(gap * 1000).toFixed(1)} ms)`);
  }
}

// ---------- puerta de cadencia del servidor ----------
// Honesto = Weapons real a 60 Hz + estados a 20 Hz por un mismo TCP (orden
// conservado). Atacante = disparo codicioso a 0.5 ms. HEAD = intervalo ≥ 82 %.
{
  const G = await import('../server/guards.js');
  const W = TUNING.weapons;
  const HEAD = { allow: (e, w, I, t) => t - (e.last ?? -Infinity) >= I * 0.82, commit: (e, w, I, t) => { e.last = t; }, note() {} };
  const NEW = { allow: G.fireCadenceAllows, commit: G.commitFireCadence, note: G.noteMessageArrival };
  let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sends = (wep, shots) => {
    const w = new Weapons(); w.infinite = true;
    if (!w.state[wep]) { w.slots[0] = wep; w.state[wep] = w._freshState(wep); }
    w.cur = wep;
    const out = []; let sq = 0, nextState = 0;
    for (let i = 0; sq < shots; i++) {
      const t = i / 60; w.st.mag = 999;
      if (w.update(1 / 60, W[wep].auto, !W[wep].auto, true)) out.push({ t, shot: true, sq: ++sq });
      if (t >= nextState) { out.push({ t, shot: false }); nextState += 0.05; }
    }
    return out;
  };
  const deliver = (list, jitter, stall) => {
    let prev = -Infinity;
    return list.map((m) => {
      let a = m.t + 0.04 + (rnd() * 2 - 1) * jitter;
      if (stall) { const ph = m.t % 2; if (ph < 0.2) a = Math.max(a, m.t - ph + 0.24); }
      prev = Math.max(a, prev); return { ...m, a: prev };
    });
  };
  const rejects = (g, wep, arr) => {
    const e = {}, I = 60 / W[wep].rpm; let n = 0, r = 0;
    for (const m of arr) {
      g.note(e, m.a); if (!m.shot) continue; n++;
      if (g.allow(e, wep, I, m.a, { sq: m.sq })) g.commit(e, wep, I, m.a, { sq: m.sq }); else r++;
    }
    return 100 * r / n;
  };
  const opening = (g, wep, win) => {
    const e = {}, I = 60 / W[wep].rpm; let n = 0, sq = 1;
    g.commit(e, wep, I, -10, { sq });
    for (let t = 0; t <= win + 1e-9; t += 0.0005) {
      g.note(e, t);
      if (g.allow(e, wep, I, t, { sq: sq + 1 })) { g.commit(e, wep, I, t, { sq: ++sq }); n++; }
    }
    return n;
  };
  const sustained = (g, wep) => {
    let best = 0; const I = 60 / W[wep].rpm;
    for (const dump of [false, true]) {
      const e = {}; let sq = 0; const ts = [];
      for (let t = 0; t < 60; t += 0.0005) {
        if (dump && t % 0.4 < 0.3) continue; // callar 300 ms y volcar
        g.note(e, t);
        if (g.allow(e, wep, I, t, { sq: sq + 1 })) { g.commit(e, wep, I, t, { sq: ++sq }); ts.push(t); }
      }
      best = Math.max(best, 60 * (ts.length - 1) / (ts.at(-1) - ts[0]));
    }
    return best;
  };
  for (const wep of ['smg', 'pistol', 'shotgun', 'sniper']) {
    const list = sends(wep, wep === 'smg' ? 20000 : 4000);
    const jit = deliver(list, 0.03, false), st = deliver(list, 0.005, true), clean = deliver(list, 0, false);
    for (const [name, arr, max] of [['jitter ±30 ms', jit, 0.5], ['atasco 200 ms', st, Infinity /* el tope de ventana descarta lo que no cabe: check-fire-cadence */], ['limpio', clean, 0]]) {
      const r = rejects(NEW, wep, arr);
      assert.ok(r <= max, `${wep} ${name}: ${r.toFixed(2)} % de tiros honestos rechazados`);
      assert.ok(r <= rejects(HEAD, wep, arr) + 1e-9, `${wep} ${name}: peor que HEAD`);
    }
    for (const win of [0.1, 0.2, 0.5]) {
      assert.ok(opening(NEW, wep, win) <= opening(HEAD, wep, win), `${wep}: apertura en ${win * 1000} ms supera a HEAD`);
    }
    const rpm = sustained(NEW, wep);
    // tolerancia: el crédito único (≤ 0.3 s + 18 % de un intervalo) repartido en 60 s
    const tol = 1 + (0.3 + 0.18 * 60 / W[wep].rpm) / 60;
    assert.ok(rpm <= W[wep].rpm * tol, `${wep}: cadencia sostenible ${rpm.toFixed(1)} RPM (configurado ${W[wep].rpm})`);
  }
  // por arma: el sniper recién equipado no hereda el intervalo de la SMG,
  // pero respeta el gesto de cambio
  const e = {}, Ismg = 60 / W.smg.rpm, Isn = 60 / W.sniper.rpm;
  NEW.commit(e, 'smg', Ismg, 0, { sq: 1 });
  assert.equal(NEW.allow(e, 'sniper', Isn, 0.3, { sq: 2 }), false, 'disparo con otra arma antes del gesto de cambio');
  assert.equal(NEW.allow(e, 'sniper', Isn, 0.56, { sq: 2 }), true, 'el sniper recién equipado quedó bloqueado por la SMG');
  // `sq` repetido o atrasado: descartado
  NEW.commit(e, 'sniper', Isn, 0.56, { sq: 2 });
  assert.equal(NEW.allow(e, 'sniper', Isn, 10, { sq: 2 }), false, 'un sq repetido fue aceptado');
}

// ---------- melee y auto-recarga ----------
{
  const w = new Weapons();
  w.cur = 'shotgun'; w.st.mag = 0; w.st.reserve = 24;
  w.update(1 / 60, false, false, true, true);
  assert.ok(w.reloading, 'la escopeta vacía debe auto-recargar');
  w.interruptReload();
  for (let i = 0; i < 44; i++) {
    w.update(1 / 60, false, false, false, false); // golpe + recovery
    assert.equal(w.reloading, false, 'la recarga se reinició durante el melee');
    assert.equal(w.st.mag, 0, 'entró un cartucho durante el melee');
  }
  w.update(1 / 60, false, false, true, true);
  assert.ok(w.reloading, 'la auto-recarga debe reanudarse al terminar el melee');
}

// ---------- recoger la especial: cliente y servidor eligen el MISMO hueco ----------
{
  const { specialPickupSlot, replacementSlot } = await import('../src/game/drop-policy.js');
  for (const held of ['smg', 'shotgun', 'pistol', 'grenade']) for (const sp of ['sniper', 'bazooka']) {
    const w = new Weapons(); w.cur = held;
    const server = [...w.slots];
    server[specialPickupSlot(server, held, sp)] = sp; // server.js: con el arma en mano ANTES de recoger
    w.giveSpecial(sp);
    assert.deepEqual(w.slots, server, `recoger ${sp} con ${held}: cliente ${w.slots} ≠ servidor ${server}`);
    // después, soltar/recoger un arma del suelo reemplaza el mismo hueco en ambos
    assert.equal(replacementSlot(w.slots, w.cur), replacementSlot(server, sp));
    // segunda recogida (ronda siguiente) con la especial en mano: mismo hueco
    const again = [...server]; again[specialPickupSlot(again, sp, sp === 'sniper' ? 'bazooka' : 'sniper')] = 'x';
    const w2 = new Weapons(); w2.slots = [...server]; w2.state = Object.fromEntries(server.map((k) => [k, w2._freshState(k)])); w2.cur = sp;
    w2.giveSpecial(sp === 'sniper' ? 'bazooka' : 'sniper');
    assert.equal(w2.slots.indexOf(sp === 'sniper' ? 'bazooka' : 'sniper'), again.indexOf('x'));
  }
}

console.log('ORDNANCE OK · espoleta barrida con identidad, cadencia sin depender del refresco, melee sin recarga fantasma');
