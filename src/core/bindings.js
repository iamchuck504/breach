// Bindings configurables de teclado y control, persistidos en localStorage.
const KB_DEFAULT = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  sprint: 'ShiftLeft', evade: 'Space', jump: 'KeyF', reload: 'KeyR', swap: 'KeyQ',
};
// Índices estándar de Gamepad API (layout Xbox)
// A=correr, X=cubrirse/evadir, B=saltar, RB=recargar (pedido de Chuck)
const PAD_DEFAULT = { sprint: 0, evade: 2, jump: 1, reload: 5, swap: 3, aim: 6, fire: 7, pause: 9 };

export const BINDS = { kb: { ...KB_DEFAULT }, pad: { ...PAD_DEFAULT } };

export const KB_LABELS = {
  forward: 'Adelante', back: 'Atrás', left: 'Izquierda', right: 'Derecha',
  sprint: 'Roadie run', evade: 'Cover / Evadir', jump: 'Saltar',
  reload: 'Recargar', swap: 'Cambiar arma',
};
export const PAD_LABELS = {
  sprint: 'Roadie run', evade: 'Cover / Evadir', jump: 'Saltar',
  aim: 'Apuntar', fire: 'Disparar', reload: 'Recargar',
  swap: 'Cambiar arma', pause: 'Pausa',
};

export const PAD_BTN_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'VIEW', 'MENU', 'L3', 'R3', 'D-ARR', 'D-ABA', 'D-IZQ', 'D-DER',
];

export function padBtnName(i) { return PAD_BTN_NAMES[i] ?? 'BTN' + i; }

export function keyLabel(code) {
  if (!code) return '—';
  return code
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace('ShiftLeft', 'SHIFT IZQ').replace('ShiftRight', 'SHIFT DER')
    .replace('ControlLeft', 'CTRL IZQ').replace('ControlRight', 'CTRL DER')
    .replace('AltLeft', 'ALT IZQ').replace('AltRight', 'ALT DER')
    .replace('Space', 'ESPACIO').replace('Arrow', 'FLECHA ')
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
