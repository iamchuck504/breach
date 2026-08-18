// Mapa competitivo "Foundry": simétrico por rotación de 180°, diseñado para
// wallbounce (bloques bajos escalonados a 2.5-4m), corredores CQC laterales,
// centro abierto de riesgo con pilar contestado, y bases rojo/azul en ±Z.
// También es el dueño de la física estática: AABBs, raycast, resolución de círculo
// y las caras de cobertura que consume el sistema de cover.
import * as THREE from 'three';

const FIELD_X = 15, FIELD_Z = 18; // semiancho / semilargo

export class World {
  constructor(scene, layout = 'foundry') {
    this.scene = scene;
    this._buildLights();
    this.mapGroup = null;
    this.layout = null;
    this.setLayout(layout);
  }

  // Cambia de mapa en caliente: 'foundry' (grande) | 'arena' (compacto, bots)
  setLayout(layout) {
    if (this.layout === layout && this.mapGroup) return;
    this.layout = layout;
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.mapGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        }
      });
    }
    this.mapGroup = new THREE.Group();
    this.scene.add(this.mapGroup);
    this.colliders = []; // {minx,minz,maxx,maxz,h}
    this.faces = [];     // caras de cobertura {n:{x,z}, a:{x,z}, b:{x,z}, h}
    this.spawns = { red: [], blue: [] };
    const dims = { arena: [11, 13], district: [21, 25], foundry: [FIELD_X, FIELD_Z] };
    [this.fx, this.fz] = dims[layout] ?? dims.foundry;

    this._buildFloor();
    if (layout === 'arena') this._buildArena();
    else if (layout === 'district') this._buildDistrict();
    else this._buildMap();
    this._buildSpawns();
  }

  _mat(color, topColor) {
    const side = new THREE.MeshLambertMaterial({ color });
    const top = new THREE.MeshLambertMaterial({ color: topColor ?? color });
    return [side, side, top, side, side, side];
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xd8e8f2, 0x8d8578, 1.6);
    this.scene.add(hemi);
    const amb = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(amb);
    const sun = new THREE.DirectionalLight(0xfff1da, 2.3);
    sun.position.set(14, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
    sc.near = 2; sc.far = 80;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.scene.background = new THREE.Color(0xb9c8d2);
    this.scene.fog = new THREE.Fog(0xb9c8d2, 45, 95);
  }

  _buildFloor() {
    // piso con textura de grid sutil hecha en canvas
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    g.fillStyle = '#a8a49b'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(60,58,52,0.16)'; g.lineWidth = 2;
    g.strokeRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.strokeRect(8, 8, 240, 240);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(this.fx, this.fz);
    tex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(this.fx * 2, this.fz * 2),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.mapGroup.add(floor);

    // tinte de zona por equipo cerca de cada base
    for (const [color, sign] of [[0xe05545, -1], [0x4f8de0, 1]]) {
      const z = sign * (this.fz - 2.5);
      const zone = new THREE.Mesh(
        new THREE.PlaneGeometry(this.fx * 2 - 1, 4.6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.10 })
      );
      zone.rotation.x = -Math.PI / 2;
      zone.position.set(0, 0.01, z);
      this.mapGroup.add(zone);
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(this.fx * 2 - 1, 0.22),
        new THREE.MeshBasicMaterial({ color })
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(0, 0.012, z + (z < 0 ? 2.4 : -2.4));
      this.mapGroup.add(strip);
    }
    // línea central
    const mid = new THREE.Mesh(
      new THREE.PlaneGeometry(this.fx * 2 - 1, 0.14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
    );
    mid.rotation.x = -Math.PI / 2;
    mid.position.y = 0.011;
    this.mapGroup.add(mid);
  }

  // Caja física + visual. mirror=true agrega la copia rotada 180° (-x,-z).
  _box(x, z, w, d, h, { mirror = true, color = 0x9a958c, top = 0xaeaaa1, cover = true } = {}) {
    const place = (px, pz) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._mat(color, top));
      mesh.position.set(px, h / 2, pz);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.mapGroup.add(mesh);
      const minx = px - w / 2, maxx = px + w / 2, minz = pz - d / 2, maxz = pz + d / 2;
      this.colliders.push({ minx, minz, maxx, maxz, h });
      if (cover) {
        this.faces.push(
          { n: { x: 1, z: 0 }, a: { x: maxx, z: minz }, b: { x: maxx, z: maxz }, h },
          { n: { x: -1, z: 0 }, a: { x: minx, z: minz }, b: { x: minx, z: maxz }, h },
          { n: { x: 0, z: 1 }, a: { x: minx, z: maxz }, b: { x: maxx, z: maxz }, h },
          { n: { x: 0, z: -1 }, a: { x: minx, z: minz }, b: { x: maxx, z: minz }, h },
        );
      }
    };
    place(x, z);
    if (mirror && !(x === 0 && z === 0)) place(-x, -z);
  }

  _buildMap() {
    const LOW = 1.05, HIGH = 2.4;
    const lowOpts = { color: 0x9c968c, top: 0xc6c1b5 };
    const highOpts = { color: 0x969188, top: 0xaba69d };

    // --- muros perimetrales (no espejar, cover en cara interna solamente por geometría)
    const wallOpts = { mirror: false, color: 0x8a857d, top: 0x9a958c };
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, 3.2, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, 3.2, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, 3.2, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, 3.2, wallOpts);

    // --- base (lado rojo; espejo crea el lado azul)
    // escudo de spawn con salidas a los lados
    this._box(0, -14.6, 7, 0.9, 2.3, highOpts);
    // coberturas bajas flanqueando las salidas
    this._box(-5.4, -12.2, 2.4, 0.9, LOW, lowOpts);
    this._box(5.4, -12.2, 2.4, 0.9, LOW, lowOpts);

    // --- corredores laterales CQC (paredes altas con carril entre pared y perímetro)
    this._box(-10.6, -8.8, 0.8, 5.2, HIGH, highOpts);
    this._box(10.6, -8.8, 0.8, 5.2, HIGH, highOpts);

    // --- cadena de bloques bajos escalonados (ruta de wallbounce hacia el centro)
    this._box(-2.2, -9.2, 2.6, 0.9, LOW, lowOpts);
    this._box(2.4, -6.9, 2.6, 0.9, LOW, lowOpts);
    this._box(-1.8, -4.5, 2.6, 0.9, LOW, lowOpts);

    // --- pilar alto de flanco + cover vertical oeste
    this._box(6.8, -4.2, 1.2, 1.2, 2.5, highOpts);
    this._box(-7.4, -6.0, 0.9, 2.6, LOW, lowOpts);

    // --- cover del carril lateral
    this._box(-13.0, -3.2, 1.6, 0.9, LOW, lowOpts);

    // --- cerca del centro
    this._box(4.2, -1.6, 3.0, 0.9, LOW, lowOpts);

    // --- centro (auto-simétrico): pilar contestado + flancos bajos
    this._box(0, 0, 1.5, 1.5, 2.7, { ...highOpts, mirror: false, top: 0xffb075 });
    this._box(-4.8, 0.2, 0.9, 2.2, LOW, lowOpts); // el espejo crea (4.8,-0.2)

    // --- siluetas decorativas fuera del campo (sin colisión)
    for (const [x, z, w, h] of [[-22, -10, 5, 7], [24, 6, 6, 9], [-20, 14, 4, 5], [21, -16, 5, 6]]) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, 4),
        new THREE.MeshLambertMaterial({ color: 0x8794a0 })
      );
      m.position.set(x, h / 2 - 0.5, z);
      this.mapGroup.add(m);
    }
  }

  // Mapa "Arena": compacto (22×26), para el modo 4v4 vs bots — cadena corta
  // de coberturas al centro, pilares de flanco y carriles laterales rápidos.
  _buildArena() {
    const LOW = 1.05, HIGH = 2.4;
    const lowOpts = { color: 0x9c968c, top: 0xc6c1b5 };
    const highOpts = { color: 0x969188, top: 0xaba69d };
    const wallOpts = { mirror: false, color: 0x8a857d, top: 0x9a958c };

    // perímetro
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, 3.2, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, 3.2, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, 3.2, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, 3.2, wallOpts);

    // escudo de spawn con salidas laterales
    this._box(0, -10.6, 5, 0.9, 2.3, highOpts);
    // bajas flanqueando las salidas
    this._box(-4.4, -8.4, 2.2, 0.9, LOW, lowOpts);
    this._box(4.4, -8.4, 2.2, 0.9, LOW, lowOpts);
    // cadena escalonada hacia el centro
    this._box(-1.6, -5.6, 2.4, 0.9, LOW, lowOpts);
    this._box(2.4, -3.2, 2.4, 0.9, LOW, lowOpts);
    // pilar alto de flanco
    this._box(-6.6, -3.6, 1.1, 1.1, HIGH, highOpts);
    // cover del carril lateral
    this._box(9.2, -5.6, 0.9, 2.2, LOW, lowOpts);
    // centro: pilar contestado + baja lateral (el espejo crea el par)
    this._box(0, 0, 1.3, 1.3, 2.6, { ...highOpts, mirror: false, top: 0xffb075 });
    this._box(-4.6, 0.4, 0.9, 2.0, LOW, lowOpts);
  }

  // Mapa "District": multijugador, el doble de área que Foundry (42×50).
  // Variedad de obstáculos con simetría rotacional: bloques bajos (1.05),
  // muros medios (1.5), plataformas pisables (0.6), formas en L, pilares
  // y cuartos laterales con corredores CQC.
  _buildDistrict() {
    const LOW = 1.05, MID = 1.5, SLAB = 0.6, HIGH = 2.4;
    const lowOpts = { color: 0x9c968c, top: 0xc6c1b5 };
    const midOpts = { color: 0x928d84, top: 0xb5b0a5 };
    const slabOpts = { color: 0xa39e93, top: 0xcfcabf };
    const highOpts = { color: 0x969188, top: 0xaba69d };
    const wallOpts = { mirror: false, color: 0x8a857d, top: 0x9a958c };

    // perímetro
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, 3.2, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, 3.2, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, 3.2, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, 3.2, wallOpts);

    // --- base (lado rojo; el espejo crea el azul)
    this._box(0, -22.8, 8, 1, 2.3, highOpts);              // escudo de spawn
    this._box(-6, -20.2, 2.6, 0.9, LOW, lowOpts);          // salidas flanqueadas
    this._box(6, -20.2, 2.6, 0.9, LOW, lowOpts);
    this._box(-8.5, -16, 5, 1, MID, midOpts);              // muro medio de base
    this._box(5.5, -17, 3, 3, SLAB, slabOpts);             // plataforma pisable

    // --- cuartos laterales (corredores CQC)
    this._box(-14.5, -12, 1, 6.5, 2.6, highOpts);
    this._box(-17.5, -8.5, 1.8, 0.9, LOW, lowOpts);
    // forma en L
    this._box(11.5, -12.5, 1, 5, HIGH, highOpts);
    this._box(9.5, -10.5, 3, 1, HIGH, highOpts);

    // --- cadena central de bloques bajos (ruta de wallbounce)
    this._box(-2, -11, 2.6, 0.9, LOW, lowOpts);
    this._box(2.5, -8.5, 2.6, 0.9, LOW, lowOpts);
    this._box(-1.5, -6, 2.6, 0.9, LOW, lowOpts);

    // --- pilares de flanco
    this._box(7, -6, 1.2, 1.2, 2.5, highOpts);
    this._box(-11, -5, 1.2, 1.2, 2.5, highOpts);

    // --- carriles laterales
    this._box(-19, -3.5, 1.6, 0.9, LOW, lowOpts);
    this._box(18.5, -6, 0.9, 2.4, LOW, lowOpts);

    // --- media cancha: muro medio + losa pisable
    this._box(5, -2.5, 3.2, 0.9, MID, midOpts);
    this._box(-8.5, -1.5, 2.4, 2.4, SLAB, slabOpts);

    // --- centro (auto-simétrico): gran pilar + flancos bajos
    this._box(0, 0, 1.8, 1.8, 3, { ...highOpts, mirror: false, top: 0xffb075 });
    this._box(-5.5, 0.6, 0.9, 2.4, LOW, lowOpts);

    // --- siluetas decorativas
    for (const [x, z, w, h] of [[-28, -14, 6, 8], [30, 8, 7, 10], [-26, 18, 5, 6], [27, -20, 6, 7]]) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, 4),
        new THREE.MeshLambertMaterial({ color: 0x8794a0 })
      );
      m.position.set(x, h / 2 - 0.5, z);
      this.mapGroup.add(m);
    }
  }

  _buildSpawns() {
    const z = this.fz - 1.6;
    for (let i = 0; i < 4; i++) {
      const x = -3.6 + i * 2.4;
      // convención: facing = (-sin yaw, -cos yaw) → yaw π mira a +z, yaw 0 a -z
      this.spawns.red.push({ x, z: -z, yaw: Math.PI });   // miran hacia +z
      this.spawns.blue.push({ x: -x, z, yaw: 0 });        // miran hacia -z
    }
  }

  // ---------- física ----------

  // Raycast 3D contra los AABBs. Devuelve t (distancia) o null. inflate expande cajas.
  raycast(origin, dir, maxDist, inflate = 0) {
    let best = null;
    for (const c of this.colliders) {
      const minx = c.minx - inflate, maxx = c.maxx + inflate;
      const minz = c.minz - inflate, maxz = c.maxz + inflate;
      const miny = -0.1, maxy = c.h + inflate;
      let tmin = 0, tmax = maxDist;
      let ok = true;
      const axes = [
        [origin.x, dir.x, minx, maxx],
        [origin.y, dir.y, miny, maxy],
        [origin.z, dir.z, minz, maxz],
      ];
      for (const [o, d, lo, hi] of axes) {
        if (Math.abs(d) < 1e-8) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let t1 = (lo - o) / d, t2 = (hi - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) { ok = false; break; }
      }
      if (ok && tmin < maxDist && (best === null || tmin < best)) best = tmin;
    }
    return best;
  }

  // Altura del "suelo" bajo el círculo: la caja más alta que quede a la
  // altura de los pies o debajo (permite pararse sobre coberturas).
  groundHeight(p, r, y) {
    let g = 0;
    const m = r * 0.5;
    for (const c of this.colliders) {
      if (c.h > y + 0.25) continue; // demasiado alta para apoyarse
      if (p.x + m < c.minx || p.x - m > c.maxx || p.z + m < c.minz || p.z - m > c.maxz) continue;
      if (c.h > g) g = c.h;
    }
    return g;
  }

  // Empuja un círculo (x,z,r) fuera de los AABBs. Muta p.
  // y: altura de los pies — las cajas por debajo no bloquean (se salta encima).
  resolveCircle(p, r, y = 0) {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.colliders) {
        if (y >= c.h - 0.05) continue;
        const cx = Math.max(c.minx, Math.min(c.maxx, p.x));
        const cz = Math.max(c.minz, Math.min(c.maxz, p.z));
        let dx = p.x - cx, dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          p.x = cx + (dx / d) * r; p.z = cz + (dz / d) * r;
        } else {
          // centro dentro de la caja: salir por el eje de menor penetración
          const pl = p.x - c.minx, pr = c.maxx - p.x;
          const pt = p.z - c.minz, pb = c.maxz - p.z;
          const m = Math.min(pl, pr, pt, pb);
          if (m === pl) p.x = c.minx - r; else if (m === pr) p.x = c.maxx + r;
          else if (m === pt) p.z = c.minz - r; else p.z = c.maxz + r;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  // Busca la mejor cara de cobertura en la dirección dada.
  // pos {x,z}, dir {x,z} normalizado. Devuelve {face, target:{x,z}, dist, t} o null.
  findCover(pos, dir, range, playerR, minDot = 0.45) {
    let best = null;
    for (const f of this.faces) {
      const n = f.n;
      const rel = { x: pos.x - f.a.x, z: pos.z - f.a.z };
      const side = rel.x * n.x + rel.z * n.z;   // distancia con signo a la cara
      if (side < playerR * 0.5) continue;        // del lado equivocado
      const into = -(dir.x * n.x + dir.z * n.z); // cuánto apunta el input hacia el cover
      if (into < minDot) continue;
      const tRay = side / into;
      if (tRay > range) continue;
      // punto de entrada sobre la cara
      const hx = pos.x + dir.x * tRay, hz = pos.z + dir.z * tRay;
      const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z;
      const len = Math.hypot(tx, tz);
      const u = ((hx - f.a.x) * tx + (hz - f.a.z) * tz) / (len * len);
      if (u < -0.05 || u > 1.05) continue;
      const cu = Math.max(playerR / len, Math.min(1 - playerR / len, u));
      const target = {
        x: f.a.x + tx * cu + n.x * playerR,
        z: f.a.z + tz * cu + n.z * playerR,
      };
      // línea de visión libre hasta la entrada (evita engancharse a través de otra caja)
      const o = new THREE.Vector3(pos.x, 0.6, pos.z);
      const d3 = new THREE.Vector3(target.x - pos.x, 0, target.z - pos.z);
      const dl = d3.length();
      if (dl > 0.01) {
        d3.normalize();
        const hit = this.raycast(o, d3, dl - playerR - 0.05);
        if (hit !== null) continue;
      }
      if (best === null || tRay < best.t) best = { face: f, target, dist: dl, t: tRay };
    }
    return best;
  }
}
