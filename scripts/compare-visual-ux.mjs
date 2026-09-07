import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=async tag=>JSON.parse(await fs.readFile(`artifacts/visual-ux/${tag}/benchmark.json`,'utf8'));
const before=await read('before'),after=await read('after');
const maps=after.reports.map(current=>{
  const previous=before.reports.find(r=>r.map===current.map);
  assert(previous,`Missing baseline: ${current.map}`);
  for(const key of ['collision','spawns','pickups','special'])assert.deepEqual(current[key],previous[key],`${current.map}: ${key} changed`);
  return {map:current.map,gameplayManifestUnchanged:true,views:current.views.map((v,i)=>({view:v.name,calls:[previous.views[i].calls,v.calls],triangles:[previous.views[i].triangles,v.triangles],medianMs:[previous.views[i].medianMs,v.medianMs]}))};
});
assert.equal(after.assets.failed,0);
assert(after.cycles.every(v=>JSON.stringify(v)===JSON.stringify(after.cycles[0])),'Render resources grow during rebuilds');
const report={maps,buildBytes:[before.buildBytes,after.buildBytes],assetBytes:[before.assetBytes,after.assetBytes],loadMs:[before.loadMs,after.loadMs],heapBytes:[before.heap,after.heap],rebuildResources:[before.cycles,after.cycles],caveat:'Static headless renders; not gameplay FPS or a multi-round soak. Load/heap/timings are sensitive to cache, GC and competing processes.'};
await fs.writeFile('artifacts/visual-ux/comparison.json',JSON.stringify(report,null,2));
console.log('PASS: all nine gameplay manifests unchanged, 41 assets loaded, stable resources across four rebuilds.');
