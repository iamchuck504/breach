// Cajas de munición: 2 en la línea media del mapa (simétricas). Recargan
// TODA la munición al pasar por encima y reaparecen a los 30 s.
// En online el server es la autoridad del estado (taken/up).
import * as THREE from 'three';

export const CRATE_POS = [{ x: 7, z: 0 }, { x: -7, z: 0 }];
export const CRATE_RESPAWN = 30;

const ACCENT = 0xff8a3d, DARK = 0x33363c, MID = 0x565b63;

function buildCrate() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.42, 0.46),
    new THREE.MeshLambertMaterial({ color: DARK })
  );
  body.castShadow = true;
  g.add(body);
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(0.66, 0.1, 0.5),
    new THREE.MeshLambertMaterial({ color: MID })
  );
  lid.position.y = 0.26;
  lid.castShadow = true;
  g.add(lid);
  for (const s of [-1, 1]) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.44, 0.48),
      new THREE.MeshLambertMaterial({ color: ACCENT })
    );
    stripe.position.set(s * 0.18, 0, 0);
    g.add(stripe);
  }
  // balas decorativas asomando
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.16, 0.06),
      new THREE.MeshLambertMaterial({ color: ACCENT })
    );
    b.position.set(-0.12 + i * 0.12, 0.36, 0);
    g.add(b);
  }
  const glow = new THREE.PointLight(ACCENT, 3, 4);
  glow.position.y = 0.6;
  g.add(glow);
  return g;
}

export class AmmoCrates {
  constructor(scene) {
    this.scene = scene;
    this.t = 0;
    this.crates = CRATE_POS.map((p) => {
      const mesh = buildCrate();
      mesh.position.set(p.x, 0.35, p.z);
      scene.add(mesh);
      return { x: p.x, z: p.z, mesh, up: true, respawnT: 0 };
    });
  }

  setState(i, up) {
    const c = this.crates[i];
    if (!c) return;
    c.up = up;
    c.respawnT = up ? 0 : CRATE_RESPAWN;
    c.mesh.visible = up;
  }

  // canPick: jugador vivo y jugando. onPick(i) se llama al recoger.
  update(dt, px, pz, canPick, onPick) {
    this.t += dt;
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (!c.up) {
        c.respawnT -= dt;
        if (c.respawnT <= 0) { c.up = true; c.mesh.visible = true; }
        continue;
      }
      // flotar + girar
      c.mesh.position.y = 0.35 + Math.sin(this.t * 2 + i * 2) * 0.08;
      c.mesh.rotation.y += dt * 0.9;
      if (canPick && Math.hypot(px - c.x, pz - c.z) < 1.15) {
        c.up = false;
        c.respawnT = CRATE_RESPAWN;
        c.mesh.visible = false;
        onPick(i);
      }
    }
  }

  dispose() {
    for (const c of this.crates) {
      this.scene.remove(c.mesh);
      c.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.crates = [];
  }
}
