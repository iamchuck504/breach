// Retroceder y desplazarse de lado en primera persona: el cuerpo NO gira (sigue
// a la vista), el desplazamiento va hacia donde pide el stick y la zancada que
// ven los demás va al revés al retroceder / de lado al desplazarse.
// PRUEBAS (corrida 6, FPS): se retiraron "sprint hacia atrás/diagonal", "correr
// libre mira al rumbo" y el tope de giro de locomoción (turnMaxDeg): en FPS el
// sprint es solo hacia delante y el cuerpo sigue a la vista (check-fps-movement).
import assert from 'node:assert/strict';
import { Controller } from '../src/player/controller.js';

const world = { resolveCircle() {}, groundHeight() { return 0; }, raycast() { return null; }, findCover() { return null; } };
for (const yaw of [0, 1.2, -2.8]) {
  for (const aimHeld of [false, true]) for (const sprintHeld of [false, true]) {
    const cam = { yaw, pitch: 0, flatForward: () => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) }), flatRight: () => ({ x: Math.cos(yaw), z: -Math.sin(yaw) }) };
    const player = new Controller(world, cam);
    player.respawn({ x: 0, z: 0, yaw });
    const start = { ...player.pos };
    const input = { aimHeld, sprintHeld, moveVec: () => ({ x: 0, z: -1 }) };
    for (let i = 0; i < 120; i++) {
      player.update(1 / 60, input, false);
      assert.ok(Math.abs(Math.atan2(Math.sin(player.yaw - yaw), Math.cos(player.yaw - yaw))) < 1e-6, 'backpedal must not turn the body');
      // el sprint no existe hacia atrás: con Shift se sigue trotando
      if (i > 10) assert.equal(player.state, 'run', `retroceder con sprint=${sprintHeld} dio ${player.state}`);
    }
    const f = cam.flatForward(), r = cam.flatRight();
    assert.ok((player.pos.x - start.x) * f.x + (player.pos.z - start.z) * f.z < -1, 'backpedal must move backwards');
    assert.ok(player.animParams().moveForward < -0.99, 'reverse stride');
    const s0 = { ...player.pos };
    input.moveVec = () => ({ x: 1, z: 0 });
    for (let i = 0; i < 120; i++) player.update(1 / 60, input, false);
    assert.ok(Math.abs(Math.atan2(Math.sin(player.yaw - yaw), Math.cos(player.yaw - yaw))) < 1e-6, 'strafe keeps facing forward');
    assert.ok(player.animParams().moveSide > 0.99, 'side stride');
    assert.ok((player.pos.x - s0.x) * r.x + (player.pos.z - s0.z) * r.z > 1, 'strafe must move right');
    for (const x of [-Math.SQRT1_2, Math.SQRT1_2]) {
      input.moveVec = () => ({ x, z: -Math.SQRT1_2 });
      for (let i = 0; i < 120; i++) {
        player.update(1 / 60, input, false);
        assert.ok(Math.abs(Math.atan2(Math.sin(player.yaw - yaw), Math.cos(player.yaw - yaw))) < 1e-6, 'rear diagonal keeps facing');
        assert.equal(player.state, 'run');
      }
      assert.ok(player.animParams().moveForward < -0.6, 'rear diagonal stride goes back');
      assert.ok(Math.abs(player.animParams().moveSide) > 0.6, 'rear diagonal stride goes sideways');
    }
  }
}
console.log('Backpedal/strafe (FPS): body follows the view; displacement and stride go where the stick asks, for three headings, aim and sprint combinations.');
