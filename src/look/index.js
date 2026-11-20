// LOOK: la capa de presentación de un mapa. Color, materiales y "vida"
// (telas, plantas, aire) se aplican DESPUÉS de construir el mapa y nunca
// tocan lo que el juego simula: ni colliders, ni caras de cobertura, ni
// spawns, ni nada que el servidor conozca.
//
// Dos mitades:
//   1. Superficies y ambiente (./<mapa>/surfaces.js):
//      cambia materiales de lo que ya existe en world.mapGroup, la luz, el
//      cielo, la niebla y la gradación.
//   2. Capas de vida (./<mapa>/<capa>.js): geometría nueva, solo decorativa.
//
// CONTRATO DE UNA CAPA DE VIDA
//   export function build(ctx) -> { update?(dt, t, camera), dispose?() } | null
//
//   ctx.THREE     la instancia de three del juego
//   ctx.group     THREE.Group donde colgar TODO. No está bajo world.mapGroup:
//                 la auditoría de hitboxes, las marcas de impacto y el editor
//                 no lo ven. Por eso una capa solo dibuja cosas que
//                 evidentemente no paran una bala (tela, plantas, aire, luz)
//                 o que quedan fuera del campo. Dentro del campo, además, no
//                 se cruza en una línea de tiro: por encima de 3.3 m a ras de
//                 suelo, y por encima de 5 m donde se dispara desde una
//                 galería (su piso está a 3 m).
//   ctx.world     el World, SOLO LECTURA: colliders [{minx,minz,maxx,maxz,h,
//                 minY?,moveOnly?}], faces, fx/fz (medio ancho/medio fondo del
//                 campo), spawns {red,blue}, layout, theme.
//   ctx.palette   la paleta del mapa (./<mapa>/palette.js). Sin hex sueltos.
//   ctx.uniforms  { uLookTime, uLookWind } — las mismas referencias para
//                 todos: se pasan tal cual a patch() (./glsl.js).
//   ctx.sunDir    Vector3 unitario hacia el sol.
//   ctx.rng(seed) generador determinista (misma decoración en todos los
//                 clientes y en cada captura). Prohibido Math.random().
//   ctx.budget    { detail: 0.35..1, particles: n, animate: bool } según la
//                 calidad gráfica. `detail` escala densidades.
//   ctx.blocked(x, z, r = 0)  true si (x,z) cae a menos de r de la huella de
//                 un collider (para no sembrar dentro de un bloque).
//   ctx.inField(x, z, margin = 0)  dentro del rectángulo jugable.
//
// PRESUPUESTO por capa: pocas llamadas de dibujo (instanciar o fusionar),
// materiales creados una vez en build(), nada de luces nuevas, sin sombras
// salvo piezas grandes y quietas, y update() sin asignar memoria.
// El gestor libera geometrías, materiales y texturas de ctx.group; dispose()
// solo hace falta para lo que no cuelgue de ahí.
import * as THREE from 'three';
import fortaleza from './fortaleza/index.js';
import azoteas from './azoteas/index.js';
import calle from './calle/index.js';

// Un directorio por TEMA (calle2 usa el tema 'calle'). Cada uno exporta
// { palette, surfaces(ctx) | null, life: [[nombre, módulo], ...] }.
const MAPS = { fortaleza, azoteas, calle };
// Las capas de vida usan coordenadas del mapa real: un clon del editor con
// el mismo tema recibe superficies y ambiente, pero no decoración.
const BUDGETS = {
  off: { detail: 0.35, particles: 0, animate: true },
  low: { detail: 0.45, particles: 120, animate: true },
  medium: { detail: 0.7, particles: 300, animate: true },
  high: { detail: 1, particles: 600, animate: true },
  ultra: { detail: 1, particles: 900, animate: true },
};

// ?look=classic (o localStorage breach.look = 'classic') deja el mapa como
// estaba antes del look: sirve para comparar y como salida de emergencia.
// ?life=flora,atmos limita las capas de vida (para trabajar una sola).
function readFlags() {
  let look = null, life = null;
  try {
    const q = new URLSearchParams(location.search);
    look = q.get('look') ?? localStorage.getItem('breach.look');
    life = q.get('life');
  } catch { /* sin almacenamiento */ }
  return { enabled: look !== 'classic' && look !== 'off', life: life == null ? null : life.split(',').filter(Boolean) };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(key) {
  let h = 2166136261;
  for (const ch of String(key)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Libera una vez cada recurso propio del árbol. Lo prestado (caché de assets
// del mapa, texturas de World) lleva userData.shared / urbanAssetShared /
// cached y no se toca.
function disposeTree(root) {
  const seen = new Set();
  const borrowed = (r) => r.userData?.shared || r.userData?.urbanAssetShared || r.userData?.cached;
  const drop = (r) => { if (r && !seen.has(r) && !borrowed(r)) { seen.add(r); r.dispose(); } };
  root.traverse((o) => {
    if (o.isInstancedMesh || o.isBatchedMesh) o.dispose(); // buffers de instancia
    drop(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (seen.has(m) || borrowed(m)) continue;
      for (const v of Object.values(m)) if (v?.isTexture) drop(v);
      drop(m);
    }
  });
}

export class MapLook {
  constructor(scene) {
    this.scene = scene;
    this.flags = readFlags();
    this.quality = 'off';
    this.group = null;
    this.parts = [];
    this.grade = null; // gradación propia del look (la lee la cadena de imagen)
    this.theme = null;
    this.time = 0;
    this.uniforms = {
      uLookTime: { value: 0 },
      uLookWind: { value: new THREE.Vector3(0.8, 0, 0.45) },
    };
  }

  get active() { return this.flags.enabled && !!this.theme; }

  // Al bajar (o subir) la calidad con un mapa puesto, su decoración se rehace
  // con el nuevo presupuesto; las superficies no cambian.
  setQuality(name) {
    const q = BUDGETS[name] ? name : 'off';
    if (q === this.quality) return;
    this.quality = q;
    if (this.group && this.ctx) this._buildLife();
  }

  // ¿Este mapa tiene look? (un clon del editor hereda el de su tema)
  has(theme) { return this.flags.enabled && !!MAPS[theme]?.surfaces; }

  // Se llama al final de World.setLayout, con el mapa ya construido y antes
  // de su primer cuadro. Apagar el look en caliente no está soportado: las
  // superficies restiladas viven en mapGroup y solo se van al reconstruirlo.
  apply(world) {
    this.clear();
    const theme = world.theme ?? world.layout;
    if (!this.has(theme)) return;
    this.theme = theme;
    const map = MAPS[theme], palette = map.palette;
    const group = this.group = new THREE.Group();
    group.name = 'look';
    this.scene.add(group);
    // ¿es el mapa hecho a mano de este tema, o un mapa de datos que lo hereda?
    const real = !world.customMap && (world.layout === theme || (theme === 'calle' && world.layout === 'calle2'));
    this.lifeMods = ((real ? map.life : null) ?? []).filter(([name]) => !this.flags.life || this.flags.life.includes(name));
    const ctx = this.ctx = {
      THREE, group, world, theme, palette, real, uniforms: this.uniforms,
      layers: new Set(this.lifeMods.map(([name]) => name)), // capas de vida que van a construirse
      sunDir: world.sun.position.clone().normalize(),
      rng: (seed) => mulberry(seedOf(`${theme}:${seed}`)),
      budget: BUDGETS[this.quality],
      blocked: (x, z, r = 0) => {
        for (const c of world.colliders) {
          if (x > c.minx - r && x < c.maxx + r && z > c.minz - r && z < c.maxz + r) return true;
        }
        return false;
      },
      inField: (x, z, margin = 0) => Math.abs(x) <= world.fx - margin && Math.abs(z) <= world.fz - margin,
    };
    try {
      const out = map.surfaces(ctx) || {};
      this.grade = out.grade ?? palette.grade ?? null;
      if (out.update || out.dispose) this.parts.push({ name: 'surfaces', ...out });
    } catch (err) {
      console.warn('[look] superficies desactivadas:', err);
    }
    this._buildLife();
  }

  // Las capas de vida se pueden rehacer solas (al cambiar la calidad gráfica)
  // sin tocar las superficies.
  _buildLife() {
    const ctx = this.ctx;
    for (const part of this.parts.filter((p) => p.layer)) {
      try { part.dispose?.(); } catch { /* nada */ }
      this.group.remove(part.layer);
      disposeTree(part.layer);
    }
    this.parts = this.parts.filter((p) => !p.layer);
    ctx.budget = BUDGETS[this.quality];
    for (const [name, mod] of this.lifeMods) {
      const layer = new THREE.Group();
      layer.name = `look-${name}`;
      this.group.add(layer);
      try {
        const part = mod.build({ ...ctx, group: layer }) || {};
        this.parts.push({ name, layer, update: part.update?.bind(part), dispose: part.dispose?.bind(part) });
      } catch (err) {
        // una capa rota nunca deja al jugador sin partida
        console.warn(`[look] capa ${name} desactivada:`, err);
        this.group.remove(layer);
        disposeTree(layer); // lo que alcanzó a construir antes de fallar
      }
    }
    this.group.updateWorldMatrix(true, true);
  }

  update(dt, camera) {
    if (!this.group) return;
    this.time += dt;
    this.uniforms.uLookTime.value = this.time;
    // racha lenta: la fuerza del viento respira
    this.uniforms.uLookWind.value.y = 0.5 + 0.5 * Math.sin(this.time * 0.21) * Math.sin(this.time * 0.057 + 1.3);
    for (const part of this.parts) {
      if (!part.update) continue;
      try { part.update(dt, this.time, camera); } catch (err) {
        console.warn(`[look] ${part.name} detenida:`, err);
        part.update = null;
      }
    }
  }

  clear() {
    for (const part of this.parts) { try { part.dispose?.(); } catch { /* nada */ } }
    this.parts = [];
    this.grade = null;
    this.theme = null;
    this.ctx = null;
    this.lifeMods = [];
    if (!this.group) return;
    this.scene.remove(this.group);
    disposeTree(this.group);
    this.group = null;
  }

  // Costo de la capa: para vigilar el presupuesto desde las capturas.
  stats() {
    const out = { calls: 0, tris: 0, layers: {} };
    if (!this.group) return out;
    for (const layer of this.group.children) {
      let calls = 0, tris = 0;
      layer.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine) || !o.visible || !o.geometry) return;
        const g = o.geometry, n = g.index ? g.index.count : g.attributes.position?.count ?? 0;
        const inst = o.isInstancedMesh ? o.count : 1;
        calls += Array.isArray(o.material) ? o.material.length : 1;
        tris += o.isMesh ? Math.floor(Math.min(n, g.drawRange.count) / 3) * inst : 0;
      });
      out.layers[layer.name] = { calls, tris };
      out.calls += calls; out.tris += tris;
    }
    return out;
  }
}
