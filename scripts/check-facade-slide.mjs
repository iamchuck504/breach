import assert from 'node:assert/strict';
import {Controller,PLAYER_R} from '../src/player/controller.js';
import {World} from '../src/world/world.js';

for(const standOff of [PLAYER_R,1.20])for(const dt of [1/30,1/60,1/144]){
 const w=Object.create(World.prototype);
 const collider={minx:0,maxx:3,minz:-5,maxz:5,h:3};
 const face={a:{x:0,z:-5},b:{x:0,z:5},n:{x:-1,z:0},h:3,topY:3,kind:'high',collider,standOff,bodyStandOff:1.28};
 w.colliders=[collider];w.segmentColliders=[];w.faces=[face];w.groundHeight=()=>0;w.ceilingHeight=()=>Infinity;w.raycast=()=>null;
 const camera={yaw:-Math.PI/2,pitch:0,flatForward:()=>({x:1,z:0}),flatRight:()=>({x:0,z:1})};
 const p=new Controller(w,camera);p.pos={x:-3,z:0};
 assert.equal(p._tryEvade({x:1,z:0},4),'slide');
 const input={moveVec:()=>({x:0,z:0}),aimHeld:false,sprintHeld:false,jumpPressed:false,meleePressed:false,evadePressed:false};
 let elapsed=0;
 while(p.state==='slide'&&elapsed<1){p.update(dt,input,false);elapsed+=dt;}
 assert.equal(p.state,'cover',`slide failed at ${dt}, standOff ${standOff}`);
 assert.ok(elapsed<.9,'must arrive before timeout');
 // Free movement still respects the body envelope, while entry only exempts
 // its chosen face, never the solid geometry or a second facade.
 const probe={x:-.5,z:0};w.resolveFacadeBody(probe,PLAYER_R,0);assert.equal(probe.x,-1.28);
 const solid={x:.1,z:0};w.resolveFacadeBody(solid,PLAYER_R,0,face);assert.ok(solid.x<=-PLAYER_R);
 const other={...face};w.faces.push(other);
 const blocked={x:-.5,z:0};w.resolveFacadeBody(blocked,PLAYER_R,0,face);assert.equal(blocked.x,-1.28);
}
console.log('FACADE SLIDE OK: cover arrival at 30/60/144 FPS, free contact and other obstacles preserved');
