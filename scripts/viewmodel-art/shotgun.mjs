// ESCOPETA — reglas de piezas y piezas construidas para scripts/build-viewmodel-art.mjs.
// Formato: ver src/view/fp/README.md y scripts/viewmodel-art/smg.mjs.
// Aquí las cajas de las reglas se escriben en coordenadas ABSOLUTAS del
// modelo (más fáciles de leer contra la lista de islas) y `rel` las pasa al
// marco del socket `grip` que espera el script.
// Coordenadas: x derecha, y arriba, -z hacia la boca.
import { cbox, ccyl, lathe, prism, T } from '../../src/view/fp/kit/geometry.js';
import { bolt, rail, inventoryMark } from '../../src/view/fp/kit/hardware.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

function sculpt(piece) {
  const body = piece('body'), pump = piece('pump');
  rail(body, 0.155, -0.194, 0.010, 0.041);
  // Tapa posterior con junta escalonada, visible justo bajo el alza.
  body.add(cbox(0.131, 0.110, 0.010, 0.004), T(0, 0.036, 0.272), SURF.metalDark);
  body.add(cbox(0.112, 0.088, 0.008, 0.003), T(0, 0.035, 0.279), SURF.ceramic);
  for (const x of [-0.044, 0.044]) bolt(body, x, 0.062, 0.284, 0, 0, 0.006);
  for (const y of [0.020, 0.034, 0.048]) body.add(cbox(0.065, 0.004, 0.003), T(0, y, 0.284), SURF.black);
  // El portacartuchos y el cartucho de la recarga comparten perfil torneado.
  for (const [x, y, b] of [[-0.105, 0.077, body], [-0.105, 0.029, body], [-0.105, -0.019, body], [0, 0, piece('mag')]]) {
    b.add(ccyl(0.022, 0.132, 20, 0.002), T(x, y, -0.139), SURF.team);
    b.add(lathe([[0, -0.077], [0.023, -0.077], [0.023, -0.058], [0.025, -0.057], [0.025, -0.053], [0, -0.053]], 20), T(x, y, 0), SURF.brass);
    b.add(ccyl(0.007, 0.002, 12), T(x, y, -0.0525), SURF.steel);
  }
  inventoryMark(body, '08', -0.096, 0.024, 0.075, 0.012);
  for (const side of [-1, 1]) {
    body.add(prism([[0.068, -0.006], [0.153, -0.006], [0.175, 0.020], [0.163, 0.072], [0.077, 0.072], [0.064, 0.058]], 0.009, 0.003), T(side * 0.091, 0, 0), SURF.ceramic);
    for (const z of [0.080, 0.149]) bolt(body, side * 0.096, 0.054, z, 0, side * Math.PI / 2, 0.006);
    for (let i = 0; i < 5; i++) {
      const z = -0.582 + i * 0.056;
      pump.add(cbox(0.009, 0.052, 0.017, 0.003), T(side * 0.082, 0.002, z, -0.12), SURF.rubber);
      bolt(pump, side * 0.087, 0.008, z, 0, side * Math.PI / 2, 0.004);
    }
  }
}

export default ({ sockets }) => {
  const g = sockets.grip;
  const rel = (box) => box.map((r, i) => [r[0] - g[i], r[1] - g[i]]);
  // |x| va en absoluto (absX); y, z relativos al socket
  const relAbsX = (box) => [box[0], ...rel(box).slice(1)];
  return {
    sculpt,
    rules: [
      // la corredera de cobre (cuerpo + cinco anillos) y sus diez tacos laterales de grafito
      { part: 'pump', from: 'grip', mat: 'copper', box: rel([[-0.1, 0.1], [-0.07, 0.07], [-0.62, -0.32]]) },
      { part: 'pump', from: 'grip', absX: true, box: relAbsX([[0.08, 0.09], [-0.01, 0.01], [-0.62, -0.32]]) },
      // gatillo (pieza de acero fresado dentro del guardamonte)
      { part: 'trigger', from: 'grip', mat: 'machined', box: rel([[-0.01, 0.01], [-0.07, -0.04], [0.03, 0.07]]) },
      // culata, sus tornillos y la cantonera (detrás del cajón): pieza aparte
      // por si de cerca roza la cámara
      { part: 'stock', from: 'grip', box: rel([[-0.1, 0.1], [-0.15, 0.15], [0.28, 0.75]]) },
    ],
    build: [
      // alza de muesca sobre la tapa del cajón (el original no tenía): base y
      // dos orejas; la línea de mira pasa por la muesca a la altura del punto
      // rojo del guion (y 0.179)
      ['body', 'graphite', [-0.03, 0.156, 0.018], [0.03, 0.167, 0.062], 0.003],
      ['body', 'graphite', [-0.03, 0.165, 0.026], [-0.0095, 0.191, 0.056], 0.0035],
      ['body', 'graphite', [0.0095, 0.165, 0.026], [0.03, 0.191, 0.056], 0.0035],
      ['body', 'machined', [-0.0095, 0.165, 0.046], [0.0095, 0.169, 0.056], 0.0015],
      // ventana de carga bajo el cajón: dos raíles, labio delantero y el
      // elevador de cartuchos (acero) entre ellos
      ['body', 'slate metal', [-0.064, -0.054, -0.215], [-0.046, -0.034, -0.048], 0.004],
      ['body', 'slate metal', [0.046, -0.054, -0.215], [0.064, -0.034, -0.048], 0.004],
      ['body', 'slate metal', [-0.064, -0.054, -0.228], [0.064, -0.034, -0.212], 0.004],
      ['body', 'machined', [-0.047, -0.047, -0.208], [0.047, -0.038, -0.062], 0.003],
      // ventana de expulsión a la derecha del cajón (sale el cartucho al bombear)
      ['body', 'slate metal', [0.076, 0.066, -0.178], [0.084, 0.11, -0.062], 0.003],
      ['body', 'graphite', [0.081, 0.074, -0.166], [0.0875, 0.102, -0.074], 0.002],
      // portacartuchos lateral (izquierda del cajón, de cara a la cámara): placa,
      // tres cartuchos tumbados y dos cinchas. La mano coge de aquí el de abajo
      // (misma orientación que al meterlo: solo traslación, sin giro de muñeca)
      ['body', 'slate metal', [-0.087, -0.046, -0.214], [-0.078, 0.1, -0.046], 0.003],
      ['body', 'graphite', [-0.131, -0.046, -0.182], [-0.082, 0.1, -0.168], 0.003],
      ['body', 'graphite', [-0.131, -0.046, -0.112], [-0.082, 0.1, -0.098], 0.003],
    ],
    pivots: {
      body: [0, 0, 0],
      pump: [0, 0, -0.47],              // corre hacia +z (atrás) hasta el cajón
      trigger: [0, -0.027, 0.045],      // eje del gatillo, arriba
      stock: [0, 0, 0.25],
      mag: [0, 0, -0.13],               // centro del cartucho
    },
    anchors: {
      muzzle: sockets.muzzle,
      grip: sockets.grip,
      // el centro de la corredera en reposo (la mano izquierda la sigue)
      forend: sockets.forend,
      pump: sockets.forend,
      // el cartucho en su reposo (dentro, sobre la ventana de carga) y la ventana
      mag: [0, 0, -0.13],
      port: [0, -0.045, -0.13],
      // el cartucho de abajo del portacartuchos
      saddle: [-0.105, -0.019, -0.13],
      sight_rear: [0, 0.179, 0.041],
      sight_front: [0, 0.179, -0.8435],
      eject: [0.088, 0.088, -0.12],
    },
  };
};
