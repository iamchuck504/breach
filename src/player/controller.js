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

export const PLAYER_R = 0.38;

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
    this.slide = null;      // {target, face, dir}
    this.dive = null;       // {dir}
    this.chain = 0;         // rebotes encadenados
    this.bounceWindow = 0;
    this.evadeCooldown = 0;
    this.detachT = 0;
    this.aim = false;
    this.firingBlind = 0;   // timer para mantener pose de blindfire
    this.dead = false;
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  facing() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; }

  camState() {
    if (this.dead) return { mode: 'normal' };
    if (this.aim) {
      // asomándose por la orilla izquierda: la cámara cambia de hombro
      // (shoulder swap automático, estilo Gears) para no ver solo la pared
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
        if (this.firingBlind > 0 && !this.aim && low) return 'blind_over';
        return low ? 'cover_low' : 'cover_high';
      }
      case 'flip': return 'flip';
      case 'roadie': return this.grounded ? 'roadie' : 'jump';
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
    let yawErr = this.cam.yaw - this.yaw;
    while (yawErr > Math.PI) yawErr -= Math.PI * 2;
    while (yawErr < -Math.PI) yawErr += Math.PI * 2;
    yawErr = Math.max(-0.7, Math.min(0.7, yawErr));
    return {
      state: st,
      speed: Math.min(1, this.speed / TUNING.move.roadieSpeed),
      aim: this.aim,
      aimPitch: this.cam.pitch,
      aimYawErr: yawErr,
      twist,
      firing: this.firingBlind > 0,
      flipT: this.flip ? Math.min(1, this.flip.t / this.flip.dur) : 0,
      flipDir: this.flip?.dir ?? 1,
      flipAxis: this.flip?.axis ?? 'z',
      coverLean: this.coverLeanAnim ?? 0,
      latMove: this._latMove(),
    };
  }

  // velocidad lateral en el frame del personaje (-1..1), para el paso lateral
  _latMove() {
    if (this.state !== 'cover') return 0;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const v = (this.vel.x * rx + this.vel.z * rz) / TUNING.move.coverStrafe;
    return Math.max(-1, Math.min(1, v));
  }

  respawn(spawn) {
    this.pos = { x: spawn.x, z: spawn.z };
    this.vel = { x: 0, z: 0 };
    this.y = 0; this.vy = 0; this.grounded = true; this.flip = null; this.usedDouble = false;
    this.yaw = spawn.yaw;
    this.cam.yaw = spawn.yaw;
    this.cam.pitch = -0.12;
    this.state = 'idle'; this.stateT = 0;
    this.cover = null; this.slide = null; this.dive = null;
    this.chain = 0; this.dead = false;
  }

  kill() {
    this.dead = true;
    this.state = 'idle';
    this.cover = null; this.slide = null; this.dive = null; this.flip = null;
    this.aim = false;
    this.vel = { x: 0, z: 0 };
  }

  // dir del input en mundo (relativo a cámara)
  _moveWorld(input) {
    const mv = input.moveVec();
    const f = this.cam.flatForward(), r = this.cam.flatRight();
    return { x: f.x * mv.z + r.x * mv.x, z: f.z * mv.z + r.z * mv.x, mag: Math.hypot(mv.x, mv.z) };
  }

  _setState(s) { this.state = s; this.stateT = 0; }

  // Busca cobertura y entra en slide, o hace dive. Devuelve true si hizo algo.
  _tryEvade(dir, range) {
    const T = TUNING.evade;
    if (this.evadeCooldown > 0) return false;
    const exclude = this.cover;
    const found = this.world.findCover(this.pos, dir, range, PLAYER_R, 0.4);
    if (found && found.face !== exclude && found.dist > 0.5) {
      this.slide = { target: found.target, face: found.face, dir };
      this.cover = null;
      this._setState('slide');
      this.evadeCooldown = T.bounceCooldown;
      this.ev.onSlideStart?.(this.chain);
      return true;
    }
    // sin cobertura: dive en la dirección pedida
    this.dive = { dir };
    this.cover = null;
    this._setState('dive');
    this.evadeCooldown = T.bounceCooldown;
    this.ev.onDive?.();
    return true;
  }

  update(dt, input, firing) {
    const M = TUNING.move, E = TUNING.evade, C = TUNING.cover;
    this.stateT += dt;
    this.evadeCooldown = Math.max(0, this.evadeCooldown - dt);
    this.bounceWindow = Math.max(0, this.bounceWindow - dt);
    this.firingBlind = Math.max(0, this.firingBlind - dt);
    if (firing && !this.aim) this.firingBlind = 0.7; // sostiene la postura de tiro

    if (this.dead) { this.aim = false; return; }

    const mw = this._moveWorld(input);
    const hasInput = mw.mag > 0.1;
    const aimAllowed = this.state !== 'dive' && this.state !== 'slide' &&
      this.state !== 'roadie' && this.state !== 'flip';
    this.aim = input.aimHeld && aimAllowed;

    switch (this.state) {
      case 'idle': case 'run': case 'roadie': {
        const roadie = this.state === 'roadie';
        // transiciones roadie
        if (roadie && (!input.sprintHeld || !hasInput || input.aimHeld || firing)) this._setState('run');
        else if (!roadie && input.sprintHeld && hasInput && !this.aim && this.stateT > 0.05) this._setState('roadie');

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
          // te muevas hacia atrás o de lado (las piernas strafean)
          this.yaw = lerpAngle(this.yaw, this.cam.yaw, 1 - Math.exp(-M.aimTurnLerp * dt));
        } else if (hasInput) {
          this.yaw = lerpAngle(this.yaw, yawFromDir(dx, dz), 1 - Math.exp(-M.turnLerp * dt));
        } else {
          // Gears: en reposo el cuerpo (y la mira) siguen a la cámara
          this.yaw = lerpAngle(this.yaw, this.cam.yaw, 1 - Math.exp(-9 * dt));
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

        // evadir / cover (solo en el suelo)
        if (input.evadePressed && this.grounded) {
          this.chain = 0;
          const dir = hasInput ? { x: mw.x, z: mw.z } : this.facing();
          const range = this.state === 'roadie' ? E.roadieSlideDist : E.slideMaxDist;
          // primero intento snap directo si el cover está pegado
          const snap = this.world.findCover(this.pos, dir, C.snapRange, PLAYER_R, 0.3);
          if (snap) this._enterCover(snap.face, snap.target);
          else this._tryEvade(dir, range);
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
        const spd = E.slideSpeed * (1 + E.chainSpeedBonus * this.chain);
        const dx = s.target.x - this.pos.x, dz = s.target.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        this.yaw = lerpAngle(this.yaw, yawFromDir(dx, dz), 1 - Math.exp(-18 * dt));
        if (d < Math.max(0.16, spd * dt)) {
          this._enterCover(s.face, s.target);
        } else {
          this.vel.x = (dx / d) * spd; this.vel.z = (dz / d) * spd;
          // WALLBOUNCE: cancelar el slide hacia otra dirección
          if (input.evadePressed && this.stateT > 0.05 && this.chain < E.chainMax) {
            const ndir = mw.mag > 0.1 ? { x: mw.x, z: mw.z } : null;
            if (ndir) {
              this.chain++;
              this.ev.onBounce?.(this.chain);
              this._tryEvade(ndir, E.bounceRange);
            }
          }
        }
        break;
      }

      case 'dive': {
        const t = this.stateT / E.diveTime;
        const ease = 1 - t * t; // desacelera
        const spd = E.diveSpeed * Math.max(0.15, ease) * (1 + E.chainSpeedBonus * this.chain);
        this.vel.x = this.dive.dir.x * spd;
        this.vel.z = this.dive.dir.z * spd;
        this.yaw = lerpAngle(this.yaw, yawFromDir(this.dive.dir.x, this.dive.dir.z), 1 - Math.exp(-14 * dt));
        if (input.evadePressed && t > E.diveCancelPct && this.chain < E.chainMax) {
          const ndir = mw.mag > 0.1 ? { x: mw.x, z: mw.z } : this.dive.dir;
          this.chain++;
          this.ev.onBounce?.(this.chain);
          this._tryEvade(ndir, E.bounceRange);
        } else if (t >= 1) {
          this._setState(hasInput ? 'run' : 'idle');
          this.chain = 0;
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

        // pegarse a la cara
        const rel = (this.pos.x - f.a.x) * n.x + (this.pos.z - f.a.z) * n.z;
        this.pos.x += n.x * (PLAYER_R - rel);
        this.pos.z += n.z * (PLAYER_R - rel);

        // posición a lo largo de la cara + orillas
        let u = ((this.pos.x - f.a.x) * ux + (this.pos.z - f.a.z) * uz);
        const edgeDist = C.cornerLean + PLAYER_R;
        const nearA = u < edgeDist, nearB = (len - u) < edgeDist;

        // en pared alta solo se puede apuntar asomándose en una orilla
        if (!low && this.aim && !nearA && !nearB) this.aim = false;
        let leanSide = 0; // -1 = orilla A, +1 = orilla B (en frame del tangente)
        if (!low && this.aim) leanSide = nearA && (!nearB || u < len - u) ? -1 : 1;

        // movimiento lateral + auto-asomarse hacia la orilla al apuntar
        const lat = hasInput ? (mw.x * ux + mw.z * uz) : 0;
        u += lat * M.coverStrafe * dt + leanSide * 1.3 * dt;
        const leanOut = leanSide !== 0 ? 0.45 : 0;
        u = Math.max(PLAYER_R * 0.7 - (leanSide < 0 ? leanOut : 0),
          Math.min(len - PLAYER_R * 0.7 + (leanSide > 0 ? leanOut : 0), u));
        this.pos.x = f.a.x + ux * u + n.x * PLAYER_R;
        this.pos.z = f.a.z + uz * u + n.z * PLAYER_R;
        this.vel.x = lat * ux * M.coverStrafe; this.vel.z = lat * uz * M.coverStrafe;

        // orientación: DE ESPALDAS a la pared; al apuntar/disparar → cámara
        if (this.aim || this.firingBlind > 0) {
          this.yaw = lerpAngle(this.yaw, this.cam.yaw, 1 - Math.exp(-M.aimTurnLerp * dt));
        } else {
          this.yaw = lerpAngle(this.yaw, yawFromDir(n.x, n.z), 1 - Math.exp(-10 * dt));
        }

        // señal de lean para la animación, en el frame del personaje
        if (leanSide !== 0) {
          const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
          this.coverLeanAnim = (ux * leanSide) * rx + (uz * leanSide) * rz >= 0 ? 1 : -1;
        } else this.coverLeanAnim = 0;

        // soltarse empujando lejos del cover
        const away = hasInput ? (mw.x * n.x + mw.z * n.z) : 0;
        if (away > C.detachPush && !this.aim) {
          this.detachT += dt;
          if (this.detachT > C.detachTime) {
            this.cover = null;
            this._setState('run');
            this.chain = 0;
            this.ev.onDetach?.();
          }
        } else this.detachT = 0;

        // WALLBOUNCE desde cover: evadir hacia otra cobertura
        if (input.evadePressed) {
          const dir = hasInput ? { x: mw.x, z: mw.z } : { x: n.x, z: n.z };
          const into = -(dir.x * n.x + dir.z * n.z);
          if (into < 0.5) { // no re-entrar al mismo cover
            if (this.bounceWindow > 0 && this.chain < E.chainMax) {
              this.chain++;
              this.ev.onBounce?.(this.chain);
            } else this.chain = 0;
            this._tryEvade(dir, E.bounceRange);
          }
        }
        break;
      }
    }

    // integrar + colisión (cover se pega manualmente, pero el resolve no estorba)
    if (this.state !== 'cover') {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
    }
    this.world.resolveCircle(this.pos, PLAYER_R, this.y);

    // vertical: gravedad + suelo (permite pararse sobre coberturas)
    const airStates = this.state === 'idle' || this.state === 'run' ||
      this.state === 'roadie' || this.state === 'flip';
    if (airStates) {
      const J = TUNING.jump;
      this.vy -= J.gravity * dt;
      this.y += this.vy * dt;
      const ground = this.world.groundHeight(this.pos, PLAYER_R, this.y);
      if (this.y <= ground + 1e-3 && this.vy <= 0) {
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
    } else {
      this.vy = 0;
      this.grounded = true;
    }
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
    this.pos.x = target.x; this.pos.z = target.z;
    this.vel = { x: 0, z: 0 };
    this.cover = face;
    this.slide = null;
    this._setState('cover');
    this.bounceWindow = TUNING.evade.bounceWindow;
    this.detachT = 0;
    this.ev.onCoverEnter?.(this.chain);
  }
}
