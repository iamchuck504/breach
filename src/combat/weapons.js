// Estado de armas del jugador local: loadout multi-slot, cadencia, cargador,
// recarga y cambio de arma con animación (el modelo se intercambia a mitad
// del gesto). Slots 0/1 = primarias (un arma especial del mapa puede ocupar
// uno), 2 = pistola, 3 = granada de humo.
import { TUNING } from '../config/tuning.js';
import { specialPickupSlot } from '../game/drop-policy.js';

// exportado: el servidor deriva de aquí el instante más temprano de un cambio honesto
export const SWAP_TIME = 0.55;
// intervalo mínimo entre dos tiros (fracción del nominal) al arrastrar
// cadencia. La puerta del servidor rechaza todo intervalo < 0.82: con 0.9
// queda ≥8 ms de margen al jitter de red. Precio: a 60 Hz la SMG sigue en
// 6 cuadros (600 RPM); alternar con 5 (0.86) dejaba solo 4 ms de margen.
const MIN_GAP = 0.9;
// s que una suelta en línea espera confirmación o rechazo antes de olvidarse
export const PENDING_THROW_TTL = 4;
export const DEFAULT_LOADOUT = ['smg', 'shotgun', 'pistol', 'grenade'];
export const SPECIAL_WEAPONS = ['sniper', 'bazooka'];

// ---------- dispersión en primera persona (CONTRATO §3) ----------
// Multiplicadores sobre la base del arma (cadera o ADS). Solo multiplican:
// un arma con dispersión 0 (sniper con mira) sigue siendo exacta.
export const SPREAD_MODS = Object.freeze({
  movingHip: 0.35,      // + a velocidad de carrera (proporcional)
  movingAds: 0.25,
  crouched: 0.8,        // agachado y quieto/andando: más preciso
  sliding: 1.5,         // deslizando: se puede disparar, peor
  airborne: 1.9,        // en el aire (cadera)
  airborneAds: 1.6,
  sprintWindow: 0.4,    // s tras soltar el sprint con penalización decreciente
  sprintPenalty: 0.5,   // + al instante de soltarlo
  cap: 2.6,             // nunca más que base × cap
});

// moving: bool o 0..1 (fracción de la velocidad de carrera). sinceSprint: s
// desde que terminó el sprint (Infinity si no hubo). Devuelve GRADOS: lo
// usan el disparo y la retícula del HUD (mismo número).
export function spreadFor(weaponKey, { aim = false, moving = 0, crouched = false, sliding = false,
  airborne = false, sinceSprint = Infinity } = {}) {
  const d = TUNING.weapons[weaponKey];
  if (!d) return 0;
  const base = aim ? d.spreadAim : d.spreadHip;
  if (!(base > 0)) return 0;
  const M = SPREAD_MODS;
  const mv = Math.max(0, Math.min(1, typeof moving === 'boolean' ? (moving ? 1 : 0) : (moving || 0)));
  let k = 1 + mv * (aim ? M.movingAds : M.movingHip);
  if (sliding) k *= M.sliding;
  else if (crouched) k *= M.crouched;
  if (airborne && !sliding) k *= aim ? M.airborneAds : M.airborne;
  if (sinceSprint < M.sprintWindow) k *= 1 + M.sprintPenalty * (1 - Math.max(0, sinceSprint) / M.sprintWindow);
  return base * Math.min(M.cap, k);
}

// ---------- retroceso mecánico (separado del cosmético) ----------
// Patrón fijo por disparo dentro de una ráfaga: la cámara aplica `pitch`/`yaw`
// (radianes) como desvío real de la mira; el viewmodel lee el mismo valor
// para su gesto. Magnitud vertical = la de siempre (recoil × 0.006 rad por
// tiro, lo que main.js ya pasaba a addPitchRecoil); el lateral es pequeño y
// alterna con un dibujo fijo, nunca aleatorio (se aprende).
const YAW_PATTERN = [0, 0.55, -0.35, 0.75, -0.6, 0.3, -0.85, 0.5, -0.2, 0.9, -0.7, 0.15];
export function recoilKick(weaponKey, shot = 0, { aim = false } = {}) {
  const d = TUNING.weapons[weaponKey];
  if (!d) return { pitch: 0, yaw: 0 };
  const pitch = (d.recoil || 0) * 0.006;
  const lateral = (d.recoil || 0) * 0.0025 * (aim ? 0.7 : 1);
  const i = Math.max(0, shot | 0);
  // el primer tiro de la ráfaga sale recto en horizontal
  return { pitch, yaw: lateral * YAW_PATTERN[i % YAW_PATTERN.length] };
}

// ---------- líneas de tiempo de recarga (eventos reloadStep) ----------
// t en 0..1 de la duración REAL de la recarga; coinciden con las piezas de
// sonido de fx/audio.js (mag_out 0.15, mag_in 0.62… y la pieza final al
// completar). La escopeta emite `shellIn` por cartucho y `pump` al cerrar.
// VISTA puede sustituirlas con setReloadTimeline() desde su perfil de arma.
const RELOAD_TIMELINES = {
  smg: [{ t: 0.15, step: 'magOut' }, { t: 0.62, step: 'magIn' }, { t: 1, step: 'boltRelease' }],
  pistol: [{ t: 0.12, step: 'magOut' }, { t: 0.55, step: 'magIn' }, { t: 1, step: 'slideRelease' }],
  sniper: [{ t: 0.08, step: 'boltOpen' }, { t: 0.5, step: 'roundIn' }, { t: 1, step: 'boltClose' }],
  bazooka: [{ t: 0.25, step: 'rocketIn' }, { t: 1, step: 'tubeLock' }],
  stun: [{ t: 0.15, step: 'charge' }, { t: 1, step: 'ready' }],
  shotgun: [],
};
export function reloadTimeline(weaponKey) { return RELOAD_TIMELINES[weaponKey] ?? []; }
export function setReloadTimeline(weaponKey, steps) {
  if (!Array.isArray(steps)) return;
  RELOAD_TIMELINES[weaponKey] = steps
    .filter((s) => s && typeof s.step === 'string' && Number.isFinite(s.t))
    .map((s) => ({ t: Math.max(0, Math.min(1, s.t)), step: s.step }))
    .sort((a, b) => a.t - b.t);
}

// Eventos (CONTRATO §4): fire, dry, reloadStart, reloadStep, reloadEnd,
// reloadCancel, swapStart, swapMid, swapEnd, meleeStart, meleeHit,
// throwStart, throwRelease. Extra: swapRetarget (redirigir antes del punto
// de cambio), swapCancel (muerte/recogida corta el gesto).
export const WEAPON_EVENTS = Object.freeze(['fire', 'dry', 'reloadStart', 'reloadStep', 'reloadEnd',
  'reloadCancel', 'swapStart', 'swapMid', 'swapEnd', 'swapRetarget', 'swapCancel',
  'meleeStart', 'meleeHit', 'throwStart', 'throwRelease', 'throwCancel', 'throwRefund']);

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
    // PRÁCTICA: munición infinita — la reserva nunca baja (recargas eternas,
    // especiales incluidas) y la granada no se agota. Lo setea main por modo;
    // reset() no lo toca para sobrevivir a los respawns.
    this.infinite = false;
    this._listeners = new Map();
    this._throw = null;      // { weapon, t, release, total, released }
    this._afterThrow = null; // cambio pedido durante el gesto de lanzar
    this._throwSeq = 0;
    this._pending = new Map(); // id → { weapon, life, age }: sueltas EN LÍNEA sin confirmar
    // En línea (lo fija main por modo): solo entonces hay reembolsos posibles.
    // Offline nadie rechaza: no se crean pendientes.
    this.online = false;
    this.life = 0;           // vida actual (newLife() al reaparecer)
    this._quick = null;      // granada rápida: { grenade, returnTo }
    this._autoFire = false;
    this._prevPressed = false;
    this.burst = 0;          // tiro dentro de la ráfaga (patrón de retroceso)
    this._sinceShot = Infinity;
    this.lastKick = { pitch: 0, yaw: 0, shot: 0, weapon: null };
  }

  // ---------- emisor (fuente única para viewmodel, audio y HUD) ----------
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this._listeners.get(event)?.delete(fn); }
  _emit(event, data = {}) {
    const set = this._listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error('[weapons]', event, e); }
    }
  }
  _cancelReload(k = this.cur) {
    const st = this.state[k];
    if (!st || st.reload <= 0) return false;
    st.reload = 0;
    this._emit('reloadCancel', { weapon: k });
    return true;
  }
  // El golpe lo decide el controller; el arma solo publica el suceso para
  // que viewmodel/audio/HUD no tengan otra fuente. TODO integración: main.js
  // llama noteMelee('start') en onMeleeStart y noteMelee('hit', {...}) al
  // resolver el contacto.
  noteMelee(phase, data = {}) {
    if (phase === 'start') this._emit('meleeStart', { weapon: this.cur, ...data });
    else if (phase === 'hit') this._emit('meleeHit', { weapon: this.cur, ...data });
  }
  get throwing() { return !!this._throw; }
  // gesto de lanzar comprometido (entre throwStart y throwRelease)
  get throwCommitted() { return !!this._throw && !this._throw.released; }
  // Arma a la que se volverá tras el gesto en curso (null si ninguna).
  get returnTarget() { return this._afterThrow ?? this._quick?.returnTo ?? null; }

  // DECISIONES 18: el servidor rechazó un lanzamiento (`nadeReject`): se
  // devuelve el bote gastado. Solo arrojadizos que se llevan y sin pasar del
  // máximo del arma. Emite `throwRefund {weapon, mag}` (HUD: contador).
  //
  // Reembolso ATADO a una suelta propia pendiente: `id` es el de
  // `throwRelease {weapon, id}` (también vale un cid que termine en `:id`).
  // Una sola vez por id; ids ajenos (bots alojados), repetidos, ya
  // confirmados o de una vida/ronda anterior no hacen nada.
  // `life` (opcional): la vida que trae el rechazo; si no coincide, nada.
  refundThrow(idOrCid, { life } = {}) {
    const id = typeof idOrCid === 'string' ? idOrCid.split(':').pop() : null;
    const p = id && this._pending.get(id);
    if (!p) return false;
    if (p.life !== this.life || (life != null && life !== p.life)) return false;
    this._pending.delete(id);
    const d = TUNING.weapons[p.weapon], st = this.state[p.weapon];
    if (!d?.thrown || !st || st.mag >= d.mag) return false;
    st.mag++;
    this._emit('throwRefund', { weapon: p.weapon, id, mag: st.mag });
    return true;
  }
  // El servidor aceptó la suelta (`nadeAck`): ya no se puede reembolsar.
  confirmThrow(idOrCid) {
    const id = typeof idOrCid === 'string' ? idOrCid.split(':').pop() : null;
    return !!id && this._pending.delete(id);
  }
  // Muerte, cambio de ronda, desconexión: se olvidan las sueltas pendientes.
  clearPendingThrows() { this._pending.clear(); }
  // Reaparecer: vida nueva; lo pendiente de la anterior ya no se reembolsa.
  newLife(serverLife) {
    this.life = Number.isSafeInteger(serverLife) ? serverLife : this.life + 1;
    this._pending.clear();
  }
  get pendingThrows() { return [...this._pending.keys()]; }
  // Gesto de lanzar cortado ANTES de soltar (aturdido, muerte, cambio
  // forzado): no cuesta nada y avisa una vez. Tras soltar solo se olvida.
  _cancelThrow() {
    const th = this._throw;
    if (th && !th.released) this._emit('throwCancel', { weapon: th.weapon });
    this._throw = null; this._quick = null; this._autoFire = false; this._afterThrow = null;
  }
  get quickThrowActive() { return !!this._quick; }

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
    if (this.swapT > 0) this._emit('swapCancel', { weapon: this.cur });
    this._cancelReload();
    this._cancelThrow();
    this._pending.clear();
    this.burst = 0; this._sinceShot = Infinity; this._prevPressed = false;
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
    this._credit = 0;
  }

  // La muerte tiene prioridad absoluta sobre gestos del arma. Congelar el
  // swap en el arma que realmente estaba activa evita que el modelo cambie
  // sobre el cadáver y que el drop no coincida con lo que vio el jugador.
  cancelActions() {
    if (this.swapT > 0) this._emit('swapCancel', { weapon: this.cur });
    for (const k of this.slots) this._cancelReload(k);
    this._cancelThrow();
    // (aturdido/muerte NO tocan las sueltas ya hechas: un rechazo en vuelo
    // se reembolsa igual; la vida nueva las anula con newLife())
    this.swapT = 0;
    this._swapped = false;
    this._swapTarget = null;
    this._queuedTarget = null;
    this._reloadInterruptPending = false;
    this._credit = 0;
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
    this._cancelReload();
  }

  // Arma primaria de referencia (para drops cuando la actual no es soltable)
  get primary() { return this.slots[0]; }

  hasWeapon(k) { return this.slots.includes(k); }

  // El arma especial del mapa reemplaza la primaria EN MANO (o el slot 0 si
  // llevas pistola/granada). Devuelve el id del arma que salió del loadout.
  giveSpecial(k) {
    // misma regla que el servidor (drop-policy.js)
    const idx = specialPickupSlot(this.slots, this.cur, k);
    const removed = this.slots[idx];
    if (this.swapT > 0) this._emit('swapCancel', { weapon: this.cur });
    this._cancelReload();
    this._cancelThrow(); // cambio forzado: el gesto sin soltar no cuesta
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
    // la recarga del arma que sale se corta con su evento (toda cancelación avisa)
    this._cancelReload(removed);
    if (this._throw && this._throw.weapon === removed) this._cancelThrow();
    if (this._quick && (this._quick.grenade === removed || this._quick.returnTo === removed)) { this._quick = null; this._autoFire = false; }
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
  startSwap(target = null, { quick = false } = {}) {
    const next = target ?? this.cycleTarget(1);
    if (!next || !this.state[next]) return false;
    // un cambio pedido a mano anula la granada rápida pendiente
    if (!quick && this._quick && next !== this._quick.grenade) { this._quick = null; this._autoFire = false; }
    // con el gesto de lanzar en curso, el cambio espera a que termine
    // (último bote → primaria, vuelta de la granada rápida, o a mano)
    if (this._throw) {
      if (next === this.cur) { const had = !!this._afterThrow; this._afterThrow = null; return had; }
      if (next === this._afterThrow) return false;
      this._afterThrow = next;
      return true;
    }

    // Una sola animación sirve a los inputs rápidos. Antes de que cambie el
    // modelo se puede redirigir; después se conserva únicamente la intención
    // más reciente para ejecutarla al recuperar control.
    if (this.swapT > 0) {
      if (!this._swapped) {
        if (next === this._swapTarget) return false;
        this._swapTarget = next;
        this._queuedTarget = null;
        this._emit('swapRetarget', { to: next });
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
    // de dónde se viene al sacar un arrojadizo (vuelta tras el último bote)
    if (TUNING.weapons[next]?.thrown && !TUNING.weapons[this.cur]?.thrown) this._cameFrom = this.cur;
    this.swapT = SWAP_TIME;
    this._swapped = false;
    this._swapTarget = next;
    this._queuedTarget = null;
    this._cancelReload(); // cambiar cancela la recarga
    this._emit('swapStart', { from: this.cur, to: next, total: SWAP_TIME });
    return true;
  }

  // Granada rápida: cambia al arrojadizo, lo lanza en cuanto se pueda y, al
  // soltarlo, vuelve al arma anterior. Cada paso es el de siempre (cambio
  // honesto + lanzamiento), así que las reglas de cadencia del servidor se
  // cumplen por construcción. Devuelve false si no hay botes o ya hay uno.
  quickThrow() {
    if (this._throw || this._quick) return false;
    const g = this.slots.find((k) => TUNING.weapons[k]?.thrown && this.state[k]?.mag > 0);
    if (!g) return false;
    if (this.cur === g && this.swapT <= 0) { this._autoFire = true; this._quick = { grenade: g, returnTo: null }; return true; }
    const returnTo = this._swapTarget ?? this.cur;
    if (!this.startSwap(g, { quick: true }) && this.selectionTarget !== g) return false;
    this._quick = { grenade: g, returnTo: returnTo === g ? null : returnTo };
    this._autoFire = true;
    return true;
  }

  // El gatillo se soltó (aunque se volviera a pulsar antes del paso): el
  // siguiente tiro no hereda el sobrante del anterior.
  dropCadenceCredit() { this._credit = 0; }

  startReload() {
    const s = this.st, d = this.def;
    if (d.thrown || this.cur==='stun') return false;
    if (s.reload > 0 || this.swapT > 0 || s.mag >= d.mag ||
        (!this.infinite && s.reserve <= 0)) return false;
    s.reload = d.reloadTime;
    // duración total prevista (la escopeta: un ciclo por cartucho que cabe)
    const shells = d.perShell ? Math.min(d.mag - s.mag, this.infinite ? d.mag : s.reserve) : 1;
    this._emit('reloadStart', { weapon: this.cur, total: d.reloadTime * shells });
    return true;
  }

  // Melee puede cortar una recarga de forma explícita conservando exactamente
  // la munición ya insertada. El evento sobrevive al update del mismo frame
  // para que audio/HUD no comuniquen una recarga completada.
  interruptReload() {
    if (!this.reloading) return false;
    this._cancelReload();
    this._reloadInterruptPending = true;
    return true;
  }

  // Progreso 0..1 de la recarga normal en curso (solo feedback del HUD).
  get reloadProgress() {
    const s = this.st, d = this.def;
    if (s.reload <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - s.reload / d.reloadTime));
  }

  // Devuelve true si disparó (o lanzó) este frame. `canHandle` = las manos
  // están libres para el arma (false durante melee y su recovery).
  update(dt, wantsFire, wantsFirePressed, canFire, canHandle = true) {
    const s = this.st, d = this.def;
    this.reloadInterrupted = this._reloadInterruptPending;
    this._reloadInterruptPending = false;
    this.reloadInserted = 0;
    // cooldown del arma en mano al empezar el paso: si se agota DENTRO del
    // paso, el tiempo que ya lleva lista se arrastra al siguiente tiro.
    // El crédito vive APARTE del cd y se consume en cada paso: solo lo
    // conserva la espera con el gatillo aún pendiente (abajo); soltar,
    // recargar, cambiar, melee o estar bloqueado lo pierden.
    const cdBefore = s.cd;
    const credit = this._credit || 0;
    this._credit = 0;
    // el cooldown corre para TODAS las armas (guardarlas no lo congela)
    for (const k of this.slots) this.state[k].cd = Math.max(0, this.state[k].cd - dt);
    // flanco de la intención de disparo (gatillo en seco: una vez por pulsación)
    const pressedEdge = wantsFirePressed && !this._prevPressed;
    this._prevPressed = !!wantsFirePressed;
    this._sinceShot += dt;
    // pendientes con caducidad: una suelta que el servidor nunca confirma
    // (frag aceptada responde con otro mensaje, pérdida de red) no se queda
    for (const [id, p] of this._pending) if ((p.age += dt) > PENDING_THROW_TTL) this._pending.delete(id);
    // gesto de lanzamiento: la suelta y el final se publican una sola vez,
    // aunque un paso largo cruce ambos instantes
    if (this._throw) {
      const th = this._throw;
      th.t += dt;
      if (!th.released && th.t >= th.release) {
        th.released = true;
        // el bote se cobra AQUÍ (lo que el servidor cuenta con `nade`); la
        // granada de humo en práctica se repone sola
        const ts = this.state[th.weapon], td = TUNING.weapons[th.weapon];
        if (ts && ts.mag > 0) {
          ts.mag--;
          if (this.infinite && th.weapon !== 'frag') ts.mag = td.mag;
        }
        const id = `t${++this._throwSeq}`;
        if (this.online) this._pending.set(id, { weapon: th.weapon, life: this.life, age: 0 });
        this._emit('throwRelease', { weapon: th.weapon, id });
        // granada rápida: de vuelta al arma anterior en la suelta (como hace
        // main.js con el último bote)
        // (la vuelta espera al FINAL del gesto: la mano sigue lanzando)
        if (this._quick && this._quick.grenade === th.weapon) {
          const back = this._quick.returnTo;
          this._quick = null;
          if (back && this.state[back] && back !== this.cur) this._afterThrow = back;
        }
      }
      if (th.t >= th.total) {
        this._throw = null;
        let next = this._afterThrow;
        this._afterThrow = null;
        // último bote sin otra selección: Weapons decide la vuelta → el arma
        // de la que se vino (pistola incluida), o la primaria si ya no está
        if (!next && this.cur === th.weapon && this.state[th.weapon]?.mag <= 0) {
          next = this._cameFrom && this.state[this._cameFrom] && !TUNING.weapons[this._cameFrom]?.thrown
            ? this._cameFrom : this.primary;
        }
        if (next && this.state[next] && next !== this.cur) this.startSwap(next, { quick: true });
      }
    }

    // auto-recarga al quedarse sin balas (sin esperar otro click). No con
    // las manos ocupadas: el melee cancela la recarga y, sin esta puerta, la
    // misma actualización la reiniciaba y la escopeta metía un cartucho a
    // mitad de la patada con la pose de recarga suprimida. Arranca al salir.
    if (canHandle && s.mag === 0 && s.reload === 0 && this.swapT === 0 &&
        (this.infinite || s.reserve > 0) && !d.thrown) {
      this.startReload();
    }

    if (this.swapT > 0) {
      this.swapT -= dt;
      if (!this._swapped && this.swapT <= SWAP_TIME / 2) {
        this._swapped = true;
        if (this._swapTarget && this.state[this._swapTarget]) this.cur = this._swapTarget;
        this._swapTarget = null;
        this._emit('swapMid', { weapon: this.cur });
      }
      if (this.swapT <= 0) {
        this.swapT = 0;
        const queued = this._queuedTarget;
        this._queuedTarget = null;
        this._swapped = false;
        this._swapTarget = null;
        this._emit('swapEnd', { weapon: this.cur });
        if (queued && queued !== this.cur && this.state[queued]) this.startSwap(queued);
      }
      return false; // sin disparo durante el cambio
    }

    // Una pulsación NUEVA de disparo tiene prioridad sobre una recarga
    // táctica. Conserva exactamente la munición que ya estaba en el cargador:
    // no completa ni inventa balas a mitad de la animación. Con cargador vacío
    // la recarga debe alcanzar su punto válido antes de que pueda salir el tiro.
    if (s.reload > 0 && wantsFirePressed && s.mag > 0) {
      this._cancelReload();
      this.reloadInterrupted = true;
    }

    if (s.reload > 0) {
      const p0 = 1 - s.reload / d.reloadTime;
      s.reload -= dt;
      if (d.perShell) {
        // La escopeta confirma munición al cerrar cada ciclo de inserción. El
        // carry conserva el tiempo sobrante sin regalar cartuchos al iniciar.
        while (s.reload <= 0 && s.mag < d.mag && (this.infinite || s.reserve > 0)) {
          s.mag++;
          if (!this.infinite) s.reserve--;
          this.reloadInserted++;
          this._emit('reloadStep', { weapon: this.cur, name: 'shellIn', index: this.reloadInserted });
          if (s.mag < d.mag && (this.infinite || s.reserve > 0)) s.reload += d.reloadTime;
          else s.reload = 0;
        }
        if (s.reload <= 0) {
          s.reload = 0;
          this._emit('reloadStep', { weapon: this.cur, name: 'pump' });
          this._emit('reloadEnd', { weapon: this.cur });
        }
      } else {
        const done = s.reload <= 0;
        const p1 = done ? 1 : 1 - s.reload / d.reloadTime;
        // cada paso de la línea de tiempo UNA vez: los que caen en (p0, p1]
        // (los de t = 1 salen tras confirmar la munición: el cierre suena con
        // el cargador ya lleno, como reloadDone del audio)
        const tl = reloadTimeline(this.cur);
        for (const step of tl) {
          if (step.t > p0 && step.t <= p1 && step.t < 1) this._emit('reloadStep', { weapon: this.cur, name: step.step });
        }
        if (done) {
          const take = Math.min(d.mag - s.mag, this.infinite ? d.mag : s.reserve);
          s.mag += take;
          if (!this.infinite) s.reserve -= take;
          s.reload = 0;
          for (const step of tl) if (step.t >= 1) this._emit('reloadStep', { weapon: this.cur, name: step.step });
          this._emit('reloadEnd', { weapon: this.cur });
        }
      }
      return false;
    }
    // Las automáticas aceptan tanto botón mantenido como una pulsación
    // bufereada; antes ignoraban el click encolado si se soltaba Fire antes
    // de recuperar control o terminar una recarga vacía.
    // granada rápida: el lanzamiento sale solo en cuanto el arrojadizo está en mano
    const auto = this._autoFire && d.thrown;
    const trigger = auto || (d.auto ? (wantsFire || wantsFirePressed) : wantsFirePressed);
    if (!trigger || !canFire || !canHandle) return false;
    if (this._throw) return false; // un gesto de lanzamiento a la vez
    // listo = cooldown cubierto por el crédito, y nunca antes de MIN_GAP del
    // nominal desde el tiro anterior (cd ≤ (1−MIN_GAP)·intervalo)
    const gapLeft = (60 / d.rpm) * (1 - MIN_GAP);
    if (s.cd > Math.min(credit, gapLeft)) { this._credit = credit; return false; }
    if (s.mag <= 0) {
      // seco total (la auto-recarga ya corrió arriba): un aviso por pulsación
      if (pressedEdge && !d.thrown) this._emit('dry', { weapon: this.cur });
      if (auto) { this._autoFire = false; this._quick = null; }
      return false;
    }
    // los arrojadizos se pagan AL SOLTAR (un gesto interrumpido no cuesta)
    if (!d.thrown) s.mag--;
    // Arrastre de cadencia: sin él cada tiro esperaba al primer paso entero
    // tras agotarse el cooldown y la SMG de 620 RPM daba 600 a 60 Hz, 563 a
    // 75 y 617 a 144. Crédito = cuánto antes de este fin de paso quedó lista
    // según el horario nominal (incluido lo que MIN_GAP retrasó); solo si
    // seguía en cadena al empezar el paso, y acotado a medio intervalo.
    const interval = 60 / d.rpm;
    const left = cdBefore - credit; // lo que faltaba al empezar el paso
    this._credit = cdBefore > 0 ? Math.min(interval * 0.5, Math.max(0, dt - left)) : 0;
    s.cd = interval;
    if (d.thrown) {
      this._autoFire = false;
      this._throw = { weapon: this.cur, t: 0, release: d.throwRelease ?? 0.28, total: d.throwTime ?? 0.5, released: false };
      this._emit('throwStart', { weapon: this.cur, total: this._throw.total, release: this._throw.release });
    } else {
      // ráfaga: el patrón sigue si el tiro llega dentro del ritmo del arma
      this.burst = this._sinceShot <= interval + 0.25 ? this.burst + 1 : 0;
      this._sinceShot = 0;
      const kick = recoilKick(this.cur, this.burst, { aim: !!this.aimHint });
      this.lastKick = { ...kick, shot: this.burst, weapon: this.cur };
      this._emit('fire', { weapon: this.cur, shot: this.burst, kick, visual: d.recoil || 0 });
    }
    return true;
  }
}
