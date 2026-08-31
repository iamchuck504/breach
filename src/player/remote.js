// Jugador remoto: buffer de snapshots + interpolación con retraso fijo.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { Rig } from './rig.js';

// módulo, NO bucle while: con un delta enorme (dato remoto corrupto) el
// while nunca terminaba por precisión float y congelaba la pestaña entera
const lerpAngle = (a, b, k) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

export class RemotePlayer {
  constructor(scene, id, name, team, variant = 0) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.rig = new Rig(scene, team, name, variant);
    this.buf = []; // {rt, x, z, yaw, st, aim, p, w, sp}
    this.alive = true;
    this.x = 0; this.z = 0; this.yaw = 0;
    this.st = 'idle'; this.aim = false; this.pitch = 0; this.aimErr = 0; this.sp = 0;
    this.coverLean = 0; this.coverExposure = 1; this.coverKind = null;
    this.aimSide = 1;
    this.aimLineOrigin = new THREE.Vector3(); this.aimLineDir = new THREE.Vector3();
    this.firing = 0; // timer, lo activa el evento de fuego remoto
  }

  push(s) {
    this.buf.push({ rt: performance.now() / 1000, ...s });
    if (this.buf.length > 40) this.buf.shift();
  }

  // El evento de disparo viaja inmediatamente, mientras la pose normal se
  // interpola con retraso. Aplicar este pequeño snapshot visual evita mostrar
  // el flash sobre low-ready cuando el tirador ya había asentado ADS.
  applyFirePose(pose, weapon) {
    const hasPose = !!pose && typeof pose === 'object' && !Array.isArray(pose);
    if (hasPose) {
      if (typeof pose.st === 'string') this.st = pose.st;
      this.aim = !!pose.a;
      if (Number.isFinite(pose.p)) this.pitch = pose.p;
      if (Number.isFinite(pose.ae)) this.aimErr = pose.ae;
      if (Number.isFinite(pose.cl)) this.coverLean = pose.cl;
      if (Number.isFinite(pose.ce)) this.coverExposure = pose.ce;
      this.coverKind = typeof pose.ck === 'string' ? pose.ck : null;
      // El evento de fuego llega antes que el snapshot interpolado: cambiar de
      // hombro aquí evita mostrar un disparo izquierdo con la pose derecha.
      this.aimSide = this.aim && Math.abs(this.coverLean) > 0.1
        ? Math.sign(this.coverLean) : 1;
    }
    if (typeof weapon === 'string') {
      this._lastW = weapon;
      this.rig.setWeapon(weapon);
    }
    // Un servidor anterior no envía `fp`. En ese caso no congeles la pose
    // interpolada: una ráfaga automática podría renovar el hold para siempre.
    if (hasPose) this.firePoseT = TUNING.net.interpDelay + 0.04;
    this.firing = 0.45;
  }

  update(dt, scene) {
    const now = performance.now() / 1000;
    const t = now - TUNING.net.interpDelay;
    const b = this.buf;
    const holdFirePose = (this.firePoseT ?? 0) > 0;
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
      if (!holdFirePose) {
        this.st = s2.st; this.aim = !!s2.aim;
        this.pitch = (s1.p ?? 0) + ((s2.p ?? 0) - (s1.p ?? 0)) * k;
        this.aimErr = (s1.ae ?? 0) + ((s2.ae ?? 0) - (s1.ae ?? 0)) * k;
        this.coverLean = (s1.cl ?? 0) + ((s2.cl ?? 0) - (s1.cl ?? 0)) * k;
        this.coverExposure = (s1.ce ?? 1) + ((s2.ce ?? 1) - (s1.ce ?? 1)) * k;
        this.coverKind = s2.ck ?? null;
      }
      this.sp = s2.sp ?? 0;
      this.inv = !!s2.inv; // protección de spawn
      const w = s2.w ?? 'smg';
      if (!holdFirePose) {
        if (this._lastW && w !== this._lastW) this.swapAnim = 0.5; // gesto de cambio
        this._lastW = w;
        this.rig.setWeapon(w);
      }
    }
    this.firePoseT = Math.max(0, (this.firePoseT ?? 0) - dt);
    this.swapAnim = Math.max(0, (this.swapAnim ?? 0) - dt);
    this.firing = Math.max(0, this.firing - dt);
    // flip remoto: progreso local aproximado mientras el estado sea 'flip'
    this.flipT = this.st === 'flip' ? Math.min(1, (this.flipT ?? 0) + dt / 0.72) : 0;
    this.rig.setTransform(this.x, this.z, this.yaw, this.y ?? 0);
    const targetAimSide = this.aim && Math.abs(this.coverLean) > 0.1
      ? this.coverLean : 1;
    this.aimSide += (targetAimSide - this.aimSide) * (1 - Math.exp(-9 * dt));
    let aimLineOrigin = null, aimLineDir = null;
    if (this.aim) {
      // Reconstruir la misma línea óptica ideal del jugador observado. El
      // snapshot lleva yaw relativo, pitch y hombro de cover; con eso el rig
      // remoto puede adoptar la misma pose física aunque su cámara no exista
      // en este cliente.
      const cameraYaw = this.yaw + this.aimErr;
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const cy = Math.cos(cameraYaw), sy = Math.sin(cameraYaw);
      const side = this.aimSide;
      aimLineDir = this.aimLineDir.set(-sy * cp, sp, -cy * cp).normalize();
      aimLineOrigin = this.aimLineOrigin.set(
        this.x + sy * cp * TUNING.cam.aimDist + cy * TUNING.cam.aimShoulder * side,
        (this.y ?? 0) + TUNING.cam.aimHeight * 0.92 - sp * TUNING.cam.aimDist + 0.12,
        this.z + cy * cp * TUNING.cam.aimDist - sy * TUNING.cam.aimShoulder * side,
      );
    }
    this.rig.update(dt, {
      state: this.alive ? this.st : 'dead',
      speed: this.sp,
      aim: this.aim,
      aimPitch: this.pitch,
      aimYawErr: this.aimErr,
      coverLean: this.coverLean,
      coverAimExposure: this.coverExposure,
      coverKind: this.coverKind,
      aimLineOrigin,
      aimLineDir,
      firing: this.firing > 0,
      flipT: this.flipT,
      flipDir: 1,
      swapping: this.swapAnim > 0,
    });
    // protección de spawn: highlight sutil del color del equipo
    this.rig.setProtected(!!this.inv);
  }

  dispose(scene) { this.rig.dispose(scene); }
}
