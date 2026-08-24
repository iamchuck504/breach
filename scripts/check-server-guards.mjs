// Contratos unitarios de las guardas del servidor. Estos tests no dependen de
// una partida ni del navegador y cubren los límites exactos que protegen la red.
import assert from 'node:assert/strict';
import { TUNING } from '../src/config/tuning.js';
import {
  MAX_WS_PAYLOAD, MESSAGE_BURST, MessageRateGuard, acceptMovement,
  consumeShotAmmo, createAmmoBudget, grantWeaponAmmo, refillNormalAmmo,
  resetMovementGuard,
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
assert.equal(consumeShotAmmo(bot, 'smg'), true, 'la IA perdió su presupuesto normal interno');
assert.equal(consumeShotAmmo(bot, 'sniper'), false, 'un bot inventó munición especial');
assert.equal(grantWeaponAmmo(bot, 'sniper'), total('sniper'));
for (let i = 0; i < total('sniper'); i++) assert.equal(consumeShotAmmo(bot, 'sniper'), true);
assert.equal(consumeShotAmmo(bot, 'sniper'), false, 'el sniper de bot no agotó munición');
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

const rate = new MessageRateGuard(0);
for (let i = 0; i < MESSAGE_BURST; i++) assert.equal(rate.allow(0, 20), true);
assert.equal(rate.allow(0, 20), false, 'la ráfaga no fue limitada');
assert.equal(rate.allow(1, 20), true, 'el bucket no recuperó crédito con el tiempo');
assert.ok(MAX_WS_PAYLOAD >= 16 * 1024 && MAX_WS_PAYLOAD <= 64 * 1024,
  'el payload máximo perdió un límite razonable');

console.log('SERVER GUARDS OK · munición, movimiento, payload y rate limit validados');
