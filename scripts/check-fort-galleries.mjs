import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import { mapLineBlocked,serverMapPhysics } from '../server/map-geometry.js';
import { galleryHeight } from '../src/world/fortaleza-galleries.js';

for(const side of [-1,1]){
  for(let z=-12;z<=12;z+=3){
    assert(!mapLineBlocked('fortaleza',[side*23,4.7,z],[side*19,4.7,z]),'window must be open');
    assert(mapLineBlocked('fortaleza',[side*23,3.8,z],[side*19,3.8,z]),'sill must block');
    assert(mapLineBlocked('fortaleza',[side*23,5.8,z],[side*19,5.8,z]),'lintel must block');
  }
  for(const end of [-1,1])for(let z=21.8;z>=14;z-=.1){
    const p={x:side*23.7,z:end*z},h=galleryHeight(p);
    assert(Math.abs(serverMapPhysics('fortaleza').groundHeight(p,.38,h)-h)<1e-6);
    const q={...p};serverMapPhysics('fortaleza').resolveCircle(q,.38,h);
    assert(Math.hypot(q.x-p.x,q.z-p.z)<1e-6,'stair must not push character');
  }
}
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5200/?nolock=1');
 const result=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');await preloadUrbanAssets();
  const {World}=await import('/src/world/world.js');
  const {Controller}=await import('/src/player/controller.js');
  const {Bot,BotMatch}=await import('/src/game/botmatch.js');
  const scene=new T.Scene(),world=new World(scene,'fortaleza'),nav=world.navigation;
  const routes=[],motion=[],botMotion=[];
  for(const side of [-1,1])for(const end of [-1,1]){
    const from={x:0,z:end*23.4},goal={x:side*23.7,z:0};
    const path=nav.path(from,goal);
    routes.push({side,end,path});
    const camera={yaw:0,pitch:0,flatForward:()=>({x:0,z:-1}),flatRight:()=>({x:1,z:0})};
    const player=new Controller(world,camera);player.pos={...from};
    let maxStep=0,frames=0;
    for(const target of [...path,{x:side*23.7,z:end*22.85},{x:side*18.8,z:end*22.85}]){
      let count=0;
      while(Math.hypot(player.pos.x-target.x,player.pos.z-target.z)>.18&&count++<1600){
        const dx=target.x-player.pos.x,dz=target.z-player.pos.z,d=Math.hypot(dx,dz);
        const input={moveVec:()=>({x:dx/d,z:-dz/d}),aimHeld:false,sprintHeld:false};
        const before=player.y;player.update(1/60,input,false);maxStep=Math.max(maxStep,Math.abs(player.y-before));frames++;
      }
      if(count>=1600)throw Error(`Stuck ${side}/${end}: ${JSON.stringify({target,pos:player.pos,y:player.y})}`);
    }
    motion.push({side,end,maxStep,frames,y:player.y});
    const botScene=new T.Scene(),match=new BotMatch(botScene,world,{player:()=>null},{external:true});
    const bot=new Bot(botScene,world,`gallery-${side}-${end}`,'TEST',end<0?'red':'blue',{...from,yaw:end<0?Math.PI:0},0);
    match.bots=[bot];match.nearestVisibleEnemy=()=>null;
    const steer=bot._steer.bind(bot);bot._steer=(...args)=>{const s=steer(...args);bot.testSteer=s;return s;};
    let steps=0,maxJump=0;
    for(const target of [goal,{x:side*18.8,z:end*22.85}]){
      bot.tacticalGoal={...target,role:'advance'};bot.wp=bot.tacticalGoal;bot.state='advance';
      bot.roleT=bot.decisionT=bot.repathT=999;bot.commitMove=true;
      let count=0;const trace=[];
      while(Math.hypot(bot.pos.x-target.x,bot.pos.z-target.z)>1.2&&count++<1800){
        bot.update(1/60,match);maxJump=Math.max(maxJump,bot.y-world.groundHeight(bot.pos,.38,bot.y));steps++;
        if(count%120===0||(count>=260&&count<=350&&count%10===0))trace.push({x:bot.pos.x,z:bot.pos.z,y:bot.y,wp:bot.wp,steer:bot.testSteer,next:nav.cache.get(bot)?.path?.[0],recovery:!!bot.recovery});
      }
      if(count>=1800)throw Error(`Bot stuck ${side}/${end}: ${JSON.stringify({target,pos:bot.pos,y:bot.y,trace})}`);
    }
    botMotion.push({side,end,steps,maxJump,y:bot.y});
  }
  const windows=[];
  for(const side of [-1,1])for(let z=-12;z<=12;z+=3){
    const o=new T.Vector3(side*23,4.7,z),d=new T.Vector3(-side,0,0);
    windows.push(world.raycast(o,d,4)===null);
  }
  const covers=[];
  for(const side of [-1,1]){
    const found=world.findCover({x:side*22.35,z:0},{x:-side,z:0},1.1,.38,.45,3);
    if(!found||Math.abs(found.face.h-1.1)>.001||found.face.topY!==4.1)throw Error('Upper sill cover missing');
    const camera={yaw:side*Math.PI/2,pitch:0,flatForward:()=>({x:-side,z:0}),flatRight:()=>({x:0,z:side})};
    const p=new Controller(world,camera);p.pos={...found.target};p.y=3;p._enterCover(found.face,found.target);
    for(let i=0;i<90;i++)p.update(1/60,{moveVec:()=>({x:0,z:0}),aimHeld:i<45,sprintHeld:false},false);
    covers.push({y:p.y,state:p.state,x:p.pos.x});
  }
  const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  renderer.setSize(1280,720);renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  const camera=new T.PerspectiveCamera(60,1280/720,.1,200),views=[];
  for(const [name,pos,target] of [
    ['entrance',[17,1.65,-23.8],[23.7,1.2,-21.3]],
    ['stairs',[23.7,1.65,-22.5],[23.7,4.1,-13]],
    ['gallery',[24.2,4.63,-10],[21,4.3,1]],
    ['courtyard',[10,1.65,-18],[20,4,0]],
    ['aerial',[40,47,49],[0,1,0]]]){
    // Inspection aerial only: hide distance fog, not geometry/lighting.
    const fog=scene.fog;if(name==='aerial')scene.fog=null;
    camera.position.set(...pos);camera.lookAt(...target);renderer.render(scene,camera);
    views.push({name,image:renderer.domElement.toDataURL(),calls:renderer.info.render.calls,triangles:renderer.info.render.triangles});
    scene.fog=fog;
  }
  renderer.dispose();
  return {blender:!!world.mapGroup.getObjectByName('fortaleza-galleries')?.userData.blender,routes,motion,botMotion,covers,windows,views};
 });
 await fs.mkdir('artifacts/fortaleza-galleries',{recursive:true});
 for(const v of result.views){await fs.writeFile(`artifacts/fortaleza-galleries/${v.name}.png`,Buffer.from(v.image.split(',')[1],'base64'));delete v.image;}
 console.log(JSON.stringify({...result,errors},null,2));
 assert(result.blender,'Blender model missing');assert(result.windows.every(Boolean));
 assert(result.routes.every(r=>r.path.length>1),'all four entrances must be reachable');
 assert(result.routes.every(r=>r.path.slice(0,-1).every(p=>p.z*r.end>=0)),'no detour to enemy spawn');
 assert(result.motion.every(r=>r.maxStep<.16&&Math.abs(r.y)<.01),'smooth ascent and return to ground');
 assert(result.botMotion.every(r=>r.maxJump<.05&&Math.abs(r.y)<.01),'bots must walk, not bounce up stairs');
 assert(result.covers.every(r=>r.state==='cover'&&Math.abs(r.y-3)<.01),'upper cover must retain deck elevation');
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
