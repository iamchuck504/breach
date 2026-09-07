export const POWER_RESPAWN_SECONDS = 45;
export class PowerRespawn {
  constructor() { this.deadline = null; }
  update(now, playing, available) {
    if (!playing || available) { this.deadline = null; return false; }
    if (this.deadline === null) this.deadline = now + POWER_RESPAWN_SECONDS;
    if (now < this.deadline) return false;
    this.deadline = null;
    return true;
  }
}
