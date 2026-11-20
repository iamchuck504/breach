import assert from 'node:assert/strict';
import * as T from 'three';
import {Rig} from '../src/player/rig.js';
const rig = new Rig(new T.Scene(), 'red');
for (const fps of [30, 60, 144]) for (const state of ['cover_high', 'blind_high_left', 'blind_high_right']) {
  for (const side of [-1, 1]) {
    for (let i=0;i<fps;i++) rig.update(1/fps,{state,aim:state==='cover_high',coverLean:side,aimPitch:0,firing:true});
    rig.root.updateMatrixWorld(true);
    if (state === 'cover_high') {
      assert.ok(rig.hips.position.x*side < 0, 'pelvis stays inward instead of following the exposed shoulder');
      assert.ok(Math.abs(rig.torso.position.x-side*.12)<.001, 'chest preserves barrel clearance without moving the feet out');
    }
    const feet = [rig.legL,rig.legR].map(leg=>{
      // el pie cuelga del tobillo (rig.js _groundLegs): es él el que va plano
      const up = new T.Vector3(0,1,0).transformDirection(leg.ankle.matrixWorld);
      assert.ok(up.y>.999, 'sole must remain level');
      // suela real (soleWorld), en el suelo; en el marco de la pelvis: en
      // blindfire lateral la pelvis gira hacia la abertura (BLIND_PELVIS)
      assert.ok(Math.abs(rig.soleWorld(leg,new T.Vector3(),true).y)<.015,'sole on the floor');
      return rig.hips.worldToLocal(rig.soleWorld(leg,new T.Vector3()));
    });
    assert.ok(Math.abs(feet[0].y-feet[1].y)<.01,'both feet share the ground plane');
    assert.ok(feet[1].x-feet[0].x>.4,'knees/boots must not pinch inward');
    assert.ok(Math.abs(feet[0].z-feet[1].z)>.08,'staggered support');
  }
}
for(let i=0;i<144;i++)rig.update(1/144,{state:'idle',aim:false});
assert.ok(Math.abs(rig.legL.hip.position.y-.02)<.001,'exit resets leg offsets');
console.log('COVER FEET OK: level, spaced, staggered support and clean exit at 30/60/144 FPS');
