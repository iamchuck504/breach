import { Vector3, MathUtils } from 'three';
import { acotar, dedos, limites, situar } from './rig.js';

export const abierta = () => acotar();
function cerrar(flexion, separacion = 0) {
  const pose = abierta();
  for (const [i, d] of dedos.entries()) {
    const f = flexion(i);
    pose[d] = { mcp: f, pip: f * 1.15, dip: f * 0.69, abd: (1.5 - i) * separacion };
  }
  return pose;
}
export function relajada() {
  const p = cerrar(i => 9 + i * 4, 0.6);
  p.thumb = { cmcFlex: 12, cmcAbd: 9, mcp: 9, ip: 6 };
  return acotar(p);
}
export function empuñadura(gatillo = false) {
  const p = cerrar(i => 53 + i * 4, 0.5);
  p.index = gatillo ? { mcp: 29, pip: 46, dip: 16, abd: 7 } : { mcp: 3, pip: 5, dip: 2, abd: 8 };
  p.thumb = { cmcFlex: 21, cmcAbd: 23, mcp: 9, ip: 8 };
  return acotar(p);
}

// Descenso de mínimos cuadrados amortiguado con diferencias finitas.
// Las incógnitas son grados, y los residuos geométricos están en milímetros.
function ajustar(inicial, cotas, residuos) {
  let x = inicial.slice(), r = residuos(x);
  const norma = a => a.reduce((s, v) => s + v * v, 0);
  let coste = norma(r), lambda = 0.04;
  for (let iter = 0; iter < 65; iter++) {
    const J = x.map((v, j) => {
      const prueba = x.slice();
      const paso = v + 0.15 > cotas[j][1] ? -0.15 : 0.15;
      prueba[j] += paso;
      return residuos(prueba).map((s, i) => (s - r[i]) / paso);
    });
    const prod = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    const A = J.map((col, i) => [...J.map((c, j) => prod(col, c) + (i === j ? lambda : 0)), -prod(col, r)]);
    for (let i = 0; i < x.length; i++) {
      const pivote = A[i][i];
      for (let k = i; k <= x.length; k++) A[i][k] /= pivote;
      for (let j = 0; j < x.length; j++) if (j !== i) {
        const factor = A[j][i];
        for (let k = i; k <= x.length; k++) A[j][k] -= factor * A[i][k];
      }
    }
    const siguiente = x.map((v, j) => MathUtils.clamp(v + A[j].at(-1), ...cotas[j]));
    const rr = residuos(siguiente), nuevo = norma(rr);
    if (nuevo < coste) {
      const mejora = coste - nuevo;
      x = siguiente; r = rr; coste = nuevo; lambda = Math.max(0.0001, lambda / 2);
      if (mejora < 0.000001) break;
    } else if ((lambda *= 4) > 100000) break;
  }
  residuos(x);
}

export function crearPosador(rig, piel, escala, avancePulgar = 0) {
  const { cadenas, palmar, largo, lateral } = rig;
  const centroNudillos = cadenas.middle[1].getWorldPosition(new Vector3());
  const v = new Vector3(), delta = new Vector3();
  const punto = m => situar(m, v);
  const cache = new Map();
  function cilindroBase(d, ajuste, avance) {
    if (!Number.isFinite(d) || d <= 0) throw new RangeError('Diámetro inválido');
    const radio = d / (2 * escala);
    return {
      radio, eje: lateral.clone(),
      centro: centroNudillos.clone().addScaledVector(palmar, radio + 0.0275 + ajuste + Math.max(0, radio - 0.025) * 0.4)
        .addScaledVector(largo, avance - 0.006),
    };
  }
  function pinza() {
    rig.aplicar(abierta());
    const p = cerrar(i => 20 + i * 6, 1);
    const nombres = Object.keys(limites.thumb);
    const inicio = [32, 30, 20, 20, 48, 62, 32];
    const cotas = [...Object.values(limites.thumb), ...['mcp', 'pip', 'dip'].map(n => limites.dedo[n])];
    // El pulgar y el índice aportan grados de libertad. Se enfrentan los
    // extremos de las almohadillas dejando luz para el borde de una anilla.
    function centroYema(d) {
      const lista = piel.grupos[d].yema;
      return lista.reduce((s, m) => s.add(punto(m)), new Vector3()).divideScalar(lista.length);
    }
    ajustar(inicio, cotas, x => {
      p.thumb = Object.fromEntries(nombres.map((n, i) => [n, x[i]]));
      p.index = { mcp: x[4], pip: x[5], dip: x[6], abd: 5 };
      rig.aplicarParte('index', p.index);
      rig.aplicarParte('thumb', p.thumb);
      const error = centroYema('thumb').sub(centroYema('index')).addScaledVector(largo, 0.019);
      return [...error.multiplyScalar(1000).toArray(), ...x.map((v, i) => (v - inicio[i]) * 0.035)];
    });
    return acotar(p);
  }

  const pielPulgar = piel.vertices.filter(m => m.enlaces.some(e => cadenas.thumb.includes(e.h)));
  function resolverCilindro(c) {
    rig.aplicar(abierta());
    const p = abierta();
    function distancia(m) {
      delta.copy(punto(m)).sub(c.centro);
      return (delta.addScaledVector(c.eje, -delta.dot(c.eje)).length() - c.radio) * 1000;
    }
    function minimo(muestras) {
      let min = Infinity;
      for (const m of muestras) min = Math.min(min, distancia(m));
      return min;
    }
    function superficie(ms) {
      const puntos = ms.map(m => punto(m).clone());
      const centro = puntos.reduce((s, p) => s.add(p), new Vector3()).divideScalar(puntos.length);
      return { puntos, centro };
    }
    function holgura(a, b) {
      // Un plano entre las dos almohadillas separa también sus triángulos.
      const eje = a.centro.clone().sub(b.centro).normalize();
      let cerca = Infinity, lejos = -Infinity;
      for (const p of a.puntos) cerca = Math.min(cerca, p.dot(eje));
      for (const p of b.puntos) lejos = Math.max(lejos, p.dot(eje));
      return Math.min(0, (cerca - lejos) * 1000 - .4);
    }
    for (const dedo of [...dedos, 'thumb']) {
      const g = piel.grupos[dedo], pulgar = dedo === 'thumb';
      const nombres = pulgar ? Object.keys(limites.thumb) : ['mcp', 'pip', 'dip'];
      const cotas = nombres.map(n => (pulgar ? limites.thumb : limites.dedo)[n]);
      const inicio = pulgar ? (avancePulgar ? [6, 28, 8, 4] : [10, 38, 34, 32]) : [40, 63, 43];
      const pose = p[dedo];
      const otras = pulgar ? dedos.flatMap(d => piel.grupos[d].falanges.slice(1).map(superficie)) : [];
      const resolver = x => {
        nombres.forEach((n, i) => { pose[n] = x[i]; });
        rig.aplicarParte(dedo, pose);
        const contactos = g.falanges.map(minimo);
        const punta = minimo(g.yema);
        // Una pequeña holgura compensa la cuerda de los triángulos entre vértices.
        const separacion = Math.min(...contactos, pulgar ? minimo(pielPulgar) : Infinity);
        const penetracion = Math.min(0, separacion - .18);
        const apoyo = pulgar ? [] : contactos.slice(1).map(v => v - 0.24);
        if (pulgar) {
          for (const ms of g.falanges.slice(1)) {
            const zona = superficie(ms);
            for (const otra of otras) apoyo.push(holgura(zona, otra) * 2);
          }
          const centro = g.yema.reduce((s, m) => s.add(punto(m)), new Vector3()).divideScalar(g.yema.length);
          const baseIndice = cadenas.index[1].getWorldPosition(new Vector3());
          const axial = centro.clone().sub(baseIndice).dot(c.eje);
          apoyo.push(Math.max(0, Math.abs(axial + avancePulgar / escala) * 1000 - (avancePulgar ? 1 : 9)) * 0.14);
          if (avancePulgar) {
            // La yema descansa por delante de la articulación distal a lo largo del tubo.
            const distal = cadenas.thumb.at(-2).getWorldPosition(new Vector3());
            apoyo.push(Math.max(0, centro.clone().sub(distal).dot(c.eje) * 1000 + 6) * .3);
          }
          apoyo.push(Math.max(0, centro.sub(c.centro).dot(largo) * 1000 + c.radio * 500));
        }
        return [...apoyo, (punta - 0.24) * 3, penetracion * 7,
          ...x.map((v, i) => (v - inicio[i]) * (pulgar ? 0.018 : 0.003))];
      };
      ajustar(inicio, cotas, resolver);
    }
    const errores = [-minimo(piel.vertices)];
    for (const [dedo, g] of Object.entries(piel.grupos)) {
      errores.push(Math.abs(minimo(g.yema)));
      if (dedo !== 'thumb') errores.push(...g.falanges.slice(1).map(ms => Math.abs(minimo(ms))));
    }
    return { p: acotar(p), c, error: Math.max(...errores) * escala };
  }
  function agarre(d = 0.05) {
    if (cache.has(d)) return cache.get(d);
    // Si el primer apoyo no cabe (p. ej. con más acolchado), se desplaza
    // el tubo por la palma y se vuelve a resolver cada articulación.
    for (const avance of [0, .004, -.004, .008]) {
      for (const ajuste of [0, .0015, .003, -.0015, .0045]) {
        const resultado = resolverCilindro(cilindroBase(d, ajuste, avance));
        if (resultado.error <= 0.95) {
          cache.set(d, resultado);
          return resultado;
        }
      }
    }
    throw new RangeError(`No se encontró contacto a ±1 mm para el diámetro de ${d} m`);
  }
  const puñoCilindro = d => acotar(agarre(d).p);
  function cilindro(d) {
    const { centro, eje, radio } = agarre(d).c;
    return { centro: centro.clone(), eje: eje.clone(), radio };
  }
  return { abierta, relajada, empuñadura, pinza, puñoCilindro, cilindro };
}
