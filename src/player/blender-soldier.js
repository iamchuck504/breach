import { Color, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { attachSkinDetails } from './soldier-skins.js';

// Native art is the browser default. Explicit legacy mode remains available.
export function blenderSoldierEnabled() {
  return typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('soldier') !== 'legacy';
}

let template;
let cachedAssets;
const palettes = new Map();
function loadTemplate() {
  const loader=new GLTFLoader(),base=`${import.meta.env?.BASE_URL ?? '/'}assets/characters/blender/`;
  const names=['soldier-blender-body','smg','shotgun','pistol','sniper','bazooka','grenade'];
  return template ??= Promise.all(names.map(name=>loader.loadAsync(`${base}${name}.glb`))).then(assets=>{
    for(let i=1;i<assets.length;i++){
      let valid=false;
      assets[i].scene.traverse(o=>{if(o.userData.sockets?.muzzle?.length===3)valid=true;});
      if(!valid)throw new Error(`Invalid Blender weapon sockets: ${names[i]}`);
    }
    for(const {scene} of assets)scene.traverse((o) => {
      if (o.geometry) o.geometry.userData.shared = true;
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.userData.shared = true;
      }
    });
    return cachedAssets={body:assets[0],weapons:Object.fromEntries(names.slice(1).map((name,i)=>[name,assets[i+1].scene]))};
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

export function attachBlenderWeapon(rig,gun,key){
  const source=rig._blenderWeaponTemplates?.[key];
  if(!source||gun.userData.blenderVisual)return;
  const object=source.clone(true),holder=new Group();
  let sockets;
  object.traverse(o=>{
    if(o.userData.sockets)sockets=o.userData.sockets;
    if(o.isMesh){
      o.material=Array.isArray(o.material)?o.material.map(m=>teamMaterial(m,rig.team)):teamMaterial(o.material,rig.team);
      o.castShadow=true;o.receiveShadow=true;
    }
  });
  if(!sockets?.muzzle)throw new Error(`Missing Blender muzzle reference: ${key}`);
  holder.scale.set(1/gun.scale.x,1/gun.scale.y,1/gun.scale.z);
  const offset=gun.userData.muzzle.position.clone().multiply(gun.scale).sub(new Vector3().fromArray(sockets.muzzle));
  holder.position.copy(offset.divide(gun.scale));holder.add(object);gun.add(holder);
  // The native weapon has different grip locations from the procedural
  // placeholder. Drive hands from the same sockets as the visible GLB.
  // Muzzle remains untouched: holder was aligned to it above.
  for(const key of ['grip','forend','aimSupport','mag']){
    const anchor=gun.userData[key],socket=sockets[key];
    if(anchor&&socket)anchor.position.fromArray(socket).divide(gun.scale).add(holder.position);
  }
  if(gun.userData.equippedVisual)gun.userData.equippedVisual.visible=false;
  else gun.traverse(o=>{if(o.isMesh&&!holder.getObjectById(o.id))o.visible=false;});
  gun.userData.blenderVisual=holder;
  gun.userData.blenderMuzzle=new Vector3().fromArray(sockets.muzzle);
  gun.userData.blenderSockets=sockets;
}

export function attachBlenderPickup(gun,key,team='red'){
  if(!blenderSoldierEnabled())return;
  loadTemplate().then(assets=>{
    if(gun.userData.blenderDisposed)return;
    attachBlenderWeapon({_blenderWeaponTemplates:assets.weapons,team},gun,key);
  }).catch(error=>console.warn('Keeping original pickup model:',error));
}

/** Visual-only attachment. Never writes a pose, gun, socket or muzzle transform. */
export async function attachBlenderSoldier(rig) {
  const assets = cachedAssets ?? await loadTemplate();
  const scene = assets.body.scene;
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
    attachSkinDetails(rig);
    rig._blenderWeaponTemplates=assets.weapons;
    for(const [key,gun] of Object.entries(rig.guns))attachBlenderWeapon(rig,gun,key);
    rig.blenderSoldier = true;
    rig._pendingBlenderSoldier = null;
    rig._prot = undefined;
    rig.setProtected(protectedState);
  };
  return true;
}
