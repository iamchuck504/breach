// Armas caídas: al morir un jugador, su arma cae tumbada junto al cuerpo.
// Quien la recoja recibe las balas restantes. Dura 8 s (parpadea los
// últimos 2) y desaparece. En online el server es la autoridad.
import * as THREE from 'three';
import { buildSMG, buildShotgun } from '../player/rig.js';

const LIFE = 8, BLINK_AT = 2;
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };

export class WeaponDrops {
  constructor(scene) {
    this.scene = scene;
    this.drops = new Map(); // id -> {mesh, x, z, wep, mag, res, t, claimed}
  }

  spawn(id, wep, x, z, team, mag = 0, res = 0, t = LIFE) {
    if (this.drops.has(id)) return;
    const mesh = (wep === 'shotgun' ? buildShotgun : buildSMG)(TEAM_HEX[team] ?? 0x999999);
    mesh.scale.set(1.3, 1.3, 1.35);
    const dx = x + (Math.random() - 0.5) * 0.8;
    const dz = z + (Math.random() - 0.5) * 0.8;
    mesh.position.set(dx, 0.13, dz);
    // tumbada de lado en el suelo, con orientación aleatoria
    mesh.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2 * 0.96);
    this.scene.add(mesh);
    this.drops.set(id, { mesh, x: dx, z: dz, wep, mag, res, t, claimed: false });
  }

  remove(id) {
    const d = this.drops.get(id);
    if (!d) return;
    this.scene.remove(d.mesh);
    d.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.drops.delete(id);
  }

  update(dt, px, pz, py, canPick, onPick) {
    for (const [id, d] of this.drops) {
      d.t -= dt;
      if (d.t <= 0) { this.remove(id); continue; }
      d.mesh.visible = d.t > BLINK_AT || Math.floor(d.t * 6) % 2 === 0;
      // reclamo online sin confirmación del server: vuelve a ser reclamable
      if (d.claimed && d.claimT !== undefined) {
        d.claimT -= dt;
        if (d.claimT <= 0) d.claimed = false;
      }
      // py: no se recoge desde ENCIMA de un bloque (el arma está en el suelo)
      if (canPick && !d.claimed && py < 0.8 && Math.hypot(px - d.x, pz - d.z) < 1.1) {
        onPick(id, d);
      }
    }
  }

  dispose() {
    for (const id of [...this.drops.keys()]) this.remove(id);
  }
}
