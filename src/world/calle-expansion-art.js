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
  const floor = (name,x,z,w,d,material) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w,d),material);
    mesh.name=name;mesh.rotation.x=-Math.PI/2;mesh.position.set(x,.016,z);
    mesh.receiveShadow=true;root.add(mesh);
  };
  for(const side of [-1,1]) {
    floor(side<0?'service-alley-floor':'workshop-floor',side*25.25,0,7.5,40.4,concrete);
    for(const z of [-18,18])floor('open-street-passage',side*18.85,z,5.5,4.4,concrete);
  }
  // Visible walls and solid outer corners exactly match their collision boxes.
  for(const b of expansionBoxes()) {
    if(b.expansionKind==='wall' || (b.expansionKind==='building'&&Math.abs(b.x)>22)) {
      cube('district-boundary',b.x,b.h/2,b.z,b.w,b.h,b.d,brick);
      // Coping is contained within the physical top rather than floating above.
      cube('wall-coping',b.x,b.h-.08,b.z,b.w,.16,b.d,concrete);
    }
  }
  // Existing facade modules continue behind the side routes, outside play.
  const facadeInstances=new Map();
  for(const side of [-1,1])for(const z of [-30,-18,-6,6,18,30]) {
    const source=buildings.find(b=>b.userData.streetBuilding.side===side);
    const clone=source.clone(true);clone.position.set(side*31.7,0,z);
    clone.name='calle2-outer-city-building';clone.userData={streetContinuation:true};
    root.add(clone);
    clone.updateWorldMatrix(true,true);
    // Keep upper architecture, not unrelated storefronts in the repair yard.
    // The physical brick wall supplies the ground floor.
    clone.traverse(part=>{
      if(!part.isMesh)return;
      if(new THREE.Box3().setFromObject(part).max.y<4.1){part.visible=false;return;}
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
    cube(p.kind,p.x,p.h/2,p.z,p.w,p.h,p.d,bodyMat);
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
    {w:2.7,h:.5,parent:root,style:'transit',subtitle:'SERVICE ACCESS ONLY'});
  world._addMapSign('SERVICE EXIT',25,2.2,20.16,Math.PI,
    {w:2.7,h:.5,parent:root,style:'transit',subtitle:'RETURN TO STREET'});
}
