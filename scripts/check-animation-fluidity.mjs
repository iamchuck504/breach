import assert from 'node:assert/strict';
import * as T from 'three';
import {Rig} from '../src/player/rig.js';
const scene=new T.Scene(),results=[];
const live={state:'run',speed:1,aim:false,aimPitch:0,moveForward:1,moveSide:0};
for(const state of ['idle','run','cover_low','dive'])for(const hz of [30,60,144]){
 const rig=new Rig(scene,'red');rig.groundFn=()=>0;
 for(let i=0;i<hz;i++)rig.update(1/hz,{...live,state});
 const hip=rig.hips.position.y;
 rig.setDeathContext({state,vel:{x:state==='run'?4:0,z:-2},impact:{x:1,z:.3},power:.7});
 const random=Math.random;let seed=123;
 Math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
 try{rig._startRagdoll();}finally{Math.random=random;}
 assert.equal(rig.rag.startHipY,hip);
 let maxStep=0,last=rig.hips.position.y;
 for(let i=0;i<hz*3;i++){
  rig.update(1/hz,{state:'dead',speed:0,aim:false});
  maxStep=Math.max(maxStep,Math.abs(rig.hips.position.y-last));last=rig.hips.position.y;
  rig.root.updateMatrixWorld(true);rig.root.traverse(o=>assert(Array.from(o.matrixWorld.elements).every(Number.isFinite)));
  assert(rig.root.position.y>=0);
 }
 assert(rig.rag.hit&&rig.rag.ang===1,'Death must settle decisively');
 assert(maxStep<.2,'Pelvis teleported during collapse');
 results.push({state,hz,x:rig.root.position.x,z:rig.root.position.z,maxStep});
 rig.update(1/hz,{state:'idle',speed:0,aim:false});
 assert(!rig.rag&&rig.head.visible,'Respawn did not restore living rig');rig.dispose(scene);
}
for(const state of ['idle','run','cover_low','dive']){
 const rows=results.filter(r=>r.state===state);
 assert(Math.hypot(rows[0].x-rows[2].x,rows[0].z-rows[2].z)<.02,'Frame rate changes death momentum');
}
const rig=new Rig(scene,'red');
rig.update(1/60,live);assert(rig._strideWeight>0&&rig._strideWeight<.5,'Stride enters abruptly');
for(let i=0;i<60;i++)rig.update(1/60,live);
rig.update(1/60,{...live,state:'idle',speed:0});assert(rig._strideWeight>.5,'Stride stops abruptly');
for(let i=0;i<60;i++)rig.update(1/60,{...live,state:'idle',speed:0});
assert(rig._strideWeight<.001);rig.dispose(scene);
console.log('ANIMATION FLUIDITY OK',JSON.stringify(results));
