import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { MAP_RUNTIME } from '../src/game/lobby-rules.js';
import { decksFor, expandedCollisionBoxes, helipadSegments, rampsFor, RAMP_LANDING } from '../src/world/collision-layouts.js';
import { FORT_GALLERY } from '../src/world/fortaleza-galleries.js';
import { MAP_DIMS, MAP_FLOORS } from '../src/world/map-dims.js';
import { World } from '../src/world/world.js';

const layouts = ['fortaleza', 'azoteas', 'calle2'];
const file = new URL('./collision-baseline.json', import.meta.url);
const writing = process.argv.includes('--write');
const json = (value) => JSON.stringify(value);
const digest = (value) => createHash('sha256').update(json(value)).digest('hex');

function canonical(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid coordinate: ${value}`);
    return Number(value.toFixed(4));
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}

// Cada colección es un multiconjunto: conservamos las repeticiones y el orden
// interno de coordenadas, pero el orden de inserción del builder no cuenta.
function sortedRows(rows) {
  return rows.map(row => json(canonical(row))).sort().map(line => JSON.parse(line));
}

function normalizeGeometry(groups) {
  return Object.fromEntries(Object.keys(groups).sort().map(key => [key, sortedRows(groups[key])]));
}

function snapshot(layout) {
  const [fx, fz] = MAP_DIMS[layout];
  const runtime = MAP_RUNTIME[layout];
  // Pasamos por _box, los ajustes de caras y los spawns reales de World.
  // Se omiten sólo las mallas y los decoradores que requieren canvas.
  const world = Object.assign(Object.create(World.prototype), {
    layout, fx, fz, colliders: [], segmentColliders: [], faces: [], surfaceZones: [],
    spawns: { red: [], blue: [] },
    _decorFortaleza() {}, _decorAzoteas() {}, _decorCalle() {},
    _box(x, z, w, d, h, options) {
      World.prototype._box.call(this, x, z, w, d, h, { ...options, visual: false });
    },
  });
  world._runBuilder(layout);
  world._buildSpawns();

  const geometry = normalizeGeometry({
    boxes: expandedCollisionBoxes(layout),
    segments: layout === 'azoteas' ? helipadSegments() : [],
    faces: world.faces.map(({ collider, ...face }) => face),
    ramps: rampsFor(layout).map(({ kind, ...ramp }) => ramp),
    decks: decksFor(layout).flatMap(({ x, z, h, w, d, mirror }) => {
      const deck = { x, z, h, w, d };
      return mirror && (x || z) ? [deck, { ...deck, x: -x, z: -z }] : [deck];
    }),
    ground: [{ fx, fz, rampLanding: RAMP_LANDING }, ...world.surfaceZones,
      ...(MAP_FLOORS[layout]?.rects ?? []).map(rect => ({ rect })),
      ...(layout === 'fortaleza' ? [{ gallery: FORT_GALLERY }] : [])],
    spawns: Object.entries(world.spawns).flatMap(([team, points]) =>
      points.map((point, slot) => ({ ...point, team, slot }))),
    crates: runtime.crates,
    special: [runtime.special],
  });
  const parity = {
    boxes: [geometry.boxes, sortedRows(world.colliders.map(({ surface, ...box }) => box))],
    segments: [geometry.segments, sortedRows(world.segmentColliders.map(({ surface, coverH, ...segment }) => segment))],
  };
  return { geometry, parity };
}

function difference(left, right) {
  const counts = new Map();
  for (const row of right) {
    const key = json(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return left.filter(row => {
    const key = json(row), n = counts.get(key);
    if (!n) return true;
    counts.set(key, n - 1);
    return false;
  });
}

function boxShape({ minx, maxx, minz, maxz, ...flags }) {
  return json(canonical({ ...flags, w: maxx - minx, d: maxz - minz }));
}

function changes(group, before, after) {
  const removed = difference(before, after);
  const added = difference(after, before);
  for (const old of removed) {
    let index = -1;
    if (group === 'boxes') {
      // Sin IDs persistentes: emparejar traslaciones por forma y cercanía.
      const shape = boxShape(old);
      let nearest = Infinity;
      for (const [i, box] of added.entries()) {
        const distance = Math.hypot(box.minx - old.minx, box.minz - old.minz);
        if (distance < nearest && boxShape(box) === shape) {
          nearest = distance;
          index = i;
        }
      }
    }
    if (index === -1) console.log(`  removed ${group} ${json(old)}`);
    else console.log(`  moved ${group} ${json(old)} -> ${json(added.splice(index, 1)[0])}`);
  }
  for (const row of added) console.log(`  added ${group} ${json(row)}`);
}

// Un registro por línea para que un diff de la referencia sea legible.
function format(value, indent = '') {
  const next = indent + '  ';
  if (Array.isArray(value)) {
    return value.length ? '[\n' + value.map(v => next + json(v)).join(',\n') + '\n' + indent + ']' : '[]';
  }
  if (typeof value !== 'object') return json(value);
  return '{\n' + Object.entries(value).map(([k, v]) => next + json(k) + ': ' + format(v, next)).join(',\n') + '\n' + indent + '}';
}

const baseline = writing || !existsSync(file) ? {} : JSON.parse(readFileSync(file, 'utf8'));
for (const layout of layouts) {
  const { geometry, parity } = snapshot(layout);
  const sha256 = digest(geometry);
  const expected = baseline[layout];
  const previous = normalizeGeometry(expected?.geometry ?? {});
  const mismatches = Object.entries(parity).filter(([, [server, client]]) => json(server) !== json(client));
  const matches = writing || (expected?.sha256 === sha256 && digest(previous) === sha256);
  const ok = matches && !mismatches.length;
  const counts = Object.entries(geometry).map(([k, rows]) => `${rows.length} ${k}`).join(', ');
  console.log(`${ok ? 'OK' : 'FAIL'} ${layout} — ${counts}`);
  for (const [group, [server, client]] of mismatches) {
    console.log('  shared geometry -> client builder');
    changes(group, server, client);
  }
  if (!matches) {
    console.log(`  sha256 ${expected?.sha256 ?? '(missing)'} -> ${sha256}`);
    for (const group of new Set([...Object.keys(geometry), ...Object.keys(previous)])) {
      changes(group, previous[group] ?? [], geometry[group] ?? []);
    }
  }
  if (!ok) process.exitCode = 1;
  if (writing) baseline[layout] = { sha256, geometry };
}
if (writing && !process.exitCode) writeFileSync(file, format(baseline) + '\n');
