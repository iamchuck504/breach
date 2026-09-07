import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';import {CHROME} from './lib-chrome.mjs';
await fs.mkdir('art/map-refresh/input',{recursive:true});await fs.mkdir('public/assets/ui',{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const p=await browser.newPage();await p.goto('http://127.0.0.1:5200/?nolock=1');
 const data=await p.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js');
  const {GLTFExporter}=await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
  const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const exports={},icons={},exporter=new GLTFExporter();
  for(const [map,method] of [['metro','_decorMetro'],['prision','_decorPrision'],['pueblo','_decorPueblo']]){
    const w=new World(new T.Scene(),map);w.mapGroup.clear();w._skipRefinedDecor=true;w[method]();
    // Input is the existing decoration only, never collision or spawn objects.
    exports[map]=Array.from(new Uint8Array(await exporter.parseAsync(w.mapGroup,{binary:true,onlyVisible:true})));
  }
  const renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(480,160);renderer.setClearColor(0,0);
  for(const key of ['smg','pistol','shotgun','sniper','bazooka','grenade']){
   const scene=new T.Scene(),asset=(await new GLTFLoader().loadAsync(`/assets/characters/blender/${key}.glb`)).scene;
   asset.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.color.lerp(new T.Color(0xc6d5e2),.28);if(/red/i.test(o.material.name)){o.material.color.setHex(0xf2a65e);o.material.emissive?.setHex(0x261302);}}});scene.add(asset);
   const bounds=new T.Box3().setFromObject(asset),c=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
   const alongZ=size.z>size.x,wide=Math.max(size.x,size.z),height=Math.max(size.y,wide/3)*1.15;
   const camera=new T.OrthographicCamera(-height*1.5,height*1.5,height/2,-height/2,.01,100);
   camera.position.copy(c).add(new T.Vector3(alongZ?5:0,.16,alongZ?0:5));camera.lookAt(c);
   scene.add(new T.HemisphereLight(0xe9f5ff,0x8e9da7,2.8));const light=new T.DirectionalLight(0xffffff,3);light.position.set(3,6,4);scene.add(light);
   renderer.render(scene,camera);icons[key]=renderer.domElement.toDataURL();
  }renderer.dispose();return {exports,icons};
 });
 for(const [k,v] of Object.entries(data.exports))await fs.writeFile(`art/map-refresh/input/${k}.glb`,Buffer.from(v));
 for(const [k,v] of Object.entries(data.icons))await fs.writeFile(`public/assets/ui/${k}.png`,Buffer.from(v.split(',')[1],'base64'));
 console.log('Exported three existing decor scenes and six real weapon illustrations.');
}finally{await browser.close();}
