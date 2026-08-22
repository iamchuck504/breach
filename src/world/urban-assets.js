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
