import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
 await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
 for(const height of ['high','low'])for(const side of [-1,1]){
  await page.evaluate(async({height,side,blind})=>{
   const T=await import('/node_modules/three/build/three.module.js'),{Rig}=await import('/src/player/rig.js');
   const scene=new T.Scene();scene.background=new T.Color(0x303841);
   scene.add(new T.HemisphereLight(0xffffff,0x7b889b,2.8));
   const light=new T.DirectionalLight(0xffffff,2);light.position.set(3,5,3);scene.add(light);
   const rig=new Rig(scene,'red');await rig.visualReady;rig.setWeapon('smg');
   for(let i=0;i<120;i++)rig.update(1/60,{state:blind?`blind_${height}_${side<0?'left':'right'}`:'cover_'+height,aim:!blind,aimPitch:0,coverLean:side,coverAimExposure:1,blindPoseExposure:1});
   const ground=new T.Mesh(new T.PlaneGeometry(30,30),new T.MeshStandardMaterial({color:0x48515b,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.1;scene.add(ground);
   const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(400,390);
   const sheet=document.createElement('div');sheet.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#202832;color:white;font:18px Arial;display:grid;grid-template-columns:repeat(4,400px);grid-template-rows:60px 420px 420px';
   const title=document.createElement('div');title.style.cssText='grid-column:1/5;padding:18px';title.textContent=`APUNTADO · COBERTURA ${height==='high'?'ALTA':'BAJA'} · SALIDA ${side<0?'IZQUIERDA':'DERECHA'} — sin pared para inspeccionar las articulaciones`;sheet.append(title);
   const labels=['Frente','Frontal derecha','Derecha','Trasera derecha','Espalda','Trasera izquierda','Izquierda','Frontal izquierda'];
   for(let i=0;i<8;i++){
    const angle=Math.PI+i*Math.PI/4,camera=new T.PerspectiveCamera(38,400/390,.01,100);
    const targetY=height==='high'?.95:.65;
    camera.position.set(Math.sin(angle)*3.3,targetY+1.0,Math.cos(angle)*3.3);camera.lookAt(0,targetY,0);
    renderer.render(scene,camera);
    const cell=document.createElement('div'),label=document.createElement('div'),img=document.createElement('img');
    label.textContent=labels[i];label.style.cssText='height:30px;text-align:center';img.src=renderer.domElement.toDataURL();img.style.cssText='width:400px;height:390px';cell.append(label,img);sheet.append(cell);
   }
   document.body.replaceChildren(sheet);renderer.dispose();
  },{height,side,blind:process.argv.includes('--blind')});
  await page.screenshot({path:`artifacts/${process.argv.includes('--blind')?'blind':'cover'}-${height}-${side<0?'left':'right'}-angles.png`});
 }
}finally{await browser.close();}
