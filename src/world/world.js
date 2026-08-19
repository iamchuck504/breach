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
const HELIPAD_RADIUS = 6.2;
const HELIPAD = {
  height: BLOCK.LOW,
  radius: HELIPAD_RADIUS,
  edge: HELIPAD_RADIUS * Math.cos(Math.PI / 8),
  diagonal: HELIPAD_RADIUS * (Math.cos(Math.PI / 8) + Math.sin(Math.PI / 8)),
  rampLength: 5,
  rampHalfWidth: 1.55,
};
const HIT_N = {
  nx: { x: -1, y: 0, z: 0 }, px: { x: 1, y: 0, z: 0 },
  ny: { x: 0, y: -1, z: 0 }, py: { x: 0, y: 1, z: 0 },
  nz: { x: 0, y: 0, z: -1 }, pz: { x: 0, y: 0, z: 1 },
};

export class World {
  constructor(scene, layout = 'foundry') {
    this.scene = scene;
    this._initTextures();
    this._buildLights();
    this.mapGroup = null;
    this.layout = null;
    this.setLayout(layout);
  }

  // Cambia de mapa en caliente:
  // 'foundry' | 'arena' (compacto) | 'fortaleza' (día) | 'azoteas' (noche)
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
    this.segmentColliders = []; // muros rotados delgados {a,b,n,half,h}
    this.faces = [];     // caras de cobertura {n:{x,z}, a:{x,z}, b:{x,z}, h}
    this.surfaceZones = []; // superficies transitables que elevan el suelo sin actuar como cover
    this.spawns = { red: [], blue: [] };
    // La geometría jugable se acumula en CPU y se sube como solo DOS meshes:
    // uno para los lados y otro para las tapas. Antes, cada BoxGeometry tenía
    // seis grupos/materiales y Fortaleza gastaba cientos de draw calls.
    this._boxBatch = { sides: this._newBatch(), tops: this._newBatch() };
    // fz de fortaleza 26.6: bolsillo de spawn de 3.2m (spawns fijos en ±23.4)
    // — la cámara (dist 2.7) ya no choca con la muralla y no hace zoom forzado
    // azoteas ×1.5 (pedido de Chuck): 63×80 — spawns propios en ±35.1
    const dims = { arena: [11, 13], fortaleza: [21, 26.6], azoteas: [31.5, 40], foundry: [FIELD_X, FIELD_Z] };
    [this.fx, this.fz] = dims[layout] ?? dims.foundry;
    // texturas del batch por mapa (piedra medieval vs concreto urbano)
    this._batchTexIds = layout === 'azoteas' ? ['concrete', 'concreteTop'] : ['stone', 'stoneTop'];
    // cajas de munición por mapa: en azoteas van sobre el eje del helipuerto,
    // libres de cover (las ±7,0 por defecto chocaban con el anillo)
    this.cratePos = layout === 'azoteas' ? [{ x: 0, z: -12.1 }, { x: 0, z: 12.1 }] : null;

    this._buildFloor();
    if (layout === 'arena') this._buildArena();
    else if (layout === 'fortaleza') this._buildFortaleza();
    else if (layout === 'azoteas') this._buildAzoteas();
    else this._buildMap();
    this._flushBoxBatch();
    this._buildSpawns();

    // el frustum de sombras debe cubrir el mapa ACTUAL (con ±30 fijos, las
    // esquinas de Fortaleza quedaban sin sombra)
    if (this.sun) {
      const r = Math.max(this.fx, this.fz) + 6;
      const sc = this.sun.shadow.camera;
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.updateProjectionMatrix();
    }
    this._applyEnvironment(layout);
  }

  // ---------- texturas procedurales (canvas nítido — cero blur/filtros) ----------
  _initTextures() {
    this._cv = {
      stone: this._stoneCanvas(4, 3, false),   // sillares de muro
      stoneTop: this._stoneCanvas(3, 3, true), // losas planas para los topes
      floor: this._floorCanvas(),
      banner: this._bannerCanvas(),
      gate: this._gateCanvas(),                 // portón de madera/hierro
      crack: this._crackCanvas(),               // daño mural (alphaTest)
      ivy: this._ivyCanvas(),                  // hiedra colgante (alphaTest)
      grass: this._grassCanvas(),              // mata de pasto (alphaTest)
      concrete: this._concreteCanvas(false),   // paneles de concreto (Azoteas)
      concreteTop: this._concreteCanvas(true),
      roofFloor: this._roofFloorCanvas(),      // grava/brea de azotea
      windows: this._windowsCanvas(),          // fachadas nocturnas iluminadas
      roofMark: this._roofMarkCanvas(),        // marca técnica del centro
      hazard: this._hazardCanvas(),            // franjas de seguridad
      billboard: this._billboardCanvas(),      // anuncio del skyline
      glow: this._glowCanvas(),                // halos sin luces dinámicas
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
    // Junta menos oscura: el grid sigue guiando distancias, pero ya no domina
    // toda la imagen por encima de personajes y coberturas.
    g.fillStyle = '#7a7367'; g.fillRect(0, 0, s, s);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = c * cell, y = r * cell;
        g.fillStyle = `hsl(${40 + Math.random() * 8}, ${10 + Math.random() * 6}%, ${70 + Math.random() * 10}%)`;
        g.fillRect(x + 2, y + 2, cell - 4, cell - 4);
        g.fillStyle = 'rgba(255,255,255,0.14)';
        g.fillRect(x + 2, y + 2, cell - 4, 2);
        g.fillStyle = 'rgba(40,34,26,0.15)';
        g.fillRect(x + 2, y + cell - 4, cell - 4, 2);
        if (Math.random() < 0.4) { // grieta
          g.strokeStyle = 'rgba(52,45,36,0.25)'; g.lineWidth = 1;
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

  _gateCanvas() {
    const w = 256, h = 192;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#65452f'); grd.addColorStop(1, '#35271f');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    // tablones y veta gruesa: legibles desde media cancha
    for (let x = 0; x <= w; x += 32) {
      g.fillStyle = 'rgba(25,18,14,.58)'; g.fillRect(x, 0, 4, h);
      g.fillStyle = 'rgba(255,220,165,.10)'; g.fillRect(x + 4, 0, 2, h);
    }
    for (let y = 18; y < h; y += 44) {
      g.strokeStyle = 'rgba(28,19,14,.28)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(8, y); g.bezierCurveTo(70, y - 8, 170, y + 9, 248, y - 3); g.stroke();
    }
    // bandas y remaches de hierro
    g.fillStyle = '#25272a';
    g.fillRect(0, 24, w, 12); g.fillRect(0, h - 38, w, 12);
    g.fillRect(w / 2 - 7, 0, 14, h);
    for (let x = 16; x < w; x += 28) {
      for (const y of [30, h - 32]) {
        g.fillStyle = '#77746c'; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
      }
    }
    return cv;
  }

  _crackCanvas() {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, s, s);
    g.strokeStyle = 'rgba(35,30,25,.82)';
    g.lineCap = 'round';
    const branch = (x, y, len, a, width, depth) => {
      const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
      g.lineWidth = width; g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.stroke();
      if (depth <= 0) return;
      branch(ex, ey, len * 0.62, a - 0.45, width * 0.68, depth - 1);
      branch(ex, ey, len * 0.52, a + 0.52, width * 0.62, depth - 1);
    };
    branch(63, 18, 28, 1.45, 4, 2);
    branch(65, 47, 22, 2.25, 2.5, 1);
    g.fillStyle = 'rgba(45,38,30,.38)';
    for (let i = 0; i < 12; i++) g.fillRect(36 + Math.random() * 56, 86 + Math.random() * 25, 4, 3);
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

  // Paneles de concreto: juntas de encofrado, manchas y chorreados sutiles.
  _concreteCanvas(flat) {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#b9b6ae'; g.fillRect(0, 0, s, s);
    // juntas de panel
    g.strokeStyle = 'rgba(60,56,48,0.4)'; g.lineWidth = 3;
    for (const x of [0, s / 2, s]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
    for (const y of [0, s / (flat ? 2 : 3) * 1, s / (flat ? 2 : 3) * 2, s]) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
    }
    // manchas y chorreados
    for (let i = 0; i < 10; i++) {
      g.fillStyle = `rgba(70,66,58,${0.05 + Math.random() * 0.08})`;
      g.fillRect(Math.random() * s, Math.random() * s, 14 + Math.random() * 40, 8 + Math.random() * 26);
    }
    for (let i = 0; i < 6; i++) {
      const x = Math.random() * s;
      g.fillStyle = 'rgba(60,56,48,0.14)';
      g.fillRect(x, Math.random() * s * 0.4, 2, 30 + Math.random() * 60);
    }
    // pernos de encofrado
    g.fillStyle = 'rgba(50,46,40,0.5)';
    for (const x of [s * 0.25, s * 0.75]) for (const y of [s * 0.2, s * 0.55, s * 0.9]) g.fillRect(x - 2, y - 2, 5, 5);
    return cv;
  }

  // Azotea: grava fina con juntas de brea y parches.
  _roofFloorCanvas() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#8f8d88'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) { // grava
      const l = 45 + Math.random() * 35;
      g.fillStyle = `hsl(40, 4%, ${l}%)`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = 'rgba(30,28,26,0.5)'; g.lineWidth = 4; // juntas de brea
    for (const t of [0, s / 2, s]) {
      g.beginPath(); g.moveTo(t, 0); g.lineTo(t, s); g.stroke();
      g.beginPath(); g.moveTo(0, t); g.lineTo(s, t); g.stroke();
    }
    g.fillStyle = 'rgba(70,68,64,0.5)'; // parche reparado
    g.fillRect(s * 0.6, s * 0.15, 60, 44);
    return cv;
  }

  // Fachada nocturna: retícula de ventanas, unas encendidas (cálidas/frías).
  _windowsCanvas() {
    const w = 128, h = 256;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#0c0e15'; g.fillRect(0, 0, w, h);
    const cols = 5, rows = 11, cw = w / cols, rh = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = Math.random();
        g.fillStyle = lit < 0.22 ? '#ffd9a0' : lit < 0.32 ? '#a8c8ff' : '#171a24';
        g.fillRect(c * cw + 4, r * rh + 5, cw - 8, rh - 9);
      }
    }
    return cv;
  }

  // Marca de mantenimiento: aro incompleto, H y coordenadas de sector.
  _roofMarkCanvas() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, s, s);
    g.strokeStyle = 'rgba(92,196,224,.58)';
    g.lineWidth = 8;
    g.setLineDash([38, 15]);
    g.beginPath(); g.arc(s / 2, s / 2, 91, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = 'rgba(160,222,238,.46)';
    g.lineWidth = 11;
    g.beginPath();
    g.moveTo(91, 82); g.lineTo(91, 174);
    g.moveTo(165, 82); g.lineTo(165, 174);
    g.moveTo(91, 128); g.lineTo(165, 128);
    g.stroke();
    g.fillStyle = 'rgba(169,222,234,.62)';
    g.font = 'bold 14px monospace';
    g.textAlign = 'center';
    g.fillText('SECTOR 09', 128, 226);
    return cv;
  }

  _hazardCanvas() {
    const w = 256, h = 64;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#d79a32'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#262a31';
    for (let x = -64; x < w + 64; x += 64) {
      g.beginPath();
      g.moveTo(x, h); g.lineTo(x + 28, h); g.lineTo(x + 64, 0); g.lineTo(x + 36, 0);
      g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(0, 0, w, 3);
    return cv;
  }

  _billboardCanvas() {
    const w = 512, h = 192;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#091018'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#4fc7df'; g.lineWidth = 10; g.strokeRect(7, 7, w - 14, h - 14);
    g.fillStyle = '#eb9f45'; g.fillRect(32, 32, 14, h - 64);
    g.fillStyle = '#d9edf2'; g.font = 'bold 64px monospace';
    g.textAlign = 'left'; g.fillText('NOVA', 72, 92);
    g.fillStyle = '#58c8df'; g.font = 'bold 25px monospace';
    g.fillText('SECTOR 09 // EN LÍNEA', 74, 142);
    return cv;
  }

  _glowCanvas() {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,.95)');
    grad.addColorStop(0.18, 'rgba(255,255,255,.48)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
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

  _newBatch() {
    return { pos: [], norm: [], uv: [], color: [], idx: [], count: 0 };
  }

  // Agrega un quad al batch. Los UV pueden exceder 1: la textura usa RepeatWrapping.
  _batchQuad(batch, verts, normal, uv, color) {
    const base = batch.count;
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Color(Array.isArray(color) ? color[i] : color);
      batch.pos.push(...verts[i]);
      batch.norm.push(...normal);
      batch.uv.push(...uv[i]);
      batch.color.push(c.r, c.g, c.b);
    }
    batch.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    batch.count += 4;
  }

  _batchBox(x, z, w, d, h, sideColor, topColor) {
    const x0 = x - w / 2, x1 = x + w / 2;
    const z0 = z - d / 2, z1 = z + d / 2;
    const S = 1.7;
    const uw = w / S, ud = d / S, vh = h / S;
    const b = this._boxBatch;
    // AO falso gratis: zócalo oscuro y borde superior claro dentro del mismo
    // atributo de color; no agrega geometría, materiales ni draw calls.
    const bottom = new THREE.Color(sideColor).multiplyScalar(0.74).getHex();
    const upper = new THREE.Color(sideColor).multiplyScalar(1.07).getHex();
    const sideGradient = [bottom, upper, upper, bottom];

    this._batchQuad(b.sides,
      [[x1, 0, z0], [x1, h, z0], [x1, h, z1], [x1, 0, z1]],
      [1, 0, 0], [[0, 0], [0, vh], [ud, vh], [ud, 0]], sideGradient);
    this._batchQuad(b.sides,
      [[x0, 0, z1], [x0, h, z1], [x0, h, z0], [x0, 0, z0]],
      [-1, 0, 0], [[0, 0], [0, vh], [ud, vh], [ud, 0]], sideGradient);
    this._batchQuad(b.sides,
      [[x1, 0, z1], [x1, h, z1], [x0, h, z1], [x0, 0, z1]],
      [0, 0, 1], [[0, 0], [0, vh], [uw, vh], [uw, 0]], sideGradient);
    this._batchQuad(b.sides,
      [[x0, 0, z0], [x0, h, z0], [x1, h, z0], [x1, 0, z0]],
      [0, 0, -1], [[0, 0], [0, vh], [uw, vh], [uw, 0]], sideGradient);
    this._batchQuad(b.tops,
      [[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]],
      [0, 1, 0], [[0, 0], [0, ud], [uw, ud], [uw, 0]], topColor);
  }

  _flushBoxBatch() {
    const build = (batch, texture) => {
      if (!batch.count) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(batch.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(batch.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(batch.color, 3));
      g.setIndex(batch.idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        map: this._tex(texture), vertexColors: true,
      }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.mapGroup.add(mesh);
    };
    build(this._boxBatch.sides, this._batchTexIds[0]);
    build(this._boxBatch.tops, this._batchTexIds[1]);
    this._boxBatch = null;
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xd9e6f0, 0x97876e, 1.55);
    this.hemi = hemi;
    this.scene.add(hemi);
    const amb = new THREE.AmbientLight(0xfff4e2, 0.25);
    this.amb = amb;
    this.scene.add(amb);
    // sol de media tarde: cálido, sombras largas y nítidas
    const sun = new THREE.DirectionalLight(0xffe9c4, 2.3);
    sun.position.set(14, 22, 8);
    sun.castShadow = true;
    const coarseDisplay = matchMedia('(pointer: coarse)').matches;
    sun.shadow.mapSize.set(coarseDisplay ? 1024 : 2048, coarseDisplay ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30;
    sc.near = 2; sc.far = 80;
    sun.shadow.bias = -0.0004;
    this.sun = sun;
    this.scene.add(sun);

    this._setSky([
      [0, '#6d9bc2'], [0.55, '#a7c0d2'], [1, '#e0cda9'],
    ]);
  }

  _setSky(stops) {
    if (this._skyTex) this._skyTex.dispose();
    const cv = document.createElement('canvas');
    cv.width = 2; cv.height = 256;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
    const sky = new THREE.CanvasTexture(cv);
    sky.colorSpace = THREE.SRGBColorSpace;
    this._skyTex = sky;
    this.scene.background = sky;
  }

  _applyEnvironment(layout) {
    if (layout === 'fortaleza') {
      // Hora dorada: contraste cálido/frío para separar piedra y jugadores.
      this.hemi.color.setHex(0x8fb4d0);
      this.hemi.groundColor.setHex(0x7a634b);
      this.hemi.intensity = 1.48;
      this.amb.color.setHex(0xffd8aa);
      this.amb.intensity = 0.24;
      this.sun.color.setHex(0xffc77f);
      this.sun.intensity = 2.15;
      this.sun.position.set(-18, 20, -11);
      this._setSky([
        [0, '#435f7d'], [0.47, '#7f9bb0'], [0.78, '#c7a27f'], [1, '#e7b36f'],
      ]);
      // Empieza fuera de los carriles jugables; solo integra paisaje lejano.
      this.scene.fog = new THREE.Fog(0x91a0a3, 46, 118);
    } else if (layout === 'azoteas') {
      // Noche urbana: luna fría, ambiente azul y resplandor cálido de la
      // ciudad en el horizonte. Los acentos emisivos (ventanas, neón,
      // luces de antena) ponen el color.
      this.hemi.color.setHex(0x6683ad);
      this.hemi.groundColor.setHex(0x222a36);
      this.hemi.intensity = 1.34;
      this.amb.color.setHex(0x52647f);
      this.amb.intensity = 0.54;
      this.sun.color.setHex(0xc3d5f2); // luna
      this.sun.intensity = 1.52;
      this.sun.position.set(20, 26, -14);
      this._setSky([
        [0, '#060b17'], [0.5, '#10203a'], [0.82, '#283a55'], [1, '#624553'],
      ]);
      // Profundidad urbana: inicia fuera del combate y funde el skyline.
      this.scene.fog = new THREE.Fog(0x111a2a, 52, 128);
    } else {
      this.hemi.color.setHex(0xd9e6f0);
      this.hemi.groundColor.setHex(0x97876e);
      this.hemi.intensity = 1.55;
      this.amb.color.setHex(0xfff4e2);
      this.amb.intensity = 0.25;
      this.sun.color.setHex(0xffe9c4);
      this.sun.intensity = 2.3;
      this.sun.position.set(14, 22, 8);
      this._setSky([
        [0, '#6d9bc2'], [0.55, '#a7c0d2'], [1, '#e0cda9'],
      ]);
      this.scene.fog = null;
    }
  }

  _buildFloor() {
    // fortaleza: losas de arenisca; azoteas: grava/brea de techo urbano
    const roof = this.layout === 'azoteas';
    const tex = roof
      ? this._tex('roofFloor', this.fx * 2 / 4.2, this.fz * 2 / 4.2)
      : this._tex('floor', this.fx * 2 / 2.6, this.fz * 2 / 2.6);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(this.fx * 2, this.fz * 2),
      new THREE.MeshLambertMaterial({
        map: tex,
        color: roof ? 0xcdd0d4 : this.layout === 'fortaleza' ? 0xc3b79f : 0xffffff,
      })
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
  _box(x, z, w, d, h, {
    mirror = true, color = 0x9a958c, top = 0xaeaaa1, cover = true, visual = true,
    surface = null,
  } = {}) {
    const place = (px, pz) => {
      // variación sutil de tono por caja: rompe la monotonía sin romper la paleta
      const jit = 0.95 + Math.random() * 0.1;
      const c = new THREE.Color(color).multiplyScalar(jit).getHex();
      const t = new THREE.Color(top).multiplyScalar(jit).getHex();
      if (visual) this._batchBox(px, pz, w, d, h, c, t);
      const minx = px - w / 2, maxx = px + w / 2, minz = pz - d / 2, maxz = pz + d / 2;
      const material = surface || (this.layout === 'fortaleza' ? 'stone' : 'concrete');
      this.colliders.push({ minx, minz, maxx, maxz, h, surface: material });
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
    // Jerarquía tonal: tapas claras = superficies jugables; muros altos más
    // oscuros = fondo. El jugador reconoce la altura antes de leer el patrón.
    const lowOpts = { color: 0x968b79, top: 0xcbbd9f };
    const midOpts = { color: 0x81786b, top: 0xb5a790 };
    const highOpts = { color: 0x817970, top: 0xa69b89 };
    const wallOpts = { mirror: false, color: 0x787168, top: 0x9a907f };

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
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x898176, map: this._tex('stone', 1, 0.5) });
    const towerMat = new THREE.MeshLambertMaterial({ color: 0x827b72, map: this._tex('stone', 8, 5) });

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
      new THREE.MeshLambertMaterial({ color: 0x687153 })
    );
    land.rotation.x = -Math.PI / 2;
    land.position.y = -0.04;
    land.receiveShadow = true;
    this.mapGroup.add(land);

    // --- torreones lejanos (el "resto" del castillo), en piedra y con techo
    const farTowers = [[-30, -16, 3.4, 11], [32, 9, 4, 13], [-28, 20, 3, 9], [29, -22, 3.6, 10]];
    for (const [x, z, r, h] of farTowers) {
      const t = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.88, r, h, 10),
        new THREE.MeshLambertMaterial({ color: 0x77736d, map: this._tex('stone', 10, 6) })
      );
      t.position.set(x, h / 2 - 0.5, z);
      this.mapGroup.add(t);
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(r * 1.05, r * 1.3, 10),
        new THREE.MeshLambertMaterial({ color: 0x704632 })
      );
      cap.position.set(x, h - 0.5 + r * 0.6, z);
      this.mapGroup.add(cap);
    }

    this._vegetation(towers);
    this._props(towers);
    this._detailFortaleza(towers, farTowers);
  }

  // Landmarks y capas de lectura. Todo vive fuera del sistema de colliders:
  // mejora orientación/atmósfera sin cambiar una sola ruta de combate.
  _detailFortaleza(towers, farTowers) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();

    // Portones de cada facción: gran ancla visual detrás de los estandartes.
    const gate = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(4.6, 2.45),
      new THREE.MeshLambertMaterial({ map: this._tex('gate'), color: 0xa47a56 }), 2);
    for (const [i, z, ry] of [[0, -20.385, 0], [1, 20.385, Math.PI]]) {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(0, 1.23, z), q, s.set(1, 1, 1));
      gate.setMatrixAt(i, m4);
    }
    gate.receiveShadow = true;
    this.mapGroup.add(gate);

    // Grietas grandes en muros: una sola geometría instanciada.
    const crackSpots = [
      [-20.95, 1.45, -5, Math.PI / 2, 1.2], [-20.95, 1.35, 13, Math.PI / 2, 0.9],
      [20.95, 1.4, 4, -Math.PI / 2, 1.1], [20.95, 1.3, -15, -Math.PI / 2, 0.85],
      [-12, 1.45, -26.55, 0, 1.15], [10, 1.3, -26.55, 0, 0.9],
      [14, 1.45, 26.55, Math.PI, 1.1], [-7, 1.35, 26.55, Math.PI, 0.85],
    ];
    const crackMat = new THREE.MeshBasicMaterial({
      map: this._tex('crack'), transparent: true, alphaTest: 0.12,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const cracks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 1.35), crackMat, crackSpots.length);
    crackSpots.forEach(([x, y, z, ry, sc], i) => {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(x, y, z), q, s.set(sc, sc, sc));
      cracks.setMatrixAt(i, m4);
    });
    this.mapGroup.add(cracks);

    // Manchas suaves en esquinas: rompen el mosaico sin crear decal por objeto.
    const stains = [
      [-18, -22, 2.3, 1.2], [-19, -8, 1.7, 1], [-18, 10, 2.1, 1.2],
      [18, 19, 2.3, 1.2], [19, 7, 1.7, 1], [18, -12, 2.1, 1.2],
      [-9, -25, 1.5, 0.8], [8, 25, 1.5, 0.8], [-2.5, 2.5, 1.1, 0.65], [3, -3, 1.1, 0.65],
    ];
    const stainMat = new THREE.MeshBasicMaterial({
      color: 0x4b3d2f, transparent: true, opacity: 0.12, depthWrite: false,
    });
    const stainMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 18), stainMat, stains.length);
    stains.forEach(([x, z, sx, sz], i) => {
      q.setFromEuler(e.set(-Math.PI / 2, 0, (x + z) * 0.13));
      m4.compose(p.set(x, 0.018, z), q, s.set(sx, sz, 1));
      stainMesh.setMatrixAt(i, m4);
    });
    this.mapGroup.add(stainMesh);

    // Ventanas negras en torreones cercanos y lejanos: escala arquitectónica.
    const windowData = [];
    const addTowerWindows = (x, z, r, ys) => {
      const len = Math.hypot(x, z) || 1;
      const nx = -x / len, nz = -z / len;
      const ry = Math.atan2(nx, nz);
      for (const y of ys) windowData.push([x + nx * (r + 0.035), y, z + nz * (r + 0.035), ry]);
    };
    for (const [x, z] of towers) addTowerWindows(x, z, 2.18, [3.1, 5.2]);
    for (const [x, z, r, h] of farTowers) addTowerWindows(x, z, r * 0.91, [h * 0.42, h * 0.66]);
    const windows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.52, 0.9),
      new THREE.MeshBasicMaterial({ color: 0x1c2225 }), windowData.length);
    windowData.forEach(([x, y, z, ry], i) => {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(x, y, z), q, s.set(1, 1, 1));
      windows.setMatrixAt(i, m4);
    });
    this.mapGroup.add(windows);

    // Horizonte low-poly con color atmosférico; la niebla lo funde al cielo.
    const mountainData = [
      [-82, -56, 23, 12, 16], [-48, -82, 28, 15, 18], [8, -94, 32, 17, 19],
      [66, -70, 25, 13, 16], [92, -18, 31, 16, 20], [84, 55, 28, 14, 18],
      [24, 94, 34, 18, 21], [-43, 88, 27, 14, 18], [-91, 39, 30, 16, 19],
    ];
    const mountains = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshLambertMaterial({ color: 0x596a72, flatShading: true }), mountainData.length);
    mountainData.forEach(([x, z, sx, sy, sz], i) => {
      q.setFromEuler(e.set(0, i * 0.71, 0));
      m4.compose(p.set(x, sy * 0.42 - 2.2, z), q, s.set(sx, sy, sz));
      mountains.setMatrixAt(i, m4);
    });
    this.mapGroup.add(mountains);

    const sunDisk = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 14, 8),
      new THREE.MeshBasicMaterial({ color: 0xffca78, fog: false }));
    sunDisk.position.set(-58, 28, -76);
    this.mapGroup.add(sunDisk);

    // Carril de asedio (este): cajas al pie de la muralla, fuera de la ruta.
    const crateData = [
      [20.05, -18, 0.8, 0], [20.1, -10, 0.65, 0.2], [20.0, -2, 0.75, -0.15],
      [20.05, 7, 0.7, 0.25], [20.05, 15, 0.85, -0.2], [19.55, -17.7, 0.55, 0.4],
    ];
    const siegeWood = new THREE.MeshLambertMaterial({ color: 0x735239 });
    const crates = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.75, 0.68, 0.75),
      siegeWood, crateData.length);
    crateData.forEach(([x, z, sc, ry], i) => {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(x, 0.34 * sc, z), q, s.set(sc, sc, sc));
      crates.setMatrixAt(i, m4);
    });
    crates.castShadow = true;
    this.mapGroup.add(crates);

    // Andamio del carril de asedio: silueta de madera pegada a la muralla.
    const beamData = [
      [20.52, 1.25, -2.2, 0, 0.13, 2.5, 0.13],
      [20.52, 1.25, 2.2, 0, 0.13, 2.5, 0.13],
      [20.52, 0.55, 0, 0, 0.13, 0.13, 4.6],
      [20.52, 1.9, 0, 0, 0.13, 0.13, 4.6],
      [20.49, 1.23, 0, -0.34, 0.1, 0.1, 4.5],
    ];
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), siegeWood, beamData.length);
    beamData.forEach(([x, y, z, rx, sx, sy, sz], i) => {
      q.setFromEuler(e.set(rx, 0, 0));
      m4.compose(p.set(x, y, z), q, s.set(sx, sy, sz));
      beams.setMatrixAt(i, m4);
    });
    beams.castShadow = true;
    this.mapGroup.add(beams);

    // Faro central sobre el pilar: visible desde cualquier carril, sin luz real.
    const metal = new THREE.MeshLambertMaterial({ color: 0x302c29 });
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.78, 0.24, 8), stoneMatFor(0x867d6f));
    plinth.position.set(0, BLOCK.HIGH + 0.12, 0);
    this.mapGroup.add(plinth);
    const supports = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), metal, 4);
    [[-0.34, -0.34], [0.34, -0.34], [-0.34, 0.34], [0.34, 0.34]].forEach(([x, z], i) => {
      m4.compose(p.set(x, BLOCK.HIGH + 0.49, z), q.identity(), s.set(1, 1, 1));
      supports.setMatrixAt(i, m4);
    });
    this.mapGroup.add(supports);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.3, 0.2, 10), metal);
    bowl.position.set(0, BLOCK.HIGH + 0.88, 0);
    this.mapGroup.add(bowl);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.27, 0.78, 7),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d }));
    flame.position.set(0, BLOCK.HIGH + 1.35, 0);
    this.mapGroup.add(flame);
    const core = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.46, 7),
      new THREE.MeshBasicMaterial({ color: 0xffe0a0 }));
    core.position.set(0, BLOCK.HIGH + 1.27, -0.01);
    this.mapGroup.add(core);

    function stoneMatFor(color) {
      return new THREE.MeshLambertMaterial({ color });
    }
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
      [-20.95, -19, Math.PI / 2, 2.1, 2.2, 1.4],   // carril jardín (oeste)
      [-20.95, 5, Math.PI / 2, 3.4, 2.8, 1.55],
      [-20.95, 18, Math.PI / 2, 2.3, 2.4, 1.45],
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

    // banderines triangulares en torreones (color del lado). El centro usa
    // ahora el faro de fuego como landmark y no necesita otra silueta.
    const flagGeo = new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.85, 0.22), new THREE.Vector2(0, 0.44),
    ]));
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4038 });
    const spots = towers.map(([tx, tz]) => [tx, 8.0, tz, tz < 0 ? 0xd94f3f : 0x4f8de0]);
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

  // Mapa "Azoteas": techos de ciudad de noche. Misma simetría rotacional 180°
  // y las MISMAS tres alturas (LOW/MID/HIGH): unidades de A/C y claraboyas
  // como cobertura baja, casetas como muros, cuartos de máquinas altos.
  // Spawns fijos en ±35.1. La cancha conserva sus 63 × 80 m originales.
  _buildAzoteas() {
    const { LOW, MID, HIGH } = BLOCK;
    // Familias tonales distintas: el jugador reconoce A/C, ductos, casetas y
    // vidrio antes de acercarse, aun con la iluminación nocturna.
    const acOpts = { color: 0x8796a5, top: 0xb9c7d2, surface: 'metal' };    // A/C metálicos
    const ventOpts = { color: 0x71808e, top: 0xa6b2bc, surface: 'metal' }; // ductos
    const hutOpts = { color: 0x727b86, top: 0x9ba5ae, surface: 'concrete' };
    const glassOpts = { color: 0x38677c, top: 0x67b6d0, surface: 'metal' }; // marco de claraboya
    const wallOpts = { mirror: false, color: 0x59636f, top: 0x7e8994, surface: 'concrete' };

    // perímetro: parapetos / fachadas de los edificios vecinos
    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // --- salida de base: dos anclas distintas en vez de A/C gemelos
    this._box(0, -31.35, 8, 1.2, HIGH, hutOpts);           // caseta de acceso / escudo
    this._box(-8.2, -27.7, 4, 2.2, LOW, acOpts);           // estación HVAC de ruta técnica
    this._box(11.5, -22.8, 3.8, 3.8, LOW, glassOpts);      // claraboya: cruce expuesto
    this._box(-12.2, -22.1, 5.6, 1.1, MID, hutOpts);       // mamparo: corta la LOS central

    // --- esquinas y anillo exterior: dos instalaciones reconocibles sustituyen
    // cinco cajas aisladas. Conservan circulación posterior y dos contraángulos.
    this._box(-26.3, -31.5, 6, 4, LOW, acOpts);            // planta HVAC de esquina
    this._box(26, -31.5, 5.5, 2.6, MID, hutOpts);          // subestación eléctrica
    this._box(-27, -23.5, 1.4, 5, LOW, ventOpts);          // ducto de planta a tanque
    this._box(27, -23.2, 4, 1.4, LOW, ventOpts);           // manifold de subestación

    // --- ruta técnica oeste: giros cerrados y posiciones de escopeta
    this._box(-20.25, -15.75, 2.8, 2.8, HIGH, hutOpts);    // elevador + tanque landmark
    this._box(-25, -6.8, 2.4, 6.2, MID, hutOpts);          // bases simétricas: grúa / generador
    // Núcleo alto idéntico en ambas instalaciones. La silueta superior cambia,
    // pero colisión, cover y rutas conservan simetría rotacional exacta.
    this._box(-25, -6.8, 1.7, 1.7, HIGH, { ...hutOpts, visual: false });
    this._azoteasLandmarks = {
      crane: { x: -25, z: -6.8 }, generator: { x: 25, z: 6.8 },
    };

    // --- aproximación central: una estación grande y un único bounce final
    this._box(-2, -15.6, 5.5, 2.5, LOW, acOpts);           // estación HVAC central
    // El panel solar reemplaza este cover, incluida su copia a 180°. Solo
    // cambia la lectura visual: huella, altura, caras y balance son los mismos.
    this._box(-4, -9.5, 3.6, 1.4, LOW, { ...acOpts, visual: false });
    this._solarCoverSpots = [
      { x: -4, z: -9.5, ry: 0 }, { x: 4, z: 9.5, ry: Math.PI },
    ];

    // --- ruta rápida este: corredor de roadie run con dos cortes de visión
    this._box(18, -14, 1.1, 5.2, HIGH, hutOpts);           // cuarto técnico / duelo CQC
    this._box(25.2, -17.2, 1.1, 3, LOW, ventOpts);         // opción exterior de riesgo
    this._box(27.2, -7.2, 3, 1.1, LOW, ventOpts);          // pausa antes de media cancha

    // --- anillo del helipuerto: dos anclas distintas por mitad. Sus huellas
    // quedan fuera del pad de 12.75 m y dejan el centro totalmente abierto.
    this._box(9.6, -4.3, 4.2, 1.1, MID, hutOpts);          // posición fuerte, flanqueable
    this._box(-9.3, -5.2, 3, 2.6, LOW, acOpts);            // apoyo flexible de corto alcance

    // --- CENTRO: helipuerto DESPEJADO (regla de Chuck) — cero obstáculos ni
    // decoración dentro del pad; el cover vive en el anillo de media cancha
    this.surfaceZones.push({ kind: 'helipad', ...HELIPAD });
    // La pared y la baranda del propio octágono forman el cover. Los lados
    // norte/sur dejan un hueco central para las rampas; los otros seis lados
    // son continuos. El collider llega hasta la parte superior de la baranda,
    // pero su altura táctica sigue siendo LOW medida desde la plataforma.
    const verts = Array.from({ length: 8 }, (_, i) => {
      const a = Math.PI / 8 + i * Math.PI / 4;
      return { x: Math.sin(a) * HELIPAD.radius, z: Math.cos(a) * HELIPAD.radius };
    });
    this._helipadSegments = [];
    const addSide = (a, b) => {
      const tx = b.x - a.x, tz = b.z - a.z;
      const len = Math.hypot(tx, tz);
      if (len < 0.05) return;
      const n = { x: -tz / len, z: tx / len }; // vértices en sentido horario
      const wall = { a, b, n, half: 0.08, h: HELIPAD.height + LOW, coverH: LOW, surface: 'metal' };
      this._helipadSegments.push(wall);
      this.segmentColliders.push(wall);
      for (const side of [1, -1]) {
        const sn = { x: n.x * side, z: n.z * side };
        const off = wall.half * side;
        this.faces.push({
          n: sn,
          a: { x: a.x + n.x * off, z: a.z + n.z * off },
          b: { x: b.x + n.x * off, z: b.z + n.z * off },
          h: wall.coverH,
        });
      }
    };
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const rampSide = Math.abs(a.z - b.z) < 0.01 && Math.abs(a.z) > HELIPAD.edge - 0.05;
      if (!rampSide) { addSide(a, b); continue; }
      const z = a.z;
      if (a.x < b.x) {
        addSide(a, { x: -HELIPAD.rampHalfWidth, z });
        addSide({ x: HELIPAD.rampHalfWidth, z }, b);
      } else {
        addSide(a, { x: HELIPAD.rampHalfWidth, z });
        addSide({ x: -HELIPAD.rampHalfWidth, z }, b);
      }
    }

    this._decorAzoteas();
  }

  // Ambiente nocturno de Azoteas: TODO decorativo (cero colisión) — skyline
  // con ventanas encendidas, tanque de agua central, antenas con luz roja,
  // claraboyas con brillo, neones de equipo y luna.
  _decorAzoteas() {
    const { HIGH } = BLOCK;
    // --- calle abajo y skyline alrededor (edificios con ventanas emisivas)
    const street = new THREE.Mesh(
      new THREE.PlaneGeometry(340, 340),
      new THREE.MeshBasicMaterial({ color: 0x0a0c12 })
    );
    street.rotation.x = -Math.PI / 2;
    street.position.y = -8;
    this.mapGroup.add(street);

    const bldgs = [
      [-48, -18, 12, 24], [-54, 12, 14, 17], [-44, 36, 11, 12],
      [48, 18, 12, 26], [52, -14, 13, 16], [44, -38, 11, 19],
      [-18, -55, 13, 14], [12, -58, 15, 22], [21, 55, 13, 13],
      [-12, 58, 14, 24], [36, 50, 11, 11], [-36, -50, 12, 10],
    ];
    const skylineRoofMat = new THREE.MeshBasicMaterial({ color: 0x111826 });
    for (const [x, z, w, h] of bldgs) {
      const facade = new THREE.MeshBasicMaterial({
        map: this._tex('windows', Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 12))),
        color: 0xa7b4c5,
      });
      const b = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, w * 0.85),
        [facade, facade, skylineRoofMat, skylineRoofMat, facade, facade]
      );
      b.position.set(x, h / 2 - 8, z);
      this.mapGroup.add(b);
    }

    // --- DOS tanques de agua simétricos sobre las casetas de elevador,
    // en lados opuestos del área central (el centro quedó despejado para
    // el helipuerto — pedido de Chuck)
    this._tankSpots = [[-20.25, -15.75], [20.25, 15.75]];
    const tankMat = new THREE.MeshLambertMaterial({ color: 0x4c525c });
    for (const [tx, tz] of this._tankSpots) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.5, 10), tankMat);
      tank.position.set(tx, HIGH + 0.75, tz);
      tank.castShadow = true;
      this.mapGroup.add(tank);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.55, 10), tankMat);
      cap.position.set(tx, HIGH + 1.75, tz);
      this.mapGroup.add(cap);
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff4444 })
      );
      beacon.position.set(tx, HIGH + 2.12, tz);
      this.mapGroup.add(beacon);
    }

    // --- antenas con luz roja (sobre casetas de elevador y perímetro)
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3f46 });
    const redMat = new THREE.MeshBasicMaterial({ color: 0xff5544 });
    for (const [ax, az, base] of [
      [18, -14, HIGH], [-18, 14, HIGH],             // cuartos técnicos de carril
      [-this.fx - 0.4, -21, HIGH], [this.fx + 0.4, 21, HIGH],
      [3, -31.35, HIGH], [-3, 31.35, HIGH],         // casetas de spawn
    ]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.4, 5), poleMat);
      pole.position.set(ax, base + 1.2, az);
      this.mapGroup.add(pole);
      for (const [by, bw] of [[0.7, 0.7], [1.3, 0.45]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.035, 0.035), poleMat);
        bar.position.set(ax, base + by, az);
        this.mapGroup.add(bar);
      }
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), redMat);
      light.position.set(ax, base + 2.45, az);
      this.mapGroup.add(light);
    }

    // --- brillo de las claraboyas (vidrio iluminado desde adentro)
    for (const [gx, gz] of [[11.5, -22.8], [-11.5, 22.8]]) {
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(3.3, 3.3),
        new THREE.MeshBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.32 })
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(gx, BLOCK.LOW + 0.012, gz);
      this.mapGroup.add(glow);
    }

    // --- neón de equipo en la caseta de spawn (mirando al campo)
    for (const [color, z, ry] of [[0xd94f3f, -31.35 + 0.62, 0], [0x4f8de0, 31.35 - 0.62, Math.PI]]) {
      const neon = new THREE.Mesh(
        new THREE.PlaneGeometry(5.4, 0.16),
        new THREE.MeshBasicMaterial({ color })
      );
      neon.position.set(0, 2.5, z);
      neon.rotation.y = ry;
      this.mapGroup.add(neon);
    }

    // --- luna
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xf2ecd8 })
    );
    moon.position.set(44, 44, -74);
    this.mapGroup.add(moon);

    this._detailAzoteas(bldgs, moon.position);
  }

  // Landmarks de media cancha. Comparten huella física y núcleo HIGH a 180°;
  // la grúa aporta altura en el oeste y el generador masa industrial al este.
  // Todo lo que sobresale de los núcleos es decorativo y de geometría barata.
  _addAzoteasLandmarks() {
    const spots = this._azoteasLandmarks;
    if (!spots) return;
    const steel = new THREE.MeshStandardMaterial({ color: 0x465967, metalness: 0.72, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d2933, metalness: 0.78, roughness: 0.45 });
    const casing = new THREE.MeshStandardMaterial({ color: 0x536b78, metalness: 0.62, roughness: 0.56 });
    const craneYellow = new THREE.MeshStandardMaterial({
      color: 0xd9a51c, emissive: 0x2a1900, emissiveIntensity: 0.14,
      metalness: 0.58, roughness: 0.46,
    });
    const cyan = new THREE.MeshBasicMaterial({ color: 0x54d9e4 });
    const red = new THREE.MeshBasicMaterial({ color: 0xff5749 });
    const beamAxis = new THREE.Vector3(0, 0, 1);
    const boxBatches = new Map();

    const addBox = (parent, w, h, d, x, y, z, mat, cast = true) => {
      let batches = boxBatches.get(parent);
      if (!batches) { batches = new Map(); boxBatches.set(parent, batches); }
      const key = `${mat.uuid}:${cast ? 1 : 0}`;
      let batch = batches.get(key);
      if (!batch) { batch = { mat, cast, matrices: [] }; batches.set(key, batch); }
      batch.matrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(w, h, d)));
    };
    const addBeam = (parent, a, b, width, mat) => {
      const delta = b.clone().sub(a);
      const len = delta.length();
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const rot = new THREE.Quaternion().setFromUnitVectors(beamAxis, delta.normalize());
      let batches = boxBatches.get(parent);
      if (!batches) { batches = new Map(); boxBatches.set(parent, batches); }
      const key = `${mat.uuid}:1`;
      let batch = batches.get(key);
      if (!batch) { batch = { mat, cast: true, matrices: [] }; batches.set(key, batch); }
      batch.matrices.push(new THREE.Matrix4().compose(mid, rot, new THREE.Vector3(width, width, len)));
    };
    const addBeacon = (parent, x, y, z) => {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), red);
      lamp.position.set(x, y, z);
      parent.add(lamp);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._tex('glow'), color: 0xff5949, transparent: true,
        opacity: 0.48, depthWrite: false, fog: false,
      }));
      halo.position.copy(lamp.position);
      halo.scale.set(0.85, 0.85, 1);
      parent.add(halo);
    };
    const addSteam = (parent, x, y, z) => {
      for (let i = 0; i < 3; i++) {
        const puff = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this._tex('glow'), color: 0xc7d6df, transparent: true,
          opacity: 0.16 - i * 0.025, depthWrite: false,
        }));
        puff.position.set(x + i * 0.12, y + i * 0.42, z - i * 0.08);
        const size = 0.65 + i * 0.35;
        puff.scale.set(size, size, 1);
        parent.add(puff);
      }
    };

    // Grúa oeste: pedestal sólido hasta HIGH y celosía liviana por encima.
    const crane = new THREE.Group();
    crane.position.set(spots.crane.x, 0, spots.crane.z);
    crane.rotation.y = Math.atan2(spots.crane.z, -spots.crane.x);
    this.mapGroup.add(crane);
    addBox(crane, 1.7, BLOCK.HIGH - BLOCK.MID, 1.7,
      0, BLOCK.MID + (BLOCK.HIGH - BLOCK.MID) / 2, 0, casing);
    addBox(crane, 2.05, 0.16, 2.05, 0, BLOCK.HIGH + 0.08, 0, dark);
    const towerBottom = BLOCK.HIGH + 0.16, towerH = 5.0, towerTop = towerBottom + towerH;
    for (const x of [-0.55, 0.55]) {
      for (const z of [-0.55, 0.55]) {
        addBox(crane, 0.13, towerH, 0.13, x, towerBottom + towerH / 2, z, craneYellow);
      }
    }
    for (let i = 0; i <= 4; i++) {
      const y = towerBottom + i * (towerH / 4);
      addBox(crane, 1.24, 0.1, 0.1, 0, y, -0.55, dark);
      addBox(crane, 1.24, 0.1, 0.1, 0, y, 0.55, dark);
      addBox(crane, 0.1, 0.1, 1.24, -0.55, y, 0, dark);
      addBox(crane, 0.1, 0.1, 1.24, 0.55, y, 0, dark);
    }
    for (let i = 0; i < 4; i++) {
      const y0 = towerBottom + i * (towerH / 4), y1 = y0 + towerH / 4;
      const flip = i % 2 ? -1 : 1;
      for (const z of [-0.56, 0.56]) {
        addBeam(crane,
          new THREE.Vector3(-0.5 * flip, y0 + 0.08, z),
          new THREE.Vector3(0.5 * flip, y1 - 0.08, z), 0.075, craneYellow);
      }
    }

    // Pluma orientada hacia el mapa, pero termina antes del anillo central.
    const boomLen = 13.5, boomY = towerTop - 0.12;
    for (const z of [-0.34, 0.34]) {
      addBox(crane, boomLen, 0.12, 0.12, boomLen / 2, boomY, z, craneYellow);
      addBox(crane, boomLen, 0.1, 0.1, boomLen / 2, boomY - 0.62, z, dark);
      for (let i = 0; i < 6; i++) {
        const x0 = i * boomLen / 6, x1 = (i + 1) * boomLen / 6;
        const swap = i % 2 === 0;
        addBeam(crane,
          new THREE.Vector3(x0, swap ? boomY : boomY - 0.62, z),
          new THREE.Vector3(x1, swap ? boomY - 0.62 : boomY, z), 0.065, craneYellow);
      }
    }
    addBox(crane, 3.4, 0.15, 0.7, -1.7, boomY - 0.08, 0, craneYellow);
    addBox(crane, 1.0, 0.7, 0.9, -3.15, boomY - 0.42, 0, dark);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.1, 6), dark);
    cable.position.set(10.8, boomY - 1.05, 0);
    crane.add(cable);
    addBox(crane, 0.34, 0.26, 0.34, 10.8, boomY - 2.16, 0, dark, false);
    // Indicador montado sobre la carcasa (antes quedaba separado de la base
    // porque la decoración de la grúa está rotada respecto al cover AABB).
    addBox(crane, 0.9, 0.08, 0.04, 0, BLOCK.MID + 0.42, 0.87, cyan, false);
    addBeacon(crane, 0, towerTop + 0.16, 0);
    addSteam(crane, -0.5, BLOCK.HIGH + 0.2, -0.45);

    // Generador este: mismo núcleo físico; volumen horizontal y escape alto
    // compensan la masa visual de la grúa sin copiar su silueta.
    const generator = new THREE.Group();
    generator.position.set(spots.generator.x, 0, spots.generator.z);
    // La planta sigue los ejes de su plataforma rectangular; la rotación que
    // orienta la pluma de la grúa la dejaba atravesada sobre el cover físico.
    generator.rotation.y = 0;
    this.mapGroup.add(generator);
    addBox(generator, 1.7, BLOCK.HIGH - BLOCK.MID, 1.7,
      0, BLOCK.MID + (BLOCK.HIGH - BLOCK.MID) / 2, 0, casing);
    addBox(generator, 2.05, 0.14, 2.05, 0, BLOCK.HIGH + 0.07, 0, dark);
    for (const z of [-2.05, 2.05]) {
      addBox(generator, 1.75, 0.55, 1.25, 0, BLOCK.MID + 0.28, z, steel);
      for (let i = -2; i <= 2; i++) {
        addBox(generator, 0.06, 0.34, 1.27, i * 0.25,
          BLOCK.MID + 0.28, z, dark, false);
      }
    }
    addBox(generator, 0.09, 0.78, 1.2, -0.88, BLOCK.MID + 0.55, 0, dark, false);
    addBox(generator, 0.09, 0.78, 1.2, 0.88, BLOCK.MID + 0.55, 0, dark, false);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 2.2, 8), dark);
    stack.position.set(0.48, BLOCK.HIGH + 1.1, -0.35);
    generator.add(stack);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.2, 0.12, 8), steel);
    cap.position.set(0.48, BLOCK.HIGH + 2.2, -0.35);
    generator.add(cap);
    for (const z of [-2.72, 2.72]) {
      addBox(generator, 1.15, 0.08, 0.08, 0, BLOCK.MID + 0.18, z, cyan, false);
    }
    addBeacon(generator, -0.48, BLOCK.HIGH + 0.22, 0.42);
    addSteam(generator, 0.48, BLOCK.HIGH + 2.3, -0.35);

    // Todas las vigas/cajas de cada material se suben como instancias: la
    // celosía conserva su silueta con un puñado de draw calls.
    for (const [parent, batches] of boxBatches) {
      for (const { mat, cast, matrices } of batches.values()) {
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, matrices.length);
        matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
    }
  }

  // El mismo par de cajas LOW conserva la física original, pero se lee como
  // paneles técnicos. Cada grupo es la rotación 180° exacta del otro.
  _addAzoteasSolarCovers() {
    if (!this._solarCoverSpots) return;
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x173b55, emissive: 0x071b28, emissiveIntensity: 0.45,
      metalness: 0.48, roughness: 0.32,
    });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x647785, metalness: 0.75, roughness: 0.4 });
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x263641, metalness: 0.65, roughness: 0.55 });
    const lightMat = new THREE.MeshBasicMaterial({ color: 0x4ed8e4 });
    for (const spot of this._solarCoverSpots) {
      const group = new THREE.Group();
      group.position.set(spot.x, 0, spot.z);
      group.rotation.y = spot.ry;
      this.mapGroup.add(group);
      const base = new THREE.Mesh(new THREE.BoxGeometry(3.55, 0.34, 1.34), baseMat);
      base.position.y = 0.17;
      base.castShadow = true;
      base.receiveShadow = true;
      group.add(base);
      for (const x of [-1.16, 0, 1.16]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.07, 1.18), panelMat);
        panel.position.set(x, 0.82, 0);
        panel.rotation.x = -0.38;
        panel.castShadow = true;
        group.add(panel);
        for (const px of [-0.42, 0.42]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.64, 0.06), frameMat);
          post.position.set(x + px, 0.48, 0.27);
          group.add(post);
        }
      }
      for (const x of [-1.72, 1.72]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.42), lightMat);
        lamp.position.set(x, 0.42, -0.48);
        group.add(lamp);
      }
    }
  }

  // Capas urbanas de bajo coste: señalética, ventiladores, luces de borde y
  // siluetas. No participan en colisión ni cobertura.
  _detailAzoteas(bldgs, moonPos) {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p = new THREE.Vector3(), s = new THREE.Vector3();

    this._addAzoteasLandmarks();
    this._addAzoteasSolarCovers();

    // Helipuerto sobre plinto metálico octagonal. La elevación es real para
    // jugadores y bots (groundHeight), pero demasiado baja para dar ventaja.
    const deckSide = new THREE.MeshStandardMaterial({ color: 0x263541, metalness: 0.72, roughness: 0.48 });
    const deckTop = new THREE.MeshStandardMaterial({ color: 0x566873, metalness: 0.58, roughness: 0.62 });
    const deck = new THREE.Mesh(
      new THREE.CylinderGeometry(HELIPAD.radius, HELIPAD.radius, HELIPAD.height, 8),
      [deckSide, deckTop, deckSide]);
    deck.name = 'azoteas-helipad-deck';
    deck.position.y = HELIPAD.height / 2;
    deck.rotation.y = Math.PI / 8;
    deck.receiveShadow = true;
    this.mapGroup.add(deck);

    // Baranda blindada exactamente sobre los segmentos físicos del octágono.
    // El zócalo sólido protege al jugador agachado y los travesaños/postes
    // comunican con claridad el límite jugable; las dos rampas quedan abiertas.
    const railPanelMat = new THREE.MeshStandardMaterial({
      color: 0x314753, metalness: 0.76, roughness: 0.42,
    });
    const railFrameMat = new THREE.MeshStandardMaterial({
      color: 0x8298a3, metalness: 0.86, roughness: 0.3,
    });
    const railSegments = this._helipadSegments ?? [];
    const railPanel = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), railPanelMat, railSegments.length);
    const railBars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), railFrameMat, railSegments.length * 2);
    const postPoints = new Map();
    railSegments.forEach((seg, i) => {
      const tx = seg.b.x - seg.a.x, tz = seg.b.z - seg.a.z;
      const len = Math.hypot(tx, tz);
      const yaw = -Math.atan2(tz, tx);
      q.setFromEuler(e.set(0, yaw, 0));
      const cx = (seg.a.x + seg.b.x) * 0.5;
      const cz = (seg.a.z + seg.b.z) * 0.5;
      m4.compose(
        p.set(cx, HELIPAD.height + 0.39, cz),
        q, s.set(Math.max(0.08, len - 0.08), 0.78, 0.12));
      railPanel.setMatrixAt(i, m4);
      for (let bar = 0; bar < 2; bar++) {
        m4.compose(
          p.set(cx, HELIPAD.height + 0.86 + bar * 0.2, cz),
          q, s.set(len + 0.08, 0.12, 0.16));
        railBars.setMatrixAt(i * 2 + bar, m4);
      }
      for (const pt of [seg.a, seg.b]) {
        postPoints.set(`${pt.x.toFixed(3)},${pt.z.toFixed(3)}`, pt);
      }
      if (len > 2.6) postPoints.set(`mid-${i}`, { x: cx, z: cz });
    });
    const railPosts = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), railFrameMat, postPoints.size);
    let postIndex = 0;
    for (const pt of postPoints.values()) {
      m4.compose(
        p.set(pt.x, HELIPAD.height + BLOCK.LOW * 0.5, pt.z),
        q.identity(), s.set(0.16, BLOCK.LOW, 0.16));
      railPosts.setMatrixAt(postIndex++, m4);
    }
    railPanel.name = 'azoteas-helipad-rail-panels';
    railBars.name = 'azoteas-helipad-rail-bars';
    railPosts.name = 'azoteas-helipad-rail-posts';
    railPanel.castShadow = railBars.castShadow = railPosts.castShadow = true;
    railPanel.receiveShadow = railBars.receiveShadow = railPosts.receiveShadow = true;
    this.mapGroup.add(railPanel, railBars, railPosts);

    // Dos accesos anchos por el eje de los equipos. Los lados este/oeste
    // alojan barreras de cover y siguen siendo rodeables por sus extremos.
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x435763, metalness: 0.66, roughness: 0.54 });
    const rampWidth = HELIPAD.rampHalfWidth * 2;
    const rampAngle = Math.atan2(HELIPAD.height, HELIPAD.rampLength);
    for (const axis of ['z']) {
      for (const sign of [-1, 1]) {
        const ramp = new THREE.Mesh(
          axis === 'z'
            ? new THREE.BoxGeometry(rampWidth, 0.08, HELIPAD.rampLength)
            : new THREE.BoxGeometry(HELIPAD.rampLength, 0.08, rampWidth),
          rampMat);
        if (axis === 'z') {
          ramp.position.set(0, HELIPAD.height / 2, sign * (HELIPAD.edge + HELIPAD.rampLength / 2));
          ramp.rotation.x = sign * rampAngle;
        } else {
          ramp.position.set(sign * (HELIPAD.edge + HELIPAD.rampLength / 2), HELIPAD.height / 2, 0);
          ramp.rotation.z = -sign * rampAngle;
        }
        ramp.receiveShadow = true;
        this.mapGroup.add(ramp);
      }
    }

    // Vigas del faldón y balizas cian: hacen legible la pared-cover del propio
    // octágono desde cualquier carril.
    const edgeLen = 2 * HELIPAD.radius * Math.sin(Math.PI / 8);
    const apothem = HELIPAD.radius * Math.cos(Math.PI / 8);
    const rim = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x18252e }), 8);
    const deckLights = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.9, 0.075, 0.055),
      new THREE.MeshBasicMaterial({ color: 0x55d5df }), 8);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      q.setFromEuler(e.set(0, a, 0));
      m4.compose(
        p.set(Math.sin(a) * apothem, HELIPAD.height * 0.5, Math.cos(a) * apothem),
        q, s.set(edgeLen * 0.93, 0.12, 0.14));
      rim.setMatrixAt(i, m4);
      m4.compose(
        p.set(Math.sin(a) * (apothem + 0.085), HELIPAD.height * 0.52,
          Math.cos(a) * (apothem + 0.085)),
        q, s.set(1, 1, 1));
      deckLights.setMatrixAt(i, m4);
    }
    rim.castShadow = true;
    this.mapGroup.add(rim, deckLights);

    // Las seis caras sin rampa llevan señalización: comunica que la pared
    // octagonal es una cobertura continua y no una simple peana decorativa.
    const markedSides = [1, 2, 3, 5, 6, 7];
    const deckHazards = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2.2, 0.18),
      new THREE.MeshBasicMaterial({ map: this._tex('hazard') }), markedSides.length);
    markedSides.forEach((side, i) => {
      const a = side * Math.PI / 4;
      q.setFromEuler(e.set(0, a, 0));
      m4.compose(
        p.set(Math.sin(a) * (apothem + 0.012), HELIPAD.height * 0.62,
          Math.cos(a) * (apothem + 0.012)),
        q, s.set(1, 1, 1));
      deckHazards.setMatrixAt(i, m4);
    });
    this.mapGroup.add(deckHazards);

    // Helipuerto central DESPEJADO: solo la marca pintada, sin obstáculos ni
    // decoración encima (regla de Chuck). Escalado con el mapa.
    const roofMark = new THREE.Mesh(
      new THREE.PlaneGeometry(12.75, 12.75),
      new THREE.MeshBasicMaterial({
        map: this._tex('roofMark'), transparent: true, opacity: 0.68,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
      })
    );
    roofMark.rotation.x = -Math.PI / 2;
    roofMark.position.y = HELIPAD.height + 0.012;
    this.mapGroup.add(roofMark);

    // Los equipos grandes llevan varios ventiladores: así se leen como bancos
    // HVAC completos y no como la misma caja pequeña repetida.
    const acSeed = [
      [-9, -27.7], [-7.4, -27.7],
      [-28, -31.5], [-26.3, -31.5], [-24.6, -31.5],
      [-3.6, -15.6], [-2, -15.6], [-0.4, -15.6],
      [-9.8, -5.2], [-8.8, -5.2],
    ];
    const seen = new Set(), acUnits = [];
    for (const [x, z] of acSeed) {
      for (const [ax, az] of [[x, z], [-x, -z]]) {
        const key = `${ax.toFixed(2)}:${az.toFixed(2)}`;
        if (!seen.has(key)) { seen.add(key); acUnits.push([ax, az]); }
      }
    }
    const fanMat = new THREE.MeshBasicMaterial({ color: 0x26313d });
    const fanRings = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.39, 0.39, 0.055, 14), fanMat, acUnits.length);
    acUnits.forEach(([x, z], i) => {
      m4.compose(p.set(x, BLOCK.LOW + 0.045, z), q.identity(), s.set(1, 1, 1));
      fanRings.setMatrixAt(i, m4);
    });
    this.mapGroup.add(fanRings);

    const blades = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x526273 }), acUnits.length * 2);
    let bladeI = 0;
    for (const [x, z] of acUnits) {
      for (const ry of [0, Math.PI / 2]) {
        q.setFromEuler(e.set(0, ry, 0));
        m4.compose(p.set(x, BLOCK.LOW + 0.085, z), q, s.set(0.55, 0.025, 0.075));
        blades.setMatrixAt(bladeI++, m4);
      }
    }
    this.mapGroup.add(blades);

    // Tuberías gemelas sobre los ductos del anillo exterior. Además de darles
    // lectura de azotea, dibujan visualmente la dirección de cada ruta.
    const pipeRuns = [
      [-27, -23.5, 5, 'z'], [27, 23.5, 5, 'z'],
      [27, -23.2, 4, 'x'], [-27, 23.2, 4, 'x'],
    ];
    const roofPipes = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.085, 0.085, 1, 8),
      new THREE.MeshLambertMaterial({ color: 0x536675 }), pipeRuns.length * 2);
    let pipeI = 0;
    for (const [x, z, len, axis] of pipeRuns) {
      for (const off of [-0.24, 0.24]) {
        q.setFromEuler(axis === 'x'
          ? e.set(0, 0, Math.PI / 2)
          : e.set(Math.PI / 2, 0, 0));
        m4.compose(
          p.set(x + (axis === 'z' ? off : 0), BLOCK.LOW + 0.13,
            z + (axis === 'x' ? off : 0)),
          q, s.set(1, len, 1));
        roofPipes.setMatrixAt(pipeI++, m4);
      }
    }
    roofPipes.castShadow = true;
    this.mapGroup.add(roofPipes);

    // Aisladores de la subestación: rompen su silueta rectangular y la
    // distinguen de los cuartos de máquinas sin sumar colisión.
    const transformerSpots = [
      [24.5, -31.5], [26, -31.5], [27.5, -31.5],
      [-24.5, 31.5], [-26, 31.5], [-27.5, 31.5],
    ];
    const transformers = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.19, 0.22, 0.62, 8),
      new THREE.MeshLambertMaterial({ color: 0x495969 }), transformerSpots.length);
    transformerSpots.forEach(([x, z], i) => {
      m4.compose(p.set(x, BLOCK.MID + 0.31, z), q.identity(), s.set(1, 1, 1));
      transformers.setMatrixAt(i, m4);
    });
    transformers.castShadow = true;
    this.mapGroup.add(transformers);

    // Franjas ámbar: muros de carril, casetas de los tanques y escudos de spawn.
    const hazardSpots = [
      [17.44, 1.34, -14, -Math.PI / 2, 1.3], [-17.44, 1.34, 14, Math.PI / 2, 1.3],
      [-19.04, 1.35, -15.75, Math.PI / 2, 1.0], [19.04, 1.35, 15.75, -Math.PI / 2, 1.0],
      [2.2, 1.5, -30.74, 0, 1.2], [-2.2, 1.5, 30.74, Math.PI, 1.2],
      [26, 1.0, -30.19, 0, 1.5], [-26, 1.0, 30.19, Math.PI, 1.5],
      [-23.79, 1.0, -6.8, Math.PI / 2, 1.2], [23.79, 1.0, 6.8, -Math.PI / 2, 1.2],
    ];
    const hazards = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.7, 0.22),
      new THREE.MeshBasicMaterial({ map: this._tex('hazard') }), hazardSpots.length);
    hazardSpots.forEach(([x, y, z, ry, sc], i) => {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(x, y, z), q, s.set(sc, 1, 1));
      hazards.setMatrixAt(i, m4);
    });
    this.mapGroup.add(hazards);

    // Balizas de borde: rojo/azul en bases, cian en flancos. Una sola malla.
    const edgeData = [];
    for (let x = -28; x <= 28; x += 7) {
      edgeData.push([x, -39.35, 0xff5d50, 0]);
      edgeData.push([x, 39.35, 0x64a9ff, 0]);
    }
    for (let z = -32; z <= 32; z += 8) {
      edgeData.push([-30.85, z, 0x55d5df, Math.PI / 2]);
      edgeData.push([30.85, z, 0x55d5df, Math.PI / 2]);
    }
    const edgeLights = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.55, 0.07, 0.12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }), edgeData.length);
    edgeData.forEach(([x, z, color, ry], i) => {
      q.setFromEuler(e.set(0, ry, 0));
      m4.compose(p.set(x, 0.055, z), q, s.set(1, 1, 1));
      edgeLights.setMatrixAt(i, m4);
      edgeLights.setColorAt(i, new THREE.Color(color));
    });
    edgeLights.instanceColor.needsUpdate = true;
    this.mapGroup.add(edgeLights);

    // Charcos de lluvia muy sutiles: rompen el mosaico sin reflejos costosos.
    const puddleData = [
      [-25.5, -30, 2.1, 0.85], [-19.5, 3, 1.45, 0.65], [-27, 22.5, 1.8, 0.8],
      [25.5, 30, 2.1, 0.85], [19.5, -3, 1.45, 0.65], [27, -22.5, 1.8, 0.8],
      [-7.5, 16.5, 1.4, 0.58], [7.5, -16.5, 1.4, 0.58],
      [-14, -26, 1.3, 0.55], [14, 26, 1.3, 0.55],
    ];
    const puddles = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 18),
      new THREE.MeshBasicMaterial({
        color: 0x15273a, transparent: true, opacity: 0.36, depthWrite: false,
      }), puddleData.length);
    puddleData.forEach(([x, z, sx, sz], i) => {
      q.setFromEuler(e.set(-Math.PI / 2, 0, (x - z) * 0.13));
      m4.compose(p.set(x, 0.026, z), q, s.set(sx, sz, 1));
      puddles.setMatrixAt(i, m4);
    });
    this.mapGroup.add(puddles);

    // Volúmenes técnicos oscuros sobre edificios: la ciudad deja de parecer
    // una colección de cubos luminosos idénticos.
    const roofBits = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x141b28 }), bldgs.length);
    bldgs.forEach(([x, z, w, h], i) => {
      const top = h - 8;
      q.setFromEuler(e.set(0, i * 0.47, 0));
      m4.compose(p.set(x + ((i % 3) - 1) * 0.7, top + 0.33, z), q,
        s.set(w * 0.28, 0.66, w * 0.2));
      roofBits.setMatrixAt(i, m4);
    });
    this.mapGroup.add(roofBits);

    // Anuncio cian/ámbar en el edificio este, orientado hacia la cancha.
    const billboard = new THREE.Mesh(
      new THREE.PlaneGeometry(6.2, 2.32),
      new THREE.MeshBasicMaterial({ map: this._tex('billboard'), side: THREE.DoubleSide }));
    billboard.position.set(41.9, 6.5, 18);
    billboard.rotation.y = -Math.PI / 2;
    billboard.scale.set(1.3, 1.3, 1);
    this.mapGroup.add(billboard);

    // Aros y escalera de CADA tanque: lectura industrial sin otra luz.
    const spots = this._tankSpots;
    const tankBands = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.07, 1.07, 0.07, 10),
      new THREE.MeshBasicMaterial({ color: 0x202934 }), spots.length * 2);
    spots.forEach(([tx, tz], t) => {
      [BLOCK.HIGH + 0.18, BLOCK.HIGH + 1.31].forEach((y, i) => {
        m4.compose(p.set(tx, y, tz), q.identity(), s.set(1, 1, 1));
        tankBands.setMatrixAt(t * 2 + i, m4);
      });
    });
    this.mapGroup.add(tankBands);
    const ladderParts = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x9b7040 }), spots.length * 7);
    spots.forEach(([tx, tz], t) => {
      const lz = tz + (tz < 0 ? -1.06 : 1.06); // escalera por la cara exterior
      let li = t * 7;
      for (let i = 0; i < 5; i++) {
        m4.compose(p.set(tx, BLOCK.HIGH + 0.15 + i * 0.29, lz), q.identity(), s.set(0.55, 0.045, 0.045));
        ladderParts.setMatrixAt(li++, m4);
      }
      for (const x of [-0.26, 0.26]) {
        m4.compose(p.set(tx + x, BLOCK.HIGH + 0.73, lz), q.identity(), s.set(0.045, 1.45, 0.045));
        ladderParts.setMatrixAt(li++, m4);
      }
    });
    this.mapGroup.add(ladderParts);

    // Tuberías al pie de los muros + escotillas de mantenimiento: textura de
    // piso con intención industrial, sin colisión ni estorbo a los pickups.
    const pipeMat = new THREE.MeshLambertMaterial({ color: 0x2b333e });
    for (const [px, pz, len, axis] of [
      [-31.02, -14, 16, 'z'], [31.02, 14, 16, 'z'],
      [-12, -39.55, 14, 'x'], [12, 39.55, 14, 'x'],
    ]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, len, 8), pipeMat);
      pipe.position.set(px, 0.32, pz);
      if (axis === 'z') pipe.rotation.x = Math.PI / 2; else pipe.rotation.z = Math.PI / 2;
      this.mapGroup.add(pipe);
    }
    const hatchSpots = [
      [-9, -31.5], [9, 31.5], [23, -5], [-23, 5],
      [-5.5, 20], [5.5, -20], [28, -14], [-28, 14],
    ];
    const hatches = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.3, 0.03, 1.3),
      new THREE.MeshLambertMaterial({ color: 0x232b36 }), hatchSpots.length);
    hatchSpots.forEach(([hx, hz], i) => {
      q.setFromEuler(e.set(0, (hx * 3 + hz) * 0.21, 0));
      m4.compose(p.set(hx, 0.016, hz), q, s.set(1, 1, 1));
      hatches.setMatrixAt(i, m4);
    });
    this.mapGroup.add(hatches);

    // Halos con sprites: dan sensación de emisión sin PointLights ni sombras.
    const haloMat = new THREE.SpriteMaterial({
      map: this._tex('glow'), color: 0xff6650, transparent: true,
      opacity: 0.48, depthWrite: false, fog: false,
    });
    for (const [tx, tz] of spots) {
      const beaconHalo = new THREE.Sprite(haloMat);
      beaconHalo.position.set(tx, BLOCK.HIGH + 2.12, tz);
      beaconHalo.scale.set(1.35, 1.35, 1);
      this.mapGroup.add(beaconHalo);
    }
    const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._tex('glow'), color: 0xbdd8ff, transparent: true,
      opacity: 0.3, depthWrite: false, fog: false,
    }));
    moonHalo.position.copy(moonPos);
    moonHalo.scale.set(9.5, 9.5, 1);
    this.mapGroup.add(moonHalo);

    // Estrellas deterministas para que el cielo tenga escala y no parpadee
    // entre cambios de mapa.
    let seed = 3907;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const starsPos = [];
    for (let i = 0; i < 110; i++) {
      const a = rnd() * Math.PI * 2, r = 105 + rnd() * 45;
      starsPos.push(Math.cos(a) * r, 20 + rnd() * 52, Math.sin(a) * r);
    }
    const starsGeo = new THREE.BufferGeometry();
    starsGeo.setAttribute('position', new THREE.Float32BufferAttribute(starsPos, 3));
    const stars = new THREE.Points(starsGeo, new THREE.PointsMaterial({
      color: 0xa9c8e8, size: 0.14, transparent: true, opacity: 0.72,
      sizeAttenuation: true, fog: false,
    }));
    this.mapGroup.add(stars);
  }

  _buildSpawns() {
    // fortaleza: spawns FIJOS en ±23.4 (el server los espeja); azoteas
    // escalada ×1.5 usa ±35.1 (solo bots/práctica — el server no la corre);
    // otros mapas, pegados al muro como siempre
    const z = this.layout === 'fortaleza' ? 23.4
      : this.layout === 'azoteas' ? 35.1
      : this.fz - 1.6;
    for (let i = 0; i < 4; i++) {
      const x = -3.6 + i * 2.4;
      // convención: facing = (-sin yaw, -cos yaw) → yaw π mira a +z, yaw 0 a -z
      this.spawns.red.push({ x, z: -z, yaw: Math.PI });   // miran hacia +z
      this.spawns.blue.push({ x: -x, z, yaw: 0 });        // miran hacia -z
    }
  }

  // ---------- física ----------

  // Raycast detallado exclusivo para impactos. Además de la distancia devuelve
  // la normal exterior y el material lógico de la superficie. Incluye suelo,
  // plataforma y rampas; el raycast de locomoción conserva su comportamiento.
  raycastHit(origin, dir, maxDist) {
    let best = null;
    const accept = (t, normal, surface, collider = null) => {
      if (!Number.isFinite(t) || t < 0.0001 || t > maxDist) return;
      if (!best || t < best.t) best = { t, normal, surface, collider };
    };

    const slabs = (axes, surface, collider) => {
      let near = -Infinity, far = Infinity;
      let nearN = null, farN = null;
      for (const a of axes) {
        if (Math.abs(a.d) < 1e-8) {
          if (a.o < a.lo || a.o > a.hi) return;
          continue;
        }
        let t1 = (a.lo - a.o) / a.d, t2 = (a.hi - a.o) / a.d;
        let n1 = a.nLo, n2 = a.nHi;
        if (t1 > t2) { [t1, t2] = [t2, t1]; [n1, n2] = [n2, n1]; }
        if (t1 > near) { near = t1; nearN = n1; }
        if (t2 < far) { far = t2; farN = n2; }
        if (near > far) return;
      }
      const outside = near >= 0.0001;
      accept(outside ? near : far, outside ? nearN : farN, surface, collider);
    };

    for (const c of this.colliders) {
      slabs([
        { o: origin.x, d: dir.x, lo: c.minx, hi: c.maxx,
          nLo: HIT_N.nx, nHi: HIT_N.px },
        { o: origin.y, d: dir.y, lo: -0.1, hi: c.h,
          nLo: HIT_N.ny, nHi: HIT_N.py },
        { o: origin.z, d: dir.z, lo: c.minz, hi: c.maxz,
          nLo: HIT_N.nz, nHi: HIT_N.pz },
      ], c.surface || 'concrete', c);
    }

    // Barandas y otros colliders delgados rotados: caja orientada completa,
    // incluidas tapas y extremos, para no dejar decals flotando en las esquinas.
    for (const c of this.segmentColliders) {
      const tx = c.b.x - c.a.x, tz = c.b.z - c.a.z;
      const len = Math.hypot(tx, tz);
      if (len < 0.001) continue;
      const ux = tx / len, uz = tz / len;
      const cx = (c.a.x + c.b.x) * 0.5, cz = (c.a.z + c.b.z) * 0.5;
      const ox = origin.x - cx, oz = origin.z - cz;
      slabs([
        { o: ox * ux + oz * uz, d: dir.x * ux + dir.z * uz, lo: -len * 0.5, hi: len * 0.5,
          nLo: { x: -ux, y: 0, z: -uz }, nHi: { x: ux, y: 0, z: uz } },
        { o: ox * c.n.x + oz * c.n.z, d: dir.x * c.n.x + dir.z * c.n.z, lo: -c.half, hi: c.half,
          nLo: { x: -c.n.x, y: 0, z: -c.n.z }, nHi: { x: c.n.x, y: 0, z: c.n.z } },
        { o: origin.y, d: dir.y, lo: -0.1, hi: c.h,
          nLo: HIT_N.ny, nHi: HIT_N.py },
      ], c.surface || 'metal', c);
    }

    const groundSurface = this.layout === 'fortaleza' ? 'stone' : 'concrete';
    const plane = (t, normal, surface, contains) => {
      if (!Number.isFinite(t) || t < 0.0001 || t > maxDist) return;
      const x = origin.x + dir.x * t, z = origin.z + dir.z * t;
      if (contains(x, z)) accept(t, normal, surface);
    };

    // Superficie superior del helipuerto y sus dos rampas inclinadas.
    for (const zone of this.surfaceZones) {
      if (zone.kind !== 'helipad') continue;
      if (dir.y < -1e-8) {
        const t = (zone.height - origin.y) / dir.y;
        plane(t, HIT_N.py, 'metal', (x, z) => {
          const ax = Math.abs(x), az = Math.abs(z);
          return ax <= zone.edge && az <= zone.edge && ax + az <= zone.diagonal;
        });
      }
      for (const sign of [-1, 1]) {
        const slope = zone.height * sign / zone.rampLength;
        const denom = dir.y + slope * dir.z;
        if (Math.abs(denom) < 1e-8) continue;
        const constant = zone.height * (1 + zone.edge / zone.rampLength);
        const t = (constant - origin.y - slope * origin.z) / denom;
        const il = 1 / Math.hypot(1, slope);
        const normal = { x: 0, y: il, z: slope * il };
        plane(t, normal, 'metal', (x, z) => {
          const sz = sign * z;
          return Math.abs(x) <= zone.rampHalfWidth && sz >= zone.edge && sz <= zone.edge + zone.rampLength;
        });
      }
    }

    // Piso base, deliberadamente limitado al área jugable.
    if (dir.y < -1e-8) {
      const t = -origin.y / dir.y;
      plane(t, HIT_N.py, groundSurface,
        (x, z) => Math.abs(x) <= this.fx + 0.05 && Math.abs(z) <= this.fz + 0.05);
    }
    return best;
  }

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
    for (const c of this.segmentColliders) {
      const denom = dir.x * c.n.x + dir.z * c.n.z;
      if (Math.abs(denom) < 1e-8) continue;
      const signed = (origin.x - c.a.x) * c.n.x + (origin.z - c.a.z) * c.n.z;
      const slab = c.half + inflate;
      for (const plane of [-slab, slab]) {
        const t = (plane - signed) / denom;
        if (t < 0 || t > maxDist || (best !== null && t >= best)) continue;
        const hy = origin.y + dir.y * t;
        if (hy < -0.1 - inflate || hy > c.h + inflate) continue;
        const hx = origin.x + dir.x * t, hz = origin.z + dir.z * t;
        const tx = c.b.x - c.a.x, tz = c.b.z - c.a.z;
        const len = Math.hypot(tx, tz);
        const along = ((hx - c.a.x) * tx + (hz - c.a.z) * tz) / len;
        if (along >= -inflate && along <= len + inflate) best = t;
      }
    }
    return best;
  }

  // Altura del "suelo" bajo el círculo: la caja más alta que quede a la
  // altura de los pies o debajo (permite pararse sobre coberturas).
  groundHeight(p, r, y) {
    let g = 0;
    for (const zone of this.surfaceZones) {
      if (zone.kind !== 'helipad') continue;
      const ax = Math.abs(p.x), az = Math.abs(p.z);
      const insideDeck = ax <= zone.edge && az <= zone.edge && ax + az <= zone.diagonal;
      let h = insideDeck ? zone.height : 0;
      // Rampas norte/sur: transición progresiva para jugadores y bots.
      if (ax <= zone.rampHalfWidth && az > zone.edge && az <= zone.edge + zone.rampLength) {
        h = Math.max(h, zone.height * (1 - (az - zone.edge) / zone.rampLength));
      }
      if (h > g) g = h;
    }
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
      for (const c of this.segmentColliders) {
        if (y >= c.h - 0.05) continue;
        const tx = c.b.x - c.a.x, tz = c.b.z - c.a.z;
        const len2 = tx * tx + tz * tz;
        const u = Math.max(0, Math.min(1,
          ((p.x - c.a.x) * tx + (p.z - c.a.z) * tz) / len2));
        const cx = c.a.x + tx * u, cz = c.a.z + tz * u;
        let dx = p.x - cx, dz = p.z - cz;
        const rr = r + c.half;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          dx /= d; dz /= d;
        } else {
          const signed = (p.x - c.a.x) * c.n.x + (p.z - c.a.z) * c.n.z;
          const side = signed >= 0 ? 1 : -1;
          dx = c.n.x * side; dz = c.n.z * side;
        }
        p.x = cx + dx * rr;
        p.z = cz + dz * rr;
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
