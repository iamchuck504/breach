// Jugador remoto: buffer de snapshots + interpolación con retraso fijo.
import { TUNING } from '../config/tuning.js';
import { Rig } from './rig.js';

const lerpAngle = (a, b, k) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

export class RemotePlayer {
  constructor(scene, id, name, team) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.rig = new Rig(scene, team, name);
    this.buf = []; // {rt, x, z, yaw, st, aim, p, w, sp}
    this.alive = true;
    this.x = 0; this.z = 0; this.yaw = 0;
    this.st = 'idle'; this.aim = false; this.pitch = 0; this.sp = 0;
    this.firing = 0; // timer, lo activa el evento de fuego remoto
  }

  push(s) {
    this.buf.push({ rt: performance.now() / 1000, ...s });
    if (this.buf.length > 40) this.buf.shift();
  }

  update(dt, scene) {
    const now = performance.now() / 1000;
    const t = now - TUNING.net.interpDelay;
    const b = this.buf;
    if (b.length > 0) {
      let i = b.length - 1;
      while (i > 0 && b[i - 1].rt > t) i--;
      const s1 = b[Math.max(0, i - 1)], s2 = b[i];
      const span = Math.max(1e-4, s2.rt - s1.rt);
      const k = Math.max(0, Math.min(1, (t - s1.rt) / span));
      this.x = s1.x + (s2.x - s1.x) * k;
      this.z = s1.z + (s2.z - s1.z) * k;
      this.y = (s1.y ?? 0) + ((s2.y ?? 0) - (s1.y ?? 0)) * k;
      this.yaw = lerpAngle(s1.yaw, s2.yaw, k);
      this.st = s2.st; this.aim = !!s2.aim; this.pitch = s2.p ?? 0; this.sp = s2.sp ?? 0;
      const w = s2.w ?? 'smg';
      if (this._lastW && w !== this._lastW) this.swapAnim = 0.5; // gesto de cambio
      this._lastW = w;
      this.rig.setWeapon(w);
    }
    this.swapAnim = Math.max(0, (this.swapAnim ?? 0) - dt);
    this.firing = Math.max(0, this.firing - dt);
    // flip remoto: progreso local aproximado mientras el estado sea 'flip'
    this.flipT = this.st === 'flip' ? Math.min(1, (this.flipT ?? 0) + dt / 0.72) : 0;
    this.rig.setTransform(this.x, this.z, this.yaw, this.y ?? 0);
    this.rig.update(dt, {
      state: this.alive ? this.st : 'dead',
      speed: this.sp,
      aim: this.aim,
      aimPitch: this.pitch,
      firing: this.firing > 0,
      flipT: this.flipT,
      flipDir: 1,
      swapping: this.swapAnim > 0,
    });
  }

  dispose(scene) { this.rig.dispose(scene); }
}
