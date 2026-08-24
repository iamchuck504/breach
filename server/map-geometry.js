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

// Adaptador físico liviano para proyectiles balísticos del servidor. Replica
// las dos operaciones de World que usa el bote de humo sin cargar Three.js ni
// la escena visual completa.
export function serverMapPhysics(layout) {
  const g = geometry(layout);
  return {
    groundHeight(p, r = 0, y = 0) {
      let height = 0;
      const zone = g.helipad;
      if (zone) {
        const ax = Math.abs(p.x), az = Math.abs(p.z);
        if (ax <= zone.edge && az <= zone.edge && ax + az <= zone.diagonal) {
          height = zone.height;
        }
        if (ax - r <= zone.rampHalfWidth && az > zone.edge &&
            az <= zone.edge + zone.rampLength) {
          height = Math.max(height,
            zone.height * (1 - (az - zone.edge) / zone.rampLength));
        }
      }
      const margin = r * 0.5;
      for (const box of g.boxes) {
        if (box.h > y + 0.25) continue;
        if (p.x + margin < box.minx || p.x - margin > box.maxx ||
            p.z + margin < box.minz || p.z - margin > box.maxz) continue;
        if (box.h > height) height = box.h;
      }
      return height;
    },

    resolveCircle(p, r, y = 0) {
      for (let iter = 0; iter < 3; iter++) {
        let moved = false;
        for (const box of g.boxes) {
          if (y >= box.h - 0.05) continue;
          const cx = Math.max(box.minx, Math.min(box.maxx, p.x));
          const cz = Math.max(box.minz, Math.min(box.maxz, p.z));
          let dx = p.x - cx, dz = p.z - cz;
          const distance2 = dx * dx + dz * dz;
          if (distance2 > r * r) continue;
          if (distance2 > 1e-9) {
            const distance = Math.sqrt(distance2);
            p.x = cx + dx / distance * r;
            p.z = cz + dz / distance * r;
          } else {
            const left = p.x - box.minx, right = box.maxx - p.x;
            const top = p.z - box.minz, bottom = box.maxz - p.z;
            const nearest = Math.min(left, right, top, bottom);
            if (nearest === left) p.x = box.minx - r;
            else if (nearest === right) p.x = box.maxx + r;
            else if (nearest === top) p.z = box.minz - r;
            else p.z = box.maxz + r;
          }
          moved = true;
        }
        for (const segment of g.segments) {
          if (y >= segment.h - 0.05) continue;
          const tx = segment.b.x - segment.a.x;
          const tz = segment.b.z - segment.a.z;
          const len2 = tx * tx + tz * tz;
          const u = Math.max(0, Math.min(1,
            ((p.x - segment.a.x) * tx + (p.z - segment.a.z) * tz) / len2));
          const cx = segment.a.x + tx * u, cz = segment.a.z + tz * u;
          let dx = p.x - cx, dz = p.z - cz;
          const radius = r + segment.half;
          const distance2 = dx * dx + dz * dz;
          if (distance2 >= radius * radius) continue;
          if (distance2 > 1e-9) {
            const distance = Math.sqrt(distance2);
            dx /= distance; dz /= distance;
          } else {
            const signed = (p.x - segment.a.x) * segment.n.x +
              (p.z - segment.a.z) * segment.n.z;
            const side = signed >= 0 ? 1 : -1;
            dx = segment.n.x * side; dz = segment.n.z * side;
          }
          p.x = cx + dx * radius;
          p.z = cz + dz * radius;
          moved = true;
        }
        if (!moved) break;
      }
    },
  };
}

function pointInsideBox(box, point) {
  return point.x >= box.minx && point.x <= box.maxx &&
    point.z >= box.minz && point.z <= box.maxz &&
    point.y >= -0.1 && point.y <= box.h;
}

function pointInsideSegment(segment, point) {
  if (point.y < -0.1 || point.y > segment.h) return false;
  const tx = segment.b.x - segment.a.x, tz = segment.b.z - segment.a.z;
  const len = Math.hypot(tx, tz); if (len < 0.001) return false;
  const ux = tx / len, uz = tz / len;
  const cx = (segment.a.x + segment.b.x) * 0.5;
  const cz = (segment.a.z + segment.b.z) * 0.5;
  const ox = point.x - cx, oz = point.z - cz;
  return Math.abs(ox * ux + oz * uz) <= len * 0.5 &&
    Math.abs(ox * segment.n.x + oz * segment.n.z) <= segment.half;
}

function pointInsideGeometry(layout, point) {
  const g = geometry(layout);
  if (g.boxes.some((box) => pointInsideBox(box, point)) ||
      g.segments.some((segment) => pointInsideSegment(segment, point))) return true;
  if (!g.helipad || point.y < -0.1 || point.y > g.helipad.height) return false;
  const ax = Math.abs(point.x), az = Math.abs(point.z);
  return ax <= g.helipad.edge && az <= g.helipad.edge &&
    ax + az <= g.helipad.diagonal;
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

// Primer contacto que debe detener un proyectil recto. Incluye el suelo y
// detecta un muzzle que haya nacido dentro de geometría para que nunca pueda
// salir por la cara opuesta de una pared/cover.
export function projectileMapContact(layout, from, direction, maxDistance) {
  if (!Array.isArray(from) || !Array.isArray(direction) ||
      ![...from, ...direction, maxDistance].every(Number.isFinite) || maxDistance <= 0) return null;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length < 0.001) return null;
  const dir = { x: direction[0] / length, y: direction[1] / length,
    z: direction[2] / length };
  const origin = { x: from[0], y: from[1], z: from[2] };
  if (pointInsideGeometry(layout, origin)) {
    return { distance: 0, point: from.slice(), normal: [-dir.x, -dir.y, -dir.z],
      surface: 'concrete' };
  }
  let distance = firstMapIntersection(layout, origin, dir, maxDistance);
  let normal = [-dir.x, -dir.y, -dir.z];
  let surface = 'concrete';
  if (dir.y < -1e-9) {
    const floorHit = -origin.y / dir.y;
    if (floorHit >= 0.0001 && floorHit <= maxDistance &&
        (distance === null || floorHit < distance)) {
      distance = floorHit; normal = [0, 1, 0]; surface = 'concrete';
    }
  }
  if (distance === null) return null;
  return {
    distance,
    point: [origin.x + dir.x * distance, origin.y + dir.y * distance,
      origin.z + dir.z * distance],
    normal,
    surface,
  };
}
