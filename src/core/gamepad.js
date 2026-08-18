// Gamepad API: stick izq mover, stick der cámara (curva cuadrática + deadzone),
// gatillos analógicos, vibración. A mantenida = roadie run (estilo Gears).
import { BINDS } from './bindings.js';

const DEADZONE = 0.16;

export class PadInput {
  constructor() {
    this.connected = false;
    this.info = null;
    this._idx = -1;
    this.moveX = 0; this.moveZ = 0;
    this.camX = 0; this.camY = 0;
    this.pressed = new Set();
    this.justPressed = new Set();
    this.fireHeld = false;
    this.aimHeld = false;
    this.sprintHeld = false;
    this._evadeHeldT = 0;
    this._gp = null;
  }

  poll(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    // Hay dispositivos virtuales "fantasma" (Steam, receivers, vJoy) que
    // aparecen conectados pero nunca emiten input: nos quedamos con el pad
    // que muestre ACTIVIDAD real, con índice pegajoso hasta que se desconecte.
    const isActive = (g) =>
      g.buttons.some((b) => b.pressed || b.value > 0.3) ||
      g.axes.some((a) => Math.abs(a) > 0.35);
    let gp = (this._idx >= 0 && pads[this._idx] && pads[this._idx].connected)
      ? pads[this._idx] : null;
    for (const g of pads) {
      if (!g || !g.connected) continue;
      if (!gp) { gp = g; continue; }
      if (g.index !== gp.index && isActive(g) && !isActive(gp)) gp = g;
    }
    this._idx = gp ? gp.index : -1;
    this._gp = gp;
    this.justPressed.clear();
    if (!gp) {
      if (this.connected) this._reset();
      this.connected = false;
      this.info = null;
      return;
    }
    this.connected = true;
    this.info = {
      id: gp.id.slice(0, 44),
      mapping: gp.mapping || 'no-standard',
      axes: gp.axes,
      pressed: gp.buttons.map((b, i) => (b.pressed || b.value > 0.3 ? i : -1)).filter((i) => i >= 0),
    };

    const dz = (v) => Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
    const curve = (v) => v * Math.abs(v);
    this.moveX = dz(gp.axes[0] ?? 0);
    this.moveZ = -dz(gp.axes[1] ?? 0);
    this.camX = curve(dz(gp.axes[2] ?? 0));
    this.camY = curve(dz(gp.axes[3] ?? 0));

    const now = new Set();
    gp.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) now.add(i); });
    for (const i of now) if (!this.pressed.has(i)) this.justPressed.add(i);
    this.pressed = now;

    this.fireHeld = now.has(BINDS.pad.fire);
    this.aimHeld = now.has(BINDS.pad.aim);
    this._evadeHeldT = now.has(BINDS.pad.evade) ? this._evadeHeldT + dt : 0;
    this.sprintHeld = this._evadeHeldT > 0.28;
  }

  _reset() {
    this.moveX = 0; this.moveZ = 0; this.camX = 0; this.camY = 0;
    this.pressed.clear(); this.justPressed.clear();
    this.fireHeld = false; this.aimHeld = false; this.sprintHeld = false;
    this._evadeHeldT = 0;
  }

  rumble(ms, weak, strong) {
    try {
      this._gp?.vibrationActuator?.playEffect('dual-rumble', {
        duration: ms, weakMagnitude: weak, strongMagnitude: strong,
      });
    } catch { /* sin soporte */ }
  }
}
