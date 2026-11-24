// Muestras de la última falange en la piel que recibe el shader. Cada
// vértice se deforma con sus cuatro pesos antes de buscar la cara del arma.
import { Box3, Matrix4, Vector3 } from 'three';
import { clearance, nearestSurface, prepare, surfaces } from './lib-fps-hand-geometry.mjs';

const samples = new WeakMap();
export function distanciaYema(vm, lado, dedo, piezas, proyeccion) {
  const mesh = vm.armsMesh;
  const { position, skinIndex } = mesh.geometry.attributes;
  const nombre = 'fp_' + lado + '_' + dedo + (dedo === 'thumb' ? '' : '-finger') + '-phalanx-distal';
  let cache = samples.get(mesh.geometry);
  if (!cache) samples.set(mesh.geometry, cache = new Map());
  if (!cache.has(nombre)) {
    const j = mesh.skeleton.bones.findIndex(b => b.name === nombre);
    const mano = vm.arms.anatomy[lado];
    const distal = mano.joints.indexOf(mesh.skeleton.bones[j]);
    const punta = mano.bones.findIndex(b => b.parent === distal && b.name.endsWith('tip'));
    const pivote = id => new Vector3().setFromMatrixPosition(new Matrix4().fromArray(mano.bones[id].inv).invert());
    const origen = pivote(distal), eje = pivote(punta).sub(origen);
    const indices = new Map();
    for (let i = 0; i < position.count; i++) if (skinIndex.getX(i) === j) {
      const punto = new Vector3().fromBufferAttribute(position, i);
      if (punto.clone().sub(origen).dot(eje) >= .8 * eje.lengthSq()) indices.set(punto.toArray().join(','), i);
    }
    cache.set(nombre, [...indices.values()]);
  }
  for (const pieza of piezas) prepare(pieza);
  let distancia = Infinity, pixeles = Infinity;
  for (const i of cache.get(nombre)) {
    const punto = mesh.localToWorld(mesh.getVertexPosition(i, new Vector3()));
    const superficie = nearestSurface(punto, piezas);
    const d = punto.distanceTo(superficie);
    if (d >= distancia) continue;
    distancia = d;
    if (proyeccion) {
      vm.root.worldToLocal(punto).applyMatrix4(proyeccion);
      vm.root.worldToLocal(superficie).applyMatrix4(proyeccion);
      pixeles = Math.hypot(640 * (punto.x - superficie.x), 360 * (punto.y - superficie.y));
    }
  }
  return proyeccion ? pixeles : distancia;
}

// El puente y la rama delantera del guardamonte están en el mismo hueso
// que el cajón. Sus dos cajas separan esas caras del resto de la carcasa.
export function guardamonteSMG(arma) {
  const cuerpo = arma.partBones.body.bone;
  const p = new Vector3();
  return surfaces(arma.mesh, b => b === cuerpo, tri => {
    tri.getMidpoint(p);
    if (Math.abs(p.x) > .0124) return false;
    return (p.z >= .003 && p.z <= .014 && p.y <= -.112 && p.y >= -.191)
      || (p.z >= .009 && p.z <= .124 && p.y >= -.197 && p.y <= -.18);
  }).get(cuerpo);
}

// Solo la camisa y sus costillas cercanas admiten el apoyo del pulgar.
// Se excluyen el cañón interior, el brocal y el resto del cajón.
export function costadoSMG(arma) {
  const cuerpo = arma.partBones.body.bone, punto = new Vector3();
  return surfaces(arma.mesh, b => b === cuerpo, tri => {
    tri.getMidpoint(punto);
    return punto.x < -.044 && punto.z < -.30 && punto.z > -.728 &&
      punto.y > -.038 && punto.y < .104 && tri.getNormal(new Vector3()).x < -.4;
  }).get(cuerpo);
}

// Comprobar también el interior de las caras: una yema junto al arma puede
// esconder una falange que la atraviese por otra arista.
export function holguraBlindaje(vm, cuerpo, nombre) {
  const mesh = vm.armsMesh, { position, skinIndex } = mesh.geometry.attributes;
  const id = mesh.skeleton.bones.findIndex(b => b.name === 'fp_L_' + nombre);
  const puntos = new Map(), inversa = mesh.skeleton.boneInverses[id];
  const guardar = p => puntos.set(p.toArray().join(','), p);
  for (let i = 0; i < position.count; i += 3) {
    if (skinIndex.getX(i) !== id) continue;
    const vs = [0,1,2].map(j => new Vector3().fromBufferAttribute(position, i+j).applyMatrix4(inversa));
    for (let j = 0; j < 3; j++) {
      guardar(vs[j]);
      guardar(vs[j].clone().lerp(vs[(j+1)%3], .5));
    }
    guardar(vs[0].clone().add(vs[1]).add(vs[2]).divideScalar(3));
  }
  prepare(cuerpo);
  const points = [...puntos.values()];
  return clearance({ bone: mesh.skeleton.bones[id], points, tree: { box: new Box3().setFromPoints(points) } }, [cuerpo]);
}

// La bomba y la palanca son superficies móviles.
export function apoyosDelArma(vm, w, piezas) {
  const cuerpo = piezas.get(w.partBones.body.bone);
  // Envolventes de la pieza continua del guardamonte exportado. Se miden
  // sus caras completas, incluidos los laterales donde descansa el índice.
  const limites = { pistol: [.03319,-.07980,-.00853,-.13365,.05613],
    stun: [.03319,-.07980,-.00853,-.13365,.05613],
    sniper: [.02597,-.10739,-.02713,-.03728,.10621],
    shotgun: [.02729,-.10913,-.02479,-.03920,.11161],
    bazooka: [.02685,-.09761,-.02927,-.05433,.08053] }[w.key];
  const guardia = w.key === 'smg' ? guardamonteSMG(w) : limites && surfaces(w.mesh,
    b => b === w.partBones.body.bone, tri => [tri.a, tri.b, tri.c].every(v =>
      Math.abs(v.x) <= limites[0] && v.y >= limites[1] && v.y <= limites[2] &&
      v.z >= limites[3] && v.z <= limites[4])).get(w.partBones.body.bone);
  return (lado, dedo) => {
    if (lado === 'L') return [w.key === 'shotgun' ? piezas.get(w.partBones.pump.bone) : cuerpo];
    if (w.prof.thrown && dedo === 'thumb') return [piezas.get(w.partBones.spoon.bone)];
    return [dedo === 'index' && guardia ? guardia : cuerpo];
  };
}
