// SNIPER — reglas de piezas y piezas construidas para scripts/build-viewmodel-art.mjs.
// Formato: ver scripts/viewmodel-art/smg.mjs y src/view/fp/README.md.
// Coordenadas del MODELO: x derecha, y arriba, -z hacia la boca.
//
// Del original (art/characters/blender-source/sniper.glb, 137 islas):
//  · cerrojo: la palanca (pomo de grafito + vástago) va a la IZQUIERDA del
//    cajón: la mano de apoyo la trabaja y la derecha no suelta la empuñadura;
//  · cargador (caja de grafito bajo el cajón), gatillo (hoja mecanizada);
//  · mira: tubo, anillos, campana del objetivo y su lente (dark optic).
// Construido: la lente del OCULAR (el original solo tiene la del objetivo):
// un disco biselado tras la cara del ocular. Su
// centro es el eje óptico (sight_rear) y en la ADS crece hasta llenar el
// anillo del scope de la interfaz (relevo sin salto).
import { cbox, ccyl, prism, T } from '../../src/view/fp/kit/geometry.js';
import { bolt, rail, inventoryMark } from '../../src/view/fp/kit/hardware.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

function sculpt(piece) {
  const b = piece('body'), boltKnob = piece('bolt');
  const mag = piece('mag');
  mag.add(cbox(0.095, 0.016, 0.160, 0.005), T(0, -0.218, -0.009), SURF.rubber);
  for (const side of [-1, 1]) for (const z of [-0.048, 0.015]) {
    mag.add(cbox(0.005, 0.130, 0.012, 0.002), T(side * 0.045, -0.125, z, -0.09), SURF.metalDark);
  }
  inventoryMark(b, '07', -0.090, 0.030, -0.147, 0.013);
  // Corona de enfoque, ocular protegido y torretas de la óptica.
  for (const z of [0.102, 0.143, 0.185]) b.add(ccyl(0.070, 0.009, 32, 0.002), T(0, 0.228, z), SURF.rubber);
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    b.add(cbox(0.008, 0.006, 0.066, 0.0015), T(-0.068 * Math.sin(a), 0.228 + 0.068 * Math.cos(a), 0.142, 0, 0, a), SURF.metalDark);
  }
  b.add(ccyl(0.035, 0.032, 20), T(0, 0.305, -0.032, Math.PI / 2), SURF.metalDark);
  b.add(ccyl(0.037, 0.01, 24), T(0, 0.325, -0.032, Math.PI / 2), SURF.metal);
  for (let i = 0; i < 11; i++) {
    const a = i * Math.PI / 12;
    b.add(cbox(0.002, 0.005, 0.008), T(-0.031 * Math.sin(a), 0.331, -0.032 + 0.031 * Math.cos(a), 0, -a), SURF.mark);
  }
  rail(b, 0.145, -0.27, 0.11, 0.057);
  for (const z of [-0.19, 0.051]) bolt(b, -0.048, 0.17, z, 0, -Math.PI / 2, 0.011);
  for (const z of [0.175, 0.188, 0.201]) boltKnob.add(ccyl(0.03, 0.004, 14), T(-0.10, 0.077, z), SURF.rubber);
  // El labio superior del guardamanos continúa por detrás del pulgar.
  b.add(cbox(.108, .034, .373, .012), T(-.032, .097, -.522), SURF.metalDark);
  // La cara inferior desciende por delante de las yemas y enlaza con el cuerpo.
  b.add(prism([[-.80,.067],[-.76,-.067],[-.705,-.079],[-.665,-.024],[-.657,.032],[-.585,.044],[-.55,.067]], .088, .008),
    T(-.004, 0, 0), SURF.rubber);
  for (let i = 0; i < 5; i++) b.add(cbox(0.005, 0.033, 0.031), T(-0.060, 0.038, -0.58 + i * 0.061, -0.4), SURF.black);
}

export default ({ sockets }) => ({
  sculpt,
  rules: [
    // cargador: centro (0, -0.118, -0.009) → respecto al socket mag (0, +0.084, +0.003)
    { part: 'mag', from: 'mag', mat: 'graphite', box: [[-0.03, 0.03], [0.05, 0.11], [-0.04, 0.04]] },
    // gatillo: hoja mecanizada delante de la empuñadura
    { part: 'trigger', from: 'grip', mat: 'machined', box: [[-0.02, 0.02], [-0.02, 0.03], [-0.14, -0.1]] },
    // cerrojo: pomo y vástago a la izquierda, a la altura de la empuñadura
    { part: 'bolt', from: 'grip', box: [[-0.13, -0.04], [0.1, 0.17], [-0.06, 0.08]] },
  ],
  build: [
    // Disco de radio 0,056 m; el centro de la cara posterior define el eje óptico.
    ['body', 'dark optic', [-0.056, 0.172, 0.15], [0.056, 0.284, 0.2205], 0.005, 'disc'],
  ],
  pivots: {
    body: [0, 0, 0],
    mag: [0, -0.016, -0.009],        // borde superior del cargador
    bolt: [0, 0.077, 0.15],          // en el eje del cerrojo: la palanca gira alrededor (levantar)
    trigger: [0, -0.03, 0.045],      // eje del gatillo, arriba
  },
  anchors: {
    muzzle: sockets.muzzle,
    grip: sockets.grip,
    forend: sockets.forend,
    mag: sockets.mag,
    // eje óptico: centro de la lente del ocular → centro de la del objetivo
    sight_rear: [0, 0.228, 0.2205],
    sight_front: [0, 0.228, -0.364],
    // ventana de expulsión: a la derecha del cajón, sobre el cerrojo
    eject: [0.085, 0.06, 0.02],
    // pomo del cerrojo (lo trabaja la mano izquierda)
    bolt: [-0.1, 0.077, 0.19],
    // recámara abierta (cerrojo atrás), por la izquierda del cajón: el
    // pulgar empuja el cartucho
    port: [-0.06, 0.1, 0.05],
  },
});
