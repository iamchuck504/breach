import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5200/?nolock=1');
  const reports=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js');
    const {World}=await import('/src/world/world.js');
    const {preloadUrbanAssets,cloneUrbanAsset}=await import('/src/world/urban-assets.js');
    const {expandedCollisionBoxes,HELIPAD}=await import('/src/world/collision-layouts.js');
    await preloadUrbanAssets();
    const assets=['fort-gate','roof-access','roof-grille','roof-cabinet'];
    for(const id of assets)if(!cloneUrbanAsset(id))throw Error(`Missing Blender asset: ${id}`);
    const world=new World(new T.Scene(),'fortaleza'),out=[];
    for(const layout of ['fortaleza','azoteas','fortaleza']){
      world.setLayout(layout);
      const root=world.mapGroup.getObjectByName(`${layout}-architectural-polish`);
      const source=expandedCollisionBoxes(layout);
      const keys=b=>[b.minx,b.minz,b.maxx,b.maxz,b.h].join(':');
      const same=JSON.stringify(world.colliders.map(keys))===JSON.stringify(source.map(keys));
      let finite=true,batches=0,triangles=0,shared=0;
      root.traverse(o=>{
        if(o.isInstancedMesh){
          batches++;finite&&=Array.from(o.instanceMatrix.array).every(Number.isFinite);
          triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*o.count;
          if(o.geometry.userData.urbanAssetShared)shared++;
        }
      });
      const gate=world.mapGroup.getObjectByName('fortaleza-procedural-gates');
      const centerClear=layout!=='azoteas'||!new T.Raycaster(new T.Vector3(0,HELIPAD.height+.02,0),new T.Vector3(0,1,0),0,20).intersectObject(root,true).length;
      // Cast from both approaches: human-height door/panel faces must have
      // physical backing immediately behind them, not create floating cover.
      const backed=[];
      for(const sign of [-1,1]){
        const z=layout==='fortaleza'?20.9:31.35;
        const ray=new T.Raycaster(new T.Vector3(.22,1.0,sign*(z-4)),new T.Vector3(0,0,sign),0,8);
        const visible=ray.intersectObject(root,true)[0];
        const physical=world.raycastHit(ray.ray.origin,ray.ray.direction,8);
        backed.push(!!visible&&!!physical&&Math.abs(visible.distance-physical.t)<.08);
      }
      out.push({layout,same,finite,batches,triangles,shared,centerClear,backed,oldGateHidden:!gate||!gate.visible});
    }
    return out;
  });
  for(const r of reports){
    assert(r.same,`${r.layout}: collider manifest changed`);
    assert(r.finite&&r.shared>0&&r.batches<30,`${r.layout}: instancing/asset regression`);
    assert(r.centerClear,`${r.layout}: helipad obstructed`);
    assert(r.backed.every(Boolean),`${r.layout}: unbacked surface`);
    assert(r.oldGateHidden,`${r.layout}: overlapping gate fallback`);
  }
  assert.deepEqual(errors,[]);console.log('ARCHITECTURE POLISH OK',JSON.stringify(reports));
}finally{await browser.close();}
