import assert from 'node:assert/strict';
import { nextRespawnWave } from '../src/game/respawn-wave.js';
import { takeDropAmmo, canReplaceDrop, replacementSlot } from '../src/game/drop-policy.js';
import { Weapons } from '../src/combat/weapons.js';
import { Controller } from '../src/player/controller.js';
import { BotMatch } from '../src/game/botmatch.js';
for (const epoch of [0, 100.25]) {
  for (const time of [0, 0.1, 9.99, 10, 19.999, 35]) {
    const next = nextRespawnWave(epoch + time, epoch);
    assert.ok(next > epoch + time && next - epoch - time <= 10);
    assert.equal((next - epoch) % 10, 0);
  }
  assert.equal(nextRespawnWave(epoch + 1, epoch), nextRespawnWave(epoch + 9, epoch));
}
const drop = { mag: 20, res: 50 };
assert.equal(BotMatch.prototype.livesOf.call({ external: false, playerTeam: 'red', cb: { player: () => ({ alive: false }) }, bots: [], pool: { red: 0 }, respawnQueue: [{ id: 'player' }] }, 'red'), 1, 'reserved wave life prevents premature round end');
assert.equal(takeDropAmmo(drop, 5), 5);
assert.equal(drop.mag + drop.res, 65);
assert.equal(takeDropAmmo(drop, 0), 0);
assert.equal(takeDropAmmo(drop, 100), 65);
assert.equal(takeDropAmmo(drop, 100), 0);
const weapons = new Weapons();
assert.ok(canReplaceDrop(weapons.slots, 'sniper'));
assert.equal(replacementSlot(weapons.slots, 'shotgun'), 1);
assert.equal(replacementSlot(weapons.slots, 'pistol'), 0);
weapons.giveSpecial('sniper');
weapons.state.sniper.mag = 0; weapons.state.sniper.reserve = 0;
weapons.refill();
assert.equal(weapons.state.sniper.mag + weapons.state.sniper.reserve, 0);
assert.equal(canReplaceDrop(weapons.slots, 'sniper'), false);
const world = { resolveCircle() {}, groundHeight: () => 0, findCover: () => null };
const cam = { yaw: 0, pitch: 0, flatForward: () => ({ x: 0, z: -1 }), flatRight: () => ({ x: 1, z: 0 }) };
const p = new Controller(world, cam);
assert.equal(p._tryEvade({ x: 0, z: -1 }, 5), 'dive');
assert.equal(p.cover, null);
const face = { a: { x: -2, z: -3 }, b: { x: 2, z: -3 }, n: { x: 0, z: 1 }, h: 2 };
world.findCover = () => ({ target: { x: 0, z: -2.6 }, face, dist: 3 });
p.evadeCooldown = 0;
assert.equal(p._tryEvade({ x: 0, z: -1 }, 5), 'slide');
p.evadeCooldown = 0;
world.resolveCircle = probe => { probe.x += 0.4; };
assert.equal(p._tryEvade({ x: 0, z: -1 }, 5), 'dive');
console.log('PASS: global wave boundaries, partial ammo conservation, special exclusion, manual replacement and reachable-cover selection.');
