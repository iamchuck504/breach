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
import { dodgeDistance } from '../src/player/dodge.js';
import { TUNING } from '../src/config/tuning.js';
import { nextRespawnWave } from '../src/game/respawn-wave.js';
import { PowerRespawn } from '../src/game/power-respawn.js';
import { takeDropAmmo, canReplaceDrop, replacementSlot, specialPickupSlot } from '../src/game/drop-policy.js';
import { damageFalloff, firearmDamage, rocketSplashDamage } from '../src/combat/damage.js';
import {evaluateBlast} from '../src/combat/blast.js';
import {CombatPrototypes} from '../src/combat/prototypes.js';
import { isSniperHeadshotDeath, rocketDeathLevel } from '../src/combat/death-reactions.js';
import { makeSmokeProjectile, stepSmokeProjectile } from '../src/game/smoke-physics.js';
import { claimPose, currentVolume, placeHitPose, hitAimHeights, hitPose, eyeWorld, recordOwnPose, shotPose, FPS_EYE_TOL, launchWorld, rocketConvergeMaxDeg } from '../src/combat/hit-pose.js';
import { canFireInState, sprintFireOk } from '../src/combat/fire-gates.js';
import { spreadFor } from '../src/combat/weapons.js';
import { meleeHitOk, meleeReachOk, MELEE_REACH, MELEE_NET_TOL } from '../src/combat/melee-reach.js';
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
  MAX_WS_PAYLOAD, MessageRateGuard, acceptMovement, dodgeFireReady, consumeShotAmmo,
  createAmmoBudget, grantWeaponAmmo, refillNormalAmmo, resetMovementGuard,
  fireCadenceAllows, commitFireCadence, noteMessageArrival,
  acceptPosture, resetPostureGuard, POSTURE_UPRIGHT, advanceCadenceClock, srvBurstAllows, commitSrvBurst,
} from './guards.js';
import {
  botPoseAllowsOrigin, BOT_ORIGIN_LAG, clipMapEndpoint, mapLineBlocked, mapPathBlocked, mapSurfaceContact, projectileMapContact,
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
const VALID_STATES = new Set(['idle', 'run', 'roadie', 'dodge', 'dive', 'slide', 'cover_low',
  'cover_high', 'blind_over', 'blind_low_left', 'blind_low_right',
  'blind_high_left', 'blind_high_right', 'jump', 'flip', 'mantle', 'melee', 'dead', 'crouch']);
// Un cliente FPS ya no emite cobertura, blindfire, dive ni flip (contrato §1;
// los bots alojados sí, hasta su etapa). Si llegan, se traducen a la postura
// FPS equivalente en altura de cabeza: agachado tras LOW sigue agachado (y su
// asomo, `ce`, sigue valiendo), el resto, de pie. Nunca un volumen más
// pequeño que lo que el cliente puede estar viendo.
const FPS_RETIRED = { cover_low: 'crouch', blind_over: 'crouch', blind_low_left: 'crouch', blind_low_right: 'crouch',
  cover_high: 'idle', blind_high_left: 'idle', blind_high_right: 'idle', dive: 'idle', flip: 'idle' };
const fpsState = (entity, st) => (entity?.fps || entity?.bot ? FPS_RETIRED[st] : null) || st;
const VALID_COVER_KINDS = new Set(['low', 'medium', 'high', 'railing', 'platform-edge',
  'vehicle', 'shelter', 'truck', 'bus']);
const VISUAL_AIM_MAX = 52 * Math.PI / 180;
const ACTION_EVENTS = new Set(['swapStart', 'swapEnd', 'reloadStart', 'reloadEnd', 'reloadCancel', 'throwStart', 'throwRelease', 'throwCancel']);
// estados del contrato §1 (también para bots alojados: los retirados se traducen)
const CONTRACT_STATES = new Set(['idle', 'run', 'roadie', 'dodge', 'jump', 'crouch', 'slide', 'mantle', 'melee']);
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
  // pruebas (matriz honesta): rechazos del servidor por motivo
  if (process.env.NODE_ENV === 'test' && ['/test/refusals', '/test/refusals/detail'].includes(urlPath)) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(urlPath.endsWith('/detail') ? { counts: REFUSALS, samples: refusalSamples } : REFUSALS)); return;
  }
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
 // Cada subpaso del proyectil comprueba el tramo completo contra el sólido.
 blocked:(a,b)=>protoBlocked(a,b),
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
const protoBlocked = (a, b) => mapPathBlocked(settings.map, [a.x, a.y, a.z], [b.x, b.y, b.z]);
// rechazos de humanos por motivo (GET /test/refusals con NODE_ENV=test)
const REFUSALS = {};
// Una muestra por motivo basta para explicar el último incremento del contador.
const refusalSamples = process.env.NODE_ENV === 'test' ? {} : null;
let refusalInput;

// BREACH_REFUSAL_LOG=<archivo> (pruebas): el detalle de cada rechazo, una línea JSON
const REFUSAL_LOG = process.env.NODE_ENV === 'test' ? process.env.BREACH_REFUSAL_LOG : null;
function refused(reason, detail = null) {
  REFUSALS[reason] = (REFUSALS[reason] || 0) + 1;
  if (refusalSamples) refusalSamples[reason] = { count: REFUSALS[reason], ...refusalInput, detail };
  if (REFUSAL_LOG) { try { fs.appendFileSync(REFUSAL_LOG, JSON.stringify({ t: +monoSec().toFixed(3), reason, ...(detail || {}) }) + '\n'); } catch { /* sin registro */ } }
  return false;
}
// Rechazo de un lanzamiento (R8): identifica el lanzamiento pendiente por
// actor (el humano o su bot), vida e id, con el motivo real (la PRIMERA regla
// que falló), UNA sola vez por cid.
function launchReject(ws, actor, { cid, kind, reason, life }, type = 'nadeReject') {
  if (!actor) return;
  if (cid) { const seen = (actor.rejectedCids ||= new Set()); if (seen.has(cid)) return; seen.add(cid); if (seen.size > 64) seen.delete(seen.values().next().value); }
  if (!actor.bot) refused(`launch-${reason || 'origin'}`);
  const current = actor.life || 0;
  const launchLife = !actor.bot && Number.isSafeInteger(life) && life >= 0 && life <= current ? life : current;
  send(ws, { t: type, cid, kind, id: actor.id, life: launchLife, reason: reason || 'origin' });
}
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
    sp: entity.sp || 0, w: entity.w, ...(entity.ceKnown ? { ce: entity.ce } : {}),
    // reloj de simulación del cliente de la última muestra (mezcla por `ct`)
    ...(Number.isFinite(entity.ct) ? { ct: entity.ct } : {}) };
}
// historial: lo difundido en cada snapshot. Se guarda más que la ventana de
// posición (0.75 s) para reconstruir la entrada de dive/mantle/flip.
const POSE_RETAIN = 1.6;
function resetPoseHistory(entity, now = monoSec()) {
  entity.poseHistory = [poseSnapshot(entity, now)];
  // estados PROPIOS recibidos (origen del disparo FPS) y su guarda de postura
  entity.selfPoses = [];
  resetPostureGuard(entity, nowSec());
}
// Postura aceptada (guards.js acceptPosture) sobre el estado ya validado.
// `crouch` siempre lleva `ce` (sin él: agachado del todo) para que el
// historial y los observadores tengan la altura de cabeza.
function applyPosture(entity, rawCl, now, ct) {
  const want = { st: entity.st, ce: entity.ceKnown ? entity.ce : undefined, cl: clamp(rawCl, -1, 1) };
  const ps = acceptPosture(entity, { st: entity.st, aim: !!entity.aim, ce: want.ce, cl: want.cl }, now, ct);
  // recorte de la guarda de postura de un cliente FPS: descarte parcial, contado
  if (entity.fps && !entity.bot && (ps.st !== want.st ||
      (want.st === 'crouch' && Math.abs(ps.ce - (want.ce ?? 0)) > 1e-9) ||
      Math.abs(ps.cl - want.cl) > 1e-9)) refused('posture-clip', { want, got: ps });
  entity.st = ps.st; entity.cl = ps.cl;
  if (Number.isFinite(ps.ce)) { entity.ce = ps.ce; entity.ceKnown = entity.ceKnown || ps.st === 'crouch' || POSTURE_UPRIGHT.has(ps.st); }
}
// Estado propio tal como llegó (reloj monótono de recepción): de aquí sale la
// cabeza del tirador para validar el origen de un cliente FPS.
function recordSelfPose(entity, now = monoSec()) {
  recordOwnPose(entity.selfPoses ||= [], poseSnapshot(entity, now));
}
// Proyectiles de un cliente FPS (cohete, humo, frag, aturdidora): mismo
// estado y retraso que el disparo, ligados a la muestra `fs` del subpaso del
// lanzamiento (aceptada ANTES por quien llama). La salida esperada se rehace
// desde esa muestra: ojo + LAUNCH_OFFSET en el marco de la cámara (yaw + ae,
// pitch) — la de fpCam.launchPoint —, acortada por la geometría; se admite a
// ≤ LAUNCH_TOL de ese tramo, con ojo→salida y cabeza→ojo libres (antes: hasta
// 0.78 m del ojo en cualquier dirección). Cohete: además `d` dentro del cono
// del peor caso de spreadFor + 2° alrededor del eje de mirada.
const LAUNCH_TOL = 0.06;
function segDist3(p, a, b) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const k = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1] + (p[2] - a[2]) * u[2]) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - u[0] * k, p[1] - a[1] - u[1] * k, p[2] - a[2] - u[2] * k);
}
function fpsLaunchLegal(shooter, o, ts, weapon, dir = null) {
  if (!dodgeFireReady(shooter, weapon) || !canFireInState(shooter.st, weapon) || !sprintFireOk(shooter.lastRoadieAt, nowSec(), weapon)) { shooter.lastRejectReason = 'state'; return false; }
  const samples = shooter.selfPoses?.length ? shooter.selfPoses : [poseSnapshot(shooter, monoSec())];
  const cur = samples[samples.length - 1], pose = shotPose(samples, ts);
  const { eye, launch: L, fwd } = launchWorld(pose, cur.x, cur.y, cur.z, cur.yaw);
  const ax = { fwd };
  const w = placeHitPose(hitPose(pose), cur.x, cur.y, cur.z, cur.yaw), head = [w.hx, w.hy, w.hz];
  const clear = (a, b) => !mapPathBlocked(settings.map, a, b);
  if (segDist3(o, eye, L) > LAUNCH_TOL || !clear(head, eye) || !clear(eye, o)) { shooter.lastRejectReason = 'origin'; return false; }
  if (dir) {
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const cos = (dir[0] * ax.fwd[0] + dir[1] * ax.fwd[1] + dir[2] * ax.fwd[2]) / len;
    // convergencia hacia la cruz (rocketAimDir, compartida) + dispersión + 2°
    const cone = rocketConvergeMaxDeg(L, eye, fwd) +
      spreadFor(weapon, { aim: !!cur.aim, moving: 1, sliding: cur.st === 'slide', airborne: cur.st === 'jump' || !!shooter.air, sinceSprint: 0 }) + 2;
    if (cos < Math.cos(cone * Math.PI / 180)) { shooter.lastRejectReason = 'origin'; return false; }
  }
  return true;
}
// muestra de un proyectil humano FPS: obligatoria y ANTES de cadencia y arma
function acceptLaunchSample(shooter, msg, kind) {
  const r = takeSample(shooter, msg, kind);
  if (!r.ok) shooter.lastRejectReason = r.reason === 'sample-weapon' ? 'wrong-weapon' : r.reason === 'sample-state' ? 'state' : 'sample';
  return r;
}
// Origen de un cliente FPS (DECISIONES §4): el tiro va ligado a UNA muestra
// propia aceptada (la `fs` del disparo, ya pasada por las guardas de
// movimiento y postura); de ella sale SU ojo con eyeWorld (y su mezcla de
// estado, hit-pose.js shotPose). El origen debe estar a ≤ FPS_EYE_TOL de ese
// ojo (solo cuantización) y el tramo centro de cabeza → origen, con sus dos
// extremos, libre de geometría: ni rodear una esquina con el casco oculto ni
// sacar el ojo a través de una pared.
function fpsOriginLegal(shooter, o, ts) {
  const samples = shooter.selfPoses?.length ? shooter.selfPoses : [poseSnapshot(shooter, monoSec())];
  const cur = samples[samples.length - 1];
  const pose = shotPose(samples, ts);
  const eye = eyeWorld(pose, cur.x, cur.y, cur.z, cur.yaw);
  if (distance3(o, eye) > FPS_EYE_TOL) return false;
  const w = placeHitPose(hitPose(pose), cur.x, cur.y, cur.z, cur.yaw), head = [w.hx, w.hy, w.hz];
  return !mapPathBlocked(settings.map, head, o);
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
// 1.2 m en planta, entre 0.3 y 2.1 m sobre los pies, y con el
// tramo pecho→origen libre de geometría del mapa (no se dispara a través de
// una cobertura).
function botOriginLegal(bot, o) {
  const mt = monoSec();
  return (bot.poseHistory || []).some(p => p.at >= mt - BOT_ORIGIN_LAG && p.at <= mt &&
    botPoseAllowsOrigin(settings.map, p, o));
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
    host: p.id === hostId ? 1 : 0, life: p.life || 0, alive: !!p.alive, hp: Math.round(p.hp ?? HP),
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
// Solo presentación. Se fija el origen una vez, entre posiciones aceptadas.
function noteDodgeVisual(actor, msg, next) {
  if (next.st === 'dodge') actor.visualUntil = msg.ct + TUNING.dodge.duration + TUNING.net.interpDelay * 2;
  actor.visualCt = Number.isFinite(msg.ct) && msg.ct <= actor.visualUntil ? msg.ct : undefined;
  if (next.st !== 'dodge') { actor.dodgeVisual = null; return; }
  if (actor.dodgeVisual) return;
  const bounded = Number.isFinite(msg.ox) && Number.isFinite(msg.oz) &&
    Math.hypot(msg.ox - next.x, msg.oz - next.z) <= dodgeDistance(msg.dg) + 0.02 &&
    Math.hypot(msg.ox - actor.x, msg.oz - actor.z) <= TUNING.fp.sprintSpeed / TUNING.net.sendHz + 0.04;
  actor.dodgeVisual = { ox: bounded ? msg.ox : actor.x, oz: bounded ? msg.oz : actor.z,
    da: Number.isFinite(msg.da) ? wrapAngle(msg.da) : Math.atan2(next.z - actor.z, next.x - actor.x) };
}
function freshCombatState(p, spawn) {
  Object.assign(p, { x: spawn.x, z: spawn.z, y: 0, yaw: spawn.yaw, st: 'idle', aim: 0,
    p: 0, ae: 0, cl: 0, ce: 1, ck: null, w: 'smg', sp: 0, hp: HP, alive: true,
    specialWep: null, wGrant: null, wSeen: 'smg', wInstant: false, lastActionWeapon: null,
    lastRoadieAt: -Infinity, ct: undefined, cCt: undefined, visualCt: undefined, visualUntil: -Infinity, dodgeVisual: null, sa: undefined,
    weaponSlots: ['smg', 'shotgun', 'pistol', 'grenade'],
    ammoBudget: createAmmoBudget(), fireWeapon: null, // vida nueva: sin arma previa
    nades: p.bot ? 1 : WD.grenade.mag,
    lastNadeAt: -Infinity, lastRocketAt: -Infinity,
    lastDamage: 0, respawnAt: 0, prot: startAt + SPAWN_PROT,
    lastFireAt: -Infinity, pendingShot: null, life: (p.life || 0) + 1 });
  if (p.bot) p.cclk = undefined; // el host reinicia simTime al reaparecer el bot
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
  if (shooter) shooter.lastRejectReason = 'state';
  if (!shooter) return false;
  if (dazed(shooter)) { shooter.lastRejectReason = 'dazed'; return false; }
  if (prototypes.stunned(shooter.id)) { shooter.lastRejectReason = 'stunned'; return false; }
  if (!shooter.alive || phase !== 'playing') { shooter.lastRejectReason = shooter.alive ? 'phase' : 'dead'; return false; }
  if (shooter.weaponSlots?.[3] === 'frag') { shooter.lastRejectReason = 'wrong-weapon'; return false; }
  if (shooter.nades <= 0) { shooter.lastRejectReason = 'ammo'; return false; }
  const o = vec3(msg.o), v = vec3(msg.v); if (!o || !v) { shooter.lastRejectReason = 'origin'; return false; }
  const now = nowSec();
  // orden fijo: muestra/arma → estado → origen → cadencia (ganchos/red.md)
  const human = !shooter.bot && shooter.fps, smp = human ? acceptLaunchSample(shooter, msg, 'grenade') : { ok: true };
  if (!smp.ok) return false;
  if (!dodgeFireReady(shooter, 'grenade')) { shooter.lastRejectReason = 'dodge'; return false; }
  if (shooter.w !== 'grenade') { shooter.lastRejectReason = 'wrong-weapon'; return false; }
  const horizontalOrigin = Math.hypot(o[0] - shooter.x, o[2] - shooter.z);
  const verticalOrigin = Math.abs(o[1] - ((shooter.y || 0) + 1.1));
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (horizontalOrigin > 2.5 || verticalOrigin > 3 || speed < 0.5 || speed > 18) { shooter.lastRejectReason = 'origin'; return false; }
  // humo de bot alojado: barrido desde su ojo, como el cohete (R6)
  if (shooter.bot && !botOriginLegal(shooter, o)) { shooter.lastRejectReason = 'origin'; return false; }
  if (human && !fpsLaunchLegal(shooter, o, smp.ts, 'grenade')) return false;
  shooter.lastRejectReason = 'cadence';
  if (now - shooter.lastNadeAt < NADE_RELAY_INTERVAL) return false;
  if (!projectileCadenceAllows(shooter, 'grenade', now)) return false;
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
  return fireCadenceAllows(shooter, weapon, projectileInterval(weapon), cadenceNow(shooter, now), projectileMeta(shooter));
}
function commitProjectileCadence(shooter, weapon, now) {
  commitFireCadence(shooter, weapon, projectileInterval(weapon), cadenceNow(shooter, now), projectileMeta(shooter));
}
const cadenceNow = (me, now) => (me?.fps && !me.bot && Number.isFinite(me.cclk) ? me.cclk : now);

function relayRocket(sourceWs, shooter, msg) {
  if (shooter) shooter.lastRejectReason = 'state';
  if(prototypes.stunned(shooter?.id)||dazed(shooter))return false;
  if (!shooter?.alive || phase !== 'playing') return false;
  // sin la bazuca (en mano o poseída): el arma, primera regla
  if (shooter.specialWep !== 'bazooka' || (!shooter.bot && shooter.fps && shooter.w !== 'bazooka')) { shooter.lastRejectReason = 'wrong-weapon'; return false; }
  const o = vec3(msg.o), d = vec3(msg.d); if (!o || !d) { shooter.lastRejectReason = 'origin'; return false; }
  const now = nowSec();
  // orden fijo (ganchos/red.md "Ronda 2 — orden de validación"): muestra/arma
  // → estado → origen → cadencia → munición; el motivo es la PRIMERA que falla
  const human = !shooter.bot && shooter.fps, smp = human ? acceptLaunchSample(shooter, msg, 'bazooka') : { ok: true };
  if (!smp.ok || !dodgeFireReady(shooter, 'bazooka')) return false;
  const horizontalOrigin = Math.hypot(o[0] - shooter.x, o[2] - shooter.z);
  const verticalOrigin = Math.abs(o[1] - ((shooter.y || 0) + 1.1));
  const len = Math.hypot(d[0], d[1], d[2]);
  shooter.lastRejectReason = 'origin';
  if (horizontalOrigin > 2.2 || verticalOrigin > 2.2 || len < 0.5 || len > 1.5) return false;
  if (shooter.bot && !botOriginLegal(shooter, o)) return false;
  if (human && !fpsLaunchLegal(shooter, o, smp.ts, 'bazooka', d)) return false;
  shooter.lastRejectReason = 'cadence';
  if (now - shooter.lastRocketAt < ROCKET_RELAY_INTERVAL) return false;
  if (!projectileCadenceAllows(shooter, 'bazooka', now)) return false;
  shooter.lastRejectReason = 'ammo';
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
    ? fpsState(shooter, raw.st) : (shooter.st || 'idle');
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

// Semiángulo máximo (grados) de un perdigón alrededor del eje central:
// spreadFor del peor caso compatible con el estado de la muestra + 2°.
function worstSpread(shooter, weapon, now) {
  const st = shooter.st, moving = Math.min(1, (shooter.sp || 0) * TUNING.move.roadieSpeed / TUNING.fp.runSpeed + 0.2);
  const sinceSprint = Number.isFinite(shooter.lastRoadieAt) ? Math.max(0, now - shooter.lastRoadieAt - 0.1) : Infinity;
  // en el aire también si la muestra lo dice aunque st siga `crouch` (R3)
  return spreadFor(weapon, { aim: shooter.sa !== undefined ? !!shooter.sa : !!shooter.aim, moving, crouched: false, sliding: st === 'slide',
    airborne: st === 'jump' || !!shooter.air, sinceSprint });
}
function shotgunCone(shooter, now) { return worstSpread(shooter, 'shotgun', now) + 2; }
function bulletDirOk(shooter, o, pt, weapon, now) {
  const yaw = (shooter.yaw || 0) + (shooter.ae || 0), p = shooter.p || 0;
  const ax = [-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p)];
  const d = [pt[0] - o[0], pt[1] - o[1], pt[2] - o[2]], l = Math.hypot(d[0], d[1], d[2]);
  if (l < 0.01) return true;
  const cone = (worstSpread(shooter, weapon, now) + 2) * Math.PI / 180;
  return (d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) / l >= Math.cos(cone);
}
// La muestra aceptada entra en el historial que rebobinan los rivales con su
// pose EVALUADA (`vol`: la mezcla exacta que autorizó el ojo, R5).
function insertShotSample(shooter, ts) {
  const h = shooter.poseHistory ||= [];
  const s = poseSnapshot(shooter, monoSec());
  const samples = shooter.selfPoses?.length ? shooter.selfPoses : [s];
  s.vol = hitPose(shotPose(samples, ts));
  if (!h.length || h[h.length - 1].at <= s.at) h.push(s);
}
// Muestra `fs` OBLIGATORIA de un cliente FPS (R2): objeto, `n` entero
// posterior al último, `w` = el arma ya equipada según el estado previo (R14;
// en melee, la que lleva en mano) y, si se da, el arma del mensaje.
function takeSample(shooter, msg, expectWeapon) {
  const fs = msg.fs && typeof msg.fs === 'object' && !Array.isArray(msg.fs) ? msg.fs : null;
  const no = (reason, detail) => ({ ok: refused(reason, detail), reason });
  // orden (red.md): arma del mensaje → muestra presente → n → arma de la muestra → guardas
  if (expectWeapon && expectWeapon !== shooter.w) return no('sample-weapon');
  if (!fs) return no('sample-missing');
  if (!Number.isInteger(fs.n) || (Number.isFinite(shooter.lastN) && fs.n <= shooter.lastN)) {
    return no('sample-seq', { n: fs.n, lastN: shooter.lastN, st: fs.st, lastSt: shooter.st });
  }
  if (fs.w !== shooter.w) return no('sample-weapon');
  if (!acceptOwnState(shooter, fs, true)) return no('sample-state');
  return { ok: true, ts: Number.isFinite(fs.ts) ? fs.ts : undefined };
}
function registerFire(shooter, msg, isBotFire = false) {
  const reject = reason => !isBotFire && shooter?.fps ? refused(reason) : false;
  if (prototypes.stunned(shooter?.id) || dazed(shooter)) return reject('fire-dazed');
  if (!shooter?.alive || phase !== 'playing') return reject('fire-inactive');
  const o = vec3(msg.o), pt = vec3(msg.p); if (!o || !pt) return reject('fire-point');
  // C6: un cliente FPS debe nombrar un arma válida (antes caía a SMG)
  if (!isBotFire && shooter?.fps && !FIREABLE.has(msg.w)) return refused('fire-weapon');
  const weapon = FIREABLE.has(msg.w) ? msg.w : 'smg', rule = FIRE_RULES[weapon], now = nowSec();
  // La bazooka nace exclusivamente mediante `rocket`; aceptar un `fire` en
  // el punto de explosión devolvería al cliente autoridad sobre la trayectoria.
  if (weapon === 'bazooka') return reject('fire-weapon');
  // Cliente FPS: PRIMERO la muestra del subpaso (`fs`, con su `n` y su arma
  // `w`) como estado propio; arma, cadencia, puertas y origen se validan
  // sobre ESE estado, y no se vuelve a aplicar después (auditoría (a)).
  const fpsShooter = !isBotFire && !!shooter.fps;
  if (fpsShooter) {
    const smp = takeSample(shooter, msg, FIREABLE.has(msg.w) && msg.w !== 'melee' ? msg.w : null);
    if (!smp.ok) return false;
    msg._ts = smp.ts;
  }
  // el melee no depende del arma en mano; el resto debe coincidir con ella.
  // Cadencia (guards.js): horario virtual por arma, apertura ≥82 %, crédito
  // solo por jitter/atasco de transporte, gesto de cambio entre armas y `sq`
  // creciente (clientes nuevos) contra duplicados.
  const cadenceMeta = { sq: Number.isFinite(msg.sq) ? msg.sq : undefined,
    wAt: shooter.wAt, wSeq: shooter.wSeq, wWeapon: shooter.wSeen, wInstant: !!shooter.wInstant, requireSwapEvidence: true };
  // El host puede enviar varios subpasos juntos. Solo el horario del arma
  // usa el instante simulado; las ventanas de ráfaga siguen midiendo llegadas.
  if (isBotFire && (Number.isFinite(msg.ct) || Number.isFinite(shooter.cclk))) {
    advanceCadenceClock(shooter, msg.ct, now);
    cadenceMeta.scheduleNow = shooter.cclk;
  }
  if (!dodgeFireReady(shooter, weapon)) return reject('fire-state');
  if (weapon !== 'melee' && weapon !== shooter.w) return fpsShooter ? refused('fire-weapon') : false;
  const melee = weapon === 'melee';
  // la embestida recorre hasta 3 m en 0,2 s: la posición conocida va por
  // detrás (bots). El cliente FPS manda su muestra: ni ese margen ni los 5 m.
  const originTolerance = melee ? 0.9 + TUNING.melee.tackleMax : (isBotFire ? 6 : 5);
  if (Math.hypot(o[0] - shooter.x, o[2] - shooter.z) > originTolerance ||
      Math.abs(o[1] - ((shooter.y || 0) + 1.1)) > (melee ? 1.1 : 4)) return reject('fire-origin');
  if (isBotFire && !melee && !botOriginLegal(shooter, o)) return false;
  // cliente FPS: el tiro (y el golpe) salen del ojo de SU muestra
  // (DECISIONES §4), en un estado que permite disparar y pasado el retraso
  // sprint→disparo del arma (fire-gates.js: la misma tabla que el cliente)
  if (fpsShooter) {
    if (!melee && (!canFireInState(shooter.st, weapon) || !sprintFireOk(shooter.lastRoadieAt, now, weapon))) return refused('fire-state');
    if (!fpsOriginLegal(shooter, o, msg._ts)) {
      const sm = shooter.selfPoses || [], cur = sm[sm.length - 1], pose = sm.length ? shotPose(sm, msg._ts) : null;
      const e = pose ? eyeWorld(pose, cur.x, cur.y, cur.z, cur.yaw) : null;
      return refused('fire-origin', { o, eye: e?.map((v) => +v.toFixed(3)), d: e ? +distance3(o, e).toFixed(3) : null, st: cur?.st, ce: cur?.ce, cl: cur?.cl,
        from: pose?.from?.st ?? null, since: pose?.since, fs: msg.fs, last3: sm.slice(-3).map((q) => ({ at: +q.at.toFixed(3), ct: q.ct, st: q.st, ce: q.ce, n: q.n })) });
    }
    // una bala (R4): `p` es la dirección EFECTIVA de la bala, dentro del cono
    // de dispersión del peor caso de la muestra + 2° alrededor de su eje
    if (!melee && weapon !== 'shotgun' && !bulletDirOk(shooter, o, pt, weapon, now)) return refused('fire-direction');
  }
  // cadencia DESPUÉS de muestra, estado y origen (orden documentado en red.md)
  if (fpsShooter && !srvBurstAllows(shooter, weapon, rule.interval, now)) return refused('fire-burst', { w: weapon });
  if (!fireCadenceAllows(shooter, weapon, rule.interval, cadenceNow(shooter, now), cadenceMeta)) {
    return fpsShooter ? refused('fire-cadence', { why: shooter.lastRejectReason ?? shooter.cadenceWhy, cclk: shooter.cclk, now: +now.toFixed(3), ct: shooter.ct, bank: shooter.cBank, chain: shooter.fireChain?.[weapon], times: shooter.fireTimes?.[weapon]?.slice(-4), w: weapon }) : false;
  }
  // Rango y falloff se miden desde el PLANO del tirador (pecho a 1.3 m),
  // igual que el cliente: en ADS el origen óptico es la cámara, ~2.2 m por
  // detrás, y medir desde ella descartaba disparos válidos y restaba daño.
  // El descuento solo existe si el PROPIO estado del tirador (aim y pitch de
  // sus snapshots recientes, no el bit del disparo) estaba en ADS y el origen
  // cae en el sobre de su cámara; hip/blindfire (cañón): base 0.
  // Cliente FPS: el origen es su ojo, sin cámara retrasada que descontar.
  const planeVec = melee || fpsShooter ? null : aimedSetback(shooter, o);
  if (shooterPlaneDistance(o, pt, planeVec) > rule.range + (melee ? 0.22 : 2)) return reject('fire-range');
  if (melee) {
    // cliente FPS: el yaw de MIRADA (C3: el cliente elige por la mirada; filtrar
    // antes por la orientación del cuerpo daba marcador sin daño)
    const ay = (shooter.yaw || 0) + (fpsShooter ? shooter.ae || 0 : 0);
    if (!meleeReachOk(o, ay, pt, Infinity)) return reject('melee-direction');
  }
  if (!consumeShotAmmo(shooter, weapon)) return reject('fire-ammo');
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
  commitFireCadence(shooter, weapon, rule.interval, cadenceNow(shooter, now), cadenceMeta);
  if (fpsShooter) commitSrvBurst(shooter, weapon, now);
  shooter.pendingShot = {
    sq: cadenceMeta.sq, meleeYaw: (shooter.yaw || 0) + (fpsShooter ? shooter.ae || 0 : 0),
    at: now, mt: monoSec(), wep: weapon, origin: o, endpoint, direction: shotDir,
    length: shotLen, remainingDamage: rule.maxDamage, hitIds: new Set(), planeVec,
    // escopeta FPS: `p` es el EJE CENTRAL del cartucho; cada perdigón
    // reclamado cabe en el cono del peor caso de spreadFor para el estado de
    // la muestra + 2° (antes 20° alrededor del ÚLTIMO perdigón)
    ...(fpsShooter && weapon === 'shotgun' ? { coneDeg: shotgunCone(shooter, now) } : {}),
  };
  // la muestra aceptada entra en el historial que rebobinan los rivales: una
  // exposición entre dos snapshots que autorizó el tiro también es impactable
  if (fpsShooter) insertShotSample(shooter, msg._ts);
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
  const degrees = Number.isFinite(shot.coneDeg) ? shot.coneDeg : shot.wep === 'shotgun' ? 20 : shot.wep === 'melee' ? 18 : 9;
  return dot >= Math.cos(degrees * Math.PI / 180);
}

function commitAuthoritativeDamage(shooter, target, shot, msg, dist, authoritative,
  now, deferRoundCheck = false) {
  const dmg = Math.min(authoritative.dmg, shot.remainingDamage);
  if (dmg <= 0) return { applied: false, killed: false };
  const part = authoritative.part;
  shot.hitIds.add(target.id); shot.remainingDamage -= dmg;
  target.hp -= dmg; target.lastDamage = now;
  if (process.env.NODE_ENV === 'test') {
    send(shooter.ws, { t: 'testDamage', target: target.id, w: shot.wep, sq: shot.sq, dmg });
  }
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
  const reject = reason => shooter?.fps && !shooter.bot && refused(reason);
  const target = players.get(msg.target) || bots.get(msg.target);
  const shot = shooter?.pendingShot, rule = shot ? FIRE_RULES[shot.wep] : null, now = nowSec();
  if (!target || !target.alive || !shooter?.alive || phase !== 'playing' || target.prot > now) return reject('hit-inactive');
  const selfRocket = target.id === shooter.id && shot?.wep === 'bazooka';
  if (target.team === shooter.team && !selfRocket) return reject('hit-team');
  if (!shot || !rule || now - shot.at > HIT_WINDOW || shot.hitIds.has(target.id)) return reject('hit-pending');
  // claim de otro disparo (cliente nuevo con `sq`): nunca se adjunta al vigente
  if (Number.isFinite(msg.sq) && Number.isFinite(shot.sq) && msg.sq !== shot.sq) return reject('hit-seq');
  const point = vec3(msg.p); if (!point) return reject('hit-point');
  // modelo de impacto y latencia del tirador (bots: los del host que los simula)
  const viewer = shooter.bot ? players.get(hostId) : shooter;
  const pose = poseForClaim(target, point, shot, viewer?.hitModel !== 2, viewer?.rtt); if (!pose) return reject('hit-pose');
  // quemarropa: el cliente impactó con el origen DENTRO del rival (contacto de
  // longitud cero, sin dirección): vale solo si el punto está dentro del volumen
  const pointBlank = !shot.direction && shot.wep !== 'melee' && shot.wep !== 'bazooka';
  if ((pointBlank ? !pose.inside || distance3(point, shot.origin) > 0.05 : !claimMatchesShot(shot, point)) ||
      mapLineBlocked(settings.map, shot.origin, point, shot.wep === 'melee' ? 0.24 : 0.18)) return reject('hit-geometry');
  // misma definición que el rango del fire: distancia desde el plano del tirador
  const dist = shooterPlaneDistance(shot.origin, point, shot.planeVec);
  const hitTolerance = shot.wep === 'melee' ? 0.28 : 2;
  if (dist > (rule.hitRange ?? rule.range) + hitTolerance) return reject('hit-range');
  if (shot.wep === 'melee') {
    // cliente FPS: la MISMA regla que el cliente (melee-reach.js), desde el ojo
    if (shooter.fps && !shooter.bot) {
      // el mismo criterio que el cliente (melee-reach.js meleeHitOk): centro del
      // blanco en 58° del yaw de MIRADA, contacto a su alcance desde el ojo
      const centre = [pose.x, (pose.y || 0) + 0.9, pose.z];
      if (!meleeHitOk(shot.origin, shot.meleeYaw, point, centre, MELEE_REACH + MELEE_NET_TOL)) return void refused('melee-reach');
    } else {
      const dx = pose.x - shooter.x, dz = pose.z - shooter.z, len = Math.hypot(dx, dz);
      const fx = -Math.sin(shooter.yaw || 0), fz = -Math.cos(shooter.yaw || 0);
      if (len > 0.001 && (dx * fx + dz * fz) / len < Math.cos(58 * Math.PI / 180)) return reject('hit-melee-direction');
    }
  }
  const authoritative = authoritativeDamage(shooter, target, shot, msg, dist, pose);
  if (!commitAuthoritativeDamage(shooter, target, shot, msg, dist, authoritative, now).applied) return reject('hit-damage');
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

function dodgeBodyPush(actor, next) {
  // Vecinos capaces de empujar en este tramo, incluida la interpolación
  // remota. Cada solape corrige como máximo 3 m/s en el controlador.
  return 3 * allSlots().filter(other => other !== actor && other.alive &&
    Math.abs(other.y - next.y) <= 1.7 &&
    Math.hypot(other.x - next.x, other.z - next.z) < 3.2).length;
}

// Estado propio de un jugador (mensaje `s`, o la muestra `fs` que viaja con
// cada disparo FPS): guardas de movimiento y postura, arma replicada y
// registro de la muestra aceptada. Devuelve true si se aceptó.
// sample: la muestra `fs` de un disparo/lanzamiento (no trae munición ni
// eventos; su arma `w` es la del subpaso y se valida con las mismas reglas).
// `n` (secuencia común con los estados `s`): una muestra o estado que no sea
// posterior al último aceptado se descarta (nunca se rebobina el estado vivo).
function acceptOwnState(me, msg, sample = false) {
  const ws = me.ws;
  // Una ola puede llegar mientras aún viaja la postura del cadáver. Nunca
  // confrontar sus coordenadas con el spawn ni corregir al jugador nuevo.
  const currentLife = me.life ?? 0;
  if (msg.life !== undefined && msg.life !== currentLife) {
    if (!sample && process.env.NODE_ENV === 'test') {
      send(ws, { t: 'testStateDiscard', reason: 'state-life', n: msg.n, life: msg.life, current: currentLife, sample: msg });
    }
    return refused('state-life');
  }
  if (Number.isFinite(msg.n)) {
    // descarte silencioso, también contado (matriz honesta: "cero" debe ver todo)
    if (Number.isFinite(me.lastN) && msg.n <= me.lastN) return refused('state-stale', { n: msg.n, lastN: me.lastN });
  }
  if(prototypes.stunned(me.id)){
    me.aim=0;me.sp=0;
    send(ws,{t:'correction',x:me.x,y:me.y||0,z:me.z,reason:'stun'});return false;
  }
  if (phase !== 'playing' || !me.alive) {
    me.st = 'idle'; me.aim = 0; me.ae = 0; me.cl = 0; me.ce = 1; me.ck = null;
    me.sp = 0; me.rl = null; return false;
  }
  if (![msg.x, msg.y, msg.z, msg.yaw].every(Number.isFinite)) return refused('state-position');
  const st = fpsState(me, VALID_STATES.has(str(msg.st)) && msg.st !== 'dead' ? msg.st : 'idle');
  const stateNow = nowSec();
  // C7: reloj de simulación acotado ANTES de las guardas (las ventanas de
  // slide/placaje y el ritmo de postura van en él)
  advanceCadenceClock(me, Number.isFinite(msg.ct) ? msg.ct : undefined, stateNow);
  const next = { x: clamp(msg.x, -60, 60), z: clamp(msg.z, -60, 60), y: clamp(msg.y, 0, 20), st, dg: msg.dg, air: msg.air, aim: msg.aim, ...(Number.isFinite(msg.ct) ? { ct: msg.ct } : {}) };
  if (st === 'dodge' || me.motionGuard?.inDodge) {
    if (dazed(me) && !me.motionGuard?.inDodge) return refused('movement');
    next.bodyPushRate = dodgeBodyPush(me, next);
  }
  if (!acceptMovement(me, next, stateNow, ALLOW_TEST_TELEPORTS)) {
    send(ws, { t: 'correction', x: me.x, y: me.y || 0, z: me.z, reason: 'movement' });
    return refused('movement', { st, x: next.x, z: next.z });
  }
  if (Number.isFinite(msg.n)) me.lastN = msg.n;
  // yaw módulo 2π (el cliente lo acumula al girar; saturarlo en ±10 rad
  // desalineaba la cabeza del servidor con el ojo del cliente)
  noteDodgeVisual(me, msg, next);
  me.x = next.x; me.z = next.z; me.y = next.y; me.yaw = wrapAngle(clamp(msg.yaw, -1e4, 1e4));
  me.st = st;
  if (st === 'dodge') me.dg = msg.dg;
  if (st === 'roadie') me.lastRoadieAt = stateNow; // retraso sprint→disparo
  me.aim = msg.aim ? 1 : 0; me.p = clamp(msg.p, -1.6, 1.6);
  me.ae = clamp(msg.ae, -VISUAL_AIM_MAX, VISUAL_AIM_MAX);
  me.ce = Number.isFinite(msg.ce) ? clamp(msg.ce, 0, 1) : 1;
  me.ceKnown = Number.isFinite(msg.ce);
  // postura FPS con ritmo acotado (guards.js): agachado/asomo/inclinación
  applyPosture(me, msg.cl, stateNow, Number.isFinite(msg.ct) ? msg.ct : undefined);
  me.ct = Number.isFinite(msg.ct) ? msg.ct : undefined;
  me.ck = VALID_COVER_KINDS.has(str(msg.ck)) ? msg.ck : null;
  me.sp = clamp(msg.sp, 0, 1); // velocidad (también en la muestra del disparo: adelanto de cabeza al trotar)
  me.air = msg.air ? 1 : 0;    // en el aire (salto desde agachado: st sigue crouch)
  // C2: `aim` de la dispersión de la muestra (sniper subiendo la mira = cadera)
  me.sa = sample && (msg.sa === 0 || msg.sa === 1) ? msg.sa : undefined;
  // la muestra de un disparo NO cambia el arma (R14: debe estar ya equipada)
  if (msg.w !== undefined && !sample) {
    const requestedWep = clampWep(msg.w);
    const stateWep = (['frag','stun'].includes(requestedWep)&&!me.weaponSlots.includes(requestedWep)) || SPECIAL_WEAPONS.has(requestedWep) && me.specialWep !== requestedWep ? 'smg' : requestedWep;
    // Hasta que el cliente confirme el arma del pedestal, estados capturados
    // antes de la recogida (incluso de un cambio en curso) no la desequipan.
    if (me.wGrant && stateWep === me.wGrant) me.wGrant = null;
    if (!me.wGrant) me.w = stateWep;
    // instante en que el arma replicada cambió: evidencia del gesto de cambio
    if (me.w !== me.wSeen) { me.wSeen = me.w; me.wAt = cadenceNow(me, nowSec()); me.wSeq = me.msgSeq; me.wInstant = false; }
    if (!me.wGrant) {
      const def = WD[me.w] || WD.smg;
      me.am = clamp(msg.am, 0, def.mag || 0); me.ar = clamp(msg.ar, 0, def.reserve || 0);
      // progreso de recarga (opcional, solo presentación: la munición y el fin
      // de la recarga se deciden donde siempre). Ausente = no recarga.
      me.rl = Number.isFinite(msg.rl) ? clamp(msg.rl, 0, 1) : null;
    }
  }
  // eventos de acción (una vez): validados y adjuntados al próximo snapshot
  if (!sample && Array.isArray(msg.ev)) {
    for (const e of msg.ev.slice(0, 4)) {
      if (!Array.isArray(e) || !ACTION_EVENTS.has(str(e[0]))) continue;
      const w = str(e[1]);
      // El evento aceptado marca el intervalo comprometido de la granada.
      // Tras una suelta o cancelación deja de impedir una esquiva nueva.
      if (e[0] === 'throwStart' && WD[w]?.thrown && Number.isFinite(msg.ct)) {
        me.motionGuard.throwReleaseCt = msg.ct + WD[w].throwRelease;
      } else if (e[0] === 'throwRelease' || e[0] === 'throwCancel') {
        delete me.motionGuard.throwReleaseCt;
      }
      (me.evQueue ||= []).push([e[0], VALID_WEAPONS.has(w) ? w : '']);
    }
    if (me.evQueue?.length > 8) me.evQueue.splice(0, me.evQueue.length - 8);
  }
  recordSelfPose(me, monoSec()); // cabeza propia para el origen de sus disparos
  return true; // la pose difundida se registra al difundirla (snap)
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
      if (refusalSamples) refusalInput = { id: me?.id, bytes };
      refused('rate-limit'); ws.close(1008, 'rate limit'); return;
    }
    let msg; try { msg = JSON.parse(data); } catch { return; }
    // solo objetos con tipo de texto (null, números o listas no son mensajes)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
    if (refusalSamples) refusalInput = { id: me?.id, life: me?.life, message: msg };
    if (msg.t === 'join' && !me) {
      // Solo clientes FPS (DECISIONES §5): uno anterior no anuncia `fps` y se
      // le rechaza por la vía de siempre (lobbyError antes del welcome, que el
      // cliente muestra y tras la que cierra). Un cliente viejo no tiene texto
      // para un código nuevo y enseña la clave: por eso el código se lee solo.
      // y con el modelo de impacto por pose (hp 2): el modelo 1 leería
      // `crouch` como de pie al validar daño
      if (msg.fps !== 1 || msg.hp !== 2) { lobbyError(ws, 'reload-page', 'fps'); ws.close(1008, 'reload the page'); return; }
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
        hitModel: 2,
        // cliente FPS (único admitido): origen en el ojo y topes de movimiento FPS
        fps: true,
        lastFireAt: -Infinity, pendingShot: null };
      if (relieved) bots.delete(relieved.id);
      players.set(id, me); if (!hostId) { hostId = id; phase = 'lobby'; }
      if (!late) {
        syncLobbyBots();
        send(ws, { t: 'welcome', id, team: me.team, lobby: lobbyPayload(), hp: 2, fps: 1, life: me.life || 0 }); broadcastLobby();
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
      send(ws, { t: 'welcome', id, team: me.team, lobby: lobbyPayload(), hp: 2, fps: 1, life: me.life || 0 });
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
    if(msg.t==='protoClaim'){
      if (!prototypes.claim(me.id,str(msg.id),msg.manual===true)) refused('pickup-prototype');
      return;
    }
    if(msg.t==='protoFire'){
      // estados: la tabla compartida con el cliente (fire-gates.js); antes se
      // rechazaba frag/stun deslizando aunque el cliente lo permitía
      const kind=['frag','stun'].includes(msg.kind)?msg.kind:null;
      const pcid=typeof msg.cid==='string'&&/^[a-zA-Z0-9:_-]{1,40}$/.test(msg.cid)?msg.cid:null;
      const refuse=(reason)=>{launchReject(ws,me,{cid:pcid,kind,reason,life:msg.fs?.life});};
      if(!kind){refuse('wrong-weapon');return;}
      // orden fijo: muestra/arma → estado → origen → cadencia → munición
      const smp=me.fps?acceptLaunchSample(me,msg,kind):{ok:true};
      if(!smp.ok){refuse(me.lastRejectReason);return;}
      if(!me.weaponSlots?.includes(kind)||me.w!==kind){refuse('wrong-weapon');return;}
      const o=vec3(msg.o),d=vec3(msg.d),pnow=nowSec();
      if(!o||!d){refuse('origin');return;}
      if(me.fps?!fpsLaunchLegal(me,o,smp.ts,kind):['melee','dive','slide','mantle'].includes(me.st)){refuse(me.lastRejectReason||'origin');return;}
      if(!projectileCadenceAllows(me,kind,pnow)){refuse('cadence');return;}
      // solo un lanzamiento ACEPTADO por el motor consume horario
      if(prototypes.fire(me.id,kind,{x:o[0],y:o[1],z:o[2]},{x:d[0],y:d[1],z:d[2]},pcid))commitProjectileCadence(me,kind,pnow);else refuse('ammo');
      const s=prototypes.state(me.id);
      if(['frag','stun'].includes(msg.kind))send(ws,{t:'protoInventory',id:me.id,kind:msg.kind,count:msg.kind==='frag'?s.frag:s.stunAmmo});
      return;
    }
    if(prototypes.stunned(me.id)&&['takeDrop','takeSpecial','crate','takeCrate','reload'].includes(msg.t))return refused('action-stunned');
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
    if (msg.t === 's') { acceptOwnState(me, msg); return; }
    // Marca FIFO de la matriz: confirma a ambos clientes hasta dónde llegó
    // el servidor. No modifica la partida ni el resultado de ninguna acción.
    if (msg.t === 'testFence' && process.env.NODE_ENV === 'test' && Number.isSafeInteger(msg.seq)) {
      broadcastRaw({ t: 'testFence', id: me.id, seq: msg.seq }); return;
    }
    // pruebas con TODAS las guardas activas (sin ALLOW_TEST_TELEPORTS): colocar
    // al jugador explícitamente; reinicia guardas e historial como una aparición
    if (msg.t === 'testPlace' && process.env.NODE_ENV === 'test') {
      if (![msg.x, msg.z].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      me.x = clamp(msg.x, -60, 60); me.z = clamp(msg.z, -60, 60); me.y = clamp(msg.y, 0, 20); me.yaw = wrapAngle(clamp(msg.yaw, -1e4, 1e4));
      resetMovementGuard(me, nowSec()); resetPoseHistory(me); me.lastN = undefined; me.cclk = undefined;
      send(ws, { t: 'correction', x: me.x, y: me.y, z: me.z, reason: 'testPlace' }); return;
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
        next.st = fpsState(b, VALID_STATES.has(s.st) ? s.st : 'idle');
        next.dg = s.dg; next.ct = s.ct; next.aim = s.aim;
        if (next.st === 'dodge' || b.motionGuard?.inDodge) {
          if (dazed(b) && !b.motionGuard?.inDodge) continue;
          next.bodyPushRate = dodgeBodyPush(b, next);
        }
        if (!acceptMovement(b, next, stateNow, ALLOW_TEST_TELEPORTS)) continue;
        if (Number.isFinite(b.cclk)) advanceCadenceClock(b, s.ct, stateNow);
        noteDodgeVisual(b, s, next);
        b.x = next.x; b.z = next.z; b.y = next.y; b.yaw = wrapAngle(clamp(s.yaw, -1e4, 1e4));
        // solo estados del contrato: los retirados de bots se traducen (auditoría)
        b.st = fpsState(b, VALID_STATES.has(str(s.st)) && s.st !== 'dead' ? s.st : 'idle');
        if (!CONTRACT_STATES.has(b.st)) b.st = 'idle';
        if (b.st === 'dodge') b.dg = s.dg;
        b.aim = s.aim ? 1 : 0; b.p = clamp(s.p, -1.6, 1.6);
        b.ae = clamp(s.ae, -VISUAL_AIM_MAX, VISUAL_AIM_MAX);
        b.ce = Number.isFinite(s.ce) ? clamp(s.ce, 0, 1) : 1;
        b.ceKnown = Number.isFinite(s.ce);
        applyPosture(b, s.cl, stateNow);
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
        launchReject(ws, eventShooter(me, msg), { cid, kind: 'bazooka', life: msg.fs?.life, reason: me.lastRejectReason || eventShooter(me, msg)?.lastRejectReason || 'origin' }, 'rocketReject');
      }
      return;
    }
    if (msg.t === 'nade') {
      const actor = eventShooter(me, msg);
      if (!relayNade(ws, actor, msg)) {
        if (LOG_FIRE_REJECTS) console.log('[nade rechazado]', JSON.stringify({ id: actor?.id, life: actor?.life,
          st: actor?.st, phase, reason: actor?.lastRejectReason, message: msg }));
        const cid = typeof msg.cid === 'string' ? msg.cid.slice(0, 40) : null;
        // qué se rechazó: el cliente devuelve el bote (weapons.refundThrow)
        launchReject(ws, actor, { cid, kind: 'grenade', life: msg.fs?.life, reason: actor?.lastRejectReason || 'origin' });
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
        if (removed === me.w) {
          me.w = d.wep; me.wGrant = d.wep; me.wSeen = d.wep;
          me.wAt = cadenceNow(me, nowSec()); me.wSeq = me.msgSeq; me.wInstant = true;
          me.am = d.mag; me.ar = d.res; me.rl = null;
        }
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
      if (!claimant?.alive || phase !== 'playing' || special.taken || !special.wep) return refused('pickup-special');
      const spot = MAP_RUNTIME[settings.map]?.special;
      if (!spot || Math.hypot(claimant.x - spot.x, claimant.z - spot.z) > 2.2 ||
          Math.abs((claimant.y || 0) - (spot.y || 0)) > 1.5) return refused('pickup-special');
      special.taken = true; special.by = claimant.id; claimant.specialWep = special.wep;
      // recoger la especial la pone EN MANO al instante (sin gesto): cuenta como cambio
      // el servidor queda como tras un cambio real a esa arma: `w` incluido
      // El hueco se elige con el arma EN MANO antes de recoger (misma regla
      // compartida que el cliente: specialPickupSlot en drop-policy.js).
      claimant.weaponSlots ||= ['smg', 'shotgun', 'pistol', 'grenade'];
      const heldBefore = claimant.w;
      claimant.weaponSlots[specialPickupSlot(claimant.weaponSlots, heldBefore, special.wep)] = special.wep;
      claimant.w = special.wep; claimant.wSeen = special.wep; claimant.wAt = cadenceNow(claimant, nowSec()); claimant.wInstant = true;
      claimant.wSeq = me.msgSeq;
      claimant.wGrant = claimant.bot ? null : special.wep;
      claimant.am = WD[special.wep].mag; claimant.ar = WD[special.wep].reserve; claimant.rl = null;
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
    if(!String(p.st).includes('cover')&&p.st!=='crouch')p.st='idle';
  }
  if(players.size&&inMatch())broadcastRaw({t:'protoState',...prototypes.snapshot()});
  if (phase === 'playing') for (const p of allSlots()) {
    if (p.alive && p.hp < HP && now - p.lastDamage > REGEN_DELAY) p.hp = Math.min(HP, p.hp + REGEN_RATE / TICK_HZ);
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) {
      const spawn = pickSpawn(p.team);
      freshCombatState(p, spawn);
      p.prot = now + SPAWN_PROT;
      broadcastRaw({ t: 'respawn', id: p.id, spawn, life: p.life });
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
    ps: allSlots().map((p) => ({ id: p.id, life: p.life || 0, x: p.x ?? 0, z: p.z ?? 0, y: p.y || 0,
      yaw: p.yaw || 0, st: p.st || 'idle', aim: p.aim || 0, p: p.p || 0,
      ae: p.ae || 0, cl: p.cl || 0, ...(p.ceKnown ? { ce: p.ce } : {}),
      ...(p.ck ? { ck: p.ck } : {}), w: p.w || 'smg',
      ct: p.visualCt, ...(p.bot && p.w === 'grenade' ? {
        throwCt: p.motionGuard?.lastCt,
        throwReady: phase === 'playing' && p.alive && !dazed(p) && !prototypes.stunned(p.id) && dodgeFireReady(p, 'grenade'),
      } : {}),
      ...(p.st === 'dodge' ? { dg: p.dg, ...p.dodgeVisual } : {}),
      sp: p.sp || 0, ...(p.alive && p.rl != null ? { rl: +p.rl.toFixed(2) } : {}),
      ...(p.evQueue?.length ? { ev: p.evQueue.splice(0) } : {}), hp: Math.round(p.hp), alive: p.alive,
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

function wrapAngle(a) { a = num(a) % (Math.PI * 2); return a > Math.PI ? a - Math.PI * 2 : a <= -Math.PI ? a + Math.PI * 2 : a; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, num(v))); }
function vec3(v) { if (!Array.isArray(v) || v.length !== 3) return null; const out = v.map(num); return out.every((n) => Math.abs(n) < 1000) ? out : null; }

server.listen(PORT, () => console.log(`BREACH server en http://localhost:${PORT} (WebSocket en el mismo enlace)`));
