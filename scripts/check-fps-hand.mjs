import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Matrix4, Quaternion, Triangle, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { acotar, crearMano, interpolar, limites, obtenerMalla } from '../src/view/fp/hand/index.js';

import { espesorCentral } from '../src/view/fp/hand/seccion.js';
import { montarAntebrazo } from '../src/view/fp/hand/antebrazo.js';
import { soldierMaterial, soldierSurface } from '../src/player/soldier-bake.js';
import smg from '../src/view/fp/profiles/smg.js';
import { comprobarBrazal, comprobarUniones, contactoBlindaje, espejoBlindado, sinCrucesDeBlindaje } from './lib-fps-hand-armor.mjs';

const mm = 1000;
let espejoRobot = 0, apoyoBlindaje = 0, luzMinima = Infinity;
async function leer(lado) {
  const b = await readFile(new URL(`../public/assets/fp/hand/${lado}.glb`, import.meta.url));
  return (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '')).scene;
}
function vertices(malla) {
  return Array.from({ length: malla.geometry.attributes.position.count }, (_, i) =>
    malla.getVertexPosition(i, new Vector3()));
}
async function modelo(mano, escala, inflado = .002) {
  const escena = await leer(mano), original = vertices(obtenerMalla(escena));
  const h = crearMano(escena, { mano, escala, inflado,
    referencia: mano === 'right' ? obtenerMalla(await leer('left')) : undefined });
  h.grupo.updateMatrixWorld(true);
  return { ...h, original };
}

let errorReposo = 0, errorEspejo = 0, errorYemas = 0, penetracion = 0, totalTriangulos = 0;
for (const lado of ['left', 'right']) {
  const h = await modelo(lado, 1, 0);
  h.aplicar(h.poses.abierta());
  const { malla, cadenas, muneca, palmar } = h.rig;
  const vs = vertices(malla);
  assert.equal(malla.skeleton.bones.length, 25);
  errorReposo = Math.max(errorReposo, ...vs.map((v, i) => v.distanceTo(h.original[i]) * mm));
  assert.ok(errorReposo < .1, `Reposo: ${errorReposo} mm`);
  for (const [d, cadena] of Object.entries(cadenas)) {
    assert.equal(cadena.length, d === 'thumb' ? 4 : 5);
    cadena.forEach((hueso, i) => assert.equal(hueso.parent, i ? cadena[i - 1] : muneca));
    if (d === 'thumb') continue;
    h.aplicar({});
    const punta = () => cadena.at(-1).getWorldPosition(new Vector3());
    const pivote = cadena[2].getWorldPosition(new Vector3());
    const centroPalma = h.rig.origen.clone().lerp(cadenas.middle[1].getWorldPosition(new Vector3()), .6);
    const yema = () => {
      const ms = h.piel.grupos[d].yema;
      return ms.reduce((s, m) => s.add(malla.getVertexPosition(m.v, new Vector3())), new Vector3()).divideScalar(ms.length);
    };
    const distanciaInicial = yema().distanceTo(centroPalma);
    const antes = punta().sub(pivote);
    const ejeLateral = antes.clone().cross(palmar).normalize();
    h.aplicar({ [d]: { pip: 90 } });
    const despues = punta().sub(pivote);
    assert.ok(yema().distanceTo(centroPalma) < distanciaInicial, `${d}: la yema debe acercarse a la palma`);
    assert.ok(despues.dot(palmar) > antes.length() * .9, `${d} debe cerrar hacia la palma`);
    assert.ok(Math.abs(despues.clone().sub(antes).dot(ejeLateral)) < .002, `${d} se desvía de lado`);
  }
}
for (const extremo of [-1, 1]) {
  const exagerada = acotar(), esperado = acotar();
  for (const [nombre, ejes] of Object.entries(exagerada)) for (const eje of Object.keys(ejes)) {
    ejes[eje] = extremo * 1000;
    esperado[nombre][eje] = (limites[nombre] ?? limites.dedo)[eje][extremo < 0 ? 0 : 1];
  }
  assert.deepEqual(acotar(exagerada), esperado);
}
assert.throws(() => acotar({ thumb: { ip: NaN } }));

// Clasificar cada cara por la suma de los pesos, también en las membranas.
// Las caras vecinas comparten un borde por construcción en la misma piel.
function carasDeDedos(malla) {
  const { position, skinIndex, skinWeight } = malla.geometry.attributes;
  const ix = malla.geometry.index.array, caras = [];
  for (let i = 0; i < ix.length; i += 3) {
    const ids = Array.from(ix.subarray(i, i + 3)), votos = new Map();
    for (const v of ids) for (let k = 0; k < 4; k++) {
      const nombre = malla.skeleton.bones[skinIndex.getComponent(v, k)].name.split('-')[0];
      votos.set(nombre, (votos.get(nombre) ?? 0) + skinWeight.getComponent(v, k));
    }
    const dedo = [...votos].sort((a, b) => b[1] - a[1])[0][0];
    if (dedo === 'wrist') continue;
    const originales = ids.map(v => new Vector3().fromBufferAttribute(position, v));
    caras.push({ ids, dedo, originales });
  }
  return caras;
}
function atraviesa(t, u) {
  const n = u.getNormal(new Vector3()), lados = [t.a, t.b, t.c];
  for (let i = 0; i < 3; i++) {
    const a = lados[i], b = lados[(i + 1) % 3];
    const da = n.dot(a.clone().sub(u.a)), db = n.dot(b.clone().sub(u.a));
    if (da * db >= 0 || Math.min(Math.abs(da), Math.abs(db)) < 1e-8) continue;
    const corte = a.clone().lerp(b, da / (da - db));
    if (u.containsPoint(corte)) return true;
  }
  return false;
}
function sinCruces(caras, vs, etiqueta) {
  const lista = caras.map(c => {
    const puntos = c.ids.map(i => vs[i]);
    return { ...c, t: new Triangle(...puntos), caja: new Box3().setFromPoints(puntos) };
  }).sort((a, b) => a.caja.min.x - b.caja.min.x);
  for (const [i, a] of lista.entries()) for (let j = i + 1; j < lista.length; j++) {
    const b = lista[j];
    if (b.caja.min.x > a.caja.max.x) break;
    if (a.dedo === b.dedo || !a.caja.intersectsBox(b.caja)) continue;
    if (a.originales.some(p => b.originales.some(q => p.distanceToSquared(q) < 1e-12))) continue;
    assert.ok(!atraviesa(a.t, b.t) && !atraviesa(b.t, a.t),
      `Cruce ${a.dedo}/${b.dedo} en ${etiqueta} (${a.ids}, ${b.ids})`);
  }
}

// Relacionar las pieles por la posición en reposo: cada GLB ordena sus índices
// de forma diferente. Las mediciones posteriores usan el skinning de Three.
function reflejar(v) { return new Vector3(-v.x, v.y, v.z); }
function parejaDeVertices(izq, der) {
  const derecho = vertices(der.rig.malla).map(v => v.sub(der.rig.origen));
  return vertices(izq.rig.malla).map(v => {
    const reflejo = reflejar(v.sub(izq.rig.origen));
    let min = Infinity, id = -1;
    derecho.forEach((q, i) => {
      const d = q.distanceToSquared(reflejo);
      if (d < min) { min = d; id = i; }
    });
    return id;
  });
}

function comprobarContacto(h, vs, d, escala) {
  const c = h.poses.cilindro(d);
  const radial = v => {
    const p = v.clone().sub(c.centro);
    return p.addScaledVector(c.eje, -p.dot(c.eje));
  };
  const dist = vs.map(v => (radial(v).length() - c.radio) * escala * mm);
  const minimo = lista => Math.min(...lista.map(m => dist[m.v]));
  penetracion = Math.max(penetracion, -Math.min(...dist));
  assert.ok(penetracion <= 1, `Penetración de ${penetracion} mm`);
  let pulgar, dedosAlOtroLado = 0;
  for (const [nombre, g] of Object.entries(h.piel.grupos)) {
    const error = Math.abs(minimo(g.yema));
    errorYemas = Math.max(errorYemas, error);
    assert.ok(error <= 1, `Yema de ${nombre}: ${error} mm`);
    if (nombre !== 'thumb') for (const ms of g.falanges.slice(1)) {
      assert.ok(Math.abs(minimo(ms)) <= 1, `Falta apoyo de falange en ${nombre}`);
    }
    // En diámetros pequeños la yema puede continuar más allá de la media
    // vuelta. La falange media identifica por qué lado envuelve cada dedo.
    const zona = nombre === 'thumb' ? g.yema : g.falanges[2];
    const centro = zona.reduce((s, m) => s.add(vs[m.v]), new Vector3()).divideScalar(zona.length);
    const lado = radial(centro).dot(h.rig.largo);
    if (nombre === 'thumb') pulgar = lado;
    else if (lado > 0) dedosAlOtroLado++;
  }
  assert.ok(pulgar < 0 && dedosAlOtroLado === 4, `Oposición en d=${d} ×${escala}: pulgar ${pulgar}, dedos ${dedosAlOtroLado}`);
}

for (const escala of [1, 1.25, 1.5]) {
  const par = await Promise.all(['left', 'right'].map(lado => modelo(lado, escala)));
  const ids = parejaDeVertices(...par);
  const caras = par.map(h => carasDeDedos(h.rig.malla));
  const casos = [
    ['abierta'], ['relajada'], ['empuñadura', false], ['empuñadura', true], ['pinza'],
    ...[.04, .05, .06].map(d => ['puñoCilindro', d]),
  ];
  for (const [nombre, opcion] of casos) {
    const pieles = par.map((h, i) => {
      const pose = h.poses[nombre](opcion);
      assert.deepEqual(pose, acotar(pose));
      h.aplicar(pose);
      h.grupo.updateMatrixWorld(true);
      comprobarUniones(h, nombre);
      sinCrucesDeBlindaje(h, `${nombre} ${opcion ?? ''} ×${escala}`);
      const vs = vertices(h.rig.malla);
      sinCruces(caras[i], vs, `${nombre} ${opcion ?? ''} ×${escala}`);
      if (escala === 1 && i === 0) for (const t of [.25, .5, .75]) {
        h.aplicar(interpolar(h.poses.abierta(), pose, t));
        sinCruces(caras[i], vertices(h.rig.malla), `transición hacia ${nombre} a ${t}`);
      }
      h.aplicar(pose);
      if (nombre === 'pinza') {
        const { index, thumb } = h.piel.grupos;
        const hueco = Math.min(...index.yema.flatMap(a => thumb.yema.map(b => vs[a.v].distanceTo(vs[b.v]))));
        assert.ok(hueco * mm < 5, 'Las yemas deben formar la pinza');
        const extremos = ['index', 'thumb'].map(d => {
          const hueso = h.rig.cadenas[d].at(-2);
          const pieza = h.blindaje.juntas.find(j => j.segmento.parent === hueso).segmento;
          return vertices(pieza).map(p => pieza.localToWorld(p));
        });
        const luz = Math.min(...extremos[0].map(a => Math.min(...extremos[1].map(b => a.distanceTo(b)))));
        assert.ok(luz / escala * mm < 5, 'Las yemas blindadas deben formar la pinza');
      }
      if (nombre === 'puñoCilindro') {
        comprobarContacto(h, vs, opcion, escala);
        const { maximo, minimo } = contactoBlindaje(h, opcion, escala);
        apoyoBlindaje = Math.max(apoyoBlindaje, maximo);
        luzMinima = Math.min(luzMinima, minimo);
      }
      return vs.map(v => v.sub(h.rig.origen));
    });
    espejoRobot = Math.max(espejoRobot, espejoBlindado(...par));
    errorEspejo = Math.max(errorEspejo, ...pieles[0].map((v, i) =>
      reflejar(v).distanceTo(pieles[1][ids[i]]) * escala * mm));
    assert.ok(errorEspejo < .1, `Asimetría en ${nombre}: ${errorEspejo} mm`);
  }
  const h = par[0], a = h.poses.abierta(), b = h.poses.empuñadura(true);
  assert.deepEqual(interpolar(a, b, 0), a);
  assert.deepEqual(interpolar(a, b, 1), b);
  assert.ok(interpolar(a, b, .5).index.pip > 0 && interpolar(a, b, .5).index.pip < b.index.pip);
  assert.ok(h.poses.empuñadura(false).index.pip < b.index.pip);
  for (const mano of par) {
    let tris = 0;
    mano.grupo.traverseVisible(o => { if (o.isMesh) tris += o.geometry.index.count / 3; });
    assert.ok(tris > 0 && tris <= 6000, `Blindaje fuera de presupuesto: ${tris}`);
    totalTriangulos = Math.max(totalTriangulos, tris);
  }
}
// Cambiar el acolchado debe cambiar la piel que consulta el solucionador.
const acolchada = await modelo('left', 1, .004);
acolchada.aplicar(acolchada.poses.puñoCilindro(.05));
const pielGruesa = vertices(acolchada.rig.malla);
comprobarContacto(acolchada, pielGruesa, .05, 1);
sinCruces(carasDeDedos(acolchada.rig.malla), pielGruesa, 'acolchado de 4 mm');
contactoBlindaje(acolchada, .05, 1);

const bytesSoldado = await readFile(new URL('../public/assets/characters/blender/soldier-blender-body.glb', import.meta.url));
const soldado = (await new GLTFLoader().parseAsync(bytesSoldado.buffer.slice(bytesSoldado.byteOffset,
  bytesSoldado.byteOffset + bytesSoldado.byteLength), '')).scene;
// Se mide cada placa del montaje de la SMG en el plano central de su falange.
{
  const escena = await leer('left');
  const h = crearMano(escena, { ...smg.anatomia, diametroMontaje: smg.anatomia.diametro });
  const { rig } = h;
  const brazal = montarAntebrazo(h, soldado, 'left', 'red', 0, smg.supportArm.sleeveScale / smg.supportArm.scale);
  h.grupo.updateMatrixWorld(true);
  const puntos = o => vertices(o).map(p => o.localToWorld(p));
  const piel = brazal.children.flatMap(puntos);
  const fin = Math.max(...piel.map(p => p.dot(rig.largo)));
  const boca = piel.filter(p => p.dot(rig.largo) >= fin - .0006);
  const limites = (ps, eje) => {
    const xs = ps.map(p => p.dot(eje));
    return [Math.min(...xs), Math.max(...xs)];
  };
  const ancho = ps => { const [a,b] = limites(ps, rig.ancho); return b-a; };
  const palma = ancho(puntos(h.blindaje.chasis)) / ancho(boca);
  const collar = puntos(h.blindaje.collar), proporcion = ancho(collar) / ancho(boca);

  assert.ok(proporcion >= 1, `El puño cubre la boca del brazal: ${proporcion}`);
  for (const eje of [rig.ancho, rig.palmar]) {
    const [a,b] = limites(boca, eje), [c,d] = limites(collar, eje);
    assert.ok(Math.abs((a+b-c-d)/2) < .001, 'Collar descentrado');
  }
  comprobarBrazal(brazal, h.blindaje.collar);
  for (const [dedo, cadena] of Object.entries(rig.cadenas)) {
    for (let i = 1; i < cadena.length - 1; i++) {
      const hueso = cadena[i], origen = hueso.getWorldPosition(new Vector3());
      const z = cadena[i+1].getWorldPosition(new Vector3()).sub(origen);
      const longitud = z.length();
      z.normalize();
      const x = z.clone().cross(dedo === 'thumb' ? rig.ancho : rig.palmar).normalize();
      const marco = new Matrix4().makeBasis(x, z.clone().cross(x), z).setPosition(origen).invert();
      const placa = hueso.getObjectByName('Blindaje ' + hueso.name);
      const blindada = espesorCentral(placa.geometry, placa.geometry.attributes.position, marco.multiply(placa.matrixWorld), longitud);
      // Secciones del guante izquierdo del soldado, a la escala del puño montado.
      const esperado = dedo === 'thumb' ? 19.7735 : 17.0195;
      assert.ok(Math.abs(blindada.espesor * mm - esperado) < .01,
        `${hueso.name}: espesor ${blindada.espesor * mm} mm, esperado ${esperado} mm`);
    }
  }
  for (const [nombre, pose] of Object.entries({
    relajada: h.poses.relajada(), abierta: h.poses.abierta(), apoyo: smg.anatomia.apoyo, pinza: h.poses.pinza(),
  })) {
    h.aplicar(pose);
    if (nombre === 'apoyo') rig.cadenas.thumb[0].quaternion.multiply(new Quaternion().fromArray(smg.anatomia.giroPulgar));
    h.grupo.updateMatrixWorld(true);
    comprobarUniones(h, nombre);
    sinCrucesDeBlindaje(h, nombre);
  }
  console.log(`SMG · palma/brazal ${palma.toFixed(3)} · collar/brazal ${proporcion.toFixed(3)}`);
}
for (const lado of ['left', 'right']) for (const equipo of ['red', 'blue']) {
  const region = 'hand_' + (lado === 'left' ? 'L' : 'R');
  const materiales = new Set();
  soldado.getObjectByName('segment_' + region).traverse(o => { if (o.isMesh) materiales.add(o.material.name); });
  for (let variante = 0; variante < 5; variante++) {
    const h = crearMano(await leer(lado), { mano: lado, equipo, variante, blindajeGrueso: true,
      referencia: lado === 'right' ? obtenerMalla(await leer('left')) : undefined });
    const usados = new Set();
    h.grupo.traverseVisible(o => {
      if (!o.isMesh) return;
      const remate = o.name.startsWith('Remate de nudillo') && !(lado === 'right' && o.name.endsWith('index'));
      const zona = o.name === 'Blindaje dorsal' ? 'graphite' : remate ? 'edge gunmetal' : 'rubber seals';
      const nombre = [...materiales].find(m => m.includes(zona));
      assert.equal(o.userData.acabado, nombre, o.name + ': reparto del guante del soldado');
      usados.add(nombre);
      assert.equal(o.material, soldierMaterial(equipo));
      const s = soldierSurface(nombre, region, variante);
      for (const [id, valores] of [['color', s.color.toArray()], ['aSurf', [s.rough, s.metal, s.glow / 8, s.team]]]) {
        const datos = o.geometry.attributes[id].array;
        assert.ok(datos.every((v, i) => v === Math.round(valores[i % valores.length] * 255)), o.name + ': ' + id);
      }
    });
    assert.deepEqual(usados, materiales);
    const brazal = montarAntebrazo(h, soldado, lado, equipo, variante, smg.supportArm.sleeveScale / smg.supportArm.scale);
    h.grupo.updateMatrixWorld(true);
    comprobarBrazal(brazal, h.blindaje.collar);
    const origen = soldado.getObjectByName('segment_forearm_' + (lado === 'left' ? 'L' : 'R'));
    const originales = [];
    origen.traverse(o => { if (o.isMesh) originales.push(o); });
    assert.equal(brazal.children.length, originales.length);
    for (const [i, pieza] of brazal.children.entries()) {
      const original = originales[i], superficie = soldierSurface(original.material.name, origen.name.slice(8), variante);
      assert.deepEqual(pieza.geometry.index.array, original.geometry.index.array);
      assert.equal(pieza.material, soldierMaterial(equipo));
      assert.deepEqual(Array.from(pieza.geometry.attributes.color.array.slice(0, 3)),
        superficie.color.toArray().map(v => Math.round(v * 255)));
    }
    brazal.removeFromParent();
  }
}
console.log(`Mano OK · ${totalTriangulos} triángulos · máximos en mm: reposo ${errorReposo.toFixed(5)}, espejo ${errorEspejo.toFixed(3)}, yema ${errorYemas.toFixed(3)}, penetración ${penetracion.toFixed(3)} · blindaje: espejo ${espejoRobot.toFixed(4)}, luz mínima ${luzMinima.toFixed(3)}, apoyo máximo ${apoyoBlindaje.toFixed(3)} · juntas encajadas`);
