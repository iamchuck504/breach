import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 const report=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js'),{Rig}=await import('/src/player/rig.js'),{Controller}=await import('/src/player/controller.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const scene=new T.Scene(),w=new World(scene,'calle2'),rig=new Rig(scene,'red');await rig.visualReady;w.mapGroup.updateMatrixWorld(true);
  const results=[];
  for(const face of w.faces.filter(f=>f.peekMargin&&Math.abs(f.a.z)<30)){
   const edge=Math.abs(face.a.x)<Math.abs(face.b.x)?face.a:face.b,sign=edge===face.a?-1:1;
   for(const aim of [false,true])for(const weapon of ['pistol','smg','shotgun','sniper','bazooka']){
    const cam={yaw:Math.atan2(face.n.x,face.n.z),pitch:0,flatForward:()=>({x:-face.n.x,z:-face.n.z}),flatRight:()=>({x:-face.n.z,z:face.n.x})};
    const p=new Controller(w,cam);p.state='cover';p.cover=face;p.pos={x:edge.x-sign*.5,z:edge.z+face.n.z*face.standOff};p.yaw=cam.yaw;
    rig.setWeapon(weapon);
    const input={moveVec:()=>({x:0,z:0}),aimHeld:aim,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
    for(let i=0;i<120;i++){p.update(1/60,input,true);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,p.animParams());}
    const muzzle=rig.muzzleWorld(new T.Vector3()),dir=rig.gunForward(new T.Vector3());
    const ray=new T.Raycaster(muzzle,dir,.001,1.5),hit=ray.intersectObjects(w._getImpactReceivers(),false)[0];
    if(hit && /District_|Existing_envelope/.test(hit.object.name))throw Error(JSON.stringify({edge,aim,weapon,hit:hit.object.name,distance:hit.distance,muzzle,pos:p.pos}));
    // A dumpster/car farther down the avenue is a legitimate shot target.
    if(Math.abs(muzzle.x)>=15.69)throw Error('barrel has not cleared street frame');
    if(!aim){
     const head=new T.Box3().setFromObject(rig.head);
     const inner=edge.x>0?head.min.x:-head.max.x;
     if(inner<15.69-(head.max.x-head.min.x)*.4)throw Error(JSON.stringify({reason:'excessive helmet exposure',edge,weapon,inner,muzzle}));
     for(const [arm,anchor] of [[rig.armR,rig.activeGun.userData.grip],[rig.armL,rig.activeGun.userData.blindSupport]]){
      const error=arm.hand.getWorldPosition(new T.Vector3()).distanceTo(anchor.getWorldPosition(new T.Vector3()));
      if(error>.025)throw Error(JSON.stringify({reason:'hand off grip',edge,weapon,error}));
     }
    }
    if(p.state!=='cover')throw Error('lost cover');
    results.push({edge,aim,weapon});
   }
  }return {samples:results.length};
 });assert.equal(report.samples,80);console.log('ALLEY PEEK OK',report);
}finally{await browser.close();}
