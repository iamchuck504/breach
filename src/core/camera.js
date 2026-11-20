// Cámara sobre el hombro: hombro derecho, FOV estable al correr,
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
    this.pitchRecoil = 0;
    this.pos = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._first = true;
    this._follow = new THREE.Vector3(); // pivote suavizado: lo único que va con retraso
    this._rig = null;                   // hombro / altura / distancia suavizados
    this._reach = 1;                    // fracción de la distancia libre de obstáculos
    this._sideDir = new THREE.Vector3();
    this.crowd = 0;                     // 0..1: hombro aplastado contra algo
    this.ghost = 0;                     // 0..1: cámara dentro del volumen del soldado
    this._side = 1; // hombro actual: 1 = derecho, -1 = izquierdo (suavizado)
    this._scoped = false;
  }

  applyMouse(dx, dy, invertY) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // escala por FOV: al apuntar (FOV cerrado) la sensibilidad baja proporcionalmente,
    // Sensibilidad de apuntado derivada del zoom real.
    const zoomScale = this._scoped ? TUNING.cam.zoomSens : 1;
    const s = TUNING.cam.sens * DEG * (this.fov / TUNING.cam.fovNormal) * zoomScale;
    let yawStep = -dx * s;
    let pitchStep = (invertY ? dy : -dy) * s;
    // Un hitch o warp tardío de pointer-lock puede acumular miles de píxeles
    // en un solo RAF. Limitar el vector angular de ESE frame evita un flip de
    // cámara sin suavizar ni ralentizar el input normal (15°/frame sigue siendo
    // una velocidad muy alta incluso a 30 fps). El exceso se descarta: nunca
    // se encola para producir saltos en frames posteriores.
    const maxStep = (TUNING.cam.maxMouseStepDeg ?? 15) * DEG;
    const stepLen = Math.hypot(yawStep, pitchStep);
    if (stepLen > maxStep && stepLen > 0) {
      const scale = maxStep / stepLen;
      yawStep *= scale;
      pitchStep *= scale;
    }
    this.yaw += yawStep;
    // Tirar manualmente hacia abajo compensa recoil y consume la deuda de
    // recuperación. Sin esto, la cámara seguiría bajando sola después de que
    // el jugador ya corrigió el arma.
    if (pitchStep < 0 && this.pitchRecoil > 0) {
      this.pitchRecoil = Math.max(0, this.pitchRecoil + pitchStep);
    }
    this.pitch += pitchStep;
    const c = TUNING.cam;
    this.pitch = Math.max(c.pitchMin * DEG, Math.min(c.pitchMax * DEG, this.pitch));
  }

  addShake(amount) { this.shake = Math.min(1.5, this.shake + amount); }

  addPitchRecoil(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const c = TUNING.cam;
    const maxDebt = (c.pitchRecoilMaxDeg ?? 4) * DEG;
    const pitchRoom = c.pitchMax * DEG - this.pitch;
    const applied = Math.max(0, Math.min(amount, maxDebt - this.pitchRecoil, pitchRoom));
    this.pitch += applied;
    this.pitchRecoil += applied;
  }

  recoverPitchRecoil(dt) {
    if (this.pitchRecoil <= 0 || !Number.isFinite(dt) || dt <= 0) return;
    const rate = TUNING.cam.pitchRecoilRecover ?? 12;
    let recovered = this.pitchRecoil * (1 - Math.exp(-rate * dt));
    if (this.pitchRecoil - recovered < 1e-5) recovered = this.pitchRecoil;
    this.pitch -= recovered;
    this.pitchRecoil -= recovered;
  }

  clearPitchRecoil() { this.pitchRecoil = 0; }

  // stick derecho del gamepad (valores -1..1 ya con curva), escala por FOV
  applyStick(cx, cy, dt, invertY) {
    const zoomScale = this._scoped ? TUNING.cam.zoomSens : 1;
    const s = TUNING.cam.padSens * DEG * dt * (this.fov / TUNING.cam.fovNormal) * zoomScale;
    this.yaw -= cx * s;
    const pitchStep = (invertY ? cy : -cy) * s;
    if (pitchStep < 0 && this.pitchRecoil > 0) {
      this.pitchRecoil = Math.max(0, this.pitchRecoil + pitchStep);
    }
    this.pitch += pitchStep;
    const c = TUNING.cam;
    this.pitch = Math.max(c.pitchMin * DEG, Math.min(c.pitchMax * DEG, this.pitch));
  }

  // dir de la cámara en el plano (para movimiento relativo a cámara)
  flatForward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; }
  flatRight() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; }

  // FOV de apuntado del arma actual (el sniper cierra más que el resto).
  // Lo inyecta main cada frame; null = valor global de TUNING.
  setAimFov(fov) { this._aimFov = fov ?? null; }

  // Estado derivado por main: no queda latcheado al arma y por eso se apaga
  // en el primer frame de swap, melee, muerte, spectator o pausa.
  setScoped(on) { this._scoped = !!on; }

  update(dt, player) {
    const c = TUNING.cam;
    const st = player.camState(); // { mode, side? }

    let shoulder = c.shoulder, height = c.height, dist = c.dist, fov = c.fovNormal;
    if (st.mode === 'roadie') { height = c.roadieHeight; dist = c.roadieDist; fov = c.fovRoadie; }
    else if (st.mode === 'aim') {
      shoulder = c.aimShoulder; height = c.aimHeight; dist = c.aimDist;
      fov = this._aimFov ?? c.fovAim;
    }
    else if (st.mode === 'cover') { dist = c.coverDist; }

    // shoulder swap suave (lean izquierdo en cover → cámara al hombro izquierdo)
    // A neutral cover section is not a request to switch to the right.
    // Retain the last requested shoulder until a real opposite edge is reached.
    if (st.side !== 0) this._targetSide = st.side ?? 1;
    const targetSide = this._targetSide ?? 1;
    this._side += (targetSide - this._side) * (1 - Math.exp(-9 * dt));
    // Los parámetros del modo (apuntar, cover) se suavizan por separado: antes
    // el cambio entraba por el mismo suavizado que la posición entera.
    if (!this._rig || this._first) this._rig = { shoulder, height, dist };
    const kr = 1 - Math.exp(-c.rigLerp * dt);
    this._rig.shoulder += (shoulder - this._rig.shoulder) * kr;
    this._rig.height += (height - this._rig.height) * kr;
    this._rig.dist += (dist - this._rig.dist) * kr;
    shoulder = this._rig.shoulder * this._side; height = this._rig.height; dist = this._rig.dist;

    // pivot: pecho del jugador. Se sigue con un suavizado corto en el plano y
    // algo más largo en altura (escalones y saltos no sacuden la vista).
    const tx = player.pos.x, ty = (player.y ?? 0) + height * 0.92, tz = player.pos.z;
    if (this._first) this._follow.set(tx, ty, tz);
    else {
      const kp = 1 - Math.exp(-c.pivotLerp * dt), ky = 1 - Math.exp(-c.pivotLerpY * dt);
      this._follow.x += (tx - this._follow.x) * kp;
      this._follow.z += (tz - this._follow.z) * kp;
      this._follow.y += (ty - this._follow.y) * ky;
    }
    this.pivot.copy(this._follow);

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // offset detrás de la cámara según yaw/pitch + hombro
    const back = this._tmp.set(sy * cp, -sp, cy * cp); // apunta desde pivot hacia atrás de cámara
    const right = { x: cy, z: -sy };

    // Brazo de UN tramo, el de siempre (pivote → hombro + atrás·dist): la
    // cámara es el origen del rayo óptico que decide los tiros en ADS, así
    // que su posición respecto al soldado no puede ganar ángulo sobre una
    // esquina (run 4 probó un brazo hombro-luego-atrás y abría líneas de
    // tiro nuevas junto a una pared). Lo que cambia: la colisión SIEMPRE
    // gana. Antes la distancia mínima de 0.5 m podía dejar la cámara al
    // otro lado de una pared fina; ahora se queda a este lado aunque quede
    // más cerca del casco, y es el material del soldado propio (trama) el
    // que mantiene la vista libre.
    const dir = this._sideDir.set(back.x * dist + right.x * shoulder, back.y * dist + 0.12, back.z * dist + right.z * shoulder);
    const len = dir.length();
    dir.multiplyScalar(1 / len);
    let free = this._free(this.pivot, dir, len);
    // Distancia mínima (TUNING.cam.minDist) como antes, pero solo hasta la
    // superficie real menos 2 cm: nunca al otro lado de una pared fina.
    if (free * len < c.minDist) {
      const tSurf = this.world.raycast(this.pivot, dir, c.minDist, 0);
      free = Math.max(free, Math.min(c.minDist, tSurf === null ? c.minDist : Math.max(0, tSurf - 0.02)) / len);
    }
    // Obstáculo: la cámara entra EN EL ACTO (nunca atraviesa la pared mientras
    // se suaviza) y vuelve a alejarse con suavidad cuando queda libre.
    if (this._first || free < this._reach) this._reach = free;
    else this._reach += (free - this._reach) * (1 - Math.exp(-c.clipOutLerp * dt));
    // ORBITA RÍGIDA: la posición sale del pivote y de los ángulos de ESTE
    // cuadro. Girar el ratón ya no arrastra la cámara detrás de la mira.
    this.pos.copy(this.pivot).addScaledVector(dir, len * this._reach);
    this._first = false;
    // Para el material del soldado propio (main → syncLocalSoldierView):
    // crowd = hombro recogido (el soldado queda detrás de la retícula; normal
    // 0.82 de pie y en cover, 1.08 apuntando → 0); ghost = cámara metida en
    // su volumen (a menos de ~0.7 m de su eje → todo él en trama).
    const lat = Math.abs(shoulder) * this._reach;
    const k = Math.min(1, Math.max(0, (0.8 - lat) / 0.22));
    this.crowd = k * k * (3 - 2 * k);
    const ax = Math.hypot(this.pos.x - player.pos.x, this.pos.z - player.pos.z);
    const g = Math.min(1, Math.max(0, (0.8 - ax) / 0.25));
    this.ghost = g * g * (3 - 2 * g);

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

  // Fracción libre de un tramo (dir unitario, len): la cámara se queda 0.15
  // antes de la caja inflada 0.25.
  _free(from, dir, len) {
    if (len < 1e-6) return 1;
    const t = this.world.raycast(from, dir, len + 0.2, 0.25);
    return t !== null && t < len ? Math.max(0, t - 0.15) / len : 1;
  }

  // Ray desde el centro de pantalla (para apuntar)
  aimRay() {
    // `camera.position` incluye el shake posicional de presentación. Usarlo
    // como origen lógico hacía que muzzle, guía y pose intentaran perseguir
    // ese ruido visual después de cada disparo. `pos` conserva la misma cámara
    // colisionada, pero antes del shake: intención y retícula quedan estables.
    const origin = this.pos.clone();
    // No leer el quaternion renderizado del frame anterior: input, simulación
    // y disparo ocurren antes de update(). La dirección se deriva del mismo
    // yaw/pitch actual que usa flatForward(), así ADS y blindfire coinciden.
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir = new THREE.Vector3(
      -Math.sin(this.yaw) * cp,
      sp,
      -Math.cos(this.yaw) * cp,
    ).normalize();
    return { origin, dir };
  }
}
