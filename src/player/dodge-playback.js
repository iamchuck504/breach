// El reloj de recepción fija el arranque una sola vez. dg mide tiempo
// simulado: dos paquetes entregados juntos conservan toda su separación.
import { TUNING } from '../config/tuning.js';
import { dodgeDistance, stepDodge, DODGE_PREP } from './dodge.js';

const duration = TUNING.dodge.duration;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function append(buf, s, rt) {
  buf.push({ ...s, rt, at: rt });
  if (buf.length > 40) buf.shift();
}
function boundary(buf, s, rt, x, y, z, dg, dash) {
  append(buf, { ...s, x, y, z, dg, dash, ev: undefined }, rt);
}

export function pushRemoteSample(buf, s, arrival) {
  const prev = buf.at(-1);
  let dash = prev?.dash;
  if (s.st === 'dodge' && Number.isFinite(s.dg)) {
    const age = clamp(s.dg, 0, duration);
    if (!dash) {
      const dx = s.x - (prev?.x ?? s.x), dz = s.z - (prev?.z ?? s.z);
      const angle = Number.isFinite(s.da) ? s.da : Math.atan2(dz, dx);
      const ox = s.ox ?? prev?.x ?? s.x - Math.cos(angle) * dodgeDistance(age);
      const oz = s.oz ?? prev?.z ?? s.z - Math.sin(angle) * dodgeDistance(age);
      const gap = prev ? Math.hypot(ox - prev.x, oz - prev.z) : 0;
      const before = s.ct - age - prev?.ct;
      const speed = (prev?.sp || 0) * TUNING.move.roadieSpeed;
      const lead = Math.max(gap / TUNING.fp.sprintSpeed, Number.isFinite(before)
        ? clamp(before, 0, 0.15) : Math.min(0.15, gap / (speed || TUNING.fp.runSpeed)));
      const start = Math.max(arrival - age, prev ? prev.rt + lead : -Infinity);
      dash = { start, ct: s.ct - age, dx: Math.cos(angle), dz: Math.sin(angle), ox, oz };
      const fromY = prev?.y ?? s.y ?? 0;
      const beforeK = gap / Math.max(1e-6, gap + Math.hypot(s.x - ox, s.z - oz));
      const oy = fromY + ((s.y ?? fromY) - fromY) * beforeK;
      if (prev) {
        boundary(buf, prev, start, ox, oy, oz);
        for (let i = buf.length - 1; i >= 0 && buf[i].rt >= start - DODGE_PREP; i--) buf[i].prepare = dash;
      }
      boundary(buf, s, start, ox, oy, oz, 0, dash);
    } else if (age <= prev.dg) {
      // El servidor puede difundir la misma muestra varias veces.
      if (s.ev?.length) append(buf, { ...s, dg: prev.dg, dash }, prev.rt);
      return;
    }
    append(buf, { ...s, dg: age, dash }, dash.start + age);
    return;
  }
  let rt = arrival;
  if (dash) {
    const age = Number.isFinite(s.ct - dash.ct) ? clamp(s.ct - dash.ct, prev.dg, duration + 0.25) : duration;
    const endAge = Math.min(duration, age);
    const dx = s.x - prev.x, dz = s.z - prev.z;
    const rest = dodgeDistance(endAge) - dodgeDistance(prev.dg);
    const k = Math.min(1, rest / (Math.hypot(dx, dz) || 1));
    const idealX = dash.ox + dash.dx * dodgeDistance(endAge);
    const idealZ = dash.oz + dash.dz * dodgeDistance(endAge);
    // Tras la salida ya puede estar corriendo en otro rumbo. Si el final
    // libre concuerda con ambos extremos, separar ese tramo de la frenada.
    const free = Math.hypot(idealX - prev.x, idealZ - prev.z) <= rest + 0.003 &&
      Math.hypot(idealX - s.x, idealZ - s.z) <= (age - endAge) * TUNING.fp.runSpeed + 0.002;
    const x = free ? idealX : prev.x + dx * k, z = free ? idealZ : prev.z + dz * k;
    const end = dash.start + endAge;
    const y = (prev.y ?? 0) + ((s.y ?? 0) - (prev.y ?? 0)) * k;
    dash.end = { x, y, z, dg: endAge };
    boundary(buf, prev, end, x, y, z, endAge, dash);
    boundary(buf, s, end, x, y, z);
    rt = end + Math.max(age - endAge, Math.hypot(s.x - x, s.z - z) / TUNING.fp.sprintSpeed);
  } else if (prev?.recover && Number.isFinite(s.ct - prev.ct)) {
    // Si el último tramo quedó por delante de la llegada, devolver la fase
    // sobrante poco a poco, incluso si el jugador ya ha vuelto a correr.
    const step = clamp(s.ct - prev.ct, 0, 0.15);
    rt = clamp(arrival, prev.rt + 0.94 * step, prev.rt + 1.06 * step);
  }
  append(buf, s, Math.max(rt, prev?.rt ?? rt));
  if (dash || (prev?.recover && (s.ct < prev.recover || Math.abs(rt - arrival) > 0.001))) {
    buf.at(-1).recover = dash ? s.ct + TUNING.net.interpDelay : prev.recover;
  }
}

// La fracción espacial sale de la integral desde el arranque. Los extremos
// aceptados recortan esa curva si el soldado roza una pared o una esquina.
export function dodgeFraction(a, b, t, linear) {
  if (!a.dash || a.dash !== b.dash) return linear;
  const d0 = dodgeDistance(a.dg), span = dodgeDistance(b.dg) - d0;
  return span > 1e-8 ? clamp((dodgeDistance(t - a.dash.start) - d0) / span, 0, 1) : linear;
}


// Si un tick repite la última muestra, seguir el impulso hasta el próximo
// paquete, con el mismo barrido contra muros, techos y desniveles del emisor.
export function advanceMissingDodge(actor, s, t) {
  const age = Math.min(duration, t - s.dash.start);
  if (age <= s.dg) return;
  if (actor.world) {
    const pred = { pos: { x: s.x, z: s.z }, y: s.y ?? 0, world: actor.world };
    stepDodge(pred, { t: s.dg, x: s.dash.dx, z: s.dash.dz }, age - s.dg, 0.38);
    actor.x = pred.pos.x; actor.z = pred.pos.z; actor.y = pred.y;
  } else {
    const distance = dodgeDistance(age) - dodgeDistance(s.dg);
    actor.x += s.dash.dx * distance; actor.z += s.dash.dz * distance;
  }
}
