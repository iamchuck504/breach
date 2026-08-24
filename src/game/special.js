// Armas ESPECIALES de mapa (sniper / bazooka): una por ronda en el punto
// marcado del mapa, alternando por número de ronda. Se recogen MANTENIENDO
// evadir junto al pedestal; reemplazan la primaria en mano y su munición no
// se rellena en cajas. Incluye el sistema de cohetes de la bazooka.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { WEAPON_BUILDERS, WEAPON_SCALES } from '../player/rig.js';

export const SPECIAL_HOLD_TIME = 0.6;
const TMP_V = new THREE.Vector3();
const TMP_D = new THREE.Vector3();
const TMP_BACK = new THREE.Vector3();

function colliderContainsPoint(c, x, y, z) {
  if (!c || y < -0.1 || y > c.h) return false;
  if (Number.isFinite(c.minx)) {
    return x >= c.minx && x <= c.maxx && z >= c.minz && z <= c.maxz;
  }
  if (!c.a || !c.b || !c.n || !Number.isFinite(c.half)) return false;
  const tx = c.b.x - c.a.x, tz = c.b.z - c.a.z;
  const len = Math.hypot(tx, tz);
  if (len < 0.001) return false;
  const ux = tx / len, uz = tz / len;
  const cx = (c.a.x + c.b.x) * 0.5, cz = (c.a.z + c.b.z) * 0.5;
  const ox = x - cx, oz = z - cz;
  return Math.abs(ox * ux + oz * uz) <= len * 0.5 &&
    Math.abs(ox * c.n.x + oz * c.n.z) <= c.half;
}

export class SpecialPickup {
  constructor(scene) {
    this.scene = scene;
    this.active = null;
    this.holdT = 0;
    this._ringGeo = new THREE.RingGeometry(0.6, 0.8, 28);
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb057, side: THREE.DoubleSide, transparent: true, opacity: 0.8,
    });
  }

  spawn(wep, x, z, y = 0) {
    this.clear();
    const group = new THREE.Group();
    const model = WEAPON_BUILDERS[wep](0xffb057);
    const s = WEAPON_SCALES[wep] ?? [1.3, 1.3, 1.3];
    model.scale.set(s[0], s[1], s[2]);
    model.position.y = 0.9;
    model.rotation.z = 0.14;
    group.add(model);
    const ring = new THREE.Mesh(this._ringGeo, this._ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);
    group.position.set(x, y, z);
    this.scene.add(group);
    this.active = { wep, x, z, y, group, model, ring, t: 0 };
    this.holdT = 0;
  }

  update(dt) {
    const a = this.active;
    if (!a) return;
    a.t += dt;
    a.model.position.y = 0.9 + Math.sin(a.t * 2.2) * 0.07;
    a.model.rotation.y += dt * 1.4;
    a.ring.material.opacity = 0.6 + Math.sin(a.t * 3) * 0.2;
  }

  near(px, pz, py) {
    const a = this.active;
    if (!a) return false;
    return Math.abs(py - a.y) < 1.2 && Math.hypot(px - a.x, pz - a.z) < 1.7;
  }

  take() {
    const wep = this.active?.wep ?? null;
    this.clear();
    return wep;
  }

  clear() {
    if (this.active) this.scene.remove(this.active.group);
    this.active = null;
    this.holdT = 0;
  }
}

// Cohetes de la bazooka: proyectil rápido y recto que explota al contacto
// con el mundo, por espoleta de proximidad al pasar junto a un objetivo, o
// al agotar su alcance. El daño (splash + autodaño) lo aplica el onExplode
// que inyecta main, que es quien conoce los modos de juego.
export class Rockets {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.list = [];
    // Recursos compartidos: antes cada disparo creaba geometrías/materiales
    // GPU que nunca se liberaban. Los grupos siguen siendo únicos, pero sus
    // recursos visuales se reutilizan durante toda la partida.
    this._bodyGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.42, 8);
    this._tipGeo = new THREE.ConeGeometry(0.07, 0.14, 8);
    this._glowGeo = new THREE.SphereGeometry(0.09, 6, 5);
    this._trailGeo = new THREE.ConeGeometry(0.085, 0.58, 8, 1, true);
    this._bodyMat = new THREE.MeshStandardMaterial({
      color: 0x555d64, roughness: 0.7, flatShading: true,
    });
    this._tipMat = new THREE.MeshBasicMaterial({ color: 0xffb057 });
    this._glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    this._trailMat = new THREE.MeshBasicMaterial({
      color: 0xff8a35, transparent: true, opacity: 0.58,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }

  _buildMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this._bodyGeo, this._bodyMat);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const tip = new THREE.Mesh(this._tipGeo, this._tipMat);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -0.26;
    g.add(tip);
    const glow = new THREE.Mesh(this._glowGeo, this._glowMat);
    glow.position.z = 0.26;
    g.add(glow);
    // Silueta/cola visible durante el vuelo sin crear partículas por frame.
    const trail = new THREE.Mesh(this._trailGeo, this._trailMat);
    trail.rotation.x = Math.PI / 2;
    trail.position.z = 0.53;
    trail.renderOrder = 5;
    g.add(trail);
    return g;
  }

  // En local, mine/owner deciden quién aplica el daño. En online,
  // authoritative=true conserva solo la predicción visual: el servidor envía
  // después el contacto y el splash definitivos.
  fire(o, dir, mine = true, owner = null, id = null, authoritative = false) {
    const d = TUNING.weapons.bazooka;
    const mesh = this._buildMesh();
    mesh.position.set(o.x, o.y, o.z);
    mesh.lookAt(o.x + dir.x, o.y + dir.y, o.z + dir.z);
    this.scene.add(mesh);
    this.list.push({
      mesh, mine, owner, id, authoritative,
      x: o.x, y: o.y, z: o.z,
      vx: dir.x * d.projSpeed, vy: dir.y * d.projSpeed, vz: dir.z * d.projSpeed,
      t: 0, maxT: (d.range / d.projSpeed) + 0.2,
    });
  }

  // targets: [{x,z,y,alive}] para la espoleta de proximidad
  update(dt, targets, onExplode) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      r.t += dt;
      // Online, el servidor decide contacto y detonación. El cliente conserva
      // movimiento inmediato del mesh, pero nunca inventa el punto de splash.
      if (r.authoritative) {
        r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
        r.mesh.position.set(r.x, r.y, r.z);
        // Fallback de limpieza: WebSocket es fiable, pero un cambio de fase o
        // desconexión no debe dejar proyectiles visuales para siempre.
        if (r.t > r.maxT + 2) {
          this.scene.remove(r.mesh); this.list.splice(i, 1);
        }
        continue;
      }
      const step = Math.hypot(r.vx, r.vy, r.vz) * dt;
      TMP_V.set(r.x, r.y, r.z);
      TMP_D.set(r.vx, r.vy, r.vz).normalize();
      const hit = this.world.raycastHit(TMP_V, TMP_D, step + 0.12);
      let boom = null;
      let boomInfo = null;
      if (hit) {
        // separar la explosión de la superficie por la NORMAL del impacto:
        // detonar exactamente sobre el collider auto-ocluía la línea de
        // efecto contra esa misma pared y el splash no dañaba a nadie
        let impact = hit;
        let impactDir = TMP_D;
        // Un arma larga puede dejar el muzzle mínimamente dentro de una
        // pared. En ese caso el raycast normal devuelve la cara LEJANA y el
        // cohete atraviesa el obstáculo antes de explotar. Buscar la salida
        // en sentido contrario recupera la cara por la que llegó el arma y
        // conserva tanto el bloqueo físico como el autodaño a quemarropa.
        if (colliderContainsPoint(hit.collider, r.x, r.y, r.z)) {
          TMP_BACK.copy(TMP_D).multiplyScalar(-1);
          const backHit = this.world.raycastHit(TMP_V, TMP_BACK, 8);
          if (backHit) { impact = backHit; impactDir = TMP_BACK; }
        }
        const n = impact.normal ?? { x: 0, y: 1, z: 0 };
        const contact = {
          x: r.x + impactDir.x * impact.t,
          y: r.y + impactDir.y * impact.t,
          z: r.z + impactDir.z * impact.t,
        };
        boom = { x: contact.x + (n.x ?? 0) * 0.3,
          y: contact.y + (n.y ?? 0) * 0.3,
          z: contact.z + (n.z ?? 0) * 0.3 };
        boomInfo = {
          kind: 'world', direct: false, normal: { x: n.x ?? 0, y: n.y ?? 1, z: n.z ?? 0 },
          surface: impact.surface || 'concrete',
          visualPos: { x: contact.x + (n.x ?? 0) * 0.035,
            y: contact.y + (n.y ?? 0) * 0.035,
            z: contact.z + (n.z ?? 0) * 0.035 },
          direction: { x: TMP_D.x, y: TMP_D.y, z: TMP_D.z },
        };
      } else {
        r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
        // espoleta de proximidad: pasar a <0.7m del torso de un objetivo
        for (const tg of targets) {
          if (tg.alive === false) continue;
          // la espoleta no se activa con el propio bando de quien lo lanzó
          if (r.owner && tg.team && tg.team === r.owner.team) continue;
          const dx = tg.x - r.x, dy = (tg.y ?? 0) + 0.9 - r.y, dz = tg.z - r.z;
          if (dx * dx + dy * dy + dz * dz < 0.7 * 0.7) {
            boom = { x: r.x, y: r.y, z: r.z };
            boomInfo = {
              kind: 'direct', direct: true, targetId: tg.id,
              surface: 'flesh', normal: { x: -TMP_D.x, y: -TMP_D.y, z: -TMP_D.z },
              visualPos: { x: r.x, y: r.y, z: r.z },
              direction: { x: TMP_D.x, y: TMP_D.y, z: TMP_D.z },
            };
            break;
          }
        }
        if (!boom && (r.t >= r.maxT || r.y < -0.5)) {
          boom = { x: r.x, y: r.y, z: r.z };
          boomInfo = {
            kind: 'air', direct: false, surface: 'concrete',
            normal: { x: 0, y: 1, z: 0 }, visualPos: { ...boom },
            direction: { x: TMP_D.x, y: TMP_D.y, z: TMP_D.z },
          };
        }
      }
      if (boom) {
        this.scene.remove(r.mesh);
        this.list.splice(i, 1);
        onExplode(boom, r.mine, r.owner, boomInfo);
      } else {
        r.mesh.position.set(r.x, r.y, r.z);
      }
    }
  }

  bindId(clientId, serverId) {
    const rocket = this.list.find((r) => r.id === clientId);
    if (!rocket) return false;
    rocket.id = serverId;
    rocket.authoritative = true;
    return true;
  }

  remove(id) {
    const index = this.list.findIndex((r) => r.id === id);
    if (index < 0) return false;
    this.scene.remove(this.list[index].mesh);
    this.list.splice(index, 1);
    return true;
  }

  clear() {
    for (const r of this.list) this.scene.remove(r.mesh);
    this.list.length = 0;
  }
}
