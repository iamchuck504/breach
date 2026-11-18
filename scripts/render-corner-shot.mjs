import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const b=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await b.newPage({viewport:{width:1400,height:1000}});
 await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 await page.evaluate(async(blind)=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js'),{Rig}=await import('/src/player/rig.js'),{Controller}=await import('/src/player/controller.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const s=new T.Scene(),w=new World(s,'calle2'),r=new Rig(s,'red');await r.visualReady;r.setWeapon('smg');
  const face=w.faces.find(f=>f.peekMargin&&f.a.x>0&&Math.abs(f.a.z-15.8)<.01);
  const edge=face.a.x<face.b.x?face.a:face.b;
  const cam={yaw:Math.atan2(face.n.x,face.n.z),pitch:0,flatForward:()=>({x:-face.n.x,z:-face.n.z}),flatRight:()=>({x:-face.n.z,z:face.n.x})};
  const p=new Controller(w,cam);p.state='cover';p.cover=face;p.pos={x:edge.x+.5,z:edge.z+face.n.z*face.standOff};p.yaw=cam.yaw;
  const input={moveVec:()=>({x:0,z:0}),aimHeld:!blind,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
  for(let i=0;i<120;i++){p.update(1/60,input,true);r.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);r.update(1/60,p.animParams());}
  r.kick(.5);r.update(1/60,p.animParams());
  const camera=new T.PerspectiveCamera(48,1.4,.03,250);
  camera.position.set(p.pos.x-2.2,2.5,p.pos.z+face.n.z*2.8);
  camera.lookAt(p.pos.x+.2,1.15,p.pos.z-face.n.z*.3);
  const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(1400,1000);
  document.body.replaceChildren(renderer.domElement);renderer.domElement.style.cssText='position:fixed;inset:0;z-index:2147483647';
  renderer.render(s,camera);
  window.cornerCapture={s,camera,renderer,p,face};
 },process.argv.includes('--blind'));
 const mode=process.argv.includes('--blind')?'blind':'aim';
 await page.screenshot({path:`artifacts/corner-${mode}-current.png`});
 for(const [name,dx,dz] of [['lateral',-3,0],['frontal',-2,-2.8],['diagonal',-3,-1.5],['elevada',-2.5,1]]){
  await page.evaluate(({dx,dz,name})=>{
   const {s,camera,renderer,p,face}=window.cornerCapture;
   camera.position.set(p.pos.x+dx,name==='elevada'?3.8:1.8,p.pos.z+face.n.z*dz);
   camera.lookAt(p.pos.x,1.15,p.pos.z);renderer.render(s,camera);
  },{dx,dz,name});
  await page.screenshot({path:`artifacts/corner-${mode}-${name}.png`});
 }
}finally{await b.close();}
