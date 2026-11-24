// Holgura corporal de fachadas altas (bodyStandOff): el cuerpo no se apoya
// dentro de la envolvente del muro y la holgura cede SIN tirones.
// PRUEBAS (corrida 6, FPS): se retiró "deslizarse a la cobertura llega en
// 30/60/144 FPS" (no hay slide a cobertura ni cobertura pegada) y la exención
// de la cara de entrada (el único llamador pasa null: código muerto para el
// juego). Lo que queda: la envolvente (resolveFacadeBody) y, nuevo, el tope de
// 3.5 m/s del empuje de fachada en el controlador, a 30/60/144 FPS.
import assert from 'node:assert/strict';
import { Controller, PLAYER_R } from '../src/player/controller.js';
import { World } from '../src/world/world.js';

for (const standOff of [PLAYER_R, 1.20]) for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
  const w = Object.create(World.prototype);
  const collider = { minx: 0, maxx: 3, minz: -5, maxz: 5, h: 3 };
  const face = { a: { x: 0, z: -5 }, b: { x: 0, z: 5 }, n: { x: -1, z: 0 }, h: 3, topY: 3, kind: 'high', collider, standOff, bodyStandOff: 1.28 };
  w.colliders = [collider]; w.segmentColliders = []; w.faces = [face]; w.surfaceZones = [];
  w.groundHeight = () => 0; w.ceilingHeight = () => Infinity; w.raycast = () => null;
  // el movimiento libre respeta la envolvente del cuerpo
  const probe = { x: -0.5, z: 0 }; w.resolveFacadeBody(probe, PLAYER_R, 0); assert.equal(probe.x, -1.28);
  // jugador que aparece dentro de la holgura (0.5 m del muro): el controlador lo
  // saca hasta la envolvente a ≤3.5 m/s, sin un salto de un cuadro
  const camera = { yaw: -Math.PI / 2, pitch: 0, flatForward: () => ({ x: 1, z: 0 }), flatRight: () => ({ x: 0, z: 1 }) };
  const p = new Controller(w, camera);
  p.respawn({ x: -0.5, z: 0, yaw: -Math.PI / 2 });
  const input = { moveVec: () => ({ x: 0, z: 0 }), aimHeld: false, sprintHeld: false, jumpPressed: false, meleePressed: false, crouchHeld: false };
  let maxStep = 0, t = 0, prev = p.pos.x;
  while (t < 1) { p.update(dt, input, false); maxStep = Math.max(maxStep, Math.abs(p.pos.x - prev)); prev = p.pos.x; t += dt; }
  assert.ok(maxStep <= 3.5 * dt + 1e-9, `empuje de fachada con tirón: ${(maxStep / dt).toFixed(2)} m/s a dt=${dt.toFixed(4)}`);
  assert.ok(Math.abs(p.pos.x + 1.28) < 1e-6, `no llegó a la envolvente: x=${p.pos.x} (dt=${dt.toFixed(4)})`);
  // andar contra el muro: la holgura no es sólida (cede a 3.5 m/s, controller.js),
  // así que se exige estabilidad y no atravesar el colisionador real
  const push = { ...input, moveVec: () => ({ x: 0, z: 1 }) };
  const xs = [];
  for (let i = 0; i < Math.round(2 / dt); i++) { p.update(dt, push, false); xs.push(p.pos.x); } // 2 s: la holgura cede a 4.8−3.5 m/s
  const tail = xs.slice(-Math.round(0.25 / dt));
  assert.ok(Math.max(...tail) - Math.min(...tail) < 1e-3, `temblor contra la fachada (dt=${dt.toFixed(4)})`);
  assert.ok(Math.max(...tail) <= -PLAYER_R + 1e-6, `atravesó el colisionador del muro (x=${Math.max(...tail)})`);
}
console.log('FACADE BODY OK: body envelope kept, facade push capped at 3.5 m/s and stable at 30/60/144 FPS');
