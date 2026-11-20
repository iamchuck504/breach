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
import { nextRespawnWave } from '../src/game/respawn-wave.js';
import { PowerRespawn } from '../src/game/power-respawn.js';
import { takeDropAmmo, canReplaceDrop, replacementSlot, specialPickupSlot } from '../src/game/drop-policy.js';
import { damageFalloff, firearmDamage, rocketSplashDamage } from '../src/combat/damage.js';
import {evaluateBlast} from '../src/combat/blast.js';
import {CombatPrototypes} from '../src/combat/prototypes.js';
import { isSniperHeadshotDeath, rocketDeathLevel } from '../src/combat/death-reactions.js';
import { makeSmokeProjectile, stepSmokeProjectile } from '../src/game/smoke-physics.js';
import { claimPose, currentVolume, placeHitPose, hitAimHeights } from '../src/combat/hit-pose.js';
import { adsSetback, shooterPlaneDistance } from '../src/combat/shooter-plane.js';
// pose ADS del tirador alineada con el disparo: la actual o las de los
// últimos 300 ms (el estado viaja a 20 Hz y el disparo puede adelantarse)
function aimedSetback(shooter, o) {
  // el historial de poses va en reloj MONÓTONO (monoSec): compararlo con
  // epoch descartaba todas las muestras
  const mt = monoSec();
  for (const pose of [shooter, ...(shooter.poseHistory || []).filter((p) => p.at >= mt - 0.3).reverse()]) {
    const c = adsSetback(pose, o);
    if (c) return c;
  }
  return null;
}
import {
  MAX_WS_PAYLOAD, MessageRateGuard, acceptMovement, consumeShotAmmo,
  createAmmoBudget, grantWeaponAmmo, refillNormalAmmo, resetMovementGuard,
  fireCadenceAllows, commitFireCadence, noteMessageArrival,
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
  melee: { interval: 0.4, range: 1.95, hitRange: 1.95, maxDamage: TUNING.melee.backstabDmg },
};
// ids replicables en 'w' (la granada solo aparece EN MANO, nunca dispara aquí)
const VALID_WEAPONS = new Set(['smg', 'shotgun', 'pistol', 'grenade', 'sniper', 'bazooka','frag','stun']);
const SPECIAL_WEAPONS = new Set(['sniper', 'bazooka']);
const FIREABLE = new Set(Object.keys(FIRE_RULES));
const clampWep = (w) => (VALID_WEAPONS.has(w) ? w : 'smg');
// la granada no es un arma soltable: el drop degrada a smg
const clampDropWep = (w) => (VALID_WEAPONS.has(w) && !['grenade','frag','stun'].includes(w) ? w : 'smg');
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
const VALID_COVER_KINDS = new Set(['low', 'medium', 'high', 'railing', 'platform-edge',
  'vehicle', 'shelter', 'truck', 'bus']);
const VISUAL_AIM_MAX = 52 * Math.PI / 180;
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
  // sonda de vida para el host (health check del proveedor); sin estado interno
  if (urlPath === '/healthz') { textResponse(res, 200, 'ok'); return; }
  // estado de la sala; CORS abierto porque el cliente puede vivir en otro
  // dominio (sitio estático) y solo expone lo que ya ve cualquiera que entre
  if (urlPath === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(publicStatus()));
    return;
  }
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
// BREACH_FILL_BOTS=0 arranca las salas sin relleno automático (lo usan las
// suites que montan rosters exactos); el anfitrión puede cambiarlo en el lobby.
const roomDefaults = () => ({ ...DEFAULT_LOBBY_SETTINGS,
  fillBots: process.env.BREACH_FILL_BOTS !== '0' && DEFAULT_LOBBY_SETTINGS.fillBots });
let settings = roomDefaults(), phase = 'empty', phaseTimer = null, startAt = 0, round = 0;
const prototypes=new CombatPrototypes({
 experimental:process.env.BREACH_EXPERIMENTAL_STUN==='1',
 actors:()=>allSlots().map(p=>({...p,protected:p.prot>nowSec(),blastH:blastHeightOf(p)})),
 physics:{resolveCircle:(...a)=>serverMapPhysics(settings.map).resolveCircle(...a),groundHeight:(...a)=>serverMapPhysics(settings.map).groundHeight(...a)},
 blocked:(a,b)=>mapLineBlocked(settings.map,[a.x,a.y,a.z],[b.x,b.y,b.z],.015),
 event:e=>{if(e.kind==='blastResolved'){checkRoundEnd();return;}broadcastRaw({t:'protoEvent',...e});},
 inventory:(id,item)=>{
  const actor=allSlots().find(p=>p.id===id);if(!actor)return;
  if(item.kind==='frag'){actor.weaponSlots[3]='frag';actor.nades=item.count;}
  else if(!actor.weaponSlots.includes('stun'))actor.weaponSlots[2]='stun';
  broadcastRaw({t:'protoInventory',id,...item});
 },
 damage:(owner,id,dmg,context)=>{
  const target=allSlots().find(p=>p.id===id),shooter=allSlots().find(p=>p.id===owner);
  if(!target?.alive||!shooter||phase!=='playing')return;
  const ep=context.explosionPoint;
  const shot={wep:'frag',origin:[ep.x,ep.y,ep.z],remainingDamage:Infinity,hitIds:new Set()};
  commitAuthoritativeDamage(shooter,target,shot,{p:[target.x,(target.y??0)+.9,target.z]},context.distance,{dmg,part:'body'},nowSec(),true);
 }
});
let waveEpoch = 0;
let wins = { red: 0, blue: 0 }, pools = { red: 0, blue: 0 };

const nowSec = () => Date.now() / 1000;
const LOG_FIRE_REJECTS = process.env.BREACH_LOG_FIRE_REJECTS === '1';
// Texto de la red: solo si ES texto. String()/plantillas sobre un objeto
// arbitrario pueden lanzar ({"toString":1,"valueOf":1}).
const str = (v) => (typeof v === 'string' ? v : '');
// Reloj monótono para el historial de poses, el instante de los disparos y
// los pings: un salto del reloj del sistema no puede desordenarlos.
const monoSec = () => performance.now() / 1000;
// Pose tal como se DIFUNDE a los observadores (lo que hit-pose.js necesita:
// estado, apuntado, exposición sobre cover bajo solo si el cliente la envió,
// asomado, pitch, ae, velocidad y arma).
function poseSnapshot(entity, now) {
  return { at: now, x: entity.x || 0, y: entity.y || 0, z: entity.z || 0, st: entity.st || 'idle',
    yaw: entity.yaw || 0, aim: entity.aim ? 1 : 0, p: entity.p || 0, ae: entity.ae || 0, cl: entity.cl || 0,
    sp: entity.sp || 0, w: entity.w, ...(entity.ceKnown ? { ce: entity.ce } : {}) };
}
// historial: lo difundido en cada snapshot. Se guarda más que la ventana de
// posición (0.75 s) para reconstruir la entrada de dive/mantle/flip.
const POSE_RETAIN = 1.6;
function resetPoseHistory(entity, now = monoSec()) {
  entity.poseHistory = [poseSnapshot(entity, now)];
}
function recordPose(entity, now = monoSec()) {
  entity.poseHistory ||= [];
  entity.poseHistory.push(poseSnapshot(entity, now));
  while (entity.poseHistory.length > 2 && entity.poseHistory[0].at < now - POSE_RETAIN) {
    entity.poseHistory.shift();
  }
}
// Pose del objetivo que explica el claim: se reconstruye en el instante que
// veía el tirador (rebobinado acotado desde el disparo, hit-pose.js) y un solo
// volumen decide cuerpo y cabeza. `legacy`: el tirador no anunció el modelo de
// pose (cliente anterior) y se valida con la regla anterior.
function poseForClaim(target, point, shot = null, legacy = false, rtt = undefined) {
  if (!point) return null;
  const mt = monoSec();
  const history = [...(target.poseHistory || []), poseSnapshot(target, mt)];
  const headOk = shot?.wep === 'sniper'
    ? (head) => distance3(point, head) <= SNIPER_HEAD_AUTH_RADIUS && sniperRayHitsHead(shot, point, head)
    : null;
  // quemarropa: contacto de longitud cero (sin dirección); dentro de la cabeza es cabeza
  const pointBlank = !!shot && !shot.direction && shot.wep !== 'melee';
  const best = claimPose(history, shot?.mt ?? mt, point,
    { rtt, legacy, headOk, pointBlank, tolerance: CLAIM_POSITION_TOLERANCE });
  return best ? { ...best.pose, vol: best.vol, head: best.head, inside: best.inside } : null;
}
// volumen de la pose actual (difundida + estado de ahora)
const currentVolumeOf = (entity) => currentVolume([...(entity.poseHistory || []), poseSnapshot(entity, monoSec())]);
// Origen de un disparo de bot (lo simula el host): debe salir de su cuerpo
// difundido en los últimos BOT_ORIGIN_LAG s (desfase host→servidor; los
// botState y el botFire viajan por el mismo socket), a menos de
// BOT_MUZZLE_REACH en planta, entre 0.3 y 2.1 m sobre los pies, y con el
// tramo pecho→origen libre de geometría del mapa (no se dispara a través de
// una cobertura).
const BOT_ORIGIN_LAG = 0.3, BOT_MUZZLE_REACH = 1.2;
function botOriginLegal(bot, o) {
  const mt = monoSec();
  // solo poses DIFUNDIDAS (lo que vieron los observadores), nunca la recién recibida
  const samples = (bot.poseHistory || []).filter((p) => p.at >= mt - BOT_ORIGIN_LAG && p.at <= mt);
  return samples.some((p) => {
    const rel = o[1] - (p.y || 0);
    return Math.hypot(o[0] - p.x, o[2] - p.z) <= BOT_MUZZLE_REACH && rel >= 0.3 && rel <= 2.1 &&
      !mapLineBlocked(settings.map, [p.x, (p.y || 0) + 1.3, p.z], o, 0.02);
  });
}
// altura de las muestras de exposición a explosiones según la pose
function blastHeightOf(entity) {
  return hitAimHeights(currentVolumeOf(entity)).blast;
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
// Dos jugadores con el mismo nombre serían indistinguibles en marcador y
// killfeed: el segundo recibe un sufijo numérico dentro del tope de 14.
function uniqueName(name) {
  const taken = new Set(allSlots().map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`, candidate = name.slice(0, 14 - suffix.length).trimEnd() + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return name;
}
// Estado público de la sala para la pantalla de entrada: se consulta por
// HTTP ANTES de conectar, así el jugador sabe si va a crear, unirse o esperar.
function publicStatus() {
  const humans = [...players.values()];
  const state = !humans.length ? 'empty' : phase === 'lobby' ? 'lobby' : 'match';
  return {
    state, players: humans.length, bots: bots.size, slots: allSlots().length,
    fillBots: settings.fillBots, joinable: state === 'empty' || canAdmitHuman(),
    maxPlayers: MAX_PLAYERS, names: humans.map((p) => p.name),
    host: players.get(hostId)?.name ?? null,
    map: settings.map, round, rounds: settings.rounds, wins: { ...wins },
  };
}
function lobbyError(ws, code, detail = '') { send(ws, { t: 'lobbyError', code, detail }); }
function clearTimer() { if (phaseTimer) clearTimeout(phaseTimer); phaseTimer = null; }
// Arma ESPECIAL del mapa: una por ronda, alternando (impar sniper, par
// bazooka). El servidor es la ÚNICA autoridad de quién se la lleva: dos
// jugadores que la reclaman a la vez producen un solo ganador.
let special = { wep: null, taken: true, by: null };
const powerRespawn = new PowerRespawn();
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
  settings = roomDefaults(); phase = 'empty'; startAt = 0; round = 0;
  wins = { red: 0, blue: 0 }; pools = { red: 0, blue: 0 }; resetWorld();
}
// Con relleno automático los bots no ocupan lugar de cara a un humano: ceden
// su puesto. Sin relleno, cada bot colocado a mano cuenta como ocupante.
const humanSlots = () => [...players.values()];
const seatPool = () => (settings.fillBots ? humanSlots() : allSlots());
function assignTeam() {
  const c = teamCounts(seatPool());
  if (c.red >= TEAM_CAPACITY) return 'blue';
  if (c.blue >= TEAM_CAPACITY) return 'red';
  return c.red <= c.blue ? 'red' : 'blue';
}
function canJoinTeam(entity, team) {
  if (team !== 'red' && team !== 'blue') return false;
  const pool = entity.bot ? allSlots() : seatPool();
  return pool.filter((p) => p.id !== entity.id && p.team === team).length < TEAM_CAPACITY;
}
function makeBot(team) {
  const id = 'b' + nextBotId++, occupied = allSlots().map((p) => p.name);
  const bot = { id, bot: true, team, name: makeBotName(team, occupied), v: (nextBotId - 2) % 5,
    hp: HP, alive: true, kills: 0, deaths: 0, w: 'smg', specialWep: null,
    lastFireAt: -Infinity, pendingShot: null };
  bots.set(id, bot);
  return bot;
}
// LOBBY con relleno: cada equipo se completa con bots hasta su capacidad y se
// retiran los que sobran cuando entra un humano o alguien cambia de equipo.
function syncLobbyBots() {
  if (!settings.fillBots) return;
  for (const team of ['red', 'blue']) {
    const humans = humanSlots().filter((p) => p.team === team).length;
    const mine = [...bots.values()].filter((b) => b.team === team);
    const want = Math.max(0, TEAM_CAPACITY - humans);
    for (const extra of mine.slice(want)) bots.delete(extra.id);
    for (let i = mine.length; i < want; i++) makeBot(team);
  }
}
// ¿Cabe un humano más AHORA? En partida empezada entra si puede relevar a un
// bot o si queda un lugar libre; la pantalla final no admite a nadie.
function canAdmitHuman() {
  if (players.size >= MAX_PLAYERS || phase === 'final') return false;
  if (inMatch()) return bots.size > 0 || allSlots().length < MAX_PLAYERS;
  return seatPool().length < MAX_PLAYERS;
}
// Bot que cede su lugar a quien entra con la partida empezada: del equipo
// con menos humanos y, de preferencia, uno vivo para que juegue de inmediato.
function botToRelieve() {
  const humans = teamCounts(humanSlots());
  const order = humans.red <= humans.blue ? ['red', 'blue'] : ['blue', 'red'];
  for (const team of order) {
    const mine = [...bots.values()].filter((b) => b.team === team);
    if (mine.length) return mine.find((b) => b.alive) || mine[0];
  }
  return null;
}
function lateJoinPayload() {
  const now = nowSec();
  return { t: 'matchStart', late: 1, phase, startAt, round,
    startsIn: Math.max(0, startAt - now),
    settings: { ...settings }, wins: { ...wins }, lives: livesState(),
    players: allSlots().map(pub), rows: statRows(),
    special: { wep: special.taken ? null : special.wep } };
}
function freshCombatState(p, spawn) {
  Object.assign(p, { x: spawn.x, z: spawn.z, y: 0, yaw: spawn.yaw, st: 'idle', aim: 0,
    p: 0, ae: 0, cl: 0, ce: 1, ck: null, w: 'smg', sp: 0, hp: HP, alive: true,
    specialWep: null,
    weaponSlots: ['smg', 'shotgun', 'pistol', 'grenade'],
    ammoBudget: createAmmoBudget(), fireWeapon: null, // vida nueva: sin arma previa
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
  const b = bots.get(str(msg.bot)) || null;
  if (b) syncBotTransport(b, me);
  return b;
}
// un bot alojado viaja por el socket de su host: mismo silencio y mismo orden
function syncBotTransport(b, host) {
  b.stallCredit = host.stallCredit; b.stallAt = host.stallAt; b.msgSeq = host.msgSeq;
}

const dazed = (entity) => nowSec() < (entity?.dazeUntil || 0); // pateado: ni dispara, ni golpea, ni lanza
function relayNade(sourceWs, shooter, msg) {
  if(dazed(shooter)||prototypes.stunned(shooter?.id)||shooter?.weaponSlots?.[3]==='frag')return false;
  if (!shooter?.alive || phase !== 'playing' || shooter.nades <= 0) return false;
  const o = vec3(msg.o), v = vec3(msg.v); if (!o || !v) return false;
  const now = nowSec();
  if (now - shooter.lastNadeAt < NADE_RELAY_INTERVAL) return false;
  if (!projectileCadenceAllows(shooter, 'grenade', now)) return false;
  const horizontalOrigin = Math.hypot(o[0] - shooter.x, o[2] - shooter.z);
  const verticalOrigin = Math.abs(o[1] - ((shooter.y || 0) + 1.1));
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (horizontalOrigin > 2.5 || verticalOrigin > 3 || speed < 0.5 || speed > 18) return false;
  const nid = `n${nextNadeId++}`;
  const cid = typeof msg.cid === 'string' && /^[a-zA-Z0-9:_-]{1,40}$/.test(msg.cid)
    ? msg.cid : null;
  shooter.lastNadeAt = now; commitProjectileCadence(shooter, 'grenade', now);
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

// Proyectiles (cohete, humo, frag/stun) pasan por el MISMO horario por arma y
// la misma evidencia de cambio que las armas de fuego, y quedan registrados
// como última arma disparada: sin esto, arma → cohete → arma esquivaba el
// gesto de cambio.
const projectileInterval = (weapon) => 60 / (WD[weapon]?.rpm || 60);
const projectileMeta = (shooter) => ({ wAt: shooter.wAt, wSeq: shooter.wSeq, wWeapon: shooter.wSeen, wInstant: !!shooter.wInstant, requireSwapEvidence: true });
function projectileCadenceAllows(shooter, weapon, now) {
  // el arma del lanzamiento tiene que ser la EQUIPADA replicada, siempre
  if (shooter.w !== weapon) return false;
  return fireCadenceAllows(shooter, weapon, projectileInterval(weapon), now, projectileMeta(shooter));
}
function commitProjectileCadence(shooter, weapon, now) {
  commitFireCadence(shooter, weapon, projectileInterval(weapon), now, projectileMeta(shooter));
}

function relayRocket(sourceWs, shooter, msg) {
  if(prototypes.stunned(shooter?.id)||dazed(shooter))return false;
  if (!shooter?.alive || phase !== 'playing' ||
      shooter.specialWep !== 'bazooka') return false;
  const o = vec3(msg.o), d = vec3(msg.d); if (!o || !d) return false;
  const now = nowSec();
  if (now - shooter.lastRocketAt < ROCKET_RELAY_INTERVAL) return false;
  if (!projectileCadenceAllows(shooter, 'bazooka', now)) return false;
  const horizontalOrigin = Math.hypot(o[0] - shooter.x, o[2] - shooter.z);
  const verticalOrigin = Math.abs(o[1] - ((shooter.y || 0) + 1.1));
  const len = Math.hypot(d[0], d[1], d[2]);
  if (horizontalOrigin > 2.2 || verticalOrigin > 2.2 || len < 0.5 || len > 1.5) return false;
  if (shooter.bot && !botOriginLegal(shooter, o)) return false;
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
  // El arma equipada la decide el estado replicado (validada arriba); un
  // lanzamiento nunca la reescribe.
  shooter.lastRocketAt = now; commitProjectileCadence(shooter, 'bazooka', now);
  shooter.pendingShot = null;
  const fp = validatedFirePose(shooter, msg.fp);
  const packet = { t: 'rocket', rid, id: shooter.id, o, d: dir,
    ...(fp ? { fp } : {}) };
  broadcastRawExcept(sourceWs, packet);
  send(sourceWs, { t: 'rocketAck', rid, id: shooter.id, cid, o, d: dir });
  return true;
}
function livesOf(team) { return pools[team] + allSlots().filter((p) => p.team === team && (p.alive || p.respawnAt > 0)).length; }
function livesState() { return { red: livesOf('red'), blue: livesOf('blue') }; }
function prepareRound(first = false) {
  clearTimer(); round++;
  const roster = allSlots(), counts = teamCounts(roster), indices = { red: 0, blue: 0 };
  pools = { red: Math.max(0, settings.lives - counts.red), blue: Math.max(0, settings.lives - counts.blue) };
  resetWorld(); startAt = nowSec() + (first ? INTRO_TIME : 0) + COUNTDOWN_TIME;
  waveEpoch = startAt;
  for (const p of roster) freshCombatState(p, pickSpawn(p.team, indices[p.team]++));
  special = { wep: specialForRound(round), taken: false, by: null };
  powerRespawn.deadline = null;
  phase = first ? 'intro' : 'countdown';
  broadcastRaw({ t: first ? 'matchStart' : 'prepare', phase, startAt, round,
    startsIn: Math.max(0, startAt - nowSec()),
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
    phase = 'lobby'; syncLobbyBots(); broadcastLobby(); startMatch();
  } else {
    phase = 'lobby'; startAt = 0; syncLobbyBots();
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
  const wep = ['frag','stun'].includes(target.w)?clampDropWep(target.weaponSlots?.[0]):clampDropWep(target.w);
  const def = WD[wep] || WD.smg;
  const remaining = Math.max(0, Math.floor(Number(target.ammoBudget?.[wep] || 0)));
  // El cliente puede reportar su distribución cargador/reserva para el HUD,
  // pero el total que queda en el arma es exclusivamente el del servidor.
  const mag = Math.min(def.mag || 0, remaining);
  const res = Math.min(def.reserve || 0, Math.max(0, remaining - mag));
  const d = { wep, x: target.x, z: target.z, y: target.y || 0,
    team: target.team, mag, res, t: DROP_LIFE };
  drops.set(id, d); broadcastRaw({ t: 'dropA', id, wep: d.wep, x: d.x, z: d.z, y: d.y, team: d.team, mag, res, life: DROP_LIFE });
}

function validatedFirePose(shooter, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const st = VALID_STATES.has(str(raw.st)) && raw.st !== 'dead'
    ? raw.st : (shooter.st || 'idle');
  const ck = VALID_COVER_KINDS.has(str(raw.ck)) ? raw.ck : null;
  return {
    st, a: raw.a ? 1 : 0,
    p: clamp(raw.p, -1.6, 1.6),
    ae: clamp(raw.ae, -VISUAL_AIM_MAX, VISUAL_AIM_MAX),
    cl: clamp(raw.cl, -1, 1),
    // sin `ce` en el origen no se inventa: los observadores aplican la regla antigua
    ...(Number.isFinite(raw.ce) ? { ce: clamp(raw.ce, 0, 1) } : {}),
    ...(ck ? { ck } : {}),
  };
}

function registerFire(shooter, msg, isBotFire = false) {
  if(prototypes.stunned(shooter?.id)||dazed(shooter))return false;
  if (!shooter?.alive || phase !== 'playing') return false;
  const o = vec3(msg.o), pt = vec3(msg.p); if (!o || !pt) return false;
  const weapon = FIREABLE.has(msg.w) ? msg.w : 'smg', rule = FIRE_RULES[weapon], now = nowSec();
  // La bazooka nace exclusivamente mediante `rocket`; aceptar un `fire` en
  // el punto de explosión devolvería al cliente autoridad sobre la trayectoria.
  if (weapon === 'bazooka') return false;
  // el melee no depende del arma en mano; el resto debe coincidir con ella.
  // Cadencia (guards.js): horario virtual por arma, apertura ≥82 %, crédito
  // solo por jitter/atasco de transporte, gesto de cambio entre armas y `sq`
  // creciente (clientes nuevos) contra duplicados.
  const cadenceMeta = { sq: Number.isFinite(msg.sq) ? msg.sq : undefined,
    wAt: shooter.wAt, wSeq: shooter.wSeq, wWeapon: shooter.wSeen, wInstant: !!shooter.wInstant, requireSwapEvidence: true };
  if ((weapon !== 'melee' && weapon !== shooter.w) ||
      !fireCadenceAllows(shooter, weapon, rule.interval, now, cadenceMeta)) return false;
  const melee = weapon === 'melee';
  // la embestida recorre hasta 3 m en 0,2 s: la posición conocida va por detrás
  const originTolerance = melee ? 0.9 + TUNING.melee.tackleMax : (isBotFire ? 6 : 5);
  if (Math.hypot(o[0] - shooter.x, o[2] - shooter.z) > originTolerance ||
      Math.abs(o[1] - ((shooter.y || 0) + 1.1)) > (melee ? 1.1 : 4)) return false;
  if (isBotFire && !melee && !botOriginLegal(shooter, o)) return false;
  // Rango y falloff se miden desde el PLANO del tirador (pecho a 1.3 m),
  // igual que el cliente: en ADS el origen óptico es la cámara, ~2.2 m por
  // detrás, y medir desde ella descartaba disparos válidos y restaba daño.
  // El descuento solo existe si el PROPIO estado del tirador (aim y pitch de
  // sus snapshots recientes, no el bit del disparo) estaba en ADS y el origen
  // cae en el sobre de su cámara; hip/blindfire (cañón): base 0.
  const planeVec = melee ? null : aimedSetback(shooter, o);
  if (shooterPlaneDistance(o, pt, planeVec) > rule.range + (melee ? 0.22 : 2)) return false;
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
  commitFireCadence(shooter, weapon, rule.interval, now, cadenceMeta); shooter.pendingShot = {
    sq: cadenceMeta.sq,
    at: now, mt: monoSec(), wep: weapon, origin: o, endpoint, direction: shotDir,
    length: shotLen, remainingDamage: rule.maxDamage, hitIds: new Set(), planeVec,
  };
  const fp = validatedFirePose(shooter, msg.fp);
  broadcastRaw({ t: 'fire', id: shooter.id, o, p: endpoint, w: weapon,
    ...(decals?.length ? { d: decals } : {}), ...(fp ? { fp } : {}) }); return true;
}

const HEAD_RADIUS = 0.22;
const SNIPER_HEAD_AUTH_RADIUS = 0.58; // hitbox + margen breve de snapshot/red
const SNIPER_ENDPOINT_EPSILON = 0.28;

// Centro de cabeza de la pose actual (hit-pose.js); con dos volúmenes
// posibles (mantle) el más cercano al punto.
function targetHeadCenter(target) {
  const w = placeHitPose(currentVolumeOf(target), target.x || 0, target.y || 0, target.z || 0, target.yaw || 0);
  return [w.hx, w.hy, w.hz];
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
  // la banda de cabeza (de pie 1.30..1.82, agachado 0.66..1.16, alzado sobre
  // cover bajo...) y el rayo del sniper ya se comprobaron en poseForClaim,
  // con el MISMO volumen que validó el cuerpo
  return pose?.head ? 'head' : 'body';
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
    // por la espalda lo decide el servidor; el placaje se acepta hasta su tope
    const ml = TUNING.melee, dx = pose.x - shooter.x, dz = pose.z - shooter.z, len = Math.hypot(dx, dz);
    const yaw = pose.yaw ?? target.yaw;
    const backstab = !shooter.bot && Number.isFinite(yaw) && len > 0.05 &&
      (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / len > Math.cos(ml.backstabArcDeg * Math.PI / 360);
    const base = backstab ? ml.backstabDmg : shooter.bot ? ml.dmg : Math.min(ml.tackleDmg, Math.max(ml.dmg, num(msg.dmg)));
    return { dmg: base * botScale, part: 'body' };
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
    // ATURDIMIENTO de la patada: lo decide y lo hace cumplir el servidor
    let dz = 0;
    if (!(now < (target.dazeImmuneUntil || 0))) {
      dz = !shooter.bot && dmg >= TUNING.melee.tackleDmg ? TUNING.melee.tackleDaze : TUNING.melee.dazeTime;
      target.dazeUntil = now + dz;
      target.dazeImmuneUntil = target.dazeUntil + TUNING.melee.dazeImmunity;
    }
    broadcastRaw({ t: 'hitConfirm', target: target.id, from: shooter.id,
      w: 'melee', dmg: Math.round(dmg), p, dz });
  }
  if (target.hp > 0) {
    if (shot.wep === 'bazooka' || shot.wep === 'frag') {
      const p = vec3(msg.p) || [target.x, (target.y || 0) + 1, target.z];
      broadcastRaw({ t: 'hitConfirm', target: target.id, from: shooter.id,
        w: shot.wep, dmg: Math.round(dmg), p, ep: shot.origin });
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
  const respawnDelay = pools[target.team] > 0 ? nextRespawnWave(now, waveEpoch) - now : 0;
  if (respawnDelay > 0) { pools[target.team]--; target.respawnAt = now + respawnDelay; }
  else target.respawnAt = 0;
  broadcastRaw({ t: 'death', target: target.id, from: shooter.id, gib: gib ? 1 : 0,
    hs: sniperHeadshot ? 1 : 0, ex: explosiveLevel, w: shot.wep,
    dist: +dist.toFixed(2), dmg: Math.round(dmg), part, respawn: respawnDelay,
    ...(deathPoint ? { p: deathPoint } : {}),
    ...(['bazooka','frag'].includes(shot.wep) ? { ep: shot.origin } : {}),
    kn: shooter.name, kt: shooter.team, vn: target.name, vt: target.team });
  dropWeapon(target);
  target.specialWep = null;
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
  // claim de otro disparo (cliente nuevo con `sq`): nunca se adjunta al vigente
  if (Number.isFinite(msg.sq) && Number.isFinite(shot.sq) && msg.sq !== shot.sq) return;
  const point = vec3(msg.p); if (!point) return;
  // modelo de impacto y latencia del tirador (bots: los del host que los simula)
  const viewer = shooter.bot ? players.get(hostId) : shooter;
  const pose = poseForClaim(target, point, shot, viewer?.hitModel !== 2, viewer?.rtt); if (!pose) return;
  // quemarropa: el cliente impactó con el origen DENTRO del rival (contacto de
  // longitud cero, sin dirección): vale solo si el punto está dentro del volumen
  const pointBlank = !shot.direction && shot.wep !== 'melee' && shot.wep !== 'bazooka';
  if ((pointBlank ? !pose.inside || distance3(point, shot.origin) > 0.05 : !claimMatchesShot(shot, point)) ||
      mapLineBlocked(settings.map, shot.origin, point, shot.wep === 'melee' ? 0.24 : 0.18)) return;
  // misma definición que el rango del fire: distancia desde el plano del tirador
  const dist = shooterPlaneDistance(shot.origin, point, shot.planeVec);
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
    // misma regla que offline (special.js): la espoleta tiene que VER el torso;
    // un muro fino lateral no deja detonar sobre quien está detrás
    if (separation > 0.001 && mapLineBlocked(settings.map, point, [target.x, centerY, target.z], 0.02)) continue;
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
    const resultBlast=evaluateBlast(WD.bazooka,{x:blast[0],y:blast[1],z:blast[2]},{...target,blastH:blastHeightOf(target)},
      (a,b)=>mapLineBlocked(settings.map,[a.x,a.y,a.z],[b.x,b.y,b.z],.015),
      {self,direct:target.id===directTarget?.id});
    if(resultBlast.damage<=0)continue;
    const authoritative = {
      dmg: resultBlast.damage, part: 'body',
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
  // latencia del tirador para el rebobinado de impactos: ping/pong de control
  // de WebSocket (el navegador responde solo; no es un mensaje del protocolo)
  // Cada pong se empareja con su ping por id; rtt = mínimo de las 8 últimas
  // muestras (inflarlo exige retrasar todas) y hit-pose.js lo topa (RTT_CAP).
  ws.on('pong', (data) => {
    const id = String(data), sent = me?.pings?.get(id);
    if (sent === undefined) return;
    me.pings.delete(id);
    (me.rttSamples ||= []).push(monoSec() - sent);
    if (me.rttSamples.length > 8) me.rttSamples.shift();
    me.rtt = Math.min(...me.rttSamples);
  });
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
    // solo objetos con tipo de texto (null, números o listas no son mensajes)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    if (msg.t === 'join' && !me) {
      const action = msg.action === 'create' ? 'create' : 'join';
      if (action === 'create' && players.size) { lobbyError(ws, 'lobby-exists'); return; }
      if (action === 'join' && !players.size) { lobbyError(ws, 'no-lobby'); return; }
      const late = inMatch();
      if (phase === 'final') { lobbyError(ws, 'in-progress'); return; }
      if (!canAdmitHuman()) { lobbyError(ws, late ? 'in-progress' : 'lobby-full'); return; }
      // Partida empezada: quien entra releva a un bot (hereda su equipo y su
      // turno de reaparición); sin bots ocupa un lugar libre.
      const relieved = late ? botToRelieve() : null;
      const team = relieved ? relieved.team : assignTeam();
      if (!relieved && !canJoinTeam({ id: '' }, team)) { lobbyError(ws, 'lobby-full'); return; }
      const id = 'p' + nextId++;
      me = { ws, id, bot: false, team, joinedAt: Date.now(),
        name: uniqueName(str(msg.name).trim().slice(0, 14).toUpperCase() || 'ANON'),
        v: Math.min(4, Math.max(0, Math.round(num(msg.v)))), hp: HP, alive: true,
        kills: 0, deaths: 0, w: 'smg', specialWep: null,
        // modelo de impacto anunciado en el join (2 = pose); ausente = anterior
        hitModel: msg.hp === 2 ? 2 : 1,
        lastFireAt: -Infinity, pendingShot: null };
      if (relieved) bots.delete(relieved.id);
      players.set(id, me); if (!hostId) { hostId = id; phase = 'lobby'; }
      if (!late) {
        syncLobbyBots();
        send(ws, { t: 'welcome', id, team: me.team, lobby: lobbyPayload(), hp: 2 }); broadcastLobby();
        console.log(`+ ${me.name} (${me.team}) — ${players.size} humanos, ${bots.size} bots`); return;
      }
      const joinedAt = nowSec();
      freshCombatState(me, pickSpawn(team));
      me.prot = Math.max(startAt, joinedAt) + SPAWN_PROT;
      if (relieved && !relieved.alive) {
        // el bot estaba eliminado: no se regala una vida, se espera su turno
        Object.assign(me, { alive: false, hp: 0, respawnAt: relieved.respawnAt || 0,
          x: relieved.x ?? me.x, z: relieved.z ?? me.z, y: relieved.y || 0 });
      }
      send(ws, { t: 'welcome', id, team: me.team, lobby: lobbyPayload(), hp: 2 });
      send(ws, lateJoinPayload());
      CRATES.forEach((c, i) => { if (!c.up) send(ws, { t: 'crate', i, up: 0 }); });
      for (const [dropId, d] of drops) send(ws, { t: 'dropA', id: dropId, wep: d.wep, x: d.x, z: d.z,
        y: d.y, team: d.team, mag: d.mag, res: d.res, life: d.t });
      broadcastRawExcept(ws, { t: 'joined', ...pub(me), replaced: relieved?.id ?? null });
      broadcastLobby();
      console.log(`+ ${me.name} (${me.team}) entra con la partida empezada${relieved ? ` por ${relieved.name}` : ''}`);
      return;
    }
    if (!me) return;
    noteMessageArrival(me, nowSec()); // evidencia de atasco para la cadencia
    if(msg.t==='protoClaim'){prototypes.claim(me.id,str(msg.id),msg.manual===true);return;}
    if(msg.t==='protoFire'){
      if(!me.weaponSlots?.includes(msg.kind)||me.w!==msg.kind||['melee','dive','slide','mantle'].includes(me.st))return;
      const o=vec3(msg.o),d=vec3(msg.d),pnow=nowSec();
      if(!o||!d||!projectileCadenceAllows(me,msg.kind,pnow))return;
      // solo un lanzamiento ACEPTADO por el motor consume horario
      if(prototypes.fire(me.id,msg.kind,{x:o[0],y:o[1],z:o[2]},{x:d[0],y:d[1],z:d[2]}))commitProjectileCadence(me,msg.kind,pnow);
      const s=prototypes.state(me.id);
      if(['frag','stun'].includes(msg.kind))send(ws,{t:'protoInventory',id:me.id,kind:msg.kind,count:msg.kind==='frag'?s.frag:s.stunAmmo});
      return;
    }
    if(prototypes.stunned(me.id)&&['takeDrop','takeSpecial','crate','takeCrate','reload'].includes(msg.t))return;
    if (msg.t === 'lobbySettings') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      const hadFill = settings.fillBots;
      settings = normalizeLobbySettings({ ...settings, ...msg.settings });
      // "sin bots" los retira todos; "rellenar" completa ambos equipos
      if (hadFill && !settings.fillBots) bots.clear();
      syncLobbyBots();
      broadcastLobby(); return;
    }
    if (msg.t === 'lobbyTeam') {
      if (phase !== 'lobby') { lobbyError(ws, 'locked'); return; }
      const team = msg.team === 'blue' ? 'blue' : 'red';
      if (me.team === team) return;
      if (settings.fillBots) {
        // con relleno, cualquiera cambia de equipo mientras haya menos de 4
        // humanos allá: el bot sobrante pasa al equipo que se deja
        if (!canJoinTeam(me, team)) { lobbyError(ws, 'team-full'); return; }
        me.team = team; syncLobbyBots(); broadcastLobby(); return;
      }
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
      // con relleno automático los bots no se administran a mano
      if (settings.fillBots) { broadcastLobby(); return; }
      if (allSlots().length >= MAX_PLAYERS) { lobbyError(ws, 'lobby-full'); return; }
      const team = msg.team === 'blue' ? 'blue' : 'red', probe = { id: '', team, bot: true };
      if (!canJoinTeam(probe, team)) { lobbyError(ws, 'team-full'); return; }
      makeBot(team);
      broadcastLobby(); return;
    }
    if (msg.t === 'lobbyBotRemove' || msg.t === 'lobbyBotTeam') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      if (settings.fillBots) { broadcastLobby(); return; }
      const bot = bots.get(msg.id); if (!bot) { lobbyError(ws, 'bot-missing'); return; }
      if (msg.t === 'lobbyBotRemove') bots.delete(bot.id);
      else { if (!canJoinTeam(bot, msg.team)) { lobbyError(ws, 'team-full'); return; } bot.team = msg.team; }
      broadcastLobby(); return;
    }
    if (msg.t === 'lobbyStart') {
      if (!isHost(me) || phase !== 'lobby') { lobbyError(ws, 'host-only'); return; }
      syncLobbyBots();
      const validity = validateLobby(allSlots(), settings);
      if (!validity.ok) { lobbyError(ws, 'invalid', validity.errors.join(',')); broadcastLobby(); return; }
      startMatch(); return;
    }
    if (msg.t === 's') {
      if(prototypes.stunned(me.id)){
        me.aim=0;me.sp=0;
        send(ws,{t:'correction',x:me.x,y:me.y||0,z:me.z,reason:'stun'});return;
      }
      if (phase !== 'playing' || !me.alive) {
        me.st = 'idle'; me.aim = 0; me.ae = 0; me.cl = 0; me.ce = 1; me.ck = null;
        me.sp = 0; me.rl = null; return;
      }
      if (![msg.x, msg.y, msg.z, msg.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      const next = { x: clamp(msg.x, -60, 60), z: clamp(msg.z, -60, 60), y: clamp(msg.y, 0, 20) };
      const stateNow = nowSec();
      if (!acceptMovement(me, next, stateNow, ALLOW_TEST_TELEPORTS)) {
        send(ws, { t: 'correction', x: me.x, y: me.y || 0, z: me.z, reason: 'movement' });
        return;
      }
      me.x = next.x; me.z = next.z; me.y = next.y; me.yaw = clamp(msg.yaw, -10, 10);
      me.st = VALID_STATES.has(str(msg.st)) && msg.st !== 'dead' ? msg.st : 'idle';
      me.aim = msg.aim ? 1 : 0; me.p = clamp(msg.p, -1.6, 1.6);
      me.ae = clamp(msg.ae, -VISUAL_AIM_MAX, VISUAL_AIM_MAX);
      me.cl = clamp(msg.cl, -1, 1);
      me.ce = Number.isFinite(msg.ce) ? clamp(msg.ce, 0, 1) : 1;
      me.ceKnown = Number.isFinite(msg.ce);
      me.ck = VALID_COVER_KINDS.has(str(msg.ck)) ? msg.ck : null;
      const requestedWep = clampWep(msg.w);
      const stateWep = (['frag','stun'].includes(requestedWep)&&!me.weaponSlots.includes(requestedWep)) || SPECIAL_WEAPONS.has(requestedWep) && me.specialWep !== requestedWep ? 'smg' : requestedWep;
      // Estado VIEJO tras una recogida: el cliente lo envió antes de recibir
      // specialTaken (aún con el arma anterior). No deshace la recogida ni
      // consume su tiro inmediato; un cambio real llega después de ese plazo.
      const staleAfterGrant = me.wGrant && nowSec() < me.wGrant.until && stateWep === me.wGrant.from;
      if (!staleAfterGrant) me.w = stateWep;
      // instante en que el arma replicada cambió: evidencia del gesto de cambio
      if (me.w !== me.wSeen) { me.wSeen = me.w; me.wAt = nowSec(); me.wSeq = me.msgSeq; me.wInstant = false; }
      const def = WD[me.w] || WD.smg;
      me.am = clamp(msg.am, 0, def.mag || 0); me.ar = clamp(msg.ar, 0, def.reserve || 0);
      me.sp = clamp(msg.sp, 0, 1);
      // progreso de recarga (opcional, solo presentación: la munición y el fin
      // de la recarga se deciden donde siempre). Ausente = no recarga.
      me.rl = Number.isFinite(msg.rl) ? clamp(msg.rl, 0, 1) : null;
      return; // la pose se registra al difundirla (snap)
    }
    if (msg.t === 'botState') {
      if (!isHost(me) || phase !== 'playing' || !Array.isArray(msg.bots)) return;
      const stateNow = nowSec();
      for (const s of msg.bots.slice(0, MAX_PLAYERS)) {
        // entrada malformada: se descarta, nunca lanza
        if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
        const b = bots.get(s.id); if (!b || !b.alive) continue;
        if(prototypes.stunned(b.id))continue;
        if (![s.x, s.y, s.z, s.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
        const next = { x: clamp(s.x, -60, 60), z: clamp(s.z, -60, 60), y: clamp(s.y, 0, 20) };
        if (!acceptMovement(b, next, stateNow, ALLOW_TEST_TELEPORTS)) continue;
        b.x = next.x; b.z = next.z; b.y = next.y; b.yaw = clamp(s.yaw, -10, 10);
        b.st = VALID_STATES.has(str(s.st)) && s.st !== 'dead' ? s.st : 'idle';
        b.aim = s.aim ? 1 : 0; b.p = clamp(s.p, -1.6, 1.6);
        b.ae = clamp(s.ae, -VISUAL_AIM_MAX, VISUAL_AIM_MAX); b.cl = clamp(s.cl, -1, 1);
        b.ce = Number.isFinite(s.ce) ? clamp(s.ce, 0, 1) : 1;
        b.ceKnown = Number.isFinite(s.ce);
        b.ck = VALID_COVER_KINDS.has(str(s.ck)) ? s.ck : null;
        const requestedWep = clampWep(s.w);
        b.w = SPECIAL_WEAPONS.has(requestedWep) && b.specialWep !== requestedWep ? 'smg' : requestedWep;
        // arma replicada del bot: misma evidencia de cambio que un jugador
        if (b.w !== b.wSeen) { b.wSeen = b.w; b.wAt = stateNow; b.wSeq = me.msgSeq; b.wInstant = false; }
        b.sp = clamp(s.sp, 0, 1);
        b.rl = Number.isFinite(s.rl) ? clamp(s.rl, 0, 1) : null;
      } return;
    }
    // Un disparo rechazado no deja sus claims colgados del anterior.
    if (msg.t === 'fire') { if (!registerFire(me, msg)) me.pendingShot = null; return; }
    if (msg.t === 'botFire') { if (isHost(me)) { const b = bots.get(msg.id);
      if (!b && LOG_FIRE_REJECTS) console.log('[botFire rechazado]', JSON.stringify({ id: msg.id, w: msg.w, alive: false, phase, reason: 'unknown-bot' }));
      if (b) {
      const requestedWep = FIREABLE.has(msg.w) ? msg.w : 'smg';
      if (SPECIAL_WEAPONS.has(requestedWep) && b.specialWep !== requestedWep) {
        if (LOG_FIRE_REJECTS) console.log('[botFire rechazado]', JSON.stringify({ id: b.id, w: msg.w, held: b.w,
          alive: b.alive, phase, reason: 'special-not-owned', specialWep: b.specialWep }));
        return;
      }
      // el arma se valida contra la REPLICADA por botState (b.w); el mensaje de
      // disparo no puede cambiarla por su cuenta
      syncBotTransport(b, me);
      if (!registerFire(b, msg, true)) {
        b.pendingShot = null;
        // diagnóstico de pruebas (BREACH_LOG_FIRE_REJECTS=1): por qué se rechazó
        if (LOG_FIRE_REJECTS) console.log('[botFire rechazado]', JSON.stringify({ id: b.id, w: msg.w, held: b.w,
          alive: b.alive, dazed: dazed(b), stunned: prototypes.stunned(b.id), phase,
          last: b.lastActionWeapon, since: +(nowSec() - (b.lastActionAt ?? -1e9)).toFixed(3),
          mag: b.botMag?.[msg.w]?.mag, budget: b.ammoBudget?.[msg.w], cadence: b.lastRejectReason,
          fireWeapon: b.fireWeapon, wSeen: b.wSeen, wAge: +(nowSec() - (b.wAt ?? -1e9)).toFixed(3), lastHeld: b.lastActionHeld }));
        b.lastRejectReason = null;
      }
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
      if (!d || !me.alive || phase !== 'playing' || Math.hypot(me.x - d.x, me.z - d.z) > 1.6 || Math.abs((me.y || 0) - d.y) > 0.8) return;
      me.weaponSlots ||= ['smg', 'shotgun', 'pistol', 'grenade'];
      const def = WD[d.wep];
      if (msg.replace === true) {
        const slot = replacementSlot(me.weaponSlots, me.w);
        if (!canReplaceDrop(me.weaponSlots, d.wep) || msg.slot !== slot || msg.expected !== me.weaponSlots[slot]) return;
        const removed = me.weaponSlots[slot];
        me.weaponSlots[slot] = d.wep;
        me.ammoBudget[removed] = 0;
        me.specialWep = me.weaponSlots.find(w => SPECIAL_WEAPONS.has(w)) || null;
        grantWeaponAmmo(me, d.wep, d.mag, d.res);
        // reemplazar el arma EN MANO por la del suelo es un cambio sin gesto
        // (el cliente solo cambia `cur` si sustituyó la que llevaba)
        if (removed === me.w) { me.w = d.wep; me.wSeen = d.wep; me.wAt = nowSec(); me.wSeq = me.msgSeq; me.wInstant = true; }
        drops.delete(msg.id); broadcastRaw({ t: 'dropR', id: msg.id });
        send(ws, { t: 'dropGive', replace: true, slot, wep: d.wep, mag: d.mag, res: d.res });
      } else {
        if (!me.weaponSlots.includes(d.wep) || !Number.isFinite(msg.capacity)) return;
        const room = Math.max(0, def.mag + def.reserve - (me.ammoBudget[d.wep] || 0));
        const amount = takeDropAmmo(d, Math.min(room, def.reserve, Math.max(0, msg.capacity)));
        if (!amount) return;
        me.ammoBudget[d.wep] = (me.ammoBudget[d.wep] || 0) + amount;
        send(ws, { t: 'dropGive', wep: d.wep, amount });
        if (d.mag + d.res <= 0) { drops.delete(msg.id); broadcastRaw({ t: 'dropR', id: msg.id }); }
        else broadcastRaw({ t: 'dropUpdate', id: msg.id, mag: d.mag, res: d.res });
      }
      return;
    }
    // pickup del arma especial: gana el PRIMER reclamo válido y solo uno
    if (msg.t === 'takeSpecial') {
      const claimant = msg.bot && isHost(me) ? bots.get(msg.bot) : me;
      if (!claimant?.alive || phase !== 'playing' || special.taken || !special.wep) return;
      const spot = MAP_RUNTIME[settings.map]?.special;
      if (!spot || Math.hypot(claimant.x - spot.x, claimant.z - spot.z) > 2.2 ||
          Math.abs((claimant.y || 0) - (spot.y || 0)) > 1.5) return;
      special.taken = true; special.by = claimant.id; claimant.specialWep = special.wep;
      // recoger la especial la pone EN MANO al instante (sin gesto): cuenta como cambio
      // el servidor queda como tras un cambio real a esa arma: `w` incluido
      // El hueco se elige con el arma EN MANO antes de recoger (misma regla
      // compartida que el cliente: specialPickupSlot en drop-policy.js).
      claimant.weaponSlots ||= ['smg', 'shotgun', 'pistol', 'grenade'];
      const heldBefore = claimant.w;
      claimant.weaponSlots[specialPickupSlot(claimant.weaponSlots, heldBefore, special.wep)] = special.wep;
      claimant.w = special.wep; claimant.wSeen = special.wep; claimant.wAt = nowSec(); claimant.wInstant = true;
      claimant.wSeq = me.msgSeq;
      // plazo para estados viejos: lo que tarda specialTaken en llegar y el
      // siguiente estado en volver (ida y vuelta + un envío a 20 Hz)
      claimant.wGrant = { from: heldBefore, until: nowSec() + Math.min(0.5, (claimant.rtt ?? 0.15) + 0.1) };
      grantWeaponAmmo(claimant, special.wep);
      broadcastRaw({ t: 'specialTaken', id: claimant.id, wep: special.wep });
      return;
    }
    if (msg.t === 'crate') {
      // índice entero: una clave objeto se convertiría a texto (y puede lanzar)
      const ci = Number.isInteger(msg.i) ? msg.i : -1;
      const c = CRATES[ci];
      const spot = MAP_RUNTIME[settings.map]?.crates?.[ci];
      if (!c || !spot || !c.up || !me.alive || phase !== 'playing' ||
          Math.hypot(me.x - spot.x, me.z - spot.z) > 3) return;
      c.up = false; c.t = CRATE_RESPAWN; broadcastRaw({ t: 'crate', i: ci, up: 0, by: me.id });
      refillNormalAmmo(me);
    }
  });
  ws.on('close', () => {
    if (!me || !players.has(me.id)) return;
    players.delete(me.id);
    if (!players.size) { resetRoom(); me = null; return; }
    // Con relleno, quien abandona una partida empezada deja un bot en su
    // lugar: mismo equipo, misma posición y mismo estado (vivo, o eliminado
    // esperando el turno que le tocaba), así el equipo no queda en desventaja.
    let stand = null;
    if (settings.fillBots && inMatch() && phase !== 'final') {
      stand = makeBot(me.team);
      freshCombatState(stand, { x: me.x ?? 0, z: me.z ?? 0, yaw: me.yaw || 0 });
      stand.y = me.y || 0;
      if (me.alive) stand.hp = Math.max(1, me.hp ?? HP);
      else Object.assign(stand, { alive: false, hp: 0, respawnAt: me.respawnAt || 0 });
      resetMovementGuard(stand, nowSec());
      resetPoseHistory(stand);
    }
    broadcastRaw({ t: 'left', id: me.id, name: me.name, bot: stand ? pub(stand) : null });
    if (hostId === me.id) {
      hostId = [...players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0].id;
      broadcastRaw({ t: 'host', id: hostId });
    }
    if (phase === 'playing') checkRoundEnd();
    else if (phase === 'lobby') syncLobbyBots();
    broadcastLobby();
    me = null;
  });
});

let prototypeLastTick=performance.now();
setInterval(() => {
  const now = nowSec();
  if (phase === 'playing') { tickRockets(now); tickSmoke(now); }
  prototypes.setRound(`${settings.map}:${round}`,phase==='playing');
  const prototypeNow=performance.now();prototypes.tick((prototypeNow-prototypeLastTick)/1000);prototypeLastTick=prototypeNow;
  for(const p of allSlots()){
    if(!p.alive||!prototypes.stunned(p.id)){p.stunVy=0;continue;}
    const floor=serverMapPhysics(settings.map).groundHeight(p,.38,p.y||0);
    p.stunVy=(p.stunVy||0)-TUNING.jump.gravity/TICK_HZ;
    p.y=Math.max(floor,(p.y||0)+p.stunVy/TICK_HZ);p.aim=0;p.sp=0;
    if(!String(p.st).includes('cover'))p.st='idle';
  }
  if(players.size&&inMatch())broadcastRaw({t:'protoState',...prototypes.snapshot()});
  if (phase === 'playing') for (const p of allSlots()) {
    if (p.alive && p.hp < HP && now - p.lastDamage > REGEN_DELAY) p.hp = Math.min(HP, p.hp + REGEN_RATE / TICK_HZ);
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) {
      p.alive = true; p.hp = HP; p.respawnAt = 0; p.prot = now + SPAWN_PROT;
      p.w = 'smg'; p.specialWep = null; p.ammoBudget = createAmmoBudget(); p.fireWeapon = null;
      p.weaponSlots = ['smg', 'shotgun', 'pistol', 'grenade'];
      p.nades = p.bot ? 1 : WD.grenade.mag;
      p.lastNadeAt = -Infinity; p.lastRocketAt = -Infinity;
      const spawn = pickSpawn(p.team); Object.assign(p, { x: spawn.x, z: spawn.z, y: 0, yaw: spawn.yaw });
      resetMovementGuard(p, now);
      resetPoseHistory(p);
      broadcastRaw({ t: 'respawn', id: p.id, spawn });
    }
  }
  for (const [id, d] of drops) { d.t -= 1 / TICK_HZ; if (d.t <= 0) { drops.delete(id); broadcastRaw({ t: 'dropR', id }); } }
  const powerAvailable = !special.taken || allSlots().some(p => p.alive &&
    p.weaponSlots?.includes(special.wep) && (p.ammoBudget?.[special.wep] || 0) > 0) ||
    [...drops.values()].some(d => d.wep === special.wep && d.mag + d.res > 0);
  if (powerRespawn.update(now, phase === 'playing' && !!special.wep, powerAvailable)) {
    special.taken = false; special.by = null;
    broadcastRaw({ t: 'specialRespawn', wep: special.wep });
  }
  for (let i = 0; i < CRATES.length; i++) { const c = CRATES[i]; if (!c.up) { c.t -= 1 / TICK_HZ; if (c.t <= 0) { c.up = true; broadcastRaw({ t: 'crate', i, up: 1 }); } } }
  if (players.size && inMatch()) broadcastRaw({ t: 'snap', phase,
    startsIn: (phase === 'intro' || phase === 'countdown')
      ? Math.max(0, startAt - now) : 0,
    lives: livesState(), wins: { ...wins },
    ps: allSlots().map((p) => ({ id: p.id, x: p.x ?? 0, z: p.z ?? 0, y: p.y || 0,
      yaw: p.yaw || 0, st: p.st || 'idle', aim: p.aim || 0, p: p.p || 0,
      ae: p.ae || 0, cl: p.cl || 0, ...(p.ceKnown ? { ce: p.ce } : {}),
      ...(p.ck ? { ck: p.ck } : {}), w: p.w || 'smg',
      sp: p.sp || 0, ...(p.alive && p.rl != null ? { rl: +p.rl.toFixed(2) } : {}), hp: Math.round(p.hp), alive: p.alive,
      resp: !p.alive && p.respawnAt > now ? +(p.respawnAt - now).toFixed(2) : 0,
      rq: !p.alive && p.respawnAt > 0 ? 1 : 0,
      inv: p.prot > now ? 1 : 0, bot: p.bot ? 1 : 0 })) });
  // historial de impactos = lo que los observadores acaban de recibir
  if (players.size && inMatch()) { const mt = monoSec(); for (const p of allSlots()) recordPose(p, mt); }
}, 1000 / TICK_HZ);
// un ping por segundo a cada humano, con id (ver ws.on('pong')); los que no
// vuelven en 5 s caducan
let pingSeq = 0;
setInterval(() => {
  const t = monoSec();
  for (const p of players.values()) {
    if (p.ws?.readyState !== 1) continue;
    p.pings ||= new Map();
    for (const [k, at] of p.pings) if (t - at > 5) p.pings.delete(k);
    const id = String(++pingSeq); p.pings.set(id, t);
    try { p.ws.ping(id); } catch { p.pings.delete(id); }
  }
}, 1000);

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, num(v))); }
function vec3(v) { if (!Array.isArray(v) || v.length !== 3) return null; const out = v.map(num); return out.every((n) => Math.abs(n) < 1000) ? out : null; }

server.listen(PORT, () => console.log(`BREACH server en http://localhost:${PORT} (WebSocket en el mismo enlace)`));
