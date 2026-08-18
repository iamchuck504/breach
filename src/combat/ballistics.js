// Hitscan: ray contra mundo (AABBs) y contra jugadores (cápsula cuerpo + esfera cabeza).
import * as THREE from 'three';

export function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}

// Cápsula vertical (x, z, y0..y1, r). Aproximación por punto más cercano.
export function rayCapsule(o, d, x, z, y0, y1, r) {
  // resolver contra cilindro infinito en XZ
  const ox = o.x - x, oz = o.z - z;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-8) {
    // ray vertical: dentro del radio?
    if (ox * ox + oz * oz > r * r) return null;
    const t = (y0 - o.y) / d.y;
    return t > 0 ? t : null;
  }
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0) return null;
  const y = o.y + d.y * t;
  if (y >= y0 && y <= y1) return t;
  // tapas (esferas en los extremos)
  return raySphere(o, d, x, y < y0 ? y0 : y1, z, r) ?? null;
}

// targets: [{id, x, z, alive}] — hitbox: cuerpo y0.35..1.3 r0.4, cabeza y1.52 r0.22
// Devuelve {kind:'world'|'player'|'none', t, point, id, part}
export function resolveShot(world, targets, origin, dir, maxRange, excludeId = null) {
  let bestT = world.raycast(origin, dir, maxRange);
  let hit = bestT !== null
    ? { kind: 'world', t: bestT }
    : { kind: 'none', t: maxRange };
  bestT = hit.t;

  for (const tg of targets) {
    if (!tg.alive || tg.id === excludeId) continue;
    const th = raySphere(origin, dir, tg.x, 1.52, tg.z, 0.22);
    if (th !== null && th < bestT) { bestT = th; hit = { kind: 'player', t: th, id: tg.id, part: 'head' }; continue; }
    const tb = rayCapsule(origin, dir, tg.x, tg.z, 0.35, 1.3, 0.4);
    if (tb !== null && tb < bestT) { bestT = tb; hit = { kind: 'player', t: tb, id: tg.id, part: 'body' }; }
  }

  hit.point = new THREE.Vector3(
    origin.x + dir.x * bestT,
    origin.y + dir.y * bestT,
    origin.z + dir.z * bestT,
  );
  return hit;
}

// Aplica dispersión cónica (grados) a una dirección
export function applySpread(dir, spreadDeg) {
  const s = (spreadDeg * Math.PI / 180);
  const u = new THREE.Vector3();
  // base ortonormal alrededor de dir
  const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(dir, up).normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1);
  const ang = Math.random() * Math.PI * 2;
  const rad = Math.sqrt(Math.random()) * s;
  u.copy(dir)
    .addScaledVector(t1, Math.cos(ang) * Math.tan(rad))
    .addScaledVector(t2, Math.sin(ang) * Math.tan(rad))
    .normalize();
  return u;
}
