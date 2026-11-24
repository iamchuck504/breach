// PISTOLA — reglas de piezas y piezas construidas para scripts/build-viewmodel-art.mjs.
// Formato: ver src/view/fp/README.md y scripts/viewmodel-art/smg.mjs. Las
// cajas de las reglas van en coordenadas ABSOLUTAS del modelo y `rel` las
// pasa al marco del socket `grip` que espera el script.
// Coordenadas: x derecha, y arriba, -z hacia la boca.
import { cbox, ccyl, lathe, prism, T } from '../../src/view/fp/kit/geometry.js';
import { bolt, rail, inventoryMark } from '../../src/view/fp/kit/hardware.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

function sculpt(piece) {
  const slide = piece('slide'), body = piece('body'), mag = piece('mag');
  // Dos mejillas fresadas con bisel roto y estrías inclinadas en el talón.
  for (const side of [-1, 1]) {
    // El faldón inferior era una cara lisa de punta a punta.
    body.add(prism([[-0.304, 0.030], [-0.289, 0.063], [-0.144, 0.063],
      [-0.124, 0.045], [-0.153, 0.019], [-0.280, 0.019]], 0.005, 0.0018), T(side * 0.051, 0, 0), SURF.ceramic);
    for (const z of [-0.267, -0.243, -0.219]) {
      body.add(cbox(0.002, 0.016, 0.009, 0.001), T(side * 0.054, 0.041, z, -0.48), SURF.black);
    }
    bolt(body, side * 0.054, 0.041, -0.157, 0, side * Math.PI / 2, 0.005);
    slide.add(prism([[-0.308, 0.109], [-0.29, 0.148], [-0.107, 0.148], [-0.126, 0.11]], 0.006, 0.002), T(side * 0.055, 0, 0), SURF.metalDark);
    for (let i = 0; i < 6; i++) slide.add(cbox(0.009, 0.047, 0.007), T(side * 0.056, 0.127, -0.009 + i * 0.014, -0.28), SURF.steel);
    for (const z of [-0.278, -0.147]) bolt(slide, side * 0.059, 0.131, z, 0, side * Math.PI / 2, 0.006);
    body.add(cbox(0.008, 0.012, 0.061, 0.002), T(side * 0.052, 0.027, 0.041), SURF.metal);
    for (let i = 0; i < 5; i++) mag.add(ccyl(0.005, 0.003, 10), T(side * 0.027, -0.119 + i * 0.029, 0.079, 0, Math.PI / 2), SURF.black);
  }
  // La tapa trasera se lee en cadera y debajo del alza al apuntar.
  slide.add(cbox(0.075, 0.047, 0.007, 0.003), T(0, 0.126, 0.088), SURF.metalDark);
  for (const x of [-0.026, 0.026]) bolt(slide, x, 0.138, 0.092, 0, 0, 0.005);
  for (const y of [0.111, 0.118, 0.125]) slide.add(cbox(0.042, 0.0025, 0.002), T(0, y, 0.092), SURF.steel);
  inventoryMark(slide, '12', -0.0586, 0.132, -0.208, 0.009);
  // La cantonera se encastra en el brocal. Sus estrías quedan en la tapa
  // que toma la pinza de recarga.
  mag.add(cbox(0.066, 0.053, 0.074, 0.006), T(0, -0.124, 0.096, -0.10), SURF.polymer);
  mag.add(cbox(0.085, 0.042, 0.086, 0.008), T(0, -0.158, 0.100, -0.10), SURF.rubber);
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
    mag.add(cbox(0.003, 0.018, 0.005), T(side * 0.042, -0.158, 0.077 + i * 0.018, -0.10), SURF.polymer);
  }
  const muzzle = lathe([[0.022, -0.342], [0.022, -0.346], [0.032, -0.346], [0.036, -0.341], [0.035, -0.331]], 24);
  body.add(muzzle, T(0, 0.104, 0), SURF.steel);
  for (let i = 0; i < 3; i++) slide.add(cbox(0.002, 0.012, 0.004), T(-0.059, 0.128, -0.247 + i * 0.011, -0.35), SURF.mark);
  body.push(T(0, -0.007, -0.22, Math.PI));
  rail(body, 0, -0.072, 0.072, 0.05);
  body.pop();
}

export default ({ sockets }) => {
  const g = sockets.grip;
  const rel = (box) => box.map((r, i) => [r[0] - g[i], r[1] - g[i]]);
  return {
    sculpt,
    // La cacha derecha es más fina para dejar sitio al índice blindado.
    // El lomo, el brocal y los paneles comparten el mismo plano de ajuste.
    shapeIsland(part, isla, posiciones) {
      if (part !== 'body' || isla.min[1] >= -.01 || isla.min[2] < 0 || isla.max[0] <= 0) return;
      for (const i of isla.verts) {
        const x = 3*i;
        if (posiciones[x] <= 0) continue;
        const altura = Math.min(1, Math.max(0, (posiciones[x+1]+.14)/.055));
        posiciones[x] *= 1 - .32*altura;
      }
    },
    rules: [
      // el alza original es un bloque sin muesca: se sustituye por una construida
      { part: 'slide', from: 'grip', box: rel([[-0.04, 0.04], [0.17, 0.2], [0.02, 0.07]]), drop: true },
      // el casquillo del cañón (anillo de grafito de la boca) se queda en el armazón
      { part: 'body', from: 'grip', mat: 'graphite', box: rel([[-0.04, 0.04], [0.09, 0.115], [-0.35, -0.26]]) },
      // corredera: todo lo que está por encima del armazón (cuerpo, guion,
      // tiras fresadas, estrías delanteras y traseras, tapa de la ventana)
      { part: 'slide', from: 'grip', box: rel([[-0.07, 0.07], [0.09, 0.2], [-0.35, 0.1]]) },
      // gatillo
      { part: 'trigger', from: 'grip', mat: 'machined', box: rel([[-0.01, 0.01], [-0.05, -0.02], [-0.02, 0.01]]) },
      // tapa del cargador (asoma bajo la empuñadura)
      { part: 'mag', from: 'grip', box: rel([[-0.05, 0.05], [-0.175, -0.145], [0.09, 0.115]]) },
    ],
    build: [
      // alza de muesca con dos puntos (tres con el del guion): la línea de
      // mira pasa por la muesca a la altura del punto del guion (y 0.1955)
      ['slide', 'graphite', [-0.036, 0.165, 0.026], [0.036, 0.181, 0.066], 0.003],
      ['slide', 'graphite', [-0.036, 0.179, 0.03], [-0.0085, 0.206, 0.062], 0.003],
      ['slide', 'graphite', [0.0085, 0.179, 0.03], [0.036, 0.206, 0.062], 0.003],
      ['slide', 'recessed red led', [-0.026, 0.19, 0.0605], [-0.018, 0.198, 0.0635], 0.0015],
      ['slide', 'recessed red led', [0.018, 0.19, 0.0605], [0.026, 0.198, 0.0635], 0.0015],
      // cuerpo del cargador (el original solo trae la tapa) y el cartucho de
      // arriba (acero: el modelo no trae latón): se ven al sacarlo
      ['mag', 'slate metal', [-0.027, -0.148, 0.052], [0.027, 0.03, 0.108], 0.004],
      ['mag', 'machined', [-0.011, 0.03, 0.058], [0.011, 0.043, 0.102], 0.004],
      // cañón bajo la corredera: asoma por delante cuando la corredera va atrás
      // cañón y recámara en metal mecanizado (claro, de la paleta del modelo):
      // al ir atrás la corredera lo descubre — "abierta" y "cerrada" se
      // distinguen de un vistazo, también con el bloqueo en vacío
      ['body', 'machined', [-0.022, 0.088, -0.332], [0.022, 0.13, -0.12], 0.004],
      ['body', 'machined', [-0.026, 0.12, -0.12], [0.026, 0.16, -0.02], 0.004],
    ],
    pivots: {
      body: [0, 0, 0],
      slide: [0, 0.125, 0],             // corre hacia +z (atrás)
      trigger: [0, -0.012, -0.006],     // eje del gatillo, arriba
      mag: [0, -0.06, 0.09],
    },
    anchors: {
      muzzle: [0, 0.104, -0.345],
      grip: sockets.grip,
      // apoyo: el costado izquierdo de la empuñadura (la izquierda envuelve a la derecha)
      forend: [-0.046, -0.06, 0.075],
      support: [-0.046, -0.06, 0.075],
      // la tapa del cargador (la mano lo coge por aquí)
      mag: [0, -0.174, 0.102],
      sight_rear: [0, 0.1955, 0.046],
      sight_front: [0, 0.1955, -0.2635],
      eject: [0.064, 0.142, -0.045],
      // estrías traseras, lado izquierdo (por si se monta la corredera a mano)
      slide: [-0.058, 0.115, 0.04],
    },
  };
};
