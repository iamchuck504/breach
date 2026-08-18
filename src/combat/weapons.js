// Estado de armas del jugador local: cadencia, cargador, recarga, cambio.
import { TUNING } from '../config/tuning.js';

export class Weapons {
  constructor() {
    this.cur = 'lancer';
    this.state = {
      lancer: { mag: TUNING.weapons.lancer.mag, reserve: TUNING.weapons.lancer.reserve, cd: 0, reload: 0 },
      gnasher: { mag: TUNING.weapons.gnasher.mag, reserve: TUNING.weapons.gnasher.reserve, cd: 0, reload: 0 },
    };
  }

  get def() { return TUNING.weapons[this.cur]; }
  get st() { return this.state[this.cur]; }
  get reloading() { return this.st.reload > 0; }

  reset() {
    for (const k of ['lancer', 'gnasher']) {
      this.state[k].mag = TUNING.weapons[k].mag;
      this.state[k].reserve = TUNING.weapons[k].reserve;
      this.state[k].cd = 0; this.state[k].reload = 0;
    }
    this.cur = 'lancer';
  }

  swap() {
    this.st.reload = 0;
    this.cur = this.cur === 'lancer' ? 'gnasher' : 'lancer';
  }

  startReload() {
    const s = this.st, d = this.def;
    if (s.reload > 0 || s.mag >= d.mag || s.reserve <= 0) return false;
    s.reload = d.reloadTime;
    return true;
  }

  // Devuelve true si disparó este frame.
  update(dt, wantsFire, wantsFirePressed, canFire) {
    const s = this.st, d = this.def;
    s.cd = Math.max(0, s.cd - dt);
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
