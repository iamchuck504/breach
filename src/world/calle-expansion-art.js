import * as THREE from 'three';
import { expansionBoxes, SIDE_PROPS } from './calle-expansion.js';

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
  for(const side of [-1,1])for(const z of [-30,-18,-6,6,18,30]) {
    const source=buildings.find(b=>b.userData.streetBuilding.side===side);
    const clone=source.clone(true);clone.position.set(side*31.74,0,z);
    clone.name='calle2-outer-city-building';clone.userData={streetContinuation:true};
    root.add(clone);
    clone.updateWorldMatrix(true,true);
    // Keep upper architecture, not unrelated storefronts in the repair yard.
    // The physical brick wall supplies the ground floor.
    clone.traverse(part=>{
      if(!part.isMesh)return;
      const bounds=new THREE.Box3().setFromObject(part);
      if(bounds.max.y<=4.5){part.visible=false;return;}
      // Trim crossing wall panels as well as removing entire storefronts.
      // Otherwise their lower halves overlap the new district walls.
      if(bounds.min.y<4.5){
        part.geometry=part.geometry.clone();
        const positions=part.geometry.attributes.position;
        const inverse=part.matrixWorld.clone().invert(),v=new THREE.Vector3();
        for(let i=0;i<positions.count;i++){
          v.fromBufferAttribute(positions,i).applyMatrix4(part.matrixWorld);
          v.y=Math.max(4.5,v.y);v.applyMatrix4(inverse);
          positions.setXYZ(i,v.x,v.y,v.z);
        }
        positions.needsUpdate=true;part.geometry.computeBoundingBox();part.geometry.computeBoundingSphere();
      }
      const materials=Array.isArray(part.material)?part.material:[part.material];
      const key=part.geometry.uuid+materials.map(m=>m.uuid).join(':');
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
    const light=new THREE.PointLight(0xffc888,3,9,2);
    light.position.set(side*19.0,2.95,z);root.add(light);
    cube('passage-lamp',side*19.0,3.30,z,.7,.08,.24,lamp);
  }
  for(const p of SIDE_PROPS) {
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
  for(const x of [21.75,24.3]) {
    cube('vehicle-lift-upright',x,1.45,0,.30,2.9,.30,yellow);
    cube('lift-guide',x,1.55,-.17,.10,2.5,.035,metal);
  }
  cube('lift-overhead-rail',23.025,2.85,0,2.85,.10,.3,yellow);
  world._addStreetVehicle(22.9,0,0,0x58646c,1);
  world._addStreetVehicle(-22.9,0,0,0x655647,1);
  world._addMapSign('MOTOR WORKS',28.93,2.9,0,-Math.PI/2,
    {w:4,h:.8,parent:root,style:'industrial',subtitle:'ALIGNMENT / REPAIRS'});
  // A coherent workshop wall treatment, not another row of shopfronts.
  const paint=mat(0xa5a8a1),blue=mat(0x3d5964);
  for(const x of [21.57,28.97]){
    cube('workshop-painted-dado',x,.78,0,.015,1.55,29,paint);
    cube('workshop-service-stripe',x,1.5,0,.025,.16,29,blue);
  }
  for(const z of [-12,12]){
    cube('tool-wall-board',28.93,1.95,z,.045,.8,2.5,metal);
    for(let i=0;i<6;i++)cube('hanging-tool',28.90,1.96,z-.9+i*.36,.025,.35,.05,concrete);
  }
  for(const z of [-12,-4,4,12]) {
    // Wall-mounted practical lamps: no detached halos and no shadow lights.
    for(const side of [-1,1]) {
      cube('wall-light-housing',side*28.94,3.3,z,.12,.22,.7,metal);
      cube('wall-light-lens',side*28.86,3.25,z,.03,.12,.5,lamp);
    }
  }
  for(const side of [-1,1])for(const z of [-10,10]) {
    const light=new THREE.PointLight(side<0?0xffc888:0xb8d8ee,5,13,2);
    light.position.set(side*26.5,3.6,z);root.add(light);
  }
  // Narrow awnings leave this repair courtyard open to the sky and readable
  // from above; no inaccessible playable roof or invisible floor-to-roof box.
  for(const z of [-9,9])cube('workshop-canopy',28.25,3.65,z,1.5,.12,7,metal);
  for(const z of [-14,14]) {
    floor('workshop-bay-line',25.15,z,5.4,.1,yellow);
    floor('alley-loading-line',-25.15,z,5.4,.1,yellow);
  }
  world._addMapSign('NO THROUGH TRAFFIC',-25,2.2,-20.16,0,
    {w:2.7,h:.5,parent:root,style:'industrial',subtitle:'SERVICE ACCESS ONLY'});
  world._addMapSign('NO EXIT',25,2.2,20.16,Math.PI,
    {w:2.7,h:.5,parent:root,style:'industrial',subtitle:'USE SIDE PASSAGES'});

  // Wall details only: no new obstacles, blinking lights or particle spam.
  for(const side of [-1,1])for(const z of [-6,6]){
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
      world._addMapSign('POLICE LINE',x,1.95,dir*41.98,dir>0?Math.PI:0,
        {w:1.7,h:.35,parent:root,style:'industrial',subtitle:'AREA CLOSED'});
    }
    // Two short paired braking traces approaching each bus; no giant decals.
    for(const x of [-.75,.75])floor('braking-trace',x,dir*31.1,.12,1.7,mat(0x20282b),.023);
  }
  for(const b of buildings){
    const {side,z,span,variant}=b.userData.streetBuilding;
    const rot=side<0?Math.PI/2:-Math.PI/2;
    world._addMapSign(String(100+Math.round(z+42)+(side>0?1:0)),side*15.91,2.12,z+span*.19,rot,
      {w:.36,h:.20,parent:root,style:'industrial',subtitle:''});
    if(variant===1||variant===4){
      world._addMapSign('EVACUATION',side*15.91,1.65,z+span*.19,rot,
        {w:.55,h:.55,parent:root,style:'industrial',subtitle:'FOLLOW POLICE INSTRUCTIONS'});
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
  for(const z of [-7,7]){
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
  }
}
