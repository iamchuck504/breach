// Máquina de estados del jugador local en PRIMERA PERSONA (DECISIONES §1-2).
// Prioridad absoluta: responsividad y lectura.
// Estados: idle / run / roadie (sprint) / crouch / slide / mantle / melee.
// El cuerpo está bloqueado a la vista: el movimiento es relativo a la mira
// (strafe y retroceso de FPS); no es un modo, es EL comportamiento.
// Retirado para el jugador: cobertura pegada (snap, slide a cobertura, swat
// turn, lean de esquina), blindfire, rodada/dive, doble salto con voltereta,
// patada de pared y wallbounce. Los bots tienen su propia clase (botmatch.js).
// Queda un único gesto contextual: el ASOMO — agachado junto a una cara LOW,
// apuntar te levanta por encima del borde (`ce` 0→1) y soltar te baja.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { stepDodge } from './dodge.js';
import { SETTINGS } from '../core/settings.js';
import { hitPose, placeHitPose, eyeWorld } from '../combat/hit-pose.js';
import { wirePose, localPose, resetTransition } from '../net/client.js';
import { canFireInState, MOVE_GATES, sprintFireDelay } from '../combat/fire-gates.js';

const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const approachAngle = (a, b, maxStep) => {
  const d = angleDelta(a, b);
  return a + Math.max(-maxStep, Math.min(maxStep, d));
};
const approach = (v, target, step) => v < target ? Math.min(target, v + step) : Math.max(target, v - step);

export const PLAYER_R = 0.38;

const TMP_O = new THREE.Vector3(), TMP_D = new THREE.Vector3();

// Estados de suelo en los que se puede inclinar
const LEAN_STATES = new Set(['idle', 'run', 'crouch']);
// Misma regla que net/client.js postureOf: estados que pasan a `crouch` en
// el cable mientras la cabeza no está de pie del todo.
const CROUCHABLE = new Set(['idle', 'run', 'jump', 'roadie', 'crouch']);
// Holgura de la esfera de cabeza contra la geometría
const HEAD_MARGIN = 0.02;
// Muestras de la superficie de la esfera (ejes + diagonales), unitarias
const SPHERE_DIRS = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ...[[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]
    .map((d) => d.map((x) => x / Math.sqrt(3))),
  ...[[1, 1, 0], [1, -1, 0], [-1, 1, 0], [-1, -1, 0], [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1]]
    .map((d) => d.map((x) => x / Math.SQRT2))];

export class Controller {
  constructor(world, camera, events = {}) {
    this.world = world;
    this.cam = camera;
    this.ev = events; // {onSlideStart, onJump, onLand, onMantle, onMeleeStart, meleeTarget, meleeTargetPos}
    this.pos = { x: 0, z: -16 };
    this.vel = { x: 0, z: 0 };
    this.y = 0;             // altura de los pies
    this.vy = 0;
    this.grounded = true;
    this.yaw = 0;
    this.state = 'idle';
    this.stateT = 0;
    // postura FPS (CONTRATO §1)
    this.crouched = false;  // intención lógica efectiva (incluye techo bajo)
    this.crouch01 = 0;      // 0 de pie … 1 agachado, continuo (altura de cámara)
    this.lean = 0;          // `cl` −1..1, ya limitado por colisión
    this.peek = 0;          // `ce` 0..1: asomo sobre cara LOW
    this.peekFace = null;
    this.leanRoom = { l: 1, r: 1 }; // inclinación máxima libre por lado (diagnóstico/tests)
    this.slide = null;      // { t, dir:{x,z}, v0 } deslizamiento desde sprint
    this.slideCd = 0;
    this.dodge = null; this.dodgeCd = 0; this.queuedDodge = null; this.offlineDodgePose = false;
    this.sinceSprint = Infinity; // s desde que se dejó el sprint (retraso de disparo y dispersión)
    this.weaponKey = 'smg';      // arma en mano para el retraso sprint→disparo
    this.mantle = null;     // trepada sobre cover bajo en progreso
    this.meleeT = 0;        // progreso del golpe melee en curso
    this.meleeCd = 0;
    this.meleeEndT = 0;
    this.meleeFreezeT = 0;
    this.meleeConnected = false;
    this.meleeKilled = false;
    this.meleeEntrySpeed = 0;
    this.meleeEntryState = 'idle';
    this.meleeFromCover = false;
    this.meleeTravel = 0;
    this.aim = false;
    this.groundPitch = 0;  // inclinación del suelo en la dirección del cuerpo
    this.dead = false;
    // --- heredados: main.js y otros módulos aún los leen/escriben. El
    // jugador ya no los usa; quedan neutros. TODO integración: retirar.
    this.cover = null;
    this.coverEntry = null;
    this.dive = null;
    this.flip = null;
    this.firingBlind = 0;
    this.blindMode = null;
    this.blindPoseExposure = 0;
    this.chain = 0;
    this.fpYawLock = 0;    // main lo fija; el bloqueo a la vista ya es permanente
  }

  // Alias de CONTRATO §1 para quien todavía lee los nombres de cobertura
  // (net/client.js → `cl`/`ce`, view/first-person.js → hitPose). Escribirlos no
  // hace nada. TODO integración: leer `lean`/`peek` directamente.
  get coverLeanAnim() { return this.lean; }
  set coverLeanAnim(_v) { /* solo lectura */ }
  get coverAimExposure() { return this.peek; }
  set coverAimExposure(_v) { /* solo lectura */ }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  facing() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; }

  cameraYawError() { return angleDelta(this.yaw, this.cam.yaw); }

  // Arma en mano (para el retraso sprint→disparo por arma). TODO integración:
  // main.js debe llamarlo al cambiar de arma (o en cada paso).
  setWeapon(key) { if (key) this.weaponKey = key; }

  // Enlaza las armas: el arma en mano sigue sola y el sprint espera a soltar
  // un lanzamiento comprometido (DECISIONES 18).
  bindWeapons(weapons) { this._weapons = weapons || null; if (weapons?.cur) this.weaponKey = weapons.cur; }

  // Tiempo que falta para que el arma pueda disparar tras salir del sprint.
  fireReadyIn(weaponKey = this.weaponKey) {
    if (this.state === 'roadie') return Infinity;
    if (this.dodge) return TUNING.dodge.duration - this.dodge.t + sprintFireDelay(weaponKey);
    return Math.max(0, sprintFireDelay(weaponKey) - this.sinceSprint);
  }

  // Puerta de disparo del cuerpo: alineado con la vista (en FPS siempre),
  // fuera de trepar, y pasado el retraso de sprint del arma. main.js la llama
  // en canFire, así que el retraso entra sin tocar main.
  fireAligned(maxDeg = TUNING.combat.fireAlignMaxDeg) {
    // misma tabla que el servidor (combat/fire-gates.js)
    if (this.dead || !canFireInState(this.animState(), this.weaponKey)) return false;
    if (this.fireReadyIn() > 0) return false;
    return Math.abs(this.cameraYawError()) <= maxDeg * Math.PI / 180;
  }

  // Entrada de spreadFor() (weapons.js): lo que el cuerpo aporta a la
  // dispersión de ESTE instante.
  spreadState() {
    return {
      aim: this.aim,
      moving: Math.min(1, this.speed / TUNING.fp.runSpeed),
      crouched: this.crouched && this.state !== 'slide',
      sliding: this.state === 'slide',
      airborne: !this.grounded,
      sinceSprint: this.state === 'roadie' ? 0 : this.sinceSprint,
    };
  }

  camState() {
    if (this.dead) return { mode: 'normal' };
    if (this.aim) return { mode: 'aim', side: 1 };
    if (this.state === 'roadie') return { mode: 'roadie' };
    return { mode: 'normal' };
  }

  // Postura replicada: SOLO estados del CONTRATO §1 (nunca cover_*, blind_*,
  // dive ni flip desde el jugador).
  animState() {
    if (this.dead) return 'dead';
    switch (this.state) {
      case 'mantle': return 'mantle';
      case 'melee': return 'melee';
      case 'dodge': return 'dodge';
      case 'slide': return 'slide';
      case 'roadie': return this.grounded ? 'roadie' : 'jump';
      case 'crouch': return this.grounded ? 'crouch' : 'jump';
      default:
        if (!this.grounded) return 'jump';
        return this.speed > 0.4 ? 'run' : 'idle';
    }
  }

  animParams() {
    const st = this.animState();
    return {
      state: st,
      // postura FPS (CONTRATO §1)
      crouch: this.crouch01,
      cl: this.lean,
      ce: this.peek,
      speed: Math.min(1, this.speed / TUNING.move.roadieSpeed),
      moveForward: this.speed > 0.05 ? (this.vel.x * -Math.sin(this.yaw) + this.vel.z * -Math.cos(this.yaw)) / this.speed : 1,
      moveSide: this.speed > 0.05 ? (this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw)) / this.speed : 0,
      aim: this.aim,
      aimPitch: this.cam.pitch,
      aimYawErr: Math.max(-1, Math.min(1, this.cameraYawError())),
      twist: 0,               // cuerpo bloqueado a la vista: sin torsión
      firing: false,
      vy: this.vy,            // fases del salto
      groundPitch: this.groundPitch,
      mantlePhase: this.mantle ? Math.min(1, this.mantle.t / this.mantle.dur) : 0,
      slidePhase: this.slide ? Math.min(1, this.slide.t / TUNING.fp.slideTime) : 0,
      meleePhase: this.state === 'melee'
        ? Math.min(1, this.meleeT / Math.max(0.001, this.meleeEndT || TUNING.melee.time))
        : 0,
      meleeEnd: this.meleeEndT,
      meleeConnected: this.meleeConnected,
      meleeFromCover: false,
      meleeEntrySpeed: this.meleeEntrySpeed,
      meleeTackle: this.state === 'melee' && !!this.meleeTackle,
      meleeLunge: this.state === 'melee' && !!this.meleeLunge,
      // heredados (neutros) para el rig hasta que RIG retire las ramas viejas
      coverLean: this.lean,
      coverAimExposure: this.peek,
      blindPoseExposure: 0,
      blindMode: null,
      coverKind: this.peek > 0 ? 'low' : undefined,
      latMove: 0,
      flipT: 0, flipDir: 1, flipAxis: 'z',
      evadePhase: this.dodge ? this.dodge.t / TUNING.dodge.duration : 0,
    };
  }

  // Altura de la postura 0 (de pie) … 1 (agachado) que ve la cámara: el
  // asomo devuelve la altura de pie aunque la intención siga agachada.
  get stanceLow() { return this.crouch01 * (1 - this.peek); }

  // Altura del ojo sobre los pies según la postura (referencia de CONTRATO
  // §2; la cámara debe usar eyeFromPose() de hit-pose.js).
  eyeHeight() {
    const F = TUNING.fp;
    return F.eyeStand + (F.eyeCrouch - F.eyeStand) * this.stanceLow;
  }

  // limpia TODO el estado transitorio (flags pegados = poses/gameplay rotos)
  _clearTransient() {
    if (this.offlineDodgePose) resetTransition(this);
    this.mantle = null;
    this.slide = null;
    this.slideCd = 0;
    this.dodge = null; this.dodgeCd = 0; this.queuedDodge = null; this.offlineDodgePose = false;
    this.sinceSprint = Infinity;
    this.crouched = false;
    this.crouch01 = 0;
    this.lean = 0;
    this.peek = 0;
    this.peekFace = null;
    this.leanRoom = { l: 1, r: 1 };
    this.meleeT = 0;
    this.meleeCd = 0;
    this.meleeEndT = 0;
    this.meleeFreezeT = 0;
    this.meleeConnected = false;
    this.meleeKilled = false;
    this.meleeEntrySpeed = 0;
    this.meleeEntryState = 'idle';
    this.meleeFromCover = false;
    this.meleeTravel = 0;
    this.jumpBuf = 0;
    this.coyoteT = 0;
    this.firingBlind = 0;
    this.blindPoseExposure = 0;
  }

  respawn(spawn) {
    this.pos = { x: spawn.x, z: spawn.z };
    this.vel = { x: 0, z: 0 };
    this.y = 0; this.vy = 0; this.grounded = true;
    // La pendiente pertenece al suelo de la vida anterior.
    this.groundPitch = 0;
    this._clearTransient();
    this.yaw = spawn.yaw;
    this.cam.yaw = spawn.yaw;
    this.cam.pitch = -0.12;
    this.cam.clearPitchRecoil?.();
    this.state = 'idle'; this.stateT = 0;
    this.cover = null; this.coverEntry = null; this.dive = null; this.flip = null;
    this.dead = false;
  }

  kill() {
    this.dead = true;
    this._setState('idle');
    this.cover = null; this.coverEntry = null; this.dive = null; this.flip = null;
    this.aim = false;
    this.vel = { x: 0, z: 0 };
    this._clearTransient();
  }

  // dir del input en mundo (relativo a la vista)
  _moveWorld(input) {
    const mv = input.moveVec();
    const f = this.cam.flatForward(), r = this.cam.flatRight();
    return { x: f.x * mv.z + r.x * mv.x, z: f.z * mv.z + r.z * mv.x, mag: Math.hypot(mv.x, mv.z), mv };
  }

  _setState(s) { this.state = s; this.stateT = 0; }

  _beginMelee() {
    const ml = TUNING.melee;
    if (!this.grounded || this.meleeCd > 0 || this.state === 'melee' || this.dazed) return false;
    const previousState = this.state;
    this.meleeT = 0;
    this.meleeEndT = ml.hitAt + ml.missRecovery;
    this.meleeFreezeT = 0;
    this.meleeConnected = false;
    this.meleeKilled = false;
    this.meleeEntrySpeed = Math.min(TUNING.fp.sprintSpeed, this.speed);
    this.meleeEntryState = previousState;
    this.meleeFromCover = false;
    this.meleeTravel = 0;
    // placaje si entra en sprint; embestida si hay un rival enganchable
    this.meleeTackle = this.speed > TUNING.fp.runSpeed * 1.15; // por velocidad real
    const hooked = this.ev.meleeTarget?.(this.meleeTackle ? ml.tackleAcquire : ml.lungeAcquire, ml.lungeArcDeg);
    this.meleeLunge = hooked ? { id: hooked.id, max: this.meleeTackle ? ml.tackleMax : ml.lungeMax } : null;
    this.aim = false;
    this.slide = null;
    this._setState('melee');
    this.ev.onMeleeStart?.();
    return true;
  }

  // El resultado llega exactamente en la ventana de contacto. Un acierto
  // recupera antes que un fallo y congela solo el gesto unas milésimas.
  confirmMelee(connected, killed = false) {
    if (this.state !== 'melee' || !connected) return;
    const ml = TUNING.melee;
    this.meleeConnected = true;
    this.meleeKilled = !!killed;
    this.meleeFreezeT = Math.max(this.meleeFreezeT, ml.hitStop);
    const recovery = killed ? ml.killRecovery : ml.hitRecovery;
    this.meleeEndT = Math.max(this.meleeT + recovery, ml.hitAt + recovery);
  }

  // Volumen de impacto (hit-pose.js) de la pose que VIAJA y que usa la
  // cámara, con altura `low` (0 de pie … 1 agachado) e inclinación `cl`.
  // Es la MISMA pose de localPose (net/client.js): regla de cable (wirePose),
  // velocidad `sp`, fase de trepar y la mezcla de transición de estados
  // (contexto del cuadro, ver _poseCtx).
  _trialPose(low = this.stanceLow, cl = this.lean) {
    const st = this.animState();
    const ps = wirePose({ animState: () => st, lean: cl, stanceLow: low, aim: this.aim });
    const pose = { st: ps.st, aim: !!this.aim, ce: ps.ce, cl: ps.cl, pitch: this.cam?.pitch ?? 0, wep: this.weaponKey,
      sp: +Math.min(1, this.speed / TUNING.move.roadieSpeed).toFixed(2) };
    if (ps.st === 'mantle') pose.phase = this.mantle ? Math.min(1, this.mantle.t / this.mantle.dur) : 0;
    const ctx = this._ctx;
    return ctx?.from ? { ...pose, from: ctx.from, fromTo: ctx.fromTo, since: ctx.since } : pose;
  }
  _headVolume(low = this.stanceLow, cl = this.lean) { return hitPose(this._trialPose(low, cl)); }
  // Contexto de mezcla de transición de ESTE cuadro (avanza con el reloj de
  // simulación del controller, igual que localPose con el de main).
  // La transición la define lo ENVIADO (net/client.js noteSentPose, por
  // `ct`): se lee con localPose en el reloj de main (`poseClock`, que fija
  // INTEGRACIÓN: () => G.simClock); sin él, reloj propio (sin envíos no hay
  // mezcla, igual que en localPose).
  _poseCtx() {
    this._ctx = null;
    const now = typeof this.poseClock === 'function' ? this.poseClock() : (this._simT ?? 0);
    const lp = localPose(this, this.weaponKey, now);
    this._ctx = lp.from ? { from: lp.from, fromTo: lp.fromTo, since: lp.since } : null;
  }

  // Ojo RESUELTO en mundo (origen del tiro y cámara): el de la pose que
  // viaja, ya con la cabeza fuera de la geometría. La cámara no necesita
  // recorte propio.
  eyeWorld() {
    const pose = { ...this._trialPose(), ae: Math.max(-1, Math.min(1, this.cameraYawError())) };
    return eyeWorld(pose, this.pos.x, this.y, this.pos.z, this.yaw);
  }

  // Si la cabeza (sin inclinación) quedó dentro de la geometría (agacharse
  // de cara a un muro, sprint de frente, un empujón externo), retrasa el
  // cuerpo lo justo en sentido contrario a la cabeza: frena el avance contra
  // la cara igual que la inclinación se recoge.
  _pushHeadOut(cl = 0) {
    if (this.state === 'mantle' || this.state === 'melee' || this.dead) return false;
    if (this.headClear(this.stanceLow, cl)) return true;
    const v = placeHitPose(this._headVolume(this.stanceLow, cl), this.pos.x, this.y, this.pos.z, this.yaw);
    // solo hacia atrás/adelante del cuerpo (nunca aparta de lado: eso es
    // la inclinación, que se recoge sola)
    const f = this.facing();
    const ahead = (v.hx - this.pos.x) * f.x + (v.hz - this.pos.z) * f.z;
    const sgnF = ahead >= 0 ? -1 : 1;
    const dx = f.x * sgnF, dz = f.z * sgnF;
    const x0 = this.pos.x, z0 = this.pos.z;
    for (let k = 0.02; k <= 0.3 + 1e-9; k += 0.02) {
      const cand = { x: x0 + dx * k, z: z0 + dz * k };
      // la posición donde el cuerpo se QUEDA (colisión + holgura de fachada,
      // como el movimiento del siguiente paso); si no, el cuerpo vuelve y la
      // cabeza con él
      this.world.resolveCircle(cand, PLAYER_R, this.y);
      if (this.world.resolveFacadeBody) {
        this.world.resolveFacadeBody(cand, PLAYER_R, this.y, null);
        this.world.resolveCircle(cand, PLAYER_R, this.y);
      }
      if (Math.abs(this.world.groundHeight(cand, PLAYER_R, this.y) - this.y) > TUNING.move.maxStepUp) continue;
      this.pos.x = cand.x; this.pos.z = cand.z;
      if (this.headClear(this.stanceLow, cl)) {
        // la velocidad hacia la pared se anula (no se acumula contra ella)
        const into = -(this.vel.x * dx + this.vel.z * dz);
        if (into > 0) { this.vel.x += dx * into; this.vel.z += dz * into; }
        return true;
      }
    }
    this.pos.x = x0; this.pos.z = z0;
    return false;
  }

  // Tras un desplazamiento externo (empujón entre cuerpos en main.js):
  // saca la cabeza y recoge la inclinación en la posición final.
  settle() {
    this._pushHeadOut();
    if (this.lean) {
      const sgn = Math.sign(this.lean);
      this.lean = sgn * this._limit(0, Math.abs(this.lean), (m) => this.headClear(this.stanceLow, sgn * m));
    }
  }

  // ¿La esfera de cabeza CALIBRADA de esa pose está libre de geometría en la
  // posición actual? Rayos desde el eje del cuerpo (a media altura, dentro
  // del círculo ya resuelto) hasta el centro y la superficie de la esfera,
  // más el techo. Es el mismo volumen que ve el servidor.
  headClear(low = this.stanceLow, cl = this.lean) {
    const v = placeHitPose(this._headVolume(low, cl), this.pos.x, this.y, this.pos.z, this.yaw);
    const r = v.hr + HEAD_MARGIN;
    const ceiling = this.world.ceilingHeight?.(this.pos, PLAYER_R, this.y) ?? Infinity;
    if (v.hy + r > ceiling) return false;
    if (!this.world.raycast) return true;
    const oy = this.y + 0.5;
    for (const d of SPHERE_DIRS) {
      const px = v.hx + d[0] * r, py = v.hy + d[1] * r, pz = v.hz + d[2] * r;
      TMP_O.set(this.pos.x, oy, this.pos.z);
      TMP_D.set(px - this.pos.x, py - oy, pz - this.pos.z);
      const len = TMP_D.length();
      if (len < 1e-6) continue;
      TMP_D.multiplyScalar(1 / len);
      const t = this.world.raycast(TMP_O, TMP_D, len);
      if (t !== null && t !== undefined && t < len) return false;
    }
    return true;
  }

  // Mayor valor entre `from` (libre o no) y `to` cuyo test pasa, por
  // bisección (monótono en la práctica: inclinar/levantar más nunca libra).
  _limit(from, to, ok) {
    if (ok(to)) return to;
    let lo = from, hi = to;
    if (!ok(lo)) lo = 0;
    if (!ok(lo)) return lo;
    for (let i = 0; i < 7; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    return lo;
  }

  // ¿Cabe de pie aquí? La esfera de cabeza de pie (con la inclinación y el
  // ADS actuales) no puede tocar techo ni paredes.
  canStand() { return this.headClear(0, this.lean); }

  // Cara LOW delante (según la VISTA) a distancia de asomo; histéresis con
  // la cara actual para no parpadear en el borde del rango.
  _findPeekFace() {
    const F = TUNING.fp;
    if (!this.world.findCover) return null;
    const f = this.cam.flatForward();
    const range = (this.peekFace ? F.peekKeepRange : F.peekRange) + PLAYER_R;
    const found = this.world.findCover(this.pos, f, range, PLAYER_R, 0.5, this.y);
    const face = found?.face;
    if (!face || face.kind === 'high') return null;
    const top = (face.topY ?? face.h) - this.y;
    if (!(top >= 0.5 && top <= TUNING.cover.lowHeight)) return null;
    return face;
  }

  _beginSlide(mw, frameRemaining = 0) {
    const F = TUNING.fp;
    const sp = this.speed;
    const dir = sp > 0.1 ? { x: this.vel.x / sp, z: this.vel.z / sp }
      : (mw.mag > 0.1 ? { x: mw.x / mw.mag, z: mw.z / mw.mag } : this.facing());
    this.slide = { t: 0, dir, v0: Math.min(F.slideMaxSpeed, sp + F.slideBoost) };
    this.vel.x = dir.x * this.slide.v0; this.vel.z = dir.z * this.slide.v0;
    this.crouched = true;
    this.sinceSprint = -frameRemaining;
    this._setState('slide');
    this.ev.onSlideStart?.(0);
  }

  // Salir del sprint por la causa que sea: el retraso de disparo arranca aquí
  _leaveSprint(input, next, frameRemaining = 0) {
    // En línea, la última postura del sprint puede salir en este mismo
    // cuadro. Su recuperación empieza a contar desde el envío efectivo.
    this.sinceSprint = -frameRemaining;
    input?.releaseToggle?.('sprint');
    this._setState(next);
  }

  update(dt, input, firing, frameRemaining = 0) {
    const F = TUNING.fp, M = TUNING.move;
    this.stateT += dt;
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    this.slideCd = Math.max(0, this.slideCd - dt);
    this._roadieExitT = Math.max(0, (this._roadieExitT ?? 0) - dt);
    if (this.state !== 'roadie') this.sinceSprint += dt;
    // MEMORIA DE PULSACIÓN: saltar justo antes de aterrizar no se pierde.
    this.jumpBuf = input.jumpPressed ? TUNING.jump.inputBuffer : Math.max(0, (this.jumpBuf ?? 0) - dt);

    if (this._weapons?.cur) this.weaponKey = this._weapons.cur;
    if (this.dead) { this.aim = false; this.jumpBuf = 0; return; }

    const mw = this._moveWorld(input);
    const mv = mw.mv;
    const hasInput = mw.mag > 0.1;
    const crouchWant = !!input.crouchHeld;
    // de pie ya está garantizado por los límites de postura; solo se comprueba agachado
    const standOk = this.crouched || this.crouch01 > 0 ? this.canStand() : true;
    const dodgeReady = this.grounded && !this.dazed && MOVE_GATES.dodge.entry.includes(this.state) &&
      this.crouch01 <= 0.005 && !crouchWant && !this._weapons?.throwCommitted;
    // Conservar el rumbo de la pulsación en la última ventana del enfriamiento.
    if (!dodgeReady) this.queuedDodge = null;
    else if (input.evadePressed && this.dodgeCd <= TUNING.evade.inputBuffer) {
      const fwd = this.cam.flatForward();
      this.queuedDodge = { t: 0, x: hasInput ? mw.x / mw.mag : -fwd.x,
        z: hasInput ? mw.z / mw.mag : -fwd.z };
    }
    if (this.queuedDodge && this.dodgeCd <= 1e-8) {
      this.dodge = this.queuedDodge; this.queuedDodge = null;
      this.dodgeCd = TUNING.dodge.duration + TUNING.dodge.cooldown;
      this.lean = 0; this.peek = 0; this.jumpBuf = 0;
      input.releaseToggle?.('sprint');
      this._setState('dodge');
      this.ev.onDodgeStart?.();
    }
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    const aimAllowed = this.state !== 'dodge' && this.state !== 'roadie' && this.state !== 'mantle' &&
      this.state !== 'melee' && !this.dazed;
    this.aim = !!input.aimHeld && aimAllowed;

    switch (this.state) {
      case 'idle': case 'run': case 'roadie': case 'crouch': {
        // --- sprint: solo hacia delante, sin apuntar, sin disparar
        const forward = mw.mag > 0.1 && mv.z >= F.sprintMinForward * mw.mag;
        // lanzamiento comprometido: el sprint espera a la suelta (el estado
        // replicado al soltar es legal según fire-gates.js)
        const throwHold = !!this._weapons?.throwCommitted;
        const sprintWant = input.sprintHeld && forward && !input.aimHeld && !firing &&
          !this.dazed && this.grounded && !throwHold;
        if (this.state === 'roadie' && !sprintWant) {
          // en el aire el sprint se mantiene hasta aterrizar (sin cambio de velocidad)
          if (this.grounded || !input.sprintHeld || firing || input.aimHeld) {
            this._leaveSprint(input, hasInput || this.speed > 0.4 ? 'run' : 'idle', frameRemaining);
            this._roadieExitT = 0.05; // antirrebote: solo tras SALIR del sprint
          }
        }
        // --- deslizamiento: agacharse yendo en sprint
        if (this.state === 'roadie' && input.crouchPressed && this.grounded &&
            this.speed >= F.slideMinSpeed && this.slideCd <= 0) {
          input.releaseToggle?.('sprint');
          this._beginSlide(mw, frameRemaining);
          break;
        }
        // --- agacharse: intención o techo bajo; sprintar levanta
        if (sprintWant && this.state !== 'roadie' && this._roadieExitT <= 0 && standOk) {
          if (this.crouched) input.releaseToggle?.('crouch');
          this.crouched = false;
          this._setState('roadie');
        } else if (this.state !== 'roadie') {
          // en el aire no se cambia de postura: se aplica al aterrizar
          if (this.grounded) this.crouched = crouchWant || (this.crouched && !standOk);
          const next = this.crouched ? 'crouch' : (hasInput || this.speed > 0.4 ? 'run' : 'idle');
          if (next !== this.state) {
            if (next === 'crouch' || this.state === 'crouch') this._setState(next);
            else if (this.state === 'idle' && next === 'run') this._setState('run');
            else if (this.state === 'run' && next === 'idle' && !hasInput && this.speed <= 0.4) this._setState('idle');
          }
        }
        if (input.aimHeld && !this.aim && this.state !== 'roadie' && !this.dazed) this.aim = true;

        // --- el cuerpo sigue a la vista
        const lockDeg = this.fpYawLock > 0 ? this.fpYawLock : F.yawLockDeg;
        this.yaw = approachAngle(this.yaw, this.cam.yaw, lockDeg * Math.PI / 180 * dt);

        // --- velocidad
        const roadie = this.state === 'roadie';
        let targetSpeed = roadie ? F.sprintSpeed
          : this.crouched ? F.crouchSpeed * (this.aim ? F.crouchAdsMul : 1)
            : F.runSpeed * (this.aim ? F.adsMul : 1);
        if (this.dazed) targetSpeed *= TUNING.melee.dazeSpeed;
        const want = hasInput;
        const tx = want ? mw.x * targetSpeed : 0;
        const tz = want ? mw.z * targetSpeed : 0;
        // en el aire el momentum se respeta: sin input casi no frena
        const acc = (want ? M.accel : M.decel * (this.grounded ? 1 : 0.06)) *
          (this.grounded ? 1 : TUNING.jump.airControl);
        const k = 1 - Math.exp(-(acc / Math.max(targetSpeed, 1)) * dt);
        this.vel.x += (tx - this.vel.x) * k;
        this.vel.z += (tz - this.vel.z) * k;
        // FRENADA lineal encima de la exponencial: sin cola de "flotar"
        if (!want && this.grounded) {
          const sp = Math.hypot(this.vel.x, this.vel.z);
          if (sp > 1e-4) {
            const keep = Math.max(0, sp - M.stopBrake * dt) / sp;
            this.vel.x *= keep; this.vel.z *= keep;
          }
        }

        // --- saltar / trepar (misma acción). Trepar solo sobre LOW, con la
        // vista hacia la cara; si no, salto simple. Agachado: se levanta y salta.
        if (input.jumpPressed || this.jumpBuf > 0) {
          const canJump = this.grounded || ((this.coyoteT ?? 0) > 0 && this.vy <= 0);
          if (canJump) {
            this.jumpBuf = 0;
            if (!this._tryMantleAhead(mw)) {
              if (this.crouched) {
                if (standOk) { this.crouched = false; input.releaseToggle?.('crouch'); this._setState(hasInput ? 'run' : 'idle'); this._tryJump(); }
              } else this._tryJump();
            }
          }
        }

        // --- golpe
        if (this.state !== 'mantle' && input.meleePressed && this.grounded && this.meleeCd <= 0) {
          this._beginMelee();
        }
        break;
      }

      case 'dodge':
        this.yaw = this.cam.yaw;
        this.sinceSprint = 0; this.jumpBuf = 0;
        break;

      case 'slide': {
        const s = this.slide;
        s.t += dt;
        const k = Math.min(1, s.t / F.slideTime);
        const spd = s.v0 * (1 - (1 - F.slideEndFrac) * k);
        // pequeña corrección de rumbo con el stick (no un giro libre)
        if (hasInput) {
          const cross = s.dir.x * mw.z - s.dir.z * mw.x;
          const ang = Math.max(-F.slideSteer * dt, Math.min(F.slideSteer * dt, Math.atan2(cross, s.dir.x * mw.x + s.dir.z * mw.z)));
          const c = Math.cos(ang), sn = Math.sin(ang);
          s.dir = { x: s.dir.x * c - s.dir.z * sn, z: s.dir.x * sn + s.dir.z * c };
        }
        this.vel.x = s.dir.x * spd;
        this.vel.z = s.dir.z * spd;
        const lockDeg = this.fpYawLock > 0 ? this.fpYawLock : F.yawLockDeg;
        this.yaw = approachAngle(this.yaw, this.cam.yaw, lockDeg * Math.PI / 180 * dt);
        this.crouched = true;
        // saltar corta el deslizamiento conservando velocidad (con tope de sprint)
        const jump = (input.jumpPressed || this.jumpBuf > 0) && standOk;
        if (k >= 1 || jump) {
          this.slide = null;
          this.slideCd = F.slideCooldown;
          this.crouched = jump ? false : (crouchWant || !standOk);
          if (!this.crouched) input.releaseToggle?.('crouch');
          const sp = this.speed, cap = jump ? F.sprintSpeed : (this.crouched ? F.crouchSpeed : F.runSpeed) * 1.2;
          if (sp > cap) { this.vel.x *= cap / sp; this.vel.z *= cap / sp; }
          this._setState(this.crouched ? 'crouch' : (hasInput ? 'run' : 'idle'));
          if (jump) { this.jumpBuf = 0; this._tryJump(); }
        }
        break;
      }

      case 'melee': {
        const ml = TUNING.melee;
        if (this.meleeFreezeT > 0) {
          this.meleeFreezeT = Math.max(0, this.meleeFreezeT - dt);
          this.vel.x *= Math.exp(-18 * dt);
          this.vel.z *= Math.exp(-18 * dt);
          break;
        }
        this.meleeT += dt;
        // Impulso corto hasta el contacto: depende de la velocidad REAL de
        // entrada y el recorrido total queda limitado.
        const wind = Math.max(0, 1 - this.meleeT / Math.max(0.001, ml.hitAt));
        const runFactor = Math.min(1, this.meleeEntrySpeed / F.sprintSpeed);
        let push = (ml.lungeSpeed + runFactor * ml.runLungeBonus) * wind;
        const remaining = Math.max(0, ml.maxLunge - this.meleeTravel);
        push = Math.min(push, remaining / Math.max(dt, 1e-4));
        let f = this.facing();
        const hook = this.meleeLunge && this.meleeT <= ml.hitAt ? this.ev.meleeTargetPos?.(this.meleeLunge.id) : null;
        if (hook) {
          // EMBESTIDA/PLACAJE: cubre la distancia al rival para el contacto.
          // En primera persona el placaje se limita a 11 m/s (antes 17).
          const dx = hook.x - this.pos.x, dz = hook.z - this.pos.z, d = Math.hypot(dx, dz);
          if (d > 0.01) {
            this.yaw = approachAngle(this.yaw, Math.atan2(-dx, -dz), ml.lungeTurnDeg * Math.PI / 180 * dt);
            f = { x: dx / d, z: dz / d };
            const left = Math.max(dt, ml.hitAt - this.meleeT);
            const top = this.meleeTackle ? Math.min(ml.tackleTopSpeed, F.tackleTopSpeed) : ml.lungeTopSpeed;
            push = Math.min(top, Math.max(0, d - ml.lungeStop) / left,
              Math.max(0, this.meleeLunge.max - this.meleeTravel) / Math.max(dt, 1e-4));
          }
        } else if (this.meleeLunge && this.meleeT <= ml.hitAt) this.meleeLunge = null;
        this.meleeTravel += push * dt;
        this.vel.x = f.x * push;
        this.vel.z = f.z * push;
        // sin embestida el cuerpo vuelve a la vista (la cámara manda)
        if (!hook) this.yaw = approachAngle(this.yaw, this.cam.yaw, F.yawLockDeg * Math.PI / 180 * dt);
        // La muestra transmite hasta visualAimMaxDeg de giro del torso.
        // Al girar la vista durante la embestida, el cuerpo acompaña el exceso.
        this.yaw = approachAngle(this.cam.yaw, this.yaw, TUNING.combat.visualAimMaxDeg * Math.PI / 180);
        if (this.meleeT >= this.meleeEndT) {
          this._setState(this.crouched ? 'crouch' : (hasInput ? 'run' : 'idle'));
          this.meleeCd = ml.inputGuard;
        }
        break;
      }

      case 'mantle': {
        // trepada corta sobre cover bajo: sube primero, avanza después.
        // Movimiento guiado — sin gravedad, sin input, sin cancelaciones.
        const m = this.mantle;
        m.t += dt;
        const k = Math.min(1, m.t / m.dur);
        const kUp = Math.min(1, k * 1.9);           // la subida llega antes
        const eUp = kUp * kUp * (3 - 2 * kUp);
        const eFwd = k * k * (3 - 2 * k);           // avance ease-in-out
        this.y = m.fy + (m.ty + 0.02 - m.fy) * eUp;
        this.pos.x = m.fx + (m.tx2 - m.fx) * eFwd;
        this.pos.z = m.fz + (m.tz2 - m.fz) * eFwd;
        this.vel.x = 0; this.vel.z = 0;
        // la vista manda también al trepar (la cámara no gira sola)
        this.yaw = approachAngle(this.yaw, this.cam.yaw, F.yawLockDeg * Math.PI / 180 * dt);
        if (k >= 1) {
          this.mantle = null;
          this.grounded = true;
          this.vy = 0;
          this._setState(hasInput ? 'run' : 'idle');
          // continuidad: sale caminando encima, no clavado en seco
          const fd = { x: -m.n.x, z: -m.n.z };
          this.vel.x = fd.x * F.runSpeed * TUNING.mantle.exitSpeed;
          this.vel.z = fd.z * F.runSpeed * TUNING.mantle.exitSpeed;
        }
        break;
      }

      default:
        // Estado heredado escrito desde fuera (p. ej. 'cover' de un parche
        // viejo): volver a suelo sin conservar nada.
        this._setState('idle');
        break;
    }

    // --- integrar + colisión (en mantle el movimiento es guiado y CRUZA el borde)
    const moveStartX = this.pos.x, moveStartZ = this.pos.z;
    const wasGrounded = this.grounded;
    if (this.state === 'dodge') {
      const done = stepDodge(this, this.dodge, dt, PLAYER_R);
      this.vel.x = dt > 0 ? (this.pos.x - moveStartX) / dt : 0;
      this.vel.z = dt > 0 ? (this.pos.z - moveStartZ) / dt : 0;
      if (done) {
        this.dodge = null;
        this.vel.x = this.vel.z = 0;
        this._setState('idle');
        this.ev.onDodgeEnd?.();
      }
    } else if (this.state !== 'mantle') {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.world.resolveCircle(this.pos, PLAYER_R, this.y, null);
      // La holgura corporal de un muro alto no es sólida: es margen para el
      // cuerpo. Cede como mucho a 3,5 m/s (sin tirones al doblar esquinas).
      const bx = this.pos.x, bz = this.pos.z;
      this.world.resolveFacadeBody?.(this.pos, PLAYER_R, this.y, null);
      const ox = this.pos.x - bx, oz = this.pos.z - bz, od = Math.hypot(ox, oz), cap = 3.5 * dt;
      if (od > cap) {
        this.pos.x = bx + ox * cap / od; this.pos.z = bz + oz * cap / od;
        this.world.resolveCircle(this.pos, PLAYER_R, this.y);
      }
    }

    // Nunca subir un desnivel grande solo porque groundHeight cambió bajo el
    // círculo. Si el movimiento completo es inválido, probar cada eje.
    if (wasGrounded && this.state !== 'mantle') {
      const fullGround = this.world.groundHeight(this.pos, PLAYER_R, this.y);
      if (fullGround > this.y + M.maxStepUp) {
        const candidate = (x, z) => {
          const p = { x, z };
          this.world.resolveCircle(p, PLAYER_R, this.y);
          const h = this.world.groundHeight(p, PLAYER_R, this.y);
          return h <= this.y + M.maxStepUp
            ? { p, d2: (p.x - moveStartX) ** 2 + (p.z - moveStartZ) ** 2 }
            : null;
        };
        const onlyX = candidate(this.pos.x, moveStartZ);
        const onlyZ = candidate(moveStartX, this.pos.z);
        const best = !onlyX ? onlyZ : !onlyZ ? onlyX : (onlyX.d2 >= onlyZ.d2 ? onlyX : onlyZ);
        if (best) {
          const keptX = Math.abs(best.p.x - moveStartX) > 1e-5;
          const keptZ = Math.abs(best.p.z - moveStartZ) > 1e-5;
          this.pos.x = best.p.x; this.pos.z = best.p.z;
          if (!keptX) this.vel.x = 0;
          if (!keptZ) this.vel.z = 0;
        } else {
          this.pos.x = moveStartX; this.pos.z = moveStartZ;
          this.vel.x = 0; this.vel.z = 0;
        }
      }
    }

    // --- vertical: gravedad + suelo (permite pararse sobre coberturas)
    const airStates = this.state === 'idle' || this.state === 'run' ||
      this.state === 'roadie' || this.state === 'crouch';
    if (airStates) {
      const J = TUNING.jump;
      const ground = this.world.groundHeight(this.pos, PLAYER_R, this.y);
      const followsGround = wasGrounded && this.vy <= 0 &&
        ground <= this.y + M.maxStepUp && this.y - ground <= M.groundStickDown;
      if (followsGround) {
        this.y = ground; this.vy = 0; this.grounded = true;
      } else {
        // integración trapezoidal: la altura del salto no depende de los fps
        const vy0 = this.vy;
        this.vy -= J.gravity * dt;
        this.y += (vy0 + this.vy) * 0.5 * dt;
      }
      if (!followsGround && this.y <= ground + 1e-3 && this.vy <= 0) {
        const wasAir = !this.grounded;
        const fallSpeed = -this.vy;
        this.y = ground; this.vy = 0; this.grounded = true;
        if (wasAir && fallSpeed > 3) this.ev.onLand?.(fallSpeed); // AUDIO elige la variante por velocidad
      } else {
        this.grounded = this.y <= ground + 0.02;
      }
      // margen para saltar justo después de salir de un borde
      this.coyoteT = this.grounded ? J.coyote : Math.max(0, (this.coyoteT ?? 0) - dt);
    } else if (this.state !== 'mantle') {
      // estados pegados al suelo (slide, melee): la Y sigue al terreno real
      this.y = this.world.groundHeight(this.pos, PLAYER_R, this.y);
      this.vy = 0;
      this.grounded = true;
    }

    // techo: la altura del cuerpo depende de la postura
    const ceiling = this.world.ceilingHeight?.(this.pos, PLAYER_R, this.y) ?? Infinity;
    const bodyH = this.crouched ? F.crouchClear : 1.63;
    if (this.y + bodyH > ceiling) { this.y = ceiling - bodyH; this.vy = Math.min(0, this.vy); }

    // --- postura continua: agachado, asomo e inclinación. Va DESPUÉS de
    // mover el cuerpo: la inclinación se barre contra la posición final de
    // este paso (si no, acercarse a una pared metía la cabeza un cuadro).
    {
      // Todo cambio de postura que SUBE o APARTA la cabeza se limita con la
      // esfera calibrada de hit-pose.js en la posición final de este paso.
      this._simT = (this._simT ?? 0) + dt;
      const crouchTarget = this.crouched ? 1 : 0;
      const c0 = this.crouch01, c1 = approach(c0, crouchTarget, dt / F.crouchTime);
      this._poseCtx();
      if (c1 > c0) {
        // bajar adelanta la cabeza: primero se intenta retrasar el cuerpo; si
        // no cabe (pasillo estrecho de cara a un pilar), se agacha solo hasta
        // donde la esfera queda libre (sin saltos: nunca vuelve hacia arriba)
        this.crouch01 = c1;
        if (!this._pushHeadOut()) {
          const ok = (cc) => this.headClear(cc * (1 - this.peek), 0);
          // si ya estaba dentro (techo bajo al aparecer), agacharse sigue
          if (ok(c0)) this.crouch01 = this._limit(c0, c1, ok);
        }
      } else this._pushHeadOut();
      // levantarse: crouch01 baja; buscar el más bajo (más de pie) libre
      if (c1 < c0) this.crouch01 = 1 - this._limit(1 - c0, 1 - c1, (u) => this.headClear((1 - u) * (1 - this.peek), this.lean));
      // ASOMO: agachado + apuntando + cara LOW delante (ajuste autoPeek)
      let peekTarget = 0;
      if (SETTINGS.autoPeek && this.state === 'crouch' && this.grounded && this.aim && standOk) {
        this.peekFace = this._findPeekFace();
        if (this.peekFace) peekTarget = 1;
      } else this.peekFace = null;
      const p0 = this.peek, p1 = approach(p0, peekTarget, dt / (peekTarget > p0 ? F.peekRise : F.peekFall));
      this.peek = p1 <= p0 ? p1 : this._limit(p0, p1, (q) => this.headClear(this.crouch01 * (1 - q), this.lean));
      // INCLINACIÓN: de pie o agachado, quieto o andando, en el suelo
      const want = LEAN_STATES.has(this.state) && this.grounded ? Math.sign(input.leanAxis || 0) : 0;
      const l1 = approach(this.lean, want, dt / F.leanTime);
      // si la inclinación pedida solo choca por DELANTE (cabeza agachada
      // contra la cara), el cuerpo cede un poco hacia atrás en vez de no inclinar
      // (como mucho 0.15 m por inclinación: en una esquina no se retrocede sin fin)
      if (l1 === 0) this._leanPush = 0;
      if (l1 !== 0 && Math.abs(l1) > Math.abs(this.lean) && (this._leanPush ?? 0) < 0.15) {
        const bx = this.pos.x, bz = this.pos.z;
        this._pushHeadOut(l1);
        this._leanPush = (this._leanPush ?? 0) + Math.hypot(this.pos.x - bx, this.pos.z - bz);
      }
      // magnitud permitida en el lado de l1 (0 siempre vale: el cuerpo ya está resuelto)
      const sgn = Math.sign(l1) || 1;
      const mag = l1 === 0 ? 0 : this._limit(Math.min(Math.abs(this.lean), Math.abs(l1)), Math.abs(l1), (m) => this.headClear(this.stanceLow, sgn * m));
      this.lean = sgn * mag;
      this.leanRoom = sgn > 0 ? { l: this.leanRoom.l, r: Math.abs(l1) > mag ? mag : 1 } : { l: Math.abs(l1) > mag ? mag : 1, r: this.leanRoom.r };
    }

    // Pendiente longitudinal para el rig.
    let pitchTarget = 0;
    if (this.grounded && airStates) {
      const fd = this.facing();
      const d = 0.42;
      const front = this.world.groundHeight({ x: this.pos.x + fd.x * d, z: this.pos.z + fd.z * d }, PLAYER_R * 0.4, this.y + M.maxStepUp);
      const back = this.world.groundHeight({ x: this.pos.x - fd.x * d, z: this.pos.z - fd.z * d }, PLAYER_R * 0.4, this.y + M.maxStepUp);
      if (Math.abs(front - back) <= 0.5) {
        pitchTarget = Math.max(-0.3, Math.min(0.3, Math.atan2(front - back, d * 2)));
      }
    }
    this.groundPitch += (pitchTarget - this.groundPitch) *
      (1 - Math.exp(-M.groundPitchLerp * dt));
  }

  // Trepar con la acción de salto: cara LOW delante según la VISTA, a
  // alcance, sin alejarse con el stick. Mismas comprobaciones que antes.
  _tryMantleAhead(mw) {
    const F = TUNING.fp;
    if (!this.world.findCover || !this.grounded) return false;
    const f = this.cam.flatForward();
    const found = this.world.findCover(this.pos, f, F.mantleReach + PLAYER_R, PLAYER_R, 0.6, this.y);
    const face = found?.face;
    if (!face || face.kind === 'high') return false;
    const top = (face.topY ?? face.h) - this.y;
    if (!(top >= F.mantleMinH && top <= F.mantleMaxH)) return false;
    const n = face.n;
    // el stick no puede pedir lo contrario (alejarse de la cara)
    if (mw.mag > 0.1 && (mw.x * n.x + mw.z * n.z) / mw.mag > 0.3) return false;
    return this._tryMantle(face, n);
  }

  // Mantle/vault corto sobre cover BAJO. Verifica ANTES de comprometer la
  // animación: espacio libre sobre el borde (nada más alto detrás), y
  // superficie de aterrizaje al nivel del tope del bloque.
  _tryMantle(f, n) {
    if (this.mantle) return false;
    if (!(f.h <= TUNING.cover.lowHeight || (f.topY != null && f.topY - this.y <= TUNING.fp.mantleMaxH))) return false;
    const h = f.topY ?? f.h;
    // aterrizaje a 0,5 m pasado el plano de la cara, desde donde se esté
    const side = (this.pos.x - f.a.x) * n.x + (this.pos.z - f.a.z) * n.z;
    const landX = this.pos.x - n.x * (side + 0.5);
    const landZ = this.pos.z - n.z * (side + 0.5);
    TMP_O.set(this.pos.x, h + 0.55, this.pos.z);
    TMP_D.set(-n.x, 0, -n.z);
    if (this.world.raycast(TMP_O, TMP_D, side + 0.9) !== null) return false;
    const gh = this.world.groundHeight({ x: landX, z: landZ }, PLAYER_R, h + 0.2);
    if (Math.abs(gh - h) > 0.25) return false;
    this.mantle = {
      t: 0, dur: TUNING.mantle.time,
      fx: this.pos.x, fz: this.pos.z, fy: this.y,
      tx2: landX, tz2: landZ, ty: h,
      n,
    };
    this.crouched = false;
    this.slide = null;
    this.vel = { x: 0, z: 0 };
    this.aim = false;
    this._setState('mantle');
    this.ev.onMantle?.();
    return true;
  }

  _tryJump() {
    this.vy = TUNING.jump.vel;
    this.grounded = false;
    this.coyoteT = 0;
    this.ev.onJump?.();
  }
}
