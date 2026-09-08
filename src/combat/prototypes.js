import {TUNING} from '../config/tuning.js';
import {makeSmokeProjectile,stepSmokeProjectile} from '../game/smoke-physics.js';
import {evaluateBlast,blastBodyHeight} from './blast.js';

const distance=(a,b)=>Math.hypot(a.x-b.x,(a.y??0)-(b.y??0),a.z-b.z);
// Authority-only state. Browsers online render snapshots; they never resolve
// stun hits, grenade damage or competing pickup claims themselves.
export class CombatPrototypes {
 constructor({actors,physics,blocked,damage,event=()=>{},inventory=()=>{},experimental=false}){
  Object.assign(this,{actors,physics,blocked,damage,event,inventory,experimental});
  this.time=0;this.sequence=0;this.key=null;this.active=false;this.reset();
 }
 reset(){this.pickups=[];this.projectiles=[];this.states=new Map();}
 state(id){if(!this.states.has(id))this.states.set(id,{frag:0,stunAmmo:0,until:0,immune:0,cooldown:0,equipment:'grenade'});return this.states.get(id);}
 stunned(id){return (this.states.get(id)?.until??0)>this.time;}
 setRound(key,active){
  if(!active){if(this.active){this.reset();this.key=null;}this.active=false;return;}
  if(this.key!==key){this.reset();this.key=key;this.time=0;
   for(const side of [-1,1]){
    // Search paired clear floor positions, away from spawns and center cover.
    for(const [x,z]of [[6,8],[8,12],[4,8],[10,8],[6,12],[10,14]]){
     const p={x:x*side,z:z*side};const probe={...p};this.physics.resolveCircle(probe,.65,0);
     if(distance(p,probe)>.02)continue;
     p.y=this.physics.groundHeight(p,.2,0);
     this.pickups.push({id:`frag:${side}`,kind:'frag',count:2,...p,ready:0});break;
    }
   }
   if(this.experimental&&this.pickups[0]){
    const p=this.pickups[0];
    for(const offset of [1.5,-1.5,2.5,-2.5]){
      const q={x:p.x,z:p.z+offset},probe={...q};this.physics.resolveCircle(probe,.65,p.y);
      if(distance(q,probe)>.02)continue;
      this.pickups.push({...q,y:this.physics.groundHeight(q,.2,p.y),id:'stun:test',kind:'stun',count:4,ready:0});break;
    }
   }
  }
  this.active=active;
 }
 claim(id,pickupId,manual=false){
  const actor=this.actors().find(a=>a.id===id),p=this.pickups.find(p=>p.id===pickupId);
  if(!this.active||!actor?.alive||this.stunned(id)||!p||p.ready>this.time||!p.count||distance(actor,p)>1.35)return false;
  if(this.blocked({...actor,y:(actor.y??0)+.8},{...p,y:p.y+.35}))return false;
  const s=this.state(id);
  if(p.kind==='frag'){
   if(s.equipment!=='frag'&&!manual)return false;
   const taken=Math.min(p.count,2-s.frag);if(taken<=0)return false;
   s.frag+=taken;s.equipment='frag';p.count-=taken;
  }else{
   if(!manual||!this.experimental||s.stunAmmo>0)return false;
   s.stunAmmo=p.count;p.count=0;
  }
  if(p.count===0)p.ready=this.time+45;
  this.inventory(id,{kind:p.kind,count:p.kind==='frag'?s.frag:s.stunAmmo});return true;
 }
 fire(id,kind,origin,direction){
  const actor=this.actors().find(a=>a.id===id),s=this.state(id);
  if(!this.active||!actor?.alive||this.stunned(id)||!['frag','stun'].includes(kind)||s.cooldown>this.time||this.projectiles.length>=48)return false;
  if(!origin||!direction||![origin.x,origin.y,origin.z,direction.x,direction.y,direction.z].every(Number.isFinite))return false;
  if(distance(origin,{...actor,y:(actor.y??0)+1})>2.3)return false;
  if(this.blocked({...actor,y:(actor.y??0)+1},origin))return false;
  const len=Math.hypot(direction.x,direction.y,direction.z);if(len<.5||len>1.5)return false;
  if(kind==='frag'?(s.equipment!=='frag'||s.frag<=0):(!this.experimental||s.stunAmmo<=0))return false;
  const def=TUNING.weapons[kind],speed=kind==='frag'?def.throwSpeed:def.projSpeed;
  const v={x:direction.x/len*speed,y:direction.y/len*speed+(kind==='frag'?def.throwUp:0),z:direction.z/len*speed};
  this.projectiles.push(makeSmokeProjectile(origin,v,{id:++this.sequence,owner:id,team:actor.team,kind,distance:0}));
  if(kind==='frag')s.frag--;else s.stunAmmo--;
  s.cooldown=this.time+60/def.rpm;
  this.inventory(id,{kind,count:kind==='frag'?s.frag:s.stunAmmo});
  this.event({kind:'launch',weapon:kind,owner:id,p:{...origin}});return true;
 }
 applyStun(actor){
  const s=this.state(actor.id),d=TUNING.weapons.stun;
  if(!actor.alive||actor.protected||s.until>this.time||s.immune>this.time)return false;
  s.until=this.time+d.stunDuration;s.immune=s.until+d.stunImmunity;
  this.event({kind:'stun',target:actor.id,p:{x:actor.x,y:(actor.y??0)+1,z:actor.z}});return true;
 }
 tick(dt){
  if(!this.active)return;
  if(!Number.isFinite(dt)||dt<=0)return;
  const skipped=Math.max(0,dt-.25);this.time+=skipped;
  for(const p of this.projectiles)p.t+=skipped;
  // Fixed bounded substeps prevent grenade tunnelling during a slow frame.
  const steps=Math.max(1,Math.ceil(Math.min(.25,dt)*120)),step=Math.min(.25,dt)/steps;
  for(let i=0;i<steps;i++)this.step(step);
 }
 step(dt){
  this.time+=dt;const actors=this.actors();
  for(const id of this.states.keys())if(!actors.some(a=>a.id===id&&a.alive))this.states.delete(id);
  for(const p of this.pickups)if(!p.count&&p.ready<=this.time)p.count=p.kind==='frag'?2:4;
  for(let i=this.projectiles.length-1;i>=0;i--){
   const p=this.projectiles[i],def=TUNING.weapons[p.kind];
   if(p.kind==='frag'){
    stepSmokeProjectile(p,dt,this.physics);
    const warning=p.t>=2?3:p.t>=1.6?2:p.t>=.8?1:0;
    if(warning>(p.warning??0)){p.warning=warning;this.event({kind:'fuse',p:{x:p.x,y:p.y,z:p.z}});}
    if(p.t<def.fuse)continue;
    this.projectiles.splice(i,1);this.event({kind:'explosion',p:{x:p.x,y:p.y,z:p.z},owner:p.owner});
    for(const a of actors){
     const self=a.id===p.owner;if(!a.alive||a.protected||a.team===p.team&&!self)continue;
     const result=evaluateBlast(def,p,a,this.blocked,{self});
     if(result.damage>.01)this.damage(p.owner,a.id,result.damage,{weapon:'frag',part:'body',distance:result.distance,damage:result.damage,explosionPoint:{x:p.x,y:p.y,z:p.z},exposure:result.exposure});
    }
    this.event({kind:'blastResolved'});
   }else{
    const from={x:p.x,y:p.y,z:p.z},to={x:p.x+p.vx*dt,y:p.y+p.vy*dt,z:p.z+p.vz*dt};
    p.t+=dt;p.distance+=distance(from,to);
    let target=null,best=Infinity;
    for(const a of actors){
     if(!a.alive||a.protected||a.team===p.team||a.id===p.owner)continue;
     const v={x:to.x-from.x,y:to.y-from.y,z:to.z-from.z};
     const height=blastBodyHeight(a),center={x:a.x,y:(a.y??0)+height*.5,z:a.z};
     const t=Math.max(0,Math.min(1,((center.x-from.x)*v.x+(center.y-from.y)*v.y+(center.z-from.z)*v.z)/(v.x*v.x+v.y*v.y+v.z*v.z)));
     const q={x:from.x+v.x*t,y:from.y+v.y*t,z:from.z+v.z*t};
     if(Math.hypot(q.x-center.x,q.z-center.z)<.30&&Math.abs(q.y-center.y)<height*.5&&t<best&&!this.blocked(from,q)){target=a;best=t;}
    }
    if(target){this.applyStun(target);this.projectiles.splice(i,1);continue;}
    if(p.distance>=def.range||this.blocked(from,to)){this.projectiles.splice(i,1);continue;}
    Object.assign(p,to);
   }
  }
 }
 snapshot(){return {time:this.time,active:this.active,pickups:this.pickups,projectiles:this.projectiles.map(({id,kind,x,y,z,t})=>({id,kind,x,y,z,t})),states:[...this.states].map(([id,s])=>({id,remaining:Math.max(0,s.until-this.time),immune:Math.max(0,s.immune-this.time)}))};}
}
