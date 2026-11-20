// Autoridad del servidor frente a mensajes de cliente, contra el handler VIVO.
// 1. Fuzz con estructura: para cada tipo de mensaje cliente→servidor con datos
//    se construye una plantilla VÁLIDA en el estado real de la partida (bot del
//    host, arma en mano, drop y caja que existen, especial en el pedestal...),
//    se comprueba que la plantilla SIN mutar se acepta (efecto observable) y se
//    cambia un campo cada vez (también los de elementos anidados) por algo
//    hostil. El proceso no puede caer, debe seguir sirviendo, y las vidas solo
//    cambian por impactos válidos.
// 2. Bots alojados: botState malformado, origen del disparo anclado a poses
//    DIFUNDIDAS del bot y sin atravesar cobertura.
//   node scripts/check-bot-authority.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { mapLineBlocked } from '../server/map-geometry.js';
import { MAP_RUNTIME, DEFAULT_LOBBY_SETTINGS } from '../src/game/lobby-rules.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8862;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1', SPECIAL_FIRST_WEAPON: 'bazooka' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += String(d); });
server.stderr.on('data', (d) => { serverLog += String(d); });
const alive = (what) => assert.equal(server.exitCode, null, `el servidor cayó (${what})\n${serverLog.slice(-1500)}`);

// ---------- clientes ----------
class Peer {
  constructor() { this.history = []; }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (raw) => { try { this.history.push(JSON.parse(raw)); } catch { /* binario */ } });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    return this;
  }
  send(m) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  mark() { return this.history.length; }
  // espera un mensaje recibido DESPUÉS de `from`
  next(pred, timeout = 4000, from = 0, label = '') {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const m = this.history.slice(from).find(pred);
        if (m) return resolve(m);
        if (Date.now() - t0 > timeout) return reject(new Error(`timeout esperando ${label}; últimos=${JSON.stringify(this.history.slice(-3)).slice(0, 300)}`));
        setTimeout(tick, 10);
      };
      tick();
    });
  }
  close() { try { this.ws.close(); } catch { /* ya cerrado */ } }
}

// ---------- fuzz ----------
const HOSTILE = [null, 5, -1, 'x', true, [], {}, [1, 2], { toString: 1, valueOf: 1 }, { toString: null, valueOf: null },
  { a: { b: null } }, 'NaN', 'x'.repeat(8000), '__INF__', '__NINF__'];
// campos que el servidor ignora o recalcula: menos valores (cada impacto válido cuesta vida)
const HOSTILE_SHORT = [null, 'x', true, {}, { toString: 1, valueOf: 1 }, 'NaN', '__INF__', [1, 2]];
const enc = (m) => JSON.stringify(m).replace(/"__INF__"/g, '1e999').replace(/"__NINF__"/g, '-1e999');
function mutations(t, tpl, short = []) {
  const out = [];
  for (const k of Object.keys(tpl)) for (const v of (short.includes(k) ? HOSTILE_SHORT : HOSTILE)) {
    out.push(enc({ t, ...tpl, [k]: v }));
    const el = Array.isArray(tpl[k]) ? tpl[k][0] : (tpl[k] && typeof tpl[k] === 'object' ? tpl[k] : null);
    if (el && typeof el === 'object' && !Array.isArray(el)) for (const kk of Object.keys(el)) {
      const m = { ...el, [kk]: v };
      out.push(enc({ t, ...tpl, [k]: Array.isArray(tpl[k]) ? [m] : m }));
    }
  }
  return out;
}
const stats = { types: new Set(), accepted: new Set(), messages: 0 };
// manda mensajes respetando el limitador (240 fichas/s, 1 por cada 2 KB) y un hueco mínimo
async function pump(peer, list, gap = 0, before = null) {
  let tokens = 0;
  for (const m of list) {
    assert.equal(peer.ws.readyState, 1, 'el servidor cerró el socket durante el fuzz');
    if (before) { before(); await wait(5); }
    peer.send(m); stats.messages++;
    tokens += Math.max(1, Math.ceil(Buffer.byteLength(m) / 2048)) + (before ? 1 : 0);
    if (gap) await wait(gap);
    else if (tokens >= 12) { tokens = 0; await wait(100); }
    alive(m.slice(0, 200));
  }
}
// plantilla válida: se ACEPTA (efecto observable `accepted`) y se muta campo a campo.
// order 'first': aceptar primero (recursos que se consumen); 'last': al final.
async function check(peer, t, tpl, accepted, { order = 'last', gap = 0, before = null, short = [], label = t } = {}) {
  stats.types.add(t);
  const proveAccepted = async () => {
    if (before) { before(); await wait(5); }
    const from = peer.mark();
    peer.send(enc({ t, ...tpl })); stats.messages++;
    await accepted(from);
    stats.accepted.add(t);
  };
  const proved = () => proveAccepted().catch((e) => { throw new Error(`${label}: la plantilla válida no se aceptó — ${e.message}`); });
  if (order === 'first') await proved();
  await pump(peer, mutations(t, tpl, short), gap, before);
  if (order === 'last') await proved();
  alive(t);
}

const host = await (async () => { await wait(700); return new Peer().open(); })();
let v = null, k = null;
try {
  // ---------- lobby ----------
  host.send({ t: 'join', action: 'create', name: 'HOST', v: 0, hp: 2 });
  const welcome = await host.next((m) => m.t === 'welcome', 4000, 0, 'welcome');
  const mine = welcome.team, other = mine === 'red' ? 'blue' : 'red';
  v = await new Peer().open();
  v.send({ t: 'join', action: 'join', name: 'VICTIM', v: 1, hp: 2 });
  const welcomeV = await v.next((m) => m.t === 'welcome', 4000, 0, 'welcome víctima');
  if (welcomeV.team !== mine) { v.send({ t: 'lobbyTeam', team: mine }); await wait(150); }
  // tercer humano: recoge el arma del bot que mata (cada tirador gasta su munición)
  k = await new Peer().open();
  k.send({ t: 'join', action: 'join', name: 'KILLER', v: 2, hp: 2 });
  const welcomeK = await k.next((m) => m.t === 'welcome', 4000, 0, 'welcome tirador');
  if (welcomeK.team !== mine) { k.send({ t: 'lobbyTeam', team: mine }); await wait(150); }
  const lastLobby = () => host.history.filter((m) => m.t === 'lobby').at(-1);
  const S = DEFAULT_LOBBY_SETTINGS;
  const okSettings = { map: 'fortaleza', rounds: S.rounds, lives: S.lives, postMatch: S.postMatch, fillBots: false };
  await check(host, 'lobbySettings', { settings: okSettings },
    (from) => host.next((m) => m.t === 'lobby' && m.settings.map === 'fortaleza' && m.settings.fillBots === false, 3000, from));
  const botsOf = () => lastLobby()?.bots ?? [];
  await check(host, 'lobbyBotAdd', { team: other },
    (from) => host.next((m) => m.t === 'lobby' && m.bots.length > botsOf().length - 1 && m.bots.some((b) => b.team === other), 3000, from));
  let someBot = botsOf().find((b) => b.team === other);
  // las mutaciones válidas de lobbyBotAdd añadieron bots: se deja solo uno
  for (const b of botsOf()) if (b.id !== someBot.id) { host.send({ t: 'lobbyBotRemove', id: b.id }); await wait(30); }
  await wait(150);
  await check(host, 'lobbyBotTeam', { id: someBot.id, team: mine },
    (from) => host.next((m) => m.t === 'lobby' && m.bots.find((b) => b.id === someBot.id)?.team === mine, 3000, from), { order: 'first' });
  await check(host, 'lobbyBotRemove', { id: someBot.id },
    (from) => host.next((m) => m.t === 'lobby' && !m.bots.some((b) => b.id === someBot.id), 3000, from), { order: 'first' });
  await check(v, 'lobbyTeam', { team: other },
    (from) => v.next((m) => m.t === 'lobby' && m.players.find((p) => p.id === welcomeV.id)?.team === other, 3000, from), { order: 'first' });
  v.send({ t: 'lobbyTeam', team: mine }); await wait(150);
  // join: cada variante desde su propio socket
  stats.types.add('join');
  {
    const probe = await new Peer().open();
    probe.send({ t: 'join', action: 'join', name: 'FUZZ', v: 1, hp: 2 });
    await probe.next((m) => m.t === 'welcome', 3000, 0, 'welcome de la plantilla join');
    stats.accepted.add('join'); probe.close();
    for (const m of mutations('join', { action: 'join', name: 'FUZZ', v: 1, hp: 2 })) {
      const extra = await new Peer().open().catch(() => null);
      if (extra) { extra.send(m); stats.messages++; await wait(30); extra.close(); }
      alive(`join ${m.slice(0, 120)}`);
    }
    await wait(300);
  }
  // roster final conocido (equipos parejos): tres humanos + un bot en `mine`,
  // cuatro bots en `other`
  for (const b of botsOf()) { host.send({ t: 'lobbyBotRemove', id: b.id }); await wait(30); }
  for (let i = 0; i < 4; i++) { host.send({ t: 'lobbyBotAdd', team: other }); await wait(30); }
  host.send({ t: 'lobbyBotAdd', team: mine }); await wait(30);
  await wait(200);
  const start = host.mark();
  await check(host, 'lobbyStart', {}, (from) => host.next((m) => m.t === 'matchStart', 4000, from));
  const matchStart = host.history.slice(start).find((m) => m.t === 'matchStart');
  const layout = matchStart.settings?.map ?? 'fortaleza', RT = MAP_RUNTIME[layout];
  const snapOf = async () => { const from = host.mark(); return host.next((m) => m.t === 'snap' && m.phase === 'playing', 4000, from, 'snap'); };
  // fin de la protección de aparición (5 s)
  await wait(5600);
  let snap = await snapOf();
  const me = () => snap.ps.find((p) => p.id === welcome.id);
  // equipos: del matchStart (el snapshot no los lleva)
  const teamOf = Object.fromEntries((matchStart.players ?? []).map((p) => [p.id, p.team]));
  const bots = snap.ps.filter((p) => p.bot && teamOf[p.id] === other);
  assert.equal(bots.length, 4, 'roster inesperado');
  // ---------- partida ----------
  // escenario despejado: el host frente a los bots, a 4 m, sin geometría entre medias
  let base = null;
  for (let x = -16; x <= 16 && !base; x += 1) for (let z = -16; z <= 16 && !base; z += 1) {
    const free = (px, pz) => !mapLineBlocked(layout, [px, 0.4, pz], [px, 1.6, pz], 0);
    if (!free(x, z)) continue;
    const pts = [0, 1, 2, 3].map((i) => [x - 3 + i * 2, z - 4]);
    if (pts.every(([px, pz]) => free(px, pz) && !mapLineBlocked(layout, [x, 1.3, z], [px, 1.3, pz], 0.3))) base = { x, z, pts };
  }
  assert.ok(base, 'sin escenario despejado');
  const hostS = (extra = {}) => ({ x: base.x, y: 0, z: base.z, yaw: 0, st: 'idle', aim: 0, p: 0, ae: 0, cl: 0, ce: 0, w: 'smg', am: 30, ar: 90, sp: 0, ...extra });
  const botS = (i) => ({ id: bots[i].id, x: base.pts[i][0], y: 0, z: base.pts[i][1], yaw: Math.PI, st: 'idle', aim: 0, p: 0, ae: 0, cl: 0, ce: 1, w: 'smg', sp: 0 });
  const place = () => {
    host.send({ t: 's', ...hostS() }); host.send({ t: 'botState', bots: bots.map((_, i) => botS(i)) });
    v.send({ t: 's', ...hostS({ x: base.x + 1.5 }) }); k.send({ t: 's', ...hostS({ x: base.x - 1.5 }) });
  };
  for (let i = 0; i < 6; i++) { place(); await wait(60); }
  snap = await snapOf();
  // s: mover medio metro y volver
  await check(host, 's', hostS({ x: base.x + 0.5 }), async (from) => {
    await host.next((m) => m.t === 'snap' && Math.abs(m.ps.find((p) => p.id === welcome.id).x - (base.x + 0.5)) < 0.01, 2000, from);
  });
  // un mensaje RECHAZADO (coordenada no numérica) no mueve a nadie
  place(); await wait(150);
  {
    const posOf = (m) => JSON.stringify(m.ps.map((p) => [p.id, p.x, p.z, p.y, p.yaw]));
    const ref = posOf(await snapOf());
    const nonNum = HOSTILE.filter((x) => typeof x !== 'number');
    const rejected = [];
    for (const key of ['x', 'y', 'z', 'yaw']) for (const val of nonNum) {
      rejected.push(enc({ t: 's', ...hostS({ x: base.x + 2 }), [key]: val }));
      rejected.push(enc({ t: 'botState', bots: [{ ...botS(0), x: base.pts[0][0] + 2, [key]: val }] }));
    }
    await pump(host, rejected);
    assert.equal(posOf(await snapOf()), ref, 'un mensaje rechazado movió a alguien');
  }
  await check(host, 'botState', { bots: [{ ...botS(0), x: base.pts[0][0] + 0.3 }] }, async (from) => {
    await host.next((m) => m.t === 'snap' && Math.abs(m.ps.find((p) => p.id === bots[0].id).x - (base.pts[0][0] + 0.3)) < 0.01, 2000, from);
  });
  place(); await wait(120);
  // fire / botFire: un disparo al aire (sin blanco), cadencia respetada
  const shot = (o, p) => ({ o, p, w: 'smg', d: [], fp: { st: 'idle', a: 1, p: 0, ae: 0, cl: 0, ce: 0 } });
  const up = (x, z) => [x, 30, z];
  await check(host, 'fire', shot([base.x, 1.1, base.z], up(base.x, base.z + 8)),
    (from) => host.next((m) => m.t === 'fire' && m.id === welcome.id, 2000, from), { gap: 120 });
  const b0 = base.pts[0];
  await check(host, 'botFire', { id: bots[0].id, ...shot([b0[0], 1.35, b0[1]], up(b0[0], b0[1] - 8)) },
    (from) => host.next((m) => m.t === 'fire' && m.id === bots[0].id, 2000, from), { gap: 120 });
  // hit: cada claim tras su propio disparo; blancos rotando entre bots vivos
  snap = await snapOf();
  const hpBefore = Object.fromEntries(snap.ps.map((p) => [p.id, p.hp]));
  let target = 1;
  const nextAlive = () => { for (let k = 0; k < 3; k++) { const i = 1 + ((target - 1 + k) % 3); if (snap.ps.find((p) => p.id === bots[i].id)?.alive) return i; } return 1; };
  const aimAt = (i, part) => { const [x, z] = base.pts[i]; return [x, part === 'head' ? 1.52 : 1.0, z]; };
  // cada tirador gasta su propia munición: el host ya disparó en el fuzz de fire
  const fireFrom = (peer, x) => (i, part) => peer.send({ t: 'fire', ...shot([x, 1.1, base.z], aimAt(i, part)) });
  const fireAt = fireFrom(v, base.x + 1.5);
  const hitTpl = (i) => ({ target: bots[i].id, dmg: 10, part: 'body', p: aimAt(i, 'body'), pellets: 1, gib: 0 });
  await check(v, 'hit', hitTpl(1), (from) => v.next((m) => m.t === 'snap' && m.ps.find((p) => p.id === bots[1].id).hp < hpBefore[bots[1].id], 2000, from),
    { order: 'first', gap: 130, before: () => { target = nextAlive(); fireAt(target, 'body'); }, short: ['dmg', 'part', 'pellets', 'gib'] });
  // botHit: un bot dispara a la víctima (no al host: su vida se necesita después)
  snap = await snapOf();
  const vx = base.x + 1.5, vz = base.z;
  const hpV = snap.ps.find((p) => p.id === welcomeV.id).hp;
  await check(host, 'botHit', { id: bots[0].id, target: welcomeV.id, dmg: 7, part: 'body', p: [vx, 1.0, vz] },
    (from) => host.next((m) => m.t === 'snap' && m.ps.find((p) => p.id === welcomeV.id).hp < hpV, 2000, from),
    { order: 'first', gap: 130, short: ['dmg', 'part'],
      before: () => host.send({ t: 'botFire', id: bots[0].id, ...shot([b0[0], 1.35, b0[1]], [vx, 1.0, vz]) }) });
  // takeDrop: matar al bot 3 (cabeza) deja su arma; el host (con munición gastada) la recoge
  place(); await wait(120);
  let drop = null;
  snap = await snapOf();
  const kill = [3, 2, 1].find((i) => snap.ps.find((p) => p.id === bots[i].id)?.alive);
  assert.ok(kill !== undefined, 'no queda bot vivo para soltar un arma');
  const killFrom = host.mark();
  for (let i = 0; i < 20 && !drop; i++) {
    fireFrom(k, base.x - 1.5)(kill, 'head'); await wait(5);
    k.send({ t: 'hit', target: bots[kill].id, dmg: 16, part: 'head', p: aimAt(kill, 'head') });
    await wait(130);
    drop = host.history.slice(killFrom).find((m) => m.t === 'dropA');
  }
  assert.ok(drop, 'el bot no soltó su arma');
  k.send({ t: 's', ...hostS({ x: drop.x, z: drop.z, y: drop.y }) }); await wait(80);
  await check(k, 'takeDrop', { id: drop.id, capacity: 5 }, (from) => k.next((m) => m.t === 'dropGive', 2000, from), { order: 'first' });
  // nade: humo (dos en total): plantilla primero
  // la granada tiene que estar EN MANO (arma replicada) y pasado el gesto de cambio
  host.send({ t: 's', ...hostS({ w: 'grenade', am: 2, ar: 0 }) }); await wait(700);
  await check(host, 'nade', { o: [base.x, 1.1, base.z], v: [0, 6, -3], cid: 'n1' },
    (from) => host.next((m) => m.t === 'nadeAck', 2000, from), { order: 'first', gap: 30 });
  // crate: junto a la caja 0
  const crate = RT.crates?.[0];
  assert.ok(crate, 'el mapa no tiene cajas');
  host.send({ t: 's', ...hostS({ x: crate.x, z: crate.z, y: crate.y ?? 0, w: 'grenade', am: 0, ar: 0 }) }); await wait(80);
  await check(host, 'crate', { i: 0 }, (from) => host.next((m) => m.t === 'crate' && m.up === 0, 2000, from), { order: 'first' });
  // takeSpecial (bazooka) y rocket hacia el cielo
  const sp = RT.special;
  host.send({ t: 's', ...hostS({ x: sp.x, z: sp.z, y: sp.y ?? 0, w: 'grenade', am: 0, ar: 0 }) }); await wait(80);
  await check(host, 'takeSpecial', {}, (from) => host.next((m) => m.t === 'specialTaken' && m.id === welcome.id, 2000, from));
  host.send({ t: 's', ...hostS({ x: sp.x, z: sp.z, y: sp.y ?? 0, w: 'bazooka', am: 1, ar: 2 }) }); await wait(700);
  await check(host, 'rocket', { o: [sp.x, (sp.y ?? 0) + 1.1, sp.z], d: [0, 1, 0], cid: 'r1' },
    (from) => host.next((m) => m.t === 'rocketAck', 2000, from), { order: 'first', gap: 30 });
  // protoClaim / protoFire: granada de fragmentación del suelo
  const ps = host.history.filter((m) => m.t === 'protoState').at(-1);
  const pick = ps?.pickups?.find((p) => p.kind === 'frag' && p.count > 0);
  assert.ok(pick, 'sin pickup de fragmentación');
  host.send({ t: 's', ...hostS({ x: pick.x + 0.3, z: pick.z, y: pick.y ?? 0, w: 'bazooka', am: 0, ar: 0 }) }); await wait(80);
  await check(host, 'protoClaim', { id: pick.id, manual: true },
    (from) => host.next((m) => m.t === 'protoInventory' && m.id === welcome.id, 2000, from), { order: 'first' });
  host.send({ t: 's', ...hostS({ x: pick.x + 0.3, z: pick.z, y: pick.y ?? 0, w: 'frag', am: 1, ar: 0 }) }); await wait(700);
  await check(host, 'protoFire', { kind: 'frag', o: [pick.x + 0.3, (pick.y ?? 0) + 1.0, pick.z], d: [0, 6, -2] },
    (from) => host.next((m) => (m.t === 'protoInventory' && m.id === welcome.id) || (m.t === 'protoState' && m.projectiles?.length > 0), 2000, from), { order: 'first', gap: 30 });
  // textos sueltos que no son mensajes
  for (const raw of ['null', '5', '"x"', '[]', '{"t":null}', '{"t":{}}', '{"t":["s"]}']) host.send(raw);
  await wait(200); alive('no-mensajes');
  // sigue sirviendo
  snap = await snapOf();

  // ---------- bots alojados ----------
  // (a) botState malformado
  host.send({ t: 'botState', bots: [null, 7, 'x', { id: 3 }, [], { id: bots[0].id, x: 'a' }] });
  await wait(100); alive('botState malformado');
  // (d) tramo pecho→origen que cruza el mapa
  let spot = null;
  for (let x = -20; x <= 20 && !spot; x += 0.5) for (let z = -20; z <= 20 && !spot; z += 0.5) {
    if (mapLineBlocked(layout, [x, 0.4, z], [x, 1.6, z], 0)) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = [x + dx, 1.35, z + dz];
      if (mapLineBlocked(layout, [x, 1.3, z], o, 0.02)) { spot = { x, z, o, far: [x + dx * 20, 1.35, z + dz * 20] }; break; }
    }
  }
  assert.ok(spot, 'no hay geometría para la prueba');
  const bid = bots[0].id;
  const placeBot = (x, z) => host.send({ t: 'botState', bots: [{ ...botS(0), x, z }] });
  for (let i = 0; i < 6; i++) { placeBot(spot.x, spot.z); await wait(60); }
  const fires = () => host.history.filter((m) => m.t === 'fire' && m.id === bid).length;
  let before = fires();
  host.send({ t: 'botFire', id: bid, o: spot.o, p: spot.far, w: 'smg' });
  await wait(250);
  assert.equal(fires(), before, 'disparo de bot aceptado a través de la cobertura');
  host.send({ t: 'botFire', id: bid, o: [spot.x + 3, 1.35, spot.z], p: [spot.x + 20, 1.35, spot.z], w: 'smg' });
  await wait(250);
  assert.equal(fires(), before, 'disparo de bot aceptado a 3 m de su cuerpo');
  // posición recibida pero aún NO difundida: no autoriza. Determinista: se
  // envía justo al llegar un snapshot (el siguiente tick es 50 ms después).
  let spot2 = null;
  for (const dx of [3, -3, 4, -4]) {
    const x = spot.x + dx;
    if (!mapLineBlocked(layout, [x, 0.4, spot.z], [x, 1.6, spot.z], 0) && !mapLineBlocked(layout, [spot.x, 1.3, spot.z], [x, 1.3, spot.z], 0)) { spot2 = x; break; }
  }
  assert.ok(spot2 !== null, 'sin hueco para la prueba de no difundido');
  before = fires();
  {
    const from = host.mark();
    await host.next((m) => m.t === 'snap', 2000, from);
    placeBot(spot2, spot.z);
    host.send({ t: 'botFire', id: bid, o: [spot2, 1.35, spot.z], p: [spot2, 1.35, spot.z - 20], w: 'smg' });
  }
  await wait(250);
  assert.equal(fires(), before, 'disparo de bot autorizado por una posición aún no difundida');
  for (let i = 0; i < 4; i++) { placeBot(spot.x, spot.z); await wait(60); }
  host.send({ t: 'botFire', id: bid, o: [spot.x, 1.35, spot.z], p: [2 * spot.x - spot.o[0], 1.35, 2 * spot.z - spot.o[2]], w: 'smg' });
  await host.next((m) => m.t === 'fire' && m.id === bid, 1500, before ? 0 : 0, 'disparo legítimo del bot').catch(() => { throw new Error('el disparo legítimo del bot fue rechazado'); });
  alive('final');
  const types = [...stats.types], acc = [...stats.accepted];
  assert.deepEqual(types.filter((t) => !acc.includes(t)), [], 'tipos sin plantilla aceptada');
  console.log(`BOT AUTHORITY OK · ${types.length} tipos de mensaje, ${acc.length} plantillas aceptadas, ${stats.messages} mensajes de fuzz sin caídas · origen de bot anclado a poses difundidas y sin atravesar cobertura`);
} finally {
  v?.close(); k?.close(); host.close();
  server.kill();
}
