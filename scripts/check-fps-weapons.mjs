// Lógica de armas FPS (etapa B, JUGABILIDAD). Solo Node.
// - Emisor de eventos (CONTRATO §4): cada suceso UNA vez, también saltando
//   cuadros (pasos largos), y las rutas de cancelación.
// - spreadFor (CONTRATO §3): modificadores de primera persona.
// - Retroceso mecánico: patrón fijo por tiro, magnitud vertical de siempre.
// - Cadencia: la puerta MIN_GAP que exige el servidor sigue intacta.
import { Weapons, spreadFor, recoilKick, reloadTimeline, setReloadTimeline, SWAP_TIME, SPREAD_MODS } from '../src/combat/weapons.js';
import { TUNING } from '../src/config/tuning.js';
import { fireWindowCap } from '../server/guards.js';
import { FIRE_GATES, actionOf, canFireInState, sprintFireDelay, sprintFireOk, FIRE_GATE_NET_TOL } from '../src/combat/fire-gates.js';
import { Controller } from '../src/player/controller.js';
import { CombatPrototypes } from '../src/combat/prototypes.js';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

function recorder(w) {
  const log = [];
  for (const e of ['fire', 'dry', 'reloadStart', 'reloadStep', 'reloadEnd', 'reloadCancel', 'swapStart',
    'swapMid', 'swapEnd', 'swapRetarget', 'swapCancel', 'meleeStart', 'meleeHit', 'throwStart', 'throwRelease']) {
    w.on(e, (d) => log.push({ e, ...d }));
  }
  return log;
}
const names = (log, e) => log.filter((x) => x.e === e);
const steps = (log) => log.filter((x) => x.e === 'reloadStep').map((x) => x.name);

// ---------- recarga: pasos una sola vez con cualquier tamaño de paso ----------
for (const dt of [1 / 144, 1 / 60, 1 / 20, 0.4, 2.5]) {
  const w = new Weapons(); const log = recorder(w);
  w.st.mag = 10;
  check(w.startReload(), 'no arranca la recarga');
  let guard = 0;
  while (w.reloading && guard++ < 2000) w.update(dt, false, false, true);
  check(names(log, 'reloadStart').length === 1 && names(log, 'reloadStart')[0].total === TUNING.weapons.smg.reloadTime,
    `dt ${dt}: reloadStart ${JSON.stringify(names(log, 'reloadStart'))}`);
  check(steps(log).join(',') === 'magOut,magIn,boltRelease', `dt ${dt}: pasos ${steps(log)}`);
  check(names(log, 'reloadEnd').length === 1 && names(log, 'reloadCancel').length === 0, `dt ${dt}: fin de recarga`);
  check(w.st.mag === TUNING.weapons.smg.mag, `dt ${dt}: cargador ${w.st.mag}`);
  // la munición cambia SOLO al final (lógica real), nunca a mitad
  const idxEnd = log.findIndex((x) => x.e === 'reloadEnd');
  check(idxEnd === log.length - 1, `dt ${dt}: reloadEnd no es el último suceso`);
}

// ---------- la munición no cambia antes del final aunque haya pasos ----------
{
  const w = new Weapons(); const log = recorder(w);
  w.st.mag = 3; w.startReload();
  let magDuring = new Set();
  w.on('reloadStep', () => magDuring.add(w.st.mag));
  while (w.reloading) w.update(1 / 60, false, false, true);
  check([...magDuring].join() === `3,${TUNING.weapons.smg.mag}`, `munición durante los pasos: ${[...magDuring]}`);
  check(log.length > 0, 'sin eventos');
}

// ---------- cancelaciones: disparo, cambio, melee, muerte, caja ----------
{
  const paths = {
    fire: (w) => w.update(1 / 60, true, true, true),
    swap: (w) => w.startSwap('shotgun'),
    melee: (w) => w.interruptReload(),
    death: (w) => w.cancelActions(),
    crate: (w) => w.refill(),
    replaceSlot: (w) => w.replaceSlot(0, 'shotgun', 3, 10),
    giveSpecial: (w) => w.giveSpecial('sniper'),
    reset: (w) => w.reset(),
  };
  for (const [name, cancel] of Object.entries(paths)) {
    const w = new Weapons(); const log = recorder(w);
    w.st.mag = 10; w.startReload();
    for (let i = 0; i < 40; i++) w.update(1 / 60, false, false, true); // pasa magOut
    cancel(w);
    for (let i = 0; i < 200; i++) w.update(1 / 60, false, false, true);
    const rc = names(log, 'reloadCancel').length;
    const re = names(log, 'reloadEnd').length;
    check(rc === 1 && re === 0, `${name}: reloadCancel ${rc}, reloadEnd ${re}`);
    check(!steps(log).includes('magIn'), `${name}: magIn tras cancelar`);
  }
}

// ---------- escopeta: un shellIn por cartucho, pump y fin una vez ----------
for (const dt of [1 / 60, 0.3, 5]) {
  const w = new Weapons(); const log = recorder(w);
  w.startSwap('shotgun'); while (w.swapping) w.update(1 / 60, false, false, true);
  w.st.mag = 3; const reserve0 = w.st.reserve;
  w.startReload();
  let guard = 0; while (w.reloading && guard++ < 2000) w.update(dt, false, false, true);
  const shells = steps(log).filter((s) => s === 'shellIn').length;
  check(shells === 5 && w.st.mag === 8 && w.st.reserve === reserve0 - 5, `escopeta dt ${dt}: ${shells} cartuchos, mag ${w.st.mag}`);
  check(steps(log).at(-1) === 'pump' && names(log, 'reloadEnd').length === 1, `escopeta dt ${dt}: cierre ${steps(log).at(-1)}`);
  check(names(log, 'reloadStart')[0].total === TUNING.weapons.shotgun.reloadTime * 5, 'escopeta: total de recarga');
}

// ---------- cambio de arma: inicio, mitad y fin una vez (también con un paso enorme) ----------
for (const dt of [1 / 60, 0.3, 1]) {
  const w = new Weapons(); const log = recorder(w);
  w.startSwap('pistol');
  let guard = 0; while (w.swapping && guard++ < 1000) w.update(dt, false, false, true);
  const seq = log.map((x) => x.e).join(',');
  check(seq === 'swapStart,swapMid,swapEnd', `cambio dt ${dt}: ${seq}`);
  check(log[0].from === 'smg' && log[0].to === 'pistol' && log[0].total === SWAP_TIME && log[1].weapon === 'pistol', 'datos del cambio');
}
{
  const w = new Weapons(); const log = recorder(w);
  w.startSwap('pistol'); w.update(0.05, false, false, true); w.startSwap('shotgun');
  while (w.swapping) w.update(1 / 60, false, false, true);
  check(names(log, 'swapStart').length === 1 && names(log, 'swapRetarget').length === 1 && w.cur === 'shotgun', 'redirigir el cambio');
  w.startSwap('smg'); w.update(0.1, false, false, true); w.cancelActions();
  check(names(log, 'swapCancel').length === 1, 'muerte no cancela el cambio');
}

// ---------- disparo: un `fire` por tiro, cadencia intacta, en seco una vez ----------
for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
  const w = new Weapons(); const log = recorder(w);
  let shots = 0, t = 0, last = -Infinity, minGap = Infinity;
  while (t < 1.5) {
    const fired = w.update(dt, true, false, true); t += dt;
    if (fired) { shots++; minGap = Math.min(minGap, t - last); last = t; }
  }
  check(names(log, 'fire').length === shots, `dt ${dt}: ${names(log, 'fire').length} eventos para ${shots} tiros`);
  const interval = 60 / TUNING.weapons.smg.rpm;
  check(minGap >= interval * 0.82, `dt ${dt}: intervalo ${minGap.toFixed(4)} < 82 % del nominal`);
  check(shots <= fireWindowCap(1.5, interval), `dt ${dt}: ${shots} tiros superan la ventana del servidor`);
  // patrón de retroceso: tiros consecutivos de la ráfaga numerados 0..n
  const idx = names(log, 'fire').map((x) => x.shot);
  check(idx.every((v, i) => v === i), `dt ${dt}: numeración de ráfaga ${idx.slice(0, 6)}`);
}
{
  const w = new Weapons(); const log = recorder(w);
  w.st.mag = 0; w.st.reserve = 0;
  for (let i = 0; i < 30; i++) w.update(1 / 60, true, true, true); // botón mantenido/bufereado
  w.update(1 / 60, false, false, true);
  w.update(1 / 60, true, true, true);
  check(names(log, 'dry').length === 2, `en seco: ${names(log, 'dry').length} avisos (esperado 2, uno por pulsación)`);
}

// ---------- lanzamiento: inicio y suelta una vez; granada rápida vuelve ----------
for (const dt of [1 / 60, 0.3]) {
  const w = new Weapons(); const log = recorder(w);
  check(w.quickThrow(), 'granada rápida no arranca');
  let guard = 0;
  while ((w.swapping || w.throwing || names(log, 'throwRelease').length === 0) && guard++ < 400) w.update(dt, false, false, true);
  while (w.swapping && guard++ < 800) w.update(dt, false, false, true);
  check(names(log, 'throwStart').length === 1 && names(log, 'throwRelease').length === 1, `rápida dt ${dt}: ${names(log, 'throwStart').length}/${names(log, 'throwRelease').length}`);
  check(names(log, 'fire').length === 0, 'el lanzamiento emitió fire');
  check(w.state.grenade.mag === TUNING.weapons.grenade.mag - 1, 'no gastó un bote');
  check(w.cur === 'smg', `rápida dt ${dt}: no volvió al arma anterior (${w.cur})`);
  // la vuelta empieza en la suelta, no antes (regla de cadencia del servidor)
  const iRel = log.findIndex((x) => x.e === 'throwRelease');
  const iBack = log.findIndex((x, i) => i > 0 && x.e === 'swapStart' && x.to === 'smg');
  check(iBack > iRel, 'la vuelta al arma empezó antes de soltar el bote');
}
{
  const w = new Weapons();
  w.state.grenade.mag = 0;
  check(!w.quickThrow(), 'granada rápida sin botes');
  const w2 = new Weapons(); w2.quickThrow(); w2.update(0.05, false, false, true); w2.startSwap('pistol');
  for (let i = 0; i < 120; i++) w2.update(1 / 60, false, false, true);
  check(w2.cur === 'pistol' && w2.state.grenade.mag === TUNING.weapons.grenade.mag, 'cambiar a mano no anula la granada rápida');
}

// ---------- con el gesto de lanzar en curso no empieza ningún cambio ----------
// (último bote: main.js pide la primaria al soltar; granada rápida: vuelta)
for (const mode of ['quick', 'last', 'lastQuick']) {
  const w = new Weapons(); const log = []; let t = 0;
  for (const e of ['throwStart', 'throwRelease', 'swapStart', 'swapEnd']) w.on(e, (d) => log.push({ e, t, ...d }));
  if (mode !== 'quick') w.state.grenade.mag = 1;
  if (mode === 'last') { w.startSwap('grenade'); while (w.swapping) { w.update(1 / 60, false, false, true); t += 1 / 60; } }
  // como main.js: con el último bote, pedir la primaria en la suelta
  w.on('throwRelease', () => { if (w.st.mag <= 0) w.startSwap(w.primary); });
  if (mode === 'last') { w.update(1 / 60, false, true, true); t += 1 / 60; } else w.quickThrow();
  for (let i = 0; i < 200; i++) { w.update(1 / 60, false, false, true); t += 1 / 60; }
  const start = log.find((x) => x.e === 'throwStart');
  const back = log.find((x) => x.e === 'swapStart' && x.from === 'grenade');
  check(start && back && back.t >= start.t + TUNING.weapons.grenade.throwTime - 1e-6,
    `${mode}: la vuelta al arma empezó a ${back ? (back.t - start.t).toFixed(3) : '—'} s del lanzamiento (gesto ${TUNING.weapons.grenade.throwTime} s)`);
  check(w.cur === 'smg' && !w.swapping, `${mode}: termina en ${w.cur}`);
  check(log.filter((x) => x.e === 'swapStart' && x.from === 'grenade').length === 1, `${mode}: más de una vuelta`);
}

// ---------- AUDITORÍA 4: el último bote vuelve al arma de la que se vino ----------
// (con la regla de respaldo de main.js aplicada cada paso, como en el juego)
const mainFallback = (w) => { if (w.def.thrown && w.st.mag <= 0 && !w.swapping && !w.throwing && !w.quickThrowActive && w.cur !== w.primary) w.startSwap(w.primary); };
for (const origin of ['pistol', 'shotgun', 'smg']) for (const quick of [true, false]) for (const kind of ['grenade']) {
  const w = new Weapons();
  w.startSwap(origin); while (w.swapping) w.update(1 / 60, false, false, true);
  w.state[kind].mag = 1;
  if (quick) w.quickThrow();
  else { w.startSwap(kind); while (w.swapping) { w.update(1 / 60, false, false, true); mainFallback(w); } w.update(1 / 60, false, true, true); }
  for (let i = 0; i < 240; i++) { w.update(1 / 60, false, false, true); mainFallback(w); }
  check(w.state[kind].mag === 0 && w.cur === origin, `${quick ? 'rápida' : 'normal'} desde ${origin} con el último bote: termina en ${w.cur}`);
}

// ---------- RONDA 2 (R8): el bote se paga AL SOLTAR; reembolso por id, una vez ----------
for (const hz of [30, 60, 144]) {
  const dt = 1 / hz;
  const arm = () => { const w = new Weapons(); w.online = true; const log = recorder(w); w.on('throwCancel', (d) => log.push({ e: 'throwCancel', ...d })); w.on('throwRefund', (d) => log.push({ e: 'throwRefund', ...d }));
    w.startSwap('grenade'); while (w.swapping) w.update(dt, false, false, true); return { w, log }; };
  const m0 = TUNING.weapons.grenade.mag;
  // gasto exactamente en la suelta
  {
    const { w, log } = arm();
    w.update(dt, false, true, true);
    let before = true, okBefore = true;
    for (let i = 0; i < hz; i++) {
      w.update(dt, false, false, true);
      if (!names(log, 'throwRelease').length && w.state.grenade.mag !== m0) okBefore = false;
    }
    const rel = names(log, 'throwRelease');
    check(names(log, 'throwStart').length === 1 && rel.length === 1 && okBefore, `${hz} Hz: el bote se cobró antes de soltar`);
    check(w.state.grenade.mag === m0 - 1, `${hz} Hz: tras soltar quedan ${w.state.grenade.mag}`);
    check(typeof rel[0]?.id === 'string' && w.pendingThrows?.length === 1, `${hz} Hz: la suelta no crea un pendiente con id (${JSON.stringify(rel[0])})`);
    const id = rel[0]?.id;
    // reembolso idempotente y atado al pendiente
    check(w.refundThrow('bot:7:3') === false && w.refundThrow('zz') === false && w.state.grenade.mag === m0 - 1, `${hz} Hz: id ajeno reembolsado`);
    check(w.refundThrow(`p:me:${id}`) === true && w.state.grenade.mag === m0, `${hz} Hz: reembolso por cid`);
    check(w.refundThrow(id) === false && w.refundThrow(`p:me:${id}`) === false && w.state.grenade.mag === m0, `${hz} Hz: reembolso repetido`);
    check(names(log, 'throwRefund').length === 1, `${hz} Hz: throwRefund ${names(log, 'throwRefund').length}`);
  }
  // confirmación, muerte y cambio de ronda limpian los pendientes
  for (const clear of ['confirm', 'death', 'round']) {
    const { w, log } = arm();
    w.update(dt, false, true, true);
    for (let i = 0; i < hz; i++) w.update(dt, false, false, true);
    const id = names(log, 'throwRelease')[0]?.id;
    if (clear === 'confirm') w.confirmThrow?.(id); else if (clear === 'death') w.newLife?.(); else w.clearPendingThrows?.();
    check(w.refundThrow(id) === false && w.state.grenade.mag === m0 - 1, `${hz} Hz: reembolso tras ${clear}`);
  }
  // gesto interrumpido (aturdido / muerte / cambio forzado) antes de soltar: gratis
  for (const cut of ['stun', 'special', 'reset']) {
    const { w, log } = arm();
    w.update(dt, false, true, true);
    for (let t = 0; t < TUNING.weapons.grenade.throwRelease * 0.5; t += dt) w.update(dt, false, false, true);
    if (cut === 'stun') w.cancelActions(); else if (cut === 'special') w.giveSpecial('sniper'); else w.reset();
    for (let i = 0; i < hz; i++) w.update(dt, false, false, true);
    check(names(log, 'throwRelease').length === 0 && names(log, 'throwCancel').length === 1, `${hz} Hz ${cut}: soltó ${names(log, 'throwRelease').length}, cancelado ${names(log, 'throwCancel').length}`);
    check((w.state.grenade?.mag ?? m0) === m0, `${hz} Hz ${cut}: el gesto interrumpido costó un bote (${w.state.grenade?.mag})`);
  }
  // recarga: la munición se mueve en el paso de confirmación, nunca antes; cancelada, nunca
  {
    const w = new Weapons(); w.st.mag = 5; const r0 = w.st.reserve;
    w.startReload(); let early = false;
    while (w.reloading) { w.update(dt, false, false, true); if (w.reloading && (w.st.mag !== 5 || w.st.reserve !== r0)) early = true; }
    check(!early && w.st.mag === TUNING.weapons.smg.mag, `${hz} Hz: la recarga movió munición antes de confirmar`);
    const c = new Weapons(); c.st.mag = 5; const rc = c.st.reserve; c.startReload();
    for (let t = 0; t < TUNING.weapons.smg.reloadTime * 0.9; t += dt) c.update(dt, false, false, true);
    c.interruptReload(); for (let i = 0; i < hz; i++) c.update(dt, false, false, true);
    check(c.st.mag === 5 && c.st.reserve === rc, `${hz} Hz: recarga cancelada movió munición`);
  }
  // cohete: se cobra en el mismo paso que sale (sin gesto previo pagado)
  {
    const w = new Weapons(); w.giveSpecial('bazooka');
    let paidEarly = false, fired = false;
    for (let i = 0; i < hz && !fired; i++) { const m = w.st.mag; fired = w.update(dt, false, true, true); if (!fired && w.st.mag !== m) paidEarly = true; }
    check(fired && !paidEarly && w.st.mag === TUNING.weapons.bazooka.mag - 1, `${hz} Hz: cohete cobrado fuera de su paso`);
  }
}

// ---------- RONDA 3 (C8): la lista de pendientes no tiene fugas ----------
for (const hz of [30, 60, 144]) {
  const dt = 1 / hz;
  const throwOnce = (w) => {
    let id = null; const off = w.on('throwRelease', (d) => { id = d.id; });
    if (!w.quickThrow()) { off(); return null; }
    for (let i = 0; i < 3 * hz && (w.swapping || w.throwing || !id); i++) w.update(dt, false, false, true);
    for (let i = 0; i < hz && w.swapping; i++) w.update(dt, false, false, true);
    off(); return id;
  };
  const fresh = (online) => { const w = new Weapons(); w.online = online; w.infinite = true; return w; };
  // 50 lanzamientos offline: ningún pendiente, nunca
  { const w = fresh(false); let max = 0;
    for (let i = 0; i < 50; i++) { throwOnce(w); max = Math.max(max, w.pendingThrows.length); }
    check(max === 0, `${hz} Hz offline: ${max} pendientes`); }
  // 50 aceptados en línea (humo con nadeAck): vuelve a 0
  { const w = fresh(true); let n = 0;
    for (let i = 0; i < 50; i++) { const id = throwOnce(w); if (id) { n++; w.confirmThrow(`p:me:${id}`); } }
    check(n === 50 && w.pendingThrows.length === 0, `${hz} Hz aceptados: ${n} lanzados, ${w.pendingThrows.length} pendientes`); }
  // La frag aceptada confirma la suelta antes de que venza el pendiente.
  {
    const w = fresh(true);
    w.replaceSlot(3, 'frag', 2, 0);
    const id = throwOnce(w), cid = 'p:me:' + id;
    const actor = {id:'me', alive:true, x:0, y:0, z:0};
    const engine = new CombatPrototypes({actors: () => [actor], blocked: () => false,
      event: e => { if (e.kind === 'launch' && e.owner === actor.id && e.cid === cid) w.confirmThrow(e.cid); }});
    engine.active = true;
    Object.assign(engine.state('me'), {equipment:'frag', frag:2});
    check(id && w.pendingThrows.includes(id) && engine.fire('me','frag',{x:0,y:1,z:0},{x:0,y:0,z:1},cid) &&
      w.pendingThrows.length === 0, `${hz} Hz: frag aceptada sin confirmar`);
  }
  // Respuesta perdida: caduca sola.
  { const w = fresh(true);
    for (let i = 0; i < 50; i++) throwOnce(w);
    const peak = w.pendingThrows.length;
    for (let t = 0; t < 6; t += dt) w.update(dt, false, false, true);
    check(peak > 0 && peak <= 50 && w.pendingThrows.length === 0, `${hz} Hz sin confirmar: pico ${peak}, quedan ${w.pendingThrows.length}`); }
  // rechazado: un bote de vuelta, lista vacía
  { const w = fresh(true); w.infinite = false; const m0 = w.state.grenade.mag;
    const id = throwOnce(w);
    check(w.refundThrow(`p:me:${id}`) && w.state.grenade.mag === m0 && w.pendingThrows.length === 0, `${hz} Hz rechazado`); }
  // rechazado DESPUÉS de un aturdimiento (suelta ya hecha): se devuelve igual, una vez
  { const w = fresh(true); w.infinite = false; const m0 = w.state.grenade.mag;
    const id = throwOnce(w);
    w.cancelActions(); // aturdido
    check(w.refundThrow(`p:me:${id}`) === true && w.refundThrow(`p:me:${id}`) === false && w.state.grenade.mag === m0 && w.pendingThrows.length === 0,
      `${hz} Hz rechazado tras aturdir: mag ${w.state.grenade.mag}, pendientes ${w.pendingThrows.length}`); }
  // rechazado tras morir y reaparecer: nada (otra vida), lista vacía
  { const w = fresh(true); w.infinite = false;
    const id = throwOnce(w); const lifeThen = w.life;
    w.cancelActions(); w.newLife?.(); const m1 = w.state.grenade.mag;
    check(w.refundThrow(`p:me:${id}`) === false && w.refundThrow(`p:me:${id}`, { life: lifeThen }) === false && w.state.grenade.mag === m1 && w.pendingThrows.length === 0,
      `${hz} Hz rechazado tras reaparecer`); }
  { const w = fresh(true); w.infinite = false;
    w.newLife(); w.newLife(); w.newLife(1); // dos vidas offline, luego otra sesión
    const id = throwOnce(w);
    check(w.life === 1 && w.refundThrow(id,{life:1}), `${hz} Hz vida del servidor al entrar online`); }
  // el receptor compara la vida que trae el rechazo
  { const w = fresh(true); w.infinite = false; const m0 = w.state.grenade.mag;
    const id = throwOnce(w);
    check(w.refundThrow(`p:me:${id}`, { life: w.life + 7 }) === false && w.pendingThrows.length === 1, `${hz} Hz vida ajena reembolsada`);
    check(w.refundThrow(`p:me:${id}`, { life: w.life }) === true && w.state.grenade.mag === m0 && w.pendingThrows.length === 0, `${hz} Hz vida propia`); }
}

// ---------- melee: los sucesos pasan por el arma ----------
{
  const w = new Weapons(); const log = recorder(w);
  w.noteMelee('start'); w.noteMelee('hit', { connected: true });
  check(names(log, 'meleeStart').length === 1 && names(log, 'meleeHit')[0]?.connected === true, 'eventos de melee');
}

// ---------- línea de tiempo sustituible (perfil del viewmodel) ----------
{
  const orig = reloadTimeline('pistol');
  setReloadTimeline('pistol', [{ t: 0.9, step: 'slideRelease' }, { t: 0.2, step: 'magOut' }, { t: 0.5, step: 'magIn' }]);
  const w = new Weapons(); const log = recorder(w);
  w.startSwap('pistol'); while (w.swapping) w.update(1 / 60, false, false, true);
  w.st.mag = 1; w.startReload(); while (w.reloading) w.update(0.07, false, false, true);
  check(steps(log).join() === 'magOut,magIn,slideRelease', `línea de tiempo del perfil: ${steps(log)}`);
  setReloadTimeline('pistol', orig);
}

// ---------- dispersión FPS ----------
{
  const base = TUNING.weapons.smg;
  const s = (o) => spreadFor('smg', o);
  check(s({}) === base.spreadHip && s({ aim: true }) === base.spreadAim, 'base de cadera/ADS');
  check(s({ moving: 1 }) > s({}) && s({ aim: true, moving: 1 }) > s({ aim: true }), 'moverse no abre');
  check(s({ crouched: true }) < s({}), 'agachado no cierra');
  check(s({ sliding: true }) > s({ moving: 1 }), 'deslizar no es peor que correr');
  check(s({ airborne: true }) > s({ moving: 1 }), 'en el aire no es peor que correr');
  check(s({ sinceSprint: 0 }) > s({ sinceSprint: 0.2 }) && s({ sinceSprint: 0.2 }) > s({ sinceSprint: 1 }) &&
    s({ sinceSprint: 1 }) === s({}), 'penalización tras sprint no decrece hasta cero');
  check(s({ moving: 1, sliding: true, airborne: true, sinceSprint: 0 }) <= base.spreadHip * SPREAD_MODS.cap + 1e-9, 'tope de dispersión');
  check(spreadFor('sniper', { aim: true, moving: 1, airborne: true }) === 0, 'el scope del sniper deja de ser exacto');
  check(spreadFor('nope', {}) === 0, 'arma desconocida');
  check(s({ moving: true }) === s({ moving: 1 }), 'moving booleano');
}

// ---------- retroceso mecánico ----------
{
  const k0 = recoilKick('smg', 0), k1 = recoilKick('smg', 1), k1b = recoilKick('smg', 1);
  check(Math.abs(k0.pitch - TUNING.weapons.smg.recoil * 0.006) < 1e-12, 'magnitud vertical cambiada');
  check(k0.yaw === 0 && k1.yaw !== 0 && k1.yaw === k1b.yaw, 'patrón lateral no determinista');
  check(Math.abs(recoilKick('smg', 3, { aim: true }).yaw) < Math.abs(recoilKick('smg', 3).yaw), 'ADS no reduce el lateral');
  const w = new Weapons(); const got = [];
  w.on('fire', (d) => got.push(d.kick));
  for (let i = 0; i < 30; i++) w.update(1 / 60, true, false, true);
  check(got.length > 1 && got.every((k, i) => k.yaw === recoilKick('smg', i).yaw) && w.lastKick.shot === got.length - 1, 'evento fire sin el kick del patrón');
}

// ---------- una tabla de qué se puede disparar en qué estado (cliente = servidor) ----------
{
  const weapons = ['smg', 'shotgun', 'pistol', 'sniper', 'bazooka', 'stun', 'frag', 'grenade'];
  check(actionOf('smg') === 'hitscan' && actionOf('bazooka') === 'projectile' && actionOf('frag') === 'thrown' &&
    actionOf('grenade') === 'thrown' && actionOf('stun') === 'stun' && actionOf('melee') === 'melee', 'clases de acción');
  for (const w of weapons) {
    for (const st of ['roadie', 'mantle', 'melee', 'dead', 'dive']) check(!canFireInState(st, w), `${w} permitido en ${st}`);
    for (const st of ['idle', 'run', 'crouch', 'jump', 'slide']) check(canFireInState(st, w), `${w} prohibido en ${st}`);
    const d = sprintFireDelay(w);
    check(d >= 0.15 && d <= 0.3 && (TUNING.weapons[w].sprintToFire == null || d === TUNING.weapons[w].sprintToFire), `${w}: retraso ${d}`);
    // servidor: el último estado roadie replicado acota por debajo el fin real del sprint
    check(sprintFireOk(10, 10 + d, w) && sprintFireOk(10, 10 + d - FIRE_GATE_NET_TOL + 1e-6, w), `${w}: tiro honesto rechazado`);
    check(!sprintFireOk(10, 10 + d - FIRE_GATE_NET_TOL - 0.01, w), `${w}: tiro desde el sprint aceptado`);
    check(sprintFireOk(-Infinity, 0, w) && sprintFireOk(undefined, 0, w), `${w}: sin sprint previo`);
  }
  check(!canFireInState('nope', 'smg'), 'estado desconocido permitido');
  check(Object.isFrozen(FIRE_GATES), 'la tabla es mutable');
  // el cliente usa la MISMA tabla: fireAligned() coincide con ella en cada estado del jugador
  const cam = { yaw: 0, pitch: 0, flatForward: () => ({ x: 0, z: -1 }), flatRight: () => ({ x: 1, z: 0 }) };
  const world = { groundHeight: () => 0, resolveCircle() {}, raycast: () => null };
  for (const st of ['idle', 'run', 'crouch', 'slide', 'roadie', 'mantle', 'melee']) for (const w of weapons) {
    const c = new Controller(world, cam); c.respawn({ x: 0, z: 0, yaw: 0 }); c.setWeapon(w);
    c.state = st; c.mantle = st === 'mantle' ? { t: 0, dur: 1 } : null; c.sinceSprint = 5;
    check(c.fireAligned() === canFireInState(c.animState(), w), `fireAligned(${st}, ${w}) = ${c.fireAligned()} ≠ tabla`);
    if (st !== 'roadie') { c.sinceSprint = sprintFireDelay(w) - 0.01; check(!c.fireAligned(), `${w}: dispara antes del retraso en ${st}`); }
  }
}

if (failures.length) {
  console.error(`FPS WEAPONS FAIL (${failures.length})\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('FPS WEAPONS OK — eventos una vez (5 tamaños de paso), cancelaciones, escopeta, cambio, en seco, granada rápida, dispersión, retroceso, cadencia del servidor');
