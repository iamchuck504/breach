import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const UP = new THREE.Vector3(0,1,0), DOWN = new THREE.Vector3(0,-1,0);
const PREFIX='SMG_Anatomical_';
const clean = name => name.replace(/[.\[\]:/]/g,'');
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));

/** Authored body animation, with runtime IK onto the physical weapon sockets.
 * This class never moves the gameplay root, gunMount, muzzle or camera.
 */
export class BlenderMotion {
  constructor(rig, asset, materialFor) {
    this.rig=rig;
    this.root=new THREE.Group();this.root.name='Blender animated soldier';
    this.root.userData.nativeSoldier=true;
    this.root.rotation.y=Math.PI; // -Y Blender -> +Z glTF -> -Z game, no mirroring.
    this.model=clone(asset.scene);this.root.add(this.model);
    this.bones={};this.meshes=[];
    this.model.traverse(o=>{
      if(o.isBone)this.bones[o.name]=o;
      if(o.isMesh){
        o.material=Array.isArray(o.material)?o.material.map(materialFor):materialFor(o.material);
        o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;
        this.meshes.push(o);
      }
    });
    this.clips=new Map();
    for(const clip of asset.animations){
      const tracks=clip.tracks.map(track=>{
        const dot=track.name.lastIndexOf('.'), name=track.name.slice(0,dot);
        const node=this.bones[name];
        return node?{node,property:track.name.slice(dot+1),sample:track.createInterpolant(),track}:null;
      }).filter(Boolean);
      this.clips.set(clip.name.replace(PREFIX,''),{duration:clip.duration,tracks});
    }
    const required=['pelvis','chest','head','weapon',...['R','L'].flatMap(s=>
      ['hand','forearm','upper_arm','thigh','shin','foot','kneecap','pauldron'].map(n=>n+'.'+s))];
    if(this.clips.size!==10 || required.some(n=>!this.b(n)))
      throw new Error('Incomplete native Blender animation package');
    rig.root.add(this.root);
    this.rest={};this.rig.root.updateWorldMatrix(true,true);
    const rootInv=rig.root.getWorldQuaternion(Q()).invert();
    for(const [name,b] of Object.entries(this.bones)){
      const q=rootInv.clone().multiply(b.getWorldQuaternion(Q()));
      const down=Q().setFromUnitVectors(UP.clone().applyQuaternion(q),DOWN).multiply(q);
      this.rest[name]={q,down,position:b.position.clone(),rotation:b.quaternion.clone(),scale:b.scale.clone()};
    }
    const weaponRest=this.b('weapon').getWorldQuaternion(Q());
    this.sample('Study_Idle',0);
    this.rig.root.updateWorldMatrix(true,true);
    const frame=this.b('weapon').getWorldQuaternion(Q()).multiply(weaponRest.invert())
      .multiply(rig.root.getWorldQuaternion(Q()))
      .multiply(Q().setFromAxisAngle(UP,Math.PI/2));
    this.handQ={};this.cuffQ={};
    for(const side of ['R','L']){
      const hand=this.b('hand.'+side).getWorldQuaternion(Q());
      this.handQ[side]=frame.clone().invert().multiply(hand);
      this.cuffQ[side]=hand.clone().invert().multiply(this.b('forearm.'+side).getWorldQuaternion(Q()));
    }
    this.clock=0;this.raise=0;this.aim=0;this.lastSide='Right';this.lastKey='';
    this.transition=1;this.previous={};this.maxReachError=0;
  }
  b(name){return this.bones[clean(name)];}
  sample(key,time){
    const clip=this.clips.get(key);if(!clip)return;
    for(const t of clip.tracks)t.node[t.property].fromArray(t.sample.evaluate(clamp(time,0,clip.duration)));
    if(key==='Walk'||key==='Sprint'){
      // Source root motion lives in PELVIS, not in the root bone.
      const t=clip.tracks.find(t=>t.node===this.b('pelvis')&&t.property==='position');
      if(t){
        const start=t.track.values, end=start.length-3, u=clamp(time/clip.duration,0,1);
        this.b('pelvis').position.x-=start[0]+(start[end]-start[0])*u;
        this.b('pelvis').position.z-=start[2]+(start[end+2]-start[2])*u;
      }
    }
    if(key.startsWith('CoverState_')){
      // The approved fixture places side guards at +/-0.75m beside its wall.
      // That is staging, not locomotion: the controller already occupies the edge.
      const t=clip.tracks.find(t=>t.node===this.b('pelvis')&&t.property==='position');
      if(t){this.b('pelvis').position.x-=t.track.values[0];this.b('pelvis').position.z-=t.track.values[2];}
    }
  }
  world(name,position,quaternion){
    const b=this.b(name);if(!b)return;
    b.parent.updateWorldMatrix(true,false);
    if(position)b.position.copy(b.parent.worldToLocal(position.clone()));
    if(quaternion)b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(quaternion));
    b.scale.set(1,1,1);b.updateWorldMatrix(false,true);
  }
  fallback(){
    const r=this.rig, rq=r.root.getWorldQuaternion(Q());
    const orient=(group,name,down=false)=>group.getWorldQuaternion(Q()).multiply(this.rest[clean(name)][down?'down':'q']);
    const hips=r.hips.getWorldPosition(V()).add(new THREE.Vector3(0,-.08,0).applyQuaternion(rq));
    this.world('pelvis',hips,orient(r.hips,'pelvis'));
    const torsoQ=r.torso.getWorldQuaternion(Q());
    this.world('chest',hips.clone().add(new THREE.Vector3(0,.18,0).applyQuaternion(torsoQ)),orient(r.torso,'chest'));
    this.world('head',r.head.getWorldPosition(V()).add(new THREE.Vector3(0,-.08,0).applyQuaternion(rq)),orient(r.head,'head'));
    for(const side of ['L','R']){
      const leg=side==='L'?r.legL:r.legR, arm=side==='L'?r.armL:r.armR;
      const start=hips.clone().add(new THREE.Vector3(side==='R'?.222:-.222,-.005,0).applyQuaternion(r.hips.getWorldQuaternion(Q())));
      const thigh=orient(leg.hip,'thigh.'+side,true), shin=orient(leg.knee,'shin.'+side,true);
      const knee=start.clone().add(UP.clone().applyQuaternion(thigh).multiplyScalar(.265277));
      const foot=knee.clone().add(UP.clone().applyQuaternion(shin).multiplyScalar(.181));
      this.world('thigh.'+side,start,thigh);this.world('shin.'+side,knee,shin);
      this.world('kneecap.'+side,knee,leg.knee.getWorldQuaternion(Q()).multiply(this.rest[clean('kneecap.'+side)].q));
      this.world('foot.'+side,foot,leg.knee.getWorldQuaternion(Q()).multiply(this.rest[clean('foot.'+side)].q));
      const shoulder=arm.shoulder.getWorldPosition(V());
      this.world('upper_arm.'+side,shoulder,orient(arm.shoulder,'upper_arm.'+side,true));
      this.world('forearm.'+side,arm.elbow.getWorldPosition(V()),orient(arm.elbow,'forearm.'+side,true));
      this.world('hand.'+side,arm.hand.getWorldPosition(V()),orient(arm.hand,'hand.'+side));
      this.world('pauldron.'+side,shoulder,r.aimRig.getWorldQuaternion(Q()).multiply(this.rest[clean('pauldron.'+side)].q));
    }
  }
  arm(side,target,handQuaternion){
    const upper=this.b('upper_arm.'+side), fore=this.b('forearm.'+side);
    let shoulder=upper.getWorldPosition(V()), elbow=fore.getWorldPosition(V());
    const l1=.2642235,l2=side==='R'?.3475428:.3889909;
    const delta=target.clone().sub(shoulder);let distance=delta.length();
    const direction=delta.normalize();
    // A small shoulder reach is anatomical, never a weapon/muzzle translation.
    if(distance>l1+l2-.002){
      const reach=Math.min(.12,distance-(l1+l2-.002));
      shoulder.addScaledVector(direction,reach);distance-=reach;
    }
    if(distance-l1-l2>this.maxReachError){
      this.maxReachError=distance-l1-l2;
      this.worstReach={side,from:shoulder.toArray(),to:target.toArray(),key:this.lastKey};
    }
    const d=clamp(distance,Math.abs(l1-l2)+.001,l1+l2-.001);
    let pole=elbow.clone().sub(shoulder);
    pole.addScaledVector(direction,-pole.dot(direction));
    if(pole.lengthSq()<.0001){
      pole.set(side==='R'?1:-1,-.5,0).applyQuaternion(this.rig.root.getWorldQuaternion(Q()));
      pole.addScaledVector(direction,-pole.dot(direction));
    }
    pole.normalize();
    const a=(l1*l1-l2*l2+d*d)/(2*d), h=Math.sqrt(Math.max(0,l1*l1-a*a));
    elbow=shoulder.clone().addScaledVector(direction,a).addScaledVector(pole,h);
    const tip=shoulder.clone().addScaledVector(direction,d);
    const turn=(node,start,end)=>{
      const q=node.getWorldQuaternion(Q());
      return Q().setFromUnitVectors(UP.clone().applyQuaternion(q),end.clone().sub(start).normalize()).multiply(q);
    };
    const uq=turn(upper,shoulder,elbow);
    const cuff=handQuaternion.clone().multiply(this.cuffQ[side]);
    const fq=Q().setFromUnitVectors(UP.clone().applyQuaternion(cuff),tip.clone().sub(elbow).normalize()).multiply(cuff);
    this.world('upper_arm.'+side,shoulder,uq);
    this.world('forearm.'+side,elbow,fq);
    this.world('hand.'+side,tip,handQuaternion);
  }
  fitUpperBody(targets){
    // Fit torso turn/lean before solving elbows: reaching across an edge with
    // a forward-facing torso is impossible for the opposite supporting arm.
    // This articulates the chest at its existing joint; feet/root/gun stay put.
    const chest=this.b('chest'),pivot=chest.getWorldPosition(V());
    const original=chest.getWorldQuaternion(Q()), rootQ=this.rig.root.getWorldQuaternion(Q());
    const rootInv=rootQ.clone().invert();
    const points=['R','L'].map(s=>this.b('upper_arm.'+s).getWorldPosition(V()).sub(pivot).applyQuaternion(rootInv));
    const localTargets=targets.map(t=>t.clone().sub(pivot).applyQuaternion(rootInv));
    const limits=[.2642235+.3475428+.10,.2642235+.3889909+.10];
    const base=Math.max(...points.map((p,i)=>p.distanceTo(localTargets[i])-limits[i]));
    if(base<=0)return;
    let best=Infinity,bestQ=Q();
    for(const yaw of [0,-.35,.35,-.7,.7,-1.05,1.05,-1.4,1.4])
      for(const roll of [0,-.25,.25,-.5,.5,-.7,.7])
        for(const pitch of [0,-.3,.3]){
          const q=Q().setFromEuler(new THREE.Euler(pitch,yaw,roll));
          const miss=Math.max(0,...points.map((p,i)=>p.clone().applyQuaternion(q).distanceTo(localTargets[i])-limits[i]));
          const cost=miss*miss*500+(yaw*yaw+roll*roll+pitch*pitch)*.003;
          if(cost<best){best=cost;bestQ=q;}
        }
    this.world('chest',null,rootQ.multiply(bestQ).multiply(rootInv).multiply(original));
  }
  update(dt,p){
    const r=this.rig, state=p.state??'idle';
    const respawning=this.lastState==='dead'&&state!=='dead';this.lastState=state;
    this.clock+=dt;
    // No low-side clip was authored: retain the game's crouched side pose,
    // rather than forcing a standing wall animation into a low-cover socket.
    const incompatible=state==='blind_low_left'||state==='blind_low_right'||p.reloading||p.swapping||p.throwT>0||
      ['dead','melee','dive','slide','jump','mantle','flip'].includes(state);
    this.aim+=(Number(!!p.aim)-this.aim)*(1-Math.exp(-dt*16));
    let key='Study_Idle',time=this.clock%2.4;
    const cover=state.startsWith('cover_')||state.startsWith('blind_');
    if(state.endsWith('_left')||p.coverLean<0)this.lastSide='Left';
    if(state.endsWith('_right')||p.coverLean>0)this.lastSide='Right';
    if(cover){
      const over=state==='blind_over'||state==='cover_low';
      const side=over?'Over':this.lastSide;
      const mode=p.aim?'Aiming':'Blindfire';
      key=`CoverState_${side}_${mode}`;
      const active=state.startsWith('blind_')||p.aim||p.firing;
      this.raise+=(Number(!!active)-this.raise)*(1-Math.exp(-dt*12));
      time=this.raise*1.8;
    }else{
      this.raise=0;
      if(p.aim||this.aim>.002){key='Study_Aim';time=this.aim*1.2;}
      else if(state==='roadie'){key='Sprint';time=this.clock%(.5);}
      else if(state==='run'&&p.speed>.02){key='Walk';time=this.clock%(38/60);}
    }
    const stateKey=incompatible?'procedural-compatibility':key;
    if(stateKey!==this.lastKey){
      this.previous={};
      for(const [n,b] of Object.entries(this.bones))this.previous[n]={p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()};
      this.transition=0;this.lastKey=stateKey;
    }
    // Reset scales after dismemberment/respawn before evaluating a fresh pose.
    for(const b of Object.values(this.bones))b.scale.set(1,1,1);
    if(incompatible){this.fallback();}
    else {
      this.sample(key,time);
      if(state==='run'&&p.speed>.02&&this.aim>.002){
        // Aiming controls the upper body, not locomotion: keep the authored
        // walking legs/pelvis while preserving the stabilized chest and arms.
        const upper={};
        for(const [name,b] of Object.entries(this.bones)){
          if(!/^(pelvis|thigh|shin|foot|kneecap)/.test(name))
            upper[name]={p:b.position.clone(),q:b.quaternion.clone()};
        }
        this.sample('Walk',this.clock%(38/60));
        for(const [name,pose] of Object.entries(upper)){
          this.bones[name].position.copy(pose.p);this.bones[name].quaternion.copy(pose.q);
        }
      }
      this.rig.root.updateWorldMatrix(true,true);
      const chest=this.b('chest'), q=r.root.getWorldQuaternion(Q());
      const pitch=Q().setFromEuler(new THREE.Euler((p.aimPitch??0)*.16,(p.aimYawErr??0)*.35,0));
      const worldOffset=q.clone().multiply(pitch).multiply(q.clone().invert());
      this.world('chest',null,worldOffset.multiply(chest.getWorldQuaternion(Q())));
    }
    this.transition=Math.min(1,this.transition+dt/.16);
    if(respawning)this.transition=1;
    if(this.transition<1&&state!=='dead'){
      const t=this.transition*this.transition*(3-2*this.transition);
      for(const [n,b] of Object.entries(this.bones)){
        const old=this.previous[n];
        b.position.lerpVectors(old.p,b.position,t);b.quaternion.slerpQuaternions(old.q,b.quaternion,t);
      }
    }
    r.root.updateWorldMatrix(true,true);
    if(state!=='dead'){
      const gun=r.activeGun,gq=gun.getWorldQuaternion(Q());
      const targets=['R','L'].map(side=>{
        const arm=side==='R'?r.armR:r.armL;
        const procedural=incompatible||state==='roadie'||(gun.userData.oneHand&&!p.aim&&side==='L');
        const socket=side==='R'?gun.userData.grip:(p.aim&&gun.userData.aimSupport)||gun.userData.forend;
        return procedural||!socket?arm.hand.getWorldPosition(V()):socket.getWorldPosition(V());
      });
      this.fitUpperBody(targets);
      for(const [i,side] of ['R','L'].entries())this.arm(side,targets[i],gq.clone().multiply(this.handQ[side]));
    }
    // Existing death decisions remain authoritative; only presentation differs.
    this.root.visible=r.torso.visible;
    for(const [bone,node] of [['head',r.head],['upper_arm.L',r.armL.shoulder],['upper_arm.R',r.armR.shoulder],
      ['shin.L',r.legL.knee],['shin.R',r.legR.knee]])if(!node.visible)this.b(bone).scale.setScalar(.00001);
    r.root.updateWorldMatrix(true,true);
  }
  dispose(){
    const skeletons=new Set(this.meshes.map(m=>m.skeleton).filter(Boolean));
    for(const s of skeletons)s.dispose();
  }
}
