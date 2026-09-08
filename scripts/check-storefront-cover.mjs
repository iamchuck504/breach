import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();
 await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 const report=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {Rig}=await import('/src/player/rig.js');
  const {World}=await import('/src/world/world.js');
  const {Controller,PLAYER_R}=await import('/src/player/controller.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');
  const {expandedCollisionBoxes}=await import('/src/world/collision-layouts.js');
  await preloadUrbanAssets();
  const scene=new T.Scene(),world=new World(scene,'calle2');
  const rig=new Rig(scene,'red');await rig.visualReady;
  const faces=world.faces.filter(f=>f.standOff&&f.n.x!==0),samples=[];
  if(faces.length!==6)throw Error('Expected all six street-facing building strips');
  for(const b of expandedCollisionBoxes('calle2'))if(!world.colliders.some(c=>
   ['minx','maxx','minz','maxz','h'].every(k=>Math.abs(c[k]-b[k])<1e-6)))throw Error('Collision parity changed');
  const input={moveVec:()=>({x:0,z:0}),aimHeld:false,sprintHeld:false,jumpPressed:false,meleePressed:false,evadePressed:false};
  for(const face of faces)for(const u of [.15,.5,.85]){
   const side=-face.n.x;
   const wallZ=face.a.z+(face.b.z-face.a.z)*u;
   const start={x:face.a.x+face.n.x*1.7,z:wallZ};
   const found=world.findCover(start,{x:-face.n.x,z:0},2,PLAYER_R);
   if(!found)continue; // Street furniture can legitimately obstruct a slot.
   if(found.face!==face)throw Error('Unexpected cover face');
   const camera={yaw:Math.atan2(-face.n.x,0),pitch:0,flatForward:()=>face.n,flatRight:()=>({x:0,z:side})};
   const player=new Controller(world,camera);player.state='cover';player.cover=face;player.pos={...found.target};player.yaw=camera.yaw;
   const positions=[];
   for(let frame=0;frame<90;frame++){
    player.update(1/60,input,false);if(frame>70)positions.push(player.pos.x);
   }
   if(player.state!=='cover'||Math.max(...positions)-Math.min(...positions)>.001)throw Error('Cover jitter');
   for(const lat of [-1,0,1]){
    for(let frame=0;frame<90;frame++){
     rig.setTransform(player.pos.x,player.pos.z,player.yaw,player.y);
     rig.update(1/60,{...player.animParams(),latMove:lat});
    }
    rig.root.updateMatrixWorld(true);let closest=-Infinity;
    rig.root.traverse(o=>{
     if(!o.isMesh)return;for(let p=o;p;p=p.parent)if(!p.visible)return;
     const b=new T.Box3().setFromObject(o);closest=Math.max(closest,side>0?b.max.x:-b.min.x);
    });
    const clearance=15.69-closest;
    if(clearance<0)throw Error(JSON.stringify({clearance,side,wallZ,lat,pos:player.pos,yaw:player.yaw,standOff:player.cover.standOff,target:found.target,closest}));
    samples.push({side,z:wallZ,lat,clearance});
   }
  }
  return {faces:faces.length,samples:samples.length,minClearance:Math.min(...samples.map(s=>s.clearance))};
 });
 assert(report.samples>=36);console.log('STOREFRONT COVER OK',JSON.stringify(report));
}finally{await browser.close();}
