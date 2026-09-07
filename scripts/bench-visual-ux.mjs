import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const tag=process.argv[2]||'after',dir=`artifacts/visual-ux/${tag}`;
await fs.mkdir(dir,{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}});
 await page.goto('http://127.0.0.1:5200/?nolock=1');
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');
  const loadStart=performance.now(),assets=await preloadUrbanAssets(),loadMs=performance.now()-loadStart;
  const {World}=await import('/src/world/world.js');const scene=new T.Scene();
  const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(1280,720);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  const gl=renderer.getContext(),camera=new T.PerspectiveCamera(55,1280/720,.1,250),reports=[];
  const world=new World(scene,'fortaleza');
  for(const map of ['fortaleza','azoteas','calle','calle2','metro','prision','pueblo','foundry','arena']){
   const begin=performance.now();world.setLayout(map,true);const buildMs=performance.now()-begin;
   const views=[];
   for(const [name,pos,target] of [['ground',[world.fx*.33,2.3,-world.fz*.72],[0,1.6,0]],['aerial',[world.fx*1.1,world.fz*1.65,world.fz*1.65],[0,0,0]]]){
    camera.position.set(...pos);camera.lookAt(...target);
    for(let i=0;i<4;i++)renderer.render(scene,camera);gl.finish();
    const times=[];for(let i=0;i<12;i++){const t=performance.now();renderer.render(scene,camera);gl.finish();times.push(performance.now()-t);}
    times.sort((a,b)=>a-b);views.push({name,medianMs:times[6],p95Ms:times[11],fpsEquivalent:1000/times[6],calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,image:renderer.domElement.toDataURL()});
   }
   const collision=world.colliders.map(b=>[b.minx,b.maxx,b.minz,b.maxz,b.h,b.minY??0]);
   reports.push({map,buildMs,collision,spawns:world.spawns,pickups:world.cratePos,special:world.specialSpot,memory:{...renderer.info.memory},views});
  }
  const cycles=[];for(let i=0;i<4;i++){world.setLayout('calle2',true);renderer.render(scene,camera);cycles.push({...renderer.info.memory});}
  const report={assets,loadMs,reports,cycles,heap:performance.memory?.usedJSHeapSize??null,renderer:gl.getParameter(gl.RENDERER)};renderer.dispose();return report;
 });
 for(const r of result.reports)for(const v of r.views){await fs.writeFile(`${dir}/${r.map}-${v.name}.png`,Buffer.from(v.image.split(',')[1],'base64'));delete v.image;}
 const walk=async p=>{let n=0;for(const f of await fs.readdir(p,{withFileTypes:true})){const q=`${p}/${f.name}`;n+=f.isDirectory()?await walk(q):(await fs.stat(q)).size;}return n;};
 result.buildBytes=await walk('dist');result.assetBytes=await walk('public/assets');
 await fs.writeFile(`${dir}/benchmark.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,reports:result.reports.map(({collision,...r})=>({...r,colliders:collision.length}))},null,2));
}finally{await browser.close();}
