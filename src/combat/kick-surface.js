import { Vector3 } from 'three';

// Rayo de escenario de weapons/logic/core.ts de CRASHTERRA. Se consulta
// después de resolver a los jugadores, únicamente para sonido y polvo.
export function kickWorldContact(world, eye, dir) {
  const hip = new Vector3().copy(eye);
  hip.y -= 0.55;
  const pitch = Math.max(-0.5, Math.min(0.5, Math.asin(Math.max(-1, Math.min(1, dir.y)))));
  const forward = new Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(Math.cos(pitch));
  forward.y = Math.sin(pitch);
  const surface = world.raycastHit?.(hip, forward, 1.6) ?? null;
  return surface && { point: hip.addScaledVector(forward, surface.t), normal: new Vector3().copy(surface.normal) };
}
