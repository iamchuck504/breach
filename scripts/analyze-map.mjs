// ANÁLISIS DE DISEÑO de un mapa a partir de su geometría jugable compartida
// (la misma que usan el cliente y el servidor). Sin navegador: mide con las
// velocidades y alturas reales del juego, no con la vista aérea.
//
//   node scripts/analyze-map.mjs <mapa> [--ascii] [--json]
//
// Qué mide:
//  - rutas: tiempos de llegada (trote 4.8 m/s, sprint 7.6 m/s) desde cada
//    spawn al arma especial, a las cajas y a media cancha, por equipo
//  - carriles: por cuántos pasos independientes se cruza cada línea z
//  - exposición: qué parte del suelo queda a más de N metros de un cover
//  - spawns: desde qué parte del mapa se ve un punto de aparición, y a qué
//    distancia mínima; salidas distintas del bolsillo de spawn
//  - líneas de tiro: longitudes típicas y máximas
import { expandedCollisionBoxes, collisionBoxesFor, helipadSegments, HELIPAD } from '../src/world/collision-layouts.js';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';
import { pathToFileURL } from 'node:url';

export const DIMS = { fortaleza: [26, 26.6], azoteas: [31.5, 40], calle2: [29, 42], calle: [17, 42] };
const CELL = 0.5, R = 0.38, EYE = 1.5, JOG = 4.8, SPRINT = 7.6;

export function analyze(layout, override = {}) {
  const [fx, fz] = DIMS[layout];
  const rt = { ...MAP_RUNTIME[layout], ...override };
  const boxes = expandedCollisionBoxes(layout).map((b) => ({ ...b, minY: b.minY ?? 0 }));
  // caras de cover reales: cajas con cover (no 'cover:false') de altura táctica
  const coverBoxes = [];
  for (const b of collisionBoxesFor(layout)) {
    if (b.cover === false || b.walkSurface || (b.minY ?? 0) > 0.2 || b.coverBase) continue;
    if (b.h < 1.0 || b.h > 3.05) continue;
    const add = (x, z) => coverBoxes.push({ minx: x - b.w / 2, maxx: x + b.w / 2, minz: z - b.d / 2, maxz: z + b.d / 2, h: b.h });
    add(b.x, b.z);
    if (b.mirror !== false && (b.x !== 0 || b.z !== 0)) add(-b.x, -b.z);
  }
  const segs = layout === 'azoteas' ? helipadSegments() : [];
  const ground = boxes.filter((b) => !b.walkSurface && b.minY < 1.6 && b.h > 0.45);
  const deck = boxes.filter((b) => b.walkSurface);
  const sight = boxes.filter((b) => !b.walkSurface && b.minY < EYE && b.h >= EYE + 0.15);

  const nx = Math.round(fx * 2 / CELL), nz = Math.round(fz * 2 / CELL);
  const X = (i) => -fx + (i + 0.5) * CELL, Z = (j) => -fz + (j + 0.5) * CELL;
  const I = (x) => Math.floor((x + fx) / CELL), J = (z) => Math.floor((z + fz) / CELL);
  const segDist = (x, z, s) => {
    const vx = s.b.x - s.a.x, vz = s.b.z - s.a.z, len2 = vx * vx + vz * vz;
    const t = Math.max(0, Math.min(1, ((x - s.a.x) * vx + (z - s.a.z) * vz) / len2));
    return Math.hypot(x - s.a.x - vx * t, z - s.a.z - vz * t);
  };
  const blocked = (x, z) => {
    for (const b of ground) if (x > b.minx - R && x < b.maxx + R && z > b.minz - R && z < b.maxz + R) return true;
    for (const b of deck) if (x > b.minx && x < b.maxx && z > b.minz && z < b.maxz) return true; // ruta elevada: fuera del análisis de suelo
    for (const s of segs) if (segDist(x, z, s) < R + s.half) return true;
    return false;
  };
  const walk = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) walk[j * nx + i] = blocked(X(i), Z(j)) ? 0 : 1;

  // distancia por el suelo (Dijkstra en 8 direcciones)
  const field = (sources) => {
    const dist = new Float64Array(nx * nz).fill(Infinity);
    const heap = [];
    const push = (d, k) => { heap.push([d, k]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let p = 0; for (;;) { let c = p * 2 + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; p = c; } } return top; };
    for (const s of sources) { const k = J(s.z) * nx + I(s.x); if (walk[k]) { dist[k] = 0; push(0, k); } }
    while (heap.length) {
      const [d, k] = pop(); if (d > dist[k]) continue;
      const i = k % nx, j = (k - i) / nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const q = b * nx + a; if (!walk[q]) continue;
        if (di && dj && (!walk[j * nx + a] || !walk[b * nx + i])) continue;
        const nd = d + (di && dj ? CELL * Math.SQRT2 : CELL);
        if (nd < dist[q]) { dist[q] = nd; push(nd, q); }
      }
    }
    return dist;
  };
  const at = (dist, p) => {
    let best = Infinity;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = I(p.x) + di, j = J(p.z) + dj; if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      best = Math.min(best, dist[j * nx + i] + Math.hypot(X(i) - p.x, Z(j) - p.z));
    }
    return best;
  };
  // línea de visión a la altura de los ojos
  const los = (ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az;
    for (const b of sight) {
      let t0 = 0, t1 = 1;
      if (Math.abs(dx) < 1e-9) { if (ax < b.minx || ax > b.maxx) continue; } else {
        let u = (b.minx - ax) / dx, v = (b.maxx - ax) / dx; if (u > v) [u, v] = [v, u];
        t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) { if (az < b.minz || az > b.maxz) continue; } else {
        let u = (b.minz - az) / dz, v = (b.maxz - az) / dz; if (u > v) [u, v] = [v, u];
        t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) continue;
      }
      return false;
    }
    for (const s of segs) { // baranda del helipuerto: tapa la vista a ras de suelo
      const ex = s.b.x - s.a.x, ez = s.b.z - s.a.z, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((s.a.x - ax) * ez - (s.a.z - az) * ex) / den, u = ((s.a.x - ax) * dz - (s.a.z - az) * dx) / den;
      if (t > 0 && t < 1 && u > 0 && u < 1) return false;
    }
    return true;
  };

  const spawns = { red: [], blue: [] };
  for (let i = 0; i < 4; i++) { const x = -3.6 + i * 2.4; spawns.red.push({ x, z: -rt.spawnZ }); spawns.blue.push({ x: -x, z: rt.spawnZ }); }
  const dRed = field(spawns.red), dBlue = field(spawns.blue);
  const cells = []; let walkable = 0, reachable = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; if (!walk[k]) continue; walkable++; if (dRed[k] < Infinity) { reachable++; cells.push(k); } }

  const time = (d) => ({ m: +d.toFixed(1), jog: +(d / JOG).toFixed(1), sprint: +(d / SPRINT).toFixed(1) });
  const routes = { special: { red: time(at(dRed, rt.special)), blue: time(at(dBlue, rt.special)) }, crates: rt.crates.map((c) => ({ x: c.x, z: c.z, red: time(at(dRed, c)), blue: time(at(dBlue, c)) })) };
  // primer contacto: dónde se encuentran ambos equipos corriendo a la vez
  let contact = Infinity; for (const k of cells) contact = Math.min(contact, Math.max(dRed[k], dBlue[k]));
  routes.firstContact = time(contact);

  // carriles: tramos transitables independientes al cruzar cada línea z
  const lanesAt = (z) => { const j = J(z); const out = []; let start = -1; for (let i = 0; i <= nx; i++) { const ok = i < nx && walk[j * nx + i] && dRed[j * nx + i] < Infinity; if (ok && start < 0) start = i; if (!ok && start >= 0) { out.push([+X(start).toFixed(1), +X(i - 1).toFixed(1)]); start = -1; } } return out; };
  const lanes = {}; for (const f of [0, 0.25, 0.5, 0.75]) { const z = -fz * f; lanes[`z=${z.toFixed(1)}`] = lanesAt(z).map(([a, b]) => `${a}..${b} (${(b - a + CELL).toFixed(1)} m)`); }

  // exposición: distancia de cada celda al cover más cercano
  const coverDist = (x, z) => { let best = Infinity; for (const b of coverBoxes) { const dx = Math.max(b.minx - x, 0, x - b.maxx), dz = Math.max(b.minz - z, 0, z - b.maxz); best = Math.min(best, Math.hypot(dx, dz)); } for (const s of segs) best = Math.min(best, segDist(x, z, s)); return best; };
  let open4 = 0, open7 = 0, sumCover = 0, maxCover = 0;
  for (const k of cells) { const i = k % nx, j = (k - i) / nx; const d = coverDist(X(i), Z(j)); sumCover += d; maxCover = Math.max(maxCover, d); if (d > 4) open4++; if (d > 7) open7++; }
  const exposure = { meanToCover: +(sumCover / cells.length).toFixed(2), maxToCover: +maxCover.toFixed(1), over4m: +(open4 / cells.length * 100).toFixed(1), over7m: +(open7 / cells.length * 100).toFixed(1), coverPieces: coverBoxes.length, coverPer100m2: +(coverBoxes.length / (cells.length * CELL * CELL) * 100).toFixed(2) };

  // spawns: desde dónde se ve un punto de aparición rojo (el azul es su espejo)
  const sample = cells.filter((k) => { const i = k % nx, j = (k - i) / nx; return i % 2 === 0 && j % 2 === 0; });
  let seen = 0, nearest = Infinity, farSeen = 0, seenEnemyHalf = 0, enemyHalf = 0;
  for (const k of sample) {
    const i = k % nx, j = (k - i) / nx, x = X(i), z = Z(j);
    const far = z > -rt.spawnZ + 12; // fuera del bolsillo propio
    if (z > 0) enemyHalf++;
    let sees = false;
    for (const s of spawns.red) if (los(x, z, s.x, s.z)) { sees = true; if (far) nearest = Math.min(nearest, Math.hypot(x - s.x, z - s.z)); }
    if (sees) { seen++; if (far) farSeen++; if (z > 0) seenEnemyHalf++; }
  }
  // salidas del bolsillo: tramos transitables a 9 m delante del spawn
  const exits = lanesAt(-rt.spawnZ + 9);
  const spawn = { visibleFromPct: +(seen / sample.length * 100).toFixed(1), visibleFromOutsidePocketPct: +(farSeen / sample.length * 100).toFixed(1), visibleFromEnemyHalfPct: +(seenEnemyHalf / Math.max(1, enemyHalf) * 100).toFixed(1), nearestSightOutsidePocket: Number.isFinite(nearest) ? +nearest.toFixed(1) : null, exits: exits.map(([a, b]) => `${a}..${b}`) };

  // líneas de tiro: longitud libre en 16 direcciones desde una muestra
  const lens = [];
  for (const k of sample) {
    const i = k % nx, j = (k - i) / nx, x = X(i), z = Z(j);
    for (let a = 0; a < 16; a++) {
      const ux = Math.cos(a * Math.PI / 8), uz = Math.sin(a * Math.PI / 8); let len = 0;
      for (let d = 1; d < 120; d += 1) { const px = x + ux * d, pz = z + uz * d; if (Math.abs(px) > fx || Math.abs(pz) > fz || !los(x, z, px, pz)) break; len = d; }
      lens.push(len);
    }
  }
  lens.sort((a, b) => a - b);
  const pct = (p) => lens[Math.floor(lens.length * p)];
  const sightlines = { median: pct(0.5), p90: pct(0.9), max: lens[lens.length - 1], close: +(lens.filter((l) => l < 10).length / lens.length * 100).toFixed(0), mid: +(lens.filter((l) => l >= 10 && l < 28).length / lens.length * 100).toFixed(0), long: +(lens.filter((l) => l >= 28).length / lens.length * 100).toFixed(0) };

  // simetría de juego: diferencia de tiempos entre equipos
  const fair = { special: +Math.abs(routes.special.red.m - routes.special.blue.m).toFixed(2), unreachableWalkable: walkable - reachable };

  const ascii = () => {
    const rows = [];
    for (let j = nz - 1; j >= 0; j -= 2) {
      let row = '';
      for (let i = 0; i < nx; i += 1) {
        const x = X(i), z = Z(j); let c = walk[j * nx + i] ? (dRed[j * nx + i] < Infinity ? '.' : '?') : ' ';
        if (!walk[j * nx + i]) { let h = 0; for (const b of ground) if (x > b.minx && x < b.maxx && z > b.minz && z < b.maxz) h = Math.max(h, b.h); c = h >= 2.9 ? '#' : h >= 1.8 ? 'M' : h > 0 ? 'o' : (deck.some((b) => x > b.minx && x < b.maxx && z > b.minz && z < b.maxz) ? '=' : ':'); }
        if (c === '.' && coverDist(x, z) > 4) c = '+';
        if ((c === '.' || c === '+') && z > -rt.spawnZ + 12 && spawns.red.some((s) => los(x, z, s.x, s.z))) c = '!';
        if (Math.hypot(x - rt.special.x, z - rt.special.z) < 0.5) c = 'S';
        for (const cr of rt.crates) if (Math.hypot(x - cr.x, z - cr.z) < 0.5) c = 'A';
        for (const s of spawns.red) if (Math.hypot(x - s.x, z - s.z) < 0.4) c = 'r';
        for (const s of spawns.blue) if (Math.hypot(x - s.x, z - s.z) < 0.4) c = 'b';
        row += c;
      }
      rows.push(row);
    }
    return rows.join('\n');
  };
  return { layout, size: `${fx * 2}x${fz * 2}`, walkableM2: Math.round(cells.length * CELL * CELL), routes, lanes, exposure, spawn, sightlines, fair, ascii };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const layout = process.argv[2] || 'fortaleza';
  const r = analyze(layout);
  if (process.argv.includes('--ascii')) console.log(r.ascii());
  const { ascii, ...data } = r;
  console.log(JSON.stringify(data, null, process.argv.includes('--json') ? 0 : 1));
}
