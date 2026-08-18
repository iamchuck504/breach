// Input unificado: teclado + ratón (pointer lock) + gamepad, con bindings
// configurables (BINDS). Y invertido por default (preferencia de Chuck),
// toggle F9 persistido en localStorage.
import { BINDS } from './bindings.js';
import { PadInput } from './gamepad.js';

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pad = new PadInput();
    this.mouseDX = 0; this.mouseDY = 0;
    this._mouseFire = false; this._mouseAim = false;
    this.firePressed = false;
    this.evadePressed = false;
    this.jumpPressed = false;
    this.reloadPressed = false;
    this.swapPressed = false;
    this.locked = false;
    // invert Y separado por dispositivo (ambos default ON, preferencia de Chuck)
    this.invertY = localStorage.getItem('breach.invertY') !== 'false';       // ratón (F9)
    this.invertYPad = localStorage.getItem('breach.invertYPad') !== 'false'; // control
    // raw input (unadjustedMovement): OFF por default — en Chrome/Windows
    // tiene un bug que deja el cursor confinado a una región tras des-lockear
    this.rawInput = localStorage.getItem('breach.rawInput') === 'true';
    this.onToggleTuning = null;
    this.onToggleMute = null;
    this.onEscape = null;
    this.onInvertChanged = null;

    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this._mouseFire = true; this.firePressed = true; }
      if (e.button === 2) this._mouseAim = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseFire = false;
      if (e.button === 2) this._mouseAim = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this._mouseFire = false; this._mouseAim = false; this.keys.clear(); }
    });
    // Al perder el foco (alt-tab / otra ventana) hay que SOLTAR el pointer
    // lock explícitamente: si queda vivo, Windows deja el cursor confinado
    // a la región de la ventana ("atrapado en un cuadrante").
    const dropLock = () => {
      this.releaseLock();
      this._mouseFire = false; this._mouseAim = false;
      this.keys.clear();
      this.onFocusLost?.();
    };
    window.addEventListener('blur', dropLock);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') dropLock();
    });
  }

  // unadjustedMovement: sin aceleración de mouse del OS (si el navegador lo soporta)
  requestLock() {
    const plain = () => {
      try {
        const q = this.canvas.requestPointerLock();
        if (q && q.catch) q.catch(() => {});
      } catch { /* sin gesto de usuario: se re-lockea al clickear el canvas */ }
    };
    if (!this.rawInput) { plain(); return; }
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      // reintentar SOLO si el navegador no soporta unadjustedMovement;
      // otros errores (falta de gesto, cooldown de Esc) no deben re-pedir
      if (p && p.catch) p.catch((e) => {
        if (e && e.name === 'NotSupportedError') plain();
      });
    } catch { plain(); }
  }
  releaseLock() { if (this.locked) document.exitPointerLock(); }

  _key(e, down) {
    if (e.repeat) return;
    if (e.target && e.target.tagName === 'INPUT') return; // escribiendo en el menú
    const c = e.code;
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
      if (c === 'Escape') { this.onEscape?.(); }
      if (!this.locked) return;
      this.keys.add(c);
      if (c === BINDS.kb.evade) this.evadePressed = true;
      if (c === BINDS.kb.jump) this.jumpPressed = true;
      if (c === BINDS.kb.reload) this.reloadPressed = true;
      if (c === BINDS.kb.swap) this.swapPressed = true;
    } else {
      this.keys.delete(c);
    }
  }

  // Poll del gamepad, una vez por frame de render. gameplay=false ignora
  // todo menos el botón de pausa (menú abierto).
  pollPad(dt, gameplay) {
    const wasFire = this.pad.fireHeld;
    this.pad.poll(dt);
    if (this.pad.justPressed.has(BINDS.pad.pause)) this.onEscape?.();
    if (!gameplay) return;
    if (this.pad.justPressed.has(BINDS.pad.evade)) this.evadePressed = true;
    if (this.pad.justPressed.has(BINDS.pad.jump)) this.jumpPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.reload)) this.reloadPressed = true;
    if (this.pad.justPressed.has(BINDS.pad.swap)) this.swapPressed = true;
    if (!wasFire && this.pad.fireHeld) this.firePressed = true;
  }

  get fireHeld() { return this._mouseFire || this.pad.fireHeld; }
  get aimHeld() { return this._mouseAim || this.pad.aimHeld; }
  get sprintHeld() {
    return this.keys.has(BINDS.kb.sprint) || this.keys.has('ShiftRight') || this.pad.sprintHeld;
  }
  get anyDevice() { return this.locked || this.pad.connected; }

  // Vector de movimiento (x = derecha, z = adelante); teclado manda, si no, stick
  moveVec() {
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
  }

  // Deltas de ratón: consumir una vez por frame de render
  endFrame() {
    this.mouseDX = 0; this.mouseDY = 0;
  }
}
