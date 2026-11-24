import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();await page.goto((process.env.BASE || 'http://127.0.0.1:5200') + '/?nolock=1');
 const report=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {World}=await import('/src/world/world.js'),{Rig}=await import('/src/player/rig.js');
  const {Controller,PLAYER_R}=await import('/src/player/controller.js');
  const {expandedCollisionBoxes}=await import('/src/world/collision-layouts.js');
  const world=new World(new T.Scene(),'azoteas'),rig=new Rig(world.scene??new T.Scene(),'red');await rig.visualReady;
  rig.wallFn=(o,d,m)=>world.raycast(o,d,m,0); // sonda de pared, como la inyecta el juego (ganchos/rig.md)
  const faces=world.faces.filter(f=>f.standOff),results=[];
  for(const b of expandedCollisionBoxes('azoteas'))if(!world.colliders.some(c=>['minx','maxx','minz','maxz','h'].every(k=>Math.abs(c[k]-b[k])<1e-6)))throw Error('colliders changed');
  for(const f of faces){
   const x=(f.a.x+f.b.x)/2,z=(f.a.z+f.b.z)/2;
   const start={x:x+f.n.x*1.4,z:z+f.n.z*1.4};
   const found=world.findCover(start,{x:-f.n.x,z:-f.n.z},2,PLAYER_R);if(found?.face!==f)continue;
   // PRUEBAS (corrida 6, FPS): sin cobertura pegada. La garantía (el soldado que
   // ven los demás no atraviesa la caseta) se mide en las posturas FPS junto a la
   // cara: de frente, agachado, inclinado a cada lado, asomado; empujando contra ella.
   const cam={yaw:Math.atan2(f.n.x,f.n.z),pitch:0,flatForward(){return{x:-Math.sin(this.yaw),z:-Math.cos(this.yaw)}},flatRight(){return{x:Math.cos(this.yaw),z:-Math.sin(this.yaw)}}};
   for(const [crouch,aim,lean] of [[false,false,0],[true,false,0],[true,true,0],[false,true,1],[false,true,-1],[true,true,1],[true,false,-1]]){
   const p=new Controller(world,cam);p.respawn({x:found.target.x,z:found.target.z,yaw:cam.yaw});
   const input={moveVec:()=>({x:0,z:1}),aimHeld:aim,crouchHeld:crouch,crouchPressed:false,leanAxis:lean,sprintHeld:false,jumpPressed:false,meleePressed:false};
   for(let i=0;i<100;i++){p.update(1/60,input,false);rig.setTransform(p.pos.x,p.pos.z,p.yaw,p.y);rig.update(1/60,{...p.animParams(),state:p.stanceLow>.005?'crouch':p.animParams().state,coverAimExposure:1-p.stanceLow,coverLean:p.lean});}
   rig.root.updateMatrixWorld(true);let clearance=Infinity,gunClear=Infinity;
   rig.root.traverse(o=>{if(!o.isMesh)return;let gun=false;for(let p=o;p;p=p.parent){if(!p.visible)return;if(p===rig.gunMount)gun=true;}const b=new T.Box3().setFromObject(o);
    const nearestX=f.n.x>0?b.min.x:b.max.x,nearestZ=f.n.z>0?b.min.z:b.max.z;
    const c=(nearestX-x)*f.n.x+(nearestZ-z)*f.n.z-.02;
    if(gun)gunClear=Math.min(gunClear,c);else clearance=Math.min(clearance,c);
   });
   if(clearance<0)throw Error('body penetration '+JSON.stringify({x,z,clearance,gunClear,pos:p.pos,crouch,aim,lean}));
   if(gunClear<0)throw Error('held weapon penetration '+JSON.stringify({x,z,clearance,gunClear,pos:p.pos,crouch,aim,lean}));
   results.push(Math.min(clearance,gunClear));
   }
  }
  // PRUEBAS (corrida 6): el rig de un BOT (creado por Bot, con la sonda de pared que le
  // inyecta botmatch.js) tampoco mete el arma en la caseta, de pie y agachado de cara a ella.
  const {Bot}=await import('/src/game/botmatch.js');
  let botSamples=0,botMin=Infinity;
  for(const f of faces.slice(0,4)){
   const x=(f.a.x+f.b.x)/2,z=(f.a.z+f.b.z)/2,yaw=Math.atan2(f.n.x,f.n.z);
   const b=new Bot(world.scene??new T.Scene(),world,'qa-bot','','red',{x:x+f.n.x*.42,z:z+f.n.z*.42,yaw},0);
   await b.rig.visualReady;
   if(!b.rig.wallFn)throw Error('el rig del bot no tiene sonda de pared');
   for(const ce of [1,0]){
    b.pos={x:x+f.n.x*.42,z:z+f.n.z*.42};b.yaw=b.rigYaw=yaw;b.velX=0;b.velZ=0;b.aim=false;b.wantCe=ce;b.ce=ce;b.wantCl=0;
    for(let i=0;i<100;i++){const anim=b._posture('idle',1/60);b.rig.setTransform(b.pos.x,b.pos.z,b.rigYaw,b.y??0);b.rig.update(1/60,b._rigParams(anim,1/60));}
    b.rig.root.updateMatrixWorld(true);let gunClear=Infinity;
    b.rig.root.traverse(o=>{if(!o.isMesh)return;let gun=false;for(let p=o;p;p=p.parent){if(!p.visible)return;if(p===b.rig.gunMount)gun=true;}if(!gun)return;const bb=new T.Box3().setFromObject(o);
     const nx=f.n.x>0?bb.min.x:bb.max.x,nz=f.n.z>0?bb.min.z:bb.max.z;gunClear=Math.min(gunClear,(nx-x)*f.n.x+(nz-z)*f.n.z-.02);});
    if(gunClear<0)throw Error('bot held weapon penetration '+JSON.stringify({x,z,ce,gunClear}));
    botSamples++;botMin=Math.min(botMin,gunClear);
   }
   b.rig.dispose?.(b.rig.root.parent);
  }
  return {faces:faces.length,samples:results.length,min:Math.min(...results),botSamples,botMin};
 });assert.equal(report.faces,8);assert.ok(report.samples>=4*7);assert.ok(report.botSamples>=4,'pocos casos de bot');console.log('Rooftop cover OK',report);
}finally{await browser.close();}
