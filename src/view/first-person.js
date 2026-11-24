// PRIMERA PERSONA — prototipo local para probar la sensación (rama
// experiment/first-person). Apagado por defecto: sin `?fp=1` ni la
// preferencia guardada, nada de este módulo toca cámara, disparo ni dibujo.
//
// Tres piezas:
//  · el modo (URL, localStorage `breach.view`, tecla de cambio y aviso);
//  · la cámara a la altura de los ojos: sale de hitPose() (la cabeza
//    calibrada por estado/exposición/asomado/fase, en el marco del cuerpo),
//    NO del hueso animado de la cabeza — el rig se mece y marearía;
//  · el arma, los brazales y los guantes articulados en src/view/fp/.
// El rig del jugador se sigue simulando entero (sombra, red, volúmenes de
// impacto, bots); solo deja de dibujarse para su propia cámara.
import * as THREE from 'three';
import { hitPose, STAND } from '../combat/hit-pose.js';
import { TUNING } from '../config/tuning.js';
import { BINDS, keyLabel } from '../core/bindings.js';
import { t } from '../core/i18n.js';
import { FpAdapter } from './fp/game-adapter.js';

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
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
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
    this.fp2 = null;
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  get vm() { return this.fp2?.active ? this.fp2.vm : null; }

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
    if (this.fp2) this.fp2.update(0, sc, false);
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
    if (this.fp2?.active) return this.fp2.muzzleWorld(out);
    return this.launchPoint(out);
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

  /** Ventana de expulsión (mundo) y dirección de los casquillos; null sin arma nueva. */
  ejectWorld(out, dir) {
    if (!this.fp2?.active) return null;
    return this.fp2.ejectWorld(out, dir);
  }

  // ---------- arma en primera persona ----------
  updateViewModel(dt, sc) {
    this.fp2 ??= new FpAdapter(this.ctx);
    this.fp2.update(dt, sc, this.live);
  }
}
