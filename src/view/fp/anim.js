// ANIMACIÓN DEL ARMA EN PRIMERA PERSONA — módulo PURO (sin three, sin DOM):
// se prueba en Node (scripts/check-fps-anim.mjs).
//
// Capas, en este orden:
//  1. base: cadera ↔ ADS (la ADS se deriva de las miras, deriveAds) más las
//     posturas de sprint, agachado, trepar, deslizar y pared;
//  2. locomoción aditiva (paso, respiración, salto, inclinación, aturdido),
//     que se apaga al apuntar;
//  3. acción exclusiva con prioridad y cancelación (recarga, cambio, golpe,
//     lanzamiento): líneas de tiempo de datos del perfil que se funden
//     al entrar y salir — una acción nueva nunca corta en seco a otra;
//  4. el arma sigue al objetivo con un resorte crítico cuya rigidez depende
//     de la MASA del arma, con velocidad máxima (nada salta de un cuadro a otro);
//  5. resortes de segundo orden SUBAMORTIGUADOS (con rebote) para balanceo
//     de la vista, retroceso, aterrizaje y golpe recibido.
// Las piezas (cargador, palanca) cambian de estado SOLO por eventos
// (magOut/magIn/boltRelease), nunca por una curva; la munición no se toca.
import { LEFT_CHANNELS, CURL_CHANNELS } from './profiles.js';
import { sampleKick } from '../../combat/kick-phase.js';
import { TUNING } from '../../config/tuning.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (v) => { const x = clamp(v, 0, 1); return x * x * (3 - 2 * x); };

// ---------- rotaciones (Euler YXZ, como THREE.Euler(x, y, z, 'YXZ')) ----------
// R = Ry · Rx · Rz aplicada a v.
export function rotYXZ(rx, ry, rz, v, out = [0, 0, 0]) {
  const cz = Math.cos(rz), sz = Math.sin(rz), cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  let x = v[0] * cz - v[1] * sz, y = v[0] * sz + v[1] * cz, z = v[2];
  const y2 = y * cx - z * sx, z2 = y * sx + z * cx; y = y2; z = z2;
  const x2 = x * cy + z * sy, z3 = -x * sy + z * cy;
  out[0] = x2; out[1] = y; out[2] = z3;
  return out;
}

/**
 * Postura ADS (ancla grip en cámara + Euler YXZ) a partir de las miras: la
 * línea alza→guion queda EXACTAMENTE en el eje óptico (-z), con el alza a
 * `relief` m del ojo. El centro de la pantalla es el mismo para cualquier
 * FOV y relación de aspecto, así que la mira cae en él siempre.
 */
export function deriveAds(anchors, scale, relief, roll = 0) {
  const r = anchors.sight_rear, f = anchors.sight_front, g = anchors.grip;
  // dirección de la línea de mira, ya con el alabeo pedido (Rz va primero)
  const d0 = [f[0] - r[0], f[1] - r[1], f[2] - r[2]];
  const cz = Math.cos(roll), sz = Math.sin(roll);
  const d = [d0[0] * cz - d0[1] * sz, d0[0] * sz + d0[1] * cz, d0[2]];
  // cabeceo que anula y con z hacia delante, luego guiñada que anula x
  let b = Math.atan2(d[1], d[2]) - Math.PI;
  if (b <= -Math.PI) b += 2 * Math.PI;
  const rho = Math.hypot(d[1], d[2]);
  const a = Math.atan2(d[0], rho);
  const rg = rotYXZ(b, a, roll, [(r[0] - g[0]) * scale, (r[1] - g[1]) * scale, (r[2] - g[2]) * scale]);
  return [-rg[0], -rg[1], -relief - rg[2], b, a, roll];
}

// ---------- pistas (Catmull-Rom, tangente nula en los extremos) ----------
export function evalTrack(track, u, out) {
  if (typeof track === 'function') return track(u, out);
  const n = track.length, m = track[0].length - 1;
  if (u <= track[0][0]) { for (let i = 0; i < m; i++) out[i] = track[0][i + 1]; return out; }
  if (u >= track[n - 1][0]) { for (let i = 0; i < m; i++) out[i] = track[n - 1][i + 1]; return out; }
  let k = 0;
  while (k < n - 2 && u > track[k + 1][0]) k++;
  const a = track[k], b = track[k + 1], t0 = a[0], t1 = b[0], h = t1 - t0;
  const s = (u - t0) / h, s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const pa = track[k - 1], pb = track[k + 2];
  for (let i = 0; i < m; i++) {
    const i1 = i + 1;
    const ma = pa ? (b[i1] - pa[i1]) / (t1 - pa[0]) * h : 0;
    const mb = pb ? (pb[i1] - a[i1]) / (pb[0] - t0) * h : 0;
    out[i] = h00 * a[i1] + h10 * ma + h01 * b[i1] + h11 * mb;
  }
  return out;
}

// ---------- pasos de recarga a partir del progreso (respaldo sin emisor) ----------
/**
 * Pasos cruzados al pasar el progreso de `from` a `to` (0..1). Cada paso
 * una sola vez aunque se salten cuadros; `to` < `from` no devuelve nada.
 */
export function stepsCrossed(steps, from, to, out = []) {
  out.length = 0;
  for (const s of steps) if (s.t > from && s.t <= to) out.push(s.step);
  return out;
}

// ---------- resortes ----------
const H = 1 / 240; // subpaso máximo: estable con cualquier dt de cuadro
function springs(x, v, target, n, w, z, dt, vmax = Infinity) {
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(H, left); left -= h;
    for (let i = 0; i < n; i++) {
      const tgt = target ? target[i] : 0;
      v[i] += (w * w * (tgt - x[i]) - 2 * z * w * v[i]) * h;
      if (v[i] > vmax) v[i] = vmax; else if (v[i] < -vmax) v[i] = -vmax;
      x[i] += v[i] * h;
    }
  }
}
// escalar (suavizado de entradas): A[k] sigue a target; su velocidad vive
// en A.vel[k]. z = amortiguamiento (1 = crítico).
function follow(A, k, target, w, dt, z = 1) {
  let x = A[k], v = A.vel[k] ?? 0, left = dt;
  while (left > 1e-9) {
    const h = Math.min(H, left); left -= h;
    v += (w * w * (target - x) - 2 * z * w * v) * h;
    x += v * h;
  }
  A[k] = x; A.vel[k] = v;
}

// ---------- acciones ----------
const PRIORITY = { swap: 4, melee: 3, throw: 3, reload: 2, cycle: 1 };
const BLOCK_ADS = { swap: 1, melee: 1, throw: 0.7, reload: 0.85, cycle: 0 };
const FADE_IN = 0.09, FADE_OUT = 0.18;
// gobernador de la salida: 1.15 m/s a 22 cm de la empuñadura (< 2 cm por cuadro a 60 Hz)
const GOV_V = 1.15, GOV_R = 0.22;

// view.ts: desplazamiento del arma y retroceso de contacto de las tres familias.
const KICK_DIP = [0.07, -0.1, 0.04, -0.2, -0.18, -0.45];
const KICK_IMPULSE = [0.08, -0.3, 0.25, -1.2, 0.4, 1.4];
const springState = () => ({ x: 0, v: 0 });
function kickSpring(s, k, d, dt) {
  const steps = Math.min(8, Math.max(1, Math.ceil(dt * 120))), h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (-k * s.x - d * s.v) * h;
    s.x += s.v * h;
  }
}

export function cancelKick(A) {
  const a = current(A, 'melee');
  if (a) a.out = true;
  const k = A.kick;
  k.phase = 'idle'; k.t = k.envelope = 0;
  k.leg.x = k.leg.v = k.pos.x = k.pos.v = k.rot.x = k.rot.v = 0;
}

export function createAnim(profile, ads) {
  const A = {
    p: profile, ads: ads.slice(), t: 0,
    aim: 0, sprint: 0, crouch: 0, lean: 0, slide: 0, mantle: 0, wall: 0, air: 0, daze: 0,
    bob: 0, bobK: 0, vel: { aim: 0, sprint: 0, crouch: 0, lean: 0, slide: 0, mantle: 0, wall: 0, air: 0, daze: 0, bobK: 0, trig: 0 },
    pose: new Float64Array(6), poseV: new Float64Array(6), poseInit: false,
    sway: new Float64Array(6), swayV: new Float64Array(6),
    rec: new Float64Array(6), recV: new Float64Array(6),
    hit: new Float64Array(6), hitV: new Float64Array(6),
    acts: [], fireN: 0, trig: 0, dryT: 0,
    kick: { phase: 'idle', t: 0, envelope: 0, leg: springState(), pos: springState(), rot: springState() },
    mag: 0,       // 0 = en el arma, 1 = en la mano izquierda (lo cambian magOut/magIn)
    magV: 0, magTarget: 0,
    // ciclo tras el disparo (bombeo) pendiente: segundos que faltan (-1 = nada)
    cycWait: -1, evq: [], govPose: new Float64Array(6),
    // pistas por pieza (parts.anim) y visibilidad del arma en mano (pista show)
    partVals: {},
    // corredera (pistola): capa de pieza fuera de la pila de acciones
    slideT: -1, slideLock: false, magHide: false,
    target: new Float64Array(6), tmp: new Float64Array(8),
    out: {
      gun: new Float64Array(6), left: new Float64Array(LEFT_CHANNELS.length), lOff: new Float64Array(3),
      lCurl: new Float64Array(CURL_CHANNELS.length), bolt: 0, mag: 0, nade: 0, trigger: 0,
      pasoMuneca: new Float64Array(3), lLag: new Float64Array(3), events: [], aim: 0, adsBlock: 0, action: null, magHide: false, show: 1, parts: null,
    },
  };
  return A;
}

export function setProfile(A, profile, ads) {
  cancelKick(A);
  A.p = profile; A.ads = ads.slice(); A.outInit = false; A.poseInit = false;
  A.acts.length = 0; A.mag = 0; A.magTarget = 0; A.magV = 0;
  A.cycWait = -1; A.slideT = -1; A.slideLock = false; A.magHide = false;
}

function startAction(A, name, def, dur, opts = {}) {
  const pr = PRIORITY[name] ?? 1;
  // un gesto, un inicio: el mismo id (o el mismo gesto pedido otra vez en
  // < 50 ms, p. ej. el emisor y un respaldo en el mismo cuadro) no reinicia
  for (const a of A.acts) {
    if (a.out || a.name !== name) continue;
    if ((opts.id != null && a.id === opts.id) || A.t - a.t0 < 0.05) { A.dupStarts = (A.dupStarts ?? 0) + 1; return a; }
  }
  for (const a of A.acts) {
    // una acción de más prioridad en curso no se interrumpe por otra menor
    if (!a.out && (PRIORITY[a.name] ?? 1) > pr && a.u < a.end) return null;
  }
  for (const a of A.acts) a.out = true;
  const act = { name, def, u: opts.u0 ?? 0, dur: Math.max(0.05, dur), w: 0, out: false, end: opts.end ?? 1,
    sync: null, remap: opts.remap ?? null, ev: 0, t0: A.t, id: opts.id ?? null,
    // recarga por cartucho: fase 'loop' (u = progreso del cartucho) → 'outro' (bombeo final)
    shell: !!def.perShell, phase: 'loop', ou: 0 };
  if (name === 'reload' && A.p.encuadreRecarga) {
    const reposo = [...A.p.hip.pos, ...A.p.hip.rot];
    act.postura = Float64Array.from(reposo);
    act.velocidad = new Float64Array(6);
    act.encuadrada = Float64Array.from(reposo);
  }
  A.acts.push(act);
  // nunca más de 3 a la vez: la más vieja ya está casi fundida
  while (A.acts.length > 3) A.acts.shift();
  return act;
}
const current = (A, name) => { for (let i = A.acts.length - 1; i >= 0; i--) { const a = A.acts[i]; if (!a.out && (!name || a.name === name)) return a; } return null; };

/**
 * Eventos del arma (CONTRATO §4) más 'land' {speed}, 'hurt' {dir}, 'draw'.
 * Se aplican de inmediato (una vez cada uno).
 */
export function animEvent(A, name, d = {}) {
  const p = A.p;
  switch (name) {
    case 'fire': {
      A.fireN++;
      // munición a la vista que se va con el disparo (ojiva de la bazuca)
      if (p.parts?.magEvents?.hideOn === 'fire') A.magHide = true;
      // bombeo/ciclo visual tras el tiro (no hay evento de la lógica)
      if (p.cycle) {
        A.cycWait = p.cycle.delay ?? 0;
        const c = current(A, 'cycle'); if (c) c.out = true;
        // tiro durante el bombeo final de la recarga: manda el bombeo del tiro
        const r = current(A, 'reload'); if (r?.shell && r.phase === 'outro') r.out = true;
      }
      // corredera: atrás y adelante; en vacío se queda atrás
      if (p.slideKick) { A.slideFrom = A.slideT >= 0 ? (A.slideNow ?? 0) : 0; A.slideT = 0; A.slideLock = !!(p.slideKick.lockEmpty && d.empty); }
      const m = Math.sqrt(p.mass / 2.6);
      const w = 34 / m;
      const k = 1 - (1 - p.recoil.ads) * A.aim;
      // alternancia pseudoaleatoria determinista (sin Math.random)
      const h = Math.sin(A.fireN * 12.9898) * 43758.5453, r = (h - Math.floor(h)) * 2 - 1;
      A.recV[2] += p.recoil.kick * w * 1.7 * k;
      A.recV[1] += p.recoil.kick * w * 0.25 * k;
      A.recV[3] += p.recoil.rise * w * 1.5 * k;
      A.recV[4] += p.recoil.yaw * w * r * k;
      A.recV[5] += p.recoil.roll * w * (r * 0.6 + 0.4) * k;
      A.vel.trig += 30;
      // La celda de la aturdidora se presenta durante el intervalo entre tiros.
      if (d.recambio > 0) {
        const celda = startAction(A, 'reload', p.reload, d.recambio, { end: 1 + p.reload.tail });
        if (celda) celda.recambio = true;
      }
      break;
    }
    case 'dry': A.vel.trig += 18; A.dryT = 0.12; break;
    case 'reloadStart': {
      A.cycWait = -1; A.magHide = false;
      // munición nueva en la mano izquierda desde el principio (magEvents.out)
      if (p.parts?.magEvents?.out === 'reloadStart') { A.mag = 1; A.magTarget = 1; }
      // vacía (corredera bloqueada) o táctica
      const def = A.slideLock && p.reloadEmpty ? p.reloadEmpty : p.reload;
      const act = startAction(A, 'reload', def, d.total ?? 1.9, { id: d.id, end: def.perShell ? Infinity : 1 + (def.tail ?? 0.12) });
      if (act) act.sync = 'reload';
      break;
    }
    case 'reloadStep': {
      // a la cola: stepAnim los publica en out.events (se vacía al empezar el paso)
      if (A.evq.length < 8) A.evq.push(d.name);
      if (d.name === 'magOut') {
        if (!p.parts?.magGuide?.extraccion) A.mag = 1;
        A.magTarget = 1; A.magV = 0;
      }
      else if (d.name === 'magIn') { A.magTarget = 0; }
      else if (d.name === 'slideRelease') A.slideLock = false;
      else if (p.parts?.magEvents?.in === d.name) A.magTarget = 0;
      else if (d.name === 'pump') { const a = current(A, 'reload'); if (a?.shell) a.phase = 'outro'; }
      else if (d.name === 'shellIn') { const a = current(A, 'reload'); if (a?.shell) a.shellN = (a.shellN ?? 0) + 1; }
      break;
    }
    case 'reloadEnd': {
      const a = current(A, 'reload');
      if (a) { a.sync = null; if (a.shell) a.phase = 'outro'; } // la cola sigue con su reloj
      A.magTarget = 0;
      break;
    }
    case 'reloadCancel': {
      const a = current(A, 'reload');
      if (a) {
        a.out = true;
        // el cartucho que llevaba la mano no entra: se esconde (la munición no cambió)
        if (a.shell && a.lastMag > 0.01) A.magHide = true;
      }
      A.magTarget = 0; // el cargador vuelve a su sitio (la munición no cambió)
      break;
    }
    case 'swapStart': {
      cancelKick(A);
      A.cycWait = -1;
      const act = startAction(A, 'swap', p.swap, d.total ?? 0.55, { id: d.id, u0: d.draw ? 0.5 : 0 });
      if (act) act.sync = 'swap';
      break;
    }
    case 'draw': startAction(A, 'swap', p.swap, d.total ?? 0.55, { u0: 0.5 }); break;
    case 'swapMid': case 'swapEnd': break;
    case 'meleeStart': {
      A.cycWait = -1;
      // La aparición puede estar terminando de sacar el arma cuando el
      // controlador ya acepta una patada. El inicio real tiene prioridad.
      const swap = current(A, 'swap');
      if (swap && d.authoritative) swap.out = true;
      const total = d.total ?? TUNING.melee.time;
      const a = startAction(A, 'melee', p.melee, total, { id: d.id });
      if (a && a.hitAt == null) a.hitAt = clamp(d.hitAt ?? TUNING.melee.hitAt / total, 0.01, 0.99) * total;
      break;
    }
    case 'meleeHit': {
      const a = current(A, 'melee');
      if (!a || a.contacted) break;
      a.contacted = true;
      if (Number.isFinite(d.elapsed)) a.hitAt = d.elapsed;
      if (Number.isFinite(d.total)) a.dur = d.total;
      a.u = a.hitAt / a.dur;
      // En CRASHTERRA solo un blanco incrementa kickHitCount.
      if (d.connected) {
        const k = A.mShake ?? 1;
        A.kick.leg.v += 1.4 * k;
        a.impactFrame = true;
        A.kick.pos.v += k; A.kick.rot.v += k;
      }
      break;
    }
    case 'throwStart': {
      A.cycWait = -1;
      const rel = clamp(d.release ?? 0.6, 0.05, 0.95);
      startAction(A, 'throw', p.throw, d.total ?? 0.8, { id: d.id, remap: [rel, p.throw.releaseAt] });
      A.released = false;
      break;
    }
    // la suelta REAL: el objeto deja la mano en el mismo cuadro en que la
    // lógica crea el proyectil (las pistas `show`/`nade` del lanzamiento
    // solo marcan el gesto; el instante lo decide este suceso)
    case 'throwRelease': A.released = true; break;
    case 'land': {
      const s = clamp((d.speed ?? 4) / 9, 0, 1.2) * (A.mBob ?? 1);
      A.hitV[1] -= 0.5 * s; A.hitV[3] -= 1.4 * s; A.hitV[2] += 0.2 * s;
      break;
    }
    case 'hurt': {
      const dir = d.dir ?? 0, k = clamp(d.amount ?? 1, 0.3, 1.5) * (A.mShake ?? 1);
      A.hitV[5] += Math.sin(dir) * 2.4 * k; A.hitV[3] -= 1.2 * k; A.hitV[0] += -Math.sin(dir) * 0.25 * k; A.hitV[2] += 0.25 * k;
      break;
    }
    default: break;
  }
}

// u lineal → u de la pista con un punto de anclaje (golpe/suelta) recolocado
const remapU = (u, r) => {
  if (!r) return u;
  const [real, track] = r;
  return u < real ? (u / real) * track : track + ((u - real) / (1 - real)) * (1 - track);
};

const G = new Float64Array(6), L = new Float64Array(LEFT_CHANNELS.length), O3 = new Float64Array(3), C = new Float64Array(CURL_CHANNELS.length), ONE = new Float64Array(1);
const BASE = new Float64Array(6), objetivoRecarga = new Float64Array(6);

/**
 * Un paso. s = estado del CONTRATO §5:
 * { aim01, speed, sprint, crouch01, lean, airborne, landed, hurtDir, reloadT,
 *   swapping, throwT, meleeT, dazed, wallNear } + opcionales { slide, mantle,
 *   yawRate, pitchRate, runSpeed, fireHeld }. Sin asignaciones por cuadro.
 */
export function stepAnim(A, dt, s) {
  const p = A.p, o = A.out;
  dt = clamp(dt, 0, 0.1);
  // PAUSA: sin tiempo no se mueve nada (antes el gobernador usaba un dt mínimo
  // de 1e-4 s por llamada y, en pausa, el arma seguía 0.1 mm por cuadro hacia su
  // objetivo: 1.56 cm durante un cambio). Los sucesos quedan en cola.
  o.events.length = 0;
  if (!(dt > 0)) return o;
  A.t += dt;
  for (let i = 0; i < A.evq.length; i++) o.events.push(A.evq[i]);
  A.evq.length = 0;
  const mass = Math.sqrt(p.mass / 2.6);
  if (s.dazed || s.dead || s.meleeElapsed === null) {
    if (current(A, 'melee')) cancelKick(A);
  }

  // --- acciones: avance, sincronía con la lógica y fundidos ---
  // ciclo pendiente tras el disparo (bombeo): arranca al cumplirse la espera
  if (A.cycWait >= 0) {
    A.cycWait -= dt;
    if (A.cycWait <= 0) { A.cycWait = -1; startAction(A, 'cycle', p.cycle, p.cycle.dur ?? 0.4); }
  }
  let block = 0;
  for (let i = A.acts.length - 1; i >= 0; i--) {
    const a = A.acts[i];
    const anterior = a.u;
    if (a.shell) {
      // por cartucho: la pista se repite con el progreso del cartucho en curso
      // (0→1 y vuelta a 0 en cada shellIn); el bombeo final lleva su reloj
      if (a.phase === 'loop') { if (Number.isFinite(s.reloadT) && s.reloadT > 0) a.u = Math.min(1, s.reloadT); }
      else { a.ou += dt / (a.def.perShell.outro.dur ?? 0.4); if (a.ou >= 1) a.out = true; }
    } else if (a.name === 'melee' && Number.isFinite(s.meleeElapsed)) {
      a.dur = s.meleeEnd || a.dur;
      a.u = s.meleeElapsed / a.dur;
    } else if (a.sync === 'reload' && Number.isFinite(s.reloadT) && s.reloadT > 0) a.u = Math.max(a.u, Math.min(1, s.reloadT));
    else if (a.sync === 'swap' && Number.isFinite(s.swapping) && s.swapping > 0) a.u = Math.max(a.u, s.swapping);
    else a.u += dt / a.dur;
    if (a.recambio && !a.out) for (const paso of a.def.steps) {
      if (anterior < paso.t && a.u >= paso.t) animEvent(A, 'reloadStep', { name: paso.step });
    }
    if (a.u >= a.end) a.out = true;
    a.w = clamp(a.w + (a.out ? -dt / FADE_OUT : dt / FADE_IN), 0, 1);
    if (a.out && a.w <= 0) { A.acts.splice(i, 1); continue; }
    block = Math.max(block, (a.def.block ?? BLOCK_ADS[a.name] ?? 0) * smooth(a.w));
  }
  o.adsBlock = block;
  o.action = A.acts.length ? A.acts[A.acts.length - 1].name : null;

  // --- entradas suavizadas ---
  const sprintIn = s.sprint ? 1 : 0;
  const aimT = clamp(s.aim01 ?? 0, 0, 1) * (1 - block) * (1 - sprintIn);
  follow(A, 'aim', aimT, 2.2 / Math.max(0.05, p.adsTime) * 2.1, dt);
  follow(A, 'sprint', sprintIn, 9, dt);
  follow(A, 'crouch', clamp(s.crouch01 ?? 0, 0, 1), 10, dt);
  follow(A, 'lean', clamp(s.lean ?? 0, -1, 1), 9, dt);
  follow(A, 'slide', s.slide ? 1 : 0, 11, dt);
  follow(A, 'mantle', s.mantle ? 1 : 0, 10, dt);
  follow(A, 'wall', clamp(s.wallNear ?? 0, 0, 1), s.wallNear > A.wall ? 16 : 7, dt);
  follow(A, 'air', s.airborne ? 1 : 0, 8, dt);
  follow(A, 'daze', s.dazed ? 1 : 0, 6, dt);
  const aim = clamp(A.aim, 0, 1);
  o.aim = aim;
  const still = 1 - aim;

  // --- 1. base ---
  const hip = p.hip, ads = A.ads;
  for (let i = 0; i < 3; i++) {
    BASE[i] = hip.pos[i] + (ads[i] - hip.pos[i]) * aim;
    BASE[i + 3] = hip.rot[i] + (ads[i + 3] - hip.rot[i]) * aim;
  }
  const melee = current(A, 'melee'), kick = A.kick;
  sampleKick(melee ? melee.u * melee.dur : null, melee?.dur, melee?.hitAt, kick);
  const kt = kick.phase === 'windup' ? 1 - (1 - kick.t) ** 3
    : kick.phase === 'strike' ? 1 : kick.phase === 'recover' ? 1 - smooth(kick.t) : 0;
  kick.envelope += (kt - kick.envelope) * (1 - Math.exp(-dt * 22));
  for (let i = 0; i < 6; i++) BASE[i] += KICK_DIP[i] * kick.envelope;
  // Se dibuja primero el tope de la bota. La velocidad del impacto ya
  // está cargada y empieza a desplazar el pie en el intervalo siguiente.
  if (melee?.impactFrame) melee.impactFrame = false;
  else kickSpring(kick.leg, 420, 18, dt);
  const pistol = p.model === 'pistol' || p.model === 'stun';
  const stiffness = pistol ? 760 : p.model === 'shotgun' ? 300 : 620;
  const dampingKick = p.model === 'shotgun' ? 24 : 36;
  kickSpring(kick.pos, stiffness, dampingKick, dt);
  kickSpring(kick.rot, stiffness * 0.8, dampingKick * 0.9, dt);
  const addPose = (pose, k) => { if (!pose || k < 1e-5) return; for (let i = 0; i < 3; i++) { BASE[i] += pose.pos[i] * k; BASE[i + 3] += pose.rot[i] * k; } };
  addPose(p.sprint, A.sprint);
  addPose(p.crouch, A.crouch * still);
  addPose(p.lower, A.mantle);
  addPose(p.slide, A.slide * still);
  addPose(p.wall, A.wall * still);
  // pared muy cerca (el ojo llega a 0.3 m de ella): además de la postura del
  // perfil, el arma se recoge contra el pecho y apunta al suelo — más cuanto
  // más larga (A.len = empuñadura→boca en m, lo pone el viewmodel)
  {
    const deep = A.wall * still, L = A.len ?? 0.4;
    // En ADS solo retrocede sobre el eje óptico, hasta librar la pared más próxima.
    BASE[2] += A.wall * aim * (A.adsRetreat ?? 0);
    BASE[2] += deep * (0.08 + 0.25 * L + Math.max(0, -hip.pos[2] - 0.42)); BASE[1] -= deep * 0.05;
    BASE[3] -= deep * Math.min(1.25, 0.5 + 1.1 * L); BASE[4] += deep * 0.25;
  }

  // --- 2. locomoción ---
  const run = s.runSpeed ?? 4.8;
  const sp = s.airborne ? 0 : Math.max(0, s.speed ?? 0);
  A.bob += dt * sp * (s.sprint ? 1.5 : 1.8) * 1.05;
  follow(A, 'bobK', clamp(sp / run, 0, 1.4), 7, dt);
  // ajustes de accesibilidad (settings: bob × motionScale, shake): balanceo,
  // respiración, inercia de la vista, salto/aterrizaje y sobresaltos. El
  // retroceso NO (es información de juego).
  const mBob = A.mBob = clamp(s.bob ?? 1, 0, 1), mShake = A.mShake = clamp(s.shake ?? 1, 0, 1);
  const bk = A.bobK * still * (1 + 0.7 * A.sprint) * mBob;
  const ph = A.bob;
  BASE[0] += Math.sin(ph) * 0.009 * bk;
  BASE[1] += (Math.cos(2 * ph) - 1) * 0.0055 * bk;
  BASE[5] += Math.sin(ph) * 0.022 * bk;
  BASE[4] += Math.sin(ph + 0.4) * 0.008 * bk;
  BASE[3] += (Math.cos(2 * ph + 0.5) - 1) * 0.006 * bk;
  if (s.dodge) {
    const { side, front, lag, dip } = s.dodge;
    BASE[0] -= 0.055 * side * lag;
    BASE[1] -= 0.035 * dip;
    BASE[2] += 0.045 * front * lag;
    BASE[3] -= 0.09 * dip;
    BASE[5] += 0.18 * side * lag;
  }
  const breath = (1 - aim) * (1 - A.bobK * 0.6) * mBob;
  BASE[1] += Math.sin(A.t * 1.35) * 0.0016 * breath;
  BASE[3] += Math.sin(A.t * 1.35 + 0.7) * 0.004 * breath;
  BASE[4] += Math.sin(A.t * 0.71) * 0.003 * breath;
  BASE[1] += 0.01 * A.air * (1 - 0.7 * aim) * mBob; BASE[3] += 0.035 * A.air * (1 - 0.7 * aim) * mBob;
  BASE[0] += 0.012 * A.lean * still; BASE[5] += 0.08 * A.lean * still;
  if (A.daze > 1e-3) {
    // el arma baja (información: estás aturdido); el bamboleo sigue el ajuste
    const wob = A.daze * mShake;
    BASE[5] += Math.sin(A.t * 6.5) * 0.06 * wob; BASE[3] += -0.1 * A.daze + Math.sin(A.t * 4.1) * 0.03 * wob;
    BASE[1] -= 0.035 * A.daze; BASE[4] += Math.sin(A.t * 3.3) * 0.03 * wob;
  }

  // La recarga conserva su encuadre aunque empiece apuntando o en movimiento.
  // El resorte de postura del jugador sigue corriendo para recuperar la mira al final.
  const carga = A.acts.findLast(a => a.postura);
  if (carga) for (let i = 0; i < 6; i++) objetivoRecarga[i] = i < 3 ? hip.pos[i] : hip.rot[i-3];

  // --- 3. acciones ---
  L.fill(0); C.fill(0); O3.fill(0); o.pasoMuneca.fill(0);
  let manoLanzamiento = 0, boltHand = 0, wsum = 0, rOpen = 0, bolt = 0, nade = 0, magOv = 0, hasMag = false, show = 1;
  const pa = p.parts?.anim;
  if (pa) for (const k in pa) A.partVals[k] = 0;
  for (const a of A.acts) {
    const w = smooth(a.w);
    if (w <= 0) continue;
    let u, tr, evs = a.def.events;
    if (a.shell) {
      const ps = a.def.perShell;
      const outro = a.phase === 'outro';
      // el primer cartucho sale de la corredera (más lejos): pista propia si la hay
      tr = outro ? ps.outro.tracks : (!a.shellN && ps.first ? ps.first.tracks : ps.loop.tracks);
      u = outro ? Math.min(1, a.ou) : a.u;
      evs = outro ? ps.outro.events : null;
      // postura de recarga (arma girada enseñando la ventana); el bombeo la devuelve
      let hk = 1;
      if (outro && tr.hold) { evalTrack(tr.hold, u, ONE); hk = ONE[0]; }
      if (ps.hold) for (let i = 0; i < 6; i++) {
        const v = (i < 3 ? ps.hold.pos[i] : ps.hold.rot[i-3]) * w * hk;
        BASE[i] += v;
        if (a === carga) objetivoRecarga[i] += v;
      }
      if (a.phase !== a.lastPhase) { a.ev = -1; a.lastPhase = a.phase; }
    } else {
      u = remapU(Math.min(a.u, a.end), a.remap);
      tr = a.def.tracks;
    }
    // sucesos de la pista (expulsión del cartucho…), una vez cada uno
    if (evs) { for (const e of evs) if (e.u > a.ev && e.u <= u) o.events.push(e.name); a.ev = u; }
    if (tr.mag) { evalTrack(tr.mag, u, ONE); a.lastMag = clamp(ONE[0], 0, 1); magOv += a.lastMag * w; hasMag = true; }
    if (tr.gun) {
      evalTrack(tr.gun, u, G);
      for (let i = 0; i < 6; i++) {
        BASE[i] += G[i] * w;
        if (a === carga) objetivoRecarga[i] += G[i] * w;
      }
    }
    if (a.name === 'throw') manoLanzamiento += w;
    if (tr.boltHand) {
      evalTrack(tr.boltHand, u, ONE);
      boltHand += clamp(ONE[0], 0, 1) * w;
    }
    if (tr.left) { evalTrack(tr.left, u, A.tmp); for (let i = 0; i < L.length; i++) L[i] += Math.max(0, A.tmp[i]) * w; }
    else L[0] += w;
    if (tr.lCurl) { evalTrack(tr.lCurl, u, A.tmp); for (let i = 0; i < C.length; i++) C[i] += Math.max(0, A.tmp[i]) * w; }
    else C[0] += w;
    if (tr.pasoMuneca) {
      evalTrack(tr.pasoMuneca, u, A.tmp);
      for (let i = 0; i < 3; i++) o.pasoMuneca[i] += A.tmp[i] * w;
    }
    if (tr.lOff) { evalTrack(tr.lOff, u, A.tmp); for (let i = 0; i < 3; i++) O3[i] += A.tmp[i] * w; }
    if (tr.bolt) { evalTrack(tr.bolt, u, ONE); bolt = Math.max(bolt, clamp(ONE[0], 0, 1) * w); }
    if (tr.show) {
      if (a.name === 'throw') {
        if (A.released) { show = Math.min(show, 1 - w); rOpen = Math.max(rOpen, w); }
      }
      else { evalTrack(tr.show, u, ONE); show = Math.min(show, 1 - (1 - clamp(ONE[0], 0, 1)) * w); }
    }
    if (pa) for (const [k, part] of Object.entries(pa)) {
      const track = tr[part.track];
      if (!track || (part.afterRelease && !A.released)) continue;
      evalTrack(track, u, ONE);
      A.partVals[k] = Math.max(A.partVals[k], ONE[0] * w);
    }
    if (tr.nade) { evalTrack(tr.nade, u, ONE); nade = Math.max(nade, (a.name === 'throw' && A.released ? 0 : ONE[0]) * w); }
    wsum += w;
  }
  const rest = Math.max(0, 1 - wsum);
  L[0] += rest; C[0] += rest;
  let ls = 0; for (let i = 0; i < L.length; i++) ls += L[i];
  for (let i = 0; i < L.length; i++) o.left[i] = L[i] / ls;
  let cs = 0; for (let i = 0; i < C.length; i++) cs += C[i];
  for (let i = 0; i < C.length; i++) o.lCurl[i] = C[i] / cs;
  const sc = 1 / Math.max(1, wsum);
  for (let i = 0; i < 3; i++) o.lOff[i] = O3[i] * sc;
  for (let i = 0; i < 3; i++) o.pasoMuneca[i] *= sc;
  o.manoLanzamiento = clamp(manoLanzamiento * sc, 0, 1);
  o.boltHand = clamp(boltHand * sc, 0, 1);
  // corredera (pistola): atrás en `back` s, adelante en `ret` s; bloqueada
  // atrás tras el último tiro hasta slideRelease (cae de golpe, como la real)
  let sl = 0;
  if (p.slideKick && A.slideT >= 0) {
    A.slideT += dt;
    // atrás desde donde esté (un tiro durante la vuelta no salta), tope
    // sujeto `hold` s, y vuelta; bloqueada atrás si el disparo vació el cargador
    const t = A.slideT, b = p.slideKick.back, h = p.slideKick.hold ?? 0, r = p.slideKick.ret, s0 = A.slideFrom ?? 0;
    sl = t < b ? s0 + (1 - s0) * (t / b) : A.slideLock || t < b + h ? 1 : Math.max(0, 1 - (t - b - h) / r);
    if (!A.slideLock && t >= b + h + r) A.slideT = -1;
    A.slideNow = sl;
  } else if (A.slideLock) sl = 1;
  else A.slideNow = 0;
  o.bolt = Math.max(bolt, sl); o.nade = nade > 0.5 ? 1 : 0;
  // El cohete de repuesto aparece en la mano al recogerlo de la cartuchera.
  const recogida = p.parts?.magEvents?.recogida;
  const recarga = recogida && current(A, 'reload');
  o.magHide = A.magHide || !!(recarga && recarga.u < recogida);
  o.rOpen = rOpen;
  o.show = show; o.parts = A.partVals;

  // --- 4. el arma sigue al objetivo (masa) ---
  if (!A.poseInit) { A.pose.set(BASE); A.poseV.fill(0); A.poseInit = true; }
  // view.ts sigue los seis canales con k=240 y d=25.
  const throwingPose = p.thrown && !melee && kick.envelope < 1e-4;
  const frequency = throwingPose ? 24 / mass : Math.sqrt(240);
  const damping = throwingPose ? 2 * frequency : 25;
  // posición ≤1.1 m/s, giro ≤7 rad/s: ningún salto aunque se encadenen cancelaciones
  springsSplit(A.pose, A.poseV, BASE, frequency, damping, dt);

  // --- 5. resortes con rebote ---
  // balanceo: el arma va por detrás del giro de la vista
  const yr = clamp(s.yawRate ?? 0, -12, 12), pr = clamp(s.pitchRate ?? 0, -12, 12);
  const swayK = (1 - 0.7 * aim) * mass * mBob;
  A.tmp[0] = clamp(yr * 0.0035, -0.022, 0.022) * swayK;
  A.tmp[1] = clamp(-pr * 0.003, -0.018, 0.018) * swayK;
  A.tmp[2] = 0;
  A.tmp[3] = clamp(-pr * 0.012, -0.05, 0.05) * swayK;
  A.tmp[4] = clamp(-yr * 0.018, -0.07, 0.07) * swayK;
  A.tmp[5] = clamp(yr * 0.012, -0.05, 0.05) * swayK;
  springs(A.sway, A.swayV, A.tmp, 6, 13 / mass, 0.55, dt);
  springs(A.rec, A.recV, null, 6, 30 / mass, 0.42, dt);
  springs(A.hit, A.hitV, null, 6, 13 / mass, 0.4, dt);
  // gobernador de velocidad: ningún punto a ≤ GOV_R de la empuñadura (las
  // dos manos) se mueve más rápido que GOV_V, sumadas todas las capas.
  // Las capas siguen su curso; la salida solo se pone al día un poco después.
  // El retroceso se suma DESPUÉS (es un impulso acotado por su resorte): el
  // golpe de un arma pesada no se recorta. `govV` por perfil (lanzamientos).
  const gp = A.govPose, lim = (p.govV ?? GOV_V) * dt;
  for (let i = 0; i < 6; i++) A.tmp[i] = A.pose[i] + A.sway[i] + A.hit[i];
  if (A.outInit) limitarPostura(gp, A.tmp, lim);
  else for (let i = 0; i < 6; i++) gp[i] = A.tmp[i];
  for (let i = 0; i < 6; i++) {
    o.gun[i] = gp[i] + A.rec[i] + KICK_IMPULSE[i] * (i < 3 ? kick.pos.x : kick.rot.x);
  }
  if (carga) {
    springsSplit(carga.postura, carga.velocidad, objetivoRecarga, frequency, damping, dt);
    limitarPostura(carga.encuadrada, carga.postura, lim);
    const salida = carga.shell ? carga.ou : (carga.u - 1) / (carga.def.tail || .12);
    const peso = (1 - smooth(salida)) * (carga.out ? smooth(carga.w) : 1);
    for (let i = 0; i < 6; i++) o.gun[i] += (carga.encuadrada[i] - gp[i]) * peso;
    o.aim *= 1 - peso;
    o.adsBlock = Math.max(o.adsBlock, peso);
    if (carga.def.encuadre) evalTrack(carga.def.encuadre, carga.u, O3);
    for (let i = 0; i < 3; i++) o.gun[i] += (p.encuadreRecarga[i] + (carga.def.encuadre ? O3[i] : 0)) * peso;
  }
  A.outInit = true;
  // retroceso: la culata va atrás (+z); el cabeceo sube la boca
  // (o.gun es la postura final del ancla grip)

  // mano izquierda con algo de retraso en el balanceo (asimetría), ≤4 mm
  o.lLag[0] = clamp(A.swayV[0] * 0.004 + Math.sin(ph + 0.9) * 0.0012 * bk, -0.004, 0.004);
  o.lLag[1] = clamp(A.swayV[1] * 0.004 + (Math.cos(2 * ph + 1.1) - 1) * 0.001 * bk, -0.004, 0.004);
  o.lLag[2] = 0;

  // gatillo y cargador
  const trigT = s.fireHeld ? 1 : A.dryT > 0 ? 1 : 0;
  A.dryT = Math.max(0, A.dryT - dt);
  follow(A, 'trig', trigT, 40, dt, 0.7);
  o.trigger = clamp(A.trig, 0, 1.1);
  if (A.magTarget === 1 && A.mag < 1 && p.parts?.magGuide?.extraccion) {
    A.mag = Math.min(1, A.mag + dt / p.parts.magGuide.extraccion);
  }
  if (A.magTarget === 0 && A.mag > 0) A.mag = Math.max(0, A.mag - dt / 0.07); // encaje corto
  // una pista `mag` (cartucho de la escopeta) manda sobre los eventos
  o.mag = hasMag ? clamp(magOv, 0, 1) : A.mag;
  return o;
}

// Una traslación y un giro comparten el mismo presupuesto de movimiento.
function limitarPostura(actual, objetivo, limite) {
  let dl = 0, dr = 0;
  for (let i = 0; i < 6; i++) {
    const d = objetivo[i] - actual[i];
    if (i < 3) dl += d*d; else dr += d*d;
  }
  const distancia = Math.sqrt(dl) + GOV_R * Math.sqrt(dr);
  const k = distancia > limite ? limite / distancia : 1;
  for (let i = 0; i < 6; i++) actual[i] += (objetivo[i] - actual[i]) * k;
}

// Resorte de la postura con límites de velocidad distintos para
// posición (m/s) y giro (rad/s).
function springsSplit(x, v, target, w, damping, dt) {
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(H, left); left -= h;
    for (let i = 0; i < 6; i++) {
      const vmax = i < 3 ? 1.1 : 5;
      v[i] += (w * w * (target[i] - x[i]) - damping * v[i]) * h;
      if (v[i] > vmax) v[i] = vmax; else if (v[i] < -vmax) v[i] = -vmax;
      x[i] += v[i] * h;
    }
  }
}
