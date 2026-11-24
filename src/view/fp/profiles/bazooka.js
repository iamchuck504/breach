// BAZUCA — perfil del arma en primera persona. Esquema y unidades en
// src/view/fp/profiles.js; guía en src/view/fp/README.md.
//
// Identidad: tubo pesado AL HOMBRO DERECHO. En cadera el tubo descansa en el
// hombro con la boca adelante; en ADS el ojo entra en la mira réflex (marco
// hueco con punto de LED, construido en scripts/viewmodel-art/bazooka.mjs).
// El cohete NO sale de aquí: nace delante del ojo por el rayo central
// (fpCam.launchPoint, CONTRATO §3); el fogonazo sale de la boca del tubo y el
// rebufo de la cola (ancla `backblast`).
// Lógica real (tuning.js): cargador de 1, recarga 2.3 s (auto tras el tiro):
//   rocketIn 0.25 (tube_slide del audio) · tubeLock 1 (tube_lock).
// La ojiva visible en la boca es la pieza `mag`: se va con el disparo; la
// mano izquierda trae otra del portacohetes y la mete en la boca.
import { contactos } from './contactos.js';
import { launcherReload } from './crashterra.js';
import { COMMON } from './common.js';

const BAZOOKA = {
  model: 'bazooka', scale: 0.42,
  // VULCAN: encuadre en YXZ; posición trasladada al pivote de este GLB.
  arcoLanzamiento: [
    [0.0075, 0, 0, 0, 0, 0],
    [0.12, -0.12, 0.12, -0.135, -0.0675, 0.0075],
  ],
  despeje: {
    recarga: [-0.063, -0.045, -0.13, -0.02, 0.12, 0.195],
    lanzamiento: [0.1265, -0.1935, 0.16, -0.1695, -0.0035, -0.0035],
    transporte: [-.2, -.008, -.1065, 0, 0, 0],
  },
  encuadreRecarga: [.085, .090, -.19],
  hip: { pos: [0.1419996, -0.2011778, -0.3952617], rot: [0.10929, 0.0888185, -0.0086176] },
  // Presenta el lateral del brazal desde el borde inferior.
  elbowL: [-0.269, -0.473, -0.464],
  ads: { relief: 0.27, roll: 0 },
  adsTime: 0.36,
  // sprint: el tubo se baja y cruza por delante (va al costado)
  sprint: { pos: [-0.04, -0.02, 0.0], rot: [-0.2, 0.35, 0.2] },
  crouch: { pos: [-0.006, -0.01, 0.006], rot: [0, 0.015, 0.03] },
  lower: { pos: [0.02, -0.12, 0.05], rot: [-0.5, 0.2, 0.2] },
  slide: { pos: [-0.02, -0.03, 0.02], rot: [-0.05, 0.08, 0.22] },
  wall: { pos: [-0.01, -0.06, 0.18], rot: [-0.6, 0.3, 0.1] },
  mass: 9,
  // golpe seco hacia atrás y la boca sube; vuelve muy lento
  recoil: { kick: 0.045, rise: 0.13, yaw: 0.008, roll: 0.02, ads: 0.7 },
  // la ojiva (`mag`) se va con el disparo, aparece en la mano izquierda al
  // empezar la recarga (la mano está bajo el cuadro) y entra en rocketIn
  parts: { giroCartuchera: -1.10, presentacion: [0, -.045, .015], mag: 'mag', trigger: 'trigger', triggerTravel: 0.3,
    anim: { cap: { track: 'cap', rot: [0, 0, 0.48] } },
    magEvents: { hideOn: 'fire', out: 'reloadStart', in: 'rocketIn', recogida: .18 } },
  targets: {
    // empuñadura trasera (como una pistola)
    grip: contactos.bazooka.dominante.target,
    // Palma bajo el apoyo delantero del tubo.
    forend: contactos.bazooka.apoyo.target,
    // "mag" = la ojiva en la boca: la palma la empuja hacia dentro
    mag: contactos.bazooka.carga.target,
    // cohete de repuesto en el portacohetes del pecho, justo bajo el cuadro
    // (cerca: la mano izq. va a ≤0.9 m/s y el cohete entra a 0.58 s)
    pouch: { cam: [-0.060, -0.19, -0.42], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    // palanca de bloqueo: la mano golpea el tubo encima de la empuñadura delantera
    bolt: { anchor: 'forend', axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50], off: [0, 0.155, 0.085] },
    wind: { cam: [-0.045, -0.12, -0.24], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    out: { cam: [0.18, -0.17, -0.67], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
  },
  grips: {
    right: { target: 'grip', pose: 'indexed' },
    left: { target: 'forend', pose: 'cup' },
    mag: { pose: 'pinch' },
  },
  throw: {
    ...COMMON.throw,
    tracks: {
      ...COMMON.throw.tracks,
      // Tras soltar el bote, el pulgar rodea el tubo antes de volver al apoyo.
      left: [
        ...COMMON.throw.tracks.left.filter(([t]) => t <= .7),
        [.7995, .152, 0, 0, 0, 0, .848], [.8745, .692, 0, 0, 0, 0, .308],
        [.892, .906, 0, 0, 0, 0, .094], [1, 1, 0, 0, 0, 0, 0],
      ],
    },
  },
  reload: {
    steps: [{ t: 0.25, step: 'rocketIn' }, { t: 1, step: 'tubeLock' }],
    tail: 0.14,
    tracks: {
      // El collar gira al abrir la recarga y vuelve a su marca con el cierre.
      cap: [[0, 0], [0.12, 1], [0.9, 1], [1, 0], [1.14, 0]],
      gun: launcherReload,
      // La cartuchera queda bajo la boca. La misma pinza acompaña la
      // ojiva por el costado del tubo hasta que se apoya en el collar.
      left: [
        [0, 1, 0, 0, 0, 0, 0], [.13, 0, 0, 1, 0, 0, 0],
        [.32, 0, 0, 1, 0, 0, 0], [.54, 0, 1, 0, 0, 0, 0],
        [.70, 0, 1, 0, 0, 0, 0], [.98, 1, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0],
      ],
      lOff: [
        [0, 0, 0, 0], [.21, -.08, -.02, -.10], [.40, -.30, .035, -.25],
        // Antes de asentar la ojiva, la muñeca presenta la pinza por
        // debajo del brocal y acompaña el último tramo en el eje del tubo.
        [.53, -.14, .02, -.20], [.57, -.045, -.035, -.15],
        [.60, 0, 0, -.10], [.65, .03, -.03, -.03],
        [.70, .03, -.03, -.03], [1, 0, 0, 0],
      ],
      mag: [[0, 1], [.62, 1], [.67, 0], [1, 0]],
      lCurl: [
        [0, 1, 0, 0, 0, 0], [.10, 0, 0, 1, 0, 0], [.18, 0, 1, 0, 0, 0],
        [.54, 0, 1, 0, 0, 0], [.62, 0, 0, 1, 0, 0], [.98, 1, 0, 0, 0, 0],
      ],
    },
  },
};

export default { ...COMMON, ...BAZOOKA };
