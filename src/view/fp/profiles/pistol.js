// PISTOLA — perfil del arma en primera persona. Esquema en src/view/fp/profiles.js
// y src/view/fp/README.md. Arma ligera en la mano derecha: el retroceso es un
// chasquido corto (sube y vuelve enseguida), la corredera va atrás en cada
// tiro y se queda bloqueada atrás tras el último cartucho.
//
// Lógica real (src/combat/weapons.js): 260 RPM, recarga de cargador 1.35 s
// con `magOut` 0.12, `magIn` 0.55 y `slideRelease` 1 (tras confirmar la
// munición). La lógica no distingue recarga vacía de táctica (mismo tiempo):
// la corredera de la animación vacía queda atrás hasta `slideRelease`.
//
// Campos que pide al código compartido (ganchos/armas-1.md, "Para VISTA"):
// `slideKick` (capa de la corredera) y `reloadEmpty`. Sin ellos la pistola
// funciona con la recarga táctica y la corredera quieta.
import { contactos } from './contactos.js';
import { vesperReload } from './crashterra.js';
import { COMMON } from './common.js';

// La izquierda llega desde el cinturón, acompaña la pieza fuera del brocal
// y la asienta con la palma antes de bajar por el mismo lado.
const manoLibre = { ...contactos.pistol.carga.target, off: [-.28, -.66, .15] };
const left = [
  [0, 1, 0, 0, 0, 0, 0], [.08790, 0, 1, 0, 0, 0, 0], [.12, 0, 1, 0, 0, 0, 0], [.56, 0, 1, 0, 0, 0, 0],
  [.67, 0, 0, 0, 1, 0, 0], [.78, 0, 0, 0, 1, 0, 0], [.93, 1, 0, 0, 0, 0, 0],
];
const lOff = [
  [0, 0, 0, 0], [.08152, -.08883, -.09251, .00928], [.12, 0, -.00264, 0],
  [.22, 0, -.25, .025], [.29, -.09, -.30, .025], [.37, -.09, -.30, .025],
  [.46, 0, -.21, .021], [.55, 0, 0, 0], [.60, -.04, -.35, .03],
  [.65, -.02, -.30, .02], [.69, 0, -.12, 0], [.72, 0, -.010, 0], [.73, 0, -.002, 0], [.745, 0, -.002, 0], [.765, 0, -.002, 0], [.78, 0, -.012, 0], [.82, -.03, -.12, .02], [.93, 0, 0, 0],
];
const lCurl = [[0, 0, 0, 1, 0, 0], [.09, 0, 1, 0, 0, 0], [.56, 0, 1, 0, 0, 0], [.65, 0, 0, 1, 0, 0]];

// La ventana sube unos milímetros mientras el guante cruza el borde inferior.
const encuadreCarga = [[0, 0, 0, 0], [.10, 0, 0, 0], [.17, 0, .008, 0],
  [.44, 0, .008, 0], [.52, 0, 0, 0], [.65, 0, -.008, 0],
  [.78, 0, -.014, 0], [.91, 0, -.009, 0], [1, 0, 0, 0]];

const PISTOL = {
  model: 'pistol', scale: 0.41,
  // VESPER: misma orientación YXZ; posición trasladada al pivote de este GLB.
  encuadreRecarga: [.15, -.072, -.085],
  hip: { pos: [.1809, -.0902, -.5452], rot: [.0788, .2262, -.0125] },
  ads: { relief: .48, roll: .30 },
  adsTime: 0.16,
  sprint: { pos: [-0.03, -0.045, 0.03], rot: [-0.45, 0.36, 0.26] },
  crouch: { pos: [-0.005, -0.01, 0.006], rot: [0, 0.02, 0.04] },
  lower: { pos: [0.01, -0.1, 0.05], rot: [-0.6, 0.2, 0.2] },
  slide: { pos: [-0.015, -0.02, 0.02], rot: [-0.05, 0.06, 0.26] },
  wall: { pos: [-0.02, -0.06, 0.22], rot: [-0.7, 0.3, 0.1] },
  mass: 1.1,
  // chasquido: subida rápida de la boca, poco desplazamiento atrás
  recoil: { kick: 0.016, rise: 0.1, yaw: 0.012, roll: 0.035, ads: 0.6 },
  parts: { mag: 'mag', bolt: 'slide', trigger: 'trigger', boltAxis: [0, 0, 1], boltTravel: 0.09, triggerTravel: 0.32,
    magGuide: { extraccion: .055, axis: [0, -1, 0.10], clear: 0.20, blend: 0.06 } },
  // corredera: 25 ms atrás, 50 ms adelante; bloqueada atrás tras el último tiro
  // atrás en 2 cuadros, sujeta ≥ 2 cuadros, vuelve en ~4 (0.13 s; el intervalo de
  // tiro a 260 rpm es 0.23 s). VISTA, auditoría: a 0.025 s el primer tiro no llegaba al tope.
  slideKick: { back: 0.033, hold: 0.034, ret: 0.065, lockEmpty: true },
  targets: {
    grip: contactos.pistol.dominante.target,
    forend: manoLibre,
    // el cargador por la tapa
    mag: contactos.pistol.carga.target,
    // En este tramo la palma, ya abierta, da el golpe en la tapa insertada.
    bolt: { anchor: 'mag', axis: [.764353, -.201038, -.612657], palm: [.517373, .758283, .396652],
      off: [-.05734, .05185, .02491] },
    // portacargadores del cinturón, justo bajo el cuadro (la recarga es corta:
    // la mano no puede ir más lejos a ≤0.9 m/s)
    pouch: { cam: [0.02, -0.23, -0.34], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    wind: { cam: [-0.045, -0.12, -0.24], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    out: { cam: [0.09, -0.185, -0.38], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
  },
  grips: {
    right: { target: 'grip', pose: 'indexed' },
    left: { target: 'forend', pose: 'libre' },
    mag: { pose: 'pinch' },
  },

  // táctica (queda bala en la recámara): la corredera no se toca
  reload: {
    encuadre: encuadreCarga,
    steps: [{ t: 0.12, step: 'magOut' }, { t: 0.55, step: 'magIn' }, { t: 1, step: 'slideRelease' }],
    tail: 0.12,
    tracks: {
      gun: vesperReload,
      left, lOff, lCurl,
    },
  },
  // Vacía: la corredera queda bloqueada hasta el paso slideRelease.
  reloadEmpty: {
    encuadre: encuadreCarga,
    steps: [{ t: 0.12, step: 'magOut' }, { t: 0.55, step: 'magIn' }, { t: 1, step: 'slideRelease' }],
    tail: 0.14,
    tracks: {
      gun: vesperReload,
      left, lOff, lCurl,
    },
  },

  throw: {
    ...COMMON.throw,
    tracks: {
      ...COMMON.throw.tracks,
      gun: [
        [0, 0, 0, 0, 0, 0, 0],
        [0.2, 0.04593, -0.06665, 0.03409, 0.07582, -0.10468, 0.16478],
        [0.6, 0.05093, -0.08665, 0.04409, 0.02582, -0.13468, 0.12478],
        [0.8, 0.03643, -0.05803, 0.03241, -0.00834, -0.11217, 0.0334],
        [1, 0, 0, 0, 0, 0, 0],
      ],
    },
  },

};

export default { ...COMMON, ...PISTOL };
