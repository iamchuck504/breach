import * as THREE from 'three';
import { World, BLOCK } from '../src/world/world.js';
import { Rig } from '../src/player/rig.js';
import { TUNING } from '../src/config/tuning.js';
import { coverAimPose, coverBlindPose, coverTopY, muzzleHasClearance,
  segmentsHaveClearance } from '../src/combat/cover-fire.js';

// PRUEBAS (corrida 6, FPS): se retiraron los bloques del CONTROLADOR en
// cobertura pegada (exposición de ADS y blindfire contextual) y la ventaja de
// spreadBlind: el jugador ya no tiene esas mecánicas. Su garantía vive en
// check-fps-movement (asomo ce: subida/bajada), check-fps-origin (origen
// oculto rechazado) y check-hit-pose (casco agachado < LOW). Lo que queda aquí
// es el rig de tercera persona y los helpers que aún usan sus poses de bots
// (BOTS-PENDING: se retiran cuando el rig deje cover_*/blind_*).
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

// ADS cerca de geometría fuera de cover: si el arma larga cruza una pared no
// se debe aprobar el tiro. Una pared que empieza delante del muzzle sí debe
// recibir el impacto normal, no convertirse en un bloqueo de gatillo.
const root = new THREE.Vector3(0, 1, 0);
const muzzle = new THREE.Vector3(0, 1, -1);
const forward = new THREE.Vector3(0, 0, -1);
const crossedWall = {
  raycastHit: () => ({ t: 0.2, collider: {} }), raycast: () => null,
};
check(!muzzleHasClearance(crossedWall, null, root, muzzle, forward),
  'ADS libre permitió que root→muzzle atravesara una pared');
const wallAhead = {
  raycastHit: (origin) => origin.z < -0.99 ? { t: 0.12, collider: {} } : null,
  raycast: () => null,
};
check(muzzleHasClearance(wallAhead, null, root, muzzle, forward),
  'ADS libre bloqueó un impacto válido delante del muzzle');


if (failures.length) {
  console.error('COVER FIRE ERRORS:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('COVER FIRE OK · cajas bajas y barandales · SMG/escopeta · aim plano/vertical');
