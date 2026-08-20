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

const PORT = process.env.PORT || 8787;
const HP = 100, REGEN_DELAY = 3.6, REGEN_RATE = 48, RESPAWN_TIME = 5;
const INTRO_TIME = Number(process.env.INTRO_TIME ?? 10);
const COUNTDOWN_TIME = Number(process.env.COUNTDOWN_TIME ?? 3);
const ROUND_FINISH_HOLD = Number(process.env.ROUND_FINISH_HOLD ?? DEFAULT_ROUND_FINISH_HOLD);
const INTERMISSION_TIME = Number(process.env.INTERMISSION_TIME ?? 5);
const FINAL_TIME = Number(process.env.FINAL_PRESENTATION_TIME ?? 11);
const SPAWN_PROT = 5, CRATE_RESPAWN = 30, DROP_LIFE = 8, TICK_HZ = 20;
const CRATES = [{ up: true, t: 0 }, { up: true, t: 0 }];
const FIRE_RULES = {
  smg: { interval: 60 / 620, range: 80, maxDamage: 16 },
  shotgun: { interval: 60 / 95, range: 24, maxDamage: 8 * 13, gibRange: 4.2 },
  pistol: { interval: 60 / 260, range: 60, maxDamage: 44 },
  sniper: { interval: 60 / 34, range: 130, maxDamage: 187 },
  // el splash puede alcanzar a varios: el presupuesto cubre 3 impactos y su
  // "rango" al validar hits es el radio de la explosión, no el del vuelo
  bazooka: { interval: 60 / 28, range: 110, maxDamage: 115 * 3, hitRange: 5 },
  // el golpe cuerpo a cuerpo viaja como "disparo" de rango mínimo
  melee: { interval: 0.55, range: 2.6, maxDamage: 60 },
};
// ids replicables en 'w' (la granada solo aparece EN MANO, nunca dispara aquí)
const VALID_WEAPONS = new Set(['smg', 'shotgun', 'pistol', 'grenade', 'sniper', 'bazooka']);
const SPECIAL_WEAPONS = new Set(['sniper', 'bazooka']);
const FIREABLE = new Set(Object.keys(FIRE_RULES));
const clampWep = (w) => (VALID_WEAPONS.has(w) ? w : 'smg');
// la granada no es un arma soltable: el drop degrada a smg
const clampDropWep = (w) => (VALID_WEAPONS.has(w) && w !== 'grenade' ? w : 'smg');
const HIT_WINDOW = .28;
const VALID_STATES = new Set(['idle', 'run', 'roadie', 'dive', 'slide', 'cover_low',
  'cover_high', 'blind_over', 'blind_low_left', 'blind_low_right',
  'blind_high_left', 'blind_high_right', 'jump', 'flip', 'mantle', 'melee', 'dead']);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(fs.existsSync(DIST) ? 'not found' : 'Falta dist/: corre "npm run build" primero.'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
const players = new Map(), bots = new Map(), drops = new Map();
let nextId = 1, nextBotId = 1, nextDropId = 1, hostId = null;
let settings = { ...DEFAULT_LOBBY_SETTINGS }, phase = 'empty', phaseTimer = null, startAt = 0, round = 0;
let wins = { red: 0, blue: 0 }, pools = { red: 0, blue: 0 };

const nowSec = () => Date.now() / 1000;
const send = (ws, obj) => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); };
function sendRaw(ws, data) { if (ws?.readyState === 1) ws.send(data); }
function broadcastRaw(obj) { const data = JSON.stringify(obj); for (const p of players.values()) sendRaw(p.ws, data); }
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
function specialForRound(r) { return r % 2 === 1 ? 'sniper' : 'bazooka'; }
function resetWorld() { drops.clear(); for (const c of CRATES) { c.up = true; c.t = 0; } }
function resetRoom() {
  clearTimer(); players.clear(); bots.clear(); drops.clear(); hostId = null;
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
    lastDamage: 0, respawnAt: 0, prot: startAt + SPAWN_PROT,
    lastFireAt: -Infinity, pendingShot: null });
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
  const d = { wep: clampDropWep(target.w), x: target.x, z: target.z, y: target.y || 0,
    team: target.team, mag: target.am || 0, res: target.ar || 0, t: DROP_LIFE };
  drops.set(id, d); broadcastRaw({ t: 'dropA', id, wep: d.wep, x: d.x, z: d.z, y: d.y, team: d.team, life: DROP_LIFE });
}
function registerFire(shooter, msg, isBotFire = false) {
  if (!shooter?.alive || phase !== 'playing') return false;
  const o = vec3(msg.o), pt = vec3(msg.p); if (!o || !pt) return false;
  const weapon = FIREABLE.has(msg.w) ? msg.w : 'smg', rule = FIRE_RULES[weapon], now = nowSec();
  // el melee no depende del arma en mano; el resto debe coincidir con ella
  if ((weapon !== 'melee' && weapon !== shooter.w) || now - shooter.lastFireAt < rule.interval * .82) return false;
  // Un PROYECTIL explota lejos de quien lo lanzó: su "disparo" se registra en
  // el punto de la explosión, así que no se le exige nacer junto al tirador
  // (sí el resto: cadencia, arma en mano y alcance del splash).
  const proj = weapon === 'bazooka';
  if (!proj && (Math.hypot(o[0] - shooter.x, o[2] - shooter.z) > (isBotFire ? 6 : 5) || Math.abs(o[1] - ((shooter.y || 0) + 1.1)) > 4)) return false;
  if (proj && Math.hypot(o[0] - shooter.x, o[2] - shooter.z) > rule.range + 4) return false;
  if (Math.hypot(pt[0] - o[0], pt[1] - o[1], pt[2] - o[2]) > rule.range + 2) return false;
  const decals = Array.isArray(msg.d) ? msg.d.slice(0, 8).map(vec3).filter(Boolean) : undefined;
  shooter.lastFireAt = now; shooter.pendingShot = { at: now, wep: weapon, origin: o, remainingDamage: rule.maxDamage, hitIds: new Set() };
  shooter.prot = 0;
  broadcastRaw({ t: 'fire', id: shooter.id, o, p: pt, w: weapon, ...(decals ? { d: decals } : {}) }); return true;
}
function registerHit(shooter, msg) {
  const target = players.get(msg.target) || bots.get(msg.target);
  const shot = shooter?.pendingShot, rule = shot ? FIRE_RULES[shot.wep] : null, now = nowSec();
  if (!target || !target.alive || !shooter?.alive || phase !== 'playing' || target.prot > now) return;
  const selfRocket = target.id === shooter.id && shot?.wep === 'bazooka';
  if (target.team === shooter.team && !selfRocket) return;
  if (!shot || !rule || now - shot.at > HIT_WINDOW || shot.hitIds.has(target.id)) return;
  const dist = Math.hypot(target.x - shot.origin[0], (target.y || 0) + 1 - shot.origin[1], target.z - shot.origin[2]);
  if (dist > (rule.hitRange ?? rule.range) + 2) return;
  const dmg = Math.min(Math.max(0, num(msg.dmg)), shot.remainingDamage); if (dmg <= 0) return;
  shot.hitIds.add(target.id); shot.remainingDamage -= dmg; target.hp -= dmg; target.lastDamage = now;
  if (target.hp > 0) return;
  target.hp = 0; target.alive = false; target.deaths++;
  if (target.id !== shooter.id) shooter.kills++;
  const gib = shot.wep === 'shotgun' && dist <= FIRE_RULES.shotgun.gibRange && !!msg.gib;
  broadcastRaw({ t: 'death', target: target.id, from: shooter.id, gib: gib ? 1 : 0, w: shot.wep,
    dist: +dist.toFixed(2), dmg: Math.round(dmg), part: msg.part === 'head' ? 'head' : 'body',
    kn: shooter.name, kt: shooter.team, vn: target.name, vt: target.team });
  dropWeapon(target);
  target.specialWep = null;
  if (pools[target.team] > 0) { pools[target.team]--; target.respawnAt = now + RESPAWN_TIME; }
  else target.respawnAt = 0;
  broadcastRaw({ t: 'score', ...livesState(), wins: { ...wins } }); checkRoundEnd();
}

wss.on('connection', (ws) => {
  let me = null;
  ws.on('message', (data) => {
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
      me.x = clamp(msg.x, -60, 60); me.z = clamp(msg.z, -60, 60); me.y = clamp(msg.y, 0, 20); me.yaw = clamp(msg.yaw, -10, 10);
      me.st = VALID_STATES.has(String(msg.st)) && msg.st !== 'dead' ? msg.st : 'idle';
      me.aim = msg.aim ? 1 : 0; me.p = clamp(msg.p, -1.6, 1.6);
      const requestedWep = clampWep(msg.w);
      me.w = SPECIAL_WEAPONS.has(requestedWep) && me.specialWep !== requestedWep ? 'smg' : requestedWep;
      me.am = clamp(msg.am, 0, 500); me.ar = clamp(msg.ar, 0, 500); me.sp = clamp(msg.sp, 0, 1); return;
    }
    if (msg.t === 'botState') {
      if (!isHost(me) || phase !== 'playing' || !Array.isArray(msg.bots)) return;
      for (const s of msg.bots.slice(0, MAX_PLAYERS)) {
        const b = bots.get(s.id); if (!b || !b.alive) continue;
        b.x = clamp(s.x, -60, 60); b.z = clamp(s.z, -60, 60); b.y = clamp(s.y, 0, 20); b.yaw = clamp(s.yaw, -10, 10);
        b.st = VALID_STATES.has(String(s.st)) && s.st !== 'dead' ? s.st : 'idle';
        b.aim = s.aim ? 1 : 0; b.p = clamp(s.p, -1.6, 1.6);
        const requestedWep = clampWep(s.w);
        b.w = SPECIAL_WEAPONS.has(requestedWep) && b.specialWep !== requestedWep ? 'smg' : requestedWep;
        b.sp = clamp(s.sp, 0, 1);
      } return;
    }
    if (msg.t === 'fire') { registerFire(me, msg); return; }
    if (msg.t === 'botFire') { if (isHost(me)) { const b = bots.get(msg.id); if (b) {
      const requestedWep = FIREABLE.has(msg.w) ? msg.w : 'smg';
      if (SPECIAL_WEAPONS.has(requestedWep) && b.specialWep !== requestedWep) return;
      b.w = requestedWep; registerFire(b, msg, true);
    } } return; }
    // granada de humo: solo visual/oclusión — el server la reenvía y cada
    // cliente simula el mismo proyectil determinista
    if (msg.t === 'nade') {
      const o = vec3(msg.o), v = vec3(msg.v);
      if (me?.alive && phase === 'playing' && o && v) broadcastRaw({ t: 'nade', id: me.id, o, v });
      return;
    }
    if (msg.t === 'hit') { registerHit(me, msg); return; }
    if (msg.t === 'botHit') { if (isHost(me)) { const b = bots.get(msg.id); if (b) registerHit(b, msg); } return; }
    if (msg.t === 'takeDrop') {
      const d = drops.get(msg.id);
      if (!d || !me.alive || phase !== 'playing' || Math.hypot(me.x - d.x, me.z - d.z) > 3) return;
      if (SPECIAL_WEAPONS.has(d.wep)) me.specialWep = d.wep;
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
      broadcastRaw({ t: 'specialTaken', id: claimant.id, wep: special.wep });
      return;
    }
    if (msg.t === 'crate') {
      const c = CRATES[msg.i];
      const spot = MAP_RUNTIME[settings.map]?.crates?.[msg.i];
      if (!c || !spot || !c.up || !me.alive || phase !== 'playing' ||
          Math.hypot(me.x - spot.x, me.z - spot.z) > 3) return;
      c.up = false; c.t = CRATE_RESPAWN; broadcastRaw({ t: 'crate', i: msg.i, up: 0, by: me.id });
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
  if (phase === 'playing') for (const p of allSlots()) {
    if (p.alive && p.hp < HP && now - p.lastDamage > REGEN_DELAY) p.hp = Math.min(HP, p.hp + REGEN_RATE / TICK_HZ);
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) {
      p.alive = true; p.hp = HP; p.respawnAt = 0; p.prot = now + SPAWN_PROT;
      const spawn = pickSpawn(p.team); Object.assign(p, { x: spawn.x, z: spawn.z, y: 0, yaw: spawn.yaw });
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
