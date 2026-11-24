import { TUNING } from '../config/tuning.js';
import { sprintFireDelay } from './fire-gates.js';

// Tiempo que debe sobrevivir un click semiautomático mientras el personaje
// recupera control/alineación. Centralizado para poder probar el contrato sin
// depender del loop/render del navegador.
// FPS: ya no hay giro de blindfire ni rodada; sí el retraso sprint→disparo
// del arma (el clic pulsado al soltar el sprint sale en cuanto se puede).
export function requiredFireBuffer(player, weaponState, reloadRemain = 0, swapRemain = 0) {
  const err = Math.abs(player.cameraYawError());
  const maxErr = TUNING.combat.fireAlignMaxDeg * Math.PI / 180;
  const turnDeg = player.fpYawLock > 0 ? player.fpYawLock : (TUNING.fp?.yawLockDeg ?? TUNING.combat.bodyTurnAimDeg);
  const alignWait = Math.max(0, err - maxErr) / (turnDeg * Math.PI / 180);

  let transitionWait = 0;
  if (player.state === 'mantle' && player.mantle) {
    transitionWait = Math.max(0, player.mantle.dur - player.mantle.t);
  } else if (player.state === 'dodge' && player.dodge) {
    transitionWait = TUNING.dodge.duration - player.dodge.t + sprintFireDelay(player.weaponKey);
  } else if (player.state === 'slide') {
    // mientras main.js no permita disparar deslizando, el clic espera al final
    transitionWait = player.slide ? Math.max(0, (TUNING.fp?.slideTime ?? 0.5) - player.slide.t) : 0.5;
  } else if (player.state === 'melee') {
    transitionWait = Math.max(0, (player.meleeEndT ?? 0) - (player.meleeT ?? 0));
  } else if (player.state === 'dive') {
    // heredado (bots/parches viejos): el jugador ya no rueda
    transitionWait = Math.max(0, TUNING.evade.diveTime - player.stateT);
  }
  // sprint: lo que falta del retraso del arma (en sprint, el retraso entero)
  let sprintWait = 0;
  if (typeof player.fireReadyIn === 'function') {
    const r = player.fireReadyIn();
    sprintWait = Number.isFinite(r) ? r : sprintFireDelay(player.weaponKey);
  }

  // Dos frames de margen incluso a 30 fps.
  return Math.max(0.3, weaponState.cd + 0.06, reloadRemain + 0.06,
    alignWait + 0.07, transitionWait + 0.07, swapRemain + 0.06, sprintWait + 0.07);
}
