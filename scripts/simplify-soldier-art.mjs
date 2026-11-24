// SIMPLIFICA LAS ARMAS Y EL CUERPO DEL SOLDADO (sin Blender, sin dependencias).
//
// Lee los GLB originales de art/characters/blender-source/ y escribe los
// ligeros en public/assets/characters/blender/, que es lo que carga el juego.
//   node scripts/simplify-soldier-art.mjs            (todos)
//   node scripts/simplify-soldier-art.mjs smg pistol (solo esos)
//   ... --check   (no escribe: solo informa triángulos y error)
//
// Qué se conserva tal cual: el JSON del GLB entero (nodos, nombres, extras
// con los sockets de muzzle/grip/forend/mag, materiales, extensiones,
// transformaciones de nodo). Solo cambian los buffers de cada primitiva:
// misma primitiva, mismo material, menos triángulos.
//
// Método: colapso de aristas por métrica de error cuadrático (Garland-
// Heckbert) dentro de cada primitiva soldada por posición. El costo se
// normaliza por el área acumulada: es un error cuadrático medio en metros,
// comparable entre piezas grandes y chicas. Nunca se mueven los vértices de
// borde ni los de aristas no-manifold, se rechazan colapsos que voltean o
// degeneran caras o que romperían la topología. Las normales se recalculan
// con ángulo de pliegue (superficie dura: caras planas, biseles suaves).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SOLDIER_ART_SRC || path.join(root, 'art/characters/blender-source');
const OUT = process.env.SOLDIER_ART_OUT || path.join(root, 'public/assets/characters/blender');

// Objetivo por modelo: triángulos máximos y error máximo tolerado (metros,
// RMS de la cuádrica). Se para en lo que llegue primero: la calidad manda.
// El arma en mano mide ~0.6-1 m y en la vista de hombro ocupa unos cientos
// de píxeles (~2-3 mm por píxel): 1.2 mm queda bajo el píxel.
// `slots`: materiales que trae el GLB fuente (si una reexportación trae
// otros, el script se detiene en vez de adivinar).
export const PLAN = {
  smg: { tris: 3000, err: 0.0012, slots: 6 },
  shotgun: { tris: 3000, err: 0.0012, slots: 7 },
  sniper: { tris: 3000, err: 0.0012, slots: 7 },
  bazooka: { tris: 3000, err: 0.0012, slots: 7 },
  pistol: { tris: 1500, err: 0.0010, slots: 6 },
  grenade: { tris: 1500, err: 0.0008, slots: 6 },
  'soldier-blender-body': { tris: 16000, err: 0.0012, slots: 9 },
};
// Doble del área mínima de un triángulo (m²): por debajo es degenerado y
// solo gasta índices (y su normal sería cero).
const DEGEN = 1e-10;
const cross2 = (X, a, b, c) => {
  const ux = X[b * 3] - X[a * 3], uy = X[b * 3 + 1] - X[a * 3 + 1], uz = X[b * 3 + 2] - X[a * 3 + 2];
  const vx = X[c * 3] - X[a * 3], vy = X[c * 3 + 1] - X[a * 3 + 1], vz = X[c * 3 + 2] - X[a * 3 + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};
const CREASE = 12 * Math.PI / 180;

// ---------- GLB ----------
const COMP = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
export function readGLB(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`no es GLB: ${file}`);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bl = b.readUInt32LE(20 + jl), bo = 20 + jl + 8;
  const bin = new Uint8Array(b.buffer.slice(b.byteOffset + bo, b.byteOffset + bo + bl));
  const accessor = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], C = COMP[a.componentType], n = SIZE[a.type];
    if (bv.byteStride && bv.byteStride !== n * C.BYTES_PER_ELEMENT) throw new Error('stride no soportado');
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    return new C(bin.buffer.slice(off, off + a.count * n * C.BYTES_PER_ELEMENT));
  };
  return { json, accessor };
}

export function writeGLB(file, json, chunks) {
  // chunks: [{ data: TypedArray, target, accessor: {...} }] en orden de accessor
  const views = [], accessors = [];
  let offset = 0;
  const parts = [];
  for (const c of chunks) {
    const bytes = new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: c.target });
    accessors.push({ ...c.accessor, bufferView: views.length - 1 });
    parts.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
  }
  json.bufferViews = views;
  json.accessors = accessors;
  json.buffers = [{ byteLength: offset }];
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  const jpad = (4 - (js.length % 4)) % 4;
  js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
  const bin = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, jh, js, bh, bin]));
}

// ---------- malla soldada ----------
export function weld(P, I) {
  const map = new Map(), remap = new Uint32Array(P.length / 3), pos = [];
  for (let i = 0; i < remap.length; i++) {
    // 1e-6 m: solo une copias exactas (las separó la normal al exportar)
    const k = `${Math.round(P[3 * i] * 1e6)},${Math.round(P[3 * i + 1] * 1e6)},${Math.round(P[3 * i + 2] * 1e6)}`;
    let id = map.get(k);
    if (id === undefined) { id = pos.length / 3; map.set(k, id); pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); }
    remap[i] = id;
  }
  // fuera las caras de área cero (las hay en la fuente y el soldado las
  // crea al unir copias): no se ven, gastan presupuesto y dan normal cero
  const X = Float64Array.from(pos), faces = [];
  let dropped = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = remap[I[i]], b = remap[I[i + 1]], c = remap[I[i + 2]];
    if (a === b || b === c || a === c || cross2(X, a, b, c) < DEGEN) { dropped++; continue; }
    faces.push(a, b, c);
  }
  return { pos: X, faces: Int32Array.from(faces), dropped };
}

// ---------- cola de prioridad (montículo binario) ----------
class Heap {
  constructor() { this.c = []; this.k = []; }
  push(cost, item) {
    const c = this.c, k = this.k; let i = c.length; c.push(cost); k.push(item);
    while (i > 0) { const p = (i - 1) >> 1; if (c[p] <= c[i]) break; [c[p], c[i]] = [c[i], c[p]]; [k[p], k[i]] = [k[i], k[p]]; i = p; }
  }
  pop() {
    const c = this.c, k = this.k, top = k[0], cost = c[0], lc = c.pop(), lk = k.pop();
    if (c.length) {
      c[0] = lc; k[0] = lk; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]]; [k[m], k[i]] = [k[i], k[m]]; i = m;
      }
    }
    return { cost, item: top };
  }
  get size() { return this.c.length; }
}

// ---------- simplificador de una malla (todas sus primitivas a la vez) ----------
// prims: [{ pos, faces }]. Devuelve las mismas primitivas simplificadas.
export function simplify(prims, { tris, err }) {
  // todo en un solo espacio de vértices: la cola es global y quita primero
  // el detalle más barato de toda el arma, sin mezclar primitivas
  let nv = 0, nf = 0;
  for (const p of prims) { nv += p.pos.length / 3; nf += p.faces.length / 3; }
  const X = new Float64Array(nv * 3), F = new Int32Array(nf * 3), FP = new Uint16Array(nf);
  const Q = new Float64Array(nv * 10), W = new Float64Array(nv);
  let vo = 0, fo = 0;
  prims.forEach((p, pi) => {
    X.set(p.pos, vo * 3);
    for (let i = 0; i < p.faces.length; i++) F[fo * 3 + i] = p.faces[i] + vo;
    FP.fill(pi, fo, fo + p.faces.length / 3);
    vo += p.pos.length / 3; fo += p.faces.length / 3;
  });
  const alive = new Uint8Array(nf).fill(1);
  const locked = new Uint8Array(nv);
  const vf = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) vf[F[f * 3 + k]].push(f);
  const fn = new Float64Array(3);
  const faceNormal = (a, b, c, out) => {
    const ux = X[b * 3] - X[a * 3], uy = X[b * 3 + 1] - X[a * 3 + 1], uz = X[b * 3 + 2] - X[a * 3 + 2];
    const vx = X[c * 3] - X[a * 3], vy = X[c * 3 + 1] - X[a * 3 + 1], vz = X[c * 3 + 2] - X[a * 3 + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    return Math.hypot(out[0], out[1], out[2]);
  };
  // cuádricas por cara, ponderadas por área
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const len = faceNormal(a, b, c, fn);
    if (len < 1e-14) continue;
    const area = len / 2, nx = fn[0] / len, ny = fn[1] / len, nz = fn[2] / len;
    const d = -(nx * X[a * 3] + ny * X[a * 3 + 1] + nz * X[a * 3 + 2]);
    const q = [nx * nx, nx * ny, nx * nz, ny * ny, ny * nz, nz * nz, nx * d, ny * d, nz * d, d * d];
    for (const v of [a, b, c]) { for (let i = 0; i < 10; i++) Q[v * 10 + i] += q[i] * area; W[v] += area; }
  }
  // bordes y aristas no-manifold: sus vértices quedan fijos
  const edgeCount = new Map();
  const ek = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const key = ek(F[f * 3 + k], F[f * 3 + (k + 1) % 3]);
    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
  }
  for (const [key, n] of edgeCount) if (n !== 2) { locked[Math.floor(key / nv)] = 1; locked[key % nv] = 1; }

  const stamp = new Uint32Array(nv);
  const heap = new Heap();
  const qe = (q, x, y, z) => q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + q[3] * y * y + 2 * q[4] * y * z + q[5] * z * z +
    2 * (q[6] * x + q[7] * y + q[8] * z) + q[9];
  const tmpQ = new Float64Array(10);
  const evaluate = (u, v) => {
    if (locked[u] && locked[v]) return null;
    for (let i = 0; i < 10; i++) tmpQ[i] = Q[u * 10 + i] + Q[v * 10 + i];
    const w = W[u] + W[v] || 1;
    const cands = [];
    if (locked[u]) cands.push([X[u * 3], X[u * 3 + 1], X[u * 3 + 2]]);
    else if (locked[v]) cands.push([X[v * 3], X[v * 3 + 1], X[v * 3 + 2]]);
    else {
      const q = tmpQ;
      const a = q[0], b = q[1], c = q[2], d = q[3], e = q[4], f = q[5];
      const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
      // solo si el sistema está bien condicionado y el punto óptimo cae cerca
      // de la arista (si no, el óptimo de planos casi paralelos se dispara)
      if (Math.abs(det) > 1e-30 * w * w * w) {
        const i00 = (d * f - e * e) / det, i01 = (c * e - b * f) / det, i02 = (b * e - c * d) / det;
        const i11 = (a * f - c * c) / det, i12 = (b * c - a * e) / det, i22 = (a * d - b * b) / det;
        const x = -(i00 * q[6] + i01 * q[7] + i02 * q[8]);
        const y = -(i01 * q[6] + i11 * q[7] + i12 * q[8]);
        const z = -(i02 * q[6] + i12 * q[7] + i22 * q[8]);
        const mx = (X[u * 3] + X[v * 3]) / 2, my = (X[u * 3 + 1] + X[v * 3 + 1]) / 2, mz = (X[u * 3 + 2] + X[v * 3 + 2]) / 2;
        const el = Math.hypot(X[u * 3] - X[v * 3], X[u * 3 + 1] - X[v * 3 + 1], X[u * 3 + 2] - X[v * 3 + 2]);
        if (Number.isFinite(x + y + z) && Math.hypot(x - mx, y - my, z - mz) < el) cands.push([x, y, z]);
      }
      cands.push([X[u * 3], X[u * 3 + 1], X[u * 3 + 2]], [X[v * 3], X[v * 3 + 1], X[v * 3 + 2]],
        [(X[u * 3] + X[v * 3]) / 2, (X[u * 3 + 1] + X[v * 3 + 1]) / 2, (X[u * 3 + 2] + X[v * 3 + 2]) / 2]);
    }
    let best = null, bc = Infinity;
    for (const p of cands) { const c = qe(tmpQ, p[0], p[1], p[2]); if (c < bc) { bc = c; best = p; } }
    if (!best) return null;
    return { cost: Math.max(0, bc) / w, p: best };
  };
  const neighbours = (v) => {
    const s = new Set();
    for (const f of vf[v]) if (alive[f]) for (let k = 0; k < 3; k++) { const w = F[f * 3 + k]; if (w !== v) s.add(w); }
    return s;
  };
  const pushEdges = (v) => {
    for (const w of neighbours(v)) {
      const r = evaluate(v, w);
      if (r) heap.push(r.cost, [v, w, stamp[v], stamp[w], r.p]);
    }
  };
  for (let v = 0; v < nv; v++) for (const w of neighbours(v)) if (w > v) {
    const r = evaluate(v, w);
    if (r) heap.push(r.cost, [v, w, stamp[v], stamp[w], r.p]);
  }

  let faces = 0;
  for (let f = 0; f < nf; f++) if (alive[f]) faces++;
  const limit = err * err;
  let worst = 0;
  const n0 = new Float64Array(3), n1 = new Float64Array(3);
  while (heap.size && faces > tris) {
    const { cost, item } = heap.pop();
    const [u, v, su, sv, p] = item;
    if (stamp[u] !== su || stamp[v] !== sv) continue;
    if (cost > limit) break;
    // condición de enlace: los vecinos comunes son solo los opuestos de las
    // dos caras de la arista (si no, el colapso crea topología no-manifold)
    const shared = vf[u].filter((f) => alive[f] && (F[f * 3] === v || F[f * 3 + 1] === v || F[f * 3 + 2] === v));
    if (shared.length !== 2) continue;
    const nu = neighbours(u), nvv = neighbours(v);
    let common = 0;
    for (const w of nu) if (nvv.has(w)) common++;
    if (common !== 2) continue;
    // un tetraedro u otra pieza mínima no se colapsa más: el colapso no
    // puede dejar dos caras con los mismos tres vértices
    const seen = new Set();
    let dup = false;
    for (const vtx of [u, v]) for (const f of vf[vtx]) {
      if (!alive[f] || shared.includes(f)) continue;
      const t = [F[f * 3], F[f * 3 + 1], F[f * 3 + 2]].map((x) => (x === v ? u : x)).sort((a, b) => a - b).join(',');
      if (seen.has(t)) { dup = true; break; }
      seen.add(t);
    }
    if (dup) continue;
    // ninguna cara superviviente se voltea ni degenera
    let ok = true;
    for (const vtx of [u, v]) {
      for (const f of vf[vtx]) {
        if (!alive[f] || shared.includes(f)) continue;
        const idx = [F[f * 3], F[f * 3 + 1], F[f * 3 + 2]];
        const l0 = faceNormal(idx[0], idx[1], idx[2], n0);
        const save = [X[vtx * 3], X[vtx * 3 + 1], X[vtx * 3 + 2]];
        X[vtx * 3] = p[0]; X[vtx * 3 + 1] = p[1]; X[vtx * 3 + 2] = p[2];
        const l1 = faceNormal(idx[0], idx[1], idx[2], n1);
        X[vtx * 3] = save[0]; X[vtx * 3 + 1] = save[1]; X[vtx * 3 + 2] = save[2];
        if (l1 < DEGEN || l0 < 1e-14) { ok = false; break; }
        const dot = (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1);
        if (dot < 0.25) { ok = false; break; }
        // nada de astillas: el área no puede caer a casi cero
        let longest = 0;
        for (let k = 0; k < 3; k++) {
          const a = idx[k] === vtx ? p : [X[idx[k] * 3], X[idx[k] * 3 + 1], X[idx[k] * 3 + 2]];
          const bI = idx[(k + 1) % 3], b = bI === vtx ? p : [X[bI * 3], X[bI * 3 + 1], X[bI * 3 + 2]];
          longest = Math.max(longest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        }
        if (l1 / (longest * longest) < 0.02) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // colapso: v se une a u en p
    for (const f of shared) { alive[f] = 0; faces--; }
    for (const f of vf[v]) {
      if (!alive[f]) continue;
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === v) F[f * 3 + k] = u;
      vf[u].push(f);
    }
    vf[v] = [];
    vf[u] = vf[u].filter((f) => alive[f]);
    X[u * 3] = p[0]; X[u * 3 + 1] = p[1]; X[u * 3 + 2] = p[2];
    for (let i = 0; i < 10; i++) Q[u * 10 + i] += Q[v * 10 + i];
    W[u] += W[v];
    locked[u] = locked[u] || locked[v];
    stamp[u]++; stamp[v]++;
    worst = Math.max(worst, cost);
    pushEdges(u);
  }
  // reconstruir primitivas
  const out = prims.map(() => ({ pos: [], faces: [] }));
  const maps = prims.map(() => new Map());
  for (let f = 0; f < nf; f++) {
    if (!alive[f]) continue;
    // red de seguridad: nada degenerado sale del simplificador
    if (cross2(X, F[f * 3], F[f * 3 + 1], F[f * 3 + 2]) < DEGEN) { alive[f] = 0; faces--; continue; }
    const pi = FP[f], o = out[pi], m = maps[pi];
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k];
      let id = m.get(v);
      if (id === undefined) { id = o.pos.length / 3; m.set(v, id); o.pos.push(X[v * 3], X[v * 3 + 1], X[v * 3 + 2]); }
      o.faces.push(id);
    }
  }
  return { prims: out.map((o) => ({ pos: Float64Array.from(o.pos), faces: Int32Array.from(o.faces) })), faces, rms: Math.sqrt(worst) };
}

// ---------- normales con ángulo de pliegue ----------
// Cada esquina promedia (por ángulo) las caras vecinas cuya normal está a
// menos de CREASE de la suya. Las esquinas con la misma normal comparten
// vértice: así sale indexado como el original.
export function creaseNormals({ pos, faces }, crease = CREASE) {
  const nf = faces.length / 3, nv = pos.length / 3;
  const FN = new Float64Array(nf * 3), FA = new Float64Array(nf * 3);
  const vf = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    const e = (i, j) => [pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]];
    const u = e(a, b), v = e(a, c);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n);
    if (!(l >= DEGEN)) throw new Error('cara degenerada en la salida');
    FN.set([n[0] / l, n[1] / l, n[2] / l], f * 3);
    const ang = (i, j, k) => {
      const p = e(i, j), q = e(i, k), lp = Math.hypot(...p), lq = Math.hypot(...q);
      if (!lp || !lq) return 0;
      return Math.acos(Math.max(-1, Math.min(1, (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / (lp * lq))));
    };
    FA.set([ang(a, b, c), ang(b, c, a), ang(c, a, b)], f * 3);
    for (let k = 0; k < 3; k++) vf[faces[f * 3 + k]].push(f);
  }
  const cos = Math.cos(crease);
  const P = [], N = [], I = [];
  const keyMap = new Map();
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      let nx = 0, ny = 0, nz = 0;
      for (const g of vf[v]) {
        const d = FN[f * 3] * FN[g * 3] + FN[f * 3 + 1] * FN[g * 3 + 1] + FN[f * 3 + 2] * FN[g * 3 + 2];
        if (d < cos) continue;
        const kk = faces[g * 3] === v ? 0 : faces[g * 3 + 1] === v ? 1 : 2;
        const w = FA[g * 3 + kk];
        nx += FN[g * 3] * w; ny += FN[g * 3 + 1] * w; nz += FN[g * 3 + 2] * w;
      }
      const l = Math.hypot(nx, ny, nz);
      // sin aporte útil (no debería pasar: la cara propia siempre suma) → normal de la cara
      if (!(l > 1e-9)) { nx = FN[f * 3]; ny = FN[f * 3 + 1]; nz = FN[f * 3 + 2]; } else { nx /= l; ny /= l; nz /= l; }
      const key = `${v}|${Math.round(nx * 1e4)},${Math.round(ny * 1e4)},${Math.round(nz * 1e4)}`;
      let id = keyMap.get(key);
      if (id === undefined) {
        id = P.length / 3; keyMap.set(key, id);
        P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); N.push(nx, ny, nz);
      }
      I.push(id);
    }
  }
  return { P: Float32Array.from(P), N: Float32Array.from(N), I: Uint32Array.from(I) };
}

// ---------- un archivo ----------
export function processFile(srcFile, plan) {
  const { json, accessor } = readGLB(srcFile);
  const src = { tris: 0, verts: 0, degenerate: 0 };
  // Este GLB solo puede traer posición + normal por primitiva. Cualquier otro
  // dato (UV, color, tangentes, skin, morphs, texturas, animación) se
  // perdería: mejor detenerse y avisar que reescribir sin él.
  const fail = (why) => { throw new Error(`${path.basename(srcFile)}: ${why} — el simplificador no lo conserva`); };
  for (const key of ['skins', 'animations', 'textures', 'images', 'samplers', 'cameras']) if (json[key]?.length) fail(`trae ${key}`);
  const extOk = new Set(['KHR_materials_emissive_strength']);
  for (const e of [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]) if (!extOk.has(e)) fail(`extensión ${e}`);
  if ((json.materials?.length ?? 0) !== plan.slots) fail(`${json.materials?.length ?? 0} materiales (se esperaban ${plan.slots})`);
  for (const m of json.meshes) {
    if (m.weights?.length) fail('pesos de morph');
    const used = new Set();
    for (const p of m.primitives) {
      const attrs = Object.keys(p.attributes).sort().join(',');
      if (attrs !== 'NORMAL,POSITION') fail(`atributos ${attrs}`);
      if (p.targets?.length) fail('morph targets');
      if (p.extensions && Object.keys(p.extensions).length) fail('extensiones de primitiva');
      if (p.material == null || p.material >= plan.slots) fail('primitiva sin material válido');
      if (used.has(p.material)) fail('dos primitivas con el mismo material');
      used.add(p.material);
    }
  }
  const meshes = json.meshes.map((m) => m.primitives.map((p) => {
    if ((p.mode ?? 4) !== 4) fail('primitiva que no es de triángulos');
    const P = accessor(p.attributes.POSITION);
    const I = p.indices != null ? accessor(p.indices) : Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
    src.tris += I.length / 3; src.verts += P.length / 3;
    const w = weld(P, I);
    src.degenerate += w.dropped;
    return w;
  }));
  // el presupuesto se reparte por malla según su peso original
  const faceCount = (prims) => prims.reduce((s, p) => s + p.faces.length / 3, 0);
  const valid = meshes.reduce((s, prims) => s + faceCount(prims), 0);
  const results = meshes.map((prims) => {
    return simplify(prims, { tris: Math.round(plan.tris * faceCount(prims) / valid), err: plan.err });
  });
  const chunks = [];
  const out = { tris: 0, verts: 0, rms: 0, degenerate: 0, zeroNormals: 0 };
  json.meshes.forEach((m, mi) => {
    out.rms = Math.max(out.rms, results[mi].rms);
    m.primitives.forEach((p, pi) => {
      const g = creaseNormals(results[mi].prims[pi]);
      const count = g.P.length / 3;
      out.tris += g.I.length / 3; out.verts += count;
      // control final sobre lo que se escribe (float32, como lo lee el juego)
      for (let i = 0; i < g.I.length; i += 3) if (cross2(g.P, g.I[i], g.I[i + 1], g.I[i + 2]) < DEGEN) out.degenerate++;
      for (let i = 0; i < count; i++) {
        const l = Math.hypot(g.N[i * 3], g.N[i * 3 + 1], g.N[i * 3 + 2]);
        if (!Number.isFinite(l) || Math.abs(l - 1) > 1e-3) out.zeroNormals++;
      }
      if (!g.P.every(Number.isFinite)) fail('posición no finita en la salida');
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < g.P.length; i++) { min[i % 3] = Math.min(min[i % 3], g.P[i]); max[i % 3] = Math.max(max[i % 3], g.P[i]); }
      const base = chunks.length;
      chunks.push({ data: g.P, target: 34962, accessor: { componentType: 5126, count, type: 'VEC3', min, max } });
      chunks.push({ data: g.N, target: 34962, accessor: { componentType: 5126, count, type: 'VEC3' } });
      const idx = count < 65536 ? Uint16Array.from(g.I) : g.I;
      chunks.push({ data: idx, target: 34963, accessor: { componentType: idx instanceof Uint16Array ? 5123 : 5125, count: g.I.length, type: 'SCALAR' } });
      p.attributes = { POSITION: base, NORMAL: base + 1 };
      p.indices = base + 2;
    });
  });
  if (out.degenerate || out.zeroNormals) throw new Error(`${path.basename(srcFile)}: ${out.degenerate} caras degeneradas y ${out.zeroNormals} normales inválidas en la salida`);
  json.asset = { ...json.asset, extras: { ...(json.asset.extras || {}), simplified: `scripts/simplify-soldier-art.mjs · ${src.tris} → ${out.tris} tris` } };
  return { json, chunks, src, out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dry = args.includes('--check');
  const names = args.filter((a) => !a.startsWith('--'));
  for (const name of names.length ? names : Object.keys(PLAN)) {
    const plan = PLAN[name];
    if (!plan) throw new Error(`sin plan: ${name}`);
    const t0 = Date.now();
    const r = processFile(path.join(SRC, `${name}.glb`), plan);
    const file = path.join(OUT, `${name}.glb`);
    if (!dry) writeGLB(file, r.json, r.chunks);
    console.log(`${name.padEnd(22)} ${String(r.src.tris).padStart(6)} → ${String(r.out.tris).padStart(6)} tris · ${r.src.verts} → ${r.out.verts} verts · degeneradas ${r.src.degenerate} → ${r.out.degenerate} · normales inválidas ${r.out.zeroNormals} · error RMS ${(r.out.rms * 1000).toFixed(2)} mm · ${Date.now() - t0} ms${dry ? '' : ` · ${fs.statSync(file).size} bytes`}`);
  }
}
