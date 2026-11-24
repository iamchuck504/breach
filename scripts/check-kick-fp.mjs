// Recorre la entrada del jugador, el emisor de Weapons, el adaptador y los
// huesos dibujados. El único doble de juego es un suelo plano sin obstáculos.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FpAdapter } from '../src/view/fp/game-adapter.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import { Controller } from '../src/player/controller.js';
import { Weapons } from '../src/combat/weapons.js';
import { FirstPersonCamera, ShoulderCamera } from '../src/core/camera.js';
import { TUNING } from '../src/config/tuning.js';
import { meleeHitOk, meleeTargetPoint, MELEE_REACH } from '../src/combat/melee-reach.js';
import { kickWorldContact } from '../src/combat/kick-surface.js';

const assets = {};
for (const id of ['kick-leg', 'arms', ...Object.keys(PROFILES)]) {
  const bytes = await readFile(new URL('../public/assets/fp/' + id + '.glb', import.meta.url));
  assets[id] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
}
const world = { raycast: () => null, groundHeight: () => 0, resolveCircle() {} };
const camera = new PerspectiveCamera(72, 16 / 9);
const look = new ShoulderCamera(camera, world);
const G = {};
const view = new FpAdapter({ scene: new Scene(), camera, world, G }, assets);
await view.vm.ready;
const vm = view.vm;
const tuning = TUNING.melee;

function begin(dt) {
  const w = G.weapons = new Weapons();
  const p = G.player = new Controller(world, look, { onMeleeStart: () => w.noteMelee('start') });
  p.respawn({ x: 0, z: 0, yaw: 0 });
  G.protoStun = 0;
  const input = { moveVec: () => ({ x: 0, z: 0 }), meleePressed: true };
  view.update(dt, look, false);
  view.update(dt, look, true);
  let starts = 0;
  w.on('meleeStart', () => starts++);
  p.update(dt, input);
  input.meleePressed = false;
  view.update(dt, look, true);
  assert.equal(starts, 1);
  assert.equal(vm.anim.kick.phase, 'windup');
  return { p, w, input };
}

for (const hz of [30, 60, 144]) {
  const dt = 1 / hz;
  for (const result of ['aire', 'acierto', 'baja']) {
    const connected = result !== 'aire', killed = result === 'baja';
    const { p, w, input } = begin(dt);
    const phases = ['windup'];
    let hitFrame, visualFrame, endFrame, hitElapsed;
    const recovery = killed ? 0.30 : connected ? 0.26 : 0.52;
    // Posición de la bota que realmente dibuja el port en extensión completa.
    vm.leg.update('strike', 1 / 2.4);
    const contact = vm.leg.boot.position.clone();
    let frame = 0;
    w.on('meleeHit', () => { assert.equal(hitFrame, undefined); hitFrame = frame; });
    for (frame = 1; frame <= hz; frame++) {
      p.update(dt, input);
      if (p.state === 'melee' && hitFrame === undefined && p.meleeT >= tuning.hitAt) {
        hitElapsed = p.meleeT;
        p.confirmMelee(connected, killed);
        w.noteMelee('hit', { connected, killed });
      }
      view.update(dt, look, true);
      const { phase } = vm.anim.kick;
      if (phase !== phases.at(-1)) phases.push(phase);
      if (vm.leg.mesh.visible && contact.distanceTo(vm.leg.boot.position) < 1e-12) visualFrame ??= frame;
      if (frame === hitFrame) {
        assert.ok(contact.distanceTo(vm.leg.boot.position) < 1e-12);
        assert.equal(vm.anim.kick.leg.v > 0, connected);
        const paused = vm.leg.boot.matrixWorld.clone(), gun = vm.anim.out.gun.slice();
        for (let i = 0; i < 8; i++) view.update(0, look, true);
        assert.ok(vm.leg.boot.matrixWorld.equals(paused));
        assert.deepEqual(vm.anim.out.gun, gun);
      }
      if (p.state !== 'melee') {
        endFrame = frame;
        assert.equal(vm.leg.mesh.visible, false);
        assert.equal(p.meleeCd, 0.045);
        break;
      }
    }
    assert.deepEqual(phases, ['windup', 'strike', 'recover', 'idle']);
    assert.ok(Math.abs(hitFrame - visualFrame) <= 1);
    assert.ok(Math.abs(hitElapsed - 0.2) <= dt + 1e-10);
    const end = (connected ? hitElapsed : 0.2) + recovery;
    assert.ok(Math.abs(p.meleeEndT - end) < 1e-10);
    assert.ok(Math.abs(endFrame * dt - (end + (connected ? 0.035 : 0))) <= 2 * dt + 1e-9);
    console.log(hz + ' Hz ' + result + ' · contacto lógico/visual en cuadros ' + hitFrame + '/' + visualFrame);
  }
  for (const reason of ['muerte', 'aturdimiento', 'cambio', 'recogida']) {
    const { p, w } = begin(dt);
    p.meleeT = 0.16;
    view.update(dt, look, true);
    assert.ok(vm.leg.mesh.visible);
    if (reason === 'muerte') p.dead = true;
    if (reason === 'aturdimiento') G.protoStun = 0.45;
    if (reason === 'cambio') w.startSwap('pistol');
    if (reason === 'recogida') w.giveSpecial('sniper');
    view.update(dt, look, true);
    w.noteMelee('hit', { connected: true });
    for (let i = 0; i < hz; i++) view.update(dt, look, true);
    assert.equal(vm.leg.mesh.visible, false, reason);
    assert.equal(vm.anim.kick.leg.v, 0, reason);
  }
}

const eye = [0, 1.48, 0];
const volume = { hx: 0, hy: 1.52, hz: -1.8, hr: 0.22, ax: 0, ay: 0.7, az: -1.8, bx: 0, by: 1.1, bz: -1.8, br: 0.3 };
const point = meleeTargetPoint(eye, volume, 0).point;
assert.equal(MELEE_REACH, 1.95);
const centerAt = deg => [Math.sin(deg * Math.PI / 180), 0.9, -Math.cos(deg * Math.PI / 180)];
assert.ok(meleeHitOk(eye, 0, point, centerAt(57.99)));
assert.equal(meleeHitOk(eye, 0, point, centerAt(58.01)), false);
assert.equal(meleeHitOk(eye, 0, [0, eye[1], -1.951], centerAt(0)), false);
assert.deepEqual([tuning.dmg, tuning.tackleDmg, tuning.backstabDmg], [60, 80, 100]);
const wall = { raycastHit(origin, direction, reach) {
  assert.ok(Math.abs(origin.y - 0.93) < 1e-10);
  assert.ok(Math.abs(direction.y - Math.sin(0.5)) < 1e-10);
  assert.equal(reach, 1.6);
  return { t: 1, normal: new Vector3(0, 0, 1) };
} };
assert.ok(kickWorldContact(wall, new Vector3(...eye), new Vector3(0, 1, -0.01).normalize()).normal.z === 1);

function roll(shake, reduceMotion) {
  const cam = new PerspectiveCamera(72, 16 / 9), sc = new ShoulderCamera(cam, world);
  const fp = new FirstPersonCamera(cam, world, sc);
  const p = G.player;
  sc.pitch = 0; sc.yaw = 0;
  fp.meleeImpact(0.5);
  const opts = { pose: { st: 'melee' }, settings: { shake, reduceMotion } };
  fp.update(1 / 60, p, opts);
  assert.ok(cam.getWorldDirection(new Vector3()).distanceTo(new Vector3(0, 0, -1)) < 1e-12);
  const quat = cam.quaternion.clone(), pos = cam.position.clone();
  fp.update(0, p, opts);
  assert.ok(quat.equals(cam.quaternion) && pos.equals(cam.position));
  return cam.rotation.z;
}
const full = roll(1, false);
assert.ok(Math.abs(full) > 0.001);
assert.ok(Math.abs(roll(0.5, true) / full - 0.125) < 1e-9);
assert.equal(Math.abs(roll(0, false)), 0);
vm.dispose();
console.log('Patada FP · fases, reloj, cancelaciones, alcance, comodidad y eje óptico correctos');
