// Mapa competitivo "Foundry": simétrico por rotación de 180°, diseñado para
// wallbounce (bloques bajos escalonados a 2.5-4m), corredores CQC laterales,
// centro abierto de riesgo con pilar contestado, y bases rojo/azul en ±Z.
// También es el dueño de la física estática: AABBs, raycast, resolución de círculo
// y las caras de cobertura que consume el sistema de cover.
import * as THREE from 'three';
import { MAP_RUNTIME } from '../game/lobby-rules.js';
import { BLOCK } from './block-heights.js';
import { getMap, isCustomLayout, cratesOf, specialOf, spawnsOf, footprint, paletteById }
  from './map-data.js';
import { cloneUrbanAsset } from './urban-assets.js';
import { HELIPAD, collisionBoxesFor, helipadSegments } from './collision-layouts.js';

const FIELD_X = 15, FIELD_Z = 18; // semiancho / semilargo
const SOLDIER_HEIGHT = 1.63;
const STREET_SCALE = Object.freeze({
  soldier: SOLDIER_HEIGHT,
  door: 2.32,
  floor: 2.7,
  lamp: 6.2,
  car: Object.freeze({ width: 2.02, length: 4.58, height: 1.52, wheel: 0.41 }),
  truck: Object.freeze({ width: 2.4, length: 6.8, height: 2.9, wheel: 0.54 }),
  bus: Object.freeze({ width: 2.5, length: 9.0, height: 3.08, wheel: 0.55 }),
});

// REGLA DE DISEÑO (Chuck): solo existen TRES alturas de bloque/pared.
//   LOW  (1.1): saltable por encima; agachado, la cabeza NO sobresale (tope 1.02)
//   MID  (1.9): cubre al personaje DE PIE completo (cabeza ~1.63); no saltable
//   HIGH (3.0): inalcanzable incluso saltando; muros y estructuras
// Ninguna pieza de mapa puede usar otra altura.
export { BLOCK };
function buildSharedCollision(world, layout, styles) {
  for (const box of collisionBoxesFor(layout)) {
    const { x, z, w, d, h, style, ...options } = box;
    world._box(x, z, w, d, h, { ...(styles[style] || {}), ...options });
  }
}
const HIT_N = {
  nx: { x: -1, y: 0, z: 0 }, px: { x: 1, y: 0, z: 0 },
  ny: { x: 0, y: -1, z: 0 }, py: { x: 0, y: 1, z: 0 },
  nz: { x: 0, y: 0, z: -1 }, pz: { x: 0, y: 0, z: 1 },
};
const IMPACT_RAY = new THREE.Raycaster();
const IMPACT_DIR = new THREE.Vector3();
const IMPACT_WORLD = new THREE.Matrix4();
const IMPACT_INSTANCE = new THREE.Matrix4();
const IMPACT_NORMAL_MATRIX = new THREE.Matrix3();

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
  // force: el editor reconstruye el MISMO id tras cada cambio de datos
  setLayout(layout, force = false) {
    if (!force && this.layout === layout && this.mapGroup) return;
    this.layout = layout;
    if (this.mapGroup) {
      this.scene.remove(this.mapGroup);
      this.mapGroup.traverse((o) => {
        if (o.geometry && !o.geometry.userData.urbanAssetShared) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
            if (m.userData.urbanAssetShared) return;
            // las texturas del caché se comparten entre mapas: no tocarlas
            if (m.map && !m.map.userData.cached) m.map.dispose();
            m.dispose();
          });
        }
      });
    }
    this.mapGroup = new THREE.Group();
    this._baseDecorOrdinals = Object.create(null);
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
    // Mapas POR DATOS (editor): mismo pipeline que los escritos a mano — solo
    // cambia de dónde salen dims/tema/piezas. El "tema" reutiliza texturas,
    // piso y ambiente de un mapa existente.
    this.customMap = isCustomLayout(layout) ? getMap(layout) : null;
    const theme = this.customMap?.theme ?? layout;
    this.theme = theme;

    const dims = {
      arena: [11, 13], fortaleza: [21, 26.6], azoteas: [31.5, 40],
      calle: [17, 42], metro: [16, 26], prision: [22, 30], pueblo: [26, 34],
      foundry: [FIELD_X, FIELD_Z],
    };
    if (this.customMap) [this.fx, this.fz] = [this.customMap.fx, this.customMap.fz];
    else [this.fx, this.fz] = dims[layout] ?? dims.foundry;
    // texturas del batch por mapa (piedra, concreto, azulejo o ladrillo)
    this._batchTexIds = {
      azoteas: ['concrete', 'concreteTop'],
      calle: ['concrete', 'concreteTop'],
      metro: ['tile', 'tileTop'],
      prision: ['concrete', 'concreteTop'],
      pueblo: ['brick', 'brickTop'],
    }[theme] ?? ['stone', 'stoneTop'];
    // cajas de munición por mapa: en azoteas van sobre el eje del helipuerto,
    // libres de cover (las ±7,0 por defecto chocaban con el anillo)
    const runtime = MAP_RUNTIME[layout];
    const customCrates = this.customMap ? cratesOf(this.customMap) : null;
    this.cratePos = this.customMap
      ? (customCrates.length ? customCrates : null)
      : (runtime?.crates ?? null);
    // pedestal del arma ESPECIAL (sniper/bazooka alternando por ronda):
    // zona central de riesgo, equidistante de ambos spawns
    // Descentrado sobre el eje X (equidistante de ambos spawns, que están en
    // ±z): en el centro exacto todo el tráfico converge al mismo carril y la
    // escuadra se amontona. Azoteas es la excepción: su centro es el
    // helipuerto despejado, que ya es una zona de riesgo con rutas propias.
    this.specialSpot = this.customMap ? specialOf(this.customMap) : (runtime?.special ?? null);

    this._buildFloor();
    if (this.customMap) this._buildFromData(this.customMap);
    else this._runBuilder(layout);
    this._addMapPeriphery(theme);
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
    // el tema decide luz/cielo/niebla (un mapa de datos hereda el ambiente
    // completo del mapa en el que se inspira)
    this._applyEnvironment(theme);
    // El raycast visual de impactos trabaja con matrices estáticas ya
    // resueltas. La lista de receptores se reconstruye al cambiar de mapa.
    this.mapGroup.updateWorldMatrix(true, true);
    this._impactReceivers = null;
  }

  // Builder original de cada mapa hecho a mano. También lo corre
  // _buildFromData (con las cajas suprimidas) para la decoración de un clon.
  _runBuilder(layout) {
    if (layout === 'arena') this._buildArena();
    else if (layout === 'fortaleza') this._buildFortaleza();
    else if (layout === 'azoteas') this._buildAzoteas();
    else if (layout === 'calle') this._buildCalle();
    else if (layout === 'metro') this._buildMetro();
    else if (layout === 'prision') this._buildPrision();
    else if (layout === 'pueblo') this._buildPueblo();
    else this._buildMap();
  }

  // Radiografía de un mapa hecho a mano para el CLONADOR del editor:
  // reconstruye el layout capturando cada caja que su builder coloca (espejo
  // ya resuelto) y devuelve, además, spawns con orientación, cajas de
  // munición y pedestal especial con altura. El llamador queda en ese layout;
  // el editor hace setLayout del clon inmediatamente después.
  snapshotLayout(layout) {
    this._capture = [];
    this._captureDecor = [];
    try {
      this.setLayout(layout, true);
      return {
        fx: this.fx, fz: this.fz,
        boxes: this._capture.slice(),
        spawns: {
          red: this.spawns.red.map((s) => ({ ...s })),
          blue: this.spawns.blue.map((s) => ({ ...s })),
        },
        crates: (this.cratePos ?? []).map((c) => ({ ...c })),
        special: this.specialSpot ? { ...this.specialSpot } : null,
        decor: this._captureDecor.slice(),
      };
    } finally {
      this._capture = null;
      this._captureDecor = null;
    }
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
      asphalt: this._asphaltCanvas(),          // asfalto urbano (Calle)
      urbanBrick: this._urbanBrickCanvas('#70483d', '#ad7a64'),
      urbanBrickDark: this._urbanBrickCanvas('#443d3b', '#74645e'),
      shopShutter: this._shopShutterCanvas(),
      vehicleWear: this._vehicleWearCanvas(),
      vehicleGlass: this._vehicleGlassCanvas(),
      puddle: this._puddleCanvas(),
      tile: this._tileCanvas(false),           // azulejo de estación (Metro)
      tileTop: this._tileCanvas(true),
      brick: this._brickCanvas(false),         // ladrillo viejo (Pueblo)
      brickTop: this._brickCanvas(true),
      roofFloor: this._roofFloorCanvas(),      // grava/brea de azotea
      windows: this._windowsCanvas(),          // fachadas nocturnas iluminadas
      roofMark: this._roofMarkCanvas(),        // marca técnica del centro
      hazard: this._hazardCanvas(),            // franjas de seguridad
      billboard: this._billboardCanvas(),      // anuncio del skyline
      glow: this._glowCanvas(),                // halos sin luces dinámicas
    };
    this._texCache = new Map(); // compartidas por (canvas, repeat): pocas subidas a GPU
    // Mapas de altura derivados de las mismas texturas de color. Mantenerlos
    // procedurales evita sumar descargas pesadas y, sobre todo, conserva una
    // escala de detalle coherente entre piso, cover y fachadas. No se usa el
    // color directamente como bump: el contraste se comprime para que ladrillo,
    // juntas y agregado respondan a la luz sin parecer piedra tallada.
    this._detailCv = Object.fromEntries(Object.entries(this._cv)
      .filter(([, canvas]) => canvas?.width && canvas?.height)
      .map(([id, canvas]) => [id, this._surfaceDetailCanvas(canvas)]));
    this._detailTexCache = new Map();
  }

  _surfaceDetailCanvas(source) {
    const cv = document.createElement('canvas');
    cv.width = source.width; cv.height = source.height;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0);
    const image = g.getImageData(0, 0, cv.width, cv.height);
    const p = image.data;
    for (let i = 0; i < p.length; i += 4) {
      const luminance = p[i] * 0.2126 + p[i + 1] * 0.7152 + p[i + 2] * 0.0722;
      // El alpha de decals/sprites no debe convertirse en una meseta blanca.
      const value = p[i + 3] < 16 ? 128 : THREE.MathUtils.clamp(128 + (luminance - 128) * 0.72, 28, 228);
      p[i] = p[i + 1] = p[i + 2] = value;
      p[i + 3] = 255;
    }
    g.putImageData(image, 0, 0);
    return cv;
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

  // Asfalto: agregado fino y grietas — piso de Calle. Los antiguos parches
  // rectangulares se repetían con la textura y parecían cuadros negros sueltos.
  _asphaltCanvas() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#57544f'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 1100; i++) { // agregado
      const l = 28 + Math.random() * 22;
      g.fillStyle = `hsl(40, 3%, ${l}%)`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = 'rgba(24,22,20,0.55)'; g.lineWidth = 2; // grietas
    for (let i = 0; i < 4; i++) {
      let x = Math.random() * s, y = Math.random() * s;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (Math.random() - 0.5) * 60; y += 14 + Math.random() * 26;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    return cv;
  }

  // Ladrillo urbano de lectura media: menos repetición obvia que la textura
  // de ruina y con manchas verticales que venden décadas de lluvia/smog.
  _urbanBrickCanvas(base, light) {
    const s = 256, bh = 22, bw = 54, joint = 3;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#292728'; g.fillRect(0, 0, s, s);
    let row = 0;
    for (let y = 0; y < s; y += bh, row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < s + bw; x += bw) {
        const shade = 0.72 + Math.random() * 0.34;
        g.fillStyle = Math.random() < 0.18 ? light : base;
        g.globalAlpha = shade;
        g.fillRect(x + off + joint, y + joint, bw - joint * 2, bh - joint * 2);
        g.globalAlpha = 1;
        g.fillStyle = 'rgba(255,225,205,.09)';
        g.fillRect(x + off + joint, y + joint, bw - joint * 2, 2);
      }
    }
    for (let i = 0; i < 13; i++) {
      const x = Math.random() * s;
      const grd = g.createLinearGradient(x, 0, x + 10, 0);
      grd.addColorStop(0, 'rgba(12,15,18,0)');
      grd.addColorStop(0.5, `rgba(12,15,18,${0.08 + Math.random() * 0.13})`);
      grd.addColorStop(1, 'rgba(12,15,18,0)');
      g.fillStyle = grd; g.fillRect(x, 0, 10, 45 + Math.random() * 190);
    }
    return cv;
  }

  _shopShutterCanvas() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, s, s);
    grd.addColorStop(0, '#4d5050'); grd.addColorStop(1, '#252a2c');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    for (let y = 5; y < s; y += 13) {
      g.fillStyle = 'rgba(230,236,232,.10)'; g.fillRect(0, y, s, 2);
      g.fillStyle = 'rgba(0,0,0,.30)'; g.fillRect(0, y + 8, s, 3);
    }
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(105,58,39,${0.08 + Math.random() * 0.16})`;
      g.fillRect(Math.random() * s, Math.random() * s, 8 + Math.random() * 32, 3 + Math.random() * 12);
    }
    return cv;
  }

  // Desgaste de carrocería con lectura a media distancia. La base clara se
  // multiplica por el color del vehículo; suciedad, rayones y óxido rompen la
  // planitud sin convertir cada auto en una malla o material único.
  _vehicleWearCanvas() {
    const w = 256, h = 128;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#ddd9d1'; g.fillRect(0, 0, w, h);
    const grime = g.createLinearGradient(0, 0, 0, h);
    grime.addColorStop(0, 'rgba(38,34,30,0)');
    grime.addColorStop(0.62, 'rgba(38,34,30,.04)');
    grime.addColorStop(1, 'rgba(30,27,24,.28)');
    g.fillStyle = grime; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 42; i++) {
      const x = Math.random() * w, y = 14 + Math.random() * (h - 22);
      g.fillStyle = `rgba(91,52,37,${0.025 + Math.random() * 0.065})`;
      g.fillRect(x, y, 4 + Math.random() * 22, 1 + Math.random() * 4);
    }
    g.strokeStyle = 'rgba(230,225,214,.32)'; g.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * w, y = 20 + Math.random() * 80;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 10 + Math.random() * 28, y + (Math.random() - 0.5) * 7); g.stroke();
    }
    return cv;
  }

  // Vidrio de vehículo "como en la vida real" (pedido de Chuck): gradiente
  // de cielo reflejado (claro arriba, oscuro abajo), dos vetas diagonales de
  // reflejo y sello de goma perimetral. El material tiñe y añade especular.
  _vehicleGlassCanvas() {
    const w = 256, h = 128;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#5d7f91');
    sky.addColorStop(0.34, '#2c4b5b');
    sky.addColorStop(0.72, '#152b37');
    sky.addColorStop(1, '#0b1a23');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    // silueta tenue de la ciudad reflejada en la mitad inferior
    for (let i = 0; i < 9; i++) {
      const bw = 14 + Math.random() * 24;
      const bx = (i / 9) * w + Math.random() * 10;
      const bh = 22 + Math.random() * 34;
      g.fillStyle = `rgba(6,13,18,${0.35 + Math.random() * 0.25})`;
      g.fillRect(bx, h - bh, bw, bh);
    }
    // vetas diagonales de reflejo (la firma clásica del vidrio estilizado)
    const streak = (x0, width, alpha) => {
      g.fillStyle = `rgba(214,232,240,${alpha})`;
      g.beginPath();
      g.moveTo(x0, h); g.lineTo(x0 + h * 0.55, 0);
      g.lineTo(x0 + h * 0.55 + width, 0); g.lineTo(x0 + width, h);
      g.closePath(); g.fill();
    };
    streak(52, 26, 0.16);
    streak(96, 10, 0.11);
    streak(176, 16, 0.08);
    // sello de goma perimetral
    g.strokeStyle = 'rgba(4,8,11,.88)'; g.lineWidth = 7;
    g.strokeRect(1.5, 1.5, w - 3, h - 3);
    g.strokeStyle = 'rgba(150,180,195,.18)'; g.lineWidth = 2;
    g.strokeRect(7, 7, w - 14, h - 14);
    return cv;
  }

  _puddleCanvas() {
    const s = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, s, s);
    const grd = g.createRadialGradient(128, 130, 8, 128, 128, 118);
    grd.addColorStop(0, 'rgba(104,142,163,.42)');
    grd.addColorStop(0.66, 'rgba(63,87,104,.26)');
    grd.addColorStop(0.88, 'rgba(28,38,46,.10)');
    grd.addColorStop(1, 'rgba(20,26,30,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(20, 134); g.bezierCurveTo(24, 76, 74, 37, 132, 50);
    g.bezierCurveTo(197, 33, 244, 78, 234, 137);
    g.bezierCurveTo(249, 195, 188, 226, 129, 210);
    g.bezierCurveTo(70, 229, 14, 193, 20, 134); g.fill();
    g.strokeStyle = 'rgba(187,208,218,.22)'; g.lineWidth = 3; g.stroke();
    return cv;
  }

  // Azulejo de estación: retícula clara con lechada oscura y piezas
  // manchadas/rotas — muros y andenes del Metro.
  _tileCanvas(flat) {
    const s = 256, t = flat ? 64 : 32, j = 3;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#3f4448'; g.fillRect(0, 0, s, s); // lechada
    for (let y = 0; y < s; y += t) {
      for (let x = 0; x < s; x += t) {
        const stained = Math.random() < 0.12;
        const l = stained ? 42 + Math.random() * 10 : 66 + Math.random() * 8;
        g.fillStyle = `hsl(${185 + Math.random() * 14}, ${stained ? 6 : 10}%, ${l}%)`;
        g.fillRect(x + j, y + j, t - j * 2, t - j * 2);
        // brillo cerámico superior (borde nítido, sin blur)
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(x + j, y + j, t - j * 2, 3);
        if (Math.random() < 0.05) { // pieza descascarada
          g.fillStyle = '#33373a';
          g.fillRect(x + j + 4, y + t / 2, t / 2, t / 3);
        }
      }
    }
    return cv;
  }

  // Ladrillo viejo: hiladas alternadas con mortero claro y piezas caídas —
  // muros del Pueblo abandonado.
  _brickCanvas(flat) {
    const s = 256, bh = flat ? 42 : 30, bw = flat ? 84 : 62, j = 4;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    g.fillStyle = '#7d746a'; g.fillRect(0, 0, s, s); // mortero
    let row = 0;
    for (let y = 0; y < s; y += bh, row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < s + bw; x += bw) {
        const missing = Math.random() < 0.06;
        if (missing) { g.fillStyle = '#5c554d'; }
        else {
          const l = 38 + Math.random() * 14;
          g.fillStyle = `hsl(${16 + Math.random() * 10}, ${26 + Math.random() * 10}%, ${l}%)`;
        }
        g.fillRect(x + off + j, y + j, bw - j * 2, bh - j * 2);
        if (!missing) { // luz superior + sombra inferior = relieve nítido
          g.fillStyle = 'rgba(255,235,210,0.18)';
          g.fillRect(x + off + j, y + j, bw - j * 2, 3);
          g.fillStyle = 'rgba(30,20,14,0.28)';
          g.fillRect(x + off + j, y + bh - j - 3, bw - j * 2, 3);
        }
      }
    }
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
      t.anisotropy = 4;
      t.userData.cached = true; // el dispose de setLayout la respeta
      this._texCache.set(key, t);
    }
    return t;
  }

  _detailTex(id, rx = 1, ry = 1) {
    const source = this._detailCv[id];
    if (!source) return null;
    const key = id + ':' + rx.toFixed(2) + ':' + ry.toFixed(2);
    let t = this._detailTexCache.get(key);
    if (!t) {
      t = new THREE.CanvasTexture(source);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 4;
      t.userData.cached = true;
      this._detailTexCache.set(key, t);
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
    const build = (batch, texture, name) => {
      if (!batch.count) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(batch.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(batch.norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(batch.color, 3));
      g.setIndex(batch.idx);
      g.computeBoundingSphere();
      const surface = {
        stone: [0.88, 0.01, 0.040], stoneTop: [0.84, 0.01, 0.028],
        concrete: [0.80, 0.03, 0.026], concreteTop: [0.76, 0.03, 0.018],
        tile: [0.58, 0.08, 0.014], tileTop: [0.52, 0.08, 0.010],
        brick: [0.90, 0.01, 0.038], brickTop: [0.87, 0.01, 0.026],
      }[texture] ?? [0.82, 0.02, 0.022];
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        map: this._tex(texture),
        bumpMap: this._detailTex(texture),
        bumpScale: surface[2],
        roughness: surface[0],
        metalness: surface[1],
        vertexColors: true,
      }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = name; // identificable para tooling/tests (editor, clonador)
      this.mapGroup.add(mesh);
    };
    build(this._boxBatch.sides, this._batchTexIds[0], 'box-batch-sides');
    build(this._boxBatch.tops, this._batchTexIds[1], 'box-batch-tops');
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
    } else if (layout === 'calle') {
      // Noche húmeda legible: ambiente azul y fuentes prácticas cálidas. La
      // luna conserva siluetas claras; el mapa no depende de luces dinámicas.
      this.hemi.color.setHex(0x7894b4);
      this.hemi.groundColor.setHex(0x253039);
      this.hemi.intensity = 1.52;
      this.amb.color.setHex(0x8295a9);
      this.amb.intensity = 0.62;
      this.sun.color.setHex(0xb7cee5);
      this.sun.intensity = 1.72;
      this.sun.position.set(-18, 22, 7);
      this._setSky([
        [0, '#09111c'], [0.48, '#17283a'], [0.80, '#344b60'], [1, '#69545a'],
      ]);
      this.scene.fog = new THREE.Fog(0x182531, 45, 112);
    } else if (layout === 'metro') {
      // Subterráneo: sin cielo real (negro de túnel), luz artificial fría
      // pareja con un acento verdoso de fluorescente.
      this.hemi.color.setHex(0xbfd2d8);
      this.hemi.groundColor.setHex(0x2b2f31);
      this.hemi.intensity = 1.5;
      this.amb.color.setHex(0xcfe6d8);
      this.amb.intensity = 0.4;
      this.sun.color.setHex(0xe8f2ee); // batería de lámparas del techo
      this.sun.intensity = 1.7;
      this.sun.position.set(4, 30, -2);
      this._setSky([
        [0, '#040506'], [0.7, '#0a0d0f'], [1, '#131a1c'],
      ]);
      // el "techo" es oscuridad: niebla corta y densa vende el túnel
      this.scene.fog = new THREE.Fog(0x0a0d0f, 34, 92);
    } else if (layout === 'prision') {
      // Mediodía crudo: luz dura y gris, sin romanticismo.
      this.hemi.color.setHex(0xd3dade);
      this.hemi.groundColor.setHex(0x777b7d);
      this.hemi.intensity = 1.5;
      this.amb.color.setHex(0xe8ecee);
      this.amb.intensity = 0.22;
      this.sun.color.setHex(0xf3f6f2);
      this.sun.intensity = 2.35;
      this.sun.position.set(9, 26, -6);
      this._setSky([
        [0, '#7c93a4'], [0.6, '#a9b8c0'], [1, '#cfd6d4'],
      ]);
      this.scene.fog = new THREE.Fog(0x9aa6ab, 55, 130);
    } else if (layout === 'pueblo') {
      // Tarde nublada cálida: luz ámbar suave sobre ladrillo y polvo.
      this.hemi.color.setHex(0xc9c2b4);
      this.hemi.groundColor.setHex(0x8a7156);
      this.hemi.intensity = 1.42;
      this.amb.color.setHex(0xffe2b8);
      this.amb.intensity = 0.3;
      this.sun.color.setHex(0xffd9a0);
      this.sun.intensity = 1.95;
      this.sun.position.set(-16, 18, 12);
      this._setSky([
        [0, '#8e9aa4'], [0.5, '#bcb6a6'], [0.85, '#d8c091'], [1, '#e5cf9d'],
      ]);
      this.scene.fog = new THREE.Fog(0xb5ad98, 52, 132);
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
    // piso por TEMA: [textura, escala de repetición, tinte]
    const [texId, cell, tint] = {
      azoteas: ['roofFloor', 4.2, 0xcdd0d4],   // grava/brea de techo urbano
      fortaleza: ['floor', 2.6, 0xc3b79f],     // losas de arenisca
      calle: ['asphalt', 3.6, 0xc4c4c4],       // asfalto de avenida
      metro: ['tileTop', 3.2, 0xb9c2c6],       // andén de azulejo
      prision: ['concreteTop', 3.4, 0xb4b6b8], // patio de concreto
      pueblo: ['floor', 2.6, 0xd0bd97],        // tierra/empedrado cálido
    }[this.theme ?? this.layout] ?? ['floor', 2.6, 0xffffff];
    const tex = this._tex(texId, this.fx * 2 / cell, this.fz * 2 / cell);
    const floorSurface = {
      azoteas: [0.86, 0.03, 0.024], fortaleza: [0.84, 0.01, 0.036],
      calle: [0.46, 0.08, 0.022], metro: [0.56, 0.07, 0.012],
      prision: [0.78, 0.03, 0.022], pueblo: [0.91, 0.01, 0.040],
    }[this.theme ?? this.layout] ?? [0.84, 0.01, 0.030];
    const floorMat = new THREE.MeshStandardMaterial({
      map: tex,
      bumpMap: this._detailTex(texId, this.fx * 2 / cell, this.fz * 2 / cell),
      bumpScale: floorSurface[2],
      color: tint,
      roughness: floorSurface[0],
      metalness: floorSurface[1],
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(this.fx * 2, this.fz * 2), floorMat);
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
    surface = null, decorLink = null,
  } = {}) {
    const place = (px, pz) => {
      // CLONADO DE MAPAS: place() es el embudo por el que pasa cada caja de
      // cada builder (el espejo ya está resuelto aquí). _capture registra la
      // caja exacta como datos; _suppressBoxes deja correr el builder solo
      // por su decoración (fachadas, GLBs, helipuerto) sin crear las cajas —
      // las del clon, ya como datos editables, ocupan su lugar.
      if (this._capture) this._capture.push({ x: px, z: pz, w, d, h, color, top, cover, visual, surface, decorLink });
      if (this._suppressBoxes) return;
      // variación sutil de tono por caja: rompe la monotonía sin romper la paleta
      const jit = 0.95 + Math.random() * 0.1;
      const c = new THREE.Color(color).multiplyScalar(jit).getHex();
      const t = new THREE.Color(top).multiplyScalar(jit).getHex();
      if (visual) this._batchBox(px, pz, w, d, h, c, t);
      const minx = px - w / 2, maxx = px + w / 2, minz = pz - d / 2, maxz = pz + d / 2;
      const material = surface ||
        ((this.theme ?? this.layout) === 'fortaleza' || (this.theme ?? this.layout) === 'pueblo' ? 'stone' : 'concrete');
      const collider = { minx, minz, maxx, maxz, h, surface: material };
      this.colliders.push(collider);
      if (cover) {
        const kind = h <= BLOCK.LOW ? 'low' : h <= BLOCK.MID ? 'medium' : 'high';
        this.faces.push(
          { n: { x: 1, z: 0 }, a: { x: maxx, z: minz }, b: { x: maxx, z: maxz }, h, topY: h, kind, collider },
          { n: { x: -1, z: 0 }, a: { x: minx, z: minz }, b: { x: minx, z: maxz }, h, topY: h, kind, collider },
          { n: { x: 0, z: 1 }, a: { x: minx, z: maxz }, b: { x: maxx, z: maxz }, h, topY: h, kind, collider },
          { n: { x: 0, z: -1 }, a: { x: minx, z: minz }, b: { x: maxx, z: minz }, h, topY: h, kind, collider },
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

  // ---------------------------------------------------------------------
  // MAPAS POR DATOS (editor). Construye con las MISMAS primitivas que los
  // mapas escritos a mano: _box genera colisión, cover y batch igual que
  // siempre, así que un mapa del editor es un mapa de producción.
  // ---------------------------------------------------------------------
  _buildFromData(map) {
    const { LOW, MID, HIGH } = BLOCK;
    // paleta tonal del tema (misma jerarquía: tapa clara = jugable)
    const tone = {
      fortaleza: [0x968b79, 0xcbbd9f, 0x81786b, 0xb5a790, 0x817970, 0xa69b89],
      azoteas: [0x8b9096, 0xb9bfc4, 0x7d838a, 0xa7adb3, 0x6f757c, 0x939aa1],
      calle: [0x8f8c86, 0xb8b4ab, 0x7d7a74, 0xa9a59c, 0x8b857c, 0xa39d92],
      metro: [0x7f8a8d, 0xa5adaf, 0x74807f, 0x9aa5a2, 0x5e696e, 0x7d878a],
      prision: [0x8e9092, 0xb2b4b4, 0x7f8285, 0xa2a5a6, 0x74777b, 0x92959a],
      pueblo: [0x9a8672, 0xc4ac8c, 0x8d7a66, 0xb59d7f, 0x86735f, 0xa89075],
    }[map.theme] ?? [0x9c968c, 0xc6c1b5, 0x81786b, 0xb5a790, 0x969188, 0xaba69d];
    const opts = (h) => (h <= LOW ? { color: tone[0], top: tone[1] }
      : h <= MID ? { color: tone[2], top: tone[3] }
      : { color: tone[4], top: tone[5] });

    // CLON de un mapa hecho a mano: correr su builder ORIGINAL con las cajas
    // suprimidas. Toda la decoración se genera intacta (fachadas, GLBs,
    // instancias, helipuerto con sus barandales y zonas transitables) y las
    // cajas jugables — capturadas como datos al clonar — toman su lugar.
    const decorOn = Boolean(map.base) && map.decor !== false;
    const editableDecor = map.objects.some((o) => o.baseDecor);
    if (decorOn) {
      this._suppressBoxes = true;
      this._suppressEditableDecor = editableDecor;
      try { this._runBuilder(map.base); }
      finally {
        this._suppressBoxes = false;
        this._suppressEditableDecor = false;
      }
      this._applyBaseDecorTransforms(map);
    }

    // límites del mapa: perímetro cerrado (mismo patrón que todos los mapas)
    if (map.walls !== false) {
      const wallOpts = { mirror: false, color: tone[4], top: tone[5] };
      this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
      this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
      this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
      this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    }

    for (const o of map.objects) {
      const piece = paletteById(o.p);
      if (!piece) continue;
      if (piece.t === 'box') {
        const fp = footprint(o);
        const h = o.h ?? piece.h;
        // Los campos explícitos del clon mandan (color exacto, colliders
        // invisibles bajo fachadas, material de impacto). Sin decoración de
        // base, las cajas invisibles SÍ se dibujan: son la única geometría.
        this._box(o.x, o.z, fp.w, fp.d, h, {
          mirror: false,
          cover: o.cover ?? (piece.cover !== false),
          visual: decorOn ? (o.visual ?? true) : true,
          surface: o.surface ?? null,
          ...opts(h),
          ...(o.color != null ? { color: o.color } : null),
          ...(o.top != null ? { top: o.top } : null),
        });
      } else if (piece.t === 'prop') {
        if (map.decor === false) continue;
        this._dataProp(o, piece, tone);
      } else if (piece.t === 'urban') {
        if (map.decor === false) continue;
        // misma biblioteca GLB que usa Calle en vivo; sin colisión propia
        // (igual que en el mapa real: la colisión son cajas visual:false)
        this._addUrbanAsset(piece.assetId, o.x, o.z, {
          y: o.y ?? 0, scale: o.scale ?? 1, rotation: (o.rot ?? 0) * Math.PI / 180,
        });
      } else if (piece.t === 'street') {
        if (map.decor === false) continue;
        const rot = (o.rot ?? 0) * Math.PI / 180;
        let model = null;
        if (piece.assetKind === 'vehicle') {
          model = this._addStreetVehicle(o.x, o.z, rot, o.color ?? 0x53616b, o.variant ?? 0);
        } else if (piece.assetKind === 'truck') {
          model = this._addStreetTruck(o.x, o.z, rot, o.color ?? 0x6d5a48, o.variant ?? 0);
        } else if (piece.assetKind === 'bus') {
          model = this._addStreetBus(o.x, o.z, rot, o.variant ?? 0);
        }
        if (model?.isObject3D && o.scale && o.scale !== 1) model.scale.setScalar(o.scale);
      }
      // spawn/crate/special son marcadores: los consume el juego, no la
      // escena. charRef es una herramienta del editor: la dibuja el editor.
    }
  }

  // Props decorativos del editor: SIN colisión (no alteran cover ni rutas).
  // Usan las mismas texturas del tema para no romper el universo visual.
  _dataProp(o, piece, tone) {
    const h = o.h ?? piece.h, w = o.w ?? piece.w, d = o.d ?? piece.d;
    const texId = this._batchTexIds[0];
    const propColor = {
      hvac: 0x687887, tank: 0x68735f, vehicle: 0x3f4b56,
      barricade: 0x8b6746, column: 0x6f7478, crateProp: 0x75604b,
    }[piece.id] ?? tone[2];
    const mat = new THREE.MeshLambertMaterial({
      color: propColor, map: this._tex(texId, Math.max(1, w / 2), Math.max(1, h / 2)),
    });
    const dark = new THREE.MeshLambertMaterial({ color: 0x222b32 });
    const accent = new THREE.MeshLambertMaterial({ color: 0xc47a3c });
    const group = new THREE.Group();
    const geo = piece.kind === 'cyl'
      ? new THREE.CylinderGeometry(w / 2, w / 2, h, 10)
      : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 28),
      new THREE.LineBasicMaterial({ color: 0x20272d, transparent: true, opacity: 0.72 }),
    );
    outline.position.y = h / 2; group.add(outline);

    const box = (bw, bh, bd, x, y, z, material = dark, rz = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), material);
      m.position.set(x, y, z); m.rotation.z = rz; m.castShadow = true; group.add(m); return m;
    };
    const cyl = (r, ch, x, y, z, material = dark, sides = 10) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, ch, sides), material);
      m.position.set(x, y, z); m.castShadow = true; group.add(m); return m;
    };
    if (piece.id === 'hvac') {
      cyl(Math.min(w, d) * 0.28, 0.09, 0, h + 0.045, 0, dark, 14);
      for (const x of [-w * 0.28, 0, w * 0.28]) box(0.045, h * 0.55, d + 0.018, x, h * 0.48, 0, dark);
      box(w * 0.42, 0.08, d + 0.035, 0, h * 0.23, 0, accent);
    } else if (piece.id === 'tank') {
      for (const y of [h * 0.28, h * 0.7]) cyl(w * 0.52, 0.07, 0, y, 0, dark, 12);
      cyl(w * 0.16, 0.16, 0, h + 0.08, 0, accent, 10);
    } else if (piece.id === 'vehicle') {
      mesh.scale.y = 0.58; mesh.position.y = h * 0.29;
      outline.scale.y = 0.58; outline.position.y = h * 0.29;
      box(w * 0.78, h * 0.48, d * 0.44, 0, h * 0.68, -d * 0.06, mat);
      for (const x of [-w * 0.51, w * 0.51]) for (const z of [-d * 0.3, d * 0.3]) {
        const wheel = cyl(h * 0.22, 0.14, x, h * 0.22, z, dark, 10);
        wheel.rotation.z = Math.PI / 2;
      }
      box(w * 0.54, 0.07, d + 0.04, 0, h * 0.43, 0, accent);
    } else if (piece.id === 'barricade') {
      box(w * 0.9, 0.1, d + 0.04, 0, h * 0.68, 0, accent, 0.32);
      box(w * 0.9, 0.1, d + 0.04, 0, h * 0.68, 0, dark, -0.32);
      box(w * 0.9, 0.1, d + 0.05, 0, h * 0.22, 0, dark);
    } else if (piece.id === 'column') {
      cyl(w * 0.62, 0.12, 0, 0.06, 0, dark, 12);
      cyl(w * 0.62, 0.12, 0, h - 0.06, 0, accent, 12);
    } else if (piece.id === 'crateProp') {
      box(w + 0.03, 0.08, d + 0.04, 0, h * 0.5, 0, accent);
      box(0.08, h + 0.03, d + 0.04, 0, h * 0.5, 0, dark);
    }
    group.position.set(o.x, 0, o.z);
    group.rotation.y = (o.rot ?? 0) * Math.PI / 180;
    this.mapGroup.add(group);
  }

  // ---------------------------------------------------------------------
  // Utilidades de ambientación. Estas piezas son deliberadamente VISUALES:
  // los AABB que gobiernan cover, navegación y disparos siguen siendo los
  // de _box. Así se puede convertir un bloque en un auto, vagón o ruina sin
  // introducir una esquina invisible o una ruta que los bots no conozcan.
  // ---------------------------------------------------------------------
  _addMapSign(text, x, y, z, ry = 0, {
    w = 2.4, h = 0.5, bg = '#16232d', fg = '#eaf2f0', border = '#6d8b9b',
    parent = this.mapGroup, style = null, subtitle = null,
  } = {}) {
    const upper = text.toUpperCase();
    const resolvedStyle = style ?? (
      upper.includes('PLATFORM') || upper === 'EXIT' ? 'transit'
        : upper.includes('CELL BLOCK') || upper === 'YARD' ? 'institutional'
          : upper.includes('ROOFTOP') ? 'industrial'
            : upper === 'NEWS' ? 'news'
              : upper.includes('HOT DOG') ? 'food'
                : upper === 'COFFEE' ? 'cafe'
                  : (this.theme ?? this.layout) === 'pueblo' ? 'heritage'
                    : 'utility'
    );
    const signStyles = {
      transit: { font: '"Arial Narrow", "Roboto Condensed", sans-serif', label: 'CITY TRANSIT', icon: 'arrow' },
      institutional: { font: 'monospace', label: 'AUTHORIZED PERSONNEL', icon: 'bars' },
      industrial: { font: '"Arial Black", sans-serif', label: 'MAINTENANCE DECK', icon: 'hazard' },
      heritage: { font: 'Georgia, serif', label: 'OLD DISTRICT', icon: 'diamond' },
      news: { font: 'Georgia, serif', label: 'DAILY PRESS', icon: 'paper' },
      food: { font: '"Arial Black", sans-serif', label: 'STREET FOOD', icon: 'stripe' },
      cafe: { font: 'Georgia, serif', label: 'FRESH BREW', icon: 'cup' },
      utility: { font: '"Arial Narrow", sans-serif', label: 'BREACH DISTRICT', icon: 'line' },
    };
    const visual = signStyles[resolvedStyle] ?? signStyles.utility;
    const smallLabel = subtitle ?? visual.label;
    const cv = document.createElement('canvas');
    cv.width = 768; cv.height = 192;
    const g = cv.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, cv.width, cv.height);
    // Ligero gradiente/desgaste: evita la placa de color plano sin destruir la
    // lectura a distancia ni depender de una textura externa.
    const shade = g.createLinearGradient(0, 0, cv.width, cv.height);
    shade.addColorStop(0, 'rgba(255,255,255,.10)');
    shade.addColorStop(0.48, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(0,0,0,.22)');
    g.fillStyle = shade; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = border; g.lineWidth = resolvedStyle === 'heritage' ? 13 : 9;
    g.strokeRect(7, 7, cv.width - 14, cv.height - 14);

    g.fillStyle = border; g.strokeStyle = border; g.lineWidth = 8;
    if (visual.icon === 'arrow') {
      g.beginPath(); g.moveTo(38, 95); g.lineTo(112, 95); g.lineTo(91, 72);
      g.moveTo(112, 95); g.lineTo(91, 118); g.stroke();
    } else if (visual.icon === 'bars') {
      for (let px = 36; px <= 112; px += 19) g.fillRect(px, 43, 8, 102);
    } else if (visual.icon === 'hazard' || visual.icon === 'stripe') {
      for (let px = 28; px < 128; px += 28) {
        g.beginPath(); g.moveTo(px, 148); g.lineTo(px + 17, 148); g.lineTo(px + 52, 44);
        g.lineTo(px + 35, 44); g.closePath(); g.fill();
      }
    } else if (visual.icon === 'diamond') {
      g.save(); g.translate(76, 96); g.rotate(Math.PI / 4);
      g.strokeRect(-31, -31, 62, 62); g.strokeRect(-18, -18, 36, 36); g.restore();
    } else if (visual.icon === 'paper') {
      g.strokeRect(38, 39, 76, 112);
      for (const py of [66, 88, 110, 132]) g.fillRect(51, py, 49, 5);
    } else if (visual.icon === 'cup') {
      g.strokeRect(40, 75, 65, 48); g.beginPath(); g.arc(108, 97, 17, -Math.PI / 2, Math.PI / 2); g.stroke();
      for (const sx of [56, 76, 96]) { g.beginPath(); g.moveTo(sx, 65); g.quadraticCurveTo(sx - 7, 48, sx, 35); g.stroke(); }
    } else {
      g.fillRect(35, 89, 90, 8); g.fillRect(76, 49, 8, 88);
    }

    const textLeft = 146;
    g.fillStyle = fg;
    let fontSize = resolvedStyle === 'heritage' || resolvedStyle === 'news' || resolvedStyle === 'cafe' ? 66 : 62;
    do {
      g.font = `700 ${fontSize}px ${visual.font}`;
      if (g.measureText(text).width <= cv.width - textLeft - 38) break;
      fontSize -= 2;
    } while (fontSize > 35);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(text, textLeft, 91);
    g.fillStyle = border;
    g.font = `700 20px ${visual.font}`;
    g.letterSpacing = '3px';
    g.fillText(smallLabel, textLeft + 2, 142);
    g.letterSpacing = '0px';
    g.fillRect(textLeft, 153, cv.width - textLeft - 36, 4);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const group = new THREE.Group();
    group.name = `map-sign:${resolvedStyle}:${text}`;
    group.position.set(x, y, z); group.rotation.y = ry;
    const backing = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.065),
      new THREE.MeshStandardMaterial({ color: 0x202428, metalness: 0.58, roughness: 0.46 }),
    );
    backing.castShadow = true; group.add(backing);
    const nightSign = ['calle', 'azoteas', 'metro'].includes(this.theme ?? this.layout);
    const frontMat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: nightSign ? tex : null,
      emissive: nightSign ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
      emissiveIntensity: nightSign ? 0.18 : 0,
      roughness: 0.46, metalness: 0.08, side: THREE.FrontSide,
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, h), frontMat);
    sign.position.z = 0.035; sign.renderOrder = 5; group.add(sign);
    parent.add(group);
    return group;
  }

  // Rótulos propios de Calle Cerrada. Conservan una paleta nocturna común,
  // pero cada rubro cambia forma, jerarquía, acento e iconografía. El marco
  // tiene profundidad real y el frente siempre mira hacia la calle, por lo que
  // el texto no puede aparecer espejado ni confundirse con una textura plana.
  _addStreetShopSign(text, style, x, y, z, ry = 0, {
    w = 3.2, h = 0.56, parent = this.mapGroup,
  } = {}) {
    const themes = {
      pharmacy:   { bg: '#173f40', edge: '#77b9aa', fg: '#f3e7cb', accent: '#e5ad60', shape: 'round', font: 'Trebuchet MS', tag: 'PRESCRIPTIONS · WELLNESS' },
      bakery:     { bg: '#5c302d', edge: '#d19a6c', fg: '#f4dfbc', accent: '#e7bc7b', shape: 'arch', font: 'Georgia', tag: 'BREAD · PASTRIES · DAILY' },
      garage:     { bg: '#20262a', edge: '#c56f3d', fg: '#f0d7ae', accent: '#dd7740', shape: 'cut', font: 'Arial Black', tag: 'SERVICE · PARTS · REPAIR' },
      electronics:{ bg: '#152d3b', edge: '#65a9bd', fg: '#d9edf0', accent: '#69c8d9', shape: 'tech', font: 'Trebuchet MS', tag: 'AUDIO · VIDEO · REPAIRS' },
      hardware:   { bg: '#43372e', edge: '#a68a66', fg: '#eee0c8', accent: '#d09a57', shape: 'plate', font: 'Arial Black', tag: 'TOOLS · SUPPLIES · KEYS' },
      barber:     { bg: '#26343d', edge: '#c6d0ce', fg: '#f2e9d7', accent: '#bc594d', shape: 'stripe', font: 'Georgia', tag: 'CUTS · SHAVES · SINCE 1987' },
      laundry:    { bg: '#21414b', edge: '#74aeb8', fg: '#e1eff0', accent: '#8fc9d2', shape: 'bubble', font: 'Trebuchet MS', tag: 'WASH · DRY · FOLD' },
      stationery: { bg: '#3d493b', edge: '#b6a66f', fg: '#f0e6c6', accent: '#d4bd72', shape: 'paper', font: 'Georgia', tag: 'PRINT · COPY · PAPER' },
      market:     { bg: '#59342d', edge: '#c88c63', fg: '#f2ddbb', accent: '#e2a55f', shape: 'awning', font: 'Arial Black', tag: 'GROCERY · PRODUCE · DELI' },
      cafe:       { bg: '#3d2c27', edge: '#b78d68', fg: '#f1dfc6', accent: '#d3a16d', shape: 'cafe', font: 'Georgia', tag: 'COFFEE · BAKED GOODS' },
    };
    const t = themes[style] ?? themes.market;
    const cv = document.createElement('canvas');
    cv.width = 768; cv.height = 192;
    const g = cv.getContext('2d');
    const roundedRect = (px, py, pw, ph, r) => {
      g.beginPath();
      g.moveTo(px + r, py); g.lineTo(px + pw - r, py); g.quadraticCurveTo(px + pw, py, px + pw, py + r);
      g.lineTo(px + pw, py + ph - r); g.quadraticCurveTo(px + pw, py + ph, px + pw - r, py + ph);
      g.lineTo(px + r, py + ph); g.quadraticCurveTo(px, py + ph, px, py + ph - r);
      g.lineTo(px, py + r); g.quadraticCurveTo(px, py, px + r, py); g.closePath();
    };

    g.clearRect(0, 0, cv.width, cv.height);
    if (t.shape === 'cut') {
      g.beginPath(); g.moveTo(34, 14); g.lineTo(734, 14); g.lineTo(754, 34);
      g.lineTo(734, 178); g.lineTo(34, 178); g.lineTo(14, 158); g.lineTo(14, 34); g.closePath();
    } else if (t.shape === 'arch') {
      g.beginPath(); g.moveTo(18, 176); g.lineTo(18, 62); g.quadraticCurveTo(18, 14, 70, 14);
      g.lineTo(698, 14); g.quadraticCurveTo(750, 14, 750, 62); g.lineTo(750, 176); g.closePath();
    } else {
      roundedRect(14, 14, 740, 164, t.shape === 'round' || t.shape === 'bubble' || t.shape === 'cafe' ? 30 : 12);
    }
    g.fillStyle = t.bg; g.fill();
    g.strokeStyle = t.edge; g.lineWidth = 8; g.stroke();

    // Detalles gráficos simples pero reconocibles a distancia.
    g.fillStyle = t.accent; g.strokeStyle = t.accent; g.lineWidth = 7;
    if (t.shape === 'bubble') {
      for (const [cx, cy, r] of [[66, 92, 25], [103, 61, 13], [112, 116, 17]]) {
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      }
    } else if (t.shape === 'tech') {
      g.beginPath(); g.moveTo(38, 55); g.lineTo(92, 55); g.lineTo(112, 76); g.lineTo(112, 126);
      g.moveTo(38, 137); g.lineTo(76, 137); g.lineTo(96, 117); g.stroke();
      for (const [cx, cy] of [[38, 55], [38, 137], [112, 76], [96, 117]]) {
        g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
      }
    } else if (t.shape === 'plate') {
      for (const [cx, cy] of [[42, 42], [726, 42], [42, 150], [726, 150]]) {
        g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill();
      }
    } else if (t.shape === 'stripe') {
      g.save(); roundedRect(24, 24, 96, 144, 12); g.clip();
      let stripeIndex = 0;
      for (let i = -80; i < 180; i += 42, stripeIndex++) {
        g.fillStyle = stripeIndex % 2 ? '#d9ded9' : t.accent;
        g.beginPath(); g.moveTo(18, i); g.lineTo(58, i); g.lineTo(126, i + 68); g.lineTo(86, i + 68); g.closePath(); g.fill();
      }
      g.restore();
    } else if (t.shape === 'paper') {
      g.fillRect(38, 44, 72, 106); g.fillStyle = t.bg;
      for (const py of [70, 94, 118]) g.fillRect(53, py, 42, 5);
    } else if (t.shape === 'awning') {
      for (let i = 0; i < 7; i++) g.fillRect(28 + i * 31, 22, 18, 30);
    } else if (t.shape === 'cafe') {
      g.strokeRect(40, 67, 64, 58); g.beginPath(); g.arc(108, 92, 18, -Math.PI / 2, Math.PI / 2); g.stroke();
      for (const sx of [55, 76, 97]) { g.beginPath(); g.moveTo(sx, 54); g.quadraticCurveTo(sx - 8, 38, sx, 28); g.stroke(); }
    } else if (t.shape === 'round') {
      roundedRect(38, 65, 78, 58, 29); g.stroke(); g.beginPath(); g.moveTo(77, 67); g.lineTo(77, 121); g.stroke();
    } else if (t.shape === 'arch') {
      g.beginPath(); g.moveTo(40, 142); g.quadraticCurveTo(78, 58, 116, 142); g.stroke();
      g.beginPath(); g.moveTo(53, 142); g.quadraticCurveTo(78, 88, 103, 142); g.stroke();
    } else {
      for (const px of [38, 66, 94]) g.fillRect(px, 42, 15, 108);
    }

    const hasIcon = ['bubble', 'tech', 'stripe', 'paper', 'cafe', 'round', 'arch'].includes(t.shape);
    const textLeft = hasIcon ? 146 : 52;
    const textRight = 728;
    let fontSize = 64;
    do {
      g.font = `700 ${fontSize}px "${t.font}", "Arial Narrow", sans-serif`;
      if (g.measureText(text).width <= textRight - textLeft) break;
      fontSize -= 2;
    } while (fontSize > 38);
    g.fillStyle = t.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, (textLeft + textRight) / 2, 88);
    g.fillStyle = t.accent;
    g.font = `700 18px "${t.font}", sans-serif`;
    g.fillText(t.tag, (textLeft + textRight) / 2, 141);
    g.fillRect(textLeft, 158, textRight - textLeft, 5);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const group = new THREE.Group(); group.position.set(x, y, z); group.rotation.y = ry;
    const backing = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.10, h + 0.10, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x202529, metalness: 0.55, roughness: 0.42 }),
    );
    backing.castShadow = true; group.add(backing);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.18,
        roughness: 0.42, metalness: 0.08, side: THREE.FrontSide,
        transparent: true, alphaTest: 0.02,
      }),
    );
    sign.position.z = 0.046; sign.renderOrder = 5; group.add(sign);
    parent.add(group);
    return group;
  }

  // Registra una piel procedural que corresponde a un collider editable.
  // La clave estable (tipo + ordinal) permite reconstruir el builder base y
  // aplicar después la transformación guardada por el editor.
  _registerBaseDecor(group, kind, data) {
    const ordinal = this._baseDecorOrdinals[kind] ?? 0;
    this._baseDecorOrdinals[kind] = ordinal + 1;
    const key = `${kind}:${ordinal}`;
    group.userData.editorDecorKey = key;
    if (this._captureDecor) this._captureDecor.push({ kind, key, ...data });
    this.mapGroup.add(group);
    return group;
  }

  _applyBaseDecorTransforms(map) {
    const templates = new Map();
    for (const child of this.mapGroup.children) {
      const key = child.userData?.editorDecorKey;
      if (!key) continue;
      templates.set(key, child);
      child.visible = false;
    }
    const uses = new Map();
    for (const o of map.objects) {
      if (paletteById(o.p)?.t !== 'baseDecor' || !o.decorKey) continue;
      const template = templates.get(o.decorKey);
      if (!template) continue;
      const count = uses.get(o.decorKey) ?? 0;
      const group = count === 0 ? template : template.clone(true);
      uses.set(o.decorKey, count + 1);
      if (count > 0) this.mapGroup.add(group);
      group.visible = map.decor !== false;
      group.position.set(o.x, o.y ?? 0, o.z);
      group.rotation.y = (o.rot ?? 0) * Math.PI / 180;
      group.scale.setScalar(o.scale ?? 1);
    }
  }

  // Extruye un perfil lateral (z/y) a lo ancho del vehículo. Permite capós,
  // parabrisas y techos inclinados sin depender de una pila de cubos.
  _addVehicleProfile(group, profile, width, material, bevel = 0.035) {
    const shape = new THREE.Shape();
    shape.moveTo(profile[0][0], profile[0][1]);
    for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1]);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: width,
      steps: 1,
      bevelEnabled: bevel > 0,
      bevelSegments: 1,
      bevelSize: bevel,
      bevelThickness: bevel,
    });
    // Shape.x es longitud local Z; extrusion.z pasa a ancho local X.
    geo.rotateY(-Math.PI / 2);
    geo.translate(width / 2, 0, 0);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
    return mesh;
  }

  _addStreetVehicle(x, z, rot = 0, color = 0x53616b, variant = 0) {
    if (this._captureDecor) this._captureDecor.push({
      kind: 'vehicle', x, z, rotation: rot, color, variant,
      w: STREET_SCALE.car.width, d: STREET_SCALE.car.length, h: STREET_SCALE.car.height,
    });
    if (this._suppressEditableDecor) return true;
    const bodyMat = new THREE.MeshStandardMaterial({
      color, map: this._tex('vehicleWear', 1.6, 1),
      bumpMap: this._detailTex('vehicleWear', 1.6, 1), bumpScale: 0.007,
      metalness: 0.46, roughness: 0.46,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x0b151b, metalness: 0.42, roughness: 0.22,
      emissive: 0x020507, emissiveIntensity: 0.16, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const glassHighlightMat = new THREE.MeshBasicMaterial({
      color: 0x526c77, transparent: true, opacity: 0.16, side: THREE.DoubleSide,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x030405, metalness: 0.02, roughness: 0.92 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x626a70, metalness: 0.66, roughness: 0.36 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x202326, metalness: 0.48, roughness: 0.48 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd6a0 });
    const rearLampMat = new THREE.MeshBasicMaterial({ color: 0xa52e26 });
    const frameMat = trimMat.clone();
    frameMat.side = THREE.DoubleSide;
    frameMat.polygonOffset = true;
    frameMat.polygonOffsetFactor = -2;
    frameMat.polygonOffsetUnits = -2;
    const seamMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.48), metalness: 0.28, roughness: 0.58,
    });
    const group = new THREE.Group();
    group.position.set(x, 0, z); group.rotation.y = rot;
    const add = (w, h, d, px, py, pz, mat, rx = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(px, py, pz); m.rotation.x = rx; m.rotation.z = rz;
      m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
    };
    const S = STREET_SCALE.car;
    this._addVehicleProfile(group, [
      [-S.length / 2, 0.22], [-S.length / 2, 0.75], [-S.length * 0.42, 0.91],
      [-S.length * 0.21, 1.00], [-S.length * 0.10, S.height], [S.length * 0.17, S.height],
      [S.length * 0.27, 1.00], [S.length * 0.42, 1.00], [S.length / 2, 0.83], [S.length / 2, 0.22],
    ], S.width, bodyMat, 0.045);
    // Los marcos y cristales laterales usan los mismos polígonos base. El
    // marco es una silueta ligeramente mayor y el vidrio una versión inset,
    // evitando bordes aproximados hechos con cajas inclinadas.
    const sidePanel = (side, pts, mat, offset, order = 1) => {
      const x = side * (S.width / 2 + offset);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(([zv, yv]) => [x, yv, zv]), 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]); geo.computeVertexNormals();
      const p = new THREE.Mesh(geo, mat); p.renderOrder = order; group.add(p); return p;
    };
    for (const side of [-1, 1]) {
      const skinX = side * (S.width / 2 + 0.050);
      sidePanel(side, [
        [-S.length * 0.20, 1.00], [-S.length * 0.10, S.height],
        [S.length * 0.018, S.height], [S.length * 0.018, 1.00],
      ], frameMat, 0.046);
      sidePanel(side, [
        [-S.length * 0.193, 1.025], [-S.length * 0.094, S.height - 0.025],
        [S.length * 0.012, S.height - 0.025], [S.length * 0.012, 1.025],
      ], glassMat, 0.048, 2);
      sidePanel(side, [
        [S.length * 0.020, 1.00], [S.length * 0.020, S.height],
        [S.length * 0.17, S.height], [S.length * 0.25, 1.00],
      ], frameMat, 0.046);
      sidePanel(side, [
        [S.length * 0.026, 1.025], [S.length * 0.026, S.height - 0.025],
        [S.length * 0.164, S.height - 0.025], [S.length * 0.243, 1.025],
      ], glassMat, 0.048, 2);
      // Solo la junta central separa ambas puertas. Es fina y tonal; los
      // contornos exteriores anteriores endurecían la silueta innecesariamente.
      add(0.010, 0.72, 0.006, skinX, 0.64, S.length * 0.019, seamMat);
    }
    // Parabrisas frontal y vidrio trasero. Son superficies trapezoidales
    // completas, no cajas inclinadas: así quedan por fuera de la carrocería y
    // se leen correctamente desde los extremos del auto.
    const endPanel = (pts, mat, order = 2, zOffset = 0) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(
        pts.flatMap(([px, py, pz]) => [px, py, pz + zOffset]), 3,
      ));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      const panel = new THREE.Mesh(geo, mat);
      panel.renderOrder = order;
      group.add(panel);
      return panel;
    };
    // Cada extremo usa un trapecio negro exterior y otro trapecio inset de
    // vidrio con las mismas pendientes. Ambos se separan físicamente de la
    // carrocería: el bevel del perfil podía taparlos desde los extremos aunque
    // el material siguiera existiendo, haciendo parecer que el auto no tenía
    // parabrisas ni medallón.
    endPanel([
      [-S.width * 0.442, 1.035, -S.length * 0.21], [S.width * 0.442, 1.035, -S.length * 0.21],
      [S.width * 0.42, S.height, -S.length * 0.105], [-S.width * 0.42, S.height, -S.length * 0.105],
    ], frameMat, 3, -0.032);
    endPanel([
      [-S.width * 0.425, 1.06, -S.length * 0.205], [S.width * 0.425, 1.06, -S.length * 0.205],
      [S.width * 0.402, S.height - 0.025, -S.length * 0.11], [-S.width * 0.402, S.height - 0.025, -S.length * 0.11],
    ], glassMat, 4, -0.046);
    endPanel([
      [-S.width * 0.42, S.height, S.length * 0.19], [S.width * 0.42, S.height, S.length * 0.19],
      [S.width * 0.442, 1.035, S.length * 0.265], [-S.width * 0.442, 1.035, S.length * 0.265],
    ], frameMat, 3, 0.032);
    endPanel([
      [-S.width * 0.402, S.height - 0.025, S.length * 0.195], [S.width * 0.402, S.height - 0.025, S.length * 0.195],
      [S.width * 0.425, 1.06, S.length * 0.26], [-S.width * 0.425, 1.06, S.length * 0.26],
    ], glassMat, 4, 0.046);
    // Distancia entre ejes cercana a un sedán compacto real: alrededor del
    // 59% del largo total, no ruedas pegadas a los parachoques.
    for (const sx of [-S.width / 2 - 0.015, S.width / 2 + 0.015]) for (const sz of [-S.length * 0.301, S.length * 0.301]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(S.wheel, S.wheel, 0.17, 16), tireMat);
      wheel.rotation.z = Math.PI / 2; wheel.position.set(sx, S.wheel, sz); group.add(wheel);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.165, 12), hubMat);
      hub.rotation.z = Math.PI / 2; hub.position.set(sx * 1.004, S.wheel, sz); group.add(hub);
    }
    add(S.width + 0.04, 0.13, 0.14, 0, 0.34, -S.length / 2 - 0.02, trimMat);
    add(S.width + 0.04, 0.13, 0.14, 0, 0.34, S.length / 2 + 0.02, trimMat);
    add(0.84, 0.17, 0.04, 0, 0.53, -S.length / 2 - 0.09, trimMat); // parrilla
    for (const sx of [-S.width * 0.325, S.width * 0.325]) {
      add(0.36, 0.19, 0.030, sx, 0.64, -S.length / 2 - 0.050, trimMat);
      add(0.30, 0.14, 0.035, sx, 0.64, -S.length / 2 - 0.070, lampMat);
      add(0.35, 0.19, 0.030, sx, 0.69, S.length / 2 + 0.050, trimMat);
      add(0.29, 0.14, 0.035, sx, 0.69, S.length / 2 + 0.070, rearLampMat);
    }
    // Manijas, espejos y líneas de puerta: detalles de reconocimiento que se
    // leen durante gameplay sin subir la densidad del modelo completo.
    for (const side of [-1, 1]) {
      for (const pz of [-S.length * 0.022, S.length * 0.20]) {
        add(0.028, 0.030, 0.17, side * (S.width / 2 + 0.060), 0.86, pz, trimMat);
      }
      // Retrovisor montado en la esquina inferior del pilar A, no flotando a
      // media altura sobre el cristal delantero.
      add(0.05, 0.08, 0.10, side * (S.width / 2 + 0.070), 1.01, -S.length * 0.185, trimMat);
      add(0.15, 0.12, 0.21, side * (S.width / 2 + 0.14), 1.06, -S.length * 0.195, trimMat);
    }
    // La variación de daño permanece pegada a la carrocería: las puertas
    // separadas y los toros de guardafango producían siluetas tipo espina.
    if (variant === 1) {
      const crack = new THREE.Mesh(
        new THREE.PlaneGeometry(0.40, 0.40),
        new THREE.MeshBasicMaterial({
          map: this._tex('crack'), color: 0xaebfc6, transparent: true,
          alphaTest: 0.08, side: THREE.DoubleSide,
        }),
      );
      crack.position.set(-0.34, 1.27, -S.length * 0.14); crack.rotation.x = 0.68; group.add(crack);
    }
    if (variant === 2) add(0.48, 0.012, 0.72, 0.40, S.height + 0.007, 0.30, trimMat);
    this.mapGroup.add(group);
    return group;
  }

  _addStreetTruck(x, z, rot = 0, color = 0x6d5a48, variant = 0) {
    if (this._captureDecor) this._captureDecor.push({
      kind: 'truck', x, z, rotation: rot, color, variant,
      w: STREET_SCALE.truck.width, d: STREET_SCALE.truck.length, h: 3.0,
    });
    if (this._suppressEditableDecor) return true;
    const cabColor = new THREE.Color(color).lerp(new THREE.Color(0x52646b), 0.38);
    const cargoMat = new THREE.MeshStandardMaterial({
      color, map: this._tex('vehicleWear', 2.4, 1),
      bumpMap: this._detailTex('vehicleWear', 2.4, 1), bumpScale: 0.010,
      metalness: 0.30, roughness: 0.64,
    });
    const cabMat = new THREE.MeshStandardMaterial({
      color: cabColor, map: this._tex('vehicleWear', 1.2, 1),
      bumpMap: this._detailTex('vehicleWear', 1.2, 1), bumpScale: 0.007,
      metalness: 0.42, roughness: 0.48,
    });
    const cabInsetMat = new THREE.MeshStandardMaterial({
      color: cabColor.clone().multiplyScalar(0.78), metalness: 0.38, roughness: 0.54,
    });
    // Vidrio real: refleja el cielo (gradiente), lleva vetas de reflejo y
    // sello de goma; el mismo mapa emite tenue para que el reflejo se LEA
    // de noche (los StandardMaterial puros se apagaban con esta luz).
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9db4c2, map: this._tex('vehicleGlass', 1, 1),
      metalness: 0.60, roughness: 0.12,
      emissive: 0x9db8c8, emissiveIntensity: 0.34,
      emissiveMap: this._tex('vehicleGlass', 1, 1), side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x030405, metalness: 0.01, roughness: 0.94 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x687177, metalness: 0.67, roughness: 0.34 });
    const stripeMat = new THREE.MeshBasicMaterial({ color: variant ? 0xb34d3f : 0xd7903e });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x202427, metalness: 0.6, roughness: 0.42 });
    const seamMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.42), metalness: 0.28, roughness: 0.60,
    });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd7a2 });
    const rearLampMat = new THREE.MeshBasicMaterial({ color: 0xb72f27 });
    const group = new THREE.Group();
    group.position.set(x, 0, z); group.rotation.y = rot;
    const add = (w, h, d, px, py, pz, mat, rx = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(px, py, pz); m.rotation.x = rx; m.rotation.z = rz;
      m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
    };
    const S = STREET_SCALE.truck;
    const panel = (pts, mat, order = 2) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
      // UV planar (horizontal dominante × altura): los vidrios con textura
      // necesitan coordenadas — sin esto el mapa de reflejo no se aplica
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), zs = pts.map((p) => p[2]);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanZ = Math.max(...zs) - Math.min(...zs);
      const horiz = spanX >= spanZ ? xs : zs;
      const h0 = Math.min(...horiz), hr = (Math.max(...horiz) - h0) || 1;
      const y0 = Math.min(...ys), yr = (Math.max(...ys) - y0) || 1;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(
        pts.flatMap((p, i) => [(horiz[i] - h0) / hr, (p[1] - y0) / yr]), 2));
      const indices = [];
      for (let i = 1; i < pts.length - 1; i++) indices.push(0, i, i + 1);
      geo.setIndex(indices); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = order;
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };
    const sidePanel = (side, pts, mat, offset = 0.068, order = 3) => {
      const mapped = pts.map(([pz, py]) => [side * (S.width / 2 + offset), py, pz]);
      if (side < 0) mapped.reverse();
      return panel(mapped, mat, order);
    };

    // Misma huella táctica, pero la caja recibe esquinas superiores suaves y
    // la cabina cab-over gana una línea de techo/ventanas de escala humana.
    this._addVehicleProfile(group, [
      [-1.28, 0.28], [-1.28, 2.72], [-1.18, 2.82], [3.30, 2.82],
      [3.40, 2.72], [3.40, 0.28],
    ], S.width, cargoMat, 0.035);
    // El quiebre del morro baja a 1.14 (antes 1.52): el plano inclinado del
    // frente es GRANDE, como un cab-over real — el parabrisas lo cubre casi
    // entero (queja de Chuck: el vidrio delantero se veía como una ranura).
    this._addVehicleProfile(group, [
      [-S.length / 2, 0.24], [-S.length / 2, 1.14], [-3.22, 2.15],
      [-2.94, 2.46], [-1.62, 2.46], [-1.28, 2.14], [-1.28, 0.24],
    ], S.width - 0.04, cabMat, 0.045);

    // Parabrisas a lo alto del morro inclinado. El marco y el vidrio
    // comparten trapecio, como en los sedanes, y no flotan como planos.
    panel([
      [-1.10, 1.20, -3.535], [-1.00, 2.24, -3.225],
      [1.00, 2.24, -3.225], [1.10, 1.20, -3.535],
    ], trimMat, 3);
    panel([
      [-1.03, 1.27, -3.545], [-0.93, 2.17, -3.235],
      [0.93, 2.17, -3.235], [1.03, 1.27, -3.545],
    ], glassMat, 4);
    for (const wx of [-0.52, 0.5]) {
      add(0.035, 0.74, 0.025, wx, 1.60, -3.45, trimMat, -0.29);
    }

    for (const side of [-1, 1]) {
      const skinX = side * (S.width / 2 + 0.068);
      // Marco y ventana lateral trapezoidales; la puerta queda definida por
      // juntas finas sobre la propia cabina, nunca por una caja que tape vidrio.
      sidePanel(side, [
        [-3.22, 1.16], [-2.93, 2.37], [-1.70, 2.37], [-1.43, 1.16],
      ], trimMat, 0.064, 3);
      sidePanel(side, [
        [-3.13, 1.27], [-2.86, 2.27], [-1.77, 2.27], [-1.51, 1.27],
      ], glassMat, 0.070, 4);
      add(0.016, 1.86, 0.018, skinX, 1.16, -1.48, seamMat);
      add(0.016, 0.018, 1.58, skinX, 0.34, -2.25, seamMat);
      add(0.026, 0.040, 0.25, skinX + side * 0.010, 1.08, -1.66, trimMat);
      // Retrovisor anclado al pilar A con carcasa negra de proporción útil.
      add(0.26, 0.035, 0.035, side * (S.width / 2 + 0.18), 1.90, -3.03, trimMat);
      add(0.13, 0.26, 0.17, side * (S.width / 2 + 0.28), 1.82, -3.03, trimMat);
      for (const dz of [-2.42, 2.22]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(S.wheel, S.wheel, 0.18, 14), tireMat);
        wheel.rotation.z = Math.PI / 2; wheel.position.set(side * (S.width / 2 + 0.035), S.wheel, dz); group.add(wheel);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.19, 14), hubMat);
        hub.rotation.z = Math.PI / 2; hub.position.set(side * (S.width / 2 + 0.045), S.wheel, dz); group.add(hub);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.205, 12), trimMat);
        cap.rotation.z = Math.PI / 2; cap.position.set(side * (S.width / 2 + 0.052), S.wheel, dz); group.add(cap);
      }
      // Caja de carga: nervaduras casi al ras, tres paneles coherentes y una
      // única banda de servicio. Ya no parece una colección de barrotes.
      add(0.025, 0.15, 3.70, side * (S.width / 2 + 0.060), 1.62, 0.88, stripeMat);
      for (const pz of [-0.08, 1.06, 2.20]) {
        add(0.020, 1.78, 0.018, side * (S.width / 2 + 0.062), 1.48, pz, seamMat);
        add(0.024, 0.025, 0.92, side * (S.width / 2 + 0.064), 0.62, pz + 0.45, seamMat);
      }
    }
    add(S.width + 0.10, 0.12, 4.68, 0, 2.88, 1.06, trimMat);
    add(S.width - 0.28, 0.20, 5.86, 0, 0.26, 0.25, trimMat); // chasis continuo
    add(S.width + 0.025, 2.40, 0.060, 0, 1.50, -1.245, seamMat); // separación cabina/carga
    for (const sx of [-0.42, 0.42]) {
      const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.10, 0.12, 8), stripeMat);
      beacon.position.set(sx, 2.57, -2.05); group.add(beacon);
    }
    // Identidad de flota y función narrativa. Las placas están sobre la caja
    // visual, no añaden volumen jugable ni cambian la huella del camión.
    for (const side of [-1, 1]) {
      this._addMapSign('CITY WORKS', side * (S.width / 2 + 0.086), 2.10, 0.82,
        side > 0 ? Math.PI / 2 : -Math.PI / 2, {
          w: 2.55, h: 0.40, parent: group, style: 'industrial',
          subtitle: variant ? 'EMERGENCY RESPONSE' : 'UTILITY SERVICES',
          bg: variant ? '#4a2927' : '#24383d', fg: '#eadcc3', border: variant ? '#c56d4a' : '#6f9ca0',
        });
    }
    // Frente completo: fascia, parrilla, bumper, faros y placa bien separados.
    add(1.34, 0.34, 0.055, 0, 0.64, -S.length / 2 - 0.055, trimMat);
    add(S.width + 0.10, 0.18, 0.16, 0, 0.31, -S.length / 2 - 0.075, trimMat);
    add(0.44, 0.12, 0.032, 0, 0.40, -S.length / 2 - 0.165, cabInsetMat);
    for (const sx of [-0.80, 0.80]) {
      add(0.34, 0.22, 0.060, sx, 0.86, -S.length / 2 - 0.070, lampMat);
      add(0.16, 0.11, 0.065, sx, 0.58, -S.length / 2 - 0.075, stripeMat);
    }
    for (let gx = -0.45; gx <= 0.45; gx += 0.15) {
      add(0.035, 0.27, 0.026, gx, 0.65, -S.length / 2 - 0.092, hubMat);
    }
    // Portones traseros con paneles, bisagras, cierre y luces verticales.
    add(S.width - 0.14, 2.38, 0.050, 0, 1.52, S.length / 2 + 0.035, cargoMat);
    add(0.030, 2.22, 0.060, 0, 1.50, S.length / 2 + 0.070, seamMat);
    for (const sx of [-0.84, 0.84]) {
      add(0.08, 1.90, 0.065, sx, 1.52, S.length / 2 + 0.075, seamMat);
      for (const y of [0.82, 2.20]) add(0.16, 0.09, 0.070, sx, y, S.length / 2 + 0.080, trimMat);
      add(0.15, 0.38, 0.075, sx, 0.67, S.length / 2 + 0.085, rearLampMat);
    }
    add(S.width + 0.10, 0.18, 0.16, 0, 0.32, S.length / 2 + 0.090, trimMat);
    this.mapGroup.add(group);
    return group;
  }

  _addStreetBus(x, z, rot = 0, variant = 0) {
    if (this._captureDecor) this._captureDecor.push({
      kind: 'bus', x, z, rotation: rot, variant,
      w: STREET_SCALE.bus.width, d: STREET_SCALE.bus.length, h: STREET_SCALE.bus.height,
    });
    if (this._suppressEditableDecor) return true;
    const bodyColor = variant ? 0x7f4638 : 0xa45c43;
    const body = new THREE.MeshStandardMaterial({
      color: bodyColor, map: this._tex('vehicleWear', 3.2, 1),
      bumpMap: this._detailTex('vehicleWear', 3.2, 1), bumpScale: 0.008,
      metalness: 0.36, roughness: 0.50,
    });
    const bodyInset = new THREE.MeshStandardMaterial({
      color: variant ? 0x6d3d34 : 0x8d4f3e, metalness: 0.38, roughness: 0.54,
    });
    const lower = new THREE.MeshStandardMaterial({ color: 0x242a2f, metalness: 0.50, roughness: 0.44 });
    // Vidrio real (mismo lenguaje que el camión): gradiente de cielo, vetas
    // de reflejo y goma perimetral por VENTANA (cada cristal lleva su UV);
    // el mapa emite tenue para leerse de noche.
    const glass = new THREE.MeshStandardMaterial({
      color: 0x9db4c2, map: this._tex('vehicleGlass', 1, 1),
      metalness: 0.60, roughness: 0.12,
      emissive: 0x9db8c8, emissiveIntensity: 0.34,
      emissiveMap: this._tex('vehicleGlass', 1, 1), side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const tire = new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.94 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x737b80, metalness: 0.68, roughness: 0.32 });
    const trim = new THREE.MeshStandardMaterial({ color: variant ? 0xc1784c : 0xd0a05e, metalness: 0.50, roughness: 0.36 });
    const lamp = new THREE.MeshBasicMaterial({ color: 0xffd7a5 });
    const rearLamp = new THREE.MeshBasicMaterial({ color: 0xc53228 });
    const group = new THREE.Group(); group.position.set(x, 0, z); group.rotation.y = rot;
    const add = (w, h, d, px, py, pz, mat, rx = 0, rz = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(px, py, pz); mesh.rotation.x = rx; mesh.rotation.z = rz;
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };
    const S = STREET_SCALE.bus;
    const panel = (pts, mat, order = 2) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
      // UV planar (horizontal dominante × altura) para el vidrio con textura
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), zs = pts.map((p) => p[2]);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanZ = Math.max(...zs) - Math.min(...zs);
      const horiz = spanX >= spanZ ? xs : zs;
      const h0 = Math.min(...horiz), hr = (Math.max(...horiz) - h0) || 1;
      const y0 = Math.min(...ys), yr = (Math.max(...ys) - y0) || 1;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(
        pts.flatMap((p, i) => [(horiz[i] - h0) / hr, (p[1] - y0) / yr]), 2));
      const indices = [];
      for (let i = 1; i < pts.length - 1; i++) indices.push(0, i, i + 1);
      geo.setIndex(indices); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = order;
      mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); return mesh;
    };
    const sidePanel = (side, pts, mat, offset = 0.078, order = 3) => {
      const mapped = pts.map(([pz, py]) => [side * (S.width / 2 + offset), py, pz]);
      if (side < 0) mapped.reverse();
      return panel(mapped, mat, order);
    };

    // Coach urbano: frente inclinado, techo continuo y trasera recortada. La
    // huella sigue siendo exactamente la del collider existente.
    this._addVehicleProfile(group, [
      [-4.50, 0.22], [-4.50, 1.14], [-4.40, 1.60], [-4.14, 2.50],
      [-3.82, 2.92], [-3.52, S.height], [3.96, S.height],
      [4.28, 2.94], [4.50, 2.64], [4.50, 0.22],
    ], S.width, body, 0.055);

    // Parabrisas grande realmente apoyado sobre la pendiente del morro. Marco
    // y vidrio comparten trapecio, evitando el rectángulo que sobresalía.
    panel([
      [-1.12, 1.20, -4.645], [-0.98, 2.76, -4.170],
      [0.98, 2.76, -4.170], [1.12, 1.20, -4.645],
    ], lower, 3);
    panel([
      [-1.05, 1.28, -4.653], [-0.91, 2.68, -4.181],
      [0.91, 2.68, -4.181], [1.05, 1.28, -4.653],
    ], glass, 4);
    add(0.042, 1.39, 0.026, 0, 1.98, -4.468, lower, -0.34);
    add(1.50, 0.20, 0.055, 0, 0.70, -4.55, lower);
    add(S.width + 0.08, 0.18, 0.16, 0, 0.31, -4.57, lower);
    add(0.48, 0.12, 0.040, 0, 0.40, -4.665, bodyInset);
    for (const sx of [-0.78, 0.78]) {
      add(0.36, 0.18, 0.060, sx, 0.80, -4.59, lamp);
      add(0.14, 0.09, 0.062, sx, 0.55, -4.60, trim);
    }
    this._addMapSign(variant ? 'EVAC 07' : 'EVAC 14', 0, 2.88, -4.015, Math.PI, {
      w: 1.42, h: 0.24, parent: group, style: 'transit',
      subtitle: variant ? 'NORTH DISTRICT' : 'CENTRAL DISTRICT',
      bg: '#121a1d', fg: '#ffd37a', border: '#816c3d',
    });
    // Parrilla inferior y número de flota: pequeños detalles funcionales que
    // dan escala al frente sin convertirlo en una colección de cubos.
    for (let gx = -0.44; gx <= 0.44; gx += 0.145) {
      add(0.026, 0.19, 0.025, gx, 0.70, -4.625, lower);
    }

    // Luneta posterior con marco propio, fascia y pilotos verticales.
    add(2.18, 1.02, 0.058, 0, 2.30, 4.535, lower);
    add(2.02, 0.88, 0.062, 0, 2.30, 4.548, glass);
    add(1.22, 0.20, 0.055, 0, 0.72, 4.55, bodyInset);
    for (const sx of [-1.02, 1.02]) {
      add(0.16, 0.54, 0.060, sx, 0.91, 4.56, rearLamp);
      add(0.13, 0.10, 0.062, sx, 0.55, 4.57, lamp);
    }

    const serviceSide = 1;
    const frontWheelZ = -2.66;
    const rearWheelZ = 2.92;
    const wheelR = S.wheel;
    const passengerWindows = [
      [-3.18, -2.18], [-2.06, -1.06], [-0.94, 0.06],
      [0.18, 1.18], [1.30, 2.30], [2.42, 3.42], [3.54, 4.18],
    ];
    for (const side of [-1, 1]) {
      const skinX = side * (S.width / 2 + 0.084);

      // Ventana triangular de cabina y banda de pasajeros continua. En el lado
      // de servicio, la ventana delantera pertenece a la propia puerta y se
      // construye más abajo dentro de su marco para evitar el efecto de vidrio
      // pegado sobre la carrocería.
      if (side !== serviceSide) {
        sidePanel(side, [
          [-4.28, 1.32], [-3.52, 1.50], [-3.52, 2.74],
          [-3.86, 2.88], [-4.12, 2.50],
        ], glass);
      }
      // Cristales individuales: la carrocería visible entre ellos forma pilares
      // reales y rompe la antigua franja negra continua de aspecto provisional.
      for (const [a, b] of passengerWindows) {
        sidePanel(side, [
          [a, 1.74], [a, 2.73], [b, 2.73], [b, 1.74],
        ], glass, 0.087, 4);
      }
      add(0.042, 0.075, 7.55, side * (S.width / 2 + 0.099), 1.68, 0.28, trim);
      add(0.040, 0.055, 7.55, side * (S.width / 2 + 0.098), 2.79, 0.28, lower);

      // Bodegas de equipaje entre los ejes: paneles anchos y bajos, no barras.
      for (const pz of [-1.72, -0.54, 0.64, 1.82]) {
        add(0.042, 0.73, 1.08, side * (S.width / 2 + 0.088), 1.00, pz, bodyInset);
        add(0.046, 0.025, 1.02, side * (S.width / 2 + 0.103), 0.66, pz, lower);
      }
      add(0.042, 0.66, 0.72, side * (S.width / 2 + 0.088), 0.96, 3.84, bodyInset);

      // Puerta de acceso integrada, solo del lado de servicio y delante del eje.
      // La carrocería sigue visible debajo: sólo cambian el panel inferior,
      // vidrio y juntas, sin una gran placa negra superpuesta.
      if (side === serviceSide) {
        const doorZ = -3.80;
        const doorWidth = 1.00;
        sidePanel(side, [
          [-4.30, 0.25], [-3.28, 0.25], [-3.28, 1.08], [-4.30, 1.08],
        ], bodyInset, 0.084, 4);
        sidePanel(side, [
          [-4.20, 1.16], [-3.36, 1.16], [-3.36, 2.42],
          [-3.76, 2.68], [-4.05, 2.40],
        ], glass, 0.088, 5);
        add(0.016, 2.34, 0.018, side * (S.width / 2 + 0.100), 1.42, -3.29, lower);
        add(0.016, 2.22, 0.018, side * (S.width / 2 + 0.100), 1.37, -4.29, lower);
        add(0.016, 0.018, doorWidth - 0.07, side * (S.width / 2 + 0.100), 0.27, doorZ, lower);
        add(0.020, 2.15, 0.018, side * (S.width / 2 + 0.101), 1.37, -3.79, lower);
        add(0.022, 0.060, doorWidth - 0.08, side * (S.width / 2 + 0.108), 1.63, doorZ, trim);
        add(0.034, 0.052, 0.17, side * (S.width / 2 + 0.108), 0.91, -3.39, lower);
      }

      for (const pz of [frontWheelZ, rearWheelZ]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, 0.23, 20), tire);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * (S.width / 2 + 0.075), wheelR, pz); group.add(wheel);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.25, 18), hubMat);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(side * (S.width / 2 + 0.092), wheelR, pz); group.add(hub);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.27, 14), lower);
        cap.rotation.z = Math.PI / 2;
        cap.position.set(side * (S.width / 2 + 0.106), wheelR, pz); group.add(cap);
      }
    }

    // Rocker, parachoques, marcadores y climatización completan la lectura.
    add(S.width + 0.04, 0.16, S.length - 0.26, 0, 0.30, 0, lower);
    add(S.width + 0.08, 0.18, 0.16, 0, 0.31, 4.56, lower);
    for (const side of [-1, 1]) for (const pz of [-2.05, 0.30, 2.50]) {
      add(0.020, 0.08, 0.14, side * (S.width / 2 + 0.105), 1.48, pz, trim);
    }
    for (let gy = 1.28; gy <= 1.84; gy += 0.14) {
      add(1.05, 0.026, 0.025, 0, gy, 4.578, lower);
    }
    add(1.30, 0.18, 1.04, 0, S.height + 0.15, 0.70, lower);
    add(0.88, 0.10, 0.70, 0, S.height + 0.10, -1.35, lower);

    // Espejos altos de coach; los brazos quedan fuera del parabrisas.
    for (const sx of [-S.width / 2 - 0.14, S.width / 2 + 0.14]) {
      add(0.32, 0.035, 0.035, sx, 2.64, -4.03, lower);
      add(0.12, 0.34, 0.16, sx * 1.01, 2.48, -4.04, lower);
    }
    for (const sx of [-0.43, 0.43]) {
      add(0.030, 0.52, 0.030, sx, 1.84, -4.54, lower, 0.25, sx > 0 ? 0.45 : -0.45);
    }
    if (variant) {
      const cracked = new THREE.Mesh(
        new THREE.PlaneGeometry(0.52, 0.52),
        new THREE.MeshBasicMaterial({
          map: this._tex('crack'), color: 0xb9cad0, transparent: true,
          alphaTest: 0.08, side: THREE.DoubleSide,
        }),
      );
      cracked.position.set(0.48, 2.14, -4.43); cracked.rotation.x = 0.27; group.add(cracked);
    }
    this.mapGroup.add(group);
    return group;
  }

  _addTransitCar(x, z, w, d, { color = 0x526a73, stripe = 0xe4a24d, rot = 0, road = false } = {}) {
    const shell = new THREE.MeshStandardMaterial({
      color, map: this._tex('vehicleWear', Math.max(1, d / 2.8), 1),
      bumpMap: this._detailTex('vehicleWear', Math.max(1, d / 2.8), 1), bumpScale: 0.007,
      metalness: 0.45, roughness: 0.48,
    });
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x15252d, metalness: 0.5, roughness: 0.22 });
    const trim = new THREE.MeshBasicMaterial({ color: stripe });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x354951, metalness: 0.42, roughness: 0.55 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x73868d, metalness: 0.55, roughness: 0.42 });
    const group = new THREE.Group();
    group.position.set(x, 0, z); group.rotation.y = rot;
    // Rebasar mínimamente el HIGH evita que la textura de concreto pelee con
    // la piel del vagón/bus en la misma profundidad de render.
    const body = new THREE.Mesh(new THREE.BoxGeometry(w + 0.07, 2.96, d + 0.07), shell);
    body.position.y = 1.47; body.castShadow = true; body.receiveShadow = true; group.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.15, 0.13, d + 0.16), roofMat);
    roof.position.y = 2.99; roof.castShadow = true; group.add(roof);
    for (const side of [-1, 1]) {
      for (let p = -d * 0.32; p <= d * 0.32; p += 1.25) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.58), windowMat);
        win.position.set(side * (w / 2 + 0.051), 2.12, p);
        win.rotation.y = side * Math.PI / 2; group.add(win);
      }
      const band = new THREE.Mesh(new THREE.PlaneGeometry(d - 0.16, 0.11), trim);
      band.position.set(side * (w / 2 + 0.056), 1.36, 0);
      band.rotation.y = side * Math.PI / 2; group.add(band);
      for (const p of [-d * 0.23, d * 0.23]) {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 1.62), doorMat);
        door.position.set(side * (w / 2 + 0.058), 1.13, p);
        door.rotation.y = side * Math.PI / 2; group.add(door);
        const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 1.46), trim);
        seam.position.set(side * (w / 2 + 0.061), 1.13, p);
        seam.rotation.y = side * Math.PI / 2; group.add(seam);
      }
    }
    const undercarriage = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, 0.18, d * 0.62), windowMat);
    undercarriage.position.y = 0.12; group.add(undercarriage);
    if (road) {
      const tireMat = new THREE.MeshLambertMaterial({ color: 0x141619 });
      for (const side of [-1, 1]) for (const p of [-d * 0.31, d * 0.31]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.16, 10), tireMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * (w / 2 + 0.09), 0.31, p);
        group.add(wheel);
      }
    }
    this.mapGroup.add(group);
  }

  _addUtilityPole(x, z, { height = STREET_SCALE.lamp, color = 0x39414a, lamp = 0xffcc82, arm = 0.55 } = {}) {
    const poleMat = new THREE.MeshLambertMaterial({ color });
    const lampMat = new THREE.MeshBasicMaterial({ color: lamp });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, height, 7), poleMat);
    pole.position.set(x, height / 2, z); pole.castShadow = true; this.mapGroup.add(pole);
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(arm), 0.07, 0.07), poleMat);
    bracket.position.set(x + arm * 0.5, height - 0.28, z); this.mapGroup.add(bracket);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.2), lampMat);
    head.position.set(x + arm, height - 0.32, z); this.mapGroup.add(head);
  }

  _addUrbanAsset(id, x, z, {
    y = 0, scale = 1, rotation = 0, castShadow = true, receiveShadow = true,
    decorLink = null, capture = true,
  } = {}) {
    const model = cloneUrbanAsset(id);
    if (!model) return null;
    model.name = `urban-${id}`;
    // Los assets de Three.js Assets vienen centrados en el origen. Apoyarlos
    // por su base evita semienterrar fachadas, vehículos y mobiliario.
    const minY = Number(model.userData.urbanMinY) || 0;
    model.position.set(x, y - minY * scale, z);
    model.rotation.y = rotation;
    model.scale.setScalar(scale);
    model.userData.urbanAssetId = id;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = castShadow;
      o.receiveShadow = receiveShadow;
      o.frustumCulled = true;
    });
    if (this._captureDecor && capture) {
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      this._captureDecor.push({
        kind: 'urban', assetId: id, x, z, y, scale, rotation,
        w: size.x, d: size.z, h: size.y, decorLink,
      });
    }
    // El builder base conserva el resto de la ambientación del clon, pero
    // estos assets se recrean desde datos para que sean realmente editables.
    // Perspectiva puramente visual (capture:false) debe seguir apareciendo al
    // reconstruir un clon, aunque no se convierta en una pieza editable.
    if (this._suppressEditableDecor && capture) return model;
    this.mapGroup.add(model);
    return model;
  }

  // Segunda capa de mundo, siempre fuera de los límites jugables. Cada tema
  // recibe una silueta propia y barata (instancias, materiales compartidos,
  // cero luces/colliders): el escenario no termina en el último muro, pero el
  // fondo tampoco compite con enemigos, landmarks ni rutas tácticas.
  _addMapPeriphery(theme) {
    const addBoxes = (name, data, material) => {
      if (!data.length) return null;
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, data.length);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const euler = new THREE.Euler();
      data.forEach(([x, z, w, h, d, ry = 0, baseY = 0], i) => {
        quaternion.setFromEuler(euler.set(0, ry, 0));
        matrix.compose(position.set(x, baseY + h / 2, z), quaternion, scale.set(w, h, d));
        mesh.setMatrixAt(i, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = name;
      mesh.frustumCulled = true;
      this.mapGroup.add(mesh);
      return mesh;
    };

    if (theme === 'azoteas') {
      const farBuildings = [];
      for (let i = 0; i < 18; i++) {
        const a = i * Math.PI * 2 / 18 + 0.13;
        const radius = 86 + (i % 3) * 9;
        farBuildings.push([
          Math.sin(a) * radius, Math.cos(a) * radius,
          9 + (i % 4) * 2.2, 18 + (i * 7 % 25), 8 + (i % 3) * 2.4, a,
        ]);
      }
      addBoxes('periphery-azoteas-far-skyline', farBuildings,
        new THREE.MeshBasicMaterial({
          color: 0x273140, map: this._tex('windows', 2, 3), fog: true,
        }));
    } else if (theme === 'fortaleza') {
      const settlement = [
        [-48, -34, 7, 4.5, 6, 0.15], [-57, -14, 6, 3.8, 5, -0.2],
        [51, 31, 8, 5.2, 6, -0.12], [62, 9, 6, 4.1, 5, 0.18],
        [-36, 48, 6, 3.6, 5, 0.3], [39, -49, 7, 4.4, 6, -0.25],
      ];
      addBoxes('periphery-fortaleza-settlement', settlement,
        new THREE.MeshStandardMaterial({
          color: 0x726d63, map: this._tex('stone', 3, 2),
          bumpMap: this._detailTex('stone', 3, 2), bumpScale: 0.035,
          roughness: 0.92, metalness: 0.01,
        }));
    } else if (theme === 'calle') {
      const gantries = [];
      for (const z of [-91, 91]) {
        gantries.push([-9.4, z, 0.18, 5.2, 0.18, 0]);
        gantries.push([9.4, z, 0.18, 5.2, 0.18, 0]);
        gantries.push([0, z, 19, 0.16, 0.18, 0, 4.75]);
      }
      addBoxes('periphery-calle-signal-gantries', gantries,
        new THREE.MeshStandardMaterial({ color: 0x20292f, metalness: 0.68, roughness: 0.42 }));
      const lamps = [];
      for (const z of [-91, 91]) for (const x of [-4.5, 0, 4.5]) lamps.push([x, z - Math.sign(z) * 0.12, 0.38, 0.16, 0.08, 0, 4.60]);
      addBoxes('periphery-calle-emergency-signals', lamps,
        new THREE.MeshBasicMaterial({ color: 0xd4683e, fog: true }));
    } else if (theme === 'metro') {
      const serviceRibs = [];
      for (const z of [-30.5, 30.5]) {
        for (const x of [-12, -8, -4, 0, 4, 8, 12]) serviceRibs.push([x, z, 0.16, 4.8, 0.34, 0]);
        serviceRibs.push([0, z, 25, 0.18, 0.34, 0, 4.62]);
      }
      addBoxes('periphery-metro-service-ribs', serviceRibs,
        new THREE.MeshStandardMaterial({ color: 0x26343a, metalness: 0.64, roughness: 0.48 }));
    } else if (theme === 'prision') {
      addBoxes('periphery-prision-administration', [
        [-30, -15, 10, 7, 15, 0.04], [30, 15, 10, 7, 15, Math.PI + 0.04],
        [-31, 18, 8, 5, 12, -0.08], [31, -18, 8, 5, 12, Math.PI - 0.08],
      ], new THREE.MeshStandardMaterial({
        color: 0x555d62, map: this._tex('concrete', 3, 2),
        bumpMap: this._detailTex('concrete', 3, 2), bumpScale: 0.024,
        roughness: 0.82, metalness: 0.04,
      }));
      const fence = [];
      for (let z = -27; z <= 27; z += 3) {
        fence.push([-26.5, z, 0.055, 3.8, 0.055]);
        fence.push([26.5, z, 0.055, 3.8, 0.055]);
      }
      addBoxes('periphery-prision-outer-fence', fence,
        new THREE.MeshStandardMaterial({ color: 0x343b3f, metalness: 0.78, roughness: 0.36 }));
    } else if (theme === 'pueblo') {
      const ridgeData = [
        [-74, -52, 28, 15, 18], [-38, -78, 31, 18, 20], [8, -86, 35, 20, 22],
        [57, -65, 29, 16, 20], [81, -18, 34, 19, 23], [73, 49, 31, 17, 20],
        [22, 84, 36, 20, 24], [-42, 75, 30, 17, 20], [-78, 31, 33, 18, 22],
      ];
      const ridge = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 1),
        new THREE.MeshLambertMaterial({ color: 0x776f61, flatShading: true }), ridgeData.length);
      const matrix = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      ridgeData.forEach(([x, z, sx, sy, sz], i) => {
        q.setFromEuler(new THREE.Euler(0, i * 0.61, 0));
        matrix.compose(p.set(x, sy * 0.36 - 3.2, z), q, s.set(sx, sy, sz));
        ridge.setMatrixAt(i, matrix);
      });
      ridge.name = 'periphery-pueblo-ridge';
      this.mapGroup.add(ridge);
    }
  }

  // Mapa "Calle Cerrada" (34×84): avenida urbana al atardecer. Ruta central
  // con vehículos como cobertura, un BUS que rompe la línea de visión larga
  // a cada lado del centro, edificios que forman callejones laterales CQC y
  // barricadas en los chokes. Simetría rotacional; LOW/MID/HIGH estrictos.
  _buildCalle() {
    const { LOW, MID, HIGH } = BLOCK;
    const lowOpts = { color: 0x8f8c86, top: 0xb8b4ab };   // autos/cobertura
    const midOpts = { color: 0x7d7a74, top: 0xa9a59c };
    const highOpts = { color: 0x8b857c, top: 0xa39d92 };  // edificios
    const wallOpts = { mirror: false, color: 0x767068, top: 0x8d867d };

    const solidProp = { mirror: false, visual: false, cover: false, surface: 'metal' };
    const shelterCover = { mirror: false, visual: false, cover: true, surface: 'metal' };
    buildSharedCollision(this, 'calle', {
      low: lowOpts, mid: midOpts, high: highOpts, wall: wallOpts,
      solid: solidProp, shelter: shelterCover,
    });

    this._decorCalle();
  }

  _decorCalle() {
    // Calle cerrada: asfalto con carriles, aceras y autos inutilizados. Las
    // siluetas se calzan sobre los bloques LOW/HIGH existentes: el auto, bus
    // y barricada se leen como cover natural sin alterar la navegación.
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x696967, roughness: 0.84 });
    const sidewalkMat = new THREE.MeshStandardMaterial({
      color: 0x777a79, map: this._tex('concreteTop', 2.2, 16),
      bumpMap: this._detailTex('concreteTop', 2.2, 16), bumpScale: 0.018,
      roughness: 0.8, metalness: 0.02,
    });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xd3a864, transparent: true, opacity: 0.46 });
    // Aceras estrechas de escala urbana. Son planos visuales sobre el mismo
    // suelo navegable: ensanchan la lectura de la calzada sin crear escalones.
    for (const x of [-14.25, 14.25]) {
      const walk = new THREE.Mesh(new THREE.PlaneGeometry(5.0, this.fz * 2 - 0.8), sidewalkMat);
      walk.rotation.x = -Math.PI / 2; walk.position.set(x, 0.014, 0); walk.receiveShadow = true;
      this.mapGroup.add(walk);
    }
    for (const x of [-11.65, 11.65]) {
      // Bordillo continuo: Calle Cerrada es una sola avenida, no una
      // intersección. La cuneta marca con claridad el límite de la calzada.
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, this.fz * 2 - 1), curbMat);
      curb.position.set(x, 0.06, 0); curb.receiveShadow = true; this.mapGroup.add(curb);
      const gutter = new THREE.Mesh(
        new THREE.PlaneGeometry(0.62, this.fz * 2 - 1.2),
        new THREE.MeshBasicMaterial({ color: 0x242a2d, transparent: true, opacity: 0.36 }),
      );
      gutter.rotation.x = -Math.PI / 2; gutter.position.set(x - Math.sign(x) * 0.46, 0.019, 0);
      this.mapGroup.add(gutter);
    }
    const markCount = Math.floor((this.fz * 2 - 6) / 2.85) + 1;
    const marks = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.13, 2.2), lineMat, markCount);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < markCount; i++) {
      const z = -this.fz + 3 + i * 2.85;
      m4.makeRotationX(-Math.PI / 2); m4.setPosition(0, 0.018, z);
      marks.setMatrixAt(i, m4);
    }
    this.mapGroup.add(marks);

    // Alcantarilla y drenajes longitudinales aportan infraestructura urbana
    // sin convertir el centro en una intersección inexistente.
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x252a2c, metalness: 0.64, roughness: 0.58 });
    const manhole = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.025, 20), ironMat);
    manhole.position.set(0, 0.035, 0); this.mapGroup.add(manhole);
    const grooves = new THREE.InstancedMesh(new THREE.BoxGeometry(0.78, 0.018, 0.035), curbMat, 5);
    const crossTransform = new THREE.Object3D();
    for (let i = 0; i < 5; i++) {
      crossTransform.position.set(0, 0.052, -0.20 + i * 0.10);
      crossTransform.rotation.set(0, 0.28, 0); crossTransform.updateMatrix(); grooves.setMatrixAt(i, crossTransform.matrix);
    }
    grooves.instanceMatrix.needsUpdate = true; this.mapGroup.add(grooves);
    const drainPositions = [[-11.18, -4.0], [11.18, 4.0], [-11.18, 4.0], [11.18, -4.0]];
    const drains = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.025, 0.78), ironMat, drainPositions.length);
    const drainSlots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.38, 0.014, 0.035), curbMat, 20);
    let slotIndex = 0;
    drainPositions.forEach(([x, z], index) => {
      crossTransform.position.set(x, 0.037, z); crossTransform.rotation.set(0, 0, 0);
      crossTransform.updateMatrix(); drains.setMatrixAt(index, crossTransform.matrix);
      for (let i = -2; i <= 2; i++) {
        crossTransform.position.set(x, 0.054, z + i * 0.12); crossTransform.updateMatrix();
        drainSlots.setMatrixAt(slotIndex++, crossTransform.matrix);
      }
    });
    drains.instanceMatrix.needsUpdate = true; drainSlots.instanceMatrix.needsUpdate = true;
    this.mapGroup.add(drains, drainSlots);

    // Charcos irregulares y parches húmedos. Son planos compartiendo una sola
    // textura, sin reflejos en tiempo real ni partículas costosas.
    const puddleMat = new THREE.MeshBasicMaterial({
      map: this._tex('puddle'), color: 0x8fb5ca, transparent: true,
      opacity: 0.38, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const [x, z, sx, sz, ry] of [
      [-5.7, -36.2, 2.7, 1.25, 0.2], [5.7, 36.2, 2.7, 1.25, -0.2],
      [4.8, -14.0, 2.0, 0.85, -0.34], [-4.8, 14.0, 2.0, 0.85, 0.34],
      [-0.8, -3.2, 2.8, 0.9, 0.08], [0.8, 3.2, 2.8, 0.9, -0.08],
      [-7.7, 7.8, 1.45, 0.58, 0.22], [7.7, -7.8, 1.45, 0.58, -0.22],
    ]) {
      const puddle = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), puddleMat);
      puddle.rotation.x = -Math.PI / 2; puddle.rotation.z = ry;
      puddle.position.set(x, 0.023, z); this.mapGroup.add(puddle);
    }

    // Basura agrupada en los bordes: una instancia/draw call, nunca sobre las
    // rutas centrales ni cerca de los puntos de spawn.
    const debrisMat = new THREE.MeshLambertMaterial({ color: 0x6f6558 });
    const debris = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.025, 0.36), debrisMat, 28);
    const dm = new THREE.Matrix4();
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      const z = -this.fz + 6 + i * ((this.fz * 2 - 12) / 13);
      dm.compose(
        new THREE.Vector3(side * (12.15 + (i % 3) * 0.30), 0.034, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (i * 1.71) % Math.PI, (i % 4 - 1.5) * 0.05)),
        new THREE.Vector3(0.65 + (i % 3) * 0.22, 1, 0.7 + (i % 4) * 0.13),
      );
      debris.setMatrixAt(i, dm);
      dm.compose(
        new THREE.Vector3(-side * (12.2 + (i % 2) * 0.42), 0.034, -z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (i * 1.29) % Math.PI, 0)),
        new THREE.Vector3(0.7 + (i % 2) * 0.2, 1, 0.8),
      );
      debris.setMatrixAt(i + 14, dm);
    }
    debris.instanceMatrix.needsUpdate = true; this.mapGroup.add(debris);

    // El perímetro ya es físico por seguridad; esta capa lo convierte en una
    // calle flanqueada por edificios reales. Volúmenes exteriores, ventanas,
    // marquesinas y rótulos quedan detrás/sobre el muro y no generan hitboxes
    // falsas dentro de la avenida.
    // La continuidad exterior reutiliza edificios reales de esta misma calle.
    // Al clonarlos solo se reduce su luz/color con la distancia; no se cambia
    // su geometría, fachada, ventanas, rótulo ni lenguaje visual.
    const dimStreetObject = (object, shade) => {
      if (!object || shade >= 0.999) return object;
      object.traverse((part) => {
        if (!part.isMesh) return;
        const sourceMaterials = Array.isArray(part.material) ? part.material : [part.material];
        const materials = sourceMaterials.map((source) => {
          const material = source.clone();
          if (material.color) material.color.multiplyScalar(shade);
          if (material.emissive) material.emissive.multiplyScalar(shade);
          return material;
        });
        part.material = Array.isArray(part.material) ? materials : materials[0];
      });
      return object;
    };
    const streetBuildings = [];
    const addStreetBuilding = (side, z, span, height, name, color, variant = 0, signStyle = 'market') => {
      const firstPart = this.mapGroup.children.length;
      // El muro físico comienza a ±17.0 y la masa exterior termina en ±16.92.
      // La piel se proyecta 5 cm hacia la calle para que nunca comparta plano
      // con el ladrillo del volumen (la causa del parpadeo anterior).
      const faceX = side * (this.fx - 0.13);
      const rot = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      const toward = -side;
      const brickId = variant % 3 === 1 ? 'urbanBrickDark' : 'urbanBrick';
      const facadeTint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.62);
      const facadeMat = new THREE.MeshStandardMaterial({
        color: facadeTint, map: this._tex(brickId, Math.max(2, span / 2.2), Math.max(2, height / 1.8)),
        bumpMap: this._detailTex(brickId, Math.max(2, span / 2.2), Math.max(2, height / 1.8)),
        bumpScale: 0.030,
        roughness: 0.86, metalness: 0.02, side: THREE.DoubleSide,
      });
      const roofMat = new THREE.MeshStandardMaterial({
        color: facadeTint.clone().multiplyScalar(0.52), roughness: 0.94, metalness: 0.01,
      });
      const glassMat = new THREE.MeshStandardMaterial({ color: 0x101c23, metalness: 0.52, roughness: 0.2 });
      const litGlassMat = new THREE.MeshBasicMaterial({ color: 0xd19a61 });
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x353c40, metalness: 0.56, roughness: 0.46 });
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x888179, roughness: 0.82 });
      const shutterMat = new THREE.MeshStandardMaterial({
        color: variant % 2 ? 0x4b5557 : 0x58514b, map: this._tex('shopShutter', 1.5, 1),
        bumpMap: this._detailTex('shopShutter', 1.5, 1), bumpScale: 0.012,
        metalness: 0.48, roughness: 0.54,
      });
      const awningColors = {
        pharmacy: 0x31564f, bakery: 0x704039, garage: 0x4b4f50, electronics: 0x25495a,
        hardware: 0x5b4938, barber: 0x445158, laundry: 0x345b65, stationery: 0x53604b,
        market: 0x75453a, cafe: 0x594138,
      };
      const awningMat = new THREE.MeshStandardMaterial({
        color: awningColors[signStyle] ?? (variant % 2 ? 0x6b3931 : 0x304f52), roughness: 0.72,
      });
      const doorMat = new THREE.MeshStandardMaterial({
        color: variant % 2 ? 0x384248 : 0x514238, metalness: 0.34, roughness: 0.62,
      });
      // Volumen exterior: visible por encima de la fachada, sin afectar juego.
      // El techo usa material liso: evita el patrón de ladrillo horizontal
      // de alta frecuencia que producía moiré al observar el mapa desde arriba.
      const massX = side * (this.fx + 2.22);
      const mass = new THREE.Mesh(new THREE.BoxGeometry(4.6, height, span),
        [facadeMat, facadeMat, roofMat, roofMat, facadeMat, facadeMat]);
      mass.position.set(massX, height / 2, z); mass.castShadow = true; this.mapGroup.add(mass);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(span - 0.16, height - 0.18), facadeMat);
      face.position.set(faceX, height / 2, z); face.rotation.y = rot; this.mapGroup.add(face);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, span + 0.3), stoneMat);
      cap.position.set(faceX - side * 0.2, height - 0.08, z); this.mapGroup.add(cap);
      // Cornisas dividen el local de las plantas residenciales y rompen el
      // gran rectángulo de fachada.
      for (const y of [3.02, height - 0.52]) {
        const cornice = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, span + 0.14), stoneMat);
        cornice.position.set(faceX + toward * 0.09, y, z); this.mapGroup.add(cornice);
      }
      const floors = Math.max(1, Math.floor((height - 3.0) / STREET_SCALE.floor));
      const bays = Math.max(2, Math.floor(span / 2.35));
      const upperFloorBase = 3.02;
      const windowH = 1.46;
      const upperWindowSill = 0.96;
      for (let row = 0; row < floors; row++) {
        // El alféizar queda a una altura residencial creíble dentro de cada
        // planta. Así las ventanas no parecen apoyadas sobre la losa/cornisa
        // del segundo ni del tercer piso.
        const y = upperFloorBase + upperWindowSill + windowH * 0.5 + STREET_SCALE.floor * row;
        if (y > height - 0.82) continue;
        for (let col = 0; col < bays; col++) {
          const zi = z - span * 0.39 + col * (span * 0.78 / Math.max(1, bays - 1));
          const win = new THREE.Mesh(new THREE.PlaneGeometry(1.06, windowH), ((row + col + variant) % 5 === 0) ? litGlassMat : glassMat);
          win.position.set(faceX + toward * 0.026, y, zi); win.rotation.y = rot; this.mapGroup.add(win);
          // cuatro piezas de marco y un alféizar proyectado
          for (const yy of [-0.775, 0.775]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.085, 1.18), frameMat);
            bar.position.set(faceX + toward * 0.07, y + yy, zi); this.mapGroup.add(bar);
          }
          for (const zz of [-0.57, 0.57]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(0.10, 1.59, 0.085), frameMat);
            bar.position.set(faceX + toward * 0.07, y, zi + zz); this.mapGroup.add(bar);
          }
          const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.105, 1.50, 0.045), frameMat);
          mullion.position.set(faceX + toward * 0.08, y, zi); this.mapGroup.add(mullion);
          if ((row + col + variant) % 3 === 0) {
            const sash = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.06, 1.05), frameMat);
            sash.position.set(faceX + toward * 0.085, y - 0.10, zi); this.mapGroup.add(sash);
          }
          if (row === 0 && (col + variant) % 4 === 1) {
            const ac = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.34, 0.62), stoneMat);
            ac.position.set(faceX + toward * 0.20, y - 0.93, zi); this.mapGroup.add(ac);
            for (const dz of [-0.19, 0, 0.19]) {
              const slit = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.035), frameMat);
              slit.position.set(faceX + toward * 0.36, y - 0.93, zi + dz); this.mapGroup.add(slit);
            }
          }
        }
      }
      // Planta baja con tipologías distintas: comercio acristalado, taller y
      // local cerrado. Comparten escala y lenguaje, pero ya no repiten la
      // misma puerta/persiana en toda la calle.
      const shopW = Math.min(3.65, span * 0.58);
      const frontX = faceX + toward * 0.04;
      const storefrontType = variant % 3;
      if (storefrontType === 0) {
        const display = new THREE.Mesh(new THREE.PlaneGeometry(shopW, STREET_SCALE.door - 0.12), glassMat);
        display.position.set(frontX, STREET_SCALE.door / 2, z - span * 0.10);
        display.rotation.y = rot; this.mapGroup.add(display);
        const kick = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.34, shopW), doorMat);
        kick.position.set(faceX + toward * 0.10, 0.19, z - span * 0.10); this.mapGroup.add(kick);
        for (const dz of [-shopW * 0.48, 0, shopW * 0.48]) {
          const frame = new THREE.Mesh(new THREE.BoxGeometry(0.11, STREET_SCALE.door + 0.06, 0.08), frameMat);
          frame.position.set(faceX + toward * 0.10, STREET_SCALE.door / 2, z - span * 0.10 + dz);
          this.mapGroup.add(frame);
        }
      } else {
        const shutterW = storefrontType === 1 ? shopW + 0.42 : shopW;
        const shutter = new THREE.Mesh(new THREE.PlaneGeometry(shutterW, STREET_SCALE.door), shutterMat);
        shutter.position.set(frontX, STREET_SCALE.door / 2, z - span * 0.10);
        shutter.rotation.y = rot; this.mapGroup.add(shutter);
        const hood = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, shutterW + 0.24), frameMat);
        hood.position.set(faceX + toward * 0.11, STREET_SCALE.door + 0.16, z - span * 0.10);
        this.mapGroup.add(hood);
      }
      const entranceW = 1.16;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(entranceW, STREET_SCALE.door), storefrontType === 2 ? glassMat : doorMat);
      door.position.set(frontX + toward * 0.005, STREET_SCALE.door / 2, z + span * 0.31);
      door.rotation.y = rot; this.mapGroup.add(door);
      const transom = new THREE.Mesh(new THREE.PlaneGeometry(entranceW, 0.30), glassMat);
      transom.position.set(frontX + toward * 0.008, STREET_SCALE.door + 0.18, z + span * 0.31);
      transom.rotation.y = rot; this.mapGroup.add(transom);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.24, 0.05), frameMat);
      handle.position.set(faceX + toward * 0.12, 1.20, z + span * 0.31 + entranceW * 0.34);
      this.mapGroup.add(handle);
      for (const pz of [z - span * 0.40, z + span * 0.18, z + span * 0.42]) {
        const pier = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.04, 0.30), stoneMat);
        pier.position.set(faceX + toward * 0.13, 1.52, pz); this.mapGroup.add(pier);
      }
      const awningDepth = storefrontType === 1 ? 0.34 : 0.72;
      const awning = new THREE.Mesh(new THREE.BoxGeometry(awningDepth, 0.13, shopW + 0.34), awningMat);
      awning.position.set(faceX + toward * (awningDepth * 0.5), 2.72, z - span * 0.10);
      awning.rotation.z = side * (storefrontType === 1 ? 0.03 : 0.10); this.mapGroup.add(awning);
      const fixture = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 0.12, Math.min(1.65, shopW * 0.58)),
        new THREE.MeshBasicMaterial({ color: variant % 3 === 0 ? 0xffc47a : 0xcbd9dc }),
      );
      fixture.position.set(faceX + toward * 0.43, 2.57, z - span * 0.10); this.mapGroup.add(fixture);
      // El rótulo vive delante de la cornisa y por encima del toldo: ninguna
      // pieza de fachada puede recortarlo desde los ángulos normales de juego.
      this._addStreetShopSign(name, signStyle, faceX + toward * 0.23, 3.23, z - span * 0.10, rot,
        { w: Math.min(3.45, span - 0.66), h: 0.56 });
      // Landmarks geométricos discretos que siguen funcionando cuando el
      // texto deja de ser legible. La farmacia conserva solo su rótulo.
      if (signStyle === 'garage') {
        const hazard = new THREE.MeshBasicMaterial({ map: this._tex('hazard', 2, 1), color: 0xc59652 });
        const sill = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 0.22), hazard);
        sill.position.set(faceX + toward * 0.06, 0.18, z - span * 0.10); sill.rotation.y = rot; this.mapGroup.add(sill);
      } else if (signStyle === 'laundry') {
        const laundryGlow = new THREE.MeshBasicMaterial({ color: 0x76a9b7 });
        for (const dz of [-0.72, 0, 0.72]) {
          const drum = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.055, 8, 18), laundryGlow);
          drum.position.set(faceX + toward * 0.12, 1.18, z - span * 0.10 + dz);
          drum.rotation.y = rot; this.mapGroup.add(drum);
        }
      } else if (signStyle === 'market') {
        const crateBand = new THREE.MeshBasicMaterial({ color: 0x9f6e42 });
        const loadingMark = new THREE.Mesh(new THREE.PlaneGeometry(2.55, 0.16), crateBand);
        loadingMark.position.set(faceX + toward * 0.065, 0.34, z - span * 0.08);
        loadingMark.rotation.y = rot; this.mapGroup.add(loadingMark);
      }
      // bajante y cajas eléctricas aportan escala humana sin ocupar suelo.
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, height - 0.5, 7), frameMat);
      pipe.position.set(faceX + toward * 0.10, (height - 0.5) / 2, z - span * 0.44); this.mapGroup.add(pipe);

      // El edificio completo pasa a ser una sola unidad editable. Conserva
      // todas las piezas en coordenadas locales para que duplicar/mover desde
      // el editor arrastre masa, fachada, rótulo, ventanas y accesorios.
      const parts = this.mapGroup.children.slice(firstPart);
      const building = new THREE.Group();
      building.position.set(massX, 0, z);
      this.mapGroup.add(building);
      for (const part of parts) building.attach(part);
      building.userData.streetBuilding = { side, z, span, height, name, color, variant, signStyle };
      this._registerBaseDecor(building, 'building', {
        x: massX, z, rotation: 0, w: 6.3, d: span + 0.5, h: height,
        name, color, variant,
      });
      streetBuildings.push(building);
      return building;
    };
    // Pares a 180°: la calle tiene barrios/negocios distintos, pero ambos
    // equipos conservan el mismo número de entradas y la misma lectura.
    const blocks = [
      // Los módulos añadidos en los extremos son repeticiones exactas de las
      // fachadas vecinas; no introducen otra familia de edificios.
      [-36, 11.7, 9.25,
        ['PHARMACY', 0x9c8173, 'pharmacy'], ['BAKERY', 0x92766c, 'bakery'], 0],
      // Los bloques con dos plantas residenciales necesitan altura completa:
      // 3.02 m de local + 2.70 m por planta + remate de cubierta. Antes la
      // cornisa superior quedaba prácticamente encima de las ventanas del 3.º.
      [-24, 11.7, 9.25,
        ['PHARMACY', 0x9c8173, 'pharmacy'], ['BAKERY', 0x92766c, 'bakery'], 0],
      [-12, 11.7, 7.3,
        ['GARAGE', 0x746967, 'garage'], ['ELECTRONICS', 0x66757b, 'electronics'], 1],
      // Todos los edificios de dos pisos comparten la altura del bloque más
      // bajo para que cornisas, ventanas y línea de cubierta queden alineadas.
      [0, 10.8, 7.3,
        ['HARDWARE', 0x846f67, 'hardware'], ['BARBER SHOP', 0x756b68, 'barber'], 2],
      [12, 11.7, 7.3,
        ['LAUNDRY', 0x776c68, 'laundry'], ['PAPER & INK', 0x7b7567, 'stationery'], 3],
      [24, 11.7, 9.35,
        ['MINI MARKET', 0x95796c, 'market'], ['CORNER CAFE', 0x876f66, 'cafe'], 4],
      [36, 11.7, 9.35,
        ['MINI MARKET', 0x95796c, 'market'], ['CORNER CAFE', 0x876f66, 'cafe'], 4],
    ];
    for (const [z, span, h, left, right, variant] of blocks) {
      addStreetBuilding(-1, z, span, h, left[0], left[1], variant, left[2]);
      addStreetBuilding(1, -z, span, h, right[0], right[1], variant, right[2]);
    }

    // MEDIANERAS: los módulos quedan PEGADOS (queja de Chuck: la rendija
    // entre edificios era un hoyo feo con el telón asomando). Cada gap se
    // rellena con un volumen de ladrillo AL RAS del plano de fachada y a la
    // altura del vecino más bajo — pared continua, sin física nueva (el
    // muro invisible ya corre por delante de todo este plano).
    {
      const seamBrickMat = new THREE.MeshStandardMaterial({
        color: 0x8a7466, map: this._tex('urbanBrickDark', 1.1, 5.2),
        bumpMap: this._detailTex('urbanBrickDark', 1.1, 5.2), bumpScale: 0.028,
        roughness: 0.88, metalness: 0.02,
      });
      const seamRoofMat = new THREE.MeshStandardMaterial({
        color: 0x4d423c, roughness: 0.94, metalness: 0.01,
      });
      for (let i = 0; i < blocks.length - 1; i++) {
        const endA = blocks[i][0] + blocks[i][1] / 2;
        const startB = blocks[i + 1][0] - blocks[i + 1][1] / 2;
        const gapC = (endA + startB) / 2;
        const gapW = Math.max(0.2, startB - endA) + 0.26;
        const hSeam = Math.min(blocks[i][2], blocks[i + 1][2]);
        for (const side of [-1, 1]) {
          const seam = new THREE.Mesh(
            new THREE.BoxGeometry(4.65, hSeam, gapW),
            [seamBrickMat, seamBrickMat, seamRoofMat, seamRoofMat, seamBrickMat, seamBrickMat],
          );
          seam.position.set(side * (this.fx + 2.195), hSeam / 2, side > 0 ? -gapC : gapC);
          seam.castShadow = true; seam.receiveShadow = true;
          this.mapGroup.add(seam);
        }
      }
    }

    // Perspectiva exterior: la colisión termina en ±fz, pero asfalto, aceras
    // y cuatro módulos de fachada continúan en cada dirección. Todo se agrupa
    // en instancias y se oscurece con la distancia, de modo que la avenida
    // parece seguir dentro de la ciudad sin ampliar navegación ni coste de IA.
    const continuationModules = 4;
    const continuationStep = 12;
    const continuationLength = continuationModules * continuationStep;
    const continuationShades = [0.72, 0.56, 0.40, 0.24];
    const roadBeyondMat = new THREE.MeshStandardMaterial({
      color: 0x8b8f91,
      map: this._tex('asphalt', this.fx * 2 / 3.6, continuationLength / 3.6),
      roughness: 0.50, metalness: 0.06,
    });
    for (const dir of [-1, 1]) {
      const beyondZ = dir * (this.fz + continuationLength * 0.5);
      const roadBeyond = new THREE.Mesh(
        new THREE.PlaneGeometry(this.fx * 2, continuationLength), roadBeyondMat,
      );
      roadBeyond.rotation.x = -Math.PI / 2;
      roadBeyond.position.set(0, -0.002, beyondZ);
      roadBeyond.receiveShadow = false; this.mapGroup.add(roadBeyond);
      for (const x of [-14.25, 14.25]) {
        const walk = new THREE.Mesh(new THREE.PlaneGeometry(5.0, continuationLength), sidewalkMat);
        walk.rotation.x = -Math.PI / 2; walk.position.set(x, 0.012, beyondZ);
        walk.receiveShadow = false; this.mapGroup.add(walk);
      }
      for (const x of [-11.65, 11.65]) {
        const curb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, continuationLength), curbMat);
        curb.position.set(x, 0.06, beyondZ); this.mapGroup.add(curb);
      }
    }
    const beyondMarkCount = continuationModules * 8;
    const beyondMarks = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.13, 2.2), lineMat, beyondMarkCount,
    );
    let beyondMarkIndex = 0;
    for (const dir of [-1, 1]) for (let i = 0; i < continuationModules * 4; i++) {
      m4.makeRotationX(-Math.PI / 2);
      m4.setPosition(0, 0.016, dir * (this.fz + 1.5 + i * 3));
      beyondMarks.setMatrixAt(beyondMarkIndex++, m4);
    }
    beyondMarks.instanceMatrix.needsUpdate = true; this.mapGroup.add(beyondMarks);

    // No se inventa una versión simplificada para el fondo: cada módulo es un
    // clon real de uno de los edificios ya presentes en la fila. Esto mantiene
    // exactamente las mismas ventanas, cornisas, persianas, toldos y rótulos.
    for (const dir of [-1, 1]) {
      for (const side of [-1, 1]) {
        const sources = streetBuildings
          .filter((building) => building.userData.streetBuilding.side === side)
          .sort((a, b) => (dir > 0 ? b.position.z - a.position.z : a.position.z - b.position.z));
        for (let depth = 0; depth < continuationModules; depth++) {
          const source = sources[depth % sources.length];
          const clone = source.clone(true);
          clone.name = `street-building-continuation:${side}:${dir}:${depth}`;
          clone.position.z = dir * (this.fz + continuationStep * (depth + 0.5));
          clone.userData = { streetContinuation: true, source: source.userData.streetBuilding.name };
          clone.traverse((part) => {
            if (!part.isMesh) return;
            part.castShadow = false;
            part.receiveShadow = false;
          });
          dimStreetObject(clone, continuationShades[depth]);
          this.mapGroup.add(clone);
        }
      }
    }

    // PARED URBANA en los cierres norte/sur (pedido de Chuck): el corte
    // físico en ±fz+0.4 era invisible y la avenida parecía seguir de largo.
    // Un muro de ladrillo con pilastras, cornisa y portón de servicio
    // cerrado explica el límite; la continuación sigue asomando por encima.
    {
      const wallBrickMat = new THREE.MeshStandardMaterial({
        color: 0x8d8177, map: this._tex('urbanBrickDark', 9.5, 1.6),
        bumpMap: this._detailTex('urbanBrickDark', 9.5, 1.6), bumpScale: 0.03,
        roughness: 0.88, metalness: 0.02,
      });
      const wallStoneMat = new THREE.MeshStandardMaterial({ color: 0x7c766e, roughness: 0.84 });
      const wallGateMat = new THREE.MeshStandardMaterial({
        color: 0x4d5356, map: this._tex('shopShutter', 3.2, 1.6),
        bumpMap: this._detailTex('shopShutter', 3.2, 1.6), bumpScale: 0.012,
        metalness: 0.46, roughness: 0.56,
      });
      const wallHazardMat = new THREE.MeshBasicMaterial({
        map: this._tex('hazard', 4, 1), color: 0xc79a55,
      });
      const wallLampMat = new THREE.MeshBasicMaterial({ color: 0xffc47a });
      for (const dir of [-1, 1]) {
        const wz = dir * (this.fz + 0.4);
        const toward = -dir; // hacia la avenida
        const body = new THREE.Mesh(new THREE.BoxGeometry(34.6, 4.4, 0.7), wallBrickMat);
        body.position.set(0, 2.2, wz); body.castShadow = true; body.receiveShadow = true;
        this.mapGroup.add(body);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(35.2, 0.24, 0.95), wallStoneMat);
        cap.position.set(0, 4.52, wz); cap.castShadow = true; this.mapGroup.add(cap);
        for (const px of [-14.5, -8.7, 8.7, 14.5]) {
          const pier = new THREE.Mesh(new THREE.BoxGeometry(1.0, 4.75, 0.95), wallStoneMat);
          pier.position.set(px, 2.37, wz); pier.castShadow = true; this.mapGroup.add(pier);
        }
        // portón de servicio cerrado al centro, con marco, viga y baliza
        const gate = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 3.5), wallGateMat);
        gate.position.set(0, 1.75, wz + toward * 0.37);
        gate.rotation.y = dir > 0 ? Math.PI : 0; this.mapGroup.add(gate);
        for (const gx of [-3.35, 3.35]) {
          const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.1, 0.92), wallStoneMat);
          jamb.position.set(gx, 2.05, wz); jamb.castShadow = true; this.mapGroup.add(jamb);
        }
        const lintel = new THREE.Mesh(new THREE.BoxGeometry(7.3, 0.55, 0.92), wallStoneMat);
        lintel.position.set(0, 3.9, wz); lintel.castShadow = true; this.mapGroup.add(lintel);
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 0.3), wallHazardMat);
        stripe.position.set(0, 3.42, wz + toward * 0.38);
        stripe.rotation.y = dir > 0 ? Math.PI : 0; this.mapGroup.add(stripe);
        for (const lx of [-2.6, 2.6]) {
          const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.12), wallLampMat);
          lamp.position.set(lx, 4.06, wz + toward * 0.5); this.mapGroup.add(lamp);
        }
      }
    }

    // TELÓN de manzana trasera (queja de Chuck: entre módulos de edificios
    // quedaban gaps por los que se veía el void del fin del mundo). Un plano
    // continuo de fachadas nocturnas corre DETRÁS de toda la línea de
    // edificios en cada lado: cualquier separación entre módulos muestra
    // ciudad, nunca cielo vacío. Sin física (vive fuera de los límites).
    // MÁS BAJO que el edificio más bajo (9.35): solo se ve POR los huecos —
    // jamás asoma sobre los techos como "edificios extra" (2ª queja).
    {
      const alleyBackMat = new THREE.MeshBasicMaterial({
        map: this._tex('windows', 24, 2.6), color: 0x232a30,
      });
      for (const side of [-1, 1]) {
        const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(86, 9.2), alleyBackMat);
        backdrop.position.set(side * (this.fx + 5.0), 4.6, 0);
        backdrop.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        this.mapGroup.add(backdrop);
      }
    }

    // MOBILIARIO URBANO de acera (pedido de Chuck): parquímetros, buzón,
    // cabina telefónica, cajas de periódicos, botes de basura y bancas.
    // Cada pieza vive espejada en ambos lados y su física (en
    // collision-layouts) coincide 1:1 con el dibujo — sin paredes
    // invisibles ni volúmenes penetrables; los decals siempre encuentran
    // superficie visual real.
    {
      const steelMat = new THREE.MeshStandardMaterial({ color: 0x5a6167, metalness: 0.62, roughness: 0.40 });
      const darkSteelMat = new THREE.MeshStandardMaterial({ color: 0x30363b, metalness: 0.55, roughness: 0.48 });
      const mailMat = new THREE.MeshStandardMaterial({
        color: 0x2c4a75, map: this._tex('vehicleWear', 0.8, 0.8),
        metalness: 0.42, roughness: 0.50,
      });
      const boothMat = new THREE.MeshStandardMaterial({ color: 0x37474e, metalness: 0.50, roughness: 0.44 });
      const boothGlassMat = new THREE.MeshStandardMaterial({
        color: 0x9db4c2, map: this._tex('vehicleGlass', 1, 1),
        emissive: 0x9db8c8, emissiveIntensity: 0.30,
        emissiveMap: this._tex('vehicleGlass', 1, 1),
        metalness: 0.58, roughness: 0.14,
      });
      const meterFaceMat = new THREE.MeshBasicMaterial({ color: 0xd8b76a });
      const phoneSignMat = new THREE.MeshBasicMaterial({ color: 0x8fd0e8 });
      const binMat = new THREE.MeshStandardMaterial({
        color: 0x4a5450, map: this._tex('vehicleWear', 0.7, 0.7),
        metalness: 0.35, roughness: 0.62,
      });
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x6d5138, roughness: 0.78 });
      const standColors = [0xc65745, 0x4f7891, 0xd9b44a];

      // cada elemento se coloca en (x,z) del lado este y espejado a (-x,-z)
      const eachSide = (x, z, build) => {
        for (const s of [1, -1]) {
          const g = new THREE.Group();
          g.position.set(s * x, 0, s * z);
          if (s < 0) g.rotation.y = Math.PI;
          build(g);
          g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
          this.mapGroup.add(g);
        }
      };
      const box = (g, w, h, d, px, py, pz, mat) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        mesh.position.set(px, py, pz); g.add(mesh); return mesh;
      };

      // parquímetros en el borde de la acera, junto a los autos estacionados
      for (const mz of [13.4, 16.6, 18.4]) {
        eachSide(12.45, mz, (g) => {
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 1.02, 8), steelMat);
          pole.position.y = 0.51; g.add(pole);
          box(g, 0.20, 0.30, 0.11, 0, 1.14, 0, darkSteelMat);
          box(g, 0.13, 0.10, 0.115, 0, 1.19, 0, meterFaceMat);
        });
      }
      // buzón de correos (macizo, tapa curva insinuada con dos volúmenes)
      eachSide(13.0, 12.2, (g) => {
        box(g, 0.60, 0.78, 0.50, 0, 0.55, 0, mailMat);
        box(g, 0.60, 0.18, 0.42, 0, 0.99, 0, mailMat);
        box(g, 0.46, 0.05, 0.06, 0, 0.86, -0.255, darkSteelMat);
        for (const lx of [-0.22, 0.22]) box(g, 0.07, 0.34, 0.07, lx, 0.17, 0, darkSteelMat);
      });
      // cabina telefónica cerrada (vitrina: el vidrio es dibujo y detiene)
      eachSide(14.9, 18.5, (g) => {
        for (const [cx, cz] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) {
          box(g, 0.10, 2.26, 0.10, cx, 1.13, cz, boothMat);
        }
        box(g, 0.98, 0.14, 0.98, 0, 2.30, 0, boothMat);
        box(g, 0.94, 0.30, 0.94, 0, 0.15, 0, boothMat);
        for (const [w2, d2, px, pz] of [
          [0.78, 0.05, 0, -0.44], [0.78, 0.05, 0, 0.44],
          [0.05, 0.78, -0.44, 0], [0.05, 0.78, 0.44, 0],
        ]) box(g, w2, 1.92, d2, px, 1.28, pz, boothGlassMat);
        box(g, 0.72, 0.24, 0.06, 0, 2.10, -0.475, phoneSignMat);
      });
      // fila de cajas dispensadoras de periódicos
      eachSide(12.9, -18.1, (g) => {
        [-0.62, 0, 0.62].forEach((dz, i) => {
          const mat = new THREE.MeshStandardMaterial({
            color: standColors[i], metalness: 0.30, roughness: 0.58,
          });
          box(g, 0.40, 0.72, 0.44, 0, 0.60, dz, mat);
          box(g, 0.03, 0.30, 0.34, -0.20, 0.72, dz, darkSteelMat);
          for (const lx2 of [-0.14, 0.14]) box(g, 0.06, 0.24, 0.38, lx2, 0.12, dz, darkSteelMat);
        });
      });
      // botes de basura públicos
      for (const [bx, bz] of [[12.85, -13.6], [14.6, 5.6]]) {
        eachSide(bx, bz, (g) => {
          const body2 = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.24, 0.86, 10), binMat);
          body2.position.y = 0.43; g.add(body2);
          const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.285, 0.285, 0.07, 10), darkSteelMat);
          ring.position.y = 0.88; g.add(ring);
        });
      }
      // bancas de acera contra la fachada, mirando a la calle
      for (const [nx, nz] of [[14.85, -20.5], [14.85, 24.2]]) {
        eachSide(nx, nz, (g) => {
          for (const dz of [-0.78, 0.78]) box(g, 0.52, 0.07, 0.09, 0, 0.42, dz, darkSteelMat);
          for (const dz of [-0.78, 0.78]) box(g, 0.46, 0.36, 0.07, 0, 0.20, dz, darkSteelMat);
          for (const ox of [-0.17, -0.03, 0.11]) box(g, 0.12, 0.05, 1.80, ox, 0.47, 0, woodMat);
          for (const oy of [0.66, 0.80]) box(g, 0.05, 0.10, 1.80, 0.28, oy, 0, woodMat);
          box(g, 0.06, 0.52, 0.08, 0.26, 0.62, -0.78, darkSteelMat);
          box(g, 0.06, 0.52, 0.08, 0.26, 0.62, 0.78, darkSteelMat);
        });
      }
    }

    // Autos inutilizados: landmark de vehículo y cover bajo predecible.
    for (const [x, z, rot, color, variant] of [
      [-2.5, -28, 0, 0x5a6470, 0], [2.5, 28, Math.PI, 0x5a6470, 0],
      [6.5, -21, 0, 0x6b6259, 1], [-6.5, 21, Math.PI, 0x6b6259, 1],
      [-6.5, -16, 0, 0x59686b, 2], [6.5, 16, Math.PI, 0x59686b, 2],
      [3, -10.5, 0, 0x815e4f, 1], [-3, 10.5, Math.PI, 0x815e4f, 1],
      [-3, -5.5, Math.PI / 2, 0x52696c, 2], [3, 5.5, -Math.PI / 2, 0x52696c, 2],
    ]) {
      // El SUV se usa como una variante compacta, no se estira: escala
      // uniforme 1.35 deja ancho/longitud cerca del collider LOW existente.
      const assetVehicle = variant === 0
        ? this._addUrbanAsset('suvMinivan', x, z, { scale: 1.35, rotation: rot })
        : null;
      if (!assetVehicle) this._addStreetVehicle(x, z, rot, color, variant);
    }
    // Buses atravesados cierran visual y tácticamente el acceso frontal a
    // cada spawn; los callejones laterales siguen siendo los flancos claros.
    this._addStreetBus(0, -34.5, Math.PI / 2, 0);
    this._addStreetBus(0, 34.5, -Math.PI / 2, 1);
    // Dos paradas explican que los autobuses cerraban una ruta urbana real.
    // Rotadas 180° (pedido de Chuck): la vitrina de vidrio da al MURO y la
    // abertura con la banca mira a la CALLE — quien espera ve pasar el bus.
    this._addUrbanAsset('busShelter', 14.35, -37.0,
      { scale: 0.84, rotation: -Math.PI / 2, decorLink: 'busShelter:right' });
    this._addUrbanAsset('busShelter', -14.35, 37.0,
      { scale: 0.84, rotation: Math.PI / 2, decorLink: 'busShelter:left' });
    // Vehículos del operativo de emergencia: conservan posición, orientación
    // y collider; colores/insignias distintos explican por qué están allí.
    this._addStreetTruck(-6.5, -1.5, 0, 0x53666b, 0);
    this._addStreetTruck(6.5, 1.5, Math.PI, 0x74584b, 1);

    // Divisores Jersey reemplazan los LOW de aproximación. Su volumen ocupa
    // la misma huella/altura del cover, pero la sección escalonada se lee como
    // infraestructura vial y no como una caja genérica.
    const jerseyMat = new THREE.MeshStandardMaterial({ color: 0x8b8983, roughness: 0.82, metalness: 0.03 });
    const grimeMat = new THREE.MeshLambertMaterial({ color: 0x4e4a44 });
    const addJersey = (x, z, w, d, rot = 0) => {
      const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot;
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.38, d), jerseyMat);
      base.position.y = 0.19; base.castShadow = true; g.add(base);
      const waist = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.42, d * 0.78), jerseyMat);
      waist.position.y = 0.58; waist.castShadow = true; g.add(waist);
      const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.30, d * 0.54), jerseyMat);
      top.position.y = 0.95; top.castShadow = true; g.add(top);
      for (const px of [-w * 0.28, w * 0.28]) {
        const stain = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, d + 0.012), grimeMat);
        stain.position.set(px, 0.44, 0); stain.rotation.z = 0.55; g.add(stain);
      }
      this._registerBaseDecor(g, 'jersey', { x, z, rotation: rot, w, d, h: BLOCK.LOW });
    };
    for (const [x, z] of [
      [-6.1, -33.4], [6.1, -33.4], [6.1, 33.4], [-6.1, 33.4],
      [3.6, -2.2], [-3.6, 2.2],
    ]) addJersey(x, z, 2.4, 0.9);

    // Contenedores comerciales junto a las puertas de servicio. Ya no ocupan
    // el carril ni parecen cobertura colocada arbitrariamente en la avenida.
    const largeWasteMat = new THREE.MeshStandardMaterial({ color: 0x304a46, metalness: 0.34, roughness: 0.68 });
    const wasteDarkMat = new THREE.MeshStandardMaterial({ color: 0x1d2627, metalness: 0.48, roughness: 0.58 });
    const wasteRimMat = new THREE.MeshStandardMaterial({ color: 0x68706d, metalness: 0.48, roughness: 0.54 });
    const reflectorMat = new THREE.MeshBasicMaterial({ color: 0xcf7b3f });
    for (const [x, z, ry] of [[-15.15, -8, Math.PI / 2], [15.15, 8, -Math.PI / 2]]) {
      const bin = new THREE.Group(); bin.position.set(x, 0, z); bin.rotation.y = ry;
      const skid = new THREE.Mesh(new THREE.BoxGeometry(2.34, 0.12, 2.02), wasteDarkMat);
      skid.position.y = 0.06; bin.add(skid);
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.38, 0.78, 1.94), largeWasteMat);
      body.position.y = 0.51; body.castShadow = true; body.receiveShadow = true; bin.add(body);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(2.48, 0.14, 2.06), wasteRimMat);
      rim.position.y = 0.96; rim.castShadow = true; bin.add(rim);
      for (const side of [-1, 1]) {
        for (const pz of [-0.66, -0.22, 0.22, 0.66]) {
          const rib = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.64, 0.08), wasteRimMat);
          rib.position.set(side * 1.205, 0.54, pz); bin.add(rib);
        }
      }
      for (const px of [-0.59, 0.59]) {
        const lid = new THREE.Mesh(new THREE.BoxGeometry(1.10, 0.10, 1.96), wasteDarkMat);
        lid.position.set(px, 1.07, 0); lid.rotation.z = px < 0 ? -0.035 : 0.035; bin.add(lid);
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.08), wasteRimMat);
        handle.position.set(px, 1.14, -0.73); bin.add(handle);
      }
      for (const px of [-0.78, 0.78]) {
        const reflector = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.12, 0.035), reflectorMat);
        reflector.position.set(px, 0.55, -0.988); bin.add(reflector);
      }
      this._registerBaseDecor(bin, 'dumpster', {
        x, z, rotation: ry, w: 2.5, d: 2.2, h: 1.15,
      });
    }

    // Kioscos urbanos compactos pero de escala humana: base, mostrador,
    // abertura de servicio, postes y techo independiente.
    // La silueta abierta evita que se lean como edificios en miniatura.
    const kioskPanel = new THREE.MeshStandardMaterial({ color: 0x5d6667, metalness: 0.32, roughness: 0.62 });
    const cornerDark = new THREE.MeshStandardMaterial({
      color: 0x4c5558, map: this._tex('shopShutter', 2, 1), metalness: 0.45, roughness: 0.55,
    });
    const cornerTrim = new THREE.MeshStandardMaterial({ color: 0x77716a, roughness: 0.78 });
    const paperColors = [0xc65745, 0xd9b44a, 0x4f7891, 0xd6d0bd];
    const addSidewalkKiosk = (x, z, w, d, toward, name, awningColor, decorLink) => {
      const kiosk = new THREE.Group();
      kiosk.position.set(x, 0, z);
      const addKioskPart = (geometry, material, px, py, pz) => {
        const part = new THREE.Mesh(geometry, material);
        part.position.set(px, py, pz); part.castShadow = true; part.receiveShadow = true;
        kiosk.add(part); return part;
      };
      const frontZ = toward * (d / 2 + 0.026);
      const backZ = -toward * (d / 2 - 0.055);
      const frontRot = toward > 0 ? 0 : Math.PI;
      addKioskPart(new THREE.BoxGeometry(w, 0.12, d), cornerTrim, 0, 0.06, 0);
      addKioskPart(new THREE.BoxGeometry(w - 0.10, 2.30, 0.11), kioskPanel, 0, 1.20, backZ);
      for (const side of [-1, 1]) {
        addKioskPart(new THREE.BoxGeometry(0.10, 2.28, d * 0.58), kioskPanel,
          side * (w / 2 - 0.05), 1.20, -toward * d * 0.20);
        addKioskPart(new THREE.BoxGeometry(0.11, 2.46, 0.11), cornerTrim,
          side * (w / 2 - 0.055), 1.35, frontZ - toward * 0.055);
      }
      // El mostrador llega exactamente a LOW: coincide con su collider y se
      // lee a escala humana, sin una franja invisible que reciba balas.
      addKioskPart(new THREE.BoxGeometry(w - 0.16, 0.94, 0.18), kioskPanel,
        0, 0.53, frontZ - toward * 0.06);
      addKioskPart(new THREE.BoxGeometry(w + 0.04, 0.10, 0.38), cornerTrim,
        0, 1.05, frontZ + toward * 0.11);
      const awning = addKioskPart(new THREE.BoxGeometry(w + 0.12, 0.12, 0.48),
        new THREE.MeshStandardMaterial({ color: awningColor, roughness: 0.74 }),
        0, 2.18, frontZ + toward * 0.20);
      awning.rotation.x = toward * -0.08;
      addKioskPart(new THREE.BoxGeometry(w + 0.18, 0.18, d + 0.18), cornerTrim, 0, 2.62, 0);
      addKioskPart(new THREE.BoxGeometry(w - 0.12, 0.34, 0.10), cornerDark,
        0, 2.40, frontZ - toward * 0.015);

      this._addMapSign(name, 0, 2.40, frontZ + toward * 0.045, frontRot,
        { w: w - 0.22, h: 0.27, bg: '#2a3438', fg: '#ead6ae', border: '#8d6b4f', parent: kiosk });

      // Producto visible sobre el mostrador: revistas o condimentos. Estos
      // detalles pequeños explican el uso sin ampliar la huella del puesto.
      if (name === 'NEWS') {
        for (let i = 0; i < 4; i++) {
          const magazine = new THREE.Mesh(
            new THREE.PlaneGeometry(0.25, 0.32),
            new THREE.MeshBasicMaterial({ color: paperColors[i], side: THREE.DoubleSide }),
          );
          magazine.position.set((i - 1.5) * 0.29, 0.49, frontZ + toward * 0.101);
          magazine.rotation.y = frontRot; kiosk.add(magazine);
        }
      } else {
        for (const [dx, color] of [[-0.20, 0xc64535], [0, 0xe4bc4f], [0.20, 0x5b8a50]]) {
          const bottle = new THREE.Mesh(
            new THREE.CylinderGeometry(0.035, 0.045, 0.22, 8),
            new THREE.MeshStandardMaterial({ color, roughness: 0.62 }),
          );
          bottle.position.set(dx, 1.20, frontZ - toward * 0.01); kiosk.add(bottle);
        }
      }
      this._registerBaseDecor(kiosk, 'kiosk', {
        x, z, rotation: 0, w, d, h: 2.71, decorLink,
      });
    };
    addSidewalkKiosk(-14.35, -29, 1.75, 1.75, 1, 'NEWS', 0x623b34,
      'kiosk:news:south-left');
    addSidewalkKiosk(14.35, 29, 1.75, 1.75, -1, 'NEWS', 0x623b34,
      'kiosk:news:north-right');
    addSidewalkKiosk(14.35, -26, 1.65, 1.65, 1, 'HOT DOGS', 0xb05f35,
      'kiosk:hotdog:south-right');
    addSidewalkKiosk(-14.35, 26, 1.65, 1.65, -1, 'HOT DOGS', 0xb05f35,
      'kiosk:hotdog:north-left');

    // Los dumpsters pertenecen ahora a pequeños patios de servicio. Puerta,
    // luz y pintura de carga los conectan con el edificio en vez de dejarlos
    // como props aislados en el límite del mapa.
    const serviceDoorMat = new THREE.MeshStandardMaterial({
      color: 0x303a3d, map: this._tex('shopShutter', 1, 1.5), metalness: 0.48,
      roughness: 0.55, side: THREE.DoubleSide,
    });
    const loadingPaint = new THREE.MeshBasicMaterial({ color: 0xc99a51, transparent: true, opacity: 0.42 });
    const serviceLamp = new THREE.MeshBasicMaterial({ color: 0xffb566 });
    const loadingEdges = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.45, 0.10), loadingPaint, 4);
    const loadingHatches = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.72, 0.12), loadingPaint, 8);
    const loadingTransform = new THREE.Object3D();
    let loadingEdgeIndex = 0; let loadingHatchIndex = 0;
    for (const [side, z] of [[-1, -8], [1, 8]]) {
      const wallX = side * (this.fx - 0.10);
      const rot = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(2.40, 2.60), serviceDoorMat);
      door.position.set(wallX - side * 0.015, 1.30, z); door.rotation.y = rot; this.mapGroup.add(door);
      const hood = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 2.66), curbMat);
      hood.position.set(wallX - side * 0.18, 2.75, z); this.mapGroup.add(hood);
      const fixture = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.42), serviceLamp);
      fixture.position.set(wallX - side * 0.22, 2.95, z); this.mapGroup.add(fixture);
      for (const dz of [-1.22, 1.22]) {
        loadingTransform.position.set(side * 14.45, 0.034, z + dz);
        loadingTransform.rotation.set(-Math.PI / 2, 0, Math.PI / 2); loadingTransform.updateMatrix();
        loadingEdges.setMatrixAt(loadingEdgeIndex++, loadingTransform.matrix);
      }
      for (let i = 0; i < 4; i++) {
        loadingTransform.position.set(side * (12.9 + i * 0.72), 0.034, z);
        loadingTransform.rotation.set(-Math.PI / 2, 0, side * 0.55); loadingTransform.updateMatrix();
        loadingHatches.setMatrixAt(loadingHatchIndex++, loadingTransform.matrix);
      }
    }
    loadingEdges.instanceMatrix.needsUpdate = true; loadingHatches.instanceMatrix.needsUpdate = true;
    this.mapGroup.add(loadingEdges, loadingHatches);

    // El MID del choke es una barricada de obra real y el MID lateral una
    // caseta cerrada: ambos reutilizan cover que ya existía, no llenan la vía.
    const barrierMat = new THREE.MeshLambertMaterial({ color: 0xd48734 });
    const blackMat = new THREE.MeshLambertMaterial({ color: 0x232a2f });
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffb34d });
    const addRoadwork = (x, z, rot) => {
      const group = new THREE.Group(); group.position.set(x, 0, z); group.rotation.y = rot;
      this._addVehicleProfile(group, [
        // El perfil queda justo dentro del collider (±0.45). Así el decal,
        // que nace 1.2 cm fuera de la cara física, nunca queda enterrado en
        // el bisel visual al observarlo desde un ángulo lateral.
        [-0.41, 0.10], [-0.41, 1.36], [-0.28, 1.76],
        [0.28, 1.76], [0.41, 1.36], [0.41, 0.10],
      ], 3.02, barrierMat, 0.035);
      for (const face of [-1, 1]) {
        for (const px of [-0.92, -0.30, 0.32, 0.94]) {
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.045), blackMat);
          stripe.position.set(px, 1.30, face * 0.475); stripe.rotation.z = 0.56; group.add(stripe);
        }
      }
      for (const px of [-1.30, 1.30]) {
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.80), blackMat);
        foot.position.set(px, 0.08, 0); group.add(foot);
        const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.10, 8), beaconMat);
        beacon.position.set(px, 1.84, 0); group.add(beacon);
      }
      this._registerBaseDecor(group, 'roadwork', {
        x, z, rotation: rot, w: 3.2, d: 0.9, h: BLOCK.MID,
      });
    };
    addRoadwork(-1.2, -8.7, 0); addRoadwork(1.2, 8.7, Math.PI);
    // Carritos de café, no tablas rotuladas: ruedas, mostrador, cafetera,
    // postes y toldo explican de inmediato la función del prop. Solo la base
    // LOW participa en cover; la estructura superior es ligera y decorativa.
    const coffeeBodyMat = new THREE.MeshStandardMaterial({ color: 0x754a34, metalness: 0.18, roughness: 0.72 });
    const coffeeTopMat = new THREE.MeshStandardMaterial({ color: 0x30383a, metalness: 0.52, roughness: 0.42 });
    const coffeeAwningMat = new THREE.MeshStandardMaterial({ color: 0xa8653d, roughness: 0.72 });
    const coffeeMetalMat = new THREE.MeshStandardMaterial({ color: 0x8d9695, metalness: 0.72, roughness: 0.28 });
    const coffeeWheelMat = new THREE.MeshStandardMaterial({ color: 0x111416, roughness: 0.92 });
    for (const [x, z, rot] of [[14.35, -8.5, 0], [-14.35, 8.5, Math.PI]]) {
      const cart = new THREE.Group(); cart.position.set(x, 0, z); cart.rotation.y = rot;
      const addCartPart = (geometry, material, px, py, pz) => {
        const part = new THREE.Mesh(geometry, material);
        part.position.set(px, py, pz); part.castShadow = true; part.receiveShadow = true;
        cart.add(part); return part;
      };
      // La base visual termina en 1.10 m, exactamente donde termina el LOW
      // que usa movimiento, cover y balística.
      addCartPart(new THREE.BoxGeometry(1.24, 0.86, 0.64), coffeeBodyMat, 0, 0.55, 0);
      addCartPart(new THREE.BoxGeometry(1.34, 0.10, 0.76), coffeeTopMat, 0, 1.05, 0);
      for (const px of [-0.47, 0.47]) for (const pz of [-0.36, 0.36]) {
        const wheel = addCartPart(new THREE.CylinderGeometry(0.14, 0.14, 0.08, 12),
          coffeeWheelMat, px, 0.18, pz);
        wheel.rotation.x = Math.PI / 2;
      }
      for (const px of [-0.55, 0.55]) for (const pz of [-0.27, 0.27]) {
        addCartPart(new THREE.BoxGeometry(0.055, 1.18, 0.055), coffeeMetalMat, px, 1.48, pz);
      }
      addCartPart(new THREE.BoxGeometry(1.52, 0.13, 0.90), coffeeAwningMat, 0, 2.09, 0);
      addCartPart(new THREE.BoxGeometry(0.34, 0.34, 0.28), coffeeMetalMat, 0.27, 1.27, 0.02);
      addCartPart(new THREE.BoxGeometry(0.24, 0.08, 0.16), coffeeTopMat, 0.27, 1.15, -0.20);
      for (const px of [-0.22, -0.08]) {
        addCartPart(new THREE.CylinderGeometry(0.045, 0.04, 0.13, 10),
          new THREE.MeshStandardMaterial({ color: 0xe7ddd0, roughness: 0.72 }), px, 1.18, -0.08);
      }
      this._addMapSign('COFFEE', 0, 1.91, -0.46, Math.PI,
        { w: 1.16, h: 0.28, bg: '#3d2920', fg: '#f0d4a1', border: '#a96f45', parent: cart });
      this._registerBaseDecor(cart, 'coffee', {
        x, z, rotation: rot, w: 1.30, d: 0.75, h: 2.2,
      });
    }

    // Postes continuos de extremo a extremo. La calle está cerrada al tráfico,
    // pero su infraestructura permanece completa y legible como una avenida.
    for (const z of [-35, -25, -15, -5, 5, 15, 25, 35]) {
      // Pegados al bordillo y fuera de la huella reducida de los kioscos.
      if (!this._addUrbanAsset('streetlight', -11.72, z,
        { scale: 1.21, decorLink: `streetlight:left:${z}` }))
        this._addUtilityPole(-11.72, z, { lamp: 0xffc27a, arm: 0.3 });
      if (!this._addUrbanAsset('streetlight', 11.72, z,
        { scale: 1.21, rotation: Math.PI, decorLink: `streetlight:right:${z}` }))
        this._addUtilityPole(11.72, z, { lamp: 0xffc27a, arm: -0.3 });
    }
    // La infraestructura exterior usa el mismo asset GLB streetlight que la
    // zona jugable. Solo pierde contraste por distancia y nunca crea collider.
    for (const dir of [-1, 1]) for (let depth = 0; depth < continuationModules; depth++) {
      const z = dir * (this.fz + 3 + depth * 10);
      for (const side of [-1, 1]) {
        const pole = this._addUrbanAsset('streetlight', side * 11.72, z, {
          scale: 1.21,
          rotation: side > 0 ? Math.PI : 0,
          castShadow: false,
          receiveShadow: false,
          capture: false,
        });
        if (pole) dimStreetObject(pole, Math.min(0.90, continuationShades[depth] + 0.18));
        else this._addUtilityPole(side * 11.72, z, {
          color: new THREE.Color(0x39414a).multiplyScalar(continuationShades[depth]).getHex(),
          lamp: new THREE.Color(0xffc27a).multiplyScalar(continuationShades[depth]).getHex(),
          arm: side > 0 ? -0.3 : 0.3,
        });
      }
    }
    // Cableado con caída suave entre postes: landmark vertical y profundidad
    // de calle real. TubeGeometry pequeño, lejos del volumen jugable.
    const cableMat = new THREE.MeshLambertMaterial({ color: 0x151a1e });
    for (const x of [-11.83, 11.83]) {
      for (let zi = -75; zi < 75; zi += 10) {
        for (const offset of [-0.10, 0.10]) {
          const cable = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
              new THREE.Vector3(x + offset, STREET_SCALE.lamp - 0.44, zi),
              new THREE.Vector3(x + offset, STREET_SCALE.lamp - 0.82, zi + 5),
              new THREE.Vector3(x + offset, STREET_SCALE.lamp - 0.44, zi + 10),
            ]), 8, 0.018, 5, false),
            cableMat,
          );
          this.mapGroup.add(cable);
        }
      }
    }
    // Hidrantes, parquímetros y señales concentran detalle sobre la acera.
    // Los hidrantes tienen un collider pequeño sin cover; señales y medidores
    // permanecen puramente visuales para no ensuciar la navegación.
    const streetMetal = new THREE.MeshStandardMaterial({ color: 0x30383d, metalness: 0.64, roughness: 0.4 });
    const hydrantMat = new THREE.MeshStandardMaterial({ color: 0x8e3e31, metalness: 0.45, roughness: 0.48 });
    for (const [x, z, decorLink] of [[-12.45, -11, 'hydrant:left'], [12.45, 11, 'hydrant:right']]) {
      if (this._addUrbanAsset('fireHydrant', x, z, { scale: 0.90, decorLink })) continue;
      const h = new THREE.Group(); h.position.set(x, 0, z);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.48, 9), hydrantMat);
      body.position.y = 0.24; h.add(body);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.12, 0.12, 9), hydrantMat);
      top.position.y = 0.52; h.add(top);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.38, 8), hydrantMat);
      arm.rotation.z = Math.PI / 2; arm.position.y = 0.32; h.add(arm); this.mapGroup.add(h);
    }
    for (const [x, z, side] of [[-12.55, -2, -1], [12.55, 2, 1], [-12.55, 34, -1], [12.55, -34, 1]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 2.8, 7), streetMetal);
      pole.position.set(x, 1.4, z); this.mapGroup.add(pole);
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(0.48, 0.72),
        new THREE.MeshBasicMaterial({ color: side < 0 ? 0xb7c1bd : 0xd4c6aa, side: THREE.DoubleSide }),
      );
      plate.position.set(x + side * 0.04, 2.34, z); plate.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      this.mapGroup.add(plate);
    }
    // Seis luces prácticas sin sombras mantienen legibles los módulos nuevos
    // húmedo y los volúmenes de vehículos respondan a la escena sin convertir
    // cada escaparate en un coste de iluminación independiente.
    for (let i = 0; i < 6; i++) {
      const z = -30 + i * 12;
      const x = i % 2 ? 11.1 : -11.1;
      const light = new THREE.PointLight(i % 2 ? 0xffb36b : 0xffc17d, 4.2, 13, 2);
      light.position.set(x, 2.75, z); light.castShadow = false; this.mapGroup.add(light);
    }
    // Edificios urbanos completos detrás de la muralla jugable. No se usan
    // como skins (su profundidad produciría clipping en la acera): desde la
    // calle añaden techos, volúmenes y variedad sin tocar colliders ni rutas.
    for (const [id, x, z, scale, rotation] of [
      ['apartmentBlock', -22.2, -22.8, 0.82, Math.PI / 2],
      ['apartmentBlock', 22.2, 22.8, 0.82, -Math.PI / 2],
      ['cornerStore', -22.8, 0.5, 0.86, Math.PI / 2],
      ['cornerStore', 22.8, -0.5, 0.86, -Math.PI / 2],
      ['shopfrontRow', -22.2, 12.8, 0.88, Math.PI / 2],
      ['shopfrontRow', 22.2, -12.8, 0.88, -Math.PI / 2],
    ]) this._addUrbanAsset(id, x, z, { scale, rotation, castShadow: false });

    // Skyline GLB: cuatro siluetas distintas sustituyen los prismas genéricos.
    // Siguen lejos del espacio jugable, sin collider ni sombras dinámicas.
    const winMat = new THREE.MeshLambertMaterial({ color: 0x4b5563, map: this._tex('windows', 2, 2) });
    for (const [id, x, z, w, h, scale, rotation] of [
      ['glassSkyscraper', -26, -14, 7, 15, 0.72, 0.18],
      ['glassSupertall', 27, -4, 8, 19, 0.60, -0.32],
      ['waterfrontTower', -25, 12, 6, 12, 0.68, 0.34],
      ['glassSkyscraper', 24, 20, 7, 16, 0.62, Math.PI + 0.12],
    ]) {
      if (this._addUrbanAsset(id, x, z, { scale, rotation, castShadow: false, receiveShadow: false })) continue;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 6), winMat);
      b.position.set(x, h / 2 - 0.5, z);
      this.mapGroup.add(b);
    }
  }

  // Mapa "Estación de Metro" (32×52): subterráneo de luz artificial. Dos
  // pares de VAGONES sobre el eje central con cruces entre ellos (rutas no
  // lineales), andenes con columnas, máquinas y bancas. El pedestal especial
  // queda en el cruce central — la zona más peligrosa.
  _buildMetro() {
    const { LOW, MID, HIGH } = BLOCK;
    const lowOpts = { color: 0x7f8a8d, top: 0xa5adaf };
    const midOpts = { color: 0x74807f, top: 0x9aa5a2 };
    const highOpts = { color: 0x5e696e, top: 0x7d878a }; // vagones
    const wallOpts = { mirror: false, color: 0x59636a, top: 0x6e777c };

    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // base
    this._box(0, -19, 6, 1, HIGH, highOpts);
    this._box(-4.8, -17.9, 2.2, 0.9, LOW, lowOpts);
    this._box(4.8, -17.9, 2.2, 0.9, LOW, lowOpts);

    // vagones del eje central (los cruces entre ellos son los chokes)
    this._box(-2.2, -11.5, 2.6, 7, HIGH, highOpts);
    this._box(2.6, -3.2, 2.6, 6, HIGH, highOpts);

    // columnas del andén (MID: bloquean pecho, permiten peek)
    this._box(-8, -14, 1.1, 1.1, MID, midOpts);
    this._box(-8, -7, 1.1, 1.1, MID, midOpts);
    this._box(8, -10.5, 1.1, 1.1, MID, midOpts);

    // mobiliario del andén
    this._box(-11, -17.5, 2.2, 0.9, LOW, lowOpts);  // máquinas expendedoras
    this._box(11.5, -13, 0.9, 2.2, LOW, lowOpts);
    this._box(6.5, -16.5, 2.4, 0.9, LOW, lowOpts);  // banca
    this._box(-12.5, -3, 2.6, 2.6, LOW, lowOpts);   // bloque de escaleras
    this._box(7.5, -1.8, 3, 0.9, MID, midOpts);     // barrera de andén

    this._decorMetro();
  }

  _decorMetro() {
    // Metro: los cuatro bloques HIGH centrales se convierten en vagones
    // reconocibles. La huella es exactamente la de la geometría que ya
    // bloquea/da cover; no se añade ningún tren decorativo que engañe al AI.
    for (const [cx, cz, w, d] of [
      [-2.2, -11.5, 2.6, 7], [2.2, 11.5, 2.6, 7],
      [2.6, -3.2, 2.6, 6], [-2.6, 3.2, 2.6, 6],
    ]) this._addTransitCar(cx, cz, w, d, { color: 0x4d6975, stripe: 0xe59b43 });

    // Rieles y durmientes: solo lenguaje de suelo, no colliders. Las franjas
    // de plataforma de ambos lados siguen siendo rutas abiertas alrededor de
    // los vagones y de sus cruces centrales.
    const railMat = new THREE.MeshStandardMaterial({ color: 0x3e474d, metalness: 0.72, roughness: 0.4 });
    const tieMat = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.90, metalness: 0.02 });
    for (const x of [-4.15, 4.15]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.045, this.fz * 2 - 2), railMat);
      rail.position.set(x, 0.025, 0); this.mapGroup.add(rail);
    }
    const ties = new THREE.InstancedMesh(new THREE.BoxGeometry(1.15, 0.04, 0.14), tieMat, 36);
    const tieM4 = new THREE.Matrix4();
    for (let i = 0; i < 36; i++) {
      tieM4.makeTranslation(0, 0.018, -24 + i * 1.36);
      ties.setMatrixAt(i, tieM4);
    }
    this.mapGroup.add(ties);

    // Columnas del andén: cilindros sobre los MID existentes; son un
    // landmark de plataforma y conservan las mismas esquinas de cover.
    const columnMat = new THREE.MeshStandardMaterial({ color: 0x6c7b80, metalness: 0.45, roughness: 0.58 });
    const collarMat = new THREE.MeshBasicMaterial({ color: 0x78b7ba });
    for (const [x, z] of [[-8, -14], [8, 14], [-8, -7], [8, 7], [8, -10.5], [-8, 10.5]]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.55, BLOCK.MID, 10), columnMat);
      col.position.set(x, BLOCK.MID / 2, z); col.castShadow = true; this.mapGroup.add(col);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.1, 10), collarMat);
      collar.position.set(x, 1.42, z); this.mapGroup.add(collar);
    }

    // Maquinas, banca y barrera existentes reciben lectura funcional. No se
    // inventa geometría de bloqueo: estas carcasas se apoyan en los LOW/MID.
    const kioskMat = new THREE.MeshStandardMaterial({ color: 0x34454b, metalness: 0.42, roughness: 0.54 });
    const screenMat = new THREE.MeshBasicMaterial({ color: 0x89d5d0 });
    for (const [x, z, rot] of [[-11, -17.5, 0], [11, 17.5, Math.PI], [11.5, -13, Math.PI / 2], [-11.5, 13, -Math.PI / 2]]) {
      const k = new THREE.Group(); k.position.set(x, 0, z); k.rotation.y = rot;
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.92, 0.76), kioskMat);
      body.position.y = 0.46; body.castShadow = true; k.add(body);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.32), screenMat);
      screen.position.set(0, 0.61, -0.386); k.add(screen);
      this.mapGroup.add(k);
    }
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x614f41, roughness: 0.82, metalness: 0.04 });
    for (const [x, z, rot] of [[6.5, -16.5, 0], [-6.5, 16.5, Math.PI]]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.22, 0.12, 0.34), benchMat);
      seat.position.set(x, 0.63, z); seat.rotation.y = rot; this.mapGroup.add(seat);
      for (const sx of [-0.8, 0.8]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.58, 0.1), railMat);
        leg.position.set(x + sx, 0.32, z); leg.rotation.y = rot; this.mapGroup.add(leg);
      }
    }

    // Señalética elevada: los nombres de zonas son landmarks jugables sin
    // competir con la mira. El centro sigue siendo el cruce de vagones.
    this._addMapSign('PLATFORM 01', -8.8, 3.85, -19.6, 0, { w: 3.1, h: 0.5, bg: '#17262b', fg: '#bde7e0', border: '#4d8f8d' });
    this._addMapSign('PLATFORM 02', 8.8, 3.85, 19.6, Math.PI, { w: 3.1, h: 0.5, bg: '#17262b', fg: '#bde7e0', border: '#4d8f8d' });
    this._addMapSign('EXIT', -12.5, 3.1, -4.34, Math.PI / 2, { w: 1.6, h: 0.42, bg: '#2b332c', fg: '#e9d176', border: '#6d724f' });
    this._addMapSign('EXIT', 12.5, 3.1, 4.34, -Math.PI / 2, { w: 1.6, h: 0.42, bg: '#2b332c', fg: '#e9d176', border: '#6d724f' });

    // baterías de lámparas colgantes (el techo es oscuridad de túnel)
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xdcefe6 });
    for (let z = -20; z <= 20; z += 8) {
      for (const x of [-9, 0, 9]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.3), stripMat);
        strip.position.set(x, 4.7, z);
        this.mapGroup.add(strip);
      }
    }
    // bocas de túnel oscuras tras los muros cortos
    const mouthMat = new THREE.MeshBasicMaterial({ color: 0x020304 });
    for (const s of [-1, 1]) {
      const mouth = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 0.4), mouthMat);
      mouth.position.set(0, 1.7, s * (this.fz + 1.3));
      this.mapGroup.add(mouth);
    }
    // franja de seguridad del borde de andén (plano, sin colisión)
    const hazMat = new THREE.MeshLambertMaterial({ map: this._tex('hazard', 8, 0.5) });
    for (const s of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 30), hazMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = Math.PI / 2;
      stripe.position.set(s * 5.2, 0.012, 0);
      this.mapGroup.add(stripe);
    }
  }

  // Mapa "Prisión" (44×60): patio central abierto con cadena de coberturas
  // bajas, BLOQUES DE CELDAS laterales (corredores interiores con puertas y
  // divisores) y torres de vigilancia en esquinas espejadas. Interior y
  // exterior conviven: el patio castiga cruzar, los corredores son CQC.
  _buildPrision() {
    const { LOW, MID, HIGH } = BLOCK;
    const lowOpts = { color: 0x8e9092, top: 0xb2b4b4 };
    const midOpts = { color: 0x7f8285, top: 0xa2a5a6 };
    const highOpts = { color: 0x74777b, top: 0x92959a };
    const wallOpts = { mirror: false, color: 0x6a6d71, top: 0x84878b };

    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // base + torre de vigilancia de esquina (bulto jugable HIGH)
    this._box(0, -22.8, 7.5, 1, HIGH, highOpts);
    this._box(-5.8, -21.6, 2.4, 0.9, LOW, lowOpts);
    this._box(5.8, -21.6, 2.4, 0.9, LOW, lowOpts);
    this._box(-17, -24, 3, 3, HIGH, highOpts);

    // bloque de celdas OESTE: muro interior con puerta + divisores de celda
    this._box(-13.5, -17, 1, 5, HIGH, highOpts);
    this._box(-13.5, -8, 1, 5, HIGH, highOpts);
    this._box(-20.2, -17, 3.4, 0.8, MID, midOpts);
    this._box(-20.2, -9, 3.4, 0.8, MID, midOpts);

    // bloque de celdas ESTE (mitad sur; el espejo crea el norte-oeste)
    this._box(14, -12, 1, 6, HIGH, highOpts);
    this._box(20.3, -12, 3.2, 0.8, MID, midOpts);

    // patio: cadena de coberturas bajas + jardinera + banca
    this._box(-3, -13, 2.6, 0.9, LOW, lowOpts);
    this._box(2, -9.5, 2.6, 0.9, LOW, lowOpts);
    this._box(-2.5, -6, 2.6, 0.9, LOW, lowOpts);
    this._box(6.5, -14.5, 3, 1, MID, midOpts);
    this._box(8, -4.5, 2.4, 0.9, LOW, lowOpts);

    // pilar de flanco + aproximación al centro
    this._box(9.5, -8.5, 1.2, 1.2, HIGH, highOpts);
    this._box(4.5, -2.6, 3.2, 0.9, MID, midOpts);
    this._box(-5, -1.4, 2.4, 0.9, LOW, lowOpts);

    this._decorPrision();
  }

  _decorPrision() {
    // Prisión: los muros HIGH laterales adquieren frentes de celdas y los
    // MID del borde se vuelven divisores/mesas de patio. Todo queda sobre los
    // AABB existentes para no encoger pasillos ni sorprender a los bots.
    const cabMat = new THREE.MeshStandardMaterial({
      color: 0x5d6165, map: this._tex('concrete', 2, 2),
      bumpMap: this._detailTex('concrete', 2, 2), bumpScale: 0.022,
      roughness: 0.80, metalness: 0.04,
    });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3c9 });
    for (const s of [-1, 1]) {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.4, 2.4), cabMat);
      cab.position.set(s * 17, 3.75, s * 24);
      this.mapGroup.add(cab);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.2, 2.9), cabMat);
      roof.position.set(s * 17, 4.55, s * 24);
      this.mapGroup.add(roof);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.14), lampMat);
      lamp.position.set(s * 17, 3.7, s * (24 - 1.26));
      this.mapGroup.add(lamp);
    }
    // postes de reflectores perimetrales
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4d50 });
    for (const [x, z] of [[-21, 8], [21, -8], [-10, 29], [10, -29]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 5.2, 6), poleMat);
      pole.position.set(x, 2.6, z);
      this.mapGroup.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.3, 0.3), lampMat);
      head.position.set(x, 5.1, z);
      this.mapGroup.add(head);
    }

    // Rejas visibles frente a los bloques de celdas. Paneles de barras muy
    // finos, sin colisión adicional: desde lejos se lee "cell block", y de
    // cerca siguen estando las mismas esquinas de blindfire de antes.
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x3e464b, metalness: 0.78, roughness: 0.38 });
    const warningMat = new THREE.MeshBasicMaterial({ color: 0xd2a648 });
    const addBars = (x, z, length, alongZ, face) => {
      const group = new THREE.Group();
      group.position.set(x, 0, z);
      const count = Math.max(3, Math.floor(length / 0.55));
      for (let i = 0; i <= count; i++) {
        const t = -length / 2 + (i / count) * length;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(alongZ ? 0.055 : 0.055, 2.55, alongZ ? 0.055 : 0.055), steelMat);
        bar.position.set(alongZ ? face : t, 1.28, alongZ ? t : face); group.add(bar);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(alongZ ? 0.09 : length, 0.09, alongZ ? length : 0.09), steelMat);
      top.position.set(alongZ ? face : 0, 2.48, alongZ ? 0 : face); group.add(top);
      const low = top.clone(); low.position.y = 0.22; group.add(low);
      this.mapGroup.add(group);
    };
    addBars(-12.98, -17, 5, true, 0);
    addBars(-12.98, -8, 5, true, 0);
    addBars(12.98, 17, 5, true, 0);
    addBars(12.98, 8, 5, true, 0);
    addBars(13.48, -12, 6, true, 0);
    addBars(-13.48, 12, 6, true, 0);

    // Divisores bajos = mesas de patio y bancos. Las franjas de riesgo dan
    // lectura de zona restringida sin cambiar el cover MEDIO que ya existe.
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x596064, metalness: 0.38, roughness: 0.58 });
    for (const [x, z, w, d, rot] of [
      [-20.2, -17, 3.2, 0.74, 0], [20.2, 17, 3.2, 0.74, Math.PI],
      [-20.2, -9, 3.2, 0.74, 0], [20.2, 9, 3.2, 0.74, Math.PI],
      [6.5, -14.5, 2.82, 0.84, 0], [-6.5, 14.5, 2.82, 0.84, Math.PI],
    ]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), benchMat);
      seat.position.set(x, 0.68, z); seat.rotation.y = rot; seat.castShadow = true; this.mapGroup.add(seat);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.08, 0.045), warningMat);
      stripe.position.set(x, 1.07, z - d * 0.5 - 0.02); stripe.rotation.y = rot; this.mapGroup.add(stripe);
    }

    // Puertas, números y cámaras: landmarks que diferencian bloque de celdas,
    // patio y acceso de servicio sin sobrecargar el espacio central.
    this._addMapSign('CELL BLOCK A', -13.02, 2.75, -17, Math.PI / 2,
      { w: 2.8, h: 0.42, bg: '#252d31', fg: '#e1c26e', border: '#626d70' });
    this._addMapSign('CELL BLOCK B', 13.02, 2.75, 17, -Math.PI / 2,
      { w: 2.8, h: 0.42, bg: '#252d31', fg: '#e1c26e', border: '#626d70' });
    this._addMapSign('YARD', -1.75, 3.25, -22.28, 0,
      { w: 2.0, h: 0.45, bg: '#32383b', fg: '#f1e6c4', border: '#a1a9a7' });
    this._addMapSign('YARD', 1.75, 3.25, 22.28, Math.PI,
      { w: 2.0, h: 0.45, bg: '#32383b', fg: '#f1e6c4', border: '#a1a9a7' });

    const cameraMat = new THREE.MeshStandardMaterial({ color: 0x30383d, metalness: 0.65, roughness: 0.4 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xd85342 });
    for (const [x, z, ry] of [[-21.62, -4, Math.PI / 2], [21.62, 4, -Math.PI / 2], [-8, -29.6, 0], [8, 29.6, Math.PI]]) {
      const cam = new THREE.Group(); cam.position.set(x, 0, z); cam.rotation.y = ry;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 0.07), cameraMat);
      arm.position.set(0.2, 2.58, 0); cam.add(arm);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.22), cameraMat);
      body.position.set(0.42, 2.5, 0); cam.add(body);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.1), eyeMat);
      eye.position.set(0.57, 2.5, 0); cam.add(eye);
      this.mapGroup.add(cam);
    }

    // Líneas de patio desvaídas: storytelling de un lugar funcional que fue
    // cerrado tras un disturbio; son planos y por tanto no afectan combate.
    const paint = new THREE.MeshBasicMaterial({ color: 0x839092, transparent: true, opacity: 0.22 });
    const court = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.18, 32), paint);
    court.rotation.x = -Math.PI / 2; court.position.set(0, 0.014, 0); this.mapGroup.add(court);
    const courtLine = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 4.3), paint);
    courtLine.rotation.x = -Math.PI / 2; courtLine.position.set(0, 0.015, 0); this.mapGroup.add(courtLine);
  }

  // Mapa "Pueblo Abandonado" (52×68): el más ABIERTO. Casas en ruinas con
  // muros en L (altura variada HIGH/MID), escombros bajos dispersos, una
  // plaza central despejada para el pedestal y casonas altas cerca del
  // centro que parten las diagonales largas.
  _buildPueblo() {
    const { LOW, MID, HIGH } = BLOCK;
    const lowOpts = { color: 0x9a8672, top: 0xc4ac8c };
    const midOpts = { color: 0x8d7a66, top: 0xb59d7f };
    const highOpts = { color: 0x86735f, top: 0xa89075 };
    const wallOpts = { mirror: false, color: 0x77664f, top: 0x93805f };

    this._box(0, -this.fz - 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(0, this.fz + 0.4, this.fx * 2 + 2, 0.8, HIGH, wallOpts);
    this._box(-this.fx - 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);
    this._box(this.fx + 0.4, 0, 0.8, this.fz * 2 + 2, HIGH, wallOpts);

    // base
    this._box(0, -26.5, 8, 1, HIGH, highOpts);
    this._box(-6, -25.4, 2.6, 0.9, LOW, lowOpts);
    this._box(6, -25.4, 2.6, 0.9, LOW, lowOpts);

    // casa en ruinas A (L alta con remanente bajo: pared rota)
    this._box(-12, -19, 6, 1, HIGH, highOpts);
    this._box(-14.5, -16, 1, 5, HIGH, highOpts);
    this._box(-9.5, -16.5, 1, 3, LOW, lowOpts);

    // casa en ruinas B (L mediana)
    this._box(10, -14, 1, 6, MID, midOpts);
    this._box(13, -11.5, 5, 1, MID, midOpts);
    this._box(8.5, -9.8, 2.4, 0.9, LOW, lowOpts);

    // escombros dispersos (cobertura baja del campo abierto)
    this._box(-4, -12, 2.2, 1.6, LOW, lowOpts);
    this._box(3, -19, 2.6, 0.9, LOW, lowOpts);
    this._box(-1.5, -7, 2.6, 0.9, LOW, lowOpts);
    this._box(18, -6, 2.2, 2.2, LOW, lowOpts);   // plataforma saltable
    this._box(-19, -12, 0.9, 3, LOW, lowOpts);

    // fragmentos de muro a media cancha
    this._box(-7, -3.5, 3.4, 0.9, MID, midOpts);
    this._box(5.5, -5.2, 3, 0.9, MID, midOpts);

    // casona alta cerca del centro (rompe la diagonal larga)
    this._box(16, -2, 1, 7, HIGH, highOpts);

    // plaza: cobertura baja orbitando el pedestal central
    this._box(-4.5, 0.8, 2.4, 0.9, LOW, lowOpts);

    this._decorPueblo();
  }

  _decorPueblo() {
    // Pueblo: las L de bloque se convierten en casas abiertas y derruidas. Los
    // huecos, marcos y tejados rotos se apoyan sobre muros existentes: cuentan
    // historia sin abrir atajos visuales que no existan en la colisión.
    const ruinFaceMat = new THREE.MeshStandardMaterial({
      color: 0x927a61, map: this._tex('brick', 2.5, 1.3),
      bumpMap: this._detailTex('brick', 2.5, 1.3), bumpScale: 0.036,
      roughness: 0.91, metalness: 0.01,
    });
    const charMat = new THREE.MeshLambertMaterial({ color: 0x3d3027 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x6a4a3b });
    const addRuinFace = (x, y, z, w, h, ry, windows = 1) => {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), ruinFaceMat);
      face.position.set(x, y, z); face.rotation.y = ry; this.mapGroup.add(face);
      for (let i = 0; i < windows; i++) {
        const at = (i - (windows - 1) / 2) * Math.min(1.35, w / (windows + 0.5));
        const win = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(0.72, w / 3), 0.86), charMat);
        if (Math.abs(Math.sin(ry)) > 0.5) win.position.set(x + Math.sign(Math.sin(ry)) * 0.014, y + 0.2, z + at);
        else win.position.set(x + at, y + 0.2, z + Math.cos(ry) * 0.014);
        win.rotation.y = ry; this.mapGroup.add(win);
      }
    };
    // Fachadas hacia el espacio jugable.
    addRuinFace(-12, 1.6, -18.485, 5.75, 2.75, Math.PI, 2);
    addRuinFace(12, 1.6, 18.485, 5.75, 2.75, 0, 2);
    addRuinFace(-13.985, 1.6, -16, 4.75, 2.75, Math.PI / 2, 1);
    addRuinFace(13.985, 1.6, 16, 4.75, 2.75, -Math.PI / 2, 1);
    addRuinFace(9.485, 1.03, -14, 5.65, 1.72, -Math.PI / 2, 2);
    addRuinFace(-9.485, 1.03, 14, 5.65, 1.72, Math.PI / 2, 2);
    // Dos fragmentos de techo inclinado sobre las paredes HIGH: se ven desde
    // la plaza, pero están altos y pegados al volumen que ya es sólido.
    for (const [x, z, ry] of [[-12, -19.18, 0], [12, 19.18, Math.PI]]) {
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.16, 1.35), roofMat);
      roof.position.set(x, 3.12, z); roof.rotation.set(0, ry, ry ? -0.18 : 0.18); roof.castShadow = true;
      this.mapGroup.add(roof);
    }

    // Escombros sobre las coberturas LOW existentes. Su silueta irregular
    // elimina la lectura de "caja" y sigue dando la misma progresión segura.
    const rubbleMat = new THREE.MeshLambertMaterial({ color: 0x806953 });
    const rubble = [
      [-4, -12, 1.05], [4, 12, 1.05], [3, -19, 0.95], [-3, 19, 0.95],
      [-1.5, -7, 1.0], [1.5, 7, 1.0], [18, -6, 1.05], [-18, 6, 1.05],
      [-19, -12, 0.9], [19, 12, 0.9], [-4.5, 0.8, 0.95], [4.5, -0.8, 0.95],
    ];
    const rubbleGeo = new THREE.DodecahedronGeometry(0.65, 0);
    for (const [x, z, s] of rubble) {
      for (const [ox, oz, sc] of [[-0.35, -0.1, 0.7], [0.22, 0.16, 0.85], [0.05, -0.38, 0.56]]) {
        const r = new THREE.Mesh(rubbleGeo, rubbleMat);
        r.position.set(x + ox * s, 0.32 * sc * s, z + oz * s);
        r.scale.set(sc * s, sc * 0.72 * s, sc * s); r.rotation.set(0.12, x * 0.19 + z * 0.08, 0.08);
        r.castShadow = true; this.mapGroup.add(r);
      }
    }

    // Calle de pueblo y señales: una plaza con rutas distinguibles (Casa
    // Rota / Mercado) en vez de una cuadrícula de ladrillo indistinta.
    const roadMat = new THREE.MeshBasicMaterial({ color: 0x6c6254, transparent: true, opacity: 0.22 });
    const roadA = new THREE.Mesh(new THREE.PlaneGeometry(5.4, this.fz * 2 - 3), roadMat);
    roadA.rotation.x = -Math.PI / 2; roadA.position.set(0, 0.014, 0); this.mapGroup.add(roadA);
    const roadB = new THREE.Mesh(new THREE.PlaneGeometry(this.fx * 2 - 4, 3.6), roadMat);
    roadB.rotation.x = -Math.PI / 2; roadB.position.set(0, 0.015, 0); this.mapGroup.add(roadB);
    this._addMapSign('MARKET', -11.95, 3.08, -18.47, 0, { w: 2.2, h: 0.4, bg: '#593b2c', fg: '#ecd49f', border: '#a17754' });
    this._addMapSign('MARKET', 11.95, 3.08, 18.47, Math.PI, { w: 2.2, h: 0.4, bg: '#593b2c', fg: '#ecd49f', border: '#a17754' });
    this._addMapSign('OLD MILL', -14.02, 3.06, -16, Math.PI / 2, { w: 1.9, h: 0.36, bg: '#593b2c', fg: '#ecd49f', border: '#a17754' });
    this._addMapSign('OLD MILL', 14.02, 3.06, 16, -Math.PI / 2, { w: 1.9, h: 0.36, bg: '#593b2c', fg: '#ecd49f', border: '#a17754' });

    // postes de electricidad y cableado visual junto a los bordes: dan edad
    // y escala sin cruzar las rutas o producir hitboxes invisibles.
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x302d29 });
    for (const [x, z, arm] of [[-25.25, -20, 0.35], [25.25, 20, -0.35], [-25.25, 13, 0.35], [25.25, -13, -0.35]]) {
      this._addUtilityPole(x, z, { height: 4.35, lamp: 0xffc66e, arm });
    }
    for (const [a, b] of [[[-25.25, -20], [-25.25, 13]], [[25.25, 20], [25.25, -13]]]) {
      const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 5), wireMat);
      wire.position.set((a[0] + b[0]) / 2, 4.02, (a[1] + b[1]) / 2);
      wire.rotation.z = Math.PI / 2; wire.rotation.y = -Math.atan2(dz, dx); this.mapGroup.add(wire);
    }

    // árboles secos: tronco inclinado + copa rala oscura
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4d4034 });
    const canopyMat = new THREE.MeshLambertMaterial({ color: 0x54503c });
    for (const [x, z, lean] of [[-21, -22, 0.2], [20, 23, -0.25], [-22, 16, 0.12], [22, -18, -0.1]]) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 3.6, 6), trunkMat);
      trunk.position.set(x, 1.8, z);
      trunk.rotation.z = lean;
      this.mapGroup.add(trunk);
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(1.1 - i * 0.25, 0.5, 1.1 - i * 0.25), canopyMat);
        c.position.set(x + lean * (2.4 + i), 3.1 + i * 0.55, z);
        this.mapGroup.add(c);
      }
    }
    // ruinas de silueta fuera del muro
    const ruinMat = new THREE.MeshStandardMaterial({
      color: 0x8a7a63, map: this._tex('brick', 4, 3),
      bumpMap: this._detailTex('brick', 4, 3), bumpScale: 0.038,
      roughness: 0.92, metalness: 0.01,
    });
    for (const [x, z, w, h] of [[-32, -10, 6, 5], [33, 4, 7, 6], [-30, 22, 5, 4], [31, -24, 6, 5]]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, h, 5), ruinMat);
      r.position.set(x, h / 2 - 0.8, z);
      this.mapGroup.add(r);
    }
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

    // Todas las huellas viven en collision-layouts.js: cliente y servidor
    // online consumen exactamente la misma geometría.
    buildSharedCollision(this, 'fortaleza', {
      low: lowOpts, mid: midOpts, high: highOpts, wall: wallOpts,
    });

    this._decorFortaleza();
  }

  // Ambiente de fortaleza: TODO decorativo (cero colisión, cero cambio de
  // gameplay) — almenas instanciadas, torreones de esquina, estandartes,
  // braseros y torreones lejanos de silueta.
  _decorFortaleza() {
    const { HIGH } = BLOCK;
    const stoneMat = new THREE.MeshStandardMaterial({
      color: 0x898176, map: this._tex('stone', 1, 0.5),
      bumpMap: this._detailTex('stone', 1, 0.5), bumpScale: 0.042,
      roughness: 0.88, metalness: 0.01,
    });
    const towerMat = new THREE.MeshStandardMaterial({
      color: 0x827b72, map: this._tex('stone', 8, 5),
      bumpMap: this._detailTex('stone', 8, 5), bumpScale: 0.045,
      roughness: 0.89, metalness: 0.01,
    });

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
        new THREE.MeshStandardMaterial({
          color: 0x77736d, map: this._tex('stone', 10, 6),
          bumpMap: this._detailTex('stone', 10, 6), bumpScale: 0.040,
          roughness: 0.90, metalness: 0.01,
        })
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

    buildSharedCollision(this, 'azoteas', {
      ac: acOpts, vent: ventOpts, hut: hutOpts, glass: glassOpts, wall: wallOpts,
    });

    // Landmarks y skins se conservan aparte: solo sus huellas físicas forman
    // parte del manifiesto compartido.
    this._azoteasLandmarks = {
      crane: { x: -25, z: -6.8 }, generator: { x: 25, z: 6.8 },
    };
    this._solarCoverSpots = [
      { x: -4, z: -9.5, ry: 0 }, { x: 4, z: 9.5, ry: Math.PI },
    ];

    // --- CENTRO: helipuerto DESPEJADO (regla de Chuck) — cero obstáculos ni
    // decoración dentro del pad; el cover vive en el anillo de media cancha
    this.surfaceZones.push({ kind: 'helipad', ...HELIPAD });
    // La pared y la baranda del propio octágono forman el cover. Los lados
    // norte/sur dejan un hueco central para las rampas; los otros seis lados
    // son continuos. El collider llega hasta la parte superior de la baranda,
    // pero su altura táctica sigue siendo LOW medida desde la plataforma.
    this._helipadSegments = [];
    for (const segment of helipadSegments()) {
      const wall = { ...segment, coverH: LOW, surface: 'metal' };
      this._helipadSegments.push(wall);
      this.segmentColliders.push(wall);
      for (const side of [1, -1]) {
        const sn = { x: wall.n.x * side, z: wall.n.z * side };
        const off = wall.half * side;
        this.faces.push({
          n: sn,
          a: { x: wall.a.x + wall.n.x * off, z: wall.a.z + wall.n.z * off },
          b: { x: wall.b.x + wall.n.x * off, z: wall.b.z + wall.n.z * off },
          h: wall.coverH,
          baseY: HELIPAD.height,
          topY: wall.h,
          kind: 'railing',
          collider: wall,
        });
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

    // Señalización de acceso y conduits de mantenimiento en los extremos. La
    // información queda fuera del helipuerto y anclada a las casetas HIGH: el
    // centro conserva por completo su lectura abierta y su valor de riesgo.
    this._addMapSign('ROOFTOP ACCESS', 0, 2.7, -30.73, 0,
      { w: 3.8, h: 0.42, bg: '#172535', fg: '#b8d9ea', border: '#4b7588' });
    this._addMapSign('ROOFTOP ACCESS', 0, 2.7, 30.73, Math.PI,
      { w: 3.8, h: 0.42, bg: '#172535', fg: '#b8d9ea', border: '#4b7588' });
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x405865, metalness: 0.74, roughness: 0.4 });
    const valveMat = new THREE.MeshBasicMaterial({ color: 0xd99a37 });
    for (const [x, z, ry] of [[-27, -23.5, 0], [27, 23.5, Math.PI]]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 4.2, 8), pipeMat);
      pipe.rotation.z = Math.PI / 2; pipe.position.set(x, 1.34, z); pipe.rotation.y = ry; this.mapGroup.add(pipe);
      const valve = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.055, 5, 10), valveMat);
      valve.position.set(x, 1.34, z); valve.rotation.x = Math.PI / 2; this.mapGroup.add(valve);
    }

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
    // Mapa por datos: los spawns son marcadores colocados en el editor. El
    // juego siempre pide 4 por equipo, así que se repiten en ciclo si hay
    // menos (y sobran los extra) — un mapa con 1 spawn por bando funciona.
    if (this.customMap) {
      const s = spawnsOf(this.customMap);
      for (const team of ['red', 'blue']) {
        const list = s[team];
        if (!list.length) continue;
        for (let i = 0; i < 4; i++) this.spawns[team].push({ ...list[i % list.length] });
      }
      if (this.spawns.red.length && this.spawns.blue.length) return;
      // sin marcadores: caer al reparto por defecto para no dejar el mapa roto
      this.spawns.red.length = 0; this.spawns.blue.length = 0;
    }
    // spawns FIJOS por mapa con bolsillo respecto al muro trasero (la cámara
    // no debe chocar la muralla al nacer). El server duplica esta tabla en
    // spawnSet() — mantener ambos sincronizados.
    const z = MAP_RUNTIME[this.layout]?.spawnZ ?? this.fz - 1.6;
    for (let i = 0; i < 4; i++) {
      const x = -3.6 + i * 2.4;
      // convención: facing = (-sin yaw, -cos yaw) → yaw π mira a +z, yaw 0 a -z
      this.spawns.red.push({ x, z: -z, yaw: Math.PI });   // miran hacia +z
      this.spawns.blue.push({ x: -x, z, yaw: 0 });        // miran hacia -z
    }
  }

  // ---------- física ----------

  _getImpactReceivers() {
    if (this._impactReceivers) return this._impactReceivers;
    const receivers = [];
    this.mapGroup?.traverse((object) => {
      if (!object.isMesh || !object.geometry || object.userData?.noBulletDecal) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const hasVisibleSurface = materials.some((material) => material &&
        material.visible !== false && material.colorWrite !== false &&
        material.blending !== THREE.AdditiveBlending &&
        (!material.transparent || material.opacity >= 0.35));
      if (hasVisibleSurface) receivers.push(object);
    });
    this._impactReceivers = receivers;
    return receivers;
  }

  // La colisión de gameplay usa AABBs deliberadamente simples y estables.
  // Para el decal hacemos un segundo raycast, exclusivamente visual, dentro
  // de una ventana pequeña alrededor del contacto físico. Así el daño sigue
  // obedeciendo al collider, pero la marca queda sobre el capó inclinado,
  // vidrio, bus, fachada o prop real y no flotando sobre la caja invisible.
  projectImpactSurface(origin, contactPoint, _fallbackNormal, surface = 'concrete') {
    if (!origin || !contactPoint || !this.mapGroup) return null;
    IMPACT_DIR.copy(contactPoint).sub(origin);
    const contactDistance = IMPACT_DIR.length();
    if (!Number.isFinite(contactDistance) || contactDistance < 0.001) return null;
    IMPACT_DIR.multiplyScalar(1 / contactDistance);

    IMPACT_RAY.set(origin, IMPACT_DIR);
    IMPACT_RAY.near = Math.max(0.001, contactDistance - 0.75);
    IMPACT_RAY.far = contactDistance + 1.50;
    const intersections = IMPACT_RAY.intersectObjects(this._getImpactReceivers(), false);
    const hit = intersections.find((candidate) => {
      let object = candidate.object;
      while (object && object !== this.mapGroup) {
        if (!object.visible) return false;
        object = object.parent;
      }
      return true;
    });
    if (!hit?.face) return null;

    if (hit.instanceId !== undefined && hit.instanceId !== null && hit.object.isInstancedMesh) {
      hit.object.getMatrixAt(hit.instanceId, IMPACT_INSTANCE);
      IMPACT_WORLD.multiplyMatrices(hit.object.matrixWorld, IMPACT_INSTANCE);
    } else {
      IMPACT_WORLD.copy(hit.object.matrixWorld);
    }
    const normal = hit.face.normal.clone()
      .applyNormalMatrix(IMPACT_NORMAL_MATRIX.getNormalMatrix(IMPACT_WORLD)).normalize();
    // Una lámina DoubleSide conserva su normal geométrica original. El decal
    // siempre debe mirar hacia el origen del disparo.
    if (normal.dot(IMPACT_DIR) > 0) normal.negate();
    return { point: hit.point.clone(), normal, surface };
  }

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

    const groundSurface =
      (this.theme ?? this.layout) === 'fortaleza' || (this.theme ?? this.layout) === 'pueblo' ? 'stone' : 'concrete';
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
  groundHeight(p, r = 0, y = 0) {
    let g = 0;
    for (const zone of this.surfaceZones) {
      if (zone.kind !== 'helipad') continue;
      const ax = Math.abs(p.x), az = Math.abs(p.z);
      const insideDeck = ax <= zone.edge && az <= zone.edge && ax + az <= zone.diagonal;
      let h = insideDeck ? zone.height : 0;
      // Rampas norte/sur: transición progresiva para jugadores y bots.
      // El círculo recibe soporte al tocar la rampa, no cuando su centro ya
      // atravesó el costado. El controller puede así rechazar un step-up
      // lateral antes de que medio cuerpo quede dentro de la geometría.
      if (ax - r <= zone.rampHalfWidth && az > zone.edge && az <= zone.edge + zone.rampLength) {
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
  resolveCircle(p, r, y = 0, ignoredCollider = null) {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.colliders) {
        if (c === ignoredCollider) continue;
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
        if (c === ignoredCollider) continue;
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
