import assert from 'node:assert/strict';
import * as T from 'three';
import {Controller} from '../src/player/controller.js';
import {World} from '../src/world/world.js';
import {Rig} from '../src/player/rig.js';
for(const side of [-1,1])for(const aim of [false,true])for(const weapon of ['pistol','smg','shotgun','sniper','bazooka']){
 const w=Object.create(World.prototype),box={minx:-2,maxx:2,minz:-2,maxz:0,h:3};
 const face={a:{x:-2,z:0},b:{x:2,z:0},n:{x:0,z:1},h:3,topY:3,kind:'high',collider:box};
 w.colliders=[box];w.segmentColliders=[];w.faces=[face];w.groundHeight=()=>0;w.ceilingHeight=()=>Infinity;
 const cam={yaw:0,pitch:0,flatForward:()=>({x:-Math.sin(cam.yaw),z:-Math.cos(cam.yaw)}),flatRight:()=>({x:Math.cos(cam.yaw),z:-Math.sin(cam.yaw)})};
 const p=new Controller(w,cam);p.pos={x:side*1.3,z:.38};p.state='cover';p.cover=face;p.yaw=Math.PI;
 const rig=new Rig(new T.Scene(),'red');rig.setWeapon(weapon);
 const input={moveVec:()=>({x:0,z:0}),aimHeld:aim,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
 for(let i=0;i<120;i++){p.update(1/60,input,true);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,p.animParams());}
 assert.equal(p.coverLeanAnim,side);
 const muzzle=rig.muzzleWorld(new T.Vector3());
 assert.ok(muzzle.x*side>2,`${weapon} ${aim?'ADS':'blind'} ${side}: muzzle inside edge ${muzzle.x}`);
 assert.equal(w.raycast(muzzle,new T.Vector3(0,0,-1),5),null,'own wall blocks barrel');
 for(const yaw of [-1.7,1.7,0]){cam.yaw=yaw;p.update(1/60,input,true);assert.equal(p.coverLeanAnim,side,'camera swapped opening');}
}
console.log('COVER SIDES OK: both edges, five weapons, ADS/blind, no camera side inversion');
// Check the whole turn, not just the final pose: every wall orientation must
// turn through its opening, including the ambiguous +/-PI half-turn.
for(const height of [1.1,3])for(const n of [{x:0,z:1},{x:0,z:-1},{x:1,z:0},{x:-1,z:0}])for(const side of [-1,1])for(const aim of [false,true]){
 const t={x:n.z,z:-n.x};
 const face={a:{x:-2*t.x,z:-2*t.z},b:{x:2*t.x,z:2*t.z},n,h:height,topY:height,kind:height<2?'low':'high'};
 const w={groundHeight:()=>0,resolveCircle(){},raycast:()=>null};
 const cam={yaw:Math.atan2(n.x,n.z),pitch:0,flatForward:()=>({x:-n.x,z:-n.z}),flatRight:()=>t};
 const p=new Controller(w,cam);p.state='cover';p.cover=face;p.yaw=Math.atan2(-n.x,-n.z);
 p.pos={x:side*1.6*t.x+.38*n.x,z:side*1.6*t.z+.38*n.z};
 const input={moveVec:()=>({x:0,z:0}),aimHeld:aim,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
 let total=0;
 for(let i=0;i<60;i++){
  const before=p.yaw;p.update(1/60,input,true);const step=p.yaw-before;total+=step;
  assert.ok(step*side>=-1e-8,'turned away from opening');
 }
 assert.ok(Math.abs(Math.abs(total)-Math.PI)<1e-6,'must make only a half turn');
}
console.log('COVER TURN OK: left/right, four wall orientations, ADS/blind');
