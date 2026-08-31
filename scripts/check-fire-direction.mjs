// Contrato visual del arma: el mesh no cambia de eje entre low-ready y el
// primer disparo; la guía central de gameplay se valida en check-reticle.
import * as THREE from 'three';
import { Rig } from '../src/player/rig.js';
import { RemotePlayer } from '../src/player/remote.js';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const weapons = ['pistol', 'smg', 'shotgun', 'sniper', 'bazooka'];
const scene = new THREE.Scene();
const poses = new Map();

function params(aim, pitch = 0, firing = false, opts = {}) {
  return {
    state: opts.state ?? 'idle', speed: 0, aim, aimPitch: pitch,
    aimYawErr: opts.aimYawErr ?? 0,
    twist: 0, firing, groundPitch: 0,
    coverLean: opts.coverLean ?? 0,
    coverAimExposure: opts.coverAimExposure ?? 1,
    coverKind: opts.coverKind,
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

  // La pose relajada y el primer frame de hip fire comparten el mismo eje.
  // Antes low-ready añadía yaw/pitch local y la retícula saltaba del vehículo
  // lateral al frente justo al pulsar disparo.
  settle(rig, params(false, 0.2, false));
  const relaxed = rig.gunForward(new THREE.Vector3()).normalize();
  const relaxedMuzzle = rig.muzzleWorld(new THREE.Vector3()).clone();
  const relaxedMount = rig.gunMount.position.clone();
  rig.update(1 / 60, params(false, 0.2, true));
  const firstFireFrame = rig.gunForward(new THREE.Vector3()).normalize();
  const firstFireMuzzle = rig.muzzleWorld(new THREE.Vector3()).clone();
  check(relaxed.dot(firstFireFrame) > 0.99999,
    `${weapon}: salto en el primer frame de hip fire (${relaxed.dot(firstFireFrame)})`);
  check(relaxedMuzzle.distanceTo(firstFireMuzzle) < 0.012,
    `${weapon}: el muzzle saltó al iniciar hip fire (${relaxedMuzzle.distanceTo(firstFireMuzzle)} m)`);
  check(relaxedMount.x >= 0.244 && relaxedMount.z <= -0.399 && relaxedMount.y > -0.17,
    `${weapon}: postura hip no mantiene el arma visible al frente (${relaxedMount.toArray()})`);
  settle(rig, params(false, 0.2, true));
  const hipA = rig.gunForward(new THREE.Vector3()).normalize();
  const firingMuzzle = rig.muzzleWorld(new THREE.Vector3()).clone();
  check(relaxed.dot(hipA) > 0.9999,
    `${weapon}: el eje cambia entre low-ready y hip fire (${relaxed.dot(hipA)})`);
  check(relaxedMuzzle.distanceTo(firingMuzzle) < 0.02,
    `${weapon}: la pose relajada y la de disparo no comparten muzzle (${relaxedMuzzle.distanceTo(firingMuzzle)} m)`);

  // El eje visual del muzzle permanece estable sin input nuevo.
  rig.update(1 / 60, params(false, 0.2, true));
  const hipB = rig.gunForward(new THREE.Vector3()).normalize();
  check(hipA.dot(hipB) > 0.99999,
    `${weapon}: eje visual deriva sin cambio de input (${hipA.dot(hipB)})`);

  // Un solo frame de transición no puede teletransportar el arma. ADS cambia
  // la pose, mientras la cámara conserva su propio encuadre de tercera persona.
  const muzzleBefore = rig.muzzleWorld(new THREE.Vector3()).clone();
  const transitionParams = params(true, 0.25);
  rig.update(1 / 60, transitionParams);
  const muzzleAfter = rig.muzzleWorld(new THREE.Vector3()).clone();
  check(muzzleBefore.distanceTo(muzzleAfter) < 0.10,
    `${weapon}: snap al entrar a ADS (${muzzleBefore.distanceTo(muzzleAfter)} m)`);
  for (const pitch of [-0.32, 0, 0.34]) {
    const aimParams = params(true, pitch);
    settle(rig, aimParams, 90);
    const dir = rig.gunForward(new THREE.Vector3()).normalize();
    check(dir.dot(expectedDir(pitch)) > 0.999,
      `${weapon}: cañón ADS no acompaña pitch ${pitch} (${dir.dot(expectedDir(pitch))})`);
    rig.update(1 / 60, aimParams);
    const stableDir = rig.gunForward(new THREE.Vector3()).normalize();
    check(dir.dot(stableDir) > 0.99999,
      `${weapon}: la pose ADS deriva asentada en pitch ${pitch}`);
  }

  // Las dos orillas de cover conservan una pose estable y finita. La cámara
  // define el objetivo balístico; no se traslada el arma encima de su rayo.
  for (const side of [1, -1]) {
    for (const pitch of [-0.28, 0, 0.3]) {
      const coverParams = params(true, pitch, false, {
        state: 'cover_high', side, coverLean: side,
        coverKind: 'high', coverAimExposure: 1,
      });
      settle(rig, coverParams, 100);
      const before = rig.gunForward(new THREE.Vector3()).normalize();
      rig.update(1 / 60, coverParams);
      const after = rig.gunForward(new THREE.Vector3()).normalize();
      check(Number.isFinite(after.x + after.y + after.z) && before.dot(after) > 0.99999,
        `${weapon}: cover ${side > 0 ? 'derecho' : 'izquierdo'} deriva en pitch ${pitch}`);
    }
  }

  // Guardar la pose neutral, no el último lean, para confirmar que cada arma
  // conserva una postura de precisión propia aunque comparta la línea óptica.
  settle(rig, params(true, 0), 90);
  poses.set(weapon, rig.gunMount.position.clone());
  const adsCenterX = rig.aimRig.position.x + rig.gunMount.position.x;
  const minAdsCenterShift = weapon === 'pistol' ? 0.19 : 0.23;
  check(adsCenterX >= minAdsCenterShift,
    `${weapon}: ADS no lleva brazos/arma hacia la línea de visión (${adsCenterX})`);
  check(adsCenterX < relaxedMount.x + 0.06,
    `${weapon}: ADS cruzó excesivamente el centro de cámara (${adsCenterX})`);

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

  rig.dispose(scene);
}

// Las armas no comparten una pose genérica: compacta, larga y pesada deben
// ocupar posiciones de hombro/manos claramente distintas.
for (const [a, b] of [['pistol', 'smg'], ['smg', 'shotgun'], ['sniper', 'bazooka']]) {
  // Al quedar físicamente colineales, dos armas largas pueden converger en
  // posición; tres centímetros siguen separando la pose sin desalinear muzzle.
  check(poses.get(a).distanceTo(poses.get(b)) > 0.03,
    `${a}/${b}: offsets ADS indistinguibles`);
}

// Un cliente observador reconstruye una pose visual estable desde el snapshot,
// sin intentar mover el muzzle hasta una cámara remota que no posee.
const remote = new RemotePlayer(scene, 'remote-test', null, 'blue');
remote.x = 2; remote.z = -3; remote.y = 0; remote.yaw = 0.45;
remote.st = 'cover_high'; remote.aim = true; remote.pitch = 0.27;
remote.aimErr = 0.11; remote.coverLean = -1; remote.coverExposure = 1;
remote.coverKind = 'high';
for (let i = 0; i < 120; i++) remote.update(1 / 60);
const remoteDir = remote.rig.gunForward(new THREE.Vector3()).normalize();
remote.update(1 / 60);
const remoteStableDir = remote.rig.gunForward(new THREE.Vector3()).normalize();
check(Number.isFinite(remoteStableDir.x + remoteStableDir.y + remoteStableDir.z) &&
  remoteDir.dot(remoteStableDir) > 0.99999,
  'remoto: pose ADS deriva después de asentar el snapshot');
remote.dispose(scene);

// Compatibilidad con servidores anteriores: un evento sin el snapshot `fp`
// puede reproducir flash/arma, pero nunca debe congelar la interpolación de
// pose durante una ráfaga completa.
const legacyRemote = new RemotePlayer(scene, 'legacy-remote', null, 'blue');
legacyRemote.applyFirePose(null, 'smg');
check((legacyRemote.firePoseT ?? 0) === 0,
  'remoto legacy: evento sin fire-pose congeló la interpolación');
check(legacyRemote.firing > 0,
  'remoto legacy: evento sin fire-pose perdió el feedback de disparo');
legacyRemote.dispose(scene);

const leftFireRemote = new RemotePlayer(scene, 'left-fire-remote', null, 'blue');
leftFireRemote.applyFirePose({ st: 'cover_high', a: 1, p: 0.1, ae: 0,
  cl: -1, ce: 1, ck: 'high' }, 'sniper');
check(leftFireRemote.aimSide === -1,
  'remoto: fire-pose de cover izquierdo conservó el hombro derecho');
leftFireRemote.dispose(scene);

if (failures.length) {
  console.error('FIRE DIRECTION ERRORS:');
  failures.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}
console.log('FIRE DIRECTION OK · hip físico · ADS central · 5 poses · cover · pitch · IK · remoto');
