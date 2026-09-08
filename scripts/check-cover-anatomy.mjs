import assert from 'node:assert/strict';
import * as T from 'three';
import {Rig} from '../src/player/rig.js';
const rig=new Rig(new T.Scene(),'red');let samples=0;
for(const state of ['cover_high','cover_low','blind_high_left','blind_high_right','blind_low_left','blind_low_right'])
for(const weapon of ['pistol','smg','shotgun','sniper','bazooka'])for(const pitch of [-.6,0,.6])for(const side of [-1,1]){
 rig.setWeapon(weapon);
 for(let i=0;i<45;i++){
  rig.update(1/60,{state,aim:state.startsWith('cover_'),aimPitch:pitch,coverLean:side,coverAimExposure:1,blindPoseExposure:1,firing:true});
  rig.root.updateMatrixWorld(true);
  for(const [arm,s] of [[rig.armL,-1],[rig.armR,1]]){
   const socket=rig.torso.localToWorld(new T.Vector3(s*.36,.5,0));
   assert.ok(socket.distanceTo(arm.shoulder.getWorldPosition(new T.Vector3()))<1e-6,'detached shoulder');
  }
  samples++;
 }
}
console.log('COVER ANATOMY OK: chest sockets remain attached',samples,'frames');
