// Sin WebGL: comprueba los archivos publicados, después el montaje real y
// sus piezas articuladas con el mismo cargador GLTF que usa el juego.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Box3, Matrix4, PerspectiveCamera, Scene, ShaderLib, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { surfaces, prepare, clearance, nearestSurface } from './lib-fps-hand-geometry.mjs';
import { createViewModel } from '../src/view/fp/viewmodel.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import { WEAPONS, buildWeapon } from './build-viewmodel-art.mjs';
import { buildWorldWeapon } from './build-thirdperson-weapons.mjs';
import { renderWeaponIcon } from './weapon-icon-raster.mjs';
import { readGLB } from './simplify-soldier-art.mjs';
import { measure } from './fire-reference.mjs';
import { ADS_WEAPON_POSES, Rig, WEAPON_BUILDERS, WEAPON_SCALES, applyEquippedWeaponVisualScale } from '../src/player/rig.js';
import { SpecialPickup } from '../src/game/special.js';
import { WeaponDrops } from '../src/game/drops.js';
import { weaponIconMarkup, feedIconMarkup } from '../src/ui/weapon-icons.js';

const assets = new URL('../public/assets/', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/fire-reference.json', import.meta.url)));
const point = n => n.getWorldPosition(new Vector3());
function checkGenerated(key, published, generated) {
  const { json, chunks } = generated;
  for (const field of ['asset', 'materials', 'meshes', 'nodes']) assert.deepEqual(published.json[field], json[field], key + ' ' + field);
  for (const [i, chunk] of chunks.entries()) assert.deepEqual(published.accessor(i), chunk.data, key + ' datos ' + i);
}

function triangles({ json, accessor }, fpProfile) {
  const out = [];
  for (const node of json.nodes.filter(n => n.mesh != null)) {
    const origin = new Vector3(...(node.translation ?? [0,0,0]));
    if (node.name==='stock' && fpProfile) {
      origin.y += fpProfile.parts.stockRise ?? 0;
      origin.z -= fpProfile.parts.stockFold ?? 0;
    }
    for (const prim of json.meshes[node.mesh].primitives) {
      const p = accessor(prim.attributes.POSITION), idx = accessor(prim.indices);
      const vertices = Array.from({ length: p.length / 3 }, (_, i) => new Vector3().fromArray(p, i*3).add(origin));
      for (let i=0; i<idx.length; i+=3) out.push([vertices[idx[i]], vertices[idx[i+1]], vertices[idx[i+2]]]);
    }
  }
  return out;
}

// Misma ventana para ambos modelos. Además de la caja, compara píxeles
// ocupados: un cargador ausente o una culata maciza alteran la máscara.
function project(tris, u, v) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const faces = tris.map(t => t.map(p => {
    const x=p.dot(u), y=p.dot(v);
    bounds[0]=Math.min(bounds[0],x); bounds[1]=Math.min(bounds[1],y);
    bounds[2]=Math.max(bounds[2],x); bounds[3]=Math.max(bounds[3],y);
    return [x,y];
  }));
  return { faces, bounds };
}
function mask({ faces }, frame) {
  const n=160, pixels=new Uint8Array(n*n);
  const s=(n-4)/Math.max(frame[2]-frame[0],frame[3]-frame[1]);
  for (const face of faces) {
    const [[ax,ay],[bx,by],[cx,cy]]=face.map(([x,y])=>[(x-frame[0])*s+2,(y-frame[1])*s+2]);
    const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
    if (Math.abs(area)<1e-7) continue;
    for (let y=Math.max(0,Math.floor(Math.min(ay,by,cy))); y<=Math.min(n-1,Math.ceil(Math.max(ay,by,cy))); y++) {
      for (let x=Math.max(0,Math.floor(Math.min(ax,bx,cx))); x<=Math.min(n-1,Math.ceil(Math.max(ax,bx,cx))); x++) {
        const dx=x+0.5-ax, dy=y+0.5-ay;
        const a=(dx*(cy-ay)-dy*(cx-ax))/area, b=((bx-ax)*dy-(by-ay)*dx)/area;
        if (a>=0 && b>=0 && a+b<=1) pixels[y*n+x]=1;
      }
    }
  }
  return pixels;
}
function oldLength(key, axis) {
  if (key === 'frag' || key === 'stun') {
    const g=WEAPON_BUILDERS[key](0);
    applyEquippedWeaponVisualScale(g,key); g.scale.set(...WEAPON_SCALES[key]);
    return new Box3().setFromObject(g,true).getSize(new Vector3())[axis];
  }
  const old=readGLB(new URL('characters/blender/'+key+'.glb',assets));
  return new Box3().setFromPoints(triangles(old).flat()).getSize(new Vector3())[axis];
}

// Contrasta los acabados ya fusionados por pieza, incluidos tintes y emisivos.
function palette(mesh) {
  const { color, aSurf, aDetail, skinIndex } = mesh.geometry.attributes;
  const entries = new Set();
  for (let i = 0; i < color.count; i++) {
    entries.add([skinIndex.getX(i), color.getX(i), color.getY(i), color.getZ(i),
      aSurf.getX(i), aSurf.getY(i), aSurf.getZ(i), aSurf.getW(i), aDetail.getX(i)].join(','));
  }
  return entries;
}

// Dos zonas del guante deben tocar el arma. Un solo vértice tangente
// también puede dar distancia cero en una mano que está casi en el aire.
function broadContact(glove, weapon) {
  let first;
  for (const p of glove.points) {
    const v = p.clone().applyMatrix4(glove.bone.matrixWorld);
    if (first && first.distanceToSquared(v) < 0.035 ** 2) continue;
    if (v.distanceTo(nearestSurface(v, weapon)) > 0.003) continue;
    if (first) return true;
    first = v;
  }
  return false;
}

function shaderFor(material) {
  const shader = { ...ShaderLib.standard, uniforms: {} };
  material.onBeforeCompile(shader);
  return shader;
}

const loader = GLTFLoader.prototype.loadAsync;
GLTFLoader.prototype.loadAsync = async function(url) {
  const b = fs.readFileSync(new URL('../public'+url,import.meta.url));
  return this.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
};
const oldLocation=globalThis.location;
globalThis.location = new URL('http://localhost/');
const scene=new Scene(), rig=new Rig(scene,'red');
assert.ok(await rig.visualReady);
rig.update(0,{state:'idle',speed:0});
rig.setTransform(0,0,0,0);
const pickups=new SpecialPickup(scene), drops=new WeaponDrops(scene);
try {
  const vm = createViewModel({ scene, camera: new PerspectiveCamera() });
  await vm.ready;
  const gloves = surfaces(rig._bodyMesh, bone => /^segment_hand_[LR]$/.test(bone.name));
  assert.equal(gloves.size, 2);
  for (const glove of gloves.values()) {
    // Las aristas y centros detectan un mango que entra por una cara ancha
    // del guante aunque sus vértices queden fuera.
    for (const { tri } of glove.faces) glove.points.push(tri.getMidpoint(new Vector3()),
      tri.a.clone().lerp(tri.b, 0.5), tri.b.clone().lerp(tri.c, 0.5), tri.c.clone().lerp(tri.a, 0.5));
  }
  for (const key of Object.keys(WEAPONS)) {
    const fp=readGLB(new URL('fp/'+key+'.glb',assets)), world=readGLB(new URL('weapons/'+key+'.glb',assets));
    const generated=buildWorldWeapon(key);
    checkGenerated(key,fp,buildWeapon(key));
    checkGenerated(key,world,generated);
    assert.deepEqual(world.json.materials,fp.json.materials);
    assert.deepEqual(world.json.nodes[0].extras.parts,fp.json.nodes[0].extras.parts);
    assert.deepEqual(world.json.nodes[0].extras.pivots,fp.json.nodes[0].extras.pivots);
    const f=triangles(fp,PROFILES[key]), w=triangles(world);
    assert.ok(w.length<=3500 && w.length<=f.length);
    let worst=1;
    for (const [u,v] of [[[1,0,0],[0,1,0]],[[0,0,1],[0,1,0]],[[0,0,1],[1,0,0]],[[0.8,0,0.6],[-0.18,0.954,0.24]]]) {
      const projections=[f,w].map(t=>project(t,new Vector3(...u),new Vector3(...v)));
      const [a,b]=projections.map(p=>p.bounds);
      const ratios=[0,1].map(i=>(b[2+i]-b[i])/(a[2+i]-a[i]));
      for (const r of [...ratios, ratios[0]/ratios[1]]) assert.ok(Math.abs(r-1)<=0.03,key+' proporción '+r);
      const [m,n]=projections.map(p=>mask(p,a));
      let union=0, intersection=0;
      for (let i=0;i<m.length;i++) { union+=m[i]|n[i]; intersection+=m[i]&n[i]; }
      worst=Math.min(worst,intersection/union);
    }
    assert.ok(worst>=0.97,key+' silueta '+worst);
    const icon=renderWeaponIcon(key,generated.json,generated.chunks);
    assert.deepEqual(icon,fs.readFileSync(new URL('ui/'+key+'.png',assets)));
    assert.ok([weaponIconMarkup(key),feedIconMarkup(key)].every(s=>s.includes('/ui/'+key+'.png')));
    rig.setWeapon(key);
    const gun=rig.activeGun, data=gun.userData, baked=data.bakedMesh;
    assert.ok(baked.isSkinnedMesh && data.weaponParts);
    const first = vm.weapons[key].mesh;
    assert.deepEqual(palette(baked), palette(first), key+' paleta por pieza');
    assert.ok(baked.geometry.attributes.aWear.array.some(v => v > 0.5), key+' desgaste');
    const shader = shaderFor(baked.material);
    assert.equal(shader.uniforms.uVmFill, shaderFor(first.material).uniforms.uVmFill);
    assert.ok(shader.uniforms.uVmFill && !shader.uniforms.uVMProj && !shader.fragmentShader.includes('sRim'));
    const weaponSurfaces = [...surfaces(baked).values()];
    // La piel del arma está expresada en el montaje. Cada superficie sigue
    // la matriz actual de su pieza multiplicada por la inversa de reposo.
    for (const surface of weaponSurfaces) {
      surface.index = baked.skeleton.bones.indexOf(surface.bone);
      surface.bone = { matrixWorld: new Matrix4() };
    }
    let worstGap = 0;
    const axis=['grenade','frag'].includes(key)?'y':'z';
    const length=rig._gunBox(gun).getSize(new Vector3())[axis];
    assert.ok(Math.abs(length/oldLength(key,axis)-1)<0.01,key+' longitud '+length);
    for (const [i,part] of Object.values(data.weaponParts).entries()) {
      assert.equal(baked.skeleton.bones[i],part.bone);
      assert.ok(baked.geometry.attributes.skinIndex.array.some((v,j)=>j%4===0 && v===i));
    }
    const idle={state:'idle',speed:0,aim:false,aimPitch:0,aimYawErr:0,groundPitch:0,twist:0};
    for(let i=0;i<150;i++) rig.update(1/60,idle);
    scene.updateMatrixWorld(true);
    const restVertex=new Vector3(), skinnedVertex=new Vector3();
    const positions=baked.geometry.attributes.position;
    for (let i=0; i<positions.count; i+=37) {
      restVertex.fromBufferAttribute(positions,i);
      baked.getVertexPosition(i,skinnedVertex);
      assert.ok(restVertex.distanceTo(skinnedVertex)<1e-5,key+' piel en reposo');
    }
    for (const name of ['grip','forend','aimSupport']) {
      const socket=data.blenderSockets[name];
      if (socket && data[name]) assert.ok(data.blenderVisual.localToWorld(new Vector3(...socket))
        .distanceTo(point(data[name]))<1e-6,key+' ancla histórica '+name);
    }
    const logical=rig.muzzleWorld(new Vector3());
    const release=data.blenderVisual.localToWorld(data.blenderMuzzle.clone());
    assert.ok(release.distanceTo(logical)<1e-6,key+' suelta');
    if (!data.thrown) assert.ok(point(data.contacts.muzzle).distanceTo(logical)<1e-6,key+' boca del arte');
    const reference=fixture[key+'|hip-idle|0|0'];
    if (reference) {
      assert.ok(logical.distanceTo(new Vector3(...reference.m))<0.02,key+' fixture posición');
      const axis=new Vector3(0,0,-1).transformDirection(data.contacts.muzzle.matrixWorld);
      assert.ok(axis.angleTo(new Vector3(...reference.d))<Math.PI/360,key+' fixture eje');
    }
    // El mismo montaje se mantiene al correr, agacharse, inclinarse o golpear.
    for (const pose of [{}, {aim:true}, {state:'run',speed:1}, {state:'roadie',speed:1},
      {state:'crouch'}, {aim:true,coverLean:-1}, {aim:true,coverLean:1}, {state:'melee',meleePhase:0.5}, {reloading:true,reloadT:0.45}]) {
      for (let i=0; i<55; i++) rig.update(1/60,{...idle,...pose});
      scene.updateMatrixWorld(true);
      for (const surface of weaponSurfaces) {
        const i = surface.index;
        surface.bone.matrixWorld.multiplyMatrices(baked.skeleton.bones[i].matrixWorld, baked.skeleton.boneInverses[i]);
        prepare(surface);
      }
      for (const [bone, glove] of gloves) {
        const left = bone.name.endsWith('_L');
        if (left && (pose.reloading || (data.oneHand && (!pose.aim || data.thrown)))) continue;
        const gap = clearance(glove, weaponSurfaces);
        worstGap = Math.max(worstGap, Math.abs(gap));
        if (!pose.state && !pose.reloading && !pose.coverLean) {
          assert.ok(broadContact(glove, weaponSurfaces), key+' '+bone.name+' extensión del contacto');
        }
        assert.ok(Math.abs(gap) < 3, key+' '+bone.name+' '+JSON.stringify(pose)+' contacto '+gap.toFixed(2)+' mm');
      }
    }
    rig.fireWeaponParts();
    const moving=data.weaponParts;
    let moved=false;
    for(let i=0;i<48;i++) {
      rig.update(1/60,idle);
      const part=moving.slide ?? moving.pump ?? moving.bolt;
      if (part && part.bone.position.distanceTo(part.rest)>0.015) moved=true;
    }
    if (moving.slide || moving.bolt || moving.pump) assert.ok(moved,key+' ciclo del tiro');
    for(let i=0;i<30;i++) rig.update(1/60,{...idle,reloading:true,reloadT:0.4});
    if (['pistol','stun','smg','shotgun'].includes(key)) {
      assert.ok(moving.mag.bone.position.distanceTo(moving.mag.rest)>0.08,key+' extracción');
      const heel=data.contacts.mag.position.clone().sub(moving.mag.rest);
      moving.mag.bone.localToWorld(heel);
      assert.ok(heel.distanceTo(point(rig.armL.hand))<1e-5,key+' cargador en mano');
    }
    if (key==='sniper') assert.ok(Math.abs(moving.bolt.bone.rotation.z)>0.8 && moving.bolt.bone.position.z>moving.bolt.rest.z+0.10);
    if (key==='bazooka') assert.ok(moving.cap.bone.rotation.z>0.4);
    if (data.thrown) {
      for (let i=0;i<12;i++) rig.update(1/60,{...idle,throwT:0.20,throwTotal:0.5});
      assert.ok(moving.pin.bone.position.distanceTo(moving.pin.rest)>0.05,key+' anilla extraída');
      assert.equal(moving.spoon.bone.rotation.x,0,key+' palanca retenida');
      rig.update(1/60,{...idle,throwT:0.04,throwTotal:0.5,throwReleased:true});
      assert.ok(moving.spoon.bone.rotation.x>0.15,key+' palanca suelta');
    }
    const other=key==='shotgun'?'smg':'shotgun';
    rig.setWeapon(other,key);
    assert.equal(gun.parent,rig.backMount);
    assert.ok(gun.visible,key+' visible a la espalda');
    for (const part of Object.values(moving)) {
      assert.ok(part.bone.position.distanceTo(part.rest)<1e-6,key+' pieza guardada');
      assert.equal(part.bone.scale.x,1);
    }
    assert.equal(data.bakedMesh,baked);
    pickups.spawn(key,0,0); drops.spawn(key,key,0,0,'blue');
    for (const [model, team] of [[pickups.active.model, 'red'], [drops.drops.get(key).mesh, 'blue']]) {
      await model.userData.visualReady;
      const pickup = model.userData.bakedMesh;
      const geom = pickup.geometry;
      const pickupShader = shaderFor(pickup.material);
      assert.equal(pickupShader.uniforms.uVmFill, shader.uniforms.uVmFill);
      assert.equal(pickup.material.userData.soldierLook, team);
      assert.ok(!pickupShader.uniforms.uVMProj);
      assert.deepEqual(geom.attributes.position.array,baked.geometry.attributes.position.array);
      for (const attr of ['color','aSurf','aWear','aDetail']) assert.deepEqual(geom.attributes[attr].array,baked.geometry.attributes[attr].array);
    }
    drops.remove(key); pickups.clear();
    console.log(key, w.length+' tris', length.toFixed(4)+' m', (worst*100).toFixed(2)+' % de silueta', worstGap.toFixed(2)+' mm de contacto');
  }
  // Repite la tabla completa sobre el eje y el punto del ARTE montado.
  // Usa las mismas tolerancias aprobadas que check-fire-direction.
  class MountedRig extends Rig {
    muzzleWorld(out) { return this.activeGun.userData.contacts.muzzle.getWorldPosition(out); }
    gunForward(out) {
      const node=this.activeGun.userData.contacts.muzzle;
      node.updateWorldMatrix(true,false);
      return out.set(0,0,-1).transformDirection(node.matrixWorld);
    }
  }
  const now=await measure(MountedRig);
  for (const [key,ref] of Object.entries(fixture)) {
    const [weapon,state,pitch]=key.split('|');
    const fwd=state==='open-ads' ? ADS_WEAPON_POSES[weapon].fwd : 0;
    const dir=new Vector3(...ref.d);
    const delta=new Vector3(...now[key].m).sub(new Vector3(...ref.m)).addScaledVector(dir,-fwd);
    const limit=state==='blind_over' ? (Number(pitch)<0 ? 0.06 : 0.22) : fwd ? 0.15 : 0.02;
    assert.ok(delta.length()<=limit,key+' boca');
    assert.ok(new Vector3(...now[key].d).angleTo(dir)<=Math.PI/360,key+' eje');
  }
  console.log(Object.keys(now).length+' poses del GLB contra fire-reference.json');
} finally {
  rig.dispose(scene);
  GLTFLoader.prototype.loadAsync=loader;
  if (oldLocation===undefined) delete globalThis.location; else globalThis.location=oldLocation;
}
