import { trimRelief } from './trim-relief.js';
import { Box3, FrontSide } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { DISTRICT_FACADES } from './district-facades.js';
import { isCustomLayout, getMap } from './map-data.js';
import { MAPS } from '../game/lobby-rules.js';

// MANIFIESTO de modelos: id → archivo (todos viven en assets/calle/ por
// historia, aunque haya piezas de Fortaleza y Azoteas).
const URBAN_ASSETS = Object.freeze({
  ...Object.fromEntries(['metro','prision','pueblo','roof-tank'].map(id=>[`refined-${id}`,`refined-${id}.glb`])),
  'fortress-kit':'fortress-kit.glb',
  'fortaleza-galleries':'fortaleza-galleries.glb',
  ...Object.fromEntries(['fort-gate','roof-access','roof-grille','roof-cabinet'].map(id=>[id,`${id}.glb`])),
  ...Object.fromEntries(['coffee','hotdog','news','dumpster','jersey','roadwork','shelter'].map(id=>[`prop-${id}`,`prop-${id}.glb`])),
  ...Object.fromEntries(Object.values(DISTRICT_FACADES).filter(id=>id!=='cornerCoffee').map(id=>[id,`${id}.glb`])),
  cornerCoffee: 'corner-coffee.glb',
  apartmentBlock: 'apartment-block-01.glb',
  busShelter: 'bus-shelter-01.glb',
  cornerStore: 'corner-store-01.glb',
  shopfrontRow: 'deco-shopfront-row.glb',
  fireHydrant: 'fire-hydrant.glb',
  glassSkyscraper: 'glass-skyscraper-01.glb',
  glassSupertall: 'glass-supertall-01.glb',
  streetlight: 'led-streetlight-01.glb',
  suvMinivan: 'suv-minivan.glb',
  waterfrontTower: 'waterfront-condo-tower.glb',
});

// Calle original: fachadas de fondo, skyline, mobiliario y el SUV (Draco).
const CALLE_LEGACY = ['apartmentBlock','busShelter','cornerStore','shopfrontRow','fireHydrant',
  'glassSkyscraper','glassSupertall','streetlight','suvMinivan','waterfrontTower'];

// MANIFIESTO mapa → ids: la ÚNICA fuente de verdad de qué baja cada mapa.
// Medido instrumentando cloneUrbanAsset al construir cada mapa (gfx alto y
// bajo, con y sin look); en DEV, pedir un id fuera de la lista avisa.
const MAP_ASSETS = Object.freeze({
  fortaleza: ['fortress-kit','fortaleza-galleries','fort-gate'],
  azoteas: ['refined-roof-tank','roof-access','roof-grille','roof-cabinet'],
  // Calle #2 solo usa nueve de las trece fachadas de distrito; busShelter
  // queda como respaldo si prop-shelter falla.
  calle2: [...CALLE_LEGACY,'cornerCoffee',
    ...['cedar-pharmacy','motor-works','neighbor-market','night-owl-cafe','oven-no-8','paper-ink',
      'signal-electronics','south-end-deli','spin-cycle'].map(n=>`district-${n}`),
    ...['coffee','hotdog','news','dumpster','jersey','roadwork','shelter'].map(id=>`prop-${id}`)],
  calle: CALLE_LEGACY,
  // mapas retirados (solo los alcanza un clon del editor)
  metro: ['refined-metro'], prision: ['refined-prision'], pueblo: ['refined-pueblo'],
});

// El fondo del menú es Azoteas (World nace con ese mapa en main.js).
export const MENU_LAYOUT = 'azoteas';

// Ids que necesita un layout. Un mapa del editor hereda los de su base (si
// conserva la decoración) más las piezas GLB que coloca.
export function assetIdsForLayout(layout) {
  if (!isCustomLayout(layout)) return MAP_ASSETS[layout] ?? [];
  const map = getMap(layout);
  if (!map) return [];
  if (map.decor === false) return [];
  const ids = new Set(MAP_ASSETS[map.base] ?? []);
  for (const o of map.objects ?? []) if (String(o.p).startsWith('urban:')) ids.add(o.p.slice(6));
  return [...ids].filter((id) => URBAN_ASSETS[id]);
}

const cache = new Map();    // id → escena lista para clonar
const pending = new Map();  // id → promesa de carga (descarga + parseo)
const bytes = new Map();    // id → promesa del ArrayBuffer aún sin parsear
const failed = new Set();   // fallaron: se reintentan en el siguiente uso
// Vite solo existe en el navegador: los scripts de Node importan World (y
// con él este módulo) sin import.meta.env, así que se lee tarde y con respaldo.
const viteEnv = () => import.meta.env ?? {};
const baseUrl = () => viteEnv().BASE_URL || '/';
const isDev = () => !!viteEnv().DEV;
const urlOf = (id) => `${baseUrl()}assets/calle/${URBAN_ASSETS[id]}`;
let loader = null, draco = null;

// El SUV viene como un único mesh Draco con un solo material y colores por
// vértice, por lo que no existe un material "glass" que podamos sustituir.
// Oscurecemos únicamente los vértices azulados que viven en el volumen de la
// cabina (laterales, parabrisas y vidrio trasero) una sola vez al precargarlo.
// La carrocería, llantas, luces y cromados conservan sus colores originales.
function darkenSuvWindows(scene) {
  let changed = 0;
  scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    const sourceColor = mesh.geometry.getAttribute('color');
    if (!position || !sourceColor) return;

    const geometry = mesh.geometry.clone();
    const color = geometry.getAttribute('color');
    let meshChanged = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      const inCabinHeight = y > 0.69 && y < 1.23;
      const sideWindow = Math.abs(x) > 0.51 && Math.abs(x) < 0.70 &&
        z > -1.42 && z < 0.73;
      const endWindow = Math.abs(x) < 0.58 && (z > 0.50 || z < -1.20);
      const r = color.getX(i), g = color.getY(i), b = color.getZ(i);
      const blueGlass = b > g + 0.014 && g > r + 0.009;
      if (!inCabinHeight || (!sideWindow && !endWindow) || !blueGlass) continue;
      color.setXYZ(i, 0.004, 0.006, 0.008);
      meshChanged++;
      changed++;
    }
    if (!meshChanged) {
      geometry.dispose();
      return;
    }
    color.needsUpdate = true;
    mesh.geometry = geometry;
  });
  scene.userData.suvDarkWindowVertices = changed;
}


// Las texturas de un modelo en caché las comparten todos los mapas (y los
// materiales que el look clona): las dos limpiezas respetan estas marcas.
function markShared(scene, id) {
  scene.name = `urban-${id}`;
  scene.updateWorldMatrix(true, true);
  scene.userData.urbanMinY = new Box3().setFromObject(scene).min.y;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.userData.urbanAssetShared = true;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const material of materials) {
      material.userData.urbanAssetShared = true;
      for (const value of Object.values(material)) {
        if (value?.isTexture) { value.userData.cached = true; value.userData.shared = true; }
      }
    }
  });
}

// Solo unos pocos GLB heredados de Calle usan Draco: el decodificador (≈760 KB)
// se pide únicamente si el JSON del archivo declara la extensión.
function needsDraco(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return false;
  const json = new TextDecoder().decode(new Uint8Array(buffer, 20, view.getUint32(12, true)));
  return json.includes('KHR_draco_mesh_compression');
}

function gltfLoader(withDraco) {
  loader ??= new GLTFLoader();
  if (withDraco && !draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(`${baseUrl()}draco/`);
    draco.setDecoderConfig({ type: 'wasm' });
    loader.setDRACOLoader(draco);
  }
  return loader;
}

// Sin cargas en curso se liberan los workers de Draco (como antes, tras la
// precarga); si otro archivo lo necesita después se crea uno nuevo.
function releaseDraco() {
  if (pending.size || !draco) return;
  draco.dispose(); draco = null;
  loader.setDRACOLoader(null);
}

// Nada espera para siempre: una descarga sin avance durante STALL_MS se aborta
// (y el siguiente uso la intenta de cero); el parseo tiene su propio tope.
const STALL_MS = 15000, PARSE_MS = 20000;
const withTimeout = (promise, ms, what) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: más de ${ms} ms`)), ms))]);

// Como mucho 4 descargas a la vez: HTTP/1.1 da 6 conexiones por servidor y
// el resto (estado de la sala en /status, audio) no debe quedar en cola
// detrás de los modelos. El ancho de banda total es el mismo.
const MAX_PARALLEL = 4;
let active = 0;
const queue = [];
async function slot() {
  if (active < MAX_PARALLEL) { active++; return; }
  await new Promise((r) => queue.push(r));
}
function release() {
  const next = queue.shift();
  if (next) next(); else active--;
}

async function download(id, priority) {
  await slot();
  try { return await downloadNow(id, priority); } finally { release(); }
}

async function downloadNow(id, priority) {
  const ctrl = new AbortController();
  let timer = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL_MS); };
  arm();
  try {
    const r = await fetch(urlOf(id), { priority, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!r.body?.getReader) return await r.arrayBuffer();
    const reader = r.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out.buffer;
  } finally { clearTimeout(timer); }
}

function fetchBytes(id, priority) {
  let p = bytes.get(id);
  if (!p) {
    p = download(id, priority);
    bytes.set(id, p);
    p.catch(() => { if (bytes.get(id) === p) bytes.delete(id); });
  }
  return p;
}

// Avisos de llegada: main.js repara un mapa construido con sustitutos.
const arrivalListeners = new Set();
export function onUrbanAssetArrived(cb) { arrivalListeners.add(cb); }

// Descarga + parseo de UN modelo. Nunca rechaza: un fallo avisa, deja el
// sustituto procedural y se reintenta la próxima vez que se pida.
function loadOne(id) {
  if (cache.has(id)) return Promise.resolve(true);
  if (pending.has(id)) return pending.get(id);
  if (!URBAN_ASSETS[id]) return Promise.resolve(false);
  const p = (async () => {
    const buffer = await fetchBytes(id, 'high');
    const parse = gltfLoader(needsDraco(buffer)).parseAsync(buffer, `${baseUrl()}assets/calle/`);
    const gltf = await withTimeout(parse, PARSE_MS, `parseo de ${id}`);
    if (id === 'suvMinivan') darkenSuvWindows(gltf.scene);
    // El corte se hace una sola vez antes de compartir los vértices entre copias.
    const facade = Object.values(DISTRICT_FACADES).includes(id);
    if (facade) gltf.scene.traverse(o=>{
      // Son volúmenes de Blender. Dibujar su reverso dejaba el ladrillo y
      // el canto interior del marco disputándose el mismo píxel.
      if (o.isMesh && /^(Brick tone [0-4]|Charcoal painted metal|Warm limestone|Recessed mortar)$/.test(o.material.name))
        o.material.side=FrontSide;
    });
    if (facade || id.startsWith('prop-') ||
        ['suvMinivan','roof-access','roof-grille','roof-cabinet','refined-roof-tank'].includes(id)) {
      // La profundidad de la rejilla se instancia al 45 % y la del armario al 85 %.
      const depthScale = id==='roof-grille' ? .45 : id==='roof-cabinet' ? .85 : 1;
      trimRelief(gltf.scene, .00205/depthScale);
    }
    markShared(gltf.scene, id);
    cache.set(id, gltf.scene);
    failed.delete(id);
    return true;
  })().catch((e) => {
    failed.add(id);
    console.warn(`Asset urbano "${id}" no pudo cargarse: se usa el sustituto.`, e);
    return false;
  }).finally(() => {
    if (bytes.get(id)) bytes.delete(id);
    if (pending.get(id) === p) pending.delete(id);
    releaseDraco();
  });
  pending.set(id, p);
  p.then((ok) => { if (ok) for (const cb of arrivalListeners) cb(id); });
  return p;
}

function loadIds(ids) {
  return Promise.all(ids.map(loadOne)).then((ok) => ({ loaded: cache.size, failed: ok.filter((v) => !v).length }));
}

// ¿Están ya en memoria todos los modelos del mapa? (un id que falló cuenta
// como no listo: ensureMapAssets lo reintenta)
export function mapAssetsReady(layout) {
  return assetIdsForLayout(layout).every((id) => cache.has(id));
}

// Espera los modelos de un mapa antes de construirlo. Resuelve siempre (los
// fallos dejan sustitutos); timeoutMs acota además la espera total.
export function ensureMapAssets(layout, { timeoutMs = 0 } = {}) {
  const job = loadIds(assetIdsForLayout(layout));
  if (!timeoutMs) return job;
  return Promise.race([job, new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs))]);
}

// En línea la rotación recorre todos los mapas jugables: se cargan todos
// antes de poder entrar a una sala o a una partida empezada.
const PLAYABLE_IDS = [...new Set(MAPS.flatMap((m) => MAP_ASSETS[m] ?? []))];
export const playableMapAssetsReady = () => PLAYABLE_IDS.every((id) => cache.has(id));
export function ensurePlayableMapAssets({ timeoutMs = 0 } = {}) {
  const job = loadIds(PLAYABLE_IDS);
  if (!timeoutMs) return job;
  return Promise.race([job, new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs))]);
}

// Compatibilidad (editor y scripts): sin argumentos carga la biblioteca entera.
export function preloadUrbanAssets(ids = Object.keys(URBAN_ASSETS)) {
  return loadIds(ids);
}

// En segundo plano, uno a uno y en tiempo ocioso, baja (prioridad baja) y
// prepara los modelos de los otros mapas jugables: un cambio de mapa
// posterior ya no espera. Los pocos GLB con Draco solo se descargan; se
// decodifican si de verdad se juega Calle (el decodificador no baja antes).
let backgroundStarted = false;
export function prefetchOtherMapAssets() {
  if (backgroundStarted) return;
  backgroundStarted = true;
  const idle = () => new Promise((r) => (globalThis.requestIdleCallback ? requestIdleCallback(r, { timeout: 3000 }) : setTimeout(r, 300)));
  (async () => {
    for (const id of PLAYABLE_IDS) {
      // primero lo que una partida esté esperando (cada carga tiene tope)
      while (pending.size) await Promise.allSettled([...pending.values()]);
      if (cache.has(id) || pending.has(id) || failed.has(id)) continue;
      await idle();
      const buffer = await fetchBytes(id, 'low').catch(() => null);
      if (!buffer || needsDraco(buffer) || cache.has(id)) continue;
      await idle(); // el parseo, en otro hueco ocioso
      await loadOne(id);
    }
  })();
}

// --- Control de construcción: cada setLayout declara qué mapa construye ----
let building = null;
const warned = new Set();

export function beginUrbanBuild(layout) {
  building = { layout, ids: new Set(assetIdsForLayout(layout)), standIns: [] };
}

// Devuelve los ids que se pidieron sin estar en memoria (se usó sustituto).
export function endUrbanBuild() {
  const standIns = building?.standIns ?? [];
  building = null;
  return standIns;
}

// ¿Llegó alguno de los modelos que faltaban? Entonces vale la pena rehacer.
export function urbanAssetsArrived(standIns) {
  return !!standIns?.some((id) => cache.has(id));
}

export function cloneUrbanAsset(id) {
  const source = cache.get(id);
  if (building) {
    if (isDev() && !building.ids.has(id) && !warned.has(`${building.layout}:${id}`)) {
      warned.add(`${building.layout}:${id}`);
      console.warn(`[urban-assets] el mapa "${building.layout}" pide "${id}", que no está en su lista de MAP_ASSETS.`);
    }
    if (!source && !building.standIns.includes(id)) {
      building.standIns.push(id);
      if (isDev() && pending.has(id)) {
        console.warn(`[urban-assets] "${building.layout}" se construye con "${id}" aún en vuelo (sustituto).`);
      }
    }
  }
  if (!source) return null;
  return source.clone(true);
}

// Para scripts de verificación.
export function urbanAssetState() {
  return { cached: [...cache.keys()], pending: [...pending.keys()], prefetched: [...bytes.keys()],
    failed: [...failed], draco: !!draco, background: backgroundStarted };
}
