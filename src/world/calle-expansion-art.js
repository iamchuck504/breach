import * as THREE from 'three';
import { expansionBoxes, SIDE_PROPS, CALLE_3 } from './calle-expansion.js';
import { clipFacadeAbove } from './clip-facade.js';
import { cloneUrbanAsset } from './urban-assets.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { polishCalleProp } from './calle-prop-polish.js';

// Visual extension only; collision comes from the shared server/client specs.
export function decorateCalleExpansion(world, buildings) {
  const root = new THREE.Group(); root.name = 'calle2-service-districts';
  world.mapGroup.add(root);
  const mat = (color, extra={}) => new THREE.MeshStandardMaterial({color,roughness:.85,...extra});
  const brick = mat(0x938579,{map:world._tex('urbanBrickDark',3,2)});
  const concrete = mat(0x666e70,{map:world._tex('concreteTop',3,6)});
  const metal = mat(0x343e43,{metalness:.5,roughness:.62});
  const green = mat(0x304b46), red = mat(0x704037), yellow = mat(0xc5974e);
  const black = mat(0x141c21), lamp = new THREE.MeshBasicMaterial({color:0xffcb88});
  const cube = (name,x,y,z,w,h,d,material=metal) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
    mesh.name=name;mesh.position.set(x,y,z);mesh.castShadow=mesh.receiveShadow=true;
    root.add(mesh);return mesh;
  };
  const floor = (name,x,z,w,d,material,y=.026) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w,d),material);
    mesh.name=name;mesh.rotation.x=-Math.PI/2;mesh.position.set(x,y,z);
    mesh.receiveShadow=true;root.add(mesh);
  };
  for(const side of [-1,1]) {
    floor(side<0?'service-alley-floor':'workshop-floor',side*25.25,0,7.5,40.4,concrete,.016);
    for(const z of [-18,18])floor('open-street-passage',side*18.80,z,5.4,4.4,concrete,.016);
    // v3: patio de manzana y patio trasero del spawn
    floor(side<0?'parking-yard-floor':'workshop-yard-floor',side*(29.8+CALLE_3.yardX)/2,0,CALLE_3.yardX-29.8,40.4,concrete,.016);
    floor('back-lot-floor',side*25.275,side*31.5,7.45,21,concrete,.016);
  }
  // Visible walls and solid outer corners exactly match their collision boxes.
  for(const b of expansionBoxes()) {
    if(b.expansionKind==='wall' || (b.expansionKind==='building'&&Math.abs(b.x)>22)) {
      // End walls own the corners; don't overlap their coping with the long wall.
      const depth=b.expansionKind==='wall'&&b.d===42?40.4:b.d;
      cube('district-boundary',b.x,(b.h-.16)/2,b.z,b.w,b.h-.16,depth,brick);
      // Coping is contained within the physical top rather than floating above.
      cube('wall-coping',b.x,b.h-.08,b.z,b.w,.16,depth,concrete);
    }
  }
  // Existing facade modules continue behind the side routes, outside play.
  const facadeInstances=new Map();
  // Identical local clipping planes must reuse geometry or every repeated
  // building becomes its own draw batch. Cache lives only for this map build.
  const clippedFacades=new Map();
  for(const side of [-1,1])for(const z of [-30,-18,-6,6,18,30]) {
    const source=buildings.find(b=>b.userData.streetBuilding.side===side);
    // Put the complete first upper sill above the 4.4m service wall.
    // v3: tras el patio de manzana quedan más lejos; en las esquinas, donde siempre.
    const clone=source.clone(true);clone.position.set(side*(Math.abs(z)<21?CALLE_3.yardX+3.54:31.74),.95,z);
    clone.name='calle2-outer-city-building';clone.userData={streetContinuation:true};
    root.add(clone);
    clone.updateWorldMatrix(true,true);
    // Keep upper architecture, not unrelated storefronts in the repair yard.
    // The physical brick wall supplies the ground floor.
    clone.traverse(part=>{
      if(!part.isMesh)return;
      const bounds=new THREE.Box3().setFromObject(part);
      // Masonry closes the seam. Other batches must also discard the last
      // storefront sign/awning fragments below the complete upper windows.
      const cut=part.name==='Existing_envelope'||part.name.startsWith('District_Brick')?4.4:4.55;
      if(bounds.max.y<=cut){part.visible=false;return;}
      // Trim crossing wall panels as well as removing entire storefronts.
      // Otherwise their lower halves overlap the new district walls.
      if(bounds.min.y<cut){
        const e=part.matrixWorld.elements;
        const clipKey=[part.geometry.uuid,e[1],e[5],e[9],e[13]-cut].join(':');
        if(!clippedFacades.has(clipKey))clippedFacades.set(clipKey,clipFacadeAbove(part.geometry,part.matrixWorld,cut));
        part.geometry=clippedFacades.get(clipKey);
      }
      const materials=Array.isArray(part.material)?part.material:[part.material];
      // Two-building chunks retain useful frustum culling along the alley.
      // One avenue-wide batch saves calls but submits too many hidden triangles.
      const chunk=bounds.min.y<cut?Math.floor((z+30)/24):'shared';
      const key=part.geometry.uuid+materials.map(m=>m.uuid).join(':')+':'+chunk;
      if(!facadeInstances.has(key))facadeInstances.set(key,{geometry:part.geometry,material:part.material,matrices:[]});
      facadeInstances.get(key).matrices.push(part.matrixWorld.clone());part.visible=false;
    });
  }
  for(const {geometry,material,matrices} of facadeInstances.values()){
    const mesh=new THREE.InstancedMesh(geometry,material,matrices.length);
    matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.instanceMatrix.needsUpdate=true;
    mesh.name='calle2-instanced-upper-facades';mesh.castShadow=mesh.receiveShadow=true;root.add(mesh);
  }
  // Readable directions at all four real openings, at human-scale sight height.
  for(const side of [-1,1])for(const z of [-18,18]) {
    world._addMapSign(side<0?'SERVICE ALLEY':'MOTOR WORKS',side*16.0,3.05,z,
      side<0?Math.PI/2:-Math.PI/2,{w:3.1,h:.56,parent:root,
        style:side<0?'transit':'industrial',subtitle:side<0?'LOADING ACCESS':'REPAIR / SERVICE'});
    // Small lintel above a 4.4m-wide opening: posts are the building corners.
    cube('passage-lintel',side*18.85,3.46,z,5.4,.18,4.4,metal);
    for(const end of [-1,1]) {
      const x=side*18.85;
      cube('passage-edge-marking',x,.03,z+end*1.92,5.4,.025,.10,yellow);
    }
    // sin luz propia: la lámpara brilla y deja su charco de luz (optimizeCalle2)
    cube('passage-lamp',side*19.0,3.30,z,.7,.08,.24,lamp);
  }
  for(const p of SIDE_PROPS) {
    const detailedBin=p.kind==='dumpster'?cloneUrbanAsset('prop-dumpster'):null;
    if(detailedBin){
      const bounds=new THREE.Box3().setFromObject(detailedBin),size=bounds.getSize(new THREE.Vector3());
      detailedBin.scale.set(p.w/size.x,p.h/size.y,p.d/size.z);
      detailedBin.position.set(p.x,-bounds.min.y*detailedBin.scale.y,p.z);
      detailedBin.name='blender-service-dumpster';root.add(detailedBin);
      detailedBin.traverse(o=>{if(o.isMesh)o.castShadow=o.receiveShadow=true;});
      floor('loading-pad',p.x,p.z,p.w+.35,p.d+.35,mat(0x73603f));
      continue;
    }
    if(p.kind==='pallets'){
      // Palés apilados con cajas: tres niveles de listones y carga encima.
      const wood=mat(0x7d6243),box=mat(0x8b7a5c),wrap=mat(0x9aa7ad,{roughness:.35});
      for(let i=0;i<3;i++){
        const y=i*.62;
        cube('pallet-deck',p.x,y+.07,p.z,p.w,.14,p.d,wood);
        cube('pallet-load',p.x,y+.14+.24,p.z,p.w-.12,.48,p.d-.12,i===1?wrap:box);
      }
      cube('pallet-cap',p.x,p.h-.02,p.z,p.w-.12,.04,p.d-.12,box);
      for(const dz of [-p.d*.28,p.d*.28])cube('pallet-strap',p.x,p.h/2,p.z+dz,p.w-.10,p.h-.1,.03,black);
      floor('loading-pad',p.x,p.z,p.w+.35,p.d+.35,mat(0x73603f));
      continue;
    }
    if(p.kind==='toolchest'){
      // Armario de herramientas de taller: cuerpo rojo con cajones y remate.
      cube('toolchest',p.x,(p.h-.06)/2,p.z,p.w,p.h-.06,p.d,red);
      cube('toolchest top',p.x,p.h-.03,p.z,p.w+.04,.06,p.d+.04,metal);
      const faceX=p.x+Math.sign(p.x)*(p.w/2+.006);
      for(let i=0;i<6;i++){
        cube('tool-drawer',faceX,.22+i*.27,p.z,.014,.22,p.d-.16,metal);
        cube('handle',faceX+Math.sign(p.x)*.02,.22+i*.27,p.z,.03,.03,p.d*.5,black);
      }
      floor('loading-pad',p.x,p.z,p.w+.35,p.d+.35,mat(0x73603f));
      continue;
    }
    const bodyMat=p.kind==='dumpster'?green:red;
    cube(p.kind,p.x,(p.h-.05)/2,p.z,p.w,p.h-.05,p.d,bodyMat);
    cube(p.kind+' top',p.x,p.h-.025,p.z,p.w,.05,p.d,metal);
    const faceX=p.x-Math.sign(p.x)*(p.w/2+.005);
    for(const dz of [-p.d*.3,0,p.d*.3]) {
      cube(p.kind==='dumpster'?'bin-panel-rib':'tool-drawer',faceX,.56,p.z+dz,.016,.73,p.d*.25,metal);
      cube('handle',faceX-Math.sign(p.x)*.022,.8,p.z+dz,.035,.035,.28,black);
    }
    // Ground markings stay flat and leave the center lane clear.
    floor('loading-pad',p.x,p.z,p.w+.35,p.d+.35,mat(0x73603f));
    if(p.kind==='dumpster'){
      // Split hinged lids and catches identify the bin without enlarging it.
      cube('bin-lid-joint',p.x,p.h+.004,p.z,.022,.008,p.d-.08,black);
      for(const dz of [-p.d*.4,p.d*.4])cube('bin-lid-hinge',p.x,p.h+.025,p.z+dz,.20,.04,.07,metal);
    }else{
      cube('bench-work-mat',p.x,p.h+.008,p.z,p.w*.7,.016,p.d*.6,black);
      cube('bench-spanner',p.x+.25,p.h+.025,p.z,.32,.018,.055,concrete);
      cube('bench-tool-handle',p.x-.28,p.h+.035,p.z-.18,.24,.035,.06,yellow);
    }
  }
  // Rear service doors are mounted on solid building walls, not false routes.
  for(const z of [-10,10]) {
    cube('service-door-frame',-21.58,1.23,z,.06,2.46,1.32,metal);
    cube('closed-service-door',-21.62,1.18,z,.035,2.30,1.16,green);
    cube('door-push-bar',-21.65,1.04,z,.04,.045,.84,concrete);
    world._addMapSign('DELIVERIES',-21.64,2.85,z,-Math.PI/2,
      {w:1.6,h:.30,parent:root,style:'transit',subtitle:'KEEP CLEAR'});
  }
  // Repair bay: lift uprights sit flush against the inner wall, not in the lane.
  const liftZ=12.2;
  for(const s of [1,-1]){
    for(const x of [21.75,24.3]) {
      cube('vehicle-lift-upright',s*x,1.45,s*liftZ,.30,2.9,.30,yellow);
      cube('lift-guide',s*x,1.55,s*(liftZ-.17),.10,2.5,.035,metal);
    }
    cube('lift-overhead-rail',s*23.025,2.85,s*liftZ,2.85,.10,.3,yellow);
  }
  // autos: el del callejón y los de cada patio, con su pareja girada 180°
  const carColors=[0x58646c,0x655647,0x4d5a48,0x6b5d55];
  [[-22.9,-12.2],...CALLE_3.cars].forEach(([x,z],i)=>{
    world._addStreetVehicle(x,z,0,carColors[i%4],1);
    world._addStreetVehicle(-x,-z,0,carColors[(i+1)%4],1);
  });
  world._addMapSign('MOTOR WORKS',CALLE_3.yardX-.07,2.9,-12.5,-Math.PI/2,
    {w:4,h:.8,parent:root,style:'industrial',subtitle:'ALIGNMENT / REPAIRS'});
  world._addMapSign('MOTOR WORKS',-(CALLE_3.yardX-.07),2.9,12.5,Math.PI/2,
    {w:4,h:.8,parent:root,style:'industrial',subtitle:'ALIGNMENT / REPAIRS'});
  // A coherent workshop wall treatment, not another row of shopfronts.
  const paint=mat(0xa5a8a1),blue=mat(0x3d5964);
  for(const x of [21.57,28.97])for(const z of [-13,13]){
    cube('workshop-painted-dado',x,.78,z,.015,1.55,x<22?5.6:7.8,paint);
    cube('workshop-service-stripe',x,1.5,z,.025,.16,x<22?5.6:7.8,blue);
  }
  // v3 — TALLER bajo marquesina y ANDÉN de carga
  const canopy=CALLE_3.canopy,canopyMat=mat(0x39464d,{metalness:.55,roughness:.5});
  for(const s of [1,-1]){
    for(const [x,z] of canopy.posts)cube('workshop-canopy-post',s*x,canopy.minY/2,s*z,.5,canopy.minY,.5,yellow);
    cube('workshop-canopy-roof',s*canopy.x,(canopy.minY+canopy.h)/2,s*canopy.z,canopy.w,canopy.h-canopy.minY,canopy.d,canopyMat);
    cube('workshop-canopy-fascia',s*(canopy.x-canopy.w/2-.01),canopy.minY+.11,s*canopy.z,.02,.2,canopy.d,yellow).castShadow=false;
    for(const dz of [-2.4,2.4])cube('workshop-canopy-lamp',s*canopy.x,canopy.minY-.04,s*(canopy.z+dz),3.2,.06,.22,lamp).castShadow=false;
    floor('workshop-bay-line',s*canopy.x,s*(canopy.z-4.4),canopy.w-.8,.1,yellow);
    floor('workshop-bay-line',s*canopy.x,s*(canopy.z+4.4),canopy.w-.8,.1,yellow);
  }
  for(const s of [1,-1]){
    const d=CALLE_3.dock,x=s*d.x,z=s*d.z;
    cube('loading-dock-slab',x,1.1/2,z,d.w,1.1,d.d,concrete);
    cube('loading-dock-edge',x-s*Math.sign(d.x)*(d.w/2-.05),1.105,z,.1,.012,d.d,yellow).castShadow=false;
    for(const dz of [-d.d/2+.6,0,d.d/2-.6])cube('loading-dock-bumper',x-s*Math.sign(d.x)*(d.w/2+.04),.72,z+dz,.08,.5,.28,black);
    floor('parking-bay-line',s*-34.3,s*-12.6,.1,5.4,yellow);
    floor('parking-bay-line',s*-30.2,s*-16.4,.1,5.4,yellow);
  }
  for(const z of [-12,12]){
    cube('tool-wall-board',28.93,1.95,z,.045,.8,2.5,metal);
    for(let i=0;i<6;i++)cube('hanging-tool',28.90,1.96,z-.9+i*.36,.025,.35,.05,concrete);
  }
  for(const z of [-12,12]) {
    // Wall-mounted practical lamps: no detached halos and no shadow lights.
    for(const side of [-1,1]) {
      cube('wall-light-housing',side*28.94,3.3,z,.12,.22,.7,metal);
      cube('wall-light-lens',side*28.86,3.25,z,.03,.12,.5,lamp);
    }
  }
  // UNA luz real por distrito (antes diez): cada luz extra se evalúa en cada
  // píxel iluminado de todo el mapa. Lámparas, marquesina y apliques dejan
  // charcos de luz pintados (optimizeCalle2).
  for(const side of [-1,1]) {
    const light=new THREE.PointLight(side<0?0xffc888:0xb8d8ee,14,26,1.7);
    light.name='calle2-district-light';light.position.set(side*26.5,4.4,0);root.add(light);
  }
  // Narrow awnings leave this repair courtyard open to the sky and readable
  // from above; no inaccessible playable roof or invisible floor-to-roof box.
  for(const z of [-13,13])cube('workshop-canopy',28.25,3.65,z,1.5,.12,7,metal);
  for(const z of [-14,14]) {
    floor('workshop-bay-line',25.15,z,5.4,.1,yellow);
    floor('alley-loading-line',-25.15,z,5.4,.1,yellow);
  }
  // v3: el extremo cerrado de cada callejón es ahora el opuesto al patio trasero
  world._addMapSign('NO THROUGH TRAFFIC',-25,2.2,20.16,Math.PI,
    {w:2.7,h:.5,parent:root,style:'industrial',subtitle:'SERVICE ACCESS ONLY'});
  world._addMapSign('NO EXIT',25,2.2,-20.16,0,
    {w:2.7,h:.5,parent:root,style:'industrial',subtitle:'USE SIDE PASSAGES'});

  // Wall details only: no new obstacles, blinking lights or particle spam.
  for(const side of [-1,1])for(const z of [-11.6,11.6]){
    const x=side*21.62;
    cube('service-vent-frame',x,3.0,z,.10,.55,1.15,metal);
    for(let i=0;i<5;i++)cube('service-vent-louver',x+side*.06,2.80+i*.10,z,.035,.035,1.0,black);
    cube('wall-conduit',x,2.0,z+1.1,.055,3.7,.055,metal);
    world._addMapSign(side<0?'DELIVERY BAY':'SERVICE BAY',x+side*.07,2.0,z,
      side<0?-Math.PI/2:Math.PI/2,{w:1.0,h:.32,parent:root,style:'industrial',
        subtitle:z<0?'01':'02'});
  }

  // A single incident ties together the two ends: closure notices and tape
  // attached to the existing closed gates, never stretched across a route.
  const tapeCanvas=document.createElement('canvas');tapeCanvas.width=512;tapeCanvas.height=64;
  const tapeInk=tapeCanvas.getContext('2d');tapeInk.fillStyle='#bfa357';tapeInk.fillRect(0,0,512,64);
  tapeInk.fillStyle='#20262b';tapeInk.font='bold 27px sans-serif';
  tapeInk.fillText('POLICE — DO NOT CROSS',30,42);
  const tapeTexture=new THREE.CanvasTexture(tapeCanvas);tapeTexture.colorSpace=THREE.SRGBColorSpace;
  tapeTexture.anisotropy=4;
  const tapeMaterial=mat(0xffffff,{map:tapeTexture});
  for(const dir of [-1,1]){
    for(const x of [-10.8,10.8]){
      cube('police-closure-tape',x,1.55,dir*41.99,3.1,.10,.025,tapeMaterial);
      world._addMapSign('POLICE CORDON',x,2.12,dir*41.98,dir>0?Math.PI:0,
        {w:2.5,h:.48,parent:root,style:'institutional',subtitle:'DISTRICT CLOSED / EVACUATION'});
    }
    // Two short paired braking traces approaching each bus; no giant decals.
    for(const x of [-.75,.75])floor('braking-trace',x,dir*31.1,.12,1.7,mat(0x20282b),.023);
  }
  for(const b of buildings){
    if(b.userData.blenderFacade) continue; // Signs/door details are authored into each facade.
    const {side,z,span,variant}=b.userData.streetBuilding;
    const rot=side<0?Math.PI/2:-Math.PI/2;
    world._addMapSign(String(100+Math.round(z+42)+(side>0?1:0)),side*15.91,2.12,z+span*.19,rot,
      {w:.36,h:.20,parent:root,style:'utility',bg:'#323737',fg:'#ddd4b8',border:'#77756a',subtitle:''});
    if(variant===1||variant===4){
      world._addMapSign('EVACUATION',side*15.91,1.65,z+span*.19,rot,
        {w:.55,h:.55,parent:root,style:'institutional',bg:'#b9aa85',fg:'#252d31',border:'#8b453a',subtitle:'FOLLOW POLICE INSTRUCTIONS'});
    }
    if(b.userData.streetBuilding.signStyle==='cafe'){
      // Menu belongs to this cafe, above door traffic and beside its sign.
      world._addMapSign('ESPRESSO',side*15.86,2.65,z+span*.19,rot,
        {w:.60,h:.38,parent:root,style:'cafe',bg:'#3d3026',fg:'#e5d4af',border:'#967851',subtitle:'COFFEE / TEA'});
    }
  }
  for(const side of [-1,1]){
    // A slim abandoned case tucked against the facade, outside walking space.
    cube('evacuation-case',side*16.0,.27,side*32,.16,.46,.58,metal);
    cube('case-handle',side*15.99,.535,side*32,.045,.045,.18,black);
    for(const dz of [-.22,.22])cube('case-strap',side*15.91,.27,side*32+dz,.012,.40,.025,black);
  }
  // Flush electrical cabinets: they stay inside the wall-side body clearance.
  for(const side of [-1,1])for(const z of [-13,13]){
    cube('service-electrical-cabinet',side*21.60,1.45,z,.08,.65,.46,metal);
    cube('cabinet-warning',side*21.648,1.5,z,.008,.12,.12,yellow);
  }
  // Stored workshop tyres are hung on the wall, not loose trip hazards.
  for(const z of [-10.6,10.6]){
    const tyre=new THREE.Mesh(new THREE.TorusGeometry(.26,.095,6,12),black);
    tyre.name='stored-workshop-tyre';tyre.rotation.y=Math.PI/2;
    tyre.position.set(28.87,2.45,z);root.add(tyre);
    cube('tyre-wall-hook',28.88,2.75,z,.17,.035,.05,metal);
  }
  // Small pavement wear patches away from painted lines. Transparent edges,
  // depth-write off and a dedicated height prevent coplanar shimmer.
  const stainCanvas=document.createElement('canvas');stainCanvas.width=128;stainCanvas.height=128;
  const ink=stainCanvas.getContext('2d'),gradient=ink.createRadialGradient(64,64,10,64,64,63);
  gradient.addColorStop(0,'rgba(15,22,24,.50)');gradient.addColorStop(1,'rgba(15,22,24,0)');
  ink.fillStyle=gradient;ink.fillRect(0,0,128,128);
  const stainTex=new THREE.CanvasTexture(stainCanvas);stainTex.colorSpace=THREE.SRGBColorSpace;
  const stain=new THREE.MeshStandardMaterial({map:stainTex,transparent:true,depthWrite:false,roughness:.3,metalness:.12});
  for(const side of [-1,1]){
    floor('vehicle-oil-stain',side*6.5,side*1.5,2.1,3.2,stain,.027);
    floor('localized-damp-pavement',side*26.5,side*4,1.5,2.5,stain,.027);
    for(let i=0;i<3;i++)floor('service-paper-litter',side*(28.45-i*.17),side*(15+i*.30),.15,.21,mat(i%2?0x7b817a:0xa39779),.031+i*.001);
  }
}

// ---------------------------------------------------------------------------
// RENDIMIENTO DE CALLE 2. El mapa se arma con cientos de piezas sueltas
// (autos de 47 mallas, mobiliario, cables, arcenes): cada una era una llamada
// de dibujo en el pase principal y otra en el de sombras. Aquí, ya construido
// todo, se FUSIONA por material dentro de cada grupo editable: misma
// geometría y mismos materiales (la silueta que audita el raycast no cambia),
// pero una llamada por material en vez de una por pieza.

// Mallas que los tests o el código buscan por nombre/posición: no se fusionan.
const KEEP = new Set(['map-floor', 'contact-shadows', 'street-building-seam', 'calle2-instanced-upper-facades',
  'service-alley-floor', 'workshop-floor', 'procedural-prop-fallback', 'streetlamp-lit-lens',
  // fachadas de Blender: los tests miden puerta, rótulo, envolvente y cubierta
  'Existing_envelope', 'Roof_cap', 'Door_leaf', 'Sign_enamel_inset', 'Sign_brass_frame', 'Shop_title', 'Shop_subtitle']);
const ATTRS = ['position', 'normal', 'uv', 'color'];
const own = (m, k) => Object.prototype.hasOwnProperty.call(m, k);
const hex = (c) => (c ? c.getHexString() : '-');

// Materiales gemelos (el mismo color/rugosidad creado veinte veces por los
// helpers) pasan a ser uno: menos programas por cambiar y más fusión posible.
function materialKey(m) {
  if (m.userData.urbanAssetShared || own(m, 'onBeforeCompile') || m.isShaderMaterial) return null;
  return [m.type, m.name, hex(m.color), hex(m.emissive), m.emissiveIntensity, m.roughness, m.metalness,
    m.map?.uuid, m.emissiveMap?.uuid, m.bumpMap?.uuid, m.bumpScale, m.normalMap?.uuid, m.alphaMap?.uuid,
    m.transparent, m.opacity, m.side, m.depthWrite, m.depthTest, m.toneMapped, m.vertexColors, m.flatShading,
    m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.alphaTest, m.blending, m.fog, m.visible].join('|');
}

function dedupeMaterials(root) {
  const canon = new Map(), dropped = new Set();
  const swap = (m) => {
    const k = materialKey(m);
    if (k == null) return m;
    const c = canon.get(k);
    if (!c) { canon.set(k, m); return m; }
    if (c !== m) dropped.add(m);
    return c;
  };
  root.traverse((o) => {
    if (!o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  for (const m of dropped) m.dispose();
}

// Geometría propia, en coordenadas de `target`, con atributos float simples
// (los GLB traen uv cuantizadas o intercaladas que no se pueden unir tal cual).
function flatGeometry(src, matrix, keepColor) {
  const g = new THREE.BufferGeometry();
  const n = src.attributes.position.count;
  for (const name of ATTRS) {
    const a = src.attributes[name];
    if (!a || (name === 'color' && !keepColor)) continue;
    const out = new Float32Array(n * a.itemSize);
    for (let i = 0; i < n; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(Array.from(src.index.array));
  else g.setIndex(Array.from({ length: n }, (_, i) => i));
  g.applyMatrix4(matrix);
  return g;
}

const TMP_BOX = new THREE.Box3(), TMP_SIZE = new THREE.Vector3();
// HORNEADO DE COLOR. Un auto trae diez materiales lisos que solo difieren en
// el color: con el color en el vértice comparten UNO por clase de acabado
// (rugosidad/metal redondeados), así que la pieza entera cuesta dos o tres
// llamadas. `tintOf(malla)` dice qué tramo de vértices venía de qué
// material para que el look lo pueda repintar (retint).
const bakedMaterials = new Map();
// tramos de color de cada malla horneada: fuera de userData (el editor clona
// grupos y three serializa userData, que convertiría materiales en números)
const TINTS = new WeakMap();
export const tintOf = (mesh) => TINTS.get(mesh) ?? null;
function bakeClass(m) {
  if (own(m, 'onBeforeCompile') || m.userData.lookPatched || m.vertexColors || m.transparent || !m.visible) return null;
  if (m.map || m.alphaMap || m.emissiveMap || m.bumpMap || m.normalMap || m.roughnessMap || m.metalnessMap || m.aoMap || m.lightMap) return null;
  if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) * m.emissiveIntensity > 0.02) return null;
  if (m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) return `std:${Math.round(m.roughness * 4) / 4}:${Math.round(m.metalness * 2) / 2}:${m.side}:${m.flatShading}`;
  if (m.isMeshLambertMaterial) return `lam:${m.side}:${m.flatShading}`;
  if (m.isMeshBasicMaterial) return `bas:${m.side}:${m.toneMapped}`;
  return null;
}
function bakedMaterial(cls) {
  if (bakedMaterials.has(cls)) return bakedMaterials.get(cls);
  const [kind, a, b, c, d] = cls.split(':');
  const side = Number(kind === 'std' ? c : a);
  const m = kind === 'std' ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: Number(a), metalness: Number(b), side, flatShading: d === 'true' })
    : kind === 'lam' ? new THREE.MeshLambertMaterial({ vertexColors: true, side, flatShading: b === 'true' })
      : new THREE.MeshBasicMaterial({ vertexColors: true, side, toneMapped: b !== 'false' });
  m.name = `calle2-baked:${cls}`;
  m.userData.calleBaked = true;
  bakedMaterials.set(cls, m);
  return m;
}

// Recorre `target` y fusiona sus mallas por material (o por clase de acabado,
// si el material es liso). `stop(o)` corta una rama (carteles, detalles que
// viven aparte, piezas con nombre propio).
function mergeTree(target, stop, { name = 'calle2-batch', exact = false } = {}) {
  target.updateWorldMatrix(true, true);
  const inv = target.matrixWorld.clone().invert();
  const buckets = new Map();
  const walk = (o) => {
    for (const c of o.children) {
      if (c.visible === false || stop(c)) continue;
      if (c.isMesh && !c.isInstancedMesh && !c.isSkinnedMesh && !Array.isArray(c.material) && !KEEP.has(c.name)
        && !c.morphTargetInfluences && !c.children.length && c.matrixWorld.determinant() > 0) {
        // la sombra de un tornillo o de una manija no se ve: solo proyectan
        // las piezas con cuerpo
        let cast = c.castShadow;
        if (cast) {
          if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
          TMP_BOX.copy(c.geometry.boundingBox).applyMatrix4(c.matrixWorld).getSize(TMP_SIZE);
          cast = Math.max(TMP_SIZE.x, TMP_SIZE.y, TMP_SIZE.z) >= 0.45;
        }
        const m = c.material, cls = bakeClass(m);
        const attrs = cls ? 'baked' : ATTRS.filter((a) => c.geometry.attributes[a] && (a !== 'color' || m.vertexColors)).join(',');
        // exact: las piezas se agrupan por su marco (padre + matriz local) y
        // el lote conserva los vértices bit a bit (ver `frame` más abajo). Lo
        // piden las fachadas: la auditoría de hitboxes tira rayos justo por el
        // borde de sus alféizares y un redondeo distinto cambiaba el veredicto.
        const frameKey = exact ? `${c.parent.uuid}:${c.matrix.elements.join(',')}` : '';
        const key = [cls ?? m.uuid, cast, c.receiveShadow, c.renderOrder, !!c.userData.noBulletDecal, c.frustumCulled, attrs, frameKey].join('|');
        if (!buckets.has(key)) buckets.set(key, { m: cls ? bakedMaterial(cls) : m, cls, cast, recv: c.receiveShadow, order: c.renderOrder, noDecal: !!c.userData.noBulletDecal, cull: c.frustumCulled, list: [] });
        buckets.get(key).list.push(c);
      }
      if (!c.isMesh || c.children.length) walk(c);
    }
  };
  walk(target);
  const rel = new THREE.Matrix4(), origin = new THREE.Vector3();
  for (const b of buckets.values()) {
    if (b.list.length < 2 && !b.cls) { if (!b.cast) b.list[0].castShadow = false; continue; }
    // Si todas las piezas se llaman igual (las marcas de carga, p. ej.), el
    // lote conserva el nombre y la posición de la primera: hay código que
    // las busca así.
    const same = b.list.every((o) => o.name && o.name === b.list[0].name);
    // Piezas hermanas con la MISMA transformación (las de un GLB): el lote
    // queda en su sitio, con sus vértices intactos bit a bit. Así un rayo
    // que roza un borde da exactamente lo mismo que antes de fusionar.
    const first = b.list[0];
    const frame = b.list.every((o) => o.parent === first.parent && o.matrix.equals(first.matrix));
    origin.set(0, 0, 0);
    if (same && !frame) origin.setFromMatrixPosition(first.matrixWorld).applyMatrix4(inv);
    const ranges = [];
    let start = 0;
    const geos = b.list.map((o) => {
      if (frame) rel.identity();
      else rel.multiplyMatrices(inv, o.matrixWorld).premultiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
      const g = flatGeometry(o.geometry, rel, !b.cls && b.m.vertexColors);
      if (b.cls) {
        g.deleteAttribute('uv');
        if (!g.attributes.normal) g.computeVertexNormals();
        const n = g.attributes.position.count;
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        ranges.push({ material: o.material, start, count: n, shade: 1, glow: false });
        start += n;
      }
      return g;
    });
    const geometry = geos.length > 1 ? mergeGeometries(geos) : geos[0];
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!geometry) continue; // atributos incompatibles: se quedan como estaban
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, b.m);
    mesh.name = same ? first.name : name;
    if (frame) { mesh.position.copy(first.position); mesh.quaternion.copy(first.quaternion); mesh.scale.copy(first.scale); }
    else mesh.position.copy(origin);
    mesh.castShadow = b.cast; mesh.receiveShadow = b.recv;
    mesh.renderOrder = b.order; mesh.frustumCulled = b.cull;
    if (b.noDecal) mesh.userData.noBulletDecal = true;
    if (b.cls) { TINTS.set(mesh, ranges); retint(mesh); }
    (frame ? first.parent : target).add(mesh);
    for (const o of b.list) {
      o.parent.remove(o);
      if (!o.geometry.userData.urbanAssetShared) o.geometry.dispose();
    }
  }
}

const isSign = (o) => o.name.startsWith('map-sign') || o.name.startsWith('prop-label');

// Llamar al final de _decorCalle(true), con todo el mapa ya construido.
export function optimizeCalle2(world) {
  const map = world.mapGroup;
  bakedMaterials.clear(); // por mapa: setLayout los libera y el look los parchea
  dedupeMaterials(map);
  for (const top of [...map.children]) {
    const ud = top.userData;
    if (top.isMesh || top.isLight) continue;
    if (ud.blenderFacade || ud.streetBuilding) { facadeShadows(top); mergeTree(top, isSign, { exact: true }); continue; }
    if (ud.streetContinuation) continue;
    if (top.name === 'calle2-service-districts') {
      for (const c of top.children) {
        if (c.name === 'calle2-instanced-upper-facades') c.castShadow = false; // en lo alto, tras el muro
      }
      mergeTree(top, (o) => isSign(o) || o.userData.streetContinuation || (!o.isMesh && o.parent === top && o.userData.callePolish));
      continue;
    }
    // Un prop modelado en Blender: el test de carteles mira su primer hijo
    // (el modelo), así que se fusiona DENTRO del modelo.
    if (ud.blenderProp) {
      for (const c of top.children) if (c.name !== 'procedural-prop-fallback' && !isSign(c)) mergeTree(c, isSign);
      continue;
    }
    // Detalles del pulido: hijos sin transformación, se fusionan en su sitio.
    for (const c of top.children) if (c.name.startsWith('calle2-prop-polish:')) mergeTree(c, isSign);
    mergeTree(top, (o) => isSign(o) || o.name.startsWith('calle2-prop-polish:'));
  }
  // Piezas sueltas sin nombre (cables, bordillos, muros de cierre, aceras).
  mergeTree(map, (o) => !o.isMesh || !!o.name);
  // carteles: placas pegadas a muros o vehículos, su sombra no se distingue
  map.traverse((o) => { if (o.isMesh && isSign(o.parent ?? o)) o.castShadow = false; });
  addLightPools(world);
  bakedMaterials.clear(); // nada del mapa queda colgado del módulo
}

// LUZ SIN LUCES. Las 16 farolas y las lámparas de los distritos ya no son
// luces reales: dejan un charco de luz aditivo en el suelo (una sola llamada
// para todos). Cuatro luces de relleno cálidas sobre la avenida y una por
// distrito (calle2-district-light) siguen iluminando soldados y coberturas.
export const AVENUE_FILL = Object.freeze([[-7.5, -27], [7.5, 27], [7.5, -9], [-7.5, 9]]);
// Cabezas de farola de la avenida, desde los DATOS del mapa (postes en
// ±11.72 cada 10 m; la lente queda 0.635 m hacia la calzada y a 6.045 m). Un
// clon del editor recrea las farolas después de construir el mapa: leerlas
// de la escena dejaba el clon sin charcos de luz.
export const CALLE_LAMP_HEADS = Object.freeze([-35, -25, -15, -5, 5, 15, 25, 35]
  .flatMap((z) => [-1, 1].map((side) => Object.freeze({ x: side * 11.085, y: 6.045, z }))));
function addLightPools(world) {
  const pools = []; // [x, z, radio, alargamiento en x]
  for (const l of CALLE_LAMP_HEADS) pools.push([l.x, l.z, 4.4, 1.25]);
  for (const side of [-1, 1]) {
    for (const z of [-18, 18]) pools.push([side * 19.0, z, 2.6, 1]);          // pasos laterales
    for (const z of [-12, 12]) pools.push([side * 28.1, z, 2.4, 1]);          // apliques del taller
    for (const dz of [-2.4, 2.4]) pools.push([side * CALLE_3.canopy.x, side * (CALLE_3.canopy.z + dz), 2.8, 1.4]); // marquesina
  }
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,.55)');
  grad.addColorStop(0.7, 'rgba(255,255,255,.16)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, color: 0xffb867, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true,
  });
  const geo = new THREE.PlaneGeometry(2, 2); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, mat, pools.length);
  const m4 = new THREE.Matrix4();
  pools.forEach(([x, z, r, sx], i) => mesh.setMatrixAt(i, m4.makeScale(r * sx, 1, r).setPosition(x, 0.036, z)));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'calle2-light-pools'; mesh.userData.noBulletDecal = true; mesh.renderOrder = 1;
  mesh.computeBoundingSphere();
  world.mapGroup.add(mesh);
  for (const [x, z] of AVENUE_FILL) {
    const light = new THREE.PointLight(0xffcf9a, 15, 26, 1.6);
    light.name = 'calle2-avenue-fill'; light.position.set(x, 5.4, z);
    world.mapGroup.add(light);
  }
}

// Fachadas de Blender: 20+ mallas cada una, todas proyectando sombra. La
// sombra la da el volumen (envolvente + cubierta); el relieve, de noche, no.
function facadeShadows(building) {
  building.traverse((o) => {
    if (o.isMesh) o.castShadow = o.name === 'Existing_envelope' || o.name === 'Roof_cap';
  });
}

// CONTINUACIÓN de la avenida más allá de ±fz: los mismos edificios reales de
// la fila (no una versión inventada), oscurecidos con la distancia. Antes eran
// 16 clones completos con materiales clonados (~350 llamadas, ~270k
// triángulos y ~290 materiales que nunca se liberaban). El muro de cierre
// (4.4 m) tapa lo de abajo: solo se conserva lo que asoma por encima desde
// cualquier cámara del juego (ver contCut), recortado por triángulo,
// y se hornea en DOS mallas por extremo (sólido + ventanas encendidas) con el
// color de cada material y su oscurecimiento en el color por vértice.
// Altura de recorte por módulo, MEDIDA desde la cámara más alta que usa el
// juego: la órbita de presentación (main.js, updateMatchCamera) sube hasta
// 11 m y llega al extremo opuesto (84.4 m del muro). Por encima de la línea
// que pasa por el remate del muro (4.4 m) todo se ve; cuanto más lejos el
// módulo, más baja esa línea. 0.3 m de margen.
const WALL_TOP = 4.4, CAM_TOP = 11, CAM_RUN = 84.4;
const contCut = (behind) => Math.max(0, Math.min(4.3, WALL_TOP - (CAM_TOP - WALL_TOP) * behind / CAM_RUN - 0.3));
export function buildCalle2Continuation(world, buildings, { modules, step, shades }) {
  const root = new THREE.Group();
  root.name = 'street-building-continuation';
  root.userData.streetContinuation = true;
  const buckets = new Map(); // `${dir}:${glow}` -> [{ geometry, material, shade }]
  const clipCache = new Map();
  const m4 = new THREE.Matrix4(), box = new THREE.Box3();
  const add = (mesh, matrix, shade, dir, cut) => {
    const m = mesh.material;
    if (!mesh.isMesh || Array.isArray(m) || m.transparent || !m.visible) return;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    box.copy(g.boundingBox).applyMatrix4(matrix);
    if (box.max.y <= cut) return;
    let src = g;
    if (box.min.y < cut) {
      const e = matrix.elements, key = [g.uuid, e[1], e[5], e[9], e[13], cut].map((v) => (typeof v === 'number' ? v.toFixed(4) : v)).join(':');
      if (!clipCache.has(key)) clipCache.set(key, clipFacadeAbove(g, matrix, cut));
      src = clipCache.get(key);
    }
    if (!src.attributes.position.count) return;
    const glow = !!(m.isMeshBasicMaterial || (m.emissive && m.emissiveIntensity * (m.emissive.r + m.emissive.g + m.emissive.b) > 0.3));
    const k = `${dir}:${glow ? 1 : 0}`;
    if (!buckets.has(k)) buckets.set(k, []);
    // solo posición y normal: sin texturas, todas las piezas unen igual
    const geometry = flatGeometry(src, matrix, false);
    geometry.deleteAttribute('uv');
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    buckets.get(k).push({ geometry, material: m, shade, glow });
  };
  for (const dir of [-1, 1]) for (const side of [-1, 1]) {
    const sources = buildings
      .filter((b) => b.userData.streetBuilding.side === side)
      .sort((a, b) => (dir > 0 ? b.position.z - a.position.z : a.position.z - b.position.z));
    for (let depth = 0; depth < modules; depth++) {
      const source = sources[depth % sources.length];
      source.updateWorldMatrix(true, true);
      const dz = dir * (world.fz + step * (depth + 0.5)) - source.position.z;
      const shift = new THREE.Matrix4().makeTranslation(0, 0, dz);
      const cut = contCut(step * depth - 0.4);
      source.traverse((o) => { if (o.isMesh && o.visible) add(o, m4.multiplyMatrices(shift, o.matrixWorld), shades[depth], dir, cut); });
      // zócalo macizo bajo el recorte: desde una cámara libre (editor) la
      // fachada nunca queda flotando
      const env = source.getObjectByName('Existing_envelope');
      if (env && cut > 0.05) {
        const { span } = source.userData.streetBuilding;
        const plinth = new THREE.Mesh(new THREE.BoxGeometry(5.4, cut, span));
        plinth.material = env.material;
        plinth.position.set(source.position.x, cut / 2, source.position.z + dz);
        plinth.updateMatrixWorld();
        add(plinth, plinth.matrixWorld, shades[depth], dir, 0);
        plinth.geometry.dispose();
      }
    }
  }
  // farolas de la continuación: el mismo GLB (con su lente) que las del campo
  for (const dir of [-1, 1]) for (let depth = 0; depth < modules; depth++) for (const side of [-1, 1]) {
    const lamp = cloneUrbanAsset('streetlight');
    if (!lamp) continue;
    const scale = 1.21, minY = Number(lamp.userData.urbanMinY) || 0;
    lamp.position.set(side * 11.72, -minY * scale, dir * (world.fz + 3 + depth * 10));
    lamp.rotation.y = side > 0 ? Math.PI : 0; lamp.scale.setScalar(scale);
    polishCalleProp(world, lamp, 'streetlight', { illuminate: false });
    lamp.updateWorldMatrix(true, true);
    const cut = contCut(3 + depth * 10 - 0.4);
    lamp.traverse((o) => { if (o.isMesh) add(o, o.matrixWorld, Math.min(0.9, shades[depth] + 0.18), dir, cut); });
    // el pulido clona materiales y crea la lente: lo propio se libera ya
    lamp.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.userData.urbanAssetShared) o.geometry.dispose();
      if (!o.material.userData.urbanAssetShared) o.material.dispose();
    });
  }
  for (const g of clipCache.values()) g.dispose();
  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08 });
  solid.userData.calleBaked = true; // el look le añade el brillo de lo que pinta por encima de 1
  const lit = new THREE.MeshBasicMaterial({ vertexColors: true });
  for (const [k, parts] of buckets) {
    const glow = k.endsWith(':1');
    const ranges = [];
    let start = 0;
    for (const p of parts) {
      const n = p.geometry.attributes.position.count;
      p.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      ranges.push({ material: p.material, start, count: n, shade: p.shade, glow });
      start += n;
    }
    const geometry = mergeGeometries(parts.map((p) => p.geometry));
    for (const p of parts) p.geometry.dispose();
    const mesh = new THREE.Mesh(geometry, glow ? lit : solid);
    mesh.name = `street-building-continuation:${k}`;
    TINTS.set(mesh, ranges);
    retint(mesh);
    root.add(mesh);
  }
  world.mapGroup.add(root);
  return root;
}

// Color por vértice = color del material de origen × oscurecimiento. El look
// lo vuelve a llamar con su propia función de color: colorOf(material, glow)
// -> THREE.Color | null (null = el color original).
export function retint(mesh, colorOf = null) {
  const ranges = TINTS.get(mesh), col = mesh.geometry?.attributes.color, c = new THREE.Color();
  if (!ranges || !col) return;
  for (const r of ranges) {
    const m = r.material;
    if (!m?.color?.isColor) continue;
    const custom = colorOf?.(m, r.glow);
    if (custom) c.copy(custom);
    else if (r.glow) c.copy(m.isMeshBasicMaterial ? m.color : m.emissive).multiplyScalar(m.isMeshBasicMaterial ? 1 : Math.min(2, m.emissiveIntensity));
    else c.copy(m.color);
    c.multiplyScalar(r.shade);
    for (let i = r.start; i < r.start + r.count; i++) col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}
