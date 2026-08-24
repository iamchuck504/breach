// Raycast estático sin Three.js para la autoridad online. Consume la misma
// fuente de colliders que World, de modo que servidor y cliente no puedan
// discrepar sobre paredes, vehículos, cover o barandas del helipuerto.
import { HELIPAD, expandedCollisionBoxes, helipadSegments }
  from '../src/world/collision-layouts.js';

const ORIGIN_NUDGE = 0.055;
const TARGET_MARGIN = 0.16;
const cache = new Map();

function geometry(layout) {
  if (!cache.has(layout)) cache.set(layout, {
    boxes: expandedCollisionBoxes(layout),
    segments: layout === 'azoteas' ? helipadSegments() : [],
    helipad: layout === 'azoteas' ? HELIPAD : null,
  });
  return cache.get(layout);
}

function slabHit(axes, maxDist) {
  let near = -Infinity, far = Infinity;
  for (const a of axes) {
    if (Math.abs(a.d) < 1e-9) {
      if (a.o < a.lo || a.o > a.hi) return null;
      continue;
    }
    let t1 = (a.lo - a.o) / a.d, t2 = (a.hi - a.o) / a.d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1); far = Math.min(far, t2);
    if (near > far) return null;
  }
  const t = near >= 0.0001 ? near : far;
  return Number.isFinite(t) && t >= 0.0001 && t <= maxDist ? t : null;
}

function boxHit(box, origin, dir, maxDist) {
  return slabHit([
    { o: origin.x, d: dir.x, lo: box.minx, hi: box.maxx },
    { o: origin.y, d: dir.y, lo: -0.1, hi: box.h },
    { o: origin.z, d: dir.z, lo: box.minz, hi: box.maxz },
  ], maxDist);
}

function segmentHit(segment, origin, dir, maxDist) {
  const tx = segment.b.x - segment.a.x, tz = segment.b.z - segment.a.z;
  const len = Math.hypot(tx, tz); if (len < 0.001) return null;
  const ux = tx / len, uz = tz / len;
  const cx = (segment.a.x + segment.b.x) * 0.5;
  const cz = (segment.a.z + segment.b.z) * 0.5;
  const ox = origin.x - cx, oz = origin.z - cz;
  return slabHit([
    { o: ox * ux + oz * uz, d: dir.x * ux + dir.z * uz,
      lo: -len * 0.5, hi: len * 0.5 },
    { o: ox * segment.n.x + oz * segment.n.z,
      d: dir.x * segment.n.x + dir.z * segment.n.z,
      lo: -segment.half, hi: segment.half },
    { o: origin.y, d: dir.y, lo: -0.1, hi: segment.h },
  ], maxDist);
}

function helipadHit(zone, origin, dir, maxDist) {
  let best = null;
  const accept = (t, contains) => {
    if (!Number.isFinite(t) || t < 0.0001 || t > maxDist) return;
    const x = origin.x + dir.x * t, z = origin.z + dir.z * t;
    if (contains(x, z) && (best === null || t < best)) best = t;
  };
  if (dir.y < -1e-9) {
    accept((zone.height - origin.y) / dir.y, (x, z) => {
      const ax = Math.abs(x), az = Math.abs(z);
      return ax <= zone.edge && az <= zone.edge && ax + az <= zone.diagonal;
    });
  }
  for (const sign of [-1, 1]) {
    const slope = zone.height * sign / zone.rampLength;
    const denom = dir.y + slope * dir.z;
    if (Math.abs(denom) < 1e-9) continue;
    const constant = zone.height * (1 + zone.edge / zone.rampLength);
    accept((constant - origin.y - slope * origin.z) / denom, (x, z) => {
      const sz = sign * z;
      return Math.abs(x) <= zone.rampHalfWidth &&
        sz >= zone.edge && sz <= zone.edge + zone.rampLength;
    });
  }
  return best;
}

export function firstMapIntersection(layout, origin, dir, maxDist) {
  if (!origin || !dir || ![origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist]
    .every(Number.isFinite) || maxDist <= 0) return null;
  const g = geometry(layout);
  let best = null;
  const accept = (t) => { if (t !== null && (best === null || t < best)) best = t; };
  for (const box of g.boxes) accept(boxHit(box, origin, dir, maxDist));
  for (const segment of g.segments) accept(segmentHit(segment, origin, dir, maxDist));
  if (g.helipad) accept(helipadHit(g.helipad, origin, dir, maxDist));
  return best;
}

export function mapLineBlocked(layout, from, to, targetMargin = TARGET_MARGIN) {
  if (!from || !to) return true;
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length <= targetMargin + ORIGIN_NUDGE) return false;
  const dir = { x: dx / length, y: dy / length, z: dz / length };
  const origin = {
    x: from[0] + dir.x * ORIGIN_NUDGE,
    y: from[1] + dir.y * ORIGIN_NUDGE,
    z: from[2] + dir.z * ORIGIN_NUDGE,
  };
  const maxDist = length - ORIGIN_NUDGE - Math.max(0, targetMargin);
  return firstMapIntersection(layout, origin, dir, maxDist) !== null;
}

export function clipMapEndpoint(layout, from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length < 0.001) return to.slice();
  const dir = { x: dx / length, y: dy / length, z: dz / length };
  const origin = {
    x: from[0] + dir.x * ORIGIN_NUDGE,
    y: from[1] + dir.y * ORIGIN_NUDGE,
    z: from[2] + dir.z * ORIGIN_NUDGE,
  };
  const hit = firstMapIntersection(layout, origin, dir, length - ORIGIN_NUDGE);
  if (hit === null) return to.slice();
  const distance = ORIGIN_NUDGE + hit;
  return [from[0] + dir.x * distance, from[1] + dir.y * distance,
    from[2] + dir.z * distance];
}

// Devuelve un contacto físico real cercano al punto reportado. A diferencia
// de clipMapEndpoint, null significa que el rayo terminó en espacio vacío.
// El plano de suelo se valida aquí (para decals), pero no participa en LOS.
export function mapSurfaceContact(layout, from, to, tolerance = 0.35) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length < 0.001) return null;
  const dir = { x: dx / length, y: dy / length, z: dz / length };
  const origin = {
    x: from[0] + dir.x * ORIGIN_NUDGE,
    y: from[1] + dir.y * ORIGIN_NUDGE,
    z: from[2] + dir.z * ORIGIN_NUDGE,
  };
  const maxDist = length - ORIGIN_NUDGE + Math.max(0, tolerance);
  let hit = firstMapIntersection(layout, origin, dir, maxDist);
  if (dir.y < -1e-9) {
    const floorHit = -origin.y / dir.y;
    if (floorHit >= 0.0001 && floorHit <= maxDist && (hit === null || floorHit < hit)) hit = floorHit;
  }
  if (hit === null) return null;
  const distance = ORIGIN_NUDGE + hit;
  return [from[0] + dir.x * distance, from[1] + dir.y * distance,
    from[2] + dir.z * distance];
}
