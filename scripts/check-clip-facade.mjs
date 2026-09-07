import assert from 'node:assert/strict';
import * as T from 'three';
import {clipFacadeAbove} from '../src/world/clip-facade.js';
const source=new T.BoxGeometry(4,8,1),before=Array.from(source.attributes.position.array);
const transform=new T.Matrix4().makeTranslation(0,4,0);
const result=clipFacadeAbove(source,transform,4.4),p=result.attributes.position;
assert(p.count>0);
assert.deepEqual(Array.from(source.attributes.position.array),before);
for(let i=0;i<p.count;i+=3){
  const v=[0,1,2].map(k=>new T.Vector3().fromBufferAttribute(p,i+k).applyMatrix4(transform));
  assert(v.every(a=>a.y>=4.4-1e-6));
  assert(new T.Triangle(...v).getArea()>1e-8,'No collapsed triangles at the seam');
}
assert.equal(result.attributes.uv.count,p.count);
assert.equal(result.attributes.normal.count,p.count);
console.log('Facade clipping OK: source intact, no flattened triangles, attributes preserved');
