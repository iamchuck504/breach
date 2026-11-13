// Shared dimensions for Calle #2. The original avenue is never mutated.
export const CALLE_2 = Object.freeze({
  fx: 40, fz: 42, streetHalfWidth: 17,
  portalZ: 18, portalHalf: 2.2, innerX: 21.55, laneX: 25,
});

// ================= CALLE CERRADA v3: EL CRUCE =================
// La avenida deja de ser un pasillo con dos callejones ciegos:
//  · CALLE TRANSVERSAL en z 0: se derriban los dos edificios centrales y
//    queda un cruce de 16,4 m de ancho que llega hasta el fondo de cada patio.
//  · PATIOS DE MANZANA: cada callejón se abre a un patio nuevo (x 29,8..40):
//    estacionamiento con andén de carga al oeste, taller bajo marquesina al
//    este. El muro que los separaba queda como espina con tres pasos.
//  · PATIO TRASERO del spawn: el edificio de la esquina derecha de cada equipo
//    desaparece y deja una salida lateral que entra al callejón por detrás.
// Todo en coordenadas del lado oeste; el este es su giro de 180°.
export const CALLE_3 = Object.freeze({
  cross: 8.2,            // semiancho de la calle transversal (entre edificios)
  yardX: 40,             // cara interior del muro exterior de los patios
  spine: Object.freeze([9, 17]),      // tramo de muro entre callejón y patio
  // franjas de edificios del lado oeste: [z0, z1, alto]
  strips: Object.freeze([[-27.8, -20.2, 9.25], [-15.8, -8.2, 7.3], [8.2, 15.8, 7.3], [20.2, 42, 9.35]]),
  backGate: Object.freeze([25.6, 29.0]), // puerta del patio trasero al callejón (|x|)
  dock: Object.freeze({ x: -38.2, z: 0, w: 3.2, d: 6 }),
  canopy: Object.freeze({ x: 35, z: -12.5, w: 8.8, d: 9, minY: 4.2, h: 4.42, posts: Object.freeze([[31.4, -16.2], [31.4, -8.8], [38.6, -16.2], [38.6, -8.8]]) }),
  cars: Object.freeze([[-36.4, -12.6], [-32.2, -16.4], [36.4, -12.5]]),
});

// These props use the same dimensions for rendering and authority collision.
export const SIDE_PROPS = Object.freeze([
  // v3: el del lado del auto estacionado baja hasta el final del tramo; juntos
  // dejaban 1,5 m de paso y los bots preferían rodear por la avenida
  { kind: 'dumpster', x: -27, z: -15, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'dumpster', x: -27, z: 10.5, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'bench', x: 27, z: -10.5, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'bench', x: 27, z: 15, w: 2.8, d: 1.6, h: 1.1 },
  // v2: los callejones guardan ahora las cajas de munición. Pilas a media
  // altura junto al muro interior permiten acercarse al centro del callejón
  // sin recorrer 15 m al descubierto.
  { kind: 'pallets', x: -23.0, z: -6.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'pallets', x: -23.0, z: 6.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'toolchest', x: 23.0, z: -6.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'toolchest', x: 23.0, z: 6.4, w: 1.6, d: 1.4, h: 1.9 },
  // v3 — patios de manzana
  { kind: 'pallets', x: -38.4, z: -8.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'pallets', x: 38.4, z: 8.4, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'dumpster', x: -31.4, z: -4.6, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'dumpster', x: 31.4, z: 4.6, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'toolchest', x: 32.2, z: -12.5, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'toolchest', x: -32.2, z: 12.5, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'bench', x: 34.4, z: -4.4, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'bench', x: -34.4, z: 4.4, w: 2.8, d: 1.6, h: 1.1 },
  // brazos de la calle transversal: 14 m de asfalto entre la avenida y el patio
  { kind: 'dumpster', x: -18.6, z: 3.2, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'dumpster', x: 18.6, z: -3.2, w: 2.8, d: 1.6, h: 1.1 },
  { kind: 'pallets', x: -25.6, z: -2.8, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'pallets', x: 25.6, z: 2.8, w: 1.6, d: 1.4, h: 1.9 },
  // patio trasero del spawn (esquina derecha de cada equipo)
  { kind: 'dumpster', x: -27.2, z: -30.2, w: 1.6, d: 2.8, h: 1.1 },
  { kind: 'dumpster', x: 27.2, z: 30.2, w: 1.6, d: 2.8, h: 1.1 },
  { kind: 'pallets', x: -23.2, z: -38.6, w: 1.6, d: 1.4, h: 1.9 },
  { kind: 'pallets', x: 23.2, z: 38.6, w: 1.6, d: 1.4, h: 1.9 },
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
  // v3: la jardinera y el carrito de café quedaban justo en las esquinas de
  // la calle transversal (z ±8.2), tapando el paso y el asomarse. Se corren
  // 3,6 m hacia el centro de su fachada.
  if(Math.abs(x)>13.5&&Math.abs(x)<16.5&&Math.abs(z)>=6.7&&Math.abs(z)<=9.3)return z+Math.sign(z)*3.6;
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
const SHOP_STRIPS = CALLE_3.strips.map(([a,b])=>[a,b]);
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
  // side -1 = oeste tal cual; side +1 = su giro de 180° (x y z cambian de signo)
  const C = CALLE_3;
  for (const side of [-1,1]) {
    const X = (x) => -side*x, Z = (z) => -side*z;
    // Franjas de edificios: cuatro por lado, cortadas por los dos portales, la
    // calle transversal y la salida lateral del spawn.
    for (const [a,b,h] of C.strips) {
      add(X(-18.85),Z((a+b)/2),5.4,b-a,h,false,'building');
      add(X(-18.85),Z((a+b)/2),5.4,b-a,3,true,'wall-cover');
    }
    for (const [a,b] of shopSkinSpans())
      add(X(-(16.15-SHOP_SKIN.depth/2)),Z((a+b)/2),SHOP_SKIN.depth,b-a,SHOP_SKIN.h,false,'shop-frame');
    // CALLEJÓN: cerrado al norte; al sur, la puerta del patio trasero.
    wall(X(-25.275),Z(20.6),7.45,.8);
    wall(X(-(21.55+C.backGate[0])/2),Z(-20.6),C.backGate[0]-21.55,.8);
    // ESPINA entre callejón y patio: dos tramos, tres pasos.
    for (const dir of [-1,1]) wall(X(-29.4),Z(dir*(C.spine[0]+C.spine[1])/2),.8,C.spine[1]-C.spine[0]);
    // PATIO DE MANZANA: muro exterior y cierres norte y sur.
    wall(X(-(C.yardX+.4)),0,.8,42);
    for (const dir of [-1,1]) wall(X(-(29.0+C.yardX+.8)/2),Z(dir*20.6),C.yardX+.8-29.0,.8);
    // PATIO TRASERO del spawn (esquina suroeste): muro exterior y fondo.
    wall(X(-29.4),Z(-31.9),.8,21.8);
    wall(X(-23.65),Z(-42.4),11.5,.8);
    // la esquina noroeste sigue maciza
    add(X(-25.275),Z(31.5),7.45,21,10,false,'building');
    // fachadas de fondo, detrás de cada muro
    for (const z of [-30,30]) add(X(-31.7),Z(z),5.4,11.7,9.25,false,'outer-facade');
    for (const z of [-18,-6,6,18]) add(X(-(C.yardX+3.5)),Z(z),5.4,11.7,9.25,false,'outer-facade');
  }
  for(const p of SIDE_PROPS) add(p.x,p.z,p.w,p.d,p.h,true,p.kind);
  // Autos estacionados: los mismos pisos de colisión que el sedán de la avenida.
  const car=(x,z)=>{
    add(x,z,2.32,4.76,1.1,true,'car');
    add(x,z+Math.sign(x)*.15,2.24,2.2,1.47,false,'car-tier');
    add(x,z+Math.sign(x)*.15,2.0,1.34,1.57,false,'car-tier');
  };
  for (const [x,z] of [[-22.9,-12.2],...C.cars]) { car(x,z); car(-x,-z); }
  // TALLER: marquesina sobre cuatro postes. Se pasa por debajo; para las
  // balas es techo. Solo existe en la mitad sur del patio este y su giro.
  for (const s of [1,-1]) {
    for (const [x,z] of C.canopy.posts) add(s*x,s*z,.5,.5,C.canopy.minY,false,'post');
    out.push({ x:s*C.canopy.x, z:s*C.canopy.z, w:C.canopy.w, d:C.canopy.d, h:C.canopy.h, minY:C.canopy.minY,
      style:'expansion', mirror:false, visual:false, cover:false, surface:'metal', expansionKind:'canopy' });
  }
  // elevador de taller en cada callejón (antes solo al este: desviaba la ruta
  // de un equipo 1,5 m más que la del otro)
  for(const s of [1,-1])for(const x of [21.75,24.3]) add(s*x,s*12.2,.30,.30,2.9,false,'lift');
  return out;
}
