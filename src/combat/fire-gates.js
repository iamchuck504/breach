// UNA tabla de qué acción de arma se puede hacer en qué estado replicado,
// más el retraso sprint→disparo por arma. Módulo puro (sin three ni DOM):
// lo importan el cliente (controller.js / fire-control.js) y el servidor
// (server/*.js vía '../src/combat/fire-gates.js'), así que ambos lados
// deciden lo mismo. DECISIONES §2: se dispara deslizando (con más
// dispersión), nunca en sprint ni trepando.
import { TUNING } from '../config/tuning.js';

// Clase de acción de un arma ('melee' es el golpe, no un arma en mano).
export function actionOf(weapon) {
  if (weapon === 'melee') return 'melee';
  if (weapon === 'stun') return 'stun';
  const d = TUNING.weapons[weapon];
  if (d?.thrown) return 'thrown';
  if (d?.projectile) return 'projectile';
  return 'hitscan';
}

const ALL = Object.freeze({ hitscan: true, projectile: true, thrown: true, stun: true });
const NONE = Object.freeze({ hitscan: false, projectile: false, thrown: false, stun: false });
// estado (`st` replicado) → acción → permitido. El golpe (melee) no está aquí:
// su mensaje llega con st 'melee' y lo valida su propia regla.
export const FIRE_GATES = Object.freeze({
  // jugador FPS
  idle: ALL, run: ALL, jump: ALL, crouch: ALL, slide: ALL,
  roadie: NONE, dodge: NONE, mantle: NONE, melee: NONE, dead: NONE,
  // heredados (bots y clientes viejos) hasta la etapa de bots: como hoy
  cover_low: ALL, cover_high: ALL,
  blind_over: ALL, blind_low_left: ALL, blind_low_right: ALL, blind_high_left: ALL, blind_high_right: ALL,
  flip: Object.freeze({ hitscan: true, projectile: true, thrown: false, stun: true }),
  dive: NONE,
});

export function canFireInState(state, weapon) {
  const row = FIRE_GATES[state];
  return !!row && !!row[actionOf(weapon)];
}

// Retraso tras SALIR del sprint antes de poder disparar (0.15–0.3 s).
export function sprintFireDelay(weapon) {
  return TUNING.weapons[weapon]?.sprintToFire ?? TUNING.fp?.sprintFireDefault ?? 0.2;
}

// Servidor: `lastRoadieAt` = instante del último estado replicado en
// `roadie`. El sprint real terminó DESPUÉS de ese snapshot, así que un
// cliente honesto dispara a ≥ lastRoadieAt + retraso; la tolerancia cubre el
// jitter entre la llegada del estado y la del disparo.
export const FIRE_GATE_NET_TOL = 0.1;
export function sprintFireOk(lastRoadieAt, now, weapon) {
  if (!Number.isFinite(lastRoadieAt)) return true;
  return now - lastRoadieAt >= sprintFireDelay(weapon) - FIRE_GATE_NET_TOL;
}

// ---------- entradas de movimiento rápido (slide y placaje) ----------
// Constantes con las que el servidor valida que una entrada a `slide` o un
// placaje viene de un sprint legal y respeta la recuperación. Derivadas de
// TUNING y del modelo de aceleración del controller (aproximación
// exponencial a la velocidad objetivo: k = accel / objetivo), así que nunca
// rechazan a un cliente honesto.
const timeToReach = (v0, vt, target, accel) => {
  if (vt <= v0) return 0;
  if (vt >= target) return Infinity;
  return Math.log((target - v0) / (target - vt)) / (accel / target);
};
function moveGates() {
  const F = TUNING.fp, M = TUNING.move, ml = TUNING.melee;
  const tackleSpeed = F.runSpeed * 1.15;
  return Object.freeze({
    dodge: Object.freeze({ ...TUNING.dodge, minCycle: TUNING.dodge.duration + TUNING.dodge.cooldown,
      entry: Object.freeze(['idle', 'run', 'roadie']) }),
    slide: Object.freeze({
      minEntrySpeed: F.slideMinSpeed,     // m/s al empezar (sale de sprint)
      maxSpeed: F.slideMaxSpeed,          // tope durante el gesto
      duration: F.slideTime,
      cooldown: F.slideCooldown,          // desde el FIN de un slide al inicio del siguiente
      minCycle: F.slideTime + F.slideCooldown, // inicio → inicio
      // sprint previo mínimo (corriendo a tope → velocidad de entrada)
      minPriorSprint: timeToReach(F.runSpeed, F.slideMinSpeed, F.sprintSpeed, M.accel),
      endState: ['crouch', 'run', 'idle', 'jump'],
    }),
    tackle: Object.freeze({
      minEntrySpeed: tackleSpeed,         // > esto al empezar el golpe = placaje
      topSpeed: Math.min(ml.tackleTopSpeed, F.tackleTopSpeed),
      maxTravel: ml.tackleMax,
      acquire: ml.tackleAcquire,
      minPriorSprint: timeToReach(F.runSpeed, tackleSpeed, F.sprintSpeed, M.accel),
      // golpe → golpe más corto (acierto): preparación + congelación + recuperación + guarda
      minCycle: ml.hitAt + ml.hitStop + Math.min(ml.hitRecovery, ml.killRecovery) + ml.inputGuard,
    }),
  });
}
export const MOVE_GATES = moveGates();
