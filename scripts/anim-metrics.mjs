// MÉTRICAS DE ANIMACIÓN del rig, sin navegador y deterministas. Sirven para
// comparar un antes y un después con números, no a ojo:
//  · DESLIZAMIENTO DE PIES: metros que recorre una suela sobre el suelo
//    mientras está apoyada, por cada metro que avanza el cuerpo. 0 = el pie
//    plantado no se mueve; 1 = patina tanto como avanza.
//  · SALTOS DE POSE: mayor desplazamiento de manos, cabeza y pies en un solo
//    cuadro (normalizado a 60 Hz) durante transiciones entre acciones.
//  · PARIDAD entre 30, 60 y 144 cuadros por segundo.
//   node scripts/anim-metrics.mjs [salida.json]
import fs from 'node:fs';
import * as T from 'three';
import { Rig } from '../src/player/rig.js';

const SOLE = new T.Vector3(0, -0.375, 0);
const makeRig = () => { const r = new Rig(new T.Scene(), 'red'); r.groundFn = () => 0; return r; };
const base = { state: 'idle', speed: 0, aim: false, aimPitch: 0, moveForward: 1, moveSide: 0 };

// ---------- deslizamiento de pies ----------
// vel(t) en m/s; fwd/side = componentes respecto al frente del cuerpo
function footSlide({ name, hz = 60, seconds = 3, speedAt, forward = 1, side = 0, state = 'run', aim = false }) {
  const rig = makeRig(), dt = 1 / hz;
  let x = 0, z = 0, travel = 0, slide = 0, planted = 0, minY = Infinity, maxLift = 0, crossed = 0, frames = 0;
  const trace = [];
  // el cuerpo mira a -z con yaw 0; la derecha es +x
  for (let i = 0; i < seconds * hz; i++) {
    const v = speedAt(i * dt);
    const len = Math.hypot(forward, side) || 1;
    const vx = v * side / len, vz = -v * forward / len;
    x += vx * dt; z += vz * dt; travel += v * dt;
    rig.setTransform(x, z, 0, 0);
    rig.update(dt, { ...base, state: v > 0.4 ? state : 'idle', speed: Math.min(1, v / 7.6), aim, moveForward: forward / len, moveSide: side / len, vx, vz });
    rig.root.updateMatrixWorld(true);
    const feet = [rig.legL, rig.legR].map((leg) => leg.knee.localToWorld(SOLE.clone()));
    if (i > hz * 0.5) { // tras el arranque
      frames++;
      feet.forEach((f) => { minY = Math.min(minY, f.y); maxLift = Math.max(maxLift, f.y); });
      trace.push(feet);
      // piernas cruzadas: el pie izquierdo a la derecha del derecho (en el eje lateral del cuerpo)
      if (feet[0].x - x > feet[1].x - x) crossed++;
    }
  }
  // Pie de APOYO: el más bajo de los dos, y a la altura a la que ese rig pisa
  // (su mínimo + 3 cm). Así la medida vale igual para un rig cuyas suelas
  // flotan a 2 cm que para uno que pisa a cero, y no cuenta la fase de vuelo.
  for (let i = 1; i < trace.length; i++) for (const k of [0, 1]) {
    const f = trace[i][k], p = trace[i - 1][k], other = trace[i][1 - k];
    if (f.y <= other.y + 1e-4 && f.y < minY + 0.03 && p.y < minY + 0.03) { slide += Math.hypot(f.x - p.x, f.z - p.z); planted++; }
  }
  const counted = travel * (seconds * hz - hz * 0.5) / (seconds * hz);
  return { name, hz, deslizamientoPorMetro: +(slide / Math.max(0.01, counted)).toFixed(3), apoyo: +(planted / (2 * frames) * 100).toFixed(0), sueloMin: +minY.toFixed(3), alzadaMax: +maxLift.toFixed(3),
    cuadrosCruzadas: +(crossed / frames * 100).toFixed(1) };
}

// ---------- saltos de pose ----------
// pasos: [params, cuadros] en secuencia. Mide el mayor salto por cuadro de
// manos, cabeza y pies respecto a la raíz.
function poseJump({ name, hz = 60, steps }) {
  const rig = makeRig(), dt = 1 / hz;
  const probes = () => {
    rig.root.updateMatrixWorld(true);
    const pt = (o, v = new T.Vector3()) => rig.root.worldToLocal(o.localToWorld(v.clone()));
    return { manoD: pt(rig.armR.hand), manoI: pt(rig.armL.hand), cabeza: pt(rig.head), pieD: pt(rig.legR.knee, SOLE), pieI: pt(rig.legL.knee, SOLE), arma: pt(rig.gunMount) };
  };
  for (let i = 0; i < hz; i++) rig.update(dt, { ...base, ...(typeof steps[0][0] === 'function' ? steps[0][0](0) : steps[0][0]) });
  let prev = probes();
  const max = { manoD: 0, manoI: 0, cabeza: 0, pieD: 0, pieI: 0, arma: 0 }, where = {};
  let frame = 0;
  for (const [params, seconds] of steps) {
    const n = Math.round(seconds * hz);
    for (let i = 0; i < n; i++, frame++) {
      const p = typeof params === 'function' ? params(i / n) : params;
      rig.update(dt, { ...base, ...p });
      const now = probes();
      for (const k of Object.keys(max)) {
        const d = now[k].distanceTo(prev[k]) * hz / 60;
        if (d > max[k]) { max[k] = d; where[k] = `${p.state ?? 'idle'}@${(frame / hz).toFixed(2)}s`; }
      }
      prev = now;
    }
  }
  const out = { name, hz };
  for (const k of Object.keys(max)) out[k] = +max[k].toFixed(3);
  out.peor = Object.entries(max).sort((a, b) => b[1] - a[1])[0][0];
  out.donde = where[out.peor];
  return out;
}

const run = { state: 'run', speed: 0.63 }, idle = { state: 'idle', speed: 0 };
const SLIDES = [
  { name: 'trote adelante 4.8', speedAt: () => 4.8 },
  { name: 'sprint 7.6', speedAt: () => 7.6, state: 'roadie' },
  { name: 'apuntando 2.16', speedAt: () => 2.16, aim: true },
  { name: 'caminar 2.4', speedAt: () => 2.4 },
  { name: 'lateral 4.8', speedAt: () => 4.8, forward: 0, side: 1 },
  { name: 'diagonal 4.8', speedAt: () => 4.8, forward: 1, side: 1 },
  { name: 'retroceso 4.8', speedAt: () => 4.8, forward: -1 },
  { name: 'frenado 4.8 → 0', speedAt: (t) => t < 1.2 ? 4.8 : 4.8 * Math.exp(-7.1 * (t - 1.2)), seconds: 2.4 },
  { name: 'arranque 0 → 4.8', speedAt: (t) => 4.8 * (1 - Math.exp(-9.6 * Math.max(0, t - 0.6))), seconds: 2.2 },
];
const JUMPS = [
  { name: 'reposo → trote → reposo', steps: [[idle, 0.4], [run, 0.8], [idle, 0.6]] },
  { name: 'trote → apuntar → trote', steps: [[run, 0.5], [{ ...run, aim: true, speed: 0.28 }, 0.6], [run, 0.5]] },
  { name: 'trote → sprint → trote', steps: [[run, 0.5], [{ state: 'roadie', speed: 1 }, 0.7], [run, 0.5]] },
  { name: 'salto y aterrizaje', steps: [[run, 0.4], [(k) => ({ state: 'jump', speed: 0.63, vy: 6.2 - 15 * k * 0.83, airborne: true }), 0.83], [run, 0.5]] },
  { name: 'superar obstáculo → trote', steps: [[run, 0.4], [(k) => ({ state: 'mantle', speed: 0.3, mantlePhase: k }), 0.42], [run, 0.5]] },
  { name: 'voltereta cortada → trote', steps: [[run, 0.3], [(k) => ({ state: 'flip', speed: 0.6, flipT: k * 0.6, flipDir: 1, flipAxis: 'x' }), 0.4], [run, 0.5]] },
  { name: 'esquiva → trote', steps: [[run, 0.3], [(k) => ({ state: 'dive', speed: 1, evadePhase: k }), 0.36], [run, 0.5]] },
  { name: 'deslizar → cobertura baja', steps: [[run, 0.3], [{ state: 'slide', speed: 1 }, 0.3], [{ state: 'cover_low', speed: 0 }, 0.6]] },
  { name: 'cobertura baja: apuntar y soltar', steps: [[{ state: 'cover_low' }, 0.4], [{ state: 'cover_low', aim: true, coverAimExposure: 1, coverKind: 'low' }, 0.5], [{ state: 'cover_low' }, 0.5]] },
  { name: 'cambio de arma', steps: [[run, 0.3], [{ ...run, swapping: true }, 0.55], [run, 0.4]] },
  { name: 'lanzar granada', steps: [[run, 0.3], [(k) => ({ ...run, throwT: 0.5 * (1 - k), throwTotal: 0.5, throwReleased: k > 0.56 }), 0.5], [run, 0.5]] },
  { name: 'recarga', steps: [[idle, 0.3], [(k) => ({ ...idle, reloading: true, reloadT: k }), 1.2], [idle, 0.4]] },
  { name: 'golpe cuerpo a cuerpo', steps: [[run, 0.3], [(k) => ({ state: 'melee', speed: 0.3, meleePhase: k }), 0.48], [run, 0.4]] },
];

const result = { deslizamiento: [], saltos: [], paridad: [] };
for (const s of SLIDES) result.deslizamiento.push(footSlide(s));
for (const j of JUMPS) result.saltos.push(poseJump(j));
// paridad: el mismo trote a 30 y 144 Hz
for (const hz of [30, 144]) result.paridad.push(footSlide({ name: 'trote adelante 4.8', hz, speedAt: () => 4.8 }));

const pad = (s, n) => String(s).padEnd(n);
console.log('DESLIZAMIENTO DE PIES (m de suela arrastrada por m recorrido)');
for (const r of [...result.deslizamiento, ...result.paridad]) console.log(' ', pad(r.name, 24), pad(r.hz + ' Hz', 7), pad(r.deslizamientoPorMetro, 7), 'apoyo', pad(r.apoyo + ' %', 6), 'suelo mín', pad(r.sueloMin, 7), 'alzada', pad(r.alzadaMax, 6), 'cruzadas', r.cuadrosCruzadas + ' %');
console.log('SALTOS DE POSE (m por cuadro a 60 Hz)');
for (const r of result.saltos) console.log(' ', pad(r.name, 34), 'mano D', pad(r.manoD, 6), 'mano I', pad(r.manoI, 6), 'cabeza', pad(r.cabeza, 6), 'pies', pad(Math.max(r.pieD, r.pieI), 6), 'peor:', r.peor, r.donde);
const out = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
// --check: contrato de la locomoción. Antes del rediseño el pie de apoyo
// patinaba entre 0,42 y 1,0 m por metro recorrido.
if (process.argv.includes('--check')) {
  const bad = [];
  for (const r of [...result.deslizamiento, ...result.paridad]) {
    if (r.deslizamientoPorMetro > 0.3) bad.push(`${r.name} (${r.hz} Hz): el pie de apoyo patina ${r.deslizamientoPorMetro} m por metro`);
    if (r.cuadrosCruzadas > 0) bad.push(`${r.name}: las piernas se cruzan`);
    if (r.sueloMin < -0.03) bad.push(`${r.name}: la suela se hunde ${r.sueloMin} m`);
  }
  for (const r of result.saltos) {
    const feet = Math.max(r.pieD, r.pieI);
    if (feet > 0.42) bad.push(`${r.name}: un pie salta ${feet} m en un cuadro`);
  }
  if (bad.length) { console.error('\n✗ MARCHA:\n - ' + bad.join('\n - ')); process.exit(1); }
  console.log('\n✓ MARCHA OK: pies de apoyo sin patinar, sin cruces y sin saltos de pie');
}
