import { Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { muestras, reconstruir } from './rig.js';
import { crearPosador } from './poses.js';
import { moldePuno } from './puno.js';
import { vestir } from './guante.js';

export { acotar, interpolar, limites, dedos } from './rig.js';
export function obtenerMalla(escena) {
  let malla;
  escena.traverse(o => { if (o.isSkinnedMesh) malla = o; });
  if (!malla) throw new Error('El recurso carece de malla con piel');
  escena.updateMatrixWorld(true);
  return malla;
}
function acolchar(rig, inflado) {
  const { malla } = rig;
  const { position, normal, skinWeight, skinIndex } = malla.geometry.attributes;
  const p = new Vector3(), n = new Vector3();
  for (let i = 0; i < position.count; i++) {
    n.fromBufferAttribute(normal, i).normalize();
    // Los fuelles entre dedos llevan un tejido fino. El acolchado se concentra
    // sobre las caras de apoyo y el dorso para conservar la luz interdigital.
    let falange = 0;
    for (let k = 0; k < 4; k++) {
      if (malla.skeleton.bones[skinIndex.getComponent(i, k)].name.includes('-finger-')) {
        falange += skinWeight.getComponent(i, k);
      }
    }
    const espesor = inflado * (1 - falange * (1 - n.dot(rig.palmar) ** 2));
    p.fromBufferAttribute(position, i).addScaledVector(n, espesor);
    position.setXYZ(i, p.x, p.y, p.z);
  }
  position.needsUpdate = true;
}
export function crearMano(escena, { mano = 'left', escala = 1, inflado = 0.002, equipo = 'red', variante = 0, referencia, avancePulgar = 0, diametroMontaje, blindajeGrueso = false, sillaPulgar, carasApoyo, puno } = {}) {
  if (!['left', 'right'].includes(mano) || !['red', 'blue'].includes(equipo) ||
      !Number.isFinite(avancePulgar) || avancePulgar < 0 || !Number.isFinite(escala) || escala <= 0 || !Number.isFinite(inflado) || inflado < 0) {
    throw new RangeError('Parámetros de mano inválidos');
  }
  if (mano === 'right' && !referencia) throw new Error('Se necesita la referencia anatómica izquierda');
  // Una copia de cálculo en reposo mantiene la pose visible intacta. Ambas
  // manos resuelven en el mismo espacio métrico, independiente del avatar.
  const copia = obtenerMalla(clone(mano === 'right' ? referencia.parent : escena));
  copia.geometry = copia.geometry.clone();
  const canon = reconstruir(copia, 'left');
  acolchar(canon, inflado);
  const pielCanon = muestras(canon);
  const poses = crearPosador(canon, pielCanon, escala, avancePulgar);
  const malla = obtenerMalla(escena);
  const rig = reconstruir(malla, mano, referencia);
  acolchar(rig, inflado);
  const piel = muestras(rig);
  const blindaje = vestir(canon, pielCanon, equipo, variante, poses, rig, mano === 'right', diametroMontaje, blindajeGrueso, carasApoyo, sillaPulgar, puno ?? moldePuno(mano));
  if (sillaPulgar) {
    // La rótula del pulgar blindado asienta sobre el borde radial del chasis,
    // por delante del collar. La cadena completa conserva sus longitudes.
    const base = rig.cadenas.thumb[0];
    const apoyo = base.getWorldPosition(new Vector3()).addScaledVector(rig.largo, sillaPulgar[0])
      .addScaledVector(rig.palmar, sillaPulgar[1]).addScaledVector(rig.ancho, sillaPulgar[2]);
    base.position.copy(base.parent.worldToLocal(apoyo));
    base.updateWorldMatrix(true, true);
  }
  if (mano === 'right') {
    const cilindro = poses.cilindro;
    poses.cilindro = d => {
      const c = cilindro(d);
      c.centro.sub(canon.origen);
      c.centro.x *= -1;
      c.centro.add(rig.origen);
      c.eje.x *= -1;
      return c;
    };
  }
  const grupo = new Group();
  grupo.add(escena);
  grupo.scale.setScalar(escala);
  malla.frustumCulled = false;
  return { grupo, rig, piel, poses, blindaje, aplicar: rig.aplicar };
}
export async function cargarMano(opciones = {}) {
  const loader = new GLTFLoader();
  const leer = lado => loader.loadAsync(`/assets/fp/hand/${lado}.glb`);
  const mano = opciones.mano ?? 'left';
  if (!['left', 'right'].includes(mano)) throw new RangeError('Lado de mano inválido');
  const [modelo, izq] = await Promise.all([leer(mano), mano === 'right' ? leer('left') : null]);
  return crearMano(modelo.scene, { ...opciones, referencia: izq && obtenerMalla(izq.scene) });
}
