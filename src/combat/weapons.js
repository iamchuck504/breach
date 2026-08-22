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
    this._queuedTarget = null; // última intención recibida tras el punto de cambio
    this.reloadInterrupted = false; // evento de un frame para audio/animación
    this.reloadInserted = 0; // cartuchos insertados físicamente este frame
    this._reloadInterruptPending = false;
  }

  _freshState(k) {
    const d = TUNING.weapons[k];
    return { mag: d.mag, reserve: d.reserve, cd: 0, reload: 0 };
  }

  get def() { return TUNING.weapons[this.cur]; }
  get st() { return this.state[this.cur]; }
  get reloading() { return this.st.reload > 0; }
  get swapping() { return this.swapT > 0; }
  get selectionTarget() { return this._queuedTarget ?? this._swapTarget ?? this.cur; }

  reset() {
    this.slots = [...DEFAULT_LOADOUT];
    this.state = {};
    for (const k of this.slots) this.state[k] = this._freshState(k);
    this.cur = 'smg';
    this.swapT = 0;
    this._swapped = false;
    this._swapTarget = null;
    this._queuedTarget = null;
    this.reloadInterrupted = false;
    this.reloadInserted = 0;
    this._reloadInterruptPending = false;
  }

  // La muerte tiene prioridad absoluta sobre gestos del arma. Congelar el
  // swap en el arma que realmente estaba activa evita que el modelo cambie
  // sobre el cadáver y que el drop no coincida con lo que vio el jugador.
  cancelActions() {
    this.swapT = 0;
    this._swapped = false;
    this._swapTarget = null;
    this._queuedTarget = null;
    this._reloadInterruptPending = false;
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
    this._queuedTarget = null;
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
    if (this._swapTarget === removed) this._swapTarget = k;
    if (this._queuedTarget === removed) this._queuedTarget = k;
    return removed;
  }

  // Siguiente slot al ciclar (Q / rueda del mouse)
  cycleTarget(dir = 1) {
    const i = Math.max(0, this.slots.indexOf(this.selectionTarget));
    return this.slots[(i + dir + this.slots.length) % this.slots.length];
  }

  // target = id de arma (selección directa) o null para ciclar +1
  startSwap(target = null) {
    const next = target ?? this.cycleTarget(1);
    if (!next || !this.state[next]) return false;

    // Una sola animación sirve a los inputs rápidos. Antes de que cambie el
    // modelo se puede redirigir; después se conserva únicamente la intención
    // más reciente para ejecutarla al recuperar control.
    if (this.swapT > 0) {
      if (!this._swapped) {
        if (next === this._swapTarget) return false;
        this._swapTarget = next;
        this._queuedTarget = null;
        return true;
      }
      if (next === this.cur) {
        const changed = this._queuedTarget !== null;
        this._queuedTarget = null;
        return changed;
      }
      if (next === this._queuedTarget) return false;
      this._queuedTarget = next;
      return true;
    }
    if (next === this.cur) return false;
    this.swapT = SWAP_TIME;
    this._swapped = false;
    this._swapTarget = next;
    this._queuedTarget = null;
    this.st.reload = 0; // cambiar cancela la recarga
    return true;
  }

  startReload() {
    const s = this.st, d = this.def;
    if (d.thrown) return false; // la granada no recarga
    if (s.reload > 0 || this.swapT > 0 || s.mag >= d.mag || s.reserve <= 0) return false;
    s.reload = d.reloadTime;
    return true;
  }

  // Melee puede cortar una recarga de forma explícita conservando exactamente
  // la munición ya insertada. El evento sobrevive al update del mismo frame
  // para que audio/HUD no comuniquen una recarga completada.
  interruptReload() {
    if (!this.reloading) return false;
    this.st.reload = 0;
    this._reloadInterruptPending = true;
    return true;
  }

  // Progreso 0..1 de la recarga normal en curso (solo feedback del HUD).
  get reloadProgress() {
    const s = this.st, d = this.def;
    if (s.reload <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - s.reload / d.reloadTime));
  }

  // Devuelve true si disparó (o lanzó) este frame.
  update(dt, wantsFire, wantsFirePressed, canFire) {
    const s = this.st, d = this.def;
    this.reloadInterrupted = this._reloadInterruptPending;
    this._reloadInterruptPending = false;
    this.reloadInserted = 0;
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
      if (this.swapT <= 0) {
        this.swapT = 0;
        const queued = this._queuedTarget;
        this._queuedTarget = null;
        this._swapped = false;
        this._swapTarget = null;
        if (queued && queued !== this.cur && this.state[queued]) this.startSwap(queued);
      }
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
