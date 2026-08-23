// Input unificado: teclado + ratón (pointer lock) + gamepad, con bindings
// configurables (BINDS). Y invertido por default (preferencia de Chuck),
// toggle F9 persistido en localStorage.
import { BINDS, PAD_DPAD_SLOTS } from './bindings.js';
import { PadInput } from './gamepad.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pad = new PadInput();
    this.mouseDX = 0; this.mouseDY = 0;
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
    this.evadePressed = false;
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.swapPressed = false;
    this.meleePressed = false;
    this.slotPressed = -1;   // índice de slot pedido por selección directa (1-4 / d-pad)
    this.cycleDir = 0;       // ±1 por muesca de la rueda del mouse
    this._wheelAcc = 0;
    this.locked = false;
    this.suppress = false; // true con el menú abierto: los inputs de juego se ignoran
    this.onLockedMouseDown = null;
    this.onLockedMouseUp = null;
    // invert Y separado por dispositivo (ambos default ON, preferencia de Chuck)
    this.invertY = localStorage.getItem('breach.invertY') !== 'false';       // ratón (F9)
    this.invertYPad = localStorage.getItem('breach.invertYPad') !== 'false'; // control
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
      // con ?nolock el juego opera SIN lock: el click va directo al gameplay
      if (!this.locked && !this.lockDisabled) { this.requestLock(); return; }
      // el cursor virtual del menú consume el click (pausa con lock activo)
      if (this.onLockedMouseDown?.(e.button)) return;
      if (e.button === 0) { this._mouseFire = true; this.firePressed = true; }
      if (e.button === 2) this._mouseAim = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.onLockedMouseUp?.(e.button);
      if (e.button === 0) this._mouseFire = false;
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
      // Chromium puede entregar un último movementX/Y del cursor anterior o
      // del warp de recaptura. Ignorarlo evita saltos de cámara al pausar.
      this.discardLookDelta(1);
      if (!this.locked) {
        this._mouseFire = false; this._mouseAim = false;
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
      this.keys.clear();
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
    if (this.lockDisabled || this.suppress) return;
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

  _key(e, down) {
    if (e.repeat) return;
    const c = e.code;
    // Escape SIEMPRE funciona, incluso con el foco en un input de texto
    // (si no, enfocar el campo "Nombre" mataba la pausa para siempre)
    if (down && c === 'Escape') {
      if (e.target && e.target.tagName === 'INPUT') e.target.blur();
      this.onEscape?.();
      return;
    }
    if (e.target && e.target.tagName === 'INPUT') return; // escribiendo en el menú
    if (c === BINDS.kb.score && (this.locked || this.lockDisabled)) e.preventDefault(); // Tab no cicla el foco
    if (down) {
      if (c === 'F9') {
        e.preventDefault();
        this.invertY = !this.invertY;
        localStorage.setItem('breach.invertY', String(this.invertY));
        this.onInvertChanged?.(this.invertY);
        return;
      }
      if (c === 'F10') { e.preventDefault(); this.onToggleTuning?.(); return; }
      if (c === 'KeyM') { this.onToggleMute?.(); }
      // (Escape ya se atendió arriba con return: NO repetir onEscape aquí,
      // duplicarlo togglearía el menú dos veces en el mismo keydown)
      if (!this.locked && !this.lockDisabled) return;
      this.keys.add(c);
      if (c === BINDS.kb.evade) this.evadePressed = true;
      if (c === BINDS.kb.jump) this.jumpPressed = true;
      if (c === BINDS.kb.reload) this.reloadPressed = true;
      if (c === BINDS.kb.swap) this.swapPressed = true;
      if (c === BINDS.kb.melee) this.meleePressed = true;
      if (c === BINDS.kb.slot1) this.slotPressed = 0;
      if (c === BINDS.kb.slot2) this.slotPressed = 1;
      if (c === BINDS.kb.slot3) this.slotPressed = 2;
      if (c === BINDS.kb.slot4) this.slotPressed = 3;
    } else {
      this.keys.delete(c);
    }
  }

  // Poll del gamepad, una vez por frame de render. gameplay=false ignora
  // todo menos el botón de pausa (menú abierto).
  pollPad(dt, gameplay) {
    const wasFire = this.pad.fireHeld;
    this.pad.poll(dt);
    // durante un rebind, el botón de pausa actual no debe cerrar el menú
    if (!this.rebinding && this.pad.justPressed.has(BINDS.pad.pause)) this.onEscape?.();
    if (!gameplay) return;
    if (this.pad.justPressed.has(BINDS.pad.evade)) this.evadePressed = true;
    if (this.pad.justPressed.has(BINDS.pad.jump)) this.jumpPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.reload)) this.reloadPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.melee)) this.meleePressed = true;
    for (const btn in PAD_DPAD_SLOTS) {
      if (this.pad.justPressed.has(+btn)) this.slotPressed = PAD_DPAD_SLOTS[btn];
    }
    if (!wasFire && this.pad.fireHeld) this.firePressed = true;
  }

  get fireHeld() { return !this.suppress && (this._mouseFire || this.pad.fireHeld); }
  get aimHeld() { return !this.suppress && (this._mouseAim || this.pad.aimHeld); }
  get sprintHeld() {
    if (this.suppress) return false;
    return this.keys.has(BINDS.kb.sprint) || this.keys.has('ShiftRight') || this.pad.sprintHeld;
  }
  get anyDevice() { return this.locked || this.lockDisabled || this.pad.connected; }
  get scoreHeld() {
    return this.keys.has(BINDS.kb.score) || this.pad.pressed.has(BINDS.pad.score);
  }

  // Vector de movimiento (x = derecha, z = adelante); teclado manda, si no, stick
  moveVec() {
    if (this.suppress) return { x: 0, z: 0 };
    let x = 0, z = 0;
    if (this.keys.has(BINDS.kb.forward)) z += 1;
    if (this.keys.has(BINDS.kb.back)) z -= 1;
    if (this.keys.has(BINDS.kb.left)) x -= 1;
    if (this.keys.has(BINDS.kb.right)) x += 1;
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
    this.evadePressed = false;
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
