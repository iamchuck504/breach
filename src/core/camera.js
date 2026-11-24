import { dodgeFX } from '../view/fp/dodge-fx.js';
// Cámara sobre el hombro: hombro derecho, FOV estable al correr,
// zoom al apuntar, colisión contra el mapa, shake.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { motionScale } from './settings.js';
// Espacio de nombres: `eyeFromPose` llega con el equipo RED; mientras no
// exista se usa la derivación del prototipo detrás de la misma llamada.
import * as HitPose from '../combat/hit-pose.js';

const DEG = Math.PI / 180;
const NEAR_3P = 0.1;

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
    // primera persona: grados por píxel ya resueltos (ajustes × FOV)
    const s = this._mouseDeg() * DEG;
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

  // Escala de giro de tercera persona: baja con el FOV y otro poco dentro
  // del scope. La primera persona fija cada cuadro `lookDeg` (°/píxel) y
  // `padDeg` ({x, y} °/s a fondo), ya con ajustes, ADS, mira y FOV.
  // Sensibilidad resuelta EN EL INSTANTE: con `sensFn` (ajustes vivos) un
  // cambio de ajuste cuenta en el mismo tick, no en el siguiente cuadro.
  _mouseDeg() {
    if (this.sensFn && this.lookCtx) {
      const v = this.sensFn('mouse', this.lookCtx)?.x;
      if (Number.isFinite(v)) return v * (this.lookRatio ?? 1);
    }
    return Number.isFinite(this.lookDeg) ? this.lookDeg : TUNING.cam.sens * this._lookScale();
  }
  _padDeg() {
    if (this.sensFn && this.lookCtx) {
      const v = this.sensFn('pad', this.lookCtx);
      if (Number.isFinite(v?.x) && Number.isFinite(v?.y)) return { x: v.x * (this.lookRatio ?? 1), y: v.y * (this.lookRatio ?? 1) };
    }
    return this.padDeg;
  }
  _lookScale() {
    return (this.fov / TUNING.cam.fovNormal) * (this._scoped ? TUNING.cam.zoomSens : 1);
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

  // Retroceso lateral mecánico (patrón del arma, `weapons.lastKick.yaw`):
  // mueve la mira y no se recupera solo; acotado por tiro.
  addYawRecoil(amount) {
    if (!Number.isFinite(amount)) return;
    this.yaw += Math.max(-0.02, Math.min(0.02, amount));
  }

  // stick derecho del gamepad (valores -1..1 ya con curva), escala por FOV
  // `friction` (0..1, por defecto 1): la fricción de la asistencia de mando
  // (JUGABILIDAD aporta la función pura; solo se aplica al stick, nunca al
  // ratón). Multiplica el giro: un stick quieto sigue dando giro cero.
  applyStick(cx, cy, dt, invertY, friction = 1) {
    const f = Number.isFinite(friction) ? Math.max(0, Math.min(1, friction)) : 1;
    const pd = this._padDeg();
    const sx = (pd ? pd.x : TUNING.cam.padSens * this._lookScale()) * DEG * dt * f;
    const sy = (pd ? pd.y : TUNING.cam.padSens * this._lookScale()) * DEG * dt * f;
    this.yaw -= cx * sx;
    const pitchStep = (invertY ? cy : -cy) * sy;
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
    // La primera persona es otra cámara (FirstPersonCamera, abajo): esta solo
    // queda para la cámara de muerte, el espectador y la presentación.
    const c = TUNING.cam;
    // plano cercano de tercera persona (la primera persona usa el suyo)
    if (this.camera.near !== NEAR_3P) { this.camera.near = NEAR_3P; this.camera.updateProjectionMatrix(); }
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

// ======================================================================
// PRIMERA PERSONA — la cámara con la que se juega (DECISIONES §3).
// El ojo sale de `eyeFromPose()` (la misma función que usan el servidor
// para validar el origen del tiro y los bots para ver), en el marco del
// cuerpo, y se suaviza; después del suavizado se recorta a la esfera de la
// cabeza replicada: quien te ve por encima de un borde tiene la cabeza
// expuesta. Todo lo cosmético (balanceo al andar, caída al aterrizar,
// sacudidas, golpe de retroceso, alabeo) va acotado y por ajustes; el
// retroceso MECÁNICO es el de la lógica del arma (addPitchRecoil sobre el
// estado de mira compartido) y es lo único que mueve la puntería.
// Estado de mira (yaw, pitch, deuda de retroceso, entrada de ratón y mando)
// = el de la ShoulderCamera (`look`): así la cámara de muerte y la de
// espectador continúan desde la misma mirada.
// ======================================================================
export const FP_NEAR = 0.03;          // pegado a una pared (radio 0.38) no recorta
export const FP_FOV_DEFAULT = 72;     // vertical
export const FP_FOV_MIN = 60, FP_FOV_MAX = 100;
export const FP_BODY_TURN_DEG = 1440; // el cuerpo sigue a la vista (°/s)
// ojo a ≤ esto del centro de la cabeza (radio 0.22): el mismo EYE_MAX que
// usa hit-pose para el ojo nominal y el servidor como referencia
export const FP_EYE_RADIUS = HitPose.EYE_MAX ?? 0.12;
const FP_WALL_PAD = 0.06;             // el ojo se queda esto antes de una pared (> esquina del plano cercano, 0.045)
// ADS: aumento por arma; el FOV de apuntado sale del de hip y del aumento
// (el scope del sniper usa su propio FOV, `def.fovAim`).
export const FP_ADS_ZOOM = Object.freeze({ smg: 1.25, shotgun: 1.15, pistol: 1.2, stun: 1.2, sniper: 1.35, bazooka: 1.3, grenade: 1.1, frag: 1.1 });
// Ajustes que lee la cámara (los persiste JUGABILIDAD en src/core/settings.js);
// cualquier campo ausente toma este valor.
export const FP_DEFAULTS = Object.freeze({
  fov: FP_FOV_DEFAULT, bob: 1, shake: 1, reduceMotion: false,
});

// El ojo sale SOLO de hit-pose (RED): ninguna altura fija en la cámara.
export const eyeFromPose = (pose) => HitPose.eyeFromPose(pose);

export function adsFov(hipFov, weapon, zoom) {
  const z = zoom ?? FP_ADS_ZOOM[weapon] ?? 1.2;
  return 2 * Math.atan(Math.tan(hipFov * DEG / 2) / Math.max(1, z)) / DEG;
}

const clampN = (v, a, b, d) => (Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
const dampK = (rate, dt) => 1 - Math.exp(-rate * dt);

// Resorte críticamente amortiguado (x'' = −w²x − 2w·x'), integrado en
// FORMA CERRADA: exacto para cualquier dt, así que ni a 10 c/s ni con un
// cuadro de 100 ms puede oscilar de más ni divergir (el Euler de antes sí).
// Devuelve [x, v] tras dt.
export function springStep(x, v, w, dt) {
  if (!(dt > 0)) return [x, v];
  const e = Math.exp(-w * dt), c = v + w * x;
  const nx = (x + c * dt) * e, nv = (v - w * c * dt) * e;
  return [Number.isFinite(nx) ? nx : 0, Number.isFinite(nv) ? nv : 0];
}
const KICK_W = 26, DIP_W = 11;
const KICK_V_MAX = 0.4, DIP_PEAK = 0.07;

export class FirstPersonCamera {
  constructor(camera, world, look) {
    this.camera = camera;
    this.world = world;
    this.look = look;
    this.live = false;            // la vista de ESTE cuadro es la de los ojos
    this.eye = new THREE.Vector3();  // ojo del cuadro = posición de la cámara = origen del rayo
    this.head = new THREE.Vector3(); // centro de la esfera de cabeza de la pose actual
    this.fov = FP_FOV_DEFAULT;
    this.aim01 = 0;
    this.hipFov = FP_FOV_DEFAULT;
    this._first = true;
    this._off = new THREE.Vector3();
    this.offset = new THREE.Vector3();
    this._py = 0;
    this._bob = 0; this._bobK = 0;
    this._dip = 0; this._dipV = 0; this._wasGrounded = true; this._airVy = 0;
    this._roll = 0;
    this._kick = 0; this._kickV = 0;
    this._shakeT = 0;
    this._meleeTrauma = 0; this._meleeClock = 0;
    this._baseFov = FP_FOV_DEFAULT;
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._a = new THREE.Vector3();
    // diagnóstico (scripts de comprobación): recorte a la cabeza, distancia
    // ojo–cabeza, y conflicto pared/cabeza (la cabeza replicada en la pared:
    // no hay punto libre dentro de la bola; debería ser siempre 0)
    this.last = { clamped: 0, eyeDist: 0, wallConflict: 0 };
  }

  // Al entrar desde otra cámara: sin arrastrar suavizados viejos.
  reset() { this._first = true; }

  // Al soltar la vista (muerte, espectador, presentación).
  release() {
    this.live = false;
    this._first = true;
    this.camera.userData.dodgeFX = null;
    this._meleeTrauma = 0;
    this.look.lookDeg = undefined; this.look.padDeg = null; this.look.lookCtx = null;
  }

  // Golpe cosmético de retroceso: `amount` ≈ el `recoil` del arma. Se ve
  // como un pulso de FOV y un poco de alabeo: ninguno de los dos mueve el
  // CENTRO de la pantalla, que sigue siendo el eje balístico.
  kick(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this._kickV = Math.min(KICK_V_MAX, this._kickV + Math.min(1.5, amount) * 0.11);
  }

  meleeImpact(amount) {
    this._meleeTrauma = Math.min(1, this._meleeTrauma + amount);
  }

  /**
   * o = { pose, eye?, weapon, scoped, scopeFov, adsZoom, settings, sens, sensFn }
   * pose = la postura replicada del jugador (la misma que va a la red).
   *
   * DECISIÓN (cruz = eje balístico): lo cosmético NUNCA gira la mira. La
   * cámara está exactamente en el ojo (`this.eye`, origen del tiro) y mira
   * exactamente por yaw/pitch (la dirección del tiro); las sacudidas y el
   * golpe de retroceso son alabeo (giro alrededor del eje de la vista) y
   * pulso de FOV, que dejan el píxel central sobre el mismo rayo. El
   * balanceo al andar y la caída al aterrizar mueven el OJO (dentro de la
   * cabeza) y por tanto también el origen del tiro: lo que ves es de donde
   * sale la bala.
   */
  update(dt, player, o = {}) {
    dt = Number.isFinite(dt) ? Math.max(0, Math.min(0.25, dt)) : 0;
    const s = o.settings || FP_DEFAULTS; // cada lectura se acota abajo
    const look = this.look, cam = this.camera, pose = o.pose || { st: 'idle' };
    const motion = s.reduceMotion ? 0 : 1;
    const first = this._first;
    const yaw = Number.isFinite(player.yaw) ? player.yaw : look.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const e = eyeFromPose(pose);
    const h = HitPose.hitPose(pose).h;
    const tx = fx * e.f + rx * e.s, ty = e.y, tz = fz * e.f + rz * e.s;
    const py = player.y ?? 0;

    // Ni la postura ni los pies se suavizan aquí: la postura ya es continua
    // en origen (ce, cl y la transición de agacharse rampan en el
    // controlador y viajan así) y un ojo suavizado aparte sería un origen
    // distinto del que se valida y de la dirección que muestra la cruz.
    this._off.set(tx, ty, tz);
    this._py = py;

    // aterrizaje: resorte exacto, pico ∝ velocidad de caída (acotado)
    const grounded = player.grounded !== false;
    if (!grounded) this._airVy = Math.min(this._airVy, Number.isFinite(player.vy) ? player.vy : 0);
    if (grounded && !this._wasGrounded && !first) {
      const peak = Math.min(DIP_PEAK, Math.max(0, -this._airVy - 2) * 0.009) * (motion ? 1 : 0.35);
      this._dipV = Math.min(DIP_PEAK * DIP_W * Math.E, this._dipV + peak * DIP_W * Math.E);
    }
    if (grounded) this._airVy = 0;
    this._wasGrounded = grounded;
    [this._dip, this._dipV] = springStep(this._dip, this._dipV, DIP_W, dt);
    if (first) { this._dip = 0; this._dipV = 0; }

    // El ojo de la cámara ES eyeWorld(pose) (el origen que valida el
    // servidor, a ≤ 2 cm): sin balanceo ni caída posicionales. El balanceo
    // al andar lo hace el arma (viewmodel, ajuste `bob`); la caída al
    // aterrizar se ve como un pulso de FOV (abajo), que no mueve el centro.
    const eye = this._v.set(player.pos.x + this._off.x, this._py + this._off.y, player.pos.z + this._off.z);
    // fuente única: el ojo resuelto del controlador (mismo punto que el
    // origen del tiro), si se pasa
    if (Array.isArray(o.eye) && o.eye.every(Number.isFinite)) eye.set(o.eye[0], o.eye[1], o.eye[2]);
    this.head.set(player.pos.x + fx * h[0] + rx * h[1], py + h[2], player.pos.z + fz * h[0] + rz * h[1]);
    this._resolveEye(eye);
    this.eye.copy(eye);
    // desplazamiento cosmético del ojo sobre eyeWorld(pose) de este cuadro
    // (balanceo, caída, escalón, pared): lo reutiliza la muestra del tiro
    this.offset.set(eye.x - (player.pos.x + tx), eye.y - (py + ty), eye.z - (player.pos.z + tz));
    look.pos.copy(eye); // la cámara de hombro parte de aquí al morir

    // --- giro: SOLO la mira (yaw/pitch) + alabeo cosmético ---
    const cl = clampN(pose.cl, -1, 1, 0);
    const rollT = (-cl * 4 * (motion ? 1 : 0.35) + (pose.st === 'slide' ? -3 * motion : 0)) * DEG;
    this._roll = first ? rollT : this._roll + (rollT - this._roll) * dampK(10, dt);
    // sacudidas (impactos, explosiones): alabeo pequeño que se apaga solo
    this._shakeT = (this._shakeT + dt * 30) % 1e4;
    look.shake = Math.max(0, Math.min(1.5, Number.isFinite(look.shake) ? look.shake : 0) - dt * 3.2);
    const shakeScale = clampN(s.shake, 0, 1, 1) * (motion ? 1 : 0.35);
    const shRoll = Math.sin(this._shakeT * 1.7) * Math.min(1, look.shake) * 0.9 * DEG * shakeScale;
    // player/index.ts de CRASHTERRA: decaimiento y alabeo originales.
    // Solo el alabeo conserva la línea óptica y el ojo de la muestra.
    this._meleeTrauma = Math.max(0, this._meleeTrauma - dt * 1.7);
    this._meleeClock += dt;
    const meleeRoll = this._meleeTrauma ** 2 * motionScale('shake', s) *
      0.06 * Math.sin(this._meleeClock * 61.7 + 0.7);
    // golpe de retroceso: resorte exacto → pulso de FOV (≤ 1.2°) y alabeo (≤ 0.4°)
    [this._kick, this._kickV] = springStep(this._kick, this._kickV, KICK_W, dt);
    if (first) { this._kick = 0; this._kickV = 0; }
    const kick = Math.max(0, Math.min(1, this._kick * 60)) * shakeScale;

    const dodge = cam.userData.dodgeFX = dodgeFX(player.dodge, look.yaw, s);
    cam.position.copy(eye);
    cam.rotation.set(0, 0, 0);
    cam.rotateY(look.yaw);
    cam.rotateX(look.pitch);
    cam.rotateZ(this._roll + shRoll + meleeRoll + (kick * 0.4 + (dodge?.roll ?? 0)) * DEG);

    // --- FOV (vertical) y plano cercano ---
    const hip = clampN(s.fov, FP_FOV_MIN, FP_FOV_MAX, FP_FOV_DEFAULT);
    this.hipFov = hip;
    const sprinting = player.state === 'roadie';
    const adsT = adsFov(hip, o.weapon, o.adsZoom);
    const target = o.scoped ? (o.scopeFov ?? 20) : player.aim && !sprinting ? adsT : hip;
    this._baseFov = first ? target : this._baseFov + (target - this._baseFov) * dampK(14, dt);
    if (Math.abs(this._baseFov - target) < 0.01) this._baseFov = target;
    // mezcla de ADS 0..1 que se ve (la retícula se cierra con el FOV)
    this.aim01 = o.scoped ? 1 : Math.max(0, Math.min(1, (hip - this._baseFov) / Math.max(1e-3, hip - adsT)));
    this.fov = this._baseFov + (dodge?.fov ?? 0) - kick * 1.2 - Math.max(0, Math.min(DIP_PEAK, this._dip)) * 14;
    look.fov = this._baseFov;
    let proj = false;
    if (Math.abs(cam.fov - this.fov) > 0.001) { cam.fov = this.fov; proj = true; }
    if (cam.near !== FP_NEAR) { cam.near = FP_NEAR; proj = true; }
    if (proj) cam.updateProjectionMatrix();

    // --- sensibilidad: la de ajustes (o.sens = { mouse °/px, padX, padY °/s },
    // ya con ADS/mira) por encima, y proporcional al FOV (sin el pulso) ---
    const ratio = this._baseFov / hip;
    const sens = o.sens || {};
    look.lookDeg = clampN(sens.mouse, 0.001, 1, TUNING.cam.sens) * ratio;
    look.padDeg = { x: clampN(sens.padX, 1, 1000, TUNING.cam.padSens) * ratio,
      y: clampN(sens.padY, 1, 1000, TUNING.cam.padSens) * ratio };
    // y el contexto para resolverla al girar (o.sensFn = lookSensitivity)
    look.sensFn = typeof o.sensFn === 'function' ? o.sensFn : null;
    look.lookCtx = { aim: !!player.aim, scoped: !!o.scoped };
    look.lookRatio = ratio;

    this._first = false;
    this.live = true;
  }

  // Pared y cabeza A LA VEZ: el ojo final está (a) dentro de la bola EYE_MAX
  // de la cabeza replicada y (b) fuera de la geometría con FP_WALL_PAD de
  // holgura. Se busca sobre el tramo eje-del-cuerpo → ojo: el punto más
  // alejado del eje que siga libre, sin salir de la bola. Si la bola entera
  // está en la pared (la postura misma es ilegal: lo impide el barrido del
  // controlador) gana la cabeza y se anota `wallConflict`.
  // El ojo de la cámara ES el ojo resuelto de la postura (eyeWorld), el
  // mismo que el tiro: sin corrección privada contra paredes. Que la esfera
  // de la cabeza (y con ella el ojo, a ≤ EYE_MAX de su centro) no entre en
  // la geometría lo garantiza el controlador tras cada desplazamiento y
  // transición de postura. Aquí solo se MIDE, para diagnóstico.
  _resolveEye(eye) {
    const H = this.head;
    this.last.clamped = 0;
    this.last.eyeDist = Math.hypot(eye.x - H.x, eye.y - H.y, eye.z - H.z);
    let near = Infinity;
    for (let i = 0; i < 8; i++) {
      const ang = i * Math.PI / 4;
      const t = this.world.raycast(eye, this._w.set(Math.cos(ang), 0, Math.sin(ang)), FP_WALL_PAD, 0);
      if (t !== null) near = Math.min(near, t);
    }
    this.last.wallConflict = near < FP_WALL_PAD ? FP_WALL_PAD - near : 0;
  }

  // Ojo de una MUESTRA de tiro (subpaso en que se aprueba) = eyeWorld de
  // esa postura, exacto: lo que reconstruye y exige el servidor.
  shotEye(pose, player, out) {
    const yaw = player.yaw, e = eyeFromPose(pose), py = player.y ?? 0;
    return out.set(player.pos.x - Math.sin(yaw) * e.f + Math.cos(yaw) * e.s, py + e.y,
      player.pos.z - Math.cos(yaw) * e.f - Math.sin(yaw) * e.s);
  }

  // Rayo central: origen = el ojo (sin sacudidas), dirección = la mira.
  aimRay() {
    const { yaw, pitch } = this.look;
    const cp = Math.cos(pitch);
    return {
      origin: this.eye.clone(),
      dir: new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize(),
    };
  }

  // Salida de granadas y cohetes: delante del ojo, algo abajo a la derecha,
  // nunca al otro lado de la geometría.
  // `from` = una muestra de tiro ({ origin, dir }): sale de ESE ojo y esa
  // mira (lo que valida el servidor: salida a ≤ 1.2 m del ojo, ojo→salida libre).
  launchPoint(out, from = null) {
    const eye = from?.origin ?? this.eye;
    const yaw = from ? Math.atan2(-from.dir.x, -from.dir.z) : this.look.yaw;
    const pitch = from ? Math.asin(Math.max(-1, Math.min(1, from.dir.y))) : this.look.pitch;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fwd = this._w.set(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp);
    const rgt = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    // arriba de la vista = derecha × adelante
    const up = { x: -rgt.z * fwd.y, y: rgt.z * fwd.x - rgt.x * fwd.z, z: rgt.x * fwd.y };
    const p = out.set(
      eye.x + fwd.x * 0.5 + rgt.x * 0.1 - up.x * 0.09,
      eye.y + fwd.y * 0.5 - up.y * 0.09,
      eye.z + fwd.z * 0.5 + rgt.z * 0.1 - up.z * 0.09);
    const dir = this._v.copy(p).sub(eye);
    const len = dir.length();
    dir.multiplyScalar(1 / Math.max(1e-6, len));
    const hit = this.world.raycast(eye, dir, len + 0.1, 0);
    const d = hit === null ? len : Math.max(0, Math.min(len, hit - 0.12));
    return out.copy(eye).addScaledVector(dir, d);
  }
}
