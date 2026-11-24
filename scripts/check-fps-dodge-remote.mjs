// Reproducción a tiempo virtual, incluidos el relevo de estado y la entrega TCP
// en ráfaga. Se comprueba cada cuadro contra su tramo de la integral.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RemotePlayer } from '../src/player/remote.js';
import { Rig } from '../src/player/rig.js';
import { attachBlenderSoldier } from '../src/player/blender-soldier.js';
import { hitPose, placeHitPose } from '../src/combat/hit-pose.js';
import { TUNING } from '../src/config/tuning.js';
import { dodgeDistance } from '../src/player/dodge.js';
import { Effects } from '../src/fx/effects.js';
import { Audio } from '../src/fx/audio.js';
import { Bot, BotMatch } from '../src/game/botmatch.js';
import { NetClient } from '../src/net/client.js';

const D = TUNING.dodge.duration, tick = 1 / TUNING.net.sendHz;
const bare = { setProtected() {}, setWeapon() {}, setTransform() {}, update() {} };
const events = ['start', 'trail', 'trail', 'trail', 'brake'];
const idle = { st: 'idle', x: 0, z: 0, y: 0, yaw: 0, ce: 1 };
GLTFLoader.prototype.loadAsync = async function (url) {
  const bytes = await readFile(new URL('../public' + url, import.meta.url));
  return this.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
};
const rig = new Rig(new THREE.Scene(), 'red');
await attachBlenderSoldier(rig);
const mesh = rig._bodyMesh, indices = [];
const skin = mesh.geometry.attributes.skinIndex, bones = mesh.skeleton.bones;
for (let i = 0; i < skin.count; i++) {
  for (let n = bones[skin.getX(i)]; n && n !== rig.root; n = n.parent) {
    if (n === rig.head) { indices.push(i); break; }
  }
}
assert.ok(indices.length);
function helmet() {
  rig.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3(), visor = new THREE.Vector3(), v = new THREE.Vector3();
  let count = 0;
  for (const i of indices) {
    mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
    bounds.expandByPoint(v);
    if (bones[skin.getX(i)] === rig.head) { visor.add(v); count++; }
  }
  return bounds.getCenter(v).lerp(visor.divideScalar(count), 0.5);
}
const maxStep = {}, world = { resolveCircle() {}, groundHeight: () => 0, raycast: () => null };
let maxHead = 0;
for (const hz of [30, 60, 144]) {
  const dt = 1 / hz;
  maxStep[hz] = 0;
  for (let seed = 0; seed < 32; seed++) {
    const rendered = seed < 12, side = seed % 2 ? -1 : 1;
    const yaw = [0, Math.PI / 2, Math.PI / 4][Math.floor(seed / 4) % 3];
    const wall = seed % 4 === 3 ? 1.6 : Infinity;
    const remote = new RemotePlayer(null, 'r', '', 'red', 0, rendered ? rig : bare);
    const cues = [];
    remote.onDodgeCue = (kind, x) => cues.push([kind, x]);
    let rand = seed + 1, arrival = 0, start, anchor, brace = false;
    let peak = 0, shoulderPush = 0, shoulderBrake = 0;
    const queue = [];
    for (let i = 0; i < 40; i++) {
      const ct = i * tick + 0.022, age = ct - 0.63;
      const s = { ...idle, ct, yaw, x: side * Math.min(wall, dodgeDistance(age)) };
      if (age > 0 && age < D) Object.assign(s, { st: 'dodge', dg: age, da: side > 0 ? 0 : Math.PI, ox: 0, oz: 0 });
      rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0;
      arrival = Math.max(arrival, ct + rand / 2 ** 32 * 0.060);
      queue.push({ s, arrival });
    }
    for (let frame = 0; frame < hz * 1.6; frame++) {
      const now = frame * dt, t = now - TUNING.net.interpDelay;
      while (queue[0]?.arrival <= now) {
        const q = queue.shift();
        remote.push(q.s, q.arrival);
        if (q.s.st === 'dodge') {
          start ??= remote.buf.at(-1).dash.start;
          remote.push(q.s, q.arrival + 0.0001);
        }
      }
      const prev = remote.x;
      remote.update(dt, null, now);
      if (remote.anim.dodgeBrace > 0 && remote.x === 0) brace = true;
      if (Number.isFinite(start)) {
        const age = t - start, dx = (remote.x - prev) * side;
        const expected = dodgeDistance(age) - dodgeDistance(age - dt);
        assert.ok(dx >= -1e-7 && dx <= expected * 1.15 + 1e-6,
          `paso ${dx} / curva ${expected}, ${hz} Hz, fase ${age}`);
        if (wall === Infinity) assert.ok(Math.abs(remote.x * side - dodgeDistance(age)) < 1e-6);
        peak = Math.max(peak, dx);
      }
      if (rendered && now > 0.5) {
        if (yaw === 0 && remote.anim.state === 'dodge') {
          const lean = -side * rig.torso.rotation.z;
          if (remote.dodgePhase < 0.6) shoulderPush = Math.max(shoulderPush, lean);
          if (remote.dodgePhase > 0.7) shoulderBrake = Math.max(shoulderBrake, -lean);
        }
        const vol = placeHitPose(hitPose(remote.hitPoseInput()), remote.x, remote.y, remote.z, remote.yaw);
        const target = new THREE.Vector3(vol.hx, vol.hy, vol.hz);
        const h = helmet();
        anchor ??= target.clone().sub(h);
        const error = h.add(anchor).distanceTo(target);
        maxHead = Math.max(maxHead, error);
        assert.ok(error <= 0.021, `casco ${error} m, ${hz} Hz, fase ${now-start-TUNING.net.interpDelay}`);
      }
    }
    assert.ok(brace, 'preparación antes de mover la raíz');
    if (rendered && yaw === 0) {
      assert.ok(shoulderPush > 0.30 && shoulderBrake > 0.08, 'el hombro marca impulso y frenada');
    }
    assert.deepEqual(cues.map(e => e[0]), events);
    assert.equal(cues[0][1], 0);
    assert.ok(Math.abs(cues.at(-1)[1] * side - Math.min(wall, 3.3)) < 1e-6);
    maxStep[hz] = Math.max(maxStep[hz], peak);
  }
}

// El cliente y el servidor emiten a 20 Hz con relojes independientes. Una
// entrega en ráfaga puede eliminar una muestra entera al difundir la última.
for (const hz of [30, 60, 144]) for (let seed = 1; seed <= 32; seed++) {
  let state = seed;
  const jitter = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 0.06;
  const r = new RemotePlayer(null, 'r', '', 'red', 0, bare);
  r.world = world;
  const uplink = [], downlink = [];
  const dt = 1 / hz, startCt = 0.489;
  let last, sent = 0, arrived = 0, start;
  for (let i = 0; i < 40; i++) {
    const ct = i * tick, age = ct - startCt, dodging = age >= 0 && age < D;
    // Viene corriendo y gira 90 grados al frenar.
    const s = { ...idle, ct: age < 0 ? undefined : ct, sp: +(3 / TUNING.move.roadieSpeed).toFixed(2),
      x: age < 0 ? age * 3 : dodgeDistance(age),
      z: Math.max(0, age - D) * 3, st: dodging ? 'dodge' : 'run' };
    if (dodging) Object.assign(s, { ox: 0, oz: 0, da: 0, dg: age });
    uplink.push({ at: sent = Math.max(sent, ct + jitter()), s });
  }
  for (let i = 0; i < 40; i++) {
    const tickAt = i * tick + 0.013;
    while (uplink[0]?.at <= tickAt) last = uplink.shift().s;
    if (last) downlink.push({ at: arrived = Math.max(arrived, tickAt + jitter()), s: last });
  }
  for (let i = 0; i < hz * 1.5; i++) {
    const now = i * dt;
    while (downlink[0]?.at <= now) {
      const q = downlink.shift();
      r.push(q.s, q.at);
      if (q.s.st === 'dodge') start ??= r.buf.at(-1).dash.start;
    }
    const x = r.x, z = r.z;
    r.update(dt, null, now);
    const age = now - TUNING.net.interpDelay - start;
    if (age >= dt && age < D) {
      assert.ok(Math.abs(r.x - dodgeDistance(age)) < 0.002 && Math.abs(r.z) < 0.002);
    }
    if (age >= 0 && age <= D + 0.08) {
      const expected = dodgeDistance(age) - dodgeDistance(age - dt) +
        3 * (Math.max(0, dt - age) + Math.min(dt, Math.max(0, age - D)));
      assert.ok(Math.hypot(r.x - x, r.z - z) <= 1.15 * expected + 0.001,
        `enlace con la carrera: ${hz} Hz, semilla ${seed}, fase ${age}`);
    }
  }
}

// Anfitrión y segundo cliente, bot real y formato de botState del anfitrión.
const bot = new Bot(new THREE.Scene(), world, 'b', '', 'red', { x: 0, z: 0, yaw: 0 });
bot.rig = rig;
rig.setTransform(0, 0, 0, 0);
const net = new NetClient(), remote = new RemotePlayer(null, 'b', '', 'red', 0, bare);
const localCues = [], hostedCues = [];
remote.onDodgeCue = k => hostedCues.push(k);
const match = Object.assign(Object.create(BotMatch.prototype), {
  bots: [bot], cb: { onDodgeCue: k => localCues.push(k) }, _clock: 0,
});
let botAnchor;
net.connected = true;
net.send = packet => remote.push(packet.bots[0], match._clock);
for (let i = 0; i < 150; i++) {
  const dt = 1 / 60;
  match._clock = bot.simTime = i * dt;
  if (i === 61) bot.dodgePrep = { t: 0, x: 1, z: 0, wait: 0.05 };
  const prev = bot.pos.x;
  const active = bot._stepDodge(dt, match);
  const pose = match._botPose(bot);
  if (!active) {
    const params = bot._rigParams('idle', dt);
    rig.update(dt, { ...params, interpolated: true, poseTr: pose.from ? pose : null });
  }
  if (i >= 50) {
    const vol = placeHitPose(hitPose(pose), bot.pos.x, bot.y, bot.pos.z, bot.yaw);
    const target = new THREE.Vector3(vol.hx, vol.hy, vol.hz), h = helmet();
    botAnchor ??= target.clone().sub(h);
    const error = h.add(botAnchor).distanceTo(target);
    maxHead = Math.max(maxHead, error);
    assert.ok(error <= 0.021, `casco del anfitrión: ${error} m, cuadro ${i}`);
  }
  assert.ok(bot.pos.x - prev <= dodgeDistance(dt) + 1e-6);
  if (bot.dodgePrep) assert.equal(bot.pos.x, 0);
  net.tickBotState(dt, [bot]);
  remote.update(dt, null, match._clock);
}
assert.deepEqual(localCues, events);
assert.deepEqual(hostedCues, events);
assert.ok(Math.abs(remote.x - 3.3) < 0.001);

// Ocho soldados, 80 ciclos: el mismo material, geometría y reserva física.
const scene = new THREE.Scene(), fx = new Effects(scene);
const pool = fx.sprites, data = pool.data.slice(), nodes = scene.children.length;
const schedule = [];
for (let cycle = 0; cycle < 80; cycle++) {
  for (let actor = 0; actor < 8; actor++) {
    for (const [j, at] of [0, 0.045, 0.100, 0.155, D].entries()) {
      schedule.push({ actor, at: (cycle + actor / 8) * (D + TUNING.dodge.cooldown) + at, kind: events[j] });
    }
  }
}
assert.equal(pool.mesh.geometry.instanceCount, 0);
for (const kind of ['start', 'trail', 'brake']) {
  fx.dodgeCue(kind, 0, 0, 0, 1, 0);
  fx.update(1 / 60);
  const count = pool.mesh.geometry.instanceCount;
  assert.equal(count, kind === 'trail' ? 1 : 3);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    assert.equal(pool.data[5][o], 0, 'sin mezcla aditiva');
    assert.equal(pool.data[5][o + 1], 0, 'sin núcleo brillante');
    if (kind === 'trail') assert.ok(pool.data[0][o] < 0 && pool.data[1][o] < 0);
    else assert.ok(pool.data[0][o + 1] < 0.15, 'polvo a la altura de la bota');
  }
  fx.update(0.25 - 1 / 60);
  assert.equal(pool.mesh.geometry.instanceCount, 0, 'la señal se disipa en un cuarto de segundo');
}
const startClock = fx.clock;
for (const { actor, at, kind } of schedule.sort((a, b) => a.at - b.at)) {
  fx.update(startClock + at - fx.clock);
  fx.dodgeCue(kind, actor, 0, 2, 1, 0);
  fx.update(0);
  assert.ok(pool.mesh.geometry.instanceCount > 0 && pool.mesh.geometry.instanceCount <= pool.limit);
  assert.equal(pool.data[5][pool.o], 0, 'polvo mate');
}
assert.equal(pool.mesh.material.depthTest, true);
fx.update(1);
assert.equal(pool.mesh.geometry.instanceCount, 0);
assert.equal(scene.children.length, nodes);
data.forEach((a, i) => assert.equal(pool.data[i], a));
const audio = Object.create(Audio.prototype), sounds = [];
audio.engine = {}; audio.ctx = { currentTime: 1 };
audio.setSpatialContext(() => ({ x: 0, y: 1.6, z: 0, team: 'red' }));
audio._play = (key, opts) => { sounds.push({ key, ...opts }); return true; };
for (const team of ['red', 'blue']) audio.footstep('dodge', { position: { x: 8, y: 0.22, z: 0 }, team });
assert.deepEqual(sounds.map(s => s.key), ['dodge_step', 'dodge_step']);
assert.ok(sounds[0].volume < sounds[1].volume && sounds[0].cut < sounds[1].cut && sounds[1].mix.pan > 0);
console.log('ESQUIVA REMOTA OK', { maxStep, cascoCm: maxHead * 100, ciclos: 8 * 80 });
