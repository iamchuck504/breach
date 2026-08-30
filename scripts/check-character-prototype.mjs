import { strict as assert } from 'node:assert';
import * as THREE from 'three';
import { Rig } from '../src/player/rig.js';

const scene = new THREE.Scene();
const base = new Rig(scene, 'red', null, 0);
const prototype = new Rig(scene, 'red', null, 5);
const blue = new Rig(scene, 'blue', null, 5);

assert.equal(base.variant, 0, 'las variantes existentes deben conservar su índice');
assert.equal(prototype.variant, 5, 'Vanguard X debe existir como sexta variante');
assert.equal(prototype.root.userData.prototype, true,
  'el prototipo debe poder distinguirse sin reemplazar skins existentes');

// La variante visual no puede alterar el esqueleto ni las proporciones que
// utilizan hitbox, IK, cover y animaciones.
for (const path of [
  ['hips'], ['torso'], ['head'], ['aimRig'],
  ['armL', 'shoulder'], ['armL', 'elbow'], ['armL', 'hand'],
  ['armR', 'shoulder'], ['armR', 'elbow'], ['armR', 'hand'],
  ['legL', 'hip'], ['legL', 'knee'], ['legR', 'hip'], ['legR', 'knee'],
]) {
  const get = (rig) => path.reduce((value, key) => value[key], rig);
  const a = get(base).position.toArray();
  const b = get(prototype).position.toArray();
  assert.deepEqual(b, a, `el pivote ${path.join('.')} cambió de proporción`);
}

const stats = (rig) => {
  let meshes = 0;
  let vertices = 0;
  let finite = true;
  rig.root.updateWorldMatrix(true, true);
  rig.root.traverse((node) => {
    if (!node.isMesh) return;
    meshes++;
    vertices += node.geometry?.attributes?.position?.count ?? 0;
    finite &&= node.matrixWorld.elements.every(Number.isFinite);
  });
  return { meshes, vertices, finite };
};

const baseStats = stats(base);
const prototypeStats = stats(prototype);
assert(prototypeStats.finite, 'Vanguard X contiene transforms inválidos');
assert(prototypeStats.vertices > baseStats.vertices,
  'el prototipo debe añadir detalle geométrico real');

const pose = (state, extra = {}) => ({
  state, speed: state === 'run' || state === 'roadie' ? 1 : 0,
  aim: false, aimPitch: 0, aimYawErr: 0, twist: 0, firing: false,
  swapping: false, swapT: 0, reloadPose: 0, throwT: 0,
  coverLean: 0, latMove: 0, ...extra,
});

for (const weapon of ['smg', 'shotgun', 'pistol', 'grenade', 'sniper', 'bazooka']) {
  prototype.setWeapon(weapon);
  for (const state of ['idle', 'run', 'roadie', 'cover_low', 'cover_high', 'blind_over']) {
    for (let frame = 0; frame < 20; frame++) {
      prototype.update(1 / 60, pose(state, {
        aim: state.startsWith('cover'),
        firing: state.startsWith('blind'),
      }));
    }
    assert(stats(prototype).finite, `${weapon}/${state} produjo transforms inválidos`);
  }
}

assert(stats(blue).finite, 'la paleta azul del prototipo no construye correctamente');

base.dispose(scene);
prototype.dispose(scene);
blue.dispose(scene);

console.log(`CHARACTER PROTOTYPE OK · base ${baseStats.vertices} vertices · Vanguard X ${prototypeStats.vertices} vertices · 6 armas`);
