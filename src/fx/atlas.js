// Atlas procedural de sprites: rejilla 4×4 de celdas de 128 px generada una
// vez al arrancar (portado de Crashterra, src/fx/atlas.ts).
// Canales: R = cobertura, G = núcleo caliente / brillo, B = sombreado (1 = sin sombra).
// Cada forma cae a cero mucho antes del borde de la celda: sin bordes
// cuadrados ni sangrado entre celdas en los mips que usan los sprites.
import * as THREE from 'three';

export const T = Object.freeze({
  GLOW: 0,
  SPARK: 1,
  SMOKE: 2, // 2..5
  SHARD: 6, // astilla de vidrio
  FLARE: 7, // estrella de 4 puntas
  DUST: 8, // 8..9
  CHIP: 10, // lasca de piedra/hormigón
  RING: 11,
  FLAME: 12, // lengua de fuego
  SPLINTER: 13, // astilla de madera
  PETAL: 14, // pétalo de fogonazo (eje +v = dirección del disparo)
  STAR: 15, // estallido de 6 puntas (escopeta, explosión)
});

const CELL = 128;
const GRID = 4;
const SIZE = CELL * GRID;

function hash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, seed, oct = 4) {
  let s = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += noise(x, y, seed + i * 17) * amp;
    norm += amp; amp *= 0.5; x *= 2.03; y *= 2.03;
  }
  return s / norm;
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function chipShape(seed) {
  const n = 6, rad = [];
  for (let i = 0; i < n; i++) rad.push(0.55 + 0.35 * hash(i, 3, seed));
  return (u, v, r, out) => {
    const ang = Math.atan2(v, u);
    const f = ((ang / (Math.PI * 2) + 1) % 1) * n;
    const i0 = Math.floor(f) % n, i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    const edge = rad[i0] * (1 - t) + rad[i1] * t;
    out[0] = sstep(edge, edge - 0.08, r);
    out[1] = 0;
    out[2] = 0.45 + 0.55 * hash(i0, 7, seed) * (0.6 + 0.4 * v);
  };
}

function smokeShape(seed, grain, density) {
  return (u, v, r, out) => {
    const n = fbm(u * 2.2 + seed * 3.1, v * 2.2 - seed * 1.7, seed);
    const n2 = fbm(u * 5 + 11, v * 5 - seed, seed + 5);
    let a = sat((1 - r) * 1.5 + (n - 0.5) * 1.6 - 0.25);
    a = Math.pow(a, 1.4) * (1 - grain + grain * n2) * density;
    out[0] = a * (1 - sstep(0.86, 0.98, r));
    out[1] = 0;
    out[2] = sat(0.42 + 0.5 * (v * 0.5 + 0.5) + (n2 - 0.5) * 0.5);
  };
}

const SHAPES = [
  // 0 GLOW
  (_u, _v, r, out) => {
    out[0] = Math.exp(-r * r * 5) * (1 - sstep(0.75, 0.98, r));
    out[1] = Math.exp(-r * r * 28);
    out[2] = 1;
  },
  // 1 SPARK: gaussiana caliente y apretada
  (_u, _v, r, out) => {
    out[0] = Math.exp(-r * r * 9) * (1 - sstep(0.7, 0.95, r));
    out[1] = Math.exp(-r * r * 40);
    out[2] = 1;
  },
  smokeShape(1, 0.35, 1),
  smokeShape(2, 0.35, 1),
  smokeShape(3, 0.4, 1),
  smokeShape(4, 0.4, 1),
  // 6 SHARD: triángulo afilado con un filo brillante (vidrio)
  (u, v, r, out) => {
    // triángulo de vértices (0,0.85) (-0.42,-0.6) (0.5,-0.45)
    const e1 = (u + 0.42) * 1.45 - (v + 0.6) * 0.42; // lado izq.
    const e2 = -(u - 0.5) * 1.3 - (v + 0.45) * 0.5; // lado der.
    const e3 = v + 0.6 - (u + 0.42) * 0.163; // base
    const d = Math.min(e1 * 0.9, e2 * 0.9, e3);
    out[0] = sstep(-0.02, 0.05, d) * (1 - sstep(0.85, 0.98, r));
    out[1] = Math.exp(-((d - 0.03) ** 2) * 900) * 0.9 + Math.exp(-((u + 0.05) ** 2 + (v - 0.2) ** 2) * 40) * 0.6;
    out[2] = 0.55 + 0.45 * sat(0.5 + u * 0.8);
  },
  // 7 FLARE: estrella de 4 puntas
  (u, v, r, out) => {
    const core = Math.exp(-r * r * 7);
    const sx = Math.exp(-Math.abs(v) * 22) * Math.exp(-u * u * 3);
    const sy = Math.exp(-Math.abs(u) * 22) * Math.exp(-v * v * 3);
    out[0] = Math.min(1, core * 0.85 + (sx + sy) * 0.6) * (1 - sstep(0.8, 0.98, r));
    out[1] = Math.exp(-r * r * 30);
    out[2] = 1;
  },
  smokeShape(7, 0.75, 0.85),
  smokeShape(8, 0.8, 0.8),
  chipShape(3),
  // 11 RING
  (_u, _v, r, out) => {
    out[0] = Math.exp(-(((r - 0.7) / 0.12) ** 2)) * (1 - sstep(0.88, 0.98, r));
    out[1] = Math.exp(-(((r - 0.7) / 0.04) ** 2));
    out[2] = 1;
  },
  // 12 FLAME: lengua de fuego con borde turbulento y núcleo blanco abajo
  (u, v, r, out) => {
    const n = fbm(u * 2.6 + 30, v * 2.6 - 4, 31, 4);
    const w = 0.62 - (v + 1) * 0.12; // más ancha abajo
    const rr = Math.hypot(u / Math.max(0.2, w), (v + 0.15) / 0.95);
    const a = sat((1 - rr) * 2.2 + (n - 0.5) * 1.8);
    out[0] = Math.pow(a, 1.2) * (1 - sstep(0.86, 0.98, r));
    out[1] = sat(Math.exp(-(u * u * 9 + (v + 0.25) ** 2 * 4)) * (0.6 + 0.6 * n));
    out[2] = sat(0.45 + 0.55 * n);
  },
  // 13 SPLINTER: astilla alargada con borde dentado (madera)
  (u, v, r, out) => {
    const jag = (fbm(v * 6 + 50, 3, 51, 3) - 0.5) * 0.12;
    const w = 0.24 * (1 - Math.abs(v) * 0.8) + jag;
    out[0] = sstep(w, w - 0.05, Math.abs(u + v * 0.08)) * sstep(0.96, 0.82, Math.abs(v)) * (1 - sstep(0.9, 0.99, r));
    out[1] = 0;
    out[2] = 0.5 + 0.5 * sat(0.5 + (u + 0.05) * 3) * (0.7 + 0.3 * fbm(u * 3, v * 14, 52, 2));
  },
  // 14 PETAL: fogonazo de lado; raíz caliente abajo (v=-1), lengua central
  // y dos púas laterales a ~30° (la silueta de estrella de un disparo real)
  (u, v, r, out) => {
    const t = (v + 1) * 0.5;
    const n = fbm(u * 3 + 60, v * 5, 61, 3);
    const w = 0.05 + 0.3 * Math.sin(Math.min(1, t * 1.25) * Math.PI) * (1 - t * 0.45);
    let a = sat((1 - Math.abs(u) / w) * 1.8 + (n - 0.5) * 0.9) * sstep(1.0, 0.8, t);
    for (const sx of [-1, 1]) {
      const dx = sx * 0.5, dy = 0.866;
      const px = u, py = v + 0.62;
      const along = px * dx + py * dy;
      const perp = Math.abs(px * dy - py * dx);
      const pw = 0.05 * (1 - sat(along / 0.95)) + 0.008;
      a = Math.max(a, sstep(pw, pw * 0.25, perp) * sstep(0, 0.12, along) * sstep(0.95, 0.55, along) * (0.7 + 0.3 * n));
    }
    out[0] = a * sstep(0.0, 0.06, t) * (1 - sstep(0.9, 0.99, r));
    out[1] = Math.exp(-(u * u * 40 + (t - 0.16) ** 2 * 16));
    out[2] = 1;
  },
  // 15 STAR: estallido de 6 puntas irregular
  (u, v, r, out) => {
    const ang = Math.atan2(v, u);
    let ray = 0;
    for (let i = 0; i < 6; i++) {
      const a0 = i * Math.PI / 3 + hash(i, 1, 9) * 0.5;
      const da = Math.abs(((ang - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const len = 0.55 + 0.4 * hash(i, 2, 9);
      ray = Math.max(ray, Math.exp(-da * da * 40 / Math.max(0.15, r)) * sstep(len, len * 0.3, r));
    }
    const core = Math.exp(-r * r * 9);
    out[0] = Math.min(1, core + ray * 0.85) * (1 - sstep(0.88, 0.98, r));
    out[1] = Math.exp(-r * r * 26);
    out[2] = 1;
  },
];

export function createAtlas() {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const px = [0, 0, 0];
  for (let c = 0; c < GRID * GRID; c++) {
    const shape = SHAPES[c];
    const ox = (c % GRID) * CELL;
    const oy = Math.floor(c / GRID) * CELL;
    for (let y = 0; y < CELL; y++) {
      const v = ((y + 0.5) / CELL) * 2 - 1;
      for (let x = 0; x < CELL; x++) {
        const u = ((x + 0.5) / CELL) * 2 - 1;
        const r = Math.hypot(u, v);
        if (r >= 1) continue;
        shape(u, v, r, px);
        const i = ((oy + y) * SIZE + ox + x) * 4;
        data[i] = Math.round(sat(px[0]) * 255);
        data[i + 1] = Math.round(sat(px[1]) * 255);
        data[i + 2] = Math.round(sat(px[2]) * 255);
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
