// PLANO DE LA CIUDAD alrededor de Azoteas: una cuadrícula ortogonal
// alineada con los ejes del mapa. Las tres azoteas jugables son tres
// edificios vecinos de UNA manzana (x ±53.2, z ±40.8), separados por los
// callejones que el mapa ya tiene (los vacíos con puentes).
//
//   avenidas (corren a lo largo de z): |x| 53.2..75.2 (22 m) y 125..141 (16 m)
//   calles   (corren a lo largo de x): |z| 40.8..56.8 (16 m) y 110..126 (16 m)
//   manzanas: columnas x [-185,-141] [-125,-75.2] [-53.2,53.2] [75.2,125] [141,185]
//             filas    z [-170,-126] [-110,-56.8] [-40.8,40.8] [56.8,110] [126,170]
//
// Cada manzana es de borde cerrado: edificios de fondo 16 m que comparten
// medianeras y dan a la calle, con patio interior. Las alturas van por
// plantas (3.2 m) y se parecen entre vecinos: 4-7 plantas cerca, y el
// centro de negocios (torres) se agrupa al NORESTE. La calle está a y = -8;
// el techo de las azoteas, a y = 0.
//
// Lo leen ./city.js (edificios, techos, balizas), ./signs.js (los cuatro
// letreros van sobre edificios de aquí) y ./atmos.js (vapor de chimeneas
// reales). Determinista: mismo plano en cada cliente.
export const STREET_Y = -8;
const FLOOR_H = 3.2, PARAPET = 0.9;
export const COLS = [[-185, -141], [-125, -75.2], [-53.2, 53.2], [75.2, 125], [141, 185]];
export const ROWS = [[-170, -126], [-110, -56.8], [-40.8, 40.8], [56.8, 110], [126, 170]];
// centros y medios anchos de las calles (para el asfalto de ./surfaces.js)
export const AVENUES = [[64.2, 11], [133, 8]];
export const STREETS = [[48.8, 8], [118, 8]];

const top = (floors) => STREET_Y + floors * FLOOR_H + PARAPET;

// Letreros: el edificio que los lleva tiene altura fija (el resto del plano
// se genera alrededor). Cada uno da a una calle o avenida.
export const HOSTS = {
  velarde: { x: 76, z: 10, floors: 6 },        // azotea frente a la avenida este
  billboard: { x: -14, z: -57.5, floors: 4 },  // azotea frente a la calle sur
  hotel: { x: -44, z: 57.5, floors: 10 },      // fachada alta sobre la calle norte
  meridiano: { x: -76, z: -14, floors: 9 },    // remate de oficinas, avenida oeste
};

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cached = null;
export function planCity() {
  if (cached) return cached;
  const rnd = mulberry(0x5a0e7e4);
  const buildings = [];
  const add = (x0, x1, z0, z1, floors, kind = 'mid') => {
    buildings.push({ x0, x1, z0, z1, floors, top: top(floors), kind, seed: rnd() });
  };
  // altura base por manzana: sube hacia el noreste (el centro)
  const baseFloors = (cx, cz) => {
    const d = Math.max(0, (cx + cz) / 2 - 20);
    return Math.min(14, 4 + Math.floor(d / 22) + Math.floor(rnd() * 2));
  };
  // reparte un tramo [a, b] en solares de 10-18 m (el último absorbe el resto)
  const cut = (a, b) => {
    const out = [];
    let s = a;
    while (b - s > 0.1) {
      let w = 10 + rnd() * 8;
      if (b - (s + w) < 9) w = b - s;
      out.push([s, s + w]);
      s += w;
    }
    return out;
  };
  for (const [x0, x1] of COLS) for (const [z0, z1] of ROWS) {
    if (x0 === -53.2 && z0 === -40.8) continue; // nuestra manzana
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const base = baseFloors(cx, cz);
    // centro de negocios: torres sueltas en una plaza, no manzana cerrada
    if (base >= 7) {
      for (const [a, b] of [[0.12, 0.45], [0.55, 0.88]]) for (const [c, e] of [[0.1, 0.42], [0.58, 0.9]]) {
        const fl = base + 4 + Math.floor(rnd() * 12);
        add(x0 + (x1 - x0) * a, x0 + (x1 - x0) * b, z0 + (z1 - z0) * c, z0 + (z1 - z0) * e, fl, 'tower');
      }
      continue;
    }
    const d = 16;
    const lotFloors = () => Math.max(3, base + Math.round(rnd() * 2 - 1));
    for (const [a, b] of cut(x0, x1)) {
      add(a, b, z1 - d, z1, lotFloors());
      add(a, b, z0, z0 + d, lotFloors());
    }
    for (const [a, b] of cut(z0 + d, z1 - d)) {
      add(x0, x0 + d, a, b, lotFloors());
      add(x1 - d, x1, a, b, lotFloors());
    }
  }
  // los edificios de los letreros: su altura manda
  const hosts = {};
  for (const [name, h] of Object.entries(HOSTS)) {
    const b = buildings.find((q) => h.x >= q.x0 && h.x <= q.x1 && h.z >= q.z0 && h.z <= q.z1);
    if (b) { b.floors = h.floors; b.top = top(h.floors); b.host = name; hosts[name] = b; }
  }
  // chimeneas de vapor reales: en algunos techos cercanos
  const stacks = [];
  for (const b of buildings) {
    const near = Math.max(Math.abs((b.x0 + b.x1) / 2), Math.abs((b.z0 + b.z1) / 2)) < 100;
    if (near && !b.host && b.seed < 0.12) stacks.push([b.x0 + (b.x1 - b.x0) * 0.3, b.top + 1.6, b.z0 + (b.z1 - b.z0) * 0.6]);
  }
  cached = { buildings, hosts, stacks };
  return cached;
}
