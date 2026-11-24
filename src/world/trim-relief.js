// Quita únicamente la zona común de dos caras exteriores paralelas de un GLB.
// Se conserva el paño más saliente. En un empate exacto manda el detalle
// pequeño. La interpolación mantiene las UV y las normales de los biseles.
import { BufferAttribute, BufferGeometry, Triangle, Vector3 } from 'three';

const EPS = 1e-7;
const area = poly => Math.abs(poly.reduce((sum, p, i) => {
  const q = poly[(i+1)%poly.length];
  return sum + p.x*q.y - q.x*p.y;
}, 0)) / 2;

function halfPlane(polygon, a, b, inside) {
  const out = [];
  const side = p => (b.x-a.x)*(p.y-a.y) - (b.y-a.y)*(p.x-a.x);
  for (let i=0; i<polygon.length; i++) {
    const p = polygon[i], q = polygon[(i+1)%polygon.length];
    const dp = side(p), dq = side(q);
    if (inside ? dp>=0 : dp<=0) out.push(p);
    if (dp*dq<0) out.push(p.clone().lerp(q, dp/(dp-dq)));
  }
  return out;
}

function subtract(polygon, mask) {
  let inner = polygon;
  const outside = [];
  for (let i=0; i<3 && inner.length; i++) {
    const a=mask[i], b=mask[(i+1)%3];
    const strip = halfPlane(inner,a,b,false);
    if (strip.length>=3 && area(strip)>1e-11) outside.push(strip);
    inner = halfPlane(inner,a,b,true);
  }
  return inner.length>=3 && area(inner)>1e-10 ? outside : [polygon];
}

// Los modelos que reciben esta reparación son lotes estáticos por material.
// Solo se recrean los índices afectados y se interpolan los vértices nuevos.
function replaceFaces(mesh, edits) {
  const src=mesh.geometry, attrs=Object.entries(src.attributes);
  const values=new Map(attrs.map(([name])=>[name,[]])), index=[];
  const count=src.attributes.position.count, ids=src.index;
  const oldIndex=i=>ids ? ids.getX(i) : i;
  let next=count;
  for(let j=0;j<(ids?.count??count);j+=3){
    const edit=edits.get(j);
    const corners=[oldIndex(j),oldIndex(j+1),oldIndex(j+2)];
    if (!edit) { index.push(...corners); continue; }
    const {projected,polygons}=edit;
    for(const poly of polygons){
      const indices=poly.map(p=>{
        const corner=projected.indexOf(p);
        if(corner>=0)return corners[corner];
        const weights=Triangle.getBarycoord(p,...projected,new Vector3());
        for(const [name,attr] of attrs)for(let k=0;k<attr.itemSize;k++){
          values.get(name).push(weights.x*attr.getComponent(corners[0],k)+
            weights.y*attr.getComponent(corners[1],k)+weights.z*attr.getComponent(corners[2],k));
        }
        return next++;
      });
      for(let k=1;k+1<indices.length;k++)index.push(indices[0],indices[k],indices[k+1]);
    }
  }
  const out=new BufferGeometry();
  for(const [name,attr] of attrs){
    const data=new Float32Array(next*attr.itemSize);
    for(let i=0;i<count;i++)for(let k=0;k<attr.itemSize;k++)data[i*attr.itemSize+k]=attr.getComponent(i,k);
    data.set(values.get(name),count*attr.itemSize);
    out.setAttribute(name,new BufferAttribute(data,attr.itemSize));
  }
  out.setIndex(index);
  out.computeBoundingBox();out.computeBoundingSphere();
  mesh.geometry=out;
}

export function trimRelief(root, gap=.00205) {
  root.updateMatrixWorld(true);
  const planes=new Map(), edits=new Map(), tri=new Triangle();
  root.traverse(mesh=>{
    if(!mesh.isMesh || mesh.material.transparent || mesh.material.alphaTest ||
        mesh.geometry.groups.length || mesh.isSkinnedMesh) return;
    const g=mesh.geometry, pos=g.attributes.position, ids=g.index;
    for(let i=0;i<(ids?.count??pos.count);i+=3){
      const corners=[tri.a,tri.b,tri.c];
      corners.forEach((p,k)=>p.fromBufferAttribute(pos,ids?ids.getX(i+k):i+k).applyMatrix4(mesh.matrixWorld));
      const normal=tri.getNormal(new Vector3());
      if(tri.getArea()<1e-9)continue;
      const abs=normal.toArray().map(Math.abs), axis=abs.indexOf(Math.max(...abs));
      const u=(axis+1)%3,v=(axis+2)%3,sign=Math.sign(normal.getComponent(axis));
      const key=axis+':'+normal.toArray().map(n=>Math.round(n*100)).join(',');
      if(!planes.has(key))planes.set(key,[]);
      const projected=corners.map(p=>new Vector3(p.getComponent(u),sign*p.getComponent(v),0));
      const xs=projected.map(p=>p.x),ys=projected.map(p=>p.y);
      planes.get(key).push({mesh,i,normal,depth:normal.dot(tri.a),projected,area:area(projected),
        minx:Math.min(...xs),maxx:Math.max(...xs),miny:Math.min(...ys),maxy:Math.max(...ys),
        origin:tri.a.clone()});
    }
  });
  for(const faces of planes.values()){
    // Barrido por X: el coste depende de los vecinos del paño, no de la ciudad.
    faces.sort((a,b)=>a.minx-b.minx);
    const masks=new Map();
    for(let i=0;i<faces.length;i++){
      const a=faces[i];
      for(let j=i+1;j<faces.length&&faces[j].minx<a.maxx-EPS;j++){
        const b=faces[j];
        if(b.maxx<=a.minx+EPS || b.miny>=a.maxy-EPS || b.maxy<=a.miny+EPS ||
          a.normal.dot(b.normal)<.9999999)continue;
        const separation=a.normal.dot(b.origin)-a.depth;
        if(Math.abs(separation)>=gap)continue;
        const bWins=Math.abs(separation)>1e-6 ? separation>0 : b.area<=a.area;
        const loser=bWins?a:b, winner=bWins?b:a;
        if(!masks.has(loser))masks.set(loser,[]);
        masks.get(loser).push(winner);
      }
    }
    for(const [face,others] of masks){
      let pieces=[face.projected];
      for(const other of others){
        pieces=pieces.flatMap(p=>subtract(p,other.projected));
        if(!pieces.length)break;
      }
      if(pieces.length===1&&pieces[0]===face.projected)continue;
      if(!edits.has(face.mesh))edits.set(face.mesh,new Map());
      edits.get(face.mesh).set(face.i,{projected:face.projected,polygons:pieces});
    }
  }
  for(const [mesh,changes] of edits)replaceFaces(mesh,changes);
}
