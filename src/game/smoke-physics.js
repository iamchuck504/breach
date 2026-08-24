// Física pura y compartida del bote de humo. Cliente y servidor usan la
// misma integración/colliders; el navegador puede predecir el vuelo, pero el
// servidor conserva la decisión final de dónde y cuándo nace la nube.
export const SMOKE_GRAVITY = 14;
export const SMOKE_RADIUS = 0.12;
export const SMOKE_REST_HEIGHT = 0.08;

export function makeSmokeProjectile(origin, velocity, extra = {}) {
  return {
    x: origin.x, y: origin.y, z: origin.z,
    vx: velocity.x, vy: velocity.y, vz: velocity.z,
    t: 0,
    ...extra,
  };
}

export function stepSmokeProjectile(p, dt, world) {
  p.t += dt;
  p.vy -= SMOKE_GRAVITY * dt;
  const nx = p.x + p.vx * dt;
  const ny = p.y + p.vy * dt;
  const nz = p.z + p.vz * dt;

  // Paredes/covers: el círculo pequeño se resuelve con la misma geometría
  // usada por personajes, aim y autoridad de impactos.
  const next = { x: nx, z: nz };
  world.resolveCircle(next, SMOKE_RADIUS, Math.max(0, ny));
  let bounced = false;
  if (Math.abs(next.x - nx) > 1e-6) { p.vx = -p.vx * 0.45; bounced = true; }
  if (Math.abs(next.z - nz) > 1e-6) { p.vz = -p.vz * 0.45; bounced = true; }
  p.x = next.x;
  p.z = next.z;

  const ground = world.groundHeight(
    { x: p.x, z: p.z }, SMOKE_RADIUS, Math.max(p.y, ny),
  );
  p.y = ny;
  if (p.y <= ground + SMOKE_REST_HEIGHT && p.vy <= 0) {
    p.y = ground + SMOKE_REST_HEIGHT;
    if (Math.abs(p.vy) > 1.7) {
      p.vy = -p.vy * 0.42;
      p.vx *= 0.62;
      p.vz *= 0.62;
      bounced = true;
    } else {
      p.vy = 0;
      const friction = Math.exp(-5 * dt);
      p.vx *= friction;
      p.vz *= friction;
    }
  }
  return bounced;
}
