import { Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const URBAN_ASSETS = Object.freeze({
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

const cache = new Map();
let preloadPromise = null;

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

function markShared(scene, id) {
  scene.name = `urban-${id}`;
  scene.updateWorldMatrix(true, true);
  scene.userData.urbanMinY = new Box3().setFromObject(scene).min.y;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.userData.urbanAssetShared = true;
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    for (const material of materials) material.userData.urbanAssetShared = true;
  });
}

// Los GLB se precargan durante PREPARANDO. Cada archivo es Draco, un solo
// mesh/material y color por vértice: la carga ocurre una vez y los mapas
// comparten geometría/material sin volver a compilarla al cambiar de mapa.
export function preloadUrbanAssets() {
  if (preloadPromise) return preloadPromise;

  const base = import.meta.env.BASE_URL || '/';
  const draco = new DRACOLoader();
  draco.setDecoderPath(`${base}draco/`);
  draco.setDecoderConfig({ type: 'wasm' });
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  preloadPromise = Promise.allSettled(Object.entries(URBAN_ASSETS).map(async ([id, file]) => {
    const gltf = await loader.loadAsync(`${base}assets/calle/${file}`);
    if (id === 'suvMinivan') darkenSuvWindows(gltf.scene);
    markShared(gltf.scene, id);
    cache.set(id, gltf.scene);
    return id;
  })).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) console.warn(`Assets urbanos: ${failed.length} no pudieron cargarse.`, failed);
    return { loaded: cache.size, failed: failed.length };
  }).finally(() => draco.dispose());

  return preloadPromise;
}

export function cloneUrbanAsset(id) {
  const source = cache.get(id);
  if (!source) return null;
  return source.clone(true);
}
