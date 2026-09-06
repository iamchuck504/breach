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
      assert.notEqual(player.state, 'roadie', 'no backward sprint pose');
    }
    const f = cam.flatForward();
    assert.ok((player.pos.x - start.x) * f.x + (player.pos.z - start.z) * f.z < -1);
    assert.ok(player.animParams().moveForward < -0.99, 'reverse stride');
    input.moveVec = () => ({ x: 1, z: 0 });
    for (let i = 0; i < 120; i++) player.update(1 / 60, input, false);
    assert.ok(Math.abs(player.yaw - yaw) < 1e-6, 'strafe keeps facing forward');
    assert.ok(player.animParams().moveSide > 0.99);
  }
}
console.log('Backpedal/strafe: facing, displacement and gait pass for three camera headings, aim and sprint combinations.');
