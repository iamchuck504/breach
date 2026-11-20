// Distancia de rango/falloff compartida por cliente y servidor. En ADS el
// daño viaja por el eje óptico desde la cámara, ~2.2 m por detrás del
// tirador; el alcance y el falloff se cuentan desde su PLANO (pecho a 1.3 m)
// para no robar esos metros. Un único convenio, por perdigón: distancia al
// punto menos la proyección (pecho − origen) sobre la dirección de ESE punto.
import { TUNING } from '../config/tuning.js';

export const SHOOTER_PLANE_Y = 1.3;
export const SHOOTER_PLANE_MAX = 3;
// holgura del sobre de cámara: suavizado del pivote, latencia de estados y
// redondeo de red (medido: el pivote va ≤0.3 m por detrás al caminar)
const CAMERA_SLACK = 0.6;

// Distancia de p al paralelogramo a + s·u + t·v, s,t ∈ [0,1].
function distToPatch(p, a, u, v) {
  const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2], wv = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
  const at = (s, t) => Math.hypot(w[0] - s * u[0] - t * v[0], w[1] - s * u[1] - t * v[1], w[2] - s * u[2] - t * v[2]);
  const det = uu * vv - uv * uv;
  if (det > 1e-9) {
    const s = (wu * vv - wv * uv) / det, t = (wv * uu - wu * uv) / det;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) return at(s, t);
  }
  const cl = (x) => Math.max(0, Math.min(1, x));
  let best = Infinity;
  // bordes: fijar s o t en 0/1 y minimizar el otro
  for (const s of [0, 1]) best = Math.min(best, at(s, cl(vv > 1e-9 ? (wv - s * uv) / vv : 0)));
  for (const t of [0, 1]) best = Math.min(best, at(cl(uu > 1e-9 ? (wu - t * uv) / uu : 0), t));
  return best;
}

// ¿Es `origin` una cámara ADS posible para esta pose (yaw, pitch del propio
// estado del tirador)? Mismo modelo que core/camera.js: pivote a 0.92 de la
// altura ADS, brazo al hombro (cualquiera de los dos, +0.12 m) y luego hacia
// atrás según yaw/pitch; la colisión de cámara solo puede acortar cada tramo.
export function adsCameraPlausible(pose, origin) {
  const c = TUNING.cam;
  const yaw = pose.yaw || 0, p = pose.p || 0;
  const pivot = [pose.x, (pose.y || 0) + c.aimHeight * 0.92, pose.z];
  const back = [Math.sin(yaw) * Math.cos(p) * c.aimDist, -Math.sin(p) * c.aimDist, Math.cos(yaw) * Math.cos(p) * c.aimDist];
  for (const side of [1, -1]) {
    const arm = [Math.cos(yaw) * c.aimShoulder * side, 0.12, -Math.sin(yaw) * c.aimShoulder * side];
    if (distToPatch(origin, pivot, arm, back) <= CAMERA_SLACK) return true;
  }
  return false;
}

// Vector pecho − origen si la pose (alineada en el tiempo, del propio estado
// del tirador) está en ADS y el origen es su cámara posible; si no, null.
export function adsSetback(pose, origin) {
  if (!pose?.aim || ![pose.x, pose.z, origin[0], origin[1], origin[2]].every(Number.isFinite)) return null;
  if (!adsCameraPlausible(pose, origin)) return null;
  return [pose.x - origin[0], (pose.y || 0) + SHOOTER_PLANE_Y - origin[1], pose.z - origin[2]];
}

// Descuento de UNA dirección (unitaria): proyección acotada del retroceso.
export function planeBaseAlong(planeVec, dir) {
  if (!planeVec) return 0;
  return Math.max(0, Math.min(SHOOTER_PLANE_MAX, planeVec[0] * dir[0] + planeVec[1] * dir[1] + planeVec[2] * dir[2]));
}

export function shooterPlaneDistance(origin, point, planeVec) {
  const d = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!planeVec || len < 0.001) return len;
  return Math.max(0, len - planeBaseAlong(planeVec, d.map((v) => v / len)));
}
