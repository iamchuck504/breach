import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?nolock=1');
 console.log(JSON.stringify(await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const report=[];
  for(const map of ['fortaleza','azoteas','calle2']){
   const world=new World(new T.Scene(),map);world.mapGroup.updateMatrixWorld(true);
   const hits=[],meshes=[];world.mapGroup.traverse(o=>{if(o.isMesh)meshes.push(o);});
   for(const f of world.faces.filter(f=>f.h>=2.5)){
    const x=(f.a.x+f.b.x)/2,z=(f.a.z+f.b.z)/2;
    for(const height of [.9,1.4]){
     const origin=new T.Vector3(x+f.n.x*1.5,(f.baseY??0)+height,z+f.n.z*1.5);
     const ray=new T.Raycaster(origin,new T.Vector3(-f.n.x,0,-f.n.z),0,1.7);
     const hit=ray.intersectObjects(meshes,false).find(h=>{for(let p=h.object;p;p=p.parent)if(!p.visible)return false;return true;});
     if(hit){const projection=1.5-hit.distance;if(projection>.1&&projection<.9)hits.push({x,z,height,projection,mesh:hit.object.name,standOff:f.standOff??.38});}
    }
   }
   report.push({map,faces:world.faces.length,projections:hits});
  }
  return report;
 }),null,2));
}finally{await browser.close();}
