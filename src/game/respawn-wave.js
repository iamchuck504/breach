export const RESPAWN_WAVE_SECONDS = 10;
// Strictly next boundary, including a death exactly on the current boundary.
export function nextRespawnWave(now, epoch = 0) {
  return epoch + (Math.floor(Math.max(0, now - epoch) / RESPAWN_WAVE_SECONDS) + 1) * RESPAWN_WAVE_SECONDS;
}
