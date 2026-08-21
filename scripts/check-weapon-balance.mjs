import assert from 'node:assert/strict';
import { TUNING } from '../src/config/tuning.js';
import { damageFalloff, firearmDamage, rocketSplashDamage } from '../src/combat/damage.js';

const W = TUNING.weapons;
const closeBodyTtk = (def) => {
  const shots = Math.ceil(TUNING.combat.hp / def.dmg);
  return (shots - 1) * 60 / def.rpm;
};

// El ajuste aprobado no toca el TTK de la SMG en las distancias habituales.
assert.equal(damageFalloff(W.smg, 0), 1);
assert.equal(damageFalloff(W.smg, 35), 1);
assert.ok(Math.abs(damageFalloff(W.smg, 57.5) - 0.9) < 1e-9);
assert.equal(damageFalloff(W.smg, 80), 0.8);
assert.equal(firearmDamage(W.smg, 80, 'body'), 8);
assert.equal(firearmDamage(W.smg, 80, 'head'), 12.8);
assert.ok(Math.abs(closeBodyTtk(W.smg) - 0.8709677419) < 1e-6);

// El resto del arsenal conserva exactamente los valores auditados/aprobados.
assert.deepEqual(
  {
    shotgun: [W.shotgun.dmg, W.shotgun.pellets, W.shotgun.rpm, W.shotgun.falloffStart,
      W.shotgun.falloffEnd],
    pistol: [W.pistol.dmg, W.pistol.headMult, W.pistol.rpm],
    sniper: [W.sniper.dmg, W.sniper.headMult, W.sniper.rpm],
    bazooka: [W.bazooka.dmg, W.bazooka.splashRadius, W.bazooka.projSpeed],
    melee: [TUNING.melee.dmg, TUNING.melee.range],
  },
  {
    shotgun: [13, 8, 95, 6, 19],
    pistol: [22, 2, 260],
    sniper: [85, 2.2, 34],
    bazooka: [115, 4.2, 26],
    melee: [60, 1.82],
  },
);
assert.equal(damageFalloff(W.shotgun, 19), 0);
assert.equal(rocketSplashDamage(W.bazooka, 0), 115);
assert.ok(Math.abs(rocketSplashDamage(W.bazooka, 4.2) - 28.75) < 1e-9);

console.log('WEAPON BALANCE OK · SMG 10→8 @35–80m · resto del arsenal intacto');
