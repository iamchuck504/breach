import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?nolock=1');
 const report=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js'),{Rig}=await import('/src/player/rig.js');
  const {Controller,PLAYER_R}=await import('/src/player/controller.js');
  const {expandedCollisionBoxes}=await import('/src/world/collision-layouts.js');
  const world=new World(new T.Scene(),'azoteas'),rig=new Rig(world.scene??new T.Scene(),'red');await rig.visualReady;
  const faces=world.faces.filter(f=>f.standOff),results=[];
  for(const b of expandedCollisionBoxes('azoteas'))if(!world.colliders.some(c=>['minx','maxx','minz','maxz','h'].every(k=>Math.abs(c[k]-b[k])<1e-6)))throw Error('colliders changed');
  for(const f of faces){
   const x=(f.a.x+f.b.x)/2,z=(f.a.z+f.b.z)/2;
   const start={x:x+f.n.x*1.4,z:z+f.n.z*1.4};
   const found=world.findCover(start,{x:-f.n.x,z:-f.n.z},2,PLAYER_R);if(found?.face!==f)continue;
   const cam={yaw:Math.atan2(-f.n.x,-f.n.z),pitch:0,flatForward:()=>f.n,flatRight:()=>({x:-f.n.z,z:f.n.x})};
   const p=new Controller(world,cam);p.state='cover';p.cover=f;p.pos={...found.target};p.yaw=cam.yaw;
   const input={moveVec:()=>({x:0,z:0}),aimHeld:false,sprintHeld:false,jumpPressed:false,meleePressed:false,evadePressed:false};
   for(let i=0;i<100;i++){p.update(1/60,input,false);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,p.animParams());}
   rig.root.updateMatrixWorld(true);let clearance=Infinity;
   rig.root.traverse(o=>{if(!o.isMesh)return;for(let p=o;p;p=p.parent)if(!p.visible)return;const b=new T.Box3().setFromObject(o);
    const nearestX=f.n.x>0?b.min.x:b.max.x,nearestZ=f.n.z>0?b.min.z:b.max.z;
    clearance=Math.min(clearance,(nearestX-x)*f.n.x+(nearestZ-z)*f.n.z-.02);
   });
   if(clearance<0)throw Error('penetration '+JSON.stringify({x,z,clearance,pos:p.pos}));results.push(clearance);
  }
  return {faces:faces.length,samples:results.length,min:Math.min(...results)};
 });assert.equal(report.faces,8);assert.ok(report.samples>=4);console.log('Rooftop cover OK',report);
}finally{await browser.close();}
