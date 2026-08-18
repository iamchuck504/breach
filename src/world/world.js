// Mapa competitivo "Foundry": simétrico por rotación de 180°, diseñado para
// wallbounce (bloques bajos escalonados a 2.5-4m), corredores CQC laterales,
// centro abierto de riesgo con pilar contestado, y bases rojo/azul en ±Z.
// También es el dueño de la física estática: AABBs, raycast, resolución de círculo
// y las caras de cobertura que consume el sistema de cover.
import * as THREE from 'three';

const FIELD_X = 15, FIELD_Z = 18; // semiancho / semilargo

// REGLA DE DISEÑO (Chuck): solo existen TRES alturas de bloque/pared.
//   LOW  (1.1): saltable por encima; agachado, la cabeza NO sobresale (tope 1.02)
//   MID  (1.9): cubre al personaje DE PIE completo (cabeza ~1.63); no saltable
//   HIGH (3.0): inalcanzable incluso saltando; muros y estructuras
// Ninguna pieza de mapa puede usar otra altura.
export const BLOCK = { LOW: 1.1, MID: 1.9, HIGH: 3.0 };

export class World {
  constructor(scene, layout = 'foundry') {
    this.scene = scene;
    this._initTextures();
    this._buildLights();
    this.mapGroup = null;
    this.layout = null;
    this.setLayout(layout);
  }

  // Cambia de mapa en caliente: 'foundry' | 'arena' (compacto) | 'fortaleza'
  setLayout(layout) {
    if (this.layout === layout && this.mapGroup) return;
    this.layout = layout;
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.mapGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
            // las texturas del caché se comparten entre mapas: no tocarlas
            if (m.map && !m.map.userData.cached) m.map.dispose();
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
    // fz de fortaleza 26.6: bolsillo de spawn de 3.2m (spawns fijos en ±23.4)
    // — la cámara (dist 2.7) ya no choca con la muralla y no hace zoom forzado
    const dims = { arena: [11, 13], fortaleza: [21, 26.6], foundry: [FIELD_X, FIELD_Z] };
    [this.fx, this.fz] = dims[layout] ?? dims.foundry;

    this._buildFloor();
    if (layout === 'arena') this._buildArena();
    else if (layout === 'fortaleza') this._buildFortaleza();
    else this._buildMap();
    this._buildSpawns();

    // el frustum de sombras debe cubrir el mapa ACTUAL (con ±30 fijos, las
    // esquinas de Fortaleza quedaban sin sombra)
    if (this.sun) {
      const r = Math.max(this.fx, this.fz) + 6;
      const sc = this.sun.shadow.camera;
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.updateProjectionMatrix();
    }
  }

  // ---------- texturas procedurales (canvas nítido — cero blur/filtros) ----------
  _initTextures() {
    this._cv = {
      stone: this._stoneCanvas(4, 3, false),   // sillares de muro
      stoneTop: this._stoneCanvas(3, 3, true), // losas planas para los topes
      floor: this._floorCanvas(),
      banner: this._bannerCanvas(),
      ivy: this._ivyCanvas(),                  // hiedra colgante (alphaTest)
      grass: this._grassCanvas(),              // mata de pasto (alphaTest)
    };
    this._texCache = new Map(); // compartidas por (canvas, repeat): pocas subidas a GPU
  }

  // Sillares: piedras claras (el color del material tiñe) con mortero oscuro,
  // borde superior iluminado y sombra inferior — relieve sin blur.
  _stoneCanvas(rows, cols, flat) {
    const s = 256, j = 3; // 256px: nítida incluso pegado a la pared
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#6e675c'; g.fillRect(0, 0, s, s); // mortero
    const rh = s / rows, cw = s / cols;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * cw * 0.5;
      for (let c = -1; c < cols; c++) {
        const x = c * cw + off, y = r * rh;
        const hue = 38 + Math.random() * 8;
        const lum = 76 + Math.random() * 12;
        g.fillStyle = `hsl(${hue}, ${flat ? 9 : 13}%, ${lum}%)`;
        g.fillRect(x + j, y + j, cw - j * 2, rh - j * 2);
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(x + j, y + j, cw - j * 2, 3);
        g.fillStyle = 'rgba(38,32,24,0.30)';
        g.fillRect(x + j, y + rh - j - 3, cw - j * 2, 3);
        // picadura ocasional de la piedra
        if (Math.random() < 0.5) {
          g.fillStyle = 'rgba(60,52,40,0.18)';
          g.fillRect(x + 12 + Math.random() * (cw - 32), y + 12 + Math.random() * (rh - 28), 7, 5);
        }
      }
    }
    return cv;
  }

  // Losas del patio: piedra arenisca cálida con juntas oscuras y grietas finas.
  _floorCanvas() {
    const s = 256, n = 4, cell = s / n;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#6d6558'; g.fillRect(0, 0, s, s);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = c * cell, y = r * cell;
        g.fillStyle = `hsl(${40 + Math.random() * 8}, ${10 + Math.random() * 6}%, ${70 + Math.random() * 10}%)`;
        g.fillRect(x + 2, y + 2, cell - 4, cell - 4);
        g.fillStyle = 'rgba(255,255,255,0.14)';
        g.fillRect(x + 2, y + 2, cell - 4, 2);
        g.fillStyle = 'rgba(40,34,26,0.22)';
        g.fillRect(x + 2, y + cell - 4, cell - 4, 2);
        if (Math.random() < 0.4) { // grieta
          g.strokeStyle = 'rgba(52,45,36,0.35)'; g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x + 8 + Math.random() * 20, y + 6);
          g.lineTo(x + 14 + Math.random() * 30, y + cell - 8);
          g.stroke();
        }
      }
    }
    return cv;
  }

  // Estandarte vertical: campo claro (el material lo tiñe del color del
  // equipo) con borde, torre almenada y punta en V.
  _bannerCanvas() {
    const w = 64, h = 128;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#e8e2d4';
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, h - 18);
    g.lineTo(w / 2, h); g.lineTo(0, h - 18); g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(30,26,20,0.55)'; g.lineWidth = 4; g.stroke();
    // torre almenada (emblema oscuro)
    g.fillStyle = 'rgba(34,30,24,0.82)';
    g.fillRect(22, 38, 20, 46);
    for (const mx of [18, 28, 38]) g.fillRect(mx, 30, 8, 10);
    g.fillStyle = '#e8e2d4'; g.fillRect(29, 62, 6, 22); // puerta (hueco claro)
    // franjas superiores
    g.fillStyle = 'rgba(34,30,24,0.6)';
    g.fillRect(6, 10, w - 12, 5);
    return cv;
  }

  // Hiedra: guías que cuelgan desde arriba con hojas en rombos nítidos.
  _ivyCanvas() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, s, s);
    for (let v = 0; v < 9; v++) {
      let x = 12 + v * 28 + Math.random() * 10;
      const len = s * (0.45 + Math.random() * 0.5);
      g.strokeStyle = '#3c5a2e'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x, 0);
      let y = 0;
      while (y < len) {
        y += 14 + Math.random() * 10;
        x += (Math.random() - 0.5) * 12;
        g.lineTo(x, y);
      }
      g.stroke();
      // hojas a lo largo de la guía (rombos de dos verdes)
      for (let ly = 8; ly < len; ly += 12 + Math.random() * 8) {
        const lx = x + (Math.random() - 0.5) * 22;
        const r = 5 + Math.random() * 4;
        g.fillStyle = Math.random() < 0.5 ? '#4e7038' : '#5d8243';
        g.beginPath();
        g.moveTo(lx, ly - r); g.lineTo(lx + r, ly); g.lineTo(lx, ly + r); g.lineTo(lx - r, ly);
        g.closePath(); g.fill();
      }
    }
    return cv;
  }

  // Mata de pasto: abanico de hojas en tres verdes.
  _grassCanvas() {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, s, s);
    for (let i = 0; i < 12; i++) {
      const bx = 12 + Math.random() * 40;
      const tip = bx + (bx - 32) * (0.6 + Math.random() * 0.8);
      const h = 20 + Math.random() * 36;
      g.fillStyle = ['#5d8243', '#4e7038', '#719350'][i % 3];
      g.beginPath();
      g.moveTo(bx - 3, s); g.lineTo(tip, s - h); g.lineTo(bx + 3, s);
      g.closePath(); g.fill();
    }
    return cv;
  }

  _tex(id, rx = 1, ry = 1) {
    const key = id + ':' + rx.toFixed(2) + ':' + ry.toFixed(2);
    let t = this._texCache.get(key);
    if (!t) {
      t = new THREE.CanvasTexture(this._cv[id]);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.colorSpace = THREE.SRGBColorSpace;
      t.userData.cached = true; // el dispose de setLayout la respeta
      this._texCache.set(key, t);
    }
    return t;
  }

  // Materiales por cara con textura de sillar escalada al tamaño real de la
  // caja (~1 tile por 1.7 m). El color del material tiñe la piedra.
  _mat(color, topColor, w = 2, d = 2, h = 2) {
    const S = 1.7;
    const mk = (id, rx, ry, tint) => new THREE.MeshLambertMaterial({
      color: tint,
      map: this._tex(id, Math.max(0.5, Math.round(rx / S * 2) / 2), Math.max(0.5, Math.round(ry / S * 2) / 2)),
    });
    const sx = mk('stone', d, h, color);            // caras ±x
    const sz = mk('stone', w, h, color);            // caras ±z
    const tp = mk('stoneTop', w, d, topColor ?? color);
    return [sx, sx, tp, tp, sz, sz];
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xd9e6f0, 0x97876e, 1.55);
    this.scene.add(hemi);
    const amb = new THREE.AmbientLight(0xfff4e2, 0.25);
    this.scene.add(amb);
    // sol de media tarde: cálido, sombras largas y nítidas
    const sun = new THREE.DirectionalLight(0xffe9c4, 2.3);
    sun.position.set(14, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
    sc.near = 2; sc.far = 80;
    sun.shadow.bias = -0.0004;
    this.sun = sun;
    this.scene.add(sun);
    // cielo: degradado vertical azul → horizonte dorado (canvas, no niebla:
    // nada de "blur" atmosférico, geometría nítida a toda distancia)
    const cv = document.createElement('canvas');
    cv.width = 2; cv.height = 256;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#6d9bc2');
    grad.addColorStop(0.55, '#a7c0d2');
    grad.addColorStop(1, '#e0cda9');
    g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
    const sky = new THREE.CanvasTexture(cv);
    sky.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = sky;
  }

  _buildFloor() {
    // patio de losas de arenisca (4 losas por tile → losa ≈ 0.65 m)
    const tex = this._tex('floor', this.fx * 2 / 2.6, this.fz * 2 / 2.6);
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
      // variación sutil de tono por caja: rompe la monotonía sin romper la paleta
      const jit = 0.95 + Math.random() * 0.1;
      const c = new THREE.Color(color).multiplyScalar(jit).getHex();
      const t = new THREE.Color(top).multiplyScalar(jit).getHex();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._mat(c, t, w, d, h));
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
    const { LOW, HIGH } = BLOCK;
    const lowOpts = { color: 0x9c968c, top: 0xc6c1b5 };
    const highOpts = { color: 0x969188, top: 0xaba69d };

    // --- muros perimetrales (no espejar, cover en cara interna solamente por geometría)
    const wallOpts = { mirror: false, color: 0x8a857d, top: 0x9a958c };
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // --- base (lado rojo; espejo crea el lado azul)
    // escudo de spawn con salidas a los lados
    this._box(0, -14.6, 7, 0.9, HIGH, highOpts);
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
    this._box(6.8, -4.2, 1.2, 1.2, HIGH, highOpts);
    this._box(-7.4, -6.0, 0.9, 2.6, LOW, lowOpts);

    // --- cover del carril lateral
    this._box(-13.0, -3.2, 1.6, 0.9, LOW, lowOpts);

    // --- cerca del centro
    this._box(4.2, -1.6, 3.0, 0.9, LOW, lowOpts);

    // --- centro (auto-simétrico): pilar contestado + flancos bajos
    this._box(0, 0, 1.5, 1.5, HIGH, { ...highOpts, mirror: false, top: 0xffb075 });
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
    const { LOW, HIGH } = BLOCK;
    const lowOpts = { color: 0x9c968c, top: 0xc6c1b5 };
    const highOpts = { color: 0x969188, top: 0xaba69d };
    const wallOpts = { mirror: false, color: 0x8a857d, top: 0x9a958c };

    // perímetro
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // escudo de spawn con salidas laterales
    this._box(0, -10.6, 5, 0.9, HIGH, highOpts);
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
    this._box(0, 0, 1.3, 1.3, HIGH, { ...highOpts, mirror: false, top: 0xffb075 });
    this._box(-4.6, 0.4, 0.9, 2.0, LOW, lowOpts);
  }

  // Mapa "Fortaleza": multijugador y VS bots, el doble de área que Foundry
  // (42×50). Patio amurallado de castillo: muralla perimetral almenada,
  // torreones en las esquinas, estandartes por equipo y braseros — misma
  // geometría jugable de siempre (simetría rotacional, LOW/MID/HIGH).
  _buildFortaleza() {
    const { LOW, MID, HIGH } = BLOCK;
    const lowOpts = { color: 0xa89f8f, top: 0xcdc5b2 };
    const midOpts = { color: 0x9e968a, top: 0xbfb8a9 };
    const highOpts = { color: 0xa19a8e, top: 0xb3aca0 };
    const wallOpts = { mirror: false, color: 0x968f83, top: 0xa59e92 };

    // perímetro
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // --- base (lado rojo; el espejo crea el azul)
    // escudo a 2m del spawn (en -22.8 quedaba a 0.6m: nacías mirando pared)
    this._box(0, -20.9, 8, 1, HIGH, highOpts);             // escudo de spawn
    this._box(-6, -20.2, 2.6, 0.9, LOW, lowOpts);          // salidas flanqueadas
    this._box(6, -20.2, 2.6, 0.9, LOW, lowOpts);
    this._box(-8.5, -16, 5, 1, MID, midOpts);              // muro mediano de base
    this._box(5.5, -17, 3, 3, LOW, lowOpts);               // plataforma saltable

    // --- cuartos laterales (corredores CQC)
    this._box(-14.5, -12, 1, 6.5, HIGH, highOpts);
    this._box(-17.5, -8.5, 1.8, 0.9, LOW, lowOpts);
    // forma en L
    this._box(11.5, -12.5, 1, 5, HIGH, highOpts);
    this._box(9.5, -10.5, 3, 1, HIGH, highOpts);

    // --- cadena central de bloques bajos (ruta de wallbounce)
    this._box(-2, -11, 2.6, 0.9, LOW, lowOpts);
    this._box(2.5, -8.5, 2.6, 0.9, LOW, lowOpts);
    this._box(-1.5, -6, 2.6, 0.9, LOW, lowOpts);

    // --- pilares de flanco
    this._box(7, -6, 1.2, 1.2, HIGH, highOpts);
    this._box(-11, -5, 1.2, 1.2, HIGH, highOpts);

    // --- carriles laterales
    this._box(-19, -3.5, 1.6, 0.9, LOW, lowOpts);
    this._box(18.5, -6, 0.9, 2.4, LOW, lowOpts);

    // --- media cancha: muro mediano + plataforma saltable
    this._box(5, -2.5, 3.2, 0.9, MID, midOpts);
    this._box(-8.5, -1.5, 2.4, 2.4, LOW, lowOpts);

    // --- centro (auto-simétrico): gran pilar + flancos bajos
    this._box(0, 0, 1.8, 1.8, HIGH, { ...highOpts, mirror: false, top: 0xffb075 });
    this._box(-5.5, 0.6, 0.9, 2.4, LOW, lowOpts);

    this._decorFortaleza();
  }

  // Ambiente de fortaleza: TODO decorativo (cero colisión, cero cambio de
  // gameplay) — almenas instanciadas, torreones de esquina, estandartes,
  // braseros y torreones lejanos de silueta.
  _decorFortaleza() {
    const { HIGH } = BLOCK;
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x9b9488, map: this._tex('stone', 1, 0.5) });
    const towerMat = new THREE.MeshLambertMaterial({ color: 0x9b9488, map: this._tex('stone', 8, 5) });

    // --- almenas: muralla perimetral + escudos de spawn + coronas de torreón
    const pts = [];
    const step = 1.7;
    for (let x = -this.fx + 0.4; x <= this.fx; x += step) {
      pts.push([x, -this.fz - 0.4, 0, HIGH]);
      pts.push([x, this.fz + 0.4, 0, HIGH]);
    }
    for (let z = -this.fz + 0.4; z <= this.fz; z += step) {
      pts.push([-this.fx - 0.4, z, Math.PI / 2, HIGH]);
      pts.push([this.fx + 0.4, z, Math.PI / 2, HIGH]);
    }
    for (let x = -3.2; x <= 3.3; x += 1.6) { // escudos de spawn (z ∓20.9)
      pts.push([x, -20.9, 0, HIGH]);
      pts.push([-x, 20.9, 0, HIGH]);
    }
    const towers = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
      .map(([sx, sz]) => [sx * (this.fx + 2.6), sz * (this.fz + 2.6)]);
    for (const [tx, tz] of towers) {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        pts.push([tx + Math.cos(a) * 2.0, tz + Math.sin(a) * 2.0, -a, 8.0]);
      }
    }
    const merlon = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.8, 0.55, 0.95), stoneMat, pts.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    pts.forEach(([x, z, ry, base], i) => {
      e.set(0, ry, 0); q.setFromEuler(e);
      m4.compose(v.set(x, base + 0.27, z), q, one);
      merlon.setMatrixAt(i, m4);
    });
    merlon.castShadow = true;
    this.mapGroup.add(merlon);

    // --- torreones de esquina (fuera del campo, tras la muralla)
    for (const [tx, tz] of towers) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.35, 8.5, 12), towerMat);
      t.position.set(tx, 3.75, tz);
      t.castShadow = true;
      this.mapGroup.add(t);
    }

    // --- estandartes de equipo colgados del escudo de spawn, mirando al campo
    for (const [team, color, z, ry] of [
      ['red', 0xd94f3f, -20.9 + 0.54, 0],
      ['blue', 0x4f8de0, 20.9 - 0.54, Math.PI],
    ]) {
      for (const x of [-2.4, 2.4]) {
        const b = new THREE.Mesh(
          new THREE.PlaneGeometry(1.1, 2.3),
          new THREE.MeshLambertMaterial({ color, map: this._tex('banner'), transparent: true })
        );
        b.position.set(team === 'red' ? x : -x, 1.75, z);
        b.rotation.y = ry;
        this.mapGroup.add(b);
      }
    }
    // estandartes neutros (acento) en el pilar central
    for (const ry of [0, Math.PI]) {
      const b = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 1.9),
        new THREE.MeshLambertMaterial({ color: 0xff8a3d, map: this._tex('banner'), transparent: true })
      );
      b.position.set(0, 1.85, (ry === 0 ? 1 : -1) * 0.93);
      b.rotation.y = ry === 0 ? 0 : Math.PI;
      this.mapGroup.add(b);
    }

    // --- braseros sobre los pilares de flanco (llama emisiva, sin luces extra)
    for (const [px, pz] of [[7, -6], [-7, 6], [-11, -5], [11, 5]]) {
      const bowl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.2, 0.22, 8),
        new THREE.MeshLambertMaterial({ color: 0x3a352e })
      );
      bowl.position.set(px, HIGH + 0.11, pz);
      this.mapGroup.add(bowl);
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.17, 0.5, 6),
        new THREE.MeshBasicMaterial({ color: 0xffa63d })
      );
      flame.position.set(px, HIGH + 0.45, pz);
      this.mapGroup.add(flame);
      const core = new THREE.Mesh(
        new THREE.ConeGeometry(0.08, 0.3, 6),
        new THREE.MeshBasicMaterial({ color: 0xffe291 })
      );
      core.position.set(px, HIGH + 0.42, pz);
      this.mapGroup.add(core);
    }

    // --- terreno exterior: campiña alrededor de la muralla (sin él, los
    // torreones lejanos flotaban contra el cielo)
    const land = new THREE.Mesh(
      new THREE.PlaneGeometry(320, 320),
      new THREE.MeshLambertMaterial({ color: 0x8b9166 })
    );
    land.rotation.x = -Math.PI / 2;
    land.position.y = -0.04;
    land.receiveShadow = true;
    this.mapGroup.add(land);

    // --- torreones lejanos (el "resto" del castillo), en piedra y con techo
    for (const [x, z, r, h] of [[-30, -16, 3.4, 11], [32, 9, 4, 13], [-28, 20, 3, 9], [29, -22, 3.6, 10]]) {
      const t = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.88, r, h, 10),
        new THREE.MeshLambertMaterial({ color: 0x958f88, map: this._tex('stone', 10, 6) })
      );
      t.position.set(x, h / 2 - 0.5, z);
      this.mapGroup.add(t);
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(r * 1.05, r * 1.3, 10),
        new THREE.MeshLambertMaterial({ color: 0x8a5f43 })
      );
      cap.position.set(x, h - 0.5 + r * 0.6, z);
      this.mapGroup.add(cap);
    }

    this._vegetation(towers);
    this._props(towers);
  }

  // Vegetación: hiedra en muros, matas de pasto entre las losas, arbustos
  // low-poly y árboles asomando tras la muralla. Todo decorativo.
  _vegetation(towers) {
    const ivyMat = new THREE.MeshLambertMaterial({
      map: this._tex('ivy'), alphaTest: 0.5, side: THREE.DoubleSide,
    });
    // [x, z, giroY, ancho, alto, yCentro] — caras que miran al campo
    const ivies = [
      [-20.95, -8, Math.PI / 2, 2.6, 2.6, 1.55],   // muralla oeste
      [20.95, 8, -Math.PI / 2, 2.6, 2.6, 1.55],
      [-14, -this.fz + 0.05, 0, 3.0, 2.7, 1.5],    // muralla norte/sur (cara interna)
      [14, this.fz - 0.05, Math.PI, 3.0, 2.7, 1.5],
      [-8.5, -15.47, 0, 2.2, 1.7, 0.95],           // muro mediano de base
      [8.5, 15.47, Math.PI, 2.2, 1.7, 0.95],
      [9.5, -9.97, 0, 2.2, 2.4, 1.6],              // forma en L
      [-9.5, 9.97, Math.PI, 2.2, 2.4, 1.6],
      [-0.93, 0, -Math.PI / 2, 1.6, 2.6, 1.5],     // pilar central, caras laterales
      [0.93, 0, Math.PI / 2, 1.6, 2.6, 1.5],
    ];
    for (const [x, z, ry, w, h, y] of ivies) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), ivyMat);
      p.position.set(x, y, z);
      p.rotation.y = ry;
      this.mapGroup.add(p);
    }

    // matas de pasto instanciadas (2 planos cruzados por mata)
    const spots = [];
    for (let i = 0; i < 90; i++) {
      // pegadas a la muralla interior o alrededor de bloques, no en los carriles
      const side = Math.floor(Math.random() * 4);
      const t = Math.random() * 2 - 1;
      let x, z;
      if (side === 0) { x = -this.fx + 0.55 + Math.random() * 0.9; z = t * (this.fz - 2); }
      else if (side === 1) { x = this.fx - 0.55 - Math.random() * 0.9; z = t * (this.fz - 2); }
      else if (side === 2) { z = -this.fz + 0.55 + Math.random() * 0.9; x = t * (this.fx - 2); }
      else { z = this.fz - 0.55 - Math.random() * 0.9; x = t * (this.fx - 2); }
      spots.push([x, z, Math.random() * Math.PI, 0.75 + Math.random() * 0.7]);
    }
    const grassMat = new THREE.MeshLambertMaterial({
      map: this._tex('grass'), alphaTest: 0.5, side: THREE.DoubleSide,
    });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const v = new THREE.Vector3(), sc = new THREE.Vector3();
    for (const rot of [0, Math.PI / 2]) {
      const g = new THREE.PlaneGeometry(0.55, 0.4);
      g.translate(0, 0.2, 0);
      g.rotateY(rot);
      const im = new THREE.InstancedMesh(g, grassMat, spots.length);
      spots.forEach(([x, z, ry, s], i) => {
        e.set(0, ry, 0); q.setFromEuler(e);
        m4.compose(v.set(x, 0, z), q, sc.set(s, s, s));
        im.setMatrixAt(i, m4);
      });
      this.mapGroup.add(im);
    }

    // arbustos low-poly (icosaedros achatados, dos verdes)
    const bushGeo = new THREE.IcosahedronGeometry(0.45, 0);
    const bushMats = [
      new THREE.MeshLambertMaterial({ color: 0x5d7a44 }),
      new THREE.MeshLambertMaterial({ color: 0x6c8a4d }),
    ];
    const bushes = [
      [-20.2, -22, 1.1], [20.2, 22, 1.1], [-19.8, 3.4, 0.9], [19.8, -3.4, 0.9],
      [-12.9, -25.9, 0.8], [12.9, 25.9, 0.8], [6.3, -25.9, 1.0], [-6.3, 25.9, 1.0],
      [18.2, -10.6, 0.75], [-18.2, 10.6, 0.75], [-15.2, -15.8, 0.85], [15.2, 15.8, 0.85],
    ];
    for (const [x, z, s] of bushes) {
      const b = new THREE.Mesh(bushGeo, bushMats[(x * 7 + z * 13 & 1) === 0 ? 0 : 1]);
      b.position.set(x, 0.3 * s, z);
      b.scale.set(s, s * 0.72, s);
      b.rotation.y = x + z;
      b.castShadow = true;
      this.mapGroup.add(b);
    }

    // árboles tras la muralla (copas visibles desde el patio) + cipreses
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6e5138 });
    const leafMats = [
      new THREE.MeshLambertMaterial({ color: 0x557a3e }),
      new THREE.MeshLambertMaterial({ color: 0x648a47 }),
    ];
    const trees = [
      [-26.5, -6, 1.3], [26.5, 6, 1.3], [-25.5, 10, 1.0], [25.5, -10, 1.0],
      [-11, -30.5, 1.15], [11, 30.5, 1.15], [19, -31, 0.9], [-19, 31, 0.9],
    ];
    for (const [x, z, s] of trees) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * s, 0.3 * s, 2.4 * s, 6), trunkMat);
      trunk.position.set(x, 1.2 * s, z);
      this.mapGroup.add(trunk);
      for (const [ox, oy, oz, r] of [[0, 3.1, 0, 1.35], [0.9, 2.5, 0.3, 0.95], [-0.8, 2.6, -0.4, 0.85]]) {
        const c = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 0), leafMats[(ox > 0 ? 1 : 0)]);
        c.position.set(x + ox * s, oy * s, z + oz * s);
        c.castShadow = true;
        this.mapGroup.add(c);
      }
    }
    // cipreses junto a los torreones lejanos
    for (const [x, z, s] of [[-33, -12, 1], [29, 13, 1.15], [-25, 23, 0.85], [26, -25.5, 1]]) {
      const cy = new THREE.Mesh(new THREE.ConeGeometry(0.85 * s, 4.6 * s, 7), leafMats[0]);
      cy.position.set(x, 2.3 * s - 0.4, z);
      this.mapGroup.add(cy);
    }
  }

  // Props: barriles de madera junto a los muros y banderines en los torreones.
  _props(towers) {
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a6a48 });
    const woodTopMat = new THREE.MeshLambertMaterial({ color: 0x6e5138 });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0x4a4038 });
    const barrels = [
      [-19.9, -18.5, 0], [19.9, 18.5, 0], [-19.5, -17.6, 0], [19.5, 17.6, 0],
      [10.3, -25.9, 0], [-10.3, 25.9, 0], [10.3, -25.9, 0.78], [-10.3, 25.9, 0.78],
      [-20.6, -6.2, 0], [20.6, 6.2, 0],
    ];
    for (const [x, z, y] of barrels) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.78, 9), woodMat);
      b.position.set(x, y + 0.39, z);
      b.castShadow = true;
      this.mapGroup.add(b);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 9), woodTopMat);
      lid.position.set(x, y + 0.8, z);
      this.mapGroup.add(lid);
      for (const by of [0.2, 0.6]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.05, 9), bandMat);
        ring.position.set(x, y + by, z);
        this.mapGroup.add(ring);
      }
    }

    // banderines triangulares: torreones (color del lado) + pilar central
    const flagGeo = new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.85, 0.22), new THREE.Vector2(0, 0.44),
    ]));
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4038 });
    const spots = towers.map(([tx, tz]) => [tx, 8.0, tz, tz < 0 ? 0xd94f3f : 0x4f8de0]);
    spots.push([0, BLOCK.HIGH, 0, 0xff8a3d]); // pilar central, acento
    for (const [x, base, z, color] of spots) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.7, 5), poleMat);
      pole.position.set(x, base + 0.85, z);
      this.mapGroup.add(pole);
      const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      flag.position.set(x, base + 1.18, z);
      flag.rotation.y = (x + z) * 0.7; // orientaciones variadas
      this.mapGroup.add(flag);
    }
  }

  _buildSpawns() {
    // fortaleza: spawns FIJOS en ±23.4 (el server los espeja) con la muralla
    // más atrás; otros mapas, pegados al muro como siempre
    const z = this.layout === 'fortaleza' ? 23.4 : this.fz - 1.6;
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
