// PRIMERA PERSONA — prototipo local para probar la sensación (rama
// experiment/first-person). Apagado por defecto: sin `?fp=1` ni la
// preferencia guardada, nada de este módulo toca cámara, disparo ni dibujo.
//
// Tres piezas:
//  · el modo (URL, localStorage `breach.view`, tecla de cambio y aviso);
//  · la cámara a la altura de los ojos: sale de hitPose() (la cabeza
//    calibrada por estado/exposición/asomado/fase, en el marco del cuerpo),
//    NO del hueso animado de la cabeza — el rig se mece y marearía;
//  · el arma en primera persona ("view model"): el modelo real del arma en
//    mano (la misma geometría horneada del rig) con manos de bloques, y una
//    animación procedural corta leída del estado real (recarga, cambio,
//    golpe, lanzamiento, retroceso).
// El rig del jugador se sigue simulando entero (sombra, red, volúmenes de
// impacto, bots); solo deja de dibujarse para su propia cámara.
import * as THREE from 'three';
import { hitPose, STAND } from '../combat/hit-pose.js';
import { soldierMaterial, SOLDIER_TEAM } from '../player/soldier-bake.js';
import { TUNING } from '../config/tuning.js';
import { SWAP_TIME } from '../combat/weapons.js';
import { BINDS, keyLabel } from '../core/bindings.js';
import { t } from '../core/i18n.js';

// ---------- constantes para afinar ----------
export const FP_FOV = 66;          // FOV vertical en hip (≈100° horizontales a 16:9)
export const FP_FOV_ADS = 50;      // FOV vertical apuntando (el scope del sniper usa el suyo, 20°)
export const FP_NEAR = 0.04;       // plano cercano: pegado a una pared (radio 0.4) no se recorta
export const FP_EYE_FORWARD = 0.1; // ojos delante del centro del casco, hacia donde mira la cámara
export const FP_EYE_COVER_BACK = -0.12; // escondido en cover: ojos algo atrás (el parapeto no llena la vista)
export const FP_EYE_DROP = 0.04;   // ojos un poco por debajo del centro de la esfera de cabeza
export const FP_EYE_LERP = 14;     // suavizado de la postura (agacharse, asomarse, levantarse)
export const FP_TURN_DEG = 1440;   // giro del cuerpo hacia la vista (°/s): bloqueado a la mira
export const FP_TOGGLE_KEY = 'KeyP';
export const FP_PREF_KEY = 'breach.view';

const DEG = Math.PI / 180;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// Postura del arma por arma, en espacio de cámara (x derecha, y arriba, -z
// delante): `s` escala sobre la del rig (el modelo a tamaño real taparía
// media pantalla), `hip`/`ads` = dónde va la empuñadura, `adsX` corre el arma
// en ADS (la bazuca va al hombro, no en el eje de la vista).
const VM = {
  smg:     { s: 0.4, hip: [0.17, -0.185, -0.44], adsZ: -0.34, adsX: 0 },
  shotgun: { s: 0.37, hip: [0.17, -0.19, -0.42], adsZ: -0.33, adsX: 0 },
  pistol:  { s: 0.42, hip: [0.13, -0.165, -0.46], adsZ: -0.42, adsX: 0 },
  stun:    { s: 0.42, hip: [0.13, -0.165, -0.46], adsZ: -0.42, adsX: 0 },
  sniper:  { s: 0.34, hip: [0.17, -0.185, -0.4], adsZ: -0.3, adsX: 0 },
  bazooka: { s: 0.38, hip: [0.2, -0.16, -0.3], adsZ: -0.24, adsX: 0.1 },
  grenade: { s: 0.6, hip: [0.17, -0.18, -0.42], adsZ: -0.4, adsX: 0.07 },
  frag:    { s: 0.6, hip: [0.17, -0.18, -0.42], adsZ: -0.4, adsX: 0.07 },
};
// Los arrojadizos van en una mano: la izquierda no se dibuja.
const ONE_HAND = new Set(['grenade', 'frag']);

function readPref() {
  try {
    const q = new URLSearchParams(location.search).get('fp');
    if (q === '1' || q === '0') {
      localStorage.setItem(FP_PREF_KEY, q === '1' ? 'fp' : 'tp');
      return q === '1';
    }
    return localStorage.getItem(FP_PREF_KEY) === 'fp';
  } catch { return false; }
}

// ---------- manos de bloques ----------
// Soldado de juguete: pocas cajas, guante oscuro, protector de antebrazo del
// color del equipo (como hombreras y casco del rig).
const BOX = new THREE.BoxGeometry(1, 1, 1);
const HAND_SCALE = 1.35; // manos al tamaño de las armas a ~0.45 m de la lente
function handMaterials(team) {
  const hex = SOLDIER_TEAM[team] ?? SOLDIER_TEAM.red;
  const teamCol = new THREE.Color(hex);
  return {
    glove: new THREE.MeshStandardMaterial({ name: 'fp glove', color: 0x26292d, roughness: 0.86, metalness: 0 }),
    plate: new THREE.MeshStandardMaterial({ name: 'fp knuckle', color: 0x4a5056, roughness: 0.42, metalness: 0.5 }),
    sleeve: new THREE.MeshStandardMaterial({ name: 'fp sleeve', color: 0x3b3f44, roughness: 0.9, metalness: 0 }),
    // protector de antebrazo: cerámica gris (la armadura neutra del rig) y
    // una franja del equipo, como las placas del cuerpo
    armor: new THREE.MeshStandardMaterial({ name: 'fp vambrace', color: 0x6c7073, roughness: 0.58, metalness: 0.08 }),
    team: new THREE.MeshStandardMaterial({ name: 'fp team stripe', color: teamCol.clone().multiplyScalar(0.7),
      roughness: 0.5, metalness: 0.12, emissive: teamCol.clone().multiplyScalar(0.12) }),
  };
}
function block(mat, sx, sy, sz, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  m.castShadow = false; m.receiveShadow = false;
  return m;
}
function makeHand(mats, left) {
  const s = left ? -1 : 1;
  const hand = new THREE.Group();
  hand.add(block(mats.glove, 0.05, 0.062, 0.072, 0.004 * s, -0.006, 0.006));       // palma
  hand.add(block(mats.glove, 0.056, 0.03, 0.05, 0.002 * s, 0.022, -0.03));         // dedos cerrados
  hand.add(block(mats.plate, 0.044, 0.016, 0.042, 0.004 * s, 0.038, -0.018));      // placa de nudillos
  hand.add(block(mats.glove, 0.02, 0.022, 0.046, -0.026 * s, 0.012, -0.022));      // pulgar
  hand.scale.setScalar(HAND_SCALE);
  const arm = new THREE.Group();
  // largo 1 en z (de 0 a 1): se estira de la muñeca al codo
  arm.add(block(mats.sleeve, 0.058, 0.058, 1, 0, 0, 0.5));
  arm.add(block(mats.armor, 0.066, 0.064, 0.26, 0, 0.004, 0.2));
  arm.add(block(mats.team, 0.068, 0.066, 0.035, 0, 0.004, 0.09));
  return { hand, arm };
}

class ViewModel {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'fp-viewmodel';
    this.root.visible = false;
    scene.add(this.root);
    this.gun = new THREE.Group();
    this.gunMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    this.gunMesh.castShadow = false; this.gunMesh.receiveShadow = false;
    this.gunMesh.frustumCulled = false;
    this.gun.add(this.gunMesh);
    this.root.add(this.gun);
    this.team = null; this.mats = null;
    this.R = null; this.L = null;
    this.key = null; this.src = null; this.cfg = VM.smg;
    this.topY = 0.15;
  }

  setTeam(team) {
    if (this.team === team) return;
    this.team = team;
    for (const h of [this.R, this.L]) if (h) { h.hand.removeFromParent(); h.arm.removeFromParent(); }
    if (this.mats) for (const m of Object.values(this.mats)) m.dispose();
    this.mats = handMaterials(team);
    this.R = makeHand(this.mats, false); this.L = makeHand(this.mats, true);
    for (const h of [this.R, this.L]) this.root.add(h.hand, h.arm);
    this.key = null; // el material del arma también cambia de equipo
  }

  // Arma en mano = la del rig (misma geometría fusionada y mismos sockets);
  // material del equipo COMPARTIDO: sin el fundido del soldado propio.
  setWeapon(rig, wep) {
    const src = rig._gunModel(wep);
    const baked = src?.userData.bakedMesh;
    if (!baked) return false;
    const key = wep + ':' + baked.geometry.uuid + ':' + rig.team;
    if (key === this.key && src === this.src) return true;
    this.key = key; this.src = src; this.wep = wep;
    this.cfg = VM[wep] ?? VM.smg;
    this.gunMesh.geometry = baked.geometry;
    this.gunMesh.material = soldierMaterial(rig.team);
    this.gun.scale.copy(src.scale).multiplyScalar(this.cfg.s);
    if (!baked.geometry.boundingBox) baked.geometry.computeBoundingBox();
    this.topY = baked.geometry.boundingBox.max.y;
    return true;
  }

  anchor(name) {
    const u = this.src.userData;
    return (u[name] ?? u.grip).position;
  }
}

// ---------- el modo ----------
export class FirstPerson {
  /**
   * ctx: { scene, camera, world, G, hint(text, ms), canToggle() }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = readPref();
    this.live = false;          // la cámara de ESTE cuadro es la de los ojos
    this.eye = new THREE.Vector3();
    this._off = new THREE.Vector3();
    this._py = 0;
    this._first = true;
    this._near3p = ctx.camera.near;
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._u = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._z = new THREE.Vector3(0, 0, 1);
    this.vm = null; // se crea al primer uso: con el modo apagado la escena no cambia
    // estado de la animación procedural
    this.a = { ads: 0, sprint: 0, act: 0, blind: 0, blindSide: 0, reload: 0, bob: 0, bobK: 0,
      swayX: 0, swayY: 0, kick: 0, recoilSeen: 0, retract: 0, prevYaw: null, prevPitch: 0,
      pos: new THREE.Vector3(), rot: new THREE.Vector3(), time: 0 };
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  // la tecla solo cambia de vista si no está asignada a otra acción
  get toggleKey() { return Object.values(BINDS.kb).includes(FP_TOGGLE_KEY) ? null : FP_TOGGLE_KEY; }

  _onKey(e) {
    if (e.code !== FP_TOGGLE_KEY || e.repeat || e.metaKey || e.ctrlKey) return;
    if (e.target && e.target.tagName === 'INPUT') return;
    if (!this.toggleKey || !this.ctx.canToggle()) return;
    this.setEnabled(!this.enabled);
  }

  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem(FP_PREF_KEY, this.enabled ? 'fp' : 'tp'); } catch { /* sin almacenamiento */ }
    this._first = true;
    this._told = true;
    this._notice();
  }

  _notice() {
    const key = keyLabel(this.toggleKey ?? FP_TOGGLE_KEY);
    this.ctx.hint(t(this.enabled ? 'msg.viewFirst' : 'msg.viewThird', { key }), 2200);
  }

  // ¿Toma la cámara este cuadro? Muerto = no: la cámara de hombro enseña la
  // reacción de muerte y luego el espectador, como siempre.
  claim(player) { return this.enabled && !!player && !player.dead; }

  // Lo llama ShoulderCamera.update al soltar la vista (muerte, cambio a 3P).
  release(sc) {
    const cam = this.ctx.camera;
    if (cam.near !== this._near3p) { cam.near = this._near3p; cam.updateProjectionMatrix(); }
    sc.fovRef = undefined;
    this._first = true;
    this.live = false;
    if (this.vm) this.vm.root.visible = false;
  }

  // ---------- cámara en los ojos ----------
  updateCamera(dt, player, sc) {
    const { camera, world, G } = this.ctx;
    const st = player.animState(), ap = player.animParams();
    // Vuelta en el aire: la cabeza calibrada da la vuelta entera; aquí solo
    // se baja el ojo (sin mortal ni roll de cámara).
    let vol, drop = 0, tilt = 0;
    if (st === 'flip') { vol = STAND; drop = 0.36 * Math.sin(Math.PI * clamp01(ap.flipT)); }
    else {
      vol = hitPose({ st, aim: player.aim, ce: player.coverAimExposure, cl: player.coverLeanAnim || 0,
        pitch: sc.pitch, phase: st === 'dive' ? ap.evadePhase : st === 'mantle' ? ap.mantlePhase : undefined,
        wep: G.weapons?.cur });
    }
    if (st === 'dive') tilt = -6 * DEG * Math.sin(Math.PI * clamp01(ap.evadePhase));
    else if (st === 'slide') tilt = -3 * DEG;
    const yaw = player.yaw, h = vol.h;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const cf = sc.flatForward();
    // escondido en cover (sin apuntar) los ojos van un poco atrás, dentro de
    // la esfera de cabeza: se ve el borde del parapeto y lo que asoma por encima
    const hidden = player.state === 'cover' && !player.aim;
    this._coverK = (this._coverK ?? 0) + ((hidden ? 1 : 0) - (this._coverK ?? 0)) * (this._first ? 1 : damp(8, dt));
    const fwd = FP_EYE_FORWARD + (FP_EYE_COVER_BACK - FP_EYE_FORWARD) * this._coverK;
    const tx = fx * h[0] + rx * h[1] + cf.x * fwd;
    const tz = fz * h[0] + rz * h[1] + cf.z * fwd;
    const ty = h[2] - FP_EYE_DROP - drop;
    const py = player.y ?? 0;
    // la POSTURA se suaviza (offset respecto a los pies); la posición del
    // cuerpo no, para no ir por detrás corriendo. Un escalón (salto brusco de
    // y) se suaviza aparte y rápido.
    if (this._first) { this._off.set(tx, ty, tz); this._py = py; }
    else {
      const k = damp(FP_EYE_LERP, dt);
      this._off.x += (tx - this._off.x) * k;
      this._off.y += (ty - this._off.y) * k;
      this._off.z += (tz - this._off.z) * k;
      this._py = Math.abs(py - this._py) > 0.6 ? py : this._py + (py - this._py) * damp(30, dt);
    }
    this._first = false;
    // el ojo nunca queda al otro lado de una pared: rayo desde el eje del cuerpo
    const from = this._v.set(player.pos.x, this._py + this._off.y, player.pos.z);
    const len = Math.hypot(this._off.x, this._off.z);
    let reach = 1;
    if (len > 0.01) {
      const dir = this._w.set(this._off.x / len, 0, this._off.z / len);
      const hit = world.raycast(from, dir, len + 0.1, 0);
      if (hit !== null) reach = Math.max(0, hit - 0.1) / len;
    }
    this.eye.set(from.x + this._off.x * Math.min(1, reach), from.y, from.z + this._off.z * Math.min(1, reach));
    sc.pos.copy(this.eye);
    sc.crowd = 0; sc.ghost = 0;

    // shake posicional (más suave que en 3P: la lente está en la cabeza)
    sc.shakeT += dt * 30;
    sc.shake = Math.max(0, sc.shake - dt * 3.2);
    camera.position.copy(this.eye);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(sc.yaw);
    camera.rotateX(sc.pitch + tilt);
    camera.translateX(Math.sin(sc.shakeT * 1.7) * sc.shake * 0.02);
    camera.translateY(Math.cos(sc.shakeT * 2.3) * sc.shake * 0.016);

    const fov = sc._scoped ? (sc._aimFov ?? FP_FOV_ADS) : player.aim ? FP_FOV_ADS : FP_FOV;
    sc.fov += (fov - sc.fov) * damp(TUNING.cam.fovLerp, dt);
    sc.fovRef = FP_FOV; // sensibilidad del ratón igual que en 3P a FOV de hip
    let proj = false;
    if (Math.abs(camera.fov - sc.fov) > 0.01) { camera.fov = sc.fov; proj = true; }
    if (camera.near !== FP_NEAR) { camera.near = FP_NEAR; proj = true; }
    if (proj) camera.updateProjectionMatrix();
    // la primera vez en la sesión (llegando por ?fp=1) se dice cómo volver
    if (!this._told) { this._told = true; this._notice(); }
    this.live = true;
  }

  // ---------- puntos de salida (disparo, cohete, granada) ----------
  // Muzzle del arma en primera persona (tracer, fogonazo, casquillos).
  muzzleWorld(out) {
    const vm = this.vm;
    // arma oculta (scope del sniper) o aún sin construir: delante de los ojos
    if (!vm?.src || !vm.root.visible) return this.launchPoint(out);
    vm.root.updateMatrixWorld(true);
    // el socket está en el marco del arma del rig = marco de la geometría
    return vm.gunMesh.localToWorld(out.copy(vm.anchor('muzzle')));
  }

  // Delante de la cámara, algo abajo a la derecha (mano del arma), nunca al
  // otro lado de la geometría: el cohete y la granada salen de aquí.
  launchPoint(out) {
    const cam = this.ctx.camera;
    cam.updateMatrixWorld(true);
    const p = this._u.set(0.1, -0.09, -0.5).applyMatrix4(cam.matrixWorld);
    const dir = this._w.copy(p).sub(this.eye);
    const len = dir.length();
    dir.multiplyScalar(1 / Math.max(1e-6, len));
    const hit = this.ctx.world.raycast(this.eye, dir, len + 0.1, 0);
    const d = hit === null ? len : Math.max(0, Math.min(len, hit - 0.12));
    return out.copy(this.eye).addScaledVector(dir, d);
  }

  // ---------- arma en primera persona ----------
  updateViewModel(dt, sc) {
    const { G, camera, world } = this.ctx;
    const a = this.a;
    const p = G.player, w = G.weapons, rig = G.rig;
    const show = this.live && p && rig && w && !p.dead && !sc._scoped;
    if (!show) { if (this.vm) this.vm.root.visible = false; a.prevYaw = null; return; }
    const vm = (this.vm ??= new ViewModel(this.ctx.scene));
    vm.setTeam(rig.team);
    if (!vm.setWeapon(rig, w.cur)) { vm.root.visible = false; return; }
    vm.root.visible = true;
    const cfg = vm.cfg, def = w.def;
    a.time += dt;

    // --- entradas de estado ---
    const ap = p.animParams();
    const sprinting = p.state === 'roadie' && p.grounded;
    const action = p.state === 'dive' || p.state === 'slide' || p.state === 'mantle';
    const blind = p.state === 'cover' && !p.aim && p.firingBlind > 0 && !!p.blindMode;
    a.ads += ((p.aim ? 1 : 0) - a.ads) * damp(16, dt);
    a.sprint += ((sprinting ? 1 : 0) - a.sprint) * damp(9, dt);
    a.act += ((action ? 1 : 0) - a.act) * damp(12, dt);
    a.blind += ((blind ? 1 : 0) - a.blind) * damp(14, dt);
    if (blind) a.blindSide = p.blindMode === 'over' ? 0 : p.blindMode === 'left' ? -1 : 1;
    a.reload += ((w.reloading ? 1 : 0) - a.reload) * damp(10, dt);

    // retroceso: el mismo evento que el rig (kick); se lee el incremento
    const rec = rig._recoil ?? 0;
    const expected = Math.max(0, a.recoilSeen - dt * 6);
    if (rec > expected + 0.01) a.kick = Math.min(1.4, a.kick + (rec - expected));
    a.recoilSeen = rec;
    a.kick *= Math.exp(-13 * dt);

    // balanceo por el giro de la vista (el arma va un pelo por detrás)
    if (a.prevYaw === null) { a.prevYaw = sc.yaw; a.prevPitch = sc.pitch; }
    const dYaw = angleDelta(a.prevYaw, sc.yaw), dPitch = sc.pitch - a.prevPitch;
    a.prevYaw = sc.yaw; a.prevPitch = sc.pitch;
    const inv = dt > 1e-4 ? 1 / dt : 0;
    const swayTX = Math.max(-0.03, Math.min(0.03, -dYaw * inv * 0.006));
    const swayTY = Math.max(-0.025, Math.min(0.025, -dPitch * inv * 0.006));
    a.swayX += (swayTX - a.swayX) * damp(10, dt);
    a.swayY += (swayTY - a.swayY) * damp(10, dt);

    // paso: fase por distancia recorrida (zancada), amplitud por velocidad
    const speed = p.grounded ? p.speed : 0;
    a.bob += dt * speed * (sprinting ? 1.45 : 1.75);
    a.bobK += (Math.min(1.3, speed / TUNING.move.runSpeed) - a.bobK) * damp(8, dt);

    // --- postura base: hip ↔ ADS ---
    const S = vm.gun.scale;
    const grip = vm.anchor('grip');
    const adsY = -0.012 - (vm.topY - grip.y) * S.y;
    const ads = a.ads * (sprinting ? 0 : 1);
    const pos = a.pos.set(
      cfg.hip[0] + ((cfg.adsX ?? 0) - cfg.hip[0]) * ads,
      cfg.hip[1] + (adsY - cfg.hip[1]) * ads,
      cfg.hip[2] + (cfg.adsZ - cfg.hip[2]) * ads);
    // en hip el arma converge levemente hacia el centro
    const rot = a.rot.set(0.02 * (1 - ads), 0.035 * (1 - ads), 0);

    const still = 1 - 0.75 * ads;
    // paso y respiración
    const bk = a.bobK * still * (1 + a.sprint * 0.8);
    pos.x += Math.sin(a.bob) * 0.011 * bk;
    pos.y += -Math.abs(Math.cos(a.bob)) * 0.012 * bk + Math.sin(a.time * 1.6) * 0.0018 * still;
    rot.z += Math.sin(a.bob) * 0.02 * bk;
    pos.x += a.swayX * still; pos.y += a.swayY * still;
    rot.y += a.swayX * 1.2 * still;

    // sprint: bajada y giro hacia dentro
    pos.x += -0.05 * a.sprint; pos.y += -0.06 * a.sprint; pos.z += 0.04 * a.sprint;
    rot.x += -0.38 * a.sprint; rot.y += 0.55 * a.sprint; rot.z += 0.22 * a.sprint;
    // dive / slide / mantle: manos ocupadas, arma abajo
    pos.y += -0.12 * a.act; rot.x += -0.45 * a.act;

    // blindfire: el arma sale por encima (o por el costado) del cover y el
    // ojo se queda detrás
    if (a.blind > 0.001) {
      const s = a.blindSide;
      const over = s === 0 ? 1 : 0;
      pos.x += (-0.08 * over + 0.2 * s) * a.blind;
      // por encima: arma más lejos y alta, MÁS ALLÁ de la cara del parapeto
      // (los brazos quedan tapados por él, como se vería desde detrás)
      pos.y += (0.39 * over + 0.03 * (1 - over)) * a.blind;
      pos.z += -0.18 * over * a.blind - 0.1 * (1 - over) * a.blind;
      rot.x += -0.05 * over * a.blind;
      rot.y += -0.25 * s * a.blind;
      rot.z += 0.35 * s * a.blind;
    }

    // recarga: baja, se inclina y vuelve, sobre el progreso REAL del cargador
    let leftToMag = 0;
    if (a.reload > 0.001) {
      const rt = w.reloading ? clamp01(1 - w.st.reload / Math.max(1e-3, def.reloadTime)) : 1;
      let dip;
      if (def.perShell) {
        // escopeta: el arma queda inclinada y la mano izquierda mete cada cartucho
        dip = 0.55;
        leftToMag = Math.sin(Math.PI * rt);
        pos.y += -0.012 * leftToMag * a.reload;
      } else {
        dip = smooth(rt / 0.2) * (1 - smooth((rt - 0.82) / 0.18));
        leftToMag = rt > 0.22 && rt < 0.8 ? Math.sin(Math.PI * (rt - 0.22) / 0.58) : 0;
      }
      const k = dip * a.reload;
      pos.x += -0.03 * k; pos.y += -0.07 * k; pos.z += 0.04 * k;
      rot.x += -0.12 * k; rot.y += 0.3 * k; rot.z += 0.6 * k;
      leftToMag *= a.reload;
    }

    // cambio de arma: baja hasta la mitad (ahí cambia el modelo) y sube
    if (w.swapping) {
      const u = clamp01(1 - w.swapT / SWAP_TIME), k = Math.sin(Math.PI * u);
      pos.y += -0.26 * k; pos.z += 0.04 * k; rot.x += -0.7 * k; rot.z += 0.2 * k;
    }

    // golpe: culatazo corto con la fase real del melee
    if (p.state === 'melee') {
      const u = clamp01(ap.meleePhase), hitAt = clamp01(TUNING.melee.hitAt / Math.max(1e-3, p.meleeEndT || TUNING.melee.time));
      const k = u < hitAt ? smooth(u / Math.max(0.05, hitAt)) : 1 - smooth((u - hitAt) / Math.max(0.05, 1 - hitAt));
      pos.x += -0.1 * k; pos.y += 0.03 * k; pos.z += -0.16 * k;
      rot.x += 0.15 * k; rot.y += 0.75 * k; rot.z += 0.6 * k;
    }

    // lanzamiento: atrás y arriba, latigazo al frente en la suelta real
    let hideGun = false;
    if (G.throwT > 0) {
      const T = TUNING.weapons.grenade.throwTime, rel = TUNING.weapons.grenade.throwRelease / T;
      const u = clamp01(1 - G.throwT / T);
      if (u < rel) {
        const wu = smooth(u / (rel * 0.7)), sw = smooth((u - rel * 0.7) / (rel * 0.3));
        pos.x += 0.03 * wu - 0.05 * sw; pos.y += 0.1 * wu - 0.02 * sw; pos.z += 0.1 * wu - 0.3 * sw;
        rot.x += 0.7 * wu - 0.9 * sw;
      } else {
        const f = smooth((u - rel) / (1 - rel));
        pos.x += -0.02 - 0.05 * f; pos.y += 0.08 - 0.3 * f; pos.z += -0.2 + 0.1 * f;
        rot.x += -0.2 - 0.4 * f;
      }
      // el bote ya salió de la mano
      if (!G.throwPending && def.thrown) hideGun = true;
    }

    // aturdido (patada) y stun: el arma cae y se tambalea
    if (p.dazed) { pos.y += -0.04; rot.z += Math.sin(a.time * 7) * 0.07; rot.x += -0.12; }
    if (G.protoStun > 0) { pos.y += -0.16; rot.x += -0.6; }

    // retroceso
    const kick = a.kick * (1 - 0.45 * ads);
    pos.z += 0.045 * kick; pos.y += 0.008 * kick; rot.x += 0.14 * kick;

    // --- no atravesar paredes: un rayo de los ojos al muzzle ---
    camera.updateMatrixWorld(true);
    const muzzleRel = this._u.copy(vm.anchor('muzzle')).sub(grip).multiply(S)
      .applyEuler(this._e.set(rot.x, rot.y, rot.z, 'YXZ')).add(pos);
    const reachLen = muzzleRel.length() + 0.06;
    const dir = this._w.copy(muzzleRel).applyQuaternion(camera.quaternion).normalize();
    let retractT = 0;
    if (!blind) {
      const hit = world.raycast(this.eye, dir, reachLen, 0);
      if (hit !== null) retractT = clamp01((reachLen - hit) / Math.max(0.2, reachLen * 0.85));
    }
    a.retract += (retractT - a.retract) * damp(retractT > a.retract ? 22 : 8, dt);
    const r = a.retract;
    pos.x += -0.02 * r; pos.y += -0.06 * r; pos.z += 0.2 * r;
    rot.x += 0.55 * r; rot.y += 0.35 * r;

    // --- aplicar ---
    vm.root.position.copy(camera.position);
    vm.root.quaternion.copy(camera.quaternion);
    vm.gun.position.copy(pos);
    vm.gun.rotation.set(rot.x, rot.y, rot.z, 'YXZ');
    vm.gunMesh.position.copy(grip).negate();
    vm.gunMesh.visible = !hideGun;
    vm.gun.updateMatrix();

    // manos: la derecha en la empuñadura, la izquierda en el guardamanos (o
    // en el cargador durante la recarga); antebrazos hacia codos fuera de cuadro
    const gq = vm.gun.quaternion;
    this._placeHand(vm.R, pos, gq, false);
    const one = ONE_HAND.has(vm.wep) || (p.state === 'melee') || G.throwT > 0;
    vm.L.hand.visible = vm.L.arm.visible = !one;
    if (!one) {
      const sup = vm.src.userData.forend ? 'forend' : 'aimSupport';
      const lp = this._v.copy(vm.anchor(sup)).sub(grip).multiply(S);
      if (leftToMag > 0.001) {
        const mp = this._w.copy(vm.anchor('mag')).sub(grip).multiply(S);
        mp.y -= 0.07 * (def.perShell ? 0.3 : 1);
        lp.lerp(mp, smooth(leftToMag));
      }
      lp.applyQuaternion(gq).add(pos);
      this._placeHand(vm.L, lp, gq, true);
    }
    vm.root.updateMatrixWorld(true);
  }

  _placeHand(h, at, q, left) {
    h.hand.position.copy(at);
    h.hand.quaternion.copy(q);
    // muñeca un poco detrás de la mano; codo abajo y atrás, fuera de cuadro
    const wrist = this._u.set(0, -0.01, 0.04).applyQuaternion(q).add(at);
    const elbow = left
      ? this._w.set(at.x - 0.08, at.y - 0.4, at.z + 0.12)
      : this._w.set(at.x + 0.1, at.y - 0.4, at.z + 0.14);
    const d = elbow.sub(wrist);
    const len = d.length();
    h.arm.position.copy(wrist);
    h.arm.quaternion.setFromUnitVectors(this._z, d.multiplyScalar(1 / Math.max(1e-6, len)));
    h.arm.scale.set(HAND_SCALE, HAND_SCALE, len);
  }
}
