import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const tag=process.argv[2]||'trial';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}});
 await page.goto('http://127.0.0.1:5200/?nolock=1');
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const {World}=await import('/src/world/world.js');
  const scene=new T.Scene(),start=performance.now(),world=new World(scene,'calle2');
  const buildMs=performance.now()-start;
  const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(1280,720);renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  const camera=new T.PerspectiveCamera(55,1280/720,.1,250),gl=renderer.getContext(),views=[];
  for(const [name,pos,target] of [['street',[8,2.4,-27],[-3,1.7,4]],['alley',[-25,2.3,-9],[-29.1,6.4,0]],['aerial',[0,88,70],[0,0,0]]]){
   camera.position.set(...pos);camera.lookAt(...target);
   for(let i=0;i<8;i++)renderer.render(scene,camera);gl.finish();
   const timings=[];
   for(let i=0;i<15;i++){const t=performance.now();renderer.render(scene,camera);gl.finish();timings.push(performance.now()-t);}
   timings.sort((a,b)=>a-b);
   const pixels=new Uint8Array(1280*720*4);gl.readPixels(0,0,1280,720,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))).map(n=>n.toString(16).padStart(2,'0')).join('');
   views.push({name,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,medianMs:timings[7],hash,image:renderer.domElement.toDataURL()});
  }
  let batches=0;world.mapGroup.traverse(o=>{if(o.name==='calle2-instanced-upper-facades')batches++;});
  const report={buildMs,batches,geometries:renderer.info.memory.geometries,colliders:world.colliders.map(b=>[b.minx,b.maxx,b.minz,b.maxz,b.h]),views};
  renderer.dispose();return report;
 });
 await fs.mkdir('artifacts/performance',{recursive:true});
 for(const v of result.views){await fs.writeFile(`artifacts/performance/${tag}-${v.name}.png`,Buffer.from(v.image.split(',')[1],'base64'));delete v.image;}
 await fs.writeFile(`artifacts/performance/${tag}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,colliders:result.colliders.length},null,2));
}finally{await browser.close();}
