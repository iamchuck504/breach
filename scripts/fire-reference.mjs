// Tabla de referencia del eje físico de disparo: muzzle (mundo) y dirección
// del cañón para cada arma × estado × pitch × error de yaw, con el rig ya
// asentado. Hip fire y blindfire disparan por ese eje (main.js), así que un
// cambio de pose no puede moverlo sin querer.
//   node scripts/fire-reference.mjs [rigModule] > scripts/fixtures/fire-reference.json
// Sin argumento usa ../src/player/rig.js. La fixture se generó desde el
// rig.js de HEAD 9fc6f12 (git show HEAD:src/player/rig.js).
import * as THREE from 'three';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WEAPONS = ['pistol', 'smg', 'shotgun', 'sniper', 'bazooka'];
export const PITCHES = [-0.8, -0.4, 0, 0.4, 0.8];
export const YAWS = [-0.4, 0, 0.4];
// [nombre, parámetros fijos]
export const STATES = [
  ['hip-idle', { state: 'idle' }],
  ['hip-run', { state: 'run', speed: 0.6, moveForward: 1, moveSide: 0 }],
  ['hip-fire', { state: 'idle', firing: true }],
  ['blind_over', { state: 'blind_over', firing: true, coverKind: 'low' }],
  ['blind_low_left', { state: 'blind_low_left', firing: true, coverKind: 'low' }],
  ['blind_low_right', { state: 'blind_low_right', firing: true, coverKind: 'low' }],
  ['blind_high_left', { state: 'blind_high_left', firing: true, coverKind: 'high' }],
  ['blind_high_right', { state: 'blind_high_right', firing: true, coverKind: 'high' }],
  ['cover_low-hide', { state: 'cover_low', coverKind: 'low' }],
  ['cover_high-hide', { state: 'cover_high', coverKind: 'high' }],
  ['cover_low-ads', { state: 'cover_low', aim: true, coverKind: 'low', coverAimExposure: 1 }],
  ['cover_high-ads-left', { state: 'cover_high', aim: true, coverKind: 'high', coverLean: -1, coverAimExposure: 1 }],
  ['cover_high-ads-right', { state: 'cover_high', aim: true, coverKind: 'high', coverLean: 1, coverAimExposure: 1 }],
  ['open-ads', { state: 'idle', aim: true }],
];

export async function measure(Rig, opts = {}) {
  const scene = new THREE.Scene();
  const out = {};
  for (const weapon of WEAPONS) for (const [name, fixed] of STATES) {
    const rig = new Rig(scene, 'red');
    rig.setWeapon(weapon);
    rig.setTransform(0, 0, 0, 0);
    for (const pitch of PITCHES) for (const yaw of YAWS) {
      const p = { speed: 0, aim: false, firing: false, twist: 0, groundPitch: 0, coverLean: 0,
        coverAimExposure: 1, ...fixed, aimPitch: pitch, aimYawErr: yaw };
      // asentado: 2,5 s a 60 Hz (la marcha queda en una fase fija y común)
      for (let i = 0; i < 150; i++) rig.update(1 / 60, p);
      rig.root.updateWorldMatrix(true, true);
      const m = rig.muzzleWorld(new THREE.Vector3());
      const d = rig.gunForward(new THREE.Vector3()).normalize();
      out[`${weapon}|${name}|${pitch}|${yaw}`] = {
        m: m.toArray().map((x) => +x.toFixed(4)), d: d.toArray().map((x) => +x.toFixed(6)),
      };
    }
    rig.dispose?.(scene);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mod = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '../src/player/rig.js';
  const { Rig } = await import(mod);
  process.stdout.write(JSON.stringify(await measure(Rig)) + '\n');
}
