import { Color, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BlenderMotion } from './blender-motion.js';

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
  const names=['soldier-native','smg','shotgun','pistol','sniper','bazooka','grenade'];
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

/** Native body/clips and weapon art; functional sockets remain authoritative. */
export async function attachBlenderSoldier(rig) {
  const assets = cachedAssets ?? await loadTemplate();
  if (rig._disposed) return false;
  // Death effects clone materials and track hidden nodes. Wait until alive so
  // swapping visuals cannot invalidate an active corpse's restoration list.
  rig._pendingBlenderSoldier = () => {
    if (rig._disposed) return;
    rig._pendingBlenderSoldier = null;
    let motion;
    try {
      motion=new BlenderMotion(rig,assets.body,m=>teamMaterial(m,rig.team));
    } catch(error) {
      console.warn('Keeping original soldier: invalid animation package',error);
      return;
    }
    const protectedState = rig._prot;
    if (rig._outlines) {
      for (const o of rig._outlines) o.removeFromParent();
      rig._outlineMat.dispose();
      rig._outlines = null;
    }
    const collect = node => {
      if ([rig.gunMount, rig.backMount, rig.holsterMount, rig.nameTag,motion.root].includes(node)) return;
      for (const child of [...node.children]) {
        if (child.isMesh) {child.visible=false;child.userData.blenderSourceHidden=true;}
        else collect(child);
      }
    };
    collect(rig.root);
    rig.blenderMotion=motion;
    rig._blenderWeaponTemplates=assets.weapons;
    for(const [key,gun] of Object.entries(rig.guns))attachBlenderWeapon(rig,gun,key);
    rig.blenderSoldier = true;
    rig._pendingBlenderSoldier = null;
    rig._prot = undefined;
    rig.setProtected(protectedState);
  };
  return true;
}
