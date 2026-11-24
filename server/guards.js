// Guardas de transporte y autoridad básica. Se mantienen fuera del servidor
// principal para poder probarlas sin levantar una partida completa.
import { TUNING } from '../src/config/tuning.js';
import { SWAP_TIME } from '../src/combat/weapons.js';
import { dodgeDistance } from '../src/player/dodge.js';
import { MOVE_GATES, sprintFireDelay } from '../src/combat/fire-gates.js';
const NET_GATE_TOL = 0.1;      // ciclos (1.1 s): jitter de llegada
const ENTRY_TIME_TOL = 0.01;    // sprint previo (mínimos de 60–69 ms): un cuadro
const ENTRY_SPEED_FRAC = 0.95;  // velocidad de entrada: redondeo de posiciones (1 mm) y del paso

export const MAX_WS_PAYLOAD = 32 * 1024;
export const MESSAGE_RATE = 240;
export const MESSAGE_BURST = 360;

const NORMAL_WEAPONS = ['smg', 'shotgun', 'pistol'];
const SPECIAL_WEAPONS = new Set(['sniper', 'bazooka']);
const MAX_MOVE_SPEED = 16.5;
// Clientes FPS (DECISIONES §2): presupuesto de velocidad POR POSTURA y
// duración (TUNING.fp), con crédito proporcional (absorbe ~0.3 s de llegadas
// amontonadas a esa velocidad) en vez de los 7 m de siempre. Los bots alojados
// conservan el tope anterior hasta que su etapa retire dive/flip.
//   agachado 2.3 · de pie/corriendo 4.8 · sprint 7.0 · slide ≤ 8 solo durante
//   slideTime (+0.2 s) · placaje ≤ 11 durante 0.45 s · en el aire, lo que se
//   traía del suelo (salto desde sprint/slide) · al cambiar de postura se
//   conserva unos 0.25 s la velocidad anterior (frenada 34 m/s²).
const FP = TUNING.fp;
export const FPS_SPEED = { crouch: FP.crouchSpeed, idle: FP.runSpeed, run: FP.runSpeed, roadie: FP.sprintSpeed,
  slide: FP.slideMaxSpeed, melee: FP.tackleTopSpeed, mantle: FP.runSpeed, jump: FP.runSpeed };
export const FPS_SPEED_SLACK = 1.08; // redondeo, aceleración y suelo inclinado
export const FPS_CREDIT_TIME = 0.35, FPS_CREDIT_MIN = 0.25;
export const MAX_FPS_MOVE_SPEED = MOVE_GATES.dodge.maxSpeed;
const SLIDE_WINDOW = FP.slideTime + 0.2, TACKLE_WINDOW = 0.45, CARRY_TIME = 0.25;
function fpsSpeedCap(guard, st, now) {
  st = FPS_SPEED[st] !== undefined ? st : 'run';
  if (st !== guard.st) {
    // al salir de una postura su tope se arrastra un momento (inercia)
    if (guard.st) { guard.carry = Math.max(guard.carryCap ?? 0, guard.st === 'jump' ? guard.airCap ?? 0 : guardCap(guard, guard.st, now)); guard.carryAt = now; }
    // presupuesto rápido solo con una ENTRADA legal (auditoría): slide desde
    // sprint (o su inercia) y pasado el enfriamiento de 0.6 s; placaje desde
    // sprint/slide. Reentrar sin eso no renueva nada: va a su velocidad lenta.
    // MOVE_GATES completas (fire-gates.js, ronda 2 R7): slide = sprint previo
    // de al menos minPriorSprint y ciclo inicio→inicio ≥ minCycle (1.1 s);
    // placaje = sprint previo suficiente o un slide LEGAL en curso, y ciclo
    // de golpe ≥ su minCycle. Holgura de red: NET_GATE_TOL.
    // C4: sprint previo de al menos su mínimo (sin holgura que lo anule: solo
    // un cuadro de 10 ms) y velocidad REAL de entrada medida del último tramo
    const G = MOVE_GATES, prevDur = now - (guard.stAt ?? now);
    const speedOk = (min) => Number.isFinite(guard.entrySpeed) && guard.entrySpeed >= min * ENTRY_SPEED_FRAC;
    const sprintFor = (min, minSpeed) => (guard.st === 'roadie' && prevDur >= min - ENTRY_TIME_TOL ||
      (guard.st === 'jump' && (guard.airCap ?? 0) >= FP.sprintSpeed - 0.01 && (guard.sprintDur ?? 0) >= min - ENTRY_TIME_TOL)) && speedOk(minSpeed);
    if (st === 'slide') {
      const ok = sprintFor(G.slide.minPriorSprint, G.slide.minEntrySpeed) && now - (guard.slideAt ?? -Infinity) >= G.slide.minCycle - NET_GATE_TOL;
      guard.slideAt = ok ? now : guard.slideAt; guard.slideLegal = ok;
    }
    if (st === 'melee') {
      const fromSlide = guard.st === 'slide' && guard.slideLegal && now - (guard.slideAt ?? -Infinity) <= SLIDE_WINDOW;
      const ok = (sprintFor(G.tackle.minPriorSprint, G.tackle.minEntrySpeed) || fromSlide && speedOk(G.tackle.minEntrySpeed)) && now - (guard.meleeAt ?? -Infinity) >= G.tackle.minCycle - NET_GATE_TOL;
      guard.meleeAt = ok ? now : guard.meleeAt; guard.tackleLegal = ok;
    }
    // duración del sprint que se arrastra a un salto (sprint → salto → slide)
    if (guard.st === 'roadie') guard.sprintDur = prevDur; else if (st !== 'jump') guard.sprintDur = 0;
    guard.stAt = now;
    if (st === 'jump') guard.airCap = Math.max(FP.runSpeed, guard.carry ?? 0);
    guard.st = st;
  }
  let cap = guardCap(guard, st, now);
  if (st === 'jump') cap = Math.max(cap, guard.airCap ?? 0);
  const k = 1 - Math.min(1, (now - (guard.carryAt ?? -Infinity)) / CARRY_TIME);
  if (k > 0) cap = Math.max(cap, (guard.carry ?? 0) * k + cap * (1 - k));
  guard.carryCap = cap;
  return cap * FPS_SPEED_SLACK + 0.2;
}
function guardCap(guard, st, now) {
  if (st === 'slide') return guard.slideLegal && now - (guard.slideAt ?? -Infinity) <= SLIDE_WINDOW ? FPS_SPEED.slide : FP.crouchSpeed;
  if (st === 'melee') return guard.tackleLegal && now - (guard.meleeAt ?? -Infinity) <= TACKLE_WINDOW ? FPS_SPEED.melee : FP.runSpeed;
  return FPS_SPEED[st] ?? FP.runSpeed;
}
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

// Solo la distancia de la curva recibe presupuesto especial. Se descuenta
// por intervalo de fase: quedarse contra una pared no almacena un salto.
// dg y ct están redondeados a milisegundos. El banco del reloj limita el
// ciclo incluso si un cliente adelanta ambos campos a la vez.
function dodgeAllowance(entity, guard, next, tclk) {
  const d = MOVE_GATES.dodge;
  if (next.st !== 'dodge' && !guard.inDodge) return 0;
  if (!Number.isFinite(next.ct)) return -1;
  if (next.st !== 'dodge') {
    if (next.ct < guard.dodgeStart + d.duration - 0.002 ||
        tclk < guard.dodgeClock + d.duration - NET_GATE_TOL) return -1;
    guard.inDodge = false;
    return dodgeDistance(d.duration) - dodgeDistance(guard.dodgeAge);
  }
  const age = next.dg, start = next.ct - age;
  if (!Number.isFinite(age) || age < 0 || age > d.duration || next.air || next.aim) return -1;
  if (!guard.inDodge) {
    if (!d.entry.includes(entity.st ?? 'idle') || entity.air ||
        start < (guard.throwReleaseCt ?? -Infinity) - 0.002 ||
        start < (guard.dodgeStart ?? -Infinity) + d.minCycle - 0.002 ||
        tclk - age < (guard.dodgeClock ?? -Infinity) + d.minCycle - NET_GATE_TOL ||
        (Number.isFinite(entity.motionGuard.lastCt) && start < entity.motionGuard.lastCt - 0.002)) return -1;
    guard.dodgeStart = start; guard.dodgeClock = tclk - age;
    guard.dodgeAge = 0; guard.dodgeExtra = 0; guard.inDodge = true;
  }
  if (age < guard.dodgeAge || Math.abs(start - guard.dodgeStart) > 0.002 ||
      age > tclk - guard.dodgeClock + NET_GATE_TOL ||
      tclk - guard.dodgeClock > d.duration + CADENCE_BANK) return -1;
  const allowance = dodgeDistance(age) - dodgeDistance(guard.dodgeAge);
  guard.dodgeAge = age;
  return allowance;
}

export function dodgeFireReady(entity, weapon) {
  if (entity.st === 'dodge') return false;
  const g = entity.motionGuard;
  if (!Number.isFinite(g?.dodgeStart)) return true;
  const ready = MOVE_GATES.dodge.duration + (weapon === 'melee' ? 0 : sprintFireDelay(weapon));
  return g.lastCt - g.dodgeStart >= ready - 0.002 &&
    g.dodgeNow - g.dodgeClock >= ready - NET_GATE_TOL;
}

export function acceptMovement(entity, next, now, bypass = false) {
  if (!entity || !next || ![next.x, next.y, next.z].every(Number.isFinite)) return false;
  if (!entity.motionGuard) resetMovementGuard(entity, now);
  const previous = entity.motionGuard;
  // Una corrección rechazada no puede servir luego como entrada de sprint.
  const guard = { ...previous };
  const dt = Math.max(0, Math.min(1, now - guard.at));
  guard.at = now;
  if (bypass) {
    guard.moveCredit = MAX_MOVE_CREDIT;
    guard.verticalCredit = MAX_VERTICAL_CREDIT;
    guard.rejected = 0;
    entity.motionGuard = guard;
    return true;
  }
  // ventanas de slide/placaje/inercia sobre el reloj de simulación acotado del
  // cliente (C7: una pausa de pestaña a mitad de slide no agota la ventana en
  // tiempo de servidor); el crédito se repone con tiempo de servidor (sin
  // crédito extra de velocidad)
  // velocidad REAL del último tramo (C4): distancia / tiempo simulado
  // la velocidad de ENTRADA es la del tramo anterior al cambio (el del cambio
  // ya va a la velocidad del gesto nuevo)
  const hasClock = Number.isFinite(next.ct) && Number.isFinite(guard.lastCt);
  const elapsed = hasClock ? next.ct - guard.lastCt : now - previous.at;
  if (Number.isFinite(next.ct)) guard.lastCt = next.ct;
  // El host también envía ct para sus bots. Cada bot lleva su propio banco
  // durante las ventanas de esquiva; sus demás topes no cambian.
  if (entity.bot && Number.isFinite(next.ct)) {
    guard.botClock = { ...previous.botClock, fps: true };
    advanceCadenceClock(guard.botClock, next.ct, now);
  }
  const boundedClock = entity.fps && Number.isFinite(entity.cclk) ? entity.cclk : guard.botClock?.cclk ?? now;
  const paused = (entity.fps || guard.botClock) && dt >= 0.25 && hasClock && elapsed >= 0;
  if (paused && Number.isFinite(previous.boundedClock)) {
    // El reloj de cadencia puede saltar al mínimo impuesto por la hora real.
    // Ese salto no consume el slide ni repone distancia que no se simuló.
    const skipped = Math.max(0, boundedClock - previous.boundedClock - elapsed);
    guard.pausedTime = (guard.pausedTime || 0) + skipped;
  }
  guard.boundedClock = boundedClock;
  const tclk = boundedClock - (guard.pausedTime || 0);
  const creditTime = paused ? Math.min(dt, elapsed) : dt;
  const dashTravel = dodgeAllowance(entity, guard, next, tclk);
  if (dashTravel < 0) { previous.rejected++; return false; }
  guard.dodgeNow = tclk;
  const speedCap = entity.fps ? fpsSpeedCap(guard, next.st, tclk) : MAX_MOVE_SPEED;
  const creditCap = entity.fps ? Math.max(FPS_CREDIT_MIN, speedCap * FPS_CREDIT_TIME) : MAX_MOVE_CREDIT;
  guard.moveCredit = Math.min(creditCap, guard.moveCredit + speedCap * creditTime);
  guard.verticalCredit = Math.min(MAX_VERTICAL_CREDIT,
    guard.verticalCredit + MAX_VERTICAL_SPEED * creditTime);
  const horizontal = Math.hypot(next.x - (entity.x || 0), next.z - (entity.z || 0));
  const vertical = Math.abs(next.y - (entity.y || 0));
  if (next.st === 'dodge') {
    // El primer envío de un bot puede incluir marcha anterior al impulso.
    const prior = previous.inDodge ? 0 : Math.min(creditCap, FP.sprintSpeed * Math.max(0, elapsed - next.dg));
    // Los empujes de otros cuerpos se miden aparte del impulso. La holgura
    // de cuantización es por gesto completo: repetir muestras no la renueva.
    const pushed = (next.bodyPushRate ?? 0) * Math.max(0, next.dg - (previous.inDodge ? previous.dodgeAge : 0));
    guard.dodgeExtra = Math.max(0, guard.dodgeExtra + horizontal - dashTravel - pushed - prior);
    if (guard.dodgeExtra > 0.045) { previous.rejected++; return false; }
  }
  if (previous.inDodge && next.st !== 'dodge') {
    const endAge = MOVE_GATES.dodge.duration, after = Math.max(0, next.ct - guard.dodgeStart - endAge);
    const pushed = (next.bodyPushRate ?? 0) * (endAge - previous.dodgeAge + after);
    if (horizontal > dashTravel + speedCap * after + pushed + 0.045 - guard.dodgeExtra) {
      previous.rejected++; return false;
    }
  }
  if (horizontal > guard.moveCredit + dashTravel + 0.01 || vertical > guard.verticalCredit + 0.01) {
    previous.rejected++;
    return false;
  }
  if (elapsed > 0) guard.entrySpeed = horizontal / Math.max(0.001, elapsed);
  entity.motionGuard = guard;
  guard.moveCredit = Math.max(0, guard.moveCredit - Math.max(0, horizontal - dashTravel));
  guard.verticalCredit = Math.max(0, guard.verticalCredit - vertical);
  guard.rejected = 0;
  return true;
}

// Postura FPS (contrato §1): `ce` en `crouch` = altura de la cabeza (0
// agachado, 1 de pie) y `cl` = inclinación −1..1. Son continuos y los gestos
// duran ~0.2 s: ningún cliente puede teletransportar su cabeza. Cubo de
// crédito por campo (como el de movimiento): se repone a POSTURE_RATE/s hasta
// POSTURE_CREDIT; un cambio mayor que el crédito se recorta (no se rechaza el
// estado entero: la posición sigue valiendo). Levantarse de golpe (idle/run
// con la cabeza aún baja) sigue como `crouch` subiendo a ese ritmo.
// Honesto (tuning.fp): agacharse 0.18 s (5.6/s), asomo 0.2 s subiendo y
// 0.15 s bajando (6.7/s), inclinación 0.16 s (6.3/s): todo por debajo de 8/s,
// más 0.5 de holgura: llegadas amontonadas con ±30 ms de jitter (medido en check-fps-origin).
export const POSTURE_RATE = 8;
export const POSTURE_CREDIT = 0.5;
export const POSTURE_UPRIGHT = new Set(['idle', 'run', 'jump']);
const LEAN_STATES = new Set(['idle', 'run', 'jump', 'crouch']);
const LOW_STATES = new Set(['cover_low', 'blind_over', 'blind_low_left', 'blind_low_right']);
export function resetPostureGuard(entity, now) {
  entity.postureGuard = { at: now, h: 1, cl: 0, hCredit: POSTURE_CREDIT, clCredit: POSTURE_CREDIT };
}
// next: { st, aim, ce (pedido, puede faltar), cl }. Devuelve { st, ce, cl } aceptados.
// Solo actúa sobre posturas FPS (de pie, agachado, inclinado); el resto de
// estados (cobertura de bots, slide, mantle…) pasa tal cual y deja la cabeza
// "de pie" como referencia de la próxima transición.
// ct: reloj de simulación del cliente (opcional). El crédito se repone con el
// tiempo SIMULADO entre estados (dos estados honestos que llegan juntos tras
// 100 ms de jitter llevan 100 ms de ct entre ellos: auditoría, 5 cm de ojo),
// acotado: ct nunca adelanta más de CT_LEAD a su mejor desfase con el reloj
// del servidor, así que no se gana crédito inflando ct.
export const CT_LEAD = 0.15;
export const POSTURE_BANK = 0.3;
export function acceptPosture(entity, next, now, ct) {
  if (!entity.postureGuard) resetPostureGuard(entity, now);
  const g = entity.postureGuard;
  const srvDt = Math.max(0, Math.min(1, now - g.at));
  let dt = srvDt;
  // C7: tras un silencio ≥ 0.25 s (pestaña en pausa) la primera muestra
  // re-basa la referencia del reloj: sin arrastrar desfases de antes
  if (srvDt >= 0.25) { g.ct = undefined; g.minOff = undefined; g.bank = 0; }
  if (Number.isFinite(ct)) {
    // ct que retrocede mucho (cambio de reloj, primera muestra de la vida con
    // otra base): se reinicia la referencia en vez de congelar el crédito
    if (Number.isFinite(g.ct) && ct < g.ct - 0.5) { g.ct = undefined; g.minOff = undefined; }
    const off = ct - now;
    g.minOff = Number.isFinite(g.minOff) ? Math.min(g.minOff, off) : off;
    const ce = Math.min(ct, now + g.minOff + CT_LEAD);
    // ronda 2 (R1): el tiempo simulado se gasta contra un BANCO de tiempo de
    // servidor acumulado (≤ POSTURE_BANK): dos estados que llegan juntos
    // usan el hueco real que los precedió, pero una llegada nunca gasta más
    // tiempo del que ha pasado en el servidor
    g.bank = Math.min(POSTURE_BANK, (g.bank ?? 0) + srvDt);
    const simDt = Number.isFinite(g.ct) ? Math.max(0, Math.min(1, ce - g.ct)) : srvDt;
    dt = Math.min(simDt, g.bank);
    g.bank -= dt;
    g.ct = Math.max(g.ct ?? -Infinity, ce);
  }
  g.at = now;
  // Si ambos cubos estaban llenos, parte de dt no repuso crédito a ninguno.
  // Esa parte del intervalo real puede pagar movimiento de la muestra actual;
  // se devuelve al banco para el siguiente ct, nunca al crédito instantáneo.
  const room = POSTURE_CREDIT - Math.min(g.hCredit, g.clCredit);
  const unused = Math.max(0, dt - room / POSTURE_RATE);
  g.hCredit = Math.min(POSTURE_CREDIT, g.hCredit + POSTURE_RATE * dt);
  g.clCredit = Math.min(POSTURE_CREDIT, g.clCredit + POSTURE_RATE * dt);
  let moved = 0;
  const step = (from, to, key) => {
    const d = Math.max(-g[key], Math.min(g[key], to - from));
    g[key] -= Math.abs(d);
    moved = Math.max(moved, Math.abs(d));
    return from + d;
  };
  let { st } = next, ce = next.ce, cl = Number.isFinite(next.cl) ? next.cl : 0;
  // Dentro de la familia de pie/agachado (sin mezcla de estados en
  // hit-pose.js) la altura `ce` va a ritmo acotado; levantarse de golpe sigue
  // como crouch subiendo. Al ENTRAR desde otro estado (slide, sprint, mantle,
  // melee) o salir hacia él, la continuidad la da la mezcla de estados que el
  // servidor reconstruye con SUS muestras (hit-pose.js transitionOf /
  // shotPose, pico ≤ BLEND_SPEED): no hay atajo para teletransportar la cabeza.
  const fromFamily = g.st === undefined || g.st === 'crouch' || POSTURE_UPRIGHT.has(g.st);
  const leaving = st !== 'crouch' && g.st === 'crouch' && g.h < 1 && POSTURE_UPRIGHT.has(st);
  if (st === 'crouch' || leaving) {
    const want = st === 'crouch' ? (Number.isFinite(ce) ? ce : 0) : 1;
    const h = fromFamily ? step(g.h, Math.max(0, Math.min(1, want)), 'hCredit') : Math.max(0, Math.min(1, want));
    g.h = h; ce = h;
    if (st !== 'crouch' && h < 1 - 1e-6) st = 'crouch';
  } else {
    // fuera de la postura FPS: solo se anota la altura de cabeza de partida
    // (cobertura baja escondida = agachado) para limitar la próxima entrada
    g.h = LOW_STATES.has(st) ? (st === 'cover_low' && next.aim && Number.isFinite(ce) ? ce : 0) : 1;
  }
  // de pie la cabeza está arriba: `ce` = 1 (la interpolación crouch→idle del
  // rebobinado queda continua)
  if (POSTURE_UPRIGHT.has(st)) ce = 1;
  g.st = st;
  if (LEAN_STATES.has(st)) { cl = step(g.cl, Math.max(-1, Math.min(1, cl)), 'clCredit'); g.cl = cl; }
  // fuera de las posturas inclinables un cliente FPS no se inclina: `cl` va a
  // cero a su ritmo (nunca se copia sin límite); los bots en cobertura
  // conservan su `cl` de siempre (lado de asomado)
  else if (st === 'dodge') {
    // La mezcla de estados conserva la cabeza inclinada de la muestra anterior
    // y la lleva al centro. Esta pose carece de inclinación independiente.
    cl = g.cl = 0;
  }
  else if (entity.fps) { cl = step(g.cl, 0, 'clCredit'); g.cl = cl; }
  else g.cl = cl;
  if (Number.isFinite(ct)) g.bank += Math.min(unused, srvDt, moved / POSTURE_RATE);
  return { st, ce, cl };
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
  const scheduleNow = meta.scheduleNow ?? now;
  const fresh = !chain || scheduleNow - chain.at > interval + FIRE_CHAIN_IDLE;
  const stall = Math.max(0, (entity.stallCredit ?? 0) - (now - (entity.stallAt ?? -Infinity)));
  // El reloj acotado ya absorbe el atasco de transporte. Sumar otro crédito
  // aquí contaría dos veces el mismo retraso, tanto en humanos como en bots.
  const bounded = meta.scheduleNow !== undefined || (entity.fps && !entity.bot);
  const credit = bounded ? FIRE_JITTER_CREDIT : Math.max(FIRE_JITTER_CREDIT, Math.min(FIRE_STALL_CREDIT, stall));
  const vt = fresh ? scheduleNow : Math.max(chain.vt + interval, scheduleNow - credit);
  return vt <= scheduleNow + interval * FIRE_SLACK ? { vt } : why(entity, 'schedule');
}
export function fireCadenceAllows(entity, weapon, interval, now, meta) {
  return fireCadenceVerdict(entity, weapon, interval, now, meta) !== null;
}
export function commitFireCadence(entity, weapon, interval, now, meta = {}) {
  const scheduleNow = meta.scheduleNow ?? now;
  const v = fireCadenceVerdict(entity, weapon, interval, now, meta) ?? { vt: scheduleNow };
  entity.fireChain ||= {};
  entity.fireChain[weapon] = { vt: v.vt, at: scheduleNow };
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

// Reloj de CADENCIA de un cliente FPS (matriz honesta): su reloj de
// simulación (`ct` de estados y muestras) acotado por un banco de tiempo de
// servidor (≤ FIRE_STALL_CREDIT, el mismo crédito de atasco que HEAD): las
// ráfagas que llegan amontonadas por jitter se juzgan con los intervalos con
// que se dispararon, pero el reloj nunca adelanta al servidor ni gana más de
// ese crédito. Nunca se queda más de ese crédito por detrás del servidor.
export const CADENCE_BANK = FIRE_STALL_CREDIT;
export function advanceCadenceClock(me, ct, now) {
  if (!me.fps && !me.bot) return;
  // el primer mensaje pudo llegar tarde (jitter): el banco arranca con el
  // crédito de atasco entero, como el de HEAD tras un atraso
  if (!Number.isFinite(me.cclk)) { me.cclk = now - CADENCE_BANK; me.cAt = now; me.cBank = CADENCE_BANK; me.cCt = ct; return; }
  me.cBank = Math.min(CADENCE_BANK, (me.cBank ?? 0) + Math.max(0, now - me.cAt)); me.cAt = now;
  let d;
  if (Number.isFinite(ct) && Number.isFinite(me.cCt) && ct >= me.cCt - 0.5) d = Math.max(0, ct - me.cCt);
  else d = me.cBank; // sin reloj (o reloj reiniciado): tiempo de servidor
  d = Math.min(d, me.cBank); me.cBank -= d; me.cclk += d;
  if (Number.isFinite(ct)) me.cCt = Number.isFinite(me.cCt) && ct >= me.cCt - 0.5 ? Math.max(me.cCt, ct) : ct;
  me.cclk = Math.min(now, Math.max(me.cclk, now - CADENCE_BANK));
}

// C1: concentración de ráfaga en tiempo de SERVIDOR, la de HEAD: en cualquier
// ventana de 100/200/400/1000 ms, como mucho ⌊W/(0.82·intervalo)⌋+1 tiros
// aplicados (SMG: 2/3/6/13). El horario sobre el reloj de simulación decide
// el ritmo; esto impide que el banco concentre más tiros simultáneos que HEAD.
// Los tiros honestos agrupados por un atasco de red siguen exactamente esa
// regla de HEAD (no se amplía).
export function srvBurstAllows(entity, weapon, interval, now) {
  const recent = entity.srvFireTimes?.[weapon] ?? [];
  for (const w of FIRE_WINDOWS) {
    let n = 1;
    for (let i = recent.length - 1; i >= 0 && now - recent[i] < w; i--) n++;
    if (n > fireWindowCap(w, interval)) return false;
  }
  return true;
}
export function commitSrvBurst(entity, weapon, now) {
  entity.srvFireTimes ||= {};
  const t = (entity.srvFireTimes[weapon] ||= []);
  t.push(now);
  while (t.length && now - t[0] >= FIRE_WINDOWS.at(-1)) t.shift();
}
