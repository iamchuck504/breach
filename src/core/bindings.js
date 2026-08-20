// Bindings configurables de teclado y control, persistidos en localStorage.
import { t } from './i18n.js';
const KB_DEFAULT = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  sprint: 'ShiftLeft', evade: 'Space', jump: 'KeyF', reload: 'KeyR', swap: 'KeyQ',
  melee: 'KeyV',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4',
  score: 'Tab',
};
// Índices estándar de Gamepad API (layout Xbox)
// A=correr, X=cubrirse/evadir, B=melee, Y=saltar, RB=recargar (pedido de Chuck).
// El d-pad selecciona arma directo (fijo, ver PAD_DPAD_SLOTS), así que el pad
// ya no necesita botón de "cambiar arma".
const PAD_DEFAULT = { sprint: 0, evade: 2, melee: 1, jump: 3, reload: 5, aim: 6, fire: 7, score: 8, pause: 9 };

// D-pad → índice de SLOT (no id de arma: si una especial reemplazó la SMG,
// izquierda sigue seleccionando ese slot). Arriba=granada, abajo=pistola,
// izquierda=SMG, derecha=escopeta. Fijo por pedido de Chuck.
export const PAD_DPAD_SLOTS = { 12: 3, 13: 2, 14: 0, 15: 1 };

export const BINDS = { kb: { ...KB_DEFAULT }, pad: { ...PAD_DEFAULT } };

export const KB_LABELS = {
  forward: 'binding.forward', back: 'binding.back', left: 'binding.left', right: 'binding.right',
  sprint: 'binding.sprint', evade: 'binding.evade', jump: 'binding.jump',
  melee: 'binding.melee', reload: 'binding.reload', swap: 'binding.swap',
  slot1: 'binding.slot1', slot2: 'binding.slot2', slot3: 'binding.slot3', slot4: 'binding.slot4',
  score: 'binding.score',
};
export const PAD_LABELS = {
  sprint: 'binding.sprint', evade: 'binding.evade', jump: 'binding.jump',
  melee: 'binding.melee', aim: 'binding.aim', fire: 'binding.fire',
  reload: 'binding.reload', score: 'binding.score', pause: 'binding.pause',
};

export const PAD_BTN_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'VIEW', 'MENU', 'L3', 'R3', 'D-ARR', 'D-ABA', 'D-IZQ', 'D-DER',
];

export function padBtnName(i) { return PAD_BTN_NAMES[i] ?? t('key.button') + i; }

export function keyLabel(code) {
  if (!code) return '—';
  return code
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace('ShiftLeft', 'SHIFT ' + t('key.left')).replace('ShiftRight', 'SHIFT ' + t('key.right'))
    .replace('ControlLeft', 'CTRL ' + t('key.left')).replace('ControlRight', 'CTRL ' + t('key.right'))
    .replace('AltLeft', 'ALT ' + t('key.left')).replace('AltRight', 'ALT ' + t('key.right'))
    .replace('Space', t('key.space')).replace('Arrow', t('key.arrow') + ' ')
    .toUpperCase();
}

// v3: melee (B / V), salto en Y, selección directa de armas (1-4 / d-pad);
// los binds guardados con esquemas viejos se ignoran
export function loadBinds() {
  try {
    const kb = JSON.parse(localStorage.getItem('breach.binds.kb.v3') || 'null');
    const pad = JSON.parse(localStorage.getItem('breach.binds.pad.v3') || 'null');
    if (kb) for (const k in KB_DEFAULT) { if (typeof kb[k] === 'string') BINDS.kb[k] = kb[k]; }
    if (pad) for (const k in PAD_DEFAULT) { if (typeof pad[k] === 'number') BINDS.pad[k] = pad[k]; }
  } catch { /* defaults */ }
}

export function saveBinds() {
  localStorage.setItem('breach.binds.kb.v3', JSON.stringify(BINDS.kb));
  localStorage.setItem('breach.binds.pad.v3', JSON.stringify(BINDS.pad));
}

export function resetBinds() {
  Object.assign(BINDS.kb, KB_DEFAULT);
  Object.assign(BINDS.pad, PAD_DEFAULT);
  saveBinds();
}
