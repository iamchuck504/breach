// Servidor de BREACH: sala única 4v4 por WebSocket + sirve dist/ por HTTP
// para jugar en LAN sin más infraestructura (npm run build && npm run server).
// Autoridad: hp, muertes, respawn, marcador. Posición client-authoritative (slice).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;
const MAX_PLAYERS = 8;
const HP = 100, REGEN_DELAY = 3.6, REGEN_RATE = 48, RESPAWN_TIME = 5, KILL_LIMIT = 25;
const SPAWN_PROT = 5;    // seg de invulnerabilidad al nacer (se rompe al disparar)
const CRATE_RESPAWN = 30;
const CRATES = [{ x: 7, z: 0, up: true, t: 0 }, { x: -7, z: 0, up: true, t: 0 }];
const TICK_HZ = 20;
const FIRE_RULES = {
  smg: { interval: 60 / 620, range: 80, maxDamage: 16 },
  shotgun: { interval: 60 / 95, range: 24, maxDamage: 8 * 13, gibRange: 4.2 },
};
const HIT_WINDOW = 0.28;

// espejo de world.js (mapa 'fortaleza': spawns fijos en ±23.4)
const SPAWNS = { red: [], blue: [] };
for (let i = 0; i < 4; i++) {
  const x = -3.6 + i * 2.4;
  SPAWNS.red.push({ x, z: -23.4, yaw: Math.PI });
  SPAWNS.blue.push({ x: -x, z: 23.4, yaw: 0 });
}

// ---------- estático ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(fs.existsSync(DIST) ? 'not found' : 'Falta dist/: corre "npm run build" primero.');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---------- sala ----------
const wss = new WebSocketServer({ server });
const players = new Map(); // id -> player
const drops = new Map();   // armas caídas: id -> {wep, x, z, team, mag, res, t}
let nextDropId = 1;
let nextId = 1;
let scores = { red: 0, blue: 0 };
let resetting = false;
const DROP_LIFE = 8;

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => { const s = JSON.stringify(obj); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); };

function pickTeam() {
  let r = 0, b = 0;
  for (const p of players.values()) p.team === 'red' ? r++ : b++;
  return r <= b ? 'red' : 'blue';
}
function pickSpawn(team) {
  return SPAWNS[team][Math.floor(Math.random() * SPAWNS[team].length)];
}

wss.on('connection', (ws) => {
  let me = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.t === 'join' && !me) {
      if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      const id = 'p' + nextId++;
      const team = pickTeam();
      const spawn = pickSpawn(team);
      me = {
        ws, id, team,
        name: String(msg.name || 'ANON').slice(0, 14).toUpperCase(),
        v: Math.min(4, Math.max(0, Math.round(num(msg.v)))), // variante de soldado

        x: spawn.x, z: spawn.z, yaw: spawn.yaw,
        st: 'idle', aim: 0, p: 0, w: 'smg', sp: 0,
        hp: HP, alive: true, lastDamage: 0, respawnAt: 0,
        lastFireAt: -Infinity, pendingShot: null,
        prot: Date.now() / 1000 + SPAWN_PROT,
        kills: 0, deaths: 0,
      };
      players.set(id, me);
      send(ws, {
        t: 'welcome', id, team, spawn, scores,
        players: [...players.values()].map(pub),
        crates: CRATES.map((c) => (c.up ? 1 : 0)),
        drops: [...drops.entries()].map(([id, d]) => ({ id, wep: d.wep, x: d.x, z: d.z, y: d.y, team: d.team, t: d.t })),
      });
      broadcast({ t: 'joined', id, name: me.name, team, v: me.v });
      console.log(`+ ${me.name} (${team}) — ${players.size}/${MAX_PLAYERS}`);
      return;
    }
    if (!me) return;

    if (msg.t === 's') {
      me.x = clamp(msg.x, -40, 40); me.z = clamp(msg.z, -40, 40);
      // yaw SIN clamp era fatal: un valor como 1e300 rebotado en el snap
      // metía el lerpAngle de todos los demás clientes en un bucle infinito
      me.y = clamp(msg.y, 0, 20); me.yaw = clamp(msg.yaw, -10, 10);
      let st = String(msg.st || 'idle');
      if (!VALID_STATES.has(st)) st = 'idle';
      if (st === 'dead' && me.alive) st = 'idle'; // sin "cadáveres falsos" que disparan
      me.st = st;
      me.aim = msg.aim ? 1 : 0;
      me.p = clamp(msg.p, -1.6, 1.6);
      me.w = msg.w === 'shotgun' ? 'shotgun' : 'smg';
      me.am = clamp(msg.am, 0, 500); me.ar = clamp(msg.ar, 0, 500);
      me.sp = clamp(msg.sp, 0, 1);
      return;
    }
    if (msg.t === 'fire') {
      if (!me.alive) return; // los muertos no disparan
      const o = vec3(msg.o), pt = vec3(msg.p);
      if (!o || !pt) return; // malformado: descartar, no propagar el crash
      const shotWep = msg.w === 'shotgun' ? 'shotgun' : 'smg';
      const rule = FIRE_RULES[shotWep];
      const now = Date.now() / 1000;
      // Validación básica autoritativa: arma declarada coincide con el estado,
      // cadencia válida, origen cerca del jugador y endpoint dentro de rango.
      // La geometría completa del mapa aún no vive en el server.
      if (shotWep !== me.w || now - me.lastFireAt < rule.interval * 0.82) return;
      if (Math.hypot(o[0] - me.x, o[2] - me.z) > 5 ||
          Math.abs(o[1] - ((me.y || 0) + 1.1)) > 4) return;
      if (Math.hypot(pt[0] - o[0], pt[1] - o[1], pt[2] - o[2]) > rule.range + 2) return;
      // Hasta ocho impactos estáticos (los pellets de la escopeta). Se sanean
      // individualmente y el cliente receptor los valida contra su propio mapa.
      const decals = Array.isArray(msg.d) ? msg.d.slice(0, 8).map(vec3).filter(Boolean) : undefined;
      me.lastFireAt = now;
      me.pendingShot = {
        at: now, wep: shotWep, origin: o,
        remainingDamage: rule.maxDamage, hitIds: new Set(),
      };
      me.prot = 0; // disparar rompe la protección de spawn
      broadcast({ t: 'fire', id: me.id, o, p: pt, w: me.w, ...(decals ? { d: decals } : {}) });
      return;
    }
    if (msg.t === 'takeDrop') {
      const d = drops.get(msg.id);
      if (!d || !me.alive) return;
      if (Math.hypot(me.x - d.x, me.z - d.z) > 3) return;
      drops.delete(msg.id);
      broadcast({ t: 'dropR', id: msg.id });
      send(ws, { t: 'dropGive', wep: d.wep, mag: d.mag, res: d.res });
      return;
    }
    if (msg.t === 'crate') {
      const c = CRATES[msg.i];
      if (!c || !c.up || !me.alive || resetting) return;
      if (Math.hypot(me.x - c.x, me.z - c.z) > 3) return; // validación laxa
      c.up = false;
      c.t = CRATE_RESPAWN;
      // by: solo quien la reclamó con éxito recibe el refill (el cliente ya
      // no rellena por su cuenta — eso permitía munición infinita reintentando)
      broadcast({ t: 'crate', i: msg.i, up: 0, by: me.id });
      return;
    }
    if (msg.t === 'hit') {
      const target = players.get(msg.target);
      if (!target || !target.alive || !me.alive || target.team === me.team || resetting) return;
      if (target.prot > Date.now() / 1000) return; // protección de spawn
      const now = Date.now() / 1000;
      const shot = me.pendingShot;
      const rule = shot ? FIRE_RULES[shot.wep] : null;
      if (!shot || !rule || now - shot.at > HIT_WINDOW || shot.hitIds.has(target.id)) return;
      const targetDist = Math.hypot(
        target.x - shot.origin[0], (target.y || 0) + 1 - shot.origin[1],
        target.z - shot.origin[2]);
      if (targetDist > rule.range + 2) return;
      const claimed = Math.max(0, num(msg.dmg));
      const dmg = Math.min(claimed, shot.remainingDamage);
      if (dmg <= 0) return;
      shot.hitIds.add(target.id);
      shot.remainingDamage -= dmg;
      target.hp -= dmg;
      target.lastDamage = Date.now() / 1000;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        target.deaths++;
        target.respawnAt = Date.now() / 1000 + RESPAWN_TIME;
        me.kills++;
        scores[me.team]++;
        const gib = shot.wep === 'shotgun' && targetDist <= FIRE_RULES.shotgun.gibRange && !!msg.gib;
        broadcast({
          t: 'death', target: target.id, from: me.id, gib: gib ? 1 : 0,
          kn: me.name, kt: me.team, vn: target.name, vt: target.team,
        });
        // el arma del muerto cae con sus balas restantes (8s para recogerla)
        const did = 'd' + nextDropId++;
        drops.set(did, {
          wep: target.w, x: target.x, z: target.z, y: target.y || 0, team: target.team,
          mag: target.am || 0, res: target.ar || 0, t: DROP_LIFE,
        });
        // vida en 'life' (NO 't': ese campo es el discriminador del protocolo
        // — pisarlo dejaba el drop con t='dropA' → NaN → arma invisible)
        broadcast({ t: 'dropA', id: did, wep: target.w, x: target.x, z: target.z, y: target.y || 0, team: target.team, life: DROP_LIFE });
        broadcast({ t: 'score', ...scores });
        if (scores[me.team] >= KILL_LIMIT) endRound(me.team);
      }
      return;
    }
  });

  ws.on('close', () => {
    if (me && players.has(me.id)) {
      players.delete(me.id);
      broadcast({ t: 'left', id: me.id });
      console.log(`- ${me.name} — ${players.size}/${MAX_PLAYERS}`);
    }
    me = null; // mensajes in-flight del socket cerrado no mutan la partida
    // sala vacía: partida fresca para el siguiente que entre
    if (players.size === 0) {
      scores = { red: 0, blue: 0 };
      drops.clear();
      for (const c of CRATES) { c.up = true; c.t = 0; }
      resetting = false;
      // el timer del reinicio de ronda no debe disparar sobre la sala nueva
      // (teleportaba y reseteaba el arma del primer jugador en entrar)
      if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    }
  });
});

let endTimer = null;
function endRound(team) {
  resetting = true;
  broadcast({ t: 'win', team });
  endTimer = setTimeout(() => {
    endTimer = null;
    scores = { red: 0, blue: 0 };
    // partida nueva: sin drops viejos, cajas arriba, stats a cero
    for (const id of [...drops.keys()]) { drops.delete(id); broadcast({ t: 'dropR', id }); }
    for (let i = 0; i < CRATES.length; i++) {
      if (!CRATES[i].up) { CRATES[i].up = true; CRATES[i].t = 0; broadcast({ t: 'crate', i, up: 1 }); }
    }
    for (const p of players.values()) {
      p.kills = 0; p.deaths = 0;
      p.hp = HP; p.alive = true; p.respawnAt = 0;
      p.prot = Date.now() / 1000 + SPAWN_PROT;
      const spawn = pickSpawn(p.team);
      p.x = spawn.x; p.z = spawn.z;
      broadcast({ t: 'respawn', id: p.id, spawn });
    }
    broadcast({ t: 'score', ...scores });
    resetting = false;
  }, 4000);
}

function pub(p) {
  // x/z: sin ellos los remotos nacían apilados en (0,0) hasta el primer snap
  return { id: p.id, name: p.name, team: p.team, alive: p.alive, hp: p.hp, x: p.x, z: p.z, v: p.v };
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, num(v))); }
// vector [x,y,z] saneado o null — un 'fire' malformado NO debe reventar
// el handler de mensajes de los demás clientes
function vec3(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map(num);
  return out.every((n) => Math.abs(n) < 1000) ? out : null;
}
const VALID_STATES = new Set(['idle', 'run', 'roadie', 'dive', 'slide',
  'cover_low', 'cover_high', 'blind_over', 'jump', 'flip', 'mantle', 'dead']);

// tick: regen + respawns + snapshot
setInterval(() => {
  const now = Date.now() / 1000;
  for (const p of players.values()) {
    if (p.alive && p.hp < HP && now - p.lastDamage > REGEN_DELAY) {
      p.hp = Math.min(HP, p.hp + REGEN_RATE / TICK_HZ);
    }
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt && !resetting) {
      p.alive = true; p.hp = HP; p.respawnAt = 0;
      p.prot = now + SPAWN_PROT;
      const spawn = pickSpawn(p.team);
      p.x = spawn.x; p.z = spawn.z;
      broadcast({ t: 'respawn', id: p.id, spawn });
    }
  }
  // expiración de armas caídas
  for (const [id, d] of drops) {
    d.t -= 1 / TICK_HZ;
    if (d.t <= 0) { drops.delete(id); broadcast({ t: 'dropR', id }); }
  }
  // respawn de cajas de munición
  for (let i = 0; i < CRATES.length; i++) {
    const c = CRATES[i];
    if (!c.up) {
      c.t -= 1 / TICK_HZ;
      if (c.t <= 0) { c.up = true; broadcast({ t: 'crate', i, up: 1 }); }
    }
  }
  if (players.size > 0) {
    broadcast({
      t: 'snap',
      ps: [...players.values()].map((p) => ({
        id: p.id, x: p.x, z: p.z, y: p.y || 0, yaw: p.yaw, st: p.st, aim: p.aim,
        p: p.p, w: p.w, sp: p.sp, hp: Math.round(p.hp), alive: p.alive,
        inv: p.prot > now ? 1 : 0,
      })),
    });
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`BREACH server en http://localhost:${PORT} (ws mismo puerto)`);
  console.log(`LAN: comparte http://TU-IP-LOCAL:${PORT} — el cliente se conecta solo.`);
});
