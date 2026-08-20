// Granadas de humo: proyectil físico con rebote real (paredes y suelo),
// delay de activación y nube OPACA de bajo poligonaje que bloquea la visión.
// Los jugadores no ven a través porque la geometría es opaca; los bots
// consultan blocksSegment() desde su chequeo de línea de visión.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';

const GRAVITY = 14;
const PUFFS = 9;
const TMP_P = { x: 0, z: 0 };
const TMP_V = new THREE.Vector3();

export class SmokeSystem {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.projs = [];
    this.clouds = [];
    this._mat = new THREE.MeshStandardMaterial({
      color: 0x9ba1a6, roughness: 1, metalness: 0, flatShading: true,
    });
    this._geo = new THREE.SphereGeometry(1, 7, 5);
    this._nadeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.16, 8);
    this._nadeMat = new THREE.MeshStandardMaterial({
      color: 0x525a61, roughness: 0.8, metalness: 0.2, flatShading: true,
    });
  }

  throwNade(o, v) {
    const mesh = new THREE.Mesh(this._nadeGeo, this._nadeMat);
    mesh.castShadow = true;
    mesh.position.set(o.x, o.y, o.z);
    this.scene.add(mesh);
    this.projs.push({
      mesh, x: o.x, y: o.y, z: o.z, vx: v.x, vy: v.y, vz: v.z, t: 0,
      lastBounce: 0,
    });
  }

  update(dt) {
    const d = TUNING.weapons.grenade;

    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i];
      p.t += dt;
      p.vy -= GRAVITY * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      // pared: resolver como círculo chico y reflejar la componente corregida
      TMP_P.x = nx; TMP_P.z = nz;
      this.world.resolveCircle(TMP_P, 0.12, Math.max(0, ny));
      let bounced = false;
      if (Math.abs(TMP_P.x - nx) > 1e-6) { p.vx = -p.vx * 0.45; bounced = true; }
      if (Math.abs(TMP_P.z - nz) > 1e-6) { p.vz = -p.vz * 0.45; bounced = true; }
      p.x = TMP_P.x; p.z = TMP_P.z;
      // suelo real debajo (bloques incluidos)
      const gy = this.world.groundHeight({ x: p.x, z: p.z }, 0.12, Math.max(p.y, ny));
      p.y = ny;
      if (p.y <= gy + 0.08 && p.vy <= 0) {
        p.y = gy + 0.08;
        if (Math.abs(p.vy) > 1.7) {
          p.vy = -p.vy * 0.42;
          p.vx *= 0.62; p.vz *= 0.62;
          bounced = true;
        } else {
          // rodando: fricción hasta asentarse
          p.vy = 0;
          const fr = Math.exp(-5 * dt);
          p.vx *= fr; p.vz *= fr;
        }
      }
      if (bounced && p.t - p.lastBounce > 0.09) {
        p.lastBounce = p.t;
        this.audio.nadeBounce({ position: TMP_V.set(p.x, p.y, p.z) });
      }
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.rotation.x += dt * 9;
      p.mesh.rotation.z += dt * 6.5;
      if (p.t >= d.fuse) {
        this._pop(p, d);
        this.scene.remove(p.mesh);
        this.projs.splice(i, 1);
      }
    }

    const total = d.smokeTime;
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.t += dt;
      // crece rápido, se mantiene plena y muere ENCOGIENDO (nítido, sin alpha)
      const grow = Math.min(1, c.t / 0.55);
      const fade = Math.max(0, Math.min(1, (total - c.t) / 0.9));
      const k = grow * grow * (3 - 2 * grow) * fade;
      c.r = d.smokeRadius * Math.max(0.01, k);
      for (const m of c.puffs) {
        const wob = 1 + Math.sin(c.t * 1.7 + m.userData.ph) * 0.06;
        m.scale.setScalar(Math.max(0.01, m.userData.s * d.smokeRadius * 0.6 * k * wob));
        m.rotation.y += dt * 0.25;
      }
      if (c.t >= total) {
        this.scene.remove(c.group);
        this.clouds.splice(i, 1);
      }
    }
  }

  _pop(p, d) {
    this.audio.smokePop({ position: TMP_V.set(p.x, p.y, p.z) });
    const group = new THREE.Group();
    group.position.set(p.x, p.y, p.z);
    const puffs = [];
    for (let i = 0; i < PUFFS; i++) {
      const m = new THREE.Mesh(this._geo, this._mat);
      const a = (i / PUFFS) * Math.PI * 2 + Math.random() * 0.7;
      const rr = i === 0 ? 0 : (0.3 + Math.random() * 0.5) * d.smokeRadius * 0.6;
      m.position.set(
        Math.cos(a) * rr,
        0.5 + Math.random() * (d.smokeRadius * 0.55),
        Math.sin(a) * rr,
      );
      m.userData.s = 0.5 + Math.random() * 0.4;
      m.userData.ph = Math.random() * Math.PI * 2;
      m.scale.setScalar(0.01);
      m.castShadow = false;
      group.add(m);
      puffs.push(m);
    }
    this.scene.add(group);
    // el centro visual de la nube queda a media altura de un personaje
    this.clouds.push({ group, puffs, x: p.x, y: p.y + 1.0, z: p.z, t: 0, r: 0 });
  }

  // ¿El segmento a→b cruza el núcleo denso de alguna nube activa? Usado por
  // la IA de bots como oclusión visual (mismo criterio que una pared).
  blocksSegment(ax, ay, az, bx, by, bz) {
    for (const c of this.clouds) {
      if (c.r < 0.8) continue; // naciendo o casi disipada: aún se ve a través
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = len2 > 0 ? ((c.x - ax) * dx + (c.y - ay) * dy + (c.z - az) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t - c.x, py = ay + dy * t - c.y, pz = az + dz * t - c.z;
      if (px * px + py * py + pz * pz <= c.r * c.r * 0.72) return true;
    }
    return false;
  }

  clear() {
    for (const p of this.projs) this.scene.remove(p.mesh);
    for (const c of this.clouds) this.scene.remove(c.group);
    this.projs.length = 0;
    this.clouds.length = 0;
  }
}
