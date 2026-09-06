import assert from 'node:assert/strict';
import { Controller } from '../src/player/controller.js';

const world = { resolveCircle() {}, groundHeight() { return 0; }, raycast() { return null; }, findCover() { return null; } };
for (const yaw of [0, 1.2, -2.8]) {
  for (const aimHeld of [false, true]) for (const sprintHeld of [false, true]) {
    const cam = { yaw, pitch: 0, flatForward: () => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) }), flatRight: () => ({ x: Math.cos(yaw), z: -Math.sin(yaw) }) };
    const player = new Controller(world, cam);
    player.yaw = yaw;
    const start = { ...player.pos };
    const input = { aimHeld, sprintHeld, moveVec: () => ({ x: 0, z: -1 }) };
    for (let i = 0; i < 120; i++) {
      player.update(1 / 60, input, false);
      assert.ok(Math.abs(player.yaw - yaw) < 1e-6, 'backpedal must not turn the body');
      if (i > 10) assert.equal(player.state, sprintHeld && !aimHeld ? 'roadie' : 'run');
    }
    const f = cam.flatForward();
    assert.ok((player.pos.x - start.x) * f.x + (player.pos.z - start.z) * f.z < -1);
    assert.ok(player.animParams().moveForward < -0.99, 'reverse stride');
    input.moveVec = () => ({ x: 1, z: 0 });
    for (let i = 0; i < 120; i++) player.update(1 / 60, input, false);
    if (aimHeld) {
      assert.ok(Math.abs(player.yaw - yaw) < 1e-6, 'aim keeps facing forward');
      assert.ok(player.animParams().moveSide > 0.99);
    } else assert.ok(player.animParams().moveForward > 0.99, 'free run faces travel');
    for (const x of [-Math.SQRT1_2, Math.SQRT1_2]) {
      input.moveVec = () => ({ x, z: -Math.SQRT1_2 });
      for (let i = 0; i < 120; i++) {
        player.update(1 / 60, input, false);
        if (aimHeld) assert.ok(Math.abs(player.yaw - yaw) < 1e-6);
        assert.equal(player.state, sprintHeld && !aimHeld ? 'roadie' : 'run');
      }
      if (aimHeld) {
        assert.ok(player.animParams().moveForward < -0.7);
        assert.ok(Math.abs(player.animParams().moveSide) > 0.7);
      } else {
        assert.ok(player.animParams().moveForward > 0.99, 'diagonal uses forward running stride');
        const r = cam.flatRight();
        const expected = Math.atan2(-(f.x * -Math.SQRT1_2 + r.x * x), -(f.z * -Math.SQRT1_2 + r.z * x));
        assert.ok(Math.abs(Math.atan2(Math.sin(player.yaw - expected), Math.cos(player.yaw - expected))) < 0.01);
      }
      if (sprintHeld && !aimHeld) assert.ok(player.animParams().speed > 0.99, 'diagonal maintains sprint speed');
    }
    input.moveVec = () => ({ x: 0.03, z: -1 });
    for (let i = 0; i < 180; i++) player.update(1 / 60, input, false);
    assert.ok(Math.abs(Math.atan2(Math.sin(player.yaw - yaw), Math.cos(player.yaw - yaw))) < 0.01, 'return to straight back tolerates stick drift');
  }
}
console.log('Backpedal/strafe: facing, displacement and gait pass for three camera headings, aim and sprint combinations.');
for (const fps of [30, 60, 144]) {
  const cam = { yaw: 0, pitch: 0, flatForward: () => ({ x: 0, z: -1 }), flatRight: () => ({ x: 1, z: 0 }) };
  for (const sprintHeld of [false, true]) {
    const player = new Controller(world, cam);
    for (const x of [0, 0.7, -0.7, 0, -0.7, 0.7, 0]) {
      const input = { sprintHeld, moveVec: () => ({ x, z: -Math.sqrt(1 - x * x) }) };
      for (let frame = 0; frame < fps; frame++) {
        const previous = player.yaw;
        player.update(1 / fps, input, false);
        const step = Math.abs(Math.atan2(Math.sin(player.yaw - previous), Math.cos(player.yaw - previous)));
        assert.ok(step <= 240 * Math.PI / 180 / fps + 1e-9, 'no abrupt locomotion turn');
      }
    }
  }
}
console.log('Turn-rate regression: alternating rear diagonals and straight back pass at 30/60/144 fps.');
