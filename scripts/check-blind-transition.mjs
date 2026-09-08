import assert from 'node:assert/strict';
import * as T from 'three';
import {Controller} from '../src/player/controller.js';
import {World} from '../src/world/world.js';
import {Rig} from '../src/player/rig.js';
import {RemotePlayer} from '../src/player/remote.js';
const reports=[];
for(const fps of [30,60,144])for(const side of [-1,1])for(const height of [3,1.1])for(const startAim of [true,false]){
 const box={minx:-2,maxx:2,minz:-2,maxz:0,h:height};
 const face={a:{x:-2,z:0},b:{x:2,z:0},n:{x:0,z:1},h:height,topY:height,kind:height<2?'low':'high',collider:box};
 const w=Object.create(World.prototype);w.colliders=[box];w.segmentColliders=[];w.faces=[face];w.groundHeight=()=>0;w.ceilingHeight=()=>Infinity;
 const cam={yaw:0,pitch:0,flatForward:()=>({x:0,z:-1}),flatRight:()=>({x:1,z:0})};
 const p=new Controller(w,cam);p.pos={x:side*1.5,z:.38};p.state='cover';p.cover=face;p.yaw=0;
 const rig=new Rig(new T.Scene(),'red');rig.setWeapon('smg');
 const input={moveVec:()=>({x:0,z:0}),aimHeld:startAim,sprintHeld:false,meleePressed:false,evadePressed:false,jumpPressed:false};
 let fire=startAim;
 const step=()=>{p.update(1/fps,input,fire);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/fps,p.animParams());};
 for(let i=0;i<fps;i++)step();
 input.aimHeld=false;fire=true;let blocked=0,maxStep=0;const blockedFrames=[];
 for(let i=0;i<fps/2;i++){
  const before=p.pos.x;step();maxStep=Math.max(maxStep,Math.abs(p.pos.x-before));
  const muzzle=rig.muzzleWorld(new T.Vector3()),dir=rig.gunForward(new T.Vector3());
  if(p.fireAligned()&&p.blindPoseExposure>.62&&w.raycast(muzzle,dir,5)!==null){blocked++;blockedFrames.push({i,exposure:p.blindPoseExposure,yaw:p.yaw,muzzle,dir});}
 }
 assert.equal(blocked,0,JSON.stringify({fps,side,height,startAim,blockedFrames}));
 assert.ok(maxStep<=6/fps+1e-6,'root snapped instead of retracting');
 if(fps===60){
  const remote=new RemotePlayer(new T.Scene(),'test',null,'red');
  remote.x=p.pos.x;remote.z=p.pos.z;remote.y=p.y;remote.yaw=p.yaw;
  remote.st=p.animState();remote.coverLean=p.coverLeanAnim;remote.rig.setWeapon('smg');
  for(let i=0;i<120;i++)remote.update(1/60);
  assert.ok(remote.rig.muzzleWorld(new T.Vector3()).distanceTo(rig.muzzleWorld(new T.Vector3()))<.001,'remote blindfire pose differs');
 }
 reports.push({fps,side,height,startAim,maxStep});
}
console.log('BLIND TRANSITIONS OK',reports.length,'cases: rest/ADS entry, bounded retraction, clear first shots, remote pose');
