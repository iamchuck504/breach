// Reproduce el orden de simStep y la entrega FIFO sin sockets ni reloj de pared.
import assert from 'node:assert/strict';
import { Controller } from '../src/player/controller.js';
import { Weapons } from '../src/combat/weapons.js';
import { NetClient, localPose, dodgeEyeReady } from '../src/net/client.js';
import { eyeWorld, FPS_EYE_TOL, recordOwnPose, shotPose } from '../src/combat/hit-pose.js';
import { canFireInState } from '../src/combat/fire-gates.js';
import { TUNING } from '../src/config/tuning.js';
import * as guards from '../server/guards.js';

function rng(seed) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2**32;
}

function frameDuration(random, index) {
  const roll = random();
  if (roll < 0.12) return 0.4 + random() * 0.35;
  if (index % 4 === 0 || roll < (index % 2 ? 0.7 : 0.3)) return 0.1 + random() * 0.3;
  return (0.8 + random() * 0.4) / (index % 3 ? 60 : 30);
}

const world = { groundHeight: () => 0, resolveCircle() {}, raycast: () => null };
const interval = 60 / TUNING.weapons.smg.rpm;
const rejected = {};
const shots = { esquiva: 0, reaparición: 0, postura: 0 };

function sequence(kind, index) {
  const random = rng(1234 + index), jitter = rng(98765 + index);
  const cam = { yaw: 0, pitch: 0, flatForward: () => ({ x: 0, z: -1 }), flatRight: () => ({ x: 1, z: 0 }) };
  const player = new Controller(world, cam), weapons = new Weapons(), net = new NetClient();
  const spawn = { x: 0, z: 0, yaw: 0 };
  player.respawn(spawn);
  player.bindWeapons(weapons);
  weapons.online = net.connected = true;
  weapons.newLife(1);
  net.resetLife(player, 1);
  const input = { moveVec() { return { x: 0, z: this.evadePressed ? 1 : 0 }; } };
  let ct = 5, wall = 5, arrival = wall, count = 0, seenLife = 1;
  performance.now = () => wall * 1000;
  player.poseClock = () => ct;
  const entity = { fps: true, x: 0, y: 0, z: 0, st: 'idle' }, history = [];

  function reject(reason, packet, detail) {
    const key = kind + '/' + reason;
    if (!rejected[key]) console.log(key, JSON.stringify({ index, packet, detail }));
    rejected[key] = (rejected[key] || 0) + 1;
  }

  net.send = packet => {
    arrival = Math.max(arrival, wall + jitter() * 0.060);
    const s = packet.fs ?? packet;
    if (s.life > seenLife) {
      assert.equal(packet.t, 'fire', 'el primer mensaje de la vida debe ser el disparo');
      seenLife = s.life;
    }
    guards.noteMessageArrival(entity, arrival);
    guards.advanceCadenceClock(entity, s.ct, arrival);
    if (!guards.acceptMovement(entity, s, arrival)) return reject('movement', packet, entity.motionGuard);
    const posture = guards.acceptPosture(entity, s, arrival, s.ct);
    if (posture.st !== s.st || Math.abs(s.cl - posture.cl) > 1e-9 ||
        (s.st === 'crouch' && Math.abs(s.ce - posture.ce) > 1e-9)) reject('posture-clip', packet, posture);
    Object.assign(entity, { x: s.x, y: s.y, z: s.z, st: posture.st });
    recordOwnPose(history, { ...s, ...posture, at: arrival });
    if (packet.t !== 'fire') return;

    count++;
    shots[kind]++;
    const weapon = packet.w;
    if (!canFireInState(entity.st, weapon) || !guards.dodgeFireReady(entity, weapon))
      return reject('fire-state', packet, entity.motionGuard);
    const pose = shotPose(history, s.ts), eye = eyeWorld(pose, s.x, s.y, s.z, s.yaw);
    const error = Math.hypot(...eye.map((v, k) => v - packet.o[k]));
    if (error > FPS_EYE_TOL) return reject('fire-origin', packet, { error, since: pose.since });
    if (!guards.srvBurstAllows(entity, weapon, interval, arrival)) return reject('fire-burst', packet);
    if (!guards.fireCadenceAllows(entity, weapon, interval, entity.cclk, packet))
      return reject('fire-cadence', packet, { reason: entity.lastRejectReason, clock: entity.cclk, chain: entity.fireChain, bank: entity.cBank });
    guards.commitSrvBurst(entity, weapon, arrival);
    guards.commitFireCadence(entity, weapon, interval, entity.cclk, packet);
  };

  net.tickState(0.1, player, weapons, ct);
  if (kind === 'reaparición') {
    // La simulación sigue mientras el servidor espera la ola sin estados del muerto.
    const wait = 0.4 + 6 * random();
    ct += wait;
    wall += wait;
    player.respawn(spawn);
    weapons.newLife(2);
    weapons.reset();
    net.resetLife(player, 2);
    guards.resetMovementGuard(entity, wall);
    guards.resetPostureGuard(entity, wall);
    entity.cCt = undefined;
    history.length = 0;
  }
  let first = true;
  const start = ct;
  while (ct < start + 1.3) {
    const frame = frameDuration(random, index);
    wall += frame;
    for (let left = Math.min(0.1, frame); left > 1e-6;) {
      const dt = Math.min(left, 1 / 30);
      ct += dt;
      left -= dt;
      input.evadePressed = first && kind === 'esquiva';
      if (kind === 'postura') {
        const age = ct - start;
        input.crouchHeld = age >= 0.03 && age < 0.5;
        input.leanAxis = age < 0.3 ? 1 : age < 0.65 ? -1 : 0;
      }
      player.update(dt, input, true, left);
      const held = kind !== 'postura' || ct - start > 0.7;
      const ready = player.fireAligned() && dodgeEyeReady(player, ct);
      if (weapons.update(dt, held, false, ready, true, left)) {
        const pose = localPose(player, weapons.cur, ct);
        const [x, y, z] = eyeWorld(pose, player.pos.x, player.y, player.pos.z, player.yaw);
        const range = 10 * Math.cos(cam.pitch);
        const point = { x: x - range * Math.sin(player.yaw), y: y + 10 * Math.sin(cam.pitch), z: z - range * Math.cos(player.yaw) };
        net.fire({ x, y, z }, point, weapons.cur, [], player, { pose, t: ct, ae: 0 });
      }
      if (first && kind === 'reaparición') assert.equal(count, 1);
      net.tickState(dt, player, weapons, ct);
      first = false;
    }
    if (frame > 0.1) weapons.dropCadenceCredit();
  }
  assert.ok(count >= 2, [kind, index, count].join(' '));
}

for (let i = 0; i < 20000; i++) {
  for (const kind of Object.keys(shots)) sequence(kind, i);
}
console.log({ shots, rejected });
assert.deepEqual(rejected, {});
