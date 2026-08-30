// La escala reducida pertenece exclusivamente al modelo equipado. Este check
// protege muzzle/ballistics, sockets de manos, pickups y paridad local/remota.
import * as THREE from 'three';
import {
  Rig,
  WEAPON_BUILDERS,
  WEAPON_SCALES,
  EQUIPPED_WEAPON_VISUAL_SCALE,
  applyEquippedWeaponVisualScale,
} from '../src/player/rig.js';

const WEAPONS = ['smg', 'shotgun', 'pistol', 'grenade', 'sniper', 'bazooka'];
const failures = [];
const EPS = 1e-6;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const close = (a, b, eps = EPS) => Math.abs(a - b) <= eps;
const vecClose = (a, b, eps = EPS) => a.distanceTo(b) <= eps;
const sizeOf = (object) => {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
};

for (const weapon of WEAPONS) {
  const build = WEAPON_BUILDERS[weapon];
  const baseline = build(0x4f8de0);
  const baselineSize = sizeOf(baseline);
  const pickupProbe = build(0x4f8de0);
  check(`${weapon}: builder/pickup conserva escala original`,
    !pickupProbe.userData.equippedVisual &&
    pickupProbe.children.some((child) => child.isMesh));

  const equipped = build(0x4f8de0);
  const originalMuzzle = equipped.userData.muzzle.position.clone();
  const originalSockets = Object.fromEntries(['grip', 'forend', 'mag']
    .filter((key) => equipped.userData[key])
    .map((key) => [key, equipped.userData[key].position.clone()]));
  const visual = applyEquippedWeaponVisualScale(equipped, weapon);
  const equippedSize = sizeOf(equipped);
  const expectedZ = weapon === 'grenade' ? EQUIPPED_WEAPON_VISUAL_SCALE : 1;

  check(`${weapon}: volumen visual reducido 20%`,
    close(equippedSize.x / baselineSize.x, EQUIPPED_WEAPON_VISUAL_SCALE) &&
    close(equippedSize.y / baselineSize.y, EQUIPPED_WEAPON_VISUAL_SCALE) &&
    close(equippedSize.z / baselineSize.z, expectedZ),
  `ratio=${(equippedSize.x / baselineSize.x).toFixed(3)},` +
    `${(equippedSize.y / baselineSize.y).toFixed(3)},${(equippedSize.z / baselineSize.z).toFixed(3)}`);

  check(`${weapon}: muzzle lógico no se desplaza`,
    vecClose(equipped.userData.muzzle.position, originalMuzzle));
  visual.updateMatrix();
  const visualTip = originalMuzzle.clone().applyMatrix4(visual.matrix);
  check(`${weapon}: punta visual coincide con muzzle/flash`, vecClose(visualTip, originalMuzzle),
    `error=${visualTip.distanceTo(originalMuzzle).toExponential(2)}`);

  for (const [key, original] of Object.entries(originalSockets)) {
    const expected = new THREE.Vector3(
      originalMuzzle.x + (original.x - originalMuzzle.x) * EQUIPPED_WEAPON_VISUAL_SCALE,
      originalMuzzle.y + (original.y - originalMuzzle.y) * EQUIPPED_WEAPON_VISUAL_SCALE,
      originalMuzzle.z + (original.z - originalMuzzle.z) * expectedZ,
    );
    check(`${weapon}: socket ${key} acompaña al mesh`,
      vecClose(equipped.userData[key].position, expected));
  }

  check(`${weapon}: root funcional no fue escalado por la reducción`,
    close(equipped.scale.x, 1) && close(equipped.scale.y, 1) && close(equipped.scale.z, 1));
}

// Rig es la ruta común de jugador local, bots y RemotePlayer. Dos instancias
// de equipos opuestos deben montar exactamente la misma capa visual reducida.
const scene = new THREE.Scene();
const localRig = new Rig(scene, 'red');
const remoteRig = new Rig(scene, 'blue');
for (const weapon of WEAPONS) {
  localRig.setWeapon(weapon);
  remoteRig.setWeapon(weapon);
  const local = localRig.activeGun;
  const remote = remoteRig.activeGun;
  const expectedRoot = WEAPON_SCALES[weapon];
  check(`${weapon}: escala idéntica en host/cliente/bot`,
    close(local.userData.equippedVisual.scale.x, remote.userData.equippedVisual.scale.x) &&
    close(local.userData.equippedVisual.scale.y, remote.userData.equippedVisual.scale.y) &&
    close(local.userData.equippedVisual.scale.z, remote.userData.equippedVisual.scale.z) &&
    close(local.scale.x, expectedRoot[0]) && close(remote.scale.x, expectedRoot[0]));
  check(`${weapon}: muzzle idéntico entre rigs`,
    vecClose(local.userData.muzzle.position, remote.userData.muzzle.position));
}

if (failures.length) {
  console.log(`\nEQUIPPED-WEAPON-SCALE: ${failures.length} fallos → ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\nEQUIPPED-WEAPON-SCALE: visual -20%, muzzle intacto, IK y multiplayer coherentes');
