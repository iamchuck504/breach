import { createWeaponMount, WEAPON_SCALES } from '../player/rig.js';
import { attachBlenderPickup } from '../player/blender-soldier.js';

// El pedestal, el botín y los prototipos comparten modelo, escala y paleta.
export function createWorldWeapon(key, team = 'red') {
  const id = Object.hasOwn(WEAPON_SCALES, key) ? key : 'smg';
  const gun = createWeaponMount(id);
  gun.scale.set(...WEAPON_SCALES[id]);
  gun.userData.visualReady = attachBlenderPickup(gun, id, team);
  return gun;
}
