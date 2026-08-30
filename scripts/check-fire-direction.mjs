// Contrato global de tiro: barrel físico sin ADS; cámara como guía con ADS,
// manteniendo muzzle, pose e IK coherentes para todas las armas equipables.
import * as THREE from 'three';
import { Rig } from '../src/player/rig.js';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const weapons = ['pistol', 'smg', 'shotgun', 'sniper', 'bazooka'];
const scene = new THREE.Scene();
const poses = new Map();

function params(aim, pitch = 0, firing = false) {
  return {
    state: 'idle', speed: 0, aim, aimPitch: pitch, aimYawErr: 0,
    twist: 0, firing, groundPitch: 0,
  };
}

function settle(rig, p, frames = 55) {
  for (let i = 0; i < frames; i++) rig.update(1 / 60, p);
  rig.root.updateWorldMatrix(true, true);
}

function expectedDir(pitch) {
  return new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch)).normalize();
}

for (const weapon of weapons) {
  const rig = new Rig(scene, 'red');
  rig.setWeapon(weapon);
  rig.setTransform(0, 0, 0, 0);

  // Hip fire no recibe corrección óptica oculta: la dirección observable es
  // exactamente la del muzzle y permanece estable sin input nuevo.
  settle(rig, params(false, 0.2, true));
  const hipA = rig.gunForward(new THREE.Vector3()).normalize();
  rig.update(1 / 60, params(false, 0.2, true));
  const hipB = rig.gunForward(new THREE.Vector3()).normalize();
  check(hipA.dot(hipB) > 0.99999,
    `${weapon}: barrel hip/blind deriva sin cambio de input (${hipA.dot(hipB)})`);

  // Un solo frame de transición no puede teletransportar el arma. La
  // orientación converge después a la cámara y conserva muzzle como origen.
  const muzzleBefore = rig.muzzleWorld(new THREE.Vector3()).clone();
  rig.update(1 / 60, params(true, 0.25));
  const muzzleAfter = rig.muzzleWorld(new THREE.Vector3()).clone();
  check(muzzleBefore.distanceTo(muzzleAfter) < 0.24,
    `${weapon}: snap al entrar a ADS (${muzzleBefore.distanceTo(muzzleAfter)} m)`);

  for (const pitch of [-0.32, 0, 0.34]) {
    settle(rig, params(true, pitch));
    const dir = rig.gunForward(new THREE.Vector3()).normalize();
    check(dir.dot(expectedDir(pitch)) > 0.994,
      `${weapon}: cañón ADS no acompaña pitch ${pitch} (${dir.dot(expectedDir(pitch))})`);
  }

  const gun = rig.activeGun;
  const rightHand = rig.armR.hand.getWorldPosition(new THREE.Vector3());
  const rightGrip = gun.userData.grip.getWorldPosition(new THREE.Vector3());
  const support = gun.userData.aimSupport ?? gun.userData.forend;
  const leftHand = rig.armL.hand.getWorldPosition(new THREE.Vector3());
  const leftGrip = support.getWorldPosition(new THREE.Vector3());
  check(rightHand.distanceTo(rightGrip) < 0.09,
    `${weapon}: mano derecha fuera del grip (${rightHand.distanceTo(rightGrip)} m)`);
  check(leftHand.distanceTo(leftGrip) < 0.15,
    `${weapon}: mano izquierda fuera del apoyo ADS (${leftHand.distanceTo(leftGrip)} m)`);

  poses.set(weapon, rig.gunMount.position.clone());
  rig.dispose(scene);
}

// Las armas no comparten una pose genérica: compacta, larga y pesada deben
// ocupar posiciones de hombro/manos claramente distintas.
for (const [a, b] of [['pistol', 'smg'], ['smg', 'shotgun'], ['sniper', 'bazooka']]) {
  check(poses.get(a).distanceTo(poses.get(b)) > 0.035,
    `${a}/${b}: offsets ADS indistinguibles`);
}

if (failures.length) {
  console.error('FIRE DIRECTION ERRORS:');
  failures.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}
console.log('FIRE DIRECTION OK · barrel hip/blind · guía ADS/zoom · 5 poses · pitch · IK · transición');
