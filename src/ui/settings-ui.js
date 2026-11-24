// Páginas de ajustes FPS: Ratón y puntería, Cámara y comodidad, HUD y
// retícula. Se generan desde SETTING_DEFS (src/core/settings.js, de
// JUGABILIDAD): una clave que no exista allí no se dibuja, y cada valor que se
// muestra es el EFECTIVO que devuelve setSetting (validado y acotado).
//
// Se monta sola (index.html la carga como módulo aparte) para no depender de
// cambios en main.js: abre sus tarjetas desde el hub de Opciones, vuelve al
// hub con Atrás/Esc/B (menu-controller.js lee data-nav-back) y se oculta si
// main.js muestra otra tarjeta. También sincroniza la franja de sensibilidad
// de la tarjeta Controles con el módulo de ajustes y marca conflictos de teclas.
import { t, onLanguageChange } from '../core/i18n.js';
import { SETTING_DEFS, SETTINGS, setSetting, resetSettings, onSettingChange } from '../core/settings.js';
import { BINDS, KB_LABELS, PAD_LABELS, keyLabel, padBtnName } from '../core/bindings.js';
import { Reticle } from './reticle.js';
import { TUNING } from '../config/tuning.js';

// Qué va en cada página y en qué orden. Las claves ausentes se saltan.
export const SETTINGS_PAGES = Object.freeze({
  aim: [
    { title: 'settings.secMouse', keys: ['sens', 'sensAds', 'sensScope', 'invertY'] },
    { title: 'settings.secController', keys: ['padSensX', 'padSensY', 'padSensAds', 'padDeadzone', 'padOuterDeadzone', 'padCurve', 'invertYPad', 'aimAssist', 'vibration'], note: 'settings.aimAssistNote' },
    { title: 'settings.secActions', keys: ['crouchToggle', 'adsToggle', 'sprintToggle', 'autoPeek'], note: 'settings.autoPeekNote' },
  ],
  comfort: [
    // fovWeapon es fijo (DECISIONES §7): un valor que no se puede cambiar no se enseña
    { title: 'settings.secView', keys: ['fov'], note: 'settings.fovNote' },
    { title: 'settings.secComfort', keys: ['bob', 'shake', 'reduceMotion'], note: 'settings.comfortNote' },
  ],
  // Audio: la tarjeta la abre main.js (volumen general); aquí se añaden las
  // claves de JUGABILIDAD/AUDIO del grupo 'audio' debajo del volumen.
  audio: [
    { title: 'settings.secMix', keys: ['ownWeaponVolume', 'hitSounds'] },
  ],
  hud: [
    { title: 'settings.secHud', keys: ['hudScale', 'hudContrast'] },
    { title: 'settings.secReticle', keys: ['reticleVisible', 'reticleColor', 'reticleSize'] },
  ],
});
const CARD_OF = { aim: 'aim-card', comfort: 'comfort-card', hud: 'hudopts-card', audio: 'audio-card' };
const HUB_BUTTON = { aim: 'btn-opt-aim', comfort: 'btn-opt-comfort', hud: 'btn-opt-hud' };
// mantener/alternar se lee mejor como dos palabras que como una casilla
const HOLD_TOGGLE = new Set(['crouchToggle', 'adsToggle', 'sprintToggle']);
const PERCENT = new Set(['ownWeaponVolume', 'sensAds', 'sensScope', 'padSensAds', 'hudScale', 'reticleSize', 'bob', 'shake', 'padDeadzone', 'padOuterDeadzone']);

export function formatSetting(key, v) {
  if (typeof v === 'boolean') return '';
  if (key === 'fov' || key === 'fovWeapon') return `${Math.round(v)}°`;
  if (key === 'padSensX' || key === 'padSensY') return `${Math.round(v)}°/s`;
  if (key === 'sens') return Number(v).toFixed(3);
  if (key === 'padCurve') return `${Number(v).toFixed(1)}`;
  if (PERCENT.has(key)) return `${Math.round(v * 100)}%`;
  return String(v);
}

const doc = typeof document !== 'undefined' ? document : null;
const controls = new Map(); // key → [{ kind, input, val }]

function rowFor(key) {
  const d = SETTING_DEFS[key];
  const row = doc.createElement('div');
  row.className = 'set-row';
  const id = `set-${key}`;
  const label = doc.createElement('label');
  label.htmlFor = id;
  label.dataset.i18n = d.label;
  label.textContent = t(d.label);
  const entry = { kind: d.type, input: null, val: null };
  if (d.readOnly) {
    row.classList.add('readonly');
    const span = doc.createElement('span');
    span.className = 'set-label'; span.dataset.i18n = d.label; span.textContent = t(d.label);
    entry.val = doc.createElement('span'); entry.val.className = 'set-val';
    row.append(span, entry.val);
  } else if (d.type === 'number') {
    entry.val = doc.createElement('span'); entry.val.className = 'set-val';
    const input = doc.createElement('input');
    input.type = 'range'; input.id = id; input.min = d.min; input.max = d.max; input.step = d.step || 'any';
    input.dataset.setting = key;
    input.addEventListener('input', () => show(key, setSetting(key, parseFloat(input.value))));
    entry.input = input;
    row.append(label, entry.val, input);
  } else if (d.type === 'bool' && HOLD_TOGGLE.has(key)) {
    entry.kind = 'holdToggle';
    const sel = doc.createElement('select');
    sel.id = id; sel.dataset.setting = key;
    for (const [v, k] of [['0', 'settings.hold'], ['1', 'settings.toggle']]) {
      const o = doc.createElement('option'); o.value = v; o.dataset.i18n = k; o.textContent = t(k); sel.append(o);
    }
    sel.addEventListener('change', () => show(key, setSetting(key, sel.value === '1')));
    entry.input = sel;
    row.append(label, sel);
  } else if (d.type === 'bool') {
    row.classList.add('set-check');
    const input = doc.createElement('input');
    input.type = 'checkbox'; input.id = id; input.dataset.setting = key;
    input.addEventListener('change', () => show(key, setSetting(key, input.checked)));
    entry.input = input;
    row.append(label, input);
  } else if (d.type === 'enum') {
    const sel = doc.createElement('select');
    sel.id = id; sel.dataset.setting = key;
    for (const opt of d.options) {
      const o = doc.createElement('option'); o.value = opt;
      const k = key === 'reticleColor' ? `settings.color.${opt}` : `settings.${key}.${opt}`;
      o.dataset.i18n = k; o.textContent = t(k); sel.append(o);
    }
    sel.addEventListener('change', () => show(key, setSetting(key, sel.value)));
    entry.input = sel;
    row.append(label, sel);
  }
  controls.set(key, [...(controls.get(key) || []), entry]);
  return row;
}

function show(key, value = SETTINGS[key]) {
  for (const e of controls.get(key) || []) {
    if (e.val) e.val.textContent = formatSetting(key, value);
    if (!e.input) continue;
    if (e.kind === 'holdToggle') e.input.value = value ? '1' : '0';
    else if (e.input.type === 'checkbox') e.input.checked = !!value;
    else if (String(e.input.value) !== String(value)) e.input.value = value;
  }
  if (key.startsWith('reticle')) drawPreview();
}

function buildPage(page) {
  const card = doc.getElementById(CARD_OF[page]);
  const host = card?.querySelector('.set-sections');
  if (!host) return;
  host.textContent = '';
  for (const sec of SETTINGS_PAGES[page]) {
    const keys = sec.keys.filter((k) => SETTING_DEFS[k]);
    if (!keys.length) continue;
    const box = doc.createElement('section');
    box.className = 'set-section';
    const h = doc.createElement('h2'); h.dataset.i18n = sec.title; h.textContent = t(sec.title);
    box.append(h);
    for (const k of keys) box.append(rowFor(k));
    if (sec.note) {
      const p = doc.createElement('p'); p.className = 'set-note'; p.dataset.i18n = sec.note; p.textContent = t(sec.note);
      box.append(p);
    }
    host.append(box);
  }
  card.querySelector('[data-reset-page]')?.addEventListener('click', () => {
    resetSettings(SETTINGS_PAGES[page].flatMap((s) => s.keys).filter((k) => SETTING_DEFS[k] && !SETTING_DEFS[k].readOnly));
    for (const k of controls.keys()) show(k);
  });
}

// ---------- vista previa de la retícula (misma clase que la del juego) ----------
let preview = null;
function drawPreview() {
  if (!preview) return;
  preview.setOptions({ visible: true, color: SETTINGS.reticleColor, size: SETTINGS.reticleSize });
  preview.state.gap = -1;
  preview.root.style.opacity = SETTINGS.reticleVisible === false ? '.25' : '1';
  preview.draw({ weapon: 'smg', def: TUNING.weapons.smg, spreadDeg: TUNING.weapons.smg?.spreadHip ?? 3, aim: 0,
    show: true, fovDeg: SETTINGS.fov || 72, height: 720, maxGap: 70 });
}

// ---------- navegación entre tarjetas ----------
function menuCards() { return [...doc.querySelectorAll('#menu .menu-card')]; }
function ownCards() { return ['aim', 'comfort', 'hud'].map((p) => doc.getElementById(CARD_OF[p])).filter(Boolean); }
const isShown = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.classList.contains('off');

function openPage(page) {
  const card = doc.getElementById(CARD_OF[page]);
  if (!card) return;
  for (const c of menuCards()) if (c !== card && c.id !== 'lobby-card') c.style.display = 'none';
  for (const k of controls.keys()) show(k);
  card.style.display = 'block';
  const menu = doc.getElementById('menu');
  if (menu) menu.scrollTop = 0;
}

function backToHub(card) {
  card.style.display = 'none';
  const hub = doc.getElementById('options-card');
  if (hub) hub.style.display = 'block';
  const btn = doc.getElementById(HUB_BUTTON[card.dataset.page]);
  try { btn?.focus({ preventScroll: true }); } catch { /* sin foco */ }
}

// Si main.js muestra otra tarjeta (abrir/cerrar pausa, lobby…), las nuestras
// se retiran: nunca dos tarjetas a la vez.
function watchOtherCards() {
  const mine = new Set(ownCards());
  const obs = new MutationObserver(() => {
    const open = ownCards().filter(isShown);
    if (!open.length) return;
    const other = menuCards().some((c) => !mine.has(c) && isShown(c));
    if (other) for (const c of open) c.style.display = 'none';
  });
  for (const c of menuCards()) if (!mine.has(c)) obs.observe(c, { attributes: true, attributeFilter: ['style', 'class'] });
}

// ---------- franja de sensibilidad de la tarjeta Controles ----------
// Misma fuente que la página Ratón y puntería (no dos valores distintos).
function syncControlsStrip() {
  const pairs = [['sl-mouse', 'sens'], ['sl-zoom', 'sensScope'], ['sl-pad', 'padSensX']];
  for (const [id, key] of pairs) {
    const el = doc.getElementById(id);
    if (!el || !SETTING_DEFS[key]) continue;
    el.addEventListener('input', () => {
      setSetting(key, parseFloat(el.value));
      if (key === 'padSensX' && SETTING_DEFS.padSensY) setSetting('padSensY', parseFloat(el.value));
    });
  }
  for (const [id, key] of [['chk-invert', 'invertY'], ['chk-invert-pad', 'invertYPad']]) {
    const el = doc.getElementById(id);
    if (el && SETTING_DEFS[key]) el.addEventListener('change', () => setSetting(key, el.checked));
  }
}

// ---------- conflictos de asignación ----------
function markConflicts() {
  for (const [dev, rowsId, noteId, labels, none, name] of [
    ['kb', 'kb-rows', 'kb-conflicts', KB_LABELS, '', keyLabel],
    ['pad', 'pad-rows', 'pad-conflicts', PAD_LABELS, -1, padBtnName],
  ]) {
    const rows = doc.getElementById(rowsId), note = doc.getElementById(noteId);
    if (!rows) continue;
    const byValue = new Map();
    for (const action of Object.keys(labels)) {
      const v = BINDS[dev][action];
      if (v === none || v === undefined || v === null) continue;
      byValue.set(v, [...(byValue.get(v) || []), action]);
    }
    const lines = [];
    for (const btn of rows.querySelectorAll('.bind-btn')) {
      const action = btn.dataset.navKey?.split(':').pop();
      const v = BINDS[dev][action];
      const dup = (byValue.get(v)?.length ?? 0) > 1;
      btn.classList.toggle('conflict', dup);
      btn.classList.toggle('unbound', v === none || v === undefined);
      if (v === none || v === undefined) btn.title = t('settings.unbound');
      else if (dup) btn.title = t('settings.conflict', { key: name(v), actions: byValue.get(v).map((a) => t(labels[a])).join(' · ') });
      else btn.removeAttribute('title');
    }
    for (const [v, actions] of byValue) {
      if (actions.length > 1) lines.push(t('settings.conflict', { key: name(v), actions: actions.map((a) => t(labels[a])).join(' · ') }));
    }
    if (note) note.textContent = lines.join('\n');
  }
}

export function mountSettingsUI() {
  if (!doc || mountSettingsUI.done) return;
  mountSettingsUI.done = true;
  for (const page of Object.keys(SETTINGS_PAGES)) buildPage(page);
  const ph = doc.getElementById('reticle-preview');
  if (ph) preview = new Reticle(ph);
  for (const k of controls.keys()) show(k);
  for (const [page, id] of Object.entries(HUB_BUTTON)) doc.getElementById(id)?.addEventListener('click', () => openPage(page));
  for (const card of ownCards()) {
    doc.getElementById(card.dataset.navBack)?.addEventListener('click', () => backToHub(card));
  }
  watchOtherCards();
  // Esc en una página propia vuelve al hub (antes que input.js/main.js, que
  // no conocen estas tarjetas). El mando llega por menu-controller (data-nav-back).
  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || e.repeat) return;
    const card = ownCards().find(isShown);
    if (!card) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (doc.activeElement?.blur) doc.activeElement.blur();
    backToHub(card);
  }, true);
  syncControlsStrip();
  onSettingChange((key, value) => show(key, value));
  for (const id of ['kb-rows', 'pad-rows']) {
    const el = doc.getElementById(id);
    if (el) new MutationObserver(markConflicts).observe(el, { childList: true });
  }
  markConflicts();
  onLanguageChange(() => { markConflicts(); for (const k of controls.keys()) show(k); });
}

if (doc) {
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mountSettingsUI, { once: true });
  else mountSettingsUI();
}
