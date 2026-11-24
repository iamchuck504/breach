// Talla los encuentros antes de publicar el GLB, fuera del bucle de carga.
// Conserva las demás primitivas, materiales, transformaciones y atributos.
import fs from 'node:fs';
import path from 'node:path';
import {Matrix4, Quaternion, Vector3} from 'three';
import { exposedMasonry, galleryThresholds, masonryBox, masonrySupports } from '../src/world/fortaleza-masonry.js';

export function finishMasonry(file) {
  const gallery = path.basename(file) === 'fortaleza-galleries.glb';
  const input = fs.readFileSync(file), jsonEnd = 20 + input.readUInt32LE(12);
  const doc = JSON.parse(input.toString('utf8',20,jsonEnd));
  const bytes = input.subarray(jsonEnd+8);
  function accessor(id) {
    const a = doc.accessors[id], view = doc.bufferViews[a.bufferView];
    const Type = {5126:Float32Array,5123:Uint16Array,5125:Uint32Array}[a.componentType];
    return new Type(bytes.buffer, bytes.byteOffset+(view.byteOffset??0)+(a.byteOffset??0),
      a.count*({VEC3:3,SCALAR:1}[a.type]));
  }
  const boxes = [], parts = new Map();
  for (const n of doc.nodes) {
    if (!gallery && !n.name.startsWith('Ashlar facing')) continue;
    const prim = doc.meshes[n.mesh].primitives[0];
    const matrix = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(
      new Vector3(...(n.translation ?? [0,0,0])), new Quaternion(...(n.rotation ?? [0,0,0,1])),
      new Vector3(...(n.scale ?? [1,1,1])));
    const pos = accessor(prim.attributes.POSITION), idx = accessor(prim.indices);
    const worldPoints = Array.from({length:pos.length/3},(_,i) =>
      new Vector3().fromArray(pos,3*i).applyMatrix4(matrix).toArray().map(v => Math.round(v*100000)/100000));
    // Cada caja sin bisel del generador ocupa doce triángulos contiguos.
    if (idx.length % 36) throw Error('Lote de cajas inesperado: '+n.name);
    for (let i=0; i<idx.length; i+=36) {
      const axes = [0,1,2].map(k => new Set(Array.from(idx.subarray(i,i+36), j =>
        worldPoints[j][k])));
      if (axes.some(a => a.size !== 2)) throw Error('Caja no ortogonal en '+n.name);
      boxes.push(masonryBox(axes.map(a=>Math.min(...a)),axes.map(a=>Math.max(...a)),n));
    }
    // Las normales ya están en los ejes del mundo. Se conserva el origen local del lote.
    const origin = new Vector3().setFromMatrixPosition(matrix).toArray();
    n.translation = origin;
    delete n.rotation; delete n.scale; delete n.matrix;
    parts.set(n,{pos:[],norm:[],idx:[],prim,origin});
  }
  if (!parts.size) throw Error('Falta el revestimiento de '+file);
  if (gallery) {
    const stone = doc.nodes.find(n => n.name === 'Aged fortress limestone');
    if (!parts.has(stone)) throw Error('Falta la piedra de los umbrales');
    boxes.push(...galleryThresholds(stone));
  }
  // Las cajas externas ya tienen su propia malla. El plano inferior se apoya en el terreno.
  boxes.push(...masonrySupports(!gallery),masonryBox([-45,-1,-40],[45,0,40]));
  exposedMasonry(boxes,(n,quad,normal) => {
    const p=parts.get(n), first=p.pos.length/3;
    for (const vertex of quad) {
      p.pos.push(...vertex.map((v,k)=>v-p.origin[k])); p.norm.push(...normal);
    }
    p.idx.push(first,first+1,first+2,first,first+2,first+3);
  });
  const streams=doc.bufferViews.map(v=>bytes.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength));
  function append(array,type,componentType,target) {
    const bufferView=streams.length;
    streams.push(Buffer.from(array.buffer)); doc.bufferViews.push({buffer:0,byteLength:array.byteLength,target});
    doc.accessors.push({bufferView,type,componentType,count:array.length/(type==='VEC3'?3:1)});
    return doc.accessors.length-1;
  }
  for (const {pos,norm,idx,prim} of parts.values()) {
    const points=Float32Array.from(pos), position=append(points,'VEC3',5126,34962);
    const bounds=doc.accessors[position];
    bounds.min=[Infinity,Infinity,Infinity]; bounds.max=[-Infinity,-Infinity,-Infinity];
    points.forEach((v,i)=>{const k=i%3; bounds.min[k]=Math.min(bounds.min[k],v); bounds.max[k]=Math.max(bounds.max[k],v);});
    prim.attributes={POSITION:position,NORMAL:append(Float32Array.from(norm),'VEC3',5126,34962)};
    const wide=points.length/3>65535;
    prim.indices=append(wide?Uint32Array.from(idx):Uint16Array.from(idx),'SCALAR',wide?5125:5123,34963);
  }
  // Compactar el buffer compartido, conservando los accesores de las piezas intactas.
  const accessors=[], views=[], chunks=[], remap=new Map(), moved=new Map();
  let size=0;
  function keep(id) {
    if (remap.has(id)) return remap.get(id);
    const a=doc.accessors[id], old=a.bufferView;
    if (!moved.has(old)) {
      const stream=streams[old], padding=(4-stream.length%4)%4;
      moved.set(old,views.length);
      views.push({...doc.bufferViews[old],byteOffset:size});
      chunks.push(stream,Buffer.alloc(padding)); size+=stream.length+padding;
    }
    remap.set(id,accessors.length); accessors.push({...a,bufferView:moved.get(old)});
    return remap.get(id);
  }
  for (const mesh of doc.meshes) for (const p of mesh.primitives) {
    for (const key of Object.keys(p.attributes)) p.attributes[key]=keep(p.attributes[key]);
    p.indices=keep(p.indices);
  }
  doc.accessors=accessors;doc.bufferViews=views;doc.buffers=[{byteLength:size}];
  const json=Buffer.from(JSON.stringify(doc)), header=Buffer.alloc(20), binaryHeader=Buffer.alloc(8);
  const pad=Buffer.alloc((4-json.length%4)%4,32);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+pad.length+size,8);
  header.writeUInt32LE(json.length+pad.length,12);header.write('JSON',16);
  binaryHeader.writeUInt32LE(size);binaryHeader.write('BIN\0',4);
  fs.writeFileSync(file,Buffer.concat([header,json,pad,binaryHeader,...chunks]));
}
