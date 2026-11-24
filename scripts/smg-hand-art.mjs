// Hornea el esqueleto anatómico y las rotaciones resueltas. En juego sólo
// se interpolan las articulaciones; cada placa conserva un único hueso.
import { readFile } from 'node:fs/promises';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { crearMano, obtenerMalla } from '../src/view/fp/hand/index.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { punoDelSoldado } from './soldier-limbs.mjs';
import { moldePuno } from '../src/view/fp/hand/puno.js';
import { contactos } from '../src/view/fp/profiles/contactos.js';
import smg from '../src/view/fp/profiles/smg.js';

async function leer(lado) {
  const bytes = await readFile(new URL('../public/assets/fp/hand/' + lado + '.glb', import.meta.url));
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
}

export async function manosRobot(materiales) {
  const bytes = await readFile(new URL('../public/assets/characters/blender/soldier-blender-body.glb', import.meta.url));
  const soldado = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
  const nodos = [], punos = {};
  for (const lado of ['L', 'R']) {
    const izquierda = lado === 'L';
    const mano = izquierda ? 'left' : 'right';
    punos[mano] = mergeVertices(punoDelSoldado(soldado, mano), 1e-7).toJSON().data;
    const diametro = smg.anatomia.diametro;
    const montaje = izquierda ? { ...smg.anatomia, diametroMontaje: diametro } : { blindajeGrueso: true };
    const h = crearMano(await leer(izquierda ? 'left' : 'right'), {
      ...montaje, puno: moldePuno(mano, punos[mano]), mano,
      referencia: izquierda ? undefined : obtenerMalla(await leer('left')),
    });
    const { rig, poses } = h;
    const cilindro = izquierda && poses.cilindro(diametro);
    // La izquierda libre de las granadas descansa con las falanges relajadas.
    const posturas = izquierda ? { apoyo: poses.relajada(), pinza: poses.pinza(), abierta: poses.abierta() }
      : { apoyo: poses.empuñadura(false), disparo: poses.empuñadura(true), abierta: poses.abierta(), pinza: poses.pinza(), cilindro: poses.puñoCilindro(.055) };
    const metacarpos = {};
    // Las poses del perfil contienen grados de las bisagras anatómicas.
    for (const [arma, c] of Object.entries(contactos)) {
      const tareas = izquierda ? [['apoyo', c.apoyo], ['apoyoADS', c.apoyoADS], ['pinza', c.carga ?? c.anilla]]
        : [['apoyo', c.dominante], ['disparo', c.disparo], ['cerrojo', c.cerrojo]];
      for (const [nombre, ajuste] of tareas) {
        if (!ajuste) continue;
        const pose = structuredClone(nombre === 'disparo' ? posturas[arma + '_apoyo']
          : nombre.startsWith('apoyo') ? posturas.apoyo : posturas.pinza);
        for (const dedo of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
          if (!ajuste[dedo]) continue;
          const ejes = dedo === 'thumb' ? ['cmcFlex', 'cmcAbd', 'mcp', 'ip'] : ['mcp', 'pip', 'dip', 'abd'];
          pose[dedo] = Object.fromEntries(ejes.map((eje, j) => [eje, ajuste[dedo][j]]));
        }
        const id = arma + '_' + nombre;
        posturas[id] = pose;
        metacarpos[id] = nombre === 'disparo' ? { ...c.dominante, ...ajuste } : ajuste;
      }
    }
    // Al desabrochar el agarre se estiran las bisagras distales antes de
    // girar la muñeca. Los metacarpos siguen la misma cara del objeto.
    for (const arma of Object.keys(contactos)) {
      const base = posturas[arma + '_apoyo'];
      if (!izquierda || !base) continue;
      const retiro = structuredClone(base);
      for (const dedo of ['index','middle','ring','pinky']) {
        retiro[dedo].pip *= .18;
        retiro[dedo].dip *= .18;
      }
      posturas[arma + '_retiro'] = retiro;
      metacarpos[arma + '_retiro'] = contactos[arma].apoyo;
    }
    // El espacio de la muñeca tiene -Z hacia los nudillos y +Y hacia el dorso.
    h.grupo.scale.setScalar(1);
    const z = rig.largo.clone().negate(), y = rig.palmar.clone().negate();
    const marco = new Matrix4().makeBasis(y.clone().cross(z), y, z).setPosition(rig.origen).invert();
    const punto = v => v.clone().applyMatrix4(marco).toArray();
    const huesos = [];
    rig.muneca.traverse(b => { if (b.isBone) huesos.push(b); });
    const prims = [];
    let primitivaPuno;
    const indice = nombre => materiales.findIndex(m => m.name === nombre);
    h.grupo.updateMatrixWorld(true);
    h.grupo.traverseVisible(o => {
      if (!o.isMesh) return;
      const geometria = o.geometry.clone().applyMatrix4(marco.clone().multiply(o.matrixWorld));
      const { position, normal } = geometria.attributes;
      const g = { P: position.array, N: normal.array, I: geometria.index.array, W: new Float32Array(position.count),
        joints: new Uint8Array(position.count * 4), weights: new Float32Array(position.count * 4) };
      const hueso = huesos.indexOf(o.parent), material = indice(o.userData.acabado);
      if (hueso < 0 || material < 0) throw new Error('Pieza de mano sin hueso o acabado: ' + o.name);
      for (let i = 0; i < position.count; i++) {
        g.joints[4 * i] = hueso;
        g.weights[4 * i] = 1;
      }
      if (o === h.blindaje.collar) primitivaPuno = prims.length;
      prims.push({ material, g });
    });
    const bones = huesos.map(b => {
      const base = marco.clone().multiply(b.matrixWorld);
      const local = b === rig.muneca ? base : b.matrix;
      return { name: b.name, parent: huesos.indexOf(b.parent), pos: new Vector3().setFromMatrixPosition(local).toArray(),
        inv: base.clone().invert().toArray(), rot: new Quaternion().setFromRotationMatrix(local).toArray() };
    });
    const palmCenter = punto(rig.origen.clone().lerp(rig.cadenas.middle[1].getWorldPosition(new Vector3()), .5));
    // Anchos reales en el marco anatómico, antes de animar los dedos.
    function ancho(pieza) {
      const vertices = pieza.geometry.attributes.position;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < vertices.count; i++) {
        const x = pieza.localToWorld(new Vector3().fromBufferAttribute(vertices, i)).dot(rig.ancho);
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
      return max - min;
    }
    const anchos = { palma: ancho(h.blindaje.chasis), collar: ancho(h.blindaje.collar) };
    const rotations = {};
    let centro;
    const bases = new Map(Object.values(rig.cadenas).map(([b]) => [b, b.quaternion.clone()]));
    for (const [nombre, pose] of Object.entries(posturas)) {
      for (const [b, reposo] of bases) b.quaternion.copy(reposo);
      h.aplicar(pose);
      if (izquierda && (nombre.endsWith('_apoyo') || nombre.endsWith('_apoyoADS') || nombre.endsWith('_retiro'))) {
        // La rótula basal orienta el pulgar a lo largo de la costilla cercana.
        rig.cadenas.thumb[0].quaternion.multiply(new Quaternion().fromArray(smg.anatomia.giroPulgar));
      }
      for (const [dedo, angulos] of Object.entries(metacarpos[nombre] ?? {})) {
        if (angulos.length === 7) rig.cadenas[dedo][0].quaternion.multiply(
          new Quaternion().setFromEuler(new Euler(...angulos.slice(4))));
      }
      if (nombre === 'smg_retiro') {
        for (const [dedo, giro] of Object.entries(smg.anatomia.giroRetiro)) {
          rig.cadenas[dedo][0].quaternion.multiply(new Quaternion().setFromEuler(new Euler(...giro)));
        }
      }
      rotations[nombre] = huesos.map((b,i) => i ? b.quaternion.toArray() : bones[0].rot);
      if (nombre === 'disparo') {
        const yema = h.piel.grupos.index.yema;
        const suma = new Vector3();
        for (const m of yema) suma.add(rig.malla.getVertexPosition(m.v, new Vector3()));
        centro = punto(suma.divideScalar(yema.length));
      }
    }
    const grip = { wrist: [0,0,0], center: izquierda ? punto(cilindro.centro) : centro,
      axis: rig.lateral.clone().transformDirection(marco).toArray(), palm: [0,-1,0] };
    nodos.push({ name: 'anatomica_' + lado, prims, extras: { bones, rotations, grip, palmCenter, anchos, primitivaPuno } });
  }
  return { nodos, punos };
}
