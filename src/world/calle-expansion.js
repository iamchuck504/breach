// Shared dimensions for Calle #2. The original avenue is never mutated.
export const CALLE_2 = Object.freeze({
  fx: 29, fz: 42, streetHalfWidth: 17,
  portalZ: 18, portalHalf: 2.2, innerX: 21.55, laneX: 25,
});

// These props use the same dimensions for rendering and authority collision.
export const SIDE_PROPS = Object.freeze([
  { kind: 'dumpster', x: -27, z: -10.5, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'dumpster', x: -27, z: 10.5, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'bench', x: 27, z: -10.5, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'bench', x: 27, z: 10.5, w: 2.8, d: 1.6, h: 1.1 },
  // v2: los callejones guardan ahora las cajas de munición. Pilas a media
  // altura junto al muro interior permiten acercarse al centro del callejón
  // sin recorrer 15 m al descubierto.
  { kind: 'pallets', x: -23.0, z: -6.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'pallets', x: -23.0, z: 6.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'toolchest', x: 23.0, z: -6.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'toolchest', x: 23.0, z: 6.4, w: 1.6, d: 1.4, h: 1.9 },
]);

// Piezas v2 de la avenida: una sola fuente para colisión (collision-layouts)
// y dibujo (maps-v2-art). El espejo (-x,-z) crea la pareja del otro equipo.
export const CALLE_2_V2 = Object.freeze({
  trailer: Object.freeze({ x: 10.4, z: -15.5, w: 2.6, d: 5 }),
  adPanels: Object.freeze([Object.freeze({ x: 13.9, z: 0, w: 2.0, d: 0.36, h: 3 })]),
});

// One placement source for visual vehicles AND all their collision tiers.
// Keep the spawn shields; stage cover before the portals rather than in them.
export const CALLE_2_VEHICLE_MOVES = Object.freeze([
  { from: [6.5,-21], to: [8.8,-26] },
  { from: [-6.5,-16], to: [-9.4,-22] },
  { from: [3,-10.5], to: [4,-14] },
  { from: [-3,-5.5], to: [-8.3,-10] },
]);
export function calle2VehiclePosition(x,z) {
  for(const {from,to} of CALLE_2_VEHICLE_MOVES)for(const side of [1,-1]) {
    if(x===from[0]*side && z===from[1]*side)return [to[0]*side,to[1]*side];
  }
  return [x,z];
}
export function calle2FurnitureZ(x,z) {
  return [12.45,12.9,14.9].includes(Math.abs(x))&&Math.abs(z)>16&&Math.abs(z)<19.1
    ? z+Math.sign(z)*4 : z;
}
export function calle2AccessOffset(key) {
  if(key?.startsWith('kiosk:')){
    const side=key.endsWith('right')?1:-1;
    return [-side*1.05,key.includes(':hotdog:')?-side*4:0];
  }
  if(key?.startsWith('busShelter:')){
    const side=key.endsWith('right')?1:-1;
    return [-side*1.05,side*.5];
  }
  return [0,0];
}

// Shopfront relief on the avenue side of the building strips. The drawn
// facade stands .23-.40 m proud of the structural wall (|x| = 16.15); a .30 m
// skin makes bullets, grenades and the camera stop where the frames are seen.
// It carries no cover faces: cover, body stand-off and peek margins stay on
// the structural wall. Shop windows count too: their glass pane sits .33 m
// proud. Spans below are where the facade is flush with the wall (service
// doors, building ends), measured on the drawn meshes and guarded by
// scripts/audit-hitboxes.mjs; the skin is left out there.
export const SHOP_SKIN = Object.freeze({ depth: .30, h: 3 });
const SHOP_STRIPS = [[-42,-20.2],[-15.8,15.8],[20.2,42]];
const SHOP_RECESS = [[-42,-41.78],[-30.22,-27.78],[-8.22,-7.68],[7.68,8.22],[27.78,30.22],[41.78,42]];
export function shopSkinSpans() {
  const holes=SHOP_RECESS;
  const out=[];
  for(const [a,b] of SHOP_STRIPS){
    let from=a;
    for(const [h0,h1] of holes){
      if(h1<=from||h0>=b)continue;
      if(h0>from)out.push([from,h0]);
      from=Math.max(from,h1);
    }
    if(from<b)out.push([from,b]);
  }
  return out;
}

export function expansionBoxes() {
  const out = [];
  const add = (x,z,w,d,h,cover=false,kind='wall') => out.push({
    x,z,w,d,h,style:'expansion',mirror:false,visual:false,cover,
    surface:['wall','wall-cover','building','outer-facade','shop-frame'].includes(kind)?'concrete':'metal',expansionKind:kind,
  });
  const wall=(x,z,w,d)=>{
    add(x,z,w,d,3,true,'wall-cover');
    add(x,z,w,d,4.4,false,'wall');
  };
  // Three solid building strips per side, interrupted only at the portals.
  for (const side of [-1,1]) {
    for (const [a,b,h] of [[-42,-20.2,9.25],[-15.8,15.8,7.3],[20.2,42,9.35]]) {
      add(side*18.85,-side*(a+b)/2,5.4,b-a,h,false,'building');
      add(side*18.85,-side*(a+b)/2,5.4,b-a,3,true,'wall-cover');
    }
    for (const [a,b] of shopSkinSpans())
      add(side*(16.15-SHOP_SKIN.depth/2),(a+b)/2,SHOP_SKIN.depth,b-a,SHOP_SKIN.h,false,'shop-frame');
    // Closed ends stop lateral routes from reaching the spawn pockets.
    for (const dir of [-1,1]) wall(side*25.275,dir*20.6,7.45,.8);
    wall(side*29.4,0,.8,42);
    // Fill inaccessible outer corners. Visual rear buildings explain them.
    for (const dir of [-1,1]) add(side*25.275,dir*31.5,7.45,21,10,false,'building');
    for(const z of [-30,-18,-6,6,18,30])add(side*31.7,z,5.4,11.7,9.25,false,'outer-facade');
  }
  for(const p of SIDE_PROPS) add(p.x,p.z,p.w,p.d,p.h,true,p.kind);
  // Parked cars use the proven sedan collision tiers from the avenue.
  for(const side of [-1,1]) {
    add(side*22.9,0,2.32,4.76,1.1,true,'car');
    add(side*22.9,.15,2.24,2.2,1.47,false,'car-tier');
    add(side*22.9,.15,2.0,1.34,1.57,false,'car-tier');
  }
  for(const x of [21.75,24.3]) add(x,0,.30,.30,2.9,false,'lift');
  return out;
}
