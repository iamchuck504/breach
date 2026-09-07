import assert from 'node:assert/strict';
import { PowerRespawn } from '../src/game/power-respawn.js';
import { Weapons } from '../src/combat/weapons.js';
const timer = new PowerRespawn();
assert.equal(timer.update(0, true, true), false);
assert.equal(timer.update(5, true, false), false);
assert.equal(timer.deadline, 50);
assert.equal(timer.update(49.999, true, false), false);
assert.equal(timer.update(50, true, false), true);
assert.equal(timer.update(51, true, true), false);
// A loaded drop keeps the weapon recoverable until it expires.
assert.equal(timer.update(60, true, true), false);
assert.equal(timer.update(68, true, false), false);
assert.equal(timer.deadline, 113);
// Recovery cancels a pending countdown, round-end cancels it too.
timer.update(70, true, true); assert.equal(timer.deadline, null);
timer.update(72, true, false);
assert.equal(timer.update(120, false, false), false);
assert.equal(timer.deadline, null);
assert.equal(timer.update(200, true, true), false);
const w = new Weapons();
w.giveSpecial('sniper'); w.cur = 'shotgun'; w.giveSpecial('sniper');
assert.equal(w.slots.filter(k => k === 'sniper').length, 1);
assert.equal(w.slots[1], 'shotgun');
console.log('PASS: 45 seconds after depletion/loss, recovery and round cancellation, no duplicate inventory slot.');
