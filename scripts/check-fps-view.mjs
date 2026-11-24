// Arma en primera persona COMPLETA (viewmodel.js con sus GLB, rig y anim) en
// Node, sin navegador:
//  1. cada pieza móvil que el perfil declara (parts.bolt = corredera, bomba,
//     cerrojo…; parts.mag) se mueve en su suceso: disparo, vacío, recarga;
//  2. scopeIn01 es el valor PRESENTE: sube al apuntar, cae con pared,
//     recarga, cambio, golpe y sprint (DECISIONES 17), monótono en cada tramo;
//  3. el ajuste de balanceo (bob/movimiento reducido) gobierna el arma;
//  4. con dt = 0 (pausa) nada se mueve;
//  5a. la mira RENDERIZADA cae en el centro por arma × FOV 60/72/100 × 4:3,
//      16:9, 21:9 (proyección real de la cámara y viewModelToMainView);
//  5b. pegado a una pared (0.30–0.50 m) ninguna parte del arma la cruza, en
//      cadera y en ADS;
//  5c. tamaño y posición en pantalla por arma y aspecto dentro de límites y
//      fuera de los rectángulos del HUD;
//  5d. separación mano–agarre DURANTE interrupciones (recarga cortada por
//      cambio, golpe, sprint y muerte; lanzamiento cortado) a 30/60/144 Hz.
import { distanciaYema, apoyosDelArma } from './lib-fps-anatomical-hand.mjs';
import { surfaces } from './lib-fps-hand-geometry.mjs';
import { checkSoldierPalette, checkSoldierScale } from './lib-fps-soldier-parity.mjs';
import { posar } from './fp-preview.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { silhouette } from '../src/view/fp/silhouette.js';
import { dodgeFX } from '../src/view/fp/dodge-fx.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import { FpAdapter } from '../src/view/fp/game-adapter.js';
import { viewModelToMainView, viewModelUniforms, updateViewModelProjection } from '../src/render/pipeline.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
const parse = (f) => new Promise((res, rej) => {
  const b = fs.readFileSync(f);
  new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), '', (g) => res(g.scene), rej);
});
const assets = { arms: await parse(path.join(root, 'public/assets/fp/arms.glb')) };
assets.soldier = await parse(path.join(root, 'public/assets/characters/blender/soldier-blender-body.glb'));
assets['kick-leg'] = await parse(path.join(root, 'public/assets/fp/kick-leg.glb'));
for (const k of Object.keys(PROFILES)) assets[k] = await parse(path.join(root, `public/assets/fp/${PROFILES[k].model}.glb`));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.03, 500);
scene.add(camera); camera.updateMatrixWorld();
const local = { rig: {}, player: { grounded: true }, weapons: { cur: 'smg' } };
const adapter = new FpAdapter({ scene, camera, G: local, world: { raycast: () => null } }, assets);
const vm = adapter.vm;
await vm.ready;

const BASE = { aim01: 0, speed: 0, sprint: false, reloadT: 0, wallNear: 0, bob: 1, shake: 1 };
const fresh = (key) => { vm.key = null; vm.anim = null; vm.setWeapon(key); const s = { ...BASE }; for (let i = 0; i < 90; i++) vm.update(1 / 60, s); return s; };
const step = (s, n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) vm.update(dt, s); };
// La posición se mide sobre los píxeles visibles del guante, sin contar
// el brazal ni los dedos que quedan detrás del cargador.
{
  const centros = [];
  for (const fase of [.25, .50, .75]) {
    posar(vm, 'smg', 'recarga:' + fase);
    const w = vm.weapons.smg, mag = w.roles.mag;
    const recorrido = w.model.worldToLocal(mag.bone.getWorldPosition(new THREE.Vector3())).distanceTo(mag.rest);
    ok(fase === .75 ? recorrido < .001 && vm.anim.out.mag === 0 : recorrido > .01 && vm.anim.out.mag === 1,
      `smg ${100*fase} %: cargador ${fase === .75 ? 'asentado en el brocal' : 'en la mano'}`);
    const { width, owner, names } = silhouette(vm, viewModelUniforms.uVMProj.value, 1280, 720);
    const guante = names.map(n => /^fp_(?:L_|hand_L$)/.test(n));
    let x = 0, y = 0, area = 0;
    for (let i = 0; i < owner.length; i++) if (guante[owner[i]]) {
      x += i % width + .5;
      y += Math.floor(i / width) + .5;
      area++;
    }
    ok(area > 0 && owner.includes(names.indexOf(mag.bone.name)),
      `smg ${100*fase} %: guante izquierdo y cargador visibles`);
    const centro = new THREE.Vector2(x / area, y / area);
    for (const previo of centros) {
      const distancia = centro.distanceTo(previo.centro);
      ok(distancia >= 60, `smg ${100*previo.fase}–${100*fase} %: separación del guante ${distancia.toFixed(1)} px`);
    }
    centros.push({ fase, centro });
  }
}
// Área realmente visible a la resolución de las capturas, tras la oclusión.
for (const [key, profile] of Object.entries(PROFILES)) {
  if (profile.scope) {
    local.weapons.cur = key;
    adapter.update(1 / 60, { yaw: 0, pitch: 0 }, true);
  }
  const state = fresh(key);
  state.aim01 = 1;
  step(state, 120);
  if (profile.scope) {
    local.weapons.cur = key;
    local.player.aim = true;
    adapter.update(1 / 60, { _scoped: true, yaw: 0, pitch: 0 }, true);
    local.player.aim = false;
    local.weapons.cur = 'smg';
  }
  const { names, owner, width, height } = silhouette(vm, viewModelUniforms.uVMProj.value, 1280, 720);
  const guante = names.map(n => /^fp_(?:[LR]_|hand_[LR]$)/.test(n));
  ok(owner.some(id => guante[id]), key + ': se distingue un guante al apuntar');
  if (profile.scope) {
    ok(vm.root.visible && vm.ocular.matte.visible && !owner[width * height / 2 + width / 2],
      key + ': campo central del visor abierto y guante visible fuera del ocular');
  }
  if (profile.grips.left.pose !== 'libre') continue;
  const brazos = names.map(n => /^fp_(?:R_|hand_R$|fore_R$)/.test(n));
  const area = 100 * owner.reduce((n,id) => n + brazos[id], 0) / owner.length;
  ok(area >= 3, key + ': mano y antebrazo derechos en ADS ocupan ' + area.toFixed(2) + ' % del cuadro');
  const pulgar = names.map(n => n.startsWith('fp_R_thumb'));
  ok(owner.subarray(-width).includes(names.indexOf('fp_fore_R')) && owner.some(id => pulgar[id]),
    key + ': brazal y pulgar derechos visibles en ADS');
  const linea = owner.subarray(0, width * Math.ceil(height / 2));
  ok(!linea.some(id => brazos[id]), key + ': manos por debajo de las miras');
}
const _v = new THREE.Vector3();
const reloadTotal = (k) => ({ smg: 1.9, shotgun: 0.46, pistol: 1.35, sniper: 2.2, bazooka: 2.6, stun: 1.5 }[k] ?? 1.5);

// Contar las mallas que realmente se envían por aspecto.
let maxTris = 0, maxDraws = 0;
for (const [variant] of vm.arms.geometries.entries()) {
  vm.setVariant(variant);
  for (const key of Object.keys(PROFILES)) {
    vm.setWeapon(key);
    vm.update(1 / 60, BASE);
    let tris = 0, draws = 0;
    vm.root.traverseVisible(node => {
      if (!node.isMesh) return;
      draws += Array.isArray(node.material) ? node.geometry.groups.length : 1;
      tris += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
    });
    maxTris = Math.max(maxTris, tris);
    maxDraws = Math.max(maxDraws, draws);
  }
}
vm.setVariant(0);
ok(maxDraws === 2 && maxTris <= 45_000, `ocho armas × cinco aspectos: máximo ${maxDraws} llamadas y ${maxTris} triángulos`);

for (const [variant] of vm.arms.geometries.entries()) for (const team of ['blue', 'red']) {
  Object.assign(local.rig, { team, variant });
  adapter.update(1 / 60, { yaw: 0, pitch: 0 }, true);
  checkSoldierPalette(vm, assets, variant, team);
}
vm.setVariant(0);
for (const key of Object.keys(PROFILES)) {
  fresh(key);
  vm.event('meleeStart', { total: 0.6, hitAt: 0.38 });
  step(BASE, 14);
  const result = checkSoldierScale(vm, key);
  ok(vm.leg.mesh.visible, `${key}: escala común ${result.scale.toFixed(4)}, guante/arma 3P ${result.third.toFixed(4)} y FP ${result.first.toFixed(4)}`);
}

// ---------- 1. piezas móviles ----------
for (const key of Object.keys(PROFILES)) {
  const p = PROFILES[key], w = vm.weapons[key];
  const R = w.roles;
  ok(!p.parts?.bolt || !!R.bolt, `${key}: la pieza declarada parts.bolt='${p.parts?.bolt}' existe en el GLB`);
  ok(!p.parts?.mag || !!R.mag, `${key}: la pieza declarada parts.mag='${p.parts?.mag}' existe en el GLB`);
  if (R.bolt && p.parts.boltTravel) {
    const travel = (b) => b.bone.position.distanceTo(b.rest) / p.parts.boltTravel;
    // en el disparo (corredera, bomba) si el perfil lo anima así
    if (p.slideKick || p.cycle) {
      const s = fresh(key); let m = 0;
      vm.event('fire', {});
      for (let i = 0; i < 60; i++) { step(s); m = Math.max(m, travel(R.bolt)); }
      ok(m > 0.6, `${key}: ${p.parts.bolt} recorre ${(m * 100).toFixed(0)} % en cada disparo`);
      const end = travel(R.bolt);
      ok(end < 0.05, `${key}: ${p.parts.bolt} vuelve tras el disparo (${(end * 100).toFixed(0)} %)`);
    }
    if (p.slideKick?.lockEmpty) {
      const s = fresh(key);
      vm.event('fire', { empty: true }); step(s, 40);
      const lock = travel(R.bolt);
      vm.event('reloadStart', { total: 1.35 });
      for (const st of p.reload.steps ?? []) vm.event('reloadStep', { name: st.step });
      vm.event('reloadEnd'); step(s, 30);
      ok(lock > 0.9 && travel(R.bolt) < 0.05, `${key}: en vacío la ${p.parts.bolt} queda atrás (${(lock * 100).toFixed(0)} %) y cae con la recarga`);
    }
    // en la recarga (palanca, cerrojo, bombeo final)
    const s = fresh(key), T = reloadTotal(key);
    let m = 0;
    vm.event('reloadStart', { total: T });
    const N = Math.round(T * 60);
    if (p.reload.perShell) {
      for (let sh = 0; sh < 2; sh++) for (let i = 1; i <= N; i++) { s.reloadT = i / N < 1 ? i / N : 0; if (i === N) vm.event('reloadStep', { name: 'shellIn' }); step(s); m = Math.max(m, travel(R.bolt)); }
      vm.event('reloadStep', { name: 'pump' }); vm.event('reloadEnd');
    } else {
      let prev = 0;
      for (let i = 1; i <= N; i++) { const t = i / N; for (const st of p.reload.steps ?? []) if (st.t > prev && st.t <= t) vm.event('reloadStep', { name: st.step }); prev = t; s.reloadT = t < 1 ? t : 0; if (t >= 1) vm.event('reloadEnd'); step(s); m = Math.max(m, travel(R.bolt)); }
    }
    for (let i = 0; i < 40; i++) { step(s); m = Math.max(m, travel(R.bolt)); }
    const hasBoltTrack = (p.reloadEmpty ?? p.reload)?.tracks?.bolt || p.reload.perShell?.outro?.tracks?.bolt;
    if (hasBoltTrack) ok(m > 0.6, `${key}: ${p.parts.bolt} se mueve en la recarga (${(m * 100).toFixed(0)} %)`);
  }
  if (R.mag && p.targets?.mag) {
    const s = fresh(key), T = reloadTotal(key);
    const rest = R.mag.bone.position.clone();
    let m = 0;
    vm.event('reloadStart', { total: T });
    const N = Math.round(T * 60);
    let prev = 0;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      if (p.reload.perShell) { s.reloadT = t < 1 ? t : 0; } else { for (const st of p.reload.steps ?? []) if (st.t > prev && st.t <= t) vm.event('reloadStep', { name: st.step }); prev = t; s.reloadT = t < 1 ? t : 0; }
      step(s);
      m = Math.max(m, R.mag.bone.scale.x < 1e-6 ? 1 : R.mag.bone.position.distanceTo(rest));
    }
    ok(m > 0.02, `${key}: la munición (${p.parts.mag}) sale de su sitio en la recarga (${(m * 100).toFixed(1)} cm)`);
  }
}

// ---------- 1b. que la pieza se LEA: recorrido proyectado y tope sujeto ----------
// Recorrido en píxeles a 1280×720 del vértice de la pieza que más se mueve en
// pantalla (caja de la pieza): ≥ 12 px en cadera y ≥ 6 px en ADS (en ADS la
// pieza se mueve hacia el ojo y se acorta; el sniper en ADS va al scope).
// Tope: en cada disparo la pieza llega al 95 % y lo sostiene ≥ 2 cuadros de 60 Hz.
{
  camera.aspect = 1280 / 720; camera.updateProjectionMatrix();
  const rows = [];
  for (const key of Object.keys(PROFILES)) {
    const p = PROFILES[key], w = vm.weapons[key], R = w.roles;
    if (!R.bolt || !p.parts?.boltTravel) continue;
    const node = assets[key].getObjectByName(p.parts.bolt);
    const box = new THREE.Box3().setFromObject(node); box.translate(node.position.clone().negate());
    const ax = new THREE.Vector3(...p.parts.boltAxis).multiplyScalar(p.parts.boltTravel);
    const res = {};
    for (const aim of [0, 1]) {
      if (aim && (p.scope ?? key === 'sniper')) continue;
      const s = fresh(key); s.aim01 = aim; step(s, 120);
      updateViewModelProjection(camera);
      const P = viewModelUniforms.uVMProj.value;
      const pr = (c) => { const v = vm.arms.rig.gunPoint(c.toArray(), new THREE.Vector3()); if (v.z > -0.02) return null; v.applyMatrix4(P); return [v.x * 640, v.y * 360]; };
      let m = 0;
      for (let i = 0; i < 8; i++) {
        const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).add(R.bolt.rest);
        const A0 = pr(c), B0 = pr(c.clone().add(ax));
        if (A0 && B0) m = Math.max(m, Math.hypot(A0[0] - B0[0], A0[1] - B0[1]));
      }
      res[aim ? 'ADS' : 'cadera'] = m;
      ok(m >= (aim ? 6 : 12), `${key}: ${p.parts.bolt} recorre ${m.toFixed(1)} px en ${aim ? 'ADS' : 'cadera'} a 1280×720 (≥ ${aim ? 6 : 12})`);
    }
    if (p.slideKick || p.cycle) {
      const s = fresh(key); let hold = 0, best = 0;
      vm.event('fire', {});
      for (let i = 0; i < 60; i++) { step(s); const t = R.bolt.bone.position.distanceTo(R.bolt.rest) / p.parts.boltTravel; hold = t >= 0.95 ? hold + 1 : 0; best = Math.max(best, hold); }
      ok(best >= 2, `${key}: ${p.parts.bolt} sostiene el tope ${best} cuadros de 60 Hz por disparo (≥ 2)`);
    }
    rows.push(`${key} ${Object.entries(res).map(([k, v]) => `${k} ${v.toFixed(1)} px`).join(', ')}`);
  }
  camera.aspect = 16 / 9; camera.updateProjectionMatrix();
}

// ---------- 2. scopeIn01 presente ----------
{
  const key = 'sniper';
  if (vm.weapons[key]) {
    let s = fresh(key);
    s.aim01 = 1;
    let prev = 0, mono = true, v = 0;
    for (let i = 0; i < 120; i++) { step(s); v = vm.scopeIn01(); if (v < prev - 1e-9) mono = false; prev = v; }
    ok(v >= 0.98 && mono, `sniper: scopeIn01 sube de forma monótona hasta ${v.toFixed(2)} al apuntar`);
    for (const [name, apply] of [
      ['pared', (st) => { st.wallNear = 1; }],
      ['recarga', () => vm.event('reloadStart', { total: 2.2 })],
      ['cambio', () => vm.event('swapStart', { total: 0.55 })],
      ['golpe', () => vm.event('meleeStart', { total: 0.6, hitAt: 0.4 })],
      ['sprint', (st) => { st.sprint = true; st.aim01 = 0; }],
    ]) {
      s = fresh(key); s.aim01 = 1; step(s, 120);
      apply(s);
      let mono2 = true; prev = vm.scopeIn01();
      for (let i = 0; i < 40; i++) { step(s); const x = vm.scopeIn01(); if (x > prev + 1e-9) mono2 = false; prev = x; }
      ok(prev < 0.2 && mono2, `sniper: scopeIn01 cae a ${prev.toFixed(2)} con ${name} (monótono al bajar)`);
    }
  }
}

// ---------- 3. balanceo según el ajuste ----------
for (const key of ['smg', 'pistol']) {
  const amp = (bob) => {
    const s = fresh(key); s.speed = 4.8; s.bob = bob; s.yawRate = 0; step(s, 60);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 120; i++) { step(s); const y = vm.anim.out.gun[1]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
    return hi - lo;
  };
  const a1 = amp(1), a0 = amp(0), aR = amp(0.25);
  ok(a0 < a1 * 0.05 && aR < a1 * 0.4, `${key}: balanceo al andar ${(a1 * 1000).toFixed(1)} mm → ${(aR * 1000).toFixed(1)} mm (movimiento reducido) → ${(a0 * 1000).toFixed(2)} mm (bob 0)`);
}

// ---------- 4. pausa: 600 actualizaciones con dt = 0 a mitad de cada gesto ----------
// Todo nodo del arma y de los brazos debe quedar BIT A BIT igual.
{
  const snap = () => { const out = []; vm.root.traverse((o) => { out.push(...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()); }); out.push(...vm.anim.out.gun); return out; };
  const GESTURES = {
    cambio: () => vm.event('swapStart', { total: 0.55 }),
    recarga: (s) => { vm.event('reloadStart', { total: 1.9 }); s.reloadT = 0.3; },
    lanzamiento: () => vm.event('throwStart', { total: 0.8, release: 0.6 }),
    golpe: () => vm.event('meleeStart', { total: 0.6, hitAt: 0.4 }),
    'subida a ADS': (s) => { s.aim01 = 1; },
  };
  for (const key of ['smg', 'shotgun', 'sniper']) for (const [name, start] of Object.entries(GESTURES)) {
    const s = fresh(key); s.speed = 4.8; start(s); step(s, 8);
    const a0 = snap();
    step(s, 600, 0);
    const a1 = snap();
    let diff = 0; for (let i = 0; i < a0.length; i++) diff = Math.max(diff, Math.abs(a0[i] - a1[i]));
    ok(diff === 0 && a0.length === a1.length, `pausa a mitad de ${name} (${key}): 600 actualizaciones con dt = 0, ${a0.length} valores idénticos (máx. dif. ${diff})`);
  }
}

// ---------- 4b. un gesto, un inicio ----------
{
  const s = fresh('smg');
  vm.event('reloadStart', { total: 1.9, id: 7 }); step(s, 5);
  const u0 = vm.anim.acts.at(-1).u;
  vm.event('reloadStart', { total: 1.9, id: 7 }); step(s, 1);
  const n = vm.anim.acts.filter((a) => a.name === 'reload' && !a.out).length;
  vm.event('meleeStart', { total: 0.6 }); vm.event('meleeStart', { total: 0.6 }); step(s, 1);
  const m = vm.anim.acts.filter((a) => a.name === 'melee' && !a.out).length;
  ok(n === 1 && vm.anim.acts.find((a) => a.name === 'reload').u > u0 && m === 1, `inicios repetidos del mismo gesto: una sola acción (recarga ${n}, golpe ${m})`);
}

// ---------- 5a. mira renderizada ----------
{
  let worst = 0, where = '';
  for (const key of Object.keys(PROFILES)) {
    const w = vm.weapons[key];
    if (!w.anchors.sight_rear || !w.anchors.sight_front || PROFILES[key].thrown) continue;
    for (const fov of [60, 72, 100]) for (const [W, H] of [[1440, 1080], [1920, 1080], [2520, 1080]]) {
      camera.fov = fov; camera.aspect = W / H; camera.updateProjectionMatrix();
      const s = fresh(key); s.aim01 = 1; step(s, 150);
      updateViewModelProjection(camera);
      for (const n of ['sight_rear', 'sight_front']) {
        // (a) con la proyección del arma, (b) el punto del mundo que la cámara del juego pinta ahí
        const c = vm.anchorCam(n, new THREE.Vector3());
        const a = c.clone().applyMatrix4(viewModelUniforms.uVMProj.value);
        const b = viewModelToMainView(c.clone(), camera).applyMatrix4(camera.projectionMatrix);
        for (const q of [a, b]) {
          const px = Math.hypot(q.x * W / 2, q.y * H / 2);
          if (px > worst) { worst = px; where = `${key} FOV ${fov} ${W}×${H} ${n}`; }
        }
      }
    }
  }
  camera.fov = 72; camera.aspect = 16 / 9; camera.updateProjectionMatrix();
  ok(worst < 1e-6, `mira renderizada en el centro: peor ${worst.toFixed(3)} px (${where || '—'}) en armas × FOV 60/72/100 × 4:3/16:9/21:9`);
}

// ---------- 5b. pared pegada ----------
{
  let worst = -Infinity, where = '';
  for (const key of Object.keys(PROFILES)) {
    const w = vm.weapons[key];
    for (const aim of [0, 1]) for (const D of [0.3, 0.4, 0.5]) {
      const s = fresh(key); s.aim01 = aim;
      for (let i = 0; i < 120; i++) {
        // como el adaptador: rayo del ojo hacia la boca; la pared a D delante
        // como el adaptador: la boca de reposo (cadera/ADS) contra una pared a D
        const m = _v.copy(w.probe.hip).lerp(w.probe.ads, Math.min(1, Math.max(0, vm.anim.aim)));
        const reach = m.length() + 0.13, cos = Math.max(0.2, -m.z / m.length()), hit = D / cos;
        s.wallNear = hit < reach ? Math.min(1, (reach - hit) / Math.max(0.1, reach - 0.3)) : 0;
        step(s);
      }
      // la parte más adelantada del arma visible (anclas y pivotes de las piezas)
      let front = 0;
      const pts = [...Object.values(w.anchors), ...Object.values(w.partBones).filter((b) => b.bone.scale.x > 0).map((b) => b.rest.toArray())];
      for (const a of pts) front = Math.max(front, -vm.arms.rig.gunPoint(a, _v).z);
      const over = front - D; if (process.env.DEBUG) console.log('   ', key, aim, D, front.toFixed(3));
      if (over > worst) { worst = over; where = `${key} ${aim ? 'ADS' : 'cadera'} pared a ${D} m: punta a ${front.toFixed(3)} m`; }
    }
  }
  ok(worst <= 0, `pared pegada: ninguna arma la cruza (peor margen ${(worst * 100).toFixed(1)} cm; ${where})`);
}

// La cobertura y el asomo no separan las dos referencias de puntería.
{
  const s = fresh('smg');
  updateViewModelProjection(camera);
  ok(!vm.sightsAligned(1080), 'punto del HUD a plena opacidad con el arma en cadera');
  Object.assign(s, { aim01: 1, crouch01: 0.6, lean: -1, wallNear: 0.4 });
  step(s, 150);
  ok(vm.sightsAligned(1080), 'alza y guion a menos de un píxel del centro al asomar junto al muro');
  vm.event('fire'); step(s, 2);
  ok(!vm.sightsAligned(1080), 'el retroceso desalineado devuelve el punto del HUD');
}

// ---------- 5c. tamaño y posición en pantalla ----------
{
  // HUD (src/ui/hud-layout.js): vida+munición abajo a la izquierda, marcador
  // arriba al centro. Para la retícula se prueban los triángulos visibles:
  // el hueco entre una manga diagonal y la mira forma parte del rectángulo.
  const HUD = [{ x0: 0, y0: 0.78, x1: 0.33, y1: 1 }, { x0: 0.38, y0: 0, x1: 0.62, y1: 0.13 }];
  const inter = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const rows = [];
  for (const key of Object.keys(PROFILES)) for (const [W, H] of [[1440, 1080], [1920, 1080], [2520, 1080]]) {
    camera.aspect = W / H; camera.updateProjectionMatrix();
    fresh(key);
    const r = vm.screenRect(key);
    const mask = silhouette(vm, viewModelUniforms.uVMProj.value, Math.round(270 * W / H), 270);
    const { body, sleeve } = vm.hudZones();
    const inside = (i, rect) => {
      const x = (i % mask.width + 0.5) / mask.width;
      const y = (Math.floor(i / mask.width) + 0.5) / mask.height;
      return rect && x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
    };
    const leftArm = mask.names.map(name => /^fp_(fore_L$|hand_L$|L_)/.test(name));
    // Bajo la bomba, el guante puede quedar a la derecha de la boca del cañón.
    ok(body &&
      mask.gun.every((covered, i) => !covered || inside(i, body)) &&
      mask.owner.every((id, i) => !leftArm[id] || inside(i, sleeve)),
      `${key} ${W}×${H}: el cuerpo y el guante izquierdo contienen sus propios píxeles`);
    const onReticle = mask.owner.some((id, i) => id && Math.abs((i % mask.width + 0.5) / mask.width - 0.5) < 0.03
      && Math.abs((Math.floor(i / mask.width) + 0.5) / mask.height - 0.5) < 0.05);
    const width = r.x1 - r.x0;
    const good = r.y0 >= 0.4 && width >= 0.08 && width <= 0.7 && !onReticle && !HUD.some((h) => inter(r, h));
    rows.push(`${key} ${W}×${H}: x ${r.x0.toFixed(2)}–${r.x1.toFixed(2)} y ${r.y0.toFixed(2)}–${r.y1.toFixed(2)}`);
    if (!good) ok(false, `pantalla: ${rows.at(-1)} fuera de límites o sobre el HUD`);
  }
  camera.aspect = 16 / 9; camera.updateProjectionMatrix();
  console.log('     ' + rows.join('\n     '));
  ok(true, `pantalla: ${rows.length} combinaciones arma × aspecto medidas`);
}

// ---------- 5d. separación mano–agarre durante interrupciones ----------
{
  const center = (side, out) => {
    const o = vm.arms.rig.out[side], h = vm.arms.rig.hands[side];
    return out.set(...h.grip.center).multiply(o.hand.scale).applyQuaternion(o.hand.quat).add(o.hand.pos);
  };
  // Cada caso dispara su interrupción cuando el tiempo CRUZA su instante
  // (t0 < T ≤ t1), a cualquier frecuencia, y cuenta si se ejecutó.
  const cross = (t0, t1, T) => t0 < T && T <= t1;
  const SEQ = {
    'esquiva lateral': (s, t0, t1, done) => {
      s.dodge = t1 < 0.3 ? dodgeFX({ t: t1, x: 1, z: 0 }, 0, { bob: 1, shake: 1 }) : null;
      if (cross(t0, t1, 0.3)) done();
    },
    'recarga→cambio': (s, t0, t1, done) => { if (t0 < 0) vm.event('reloadStart', { total: 1.5 }); if (t1 < 0.6) s.reloadT = t1 / 1.5; if (cross(t0, t1, 0.6)) { s.reloadT = 0; vm.event('reloadCancel'); vm.event('swapStart', { total: 0.55 }); done(); } },
    'recarga→golpe': (s, t0, t1, done) => { if (t0 < 0) vm.event('reloadStart', { total: 1.5 }); if (t1 < 0.5) s.reloadT = t1 / 1.5; if (cross(t0, t1, 0.5)) { s.reloadT = 0; vm.event('reloadCancel'); vm.event('meleeStart', { total: 0.6, hitAt: 0.4 }); done(); } },
    'recarga→sprint': (s, t0, t1, done) => { if (t0 < 0) vm.event('reloadStart', { total: 1.5 }); if (t1 < 0.4) s.reloadT = t1 / 1.5; if (cross(t0, t1, 0.4)) { s.reloadT = 0; vm.event('reloadCancel'); s.sprint = true; s.speed = 7; done(); } },
    'recarga→muerte': (s, t0, t1, done) => { if (t0 < 0) vm.event('reloadStart', { total: 1.5 }); if (t1 < 0.7) s.reloadT = t1 / 1.5; if (cross(t0, t1, 0.7)) { s.reloadT = 0; s.dead = true; } if (cross(t0, t1, 1.2)) { s.dead = false; vm.event('draw', { total: 0.33 }); done(); } },
    'lanzamiento cortado': (s, t0, t1, done) => { if (t0 < 0) vm.event('throwStart', { total: 0.8, release: 0.6 }); if (cross(t0, t1, 0.3)) { vm.event('swapStart', { total: 0.55 }); done(); } },
  };
  const executed = { 30: 0, 60: 0, 144: 0 }, declared = { 30: 0, 60: 0, 144: 0 };
  const out = [];
  let worstR = 0, worstL = 0, whereL = '';
  const jerk = { 30: { v: 0, at: '' }, 60: { v: 0, at: '' }, 144: { v: 0, at: '' } };
  for (const hz of [30, 60, 144]) {
    const dt = 1 / hz;
    for (const key of Object.keys(PROFILES)) {
      const p = PROFILES[key];
      const lOnAnchor = !!p.targets[p.grips.left.target]?.anchor;
      for (const [name, fn] of Object.entries(SEQ)) {
        const s = fresh(key);
        let held = 0, derechaAsentada = 0;
        let prevL = null, prevV = null, did = false;
        declared[hz]++;
        for (let i = 0; i < Math.round(2.4 * hz); i++) {
          fn(s, i === 0 ? -1 : (i - 1) * dt, i * dt, () => { did = true; });
          if (s.dead) { vm.update(dt, s, false); continue; }
          vm.update(dt, s);
          const a = vm.anim.out;
          derechaAsentada = a.boltHand > 0 ? 0 : derechaAsentada + dt;
          if (!p.scope || derechaAsentada >= .35) worstR = Math.max(worstR, center('R', _v).distanceTo(vm.arms.rig.out.R.target));
          // tirón de la mano izquierda en el marco del arma (m/s²), a cualquier frecuencia
          const gq = vm.arms.rig.gunQuat.clone().invert();
          const cl = center('L', new THREE.Vector3()).sub(vm.arms.rig.gunPos).applyQuaternion(gq);
          if (prevL) {
            const v = cl.clone().sub(prevL).multiplyScalar(1 / dt);
            if (prevV) { const acc = v.distanceTo(prevV) / dt; if (acc > jerk[hz].v) jerk[hz] = { v: acc, at: `${key} ${name}` }; }
            prevV = v;
          }
          prevL = cl;
          // izquierda: "en el agarre" cuando su objetivo de reposo manda (≥ 0.99) hace ≥ 0.35 s (el trayecto de vuelta desde la cartuchera, ~0.4 m a ≤ 1.9 m/s y ≤ 40 m/s², tarda ~0.3 s)
          held = a.left[0] >= 0.99 && lOnAnchor ? held + dt : 0;
          if (held >= 0.35) {
            const d = center('L', _v).distanceTo(vm.arms.rig.out.L.target);
            if (d > worstL) { worstL = d; whereL = `${key} ${name} ${hz} Hz`; }
          }
        }
        if (did) executed[hz]++;
      }
    }
    out.push(hz);
  }
  // 72 m/s² = 2 cm/cuadro² a 60 Hz: el seguidor de la mano acota 40 m/s²; el
  // resto es el giro de la mano (centro del agarre a ≤ 4 cm)
  for (const hz of [30, 60, 144]) ok(jerk[hz].v < 72, `${hz} Hz: aceleración máx. de la mano izquierda en el marco del arma ${jerk[hz].v.toFixed(0)} m/s² (< 72; ${jerk[hz].at})`);
  for (const hz of [30, 60, 144]) ok(executed[hz] === declared[hz], `${hz} Hz: casos de interrupción ejecutados ${executed[hz]}/${declared[hz]}`);
  ok(worstR < 0.001, `interrupciones a ${out.join('/')} Hz: mano derecha en la empuñadura (peor ${(worstR * 1000).toFixed(2)} mm)`);
  ok(worstL < 0.01, `interrupciones a ${out.join('/')} Hz: mano izquierda de vuelta en su agarre (peor ${(worstL * 1000).toFixed(1)} mm; ${whereL || '—'})`);
}

// Una muñeca puede estar en su ancla aunque todos sus dedos floten.
// Medir la superficie de cada falange distal en la pose que se dibuja.
{
  for (const [key, profile] of Object.entries(PROFILES)) {
    fresh(key);
    const w = vm.weapons[key], piezas = surfaces(w.mesh), apoyo = apoyosDelArma(vm, w, piezas);
    for (const lado of ['L', 'R']) {
      if (lado === 'L' && (!profile.targets.forend.anchor || profile.grips.left.pose === 'libre')) continue;
      for (const dedo of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
        const d = 1000 * distanciaYema(vm, lado, dedo, apoyo(lado, dedo));
        ok(d <= 1, `${key}: ${lado} ${dedo} a ${d.toFixed(3)} mm de su apoyo`);
      }
    }
    if (w.roles.trigger) {
      vm.event('fire');
      step({ ...BASE, fireHeld: true }, 25);
      const d = 1000 * distanciaYema(vm, 'R', 'index', [piezas.get(w.roles.trigger.bone)]);
      ok(d <= 1, `${key}: índice a ${d.toFixed(3)} mm del gatillo presionado`);
    }
  }
}

// En la pistola el cargador tiene que pasar dos veces por el mismo brocal.
// Una trayectoria lateral sigue siendo posible cuando ya está fuera.
for (const [key, profile] of Object.entries(PROFILES)) {
  const guide = profile.parts?.magGuide;
  if (!guide) continue;
  const w = vm.weapons[key], mag = w.roles.mag;
  const axis = new THREE.Vector3(...guide.axis).normalize();
  for (const hz of [30, 60, 144]) {
    const state = fresh(key), total = reloadTotal(key), frames = Math.ceil(total * hz);
    vm.event('reloadStart', { total });
    let outgoing = false, incoming = false, free = false, maxDrift = 0, maxAngle = 0;
    for (let i = 1; i <= frames; i++) {
      state.reloadT = Math.min(1, i / hz / total);
      for (const { t, step } of profile.reload.steps) {
        if ((i - 1) / hz / total < t && state.reloadT >= t) vm.event('reloadStep', { name: step });
      }
      vm.update(1 / hz, state);
      const delta = w.model.worldToLocal(mag.bone.getWorldPosition(new THREE.Vector3())).sub(mag.rest);
      const travel = delta.dot(axis);
      if (travel > guide.clear + guide.blend) free = true;
      if (travel < 0.012 || travel > guide.clear - 0.012) continue;
      if (free) incoming = true; else outgoing = true;
      const drift = delta.addScaledVector(axis, -travel).length();
      const angle = w.pivot.quaternion.angleTo(mag.bone.quaternion);
      maxDrift = Math.max(maxDrift, drift);
      maxAngle = Math.max(maxAngle, angle);
    }
    ok(outgoing && incoming && maxDrift < 0.001 && maxAngle < 0.001, `${key}: cargador alineado al salir y al entrar a ${hz} Hz`);
  }
}

{
  const state = fresh('smg'), bote = vm.arms.grenade;
  vm.event('throwStart', { total: 0.8, release: 0.66 });
  step(state, 22);
  ok(bote.visible && bote.material === vm.weapons.smg.mesh.material
    && bote.skeleton.bones[0].parent === vm.arms.seg.L.hand, 'Lanzamiento rápido con el bote en el guante izquierdo');
  vm.event('throwRelease');
  step(state);
  ok(!bote.visible, 'La mano deja de dibujar el bote al soltarlo');
}

if (fail) { console.log(`\n${fail} fallo(s)`); process.exit(1); }
console.log('\ncheck-fps-view: todo bien');
