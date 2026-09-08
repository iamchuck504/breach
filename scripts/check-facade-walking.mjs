import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?nolock=1');
 const report=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js');
  const {Rig}=await import('/src/player/rig.js');
  const rig=new Rig(new T.Scene(),'red');await rig.visualReady;
  let bodyExtent=0;
  for(const weapon of ['pistol','smg','shotgun','sniper','bazooka']){
   rig.setWeapon(weapon);
   for(let i=0;i<120;i++)rig.update(1/60,{state:'idle',speed:0,aim:false,aimPitch:0});
   rig.root.updateMatrixWorld(true);
   rig.root.traverse(o=>{
    if(!o.isMesh)return;
    for(let p=o;p;p=p.parent)if(!p.visible||p===rig.gunMount||p===rig.backMount)return;
    const b=new T.Box3().setFromObject(o);
    bodyExtent=Math.max(bodyExtent,-b.min.z,b.max.z,-b.min.x,b.max.x);
   });
  }
  if(bodyExtent>.82)throw Error(`Body envelope too small: ${bodyExtent}`);
  const results=[];
  for(const map of ['fortaleza','azoteas','calle2']){
   const world=new World(new T.Scene(),map),before=JSON.stringify(world.colliders);
   let samples=0;
   for(const f of world.faces.filter(f=>f.bodyStandOff)){
    const x=(f.a.x+f.b.x)/2,z=(f.a.z+f.b.z)/2;
    const p={x:x+f.n.x*(f.bodyStandOff+.1),z:z+f.n.z*(f.bodyStandOff+.1)};
    const probe={...p};world.resolveCircle(probe,.38,0);
    if(Math.hypot(probe.x-p.x,probe.z-p.z)>.001)continue;
    for(let i=0;i<120;i++){
     p.x-=f.n.x*.04;p.z-=f.n.z*.04;
     world.resolveCircle(p,.38,0);world.resolveFacadeBody(p,.38,0);
    }
    const distance=(p.x-x)*f.n.x+(p.z-z)*f.n.z;
    if(distance<f.bodyStandOff-1e-5)throw Error(`${map}: body penetration ${distance}`);
    const resting={...p};
    for(let i=0;i<120;i++)world.resolveFacadeBody(p,.38,0);
    if(Math.hypot(p.x-resting.x,p.z-resting.z)>1e-6)throw Error(`${map}: resting jitter`);
    samples++;
   }
   if(before!==JSON.stringify(world.colliders))throw Error('ballistic geometry changed');
   results.push({map,samples});
  }
  return results;
 });for(const r of report)assert.ok(r.samples>0);console.log('Facade body contact OK',report);
}finally{await browser.close();}
