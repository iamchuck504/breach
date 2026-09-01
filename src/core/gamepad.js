// Gamepad API: stick izq mover, stick der cámara (curva cuadrática + deadzone),
// gatillos analógicos, vibración. A mantenida = correr.
import { BINDS } from './bindings.js';
import { HidPad } from './pad-hid.js';

const DEADZONE = 0.16;
const SWITCH_AXIS = 0.28;
const SWITCH_DELTA = 0.055;
const SUSTAINED_AXIS = 0.52;

const buttonDown = (b, threshold = 0.5) =>
  !!b && (b.pressed || Number(b.value || 0) > threshold);

function padPriority(gp) {
  const id = String(gp?.id || '').toLowerCase();
  // Steam Input suele publicar un pad virtual estándar además del dispositivo
  // físico. Si ambos emiten el mismo gesto, consumir el virtual evita layouts
  // DInput sin normalizar y botones/ejes duplicados.
  const steamVirtual = /steam.*(virtual|input)|virtual.*steam|\b(vigem|vjoy|x360ce|rewasd)\b/.test(id);
  const standard = gp?.mapping === 'standard';
  // El pad WebHID lee el control DIRECTO: cuando está activo gana siempre
  // sobre el mismo dispositivo visto (roto) por la Gamepad API.
  const webhid = id.includes('breach webhid');
  const touch = id.includes('breach touch');
  return (standard ? 20 : 0) + (steamVirtual ? 8 : 0) + (webhid ? 30 : 0) +
    (touch ? 26 : 0) + (/xinput|xbox 360|xbox one/.test(id) ? 3 : 0);
}

function snapshot(gp) {
  const axes = Array.from(gp?.axes || [], (v) => Number.isFinite(v) ? v : 0);
  const buttons = Array.from(gp?.buttons || [], (b) => buttonDown(b));
  return { axes, buttons };
}

function padIdentity(gp, index) {
  return `${index}|${String(gp?.id || '')}|${gp?.mapping || ''}|` +
    `${gp?.axes?.length || 0}|${gp?.buttons?.length || 0}`;
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
    this.hid = new HidPad();
    this.hid.autoConnect?.();
  }

  poll(dt) {
    const raw = navigator.getGamepads ? navigator.getGamepads() : [];
    const pads = Array.from(raw || []).filter((g) => g && g.connected !== false);
    // Mando PlayStation por WebHID (lectura directa, inmune a que Steam
    // cambie el modo de reporte): entra al MISMO pipeline que cualquier pad,
    // PERO solo cuando hace falta — si la Gamepad API ya entrega un mando
    // Sony con ejes VIVOS (sin Steam secuestrando), esa es la fuente sana y
    // el HID se aparta; inyectar ambos duplicaba el mismo control físico.
    const sonyApi = pads.find((g) => /dualsense|dualshock|054c/i.test(String(g.id || '')));
    if (sonyApi) {
      const ax = (sonyApi.axes || []).slice(0, 4).map((v) => +v || 0);
      const prev = this._sonyAx;
      this._sonyAx = ax;
      if (prev && ax.some((v, i) => Math.abs(v - prev[i]) > 0.02)) {
        this._sonyAliveAt = performance.now();
      }
      if (Array.from(sonyApi.buttons || []).some((b) => buttonDown(b, 0.3))) {
        this._sonyButtonAt = performance.now();
      }
    }
    const apiAlive = this._sonyAliveAt && performance.now() - this._sonyAliveAt < 2500;
    const hidGp = apiAlive ? null : this.hid?.gamepad?.();
    if (hidGp) pads.push(hidGp);
    // Controles táctiles (smartphones/tablets): otro pad sintético más.
    const touchGp = this.touch?.gamepad?.();
    if (touchGp) pads.push(touchGp);
    const live = new Set(pads.map((g, slot) => Number.isInteger(g.index) ? g.index : slot));
    for (const index of this._samples.keys()) if (!live.has(index)) this._samples.delete(index);

    // Un índice de Gamepad API puede quedar hueco al abrir/cerrar Steam. Buscar
    // por gp.index en vez de asumir que index === posición del array evita que
    // el pad activo se pierda durante ese hot-swap.
    let gp = pads.find((g, slot) =>
      (Number.isInteger(g.index) ? g.index : slot) === this._idx) || null;
    let best = null;
    let currentActivity = null;
    for (let slot = 0; slot < pads.length; slot++) {
      const g = pads[slot];
      const index = Number.isInteger(g.index) ? g.index : slot;
      const now = snapshot(g);
      const identity = padIdentity(g, index);
      const stored = this._samples.get(index);
      // Steam puede reemplazar el dispositivo que ocupa un índice sin dejar
      // un frame vacío. No compares el virtual nuevo contra el snapshot del
      // pad anterior o su primera entrada puede desaparecer.
      const prev = stored?.identity === identity ? stored : null;
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
      const axisEverChanged = !!prev?.axisEverChanged || axisDelta >= SWITCH_DELTA;
      const freshAxis = stickMag >= SWITCH_AXIS &&
        (prev ? axisDelta >= SWITCH_DELTA : g.mapping === 'standard');
      // Caso real de Steam Input: el pad físico gana el primer gesto, pero el
      // virtual ya conserva el stick inclinado. Aunque no haya un NUEVO delta
      // en el frame siguiente, esa entrada sostenida debe poder tomar control.
      // Para DInput no estándar exigimos haber observado un cambio primero;
      // así gatillos/axes fantasma clavados en -1 no secuestran la selección.
      const sustainedAxis = stickMag >= SUSTAINED_AXIS &&
        (g.mapping === 'standard' || axisEverChanged);
      const fresh = buttonEdges > 0 || freshAxis;
      const heldInput = heldButtons > 0 || sustainedAxis;
      const score = buttonEdges * 200 + (freshAxis ? 80 : 0) +
        Math.min(heldButtons, 4) * 30 +
        (sustainedAxis ? 45 + stickMag * 20 : 0) + padPriority(g) +
        (index === this._idx ? 6 : 0);
      const activity = { g, index, score, fresh, heldInput };
      if (index === this._idx) currentActivity = activity;
      if ((fresh || heldInput) && (!best || score > best.score)) best = activity;
      this._samples.set(index, { ...now, identity, axisEverChanged });
    }

    // El último pad usado es pegajoso. Solo una entrada NUEVA cambia de pad;
    // si Steam abre en medio de la partida, su virtual toma control en el
    // primer botón/movimiento y no hace falta recargar la página.
    if (best && best.index !== this._idx) {
      const currentEngaged = !!currentActivity?.heldInput;
      if (!gp || !currentEngaged || best.fresh ||
          best.score > (currentActivity?.score || 0) + 12) gp = best.g;
    }
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

  // Firma MEDIDA de "Steam capturó el mando Sony": los botones siguen
  // llegando (RawInput) pero los EJES están congelados — el modo extendido
  // de Steam cambió el formato y el navegador ya no lo entiende.
  sonyFrozen() {
    const now = performance.now();
    return !!this._sonyButtonAt && now - this._sonyButtonAt < 5000 &&
      (!this._sonyAliveAt || now - this._sonyAliveAt > 5000);
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
