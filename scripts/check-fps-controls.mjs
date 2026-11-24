// Controles y ajustes FPS (etapa B, JUGABILIDAD). Solo Node.
// - Migración de bindings v3 → v4 (lo personalizado se conserva, sin duplicados).
// - Mantener/alternar (ToggleLatch), zona muerta radial + exterior y curva.
// - Límites de la fricción de asistencia (DECISIONES §6).
// - Ajustes: validación, migración de las claves sueltas, notificación.
import { BINDS, BIND_DEFAULTS, migrateBindsV3, sanitizeBinds, loadBinds, saveBinds, assignBind, padBtnName,
  KB_LABELS, PAD_LABELS, BIND_CONFLICTS, dpadSlotFor, padLeanContextual, PAD_DPAD_SLOTS, kbMatches } from '../src/core/bindings.js';
import { ToggleLatch } from '../src/core/input.js';
import { shapeStick, aimFriction, AIM_FRICTION } from '../src/core/gamepad.js';
import { SETTINGS, SETTING_DEFS, loadSettings, setSetting, onSettingChange, validateSetting, resetSettings,
  lookSensitivity, bindTuning } from '../src/core/settings.js';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const memStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};
// duplicados reales (en el mando, inclinarse puede compartir con sprint/agacharse)
const noDupes = (map, none) => {
  const ent = Object.entries(map).filter(([k, v]) => v !== none && !(none === -1 && (k === 'leanLeft' || k === 'leanRight')));
  return new Set(ent.map(([, v]) => v)).size === ent.length;
};

// ---------- acciones FPS presentes y reasignables en ambos dispositivos ----------
for (const a of ['forward', 'back', 'left', 'right', 'sprint', 'crouch', 'jump', 'leanLeft', 'leanRight', 'reload',
  'melee', 'grenade', 'pickup', 'swap', 'swapPrev', 'slot1', 'slot2', 'slot3', 'slot4', 'score']) {
  check(a in BIND_DEFAULTS.kb && a in KB_LABELS, `teclado sin acción ${a}`);
}
for (const a of ['jump', 'crouch', 'sprint', 'aim', 'fire', 'reload', 'melee', 'grenade', 'pickup', 'swap',
  'leanLeft', 'leanRight', 'score', 'pause']) {
  check(a in BIND_DEFAULTS.pad && a in PAD_LABELS, `mando sin acción ${a}`);
}
check(KB_LABELS.evade && PAD_LABELS.evade && BINDS.kb.evade === 'Space' && BINDS.pad.evade === 2, 'esquiva dedicada sin los controles de origen');
check(noDupes(BIND_DEFAULTS.kb, '') && noDupes(BIND_DEFAULTS.pad, -1), 'valores por defecto duplicados');
check(BIND_DEFAULTS.pad.melee === 1 && BIND_DEFAULTS.pad.reload === 5, 'mando: B melee / RB recargar (pedido de Chuck)');
check(padBtnName(-1) === '—' && padBtnName(11) === 'R3', 'nombres de botón');

// ---------- migración v3 → v4 ----------
{
  // sin personalizar: todo pasa a v4
  const r = migrateBindsV3({ forward: 'KeyW', evade: 'Space', jump: 'KeyF', pickup: 'KeyE', swap: 'KeyQ' },
    { sprint: 0, evade: 2, melee: 1, jump: 3, reload: 5, aim: 6, fire: 7, score: 8, pause: 9 });
  check(JSON.stringify(r.kb) === JSON.stringify(BIND_DEFAULTS.kb), `v3 por defecto no da v4 por defecto: ${JSON.stringify(r.kb)}`);
  check(JSON.stringify(r.pad) === JSON.stringify(BIND_DEFAULTS.pad), `mando v3 por defecto: ${JSON.stringify(r.pad)}`);
  // personalizado: se conserva; lo que choca queda libre, nunca duplicado
  const c = migrateBindsV3({ forward: 'ArrowUp', reload: 'KeyG', swap: 'KeyE', evade: 'KeyK', jump: 'Space' },
    { reload: 2, fire: 7 });
  check(c.kb.forward === 'ArrowUp' && c.kb.reload === 'KeyG' && c.kb.swap === 'KeyE' && c.kb.jump === 'Space', `personalizado perdido: ${JSON.stringify(c.kb)}`);
  check(c.kb.grenade === '' && c.kb.leanRight === '', 'el choque con lo personalizado no liberó la acción por defecto');
  check(noDupes(c.kb, '') && noDupes(c.pad, -1), `migración con duplicados ${JSON.stringify(c)}`);
  check(c.pad.reload === 2 && c.pad.evade === -1, `mando personalizado: ${JSON.stringify(c.pad)}`);
  check(c.kb.evade === 'KeyK', 'se perdió la esquiva personalizada');
  // basura
  const g = migrateBindsV3('x', null);
  check(JSON.stringify(g.kb) === JSON.stringify(BIND_DEFAULTS.kb), 'v3 corrupto');
  const z = sanitizeBinds({ jump: 5, crouch: 'KeyC', nope: 'KeyQ' }, { jump: 'A', fire: 3 });
  check(z.kb.jump === 'KeyT' && z.pad.fire === 3 && z.pad.swap === -1 && noDupes(z.pad, -1), `sanitize ${JSON.stringify(z)}`);
}
// ---------- carga: migra una vez, guarda v4, deja v3 intacto ----------
{
  const store = memStore({ 'breach.binds.kb.v3': JSON.stringify({ forward: 'ArrowUp', jump: 'KeyF' }) });
  loadBinds(store);
  check(BINDS.kb.forward === 'ArrowUp' && BINDS.kb.jump === 'KeyT', 'loadBinds no migró v3');
  check(store.m.has('breach.binds.kb.v4') && store.m.has('breach.binds.kb.v3'), 'no guardó v4 o borró v3');
  check(JSON.parse(store.getItem('breach.binds.kb.v4')).evade === 'Space', 'la esquiva no se guardó');
  assignBind('kb', 'crouch', 'ArrowUp', store);
  check(BINDS.kb.crouch === 'ArrowUp' && BINDS.kb.forward === 'KeyC', `reasignar no intercambia: ${BINDS.kb.crouch}/${BINDS.kb.forward}`);
  loadBinds(store);
  check(BINDS.kb.crouch === 'ArrowUp' && BINDS.kb.forward === 'KeyC', 'v4 guardado no se relee');
  loadBinds(memStore());
  check(JSON.stringify({ ...BINDS.kb }) === JSON.stringify(BIND_DEFAULTS.kb), 'sin almacenamiento no hay defaults');
}

// La v4 anterior ya tenía salto en Espacio y recoger en X.
{
  const store = memStore({ 'breach.binds.kb.v4': '{"jump":"Space","left":"ArrowLeft"}',
    'breach.binds.pad.v4': '{"pickup":2,"swap":4,"grenade":3}' });
  loadBinds(store);
  check(BINDS.kb.evade === 'Space' && BINDS.kb.jump === 'KeyT' && BINDS.kb.left === 'ArrowLeft', 'migración del teclado v4');
  check(BINDS.pad.evade === 2 && BINDS.pad.pickup === 13 && BINDS.pad.swap === 4, 'migración del mando v4');
}

// ---------- duplicados entre dos acciones personalizadas ----------
{
  const c = migrateBindsV3({ reload: 'KeyT', melee: 'KeyT', swap: 'KeyY' }, { reload: 3, melee: 3 });
  check(noDupes(c.kb, '') && noDupes(c.pad, -1), `migración conserva duplicados personalizados: ${JSON.stringify({ kb: c.kb, pad: c.pad })}`);
  check(c.kb.reload === 'KeyT' && c.kb.melee === '' && c.pad.melee === 3 && c.pad.reload === -1, `gana la primera acción: ${JSON.stringify([c.kb.reload, c.kb.melee, c.pad.melee, c.pad.reload])}`);
  check(c.conflicts?.length === 2 && c.conflicts.some((x) => x.device === 'kb' && x.action === 'melee' && x.with === 'reload' && x.value === 'KeyT'),
    `conflictos no informados: ${JSON.stringify(c.conflicts)}`);
  const z = sanitizeBinds({ jump: 'KeyK', crouch: 'KeyK' }, {});
  check(noDupes(z.kb, '') && z.conflicts?.length === 1, `v4 guardado con duplicados: ${JSON.stringify(z)}`);
  const store = memStore({ 'breach.binds.kb.v4': JSON.stringify({ jump: 'KeyK', crouch: 'KeyK' }) });
  loadBinds(store);
  check(BINDS.kb.crouch === 'KeyK' && BINDS.kb.jump === '' && BIND_CONFLICTS.length === 1 && BIND_CONFLICTS[0].action === 'jump' && BIND_CONFLICTS[0].with === 'crouch',
    `loadBinds no resuelve/informa: ${BINDS.kb.jump} ${JSON.stringify(BIND_CONFLICTS)}`);
  loadBinds(memStore());
  check(BIND_CONFLICTS.length === 0, 'conflictos viejos no se limpian');
}

// ---------- cruceta: selección de arma frente a acciones asignadas ----------
{
  const pad = { ...BIND_DEFAULTS.pad };
  for (const b of Object.keys(PAD_DPAD_SLOTS)) check(dpadSlotFor(+b, pad) === (+b === pad.pickup ? -1 : PAD_DPAD_SLOTS[b]), `cruceta ${b} sin arma por defecto`);
  check(pad.pickup === 13, 'recoger debe tener un botón dedicado');
  const custom = { ...pad, leanLeft: 14, leanRight: 15 };
  check(dpadSlotFor(14, custom) === -1 && dpadSlotFor(15, custom) === -1 && dpadSlotFor(12, custom) === 3,
    'inclinarse en la cruceta también selecciona arma');
  // inclinación por defecto en el mando, sin chocar con la selección de arma
  check(pad.leanLeft >= 0 && pad.leanRight >= 0, `inclinación sin botón por defecto (${pad.leanLeft}/${pad.leanRight})`);
  check(padLeanContextual(pad, 'leanLeft') && padLeanContextual(pad, 'leanRight'),
    'la inclinación por defecto comparte botón sin ser contextual al ADS');
  check(!padLeanContextual({ ...pad, leanLeft: 14 }, 'leanLeft'), 'inclinación en botón propio marcada como contextual');
}

// ---------- AUDITORÍA 5: teclas gemelas y de respaldo según el binding efectivo ----------
{
  const kb = { ...BIND_DEFAULTS.kb };
  check(typeof kbMatches === 'function', 'falta kbMatches');
  const m = (code, action, map = kb) => kbMatches?.(code, action, map);
  check(m('ShiftLeft', 'sprint') && m('ShiftRight', 'sprint'), 'Shift derecho no esprinta con el binding por defecto');
  const re = { ...kb, sprint: 'KeyB' };
  check(!m('ShiftRight', 'sprint', re) && !m('ShiftLeft', 'sprint', re) && m('KeyB', 'sprint', re), 'Shift derecho esprinta tras reasignar');
  const ctrl = { ...kb, crouch: 'ControlLeft' };
  check(m('ControlRight', 'crouch', ctrl) && m('ControlLeft', 'crouch', ctrl), 'Ctrl derecho no sigue al izquierdo');
  check(m('AltRight', 'melee', { ...kb, melee: 'AltLeft' }), 'Alt derecho no sigue al izquierdo');
  // el gemelo asignado a OTRA acción es de esa acción
  const both = { ...kb, sprint: 'ShiftLeft', crouch: 'ShiftRight' };
  check(!m('ShiftRight', 'sprint', both) && m('ShiftRight', 'crouch', both), 'gemelo asignado a otra acción');
  // flechas: respaldo del movimiento solo si nadie las usa
  check(m('ArrowUp', 'forward') && m('ArrowDown', 'back'), 'flechas de respaldo');
  const arr = { ...kb, crouch: 'ArrowDown' };
  check(!m('ArrowDown', 'back', arr) && m('ArrowDown', 'crouch', arr), 'flecha asignada a otra acción también mueve');
  check(!m('KeyW', 'sprint') && !m('', 'jump', { ...kb, jump: '' }), 'coincidencias falsas');
}

// ---------- mantener / alternar ----------
{
  const l = new ToggleLatch();
  check(l.sample(true, false, 0) && !l.sample(false, false, 0.1), 'mantener');
  const t = new ToggleLatch();
  t.sample(true, true, 0); const tapOn = t.sample(false, true, 0.1);
  t.sample(true, true, 1); const tapOff = t.sample(false, true, 1.1);
  check(tapOn && !tapOff, 'alternar con toques');
  t.sample(true, true, 2); const holding = t.on; const longRelease = t.sample(false, true, 3);
  check(holding && !longRelease, 'alternar: pulsación larga actúa como mantener');
  t.sample(true, true, 4); t.sample(false, true, 4.1); t.release();
  check(!t.on, 'release no apaga el alternado');
}

// ---------- stick: radial, exterior, curva ----------
{
  const [x0, y0] = shapeStick(0.08, 0.08, { inner: 0.12 });
  check(x0 === 0 && y0 === 0, 'zona muerta radial (diagonal pequeña)');
  const [dx, dy] = shapeStick(0.5, 0.5, { inner: 0.12, outer: 0.04, curve: 1 });
  check(Math.abs(dx - dy) < 1e-12, 'la dirección diagonal se deforma');
  const [fx] = shapeStick(0.97, 0, { inner: 0.12, outer: 0.04, curve: 2 });
  check(fx === 1, `borde exterior no llega a 1 (${fx})`);
  const lin = shapeStick(0.56, 0, { inner: 0.12, outer: 0.04, curve: 1 })[0];
  const quad = shapeStick(0.56, 0, { inner: 0.12, outer: 0.04, curve: 2 })[0];
  check(quad < lin && Math.abs(quad - lin * lin) < 1e-9, 'curva de respuesta');
  let mono = true, prev = -1;
  for (let m = 0; m <= 1.0001; m += 0.01) { const v = Math.hypot(...shapeStick(m, 0, { inner: 0.1, outer: 0.05, curve: 1.6 })); if (v < prev - 1e-12) mono = false; prev = v; }
  check(mono, 'respuesta no monótona');
  check(shapeStick(NaN, undefined)[0] === 0, 'ejes no finitos');
}

// ---------- fricción de asistencia: límites ----------
{
  const eye = [0, 1.5, 0], dir = [0, 0, -1];
  const tgt = (z, x = 0, extra = {}) => ({ pos: [x, 1.5, z], radius: 0.3, ...extra });
  const base = { device: 'pad', stick: [0.5, 0], targets: [tgt(-10)], eye, dir };
  const hip = aimFriction(base), ads = aimFriction({ ...base, aim: true }), sc = aimFriction({ ...base, aim: true, scoped: true });
  check(Math.abs(hip - (1 - AIM_FRICTION.hip)) < 1e-9 && hip >= 0.649, `cadera ${hip} (tope 35 %)`);
  check(Math.abs(ads - (1 - AIM_FRICTION.ads)) < 1e-9 && ads >= 0.549, `ADS ${ads} (tope 45 %)`);
  check(sc > ads && sc < 1, `con mira debe ser menor que ADS (${sc})`);
  check(aimFriction({ ...base, device: 'keyboard' }) === 1, 'ratón/teclado recibe asistencia');
  check(aimFriction({ ...base, mouseRecent: true }) === 1, 'con ratón reciente');
  check(aimFriction({ ...base, enabled: false }) === 1, 'ajuste apagado');
  check(aimFriction({ ...base, blocked: true }) === 1, 'veto global (protección propia)');
  for (const flag of ['smoke', 'blocked', 'protected', 'ally']) {
    check(aimFriction({ ...base, targets: [tgt(-10, 0, { [flag]: true })] }) === 1, `blanco con ${flag}`);
  }
  check(aimFriction({ ...base, stick: [0.01, 0.02] }) === 1, 'actúa con el stick casi quieto');
  // factor × stick: un stick quieto sigue quieto
  check(0 * aimFriction({ ...base, stick: [0, 0] }) === 0, 'mueve un stick quieto');
  // fuera de la zona (radio angular + margen, tope 3°)
  const zoneDeg = (Math.atan(0.3 / 10) * 180 / Math.PI) + AIM_FRICTION.marginHipDeg;
  const off = (deg) => tgt(-10 * Math.cos(deg * Math.PI / 180), 10 * Math.sin(deg * Math.PI / 180));
  check(aimFriction({ ...base, targets: [off(zoneDeg + 0.05)] }) === 1, 'actúa fuera de la zona');
  const mid = aimFriction({ ...base, targets: [off(zoneDeg - AIM_FRICTION.marginHipDeg / 2)] });
  check(mid > hip && mid < 1, `sin caída suave en el margen (${mid})`);
  check(aimFriction({ ...base, targets: [tgt(-1.0)] }) >= 1 - AIM_FRICTION.hip, 'blanco cercano rompe el tope');
  const near = { ...base, targets: [{ pos: [0.3, 1.5, -1.2], radius: 0.6 }] };
  check(aimFriction({ ...near, targets: [{ pos: [Math.sin(3.2 * Math.PI / 180) * 1.2, 1.5, -Math.cos(3.2 * Math.PI / 180) * 1.2], radius: 2 }] }) === 1, 'zona > 3°');
  check(aimFriction({ ...base, targets: [tgt(-80)] }) === 1, 'más allá del alcance');
  check(aimFriction({ ...base, targets: [tgt(-30)], range: 20 }) === 1, 'más allá del alcance del arma');
  check(aimFriction({ ...base, targets: [tgt(10)] }) === 1, 'blanco detrás');
  // barrido: nunca por debajo del tope en ninguna combinación
  let minF = 1;
  for (const aim of [false, true]) for (const scoped of [false, true]) for (let a = -4; a <= 4; a += 0.1) for (const d of [2, 8, 25, 50]) {
    minF = Math.min(minF, aimFriction({ ...base, aim, scoped, targets: [off(a), tgt(-d)] }));
  }
  check(minF >= 1 - AIM_FRICTION.ads - 1e-9, `factor mínimo ${minF}`);
}

// ---------- ajustes ----------
{
  const keys = ['fov', 'fovWeapon', 'sens', 'sensAds', 'sensScope', 'invertY', 'bob', 'shake', 'reduceMotion', 'crouchToggle',
    'adsToggle', 'sprintToggle', 'autoPeek', 'aimAssist', 'padDeadzone', 'padCurve', 'padSensX', 'padSensY', 'padSensAds',
    'vibration', 'hudScale', 'hudContrast', 'reticleColor', 'reticleSize', 'reticleVisible'];
  for (const k of keys) check(k in SETTING_DEFS, `falta el ajuste ${k} (CONTRATO §6)`);
  check(SETTING_DEFS.fov.def === 72 && SETTING_DEFS.fov.min === 60 && SETTING_DEFS.fov.max === 100, 'fov 60–100 / 72');
  check(validateSetting('fov', 300) === 100 && validateSetting('fov', 'x') === 72 && validateSetting('fov', '80') === 80, 'validación numérica');
  check(validateSetting('invertY', 'true') === true && validateSetting('invertY', 'maybe') === false, 'validación booleana');
  check(validateSetting('reticleColor', 'pink') === 'white', 'validación de lista');
  check(validateSetting('fovWeapon', 90) === 50, 'fovWeapon no es fijo');
  // migración de las claves sueltas de antes
  const legacy = memStore({ 'breach.sens.mouse': '0.08', 'breach.sens.pad': '999', 'breach.sens.zoom': '0.5', 'breach.invertY': 'true' });
  loadSettings(legacy);
  check(SETTINGS.sens === 0.08 && SETTINGS.padSensX === 320 && SETTINGS.padSensY === 320 && SETTINGS.sensScope === 0.5 && SETTINGS.invertY === true,
    `migración de claves sueltas: ${JSON.stringify({ s: SETTINGS.sens, p: SETTINGS.padSensX, z: SETTINGS.sensScope, i: SETTINGS.invertY })}`);
  // notificación y persistencia
  const seen = [];
  const off = onSettingChange((k, v, p) => seen.push([k, v, p]));
  check(setSetting('fov', 85) === 85 && setSetting('fov', 85) === 85, 'setSetting');
  check(seen.length === 1 && seen[0][0] === 'fov' && seen[0][2] === 72, `notificación ${JSON.stringify(seen)}`);
  check(setSetting('nope', 1) === undefined, 'clave desconocida');
  check(JSON.parse(legacy.getItem('breach.settings.v1')).fov === 85, 'no persiste');
  loadSettings(legacy);
  check(SETTINGS.fov === 85 && SETTINGS.sens === 0.08, 'no relee lo guardado');
  loadSettings(memStore({ 'breach.settings.v1': '{"fov":"garbage","padCurve":9}' }));
  check(SETTINGS.fov === 72 && SETTINGS.padCurve === 3, 'guardado corrupto');
  // sensibilidad efectiva y reflejo en TUNING
  setSetting('sensAds', 0.5); setSetting('sensScope', 0.6); setSetting('padSensY', 100);
  const m = lookSensitivity('mouse', { aim: true, scoped: true });
  check(Math.abs(m.x - SETTINGS.sens * 0.5 * 0.6) < 1e-12, 'sensibilidad ADS/mira de ratón');
  const pd = lookSensitivity('pad', { aim: false });
  check(pd.x === SETTINGS.padSensX && pd.y === 100, 'sensibilidad X/Y del mando');
  const T = { cam: {} };
  const unbind = bindTuning(T);
  setSetting('sens', 0.05);
  check(T.cam.sens === 0.05 && T.cam.zoomSens === 0.6, 'bindTuning no refleja');
  unbind(); off();
  resetSettings();
  check(SETTINGS.sens === SETTING_DEFS.sens.def && SETTINGS.fov === 72, 'reset');
}

if (failures.length) {
  console.error(`FPS CONTROLS FAIL (${failures.length})\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('FPS CONTROLS OK — acciones FPS, migración v3→v4 sin duplicados, mantener/alternar, stick radial+exterior+curva, límites de la fricción, ajustes');
