import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  DEFAULT_LOBBY_SETTINGS, MAX_PLAYERS, nextLobbyMap,
  normalizeLobbySettings, validateLobby,
} from '../src/game/lobby-rules.js';

assert.equal(nextLobbyMap('fortaleza'), 'azoteas');
assert.deepEqual(normalizeLobbySettings({ map: 'bad', rounds: 2, lives: 999, postMatch: 'bad' }), DEFAULT_LOBBY_SETTINGS);
const balanced = Array.from({ length: 8 }, (_, i) => ({ id: String(i), team: i < 4 ? 'red' : 'blue' }));
assert.equal(validateLobby(balanced, DEFAULT_LOBBY_SETTINGS).ok, true);
assert.equal(validateLobby(balanced.slice(0, 7), DEFAULT_LOBBY_SETTINGS).errors.includes('teams-unbalanced'), true);
assert.equal(MAX_PLAYERS, 8);

const port = 19000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), INTRO_TIME: '.05', COUNTDOWN_TIME: '.05', INTERMISSION_TIME: '.05', FINAL_PRESENTATION_TIME: '.05' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitServer = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server timeout')), 4000);
  child.stdout.on('data', (d) => { if (String(d).includes('BREACH server')) { clearTimeout(timer); resolve(); } });
  child.stderr.on('data', (d) => process.stderr.write(d));
});

function client(name, action) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [], waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.t && (!w.predicate || w.predicate(msg)));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  const wait = (type, predicate = null, timeout = 2500) => {
    const i = queue.findIndex((m) => m.t === type && (!predicate || predicate(m)));
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const item = { type, predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => { const x = waiters.indexOf(item); if (x >= 0) waiters.splice(x, 1); reject(new Error(`timeout ${name}:${type}`)); }, timeout);
      waiters.push(item);
    });
  };
  const send = (obj) => ws.send(JSON.stringify(obj));
  return once(ws, 'open').then(() => { send({ t: 'join', action, name, v: 0 }); return { ws, wait, send }; });
}

try {
  await waitServer;
  const a = await client('HOST', 'create');
  const aw = await a.wait('welcome');
  assert.equal(aw.lobby.hostId, aw.id);
  const b = await client('GUEST', 'join');
  const bw = await b.wait('welcome');
  assert.notEqual(aw.team, bw.team);

  b.send({ t: 'lobbyTeam', team: 'red' });
  await b.wait('lobby', (m) => m.validation.counts.red === 2);
  a.send({ t: 'lobbyTeam', team: 'blue' });
  await a.wait('lobby', (m) => m.validation.counts.red === 1 && m.validation.counts.blue === 1);

  b.send({ t: 'lobbySettings', settings: { map: 'azoteas' } });
  assert.equal((await b.wait('lobbyError')).code, 'host-only');
  a.send({ t: 'lobbySettings', settings: { map: 'azoteas', rounds: 5, lives: 20, postMatch: 'lobby' } });
  const configured = await a.wait('lobby', (m) => m.settings.map === 'azoteas');
  assert.equal(configured.settings.rounds, 5);
  assert.equal(configured.settings.lives, 20);

  let full;
  for (let i = 0; i < 3; i++) {
    a.send({ t: 'lobbyBotAdd', team: 'red' });
    await a.wait('lobby', (m) => m.bots.length === i * 2 + 1);
    a.send({ t: 'lobbyBotAdd', team: 'blue' });
    full = await a.wait('lobby', (m) => m.bots.length === i * 2 + 2);
  }
  assert.equal(full.validation?.ok, true);
  assert.equal(full.players.length + full.bots.length, 8);
  assert.equal(full.validation.counts.red, 4);
  assert.equal(full.validation.counts.blue, 4);
  b.send({ t: 'lobbyTeam', team: 'blue' });
  assert.equal((await b.wait('lobbyError')).code, 'team-full');
  a.send({ t: 'lobbyTeam', team: 'red' });
  const swapped = await a.wait('lobby', (m) =>
    m.bots.length === 6 && m.players.find((p) => p.id === aw.id)?.team === 'red');
  assert.equal(swapped.validation.counts.red, 4);
  assert.equal(swapped.validation.counts.blue, 4);
  assert.equal(swapped.bots.filter((bot) => bot.team === 'blue').length, 4);

  a.send({ t: 'lobbyStart' });
  const started = await a.wait('matchStart');
  assert.equal(started.settings.map, 'azoteas');
  assert.equal(started.players.filter((p) => p.bot).length, 6);
  await a.wait('start');

  const late = await client('LATE', 'join');
  assert.equal((await late.wait('lobbyError')).code, 'in-progress');
  late.ws.close();

  a.ws.close();
  const host = await b.wait('host');
  assert.equal(host.id, bw.id);
  b.ws.close();
  console.log('Lobby rules + two-client protocol: OK');
} finally {
  child.kill();
  await once(child, 'exit').catch(() => {});
}
