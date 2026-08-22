import * as THREE from 'three';
import { World } from '../src/world/world.js';
import { resolveShot, resolveGuidedShot } from '../src/combat/ballistics.js';
import { Effects } from '../src/fx/effects.js';

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };
const near = (a, b, e = 0.001) => Math.abs(a - b) <= e;

const world = Object.create(World.prototype);
world.fx = 20; world.fz = 20; world.layout = 'fortaleza';
world.surfaceZones = [];
world.segmentColliders = [];
world.colliders = [{ minx: -1, maxx: 1, minz: -1, maxz: 1, h: 2, surface: 'stone' }];

let hit = world.raycastHit(
  new THREE.Vector3(0, 1, -5), new THREE.Vector3(0, 0, 1), 20,
);
check(hit && near(hit.t, 4), `pared a distancia incorrecta (${hit?.t})`);
check(hit?.normal.z === -1 && hit?.surface === 'stone', 'normal/material de pared incorrectos');

hit = world.raycastHit(
  new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0), 20,
);
check(hit && near(hit.t, 3) && hit.normal.y === 1, 'normal de tapa superior incorrecta');

world.colliders = [];
hit = world.raycastHit(
  new THREE.Vector3(3, 4, 2), new THREE.Vector3(0, -1, 0), 20,
);
check(hit && near(hit.t, 4) && hit.normal.y === 1 && hit.surface === 'stone', 'impacto de suelo incorrecto');

world.segmentColliders = [{
  a: { x: -2, z: 0 }, b: { x: 2, z: 0 }, n: { x: 0, z: 1 },
  half: 0.1, h: 2.2, surface: 'metal',
}];
hit = world.raycastHit(
  new THREE.Vector3(0, 1, -3), new THREE.Vector3(0, 0, 1), 20,
);
check(hit && near(hit.t, 2.9) && hit.normal.z === -1 && hit.surface === 'metal',
  'impacto de baranda rotada incorrecto');

const shotWorld = {
  raycastHit: () => ({ t: 6, normal: { x: -1, y: 0, z: 0 }, surface: 'metal' }),
  raycast: () => null,
};
let shot = resolveShot(shotWorld, [], new THREE.Vector3(), new THREE.Vector3(1, 0, 0), 20);
check(shot.kind === 'world' && shot.normal.x === -1 && shot.surface === 'metal',
  'ballistics perdió los datos del impacto estático');
shot = resolveShot(shotWorld, [{ id: 'p', x: 3, z: 0, alive: true }],
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), 20);
check(shot.kind === 'player' && !shot.normal && !shot.surface,
  'un impacto de personaje heredó datos de decal');

// ADS: la cámara ve el blanco, pero el origen físico tiene una pared cerca.
const cornerWorld = {
  raycastHit(origin) {
    return origin.x > 0.5
      ? { t: 0.7, normal: { x: -1, y: 0, z: 0 }, surface: 'stone' }
      : null;
  },
  raycast: () => null,
};
shot = resolveGuidedShot(cornerWorld,
  [{ id: 'p', x: 0, z: -5, alive: true }],
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 0),
  new THREE.Vector3(0, 0, -1), 20);
check(shot.kind === 'world' && near(shot.t, 0.7),
  'ADS atravesó una esquina entre el arma y el objetivo de cámara');

// El collider puede ser una caja simple, pero el decal debe caer sobre la
// piel visual real (fachada/capó inclinado) y omitir halos aditivos.
const visualWorld = Object.create(World.prototype);
visualWorld.mapGroup = new THREE.Group();
const halo = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({
    color: 0xffaa55, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }),
);
halo.position.set(0, 1, -0.2);
visualWorld.mapGroup.add(halo);
const hood = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ color: 0x556677, side: THREE.DoubleSide }),
);
hood.position.set(0, 1, 0);
hood.rotation.x = 0.35;
visualWorld.mapGroup.add(hood);
visualWorld.mapGroup.updateWorldMatrix(true, true);
const projected = visualWorld.projectImpactSurface(
  new THREE.Vector3(0, 1, -5), new THREE.Vector3(0, 1, -0.45),
  { x: 0, y: 0, z: -1 }, 'metal',
);
check(projected && near(projected.point.z, 0, 0.01),
  `decal no llegó a la piel visual (${projected?.point?.z})`);
check(projected?.normal.y > 0.2 && projected?.normal.z < -0.8,
  `decal no respetó la inclinación del capó (${JSON.stringify(projected?.normal)})`);
check(projected?.surface === 'metal', 'proyección visual perdió el material lógico');

const scene = new THREE.Scene();
const effects = new Effects(scene);
for (let i = 0; i < 130; i++) {
  effects.impact(new THREE.Vector3(i * 0.01, 1, 0), { x: 0, y: 0, z: -1 }, i % 2 ? 'metal' : 'concrete');
}
check(effects.decals.activeCount === 96, `pool excedió el máximo (${effects.decals.activeCount})`);
check(scene.children.filter((o) => o.name === 'impact-decals').length === 1,
  'los decals no comparten un único InstancedMesh');
check(effects.decals.mesh.material.side === THREE.DoubleSide,
  'los decals desaparecen al mirar un perfil biselado desde atrás/ángulo rasante');
effects.update(30);
check(effects.decals.activeCount === 0, 'los decals no expiraron tras su fade');

if (fail.length) {
  console.error('IMPACT ERRORS:');
  for (const msg of fail) console.error(' - ' + msg);
  process.exit(1);
}
console.log('IMPACTS OK — normales, materiales, suelo, pool y expiración');
