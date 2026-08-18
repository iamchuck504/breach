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
const HP = 100, REGEN_DELAY = 3.6, REGEN_RATE = 48, RESPAWN_TIME = 4, KILL_LIMIT = 25;
const TICK_HZ = 20;

// espejo de world.js
const SPAWNS = { red: [], blue: [] };
for (let i = 0; i < 4; i++) {
  const x = -3.6 + i * 2.4;
  SPAWNS.red.push({ x, z: -16.4, yaw: Math.PI });
  SPAWNS.blue.push({ x: -x, z: 16.4, yaw: 0 });
}

// ---------- estático ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

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
let nextId = 1;
let scores = { red: 0, blue: 0 };
let resetting = false;

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
        x: spawn.x, z: spawn.z, yaw: spawn.yaw,
        st: 'idle', aim: 0, p: 0, w: 'lancer', sp: 0,
        hp: HP, alive: true, lastDamage: 0, respawnAt: 0,
        kills: 0, deaths: 0,
      };
      players.set(id, me);
      send(ws, {
        t: 'welcome', id, team, spawn, scores,
        players: [...players.values()].map(pub),
      });
      broadcast({ t: 'joined', id, name: me.name, team });
      console.log(`+ ${me.name} (${team}) — ${players.size}/${MAX_PLAYERS}`);
      return;
    }
    if (!me) return;

    if (msg.t === 's') {
      me.x = num(msg.x); me.z = num(msg.z); me.y = num(msg.y); me.yaw = num(msg.yaw);
      me.st = String(msg.st || 'idle'); me.aim = msg.aim ? 1 : 0;
      me.p = num(msg.p); me.w = msg.w === 'gnasher' ? 'gnasher' : 'lancer';
      me.sp = num(msg.sp);
      return;
    }
    if (msg.t === 'fire') {
      broadcast({ t: 'fire', id: me.id, o: msg.o, p: msg.p, w: me.w });
      return;
    }
    if (msg.t === 'hit') {
      const target = players.get(msg.target);
      if (!target || !target.alive || !me.alive || target.team === me.team || resetting) return;
      const dmg = Math.min(120, Math.max(0, num(msg.dmg)));
      target.hp -= dmg;
      target.lastDamage = Date.now() / 1000;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        target.deaths++;
        target.respawnAt = Date.now() / 1000 + RESPAWN_TIME;
        me.kills++;
        scores[me.team]++;
        broadcast({
          t: 'death', target: target.id, from: me.id, gib: msg.gib ? 1 : 0,
          kn: me.name, kt: me.team, vn: target.name, vt: target.team,
        });
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
  });
});

function endRound(team) {
  resetting = true;
  broadcast({ t: 'win', team });
  setTimeout(() => {
    scores = { red: 0, blue: 0 };
    for (const p of players.values()) {
      p.hp = HP; p.alive = true; p.respawnAt = 0;
      const spawn = pickSpawn(p.team);
      p.x = spawn.x; p.z = spawn.z;
      broadcast({ t: 'respawn', id: p.id, spawn });
    }
    broadcast({ t: 'score', ...scores });
    resetting = false;
  }, 4000);
}

function pub(p) {
  return { id: p.id, name: p.name, team: p.team, alive: p.alive, hp: p.hp };
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// tick: regen + respawns + snapshot
setInterval(() => {
  const now = Date.now() / 1000;
  for (const p of players.values()) {
    if (p.alive && p.hp < HP && now - p.lastDamage > REGEN_DELAY) {
      p.hp = Math.min(HP, p.hp + REGEN_RATE / TICK_HZ);
    }
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt && !resetting) {
      p.alive = true; p.hp = HP; p.respawnAt = 0;
      const spawn = pickSpawn(p.team);
      p.x = spawn.x; p.z = spawn.z;
      broadcast({ t: 'respawn', id: p.id, spawn });
    }
  }
  if (players.size > 0) {
    broadcast({
      t: 'snap',
      ps: [...players.values()].map((p) => ({
        id: p.id, x: p.x, z: p.z, y: p.y || 0, yaw: p.yaw, st: p.st, aim: p.aim,
        p: p.p, w: p.w, sp: p.sp, hp: Math.round(p.hp), alive: p.alive,
      })),
    });
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`BREACH server en http://localhost:${PORT} (ws mismo puerto)`);
  console.log(`LAN: comparte http://TU-IP-LOCAL:${PORT} — el cliente se conecta solo.`);
});
