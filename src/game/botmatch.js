// Modo VS BOTS: TDM 4v4 por rondas en el mapa Arena.
// - Rondas de 5 min; gana la ronda quien agota las vidas del rival
//   (4 iniciales + 15 respawns = 19 por equipo). Match al mejor de 3 (2 rondas).
// - Bots con IA simple: patrullan, buscan línea de visión, strafean y
//   disparan en ráfagas con error de puntería. Sin fuego amigo.
// - Lleva stats (kills/deaths, 100 pts por kill) para el scoreboard (Tab/VIEW).
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { Rig } from '../player/rig.js';
import { resolveShot, applySpread } from '../combat/ballistics.js';

const ROUND_TIME = 300;      // 5 minutos
const RESPAWN_POOL = 15;     // respawns por equipo (además de las 4 vidas iniciales)
const BOT_RESPAWN = 3, PLAYER_RESPAWN = 4;
const BOT_NAMES = { red: ['REX', 'VOLT', 'JAZZ'], blue: ['NOVA', 'DUKE', 'BLITZ', 'PIXEL'] };
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

class Bot {
  constructor(scene, world, id, name, team, spawn) {
    this.id = id; this.name = name; this.team = team;
    this.world = world;
    this.rig = new Rig(scene, team, name);
    this.pos = { x: spawn.x, z: spawn.z };
    this.yaw = spawn.yaw;
    this.hp = TUNING.combat.hp;
    this.alive = true;
    this.speed = 0;
    this.wp = null; this.repathT = 0;
    this.strafeDir = 1; this.strafeT = 0;
    this.burstT = 0; this.pauseT = 1 + Math.random();
    this.shotCd = 0;
    this.lastDamage = 0;
  }

  respawn(spawn) {
    this.pos = { x: spawn.x, z: spawn.z };
    this.yaw = spawn.yaw;
    this.hp = TUNING.combat.hp;
    this.alive = true;
    this.wp = null;
    this.pauseT = 0.8 + Math.random();
    this.rig.setVisible(true);
  }

  update(dt, match) {
    if (!this.alive) {
      this.rig.update(dt, { state: 'dead', speed: 0, aim: false, aimPitch: 0 });
      return;
    }
    this.lastDamage += dt;
    if (this.lastDamage > TUNING.combat.regenDelay && this.hp < TUNING.combat.hp) {
      this.hp = Math.min(TUNING.combat.hp, this.hp + TUNING.combat.regenRate * dt);
    }

    const enemy = match.nearestVisibleEnemy(this);
    let mx = 0, mz = 0, engaging = false;

    if (enemy) {
      engaging = true;
      const dx = enemy.x - this.pos.x, dz = enemy.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      const ex = dx / dist, ez = dz / dist;
      // encarar al enemigo
      const wantYaw = Math.atan2(-ex, -ez);
      let d = wantYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * (1 - Math.exp(-8 * dt));
      // strafe lateral + mantener distancia media
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeT = 0.8 + Math.random() * 1.4; }
      const tx = -ez * this.strafeDir, tz = ex * this.strafeDir;
      const push = dist > 15 ? 0.7 : dist < 5 ? -0.7 : 0;
      mx = tx * 0.7 + ex * push;
      mz = tz * 0.7 + ez * push;
      // ráfagas con error de puntería
      this.shotCd -= dt;
      if (this.burstT > 0) {
        this.burstT -= dt;
        if (this.shotCd <= 0 && Math.abs(d) < 0.35) {
          this.shotCd = 60 / TUNING.weapons.smg.rpm * 1.6; // bots tiran más lento
          match.botShoot(this, enemy);
        }
        if (this.burstT <= 0) this.pauseT = 0.5 + Math.random() * 0.9;
      } else {
        this.pauseT -= dt;
        if (this.pauseT <= 0) this.burstT = 0.4 + Math.random() * 0.5;
      }
    } else {
      // patrullar: waypoint aleatorio sesgado hacia el lado enemigo
      this.repathT -= dt;
      if (!this.wp || this.repathT <= 0 ||
          Math.hypot(this.wp.x - this.pos.x, this.wp.z - this.pos.z) < 1) {
        const towardEnemy = this.team === 'red' ? 1 : -1;
        this.wp = {
          x: (Math.random() * 2 - 1) * (this.world.fx - 2),
          z: (Math.random() * 1.4 - 0.4) * towardEnemy * (this.world.fz - 3),
        };
        this.repathT = 3 + Math.random() * 3;
      }
      const dx = this.wp.x - this.pos.x, dz = this.wp.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        mx = dx / dist; mz = dz / dist;
        const wantYaw = Math.atan2(-mx, -mz);
        let d = wantYaw - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.yaw += d * (1 - Math.exp(-6 * dt));
      }
    }

    // mover
    const spd = engaging ? 3.2 : 4.2;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 0.05) {
      this.pos.x += (mx / mlen) * spd * dt;
      this.pos.z += (mz / mlen) * spd * dt;
      this.speed = spd;
    } else this.speed = 0;
    this.world.resolveCircle(this.pos, 0.38);

    this.rig.setTransform(this.pos.x, this.pos.z, this.yaw);
    this.rig.update(dt, {
      state: this.speed > 0.4 ? 'run' : 'idle',
      speed: Math.min(1, this.speed / TUNING.move.roadieSpeed),
      aim: engaging,
      aimPitch: 0,
      firing: this.burstT > 0,
    });
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
    this.stats = new Map(); // id -> {name, team, kills, deaths}
    this.wins = { red: 0, blue: 0 };
    this.round = 0;
    this.timer = ROUND_TIME;
    this.phase = 'starting'; // starting | playing | intermission | over
    this.phaseT = 0;
    this.pool = { red: RESPAWN_POOL, blue: RESPAWN_POOL };
    this.respawnQueue = []; // {id, t}

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
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: 0, alive: true }));
  }

  // todos los blancos vivos del equipo contrario a `bot` (incluye al jugador)
  _enemiesOf(bot) {
    const out = this.bots
      .filter((b) => b.team !== bot.team && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: 0, alive: true }));
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
      _v1.set(bot.pos.x, 1.3, bot.pos.z);
      _v2.set(e.x - bot.pos.x, (e.y + 1.3) - 1.3, e.z - bot.pos.z);
      const len = _v2.length();
      _v2.normalize();
      if (this.world.raycast(_v1, _v2, len - 0.5) !== null) continue; // sin LOS
      best = e; bestD = d;
    }
    return best;
  }

  botShoot(bot, enemy) {
    const def = TUNING.weapons.smg;
    _v1.set(bot.pos.x, 1.35, bot.pos.z);
    _v3.set(enemy.x, (enemy.y ?? 0) + 1.0 + Math.random() * 0.4, enemy.z).sub(_v1).normalize();
    const dir = applySpread(_v3, 4.5); // error de puntería del bot
    const targets = this._enemiesOf(bot);
    const hit = resolveShot(this.world, targets, _v1, dir, def.range, bot.id);
    this.cb.effects.tracer(_v1, hit.point);
    this.cb.audio.smg();
    if (hit.kind === 'player') {
      let dmg = def.dmg * 0.7; // los bots pegan más suave
      if (hit.part === 'head') dmg *= def.headMult;
      if (hit.id === 'player') {
        this.cb.effects.blood(hit.point, TEAM_HEX.red);
        const died = this.cb.damagePlayer(dmg, bot.name);
        if (died) this._onDeath('player', bot.id, false);
      } else {
        this.damageBot(hit.id, dmg, bot.id, false, true);
      }
    } else if (hit.kind === 'world') {
      this.cb.effects.impact(hit.point);
    }
  }

  // daño a un bot; from: 'player' | botId
  damageBot(id, dmg, from, gib, silent = false) {
    const b = this.bots.find((x) => x.id === id);
    if (!b || !b.alive || this.phase !== 'playing') return false;
    b.hp -= dmg;
    b.lastDamage = 0;
    if (!silent) this.cb.effects.blood(_v3.set(b.pos.x, 1, b.pos.z), TEAM_HEX[b.team]);
    if (b.hp <= 0) {
      b.alive = false;
      if (gib) this.cb.effects.gib(_v3.set(b.pos.x, 0, b.pos.z), TEAM_HEX[b.team]);
      this._onDeath(id, from, gib);
      return true;
    }
    return false;
  }

  _onDeath(victimId, killerId, gib) {
    const v = this.stats.get(victimId), k = this.stats.get(killerId);
    if (v) v.deaths++;
    if (k) k.kills++;
    if (v && k) this.cb.hud.kill(k.name, k.team, v.name, v.team);
    if (killerId === 'player') { this.cb.audio.kill(); this.cb.hud.hitmarker(); }
    const team = v?.team;
    if (!team || this.phase !== 'playing') return;
    // vidas: consumir un respawn del pool, o quedar fuera
    if (this.pool[team] > 0) {
      this.pool[team]--;
      this.respawnQueue.push({
        id: victimId,
        t: victimId === 'player' ? PLAYER_RESPAWN : BOT_RESPAWN,
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
    // timer de ronda
    this.timer -= dt;
    if (this.timer <= 0) {
      const lr = this.livesOf('red'), lb = this.livesOf('blue');
      this._endRound(lr > lb ? 'red' : lb > lr ? 'blue' : null);
      return;
    }
    // respawns
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
