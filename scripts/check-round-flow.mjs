import assert from 'node:assert/strict';
import { BotMatch } from '../src/game/botmatch.js';
import { ROUND_FINISH_HOLD } from '../src/game/match-flow.js';

assert.equal(ROUND_FINISH_HOLD, 2, 'la baja final no conserva dos segundos');
const fake = {
  phase: 'playing', phaseT: 0, pendingRoundWinner: null,
  respawnQueue: [{ id: 'victim', t: 1 }],
  coverClaims: new Map([['bot', {}]]),
  tacticalClaims: new Map([['bot', {}]]),
};
BotMatch.prototype._holdRoundResult.call(fake, 'blue');
assert.equal(fake.phase, 'round-finish');
assert.equal(fake.phaseT, 2);
assert.equal(fake.pendingRoundWinner, 'blue');
assert.equal(fake.respawnQueue.length, 0, 'quedó un respawn durante la baja final');
assert.equal(fake.coverClaims.size + fake.tacticalClaims.size, 0, 'quedaron decisiones tácticas activas');
assert.equal(BotMatch.prototype.controlsLocked.call(fake), false,
  'la cámara/control local se bloqueó durante el momento final');
fake.phase = 'intermission';
assert.equal(BotMatch.prototype.controlsLocked.call(fake), true,
  'el intermedio no bloqueó los controles');
console.log('ROUND FLOW OK · 2.00s sin overlay antes del resultado');
