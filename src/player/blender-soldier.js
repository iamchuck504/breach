import { Color } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Explicit playtest opt-in: existing avatars and production behavior stay intact.
export function blenderSoldierEnabled() {
  return typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('soldier') === 'blender';
}

let template;
const palettes = new Map();
function loadTemplate() {
  return template ??= new GLTFLoader().loadAsync(
    `${import.meta.env?.BASE_URL ?? '/'}assets/characters/blender/soldier-blender-body.glb`,
  ).then(({ scene }) => {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.userData.shared = true;
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.userData.shared = true;
      }
    });
    return scene;
  });
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

/** Visual-only attachment. Never writes a pose, gun, socket or muzzle transform. */
export async function attachBlenderSoldier(rig) {
  const scene = await loadTemplate();
  if (rig._disposed) return false;
  const segments = scene.children.filter(o => o.userData.runtimeTarget);
  if (segments.length !== 19 || segments.some(o => !targetFor(rig, o.userData.runtimeTarget))) {
    throw new Error('Invalid Blender soldier segment manifest');
  }
  // Finish loading/validating before removing any old geometry.
  const replacements = segments.map(source => {
    const object = source.clone(true);
    object.traverse(o => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material)
        ? o.material.map(m => teamMaterial(m, rig.team)) : teamMaterial(o.material, rig.team);
      o.castShadow = true;
      o.receiveShadow = true;
      o.userData.blenderSoldier = true;
    });
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
    for (const [parent, object] of replacements) parent.add(object);
    rig.blenderSoldier = true;
    rig._pendingBlenderSoldier = null;
    rig._prot = undefined;
    rig.setProtected(protectedState);
  };
  return true;
}
