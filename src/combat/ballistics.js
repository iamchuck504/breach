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
  if (t >= 0) {
    const y = o.y + d.y * t;
    if (y >= y0 && y <= y1) return t;
  }
  // tapas (esferas en los extremos) — también cuando el origen está dentro
  // del radio del cilindro pero por encima/debajo del segmento
  const t0 = raySphere(o, d, x, y0, z, r);
  const t1 = raySphere(o, d, x, y1, z, r);
  if (t0 !== null && t1 !== null) return Math.min(t0, t1);
  return t0 ?? t1;
}

// targets: [{id, x, z, y, alive, crouch}] — hitbox de PIE: cuerpo y0.35..1.3
// r0.4, cabeza y1.52 r0.22. AGACHADO (cover bajo): cuerpo 0.26..0.6, cabeza
// 0.86 (tope 1.08 < bloque LOW 1.1) — sin esto, el personaje visualmente
// agachado conservaba la cabeza-hitbox de pie flotando sobre el bloque.
// Devuelve {kind:'world'|'player'|'none', t, point, id, part, normal, surface}.
// normal/surface solo existen para geometría estática válida: nunca personajes.
export function resolveShot(world, targets, origin, dir, maxRange, excludeId = null) {
  const contact = world.raycastHit?.(origin, dir, maxRange) ?? null;
  let bestT = contact?.t ?? world.raycast(origin, dir, maxRange);
  let hit = bestT !== null
    ? { kind: 'world', t: bestT, normal: contact?.normal, surface: contact?.surface || 'concrete' }
    : { kind: 'none', t: maxRange };
  bestT = hit.t;

  for (const tg of targets) {
    if (!tg.alive || tg.id === excludeId) continue;
    const ty = tg.y || 0; // altura de los pies (saltos / encima de cajas)
    const cr = !!tg.crouch;
    const th = raySphere(origin, dir, tg.x, (cr ? 0.86 : 1.52) + ty, tg.z, 0.22);
    if (th !== null && th < bestT) { bestT = th; hit = { kind: 'player', t: th, id: tg.id, part: 'head' }; continue; }
    const tb = rayCapsule(origin, dir, tg.x, tg.z, (cr ? 0.26 : 0.35) + ty, (cr ? 0.6 : 1.3) + ty, cr ? 0.42 : 0.4);
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
