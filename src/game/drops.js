// Armas caídas: al morir un jugador, su arma cae tumbada junto al cuerpo.
// Quien la recoja recibe las balas restantes. Dura 8 s (parpadea los
// últimos 2) y desaparece. En online el server es la autoridad.
import * as THREE from 'three';
import { WEAPON_BUILDERS, WEAPON_SCALES, buildSMG } from '../player/rig.js';

const LIFE = 8, BLINK_AT = 2;
const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };

export class WeaponDrops {
  constructor(scene) {
    this.scene = scene;
    this.drops = new Map(); // id -> {mesh, x, z, wep, mag, res, t, claimed}
  }

  spawn(id, wep, x, z, team, mag = 0, res = 0, t = LIFE, y = 0) {
    if (this.drops.has(id)) return;
    const mesh = (WEAPON_BUILDERS[wep] ?? buildSMG)(TEAM_HEX[team] ?? 0x999999);
    const s = WEAPON_SCALES[wep] ?? [1.3, 1.3, 1.35];
    mesh.scale.set(s[0], s[1], s[2]);
    // offset determinista desde el id: en online todos los clientes ven el
    // arma en el MISMO punto (Math.random dispersaba hasta 0.57m por pantalla)
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    const ang = (h % 360) * Math.PI / 180;
    const rad = 0.15 + ((h >>> 9) % 100) * 0.0025;
    const dx = x + Math.cos(ang) * rad;
    const dz = z + Math.sin(ang) * rad;
    // y: altura del terreno donde murió (morir sobre un bloque ya no deja el
    // arma incrustada al nivel del piso)
    mesh.position.set(dx, y + 0.13, dz);
    mesh.rotation.set(0, ang * 5, Math.PI / 2 * 0.96);
    this.scene.add(mesh);
    this.drops.set(id, { mesh, x: dx, z: dz, y, wep, mag, res, t, claimed: false });
  }

  remove(id) {
    const d = this.drops.get(id);
    if (!d) return;
    this.scene.remove(d.mesh);
    d.mesh.traverse((o) => {
      // Las armas procedurales comparten primitivas/materiales con los rigs.
      // Destruirlos al recoger un drop corrompería los personajes restantes.
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (!m.userData.shared) m.dispose();
      }
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
      // altura RELATIVA al arma: no se recoge desde encima de un bloque, pero
      // sí un arma que cayó sobre un bloque estando tú arriba
      if (canPick && !d.claimed && Math.abs(py - d.y) < 0.8 && Math.hypot(px - d.x, pz - d.z) < 1.1) {
        onPick(id, d);
      }
    }
  }

  dispose() {
    for (const id of [...this.drops.keys()]) this.remove(id);
  }
}
