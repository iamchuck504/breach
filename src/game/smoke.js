// Granadas de humo: proyectil físico con rebote real (paredes y suelo),
// delay de activación y nube volumétrica ligera formada por sprites suaves.
// Los bots consultan blocksSegment() desde su chequeo de línea de visión.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { makeSmokeProjectile, stepSmokeProjectile } from './smoke-physics.js';

const PUFFS = 18;
const TMP_V = new THREE.Vector3();

// Textura procedural pequeña: borde erosionado + densidad interior irregular.
// Evita depender de un asset externo y, sobre todo, elimina la silueta de
// esfera plástica que producían los MeshStandardMaterial opacos.
function smokeTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x + 0.5) / size * 2 - 1;
    const ny = (y + 0.5) / size * 2 - 1;
    const angle = Math.atan2(ny, nx);
    const radius = Math.hypot(nx, ny);
    const coarse = Math.sin(nx * 8.1 + ny * 5.7) * 0.045 +
      Math.sin(nx * 17.3 - ny * 13.1) * 0.022 +
      Math.sin(angle * 7 + radius * 9.4) * 0.035;
    const edge = 1 - smooth(0.48 + coarse, 0.98 + coarse, radius);
    const interior = 0.82 + 0.10 * Math.sin(nx * 11.7 + ny * 7.9) +
      0.08 * Math.sin(nx * 23.1 - ny * 19.7);
    const alpha = Math.max(0, Math.min(1, edge * interior));
    const i = (y * size + x) * 4;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
    image.data[i + 3] = Math.round(alpha * 255);
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

export class SmokeSystem {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.projs = [];
    this.clouds = [];
    this._smokeTexture = smokeTexture();
    this._smokeStyles = [
      [0x858b90, 0.46], [0xa4a9ad, 0.38], [0x6f767c, 0.34],
    ].map(([color, opacity]) => {
      const material = new THREE.SpriteMaterial({
        map: this._smokeTexture, color, opacity, transparent: true,
        depthTest: true, depthWrite: false, alphaTest: 0.012,
      });
      material.userData.baseOpacity = opacity;
      return material;
    });
    this._nadeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.16, 8);
    this._nadeMat = new THREE.MeshStandardMaterial({
      color: 0x525a61, roughness: 0.8, metalness: 0.2, flatShading: true,
    });
  }

  throwNade(o, v, options = {}) {
    const mesh = new THREE.Mesh(this._nadeGeo, this._nadeMat);
    mesh.castShadow = true;
    mesh.position.set(o.x, o.y, o.z);
    this.scene.add(mesh);
    this.projs.push(makeSmokeProjectile(o, v, {
      mesh,
      id: options.id ?? null,
      authoritative: !!options.authoritative,
      lastBounce: 0,
    }));
    return options.id ?? null;
  }

  update(dt) {
    const d = TUNING.weapons.grenade;

    for (let i = this.projs.length - 1; i >= 0; i--) {
      const p = this.projs[i];
      const bounced = stepSmokeProjectile(p, dt, this.world);
      if (bounced && p.t - p.lastBounce > 0.09) {
        p.lastBounce = p.t;
        this.audio.nadeBounce({ position: TMP_V.set(p.x, p.y, p.z) });
      }
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.rotation.x += dt * 9;
      p.mesh.rotation.z += dt * 6.5;
      if (p.t >= d.fuse) {
        if (p.authoritative) {
          // La predicción online nunca inventa una nube. Al alcanzar el fuse
          // conserva el bote asentado hasta recibir smokeStart del servidor.
          p.vx = 0; p.vy = 0; p.vz = 0;
        } else {
          this._pop(p, d);
          this.scene.remove(p.mesh);
          this.projs.splice(i, 1);
        }
      }
    }

    const total = d.smokeTime;
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.t += dt;
      // Nace rápido, deriva lentamente y se disipa por alpha mientras continúa
      // expandiéndose. El humo real no colapsa como una burbuja al desaparecer.
      const grow = Math.min(1, c.t / 0.55);
      const growEase = grow * grow * (3 - 2 * grow);
      const fadeRaw = Math.max(0, Math.min(1, (total - c.t) / 1.25));
      const fade = fadeRaw * fadeRaw * (3 - 2 * fadeRaw);
      const appear = Math.min(1, c.t / 0.24);
      const expansion = 1 + Math.min(1, c.t / total) * 0.16;
      c.r = d.smokeRadius * Math.max(0.01, growEase * fade);
      for (const mat of c.materials) {
        mat.opacity = mat.userData.baseOpacity * appear * fade;
        mat.rotation += dt * mat.userData.spin;
      }
      for (const m of c.puffs) {
        const u = m.userData;
        const wob = 1 + Math.sin(c.t * u.wobble + u.phase) * 0.055;
        m.position.x = u.x + u.vx * c.t + Math.sin(c.t * 0.48 + u.phase) * 0.035;
        m.position.y = u.y + u.rise * c.t;
        m.position.z = u.z + u.vz * c.t + Math.cos(c.t * 0.43 + u.phase) * 0.035;
        m.scale.set(
          Math.max(0.01, u.sx * growEase * expansion * wob),
          Math.max(0.01, u.sy * growEase * expansion / wob),
          1,
        );
      }
      if (c.t >= total) {
        this.scene.remove(c.group);
        for (const mat of c.materials) mat.dispose();
        this.clouds.splice(i, 1);
      }
    }
  }

  _pop(p, d, id = null) {
    this.audio.smokePop({ position: TMP_V.set(p.x, p.y, p.z) });
    const group = new THREE.Group();
    group.position.set(p.x, p.y, p.z);
    const puffs = [];
    // Tres materiales por nube permiten variar densidad y hacer fade con solo
    // tres cambios de estado, no un material nuevo por partícula.
    const materials = this._smokeStyles.map((base, i) => {
      const material = base.clone();
      material.userData.baseOpacity = base.userData.baseOpacity;
      material.userData.spin = (i - 1) * 0.018;
      return material;
    });
    for (let i = 0; i < PUFFS; i++) {
      const m = new THREE.Sprite(materials[i % materials.length]);
      const a = Math.random() * Math.PI * 2;
      // Varios núcleos centrales garantizan densidad; el resto forma un
      // volumen irregular, sin anillos ni siluetas esféricas evidentes.
      const rr = i < 4 ? Math.random() * 0.28
        : Math.sqrt(Math.random()) * d.smokeRadius * 0.72;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const y = 0.34 + Math.random() * d.smokeRadius * 0.62;
      const baseSize = d.smokeRadius * (0.62 + Math.random() * 0.38);
      m.position.set(x, y, z);
      Object.assign(m.userData, {
        x, y, z,
        sx: baseSize * (0.9 + Math.random() * 0.35),
        sy: baseSize * (0.85 + Math.random() * 0.42),
        vx: Math.cos(a) * (0.018 + Math.random() * 0.024),
        vz: Math.sin(a) * (0.018 + Math.random() * 0.024),
        rise: 0.018 + Math.random() * 0.035,
        phase: Math.random() * Math.PI * 2,
        wobble: 0.7 + Math.random() * 0.65,
      });
      m.scale.set(0.01, 0.01, 1);
      m.renderOrder = 3;
      group.add(m);
      puffs.push(m);
    }
    this.scene.add(group);
    // el centro visual de la nube queda a media altura de un personaje
    this.clouds.push({ id, group, puffs, materials,
      x: p.x, y: p.y + 1.0, z: p.z, t: 0, r: 0 });
  }

  bindId(clientId, serverId) {
    const projectile = this.projs.find((p) => p.id === clientId);
    if (!projectile) return false;
    projectile.id = serverId;
    projectile.authoritative = true;
    return true;
  }

  remove(id) {
    const pi = this.projs.findIndex((p) => p.id === id);
    if (pi >= 0) {
      this.scene.remove(this.projs[pi].mesh);
      this.projs.splice(pi, 1);
      return true;
    }
    const ci = this.clouds.findIndex((c) => c.id === id);
    if (ci < 0) return false;
    this._removeCloud(ci);
    return true;
  }

  activate(id, point) {
    if (!id || !point || this.clouds.some((c) => c.id === id)) return false;
    this.remove(id);
    const d = TUNING.weapons.grenade;
    this._pop({ x: point.x, y: point.y, z: point.z }, d, id);
    return true;
  }

  _removeCloud(index) {
    const c = this.clouds[index];
    if (!c) return;
    this.scene.remove(c.group);
    for (const mat of c.materials) mat.dispose();
    this.clouds.splice(index, 1);
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
    for (const c of this.clouds) {
      this.scene.remove(c.group);
      for (const mat of c.materials) mat.dispose();
    }
    this.projs.length = 0;
    this.clouds.length = 0;
  }
}
