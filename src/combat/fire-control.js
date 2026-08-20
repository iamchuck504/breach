import { TUNING } from '../config/tuning.js';

// Tiempo que debe sobrevivir un click semiautomático mientras el personaje
// recupera control/alineación. Centralizado para poder probar el contrato sin
// depender del loop/render del navegador.
export function requiredFireBuffer(player, weaponState, reloadRemain = 0) {
  const err = Math.abs(player.cameraYawError());
  const maxErr = TUNING.combat.fireAlignMaxDeg * Math.PI / 180;
  const turnDeg = player.state === 'cover' && !player.aim
    ? TUNING.combat.bodyTurnBlindDeg : TUNING.combat.bodyTurnAimDeg;
  const alignWait = Math.max(0, err - maxErr) / (turnDeg * Math.PI / 180);

  let transitionWait = 0;
  if (player.state === 'dive') {
    transitionWait = Math.max(0, TUNING.evade.diveTime - player.stateT);
  } else if (player.state === 'mantle' && player.mantle) {
    transitionWait = Math.max(0, player.mantle.dur - player.mantle.t);
  }

  // Dos frames de margen incluso a 30 fps.
  return Math.max(0.3, weaponState.cd + 0.06, reloadRemain + 0.06,
    alignWait + 0.07, transitionWait + 0.07);
}
