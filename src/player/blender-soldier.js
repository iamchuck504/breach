import { Box3, Color, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { vmMaterial } from '../view/fp/material.js';
import { PROFILES } from '../view/fp/profiles.js';
import { weaponSurface } from './weapon-surface.js';
import { attachSkinDetails } from './soldier-skins.js';
import { bakeSoldierBody, bakeSoldierGun } from './soldier-bake.js';

// Longitudes de pierna del modelo exportado (scripts/blender/export-soldier-body.py):
// muslo y tibia de 0,32 m; la bota cuelga 0,32 m bajo la rodilla.
const BLENDER_ANKLE = 0.32;
// Factor común de muslo y tibia (rig.js lo usa también en sus pruebas).
export const BLENDER_LEG_SCALE = 0.87;

// Native art is the browser default. Explicit legacy mode remains available.
export function blenderSoldierEnabled() {
  return typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('soldier') !== 'legacy';
}

const palettes = new Map();
const scenes = new Map();
let cachedAssets;

function loadScene(path) {
  if (!scenes.has(path)) {
    const url = `${import.meta.env?.BASE_URL ?? '/'}assets/${path}.glb`;
    const ready = new GLTFLoader().loadAsync(url).then(({ scene }) => {
      scene.traverse(node => {
        if (node.geometry) node.geometry.userData.shared = true;
        if (node.material) for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          material.userData.shared = true;
        }
      });
      return scene;
    }).catch(error => { scenes.delete(path); throw error; });
    scenes.set(path, ready);
  }
  return scenes.get(path);
}

async function weaponTemplates() {
  const entries = await Promise.all(Object.keys(PROFILES).map(async key => [key, await loadScene('weapons/' + key)]));
  return Object.fromEntries(entries);
}

async function loadTemplate() {
  const [body, weapons] = await Promise.all([loadScene('characters/blender/soldier-blender-body'), weaponTemplates()]);
  return cachedAssets = { body, weapons };
}

function targetFor(rig, target) {
  const [part, side] = target.split('.');
  const arm = side === 'R' ? rig.armR : rig.armL;
  const leg = side === 'R' ? rig.legR : rig.legL;
  return ({ hips: rig.hips, torso: rig.torso, head: rig.head,
    upper_arm: arm.shoulder, pauldron: arm.shoulder, forearm: arm.elbow,
    hand: arm.hand, thigh: leg.hip, shin: leg.knee })[part];
}

function teamMaterial(source, team) {
  if (team !== 'blue' || !/red/i.test(source.name) || /copper/i.test(source.name)) return source;
  const key = source.uuid;
  if (!palettes.has(key)) {
    const material = source.clone();
    material.color.setRGB(.025, .14, .48);
    if (material.emissive?.getHex()) material.emissive.copy(new Color().setRGB(.025, .28, 1));
    material.userData.shared = true;
    palettes.set(key, material);
  }
  return palettes.get(key);
}

// Marcos de los guantes rígidos del soldado, en coordenadas del modelo.
// La posición es el centro del guante exportado. El cuaternión orienta
// palma y falanges alrededor del puño, el bote o el apoyo delantero.
const GLOVE_CONTACTS = {
  smg: {
    grip: { position: [0.1179, -0.1765, 0.1717], rotation: [-0.58054, 0.36863, 0.13926, -0.71253] },
    forend: { position: [-0.0841, -0.0989, -0.277], rotation: [-0.84259, 0.11621, 0.31367, -0.42207] },
  },
  shotgun: {
    grip: { position: [0.114, -0.0844, 0.1168], rotation: [-0.67453, 0.26818, 0.1833, -0.66293] },
    // La muñeca gira hacia dentro en el extremo trasero de la corredera.
    forend: { position: [-0.12738, -0.01286, -0.32692], rotation: [-0.71514, -0.11622, 0.64170, -0.25157] },
  },
  sniper: {
    grip: { position: [0.1286, -0.1163, 0.1439], rotation: [-0.64999, 0.47294, -0.06004, -0.59181] },
    forend: { position: [-0.103, -0.1364, -0.13], rotation: [-0.83601, 0.07198, 0.48966, -0.23693] },
  },
  bazooka: {
    grip: { position: [0.1422, -0.1104, 0.1118], rotation: [-0.73007, 0.45159, -0.04948, -0.5105] },
    forend: { position: [-0.1367, -0.0937, -0.1922], rotation: [-0.77515, -0.16301, 0.60941, 0.03461] },
  },
  pistol: {
    grip: { position: [0.1187, -0.0700, 0.1202], rotation: [-0.52709, 0.42307, -0.09556, -0.73079] },
    support: { position: [-0.1197, -0.1187, 0.073], rotation: [-0.82006, 0.22093, 0.49344, -0.18762] },
  },
  stun: {
    grip: { position: [0.1162, -0.0793, 0.1423], rotation: [-0.43531, 0.48587, -0.05321, -0.75605] },
    support: { position: [-0.1185, -0.1271, 0.0776], rotation: [-0.82452, 0.22638, 0.4757, -0.20646] },
  },
  grenade: {
    grip: { position: [0.1133, -0.0032, 0.0547], rotation: [-0.54139, 0.54211, -0.14339, -0.62646] },
  },
  frag: {
    grip: { position: [0.1592, 0.02, -0.009], rotation: [-0.72122, 0.48781, -0.1115, -0.47901] },
  },
};

export function attachBlenderWeapon(rig, gun, key) {
  const source = rig._blenderWeaponTemplates?.[key];
  if (!source || gun.userData.blenderVisual) return;
  const object = source.children[0].clone(true);
  const { worldScale, sockets, parts, mountSockets } = object.userData;
  const holder = new Group(), refs = gun.userData;
  const release = mountSockets.muzzle;
  // Marco del montaje anterior. El origen físico y los asideros que limitan
  // el alcance del rig siguen en ese marco aunque cambie el diseño del arma.
  holder.scale.set(1/gun.scale.x, 1/gun.scale.y, 1/gun.scale.z);
  holder.position.copy(refs.muzzle.position).sub(new Vector3(...release).divide(gun.scale));
  for (const name of ['grip', 'forend', 'aimSupport']) {
    if (mountSockets[name] && refs[name]) refs[name].position.fromArray(mountSockets[name]).divide(gun.scale).add(holder.position);
  }
  object.scale.setScalar(worldScale);
  // La mira virtual de las granadas está delante del bote; la suelta real
  // se registra por el punto de la espoleta que usaba el soldado.
  const artMuzzle = PROFILES[key].thrown ? release : sockets.muzzle;
  object.position.fromArray(release).addScaledVector(new Vector3(...artMuzzle), -worldScale);
  holder.add(object);
  // Contactos en la superficie real, independientes del cálculo del montaje.
  const contacts = {};
  for (const name of Object.keys(sockets)) {
    const node = object.getObjectByName('anchor_' + name);
    if (node) contacts[name] = node;
  }
  const pivots = {};
  for (const name of parts) {
    const part = object.getObjectByName(name);
    const bone = new Group();
    bone.position.copy(part.position);
    part.position.set(0, 0, 0);
    object.add(bone);
    bone.add(part);
    pivots[name] = { bone, rest: bone.position.clone() };
  }
  if (contacts.bolt && pivots.bolt) {
    contacts.bolt.position.sub(pivots.bolt.rest);
    pivots.bolt.bone.add(contacts.bolt);
  }
  for (const [name, frame] of Object.entries(GLOVE_CONTACTS[key])) {
    const contact = new Group();
    contact.position.fromArray(frame.position);
    contact.quaternion.fromArray(frame.rotation).normalize();
    const pump = name === 'forend' && pivots.pump;
    if (pump) contact.position.sub(pump.rest);
    (pump ? pump.bone : object).add(contact);
    contacts[name] = contact;
  }
  // En un pedestal o al soltar el arma se hornea la pose de reposo.
  gun.traverse(o => { if (o.isMesh) o.visible = false; });
  gun.add(holder);
  Object.assign(refs, { blenderVisual: holder, blenderMuzzle: new Vector3(...release),
    blenderSockets: mountSockets, contacts, weaponParts: pivots });
  bakeSoldierGun(rig, gun, key, material => weaponSurface(material, key), vmMaterial(rig.team));
}

export function attachBlenderPickup(gun, key, team = 'red') {
  if (typeof location === 'undefined') return;
  return loadScene('weapons/' + key).then(scene => {
    if (!gun.userData.blenderDisposed) attachBlenderWeapon({ _blenderWeaponTemplates: { [key]: scene }, team }, gun, key);
  }).catch(error => console.warn('No se pudo cargar el arma del mundo:', key, error));
}

export async function attachSoldierWeapons(rig) {
  const weapons = cachedAssets?.weapons ?? await weaponTemplates();
  if (rig._disposed) return;
  rig._blenderWeaponTemplates = weapons;
  for (const [key, gun] of Object.entries(rig.guns)) attachBlenderWeapon(rig, gun, key);
  rig._placeStowed();
}

/** Visual-only attachment. Never writes a pose, gun, socket or muzzle transform. */
export async function attachBlenderSoldier(rig) {
  const assets = cachedAssets ?? await loadTemplate();
  const scene = assets.body;
  if (rig._disposed) return false;
  const segments = scene.children.filter(o => o.userData.runtimeTarget);
  if (segments.length !== 19 || segments.some(o => !targetFor(rig, o.userData.runtimeTarget))) {
    throw new Error('Invalid Blender soldier segment manifest');
  }
  // Finish loading/validating before removing any old geometry.
  const replacements = segments.map(source => {
    const object = source.clone(true);
    // The shoulder shell previously covered the whole upper arm in firing
    // poses. Reduce only this cosmetic shell, not bones, hands or body scale.
    if(source.userData.runtimeTarget.startsWith('pauldron.'))object.scale.multiplyScalar(.82);
    object.traverse(o => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material)
        ? o.material.map(m => teamMaterial(m, rig.team))
        : teamMaterial(o.material, rig.team);
      o.castShadow = true;
      o.receiveShadow = true;
      o.userData.blenderSoldier = true;
    });
    const name = source.name || '';
    // Piernas: muslo y tibia exportados a 0,32 m + bota de 0,13 m no caben
    // bajo una cadera a 0,68 m (la bota quedaba 9 cm bajo el suelo). Se
    // acortan ambos por igual; la bota cuelga del tobillo para pisar plana.
    if (/^segment_(thigh|shin)_/.test(name)) object.scale.y *= BLENDER_LEG_SCALE;
    if (/^segment_foot_/.test(name)) {
      const leg = name.endsWith('_R') ? rig.legR : rig.legL;
      const box = new Box3().setFromObject(object);
      const ax = (box.min.x + box.max.x) / 2;
      // la bota se exportó con su tobillo a 0,32 m bajo la rodilla
      object.position.set(-ax, BLENDER_ANKLE, 0);
      return [leg.ankle, object, { leg, ax }];
    }
    return [targetFor(rig, source.userData.runtimeTarget), object];
  });
  // Death effects clone materials and track hidden nodes. Wait until alive so
  // swapping visuals cannot invalidate an active corpse's restoration list.
  rig._pendingBlenderSoldier = () => {
    if (rig._disposed) return;
    const protectedState = rig._prot;
    if (rig._outlines) {
      for (const o of rig._outlines) o.removeFromParent();
      rig._outlineMat.dispose();
      rig._outlines = null;
    }
    const collect = node => {
      if ([rig.gunMount, rig.backMount, rig.holsterMount, rig.nameTag].includes(node)) return;
      for (const child of [...node.children]) {
        if (child.isMesh) child.removeFromParent();
        else collect(child);
      }
    };
    collect(rig.root);
    for (const [parent, object, foot] of replacements) {
      if (parent === rig.armR.hand || parent === rig.armL.hand) {
        // El agarre orienta sólo el guante dibujado, en torno a la muñeca lógica.
        const arm = parent === rig.armR.hand ? rig.armR : rig.armL;
        arm.glovePivot = new Group();
        parent.add(arm.glovePivot);
        arm.glovePivot.add(object);
      } else parent.add(object);
      if (!foot) continue;
      // rodilla y tobillo del esqueleto acortado (ver BLENDER_LEG_SCALE)
      foot.leg.knee.position.y = -BLENDER_ANKLE * BLENDER_LEG_SCALE;
      foot.leg.ankle.position.set(foot.ax, -BLENDER_ANKLE * BLENDER_LEG_SCALE, 0);
    }
    rig._calibrateLegs();
    attachSkinDetails(rig);
    rig._blenderWeaponTemplates = assets.weapons;
    for (const [key, gun] of Object.entries(rig.guns)) attachBlenderWeapon(rig, gun, key);
    rig.blenderSoldier = true;
    // Todo el cuerpo (segmentos + detalles de la variante) pasa a UN mesh
    // con skinning rígido sobre las mismas piezas que anima el rig.
    bakeSoldierBody(rig);
    // armas guardadas: se recolocan sobre el cuerpo y los modelos nuevos
    rig._placeStowed?.();
    rig._pendingBlenderSoldier = null;
    rig._prot = undefined;
    rig.setProtected(protectedState);
  };
  return true;
}
