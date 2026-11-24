// Auditoría en metros sobre la escena final, después de cargar, fusionar e instanciar los GLB.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as T from 'three';
import { checkFortalezaOpenings } from './lib-fortaleza-vanos.mjs';
import { buildMap } from './lib-map-visuals.mjs';
import { MapTriangles, drawable, frameOverlaps } from './map-visual-geometry.mjs';
import { decksFor, rampsFor } from '../src/world/collision-layouts.js';

const vec = (x,y,z) => new T.Vector3(x,y,z);
const coord = p => p.toArray().map(v => v.toFixed(3)).join(', ');
const down = vec(0,-1,0);

function checkObjects(world, index) {
  let count = 0;
  for (const c of world.colliders) {
    if (c.moveOnly) continue; // El vacío entre azoteas impide andar y debe seguir vacío.
    const base = c.minY ?? 0;
    const box = new T.Box3(vec(c.minx-.025,base+Math.min(.09,(c.h-base)*.3),c.minz-.025),
      vec(c.maxx+.025,c.h+.08,c.maxz+.025));
    let found = false;
    for (const face of index.near(box)) {
      if (face.triangle.getArea()>1e-7 && box.intersectsTriangle(face.triangle)) { found=true; break; }
    }
    assert(found,'Caja sin representación en '+coord(box.getCenter(vec())));
    count++;
  }
  for (const c of world.segmentColliders) {
    const center=vec((c.a.x+c.b.x)/2,c.h-.35,(c.a.z+c.b.z)/2);
    const normal=vec(c.n.x,0,c.n.z);
    const hits=index.hits(center.clone().addScaledVector(normal,c.half+.25),normal.negate(),.5+c.half*2);
    assert(hits.length,'Baranda sin representación en '+coord(center));
    count++;
  }
  return count;
}

function checkInstances(world) {
  const local=new T.Matrix4(), p=vec(), normal=vec(), tri=new T.Triangle();
  const testedGeometry=new Set();
  let count=0;
  world.scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    let visible=mesh.layers.isEnabled(0);
    for(let o=mesh;o;o=o.parent) visible &&= o.visible;
    const g=mesh.geometry, materials=[mesh.material].flat();
    const drawn=visible && materials.some(drawable) && g.drawRange.count>0 &&
      (g.index?.count??g.attributes.position.count)>0 && (!mesh.isInstancedMesh || mesh.count>0);
    assert(!mesh.castShadow || drawn,'Sombra sin dibujo en '+mesh.parent.name+'/'+mesh.name);
    if (!drawn) return;
    assert(mesh.matrixWorld.elements.every(Number.isFinite) && mesh.matrixWorld.determinant()>0,mesh.name);
    for(let o=mesh;o;o=o.parent) assert(o.scale.toArray().every(k=>k>0),mesh.name+': escala');
    // Una normal exterior con los tres vértices ordenados al revés se ilumina
    // correctamente pero desaparece al activar el descarte de caras traseras.
    if(!testedGeometry.has(g) && materials.every(m=>m.side===T.FrontSide) && g.attributes.normal){
      testedGeometry.add(g);
      for(let j=0;j<(g.index?.count??g.attributes.position.count);j+=3){
        const id=k=>g.index?g.index.getX(j+k):j+k;
        [tri.a,tri.b,tri.c].forEach((v,k)=>v.fromBufferAttribute(g.attributes.position,id(k)));
        if(tri.getArea()<.000005)continue;
        tri.getNormal(normal);
        assert(![0,1,2].every(k=>p.fromBufferAttribute(g.attributes.normal,id(k)).dot(normal)<-.75),
          mesh.name+': cara invertida en '+coord(tri.getMidpoint(p).applyMatrix4(mesh.matrixWorld)));
      }
    }
    if(!mesh.isInstancedMesh) return;
    if(!mesh.boundingSphere) mesh.computeBoundingSphere();
    const sphere=mesh.boundingSphere;
    assert(sphere.center.toArray().every(Number.isFinite) && Number.isFinite(sphere.radius),mesh.name);
    for(let i=0;i<mesh.count;i++) {
      mesh.getMatrixAt(i,local);
      assert(local.elements.every(Number.isFinite) && local.determinant()>0,mesh.name+': instancia '+i);
      let top=-Infinity;
      for(let j=0;j<g.attributes.position.count;j++) {
        p.fromBufferAttribute(g.attributes.position,j).applyMatrix4(local);
        assert(p.toArray().every(Number.isFinite),mesh.name+': vértice');
        if(mesh.frustumCulled) assert(p.distanceTo(sphere.center)<=sphere.radius+.00015,mesh.name+': recorte');
        top=Math.max(top,p.applyMatrix4(mesh.matrixWorld).y);
      }
      // La bandada sitúa cada ave en el cielo en el shader y desactiva el recorte de CPU.
      if(mesh.name!=='atmos-birds' || mesh.frustumCulled) assert(top>-.00001 && top!==0,mesh.name+': enterrada');
      count++;
    }
  });
  return count;
}

function passages(layout) {
  const out=[];
  const opening=(x,z,w,d,floor=0)=>out.push(new T.Box3(vec(x-w/2,floor+.06,z-d/2),vec(x+w/2,floor+2.1,z+d/2)));
  for(const s of [-1,1]) {
    if(layout==='calle2') for(const z of [-18,18]) opening(s*18.85,z,5.9,4.35);
    if(layout==='azoteas') {
      opening(s*17.9,s*5,2.53,.85);
      opening(s*17.1,-s*5,2.53,.85);
      opening(s*13.5,0,.85,3);
      opening(0,s*6,2,1,1.1);
    }
    if(layout==='fortaleza') {
      for(const x of [-16,0,16]) opening(x,s*27,2,.8);
      for(const z of [-17,17]) opening(s*25.8,z,.42,1.65);
      opening(s*25.8,0,.42,2.3,3);
    }
  }
  for(const r of rampsFor(layout)) {
    const alongZ=r.axis==='z', len=alongZ?r.d:r.w;
    const x=r.x+(alongZ?0:r.dir*len/2), z=r.z+(alongZ?r.dir*len/2:0);
    opening(x,z,alongZ?r.w-.12:.4,alongZ?.4:r.d-.12,r.h);
  }
  return out;
}

function checkSigns(world,index) {
  let count=0;
  for(const opening of passages(world.layout)) for(const f of index.near(opening)) {
    const name=[f.mesh.parent.name,f.mesh.name,f.mat.name].join(' ');
    if(/map-sign|prop-label|signage|awning|marquee|banner|neon|lettering|shop.title|flag.sign|swinging.sign|placard|hazard-plates|storefront.sign/i.test(name)) {
      assert(!opening.intersectsTriangle(f.triangle),'Paso ocupado por '+name+' en '+coord(opening.getCenter(vec())));
    }
  }
  world.mapGroup.traverseVisible(group=>{
    if(!group.name.startsWith('map-sign:'))return;
    const text=group.children[1], size=text.geometry.parameters;
    const normal=vec(0,0,1).transformDirection(text.matrixWorld);
    for(const u of [-.45,0,.45])for(const v of [-.43,0,.43]){
      const point=text.localToWorld(vec(u*size.width,v*size.height,0));
      // El espray calado del cordón forma parte del texto tachado; medimos el soporte bajo su tinta.
      const first=index.hits(point.clone().addScaledVector(normal,.42),normal.clone().negate(),.43)
        .find(hit=>hit.face.mesh.name!=='ruina-decals');
      assert.equal(first?.face.mesh===text,true,group.name+': texto oculto o invertido en '+coord(point));
      // Un rótulo bajo queda sobre su soporte, fuera del espacio que puede ocupar el cuerpo.
      const foot={x:point.x,z:point.z};
      const floors=[world.baseGround(foot,.02)];
      for(const d of decksFor(world.layout))for(const side of d.mirror?[-1,1]:[1])
        if(Math.abs(point.x-side*d.x)<d.w/2+.02 && Math.abs(point.z-side*d.z)<d.d/2+.02) floors.push(d.h);
      for(const floor of floors)if(point.y>floor && point.y<floor+2.1 && world._onFloor(foot.x,foot.z)){
        const body={...foot};world.resolveCircle(body,.38,floor);
        assert(Math.hypot(body.x-foot.x,body.z-foot.z)>.001,group.name+': dentro del paso en '+coord(point));
      }
    }
    count++;
  });
  assert.equal(count,{fortaleza:6,azoteas:10,calle2:24}[world.layout], 'Rótulos montados');
  return count;
}

function checkSurfaces(world,index) {
  const seen=new Set(), normal=vec(), p=vec(), otherNormal=vec();
  let samples=0;
  for(const cell of index.grid.values())for(const f of cell) {
    if(seen.has(f))continue;
    seen.add(f);
    const t=f.triangle;
    t.getNormal(normal); t.getMidpoint(p);
    if(Math.abs(p.x)>world.fx+.1 || Math.abs(p.z)>world.fz+.1 || p.y<.001 || p.y>8 ||
        (normal.y<-.99 && p.y<2.1) || t.getArea()<.00006)continue;
    // Fortaleza tiene un ensayo específico de las jambas, dinteles y ventanas, también en esta cadena.
    if(world.layout==='fortaleza' && !(Math.abs(Math.abs(p.x)-25.8)<.23 && Math.abs(p.z)<1.23 && p.y>=3 && p.y<=5.25))continue;
    p.copy(t.a).multiplyScalar(.311).addScaledVector(t.b,.327).addScaledVector(t.c,.362);
    const origin=p.clone().addScaledVector(normal,.12);
    const hits=index.hits(origin,normal.clone().negate(),.124);
    if(!hits.some(h=>h.face===f) || hits[0].distance<.118)continue;
    samples++;
    for(const {face,distance} of hits) {
      if(face===f || Math.abs(distance-.12)>=.001999 || normal.dot(face.triangle.getNormal(otherNormal))<.999999)continue;
      const bias=m=>m.polygonOffset ? [m.polygonOffsetFactor,m.polygonOffsetUnits].join('/') : '0/0';
      assert.notEqual(bias(face.mat),bias(f.mat),'Dos caras a '+(1000*Math.abs(distance-.12)).toFixed(3)+' mm en '+coord(p)+' '+face.mesh.name+' / '+f.mesh.name);
    }
  }
  assert(samples>0,'Sin superficies examinadas');
  return samples;
}

function geometryHash(world) {
  const hash=createHash('sha256'), geometries=new Set();
  const feed=a=>hash.update(Buffer.from(a.buffer,a.byteOffset,a.byteLength));
  for(const root of [world.mapGroup,world.look.group])root.traverseVisible(o=>{
    if(!o.isMesh)return;
    feed(Float64Array.from(o.matrixWorld.elements));
    if(o.isInstancedMesh)feed(o.instanceMatrix.array);
    if(o.instanceColor)feed(o.instanceColor.array);
    if(geometries.has(o.geometry))return;
    geometries.add(o.geometry);
    for(const key of ['position','normal','color','uv']) {
      const a=o.geometry.attributes[key];
      if(a)feed(a.isInterleavedBufferAttribute?a.data.array:a.array);
    }
    if(o.geometry.index)feed(o.geometry.index.array);
  });
  return hash.digest('hex');
}

function checkRepairs(world,index) {
  if(world.layout==='calle2')for(const side of [-1,1])for(const z of [-20.5,24.2]){
    for(const [x,height] of [[14.82,.495],[15.13,.85]]){
      const p=vec(side*x,1,side*z);
      const first=index.hits(p,down,.8)[0];
      assert(first && Math.abs(1-first.distance-height)<.001,'Falta la banca en '+coord(p));
    }
  }
  if(world.layout==='calle2')for(const [side,z] of [[-1,-2],[1,2],[-1,34],[1,-34]]){
    const n=vec(side,0,0), x=side*12.5;
    // fuera del poste: la sonda baja debe atravesar el hueco y la alta encontrar la placa
    const ray=y=>index.hits(vec(x-side*.3,y,z+.15),n,.32);
    assert.equal(ray(2.10).length,0,'Señal de acera por debajo de 2.1 m en '+[x,z]);
    const plate=ray(2.16)[0];
    assert(plate && Math.abs(plate.distance-.3)<.001,'Falta la placa en '+[x,z]);
    const print=index.hits(vec(x-side*2,2.5,z),n,2.01)[0]?.face;
    assert(print?.mat.map?.image && print.mat.map.image===world._cv.parkingSign,
      'Señal de acera sin impresión visible desde la calle en '+[x,z]);
  }
  if(world.layout!=='azoteas')return;
  for(const s of [-1,1])for(const offset of [-2,2]){
    const p=vec(s*25+1.18,2.58,s*6.8+offset);
    assert(index.hits(p,vec(-1,0,0),.24).length,'Pedestal incompleto en '+coord(p));
  }
  const m=new T.Matrix4();
  for(const name of ['azoteas-edge-lights','azoteas-hazard-plates','azoteas-service-hatches','azoteas-puddles']) {
    const o=world.mapGroup.getObjectByName(name);
    const expected={'azoteas-edge-lights':34,'azoteas-hazard-plates':10,'azoteas-service-hatches':8,'azoteas-puddles':10};
    assert.equal(o?.count,expected[name],name);
    for(let i=0;i<o.count;i++){
      o.getMatrixAt(i,m);m.premultiply(o.matrixWorld);
      const plate=name.endsWith('plates'), n=plate?vec(0,0,1).transformDirection(m):vec(0,1,0);
      const geo=o.geometry.parameters, flat=geo.depth===undefined;
      for(let j=0;j<=16;j++){
        const angle=j*Math.PI/8, radius=j===16?0:.90;
        const x=(geo.width??2)*.5*radius*Math.cos(angle);
        const along=(flat?geo.height??2:geo.depth)*.5*radius*Math.sin(angle);
        const p=vec(x,flat?along:0,flat?0:along).applyMatrix4(m);
        const hits=index.hits(p.clone().addScaledVector(n,1.6),n.clone().negate(),1.67);
        assert(hits[0]?.face.mesh===o,name+' '+i+': tapada en '+coord(p));
      }
    }
  }
}

for(const layout of ['calle2','azoteas','fortaleza']){
  const world=await buildMap(layout), index=new MapTriangles(world);
  const objects=checkObjects(world,index), instances=checkInstances(world), signs=checkSigns(world,index);
  if(layout==='fortaleza')checkFortalezaOpenings(world);
  checkRepairs(world,index);
  const surfaces=checkSurfaces(world,index);
  for(const {at,gap} of frameOverlaps(world,index))assert.fail('Solape interior de marcos a '+(gap*1000)+' mm en '+coord(at));
  const again=await buildMap(layout);
  assert.equal(geometryHash(again),geometryHash(world),layout+': cambió la semilla');
  const paints=layout==='azoteas'?['concrete','concreteTop','windows','roofFloor','roofMark','hazard','serviceHatch','puddleWet']:
    layout==='calle2'?['asphalt','urbanBrick','urbanBrickDark','shopShutter','vehicleWear','vehicleGlass','puddle','parkingSign']:[];
  for(const key of paints)assert.equal(world._cv[key].paintDigest(),again._cv[key].paintDigest(),key+': cambió la pintura');
  console.log(layout+' OK · '+objects+' cajas/segmentos, '+instances+' instancias, '+signs+' rótulos, '+surfaces+' muestras de superficie');
}
