// Triángulos que Three envía al pase de color. Conserva los grupos de material,
// el rango de dibujo y la transformación de cada copia de un lote.
import * as T from 'three';

export function drawable(material) {
  return material && material.visible && material.colorWrite &&
    material.opacity >= material.alphaTest && (!material.transparent || material.opacity > 0);
}

export function eachTriangle(root, visit) {
  const local = new T.Matrix4(), transform = new T.Matrix4(), tri = new T.Triangle();
  root.traverseVisible(mesh => {
    if (!mesh.isMesh || !mesh.layers.isEnabled(0)) return;
    const g = mesh.geometry, pos = g.attributes.position;
    const groups = Array.isArray(mesh.material) ? g.groups : [{start: 0, count: Infinity}];
    const end = Math.min(g.drawRange.start + g.drawRange.count, g.index?.count ?? pos.count);
    for (let i = 0; i < (mesh.isInstancedMesh ? mesh.count : 1); i++) {
      if (mesh.isInstancedMesh) mesh.getMatrixAt(i, local);
      else local.identity();
      transform.multiplyMatrices(mesh.matrixWorld, local);
      for (const group of groups) {
        const material = Array.isArray(mesh.material) ? mesh.material[group.materialIndex] : mesh.material;
        if (!drawable(material)) continue;
        for (let j = Math.max(g.drawRange.start, group.start); j + 2 < Math.min(end, group.start + group.count); j += 3) {
          const point = (v, k) => v.fromBufferAttribute(pos, g.index ? g.index.getX(j+k) : j+k).applyMatrix4(transform);
          point(tri.a, 0); point(tri.b, 1); point(tri.c, 2);
          visit(tri, mesh, material, i);
        }
      }
    }
  });
}

// Índice en planta: un triángulo de un lote fusionado nunca representa por
// sí solo todos los objetos comprendidos entre los extremos de ese lote.
export class MapTriangles {
  constructor(world) {
    this.grid = new Map();
    const add = (t, mesh, mat, instance) => {
      const bounds = new T.Box3().setFromPoints([t.a,t.b,t.c]);
      if (bounds.min.x > world.fx+8 || bounds.max.x < -world.fx-8 ||
          bounds.min.z > world.fz+8 || bounds.max.z < -world.fz-8 || bounds.max.y < -.05) return;
      const face = {triangle:t.clone(), mesh, mat, bounds, instance};
      for (const key of this.cells(bounds)) {
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(face);
      }
    };
    eachTriangle(world.mapGroup, add);
    // La ciudad, las calcomanías y los rótulos viven en el look. Las nubes,
    // aves y columnas de humo se posicionan en el shader de atmósfera.
    for(const layer of world.look.group.children){
      if(layer.name==='look-atmos' || layer.name==='look-flora')continue;
      eachTriangle(layer,add);
    }
  }

  *cells(b) {
    for (let x = Math.floor(b.min.x/3); x <= Math.floor(b.max.x/3); x++)
      for (let z = Math.floor(b.min.z/3); z <= Math.floor(b.max.z/3); z++) yield x+','+z;
  }

  *near(box) {
    const seen = new Set();
    for (const key of this.cells(box)) for (const face of this.grid.get(key) ?? []) {
      if (seen.has(face) || !box.intersectsBox(face.bounds)) continue;
      seen.add(face);
      yield face;
    }
  }

  hits(origin, direction, distance) {
    const ray = new T.Ray(origin, direction), end = ray.at(distance,new T.Vector3());
    const box = new T.Box3().setFromPoints([origin,end]).expandByScalar(.00001);
    const hits = [], p = new T.Vector3();
    for (const face of this.near(box)) {
      const {a,b,c} = face.triangle;
      const hit = face.mat.side === T.BackSide ? ray.intersectTriangle(c,b,a,true,p)
        : ray.intersectTriangle(a,b,c,face.mat.side === T.FrontSide,p);
      if (hit && origin.distanceTo(hit) <= distance) hits.push({face, distance:origin.distanceTo(hit)});
    }
    return hits.sort((a,b) => a.distance-b.distance);
  }
}

// Intersección de los interiores en el plano. También encuentra un filete que
// pisa una esquina sin cubrir el centro de ninguno de los dos triángulos.
function overlapPoint(a,b,normal) {
  let points=[a.a,a.b,a.c];
  for(const [start,end] of [[b.a,b.b],[b.b,b.c],[b.c,b.a]]) {
    const inward=new T.Vector3().subVectors(end,start).cross(normal).negate();
    const polygon=points;
    points=[];
    for(let i=0;i<polygon.length;i++){
      const p=polygon[i],q=polygon[(i+1)%polygon.length];
      const dp=inward.dot(p)-inward.dot(start),dq=inward.dot(q)-inward.dot(start);
      if(dp>=0)points.push(p);
      if(dp*dq<0)points.push(p.clone().lerp(q,dp/(dp-dq)));
    }
    if(points.length<3)return null;
  }
  let area=0;
  for(let i=1;i+1<points.length;i++)area+=new T.Triangle(points[0],points[i],points[i+1]).getArea();
  if(area<1e-7)return null;
  const center=points.reduce((sum,p)=>sum.add(p),new T.Vector3()).divideScalar(points.length);
  // Dos teselas contiguas pueden redondear un borde compartido en una ULP de float32.
  for(const tri of [a,b])for(const [x,y] of [[tri.a,tri.b],[tri.b,tri.c],[tri.c,tri.a]]){
    const edge=new T.Vector3().subVectors(y,x).normalize();
    if(Math.abs(new T.Vector3().subVectors(center,x).cross(edge).dot(normal))<.000003)return null;
  }
  return center;
}

const biasKey=m=>m.polygonOffset ? m.polygonOffsetFactor+'/'+m.polygonOffsetUnits : '0/0';

export function *frameOverlaps(world,index) {
  const seen=new Set(), buckets=new Map(), n=new T.Vector3(), p=new T.Vector3();
  for(const list of index.grid.values())for(const f of list) {
    if(seen.has(f))continue;
    seen.add(f);
    const t=f.triangle, label=f.mesh.parent.name+' '+f.mesh.name+' '+f.mat.name;
    if(!/facade|polish-batch|window|marco|jamba|grille|cabinet|sign:|door|ruina-|roof-access|gallery|gallerie/i.test(label))continue;
    t.getMidpoint(p);
    if(p.y<.015 || Math.abs(p.x)>world.fx+.1 || Math.abs(p.z)>world.fz+.1 || t.getArea()<1e-7)continue;
    const addFace=face=>{
      face.triangle.getNormal(n);
      const key=n.toArray().map(k=>Math.round(k*1000)).join('/')+' '+biasKey(face.mat);
      if(!buckets.has(key))buckets.set(key,[]);
      buckets.get(key).push(face);
    };
    if(f.mat.side!==T.BackSide)addFace(f);
    if(f.mat.side!==T.FrontSide)addFace({...f,source:f,triangle:new T.Triangle(t.c,t.b,t.a)});

  }
  for(const faces of buckets.values()){
    faces.sort((a,b)=>a.bounds.min.x-b.bounds.min.x);
    for(let i=0;i<faces.length;i++){
      const a=faces[i],t=a.triangle,normal=t.getNormal(new T.Vector3());
      for(let j=i+1;j<faces.length;j++){
        const b=faces[j];
        if(b.bounds.min.x>a.bounds.max.x+.002)break;
        if(b.bounds.min.y>a.bounds.max.y+.002 || b.bounds.max.y<a.bounds.min.y-.002 ||
           b.bounds.min.z>a.bounds.max.z+.002 || b.bounds.max.z<a.bounds.min.z-.002)continue;
        const gap=normal.dot(b.triangle.a)-normal.dot(t.a);
        if(Math.abs(gap)>=.001999 || normal.dot(b.triangle.getNormal(n))<.999999)continue;
        const at=overlapPoint(t,b.triangle,normal);
        if(!at)continue;
        const hits=index.hits(at.clone().addScaledVector(normal,.12),normal.clone().negate(),.123);
        if(hits.length && hits[0].distance>=.118 && hits.some(h=>h.face===(a.source??a)) && hits.some(h=>h.face===(b.source??b)))
          yield {at,gap:Math.abs(gap),a,b};
      }
    }
  }
}
