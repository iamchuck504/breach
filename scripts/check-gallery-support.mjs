import assert from 'node:assert/strict';
import {World} from '../src/world/world.js';
import {expandedCollisionBoxes} from '../src/world/collision-layouts.js';
import {Controller,PLAYER_R} from '../src/player/controller.js';
import {galleryHeight} from '../src/world/fortaleza-galleries.js';

const world=Object.create(World.prototype);
Object.assign(world,{layout:'fortaleza',galleryEnabled:true,colliders:expandedCollisionBoxes('fortaleza'),segmentColliders:[],surfaceZones:[],fx:26,fz:26.6});
const camera={yaw:0,pitch:0,flatForward:()=>({x:0,z:-1}),flatRight:()=>({x:1,z:0})};
const input={aimHeld:false,sprintHeld:false,jumpPressed:false,evadePressed:false,moveVec:()=>({x:0,z:0})};
let samples=0;
for(const side of [-1,1])for(const end of [-1,1]){
  for(const x of [22.18,22.3,23.7,25.22])for(const z of [0,1.2,1.5,3,6,7.8,8.1,10,12,14,15.6]){
    const c=new Controller(world,camera);c.pos={x:side*x,z:end*z};c.y=galleryHeight(c.pos,PLAYER_R);c.grounded=true;
    world.resolveCircle(c.pos,PLAYER_R,c.y);
    const floor=world.groundHeight(c.pos,PLAYER_R,c.y);
    for(let frame=0;frame<30;frame++){
      c.update(1/60,input,false);
      assert(c.y>=floor-1e-5,`Sank beside gallery wall at ${side*x},${end*z}, frame ${frame}: ${c.y} < ${floor}`);
    }
    samples++;
  }
}
// A circle near a corner is not the square enclosing it. Tangency is not a ceiling.
world.colliders=[{minx:21,maxx:21.8,minz:1.2,maxz:1.5,minY:4.1,h:6}];
const corner=new Controller(world,camera);corner.pos={x:22.1,z:1.8};corner.y=3;corner.grounded=true;
for(let frame=0;frame<30;frame++){
  corner.update(1/60,input,false);
  assert.equal(corner.y,3,'Window corner falsely lowered the character below the gallery deck');
}
world.colliders=[{minx:0,maxx:1,minz:0,maxz:1,minY:4.1,h:6}];
assert.equal(world.ceilingHeight({x:1.3,z:1.3},.38,3),Infinity);
assert.equal(world.ceilingHeight({x:1.38,z:.5},.38,3),Infinity);
assert.equal(world.ceilingHeight({x:.5,z:.5},.38,3),4.1,'Real overhead geometry must still block jumping');
assert.equal(world.ceilingHeight({x:.5,z:.5},0,3),4.1);
console.log(`PASS: ${samples} gallery/stair wall positions remain supported; corner/tangent clearance and real ceilings correct.`);
