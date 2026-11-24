// Pruebas de red con el protocolo FPS (rondas 1–2): el servidor exige la
// muestra `fs` (con `n` creciente y `w` = arma equipada) en cada fire/rocket/
// nade/protoFire humano, y en las armas de una bala que la dirección quede en
// el cono de dispersión del eje de mirada de la muestra. Este envoltorio añade
// la muestra a partir del último estado `s` de ESE emisor, como hace NetClient
// con el subpaso. Si el `fire` sale (≤ 0.12 m) del ojo honesto, la muestra
// MIRA hacia el punto (yaw y pitch de la muestra = los del rayo) y el origen
// se recalcula como el ojo de esa mirada, igual que un jugador que apunta.
// Los orígenes desplazados a propósito (pruebas de rechazo) no se tocan.
import { eyeWorld } from '../src/combat/hit-pose.js';
let N = 1e7;
export function withSamples(sendRaw) {
  const last = new Map(); // emisor → último estado `s`
  return (peer, msg) => {
    if (msg && typeof msg === 'object') {
      if (msg.t === 's') last.set(peer, msg);
      else if (['fire', 'rocket', 'nade', 'protoFire'].includes(msg.t) && !msg.fs && !msg.bot) {
        const s = last.get(peer);
        if (s) {
          const fs = { x: s.x, y: s.y ?? 0, z: s.z, yaw: s.yaw ?? 0, st: s.st ?? 'idle', aim: s.aim ? 1 : 0,
            ce: s.ce ?? 1, cl: s.cl ?? 0, p: s.p ?? 0, sp: s.sp ?? 0, ae: s.ae ?? 0, w: s.w ?? 'smg', n: ++N };
          if (msg.t === 'fire' && msg.w !== 'melee' && Array.isArray(msg.o) && Array.isArray(msg.p)) {
            const pose = (yaw, p) => ({ st: fs.st, aim: !!fs.aim, ce: fs.ce, cl: fs.cl, pitch: p, wep: fs.w, sp: fs.sp, ae: 0 });
            const e0 = eyeWorld(pose(fs.yaw, fs.p), fs.x, fs.y, fs.z, fs.yaw);
            if (Math.hypot(msg.o[0] - e0[0], msg.o[1] - e0[1], msg.o[2] - e0[2]) <= 0.12) {
              const dx = msg.p[0] - e0[0], dy = msg.p[1] - e0[1], dz = msg.p[2] - e0[2];
              // casi vertical (tiros al cielo): se conserva el yaw del estado
              if (Math.hypot(dx, dz) > 0.2 * Math.hypot(dx, dy, dz)) fs.yaw = Math.atan2(-dx, -dz);
              fs.p = Math.max(-1.55, Math.min(1.55, Math.atan2(dy, Math.hypot(dx, dz)))); fs.ae = 0;
              const e1 = eyeWorld(pose(fs.yaw, fs.p), fs.x, fs.y, fs.z, fs.yaw);
              msg = { ...msg, o: e1.map((v) => +v.toFixed(3)) };
            }
          }
          msg = { ...msg, fs };
        }
      }
    }
    return sendRaw(peer, msg);
  };
}
export const nextN = () => ++N;
