import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 console.log(await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js'),{Rig}=await import('/src/player/rig.js'),{Controller}=await import('/src/player/controller.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const scene=new T.Scene(),w=new World(scene,'calle2'),rig=new Rig(scene,'red');await rig.visualReady;w.mapGroup.updateMatrixWorld(true);
  const results=[];
  for(const face of w.faces.filter(f=>f.standOff))for(const edge of [face.a,face.b]){
   if(Math.abs(edge.z)>30)continue;
   const sign=edge===face.a?-1:1;
   for(const aim of [false,true])for(const angle of [-1.2,-.6,0,.6,1.2]){
    const cam={yaw:Math.atan2(face.n.x,face.n.z)+angle,pitch:0,flatForward:()=>({x:-Math.sin(cam.yaw),z:-Math.cos(cam.yaw)}),flatRight:()=>({x:Math.cos(cam.yaw),z:-Math.sin(cam.yaw)})};
    const p=new Controller(w,cam);p.state='cover';p.cover=face;p.pos={x:edge.x+face.n.x*face.standOff,z:edge.z-sign*.5};p.yaw=cam.yaw;
    const input={moveVec:()=>({x:0,z:0}),aimHeld:aim,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
    for(let i=0;i<120;i++){p.update(1/60,input,true);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,p.animParams());}
    const muzzle=rig.muzzleWorld(new T.Vector3()),dir=new T.Vector3(-Math.sin(cam.yaw),0,-Math.cos(cam.yaw));
    const ray=new T.Raycaster(muzzle,dir,.001,1.5),hit=ray.intersectObjects(w._getImpactReceivers(),false)[0];
    if(hit)results.push({edge:edge.z,x:edge.x,aim,angle,pos:p.pos,hit:hit?.object.name,distance:hit?.distance});
   }
  }return results;
 }));
}finally{await browser.close();}
