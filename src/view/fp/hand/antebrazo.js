import { Box3, Group, Matrix4, Vector3 } from 'three';
import { pintar } from './guante.js';

// El segmento Blender tiene el codo en el origen y la muñeca en −Y.
// El factor uniforme conserva la sección del brazal relativa a la mano
// del montaje en primera persona.
export function montarAntebrazo(mano, modelo, lado, equipo, variante, proporcion) {
  const { rig, grupo } = mano;
  const segmento = modelo.getObjectByName('segment_forearm_' + (lado === 'left' ? 'L' : 'R'));
  const antebrazo = new Group();
  antebrazo.name = 'Antebrazo del soldado';
  const y = rig.largo.clone().negate();
  const x = rig.palmar.clone().cross(y).normalize();
  const base = new Matrix4().makeBasis(x, y, x.clone().cross(y));
  let extremo = Infinity;
  segmento.updateWorldMatrix(true, true);
  const alSegmento = segmento.matrixWorld.clone().invert();
  segmento.traverse(o => {
    if (!o.isMesh) return;
    const pieza = o.clone(false);
    pieza.geometry = o.geometry.clone().applyMatrix4(alSegmento.clone().multiply(o.matrixWorld));
    pieza.position.set(0, 0, 0);
    pieza.quaternion.identity();
    pieza.scale.setScalar(1);
    pieza.material = pintar(pieza.geometry, o.material.name, equipo, variante, segmento.name.slice(8));
    pieza.geometry.computeBoundingBox();
    extremo = Math.min(extremo, pieza.geometry.boundingBox.min.y);
    antebrazo.add(pieza);
  });
  // Centrar la boca distal es importante: el escultor desplazó la coraza
  // respecto al eje del codo. Se conserva íntegra la malla de ambas caras.
  const tapa = new Box3(), pos = new Vector3();
  for (const pieza of antebrazo.children) {
    const vs = pieza.geometry.attributes.position;
    for (let i = 0; i < vs.count; i++) {
      pos.fromBufferAttribute(vs, i);
      if (pos.y < extremo + .001) tapa.expandByPoint(pos);
    }
  }
  const boca = tapa.getCenter(new Vector3());
  antebrazo.quaternion.setFromRotationMatrix(base);
  antebrazo.scale.setScalar(proporcion);
  antebrazo.position.copy(rig.origen).addScaledVector(rig.largo, -.007).addScaledVector(rig.palmar, .001)
    .sub(boca.multiplyScalar(proporcion).applyQuaternion(antebrazo.quaternion));
  grupo.add(antebrazo);
  return antebrazo;
}
