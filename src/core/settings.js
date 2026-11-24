// Ajustes persistentes del jugador: UN solo módulo (antes vivían sueltos en
// main.js e input.js con claves `breach.sens.*` / `breach.invertY*`). Cada
// clave tiene valor por defecto, rango y validación; los cambios se notifican
// a quien escuche (cámara, HUD, input). Sin dependencias del navegador al
// importarlo: en Node funciona con los valores por defecto.

const STORE_KEY = 'breach.settings.v1';

// type: 'number' | 'bool' | 'enum' · label: clave de i18n (la pone el HUD)
// group: sección del menú de ajustes donde la coloca el HUD.
export const SETTING_DEFS = Object.freeze({
  // --- vista ---
  fov:          { type: 'number', def: 72, min: 60, max: 100, step: 1, group: 'view', label: 'settings.fov' },
  // FOV vertical del arma en primera persona: fijo (DECISIONES §7), solo lectura
  fovWeapon:    { type: 'number', def: 50, min: 50, max: 50, step: 0, group: 'view', label: 'settings.fovWeapon', readOnly: true },
  bob:          { type: 'number', def: 1, min: 0, max: 1, step: 0.05, group: 'view', label: 'settings.bob' },
  shake:        { type: 'number', def: 1, min: 0, max: 1, step: 0.05, group: 'view', label: 'settings.shake' },
  // reduce balanceo, sacudida y gestos bruscos de cámara (accesibilidad)
  reduceMotion: { type: 'bool', def: false, group: 'view', label: 'settings.reduceMotion' },
  // --- ratón ---
  sens:         { type: 'number', def: 0.045, min: 0.01, max: 0.12, step: 0.001, group: 'mouse', label: 'settings.sens' },
  sensAds:      { type: 'number', def: 1, min: 0.3, max: 1.5, step: 0.05, group: 'mouse', label: 'settings.sensAds' },
  sensScope:    { type: 'number', def: 0.75, min: 0.35, max: 1.25, step: 0.05, group: 'mouse', label: 'settings.sensScope' },
  invertY:      { type: 'bool', def: false, group: 'mouse', label: 'settings.invertY' },
  // --- acciones ---
  crouchToggle: { type: 'bool', def: false, group: 'actions', label: 'settings.crouchToggle' },
  adsToggle:    { type: 'bool', def: false, group: 'actions', label: 'settings.adsToggle' },
  sprintToggle: { type: 'bool', def: false, group: 'actions', label: 'settings.sprintToggle' },
  autoPeek:     { type: 'bool', def: true, group: 'actions', label: 'settings.autoPeek' },
  // --- mando ---
  aimAssist:    { type: 'bool', def: true, group: 'pad', label: 'settings.aimAssist' },
  padDeadzone:  { type: 'number', def: 0.12, min: 0, max: 0.35, step: 0.01, group: 'pad', label: 'settings.padDeadzone' },
  padOuterDeadzone: { type: 'number', def: 0.04, min: 0, max: 0.2, step: 0.01, group: 'pad', label: 'settings.padOuterDeadzone' },
  // exponente de la curva de respuesta: 1 lineal, 2 cuadrática (la de siempre)
  padCurve:     { type: 'number', def: 2, min: 1, max: 3, step: 0.1, group: 'pad', label: 'settings.padCurve' },
  padSensX:     { type: 'number', def: 170, min: 60, max: 320, step: 5, group: 'pad', label: 'settings.padSensX' },
  padSensY:     { type: 'number', def: 170, min: 60, max: 320, step: 5, group: 'pad', label: 'settings.padSensY' },
  padSensAds:   { type: 'number', def: 1, min: 0.3, max: 1.5, step: 0.05, group: 'pad', label: 'settings.padSensAds' },
  invertYPad:   { type: 'bool', def: false, group: 'pad', label: 'settings.invertYPad' },
  vibration:    { type: 'bool', def: true, group: 'pad', label: 'settings.vibration' },
  // --- audio (lo aplica fx/audio.js vía main.js) ---
  ownWeaponVolume: { type: 'number', def: 1, min: 0, max: 1.5, step: 0.05, group: 'audio', label: 'settings.ownWeaponVolume' },
  hitSounds:    { type: 'bool', def: true, group: 'audio', label: 'settings.hitSounds' },
  // --- HUD ---
  hudScale:     { type: 'number', def: 1, min: 0.75, max: 1.5, step: 0.05, group: 'hud', label: 'settings.hudScale' },
  // HUD de alto contraste (accesibilidad, PEDIDO §17): paneles opacos, texto y contornos más fuertes
  hudContrast:  { type: 'bool', def: false, group: 'hud', label: 'settings.hudContrast' },
  reticleVisible: { type: 'bool', def: true, group: 'hud', label: 'settings.reticleVisible' },
  reticleColor: { type: 'enum', def: 'white', options: ['white', 'green', 'yellow', 'cyan', 'magenta', 'red'], group: 'hud', label: 'settings.reticleColor' },
  reticleSize:  { type: 'number', def: 1, min: 0.5, max: 2, step: 0.05, group: 'hud', label: 'settings.reticleSize' },
});

export const SETTINGS = {};
for (const [k, d] of Object.entries(SETTING_DEFS)) SETTINGS[k] = d.def;

const listeners = new Set();
let store = null;

// Coerciona y acota. Un valor corrupto guardado nunca deja la sensibilidad
// microscópica ni gigante: vuelve al rango o al valor por defecto.
export function validateSetting(key, value) {
  const d = SETTING_DEFS[key];
  if (!d) return undefined;
  if (d.readOnly) return d.def;
  if (d.type === 'bool') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return d.def;
  }
  if (d.type === 'enum') return d.options.includes(value) ? value : d.def;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return d.def;
  return Math.min(d.max, Math.max(d.min, n));
}

function defaultStorage() {
  try { return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null; }
  catch { return null; }
}

function persist() {
  if (!store) return;
  try { store.setItem(STORE_KEY, JSON.stringify(SETTINGS)); } catch { /* sin almacenamiento */ }
}

// Lee los ajustes guardados. Sin `breach.settings.v1` importa las claves
// sueltas de antes (sensibilidades e inversión) para no perder lo que el
// jugador ya había configurado.
export function loadSettings(storage = defaultStorage()) {
  store = storage;
  for (const [k, d] of Object.entries(SETTING_DEFS)) SETTINGS[k] = d.def;
  if (!store) return SETTINGS;
  let saved = null;
  try { saved = JSON.parse(store.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(SETTING_DEFS)) if (k in saved) SETTINGS[k] = validateSetting(k, saved[k]);
  } else {
    const legacy = (key) => { try { return store.getItem(key); } catch { return null; } };
    const num = (key) => { const v = parseFloat(legacy(key)); return v > 0 ? v : null; };
    const sm = num('breach.sens.mouse'), sp = num('breach.sens.pad'), sz = num('breach.sens.zoom');
    if (sm != null) SETTINGS.sens = validateSetting('sens', sm);
    if (sp != null) { SETTINGS.padSensX = validateSetting('padSensX', sp); SETTINGS.padSensY = validateSetting('padSensY', sp); }
    if (sz != null) SETTINGS.sensScope = validateSetting('sensScope', sz);
    if (legacy('breach.invertY') != null) SETTINGS.invertY = legacy('breach.invertY') === 'true';
    if (legacy('breach.invertYPad') != null) SETTINGS.invertYPad = legacy('breach.invertYPad') === 'true';
  }
  return SETTINGS;
}

export function getSetting(key) { return SETTINGS[key]; }

// Aplica (validado), guarda y avisa solo si el valor cambió. Devuelve el
// valor efectivo (el UI debe mostrar ESTE, no lo que pidió).
export function setSetting(key, value, { save = true } = {}) {
  if (!(key in SETTING_DEFS)) return undefined;
  const next = validateSetting(key, value);
  const prev = SETTINGS[key];
  if (next === prev) return next;
  SETTINGS[key] = next;
  if (save) persist();
  for (const fn of [...listeners]) {
    try { fn(key, next, prev); } catch (e) { console.error('[settings]', key, e); }
  }
  return next;
}

export function resetSettings(keys = Object.keys(SETTING_DEFS)) {
  for (const k of keys) if (k in SETTING_DEFS) setSetting(k, SETTING_DEFS[k].def, { save: false });
  persist();
}

// fn(key, value, prev). Devuelve la función para darse de baja.
export function onSettingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Movimiento reducido: los consumidores multiplican balanceo/sacudida por esto.
export function motionScale(kind, settings = SETTINGS) {
  const base = kind === 'bob' ? settings.bob ?? 1 : kind === 'shake' ? settings.shake ?? 1 : 1;
  return base * (settings.reduceMotion ? 0.25 : 1);
}

// Sensibilidad efectiva de mira. Ratón: grados por píxel. Mando: grados por
// segundo a deflexión completa, separada en X/Y. La cámara sigue escalando por
// FOV aparte; estos multiplicadores son la preferencia del jugador encima.
export function lookSensitivity(device, { aim = false, scoped = false } = {}) {
  if (device === 'pad') {
    const k = (aim ? SETTINGS.padSensAds : 1) * (scoped ? SETTINGS.sensScope : 1);
    return { x: SETTINGS.padSensX * k, y: SETTINGS.padSensY * k };
  }
  const k = SETTINGS.sens * (aim ? SETTINGS.sensAds : 1) * (scoped ? SETTINGS.sensScope : 1);
  return { x: k, y: k };
}

// Compatibilidad mientras la cámara lee TUNING.cam: refleja sens, padSens y
// zoomSens en TUNING (y en cada cambio). TODO integración: la cámara debería
// usar lookSensitivity() directamente.
export function bindTuning(TUNING) {
  const apply = () => {
    TUNING.cam.sens = SETTINGS.sens;
    TUNING.cam.padSens = SETTINGS.padSensX;
    TUNING.cam.zoomSens = SETTINGS.sensScope;
  };
  apply();
  return onSettingChange((k) => { if (k === 'sens' || k === 'padSensX' || k === 'sensScope') apply(); });
}

loadSettings();
