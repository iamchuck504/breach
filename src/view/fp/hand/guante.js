import { BufferAttribute, BufferGeometry, Matrix4, Mesh, Vector3 } from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { soldierMaterial, soldierSurface } from '../../../player/soldier-bake.js';
import { cbox, ccyl } from '../kit/geometry.js';
import { espesorCentral } from './seccion.js';

const punto = h => h.getWorldPosition(new Vector3());
const marco = (x, z, origen) => new Matrix4().makeBasis(x, z.clone().cross(x), z).setPosition(origen);

export function pintar(geo, nombre, equipo, variante, zona) {
  const s = soldierSurface(nombre, zona, variante);
  const cantidad = geo.attributes.position.count;
  for (const [clave, valores] of [
    ['color', s.color.toArray()], ['aSurf', [s.rough, s.metal, s.glow / 8, s.team]],
    ['aDetail', [s.kind / 255, .38]],
  ]) {
    const bytes = Uint8Array.from(valores, n => Math.round(n * 255));
    const datos = new Uint8Array(cantidad * bytes.length);
    for (let i = 0; i < datos.length; i += bytes.length) datos.set(bytes, i);
    geo.setAttribute(clave, new BufferAttribute(datos, bytes.length, true));
  }
  return soldierMaterial(equipo);
}

// Conformar las caras interiores sobre calibres en el espacio de cada hueso.
// Cada plano es tangente al cilindro en el apoyo anatómico de esa falange.
// Los calibres sólo intervienen al fabricar la pieza rígida en reposo.
function calibres(rig, piel, poses, diametros) {
  const porHueso = new Map();
  const reposo = new Map(rig.malla.skeleton.bones.map(h => [h, h.matrixWorld.clone()]));
  for (const d of diametros) {
    let c;
    try { c = poses.cilindro(d); }
    catch (e) {
      // Una envolvente personalizada puede no admitir todo el juego de calibres.
      if (e instanceof RangeError) continue;
      throw e;
    }
    rig.aplicar(poses.puñoCilindro(d));
    for (const [dedo, cadena] of Object.entries(rig.cadenas)) {
      const grupo = piel.grupos[dedo];
      for (let i = dedo === 'thumb' ? 0 : 1; i < cadena.length - 1; i++) {
        const h = cadena[i], ms = i === cadena.length - 2 ? grupo.yema : grupo.falanges[i];
        let menor = Infinity, apoyo, normal;
        for (const m of ms) {
          const p = rig.malla.getVertexPosition(m.v, new Vector3());
          const radial = p.clone().sub(c.centro);
          radial.addScaledVector(c.eje, -radial.dot(c.eje));
          if (radial.lengthSq() < menor) {
            menor = radial.lengthSq(); apoyo = p; normal = radial;
          }
        }
        normal.normalize();
        // Una décima de milímetro de luz deja sitio a la discretización.
        apoyo.addScaledVector(normal, c.radio + .00012 - Math.sqrt(menor));
        const volver = reposo.get(h).clone().multiply(h.matrixWorld.clone().invert());
        const centro = c.centro.clone().applyMatrix4(volver), eje = c.eje.clone().transformDirection(volver);
        if (!porHueso.has(h)) porHueso.set(h, []);
        porHueso.get(h).push({ centro, eje, radio: c.radio, apoyo: apoyo.applyMatrix4(volver) });
      }
    }
  }
  rig.aplicar({});
  return porHueso;
}

// La proyección de una cara sobre el plano transversal es un triángulo.
// Su arista más cercana al eje da el plano de corte mínimo del blindaje.
function conformar(nube, calibres) {
  let casco = new ConvexGeometry(nube);
  for (const { centro, eje, radio } of calibres) {
    const pos = casco.attributes.position;
    const radial = new Vector3(), proximo = new Vector3(), arista = new Vector3();
    let menor = Infinity;
    for (let i = 0; i < pos.count; i += 3) {
      const vs = [0, 1, 2].map(k => {
        const p = new Vector3().fromBufferAttribute(pos, i + k).sub(centro);
        return p.addScaledVector(eje, -p.dot(eje));
      });
      for (let k = 0; k < 3; k++) {
        const a = vs[k];
        arista.subVectors(vs[(k + 1) % 3], a);
        const t = Math.max(0, Math.min(1, -a.dot(arista) / (arista.lengthSq() || 1)));
        radial.copy(a).addScaledVector(arista, t);
        if (radial.lengthSq() < menor) { menor = radial.lengthSq(); proximo.copy(radial); }
      }
    }
    if (Math.sqrt(menor) >= radio + .000025) continue;
    proximo.normalize();
    const umbral = centro.dot(proximo) + radio + .000025;
    for (const p of nube) p.addScaledVector(proximo, Math.max(0, umbral - p.dot(proximo)));
    casco.dispose();
    casco = new ConvexGeometry(nube);
  }
  return casco;
}

// Fresar la cara interior conserva el perfil exterior de cada pieza convexa.
// Las intersecciones con las aristas forman la nueva superficie plana de apoyo.
function mecanizarApoyo(geometria, plano) {
  if (!plano) return geometria;
  const normal = new Vector3().fromArray(plano), posicion = geometria.attributes.position;
  const vertices = Array.from({ length: posicion.count }, (_, i) => new Vector3().fromBufferAttribute(posicion, i));
  const distancias = vertices.map(v => normal.dot(v) + plano[3]);
  if (distancias.every(d => d <= 0)) return geometria;
  const caras = [], normales = [], borde = new Map();
  const originales = geometria.attributes.normal;
  function emitir(a, b, c) {
    for (const v of [a, b, c]) {
      caras.push(...v.p.toArray());
      normales.push(...v.n.toArray());
    }
  }
  const indices = geometria.index;
  for (let i = 0; i < (indices?.count ?? posicion.count); i += 3) {
    const cara = [0, 1, 2].map(j => indices ? indices.getX(i + j) : i + j);
    const poligono = [];
    for (let j = 0; j < 3; j++) {
      const a = cara[j], b = cara[(j + 1) % 3];
      const n = new Vector3().fromBufferAttribute(originales, a);
      if (distancias[a] <= 0) poligono.push({ p: vertices[a], n });
      if ((distancias[a] > 0) === (distancias[b] > 0)) continue;
      const t = distancias[a] / (distancias[a] - distancias[b]);
      const p = vertices[a].clone().lerp(vertices[b], t);
      poligono.push({ p, n: n.clone().lerp(new Vector3().fromBufferAttribute(originales, b), t).normalize() });
      borde.set(p.toArray().map(x => Math.round(x * 1e7)).join(','), p);
    }
    for (let j = 2; j < poligono.length; j++) emitir(poligono[0], poligono[j - 1], poligono[j]);
  }
  const puntos = [...borde.values()];
  if (puntos.length < 3) throw new Error('Plano sin cara de apoyo en el pulgar');
  const centro = puntos.reduce((s, p) => s.add(p), new Vector3()).divideScalar(puntos.length);
  const x = puntos[0].clone().sub(centro).normalize(), y = normal.clone().cross(x);
  const tapa = puntos.map(p => {
    const radio = p.clone().sub(centro);
    return { p, n: normal, angulo: Math.atan2(radio.dot(y), radio.dot(x)) };
  }).sort((a, b) => a.angulo - b.angulo);
  for (let i = 0; i < tapa.length; i++) emitir({ p: centro, n: normal }, tapa[i], tapa[(i + 1) % tapa.length]);
  geometria.dispose();
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(new Float32Array(caras), 3))
    .setAttribute('normal', new BufferAttribute(new Float32Array(normales), 3));
}

// Los vértices centrales de la cara de apoyo siguen casi enteramente un solo
// hueso. Al rigidizarlos en flexión conservamos la superficie de contacto.
export function vestir(rig, piel, equipo, variante, poses, destino, espejo, diametroMontaje, grueso, carasApoyo, sillaPulgar, puno) {
  const { malla, cadenas, muneca, origen, largo, palmar, ancho } = rig;
  const goma = 'B04 | rubber seals.002', dorso = 'B04 | graphite.002', remate = 'B04 | edge gunmetal.002';
  const juntas = [];
  const moldes = calibres(rig, piel, poses, diametroMontaje ? [diametroMontaje] : [.04, .045, .05, .055, .06]);
  const traslado = new Matrix4().makeTranslation(...destino.origen.toArray())
    .multiply(new Matrix4().makeScale(espejo ? -1 : 1, 1, 1))
    .multiply(new Matrix4().makeTranslation(...origen.clone().negate().toArray()));
  function pieza(nombre, hueso, geo, acabado) {
    hueso = destino.malla.skeleton.getBoneByName(hueso.name);
    geo.applyMatrix4(hueso.matrixWorld.clone().invert().multiply(traslado));
    const g = mergeVertices(mecanizarApoyo(geo, carasApoyo?.[hueso.name]), 1e-7);
    if (espejo) {
      const indices = g.index.array;
      for (let i = 0; i < indices.length; i += 3) [indices[i], indices[i + 1]] = [indices[i + 1], indices[i]];
    }
    const o = new Mesh(g, pintar(g, acabado, equipo, variante, espejo ? 'hand_R' : 'hand_L'));
    o.name = nombre;
    o.userData.acabado = acabado;
    hueso.add(o);
    return o;
  }
  function cilindro(nombre, hueso, centro, eje, radio, alto, acabado, lados = 12) {
    const g = ccyl(radio, alto, lados, Math.min(radio, alto) * .13);
    // El cilindro del kit se extruye en Z.
    const guia = Math.abs(eje.dot(palmar)) < .95 ? palmar : largo;
    const x = guia.clone().addScaledVector(eje, -guia.dot(eje)).normalize();
    g.applyMatrix4(marco(x, eje, new Vector3()));
    return pieza(nombre, hueso, g.translate(...centro.toArray()), acabado);
  }
  const palma = (x, y, z) => origen.clone().addScaledVector(ancho, x)
    .addScaledVector(palmar, y).addScaledVector(largo, z);
  // El contorno sigue el arco de los cuatro nudillos y el asiento del pulgar.
  const nudillo = d => {
    const p = punto(cadenas[d][1]).sub(origen);
    return [p.dot(ancho), p.dot(largo)];
  };
  const [ix, iz] = nudillo('index'), [mx, mz] = nudillo('middle');
  const [ax, az] = nudillo('ring'), [px, pz] = nudillo('pinky');
  const basePulgar = punto(cadenas.thumb[0]).sub(origen);
  const contorno = [[-.025, -.003], [.023, -.003], [px + .009, pz - .012], [px + .005, pz + .002],
    [ax, az + .001], [mx, mz + .001], [ix - .001, iz + .003], [ix - .011, iz - .013],
    [basePulgar.dot(ancho) - .011, basePulgar.dot(largo) + .007]];
  function placa(nombre, perfil, capas, acabado) {
    const nube = capas.flatMap(([factor, y]) => perfil.map(([x, z]) =>
      palma(x * factor, y, .047 + (z - .047) * factor)));
    return pieza(nombre, muneca, new ConvexGeometry(nube), acabado);
  }
  const chasis = placa('Chasis palmar', contorno, [[.89, -.009], [1, -.004], [1, .009], [.91, .015]], goma);
  placa('Blindaje dorsal', contorno, [[.69, -.016], [.86, -.011], [1.015, -.005], [1.015, .003], [.99, .005]], dorso);
  // Los tacos interiores refuerzan la palma bajo las cabezas metacarpianas.
  for (const d of ['index', 'middle', 'ring', 'pinky']) {
    const [x, z] = nudillo(d);
    const asiento = marco(largo.clone().cross(palmar).normalize(), largo, palma(x * .82, grueso ? .016 : .014, z - .020));
    pieza('Placa palmar ' + d, muneca, cbox(.016, grueso ? .011 : .007, .023, .0025, true).applyMatrix4(asiento), goma);
  }
  const radioCollar = grueso ? .033 : .029;
  let asientoPulgar = chasis;
  if (sillaPulgar) {
    // El resalte tenar enlaza la rótula con la palma al adelantar el pulgar.
    const cx = basePulgar.dot(ancho) + sillaPulgar[2], cz = basePulgar.dot(largo) + sillaPulgar[0];
    const cima = basePulgar.dot(palmar) + sillaPulgar[1];
    const perfil = [[-.012, -.011], [-.008, -.019], [.008, -.019], [.014, -.009],
      [.014, .010], [.006, .018], [-.009, .016], [-.013, .006]];
    const nube = [[1, .006], [1, .014], [.72, cima]].flatMap(([k, y]) =>
      perfil.map(([x, z]) => palma(cx + x*k, y, cz + z*k)));
    asientoPulgar = pieza('Asiento del pulgar', muneca, new ConvexGeometry(nube), goma);
  }
  const anchoPuno = radioCollar * (espejo ? 1.60 : 2);
  const centroPuno = palma(0, .001, .003 - puno.boundingBox.max.z * anchoPuno);
  const geoPuno = puno.clone().scale(anchoPuno, anchoPuno, anchoPuno);
  const collar = pieza('Collar de muñeca', muneca, geoPuno.applyMatrix4(marco(ancho, largo, centroPuno)), goma);
  // Se guardan las posiciones en el espacio de cada falange; el blindaje
  // terminado se mueve como un sólido incluso en las transiciones.
  const reposo = new Map(malla.skeleton.bones.map(h => [h, h.matrixWorld.clone()]));
  rig.aplicar(Object.fromEntries(Object.keys(cadenas).map(d => [d, d === 'thumb'
    ? { cmcAbd: 35, cmcFlex: -8, mcp: 48, ip: 66 } : { mcp: 45, pip: 32, dip: 54 }])));
  const apoyos = {};
  for (const [d, cadena] of Object.entries(cadenas)) {
    apoyos[d] = piel.grupos[d].falanges.map((ms, i) => {
      const h = cadena[i], volver = reposo.get(h).clone().multiply(h.matrixWorld.clone().invert());
      return ms.map(m => malla.getVertexPosition(m.v, new Vector3()).applyMatrix4(volver));
    });
  }
  rig.aplicar({});
  for (const [d, cadena] of Object.entries(cadenas)) {
    const pulgar = d === 'thumb';
    // Secciones de goma medidas entre las caras planas del GLB del soldado.
    // El puño original fija la correspondencia de escala con la mano articulada.
    const escalaMolde = anchoPuno / (espejo ? .0671515 : .1198272);
    const espesor = escalaMolde * (espejo ? (pulgar ? .0289 : d === 'index' ? .0229 : .0269)
      : (pulgar ? .0359 : .0309));
    const anchoMolde = espesor + escalaMolde * (pulgar ? (espejo ? .001 : .003) : espejo ? 0 : .001);
    let anterior = pulgar ? asientoPulgar : chasis;
    for (let i = pulgar ? 0 : 1; i < cadena.length - 1; i++) {
      const h = cadena[i], inicio = punto(h), delta = punto(cadena[i + 1]).sub(inicio);
      const longitud = delta.length(), z = delta.normalize();
      const x = z.clone().cross(pulgar ? ancho : palmar).normalize();
      const base = marco(x, z, inicio), inversa = base.clone().invert();
      const apoyo = apoyos[d][i].map(p => p.applyMatrix4(inversa));
      const distal = i === cadena.length - 2, metacarpo = pulgar && i === 0;
      const banda = apoyo.filter(p => p.z > longitud * .24 && p.z < longitud * (distal ? 1.45 : .86));
      const diametro = Math.max(...banda.map(p => p.x)) - Math.min(...banda.map(p => p.x));
      const anchura = grueso ? anchoMolde : metacarpo ? .023 : diametro * 1.12;
      const radio = grueso && pulgar ? Math.min(anchura * .48, longitud * .48) : Math.min(anchura * .40, longitud * .38);
      // En los nudillos vecinos la holgura lateral la impone el esqueleto.
      // La carcasa conserva su espesor dorsal al estrechar el encaje.
      const vecinos = Object.entries(cadenas).filter(([nombre]) => nombre !== 'thumb' && nombre !== d);
      const paso = pulgar ? Infinity : Math.min(...vecinos.map(([, vecino]) =>
        Math.abs(punto(vecino[i]).sub(inicio).dot(x))));
      const anchoEje = Math.min(anchura * (pulgar && !grueso ? .83 : .95), paso * .84);
      // La solapa cierra el dorso de la bisagra. Sus extremos facetados
      // entran en las dos placas contiguas al flexionar el dedo.
      const cantos = [];
      for (const u of [-.50, -.43, .43, .50]) {
        const bisel = Math.abs(u) === .50 ? .87 : 1;
        for (let j = 0; j < 12; j++) {
          if (pulgar && (j === 2 || j === 5 || j === 8 || j === 11)) continue;
          const angulo = j * Math.PI / 6;
          cantos.push(new Vector3(u * anchoEje, Math.cos(angulo) * radio * bisel,
            Math.sin(angulo) * radio * bisel).applyMatrix4(base));
        }
      }
      const junta = metacarpo ? cilindro('Asiento carpal ' + h.name, h, inicio, x, radio, anchoEje, goma)
        : pieza('Nudillera ' + h.name, h, new ConvexGeometry(cantos), goma);
      if (!pulgar && i === 2) {
        // Remate dorsal del nudillo. El índice de disparo lleva sólo goma.
        const tapa = cbox(anchoEje * .72, radio * .32, radio * .97, radio * .12, true)
          .translate(0, radio * .90, 0).applyMatrix4(base);
        pieza('Remate de nudillo ' + d, h, tapa, espejo && d === 'index' ? goma : remate);
      }
      if (pulgar) {
        // El lateral conserva la envolvente de apoyo del pulgar articulado.
        const escama = [];
        const perfil = [[-.55, -.73], [.45, -.73], [.67, -.39], [.62, .21],
          [.39, .76], [-.31, .87], [-.66, .48], [-.74, -.34]];
        for (const [u, factor] of [[-.39, 1], [-.48, 1], [-.54, .89]]) {
          for (const [y, t] of perfil) {
            const z = t * (t < 0 ? radio : longitud * (distal ? .74 : .96));
            escama.push(new Vector3(u * anchoEje, y * radio * factor, z * factor).applyMatrix4(base));
          }
        }
        pieza('Almohadilla lateral ' + h.name, h, conformar(escama, moldes.get(h) ?? []), goma);
      }
      const fin = distal ? longitud * .82 : longitud - radio * .36;
      const principio = radio * .42;
      const altura = grueso ? espesor : metacarpo ? .024 : anchura * (pulgar && distal ? .66 : .80);
      const frente = grueso && pulgar ? 1 : (distal ? .84 : .94);
      const caja = cbox(anchura * frente, altura, fin - principio, Math.min(anchura * .16, .0035), true);
      const centro = (fin + principio) / 2;
      caja.translate(pulgar && !metacarpo ? -anchura * (distal ? .05 : .16) : 0, pulgar ? 0 : altura * .10, centro);
      const pos = caja.attributes.position;
      const nube = Array.from({ length: pos.count }, (_, j) => new Vector3().fromBufferAttribute(pos, j));
      if (!metacarpo) {
        for (const p of apoyo) {
          if (p.z < (distal ? principio : longitud * .32) || (!distal && p.z > longitud * .94)) continue;
          if (pulgar || distal && p.z > longitud || p.y < -altura * .25) nube.push(p);
        }
      }
      for (const p of nube) {
        p.x = Math.max(-paso * .432, Math.min(paso * .432, p.x));
        p.applyMatrix4(base);
      }
      const limites = moldes.get(h) ?? [];
      if (!pulgar || distal) {
        for (const { apoyo, eje } of limites) {
          for (const lado of [-1, 1]) nube.push(apoyo.clone().addScaledVector(eje, lado * anchura * (distal ? .035 : .19)));
        }
      }
      const casco = conformar(nube, limites);
      if (grueso && !metacarpo) {
        casco.applyMatrix4(inversa);
        const vs = casco.attributes.position;
        const actual = espesorCentral(casco, vs, new Matrix4(), longitud);
        const factor = espesor / actual.espesor;
        // La cara de apoyo permanece en su sitio al dimensionar la carcasa.
        for (let j = 0; j < vs.count; j++) vs.setY(j, actual.minimo + (vs.getY(j) - actual.minimo) * factor);
        casco.computeVertexNormals();
        casco.applyMatrix4(base);
      }
      const segmento = pieza('Blindaje ' + h.name, h, casco, goma);
      juntas.push({ eje: junta, anterior, segmento });
      anterior = segmento;
    }
  }
  // La malla anatómica queda disponible para el solucionador y las sondas.
  destino.malla.visible = false;
  return { juntas, collar, chasis };
}
