// Efectos de combate: tracers por equipo, fogonazos por arma, impactos por
// superficie, explosiones por capas, restos y polvo de movimiento.
//
// Todo vive en pools fijos creados en el constructor (técnica de Crashterra,
// src/fx): partículas animadas en GPU en un ring buffer (1 draw call),
// tracers (1), anillos (1), restos iluminados (2: lascas y casquillos),
// decals (1) y fogonazos con forma (mallas en pool, 2-3 frames de vida).
// Un evento solo escribe en arrays tipados: no crea geometrías, materiales
// ni luces. Las dos luces de FX existen siempre (intensidad 0 en reposo).
import * as THREE from 'three';
import { T, createAtlas } from './atlas.js';
import {
  Chunks, createFlashCross, createFlashMaterial, createFlashPool, createFxUniforms,
  createRingPool, createSpritePool, createTracerPool,
} from './pools.js';

const DECAL_MAX = 96;
const DECAL_LIFE = 22;
const DECAL_FADE = 4;
const PLUS_Z = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const IMPACT_COLORS = {
  concrete: new THREE.Color(0x6c7375),
  stone: new THREE.Color(0x786a58),
  brick: new THREE.Color(0x7a5244),
  tile: new THREE.Color(0x77736c),
  metal: new THREE.Color(0x8c7155),
  glass: new THREE.Color(0x8fa6ae),
  wood: new THREE.Color(0x5e4632),
};

function makePool(scene, count, factory) {
  const free = [];
  for (let i = 0; i < count; i++) {
    const obj = factory();
    obj.visible = false;
    obj.frustumCulled = false;
    scene.add(obj);
    free.push(obj);
  }
  return {
    free,
    acquire() { return this.free.pop() || null; },
    release(obj) {
      obj.visible = false;
      this.free.push(obj);
    },
  };
}

// Un solo InstancedMesh y un ring buffer: 96 impactos cuestan un draw call,
// nunca crean/destruyen meshes y la marca más antigua se reutiliza primero.
class ImpactDecalPool {
  constructor(scene, max = DECAL_MAX) {
    this.max = max;
    this.cursor = 0;
    this.activeCount = 0;
    this.slots = new Array(max).fill(null);
    this.opacity = new Float32Array(max);
    this.colors = new Float32Array(max * 3);

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(this.opacity, 1));
    geo.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(this.colors, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Los impactos pueden quedar sobre perfiles biselados muy finos. Al
      // dibujar ambas caras siguen obedeciendo al depth buffer, pero no
      // desaparecen al mirar la superficie desde un ángulo rasante.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      vertexShader: `
        attribute float instanceOpacity;
        attribute vec3 instanceColor;
        varying vec2 vUv;
        varying float vOpacity;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vOpacity = instanceOpacity;
          vColor = instanceColor;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vOpacity;
        varying vec3 vColor;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          float a = atan(p.y, p.x);
          float jag = sin(a * 7.0 + 0.8) * 0.018 + sin(a * 13.0) * 0.010;
          float outer = 1.0 - smoothstep(0.43 + jag, 0.50 + jag, r);
          float core = 1.0 - smoothstep(0.08, 0.29, r);
          float ring = smoothstep(0.24, 0.31, r) - smoothstep(0.38 + jag, 0.46 + jag, r);
          ring *= 0.68 + 0.32 * sin(a * 9.0 + 1.7);
          float alpha = max(core * 0.86, max(ring * 0.82, outer * 0.13)) * vOpacity;
          if (alpha < 0.025) discard;
          vec3 soot = vec3(0.018, 0.021, 0.023);
          vec3 color = mix(soot, vColor, clamp(ring * 1.35, 0.0, 0.72));
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });
    geo.userData.shared = true;
    mat.userData.shared = true;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = 'impact-decals';
    this.mesh.frustumCulled = false;
    // bajo las nubes de humo (3): una marca detrás del humo no se filtra
    this.mesh.renderOrder = 2;
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    // solo se envían hasta la marca viva más alta (0 sin marcas: el
    // programa igual se compila, three lo prepara antes de mirar count)
    this.mesh.count = 0;
    scene.add(this.mesh);

    this._normal = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._spin = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
  }

  add(point, normal, surface = 'concrete', sizeScale = 1) {
    if (!point || !normal) return;
    this._normal.set(normal.x, normal.y, normal.z);
    if (this._normal.lengthSq() < 0.5) return;
    this._normal.normalize();

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (!this.slots[i]) this.activeCount++;
    this.slots[i] = { age: 0, ttl: DECAL_LIFE + Math.random() * 4 };

    const base = surface === 'metal' ? 0.115 : surface === 'stone' ? 0.155 : 0.14;
    const scale = Math.max(0.5, Math.min(5, Number(sizeScale) || 1));
    const size = base * (0.82 + Math.random() * 0.36) * scale;
    // Separación mínima de la superficie para evitar z-fighting al usar FOV
    // estrecho. Sigue visualmente pegado al material (1.2 cm en el mundo).
    this._pos.copy(point).addScaledVector(this._normal, 0.012);
    this._quat.setFromUnitVectors(PLUS_Z, this._normal);
    this._spin.setFromAxisAngle(PLUS_Z, Math.random() * Math.PI * 2);
    this._quat.multiply(this._spin);
    this._scale.set(size, size * (0.86 + Math.random() * 0.2), 1);
    this._matrix.compose(this._pos, this._quat, this._scale);
    this.mesh.setMatrixAt(i, this._matrix);
    if (i + 1 > this.mesh.count) this.mesh.count = i + 1;

    const color = IMPACT_COLORS[surface] || IMPACT_COLORS.concrete;
    const tone = 0.82 + Math.random() * 0.28;
    this.colors[i * 3] = color.r * tone;
    this.colors[i * 3 + 1] = color.g * tone;
    this.colors[i * 3 + 2] = color.b * tone;
    this.opacity[i] = 0.92 + Math.random() * 0.08;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.instanceColor.needsUpdate = true;
    this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
  }

  update(dt) {
    let opacityDirty = false, matrixDirty = false, top = 0;
    for (let i = 0; i < this.max; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      top = i + 1;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        this.slots[i] = null;
        this.activeCount--;
        this.opacity[i] = 0;
        this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
        opacityDirty = matrixDirty = true;
      } else if (slot.age > slot.ttl - DECAL_FADE) {
        this.opacity[i] = Math.max(0, (slot.ttl - slot.age) / DECAL_FADE);
        opacityDirty = true;
      }
    }
    if (opacityDirty) this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    // un slot que caduca en este paso cuenta en top pero ya es nulo: se corrige al siguiente
    let live = top;
    while (live > 0 && !this.slots[live - 1]) live--;
    this.mesh.count = live;
  }

  clear() {
    this.cursor = 0;
    this.activeCount = 0;
    this.slots.fill(null);
    this.opacity.fill(0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, HIDDEN_MATRIX);
    this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 0;
  }
}

/* ----------------------------------------------------------- colores */

const lin = (hex, k = 1) => {
  const c = new THREE.Color(hex);
  return { r: c.r * k, g: c.g * k, b: c.b * k };
};
const C = {
  // equipos: SOLO los tracers, chispas de armadura y restos de equipo los usan
  teamRed: lin(0xe8402f),
  teamBlue: lin(0x2f7fe8),
  neutral: lin(0xffc27a),
  white: lin(0xffffff),
  flash: lin(0xffc27a),
  flashHot: lin(0xffe2b0),
  flashSniper: lin(0xfff0d0),
  flashStun: lin(0xbfefff),
  fire: lin(0xff7a28),
  fireHot: lin(0xffc060),
  spark: lin(0xff9a48),
  sparkWhite: lin(0xfff2dc),
  ember: lin(0xff6a1c),
  smoke: lin(0x4e5054),
  smokeDark: lin(0x2c2d30),
  smokeLight: lin(0x9a9ca0),
  // polvo de material: más claro que la superficie (piedra pulverizada)
  concrete: lin(0xa0a4a5),
  stone: lin(0xae9c7e),
  brick: lin(0xa0644e),
  dirt: lin(0x8a7a62),
  wood: lin(0xa27a50),
  woodDust: lin(0xc4a47c),
  glass: lin(0xc6e2ea),
  brass: lin(0xd8a842),
  armorDark: lin(0x2e3238),
  armorGrey: lin(0x5a616b),
};
const SURFACE_DUST = {
  concrete: C.concrete, stone: C.stone, brick: C.brick, tile: C.concrete,
  wood: C.woodDust, glass: C.concrete, metal: C.smokeLight, cloth: C.dirt, grass: C.dirt,
};
// lascas más oscuras que su polvo: se recortan contra la pared de la que salen
const SURFACE_CHIP = Object.fromEntries(Object.entries(SURFACE_DUST)
  .map(([k, c]) => [k, { r: c.r * 0.5, g: c.g * 0.5, b: c.b * 0.5 }]));

/* ----------------------------------------------------------- presets */

const pre = (o) => ({
  cell: T.GLOW, variants: 1, life: [0.3, 0.5], size: [0.1, 0.2], grow: 1, speed: [1, 2], cone: Math.PI, up: 0, jit: 0,
  col: C.white, bright: 1, alpha: 1, m: 0, hot: 0, grav: 0, drag: 0, stretch: 0, spin: 0, fin: 0.02, fout: 0.3, floor: false,
  ...o,
});

// Energía (m = 1) en HDR: núcleos > 1 florecen con la cadena de imagen;
// sin ella fxOut los comprime conservando el tono.
const P = {
  sparkHot: pre({ cell: T.SPARK, life: [0.18, 0.4], size: [0.032, 0.05], grow: 0.6, speed: [4, 10], cone: 0.9, col: C.spark, bright: 5, m: 1, hot: 0.8, grav: -12, drag: 1.6, stretch: 0.028, fout: 0.35, floor: true }),
  sparkWhite: pre({ cell: T.SPARK, life: [0.1, 0.22], size: [0.028, 0.044], grow: 0.5, speed: [4, 10], cone: 1.0, col: C.sparkWhite, bright: 5, m: 1, hot: 1.4, grav: -8, drag: 2.5, stretch: 0.022, fout: 0.3 }),
  sparkTeam: pre({ cell: T.SPARK, life: [0.2, 0.38], size: [0.045, 0.07], grow: 0.5, speed: [3, 8], cone: 1.0, bright: 4, m: 1, hot: 0.9, grav: -9, drag: 2.2, stretch: 0.024, fout: 0.3, floor: true }),
  ember: pre({ cell: T.GLOW, life: [0.5, 1.0], size: [0.04, 0.065], grow: 0.5, speed: [1.5, 5], cone: 1.2, up: 1, col: C.ember, bright: 4, m: 1, hot: 0.8, grav: -3, drag: 1.5, fout: 0.5, floor: true }),
  flareWhite: pre({ cell: T.FLARE, life: [0.05, 0.08], size: [0.32, 0.44], grow: 1.4, speed: [0, 0], col: C.flashHot, bright: 3, m: 1, hot: 1.5, fin: 0.01, fout: 0.05 }),
  impactPop: pre({ cell: T.GLOW, life: [0.04, 0.06], size: [0.2, 0.28], grow: 1.6, speed: [0, 0], col: C.flashHot, bright: 2, m: 1, hot: 1, fin: 0.01, fout: 0.1 }),
  muzzleCore: pre({ cell: T.GLOW, life: [0.035, 0.05], size: [0.18, 0.22], grow: 1.4, speed: [0, 0], col: C.flash, bright: 3, m: 1, hot: 1.6, fin: 0.01, fout: 0.15 }),
  muzzleStar: pre({ cell: T.STAR, life: [0.045, 0.06], size: [0.46, 0.56], grow: 1.25, speed: [0, 0], col: C.flash, bright: 3, m: 1, hot: 1.6, fin: 0.01, fout: 0.1 }),
  smokeMuzzle: pre({ cell: T.SMOKE, variants: 4, life: [0.5, 0.8], size: [0.08, 0.13], grow: 4, speed: [0.6, 2.2], cone: 0.35, col: C.smokeLight, alpha: 0.45, grav: 0.5, drag: 3.4, spin: 1.2, fin: 0.06, fout: 0.25 }),
  smokeTiny: pre({ cell: T.SMOKE, variants: 4, life: [0.45, 0.7], size: [0.1, 0.15], grow: 3, speed: [0.3, 0.9], cone: 0.7, col: C.smoke, alpha: 0.45, grav: 0.6, drag: 3, spin: 1, fin: 0.1, fout: 0.3, floor: true }),
  chip: pre({ cell: T.CHIP, life: [0.4, 0.75], size: [0.04, 0.065], grow: 1, speed: [2.5, 6], cone: 0.8, up: 0.8, alpha: 1, grav: -15, drag: 0.4, spin: 12, fin: 0.01, fout: 0.7, floor: true }),
  // golpe de material: sale rápido por la normal y se frena (la "nube" del impacto)
  impactBurst: pre({ cell: T.SMOKE, variants: 4, life: [0.35, 0.6], size: [0.24, 0.34], grow: 2.8, speed: [1.6, 3.6], cone: 0.45, alpha: 1, grav: 0.2, drag: 7, spin: 1.5, fin: 0.04, fout: 0.3, floor: true }),
  dustPuff: pre({ cell: T.DUST, variants: 2, life: [0.5, 0.9], size: [0.18, 0.28], grow: 3, speed: [0.6, 2.4], cone: 0.8, alpha: 0.8, grav: 0.2, drag: 3.5, spin: 0.8, fin: 0.06, fout: 0.3, floor: true }),
  dustStep: pre({ cell: T.DUST, variants: 2, life: [0.35, 0.6], size: [0.12, 0.18], grow: 3, speed: [0.4, 1.4], cone: 1.3, alpha: 0.4, grav: 0.1, drag: 4, spin: 0.6, fin: 0.06, fout: 0.3, floor: true }),
  dustBig: pre({ cell: T.SMOKE, variants: 4, life: [0.8, 1.3], size: [0.35, 0.6], grow: 3, speed: [1, 4], cone: 1.2, alpha: 0.55, grav: 0.3, drag: 2.4, spin: 0.4, fin: 0.06, fout: 0.3, floor: true }),
  shard: pre({ cell: T.SHARD, life: [0.4, 0.7], size: [0.05, 0.09], grow: 0.9, speed: [2, 5], cone: 0.9, up: 0.5, col: C.glass, bright: 1.4, alpha: 0.95, m: 0.35, hot: 2.2, grav: -14, drag: 0.5, spin: 14, fin: 0.01, fout: 0.6, floor: true }),
  glitter: pre({ cell: T.SPARK, life: [0.12, 0.28], size: [0.022, 0.034], grow: 0.6, speed: [2, 6], cone: 1.0, col: C.glass, bright: 4, m: 1, hot: 1.5, grav: -9, drag: 2, stretch: 0.012, fout: 0.3 }),
  splinter: pre({ cell: T.SPLINTER, life: [0.45, 0.8], size: [0.08, 0.13], grow: 1, speed: [2.2, 5], cone: 0.8, up: 0.6, col: C.wood, alpha: 1, grav: -14, drag: 0.6, stretch: 0.03, spin: 9, fin: 0.01, fout: 0.7, floor: true }),
  armorPuff: pre({ cell: T.SMOKE, variants: 4, life: [0.3, 0.5], size: [0.14, 0.22], grow: 2.6, speed: [0.6, 1.8], cone: 1.0, col: C.smokeLight, alpha: 0.5, grav: 0.4, drag: 4, spin: 1.5, fin: 0.05, fout: 0.3 }),
  // nube del color del equipo, medio emisiva: "le diste a ESE equipo"
  teamPuff: pre({ cell: T.SMOKE, variants: 4, life: [0.28, 0.45], size: [0.22, 0.32], grow: 2.4, speed: [0.8, 2.2], cone: 1.1, bright: 1.6, alpha: 0.7, m: 0.45, hot: 0.4, grav: 0.3, drag: 5, spin: 1.5, fin: 0.03, fout: 0.3 }),
  teamGlow: pre({ cell: T.GLOW, life: [0.08, 0.12], size: [0.36, 0.46], grow: 1.6, speed: [0, 0], bright: 2.5, m: 1, hot: 1.2, fin: 0.01, fout: 0.1 }),
  teamStar: pre({ cell: T.STAR, life: [0.07, 0.1], size: [0.7, 0.85], grow: 1.4, speed: [0, 0], bright: 3, m: 1, hot: 1.6, fin: 0.01, fout: 0.1 }),
  // explosión
  blastFlash: pre({ cell: T.GLOW, life: [0.08, 0.1], size: [2.4, 2.8], grow: 1.5, speed: [0, 0], col: C.fireHot, bright: 4, m: 1, hot: 2, fin: 0.01, fout: 0.05 }),
  blastStar: pre({ cell: T.STAR, life: [0.06, 0.08], size: [2.0, 2.4], grow: 1.4, speed: [0, 0], col: C.fireHot, bright: 3.5, m: 1, hot: 2, fin: 0.01, fout: 0.1 }),
  fireball: pre({ cell: T.FLAME, life: [0.28, 0.5], size: [0.9, 1.25], grow: 2.1, speed: [2.5, 6], cone: 1.3, up: 0.9, col: C.fire, bright: 4, m: 1, hot: 1.6, grav: 1.5, drag: 6, spin: 2.5, fin: 0.04, fout: 0.35 }),
  fireCore: pre({ cell: T.GLOW, life: [0.16, 0.24], size: [1.2, 1.6], grow: 1.6, speed: [0.5, 1.5], cone: Math.PI, col: C.fireHot, bright: 4, m: 1, hot: 2, drag: 6, fin: 0.02, fout: 0.3 }),
  blastSmoke: pre({ cell: T.SMOKE, variants: 4, life: [1.1, 1.7], size: [0.9, 1.3], grow: 2.6, speed: [1.4, 3.8], cone: 1.3, up: 1.0, col: C.smoke, alpha: 0.72, grav: 0.5, drag: 2.4, spin: 0.5, fin: 0.1, fout: 0.35, floor: true }),
  blastDust: pre({ cell: T.DUST, variants: 2, life: [0.6, 1.0], size: [0.45, 0.65], grow: 3, speed: [4, 8], cone: 0.25, alpha: 0.65, grav: 0.1, drag: 4, spin: 0.6, fin: 0.04, fout: 0.3, floor: true }),
  blastSpark: pre({ cell: T.SPARK, life: [0.3, 0.6], size: [0.04, 0.06], grow: 0.6, speed: [7, 16], cone: 1.4, up: 1, col: C.spark, bright: 5, m: 1, hot: 1, grav: -11, drag: 1.2, stretch: 0.03, fout: 0.4, floor: true }),
  // estela del cohete
  trailSmoke: pre({ cell: T.SMOKE, variants: 4, life: [0.45, 0.75], size: [0.12, 0.18], grow: 3.4, speed: [0.2, 0.7], cone: Math.PI, col: C.smokeLight, alpha: 0.5, grav: 0.4, drag: 2.5, spin: 1.2, fin: 0.08, fout: 0.3 }),
  trailFlame: pre({ cell: T.SPARK, life: [0.04, 0.06], size: [0.13, 0.17], grow: 0.7, speed: [0, 0], col: C.fireHot, bright: 2.4, m: 1, hot: 1.5, stretch: 0.035, fin: 0.01, fout: 0.2 }),
};

/* ----------------------------------------------------------- calidad */

// Presupuestos por nivel. El pool se reserva al máximo una vez; un nivel
// más bajo solo acorta el ring buffer y multiplica los conteos por q.
const SPRITE_CAP = 3600;
const DEBRIS_CAP = 300;
const CASING_CAP = 48;
const RING_CAP = 48;
const TRACER_SLOTS = 32; // cada slot = bala + haz (2 instancias)
const FLASH_SLOTS = 16; // por pool (normal y pesado)
export const FX_TIERS = Object.freeze({
  off: { q: 0.7, sprites: 1500, debris: 140, casings: 24 },
  low: { q: 0.7, sprites: 1500, debris: 140, casings: 24 },
  medium: { q: 0.85, sprites: 2400, debris: 220, casings: 36 },
  high: { q: 1, sprites: 3000, debris: 260, casings: 48 },
  ultra: { q: 1, sprites: 3600, debris: 300, casings: 48 },
});
// Luz aproximada del mapa para humo/polvo (no emiten): de noche no brillan.
const AMBIENT = {
  fortaleza: [1.0, 0.93, 0.84], azoteas: [0.42, 0.46, 0.58], calle: [0.42, 0.44, 0.54],
  metro: [0.6, 0.62, 0.66], prision: [0.85, 0.86, 0.88], pueblo: [1.0, 0.95, 0.88],
};

// Fogonazo por clase de arma: largo/ancho de la malla, vida, color, flash
// frontal, humo, casquillo y frenos laterales.
const FLASH = {
  smg: { big: 0, len: 0.36, wid: 0.2, life: 0.045, col: C.flash, k: 2.4, core: 0.75, star: 0, smoke: 0.35, casing: 1, embers: 0, brake: 0, light: 14 },
  pistol: { big: 0, len: 0.3, wid: 0.24, life: 0.05, col: C.flash, k: 2.4, core: 0.85, star: 0, smoke: 0.7, casing: 1, embers: 0, brake: 0, light: 14 },
  shotgun: { big: 1, len: 0.58, wid: 0.46, life: 0.06, col: C.flash, k: 2.6, core: 1.1, star: 1, smoke: 2.5, casing: 0, embers: 5, brake: 0, light: 26 },
  sniper: { big: 1, len: 0.8, wid: 0.2, life: 0.07, col: C.flashSniper, k: 2.6, core: 1.0, star: 0, smoke: 2, casing: 1, embers: 0, brake: 1, light: 26 },
  bazooka: { big: 1, len: 0.5, wid: 0.36, life: 0.07, col: C.fireHot, k: 2.6, core: 1.1, star: 1, smoke: 3, casing: 0, embers: 3, brake: 0, light: 26 },
  stun: { big: 0, len: 0.28, wid: 0.22, life: 0.05, col: C.flashStun, k: 3, core: 0.8, star: 0, smoke: 0, casing: 0, embers: 0, brake: 0, light: 12 },
};

/* ----------------------------------------------------------- registros */

// Registro de efecto vivo (items). Se reciclan: un evento no asigna objetos.
// obj: la malla del efecto (fogonazo) o el pool que dibuja esa capa.
function makeRec() {
  return { obj: null, life: 0, ttl: 0, tick: null, release: null, w: 0, len: 0, alpha: 0, pool: null };
}
const NOOP = () => {};
function flashTick(it) {
  const t = Math.min(1, it.life / it.ttl);
  const g = 1 + 0.35 * t;
  it.obj.scale.set(it.w * g, it.w * g, it.len * (1 + 0.55 * t));
  it.obj.material.uniforms.uCol.value.w = it.alpha * Math.pow(1 - t, 1.3);
}
function flashRelease(obj, it) { it.pool.release(obj); }

// Pool de slots con lista libre (índices en un pool GPU instanciado).
function slotPool(first, count) {
  const free = [];
  for (let i = first + count - 1; i >= first; i--) free.push(i);
  return {
    free,
    acquire() { return this.free.length ? this.free.pop() : -1; },
    release(i) { this.free.push(i); },
  };
}

export class Effects {
  constructor(scene, world = null) {
    this.scene = scene;
    this.world = world;
    this.camera = null;
    this.items = []; // registros vivos {obj, life, ttl, tick, release}
    this._recFree = [];
    for (let i = 0; i < 96; i++) this._recFree.push(makeRec());
    this.decals = new ImpactDecalPool(scene);
    this._impactBurstBudget = 12;
    // Una sola luz siempre presente: intensidad 0 cuando está inactiva.
    // Añadir/quitar PointLights por disparo invalidaba los programas WebGL.
    this._muzzleLight = new THREE.PointLight(0xffb35c, 0, 7);
    this._muzzleLightT = 0;
    this._muzzleLightPeak = 0;
    scene.add(this._muzzleLight);
    // Luz independiente: una explosión no roba el flash de un arma que se
    // dispare durante el mismo frame y nunca crea/destruye luces dinámicas.
    this._blastLight = new THREE.PointLight(0xff8a3d, 0, 13, 2);
    this._blastLightT = 0;
    this._blastLightPeak = 0;
    scene.add(this._blastLight);

    // ---- pools GPU ----
    this.atlas = sharedAtlas();
    this.u = createFxUniforms();
    this.clock = 0;
    this.sprites = createSpritePool(SPRITE_CAP, this.atlas, this.u);
    this.tracers = createTracerPool(TRACER_SLOTS * 2, this.u);
    this.flashes = createFlashPool(FLASH_SLOTS * 2, this.atlas, this.u);
    this.rings = createRingPool(RING_CAP, this.u);
    this.debris = new Chunks(DEBRIS_CAP, shardGeometry(), 'fx-debris', 0.7, 0.05);
    this.casings = new Chunks(CASING_CAP, casingGeometry(), 'fx-casings', 0.35, 0.85);
    // Orden de transparentes: TODO lo de FX (también decals, columna del
    // sniper y la cola del cohete) va en 2, antes que las nubes de humo
    // (renderOrder 3, sin depth write): una granada tapa lo que hay detrás.
    this.rings.mesh.renderOrder = 2;
    this.sprites.mesh.renderOrder = 2;
    this.tracers.mesh.renderOrder = 2;
    this.flashes.mesh.renderOrder = 2;
    this.flashes.mesh.name = 'fx-flashes';
    this.sprites.mesh.name = 'fx-sprites';
    this.tracers.mesh.name = 'fx-tracers';
    this.rings.mesh.name = 'fx-rings';
    this._gpuPools = [this.sprites, this.tracers, this.rings, this.flashes];
    // Siempre visibles, con 0 instancias en reposo: no cuestan draw calls,
    // pero el programa se compila con cada render de la escena (también al
    // cargar un mapa con otras luces): ningún tirón al primer disparo.
    for (const p of this._gpuPools) scene.add(p.mesh);
    for (const c of [this.debris, this.casings]) { c.mesh.count = 0; scene.add(c.mesh); }

    // Slots de tracer: pool real con lista libre (un shotgun de 8 perdigones
    // ocupa 8). Lleno = se descarta el tracer extra, se prioriza el frame.
    this._tracerExpire = new Float32Array(TRACER_SLOTS);
    this._tracerBusy = new Uint8Array(TRACER_SLOTS);
    this._tracerPool = slotPool(0, TRACER_SLOTS);

    // Fogonazos con forma (mallas cruzadas instanciadas, 1 draw call): dos
    // pools de slots, normal y pesado, 16 cada uno.
    this._flashGeo = createFlashCross();
    this._flashPools = [slotPool(0, FLASH_SLOTS), slotPool(FLASH_SLOTS, FLASH_SLOTS)];
    this._flashExpire = new Float32Array(FLASH_SLOTS * 2);
    this._flashBusy = new Uint8Array(FLASH_SLOTS * 2);
    // Columna de polvo del impacto con scope: se lee dentro del FOV de 20°.
    this._puffPool = makePool(scene, 4, () => {
      const m = new THREE.Mesh(this._flashGeo, createFlashMaterial(this.atlas, this.u));
      m.name = 'sniper-impact-puff';
      m.renderOrder = 2; // bajo el humo (3): la granada también lo tapa
      m.material.uniforms.uCell.value = T.PETAL;
      m.material.uniforms.uM.value = 0;
      return m;
    });

    // estado de emisión (campos para que el camino caliente no reciba objetos)
    this.Q = FX_TIERS.off.q;
    this.DELAY = 0; this.LIFE = 1; this.SIZE = 1; this.BRIGHT = 1; this.TINT = null; this.FLOOR = -1e5;
    this._ox = 0; this._oy = 0; this._oz = 0;
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._p = { x: 0, z: 0 };
    this._team = { r: 1, g: 1, b: 1 };
    this._tc = new THREE.Color();
    this._dust = { r: 1, g: 1, b: 1 };
    this._theme = null;
    this._rockets = null;
    this._floorAt = (x, z, y) => this._ground(x, z, y);
    this._hitWall = (s, o, dt) => this._chunkWall(s, o, dt);
    this.setQuality('off');
  }

  /* ------------------------------------------------------- configuración */

  // Nivel de gráficos: presupuesto de partículas y si hay cadena HDR.
  setQuality(q) {
    const t = FX_TIERS[q] || FX_TIERS.off;
    this.quality = FX_TIERS[q] ? q : 'off';
    this.Q = t.q;
    this.sprites.limit = Math.min(SPRITE_CAP, t.sprites);
    this.debris.limit = Math.min(DEBRIS_CAP, t.debris);
    this.casings.limit = Math.min(CASING_CAP, t.casings);
    this.u.uHdr.value = this.quality === 'off' ? 0 : 1;
  }

  // Cohetes en vuelo (src/game/special.js): solo se leen para la estela.
  trackRockets(rockets) { this._rockets = rockets; }

  /* ------------------------------------------------------- utilidades */

  _rec(obj, ttl, tick, release) {
    const it = this._recFree.pop() || makeRec();
    it.obj = obj; it.life = 0; it.ttl = ttl; it.tick = tick || NOOP; it.release = release || NOOP;
    this.items.push(it);
    return it;
  }

  // Capa animada en GPU: solo se registra para que items refleje lo vivo.
  _layer(pool, ttl) { this._rec(pool.mesh, ttl, NOOP, NOOP); }

  _count(n) {
    const x = n * this.Q;
    const f = Math.floor(x);
    return f + (Math.random() < x - f ? 1 : 0);
  }

  _ground(x, z, y) {
    const w = this.world;
    if (!w?.groundHeight) return 0;
    this._p.x = x; this._p.z = z;
    const g = w.groundHeight(this._p, 0, y);
    return Number.isFinite(g) ? g : 0;
  }

  // Paredes para los restos grandes: un raycast por paso, solo si se mueven.
  _chunkWall(s, o, dt) {
    const w = this.world;
    if (!w?.raycastHit) return;
    const vx = s[o + 3], vy = s[o + 4], vz = s[o + 5];
    const len = Math.hypot(vx, vy, vz) * dt;
    if (len < 0.001) return;
    this._v4.set(s[o], s[o + 1], s[o + 2]);
    this._v3.set(vx, vy, vz).multiplyScalar(1 / (len / dt));
    const hit = w.raycastHit(this._v4, this._v3, len + 0.035);
    if (!hit || !(hit.t <= len + 0.035)) return;
    const n = hit.normal ?? UP;
    const dot = vx * n.x + vy * n.y + vz * n.z;
    if (dot < 0) {
      s[o + 3] = (vx - 1.35 * dot * n.x) * 0.48;
      s[o + 4] = (vy - 1.35 * dot * n.y) * 0.48;
      s[o + 5] = (vz - 1.35 * dot * n.z) * 0.48;
    }
  }

  _cam() {
    if (!this.camera) return null;
    return this.camera.getWorldPosition(this._camPos);
  }

  // Tamaño según distancia a cámara: lo lejano crece para leerse, lo muy
  // cercano se encoge para no tapar al objetivo.
  _distSize(p, far = 9, max = 2.2) {
    const c = this._cam();
    if (!c) return 1;
    const d = c.distanceTo(p);
    return d < 3.5 ? 0.55 + 0.13 * d : Math.min(max, Math.max(1, d / far));
  }

  _impactSize(p) {
    const c = this._cam();
    if (!c) return 1;
    const d = c.distanceTo(p);
    // lejos crece para leerse (≈ 0.5 m a 10 m); a quemarropa se encoge
    return d < 3.5 ? 0.55 + 0.13 * d : Math.min(3, Math.max(1, d / 7));
  }

  _teamRGB(team) {
    if (team === 'red') return C.teamRed;
    if (team === 'blue') return C.teamBlue;
    if (typeof team === 'number') {
      // los hex de equipo del juego se mapean a los colores de lectura
      if (team === 0xd94f3f || team === 0xe8402f) return C.teamRed;
      if (team === 0x4f8de0 || team === 0x2f7fe8) return C.teamBlue;
      this._tc.setHex(team);
      this._team.r = this._tc.r; this._team.g = this._tc.g; this._team.b = this._tc.b;
      return this._team;
    }
    return null;
  }

  // Dirección aleatoria dentro de un cono de semiángulo `cone` → _ox,_oy,_oz.
  _coneDir(dx, dy, dz, cone) {
    const cosT = 1 - Math.random() * (1 - Math.cos(Math.min(cone, Math.PI)));
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = Math.random() * Math.PI * 2;
    let ux, uy, uz;
    if (Math.abs(dy) < 0.9) { ux = dz; uy = 0; uz = -dx; } else { ux = 0; uy = -dz; uz = dy; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const wx = dy * uz - dz * uy, wy = dz * ux - dx * uz, wz = dx * uy - dy * ux;
    const c = Math.cos(phi) * sinT, s = Math.sin(phi) * sinT;
    this._ox = dx * cosT + ux * c + wx * s;
    this._oy = dy * cosT + uy * c + wy * s;
    this._oz = dz * cosT + uz * c + wz * s;
  }

  _sprite(p, x, y, z, vx, vy, vz, sizeMul) {
    const sp = this.sprites;
    sp.alloc();
    const o = sp.o;
    const A = sp.data;
    const life = (p.life[0] + (p.life[1] - p.life[0]) * Math.random()) * this.LIFE;
    const s0 = (p.size[0] + (p.size[1] - p.size[0]) * Math.random()) * sizeMul * this.SIZE;
    const birth = this.clock + this.DELAY;
    A[0][o] = x; A[0][o + 1] = y; A[0][o + 2] = z; A[0][o + 3] = birth;
    A[1][o] = vx; A[1][o + 1] = vy; A[1][o + 2] = vz; A[1][o + 3] = life;
    A[2][o] = p.grav; A[2][o + 1] = p.drag; A[2][o + 2] = p.floor ? this.FLOOR + 0.015 : -1e5;
    A[2][o + 3] = p.spin * (Math.random() * 2 - 1);
    A[3][o] = s0; A[3][o + 1] = s0 * p.grow; A[3][o + 2] = p.stretch;
    A[3][o + 3] = p.cell + (p.variants > 1 ? Math.floor(Math.random() * p.variants) : 0);
    const c = this.TINT || p.col;
    const k = p.bright * this.BRIGHT * (0.85 + 0.3 * Math.random());
    A[4][o] = c.r * k; A[4][o + 1] = c.g * k; A[4][o + 2] = c.b * k; A[4][o + 3] = p.alpha;
    A[5][o] = p.m; A[5][o + 1] = p.hot; A[5][o + 2] = p.fout; A[5][o + 3] = p.fin;
    if (birth + life > sp.until) sp.until = birth + life;
  }

  // n sprites (escalado por calidad) desde pos en un cono alrededor de dir.
  _emit(p, n, pos, dir, spd = 1, size = 1, cone = -1, exact = false) {
    const k = exact ? Math.round(n) : this._count(n);
    const cn = cone >= 0 ? cone : p.cone;
    for (let i = 0; i < k; i++) {
      if (dir) this._coneDir(dir.x, dir.y, dir.z, cn);
      else this._coneDir(0, 1, 0, Math.PI);
      const sp = (p.speed[0] + (p.speed[1] - p.speed[0]) * Math.random()) * spd;
      let x = pos.x, y = pos.y, z = pos.z;
      if (p.jit > 0) {
        const j = p.jit * size;
        x += (Math.random() * 2 - 1) * j; y += (Math.random() * 2 - 1) * j * 0.5; z += (Math.random() * 2 - 1) * j;
      }
      this._sprite(p, x, y, z, this._ox * sp, this._oy * sp + p.up * spd, this._oz * sp, size);
    }
  }

  _ring(pos, n, r0, r1, th, col, bright, alpha, m, life, fill, hot) {
    const rp = this.rings;
    rp.alloc();
    const o = rp.o;
    const d = rp.data;
    const birth = this.clock + this.DELAY;
    d[0][o] = pos.x; d[0][o + 1] = pos.y; d[0][o + 2] = pos.z; d[0][o + 3] = birth;
    if (n) { d[1][o] = n.x; d[1][o + 1] = n.y; d[1][o + 2] = n.z; } else { d[1][o] = d[1][o + 1] = d[1][o + 2] = 0; }
    d[1][o + 3] = life;
    d[2][o] = col.r * bright; d[2][o + 1] = col.g * bright; d[2][o + 2] = col.b * bright; d[2][o + 3] = alpha;
    d[3][o] = r0; d[3][o + 1] = r1; d[3][o + 2] = th; d[3][o + 3] = m;
    d[4][o] = fill; d[4][o + 1] = Math.random() * 6.28; d[4][o + 2] = hot; d[4][o + 3] = 0;
    if (birth + life > rp.until) rp.until = birth + life;
  }

  _streak(i, a, b, col, bright, width, speed, trail, hot, alpha, life) {
    const tp = this.tracers;
    const o = i * 4;
    tp.mark(i);
    const d = tp.data;
    const birth = this.clock;
    d[0][o] = a.x; d[0][o + 1] = a.y; d[0][o + 2] = a.z; d[0][o + 3] = birth;
    d[1][o] = b.x; d[1][o + 1] = b.y; d[1][o + 2] = b.z; d[1][o + 3] = life;
    d[2][o] = col.r * bright; d[2][o + 1] = col.g * bright; d[2][o + 2] = col.b * bright; d[2][o + 3] = width;
    d[3][o] = speed; d[3][o + 1] = trail; d[3][o + 2] = hot; d[3][o + 3] = alpha;
    if (birth + life > tp.until) tp.until = birth + life;
  }

  // n restos sólidos iluminados en un cono alrededor de dir.
  _chunks(pool, pos, dir, cone, n, spdA, spdB, size, flat, col, glow, life, collide = 0) {
    const k = this._count(n);
    const floor = this.FLOOR > -1e4 ? this.FLOOR : this._ground(pos.x, pos.z, pos.y);
    for (let i = 0; i < k; i++) {
      if (dir) this._coneDir(dir.x, dir.y, dir.z, cone);
      else this._coneDir(0, 1, 0, Math.PI * 0.6);
      const sp = spdA + (spdB - spdA) * Math.random();
      const v = 0.8 + 0.4 * Math.random();
      const s = size * (0.6 + Math.random() * 0.7);
      pool.spawn(pos.x, pos.y, pos.z, this._ox * sp, this._oy * sp, this._oz * sp,
        s * (0.7 + Math.random() * 0.6), s * flat * (0.6 + Math.random() * 0.5), s * (0.7 + Math.random() * 0.6),
        col.r * v, col.g * v, col.b * v, glow, life * (0.8 + 0.4 * Math.random()), floor, 0.32, collide);
    }
  }

  _reset() { this.DELAY = 0; this.LIFE = 1; this.SIZE = 1; this.BRIGHT = 1; this.TINT = null; this.FLOOR = -1e5; }

  /* ------------------------------------------------------- disparo */

  // Tracer del color del equipo que dispara (lectura: quién dispara desde
  // dónde). Bala con núcleo blanco caliente + haz tenue que dura un instante.
  // opts: { team: 'red'|'blue'|hex, weapon }
  tracer(from, to, emphasized = false, opts = null) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.3) return;
    const slot = this._tracerPool.acquire();
    if (slot < 0) return; // priorizar frame time sobre un tracer extra
    const col = this._teamRGB(opts?.team) || C.neutral;
    const pellet = opts?.weapon === 'shotgun';
    const speed = Math.max(320, len / 0.05);
    const trail = Math.min(pellet ? 2.2 : 5, Math.max(1.4, len * 0.3));
    const life = (len + trail) / speed + 0.012;
    const beamLife = emphasized ? 0.22 : pellet ? 0.07 : 0.11;
    this._streak(slot * 2, from, to, col, 4, emphasized ? 0.05 : pellet ? 0.028 : 0.038,
      speed, trail, emphasized ? 3 : 2.2, 1, life);
    this._streak(slot * 2 + 1, from, to, col, 1.6, emphasized ? 0.03 : 0.016,
      0, 0, 0.25, emphasized ? 0.45 : pellet ? 0.16 : 0.26, beamLife);
    this._tracerBusy[slot] = 1;
    this._tracerExpire[slot] = this.clock + Math.max(life, beamLife);
  }

  // Fogonazo por clase de arma. opts: { weapon, dir, to, team }.
  muzzleFlash(pos, big = false, opts = null) {
    const weapon = opts?.weapon && FLASH[opts.weapon] ? opts.weapon : (big ? 'shotgun' : 'smg');
    const F = FLASH[weapon];
    this._reset();
    this._muzzleLight.position.copy(pos);
    this._muzzleLight.color.setHex(weapon === 'stun' ? 0xbfe8ff : 0xffb35c);
    this._muzzleLightPeak = F.light;
    this._muzzleLight.intensity = this._muzzleLightPeak;
    this._muzzleLightT = 0.055;

    // dirección del cañón: explícita, hacia el destino o hacia donde mira la cámara
    const dir = this._v1;
    if (opts?.dir) dir.set(opts.dir.x, opts.dir.y, opts.dir.z);
    else if (opts?.to) dir.set(opts.to.x - pos.x, opts.to.y - pos.y, opts.to.z - pos.z);
    else if (this.camera) this.camera.getWorldDirection(dir);
    else dir.set(0, 0, -1);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();

    const scale = 0.85 + Math.random() * 0.3;
    if (weapon === 'bazooka') {
      // boca: fogonazo corto; atrás del tubo: back-blast largo y humo
      this._flashMesh(F, pos, dir, scale * 0.8, 1);
      this._v2.copy(pos).addScaledVector(dir, -1.05);
      this._v3.copy(dir).negate();
      this._flashMesh(F, this._v2, this._v3, scale * 1.5, 1);
      this._emit(P.muzzleCore, 1, this._v2, null, 0, 1.4, -1, true);
      this._emit(P.smokeMuzzle, F.smoke * 2, this._v2, this._v3, 1.6, 2.2);
      this._emit(P.ember, F.embers, this._v2, this._v3, 1, 1);
    } else {
      this._flashMesh(F, pos, dir, scale, F.big);
      if (F.brake) {
        // freno de boca del sniper: dos chorros laterales cortos
        this._v3.crossVectors(dir, UP);
        if (this._v3.lengthSq() < 1e-4) this._v3.set(1, 0, 0);
        this._v3.normalize();
        this._v2.copy(pos).addScaledVector(dir, 0.05);
        this._flashMesh(F, this._v2, this._v3, scale * 0.42, 1);
        this._v3.negate();
        this._flashMesh(F, this._v2, this._v3, scale * 0.42, 1);
      }
    }
    // núcleo frontal y estrella (escopeta)
    this._v2.copy(pos).addScaledVector(dir, 0.06);
    this.TINT = F.col;
    this._emit(P.muzzleCore, 1, this._v2, null, 0, F.core * scale, -1, true);
    if (F.star) this._emit(P.muzzleStar, 1, this._v2, null, 0, scale * (weapon === 'shotgun' ? 1 : 0.8), -1, true);
    this.TINT = null;
    if (F.embers && weapon !== 'bazooka') this._emit(P.sparkHot, F.embers, this._v2, dir, 1.2, 0.8, 0.35);
    // humo: un hilo breve que deriva y sube
    if (F.smoke > 0) {
      this._v2.copy(pos).addScaledVector(dir, 0.12);
      this._emit(P.smokeMuzzle, F.smoke, this._v2, dir, 1, weapon === 'sniper' || weapon === 'shotgun' ? 1.4 : 1);
    }
    // casquillo expulsado a la derecha del arma
    if (F.casing) {
      this._v3.crossVectors(dir, UP);
      if (this._v3.lengthSq() > 1e-4) {
        this._v3.normalize();
        const back = weapon === 'sniper' ? 0.5 : 0.3;
        this._v2.copy(pos).addScaledVector(dir, -back);
        const s = weapon === 'sniper' ? 1.5 : weapon === 'pistol' ? 0.9 : 1;
        const sp = 1.6 + Math.random() * 1.2;
        this.casings.spawn(this._v2.x, this._v2.y, this._v2.z,
          this._v3.x * sp - dir.x * 0.4, 1.4 + Math.random() * 1.2, this._v3.z * sp - dir.z * 0.4,
          0.016 * s, 0.016 * s, 0.04 * s, C.brass.r, C.brass.g, C.brass.b, 0.15, 1.4,
          this._ground(this._v2.x, this._v2.z, this._v2.y), 0.45, 0);
      }
    }
  }

  _flashMesh(F, pos, dir, scale, big) {
    const i = this._flashPools[big ? 1 : 0].acquire();
    if (i < 0) return; // lleno: se descarta el fogonazo extra
    const fp = this.flashes;
    const o = i * 4;
    fp.mark(i);
    const d = fp.data;
    const birth = this.clock;
    const k = F.k;
    d[0][o] = pos.x; d[0][o + 1] = pos.y; d[0][o + 2] = pos.z; d[0][o + 3] = birth;
    d[1][o] = dir.x; d[1][o + 1] = dir.y; d[1][o + 2] = dir.z; d[1][o + 3] = F.life;
    d[2][o] = F.col.r * k; d[2][o + 1] = F.col.g * k; d[2][o + 2] = F.col.b * k; d[2][o + 3] = 1;
    d[3][o] = F.wid * scale; d[3][o + 1] = F.len * scale; d[3][o + 2] = Math.random() * Math.PI; d[3][o + 3] = 1;
    if (birth + F.life > fp.until) fp.until = birth + F.life;
    this._flashBusy[i] = 1;
    this._flashExpire[i] = birth + F.life;
  }

  /* ------------------------------------------------------- impactos */

  impact(pos, normal = null, surface = 'concrete', options = null) {
    const emphasized = !!options?.emphasized;
    const canProject = normal && options?.origin && this.world?.projectImpactSurface;
    const projected = canProject
      ? this.world.projectImpactSurface(options.origin, pos, normal, surface)
      : null;
    const impactPos = projected?.point || pos;
    const impactNormal = projected?.normal || normal;
    const impactSurface = projected?.surface || surface;
    // Si la reproyección visual NO encontró superficie cerca del contacto
    // físico, el punto está en el AIRE (el collider AABB sobresale del mesh
    // — capós inclinados, bordes de assets): mejor sin marca que un decal
    // flotante. El puff sí sale: feedback de que la bala se detuvo ahí.
    const airborne = canProject && !projected;
    if (impactNormal && !airborne) {
      this.decals.add(impactPos, impactNormal, impactSurface, emphasized ? 1.65 : 1);
    }
    // Los decals siempre se registran; las partículas se presupuestan para
    // que una ráfaga de escopetas no sature la pantalla. Un impacto local de
    // sniper scoped siempre conserva su columna: es el feedback que debe
    // poder leerse dentro del FOV de 20 grados.
    if (this._impactBurstBudget < 1 && !emphasized) return;
    if (this._impactBurstBudget >= 1) this._impactBurstBudget--;
    this._reset();
    const p = impactPos;
    const n = this._v2;
    if (impactNormal) n.set(impactNormal.x, impactNormal.y, impactNormal.z).normalize();
    else n.set(0, 1, 0);
    // La bala llega cuando llega el tracer (≤ 50 ms): el impacto la espera.
    if (options?.origin) {
      const L = Math.hypot(p.x - options.origin.x, p.y - options.origin.y, p.z - options.origin.z);
      this.DELAY = Math.min(0.05, L / Math.max(320, L / 0.05));
    }
    this.FLOOR = this._ground(p.x, p.z, p.y + 0.05);
    this.SIZE = this._impactSize(p) * (emphasized ? 1.5 : 1);
    // rocío: por la normal, doblado hacia quien disparó
    const v1 = this._v3.copy(n);
    if (options?.origin) {
      this._v4.set(options.origin.x - p.x, options.origin.y - p.y, options.origin.z - p.z);
      if (this._v4.lengthSq() > 1e-4) v1.multiplyScalar(0.75).addScaledVector(this._v4.normalize(), 0.45).normalize();
    }
    const dust = SURFACE_DUST[impactSurface] || C.concrete;
    switch (impactSurface) {
      case 'metal':
        this._emit(P.sparkHot, 9, p, v1, 1.1, 1);
        this._emit(P.sparkWhite, 3, p, v1, 1, 1);
        this._emit(P.flareWhite, 1, p, null, 0, 0.5, -1, true);
        this._emit(P.smokeTiny, 2, p, n, 1, 1);
        break;
      case 'glass':
        this._emit(P.shard, 7, p, v1, 1, 1);
        this._emit(P.glitter, 6, p, v1, 1, 1);
        this.TINT = dust; this._emit(P.impactBurst, 1.5, p, v1, 0.8, 0.7); this.TINT = null;
        break;
      case 'wood':
        this._emit(P.splinter, 6, p, v1, 1, 1);
        this.TINT = dust; this._emit(P.impactBurst, 2.5, p, v1, 1, 0.9); this.TINT = null;
        this._emit(P.impactPop, 1, p, null, 0, 0.7, -1, true);
        break;
      case 'cloth':
      case 'grass':
        this.TINT = dust; this._emit(P.impactBurst, 3, p, v1, 0.9, 0.9); this.TINT = null;
        break;
      default: // concrete, stone, brick, tile
        this.TINT = SURFACE_CHIP[impactSurface] || SURFACE_CHIP.concrete;
        this._emit(P.chip, 7, p, v1, 1, 1);
        this.TINT = dust;
        this._emit(P.impactBurst, 3, p, v1, 1, 1);
        this._emit(P.dustPuff, 2, p, n, 1, 1);
        this.TINT = null;
        this._emit(P.impactPop, 1, p, null, 0, 0.8, -1, true);
        if (impactSurface === 'stone' || impactSurface === 'concrete') this._emit(P.sparkHot, 1.2, p, v1, 0.8, 0.7);
        this._chunks(this.debris, p, v1, 0.6, 0.6, 2, 4.5, 0.035, 0.6, dust, 0, 1.1);
        break;
    }
    if (emphasized) {
      // Sniper con scope: columna de polvo a lo largo de la normal, aro
      // frente a cámara y más masa. Debe leerse a 100 m con FOV 20.
      this.TINT = dust;
      this._emit(P.dustBig, 4, p, n, 1.3, 0.8);
      this.TINT = null;
      this._emit(P.flareWhite, 1, p, null, 0, 1.2, -1, true);
      const m = this._puffPool.acquire();
      if (m) {
        m.position.copy(p);
        // eje de la columna: la normal sin su componente hacia la cámara
        // (de frente, una malla a lo largo de la normal se vería de canto)
        // más algo de subida: el polvo brota y se eleva
        const ax = this._v4.copy(n);
        const c = this._cam();
        if (c) {
          this._v1.subVectors(c, p).normalize();
          ax.addScaledVector(this._v1, -ax.dot(this._v1));
        }
        ax.y += 0.6;
        if (ax.lengthSq() < 1e-4) ax.set(0, 1, 0);
        ax.normalize();
        this._q.setFromUnitVectors(PLUS_Z, ax);
        this._q2.setFromAxisAngle(PLUS_Z, Math.random() * Math.PI);
        m.quaternion.copy(this._q).multiply(this._q2);
        m.material.uniforms.uCol.value.set(dust.r * 0.9, dust.g * 0.9, dust.b * 0.9, 0.85);
        m.visible = true;
        const it = this._rec(m, 0.34, flashTick, flashRelease);
        it.w = 0.7 * this.SIZE; it.len = 1.1 * this.SIZE; it.alpha = 0.85; it.pool = this._puffPool;
        m.scale.set(it.w, it.w, it.len);
      }
    }
    this._reset();
  }

  // Impacto en un personaje: chispa de armadura del color de su equipo y un
  // golpe de polvo gris. Sin sangre: la lectura es "le diste a ese equipo".
  blood(pos, teamColor) {
    this._reset();
    const col = this._teamRGB(teamColor) || C.neutral;
    this.SIZE = this._distSize(pos, 10, 1.8);
    this.FLOOR = this._ground(pos.x, pos.z, pos.y - 0.6);
    this.TINT = col;
    this._emit(P.sparkTeam, 14, pos, null, 1, 1);
    this._emit(P.teamGlow, 1, pos, null, 0, 1, -1, true);
    this._emit(P.teamPuff, 3, pos, null, 1, 1);
    this.TINT = null;
    this._emit(P.sparkWhite, 3, pos, null, 0.8, 0.8);
    this._reset();
  }

  /* ------------------------------------------------------- explosiones */

  // Explosión ambiental de bazooka. El daño sigue completamente separado:
  // este método solo presenta flash → bola de fuego → humo → chispas →
  // onda en el suelo → restos, iluminado por la luz de explosión fija.
  rocketExplosion(pos, info = {}) {
    this._reset();
    const origin = this._v4.set(pos.x, pos.y, pos.z);
    const direct = !!info.direct;
    const floorY = Number.isFinite(info.floorY) ? info.floorY : this._ground(pos.x, pos.z, pos.y);
    const surface = info.surface || 'concrete';
    const n = this._v2;
    if (info.normal && Number.isFinite(info.normal.x)) n.set(info.normal.x, info.normal.y, info.normal.z).normalize();
    else n.set(0, 1, 0);
    if (n.lengthSq() < 0.5) n.set(0, 1, 0);

    this._blastLight.position.copy(origin);
    this._blastLightPeak = direct ? 62 : 48;
    this._blastLight.intensity = this._blastLightPeak;
    this._blastLightT = direct ? 0.18 : 0.15;

    this.FLOOR = floorY;
    const s = direct ? 1.15 : 1;
    // flash
    this._emit(P.blastFlash, 1, origin, null, 0, s, -1, true);
    this._emit(P.blastStar, 1, origin, null, 0, s, -1, true);
    this._layer(this.sprites, 0.1);
    // humo: nace tras el fuego y se ilumina con la luz de la explosión. Se
    // escribe ANTES que el fuego: en el mismo draw call el orden de instancia
    // es el de dibujo, y el fuego aditivo debe quedar encima del humo.
    this.DELAY = 0.06;
    this._emit(P.blastSmoke, 14, origin, n, s, s, 1.4);
    this.DELAY = 0;
    this._layer(this.sprites, 1.7);
    // bola de fuego: lenguas que salen por la normal y se frenan
    this._emit(P.fireball, 16, origin, n, s, s, 1.4);
    this._emit(P.fireCore, 4, origin, null, s, s);
    this._layer(this.sprites, 0.42);
    // chispas y brasas
    this._emit(P.blastSpark, 22, origin, n, s, 1);
    this._emit(P.ember, 8, origin, n, 1.2, 1);
    this._layer(this.sprites, 1.0);
    // restos del material (o fragmentos oscuros en impacto directo)
    const debrisCol = direct ? C.armorDark : SURFACE_DUST[surface] || C.concrete;
    this._chunks(this.debris, origin, n, 1.1, direct ? 10 : 12, 3, 9, 0.07, 0.6, debrisCol, 0, 1.6, 1);
    this._chunks(this.debris, origin, n, 1.2, 4, 3, 7, 0.05, 0.6, C.ember, 1.6, 0.9, 0);
    this._layer(this.debris, 1.6);
    // onda: aro de polvo pegado a la superficie + aro caliente breve
    if (!direct && info.normal) {
      this._v1.copy(origin).addScaledVector(n, -0.25);
      const ground = n.y > 0.7 ? this._v1.set(origin.x, floorY + 0.06, origin.z) : this._v1;
      const dustCol = SURFACE_DUST[surface] || C.concrete;
      this._ring(ground, n, 0.3, 4.6, 0.5, dustCol, 1, 0.85, 0, 0.6, 0.4, 0);
      // polvo radial a ras de suelo
      this.TINT = dustCol;
      const k = this._count(10);
      for (let i = 0; i < k; i++) {
        const a = (i / k) * Math.PI * 2 + Math.random() * 0.4;
        this._v3.set(Math.cos(a), 0, Math.sin(a));
        // proyectar al plano de la superficie
        this._v3.addScaledVector(n, -this._v3.dot(n));
        if (this._v3.lengthSq() < 1e-4) continue;
        this._v3.normalize();
        this._emit(P.blastDust, 1, ground, this._v3, 1, 1, 0.2, true);
      }
      this.TINT = null;
      this.decals.add(origin, n, surface, 4.2);
    }
    this._layer(this.rings, 0.55);
    this._reset();
  }

  // Restos de una muerte por bazooka: piezas de armadura del equipo y gris,
  // chispas de equipo, humo. Los fragmentos chocan con paredes y suelo.
  rocketDeath(pos, teamColor, level = 2, direction = null, floorY = 0) {
    this._reset();
    const total = level >= 2;
    const baseY = Number.isFinite(pos.y) ? pos.y : floorY;
    const origin = this._v4.set(pos.x, baseY + 0.9, pos.z);
    const dir = this._v2.set(0, 1, 0);
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.z)) {
      dir.set(direction.x, (direction.y ?? 0.12) + 0.6, direction.z);
      if (dir.lengthSq() > 0.001) dir.normalize(); else dir.set(0, 1, 0);
    }
    this.FLOOR = Number.isFinite(floorY) ? floorY : this._ground(pos.x, pos.z, baseY);
    const col = this._teamRGB(teamColor) || C.neutral;
    this._chunks(this.debris, origin, dir, 1.0, total ? 12 : 7, 3, total ? 8 : 6, 0.17, 0.6, col, 0.25, 1.8, 1);
    this._chunks(this.debris, origin, dir, 1.2, total ? 12 : 7, 2.5, total ? 7.5 : 5.5, 0.14, 0.55, C.armorGrey, 0, 1.8, 1);
    this._chunks(this.debris, origin, dir, 1.2, total ? 6 : 3, 2, 6, 0.11, 0.5, C.armorDark, 0, 1.6, 1);
    this.TINT = col;
    this._emit(P.sparkTeam, total ? 22 : 14, origin, null, 1.4, 1.2);
    this._emit(P.teamStar, 1, origin, null, 0, 1.6, -1, true);
    this._emit(P.teamPuff, 6, origin, null, 1.6, 2);
    this.TINT = null;
    this._emit(P.blastSmoke, total ? 6 : 4, origin, dir, 0.6, 0.8);
    this._layer(this.debris, 1.8);
    this._layer(this.sprites, 1.6);
    this._reset();
  }

  // Remate del sniper a la cabeza: estallido del color del equipo, flash
  // blanco, aro y fragmentos de casco. Más localizado que gib().
  sniperHeadshot(pos, teamColor, direction = null, floorY = 0) {
    this._reset();
    const origin = this._v4.set(pos.x, pos.y, pos.z);
    let dir = null;
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.z)) {
      dir = this._v2.set(direction.x, (direction.y ?? 0.08) + 0.3, direction.z);
      if (dir.lengthSq() > 0.001) dir.normalize(); else dir = null;
    }
    this.FLOOR = Number.isFinite(floorY) ? floorY : this._ground(pos.x, pos.z, pos.y - 1.5);
    this.SIZE = this._distSize(origin, 10, 1.8);
    const col = this._teamRGB(teamColor) || C.neutral;
    this.TINT = col;
    this._emit(P.sparkTeam, 20, origin, dir, 1.4, 1.1, 1.1);
    this._emit(P.teamStar, 1, origin, null, 0, 1, -1, true);
    this._emit(P.teamPuff, 5, origin, dir, 1.4, 1.4);
    this.TINT = null;
    this._emit(P.flareWhite, 1, origin, null, 0, 1.4, -1, true);
    this._emit(P.armorPuff, 3, origin, dir, 1.2, 1.3);
    this.SIZE = 1;
    this._chunks(this.debris, origin, dir, 1.0, 5, 2, 5, 0.08, 0.45, col, 0.2, 1.1);
    this._chunks(this.debris, origin, dir, 1.1, 4, 2, 5, 0.07, 0.45, C.armorGrey, 0, 1.1);
    this._layer(this.sprites, 0.5);
    this._reset();
  }

  meleeImpact(pos, teamColor, direction = null) {
    // Contacto compacto: destello cálido + chispas del color de la víctima +
    // golpe de polvo. Menor que una explosión y sin decal de bala.
    this._reset();
    const col = this._teamRGB(teamColor) || C.neutral;
    const dir = direction && Number.isFinite(direction.x) ? this._v2.set(direction.x, direction.y ?? 0, direction.z) : null;
    if (dir && dir.lengthSq() > 1e-4) dir.normalize();
    this.FLOOR = this._ground(pos.x, pos.z, pos.y - 0.5);
    this._emit(P.flareWhite, 1, pos, null, 0, 1.4, -1, true);
    this.TINT = col;
    this._emit(P.sparkTeam, 12, pos, dir, 1, 1, 1.0);
    this._emit(P.teamPuff, 3, pos, dir, 1.2, 1.1, 1.0);
    this.TINT = null;
    this._emit(P.armorPuff, 3, pos, dir, 1.4, 1.1);
    this._reset();
  }

  // Polvo de movimiento. kind: land | cover | slide | wall | bounce | step.
  // y: altura de los pies (si falta, se busca el suelo).
  dust(pos, kind = 'land', y = null) {
    this._reset();
    const gy = Number.isFinite(y) ? y : this._ground(pos.x, pos.z, 50);
    const p = this._v4.set(pos.x, gy + 0.06, pos.z);
    this.FLOOR = gy;
    this.TINT = this._themeDust();
    if (kind === 'step') {
      this._emit(P.dustStep, 2, p, UP, 1, 0.8, 1.4);
    } else if (kind === 'slide') {
      this._emit(P.dustPuff, 6, p, UP, 1.4, 1.1, 1.4);
    } else if (kind === 'cover') {
      // golpe contra la cobertura: abanico corto y un aro bajo
      this._emit(P.dustPuff, 7, p, UP, 1.6, 1.2, 1.45);
      this._ring(p, UP, 0.15, 1.0, 0.12, this.TINT, 1, 0.6, 0, 0.32, 0.25, 0);
    } else {
      this._emit(P.dustPuff, kind === 'wall' ? 4 : 7, p, UP, 1.4, 1, 1.45);
      this._ring(p, UP, 0.2, 1.3, 0.14, this.TINT, 1, 0.6, 0, 0.4, 0.3, 0);
    }
    this._reset();
  }

  // Muerte por gib: piezas de armadura del equipo y gris, chispas, humo.
  gib(pos, teamColor) {
    this._reset();
    const baseY = Number.isFinite(pos.y) ? pos.y : 0;
    const origin = this._v4.set(pos.x, baseY + 0.9, pos.z);
    this.FLOOR = this._ground(pos.x, pos.z, baseY + 0.3);
    const col = this._teamRGB(teamColor) || C.neutral;
    this._chunks(this.debris, origin, UP, 1.2, 7, 2.5, 6.5, 0.16, 0.6, col, 0.2, 1.4, 1);
    this._chunks(this.debris, origin, UP, 1.3, 8, 2.5, 6, 0.14, 0.55, C.armorGrey, 0, 1.4, 1);
    this.TINT = col;
    this._emit(P.sparkTeam, 14, origin, null, 1.3, 1.1);
    this._emit(P.teamStar, 1, origin, null, 0, 1.4, -1, true);
    this._emit(P.teamPuff, 5, origin, null, 1.5, 1.8);
    this.TINT = null;
    this._emit(P.armorPuff, 4, origin, null, 1.4, 1.6);
    this._layer(this.debris, 1.3);
    this._reset();
  }

  _themeDust() {
    const th = this.world?.theme ?? this.world?.layout;
    if (th === 'fortaleza') return C.stone;
    if (th === 'azoteas' || th === 'calle') return C.concrete;
    return C.dirt;
  }

  /* ------------------------------------------------------- frame */

  _syncEnv() {
    const fog = this.scene.fog;
    const u = this.u;
    if (fog?.isFogExp2) { u.uFogColor.value.copy(fog.color); u.uFog.value.set(1e5, 1e5 + 1, fog.density); }
    else if (fog?.isFog) { u.uFogColor.value.copy(fog.color); u.uFog.value.set(fog.near, Math.max(fog.near + 0.01, fog.far), 0); }
    else u.uFog.value.set(1e5, 1e5 + 1, 0);
    const th = this.world?.theme ?? this.world?.layout ?? null;
    if (th !== this._theme) {
      this._theme = th;
      const a = AMBIENT[th] || [0.85, 0.85, 0.85];
      u.uAmbient.value.setRGB(a[0], a[1], a[2]);
    }
    const bl = this._blastLight;
    u.uBlast.value.set(bl.position.x, bl.position.y, bl.position.z,
      this._blastLightPeak > 0 ? bl.intensity / this._blastLightPeak : 0);
  }

  _rebase(r) {
    for (const p of this._gpuPools) p.rebase(r);
    for (let i = 0; i < TRACER_SLOTS; i++) this._tracerExpire[i] -= r;
    for (let i = 0; i < FLASH_SLOTS * 2; i++) this._flashExpire[i] -= r;
    this.clock -= r;
  }

  _updateTrails(dt) {
    const list = this._rockets?.list;
    if (!list || !list.length || dt <= 0) return;
    this._reset();
    for (const r of list) {
      if (!Number.isFinite(r.x)) continue;
      const sp = Math.hypot(r.vx, r.vy, r.vz) || 1;
      const dx = r.vx / sp, dy = r.vy / sp, dz = r.vz / sp;
      // tobera ~0.3 m detrás del centro del cohete
      const tx = r.x - dx * 0.32, ty = r.y - dy * 0.32, tz = r.z - dz * 0.32;
      // llama: viaja con el cohete a menor velocidad y se estira en pantalla
      this._sprite(P.trailFlame, tx, ty, tz, r.vx * 0.55, r.vy * 0.55, r.vz * 0.55, 1);
      // humo por DISTANCIA (cada ~14 cm): cinta continua a cualquier fps
      const step = sp * dt;
      const n = Math.min(12, Math.ceil(step / 0.14 * this.Q));
      for (let k = 0; k < n; k++) {
        const back = (k / n) * step;
        this._v1.set(tx - dx * back, ty - dy * back, tz - dz * back);
        this._emit(P.trailSmoke, 1, this._v1, null, 1, 1, -1, true);
      }
    }
  }

  update(dt) {
    this.clock += dt;
    // reloj relativo: cada ~5 min vuelve a 0 restando lo mismo a todos los
    // nacimientos y caducidades (float32 en el shader pierde el sub-frame
    // tras horas de sesión)
    if (this.clock > 300) this._rebase(this.clock);
    this.u.uTime.value = this.clock;
    if (this._muzzleLightT > 0) {
      this._muzzleLightT = Math.max(0, this._muzzleLightT - dt);
      this._muzzleLight.intensity = this._muzzleLightPeak * (this._muzzleLightT / 0.055);
    } else this._muzzleLight.intensity = 0;
    if (this._blastLightT > 0) {
      this._blastLightT = Math.max(0, this._blastLightT - dt);
      this._blastLight.intensity = this._blastLightPeak
        * Math.min(1, this._blastLightT / 0.18);
    } else this._blastLight.intensity = 0;
    this._impactBurstBudget = Math.min(12, this._impactBurstBudget + dt * 30);
    this.decals.update(dt);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += dt;
      if (it.life >= it.ttl) {
        it.release(it.obj, it);
        it.obj = null; it.pool = null;
        this._recFree.push(it);
        const last = this.items.pop();
        if (i < this.items.length) this.items[i] = last;
      } else it.tick(it, dt);
    }
    for (let i = 0; i < TRACER_SLOTS; i++) {
      if (this._tracerBusy[i] && this.clock >= this._tracerExpire[i]) {
        this._tracerBusy[i] = 0;
        this._tracerPool.release(i);
      }
    }
    for (let i = 0; i < FLASH_SLOTS * 2; i++) {
      if (this._flashBusy[i] && this.clock >= this._flashExpire[i]) {
        this._flashBusy[i] = 0;
        this._flashPools[i < FLASH_SLOTS ? 0 : 1].release(i);
      }
    }
    this._updateTrails(dt);
    this.debris.update(dt, this._floorAt, this._hitWall);
    this.casings.update(dt, this._floorAt, null);
    // restos: solo hasta el slot vivo más alto; 0 en reposo
    this.debris.mesh.count = this.debris.hi + 1;
    this.casings.mesh.count = this.casings.hi + 1;
    this._syncEnv();
    // Un pool sin nada vivo no se dibuja: cero draw calls en reposo.
    for (const p of this._gpuPools) {
      p.flush();
      // instancias = tramo vivo (≤ capacidad del nivel); 0 en reposo
      if (this.clock >= p.until) { p.hi = -1; p.cursor = 0; }
      p.mesh.geometry.instanceCount = p.hi + 1;
    }
  }

  // Prepara los programas/materiales que solo aparecen al disparar o impactar.
  // Se ejecuta una vez, detrás del splash, y limpia todos los objetos de prueba.
  // target: el buffer al que se dibuja la escena (cadena de imagen). Los
  // programas dependen del destino; compilar contra la pantalla no serviría.
  async prepare(renderer, camera, target = null) {
    if (this._prepared) return;
    this._prepared = true;
    this.camera = camera;
    const p = new THREE.Vector3(0, -1000, 0);
    const q = new THREE.Vector3(0, -1000, -3);
    const n = new THREE.Vector3(0, 1, 0);
    this.tracer(p, q);
    this.muzzleFlash(p, false);
    this.muzzleFlash(q, true, { weapon: 'sniper', dir: n });
    this._impactBurstBudget = 12;
    this.impact(p, n, 'concrete');
    this.impact(q, n, 'metal', { emphasized: true });
    this.blood(p, 0xd94f3f);
    this.sniperHeadshot(q, 0x4f8de0, n);
    this.rocketExplosion(q, { normal: n, surface: 'concrete', floorY: -1000 });
    this.rocketDeath(q, 0xd94f3f, 2, n, -1000);
    this.meleeImpact(q, 0x4f8de0, n);
    this.dust(q, 'land', -1000);
    this.update(0);
    renderer.setRenderTarget(target);
    // No se usa renderer.compileAsync: su espera consulta el programa de cada
    // material dentro de un temporizador, y si entretanto un efecto caduca y
    // libera el suyo lanza un error que nadie puede capturar y la promesa no
    // se resuelve nunca (pantalla de carga atascada). Se compila de forma
    // directa y se espera aquí, tolerando materiales liberados y con tope.
    const materials = renderer.compile(this.scene, camera);
    const pending = () => [...(materials ?? [])].some((m) => {
      const program = renderer.properties.get(m).currentProgram;
      return !!program && !program.isReady();
    });
    const deadline = performance.now() + 2500;
    while (pending() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 12));
    renderer.setRenderTarget(null);
    this.update(999);
    this.clearImpacts();
    this._impactBurstBudget = 12;
  }

  // Cambio de mapa / partida: fuera marcas, partículas y restos.
  clearImpacts() {
    this.decals.clear();
    for (const p of this._gpuPools) { p.clear(); p.flush(); p.until = -1; p.mesh.geometry.instanceCount = 0; }
    this.debris.clear();
    this.casings.clear();
  }
}

/* ------------------------------------------------------- recursos únicos */

let ATLAS = null;
function sharedAtlas() {
  // el atlas se genera una vez por página (≈ 512×512 px de ruido)
  if (!ATLAS) { ATLAS = createAtlas(); ATLAS.userData.shared = true; }
  return ATLAS;
}

function shardGeometry() {
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  // aplastar unos vértices: lasca rota, no gema
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setY(i, y > 0.2 ? y * 0.55 : y);
    p.setX(i, p.getX(i) * (1 + 0.25 * Math.sin(i * 2.3)));
  }
  geo.computeVertexNormals();
  return geo;
}

function casingGeometry() {
  // cilindro unitario a lo largo de Z (la escala da calibre y largo)
  const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1);
  geo.rotateX(Math.PI / 2);
  return geo;
}
