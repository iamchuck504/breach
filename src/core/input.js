// Input unificado: teclado + ratón (pointer lock) + gamepad, con bindings
// configurables (BINDS). Eje Y normal por defecto; la inversión (F9 o
// Opciones → Controles) vive en los ajustes (settings.js). Agacharse, ADS y
// sprint pueden ser "mantener" o "alternar" según los ajustes.
import { BINDS, PAD_DPAD_SLOTS, dpadSlotFor, padLeanContextual, kbMatches } from './bindings.js';
import { PadInput } from './gamepad.js';
import { SETTINGS, setSetting, onSettingChange } from './settings.js';

// Pura (probada en Node): convierte un botón físico en la intención
// "mantenida" según el modo. Alternar es híbrido: un toque alterna, pero una
// pulsación larga (> HOLD_S) se comporta como mantener y se suelta al soltar.
const HOLD_S = 0.35;
export class ToggleLatch {
  constructor() { this.on = false; this._raw = false; this._downAt = 0; this._wasOn = false; }
  // raw: botón físico abajo · toggle: modo alternar · now: segundos
  sample(raw, toggle, now) {
    raw = !!raw;
    if (!toggle) { this.on = raw; this._raw = raw; return this.on; }
    if (raw && !this._raw) { this._downAt = now; this._wasOn = this.on; this.on = true; }
    if (!raw && this._raw) {
      // toque corto: alterna respecto de como estaba; largo: era "mantener"
      const held = now - this._downAt;
      this.on = held <= HOLD_S ? !this._wasOn : false;
    }
    this._raw = raw;
    return this.on;
  }
  release() { this.on = false; this._wasOn = false; }
}
const nowS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

// macOS no emite keyup de las teclas soltadas mientras Cmd está abajo (en
// Windows/Linux sí): solo ahí hace falta limpiar al soltar Cmd.
const MAC_KEYS = /Mac|iPhone|iPad/i.test(
  (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform)) || '');
const isMeta = (c) => c === 'MetaLeft' || c === 'MetaRight' || c === 'OSLeft' || c === 'OSRight';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.lastDevice = 'keyboard';
    this.pad = new PadInput();
    this.mouseDX = 0; this.mouseDY = 0;
    this.lastMouseAt = -Infinity; // ms del último movimiento de ratón de juego
    // El cursor virtual del menú y la cámara reciben los mismos eventos de
    // pointer-lock, pero nunca deben consumir el mismo delta al cambiar de
    // contexto. Este guard absorbe el frame de transición/re-lock.
    this._lookGuardFrames = 0;
    // Chromium/Windows puede entregar el warp de recaptura varios frames
    // después del pointerlockchange. El primer movimiento posterior a una
    // transición se consume por evento, no por tiempo, para que un outlier
    // tardío nunca llegue a la cámara.
    this._discardNextLookMotion = false;
    this._mouseFire = false; this._mouseAim = false;
    this.firePressed = false;
    // flanco de suelta del gatillo: una suelta y re-pulsación entre dos pasos
    // de simulación no se ve en fireHeld; se retiene hasta el paso siguiente
    // para que el arma descarte su crédito de cadencia
    this.fireReleased = false;
    this.evadePressed = false;
    this.pickupPressed = false;
    this.crouchPressed = false;   // flanco: agacharse (deslizar si se va en sprint)
    this.grenadePressed = false;  // flanco: granada rápida
    this.swapPrevPressed = false; // flanco: arma anterior
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.swapPressed = false;
    this.meleePressed = false;
    this.slotPressed = -1;   // índice de slot pedido por selección directa (1-4 / d-pad)
    this.cycleDir = 0;       // ±1 por muesca de la rueda del mouse
    this._wheelAcc = 0;
    this.locked = false;
    this.suppress = false; // true con el menú abierto: los inputs de juego se ignoran
    // Presentación previa a la ronda (intro / cuenta regresiva): el gameplay
    // sigue suprimido pero el cursor SÍ se captura, para que al dar la salida
    // ratón y teclado ya respondan.
    this.presentation = false;
    this.heldRaw = new Set(); // teclas físicamente mantenidas, haya o no captura
    // macOS: teclas ya mantenidas cuando bajó Cmd. Si se sueltan con Cmd
    // abajo su keyup no llega; al soltar Cmd se descartan (un repeat posterior
    // las restaura si de verdad siguen pulsadas).
    this._metaSuspects = null;
    this.macKeys = MAC_KEYS;
    this.onAnyPress = null; // main: saltar la presentación (tecla/click/botón)
    this.onLockedMouseDown = null;
    this.onLockedMouseUp = null;
    // invert Y separado por dispositivo. Por defecto NO invertido (lo que
    // espera un jugador nuevo); quien lo prefiera invertido lo activa una vez
    // y queda guardado en su navegador.
    this.invertY = SETTINGS.invertY;       // ratón (F9)
    this.invertYPad = SETTINGS.invertYPad; // control
    this._crouch = new ToggleLatch();
    this._aim = new ToggleLatch();
    this._sprint = new ToggleLatch();
    onSettingChange((k, v) => {
      if (k === 'invertY') this.invertY = v;
      if (k === 'invertYPad') this.invertYPad = v;
      if (k === 'crouchToggle') this._crouch.release();
      if (k === 'adsToggle') this._aim.release();
      if (k === 'sprintToggle') this._sprint.release();
    });
    this.kbLocked = false;  // main: true si navigator.keyboard.lock fue CONCEDIDO
    this.rebinding = false; // main: true durante un rebind (Esc/botón pausa no actúan)
    // ?nolock=1 (suites headless): JAMÁS pedir pointer lock — MEDIDO: hasta un
    // Chromium headless SIN lock concedido pone un ClipCursor REAL en Windows
    // y confina el mouse físico de quien esté usando la máquina
    this.lockDisabled = new URLSearchParams(location.search).has('nolock');
    this.onToggleTuning = null;
    this.onToggleMute = null;
    this.onEscape = null;
    this.onInvertChanged = null;

    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    canvas.addEventListener('mousedown', (e) => {
      this.lastDevice = 'keyboard';
      // con ?nolock el juego opera SIN lock: el click va directo al gameplay
      if (!this.locked && !this.lockDisabled) { this.onAnyPress?.('mouse'); this.requestLock(); return; }
      // el cursor virtual del menú consume el click (pausa con lock activo)
      if (this.suppress && this.presentation) this.onAnyPress?.('mouse'); // saltar la presentación
      if (this.onLockedMouseDown?.(e.button)) return;
      if (e.button === 0) { this._mouseFire = true; this.firePressed = true; }
      if (e.button === 2) this._mouseAim = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.onLockedMouseUp?.(e.button);
      if (e.button === 0) { if (this._mouseFire) this.fireReleased = true; this._mouseFire = false; }
      if (e.button === 2) this._mouseAim = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked && !this.lockDisabled) return;
      const dx = Number.isFinite(e.movementX) ? e.movementX : 0;
      const dy = Number.isFinite(e.movementY) ? e.movementY : 0;
      if (dx === 0 && dy === 0) return;
      if (this._discardNextLookMotion) {
        this._discardNextLookMotion = false;
        return;
      }
      this.mouseDX += dx;
      this.mouseDY += dy;
      // la fricción de asistencia se apaga con ratón reciente (DECISIONES §6)
      this.lastMouseAt = performance.now();
    });
    // Rueda del mouse = ciclar arma. Acumula deltas (trackpads reportan pasos
    // chicos) y emite un edge por muesca; el scroll del menú no pasa por aquí
    // porque con el menú abierto no hay lock y suppress corta el consumo.
    window.addEventListener('wheel', (e) => {
      if (!this.locked && !this.lockDisabled) return;
      if (this.suppress) return;
      this._wheelAcc += e.deltaY;
      while (this._wheelAcc >= 60) { this.cycleDir += 1; this._wheelAcc -= 60; }
      while (this._wheelAcc <= -60) { this.cycleDir -= 1; this._wheelAcc += 60; }
      if (Math.abs(this.cycleDir) > 2) this.cycleDir = Math.sign(this.cycleDir) * 2;
    }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      // Teclas que ya venían mantenidas cuando llegó la captura (p. ej. W
      // sostenida durante la cuenta regresiva): cuentan desde este instante.
      // Sin esto había que soltarlas y volver a pulsarlas (keydown repetido
      // se ignora) y el personaje arrancaba la ronda clavado.
      // heldRaw es estado físico veraz (down/up balanceados, limpio en blur
      // y en los acordes de Cmd de macOS): se importa entero, sin flancos.
      if (this.locked) for (const code of this.heldRaw) this.keys.add(code);
      // Chromium puede entregar un último movementX/Y del cursor anterior o
      // del warp de recaptura. Ignorarlo evita saltos de cámara al pausar.
      this.discardLookDelta(1);
      if (!this.locked) {
        this._mouseFire = false; this._mouseAim = false;
        this.resetToggles(); // sin captura no queda un ADS/agachado alternado pegado
        this.keys.clear();
        this.consumeEdges();               // sin edges fantasma al des-lockear
      }
    });
    // MEDIDO en la máquina de Chuck (scripts/diag-clip.mjs): la salida
    // PROGRAMÁTICA (exitPointerLock) limpia el ClipCursor de Windows
    // correctamente; el camino interno del navegador (Esc real / blur) es el
    // que a veces lo deja pegado con la escala 125%. Estrategia: salir
    // SIEMPRE nosotros primero, por el camino limpio.
    this.cleanExitAt = 0; // marca de exits limpios (con foco): no necesitan saneo
    window.addEventListener('keydown', (e) => {
      // salir programáticamente ANTES que el navegador (camino limpio medido),
      // salvo en fullscreen con keyboard.lock CONFIRMADO (ahí Esc es nuestro)
      // o durante un rebind (Esc solo cancela el rebind, no suelta el lock)
      if (e.code === 'Escape' && this.locked && !this.rebinding &&
          !(document.fullscreenElement && this.kbLocked)) {
        this.cleanExitAt = performance.now();
        try { document.exitPointerLock(); } catch { /* ok */ }
      }
    }, true);
    const onFocusLoss = () => {
      if (this.locked) { try { document.exitPointerLock(); } catch { /* ok */ } }
      this._mouseFire = false; this._mouseAim = false;
      this.resetToggles();
      this.keys.clear();
      this.heldRaw.clear();
      this.onFocusLost?.();
    };
    window.addEventListener('blur', onFocusLoss);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onFocusLoss();
    });
    // cerrar/navegar la pestaña con el lock puesto era un exit sucio SIN
    // reparación posible (la página muere y nadie sanea): soltar antes, limpio
    const onUnload = () => {
      if (this.locked) { try { document.exitPointerLock(); } catch { /* ok */ } }
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
  }

  // Siempre pointer lock PLANO: el modo raw input (unadjustedMovement) se
  // eliminó por completo — es el camino con el bug de ClipCursor en Windows.
  requestLock() {
    // Menús, presentaciones y el editor mantienen suppress=true. Nunca deben
    // recapturar el cursor al hacer clic en el canvas; el editor procesa ese
    // mismo evento con sus propios controles de selección/arrastre.
    if (this.lockDisabled || (this.suppress && !this.presentation)) return;
    this.captureAt = performance.now();
    try {
      const q = this.canvas.requestPointerLock();
      if (q && q.catch) q.catch(() => {});
    } catch { /* sin gesto: el keeper de main reintenta, o el click al canvas */ }
  }
  releaseLock() {
    if (this.locked) {
      this.cleanExitAt = performance.now(); // exit propio con foco = limpio
      document.exitPointerLock();
    }
  }

  // Captura pedida DENTRO del gesto que arranca la partida (click en START):
  // pasados 13 s el navegador ya no la concede sin un gesto nuevo.
  captureNow() {
    if (this.lockDisabled || this.locked) return;
    this.captureAt = performance.now();
    try {
      const q = this.canvas.requestPointerLock();
      if (q && q.catch) q.catch(() => {});
    } catch { /* sin soporte */ }
  }

  // Olvidar todo lo mantenido (cambio de fase/foco): solo cuenta lo que se
  // pulse a partir de ahora.
  clearHeld() {
    this.keys.clear(); this.heldRaw.clear(); this._metaSuspects = null;
    this._mouseFire = false; this._mouseAim = false;
    this.resetToggles();
    this.consumeEdges();
  }

  _key(e, down) {
    const c = e.code;
    if (down) this.lastDevice = 'keyboard';
    // keyup SIEMPRE se procesa (aunque el foco esté en un campo de texto): un
    // keyup descartado deja la tecla "pulsada" para siempre
    if (!down) {
      this.keys.delete(c);
      this.heldRaw.delete(c);
      this._metaSuspects?.delete(c);
      if (isMeta(c) && this._metaSuspects) {
        // macOS: lo que se mantenía al bajar Cmd y no avisó su keyup pudo
        // soltarse sin aviso (Cmd+W, Cmd+Tab…): fuera
        for (const k of this._metaSuspects) { this.keys.delete(k); this.heldRaw.delete(k); }
        this._metaSuspects = null;
      }
      return;
    }
    if (isMeta(c)) {
      if (this.macKeys && !e.repeat) this._metaSuspects = new Set(this.heldRaw);
      return;
    }
    // Cmd/Win+tecla es un atajo del sistema/navegador, no un movimiento (en
    // macOS además su keyup nunca llegaría)
    if (e.metaKey) return;
    if (e.repeat) {
      // auto-repeat = la tecla sigue físicamente abajo: restaura el estado
      // mantenido si algo lo había descartado, pero NUNCA dispara acciones
      if (e.target && e.target.tagName === 'INPUT') return;
      if (c === 'Escape' || /^F\d/.test(c)) return;
      this.heldRaw.add(c);
      this._metaSuspects?.delete(c);
      if (this.locked || this.lockDisabled) this.keys.add(c);
      return;
    }
    if (!/^(Shift|Control|Alt|Meta|OS)/.test(c)) this.pad.disarm?.(); // el teclado manda: el pad vuelve a reposo
    // Escape SIEMPRE funciona, incluso con el foco en un input de texto
    // (si no, enfocar el campo "Nombre" mataba la pausa para siempre)
    if (down && c === 'Escape') {
      if (e.target && e.target.tagName === 'INPUT') e.target.blur();
      this.onEscape?.();
      return;
    }
    if (e.target && e.target.tagName === 'INPUT') return; // escribiendo en el menú
    if (kbMatches(c, 'score') && (this.locked || this.lockDisabled)) e.preventDefault(); // Tab no cicla el foco
    if (down) {
      if (c === 'F9') {
        e.preventDefault();
        this.invertY = setSetting('invertY', !this.invertY);
        this.onInvertChanged?.(this.invertY);
        return;
      }
      if (c === 'F10') { e.preventDefault(); this.onToggleTuning?.(); return; }
      if (c === 'KeyM') { this.onToggleMute?.(); }
      // (Escape ya se atendió arriba con return: NO repetir onEscape aquí,
      // duplicarlo togglearía el menú dos veces en el mismo keydown)
      this.heldRaw.add(c); // estado físico, con o sin captura (ver pointerlockchange)
      if (c !== 'F9' && c !== 'F10' && c !== 'KeyM' && !/^F\d/.test(c)) this.onAnyPress?.('key');
      if (!this.locked && !this.lockDisabled) {
        // jugando sin captura: la tecla es un gesto válido para pedirla ya
        // (antes el keeper la pedía hasta 1.6 s después y el personaje
        // arrancaba solo con la tecla que se pulsó antes)
        this.requestLock();
        return;
      }
      this.keys.add(c);
      if (kbMatches(c, 'evade')) this.evadePressed = true;
      if (kbMatches(c, 'pickup')) this.pickupPressed = true;
      if (kbMatches(c, 'crouch')) this.crouchPressed = true;
      if (kbMatches(c, 'grenade')) this.grenadePressed = true;
      if (kbMatches(c, 'swapPrev')) this.swapPrevPressed = true;
      if (kbMatches(c, 'jump')) this.jumpPressed = true;
      if (kbMatches(c, 'reload')) this.reloadPressed = true;
      if (kbMatches(c, 'swap')) this.swapPressed = true;
      if (kbMatches(c, 'melee')) this.meleePressed = true;
      if (kbMatches(c, 'slot1')) this.slotPressed = 0;
      if (kbMatches(c, 'slot2')) this.slotPressed = 1;
      if (kbMatches(c, 'slot3')) this.slotPressed = 2;
      if (kbMatches(c, 'slot4')) this.slotPressed = 3;
    }
  }

  // Poll del gamepad, una vez por frame de render. gameplay=false ignora
  // todo menos el botón de pausa (menú abierto).
  pollPad(dt, gameplay) {
    const wasFire = this.pad.fireHeld;
    this.pad.poll(dt);
    // cualquier stick armado cuenta (jugar solo con el derecho también es
    // "usar el control": prompts del pad y sin aviso de "clic para jugar")
    if (this.pad.justPressed.size || Math.hypot(this.pad.moveX || 0, this.pad.moveZ || 0) > 0.25 ||
        Math.hypot(this.pad.camX || 0, this.pad.camY || 0) > 0.06) this.lastDevice = 'pad';
    // durante un rebind, el botón de pausa actual no debe cerrar el menú
    if (!this.rebinding && this.pad.justPressed.has(BINDS.pad.pause)) this.onEscape?.();
    else if (this.pad.justPressed.size) this.onAnyPress?.('pad');
    if (!gameplay) return;
    // Inclinación contextual (botón compartido con sprint/agacharse): solo
    // apuntando, como alternar. Un botón pulsado apuntando queda "enmascarado"
    // hasta soltarlo: no agacha ni esprinta.
    this._padMask ??= new Set();
    for (const b of [...this._padMask]) if (!this.pad.pressed.has(b)) this._padMask.delete(b);
    const aiming = this.aimHeld;
    if (aiming) {
      for (const [act, side] of [['leanLeft', -1], ['leanRight', 1]]) {
        const b = BINDS.pad[act];
        if (padLeanContextual(BINDS.pad, act) && this.pad.justPressed.has(b)) {
          this._padLean = this._padLean === side ? 0 : side;
          this._padMask.add(b);
        }
      }
    } else this._padLean = 0;
    const jp = (action) => BINDS.pad[action] >= 0 && this.pad.justPressed.has(BINDS.pad[action]) &&
      !this._padMask.has(BINDS.pad[action]);
    if (jp('evade')) this.evadePressed = true;
    if (jp('pickup')) this.pickupPressed = true;
    if (jp('crouch')) this.crouchPressed = true;
    if (jp('grenade')) this.grenadePressed = true;
    if (jp('swap')) this.swapPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.jump)) this.jumpPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.reload)) this.reloadPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.melee)) this.meleePressed = true;
    // la cruceta elige arma salvo que el jugador le haya dado otra acción
    for (const btn in PAD_DPAD_SLOTS) {
      const slot = dpadSlotFor(+btn, BINDS.pad);
      if (slot >= 0 && this.pad.justPressed.has(+btn)) this.slotPressed = slot;
    }
    if (!wasFire && this.pad.fireHeld) this.firePressed = true;
    if (wasFire && !this.pad.fireHeld) this.fireReleased = true;
  }

  keyForAction(action) { return BINDS.kb[action]; }

  // ¿alguna tecla que cuenta para esta acción (binding, gemelo libre o
  // flecha de respaldo libre) está mantenida?
  _kbHeld(action) {
    for (const k of this.keys) if (kbMatches(k, action)) return true;
    return false;
  }
  get fireHeld() { return !this.suppress && (this._mouseFire || this.pad.fireHeld); }
  // ADS / sprint / agacharse: intención efectiva (mantener o alternar)
  get aimHeld() {
    const on = this._aim.sample(this._mouseAim || this.pad.aimHeld, SETTINGS.adsToggle, nowS());
    return !this.suppress && on;
  }
  get sprintHeld() {
    const raw = this._kbHeld('sprint') ||
      (this.pad.sprintHeld && !this._padMask?.has(BINDS.pad.sprint));
    const on = this._sprint.sample(raw, SETTINGS.sprintToggle, nowS());
    // sprint alternado se apaga al dejar de moverse
    if (on && SETTINGS.sprintToggle && !this.suppress) {
      const mv = this.moveVec();
      if (Math.hypot(mv.x, mv.z) < 0.1) { this._sprint.release(); return false; }
    }
    return !this.suppress && on;
  }
  get crouchHeld() {
    const raw = this._kbHeld('crouch') || (this.pad.crouchHeld && !this._padMask?.has(BINDS.pad.crouch));
    const on = this._crouch.sample(raw, SETTINGS.crouchToggle, nowS());
    return !this.suppress && on;
  }
  // inclinación pedida: -1 izquierda, +1 derecha, 0 ninguna (ambas = 0)
  get leanAxis() {
    if (this.suppress) return 0;
    // mando: en botón propio se mantiene; compartido, alternar solo en ADS
    const l = this._kbHeld('leanLeft') || (this.pad.leanLeftHeld && !padLeanContextual(BINDS.pad, 'leanLeft'));
    const r = this._kbHeld('leanRight') || (this.pad.leanRightHeld && !padLeanContextual(BINDS.pad, 'leanRight'));
    const kb = (r ? 1 : 0) - (l ? 1 : 0);
    return kb || this._padLean || 0;
  }
  // El controller apaga un alternado cuando la acción termina por otra causa
  // (saltar o sprintar levanta al agachado; disparar corta el sprint…).
  releaseToggle(name) {
    if (name === 'crouch') this._crouch.release();
    else if (name === 'aim') this._aim.release();
    else if (name === 'sprint') this._sprint.release();
  }
  resetToggles() { this._crouch.release(); this._aim.release(); this._sprint.release(); this._padLean = 0; }
  // ¿hubo ratón de juego en el último `ms`? (veto de la asistencia de mando)
  mouseRecent(ms = 1000) { return performance.now() - this.lastMouseAt < ms; }
  get anyDevice() { return this.locked || this.lockDisabled || this.pad.connected; }
  get scoreHeld() {
    return this._kbHeld('score') || this.pad.pressed.has(BINDS.pad.score);
  }

  // Vector de movimiento (x = derecha, z = adelante); teclado manda, si no, stick
  moveVec() {
    if (this.suppress) return { x: 0, z: 0 };
    let x = 0, z = 0;
    // Steam Desktop Layout puede duplicar el stick izquierdo como flechas.
    // Aceptarlas como fallback no altera los binds configurables ni duplica el
    // movimiento (el vector se normaliza), pero evita quedar inmóvil si Steam
    // temporalmente publica teclado antes que su gamepad virtual.
    if (this._kbHeld('forward')) z += 1;
    if (this._kbHeld('back')) z -= 1;
    if (this._kbHeld('left')) x -= 1;
    if (this._kbHeld('right')) x += 1;
    let len = Math.hypot(x, z);
    if (len === 0 && this.pad.connected) {
      x = this.pad.moveX; z = this.pad.moveZ;
      len = Math.hypot(x, z);
      if (len < 0.25) return { x: 0, z: 0 };
    }
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  // Flancos: consumir tras CADA paso de simulación (evita doble-evade si un
  // frame de render ejecuta dos pasos de física)
  consumeEdges() {
    this.firePressed = false;
    this.fireReleased = false;
    this.evadePressed = false;
    this.pickupPressed = false;
    this.crouchPressed = false;
    this.grenadePressed = false;
    this.swapPrevPressed = false;
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.swapPressed = false;
    this.meleePressed = false;
    this.slotPressed = -1;
    this.cycleDir = 0;
  }

  // Deltas de ratón: consumir una vez por frame de render
  discardLookDelta(guardFrames = 1, discardNextMotion = true) {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this._lookGuardFrames = Math.max(this._lookGuardFrames, guardFrames);
    if (discardNextMotion) this._discardNextLookMotion = true;
  }

  // La UI conserva los deltas crudos para su cursor virtual. Gameplay usa
  // estos getters, que silencian solamente el frame de transición.
  get lookDX() { return this._lookGuardFrames > 0 ? 0 : this.mouseDX; }
  get lookDY() { return this._lookGuardFrames > 0 ? 0 : this.mouseDY; }

  endFrame() {
    this.mouseDX = 0; this.mouseDY = 0;
    if (this._lookGuardFrames > 0) this._lookGuardFrames--;
  }
}
