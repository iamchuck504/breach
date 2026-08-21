// Modo práctica: dummies del equipo azul que patrullan entre dos puntos.
// No disparan; son blancos móviles para probar armas, cover y bounce.
import { TUNING } from '../config/tuning.js';
import { Rig, RAGDOLL_R } from './rig.js';

// Rutas base afinadas para Fortaleza (21×26.6); en otros mapas se ESCALAN a
// las dimensiones reales y se corrigen contra la geometría (resolveCircle)
// para que ningún dummy patrulle dentro de un bloque.
const PATROLS = [
  [{ x: -4.8, z: 3.5 }, { x: -4.8, z: 9 }],
  [{ x: 2.2, z: 6.9 }, { x: 6, z: 6.9 }],
  [{ x: 0, z: 13 }, { x: -5, z: 13 }],
  [{ x: 11, z: 4 }, { x: 13.5, z: 8 }],
];

export class Dummies {
  constructor(scene, world = null) {
    this.scene = scene;
    this.world = world;
    const sx = world ? world.fx / 21 : 1;
    const sz = world ? world.fz / 26.6 : 1;
    const fit = (p) => {
      const q = { x: p.x * sx, z: p.z * sz };
      if (world) world.resolveCircle(q, 0.45, 0);
      return q;
    };
    this.list = PATROLS.map((base, i) => {
      const path = base.map(fit);
      const rig = new Rig(scene, 'blue', 'DUMMY-' + (i + 1), (Math.random() * 5) | 0);
      if (world) {
        rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, 0.38, y);
        rig.collideFn = (p, y, r = RAGDOLL_R) => world.resolveCircle(p, r, y);
      }
      return {
        id: 'dummy' + i,
        name: 'DUMMY-' + (i + 1),
        team: 'blue',
        rig,
        path, seg: 0, u: Math.random(),
        x: path[0].x, z: path[0].z, yaw: 0,
        hp: TUNING.combat.hp, alive: true, respawnT: 0,
        hitOX: 0, hitOZ: 0,
      };
    });
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

  recoil(id, dx, dz, distance = 0.14) {
    const d = this.list.find((x) => x.id === id);
    if (!d || !d.alive) return;
    const len = Math.max(0.001, Math.hypot(dx, dz));
    d.hitOX += (dx / len) * distance;
    d.hitOZ += (dz / len) * distance;
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
          d.hitOX = 0; d.hitOZ = 0;
          d.x = d.path[0].x; d.z = d.path[0].z;
        }
        continue;
      }
      const a = d.path[d.seg], b = d.path[1 - d.seg];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      d.u += (1.6 / len) * dt;
      if (d.u >= 1) { d.u = 0; d.seg = 1 - d.seg; continue; }
      const baseX = a.x + dx * d.u, baseZ = a.z + dz * d.u;
      const recoilDamp = Math.exp(-4.8 * dt);
      d.hitOX *= recoilDamp; d.hitOZ *= recoilDamp;
      d.x = baseX + d.hitOX;
      d.z = baseZ + d.hitOZ;
      if (this.world) {
        const q = { x: d.x, z: d.z };
        this.world.resolveCircle(q, 0.42, 0);
        d.x = q.x; d.z = q.z;
      }
      d.yaw = Math.atan2(-dx, -dz);
      d.rig.setTransform(d.x, d.z, d.yaw);
      d.rig.update(dt, { state: 'run', speed: 0.35, aim: false, aimPitch: 0 });
    }
  }

  dispose() { for (const d of this.list) d.rig.dispose(this.scene); }
}
