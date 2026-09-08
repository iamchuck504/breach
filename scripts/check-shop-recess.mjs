import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:800}});
 await page.goto('http://127.0.0.1:5200/?nolock=1');
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const {DISTRICT_FACADES}=await import('/src/world/district-facades.js');
  const loader=new GLTFLoader(),report=[];let preview;
  for(const id of Object.values(DISTRICT_FACADES).filter(id=>id.startsWith('district-')&&!id.includes('motor-works'))){
   const {scene}=await loader.loadAsync(`/assets/calle/${id}.glb`);
   const panes=[];scene.traverse(o=>{if(o.isMesh&&o.material.name==='Shop window clear glazing')panes.push(o);});
   if(panes.length!==1)throw Error(`${id}: missing dedicated glass`);
   const pane=panes[0],bounds=new T.Box3().setFromObject(pane);
   if(!pane.material.transparent||pane.material.opacity>.2)throw Error(`${id}: opaque glazing`);
   const origin=bounds.getCenter(new T.Vector3());origin.x+=.57;origin.y+=.34;origin.z=1;
   const ray=new T.Raycaster(origin,new T.Vector3(0,0,-1));
   const hits=ray.intersectObject(scene,true).filter(h=>h.object!==pane);
   if(!hits.length||hits[0].point.z>=0)throw Error(`${id}: display is not recessed ${hits[0]?.object.name} ${hits[0]?.point.z}`);
   report.push({id,glassZ:bounds.min.z,interiorZ:hits[0].point.z});
   if(id==='district-paper-ink')preview=scene;
  }
  const scene=new T.Scene();scene.background=new T.Color(0x18222c);scene.add(preview);
  scene.add(new T.HemisphereLight(0xc3d9ed,0x36312b,2));
  const light=new T.DirectionalLight(0xffdfbc,2);light.position.set(-3,5,5);scene.add(light);
  const camera=new T.PerspectiveCamera(46,1100/800,.05,60);camera.position.set(-4.4,2.1,3.5);camera.lookAt(-1.1,1.5,0);
  const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(1100,800);renderer.render(scene,camera);
  const image=renderer.domElement.toDataURL();renderer.dispose();return {report,image};
 });
 assert.equal(result.report.length,12);
 await fs.mkdir('artifacts/shop-recess',{recursive:true});
 await fs.writeFile('artifacts/shop-recess/oblique.png',Buffer.from(result.image.split(',')[1],'base64'));
 console.log('SHOP RECESS OK',JSON.stringify(result.report));
}finally{await browser.close();}
