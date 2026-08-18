// Cámara over-shoulder estilo Gears: hombro derecho, FOV kick en roadie,
// zoom al apuntar, colisión contra el mapa, shake.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';

const DEG = Math.PI / 180;

export class ShoulderCamera {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.yaw = 0;
    this.pitch = -8 * DEG;
    this.fov = TUNING.cam.fovNormal;
    this.shake = 0;
    this.shakeT = 0;
    this.pos = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._first = true;
  }

  applyMouse(dx, dy, invertY) {
    // escala por FOV: al apuntar (FOV cerrado) la sensibilidad baja proporcionalmente,
    // igual que gears-clone (sens * 0.55 al apuntar) pero derivado del zoom real
    const s = TUNING.cam.sens * DEG * (this.fov / TUNING.cam.fovNormal);
    this.yaw -= dx * s;
    this.pitch += (invertY ? dy : -dy) * s;
    const c = TUNING.cam;
    this.pitch = Math.max(c.pitchMin * DEG, Math.min(c.pitchMax * DEG, this.pitch));
  }

  addShake(amount) { this.shake = Math.min(1.5, this.shake + amount); }

  // stick derecho del gamepad (valores -1..1 ya con curva), escala por FOV
  applyStick(cx, cy, dt, invertY) {
    const s = TUNING.cam.padSens * DEG * dt * (this.fov / TUNING.cam.fovNormal);
    this.yaw -= cx * s;
    this.pitch += (invertY ? cy : -cy) * s;
    const c = TUNING.cam;
    this.pitch = Math.max(c.pitchMin * DEG, Math.min(c.pitchMax * DEG, this.pitch));
  }

  // dir de la cámara en el plano (para movimiento relativo a cámara)
  flatForward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; }
  flatRight() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; }

  update(dt, player) {
    const c = TUNING.cam;
    const st = player.camState(); // { mode:'normal'|'roadie'|'aim'|'cover', coverNormal? }

    let shoulder = c.shoulder, height = c.height, dist = c.dist, fov = c.fovNormal;
    if (st.mode === 'roadie') { height = c.roadieHeight; dist = c.roadieDist; fov = c.fovRoadie; }
    else if (st.mode === 'aim') { shoulder = c.aimShoulder; height = c.aimHeight; dist = c.aimDist; fov = c.fovAim; }
    else if (st.mode === 'cover') { dist = c.coverDist; }

    // pivot: pecho del jugador
    this.pivot.set(player.pos.x, height * 0.92, player.pos.z);

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // offset detrás de la cámara según yaw/pitch + hombro
    const back = this._tmp.set(sy * cp, -sp, cy * cp); // apunta desde pivot hacia atrás de cámara
    const right = { x: cy, z: -sy };

    const desired = new THREE.Vector3(
      this.pivot.x + back.x * dist + right.x * shoulder,
      this.pivot.y + back.y * dist + 0.12,
      this.pivot.z + back.z * dist + right.z * shoulder,
    );

    // colisión: ray del pivot a la posición deseada
    const dir = desired.clone().sub(this.pivot);
    const len = dir.length();
    dir.normalize();
    const t = this.world.raycast(this.pivot, dir, len + 0.2, 0.25);
    if (t !== null && t < len) desired.copy(this.pivot).addScaledVector(dir, Math.max(c.minDist, t - 0.15));

    const k = this._first ? 1 : 1 - Math.exp(-c.posLerp * dt);
    this.pos.lerp(desired, k);
    this._first = false;

    // shake POSICIONAL únicamente: nunca rota la puntería (eso se siente incontrolable)
    this.shakeT += dt * 30;
    if (st.mode === 'roadie') this.shake = Math.max(this.shake, 0.25 * c.shakeRoadie);
    this.shake = Math.max(0, this.shake - dt * 3.2);
    const shx = Math.sin(this.shakeT * 1.7) * this.shake * 0.045;
    const shy = Math.cos(this.shakeT * 2.3) * this.shake * 0.035;

    this.camera.position.copy(this.pos);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    this.camera.translateX(shx);
    this.camera.translateY(shy);

    this.fov += (fov - this.fov) * (1 - Math.exp(-c.fovLerp * dt));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  // Ray desde el centro de pantalla (para apuntar)
  aimRay() {
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return { origin, dir };
  }
}
