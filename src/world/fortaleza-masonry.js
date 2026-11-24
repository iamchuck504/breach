// Superficie exterior de la sillería ortogonal. Los apoyos sin material solo
// recortan: su cara visible ya la dibuja el muro. No interviene en la física.
import { FORT_GALLERY as G } from './fortaleza-galleries.js';
import { collisionBoxesFor } from './collision-layouts.js';

export function masonryBox(min, max, material = null) {
  // La exportación de Blender expresa el mismo borde con errores de micras.
  const snap = point => point.map(v => Math.round(v * 100000) / 100000);
  return { min: snap(min), max: snap(max), material };
}

// El suelo de la galería y el rellano exterior terminan en caras opuestas
// del muro. Un umbral de piedra cubre esos 40 cm entre ambas losas.
export function galleryThresholds(material = null) {
  return [-1,1].map(side => {
    const outer = side*(G.outer+.4), inner = side*G.outer;
    return masonryBox([Math.min(inner,outer),G.height-.1,-G.liza.upperHalf],
      [Math.max(inner,outer),G.height,G.liza.upperHalf],material);
  });
}

export function masonrySupports(includeGallery = true) {
  const boxes = includeGallery ? galleryThresholds() : [];
  for (const b of collisionBoxesFor('fortaleza')) {
    if (b.visual === false && !(includeGallery && b.gallery)) continue;
    for (const s of b.mirror === false || !(b.x || b.z) ? [1] : [-1, 1]) {
      const x = s*b.x, z = s*b.z;
      const lap = Math.abs(x) === 4.6 && Math.abs(z) === 4.1 && b.d === 1 ? .4 : 0;
      const cap = Math.abs(x) === 21.4 && Math.abs(z) > 18 && !b.gallery ? .005 : 0;
      const rail = b.minY === 3 && b.w > b.d && b.d === .2 ? b.d : 0;
      boxes.push(masonryBox([x-b.w/2+(x<0?rail:0), b.visualBase ?? b.minY ?? 0, z-b.d/2+(z<0?lap:0)],
        [x+b.w/2-(x>0?rail:0), b.h-cap, z+b.d/2-(z>0?lap:0)]));
    }
  }
  return boxes;
}

// Devuelve los rectángulos de la primera cara que quedan fuera de la segunda.
function subtract(rect, left, bottom, right, top) {
  const [x, y, X, Y] = rect;
  left = Math.max(left,x); bottom = Math.max(bottom,y);
  right = Math.min(right,X); top = Math.min(top,Y);
  if (left >= right || bottom >= top) return [rect];
  const out = [];
  if (x < left) out.push([x,y,left,Y]);
  if (right < X) out.push([right,y,X,Y]);
  if (y < bottom) out.push([left,y,right,bottom]);
  if (top < Y) out.push([left,top,right,Y]);
  return out;
}

export function exposedMasonry(boxes, emit) {
  // Índice en planta. También las piezas que cruzan un límite de celda se
  // encuentran con su vecina cuando ambas terminan exactamente en ese límite.
  const bins = new Map();
  function cells(box) {
    const keys = [];
    for (let x = Math.floor(box.min[0]/3); x <= Math.floor(box.max[0]/3); x++)
      for (let z = Math.floor(box.min[2]/3); z <= Math.floor(box.max[2]/3); z++) keys.push(x+','+z);
    return keys;
  }
  for (const [i, box] of boxes.entries()) for (const key of cells(box)) {
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(i);
  }
  for (const [i, box] of boxes.entries()) {
    if (box.material === null) continue;
    const near = new Set(cells(box).flatMap(key => bins.get(key)));
    near.delete(i);
    const neighbors = [...near].filter(j => boxes[j].min.every((v,k) =>
      v <= box.max[k] && boxes[j].max[k] >= box.min[k]));
    for (let k = 0; k < 3; k++) for (const sign of [-1,1]) {
      const u = (k+1)%3, v = (k+2)%3, plane = (sign > 0 ? box.max : box.min)[k];
      let rects = [[box.min[u], box.min[v], box.max[u], box.max[v]]];
      for (const j of neighbors) {
        const other = boxes[j];
        if (other.min[k] > plane || other.max[k] < plane) continue;
        // En un empate exterior prevalece la última pieza (la moldura).
        if ((sign>0 ? other.max : other.min)[k] === plane && j < i) continue;
        rects = rects.flatMap(r => subtract(r,other.min[u],other.min[v],other.max[u],other.max[v]));
        if (!rects.length) break;
      }
      for (const [x,y,X,Y] of rects) {
        const quad = [[x,y],[X,y],[X,Y],[x,Y]].map(([a,b]) => {
          const p = []; p[k]=plane; p[u]=a; p[v]=b; return p;
        });
        if (sign < 0) quad.reverse();
        const normal = [0,0,0]; normal[k] = sign;
        emit(box.material, quad, normal);
      }
    }
  }
}

export function masonryBuffers(boxes) {
  const buffers = new Map();
  exposedMasonry(boxes, (material, quad, normal) => {
    if (!buffers.has(material)) buffers.set(material, {position:[], normal:[], index:[]});
    const b = buffers.get(material), first = b.position.length/3;
    for (const p of quad) { b.position.push(...p); b.normal.push(...normal); }
    b.index.push(first,first+1,first+2,first,first+2,first+3);
  });
  return buffers;
}

// Recorta el lote del muro conservando las coordenadas del sillar original.
// Así la junta sigue en el mismo sitio al pasar de la jamba al dintel.
export function clipMasonryBatch(batch, neighbors) {
  const sides = batch.sides, tops = batch.tops;
  sides.idx = []; tops.idx = [];
  exposedMasonry([...neighbors,...batch.solids], (face, quad, n) => {
    const target = n[1] ? tops : sides;
    if (n[1] < 0 && !face.bottom) return;
    const start = n[1] ? face.top + (n[1]<0 ? 4 : 0) :
      face.side + (n[0]>0 ? 0 : n[0]<0 ? 4 : n[2]>0 ? 8 : 12);
    const origin = target.pos.slice(start*3,start*3+3);
    const edge = (j) => target.pos.slice((start+j)*3,(start+j)*3+3).map((x,k)=>x-origin[k]);
    const a = edge(1), b = edge(3);
    const u = a.findIndex(x=>x!==0), v = b.findIndex(x=>x!==0);
    const indices = [];
    for (const p of quad) {
      const s = (p[u]-origin[u])/a[u], t = (p[v]-origin[v])/b[v];
      const corner = value => Math.abs(value)<1e-5 ? 0 : Math.abs(value-1)<1e-5 ? 1 : -1;
      const i = corner(s), j = corner(t);
      if (i>=0 && j>=0) indices.push(start+(j ? 3-i : i));
      else {
        indices.push(target.count++);
        target.pos.push(...p);target.norm.push(...n);
        for (const [attr,size] of [['uv',2],['color',3],['box',4],['meta',2]]) {
          const data=target[attr], index=start*size;
          for (let k=0;k<size;k++) {
            const base=data[index+k];
            data.push(base+s*(data[index+size+k]-base)+t*(data[index+3*size+k]-base));
          }
        }
      }
    }
    const [i,j,k,l]=indices;target.idx.push(i,j,k,i,k,l);
  });
}
