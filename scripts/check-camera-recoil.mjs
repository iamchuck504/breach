import { strict as assert } from 'node:assert';
import * as THREE from 'three';
import { ShoulderCamera } from '../src/core/camera.js';
import { TUNING } from '../src/config/tuning.js';

const view = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 300);
const world = { raycast: () => null };
const cam = new ShoulderCamera(view, world);
const baseline = -0.2;
cam.pitch = baseline;

cam.addPitchRecoil(0.04);
assert(cam.pitch > baseline, 'el disparo debe elevar el pitch');
assert(cam.pitchRecoil > 0, 'el recoil debe registrar una deuda recuperable');
const kicked = cam.pitch;
cam.recoverPitchRecoil(1 / 60);
assert(cam.pitch < kicked, 'la recuperación debe comenzar en el siguiente frame');

for (let i = 0; i < 90; i++) cam.recoverPitchRecoil(1 / 60);
assert(Math.abs(cam.pitch - baseline) < 0.0002,
  `el pitch no volvió a su base: ${cam.pitch} vs ${baseline}`);
assert.equal(cam.pitchRecoil, 0, 'la deuda debe terminar limpia');

cam.pitch = baseline;
cam.addPitchRecoil(2 * Math.PI / 180);
const debt = cam.pitchRecoil;
cam.applyMouse(0, 30, false);
assert(cam.pitchRecoil < debt,
  'compensar hacia abajo debe consumir recuperación pendiente');
for (let i = 0; i < 90; i++) cam.recoverPitchRecoil(1 / 60);
assert(cam.pitchRecoil === 0, 'la compensación manual no debe dejar deuda latente');

cam.pitch = baseline;
cam.clearPitchRecoil();
for (let i = 0; i < 20; i++) cam.addPitchRecoil(1);
assert(cam.pitchRecoil <= TUNING.cam.pitchRecoilMaxDeg * Math.PI / 180 + 1e-8,
  'el recoil automático no debe acumular pitch sin límite');

console.log('CAMERA RECOIL OK · retorno · compensación manual · acumulación limitada');
