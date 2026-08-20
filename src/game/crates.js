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
  // Glow visual sin PointLight. Ocultar una caja antes cambiaba el número de
  // luces de la escena y forzaba recompilaciones de shaders justo al recogerla.
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.34 })
  );
  glow.position.y = 0.58;
  glow.scale.set(1.8, 0.55, 1.8);
  g.add(glow);
  return g;
}

export class AmmoCrates {
  // authoritative=true (online): el server manda — sin auto-respawn local y
  // el pickup solo notifica (el estado visible lo fija el broadcast del server)
  // positions: cada mapa coloca sus cajas (default: Foundry/Fortaleza) —
  // las posiciones fijas ±7,0 hacían clipping con el cover de Azoteas
  constructor(scene, authoritative = false, positions = CRATE_POS) {
    this.scene = scene;
    this.authoritative = authoritative;
    this.t = 0;
    this.crates = positions.map((p) => {
      const mesh = buildCrate();
      mesh.position.set(p.x, 0.35, p.z);
      scene.add(mesh);
      return { x: p.x, z: p.z, mesh, up: true, respawnT: 0, pendingT: 0 };
    });
  }

  setState(i, up) {
    const c = this.crates[i];
    if (!c) return;
    c.up = up;
    c.pendingT = 0;
    c.respawnT = up ? 0 : CRATE_RESPAWN;
    c.mesh.visible = up;
  }

  // canPick: jugador vivo y jugando. onPick(i) se llama al recoger.
  update(dt, px, pz, py, canPick, onPick) {
    this.t += dt;
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (!c.up) {
        // en online el respawn lo dicta el server (broadcast → setState)
        if (!this.authoritative) {
          c.respawnT -= dt;
          if (c.respawnT <= 0) { c.up = true; c.mesh.visible = true; }
        }
        continue;
      }
      // flotar + girar
      c.mesh.position.y = 0.35 + Math.sin(this.t * 2 + i * 2) * 0.08;
      c.mesh.rotation.y += dt * 0.9;
      if (c.pendingT > 0) { c.pendingT -= dt; continue; } // reclamo en vuelo
      // py: la caja está en el suelo; no se toma desde encima de un bloque
      if (canPick && py < 0.8 && Math.hypot(px - c.x, pz - c.z) < 1.15) {
        if (this.authoritative) {
          c.pendingT = 1.5; // esperar confirmación; si no llega, reintenta
        } else {
          c.up = false;
          c.respawnT = CRATE_RESPAWN;
          c.mesh.visible = false;
        }
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
