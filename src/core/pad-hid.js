// Conexión DIRECTA a mandos PlayStation por WebHID (DualSense, DualSense
// Edge, DualShock 4). MEDIDO en la máquina de Chuck: al abrir Steam, este
// pone el DualSense en su modo extendido de reporte y la Gamepad API del
// navegador queda leyendo el formato viejo — los botones coinciden de
// casualidad y los EJES SE CONGELAN. Leer los reportes HID crudos es inmune
// a ese modo: el control funciona con Steam abierto, cerrado o como esté.
//
// El estado se expone como un objeto con la forma de un Gamepad estándar
// (mapping 'standard'), así PadInput lo consume por el mismo pipeline que
// cualquier control (BINDS, flancos, selección por actividad).

const SONY_VENDOR = 0x054c;
const HID_ID = 'BREACH WebHID PlayStation (STANDARD GAMEPAD)';
const STALE_MS = 1200; // sin reportes en este lapso: el pad no cuenta

// PadInput también corre en unit-tests de Node: sin window no hay
// localStorage/performance del navegador.
const store = typeof localStorage !== 'undefined' ? localStorage : null;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);

export class HidPad {
  constructor() {
    this.device = null;
    this._axes = [0, 0, 0, 0];
    this._buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    this._lastReport = 0;
    this.enabled = store?.getItem('breach.hidpad') === 'true';
    this.onStatus = null; // UI: notificación de cambios de estado
    // WATCHDOG de sanidad: un layout de reporte distinto al esperado no
    // debe romper el juego (leer gyro/touchpad como botones = acciones
    // fantasma). Si el parseo produce basura sostenida, auto-suspender.
    this.layoutBad = false;
    this._suspect = 0;
    this._prevAxes = null;
  }

  supported() { return typeof navigator !== 'undefined' && !!navigator.hid; }

  // Al cargar: si el usuario ya autorizó un mando Sony, reconectar solo
  // (getDevices/open no exigen gesto de usuario).
  async autoConnect() {
    if (!this.enabled || !this.supported()) return false;
    try {
      const devices = await navigator.hid.getDevices();
      const sony = devices.find((d) => d.vendorId === SONY_VENDOR);
      return sony ? this._open(sony) : false;
    } catch { return false; }
  }

  // Desde el botón de Opciones→Controles (gesto de usuario: abre el chooser).
  async requestConnect() {
    if (!this.supported()) return false;
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: SONY_VENDOR }],
      });
      if (!devices.length) return false;
      const ok = await this._open(devices[0]);
      if (ok) {
        this.enabled = true;
        store?.setItem('breach.hidpad', 'true');
      }
      return ok;
    } catch { return false; }
  }

  disconnect() {
    try { this.device?.close(); } catch { /* ya cerrado */ }
    this.device = null;
    this._lastReport = 0;
    this.enabled = false;
    store?.setItem('breach.hidpad', 'false');
    this.onStatus?.();
  }

  async _open(device) {
    try {
      if (!device.opened) await device.open();
    } catch { return false; }
    this.device = device;
    device.oninputreport = (e) => this._report(e);
    // MEDIDO (Chromium y Brave, con Steam abierto): el dispositivo abre
    // pero Steam retiene el flujo de reportes a nivel de SO — cero datos.
    // Detectarlo y decirlo con honestidad en la UI.
    this.noData = false;
    setTimeout(() => {
      if (this.device === device && !this._lastReport) {
        this.noData = true;
        this.onStatus?.();
      }
    }, 3000);
    navigator.hid.addEventListener?.('disconnect', (e) => {
      if (e.device === this.device) { this.device = null; this._lastReport = 0; this.onStatus?.(); }
    });
    this.onStatus?.();
    return true;
  }

  _resetButtons() {
    this._axes = [0, 0, 0, 0];
    for (const b of this._buttons) { b.pressed = false; b.value = 0; }
  }

  active() { return !!this.device && nowMs() - this._lastReport < STALE_MS; }
  connected() { return !!this.device; }

  // Pad sintético con forma de Gamepad estándar (o null si no hay datos
  // frescos). index alto fijo: no choca con pads reales.
  gamepad() {
    if (this.layoutBad || !this.active()) return null;
    return {
      id: HID_ID, index: 31, mapping: 'standard', connected: true,
      axes: this._axes, buttons: this._buttons,
    };
  }

  _report(e) {
    const dv = e.data;
    // Formatos DualSense/Edge (mismo layout base):
    //  - USB reportId 0x01 (63B): ejes en 0..3, L2/R2 en 4..5, botones 7..9
    //  - BT extendido reportId 0x31: todo corrido +1 (byte 0 = secuencia)
    //  - BT simple reportId 0x01 (9B): ejes 0..3, botones 4..6, L2/R2 7..8
    // DualShock 4: USB 0x01 y BT 0x11 (offset +2) comparten la estructura.
    let o = null, simple = false;
    if (e.reportId === 0x31 && dv.byteLength >= 10) o = 1;
    else if (e.reportId === 0x11 && dv.byteLength >= 11) o = 2;
    else if (e.reportId === 0x01 && dv.byteLength >= 10) o = 0;
    else if (e.reportId === 0x01 && dv.byteLength === 9) { o = 0; simple = true; }
    else return;

    const axis = (i) => {
      const v = (dv.getUint8(o + i) - 127.5) / 127.5;
      return Math.abs(v) < 0.01 ? 0 : Math.max(-1, Math.min(1, v));
    };
    this._axes = [axis(0), axis(1), axis(2), axis(3)];

    const b1 = dv.getUint8(o + (simple ? 4 : 7));
    const b2 = dv.getUint8(o + (simple ? 5 : 8));
    const b3 = dv.getUint8(o + (simple ? 6 : 9));
    const l2 = dv.getUint8(o + (simple ? 7 : 4)) / 255;
    const r2 = dv.getUint8(o + (simple ? 8 : 5)) / 255;

    const hat = b1 & 0x0f;
    const set = (i, pressed, value = pressed ? 1 : 0) => {
      const btn = this._buttons[i];
      btn.pressed = !!pressed; btn.value = value;
    };
    // mapping estándar: 0=Cruz 1=Círculo 2=Cuadrado 3=Triángulo, 4/5=L1/R1,
    // 6/7=L2/R2 (analógicos), 8=Create 9=Options 10/11=L3/R3, 12..15=dpad,
    // 16=PS
    set(0, b1 & 0x20); set(1, b1 & 0x40); set(2, b1 & 0x10); set(3, b1 & 0x80);
    set(4, b2 & 0x01); set(5, b2 & 0x02);
    set(6, (b2 & 0x04) || l2 > 0.12, l2); set(7, (b2 & 0x08) || r2 > 0.12, r2);
    set(8, b2 & 0x10); set(9, b2 & 0x20);
    set(10, b2 & 0x40); set(11, b2 & 0x80);
    set(12, hat === 7 || hat === 0 || hat === 1);
    set(13, hat === 3 || hat === 4 || hat === 5);
    set(14, hat === 5 || hat === 6 || hat === 7);
    set(15, hat === 1 || hat === 2 || hat === 3);
    set(16, b3 & 0x01);
    // sanidad: >6 botones simultáneos o ejes teletransportándose entre
    // reportes consecutivos = layout desconocido → basura sostenida suspende
    const pressedCount = this._buttons.reduce((n, b) => n + (b.pressed ? 1 : 0), 0);
    let jumpy = false;
    if (this._prevAxes) {
      for (let i = 0; i < 4; i++) {
        if (Math.abs(this._axes[i] - this._prevAxes[i]) > 1.5) jumpy = true;
      }
    }
    this._prevAxes = [...this._axes];
    if (pressedCount > 6 || jumpy) this._suspect++;
    else if (this._suspect > 0) this._suspect -= 0.2;
    if (this._suspect > 25 && !this.layoutBad) {
      this.layoutBad = true;
      this._resetButtons();
      this.onStatus?.();
    }
    this._lastReport = nowMs();
  }
}
