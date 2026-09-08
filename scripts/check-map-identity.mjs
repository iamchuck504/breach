import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const dir='artifacts/map-identity';await fs.mkdir(dir,{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5200/?nolock=1');
 const reports=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const {expandedCollisionBoxes}=await import('/src/world/collision-layouts.js');
  const scene=new T.Scene(),world=new World(scene,'fortaleza'),out=[];
  const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(1280,720);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  const camera=new T.PerspectiveCamera(60,1280/720,.1,250);
  const positions={fortaleza:[['keep',[4,2,-5],[0,1.6,0]],['armoury',[-23.1,4.6,-7],[-25.5,4.4,0]]],
    azoteas:[['landing',[6,3,-17],[0,1.2,-7]],['access',[6,2,-25],[0,2,-31]]],
    calle2:[['cordon',[10.5,2,32],[9,2,42]],['service',[-24,2,-16],[-26,1,-10]]]};
  for(const layout of Object.keys(positions)){
   world.setLayout(layout,true);const root=world.mapGroup.getObjectByName(`map-identity:${layout}`);
   const key=b=>[b.minx,b.maxx,b.minz,b.maxz,b.h,b.minY??0];
   const same=JSON.stringify(world.colliders.map(key))===JSON.stringify(expandedCollisionBoxes(layout).map(key));
   let triangles=0,finite=true,lights=0;
   root.traverse(o=>{if(o.isLight)lights++;if(o.isMesh){triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.count??1);finite&&=Array.from(o.matrixWorld.elements).every(Number.isFinite);}});
   const views=[];
   for(const [name,pos,target] of positions[layout]){
    camera.position.set(...pos);camera.lookAt(...target);root.visible=true;renderer.render(scene,camera);
    const calls=renderer.info.render.calls,image=renderer.domElement.toDataURL();
    root.visible=false;renderer.render(scene,camera);const baseCalls=renderer.info.render.calls;root.visible=true;
    views.push({name,image,addedCalls:calls-baseCalls});
   }
   out.push({layout,same,finite,lights,triangles,zones:root.userData.zones,views});
  }
  renderer.dispose();return out;
 });
 for(const r of reports){
  assert(r.same&&r.finite&&r.lights===0&&r.triangles<1000,JSON.stringify(r));
  for(const v of r.views){assert(v.addedCalls<35);await fs.writeFile(`${dir}/${r.layout}-${v.name}.png`,Buffer.from(v.image.split(',')[1],'base64'));delete v.image;}
 }
 assert.deepEqual(errors,[]);await fs.writeFile(`${dir}/report.json`,JSON.stringify(reports,null,2));
 console.log('MAP IDENTITY OK',JSON.stringify(reports));
}finally{await browser.close();}
