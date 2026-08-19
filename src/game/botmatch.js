// Modo VS BOTS: TDM 4v4 por rondas en el mapa Arena.
// - Rondas de 5 min; gana la ronda quien agota las vidas del rival
//   (4 iniciales + 15 respawns = 19 por equipo). Match al mejor de 3.
// - IA con estados que usa las mecánicas del juego:
//     advance  → avanza por un carril táctico y ocupa posiciones útiles
//     engage   → strafea y dispara en ráfagas manteniendo rango de su arma
//     rush     → con escopeta en corto: cierra distancia con saltos de esquiva
//     hold     → conserva un ángulo/posición mientras aporta control de zona
//     cover    → herido: corre a una cobertura que bloquee la línea de visión,
//                se esconde a regenerar y se asoma a disparar por ciclos
//   Además: cambia de arma según la distancia, salta obstáculos bajos que le
//   estorban el camino y hace saltos de esquiva al recibir fuego.
// - Stats (kills/deaths, 100 pts por kill) para el scoreboard (Tab/VIEW).
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { Rig } from '../player/rig.js';
import { resolveShot, applySpread } from '../combat/ballistics.js';

const ROUND_TIME = 300;      // 5 minutos
const RESPAWN_POOL = 11;     // respawns por equipo (además de las 4 vidas
                             // iniciales = 15 vidas totales, pedido de Chuck)
const BOT_RESPAWN = 3;
const PLAYER_RESPAWN = () => TUNING.combat.respawnTime;
const BOT_NAMES = { red: ['REX', 'VOLT', 'JAZZ'], blue: ['NOVA', 'DUKE', 'BLITZ', 'PIXEL'] };
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };
const BOT_DMG = 0.7;         // los bots pegan más suave que un jugador
const TACTICAL_ROLES = ['advance', 'flank', 'hold', 'support', 'angle'];

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

const lerpYaw = (a, b, k) => {
  let d = b - a;
  d = d % (Math.PI * 2); // módulo, no while: un delta gigante colgaba el bucle
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

// Variación estable por bot/decisión. Evita que la personalidad táctica cambie
// cada frame y que la dispersión dependa de tirar una moneda continuamente.
const hash01 = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

class Bot {
  constructor(scene, world, id, name, team, spawn) {
    this.id = id; this.name = name; this.team = team;
    this.world = world;
    this.profile = {
      aggression: hash01(id + ':aggression'),
      patience: hash01(id + ':patience'),
      flank: hash01(id + ':flank'),
      cohesion: hash01(id + ':cohesion'),
    };
    this.rig = new Rig(scene, team, name, (Math.random() * 5) | 0); // soldado random
    this.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, 0.38, y);
    this.respawn(spawn);
  }

  respawn(spawn) {
    this.pos = { x: spawn.x, z: spawn.z };
    this.yaw = spawn.yaw;
    this.y = 0; this.vy = 0; this.grounded = true;
    this.hp = TUNING.combat.hp;
    this.alive = true;
    this.speed = 0;
    this.state = 'advance';
    this.wp = null; this.repathT = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = 0;
    this.burstT = 0; this.pauseT = 1 + Math.random();
    this.muzzleT = 0; // pose de fogonazo de la escopeta (separado de burstT)
    this.shotCd = 0;
    this.lastDamage = 99; this.recentHit = 99;
    this.wep = 'smg';
    this.swapCd = 0; this.swapAnim = 0;
    this.jumpCd = 0;
    this.cover = null;   // {x, z, tx, tz, low}
    this.coverPhase = 'hide'; this.coverT = 0; this.peekDir = 1;
    this.aggro = this.profile.aggression; // personalidad estable, no ruido por frame
    this.laneBias = this.laneBias ?? (this.profile.flank * 2 - 1);
    this.coverCd = 0;  // enfriamiento entre visitas a cobertura
    this.targetId = null; this.reactT = 0; // reacción al adquirir blanco
    this.role = this.role ?? 'advance';
    this.roleT = 0; this.decisionT = 0; this.decisionSerial = 0;
    this.tacticalGoal = null;
    this.flip = null;  // vuelta acrobática en el aire (solo estilo)
    this.stuckT = 0; this.avoidSide = 0;
    this._px = this.pos.x; this._pz = this.pos.z;
    this.protT = TUNING.combat.spawnProtection; // invulnerable al nacer
    this.rig.setWeapon('smg');
    this.rig.setVisible(true);
  }

  // Steering: si el frente está bloqueado (y no es saltable), desviarse hacia
  // el lado más libre. avoidSide es pegajoso para no oscilar contra la pared.
  _steer(dx, dz) {
    _v1.set(this.pos.x, 0.7, this.pos.z);
    _v2.set(dx, 0, dz);
    if (this.world.raycast(_v1, _v2, 1.3) === null) { this.avoidSide = 0; return { x: dx, z: dz }; }
    // si lo alto está libre es un obstáculo saltable: _jumpIfBlocked se encarga
    _v1.y = 1.6;
    if (this.world.raycast(_v1, _v2, 1.6) === null) return { x: dx, z: dz };
    _v1.y = 0.7;
    if (!this.avoidSide) this.avoidSide = Math.random() < 0.5 ? 1 : -1;
    for (const ang of [0.85 * this.avoidSide, -0.85 * this.avoidSide,
                       1.6 * this.avoidSide, -1.6 * this.avoidSide]) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const nx = dx * c - dz * s, nz = dx * s + dz * c;
      _v2.set(nx, 0, nz);
      if (this.world.raycast(_v1, _v2, 1.3) === null) return { x: nx, z: nz };
    }
    return { x: -dx, z: -dz }; // encajonado: salir hacia atrás
  }

  _face(tx, tz, dt, rate = 8) {
    this.yaw = lerpYaw(this.yaw, Math.atan2(-tx, -tz), 1 - Math.exp(-rate * dt));
  }

  _trySwap(want) {
    if (this.wep === want || this.swapCd > 0) return;
    this.wep = want;
    this.swapCd = 2.5;
    this.swapAnim = 0.5;
    this.rig.setWeapon(want);
  }

  _jump(acrobatic = false) {
    if (!this.grounded || this.jumpCd > 0) return;
    this.vy = 6.2; // mismo apex que el jugador: pasa bloques LOW (1.1)
    this.grounded = false;
    this.jumpCd = 1.2;
    // de vez en cuando, vuelta en el aire (misma física, solo animación)
    if (acrobatic && Math.random() < 0.4) {
      this.flip = {
        t: 0,
        axis: Math.random() < 0.65 ? 'z' : 'x', // lateral Matrix o voltereta
        dir: Math.random() < 0.5 ? 1 : -1,
      };
    }
  }

  // ¿hay un obstáculo BAJO justo en el camino? → saltarlo
  _jumpIfBlocked(mx, mz) {
    if (!this.grounded || this.jumpCd > 0) return;
    _v1.set(this.pos.x, 0.5, this.pos.z);
    _v2.set(mx, 0, mz).normalize();
    const tLow = this.world.raycast(_v1, _v2, 1.3);
    if (tLow === null) return;
    _v1.y = 1.6;
    const tHigh = this.world.raycast(_v1, _v2, 2.2);
    if (tHigh === null) this._jump(); // bajo bloqueado, alto libre → brincable
  }

  update(dt, match) {
    if (!this.alive) {
      this.rig.update(dt, { state: 'dead', speed: 0, aim: false, aimPitch: 0 });
      return;
    }
    this.lastDamage += dt; this.recentHit += dt;
    this.protT = Math.max(0, this.protT - dt);
    this.swapCd = Math.max(0, this.swapCd - dt);
    this.swapAnim = Math.max(0, this.swapAnim - dt);
    this.jumpCd = Math.max(0, this.jumpCd - dt);
    this.coverCd = Math.max(0, this.coverCd - dt);
    this.roleT = Math.max(0, this.roleT - dt);
    this.decisionT = Math.max(0, this.decisionT - dt);
    this.shotCd = Math.max(-0.5, this.shotCd - dt);
    // ráfaga/pausa SIEMPRE decrementan: si el bot pierde al enemigo a mitad
    // de ráfaga, la pose de disparo no debe quedarse congelada
    this.burstT = Math.max(0, this.burstT - dt);
    this.muzzleT = Math.max(0, this.muzzleT - dt);
    if (this.burstT === 0 && this.pauseT > 0) this.pauseT -= dt;
    if (this.lastDamage > TUNING.combat.regenDelay && this.hp < TUNING.combat.hp) {
      this.hp = Math.min(TUNING.combat.hp, this.hp + TUNING.combat.regenRate * dt);
    }

    const enemy = match.nearestVisibleEnemy(this);
    // epsilon: dos entidades solapadas producían NaN en yaw/pos (bot invisible)
    const dist = enemy
      ? Math.max(0.05, Math.hypot(enemy.x - this.pos.x, enemy.z - this.pos.z))
      : Infinity;

    // reacción humana: adquirir un blanco NUEVO cuesta 150-350ms antes del
    // primer tiro (antes giraba y disparaba en el mismo frame)
    const eid = enemy ? enemy.id : null;
    if (eid !== this.targetId) {
      this.targetId = eid;
      if (eid) this.reactT = 0.15 + Math.random() * 0.2;
    }
    this.reactT = Math.max(0, (this.reactT ?? 0) - dt);

    // ---- decidir estado ----
    // La retirada ahora considera fuego reciente y balance local, no solo una
    // cifra extrema de vida. Así un bot aislado puede romper contacto antes de
    // morir, mientras uno apoyado conserva la presión.
    const pressure = enemy ? match.localPressure(this, 11) : 0;
    const wantsSafety = this.hp < 24 ||
      (this.hp < 48 && (this.recentHit < 2.2 || pressure > 0));
    const spot = this.state !== 'cover' && this.coverCd <= 0 && wantsSafety && enemy
      ? match.findCoverSpot(this, enemy, { retreat: true }) : null;
    if (spot) {
      this.cover = spot; this.state = 'cover';
      this.coverPhase = 'go'; this.coverT = 0; this.coverPhaseT = 0;
      match.releaseTacticalClaim(this.id);
      match.coverClaims.set(this.id, spot); // reservar: nadie más a este spot
    } else if (this.state === 'cover') {
      this.coverT += dt;
      this.coverPhaseT = (this.coverPhaseT ?? 0) + dt;
      // salir con la vida CASI llena (o por tiempo): con el umbral en 62 y
      // regen de 48/s, la ventana entre asomarse (55) y salir era de 0.15s
      // — el ciclo hide→peek→hide nunca ocurría de verdad
      if (this.hp > 90 || this.coverT > 6.5) {
        this.state = 'advance'; this.cover = null;
        this.coverCd = 6 + Math.random() * 5;
        match.coverClaims.delete(this.id);
        this.decisionT = 0;
      }
    } else {
      const reached = this.tacticalGoal &&
        Math.hypot(this.tacticalGoal.x - this.pos.x, this.tacticalGoal.z - this.pos.z) < 1.15;
      const defending = this.role === 'hold' && reached && this.roleT > 0;
      if (this.roleT <= 0 || !this.tacticalGoal || (!defending && (this.decisionT <= 0 || reached))) {
        match.refreshTacticalPlan(this, enemy);
      }

      const reposition = !!this.tacticalGoal && this.commitMove &&
        (!enemy || dist > 5.5) && !reached;
      if (enemy && !reposition) {
      // arma según distancia; los agresivos con vida llena se comprometen al rush
        if (dist < 8 || (this.aggro > 0.55 && dist < 14 && this.hp > 60)) this._trySwap('shotgun');
        else if (dist > 15) this._trySwap('smg');
        this.state = this.wep === 'shotgun' && dist > 4.5 ? 'rush' :
          this.role === 'hold' && reached ? 'hold' : 'engage';
      } else if (this.role === 'hold' && reached) {
        this.state = 'hold';
      } else {
        this.state = 'advance';
      }
    }

    // salto de esquiva bajo fuego reciente (a veces con vuelta en el aire)
    if (this.recentHit < 0.6 && this.state !== 'cover' && Math.random() < 1.2 * dt) this._jump(true);

    // ---- comportamiento por estado ----
    let mx = 0, mz = 0, aiming = false, animOverride = null;

    if (this.state === 'engage' && enemy) {
      aiming = true;
      const ex = (enemy.x - this.pos.x) / dist, ez = (enemy.z - this.pos.z) / dist;
      this._face(ex, ez, dt);
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeDir *= -1; this.strafeT = 0.8 + Math.random() * 1.4; }
      const ideal = this.wep === 'smg' ? 12 : 6;
      const push = dist > ideal + 3 ? 0.7 : dist < ideal - 3 ? -0.7 : 0;
      mx = -ez * this.strafeDir * 0.75 + ex * push;
      mz = ex * this.strafeDir * 0.75 + ez * push;
      this._fireAt(dt, match, enemy, dist);
    } else if (this.state === 'rush' && enemy) {
      aiming = dist < 12;
      const ex = (enemy.x - this.pos.x) / dist, ez = (enemy.z - this.pos.z) / dist;
      this._face(ex, ez, dt, 10);
      // cerrar distancia con jitter lateral y saltos ocasionales
      mx = ex + -ez * this.strafeDir * 0.35;
      mz = ez + ex * this.strafeDir * 0.35;
      if (Math.random() < 0.5 * dt) this._jump(true);
      if (dist < 9) this._fireAt(dt, match, enemy, dist);
    } else if (this.state === 'hold') {
      // Una defensa es temporal: vigila el frente y pelea desde el ángulo que
      // eligió, pero el temporizador de rol terminará forzando otra decisión.
      if (enemy) {
        aiming = true;
        this._face(enemy.x - this.pos.x, enemy.z - this.pos.z, dt, 7);
        this._fireAt(dt, match, enemy, dist);
      } else {
        this._face(0, this.team === 'red' ? 1 : -1, dt, 3);
      }
    } else if (this.state === 'cover' && this.cover) {
      const c = this.cover;
      if (this.coverPhase === 'go') {
        const dx = c.x - this.pos.x, dz = c.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) { this.coverPhase = 'hide'; this.coverPhaseT = 0; }
        else { mx = dx / d; mz = dz / d; this._face(mx, mz, dt); }
      } else if (this.coverPhase === 'hide') {
        // agazapado tras el bloque, regenerando
        animOverride = c.low ? 'cover_low' : 'cover_high';
        if (enemy) this._face((enemy.x - this.pos.x), (enemy.z - this.pos.z), dt, 5);
        // asomarse aunque el regen no haya llegado (35): así el ciclo
        // hide→peek→hide ocurre 2-3 veces por visita a cobertura
        if (this.coverPhaseT > 1.0 + Math.random() * 0.7 && this.hp > 35) {
          this.coverPhase = 'peek'; this.coverPhaseT = 0;
          this.peekDir = Math.random() < 0.5 ? -1 : 1;
        }
      } else { // peek: asomarse por el costado y tirar
        const px = c.x + c.tx * this.peekDir * 1.4;
        const pz = c.z + c.tz * this.peekDir * 1.4;
        const dx = px - this.pos.x, dz = pz - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.3) { mx = dx / d; mz = dz / d; }
        if (enemy) {
          aiming = true;
          this._face((enemy.x - this.pos.x), (enemy.z - this.pos.z), dt, 10);
          this._fireAt(dt, match, enemy, dist);
        }
        if (this.coverPhaseT > 1.1) { this.coverPhase = 'hide'; this.coverPhaseT = 0; }
      }
    } else {
      // advance: waypoint elegido por rol, ocupación y valor táctico
      this.repathT -= dt;
      if (!this.wp || this.repathT <= 0 ||
          Math.hypot(this.wp.x - this.pos.x, this.wp.z - this.pos.z) < 1) {
        match.refreshTacticalPlan(this, enemy);
        this.wp = this.tacticalGoal;
        this.repathT = 2.4 + this.profile.patience * 2.2;
      }
      const dx = this.wp.x - this.pos.x, dz = this.wp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.5) {
        mx = dx / d; mz = dz / d;
        this._face(mx, mz, dt, 6);
      }
    }

    // ---- mover (con steering) + salto de obstáculos + física vertical ----
    const spd = this.state === 'rush' ? 5.2 : this.state === 'engage' ? 3.2 : 4.2;
    // separación de compañeros: repulsión suave bajo 3.4m — sin esto
    // atacaban en racimo, prácticamente agarrados de la mano
    let sepX = 0, sepZ = 0;
    for (const o of match.bots) {
      if (o === this || !o.alive || o.team !== this.team) continue;
      const ddx = this.pos.x - o.pos.x, ddz = this.pos.z - o.pos.z;
      const dd = Math.hypot(ddx, ddz);
      if (dd < 3.4 && dd > 0.01) {
        const w = (3.4 - dd) / 3.4;
        sepX += (ddx / dd) * w; sepZ += (ddz / dd) * w;
      }
    }
    mx += sepX * 0.9; mz += sepZ * 0.9;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 0.05) {
      const d = this._steer(mx / mlen, mz / mlen);
      this._jumpIfBlocked(d.x, d.z);
      this.pos.x += d.x * spd * dt;
      this.pos.z += d.z * spd * dt;
      this.speed = spd;
    } else this.speed = 0;
    this.world.resolveCircle(this.pos, 0.38, this.y);

    // detector de atasco: si no avanza lo esperado, replantear el plan
    if (mlen > 0.05 && this.grounded) {
      const moved = Math.hypot(this.pos.x - this._px, this.pos.z - this._pz);
      if (moved < spd * dt * 0.3) this.stuckT += dt;
      else this.stuckT = Math.max(0, this.stuckT - dt * 2);
      if (this.stuckT > 0.9) {
        this.stuckT = 0;
        this.wp = null; this.repathT = 0;
        this.avoidSide = -(this.avoidSide || 1);
        this.strafeDir *= -1;
        if (this.state === 'cover') {
          this.state = 'advance'; this.cover = null;
          match.coverClaims.delete(this.id);
          this.decisionT = 0;
        }
        if (Math.random() < 0.5) this._jump();
      }
    } else this.stuckT = 0;
    this._px = this.pos.x; this._pz = this.pos.z;
    this.vy -= 15 * dt;
    this.y += this.vy * dt;
    const ground = this.world.groundHeight(this.pos, 0.38, this.y);
    if (this.y <= ground && this.vy <= 0) { this.y = ground; this.vy = 0; this.grounded = true; }
    else this.grounded = this.y <= ground + 0.02;

    // vuelta acrobática: progresa en el aire, se limpia al aterrizar
    if (this.flip) {
      this.flip.t = Math.min(1, this.flip.t + dt / 0.72);
      if (this.grounded) this.flip = null;
    }

    // pasos posicionales del bot: por distancia recorrida real + aterrizaje
    const stepped = Math.hypot(this.pos.x - (this._fx ?? this.pos.x), this.pos.z - (this._fz ?? this.pos.z));
    this._fx = this.pos.x; this._fz = this.pos.z;
    if (this.grounded && this.speed > 1) {
      this._facc = (this._facc ?? 0) + stepped;
      if (this._facc > (this.speed > 4.6 ? 1.9 : 1.6)) {
        this._facc = 0;
        match.cb.stepSound?.(this.pos.x, this.pos.z, this.speed > 4.6 ? 'run' : 'walk');
      }
    } else {
      this._facc = 0;
    }
    if (this._wasAir && this.grounded) match.cb.stepSound?.(this.pos.x, this.pos.z, 'land');
    this._wasAir = !this.grounded;

    let anim = animOverride;
    if (!anim) anim = !this.grounded ? (this.flip ? 'flip' : 'jump') : this.speed > 0.4 ? 'run' : 'idle';
    this.rig.setTransform(this.pos.x, this.pos.z, this.yaw, this.y);
    this.rig.update(dt, {
      state: anim,
      speed: Math.min(1, this.speed / TUNING.move.roadieSpeed),
      aim: aiming && !animOverride && anim !== 'flip',
      aimPitch: 0,
      firing: this.burstT > 0 || this.muzzleT > 0,
      swapping: this.swapAnim > 0,
      flipT: this.flip ? this.flip.t : 0,
      flipDir: this.flip?.dir ?? 1,
      flipAxis: this.flip?.axis ?? 'z',
    });
    // protección de spawn: highlight sutil del color del equipo
    this.rig.setProtected(this.protT > 0);
  }

  // ráfagas (metralleta) o bombazos sueltos (escopeta)
  // ráfagas (metralleta) o bombazos sueltos (escopeta). Los timers burstT y
  // pauseT decrementan GLOBALMENTE en update(); aquí solo se dispara/arma.
  _fireAt(dt, match, enemy, dist) {
    // sin reaccionar aún, o con el cuerpo todavía girando (>26° de error),
    // no se dispara — antes la bala salía perfecta aunque el modelo apenas
    // empezara a voltear hacia el blanco
    if (this.reactT > 0) return;
    let da = (Math.atan2(-(enemy.x - this.pos.x), -(enemy.z - this.pos.z)) - this.yaw) % (Math.PI * 2);
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > 0.45) return;
    if (this.wep === 'shotgun') {
      if (this.shotCd <= 0 && dist < 20) {
        this.shotCd = (60 / TUNING.weapons.shotgun.rpm) * 1.5;
        // muzzleT, NO burstT: usar burstT congelaba pauseT y contaminaba el
        // ritmo de ráfagas al volver a la metralleta
        this.muzzleT = 0.15;
        match.botShoot(this, enemy);
      }
      return;
    }
    if (this.burstT > 0) {
      if (this.shotCd <= 0) {
        this.shotCd = (60 / TUNING.weapons.smg.rpm) * 1.6;
        match.botShoot(this, enemy);
      }
    } else if (this.pauseT <= 0) {
      this.burstT = 0.4 + Math.random() * 0.5;
      this.pauseT = 0.5 + Math.random() * 0.9;
      // primer tiro de la ráfaga en el MISMO frame que se arma
      if (this.shotCd <= 0) {
        this.shotCd = (60 / TUNING.weapons.smg.rpm) * 1.6;
        match.botShoot(this, enemy);
      }
    }
  }

  dispose(scene) { this.rig.dispose(scene); }
}

export class BotMatch {
  // cb: { effects, audio, hud, playerName,
  //   player(): {x,z,y,alive}, damagePlayer(dmg, fromName) -> murió?,
  //   respawnPlayer(spawn), onMatchEnd(winnerTeam) }
  constructor(scene, world, cb) {
    this.scene = scene;
    this.world = world;
    this.cb = cb;
    this.bots = [];
    this.stats = new Map();
    this.wins = { red: 0, blue: 0 };
    this.round = 0;
    this.timer = ROUND_TIME;
    this.phase = 'starting';
    this.phaseT = 0;
    this.pool = { red: RESPAWN_POOL, blue: RESPAWN_POOL };
    this.respawnQueue = [];
    this.coverClaims = new Map(); // botId -> spot reservado (sin duplicar cover)
    // calor de enemigos AVISTADOS por tercio del mapa (x), por equipo: la
    // base contextual para flanquear por el lado frío y no amontonarse
    this.enemyHeat = { red: [0, 0, 0], blue: [0, 0, 0] };
    this.tacticalClaims = new Map(); // destinos/ángulos reservados por bot

    this.stats.set('player', { name: cb.playerName, team: 'red', kills: 0, deaths: 0 });
    let n = 0;
    for (const team of ['red', 'blue']) {
      for (const name of BOT_NAMES[team]) {
        const id = 'bot' + n++;
        // +1: el spawn [0] del lado rojo es del JUGADOR (evitar solaparse)
        const spawn = world.spawns[team][(this.bots.length + 1) % 4];
        this.bots.push(new Bot(scene, world, id, name, team, spawn));
        this.stats.set(id, { name, team, kills: 0, deaths: 0 });
      }
    }
    this._startRound();
  }

  _startRound() {
    this.round++;
    this.timer = ROUND_TIME;
    this.pool = { red: RESPAWN_POOL, blue: RESPAWN_POOL };
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
    this.phase = 'playing';
    let i = { red: 0, blue: 0 };
    for (const b of this.bots) {
      b.respawn(this.world.spawns[b.team][++i[b.team] % 4]);
    }
    this._assignOpeningPlans();
    this.cb.respawnPlayer(this.world.spawns.red[0]);
    this.cb.hud.center('ROUND ' + this.round,
      'primero en agotar las ' + (RESPAWN_POOL + 4) + ' vidas rivales', 3000);
  }

  livesOf(team) {
    let alive = 0;
    if (team === 'red' && this.cb.player().alive) alive++;
    for (const b of this.bots) if (b.team === team && b.alive) alive++;
    return alive + this.pool[team];
  }

  // agachado real: escondido tras cover BAJO → hitbox reducida en ballistics
  _crouched(b) {
    return b.state === 'cover' && b.coverPhase === 'hide' && !!b.cover?.low;
  }

  targets() { // enemigos del JUGADOR (azules vivos)
    return this.bots
      .filter((b) => b.team === 'blue' && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true, crouch: this._crouched(b) }));
  }

  _enemiesOf(bot) {
    const out = this.bots
      .filter((b) => b.team !== bot.team && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true, crouch: this._crouched(b) }));
    if (bot.team === 'blue') {
      const p = this.cb.player();
      if (p.alive) out.push({ id: 'player', x: p.x, z: p.z, y: p.y, alive: true, crouch: !!p.crouch });
    }
    return out;
  }

  _alliesOf(bot) {
    const out = this.bots.filter((b) => b !== bot && b.team === bot.team && b.alive);
    if (bot.team === 'red') {
      const p = this.cb.player();
      if (p.alive) out.push({ id: 'player', pos: { x: p.x, z: p.z }, hp: 100, state: 'player' });
    }
    return out;
  }

  _assignOpeningPlans() {
    const roles = ['flank', 'advance', 'angle', 'hold'];
    for (const team of ['red', 'blue']) {
      const squad = this.bots.filter((b) => b.team === team);
      squad.forEach((b, i) => {
        b.laneBias = squad.length === 1 ? 0 : -0.8 + (1.6 * i) / (squad.length - 1);
        // Invertir el orden azul evita duelos espejo perfectos desde el spawn.
        if (team === 'blue') b.laneBias *= -1;
        b.role = roles[i % roles.length];
        b.roleT = 6 + b.profile.patience * 3;
        b.decisionT = 0;
        b.tacticalGoal = null;
      });
    }
  }

  _assignRespawnPlan(bot) {
    const lanes = [-0.78, 0, 0.78];
    const allies = this._alliesOf(bot).filter((a) => a.pos);
    const load = lanes.map((lane) => allies.reduce((n, a) =>
      n + (Math.abs(a.pos.x / this.world.fx - lane) < 0.36 ? 1 : 0), 0));
    const least = Math.min(...load);
    const choices = lanes.filter((_, i) => load[i] === least);
    bot.laneBias = choices[Math.floor(bot.profile.flank * choices.length)] ?? 0;
    const role = TACTICAL_ROLES
      .map((r) => ({ r, n: this._roleLoad(bot, r) }))
      .sort((a, b) => a.n - b.n ||
        hash01(bot.id + ':' + a.r) - hash01(bot.id + ':' + b.r))[0]?.r;
    bot.role = role || 'advance';
    bot.roleT = 5;
    bot.decisionT = 0;
  }

  _roleLoad(bot, role) {
    return this.bots.reduce((n, b) =>
      n + (b !== bot && b.alive && b.team === bot.team && b.role === role ? 1 : 0), 0);
  }

  localPressure(bot, radius) {
    const enemies = this._enemiesOf(bot).filter((e) =>
      Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z) < radius).length;
    const allies = this._alliesOf(bot).filter((a) => a.pos &&
      Math.hypot(a.pos.x - bot.pos.x, a.pos.z - bot.pos.z) < radius).length;
    return enemies - allies;
  }

  nearestEnemy(bot) {
    let best = null, bestD = Infinity;
    for (const e of this._enemiesOf(bot)) {
      const d = Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z);
      if (d < bestD) { best = e; bestD = d; }
    }
    return best;
  }

  releaseTacticalClaim(id) {
    this.tacticalClaims.delete(id);
  }

  _leastControlledLane(bot) {
    const lanes = [-0.78, 0, 0.78];
    const allies = this._alliesOf(bot).filter((a) => a.pos);
    const load = lanes.map((lane) => allies.reduce((n, a) =>
      n + Math.max(0, 1 - Math.abs(a.pos.x / this.world.fx - lane) / 0.42), 0));
    // calor de enemigos AVISTADOS por tercio: flanquear por donde el enemigo
    // NO está operando, no solo por donde faltan compañeros
    const heat = this.enemyHeat[bot.team];
    const heatTotal = heat[0] + heat[1] + heat[2];
    if (heatTotal > 1) {
      for (let i = 0; i < 3; i++) load[i] += (heat[i] / heatTotal) * 1.1;
    }
    const least = Math.min(...load);
    const choices = lanes.filter((_, i) => load[i] < least + 0.12);
    return choices[Math.floor(hash01(bot.id + ':lane:' + bot.decisionSerial) * choices.length)] ?? 0;
  }

  refreshTacticalPlan(bot, visibleEnemy) {
    const threat = visibleEnemy || this.nearestEnemy(bot);
    bot.decisionSerial++;

    if (bot.roleT <= 0) {
      const toward = bot.team === 'red' ? 1 : -1;
      const depth = bot.pos.z * toward / this.world.fz;
      const allies = this._alliesOf(bot).filter((a) => a.pos);
      const allyNeedsHelp = allies.some((a) =>
        a.hp < 58 || (a.recentHit ?? 99) < 2.5 || a.state === 'cover');
      const enemyCentral = threat ? Math.abs(threat.x) < this.world.fx * 0.38 : false;
      const scores = {
        advance: 1.2 + bot.profile.aggression * 1.15,
        flank: 0.75 + bot.profile.flank * 1.75 + (enemyCentral ? 0.65 : 0),
        hold: 0.55 + bot.profile.patience * 1.55 + (depth > -0.15 ? 0.55 : -0.55) +
          (bot.hp < 68 ? 0.45 : 0),
        support: 0.55 + bot.profile.cohesion * 1.4 + (allyNeedsHelp ? 1.15 : 0),
        angle: 0.8 + (visibleEnemy ? 1.05 : 0) + (1 - bot.profile.cohesion) * 0.55,
      };
      for (const role of TACTICAL_ROLES) {
        scores[role] -= this._roleLoad(bot, role) * 1.15;
        scores[role] += hash01(bot.id + ':' + bot.decisionSerial + ':' + role) * 0.28;
      }
      if (this.localPressure(bot, 11) > 0) {
        scores.hold += 0.7; scores.support += 0.55; scores.flank -= 0.35;
      }
      bot.role = TACTICAL_ROLES.reduce((best, role) =>
        scores[role] > scores[best] ? role : best, 'advance');
      bot.roleT = 7 + bot.profile.patience * 5;
      if (bot.role === 'flank' || bot.role === 'angle') {
        bot.laneBias = this._leastControlledLane(bot);
      }
    }

    this.releaseTacticalClaim(bot.id);
    const goal = this.tacticalWaypoint(bot, bot.role, threat);
    bot.tacticalGoal = goal;
    bot.wp = goal;
    if (goal) this.tacticalClaims.set(bot.id, goal);
    const enemyDist = visibleEnemy
      ? Math.hypot(visibleEnemy.x - bot.pos.x, visibleEnemy.z - bot.pos.z) : Infinity;
    bot.commitMove = !visibleEnemy || bot.role === 'flank' || bot.role === 'angle' ||
      bot.role === 'support' || bot.role === 'hold';
    if (bot.role === 'advance' && enemyDist < 16) bot.commitMove = false;
    if (bot.recentHit < 0.75 || this.localPressure(bot, 9) > 1) bot.commitMove = false;
    bot.decisionT = 1.8 + hash01(bot.id + ':decision:' + bot.decisionSerial) * 1.7;
  }

  _supportTarget(bot) {
    const allies = this.bots.filter((b) =>
      b !== bot && b.alive && b.team === bot.team);
    if (!allies.length) return null;
    return allies.sort((a, b) => {
      const needA = (100 - a.hp) + ((a.recentHit ?? 99) < 3 ? 35 : 0) -
        Math.hypot(a.pos.x - bot.pos.x, a.pos.z - bot.pos.z) * 0.5;
      const needB = (100 - b.hp) + ((b.recentHit ?? 99) < 3 ? 35 : 0) -
        Math.hypot(b.pos.x - bot.pos.x, b.pos.z - bot.pos.z) * 0.5;
      return needB - needA;
    })[0];
  }

  tacticalWaypoint(bot, role = 'advance', threat = null) {
    const toward = bot.team === 'red' ? 1 : -1;
    const clampX = (x) => Math.max(-this.world.fx + 2, Math.min(this.world.fx - 2, x));
    const clampZ = (z) => Math.max(-this.world.fz + 2, Math.min(this.world.fz - 2, z));
    let lane = bot.laneBias ?? 0;
    if (role === 'flank' && Math.abs(lane) < 0.45) lane = this._leastControlledLane(bot) ||
      (bot.profile.flank < 0.5 ? -0.78 : 0.78);

    let targetX = lane * this.world.fx * (role === 'flank' ? 0.9 : 0.62);
    let targetZ = bot.pos.z + toward * (role === 'hold' ? 3.5 : role === 'flank' ? 14 : 10);
    if (role === 'angle' && threat) {
      const side = lane || (bot.profile.flank < 0.5 ? -1 : 1);
      targetX = threat.x + Math.sign(side) * (6 + bot.profile.flank * 4);
      targetZ = threat.z - toward * 4.5;
    } else if (role === 'support') {
      const ally = this._supportTarget(bot);
      if (ally) {
        const side = lane || (bot.profile.flank < 0.5 ? -1 : 1);
        targetX = ally.pos.x + Math.sign(side) * 4.2;
        targetZ = ally.pos.z - toward * 3.2;
      }
    } else if (role === 'hold') {
      targetX = bot.pos.x * 0.65 + targetX * 0.35;
      targetZ = bot.pos.z + toward * (2.5 + bot.profile.patience * 3);
    } else if (threat) {
      const desired = threat.z - toward * (role === 'flank' ? 5 : 8);
      targetZ = bot.pos.z + Math.max(-14, Math.min(14, desired - bot.pos.z));
    }
    targetX = clampX(targetX); targetZ = clampZ(targetZ);

    let best = null, bestScore = -Infinity;
    for (let i = 0; i < this.world.faces.length; i++) {
      const f = this.world.faces[i];
      if (f.h > 2.6) continue;
      const x = (f.a.x + f.b.x) / 2 + f.n.x * 0.78;
      const z = (f.a.z + f.b.z) / 2 + f.n.z * 0.78;
      if (Math.abs(x) > this.world.fx - 1 || Math.abs(z) > this.world.fz - 1) continue;
      const d = Math.hypot(x - bot.pos.x, z - bot.pos.z);
      if (d < 2 || d > (role === 'flank' ? 22 : 18)) continue;
      const progress = (z - bot.pos.z) * toward;
      if (progress < (role === 'hold' ? -5 : -8)) continue;

      let claimed = false, claimPenalty = 0;
      for (const [id, c] of this.tacticalClaims) {
        if (id === bot.id) continue;
        const cd = Math.hypot(c.x - x, c.z - z);
        if (cd < 2.4) { claimed = true; break; }
        if (cd < 7) claimPenalty += (7 - cd) * 0.7;
      }
      if (claimed) continue;

      let crowd = 0;
      for (const a of this._alliesOf(bot)) {
        if (!a.pos) continue;
        const ad = Math.hypot(a.pos.x - x, a.pos.z - z);
        if (ad < 5.5) crowd += (5.5 - ad) * 0.85;
      }
      const targetFit = Math.hypot(x - targetX, z - targetZ);
      let score = -targetFit * 0.42 - Math.abs(d - (role === 'hold' ? 6 : 11)) * 0.12;
      score += Math.max(-2, Math.min(2.2, progress * 0.12));
      score -= crowd + claimPenalty;

      if (threat) {
        const shielded = (threat.x - x) * f.n.x + (threat.z - z) * f.n.z < -0.2;
        if (shielded) score += role === 'hold' || role === 'support' ? 2.3 : 1.15;
        else if (role === 'hold') score -= 1.3;
      }
      // Un muro alto bloqueando la ruta directa no invalida el destino (steering
      // puede rodearlo), pero hace preferible un paso más legible.
      _v1.set(bot.pos.x, 1.45, bot.pos.z);
      _v2.set(x - bot.pos.x, 0, z - bot.pos.z);
      const pathLen = _v2.length();
      if (pathLen > 0.1) {
        _v2.normalize();
        if (this.world.raycast(_v1, _v2, Math.min(pathLen, 5.5)) !== null) score -= 1.4;
      }
      score += hash01(bot.id + ':' + bot.decisionSerial + ':face:' + i) * 0.18;
      if (score > bestScore) { bestScore = score; best = { x, z, role }; }
    }

    return best || { x: targetX, z: targetZ, role };
  }

  // Todos los enemigos con LOS a <30m, ordenados por distancia. Alimenta el
  // calor por zona del equipo (contexto para flanqueos y dispersión).
  visibleEnemies(bot) {
    const out = [];
    for (const e of this._enemiesOf(bot)) {
      const d = Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z);
      if (d >= 30) continue;
      // ojo del BLANCO según postura: un agachado tras cover bajo no debe
      // ser visto "a través" del bloque a altura de pie
      const eyeT = e.crouch ? 0.9 : 1.3;
      _v1.set(bot.pos.x, bot.y + 1.3, bot.pos.z);
      _v2.set(e.x - bot.pos.x, (e.y + eyeT) - (bot.y + 1.3), e.z - bot.pos.z);
      const len = _v2.length();
      _v2.normalize();
      if (this.world.raycast(_v1, _v2, len - 0.5) !== null) continue; // sin LOS
      out.push({ ...e, d });
      this.enemyHeat[bot.team][this._third(e.x)] += 0.25;
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  nearestVisibleEnemy(bot) { return this.visibleEnemies(bot)[0] ?? null; }

  _third(x) { return x < -this.world.fx / 3 ? 0 : x > this.world.fx / 3 ? 2 : 1; }

  // Cobertura que BLOQUEA la línea de visión del enemigo. No elige simplemente
  // la más cercana: pondera retirada, ruta, espacio personal y reservas.
  findCoverSpot(bot, threat, { retreat = false } = {}) {
    let best = null, bestScore = -Infinity;
    const currentThreatD = Math.hypot(threat.x - bot.pos.x, threat.z - bot.pos.z);
    for (let fi = 0; fi < this.world.faces.length; fi++) {
      const f = this.world.faces[fi];
      if (f.h > 2.6) continue; // muros perimetrales no
      const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
      // la cara debe darle la ESPALDA al enemigo: sin este check el bot se
      // "cubría" parado del lado del enemigo, de frente a él contra la pared
      if ((threat.x - mx) * f.n.x + (threat.z - mz) * f.n.z > -0.2) continue;
      const sx = mx + f.n.x * 0.7, sz = mz + f.n.z * 0.7;
      const d = Math.hypot(sx - bot.pos.x, sz - bot.pos.z);
      if (d > 16 || d < 1.2) continue;
      if (Math.hypot(threat.x - sx, threat.z - sz) < 5) continue; // no en la cara del enemigo
      // spot ya reservado por un compañero → buscar otro
      let taken = false;
      for (const [cid, c] of this.coverClaims) {
        if (cid !== bot.id && Math.hypot(c.x - sx, c.z - sz) < 1.6) { taken = true; break; }
      }
      if (taken) continue;
      for (const [cid, c] of this.tacticalClaims) {
        if (cid !== bot.id && Math.hypot(c.x - sx, c.z - sz) < 2.2) { taken = true; break; }
      }
      if (taken) continue;
      // vista bloqueada desde la POSTURA real: agachado (0.8) tras bloques
      // LOW — con ojo fijo a 1.2 un bloque de 1.1 jamás calificaba
      const eye = f.h <= TUNING.cover.lowHeight ? 0.8 : 1.2;
      _v1.set(sx, eye, sz);
      _v2.set(threat.x - sx, 0.1, threat.z - sz);
      const len = _v2.length();
      _v2.normalize();
      if (this.world.raycast(_v1, _v2, Math.min(len, 25)) === null) continue; // vista libre = mal

      let crowd = 0;
      for (const a of this._alliesOf(bot)) {
        if (!a.pos) continue;
        const ad = Math.hypot(a.pos.x - sx, a.pos.z - sz);
        if (ad < 5) crowd += (5 - ad) * 0.8;
      }
      const newThreatD = Math.hypot(threat.x - sx, threat.z - sz);
      let score = -d * 0.34 - crowd + (newThreatD - currentThreatD) * (retreat ? 0.18 : 0.06);
      const faceLen = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      score += Math.min(1.2, faceLen * 0.12);
      _v1.set(bot.pos.x, 1.45, bot.pos.z);
      _v2.set(sx - bot.pos.x, 0, sz - bot.pos.z);
      const pathLen = _v2.length();
      if (pathLen > 1.5) {
        _v2.normalize();
        if (this.world.raycast(_v1, _v2, pathLen - 1.1) !== null) score -= 1.1;
      }
      score += hash01(bot.id + ':cover:' + bot.decisionSerial + ':' + fi) * 0.16;
      if (score <= bestScore) continue;
      const tlen = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      best = {
        x: sx, z: sz,
        tx: (f.b.x - f.a.x) / tlen, tz: (f.b.z - f.a.z) / tlen,
        low: f.h <= TUNING.cover.lowHeight,
      };
      bestScore = score;
    }
    return best;
  }

  botShoot(bot, enemy) {
    bot.protT = 0; // disparar rompe la protección de spawn
    const def = TUNING.weapons[bot.wep];
    _v1.set(bot.pos.x, bot.y + 1.35, bot.pos.z);
    _v3.set(enemy.x, (enemy.y ?? 0) + 1.0 + Math.random() * 0.4, enemy.z).sub(_v1).normalize();
    const err = bot.wep === 'shotgun' ? 3 : 4.5;
    const baseDir = applySpread(_v3, err);
    const targets = this._enemiesOf(bot);
    const pellets = def.pellets || 1;
    const dmgAcc = new Map();
    for (let i = 0; i < pellets; i++) {
      const dir = pellets > 1 ? applySpread(baseDir, def.spreadHip) : baseDir;
      const hit = resolveShot(this.world, targets, _v1, dir, def.range, bot.id);
      if (i === 0) this.cb.effects.tracer(_v1, hit.point);
      if (hit.kind === 'player') {
        let dmg = def.dmg * BOT_DMG;
        if (def.falloffStart && hit.t > def.falloffStart) {
          dmg *= Math.max(0, 1 - (hit.t - def.falloffStart) / (def.falloffEnd - def.falloffStart));
        }
        if (hit.part === 'head') dmg *= def.headMult;
        dmgAcc.set(hit.id, (dmgAcc.get(hit.id) || 0) + dmg);
      } else if (hit.kind === 'world' && i === 0) {
        this.cb.effects.impact(hit.point);
      }
    }
    if (bot.wep === 'shotgun') this.cb.audio.shotgun(); else this.cb.audio.smg();
    for (const [id, dmg] of dmgAcc) {
      if (id === 'player') {
        this.cb.effects.blood(_v3.set(this.cb.player().x, 1, this.cb.player().z), TEAM_HEX.red);
        const died = this.cb.damagePlayer(dmg, bot.name);
        if (died) this._onDeath('player', bot.id, false);
      } else {
        this.damageBot(id, dmg, bot.id, false, true);
      }
    }
  }

  // daño a un bot; from: 'player' | botId
  damageBot(id, dmg, from, gib, silent = false) {
    const b = this.bots.find((x) => x.id === id);
    if (!b || !b.alive || this.phase !== 'playing') return false;
    if (b.protT > 0) return false; // protección de spawn
    b.hp -= dmg;
    b.lastDamage = 0;
    b.recentHit = 0;
    if (!silent) this.cb.effects.blood(_v3.set(b.pos.x, b.y + 1, b.pos.z), TEAM_HEX[b.team]);
    if (b.hp <= 0) {
      b.alive = false;
      if (gib) this.cb.effects.gib(_v3.set(b.pos.x, b.y, b.pos.z), TEAM_HEX[b.team]);
      this._onDeath(id, from, gib);
      return true;
    }
    return false;
  }

  _onDeath(victimId, killerId, gib) {
    this.coverClaims.delete(victimId); // el muerto suelta su reserva de cover
    this.releaseTacticalClaim(victimId);
    const v = this.stats.get(victimId), k = this.stats.get(killerId);
    if (v) v.deaths++;
    if (k) k.kills++;
    // el arma del bot cae junto a su cuerpo (la del jugador la suelta main)
    if (victimId !== 'player') {
      const b = this.bots.find((x) => x.id === victimId);
      if (b) this.cb.dropWeapon?.(b.wep, b.pos.x, b.pos.z, b.team, b.y);
    }
    if (v && k) this.cb.hud.kill(k.name, k.team, v.name, v.team);
    if (killerId === 'player') { this.cb.audio.kill(); this.cb.hud.hitmarker(); }
    const team = v?.team;
    if (!team || this.phase !== 'playing') return;
    if (this.pool[team] > 0) {
      this.pool[team]--;
      this.respawnQueue.push({
        id: victimId,
        t: victimId === 'player' ? PLAYER_RESPAWN() : BOT_RESPAWN,
      });
    }
    this._checkRoundEnd();
  }

  _checkRoundEnd() {
    for (const team of ['red', 'blue']) {
      if (this.livesOf(team) <= 0) {
        this._endRound(team === 'red' ? 'blue' : 'red');
        return;
      }
    }
  }

  _endRound(winner) {
    if (this.phase !== 'playing') return;
    this.phase = 'intermission';
    this.phaseT = 4;
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
    if (winner) this.wins[winner]++;
    const w = this.wins;
    if (winner && w[winner] >= 2) {
      this.phase = 'over';
      const playerWon = winner === 'red';
      this.cb.hud.center(
        playerWon ? 'VICTORIA' : 'DERROTA',
        `match ${w.red} - ${w.blue}`, 6000);
      this.cb.audio.win();
      this.cb.onMatchEnd(winner);
    } else {
      this.cb.hud.center(
        winner ? 'ROUND PARA ' + (winner === 'red' ? 'ROJO' : 'AZUL') : 'ROUND EMPATADO',
        `rounds ${w.red} - ${w.blue}`, 3500);
      if (winner) this.cb.audio.win();
    }
  }

  statRows() {
    const rows = [...this.stats.entries()].map(([id, s]) => ({
      id, name: s.name, team: s.team, kills: s.kills, deaths: s.deaths, score: s.kills * 100,
    }));
    rows.sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    return rows;
  }

  update(dt) {
    if (this.phase === 'over') return;
    // el calor de zonas se enfría solo: información vieja pesa menos
    for (const team of ['red', 'blue']) {
      const h = this.enemyHeat[team];
      const k = Math.exp(-dt / 5);
      h[0] *= k; h[1] *= k; h[2] *= k;
    }
    if (this.phase === 'intermission') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this._startRound(); return; }
      // los ragdolls siguen desplomándose y los vivos respiran en idle
      // (el return seco congelaba estatuas a mitad de la caída 4 s)
      for (const b of this.bots) {
        if (!b.alive) b.update(dt, this);
        else b.rig.update(dt, { state: 'idle', speed: 0, aim: false, aimPitch: 0 });
      }
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      const lr = this.livesOf('red'), lb = this.livesOf('blue');
      this._endRound(lr > lb ? 'red' : lb > lr ? 'blue' : null);
      return;
    }
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const q = this.respawnQueue[i];
      q.t -= dt;
      if (q.t <= 0) {
        this.respawnQueue.splice(i, 1);
        if (q.id === 'player') {
          this.cb.respawnPlayer(this.world.spawns.red[Math.floor(Math.random() * 4)]);
        } else {
          const b = this.bots.find((x) => x.id === q.id);
          if (b) {
            b.respawn(this.world.spawns[b.team][Math.floor(Math.random() * 4)]);
            this._assignRespawnPlan(b);
          }
        }
      }
    }
    for (const b of this.bots) b.update(dt, this);
  }

  dispose() {
    for (const b of this.bots) b.dispose(this.scene);
    this.bots = [];
  }
}
