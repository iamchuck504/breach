// La vista en primera persona y el proyectil comparten el mismo GLB en memoria.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const models = new Map();
export function loadGLB(name) {
  if (!models.has(name)) {
    const url = `${import.meta.env?.BASE_URL ?? '/'}assets/fp/${name}.glb`;
    models.set(name, new GLTFLoader().loadAsync(url).then((g) => g.scene));
  }
  return models.get(name);
}
