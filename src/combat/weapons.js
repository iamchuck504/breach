// Estado de armas del jugador local: loadout multi-slot, cadencia, cargador,
// recarga y cambio de arma con animación (el modelo se intercambia a mitad
// del gesto). Slots 0/1 = primarias (un arma especial del mapa puede ocupar
// uno), 2 = pistola, 3 = granada de humo.
import { TUNING } from '../config/tuning.js';

const SWAP_TIME = 0.55;
export const DEFAULT_LOADOUT = ['smg', 'shotgun', 'pistol', 'grenade'];
export const SPECIAL_WEAPONS = ['sniper', 'bazooka'];

export class Weapons {
  constructor() {
    this.slots = [...DEFAULT_LOADOUT];
    this.state = {};
    for (const k of this.slots) this.state[k] = this._freshState(k);
    this.cur = 'smg';
    this.swapT = 0;        // tiempo restante del cambio
    this._swapped = false; // ya se intercambió el modelo a mitad del gesto
    this._swapTarget = null;
    this.reloadInterrupted = false; // evento de un frame para audio/animación
    this.reloadInserted = 0; // cartuchos insertados físicamente este frame
    this.bonusT = 0;         // tiempo restante del bonus de recarga activa
  }

  _freshState(k) {
    const d = TUNING.weapons[k];
    return { mag: d.mag, reserve: d.reserve, cd: 0, reload: 0, active: null, jammed: false };
  }

  get def() { return TUNING.weapons[this.cur]; }
  get st() { return this.state[this.cur]; }
  get reloading() { return this.st.reload > 0; }
  get swapping() { return this.swapT > 0; }

  reset() {
    this.slots = [...DEFAULT_LOADOUT];
    this.state = {};
    for (const k of this.slots) this.state[k] = this._freshState(k);
    this.cur = 'smg';
    this.swapT = 0;
    this._swapped = false;
    this._swapTarget = null;
    this.reloadInterrupted = false;
    this.reloadInserted = 0;
    this.bonusT = 0;
  }

  // La muerte tiene prioridad absoluta sobre gestos del arma. Congelar el
  // swap en el arma que realmente estaba activa evita que el modelo cambie
  // sobre el cadáver y que el drop no coincida con lo que vio el jugador.
  cancelActions() {
    this.swapT = 0;
    this._swapped = false;
    this._swapTarget = null;
    for (const k of this.slots) this.state[k].reload = 0;
  }

  // caja de munición: rellena todo el loadout sin tocar el arma actual.
  // La munición de un arma ESPECIAL nunca se rellena.
  refill() {
    for (const k of this.slots) {
      const d = TUNING.weapons[k];
      if (d.special) continue;
      this.state[k].mag = d.mag;
      this.state[k].reserve = d.reserve;
    }
    this.st.reload = 0;
  }

  // Arma primaria de referencia (para drops cuando la actual no es soltable)
  get primary() { return this.slots[0]; }

  hasWeapon(k) { return this.slots.includes(k); }

  // El arma especial del mapa reemplaza la primaria EN MANO (o el slot 0 si
  // llevas pistola/granada). Devuelve el id del arma que salió del loadout.
  giveSpecial(k) {
    const curIdx = this.slots.indexOf(this.cur);
    const idx = curIdx === 0 || curIdx === 1 ? curIdx : 0;
    const removed = this.slots[idx];
    delete this.state[removed];
    this.slots[idx] = k;
    this.state[k] = this._freshState(k);
    this.cur = k;
    this.swapT = 0;
    this._swapped = false;
    this._swapTarget = null;
    return removed;
  }

  // Recuperar una primaria normal (drop del suelo) soltando la especial vacía
  replaceSlot(idx, k, mag = null, reserve = null) {
    const removed = this.slots[idx];
    delete this.state[removed];
    this.slots[idx] = k;
    this.state[k] = this._freshState(k);
    if (mag !== null) this.state[k].mag = mag;
    if (reserve !== null) this.state[k].reserve = reserve;
    if (this.cur === removed) this.cur = k;
    return removed;
  }

  // Siguiente slot al ciclar (Q / rueda del mouse)
  cycleTarget(dir = 1) {
    const i = Math.max(0, this.slots.indexOf(this.cur));
    return this.slots[(i + dir + this.slots.length) % this.slots.length];
  }

  // target = id de arma (selección directa) o null para ciclar +1
  startSwap(target = null) {
    if (this.swapT > 0) return false;
    const next = target ?? this.cycleTarget(1);
    if (!next || next === this.cur || !this.state[next]) return false;
    this.swapT = SWAP_TIME;
    this._swapped = false;
    this._swapTarget = next;
    this.st.reload = 0; // cambiar cancela la recarga
    return true;
  }

  startReload() {
    const s = this.st, d = this.def;
    if (d.thrown) return false; // la granada no recarga
    if (s.reload > 0 || this.swapT > 0 || s.mag >= d.mag || s.reserve <= 0) return false;
    s.reload = d.reloadTime;
    s.active = 'open';   // 'open' → aún se puede clavar | 'done' | 'jam'
    s.jammed = false;
    return true;
  }

  // Progreso 0..1 de la recarga en curso (para el HUD y la ventana activa)
  get reloadProgress() {
    const s = this.st, d = this.def;
    if (s.reload <= 0) return 0;
    const total = d.perShell ? d.reloadTime : d.reloadTime * (s.jammed ? TUNING.activeReload.jamMul : 1);
    return Math.max(0, Math.min(1, 1 - s.reload / total));
  }

  // Ventana activa del arma actual: null si no aplica (per-shell o ya usada)
  activeWindow() {
    const d = this.def, s = this.st;
    if (d.perShell || d.thrown || s.reload <= 0 || s.active !== 'open') return null;
    const a = TUNING.activeReload;
    return { start: a.windowStart, end: a.windowEnd };
  }

  // Intento de recarga activa. Devuelve 'perfect' | 'jam' | null (sin efecto)
  tryActiveReload() {
    const s = this.st, d = this.def;
    if (d.perShell || d.thrown || s.reload <= 0 || s.active !== 'open') return null;
    const a = TUNING.activeReload;
    const p = this.reloadProgress;
    if (p >= a.windowStart && p <= a.windowEnd + a.perfectPad) {
      // clavada: cargador lleno YA + bonus temporal de daño
      const take = Math.min(d.mag - s.mag, s.reserve);
      s.mag += take; s.reserve -= take;
      s.reload = 0;
      s.active = 'done';
      this.bonusT = a.bonusTime;
      return 'perfect';
    }
    // fallada: se atasca y el resto de la recarga se alarga
    s.active = 'jam';
    s.jammed = true;
    s.reload *= a.jamMul;
    return 'jam';
  }

  // Multiplicador de daño vigente (bonus de recarga activa)
  get damageMul() { return this.bonusT > 0 ? 1 + TUNING.activeReload.damageBonus : 1; }

  // Devuelve true si disparó (o lanzó) este frame.
  update(dt, wantsFire, wantsFirePressed, canFire) {
    const s = this.st, d = this.def;
    this.reloadInterrupted = false;
    this.reloadInserted = 0;
    this.bonusT = Math.max(0, this.bonusT - dt);
    // el cooldown corre para TODAS las armas (guardarlas no lo congela)
    for (const k of this.slots) this.state[k].cd = Math.max(0, this.state[k].cd - dt);

    // auto-recarga al quedarse sin balas (sin esperar otro click)
    if (s.mag === 0 && s.reload === 0 && this.swapT === 0 && s.reserve > 0 && !d.thrown) {
      this.startReload();
    }

    if (this.swapT > 0) {
      this.swapT -= dt;
      if (!this._swapped && this.swapT <= SWAP_TIME / 2) {
        this._swapped = true;
        if (this._swapTarget && this.state[this._swapTarget]) this.cur = this._swapTarget;
        this._swapTarget = null;
      }
      if (this.swapT < 0) this.swapT = 0;
      return false; // sin disparo durante el cambio
    }

    // Una pulsación NUEVA de disparo tiene prioridad sobre una recarga
    // táctica. Conserva exactamente la munición que ya estaba en el cargador:
    // no completa ni inventa balas a mitad de la animación. Con cargador vacío
    // la recarga debe alcanzar su punto válido antes de que pueda salir el tiro.
    if (s.reload > 0 && wantsFirePressed && s.mag > 0) {
      s.reload = 0;
      this.reloadInterrupted = true;
    }

    if (s.reload > 0) {
      s.reload -= dt;
      if (d.perShell) {
        // La escopeta confirma munición al cerrar cada ciclo de inserción. El
        // carry conserva el tiempo sobrante sin regalar cartuchos al iniciar.
        while (s.reload <= 0 && s.mag < d.mag && s.reserve > 0) {
          s.mag++;
          s.reserve--;
          this.reloadInserted++;
          if (s.mag < d.mag && s.reserve > 0) s.reload += d.reloadTime;
          else s.reload = 0;
        }
      } else if (s.reload <= 0) {
        const take = Math.min(d.mag - s.mag, s.reserve);
        s.mag += take; s.reserve -= take;
        s.reload = 0;
      }
      return false;
    }
    // Las automáticas aceptan tanto botón mantenido como una pulsación
    // bufereada; antes ignoraban el click encolado si se soltaba Fire antes
    // de recuperar control o terminar una recarga vacía.
    const trigger = d.auto ? (wantsFire || wantsFirePressed) : wantsFirePressed;
    if (!trigger || !canFire || s.cd > 0) return false;
    if (s.mag <= 0) return false; // seco total (la auto-recarga ya corrió arriba)
    s.mag--;
    s.cd = 60 / d.rpm;
    return true;
  }
}
