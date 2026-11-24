import { MathUtils, Quaternion, Vector3 } from 'three';

export const dedos = ['index', 'middle', 'ring', 'pinky'];
export const limites = {
  dedo: { mcp: [0, 90], pip: [0, 110], dip: [0, 80], abd: [-15, 15] },
  thumb: { cmcFlex: [-25, 65], cmcAbd: [-20, 85], mcp: [0, 65], ip: [0, 85] },
  wrist: { flex: [-65, 75], abd: [-25, 30], giro: [-80, 80] },
};

export function acotar(pose = {}) {
  const salida = {};
  for (const nombre of [...dedos, 'thumb', 'wrist']) {
    salida[nombre] = {};
    for (const [eje, [min, max]] of Object.entries(limites[nombre] ?? limites.dedo)) {
      const valor = pose[nombre]?.[eje] ?? 0;
      if (!Number.isFinite(valor)) throw new TypeError(`Ángulo inválido en ${nombre}.${eje}`);
      salida[nombre][eje] = MathUtils.clamp(valor, min, max);
    }
  }
  return salida;
}

export function interpolar(desde, hasta, t) {
  const a = acotar(desde), b = acotar(hasta);
  const s = MathUtils.smootherstep(t, 0, 1);
  for (const nombre in a) for (const eje in a[nombre]) {
    a[nombre][eje] = MathUtils.lerp(a[nombre][eje], b[nombre][eje], s);
  }
  return a;
}

const punto = hueso => hueso.getWorldPosition(new Vector3());
const direccion = (a, b) => new Vector3().subVectors(b, a).normalize();
const normal = (a, b) => new Vector3().crossVectors(a, b).normalize();

export function reconstruir(malla, lado, referencia) {
  const { skeleton } = malla;
  const huesos = Object.fromEntries(skeleton.bones.map(h => [h.name, h]));
  const muneca = huesos.wrist;
  const origen = punto(muneca);
  // Las dos pieles son espejos exactos; el GLB derecho desplaza algunos pivotes.
  // Igualamos los centros, conservando la orientación de enlace de cada archivo.
  if (lado === 'right') {
    const ref = referencia.skeleton;
    const centro = punto(ref.getBoneByName('wrist'));
    for (const h of skeleton.bones) {
      const p = punto(ref.getBoneByName(h.name)).sub(centro);
      p.x *= -1;
      h.position.copy(h.parent.worldToLocal(p.add(origen)));
      h.updateWorldMatrix(false, false);
    }
    skeleton.calculateInverses();
  }

  const cadenas = {};
  for (const dedo of ['thumb', ...dedos]) {
    const prefijo = dedo === 'thumb' ? dedo : dedo + '-finger';
    const partes = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
    cadenas[dedo] = partes.filter(p => dedo !== 'thumb' || p !== 'phalanx-intermediate')
      .map(p => huesos[prefijo + '-' + p]);
    let padre = muneca;
    for (const h of cadenas[dedo]) {
      // attach calcula la local de reposo como inversa(padreMundo) × hijoMundo.
      padre.attach(h);
      padre = h;
    }
  }
  const signo = lado === 'left' ? 1 : -1;
  const nudillo = d => punto(cadenas[d][1]);
  const largo = direccion(origen, nudillo('middle'));
  const lateral = direccion(nudillo('index'), nudillo('pinky'));
  const palmar = normal(lateral, largo).multiplyScalar(signo);
  const ancho = normal(largo, palmar).multiplyScalar(signo);
  const reposo = new Map(skeleton.bones.map(h => [h, h.quaternion.clone()]));
  const ejes = {};
  function eje(h, vector) {
    return vector.clone().applyQuaternion(h.getWorldQuaternion(new Quaternion()).invert());
  }
  const registro = (h, nombre, angulo, vector) => {
    (ejes[nombre] ??= []).push({ h, angulo, local: eje(h, vector) });
  };
  registro(muneca, 'wrist', 'giro', largo.clone().multiplyScalar(signo));
  registro(muneca, 'wrist', 'abd', palmar.clone().multiplyScalar(signo));
  registro(muneca, 'wrist', 'flex', normal(largo, palmar));
  for (const d of dedos) {
    const cadena = cadenas[d];
    registro(cadena[1], d, 'abd', palmar.clone().multiplyScalar(signo));
    ['mcp', 'pip', 'dip'].forEach((a, i) => {
      const segmento = direccion(punto(cadena[i + 1]), punto(cadena[i + 2]));
      registro(cadena[i + 1], d, a, normal(segmento, palmar));
    });
  }
  const pulgar = cadenas.thumb;
  // La oposición levanta el primer metacarpiano hacia la cara palmar.
  // La flexión del pulgar barre el hueco entre éste y los cuatro dedos.
  registro(pulgar[0], 'thumb', 'cmcAbd', normal(direccion(punto(pulgar[0]), punto(pulgar[1])), palmar));
  for (const [i, a] of ['cmcFlex', 'mcp', 'ip'].entries()) {
    const segmento = direccion(punto(pulgar[i]), punto(pulgar[i + 1]));
    registro(pulgar[i], 'thumb', a, normal(segmento, ancho));
  }
  const q = new Quaternion();
  function aplicarParte(nombre, angulos) {
    for (const { h } of ejes[nombre]) h.quaternion.copy(reposo.get(h));
    for (const { h, angulo, local } of ejes[nombre]) {
      h.quaternion.multiply(q.setFromAxisAngle(local, MathUtils.degToRad(angulos[angulo])));
    }
    (nombre === 'wrist' ? muneca : cadenas[nombre][0]).updateWorldMatrix(true, true);
  }
  function aplicar(pose) {
    const angulos = acotar(pose);
    for (const nombre of ['wrist', 'thumb', ...dedos]) aplicarParte(nombre, angulos[nombre]);
    skeleton.update();
    return angulos;
  }
  return { malla, muneca, cadenas, origen, largo, lateral, palmar, ancho, aplicar, aplicarParte };
}

// Puntos de la envolvente por falange. Las puntas WebXR son centros internos
// sin pesos de piel: la yema es la porción terminal real de la falange distal.
export function muestras(rig) {
  const { malla, cadenas } = rig;
  const { position, skinIndex, skinWeight } = malla.geometry.attributes;
  const grupos = {}, porHueso = new Map();
  for (const [d, cadena] of Object.entries(cadenas)) {
    grupos[d] = { falanges: [], yema: [], todos: [] };
    cadena.slice(0, -1).forEach((h, i) => {
      grupos[d].falanges.push([]);
      porHueso.set(h, { d, i, inicio: punto(h), fin: punto(cadena[i + 1]) });
    });
  }
  const vertices = [];
  for (let v = 0; v < position.count; v++) {
    let dominante, maximo = 0;
    const enlaces = [];
    const p = new Vector3().fromBufferAttribute(position, v).applyMatrix4(malla.bindMatrix);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (!w) continue;
      const j = skinIndex.getComponent(v, k);
      if (w > maximo) { dominante = malla.skeleton.bones[j]; maximo = w; }
      enlaces.push({ h: malla.skeleton.bones[j], local: p.clone().applyMatrix4(malla.skeleton.boneInverses[j]), w });
    }
    const muestra = { v, enlaces };
    vertices.push(muestra);
    const parte = porHueso.get(dominante);
    if (!parte) continue;
    const { d, i, inicio, fin } = parte;
    const g = grupos[d];
    g.todos.push(muestra);
    g.falanges[i].push(muestra);
    if (i !== g.falanges.length - 1) continue;
    const delta = fin.clone().sub(inicio);
    if (p.clone().sub(inicio).dot(delta) >= delta.lengthSq() * 0.8) g.yema.push(muestra);
  }
  return { grupos, vertices };
}

const temporal = new Vector3();
export function situar(muestra, destino) {
  destino.set(0, 0, 0);
  for (const { h, local, w } of muestra.enlaces) {
    destino.addScaledVector(temporal.copy(local).applyMatrix4(h.matrixWorld), w);
  }
  return destino;
}
