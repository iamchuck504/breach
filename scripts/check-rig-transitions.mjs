// TRANSICIONES DEL RIG (procedural, node): cambio de arma guiado por su
// progreso real (primer cambio, repetidos, encadenados e interrumpidos, sin
// NaN y con la fase de guardar/sacar sobre el arma correcta), bombeo de la
// escopeta solo al COMPLETAR la recarga, suelo inválido (NaN/undefined unos
// cuadros) o un escalón bajo un pie sin envenenar el apoyo, y armas
// guardadas colocadas desde el primer cuadro tras construir el rig.
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
