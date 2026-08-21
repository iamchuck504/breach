// Formato de mapa POR DATOS de Breach + almacén local + catálogo de piezas.
//
// Regla de diseño: NO existe un "formato del editor" y otro "formato del
// juego". Un mapa de datos se construye con exactamente el mismo pipeline
// que los mapas escritos a mano (world._box → colliders/faces/batch), así
// que lo que el editor dibuja es literalmente lo que el juego simula.
//
// Restricción heredada de la arquitectura: la geometría jugable es AABB
// (colisión y cover se derivan de cajas alineadas a los ejes). Por eso las
// piezas de gameplay solo rotan en pasos de 90° (intercambian ancho/fondo);
// la rotación libre queda para props decorativos, que no colisionan.
import { BLOCK } from './block-heights.js';

export const MAP_FORMAT_VERSION = 1;
const STORE_KEY = 'breach.maps.v1';
export const CUSTOM_PREFIX = 'custom:';
// Borradores vivos del editor. El mundo puede reconstruirlos sin escribir en
// localStorage en cada pixel de un arrastre; solo GUARDAR los hace persistentes.
const drafts = new Map();

// Temas = ambiente + texturas + piso de un mapa existente (se reutilizan tal
// cual: el editor no inventa arte nuevo).
export const THEMES = ['fortaleza', 'azoteas', 'calle', 'metro', 'prision', 'pueblo'];

// ---------------------------------------------------------------------------
// Catálogo de piezas. `build` describe la caja jugable; los props solo dibujan.
// ---------------------------------------------------------------------------
export const PALETTE = [
  // --- gameplay (generan colisión y cover reales)
  { id: 'coverLow', group: 'gameplay', label: 'COVER BAJO', labelKey: 'editor.piece.coverLow', icon: '▰', metaKey: 'editor.meta.lowCover', t: 'box',
    w: 2.6, d: 0.9, h: BLOCK.LOW, cover: true },
  { id: 'coverMid', group: 'gameplay', label: 'COVER MEDIO', labelKey: 'editor.piece.coverMid', icon: '▰', metaKey: 'editor.meta.midCover', t: 'box',
    w: 3.0, d: 1.0, h: BLOCK.MID, cover: true },
  { id: 'wall', group: 'gameplay', label: 'PARED', labelKey: 'editor.piece.wall', icon: '▮', metaKey: 'editor.meta.highCover', t: 'box',
    w: 4.0, d: 1.0, h: BLOCK.HIGH, cover: true },
  { id: 'pillar', group: 'gameplay', label: 'PILAR', labelKey: 'editor.piece.pillar', icon: '◆', metaKey: 'editor.meta.highCover', t: 'box',
    w: 1.2, d: 1.2, h: BLOCK.HIGH, cover: true },
  { id: 'platform', group: 'gameplay', label: 'PLATAFORMA', labelKey: 'editor.piece.platform', icon: '▱', metaKey: 'editor.meta.lowCover', t: 'box',
    w: 2.4, d: 2.4, h: BLOCK.LOW, cover: true },
  { id: 'corner', group: 'gameplay', label: 'ESQUINA', labelKey: 'editor.piece.corner', icon: '⌜', metaKey: 'editor.meta.highCover', t: 'box',
    w: 1.0, d: 3.0, h: BLOCK.HIGH, cover: true },
  { id: 'railing', group: 'gameplay', label: 'BARANDAL', labelKey: 'editor.piece.railing', icon: '╪', metaKey: 'editor.meta.lowCover', t: 'box',
    w: 3.4, d: 0.35, h: BLOCK.LOW, cover: true },
  // --- environment (decorativo: NO colisiona, no genera cover)
  { id: 'hvac', group: 'env', label: 'HVAC', labelKey: 'editor.piece.hvac', icon: '▦', metaKey: 'editor.meta.decorative', t: 'prop', kind: 'box',
    w: 1.8, d: 1.2, h: 1.0 },
  { id: 'tank', group: 'env', label: 'TANQUE', labelKey: 'editor.piece.tank', icon: '◉', metaKey: 'editor.meta.decorative', t: 'prop', kind: 'cyl',
    w: 1.6, d: 1.6, h: 2.2 },
  { id: 'vehicle', group: 'env', label: 'VEHÍCULO', labelKey: 'editor.piece.vehicle', icon: '▰', metaKey: 'editor.meta.decorative', t: 'prop', kind: 'box',
    w: 1.9, d: 4.2, h: 1.1 },
  { id: 'barricade', group: 'env', label: 'BARRICADA', labelKey: 'editor.piece.barricade', icon: '╳', metaKey: 'editor.meta.decorative', t: 'prop', kind: 'box',
    w: 2.2, d: 0.5, h: 0.9 },
  { id: 'column', group: 'env', label: 'COLUMNA', labelKey: 'editor.piece.column', icon: '●', metaKey: 'editor.meta.decorative', t: 'prop', kind: 'cyl',
    w: 0.9, d: 0.9, h: 3.4 },
  { id: 'crateProp', group: 'env', label: 'CAJA', labelKey: 'editor.piece.crate', icon: '□', metaKey: 'editor.meta.decorative', t: 'prop', kind: 'box',
    w: 1.0, d: 1.0, h: 1.0 },
  // --- markers de gameplay (no se dibujan en partida)
  { id: 'spawnRed', group: 'marker', label: 'SPAWN ROJO', labelKey: 'editor.piece.spawnRed', icon: 'R', metaKey: 'editor.meta.marker', t: 'spawn', team: 'red' },
  { id: 'spawnBlue', group: 'marker', label: 'SPAWN AZUL', labelKey: 'editor.piece.spawnBlue', icon: 'B', metaKey: 'editor.meta.marker', t: 'spawn', team: 'blue' },
  { id: 'ammo', group: 'marker', label: 'MUNICIÓN', labelKey: 'editor.piece.ammo', icon: 'A', metaKey: 'editor.meta.marker', t: 'crate' },
  { id: 'special', group: 'marker', label: 'ARMA ESPECIAL', labelKey: 'editor.piece.special', icon: '★', metaKey: 'editor.meta.marker', t: 'special' },
];

export const paletteById = (id) => PALETTE.find((p) => p.id === id) ?? null;

export function newMap(name = 'NEW MAP') {
  const id = 'map-' + Math.random().toString(36).slice(2, 8);
  return {
    v: MAP_FORMAT_VERSION,
    id, name,
    theme: 'fortaleza',
    fx: 21, fz: 26.6,
    walls: true,          // perímetro automático (límites del mapa)
    objects: [],
  };
}

// Objeto nuevo desde una pieza del catálogo
export function makeObject(paletteId, x, z, extra = {}) {
  const p = paletteById(paletteId);
  if (!p) return null;
  const o = { id: 'o' + Math.random().toString(36).slice(2, 9), p: paletteId, x, z, rot: 0 };
  if (p.t === 'box' || p.t === 'prop') { o.w = p.w; o.d = p.d; o.h = p.h; }
  if (p.t === 'spawn') o.yaw = p.team === 'red' ? Math.PI : 0;
  return Object.assign(o, extra);
}

// Ancho/fondo EFECTIVOS: una rotación de 90° intercambia los ejes (AABB)
export function footprint(o) {
  const swap = Math.abs(Math.round((o.rot ?? 0) / 90)) % 2 === 1;
  return swap ? { w: o.d ?? 1, d: o.w ?? 1 } : { w: o.w ?? 1, d: o.d ?? 1 };
}

// ---------------------------------------------------------------------------
// Almacén local (localStorage). Guarda el MISMO objeto que consume el juego.
// ---------------------------------------------------------------------------
// El servidor importa esta cadena de módulos en Node: sin localStorage el
// almacén queda vacío en vez de reventar (los mapas del editor son locales).
const store = typeof localStorage !== 'undefined' ? localStorage : null;
function readStore() {
  try { return JSON.parse(store?.getItem(STORE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function writeStore(all) {
  store?.setItem(STORE_KEY, JSON.stringify(all));
}

export function listMaps() {
  return Object.values(readStore()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
export function listPlayableMaps() {
  return listMaps().filter((map) => validationOk(validateMap(map)));
}
export function getMap(id) {
  if (typeof id === 'string' && id.startsWith(CUSTOM_PREFIX)) id = id.slice(CUSTOM_PREFIX.length);
  return drafts.get(id) ?? readStore()[id] ?? null;
}
export function stageMap(map) {
  const copy = JSON.parse(JSON.stringify(map));
  drafts.set(copy.id, copy);
  return copy;
}
export function unstageMap(id) {
  if (typeof id === 'string' && id.startsWith(CUSTOM_PREFIX)) id = id.slice(CUSTOM_PREFIX.length);
  drafts.delete(id);
}
export function saveMap(map) {
  const all = readStore();
  const copy = JSON.parse(JSON.stringify(map));
  all[map.id] = copy;
  drafts.set(map.id, copy);
  writeStore(all);
  return map;
}
export function deleteMap(id) {
  const all = readStore();
  delete all[id];
  drafts.delete(id);
  writeStore(all);
}
export function duplicateMap(id, name) {
  const src = getMap(id);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = 'map-' + Math.random().toString(36).slice(2, 8);
  copy.name = name || (src.name + ' COPIA');
  return saveMap(copy);
}
// id que usan lobby/selector para un mapa de datos
export const mapLayoutId = (map) => CUSTOM_PREFIX + map.id;
export const isCustomLayout = (id) => typeof id === 'string' && id.startsWith(CUSTOM_PREFIX);

// ---------------------------------------------------------------------------
// Extracción de marcadores (el juego los consume desde aquí)
// ---------------------------------------------------------------------------
export function spawnsOf(map) {
  const red = [], blue = [];
  for (const o of map.objects) {
    if (o.p === 'spawnRed') red.push({ x: o.x, z: o.z, yaw: o.yaw ?? Math.PI });
    if (o.p === 'spawnBlue') blue.push({ x: o.x, z: o.z, yaw: o.yaw ?? 0 });
  }
  return { red, blue };
}
export function cratesOf(map) {
  return map.objects.filter((o) => o.p === 'ammo').map((o) => ({ x: o.x, z: o.z }));
}
export function specialOf(map) {
  const o = map.objects.find((x) => x.p === 'special');
  return o ? { x: o.x, z: o.z } : null;
}

// ---------------------------------------------------------------------------
// VALIDACIÓN: mismas reglas que exige el juego para un mapa jugable.
// Devuelve [{ level: 'ok'|'warn'|'error', key, msg }]
// ---------------------------------------------------------------------------
export function validateMap(map, world = null) {
  const out = [];
  const add = (level, key, msg, vars = {}) => out.push({
    level, key, msg, vars, i18nKey: `editor.validation.${key}.${level}`,
  });
  const { red, blue } = spawnsOf(map);
  const inBounds = (o) => {
    const piece = paletteById(o.p);
    const fp = piece && (piece.t === 'box' || piece.t === 'prop')
      ? footprint(o) : { w: 1.2, d: 1.2 };
    return Math.abs(o.x) + fp.w / 2 <= map.fx && Math.abs(o.z) + fp.d / 2 <= map.fz;
  };

  if (red.length >= 4) add('ok', 'redSpawn', `Spawns rojos (${red.length}/4)`, { count: red.length });
  else add('error', 'redSpawn', red.length
    ? `Faltan spawns rojos (${red.length}/4)` : 'Faltan spawns del equipo rojo (0/4)', { count: red.length });
  if (blue.length >= 4) add('ok', 'blueSpawn', `Spawns azules (${blue.length}/4)`, { count: blue.length });
  else add('error', 'blueSpawn', blue.length
    ? `Faltan spawns azules (${blue.length}/4)` : 'Faltan spawns del equipo azul (0/4)', { count: blue.length });

  // separación entre bandos: spawns enfrentados, no mezclados
  if (red.length && blue.length) {
    let worst = Infinity;
    for (const r of red) for (const b of blue) {
      worst = Math.min(worst, Math.hypot(r.x - b.x, r.z - b.z));
    }
    if (worst < 12) add('warn', 'spawnDist', `Spawns muy cerca entre sí (${worst.toFixed(1)}m)`, { distance: worst.toFixed(1) });
    else add('ok', 'spawnDist', `Separación entre bandos ${worst.toFixed(1)}m`, { distance: worst.toFixed(1) });
  }

  const outside = map.objects.filter((o) => !inBounds(o));
  if (outside.length) add('error', 'bounds', `${outside.length} objeto(s) fuera de los límites`, { count: outside.length });
  else add('ok', 'bounds', 'Todo dentro de los límites');

  const unknown = map.objects.filter((o) => !paletteById(o.p));
  if (unknown.length) add('error', 'unknownPiece', `${unknown.length} pieza(s) desconocida(s)`, { count: unknown.length });

  const crates = cratesOf(map);
  if (!crates.length) add('warn', 'ammo', 'Sin cajas de munición');
  else add('ok', 'ammo', `Cajas de munición (${crates.length})`, { count: crates.length });

  const special = specialOf(map);
  if (!special) add('warn', 'special', 'Sin punto de arma especial');
  else add('ok', 'special', 'Punto de arma especial');

  // Comprobaciones que necesitan la geometría ya construida
  if (world) {
    const free = (x, z, r) => {
      const p = { x, z };
      world.resolveCircle(p, r, 0);
      return Math.hypot(p.x - x, p.z - z) < 0.02;
    };
    const blockedSpawns = [...red, ...blue].filter((s) => !free(s.x, s.z, 0.6));
    if (blockedSpawns.length) add('error', 'spawnClear', `${blockedSpawns.length} spawn(s) dentro de geometría`, { count: blockedSpawns.length });
    else if (red.length || blue.length) add('ok', 'spawnClear', 'Spawns despejados');

    const blockedPickups = [...crates, ...(special ? [special] : [])]
      .filter((c) => !free(c.x, c.z, 0.45));
    if (blockedPickups.length) add('error', 'pickupClear', `${blockedPickups.length} pickup(s) dentro de geometría`, { count: blockedPickups.length });
    else if (crates.length || special) add('ok', 'pickupClear', 'Pickups accesibles');

    const covers = world.faces.filter((f) => f.h <= 2.6).length;
    if (covers < 8) add('warn', 'cover', `Poca cobertura utilizable (${covers} caras)`, { count: covers });
    else add('ok', 'cover', `Cobertura utilizable (${covers} caras)`, { count: covers });
  }
  return out;
}

export const validationOk = (report) => !report.some((r) => r.level === 'error');
