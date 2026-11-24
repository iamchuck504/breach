// Todos los gestos se evalúan en la fase real del impulso. Una pausa o un
// cuadro largo conserva exactamente la correspondencia entre cuerpo y vista.
import { TUNING } from '../../config/tuning.js';
import { motionScale } from '../../core/settings.js';

const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

export function dodgeFX(dash, yaw, settings) {
  if (!dash) return null;
  const u = Math.min(1, dash.t / TUNING.dodge.duration);
  const drive = smooth(u / 0.18) * (1 - smooth((u - 0.18) / 0.76));
  const brake = Math.sin(Math.PI * smooth((u - 0.62) / 0.38));
  const side = dash.x * Math.cos(yaw) - dash.z * Math.sin(yaw);
  const front = -dash.x * Math.sin(yaw) - dash.z * Math.cos(yaw);
  const bob = motionScale('bob', settings), shake = motionScale('shake', settings);
  const reduced = settings.reduceMotion;
  return {
    side, front, u,
    fov: (drive * (reduced ? 2 : 9) - brake * (reduced ? 0 : 1.1)) * shake,
    roll: reduced ? 0 : -7 * side * drive * bob + 1.2 * Math.max(-1, Math.min(1, side + 0.55 * front)) * brake * shake,
    blur: reduced ? 0 : drive * shake,
    lag: (drive - brake * 0.25) * bob,
    dip: (drive - brake * 0.18) * bob,
  };
}
