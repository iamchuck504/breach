// Guardas de transporte y autoridad básica. Se mantienen fuera del servidor
// principal para poder probarlas sin levantar una partida completa.
import { TUNING } from '../src/config/tuning.js';

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
  for (const weapon of NORMAL_WEAPONS) entity.ammoBudget[weapon] = totalAmmo(weapon);
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
  return entity.ammoBudget[weapon];
}

export function consumeShotAmmo(entity, weapon) {
  if (weapon === 'melee') return true;
  // Los bots administran internamente la munición normal. Las armas especiales
  // sí se presupuestan en servidor porque solo existe una por ronda.
  if (entity?.bot && !SPECIAL_WEAPONS.has(weapon)) return true;
  if (!entity) return false;
  entity.ammoBudget ||= createAmmoBudget();
  const left = Math.floor(Number(entity.ammoBudget[weapon] || 0));
  if (left <= 0) return false;
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
