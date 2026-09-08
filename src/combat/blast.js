// Shared continuous blast profile and body-sampled occlusion. No client-only
// bypass: the same samples are evaluated against authoritative map geometry.
export function blastFactor(distance,radius,core=.7){
 if(distance>=radius)return 0;
 if(distance<=core)return 1;
 const t=Math.max(0,Math.min(1,(distance-core)/(radius-core)));
 return 1-t*t*(3-2*t);
}
export const blastBodyHeight=target=>target.crouch||String(target.st??target.state).includes('low') ? .85:1.65;
export function blastExposure(origin,target,blocked){
 const height=blastBodyHeight(target);
 const samples=[[0,height*.23,0,.15],[0,height*.52,0,.30],[0,height*.86,0,.25],
  [-.22,height*.62,0,.075],[.22,height*.62,0,.075],[0,height*.62,-.22,.075],[0,height*.62,.22,.075]];
 let exposure=0;
 for(const [x,y,z,weight] of samples){
  const point={x:target.x+x,y:(target.y??0)+y,z:target.z+z};
  if(!blocked(origin,point))exposure+=weight;
 }
 return Math.min(1,exposure);
}
export function evaluateBlast(def,origin,target,blocked,{self=false,direct=false}={}){
 const distance=Math.hypot(target.x-origin.x,(target.y??0)+blastBodyHeight(target)*.52-origin.y,target.z-origin.z);
 if(!direct&&distance>=def.splashRadius)return {distance,exposure:0,damage:0,zone:'outside'};
 const exposure=blastExposure(origin,target,blocked);
 const damage=(direct?def.directDamage??def.dmg:def.dmg*blastFactor(distance,def.splashRadius,def.blastCore??.7))*exposure*(self?def.selfDamage??.85:1);
 return {distance,exposure,damage,zone:distance<=(def.blastCore??.7)?'core':distance<def.splashRadius*.55?'high':'outer'};
}
