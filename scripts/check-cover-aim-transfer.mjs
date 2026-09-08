import assert from 'node:assert/strict';
import * as T from 'three';
import { Rig } from '../src/player/rig.js';
import { ShoulderCamera } from '../src/core/camera.js';
let cases=0;
for(const fps of [30,60,144])for(const weapon of ['pistol','smg','shotgun','sniper','bazooka'])for(const state of ['cover_low','cover_high']){
  const rig=new Rig(new T.Scene(),'red');rig.setWeapon(weapon);
  const p={state,aim:true,aimPitch:0,aimYawErr:0,coverLean:-1,coverAimExposure:1,speed:0};
  for(let i=0;i<fps;i++)rig.update(1/fps,p);
  for(const side of [0,1,0,-1]){
    const initial=rig.torso.position.x;
    p.coverLean=side;rig.update(1/fps,p);
    const target=side*.12;
    const fraction=Math.abs((rig.torso.position.x-initial)/(target-initial));
    assert.ok(fraction<.4,`transfer snapped: ${fps} ${weapon} ${state} ${side} ${fraction}`);
    for(let i=0;i<fps;i++)rig.update(1/fps,p);
    assert.ok(Math.abs(rig.torso.position.x-target)<1e-5,'approved endpoint changed');
    cases++;
  }
  // Releasing aim cancels the transfer: returning to protection is not delayed.
  p.coverLean=0;rig.update(1/fps,p);p.aim=false;rig.update(1/fps,p);
  assert.equal(rig._coverTransferTime,0);
}
for(const fps of [30,60,144]){
  const camera=new ShoulderCamera(new T.PerspectiveCamera(),{raycast:()=>null});
  let side=-1;
  const player={pos:{x:0,z:0},y:0,camState:()=>({mode:'aim',side})};
  for(let i=0;i<fps*2;i++)camera.update(1/fps,player);
  side=0;
  for(let i=0;i<fps;i++)camera.update(1/fps,player);
  assert.ok(camera._side<-.999,'neutral barrier section switched shoulders');
  side=1;const before=camera._side;camera.update(1/fps,player);
  assert.ok(camera._side>before&&camera._side<0,'opposite edge snapped camera');
}
console.log('COVER AIM TRANSFER OK',cases,'transfers, five weapons, 30/60/144fps, unchanged endpoints, neutral shoulder retained');
