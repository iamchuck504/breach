import assert from 'node:assert/strict';
import { Box3, Line3, Plane, Triangle, Vector3 } from 'three';

const cache = new WeakMap();
function solido(malla) {
  if (cache.has(malla)) return cache.get(malla);
  const { index, attributes } = malla.geometry;
  const vs = Array.from({ length: attributes.position.count }, (_, i) =>
    new Vector3().fromBufferAttribute(attributes.position, i));
  const caras = [], planos = [], puntos = [];
  const centro = vs.reduce((a, v) => a.add(v), new Vector3()).divideScalar(vs.length);
  for (let i = 0; i < index.count; i += 3) {
    const t = new Triangle(...[0, 1, 2].map(k => vs[index.getX(i + k)]));
    if (t.getArea() < 1e-14) continue;
    caras.push(t);
    const p = t.getPlane(new Plane());
    if (!planos.some(q => p.normal.dot(q.normal) > .999999 && Math.abs(p.constant - q.constant) < 1e-7)) planos.push(p);
    const borde = t.getMidpoint(new Vector3());
    for (const f of [.35, .65, .88]) puntos.push(centro.clone().lerp(borde, f));
  }
  const datos = { planos, puntos, caras, vs };
  cache.set(malla, datos);
  return datos;
}

// Buscar un volumen común dentro de ambas mallas convexas. Dos cajas
// envolventes que se solapen o un simple roce en un canto no bastan.
function encajada(junta, pieza) {
  const local = pieza.matrixWorld.clone().invert().multiply(junta.matrixWorld);
  const planos = solido(pieza).planos;
  let primero;
  for (const v of solido(junta).puntos) {
    const p = v.clone().applyMatrix4(local);
    if (!planos.every(plano => plano.distanceToPoint(p) < -.0001)) continue;
    if (primero && primero.distanceToSquared(p) > .002 ** 2) return true;
    primero ??= p;
  }
  return false;
}

export function comprobarUniones({ blindaje }, caso) {
  assert.equal(blindaje.juntas.length, 15);
  assert.equal(new Set(blindaje.juntas.map(j => j.segmento.parent)).size, 15);
  for (const { eje, anterior, segmento } of blindaje.juntas) {
    assert.equal(segmento.parent, eje.parent);
    for (const pieza of [anterior, segmento]) {
      assert.ok(encajada(eje, pieza), `Hueco entre ${eje.name} y ${pieza.name} en ${caso}`);
    }
  }
  assert.ok(encajada(blindaje.collar, blindaje.chasis), 'Collar separado del chasis');
}

// Distancia de la cara completa al cilindro infinito. Una arista paralela
// al eje puede degenerar en un punto al proyectarla.
function distancia(malla, cilindro, referencia, recorte) {
  const alBanco = referencia.clone().multiply(malla.matrixWorld);
  const proyectar = v => {
    const p = v.clone().applyMatrix4(alBanco).sub(cilindro.centro);
    return p.addScaledVector(cilindro.eje, -p.dot(cilindro.eje));
  };
  let menor = Infinity;
  const cero = new Vector3(), q = new Vector3();
  for (const t of solido(malla).caras) {
    let vertices = [t.a, t.b, t.c];
    if (recorte) {
      const borde = [];
      for (let i = 0; i < 3; i++) {
        const a = vertices[i], b = vertices[(i + 1) % 3];
        const da = recorte.distanceToPoint(a), db = recorte.distanceToPoint(b);
        if (da >= 0) borde.push(a);
        if (da * db < 0) borde.push(a.clone().lerp(b, da / (da - db)));
      }
      vertices = borde;
    }
    const p = vertices.map(proyectar);
    for (let i = 1; i + 1 < p.length; i++) {
      if (new Triangle(p[0], p[i], p[i + 1]).containsPoint(cero)) return -cilindro.radio;
    }
    for (let i = 0; i < p.length; i++) {
      const linea = new Line3(p[i], p[(i + 1) % p.length]);
      if (linea.distanceSq() < 1e-16) q.copy(linea.start);
      else linea.closestPointToPoint(cero, true, q);
      menor = Math.min(menor, q.lengthSq());
    }
  }
  return Math.sqrt(menor) - cilindro.radio;
}
export function contactoBlindaje(h, d, escala) {
  const cilindro = h.poses.cilindro(d), inversa = h.grupo.matrixWorld.clone().invert();
  let maximo = 0, minimo = Infinity;
  const apoyos = new Set(h.blindaje.juntas.map(j => j.segmento).filter(o =>
    !o.parent.name.startsWith('thumb') || o.parent.name.endsWith('distal')));
  h.grupo.traverseVisible(o => {
    if (!o.isMesh) return;
    const mm = distancia(o, cilindro, inversa) * escala * 1000;
    assert.ok(mm >= -1e-3, `${o.name} penetra ${-mm} mm en el cilindro ${d} ×${escala}`);
    if (apoyos.has(o)) {
      assert.ok(mm <= 1, `Falta apoyo en ${o.name}: ${mm} mm, diámetro ${d} ×${escala}`);
      maximo = Math.max(maximo, mm);
      if (o.parent.name.endsWith('distal')) {
        const punta = o.parent.children.find(h => h.isBone).position;
        const plano = new Plane(punta.clone().normalize(), -.8 * punta.length());
        const yema = distancia(o, cilindro, inversa, plano) * escala * 1000;
        assert.ok(yema <= 1, `Yema blindada de ${o.name}: ${yema} mm, diámetro ${d} ×${escala}`);
        maximo = Math.max(maximo, yema);
      }
    }
    minimo = Math.min(minimo, mm);
  });
  return { maximo, minimo };
}

// El horneado de la derecha invierte el orden de dos vértices por triángulo.
// Comparamos caras dibujadas incluso si el indexado local reúne más vértices.
export function espejoBlindado(izq, der) {
  const visibles = h => {
    const mallas = [];
    h.grupo.traverseVisible(o => { if (o.isMesh && o !== h.blindaje.collar) mallas.push(o); });
    return mallas;
  };
  const a = visibles(izq), b = visibles(der);
  assert.equal(a.length, b.length);
  const centroI = izq.grupo.localToWorld(izq.rig.origen.clone());
  const centroD = der.grupo.localToWorld(der.rig.origen.clone());
  let error = 0;
  const p = new Vector3(), q = new Vector3();
  for (const [j, m] of a.entries()) {
    const n = b[j], g = m.geometry, f = n.geometry;
    assert.equal(n.name, m.name);
    assert.equal(f.index.count, g.index.count);
    for (let i = 0; i < g.index.count; i++) {
      const reflejo = i + [1, -1, 0][i % 3];
      p.fromBufferAttribute(g.attributes.position, g.index.getX(i)).applyMatrix4(m.matrixWorld).sub(centroI);
      q.fromBufferAttribute(f.attributes.position, f.index.getX(reflejo)).applyMatrix4(n.matrixWorld).sub(centroD);
      p.x *= -1;
      error = Math.max(error, p.distanceTo(q) * 1000);
    }
  }
  assert.ok(error < .1, `Asimetría de blindaje: ${error} mm`);
  return error;
}

// Dos sólidos convexos quedan separados por una cara o por la perpendicular
// común de dos aristas. Sólo las cajas cercanas necesitan la prueba completa.
export function sinCrucesDeBlindaje(h, caso) {
  const piezas = [];
  h.grupo.traverseVisible(o => {
    if (!o.isMesh || !o.parent.name.includes('phalanx') && !o.parent.name.startsWith('thumb')) return;
    const { vs, planos, caras } = solido(o);
    const puntos = vs.map(v => v.clone().applyMatrix4(o.matrixWorld));
    piezas.push({ o, puntos, caja: new Box3().setFromPoints(puntos), dedo: o.parent.name.split('-')[0],
      planos: planos.map(p => p.clone().applyMatrix4(o.matrixWorld)), caras });
  });
  const separa = (a, b) => a.planos.some(p => b.puntos.every(v => p.distanceToPoint(v) >= -1e-7));
  function aristas(pieza) {
    if (pieza.aristas) return pieza.aristas;
    const ejes = [];
    for (const { a, b, c } of pieza.caras) {
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const eje = p.clone().sub(q).transformDirection(pieza.o.matrixWorld);
        if (!ejes.some(e => Math.abs(e.dot(eje)) > .999999)) ejes.push(eje);
      }
    }
    return pieza.aristas = ejes;
  }
  function separanAristas(a, b) {
    for (const e of aristas(a)) for (const f of aristas(b)) {
      const n = new Vector3().crossVectors(e, f);
      if (n.lengthSq() < 1e-14) continue;
      n.normalize();
      const aa = a.puntos.map(p => p.dot(n)), bb = b.puntos.map(p => p.dot(n));
      if (Math.max(...aa) <= Math.min(...bb) + 1e-7 || Math.max(...bb) <= Math.min(...aa) + 1e-7) return true;
    }
    return false;
  }
  for (const [i, a] of piezas.entries()) for (const b of piezas.slice(i + 1)) {
    if (a.dedo === b.dedo || !a.caja.intersectsBox(b.caja)) continue;
    assert.ok(separa(a, b) || separa(b, a) || separanAristas(a, b),
      `Cruce de ${a.o.name} con ${b.o.name} en ${caso}`);
  }
}

// La tapa distal del brazal debe entrar en el volumen del collar. Se usan
// sus triángulos individuales porque el bloque Blender incluye varias islas.
export function comprobarBrazal(brazal, collar) {
  const { planos, puntos } = solido(collar);
  const interior = puntos.reduce((a, p) => a.add(p), new Vector3()).divideScalar(puntos.length);
  const p = new Vector3(), inversa = collar.matrixWorld.clone().invert();
  for (const pieza of brazal.children) {
    const local = inversa.clone().multiply(pieza.matrixWorld);
    for (const t of solido(pieza).caras) {
      const cara = t.clone();
      for (const v of [cara.a, cara.b, cara.c]) v.applyMatrix4(local);
      cara.closestPointToPoint(interior, p);
      if (planos.every(plano => plano.distanceToPoint(p) < -.0001)) return;
    }
  }
  assert.fail('La boca del antebrazo no alcanza la muñeca');
}
