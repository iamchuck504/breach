import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
import fs from 'node:fs/promises';

const out='artifacts/soldier-skins';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:CHROME});
try{
  const page=await browser.newPage({viewport:{width:2200,height:820}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5200/?nolock=1');
  const report=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js');
    const {Rig}=await import('/src/player/rig.js');
    const scene=new T.Scene(),rigs=[],references=[],rows=[];
    for(const team of ['red','blue'])for(let v=0;v<5;v++){
      history.replaceState(null,'','/?soldier=legacy');
      const old=new Rig(scene,team,null,v);references.push(old);
      history.replaceState(null,'','/?soldier=blender');
      const rig=new Rig(scene,team,null,v);await rig.visualReady;
      rig.update(0,{state:'idle',speed:0});rigs.push(rig);
      rows.push({team,variant:v,name:rig.root.userData.skin});
    }
    const joints=r=>[r.hips,r.torso,r.head,r.aimRig,r.armL.shoulder,r.armL.elbow,r.armL.hand,
      r.armR.shoulder,r.armR.elbow,r.armR.hand,r.legL.hip,r.legL.knee,r.legR.hip,r.legR.knee];
    let maxPoseError=0,maxMuzzleError=0,opaque=true,shared=true,samePalette=true;
    const recruitMaterials={red:new Set(),blue:new Set()};
    for(const r of rigs.filter(r=>r.variant===0))r.root.traverse(o=>{
      if(o.userData.blenderSoldier)for(const m of Array.isArray(o.material)?o.material:[o.material])
        recruitMaterials[r.team].add(m);
    });
    const random=Math.random;Math.random=()=>.5;
    for(let i=0;i<rigs.length;i++){
      const r=rigs[i],old=references[i];
      for(const weapon of ['smg','pistol','shotgun','sniper','bazooka','grenade']){
        r.setWeapon(weapon);old.setWeapon(weapon);
        for(const state of ['idle','run','roadie','cover_low','blind_over','blind_high_left','blind_high_right','melee','dead','idle']){
          for(let f=0;f<25;f++){
            const p={state,speed:.7,aim:state==='idle',aimPitch:.15};
            old.update(1/60,p);r.update(1/60,p);
            old.root.updateWorldMatrix(true,true);r.root.updateWorldMatrix(true,true);
            const a=joints(old),b=joints(r);
            for(let j=0;j<a.length;j++)for(let k=0;k<16;k++)
              maxPoseError=Math.max(maxPoseError,Math.abs(a[j].matrixWorld.elements[k]-b[j].matrixWorld.elements[k]));
            maxMuzzleError=Math.max(maxMuzzleError,old.muzzleWorld(new T.Vector3()).distanceTo(r.muzzleWorld(new T.Vector3())));
          }
        }
      }
      r.root.traverse(o=>{
        if(!o.userData.blenderSoldier)return;
        for(const m of Array.isArray(o.material)?o.material:[o.material]){
          opaque&&=!m.transparent&&m.opacity===1&&m.depthWrite;
          shared&&=!!m.userData.shared;
          samePalette&&=recruitMaterials[r.team].has(m);
        }
      });
      old.root.visible=false;r.setWeapon('smg');
      for(let f=0;f<75;f++)r.update(1/60,{state:'idle',speed:0,aim:false});
      r.setTransform((2-i%5)*1.65,0,0);
    }
    Math.random=random;
    scene.background=new T.Color(0x2b313a);
    scene.add(new T.HemisphereLight(0xe7efff,0x56504a,2.7));
    const key=new T.DirectionalLight(0xfff3e7,2.5);key.position.set(-4,6,-6);scene.add(key);
    const cam=new T.OrthographicCamera(-4.5,4.5,1.677,-1.677,.01,40);
    cam.position.set(0,1.05,-8);cam.lookAt(0,1.05,0);
    const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(2200,820);
    const images={};
    for(const team of ['red','blue'])for(const view of ['front','back']){
      for(const r of rigs){r.root.visible=r.team===team;r.root.rotation.y=view==='front'?0:Math.PI;}
      renderer.render(scene,cam);images[team+'-'+view]=renderer.domElement.toDataURL();
    }
    const close=new T.OrthographicCamera(-2.3,2.3,.50,-.50,.01,40);
    close.position.set(0,1.57,-8);close.lookAt(0,1.57,0);
    renderer.setSize(2200,478);
    for(const team of ['red','blue']){
      for(const r of rigs){
        r.root.visible=r.team===team;r.setTransform((2-r.variant)*.87,0,0);
        r.backMount.visible=false;r.gunMount.visible=false;
      }
      renderer.render(scene,close);images[team+'-masks']=renderer.domElement.toDataURL();
    }
    for(const r of [...rigs,...references])r.dispose(scene);renderer.dispose();
    return {rows,maxPoseError,maxMuzzleError,opaque,shared,samePalette,images};
  });
  for(const [name,url] of Object.entries(report.images))await fs.writeFile(`${out}/${name}.png`,Buffer.from(url.split(',')[1],'base64'));
  delete report.images;console.log(JSON.stringify({...report,errors},null,2));
  if(report.maxPoseError>1e-8||report.maxMuzzleError>1e-8||!report.opaque||!report.shared||!report.samePalette||errors.length||new Set(report.rows.map(r=>r.name)).size!==5)process.exitCode=1;
}finally{await browser.close();}
