import * as THREE from 'three';

// Clip triangles rather than flattening vertices into overlapping surfaces.
// Preserve UVs/colors/normals and leave the shared source geometry untouched.
export function clipFacadeAbove(geometry, matrixWorld, height) {
  const attributes=Object.entries(geometry.attributes);
  const output=Object.fromEntries(attributes.map(([name])=>[name,[]]));
  const p=geometry.attributes.position,index=geometry.index;
  const vertex=i=>{
    const values={};
    for(const [name,a] of attributes){
      values[name]=Array.from({length:a.itemSize},(_,k)=>a.getComponent(i,k));
    }
    return {values,y:new THREE.Vector3(...values.position).applyMatrix4(matrixWorld).y};
  };
  const interpolate=(a,b)=>{
    const t=(height-a.y)/(b.y-a.y),values={};
    for(const [name] of attributes)values[name]=a.values[name].map((v,k)=>v+(b.values[name][k]-v)*t);
    return {values,y:height};
  };
  for(let i=0;i<(index?index.count:p.count);i+=3){
    const triangle=[0,1,2].map(k=>vertex(index?index.getX(i+k):i+k)),polygon=[];
    for(let k=0;k<3;k++){
      const a=triangle[k],b=triangle[(k+1)%3],inside=a.y>=height;
      if(inside)polygon.push(a);
      if(inside!==(b.y>=height))polygon.push(interpolate(a,b));
    }
    for(let k=1;k<polygon.length-1;k++){
      for(const v of [polygon[0],polygon[k],polygon[k+1]])
        for(const [name] of attributes)output[name].push(...v.values[name]);
    }
  }
  const clipped=new THREE.BufferGeometry();
  for(const [name,a] of attributes)clipped.setAttribute(name,new THREE.Float32BufferAttribute(output[name],a.itemSize));
  clipped.computeBoundingBox();clipped.computeBoundingSphere();
  return clipped;
}
