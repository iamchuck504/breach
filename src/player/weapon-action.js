// Movimiento de las piezas en el marco del arma. Usa el progreso de recarga
// que ya recibe el rig, también cuando un remoto entra a mitad del gesto.
import { MathUtils, Vector3 } from 'three';
import { PROFILES } from '../view/fp/profiles.js';
import { evalTrack } from '../view/fp/anim.js';

const value = [0], point = new Vector3(), axis = new Vector3();
const sample = (track, t) => track ? MathUtils.clamp(evalTrack(track, t, value)[0], 0, 1) : 0;
const windowWeight = (t, a, b, c, d) => MathUtils.smoothstep(t, a, b) * (1 - MathUtils.smoothstep(t, c, d));
const carry = {
  smg: [0.13, 0.15, 0.58, 0.62], pistol: [0.02, 0.12, 0.50, 0.55],
  stun: [0.02, 0.12, 0.50, 0.55], shotgun: [0.24, 0.38, 0.83, 0.94],
  bazooka: [0, 0.12, 0.20, 0.25],
};

export function resetWeaponAction(gun) {
  if (!gun) return;
  for (const part of Object.values(gun.userData.weaponParts ?? {})) {
    part.bone.position.copy(part.rest);
    part.bone.rotation.set(0, 0, 0);
    part.bone.scale.setScalar(1);
  }
  gun.userData.shotAge = undefined;
  gun.userData.rocketFired = false;
}

export function updateWeaponAction(rig, dt, pose, reloading, pump, released) {
  const gun = rig.activeGun, data = gun.userData, parts = data.weaponParts;
  if (!parts) return;
  const key = rig._wep, profile = PROFILES[key], spec = profile.parts;
  const t = reloading ? pose.reloadT ?? 0 : 0;
  const age = data.shotAge ?? Infinity;
  const trigger = Math.max(0, 1 - age / 0.12);
  if (parts.trigger) parts.trigger.bone.rotation.x = -trigger * spec.triggerTravel;
  const tracks = reloading ? profile.reload?.tracks : null;
  const slide = parts[spec.bolt];
  if (slide) {
    let stroke = sample(tracks?.bolt, t);
    if (profile.cycle && Number.isFinite(age)) {
      const u = (age - profile.cycle.delay) / profile.cycle.dur;
      stroke = Math.max(stroke, sample(profile.cycle.tracks.bolt, u));
    } else if (age < 0.12) stroke = Math.max(stroke, Math.sin(Math.PI * age / 0.12));
    slide.bone.position.copy(slide.rest).addScaledVector(axis.fromArray(spec.boltAxis), Math.max(pump, stroke) * spec.boltTravel);
  }
  const throwing = pose.throwT > 0 && profile.thrown;
  const throwPhase = throwing ? 1 - pose.throwT / (pose.throwTotal || 0.5) : 0;
  for (const [name, anim] of Object.entries(spec.anim ?? {})) {
    const part = parts[name];
    const track = throwing ? profile.throw.tracks[anim.track] : tracks?.[anim.track];
    const w = anim.afterRelease && !released ? 0 : sample(track, throwing ? throwPhase : t);
    if (anim.rot) part.bone.rotation.set(anim.rot[0]*w, anim.rot[1]*w, anim.rot[2]*w);
    if (name === 'pin') part.bone.position.copy(part.rest).x -= 0.10 * w;
  }
  if (Number.isFinite(age)) data.shotAge = age < 1 ? age + dt : undefined;
}

export function seatMagazine(rig, pose, reloading) {
  const key = rig._wep, data = rig.activeGun.userData, parts = data.weaponParts;
  const t = reloading ? pose.reloadT ?? 0 : 0;
  if (parts?.mag) {
    const mag = parts.mag;
    mag.bone.position.copy(mag.rest);
    const weight = reloading && carry[key] ? windowWeight(t, ...carry[key]) : 0;
    if (weight) {
      rig.armL.hand.getWorldPosition(point);
      mag.bone.parent.worldToLocal(point);
      point.sub(data.contacts.mag.position);
      mag.bone.position.addScaledVector(point, weight);
    }
    if (key === 'bazooka') {
      if (reloading && t > 0.1) data.rocketFired = false;
      mag.bone.scale.setScalar(data.rocketFired ? 0 : 1);
    }
  }
}
