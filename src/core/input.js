// Teclado + ratón con pointer lock. Y invertido por default (preferencia de Chuck),
// toggle F9 persistido en localStorage.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.fireHeld = false; this.firePressed = false;
    this.aimHeld = false;
    this.evadePressed = false;
    this.reloadPressed = false;
    this.swapPressed = false;
    this.locked = false;
    this.invertY = localStorage.getItem('breach.invertY') !== 'false'; // default ON
    this.onToggleTuning = null;
    this.onToggleMute = null;
    this.onEscape = null;

    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this.fireHeld = true; this.firePressed = true; }
      if (e.button === 2) this.aimHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.aimHeld = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.fireHeld = false; this.aimHeld = false; this.keys.clear(); }
    });
  }

  // unadjustedMovement: sin aceleración de mouse del OS (si el navegador lo soporta)
  requestLock() {
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch {
      this.canvas.requestPointerLock();
    }
  }
  releaseLock() { if (this.locked) document.exitPointerLock(); }

  _key(e, down) {
    if (e.repeat) return;
    const c = e.code;
    if (down) {
      if (c === 'F9') {
        e.preventDefault();
        this.invertY = !this.invertY;
        localStorage.setItem('breach.invertY', String(this.invertY));
        if (this.onInvertChanged) this.onInvertChanged(this.invertY);
        return;
      }
      if (c === 'F10') { e.preventDefault(); this.onToggleTuning?.(); return; }
      if (c === 'KeyM') { this.onToggleMute?.(); }
      if (c === 'Escape') { this.onEscape?.(); }
      if (!this.locked) return;
      this.keys.add(c);
      if (c === 'Space') this.evadePressed = true;
      if (c === 'KeyR') this.reloadPressed = true;
      if (c === 'KeyQ') this.swapPressed = true;
    } else {
      this.keys.delete(c);
    }
  }

  // Vector de movimiento en espacio local de input (x = derecha, z = adelante)
  moveVec() {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z += 1;
    if (this.keys.has('KeyS')) z -= 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 0) { x /= len; z /= len; }
    return { x, z };
  }

  get sprintHeld() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }

  // Flancos: consumir tras CADA paso de simulación (evita doble-evade si un
  // frame de render ejecuta dos pasos de física)
  consumeEdges() {
    this.firePressed = false;
    this.evadePressed = false;
    this.reloadPressed = false;
    this.swapPressed = false;
  }

  // Deltas de ratón: consumir una vez por frame de render
  endFrame() {
    this.mouseDX = 0; this.mouseDY = 0;
  }
}
