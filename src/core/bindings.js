// Bindings configurables de teclado y control, persistidos en localStorage.
// v4 (FPS): agacharse, inclinarse, granada rápida, arma anterior e
// interactuar propio en el mando. Espacio/X vuelve a ser la esquiva FPS.
import { t } from './i18n.js';

const KB_DEFAULT = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  sprint: 'ShiftLeft', crouch: 'KeyC', evade: 'Space', jump: 'KeyT',
  leanLeft: 'KeyQ', leanRight: 'KeyE',
  reload: 'KeyR', melee: 'KeyV', grenade: 'KeyG',
  pickup: 'KeyF',   // recoger / interactuar
  swap: 'KeyX', swapPrev: 'KeyZ', // la rueda del ratón también cicla
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4',
  score: 'Tab',
};
// Índices estándar de Gamepad API (layout Xbox). Esquema "táctico": B sigue
// siendo melee y RB recargar (pedidos de Chuck); agacharse/deslizar en R3,
// sprint en L3. Inclinarse comparte L3/R3 de forma CONTEXTUAL: apuntando,
// L3/R3 inclinan (alternar); sin apuntar son sprint/agacharse (el sprint no
// existe en ADS). La cruceta elige arma salvo abajo, que recoge.
const PAD_DEFAULT = {
  jump: 0, melee: 1, evade: 2, pickup: 13, swap: 3, grenade: 4, reload: 5,
  aim: 6, fire: 7, score: 8, pause: 9, sprint: 10, crouch: 11,
  leanLeft: 10, leanRight: 11,
};
// Únicos pares que pueden compartir botón en el mando: inclinarse (solo en
// ADS) con sprint/agacharse (fuera de ADS). Cualquier otro duplicado es un
// conflicto.
const PAD_LEAN = new Set(['leanLeft', 'leanRight']);
const PAD_SHARES_WITH_LEAN = new Set(['sprint', 'crouch']);
export function canShareBind(device, a, b) {
  if (device !== 'pad') return false;
  return (PAD_LEAN.has(a) && PAD_SHARES_WITH_LEAN.has(b)) || (PAD_LEAN.has(b) && PAD_SHARES_WITH_LEAN.has(a));
}
// Inclinación de mando contextual (solo en ADS, alternar) cuando su botón lo
// comparte con otra acción; en un botón propio se mantiene, siempre.
export function padLeanContextual(pad, action) {
  const v = pad?.[action];
  if (!(v >= 0)) return false;
  return Object.keys(pad).some((k) => k !== action && !PAD_LEAN.has(k) && pad[k] === v);
}
// Cruceta: selecciona arma SALVO que el jugador le haya asignado una acción
// (la asignación manda; no hace las dos cosas).
export function dpadSlotFor(btn, pad = BINDS.pad) {
  if (!(btn in PAD_DPAD_SLOTS)) return -1;
  return Object.values(pad).includes(btn) ? -1 : PAD_DPAD_SLOTS[btn];
}

// D-pad → índice de SLOT (no id de arma: si una especial reemplazó la SMG,
// derecha sigue seleccionando ese slot). Arriba=granada, abajo=pistola,
// izquierda=escopeta, derecha=SMG. Fijo por pedido de Chuck.
export const PAD_DPAD_SLOTS = { 12: 3, 13: 2, 14: 1, 15: 0 };

export const BINDS = { kb: { ...KB_DEFAULT }, pad: { ...PAD_DEFAULT } };

export const KB_LABELS = {
  forward: 'binding.forward', back: 'binding.back', left: 'binding.left', right: 'binding.right',
  sprint: 'binding.sprint', evade: 'binding.evade', crouch: 'binding.crouch', jump: 'binding.jump',
  leanLeft: 'binding.leanLeft', leanRight: 'binding.leanRight',
  melee: 'binding.melee', grenade: 'binding.grenade', reload: 'binding.reload',
  swap: 'binding.swap', swapPrev: 'binding.swapPrev', pickup: 'binding.pickup',
  slot1: 'binding.slot1', slot2: 'binding.slot2', slot3: 'binding.slot3', slot4: 'binding.slot4',
  score: 'binding.score',
};
export const PAD_LABELS = {
  jump: 'binding.jump', evade: 'binding.evade', crouch: 'binding.crouch', sprint: 'binding.sprint',
  aim: 'binding.aim', fire: 'binding.fire', reload: 'binding.reload',
  melee: 'binding.melee', grenade: 'binding.grenade', pickup: 'binding.pickup',
  swap: 'binding.swap', leanLeft: 'binding.leanLeft', leanRight: 'binding.leanRight',
  score: 'binding.score', pause: 'binding.pause',
};

export const PAD_BTN_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'VIEW', 'MENU', 'L3', 'R3', 'D-ARR', 'D-ABA', 'D-IZQ', 'D-DER',
];

export function padBtnName(i) {
  if (!Number.isInteger(i) || i < 0) return '—';
  return PAD_BTN_NAMES[i] ?? t('key.button') + i;
}

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

const KEY_V4 = { kb: 'breach.binds.kb.v4', pad: 'breach.binds.pad.v4' };
const KEY_V3 = { kb: 'breach.binds.kb.v3', pad: 'breach.binds.pad.v3' };

// Valores por defecto de v3 (para distinguir lo que el jugador personalizó).
const V3_KB_DEFAULT = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft',
  evade: 'Space', jump: 'KeyF', reload: 'KeyR', swap: 'KeyQ', melee: 'KeyV', pickup: 'KeyE',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', score: 'Tab',
};
const V3_PAD_DEFAULT = { sprint: 0, evade: 2, melee: 1, jump: 3, reload: 5, aim: 6, fire: 7, score: 8, pause: 9 };

// Rellena huecos y resuelve duplicados: lo `keep` (lo que el jugador eligió)
// gana; una acción por defecto que choque vuelve a su valor v4 si está libre,
// y si no queda sin asignar (mejor sin tecla que dos acciones en una).
// Entre dos acciones elegidas por el jugador con el mismo valor gana la
// primera (orden de las acciones) y la otra queda sin asignar y se informa
// como conflicto ({device, action, value, with}) para que el menú lo enseñe.
function settle(map, defaults, keep, none, device, conflicts = []) {
  const out = { ...defaults };
  const used = new Map(); // valor → acciones que lo tienen
  const clash = (k, v) => (used.get(v) || []).find((o) => !canShareBind(device, k, o));
  const take = (k, v) => { used.set(v, [...(used.get(v) || []), k]); };
  for (const k of Object.keys(defaults)) {
    if (!keep.includes(k)) continue;
    const v = map[k];
    if (v === none) { out[k] = none; continue; }
    const other = clash(k, v);
    if (other) { out[k] = none; conflicts.push({ device, action: k, value: v, with: other }); continue; }
    out[k] = v; take(k, v);
  }
  for (const k of Object.keys(defaults)) {
    if (keep.includes(k)) continue;
    if (out[k] !== none && clash(k, out[k])) out[k] = none;
    if (out[k] !== none) take(k, out[k]);
  }
  return out;
}

// Conflictos resueltos en la última carga (el menú puede mostrarlos).
export const BIND_CONFLICTS = [];

// Pura (probada en Node): convierte binds guardados v3 al esquema v4. Solo
// conserva lo que el jugador cambió respecto de v3 y que siga existiendo;
// todo lo demás toma los nuevos valores por defecto.
export function migrateBindsV3(kb3, pad3) {
  const kbKeep = [], padKeep = [];
  const kb = {}, pad = {};
  if (kb3 && typeof kb3 === 'object') {
    for (const k of Object.keys(KB_DEFAULT)) {
      if (typeof kb3[k] === 'string' && kb3[k] && k in V3_KB_DEFAULT && kb3[k] !== V3_KB_DEFAULT[k]) {
        kb[k] = kb3[k]; kbKeep.push(k);
      }
    }
  }
  if (pad3 && typeof pad3 === 'object') {
    for (const k of Object.keys(PAD_DEFAULT)) {
      if (Number.isInteger(pad3[k]) && pad3[k] >= 0 && k in V3_PAD_DEFAULT && pad3[k] !== V3_PAD_DEFAULT[k]) {
        pad[k] = pad3[k]; padKeep.push(k);
      }
    }
  }
  const conflicts = [];
  return {
    kb: settle(kb, KB_DEFAULT, kbKeep, '', 'kb', conflicts),
    pad: settle(pad, PAD_DEFAULT, padKeep, -1, 'pad', conflicts),
    conflicts,
  };
}

// Pura: limpia un mapa v4 leído (tipos válidos, acciones conocidas).
export function sanitizeBinds(kb, pad) {
  const okKb = {}, okPad = {}, kbKeep = [], padKeep = [];
  if (kb && typeof kb === 'object') {
    for (const k of Object.keys(KB_DEFAULT)) if (typeof kb[k] === 'string') { okKb[k] = kb[k]; kbKeep.push(k); }
  }
  if (pad && typeof pad === 'object') {
    for (const k of Object.keys(PAD_DEFAULT)) if (Number.isInteger(pad[k]) && pad[k] >= -1) { okPad[k] = pad[k]; padKeep.push(k); }
  }
  const conflicts = [];
  return { kb: settle(okKb, KB_DEFAULT, kbKeep, '', 'kb', conflicts), pad: settle(okPad, PAD_DEFAULT, padKeep, -1, 'pad', conflicts), conflicts };
}

function storage() {
  try { return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null; }
  catch { return null; }
}

export function loadBinds(store = storage()) {
  BIND_CONFLICTS.length = 0;
  Object.assign(BINDS.kb, KB_DEFAULT);
  Object.assign(BINDS.pad, PAD_DEFAULT);
  if (!store) return BINDS;
  try {
    const kb4 = JSON.parse(store.getItem(KEY_V4.kb) || 'null');
    const pad4 = JSON.parse(store.getItem(KEY_V4.pad) || 'null');
    if (kb4 || pad4) {
      // v4 de la primera versión guardaba inclinación de mando en −1 (no había
      // botón por defecto): eso no es una elección del jugador
      if (pad4) for (const k of PAD_LEAN) if (pad4[k] === -1) delete pad4[k];
      // En v4 Espacio saltaba y X recogía. Migrar solo los antiguos valores
      // por defecto. Las reasignaciones del jugador tienen prioridad.
      if (kb4 && !('evade' in kb4) && kb4.jump === 'Space') delete kb4.jump;
      if (pad4 && !('evade' in pad4) && pad4.pickup === 2) delete pad4.pickup;
      const r = sanitizeBinds(kb4, pad4);
      Object.assign(BINDS.kb, r.kb); Object.assign(BINDS.pad, r.pad);
      BIND_CONFLICTS.push(...r.conflicts);
      return BINDS;
    }
    const kb3 = JSON.parse(store.getItem(KEY_V3.kb) || 'null');
    const pad3 = JSON.parse(store.getItem(KEY_V3.pad) || 'null');
    if (kb3 || pad3) {
      const r = migrateBindsV3(kb3, pad3);
      Object.assign(BINDS.kb, r.kb); Object.assign(BINDS.pad, r.pad);
      BIND_CONFLICTS.push(...r.conflicts);
      saveBinds(store); // la migración se hace una vez; v3 queda intacto por si se vuelve atrás
    }
  } catch { /* defaults */ }
  return BINDS;
}

export function saveBinds(store = storage()) {
  if (!store) return;
  try {
    store.setItem(KEY_V4.kb, JSON.stringify(BINDS.kb));
    store.setItem(KEY_V4.pad, JSON.stringify(BINDS.pad));
  } catch { /* sin almacenamiento */ }
}

export function resetBinds(store = storage()) {
  Object.assign(BINDS.kb, KB_DEFAULT);
  Object.assign(BINDS.pad, PAD_DEFAULT);
  saveBinds(store);
}

// Reasignar sin duplicados: si el valor ya lo usaba otra acción, esa acción
// recibe el valor anterior de ésta (intercambio). device: 'kb' | 'pad'.
export function assignBind(device, action, value, store = storage()) {
  const map = BINDS[device];
  if (!map || !(action in (device === 'kb' ? KB_DEFAULT : PAD_DEFAULT))) return false;
  const prev = map[action];
  for (const k of Object.keys(map)) {
    if (k !== action && map[k] === value && !canShareBind(device, action, k)) map[k] = prev;
  }
  map[action] = value;
  saveBinds(store);
  return true;
}

export const BIND_DEFAULTS = Object.freeze({ kb: { ...KB_DEFAULT }, pad: { ...PAD_DEFAULT } });

// ---------- teclas gemelas y de respaldo (según el binding EFECTIVO) ----------
// Un modificador asignado admite también su gemelo del otro lado (Shift,
// Ctrl, Alt) y el movimiento admite las flechas (Steam Desktop Layout
// publica el stick como flechas), pero SOLO si esa otra tecla no la usa otra
// acción: reasignar sprint a B deja Shift derecho libre de verdad.
const TWIN = { ShiftLeft: 'ShiftRight', ShiftRight: 'ShiftLeft', ControlLeft: 'ControlRight',
  ControlRight: 'ControlLeft', AltLeft: 'AltRight', AltRight: 'AltLeft' };
const ARROW = { forward: 'ArrowUp', back: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
export function kbMatches(code, action, kb = BINDS.kb) {
  if (!code) return false;
  const bound = kb[action];
  if (bound && code === bound) return true;
  const takenByOther = Object.keys(kb).some((k) => k !== action && kb[k] === code);
  if (takenByOther) return false;
  if (bound && TWIN[bound] === code) return true;
  return ARROW[action] === code;
}
