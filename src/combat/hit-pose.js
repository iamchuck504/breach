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
  roadie: {h:[0.36,-0.04,1.36],a:[0.03,0.07,0.35],b:[0.34,-0.09,1.15]},
  dive_2: {h:[0.4,0.06,1.18],a:[0.03,0.08,0.21],b:[0.36,-0.03,1.01]},
  dive_5: {h:[0.54,0.1,0.9],a:[0.07,0.08,0.12],b:[0.48,0.01,0.81]},
  dive_8: {h:[0.4,0.06,1.18],a:[0.03,0.08,0.21],b:[0.36,-0.03,1.01]},
  // Guarda de esquiva: desplazamiento medido del rig respecto al reposo.
  dodge: {h:[0.08,0,1.42],a:[-0.02,0.07,0.26],b:[0.09,-0.08,1.19]},
  slide: {h:[-0.3,0,1.11],a:[-0.06,0.07,-0.06],b:[-0.26,-0.08,0.87]},
  mantle_2: {h:[0.44,-0.04,1.2],a:[0.05,0.07,0.27],b:[0.4,-0.1,1.02]},
  mantle_4: {h:[0.53,-0.05,1.06],a:[0.07,0.06,0.23],b:[0.48,-0.11,0.91]},
  mantle_5: {h:[0.51,-0.05,1.1],a:[0.06,0.07,0.24],b:[0.46,-0.11,0.94]},
  mantle_8: {h:[0.12,0,1.47],a:[-0.01,0.07,0.33],b:[0.13,-0.08,1.24]},
  flip_0: {h:[0.15,0,1.54],a:[-0.01,0.07,0.43],b:[0.14,-0.08,1.34]},
  flip_2: {h:[0.15,0.78,0.97],a:[-0.01,0.17,0.36],b:[0.17,0.53,1.01]},
  flip_5: {h:[0.15,0,-0.09],a:[-0.01,0.07,0.22],b:[0.31,0.02,0.21]},
  flip_8: {h:[0.15,-0.78,0.97],a:[-0.01,-0.03,0.36],b:[0.13,-0.6,0.91]},
  flip_pivot: [0.34,0,0.72],
  crouch_idle: {h:[0.24,-0.01,0.69],a:[-0.23,0.03,-0.05],b:[0.18,-0.02,0.64]},
  crouch_aim: {h:[0.22,0.1,0.7],a:[-0.23,0.03,-0.05],b:[0.18,-0.02,0.64]},
  lean_stand_r: {h:[0,0.23,-0.09],b:[0.01,0.18,-0.09]},
  lean_stand_aim_r: {h:[0.02,0.22,-0.15],b:[0.01,0.18,-0.08]},
  lean_crouch_r: {h:[-0.01,0.2,0.01],b:[0.01,0.21,0.01]},
  lean_crouch_aim_r: {h:[0.01,0.21,-0.01],b:[0.01,0.2,0.01]},
  lean_stand_l: {h:[-0.01,-0.23,-0.09],b:[-0.01,-0.18,-0.08]},
  lean_stand_aim_l: {h:[-0.02,-0.24,-0.06],b:[-0.01,-0.17,-0.09]},
  lean_crouch_l: {h:[-0.01,-0.21,0.02],b:[0,-0.21,0.02]},
  lean_crouch_aim_l: {h:[-0.01,-0.21,0.04],b:[0,-0.21,0.01]},
  crouch_idle_25: {h:[0.22,-0.01,0.94],a:[-0.17,0.02,0.05],b:[0.16,-0.01,0.84]},
  crouch_aim_25: {h:[0.21,0.11,0.94],a:[-0.17,0.03,0.06],b:[0.17,-0.02,0.83]},
  crouch_idle_50: {h:[0.17,0,1.16],a:[-0.12,0.01,0.15],b:[0.12,-0.01,1.02]},
  crouch_aim_50: {h:[0.18,0.11,1.16],a:[-0.12,0.02,0.16],b:[0.15,-0.01,1.01]},
  crouch_idle_75: {h:[0.1,0,1.36],a:[-0.06,0.01,0.25],b:[0.06,0,1.17]},
  crouch_aim_75: {h:[0.12,0.11,1.34],a:[-0.06,0.01,0.26],b:[0.12,-0.01,1.16]},
  // </calibrado>
};
// Para calibrate-hit-pose.mjs: conserva las entradas que el rig aún no puede
// medir (postura sin pose propia en rig.js) en vez de borrarlas.
export const CALIBRATION = CAL;

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
const BODY_R = { roadie: 0.43, mantle_4: 0.47, ads_bazooka: 0.43, ads_bazooka_down: 0.43, slide: 0.48, dive_5: 0.45,
  crouch_idle: CROUCH.br, crouch_aim: CROUCH.br,
  ...Object.fromEntries([25, 50, 75].flatMap((q) => [[`crouch_idle_${q}`, CROUCH.br + (0.4 - CROUCH.br) * q / 100], [`crouch_aim_${q}`, CROUCH.br + (0.4 - CROUCH.br) * q / 100]])) };
const cal = (k) => ({ hr: HEAD_R, br: BODY_R[k] ?? 0.4, legacy: null, ...CAL[k] });

// ---------- FPS: postura e inclinación ----------
// Estados que el jugador FPS emite (contrato §1). Los de cobertura, blindfire,
// dive y flip quedan solo para bots hasta su etapa.
export const FPS_LEAN_STATES = new Set(['idle', 'run', 'jump', 'crouch']);
// Desplazamiento lateral máximo de la cabeza con cl = ±1.
export const LEAN_MAX = 0.24;
// Inclinación: desplazamiento de cabeza (h) y hombros (b) medido en el rig
// para cl = ±1 (tabla lean_*: de pie / agachado, con y sin ADS; el rig no es
// simétrico en ADS), escalado por |cl| (el rig lo dibuja casi lineal: cl 0.5
// ADS medido 0.23 de lado frente a 0.22 lineal). Las piernas (a) no se mueven.
// En `crouch` con altura `ce` se mezcla el de agachado con el de pie. Sin
// tabla: giro analítico del tronco que aparta la cabeza LEAN_MAX.
function leanDelta(kind, cl) {
  const d = CAL[`${kind}_${cl > 0 ? 'r' : 'l'}`];
  return d ? { h: d.h.map((x) => x * Math.abs(cl)), b: d.b.map((x) => x * Math.abs(cl)) } : null;
}
function leanVol(v, cl, aim = false, ce = 1) {
  if (!cl) return v;
  const up = leanDelta(aim ? 'lean_stand_aim' : 'lean_stand', cl);
  const low = ce < 1 ? leanDelta(aim ? 'lean_crouch_aim' : 'lean_crouch', cl) : up;
  if (up && low) {
    const d = { h: mix3(low.h, up.h, clamp01(ce)), b: mix3(low.b, up.b, clamp01(ce)) };
    const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
    return { h: add(v.h, d.h), hr: v.hr, a: v.a, b: add(v.b, d.b), br: v.br, legacy: null };
  }
  const piv = mix3(v.a, v.b, 0.4), dh = Math.max(0.3, v.h[2] - piv[2]);
  const ang = Math.asin(Math.min(1, LEAN_MAX / dh)) * cl;
  const c = Math.cos(ang), s = Math.sin(ang);
  // roll en el plano lado/altura: +cl = a la derecha (+s)
  const R = (p) => [p[0], piv[1] + (p[1] - piv[1]) * c + (p[2] - piv[2]) * s, piv[2] - (p[1] - piv[1]) * s + (p[2] - piv[2]) * c];
  return { h: R(v.h), hr: v.hr, a: v.a, b: R(v.b), br: v.br, legacy: null };
}
// Trote sin apuntar: el rig dibuja la cabeza de media 0.075 m adelante y
// 0.008 arriba a 4.8 m/s (medido por RIG, check-rig-net-pose: ±0.03 de
// balanceo alrededor de esa media); proporcional a la velocidad replicada
// (`sp` = velocidad / roadieSpeed), así no salta al arrancar o parar.
export const RUN_LEAN = Object.freeze([0.075, 0, 0.008]);
function runVol(pose) {
  const k = clamp01((Number(pose.sp) || 0) * TUNING.move.roadieSpeed / TUNING.fp.runSpeed);
  if (k <= 0.005) return STAND;
  const d = RUN_LEAN.map((x) => x * k), add = (p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  return { h: add(STAND.h), hr: HEAD_R, a: STAND.a, b: add(STAND.b), br: STAND.br, legacy: null };
}
// ADS de pie con el arma en mano (mirar abajo inclina la cabeza)
function adsVol(pose) {
  const k = CAL['ads_' + ADS_KEY[pose.wep]] ? 'ads_' + ADS_KEY[pose.wep] : 'ads_smg';
  return mix(cal(k), cal(k + '_down'), clamp01(-(Number(pose.pitch) || 0) / 0.55));
}

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
function rawHitPose(pose = {}) {
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
    case 'dodge': return cal('dodge');
    case 'slide': return cal('slide');
    case 'dive': return mix(STAND, cal('dive_5'), Math.sin(Math.PI * ph));
    case 'mantle': return mix(STAND, cal('mantle_4'), Math.sin(Math.PI * Math.min(1, ph / 0.8)));
    case 'flip': {
      const base = cal('flip_0'), piv = CAL.flip_pivot;
      const axis = pose.flipAxis === 'x' ? 'x' : 'z';
      const ang = (pose.flipDir === -1 ? -1 : 1) * ph * Math.PI * 2;
      return { ...base, h: rotFlip(base.h, piv, ang, axis), a: rotFlip(base.a, piv, ang, axis), b: rotFlip(base.b, piv, ang, axis) };
    }
    case 'crouch': {
      // FPS: `ce` = altura de la cabeza (0 agachado, 1 de pie). Sirve para el
      // asomo sobre LOW y para la transición agacharse↔levantarse (~0.2 s):
      // así la cabeza replicada nunca salta. Sin `ce`, agachado.
      const ce = Number.isFinite(pose.ce) ? clamp01(pose.ce) : 0;
      // tramos por los puntos medidos del rig (ce 0, .25, .5, .75, 1)
      const k = aim ? 'crouch_aim' : 'crouch_idle', high = aim ? adsVol(pose) : STAND;
      const pts = [cal(k), ...[25, 50, 75].map((q) => (CAL[`${k}_${q}`] ? cal(`${k}_${q}`) : null)), high];
      let v;
      if (pts.includes(null)) v = mix(pts[0], high, ce);
      else { const i = Math.min(3, Math.floor(ce * 4)); v = mix(pts[i], pts[i + 1], ce * 4 - i); }
      return leanVol(v, lean, aim, ce);
    }
    case 'idle': case 'run': case 'jump':
      // ADS en abierto: cada arma tiene su pose (perfilado, cabeza girada
      // hacia la culata); `wep` es el arma en mano (replicada como `w`).
      // `cl`: inclinación FPS (Q/E), también de pie. Corriendo sin apuntar el
      // rig adelanta la cabeza (RUN_LEAN, proporcional a la velocidad `sp`).
      return leanVol(aim ? adsVol(pose) : runVol(pose), lean, aim, 1);
    default: return STAND;
  }
}

// ---------- transición entre estados ----------
// `st` es discreto y sus volúmenes calibrados distan hasta 0.43 m
// (idle↔roadie 0.38, idle↔slide 0.33, slide↔roadie 0.69). Sin esto la cabeza
// replicada se teletransportaba en un cuadro y la cámara (atada a la esfera)
// daba un tirón. Cada cambio de estado mezcla, en POSE_BLEND s con curva
// suave, desde el volumen que había en el instante del cambio (que a su vez
// puede estar a medio mezclar: cadena). La duración es la del suavizado del
// rig (dos etapas, ~0.2 s al 90 %). Los tres consumidores lo calculan con
// datos que todos tienen:
//   - cámara/jugador local: instante real del cambio (net/client.js localPose)
//   - servidor y observadores: entrada = punto medio entre el último snapshot
//     del estado anterior y el primero del nuevo (transitionOf), igual que la
//     fase de dive/mantle/flip.
// pose.from: pose de la que se viene (con su propio from/since congelados en
// el instante del cambio); pose.fromTo: la pose NUEVA en ese instante;
// pose.since: s desde el cambio.
export const POSE_BLEND = 0.2;
// velocidad de pico de la mezcla: la de agacharse con la curva del rig (5.6 m/s)
export const BLEND_SPEED = 5.4;
export const POSE_BLEND_MAX = 0.35;
const blendTime = (A, B) => Math.min(POSE_BLEND_MAX, Math.max(POSE_BLEND,
  1.5 * Math.hypot(A.h[0] - B.h[0], A.h[1] - B.h[1], A.h[2] - B.h[2]) / BLEND_SPEED));
// El ojo usa tanto la cabeza apuntada como su posición nominal sin ADS.
export const poseBlendDuration = (from, to) => Math.max(
  blendTime(from.vol, rawHitPose(to)), blendTime(from.steady, rawHitPose({ ...to, aim: false })));
const smooth = (x) => x * x * (3 - 2 * x);
// Entre de pie/corriendo/saltando/agachado la continuidad ya la da `ce` (y el
// ADS no mueve el ojo): esos cambios no mezclan, así agacharse no deja la
// cabeza alzada más tiempo del que se dibuja. Los demás estados (sprint,
// slide, mantle, melee y los de bots) sí.
const CONTINUOUS = new Set(['idle', 'run', 'jump', 'crouch']);
export const poseKey = (s) => { const st = s?.st || 'idle'; return CONTINUOUS.has(st) ? 'upright' : st; };
// Mezcla por DESFASE (inercialización): en el cambio se mide el hueco entre
// lo que había (from) y lo que el estado nuevo daba en ese instante (fromTo);
// el hueco se extingue con la curva suave y el movimiento propio del estado
// nuevo (p. ej. la rampa de agachado) pasa tal cual, sin acelerarse.
export function hitPose(pose = {}) {
  const v = rawHitPose(pose);
  if (!pose.from || !(pose.since >= 0 && pose.since < POSE_BLEND_MAX)) return v;
  const A = pose.from.vol ?? hitPose(pose.from), B = pose.fromTo ? rawHitPose(pose.fromTo) : v;
  // huecos grandes (agachado → patada/sprint: 0.86 m) se alargan para no
  // pasar de BLEND_SPEED en el pico de la curva (1.5·hueco/duración)
  const dur = blendTime(A, B);
  if (pose.since >= dur) return v;
  const k = 1 - smooth(pose.since / dur);
  const off = (p, a, b) => [p[0] + (a[0] - b[0]) * k, p[1] + (a[1] - b[1]) * k, p[2] + (a[2] - b[2]) * k];
  return { h: off(v.h, A.h, B.h), hr: HEAD_R, a: off(v.a, A.a, B.a), b: off(v.b, A.b, B.b),
    br: v.br + (A.br - B.br) * k, legacy: null };
}
// la misma cadena sin apuntar (ojo nominal estable al cambiar el ADS)
const noAim = (p) => ({ ...p, aim: false,
  ...(p.from ? { from: p.from.vol ? { vol: p.from.steady ?? p.from.vol } : noAim(p.from) } : {}),
  ...(p.fromTo ? { fromTo: { ...p.fromTo, aim: false } } : {}) });
// Pose de la que se viene, CONGELADA como volumen evaluado (y el mismo sin
// apuntar, para el ojo): la cadena de mezclas nunca pasa de un eslabón.
export function freezePose(pose) {
  return { vol: hitPose(pose), steady: hitPose(noAim(pose)), st: pose.st };
}

// ---------- ojo (FPS) ----------
// Clave del juego limpio: la cámara, el servidor y los bots sacan el ojo de
// aquí, y el ojo queda SIEMPRE a ≤ EYE_MAX del centro de la esfera de cabeza
// replicada (radio 0.22): quien puede ver/disparar tiene la cabeza expuesta.
// Ojo ALTO en la cabeza (decisión del lead, corrida 6): 0.08 POR ENCIMA del
// centro y 0.08 hacia donde mira la cámara (0.113 del centro): al asomar por
// un borde se ve antes de exponer media cabeza, y una cabeza expuesta casi
// siempre ve (antes 0.04 por debajo: tras un coche de 1.50–1.57 m la cabeza
// asomaba más de la mitad sin ver nada). De pie 1.60, agachado ≈ 0.77.
// Nominal: centro de cabeza de la MISMA postura sin apuntar (así el ADS, que
// gira la cabeza hacia la culata, no mueve la cámara de lado), recortado a la
// bola de radio EYE_MAX alrededor de la cabeza real.
export const EYE_FORWARD = 0.08, EYE_DROP = -0.08, EYE_MAX = 0.12; // EYE_DROP < 0: por encima del centro
// Recorta p (marco del personaje) a la bola de radio r alrededor de c.
function intoBall(p, c, r) {
  const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], l = Math.hypot(d[0], d[1], d[2]);
  return l <= r ? p : [c[0] + d[0] * r / l, c[1] + d[1] * r / l, c[2] + d[2] * r / l];
}
// pose: la de hitPose (+ `ae`, giro de cámara respecto al cuerpo, opcional).
export function eyeFromPose(pose = {}) {
  const vol = hitPose(pose), steady = pose.aim || pose.from ? hitPose(noAim(pose)) : vol;
  const ae = Number(pose.ae) || 0;
  // adelante de la cámara en el marco del cuerpo: (cos ae, −sin ae)
  const nominal = [steady.h[0] + EYE_FORWARD * Math.cos(ae), steady.h[1] - EYE_FORWARD * Math.sin(ae), steady.h[2] - EYE_DROP];
  const e = intoBall(nominal, vol.h, EYE_MAX);
  return { f: e[0], s: e[1], y: e[2] };
}
const toWorld = (p, x, y, z, yaw) => {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  return [x + fx * p[0] + rx * p[1], (y || 0) + p[2], z + fz * p[0] + rz * p[1]];
};
// Ojo en mundo (pies en x,y,z; yaw del cuerpo).
export function eyeWorld(pose, x, y, z, yaw = 0) {
  const e = eyeFromPose(pose);
  return toWorld([e.f, e.s, e.y], x, y, z, yaw);
}
// Para la cámara suavizada: lleva un punto de mundo a la bola EYE_MAX de la
// cabeza de esta pose (el suavizado nunca puede sacar el ojo de la cabeza).
export function clampToEye(pose, x, y, z, yaw, point) {
  const h = toWorld(hitPose(pose).h, x, y, z, yaw);
  return intoBall(point, h, EYE_MAX);
}

// Salida de proyectiles (cohete, humo, frag, aturdidora) de la pose: ojo +
// LAUNCH_OFFSET en el marco de la cámara (yaw + ae, pitch): la de
// fpCam.launchPoint (derecha 0.10, abajo 0.09, delante 0.50). La usan el
// cliente (lanzar) y el servidor (validar), sin acortar por la geometría.
export const LAUNCH_OFFSET = Object.freeze([0.10, -0.09, -0.50]);
export function launchWorld(pose, x, y, z, yaw = 0) {
  const eye = eyeWorld(pose, x, y, z, yaw);
  const cy = yaw + (Number(pose.ae) || 0), p = Number(pose.pitch) || 0, cp = Math.cos(p), sp = Math.sin(p);
  const fwd = [-Math.sin(cy) * cp, sp, -Math.cos(cy) * cp], right = [Math.cos(cy), 0, -Math.sin(cy)];
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  return { eye, launch: [0, 1, 2].map((i) => eye[i] + right[i] * LAUNCH_OFFSET[0] + up[i] * LAUNCH_OFFSET[1] - fwd[i] * LAUNCH_OFFSET[2]), fwd };
}

// Convergencia del cohete (cliente y servidor, ronda 2 R6): sale de la boca
// del viewmodel y apunta al punto del rayo central a `aimDist` (mínimo
// ROCKET_CONVERGE_MIN). El servidor admite como máximo el ángulo de esa
// convergencia a la distancia mínima.
export const ROCKET_CONVERGE_MIN = 2;
export function rocketAimDir(launch, eye, fwd, aimDist = Infinity) {
  const d = Math.max(ROCKET_CONVERGE_MIN, Number.isFinite(aimDist) ? aimDist : 1e3);
  const t = [eye[0] + fwd[0] * d - launch[0], eye[1] + fwd[1] * d - launch[1], eye[2] + fwd[2] * d - launch[2]];
  const l = Math.hypot(t[0], t[1], t[2]) || 1;
  return [t[0] / l, t[1] / l, t[2] / l];
}
export function rocketConvergeMaxDeg(launch, eye, fwd) {
  const d = rocketAimDir(launch, eye, fwd, ROCKET_CONVERGE_MIN);
  return Math.acos(Math.max(-1, Math.min(1, d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]))) * 180 / Math.PI;
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
    cl: L(s1.cl, s2.cl), p: L(s1.p, s2.p), sp: L(s1.sp, s2.sp),
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

// Entrada de hitPose de un snapshot (campos del cable) con la fase de su acción.
function snapInput(history, pose, t) {
  const base = { st: pose.st, aim: !!pose.aim, ce: pose.ce, cl: pose.cl, pitch: pose.p, wep: pose.w, sp: pose.sp };
  const act = pose.st === 'dive' || pose.st === 'mantle' || pose.st === 'flip' ? actionAt(history, pose, t) : {};
  return { ...base, ...act, phase: act.phase !== undefined ? clamp01(act.phase) : undefined };
}
// Transición en curso en t para el snapshot i del historial (servidor y
// observadores): { from, since } o null. Recursiva sobre cambios encadenados.
export function transitionOf(history, i, t) {
  // La mezcla anterior se congela como volumen (freezePose) UNA vez por
  // cambio y se guarda en el propio snapshot (`_trFrom`): la cadena es exacta
  // (sin truncar antecesores: ronda 2, R13) y cada cambio se evalúa una sola
  // vez aunque el historial se consulte muchas.
  if (!history?.length || i <= 0) return null;
  const key = poseKey(history[i]);
  let j = i;
  while (j > 0 && poseKey(history[j - 1]) === key) j--;
  if (j === 0) return null;
  const entry = (history[j - 1].at + history[j].at) / 2, since = t - entry;
  if (!(since < POSE_BLEND_MAX)) return null;
  const first = history[j];
  if (!first._trFrom) {
    const prev = { ...history[j - 1], i: j - 1 };
    first._trFrom = freezePose({ ...snapInput(history, prev, entry), ...(transitionOf(history, j - 1, entry) || {}) });
    first._trTo = snapInput(history, { ...first, i: j }, first.at);
  }
  return { from: first._trFrom, fromTo: first._trTo, since: Math.max(0, since) };
}
// Entrada de hitPose de la muestra i (con la fase de su acción en t).
export function sampleInput(history, i, t) { return snapInput(history, { ...history[i], i }, t); }
// Pose del DISPARO de un cliente FPS: la última muestra propia aceptada (la
// `fs` que viajó con el tiro) con su mezcla de estado. El cliente manda el
// estado del cuadro anterior y el del cuadro del cambio (net/client.js), así
// que `from`/`fromTo` son exactamente los suyos; `since` es el del cliente
// (`ts`), admitido a ±SHOT_SINCE_TOL del que mide el servidor por llegadas
// (jitter de transporte). Sin `ts`, el del servidor.
export const SHOT_SINCE_TOL = 0.06; // ±30 ms de jitter en cada extremo
// Ronda 2 (matriz honesta): con `ct` (reloj de simulación del cliente) en las
// muestras, la transición es la que definió el cliente con lo ENVIADO
// (net/client.js noteSentPose): entrada = `ct` de la primera muestra con la
// clave nueva, desde la anterior con su propia mezcla en su `ct`. El `since`
// de la muestra (ct − ct de entrada) se acota a ±SHOT_SINCE_TOL del medido por
// llegadas, así que un cliente no elige otra fase de la mezcla.
function ctFull(samples, i) {
  const s = samples[i];
  if (s._ctFull) return s._ctFull;
  const inp = sampleInput(samples, i, s.at);
  let j = i;
  while (j > 0 && poseKey(samples[j - 1]) === poseKey(s)) j--;
  let full = inp;
  if (j > 0 && Number.isFinite(s.ct) && Number.isFinite(samples[j].ct)) {
    const since = s.ct - samples[j].ct;
    if (since >= 0 && since < POSE_BLEND_MAX) {
      const first = samples[j];
      first._ctFrom ??= freezePose(ctFull(samples, j - 1));
      full = { ...inp, from: first._ctFrom, fromTo: sampleInput(samples, j, first.at), since };
    }
  }
  s._ctFull = full;
  return full;
}
// Reloj de la pose propia. Tras una pausa comprobada por el servidor, la
// simulación puede haber avanzado un solo cuadro. Descontar solo esa parte
// del silencio también conserva el principio de la mezcla al podar la cola.
export const POSE_PAUSE_GAP = 0.25;
export function recordOwnPose(history, sample) {
  const previous = history.at(-1);
  const received = sample.at;
  if (previous) {
    const gap = received - previous.received;
    const simulated = sample.ct - previous.ct;
    const elapsed = gap >= POSE_PAUSE_GAP && Number.isFinite(simulated) && simulated >= 0
      ? Math.min(gap, simulated) : gap;
    sample.at = previous.at + elapsed;
  }
  sample.received = received;
  history.push(sample);
  while (history.length > 2 && (history[0].at < sample.at - 0.5 || history.length > 256)) history.shift();
}
export function shotPose(samples, ts) {
  const n = samples.length - 1, cur = samples[n];
  if (Number.isFinite(cur.ct)) {
    const key = poseKey(cur);
    let j = n;
    while (j > 0 && poseKey(samples[j - 1]) === key) j--;
    const base = { ...sampleInput(samples, n, cur.at), ae: cur.ae || 0 };
    if (j === 0 || !Number.isFinite(samples[j].ct)) return base;
    const sinceArr = cur.at - samples[j].at;
    const since = Math.max(0, Math.max(sinceArr - SHOT_SINCE_TOL, Math.min(sinceArr + SHOT_SINCE_TOL, cur.ct - samples[j].ct)));
    if (since >= POSE_BLEND_MAX) return base;
    const first = samples[j];
    first._ctFrom ??= freezePose(ctFull(samples, j - 1));
    return { ...base, from: first._ctFrom, fromTo: sampleInput(samples, j, first.at), since };
  }
  const base = { ...sampleInput(samples, n, cur.at), ae: cur.ae || 0 };
  const key = poseKey(cur);
  let j = n;
  while (j > 0 && poseKey(samples[j - 1]) === key) j--;
  if (j === 0) return base;
  const sinceS = cur.at - samples[j].at;
  const since = Math.max(0, Number.isFinite(ts) ? Math.max(sinceS - SHOT_SINCE_TOL, Math.min(sinceS + SHOT_SINCE_TOL, ts)) : sinceS);
  if (since >= POSE_BLEND_MAX) return base;
  const entry = samples[j].at;
  const from = freezePose({ ...sampleInput(samples, j - 1, entry), ...(transitionOf(samples, j - 1, entry) || {}) });
  return { ...base, from, fromTo: sampleInput(samples, j, entry), since };
}
// UN volumen: la pose difundida en t (y su acción y transición) o la regla anterior.
export function shapeAt(history, t, legacy = false) {
  // Una muestra autorizada entre dos snapshots tiene volumen solo en SU
  // instante. No interpola posiciones ni mezcla la pose de los observadores.
  const exact = history?.find(s => s.vol && s.at === t);
  if (exact && !legacy) return {pose: exact, vol: exact.vol};
  if (history?.some(s => s.vol)) history = history.filter(s => !s.vol);
  const pose = poseAt(history, t);
  if (!pose) return null;
  if (legacy) return { pose, vol: legacyVolume(pose.st) };
  return { pose, vol: hitPose({ ...snapInput(history, pose, t), ...(transitionOf(history, pose.i, t) || {}) }) };
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
  // instantes: la rejilla alrededor del estimado y, además, el instante exacto
  // de cada muestra de disparo evaluada dentro de la ventana
  const times = [];
  for (let m = 0; m <= 2 * n; m++) {
    // orden 0, +1, −1, +2, −2…: el instante más cercano al estimado manda
    const k = m === 0 ? 0 : (m % 2 ? (m + 1) / 2 : -m / 2);
    times.push(Math.min(shotAt, c + k * step));
  }
  for (const h of seen) if (h.vol && Math.abs(h.at - c) <= CLAIM_JITTER) times.push(h.at);
  for (const t of times) {
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

// ---------- origen del disparo de un cliente FPS (servidor) ----------
// El tiro sale del OJO (DECISIONES §4): el servidor exige que el origen esté a
// ≤ FPS_ORIGIN_REACH del centro de cabeza de la pose PROPIA del tirador en el
// instante del disparo (la cabeza está a ≤ EYE_MAX del ojo; el resto cubre un
// cuadro de movimiento y el redondeo). El cliente manda un estado fresco justo
// antes de cada `fire` (net/client.js), así que basta con los estados propios
// recibidos en los últimos FPS_ORIGIN_LAG s; entre dos muestras la cabeza se
// interpola (tramo). Sin extrapolar: nunca un origen por delante de lo
// recibido (asomarse antes de mostrarse).
export const FPS_ORIGIN_REACH = 0.4;
// Tolerancia del origen ligado a SU muestra (ojo reconstruido con eyeWorld):
// solo cuantización. Origen a 1 mm (±0.0005 por eje → 0.0009), muestra a 1 mm
// en posición (0.0009), yaw 1e-4 rad × 0.34 m del ojo agachado (0.00003),
// ce/cl a 1e-3 × 1.0 m por unidad (0.0005 + 0.0002), ts a 1 ms × 6.3 m/s de
// mezcla (0.003), y los `from`/`fromTo` de los estados `s` a 0.01 en ce/cl
// (0.005 + 0.001): suma 0.011 → 0.02 con margen. El suavizado de cámara NO
// cabe: el origen del tiro es el ojo sin suavizar.
export const FPS_EYE_TOL = 0.02;
export const FPS_ORIGIN_LAG = 0.1;
// Centro de cabeza en mundo de una muestra (formato de poseSnapshot).
// history: si se da, la transición de estado en curso (como el rebobinado).
export function headWorld(sample, history = null, i = -1) {
  const tr = history && i >= 0 ? transitionOf(history, i, sample.at) : null;
  const vol = hitPose({ st: sample.st, aim: !!sample.aim, ce: sample.ce, cl: sample.cl, pitch: sample.p, wep: sample.w, sp: sample.sp, ...(tr || {}) });
  return toWorld(vol.h, sample.x || 0, sample.y || 0, sample.z || 0, sample.yaw || 0);
}
// samples: estados propios recibidos (reloj monótono), el último = el actual.
// Devuelve { dist, head } con el punto de la trayectoria de cabeza más cercano
// al origen, o null sin muestras.
export function originToHead(samples, o, shotAt) {
  if (!samples?.length) return null;
  const last = samples[samples.length - 1];
  const win = samples.filter((s) => s.at >= shotAt - FPS_ORIGIN_LAG && s.at <= shotAt);
  if (!win.includes(last) && last.at <= shotAt) win.push(last);
  if (!win.length) return null;
  const heads = win.map((s) => headWorld(s, samples, samples.indexOf(s)));
  let best = { dist: Infinity, head: heads[0] };
  for (let i = 0; i < heads.length; i++) {
    const a = heads[i], b = heads[Math.min(heads.length - 1, i + 1)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    const k = l2 > 1e-9 ? clamp01(((o[0] - a[0]) * u[0] + (o[1] - a[1]) * u[1] + (o[2] - a[2]) * u[2]) / l2) : 0;
    const c = [a[0] + u[0] * k, a[1] + u[1] * k, a[2] + u[2] * k];
    const d = Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]);
    if (d < best.dist) best = { dist: d, head: c };
  }
  return best;
}
