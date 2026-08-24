// BREACH: lobby persistente 4v4 por WebSocket + dist/ por HTTP.
// El enlace del servidor identifica la sesion. Vida, respawns, rounds y
// validacion de configuracion permanecen autoritativos en el servidor.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  DEFAULT_LOBBY_SETTINGS, MAP_RUNTIME, MAX_PLAYERS, TEAM_CAPACITY, makeBotName,
  nextLobbyMap, normalizeLobbySettings, teamCounts, validateLobby,
} from '../src/game/lobby-rules.js';
import { ROUND_FINISH_HOLD as DEFAULT_ROUND_FINISH_HOLD } from '../src/game/match-flow.js';
import { TUNING } from '../src/config/tuning.js';
import { damageFalloff, firearmDamage, rocketSplashDamage } from '../src/combat/damage.js';
import { isSniperHeadshotDeath, rocketDeathLevel } from '../src/combat/death-reactions.js';
import { makeSmokeProjectile, stepSmokeProjectile } from '../src/game/smoke-physics.js';
import {
  MAX_WS_PAYLOAD, MessageRateGuard, acceptMovement, consumeShotAmmo,
  createAmmoBudget, grantWeaponAmmo, refillNormalAmmo, resetMovementGuard,
} from './guards.js';
import {
  clipMapEndpoint, mapLineBlocked, mapSurfaceContact, projectileMapContact,
  serverMapPhysics,
} from './map-geometry.js';

const PORT = process.env.PORT || 8787;
const HP = TUNING.combat.hp, REGEN_DELAY = TUNING.combat.regenDelay,
  REGEN_RATE = TUNING.combat.regenRate, RESPAWN_TIME = TUNING.combat.respawnTime;
const INTRO_TIME = Number(process.env.INTRO_TIME ?? 10);
const COUNTDOWN_TIME = Number(process.env.COUNTDOWN_TIME ?? 3);
const ROUND_FINISH_HOLD = Number(process.env.ROUND_FINISH_HOLD ?? DEFAULT_ROUND_FINISH_HOLD);
const INTERMISSION_TIME = Number(process.env.INTERMISSION_TIME ?? 5);
const FINAL_TIME = Number(process.env.FINAL_PRESENTATION_TIME ?? 11);
const SPAWN_PROT = 5, CRATE_RESPAWN = 30, DROP_LIFE = 8, TICK_HZ = 20;
const CRATES = [{ up: true, t: 0 }, { up: true, t: 0 }];
const WD = TUNING.weapons;
const FIRE_RULES = {
  smg: { interval: 60 / WD.smg.rpm, range: WD.smg.range,
    maxDamage: WD.smg.dmg * WD.smg.headMult },
  shotgun: { interval: 60 / WD.shotgun.rpm, range: WD.shotgun.range,
    maxDamage: WD.shotgun.pellets * WD.shotgun.dmg, gibRange: WD.shotgun.gibRange },
  pistol: { interval: 60 / WD.pistol.rpm, range: WD.pistol.range,
    maxDamage: WD.pistol.dmg * WD.pistol.headMult },
  sniper: { interval: 60 / WD.sniper.rpm, range: WD.sniper.range,
    maxDamage: WD.sniper.dmg * WD.sniper.headMult },
  // La trayectoria/splash de bazooka se resuelve en activeRockets. La regla
  // conserva cadencia/rango como fuente común de balance.
  bazooka: { interval: 60 / WD.bazooka.rpm, range: WD.bazooka.range,
    maxDamage: WD.bazooka.dmg * 3, hitRange: WD.bazooka.splashRadius + 0.8 },
  // tolerancia de red pequeña sobre los 1.82 m físicos del cliente
  melee: { interval: 0.4, range: 1.95, hitRange: 1.95, maxDamage: TUNING.melee.dmg },
};
// ids replicables en 'w' (la granada solo aparece EN MANO, nunca dispara aquí)
const VALID_WEAPONS = new Set(['smg', 'shotgun', 'pistol', 'grenade', 'sniper', 'bazooka']);
const SPECIAL_WEAPONS = new Set(['sniper', 'bazooka']);
const FIREABLE = new Set(Object.keys(FIRE_RULES));
const clampWep = (w) => (VALID_WEAPONS.has(w) ? w : 'smg');
// la granada no es un arma soltable: el drop degrada a smg
const clampDropWep = (w) => (VALID_WEAPONS.has(w) && w !== 'grenade' ? w : 'smg');
const HIT_WINDOW = .28;
const NADE_RELAY_INTERVAL = 60 / WD.grenade.rpm * .82;
const ROCKET_RELAY_INTERVAL = FIRE_RULES.bazooka.interval * .82;
const ROCKET_SPEED = WD.bazooka.projSpeed;
const ROCKET_FUSE_RADIUS = 0.7;
const ROCKET_SURFACE_OFFSET = 0.28;
const SMOKE_PHYSICS_STEP = 1 / 60;
const SMOKE_FUSE = Number(process.env.SMOKE_FUSE ?? WD.grenade.fuse);
const SMOKE_TIME = Number(process.env.SMOKE_TIME ?? WD.grenade.smokeTime);
const VALID_STATES = new Set(['idle', 'run', 'roadie', 'dive', 'slide', 'cover_low',
  'cover_high', 'blind_over', 'blind_low_left', 'blind_low_right',
  'blind_high_left', 'blind_high_right', 'jump', 'flip', 'mantle', 'melee', 'dead']);
const CROUCH_STATES = new Set(['cover_low', 'blind_over', 'blind_low_left', 'blind_low_right']);
const POSE_HISTORY_TIME = 0.75;
const CLAIM_POSITION_TOLERANCE = 0.82;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm' };
const ALLOW_TEST_TELEPORTS = process.env.NODE_ENV === 'test' && process.env.ALLOW_TEST_TELEPORTS === '1';
function textResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    textResponse(res, 405, 'method not allowed'); return;
  }
  let urlPath;
  try { urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]); }
  catch { textResponse(res, 400, 'bad request'); return; }
  if (urlPath.includes('\0')) { textResponse(res, 400, 'bad request'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.resolve(DIST, urlPath.replace(/^[\\/]+/, ''));
  const relative = path.relative(DIST, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    textResponse(res, 404, 'not found'); return;
  }
  let stat;
  try { stat = fs.statSync(file); } catch {
    textResponse(res, 404, fs.existsSync(DIST) ? 'not found' : 'Falta dist/: corre "npm run build" primero.');
    return;
  }
  if (stat.isDirectory()) { textResponse(res, 404, 'not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) textResponse(res, 500, 'read error'); else res.destroy(); });
  stream.pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD });
const players = new Map(), bots = new Map(), drops = new Map();
const activeRockets = new Map(), activeNades = new Map(), activeSmokes = new Map();
let nextId = 1, nextBotId = 1, nextDropId = 1;
let nextRocketId = 1, nextNadeId = 1, hostId = null;
let settings = { ...DEFAULT_LOBBY_SETTINGS }, phase = 'empty', phaseTimer = null, startAt = 0, round = 0;
let wins = { red: 0, blue: 0 }, pools = { red: 0, blue: 0 };

const nowSec = () => Date.now() / 1000;
function resetPoseHistory(entity, now = nowSec()) {
  entity.poseHistory = [{ at: now, x: entity.x || 0, y: entity.y || 0,
    z: entity.z || 0, st: entity.st || 'idle' }];
}
function recordPose(entity, now = nowSec()) {
  entity.poseHistory ||= [];
  entity.poseHistory.push({ at: now, x: entity.x || 0, y: entity.y || 0,
    z: entity.z || 0, st: entity.st || 'idle' });
  while (entity.poseHistory.length > 2 && entity.poseHistory[0].at < now - POSE_HISTORY_TIME) {
    entity.poseHistory.shift();
  }
}
function poseForClaim(target, point, now) {
  if (!point) return null;
  const candidates = (target.poseHistory || []).filter((pose) => pose.at >= now - POSE_HISTORY_TIME);
  candidates.push({ at: now, x: target.x || 0, y: target.y || 0,
    z: target.z || 0, st: target.st || 'idle' });
  let best = null, bestDistance = Infinity;
  for (const pose of candidates) {
    const relY = point[1] - pose.y;
    const crouched = CROUCH_STATES.has(pose.st);
    if (relY < 0.12 || relY > (crouched ? 1.18 : 1.88)) continue;
    const distance = Math.hypot(point[0] - pose.x, point[2] - pose.z);
    if (distance < bestDistance) { bestDistance = distance; best = pose; }
  }
  return bestDistance <= CLAIM_POSITION_TOLERANCE ? best : null;
}
const send = (ws, obj) => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); };
function sendRaw(ws, data) { if (ws?.readyState === 1) ws.send(data); }
function broadcastRaw(obj) { const data = JSON.stringify(obj); for (const p of players.values()) sendRaw(p.ws, data); }
function broadcastRawExcept(ws, obj) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) if (p.ws !== ws) sendRaw(p.ws, data);
}
const allSlots = () => [...players.values(), ...bots.values()];
const inMatch = () => ['intro', 'countdown', 'playing', 'round-finish', 'intermission', 'final'].includes(phase);
const isHost = (p) => !!p && p.id === hostId;

function spawnSet(map, team) {
  const z = MAP_RUNTIME[map]?.spawnZ ?? MAP_RUNTIME.fortaleza.spawnZ;
  return Array.from({ length: 4 }, (_, i) => {
    const x = -3.6 + i * 2.4;
    return { x: team === 'red' ? x : -x, z: team === 'red' ? -z : z, yaw: team === 'red' ? Math.PI : 0 };
  });
}
function pickSpawn(team, index = -1) {
  const set = spawnSet(settings.map, team);
  return set[index >= 0 ? index % set.length : Math.floor(Math.random() * set.length)];
}
function pub(p) {
  return { id: p.id, name: p.name, team: p.team, bot: p.bot ? 1 : 0,
    host: p.id === hostId ? 1 : 0, alive: !!p.alive, hp: Math.round(p.hp ?? HP),
    x: p.x ?? 0, z: p.z ?? 0, y: p.y ?? 0, v: p.v ?? 0,
    kills: p.kills ?? 0, deaths: p.deaths ?? 0 };
}
function statRows() {
  return allSlots().map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot ? 1 : 0,
    variant: p.v ?? 0, kills: p.kills ?? 0, deaths: p.deaths ?? 0, score: (p.kills ?? 0) * 100 }))
    .sort((a, b) => b.score - a.score || a.deaths - b.deaths || a.name.localeCompare(b.name));
}
function lobbyPayload() {
  const slots = allSlots();
  return { t: 'lobby', phase: phase === 'empty' ? 'lobby' : phase, hostId,
    settings: { ...settings }, players: [...players.values()].map(pub), bots: [...bots.values()].map(pub),
    validation: validateLobby(slots, settings), maxPlayers: MAX_PLAYERS, teamCapacity: TEAM_CAPACITY };
}
function broadcastLobby() { if (players.size) broadcastRaw(lobbyPayload()); }
function lobbyError(ws, code, detail = '') { send(ws, { t: 'lobbyError', code, detail }); }
function clearTimer() { if (phaseTimer) clearTimeout(phaseTimer); phaseTimer = null; }
// Arma ESPECIAL del mapa: una por ronda, alternando (impar sniper, par
// bazooka). El servidor es la ÚNICA autoridad de quién se la lleva: dos
// jugadores que la reclaman a la vez producen un solo ganador.
let special = { wep: null, taken: true, by: null };
const firstSpecial = process.env.SPECIAL_FIRST_WEAPON === 'bazooka' ? 'bazooka' : 'sniper';
function specialForRound(r) {
  return r % 2 === 1 ? firstSpecial : (firstSpecial === 'sniper' ? 'bazooka' : 'sniper');
}
function clearActiveRockets(notify = true) {
  if (!activeRockets.size) return;
  activeRockets.clear();
  if (notify && players.size) broadcastRaw({ t: 'rocketClear' });
}
function clearActiveSmoke(notify = true) {
  if (!activeNades.size && !activeSmokes.size) return;
  activeNades.clear();
  activeSmokes.clear();
  if (notify && players.size) broadcastRaw({ t: 'smokeClear' });
}
function resetWorld() {
  drops.clear(); clearActiveRockets(); clearActiveSmoke();
  for (const c of CRATES) { c.up = true; c.t = 0; }
}
function resetRoom() {
  clearTimer(); players.clear(); bots.clear(); drops.clear(); activeRockets.clear();
  activeNades.clear(); activeSmokes.clear(); hostId = null;
  settings = { ...DEFAULT_LOBBY_SETTINGS }; phase = 'empty'; startAt = 0; round = 0;
  wins = { red: 0, blue: 0 }; pools = { red: 0, blue: 0 }; resetWorld();
}
function assignTeam() {
  const c = teamCounts(allSlots());
  if (c.red >= TEAM_CAPACITY) return 'blue';
  if (c.blue >= TEAM_CAPACITY) return 'red';
  return c.red <= c.blue ? 'red' : 'blue';
}
function canJoinTeam(entity, team) {
  if (team !== 'red' && team !== 'blue') return false;
  return allSlots().filter((p) => p.id !== entity.id && p.team === team).length < TEAM_CAPACITY;
}
function freshCombatState(p, spawn) {
  Object.assign(p, { x: spawn.x, z: spawn.z, y: 0, yaw: spawn.yaw, st: 'idle', aim: 0,
    p: 0, w: 'smg', sp: 0, hp: HP, alive: true,
    specialWep: null,
    ammoBudget: createAmmoBudget(),
    nades: p.bot ? 1 : WD.grenade.mag,
    lastNadeAt: -Infinity, lastRocketAt: -Infinity,
    lastDamage: 0, respawnAt: 0, prot: startAt + SPAWN_PROT,
    lastFireAt: -Infinity, pendingShot: null });
  resetMovementGuard(p, nowSec());
  resetPoseHistory(p);
}

function eventShooter(me, msg) {
  if (msg.bot === undefined || msg.bot === null) return me;
  if (!isHost(me)) return null;
  return bots.get(String(msg.bot)) || null;
}

function relayNade(sourceWs, shooter, msg) {
  if (!shooter?.alive || phase !== 'playing' || shooter.nades <= 0) return false;
  const o = vec3(msg.o), v = vec3(msg.v); if (!o || !v) return false;
  const now = nowSec();
  if (now - shooter.lastNadeAt < NADE_RELAY_INTERVAL) return false;
  const horizontalOrigin = Math.hypot(o[0] - shooter.x, o[2] - shooter.z);
  const verticalOrigin = Math.abs(o[1] - ((shooter.y || 0) + 1.1));
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (horizontalOrigin > 2.5 || verticalOrigin > 3 || speed < 0.5 || speed > 18) return false;
  const nid = `n${nextNadeId++}`;
  const cid = typeof msg.cid === 'string' && /^[a-zA-Z0-9:_-]{1,40}$/.test(msg.cid)
    ? msg.cid : null;
  shooter.lastNadeAt = now;
  shooter.nades--;
  activeNades.set(nid, makeSmokeProjectile(
    { x: o[0], y: o[1], z: o[2] },
    { x: v[0], y: v[1], z: v[2] },
    { nid, shooterId: shooter.id, lastTick: now },
  ));
  const packet = { t: 'nade', nid, id: shooter.id, o, v };
  broadcastRawExcept(sourceWs, packet);
  send(sourceWs, { t: 'nadeAck', nid, id: shooter.id, cid, o, v });
  return true;
}

function relayRocket(sourceWs, shooter, msg) {
  if (!shooter?.alive || phase !== 'playing' ||
      shooter.specialWep !== 'bazooka') return false;
  const o = vec3(msg.o), d = vec3(msg.d); if (!o || !d) return false;
  const now = nowSec();
  if (now - shooter.lastRocketAt < ROCKET_RELAY_INTERVAL) return false;
  const horizontalOrigin = Math.hypot(o[0] - shooter.x, o[2] - shooter.z);
  const verticalOrigin = Math.abs(o[1] - ((shooter.y || 0) + 1.1));
  const len = Math.hypot(d[0], d[1], d[2]);
  if (horizontalOrigin > 2.2 || verticalOrigin > 2.2 || len < 0.5 || len > 1.5) return false;
  if (!consumeShotAmmo(shooter, 'bazooka')) return false;
  const dir = d.map((n) => +(n / len).toFixed(6));
  const rid = `r${nextRocketId++}`;
  const cid = typeof msg.cid === 'string' && /^[a-zA-Z0-9:_-]{1,40}$/.test(msg.cid)
    ? msg.cid : null;
  const staticContact = projectileMapContact(settings.map, o, dir, WD.bazooka.range);
  activeRockets.set(rid, {
    rid, shooter, shooterId: shooter.id, team: shooter.team,
    origin: o, direction: dir, launchedAt: now, traveled: 0,
    staticContact,
  });
  // La posesión autoritativa basta: un cambio de arma puede llegar un snapshot
  // después que el click con latencia. El launch aprobado corrige ese desfase.
  shooter.w = 'bazooka';
  shooter.lastRocketAt = now; shooter.lastFireAt = now;
  shooter.pendingShot = null; shooter.prot = 0;
  const packet = { t: 'rocket', rid, id: shooter.id, o, d: dir };
  broadcastRawExcept(sourceWs, packet);
  send(sourceWs, { t: 'rocketAck', rid, id: shooter.id, cid, o, d: dir });
  return true;
}
function livesOf(team) { return pools[team] + allSlots().filter((p) => p.team === team && p.alive).length; }
function livesState() { return { red: livesOf('red'), blue: livesOf('blue') }; }
function prepareRound(first = false) {
  clearTimer(); round++;
  const roster = allSlots(), counts = teamCounts(roster), indices = { red: 0, blue: 0 };
  pools = { red: Math.max(0, settings.lives - counts.red), blue: Math.max(0, settings.lives - counts.blue) };
  resetWorld(); startAt = nowSec() + (first ? INTRO_TIME : 0) + COUNTDOWN_TIME;
  for (const p of roster) freshCombatState(p, pickSpawn(p.team, indices[p.team]++));
  special = { wep: specialForRound(round), taken: false, by: null };
  phase = first ? 'intro' : 'countdown';
  broadcastRaw({ t: first ? 'matchStart' : 'prepare', phase, startAt, round,
    settings: { ...settings }, wins: { ...wins }, lives: livesState(), players: roster.map(pub), rows: statRows(),
    special: { wep: special.wep } });
  phaseTimer = setTimeout(() => { phaseTimer = null; phase = 'playing'; startAt = 0;
    broadcastRaw({ t: 'start', round, wins: { ...wins }, lives: livesState() });
  }, Math.max(0, (startAt - nowSec()) * 1000));
}
function startMatch() {
  wins = { red: 0, blue: 0 }; round = 0;
  for (const p of allSlots()) { p.kills = 0; p.deaths = 0; }
  prepareRound(true);
}
function finishRound(winner) {
  if (phase !== 'playing' && phase !== 'round-finish') return;
  clearTimer(); phase = 'intermission'; wins[winner]++;
  const needed = Math.floor(settings.rounds / 2) + 1;
  broadcastRaw({ t: 'roundEnd', winner, round, wins: { ...wins }, lives: livesState(), rows: statRows() });
  if (wins[winner] >= needed) {
    phase = 'final'; broadcastRaw({ t: 'win', team: winner, round, wins: { ...wins }, rows: statRows(), settings: { ...settings } });
    phaseTimer = setTimeout(finishMatch, FINAL_TIME * 1000);
  } else phaseTimer = setTimeout(() => prepareRound(false), INTERMISSION_TIME * 1000);
}
function finishMatch() {
  clearTimer();
  if (!players.size) { resetRoom(); return; }
  if (settings.postMatch === 'next-map') {
    settings = { ...settings, map: nextLobbyMap(settings.map) };
    phase = 'lobby'; broadcastLobby(); startMatch();
  } else {
    phase = 'lobby'; startAt = 0;
    for (const p of allSlots()) { p.alive = true; p.hp = HP; p.respawnAt = 0; }
    broadcastRaw({ t: 'returnLobby' }); broadcastLobby();
  }
}
function holdRoundResult(winner) {
  if (phase !== 'playing') return;
  clearTimer();
  phase = 'round-finish';
  clearActiveRockets();
  clearActiveSmoke();
  // El servidor deja de aceptar combate inmediatamente, pero pospone el
  // anuncio para que todos los clientes vean completa la reacción final.
  phaseTimer = setTimeout(() => finishRound(winner), Math.max(0, ROUND_FINISH_HOLD) * 1000);
}
function checkRoundEnd() {
  for (const team of ['red', 'blue']) if (livesOf(team) <= 0) {
    holdRoundResult(team === 'red' ? 'blue' : 'red'); return true;
  }
  return false;
}
function dropWeapon(target) {
  const id = 'd' + nextDropId++;
  const wep = clampDropWep(target.w);
  const def = WD[wep] || WD.smg;
  const remaining = Math.max(0, Math.floor(Number(target.ammoBudget?.[wep] || 0)));
  // El cliente puede reportar su distribución cargador/reserva para el HUD,
  // pero el total que queda en el arma es exclusivamente el del servidor.
  const mag = Math.min(def.mag || 0, remaining);
  const res = Math.min(def.reserve || 0, Math.max(0, remaining - mag));
  const d = { wep: clampDropWep(target.w), x: target.x, z: target.z, y: target.y || 0,
    team: target.team, mag, res, t: DROP_LIFE };
  drops.set(id, d); broadcastRaw({ t: 'dropA', id, wep: d.wep, x: d.x, z: d.z, y: d.y, team: d.team, life: DROP_LIFE });
}
function registerFire(shooter, msg, isBotFire = false) {
  if (!shooter?.alive || phase !== 'playing') return false;
  const o = vec3(msg.o), pt = vec3(msg.p); if (!o || !pt) return false;
  const weapon = FIREABLE.has(msg.w) ? msg.w : 'smg', rule = FIRE_RULES[weapon], now = nowSec();
  // La bazooka nace exclusivamente mediante `rocket`; aceptar un `fire` en
  // el punto de explosión devolvería al cliente autoridad sobre la trayectoria.
  if (weapon === 'bazooka') return false;
  // el melee no depende del arma en mano; el resto debe coincidir con ella
  if ((weapon !== 'melee' && weapon !== shooter.w) || now - shooter.lastFireAt < rule.interval * .82) return false;
  const melee = weapon === 'melee';
  const originTolerance = melee ? 0.9 : (isBotFire ? 6 : 5);
  if (Math.hypot(o[0] - shooter.x, o[2] - shooter.z) > originTolerance ||
      Math.abs(o[1] - ((shooter.y || 0) + 1.1)) > (melee ? 1.1 : 4)) return false;
  if (Math.hypot(pt[0] - o[0], pt[1] - o[1], pt[2] - o[2]) > rule.range + (melee ? 0.22 : 2)) return false;
  if (melee) {
    const dx = pt[0] - o[0], dz = pt[2] - o[2], len = Math.hypot(dx, dz);
    const fx = -Math.sin(shooter.yaw || 0), fz = -Math.cos(shooter.yaw || 0);
    if (len > 0.001 && (dx * fx + dz * fz) / len < Math.cos(62 * Math.PI / 180)) return false;
  }
  if (!consumeShotAmmo(shooter, weapon)) return false;
  const endpoint = clipMapEndpoint(settings.map, o, pt);
  // Solo retransmitir impactos que realmente coincidan con la primera
  // superficie física de ese rayo. Evita decals suspendidos o pintados a
  // través del mapa por un cliente modificado.
  const decals = Array.isArray(msg.d) ? msg.d.slice(0, 8).map(vec3).filter((point) => {
    if (!point) return false;
    const contact = mapSurfaceContact(settings.map, o, point);
    return contact !== null && distance3(contact, point) <= 0.35;
  }) : undefined;
  const shotVec = [endpoint[0] - o[0], endpoint[1] - o[1], endpoint[2] - o[2]];
  const shotLen = Math.hypot(shotVec[0], shotVec[1], shotVec[2]);
  const shotDir = shotLen > 0.001
    ? shotVec.map((v) => v / shotLen)
    : null;
  shooter.lastFireAt = now; shooter.pendingShot = {
    at: now, wep: weapon, origin: o, endpoint, direction: shotDir,
    length: shotLen, remainingDamage: rule.maxDamage, hitIds: new Set(),
  };
  shooter.prot = 0;
  broadcastRaw({ t: 'fire', id: shooter.id, o, p: endpoint, w: weapon,
    ...(decals?.length ? { d: decals } : {}) }); return true;
}

const HEAD_RADIUS = 0.22;
const SNIPER_HEAD_AUTH_RADIUS = 0.58; // hitbox + margen breve de snapshot/red
const SNIPER_ENDPOINT_EPSILON = 0.28;

function targetHeadCenter(target, pose = target) {
  const crouched = CROUCH_STATES.has(pose.st);
  return [pose.x, (pose.y || 0) + (crouched ? 0.86 : 1.52), pose.z];
}

function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// El sniper es un solo rayo sin spread dentro del scope. Su claim de cabeza
// debe pertenecer al mismo segmento que registró el disparo y ese segmento
// debe pasar por el volumen real de la cabeza; no basta con enviar una Y alta.
function sniperRayHitsHead(shot, point, head) {
  if (!shot?.direction || !shot.endpoint || !Number.isFinite(shot.length)) return false;
  if (distance3(point, shot.endpoint) > SNIPER_ENDPOINT_EPSILON) return false;
  const rel = [head[0] - shot.origin[0], head[1] - shot.origin[1], head[2] - shot.origin[2]];
  const along = rel[0] * shot.direction[0] + rel[1] * shot.direction[1] + rel[2] * shot.direction[2];
  if (along < 0 || along > shot.length + SNIPER_HEAD_AUTH_RADIUS) return false;
  const closest = [
    shot.origin[0] + shot.direction[0] * along,
    shot.origin[1] + shot.direction[1] * along,
    shot.origin[2] + shot.direction[2] * along,
  ];
  return distance3(closest, head) <= SNIPER_HEAD_AUTH_RADIUS;
}

// El cliente comunica el punto visual, pero no decide el multiplicador. La Y
// del impacto permite validar cabeza incluso con interpolación horizontal; el
// radio amplio en XZ tolera los ~120 ms de snapshots sin regalar headshots por
// impactos claramente situados en el torso.
function validatedPart(target, claimedPart, point, shot = null, pose = target) {
  if (claimedPart !== 'head' || !point) return 'body';
  const crouched = CROUCH_STATES.has(pose.st);
  const relY = point[1] - (pose.y || 0);
  const minY = crouched ? 0.66 : 1.30;
  const maxY = crouched ? 1.16 : 1.82;
  const horizontal = Math.hypot(point[0] - pose.x, point[2] - pose.z);
  if (relY < minY || relY > maxY || horizontal > 1.25) return 'body';
  if (shot?.wep === 'sniper') {
    const head = targetHeadCenter(target, pose);
    if (distance3(point, head) > SNIPER_HEAD_AUTH_RADIUS ||
        !sniperRayHitsHead(shot, point, head)) return 'body';
  }
  return 'head';
}

// Nunca retransmitir el punto bruto del cliente fuera del cráneo: mantiene
// sangre/fragmentos pegados al personaje aun con interpolación de red.
function validatedDeathPoint(target, part, point) {
  if (!point || part !== 'head') return point;
  const head = targetHeadCenter(target);
  const delta = [point[0] - head[0], point[1] - head[1], point[2] - head[2]];
  const len = Math.hypot(delta[0], delta[1], delta[2]);
  if (len < 0.001) return head;
  const radius = Math.min(HEAD_RADIUS, len);
  return [
    head[0] + delta[0] / len * radius,
    head[1] + delta[1] / len * radius,
    head[2] + delta[2] / len * radius,
  ];
}

function authoritativeDamage(shooter, target, shot, msg, dist, pose) {
  const wep = shot.wep;
  const point = vec3(msg.p);
  const part = validatedPart(target, msg.part, point, shot, pose);
  const botScale = shooter.bot && wep !== 'bazooka'
    ? TUNING.combat.botDamageScale
    : 1;

  if (wep === 'melee') {
    return { dmg: TUNING.melee.dmg * botScale, part: 'body' };
  }
  if (wep === 'bazooka') {
    return {
      dmg: rocketSplashDamage(WD.bazooka, dist, target.id === shooter.id),
      part: 'body',
    };
  }

  const def = WD[wep];
  if (!def) return { dmg: 0, part: 'body' };
  let pellets = 1;
  if (wep === 'shotgun') {
    const declared = Math.floor(num(msg.pellets));
    if (declared > 0) pellets = Math.min(def.pellets, declared);
    else {
      // Compatibilidad con clientes anteriores: inferir cuántos pellets
      // produjeron su claim, pero recalcular el daño con la fórmula vigente.
      const perPellet = def.dmg * damageFalloff(def, dist) * botScale;
      pellets = perPellet > 0
        ? Math.max(1, Math.min(def.pellets, Math.round(num(msg.dmg) / perPellet)))
        : 1;
    }
  }
  return { dmg: firearmDamage(def, dist, part, pellets, botScale), part };
}

function claimMatchesShot(shot, point) {
  if (shot.wep === 'bazooka') return true; // el origen ES la explosión
  if (!shot.direction) return false;
  const dx = point[0] - shot.origin[0], dy = point[1] - shot.origin[1];
  const dz = point[2] - shot.origin[2], len = Math.hypot(dx, dy, dz);
  if (len < 0.001) return shot.wep === 'melee';
  const dot = (dx * shot.direction[0] + dy * shot.direction[1] +
    dz * shot.direction[2]) / len;
  // Un fire de escopeta registra el último pellet, mientras el claim agrupa
  // todos; sus dos extremos pueden separarse hasta ~16°. Armas de un solo
  // proyectil mantienen un cono mucho más estrecho.
  const degrees = shot.wep === 'shotgun' ? 20 : shot.wep === 'melee' ? 18 : 9;
  return dot >= Math.cos(degrees * Math.PI / 180);
}

function commitAuthoritativeDamage(shooter, target, shot, msg, dist, authoritative,
  now, deferRoundCheck = false) {
  const dmg = Math.min(authoritative.dmg, shot.remainingDamage);
  if (dmg <= 0) return { applied: false, killed: false };
  const part = authoritative.part;
  shot.hitIds.add(target.id); shot.remainingDamage -= dmg;
  target.hp -= dmg; target.lastDamage = now;
  if (shot.wep === 'melee') {
    const p = vec3(msg.p) || [target.x, (target.y || 0) + 1, target.z];
    broadcastRaw({ t: 'hitConfirm', target: target.id, from: shooter.id,
      w: 'melee', dmg: Math.round(dmg), p });
  }
  if (target.hp > 0) {
    if (shot.wep === 'bazooka') {
      const p = vec3(msg.p) || [target.x, (target.y || 0) + 1, target.z];
      broadcastRaw({ t: 'hitConfirm', target: target.id, from: shooter.id,
        w: 'bazooka', dmg: Math.round(dmg), p, ep: shot.origin });
    }
    return { applied: true, killed: false };
  }
  target.hp = 0; target.alive = false; target.deaths++;
  if (target.id !== shooter.id) shooter.kills++;
  const gib = shot.wep === 'shotgun' && dist <= FIRE_RULES.shotgun.gibRange && !!msg.gib;
  const sniperHeadshot = isSniperHeadshotDeath(shot.wep, part);
  const directRocket = shot.wep === 'bazooka'
    ? shot.directTargetId === target.id
    : dist <= 0.82;
  const explosiveLevel = rocketDeathLevel(shot.wep, dist, dmg, directRocket);
  const deathPoint = validatedDeathPoint(target, part, vec3(msg.p));
  broadcastRaw({ t: 'death', target: target.id, from: shooter.id, gib: gib ? 1 : 0,
    hs: sniperHeadshot ? 1 : 0, ex: explosiveLevel, w: shot.wep,
    dist: +dist.toFixed(2), dmg: Math.round(dmg), part,
    ...(deathPoint ? { p: deathPoint } : {}),
    ...(shot.wep === 'bazooka' ? { ep: shot.origin } : {}),
    kn: shooter.name, kt: shooter.team, vn: target.name, vt: target.team });
  dropWeapon(target);
  target.specialWep = null;
  if (pools[target.team] > 0) { pools[target.team]--; target.respawnAt = now + RESPAWN_TIME; }
  else target.respawnAt = 0;
  broadcastRaw({ t: 'score', ...livesState(), wins: { ...wins } });
  if (!deferRoundCheck) checkRoundEnd();
  return { applied: true, killed: true };
}

function registerHit(shooter, msg) {
  const target = players.get(msg.target) || bots.get(msg.target);
  const shot = shooter?.pendingShot, rule = shot ? FIRE_RULES[shot.wep] : null, now = nowSec();
  if (!target || !target.alive || !shooter?.alive || phase !== 'playing' || target.prot > now) return;
  const selfRocket = target.id === shooter.id && shot?.wep === 'bazooka';
  if (target.team === shooter.team && !selfRocket) return;
  if (!shot || !rule || now - shot.at > HIT_WINDOW || shot.hitIds.has(target.id)) return;
  const point = vec3(msg.p); if (!point) return;
  const pose = poseForClaim(target, point, now); if (!pose) return;
  if (!claimMatchesShot(shot, point) ||
      mapLineBlocked(settings.map, shot.origin, point, shot.wep === 'melee' ? 0.24 : 0.18)) return;
  const dist = distance3(shot.origin, point);
  const hitTolerance = shot.wep === 'melee' ? 0.28 : 2;
  if (dist > (rule.hitRange ?? rule.range) + hitTolerance) return;
  if (shot.wep === 'melee') {
    const dx = pose.x - shooter.x, dz = pose.z - shooter.z, len = Math.hypot(dx, dz);
    const fx = -Math.sin(shooter.yaw || 0), fz = -Math.cos(shooter.yaw || 0);
    if (len > 0.001 && (dx * fx + dz * fz) / len < Math.cos(58 * Math.PI / 180)) return;
  }
  const authoritative = authoritativeDamage(shooter, target, shot, msg, dist, pose);
  commitAuthoritativeDamage(shooter, target, shot, msg, dist, authoritative, now);
}

function rocketPoint(rocket, distance) {
  return [
    rocket.origin[0] + rocket.direction[0] * distance,
    rocket.origin[1] + rocket.direction[1] * distance,
    rocket.origin[2] + rocket.direction[2] * distance,
  ];
}

function firstRocketTarget(rocket, fromDistance, toDistance, now) {
  if (toDistance < fromDistance) return null;
  let best = null;
  for (const target of allSlots()) {
    if (!target.alive || target.prot > now || target.id === rocket.shooterId ||
        target.team === rocket.team) continue;
    const centerY = (target.y || 0) + 0.9;
    const rel = [target.x - rocket.origin[0], centerY - rocket.origin[1],
      target.z - rocket.origin[2]];
    const along = rel[0] * rocket.direction[0] + rel[1] * rocket.direction[1] +
      rel[2] * rocket.direction[2];
    const distance = Math.max(fromDistance, Math.min(toDistance, along));
    const point = rocketPoint(rocket, distance);
    const separation = Math.hypot(target.x - point[0], centerY - point[1], target.z - point[2]);
    if (separation > ROCKET_FUSE_RADIUS || (best && distance >= best.distance)) continue;
    best = { target, distance };
  }
  return best;
}

function detonateRocket(rocket, distance, kind, directTarget = null) {
  if (!activeRockets.delete(rocket.rid)) return;
  const contact = kind === 'world' && rocket.staticContact
    ? rocket.staticContact.point.slice()
    : rocketPoint(rocket, distance);
  const blast = kind === 'world'
    ? contact.map((n, i) => n - rocket.direction[i] * ROCKET_SURFACE_OFFSET)
    : contact.slice();
  const normal = kind === 'world' && rocket.staticContact?.normal
    ? rocket.staticContact.normal
    : rocket.direction.map((n) => -n);
  broadcastRaw({
    t: 'rocketBoom', rid: rocket.rid, id: rocket.shooterId,
    p: blast, vp: contact, n: normal,
    kind, direct: directTarget ? 1 : 0,
    ...(directTarget ? { target: directTarget.id } : {}),
    surface: rocket.staticContact?.surface || (directTarget ? 'flesh' : 'concrete'),
  });

  if (phase !== 'playing') return;
  const now = nowSec();
  const shot = {
    at: now, wep: 'bazooka', origin: blast, endpoint: blast, direction: rocket.direction,
    length: 0, remainingDamage: Infinity, hitIds: new Set(),
    directTargetId: directTarget?.id || null,
  };
  let killed = false;
  for (const target of allSlots()) {
    if (!target.alive || target.prot > now) continue;
    const self = target.id === rocket.shooterId;
    if (target.team === rocket.team && !self) continue;
    const point = [target.x, (target.y || 0) + 0.9, target.z];
    const dist = distance3(blast, point);
    if (dist > WD.bazooka.splashRadius ||
        mapLineBlocked(settings.map, blast, point, 0.22)) continue;
    const authoritative = {
      dmg: rocketSplashDamage(WD.bazooka, dist, self), part: 'body',
    };
    const result = commitAuthoritativeDamage(rocket.shooter, target, shot,
      { p: point, gib: 0 }, dist, authoritative, now, true);
    killed ||= result.killed;
  }
  if (killed) checkRoundEnd();
}

function tickRockets(now) {
  for (const rocket of [...activeRockets.values()]) {
    const nextDistance = Math.min(WD.bazooka.range,
      Math.max(rocket.traveled, (now - rocket.launchedAt) * ROCKET_SPEED));
    const staticDistance = rocket.staticContact?.distance ?? Infinity;
    const segmentEnd = Math.min(nextDistance, staticDistance, WD.bazooka.range);
    const direct = firstRocketTarget(rocket, rocket.traveled, segmentEnd, now);
    if (direct && direct.distance < staticDistance - 0.001) {
      detonateRocket(rocket, direct.distance, 'direct', direct.target); continue;
    }
    if (rocket.staticContact && nextDistance >= staticDistance) {
      detonateRocket(rocket, staticDistance, 'world'); continue;
    }
    if (nextDistance >= WD.bazooka.range) {
      detonateRocket(rocket, WD.bazooka.range, 'air'); continue;
    }
    rocket.traveled = nextDistance;
  }
}

function activateNade(nade, now) {
  if (!activeNades.delete(nade.nid)) return;
  const point = [nade.x, nade.y, nade.z].map((n) => +n.toFixed(4));
  activeSmokes.set(nade.nid, {
    nid: nade.nid,
    shooterId: nade.shooterId,
    point,
    expiresAt: now + SMOKE_TIME,
  });
  broadcastRaw({
    t: 'smokeStart', nid: nade.nid, id: nade.shooterId,
    p: point, duration: SMOKE_TIME,
  });
}

function tickSmoke(now) {
  const physics = serverMapPhysics(settings.map);
  for (const nade of [...activeNades.values()]) {
    let remaining = Math.min(0.15, Math.max(0, now - nade.lastTick));
    while (remaining > 1e-7 && nade.t < SMOKE_FUSE) {
      const dt = Math.min(SMOKE_PHYSICS_STEP, remaining,
        SMOKE_FUSE - nade.t);
      stepSmokeProjectile(nade, dt, physics);
      remaining -= dt;
    }
    nade.lastTick = now;
    if (nade.t >= SMOKE_FUSE - 1e-6) activateNade(nade, now);
  }
  for (const smoke of [...activeSmokes.values()]) {
    if (now < smoke.expiresAt) continue;
    activeSmokes.delete(smoke.nid);
    broadcastRaw({ t: 'smokeEnd', nid: smoke.nid });
  }
}

wss.on('connection', (ws) => {
  let me = null;
  const rateGuard = new MessageRateGuard(nowSec());
  // Errores de protocolo/payload pertenecen a este peer. Sin listener, `ws`
  // los eleva como excepción no manejada y un solo cliente puede tumbar la sala.
  ws.on('error', () => { /* el cierre del socket hace la limpieza normal */ });
  ws.on('message', (data) => {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : (data?.byteLength || data?.length || 0);
    if (!rateGuard.allow(nowSec(), bytes)) {
      ws.close(1008, 'rate limit'); return;
    }
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.t === 'join' && !me) {
      const action = msg.action === 'create' ? 'create' : 'join';
      if (action === 'create' && players.size) { lobbyError(ws, 'lobby-exists'); return; }
      if (action === 'join' && !players.size) { lobbyError(ws, 'no-lobby'); return; }
      if (inMatch()) { lobbyError(ws, 'in-progress'); return; }
      if (allSlots().length >= MAX_PLAYERS) { lobbyError(ws, 'lobby-full'); return; }
      const id = 'p' + nextId++;
      me = { ws, id, bot: false, team: assignTeam(), joinedAt: Date.now(),
        name: String(msg.name || 'ANON').slice(0, 14).toUpperCase(),
        v: Math.min(4, Math.max(0, Math.round(num(msg.v)))), hp: HP, alive: true,
        kills: 0, deaths: 0, w: 'smg', specialWep: null,
        lastFireAt: -Infinity, pendingShot: null };
      players.set(id, me); if (!hostId) { hostId = id; phase = 'lobby'; }
      send(ws, { t: 'welcome', id, team: me.team, lobby: lobbyPayload() }); broadcastLobby();
      console.log(`+ ${me.name} (${me.team}) — ${players.size} humanos, ${bots.size} bots`); return;
    }
    if (!me) return;
    if (msg.t === 'lobbySettings') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      settings = normalizeLobbySettings({ ...settings, ...msg.settings }); broadcastLobby(); return;
    }
    if (msg.t === 'lobbyTeam') {
      if (phase !== 'lobby') { lobbyError(ws, 'locked'); return; }
      const team = msg.team === 'blue' ? 'blue' : 'red';
      if (me.team === team) return;
      if (!canJoinTeam(me, team)) {
        // Una selección explícita puede intercambiar el slot con un bot del
        // destino. No se elimina ni reasigna silenciosamente a nadie y el
        // roster conserva exactamente el mismo tamaño/balance.
        if (!isHost(me)) { lobbyError(ws, 'team-full'); return; }
        const bot = [...bots.values()].find((b) => b.team === team);
        if (!bot) { lobbyError(ws, 'team-full'); return; }
        bot.team = me.team;
      }
      me.team = team; broadcastLobby(); return;
    }
    if (msg.t === 'lobbyBotAdd') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      if (allSlots().length >= MAX_PLAYERS) { lobbyError(ws, 'lobby-full'); return; }
      const team = msg.team === 'blue' ? 'blue' : 'red', probe = { id: '', team };
      if (!canJoinTeam(probe, team)) { lobbyError(ws, 'team-full'); return; }
      const id = 'b' + nextBotId++, occupied = allSlots().map((p) => p.name);
      bots.set(id, { id, bot: true, team, name: makeBotName(team, occupied), v: (nextBotId - 2) % 5,
        hp: HP, alive: true, kills: 0, deaths: 0, w: 'smg', specialWep: null,
        lastFireAt: -Infinity, pendingShot: null });
      broadcastLobby(); return;
    }
    if (msg.t === 'lobbyBotRemove' || msg.t === 'lobbyBotTeam') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      const bot = bots.get(msg.id); if (!bot) { lobbyError(ws, 'bot-missing'); return; }
      if (msg.t === 'lobbyBotRemove') bots.delete(bot.id);
      else { if (!canJoinTeam(bot, msg.team)) { lobbyError(ws, 'team-full'); return; } bot.team = msg.team; }
      broadcastLobby(); return;
    }
    if (msg.t === 'lobbyStart') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      const validity = validateLobby(allSlots(), settings);
      if (!validity.ok) { lobbyError(ws, 'invalid', validity.errors.join(',')); broadcastLobby(); return; }
      startMatch(); return;
    }
    if (msg.t === 's') {
      if (phase !== 'playing' || !me.alive) { me.st = 'idle'; me.aim = 0; me.sp = 0; return; }
      if (![msg.x, msg.y, msg.z, msg.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      const next = { x: clamp(msg.x, -60, 60), z: clamp(msg.z, -60, 60), y: clamp(msg.y, 0, 20) };
      const stateNow = nowSec();
      if (!acceptMovement(me, next, stateNow, ALLOW_TEST_TELEPORTS)) {
        send(ws, { t: 'correction', x: me.x, y: me.y || 0, z: me.z, reason: 'movement' });
        return;
      }
      me.x = next.x; me.z = next.z; me.y = next.y; me.yaw = clamp(msg.yaw, -10, 10);
      me.st = VALID_STATES.has(String(msg.st)) && msg.st !== 'dead' ? msg.st : 'idle';
      me.aim = msg.aim ? 1 : 0; me.p = clamp(msg.p, -1.6, 1.6);
      const requestedWep = clampWep(msg.w);
      me.w = SPECIAL_WEAPONS.has(requestedWep) && me.specialWep !== requestedWep ? 'smg' : requestedWep;
      const def = WD[me.w] || WD.smg;
      me.am = clamp(msg.am, 0, def.mag || 0); me.ar = clamp(msg.ar, 0, def.reserve || 0);
      me.sp = clamp(msg.sp, 0, 1); recordPose(me, stateNow); return;
    }
    if (msg.t === 'botState') {
      if (!isHost(me) || phase !== 'playing' || !Array.isArray(msg.bots)) return;
      const stateNow = nowSec();
      for (const s of msg.bots.slice(0, MAX_PLAYERS)) {
        const b = bots.get(s.id); if (!b || !b.alive) continue;
        if (![s.x, s.y, s.z, s.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
        const next = { x: clamp(s.x, -60, 60), z: clamp(s.z, -60, 60), y: clamp(s.y, 0, 20) };
        if (!acceptMovement(b, next, stateNow, ALLOW_TEST_TELEPORTS)) continue;
        b.x = next.x; b.z = next.z; b.y = next.y; b.yaw = clamp(s.yaw, -10, 10);
        b.st = VALID_STATES.has(String(s.st)) && s.st !== 'dead' ? s.st : 'idle';
        b.aim = s.aim ? 1 : 0; b.p = clamp(s.p, -1.6, 1.6);
        const requestedWep = clampWep(s.w);
        b.w = SPECIAL_WEAPONS.has(requestedWep) && b.specialWep !== requestedWep ? 'smg' : requestedWep;
        b.sp = clamp(s.sp, 0, 1); recordPose(b, stateNow);
      } return;
    }
    if (msg.t === 'fire') { registerFire(me, msg); return; }
    if (msg.t === 'botFire') { if (isHost(me)) { const b = bots.get(msg.id); if (b) {
      const requestedWep = FIREABLE.has(msg.w) ? msg.w : 'smg';
      if (SPECIAL_WEAPONS.has(requestedWep) && b.specialWep !== requestedWep) return;
      b.w = requestedWep; registerFire(b, msg, true);
    } } return; }
    // Proyectiles visuales: quien dispara ya los simuló localmente. El server
    // valida lanzamiento, simula trayectoria/impacto y decide todo el splash.
    if (msg.t === 'rocket') {
      if (!relayRocket(ws, eventShooter(me, msg), msg)) {
        const cid = typeof msg.cid === 'string' ? msg.cid.slice(0, 40) : null;
        send(ws, { t: 'rocketReject', cid });
      }
      return;
    }
    if (msg.t === 'nade') {
      if (!relayNade(ws, eventShooter(me, msg), msg)) {
        const cid = typeof msg.cid === 'string' ? msg.cid.slice(0, 40) : null;
        send(ws, { t: 'nadeReject', cid });
      }
      return;
    }
    if (msg.t === 'hit') { registerHit(me, msg); return; }
    if (msg.t === 'botHit') { if (isHost(me)) { const b = bots.get(msg.id); if (b) registerHit(b, msg); } return; }
    if (msg.t === 'takeDrop') {
      const d = drops.get(msg.id);
      if (!d || !me.alive || phase !== 'playing' || Math.hypot(me.x - d.x, me.z - d.z) > 3) return;
      if (SPECIAL_WEAPONS.has(d.wep)) me.specialWep = d.wep;
      grantWeaponAmmo(me, d.wep, d.mag, d.res);
      drops.delete(msg.id); broadcastRaw({ t: 'dropR', id: msg.id }); send(ws, { t: 'dropGive', wep: d.wep, mag: d.mag, res: d.res }); return;
    }
    // pickup del arma especial: gana el PRIMER reclamo válido y solo uno
    if (msg.t === 'takeSpecial') {
      const claimant = msg.bot && isHost(me) ? bots.get(msg.bot) : me;
      if (!claimant?.alive || phase !== 'playing' || special.taken || !special.wep) return;
      const spot = MAP_RUNTIME[settings.map]?.special;
      if (!spot || Math.hypot(claimant.x - spot.x, claimant.z - spot.z) > 2.2 ||
          Math.abs((claimant.y || 0) - (spot.y || 0)) > 1.5) return;
      special.taken = true; special.by = claimant.id; claimant.specialWep = special.wep;
      grantWeaponAmmo(claimant, special.wep);
      broadcastRaw({ t: 'specialTaken', id: claimant.id, wep: special.wep });
      return;
    }
    if (msg.t === 'crate') {
      const c = CRATES[msg.i];
      const spot = MAP_RUNTIME[settings.map]?.crates?.[msg.i];
      if (!c || !spot || !c.up || !me.alive || phase !== 'playing' ||
          Math.hypot(me.x - spot.x, me.z - spot.z) > 3) return;
      c.up = false; c.t = CRATE_RESPAWN; broadcastRaw({ t: 'crate', i: msg.i, up: 0, by: me.id });
      refillNormalAmmo(me);
    }
  });
  ws.on('close', () => {
    if (!me || !players.has(me.id)) return;
    players.delete(me.id); broadcastRaw({ t: 'left', id: me.id });
    if (!players.size) { resetRoom(); me = null; return; }
    if (hostId === me.id) {
      hostId = [...players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
      broadcastRaw({ t: 'host', id: hostId });
    }
    if (phase === 'playing') checkRoundEnd(); else if (phase === 'lobby') broadcastLobby();
    me = null;
  });
});

setInterval(() => {
  const now = nowSec();
  if (phase === 'playing') { tickRockets(now); tickSmoke(now); }
  if (phase === 'playing') for (const p of allSlots()) {
    if (p.alive && p.hp < HP && now - p.lastDamage > REGEN_DELAY) p.hp = Math.min(HP, p.hp + REGEN_RATE / TICK_HZ);
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) {
      p.alive = true; p.hp = HP; p.respawnAt = 0; p.prot = now + SPAWN_PROT;
      p.w = 'smg'; p.specialWep = null; p.ammoBudget = createAmmoBudget();
      p.nades = p.bot ? 1 : WD.grenade.mag;
      p.lastNadeAt = -Infinity; p.lastRocketAt = -Infinity;
      const spawn = pickSpawn(p.team); Object.assign(p, { x: spawn.x, z: spawn.z, y: 0, yaw: spawn.yaw });
      resetMovementGuard(p, now);
      resetPoseHistory(p, now);
      broadcastRaw({ t: 'respawn', id: p.id, spawn });
    }
  }
  for (const [id, d] of drops) { d.t -= 1 / TICK_HZ; if (d.t <= 0) { drops.delete(id); broadcastRaw({ t: 'dropR', id }); } }
  for (let i = 0; i < CRATES.length; i++) { const c = CRATES[i]; if (!c.up) { c.t -= 1 / TICK_HZ; if (c.t <= 0) { c.up = true; broadcastRaw({ t: 'crate', i, up: 1 }); } } }
  if (players.size && inMatch()) broadcastRaw({ t: 'snap', phase, lives: livesState(), wins: { ...wins },
    ps: allSlots().map((p) => ({ id: p.id, x: p.x ?? 0, z: p.z ?? 0, y: p.y || 0,
      yaw: p.yaw || 0, st: p.st || 'idle', aim: p.aim || 0, p: p.p || 0, w: p.w || 'smg',
      sp: p.sp || 0, hp: Math.round(p.hp), alive: p.alive, inv: p.prot > now ? 1 : 0, bot: p.bot ? 1 : 0 })) });
}, 1000 / TICK_HZ);

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, num(v))); }
function vec3(v) { if (!Array.isArray(v) || v.length !== 3) return null; const out = v.map(num); return out.every((n) => Math.abs(n) < 1000) ? out : null; }

server.listen(PORT, () => console.log(`BREACH server en http://localhost:${PORT} (WebSocket en el mismo enlace)`));
