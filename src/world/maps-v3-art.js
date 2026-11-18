// Arte de las piezas estructurales de los mapas v3 que no son cajas de la
// geometría compartida: lo que hay DEBAJO y ENTRE las losas de un mapa con
// huecos (Azoteas). Decoración pura: ni colisión ni cover.
import * as THREE from 'three';
import { MAP_FLOORS, AZOTEAS_3 } from './map-dims.js';

export function decorateMapV3(world, layout) {
  if (layout !== 'azoteas' || !MAP_FLOORS.azoteas) return null;
  const root = new THREE.Group();
  root.name = 'maps-v3';
  world.mapGroup.add(root);
  const A = AZOTEAS_3;
  const DEPTH = 8; // la calle está a -8 (ver _decorAzoteas)

  // EDIFICIOS: cada azotea es la tapa de un edificio que baja hasta la calle.
  // Se ven sus fachadas al asomarse al vacío y desde los puentes.
  const facade = (w, h) => new THREE.MeshBasicMaterial({
    map: world._tex('windows', Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 8))), color: 0x8e9db0,
  });
  const dark = new THREE.MeshBasicMaterial({ color: 0x0d121b });
  const masses = [
    [0, 0, A.gap[0] * 2, 81.6],
    ...[1, -1].map((s) => [s * (A.gap[1] + A.annexX[1] + 0.8) / 2, 0, A.annexX[1] + 0.8 - A.gap[1], A.annexZ * 2 + 1.6]),
  ];
  for (const [x, z, w, d] of masses) {
    const sideX = facade(d, DEPTH), sideZ = facade(w, DEPTH);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, DEPTH, d - 0.04), [sideX, sideX, dark, dark, sideZ, sideZ]);
    m.name = 'v3-building-mass';
    m.position.set(x, -DEPTH / 2 - 0.03, z);
    root.add(m);
  }

  // PUENTES: losa, vigas de celosía por debajo y franjas de seguridad
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a5661, metalness: 0.6, roughness: 0.5 });
  const hazard = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.6 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0x8fe3ff });
  const cube = (name, x, y, z, w, h, d, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.name = name; m.position.set(x, y, z); root.add(m); return m;
  };
  const len = A.gap[1] - A.gap[0], cx = (A.gap[0] + A.gap[1]) / 2, half = A.bridgeHalf;
  for (const s of [1, -1]) for (const z of A.bridges) {
    const x = s * cx;
    cube('v3-bridge-slab', x, -0.2, z, len, 0.36, half * 2 + 0.6, steel);
    for (const e of [-1, 1]) {
      cube('v3-bridge-girder', x, -0.75, z + e * (half + 0.1), len, 0.9, 0.16, steel);
      cube('v3-bridge-stripe', x, 0.014, z + e * (half - 0.12), len, 0.012, 0.12, hazard);
      // balizas en los cuatro extremos: el puente se localiza de lejos
      for (const ex of [-1, 1]) cube('v3-bridge-beacon', x + ex * (len / 2 - 0.15), 1.16, z + e * (half + 0.15), 0.12, 0.1, 0.12, lamp);
    }
    for (let i = -1; i <= 1; i++) cube('v3-bridge-brace', x + i * 1.5, -0.75, z, 0.12, 0.7, half * 2, steel);
  }
  return root;
}
