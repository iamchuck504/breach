// Integral de la velocidad lineal. Cada paso recorre la diferencia entre dos
// instantes de la curva, incluido el último paso fraccionario.
import { TUNING } from '../config/tuning.js';

export const DODGE_PREP = 0.05;

export function dodgeDistance(t) {
  const d = TUNING.dodge;
  t = Math.max(0, Math.min(d.duration, t));
  return t * (d.maxSpeed - (d.maxSpeed - d.endSpeed) * t / (2 * d.duration));
}

// Barrido común de jugador y bots. Comprobar suelo y techo a cada tramo
// evita saltarse una arista o entrar bajo un dintel a baja tasa de cuadros.
export function stepDodge(actor, dash, dt, radius) {
  if (dash.t === 0) { dash.ox = actor.pos.x; dash.oz = actor.pos.z; }
  const end = Math.min(TUNING.dodge.duration, dash.t + dt);
  const distance = dodgeDistance(end) - dodgeDistance(dash.t);
  dash.t = end;
  if (distance <= 0) return end >= TUNING.dodge.duration - 1e-9;
  const n = Math.ceil(distance / 0.12), pos = actor.pos;
  const dx = dash.x * distance / n, dz = dash.z * distance / n;
  for (let i = 0; i < n; i++) {
    const q = { x: pos.x + dx, z: pos.z + dz };
    actor.world.resolveCircle(q, radius, actor.y);
    const floor = actor.world.groundHeight(q, radius, actor.y);
    if (floor - actor.y > TUNING.move.maxStepUp || actor.y - floor > TUNING.move.groundStickDown ||
        (actor.world.ceilingHeight?.(q, radius, floor) ?? Infinity) < floor + TUNING.fp.standClear) break;
    pos.x = q.x; pos.z = q.z; actor.y = floor;
  }
  return end >= TUNING.dodge.duration - 1e-9;
}

// Una señal de arranque, tres marcas de la estela y la pisada de frenada.
// La marca vive en la propia maniobra; no hay temporizadores por soldado.
export function dodgeCues(dash, age, x, y, z, dx, dz, team, emit, done) {
  if (!emit) return;
  if (dash.cue == null) {
    emit('start', dash.ox ?? x, y, dash.oz ?? z, dx, dz, team);
    dash.cue = 0;
  }
  while (dash.cue < 3 && age >= 0.045 + 0.055 * dash.cue) {
    emit('trail', x, y, z, dx, dz, team);
    dash.cue++;
  }
  if (done && dash.cue !== 4) {
    emit('brake', x, y, z, dx, dz, team);
    dash.cue = 4;
  }
}
