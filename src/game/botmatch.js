// Modo VS BOTS: TDM 4v4 por rondas en el mapa Arena.
// - Rondas de 5 min; gana la ronda quien agota las vidas del rival
//   (4 iniciales + 15 respawns = 19 por equipo). Match al mejor de 3.
// - IA con estados que usa las mecánicas del juego:
//     advance  → avanza ENTRE coberturas (waypoints al lado seguro de los bloques)
//     engage   → strafea y dispara en ráfagas manteniendo rango de su arma
//     rush     → con escopeta en corto: cierra distancia con saltos de esquiva
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
const RESPAWN_POOL = 15;     // respawns por equipo (además de las 4 vidas iniciales)
const BOT_RESPAWN = 3;
const PLAYER_RESPAWN = () => TUNING.combat.respawnTime;
const BOT_NAMES = { red: ['REX', 'VOLT', 'JAZZ'], blue: ['NOVA', 'DUKE', 'BLITZ', 'PIXEL'] };
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };
const BOT_DMG = 0.7;         // los bots pegan más suave que un jugador

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

const lerpYaw = (a, b, k) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

class Bot {
  constructor(scene, world, id, name, team, spawn) {
    this.id = id; this.name = name; this.team = team;
    this.world = world;
    this.rig = new Rig(scene, team, name);
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
    this.shotCd = 0;
    this.lastDamage = 99; this.recentHit = 99;
    this.wep = 'smg';
    this.swapCd = 0; this.swapAnim = 0;
    this.jumpCd = 0;
    this.cover = null;   // {x, z, tx, tz, low}
    this.coverPhase = 'hide'; this.coverT = 0; this.peekDir = 1;
    this.aggro = Math.random(); // personalidad por vida: >0.55 = rushea con escopeta
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

  _jump() {
    if (!this.grounded || this.jumpCd > 0) return;
    this.vy = 6.2; // mismo apex que el jugador: pasa bloques LOW (1.1)
    this.grounded = false;
    this.jumpCd = 1.2;
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
    this.shotCd -= dt;
    if (this.lastDamage > TUNING.combat.regenDelay && this.hp < TUNING.combat.hp) {
      this.hp = Math.min(TUNING.combat.hp, this.hp + TUNING.combat.regenRate * dt);
    }

    const enemy = match.nearestVisibleEnemy(this);
    const dist = enemy ? Math.hypot(enemy.x - this.pos.x, enemy.z - this.pos.z) : Infinity;

    // ---- decidir estado ----
    if (this.state !== 'cover' && this.hp < 38 && enemy) {
      const spot = match.findCoverSpot(this, enemy);
      if (spot) { this.cover = spot; this.state = 'cover'; this.coverPhase = 'go'; this.coverT = 0; }
    } else if (this.state === 'cover') {
      this.coverT += dt;
      // recuperado (o lleva demasiado escondido) → volver a pelear
      if (this.hp > 80 || this.coverT > 9) { this.state = 'advance'; this.cover = null; }
    } else if (enemy) {
      // arma según distancia; los agresivos con vida llena se comprometen al rush
      if (dist < 8 || (this.aggro > 0.55 && dist < 14 && this.hp > 60)) this._trySwap('shotgun');
      else if (dist > 15) this._trySwap('smg');
      this.state = this.wep === 'shotgun' && dist > 4.5 ? 'rush' : 'engage';
    } else {
      this.state = 'advance';
    }

    // salto de esquiva bajo fuego reciente
    if (this.recentHit < 0.6 && this.state !== 'cover' && Math.random() < 1.2 * dt) this._jump();

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
      if (Math.random() < 0.5 * dt) this._jump();
      if (dist < 9) this._fireAt(dt, match, enemy, dist);
    } else if (this.state === 'cover' && this.cover) {
      const c = this.cover;
      if (this.coverPhase === 'go') {
        const dx = c.x - this.pos.x, dz = c.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) { this.coverPhase = 'hide'; this.coverT = 0; }
        else { mx = dx / d; mz = dz / d; this._face(mx, mz, dt); }
      } else if (this.coverPhase === 'hide') {
        // agazapado tras el bloque, regenerando
        animOverride = c.low ? 'cover_low' : 'cover_high';
        if (enemy) this._face((enemy.x - this.pos.x), (enemy.z - this.pos.z), dt, 5);
        if (this.coverT > 1.2 + Math.random() * 0.8 && this.hp > 55) {
          this.coverPhase = 'peek'; this.coverT = 0;
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
        if (this.coverT > 1.1) { this.coverPhase = 'hide'; this.coverT = 0; }
      }
    } else {
      // advance: waypoints al lado seguro de las coberturas, rumbo al enemigo
      this.repathT -= dt;
      if (!this.wp || this.repathT <= 0 ||
          Math.hypot(this.wp.x - this.pos.x, this.wp.z - this.pos.z) < 1) {
        this.wp = match.advanceWaypoint(this);
        this.repathT = 3 + Math.random() * 3;
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
        if (this.state === 'cover') { this.state = 'advance'; this.cover = null; }
        if (Math.random() < 0.5) this._jump();
      }
    } else this.stuckT = 0;
    this._px = this.pos.x; this._pz = this.pos.z;
    this.vy -= 15 * dt;
    this.y += this.vy * dt;
    const ground = this.world.groundHeight(this.pos, 0.38, this.y);
    if (this.y <= ground && this.vy <= 0) { this.y = ground; this.vy = 0; this.grounded = true; }
    else this.grounded = this.y <= ground + 0.02;

    let anim = animOverride;
    if (!anim) anim = !this.grounded ? 'jump' : this.speed > 0.4 ? 'run' : 'idle';
    this.rig.setTransform(this.pos.x, this.pos.z, this.yaw, this.y);
    this.rig.update(dt, {
      state: anim,
      speed: Math.min(1, this.speed / TUNING.move.roadieSpeed),
      aim: aiming && !animOverride,
      aimPitch: 0,
      firing: this.burstT > 0,
      swapping: this.swapAnim > 0,
    });
    // protección de spawn: highlight sutil del color del equipo
    this.rig.setProtected(this.protT > 0);
  }

  // ráfagas (metralleta) o bombazos sueltos (escopeta)
  _fireAt(dt, match, enemy, dist) {
    if (this.wep === 'shotgun') {
      if (this.shotCd <= 0 && dist < 20) {
        this.shotCd = (60 / TUNING.weapons.shotgun.rpm) * 1.5;
        this.burstT = 0.15;
        match.botShoot(this, enemy);
      }
      this.burstT = Math.max(0, this.burstT - dt);
      return;
    }
    if (this.burstT > 0) {
      this.burstT -= dt;
      if (this.shotCd <= 0) {
        this.shotCd = (60 / TUNING.weapons.smg.rpm) * 1.6;
        match.botShoot(this, enemy);
      }
      if (this.burstT <= 0) this.pauseT = 0.5 + Math.random() * 0.9;
    } else {
      this.pauseT -= dt;
      if (this.pauseT <= 0) this.burstT = 0.4 + Math.random() * 0.5;
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

    this.stats.set('player', { name: cb.playerName, team: 'red', kills: 0, deaths: 0 });
    let n = 0;
    for (const team of ['red', 'blue']) {
      for (const name of BOT_NAMES[team]) {
        const id = 'bot' + n++;
        const spawn = world.spawns[team][this.bots.length % 4];
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
    this.phase = 'playing';
    let i = { red: 0, blue: 0 };
    for (const b of this.bots) {
      b.respawn(this.world.spawns[b.team][++i[b.team] % 4]);
    }
    this.cb.respawnPlayer(this.world.spawns.red[0]);
    this.cb.hud.center('ROUND ' + this.round, 'primero en agotar las 19 vidas rivales', 3000);
  }

  livesOf(team) {
    let alive = 0;
    if (team === 'red' && this.cb.player().alive) alive++;
    for (const b of this.bots) if (b.team === team && b.alive) alive++;
    return alive + this.pool[team];
  }

  targets() { // enemigos del JUGADOR (azules vivos)
    return this.bots
      .filter((b) => b.team === 'blue' && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true }));
  }

  _enemiesOf(bot) {
    const out = this.bots
      .filter((b) => b.team !== bot.team && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true }));
    if (bot.team === 'blue') {
      const p = this.cb.player();
      if (p.alive) out.push({ id: 'player', x: p.x, z: p.z, y: p.y, alive: true });
    }
    return out;
  }

  nearestVisibleEnemy(bot) {
    let best = null, bestD = 30;
    for (const e of this._enemiesOf(bot)) {
      const d = Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z);
      if (d >= bestD) continue;
      _v1.set(bot.pos.x, bot.y + 1.3, bot.pos.z);
      _v2.set(e.x - bot.pos.x, (e.y + 1.3) - (bot.y + 1.3), e.z - bot.pos.z);
      const len = _v2.length();
      _v2.normalize();
      if (this.world.raycast(_v1, _v2, len - 0.5) !== null) continue; // sin LOS
      best = e; bestD = d;
    }
    return best;
  }

  // Cobertura que BLOQUEA la línea de visión del enemigo, cerca del bot.
  findCoverSpot(bot, threat) {
    let best = null, bestD = 14;
    for (const f of this.world.faces) {
      if (f.h > 2.6) continue; // muros perimetrales no
      const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
      const sx = mx + f.n.x * 0.7, sz = mz + f.n.z * 0.7;
      const d = Math.hypot(sx - bot.pos.x, sz - bot.pos.z);
      if (d >= bestD) continue;
      // desde el spot, la vista al enemigo debe estar bloqueada
      _v1.set(sx, 1.2, sz);
      _v2.set(threat.x - sx, 0.1, threat.z - sz);
      const len = _v2.length();
      _v2.normalize();
      if (this.world.raycast(_v1, _v2, Math.min(len, 25)) === null) continue; // vista libre = mal
      const tlen = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      best = {
        x: sx, z: sz,
        tx: (f.b.x - f.a.x) / tlen, tz: (f.b.z - f.a.z) / tlen,
        low: f.h <= TUNING.cover.lowHeight,
      };
      bestD = d;
    }
    return best;
  }

  // Waypoint de avance: 60% al lado seguro de una cobertura rumbo al enemigo
  advanceWaypoint(bot) {
    const towardEnemy = bot.team === 'red' ? 1 : -1;
    if (Math.random() < 0.6) {
      const candidates = this.world.faces.filter((f) =>
        f.h <= 2.6 && f.n.z * towardEnemy < -0.3); // cara que mira a NUESTRO lado
      if (candidates.length) {
        const f = candidates[Math.floor(Math.random() * candidates.length)];
        return {
          x: (f.a.x + f.b.x) / 2 + f.n.x * 0.8,
          z: (f.a.z + f.b.z) / 2 + f.n.z * 0.8,
        };
      }
    }
    return {
      x: (Math.random() * 2 - 1) * (this.world.fx - 2),
      z: (Math.random() * 1.4 - 0.4) * towardEnemy * (this.world.fz - 3),
    };
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
    const v = this.stats.get(victimId), k = this.stats.get(killerId);
    if (v) v.deaths++;
    if (k) k.kills++;
    // el arma del bot cae junto a su cuerpo (la del jugador la suelta main)
    if (victimId !== 'player') {
      const b = this.bots.find((x) => x.id === victimId);
      if (b) this.cb.dropWeapon?.(b.wep, b.pos.x, b.pos.z, b.team);
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
    if (this.phase === 'intermission') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this._startRound();
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
          if (b) b.respawn(this.world.spawns[b.team][Math.floor(Math.random() * 4)]);
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
