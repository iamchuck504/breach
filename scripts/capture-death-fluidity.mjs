import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 const image=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');const {Rig}=await import('/src/player/rig.js');
  const scene=new T.Scene();scene.background=new T.Color(0x202b37);
  scene.add(new T.HemisphereLight(0xd5e6ff,0x433b34,2));const sun=new T.DirectionalLight(0xffdeb7,3);sun.position.set(3,6,4);scene.add(sun);
  const floor=new T.Mesh(new T.PlaneGeometry(10,10),new T.MeshStandardMaterial({color:0x485361,roughness:.9}));floor.rotation.x=-Math.PI/2;scene.add(floor);
  const rig=new Rig(scene,'red');await rig.visualReady;
  rig.groundFn=()=>0;const camera=new T.PerspectiveCamera(42,1,.05,30);camera.position.set(3,2.4,4);camera.lookAt(0,.7,0);
  const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(420,420);
  const sheet=document.createElement('canvas');sheet.width=1680;sheet.height=460;const c=sheet.getContext('2d');c.fillStyle='#111a23';c.fillRect(0,0,1680,460);
  for(let i=0;i<60;i++)rig.update(1/60,{state:'run',speed:1,aim:false,moveForward:1});
  rig.setDeathContext({state:'run',vel:{x:1,z:-4},impact:{x:.4,z:1},power:.8});
  let t=0;
  for(const [i,time] of [.1,.28,.43,1.3].entries()){
   while(t<time-1e-6){rig.update(1/60,{state:'dead',speed:0,aim:false});t+=1/60;}
   renderer.render(scene,camera);c.drawImage(renderer.domElement,i*420,0);
   c.fillStyle='#e4eaf0';c.font='20px sans-serif';c.fillText(`${time.toFixed(2)} s`,i*420+18,447);
  }
  renderer.dispose();return sheet.toDataURL();
 });
 await fs.mkdir('artifacts/animation-fluidity',{recursive:true});
 await fs.writeFile('artifacts/animation-fluidity/death-sequence.png',Buffer.from(image.split(',')[1],'base64'));
 console.log('Death sequence captured with the equipped Blender character.');
}finally{await browser.close();}
