import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {CHROME} from './lib-chrome.mjs';
const browser=await chromium.launch({executablePath:CHROME,headless:true});
try{
 const page=await browser.newPage();
 await page.goto((process.env.BASE || 'http://127.0.0.1:5200') + '/?soldier=blender&nolock=1');
 const report=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js');
  const {Rig}=await import('/src/player/rig.js');
  const {World}=await import('/src/world/world.js');
  const {Controller,PLAYER_R}=await import('/src/player/controller.js');
  const {preloadUrbanAssets}=await import('/src/world/urban-assets.js');
  const {expandedCollisionBoxes}=await import('/src/world/collision-layouts.js');
  await preloadUrbanAssets();
  const scene=new T.Scene(),world=new World(scene,'calle2');
  world.mapGroup?.updateMatrixWorld(true);
  const facadeMeshes=world._getImpactReceivers().filter(m=>/District_|Existing_envelope|shop|facade|storefront/i.test(m.name+' '+(m.parent?.name??'')));
  if(!facadeMeshes.length)throw Error('sin mallas de fachada que medir');
  const rig=new Rig(scene,'red');await rig.visualReady;
  rig.wallFn=(o,d,m)=>world.raycast(o,d,m,0); // sonda de pared, como la inyecta el juego (ganchos/rig.md)
  const faces=world.faces.filter(f=>f.standOff&&f.n.x!==0),samples=[];
  if(faces.length!==8)throw Error('Expected all eight street-facing building strips'); // v3: four per side
  for(const b of expandedCollisionBoxes('calle2'))if(!world.colliders.some(c=>
   ['minx','maxx','minz','maxz','h'].every(k=>Math.abs(c[k]-b[k])<1e-6)))throw Error('Collision parity changed');
  for(const face of faces)for(const u of [.15,.5,.85]){
   const side=-face.n.x;
   const wallZ=face.a.z+(face.b.z-face.a.z)*u;
   const start={x:face.a.x+face.n.x*1.7,z:wallZ};
   const found=world.findCover(start,{x:-face.n.x,z:0},2,PLAYER_R);
   if(!found)continue; // Street furniture can legitimately obstruct a slot.
   if(found.face!==face)throw Error('Unexpected cover face');
   // PRUEBAS (corrida 6, FPS): sin cobertura pegada. Mismas garantías con las
   // posturas FPS empujando contra la fachada: sin temblor y el soldado que ven
   // los demás (agachado, inclinado, asomado) sin cruzar el plano x=±15.69.
   const camera={yaw:Math.atan2(face.n.x,face.n.z),pitch:0,flatForward(){return{x:-Math.sin(this.yaw),z:-Math.cos(this.yaw)}},flatRight(){return{x:Math.cos(this.yaw),z:-Math.sin(this.yaw)}}};
   for(const [crouch,aim,lat] of [[true,false,0],[true,true,-1],[true,true,1],[false,true,-1],[false,true,1],[false,false,0]]){
   const player=new Controller(world,camera);player.respawn({x:found.target.x,z:found.target.z,yaw:camera.yaw});
   const input={moveVec:()=>({x:0,z:1}),aimHeld:aim,crouchHeld:crouch,crouchPressed:false,leanAxis:lat,sprintHeld:false,jumpPressed:false,meleePressed:false};
   const positions=[];
   for(let frame=0;frame<90;frame++){
    player.update(1/60,input,false);if(frame>70)positions.push(player.pos.x);
   }
   if(player.state!==(crouch?'crouch':'run')&&player.state!==(crouch?'crouch':'idle')||Math.max(...positions)-Math.min(...positions)>.001)throw Error('Jitter against facade '+JSON.stringify({state:player.state,crouch,aim,lat,spread:Math.max(...positions)-Math.min(...positions)}));
   {
    for(let frame=0;frame<90;frame++){
     player.update(1/60,input,false);
     rig.setTransform(player.pos.x,player.pos.z,player.yaw,player.y);
     rig.update(1/60,{...player.animParams(),state:player.stanceLow>.005?'crouch':player.animParams().state,coverAimExposure:1-player.stanceLow,coverLean:player.lean});
    }
    // PRUEBAS (corrida 6): se mide contra la geometría DIBUJADA, no contra un plano.
    // El ±15.69 de antes era la proyección de la cobertura en tercera persona: el
    // colisionador está a ±15.85 a propósito (calle-expansion.js) y lo dibujado tiene
    // escaparates hundidos, cristal, marcos y rótulos a distintas profundidades.
    // Cada vértice del soldado (piel aplicada) a ≤ 0.4 m de la fachada se lanza
    // hacia la calle: si una malla de fachada queda entre él y la calle, ese punto
    // está DENTRO de lo dibujado.
    rig.root.updateMatrixWorld(true);
    const V=new T.Vector3(),dir=new T.Vector3(-side,0,0),ray=new T.Raycaster(),CONTACT=0.01;
    let bodyIn=0,gunIn=0,headIn=0,deepest=0;
    rig.root.traverse(o=>{
     if(!o.isMesh)return;let gun=false,head=false;for(let p=o;p;p=p.parent){if(!p.visible)return;if(p===rig.gunMount)gun=true;if(p===rig.head)head=true;}
     const pos=o.geometry?.attributes?.position;if(!pos)return;
     const step=Math.max(1,Math.floor(pos.count/400));
     for(let i=0;i<pos.count;i+=step){
      if(o.isSkinnedMesh)o.getVertexPosition(i,V);else V.fromBufferAttribute(pos,i);
      V.applyMatrix4(o.matrixWorld);
      if(side*V.x<15.85-.4)continue;
      ray.set(V,dir);ray.near=0;ray.far=1.2;
      const hit=ray.intersectObjects(facadeMeshes,false)[0];
      // contacto ≤ 1 cm (precisión de la piel/muestreo) no cuenta; más hondo, sí
      if(hit){deepest=Math.max(deepest,hit.distance);if(hit.distance>CONTACT){if(gun)gunIn++;else if(head)headIn++;else bodyIn++;}}
     }
    });
    const clearance=-deepest;
    if(bodyIn||headIn)throw Error('body inside the drawn facade '+JSON.stringify({bodyIn,headIn,deepest:+deepest.toFixed(3),side,wallZ,lat,crouch,aim,pos:player.pos}));
    if(gunIn)throw Error('held weapon inside the drawn facade '+JSON.stringify({gunIn,deepest:+deepest.toFixed(3),side,wallZ,lat,crouch,aim,pos:player.pos}));
    samples.push({side,z:wallZ,lat,crouch,clearance});
   }
   }
  }
  return {faces:faces.length,samples:samples.length,facadeMeshes:facadeMeshes.length,minClearance:Math.min(...samples.map(s=>s.clearance))};
 });
 assert(report.samples>=36);console.log('STOREFRONT COVER OK',JSON.stringify(report));
}finally{await browser.close();}
