// TRANSICIONES DEL RIG (procedural, node): cambio de arma guiado por su
// progreso real (primer cambio, repetidos, encadenados e interrumpidos, sin
// NaN y con la fase de guardar/sacar sobre el arma correcta), bombeo de la
// escopeta solo al COMPLETAR la recarga, suelo inválido (NaN/undefined unos
// cuadros) o un escalón bajo un pie sin envenenar el apoyo, armas
// guardadas colocadas desde el primer cuadro tras construir el rig y la capa
// FPS (agachado, asomo, inclinación, deslizamiento) continua a 30/60/144 Hz.
//   node scripts/check-rig-transitions.mjs
import assert from 'node:assert/strict';
import * as T from 'three';
import { Rig } from '../src/player/rig.js';
import { TUNING } from '../src/config/tuning.js';

const SWAP = 0.55; // = SWAP_TIME de src/combat/weapons.js
const base = { state: 'idle', speed: 0, aim: false, aimPitch: 0 };
const finiteRig = (r) => { r.root.updateMatrixWorld(true); let ok = true; r.root.traverse((o) => { if (!o.matrixWorld.elements.every(Number.isFinite)) ok = false; }); return ok; };
const out = {};
const ONLY = process.env.ONLY;
const want = (k) => !ONLY || ONLY === k;

// --- cambio de arma: como main (el modelo cambia a mitad del gesto)
if (want('cambio')) for (const hz of [30, 60, 144]) {
  const r = new Rig(new T.Scene(), 'red'); r.groundFn = () => 0; const dt = 1 / hz;
  r.setWeapon('smg', 'shotgun');
  for (let i = 0; i < hz; i++) r.update(dt, base);
  const run = (from, to, seconds, interruptAt = Infinity) => {
    let swapT = SWAP, swapped = false, outOnIncoming = 0, frames = 0;
    for (let t = 0; t < seconds; t += dt) {
      if (t >= interruptAt) swapT = 0;
      if (swapT > 0) { swapT = Math.max(0, swapT - dt); if (!swapped && swapT <= SWAP / 2) { swapped = true; r.setWeapon(to, from); } }
      r.update(dt, { ...base, swapping: swapT > 0 });
      assert.ok(finiteRig(r), 'NaN en el cambio de arma');
      if (swapT > 0) assert.ok(Number.isFinite(r._swapClock) && (r._swapPhase === 'out' || r._swapPhase === 'in'), `reloj del cambio inválido (${r._swapClock})`);
      // la fase de sacar nunca empieza antes de tener el arma nueva
      if (r._swapPhase === 'in' && r._wep !== to) outOnIncoming++;
      if (r._swapPhase === 'out' && r._wep === to) outOnIncoming++;
      frames++;
    }
    return outOnIncoming;
  };
  assert.equal(run('smg', 'shotgun', 0.9), 0, 'primer cambio: fase sobre el arma equivocada');
  assert.equal(run('shotgun', 'smg', 0.9), 0, 'segundo cambio');
  // cambio interrumpido antes de la mitad (melee/muerte): vuelve limpio
  run('smg', 'pistol', 0.6, 0.12);
  r.setWeapon('smg', 'shotgun');
  assert.equal(run('smg', 'shotgun', 0.9), 0, 'cambio tras uno interrumpido');
  out['cambio@' + hz] = 'ok';
}
// encadenado: un segundo cambio sin soltar swapping (cola de Weapons)
if (want('cambio')) {
  const r = new Rig(new T.Scene(), 'red'); const dt = 1 / 60;
  r.setWeapon('smg', 'shotgun');
  for (let i = 0; i < 60; i++) r.update(dt, base);
  const phases = [];
  for (let k = 0; k < Math.round(2 * SWAP / dt); k++) {
    const t = k * dt, cyc = Math.floor(t / SWAP), inCyc = t - cyc * SWAP;
    if (inCyc >= SWAP / 2 && r._wep !== (cyc === 0 ? 'shotgun' : 'smg')) r.setWeapon(cyc === 0 ? 'shotgun' : 'smg', cyc === 0 ? 'smg' : 'shotgun');
    r.update(dt, { ...base, swapping: true });
    phases.push(r._swapPhase);
  }
  assert.ok(finiteRig(r));
  const changes = phases.filter((p, i) => i && p !== phases[i - 1]).length;
  assert.equal(changes, 3, `dos cambios encadenados = out,in,out,in (cambios de fase: ${changes})`);
  out.encadenado = 'ok';
}

// Cortar la patada antes, durante y después del contacto. Un remoto puede
// seguir enviando melee unos cuadros después del aturdimiento o del cambio.
if (want('patada')) for (const hz of [30, 60, 144]) {
  const dt = 1 / hz, { hitAt, time } = TUNING.melee;
  let worst = 0;
  for (const kind of ['muerte', 'aturdimiento', 'cambio']) for (const cut of [hitAt / 2, hitAt, hitAt + 0.1]) {
    const rig = new Rig(new T.Scene(), 'red');
    rig.groundFn = () => 0;
    for (let i = 0; i < hz; i++) rig.update(dt, base);
    const ankle = rig.legR.ankle, prev = ankle.getWorldPosition(new T.Vector3()), now = new T.Vector3();
    for (let frame = 0; frame < hz; frame++) {
      const t = frame * dt, interrupted = t >= cut;
      rig.stunned = interrupted && kind === 'aturdimiento';
      const swapping = interrupted && kind === 'cambio';
      if (swapping) rig.setWeapon('shotgun');
      const state = interrupted && kind === 'muerte' ? 'dead' : t < time ? 'melee' : 'idle';
      rig.update(dt, { state, meleePhase: t / time, meleeEnd: time, speed: 0, swapping });
      ankle.getWorldPosition(now);
      const step = now.distanceTo(prev) * hz / 60;
      assert.ok(step < 0.42, `${kind} a ${hz} Hz: el tobillo saltó ${step} m/cuadro normalizado`);
      worst = Math.max(worst, step);
      prev.copy(now);
      if (interrupted && kind !== 'muerte' && t >= cut + 0.28) {
        assert.ok(rig.soleWorld(rig.legR, now, true).y < 0.04, 'La pierna interrumpida debe volver al suelo');
      }
    }
  }
  out['patada' + hz] = +worst.toFixed(3);
}

// --- bombeo de la escopeta: solo al completar
if (want('bombeo')) for (const hz of [30, 60, 144]) {
  const r = new Rig(new T.Scene(), 'red'); const dt = 1 / hz, rt = TUNING.weapons.shotgun.reloadTime;
  r.setWeapon('shotgun', 'smg');
  for (let i = 0; i < hz; i++) r.update(dt, base);
  // como Weapons: s.reload baja; reloadT = 1 − reload/reloadTime
  const cycle = (stopAt) => {
    let reload = rt, pumped = false;
    for (let k = 0; k < 200; k++) {
      let reloading = reload > 0;
      if (reload > 0 && 1 - reload / rt >= stopAt) { reload = 0; reloading = false; } // cancelado
      const reloadT = reloading ? 1 - reload / rt : 0;
      if (reload > 0) { reload -= dt; if (reload <= 0) reload = 0; }
      r.update(dt, { ...base, reloading, reloadT });
      if (r._pumpT !== undefined) pumped = true;
      if (!reloading && k > 2) { for (let j = 0; j < hz / 2; j++) { r.update(dt, base); if (r._pumpT !== undefined) pumped = true; } break; }
    }
    return pumped;
  };
  assert.equal(cycle(0.85), false, `@${hz}: cancelar al 85 % no debe bombear`);
  assert.equal(cycle(0.97 - 1 / (hz * rt)), false, `@${hz}: cancelar casi al final no debe bombear`);
  assert.equal(cycle(2), true, `@${hz}: completar debe bombear`);
  out['bombeo@' + hz] = 'ok';
}

// --- suelo inválido unos cuadros y escalón bajo un pie
if (want('suelo')) {
  const r = new Rig(new T.Scene(), 'red'); const dt = 1 / 60;
  let mode = 'ok';
  r.groundFn = (x) => mode === 'nan' ? NaN : mode === 'undef' ? undefined : mode === 'ledge' && x > 0 ? -0.3 : 0;
  for (let i = 0; i < 60; i++) r.update(dt, base);
  for (const bad of ['nan', 'undef']) {
    mode = bad; for (let i = 0; i < 8; i++) { r.update(dt, base); assert.ok(finiteRig(r), `suelo ${bad}: NaN en la pose`); }
    mode = 'ok'; for (let i = 0; i < 40; i++) r.update(dt, base);
    for (const leg of [r.legL, r.legR]) {
      assert.ok(Number.isFinite(leg._pen ?? 0) && Number.isFinite(leg._floorOff ?? 0), `suelo ${bad}: acumulador envenenado`);
      assert.ok(Math.abs(r.soleWorld(leg, new T.Vector3(), true).y) < 0.015, `suelo ${bad}: el pie no vuelve al suelo`);
    }
  }
  // borde: el pie derecho sobre un hueco de 30 cm; la pierna estira hasta su alcance
  // (de pie, la marcha deja el pie a la altura del cuerpo sobre el borde; en
  // una postura apoyada el pie busca el suelo de abajo hasta donde alcanza)
  mode = 'ledge'; for (let i = 0; i < 60; i++) r.update(dt, base);
  assert.ok(finiteRig(r) && r.soleWorld(r.legR, new T.Vector3(), true).y > -0.31, 'escalón de pie');
  for (let i = 0; i < 60; i++) r.update(dt, { ...base, state: 'cover_high' });
  assert.ok(finiteRig(r));
  const yR = r.soleWorld(r.legR, new T.Vector3(), true).y;
  assert.ok(yR < -0.05 && yR > -0.31, `escalón: el pie derecho baja hacia el suelo de abajo sin pasarlo (${yR.toFixed(3)})`);
  assert.ok(r.legR.knee.rotation.x <= 0, 'rodilla sin hiperextensión');
  out.suelo = 'ok';
}

// --- capa FPS (corrida 6): agacharse, asomo `ce`, inclinación `cl`, sprint →
// deslizamiento → agachado. Misma pose a 30/60/144 Hz en los mismos
// instantes, sin saltos de un cuadro (cabeza y boca, normalizado a 60 Hz) y
// sin NaN; estados nuevos o desconocidos caen con gracia.
if (want('fps')) {
  const SEQ = [ // [segundos, parámetros]
    [0.5, {}], [0.4, { state: 'crouch', coverAimExposure: 0 }], [0.3, { state: 'crouch', speed: 2.3 / 7.6, coverAimExposure: 0 }],
    [0.4, { state: 'crouch', aim: true, coverAimExposure: 0 }], [0.5, { state: 'crouch', aim: true, coverAimExposure: 1, ramp: 'ce' }],
    [0.4, { state: 'crouch', aim: true, coverAimExposure: 0, ramp: 'ce-' }], [0.4, { state: 'crouch', aim: true, coverLean: 1, coverAimExposure: 0 }],
    [0.4, { state: 'crouch', aim: true, coverLean: -1, coverAimExposure: 0 }], [0.4, { aim: true, coverLean: 1 }], [0.4, { coverLean: -1 }],
    [0.4, { state: 'run', speed: 0.6, coverLean: 1 }], [0.5, { state: 'roadie', speed: 1 }], [0.5, { state: 'slide', aim: true }],
    [0.4, { state: 'crouch', coverAimExposure: 0 }], [0.3, { state: 'slide' }], [0.5, {}], [0.3, { state: 'estado_futuro' }], [0.3, {}],
  ];
  const marks = {};
  for (const hz of [30, 60, 144]) {
    const r = new Rig(new T.Scene(), 'red'); r.groundFn = () => 0; const dt = 1 / hz;
    r.setWeapon('smg', 'shotgun');
    const head = new T.Vector3(), prevH = new T.Vector3(), mz = new T.Vector3(), prevM = new T.Vector3();
    let first = true, maxHead = 0, maxMz = 0, seg = 0;
    marks[hz] = [];
    const stepsH = [], stepsM = [];
    for (const [secs, p0] of SEQ) {
      const n = Math.round(secs * hz);
      for (let i = 0; i < n; i++) {
        const u = (i + 1) / n, p = { ...base, ...p0 };
        // `ce` llega rampado (servidor: ≤6/s), como en la red
        if (p0.ramp === 'ce') p.coverAimExposure = Math.min(1, u * 2);
        if (p0.ramp === 'ce-') p.coverAimExposure = Math.max(0, 1 - u * 2.5);
        r.update(dt, p);
        assert.ok(finiteRig(r), `NaN en la capa FPS (${JSON.stringify(p0)} @${hz})`);
        r.head.getWorldPosition(head); r.muzzleWorld(mz);
        if (!first) {
          // paso por cuadro llevado a 60 Hz (a 30 Hz un cuadro abarca el doble)
          stepsH.push(head.distanceTo(prevH) * hz / 60);
          stepsM.push(mz.distanceTo(prevM) * hz / 60);
        }
        prevH.copy(head); prevM.copy(mz); first = false;
      }
      marks[hz].push([+head.x.toFixed(4), +head.y.toFixed(4), +head.z.toFixed(4), seg++]);
    }
    // salto = un cuadro que mueve mucho más que sus dos vecinos (una
    // transición rápida pero suave sube y baja de forma gradual); tope absoluto
    const spikes = (a, min) => { let n = 0; for (let i = 1; i < a.length - 1; i++) if (a[i] > min && a[i] > 2.2 * Math.max(a[i - 1], a[i + 1])) n++; return n; };
    maxHead = Math.max(...stepsH); maxMz = Math.max(...stepsM);
    assert.equal(spikes(stepsH, 0.02), 0, `@${hz}: salto de un cuadro en la cabeza`);
    assert.equal(spikes(stepsM, 0.03), 0, `@${hz}: salto de un cuadro en la boca`);
    // (tope: el máximo es el primer cuadro de agachado→deslizamiento, que como
    // todo cambio de estado del rig se suaviza con una sola etapa exponencial)
    assert.ok(maxHead < 0.25 && maxMz < 0.3, `@${hz}: cabeza ${maxHead.toFixed(3)} / boca ${maxMz.toFixed(3)} m en un cuadro`);
    out['fps@' + hz] = `cabeza ${maxHead.toFixed(3)} boca ${maxMz.toFixed(3)} m/cuadro60`;
  }
  // mismos instantes, misma pose a cualquier frecuencia (±2 cm: algunos
  // tramos aún se mueven a ~1 m/s y el filtro discreto difiere en <½ cuadro)
  for (const hz of [30, 144]) marks[hz].forEach((m, i) => {
    const a = marks[60][i];
    const d = Math.hypot(m[0] - a[0], m[1] - a[1], m[2] - a[2]);
    assert.ok(d < 0.02, `@${hz} tramo ${i}: la cabeza difiere de 60 Hz en ${d.toFixed(3)} m`);
  });
  // estados que el rig dibuja (remote.js decide su respaldo con esto)
  {
    const r = new Rig(new T.Scene(), 'red'); r.groundFn = () => 0;
    const p = { ...base, state: 'crouch', aim: true, coverLean: 0.6, coverAimExposure: 0.3, speed: 0.3 };
    for (let i = 0; i < 30; i++) r.update(1 / 60, p);
    assert.ok(r.supportsState('crouch') && !r.supportsState('estado_futuro'), 'supportsState');
  }
}

// --- etiqueta de nombre (revisión de la rebanada): sigue a la cabeza (agachado
// tras LOW ya no flota a 2,05 m) y la de un ENEMIGO no se dibuja si no se pide
if (want('etiqueta')) {
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillText() {} }) }) };
  const r = new Rig(new T.Scene(), 'red', 'Rival'); r.groundFn = () => 0;
  r.setNameTagThroughWalls(false);
  assert.equal(r.nameTag.visible, false, 'etiqueta enemiga visible sin pedirla');
  r.showNameTag(true);
  for (let i = 0; i < 60; i++) r.update(1 / 60, base);
  const yUp = r.nameTag.position.y;
  for (let i = 0; i < 60; i++) r.update(1 / 60, { ...base, state: 'crouch', coverAimExposure: 0 });
  const yLow = r.nameTag.position.y;
  assert.ok(yUp > 1.9 && yLow < yUp - 0.7, `la etiqueta no sigue a la cabeza (${yUp.toFixed(2)} → ${yLow.toFixed(2)})`);
  assert.equal(r.nameTag.material.depthTest, true, 'la etiqueta enemiga atraviesa geometría');
  r.showNameTag(false); assert.equal(r.nameTag.visible, false);
  const a = new Rig(new T.Scene(), 'blue', 'Aliado'); a.setNameTagThroughWalls(true);
  assert.equal(a.nameTag.visible, true, 'la etiqueta de un compañero debe verse');
  out.etiqueta = `pie ${yUp.toFixed(2)} agachado ${yLow.toFixed(2)} m`;
}

// --- acciones por evento (remotos, auditoría): lanzamiento rápido de frag con
// el fusil en la mano (se ve el bote, se suelta en el evento, vuelve el
// fusil), cancelación de recarga sin bombeo
if (want('eventos')) {
  const r = new Rig(new T.Scene(), 'red'); r.groundFn = () => 0; const dt = 1 / 60, g = TUNING.weapons.grenade;
  r.setWeapon('smg', 'shotgun');
  for (let i = 0; i < 30; i++) r.update(dt, base);
  let throwT = g.throwTime, ev = [['throwStart', 'frag']], visBefore = null, visAfter = null, relDone = false;
  for (let i = 0; i < 90 && throwT > 0; i++) {
    if (!relDone && throwT <= g.throwTime - g.throwRelease) { ev = [['throwRelease', 'frag']]; relDone = true; }
    r.update(dt, { ...base, throwT, throwTotal: g.throwTime, throwReleased: true, events: ev });
    r.setWeapon('smg', 'shotgun'); // remote.js lo pide cada cuadro: se aplaza
    if (i === 2) { assert.equal(r._wep, 'frag', 'la frag rápida no se ve en la mano'); visBefore = r.activeGun.visible; }
    if (relDone && ev.length === 0) visAfter = r.activeGun.visible;
    ev = []; throwT = Math.max(0, throwT - dt);
  }
  r.update(dt, { ...base, events: [] });
  assert.equal(visBefore, true, 'el bote desaparece antes de la suelta');
  assert.equal(visAfter, false, 'el bote sigue en la mano tras la suelta');
  assert.equal(r._wep, 'smg', 'no vuelve el arma de la mano tras lanzar');
  // recarga de escopeta cancelada por evento: sin bombeo
  r.setWeapon('shotgun', 'smg');
  for (let i = 0; i < 20; i++) r.update(dt, { ...base, state: 'run', speed: 0.5, reloading: true, reloadT: 0.9 + i * 0.004 });
  r.update(dt, { ...base, state: 'run', speed: 0.5, events: [['reloadCancel', 'shotgun']] });
  for (let i = 0; i < 20; i++) { r.update(dt, { ...base, state: 'run', speed: 0.5 }); assert.equal(r._pumpT, undefined, 'bombea tras cancelar'); }
  assert.ok(finiteRig(r));
  out.eventos = 'ok';
}

// --- armas guardadas colocadas desde la construcción (sin cambiar de arma)
if (want('guardadas')) for (let v = 0; v < 5; v++) {
  const r = new Rig(new T.Scene(), 'red', null, v);
  const g = r.guns.shotgun; assert.equal(g.parent, r.backMount);
  const z0 = g.position.z;
  r.setWeapon('shotgun', 'smg'); r.setWeapon('smg', 'shotgun');
  assert.ok(Math.abs(r.guns.shotgun.position.z - z0) < 1e-6, `variante ${v}: la escopeta de la espalda cambia de sitio al re-equipar (${z0.toFixed(3)} → ${r.guns.shotgun.position.z.toFixed(3)})`);
}
out.guardadas = 'ok';
console.log('RIG TRANSITIONS OK', JSON.stringify(out));
