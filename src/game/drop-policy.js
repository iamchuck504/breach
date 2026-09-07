import { TUNING } from '../config/tuning.js';

// Ammo families are intentionally weapon-specific: normal pickups cannot
// manufacture sniper rounds or rockets.
export function takeDropAmmo(drop, capacity) {
  const available = Math.max(0, drop.mag) + Math.max(0, drop.res);
  const amount = Math.min(available, Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0);
  const fromReserve = Math.min(drop.res, amount);
  drop.res -= fromReserve;
  drop.mag -= amount - fromReserve;
  return amount;
}
export function replacementSlot(slots, current) {
  const slot = slots.indexOf(current);
  return slot === 1 ? 1 : 0;
}
export function canReplaceDrop(slots, weapon) {
  return !!TUNING.weapons[weapon] && !TUNING.weapons[weapon].thrown &&
    weapon !== 'pistol' && !slots.includes(weapon);
}
