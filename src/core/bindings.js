// Bindings configurables de teclado y control, persistidos en localStorage.
import { t } from './i18n.js';
const KB_DEFAULT = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  sprint: 'ShiftLeft', evade: 'Space', jump: 'KeyF', reload: 'KeyR', swap: 'KeyQ',
  score: 'Tab',
};
// Índices estándar de Gamepad API (layout Xbox)
// A=correr, X=cubrirse/evadir, B=saltar, RB=recargar (pedido de Chuck)
const PAD_DEFAULT = { sprint: 0, evade: 2, jump: 1, reload: 5, swap: 3, aim: 6, fire: 7, score: 8, pause: 9 };

export const BINDS = { kb: { ...KB_DEFAULT }, pad: { ...PAD_DEFAULT } };

export const KB_LABELS = {
  forward: 'binding.forward', back: 'binding.back', left: 'binding.left', right: 'binding.right',
  sprint: 'binding.sprint', evade: 'binding.evade', jump: 'binding.jump',
  reload: 'binding.reload', swap: 'binding.swap', score: 'binding.score',
};
export const PAD_LABELS = {
  sprint: 'binding.sprint', evade: 'binding.evade', jump: 'binding.jump',
  aim: 'binding.aim', fire: 'binding.fire', reload: 'binding.reload',
  swap: 'binding.swap', score: 'binding.score', pause: 'binding.pause',
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

// v2: al cambiar los defaults (A=correr, X=evadir, RB=recargar, salto nuevo)
// se ignoran los binds guardados con el esquema viejo
export function loadBinds() {
  try {
    const kb = JSON.parse(localStorage.getItem('breach.binds.kb.v2') || 'null');
    const pad = JSON.parse(localStorage.getItem('breach.binds.pad.v2') || 'null');
    if (kb) for (const k in KB_DEFAULT) { if (typeof kb[k] === 'string') BINDS.kb[k] = kb[k]; }
    if (pad) for (const k in PAD_DEFAULT) { if (typeof pad[k] === 'number') BINDS.pad[k] = pad[k]; }
  } catch { /* defaults */ }
}

export function saveBinds() {
  localStorage.setItem('breach.binds.kb.v2', JSON.stringify(BINDS.kb));
  localStorage.setItem('breach.binds.pad.v2', JSON.stringify(BINDS.pad));
}

export function resetBinds() {
  Object.assign(BINDS.kb, KB_DEFAULT);
  Object.assign(BINDS.pad, PAD_DEFAULT);
  saveBinds();
}
