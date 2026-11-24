// Adaptación de buildVulcan (vulcan.ts de CRASHTERRA) al subfusil de Breach.
// La transformación lleva el eje del cañón y la ventana réflex a las anclas originales.
import { cbox, ccyl, cyl, lathe, prism, T } from '../../src/view/fp/kit/geometry.js';
import { rail, bolt, inventoryMark } from '../../src/view/fp/kit/hardware.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

// Alza y guion comparten la altura del centro de la ventana.
const ejeOptico = 0.2075;
const pomo = [-0.067, 0.041, -0.083];

function buildVulcan(piece, anchors) {
  const sy = 0.062, sx = 2.05, sz = 1.62;
  // La altura del cajón conserva la referencia original aunque baje el colimador.
  const scaleY = (0.1905 - anchors.muzzle[1]) / (0.132 - sy);
  const y0 = anchors.muzzle[1] - scaleY * sy, z0 = anchors.muzzle[2] + 0.586 * sz;
  const frame = T(0, y0, z0, 0, 0, 0, sx, scaleY, sz);
  const b = piece('body').push(frame);
  b.add(prism([[0.07, -0.006], [0.082, 0.03], [0.07, 0.048], [-0.232, 0.048], [-0.242, 0.03], [-0.236, -0.006]], 0.06, 0.004), null, SURF.metal);
  b.add(prism([[0.062, 0.048], [0.062, 0.082], [0.044, 0.096], [-0.205, 0.096], [-0.238, 0.08], [-0.244, 0.048]], 0.054, 0.004), null, SURF.metal);
  b.add(cbox(0.062, 0.004, 0.3, 0.001), T(0, 0.048, -0.085), SURF.metalDark);
  b.add(prism([[0.056, 0.002], [0.066, 0.028], [0.056, 0.042], [-0.055, 0.042], [-0.07, 0.024], [-0.06, 0.002]], 0.006, 0.0018), T(-0.032, 0, 0), SURF.ceramic);
  b.add(prism([[-0.19, 0.052], [-0.19, 0.088], [-0.21, 0.094], [-0.232, 0.08], [-0.238, 0.052]], 0.006, 0.0015), T(-0.028, 0, 0), SURF.ceramic);
  b.add(prism([[0.058, 0.002], [0.066, 0.028], [0.056, 0.042], [-0.07, 0.042], [-0.08, 0.02], [-0.07, 0.002]], 0.006, 0.0018), T(0.032, 0, 0), SURF.ceramic);
  b.add(cbox(0.002, 0.03, 0.002, 0.0005), T(-0.0355, 0.022, 0.0), SURF.black);
  b.add(cbox(0.002, 0.002, 0.1, 0.0005), T(-0.0355, 0.012, 0.0), SURF.black);
  for (const [z, y] of [[0.045, 0.034], [0.045, 0.01], [-0.045, 0.034], [-0.045, 0.01]]) bolt(b, -0.0358, y, z, 0, -Math.PI / 2);
  for (const [z, y] of [[-0.2, 0.086], [-0.225, 0.06]]) bolt(b, -0.0315, y, z, 0, -Math.PI / 2, 0.0035);
  // La tapa posterior sigue el bisel del riel.
  b.add(cbox(0.046, 0.028, 0.005, 0.002), T(0, 0.066, 0.063), SURF.ceramic);
  b.push(T(0, 0.089, 0.053, -0.91));
  b.add(cbox(0.037, 0.018, 0.004, 0.0018), null, SURF.metalDark);
  for (const y of [-0.005, 0, 0.005]) b.add(cbox(0.027, 0.0018, 0.002, 0.0006), T(0, y, 0.002), SURF.steel);
  b.pop();
  // Culata calada y cantonera estriada.
  const stock = piece('stock').push(frame);
  stock.add(cbox(0.022, 0.02, 0.15, 0.005), T(0, 0.004, 0.14), SURF.metalDark);
  stock.add(cbox(0.026, 0.018, 0.14, 0.005), T(0, 0.066, 0.13, 0.06), SURF.metal);
  stock.add(cbox(0.03, 0.05, 0.02, 0.006), T(0, 0.035, 0.12), SURF.metalDark);
  stock.add(cbox(0.042, 0.11, 0.026, 0.01), T(0, 0.03, 0.215), SURF.rubber);
  for (let i = 0; i < 7; i++) stock.add(cbox(0.044, 0.004, 0.012), T(0, -0.014 + i * 0.014, 0.224), SURF.polymer);
  const gripPts = [[0.042, 0.0], [0.0, 0.0], [-0.012, -0.03], [-0.006, -0.1], [0.026, -0.11], [0.044, -0.075], [0.052, -0.03]];
  b.add(prism(gripPts, 0.050, 0.004), null, SURF.polymer);
  b.add(prism([[0.034, -0.012], [0.004, -0.012], [-0.004, -0.035], [0.0, -0.09], [0.024, -0.096], [0.038, -0.07], [0.044, -0.035]], 0.054, 0.002), null, SURF.rubber);
  b.add(cbox(0.055, 0.014, 0.05, 0.004), T(0, -0.112, 0.012, 0.15), SURF.metalDark);
  b.add(cbox(0.012, 0.006, 0.07, 0.002), T(0, -0.034, -0.032), SURF.metalDark);
  b.add(cbox(0.012, 0.034, 0.006, 0.002), T(0, -0.018, -0.068), SURF.metalDark);
  piece('trigger').push(frame).add(prism([[-0.02, -0.003], [-0.03, -0.003], [-0.036, -0.016], [-0.031, -0.028], [-0.026, -0.018]], 0.007, 0.0015), null, SURF.light);
  b.add(prism([[-0.078, -0.004], [-0.178, -0.004], [-0.186, -0.034], [-0.07, -0.034]], 0.062, 0.003), null, SURF.metal);
  b.add(cbox(0.066, 0.006, 0.1, 0.002), T(0, -0.035, -0.128, 0.1), SURF.light);
  b.add(cbox(0.012, 0.012, 0.012, 0.003), T(-0.033, -0.02, -0.074), SURF.team);
  // Ventana fresada en el costado visible, guía y corredera de la palanca.
  b.add(prism([[-0.18, 0.058], [-0.17, 0.085], [0.042, 0.085], [0.052, 0.073], [0.041, 0.058]], 0.006, 0.0015), T(-0.028, 0, 0), SURF.black);
  b.add(cyl(0.004, 0.19, 12), T(-0.032, 0.078, -0.066), SURF.steel);
  b.add(cbox(0.004, 0.007, 0.17), T(-0.032, 0.059, -0.066), SURF.steel);
  // Chapa de inspección mate y marcas oblicuas, visibles entre
  // las aletas y la placa numerada incluso con la luz rasante del mapa.
  b.add(prism([[-0.223, 0.008], [-0.213, 0.037], [-0.102, 0.037], [-0.092, 0.025], [-0.101, 0.008]], 0.004, 0.001), T(-0.0305, 0, 0), SURF.ceramic);
  for (let i = 0; i < 3; i++) b.add(cbox(0.0016, 0.020, 0.005), T(-0.033, 0.022, -0.205 + i * 0.012, -0.44), SURF.mark);
  for (const z of [-0.147, -0.125]) b.add(cbox(0.002, 0.004, 0.012), T(-0.033, 0.022, z), SURF.black);
  b.add(cbox(0.0025, 0.013, 0.038, 0.002), T(-0.035, 0.024, -0.016), SURF.team);
  inventoryMark(b, '03', -0.0356, 0.022, 0.012, 0.0052);
  // El pomo estriado va a lo largo de la corredera, en su ranura izquierda.
  const actuator = piece('bolt').push(T(...pomo));
  actuator.add(cbox(0.027, 0.029, 0.047, 0.004), T(0.004, 0, 0.020), SURF.metal);
  actuator.add(cbox(0.014, 0.020, 0.035, 0.003), T(-0.003, 0, 0.019), SURF.polymer);
  actuator.add(ccyl(0.011, 0.046, 12, 0.002), T(0, 0, -0.016), SURF.steel);
  for (let i = 0; i < 3; i++) actuator.add(ccyl(0.013, 0.004, 12, 0.0008), T(0, 0, -0.019 - i * 0.008), SURF.rubber);
  // Montura y ventana del réflex sobre el eje óptico del perfil.
  rail(b, 0.096, 0.053, -0.22, 0.028);
  const [, ry, rz] = anchors.sight_rear;
  const rear = piece('sight_rear').push(T(0, ry, rz));
  const lateral = 0.0662, pared = 0.0132, semialto = 0.0456, fondo = 0.008;
  for (const x of [-lateral, lateral]) {
    rear.add(cbox(pared, 2 * semialto, fondo, 0.0015), T(x, 0, 0), SURF.metal);
  }
  for (const y of [-semialto, semialto]) {
    rear.add(cbox(2 * lateral + pared, pared, fondo, 0.0015), T(0, y, 0), SURF.metal);
  }
  // Carcasa bajo el cristal y mordaza asentada sobre los dientes del riel.
  const mount = piece('sight_mount').push(T(0, ry, rz));
  const riel = y0 + scaleY * 0.106 - ry;
  const borde = -semialto - 0.002, hombro = borde - 0.024;
  const carcasa = [[-0.056, borde], [0.056, borde], [0.056, borde - 0.012],
    [0.038, hombro], [-0.038, hombro], [-0.056, borde - 0.012]];
  mount.add(prism(carcasa, 0.056, 0.003), T(0, 0, -0.012, 0, Math.PI / 2), SURF.metal);
  mount.add(cbox(0.073, hombro - riel + 0.004, 0.071, 0.003), T(0, (hombro + riel) / 2, -0.017), SURF.metalDark);
  mount.add(cbox(0.083, 0.014, 0.081, 0.003), T(0, riel + 0.002, -0.017), SURF.metal);
  rear.add(ccyl(0.0032, 0.002, 16), T(0, 0, 0), SURF.dot);
  // Camisa abierta, aletas y boca torneada de la VULCAN-X.
  b.add(cyl(0.0115, 0.33, 14), T(0, sy, -0.39), SURF.steel);
  for (let i = 0; i < 13; i++) b.add(ccyl(0.02, 0.0045, 14, 0.001), T(0, sy, -0.262 - i * 0.019), SURF.steel);
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.add(cbox(0.009, 0.009, 0.28, 0.002), T(x * 0.022, sy + y * 0.022, -0.38), SURF.metal);
  for (const z of [-0.248, -0.38, -0.512]) b.add(cbox(0.058, 0.058, 0.012, 0.004), T(0, sy, z), SURF.metal);
  for (let i = 0; i < 6; i++) b.add(cbox(0.04, 0.006, 0.034, 0.002), T(0, sy + 0.027, -0.276 - i * 0.042), SURF.metalDark);
  b.add(cbox(0.05, 0.008, 0.27, 0.002), T(0, sy - 0.028, -0.38), SURF.metalDark);
  b.add(lathe([[0.0, -0.586], [0.008, -0.586], [0.008, -0.578], [0.021, -0.584], [0.025, -0.578], [0.025, -0.56], [0.019, -0.556], [0.019, -0.548], [0.023, -0.545], [0.023, -0.524], [0.02, -0.518], [0, -0.518]], 16), T(0, sy, 0), SURF.metal);
  for (let i = 0; i < 4; i++) b.add(cbox(0.052, 0.003, 0.004, 0.001), T(0, sy, -0.531 - i * 0.004 * (i > 1 ? 4 : 1), 0, 0, (i * Math.PI) / 4), SURF.black);
  b.add(cbox(0.056, 0.012, 0.12, 0.004), T(0, sy - 0.032, -0.36), SURF.polymer);
  for (let i = 0; i < 5; i++) b.add(cbox(0.06, 0.006, 0.008, 0.002), T(0, sy - 0.034, -0.315 - i * 0.022), SURF.rubber);
  b.add(prism([[-0.43, sy - 0.03], [-0.445, sy - 0.03], [-0.452, sy - 0.062], [-0.438, sy - 0.066]], 0.04, 0.004), null, SURF.metal);
  const front = piece('sight_front');
  const [, , fz] = anchors.sight_front;
  // Guion de respaldo plegado contra el riel bajo el eje del colimador.
  front.add(cbox(0.056, 0.012, 0.042, 0.002), T(0, 0.1055, fz), SURF.metal);
  front.add(cbox(0.020, 0.010, 0.043, 0.002), T(0, 0.1145, fz + 0.010), SURF.metalDark);
  // Cargador de chapa con nervios, testigos de carga y zapata de goma.
  const mag = piece('mag').push(frame).push(T(0, -0.016, -0.127, 0.10));
  mag.add(prism([[-0.037, 0.018], [0.038, 0.018], [0.035, -0.09], [0.022, -0.135], [-0.046, -0.126], [-0.032, -0.081]], 0.047, 0.003), null, SURF.metalDark);
  for (const side of [-1, 1]) {
    for (const z of [-0.018, 0.002, 0.022]) mag.add(cbox(0.003, 0.081, 0.005, 0.001), T(side * 0.024, -0.048, z, 0.06), SURF.metal);
    for (let i = 0; i < 4; i++) mag.add(ccyl(0.0026, 0.0014, 10), T(side * 0.024, -0.024 - i * 0.019, 0.012, 0, Math.PI / 2), SURF.black);
  }
  mag.add(cbox(0.053, 0.011, 0.077, 0.003), T(0, -0.132, -0.012, 0.1), SURF.rubber);
}

export default ({ sockets }) => ({
  replace: true, sculpt: buildVulcan, rules: [], build: [],
  pivots: {
    body: [0, 0, 0], trigger: [0, -0.119, 0.078], mag: [0, -0.15, -0.088],
    bolt: pomo, stock: [0, 0, 0.24],
    sight_rear: [0, ejeOptico, 0.205], sight_mount: [0, ejeOptico, 0.205], sight_front: [0, ejeOptico, -0.3505],
  },
  anchors: {
      muzzle: sockets.muzzle,
      grip: sockets.grip,
      forend: sockets.forend,
      mag: [0, -0.327, -0.081],
      // Dos puntos de la línea óptica, independientes del guion de respaldo.
      sight_rear: [0, ejeOptico, 0.205],
      sight_front: [0, ejeOptico, -0.3505],
      eject: [0.072, 0.091, -0.11],
      // pomo izquierdo de la palanca de carga (lo tira la mano de apoyo)
      bolt: [pomo[0], pomo[1], pomo[2] - 0.03],
    },
});
