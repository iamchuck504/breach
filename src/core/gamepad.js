// Gamepad API: stick izq mover, stick der cámara (curva cuadrática + deadzone),
// gatillos analógicos, vibración. A mantenida = correr.
import { BINDS } from './bindings.js';

const DEADZONE = 0.16;
const SWITCH_AXIS = 0.28;
const SWITCH_DELTA = 0.055;
// Armado POR STICK: un stick solo mueve/gira tras un gesto deliberado. Un
// stick gastado que reposa fuera de la zona muerta, o un HID no estándar con
// un eje clavado en ±1, caminaban solos. Cifras de drift usadas (testers de
// mandos publicados: reposo sano ±0.02-0.05; drift "notable" > 0.08-0.10;
// "severo" ≥ 0.15; el umbral de fallo más alto visto, 0.25). Reglas, sin
// mirar botones:
// - ≥ DELIBERATE (0.5, el doble del peor drift reportado) → gesto, al momento;
// - entre JITTER_MIN (0.3, sobre el drift severo) y 0.5 → arma si varía como
//   un pulgar: pico a pico ≥ JITTER (0.006) en algún eje dentro de
//   JITTER_WINDOW (0.3 s). Un eje atascado se queda quieto;
// - base neutra: visto en reposo (< NEUTRAL) y luego inclinado ≥ DEFLECT;
// - cambio ≥ CHANGE respecto de donde se lo vio primero (o al desarmarlo);
// - un eje clavado en ±1 (≥ 0.999) de un mapping NO estándar es la firma de
//   un HID que no es un stick: solo arma por cambio, nunca por magnitud.
const NEUTRAL = 0.2;
const DEFLECT = 0.25;
const CHANGE = 0.15;
const DELIBERATE = 0.5;
const JITTER_MIN = 0.3;
const JITTER = 0.006;
const JITTER_WINDOW = 0.3;

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
    this._arm = new Map(); // index -> { armed, anchor:[4 ejes] }
  }

  // El teclado tomó el control: el pad queda en reposo hasta que alguien lo
  // vuelva a usar de verdad (lo que marque el stick ahora es su "reposo").
  disarm() {
    for (const [index, sticks] of this._arm) {
      const smp = this._samples.get(index);
      for (const st of sticks) {
        const x = axisAt(smp, st.ax), y = axisAt(smp, st.ax + 1);
        st.armed = false; st.ref = [x, y]; st.neutral = Math.hypot(x, y) < NEUTRAL; st.win.length = 0;
      }
    }
    this.moveX = 0; this.moveZ = 0; this.camX = 0; this.camY = 0;
  }

  _updateArm(g, index, now, dt = 1 / 60) {
    let sticks = this._arm.get(index);
    const fresh = !sticks;
    if (fresh) {
      sticks = [0, 2].map((ax) => {
        const x = axisAt(now, ax), y = axisAt(now, ax + 1);
        return { ax, ref: [x, y], neutral: Math.hypot(x, y) < NEUTRAL, armed: false, win: [] };
      });
      this._arm.set(index, sticks);
    }
    const nonStd = g.mapping !== 'standard';
    for (const st of sticks) {
      if (st.armed) continue;
      const x = axisAt(now, st.ax), y = axisAt(now, st.ax + 1), mag = Math.hypot(x, y);
      if (mag < NEUTRAL) { st.neutral = true; st.win.length = 0; continue; }
      const pinned = nonStd && (Math.abs(x) >= 0.999 || Math.abs(y) >= 0.999);
      if ((st.neutral && mag >= DEFLECT) || Math.hypot(x - st.ref[0], y - st.ref[1]) >= CHANGE ||
          (!pinned && mag >= DELIBERATE)) { st.armed = true; continue; }
      if (pinned || mag < JITTER_MIN) { st.win.length = 0; continue; }
      // ventana de "pulgar vivo": muestras de los últimos JITTER_WINDOW s
      const w = st.win;
      w.push(x, y, dt);
      let span = 0;
      for (let i = w.length - 1; i >= 2; i -= 3) span += w[i];
      while (span - w[2] > JITTER_WINDOW && w.length > 3) { span -= w[2]; w.splice(0, 3); }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < w.length; i += 3) {
        x0 = Math.min(x0, w[i]); x1 = Math.max(x1, w[i]);
        y0 = Math.min(y0, w[i + 1]); y1 = Math.max(y1, w[i + 1]);
      }
      if (span >= JITTER_WINDOW * 0.8 && Math.max(x1 - x0, y1 - y0) >= JITTER) st.armed = true;
    }
    return sticks;
  }

  poll(dt) {
    const raw = navigator.getGamepads ? navigator.getGamepads() : [];
    const pads = Array.from(raw || []).filter((g) => g && g.connected !== false);
    const live = new Set(pads.map((g, slot) => Number.isInteger(g.index) ? g.index : slot));
    for (const index of this._samples.keys()) if (!live.has(index)) this._samples.delete(index);
    for (const index of this._arm.keys()) if (!live.has(index)) this._arm.delete(index);

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
      this._updateArm(g, index, now, dt);
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
    // un stick sin armar no existe para el gameplay ni el menú (botones sí)
    const sticks = this._arm.get(this._idx);
    const moveOk = !!sticks?.[0]?.armed, camOk = !!sticks?.[1]?.armed;
    this.moveX = moveOk ? dz(gp.axes[0] ?? 0) : 0;
    this.moveZ = moveOk ? -dz(gp.axes[1] ?? 0) : 0;
    this.camX = camOk ? curve(dz(gp.axes[2] ?? 0)) : 0;
    this.camY = camOk ? curve(dz(gp.axes[3] ?? 0)) : 0;

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
