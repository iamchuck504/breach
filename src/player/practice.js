// Modo práctica: dummies del equipo azul que patrullan entre dos puntos.
// No disparan; son blancos móviles para probar armas, cover y bounce.
import { TUNING } from '../config/tuning.js';
import { Rig } from './rig.js';

const PATROLS = [
  [{ x: -4.8, z: 3.5 }, { x: -4.8, z: 9 }],
  [{ x: 2.2, z: 6.9 }, { x: 6, z: 6.9 }],
  [{ x: 0, z: 13 }, { x: -5, z: 13 }],
  [{ x: 11, z: 4 }, { x: 13.5, z: 8 }],
];

export class Dummies {
  constructor(scene) {
    this.scene = scene;
    this.list = PATROLS.map((path, i) => ({
      id: 'dummy' + i,
      name: 'DUMMY-' + (i + 1),
      team: 'blue',
      rig: new Rig(scene, 'blue', 'DUMMY-' + (i + 1), (Math.random() * 5) | 0),
      path, seg: 0, u: Math.random(),
      x: path[0].x, z: path[0].z, yaw: 0,
      hp: TUNING.combat.hp, alive: true, respawnT: 0,
    }));
  }

  // targets para la balística
  targets() { return this.list; }

  damage(id, dmg, onKill) {
    const d = this.list.find((x) => x.id === id);
    if (!d || !d.alive) return false;
    d.hp -= dmg;
    if (d.hp <= 0) {
      d.alive = false;
      d.respawnT = 3;
      onKill?.(d);
      return true;
    }
    return false;
  }

  update(dt) {
    for (const d of this.list) {
      if (!d.alive) {
        d.respawnT -= dt;
        d.rig.update(dt, { state: 'dead', speed: 0, aim: false, aimPitch: 0 });
        if (d.respawnT <= 0) {
          d.alive = true;
          d.hp = TUNING.combat.hp;
          d.u = 0; d.seg = 0;
          d.x = d.path[0].x; d.z = d.path[0].z;
        }
        continue;
      }
      const a = d.path[d.seg], b = d.path[1 - d.seg];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      d.u += (1.6 / len) * dt;
      if (d.u >= 1) { d.u = 0; d.seg = 1 - d.seg; continue; }
      d.x = a.x + dx * d.u;
      d.z = a.z + dz * d.u;
      d.yaw = Math.atan2(-dx, -dz);
      d.rig.setTransform(d.x, d.z, d.yaw);
      d.rig.update(dt, { state: 'run', speed: 0.35, aim: false, aimPitch: 0 });
    }
  }

  dispose() { for (const d of this.list) d.rig.dispose(this.scene); }
}
