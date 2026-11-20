// Guardas de transporte y autoridad básica. Se mantienen fuera del servidor
// principal para poder probarlas sin levantar una partida completa.
import { TUNING } from '../src/config/tuning.js';
import { SWAP_TIME } from '../src/combat/weapons.js';

export const MAX_WS_PAYLOAD = 32 * 1024;
export const MESSAGE_RATE = 240;
export const MESSAGE_BURST = 360;

const NORMAL_WEAPONS = ['smg', 'shotgun', 'pistol'];
const SPECIAL_WEAPONS = new Set(['sniper', 'bazooka']);
const MAX_MOVE_SPEED = 16.5;
const MAX_MOVE_CREDIT = 7;
const MAX_VERTICAL_SPEED = 12;
const MAX_VERTICAL_CREDIT = 3;

const totalAmmo = (weapon) => {
  const d = TUNING.weapons[weapon];
  return d ? Math.max(0, (d.mag || 0) + (d.reserve || 0)) : 0;
};

export function createAmmoBudget() {
  return {
    smg: totalAmmo('smg'),
    shotgun: totalAmmo('shotgun'),
    pistol: totalAmmo('pistol'),
    sniper: 0,
    bazooka: 0,
  };
}

export function refillNormalAmmo(entity) {
  entity.ammoBudget ||= createAmmoBudget();
  for (const weapon of NORMAL_WEAPONS) {
    entity.ammoBudget[weapon] = totalAmmo(weapon);
    resetMagazine(entity, weapon); // caja de munición = cargadores llenos
  }
}

// Un arma (re)concedida llega con su cargador como la de un jugador: lleno o
// el `mag` informado del arma del suelo. Sin esto, una especial agotada y
// recogida de nuevo en la misma vida conservaba el cargador vacío.
function resetMagazine(entity, weapon, mag = null) {
  const d = TUNING.weapons[weapon];
  if (!entity.botMag || !d?.mag) return;
  const budget = Math.floor(Number(entity.ammoBudget?.[weapon] || 0));
  const m = mag === null ? d.mag : Math.max(0, Math.min(d.mag, Math.floor(Number(mag) || 0)));
  entity.botMag[weapon] = { mag: Math.min(m, budget), lastAt: -Infinity, budget: entity.ammoBudget };
}

export function grantWeaponAmmo(entity, weapon, mag = null, reserve = null) {
  if (!entity || !TUNING.weapons[weapon]) return 0;
  entity.ammoBudget ||= createAmmoBudget();
  const fallback = totalAmmo(weapon);
  const reported = Number(mag || 0) + Number(reserve || 0);
  const amount = mag === null && reserve === null
    ? fallback
    : (Number.isFinite(reported) ? Math.max(0, Math.min(fallback, reported)) : 0);
  entity.ammoBudget[weapon] = Math.round(amount);
  resetMagazine(entity, weapon, mag);
  return entity.ammoBudget[weapon];
}

// Cargador de un bot alojado: el host simula cargador, reserva y recarga con
// las reglas del jugador (botmatch.js), así que el servidor puede exigirlas.
// Modelo de COTA SUPERIOR: durante cada silencio de esa arma se acredita la
// recarga que cabía en él (entero tras reloadTime, o un cartucho por cada
// reloadTime en la escopeta), con BOT_RELOAD_TOL de jitter. Un bot honesto
// nunca dispara sin munición real, así que nunca queda por debajo; un host
// que dispara más de un cargador sin la pausa de recarga, sí.
// Holgura de host: la misma para TODAS las armas. Cubre el jitter de llegada
// entre el último tiro del cargador y el primero tras la recarga (el host los
// emite separados por la recarga entera; la red puede acercarlos hasta ~2×30
// ms) más el redondeo del paso del host. SMG: 1.90 s → ≥ 1.75 s entre llegadas.
export const BOT_RELOAD_TOL = 0.15;
function botMagazineAllows(entity, weapon, now, commit) {
  const d = TUNING.weapons[weapon];
  // armas con cargador real en el host: normales y especiales (sniper/bazooka)
  if (!d?.mag || !(NORMAL_WEAPONS.includes(weapon) || SPECIAL_WEAPONS.has(weapon))) return true;
  entity.botMag ||= {};
  let m = entity.botMag[weapon];
  // presupuesto nuevo (respawn / inicio de ronda) = armas nuevas
  if (!m || m.budget !== entity.ammoBudget) {
    m = { mag: Math.min(d.mag, Math.floor(Number(entity.ammoBudget?.[weapon] || 0))), lastAt: -Infinity, budget: entity.ammoBudget };
  }
  // reserva DERIVADA del presupuesto total (cajas y munición del suelo suman ahí)
  let mag = m.mag, reserve = Math.max(0, Math.floor(Number(entity.ammoBudget?.[weapon] || 0)) - mag);
  const gap = now - m.lastAt + BOT_RELOAD_TOL;
  if (mag < d.mag && reserve > 0 && gap >= d.reloadTime) {
    const room = d.mag - mag;
    const take = Math.min(room, reserve, d.perShell ? Math.floor(gap / d.reloadTime) : room);
    mag += take; reserve -= take;
  }
  if (mag <= 0) return false;
  if (commit) { m.mag = mag - 1; m.lastAt = now; entity.botMag[weapon] = m; }
  return true;
}

export function consumeShotAmmo(entity, weapon, now = Date.now() / 1000) {
  if (weapon === 'melee') return true;
  if (!entity) return false;
  entity.ammoBudget ||= createAmmoBudget();
  // Bots alojados: mismo presupuesto total que un jugador y, además, cargador
  // y tiempo de recarga (arriba). Las especiales, solo presupuesto.
  if (entity.bot && !botMagazineAllows(entity, weapon, now, false)) return false;
  const left = Math.floor(Number(entity.ammoBudget[weapon] || 0));
  if (left <= 0) return false;
  // el cargador se actualiza ANTES de descontar: su reserva sale del presupuesto
  if (entity.bot) botMagazineAllows(entity, weapon, now, true);
  entity.ammoBudget[weapon] = left - 1;
  return true;
}

export function resetMovementGuard(entity, now) {
  entity.motionGuard = {
    at: now,
    moveCredit: MAX_MOVE_CREDIT,
    verticalCredit: MAX_VERTICAL_CREDIT,
    rejected: 0,
  };
}

export function acceptMovement(entity, next, now, bypass = false) {
  if (!entity || !next || ![next.x, next.y, next.z].every(Number.isFinite)) return false;
  if (!entity.motionGuard) resetMovementGuard(entity, now);
  const guard = entity.motionGuard;
  const dt = Math.max(0, Math.min(1, now - guard.at));
  guard.at = now;
  if (bypass) {
    guard.moveCredit = MAX_MOVE_CREDIT;
    guard.verticalCredit = MAX_VERTICAL_CREDIT;
    guard.rejected = 0;
    return true;
  }
  guard.moveCredit = Math.min(MAX_MOVE_CREDIT, guard.moveCredit + MAX_MOVE_SPEED * dt);
  guard.verticalCredit = Math.min(MAX_VERTICAL_CREDIT,
    guard.verticalCredit + MAX_VERTICAL_SPEED * dt);
  const horizontal = Math.hypot(next.x - (entity.x || 0), next.z - (entity.z || 0));
  const vertical = Math.abs(next.y - (entity.y || 0));
  if (horizontal > guard.moveCredit + 0.01 || vertical > guard.verticalCredit + 0.01) {
    guard.rejected++;
    return false;
  }
  guard.moveCredit = Math.max(0, guard.moveCredit - horizontal);
  guard.verticalCredit = Math.max(0, guard.verticalCredit - vertical);
  guard.rejected = 0;
  return true;
}

export class MessageRateGuard {
  constructor(now, rate = MESSAGE_RATE, burst = MESSAGE_BURST) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  allow(now, bytes = 0) {
    const dt = Math.max(0, Math.min(2, now - this.at));
    this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    const cost = Math.max(1, Math.ceil(Math.max(0, bytes) / 2048));
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

// Cadencia de disparo autoritativa, por arma, sobre un horario virtual:
// cada tiro aceptado ocupa la "hora virtual" vt = vt_anterior + intervalo.
// - Se acepta si vt ≤ ahora + 18 % del intervalo: tras estar quieto la pareja
//   de apertura sigue a ≥82 % (la regla histórica) y a largo plazo no caben
//   más tiros que el RPM configurado.
// - vt puede quedarse ATRÁS del reloj (crédito): FIRE_JITTER_CREDIT siempre
//   (jitter de red), y además el silencio de transporte que precedió a la
//   ráfaga actual, gastándose con el tiempo (≤ FIRE_STALL_CREDIT): tiros
//   honestos que llegan juntos tras un atasco TCP pasan; un atacante que
//   sigue enviando estados no acumula ráfagas. El crédito nunca suma tiros:
//   solo deja entrar los que el horario nominal ya debía. Capacidad: 300 ms
//   = un atasco de 200 ms + el intervalo de la SMG.
// - TOPE DE APLICACIÓN: en cualquier ventana móvil de 100/200/400/1000 ms
//   nunca se aplican más tiros de un arma que los que permitía la regla de
//   HEAD (intervalo ≥ 82 %): ⌊W / (0.82·intervalo)⌋ + 1 (SMG: 2/3/6/13).
//   Lo que el horario debía tras un atasco y no cabe se DESCARTA, no se
//   encola: aplicarlo después exigiría diferir sus claims y su instante de
//   rebobinado, y un tiro aplicado tarde golpea donde el defensor ya no está.
// - Cambiar de arma exige EVIDENCIA del cambio: el `w` replicado del tirador
//   pasó a SER esta arma después de su último tiro con otra, y hace ≥ 0.1 s
//   (el cliente publica el arma nueva a mitad del gesto de 0.55 s y dispara
//   al terminarlo). Sin dato (bots alojados) se mantiene el tiempo mínimo.
// - `sq` (opcional, creciente) descarta duplicados y repeticiones.
export const FIRE_SLACK = 0.18;
export const FIRE_STALL_CREDIT = 0.3;
export const FIRE_JITTER_CREDIT = 0.04;
// Llamar en CADA mensaje del cliente: un hueco mayor que la cadencia de
// estados (20 Hz) es evidencia de atasco y abre crédito para lo que llega.
export function noteMessageArrival(entity, now) {
  const gap = now - (entity.msgAt ?? now);
  if (gap > 0.075) { entity.stallCredit = Math.min(FIRE_STALL_CREDIT, gap); entity.stallAt = now; }
  entity.msgAt = now;
  // orden de llegada (TCP conserva el del envío): "el cambio se publicó
  // DESPUÉS del tiro" se decide por orden, no por reloj, que un atasco aplasta
  entity.msgSeq = (entity.msgSeq ?? 0) + 1;
}
// silencio de transporte vigente (atasco que pudo retrasar el mensaje actual)
export const stallRemaining = (entity, now) =>
  Math.max(0, (entity.stallCredit ?? 0) - (now - (entity.stallAt ?? -Infinity)));
export const FIRE_CHAIN_IDLE = 0.35;
export const FIRE_SWAP_GAP = 0.55 * 0.82;
// el cliente publica el arma nueva a mitad del gesto (0.275 s) en el siguiente
// estado (20 Hz) y dispara al terminar (0.55 s): ≥ 0.175 s entre ambos antes
// del jitter; 0.1 s deja margen a ±30 ms sin rechazar a nadie honesto
export const FIRE_SWAP_EVIDENCE = 0.1;
export const FIRE_WINDOWS = [0.1, 0.2, 0.4, 1];
// Entre dos acciones aceptadas con armas DISTINTAS el hueco mínimo es lo más
// pronto que un cliente honesto puede encadenarlas − FIRE_NET_TOL (nunca
// rechaza a un honesto; es al menos tan estricto como HEAD donde HEAD era
// más laxo que el juego). Instantes derivados de la máquina de estados del
// cliente (tiempo continuo; los cuadros solo lo alargan):
// - arma → otra arma: el cambio empieza como pronto en el paso del tiro
//   (main.js lo procesa tras weapons.update), dura SWAP_TIME y el paso en que
//   termina no dispara (weapons.js) → SWAP_TIME. El modelo cambia a mitad del
//   gesto, pero `canFire` no vuelve hasta el final.
// - …→ arrojadizo (humo/frag): tras el cambio, la suelta llega en throwRelease
//   del gesto de lanzamiento (main.js). El stun dispara al instante.
// - arrojadizo → arma: con el último bote main.js cambia a la primaria en la
//   suelta → SWAP_TIME (si quedan botes el gesto termina antes: más tarde).
// - arma → patada: la patada empieza al paso siguiente (controller.js corre
//   antes que el arma: en el mismo paso el tiro ya no sale) y el golpe —el
//   mensaje `melee`— llega con meleeT ≥ hitAt.
// - arrojadizo → patada: la patada está bloqueada mientras dura el gesto de
//   lanzamiento (throwTime − throwRelease tras la suelta) → + hitAt.
// - patada → arma EN MANO durante la patada: golpe conectado = congelación
//   (hitStop) + hitRecovery antes de salir del estado melee (los fallos y las
//   bajas tardan más); con arrojadizo, + throwRelease.
// - patada → arma GUARDADA: durante melee no se puede cambiar de arma, así que
//   además del recovery va el gesto entero (SWAP_TIME), y la evidencia del
//   cambio tiene que ser posterior a la patada.
// - recogida de la especial: el arma queda en mano al instante (≈ 0).
// SIN crédito de atasco: un cliente que calla a propósito podría apilar dos
// armas antes de lo que permite el juego. Coste asumido: un atasco real ≥ 150
// ms justo en el cambio puede costar el primer tiro tras él (raro).
export const FIRE_NET_TOL = 0.06; // ±30 ms de jitter entre las dos llegadas
const THROWN = new Set(['grenade', 'frag']);
export function honestCrossGap(prev, next, held = prev, pickup = false) {
  const ml = TUNING.melee, g = TUNING.weapons.grenade;
  if (pickup) return 0;
  if (next === 'melee') return (THROWN.has(prev) ? g.throwTime - g.throwRelease : 0) + ml.hitAt;
  if (prev === 'melee') {
    return ml.hitStop + ml.hitRecovery + (next === held ? 0 : SWAP_TIME) + (THROWN.has(next) ? g.throwRelease : 0);
  }
  return SWAP_TIME + (THROWN.has(next) ? g.throwRelease : 0);
}
export const crossWeaponFloor = (prev, next, held = prev, pickup = false) =>
  Math.max(0, honestCrossGap(prev, next, held, pickup) - FIRE_NET_TOL);
export const fireWindowCap = (w, interval) => Math.floor(w / (interval * 0.82) + 1e-9) + 1;
// motivo del último rechazo (diagnóstico; no cambia ninguna decisión)
const why = (entity, reason) => { entity.lastRejectReason = reason; return null; };
export function fireCadenceVerdict(entity, weapon, interval, now, meta = {}) {
  if (Number.isFinite(meta.sq) && Number.isFinite(entity.fireSq) && meta.sq <= entity.fireSq) return why(entity, 'sq');
  if (weapon !== 'melee' && entity.fireWeapon && entity.fireWeapon !== weapon) {
    if (Number.isFinite(meta.wAt) || meta.requireSwapEvidence) {
      // Evidencia = el arma REPLICADA se convirtió en ESTA arma (`wWeapon`) en
      // T ≥ último tiro con otra, y ahora ≥ T + FIRE_SWAP_EVIDENCE. El cambio
      // de otra arma no vale como evidencia de esta. `wInstant`: ESTA arma
      // llegó a la mano sin gesto (recogida); vale una sola vez (commit).
      const after = Number.isFinite(meta.wSeq) && Number.isFinite(entity.fireWeaponSeq)
        ? meta.wSeq > entity.fireWeaponSeq : meta.wAt >= (entity.fireWeaponAt ?? -Infinity);
      if (meta.wWeapon !== weapon || !after ||
          (!meta.wInstant && now - meta.wAt < FIRE_SWAP_EVIDENCE)) return why(entity, 'swap-evidence');
    } else if (now - (entity.fireWeaponAt ?? -Infinity) < FIRE_SWAP_GAP) return why(entity, 'swap-gap');
  }
  // hueco mínimo entre armas distintas (melee incluida)
  if (entity.lastActionWeapon && entity.lastActionWeapon !== weapon) {
    const pickup = !!meta.wInstant && meta.wWeapon === weapon;
    if (now - entity.lastActionAt < crossWeaponFloor(entity.lastActionWeapon, weapon,
      entity.lastActionHeld, pickup)) return why(entity, 'cross-floor');
    // tras una patada con OTRA arma en mano, el cambio a esta debe publicarse
    // después de la patada (no se puede cambiar de arma durante melee)
    if (entity.lastActionWeapon === 'melee' && weapon !== 'melee' && weapon !== entity.lastActionHeld && !pickup &&
        (meta.requireSwapEvidence || Number.isFinite(meta.wAt)) &&
        !(meta.wWeapon === weapon && (Number.isFinite(meta.wSeq) && Number.isFinite(entity.lastActionSeq)
          ? meta.wSeq > entity.lastActionSeq : meta.wAt >= entity.lastActionAt) &&
          now - meta.wAt >= FIRE_SWAP_EVIDENCE)) return why(entity, 'kick-swap-evidence');
  }
  const recent = entity.fireTimes?.[weapon] ?? [];
  for (const w of FIRE_WINDOWS) {
    let n = 1;
    for (let i = recent.length - 1; i >= 0 && now - recent[i] < w; i--) n++;
    if (n > fireWindowCap(w, interval)) return why(entity, 'window');
  }
  const chain = entity.fireChain?.[weapon];
  const fresh = !chain || now - chain.at > interval + FIRE_CHAIN_IDLE;
  const stall = Math.max(0, (entity.stallCredit ?? 0) - (now - (entity.stallAt ?? -Infinity)));
  const credit = Math.max(FIRE_JITTER_CREDIT, Math.min(FIRE_STALL_CREDIT, stall));
  const vt = fresh ? now : Math.max(chain.vt + interval, now - credit);
  return vt <= now + interval * FIRE_SLACK ? { vt } : why(entity, 'schedule');
}
export function fireCadenceAllows(entity, weapon, interval, now, meta) {
  return fireCadenceVerdict(entity, weapon, interval, now, meta) !== null;
}
export function commitFireCadence(entity, weapon, interval, now, meta = {}) {
  const v = fireCadenceVerdict(entity, weapon, interval, now, meta) ?? { vt: now };
  entity.fireChain ||= {};
  entity.fireChain[weapon] = { vt: v.vt, at: now };
  entity.fireTimes ||= {};
  const times = (entity.fireTimes[weapon] ||= []);
  times.push(now);
  while (times.length && now - times[0] >= FIRE_WINDOWS.at(-1)) times.shift();
  if (weapon !== 'melee') { entity.fireWeapon = weapon; entity.fireWeaponAt = now; entity.fireWeaponSeq = entity.msgSeq; }
  entity.lastActionWeapon = weapon; entity.lastActionAt = now;
  // arma EN MANO en esta acción (la patada se da con la equipada)
  entity.lastActionHeld = weapon === 'melee' ? meta.wWeapon : weapon;
  entity.lastActionSeq = entity.msgSeq;
  // la recogida sin gesto autoriza UN tiro inmediato de esa arma, no más
  if (meta.wInstant && meta.wWeapon === weapon) entity.wInstant = false;
  if (Number.isFinite(meta.sq)) entity.fireSq = meta.sq;
  entity.lastFireAt = now;
}
