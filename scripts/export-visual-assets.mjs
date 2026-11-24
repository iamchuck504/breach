import fs from 'node:fs/promises';
import { writeWorldWeapons } from './build-thirdperson-weapons.mjs';
import {chromium} from 'playwright-core';import {CHROME} from './lib-chrome.mjs';
await fs.mkdir('art/map-refresh/input',{recursive:true});await fs.mkdir('public/assets/ui',{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const p=await browser.newPage();await p.goto('http://127.0.0.1:5200/?nolock=1');
 const data=await p.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js');
  const {GLTFExporter}=await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
  const exports={},exporter=new GLTFExporter();
  for(const [map,method] of [['metro','_decorMetro'],['prision','_decorPrision'],['pueblo','_decorPueblo']]){
    const w=new World(new T.Scene(),map);w.mapGroup.clear();w._skipRefinedDecor=true;w[method]();
    // Solo se exporta la decoración existente del mapa.
    exports[map]=Array.from(new Uint8Array(await exporter.parseAsync(w.mapGroup,{binary:true,onlyVisible:true})));
  }
  return exports;
 });
 for(const [k,v] of Object.entries(data))await fs.writeFile(`art/map-refresh/input/${k}.glb`,Buffer.from(v));
 writeWorldWeapons();
 console.log('Decoración de tres mapas e iconos de las ocho armas exportados.');
}finally{await browser.close();}
