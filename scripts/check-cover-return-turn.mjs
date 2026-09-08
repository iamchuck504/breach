import assert from 'node:assert/strict';
import {Controller} from '../src/player/controller.js';
import {World} from '../src/world/world.js';
let cases=0;
for(const fps of [30,60,144])for(const side of [-1,1])for(const height of [1.1,3])for(const aim of [false,true])for(const offset of [-.08,0,.08]){
 const box={minx:-2,maxx:2,minz:-2,maxz:0,h:height};
 const face={a:{x:-2,z:0},b:{x:2,z:0},n:{x:0,z:1},h:height,topY:height,collider:box};
 const w=Object.create(World.prototype);w.colliders=[box];w.segmentColliders=[];w.faces=[face];w.groundHeight=()=>0;w.ceilingHeight=()=>Infinity;
 const cam={yaw:offset,pitch:0,flatForward:()=>({x:-Math.sin(offset),z:-Math.cos(offset)}),flatRight:()=>({x:Math.cos(offset),z:-Math.sin(offset)})};
 const p=new Controller(w,cam);p.state='cover';p.cover=face;p.pos={x:side*1.5,z:.38};p.yaw=-Math.PI;
 const input={moveVec:()=>({x:0,z:0}),aimHeld:aim};
 for(let cycle=0;cycle<3;cycle++){
  input.aimHeld=aim;
  for(let i=0;i<fps;i++)p.update(1/fps,input,true);
  const firedYaw=p.yaw,returnSign=Math.sign(-Math.PI-firedYaw);
  input.aimHeld=false;
  let travel=0;
  for(let i=0;i<fps*2;i++){
   const before=p.yaw;p.update(1/fps,input,false);const step=p.yaw-before;
   assert.ok(step*returnSign>=-1e-7,'return continued the outward spin');
   assert.ok(Math.abs(step)<=Math.PI*2/fps+.001,'return snapped');
   travel+=Math.abs(step);
  }
  assert.ok(Math.abs(p.yaw+Math.PI)<1e-4,'did not return to original unwrapped pose');
  assert.ok(travel<Math.PI+.15,'unnecessary full revolution');
  cases++;
 }
}
console.log('COVER RETURN OK',cases,'cycles: left/right, high/low, ADS/blind, +/-180 boundary, 30/60/144 FPS');
