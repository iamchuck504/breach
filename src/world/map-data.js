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
  // --- assets urbanos GLB (misma biblioteca que usa Calle Cerrada en vivo).
  // Decorativos: la colisión se pone aparte con cajas visual:false, igual que
  // hace el propio mapa Calle.
  ...['apartmentBlock', 'busShelter', 'cornerStore', 'shopfrontRow', 'fireHydrant',
    'glassSkyscraper', 'glassSupertall', 'streetlight', 'suvMinivan', 'waterfrontTower']
    .map((assetId) => ({
      id: 'urban:' + assetId, group: 'assets', label: assetId.toUpperCase(),
      icon: '⌂', metaKey: 'editor.meta.urban', t: 'urban', assetId,
    })),
  // Props procedurales de Calle Cerrada. Al clonar el mapa pasan a ser datos
  // editables para que la carrocería visible y su collider se muevan juntos.
  { id: 'street:vehicle', group: 'assets', label: 'SEDÁN', icon: '▰',
    metaKey: 'editor.meta.urban', t: 'street', assetKind: 'vehicle', w: 2.05, d: 4.45, h: 1.48 },
  { id: 'street:truck', group: 'assets', label: 'CAMIÓN', icon: '▮',
    metaKey: 'editor.meta.urban', t: 'street', assetKind: 'truck', w: 2.4, d: 7, h: 3.0 },
  { id: 'street:bus', group: 'assets', label: 'AUTOBÚS', icon: '▬',
    metaKey: 'editor.meta.urban', t: 'street', assetKind: 'bus', w: 2.65, d: 9, h: 3.25 },
  // --- herramienta del editor: personaje de REFERENCIA con las dimensiones
  // reales del juego. No colisiona, no aparece en partida y el export lo
  // elimina — es la regla de escala del entorno.
  { id: 'charRef', group: 'editor', label: 'PERSONAJE REF.', labelKey: 'editor.piece.charRef',
    icon: '☺', metaKey: 'editor.meta.charRef', t: 'charRef' },
];

// Campos opcionales por objeto (los escribe el CLONADOR para fidelidad
// exacta con los mapas hechos a mano):
//   color/top   hex del cuerpo y la tapa (si faltan, paleta del tema)
//   visual      false = collider invisible (Calle pone fachadas encima)
//   cover       false = colisiona pero no genera caras de cobertura
//   surface     material de impacto ('stone'|'concrete'|'metal')
//   y           altura (special sobre el helipuerto, assets elevados)
//   scale       solo assets urbanos

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
  if (p.t === 'urban') o.scale = 1;
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
  // los EMPAQUETADOS (src/world/maps/*.json, exportados desde el editor)
  // conviven con los locales; un guardado local con el mismo id los tapa
  const all = { ...bundledStore(), ...readStore() };
  return Object.values(all).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
export function listPlayableMaps() {
  return listMaps().filter((map) => validationOk(validateMap(map)));
}
export function getMap(id) {
  if (typeof id === 'string' && id.startsWith(CUSTOM_PREFIX)) id = id.slice(CUSTOM_PREFIX.length);
  return drafts.get(id) ?? readStore()[id] ?? bundledStore()[id] ?? null;
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
  // conservar la altura: el pedestal de azoteas vive SOBRE el helipuerto
  return o ? { x: o.x, z: o.z, y: o.y ?? 0 } : null;
}

// ---------------------------------------------------------------------------
// CLONADO de mapas hechos a mano. world.snapshotLayout() reconstruye el mapa
// capturando cada caja que su builder coloca (espejo ya resuelto); esto la
// convierte en datos SIN perder nada: color exacto, cover, colliders
// invisibles bajo fachadas, material de impacto. `base` hace que el mundo
// corra el builder original para la decoración (fachadas, GLBs, helipuerto)
// suprimiendo sus cajas — las de aquí, ya editables, las sustituyen.
// ---------------------------------------------------------------------------
export function mapFromSnapshot(layout, snap, name = null) {
  const oid = () => 'o' + Math.random().toString(36).slice(2, 9);
  const pieceFor = (h) => (h <= BLOCK.LOW + 1e-6 ? 'coverLow'
    : h <= BLOCK.MID + 1e-6 ? 'coverMid' : 'wall');
  const objects = snap.boxes.map((b) => ({
    id: oid(), p: pieceFor(b.h), x: b.x, z: b.z, rot: 0,
    w: b.w, d: b.d, h: b.h, color: b.color, top: b.top,
    ...(b.cover === false ? { cover: false } : null),
    ...(b.visual === false ? { visual: false } : null),
    ...(b.surface ? { surface: b.surface } : null),
  }));
  // La decoración editable se captura separada de las cajas jugables.
  // Los vehículos se enlazan con el collider invisible que comparte centro,
  // de modo que moverlos actualice visual, cover, disparos y navegación.
  for (const d of snap.decor ?? []) {
    const p = d.kind === 'urban' ? `urban:${d.assetId}` : `street:${d.kind}`;
    if (!paletteById(p)) continue;
    const object = {
      id: oid(), p, x: d.x, z: d.z,
      rot: (((d.rotation ?? 0) * 180 / Math.PI) % 360 + 360) % 360,
      ...(d.y ? { y: d.y } : null),
      ...(d.scale && d.scale !== 1 ? { scale: d.scale } : null),
      ...(d.color != null ? { color: d.color } : null),
      ...(d.variant != null ? { variant: d.variant } : null),
      ...(d.w ? { w: d.w } : null),
      ...(d.d ? { d: d.d } : null),
      ...(d.h ? { h: d.h } : null),
      baseDecor: true,
    };
    const collider = objects.find((o) => o.visual === false && !o.link &&
      Math.hypot(o.x - object.x, o.z - object.z) < 0.12);
    if (collider) {
      const link = 'link-' + Math.random().toString(36).slice(2, 9);
      collider.link = link;
      object.link = link;
    }
    objects.push(object);
  }
  for (const team of ['red', 'blue']) {
    for (const s of snap.spawns[team] ?? []) {
      const yaw = s.yaw ?? 0;
      objects.push({
        id: oid(), p: team === 'red' ? 'spawnRed' : 'spawnBlue',
        x: s.x, z: s.z, rot: ((yaw * 180 / Math.PI) % 360 + 360) % 360, yaw,
      });
    }
  }
  for (const c of snap.crates ?? []) objects.push({ id: oid(), p: 'ammo', x: c.x, z: c.z, rot: 0 });
  if (snap.special) {
    objects.push({
      id: oid(), p: 'special', x: snap.special.x, z: snap.special.z, rot: 0,
      ...(snap.special.y ? { y: snap.special.y } : null),
    });
  }
  return {
    v: MAP_FORMAT_VERSION,
    id: 'map-' + Math.random().toString(36).slice(2, 8),
    name: name || (layout.toUpperCase() + ' COPIA'),
    theme: layout,
    base: layout,     // decoración: el builder original corre intacto
    decorCaptured: true,
    fx: snap.fx, fz: snap.fz,
    walls: false,     // el perímetro ya viene capturado como cajas editables
    objects,
  };
}

// ---------------------------------------------------------------------------
// EXPORT / IMPORT a fichero. El fichero ES el formato del juego: no existe
// una conversión — solo se eliminan las herramientas del editor (charRef).
// ---------------------------------------------------------------------------
export function exportableMap(map) {
  const clean = JSON.parse(JSON.stringify(map));
  clean.objects = clean.objects.filter((o) => paletteById(o.p)?.group !== 'editor');
  return clean;
}

export function serializeMap(map) {
  return JSON.stringify(exportableMap(map), null, 2);
}

// Devuelve { map } o { error } — jamás toca el almacén si el JSON no valida.
export function parseMapFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { error: 'JSON inválido' }; }
  if (!data || typeof data !== 'object') return { error: 'Formato desconocido' };
  if (typeof data.v !== 'number' || data.v > MAP_FORMAT_VERSION) {
    return { error: `Versión de formato no soportada (${data.v})` };
  }
  if (!Array.isArray(data.objects)) return { error: 'El mapa no tiene objetos' };
  if (typeof data.fx !== 'number' || typeof data.fz !== 'number') {
    return { error: 'Dimensiones inválidas' };
  }
  const unknown = data.objects.filter((o) => !paletteById(o.p)).length;
  data.id = data.id || ('map-' + Math.random().toString(36).slice(2, 8));
  data.name = String(data.name || 'MAPA IMPORTADO');
  return { map: data, unknownPieces: unknown };
}

// Mapas EMPAQUETADOS: ficheros exportados que se suben al repo en
// src/world/maps/*.json y quedan disponibles como mapas del juego (modos
// locales). import.meta.glob lo resuelve Vite en build; en Node (el server
// importa esta cadena) la llamada revienta y el catch deja el almacén vacío.
let _bundled = null;
function bundledStore() {
  if (_bundled) return _bundled;
  _bundled = {};
  try {
    const files = import.meta.glob('./maps/*.json', { eager: true });
    for (const mod of Object.values(files)) {
      const map = mod.default ?? mod;
      if (map?.id && Array.isArray(map.objects)) _bundled[map.id] = map;
    }
  } catch { /* Node: sin bundle */ }
  return _bundled;
}
export function bundledMaps() { return Object.values(bundledStore()); }

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
    // Fachadas/skyline capturados del builder viven deliberadamente fuera
    // del rectángulo jugable. Siguen siendo editables, pero no invalidan el
    // mapa mientras conserven esa condición de decoración base.
    if (o.baseDecor && !o.link) return true;
    const piece = paletteById(o.p);
    const fp = piece && (piece.t === 'box' || piece.t === 'prop' || piece.t === 'street')
      ? footprint(o) : { w: 1.2, d: 1.2 };
    // margen +1.2: los muros perimetrales de un CLON son cajas normales que
    // viven justo fuera de fx/fz (±fx+0.4, medio ancho 0.4/1.0)
    return Math.abs(o.x) + fp.w / 2 <= map.fx + 1.2 && Math.abs(o.z) + fp.d / 2 <= map.fz + 1.2;
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

    // Para un pickup, la geometría LOW no es "pared": se recoge parado al
    // lado o encima (en la fortaleza real un crate roza una plataforma baja).
    // Solo MID/HIGH lo dejarían físicamente inaccesible.
    const pickupFree = (x, z, r) => !world.colliders.some((c) => {
      if (c.h <= BLOCK.LOW + 0.01) return false;
      const dx = Math.max(c.minx - x, 0, x - c.maxx);
      const dz = Math.max(c.minz - z, 0, z - c.maxz);
      return Math.hypot(dx, dz) < r;
    });
    const blockedPickups = [...crates, ...(special ? [special] : [])]
      .filter((c) => !pickupFree(c.x, c.z, 0.45));
    if (blockedPickups.length) add('error', 'pickupClear', `${blockedPickups.length} pickup(s) dentro de geometría`, { count: blockedPickups.length });
    else if (crates.length || special) add('ok', 'pickupClear', 'Pickups accesibles');

    const covers = world.faces.filter((f) => f.h <= 2.6).length;
    if (covers < 8) add('warn', 'cover', `Poca cobertura utilizable (${covers} caras)`, { count: covers });
    else add('ok', 'cover', `Cobertura utilizable (${covers} caras)`, { count: covers });
  }
  return out;
}

export const validationOk = (report) => !report.some((r) => r.level === 'error');
