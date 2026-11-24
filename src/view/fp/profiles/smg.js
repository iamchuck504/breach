// SMG — perfil del arma en primera persona (ejemplo de referencia: ver
// src/view/fp/README.md). Esquema y unidades en src/view/fp/profiles.js.
import { contactos } from './contactos.js';
import { smgReload, vulcanHand, vulcanTravel, pasoDeMuneca } from './crashterra.js';
import { COMMON } from './common.js';

const SMG = {
  model: 'smg', scale: 0.33,
  // VULCAN: encuadre en YXZ; posición trasladada al pivote de este GLB.
  apoyoLanzamiento: { out: [-.125, -.169, -.53] },
  arcoLanzamiento: [
    [0.0525, 0.0225, -0.105, 0.06, 0.405, 0.0075],
    [0.285, -0.18, 0.06, 0.195, -0.09, -0.1125],
  ],
  despeje: {
    lanzamiento: [-0.1785, -0.34, -0.077, 0.06, -0.16, 0],
    recarga: [-0.023, -0.1545, -0.05, 0.112, 0.0875, 0.116],
    brocal: [-0.0175, 0, 0.001, 0, 0, 0],
  },
  encuadreRecarga: [.17, -.027, -.23],
  hip: { pos: [0.1635391, -0.1566872, -0.3581173], rot: [0.20355, 0.3480188000000001, 0.020489] },
  // La manga prolonga la muñeca desde la cara inferior del guardamanos.
  supportArm: { desenrollar: .0625, apertura: .055, extension: .866, salida: [-0.0525, -0.213, -0.067],
    scale: 2.34, sleeveScale: 1.12,
    // Centro de la tapa distal de segment_forearm_L y asiento interior del collar.
    boca: [-.0013, -.30995, .0009], asiento: [0, -.001, .007], twist: 1.38473,
    elbowDirection: [-0.5628, -0.0695, 0.8237], elbowDirectionADS: [-.789, -.355, .501],
  },
  // Calibre de conformado del blindaje, en metros de la mano sin escalar.
  anatomia: {
    diametro: .05314363, avancePulgar: .02883721,
    sillaPulgar: [0.00600623, 0.01018022, -0.00190843],
    // Los dedos rodean las costillas exteriores al dejar el guardamanos.
    giroRetiro: {
      thumb: [0.09, 0.0025, -0.0025],
      index: [0.215, 0.0025, -0.0025],
      ring: [0.055, 0.265, 0.06],
      pinky: [0.0825, 0.0025, -0.0025],
    },
    giroPulgar: [0.29076994, -0.00018184, 0.07145821, 0.95412082],
    blindajeGrueso: true,
    // Planos de la cara cercana del guardamanos, en el espacio de cada falange.
    carasApoyo: {
      'thumb-metacarpal': [-0.377634653, -0.924626852, 0.049570691, -0.009454544],
      'thumb-phalanx-distal': [-0.756854057, -0.653581123, 0.001911004, -0.009839043],
      'thumb-phalanx-proximal': [-0.849666429, -0.51131302, -0.128941674, -0.012473],
    },
    apoyo: {
      index: { mcp: 12.2063, pip: 85.2465, dip: 65.9197, abd: -0.8117 },
      middle: { mcp: 13.3596, pip: 109.6201, dip: 27.1225, abd: 0.7436 },
      ring: { mcp: 39.4409, pip: 80.465, dip: 73.4085, abd: -8.511 },
      pinky: { mcp: 28.0113, pip: 87.5024, dip: 56.3001, abd: -14.916 },
      thumb: { cmcFlex: 0, cmcAbd: 0, mcp: 27.82038, ip: 6.23523 },
    },
  },
  ads: { relief: 0.2025, roll: 0 },
  adsTime: 0.2,
  sprint: { pos: [-0.05, -0.05, 0.035], rot: [-0.34, 0.62, 0.3] },
  crouch: { pos: [-0.006, -0.012, 0.008], rot: [0, 0.02, 0.05] },
  lower: { pos: [0.02, -0.09, 0.04], rot: [-0.5, 0.22, 0.22] },
  slide: { pos: [-0.02, -0.02, 0.02], rot: [-0.05, 0.08, 0.3] },
  wall: { pos: [-0.01, -0.05, 0.12], rot: [-0.55, 0.32, 0.12] },
  mass: 2.6,
  recoil: { kick: 0.011, rise: 0.034, yaw: 0.012, roll: 0.018, ads: 0.5 },
  parts: { sightHipScale: 0.935, stockTuckADS: true, mag: 'mag', bolt: 'bolt', trigger: 'trigger', boltAxis: [0, 0, 1], boltTravel: 0.12, triggerTravel: 0.3, magGuide: { axis: [0, -1, -0.10], clear: 0.18, blend: 0.06 } },
  slideKick: { back: 0.017, hold: 0.036, ret: 0.046 },
  targets: {
    // el puño baja por la empuñadura: el índice queda a la altura del gatillo
    // y el pulgar no entra en el cajón
    grip: contactos.smg.dominante.target,
    // El dorso queda bajo el apoyo y las cuatro yemas cierran por el lado lejano.
    forend: contactos.smg.apoyo.target,
    mag: contactos.smg.carga.target,
    bolt: { anchor: 'bolt', axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50], off: [-0.035, 0.01, 0] },
    pouch: { cam: [0.04, -0.5, -0.26], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    wind: { cam: [-0.045, -0.12, -0.24], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    out: { cam: [0.12, -0.13, -0.56], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
  },
  grips: {
    right: { pose: 'indexed', target: 'grip' },
    left: { pose: 'cup', target: 'forend' },
    mag: { pose: 'pinch' },
  },
  reload: {
    // mag_out 0.15 y mag_in 0.62 (audio.js); la palanca suena en reloadDone
    steps: [{ t: 0.15, step: 'magOut' }, { t: 0.62, step: 'magIn' }, { t: 1, step: 'boltRelease' }],
    // Tras insertar el cargador, el cajón gira a la derecha para presentar
    // la palanca mientras la izquierda asciende desde el brocal.
    // La manga izquierda sigue hasta el borde mientras suelta y recupera el guardamanos.
    encuadre: [
      [0, 0, -.048, 0], [.035, 0, -.046, 0], [.075, 0, 0, 0], [.67, 0, 0, 0],
      [.75, .025, 0, 0], [.83, 0, 0, 0], [.90, 0, -.060, 0], [1, 0, -.05, 0],
    ],
    tail: 0.14, // la vuelta a la postura sigue tras el final lógico
    tracks: {
      pasoMuneca: pasoDeMuneca([
        [0.018, 0, 0, 0],
        [0.035, -0.54614, -16.43881, 0],
        [0.077, 0, 0, 0],
        [0.0945374, 0, 0, 0],
        [0.1306177, -0.7379865, -3.0740984, 0.1995995],
        [0.1601973, 0, 0, 0],
        [0.66, 0, 0, 0],
        [0.7, 6.64, 6.64, -9.13],
        [0.75, 0, 0, 0],
        [0.8, 0, 0, 0],
        [0.86, 0.06106, -3.70996, 1.28816],
        [0.94, 0, 0, 0],
      ]),
      gun: smgReload,
      left: vulcanHand,
      lOff: vulcanTravel,
      //       support pinch open rack fist
      lCurl: [
        [0, 1, 0, 0, 0, 0], [0.08, 0, 0, 1, 0, 0], [0.12, 0, 1, 0, 0, 0], [0.62, 0, 1, 0, 0, 0],
        [0.66, 0, 1, 0, 0, 0], [0.76, 0, 1, 0, 0, 0], [0.84, 0, 0, 0, 1, 0], [0.99, 0, 0, 0, 1, 0],
        [1.03, 0, 0, 1, 0, 0], [1.14, 1, 0, 0, 0, 0],
      ],
      bolt: [[0, 0], [0.85, 0], [0.95, 1], [0.995, 1], [1.005, 0], [1.14, 0]],
    },
  },
};

export default { ...COMMON, ...SMG };
