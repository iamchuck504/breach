// Controles TÁCTILES para smartphones y tablets.
//
// Filosofía: el touch se sintetiza como un Gamepad estándar más (mismo
// pipeline que Xbox/PS/WebHID: BINDS, flancos, selección por actividad) y
// la mirada alimenta los MISMOS acumuladores que el mouse. Cero caminos
// nuevos de gameplay.
//
// Detección inteligente: por CAPACIDADES, nunca por user-agent — pointer
// primario "coarse" + eventos touch reales. En híbridos (laptop táctil) la
// UI solo aparece cuando llega el PRIMER toque y se esconde si el jugador
// vuelve al mouse/teclado.
//
// Layout (pulgares, landscape): stick virtual DINÁMICO en la zona
// izquierda (nace donde apoyas el dedo); la zona derecha libre es mirada
// por arrastre; botones de acción agrupados para el pulgar derecho; fila
// de armas arriba a la derecha (d-pad 12-15); ADS es TOGGLE (mantener el
// pulgar sería incómodo); empujar el stick al máximo sostiene el sprint.

import { BINDS } from './bindings.js';
import { TUNING } from '../config/tuning.js';

const TOUCH_ID = 'BREACH Touch (STANDARD GAMEPAD)';
const STICK_RADIUS = 62;      // px hasta deflexión máxima
const SPRINT_EDGE = 0.94;     // stick al tope
const SPRINT_HOLD_MS = 240;

export class TouchInput {
  constructor(input, canvas) {
    this.input = input;
    this.canvas = canvas;
    this.active = false;
    this._buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
    this._axes = [0, 0, 0, 0];
    this._stickTouch = null;   // { id, ox, oy }
    this._lookTouch = null;    // { id, x, y }
    this._sprintSince = 0;
    this._ui = null;
    this._aimToggle = false;
    if (typeof window === 'undefined') return;

    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches &&
      ('ontouchstart' in window);
    if (coarse) this._activate();
    // híbridos: el primer toque real activa; mouse/teclado REALES esconden.
    // OJO: cada toque genera un mousedown de COMPATIBILIDAD — filtrarlo
    // (sourceCapabilities + ventana temporal) o el propio tap desactivaría.
    this._lastTouchTs = 0;
    window.addEventListener('touchstart', () => {
      this._lastTouchTs = performance.now();
      this._activate();
    }, { passive: true });
    const realPointer = (e) => {
      if (e.sourceCapabilities?.firesTouchEvents) return;
      if (performance.now() - this._lastTouchTs < 900) return;
      this._deactivate();
    };
    window.addEventListener('mousedown', realPointer);
    window.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      realPointer(e);
    });

    canvas.addEventListener('touchstart', (e) => this._start(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this._move(e), { passive: false });
    canvas.addEventListener('touchend', (e) => this._end(e), { passive: false });
    canvas.addEventListener('touchcancel', (e) => this._end(e), { passive: false });
  }

  _activate() {
    if (this.active) return;
    this.active = true;
    // sin pointer lock en táctil: el gameplay opera como con ?nolock
    this._prevLockDisabled = this.input.lockDisabled;
    this.input.lockDisabled = true;
    document.body.classList.add('touch-on');
    this._buildUi();
  }

  _deactivate() {
    if (!this.active) return;
    this.active = false;
    this.input.lockDisabled = this._prevLockDisabled ?? false;
    document.body.classList.remove('touch-on');
    this._resetState();
  }

  _resetState() {
    this._axes = [0, 0, 0, 0];
    for (const b of this._buttons) { b.pressed = false; b.value = 0; }
    this._stickTouch = null;
    this._lookTouch = null;
    this._aimToggle = false;
    if (this._stickEl) this._stickEl.style.display = 'none';
  }

  // pad sintético (mismo contrato que HidPad.gamepad)
  gamepad() {
    if (!this.active) return null;
    return {
      id: TOUCH_ID, index: 32, mapping: 'standard', connected: true,
      axes: this._axes, buttons: this._buttons,
    };
  }

  _press(idx, down, value = down ? 1 : 0) {
    if (idx == null || idx < 0) return;
    const b = this._buttons[idx];
    if (b) { b.pressed = !!down; b.value = value; }
  }

  // ---------- toques sobre el canvas: stick dinámico + mirada ----------
  _start(e) {
    if (!this.active || this.input.suppress) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      const leftZone = t.clientX < innerWidth * 0.45;
      if (leftZone && !this._stickTouch) {
        this._stickTouch = { id: t.identifier, ox: t.clientX, oy: t.clientY };
        this._placeStick(t.clientX, t.clientY, t.clientX, t.clientY);
      } else if (!this._lookTouch) {
        this._lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }
  }

  _move(e) {
    if (!this.active || this.input.suppress) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this._stickTouch && t.identifier === this._stickTouch.id) {
        const dx = t.clientX - this._stickTouch.ox;
        const dy = t.clientY - this._stickTouch.oy;
        const len = Math.hypot(dx, dy);
        const cl = Math.min(1, len / STICK_RADIUS);
        const nx = len > 0 ? (dx / len) * cl : 0;
        const ny = len > 0 ? (dy / len) * cl : 0;
        this._axes[0] = nx; this._axes[1] = ny;
        this._placeStick(this._stickTouch.ox, this._stickTouch.oy,
          this._stickTouch.ox + nx * STICK_RADIUS, this._stickTouch.oy + ny * STICK_RADIUS);
        // sprint: stick al tope sostenido
        if (cl >= SPRINT_EDGE) {
          if (!this._sprintSince) this._sprintSince = performance.now();
          if (performance.now() - this._sprintSince > SPRINT_HOLD_MS) {
            this._press(BINDS.pad.sprint, true);
          }
        } else {
          this._sprintSince = 0;
          this._press(BINDS.pad.sprint, false);
        }
      } else if (this._lookTouch && t.identifier === this._lookTouch.id) {
        const k = TUNING.cam.touchSens ?? 2.4;
        this.input.mouseDX += (t.clientX - this._lookTouch.x) * k;
        this.input.mouseDY += (t.clientY - this._lookTouch.y) * k;
        this._lookTouch.x = t.clientX; this._lookTouch.y = t.clientY;
      }
    }
  }

  _end(e) {
    if (!this.active) return;
    for (const t of e.changedTouches) {
      if (this._stickTouch && t.identifier === this._stickTouch.id) {
        this._stickTouch = null;
        this._sprintSince = 0;
        this._axes[0] = 0; this._axes[1] = 0;
        this._press(BINDS.pad.sprint, false);
        if (this._stickEl) this._stickEl.style.display = 'none';
      }
      if (this._lookTouch && t.identifier === this._lookTouch.id) this._lookTouch = null;
    }
  }

  _placeStick(ox, oy, tx, ty) {
    if (!this._stickEl) return;
    this._stickEl.style.display = 'block';
    this._stickEl.style.left = `${ox - STICK_RADIUS}px`;
    this._stickEl.style.top = `${oy - STICK_RADIUS}px`;
    this._nubEl.style.left = `${STICK_RADIUS + (tx - ox) - 26}px`;
    this._nubEl.style.top = `${STICK_RADIUS + (ty - oy) - 26}px`;
  }

  // ---------- botones en pantalla ----------
  _buildUi() {
    if (this._ui) { this._ui.style.display = ''; return; }
    const ui = document.createElement('div');
    ui.id = 'touch-ui';
    document.body.appendChild(ui);
    this._ui = ui;

    // base visual del stick dinámico
    const stick = document.createElement('div');
    stick.className = 'touch-stick';
    const nub = document.createElement('div');
    nub.className = 'touch-nub';
    stick.appendChild(nub);
    ui.appendChild(stick);
    this._stickEl = stick;
    this._nubEl = nub;

    // acción → índice de botón del pad (respeta rebinds al leerse en vivo)
    const mk = (cls, label, bind, { toggle = false } = {}) => {
      const b = document.createElement('div');
      b.className = `touch-btn ${cls}`;
      b.textContent = label;
      const idx = () => (typeof bind === 'function' ? bind() : bind);
      b.addEventListener('touchstart', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (toggle) {
          this._aimToggle = !this._aimToggle;
          this._press(idx(), this._aimToggle);
          b.classList.toggle('on', this._aimToggle);
        } else {
          this._press(idx(), true);
          b.classList.add('on');
        }
      }, { passive: false });
      const release = (e) => {
        e.preventDefault();
        if (!toggle) { this._press(idx(), false); b.classList.remove('on'); }
      };
      b.addEventListener('touchend', release, { passive: false });
      b.addEventListener('touchcancel', release, { passive: false });
      ui.appendChild(b);
      return b;
    };

    mk('t-fire', 'FIRE', () => BINDS.pad.fire);
    mk('t-aim', 'ADS', () => BINDS.pad.aim, { toggle: true });
    mk('t-jump', 'JMP', () => BINDS.pad.jump);
    mk('t-evade', 'ROLL', () => BINDS.pad.evade);
    mk('t-reload', 'RLD', () => BINDS.pad.reload);
    mk('t-melee', 'MLE', () => BINDS.pad.melee);
    // armas por d-pad estándar: ↑ granada · ↓ pistola · ← escopeta · → SMG
    mk('t-w1 t-wep', 'SMG', 15);
    mk('t-w2 t-wep', 'SHG', 14);
    mk('t-w3 t-wep', 'PST', 13);
    mk('t-w4 t-wep', 'GRN', 12);
  }
}
