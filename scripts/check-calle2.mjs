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

assert(!MAPS.includes('calle')&&MAPS.includes('calle2'));
assert.equal(normalizeLobbySettings({map:'calle'}).map,'calle2');
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
    const cafes=buildings.filter(b=>b.userData.blenderCafe);
    const polished=[];world.mapGroup.traverse(o=>{if(o.userData.callePolish)polished.push(o);});
    checks.propPolish=['sedan','truck','bus','dumpster','jersey','kiosk','coffee','suvMinivan','streetlight','busShelter']
      .every(kind=>polished.some(o=>o.userData.callePolish===kind));
    const modeled=world.mapGroup.children.filter(o=>o.userData.blenderProp);
    checks.blenderStreetProps=['coffee','hotdog','news','dumpster','jersey','roadwork']
      .every(kind=>modeled.some(o=>o.userData.blenderProp===kind));
    checks.blenderPropEnvelope=modeled.every(o=>{
      const fallback=o.getObjectByName('procedural-prop-fallback');
      if(!fallback||fallback.visible)return false;
      const old=new T.Box3().setFromObject(fallback,true),current=new T.Box3();
      for(const c of o.children)if(c!==fallback)current.union(new T.Box3().setFromObject(c,true));
      const fits=['x','y','z'].every(a=>current.min[a]>=old.min[a]-.08&&current.max[a]<=old.max[a]+.08);
      if(!fits)throw Error(JSON.stringify({prop:o.userData.blenderProp,key:o.userData.editorDecorKey,old,current}));
      return fits;
    });
    // Plaques must be readable from standing approach angles, not merely
    // when looking horizontally at their centers. Ignore hidden fallbacks.
    checks.propSignClearance=true;
    for(const group of modeled){
      const id=group.userData.blenderProp;
      const model=group.children.find(c=>c.name!=='procedural-prop-fallback');
      const samples=[];
      if(id==='hotdog'||id==='news'){
        const z=id==='hotdog'?1.311:1.361;
        for(const x of [-.4,0,.4])for(const y of [2.32,2.40,2.48])samples.push([x,y,z,1]);
      }
      if(id==='coffee')for(const y of [1.535,1.625])samples.push([-.37,y,.135,-1]);
      if(id==='hotdog')for(const y of [1.65,1.78,1.94])samples.push([0,y,-.66,1]);
      if(id==='dumpster')for(const side of [-1,1])for(const x of [-.3,0,.3])samples.push([x,.60,side*.98,side]);
      model.updateWorldMatrix(true,true);
      for(const [x,y,z,side] of samples)for(const approach of [-.65,0,.65]){
        const target=model.localToWorld(new T.Vector3(x,y,z));
        const origin=model.localToWorld(new T.Vector3(approach,1.63,z+side*2.5));
        const hit=new T.Raycaster(origin,target.clone().sub(origin).normalize(),0,5).intersectObject(model,true)[0];
        const clear=!!hit&&hit.point.distanceTo(target)<.065;
        if(!clear)throw Error(`Prop sign blocked: ${id} ${group.userData.editorDecorKey} ${[x,y,z,approach]} by ${hit?.object.name}`);
        checks.propSignClearance&&=clear;
      }
    }
    checks.parentedPropDetails=polished.every(p=>p.children.filter(o=>o.name.startsWith('calle2-prop-polish:'))
      .every(o=>o.position.length()===0&&o.rotation.x===0&&o.rotation.y===0&&o.rotation.z===0));
    checks.propSilhouette=polished.every(p=>{
      p.updateWorldMatrix(true,true);
      const before=new T.Box3();
      for(const c of p.children)if(!c.name.startsWith('calle2-prop-polish:'))before.union(new T.Box3().setFromObject(c));
      const after=new T.Box3().setFromObject(p);
      return ['x','y','z'].every(a=>after.min[a]>=before.min[a]-.04&&after.max[a]<=before.max[a]+.04);
    });
    checks.allDistrictFacades=buildings.length===14&&buildings.every(b=>b.userData.blenderFacade);
    checks.facadeDimensions=buildings.every(b=>{
      const meta=b.userData.streetBuilding;
      const box=new T.Box3().setFromObject(b.getObjectByName('Existing_envelope'));
      return Math.abs(box.max.z-box.min.z-meta.span)<.002&&Math.abs(box.max.x-box.min.x-5.4)<.002;
    });
    checks.doorAlignment=buildings.filter(b=>!b.userData.blenderCafe).every(b=>{
      const door=b.getObjectByName('Door_leaf');if(!door)return false;
      const box=new T.Box3().setFromObject(door),pos=box.getCenter(new T.Vector3());
      return Math.abs(pos.z-(b.position.z+b.userData.streetBuilding.span*.31))<.002&&box.max.y-box.min.y>2.4;
    });
    checks.blenderCafe=cafes.length===1&&cafes[0].position.z===-24;
    checks.cafeDrawBudget=cafes.every(b=>{
      let meshes=0; b.traverse(o=>{if(o.isMesh) meshes++;}); return meshes>0&&meshes<=24;
    });
    checks.shopIdentity=new Set(buildings.map(b=>b.userData.streetBuilding.name)).size===buildings.length;
    checks.signClearance=true;
    scene.updateMatrixWorld(true);
    for(const b of buildings){
      const sign=b.getObjectByName(b.userData.blenderFacade?'Sign_enamel_inset':'street-shop-sign');
      if(!sign){checks.signClearance=false;continue;}
      const o=sign.localToWorld(new T.Vector3(0,0,.8));
      const target=sign.localToWorld(new T.Vector3(0,0,0));
      const hit=new T.Raycaster(o,target.sub(o).normalize(),0,.8).intersectObject(b,true)[0];
      let belongs=false;for(let p=hit?.object;p;p=p.parent)if(p===sign)belongs=true;
      if(b.userData.blenderFacade&&['Shop_title','Shop_subtitle'].includes(hit?.object.name))belongs=true;
      checks.signClearance&&=belongs;
    }
    checks.roofLayers=buildings.every(b=>{
      const mass=b.getObjectByName(b.userData.blenderFacade?'Existing_envelope':'street-building-mass'),roof=b.getObjectByName(b.userData.blenderFacade?'Roof_cap':'street-building-roof');
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
    const upperBatches=district.children.filter(o=>o.name==='calle2-instanced-upper-facades');
    checks.upperFacadeBatchBudget=upperBatches.length>0&&upperBatches.length<=70;
    const patrols=world.mapGroup.children.filter(o=>o.userData.police);
    checks.policePair=patrols.length===2&&patrols.every(p=>Math.abs(p.position.x)===8.8&&Math.abs(p.position.z)===26);
    const baseFloors=district.children.filter(o=>['service-alley-floor','workshop-floor'].includes(o.name));
    const markings=district.children.filter(o=>['loading-pad','workshop-bay-line','alley-loading-line'].includes(o.name));
    checks.floorLayers=markings.every(m=>baseFloors.every(f=>m.position.y>f.position.y+.005));
    for(const side of [-1,1]){
      checks.storeAccess??=true;
      for(const end of [-1,1])checks.storeAccess&&=world.navigation.clear(
        {x:side*15,z:end*28},{x:side*15,z:end*40});
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
    for(const b of buildings){
      const {side,z,name}=b.userData.streetBuilding;
      cam.position.set(side*3,5,z+6);cam.lookAt(side*16.1,4,z);
      renderer.render(scene,cam);images['shop-'+name.replace(/[^a-z0-9]/gi,'-')]=renderer.domElement.toDataURL();
    }
    cam.position.set(0,88,70);cam.lookAt(0,0,0);renderer.render(scene,cam);
    images.aerial=renderer.domElement.toDataURL();scene.fog=fog;
    for(const [name,p,target] of [
      ['cafe',[3,5,-18],[16.1,4.4,-24]],
      ['polish-sedan',[5,2.0,-31],[8.8,.7,-26]],
      ['polish-truck',[-9,2,-8],[-6.5,1.5,-1.5]],
      ['polish-bus',[-8,2.1,-28],[0,1.5,-34.5]],
      ['polish-waste',[12.4,1.5,5.2],[15.15,.7,8]],
      ['polish-kiosk',[11.4,1.6,-30],[14.35,1.4,-26]],
      ['blender-coffee',[12,1.7,-11],[14.35,1.1,-8.5]],
      ['blender-hotdog',[11,1.9,-27],[13.3,1.4,-30]],
      ['blender-news',[-11,1.9,-26],[-13.3,1.4,-29]],
      ['seam',[9,2.3,24],[16.15,5,29]],
      ['police',[13,2.5,-30],[8.8,.85,-26]],
      ['storefront',[11,2.1,33],[16.1,1.5,36]],
      ['closure',[8,2.1,37],[10.8,1.8,42]],
      ['shop-access',[-15,2.1,40],[-14,1.5,29]],
      ['seam-oblique',[12,2.3,34],[16.15,5,29]],
      ['alley',[-25,2.3,-18],[-25,1.6,14]],
      ['alley-windows',[-25,2.3,-9],[-29.1,6.4,0]],
      ['workshop-windows',[25,2.3,9],[29.1,6.4,0]],
      ['workshop',[25,2.3,-18],[25,1.6,14]],
      ['entrance',[-10,2.4,-20],[-24,1.5,-18]],
      ['street',[8,2.4,-27],[-3,1.7,4]],
    ]){cam.position.set(...p);cam.lookAt(...target);renderer.render(scene,cam);images[name]=renderer.domElement.toDataURL();}
    const nodes=world.navigation.nodes.length;
    const performance={triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls};
    world.setLayout('calle');checks.originalUnchanged=JSON.stringify(original)===JSON.stringify(world.colliders.map(key))&&world.navigation===null;
    checks.polishScoped=true;world.mapGroup.traverse(o=>{if(o.userData.callePolish)checks.polishScoped=false;});
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
  assert(!options.includes('calle')&&options.includes('calle2'));
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
