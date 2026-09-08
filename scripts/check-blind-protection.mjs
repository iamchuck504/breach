import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try {
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {Rig}=await import('/src/player/rig.js'),{Controller}=await import('/src/player/controller.js'),{World}=await import('/src/world/world.js');
  const scene=new T.Scene();scene.background=new T.Color(0x303c48);
  scene.add(new T.HemisphereLight(0xffffff,0x788695,2.5));
  const light=new T.DirectionalLight(0xffffff,2);light.position.set(-3,6,4);scene.add(light);
  const floor=new T.Mesh(new T.PlaneGeometry(30,30),new T.MeshStandardMaterial({color:0x52606b}));floor.rotation.x=-Math.PI/2;scene.add(floor);
  const rig=new Rig(scene,'red');await rig.visualReady;
  const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(400,440);
  const sheet=document.createElement('div');sheet.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#18222b;color:white;font:18px Arial;display:grid;grid-template-columns:repeat(4,400px);grid-template-rows:60px 470px 470px';
  const heading=document.createElement('div');heading.style.cssText='grid-column:1/5;padding:16px';heading.textContent='MISMA COBERTURA · modelo real · vista desde la dirección del tiro';sheet.append(heading);
  let samples=0;
  for(const height of [3,1.1])for(const side of [-1,1])for(const aim of [false,true]){
   const box={minx:-2,maxx:2,minz:-2,maxz:0,h:height};
   const face={a:{x:-2,z:0},b:{x:2,z:0},n:{x:0,z:1},h:height,topY:height,kind:height<2?'low':'high',collider:box};
   const w=Object.create(World.prototype);w.colliders=[box];w.segmentColliders=[];w.faces=[face];w.groundHeight=()=>0;w.ceilingHeight=()=>Infinity;
   const wall=new T.Mesh(new T.BoxGeometry(4,height,2),new T.MeshStandardMaterial({color:0x697682}));wall.position.set(0,height/2,-1);scene.add(wall);
   // Extreme pitches exercise physical blindfire. ADS uses its separate
   // camera-guided shot solver; the pose comparison uses the central range.
   for(const weapon of ['pistol','smg','shotgun','sniper','bazooka'])for(const pitch of (aim?[-.25,0,.25]:[-.5,-.25,0,.25,.5])){
    const cam={yaw:0,pitch,flatForward:()=>({x:0,z:-1}),flatRight:()=>({x:1,z:0})};
    const p=new Controller(w,cam);p.pos={x:side*1.5,z:.38};p.state='cover';p.cover=face;p.yaw=0;
    rig.setWeapon(weapon);
    const input={moveVec:()=>({x:0,z:0}),aimHeld:aim,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
    for(let i=0;i<120;i++){p.update(1/60,input,true);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,p.animParams());}
    const muzzle=rig.muzzleWorld(new T.Vector3()),direction=rig.gunForward(new T.Vector3());
    if(w.raycast(muzzle,direction,5)!==null)throw Error(JSON.stringify({height,side,weapon,pitch,aim,muzzle,direction,reason:'barrel obstructed'}));
    if(!aim){
     const head=new T.Box3().setFromObject(rig.head),edge=side<0?-head.min.x:head.max.x;
     if(edge>2)throw Error(`${height} ${side} ${weapon}: helmet exposed ${edge}`);
     for(const [arm,anchor] of [[rig.armR,rig.activeGun.userData.grip],[rig.armL,rig.activeGun.userData.blindSupport]]){
      if(arm.hand.getWorldPosition(new T.Vector3()).distanceTo(anchor.getWorldPosition(new T.Vector3()))>.025)throw Error(`${height} ${side} ${weapon}: hand detached`);
     }
    }
    if(weapon==='smg'&&pitch===0){
     const camera=new T.PerspectiveCamera(40,400/440,.03,100);
     camera.position.set(side*2.0,height<2?.85:1.20,-5);camera.lookAt(side*2.0,height<2?.75:1.1,.2);
     renderer.render(scene,camera);
     const cell=document.createElement('div'),label=document.createElement('div'),img=document.createElement('img');
     label.textContent=`${height<2?'Baja':'Alta'} · ${side<0?'Izquierda':'Derecha'} · ${aim?'AIM':'BLINDFIRE'}`;label.style.cssText='height:30px;text-align:center';
     img.src=renderer.domElement.toDataURL();cell.append(label,img);sheet.append(cell);
    }
    samples++;
    if(aim){
     input.aimHeld=false;
     for(let i=0;i<24;i++){
      p.update(1/60,input,true);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,p.animParams());
      if(p.fireAligned()&&p.blindPoseExposure>=.62&&w.raycast(rig.muzzleWorld(new T.Vector3()),rig.gunForward(new T.Vector3()),5)!==null){
       throw Error(`${height} ${side} ${weapon} ${pitch}: transition shot blocked at frame ${i}`);
      }
     }
    }
   }
   scene.remove(wall);wall.geometry.dispose();wall.material.dispose();
  }
  document.body.replaceChildren(sheet);renderer.dispose();return {samples};
 });
 assert.equal(result.samples,160);await page.screenshot({path:'artifacts/blind-vs-aim-protection.png'});
 console.log('BLIND PROTECTION OK',result,'real helmets, both hands, high/low edges, five weapons, extended blindfire pitches');
}finally{await browser.close();}
