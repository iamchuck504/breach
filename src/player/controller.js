// Máquina de estados del jugador local. Prioridad absoluta: responsividad.
// Estados: idle / run / roadie / dive / slide / cover / dead.
// El wallbounce es cancelar un slide (o salir de cover en la ventana de bounce)
// hacia otra cobertura: cada rebote encadenado da un pequeño bonus de velocidad.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';

const yawFromDir = (x, z) => Math.atan2(-x, -z);
const lerpAngle = (a, b, k) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};
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

export const PLAYER_R = 0.38;

const TMP_O = new THREE.Vector3(), TMP_D = new THREE.Vector3();

export class Controller {
  constructor(world, camera, events = {}) {
    this.world = world;
    this.cam = camera;
    this.ev = events; // {onSlideStart, onCoverEnter, onBounce, onDive, onDetach}
    this.pos = { x: 0, z: -16 };
    this.vel = { x: 0, z: 0 };
    this.y = 0;             // altura de los pies
    this.vy = 0;
    this.grounded = true;
    this.flip = null;       // { t, dur } — vuelta de gato del salto de pared
    this.yaw = 0;
    this.state = 'idle';
    this.stateT = 0;
    this.cover = null;      // face actual
    this.coverEntry = null; // absorción corta de posición/momentum al engancharse
    this.slide = null;      // {target, face, dir}
    this.dive = null;       // {dir}
    this.chain = 0;         // rebotes encadenados
    this.bounceWindow = 0;
    this.evadeCooldown = 0;
    this.runT = 0;          // carrera continua (momentum ganado)
    this.runDist = 0;
    this.evadeMom = 0;      // impulso ganado aplicado a la evasión en curso
    this.mantle = null;     // vault sobre cover bajo en progreso
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
    this.detachT = 0;
    this.aim = false;
    this.firingBlind = 0;   // timer para mantener pose de blindfire
    this.coverAimExposure = 0; // 0 protegido, 1 asomado con muzzle libre
    this.blindMode = null;  // 'over' | 'left' | 'right' según cover/cámara
    this._blindModePrev = null;
    this.blindPoseExposure = 0;
    this.groundPitch = 0;  // inclinación del suelo en la dirección del cuerpo
    this.dead = false;
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  facing() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; }

  cameraYawError() { return angleDelta(this.yaw, this.cam.yaw); }

  fireAligned(maxDeg = TUNING.combat.fireAlignMaxDeg) {
    const lowAim = this.state === 'cover' && this.aim && this.cover &&
      this.cover.h <= TUNING.cover.lowHeight;
    return Math.abs(this.cameraYawError()) <= maxDeg * Math.PI / 180 &&
      (!lowAim || this.coverAimExposure >= 0.82);
  }

  _turnToCamera(dt, blindfire = false) {
    const degPerSec = blindfire
      ? TUNING.combat.bodyTurnBlindDeg
      : TUNING.combat.bodyTurnAimDeg;
    this.yaw = approachAngle(this.yaw, this.cam.yaw, degPerSec * Math.PI / 180 * dt);
  }

  camState() {
    if (this.dead) return { mode: 'normal' };
    if (this.aim) {
      // asomándose por la orilla izquierda: la cámara cambia de hombro
      // shoulder swap automático para no ver solo la pared
      const side = this.state === 'cover' && this.coverLeanAnim ? this.coverLeanAnim : 1;
      return { mode: 'aim', side };
    }
    if (this.state === 'roadie') return { mode: 'roadie' };
    if (this.state === 'cover') return { mode: 'cover', side: this.coverLeanAnim || 1 };
    return { mode: 'normal' };
  }

  animState() {
    if (this.dead) return 'dead';
    switch (this.state) {
      case 'cover': {
        const low = this.cover && this.cover.h <= TUNING.cover.lowHeight;
        if (this.firingBlind > 0 && !this.aim) {
          if (this.blindMode === 'over' && low) return 'blind_over';
          if (this.blindMode === 'left') return low ? 'blind_low_left' : 'blind_high_left';
          if (this.blindMode === 'right') return low ? 'blind_low_right' : 'blind_high_right';
        }
        return low ? 'cover_low' : 'cover_high';
      }
      case 'flip': return 'flip';
      case 'mantle': return 'mantle';
      case 'roadie': return this.grounded ? 'roadie' : 'jump';
      case 'melee': return 'melee';
      case 'dive': return 'dive';
      case 'slide': return 'slide';
      default:
        if (!this.grounded) return 'jump';
        return this.speed > 0.4 ? 'run' : 'idle';
    }
  }

  animParams() {
    const st = this.animState();
    // twist de torso hacia la cámara (upper-body aim al correr lateral)
    let twist = 0;
    if (!this.aim && (st === 'idle' || st === 'run')) {
      let d = this.cam.yaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      twist = Math.max(-0.9, Math.min(0.9, d));
    }
    // error de yaw cuerpo-cámara: el ARMA lo compensa al disparar para que
    // el cañón visual apunte a la línea de tiro real aunque el cuerpo gire
    let yawErr = this.cameraYawError();
    const visualMax = TUNING.combat.visualAimMaxDeg * Math.PI / 180;
    yawErr = Math.max(-visualMax, Math.min(visualMax, yawErr));
    return {
      state: st,
      speed: Math.min(1, this.speed / TUNING.move.roadieSpeed),
      aim: this.aim,
      aimPitch: this.cam.pitch,
      aimYawErr: yawErr,
      twist,
      firing: this.firingBlind > 0 &&
        (this.state !== 'cover' || !!this.blindMode),
      flipT: this.flip ? Math.min(1, this.flip.t / this.flip.dur) : 0,
      flipDir: this.flip?.dir ?? 1,
      flipAxis: this.flip?.axis ?? 'z',
      coverLean: this.coverLeanAnim ?? 0,
      coverAimExposure: this.coverAimExposure,
      blindPoseExposure: this.blindPoseExposure,
      blindMode: this.blindMode,
      coverKind: this.cover?.kind,
      latMove: this._latMove(),
      groundPitch: this.groundPitch,
      meleePhase: this.state === 'melee'
        ? Math.min(1, this.meleeT / Math.max(0.001, this.meleeEndT || TUNING.melee.time))
        : 0,
      meleeConnected: this.meleeConnected,
      meleeFromCover: this.meleeFromCover,
      meleeEntrySpeed: this.meleeEntrySpeed,
    };
  }

  // velocidad lateral en el frame del personaje (-1..1), para el paso lateral
  _latMove() {
    if (this.state !== 'cover') return 0;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const v = (this.vel.x * rx + this.vel.z * rz) / TUNING.move.coverStrafe;
    return Math.max(-1, Math.min(1, v));
  }

  // limpia TODO el estado transitorio (flags pegados = poses/gameplay rotos)
  _clearTransient() {
    this.firingBlind = 0;
    this.coverAimExposure = 0;
    this.blindMode = null;
    this._blindModePrev = null;
    this.blindPoseExposure = 0;
    this.coverLeanAnim = 0;
    this.detachT = 0;
    this.evadeCooldown = 0;
    this.runT = 0;
    this.runDist = 0;
    this.evadeMom = 0;
    this.mantle = null;
    this.coverEntry = null;
    this.edgePushT = 0;
    this.bounceWindow = 0;
    this.chain = 0;
    this.usedDouble = false;
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
  }

  respawn(spawn) {
    this.pos = { x: spawn.x, z: spawn.z };
    this.vel = { x: 0, z: 0 };
    this.y = 0; this.vy = 0; this.grounded = true; this.flip = null;
    // La pendiente pertenece al suelo de la vida anterior. Conservarla hacía
    // que el rig reapareciera inclinado durante los primeros frames.
    this.groundPitch = 0;
    this._clearTransient();
    this.yaw = spawn.yaw;
    this.cam.yaw = spawn.yaw;
    this.cam.pitch = -0.12;
    this.state = 'idle'; this.stateT = 0;
    this.cover = null; this.coverEntry = null; this.slide = null; this.dive = null;
    this.chain = 0; this.dead = false;
  }

  kill() {
    this.dead = true;
    this._setState('idle'); // resetea stateT (directo dejaba el valor pre-muerte)
    this.cover = null; this.coverEntry = null; this.slide = null; this.dive = null; this.flip = null;
    this.mantle = null;
    this.aim = false;
    this.vel = { x: 0, z: 0 };
    this._clearTransient();
  }

  // dir del input en mundo (relativo a cámara)
  _moveWorld(input) {
    const mv = input.moveVec();
    const f = this.cam.flatForward(), r = this.cam.flatRight();
    return { x: f.x * mv.z + r.x * mv.x, z: f.z * mv.z + r.z * mv.x, mag: Math.hypot(mv.x, mv.z) };
  }

  _setState(s) { this.state = s; this.stateT = 0; }

  _beginMelee(fromCover = false) {
    const ml = TUNING.melee;
    if (!this.grounded || this.meleeCd > 0 || this.state === 'melee') return false;
    const previousState = this.state;
    this.meleeT = 0;
    this.meleeEndT = ml.hitAt + ml.missRecovery;
    this.meleeFreezeT = 0;
    this.meleeConnected = false;
    this.meleeKilled = false;
    this.meleeEntrySpeed = Math.min(TUNING.move.roadieSpeed, this.speed);
    this.meleeEntryState = previousState;
    this.meleeFromCover = fromCover;
    this.meleeTravel = 0;
    this.aim = false;
    this.firingBlind = 0;
    if (fromCover) {
      this.cover = null;
      this.coverEntry = null;
      this.coverLeanAnim = 0;
      this.detachT = 0;
      this.vel.x = 0;
      this.vel.z = 0;
    }
    this._setState('melee');
    this.ev.onMeleeStart?.();
    return true;
  }

  // El resultado llega exactamente en la ventana de contacto. Un acierto
  // recupera antes que un fallo y congela solo el gesto unas milésimas para
  // vender peso, sin detener la simulación ni el networking.
  confirmMelee(connected, killed = false) {
    if (this.state !== 'melee' || !connected) return;
    const ml = TUNING.melee;
    this.meleeConnected = true;
    this.meleeKilled = !!killed;
    this.meleeFreezeT = Math.max(this.meleeFreezeT, ml.hitStop);
    const recovery = killed ? ml.killRecovery : ml.hitRecovery;
    this.meleeEndT = Math.max(this.meleeT + recovery, ml.hitAt + recovery);
  }

  // Busca cobertura y entra en slide, o hace dive. Devuelve 'slide' | 'dive'
  // | false — SOLO 'slide' cuenta como rebote (chain/SFX/bonus); el fallback
  // de dive devolvía true y un rebote al vacío sumaba cadena igual.
  _tryEvade(dir, range, allowDive = true) {
    const T = TUNING.evade;
    if (this.evadeCooldown > 0) return false;
    // normalizar SIEMPRE: con el stick a medio recorrido la búsqueda de
    // cobertura y la velocidad del dive salían escaladas por la magnitud
    const m = Math.hypot(dir.x, dir.z);
    if (m < 0.001) return false;
    dir = { x: dir.x / m, z: dir.z / m };
    this.coverLeanAnim = 0; // no arrastrar el lean al salir de cover
    const exclude = this.cover;
    const found = this.world.findCover(this.pos, dir, range, PLAYER_R, 0.4);
    if (found && found.face !== exclude && found.dist > 0.5) {
      this.slide = { target: found.target, face: found.face, dir };
      this.dive = null;
      this.cover = null;
      this._setState('slide');
      this.evadeCooldown = T.bounceCooldown;
      this.ev.onSlideStart?.(this.chain);
      return 'slide';
    }
    // Un cancel de dive solo puede convertirse en un wallbounce real. Si no
    // hay cover, conservar el dive actual evita reiniciarlo infinitamente.
    if (!allowDive) return false;
    // sin cobertura: dive en la dirección pedida
    this.dive = { dir };
    this.slide = null;
    this.cover = null;
    this._setState('dive');
    this.evadeCooldown = T.bounceCooldown;
    this.ev.onDive?.();
    return 'dive';
  }

  update(dt, input, firing) {
    const M = TUNING.move, E = TUNING.evade, C = TUNING.cover;
    this.stateT += dt;
    this.evadeCooldown = Math.max(0, this.evadeCooldown - dt);
    this.bounceWindow = Math.max(0, this.bounceWindow - dt);
    this.firingBlind = Math.max(0, this.firingBlind - dt);
    this.meleeCd = Math.max(0, this.meleeCd - dt);

    if (this.dead) { this.aim = false; return; }

    const mw = this._moveWorld(input);
    const hasInput = mw.mag > 0.1;
    const aimAllowed = this.state !== 'dive' && this.state !== 'slide' &&
      this.state !== 'roadie' && this.state !== 'flip' && this.state !== 'mantle' &&
      this.state !== 'melee';
    this.aim = input.aimHeld && aimAllowed;
    const lowCoverAim = this.state === 'cover' && this.aim && this.cover &&
      this.cover.h <= C.lowHeight;
    const exposeTarget = lowCoverAim ? 1 : 0;
    const exposeRate = exposeTarget ? 18 : 25;
    this.coverAimExposure += (exposeTarget - this.coverAimExposure) *
      (1 - Math.exp(-exposeRate * dt));
    // Evaluar contra el input de ESTE frame, no contra this.aim anterior.
    // Así mantener fuego al soltar ADS entra a blindfire sin un frame ambiguo.
    if (firing && !this.aim) this.firingBlind = 0.7;

    // momentum GANADO corriendo: tiempo continuo + distancia reciente en el
    // suelo. Se pierde al instante al dejar de correr — un toque de carrera
    // seguido de evade no genera impulso falso.
    if (this.grounded && (this.state === 'run' || this.state === 'roadie') &&
        this.speed > TUNING.move.runSpeed * 0.55) {
      this.runT += dt;
      this.runDist = Math.min(E.momentumRunDist * 2, this.runDist + this.speed * dt);
    } else if (this.state !== 'slide' && this.state !== 'dive') {
      this.runT = 0;
      this.runDist = 0;
    }

    switch (this.state) {
      case 'idle': case 'run': case 'roadie': {
        const roadie = this.state === 'roadie';
        // Estados lógicos y visuales deben coincidir: momentum, pasos, red y
        // animación consumen este estado. Antes se podía correr a 4.8 m/s
        // permaneciendo lógicamente en idle.
        if (roadie && (!input.sprintHeld || !hasInput || input.aimHeld || firing)) {
          this._setState(hasInput || this.speed > 0.4 ? 'run' : 'idle');
        } else if (!roadie && input.sprintHeld && hasInput && !this.aim &&
                   this.stateT > 0.05) {
          this._setState('roadie');
        } else if (this.state === 'idle' && hasInput) {
          this._setState('run');
        } else if (this.state === 'run' && !hasInput && this.speed <= 0.4) {
          this._setState('idle');
        }

        const targetSpeed = (this.state === 'roadie' ? M.roadieSpeed : M.runSpeed) * (this.aim ? 0.45 : 1);
        let dx = mw.x, dz = mw.z;

        if (this.state === 'roadie') {
          // giro pesado: el heading persigue al input, la velocidad va por el heading
          const desired = yawFromDir(dx, dz);
          this.yaw = lerpAngle(this.yaw, desired, 1 - Math.exp(-M.roadieTurnLerp * dt));
          const f = this.facing();
          dx = f.x; dz = f.z;
        } else if (this.aim || firing) {
          // DISPARAR MANDA sobre correr: el cuerpo encara a la cámara aunque
          // te muevas hacia atrás o de lado (las piernas strafean). El límite
          // angular evita que un delta grande se convierta en un snap de 180°.
          this._turnToCamera(dt);
        } else if (hasInput) {
          this.yaw = lerpAngle(this.yaw, yawFromDir(dx, dz), 1 - Math.exp(-M.turnLerp * dt));
        } else {
          // En reposo el cuerpo y la mira siguen a la cámara.
          this.yaw = approachAngle(this.yaw, this.cam.yaw,
            TUNING.combat.bodyTurnFollowDeg * Math.PI / 180 * dt);
        }

        const want = hasInput || this.state === 'roadie';
        const tx = want ? dx * targetSpeed : 0;
        const tz = want ? dz * targetSpeed : 0;
        // en el aire el momentum se respeta: sin input casi no frena
        const acc = (want ? M.accel : M.decel * (this.grounded ? 1 : 0.06)) *
          (this.grounded ? 1 : TUNING.jump.airControl);
        const k = 1 - Math.exp(-(acc / Math.max(targetSpeed, 1)) * dt);
        this.vel.x += (tx - this.vel.x) * k;
        this.vel.z += (tz - this.vel.z) * k;

        // saltar: en el suelo salto normal; en el aire: wall kick si hay
        // pared, si no doble salto = vuelta hacia la dirección presionada
        if (input.jumpPressed) {
          if (this.grounded) this._tryJump();
          else if (!this._tryWallKick() && !this.usedDouble && hasInput) this._airRoll(mw, input.moveVec());
        }

        // Nueva pulsación válida en el suelo: si el estado anterior ya terminó,
        // evade vuelve a estar disponible sin una espera artificial adicional.
        if (input.evadePressed && this.grounded) {
          this.chain = 0;
          const dir = hasInput ? { x: mw.x, z: mw.z } : this.facing();
          // impulso ganado: solo si venía corriendo un tramo REAL y la
          // evasión va en la dirección que ya traía (proporcional, con tope)
          let mom = 0;
          if (this.runT > 0.15 && this.speed > 1) {
            const align = (this.vel.x * dir.x + this.vel.z * dir.z) /
              (this.speed * Math.max(0.001, Math.hypot(dir.x, dir.z)));
            mom = Math.min(1, this.runT / E.momentumRunTime) *
              Math.min(1, this.runDist / E.momentumRunDist) *
              Math.max(0, align);
          }
          this.evadeMom = mom;
          this.runT = 0;
          this.runDist = 0;
          // Entrar a roadie y evadir en el mismo frame no regala su alcance:
          // se obtiene solo si ya había velocidad real de carrera.
          const earnedRoadie = roadie && this.speed > M.runSpeed * 0.55;
          const range = earnedRoadie ? E.roadieSlideDist : E.slideMaxDist;
          // primero intento snap directo si el cover está pegado
          const snap = this.world.findCover(this.pos, dir, C.snapRange, PLAYER_R, 0.3);
          if (snap && snap.dist <= C.directAttachRange) this._enterCover(snap.face, snap.target);
          else this._tryEvade(dir, range);
        }

        // El ataque conserva la lectura del movimiento previo, pero no su
        // velocidad completa: correr aporta peso, nunca un dash gratuito.
        // Una evasión resuelta este mismo frame sigue teniendo prioridad.
        if (input.meleePressed && this.grounded && this.meleeCd <= 0 &&
            (this.state === 'idle' || this.state === 'run' || this.state === 'roadie')) {
          this._beginMelee(false);
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
        // Impulso corto hasta el contacto. El bonus depende de velocidad REAL
        // de entrada y el recorrido total queda limitado a 30 cm.
        const wind = Math.max(0, 1 - this.meleeT / Math.max(0.001, ml.hitAt));
        const runFactor = Math.min(1, this.meleeEntrySpeed / TUNING.move.roadieSpeed);
        let push = (ml.lungeSpeed + runFactor * ml.runLungeBonus) * wind;
        const remaining = Math.max(0, ml.maxLunge - this.meleeTravel);
        push = Math.min(push, remaining / Math.max(dt, 1e-4));
        this.meleeTravel += push * dt;
        const f = this.facing();
        this.vel.x = f.x * push;
        this.vel.z = f.z * push;
        // Asistencia pequeña: solo dentro de un cono frontal razonable y con
        // tope angular. Un giro de cámara de 90/180° nunca arrastra el golpe.
        const camDelta = angleDelta(this.yaw, this.cam.yaw);
        const assist = ml.assistDeg * Math.PI / 180;
        if (this.meleeT <= ml.hitAt && Math.abs(camDelta) <= assist) {
          this.yaw = approachAngle(this.yaw, this.cam.yaw,
            ml.assistTurnDeg * Math.PI / 180 * dt);
        }
        if (this.meleeT >= this.meleeEndT) {
          this._setState(hasInput ? 'run' : 'idle');
          this.meleeCd = ml.inputGuard;
        }
        break;
      }

      case 'mantle': {
        // vault corto sobre cover bajo: sube primero, avanza después.
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
        this.yaw = lerpAngle(this.yaw, yawFromDir(-m.n.x, -m.n.z), 1 - Math.exp(-12 * dt));
        if (k >= 1) {
          this.mantle = null;
          this.grounded = true;
          this.vy = 0;
          this._setState(hasInput ? 'run' : 'idle');
          // continuidad: sale caminando encima, no clavado en seco
          const fd = this.facing();
          this.vel.x = fd.x * M.runSpeed * TUNING.mantle.exitSpeed;
          this.vel.z = fd.z * M.runSpeed * TUNING.mantle.exitSpeed;
        }
        break;
      }

      case 'flip': {
        // vuelta en el aire: el impulso manda; el yaw sigue a la cámara
        // para poder disparar (el giro es del modelo, no del control)
        this.flip.t += dt;
        this.yaw = lerpAngle(this.yaw, this.cam.yaw, 1 - Math.exp(-9 * dt));
        if (this.flip.t >= this.flip.dur) {
          // la vuelta terminó en el aire: recuperar control aéreo normal
          this.flip = null;
          this._setState('run');
        }
        break;
      }

      case 'slide': {
        const s = this.slide;
        const spd = E.slideSpeed *
          (1 + E.chainSpeedBonus * this.chain + E.momentumBoost * this.evadeMom);
        const dx = s.target.x - this.pos.x, dz = s.target.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        this.yaw = lerpAngle(this.yaw, yawFromDir(dx, dz), 1 - Math.exp(-18 * dt));
        if (this.stateT > 0.9) {
          // target inalcanzable (colisión lo empuja fuera): NUNCA deslizarse
          // para siempre — rescate a run, frenando a velocidad de carrera
          this.slide = null;
          this._setState('run');
          this.chain = 0;
          this.evadeMom = 0;
          this.evadeCooldown = 0;
          const sp = Math.hypot(this.vel.x, this.vel.z);
          if (sp > M.runSpeed) {
            const k = M.runSpeed / sp;
            this.vel.x *= k; this.vel.z *= k;
          }
        } else if (d < Math.max(0.16, spd * dt)) {
          this._enterCover(s.face, s.target);
        } else {
          this.vel.x = (dx / d) * spd; this.vel.z = (dz / d) * spd;
          // WALLBOUNCE: cancelar el slide hacia otra dirección
          if (input.evadePressed && this.stateT > 0.05 && this.chain < E.chainMax) {
            const ndir = mw.mag > 0.1 ? { x: mw.x, z: mw.z } : null;
            if (ndir) {
              this.chain++;
              this.evadeMom *= 0.45; // el impulso ganado se disipa por rebote
              if (this._tryEvade(ndir, E.bounceRange) === 'slide') this.ev.onBounce?.(this.chain);
              else this.chain--; // dive al vacío o nada: sin bonus ni SFX
            }
          }
        }
        break;
      }

      case 'dive': {
        const t = this.stateT / E.diveTime;
        const ease = 1 - t * t; // desacelera
        const spd = E.diveSpeed * Math.max(0.15, ease) *
          (1 + E.chainSpeedBonus * this.chain + E.momentumBoost * this.evadeMom);
        this.vel.x = this.dive.dir.x * spd;
        this.vel.z = this.dive.dir.z * spd;
        this.yaw = lerpAngle(this.yaw, yawFromDir(this.dive.dir.x, this.dive.dir.z), 1 - Math.exp(-14 * dt));
        if (input.evadePressed && t > E.diveCancelPct && this.chain < E.chainMax) {
          const ndir = mw.mag > 0.1 ? { x: mw.x, z: mw.z } : this.dive.dir;
          this.chain++;
          this.evadeMom *= 0.45;
          if (this._tryEvade(ndir, E.bounceRange, false) === 'slide') this.ev.onBounce?.(this.chain);
          else this.chain--;
        } else if (t >= 1) {
          this._setState(hasInput ? 'run' : 'idle');
          this.chain = 0;
          this.evadeMom = 0;
          this.evadeCooldown = 0;
        }
        break;
      }

      case 'cover': {
        const f = this.cover;
        const n = f.n;
        const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z;
        const len = Math.hypot(tx, tz);
        const ux = tx / len, uz = tz / len;
        const low = f.h <= TUNING.cover.lowHeight;

        // posición a lo largo de la cara + orillas
        let u = ((this.pos.x - f.a.x) * ux + (this.pos.z - f.a.z) * uz);
        const edgeDist = C.cornerLean + PLAYER_R;
        const nearA = u < edgeDist, nearB = (len - u) < edgeDist;

        // en pared alta solo se puede apuntar asomándose en una orilla
        if (!low && this.aim && !nearA && !nearB) this.aim = false;
        // La restricción contextual pudo convertir ADS en blindfire este frame.
        if (firing && !this.aim) this.firingBlind = 0.7;
        const edgeSide = nearA && (!nearB || u < len - u) ? -1 : nearB ? 1 : 0;
        const camF = this.cam.flatForward();
        const aroundEdge = edgeSide
          ? camF.x * ux * edgeSide + camF.z * uz * edgeSide
          : -1;
        let aimLeanSide = 0;
        if (!low && this.aim) aimLeanSide = edgeSide;

        // Melee contextual desde una orilla: abandonar cover requiere una
        // pulsación explícita y solo se permite donde el arma/brazos pueden
        // salir lateralmente. La resolución física decidirá después si hay
        // pared o box entre el atacante y la víctima.
        if (input.meleePressed && edgeSide !== 0 && this.meleeCd <= 0) {
          this._beginMelee(true);
          break;
        }

        // Blindfire contextual. En cover alto la POSICIÓN en la orilla elige
        // automáticamente el lado: la cámara guía el tiro, pero ya no hay que
        // encontrar un ángulo estrecho para activar la pose. En cover bajo se
        // conserva la distinción entre disparar por arriba y rodear una esquina.
        let blindEdgeSide = 0;
        if (!this.aim && this.firingBlind > 0) {
          if (!low && edgeSide) blindEdgeSide = edgeSide;
          else if (low && edgeSide && aroundEdge > 0.24) blindEdgeSide = edgeSide;
          else if (low) this.blindMode = 'over';
          else this.blindMode = null;
        } else this.blindMode = null;

        // Movimiento lateral confinado al cover. La velocidad se deriva del
        // desplazamiento REAL ya limitado, de modo que empujar hacia fuera en
        // el extremo detiene naturalmente al personaje en vez de animar pasos
        // o acumular una salida automática.
        const lat = hasInput ? (mw.x * ux + mw.z * uz) : 0;
        const previousU = u;
        const entryCarry = this.coverEntry
          ? this.coverEntry.tangentSpeed * Math.exp(-C.enterMomentumDamp * this.coverEntry.t)
          : 0;
        u += (lat * M.coverStrafe + entryCarry) * dt + aimLeanSide * 1.3 * dt;
        const leanOut = aimLeanSide !== 0 ? 0.45 : 0;
        u = Math.max(PLAYER_R * 0.7 - (aimLeanSide < 0 ? leanOut : 0),
          Math.min(len - PLAYER_R * 0.7 + (aimLeanSide > 0 ? leanOut : 0), u));
        const desiredX = f.a.x + ux * u + n.x * PLAYER_R;
        const desiredZ = f.a.z + uz * u + n.z * PLAYER_R;
        if (this.coverEntry) {
          const entry = this.coverEntry;
          entry.t += dt;
          const ex = desiredX - this.pos.x, ez = desiredZ - this.pos.z;
          const ed = Math.hypot(ex, ez);
          const smooth = 1 - Math.exp(-C.enterLerp * dt);
          const maxStep = C.enterPullSpeed * dt;
          const k = ed > 1e-6 ? Math.min(1, smooth, maxStep / ed) : 1;
          this.pos.x += ex * k;
          this.pos.z += ez * k;
          if (ed < 0.012 || (entry.t >= entry.dur && ed < 0.05) ||
              entry.t >= C.enterMaxTime + 0.05) {
            this.pos.x = desiredX;
            this.pos.z = desiredZ;
            this.coverEntry = null;
            this.bounceWindow = TUNING.evade.bounceWindow;
            this.ev.onCoverEnter?.(this.chain);
          }
        } else {
          this.pos.x = desiredX;
          this.pos.z = desiredZ;
        }
        const coverSpeed = dt > 0 ? (u - previousU) / dt : 0;
        this.vel.x = coverSpeed * ux; this.vel.z = coverSpeed * uz;

        // orientación: DE ESPALDAS a la pared; al apuntar/disparar → cámara.
        // Blindfire gira más pesado para conservar la lectura del cover y no
        // invertir cuerpo/cañón de un frame al siguiente.
        if (this.aim || (this.firingBlind > 0 && this.blindMode)) {
          this._turnToCamera(dt, !this.aim);
        } else {
          this.yaw = approachAngle(this.yaw, yawFromDir(n.x, n.z),
            TUNING.combat.bodyTurnFollowDeg * Math.PI / 180 * dt);
        }

        // Señal de lean contra el frame de intención de la cámara, no contra el
        // yaw corporal que todavía está interpolando. Así el rig elige desde el
        // primer frame el brazo correcto para ESA orilla y no invierte la pose
        // a mitad de la transición del cuerpo.
        const poseEdgeSide = aimLeanSide || blindEdgeSide;
        if (poseEdgeSide !== 0) {
          const rx = Math.cos(this.cam.yaw), rz = -Math.sin(this.cam.yaw);
          this.coverLeanAnim = (ux * poseEdgeSide) * rx + (uz * poseEdgeSide) * rz >= 0 ? 1 : -1;
          if (blindEdgeSide) this.blindMode = this.coverLeanAnim > 0 ? 'right' : 'left';
        } else this.coverLeanAnim = 0;

        const away = hasInput ? (mw.x * n.x + mw.z * n.z) : 0;
        // Zona para acciones explícitas en el extremo. El stick lateral por sí
        // solo nunca usa esta zona para abandonar la cobertura.
        const exitZone = C.cornerLean * 1.7 + PLAYER_R;
        const eSign = (len - u) < exitZone ? 1 : u < exitZone ? -1 : 0;
        const latOut = eSign !== 0 && hasInput ? (mw.x * ux + mw.z * uz) * eSign : 0;

        // Salto/mantle hacia delante sobre cover bajo. Es una intención
        // distinta del salto lateral en una esquina y se resuelve primero.
        if (input.jumpPressed && low && hasInput) {
          const im = Math.max(0.001, Math.hypot(mw.x, mw.z));
          const into = -(mw.x * n.x + mw.z * n.z) / im;
          const latIn = Math.abs((mw.x * ux + mw.z * uz) / im);
          if (into >= 0.72 && latIn <= into * 0.75 && this._tryMantle(f, n)) break;
        }

        // Salto lateral explícito desde una orilla.
        if (input.jumpPressed && eSign !== 0) {
          const ox = ux * eSign, oz = uz * eSign;
          const wantOut = hasInput ? (mw.x * ox + mw.z * oz) : 1;
          if (wantOut > 0.35) {
            TMP_O.set(this.pos.x, this.y + 0.9, this.pos.z);
            TMP_D.set(ox, 0, oz);
            if (this.world.raycast(TMP_O, TMP_D, PLAYER_R + 1.3) === null) {
              this.cover = null;
              this.chain = 0;
              this._setState('run');
              this.vy = TUNING.jump.vel * 0.85;
              this.grounded = false;
              this.vel.x = ox * M.runSpeed * 0.95 + n.x * 1.4;
              this.vel.z = oz * M.runSpeed * 0.95 + n.z * 1.4;
              this.ev.onJump?.();
              break;
            }
          }
        }

        // WALLBOUNCE / EVADE / MANTLE: una diagonal en el extremo es una
        // evasión lateral, no un mantle ni un input perdido. Frente a cover
        // alto se conserva la cobertura porque no existe mantle posible.
        if (input.evadePressed) {
          const dir = hasInput ? { x: mw.x, z: mw.z } : { x: n.x, z: n.z };
          const im3 = Math.max(0.001, Math.hypot(dir.x, dir.z));
          const into = -(dir.x * n.x + dir.z * n.z) / im3;
          const latIn = Math.abs((dir.x * ux + dir.z * uz) / im3);
          const centered = len < edgeDist * 2 + 0.5 || (!nearA && !nearB);
          const wantsMantle = low && into >= 0.8 && latIn <= into * 0.6 && centered;
          const wantsEvade = into < 0.5 || (eSign !== 0 && latIn > 0.35);

          if (wantsMantle) {
            if (this._tryMantle(f, n)) break;
          } else if (wantsEvade) {
            const chained = this.bounceWindow > 0 && this.chain < E.chainMax;
            if (chained) this.chain++; else this.chain = 0;
            this.evadeMom *= 0.45;
            const result = this._tryEvade(dir, E.bounceRange);
            if (result === 'slide' && chained) this.ev.onBounce?.(this.chain);
            else if (result !== 'slide' && chained) this.chain--;
            if (this.state !== 'cover') break;
          }
        }

        // Correr + dirección clara es una salida explícita. A mitad de pared,
        // solo acepta alejarse del cover; en la orilla también acepta continuar
        // lateralmente hacia fuera. Un diagonal pequeño sin sprint no expulsa.
        const runExit = input.sprintHeld && hasInput &&
          (away > 0.28 || (eSign !== 0 && latOut > 0.35));
        if (runExit) {
          const im0 = Math.max(0.001, mw.mag);
          const sx = mw.x / im0, sz = mw.z / im0;
          // SWAT TURN: correr alejándose de la pared CON otra cobertura justo
          // enfrente cruza el hueco de un tirón en vez de salir a campo
          // abierto. Exige intención clara (away alto), estar a mitad de cara
          // —la orilla es del edge-exit— y que exista cover real en línea.
          // Intención de CRUZAR: perpendicular clara al muro y sin componente
          // lateral de orilla (esa es del edge-exit). No se exige estar a
          // mitad de cara: las coberturas cortas son casi todas orilla.
          const awayN = away / Math.max(0.001, mw.mag);
          if (awayN > 0.62 && latOut < 0.35 && this.evadeCooldown <= 0) {
            const prevCover = this.cover, prevState = this.state;
            // sondear POR DELANTE: desde la posición pegada, findCover
            // devuelve la propia cara (dist 0). El punto adelantado y el
            // filtro por collider garantizan que sea otra cobertura.
            TMP_O.set(this.pos.x + sx * 1.4, this.y, this.pos.z + sz * 1.4);
            const ahead = this.world.findCover(TMP_O, { x: sx, z: sz },
              E.bounceRange - 1.4, PLAYER_R, 0.5);
            if (ahead && ahead.face?.collider !== prevCover?.collider) {
              this.cover = null;
              const res = this._tryEvade({ x: sx, z: sz }, E.bounceRange);
              if (res === 'slide') {
                this.chain = 0;
                this.evadeMom = 0;
                this.ev.onDetach?.();
                break;
              }
              // sin slide real: deshacer y salir corriendo como siempre
              this.cover = prevCover;
              this.state = prevState;
              this.dive = null;
              this.slide = null;
            }
          }
          this.cover = null;
          this.chain = 0;
          const im = Math.max(0.001, mw.mag);
          const dx2 = mw.x / im, dz2 = mw.z / im;
          // conservar continuidad corporal; el estado nuevo completa el giro
          // en los frames siguientes en vez de saltar 90° instantáneamente.
          this.yaw = lerpAngle(this.yaw, yawFromDir(dx2, dz2),
            1 - Math.exp(-M.turnLerp * dt));
          this._setState('roadie');
          const spd = M.roadieSpeed * 0.78;
          this.vel.x = dx2 * spd;
          this.vel.z = dz2 * spd;
          this.ev.onDetach?.();
          break;
        }

        // Stick claramente hacia atrás: detach deliberado desde cualquier
        // punto de la cara. El breve filtro temporal absorbe diagonales/ruido,
        // pero también funciona si ADS estaba activo porque la intención manda.
        if (away > C.detachPush) {
          this.detachT += dt;
          if (this.detachT > C.detachTime) {
            this.cover = null;
            this._setState('run');
            this.chain = 0;
            this.aim = false;
            const im = Math.max(0.001, mw.mag);
            const dx2 = mw.x / im, dz2 = mw.z / im;
            this.vel.x = dx2 * M.runSpeed * C.edgeExitBoost;
            this.vel.z = dz2 * M.runSpeed * C.edgeExitBoost;
            this.ev.onDetach?.();
            break;
          }
        } else this.detachT = 0;

        break;
      }
    }

    if (this.state !== 'cover') {
      this.blindMode = null;
      this.coverEntry = null;
    }
    if (this.blindMode !== this._blindModePrev) {
      this.blindPoseExposure = 0;
      this._blindModePrev = this.blindMode;
    }
    const blindTarget = this.state === 'cover' && !this.aim && this.blindMode &&
      this.firingBlind > 0 ? 1 : 0;
    this.blindPoseExposure += ((blindTarget ? 1 : 0) - this.blindPoseExposure) *
      (1 - Math.exp(-(blindTarget ? C.blindEnterRate : C.blindExitRate) * dt));

    // integrar + colisión (cover se pega manualmente, pero el resolve no estorba;
    // en mantle el movimiento es guiado y CRUZA el borde: el resolve pelearía)
    const moveStartX = this.pos.x, moveStartZ = this.pos.z;
    const wasGrounded = this.grounded;
    if (this.state !== 'cover' && this.state !== 'mantle') {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
    }
    if (this.state !== 'mantle') {
      // En cover la posición ya fue resuelta analíticamente contra ESA cara.
      // Volver a empujar el círculo contra el mismo collider en el extremo
      // pelea con el lean (sobre todo en bus/camión/Jersey) y produce jitter.
      // Los demás obstáculos siguen resolviéndose con normalidad.
      this.world.resolveCircle(this.pos, PLAYER_R, this.y,
        this.state === 'cover' ? this.cover?.collider : null);
    }

    // Nunca subir un desnivel grande solo porque groundHeight cambió bajo el
    // círculo (caso típico: entrar de lado en una rampa). Si el movimiento
    // completo es inválido, probar cada eje permite deslizarse por el borde.
    if (wasGrounded && this.state !== 'cover' && this.state !== 'mantle') {
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

    // vertical: gravedad + suelo (permite pararse sobre coberturas)
    const airStates = this.state === 'idle' || this.state === 'run' ||
      this.state === 'roadie' || this.state === 'flip';
    if (airStates) {
      const J = TUNING.jump;
      const ground = this.world.groundHeight(this.pos, PLAYER_R, this.y);
      // Si estaba apoyado, adherirse a pendientes suaves tanto al subir como
      // al bajar. Una caída mayor conserva gravedad y animación aérea.
      const followsGround = wasGrounded && this.vy <= 0 &&
        ground <= this.y + M.maxStepUp && this.y - ground <= M.groundStickDown;
      if (followsGround) {
        this.y = ground; this.vy = 0; this.grounded = true;
        this.usedDouble = false;
      } else {
        this.vy -= J.gravity * dt;
        this.y += this.vy * dt;
      }
      if (!followsGround && this.y <= ground + 1e-3 && this.vy <= 0) {
        const wasAir = !this.grounded;
        const fallSpeed = -this.vy;
        this.y = ground; this.vy = 0; this.grounded = true;
        this.usedDouble = false;
        if (this.state === 'flip') {
          this.flip = null;
          this._setState(hasInput ? 'run' : 'idle');
        }
        if (wasAir && fallSpeed > 3) this.ev.onLand?.();
      } else {
        this.grounded = this.y <= ground + 0.02;
      }
    } else if (this.state !== 'mantle') {
      // estados pegados al suelo: la Y sigue al terreno real (un slide que
      // sale de una caja no debe conservar una altura fantasma).
      // (mantle administra su propia Y guiada)
      this.y = this.world.groundHeight(this.pos, PLAYER_R, this.y);
      this.vy = 0;
      this.grounded = true;
    }

    // Pendiente longitudinal para el rig. Dos muestras pequeñas producen un
    // pitch estable en la rampa, pero ignoran paredes/desniveles laterales.
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

  // Mantle/vault corto sobre cover BAJO (cubierto + stick hacia el bloque).
  // Verifica ANTES de comprometer la animación: espacio libre sobre el
  // borde (nada más alto detrás), y superficie de aterrizaje al nivel del
  // tope del bloque (no un hueco ni otro nivel).
  _tryMantle(f, n) {
    if (this.mantle) return false;
    const h = f.h;
    const landX = this.pos.x - n.x * (PLAYER_R + 0.5);
    const landZ = this.pos.z - n.z * (PLAYER_R + 0.5);
    TMP_O.set(this.pos.x, h + 0.55, this.pos.z);
    TMP_D.set(-n.x, 0, -n.z);
    if (this.world.raycast(TMP_O, TMP_D, PLAYER_R + 0.9) !== null) return false;
    const gh = this.world.groundHeight({ x: landX, z: landZ }, PLAYER_R, h + 0.2);
    if (Math.abs(gh - h) > 0.25) return false;
    this.mantle = {
      t: 0, dur: TUNING.mantle.time,
      fx: this.pos.x, fz: this.pos.z, fy: this.y,
      tx2: landX, tz2: landZ, ty: h,
      n,
    };
    this.cover = null;
    this.vel = { x: 0, z: 0 };
    this._setState('mantle');
    this.ev.onMantle?.();
    return true;
  }

  _tryJump() {
    this.vy = TUNING.jump.vel;
    this.grounded = false;
    this.ev.onJump?.();
  }

  // En el aire, cerca de una pared (hacia el movimiento o el facing):
  // pies a la pared y patada de regreso. Llegando de lado → giro lateral
  // (Matrix); llegando de frente → backflip. Devuelve true si pateó.
  _tryWallKick() {
    if (this.flip) return false;
    const J = TUNING.jump;
    const dirs = [];
    if (this.speed > 1) dirs.push({ x: this.vel.x / this.speed, z: this.vel.z / this.speed });
    dirs.push(this.facing());
    for (const d of dirs) {
      const wall = this.world.findCover(this.pos, d, 0.95, PLAYER_R, 0.3);
      if (!wall || wall.face.h < J.wallMinH || wall.face.h < this.y + 0.8 || wall.t > 0.85) continue;
      const n = wall.face.n;
      const tx = -n.z, tz = n.x;
      const lat = this.vel.x * tx + this.vel.z * tz; // velocidad a lo largo de la pared
      this.vy = J.wallVel;
      this.vel.x = n.x * J.wallPush + tx * lat * 0.4;
      this.vel.z = n.z * J.wallPush + tz * lat * 0.4;
      const lateral = Math.abs(lat) >= J.backflipLat;
      this.flip = {
        t: 0,
        dur: Math.max(0.4, (2 * J.wallVel / J.gravity) * 0.92),
        axis: lateral ? 'z' : 'x',
        dir: lateral ? (lat >= 0 ? 1 : -1) : 1, // frontal → backflip (atrás)
      };
      this.cover = null;
      this._setState('flip');
      this.ev.onWallJump?.();
      return true;
    }
    return false;
  }

  // Doble salto: vuelta hacia la dirección presionada (sin ganar altura).
  // mv es el stick CRUDO (x = derecha en pantalla, z = adelante): el eje del
  // giro respeta lo que el jugador presiona, no la orientación del cuerpo.
  _airRoll(mw, mv) {
    const J = TUNING.jump;
    const mag = Math.max(0.001, Math.hypot(mw.x, mw.z));
    const d = { x: mw.x / mag, z: mw.z / mag };
    const spd = Math.max(this.speed, TUNING.move.runSpeed) * J.dashMul;
    this.vel.x = d.x * spd;
    this.vel.z = d.z * spd;
    this.vy = Math.max(this.vy, J.doubleVy);
    this.usedDouble = true;
    let axis, dir;
    if (Math.abs(mv.z) >= Math.abs(mv.x)) {
      axis = 'x';
      dir = mv.z >= 0 ? -1 : 1;   // adelante = front flip, atrás = backflip
    } else {
      axis = 'z';
      dir = mv.x >= 0 ? 1 : -1;   // stick derecha = giro a la derecha
    }
    this.flip = { t: 0, dur: J.rollDur, axis, dir };
    this._setState('flip');
    this.ev.onDoubleJump?.();
  }

  _enterCover(face, target) {
    const C = TUNING.cover;
    const tx = face.b.x - face.a.x, tz = face.b.z - face.a.z;
    const len = Math.max(0.001, Math.hypot(tx, tz));
    const ux = tx / len, uz = tz / len;
    const incomingSpeed = this.speed;
    const tangentSpeed = Math.max(-TUNING.move.coverStrafe * 1.2,
      Math.min(TUNING.move.coverStrafe * 1.2, this.vel.x * ux + this.vel.z * uz));
    const distance = Math.hypot(target.x - this.pos.x, target.z - this.pos.z);
    const duration = Math.max(C.enterMinTime, Math.min(C.enterMaxTime,
      distance / Math.max(C.enterPullSpeed, incomingSpeed) + 0.08));
    this.coverEntry = { target: { ...target }, t: 0, dur: duration, tangentSpeed };
    this.vel = { x: ux * tangentSpeed, z: uz * tangentSpeed };
    this.evadeMom = 0; // el impulso ganado se gasta al llegar
    this.cover = face;
    this.slide = null;
    this._setState('cover');
    // Llegar al cover termina el slide: una NUEVA pulsación ya es válida.
    // evadeCooldown solo protege la acción mientras está activa.
    this.evadeCooldown = 0;
    this.detachT = 0;
  }
}
