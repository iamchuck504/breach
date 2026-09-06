import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import fs from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: CHROME });
const out = process.env.BREACH_CAPTURE_DIR ?? 'artifacts/blender-soldier';
await fs.mkdir(out, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.rig?.blenderSoldier);
  await page.screenshot({ path: `${out}/gameplay.png` });
  const report = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { Rig } = await import('/src/player/rig.js');
    const scene = new THREE.Scene();
    const originalUrl = location.href;
    history.replaceState(null, '', '/');
    const reference = new Rig(scene, 'red');
    history.replaceState(null, '', originalUrl);
    const candidate = new Rig(scene, 'red');
    const blue = new Rig(scene, 'blue');
    candidate.setProtected(true);
    await Promise.all([candidate.visualReady, blue.visualReady]);
    candidate.update(0,{state:'idle',speed:0});
    const protectionRestored=candidate._outlines?.length>0&&candidate._outlines.every(o=>o.visible);
    candidate.setProtected(false);
    let maxOrigin = 0, maxDirection = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const states = ['idle','run','roadie','cover_low','cover_high','blind_over',
      'blind_high_left','blind_high_right','blind_low_left','blind_low_right',
      'dive','slide','jump','mantle','melee','dead','idle'];
    const random=Math.random;
    Math.random=()=>.5; // Identical ragdoll impulses for the two rigs.
    for (const weapon of ['smg','shotgun','pistol','sniper','bazooka','grenade']) {
      reference.setWeapon(weapon);candidate.setWeapon(weapon);
      for (const state of states) for (const aim of [false,true]) {
        for (let f=0;f<30;f++) {
          const p={state,aim,speed:state==='run'?.5:0,aimPitch:.25,aimYawErr:.1,
            coverLean:state==='cover_high'?.5:0,coverKind:'wall',firing:false};
          reference.update(1/60,p);candidate.update(1/60,p);
          maxOrigin=Math.max(maxOrigin,reference.muzzleWorld(a).distanceTo(candidate.muzzleWorld(b)));
          maxDirection=Math.max(maxDirection,reference.gunForward(a).distanceTo(candidate.gunForward(b)));
        }
      }
    }
    Math.random=random;
    candidate.setProtected(true);candidate.setProtected(false);
    candidate.setDeathContext({weapon:'sniper',part:'head',lethal:true});
    candidate.update(1/60,{state:'dead',speed:0});
    const hiddenHead=!candidate.head.visible;
    candidate.update(1/60,{state:'idle',speed:0});
    const restoredHead=candidate.head.visible;
    // Front and rear, same gameplay rig and actual equipped weapons.
    reference.root.visible=false;candidate.setWeapon('smg');blue.setWeapon('smg');
    for (const rig of [candidate,blue]) {
      for(let i=0;i<120;i++)rig.update(1/60,{state:'idle',speed:0,aim:false});
    }
    candidate.setTransform(-.7,0,0);blue.setTransform(.7,0,Math.PI);
    scene.add(new THREE.HemisphereLight(0xe7f2ff,0x434751,3));
    const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(-3,5,-3);scene.add(light);
    scene.background=new THREE.Color(0x252c36);
    const camera=new THREE.PerspectiveCamera(36,1280/850,.01,50);
    camera.position.set(0,1.35,-4.8);camera.lookAt(0,.85,0);
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(1280,850);renderer.render(scene,camera);
    const image=renderer.domElement.toDataURL();
    const poses={};
    for(const [label,p] of Object.entries({
      aiming:{state:'idle',aim:true,speed:0},
      running:{state:'run',aim:false,speed:.7},
      overhead:{state:'blind_over',aim:false,speed:0},
    })) {
      for(let i=0;i<50;i++)for(const rig of [candidate,blue])rig.update(1/60,p);
      renderer.render(scene,camera);poses[label]=renderer.domElement.toDataURL();
    }
    const hasModel=candidate.blenderSoldier&&blue.blenderSoldier;
    candidate.dispose(scene);blue.dispose(scene);reference.dispose(scene);renderer.dispose();
    return {hasModel,maxOrigin,maxDirection,hiddenHead,restoredHead,protectionRestored,image,poses};
  });
  await fs.writeFile(`${out}/front-back.png`, Buffer.from(report.image.split(',')[1], 'base64'));
  delete report.image;
  for(const [name,data] of Object.entries(report.poses))
    await fs.writeFile(`${out}/${name}.png`,Buffer.from(data.split(',')[1],'base64'));
  delete report.poses;
  const failedPage=await browser.newPage();
  await failedPage.route('**/soldier-blender-body.glb',route=>route.abort());
  await failedPage.goto('http://127.0.0.1:5200/?soldier=blender&nolock=1');
  const fallback=await failedPage.evaluate(async()=>{
    const THREE=await import('/node_modules/three/build/three.module.js');
    const {Rig}=await import('/src/player/rig.js');
    const scene=new THREE.Scene(), rig=new Rig(scene,'red');
    const loaded=await rig.visualReady;
    let meshes=0;rig.root.traverse(o=>{if(o.isMesh)meshes++;});
    rig.dispose(scene);return !loaded&&!rig.blenderSoldier&&meshes>0;
  });
  report.failedLoadKeepsOriginal=fallback;
  console.log(JSON.stringify({ ...report, errors },null,2));
  if (!report.hasModel || !fallback || !report.protectionRestored || !report.hiddenHead || !report.restoredHead ||
      report.maxOrigin>1e-8 || report.maxDirection>1e-8 || errors.length) process.exitCode=1;
} finally { await browser.close(); }
