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
import { Rig, RAGDOLL_R } from '../player/rig.js';
import { resolveShot, applySpread, applyPelletPattern } from '../combat/ballistics.js';

const ROUND_TIME = 300;      // 5 minutos
const RESPAWN_POOL = 11;     // respawns por equipo (además de las 4 vidas
                             // iniciales = 15 vidas totales, pedido de Chuck)
const BOT_RESPAWN = 3;
const PLAYER_RESPAWN = () => TUNING.combat.respawnTime;
const INTRO_TIME = 10;
const COUNTDOWN_TIME = 3;
const ROUND_RESULT_TIME = 5;
const FINAL_TIME = 11;
const BOT_NAMES = { red: ['REX', 'VOLT', 'JAZZ'], blue: ['NOVA', 'DUKE', 'BLITZ', 'PIXEL'] };
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };
const BOT_DMG = 0.7;         // los bots pegan más suave que un jugador
const TACTICAL_ROLES = ['advance', 'flank', 'hold', 'support', 'angle'];
const STUCK_WINDOW = 0.45;   // reacción perceptiblemente inmediata, sin ruido de un frame
const STUCK_RATIO = 0.32;    // progreso real mínimo frente al movimiento solicitado
const FAILED_ROUTE_TTL = 4.5;
const BYPASS_CLEARANCE = 0.9;

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
    this.variant = (Math.random() * 5) | 0;
    this.profile = {
      aggression: hash01(id + ':aggression'),
      patience: hash01(id + ':patience'),
      flank: hash01(id + ':flank'),
      cohesion: hash01(id + ':cohesion'),
    };
    this.rig = new Rig(scene, team, name, this.variant); // soldado random
    this.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, 0.38, y);
    this.rig.collideFn = (p, y, r = RAGDOLL_R) => world.resolveCircle(p, r, y);
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
    this.lastThreat = null;  // {x,z,age}: el último que me pegó (aunque no lo vea)
    this.coverThreat = null; // amenaza contra la que se eligió el cover actual
    this.role = this.role ?? 'advance';
    this.roleT = 0; this.decisionT = 0; this.decisionSerial = 0;
    this.tacticalGoal = null;
    this.flip = null;  // vuelta acrobática en el aire (solo estilo)
    this.stuckT = 0; this.avoidSide = 0;
    this.recovery = null;    // waypoint temporal para rodear un obstáculo concreto
    this.failedRoutes = [];  // memoria corta de obstáculo/lado y destinos fallidos
    this.progressT = 0; this.progressExpected = 0; this.progressActual = 0;
    this.progressStartX = this.pos.x; this.progressStartZ = this.pos.z;
    this.blockedFrameT = 0;
    this.protT = TUNING.combat.spawnProtection; // invulnerable al nacer
    this.rig.setWeapon('smg');
    this.rig.setVisible(true);
  }

  _resetProgress() {
    this.stuckT = 0;
    this.progressT = 0;
    this.progressExpected = 0;
    this.progressActual = 0;
    this.progressStartX = this.pos.x;
    this.progressStartZ = this.pos.z;
    this.blockedFrameT = 0;
  }

  _obstacleKey(c) {
    if (!c) return 'unknown';
    if (c.minx !== undefined) {
      return `a:${c.minx.toFixed(2)}:${c.minz.toFixed(2)}:${c.maxx.toFixed(2)}:${c.maxz.toFixed(2)}`;
    }
    if (c.a && c.b) {
      return `s:${c.a.x.toFixed(2)}:${c.a.z.toFixed(2)}:${c.b.x.toFixed(2)}:${c.b.z.toFixed(2)}`;
    }
    return 'unknown';
  }

  _goalRecentlyFailed(x, z, radius = 1.8) {
    return this.failedRoutes.some((f) => f.kind === 'goal' && f.ttl > 0 &&
      Math.hypot(f.x - x, f.z - z) < radius);
  }

  _routeSideFailed(key, side) {
    return this.failedRoutes.some((f) => f.kind === 'side' && f.ttl > 0 &&
      f.key === key && f.side === side);
  }

  _rememberGoalFailure(goal) {
    if (!goal) return;
    this.failedRoutes.push({ kind: 'goal', x: goal.x, z: goal.z, ttl: FAILED_ROUTE_TTL });
  }

  _rememberSideFailure(recovery) {
    if (!recovery) return;
    this.failedRoutes.push({
      kind: 'side', key: recovery.key, side: recovery.side, ttl: FAILED_ROUTE_TTL,
    });
  }

  _colliderBounds(c) {
    if (!c) return null;
    if (c.minx !== undefined) {
      return { minx: c.minx, minz: c.minz, maxx: c.maxx, maxz: c.maxz };
    }
    if (c.a && c.b) {
      const pad = c.half ?? 0.1;
      return {
        minx: Math.min(c.a.x, c.b.x) - pad, minz: Math.min(c.a.z, c.b.z) - pad,
        maxx: Math.max(c.a.x, c.b.x) + pad, maxz: Math.max(c.a.z, c.b.z) + pad,
      };
    }
    return null;
  }

  _startObstacleRecovery(collider, dx, dz, goal, match) {
    const bounds = this._colliderBounds(collider);
    if (!bounds) return false;
    const key = this._obstacleKey(collider);
    const len = Math.max(0.001, Math.hypot(dx, dz));
    const fx = dx / len, fz = dz / len;
    const px = -fz, pz = fx;
    const cx = (bounds.minx + bounds.maxx) * 0.5;
    const cz = (bounds.minz + bounds.maxz) * 0.5;
    const hx = (bounds.maxx - bounds.minx) * 0.5;
    const hz = (bounds.maxz - bounds.minz) * 0.5;
    const centerF = cx * fx + cz * fz;
    const centerP = cx * px + cz * pz;
    const radiusF = Math.abs(fx) * hx + Math.abs(fz) * hz;
    const radiusP = Math.abs(px) * hx + Math.abs(pz) * hz;
    const currentF = this.pos.x * fx + this.pos.z * fz;
    const preferred = this.avoidSide ||
      (hash01(this.id + ':avoid:' + key + ':' + this.decisionSerial) < 0.5 ? -1 : 1);
    const sides = [preferred, -preferred];
    let best = null, bestScore = -Infinity;

    for (const side of sides) {
      if (this._routeSideFailed(key, side)) continue;
      const targetF = Math.max(currentF + 1.15, centerF + radiusF + BYPASS_CLEARANCE);
      const targetP = centerP + side * (radiusP + BYPASS_CLEARANCE);
      let x = fx * targetF + px * targetP;
      let z = fz * targetF + pz * targetP;
      x = Math.max(-this.world.fx + 0.75, Math.min(this.world.fx - 0.75, x));
      z = Math.max(-this.world.fz + 0.75, Math.min(this.world.fz - 0.75, z));
      const tx = x - this.pos.x, tz = z - this.pos.z;
      const dist = Math.hypot(tx, tz);
      if (dist < 0.7) continue;

      _v1.set(this.pos.x, 1.45, this.pos.z);
      _v2.set(tx / dist, 0, tz / dist);
      const routeHit = this.world.raycastHit?.(_v1, _v2, Math.max(0, dist - 0.5));
      let score = -dist * 0.18;
      if (goal) score -= Math.hypot(goal.x - x, goal.z - z) * 0.08;
      if (routeHit && routeHit.collider !== collider) score -= 8;
      else if (routeHit) score -= 1.2; // rozar el mismo volumen es aceptable: el clearance lo rodea
      for (const ally of match.bots) {
        if (ally === this || !ally.alive || ally.team !== this.team) continue;
        const ad = Math.hypot(ally.pos.x - x, ally.pos.z - z);
        if (ad < 2.2) score -= (2.2 - ad) * 1.2;
      }
      score += side === preferred ? 0.25 : 0;
      if (score > bestScore) { bestScore = score; best = { x, z, side }; }
    }
    if (!best) return false;
    this.recovery = {
      ...best, key, collider, age: 0,
      goalX: goal?.x ?? null, goalZ: goal?.z ?? null,
    };
    this.avoidSide = best.side;
    this._resetProgress();
    return true;
  }

  _recoverFromStuck(match, contact, requested, goal) {
    const previous = this.recovery;
    if (previous) this._rememberSideFailure(previous);
    this.recovery = null;
    const collider = contact?.collider || previous?.collider || null;
    if (collider && this._startObstacleRecovery(collider, requested.x, requested.z, goal, match)) return;

    // Ambos lados fallaron o el bloqueo no pertenece al mundo estático:
    // descartar el destino y pedir otra decisión táctica, no invertir al azar.
    this._rememberGoalFailure(goal);
    this.wp = null; this.tacticalGoal = null; this.repathT = 0;
    this.decisionT = 0; this.decisionSerial++;
    if (this.state === 'cover' && this.coverPhase === 'go') {
      this._rememberGoalFailure(this.cover);
      const threats = match.threatsFor(this, this.coverThreat);
      const again = threats.length
        ? match.findCoverSpot(this, threats[0], { retreat: true, threats }) : null;
      if (again) {
        this.cover = again;
        match.coverClaims.set(this.id, again);
      } else {
        this.state = 'advance'; this.cover = null;
        match.coverClaims.delete(this.id);
        this.coverCd = 3;
      }
    } else {
      match.refreshTacticalPlan(this, match.nearestVisibleEnemy(this));
      this.wp = this.tacticalGoal;
    }
    this._resetProgress();
  }

  // Steering: el look-ahead identifica el collider alto antes del contacto y
  // crea un waypoint persistente detrás de una de sus esquinas.
  _steer(dx, dz, match, goal) {
    _v1.set(this.pos.x, 0.7, this.pos.z);
    _v2.set(dx, 0, dz);
    const lowHit = this.world.raycastHit?.(_v1, _v2, 1.35);
    if (!lowHit) return { x: dx, z: dz, blocked: false, hit: null };
    // si lo alto está libre es un obstáculo saltable: _jumpIfBlocked se encarga
    _v1.y = 1.6;
    const highHit = this.world.raycastHit?.(_v1, _v2, 1.6);
    if (!highHit) return { x: dx, z: dz, blocked: false, hit: lowHit };

    const obstacle = lowHit.collider || highHit.collider;
    if (!this.recovery || this.recovery.key !== this._obstacleKey(obstacle)) {
      this._startObstacleRecovery(obstacle, dx, dz, goal, match);
    }
    let rx = dx, rz = dz;
    if (this.recovery) {
      rx = this.recovery.x - this.pos.x; rz = this.recovery.z - this.pos.z;
      const rl = Math.max(0.001, Math.hypot(rx, rz)); rx /= rl; rz /= rl;
    }
    _v1.y = 0.7;
    for (const ang of [0, 0.42 * this.avoidSide, 0.85 * this.avoidSide,
                       -0.42 * this.avoidSide, 1.35 * this.avoidSide]) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const nx = rx * c - rz * s, nz = rx * s + rz * c;
      _v2.set(nx, 0, nz);
      if (this.world.raycast(_v1, _v2, 0.9) === null) {
        return { x: nx, z: nz, blocked: true, hit: lowHit };
      }
    }
    return { x: -rx, z: -rz, blocked: true, hit: lowHit }; // crear espacio para el siguiente intento
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
    if (this.lastThreat && (this.lastThreat.age += dt) > 4) this.lastThreat = null;
    this.protT = Math.max(0, this.protT - dt);
    this.swapCd = Math.max(0, this.swapCd - dt);
    this.swapAnim = Math.max(0, this.swapAnim - dt);
    this.jumpCd = Math.max(0, this.jumpCd - dt);
    this.coverCd = Math.max(0, this.coverCd - dt);
    this.roleT = Math.max(0, this.roleT - dt);
    this.decisionT = Math.max(0, this.decisionT - dt);
    for (const f of this.failedRoutes) f.ttl -= dt;
    this.failedRoutes = this.failedRoutes.filter((f) => f.ttl > 0);
    if (this.recovery) this.recovery.age += dt;
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
    // La retirada considera fuego reciente y balance local, no solo una cifra
    // extrema de vida. La amenaza de referencia incluye al ÚLTIMO TIRADOR
    // aunque no esté en línea de visión (antes huía "del visible más
    // cercano", que podía no ser quien le pegaba).
    const pressure = enemy ? match.localPressure(this, 11) : 0;
    const ghost = this.lastThreat && this.lastThreat.age < 3 ? this.lastThreat : null;
    const threatRef = enemy ?? ghost;
    const wantsSafety = this.hp < 24 ||
      (this.hp < 48 && (this.recentHit < 2.2 || pressure > 0));
    const spot = this.state !== 'cover' && this.coverCd <= 0 && wantsSafety && threatRef
      ? match.findCoverSpot(this, threatRef, { retreat: true, threats: match.threatsFor(this, threatRef) })
      : null;
    if (spot) {
      this.cover = spot; this.state = 'cover';
      this.coverPhase = 'go'; this.coverT = 0; this.coverPhaseT = 0;
      this.coverThreat = { x: threatRef.x, z: threatRef.z };
      this.coverCheckT = 0.6;
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
        // revalidar EN RUTA cada 0.6s: si el spot dejó de romper la línea de
        // tiro (la amenaza se movió) o un compañero lo reclamó, re-buscar en
        // vez de seguir corriendo a una posición que ya no protege
        this.coverCheckT = (this.coverCheckT ?? 0.6) - dt;
        if (this.coverCheckT <= 0 && d > 0.6) {
          this.coverCheckT = 0.6;
          const threats = match.threatsFor(this, enemy ?? this.coverThreat);
          if (threats.length && !match.coverStillSafe(this, c, threats)) {
            this.decisionSerial++;
            const again = match.findCoverSpot(this, threats[0], { retreat: true, threats });
            if (again) {
              this.cover = again;
              match.coverClaims.set(this.id, again);
            } else {
              this.state = 'advance'; this.cover = null;
              match.coverClaims.delete(this.id);
              this.coverCd = 2; this.decisionT = 0;
            }
          }
        }
        if (d < 0.5) {
          // "cerca del cover" ≠ "protegido": solo agacharse si la posición
          // REALMENTE bloquea a la amenaza; si no, re-buscar de inmediato
          const threats = match.threatsFor(this, enemy ?? this.coverThreat);
          if (!threats.length || match.coverStillSafe(this, c, threats)) {
            this.coverPhase = 'hide'; this.coverPhaseT = 0;
          } else {
            this.decisionSerial++;
            const again = match.findCoverSpot(this, threats[0], { retreat: true, threats });
            if (again) { this.cover = again; match.coverClaims.set(this.id, again); }
            else {
              this.state = 'advance'; this.cover = null;
              match.coverClaims.delete(this.id);
              this.coverCd = 2; this.decisionT = 0;
            }
          }
        } else { mx = dx / d; mz = dz / d; this._face(mx, mz, dt); }
      } else if (this.coverPhase === 'hide') {
        // agazapado tras el bloque, regenerando
        animOverride = c.low ? 'cover_low' : 'cover_high';
        if (enemy) this._face((enemy.x - this.pos.x), (enemy.z - this.pos.z), dt, 5);
        // el escondite CADUCA si la amenaza flanquea: re-evaluar cada 0.6s y
        // reubicarse (muchas veces al otro lado del MISMO bloque)
        this.coverCheckT = (this.coverCheckT ?? 0.6) - dt;
        if (this.coverCheckT <= 0) {
          this.coverCheckT = 0.6;
          const threats = match.threatsFor(this, enemy ?? this.coverThreat);
          if (threats.length && !match.coverStillSafe(this, c, threats)) {
            this.decisionSerial++;
            const again = match.findCoverSpot(this, threats[0], { retreat: true, threats });
            if (again) {
              this.cover = again;
              this.coverPhase = 'go'; this.coverPhaseT = 0;
              this.coverThreat = { x: threats[0].x, z: threats[0].z };
              match.coverClaims.set(this.id, again);
            } else {
              this.state = 'advance'; this.cover = null;
              match.coverClaims.delete(this.id);
              this.coverCd = 2; this.decisionT = 0;
            }
          } else if (threats[0]) {
            this.coverThreat = { x: threats[0].x, z: threats[0].z };
          }
        }
        // asomarse aunque el regen no haya llegado (35): así el ciclo
        // hide→peek→hide ocurre 2-3 veces por visita a cobertura
        if (this.state === 'cover' && this.coverPhase === 'hide' &&
            this.coverPhaseT > 1.0 + Math.random() * 0.7 && this.hp > 35) {
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

    // Un bypass activo manda sobre el waypoint final hasta cruzar la esquina.
    // Al completarlo, la intención táctica original vuelve a tomar el control.
    const activeGoal = this.state === 'cover' && this.coverPhase === 'go'
      ? this.cover : (this.wp || this.tacticalGoal || enemy);
    if (this.recovery) {
      const rx = this.recovery.x - this.pos.x, rz = this.recovery.z - this.pos.z;
      const rd = Math.hypot(rx, rz);
      if (rd < 0.65) {
        this.recovery = null;
        this._resetProgress();
      } else if (this.recovery.age > 3.2) {
        this._recoverFromStuck(match, null, { x: rx / rd, z: rz / rd }, activeGoal);
      } else {
        mx = rx / rd; mz = rz / rd;
        this._face(mx, mz, dt, 9);
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
    const beforeX = this.pos.x, beforeZ = this.pos.z;
    let wasGrounded = this.grounded;
    let steering = null;
    if (mlen > 0.05) {
      steering = this._steer(mx / mlen, mz / mlen, match, activeGoal);
      this._jumpIfBlocked(steering.x, steering.z);
      // Un salto deliberado deja de ser un movimiento pegado al suelo.
      wasGrounded = this.grounded;
      this.pos.x += steering.x * spd * dt;
      this.pos.z += steering.z * spd * dt;
    } else { this.speed = 0; this.velX = 0; this.velZ = 0; }
    this.world.resolveCircle(this.pos, 0.38, this.y);

    // groundHeight da soporte a un círculo desde que toca la rampa. Sin este
    // guard, un bot que la rozaba de lado heredaba su altura instantáneamente.
    // Reutilizamos la misma regla que el jugador y conservamos el eje válido
    // para que pueda deslizarse por el borde en vez de quedar clavado.
    if (wasGrounded) {
      const maxStep = TUNING.move.maxStepUp;
      const fullGround = this.world.groundHeight(this.pos, 0.38, this.y);
      if (fullGround > this.y + maxStep) {
        const candidate = (x, z) => {
          const p = { x, z };
          this.world.resolveCircle(p, 0.38, this.y);
          const h = this.world.groundHeight(p, 0.38, this.y);
          return h <= this.y + maxStep
            ? { p, d2: (p.x - beforeX) ** 2 + (p.z - beforeZ) ** 2 }
            : null;
        };
        const onlyX = candidate(this.pos.x, beforeZ);
        const onlyZ = candidate(beforeX, this.pos.z);
        const best = !onlyX ? onlyZ : !onlyZ ? onlyX : (onlyX.d2 >= onlyZ.d2 ? onlyX : onlyZ);
        if (best) {
          this.pos.x = best.p.x; this.pos.z = best.p.z;
        } else {
          this.pos.x = beforeX; this.pos.z = beforeZ;
        }
      }
    }

    const actualX = this.pos.x - beforeX, actualZ = this.pos.z - beforeZ;
    const moved = Math.hypot(actualX, actualZ);
    if (mlen > 0.05) {
      this.speed = Math.min(spd * 1.15, moved / Math.max(0.001, dt));
      this.velX = actualX / Math.max(0.001, dt);
      this.velZ = actualZ / Math.max(0.001, dt); // momentum REAL para la muerte
    }

    // Movimiento solicitado vs. movimiento real, acumulado en una ventana
    // corta. También cuenta contactos repetidos para reaccionar antes de 0.45s.
    if (mlen > 0.05 && this.grounded) {
      const expected = spd * dt;
      const forward = Math.max(0, actualX * steering.x + actualZ * steering.z);
      this.progressT += dt;
      this.progressExpected += expected;
      this.progressActual += forward;
      this.stuckT = this.progressT;
      if (forward < expected * 0.22) this.blockedFrameT += dt;
      else this.blockedFrameT = Math.max(0, this.blockedFrameT - dt * 2.5);

      const ratio = this.progressActual / Math.max(0.001, this.progressExpected);
      const net = Math.hypot(this.pos.x - this.progressStartX, this.pos.z - this.progressStartZ);
      const repeatedContact = this.blockedFrameT >= 0.28;
      const windowStuck = this.progressT >= STUCK_WINDOW && ratio < STUCK_RATIO &&
        net < this.progressExpected * 0.38;
      if (repeatedContact || windowStuck) {
        _v1.set(this.pos.x, 0.7, this.pos.z);
        _v2.set(steering.x, 0, steering.z);
        const contact = steering.hit || this.world.raycastHit?.(_v1, _v2, 1.6) || null;
        this.speed = 0; this.velX = 0; this.velZ = 0;
        this._recoverFromStuck(match, contact, steering, activeGoal);
      } else if (this.progressT >= STUCK_WINDOW) {
        this._resetProgress();
      }
    } else this._resetProgress();
    const ground = this.world.groundHeight(this.pos, 0.38, this.y);
    const followsGround = wasGrounded && this.vy <= 0 &&
      ground <= this.y + TUNING.move.maxStepUp &&
      this.y - ground <= TUNING.move.groundStickDown;
    if (followsGround) {
      this.y = ground; this.vy = 0; this.grounded = true;
    } else {
      this.vy -= 15 * dt;
      this.y += this.vy * dt;
      if (this.y <= ground && this.vy <= 0) {
        this.y = ground; this.vy = 0; this.grounded = true;
      } else this.grounded = this.y <= ground + 0.02;
    }

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
        match.cb.stepSound?.(this.pos.x, this.pos.z,
          this.speed > 4.6 ? 'run' : 'walk', this.y);
      }
    } else {
      this._facc = 0;
    }
    if (this._wasAir && this.grounded) {
      match.cb.stepSound?.(this.pos.x, this.pos.z, 'land', this.y);
    }
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

    this.stats.set('player', {
      name: cb.playerName, team: 'red', kills: 0, deaths: 0,
      variant: cb.playerVariant ?? 0,
    });
    let n = 0;
    for (const team of ['red', 'blue']) {
      for (const name of BOT_NAMES[team]) {
        const id = 'bot' + n++;
        // +1: el spawn [0] del lado rojo es del JUGADOR (evitar solaparse)
        const spawn = world.spawns[team][(this.bots.length + 1) % 4];
        this.bots.push(new Bot(scene, world, id, name, team, spawn));
        this.stats.set(id, { name, team, kills: 0, deaths: 0, variant: this.bots.at(-1).variant });
      }
    }
    this.roundWinner = null;
    this.matchWinner = null;
    this._startRound(true);
  }

  _startRound(first = false) {
    this.round++;
    this.timer = ROUND_TIME;
    this.pool = { red: RESPAWN_POOL, blue: RESPAWN_POOL };
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
    this.phase = first ? 'intro' : 'countdown';
    this.phaseT = first ? INTRO_TIME : COUNTDOWN_TIME;
    this.roundWinner = null;
    let i = { red: 0, blue: 0 };
    for (const b of this.bots) {
      b.respawn(this.world.spawns[b.team][++i[b.team] % 4]);
    }
    this._assignOpeningPlans();
    this.cb.respawnPlayer(this.world.spawns.red[0], false);
  }

  controlsLocked() { return this.phase !== 'playing'; }

  _idleBots(dt) {
    for (const b of this.bots) {
      if (!b.alive) b.update(dt, this);
      else {
        b.rig.setTransform(b.pos.x, b.pos.z, b.yaw, b.y);
        b.rig.update(dt, { state: 'idle', speed: 0, aim: false, aimPitch: 0 });
      }
    }
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
    if (bot._goalRecentlyFailed(targetX, targetZ, 2.4)) {
      const side = bot.avoidSide || (bot.profile.flank < 0.5 ? -1 : 1);
      targetX = clampX(targetX + side * 5.5);
      targetZ = clampZ(targetZ - toward * 1.5);
    }

    let best = null, bestScore = -Infinity;
    for (let i = 0; i < this.world.faces.length; i++) {
      const f = this.world.faces[i];
      if (f.h > 2.6) continue;
      const x = (f.a.x + f.b.x) / 2 + f.n.x * 0.78;
      const z = (f.a.z + f.b.z) / 2 + f.n.z * 0.78;
      if (Math.abs(x) > this.world.fx - 1 || Math.abs(z) > this.world.fz - 1) continue;
      if (bot._goalRecentlyFailed(x, z)) continue;
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

  // Amenazas REALES de una retirada: enemigos con línea de visión + el último
  // tirador (fantasma, aunque no se vea). La primaria va primero.
  threatsFor(bot, primary) {
    const list = this.visibleEnemies(bot).slice(0, 3);
    const lt = bot.lastThreat;
    if (lt && lt.age < 3 &&
        !list.some((e) => Math.hypot(e.x - lt.x, e.z - lt.z) < 3)) {
      list.push({ x: lt.x, z: lt.z, ghost: true });
    }
    if (primary) {
      const i = list.findIndex((e) => Math.hypot(e.x - primary.x, e.z - primary.z) < 0.5);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
      else if (i < 0) list.unshift({ x: primary.x, z: primary.z });
    }
    return list;
  }

  // ¿Este spot sigue siendo cobertura REAL contra estas amenazas?
  // (lado correcto de la cara + línea de tiro de la primaria bloqueada
  // desde la postura final + reserva no pisada por un compañero)
  coverStillSafe(bot, c, threats) {
    const t = threats[0];
    if (!t) return true;
    if (c.nx !== undefined && (t.x - c.x) * c.nx + (t.z - c.z) * c.nz > 0.2) return false;
    const eye = c.low ? 0.8 : 1.2;
    _v1.set(c.x, eye, c.z);
    _v2.set(t.x - c.x, 0.1, t.z - c.z);
    const len = _v2.length();
    _v2.normalize();
    if (this.world.raycast(_v1, _v2, Math.min(len, 25)) === null) return false;
    for (const [cid, cl] of this.coverClaims) {
      if (cid !== bot.id && Math.hypot(cl.x - c.x, cl.z - c.z) < 1.4) return false;
    }
    return true;
  }

  // Cobertura que BLOQUEA la línea de visión del enemigo. No elige simplemente
  // la más cercana: puntúa cada candidato por amenazas restantes con tiro,
  // seguridad de la RUTA (nada de correr contra un muro no saltable ni HACIA
  // la amenaza), retirada, espacio personal y reservas.
  findCoverSpot(bot, threat, { retreat = false, threats = null } = {}) {
    const threatList = threats && threats.length ? threats : [{ x: threat.x, z: threat.z }];
    const primary = threatList[0];
    let best = null, bestScore = -Infinity;
    const currentThreatD = Math.hypot(primary.x - bot.pos.x, primary.z - bot.pos.z);
    const toThreatX = (primary.x - bot.pos.x) / Math.max(0.01, currentThreatD);
    const toThreatZ = (primary.z - bot.pos.z) / Math.max(0.01, currentThreatD);
    for (let fi = 0; fi < this.world.faces.length; fi++) {
      const f = this.world.faces[fi];
      if (f.h > 2.6) continue; // muros perimetrales no
      const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
      // la cara debe darle la ESPALDA a la amenaza primaria: sin este check
      // el bot se "cubría" parado del lado del enemigo, de frente a él
      if ((primary.x - mx) * f.n.x + (primary.z - mz) * f.n.z > -0.2) continue;
      const sx = mx + f.n.x * 0.7, sz = mz + f.n.z * 0.7;
      if (bot._goalRecentlyFailed(sx, sz)) continue;
      const d = Math.hypot(sx - bot.pos.x, sz - bot.pos.z);
      if (d > 16 || d < 1.2) continue;
      if (Math.hypot(primary.x - sx, primary.z - sz) < 5) continue; // no en su cara

      // NUNCA escapar corriendo HACIA la amenaza: si la ruta apunta a menos
      // de ~55° del tirador y él está en ese trayecto, el spot no sirve
      const pdx = (sx - bot.pos.x) / Math.max(0.01, d);
      const pdz = (sz - bot.pos.z) / Math.max(0.01, d);
      if (retreat && pdx * toThreatX + pdz * toThreatZ > 0.55 && currentThreatD < d + 4) continue;

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
      _v2.set(primary.x - sx, 0.1, primary.z - sz);
      const len = _v2.length();
      _v2.normalize();
      if (this.world.raycast(_v1, _v2, Math.min(len, 25)) === null) continue; // vista libre = mal

      // amenazas SECUNDARIAS que aún tendrían tiro desde el spot: cada una
      // resta — "cerca de un cover" no es "protegido por ese cover"
      let exposure = 0;
      for (let ti = 1; ti < threatList.length; ti++) {
        const t2 = threatList[ti];
        const sideOk = (t2.x - mx) * f.n.x + (t2.z - mz) * f.n.z < 0.2;
        _v1.set(sx, eye, sz);
        _v2.set(t2.x - sx, 0.1, t2.z - sz);
        const l2 = _v2.length();
        _v2.normalize();
        const blocked = this.world.raycast(_v1, _v2, Math.min(l2, 25)) !== null;
        if (!sideOk || !blocked) exposure += t2.ghost ? 1.0 : 1.6;
      }

      let crowd = 0;
      for (const a of this._alliesOf(bot)) {
        if (!a.pos) continue;
        const ad = Math.hypot(a.pos.x - sx, a.pos.z - sz);
        if (ad < 5) crowd += (5 - ad) * 0.8;
      }
      const newThreatD = Math.hypot(primary.x - sx, primary.z - sz);
      let score = -d * 0.34 - crowd - exposure +
        (newThreatD - currentThreatD) * (retreat ? 0.18 : 0.06);
      const faceLen = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      score += Math.min(1.2, faceLen * 0.12);

      // ruta: un bloqueo a altura de pecho (no saltable) al inicio del
      // trayecto = correr contra la pared → descartar; lejano → castigo duro
      _v1.set(bot.pos.x, 1.45, bot.pos.z);
      _v2.set(sx - bot.pos.x, 0, sz - bot.pos.z);
      const pathLen = _v2.length();
      if (pathLen > 1.5) {
        _v2.normalize();
        const tHit = this.world.raycast(_v1, _v2, pathLen - 1.1);
        if (tHit !== null) {
          if (retreat && tHit < Math.min(4, pathLen * 0.55)) continue;
          score -= 3;
        }
      }
      score += hash01(bot.id + ':cover:' + bot.decisionSerial + ':' + fi) * 0.16;
      if (score <= bestScore) continue;
      const tlen = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      best = {
        x: sx, z: sz,
        tx: (f.b.x - f.a.x) / tlen, tz: (f.b.z - f.a.z) / tlen,
        nx: f.n.x, nz: f.n.z,
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
      const dir = pellets > 1
        ? applyPelletPattern(baseDir, def.spreadHip, i, pellets)
        : baseDir;
      const hit = resolveShot(this.world, targets, _v1, dir, def.range, bot.id);
      if (i === 0) this.cb.effects.tracer(_v1, hit.point);
      if (hit.kind === 'player') {
        let dmg = def.dmg * BOT_DMG;
        if (def.falloffStart && hit.t > def.falloffStart) {
          dmg *= Math.max(0, 1 - (hit.t - def.falloffStart) / (def.falloffEnd - def.falloffStart));
        }
        if (hit.part === 'head') dmg *= def.headMult;
        const acc = dmgAcc.get(hit.id) || { dmg: 0, part: hit.part, dist: hit.t };
        acc.dmg += dmg;
        acc.dist = Math.min(acc.dist, hit.t);
        if (hit.part === 'head') acc.part = 'head';
        dmgAcc.set(hit.id, acc);
      } else if (hit.kind === 'world') {
        // Cada pellet deja su marca; Effects limita/presupuesta las partículas.
        this.cb.effects.impact(hit.point, hit.normal, hit.surface);
        this.cb.audio.impact(hit.point, hit.surface);
      }
    }
    const shotAudio = { position: { x: bot.pos.x, y: bot.y + 1.35, z: bot.pos.z } };
    if (bot.wep === 'shotgun') this.cb.audio.shotgun(shotAudio);
    else this.cb.audio.smg(shotAudio);
    for (const [id, hitCtx] of dmgAcc) {
      const dmg = hitCtx.dmg;
      const gib = bot.wep === 'shotgun' && hitCtx.dist <= TUNING.weapons.shotgun.gibRange;
      const deathCtx = {
        weapon: bot.wep, distance: hitCtx.dist, damage: dmg,
        part: hitCtx.part, gib,
      };
      if (id === 'player') {
        this.cb.effects.blood(_v3.set(this.cb.player().x, 1, this.cb.player().z), TEAM_HEX.red);
        const died = this.cb.damagePlayer(dmg, bot.name, { x: bot.pos.x, z: bot.pos.z }, deathCtx);
        if (died) {
          if (gib) this.cb.effects.gib(_v3.set(this.cb.player().x, this.cb.player().y || 0, this.cb.player().z), TEAM_HEX.red);
          this._onDeath('player', bot.id, gib);
        }
      } else {
        this.damageBot(id, dmg, bot.id, gib, true, deathCtx);
      }
    }
  }

  // daño a un bot; from: 'player' | botId
  damageBot(id, dmg, from, gib, silent = false, hitCtx = null) {
    const b = this.bots.find((x) => x.id === id);
    if (!b || !b.alive || this.phase !== 'playing') return null;
    if (b.protT > 0) return null; // protegido: rechazo distinguible de "no murió"
    b.hp -= dmg;
    b.lastDamage = 0;
    b.recentHit = 0;
    // memoria del tirador: la retirada debe protegerse de QUIEN le pega,
    // esté o no en línea de visión en ese momento
    const att = from === 'player'
      ? (() => { const p = this.cb.player(); return p.alive ? { x: p.x, z: p.z } : null; })()
      : (() => { const ab = this.bots.find((x) => x.id === from); return ab?.alive ? { x: ab.pos.x, z: ab.pos.z } : null; })();
    if (att) b.lastThreat = { x: att.x, z: att.z, age: 0 };
    if (!silent) this.cb.effects.blood(_v3.set(b.pos.x, b.y + 1, b.pos.z), TEAM_HEX[b.team]);
    if (b.hp <= 0) {
      b.alive = false;
      // contexto físico del ragdoll: de dónde vino el tiro final, con qué
      // fuerza (daño del golpe), y el momentum/estado que llevaba el bot
      b.rig.setDeathContext({
        impact: att ? { x: b.pos.x - att.x, z: b.pos.z - att.z } : null,
        power: Math.min(1, dmg / 55) + (gib ? 0.35 : 0),
        vel: { x: b.velX ?? 0, z: b.velZ ?? 0 },
        state: b.state === 'cover' ? (b.cover?.low ? 'cover_low' : 'cover_high') : b.state,
        weapon: hitCtx?.weapon,
        distance: hitCtx?.distance,
        damage: hitCtx?.damage ?? dmg,
        part: hitCtx?.part,
        gib: !!gib,
      });
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
      if (b) this.cb.dropWeapon?.(b.wep, b.pos.x, b.pos.z, b.team, b.y, b.rig);
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
    this.phaseT = ROUND_RESULT_TIME;
    this.roundWinner = winner;
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
    if (winner) this.wins[winner]++;
    const w = this.wins;
    if (winner && w[winner] >= 2) {
      this.phase = 'final';
      this.phaseT = FINAL_TIME;
      this.matchWinner = winner;
      this.cb.audio.win();
    } else {
      if (winner) this.cb.audio.win();
    }
  }

  statRows() {
    const rows = [...this.stats.entries()].map(([id, s]) => ({
      id, name: s.name, team: s.team, kills: s.kills, deaths: s.deaths,
      score: s.kills * 100, variant: s.variant ?? 0,
    }));
    rows.sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    return rows;
  }

  update(dt) {
    if (this.phase === 'over') return;
    if (this.phase === 'intro' || this.phase === 'countdown') {
      this.phaseT -= dt;
      this._idleBots(dt);
      if (this.phaseT <= 0) {
        if (this.phase === 'intro') {
          this.phase = 'countdown';
          this.phaseT = COUNTDOWN_TIME;
        } else {
          this.phase = 'playing';
          this.phaseT = 0;
          this.cb.onRoundStart?.();
        }
      }
      return;
    }
    if (this.phase === 'final') {
      this.phaseT -= dt;
      this._idleBots(dt);
      if (this.phaseT <= 0) {
        this.phase = 'over';
        this.cb.onMatchEnd(this.matchWinner);
      }
      return;
    }
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
      // (el return seco congelaba estatuas a mitad de la caída)
      this._idleBots(dt);
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
