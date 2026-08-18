// Estado de armas del jugador local: cadencia, cargador, recarga y cambio
// de arma con animación (el modelo se intercambia a mitad del gesto).
import { TUNING } from '../config/tuning.js';

const SWAP_TIME = 0.55;

export class Weapons {
  constructor() {
    this.cur = 'smg';
    this.state = {
      smg: { mag: TUNING.weapons.smg.mag, reserve: TUNING.weapons.smg.reserve, cd: 0, reload: 0 },
      shotgun: { mag: TUNING.weapons.shotgun.mag, reserve: TUNING.weapons.shotgun.reserve, cd: 0, reload: 0 },
    };
    this.swapT = 0;        // tiempo restante del cambio
    this._swapped = false; // ya se intercambió el modelo a mitad del gesto
  }

  get def() { return TUNING.weapons[this.cur]; }
  get st() { return this.state[this.cur]; }
  get reloading() { return this.st.reload > 0; }
  get swapping() { return this.swapT > 0; }

  reset() {
    for (const k of ['smg', 'shotgun']) {
      this.state[k].mag = TUNING.weapons[k].mag;
      this.state[k].reserve = TUNING.weapons[k].reserve;
      this.state[k].cd = 0; this.state[k].reload = 0;
    }
    this.cur = 'smg';
    this.swapT = 0;
  }

  startSwap() {
    if (this.swapT > 0) return false;
    this.swapT = SWAP_TIME;
    this._swapped = false;
    this.st.reload = 0; // cambiar cancela la recarga
    return true;
  }

  startReload() {
    const s = this.st, d = this.def;
    if (s.reload > 0 || this.swapT > 0 || s.mag >= d.mag || s.reserve <= 0) return false;
    s.reload = d.reloadTime;
    return true;
  }

  // Devuelve true si disparó este frame.
  update(dt, wantsFire, wantsFirePressed, canFire) {
    const s = this.st, d = this.def;
    s.cd = Math.max(0, s.cd - dt);

    // auto-recarga al quedarse sin balas (sin esperar otro click)
    if (s.mag === 0 && s.reload === 0 && this.swapT === 0 && s.reserve > 0) {
      this.startReload();
    }

    if (this.swapT > 0) {
      this.swapT -= dt;
      if (!this._swapped && this.swapT <= SWAP_TIME / 2) {
        this._swapped = true;
        this.cur = this.cur === 'smg' ? 'shotgun' : 'smg';
      }
      if (this.swapT < 0) this.swapT = 0;
      return false; // sin disparo durante el cambio
    }

    if (s.reload > 0) {
      s.reload -= dt;
      if (s.reload <= 0) {
        const take = Math.min(d.mag - s.mag, s.reserve);
        s.mag += take; s.reserve -= take;
        s.reload = 0;
      }
      return false;
    }
    const trigger = d.auto ? wantsFire : wantsFirePressed;
    if (!trigger || !canFire || s.cd > 0) return false;
    if (s.mag <= 0) { this.startReload(); return false; }
    s.mag--;
    s.cd = 60 / d.rpm;
    return true;
  }
}
