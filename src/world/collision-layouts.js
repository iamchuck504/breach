// Geometría jugable compartida entre World (cliente) y la autoridad online.
// Estas cajas son la fuente única para movimiento, cover y línea de tiro.
import { BLOCK } from './block-heights.js';

const { LOW, MID, HIGH } = BLOCK;
const make = (x, z, w, d, h, style, options = {}) =>
  Object.freeze({ x, z, w, d, h, style, ...options });
const freeze = (items) => Object.freeze(items.map(Object.freeze));

const fortaleza = freeze([
  make(0, -27, 44, 0.8, HIGH, 'wall', { mirror: false }),
  make(0, 27, 44, 0.8, HIGH, 'wall', { mirror: false }),
  make(-21.4, 0, 0.8, 55.2, HIGH, 'wall', { mirror: false }),
  make(21.4, 0, 0.8, 55.2, HIGH, 'wall', { mirror: false }),
  make(0, -20.9, 8, 1, HIGH, 'high'),
  make(-6, -20.2, 2.6, 0.9, LOW, 'low'),
  make(6, -20.2, 2.6, 0.9, LOW, 'low'),
  make(-8.5, -16, 5, 1, MID, 'mid'),
  make(5.5, -17, 3, 3, LOW, 'low'),
  make(-14.5, -12, 1, 6.5, HIGH, 'high'),
  make(-17.5, -8.5, 1.8, 0.9, LOW, 'low'),
  make(11.5, -12.5, 1, 5, HIGH, 'high'),
  make(9.5, -10.5, 3, 1, HIGH, 'high'),
  make(-2, -11, 2.6, 0.9, LOW, 'low'),
  make(2.5, -8.5, 2.6, 0.9, LOW, 'low'),
  make(-1.5, -6, 2.6, 0.9, LOW, 'low'),
  make(7, -6, 1.2, 1.2, HIGH, 'high'),
  make(-11, -5, 1.2, 1.2, HIGH, 'high'),
  make(-19, -3.5, 1.6, 0.9, LOW, 'low'),
  make(18.5, -6, 0.9, 2.4, LOW, 'low'),
  make(5, -2.5, 3.2, 0.9, MID, 'mid'),
  make(-8.5, -1.5, 2.4, 2.4, LOW, 'low'),
  make(0, 0, 1.8, 1.8, HIGH, 'high', { mirror: false, top: 0xffb075 }),
  make(-5.5, 0.6, 0.9, 2.4, LOW, 'low'),
]);

const azoteas = freeze([
  make(0, -40.4, 65, 0.8, HIGH, 'wall', { mirror: false }),
  make(0, 40.4, 65, 0.8, HIGH, 'wall', { mirror: false }),
  make(-31.9, 0, 0.8, 82, HIGH, 'wall', { mirror: false }),
  make(31.9, 0, 0.8, 82, HIGH, 'wall', { mirror: false }),
  make(0, -31.35, 8, 1.2, HIGH, 'hut'),
  make(-8.2, -27.7, 4, 2.2, LOW, 'ac'),
  make(11.5, -22.8, 3.8, 3.8, LOW, 'glass'),
  make(-12.2, -22.1, 5.6, 1.1, MID, 'hut'),
  make(-26.3, -31.5, 6, 4, LOW, 'ac'),
  // AUDITORÍA de hitboxes: las tapas/rejillas visuales de AC, vents y la
  // caseta MID sobresalen 10-15cm de su caja — un tiro rasante por encima
  // atravesaba la tapa visible. Tapas 'solid' (sin cover: no son bloques
  // jugables, la regla LOW/MID/HIGH no aplica, como las cabinas de autos).
  make(-26.3, -31.5, 5.9, 3.9, 1.26, 'ac', { visual: false, cover: false }),
  make(26, -31.5, 5.5, 2.6, MID, 'hut'),
  make(26, -31.5, 5.4, 2.5, 2.06, 'hut', { visual: false, cover: false }),
  make(-27, -23.5, 1.4, 5, LOW, 'vent'),
  make(27, -23.2, 4, 1.4, LOW, 'vent'),
  make(27, -23.2, 3.9, 1.3, 1.26, 'vent', { visual: false, cover: false }),
  make(-20.25, -15.75, 2.8, 2.8, HIGH, 'hut'),
  make(-25, -6.8, 2.4, 6.2, MID, 'hut'),
  make(-25, -6.8, 1.7, 1.7, HIGH, 'hut', { visual: false }),
  make(-2, -15.6, 5.5, 2.5, LOW, 'ac'),
  make(-4, -9.5, 3.6, 1.4, LOW, 'ac', { visual: false }),
  make(18, -14, 1.1, 5.2, HIGH, 'hut'),
  make(25.2, -17.2, 1.1, 3, LOW, 'vent'),
  make(27.2, -7.2, 3, 1.1, LOW, 'vent'),
  make(9.6, -4.3, 4.2, 1.1, MID, 'hut'),
  make(-9.3, -5.2, 3, 2.6, LOW, 'ac'),
]);

function calleSpecs() {
  const out = [
    make(0, -42.4, 36, 0.8, HIGH, 'wall', { mirror: false, visual: false }),
    make(0, 42.4, 36, 0.8, HIGH, 'wall', { mirror: false, visual: false }),
    // AUDITORÍA de hitboxes: las fachadas laterales empiezan en x ±16.15 —
    // el muro en ±17.4 dejaba 0.85m de calle DENTRO del edificio visual
    // (se caminaba y disparaba dentro de la fachada, decals flotando).
    make(-16.55, 0, 0.8, 86, HIGH, 'wall', { mirror: false }),
    make(16.55, 0, 0.8, 86, HIGH, 'wall', { mirror: false }),
    // BUS atravesado (escudo de spawn): medido 9.35x3.06 con morro/cola
    // bajos que sobresalían del torso — las balas pasaban por las puntas.
    make(0, -34.5, 9.2, 2.92, HIGH, 'high', { visual: false }),
    make(0, -34.5, 9.35, 3.06, LOW, 'low', { visual: false }),
    make(-6.1, -33.4, 2.4, 0.9, LOW, 'low', { visual: false }),
    make(6.1, -33.4, 2.4, 0.9, LOW, 'low', { visual: false }),
    make(-1.2, -8.7, 3.2, 0.9, MID, 'mid', { visual: false }),
    make(-6.5, -1.5, 3.0, 7.15, HIGH, 'high', { visual: false }),
    make(-15.15, -8, 2.5, 2.5, LOW, 'low', { visual: false }),
    make(14.35, -8.5, 1.3, 0.75, LOW, 'low', { visual: false }),
    make(3.6, -2.2, 2.4, 0.9, LOW, 'low', { visual: false }),
  ];

  // VEHÍCULOS con perfiles MEDIDOS contra los meshes reales (auditoría de
  // hitboxes): el sedán procedural mide 2.26x4.76 de cuerpo (la base vieja
  // 2.02x4.45 dejaba pasar balas por defensas y costados) y el SUV GLB
  // lleva capó/portón ALTOS a lo largo de todo el cuerpo (los pisos cortos
  // centrados dejaban pasar tiros por el morro y la cola, decals en la
  // fachada de la panadería a través del auto). La base LOW conserva el
  // cover táctico; los pisos 'solid' no crean caras nuevas.
  const addVehicle = (x, z, { rotated = false, suv = false } = {}) => {
    const swap = (w, d) => rotated ? [d, w] : [w, d];
    const [bodyW, bodyD] = swap(suv ? 1.74 : 2.26, suv ? 4.5 : 4.76);
    out.push(make(x, z, bodyW, bodyD, LOW, 'low', { visual: false }));
    const tiers = suv
      ? [
        [2.06, 4.5, 1.5],   // capó/portón/espejos: alto en TODO el largo
        [1.72, 2.0, 2.0],   // techo (corto: el portón cae en pendiente)
      ]
      : [
        [2.26, 4.76, 1.0],  // cuerpo completo hasta el cinturón
        [2.08, 2.5, 1.3],   // cabina baja (parabrisas/medallón en pendiente)
        [2.0, 1.34, 1.57],  // techo
      ];
    for (const [width, length, height] of tiers) {
      const [w, d] = swap(width, length);
      out.push(make(x, z, w, d, height, 'solid', {
        visual: false, mirror: true,
      }));
    }
  };
  addVehicle(-2.5, -28, { suv: true });
  addVehicle(6.5, -21);
  addVehicle(-6.5, -16);
  addVehicle(3, -10.5);
  addVehicle(-3, -5.5, { rotated: true });

  // Un kiosco abierto no puede compartir el cubo HIGH que ocupaba toda su
  // huella. Se modelan únicamente respaldo, laterales, postes y mostrador;
  // el hueco de servicio permanece físicamente transitable y visible.
  // Kioscos: huella MEDIDA contra el mesh (news 1.93x2.31, hotdog 1.83x2.21,
  // centro corrido 0.19 hacia atrás) — el visual sobresalía del spec y las
  // balas entraban por los costados. El hueco de servicio sigue transitable.
  const addKiosk = (x, z, w, d, toward, decorLink) => {
    const frontZ = z + toward * (d / 2 - 0.034);
    const backZ = z - toward * (d / 2 - 0.055);
    // costados casi completos (el panel lateral del kiosco corre a lo largo;
    // solo el frente queda abierto como hueco de servicio)
    const sideZ = z - toward * d * 0.06;
    const linked = { visual: false, mirror: false, decorLink };
    out.push(make(x, backZ, w - 0.10, 0.11, 2.30, 'shelter', linked));
    for (const side of [-1, 1]) {
      out.push(make(x + side * (w / 2 - 0.05), sideZ,
        0.10, d * 0.8, 2.28, 'shelter', linked));
      out.push(make(x + side * (w / 2 - 0.055), frontZ,
        0.14, 0.14, 2.46, 'solid', linked));
    }
    out.push(make(x, frontZ, w - 0.16, 0.18, LOW, 'low', linked));
  };
  addKiosk(-14.35, -28.81, 1.93, 2.31, 1, 'kiosk:news:south-left');
  addKiosk(14.35, 28.81, 1.93, 2.31, -1, 'kiosk:news:north-right');
  addKiosk(14.35, -25.81, 1.83, 2.21, 1, 'kiosk:hotdog:south-right');
  addKiosk(-14.35, 25.81, 1.83, 2.21, -1, 'kiosk:hotdog:north-left');
  for (const z of [-35, -25, -15, -5, 5, 15, 25, 35]) {
    // poste real medido: 0.2 de grosor con cara en ±12.69 — más grueso era
    // pared invisible y los decals del borde se suprimían por caer en aire
    out.push(make(-12.6, z, 0.22, 0.22, 6.2, 'solid', {
      mirror: false, decorLink: `streetlight:left:${z}`,
    }));
    out.push(make(12.6, z, 0.22, 0.22, 6.2, 'solid', {
      mirror: false, decorLink: `streetlight:right:${z}`,
    }));
  }
  out.push(make(-12.45, -11, 0.46, 0.46, 0.68, 'solid', {
    mirror: false, decorLink: 'hydrant:left',
  }));
  out.push(make(12.45, 11, 0.46, 0.46, 0.68, 'solid', {
    mirror: false, decorLink: 'hydrant:right',
  }));
  // Parada de bus: el GLB real ocupa x 13.72..14.98 (los costados del spec
  // arrancaban en 13.88 — 16cm de marquesina/lateral penetrables y decals
  // clavados 0.9m adentro). Frente abierto intacto (cover en U).
  for (const [side, z] of [[1, -37], [-1, 37]]) {
    const decorLink = `busShelter:${side > 0 ? 'right' : 'left'}`;
    out.push(make(side * 14.88, z, 0.2, 3.53, 2.45, 'shelter', {
      mirror: false, decorLink,
    }));
    for (const dz of [-1.6, 1.6]) {
      out.push(make(side * 14.35, z + dz, 1.26, 0.5, 2.45, 'shelter', {
        mirror: false, decorLink,
      }));
    }
    // interior del GLB (banca con respaldo + paneles de vidrio a varias
    // alturas): sellado como bloque — la navegación ya estaba bloqueada por
    // la banca y las balas se colaban entre panel y panel
    out.push(make(side * 14.38, z, 1.2, 3.1, 2.45, 'solid', {
      mirror: false, decorLink,
    }));
  }
  return freeze(out);
}

const calle = calleSpecs();
export const COLLISION_LAYOUTS = Object.freeze({ fortaleza, azoteas, calle });

export const HELIPAD = Object.freeze({
  height: LOW,
  radius: 6.2,
  edge: 6.2 * Math.cos(Math.PI / 8),
  diagonal: 6.2 * (Math.cos(Math.PI / 8) + Math.sin(Math.PI / 8)),
  rampLength: 5,
  rampHalfWidth: 1.55,
});

export function collisionBoxesFor(layout) {
  return COLLISION_LAYOUTS[layout] || Object.freeze([]);
}

export function expandedCollisionBoxes(layout) {
  const out = [];
  const place = (box, x, z) => out.push({
    minx: x - box.w / 2, maxx: x + box.w / 2,
    minz: z - box.d / 2, maxz: z + box.d / 2,
    h: box.h,
  });
  for (const box of collisionBoxesFor(layout)) {
    place(box, box.x, box.z);
    if (box.mirror !== false && (box.x !== 0 || box.z !== 0)) place(box, -box.x, -box.z);
  }
  return out;
}

export function helipadSegments() {
  const verts = Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + i * Math.PI / 4;
    return { x: Math.sin(a) * HELIPAD.radius, z: Math.cos(a) * HELIPAD.radius };
  });
  const out = [];
  const add = (a, b) => {
    const tx = b.x - a.x, tz = b.z - a.z;
    const len = Math.hypot(tx, tz); if (len < 0.05) return;
    out.push({ a, b, n: { x: -tz / len, z: tx / len }, half: 0.08,
      h: HELIPAD.height + LOW });
  };
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const rampSide = Math.abs(a.z - b.z) < 0.01 && Math.abs(a.z) > HELIPAD.edge - 0.05;
    if (!rampSide) { add(a, b); continue; }
    const z = a.z;
    if (a.x < b.x) {
      add(a, { x: -HELIPAD.rampHalfWidth, z });
      add({ x: HELIPAD.rampHalfWidth, z }, b);
    } else {
      add(a, { x: HELIPAD.rampHalfWidth, z });
      add({ x: -HELIPAD.rampHalfWidth, z }, b);
    }
  }
  return out;
}
