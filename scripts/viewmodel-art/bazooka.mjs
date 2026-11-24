// BAZUCA — reglas de piezas y piezas construidas para scripts/build-viewmodel-art.mjs.
// Formato: ver scripts/viewmodel-art/smg.mjs y src/view/fp/README.md.
// Coordenadas del MODELO: x derecha, y arriba, -z hacia la boca.
//
// Del original (art/characters/blender-source/bazooka.glb, 112 islas): tubo
// de grafito con cinco anillos mecanizados, brocal delantero, sección trasera
// con su anillo (tapa), empuñadura trasera con gatillo, empuñadura delantera,
// y la mira sobre el tubo (base, capuchón y lente).
// Construido:
//  · la OJIVA del cohete asomando por la boca (cuerpo, banda de equipo,
//    cono escalonado y espoleta), pieza propia `mag`: la carga la mano
//    izquierda en la recarga;
//  · el capuchón de la mira HUECO (cuatro paredes): el original es una caja
//    maciza con la lente delante y en la ADS taparía el centro de la
//    pantalla. Dentro, un punto de LED en el eje: la mira réflex;
//  · tapa trasera: el anillo trasero original es su propio nodo (`cap`).
const TUBE_Y = 0.0484; // eje del tubo (centro de los anillos)
import { cbox, ccyl, lathe, prism, tube, T } from '../../src/view/fp/kit/geometry.js';
import { bolt, inventoryMark } from '../../src/view/fp/kit/hardware.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

function sculpt(piece) {
  const b = piece('body'), cap = piece('cap');
  const y = TUBE_Y;
  // Dos conchas estampadas siguen el tubo; los aros quedan a la vista entre ellas.
  for (const [z, length] of [[-0.33, 0.20], [0.32, 0.17]]) {
    for (const side of [-1, 1]) {
      b.push(T(side * 0.096, y + 0.044, z, 0, 0, side * 0.43));
      b.add(cbox(0.012, 0.058, length, 0.005), null, SURF.ceramic);
      for (const end of [-1, 1]) bolt(b, side * 0.007, 0.009, end * (length / 2 - 0.017), 0, side * Math.PI / 2, 0.006);
      for (const slit of [-0.025, 0, 0.025]) b.add(cbox(0.002, 0.027, 0.010, 0.0008), T(side * 0.0065, 0, slit, -0.32), SURF.black);
      b.pop();
    }
  }
  // Brocal con pared interior visible y tapa con orejetas solidarias.
  b.add(lathe([[0.101, -0.833], [0.101, -0.866], [0.124, -0.866], [0.131, -0.855], [0.131, -0.838], [0.126, -0.833]], 36), T(0, y, 0), SURF.metalDark);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    cap.add(cbox(0.024, 0.012, 0.029), T(-0.122 * Math.sin(a), y + 0.122 * Math.cos(a), 0.642, 0, 0, a), SURF.metalDark);
  }
  const rocket = piece('mag');
  rocket.add(lathe([[0, -1.062], [0.015, -1.054], [0.047, -1.012], [0.081, -0.942], [0.089, -0.912], [0.089, -0.845], [0, -0.845]], 28), T(0, y, 0), SURF.metal);
  rocket.add(ccyl(0.091, 0.019, 28), T(0, y, -0.891), SURF.team);
  for (const side of [-1, 1]) {
    b.add(prism([[-0.24, 0.173], [-0.20, 0.251], [0.026, 0.251], [0.05, 0.224], [0.04, 0.172]], 0.009, 0.004), T(side * 0.059, 0, 0), SURF.metal);
    for (const z of [-0.19, 0.018]) bolt(b, side * 0.065, 0.217, z, 0, side * Math.PI / 2, 0.009);
  }
  // Cable protegido entre el ocular y el selector del costado.
  b.add(tube([[-0.05, 0.259, -0.10], [-0.076, 0.25, -0.071], [-0.079, 0.20, 0.002], [-0.059, 0.182, 0.028]], 0.005, 14, 8), null, SURF.rubber);
  inventoryMark(b, '04', -0.0645, 0.229, -0.144, 0.009);
  for (const z of [-0.58, -0.54, -0.50]) b.add(ccyl(0.112, 0.008, 32), T(0, y, z), SURF.rubber);
  for (let i = 0; i < 6; i++) b.add(cbox(0.005, 0.026, 0.009), T(-0.066, 0.204, -0.14 + i * 0.021, -0.34), SURF.black);
}

export default ({ sockets }) => ({
  sculpt,
  rules: [
    // gatillo: hoja mecanizada delante de la empuñadura trasera
    { part: 'trigger', from: 'grip', mat: 'machined', box: [[-0.02, 0.02], [-0.02, 0.03], [-0.11, -0.05]] },
    // tapa trasera: el anillo mecanizado del extremo
    { part: 'cap', from: 'grip', mat: 'machined', box: [[-0.02, 0.02], [0.08, 0.14], [0.5, 0.58]] },
    // mira: capuchón macizo y lente del original → se sustituyen (hueco)
    { part: 'sight', from: 'grip', mat: 'graphite', box: [[-0.02, 0.02], [0.32, 0.4], [-0.3, -0.2]], drop: true },
    { part: 'sight', from: 'grip', mat: 'optic', box: [[-0.02, 0.02], [0.32, 0.4], [-0.36, -0.32]], drop: true },
  ],
  build: [
    // capuchón hueco de la mira (mismo contorno que el original)
    ['body', 'graphite', [-0.044, 0.313, -0.238], [0.044, 0.325, -0.079], 0.004],
    ['body', 'graphite', [-0.044, 0.261, -0.238], [0.044, 0.273, -0.079], 0.004],
    ['body', 'graphite', [-0.044, 0.271, -0.238], [-0.033, 0.315, -0.079], 0.003],
    ['body', 'graphite', [0.033, 0.271, -0.238], [0.044, 0.315, -0.079], 0.003],
    // brocal delantero del capuchón (marco de la lente, metal)
    ['body', 'slate metal', [-0.047, 0.258, -0.246], [0.047, 0.276, -0.236], 0.003],
    ['body', 'slate metal', [-0.047, 0.31, -0.246], [0.047, 0.328, -0.236], 0.003],
    // punto réflex: LED en el eje de la mira, al fondo del capuchón
    ['body', 'led', [-0.0022, 0.2913, -0.24], [0.0022, 0.2957, -0.237], 0.0008],
  ],
  pivots: {
    body: [0, 0, 0],
    mag: [0, TUBE_Y, -0.88],          // base de la ojiva, en el eje del tubo
    trigger: [0, -0.03, 0.03],        // eje del gatillo, arriba
    cap: [0, TUBE_Y, 0.64],           // anillo trasero
  },
  anchors: {
    // el fogonazo nace en la boca del tubo (la ojiva sale de ahí)
    muzzle: sockets.muzzle,
    grip: sockets.grip,
    forend: sockets.forend,
    mag: [0, TUBE_Y, -0.9],
    // línea de mira: centro del marco trasero → punto réflex
    sight_rear: [0, 0.2935, -0.079],
    sight_front: [0, 0.2935, -0.24],
    // sin casquillo: el "eject" es el chorro trasero (rebufo)
    eject: [0, TUBE_Y, 0.66],
    backblast: [0, TUBE_Y, 0.66],
    // hombrera: donde el tubo apoya en el hombro derecho
    shoulder: [0, -0.061, 0.3],
  },
});
