// PLANO CENITAL Y SUPERFICIE JUGABLE de un mapa, desde la misma geometría que
// usan cliente y servidor. Sirve para comparar un rediseño "antes/después" a la
// MISMA escala y con el MISMO encuadre.
//   node scripts/map-plan.mjs <mapa> [carpeta de salida] [etiqueta]
//
// Superficie jugable = celdas de 0,25 m donde cabe el centro del cuerpo de un
// jugador (radio 0,38 m) y a las que se llega ANDANDO desde un spawn: pasos de
// hasta 0,16 m (el desnivel automático del juego), rampas y caídas. No cuenta
// lo que exige saltar o trepar, ni el interior de muros y cover.
import fs from 'node:fs';
import path from 'node:path';
import { serverMapPhysics } from '../server/map-geometry.js';
import { expandedCollisionBoxes, rampsFor } from '../src/world/collision-layouts.js';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';

export const CELL = 0.25, R = 0.38, STEP = 0.16;
// encuadre común a todos los mapas y a todas las versiones: ±60 m × ±66 m
export const FRAME = { x: 60, z: 66, scale: 7 };

export function spawnsFor(map) {
  const z = MAP_RUNTIME[map].spawnZ;
  const xs = MAP_RUNTIME[map].spawnXs ?? [-3.6, -1.2, 1.2, 3.6];
  const cx = MAP_RUNTIME[map].spawnX ?? 0;
  return { red: xs.map((x) => ({ x: cx + x, z: -z })), blue: xs.map((x) => ({ x: -cx - x, z })) };
}

export function survey(map) {
  const phys = serverMapPhysics(map);
  const boxes = expandedCollisionBoxes(map);
  const lim = { x: FRAME.x, z: FRAME.z };
  const nx = Math.round(lim.x * 2 / CELL), nz = Math.round(lim.z * 2 / CELL);
  const best = new Float32Array(nx * nz).fill(NaN);   // altura más alta alcanzada en la celda
  const low = new Float32Array(nx * nz).fill(NaN);    // altura más baja alcanzada
  const seen = new Set();
  const queue = [];
  const push = (i, j, y) => {
    const key = (j * nx + i) * 64 + Math.round(y * 4);
    if (seen.has(key)) return;
    seen.add(key);
    const k = j * nx + i;
    if (Number.isNaN(best[k]) || y > best[k]) best[k] = y;
    if (Number.isNaN(low[k]) || y < low[k]) low[k] = y;
    queue.push([i, j, y]);
  };
  const cellOf = (x, z) => [Math.floor((x + lim.x) / CELL), Math.floor((z + lim.z) / CELL)];
  const centre = (i, j) => ({ x: -lim.x + (i + 0.5) * CELL, z: -lim.z + (j + 0.5) * CELL });
  const sp = spawnsFor(map);
  for (const s of [...sp.red, ...sp.blue]) { const [i, j] = cellOf(s.x, s.z); push(i, j, phys.groundHeight(s, R, 0)); }
  while (queue.length) {
    const [i, j, y] = queue.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const c = centre(a, b), p = { ...c };
      phys.resolveCircle(p, R, y);
      if (Math.hypot(p.x - c.x, p.z - c.z) > 0.05) continue;
      const g = phys.groundHeight(c, R, y);
      if (g - y > STEP) continue;
      push(a, b, g);
    }
  }
  let cells = 0, raised = 0, minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const h = best[j * nx + i];
    if (Number.isNaN(h)) continue;
    cells++; if (h > 0.5) raised++;
    const c = centre(i, j);
    minx = Math.min(minx, c.x); maxx = Math.max(maxx, c.x); minz = Math.min(minz, c.z); maxz = Math.max(maxz, c.z);
  }
  const area = cells * CELL * CELL;
  return { map, boxes, best, low, nx, nz, lim, sp,
    stats: { ancho: +(maxx - minx + 2 * R).toFixed(1), largo: +(maxz - minz + 2 * R).toFixed(1), superficie: Math.round(area), elevada: Math.round(raised * CELL * CELL),
      x: [+(minx - R).toFixed(1), +(maxx + R).toFixed(1)], z: [+(minz - R).toFixed(1), +(maxz + R).toFixed(1)] } };
}

export function planSvg(s, label = '') {
  const { scale } = FRAME, W = s.lim.x * 2 * scale, H = s.lim.z * 2 * scale;
  // norte (+z, lado azul) arriba
  const X = (x) => ((x + s.lim.x) * scale).toFixed(1), Y = (z) => ((s.lim.z - z) * scale).toFixed(1);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#14181d"/>`];
  // suelo alcanzable, por filas (tramos fundidos)
  const shade = (h) => h > 2.4 ? '#c9a45c' : h > 1.5 ? '#b8975a' : h > 0.5 ? '#8f8a62' : '#5d6873';
  for (let j = 0; j < s.nz; j++) {
    let run = null;
    for (let i = 0; i <= s.nx; i++) {
      const h = i < s.nx ? s.best[j * s.nx + i] : NaN;
      const col = Number.isNaN(h) ? null : shade(h);
      if (run && run.col !== col) {
        out.push(`<rect x="${(run.i * CELL * scale).toFixed(1)}" y="${((s.nz - 1 - j) * CELL * scale).toFixed(1)}" width="${((i - run.i) * CELL * scale).toFixed(1)}" height="${(CELL * scale + 0.4).toFixed(1)}" fill="${run.col}"/>`);
        run = null;
      }
      if (col && !run) run = { i, col };
    }
  }
  // cuadrícula de 10 m
  for (let x = -s.lim.x; x <= s.lim.x; x += 10) out.push(`<line x1="${X(x)}" y1="0" x2="${X(x)}" y2="${H}" stroke="#ffffff" stroke-opacity="${x === 0 ? 0.22 : 0.07}"/>`);
  for (let z = -s.lim.z + 6; z <= s.lim.z; z += 10) out.push(`<line x1="0" y1="${Y(z)}" x2="${W}" y2="${Y(z)}" stroke="#ffffff" stroke-opacity="${z === 0 ? 0.22 : 0.07}"/>`);
  // cajas: muros y cover por altura (las de relleno de rampa y las de solo-superficie no)
  const boxCol = (b) => b.h >= 2.9 ? '#e8e2d4' : b.h >= 1.8 ? '#d08a4a' : b.h >= 1.0 ? '#7fb2c9' : '#56707d';
  for (const b of [...s.boxes].sort((p, q) => p.h - q.h)) {
    if (b.walkSurface || b.h < 0.7) continue;
    out.push(`<rect x="${X(b.minx)}" y="${Y(b.maxz)}" width="${((b.maxx - b.minx) * scale).toFixed(1)}" height="${((b.maxz - b.minz) * scale).toFixed(1)}" fill="${boxCol(b)}" fill-opacity="${b.minY !== undefined ? 0.55 : 0.95}"/>`);
  }
  for (const r of rampsFor(s.map)) {
    out.push(`<rect x="${X(r.x - r.w / 2)}" y="${Y(r.z + r.d / 2)}" width="${(r.w * scale).toFixed(1)}" height="${(r.d * scale).toFixed(1)}" fill="none" stroke="#f2d98a" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  }
  const rt = MAP_RUNTIME[s.map];
  for (const [team, col] of [['red', '#ff5a4a'], ['blue', '#4f9dff']]) for (const p of s.sp[team]) out.push(`<circle cx="${X(p.x)}" cy="${Y(p.z)}" r="5" fill="${col}" stroke="#000" stroke-width="1"/>`);
  for (const c of rt.crates) out.push(`<rect x="${X(c.x) - 6}" y="${Y(c.z) - 6}" width="12" height="12" fill="#58d68d" stroke="#000" stroke-width="1"/>`);
  for (const sp of (rt.specials ?? [rt.special])) out.push(`<path d="M ${X(sp.x)} ${Y(sp.z) - 10} l 9 10 l -9 10 l -9 -10 z" fill="#f4d03f" stroke="#000" stroke-width="1"/>`);
  // escala y rótulo
  out.push(`<rect x="20" y="${H - 34}" width="${20 * scale}" height="6" fill="#fff"/><text x="20" y="${H - 40}" fill="#fff" font-size="15">20 m</text>`);
  out.push(`<text x="20" y="30" fill="#fff" font-size="22" font-weight="600">${label || s.map}</text>`);
  out.push(`<text x="20" y="54" fill="#cfd6dc" font-size="15">${s.stats.ancho} × ${s.stats.largo} m · ${s.stats.superficie} m² jugables (${s.stats.elevada} m² en altura)</text>`);
  out.push(`<text x="${W - 20}" y="30" fill="#4f9dff" font-size="15" text-anchor="end">▲ azul (+z)</text><text x="${W - 20}" y="${H - 20}" fill="#ff5a4a" font-size="15" text-anchor="end">▼ rojo (−z)</text>`);
  out.push('</svg>');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const map = process.argv[2] || 'fortaleza';
  const dir = process.argv[3] ? path.resolve(process.argv[3]) : '';
  const s = survey(map);
  console.log(JSON.stringify({ mapa: map, ...s.stats }));
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${map}-plano.svg`), planSvg(s, process.argv[4] || map));
    fs.writeFileSync(path.join(dir, `${map}-plano.json`), JSON.stringify(s.stats));
  }
}
