// KICK de CRASHTERRA (weapons/tuning.ts y updateLeg de weapons/view.ts).
// El primer tope de la suela llega a windup + strike / 2.4. Anclar ese
// instante al contacto de Breach conserva ambas mitades de la curva incluso
// cuando confirmar el golpe acorta la recuperación o congela el gesto.
const WINDUP = 0.08, STRIKE = 0.12, RECOVER = 0.30;
const CONTACT = WINDUP + STRIKE / 2.4;
const LENGTH = WINDUP + STRIKE + RECOVER;

export function sampleKick(elapsed, end, hitAt, out) {
  if (elapsed == null || elapsed < 0 || elapsed >= end) {
    out.phase = 'idle';
    out.t = 0;
    return out;
  }
  const time = elapsed < hitAt
    ? CONTACT * elapsed / hitAt
    : CONTACT + (LENGTH - CONTACT) * (elapsed - hitAt) / (end - hitAt);
  if (time < WINDUP) {
    out.phase = 'windup'; out.t = time / WINDUP;
  } else if (time < WINDUP + STRIKE) {
    out.phase = 'strike'; out.t = (time - WINDUP) / STRIKE;
  } else {
    out.phase = 'recover'; out.t = (time - WINDUP - STRIKE) / RECOVER;
  }
  return out;
}
