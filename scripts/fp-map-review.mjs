// REVISIÓN DE MAPAS A LA ALTURA DE LOS OJOS (corrida 6, FPS). Sin navegador.
//
//   node scripts/fp-map-review.mjs [fortaleza|azoteas|calle2 ...] [--out=dir] [--quick]
//
// Mide cada mapa con las MISMAS piezas que usa el juego:
//  - geometría: World (builder real, sin mallas) + manifiesto compartido; la
//    línea de visión se valida contra `firstMapIntersection` del servidor
//  - ojo y cabeza: `eyeWorld` / `hitPose` de src/combat/hit-pose.js (de pie,
//    agachado, inclinado, asomo), así "el ojo de A ve la cabeza de B" se
//    calcula, no se estima
//  - movimiento: radio 0.38, escalón 0.16, salto (apex 1.28), trepar solo LOW
//    con las comprobaciones de Controller._tryMantle
// Escribe <out>/<mapa>.json (métricas y listas) y <out>/<mapa>.svg (planta).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { World } from '../src/world/world.js';
import { MAP_DIMS } from '../src/world/map-dims.js';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';
import { BLOCK } from '../src/world/block-heights.js';
import { expandedCollisionBoxes, helipadSegments, HELIPAD } from '../src/world/collision-layouts.js';
import { firstMapIntersection } from '../server/map-geometry.js';
import { hitPose, eyeWorld, placeHitPose } from '../src/combat/hit-pose.js';
import { TUNING } from '../src/config/tuning.js';

const R = 0.38, STEP = TUNING.move.maxStepUp, BODY = 1.63;
const JUMP_UP = TUNING.jump.vel ** 2 / (2 * TUNING.jump.gravity) + 0.05; // apex 1.28 + holgura de resolveCircle
const CELL = 0.5;
const POSES = {
  stand: { st: 'idle' },
  crouch: { st: 'crouch', ce: 0 },
  peek: { st: 'crouch', ce: 1, aim: true },
  leanL: { st: 'idle', cl: -1 },
  leanR: { st: 'idle', cl: 1 },
  crouchL: { st: 'crouch', ce: 0, cl: -1 },
  crouchR: { st: 'crouch', ce: 0, cl: 1 },
};

// ---------- mundo sin mallas (mismo truco que check-collision-baseline) ----------
export function headlessWorld(layout) {
  const [fx, fz] = MAP_DIMS[layout];
  const world = Object.assign(Object.create(World.prototype), {
    layout, fx, fz, colliders: [], segmentColliders: [], faces: [], surfaceZones: [],
    spawns: { red: [], blue: [] },
    _decorFortaleza() {}, _decorAzoteas() {}, _decorCalle() {},
    _box(x, z, w, d, h, options) { World.prototype._box.call(this, x, z, w, d, h, { ...options, visual: false }); },
  });
  world._runBuilder(layout); world._buildSpawns();
  return world;
}

// ---------- línea de visión rápida (cubos 2D) validada contra el servidor ----------
function makeLOS(layout) {
  const boxes = expandedCollisionBoxes(layout).filter((b) => !b.moveOnly);
  const n = boxes.length, B = new Float64Array(n * 6);
  boxes.forEach((b, i) => B.set([b.minx, b.maxx, b.minY ?? -0.1, b.h, b.minz, b.maxz], i * 6));
  const [fx, fz] = MAP_DIMS[layout], S = 2, pad = 1.2;
  const gx = Math.ceil((fx * 2 + 30) / S), gz = Math.ceil((fz * 2 + 30) / S), ox = fx + 15, oz = fz + 15;
  const grid = Array.from({ length: gx * gz }, () => []);
  boxes.forEach((b, i) => {
    for (let j = Math.max(0, Math.floor((b.minz - pad + oz) / S)); j <= Math.min(gz - 1, Math.floor((b.maxz + pad + oz) / S)); j++)
      for (let k = Math.max(0, Math.floor((b.minx - pad + ox) / S)); k <= Math.min(gx - 1, Math.floor((b.maxx + pad + ox) / S)); k++) grid[j * gx + k].push(i);
  });
  const stamp = new Int32Array(n); let ray = 0;
  const heli = layout === 'azoteas';
  // ¿el segmento a→b (t en [0, 1-tail]) toca geometría?
  function blocked(a, b, tail = 0) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return false;
    const tmax = 1 - tail / L;
    if (heli) {
      // cerca del helipuerto: la rutina exacta del servidor (barandas, losa y rampas)
      const t = Math.max(0, Math.min(1, -(a[0] * dx + a[2] * dz) / Math.max(1e-9, dx * dx + dz * dz)));
      if (Math.hypot(a[0] + dx * t, a[2] + dz * t) < 12) {
        const hit = firstMapIntersection(layout, { x: a[0], y: a[1], z: a[2] }, { x: dx / L, y: dy / L, z: dz / L }, L * tmax);
        return hit !== null;
      }
    }
    ray++;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 1.0));
    for (let s = 0; s <= steps; s++) {
      const x = a[0] + dx * s / steps, z = a[2] + dz * s / steps;
      const k = Math.floor((x + ox) / S), j = Math.floor((z + oz) / S);
      if (k < 0 || j < 0 || k >= gx || j >= gz) continue;
      for (const i of grid[j * gx + k]) {
        if (stamp[i] === ray) continue; stamp[i] = ray;
        const o = i * 6;
        let t0 = 0.0001 / L, t1 = tmax, ok = true;
        for (const [p, d, lo, hi] of [[a[0], dx, B[o], B[o + 1]], [a[1], dy, B[o + 2], B[o + 3]], [a[2], dz, B[o + 4], B[o + 5]]]) {
          if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) { ok = false; break; } continue; }
          let u = (lo - p) / d, v = (hi - p) / d; if (u > v) [u, v] = [v, u];
          if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  }
  // el caso inverso de la rutina rápida: ¿qué caja tapa primero? (para "tapa un LOW")
  function firstBox(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    let best = null, bt = Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 6; let t0 = 0.0001, t1 = 1, ok = true;
      for (const [p, d, lo, hi] of [[a[0], dx, B[o], B[o + 1]], [a[1], dy, B[o + 2], B[o + 3]], [a[2], dz, B[o + 4], B[o + 5]]]) {
        if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) { ok = false; break; } continue; }
        let u = (lo - p) / d, v = (hi - p) / d; if (u > v) [u, v] = [v, u];
        if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) { ok = false; break; }
      }
      if (ok && t0 < bt) { bt = t0; best = boxes[i]; }
    }
    return best;
  }
  return { blocked, firstBox, boxes };
}

// ---------- alcance del jugador (andar, caer, saltar) ----------
function reach(world, { jump = true } = {}) {
  const fx = world.fx, fz = world.fz;
  const nx = Math.ceil(fx * 2 / CELL), nz = Math.ceil(fz * 2 / CELL);
  const cols = world.colliders.filter((c) => !c.walkSurface), segs = world.segmentColliders;
  const S = 4, bx = Math.ceil(fx * 2 / S) + 2, bz = Math.ceil(fz * 2 / S) + 2, buckets = Array.from({ length: bx * bz }, () => []);
  for (const c of cols) for (let j = Math.max(0, Math.floor((c.minz - 1 + fz) / S) + 1); j <= Math.min(bz - 1, Math.floor((c.maxz + 1 + fz) / S) + 1); j++)
    for (let i = Math.max(0, Math.floor((c.minx - 1 + fx) / S) + 1); i <= Math.min(bx - 1, Math.floor((c.maxx + 1 + fx) / S) + 1); i++) buckets[j * bx + i].push(c);
  const near = (x, z) => { const i = Math.floor((x + fx) / S) + 1, j = Math.floor((z + fz) / S) + 1; return i < 0 || j < 0 || i >= bx || j >= bz ? [] : buckets[j * bx + i]; };
  const blocked = (x, z, y, r = R) => {
    if (Math.abs(x) > fx - r || Math.abs(z) > fz - r) return true;
    for (const c of near(x, z)) {
      if (y >= c.h - 0.05) continue;
      if (c.minY !== undefined && y + BODY <= c.minY + 0.02) continue;
      const dx = x - Math.max(c.minx, Math.min(c.maxx, x)), dz = z - Math.max(c.minz, Math.min(c.maxz, z));
      if (dx * dx + dz * dz < r * r) return true;
    }
    for (const s of segs) {
      if (y >= s.h - 0.05) continue;
      const tx = s.b.x - s.a.x, tz = s.b.z - s.a.z, l2 = tx * tx + tz * tz;
      const u = Math.max(0, Math.min(1, ((x - s.a.x) * tx + (z - s.a.z) * tz) / l2));
      const dx = x - (s.a.x + tx * u), dz = z - (s.a.z + tz * u), rr = r + s.half;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  };
  const ground = (x, z, y) => {
    let g = world.baseGround({ x, z }, R);
    const m = R / 2;
    for (const c of near(x, z)) {
      if (c.h > y + 0.25 || c.h <= g) continue;
      if (x + m < c.minx || x - m > c.maxx || z + m < c.minz || z - m > c.maxz) continue;
      g = c.h;
    }
    return g;
  };
  // tramo a→b: devuelve [altura de llegada, salto?] o null
  const walk = (ax, az, ay, bx2, bz2) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx2 - ax, bz2 - az) / 0.125));
    let y = ay, jumped = false;
    for (let i = 1; i <= n; i++) {
      const x = ax + (bx2 - ax) * i / n, z = az + (bz2 - az) * i / n;
      let g = ground(x, z, y);
      if (g - y > STEP) {
        if (!jump) return null;
        // salto: el cuerpo pasa por encima si la cima llega y el techo lo deja
        const top = y + JUMP_UP;
        g = ground(x, z, top);
        if (g - y > JUMP_UP - 0.05 || g - y <= STEP) return null;
        if (world.ceilingHeight({ x, z }, R, y) < g + BODY) return null;
        if (blocked(x, z, g)) return null;
        jumped = true;
      }
      if (blocked(x, z, Math.max(y, g)) && blocked(x, z, g)) return null;
      y = g;
    }
    return [y, jumped];
  };
  const height = new Float32Array(nx * nz).fill(NaN), stack = [];
  const centre = (i, j) => [-fx + (i + 0.5) * CELL, -fz + (j + 0.5) * CELL];
  for (const s of [...world.spawns.red, ...world.spawns.blue]) {
    const i = Math.floor((s.x + fx) / CELL), j = Math.floor((s.z + fz) / CELL), k = j * nx + i;
    const [x, z] = centre(i, j), y = ground(x, z, 0);
    if (!blocked(x, z, y)) { height[k] = y; stack.push(k); }
  }
  const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (stack.length) {
    const k = stack.pop(), i = k % nx, j = (k - i) / nx, [x, z] = centre(i, j), y = height[k];
    for (const [di, dj] of D4) {
      const i2 = i + di, j2 = j + dj; if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
      const k2 = j2 * nx + i2; if (!Number.isNaN(height[k2])) continue;
      const [x2, z2] = centre(i2, j2), got = walk(x, z, y, x2, z2);
      if (!got) continue;
      height[k2] = got[0]; stack.push(k2);
    }
  }
  return { nx, nz, height, centre, blocked, ground, walk, fx, fz,
    idx: (x, z) => { const i = Math.floor((x + fx) / CELL), j = Math.floor((z + fz) / CELL); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; } };
}

// Dijkstra 8-vecinos sobre la rejilla alcanzada (con los mismos tramos)
function paths(rc, sources) {
  const { nx, nz, height, centre, walk } = rc;
  const dist = new Float64Array(nx * nz).fill(Infinity), prev = new Int32Array(nx * nz).fill(-1);
  const heap = [];
  const push = (d, k) => { heap.push([d, k]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let p = 0; for (;;) { let c = p * 2 + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; p = c; } } return top; };
  for (const k of sources) if (k >= 0 && !Number.isNaN(height[k])) { dist[k] = 0; push(0, k); }
  const link = new Map();
  while (heap.length) {
    const [d, k] = pop(); if (d > dist[k]) continue;
    const i = k % nx, j = (k - i) / nx, [x, z] = centre(i, j);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const i2 = i + di, j2 = j + dj; if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= nz) continue;
      const k2 = j2 * nx + i2; if (Number.isNaN(height[k2])) continue;
      const key = k * 9 + (dj + 1) * 3 + di + 1;
      let got = link.get(key);
      if (got === undefined) { const [x2, z2] = centre(i2, j2); const w = walk(x, z, height[k], x2, z2); got = w && Math.abs(w[0] - height[k2]) < 0.05 ? (w[1] ? 2 : 1) : 0; link.set(key, got); }
      if (!got) continue;
      const nd = d + (di && dj ? CELL * Math.SQRT2 : CELL) + (got === 2 ? 0.6 : 0);
      if (nd < dist[k2]) { dist[k2] = nd; prev[k2] = k; push(nd, k2); }
    }
  }
  return { dist, prev };
}
const trace = (prev, k) => { const out = []; while (k >= 0) { out.push(k); k = prev[k]; } return out.reverse(); };

// ---------- volumen y ojo ----------
const yawTo = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2])); // facing (-sin, -cos)
function eyeAt(pose, x, y, z, yaw) { return eyeWorld(pose, x, y, z, yaw); }
// muestras del volumen de impacto: centro y tope de cabeza, lados, pecho y cadera
function volumeSamples(pose, x, y, z, yaw) {
  const v = placeHitPose(hitPose(pose), x, y, z, yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw), r = v.hr * 0.8;
  return [
    [v.hx, v.hy, v.hz], [v.hx, v.hy + r, v.hz], [v.hx + rx * r, v.hy, v.hz + rz * r], [v.hx - rx * r, v.hy, v.hz - rz * r],
    [v.bx, v.by, v.bz], [(v.ax + v.bx) / 2, (v.ay + v.by) / 2, (v.az + v.bz) / 2],
  ];
}
const headSamples = (pose, x, y, z, yaw) => volumeSamples(pose, x, y, z, yaw).slice(0, 4);

export function review(layout, { quick = false } = {}) {
  const world = headlessWorld(layout);
  const los = makeLOS(layout);
  const rt = MAP_RUNTIME[layout];
  const rc = reach(world), walkOnly = reach(world, { jump: false });
  const { nx, nz, height, centre } = rc;
  const cells = [];
  for (let k = 0; k < nx * nz; k++) if (!Number.isNaN(height[k])) cells.push(k);
  const P = (k) => { const [x, z] = centre(k % nx, Math.floor(k / nx)); return [x, height[k], z]; };

  // validación: la LOS rápida coincide con la del servidor
  let mismatch = 0, checked = 0;
  { let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < (quick ? 2000 : 12000); t++) {
      const a = P(cells[Math.floor(rnd() * cells.length)]), b = P(cells[Math.floor(rnd() * cells.length)]);
      const A = [a[0], a[1] + 0.3 + rnd() * 1.6, a[2]], Bp = [b[0], b[1] + 0.3 + rnd() * 1.6, b[2]];
      const L = Math.hypot(Bp[0] - A[0], Bp[1] - A[1], Bp[2] - A[2]); if (L < 0.5) continue;
      const d = { x: (Bp[0] - A[0]) / L, y: (Bp[1] - A[1]) / L, z: (Bp[2] - A[2]) / L };
      const exact = firstMapIntersection(layout, { x: A[0], y: A[1], z: A[2] }, d, L) !== null;
      checked++; if (exact !== los.blocked(A, Bp)) mismatch++;
    } }

  // ---- posiciones de muestra (cada 2 m) ----
  const step = quick ? 6 : 4;
  const sample = cells.filter((k) => { const i = k % nx, j = Math.floor(k / nx); return i % step === 0 && j % step === 0; });
  // máscara de muestras del volumen de B que ve el ojo de A (bits: 0 centro de
  // cabeza, 1 tope, 2-3 lados, 4 pecho, 5 cadera)
  const mask = (aPose, a, bPose, b) => {
    const e = eyeAt(aPose, a[0], a[1], a[2], yawTo(a, b));
    let m = 0;
    volumeSamples(bPose, b[0], b[1], b[2], yawTo(b, a)).forEach((p, i) => { if (!los.blocked(e, p)) m |= 1 << i; });
    return m;
  };
  const CENTER = 1 | 16 | 32;
  const seesHead = (aPose, a, bPose, b) => {
    const e = eyeAt(aPose, a[0], a[1], a[2], yawTo(a, b));
    for (const p of headSamples(bPose, b[0], b[1], b[2], yawTo(b, a))) if (!los.blocked(e, p)) return true;
    return false;
  };

  // ---- 1. spawns ----
  const spawnRed = world.spawns.red.map((s) => [s.x, 0, s.z]);
  const pocket = (p) => spawnRed.some((s) => Math.hypot(p[0] - s[0], p[2] - s[2]) < 12);
  const enemyHalf = (p) => p[2] > 0;
  const spawn = { cellsChecked: 0, seeStanding: 0, seeFromEnemyHalf: 0, enemyHalf: 0, overLow: 0, list: [], overLowList: [] };
  for (const k of cells) {
    const p = P(k); if (pocket(p)) continue;
    const i = k % nx, j = Math.floor(k / nx); if (i % 2 || j % 2) continue; // 1 m
    spawn.cellsChecked++; if (enemyHalf(p)) spawn.enemyHalf++;
    let stand = false, crouch = false, lowOnly = false;
    for (const s of spawnRed) {
      if (seesHead(POSES.stand, p, POSES.stand, s)) {
        stand = true;
        if (!seesHead(POSES.crouch, p, POSES.stand, s)) {
          const e = eyeAt(POSES.crouch, p[0], p[1], p[2], yawTo(p, s)), hb = headSamples(POSES.stand, s[0], s[1], s[2], 0)[0];
          const b = los.firstBox(e, hb); if (b && b.h - (b.minY ?? 0) <= BLOCK.LOW + 0.45 && b.h <= p[1] + 1.6) lowOnly = true;
        } else crouch = true;
      }
    }
    if (stand) { spawn.seeStanding++; if (enemyHalf(p)) { spawn.seeFromEnemyHalf++; spawn.list.push(p.map((v) => +v.toFixed(1))); } }
    if (stand && lowOnly && !crouch) { spawn.overLow++; spawn.overLowList.push(p.map((v) => +v.toFixed(1))); }
  }
  spawn.seenPct = +(spawn.seeStanding / spawn.cellsChecked * 100).toFixed(2);
  spawn.seenFromEnemyHalfPct = +(spawn.seeFromEnemyHalf / Math.max(1, spawn.enemyHalf) * 100).toFixed(2);

  // salida del spawn: cada celda a ≤ 10 m de ruta de un spawn rojo — ¿cuántas
  // posiciones de la mitad rival ven su cabeza de pie?
  const fromRed = paths(rc, spawnRed.map((s) => rc.idx(s[0], s[2])));
  const fromBlue = paths(rc, world.spawns.blue.map((s) => rc.idx(s.x, s.z)));
  const enemyPositions = sample.filter((k) => enemyHalf(P(k)));
  const exit = { cells: 0, exposed: 0, worst: [] };
  for (const k of cells) {
    if (!(fromRed.dist[k] <= 14)) continue;
    const i = k % nx, j = Math.floor(k / nx); if (i % 2 || j % 2) continue;
    const p = P(k); exit.cells++;
    let n = 0; for (const q of enemyPositions) if (seesHead(POSES.stand, P(q), POSES.stand, p)) n++;
    if (n) { exit.exposed++; exit.worst.push([n, p.map((v) => +v.toFixed(1)), +fromRed.dist[k].toFixed(1)]); }
  }
  exit.worst.sort((a, b) => b[0] - a[0]); exit.worst = exit.worst.slice(0, 12);
  exit.exposedPct = +(exit.exposed / Math.max(1, exit.cells) * 100).toFixed(1);

  // ---- 2. rutas principales ----
  const lanes = { fortaleza: [[0, 0], [-33, 0], [33, 0], [-23.7, 0], [23.7, 0]], azoteas: [[0, 0], [-45, 0], [45, 0], [-24, 0], [24, 0]], calle2: [[0, 0], [-25, 0], [25, 0], [-35, 0], [35, 0]] }[layout] || [[0, 0]];
  const faces = world.faces.filter((f) => (f.topY ?? f.h) - (f.baseY ?? 0) >= 1.0);
  const nearCover = (p, rad = 2.5) => {
    for (const f of faces) {
      if ((f.baseY ?? 0) > p[1] + 0.3 || (f.topY ?? f.h) < p[1] + BLOCK.LOW - 0.05) continue;
      const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z, l2 = tx * tx + tz * tz;
      const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - f.a.x) * tx + (p[2] - f.a.z) * tz) / l2)) : 0;
      const dx = p[0] - (f.a.x + tx * u), dz = p[2] - (f.a.z + tz * u);
      if (dx * f.n.x + dz * f.n.z < -0.05) continue;
      if (Math.hypot(dx, dz) <= rad) return true;
    }
    return false;
  };
  const routes = [];
  const enemySample = sample;
  for (const [wx, wz] of lanes) {
    const w = rc.idx(wx, wz);
    if (w < 0 || Number.isNaN(height[w])) { routes.push({ via: [wx, wz], error: 'waypoint unreachable' }); continue; }
    const a = trace(fromRed.prev, w), b = trace(fromBlue.prev, w).reverse();
    const route = [...a, ...b.slice(1)];
    let run = 0, worst = 0, worstAt = null, start = null, last = null, len = 0, maxStep = 0, steps = 0, exposedRun = 0, worstExposed = 0, worstExposedAt = null, estart = null;
    for (const k of route) {
      const p = P(k);
      const d = last ? Math.hypot(p[0] - last[0], p[2] - last[2]) : 0; len += d;
      if (last) { const dy = Math.abs(p[1] - last[1]); if (dy > 0.05 && dy <= 0.6) { steps++; maxStep = Math.max(maxStep, dy); } }
      const covered = nearCover(p);
      if (!covered) { if (!run) start = p; run += d; if (run > worst) { worst = run; worstAt = [start, p].map((q) => q.map((v) => +v.toFixed(1))); } }
      else run = 0;
      // tramo descubierto Y a la vista de alguna posición (cabeza de pie)
      let seen = false;
      if (!covered) { for (const q of enemySample) { const qp = P(q); if (Math.hypot(qp[0] - p[0], qp[2] - p[2]) < 6) continue; if (seesHead(POSES.stand, qp, POSES.stand, p)) { seen = true; break; } } }
      if (!covered && seen) { if (!exposedRun) estart = p; exposedRun += d; if (exposedRun > worstExposed) { worstExposed = exposedRun; worstExposedAt = [estart, p].map((q) => q.map((v) => +v.toFixed(1))); } }
      else exposedRun = 0;
      last = p;
    }
    routes.push({ via: [wx, wz], length: +len.toFixed(1), longestUncovered: +worst.toFixed(1), uncoveredAt: worstAt, longestUncoveredSeen: +worstExposed.toFixed(1), uncoveredSeenAt: worstExposedAt, steps, maxStep: +maxStep.toFixed(2),
      path: route.filter((_, i) => i % 4 === 0).map((k) => { const p = P(k); return [+p[0].toFixed(1), +p[2].toFixed(1)]; }) });
  }

  // ---- 3. pares: líneas de tiro, dominancia, "me dan y no veo" ----
  const pos = sample.map(P);
  const N = pos.length;
  const seeCount = new Int32Array(N), seenCount = new Int32Array(N), sbcs = new Int32Array(N), sbcsCrouch = new Int32Array(N);
  let longest = [0, null, null]; const hist = { lt10: 0, lt28: 0, lt50: 0, ge50: 0 }; const occluders = {};
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    const pa = pos[a], pb = pos[b], d = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
    if (d < 4) continue;
    const ab = seesHead(POSES.stand, pa, POSES.stand, pb);
    const ba = seesHead(POSES.stand, pb, POSES.stand, pa);
    if (ab) { seeCount[a]++; seenCount[b]++; }
    if (ba) { seeCount[b]++; seenCount[a]++; }
    if (ab || ba) {
      if (d > longest[0]) longest = [d, pa, pb];
      if (d < 10) hist.lt10++; else if (d < 28) hist.lt28++; else if (d < 50) hist.lt50++; else hist.ge50++;
    }
    // asimetría: A le da a B en el centro (cabeza, pecho o cadera) y el ojo
    // de B no ve NINGUNA parte de A. Un casco que asoma 2 cm no cuenta.
    if (d < 6) continue;
    for (const [px, py, y] of [[pa, pb, b], [pb, pa, a]]) {
      if ((mask(POSES.stand, px, POSES.stand, py) & CENTER) && !mask(POSES.stand, py, POSES.stand, px)) {
        sbcs[y]++;
        // ¿qué tapa el ojo de B? (altura del tope: las de 1.48–1.74 son la trampa)
        const e = eyeAt(POSES.stand, py[0], py[1], py[2], yawTo(py, px)), h = volumeSamples(POSES.stand, px[0], px[1], px[2], yawTo(px, py))[0];
        const occ = los.firstBox(e, h), key = occ ? (occ.h - py[1]).toFixed(2) : 'helipad';
        occluders[key] = (occluders[key] ?? 0) + 1;
      }
      if ((mask(POSES.stand, px, POSES.crouch, py) & CENTER) && !mask(POSES.crouch, py, POSES.stand, px)) sbcsCrouch[y]++;
    }
  }
  const pairs = hist.lt10 + hist.lt28 + hist.lt50 + hist.ge50;
  const sight = { positions: N, longest: +longest[0].toFixed(1), longestPair: [longest[1], longest[2]].map((p) => p && p.map((v) => +v.toFixed(1))),
    closePct: +(hist.lt10 / pairs * 100).toFixed(1), midPct: +(hist.lt28 / pairs * 100).toFixed(1), longPct: +(hist.lt50 / pairs * 100).toFixed(1), veryLongPct: +(hist.ge50 / pairs * 100).toFixed(1) };
  const rank = (arr, n = 10, f = () => true) => [...arr.keys()].filter(f).sort((x, y) => arr[y] - arr[x]).slice(0, n).map((i) => ({ at: pos[i].map((v) => +v.toFixed(1)), n: arr[i], sees: seeCount[i], seen: seenCount[i] }));
  const sbcsSpots = { occluders, threshold: 1, stand: [...sbcs].filter((v) => v >= 1).length, crouch: [...sbcsCrouch].filter((v) => v >= 1).length,
    worstStand: rank(sbcs, 10), worstCrouch: rank(sbcsCrouch, 10) };
  // dominancia: ve mucho y lo ven poco (ratio), sólo con suficiente muestra
  const dom = [...pos.keys()].filter((i) => seeCount[i] >= N * 0.08)
    .map((i) => ({ i, r: seeCount[i] / Math.max(1, seenCount[i]) })).sort((x, y) => y.r - x.r).slice(0, 10)
    .map(({ i, r }) => ({ at: pos[i].map((v) => +v.toFixed(1)), sees: seeCount[i], seen: seenCount[i], ratio: +r.toFixed(2) }));
  const topSee = rank(seeCount, 8);

  // ---- 3b. ¿la cobertura cubre a la altura nueva? ----
  // LOW: agachado pegado a la cara, ¿qué parte de las posiciones del otro lado
  // (a 4-45 m) le ve el centro (cabeza, pecho o cadera)? MID: lo mismo de pie.
  // MID además: ¿se puede asomar inclinado por algún extremo o es un tapón?
  const coverFaces = world.faces.filter((f) => !(f.baseY > 0.2) && (f.kind === 'low' || f.kind === 'medium'));
  const cover = { low: { faces: 0, leaky: [] }, mid: { faces: 0, leaky: [], deadEnds: [] } };
  const tall = world.colliders.filter((c) => !c.walkSurface && c.h >= 1.5 && !(c.minY > 1.2));
  for (const f of coverFaces) {
    // Solo caras más anchas que un cuerpo agachado (radio 0.42 → 0.84 m +
    // holgura). La testa de 0.9 m de un bloque LOW (fortaleza −26.5,−33.4;
    // calle2 ±7.7,±33.4) no promete tapar un cono de 60°: tapa el costado
    // largo; sus rayos rozan el canto y "fugaban" sin ser un defecto.
    const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z, len = Math.hypot(tx, tz); if (len < 1.2) continue;
    const ux = tx / len, uz = tz / len, low = f.kind === 'low';
    const bx = (f.a.x + f.b.x) / 2 + f.n.x * (R + 0.05), bz = (f.a.z + f.b.z) / 2 + f.n.z * (R + 0.05);
    const k = rc.idx(bx, bz); if (k < 0 || Number.isNaN(height[k]) || height[k] > 0.2) continue;
    if (rc.blocked(bx, bz, 0)) continue;
    const B = [bx, 0, bz], bucket = low ? cover.low : cover.mid; bucket.faces++;
    let seen = 0, total = 0;
    for (const q of pos) {
      const s = (q[0] - bx) * f.n.x + (q[2] - bz) * f.n.z, dd = Math.hypot(q[0] - bx, q[2] - bz);
      // cono de 60° detrás de la cara: lo que la cobertura promete tapar
      if (s > -3 || dd > 45 || -s / dd < 0.5) continue;
      total++;
      if (mask(POSES.stand, q, low ? POSES.crouch : POSES.stand, B) & CENTER) seen++;
    }
    const pct = total ? seen / total * 100 : 0;
    if (total >= 10 && pct > 20) bucket.leaky.push({ at: [+bx.toFixed(1), +bz.toFixed(1)], n: f.n, pct: +pct.toFixed(0), of: total });
    if (!low) {
      // extremos: un paso más allá de cada punta, ¿hay algo alto pegado?
      let open = 0;
      for (const end of [f.a, f.b]) {
        const sgn = end === f.a ? -1 : 1;
        const ex = end.x + ux * sgn * 0.45 + f.n.x * 0.5, ez = end.z + uz * sgn * 0.45 + f.n.z * 0.5;
        if (!tall.some((c) => ex > c.minx - 0.05 && ex < c.maxx + 0.05 && ez > c.minz - 0.05 && ez < c.maxz + 0.05)) open++;
      }
      if (!open) bucket.deadEnds.push({ at: [+bx.toFixed(1), +bz.toFixed(1)], n: f.n, len: +len.toFixed(1) });
    }
  }

  // ---- 4. geometría ----
  // 4a. trepar: cada cara LOW (tope 0.5..1.4 sobre su base) muestreada cada 0.5 m
  const mantle = { faces: 0, samples: 0, ok: 0, failAt: [], fail: { blockedBehind: 0, landing: 0, ceiling: 0 }, oneSided: [], newArea: [], lowCeiling: [] };
  const mantleFaces = world.faces.filter((f) => f.kind !== 'high' && ((f.topY ?? f.h) - (f.baseY ?? 0)) >= TUNING.fp.mantleMinH && ((f.topY ?? f.h) - (f.baseY ?? 0)) <= TUNING.fp.mantleMaxH);
  const faceResult = new Map();
  for (const f of mantleFaces) {
    mantle.faces++;
    const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z, len = Math.hypot(tx, tz);
    let ok = 0, tried = 0;
    for (let u = 0.25; u < len - 0.2; u += 0.5) {
      const fxp = f.a.x + tx * u / len, fzp = f.a.z + tz * u / len;
      const px = fxp + f.n.x * (R + 0.2), pz = fzp + f.n.z * (R + 0.2), base = f.baseY ?? 0;
      const k = rc.idx(px, pz); if (k < 0 || Number.isNaN(height[k]) || Math.abs(height[k] - base) > 0.2) continue;
      if (rc.blocked(px, pz, base)) continue;
      tried++; mantle.samples++;
      const h = f.topY ?? f.h, side = R + 0.2;
      const lx = px - f.n.x * (side + 0.5), lz = pz - f.n.z * (side + 0.5);
      const hit = world.raycast({ x: px, y: h + 0.55, z: pz }, { x: -f.n.x, y: 0, z: -f.n.z }, side + 0.9);
      if (hit !== null) { mantle.fail.blockedBehind++; mantle.failAt.push([+fxp.toFixed(1), +fzp.toFixed(1), 'detrás']); continue; }
      const gh = world.groundHeight({ x: lx, z: lz }, R, h + 0.2);
      if (Math.abs(gh - h) > 0.25) { mantle.fail.landing++; mantle.failAt.push([+fxp.toFixed(1), +fzp.toFixed(1), `aterrizaje ${gh.toFixed(2)}≠${h.toFixed(2)}`]); continue; }
      if (world.ceilingHeight({ x: lx, z: lz }, R, h) - h < TUNING.fp.standClear) { mantle.fail.ceiling++; mantle.lowCeiling.push([+lx.toFixed(1), +h.toFixed(2), +lz.toFixed(1)]); continue; }
      ok++; mantle.ok++;
      // ¿lleva a un sitio al que no se llega andando (ni cayendo)?
      const kl = walkOnly.idx(lx, lz);
      if (kl >= 0 && Number.isNaN(walkOnly.height[kl])) {
        // el techo del bloque no cuenta: se mira 1 m más allá del bloque
        const fx2 = lx - f.n.x * 1.2, fz2 = lz - f.n.z * 1.2, k2 = walkOnly.idx(fx2, fz2);
        if (k2 >= 0 && Number.isNaN(walkOnly.height[k2]) && !Number.isNaN(rc.height[k2]) && rc.height[k2] < 0.3) mantle.newArea.push([+fx2.toFixed(1), +fz2.toFixed(1)]);
      }
    }
    faceResult.set(f, { ok, tried });
  }
  // una cara trepable por un lado y no por el otro (misma caja)
  for (const f of mantleFaces) {
    const r1 = faceResult.get(f); if (!r1?.tried) continue;
    const opp = mantleFaces.find((g) => g !== f && g.collider === f.collider && g.n.x === -f.n.x && g.n.z === -f.n.z);
    const r2 = opp && faceResult.get(opp);
    if (r2?.tried && ((r1.ok > 0) !== (r2.ok > 0))) mantle.oneSided.push({ at: [+((f.a.x + f.b.x) / 2).toFixed(1), +((f.a.z + f.b.z) / 2).toFixed(1)], n: f.n, ok: r1.ok, oppOk: r2.ok, kind: f.kind });
  }
  mantle.newArea = dedupe(mantle.newArea);
  // 4b. techos y dinteles frente a la cabeza de pie (1.74) y al salto
  const ceil = { headClip: [], cantStand: [], jumpCapped: 0 };
  for (const k of cells) {
    const [x, y, z] = P(k), c = world.ceilingHeight({ x, z }, R, y);
    if (!Number.isFinite(c)) continue;
    const room = c - y;
    if (room < TUNING.fp.standClear) ceil.cantStand.push([+x.toFixed(1), +y.toFixed(2), +z.toFixed(1), +room.toFixed(2)]);
    else if (room < 1.74 + 0.05) ceil.headClip.push([+x.toFixed(1), +y.toFixed(2), +z.toFixed(1), +room.toFixed(2)]);
    if (room < 1.74 + JUMP_UP) ceil.jumpCapped++;
  }
  ceil.headClip = dedupe(ceil.headClip, 1.5); ceil.cantStand = dedupe(ceil.cantStand, 1.5);
  // 4c. huecos más estrechos que el cuerpo entre dos cajas que bloquean a ras de suelo
  const solid = world.colliders.filter((c) => !c.walkSurface && c.h > 0.5 && (c.minY === undefined || c.minY < 1.6) && !c.moveOnly);
  const gaps = [];
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const A = solid[i], Bc = solid[j];
    const gx = Math.max(A.minx - Bc.maxx, Bc.minx - A.maxx), gz = Math.max(A.minz - Bc.maxz, Bc.minz - A.maxz);
    let gap, overlap;
    if (gx > 0 && gz <= 0) { gap = gx; overlap = Math.min(A.maxz, Bc.maxz) - Math.max(A.minz, Bc.minz); }
    else if (gz > 0 && gx <= 0) { gap = gz; overlap = Math.min(A.maxx, Bc.maxx) - Math.max(A.minx, Bc.minx); }
    else if (gx > 0 && gz > 0) { gap = Math.hypot(gx, gz); overlap = 0; }
    else continue;
    if (gap < 0.12 || gap >= 2 * R + 0.02) continue;
    const mx = (Math.max(A.minx, Bc.minx) + Math.min(A.maxx, Bc.maxx)) / 2, mz = (Math.max(A.minz, Bc.minz) + Math.min(A.maxz, Bc.maxz)) / 2;
    // solo cuenta si a ambos lados del hueco hay suelo alcanzable (parece un paso)
    const k = rc.idx(mx, mz);
    gaps.push({ at: [+mx.toFixed(2), +mz.toFixed(2)], gap: +gap.toFixed(2), overlap: +overlap.toFixed(2), h: [+A.h.toFixed(2), +Bc.h.toFixed(2)], nearReach: hasReachNear(rc, mx, mz, 1.0) });
  }
  const gapsReal = gaps.filter((g) => g.nearReach && g.gap >= 0.3);
  // 4d. cabeza/ojo que atraviesan geometría al inclinarse o agacharse pegado a algo
  const poke = { tested: 0, eyeInside: 0, eyeThrough: 0, list: [] };
  for (const f of world.faces) {
    const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z, len = Math.hypot(tx, tz); if (len < 0.3) continue;
    for (let u = 0.3; u < len - 0.3; u += quick ? 2 : 1) {
      const base = f.baseY ?? 0;
      // el cuerpo donde lo dejaría el juego: resolveCircle contra TODAS las
      // cajas (una tapa 1 cm más ancha que su cara, p. ej. el carrito de café,
      // empuja el cuerpo; sin esto el ojo "atravesaba" por esa diferencia)
      const q = { x: f.a.x + tx * u / len + f.n.x * (R + 0.001), z: f.a.z + tz * u / len + f.n.z * (R + 0.001) };
      world.resolveCircle(q, R, base);
      const px = q.x, pz = q.z;
      const k = rc.idx(px, pz); if (k < 0 || Number.isNaN(height[k]) || Math.abs(height[k] - base) > 0.2) continue;
      if (rc.blocked(px, pz, height[k], R - 0.01)) continue;
      for (let a = 0; a < 8; a++) {
        const yaw = a * Math.PI / 4;
        for (const pn of ['crouch', 'crouchL', 'crouchR', 'leanL', 'leanR', 'peek']) {
          poke.tested++;
          const e = eyeAt(POSES[pn], px, height[k], pz, yaw);
          const axis = [px, e[1], pz];
          if (los.blocked(axis, e)) {
            poke.eyeThrough++;
            if (poke.list.length < 40) poke.list.push({ at: [+px.toFixed(2), +pz.toFixed(2)], pose: pn, yawDeg: a * 45, face: f.kind });
          }
        }
      }
    }
  }
  // 4e. escalones que sacuden el ojo: saltos de suelo entre celdas vecinas transitables
  const jolts = [];
  for (const k of cells) {
    const i = k % nx, j = Math.floor(k / nx);
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const k2 = (j + dj) * nx + i + di; if (i + di >= nx || j + dj >= nz || Number.isNaN(height[k2])) continue;
      const dy = Math.abs(height[k2] - height[k]);
      if (!(dy > 0.08 && dy <= STEP + 0.01)) continue;
      // rampa = el suelo sube de forma continua; escalón = salto en un punto
      const a = P(k), b = P(k2), lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      let jump = 0;
      for (let t = 1; t <= 8; t++) {
        const g1 = rc.ground(a[0] + (b[0] - a[0]) * (t - 1) / 8, a[2] + (b[2] - a[2]) * (t - 1) / 8, hi), g2 = rc.ground(a[0] + (b[0] - a[0]) * t / 8, a[2] + (b[2] - a[2]) * t / 8, hi);
        jump = Math.max(jump, Math.abs(g2 - g1));
      }
      if (jump > 0.06) jolts.push([...a].map((v) => +v.toFixed(2)).concat(+jump.toFixed(2)));
    }
  }

  return {
    layout, cells: cells.length, walkOnlyCells: [...walkOnly.height].filter((v) => !Number.isNaN(v)).length,
    losCheck: { checked, mismatch },
    spawn: { seenPct: spawn.seenPct, seenFromEnemyHalfPct: spawn.seenFromEnemyHalfPct, cellsChecked: spawn.cellsChecked, overLowCells: spawn.overLow,
      overLow: dedupe(spawn.overLowList, 2), fromEnemyHalf: dedupe(spawn.list, 2), exit },
    routes, sight, dominant: dom, topSee, sbcs: sbcsSpots, cover,
    mantle: { ...mantle, failAt: dedupe(mantle.failAt, 1.5, 1), lowCeiling: dedupe(mantle.lowCeiling, 1.5) },
    ceilings: ceil, gaps: { narrow: gapsReal.length, list: gapsReal.slice(0, 40) },
    poke: { ...poke }, jolts: { count: jolts.length, sample: dedupe(jolts.map((j) => [j[0], j[2], j[1], j[3]]), 2, 1).slice(0, 20) },
    _draw: { world, rc, P, sample, pos, sbcs, seeCount, routes },
  };
}

function hasReachNear(rc, x, z, r) {
  let n = 0;
  for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) { const k = rc.idx(x + dx, z + dz); if (k >= 0 && !Number.isNaN(rc.height[k])) n++; }
  return n >= 2;
}
function dedupe(list, rad = 1, zi = null) {
  const out = [];
  const Zof = (p) => p[zi ?? (p.length === 2 ? 1 : 2)];
  for (const p of list) if (!out.some((q) => Math.hypot(q[0] - p[0], Zof(q) - Zof(p)) < rad)) out.push(p);
  return out;
}

// ---------- planta SVG ----------
export function drawSVG(r, marks = [], baselineBoxes = null) {
  const { world, rc, pos, sbcs, routes } = r._draw;
  const fx = world.fx + 2, fz = world.fz + 2, S = 8;
  const W = Math.max(fx, fz) * 2 * S, H = Math.max(fx, fz) * 2 * S;
  const ox = (W / S / 2), oz = (H / S / 2);
  const X = (x) => ((x + ox) * S).toFixed(1), Z = (z) => ((oz - z) * S).toFixed(1);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 60}" width="${W}" height="${H + 60}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#14161a"/>`];
  // suelo alcanzable
  for (let k = 0; k < rc.nx * rc.nz; k++) {
    if (Number.isNaN(rc.height[k])) continue;
    const [x, z] = rc.centre(k % rc.nx, Math.floor(k / rc.nx)), y = rc.height[k];
    out.push(`<rect x="${X(x - 0.25)}" y="${Z(z + 0.25)}" width="${S / 2}" height="${S / 2}" fill="${y > 2 ? '#3a4a5c' : y > 0.5 ? '#2f3d33' : '#262a30'}"/>`);
  }
  const col = (b) => b.moveOnly ? '#000000' : b.h >= 2.9 ? '#8a8f98' : b.h >= 1.8 ? '#c79b4a' : b.h >= 1.0 ? '#5aa1c9' : '#4b5560';
  for (const b of [...world.colliders].sort((p, q) => p.h - q.h)) {
    if (b.walkSurface || (b.minY ?? 0) > 2) continue;
    out.push(`<rect x="${X(b.minx)}" y="${Z(b.maxz)}" width="${((b.maxx - b.minx) * S).toFixed(1)}" height="${((b.maxz - b.minz) * S).toFixed(1)}" fill="${col(b)}" fill-opacity="0.85"/>`);
  }
  for (const s of world.segmentColliders) out.push(`<line x1="${X(s.a.x)}" y1="${Z(s.a.z)}" x2="${X(s.b.x)}" y2="${Z(s.b.z)}" stroke="#5aa1c9" stroke-width="2"/>`);
  // "me dan y no veo" (de pie)
  pos.forEach((p, i) => { if (sbcs[i] >= 1) out.push(`<circle cx="${X(p[0])}" cy="${Z(p[2])}" r="${Math.min(9, 2 + sbcs[i] / 3).toFixed(1)}" fill="#ff3b6b" fill-opacity="0.55"/>`); });
  for (const rt of routes) if (rt.path) out.push(`<polyline points="${rt.path.map(([x, z]) => `${X(x)},${Z(z)}`).join(' ')}" fill="none" stroke="#e8c15a" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="6 4"/>`);
  for (const t of ['red', 'blue']) for (const s of world.spawns[t]) out.push(`<circle cx="${X(s.x)}" cy="${Z(s.z)}" r="5" fill="${t === 'red' ? '#e0483e' : '#3e7be0'}"/>`);
  for (const p of r.spawn.overLow) out.push(`<rect x="${X(p[0]) - 3}" y="${Z(p[2]) - 3}" width="6" height="6" fill="#ff9f1c"/>`);
  // cambios
  marks.forEach((m, i) => {
    out.push(`<rect x="${X(m.minx) - 4}" y="${Z(m.maxz) - 4}" width="${((m.maxx - m.minx) * S + 8).toFixed(1)}" height="${((m.maxz - m.minz) * S + 8).toFixed(1)}" fill="none" stroke="${m.kind === 'removed' ? '#ff4d4d' : '#4dff88'}" stroke-width="2.5" ${m.kind === 'removed' ? 'stroke-dasharray="4 3"' : ''}/>`);
    if (m.label) out.push(`<text x="${+X(m.maxx) + 6}" y="${+Z(m.maxz) + 4}" fill="#ffffff" font-size="15" font-weight="700" stroke="#000" stroke-width="3" paint-order="stroke">${m.label}</text>`);
  });
  out.push(`<text x="10" y="${H + 22}" fill="#ddd" font-size="14">${r.layout} — gris HIGH · ocre MID · azul LOW · rosa: "me dan y no veo" (≥1 tirador) · naranja: el ojo de pie ve el spawn por encima de un LOW · amarillo: rutas · verde/rojo: cambios</text>`);
  out.push(`<text x="10" y="${H + 44}" fill="#999" font-size="13">+z arriba (spawn azul), −z abajo (spawn rojo). 1 m = ${S} px.</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// diferencias de cajas contra la referencia (para marcar cambios en la planta)
export function boxDiff(layout, baselineFile) {
  if (!existsSync(baselineFile)) return [];
  const base = [...(JSON.parse(readFileSync(baselineFile, 'utf8'))[layout]?.geometry?.boxes ?? [])];
  const now = [...expandedCollisionBoxes(layout)];
  const K = ['minx', 'maxx', 'minz', 'maxz', 'h', 'minY'];
  const same = (a, b) => K.every((k) => (a[k] === undefined) === (b[k] === undefined) && (a[k] === undefined || Math.abs(a[k] - b[k]) < 0.005));
  const out = [], used = new Set();
  for (const b of now) {
    const i = base.findIndex((q, n) => !used.has(n) && same(q, b));
    if (i >= 0) used.add(i); else out.push({ ...b, kind: 'added' });
  }
  base.forEach((b, n) => { if (!used.has(n)) out.push({ ...b, kind: 'removed' }); });
  let n = 0;
  for (const a of out.filter((b) => b.kind === 'added')) a.label = String(++n);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const maps = args.filter((a) => !a.startsWith('--'));
  const out = (args.find((a) => a.startsWith('--out=')) || '--out=/tmp/fp-map-review').slice(6);
  const quick = args.includes('--quick');
  const base = (args.find((a) => a.startsWith('--baseline=')) || '').slice(11);
  mkdirSync(out, { recursive: true });
  for (const layout of maps.length ? maps : ['fortaleza', 'azoteas', 'calle2']) {
    const t0 = Date.now();
    const r = review(layout, { quick });
    const marks = base ? boxDiff(layout, base) : [];
    writeFileSync(`${out}/${layout}.svg`, drawSVG(r, marks));
    const { _draw, ...data } = r;
    writeFileSync(`${out}/${layout}.json`, JSON.stringify(data, null, 1));
    console.log(`${layout} (${((Date.now() - t0) / 1000).toFixed(0)} s) LOS ${data.losCheck.mismatch}/${data.losCheck.checked} discrepancias`);
    console.log(`  spawn: visto desde ${data.spawn.seenPct}% del mapa, ${data.spawn.seenFromEnemyHalfPct}% de la mitad rival; por encima de LOW ${data.spawn.overLowCells} celdas; salida expuesta ${data.spawn.exit.exposedPct}% (${data.spawn.exit.exposed}/${data.spawn.exit.cells})`);
    for (const rt of data.routes) console.log(`  ruta vía ${rt.via}: ${rt.length} m, descubierto máx ${rt.longestUncovered} m, descubierto y a la vista ${rt.longestUncoveredSeen} m ${JSON.stringify(rt.uncoveredSeenAt)}`);
    console.log(`  líneas de tiro: máx ${data.sight.longest} m, <10 ${data.sight.closePct}% · 10-28 ${data.sight.midPct}% · 28-50 ${data.sight.longPct}% · ≥50 ${data.sight.veryLongPct}%`);
    console.log(`  "me dan y no veo" (≥1 tirador): de pie ${data.sbcs.stand}, agachado ${data.sbcs.crouch} de ${data.sight.positions}`);
    console.log(`  trepar: ${data.mantle.ok}/${data.mantle.samples} ok en ${data.mantle.faces} caras; fallos ${JSON.stringify(data.mantle.fail)}; un solo lado ${data.mantle.oneSided.length}; zonas nuevas ${data.mantle.newArea.length}`);
    console.log(`  cobertura: LOW que no tapa agachado ${data.cover.low.leaky.length}/${data.cover.low.faces}, MID que no tapa de pie ${data.cover.mid.leaky.length}/${data.cover.mid.faces}, MID sin extremo para asomarse ${data.cover.mid.deadEnds.length}`);
    console.log(`  techos: cabeza roza ${data.ceilings.headClip.length}, no se puede levantar ${data.ceilings.cantStand.length}; huecos estrechos ${data.gaps.narrow}; ojo atraviesa ${data.poke.eyeThrough}/${data.poke.tested}; escalones ${data.jolts.count}`);
  }
}
