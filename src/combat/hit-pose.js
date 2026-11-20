// Volumen de impacto según la POSE dibujada. Módulo puro (sin Three.js): lo
// usan el cliente (resolveShot, bots) y el servidor (validación de claims).
// Antes el volumen salía solo del nombre del estado: `cover_low` era siempre
// agachado aunque el rig se pusiera de pie para apuntar sobre el bloque, y
// el casco visible no se podía impactar desde el frente.
//
// Marco del personaje: f = adelante, s = derecha, y = altura sobre los pies.
// Con yaw: adelante = (-sin yaw, -cos yaw), derecha = (cos yaw, -sin yaw).
// Volumen = esfera de cabeza (h, hr) + cápsula de cuerpo (segmento a→b, br).

import { TUNING } from '../config/tuning.js';

export const HEAD_R = 0.22;
// Volúmenes de siempre (ballistics.js): de pie y agachado tras cover bajo.
export const STAND = Object.freeze({ h: [0, 0, 1.52], hr: HEAD_R, a: [0, 0, 0.35], b: [0, 0, 1.3], br: 0.4, legacy: 'stand' });
export const CROUCH = Object.freeze({ h: [0, 0, 0.86], hr: HEAD_R, a: [0, 0, 0.26], b: [0, 0, 0.6], br: 0.42, legacy: 'crouch' });
export const CROUCH_STATES = new Set(['cover_low', 'blind_over', 'blind_low_left', 'blind_low_right']);
// Regla anterior (solo nombre de estado): la usa quien habla con un servidor
// o un tirador que no anunció este modelo (versiones mezcladas).
export const legacyVolume = (st) => (CROUCH_STATES.has(st) ? CROUCH : STAND);
// Modelo de impacto acordado con el servidor: 2 = pose (este módulo), 1 =
// regla anterior. Offline siempre 2; online lo fija el `welcome` (campo hp).
let MODEL = 2;
export function setHitModel(v) { MODEL = v === 1 ? 1 : 2; }
export const hitModel = () => MODEL;

// Tabla medida sobre el rig real con scripts/calibrate-hit-pose.mjs (anclada
// a STAND: idle dibujado = volumen de pie). Regenerar con --write si cambia
// una pose de rig.js; no editar a mano.
const CAL = {
  // <calibrado>
  crouch: {h:[-0.83,0,0.84],a:[0.08,0.07,-0.09],b:[-0.51,-0.05,0.5]},
  low_aim: {h:[0.08,0.05,1.49],a:[-0.01,0.04,0.36],b:[0.09,-0.04,1.29]},
  low_aim_down: {h:[0.14,0.06,1.62],a:[-0.01,0.04,0.55],b:[0.13,-0.04,1.47]},
  low_lean_r: {h:[0.02,0.31,1],a:[-0.02,0.15,-0.12],b:[0.05,0.19,0.81]},
  low_lean_l: {h:[0.13,-0.2,0.99],a:[-0.01,-0.08,-0.12],b:[0.13,-0.26,0.79]},
  high_lean_r: {h:[0.02,0.31,1.44],a:[-0.02,0.15,0.32],b:[0.05,0.19,1.25]},
  high_lean_l: {h:[0.13,-0.2,1.43],a:[-0.01,-0.08,0.32],b:[0.13,-0.26,1.23]},
  blind_over: {h:[0.08,0.02,1.02],a:[-0.02,0.07,-0.14],b:[0.09,-0.05,0.79]},
  blind_over_down: {h:[0.08,0.02,1.28],a:[-0.02,0.07,0.12],b:[0.09,-0.05,1.05]},
  ads_pistol: {h:[0.06,0,1.51],a:[-0.02,0.07,0.36],b:[0.06,-0.08,1.29]},
  ads_smg: {h:[0.05,0.11,1.5],a:[0,0.01,0.36],b:[0.08,-0.01,1.29]},
  ads_shotgun: {h:[0.07,0.11,1.5],a:[0.01,0.01,0.36],b:[0.1,-0.01,1.3]},
  ads_sniper: {h:[0.09,0.11,1.48],a:[0.01,0.01,0.36],b:[0.11,-0.01,1.29]},
  ads_bazooka: {h:[0.15,0,1.47],a:[-0.01,0.07,0.37],b:[0.13,-0.08,1.28]},
  ads_grenade: {h:[0.07,0,1.5],a:[-0.02,0.07,0.36],b:[0.07,-0.08,1.29]},
  ads_pistol_down: {h:[0.08,0,1.47],a:[-0.02,0.07,0.36],b:[0.06,-0.08,1.29]},
  ads_smg_down: {h:[0.06,0.13,1.47],a:[0,0.01,0.36],b:[0.08,-0.01,1.29]},
  ads_shotgun_down: {h:[0.08,0.13,1.46],a:[0.01,0.01,0.36],b:[0.1,-0.01,1.29]},
  ads_sniper_down: {h:[0.1,0.12,1.46],a:[0.01,0.01,0.36],b:[0.11,-0.01,1.29]},
  ads_bazooka_down: {h:[0.16,0,1.45],a:[-0.01,0.07,0.37],b:[0.13,-0.08,1.28]},
  ads_grenade_down: {h:[0.09,0,1.47],a:[-0.02,0.07,0.36],b:[0.07,-0.08,1.29]},
  roadie: {h:[0.36,-0.01,1.35],a:[0.03,0.07,0.34],b:[0.34,-0.08,1.15]},
  dive_2: {h:[0.4,0.06,1.18],a:[0.03,0.08,0.21],b:[0.36,-0.03,1.01]},
  dive_5: {h:[0.54,0.1,0.9],a:[0.07,0.08,0.12],b:[0.48,0.01,0.81]},
  dive_8: {h:[0.4,0.06,1.18],a:[0.03,0.08,0.21],b:[0.36,-0.03,1.01]},
  slide: {h:[-0.16,-0.08,1.24],a:[-0.04,0.06,0.05],b:[-0.11,-0.14,0.99]},
  mantle_2: {h:[0.44,-0.04,1.2],a:[0.05,0.07,0.27],b:[0.4,-0.1,1.02]},
  mantle_4: {h:[0.53,-0.05,1.06],a:[0.07,0.06,0.23],b:[0.48,-0.11,0.91]},
  mantle_5: {h:[0.51,-0.05,1.1],a:[0.06,0.07,0.24],b:[0.46,-0.11,0.94]},
  mantle_8: {h:[0.12,0,1.47],a:[-0.01,0.07,0.33],b:[0.13,-0.08,1.24]},
  flip_0: {h:[0.15,0,1.54],a:[-0.01,0.07,0.43],b:[0.14,-0.08,1.34]},
  flip_2: {h:[0.15,0.78,0.97],a:[-0.01,0.17,0.36],b:[0.17,0.53,1.01]},
  flip_5: {h:[0.15,0,-0.09],a:[-0.01,0.07,0.22],b:[0.31,0.02,0.21]},
  flip_8: {h:[0.15,-0.78,0.97],a:[-0.01,-0.03,0.36],b:[0.13,-0.6,0.91]},
  flip_pivot: [0.34,0,0.72],
  // </calibrado>
};

// arma en mano -> pose de ADS de rig.js (stun usa la de pistola, frag la de granada)
const ADS_KEY = { pistol: 'pistol', stun: 'pistol', smg: 'smg', shotgun: 'shotgun', sniper: 'sniper',
  bazooka: 'bazooka', grenade: 'grenade', frag: 'grenade' };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix3 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
function mix(A, B, t) {
  if (t <= 0) return A;
  if (t >= 1) return B;
  return { h: mix3(A.h, B.h, t), hr: HEAD_R, a: mix3(A.a, B.a, t), b: mix3(A.b, B.b, t),
    br: A.br + (B.br - A.br) * t, legacy: null };
}
// Radio del cuerpo por pose, ajustado con la sonda run4/exposicion (no a ojo):
// en sprint y mantle los brazos van extendidos delante del tronco.
const BODY_R = { roadie: 0.43, mantle_4: 0.47, ads_bazooka: 0.43, ads_bazooka_down: 0.43, slide: 0.48, dive_5: 0.45 };
const cal = (k) => ({ hr: HEAD_R, br: BODY_R[k] ?? 0.4, legacy: null, ...CAL[k] });

// Giro del flip alrededor de la cadera ('z' = lateral, 'x' = mortal), igual
// que rig.js: hips.rotation.z = -dir·ang / hips.rotation.x = dir·ang.
function rotFlip(p, piv, ang, axis) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const df = p[0] - piv[0], ds = p[1] - piv[1], dy = p[2] - piv[2];
  if (axis === 'x') return [piv[0] + df * c - dy * s, p[1], piv[2] + df * s + dy * c];
  return [p[0], piv[1] + ds * c + dy * s, piv[2] - ds * s + dy * c];
}

// pose: { st, aim, ce, cl, pitch, phase, flipDir, flipAxis, wep }
//   ce  exposición de apuntado sobre cover bajo (0..1); ausente = regla antigua
//   cl  lado de asomado en la orilla (-1 izq .. 1 der)
//   phase  progreso de dive/mantle/flip (0..1); ausente = media pose del rig
export function hitPose(pose = {}) {
  const st = pose.st || 'idle';
  const aim = !!pose.aim;
  const cl = Math.max(-1, Math.min(1, Number(pose.cl) || 0));
  const lean = Math.abs(cl) > 0.01 ? cl : 0;
  const ph = Number.isFinite(pose.phase) ? clamp01(pose.phase) : 0.5;
  switch (st) {
    case 'cover_low': {
      // escondido (o sin dato de exposición): exactamente lo de siempre
      if (!aim || !Number.isFinite(pose.ce)) return CROUCH;
      const down = clamp01(-(Number(pose.pitch) || 0) / 0.55);
      const up = mix(cal('low_aim'), cal('low_aim_down'), down);
      const rise = mix(CROUCH, up, clamp01(pose.ce)); // sube con la exposición, sin saltos
      return lean ? mix(rise, cal(lean > 0 ? 'low_lean_r' : 'low_lean_l'), Math.abs(lean)) : rise;
    }
    case 'cover_high':
      return aim && lean ? mix(STAND, cal(lean > 0 ? 'high_lean_r' : 'high_lean_l'), Math.abs(lean)) : STAND;
    case 'blind_over': // agachado tras el bloque; apuntar abajo alza la cadera (rig.js BLIND_OVER.rise)
      return mix(cal('blind_over'), cal('blind_over_down'), clamp01(-(Number(pose.pitch) || 0) / 0.55));
    case 'blind_low_left': case 'blind_low_right': return CROUCH;
    case 'roadie': return cal('roadie');
    case 'slide': return cal('slide');
    case 'dive': return mix(STAND, cal('dive_5'), Math.sin(Math.PI * ph));
    case 'mantle': return mix(STAND, cal('mantle_4'), Math.sin(Math.PI * Math.min(1, ph / 0.8)));
    case 'flip': {
      const base = cal('flip_0'), piv = CAL.flip_pivot;
      const axis = pose.flipAxis === 'x' ? 'x' : 'z';
      const ang = (pose.flipDir === -1 ? -1 : 1) * ph * Math.PI * 2;
      return { ...base, h: rotFlip(base.h, piv, ang, axis), a: rotFlip(base.a, piv, ang, axis), b: rotFlip(base.b, piv, ang, axis) };
    }
    case 'idle': case 'run': case 'jump': {
      // ADS en abierto: cada arma tiene su pose (perfilado, cabeza girada
      // hacia la culata); `wep` es el arma en mano (replicada como `w`)
      if (!aim) return STAND;
      const k = CAL['ads_' + ADS_KEY[pose.wep]] ? 'ads_' + ADS_KEY[pose.wep] : 'ads_smg';
      // mirar abajo inclina la cabeza (rig.js: head = pitch · adsPose.head)
      return mix(cal(k), cal(k + '_down'), clamp01(-(Number(pose.pitch) || 0) / 0.55));
    }
    default: return STAND;
  }
}

// Volumen en mundo para resolveShot: { hx,hy,hz,hr, ax,ay,az, bx,by,bz, br }.
export function placeHitPose(vol, x, y, z, yaw = 0) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const P = (p) => [x + fx * p[0] + rx * p[1], y + p[2], z + fz * p[0] + rz * p[1]];
  const h = P(vol.h), a = P(vol.a), b = P(vol.b);
  return { hx: h[0], hy: h[1], hz: h[2], hr: vol.hr, ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], br: vol.br };
}

// Campos de un objetivo para resolveShot: `crouch` conserva la ruta antigua
// en las poses de siempre; `hit` solo existe cuando la pose difiere (y
// entonces manda en resolveShot). Con `hit`, `crouch` solo dice "pose baja"
// (cabeza bajo 1.2 m) a quien apunta o calcula alturas (IA, blast.js).
export function hitFields(pose, x, y, z, yaw) {
  const vol = MODEL === 1 ? legacyVolume(pose.st) : hitPose(pose);
  if (vol.legacy) return { crouch: vol.legacy === 'crouch', hit: null, hitVol: vol };
  return { crouch: vol.h[2] < 1.2, hit: placeHitPose(vol, x, y || 0, z, Number.isFinite(yaw) ? yaw : 0), hitVol: vol };
}

// Alturas de puntería de la IA ancladas a las de siempre (0.78/1.02 al
// cuerpo, 0.9/1.3 de visibilidad) y desplazadas con la cabeza dibujada.
export function hitAimHeights(vol) {
  const t = Math.max(0, Math.min(1.25, (vol.h[2] - CROUCH.h[2]) / (STAND.h[2] - CROUCH.h[2])));
  // blast: altura de las muestras de exposición (blast.js: 0.85 / 1.65)
  return { body: 0.78 + 0.24 * t, eye: 0.9 + 0.4 * t, blast: 0.85 + 0.8 * Math.min(1, t) };
}

// ---------- validación de claims (servidor) ----------
// El servidor valida contra lo que VEÍA el tirador: el historial guarda las
// poses tal como se difundieron (reloj monótono del servidor) y se elige UN
// instante, shotAt − (interpDelay + rtt). Allí se interpola la transformada
// COMPLETA (posición, yaw, estado, exposición, asomado y fase de la acción) y
// un solo volumen decide cuerpo y cabeza. Holguras: espacial, 0.82 m en
// planta alrededor de esa pose; temporal, ±CLAIM_JITTER moviendo la pose
// entera (posición y postura del MISMO instante). Nunca se usan snapshots
// difundidos después de recibir el disparo.
//
// rtt: mínimo de las muestras recientes de ping (difícil de inflar: hay que
// retrasar TODAS las respuestas) con tope RTT_CAP. Tope 0.25 s: por encima la
// partida ya no es jugable y cada ms de más es ventaja de rebobinado para
// quien retrasa sus pongs. Sin muestras, RTT_DEFAULT.
export const RTT_CAP = 0.25;
export const RTT_DEFAULT = 0.1;
export const CLAIM_JITTER = 0.5 / TUNING.net.sendHz + 0.06;
export const viewDelay = (rtt) => TUNING.net.interpDelay +
  Math.min(RTT_CAP, Math.max(0, Number.isFinite(rtt) ? rtt : RTT_DEFAULT));
// rebobinado máximo de la pose: interpDelay + RTT_CAP + CLAIM_JITTER
export const CLAIM_REWIND_MAX = TUNING.net.interpDelay + RTT_CAP + CLAIM_JITTER;

// Duraciones y reglas de controller.js para las acciones; las mismas que usa
// el observador remoto (remote.js) para dibujarlas.
export const ROLL_DUR = TUNING.jump.rollDur;
export const WALL_FLIP_DUR = Math.max(0.4, (2 * TUNING.jump.wallVel / TUNING.jump.gravity) * 0.92);
// La vuelta del doble salto sale a ≥ runSpeed·dashMul (5,5 m/s); la patada de
// pared, a ≤ 4,9 (empuje 3,8 + 0,4 de la velocidad a lo largo del muro).
const ROLL_MIN_SPEED = (TUNING.move.runSpeed * TUNING.jump.dashMul + 4.9) / 2;

// Eje y sentido de una vuelta a partir del recorrido (mismas reglas que
// controller.js). pre/post: velocidad horizontal antes y después de entrar al
// flip; camYaw: hacia dónde miraba la cámara (yaw + ae del snapshot).
export function inferFlip(pre, post, camYaw) {
  const J = TUNING.jump;
  const hs = Math.hypot(post.x, post.z);
  if (hs >= ROLL_MIN_SPEED) {
    // doble salto: el stick (marco de cámara) elige eje y sentido
    const f = post.x * -Math.sin(camYaw) + post.z * -Math.cos(camYaw);
    const s = post.x * Math.cos(camYaw) - post.z * Math.sin(camYaw);
    if (Math.abs(f) >= Math.abs(s)) return { kind: 'roll', axis: 'x', dir: f >= 0 ? -1 : 1, dur: ROLL_DUR };
    return { kind: 'roll', axis: 'z', dir: s >= 0 ? 1 : -1, dur: ROLL_DUR };
  }
  // patada de pared: post = n·wallPush + t·0,4·lat con lat = pre·t y
  // t = (-n.z, n.x). Se despeja n por punto fijo partiendo del cambio de
  // velocidad (dominado por el empuje desde el muro).
  let nx = post.x - pre.x, nz = post.z - pre.z;
  let l = Math.hypot(nx, nz);
  if (l < 1e-3) return { kind: 'wall', axis: 'x', dir: 1, dur: WALL_FLIP_DUR };
  nx /= l; nz /= l;
  let lat = 0;
  for (let i = 0; i < 4; i++) {
    const tx = -nz, tz = nx;
    lat = pre.x * tx + pre.z * tz;
    const mx = post.x - tx * lat * 0.4, mz = post.z - tz * lat * 0.4;
    l = Math.hypot(mx, mz);
    if (l < 1e-3) break;
    nx = mx / l; nz = mz / l;
  }
  const lateral = Math.abs(lat) >= J.backflipLat;
  return { kind: 'wall', axis: lateral ? 'z' : 'x', dir: lateral ? (lat >= 0 ? 1 : -1) : 1, dur: WALL_FLIP_DUR };
}

const lerpAngle = (a, b, k) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

// Pose interpolada en t entre los dos snapshots difundidos que lo rodean,
// igual que el cliente remoto: continuos interpolados, discretos (estado,
// aim, arma) del posterior. history: [{ at, x, y, z, yaw, st, aim, ce?, cl, p, ae, sp, w }]
export function poseAt(history, t) {
  if (!history?.length) return null;
  let i = history.length - 1;
  while (i > 0 && history[i - 1].at > t) i--;
  const s2 = history[i], s1 = history[Math.max(0, i - 1)];
  if (s1 === s2 || t >= s2.at) return { ...s2, i };
  const k = Math.max(0, Math.min(1, (t - s1.at) / Math.max(1e-4, s2.at - s1.at)));
  const L = (a, b) => (a ?? 0) + ((b ?? 0) - (a ?? 0)) * k;
  return { ...s2, i, at: t, x: L(s1.x, s2.x), y: L(s1.y, s2.y), z: L(s1.z, s2.z), yaw: lerpAngle(s1.yaw || 0, s2.yaw || 0, k),
    cl: L(s1.cl, s2.cl), p: L(s1.p, s2.p),
    ...(Number.isFinite(s2.ce) ? { ce: Number.isFinite(s1.ce) ? L(s1.ce, s2.ce) : s2.ce } : {}) };
}

// Datos de la acción en curso tal como los reconstruye el observador:
// entrada = punto medio entre el último snapshot previo y el primero de la
// acción; eje/sentido/duración del flip por el recorrido una vez que el
// observador tiene 0.16 s de vuelo en su buffer (va interpDelay por delante).
function actionAt(history, pose, t) {
  let j = pose.i;
  while (j > 0 && history[j - 1].st === pose.st) j--;
  const first = history[j], prev = history[j - 1];
  const entry = prev ? (prev.at + first.at) / 2 : first.at;
  const since = Math.max(0, t - entry), ahead = t + TUNING.net.interpDelay;
  if (pose.st === 'dive') return { phase: since / TUNING.evade.diveTime };
  if (pose.st === 'mantle') {
    // remote.js: si el buffer ya muestra el final, la fase llega a 1 justo ahí
    let end = null;
    for (let k = j; k < history.length && history[k].at <= ahead; k++) {
      if (history[k].at > t && history[k].st !== 'mantle') { end = history[k - 1].at; break; }
    }
    return { phase: Math.max(since / TUNING.mantle.time, end != null ? since / Math.max(1e-3, since + end - t) : 0) };
  }
  // flip
  let info = { axis: 'z', dir: 1, dur: WALL_FLIP_DUR };
  if (history[history.length - 1].at >= entry + 0.16 && ahead >= entry + 0.16) {
    const vel = (a, b) => {
      const p = poseAt(history, a), q = poseAt(history, b), w = Math.max(1e-3, b - a);
      return { x: (q.x - p.x) / w, z: (q.z - p.z) / w };
    };
    const pre = vel(entry - 0.1, entry), post = vel(entry + 0.03, entry + 0.16);
    const RS = TUNING.move.roadieSpeed;
    const scale = (v, sp) => {
      const h = Math.hypot(v.x, v.z);
      if (Number.isFinite(sp) && h > 1e-3) { v.x *= sp * RS / h; v.z *= sp * RS / h; }
    };
    scale(pre, prev?.sp); scale(post, (history[j + 1]?.st === 'flip' ? history[j + 1] : first).sp);
    info = inferFlip(pre, post, (first.yaw || 0) + (first.ae || 0));
  }
  return { phase: since / info.dur, flipAxis: info.axis, flipDir: info.dir };
}

// UN volumen: la pose difundida en t (y su acción) o la regla anterior.
export function shapeAt(history, t, legacy = false) {
  const pose = poseAt(history, t);
  if (!pose) return null;
  if (legacy) return { pose, vol: legacyVolume(pose.st) };
  const base = { st: pose.st, aim: !!pose.aim, ce: pose.ce, cl: pose.cl, pitch: pose.p, wep: pose.w };
  const act = pose.st === 'dive' || pose.st === 'mantle' || pose.st === 'flip' ? actionAt(history, pose, t) : {};
  return { pose, vol: hitPose({ ...base, ...act, phase: act.phase !== undefined ? clamp01(act.phase) : undefined }) };
}

// ¿Está el punto dentro de la esfera de cabeza? Devuelve su centro o null.
export function volContainsHead(vol, pose, point, slack = 0.02) {
  const w = placeHitPose(vol, pose.x || 0, pose.y || 0, pose.z || 0, pose.yaw || 0);
  return Math.hypot(point[0] - w.hx, point[1] - w.hy, point[2] - w.hz) <= w.hr + slack ? [w.hx, w.hy, w.hz] : null;
}

// ¿Está el punto DENTRO del volumen? (impacto a quemarropa: contacto de
// longitud cero, sin dirección de disparo)
export function volContains(vol, pose, point, slack = 0.05) {
  const w = placeHitPose(vol, pose.x || 0, pose.y || 0, pose.z || 0, pose.yaw || 0);
  if (Math.hypot(point[0] - w.hx, point[1] - w.hy, point[2] - w.hz) <= w.hr + slack) return true;
  const ux = w.bx - w.ax, uy = w.by - w.ay, uz = w.bz - w.az, l2 = ux * ux + uy * uy + uz * uz;
  const k = l2 > 1e-9 ? Math.max(0, Math.min(1, ((point[0] - w.ax) * ux + (point[1] - w.ay) * uy + (point[2] - w.az) * uz) / l2)) : 0;
  return Math.hypot(point[0] - (w.ax + ux * k), point[1] - (w.ay + uy * k), point[2] - (w.az + uz * k)) <= w.br + slack;
}

// Claim de un impacto. history: poses difundidas (reloj monótono), la última
// = estado actual. Devuelve { pose, vol, head, inside } o null.
export function claimPose(history, shotAt, point, { rtt, legacy = false, headOk = null, tolerance = 0.82,
  pointBlank = false, step = 0.02 } = {}) {
  // solo lo difundido hasta recibir el disparo; sin nada difundido antes de
  // la recepción no hay pose que el tirador pudiera ver: se rechaza
  const seen = history?.filter((p) => p.at <= shotAt) ?? [];
  if (!seen.length) return null;
  const c = shotAt - viewDelay(rtt);
  const n = Math.round(CLAIM_JITTER / step);
  for (let m = 0; m <= 2 * n; m++) {
    // orden 0, +1, −1, +2, −2…: el instante más cercano al estimado manda
    const k = m === 0 ? 0 : (m % 2 ? (m + 1) / 2 : -m / 2);
    const t = Math.min(shotAt, c + k * step);
    const shape = shapeAt(seen, t, legacy);
    if (!shape || claimFit(shape.vol, shape.pose, point, tolerance) === null) continue;
    const h = headFit(shape.vol, shape.pose, point);
    // quemarropa (contacto sin dirección): dentro de la esfera de cabeza es cabeza
    const inHead = pointBlank ? volContainsHead(shape.vol, shape.pose, point) : null;
    return { pose: shape.pose, vol: shape.vol, head: h && (!headOk || headOk(h)) ? h : inHead,
      inside: volContains(shape.vol, shape.pose, point) };
  }
  return null;
}

// Volumen del estado actual (cabeza del punto de muerte, blast).
export function currentVolume(history) {
  const last = history?.[history.length - 1];
  return last ? shapeAt(history, last.at).vol : STAND;
}

// Banda vertical de cada volumen. Ancladas a las de siempre: de pie 1.30..1.82
// (cabeza) y techo 1.88; agachado 0.66..1.16 y techo 1.18.
const LEGACY_BAND = { stand: { headMin: 1.30, headMax: 1.82, top: 1.88 }, crouch: { headMin: 0.66, headMax: 1.16, top: 1.18 } };
export function claimBand(vol) {
  if (vol.legacy) return LEGACY_BAND[vol.legacy];
  const hy = vol.h[2], t = clamp01((hy - CROUCH.h[2]) / (STAND.h[2] - CROUCH.h[2]));
  return { headMin: hy - 0.20 - 0.02 * t, headMax: hy + 0.30,
    top: Math.max(hy + 0.32 + 0.04 * t, vol.a[2] + vol.br + 0.1, vol.b[2] + vol.br + 0.1) };
}

function segDist2(px, pz, ax, az, bx, bz) {
  const ux = bx - ax, uz = bz - az, l2 = ux * ux + uz * uz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * ux + (pz - az) * uz) / l2)) : 0;
  const dx = px - (ax + ux * t), dz = pz - (az + uz * t);
  return dx * dx + dz * dz;
}

// ¿Puede `point` ([x,y,z]) pertenecer a este volumen? Devuelve la distancia
// en planta al eje cuerpo→cabeza (para elegir pose) o null.
export function claimFit(vol, pose, point, tolerance = 0.82) {
  const relY = point[1] - (pose.y || 0);
  // suelo: 0.12 m sobre los pies, salvo poses que bajan de ahí (flip boca abajo)
  const floor = vol.legacy ? 0.12 : Math.min(0.12, vol.h[2] - vol.hr - 0.05, vol.a[2] - vol.br - 0.05, vol.b[2] - vol.br - 0.05);
  if (relY < floor || relY > claimBand(vol).top) return null;
  const w = placeHitPose(vol, pose.x || 0, pose.y || 0, pose.z || 0, pose.yaw || 0);
  const d = Math.sqrt(Math.min(segDist2(point[0], point[2], w.ax, w.az, w.bx, w.bz),
    segDist2(point[0], point[2], w.bx, w.bz, w.hx, w.hz)));
  return d <= tolerance ? d : null;
}

// Centro de cabeza en mundo si el punto cae en su banda, o null.
export function headFit(vol, pose, point, tolerance = 1.25) {
  const band = claimBand(vol), relY = point[1] - (pose.y || 0);
  if (relY < band.headMin || relY > band.headMax) return null;
  const w = placeHitPose(vol, pose.x || 0, pose.y || 0, pose.z || 0, pose.yaw || 0);
  return Math.hypot(point[0] - w.hx, point[2] - w.hz) <= tolerance ? [w.hx, w.hy, w.hz] : null;
}
