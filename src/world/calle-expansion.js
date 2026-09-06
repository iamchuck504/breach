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
]);

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

export function expansionBoxes() {
  const out = [];
  const add = (x,z,w,d,h,cover=false,kind='wall') => out.push({
    x,z,w,d,h,style:'expansion',mirror:false,visual:false,cover,
    surface:['wall','wall-cover','building','outer-facade'].includes(kind)?'concrete':'metal',expansionKind:kind,
  });
  const wall=(x,z,w,d)=>{
    add(x,z,w,d,3,true,'wall-cover');
    add(x,z,w,d,4.4,false,'wall');
  };
  // Three solid building strips per side, interrupted only at the portals.
  for (const side of [-1,1]) {
    for (const [a,b,h] of [[-42,-20.2,9.25],[-15.8,15.8,7.3],[20.2,42,9.35]]) {
      add(side*18.85,-side*(a+b)/2,5.4,b-a,h,false,'building');
    }
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
