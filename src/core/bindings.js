// Bindings configurables de teclado y control, persistidos en localStorage.
const KB_DEFAULT = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  sprint: 'ShiftLeft', evade: 'Space', reload: 'KeyR', swap: 'KeyQ',
};
// Índices estándar de Gamepad API (layout Xbox)
const PAD_DEFAULT = { evade: 0, sprint: 10, reload: 2, swap: 3, aim: 6, fire: 7, pause: 9 };

export const BINDS = { kb: { ...KB_DEFAULT }, pad: { ...PAD_DEFAULT } };

export const KB_LABELS = {
  forward: 'Adelante', back: 'Atrás', left: 'Izquierda', right: 'Derecha',
  sprint: 'Roadie run', evade: 'Cover / Evadir', reload: 'Recargar', swap: 'Cambiar arma',
};
export const PAD_LABELS = {
  evade: 'Cover / Evadir', sprint: 'Roadie run', aim: 'Apuntar', fire: 'Disparar',
  reload: 'Recargar', swap: 'Cambiar arma', pause: 'Pausa',
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

export function loadBinds() {
  try {
    const kb = JSON.parse(localStorage.getItem('breach.binds.kb') || 'null');
    const pad = JSON.parse(localStorage.getItem('breach.binds.pad') || 'null');
    if (kb) for (const k in KB_DEFAULT) { if (typeof kb[k] === 'string') BINDS.kb[k] = kb[k]; }
    if (pad) for (const k in PAD_DEFAULT) { if (typeof pad[k] === 'number') BINDS.pad[k] = pad[k]; }
  } catch { /* defaults */ }
}

export function saveBinds() {
  localStorage.setItem('breach.binds.kb', JSON.stringify(BINDS.kb));
  localStorage.setItem('breach.binds.pad', JSON.stringify(BINDS.pad));
}

export function resetBinds() {
  Object.assign(BINDS.kb, KB_DEFAULT);
  Object.assign(BINDS.pad, PAD_DEFAULT);
  saveBinds();
}
