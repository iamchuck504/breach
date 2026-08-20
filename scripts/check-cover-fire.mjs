import * as THREE from 'three';
import { World, BLOCK } from '../src/world/world.js';
import { Rig } from '../src/player/rig.js';
import { Controller } from '../src/player/controller.js';
import { TUNING } from '../src/config/tuning.js';
import { coverAimPose, coverBlindPose, coverTopY, muzzleHasClearance,
  segmentsHaveClearance } from '../src/combat/cover-fire.js';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// Altura táctica y altura mundial no son lo mismo sobre una plataforma.
const railMeta = { kind: 'railing', h: BLOCK.LOW, baseY: BLOCK.LOW,
  topY: BLOCK.LOW * 2, collider: {} };
check(Math.abs(coverTopY(railMeta) - BLOCK.LOW * 2) < 0.001,
  `altura mundial del barandal incorrecta (${coverTopY(railMeta)})`);
check(Math.abs(coverTopY({ kind: 'low', h: BLOCK.LOW }, 0) - BLOCK.LOW) < 0.001,
  'cover bajo perdió su altura mundial');

const poseFlat = coverAimPose({ kind: 'low', h: BLOCK.LOW }, 0, 1);
const poseDown = coverAimPose({ kind: 'railing', h: BLOCK.LOW }, -0.3, 1);
check(poseFlat.hipsY > 0.6, 'ADS bajo no expone parcialmente al personaje');
check(poseDown.aimRigY > poseFlat.aimRigY,
  'barandal apuntando abajo no eleva hombros/arma');
check(coverBlindPose({ kind: 'railing' }, -0.3).aimRigY > 0.6,
  'blindfire descendente no eleva el arma sobre el barandal');

// Transición protegida -> expuesta -> protegida: el gatillo espera la pose,
// pero soltar ADS recupera cover sin un cooldown artificial.
const ctrlWorld = {
  groundHeight: () => 0, resolveCircle() {}, findCover: () => null,
  raycast: () => null,
};
const ctrlCam = {
  yaw: 0, pitch: 0, flatForward: () => ({ x: 0, z: -1 }),
  flatRight: () => ({ x: 1, z: 0 }),
};
const controller = new Controller(ctrlWorld, ctrlCam);
controller.respawn({ x: 0, z: 0.83, yaw: 0 });
controller.cover = { kind: 'low', h: BLOCK.LOW, n: { x: 0, z: 1 },
  a: { x: -2, z: 0.45 }, b: { x: 2, z: 0.45 } };
controller.state = 'cover';
const ctrlInput = {
  aimHeld: true, sprintHeld: false, jumpPressed: false, evadePressed: false,
  moveVec: () => ({ x: 0, z: 0 }),
};
controller.update(1 / 60, ctrlInput, false);
check(!controller.fireAligned(), 'cover bajo permitió disparar antes de asomarse');
for (let i = 1; i < 9; i++) controller.update(1 / 60, ctrlInput, false);
check(controller.coverAimExposure >= 0.82 && controller.fireAligned(),
  `ADS no recuperó línea de fuego a tiempo (${controller.coverAimExposure})`);
ctrlInput.aimHeld = false;
for (let i = 0; i < 9; i++) controller.update(1 / 60, ctrlInput, false);
check(controller.coverAimExposure < 0.04,
  `soltar ADS no regresó rápido a protección (${controller.coverAimExposure})`);

// La locomoción descendente inclina el root de forma progresiva; así el torso
// y los pies acompañan la pendiente en lugar de permanecer verticales.
{
  const slopeRig = new Rig(new THREE.Scene(), 'red');
  for (let i = 0; i < 12; i++) slopeRig.update(1 / 60, {
    state: 'run', speed: 0.75, aim: false, aimPitch: 0, twist: 0,
    groundPitch: -0.2,
  });
  check(slopeRig.root.rotation.x < -0.09,
    `rig no acompañó pendiente descendente (${slopeRig.root.rotation.x})`);
  slopeRig.dispose(slopeRig.root.parent);
}

function contextualBlind(h, x, yaw) {
  const cam = {
    yaw, pitch: 0,
    flatForward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; },
    flatRight() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; },
  };
  const c = new Controller(ctrlWorld, cam);
  c.respawn({ x, z: 0.83, yaw: Math.PI });
  c.cover = { kind: h < 1.5 ? 'low' : 'high', h, n: { x: 0, z: 1 },
    a: { x: -2, z: 0.45 }, b: { x: 2, z: 0.45 }, collider: {} };
  c.state = 'cover';
  cam.yaw = yaw;
  for (let i = 0; i < 20; i++) c.update(1 / 60, ctrlInput, true);
  return c;
}

const lowCenter = contextualBlind(BLOCK.LOW, 0, 0);
const lowLeft = contextualBlind(BLOCK.LOW, -1.73, Math.PI / 4);
const lowRight = contextualBlind(BLOCK.LOW, 1.73, -Math.PI / 4);
const highCenter = contextualBlind(BLOCK.MID, 0, 0);
const highLeft = contextualBlind(BLOCK.MID, -1.73, Math.PI / 4);
const highRight = contextualBlind(BLOCK.MID, 1.73, -Math.PI / 4);
check(lowCenter.animState() === 'blind_over', 'centro de cover bajo no eligió blindfire superior');
check(lowLeft.animState() === 'blind_low_left' && lowRight.animState() === 'blind_low_right',
  `orillas bajas no se espejaron (${lowLeft.animState()}/${lowRight.animState()})`);
check(highCenter.blindMode === null && highCenter.animState() === 'cover_high',
  'centro de cover alto inventó una línea de fuego imposible');
check(highLeft.animState() === 'blind_high_left' && highRight.animState() === 'blind_high_right',
  `orillas altas no se espejaron (${highLeft.animState()}/${highRight.animState()})`);
check(lowCenter.blindPoseExposure > 0.76 && highLeft.blindPoseExposure > 0.76,
  'blindfire válido no terminó su transición de pose');

function checkRigClearance(kind, pitch, weapon, elevated = false, blind = false) {
  const testScene = new THREE.Scene();
  const rig = new Rig(testScene, 'red');
  rig.setWeapon(weapon);
  const baseY = elevated ? BLOCK.LOW : 0;
  const collider = elevated
    ? { a: { x: -2, z: 0 }, b: { x: 2, z: 0 }, n: { x: 0, z: 1 }, half: 0.08,
      h: BLOCK.LOW * 2, surface: 'metal' }
    : { minx: -2, maxx: 2, minz: -0.45, maxz: 0.45, h: BLOCK.LOW, surface: 'concrete' };
  const world = Object.create(World.prototype);
  world.layout = elevated ? 'azoteas' : 'fortaleza';
  world.colliders = elevated ? [] : [collider];
  world.segmentColliders = elevated ? [collider] : [];
  world.surfaceZones = [];
  const face = { kind, h: BLOCK.LOW, collider,
    topY: baseY + BLOCK.LOW, baseY };
  const z = elevated ? 0.46 : 0.83;
  rig.setTransform(0, z, 0, baseY);
  for (let i = 0; i < 45; i++) {
    rig.update(1 / 60, { state: blind ? 'blind_over' : 'cover_low', speed: 0, aim: !blind,
      aimPitch: pitch, aimYawErr: 0, coverAimExposure: 1, coverKind: kind,
      firing: blind, coverLean: 0, latMove: 0 });
  }
  rig.root.updateWorldMatrix(true, true);
  const muzzle = rig.muzzleWorld(new THREE.Vector3());
  const weaponRoot = rig.gunMount.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch)).normalize();
  check(muzzleHasClearance(world, face, weaponRoot, muzzle, dir),
    `${kind}/${weapon}/${blind ? 'blind' : 'ADS'}/pitch ${pitch}: pose sigue atravesando su cover`);
}

function checkSideRig(low, side, weapon) {
  const h = low ? BLOCK.LOW : BLOCK.MID;
  const state = `blind_${low ? 'low' : 'high'}_${side < 0 ? 'left' : 'right'}`;
  const yaw = side < 0 ? Math.PI / 4 : -Math.PI / 4;
  const rig = new Rig(new THREE.Scene(), 'red');
  rig.setWeapon(weapon);
  rig.setTransform(side * 1.73, 0.83, yaw, 0);
  for (let i = 0; i < 50; i++) rig.update(1 / 60, {
    state, speed: 0, aim: false, aimPitch: 0, aimYawErr: 0, firing: true,
  });
  rig.root.updateWorldMatrix(true, true);
  const collider = { minx: -2, maxx: 2, minz: -0.45, maxz: 0.45,
    h, surface: 'concrete' };
  const world = Object.create(World.prototype);
  Object.assign(world, { layout: 'fortaleza', colliders: [collider],
    segmentColliders: [], surfaceZones: [] });
  const muzzle = rig.muzzleWorld(new THREE.Vector3());
  const root = rig.gunMount.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const segments = [];
  for (const arm of [rig.armL, rig.armR]) {
    const shoulder = arm.shoulder.getWorldPosition(new THREE.Vector3());
    const elbow = arm.elbow.getWorldPosition(new THREE.Vector3());
    const hand = arm.hand.getWorldPosition(new THREE.Vector3());
    segments.push([shoulder, elbow], [elbow, hand]);
  }
  check(muzzleHasClearance(world, { collider }, root, muzzle, dir),
    `${state}/${weapon}: arma atraviesa la esquina`);
  check(segmentsHaveClearance(world, segments),
    `${state}/${weapon}: brazos atraviesan la esquina`);
  if (low) {
    const head = rig.head.getWorldPosition(new THREE.Vector3());
    check(head.y + 0.34 <= BLOCK.LOW + 0.001,
      `${state}: cabeza expuesta en blindfire bajo (${head.y + 0.34})`);
  }
}

for (const weapon of ['smg', 'shotgun']) {
  checkRigClearance('low', 0, weapon);
  checkRigClearance('low', -0.18, weapon);
  checkRigClearance('low', 0.35, weapon);
  checkRigClearance('railing', 0, weapon, true);
  checkRigClearance('railing', -0.30, weapon, true);
  checkRigClearance('low', 0, weapon, false, true);
  checkRigClearance('low', -0.18, weapon, false, true);
  checkRigClearance('railing', 0, weapon, true, true);
  checkRigClearance('railing', -0.30, weapon, true, true);
  for (const low of [true, false]) for (const side of [-1, 1]) {
    checkSideRig(low, side, weapon);
  }
}

check(TUNING.weapons.smg.spreadBlind > TUNING.weapons.smg.spreadAim &&
  TUNING.weapons.shotgun.spreadBlind > TUNING.weapons.shotgun.spreadAim,
  'blindfire perdió su desventaja de precisión');

if (failures.length) {
  console.error('COVER FIRE ERRORS:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('COVER FIRE OK · cajas bajas y barandales · SMG/escopeta · aim plano/vertical');
