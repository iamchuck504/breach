// Gamepad API: stick izq mover, stick der cámara (curva cuadrática + deadzone),
// gatillos analógicos, vibración. A mantenida = correr.
import { BINDS } from './bindings.js';

const DEADZONE = 0.16;
const SWITCH_AXIS = 0.28;
const SWITCH_DELTA = 0.055;

const buttonDown = (b, threshold = 0.5) =>
  !!b && (b.pressed || Number(b.value || 0) > threshold);

function padPriority(gp) {
  const id = String(gp?.id || '').toLowerCase();
  // Steam Input suele publicar un pad virtual estándar además del dispositivo
  // físico. Si ambos emiten el mismo gesto, consumir el virtual evita layouts
  // DInput sin normalizar y botones/ejes duplicados.
  const steamVirtual = /steam.*(virtual|input)|virtual.*steam/.test(id);
  const standard = gp?.mapping === 'standard';
  return (standard ? 20 : 0) + (steamVirtual ? 8 : 0) +
    (/xinput|xbox 360|xbox one/.test(id) ? 3 : 0);
}

function snapshot(gp) {
  const axes = Array.from(gp?.axes || [], (v) => Number.isFinite(v) ? v : 0);
  const buttons = Array.from(gp?.buttons || [], (b) => buttonDown(b));
  return { axes, buttons };
}

function axisAt(s, i) { return Number(s?.axes?.[i] || 0); }

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
    this._samples = new Map();
  }

  poll(dt) {
    const raw = navigator.getGamepads ? navigator.getGamepads() : [];
    const pads = Array.from(raw || []).filter((g) => g && g.connected !== false);
    const live = new Set(pads.map((g, slot) => Number.isInteger(g.index) ? g.index : slot));
    for (const index of this._samples.keys()) if (!live.has(index)) this._samples.delete(index);

    // Un índice de Gamepad API puede quedar hueco al abrir/cerrar Steam. Buscar
    // por gp.index en vez de asumir que index === posición del array evita que
    // el pad activo se pierda durante ese hot-swap.
    let gp = pads.find((g, slot) =>
      (Number.isInteger(g.index) ? g.index : slot) === this._idx) || null;
    let best = null;
    for (let slot = 0; slot < pads.length; slot++) {
      const g = pads[slot];
      const index = Number.isInteger(g.index) ? g.index : slot;
      const now = snapshot(g);
      const prev = this._samples.get(index);
      let buttonEdges = 0, heldButtons = 0;
      for (let i = 0; i < now.buttons.length; i++) {
        if (now.buttons[i]) {
          heldButtons++;
          if (!prev?.buttons?.[i]) buttonEdges++;
        }
      }
      // Solo los cuatro ejes estándar de sticks deciden el dispositivo. Ejes
      // extra de DInput suelen ser gatillos en -1 y antes contaban como
      // actividad perpetua, dejando seleccionado un receiver/pad fantasma.
      const stickMag = Math.max(
        Math.hypot(axisAt(now, 0), axisAt(now, 1)),
        Math.hypot(axisAt(now, 2), axisAt(now, 3)),
      );
      let axisDelta = 0;
      if (prev) {
        for (let i = 0; i < 4; i++) {
          axisDelta = Math.max(axisDelta, Math.abs(axisAt(now, i) - axisAt(prev, i)));
        }
      }
      const freshAxis = stickMag >= SWITCH_AXIS &&
        (prev ? axisDelta >= SWITCH_DELTA : g.mapping === 'standard');
      const fresh = buttonEdges > 0 || freshAxis;
      const score = buttonEdges * 100 + (freshAxis ? 40 + stickMag * 10 : 0) +
        Math.min(heldButtons, 4) + padPriority(g);
      if (fresh && (!best || score > best.score)) best = { g, index, score };
      this._samples.set(index, now);
    }

    // El último pad usado es pegajoso. Solo una entrada NUEVA cambia de pad;
    // si Steam abre en medio de la partida, su virtual toma control en el
    // primer botón/movimiento y no hace falta recargar la página.
    if (best && (!gp || best.index !== this._idx)) gp = best.g;
    if (!gp && pads.length) {
      gp = [...pads].sort((a, b) => padPriority(b) - padPriority(a))[0];
    }
    this._idx = gp
      ? (Number.isInteger(gp.index) ? gp.index : pads.indexOf(gp))
      : -1;
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
      id: String(gp.id || 'Gamepad').slice(0, 44),
      mapping: gp.mapping || 'no-standard',
      axes: Array.from(gp.axes || []),
      pressed: Array.from(gp.buttons || [], (b, i) => buttonDown(b, 0.3) ? i : -1)
        .filter((i) => i >= 0),
    };

    const dz = (v) => Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
    const curve = (v) => v * Math.abs(v);
    this.moveX = dz(gp.axes[0] ?? 0);
    this.moveZ = -dz(gp.axes[1] ?? 0);
    this.camX = curve(dz(gp.axes[2] ?? 0));
    this.camY = curve(dz(gp.axes[3] ?? 0));

    const now = new Set();
    Array.from(gp.buttons || []).forEach((b, i) => { if (buttonDown(b)) now.add(i); });
    for (const i of now) if (!this.pressed.has(i)) this.justPressed.add(i);
    this.pressed = now;

    this.fireHeld = now.has(BINDS.pad.fire);
    this.aimHeld = now.has(BINDS.pad.aim);
    this.sprintHeld = now.has(BINDS.pad.sprint); // botón dedicado (default L3)
  }

  _reset() {
    this.moveX = 0; this.moveZ = 0; this.camX = 0; this.camY = 0;
    this.pressed.clear(); this.justPressed.clear();
    this.fireHeld = false; this.aimHeld = false; this.sprintHeld = false;
  }

  rumble(ms, weak, strong) {
    try {
      this._gp?.vibrationActuator?.playEffect('dual-rumble', {
        duration: ms, weakMagnitude: weak, strongMagnitude: strong,
      });
    } catch { /* sin soporte */ }
  }
}
