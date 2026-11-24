// Animación del arma en primera persona (src/view/fp/anim.js + rig.js), en Node:
//  1. ADS derivada de las miras: alza y guion caen en el centro de la
//     pantalla (< 1 px) a FOV 60/72/90 y 4:3, 16:9, 21:9 — con la postura
//     que de verdad produce la animación al asentarse, no solo la fórmula;
//  2. continuidad, en términos físicos, con interrupciones aleatorias
//     (disparo, recarga y su cancelación, cambio, golpe, lanzamiento,
//     aterrizaje, daño, sprint, ADS…) a 60 Hz:
//     · el arma SIN retroceso nunca supera 1.15 m/s en un punto a 22 cm de
//       la empuñadura (< 2 cm/cuadro), o el `govV` de su perfil (lanzar);
//       el retroceso va fuera: es un impulso legítimo, acotado por su resorte;
//     · ambas manos deben mantenerse por debajo de 2 cm/cuadro² a 60 Hz.
//  3. contacto: en reposo (cadera, ADS, andando, sprint, agachado) cada
//     mano está a < 1 cm de su ancla;
//  4. pasos de recarga: cada paso exactamente una vez aunque se salten
//     cuadros, ninguno tras una cancelación.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { readGLB } from './simplify-soldier-art.mjs';
import { PROFILES } from '../src/view/fp/profiles.js';
import { createAnim, stepAnim, animEvent, deriveAds, rotYXZ, stepsCrossed } from '../src/view/fp/anim.js';
import { ArmRig } from '../src/view/fp/rig.js';
import { VIEWMODEL_FOV as VM_FOV } from '../src/render/pipeline.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
// azar reproducible
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const arms = readGLB(path.join(root, 'public/assets/fp/arms.glb')).json;
const artLen = arms.nodes[0].extras;

for (const key of Object.keys(PROFILES)) {
  const p = PROFILES[key];
  const hands = Object.fromEntries(['L', 'R'].map(side => {
    const nombre = 'anatomica_' + side;
    return [side, arms.nodes.find(n => n.name === nombre).extras];
  }));
  const anchors = readGLB(path.join(root, `public/assets/fp/${p.model}.glb`)).json.nodes[0].extras.sockets;
  const ads = deriveAds(anchors, p.scale, p.ads.relief, p.ads.roll ?? 0);
  const camPt = (gun, m) => {
    const g = anchors.grip;
    const r = rotYXZ(gun[3], gun[4], gun[5], [(m[0] - g[0]) * p.scale, (m[1] - g[1]) * p.scale, (m[2] - g[2]) * p.scale]);
    return [r[0] + gun[0], r[1] + gun[1], r[2] + gun[2]];
  };

  // ---------- 1. ADS ----------
  const A = createAnim(p, ads);
  for (let i = 0; i < 180; i++) stepAnim(A, 1 / 60, { aim01: 1, speed: 0 });
  // sin respiración ni balanceo: lo que queda es la postura ADS pura
  let worst = 0;
  // derivación: la línea de mira cae en el eje óptico de la cámara del arma
  // (x = y = 0) en la postura que produce la animación al asentarse. El
  // renderizado real por FOV del juego × aspecto lo mide check-fps-view.mjs.
  for (const s of ['sight_rear', 'sight_front']) {
    const v = camPt(A.out.gun, anchors[s]);
    worst = Math.max(worst, Math.hypot(v[0], v[1]) / -v[2] * 1080 / 2 / Math.tan(VM_FOV * Math.PI / 360));
  }
  ok(worst < 1, `${key}: miras en el eje óptico en ADS asentada (${worst.toFixed(3)} px a 1080 de alto)`);

  // ---------- 2–3. continuidad y contacto ----------
  const rig = new ArmRig(hands, artLen);
  rig.setProfile(p, anchors);
  const B = createAnim(p, ads);
  const st = { aim01: 0, speed: 0, sprint: false, crouch01: 0, lean: 0, airborne: false, yawRate: 0, pitchRate: 0, reloadT: 0 };
  const prev = { R: new THREE.Vector3(), L: new THREE.Vector3(), mag: new THREE.Vector3() };
  const cur = { R: new THREE.Vector3(), L: new THREE.Vector3() };
  const center = (side, out) => {
    const o = rig.out[side];
    return out.set(...hands[side].grip.center).multiply(o.hand.scale).applyQuaternion(o.hand.quat).add(o.hand.pos);
  };
  let maxJump = 0, jumpAt = '';
  const pg = new Float64Array(6);
  let maxPop = 0, popAt = '';
  const vel = { R: new THREE.Vector3(), L: new THREE.Vector3() }, pvel = { R: new THREE.Vector3(), L: new THREE.Vector3() };
  let reload = null; // { t, total }
  const T = 60 * 90; // 90 s de juego
  const log = [];
  for (let i = 0; i < T; i++) {
    const dt = 1 / 60;
    const r = rnd();
    // interrupciones aleatorias
    if (r < 0.012) { animEvent(B, 'fire'); log.push('fire'); }
    else if (r < 0.016 && !reload) { reload = { t: 0, total: 1.9 }; animEvent(B, 'reloadStart', { total: 1.9 }); log.push('reload'); }
    else if (r < 0.0175 && reload) { reload = null; animEvent(B, 'reloadCancel'); log.push('cancel'); }
    else if (r < 0.019) { reload && animEvent(B, 'reloadCancel'); reload = null; animEvent(B, 'swapStart', { total: 0.55, draw: rnd() < 0.5 }); log.push('swap'); }
    else if (r < 0.0205) { reload && animEvent(B, 'reloadCancel'); reload = null; animEvent(B, 'meleeStart', { total: 0.6, hitAt: 0.4 }); log.push('melee'); }
    else if (r < 0.022) { animEvent(B, 'throwStart', { total: 0.8, release: 0.6 }); log.push('throw'); }
    else if (r < 0.024) animEvent(B, 'land', { speed: 3 + rnd() * 8 });
    else if (r < 0.026) animEvent(B, 'hurt', { dir: rnd() * 6.28 - 3.14 });
    else if (r < 0.04) st.aim01 = st.aim01 ? 0 : 1;
    else if (r < 0.05) st.sprint = !st.sprint;
    else if (r < 0.06) st.crouch01 = st.crouch01 ? 0 : 1;
    else if (r < 0.07) st.speed = rnd() < 0.4 ? 0 : rnd() * 7;
    else if (r < 0.08) st.lean = Math.round(rnd() * 2 - 1);
    else if (r < 0.085) st.airborne = !st.airborne;
    if (rnd() < 0.05) { st.yawRate = (rnd() * 2 - 1) * 8; st.pitchRate = (rnd() * 2 - 1) * 3; }
    if (reload) {
      const t0 = reload.t; reload.t += dt / reload.total;
      for (const s of stepsCrossed(p.reload.steps, t0, Math.min(1, reload.t))) animEvent(B, 'reloadStep', { name: s });
      if (reload.t >= 1) { animEvent(B, 'reloadEnd'); reload = null; }
      st.reloadT = reload ? reload.t : 0;
    } else st.reloadT = 0;
    const a = stepAnim(B, dt, st);
    rig.update(dt, a.gun, a);
    // manos en el marco del ARMA (un salto aquí es un "pop" de la mano) y el
    // arma sin el retroceso (A.govPose: un salto aquí es un "pop" del arma;
    // el retroceso es un impulso legítimo y su resorte lo acota)
    center('R', cur.R); center('L', cur.L);
    const gq = rig.gunQuat.clone().invert();
    for (const s of ['R', 'L']) cur[s].sub(rig.gunPos).applyQuaternion(gq);
    if (i > 2) {
      // manos: un "pop" es un cambio BRUSCO de velocidad (segunda diferencia);
      // un movimiento rápido y suave (lanzar, ir a la cartuchera) no lo es
      for (const s of ['R', 'L']) {
        const dv = vel[s].copy(cur[s]).sub(prev[s]);
        const pop = i > 3 ? dv.distanceTo(pvel[s]) : 0;
        pvel[s].copy(dv);
        if (pop > maxPop) { maxPop = pop; popAt = `mano ${s} cuadro ${i} tras ${log.slice(-3).join(',')}`; }
      }
      const g = B.govPose;
      const dg = Math.hypot(g[0] - pg[0], g[1] - pg[1], g[2] - pg[2]) + 0.22 * Math.hypot(g[3] - pg[3], g[4] - pg[4], g[5] - pg[5]);
      if (dg > maxJump) { maxJump = dg; jumpAt = `arma cuadro ${i} tras ${log.slice(-3).join(',')}`; }
    }
    pg.set(B.govPose);
    prev.R.copy(cur.R); prev.L.copy(cur.L);
  }
  // un perfil con gobernador propio (lanzamiento) declara su velocidad: el
  // umbral es la suya a 60 Hz (+5 %), nunca menos de 2 cm
  const lim = Math.max(0.02, (p.govV ?? 0) / 60 * 1.05);
  ok(maxJump < lim, `${key}: (≤ ${(lim * 100).toFixed(1)} cm) continuidad con ${log.length} interrupciones: arma sin retroceso, salto máx. ${(maxJump * 100).toFixed(2)} cm/cuadro (${jumpAt})`);
  // Incluye el giro del guante alrededor del centro de contacto.
  const popLim = 0.02;
  ok(maxPop < popLim, `${key}: manos sin tirones (cambio de velocidad máx. ${(maxPop * 100).toFixed(2)} cm/cuadro², < ${(popLim * 100).toFixed(1)}; ${popAt})`);

  // contacto en reposo
  const poses = {
    cadera: { aim01: 0 }, ads: { aim01: 1 }, andando: { speed: 4.8 }, sprint: { sprint: true, speed: 7 },
    agachado: { crouch01: 1 }, inclinado: { lean: 1 }, girando: { yawRate: 4, pitchRate: -1.5 },
  };
  for (const [name, s0] of Object.entries(poses)) {
    const C = createAnim(p, ads);
    const rg = new ArmRig(hands, artLen);
    rg.setProfile(p, anchors);
    let worstR = 0, worstL = 0;
    for (let i = 0; i < 240; i++) {
      const a = stepAnim(C, 1 / 60, { aim01: 0, speed: 0, ...s0 });
      rg.update(1 / 60, a.gun, a);
      if (i < 120) continue;
      const cR = new THREE.Vector3(...hands.R.grip.center).multiply(rg.out.R.hand.scale).applyQuaternion(rg.out.R.hand.quat).add(rg.out.R.hand.pos);
      const cL = new THREE.Vector3(...hands.L.grip.center).multiply(rg.out.L.hand.scale).applyQuaternion(rg.out.L.hand.quat).add(rg.out.L.hand.pos);
      worstR = Math.max(worstR, cR.distanceTo(rg.out.R.target));
      worstL = Math.max(worstL, cL.distanceTo(rg.out.L.target));
    }
    const freeL = !p.targets[p.grips.left.target]?.anchor;
    ok(worstR < 0.01 && (freeL || worstL < 0.01), `${key}: ${name}: manos en sus anclas (der ${(worstR * 1000).toFixed(1)} mm, izq ${(worstL * 1000).toFixed(1)} mm)`);
  }
  // también durante una ráfaga (el retroceso no despega las manos)
  {
    const lado = p.grips.left.pose === 'libre' ? 'R' : 'L';
    const C = createAnim(p, ads);
    const rg = new ArmRig(hands, artLen);
    rg.setProfile(p, anchors);
    let w = 0;
    for (let i = 0; i < 240; i++) {
      if (i > 60 && i % 6 === 0) animEvent(C, 'fire');
      const a = stepAnim(C, 1 / 60, { aim01: 0, speed: 0, fireHeld: true });
      rg.update(1 / 60, a.gun, a);
      if (i < 60) continue;
      const { hand, target } = rg.out[lado];
      const centro = new THREE.Vector3(...hands[lado].grip.center).multiply(hand.scale).applyQuaternion(hand.quat).add(hand.pos);
      w = Math.max(w, centro.distanceTo(target));
    }
    const apoyo = lado === 'R' ? 'derecha en la empuñadura' : 'izquierda en su apoyo';
    ok(w < 0.01, `${key}: ráfaga: mano ${apoyo} (${(w * 1000).toFixed(1)} mm)`);
  }

  // ---------- 4. pasos de recarga ----------
  let bad = 0, runs = 0;
  for (let k = 0; k < 400; k++) {
    const seen = new Map();
    let t = 0;
    const cancelAt = rnd() < 0.35 ? rnd() : 2;
    let cancelled = false;
    while (t < 1) {
      const dt = rnd() < 0.1 ? rnd() * 0.5 : rnd() * 0.02; // saltos grandes de cuadro
      const t1 = Math.min(1, t + dt);
      if (t1 >= cancelAt) { cancelled = true; break; }
      for (const s of stepsCrossed(p.reload.steps, t, t1)) seen.set(s, (seen.get(s) ?? 0) + 1);
      t = t1;
    }
    runs++;
    for (const s of p.reload.steps) {
      const n = seen.get(s.step) ?? 0;
      if (n > 1) bad++;
      if (!cancelled && n !== 1) bad++;
      if (cancelled && s.t > cancelAt && n) bad++;
    }
  }
  ok(bad === 0, `${key}: ${runs} recargas con saltos y cancelaciones: cada paso exactamente una vez (${bad} errores)`);
}
if (fail) { console.log(`\n${fail} fallo(s)`); process.exit(1); }
console.log('\ncheck-fps-anim: todo bien');
