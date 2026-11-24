// Contratos unitarios de las guardas del servidor. Estos tests no dependen de
// una partida ni del navegador y cubren los límites exactos que protegen la red.
import assert from 'node:assert/strict';
import { Controller } from '../src/player/controller.js';
import { NetClient } from '../src/net/client.js';
import { World } from '../src/world/world.js';
import { eyeWorld } from '../src/combat/hit-pose.js';
import { TUNING } from '../src/config/tuning.js';
import {
  MAX_WS_PAYLOAD, MESSAGE_BURST, MessageRateGuard, acceptMovement, advanceCadenceClock,
  consumeShotAmmo, createAmmoBudget, grantWeaponAmmo, refillNormalAmmo,
  resetMovementGuard, acceptPosture, MAX_FPS_MOVE_SPEED, POSTURE_RATE, POSTURE_CREDIT, POSTURE_BANK,
} from '../server/guards.js';

const total = (weapon) => TUNING.weapons[weapon].mag + TUNING.weapons[weapon].reserve;

const soldier = { bot: false };
soldier.ammoBudget = createAmmoBudget();
assert.equal(soldier.ammoBudget.smg, total('smg'));
for (let i = 0; i < total('smg'); i++) {
  assert.equal(consumeShotAmmo(soldier, 'smg'), true, `SMG rechazó el tiro ${i + 1}`);
}
assert.equal(consumeShotAmmo(soldier, 'smg'), false, 'SMG permitió munición infinita');
refillNormalAmmo(soldier);
assert.equal(soldier.ammoBudget.smg, total('smg'), 'la caja no repuso munición normal');

const bot = { bot: true, ammoBudget: createAmmoBudget() };
bot.ammoBudget.smg = 0;
// los bots alojados se contabilizan como un jugador (cargador + reserva)
assert.equal(consumeShotAmmo(bot, 'smg'), false, 'un bot disparó sin presupuesto normal');
assert.equal(consumeShotAmmo(bot, 'sniper'), false, 'un bot inventó munición especial');
assert.equal(grantWeaponAmmo(bot, 'sniper'), total('sniper'));
// el sniper de bot tiene cargador de 1: cada tiro tras su recarga (1.7 s)
for (let i = 0; i < total('sniper'); i++) assert.equal(consumeShotAmmo(bot, 'sniper', 100 + i * 2), true);
assert.equal(consumeShotAmmo(bot, 'sniper', 100 + total('sniper') * 2), false, 'el sniper de bot no agotó munición');
assert.equal(grantWeaponAmmo(bot, 'bazooka', 999, 999), total('bazooka'),
  'un pickup excedió la capacidad real');
assert.equal(grantWeaponAmmo(bot, 'bazooka', Number.POSITIVE_INFINITY, 1), 0,
  'un valor no finito contaminó el presupuesto');

const mover = { x: 0, y: 0, z: 0 };
resetMovementGuard(mover, 0);
assert.equal(acceptMovement(mover, { x: 6, y: 0, z: 0 }, 0), true,
  'el crédito inicial no toleró una transición legítima');
mover.x = 6;
assert.equal(acceptMovement(mover, { x: 20, y: 0, z: 0 }, 0), false,
  'se aceptó un teleport horizontal');
assert.equal(acceptMovement(mover, { x: 8, y: 0, z: 0 }, 0.1), true,
  'se rechazó velocidad sostenida legítima');
mover.x = 8;
assert.equal(acceptMovement(mover, { x: 11, y: 0, z: 0 }, 0.1), false,
  'dos desplazamientos consumieron más crédito del disponible');
assert.equal(acceptMovement(mover, { x: 8, y: 6, z: 0 }, 0.2), false,
  'se aceptó un salto vertical imposible');
assert.equal(acceptMovement(mover, { x: 50, y: 10, z: 50 }, 0.2, true), true,
  'el bypass explícito de tests dejó de funcionar');

// Un estado descartado no demuestra velocidad de entrada. Sin ct se usa
// la distancia aceptada en tiempo de servidor, también si fue cero.
for (const withCt of [true,false]) {
  const e = {fps:true, x:0,y:0,z:0};
  resetMovementGuard(e, 0);
  const move = (t,x,st) => acceptMovement(e,{x,y:0,z:0,st,...(withCt ? {ct:t} : {})},t);
  assert.ok(move(0.05,0,'roadie') && move(0.15,0,'roadie'));
  assert.equal(move(0.16,40,'roadie'), false);
  assert.ok(move(0.20,0,'slide'));
  assert.equal(e.motionGuard.slideLegal,false);
}

// El mismo slide antes y después de una pausa real: misma ventana y mismo
// crédito disponible, incluso si el reloj de cadencia avanzó por la pausa.
{
  const replay = pause => {
    const e = {fps:true, x:0, y:0, z:0};
    resetMovementGuard(e, 0);
    for (let i = 1; i <= 18; i++) {
      const ct = i * 0.05, now = ct + (i >= 13 ? pause : 0);
      const st = i < 10 ? 'roadie' : 'slide';
      const x = e.x + 0.05 * (i < 10 ? TUNING.fp.sprintSpeed : TUNING.fp.slideMaxSpeed);
      advanceCadenceClock(e, ct, now);
      assert.ok(acceptMovement(e, {x,y:0,z:0,st,ct}, now));
      e.x = x;
    }
    assert.ok(e.motionGuard.slideLegal);
    const elapsed = e.motionGuard.boundedClock - (e.motionGuard.pausedTime || 0) - e.motionGuard.slideAt;
    assert.ok(Math.abs(elapsed - 0.40) < 1e-8, 'la pausa agotó la ventana del slide');
    return e.motionGuard.moveCredit;
  };
  assert.ok(Math.abs(replay(0.4) - replay(0)) < 1e-8, 'la pausa alteró el presupuesto de movimiento');
}

// FPS (corrida 6): presupuesto por postura (tuning.fp) con crédito
// proporcional; bots sin cambio
{
  const run = (fps, speed, st, secs = 4) => {
    const e = { x: 0, y: 0, z: 0, fps }; resetMovementGuard(e, 0); let ok = 0, n = Math.round(secs / 0.05);
    for (let i = 1; i <= n; i++) { const p = { x: speed * i * 0.05, y: 0, z: 0, st }; if (acceptMovement(e, p, i * 0.05)) { e.x = p.x; ok++; } }
    return ok === n;
  };
  const F = TUNING.fp;
  assert.equal(MAX_FPS_MOVE_SPEED, TUNING.dodge.maxSpeed, 'tope FPS absoluto = esquiva');
  for (const [st, v] of [['crouch', F.crouchSpeed], ['run', F.runSpeed], ['roadie', F.sprintSpeed]]) {
    assert.ok(run(true, v, st), `${st}: ${v} m/s honesto rechazado`);
    assert.ok(!run(true, v * 1.3, st), `${st}: ${v * 1.3} m/s aceptado`);
  }
  // slide: solo con entrada legal (desde sprint), ~0.5 s
  const seq = (parts) => {
    const e = { x: 0, y: 0, z: 0, fps: true }; resetMovementGuard(e, 0); let t = 0, ok = true;
    for (const [st, dur, v] of parts) for (let k = 0; k < Math.round(dur / 0.05); k++) {
      t += 0.05; const p = { x: e.x + v * 0.05, y: 0, z: 0, st }; if (acceptMovement(e, p, t)) e.x = p.x; else ok = false;
    }
    return ok;
  };
  assert.ok(seq([['roadie', 0.6, F.sprintSpeed], ['slide', F.slideTime, F.slideMaxSpeed]]), 'slide honesto rechazado');
  assert.ok(!seq([['roadie', 0.6, F.sprintSpeed], ['slide', 2, F.slideMaxSpeed]]), 'slide de 2 s a 8 m/s aceptado');
  assert.ok(!seq([['idle', 0.6, 0], ['slide', 0.5, F.slideMaxSpeed], ['crouch', 0.1, 0], ['slide', 0.5, F.slideMaxSpeed]]), 'slide sin sprint a 8 m/s aceptado');
  assert.ok(!run(true, 9, 'crouch', 1), 'agachado: 9 m/s durante 1 s aceptado (antes cabía en el crédito de 7 m)');
  assert.ok(run(false, 13, 'idle'), 'bots: el tope anterior cambió');
}
// postura: la cabeza no se teletransporta (ce/cl con ritmo acotado)
{
  const e = { fps: true }; let t = 0;
  for (let i = 0; i < 6; i++) acceptPosture(e, { st: 'crouch', ce: 0, cl: 0 }, (t += 0.05));
  const jump = acceptPosture(e, { st: 'idle', aim: true, ce: 1, cl: -1 }, (t += 0.05));
  assert.ok(jump.st === 'crouch' && jump.ce <= POSTURE_CREDIT + 1e-9 && jump.cl >= -POSTURE_CREDIT - 1e-9, `cabeza teletransportada: ${JSON.stringify(jump)}`);
  // honesto a 1/0.15 s (asomo bajando, el gesto más rápido): sin recorte
  const h = { fps: true }; let tt = 0, lag = 0;
  for (let i = 0; i <= 40; i++) {
    const want = Math.max(0, 1 - Math.max(0, i * 0.05 - 0.5) / 0.15);
    lag = Math.max(lag, Math.abs(acceptPosture(h, { st: 'crouch', ce: want, cl: 0 }, (tt += 0.05)).ce - want));
  }
  assert.ok(lag < 1e-9 && POSTURE_RATE >= 1 / 0.15, `guarda de postura recorta a un honesto (${lag})`);
  // estados de bots fuera de la postura FPS: intactos
  assert.deepEqual(acceptPosture({}, { st: 'cover_low', aim: true, ce: 0.7, cl: 1 }, 1), { st: 'cover_low', ce: 0.7, cl: 1 });
}

// LOW de 1.1 m, mismo orden que simStep: mover, settle, preparar/soltar, emitir.
for (const [hz, kind] of [[30, 'grenade'], [60, 'frag']]) {
  const world = Object.assign(Object.create(World.prototype), {
    colliders: [{ minx: -2, maxx: 2, minz: -1, maxz: 0, h: 1.1 }],
    fx: 20, fz: 20, faces: [], segmentColliders: [], groundHeight: () => 0,
  });
  const yaw = -1.13, camera = { yaw, pitch: 0.93,
    flatForward: () => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) }),
    flatRight: () => ({ x: Math.cos(yaw), z: -Math.sin(yaw) }) };
  const p = new Controller(world, camera), net = new NetClient();
  p.respawn({ x: 0, z: 0.4, yaw });
  const weapon = { cur: kind, st: { mag: 1, reserve: 0 }, throwCommitted: false };
  p.bindWeapons(weapon);
  let ct = 0, arrival = 0, released = false;
  const entity = { fps: true }, samples = [];
  net.connected = true; p.poseClock = () => ct;
  net.send = m => {
    // El primer estado de la bajada llega tarde. El siguiente ya estaba en cola.
    const jitter = samples.length === 2 ? 0 : 0.059;
    arrival = Math.max(arrival + 0.001, ct + jitter);
    const got = acceptPosture(entity, m, arrival, m.ct);
    samples.push([m.ct, arrival, m.ce]);
    assert.equal(got.st, m.st);
    assert.ok(Math.abs(got.ce - m.ce) < 1e-9, JSON.stringify({ hz, samples, got }));
    assert.ok(Math.abs(got.cl - m.cl) < 1e-9);
    if (m.t !== 's') {
      const eye = ps => eyeWorld({ ...ps, wep: kind, pitch: m.p }, m.x, m.y, m.z, m.yaw);
      assert.deepEqual(eye(got), eye(m));
      assert.equal(m.st, 'crouch'); assert.equal(m.ce, 0);
      released = true;
    }
  };
  const input = { moveVec: () => ({ x: 0, z: input.sprintHeld ? 1 : 0 }), releaseToggle() {} };
  for (let k = 1; k <= hz; k++) {
    ct = k / hz;
    input.crouchHeld = ct > (hz === 30 ? 2 / hz : 0.05);
    input.sprintHeld = weapon.throwCommitted = ct > 0.4 && ct <= 0.7;
    p.update(1 / hz, input, false); p.settle();
    if (input.sprintHeld) assert.equal(p.state, 'crouch');
    if (k === Math.floor(0.7 * hz)) net.send(net.shotSample(p, kind, { t: ct }));
    net.tickState(1 / hz, p, weapon, ct);
  }
  assert.ok(released);
}

// El gasto total, incluso con ct adelantado y mensajes simultáneos, está
// respaldado por tiempo real. Se alternan los extremos para agotar el saldo.
const postureTravel = clockRate => {
  const e = { fps: true }; let total = 0, last = 1;
  for (let i = 0; i < 400; i++) {
    const now = Math.floor(i / 2) * 0.01;
    const { ce } = acceptPosture(e, { st: 'crouch', ce: i % 2, cl: 0 }, now, i * 0.005 * clockRate);
    assert.ok(e.postureGuard.bank >= 0 && e.postureGuard.bank <= POSTURE_BANK);
    total += Math.abs(ce - last); last = ce;
    assert.ok(total <= POSTURE_CREDIT + POSTURE_RATE * now + 1e-9);
  }
  return total;
};
assert.ok(postureTravel(10) <= postureTravel(1) + 1e-9);

const rate = new MessageRateGuard(0);
for (let i = 0; i < MESSAGE_BURST; i++) assert.equal(rate.allow(0, 20), true);
assert.equal(rate.allow(0, 20), false, 'la ráfaga no fue limitada');
assert.equal(rate.allow(1, 20), true, 'el bucket no recuperó crédito con el tiempo');
assert.ok(MAX_WS_PAYLOAD >= 16 * 1024 && MAX_WS_PAYLOAD <= 64 * 1024,
  'el payload máximo perdió un límite razonable');

console.log('SERVER GUARDS OK · munición, movimiento (FPS por postura), postura, payload y rate limit validados');
