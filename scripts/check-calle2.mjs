import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
import {expandedCollisionBoxes} from '../src/world/collision-layouts.js';
import {MAPS,MAP_RUNTIME,normalizeLobbySettings} from '../src/game/lobby-rules.js';
import {mapLineBlocked} from '../server/map-geometry.js';
import {CALLE_2_VEHICLE_MOVES,calle2VehiclePosition,SIDE_PROPS} from '../src/world/calle-expansion.js';

// Tactical edits remain paired and cannot silently move only a visual car.
const tacticalBoxes=expandedCollisionBoxes('calle2');
for(const {from,to} of CALLE_2_VEHICLE_MOVES)for(const side of [-1,1]){
  assert.deepEqual(calle2VehiclePosition(from[0]*side,from[1]*side),to.map(v=>v*side));
  assert(tacticalBoxes.some(b=>Math.abs((b.minx+b.maxx)/2-to[0]*side)<1e-6&&
    Math.abs((b.minz+b.maxz)/2-to[1]*side)<1e-6&&b.h===1.1));
}
for(const p of SIDE_PROPS){
  assert(Math.abs(p.z)+p.d/2<15.8,'Side cover stays outside portal mouths');
  assert(Math.abs(p.x)-p.w/2>25+.48,'Center route retains body clearance');
}

assert(MAPS.includes('calle')&&MAPS.includes('calle2'));
assert.equal(normalizeLobbySettings({map:'calle2'}).map,'calle2');
assert.deepEqual(MAP_RUNTIME.calle,MAP_RUNTIME.calle2);
for(const side of [-1,1]){
  for(const z of [-18,18])assert.equal(mapLineBlocked('calle2',[side*14,1.2,z],[side*25,1.2,z]),false);
  assert.equal(mapLineBlocked('calle2',[side*14,1.2,0],[side*25,1.2,0]),true);
  assert.equal(mapLineBlocked('calle2',[side*25,1.2,18],[side*25,1.2,38]),true);
}
const out='artifacts/calle2';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
  const page=await browser.newPage({viewport:{width:1600,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5200/?nolock=1',{waitUntil:'networkidle'});
  const report=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js');
    const {World}=await import('/src/world/world.js');
    const {Bot}=await import('/src/game/botmatch.js');
    const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');
    await preloadUrbanAssets();
    const scene=new T.Scene(),world=new World(scene,'calle');
    const key=b=>[b.minx,b.maxx,b.minz,b.maxz,b.h].join(':');
    const original=world.colliders.map(key),spawns=JSON.stringify(world.spawns);
    world.setLayout('calle2');
    const boxes=world.colliders.map(({minx,maxx,minz,maxz,h})=>({minx,maxx,minz,maxz,h}));
    const checks={spawnsUnchanged:spawns===JSON.stringify(world.spawns),portals:true,paths:true,
      botRoutes:true,originalUnchanged:false,interiorSolid:true,wallCover:true,floorLayers:true,seamsClear:true};
    const buildings=world.mapGroup.children.filter(o=>o.userData.streetBuilding);
    checks.roofLayers=buildings.every(b=>{
      const mass=b.getObjectByName('street-building-mass'),roof=b.getObjectByName('street-building-roof');
      if(!mass||!roof)return false;
      const bodyBox=new T.Box3().setFromObject(mass),roofBox=new T.Box3().setFromObject(roof);
      return Math.abs(bodyBox.max.y-roofBox.min.y)<1e-5&&roofBox.max.y-bodyBox.max.y>.17;
    });
    const seams=world.mapGroup.children.filter(o=>o.name==='street-building-seam');
    checks.seamsClear=seams.length>0&&seams.every(seam=>buildings.every(building=>{
      const b=building.userData.streetBuilding;
      if(Math.sign(seam.position.x)!==b.side)return true;
      const z=b.z,half=b.span/2,s=seam.geometry.parameters.depth/2;
      return Math.min(z+half,seam.position.z+s)-Math.max(z-half,seam.position.z-s)<1e-6;
    }));
    const district=world.mapGroup.getObjectByName('calle2-service-districts');
    const patrols=world.mapGroup.children.filter(o=>o.userData.police);
    checks.policePair=patrols.length===2&&patrols.every(p=>Math.abs(p.position.x)===8.8&&Math.abs(p.position.z)===26);
    const baseFloors=district.children.filter(o=>['service-alley-floor','workshop-floor'].includes(o.name));
    const markings=district.children.filter(o=>['loading-pad','workshop-bay-line','alley-loading-line'].includes(o.name));
    checks.floorLayers=markings.every(m=>baseFloors.every(f=>m.position.y>f.position.y+.005));
    for(const side of [-1,1]){
      for(const z of [-13,6,13])for(const [x,dx] of [[22.25,-1],[28.3,1]]){
        const found=world.findCover({x:side*x,z},{x:side*dx,z:0},1.2,.38);
        checks.wallCover&&=!!found&&found.face.kind==='high';
      }
      for(const z of [-18,18])checks.portals&&=world.navigation.clear({x:side*14,z},{x:side*25,z});
      const ray=new T.Raycaster(new T.Vector3(side*14,1.4,0),new T.Vector3(side,0,0),0,11);
      checks.interiorSolid&&=world.raycast(ray.ray.origin,ray.ray.direction,11)!==null;
      for(const z of [-18,18]){
        ray.ray.origin.set(side*14,1.4,z);
        // Check the visible meshes too: collision-clear passages must not
        // contain an old facade, GLB, sign or misplaced decoration.
        const hits=ray.intersectObjects(world.mapGroup.children,true).filter(hit=>{
          for(let o=hit.object;o&&o!==world.mapGroup;o=o.parent)if(!o.visible)return false;
          return true;
        });
        checks.portals&&=hits.length===0;
      }
      const tasks=[
        [{x:side*13.5,z:-18},{x:side*25,z:0}],
        [{x:side*25,z:0},{x:side*13.5,z:18}],
        [{x:side*13.5,z:18},{x:side*25,z:0}],
        [{x:side*25,z:0},{x:side*13.5,z:-18}],
        [{x:side*25,z:0},{x:side*14,z:0}],
        [{x:side*10,z:-38},{x:side*13.5,z:-18}],
        [{x:side*10,z:38},{x:side*13.5,z:18}],
        [{x:side*13.5,z:-18},{x:side*10,z:0}],
        [{x:side*13.5,z:18},{x:side*10,z:0}],
      ];
      for(const [from,goal] of tasks){
        const path=world.navigation.path(from,goal);checks.paths&&=path.length>0;
        if(!path.length)throw new Error('No route '+JSON.stringify({from,goal,nodes:world.navigation.nodes}));
        let p=from;for(const q of path){checks.paths&&=world.navigation.clear(p,q);p=q;}
        // Exercise production bot steering and actual circle collision, not
        // only the planned path, at the normal navigation/body radius.
        const bot={world,pos:{...from},recovery:null};
        for(let f=0;f<2400&&Math.hypot(bot.pos.x-goal.x,bot.pos.z-goal.z)>.25;f++){
          const d=Math.hypot(goal.x-bot.pos.x,goal.z-bot.pos.z);
          let steer;
          try {steer=Bot.prototype._steer.call(bot,(goal.x-bot.pos.x)/d,(goal.z-bot.pos.z)/d,{},goal);}
          catch(e){throw new Error(JSON.stringify({from,goal,pos:bot.pos,path,next:world.navigation.next(bot.pos,goal,bot),message:e.message}));}
          bot.pos.x+=steer.x*.075;bot.pos.z+=steer.z*.075;world.resolveCircle(bot.pos,.38,0);
        }
        checks.botRoutes&&=Math.hypot(bot.pos.x-goal.x,bot.pos.z-goal.z)<.3;
      }
    }
    const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(1600,1100);renderer.setPixelRatio(1);
    renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
    const images={};
    // Tactical overview lifts fog only for this QA camera so both routes show.
    const fog=scene.fog;scene.fog=null;
    const top=new T.OrthographicCamera(-48,48,33,-33,.1,250);
    top.position.set(0,110,.01);top.up.set(0,0,-1);top.lookAt(0,0,0);
    top.left=-48;top.right=48;top.top=52;top.bottom=-52;
    renderer.setSize(1500,1625);top.updateProjectionMatrix();renderer.render(scene,top);
    images['top-down']=renderer.domElement.toDataURL();
    renderer.setSize(1600,1100);
    const cam=new T.PerspectiveCamera(55,1600/1100,.1,250);
    cam.position.set(0,88,70);cam.lookAt(0,0,0);renderer.render(scene,cam);
    images.aerial=renderer.domElement.toDataURL();scene.fog=fog;
    for(const [name,p,target] of [
      ['seam',[9,2.3,24],[16.15,5,29]],
      ['police',[13,2.5,-30],[8.8,.85,-26]],
      ['storefront',[11,2.1,33],[16.1,1.5,36]],
      ['closure',[8,2.1,37],[10.8,1.8,42]],
      ['seam-oblique',[12,2.3,34],[16.15,5,29]],
      ['alley',[-25,2.3,-18],[-25,1.6,14]],
      ['workshop',[25,2.3,-18],[25,1.6,14]],
      ['entrance',[-10,2.4,-20],[-24,1.5,-18]],
      ['street',[8,2.4,-27],[-3,1.7,4]],
    ]){cam.position.set(...p);cam.lookAt(...target);renderer.render(scene,cam);images[name]=renderer.domElement.toDataURL();}
    const nodes=world.navigation.nodes.length;
    const performance={triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls};
    world.setLayout('calle');checks.originalUnchanged=JSON.stringify(original)===JSON.stringify(world.colliders.map(key))&&world.navigation===null;
    renderer.dispose();return {boxes,checks,nodes,performance,images};
  });
  for(const [name,url] of Object.entries(report.images))await fs.writeFile(`${out}/${name}.png`,Buffer.from(url.split(',')[1],'base64'));
  delete report.images;
  assert.deepEqual(report.boxes,expandedCollisionBoxes('calle2'),'server/client geometry');delete report.boxes;
  console.log(JSON.stringify({...report,errors},null,2));
  assert.deepEqual(errors,[]);for(const [name,ok] of Object.entries(report.checks))assert(ok,name);
  // Real menu -> local lobby -> match smoke test. The existing map remains
  // selectable alongside #2; no debug-only entry point is required to play it.
  await page.evaluate(()=>document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off',{state:'attached'});
  await page.evaluate(()=>document.getElementById('btn-bots').click());
  const selector=page.locator('[data-setting="map"]');
  const options=await selector.locator('option').evaluateAll(items=>items.map(o=>o.value));
  assert(options.includes('calle')&&options.includes('calle2'));
  await selector.selectOption('calle2');
  await page.evaluate(()=>document.getElementById('btn-lobby-start').click());
  await page.waitForFunction(()=>window.BREACH_WORLD.layout==='calle2'&&window.BREACH.botMatch?.bots.length>0);
  const initial=await page.evaluate(()=>{
    const bm=window.BREACH.botMatch;bm.phase='playing';bm.phaseT=0;
    return bm.bots.map(b=>({id:b.id,x:b.pos.x,z:b.pos.z}));
  });
  await page.waitForTimeout(8000);
  const play=await page.evaluate(()=>({layout:window.BREACH_WORLD.layout,
    bots:window.BREACH.botMatch.bots.map(b=>({id:b.id,x:b.pos.x,z:b.pos.z,alive:b.alive})),
  }));
  assert.equal(play.layout,'calle2');
  assert(play.bots.every(b=>Number.isFinite(b.x)&&Number.isFinite(b.z)));
  const moved=play.bots.filter(b=>{const old=initial.find(o=>o.id===b.id);return Math.hypot(b.x-old.x,b.z-old.z)>1;}).length;
  assert(moved>=2,'bots advance in the actual match');
  assert.deepEqual(errors,[]);console.log('CALLE #2 PLAY OK',JSON.stringify({options,bots:play.bots.length,moved}));
}finally{await browser.close();}
