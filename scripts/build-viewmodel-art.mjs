// ARTE DEL ARMA EN PRIMERA PERSONA (sin Blender, sin dependencias nuevas).
//
//   node scripts/build-viewmodel-art.mjs            (escribe public/assets/fp/*.glb)
//   node scripts/build-viewmodel-art.mjs shotgun    (solo esa arma; `arms` = brazos, `kick-leg` = pierna)
//   node scripts/build-viewmodel-art.mjs --check    (no escribe: solo informa)
//
// Las armas conservan las islas del GLB de autor o se construyen íntegramente
// con el kit. Se hornean las normales, el desgaste y los pivotes de cada pieza.
// Brazos y pierna conservan los triángulos del mismo GLB que usa el soldado.
// Determinista: misma entrada → mismos bytes (sin Math.random ni fechas).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, simplify, creaseNormals, writeGLB } from './simplify-soldier-art.mjs';

import { Builder } from '../src/view/fp/kit/geometry.js';
import { kitMaterials } from '../src/view/fp/kit/surfaces.js';
import { manosRobot } from './smg-hand-art.mjs';
import { soldierPiece } from './soldier-limbs.mjs';
import { Matrix4 } from 'three';
import { BLENDER_LEG_SCALE } from '../src/player/blender-soldier.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'art/characters/blender-source');
const OUT = path.join(root, 'public/assets/fp');
const SOCKETS = JSON.parse(fs.readFileSync(path.join(root, 'public/assets/characters/blender/weapons.json'), 'utf8'));

// Ángulo de pliegue de las normales: los biseles (2-3 tramos por arista de
// 90°) se ven redondos; las caras a 90° siguen duras.
const CREASE = 34 * Math.PI / 180;

// ---------- tabla por arma ----------
// Una arma por archivo en scripts/viewmodel-art/<arma>.mjs (reglas de
// piezas, piezas construidas, pivotes y anclas); aquí solo la maquinaria.
const ART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'viewmodel-art');
export const WEAPONS = {};
for (const f of fs.readdirSync(ART_DIR).filter((x) => x.endsWith('.mjs')).sort()) {
  const key = f.slice(0, -4);
  const mod = await import(path.join(ART_DIR, f));
  const source = mod.source ?? key;
  WEAPONS[key] = { source, ...mod.default({ sockets: SOCKETS[source].sockets }) };
}

// ---------- utilidades de malla ----------
const key3 = (x, y, z) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;

// Malla de un nodo, soldada por posición en TODAS sus primitivas (las islas
// cruzan materiales). F: caras, FM: material de cada cara.
function loadMesh(json, accessor, nodeName) {
  const node = nodeName ? json.nodes.find((n) => n.name === nodeName) : json.nodes.find((n) => n.mesh != null);
  if (!node || node.mesh == null) throw new Error(`sin malla: ${nodeName}`);
  const P = [], F = [], FM = [], map = new Map();
  for (const p of json.meshes[node.mesh].primitives) {
    const pos = accessor(p.attributes.POSITION), idx = accessor(p.indices);
    const remap = new Int32Array(pos.length / 3);
    for (let i = 0; i < remap.length; i++) {
      const k = key3(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
      let id = map.get(k);
      if (id === undefined) { id = P.length / 3; map.set(k, id); P.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]); }
      remap[i] = id;
    }
    for (let i = 0; i < idx.length; i += 3) {
      const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
      if (a === b || b === c || a === c) continue;
      F.push(a, b, c); FM.push(p.material);
    }
  }
  return { P: Float64Array.from(P), F: Int32Array.from(F), FM: Int32Array.from(FM), node };
}

// Islas conexas por caras; orden estable = primera cara de cada isla.
function islands(mesh) {
  const { P, F, FM } = mesh;
  const nv = P.length / 3, par = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let i = 0; i < F.length; i += 3) {
    const a = find(F[i]), b = find(F[i + 1]), c = find(F[i + 2]);
    par[b] = a; par[find(c)] = a;
  }
  const byRoot = new Map(), out = [];
  for (let t = 0; t < F.length / 3; t++) {
    const r = find(F[3 * t]);
    let isl = byRoot.get(r);
    if (!isl) {
      isl = { index: out.length, faces: [], mats: new Set(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], verts: new Set() };
      byRoot.set(r, isl); out.push(isl);
    }
    isl.faces.push(t); isl.mats.add(FM[t]);
    for (let k = 0; k < 3; k++) {
      const v = F[3 * t + k]; isl.verts.add(v);
      for (let a = 0; a < 3; a++) { isl.min[a] = Math.min(isl.min[a], P[3 * v + a]); isl.max[a] = Math.max(isl.max[a], P[3 * v + a]); }
    }
  }
  for (const isl of out) {
    isl.center = [0, 1, 2].map((a) => (isl.min[a] + isl.max[a]) / 2);
    let c = [0, 0, 0];
    for (const v of isl.verts) for (let a = 0; a < 3; a++) c[a] += P[3 * v + a];
    isl.centroid = c.map((x) => x / isl.verts.size);
    isl.verts = [...isl.verts];
  }
  return out;
}

// Caja con aristas achaflanadas (44 triángulos, cerrada y manifold): el
// mismo lenguaje de caja biselada del modelo original.
function chamferBox(min, max, c) {
  const h = [0, 1, 2].map((a) => (max[a] - min[a]) / 2), m = [0, 1, 2].map((a) => (max[a] + min[a]) / 2);
  c = Math.min(c, h[0] * 0.45, h[1] * 0.45, h[2] * 0.45);
  const pos = [], idx = new Map();
  // punto de la esquina (sx,sy,sz) sobre la cara del eje `ax`
  const pt = (sx, sy, sz, ax) => {
    const k = `${sx},${sy},${sz},${ax}`;
    if (idx.has(k)) return idx.get(k);
    const s = [sx, sy, sz], p = [0, 1, 2].map((a) => m[a] + s[a] * (a === ax ? h[a] : h[a] - c));
    idx.set(k, pos.length / 3); pos.push(...p);
    return idx.get(k);
  };
  const faces = [];
  const quad = (a, b, cc, d) => faces.push([a, b, cc], [a, cc, d]);
  const S = [-1, 1];
  // caras principales
  for (const s of S) {
    quad(pt(s, -1, -1, 0), pt(s, 1, -1, 0), pt(s, 1, 1, 0), pt(s, -1, 1, 0));
    quad(pt(-1, s, -1, 1), pt(1, s, -1, 1), pt(1, s, 1, 1), pt(-1, s, 1, 1));
    quad(pt(-1, -1, s, 2), pt(1, -1, s, 2), pt(1, 1, s, 2), pt(-1, 1, s, 2));
  }
  // chaflanes de arista (a lo largo de z, y, x) y esquinas
  for (const a of S) for (const b of S) {
    quad(pt(a, b, -1, 0), pt(a, b, 1, 0), pt(a, b, 1, 1), pt(a, b, -1, 1));
    quad(pt(a, -1, b, 0), pt(a, 1, b, 0), pt(a, 1, b, 2), pt(a, -1, b, 2));
    quad(pt(-1, a, b, 1), pt(1, a, b, 1), pt(1, a, b, 2), pt(-1, a, b, 2));
    for (const z of S) faces.push([pt(a, b, z, 0), pt(a, b, z, 1), pt(a, b, z, 2)]);
  }
  // orientación hacia fuera (convexa: basta con el centro)
  const out = [];
  for (const f of faces) {
    const [p, q, r] = f.map((i) => pos.slice(i * 3, i * 3 + 3));
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const cx = (p[0] + q[0] + r[0]) / 3 - m[0], cy = (p[1] + q[1] + r[1]) / 3 - m[1], cz = (p[2] + q[2] + r[2]) / 3 - m[2];
    out.push(...(n[0] * cx + n[1] * cy + n[2] * cz < 0 ? [f[0], f[2], f[1]] : f));
  }
  return { pos: Float64Array.from(pos), faces: Int32Array.from(out) };
}

// Disco en el plano XY, con un anillo biselado en cada cara del ocular.
function chamferDisc(min, max, bevel) {
  const sides = 24, pos = [], faces = [];
  const [cx, cy] = min.map((v, i) => (v + max[i]) / 2);
  const radius = (max[0] - min[0]) / 2;
  for (const [r, z] of [[radius - bevel, min[2]], [radius, min[2] + bevel],
    [radius, max[2] - bevel], [radius - bevel, max[2]]]) {
    for (let i = 0; i < sides; i++) {
      const t = 2 * Math.PI * i / sides;
      pos.push(cx + r * Math.cos(t), cy + r * Math.sin(t), z);
    }
  }
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    for (let k = 0; k < 3; k++) {
      const a = k * sides + i, b = k * sides + next;
      faces.push(a, b, a + sides, b, b + sides, a + sides);
    }
    if (i > 0 && i < sides - 1) faces.push(0, next, i, 3 * sides, 3 * sides + i, 3 * sides + next);
  }
  return { pos: Float64Array.from(pos), faces: Int32Array.from(faces) };
}

// Primitiva compacta (posiciones propias) con las caras dadas de la malla.
function primFromFaces(mesh, faceList) {
  const map = new Map(), pos = [], faces = [];
  for (const t of faceList) for (let k = 0; k < 3; k++) {
    const v = mesh.F[3 * t + k];
    let id = map.get(v);
    if (id === undefined) { id = pos.length / 3; map.set(v, id); pos.push(mesh.P[3 * v], mesh.P[3 * v + 1], mesh.P[3 * v + 2]); }
    faces.push(id);
  }
  return { pos: Float64Array.from(pos), faces: Int32Array.from(faces) };
}
function mergePrims(list) {
  const pos = [], faces = [];
  for (const p of list) {
    const o = pos.length / 3;
    pos.push(...p.pos);
    for (const f of p.faces) faces.push(f + o);
  }
  return { pos: Float64Array.from(pos), faces: Int32Array.from(faces) };
}
// Desgaste por vértice: aristas convexas (biseles, cantos) se gastan; las
// caras planas y los rincones cóncavos no. 0..1.
export function wearOf(g) {
  const nv = g.P.length / 3, byKey = new Map();
  for (let i = 0; i < nv; i++) {
    const k = key3(g.P[3 * i], g.P[3 * i + 1], g.P[3 * i + 2]);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  }
  // normal media por posición y dispersión de las normales que la comparten
  const W = new Float32Array(nv);
  for (const ids of byKey.values()) {
    let sx = 0, sy = 0, sz = 0;
    for (const i of ids) { sx += g.N[3 * i]; sy += g.N[3 * i + 1]; sz += g.N[3 * i + 2]; }
    const l = Math.hypot(sx, sy, sz) / ids.length; // 1 = todas iguales; menos = esquina dura
    const hard = 1 - l;
    for (const i of ids) W[i] = hard;
  }
  // biseles suaves: la normal del vértice se aparta de las de sus caras
  const fn = new Float64Array(3);
  const dev = new Float32Array(nv), cnt = new Float32Array(nv);
  for (let f = 0; f < g.I.length; f += 3) {
    const a = g.I[f], b = g.I[f + 1], c = g.I[f + 2];
    const ux = g.P[3 * b] - g.P[3 * a], uy = g.P[3 * b + 1] - g.P[3 * a + 1], uz = g.P[3 * b + 2] - g.P[3 * a + 2];
    const vx = g.P[3 * c] - g.P[3 * a], vy = g.P[3 * c + 1] - g.P[3 * a + 1], vz = g.P[3 * c + 2] - g.P[3 * a + 2];
    fn[0] = uy * vz - uz * vy; fn[1] = uz * vx - ux * vz; fn[2] = ux * vy - uy * vx;
    const l = Math.hypot(fn[0], fn[1], fn[2]) || 1;
    for (const v of [a, b, c]) {
      const d = (fn[0] * g.N[3 * v] + fn[1] * g.N[3 * v + 1] + fn[2] * g.N[3 * v + 2]) / l;
      dev[v] += 1 - d; cnt[v]++;
    }
  }
  for (let i = 0; i < nv; i++) {
    const soft = cnt[i] ? dev[i] / cnt[i] : 0;
    const w = Math.max(W[i] * 1.6, soft * 9);
    W[i] = Math.round(Math.min(1, w) * 255) / 255;
  }
  return W;
}

// ---------- escritura ----------
// parts: [{ name, translation, prims: [{ material, prim }], extras, children: [...] }]
function buildGLB({ name, materials, nodes, extras, report }) {
  const json = { asset: { version: '2.0', generator: 'breach scripts/build-viewmodel-art.mjs', extras: report },
    extensionsUsed: [...new Set(materials.flatMap((m) => Object.keys(m.extensions ?? {})))],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [], materials };
  const chunks = [];
  const pushNode = (n) => {
    const id = json.nodes.length;
    const out = { name: n.name };
    json.nodes.push(out);
    if (n.translation && n.translation.some((v) => v !== 0)) out.translation = n.translation.map((v) => Math.fround(v));
    if (n.extras) out.extras = n.extras;
    if (n.prims?.length) {
      const primitives = [];
      for (const { material, g } of n.prims) {
        const count = g.P.length / 3;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < g.P.length; i++) { min[i % 3] = Math.min(min[i % 3], g.P[i]); max[i % 3] = Math.max(max[i % 3], g.P[i]); }
        const base = chunks.length;
        chunks.push({ data: g.P, target: 34962, accessor: { componentType: 5126, count, type: 'VEC3', min, max } });
        chunks.push({ data: g.N, target: 34962, accessor: { componentType: 5126, count, type: 'VEC3' } });
        chunks.push({ data: g.W, target: 34962, accessor: { componentType: 5126, count, type: 'SCALAR' } });
        const idx = count < 65536 ? Uint16Array.from(g.I) : g.I;
        chunks.push({ data: idx, target: 34963, accessor: { componentType: idx instanceof Uint16Array ? 5123 : 5125, count: g.I.length, type: 'SCALAR' } });
        const attributes = { POSITION: base, NORMAL: base + 1, _WEAR: base + 2 };
        if (g.joints) {
          attributes._FP_JOINTS = chunks.length;
          chunks.push({ data: g.joints, target: 34962, accessor: { componentType: 5121, count, type: 'VEC4' } });
          attributes._FP_WEIGHTS = chunks.length;
          chunks.push({ data: g.weights, target: 34962, accessor: { componentType: 5126, count, type: 'VEC4' } });
        }
        primitives.push({ attributes, indices: base + 3, material });
      }
      out.mesh = json.meshes.length;
      json.meshes.push({ name: `m_${n.name}`, primitives });
    }
    if (n.children?.length) out.children = n.children.map(pushNode);
    return id;
  };
  pushNode({ name, extras, children: nodes });
  return { json, chunks };
}

// Simplifica en una sola cola todas las primitivas [{ key, prim }] y
// devuelve la geometría final (posición, normal con pliegue, desgaste).
function finish(list, plan) {
  const prims = list.map((l) => l.prim);
  const res = plan ? simplify(prims, plan) : { prims, rms: 0 };
  return { rms: res.rms, out: list.map((l, i) => {
    const g = creaseNormals(res.prims[i], CREASE);
    for (let k = 0; k < g.I.length; k += 3) {
      // control: nada degenerado (como el simplificador del juego)
      const a = g.I[k], b = g.I[k + 1], c = g.I[k + 2];
      const ux = g.P[3 * b] - g.P[3 * a], uy = g.P[3 * b + 1] - g.P[3 * a + 1], uz = g.P[3 * b + 2] - g.P[3 * a + 2];
      const vx = g.P[3 * c] - g.P[3 * a], vy = g.P[3 * c + 1] - g.P[3 * a + 1], vz = g.P[3 * c + 2] - g.P[3 * a + 2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-10) throw new Error('cara degenerada en la salida');
    }
    g.W = wearOf(g);
    return { ...l, g };
  }) };
}
const trisOf = (gs) => gs.reduce((s, x) => s + x.g.I.length / 3, 0);
const materialIndex = (materials, name) => {
  const i = materials.findIndex((m) => m.name.toLowerCase().includes(name));
  if (i < 0) throw new Error(`material no encontrado: ${name}`);
  return i;
};

// Conserva las normales de los tornos y biseles del kit al indexar el GLB.
function kitPrims(builder, materials) {
  return builder.build().map(({ surface, geometry }) => {
    let material = materials.findIndex(m => m.name === surface || m.name.toLowerCase().includes(surface));
    if (material < 0) {
      const finish = kitMaterials.find(m => m.name === surface);
      if (!finish) throw new Error(`Acabado desconocido: ${surface}`);
      material = materials.push(finish) - 1;
    }
    const g = { P: geometry.attributes.position.array, N: geometry.attributes.normal.array, I: geometry.index.array };
    g.W = wearOf(g);
    return { material, g };
  });
}

// ---------- un arma ----------
export function buildWeapon(key) {
  const spec = WEAPONS[key];
  const source = spec.source;
  const donor = spec.replace ? null : readGLB(path.join(SRC, `${source}.glb`));
  const mesh = donor && loadMesh(donor.json, donor.accessor, null);
  const isl = mesh ? islands(mesh) : [];
  const sockets = SOCKETS[source].sockets;
  const materials = donor?.json.materials ?? [];
  const assign = new Map(); // isla → pieza (o null = descartada)
  const counts = {};
  for (const it of isl) {
    let part = 'body';
    for (const r of spec.rules) {
      const s = sockets[r.from];
      const rel = [it.center[0] - s[0], it.center[1] - s[1], it.center[2] - s[2]];
      if (r.absX) rel[0] = Math.abs(it.center[0]);
      if (r.mat && ![...it.mats].some((m) => materials[m].name.toLowerCase().includes(r.mat))) continue;
      if (rel.every((v, a) => v >= r.box[a][0] && v <= r.box[a][1])) { part = r.drop ? null : r.part; if (r.drop) counts[`${r.part}(sustituida)`] = (counts[`${r.part}(sustituida)`] || 0) + 1; break; }
    }
    assign.set(it, part);
    if (part) counts[part] = (counts[part] || 0) + 1;
  }
  // primitivas por (pieza, material)
  const groups = new Map();
  const add = (part, material, prim) => {
    const k = `${part}|${material}`;
    if (!groups.has(k)) groups.set(k, { part, material, prims: [] });
    groups.get(k).prims.push(prim);
  };
  for (const it of isl) {
    const part = assign.get(it);
    if (!part) continue;
    spec.shapeIsland?.(part, it, mesh.P);
    const byMat = new Map();
    for (const t of it.faces) { const m = mesh.FM[t]; if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(t); }
    for (const [m, faces] of byMat) add(part, m, primFromFaces(mesh, faces));
  }
  const built = {};
  for (const [part, mat, min, max, bevel, shape] of spec.build) {
    const make = shape === 'disc' ? chamferDisc : chamferBox;
    add(part, materialIndex(materials, mat), make(min, max, bevel));
    built[part] = (built[part] || 0) + 1;
  }
  const list = [...groups.values()].map((g) => ({ part: g.part, material: g.material, prim: mergePrims(g.prims) }));
  const { out, rms } = finish(list);
  const builders = new Map();
  spec.sculpt(part => {
    if (!Object.hasOwn(spec.pivots, part)) throw new Error(`${key}: pieza desconocida ${part}`);
    if (!builders.has(part)) builders.set(part, new Builder());
    return builders.get(part);
  }, spec.anchors);
  for (const [part, b] of builders) {
    for (const prim of kitPrims(b, materials)) out.push({ part, ...prim });
  }
  const srcTris = mesh ? mesh.F.length / 3 : 0;
  // nodos por pieza con su pivote
  const parts = Object.keys(spec.pivots);
  const nodes = parts.map((part) => {
    const pv = spec.pivots[part];
    return {
      name: part, translation: pv,
      prims: out.filter((o) => o.part === part).map((o) => {
        const g = o.g, P = Float32Array.from(g.P);
        for (let i = 0; i < P.length; i += 3) { P[i] -= pv[0]; P[i + 1] -= pv[1]; P[i + 2] -= pv[2]; }
        return { material: o.material, g: { ...g, P } };
      }),
    };
  });
  for (const [a, p] of Object.entries(spec.anchors)) nodes.push({ name: `anchor_${a}`, translation: p });
  const tris = trisOf(out);
  const report = { source: spec.replace ? 'CRASHTERRA/vulcan.ts' : `art/characters/blender-source/${source}.glb`, sourceTris: srcTris, islands: isl.length, tris, rmsMm: +(rms * 1000).toFixed(3), parts: counts, built };
  const extras = { fp: 1, weapon: key, sockets: spec.anchors, pivots: spec.pivots, parts };
  const mats = materials.map((m) => JSON.parse(JSON.stringify(m)));
  return { ...buildGLB({ name: `${key}_fp`, materials: mats, nodes, extras, report }), report };
}

// ---------- brazos ----------
const SOLDIER = path.join(root, 'public/assets/characters/blender/soldier-blender-body.glb');
const UPPER_LEN = 0.28, FORE_LEN = 0.31;

export async function buildArms() {
  const body = readGLB(SOLDIER);
  const { json, accessor } = body;
  const materials = structuredClone(json.materials);
  const list = [];
  // bote de humo para el lanzamiento (en la mano izquierda): el arma real
  const gj = readGLB(path.join(SRC, 'grenade.glb'));
  const gm = loadMesh(gj.json, gj.accessor, null);
  const gIsl = islands(gm);
  const gMat = new Map();
  for (const it of gIsl) for (const t of it.faces) {
    const name = gj.json.materials[gm.FM[t]].name;
    let mi = materials.findIndex((m) => m.name === name);
    if (mi < 0) { mi = materials.length; materials.push(JSON.parse(JSON.stringify(gj.json.materials[gm.FM[t]]))); }
    if (!gMat.has(mi)) gMat.set(mi, []);
    gMat.get(mi).push(t);
  }
  for (const [mi, faces] of gMat) list.push({ key: 'grenade', material: mi, prim: primFromFaces(gm, faces) });

  const { out } = finish(list, { tris: 500, err: 0.0011 });
  const nodes = ['R', 'L'].map(side => {
    const mesh = part => loadMesh(json, accessor, 'segment_' + part + '_' + side);
    const fore = soldierPiece(body, mesh('forearm'), 'forearm_' + side);
    fore.translation = [0, -UPPER_LEN, 0];

    const upper = soldierPiece(body, mesh('upper_arm'), 'upper_arm_' + side);
    const shell = soldierPiece(body, mesh('pauldron'), 'pauldron_' + side, new Matrix4().makeScale(1 / .82, 1 / .82, 1 / .82));
    upper.children = [shell, fore];
    return upper;
  });
  const { nodos, punos } = await manosRobot(materials);
  nodes.push({ name: 'grenade', prims: out }, ...nodos);
  const nodeTris = node => trisOf(node.prims ?? []) + (node.children ?? []).reduce((sum, ch) => sum + nodeTris(ch), 0);
  const report = { source: 'public/assets/characters/blender/soldier-blender-body.glb', tris: nodes.reduce((sum, n) => sum + nodeTris(n), 0) };
  // El montaje de mundo normaliza cada arma a su longitud en manos del soldado.
  const mounts = Object.fromEntries(Object.keys(WEAPONS).map(key => {
    const world = readGLB(path.join(root, 'public/assets/weapons', key + '.glb'));
    return [key, world.json.nodes[0].extras.worldScale];
  }));
  return { ...buildGLB({ name: 'fp_arms', materials, nodes, extras: { fp: 1, upper: UPPER_LEN, fore: FORE_LEN, mounts }, report }), report, punos };
}

// Pierna derecha con las cuatro piezas del soldado, incluida la rodillera
// rígida que el exportador dejó en un nodo distinto al de la espinilla.
export function buildKickLeg() {
  const body = readGLB(SOLDIER);
  const { json, accessor } = body;
  const nodes = ['thigh', 'kneecap', 'shin', 'foot'].map(name => {
    const mesh = loadMesh(json, accessor, 'segment_' + name + '_R');
    const boot = name === 'foot';
    const sy = name === 'thigh' || name === 'shin' ? BLENDER_LEG_SCALE : 1;
    const bind = new Matrix4().makeScale(boot ? -1 : 1, boot ? 1 : -1 / sy, -1);
    bind.setPosition(0.06, boot ? -0.32 : 0, 0);
    return soldierPiece(body, mesh, name, bind);
  });
  const report = { source: 'public/assets/characters/blender/soldier-blender-body.glb', tris: nodes.reduce((n, piece) => n + trisOf(piece.prims), 0) };
  return { ...buildGLB({ name: 'fp_kick_leg', materials: json.materials, nodes, extras: { fp: 1 }, report }), report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dry = process.argv.includes('--check');
  if (!dry) fs.mkdirSync(OUT, { recursive: true });
  // `node scripts/build-viewmodel-art.mjs smg arms` → solo esos; sin nombres, todo
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const all = [...Object.keys(WEAPONS).map((k) => [k, () => buildWeapon(k)]), ['arms', buildArms], ['kick-leg', buildKickLeg]];
  for (const n of names) if (!all.some(([key]) => key === n)) throw new Error(`pieza sin reglas: ${n}`);
  const jobs = names.length ? all.filter(([n]) => names.includes(n)) : all;
  for (const [name, fn] of jobs) {
    const t0 = Date.now();
    const r = await fn();
    const file = path.join(OUT, `${name}.glb`);
    if (!dry) {
      writeGLB(file, r.json, r.chunks);
      if (r.punos) fs.writeFileSync(path.join(root, 'src/view/fp/hand/punos.json'), JSON.stringify(r.punos) + '\n');
    }
    console.log(`${name.padEnd(6)} ${JSON.stringify(r.report)} · ${Date.now() - t0} ms${dry ? '' : ` · ${fs.statSync(file).size} bytes`}`);
  }
}
