// Regresiones de cámara/cuerpo/disparo sin navegador. Ataca giros de 180°,
// alternancia rápida y el desfase de un frame que antes tenía aimRay().
import * as THREE from 'three';
import { ShoulderCamera } from '../src/core/camera.js';
import { Controller } from '../src/player/controller.js';
import { TUNING } from '../src/config/tuning.js';
import { Weapons } from '../src/combat/weapons.js';
import { requiredFireBuffer } from '../src/combat/fire-control.js';

const DT = 1 / 60;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const delta = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

const world = {
  findCover() { return null; },
  resolveCircle() {},
  groundHeight() { return 0; },
  raycast() { return null; },
};
const camera3d = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 100);
const camera = new ShoulderCamera(camera3d, world);
const player = new Controller(world, camera);
const input = {
  aimHeld: false, sprintHeld: false, jumpPressed: false, evadePressed: false,
  moveVec() { return { x: 0, z: 0 }; },
};

function putInLowCover() {
  player.respawn({ x: 0, z: 0.38, yaw: 0 });
  player.cover = {
    a: { x: -3, z: 0 }, b: { x: 3, z: 0 }, n: { x: 0, z: 1 }, h: 1.1,
  };
  player.state = 'cover';
  player.stateT = 0.5;
}

// aimRay debe responder al yaw/pitch actual aun antes del render/update.
camera.yaw = Math.PI * 0.5;
camera.pitch = 0.22;
const ray = camera.aimRay().dir;
const expected = new THREE.Vector3(-Math.cos(0.22), Math.sin(0.22), 0).normalize();
check(ray.dot(expected) > 0.999999,
  `aimRay conserva orientación vieja (dot=${ray.dot(expected)})`);

// Un 180° en blindfire no puede invertir el cuerpo en un frame.
putInLowCover();
camera.yaw = Math.PI;
const before = player.yaw;
player.update(DT, input, true);
const firstStep = Math.abs(delta(player.yaw, before));
const blindMax = TUNING.combat.bodyTurnBlindDeg * Math.PI / 180 * DT;
check(firstStep <= blindMax + 1e-8,
  `blindfire giró ${firstStep * 180 / Math.PI}° en un frame`);
check(!player.fireAligned(), '180° quedó habilitado para disparar de inmediato');

// El click/held queda disponible apenas cuerpo y arma entran en el margen.
let frames = 1;
while (!player.fireAligned() && frames < 120) {
  player.update(DT, input, true);
  frames++;
}
check(player.fireAligned(), 'blindfire nunca recuperó alineación');
check(frames >= 10 && frames <= 30,
  `alineación de 180° tardó ${frames} frames (debe ser progresiva y ágil)`);
check(Math.abs(player.animParams().aimYawErr) <=
  TUNING.combat.visualAimMaxDeg * Math.PI / 180 + 1e-8,
  'el arma excedió su compensación visual máxima');

// Alternar izquierda/derecha agresivamente nunca excede el límite angular.
putInLowCover();
for (let i = 0; i < 90; i++) {
  camera.yaw = i % 2 ? Math.PI * 0.9 : -Math.PI * 0.9;
  const y0 = player.yaw;
  player.update(DT, input, true);
  const step = Math.abs(delta(player.yaw, y0));
  check(step <= blindMax + 1e-8, `alternancia frame ${i}: salto de ${step}`);
}

// ADS usa el mismo contrato de alineación y una velocidad propia, sin snap.
putInLowCover();
camera.yaw = Math.PI;
input.aimHeld = true;
const adsBefore = player.yaw;
player.update(DT, input, true);
const adsStep = Math.abs(delta(player.yaw, adsBefore));
const adsMax = TUNING.combat.bodyTurnAimDeg * Math.PI / 180 * DT;
check(adsStep <= adsMax + 1e-8, `ADS hizo snap de ${adsStep}`);
check(!player.fireAligned(), 'ADS de 180° ignoró la coherencia cuerpo/cámara');

// Mantener fuego al soltar ADS debe activar blindfire en el mismo frame.
camera.yaw = player.yaw;
input.aimHeld = true;
player.update(DT, input, true);
check(player.aim, 'ADS no se activó en cover bajo');
input.aimHeld = false;
player.update(DT, input, true);
check(!player.aim && player.firingBlind > 0.69,
  'ADS -> blindfire heredó la orientación/pose del frame anterior');

// Un único click de escopeta a 180° debe sobrevivir hasta que blindfire se
// alinee; antes el buffer de 0.30 s expiraba apenas un frame demasiado pronto.
putInLowCover();
camera.yaw = Math.PI;
input.aimHeld = false;
const weapons = new Weapons();
weapons.cur = 'shotgun';
let firePressed = true;
let fireBuffer = 0;
let firedFrame = -1;
for (let i = 0; i < 60; i++) {
  let canFire = player.fireAligned();
  if (firePressed && (!canFire || weapons.st.cd > 0)) {
    fireBuffer = requiredFireBuffer(player, weapons.st, 0);
  }
  fireBuffer = Math.max(0, fireBuffer - DT);
  player.update(DT, input, fireBuffer > 0);
  canFire = player.fireAligned();
  const fired = weapons.update(DT, false, firePressed || fireBuffer > 0, canFire);
  if (fired) { firedFrame = i; break; }
  firePressed = false;
}
check(firedFrame >= 0 && weapons.st.mag === TUNING.weapons.shotgun.mag - 1,
  `click semiauto se perdió durante giro 180° (frame=${firedFrame}, mag=${weapons.st.mag})`);

if (failures.length) {
  for (const failure of failures) console.error('FALLO:', failure);
  process.exit(1);
}
console.log(`COMBAT ORIENTATION OK · 180° alineado en ${frames} frames · click en ${firedFrame}`);
