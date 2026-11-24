// Golpe (melee) compartido por cliente y servidor (ronda 2, R6): la selección
// del blanco y el alcance se miden desde el OJO de la muestra del golpe, y el
// barrido va ojo → punto. Antes el cliente elegía desde los pies y barría
// desde el pecho mientras el servidor medía desde el ojo: contra un rival más
// bajo o agachado salía marcador local sin daño.
// Módulo puro (sin three): lo importan main.js (INTEGRACIÓN) y server.js.
export const MELEE_REACH = 1.95;   // m desde el ojo (la regla de siempre del servidor)
export const MELEE_CONE = 62;      // grados: el gesto (punto declarado del `fire`), regla de HEAD
export const MELEE_HIT_CONE = 58;  // grados: el blanco (su CENTRO), regla de HEAD para el `hit`
export const MELEE_NET_TOL = 0.28; // holgura de red en el alcance del `hit`

// Punto del volumen de impacto (formato de placeHitPose/hitFields.hit:
// { hx,hy,hz,hr, ax,ay,az, bx,by,bz, br }) más cercano a `eye`.
export function meleeTargetPoint(eye, w, aimYaw) {
  const toHead = [w.hx - eye[0], w.hy - eye[1], w.hz - eye[2]], lh = Math.hypot(...toHead);
  const head = lh > w.hr ? [eye[0] + toHead[0] * (lh - w.hr) / lh, eye[1] + toHead[1] * (lh - w.hr) / lh, eye[2] + toHead[2] * (lh - w.hr) / lh] : eye.slice();
  const u = [w.bx - w.ax, w.by - w.ay, w.bz - w.az], l2 = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const k = l2 > 1e-9 ? Math.max(0, Math.min(1, ((eye[0] - w.ax) * u[0] + (eye[1] - w.ay) * u[1] + (eye[2] - w.az) * u[2]) / l2)) : 0;
  const c = [w.ax + u[0] * k, w.ay + u[1] * k, w.az + u[2] * k];
  const toBody = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]], lb = Math.hypot(...toBody);
  const body = lb > w.br ? [eye[0] + toBody[0] * (lb - w.br) / lb, eye[1] + toBody[1] * (lb - w.br) / lb, eye[2] + toBody[2] * (lb - w.br) / lb] : eye.slice();
  const dh = Math.hypot(head[0] - eye[0], head[1] - eye[1], head[2] - eye[2]);
  const db = Math.hypot(body[0] - eye[0], body[1] - eye[1], body[2] - eye[2]);
  const h = { point: head, part: 'head', dist: dh }, b = { point: body, part: 'body', dist: db };
  const [nearest, other] = dh <= db ? [h, b] : [b, h];
  if (aimYaw === undefined || meleeReachOk(eye, aimYaw, nearest.point)) return nearest;
  if (meleeReachOk(eye, aimYaw, other.point)) return other;
  // El hombro inclinado puede quedar fuera del gesto aunque la parte baja
  // del tronco sí dé contacto. Probar la superficie de la tapa inferior.
  const delta = [w.ax-eye[0], w.ay-eye[1], w.az-eye[2]];
  const length = Math.hypot(...delta), dist = Math.max(0, length-w.br);
  const point = eye.map((v,i) => v + delta[i] * dist / (length || 1));
  return meleeReachOk(eye, aimYaw, point) ? {point, part: 'body', dist} : null;
}

// ¿Alcanza el golpe `point` desde `eye` mirando a `aimYaw`? (cono en planta)
export function meleeReachOk(eye, aimYaw, point, reach = MELEE_REACH) {
  const dx = point[0] - eye[0], dz = point[2] - eye[2], d = Math.hypot(dx, point[1] - eye[1], dz);
  if (d > reach) return false;
  const lh = Math.hypot(dx, dz);
  if (lh < 0.001) return true;
  const fx = -Math.sin(aimYaw), fz = -Math.cos(aimYaw);
  return (dx * fx + dz * fz) / lh >= Math.cos(MELEE_CONE * Math.PI / 180);
}

// C3 (ronda 3): UN criterio en cliente y servidor para acreditar el golpe:
// el CENTRO del blanco dentro de MELEE_HIT_CONE (58°, el de HEAD) alrededor
// del yaw de MIRADA (no del cuerpo) y el punto de contacto (meleeTargetPoint)
// a ≤ reach del ojo. 62° sobre el punto de contacto era más laxo que HEAD.
export function meleeHitOk(eye, aimYaw, contact, centre, reach = MELEE_REACH) {
  if (Math.hypot(contact[0] - eye[0], contact[1] - eye[1], contact[2] - eye[2]) > reach) return false;
  const dx = centre[0] - eye[0], dz = centre[2] - eye[2], lh = Math.hypot(dx, dz);
  if (lh < 0.001) return true;
  const fx = -Math.sin(aimYaw), fz = -Math.cos(aimYaw);
  return (dx * fx + dz * fz) / lh >= Math.cos(MELEE_HIT_CONE * Math.PI / 180);
}
