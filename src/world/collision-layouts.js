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
  make(26, -31.5, 5.5, 2.6, MID, 'hut'),
  make(-27, -23.5, 1.4, 5, LOW, 'vent'),
  make(27, -23.2, 4, 1.4, LOW, 'vent'),
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
    make(-17.4, 0, 0.8, 86, HIGH, 'wall', { mirror: false }),
    make(17.4, 0, 0.8, 86, HIGH, 'wall', { mirror: false }),
    make(0, -34.5, 9, 2.5, HIGH, 'high', { visual: false }),
    make(-6.1, -33.4, 2.4, 0.9, LOW, 'low', { visual: false }),
    make(6.1, -33.4, 2.4, 0.9, LOW, 'low', { visual: false }),
    // Los vehículos conservan una base LOW para cover/mantle. La cabina se
    // añade debajo como collider sólido sin caras de cover: así los disparos
    // no atraviesan el techo, pero tampoco convertimos el auto completo en
    // una caja invisible de 1.5–2 m sobre capó y maletero.
    make(-2.5, -28, 2.02, 4.45, LOW, 'low', { visual: false }),
    make(-2.5, -28.05, 1.78, 2.82, 2.05, 'solid', { visual: false, mirror: true }),
    make(6.5, -21, 2.02, 4.45, LOW, 'low', { visual: false }),
    make(6.5, -21.08, 1.78, 2.34, 1.52, 'solid', { visual: false, mirror: true }),
    make(-6.5, -16, 2.02, 4.45, LOW, 'low', { visual: false }),
    make(-6.5, -16.08, 1.78, 2.34, 1.52, 'solid', { visual: false, mirror: true }),
    make(3, -10.5, 2.02, 4.45, LOW, 'low', { visual: false }),
    make(3, -10.58, 1.78, 2.34, 1.52, 'solid', { visual: false, mirror: true }),
    make(-3, -5.5, 4.45, 2.02, LOW, 'low', { visual: false }),
    make(-3.08, -5.5, 2.34, 1.78, 1.52, 'solid', { visual: false, mirror: true }),
    make(-1.2, -8.7, 3.2, 0.9, MID, 'mid', { visual: false }),
    make(-6.5, -1.5, 2.4, 7, HIGH, 'high', { visual: false }),
    make(-15.15, -8, 2.5, 2.2, LOW, 'low', { visual: false }),
    make(14.35, -8.5, 1.3, 0.75, LOW, 'low', { visual: false }),
    make(3.6, -2.2, 2.4, 0.9, LOW, 'low', { visual: false }),
  ];

  // Un kiosco abierto no puede compartir el cubo HIGH que ocupaba toda su
  // huella. Se modelan únicamente respaldo, laterales, postes y mostrador;
  // el hueco de servicio permanece físicamente transitable y visible.
  const addKiosk = (x, z, w, d, toward, decorLink) => {
    const frontZ = z + toward * (d / 2 - 0.034);
    const backZ = z - toward * (d / 2 - 0.055);
    const sideZ = z - toward * d * 0.20;
    const linked = { visual: false, mirror: false, decorLink };
    out.push(make(x, backZ, w - 0.10, 0.11, 2.30, 'shelter', linked));
    for (const side of [-1, 1]) {
      out.push(make(x + side * (w / 2 - 0.05), sideZ,
        0.10, d * 0.58, 2.28, 'shelter', linked));
      out.push(make(x + side * (w / 2 - 0.055), frontZ,
        0.14, 0.14, 2.46, 'solid', linked));
    }
    out.push(make(x, frontZ, w - 0.16, 0.18, LOW, 'low', linked));
  };
  addKiosk(-14.35, -29, 1.75, 1.75, 1, 'kiosk:news:south-left');
  addKiosk(14.35, 29, 1.75, 1.75, -1, 'kiosk:news:north-right');
  addKiosk(14.35, -26, 1.65, 1.65, 1, 'kiosk:hotdog:south-right');
  addKiosk(-14.35, 26, 1.65, 1.65, -1, 'kiosk:hotdog:north-left');
  for (const z of [-35, -25, -15, -5, 5, 15, 25, 35]) {
    out.push(make(-12.6, z, 0.5, 0.5, 6.2, 'solid', {
      mirror: false, decorLink: `streetlight:left:${z}`,
    }));
    out.push(make(12.6, z, 0.5, 0.5, 6.2, 'solid', {
      mirror: false, decorLink: `streetlight:right:${z}`,
    }));
  }
  out.push(make(-12.45, -11, 0.46, 0.46, 0.68, 'solid', {
    mirror: false, decorLink: 'hydrant:left',
  }));
  out.push(make(12.45, 11, 0.46, 0.46, 0.68, 'solid', {
    mirror: false, decorLink: 'hydrant:right',
  }));
  for (const [side, z] of [[1, -37], [-1, 37]]) {
    const decorLink = `busShelter:${side > 0 ? 'right' : 'left'}`;
    out.push(make(side * 14.88, z, 0.2, 3.34, 2.45, 'shelter', {
      mirror: false, decorLink,
    }));
    for (const dz of [-1.67, 1.67]) {
      out.push(make(side * 14.43, z + dz, 1.1, 0.18, 2.45, 'shelter', {
        mirror: false, decorLink,
      }));
    }
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
