import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const dir='art/street-props';await fs.mkdir(`${dir}/input`,{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:5200/?nolock=1');
  const models=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js');
    const {GLTFExporter}=await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
    const {World}=await import('/src/world/world.js');const world=new World(new T.Scene(),'calle2');
    const exporter=new GLTFExporter(),result={};
    for(const [id,key] of [['coffee','coffee:0'],['hotdog','kiosk:2'],['news','kiosk:0'],['dumpster','dumpster:0'],['jersey','jersey:0'],['roadwork','roadwork:0'],['shelter',null]]){
      const source=world.mapGroup.children.find(o=>key?o.userData.editorDecorKey===key:o.userData.urbanAssetId==='busShelter');
      if(!source)throw Error(`Missing ${id}`);
      const model=source.clone(true);model.position.set(0,0,0);model.rotation.set(0,0,0);
      // Keep GLB assets in their native local units; placement owns scale.
      model.scale.setScalar(1);model.updateMatrixWorld(true);
      model.traverse(o=>{o.userData={};});
      const buffer=await exporter.parseAsync(model,{binary:true,onlyVisible:true});
      result[id]=Array.from(new Uint8Array(buffer));
    }return result;
  });
  for(const [id,bytes] of Object.entries(models))await fs.writeFile(`${dir}/input/${id}.glb`,Buffer.from(bytes));
  console.log('Exported',Object.keys(models));
}finally{await browser.close();}
