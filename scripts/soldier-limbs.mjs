// Extrae los triángulos del soldado distribuido en el juego. Cada isla se
// expresa en el marco rígido de su articulación, sin modificar su superficie.
import { BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, Vector3 } from 'three';

const xyz = (a, i) => new Vector3().fromArray(a, 3 * i);
// La matriz guardada permite reconstruir el segmento de tercera persona,
// también cuando la postura de reposo del escultor ya tiene los dedos cerrados.
export function soldierPiece(body, mesh, name, bind = new Matrix4()) {
  const original = bind.equals(new Matrix4());
  const fromSource = bind.clone().invert();
  const normalsFromSource = new Matrix3().getNormalMatrix(fromSource);
  const prims = [];
  for (const p of body.json.meshes[mesh.node.mesh].primitives) {
    const positions = body.accessor(p.attributes.POSITION), normals = body.accessor(p.attributes.NORMAL);
    const sourceIndices = body.accessor(p.indices);
    const remap = new Map(), P = [], N = [], I = [];
    for (let i = 0; i < sourceIndices.length; i += 3) {
      for (const src of sourceIndices.subarray(i, i + 3)) {
        if (!remap.has(src)) {
          remap.set(src, P.length / 3);
          const punto = xyz(positions, src), normal = xyz(normals, src);
          if (!original) {
            punto.applyMatrix4(fromSource);
            normal.applyNormalMatrix(normalsFromSource);
          }
          P.push(...punto.toArray());
          N.push(...normal.toArray());
        }
        I.push(remap.get(src));
      }
    }
    if (I.length) prims.push({ material: p.material, g: { P: Float32Array.from(P), N: Float32Array.from(N),
      I: Uint32Array.from(I), W: new Float32Array(P.length / 3) } });
  }
  return { name, prims, extras: { segment: mesh.node.name, bind: bind.toArray() } };
}

// La bocamanga es la isla de goma situada en el extremo proximal de la mano
// rígida. Las costuras de normales del GLB duplican vértices en los biseles.
export function punoDelSoldado(modelo, lado) {
  const izquierda = lado === 'left';
  const segmento = modelo.getObjectByName('segment_hand_' + (izquierda ? 'L' : 'R'));
  let origen;
  segmento.traverse(o => { if (o.isMesh && o.material.name.toLowerCase().includes('rubber seals')) origen = o.geometry; });
  const { position, normal } = origen.attributes;
  const puntos = Array.from({ length: position.count }, (_, i) => new Vector3().fromBufferAttribute(position, i));
  const claves = puntos.map(p => p.toArray().map(x => Math.round(x * 1e6)).join(','));
  const caras = new Map(), indices = origen.index.array;
  let extremo = 0;
  const eje = izquierda ? 'z' : 'x';
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i], clave = claves[v];
    if (puntos[v][eje] > puntos[extremo][eje]) extremo = v;
    if (!caras.has(clave)) caras.set(clave, []);
    caras.get(clave).push(i - i % 3);
  }
  const isla = new Set(caras.get(claves[extremo]));
  for (const cara of isla) for (let i = cara; i < cara + 3; i++) {
    for (const vecina of caras.get(claves[indices[i]])) isla.add(vecina);
  }
  const pos = [], nor = [], n = new Vector3();
  for (const cara of isla) for (let i = cara; i < cara + 3; i++) {
    pos.push(...puntos[indices[i]].toArray());
    nor.push(...n.fromBufferAttribute(normal, indices[i]).toArray());
  }
  const geo = new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute(pos, 3))
    .setAttribute('normal', new Float32BufferAttribute(nor, 3));
  // Normales de las caras planas del original. Sólo se cambia el marco y
  // la escala uniforme para sentar el puño en la nueva articulación.
  const z = new Vector3(...(izquierda ? [-.61, .57, -.54] : [-.56, .42, -.72])).normalize();
  const x = new Vector3(...(izquierda ? [.08, -.64, -.77] : [.80, .05, -.59]));
  x.addScaledVector(z, -x.dot(z)).normalize();
  geo.applyMatrix4(new Matrix4().makeBasis(x, z.clone().cross(x), z).invert());
  geo.center();
  const ancho = geo.boundingBox.max.x - geo.boundingBox.min.x;
  return geo.scale(1 / ancho, 1 / ancho, 1 / ancho);
}
