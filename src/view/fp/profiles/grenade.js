// GRANADA DE HUMO — perfil del arma en primera persona. Esquema y unidades
// en src/view/fp/profiles.js; guía en src/view/fp/README.md.
//
// En la mano derecha (puño); la izquierda baja, libre. Lógica real
// (tuning.js): gesto de 0.5 s con la suelta a 0.28 s (`throwRelease`); la
// granada rápida (tecla G) es un cambio honesto a la granada, el
// lanzamiento y la vuelta al arma anterior en la suelta (weapons.quickThrow).
// Lanzamiento por encima del hombro: la izquierda arranca la anilla (pieza
// `pin`) → carga atrás y arriba → latigazo al frente → SUELTA (el bote de la
// mano desaparece en ese cuadro: pista `show`) → seguimiento abajo, fuera
// de cuadro → sube otra granada (si quedan).
import { contactos } from './contactos.js';
import { COMMON } from './common.js';

const REL = 0.56; // suelta / duración del gesto (0.28 / 0.5)
// Tras soltar la anilla, el guante de apoyo vuelve por debajo de la ventana.
const libre = { cam: [-.04, -.248, -.32], axis: [0.51, -0.80, 0.31], palm: [0.02, 0.37, 0.93] };
const GRENADE = {
  model: 'grenade', thrown: true, scale: 0.5,
  hip: { pos: [0.16485, -0.11518, -0.46184], rot: [-0.04518, 0.02265, 0.42207] },
  // "apuntar" con la granada: se sube, lista para lanzar (la línea de mira
  // del arte es virtual, por encima del bote)
  ads: { relief: 0.26, roll: 0.7 },
  adsTime: 0.18,
  sprint: { pos: [-0.02, -0.06, 0.03], rot: [-0.25, 0.3, 0.2] },
  crouch: { pos: [-0.004, -0.01, 0.006], rot: [0, 0.01, 0.03] },
  lower: { pos: [0.02, -0.12, 0.04], rot: [-0.4, 0.2, 0.2] },
  slide: { pos: [-0.01, -0.02, 0.01], rot: [-0.04, 0.06, 0.2] },
  wall: { pos: [-0.01, -0.04, 0.16], rot: [-0.3, 0.2, 0.1] },
  mass: 0.6,
  // El bote tiene que recorrer el arco del lanzamiento antes de la suelta.
  govV: 4.5,
  recoil: { kick: 0, rise: 0, yaw: 0, roll: 0, ads: 1 },
  // anilla: la arranca la izquierda y se pierde abajo a la izquierda
  parts: {
    anilla: [
      [-.12, 0, -.12, -.12, 0, -.015],
      [-.09, 0, 0, 0, 0, 0],
    ],
    triggerTravel: 0, anim: { spoon: { track: 'spoon', afterRelease: true, rot: [0.48, 0, 0] }, pin: { track: 'pin' } } },
  targets: {
    // puño: la palma aprieta la cuchara (espalda del bote, +z)
    grip: contactos.grenade.dominante.target,
    // izquierda: en reposo, baja y fuera de cuadro (de cerca la mano plana
    // junto al bote tapaba media pantalla); sube a la anilla al sacar
    forend: libre,
    mag: { anchor: 'pin', axis: [0, 0.2, -1], palm: [-1, 0.2, 0], off: [-0.04, -0.02, 0] },
    pouch: { cam: [0.0, -0.46, -0.24], axis: [0, 0.3, -1], palm: [-0.2, -1, 0] },
    bolt: contactos.grenade.anilla.target,
    // La izquierda se retira después del contacto con la anilla.
    wind: { ...libre, cam: [0.035, -0.29, -0.22] },
    out: libre,
  },
  grips: {
    right: { target: 'grip', pose: 'cylinder' },
    left: { target: 'forend', pose: 'cup' },
    mag: { pose: 'pinch' },
  },
  // la granada no recarga (la lógica no tiene pasos): pista vacía
  reload: { steps: [], tail: 0, tracks: { gun: [[0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0]] } },
  throw: {
    releaseAt: REL,
    tracks: {
      // aditivo sobre la cadera: [u, px, py, pz, rx, ry, rz]
      gun: [
        [0, 0, 0, 0, 0, 0, 0],
        [0.12, -0.00233, 0.00317, 0.038, 0.134, -0.08867, 0.00896],
        [0.26, 0.012, 0.0185, 0.074, 0.197, -0.13, 0.02195],
        [0.42, 0.012, 0.0185, 0.074, 0.197, -0.13, 0.02195],
        [0.56, -0.00351, 0.01321, -0.008, -0.00746, -0.00377, -0.07805],
        [0.69, -0.012, -0.035, 0.012, -0.12746, 0.02472, -0.09805],
        [0.8, -0.004, -0.082, 0.045, -0.25955, 0.00393, -0.06338],
        [1, 0, -0.06, 0.032, -0.16, 0, 0],
      ],
      //      forend mag pouch bolt(anilla) wind out
      left: (u, out) => {
        // Acercamiento y retirada con velocidad y aceleración nulas al
        // tocar la anilla. La duración del lanzamiento sigue siendo la del juego.
        const paso = x => { x = Math.max(0, Math.min(1, x)); return x*x*x*(10+x*(-15+6*x)); };
        const pinza = paso(u/.36) * (1-paso((u-.44)/.36));
        out.fill(0);
        out[0] = 1 - pinza;
        out[3] = pinza;
        return out;
      },
      lCurl: [[0, 0, 1, 0, 0, 0], [0.15, 0, 0, 0, 1, 0], [0.51, 0, 0, 0, 1, 0], [0.68, 0, 0, 1, 0, 0], [0.75, 0, 0, 1, 0, 0], [1, 0, 1, 0, 0, 0]],
      // la anilla sale con el tirón de la izquierda (y no vuelve en este gesto)
      spoon: [[0, 0], [REL - 0.035, 0], [REL, 1], [1, 1]],
      pin: [[0, 0], [0.44, 0], [0.55, 1], [1, 1]],
      // la granada sale de la mano EN la suelta; la siguiente (si queda y no
      // es granada rápida, que vuelve al arma anterior) aparece al fundirse
      // el gesto, con la mano aún baja
      show: [[0, 1], [REL - 0.006, 1], [REL + 0.004, 0], [1, 0]],
    },
  },
  // guardar: sin granada en la mano (en la granada rápida el cambio de vuelta
  // empieza en la misma suelta: el bote ya voló). Sacar: con granada.
  swap: {
    tracks: {
      ...COMMON.swap.tracks,
      gun: [
        [0, 0, 0, 0, 0, 0, 0], [0.25, 0.009, -0.064, 0.024, -0.10, 0.04, -0.06],
        [0.48, 0.018, -0.15, 0.048, -0.18, 0.08, -0.12],
        [0.52, 0.018, -0.15, 0.048, -0.18, 0.08, -0.12], [1, 0, 0, 0, 0, 0, 0],
      ],
      show: [[0, 0], [0.488, 0], [0.494, 1], [1, 1]],
    },
  },
};

export default { ...COMMON, ...GRENADE };
