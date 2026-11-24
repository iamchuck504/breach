import { stepDodge, dodgeCues, DODGE_PREP } from '../player/dodge.js';
// Modo VS BOTS: TDM 4v4 por rondas en el mapa Arena.
// - Rondas de 5 min; gana la ronda quien agota las vidas del rival
//   (4 iniciales + 15 respawns = 19 por equipo). Match al mejor de 3.
// - IA con estados que usa las mecánicas del juego:
//     advance  → avanza por un carril táctico y ocupa posiciones útiles
//     engage   → strafea y dispara en ráfagas manteniendo rango de su arma
//     rush     → con escopeta en corto: cierra distancia
//     hold     → conserva un ángulo/posición mientras aporta control de zona
//     cover    → corre a una cobertura que bloquee la línea de visión, se
//                agacha tras ella y se asoma a disparar por ciclos
// - FPS (corrida 6): el bot juega con las reglas del jugador en primera
//   persona. Sin rodada, voltereta ni patada de pared; velocidades de
//   TUNING.fp (correr 4.8, sprint 7.0, agachado 2.3, ADS 2.16); tras un LOW
//   se agacha escondido (`crouch`, ce 0) y se ASOMA apuntando (ce 0→1) como
//   el jugador; tras MID/HIGH sale a la orilla y se inclina (`cl`). Solo
//   emite los estados del contrato de postura (idle, run, roadie, jump,
//   crouch, melee, dead). Ve y dispara desde su OJO real (eyeWorld de su pose)
//   y solo dispara en los estados que la tabla compartida permite
//   (fire-gates.js), con el retraso sprint→disparo de cada arma.
// - Stats (kills/deaths, 100 pts por kill) para el scoreboard (Tab/VIEW).
import * as THREE from 'three';
import { botPoseAllowsOrigin, BOT_ORIGIN_LAG, mapPathBlocked } from '../../server/map-geometry.js';
import { TUNING } from '../config/tuning.js';
import { ROUND_FINISH_HOLD } from './match-flow.js';
import { Rig, RAGDOLL_R } from '../player/rig.js';
import { resolveShot, applySpread, applyPelletPattern } from '../combat/ballistics.js';
import { hitFields, hitAimHeights, placeHitPose, STAND, CROUCH, eyeWorld, HEAD_R, LEAN_MAX, POSE_BLEND_MAX } from '../combat/hit-pose.js';
import { kickWorldContact } from '../combat/kick-surface.js';
import { meleeHitOk, meleeTargetPoint } from '../combat/melee-reach.js';
import { canFireInState, MOVE_GATES, sprintFireDelay } from '../combat/fire-gates.js';
import { spreadFor } from '../combat/weapons.js';
import { trackTransition } from '../net/client.js';
import { damageFalloff } from '../combat/damage.js';
import {
  deathImpactPoint, isSniperHeadshotDeath, rocketDeathLevel,
} from '../combat/death-reactions.js';
import { t } from '../core/i18n.js';
import { groundPitchTarget } from '../player/remote.js';
import { makeSmokeProjectile, stepSmokeProjectile } from './smoke-physics.js';

const ROUND_TIME = 300;      // 5 minutos
const DEFAULT_LIVES = 15;
import { nextRespawnWave } from './respawn-wave.js';
import { decksFor, rampsFor } from '../world/collision-layouts.js';
// alturas de puntería/visibilidad del blanco según su volumen de impacto
const aimHeights = (e) => hitAimHeights(e.hitVol ?? (e.crouch ? CROUCH : STAND));

// PUESTOS ELEVADOS (mapas v2): cada plataforma con sus rampas, como ruta que
// un bot puede seguir: pie de rampa -> rellano -> puesto. Sale de las mismas
// listas que la colisión, así que un mapa nuevo con addDeck() ya los ofrece.
const PERCHES = new Map();
function perchesFor(layout) {
  if (PERCHES.has(layout)) return PERCHES.get(layout);
  const out = [];
  for (const d of decksFor(layout)) for (const side of d.mirror ? [1, -1] : [1]) {
    const deck = { x: d.x * side, z: d.z * side, w: d.w, d: d.d, h: d.h, railed: d.rails.length > 0, ramps: [] };
    for (const r of rampsFor(layout)) {
      if (r.axis !== 'z') continue; // dir = sentido en que se sube
      const joinZ = r.z + r.dir * r.d / 2;
      if (Math.abs(r.x - deck.x) > deck.w / 2 || Math.abs(joinZ - (deck.z - r.dir * deck.d / 2)) > 0.3) continue;
      deck.ramps.push({ dir: r.dir, foot: { x: r.x, z: r.z - r.dir * (r.d / 2 + 0.8) }, top: { x: r.x, z: joinZ + r.dir * 0.55 } });
    }
    if (deck.ramps.length) out.push(deck);
  }
  PERCHES.set(layout, out);
  return out;
}
// SALIDAS DEL SPAWN para mapas sin grafo de navegación. El escudo que tapa el
// spawn es un muro de 15 m justo delante de donde nace el bot: rodearlo a
// tientas costaba varios segundos por vida. Rutas en el lado rojo (el azul es
// el espejo): la salida frontal y el paso por detrás de cada caseta lateral.
const SPAWN_ROUTES = {
  azoteas: [
    [[7.35, -33.4], [7.35, -30.0]],
    [[-9.8, -38.5], [-12.4, -36.2]],
    [[9.8, -38.5], [12.4, -36.2]],
  ],
};
// Huella completa de cada plataforma (cuerpo + rampas). Para rodearla, un bot
// la trata como UN obstáculo: esquivar por separado cada escalón del relleno
// de la rampa o cada tramo de baranda encadenaba rodeos que no terminaban.
const FOOTPRINTS = new Map();
function deckFootprints(layout) {
  if (FOOTPRINTS.has(layout)) return FOOTPRINTS.get(layout);
  const out = [];
  for (const d of decksFor(layout)) for (const side of d.mirror ? [1, -1] : [1]) {
    const x = d.x * side, z = d.z * side;
    const b = { minx: x - d.w / 2, maxx: x + d.w / 2, minz: z - d.d / 2, maxz: z + d.d / 2 };
    for (const r of rampsFor(layout)) {
      const touches = r.x + r.w / 2 > b.minx - 0.3 && r.x - r.w / 2 < b.maxx + 0.3 &&
        r.z + r.d / 2 > z - d.d / 2 - 0.3 && r.z - r.d / 2 < z + d.d / 2 + 0.3;
      if (!touches) continue;
      b.minx = Math.min(b.minx, r.x - r.w / 2); b.maxx = Math.max(b.maxx, r.x + r.w / 2);
      b.minz = Math.min(b.minz, r.z - r.d / 2); b.maxz = Math.max(b.maxz, r.z + r.d / 2);
    }
    out.push(b);
  }
  FOOTPRINTS.set(layout, out);
  return out;
}
function footprintAt(world, x, z) {
  for (const b of deckFootprints(world.customMap ? world.customMap.base : world.layout)) {
    if (x > b.minx - 0.05 && x < b.maxx + 0.05 && z > b.minz - 0.05 && z < b.maxz + 0.05) return b;
  }
  return null;
}
// Presentación de vs bots: 6 s (eran 10) y saltable con cualquier tecla,
// click o botón (skipIntro). La cuenta regresiva de 3 s se mantiene: es la
// salida justa para todos y el momento en que el jugador toma el control.
export const INTRO_TIME = 6;
const COUNTDOWN_TIME = 3;
const ROUND_RESULT_TIME = 5;
const FINAL_TIME = 11;
const BOT_NAMES = { red: ['REX', 'VOLT', 'JAZZ'], blue: ['NOVA', 'DUKE', 'BLITZ', 'PIXEL'] };
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };
const BOT_DMG = TUNING.combat.botDamageScale; // los bots pegan más suave que un jugador
const TACTICAL_ROLES = ['advance', 'flank', 'hold', 'support', 'angle'];
// PERCEPCIÓN Y PUNTERÍA (una sola dificultad, "normal"). Un bot debe leerse
// como una persona competente y falible: ve hacia donde mira, reacciona en
// tiempo humano, apunta con un error que se corrige mientras sigue al blanco
// y falla más con la distancia y el movimiento.
// FPS: el humano solo ve lo que cabe en su pantalla (FOV vertical 72° ≈ 104°
// horizontal en 16:9) y oye el resto. El bot igual: cono de ~110°, sin
// periferia salvo para seguir al blanco que ya tiene o a quien le roza; lo
// que pasa fuera se OYE (disparos, carrera cerca) y le hace girarse.
const SIGHT_RANGE = 45;          // m: más lejos nadie distingue a un soldado
const FRONT_COS = Math.cos(55 * Math.PI / 180);      // cono de atención (antes 62°)
const PERIPHERY_COS = Math.cos(80 * Math.PI / 180);  // solo el blanco actual, de cerca (antes 100°, cualquiera)
const HEAR_SHOT = 30, HEAR_STEPS = 7; // m: disparos / pasos a la carrera
const SENSE_PERIOD = 0.1;        // s entre percepciones
const INTEL_TTL = 8;             // s que un avistamiento orienta los planes
const AIM = {
  start: 0.085,   // rad de error al fijar un blanco nuevo (~5°)
  known: 0.05,    // si ya lo tenía ubicado
  floor: 0.028,   // error asentado, quieto (~1.6°; antes 0.024: con el ojo a 1.48 y la dispersión del jugador mataba a 15 m en 4.4 s)
  moving: 0.018,  // extra si el bot se mueve al disparar
  settle: 0.5,    // s de corrección (constante de tiempo)
  track: 12,      // velocidad de giro siguiendo a un blanco (lag real)
};
// Reacción (s) al adquirir un blanco: sorpresa / ya ubicado (lo vio hace
// nada, lo oyó, se lo cantaron), + azar, + si entra por el borde de la vista,
// + si está lejos. Re-adquirir a quien se agachó tras un LOW o volvió a
// inclinarse cuenta como "ya ubicado" (mira su última posición) pero no es
// gratis: vuelve a pagar reacción y error de puntería.
const REACT = { surprise: 0.24, known: 0.14, jitter: 0.16, offAxis: 0.16, far: 0.08 };
// La pose que dispara debe llevar ≥ esto quieta (st/aim/ce/cl): así ha salido
// al menos en un botState (20 Hz) y el servidor la conoce (bots alojados).
const POSE_SETTLE = 1.5 / TUNING.net.sendHz;
// postura (las del jugador, TUNING.fp): ritmo de ce/cl (1/0.18 s ≈ 5.6/s, por
// debajo del límite del servidor de 6/s)
const POSTURE_RATE = 1 / TUNING.fp.crouchTime;
// Cobertura: LOW ≤ lowHeight (1.4) se asoma por encima; menos de MID_STAND
// (1.9) tapa al agachado pero no al de pie (casco 1.74–1.82): ahí se esconde
// agachado y se asoma por la orilla; desde MID_STAND tapa de pie.
const MID_STAND = 1.9;
const HIDE_EYE = 0.95;  // m: casco agachado (0.91–1.04) para validar un escondite bajo
const STAND_EYE = 1.8;  // m: casco de pie para validar un escondite alto
const STUCK_WINDOW = 0.45;   // reacción perceptiblemente inmediata, sin ruido de un frame
const STUCK_RATIO = 0.32;    // progreso real mínimo frente al movimiento solicitado
const FAILED_ROUTE_TTL = 4.5;
const BYPASS_CLEARANCE = 0.9;

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _probe = { x: 0, z: 0 };
// giros que prueba un paso local bloqueado (radianes; nunca hacia atrás)
const LOCAL_TURNS = [0, 0.55, -0.55, 1.1, -1.1];

// PRESENTACIÓN = la del jugador. El bot usa los mismos gestos y tiempos que
// controller.js/weapons.js/main.js le dan al jugador local para la misma acción.
const SWAP_TIME = 0.55;          // weapons.js: gesto de cambio; el modelo cambia a la mitad
// tope del arrastre (fracción del intervalo del BOT, que ya es 1.2-1.5× el
// del arma: 0.85 de él queda muy por encima de la puerta del servidor, 0.82
// del nominal del arma). Con 0.9, a 30 Hz la SMG de bot no pasaba de 450 RPM.
const MIN_GAP = 0.85;
const angDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
// Alcance del bote de humo (posición al estallar, suelo plano, suelta a 1,5 m)
// según el ángulo de lanzamiento, con la física real de smoke-physics.js y la
// velocidad del jugador (dir·throwSpeed + throwUp). Tabla única, perezosa.
let SMOKE_REACH = null;
function smokeReachTable() {
  if (SMOKE_REACH) return SMOKE_REACH;
  const g = TUNING.weapons.grenade, flat = { resolveCircle() {}, groundHeight: () => 0 };
  SMOKE_REACH = [];
  for (let a = -1.3; a <= 1.0001; a += 0.025) {
    const p = makeSmokeProjectile({ x: 0, y: 1.5, z: 0 },
      { x: Math.cos(a) * g.throwSpeed, y: Math.sin(a) * g.throwSpeed + g.throwUp, z: 0 });
    while (p.t < g.fuse) stepSmokeProjectile(p, 1 / 60, flat);
    SMOKE_REACH.push([a, p.x]);
  }
  return SMOKE_REACH;
}
// el ángulo más bajo que lleva el bote a `reach` metros (como apuntar al suelo)
function smokePitchFor(reach) {
  const T = smokeReachTable();
  if (reach <= T[0][1]) return T[0][0];
  for (let i = 1; i < T.length; i++) {
    if (T[i][1] >= reach) {
      const [a0, r0] = T[i - 1], [a1, r1] = T[i];
      return a0 + (a1 - a0) * (reach - r0) / Math.max(1e-6, r1 - r0);
    }
  }
  return T[T.length - 1][0];
}

const lerpYaw = (a, b, k) => {
  let d = b - a;
  d = d % (Math.PI * 2); // módulo, no while: un delta gigante colgaba el bucle
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

// Variación estable por bot/decisión. Evita que la personalidad táctica cambie
// cada frame y que la dispersión dependa de tirar una moneda continuamente.
// normal estándar (Box-Muller): el error de puntería se concentra cerca del
// blanco y de vez en cuando se va lejos, como el de una persona
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

const hash01 = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

export class Bot {
  constructor(scene, world, id, name, team, spawn, variant = null) {
    this.id = id; this.name = name; this.team = team;
    this.world = world;
    this.variant = variant == null ? (Math.random() * 5) | 0 : Math.max(0, Math.min(4, variant | 0));
    this.profile = {
      aggression: hash01(id + ':aggression'),
      patience: hash01(id + ':patience'),
      flank: hash01(id + ':flank'),
      cohesion: hash01(id + ':cohesion'),
    };
    this.rig = new Rig(scene, team, name, this.variant); // soldado random
    this.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, 0.38, y);
    // sonda de pared del rig (RIG): el arma en tercera persona no atraviesa el muro
    this.rig.wallFn = (o, d, m) => world.raycast(o, d, m, 0);
    this.rig.collideFn = (p, y, r = RAGDOLL_R) => world.resolveCircle(p, r, y);
    this.respawn(spawn);
  }

  respawn(spawn) {
    this.hostedPose = null; this.lastIncomingHitCt = -Infinity;
    this.world.navigation?.cache?.delete(this);
    this._eye = null; this._eyeAt = null; this.seen = []; this.seenD = []; this.senseT = 0; // nada percibido desde la posición anterior
    this.pos = { x: spawn.x, z: spawn.z };
    this.yaw = Number.isFinite(spawn.yaw) ? spawn.yaw : 0;
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
    this.meleeT = 0;    // gesto de golpe en curso
    this.meleeCd = 0;
    this.meleeFreezeT = 0;
    this.meleeTravel = 0;
    this.meleeEntrySpeed = 0;
    this.nadeCd = 4 + Math.random() * 5; // humo: no todos lo usan al segundo 0
    this.nades = 1;     // botes de humo por vida
    this.specialHoldT = 0; // progreso de recogida del arma especial
    this.shotCd = 0;
    this.lastDamage = 99; this.recentHit = 99; this.dazeT = 0;
    this.wep = 'smg';
    this.specialAmmo = 0; // el arma especial NO sobrevive a la muerte
    this.rig?.setWeapon?.('smg');
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
    this.perch = null; this.perchCd = 4 + Math.random() * 6; // puesto elevado en curso
    this.exitRoute = null; this.exitPending = true; this.exitT = 0; // salida del spawn
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
    this.netAnim = 'idle'; this.aim = false; this.aimPitch = 0;
    this.senseT = 0; this.seen = []; this.seenD = []; this.alert = null;
    this.aimSigma = AIM.start; this.aimEx = 0; this.aimEy = 0;
    this.ammo = { smg: TUNING.weapons.smg.mag, shotgun: TUNING.weapons.shotgun.mag }; this.reloadT = 0;
    // reserva como la del jugador (weapons.js): la recarga la consume
    this.reserve = { smg: TUNING.weapons.smg.reserve, shotgun: TUNING.weapons.shotgun.reserve };
    this.dryT ??= 0; // segundos (acumulados) sin munición en ninguna de sus dos armas
    // Tras nacer o ser movido lejos, no dispara hasta que esa pose haya salido
    // por botState (el servidor valida el origen contra poses DIFUNDIDAS):
    // dos envíos a sendHz y margen de red.
    this.fireHoldT = 2.5 / TUNING.net.sendHz; this._lastPx = null;
    this.reloadTotal = 0;
    this.coverFight = false; this.fightCoverT = 1 + Math.random();
    // presentación (lo que dibuja el rig, igual que el jugador): arma en mano
    // durante los gestos, lanzamiento en curso, cuerpo y exposición en cover
    this.shownWep = 'smg'; this._swapModel = null;
    this.throwPlan = null; this.throwT = 0;
    this.rigYaw = this.yaw; this.groundPitch = 0;
    this.coverLean = 0; this.coverExposure = 1; this.coverKind = null; this.latMove = 0;
    // postura FPS: ce = altura de cabeza (1 de pie, 0 agachado; asomo y
    // transición), cl = inclinación; want* = lo que pide la conducta este paso
    this.ce = 1; this.cl = 0; this.wantCe = 1; this.wantCl = 0;
    this.dodge = null; this.dodgePrep = null; this.dodgeCd = 0; this.simTime = 0;
    this.sinceSprint = 99; this.poseHeld = 0; this._poseSig = '';
    this.special = null;       // arma especial que lleva (aunque tenga otra en mano)
    this.lastSeen = null;      // {x, z, y, age, id}: dónde vio por última vez a su blanco
    this.peekT = 0; this.peekOut = 0;
  }

  // Pose replicada (la de hit-pose.js): la misma que viaja en botState, la
  // que dibuja el rig y de la que salen ojo y volumen.
  pose() {
    const st = this.animState();
    // pose COMPLETA, con los mismos campos que viajan en botState (sp con su
    // redondeo: el trote adelanta la cabeza, hit-pose.js runVol) y ae
    return { st, aim: !!this.aim, ce: st === 'crouch' ? this.ce : 1, cl: this.coverLean || 0,
      pitch: this.aimPitch || 0, wep: this.shownWep ?? this.wep,
      sp: +Math.min(1, Math.hypot(this.velX || 0, this.velZ || 0) / TUNING.move.roadieSpeed).toFixed(2),
      ae: this.aimYawErr || 0 };
  }

  animState() { return this.alive ? (this.netAnim || 'idle') : 'dead'; }
  // mismos nombres que Controller: la fire-pose de red (client.js) los lee
  get coverLeanAnim() { return this.coverLean; }
  get coverAimExposure() { return this.coverExposure; }

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
      const deck = footprintAt(this.world, (c.minx + c.maxx) / 2, (c.minz + c.maxz) / 2);
      if (deck) return `d:${deck.minx.toFixed(2)}:${deck.minz.toFixed(2)}`;
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
    const remembered = this.failedRoutes.find((f) => f.kind === 'goal' &&
      Math.hypot(f.x - goal.x, f.z - goal.z) < 1.2);
    if (remembered) { remembered.ttl = FAILED_ROUTE_TTL; return; }
    this.failedRoutes.push({ kind: 'goal', x: goal.x, z: goal.z, ttl: FAILED_ROUTE_TTL });
  }

  _rememberSideFailure(recovery) {
    if (!recovery) return;
    const remembered = this.failedRoutes.find((f) => f.kind === 'side' &&
      f.key === recovery.key && f.side === recovery.side);
    if (remembered) { remembered.ttl = FAILED_ROUTE_TTL; return; }
    this.failedRoutes.push({
      kind: 'side', key: recovery.key, side: recovery.side, ttl: FAILED_ROUTE_TTL,
    });
  }

  _colliderBounds(c) {
    if (!c) return null;
    if (c.minx !== undefined) {
      const deck = footprintAt(this.world, (c.minx + c.maxx) / 2, (c.minz + c.maxz) / 2);
      if (deck) return deck;
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
      // plazo del rodeo según su longitud: 3 s bastan para una caja, no para
      // dar la vuelta a una plataforma de 19 m con sus rampas
      // (solo plataformas: contra una fachada larga el punto de rodeo puede ser
      // inalcanzable y alargar el plazo dejaba al bot empujando la pared)
      budget: key.startsWith('d:') ? Math.min(9, Math.max(3, Math.hypot(best.x - this.pos.x, best.z - this.pos.z) / 3.2 + 1)) : 3,
      forwardX: fx, forwardZ: fz, perpX: px, perpZ: pz,
      targetP: best.x * px + best.z * pz,
      goalX: goal?.x ?? null, goalZ: goal?.z ?? null,
    };
    this.avoidSide = best.side;
    this._resetProgress();
    return true;
  }

  _recoverFromStuck(match, contact, requested, goal, reason = 'blocked') {
    this.lastRecoveryReason = reason;
    // Con rejilla de navegación el atasco no se arregla con un rodeo a
    // ciegas: se rehace la ruta desde donde está y, si vuelve a atascarse
    // enseguida (un cuerpo en un portal, un destino mal elegido), se cambia
    // de destino.
    const nav = this.world.navigation;
    if (nav) {
      nav.cache.delete(this);
      this.recovery = null;
      this.navStuckN = (this.navStuckT > 0 ? this.navStuckN ?? 0 : 0) + 1;
      this.navStuckT = 4;
      if (this.navStuckN >= 2 && goal) { this.navStuckN = 0; this._unreachable = goal; }
      this._resetProgress();
      return;
    }
    const previous = this.recovery;
    if (previous) this._rememberSideFailure(previous);
    this.recovery = null;
    const collider = contact?.collider || previous?.collider || null;
    const retry = previous
      ? { x: previous.forwardX, z: previous.forwardZ }
      : requested;
    if (collider && this._startObstacleRecovery(collider, retry.x, retry.z, goal, match)) return;

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
    const nav = this.world.navigation;
    if (nav && !goal) return this._localStep(dx, dz);
    if (nav && goal) {
      // persecución con línea andable directa: sin A* por cada paso del blanco
      if (goal.id !== undefined && nav.clear(this.pos, goal, this.y)) {
        const d = Math.max(0.001, Math.hypot(goal.x - this.pos.x, goal.z - this.pos.z));
        this.recovery = null;
        return this._stepOut((goal.x - this.pos.x) / d, (goal.z - this.pos.z) / d, false, false, d);
      }
      const next = nav.next(this.pos, goal, this);
      // llegó al final de una ruta que no alcanza el destino (destino dentro
      // de un volumen): antes orbitaba ese punto indefinidamente
      if (!next || nav.stranded(this, this.pos)) {
        this._unreachable = goal;
        return this._stepOut(0, 0, true, true);
      }
      const nd = Math.hypot(next.x - this.pos.x, next.z - this.pos.z);
      const d = Math.max(.001, nd);
      // la ruta ya rodea los volúmenes con holgura: un rodeo viejo no debe
      // devolver al bot contra la fachada que la ruta esquiva
      this.recovery = null;
      return this._stepOut((next.x - this.pos.x) / d, (next.z - this.pos.z) / d, false, false, d);
    }
    _v1.set(this.pos.x, this.y + 0.7, this.pos.z);
    if (this.recovery) {
      const currentP = this.pos.x * this.recovery.perpX + this.pos.z * this.recovery.perpZ;
      const lateral = this.recovery.targetP - currentP;
      // Mantener la tangente hasta quedar realmente fuera de la proyección de
      // la pared. Un look-ahead corto podía dejar de verla a mitad del rodeo y
      // volver a cortar diagonalmente contra el mismo volumen.
      if (Math.abs(lateral) > 0.42) {
        const side = Math.sign(lateral);
        let tx = this.recovery.perpX * side - this.recovery.forwardX * 0.12;
        let tz = this.recovery.perpZ * side - this.recovery.forwardZ * 0.12;
        const tl = Math.max(0.001, Math.hypot(tx, tz)); tx /= tl; tz /= tl;
        _v2.set(tx, 0, tz);
        if (this.world.raycast(_v1, _v2, 0.82) === null) {
          return { x: tx, z: tz, blocked: true, hit: null };
        }
      }
    }
    _v2.set(dx, 0, dz);
    const lowHit = this.world.raycastHit?.(_v1, _v2, 1.35);
    if (!lowHit) return { x: dx, z: dz, blocked: false, hit: null };
    // si lo alto está libre es un obstáculo saltable: _jumpIfBlocked se encarga
    _v1.y = this.y + 1.6;
    const highHit = this.world.raycastHit?.(_v1, _v2, 1.6);
    if (!highHit) return { x: dx, z: dz, blocked: false, hit: lowHit };

    const obstacle = lowHit.collider || highHit.collider;
    // No reemplazar un bypass activo por cada cara contigua de una esquina:
    // ese ping-pong reiniciaba el detector de progreso y podía durar segundos.
    if (!this.recovery) {
      this._startObstacleRecovery(obstacle, dx, dz, goal, match);
    }
    let rx = dx, rz = dz;
    if (this.recovery) {
      rx = this.recovery.x - this.pos.x; rz = this.recovery.z - this.pos.z;
      const rl = Math.max(0.001, Math.hypot(rx, rz)); rx /= rl; rz /= rl;
    }
    _v1.y = 0.7;
    // Frente a una pared ancha, rotar alrededor del vector al waypoint aún
    // puede apuntar a través del volumen. Primero prueba la tangente estable
    // del lado elegido: gana espacio lateral hasta descubrir la esquina.
    if (this.recovery) {
      const tx = -this.recovery.forwardZ * this.recovery.side;
      const tz = this.recovery.forwardX * this.recovery.side;
      for (const forwardBias of [-0.16, 0, 0.16]) {
        let nx = tx + this.recovery.forwardX * forwardBias;
        let nz = tz + this.recovery.forwardZ * forwardBias;
        const nl = Math.max(0.001, Math.hypot(nx, nz)); nx /= nl; nz /= nl;
        _v2.set(nx, 0, nz);
        if (this.world.raycast(_v1, _v2, 0.9) === null) {
          return { x: nx, z: nz, blocked: true, hit: lowHit };
        }
      }
    }
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

  // Destino inalcanzable: recordarlo como fallido y decidir otro ya.
  _dropUnreachable(match) {
    const g = this._unreachable;
    this._unreachable = null;
    this._rememberGoalFailure(g);
    this.world.navigation?.cache?.delete(this);
    this.exitRoute = null;
    if (this.state === 'cover' && this.coverPhase === 'go') {
      this.state = 'advance'; this.cover = null; this.coverFight = false;
      match.coverClaims.delete(this.id);
      this.coverCd = 1.5;
    } else if (this.perch) {
      this._perchEnd(match, 10);
    }
    this.wp = null; this.tacticalGoal = null; this.decisionT = 0; this.repathT = 0;
    match.releaseTacticalClaim(this.id);
  }

  _lookTarget() {
    const t = this.lastThreat;
    if (t && t.age > 0.3 && t.age < 3) return t;
    // a quien perdió de vista (se agachó, se apartó de la orilla): su última
    // posición vista, no la real
    const s = this.lastSeen;
    if (s && s.age < 3) return s;
    const a = this.alert;
    if (a && a.age > 0.25 && a.age < 2.5) return a;
    return null;
  }

  // Recarga cuando le falta munición y no hay a quién disparar.
  _maybeReload(frac) {
    const def = TUNING.weapons[this.wep];
    const n = this.ammo[this.wep];
    if (n === undefined || this.reloadT > 0 || n >= def.mag * frac) return;
    this._startReload();
  }

  // Recarga con las reglas del jugador (weapons.js): sin reserva no hay
  // recarga; cargador entero al terminar reloadTime, o la escopeta cartucho a
  // cartucho (reloadTime CADA UNO: 8 vacíos = 3,68 s, antes 2,4 s gratis).
  _startReload() {
    const def = TUNING.weapons[this.wep];
    const n = this.ammo[this.wep];
    if (n === undefined || n >= def.mag || !(this.reserve[this.wep] > 0)) return;
    this.reloadT = def.reloadTime;
    this.reloadTotal = def.reloadTime;
  }

  // Avance de la recarga (por paso): la munición sale de la reserva.
  _reloadStep(dt) {
    if (this.reloadT <= 0) return;
    const def = TUNING.weapons[this.wep], k = this.wep;
    if (this.ammo[k] === undefined) { this.reloadT = 0; return; }
    this.reloadT -= dt;
    if (def.perShell) {
      while (this.reloadT <= 0 && this.ammo[k] < def.mag && this.reserve[k] > 0) {
        this.ammo[k]++; this.reserve[k]--;
        if (this.ammo[k] < def.mag && this.reserve[k] > 0) this.reloadT += def.reloadTime;
        else this.reloadT = 0;
      }
      if (this.reloadT < 0) this.reloadT = 0;
    } else if (this.reloadT <= 0) {
      const take = Math.min(def.mag - this.ammo[k], this.reserve[k]);
      this.ammo[k] += take; this.reserve[k] -= take; this.reloadT = 0;
    }
  }

  // ¿Le queda algo que disparar a esta arma (cargador o reserva)?
  _hasAmmo(wep) {
    if (TUNING.weapons[wep]?.special) return this.specialAmmo > 0;
    return (this.ammo[wep] ?? 0) + (this.reserve[wep] ?? 0) > 0;
  }

  // Progreso de la recarga como el del jugador (main.js: 1 − st.reload /
  // reloadTime): la escopeta repite el ciclo por cartucho.
  _reloadPhase() {
    if (this.reloadT <= 0) return 0;
    const def = TUNING.weapons[this.wep];
    return Math.max(0, Math.min(1, 1 - this.reloadT / Math.max(1e-3, def.reloadTime)));
  }

  // Gesto de cambio de arma del jugador: dura SWAP_TIME y el modelo se cambia
  // a la mitad (antes el bot cambiaba el modelo al instante y podía disparar
  // el arma nueva durante el gesto).
  _beginSwap(model) {
    this.swapAnim = SWAP_TIME;
    this._swapModel = model;
  }

  // Cadencia con arrastre, como weapons.js: lo que el arma lleva lista
  // dentro de este paso (y lo que el tope MIN_GAP dejó pendiente) adelanta el
  // siguiente tiro; así la media es la configurada a cualquier fps (antes se
  // tiraba el sobrante: la SMG de bot daba 450 RPM a 30 Hz en vez de 517).
  // Ningún intervalo baja de MIN_GAP del nominal. Esperar con el arma lista
  // (pausa, sin blanco) rompe la cadena y no acumula crédito.
  _rearm(interval) {
    const ready = -this.shotCd;
    const chained = ready > 0 && ready < (this._stepDt ?? 0);
    const late = chained ? ready + (this._cdCarry ?? 0) : 0;
    const use = Math.min(late, interval * (1 - MIN_GAP));
    this._cdCarry = Math.min(interval * 0.5, late - use);
    this.shotCd = interval - use;
  }


  // Resultado de _steer sin crear objetos por paso.
  // reach: distancia al punto final del tramo (no pasarse de él en un paso:
  // el sobrepaso y la vuelta eran el temblor sobre los destinos)
  _stepOut(x, z, blocked, none = false, reach = Infinity) {
    const o = this._steerOut ??= { x: 0, z: 0, blocked: false, hit: null, stairsRoute: true, none: false, reach: Infinity };
    o.x = x; o.z = z; o.blocked = blocked; o.hit = null; o.stairsRoute = true; o.none = none; o.reach = reach;
    return o;
  }

  // Paso LOCAL (strafe, asomarse, separarse): se sondea con la misma rejilla
  // que las rutas (cuerpo entero, mismo piso). Si el sentido pedido choca, se
  // prueba girado; si no hay ninguno, se queda quieto en vez de empujar.
  _localStep(dx, dz) {
    const nav = this.world.navigation, q = _probe;
    for (let i = 0; i < LOCAL_TURNS.length; i++) {
      const a = LOCAL_TURNS[i], c = Math.cos(a), s = Math.sin(a);
      const x = dx * c - dz * s, z = dx * s + dz * c;
      q.x = this.pos.x + x * 0.45; q.z = this.pos.z + z * 0.45;
      if (!nav.standable(q, this.y)) continue;
      q.x = this.pos.x + x * 0.9; q.z = this.pos.z + z * 0.9;
      if (!nav.standable(q, this.y)) continue;
      return this._stepOut(x, z, i > 0);
    }
    return this._stepOut(0, 0, true, true);
  }

  _face(tx, tz, dt, rate = 8) {
    this.yaw = lerpYaw(this.yaw, Math.atan2(-tx, -tz), 1 - Math.exp(-rate * dt));
  }

  // Arma según la distancia, como un jugador: escopeta de cerca, SMG a media.
  // Con la especial: el francotirador se guarda a menos de 9 m (y vuelve a
  // sacarse pasados 14), la bazooka a menos de 8 (vuelve pasados 12; nunca
  // un cohete a bocajarro). Histéresis para no alternar en el borde.
  _pickWeapon(dist) {
    const sp = this.special && this.specialAmmo > 0 ? this.special : null;
    if (sp) {
      const close = sp === 'sniper' ? 9 : 8, far = sp === 'sniper' ? 14 : 12;
      if (this.wep === sp) {
        if (dist < close) this._trySwap(dist < 7 && this._hasAmmo('shotgun') ? 'shotgun' : 'smg', true);
        return;
      }
      if (dist > far) { this._trySwap(sp, true); return; }
    }
    if (dist < 8 || (this.aggro > 0.55 && dist < 14 && this.hp > 60)) this._trySwap('shotgun');
    else if (dist > 15) this._trySwap('smg');
  }

  _trySwap(want, bands = false) {
    // como el jugador: durante la patada el arma está ocupada y no se cambia
    if (this.wep === want || this.swapCd > 0 || this.meleeT > 0) return;
    // el arma ESPECIAL no se guarda por preferencia de distancia (sí por sus
    // bandas, _pickWeapon): se usa hasta agotarla y entonces vuelve sola a la primaria
    if (!bands && TUNING.weapons[this.wep]?.special && this.specialAmmo > 0) return;
    if (this.throwPlan) return; // con el bote en la mano no se cambia de arma
    if (!this._hasAmmo(want)) return; // a un arma vacía no se cambia
    this.wep = want;
    this.reloadT = 0; // cambiar de arma interrumpe la recarga
    this.swapCd = bands ? 1.2 : 2.5;
    this._beginSwap(want);
  }

  // Lanzamiento de humo con la secuencia del jugador: sacar el bote (gesto de
  // cambio), gesto de lanzamiento con la suelta en throwRelease (el bote sale
  // de la mano tras actualizar el rig: BotMatch.botReleaseSmoke) y guardar.
  _stepThrow(dt) {
    const p = this.throwPlan;
    if (!p) return;
    const g = TUNING.weapons.grenade;
    if (p.phase === 'draw') {
      if (this.swapAnim > 0) return;
      p.phase = 'throw'; p.pending = true; this.throwT = g.throwTime;
      return;
    }
    if (p.phase === 'throw') {
      this.throwT = Math.max(0, this.throwT - dt);
      if (p.pending && this.throwT <= g.throwTime - g.throwRelease) p.release = true;
      if (this.throwT <= 0 && !p.pending) { p.phase = 'stow'; this._beginSwap(this.wep); }
      return;
    }
    if (this.swapAnim <= 0) this.throwPlan = null; // stow terminado
  }

  // Salto simple, el del jugador (sin voltereta: retirada en FPS). Solo lo
  // usa el paso de obstáculos bajos sin rejilla de navegación.
  _jump() {
    if (!this.grounded || this.jumpCd > 0) return;
    this.vy = 6.2; // mismo apex que el jugador: pasa bloques LOW (1.1)
    this.grounded = false;
    this.jumpCd = 1.2;
  }

  // ¿hay un obstáculo BAJO justo en el camino? → saltarlo
  // Ir por el arma ESPECIAL del pedestal (sniper o bazooka). La bazooka solo
  // se dispara con línea limpia, lejos y sin compañeros en el radio
  // (rocketPathClear), así que en manos de la IA ya no es un peligro propio.
  _seekSpecial(dt, match, enemy, dist) {
    const specials = match.cb.specials;
    const a = specials?.active;
    // el pedestal está en el CENTRO: si todos van por él, la escuadra se
    // amontona ahí. Solo UN bot por equipo lo reclama; el resto sigue su
    // plan táctico normal.
    const release = () => {
      this.specialHoldT = 0;
      if (match.specialSeeker[this.team] === this.id) match.specialSeeker[this.team] = null;
      return false;
    };
    if (!a) return release();
    if (TUNING.weapons[this.wep]?.special || this.hp < 45) return release();
    // con un enemigo encima, pelear manda sobre ir por el arma
    if (enemy && dist < 9) return release();
    const d = Math.hypot(a.x - this.pos.x, a.z - this.pos.z);
    if (d > 16) return release();
    const seeker = match.specialSeeker[this.team];
    if (seeker && seeker !== this.id) { this.specialHoldT = 0; return false; }
    match.specialSeeker[this.team] = this.id;
    if (d < 1.5 && Math.abs(this.y - a.y) < 1.2) {
      this.specialHoldT += dt;
      this.state = 'hold';
      this.tacticalGoal = { x: a.x, z: a.z, role: 'special' };
      if (this.specialHoldT >= 0.6) {
        this.specialHoldT = 0;
        match.botTakeSpecial(this);
      }
      return true;
    }
    this.specialHoldT = 0;
    this.state = 'advance';
    this.tacticalGoal = { x: a.x, z: a.z, role: 'special' };
    this.wp = this.tacticalGoal;
    this.commitMove = true;
    this.decisionT = 0.4;
    return true;
  }

  // PUESTO ELEVADO: subir a una plataforma por su rampa, vigilar desde arriba
  // y bajar. Mientras está en la rampa o arriba manda sobre el resto de
  // decisiones: la baranda y el borde no se negocian con el steering normal,
  // se entra y se sale por la rampa.
  _perchEnd(match, cooldown) {
    match.releasePerch(this);
    this.perch = null; this.perchCd = cooldown;
    this.wp = null; this.state = 'advance'; this.roleT = 0; this.decisionT = 0;
    return false;
  }

  _perch(dt, match, enemy, dist, wantsSafety) {
    this.perchCd = Math.max(0, this.perchCd - dt);
    let p = this.perch;
    if (!p) {
      if (this.perchCd > 0 || this.state === 'cover' || wantsSafety || this.hp < 70 || !this.grounded ||
          (enemy && dist < 12) || (this.role !== 'hold' && this.role !== 'angle' && this.role !== 'support')) return false;
      p = match.claimPerch(this);
      if (!p) { this.perchCd = 3; return false; }
      this.perch = p; this.cover = null;
    }
    p.t += dt;
    const near = (q, r) => Math.hypot(q.x - this.pos.x, q.z - this.pos.z) < r;
    const descend = (exit) => { p.phase = 'down'; p.exit = exit; p.step = 0; p.t = 0; };
    if (p.phase === 'approach') {
      if (wantsSafety || (enemy && dist < 7) || p.t > 16) return this._perchEnd(match, 8);
      if (near(p.entry.foot, 0.7)) { p.phase = 'up'; p.step = 0; p.t = 0; }
    } else if (p.phase === 'up') {
      if (near(p.step === 0 ? p.entry.top : p.spot, 0.45)) {
        if (p.step === 0) { p.step = 1; p.t = 0; } else { p.phase = 'hold'; p.t = 0; p.quiet = 0; }
      } else if (p.t > 5) {
        // no llegó: si sigue en el suelo se abandona; si quedó arriba, baja
        if (this.y < 0.3) return this._perchEnd(match, 10);
        descend(p.entry);
      }
    } else if (p.phase === 'hold') {
      if (this.y < p.deck.h - 0.4) return this._perchEnd(match, 12); // lo tiraron de la plataforma
      p.quiet = enemy ? 0 : p.quiet + dt;
      if (wantsSafety) descend(p.entry);
      else if (p.t > p.holdFor || p.quiet > 6) descend(p.advance);
    } else {
      if (this.y < 0.05 && p.step === 1 && near(p.exit.foot, 1.6)) return this._perchEnd(match, 18 + Math.random() * 14);
      if (near(p.step === 0 ? p.exit.top : p.exit.foot, 0.5)) {
        if (p.step === 0) { p.step = 1; p.t = 0; } else return this._perchEnd(match, 18 + Math.random() * 14);
      } else if (p.t > 6) return this._perchEnd(match, 20);
    }
    this.state = 'perch';
    return true;
  }

  // Colisión de CUERPOS: nadie atraviesa a nadie (aliados y enemigos, bots y
  // humanos). Corrección posicional SUAVE: la mitad del solape por paso con
  // tope de 3 m/s — sin empujones violentos ni atrapamientos permanentes.
  _bodyCollide(match, dt) {
    if (!this.alive) return;
    const R = 0.72;
    const maxPush = 3 * dt;
    let pushed = false;
    const solve = (ox, oz, oy) => {
      if (Math.abs((oy ?? 0) - this.y) > 1.4) return;
      const dx = this.pos.x - ox, dz = this.pos.z - oz;
      const d = Math.hypot(dx, dz);
      if (d >= R || d < 0.001) return;
      const push = Math.min((R - d) * 0.5, maxPush);
      this.pos.x += (dx / d) * push;
      this.pos.z += (dz / d) * push;
      pushed = true;
    };
    for (const o of match.bots) {
      if (o !== this && o.alive) solve(o.pos.x, o.pos.z, o.y);
    }
    const p = match.cb.player?.();
    if (p?.alive) solve(p.x, p.z, p.y);
    for (const h of match.cb.humans?.() ?? []) {
      if (h.alive) solve(h.x, h.z, h.y);
    }
    // el empuje no puede meter al bot en una pared
    if (pushed) this.world.resolveCircle(this.pos, 0.38, this.y);
  }

  _jumpIfBlocked(mx, mz) {
    if (!this.grounded || this.jumpCd > 0) return;
    _v1.set(this.pos.x, this.y + 0.5, this.pos.z);
    _v2.set(mx, 0, mz).normalize();
    const tLow = this.world.raycast(_v1, _v2, 1.3);
    if (tLow === null) return;
    _v1.y = this.y + 1.6;
    const tHigh = this.world.raycast(_v1, _v2, 2.2);
    if (tHigh === null) this._jump(); // bajo bloqueado, alto libre → brincable
  }

  _stepDodge(dt, match) {
    if (!this.dodgePrep && !this.dodge && this.recentHit < 0.25 && this.dodgeCd <= 0 && this.grounded &&
        MOVE_GATES.dodge.entry.includes(this.netAnim) && this.ce >= 0.995 &&
        this.poseHeld >= 2 / TUNING.net.sendHz && !this.perch && !this.cover && !this.throwPlan && this.throwT <= 0 &&
        this.dazeT <= 0 && this.meleeT <= 0 && Math.random() < 1 - Math.exp(-2.5 * dt)) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this.dodgePrep = { wait: DODGE_PREP, t: 0, x: side * Math.cos(this.yaw), z: -side * Math.sin(this.yaw) };
    }
    if (this.dazeT > 0) this.dodgePrep = null;
    if (this.dodgePrep) {
      const prep = this.dodgePrep;
      if (prep.wait > 1e-8) {
        prep.wait -= dt;
        const params = this._rigParams(this.netAnim, dt);
        params.dodgeBrace = Math.min(1, 1 - prep.wait / DODGE_PREP);
        this.rig.update(dt, params);
        return true;
      }
      this.dodge = prep; this.dodgePrep = null;
      this.dodgeCd = TUNING.dodge.duration + TUNING.dodge.cooldown;
    }
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    if (!this.dodge) return false;
    const x = this.pos.x, z = this.pos.z;
    const done = stepDodge(this, this.dodge, dt, 0.38);
    this._bodyCollide(match, dt);
    this.velX = (this.pos.x - x) / dt; this.velZ = (this.pos.z - z) / dt;
    this.speed = Math.hypot(this.velX, this.velZ);
    this.sinceSprint = this.poseHeld = this.burstT = this.muzzleT = 0;
    this.aim = false; this.cl = this.coverLean = 0;
    this.netAnim = done ? 'idle' : 'dodge';
    if (done) this.velX = this.velZ = this.speed = 0;
    this._lastPx = this._fx = this.pos.x; this._lastPz = this._fz = this.pos.z;
    this.rigYaw = this.yaw;
    this.rig.setTransform(this.pos.x, this.pos.z, this.yaw, this.y);
    const params = this._rigParams(this.netAnim, dt);
    const pose = match._botPose(this);
    params.interpolated = true; params.poseTr = pose.from ? pose : null;
    params.evadePhase = this.dodge.t / TUNING.dodge.duration;
    this.rig.update(dt, params);
    const d = this.dodge;
    dodgeCues(d, d.t, this.pos.x, this.y, this.pos.z, d.x, d.z, this.team, match.cb.onDodgeCue, done);
    if (done) this.dodge = null;
    return true;
  }

  update(dt, match) {
    if (!this.alive) {
      this.rig.update(dt, { state: 'dead', speed: 0, aim: false, aimPitch: 0 });
      return;
    }
    this.simTime += dt;
    if(this.protoStunned){
      this.dodgePrep = null;
      if (this.dodge) { this.dodge = null; this.netAnim = 'idle'; }
      if (this.meleeT > 0) { this.meleeT = this.meleeFreezeT = 0; this.netAnim = 'idle'; }
      const floor=this.world.groundHeight(this.pos,.38,this.y);
      if(this.y>floor+.01){this.vy-=TUNING.jump.gravity*dt;this.y=Math.max(floor,this.y+Math.min(0,this.vy)*dt);}else{this.y=floor;this.vy=0;this.grounded=true;}
      this.rig.stunned=true;this.muzzleT=0;this.burstT=0;this.protT=Math.max(0,this.protT-dt);
      this.rig.setTransform(this.pos.x,this.pos.z,this.rigYaw??this.yaw,this.y);
      // aturdido: conserva la postura que traía (agachado tras el LOW sigue agachado)
      this.rig.update(dt,{state:this.animState()==='crouch'?'crouch':'idle',speed:0,aim:false,coverAimExposure:this.ce,coverLean:0});
      return;
    }
    this.lastDamage += dt; this.recentHit += dt;
    if (this.lastThreat && (this.lastThreat.age += dt) > 4) this.lastThreat = null;
    this.senseT -= dt;
    if (this.alert && (this.alert.age += dt) > 4) this.alert = null;
    this.fightCoverT = Math.max(0, this.fightCoverT - dt);
    this.navStuckT = Math.max(0, (this.navStuckT ?? 0) - dt);
    // la puntería se asienta mientras sigue al mismo blanco
    this.aimSigma = AIM.floor + (this.aimSigma - AIM.floor) * Math.exp(-dt / AIM.settle);
    this._reloadStep(dt);
    // sin munición en ninguna arma: maniobra y patea, pero no dispara
    if (!this._hasAmmo('smg') && !this._hasAmmo('shotgun') && !TUNING.weapons[this.wep]?.special) this.dryT += dt;
    this.protT = Math.max(0, this.protT - dt);
    this.swapCd = Math.max(0, this.swapCd - dt);
    this.swapAnim = Math.max(0, this.swapAnim - dt);
    if (this._swapModel && this.swapAnim <= SWAP_TIME / 2) {
      this.shownWep = this._swapModel; this._swapModel = null;
      this.rig.setWeapon(this.shownWep);
    }
    this._stepDt = dt;
    if (this._lastPx != null && Math.hypot(this.pos.x - this._lastPx, this.pos.z - this._lastPz) > 1.2) {
      this.fireHoldT = 2.5 / TUNING.net.sendHz; // movido lejos entre pasos (teletransporte)
    }
    this.fireHoldT = Math.max(0, (this.fireHoldT ?? 0) - dt);
    this._stepThrow(dt);
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    this.nadeCd = Math.max(0, this.nadeCd - dt);
    this.jumpCd = Math.max(0, this.jumpCd - dt);
    this.coverCd = Math.max(0, this.coverCd - dt);
    this.roleT = Math.max(0, this.roleT - dt);
    // aturdido por una patada: ni dispara, ni golpea, ni lanza
    this.dazeImmuneT = Math.max(0, (this.dazeImmuneT ?? 0) - dt);
    this.dazeT = Math.max(0, (this.dazeT ?? 0) - dt);
    if (this.dazeT > 0) {
      this.burstT = 0; this.pauseT = Math.max(this.pauseT, 0.08);
      this.meleeCd = Math.max(this.meleeCd, 0.08); this.nadeCd = Math.max(this.nadeCd, 0.08);
    }
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

    if (this._stepDodge(dt, match)) return;
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
      if (eid) {
        // reacción humana: 0.25-0.4 s ante una sorpresa, menos si ya lo
        // esperaba; más si entra por el rabillo del ojo o está lejos
        const known = this.expectBy?.get(enemy.id) ?? match._expected(this, enemy);
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const off = (enemy.x - this.pos.x) * fx + (enemy.z - this.pos.z) * fz < 0.64 * dist;
        this.reactT = (known ? REACT.known : REACT.surprise) + Math.random() * REACT.jitter +
          (off ? REACT.offAxis : 0) + (dist > 25 ? REACT.far : 0);
        this.aimSigma = Math.max(this.aimSigma, known ? AIM.known : AIM.start);
      }
    }
    this.reactT = Math.max(0, (this.reactT ?? 0) - dt);
    // Última posición VISTA del blanco: si se agacha tras un LOW o se aparta
    // de la orilla, el bot mira (y apunta) ahí, no a donde está de verdad.
    if (enemy) {
      const ls = this.lastSeen ??= { x: 0, z: 0, y: 0, age: 0, id: null };
      ls.x = enemy.x; ls.z = enemy.z; ls.y = enemy.y ?? 0; ls.age = 0; ls.id = enemy.id;
    } else if (this.lastSeen && (this.lastSeen.age += dt) > 4) this.lastSeen = null;

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
    // HUMO defensivo: al romper contacto herido y con la amenaza a media
    // distancia, cortar la línea de tiro vale más que correr expuesto. El
    // bote es el mismo del jugador (también le tapa a él la visión).
    if (wantsSafety && threatRef && this.nadeCd <= 0 && this.nades > 0 &&
        this.grounded && this.meleeT <= 0) {
      const td = Math.hypot(threatRef.x - this.pos.x, threatRef.z - this.pos.z);
      if (td > 4 && td < 26) match.botThrowSmoke(this, threatRef);
    }

    const perching = this._perch(dt, match, enemy, dist, wantsSafety);
    // COBERTURA: retirarse herido, o pelear desde un bloque cercano cuando
    // le disparan, recarga o lleva un rato tiroteándose al descubierto. La
    // búsqueda recorre todas las caras del mapa: como mucho cada 0.5-1.5 s
    // (antes se repetía en cada paso mientras no encontraba nada).
    let spot = null, fight = false;
    if (!perching && this.state !== 'cover' && this.coverCd <= 0 && threatRef && this.fightCoverT <= 0) {
      if (wantsSafety) {
        spot = match.findCoverSpot(this, threatRef, { retreat: true, threats: match.threatsFor(this, threatRef) });
        this.fightCoverT = 0.5;
      } else if (enemy && dist > 7 && dist < 34 && this.wep !== 'shotgun' && this.wep !== 'bazooka' &&
          (this.recentHit < 1.5 || this.reloadT > 0 || (this.state === 'engage' && this.profile.patience > 0.3))) {
        spot = match.findCoverSpot(this, enemy, { retreat: false, maxD: 6.5, threats: match.threatsFor(this, enemy) });
        fight = !!spot;
        this.fightCoverT = spot ? 0 : 1.5;
      }
    }
    if (perching) {
      // el puesto elevado manda: ver _perch
    } else if (spot) {
      this.cover = spot; this.state = 'cover'; this.coverFight = fight; this.coverQuiet = 0; this.coverSwaps = 0;
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
      // pelea desde cobertura: se queda mientras haya contacto y la deja
      // cuando el frente se calla (o si se le echan encima)
      const contact = !!enemy || (!!this.lastThreat && this.lastThreat.age < 2.5);
      this.coverQuiet = contact ? 0 : (this.coverQuiet ?? 0) + dt;
      const done = this.coverFight
        ? this.coverQuiet > 2.5 || this.coverT > 14 || (!!enemy && dist < 5)
        : this.hp > 90 || this.coverT > 6.5;
      if (done) {
        this.coverCd = this.coverFight ? 3 + Math.random() * 3 : 6 + Math.random() * 5;
        this.state = 'advance'; this.cover = null; this.coverFight = false;
        match.coverClaims.delete(this.id);
        this.decisionT = 0;
      }
    } else if (this._seekSpecial(dt, match, enemy, dist)) {
      // yendo por el arma especial del pedestal (tiene prioridad sobre el
      // plan táctico mientras dure y no haya un enemigo encima)
    } else {
      // "llegó" con histéresis: a 1.15 m cuenta como llegado y deja de contar
      // solo pasados 2.5 m. Con un umbral único, un destino pegado a una
      // pared alternaba avanzar/pelear en cada paso (temblor en el sitio).
      const gd = this.tacticalGoal ? Math.hypot(this.tacticalGoal.x - this.pos.x, this.tacticalGoal.z - this.pos.z) : Infinity;
      if (this.reachedGoal !== this.tacticalGoal) this.reachedGoal = gd < 1.15 ? this.tacticalGoal : null;
      else if (gd > 2.5) this.reachedGoal = null;
      const reached = !!this.tacticalGoal && this.reachedGoal === this.tacticalGoal;
      const defending = this.role === 'hold' && reached && this.roleT > 0;
      // al llegar a su destino se queda vigilando hasta la siguiente decisión
      // (antes elegía al instante otra cara del MISMO bloque y daba vueltas)
      if (this.roleT <= 0 || !this.tacticalGoal || (!defending && this.decisionT <= 0)) {
        match.refreshTacticalPlan(this, enemy);
      }

      const reposition = !!this.tacticalGoal && this.commitMove &&
        (!enemy || dist > 5.5) && !reached;
      if (enemy && !reposition) {
        // arma según distancia (bandas de la especial incluidas)
        this._pickWeapon(dist);
        this.state = this.wep === 'shotgun' && dist > 4.5 ? 'rush' :
          this.role === 'hold' && reached ? 'hold' : 'engage';
      } else if (reached) {
        this.state = 'hold';
      } else {
        this.state = 'advance';
      }
    }
    // FPS: sin saltos de esquiva ni volteretas bajo fuego (retirados también
    // para el jugador); la respuesta al fuego es la cobertura y el strafe.
    this.wantCe = 1; this.wantCl = 0; this._sprintWish = false;

    // ---- comportamiento por estado ----
    let mx = 0, mz = 0, aiming = false, animOverride = null;
    // sin nadie a la vista: mirar hacia donde le dispararon u oyó algo
    // (pasado un tiempo de reacción), no hacia donde camina
    const look = enemy ? null : this._lookTarget();
    // destino de VIAJE (ruta por la rejilla) o null = movimiento local (strafe,
    // asomarse): la ruta de navegación no debe sustituir a un paso lateral
    let travel = null;

    // MELEE: a bocajarro el disparo pierde sentido y el golpe es más rápido
    // que reposicionarse. Corta cualquier otro comportamiento mientras dura.
    if (this.meleeT > 0) {
      const ml = TUNING.melee;
      if (this.meleeFreezeT > 0) this.meleeFreezeT = Math.max(0, this.meleeFreezeT - dt);
      else { this.meleeT -= dt; this.meleeEl = (this.meleeEl ?? 0) + dt; }
      if (!this._meleeHit && this.meleeT <= ml.time - ml.hitAt) {
        this._meleeHit = true;
        const result = match.botMelee(this);
        if (result.connected) {
          this.meleeFreezeT = ml.hitStop;
          this.meleeT = Math.min(this.meleeT,
            result.killed ? ml.killRecovery : ml.hitRecovery);
        }
      }
      const f = this.facing ? this.facing() : { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
      const elapsed = ml.time - this.meleeT;
      const wind = Math.max(0, 1 - elapsed / Math.max(0.001, ml.hitAt));
      const runFactor = Math.min(1, this.meleeEntrySpeed / TUNING.move.roadieSpeed);
      let push = (ml.lungeSpeed + runFactor * ml.runLungeBonus) * wind;
      const remaining = Math.max(0, ml.maxLunge - this.meleeTravel);
      push = Math.min(push, remaining / Math.max(dt, 1e-4));
      this.meleeTravel += push * dt;
      this.pos.x += f.x * push * dt;
      this.pos.z += f.z * push * dt;
      this.world.resolveCircle(this.pos, 0.38, this.y);
      this._bodyCollide(match, dt);
      this.speed = push;
      animOverride = 'melee';
      if (this.meleeT <= 0) { this.meleeT = 0; this._meleeHit = false; }
    } else if (enemy && dist < TUNING.melee.range * 0.9 && this.meleeCd <= 0 && this.swapAnim <= 0 &&
               this.grounded && this.state !== 'cover' && !this.throwPlan && match.canBotMelee(this, enemy)) {
      // como el jugador (main.js): no se patea a mitad de un cambio de arma
      match.cb.audio?.meleeSwing?.({ position: { x: this.pos.x, y: this.y + 1, z: this.pos.z } });
      this.meleeT = TUNING.melee.time;
      this.meleeCd = TUNING.melee.botCooldownMin +
        Math.random() * (TUNING.melee.botCooldownMax - TUNING.melee.botCooldownMin);
      this.meleeFreezeT = 0;
      this.meleeTravel = 0;
      this.meleeEl = 0;
      this.meleeEntrySpeed = this.speed;
      this._meleeHit = false;
      this._face(enemy.x - this.pos.x, enemy.z - this.pos.z, dt, 14);
      animOverride = 'melee';
    }

    // Preparar el pitch ANTES de cualquier _fireAt de este frame. Antes se
    // actualizaba después del disparo, por lo que el primer tracer a un blanco
    // nuevo podía subir/bajar mientras el cañón aún se veía horizontal.
    const intendsAim = this.meleeT <= 0 && !!enemy && (
      this.state === 'engage' || this.state === 'hold' ||
      (this.state === 'rush' && dist < 12) ||
      (this.state === 'cover' && this.coverPhase === 'peek')
    );
    // desde el OJO de la pose actual al pecho del blanco; sin blanco, a la
    // altura de cabeza de donde lo vio por última vez (preapuntar la esquina)
    const eyeY = this._eye ? this._eye[1] : this.y + 1.48;
    const ls = !enemy && this.lastSeen && this.lastSeen.age < 3 ? this.lastSeen : null;
    const desiredAimPitch = intendsAim
      ? Math.atan2((enemy.cy ?? (enemy.y ?? 0) + 1.1) - eyeY,
        Math.max(0.01, Math.hypot(enemy.x - this.pos.x, enemy.z - this.pos.z)))
      : ls ? Math.atan2(ls.y + 1.3 - eyeY, Math.max(1, Math.hypot(ls.x - this.pos.x, ls.z - this.pos.z))) : 0;
    this.aimPitch += (desiredAimPitch - this.aimPitch) * (1 - Math.exp(-12 * dt));

    if (this.meleeT > 0) {
      // el golpe manda: saltar el resto de estados este frame
    } else if (this.state === 'engage' && enemy) {
      // como el jugador: ADS a media/larga distancia (y siempre con la
      // especial, que sin mira no acierta), desde la cadera de cerca
      aiming = dist > 8 || !!TUNING.weapons[this.wep]?.special;
      const ex = (enemy.x - this.pos.x) / dist, ez = (enemy.z - this.pos.z) / dist;
      this._face(ex, ez, dt, AIM.track);
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeDir *= -1; this.strafeT = 0.8 + Math.random() * 1.4; }
      // distancia de trabajo por arma: el francotirador y la bazooka la abren
      const ideal = { smg: 12, shotgun: 6, sniper: 24, bazooka: 16 }[this.wep] ?? 12;
      const push = dist > ideal + 3 ? 0.7 : dist < ideal - 3 ? -0.7 : 0;
      // con la mira del francotirador se planta (moverse le abre el error)
      const strafe = this.wep === 'sniper' ? 0 : 0.75;
      mx = -ez * this.strafeDir * strafe + ex * push;
      mz = ex * this.strafeDir * strafe + ez * push;
      this._fireAt(dt, match, enemy, dist);
    } else if (this.state === 'rush' && enemy) {
      // escopeta: cerrar distancia a la carrera (sprint mientras está lejos:
      // sin disparar, como el jugador) y tirar desde la cadera al llegar
      aiming = false;
      const ex = (enemy.x - this.pos.x) / dist, ez = (enemy.z - this.pos.z) / dist;
      this._face(ex, ez, dt, AIM.track);
      mx = ex + -ez * this.strafeDir * 0.35;
      mz = ez + ex * this.strafeDir * 0.35;
      travel = enemy;
      if (dist > 12 && this.hp > 60) this._sprintWish = true;
      else if (dist < 9) this._fireAt(dt, match, enemy, dist);
    } else if (this.state === 'perch' && this.perch) {
      const p = this.perch;
      const target = p.phase === 'approach' ? p.entry.foot
        : p.phase === 'up' ? (p.step === 0 ? p.entry.top : p.spot)
        : p.phase === 'down' ? (p.step === 0 ? p.exit.top : p.exit.foot) : p.spot;
      this.wp = target;
      const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > (p.phase === 'hold' ? 0.5 : 0.12)) { mx = dx / d; mz = dz / d; }
      if (p.phase === 'approach') travel = target;
      if (enemy && (p.phase === 'hold' || dist < 16)) {
        aiming = true;
        this._face(enemy.x - this.pos.x, enemy.z - this.pos.z, dt, AIM.track);
        this._fireAt(dt, match, enemy, dist);
      } else if (p.phase === 'hold' && look) {
        this._face(look.x - this.pos.x, look.z - this.pos.z, dt, 6);
      } else if (p.phase === 'hold') {
        // vigila hacia el centro del mapa y el campo rival
        this._face(-Math.sign(p.deck.x) * 0.6, this.team === 'red' ? 1 : -1, dt, 3);
      } else if (mx || mz) this._face(mx, mz, dt, 7);
    } else if (this.state === 'hold') {
      // Una defensa es temporal: vigila el frente y pelea desde el ángulo que
      // eligió, pero el temporizador de rol terminará forzando otra decisión.
      if (enemy) {
        aiming = true;
        this._face(enemy.x - this.pos.x, enemy.z - this.pos.z, dt, AIM.track);
        this._fireAt(dt, match, enemy, dist);
      } else if (look) {
        this._face(look.x - this.pos.x, look.z - this.pos.z, dt, 6);
      } else {
        // vigilar por donde el equipo sabe que hay alguien; si no, hacia el
        // centro del campo rival (no recto contra lo que tenga delante)
        const kt = match.knownThreat(this);
        if (kt) this._face(kt.x - this.pos.x, kt.z - this.pos.z, dt, 3);
        else this._face(-this.pos.x * 0.35, this.team === 'red' ? 10 : -10, dt, 3);
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
        // revalidar en ruta, pero sin cambiar de escondite una y otra vez:
        // dos amenazas que se mueven hacían rebotar al bot entre dos bloques
        if (this.coverCheckT <= 0 && d > 0.6 && (this.coverSwaps ?? 0) < 2) {
          this.coverCheckT = 0.6;
          const threats = match.threatsFor(this, enemy ?? this.coverThreat);
          if (threats.length && !match.coverStillSafe(this, c, threats)) {
            this.decisionSerial++;
            const again = match.findCoverSpot(this, threats[0], this.coverFight
              ? { retreat: false, maxD: 8, threats } : { retreat: true, threats });
            if (again) {
              this.cover = again; this.coverSwaps = (this.coverSwaps ?? 0) + 1;
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
          // tras dos cambios de escondite se queda en este: atrapado entre dos
          // fuegos, rebotar de un lado al otro del bloque era peor que nada
          if (!threats.length || (this.coverSwaps ?? 0) >= 2 || match.coverStillSafe(this, c, threats)) {
            this.coverPhase = 'hide'; this.coverPhaseT = 0;
          } else {
            this.coverSwaps = (this.coverSwaps ?? 0) + 1;
            this.decisionSerial++;
            const again = match.findCoverSpot(this, threats[0], { retreat: true, threats });
            if (again) { this.cover = again; match.coverClaims.set(this.id, again); }
            else {
              this.state = 'advance'; this.cover = null;
              match.coverClaims.delete(this.id);
              this.coverCd = 2; this.decisionT = 0;
            }
          }
        } else {
          mx = dx / d; mz = dz / d; travel = c; this._face(mx, mz, dt);
          // retirada herida: a la carrera (sprint, sin disparar); a una
          // cobertura de pelea se va trotando, listo para tirar
          if (!this.coverFight && d > 3) this._sprintWish = true;
        }
      } else if (this.coverPhase === 'hide') {
        // ESCONDIDO como el jugador: tras LOW/MID agachado (la cabeza no
        // asoma: casco 1.02–1.08 < 1.1), tras HIGH de pie; mira hacia la
        // amenaza (no de espaldas a la pared: eso era la cobertura pegada)
        this.wantCe = c.crouchHide ?? c.low ? 0 : 1;
        const tgt = enemy ?? look ?? (this.lastSeen?.age < 3 ? this.lastSeen : null) ?? this.coverThreat;
        if (tgt) this._face(tgt.x - this.pos.x, tgt.z - this.pos.z, dt, 5);
        // recargar a cubierto, no al asomarse
        this._maybeReload(0.6);
        // el escondite CADUCA si la amenaza flanquea: re-evaluar cada 0.6s y
        // reubicarse (muchas veces al otro lado del MISMO bloque)
        this.coverCheckT = (this.coverCheckT ?? 0.6) - dt;
        if (this.coverCheckT <= 0) {
          this.coverCheckT = 0.6;
          const threats = match.threatsFor(this, enemy ?? this.coverThreat);
          if (threats.length && !match.coverStillSafe(this, c, threats)) {
            this.decisionSerial++;
            const again = (this.coverSwaps ?? 0) < 2
              ? match.findCoverSpot(this, threats[0], { retreat: !this.coverFight, maxD: this.coverFight ? 8 : 16, threats }) : null;
            if (again) {
              this.cover = again; this.coverSwaps = (this.coverSwaps ?? 0) + 1;
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
        // quien pelea desde la cobertura se asoma antes y más rato que quien
        // se esconde a curarse; sin munición no se asoma
        this.hideFor ??= 1.0 + Math.random() * 0.7;
        if (this.state === 'cover' && this.coverPhase === 'hide' &&
            this.coverPhaseT > this.hideFor && this.hp > 35 && this.reloadT <= 0) {
          this.coverPhase = 'peek'; this.coverPhaseT = 0; this.peekOut = 0;
          // orilla del lado de la amenaza (por ahí se la ve), a veces la otra
          // para no ser previsible
          const th = this.coverThreat;
          const side = th ? Math.sign((th.x - c.x) * c.tx + (th.z - c.z) * c.tz) : 0;
          this.peekDir = (side || this.peekDir || 1) * (Math.random() < 0.25 ? -1 : 1);
          this.peekFor = this.coverFight ? 1.4 + Math.random() * 0.8 : 1.1;
          this.hideFor = this.coverFight ? 0.5 + Math.random() * 0.6 : 1.0 + Math.random() * 0.7;
        }
      } else { // peek
        const tgt = enemy ?? look ?? (this.lastSeen?.age < 3 ? this.lastSeen : null) ?? this.coverThreat;
        aiming = true; // apuntar ES asomarse (también preapuntando sin blanco)
        if (c.low) {
          // ASOMO del jugador: agachado tras el LOW + apuntar → la cabeza
          // sube por encima del borde (ce 0→1 en ~0.18 s); sin moverse
          this.wantCe = 1;
        } else {
          // MID/HIGH: a la orilla (el cuerpo aún tras la cara) e inclinarse
          // hacia la abertura; si así no ve nada, un paso fuera, sin inclinar
          const half = Math.max(0, (c.len ?? 0) / 2 - 0.05);
          const u = this.peekDir * (half + this.peekOut);
          const px = c.x + c.tx * u, pz = c.z + c.tz * u;
          const dx = px - this.pos.x, dz = pz - this.pos.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.25) { mx = dx / d; mz = dz / d; }
          this.wantCe = 1;
          if (d < 0.45 && !this.peekOut) {
            this.peekEdgeT = (this.peekEdgeT ?? 0) + dt;
            this.wantCl = this._leanToward(c.tx * this.peekDir, c.tz * this.peekDir);
            // sin hueco para inclinarse, o inclinado medio segundo sin ver a nadie
            if (!this.wantCl || (!enemy && this.peekEdgeT > 0.55)) this.peekOut = 0.55;
          } else if (!this.peekOut) this.peekEdgeT = 0;
        }
        if (enemy) {
          this._face((enemy.x - this.pos.x), (enemy.z - this.pos.z), dt, AIM.track);
          this._fireAt(dt, match, enemy, dist);
        } else if (tgt) this._face(tgt.x - this.pos.x, tgt.z - this.pos.z, dt, 6);
        if (this.coverPhaseT > (this.peekFor ?? 1.1) || this.reloadT > 0) { this.coverPhase = 'hide'; this.coverPhaseT = 0; this.peekOut = 0; this.peekEdgeT = 0; }
      }
    } else {
      // advance: waypoint elegido por rol, ocupación y valor táctico
      this.repathT -= dt;
      if (this.exitPending) {
        this.exitPending = false;
        const routes = SPAWN_ROUTES[this.world.customMap ? null : this.world.layout];
        if (routes) {
          // la ruta del lado de su carril; por el centro, la frontal
          const side = this.team === 'red' ? 1 : -1;
          const lane = (this.laneBias ?? 0) * side;
          const pick = lane < -0.35 ? routes[1] : lane > 0.35 && hash01(this.id + ':exit:' + this.decisionSerial) < 0.5 ? routes[2] : routes[0];
          this.exitRoute = pick.map(([x, z]) => ({ x: x * side, z: z * side }));
          this.exitT = 0;
        }
      }
      if (this.exitRoute) {
        this.exitT += dt;
        if (Math.hypot(this.exitRoute[0].x - this.pos.x, this.exitRoute[0].z - this.pos.z) < 0.9) this.exitRoute.shift();
        if (!this.exitRoute.length || this.exitT > 7) this.exitRoute = null;
      }
      if (this.exitRoute) {
        this.wp = this.exitRoute[0];
      } else if (!this.wp || this.repathT <= 0 ||
          Math.hypot(this.wp.x - this.pos.x, this.wp.z - this.pos.z) < 1) {
        match.refreshTacticalPlan(this, enemy);
        this.wp = this.tacticalGoal;
        this.repathT = 2.4 + this.profile.patience * 2.2;
      }
      const dx = this.wp.x - this.pos.x, dz = this.wp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.5) { mx = dx / d; mz = dz / d; travel = this.wp; }
      // reposicionándose con un enemigo a la vista: dispara mientras camina
      // (antes cruzaba por delante sin tirar hasta llegar a su destino)
      if (enemy && dist < 32 && this.meleeT <= 0) {
        aiming = true;
        this._face(enemy.x - this.pos.x, enemy.z - this.pos.z, dt, AIM.track);
        this._fireAt(dt, match, enemy, dist);
      } else if (look) this._face(look.x - this.pos.x, look.z - this.pos.z, dt, 7);
      else if (d > 0.5) {
        this._face(mx, mz, dt, 6);
        // rotar a la carrera por terreno que el equipo cree tranquilo, como
        // un jugador (el sprint cuesta el retraso sprint→disparo si aparece alguien)
        if (d > 6 && this.hp > 45 && !this.lastSeen && this.reloadT <= 0) {
          const kt = match.knownThreat(this);
          if (!kt || Math.hypot(kt.x - this.pos.x, kt.z - this.pos.z) > 20) this._sprintWish = true;
        }
      } else this._maybeReload(0.5);
    }

    // Un bypass activo manda sobre el waypoint final hasta cruzar la esquina.
    // Al completarlo, la intención táctica original vuelve a tomar el control.
    const activeGoal = this.state === 'cover' && this.coverPhase === 'go'
      ? this.cover : (this.wp || this.tacticalGoal || enemy);
    // En la rampa y sobre la plataforma el bot va en línea recta entre puntos
    // de la ruta: ni rodeos, ni saltos, ni empujones de compañeros.
    const direct = this.state === 'perch' && !!this.perch && this.perch.phase !== 'approach';
    if (direct) this.recovery = null;
    if (this.recovery) {
      const rx = this.recovery.x - this.pos.x, rz = this.recovery.z - this.pos.z;
      const rd = Math.hypot(rx, rz);
      if (rd < 0.65) {
        const completed = this.recovery;
        this.recovery = null;
        let chained = false;
        if (activeGoal) {
          const gx = activeGoal.x - this.pos.x, gz = activeGoal.z - this.pos.z;
          const gl = Math.hypot(gx, gz);
          if (gl > 0.8) {
            _v1.set(this.pos.x, 1.55, this.pos.z);
            _v2.set(gx / gl, 0, gz / gl);
            const nextHit = this.world.raycastHit?.(_v1, _v2, Math.min(2.4, gl));
            // Cajas, barandales y estructuras suelen estar formadas por
            // colliders contiguos. Encadenarlos conserva el rodeo en vez de
            // volver al waypoint final entre dos piezas de la misma barrera.
            if (nextHit?.collider) {
              const nextKey = this._obstacleKey(nextHit.collider);
              if (nextKey === completed.key) {
                completed.x += completed.perpX * completed.side * 1.25;
                completed.z += completed.perpZ * completed.side * 1.25;
                completed.targetP += completed.side * 1.25;
                completed.age = 0;
                this.recovery = completed;
                this._resetProgress();
                chained = true;
              } else {
                chained = this._startObstacleRecovery(nextHit.collider,
                  completed.forwardX, completed.forwardZ, activeGoal, match);
              }
            }
          }
        }
        if (!chained) this._resetProgress();
      } else if (this.recovery.age > (this.recovery.budget ?? 3)) {
        this._recoverFromStuck(match, null, { x: rx / rd, z: rz / rd }, activeGoal, 'bypass-timeout');
      } else {
        mx = rx / rd; mz = rz / rd;
        this._face(mx, mz, dt, 9);
      }
    }

    // ---- mover (con steering) + salto de obstáculos + física vertical ----
    // Velocidades del JUGADOR FPS (TUNING.fp): trote 4.8, ADS 2.16, agachado
    // 2.3 (ADS agachado 1.6), sprint 7.0 solo hacia delante, sin apuntar y
    // de pie (antes 4.2 / 3.2 / 5.2 y el impulso de la voltereta).
    const F = TUNING.fp;
    const low = this.wantCe < 0.5 || this.ce < 0.5;
    let spd = low ? F.crouchSpeed * (aiming ? F.crouchAdsMul : 1) : aiming ? F.runSpeed * F.adsMul : F.runSpeed;
    let sprinting = false;
    const canSprint = this._sprintWish && !aiming && !low && this.ce > 0.99 && this.grounded &&
      this.meleeT <= 0 && !this.throwPlan && animOverride == null;
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
    if (!direct) { mx += sepX * 0.9; mz += sepZ * 0.9; }
    const mlen = Math.hypot(mx, mz);
    const beforeX = this.pos.x, beforeZ = this.pos.z;
    let wasGrounded = this.grounded;
    let steering = null, requested = 0;
    if (mlen > 0.05) {
      steering = direct ? { x: mx / mlen, z: mz / mlen, blocked: false, hit: null, stairsRoute: true }
        : this._steer(mx / mlen, mz / mlen, match, this.world.navigation ? travel : activeGoal);
      if(!steering.stairsRoute)this._jumpIfBlocked(steering.x, steering.z);
      // Un salto deliberado deja de ser un movimiento pegado al suelo.
      wasGrounded = this.grounded;
      // sprint solo si el paso va claramente hacia donde mira (sprintMinForward)
      if (canSprint && steering.x * -Math.sin(this.yaw) + steering.z * -Math.cos(this.yaw) > F.sprintMinForward + 0.2) {
        sprinting = true; spd = F.sprintSpeed;
      }
      const stepLen = requested = Math.min(spd * dt, steering.reach ?? Infinity);
      this.pos.x += steering.x * stepLen;
      this.pos.z += steering.z * stepLen;
    } else { this.speed = 0; this.velX = 0; this.velZ = 0; }
    this.world.resolveCircle(this.pos, 0.38, this.y);
    this._bodyCollide(match, dt);
    if (this._unreachable) this._dropUnreachable(match);

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
    // sin paso libre en ningún sentido (strafe contra una pared): quedarse
    // quieto no es un atasco que haya que "rodear"
    const stepping = mlen > 0.05 && !steering?.none;
    if (stepping) {
      this.speed = Math.min(spd * 1.15, moved / Math.max(0.001, dt));
      this.velX = actualX / Math.max(0.001, dt);
      this.velZ = actualZ / Math.max(0.001, dt); // momentum REAL para la muerte
    } else if (mlen > 0.05) { this.speed = 0; this.velX = 0; this.velZ = 0; }

    // Movimiento solicitado vs. movimiento real, acumulado en una ventana
    // corta. También cuenta contactos repetidos para reaccionar antes de 0.45s.
    if (stepping && this.grounded && requested > 0.01 * spd * dt) {
      const expected = requested;
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
        this._recoverFromStuck(match, contact, steering, activeGoal,
          repeatedContact ? 'repeated-contact' : 'no-progress');
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

    const ceiling=this.world.ceilingHeight?.(this.pos,.38,this.y)??Infinity;
    if(this.y+1.63>ceiling){this.y=ceiling-1.63;this.vy=Math.min(0,this.vy);}

    // pasos posicionales del bot: por distancia recorrida real + aterrizaje
    const stepped = Math.hypot(this.pos.x - (this._fx ?? this.pos.x), this.pos.z - (this._fz ?? this.pos.z));
    this._fx = this.pos.x; this._fz = this.pos.z;
    if (this.grounded && this.speed > 1) {
      this._facc = (this._facc ?? 0) + stepped;
      if (this._facc > (this.speed > 4.6 ? 1.9 : 1.6)) {
        this._facc = 0;
        match.cb.stepSound?.(this.pos.x, this.pos.z,
          this.speed > 4.6 ? 'run' : 'walk', this.y, this.team);
      }
    } else {
      this._facc = 0;
    }
    if (this._wasAir && this.grounded) {
      match.cb.stepSound?.(this.pos.x, this.pos.z, 'land', this.y, this.team);
    }
    this._wasAir = !this.grounded;

    let anim = animOverride;
    if (!anim) anim = !this.grounded ? 'jump' : this.speed > 0.4 ? (sprinting ? 'roadie' : 'run') : 'idle';
    this.aim = aiming && !animOverride && anim !== 'roadie';
    anim = this._posture(anim, dt);
    // reloj del retraso sprint→disparo (fire-gates.js): arranca al soltar el sprint
    this.sinceSprint = anim === 'roadie' ? 0 : this.sinceSprint + dt;
    // ¿cuánto lleva quieta esta pose? (lo que el servidor ya recibió)
    // (de pie, trotando o en el aire es el mismo volumen: no cuenta como cambio)
    const fam = anim === 'run' || anim === 'jump' ? 'idle' : anim;
    const sig = `${fam}|${this.aim ? 1 : 0}|${Math.round(this.ce * 20)}|${Math.round(this.coverLean * 20)}`;
    if (sig !== this._poseSig) { this._poseSig = sig; this.poseHeld = 0; } else this.poseHeld += dt;
    this.netAnim = anim;
    // FPS: el cuerpo sigue a la mirada (como el jugador, yawLockDeg 1440°/s);
    // ya no hay "de espaldas a la pared"
    this.rigYaw = this.yaw;
    this.rig.setTransform(this.pos.x, this.pos.z, this.rigYaw, this.y);
    const params = this._rigParams(anim, dt);
    if (this.dodgeCd > TUNING.dodge.cooldown - POSE_BLEND_MAX) {
      // También al recuperar la marcha: la salida del casco usa la misma
      // mezcla que la esfera del bot hasta que se extingue la transición.
      const pose = match._botPose(this);
      params.interpolated = true; params.poseTr = pose.from ? pose : null;
    }
    this.rig.update(dt, params);
    // el bote sale de la mano en la pose de ESTE cuadro (main.js: throwSmoke)
    if (this.throwPlan?.release) {
      this.throwPlan.release = false;
      // Si aún no llegó el snapshot del asomo, queda el resto del gesto
      // para soltar. Al terminar se guarda el bote que sigue en el inventario.
      this.throwPlan.pending = !match.botReleaseSmoke(this) && this.throwT > 0;
    }
    // protección de spawn: highlight sutil del color del equipo
    this.rig.setProtected(this.protT > 0);
    this._lastPx = this.pos.x; this._lastPz = this.pos.z;
  }

  // POSTURA FPS (la del jugador, controller.js + net/client.js postureOf):
  // ce = altura de la cabeza (1 de pie … 0 agachado) a ritmo acotado, cl =
  // inclinación. Mientras la cabeza no está arriba del todo el estado es
  // `crouch` (también al levantarse y en el asomo), así la cabeza replicada
  // nunca salta. Inclinarse solo de pie/agachado y en el suelo; el sprint y el
  // golpe se hacen de pie. Devuelve el estado que viaja (`st`).
  _posture(anim, dt) {
    const k = POSTURE_RATE * dt;
    const step = (v, to) => (v < to ? Math.min(to, v + k) : Math.max(to, v - k));
    const upright = anim === 'roadie' || anim === 'melee';
    // sin apuntar no hay asomo: tras el LOW la cabeza vuelve abajo sola
    const want = upright ? 1 : Math.max(0, Math.min(1, this.wantCe));
    this.ce = step(this.ce, want);
    let st = anim;
    if ((anim === 'idle' || anim === 'run' || anim === 'jump') && this.ce < 0.995) st = 'crouch';
    const leanOk = (st === 'idle' || st === 'run' || st === 'crouch') && this.grounded;
    const wantCl = leanOk ? Math.max(-1, Math.min(1, this.wantCl || 0)) : 0;
    this.cl = step(this.cl, wantCl);
    if (!leanOk && Math.abs(this.cl) < 1e-3) this.cl = 0;
    this.coverLean = this.cl;
    this.coverExposure = st === 'crouch' ? this.ce : 1;
    this.coverKind = null; this.latMove = 0;
    return st;
  }

  // Lado (cl ±1) hacia el que inclinarse para asomar la cabeza en la
  // dirección (ox, oz) con el cuerpo mirando por yaw; 0 si la cabeza
  // inclinada (esfera de 0.22 desplazada LEAN_MAX) chocaría con algo.
  _leanToward(ox, oz) {
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const side = ox * rx + oz * rz >= 0 ? 1 : -1;
    const eye = this._eye ? this._eye[1] : this.y + 1.48;
    _v1.set(this.pos.x, eye, this.pos.z);
    _v2.set(rx * side, 0, rz * side);
    return this.world.raycast(_v1, _v2, LEAN_MAX + HEAD_R + 0.04) === null ? side : 0;
  }

  // Parámetros del rig: el mismo juego que animParams() + extras de main.js
  // para el jugador local. Objeto reutilizado (sin asignar por paso).
  _rigParams(anim, dt) {
    const o = this._rp ??= {};
    const CB = TUNING.combat;
    const sp = Math.hypot(this.velX ?? 0, this.velZ ?? 0);
    const fx = -Math.sin(this.rigYaw), fz = -Math.cos(this.rigYaw);
    // pendiente del suelo (controller.js): solo de pie y apoyado
    const pitchTarget = this.grounded && (anim === 'idle' || anim === 'run' || anim === 'crouch')
      ? groundPitchTarget(this.rig.groundFn, this.pos.x, this.pos.z, this.rigYaw, this.y) : 0;
    this.groundPitch += (pitchTarget - this.groundPitch) * (1 - Math.exp(-TUNING.move.groundPitchLerp * dt));
    const visualMax = CB.visualAimMaxDeg * Math.PI / 180;
    const g = TUNING.weapons.grenade;
    o.state = anim; o.interpolated = false; o.poseTr = null;
    o.speed = Math.min(1, this.speed / TUNING.move.roadieSpeed);
    // dirección real del paso respecto al cuerpo: un bot que se desplaza de
    // lado mientras dispara ya no camina "hacia delante"
    o.moveForward = sp > 0.05 ? (this.velX * fx + this.velZ * fz) / sp : 1;
    o.moveSide = sp > 0.05 ? (this.velZ * fx - this.velX * fz) / sp : 0;
    o.latMove = this.latMove;
    o.groundPitch = this.groundPitch;
    o.twist = 0;
    o.vy = this.vy;
    o.aim = this.aim;
    o.aimPitch = this.aimPitch;
    // el arma compensa lo que al cuerpo le falta por girar (como cameraYawError)
    o.aimYawErr = this.aimYawErr = Math.max(-visualMax, Math.min(visualMax, angDelta(this.rigYaw, this.yaw)));
    o.firing = this.burstT > 0 || this.muzzleT > 0;
    o.coverLean = this.coverLean;
    o.coverAimExposure = this.coverExposure;
    o.coverKind = this.coverKind;
    o.swapping = this.swapAnim > 0;
    o.throwT = this.throwT;
    o.throwTotal = g.throwTime;
    o.throwReleased = this.throwT > 0 && !this.throwPlan?.pending;
    o.reloading = this.reloadT > 0;
    o.reloadT = this._reloadPhase();
    // fase = transcurrido / final previsto, como controller.js (meleeT /
    // meleeEndT): al conectar, el final se acorta a hitAt + recovery
    const el = this.meleeEl ?? 0;
    o.meleeEnd = el + Math.max(0, this.meleeT);
    o.meleePhase = anim === 'melee'
      ? Math.min(1, el / Math.max(0.001, o.meleeEnd))
      : undefined;
    // patada en carrera: misma regla que controller.js (_beginMelee)
    o.meleeTackle = anim === 'melee' && this.meleeEntrySpeed > TUNING.move.runSpeed * 1.15;
    o.flipT = 0; o.flipDir = 1; o.flipAxis = 'z'; // sin volteretas (retiradas en FPS)
    o.dodgeBrace = 0; o.evadePhase = 0;
    o.mantlePhase = 0;
    return o;
  }

  // ráfagas (metralleta) o bombazos sueltos (escopeta)
  // ráfagas (metralleta) o bombazos sueltos (escopeta). Los timers burstT y
  // pauseT decrementan GLOBALMENTE en update(); aquí solo se dispara/arma.
  _fireAt(dt, match, enemy, dist) {
    // sin reaccionar aún, o con el cuerpo todavía girando (>26° de error),
    // no se dispara — antes la bala salía perfecta aunque el modelo apenas
    // empezara a voltear hacia el blanco
    // aturdido por una patada: nada dispara (el jugador tampoco: main.js)
    if ((this.dazeT ?? 0) > 0) return;
    // pose recién nacida / teletransportada aún sin difundir
    if ((this.fireHoldT ?? 0) > 0) return;
    // escopeta recargando con cartuchos y el blanco encima: interrumpe como
    // el jugador (una pulsación nueva corta la recarga con munición)
    if (this.reloadT > 0 && this.wep === 'shotgun' && this.ammo.shotgun > 0 && dist < 9) this.reloadT = 0;
    if (this.reactT > 0 || this.reloadT > 0) return;
    // manos ocupadas (cambio de arma, bote en la mano) o cuerpo todavía
    // girando desde la pared: el jugador tampoco puede disparar ahí
    if (this.swapAnim > 0 || this.throwPlan) return;
    // REGLAS DEL JUGADOR (fire-gates.js, la misma tabla que cliente y
    // servidor): nada en sprint, trepando ni a mitad de golpe, y tras soltar
    // el sprint el retraso del arma. El estado es el que ya viajó (netAnim).
    if (!canFireInState(this.netAnim || 'idle', this.wep)) return;
    if (this.sinceSprint < sprintFireDelay(this.wep)) return;
    // la pose desde la que sale el tiro ya se difundió (no una recién puesta);
    // recargar o cambiar con el cargador vacío no espera a eso
    const settled = this.poseHeld >= POSE_SETTLE;
    let da = (Math.atan2(-(enemy.x - this.pos.x), -(enemy.z - this.pos.z)) - this.yaw) % (Math.PI * 2);
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    // el disparo sale hacia donde apunta el cuerpo (ver botShoot): con el
    // cuerpo aún girando no se aprieta el gatillo
    if (Math.abs(da) > 0.2) return;
    // LANZACOHETES: solo con línea despejada, a distancia segura y sin
    // compañeros cerca del punto de impacto. Un bot no debe reventar a su
    // propio equipo ni suicidarse por disparar a bocajarro.
    if (this.wep === 'bazooka') {
      if (settled && this.shotCd <= 0 && this.specialAmmo > 0 && dist > 8 &&
          match.rocketPathClear(this, enemy, dist) && match.botFireRocket(this, enemy) !== false) {
        this._rearm((60 / TUNING.weapons.bazooka.rpm) * 1.3);
        this.muzzleT = 0.18;
        this.specialAmmo--;
        if (this.specialAmmo <= 0) { this.special = null; this.swapCd = 0; this._trySwap(this._hasAmmo('smg') ? 'smg' : 'shotgun'); }
      }
      return;
    }
    // FRANCOTIRADOR recogido del pedestal: cadencia lenta, munición contada.
    // Al agotarla vuelve solo a su primaria (no se queda con un arma vacía).
    if (this.wep === 'sniper') {
      // solo con la mira (sin ella su dispersión es de 5°)
      if (settled && this.aim && this.shotCd <= 0 && this.specialAmmo > 0) {
        this._rearm((60 / TUNING.weapons.sniper.rpm) * 1.25);
        // tiro declinado (línea tapada, humo): ni bala gastada ni fogonazo
        if (match.botShoot(this, enemy) === false) return;
        this.muzzleT = 0.15;
        this.specialAmmo--;
        if (this.specialAmmo <= 0) { this.special = null; this.swapCd = 0; this._trySwap(this._hasAmmo('smg') ? 'smg' : 'shotgun'); }
      }
      return;
    }
    // cargador real: al vaciarlo recarga (y quien pelea desde cobertura se
    // esconde para hacerlo)
    if (this.ammo[this.wep] !== undefined && this.ammo[this.wep] <= 0) {
      // sin reserva: a la otra arma si le queda algo (sin esperar al enfriamiento)
      if (!(this.reserve[this.wep] > 0)) {
        const other = this.wep === 'smg' ? 'shotgun' : 'smg';
        if (this._hasAmmo(other)) { this.swapCd = 0; this._trySwap(other); }
      } else this._startReload();
      return;
    }
    if (!settled) return;
    if (this.wep === 'shotgun') {
      if (this.shotCd <= 0 && dist < 20) {
        this._rearm((60 / TUNING.weapons.shotgun.rpm) * 1.5);
        // muzzleT, NO burstT: usar burstT congelaba pauseT y contaminaba el
        // ritmo de ráfagas al volver a la metralleta
        if (match.botShoot(this, enemy) !== false) { this.muzzleT = 0.15; this.ammo.shotgun--; }
      }
      return;
    }
    // ráfagas cortas con pausas para corregir, como una persona con una SMG
    if (this.burstT > 0) {
      if (this.shotCd <= 0) {
        this._rearm((60 / TUNING.weapons.smg.rpm) * 1.2);
        if (match.botShoot(this, enemy) !== false) this.ammo.smg--;
      }
    } else if (this.pauseT <= 0) {
      this.burstT = 0.45 + Math.random() * 0.45;
      this.pauseT = 0.3 + Math.random() * 0.4 + (dist > 22 ? 0.25 : 0);
      // primer tiro de la ráfaga en el MISMO frame que se arma
      if (this.shotCd <= 0) {
        this._rearm((60 / TUNING.weapons.smg.rpm) * 1.2);
        if (match.botShoot(this, enemy) !== false) this.ammo.smg--;
      }
    }
  }

  dispose(scene) { this.rig.dispose(scene); }
}

export class BotMatch {
  get waveRemaining() {
    const elapsed = ROUND_TIME - this.timer;
    return nextRespawnWave(elapsed) - elapsed;
  }
  // cb: { effects, audio, hud, playerName,
  //   player(): {x,z,y,alive}, damagePlayer(dmg, fromName) -> murió?,
  //   respawnPlayer(spawn), onMatchEnd(winnerTeam) }
  constructor(scene, world, cb, options = {}) {
    this.scene = scene;
    this.world = world;
    this.cb = cb;
    this.external = !!options.external;
    this.playerTeam = options.playerTeam === 'blue' ? 'blue' : 'red';
    this.roundLimit = [1, 3, 5].includes(+options.rounds) ? +options.rounds : 3;
    this.livesPerTeam = Math.max(2, +options.lives || DEFAULT_LIVES);
    this.bots = [];
    this.stats = new Map();
    this.wins = { red: 0, blue: 0 };
    this.round = 0;
    this.timer = ROUND_TIME;
    this.phase = 'starting';
    this.phaseT = 0;
    this.pool = { red: 0, blue: 0 };
    this.respawnQueue = [];
    this.coverClaims = new Map(); // botId -> spot reservado (sin duplicar cover)
    // calor de enemigos AVISTADOS por tercio del mapa (x), por equipo: la
    // base contextual para flanquear por el lado frío y no amontonarse
    this.enemyHeat = { red: [0, 0, 0], blue: [0, 0, 0] };
    this.specialSeeker = { red: null, blue: null }; // un solo bot por equipo va al pedestal
    this.tacticalClaims = new Map(); // destinos/ángulos reservados por bot
    this.perchClaims = new Map();    // plataforma -> bot que la ocupa
    this.motion = new Map();         // id -> posición/velocidad de cada combatiente
    this.intel = { red: new Map(), blue: new Map() }; // lo que sabe cada equipo
    this._stamp = 0; this._clock = 0;
    this._rocketSeq = 0;
    this._nadeSeq = 0;

    if (!this.external) this.stats.set('player', {
      name: cb.playerName, team: this.playerTeam, kills: 0, deaths: 0,
      variant: cb.playerVariant ?? 0,
    });
    const roster = Array.isArray(options.bots) ? options.bots : (() => {
      let n = 0;
      const out = [];
      for (const team of ['red', 'blue']) for (const name of BOT_NAMES[team]) {
        // En el roster clásico el jugador ocupa un slot rojo.
        if (team === this.playerTeam && out.filter((b) => b.team === team).length >= 3) continue;
        out.push({ id: 'bot' + n++, name, team });
      }
      return out;
    })();
    const spawnIndex = { red: 0, blue: 0 };
    if (!this.external) spawnIndex[this.playerTeam] = 1;
    for (const slot of roster) {
      const team = slot.team === 'blue' ? 'blue' : 'red';
      const spawn = slot.spawn || world.spawns[team][spawnIndex[team]++ % 4];
      const bot = new Bot(scene, world, String(slot.id), String(slot.name), team, spawn, slot.variant);
      bot.rig.setNameTagThroughWalls(team === this.playerTeam); // solo compañeros a través de muros
      this.bots.push(bot);
      this.stats.set(bot.id, { name: bot.name, team, kills: 0, deaths: 0, variant: bot.variant });
    }
    this.roundWinner = null;
    this.matchWinner = null;
    this.pendingRoundWinner = null;
    if (this.external) {
      this.phase = 'playing';
      this.phaseT = 0;
      this._assignOpeningPlans();
    } else this._startRound(true);
  }

  _startRound(first = false) {
    this.round++;
    this.timer = ROUND_TIME;
    const roster = {
      red: this.bots.filter((b) => b.team === 'red').length + (this.playerTeam === 'red' ? 1 : 0),
      blue: this.bots.filter((b) => b.team === 'blue').length + (this.playerTeam === 'blue' ? 1 : 0),
    };
    this.pool = {
      red: Math.max(0, this.livesPerTeam - roster.red),
      blue: Math.max(0, this.livesPerTeam - roster.blue),
    };
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
    this.intel.red.clear(); this.intel.blue.clear();
    this.specialSeeker = { red: null, blue: null };
    this.phase = first ? 'intro' : 'countdown';
    this.phaseT = first ? INTRO_TIME : COUNTDOWN_TIME;
    this.roundWinner = null;
    let i = { red: 0, blue: 0 };
    for (const b of this.bots) {
      b.respawn(this.world.spawns[b.team][++i[b.team] % 4]);
    }
    this._assignOpeningPlans();
    this.cb.respawnPlayer(this.world.spawns[this.playerTeam][0], false);
  }

  controlsLocked() { return this.phase !== 'playing' && this.phase !== 'round-finish'; }

  // Saltar la presentación: pasa directo a la cuenta regresiva. minShown
  // (s) evita que el gesto que arrancó la partida la salte en el acto.
  skipIntro(minShown = 0) {
    if (this.phase !== 'intro' || INTRO_TIME - this.phaseT < minShown) return false;
    this.phaseT = 0; // el próximo update la convierte en countdown
    return true;
  }

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
    if (!this.external && team === this.playerTeam && this.cb.player().alive) alive++;
    if (this.external) alive += (this.cb.humans?.() || []).filter((p) => p.team === team && p.alive).length;
    for (const b of this.bots) if (b.team === team && b.alive) alive++;
    const queued = this.respawnQueue.filter(q => q.id === 'player' ? team === this.playerTeam : this.bots.some(b => b.id === q.id && b.team === team)).length;
    return alive + this.pool[team] + queued;
  }

  // Pose del bot con la MEZCLA DE ESTADOS de hit-pose.js (POSE_BLEND, 0.2 s
  // de pie↔sprint↔golpe): la misma que el servidor reconstruye de los
  // botState (transitionOf) y que el jugador local usa para sí
  // (net/client.js trackTransition, con el instante exacto del cambio).
  // Antes el volumen del bot saltaba de golpe y el del servidor se mezclaba.
  _botPose(b) {
    const p = trackTransition(b, b.pose(), this._clock);
    b._posed = p;
    b._eye = eyeWorld(p, b.pos.x, b.y, b.pos.z, b.rigYaw ?? b.yaw);
    b._eyeAt = { x: b.pos.x, z: b.pos.z, y: b.y };
    return p;
  }
  // Ojo para un tiro: el de la pose del paso (la difundida); si al bot lo
  // movieron lejos desde entonces (teletransporte, pruebas), se recalcula.
  _eyeOf(b) {
    const a = b._eyeAt;
    if (!b._eye || !a || Math.hypot(a.x - b.pos.x, a.z - b.pos.z) > 0.6 || Math.abs(a.y - b.y) > 0.4) this._botPose(b);
    return b._eye;
  }

  // Volumen de impacto del bot = el de su pose replicada (hit-pose.js): de
  // pie, agachado tras el LOW (casco 1.02–1.08), asomado con `ce`, inclinado
  // con `cl`, ADS con el arma en mano. Lo dibujado es lo impactable.
  _hitFields(b) {
    return hitFields(this._botPose(b), b.pos.x, b.y, b.pos.z, b.rigYaw ?? b.yaw);
  }

  targets() { // enemigos del jugador local
    return this.bots
      .filter((b) => b.team !== this.playerTeam && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y,
        team: b.team, alive: true, ...this._hitFields(b) }));
  }

  _enemiesOf(bot) {
    const out = this.bots
      .filter((b) => b.team !== bot.team && b.alive)
      .map((b) => ({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true, ...this._hitFields(b) }));
    if (!this.external && bot.team !== this.playerTeam) {
      const p = this.cb.player();
      if (p.alive) out.push({ id: 'player', x: p.x, z: p.z, y: p.y, alive: true, crouch: !!p.crouch,
        hit: p.hit ?? null, hitVol: p.hitVol });
    }
    if (this.external) for (const p of this.cb.humans?.() || []) {
      if (p.team !== bot.team && p.alive) out.push({ ...p, crouch: !!p.crouch });
    }
    return out;
  }

  _alliesOf(bot) {
    const out = this.bots.filter((b) => b !== bot && b.team === bot.team && b.alive);
    if (!this.external && bot.team === this.playerTeam) {
      const p = this.cb.player();
      if (p.alive) out.push({ id: 'player', pos: { x: p.x, z: p.z }, hp: 100, state: 'player' });
    }
    if (this.external) for (const p of this.cb.humans?.() || []) {
      if (p.team === bot.team && p.alive) out.push({ id: p.id, pos: { x: p.x, z: p.z }, hp: p.hp ?? 100, state: p.state || 'player' });
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
    let enemies = 0;
    for (const i of this.intel[bot.team].values()) {
      if (i.age < 3 && this.motion.get(i.id)?.alive && Math.hypot(i.x - bot.pos.x, i.z - bot.pos.z) < radius) enemies++;
    }
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

  // Reserva una plataforma para el bot: una por bot, un bot por equipo arriba
  // a la vez, y solo las que no quedan detrás de las líneas rivales.
  claimPerch(bot) {
    const decks = perchesFor(this.world.customMap ? this.world.customMap.base : this.world.layout);
    if (!decks.length) return null;
    if (this.bots.some((b) => b !== bot && b.alive && b.team === bot.team && b.perch)) return null;
    const toward = bot.team === 'red' ? 1 : -1;
    // v3: hay plataformas al otro lado de un puente; el bot llega por la ruta
    // de navegación, así que el radio es amplio y el plazo de llegada también
    let best = null, bestD = 30;
    for (const deck of decks) {
      const holder = this.perchClaims.get(deck);
      if (holder && holder !== bot.id) { const h = this.botById(holder); if (h?.alive && h.perch?.deck === deck) continue; }
      if (deck.z * toward > 6) continue;
      for (const entry of deck.ramps) {
        const d = Math.hypot(entry.foot.x - bot.pos.x, entry.foot.z - bot.pos.z);
        if (d < bestD) { bestD = d; best = { deck, entry }; }
      }
    }
    if (!best) return null;
    const { deck, entry } = best;
    this.perchClaims.set(deck, bot.id);
    this.releaseTacticalClaim(bot.id);
    const inward = -Math.sign(deck.x);
    return {
      deck, entry, phase: 'approach', step: 0, t: 0, quiet: 0,
      // bajar hacia el campo rival si hay rampa de ese lado
      advance: deck.ramps.find((r) => r.dir * toward < 0) ?? entry,
      // con baranda: en la esquina que mira al centro y al rival, con la
      // baranda delante; sin ella (remolque), en medio de la tarima
      spot: deck.railed
        ? { x: deck.x + inward * (deck.w / 2 - 1.0), z: deck.z + toward * (deck.d / 2 - 1.0) }
        : { x: deck.x, z: deck.z + toward * 0.6 },
      holdFor: 7 + bot.profile.patience * 6,
    };
  }

  releasePerch(bot) {
    const deck = bot.perch?.deck;
    if (deck && this.perchClaims.get(deck) === bot.id) this.perchClaims.delete(deck);
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
    // planes con lo que el equipo SABE (visto, oído o recibido), no con la
    // posición real de quien nadie ha detectado
    const threat = visibleEnemy || this.knownThreat(bot);
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
        support: 0.55 + bot.profile.cohesion * 1.4 + (allyNeedsHelp ? 1.15 : 0) +
          (this._escortsHuman(bot) ? 1.6 : 0),
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
    let goal = this.tacticalWaypoint(bot, bot.role, threat);
    // garantía final: ningún destino donde no quepa un cuerpo (venga de donde
    // venga, una cara de cobertura, un punto de apoyo o el plan de flanqueo)
    const nav = this.world.navigation;
    if (goal && nav && !nav.walkable(goal)) {
      const c = nav.nearest(goal);
      if (c) goal = { x: c.x, z: c.z, role: goal.role };
    }
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

  // A quién cubrir: el compañero más necesitado. Un humano del equipo
  // cuenta siempre (antes solo se cubría a otros bots y el jugador avanzaba
  // solo): los bots le acompañan y le cubren el flanco.
  _supportTarget(bot) {
    let best = null, bestNeed = -Infinity;
    for (const a of this._alliesOf(bot)) {
      if (!a.pos) continue;
      const human = a.state === 'player' || !(a instanceof Bot);
      const need = (100 - (a.hp ?? 100)) + ((a.recentHit ?? 99) < 3 ? 35 : 0) + (human ? 45 : 0) -
        Math.hypot(a.pos.x - bot.pos.x, a.pos.z - bot.pos.z) * 0.5;
      if (need > bestNeed) { bestNeed = need; best = a; }
    }
    return best;
  }

  // ¿Es este bot el compañero más cercano a un humano de su equipo?
  _escortsHuman(bot) {
    const humans = this._alliesOf(bot).filter((a) => a.pos && !(a instanceof Bot));
    if (!humans.length) return false;
    for (const h of humans) {
      let near = null, nd = Infinity;
      for (const b of this.bots) {
        if (!b.alive || b.team !== bot.team) continue;
        const d = Math.hypot(b.pos.x - h.pos.x, b.pos.z - h.pos.z);
        if (d < nd) { nd = d; near = b; }
      }
      if (near === bot) return true;
    }
    return false;
  }

  tacticalWaypoint(bot, role = 'advance', threat = null) {
    const toward = bot.team === 'red' ? 1 : -1;
    const clampX = (x) => Math.max(-this.world.fx + 2, Math.min(this.world.fx - 2, x));
    const clampZ = (z) => Math.max(-this.world.fz + 2, Math.min(this.world.fz - 2, z));
    let lane = bot.laneBias ?? 0;
    if(this.world.layout==='fortaleza'&&role==='flank'&&bot.profile.flank>.5){
      const side=Math.sign(lane)||(bot.profile.flank<.75?-1:1);
      // por la galería: primero hasta su mitad y luego al tramo rival. Decidir
      // por |z| hacía rebotar al bot en z=±6 (cada destino devolvía al otro).
      return {x:side*23.7,z:bot.pos.z*toward<-6?0:toward*16.4,role};
    }
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
      // sobre una plataforma o su rampa no hay destino a pie llano: arriba se
      // sube solo como puesto (ver _perch)
      if (footprintAt(this.world, x, z)) continue;
      if (bot._goalRecentlyFailed(x, z)) continue;
      // destino donde no cabe un cuerpo (pegado a otra caja, en el vacío entre
      // azoteas): la ruta no lo alcanza y el bot acababa empujando
      if (this.world.navigation) { _probe.x = x; _probe.z = z; if (!this.world.navigation.walkable(_probe)) continue; }
      const d = Math.hypot(x - bot.pos.x, z - bot.pos.z);
      if (d < (role === 'hold' ? 2 : 3.5) || d > (role === 'flank' ? 22 : 18)) continue;
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

    if (!best && this.world.navigation && !this.world.navigation.walkable({x:targetX,z:targetZ})) {
      const p=this.world.navigation.nodes.reduce((a,b)=>
        Math.hypot(b.x-targetX,b.z-targetZ)<Math.hypot(a.x-targetX,a.z-targetZ)?b:a);
      return {...p,role};
    }
    return best || { x: targetX, z: targetZ, role };
  }

  // ---------- PERCEPCIÓN ----------
  // Cada combatiente vivo (bots, jugador local, humanos online) tiene un
  // registro reutilizado con su posición y velocidad estimada. Los bots solo
  // "ven" a través de él: sin objetos nuevos por paso.
  _touch(id, team, x, z, y, fields, dt) {
    let r = this.motion.get(id);
    if (!r) {
      r = { id, team, x, z, y, vx: 0, vz: 0, crouch: false, alive: true, shotAt: -99, stamp: 0 };
      this.motion.set(id, r);
    } else if (dt > 0 && r.alive) {
      const k = 1 - Math.exp(-dt / 0.15);
      // tope de 9 m/s: un respawn (teletransporte) no es velocidad
      r.vx += (Math.max(-9, Math.min(9, (x - r.x) / dt)) - r.vx) * k;
      r.vz += (Math.max(-9, Math.min(9, (z - r.z) / dt)) - r.vz) * k;
    }
    r.team = team; r.x = x; r.z = z; r.y = y ?? 0; r.crouch = !!fields?.crouch;
    this._storeVolume(r, fields);
    r.alive = true; r.stamp = this._stamp;
  }

  // Volumen de impacto REAL del blanco (hit-pose.js) en el registro: la
  // vista y la puntería de los bots van a lo que se dibuja (cabeza asomada
  // sobre el bloque, lean en la orilla, tumbado en dive), no a la altura de
  // pie/agachado. Con las poses de siempre (STAND/CROUCH) los puntos son
  // exactamente los de antes: 0.9/1.3 para ver, 0.72/1.1 al pecho.
  _storeVolume(r, f) {
    const vol = f?.hitVol ?? (f?.crouch ? CROUCH : STAND);
    const w = f?.hit;
    r.hitVol = vol;
    r.legacy = !w;
    if (w) {
      r.hx = w.hx; r.hy = w.hy; r.hz = w.hz; r.hr = w.hr;
      // pecho: 80 % del eje del cuerpo (de pie: 1.11, como el 1.1 de siempre)
      r.cx = w.ax + (w.bx - w.ax) * 0.8; r.cy = w.ay + (w.by - w.ay) * 0.8; r.cz = w.az + (w.bz - w.az) * 0.8;
    } else {
      r.hx = r.x; r.hy = r.y + vol.h[2]; r.hz = r.z; r.hr = vol.hr;
      r.cx = r.x; r.cy = r.y + (r.crouch ? 0.72 : 1.1); r.cz = r.z;
    }
    r.eyeY = r.y + hitAimHeights(vol).eye;
  }

  // Línea de visión del OJO del bot (punto de mundo e = [x, y, z], el de su
  // pose) a un punto: 0 libre, 1 la tapa una pared, 2 la tapa el humo. Hasta
  // 5 cm del punto (antes 0.5 m: un muro pegado al blanco no contaba y un
  // agachado tras un bloque delgado se "veía").
  _sightTo(e, x, y, z) {
    _v1.set(e[0], e[1], e[2]);
    _v2.set(x - e[0], y - e[1], z - e[2]);
    const len = _v2.length();
    if (len < 0.1) return 0;
    _v2.multiplyScalar(1 / len);
    if (this.world.raycast(_v1, _v2, len - 0.05) !== null) return 1;
    return this.cb.smoke?.blocksSegment(e[0], e[1], e[2], x, y, z) ? 2 : 0;
  }
  // ¿Ve el ojo e alguna parte del volumen del registro r? Centro de cabeza,
  // tope del casco o pecho (lo que asoma por encima de un LOW o por una
  // orilla basta; el humo tapa la línea entera).
  _seesVolume(e, r) {
    if (this._sightTo(e, r.hx, r.hy, r.hz) === 0) return true;
    if (this._sightTo(e, r.hx, r.hy + r.hr * 0.7, r.hz) === 0) return true;
    return this._sightTo(e, r.cx, r.cy, r.cz) === 0;
  }

  _trackMotion(dt) {
    this._stamp++;
    this._clock += dt;
    for (const b of this.bots) if (b.alive) this._touch(b.id, b.team, b.pos.x, b.pos.z, b.y, this._hitFields(b), dt);
    if (!this.external) {
      const p = this.cb.player?.();
      if (p?.alive) this._touch('player', this.playerTeam, p.x, p.z, p.y, p, dt);
    } else {
      for (const p of this.cb.humans?.() ?? []) {
        if (p.alive) this._touch(p.id, p.team, p.x, p.z, p.y, p, dt);
      }
    }
    for (const r of this.motion.values()) if (r.stamp !== this._stamp) r.alive = false;
    // lo que sabe cada equipo envejece; pasado INTEL_TTL ya no orienta planes
    for (const team of ['red', 'blue']) {
      for (const i of this.intel[team].values()) i.age += dt;
    }
  }

  // Un equipo "sabe" dónde está un enemigo porque alguien lo vio, lo oyó o
  // recibió sus tiros. Es la única fuente de los planes (nada de leer la
  // posición real de quien nadie ha detectado).
  _report(team, id, x, z) {
    let i = this.intel[team].get(id);
    if (!i) { i = { id, x, z, age: 0 }; this.intel[team].set(id, i); }
    i.x = x; i.z = z; i.age = 0;
  }

  knownThreat(bot) {
    let best = null, bestD = Infinity;
    for (const i of this.intel[bot.team].values()) {
      if (i.age > INTEL_TTL) continue;
      const r = this.motion.get(i.id);
      if (!r || !r.alive) continue;
      const d = Math.hypot(i.x - bot.pos.x, i.z - bot.pos.z) + i.age * 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ¿Ya tenía ubicado a este enemigo? (lo vio hace nada, lo oyó, le pegó o
  // un compañero lo cantó cerca de ahí): la reacción es más corta.
  _expected(bot, e) {
    const i = this.intel[bot.team].get(e.id);
    if (i && i.age < 2.5 && Math.hypot(i.x - e.x, i.z - e.z) < 5) return true;
    const t = bot.lastThreat ?? bot.alert;
    return !!t && t.age < 2.5 && Math.hypot(t.x - e.x, t.z - e.z) < 5;
  }

  // Lo que el bot percibe: vista con campo visual (cono frontal amplio,
  // periferia solo de cerca, sin ojos en la nuca), línea de visión y humo
  // reales, y oído (disparos cercanos, pasos a la carrera muy cerca). Se
  // recalcula cada SENSE_PERIOD, no cada paso: nadie percibe a 30 Hz.
  _perceive(bot) {
    const seen = bot.seen, seenD = bot.seenD;
    seen.length = 0; seenD.length = 0;
    const fx = -Math.sin(bot.yaw), fz = -Math.cos(bot.yaw);
    // ojo REAL del bot (eyeWorld de su pose): agachado tras un LOW ve desde
    // 0.65 m y no por encima del bloque (antes, siempre desde y + 1.3)
    const eye = this._eyeOf(bot); // vivo: tras un respawn/teletransporte no ve desde donde estaba
    for (const r of this.motion.values()) {
      if (!r.alive || r.team === bot.team) continue;
      const dx = r.x - bot.pos.x, dz = r.z - bot.pos.z;
      const d = Math.hypot(dx, dz);
      if (d >= SIGHT_RANGE) continue;
      const cos = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      const loud = this._clock - r.shotAt < 0.6;
      const running = r.vx * r.vx + r.vz * r.vz > 9;
      // en pantalla, o el blanco que ya sigue (de cerca), o pegado a él;
      // un disparo fuera de la vista se OYE (abajo) y le hace girarse
      let look = cos >= FRONT_COS ||
        (cos >= PERIPHERY_COS && r.id === bot.targetId && d < 12) || d < 2.2;
      // a lo que se dibuja: lo agachado tras un bloque no se ve; lo que asoma
      // por encima (asomo) o por la orilla (inclinación) sí
      if (look) look = this._seesVolume(eye, r);
      if (look) {
        let k = seen.length;
        seen.push(r); seenD.push(d);
        while (k > 0 && seenD[k - 1] > d) { seen[k] = seen[k - 1]; seenD[k] = seenD[k - 1]; k--; }
        seen[k] = r; seenD[k] = d;
        // ¿lo esperaba? Se clasifica ANTES de publicar el avistamiento: si no,
        // hasta una sorpresa contaba como "ya ubicado" (reacción corta)
        (bot.expectBy ??= new Map()).set(r.id, this._expected(bot, r));
        this._report(bot.team, r.id, r.x, r.z);
        this.enemyHeat[bot.team][this._third(r.x)] += 0.25 * SENSE_PERIOD * 30;
      } else if ((loud && d < HEAR_SHOT) || (running && d < HEAR_STEPS)) {
        // oído: dirección aproximada, no una posición exacta
        const a = bot.alert ??= { x: 0, z: 0, age: 99 };
        const err = Math.min(3, d * 0.08);
        a.x = r.x + (Math.random() - 0.5) * err; a.z = r.z + (Math.random() - 0.5) * err; a.age = 0;
        if (loud) this._report(bot.team, r.id, a.x, a.z);
      }
    }
  }

  // Lista ordenada por distancia de lo que el bot ve ahora (registros vivos).
  visibleEnemies(bot) {
    if (bot.senseT <= 0 || !bot.seen) {
      bot.seen ??= []; bot.seenD ??= [];
      this._perceive(bot);
      bot.senseT = SENSE_PERIOD;
    }
    return bot.seen;
  }

  // El blanco: el más cercano a la vista, pero sin saltar de uno a otro por
  // medio metro (el actual se conserva salvo que otro esté claramente más cerca).
  nearestVisibleEnemy(bot) {
    const seen = this.visibleEnemies(bot);
    let first = -1;
    for (let i = 0; i < seen.length; i++) {
      if (!seen[i].alive) continue;
      if (first < 0) first = i;
      if (seen[i].id === bot.targetId && bot.seenD[i] < bot.seenD[first] * 1.35 + 2) return seen[i];
    }
    return first < 0 ? null : seen[first];
  }

  // Un disparo se oye: marca al tirador para la percepción de los demás.
  _shotBy(bot) {
    const r = this.motion.get(bot.id);
    if (r) r.shotAt = this._clock;
  }

  // Disparo de un humano (jugador local u online): los bots también lo oyen
  // (antes solo se marcaban los de otros bots). id: 'player' offline.
  noteShot(id) {
    const r = this.motion.get(id);
    if (r) r.shotAt = this._clock;
  }

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
    // desde el casco de la postura escondida real (agachado tras LOW/MID,
    // de pie tras HIGH): si la amenaza lo ve, el escondite no sirve
    const eye = (bot.y || 0) + ((c.crouchHide ?? c.low) ? HIDE_EYE : STAND_EYE);
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
  findCoverSpot(bot, threat, { retreat = false, threats = null, maxD = 16 } = {}) {
    const threatList = threats && threats.length ? threats : [{ x: threat.x, z: threat.z }];
    const primary = threatList[0];
    let best = null, bestScore = -Infinity;
    const currentThreatD = Math.hypot(primary.x - bot.pos.x, primary.z - bot.pos.z);
    const toThreatX = (primary.x - bot.pos.x) / Math.max(0.01, currentThreatD);
    const toThreatZ = (primary.z - bot.pos.z) / Math.max(0.01, currentThreatD);
    for (let fi = 0; fi < this.world.faces.length; fi++) {
      const f = this.world.faces[fi];
      if (f.h > 2.6) continue; // muros perimetrales no
      if(Math.abs((f.baseY??0)-bot.y)>.3)continue;
      const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
      // la cara debe darle la ESPALDA a la amenaza primaria: sin este check
      // el bot se "cubría" parado del lado del enemigo, de frente a él
      if ((primary.x - mx) * f.n.x + (primary.z - mz) * f.n.z > -0.2) continue;
      const sx = mx + f.n.x * 0.7, sz = mz + f.n.z * 0.7;
      if (bot._goalRecentlyFailed(sx, sz)) continue;
      if (this.world.navigation) { _probe.x = sx; _probe.z = sz; if (!this.world.navigation.walkable(_probe)) continue; }
      const d = Math.hypot(sx - bot.pos.x, sz - bot.pos.z);
      if (d > maxD || d < 1.2) continue;
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
      // vista bloqueada desde la POSTURA escondida real: el casco agachado
      // (0.95) tras LOW y MID (< 1.9: de pie asomaría la cabeza), el de pie
      // (1.8) tras HIGH. Antes 0.8 / 1.2: tras un bloque de 1.5 el bot se
      // quedaba de pie con la cabeza fuera.
      const crouchHide = f.h - (f.baseY ?? 0) < MID_STAND;
      const eye = crouchHide ? HIDE_EYE : STAND_EYE;
      _v1.set(sx, bot.y + eye, sz);
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
        _v1.set(sx, bot.y + eye, sz);
        _v2.set(t2.x - sx, 0.1, t2.z - sz);
        const l2 = _v2.length();
        _v2.normalize();
        const blocked = this.world.raycast(_v1, _v2, Math.min(l2, 25)) !== null;
        if (!sideOk || !blocked) exposure += t2.ghost ? 1.0 : 1.6;
      }
      // cobertura de PELEA: un LOW sirve si al asomarse (ojo de pie, 1.48)
      // se ve a la amenaza por encima; un HIGH, si su orilla queda cerca
      const low = f.h - (f.baseY ?? 0) <= TUNING.cover.lowHeight;
      let fightBonus = 0;
      if (!retreat) {
        if (low) {
          _v1.set(sx, bot.y + 1.48, sz);
          _v2.set(primary.x - sx, 0, primary.z - sz);
          const lp = _v2.length(); _v2.normalize();
          fightBonus = this.world.raycast(_v1, _v2, Math.min(lp, 25)) === null ? 0.9 : -0.6;
        } else fightBonus = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z) < 5 ? 0.3 : -0.3;
      }

      let crowd = 0;
      for (const a of this._alliesOf(bot)) {
        if (!a.pos) continue;
        const ad = Math.hypot(a.pos.x - sx, a.pos.z - sz);
        if (ad < 5) crowd += (5 - ad) * 0.8;
      }
      const newThreatD = Math.hypot(primary.x - sx, primary.z - sz);
      let score = fightBonus - d * 0.34 - crowd - exposure +
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
        low,               // asomo por encima (≤ lowHeight)
        crouchHide,        // escondido agachado (< MID_STAND)
        len: tlen, kind: f.kind, // orillas para asomarse por el lado
      };
      bestScore = score;
    }
    return best;
  }

  canBotMelee(bot, enemy) {
    const ml = TUNING.melee;
    const dx = enemy.x - bot.pos.x, dz = enemy.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > ml.range || Math.abs((enemy.y ?? 0) - bot.y) > ml.heightTolerance) return false;
    const f = { x: -Math.sin(bot.yaw), z: -Math.cos(bot.yaw) };
    const dot = dist < 0.001 ? 1 : (dx * f.x + dz * f.z) / dist;
    if (dot < Math.cos(ml.acquireArcDeg * Math.PI / 360)) return false;
    _v1.set(bot.pos.x, bot.y + 1.08, bot.pos.z);
    _v2.set(enemy.x - bot.pos.x,
      (enemy.y ?? 0) + aimHeights(enemy).body - (bot.y + 1.08),
      enemy.z - bot.pos.z);
    const len = _v2.length();
    return len <= 0.4 || this.world.raycast(_v1, _v2.normalize(),
      Math.max(0, len - ml.wallPadding)) === null;
  }

  // Golpe cuerpo a cuerpo de un bot: misma geometría que el jugador y, en
  // online, el servidor sigue siendo quien decide el daño definitivo.
  botMelee(bot) {
    const ml = TUNING.melee;
    const eye = this._eyeOf(bot);
    const origin = new THREE.Vector3(...eye);
    const yaw = bot.yaw;
    let best = null;
    for (const e of this._enemiesOf(bot)) {
      if (e.alive === false) continue;
      const y = e.y ?? 0;
      const vol = e.hit ?? placeHitPose(e.hitVol ?? (e.crouch ? CROUCH : STAND), e.x, y, e.z, 0);
      const contact = meleeTargetPoint(eye, vol, yaw);
      if (!contact || !meleeHitOk(eye, yaw, contact.point, [e.x, y + 0.9, e.z])) continue;
      _v2.fromArray(contact.point).sub(origin);
      const len = _v2.length();
      if (len > 0.05 && this.world.raycast(origin, _v2.multiplyScalar(1 / len), len) !== null) continue;
      const dx = e.x - bot.pos.x, dz = e.z - bot.pos.z, d = Math.hypot(dx, dz);
      const dot = d > 0.001 ? (-dx * Math.sin(yaw) - dz * Math.cos(yaw)) / d : 1;
      const score = contact.dist + (1 - dot) * 0.42;
      if (!best || score < best.score) best = { e, d, dx, dz, score, point: contact.point };
    }
    if (!best) {
      const pitch = bot.aimPitch || 0, cp = Math.cos(pitch);
      const dir = _v2.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
      const wall = kickWorldContact(this.world, origin, dir);
      if (wall) {
        this.cb.effects?.meleeWorld?.(wall.point, wall.normal);
        this.cb.audio?.meleeImpact?.({ position: wall.point, world: true });
      }
      return { connected: false, killed: false };
    }
    const point = new THREE.Vector3(...best.point);
    const ctx = { weapon: 'melee', distance: best.d, damage: ml.dmg,
      part: 'body', gib: false, attackerState: bot.state };
    let killed = false;
    if (this.external) {
      this.cb.botFire?.(bot, origin, point, 'melee', []);
      this.cb.botHit?.(bot, best.e.id, ml.dmg, 'body', false, point);
    } else if (best.e.id === 'player') {
      killed = !!this.cb.damagePlayer(ml.dmg * BOT_DMG, bot.name,
        { x: bot.pos.x, z: bot.pos.z }, ctx);
      if (killed) this._onDeath('player', bot.id, false, ctx);
    } else {
      killed = !!this.damageBot(best.e.id, ml.dmg * BOT_DMG,
        bot.id, false, false, ctx);
    }
    const team = best.e.id === 'player' ? this.playerTeam
      : (this.bots.find((b) => b.id === best.e.id)?.team || 'blue');
    const normal = _v2.set(best.dx, 0.12, best.dz).normalize();
    // En red, el host también recibe el impacto autorizado y lo reproduce allí.
    if (!this.external) {
      this.cb.effects?.meleeImpact?.(point, TEAM_HEX[team], normal);
      this.cb.audio?.meleeImpact?.({ position: point }, killed);
    }
    return { connected: true, killed };
  }

  // Humo defensivo: el bot lo lanza hacia la amenaza para cortar la línea de
  // tiro mientras se reposiciona. Usa el MISMO sistema que el jugador, así
  // que la nube también le tapa la visión a él y a sus compañeros. Aquí solo
  // empieza la secuencia del jugador (sacar el bote, gesto, suelta, guardar):
  // el bote sale en botReleaseSmoke, desde la mano.
  botThrowSmoke(bot, threat) {
    const smoke = this.cb.smoke;
    // ni a mitad de una patada ni de otro cambio de arma (reglas del jugador)
    if (!smoke || bot.nades <= 0 || bot.throwPlan || bot.meleeT > 0 || bot.swapAnim > 0) return false;
    // lanzar es una acción de arma: la misma tabla que al jugador (no en sprint)
    if (!canFireInState(bot.netAnim || 'idle', 'grenade')) return false;
    bot.nadeCd = 12 + Math.random() * 8;
    bot.reloadT = 0; // sacar el bote interrumpe la recarga, como al jugador
    bot.throwPlan = { phase: 'draw', tx: threat.x, tz: threat.z, pending: false, release: false };
    bot._beginSwap('grenade');
    return true;
  }

  // Suelta (main.js throwSmoke): de la mano del rig, en el cuadro del
  // latigazo, con la velocidad del jugador (dir·throwSpeed + throwUp). La
  // dirección apunta a la mitad del camino hacia la amenaza (con tope), como
  // antes; el ángulo sale de la tabla de alcance en vez de un arco fijo.
  botReleaseSmoke(bot) {
    const smoke = this.cb.smoke, p = bot.throwPlan;
    // La patada puede llegar después de sacar el bote y antes de la suelta.
    // Conservarlo si el gesto se acaba mientras sigue impedido para lanzar.
    if (!smoke || !p || bot.nades <= 0 || !bot.alive || bot.dazeT > 0 || bot.protoStunned ||
        !canFireInState(bot.netAnim || 'idle', 'grenade') || bot.sinceSprint < sprintFireDelay('grenade')) return false;
    const g = TUNING.weapons.grenade;
    // salida como la del jugador (DECISIONES §4): 0.5 m delante del OJO de
    // la pose difundida, hacia donde lanza, con el tramo ojo→salida libre
    // (antes, desde la mano del rig). La mano solo es visual.
    const dx = p.tx - bot.pos.x, dz = p.tz - bot.pos.z;
    const d = Math.max(0.6, Math.hypot(dx, dz));
    this._botPose(bot); // el paso de la suelta ya movió y giró al bot
    const eye = bot._eye;
    _v1.set(eye[0], eye[1], eye[2]); _v2.set(dx / d, 0, dz / d);
    const free = this.world.raycast(_v1, _v2, 0.6);
    const out = free === null ? 0.5 : Math.max(0, free - 0.1);
    const hand = _v3.set(eye[0] + dx / d * out, eye[1], eye[2] + dz / d * out);
    // y el tramo pecho (y + 1.3) → salida libre, la regla del servidor para bots
    // (botOriginLegal): agachado pegado a un LOW, la salida se acerca al pecho
    _v1.set(bot.pos.x, bot.y + 1.3, bot.pos.z); _v2.set(hand.x - _v1.x, hand.y - _v1.y, hand.z - _v1.z);
    const cl = _v2.length();
    if (cl > 0.02) { _v2.multiplyScalar(1 / cl); const hit = this.world.raycast(_v1, _v2, cl);
      if (hit !== null) hand.copy(_v1).addScaledVector(_v2, Math.max(0, hit - 0.1)); }
    if (this.external) {
      const pose = bot.hostedPose, origin = hand.toArray();
      // El host puede haber enviado un impacto en este mismo cuadro. Su
      // resultado (incluidas baja y patada) precede al siguiente botState
      // en el socket FIFO. Esperar esa pose antes de descontar el bote.
      if (!pose?.alive || pose.w !== 'grenade' || pose.throwReady === false || pose.throwCt <= bot.lastIncomingHitCt ||
          performance.now() - bot.hostedPoseAt >= BOT_ORIGIN_LAG * 1000 ||
          !botPoseAllowsOrigin(this.world.layout, pose, origin) || mapPathBlocked(this.world.layout, eye, origin)) return false;
    }
    bot.nades--;
    const reach = Math.min(d * 0.55, 8);
    const lx = bot.pos.x + dx / d * reach - hand.x, lz = bot.pos.z + dz / d * reach - hand.z;
    const ll = Math.max(0.01, Math.hypot(lx, lz));
    const a = smokePitchFor(ll), ca = Math.cos(a);
    const origin = { x: hand.x, y: hand.y, z: hand.z };
    const velocity = {
      x: lx / ll * ca * g.throwSpeed,
      y: Math.sin(a) * g.throwSpeed + g.throwUp,
      z: lz / ll * ca * g.throwSpeed,
    };
    const cid = this.external ? `nb:${bot.id}:${++this._nadeSeq}` : null;
    smoke.throwNade(origin, velocity,
      cid ? { id: cid, authoritative: true } : undefined);
    this.cb.audio?.throwNade?.({ position: hand.clone() });
    bot.rig.kick?.(0.5);
    this.cb.botNade?.(bot, origin, velocity, cid);
    return true;
  }

  // ¿Es seguro lanzar un cohete a este blanco? Exige línea limpia y que
  // ningún COMPAÑERO (ni el propio bot) quede dentro del radio de la
  // explosión estimada. Es la regla que hace usable la bazooka en la IA.
  // Punto de lanzamiento del cohete: 0.5 m delante del OJO hacia el blanco,
  // como el del jugador (fpCam.launchPoint); el servidor lo valida contra
  // el cuerpo difundido (botOriginLegal).
  _launchPoint(bot, enemy, out) {
    const eye = this._eyeOf(bot);
    const tx = enemy.x - eye[0], ty = (enemy.y ?? 0) + 0.9 - eye[1], tz = enemy.z - eye[2];
    const l = Math.max(0.01, Math.hypot(tx, ty, tz));
    return out.set(eye[0] + tx / l * 0.5, eye[1] + ty / l * 0.5, eye[2] + tz / l * 0.5);
  }

  rocketPathClear(bot, enemy, dist) {
    const R = TUNING.weapons.bazooka.splashRadius;
    // el tramo ojo→salida debe estar libre (la regla que el servidor barre)
    const eye = this._eyeOf(bot);
    this._launchPoint(bot, enemy, _v1);
    _v2.set(_v1.x - eye[0], _v1.y - eye[1], _v1.z - eye[2]);
    const el = _v2.length(); _v2.normalize(); _v3.set(eye[0], eye[1], eye[2]);
    if (this.world.raycast(_v3, _v2, el + 0.05) !== null) return false;
    // pecho → salida también libre (servidor: botOriginLegal)
    _v3.set(bot.pos.x, bot.y + 1.3, bot.pos.z); _v2.set(_v1.x - _v3.x, _v1.y - _v3.y, _v1.z - _v3.z);
    const cl = _v2.length(); _v2.normalize();
    if (cl > 0.02 && this.world.raycast(_v3, _v2, cl) !== null) return false;
    _v2.set(enemy.x - _v1.x, (enemy.y ?? 0) + 0.9 - _v1.y, enemy.z - _v1.z);
    const len = _v2.length();
    _v2.normalize();
    // la trayectoria debe estar despejada: si pega en una pared cercana, el
    // splash vuelve sobre el propio bot
    const hit = this.world.raycast(_v1, _v2, len);
    if (hit !== null && hit < len - 0.6) return false;
    // pegado a una esquina el cohete nace DENTRO del bloque y detona en su
    // cara: exigir que los primeros metros de vuelo estén libres de verdad
    if (this.world.raycastHit) {
      const near = this.world.raycastHit(_v1, _v2, Math.min(len, R + 1.5));
      if (near) return false;
    }
    // compañeros cerca del punto de impacto o en la línea de vuelo
    for (const o of this.bots) {
      if (o === bot || !o.alive || o.team !== bot.team) continue;
      if (Math.hypot(o.pos.x - enemy.x, o.pos.z - enemy.z) < R + 1.2) return false;
      // proyección sobre la trayectoria: compañero atravesado por el cohete
      const px = o.pos.x - bot.pos.x, pz = o.pos.z - bot.pos.z;
      const proj = px * _v2.x + pz * _v2.z;
      if (proj > 0 && proj < len) {
        const perp = Math.hypot(px - _v2.x * proj, pz - _v2.z * proj);
        if (perp < 1.2) return false;
      }
    }
    // el jugador aliado también cuenta
    const p = this.cb.player?.();
    if (p?.alive && this.playerTeam === bot.team &&
        Math.hypot(p.x - enemy.x, p.z - enemy.z) < R + 1.2) return false;
    return true;
  }

  // Disparo de cohete de un bot: proyectil REAL (mismo sistema del jugador),
  // con su bando para que el splash respete a los compañeros.
  botFireRocket(bot, enemy) {
    const rockets = this.cb.rockets;
    if (!rockets) return false;
    this._launchPoint(bot, enemy, _v1);
    // humo comprobado AL LANZAR, como en botShoot: no se dispara a un blanco
    // que la nube acaba de tapar (devuelve false: ni cohete ni munición)
    if (this.cb.smoke?.blocksSegment(_v1.x, _v1.y, _v1.z, enemy.x, (enemy.y ?? 0) + 0.9, enemy.z)) return false;
    _v2.set(enemy.x - _v1.x, (enemy.y ?? 0) + 0.9 - _v1.y, enemy.z - _v1.z).normalize();
    bot.rig?.fireWeaponParts?.();
    this.cb.audio?.gun?.('bazooka', { position: _v1.clone() });
    const cid = this.external ? `b:${bot.id}:${++this._rocketSeq}` : null;
    rockets.fire({ x: _v1.x, y: _v1.y, z: _v1.z }, _v2.clone(), true,
      { team: bot.team, id: bot.id, name: bot.name }, cid, this.external);
    this.cb.botRocket?.(bot,
      { x: _v1.x, y: _v1.y, z: _v1.z },
      { x: _v2.x, y: _v2.y, z: _v2.z }, cid);
    return true;
  }

  // El bot toma el arma especial del pedestal (mismo pedestal y misma regla
  // de exclusividad que el jugador: quien completa el hold se la lleva).
  botTakeSpecial(bot) {
    // En online el host propone el reclamo, pero el servidor decide y después
    // concede mediante el broadcast. No consumir el pedestal solo localmente.
    if (this.cb.claimBotSpecial) { this.cb.claimBotSpecial(bot); return; }
    const specials = this.cb.specials;
    const wep = specials?.take?.();
    if (!wep) return;
    bot.wep = wep; bot.special = wep;
    bot.specialAmmo = TUNING.weapons[wep].mag + TUNING.weapons[wep].reserve;
    bot.swapCd = 2.5;
    bot.throwPlan = null; bot.throwT = 0;
    bot.reloadT = 0; // cambiar de arma interrumpe la recarga (como _trySwap y el jugador)
    bot._beginSwap(wep);
    this.specialSeeker[bot.team] = null; // reclamo cumplido: liberar
    this.cb.hud?.hint?.(t('msg.specialTakenBy', { name: bot.name, weapon: t(TUNING.weapons[wep].nameKey) }), 2000);
  }

  grantBotSpecial(id, wep) {
    const bot = this.botById(id);
    if (!bot || !bot.alive || !TUNING.weapons[wep]?.special) return false;
    this.cb.specials?.clear?.();
    bot.wep = wep; bot.special = wep;
    bot.specialAmmo = TUNING.weapons[wep].mag + TUNING.weapons[wep].reserve;
    bot.swapCd = 2.5;
    bot.throwPlan = null; bot.throwT = 0;
    bot.reloadT = 0; // cambiar de arma interrumpe la recarga (como _trySwap y el jugador)
    bot._beginSwap(wep);
    this.specialSeeker[bot.team] = null;
    this.cb.hud?.hint?.(t('msg.specialTakenBy', { name: bot.name, weapon: t(TUNING.weapons[wep].nameKey) }), 2000);
    return true;
  }

  // Puntería de un bot: apunta al pecho (o a la cabeza si un bloque bajo
  // tapa el pecho) y NO dispara a lo que no ve. El tiro sale con la
  // orientación real del cuerpo (el retraso al seguir a alguien que corre es
  // un fallo de verdad) más un error que se corrige mientras sigue al mismo
  // blanco y crece si el bot se mueve. Devuelve false si no hubo tiro.
  botShoot(bot, enemy) {
    const def = TUNING.weapons[bot.wep];
    // FPS: el tiro sale del OJO de la pose difundida (eyeWorld), como el del
    // jugador; antes, de y + 1.35 aunque estuviera agachado
    const eye = this._eyeOf(bot);
    _v1.set(eye[0], eye[1], eye[2]);
    // al pecho; si un bloque lo tapa, a la cabeza; si solo asoma el casco
    // (blindfire por encima del bloque), al casco. Puntos del volumen real;
    // con las poses de siempre, los de antes (0.72/1.1 y 0.95/1.5).
    const ey = enemy.y ?? 0;
    const pts = this._aimPts ??= [[0, 0, 0, 0.45], [0, 0, 0, 0.35], [0, 0, 0, 0.35]];
    pts[0][0] = enemy.cx ?? enemy.x; pts[0][1] = enemy.cy ?? ey + (enemy.crouch ? 0.72 : 1.1); pts[0][2] = enemy.cz ?? enemy.z;
    pts[1][0] = enemy.hx ?? enemy.x; pts[1][2] = enemy.hz ?? enemy.z;
    pts[1][1] = enemy.legacy === false ? enemy.hy : ey + (enemy.crouch ? 0.95 : 1.5);
    pts[2][0] = enemy.hx ?? enemy.x; pts[2][2] = enemy.hz ?? enemy.z;
    pts[2][1] = enemy.hy != null ? enemy.hy + enemy.hr * 0.7 : NaN;
    let aim = null;
    for (const q of pts) {
      if (!Number.isFinite(q[1])) continue;
      _v2.set(q[0] - _v1.x, q[1] - _v1.y, q[2] - _v1.z);
      const len = _v2.length();
      // del ojo al punto del volumen (hasta 5 cm de él: un bloque pegado al
      // blanco TAPA; antes se ignoraban sus últimos 35–45 cm)
      if (this.world.raycast(_v1, _v2.normalize(), Math.max(0, len - 0.05)) === null) { aim = q; break; }
    }
    if (!aim) return false;
    // el humo se comprueba AL DISPARAR, no solo al percibir (cada 0,1 s): un
    // blanco que la nube acaba de tapar no recibe un tiro apuntado
    if (this.cb.smoke?.blocksSegment(_v1.x, _v1.y, _v1.z, aim[0], aim[1], aim[2])) return false;
    const aimY = aim[1];
    // el cuerpo sigue al centro del blanco; el tiro va al punto elegido
    // (cabeza en lean, casco desplazado) con el mismo error humano
    const offYaw = angDelta(Math.atan2(-(enemy.x - _v1.x), -(enemy.z - _v1.z)),
      Math.atan2(-(aim[0] - _v1.x), -(aim[2] - _v1.z)));
    const flat = Math.max(0.01, Math.hypot(aim[0] - _v1.x, aim[2] - _v1.z));
    // error correlacionado entre tiros (una ráfaga se va hacia un lado)
    const sniper = bot.wep === 'sniper';
    const sigma = (sniper ? bot.aimSigma * 0.4 : bot.aimSigma) + ((bot.speed ?? 0) > 0.6 ? AIM.moving : 0);
    bot.aimEx = bot.aimEx * 0.55 + gauss() * sigma * 0.83;
    bot.aimEy = bot.aimEy * 0.55 + gauss() * sigma * 0.6;
    const yaw = bot.yaw + offYaw + bot.aimEx;
    const pitch = Math.atan2(aimY - _v1.y, flat) + bot.aimEy;
    const cp = Math.cos(pitch);
    _v3.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    // dispersión del JUGADOR para esa arma y ese estado (spreadFor: la misma
    // que la retícula), además del error humano de arriba
    const spread = spreadFor(bot.wep, { aim: !!bot.aim, moving: Math.min(1, (bot.speed ?? 0) / TUNING.fp.runSpeed),
      crouched: bot.animState() === 'crouch' && bot.ce < 0.5, airborne: !bot.grounded, sinceSprint: bot.sinceSprint ?? 99 });
    const pellets0 = def.pellets || 1;
    const baseDir = pellets0 > 1 ? applySpread(_v3, 1.2) : spread > 0 ? applySpread(_v3, spread) : _v3;
    bot.rig?.fireWeaponParts?.();
    this._shotBy(bot);
    const targets = this._enemiesOf(bot);
    const pellets = def.pellets || 1;
    const dmgAcc = new Map();
    const shotOrigin = _v1.clone();
    let shotPoint = null;
    const impactPoints = [];
    for (let i = 0; i < pellets; i++) {
      const dir = pellets > 1
        ? applyPelletPattern(baseDir, spread || def.spreadHip, i, pellets)
        : baseDir;
      const hit = resolveShot(this.world, targets, _v1, dir, def.range, bot.id);
      if (!shotPoint) shotPoint = hit.point.clone();
      if (i === 0) {
        // solo visual: tracer y fogonazo salen del arma del bot, con el color de su equipo
        const from = bot.rig?.muzzleWorld ? bot.rig.muzzleWorld(_v2) : _v2.copy(_v1);
        // con el arma muy picada el cañón queda bajo el suelo: se sube solo el
        // efecto, como en main.js (fxAboveGround); el tiro no cambia
        const floor = this.world.groundHeight(from, 0, bot.y + 0.25) + 0.04;
        if (from.y < floor) from.y = floor;
        this.cb.effects.tracer(from, hit.point, false, { team: bot.team, weapon: bot.wep });
        this.cb.effects.muzzleFlash?.(from, bot.wep === 'shotgun', { weapon: bot.wep, to: hit.point, team: bot.team });
      }
      if (hit.kind === 'player') {
        let dmg = def.dmg * BOT_DMG;
        dmg *= damageFalloff(def, hit.t);
        if (hit.part === 'head') dmg *= def.headMult;
        const acc = dmgAcc.get(hit.id) || {
          dmg: 0, part: hit.part, dist: hit.t, point: hit.point.clone(), pellets: 0,
        };
        acc.dmg += dmg;
        acc.pellets++;
        acc.dist = Math.min(acc.dist, hit.t);
        if (hit.part === 'head') acc.part = 'head';
        dmgAcc.set(hit.id, acc);
      } else if (hit.kind === 'world') {
        // Cada pellet deja su marca; Effects limita/presupuesta las partículas.
        this.cb.effects.impact(hit.point, hit.normal, hit.surface, { origin: _v1 });
        this.cb.audio.impact(hit.point, hit.surface);
        impactPoints.push(hit.point.clone());
      }
    }
    const shotAudio = { position: { x: bot.pos.x, y: bot.y + 1.35, z: bot.pos.z }, end: shotPoint, team: bot.team };
    // cada bot suena con SU arma (antes todo lo que no era escopeta era SMG)
    this.cb.audio.gun(bot.wep, shotAudio);
    if (this.external && shotPoint) {
      this.cb.botFire?.(bot, shotOrigin, shotPoint, bot.wep, impactPoints);
    }
    for (const [id, hitCtx] of dmgAcc) {
      const dmg = hitCtx.dmg;
      const gib = bot.wep === 'shotgun' && hitCtx.dist <= TUNING.weapons.shotgun.gibRange;
      const deathCtx = {
        weapon: bot.wep, distance: hitCtx.dist, damage: dmg,
        part: hitCtx.part, point: hitCtx.point, gib,
      };
      if (this.external) {
        this.cb.botHit?.(bot, id, dmg, hitCtx.part, gib, hitCtx.point, {
          pellets: hitCtx.pellets,
        });
        continue;
      }
      if (id === 'player') {
        this.cb.effects.blood(_v3.set(this.cb.player().x, 1, this.cb.player().z), TEAM_HEX[this.playerTeam]);
        const died = this.cb.damagePlayer(dmg, bot.name, { x: bot.pos.x, z: bot.pos.z }, deathCtx);
        if (died) {
          if (gib) this.cb.effects.gib(_v3.set(this.cb.player().x, this.cb.player().y || 0, this.cb.player().z), TEAM_HEX[this.playerTeam]);
          this._onDeath('player', bot.id, gib, deathCtx);
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
    if (att) {
      // Un humano al que le pegan sabe DE DÓNDE (indicador de daño), no el
      // punto exacto si no ve al tirador: sin línea de visión, error de
      // hasta 4 m que crece con la distancia (antes, la posición exacta).
      const ar = this.motion.get(from);
      if (ar && b._eye && !this._seesVolume(b._eye, ar)) {
        const err = Math.min(4, Math.hypot(att.x - b.pos.x, att.z - b.pos.z) * 0.12);
        att.x += (Math.random() - 0.5) * 2 * err; att.z += (Math.random() - 0.5) * 2 * err;
      }
      b.lastThreat = { x: att.x, z: att.z, age: 0 };
      // el equipo se entera de dónde viene el fuego; los compañeros cercanos
      // oyen el tiroteo y miran hacia allí
      this._report(b.team, from, att.x, att.z);
      for (const o of this.bots) {
        if (o === b || !o.alive || o.team !== b.team) continue;
        if (Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z) > 18) continue;
        const a = o.alert ??= { x: 0, z: 0, age: 99 };
        a.x = att.x; a.z = att.z; a.age = 0;
      }
    }
    if (att && hitCtx?.weapon === 'melee') {
      const dx = b.pos.x - att.x, dz = b.pos.z - att.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      const rightX = Math.cos(b.yaw), rightZ = -Math.sin(b.yaw);
      const side = (dx * rightX + dz * rightZ) / len;
      b.rig.hitReact(side, Math.min(1.2, dmg / 50), 'melee');
      b.pos.x += (dx / len) * 0.13;
      b.pos.z += (dz / len) * 0.13;
      this.world.resolveCircle(b.pos, 0.38, b.y);
      b.commitMove = false; // vuelve a evaluar: ya no sigue corriendo ciego
      b.decisionT = 0;
    }
    if (b.hp > 0 && ['bazooka','frag'].includes(hitCtx?.weapon)) {
      const raw = hitCtx.explosionPoint;
      const blast = Array.isArray(raw)
        ? { x: raw[0], z: raw[2] }
        : raw;
      if (blast && Number.isFinite(blast.x) && Number.isFinite(blast.z)) {
        const dx = b.pos.x - blast.x, dz = b.pos.z - blast.z;
        const len = Math.max(0.08, Math.hypot(dx, dz));
        const push = Math.max(0.09, Math.min(0.34, (+dmg || 0) / 260));
        b.pos.x += dx / len * push;
        b.pos.z += dz / len * push;
        this.world.resolveCircle(b.pos, 0.38, b.y);
        const side = (dx * Math.cos(b.yaw) + dz * -Math.sin(b.yaw)) / len;
        b.rig.hitReact(side, Math.min(1.2, 0.45 + (+dmg || 0) / 85), 'explosion');
        b.commitMove = false;
        b.decisionT = 0;
      }
    }
    if (!silent) this.cb.effects.blood(_v3.set(b.pos.x, b.y + 1, b.pos.z), TEAM_HEX[b.team]);
    if (b.hp <= 0) {
      b.alive = false;
      const sniperHeadshot = isSniperHeadshotDeath(hitCtx);
      const explosiveLevel = rocketDeathLevel(hitCtx);
      const impactPoint = deathImpactPoint(hitCtx, { x: b.pos.x, y: b.y, z: b.pos.z });
      const blast = hitCtx?.explosionPoint;
      const deathImpact = blast && Number.isFinite(blast.x)
        ? { x: b.pos.x - blast.x, z: b.pos.z - blast.z }
        : att ? { x: b.pos.x - att.x, z: b.pos.z - att.z } : null;
      // contexto físico del ragdoll: de dónde vino el tiro final, con qué
      // fuerza (daño del golpe), y el momentum/estado que llevaba el bot
      b.rig.setDeathContext({
        impact: deathImpact,
        power: explosiveLevel ? 1 : Math.min(1, dmg / 55) + (gib ? 0.35 : 0),
        vel: { x: b.velX ?? 0, z: b.velZ ?? 0 },
        // estado DIBUJADO, como animState() del jugador: el de la IA
        // ('advance', 'cover' corriendo hacia el bloque...) no es una pose
        state: b.netAnim || 'idle',
        weapon: hitCtx?.weapon,
        distance: hitCtx?.distance,
        damage: hitCtx?.damage ?? dmg,
        part: hitCtx?.part,
        point: impactPoint,
        sniperHeadshot,
        rocketDeathLevel: explosiveLevel,
        explosionPoint: hitCtx?.explosionPoint,
        gib: !!gib,
      });
      if (sniperHeadshot) {
        const direction = att
          ? { x: b.pos.x - att.x, y: 0.1, z: b.pos.z - att.z }
          : null;
        this.cb.effects.sniperHeadshot(impactPoint, TEAM_HEX[b.team], direction, b.y);
      } else if (explosiveLevel) {
        this.cb.effects.rocketDeath(
          { x: b.pos.x, y: b.y, z: b.pos.z }, TEAM_HEX[b.team],
          explosiveLevel, deathImpact, b.y);
      } else if (gib) {
        this.cb.effects.gib(_v3.set(b.pos.x, b.y, b.pos.z), TEAM_HEX[b.team]);
      }
      this._onDeath(id, from, gib, hitCtx);
      return true;
    }
    return false;
  }

  // Muerte del jugador SIN bot asesino (autodaño de bazooka): registra la
  // baja, consume vida del pool y agenda el respawn igual que cualquier kill.
  // killerId null: sin killfeed y sin regalar un kill por suicidarse.
  playerSelfDeath() { this._onDeath('player', null, false); }

  // hitCtx (opcional): { weapon, part } del golpe final, para feed y confirmación
  _onDeath(victimId, killerId, gib, hitCtx = null) {
    this.coverClaims.delete(victimId); // el muerto suelta su reserva de cover
    this.releaseTacticalClaim(victimId);
    // quien cae cerca "canta" al asesino: sus compañeros miran hacia él y el
    // equipo lo tiene ubicado (así se vengan bajas en vez de seguir de largo)
    const vr = this.motion.get(victimId), kr = killerId ? this.motion.get(killerId) : null;
    if (vr && kr && vr.team !== kr.team) {
      this._report(vr.team, kr.id, kr.x, kr.z);
      for (const o of this.bots) {
        if (!o.alive || o.team !== vr.team || o.id === victimId) continue;
        if (Math.hypot(o.pos.x - vr.x, o.pos.z - vr.z) > 25) continue;
        const a = o.alert ??= { x: 0, z: 0, age: 99 };
        a.x = kr.x; a.z = kr.z; a.age = 0;
      }
    }
    // el que iba por el arma especial ya no va: liberar para otro
    for (const team of ['red', 'blue']) {
      if (this.specialSeeker[team] === victimId) this.specialSeeker[team] = null;
    }
    const v = this.stats.get(victimId), k = this.stats.get(killerId);
    if (v) v.deaths++;
    if (k) k.kills++;
    // el arma del bot cae junto a su cuerpo (la del jugador la suelta main)
    if (victimId !== 'player') {
      const b = this.bots.find((x) => x.id === victimId);
      // si lleva la especial guardada (bandas de distancia), cae la especial
      if (b) this.cb.dropWeapon?.(b.special && b.specialAmmo > 0 ? b.special : b.wep, b.pos.x, b.pos.z, b.team, b.y, b.rig, b.specialAmmo);
    }
    const head = hitCtx?.part === 'head';
    if (v && k) this.cb.hud.kill(k.name, k.team, v.name, v.team, { weapon: hitCtx?.weapon, head,
      local: killerId === 'player' ? 'killer' : victimId === 'player' ? 'victim' : null });
    if (killerId === 'player') {
      this.cb.audio.kill(head);
      this.cb.hud.hitmarker('kill');
      if (victimId !== 'player') this.cb.hud.killConfirm?.(v?.name, hitCtx?.weapon, head);
    }
    const team = v?.team;
    if (!team || this.phase !== 'playing') return;
    if (this.pool[team] > 0) {
      this.pool[team]--;
      this.respawnQueue.push({
        id: victimId,
        t: nextRespawnWave(ROUND_TIME - this.timer) - (ROUND_TIME - this.timer),
        waveAt: nextRespawnWave(ROUND_TIME - this.timer),
      });
    }
    this._checkRoundEnd();
  }

  _checkRoundEnd() {
    for (const team of ['red', 'blue']) {
      if (this.livesOf(team) <= 0) {
        this._holdRoundResult(team === 'red' ? 'blue' : 'red');
        return;
      }
    }
  }

  _holdRoundResult(winner) {
    if (this.phase !== 'playing') return;
    // La baja decisiva permanece en cámara antes de que aparezca cualquier
    // overlay. Se detienen respawns/decisiones nuevas, pero el jugador conserva
    // la cámara y los ragdolls continúan asentándose.
    this.phase = 'round-finish';
    this.phaseT = ROUND_FINISH_HOLD;
    this.pendingRoundWinner = winner;
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
  }

  _endRound(winner) {
    if (this.phase !== 'playing' && this.phase !== 'round-finish') return;
    this.phase = 'intermission';
    this.phaseT = ROUND_RESULT_TIME;
    this.pendingRoundWinner = null;
    this.roundWinner = winner;
    this.respawnQueue = [];
    this.coverClaims.clear();
    this.tacticalClaims.clear();
    if (winner) this.wins[winner]++;
    const w = this.wins;
    if (winner && w[winner] >= Math.floor(this.roundLimit / 2) + 1) {
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
    if (this.external) {
      this.phase = this.cb.playing?.() === false ? 'countdown' : 'playing';
      if (this.phase !== 'playing') { this._idleBots(dt); return; }
      this._trackMotion(dt);
      for (const team of ['red', 'blue']) {
        const h = this.enemyHeat[team];
        const k = Math.exp(-dt / 5);
        h[0] *= k; h[1] *= k; h[2] *= k;
      }
      for (const b of this.bots) b.update(dt, this);
      return;
    }
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
    if (this.phase === 'round-finish') {
      this.phaseT -= dt;
      // Mantener vivas las reacciones físicas sin permitir que la IA arranque
      // otra decisión táctica después de la baja final.
      this._idleBots(dt);
      if (this.phaseT <= 0) this._endRound(this.pendingRoundWinner);
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
    this._trackMotion(dt);
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const q = this.respawnQueue[i];
      q.t = q.waveAt - (ROUND_TIME - this.timer);
      if (q.t <= 0) {
        this.respawnQueue.splice(i, 1);
        if (q.id === 'player') {
          this.cb.respawnPlayer(this.world.spawns[this.playerTeam][Math.floor(Math.random() * 4)]);
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

  botById(id) { return this.bots.find((b) => b.id === id) || null; }

  // ONLINE, partida empezada: el servidor cambia el roster cuando un humano
  // releva a un bot o cuando un bot cubre a quien se fue. El anfitrión, que
  // simula a los bots, los da de baja y de alta sin reiniciar la partida.
  removeExternalBot(id) {
    const i = this.bots.findIndex((b) => b.id === id);
    if (i < 0) return false;
    const [bot] = this.bots.splice(i, 1);
    this.coverClaims.delete(id);
    this.releaseTacticalClaim(id);
    for (const team of ['red', 'blue']) {
      if (this.specialSeeker[team] === id) this.specialSeeker[team] = null;
    }
    this.respawnQueue = this.respawnQueue.filter((q) => q.id !== id);
    this.stats.delete(id);
    bot.dispose(this.scene);
    return true;
  }

  addExternalBot(slot) {
    if (this.botById(String(slot.id))) return null;
    const team = slot.team === 'blue' ? 'blue' : 'red';
    const spawn = slot.spawn || this.world.spawns[team][0];
    const bot = new Bot(this.scene, this.world, String(slot.id), String(slot.name), team, spawn, slot.variant);
    bot.rig.setNameTagThroughWalls(team === this.playerTeam);
    this.bots.push(bot);
    this.stats.set(bot.id, { name: bot.name, team, kills: 0, deaths: 0, variant: bot.variant });
    // cubre a un jugador eliminado: espera el turno de reaparición del server
    if (slot.alive === false) { bot.alive = false; bot.hp = 0; }
    else this._assignRespawnPlan(bot);
    return bot;
  }

  respawnExternal(id, spawn) {
    const bot = this.botById(id);
    if (!bot) return;
    bot.respawn(spawn);
    this._assignRespawnPlan(bot);
  }

  killExternal(id, ctx = {}) {
    const bot = this.botById(id);
    if (!bot || !bot.alive) return;
    bot.alive = false;
    bot.rig.setDeathContext({
      impact: ctx.impact || null,
      power: ctx.gib || ctx.rocketDeathLevel ? 1 : ctx.sniperHeadshot ? 0.95 : 0.6,
      vel: { x: bot.velX || 0, z: bot.velZ || 0 },
      state: bot.netAnim || 'idle',
      weapon: ctx.weapon, distance: ctx.distance, damage: ctx.damage,
      part: ctx.part, point: ctx.point, sniperHeadshot: !!ctx.sniperHeadshot,
      rocketDeathLevel: Math.max(0, Math.min(2, Math.round(ctx.rocketDeathLevel || 0))),
      explosionPoint: ctx.explosionPoint,
      gib: !!ctx.gib,
    });
  }
}
