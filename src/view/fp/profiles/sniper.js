// FRANCOTIRADOR — perfil del arma en primera persona. Esquema y unidades en
// src/view/fp/profiles.js; guía en src/view/fp/README.md.
//
// Identidad: rifle largo y pesado de cerrojo. La palanca va a la IZQUIERDA
// del cajón (arte original): la derecha alcanza el pomo mientras la izquierda sostiene el guardamanos.
// Lógica real (src/config/tuning.js): cargador de 1, recarga 1.7 s que
// arranca sola tras cada tiro → la "recarga" ES el ciclo del cerrojo:
//   boltOpen 0.08 (bolt_open del audio) · roundIn 0.5 (round_in) · boltClose 1 (bolt_close).
// La munición la cambia la lógica; aquí solo se mueven piezas y manos.
//
// ADS = el ocular al ojo: `relief` muy corto para que la lente del ocular
// (construida en scripts/viewmodel-art/sniper.mjs) crezca hasta el tamaño
// del anillo de #sniper-scope (43 vmin de radio): el relevo al scope de la
// interfaz no salta (ver run6/ganchos/armas-2.md, "relevo al scope").
import { contactos } from './contactos.js';
import { sniperReload } from './crashterra.js';
import { COMMON } from './common.js';

// La palanca y el carro se detienen en sus topes mientras entra la munición.
function recorridoCerrojo(inicio, abierto, cierre, fin) {
  const tramo = t => {
    const v = Math.max(0, Math.min(1, t));
    return v*v*(3 - 2*v);
  };
  return (u, out) => {
    out[0] = tramo((u-inicio)/(abierto-inicio)) * (1-tramo((u-cierre)/(fin-cierre)));
    return out;
  };
}

const SNIPER = {
  model: 'sniper', scale: 0.31,
  // VULCAN: encuadre en YXZ; posición trasladada al pivote de este GLB.
  // La mano suelta el bote a la izquierda de la boca y regresa por debajo del guardamanos.
  apoyoLanzamiento: { wind: [-.14713, -.19077, -.35346], out: [-.030712, -.193119, -.435120], pouch: [-.105008, -.285004, -.319993] },
  arcoLanzamiento: [
    [.1196065, .1197446, .0003511, .1575, 0.1125, -0.0975],
    [.0806741, -.0396971, .0899548, -.0720625, .0462878, 0],
  ],
  despeje: { lanzamiento: [0.782584, -0.502994, 0.00459, 0.058234, -0.462785, 0.856535] },
  encuadreRecarga: [.055, .035, -.14],
  hip: { pos: [0.1414434, -0.1764921, -0.3188012], rot: [0.0681559, 0.1140564, -0.0961141] },
  elbowL: [-0.139458, -0.234195, -0.382177],
  ads: { relief: 0.11000, roll: 0 },
  adsTime: 0.32,
  sprint: { pos: [-0.05, -0.015, 0.02], rot: [-0.24, 0.55, 0.3] },
  crouch: { pos: [-0.008, -0.012, 0.01], rot: [0, 0.02, 0.05] },
  lower: { pos: [0.02, -0.11, 0.05], rot: [-0.55, 0.25, 0.25] },
  slide: { pos: [-0.02, -0.03, 0.02], rot: [-0.06, 0.1, 0.3] },
  // pared: un rifle largo se recoge mucho y sube la boca
  wall: { pos: [-0.02, -0.07, 0.21], rot: [-0.7, 0.36, 0.15] },
  mass: 6.5,
  // golpe pesado: la culata empuja y la boca sube; vuelve lento (masa)
  recoil: { kick: 0.032, rise: 0.11, yaw: 0.012, roll: 0.035, ads: 0.55 },
  // En primera persona se acorta el giro de la palanca para mantener el antebrazo
  // bajo el visor. El recorrido longitudinal del cerrojo sigue siendo de 0,12 m.
  parts: { mag: 'mag', bolt: 'bolt', trigger: 'trigger', pasoCerrojo: [.2205, .014, .014], arcoCerrojo: [-.5415, -.1335, .1445, -.288, .0625, -.3785], boltPivot: [0, .077, .15], boltAxis: [0, 0, 1], boltTravel: 0.12, triggerTravel: 0.28,
    anim: { bolt: { track: 'boltLift', rot: [0, 0, -1], giroFP: -.12 } } },
  scopeRadius: .056,
  scope: true, // relevo al scope de la interfaz (vm.scopeIn01)
  targets: {
    // empuñadura de pistola con estrías
    grip: contactos.sniper.dominante.target,
    // apoyo: la palma bajo el guardamanos, el pulgar por la izquierda
    forend: contactos.sniper.apoyo.target,
    // "mag" = ventana del cajón: el pulgar empuja el cartucho (roundIn)
    mag: contactos.sniper.carga.target,
    // el pomo del cerrojo, desde la izquierda
    bolt: contactos.sniper.cerrojo.target,
    // cartuchos en la cartuchera del costado: cerca (el ciclo es corto)
    pouch: { cam: [-0.14, -0.36, -0.33], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    wind: { cam: [-0.045, -0.12, -0.24], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    out: { cam: [0.12, -0.10, -0.61], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
  },
  grips: {
    right: { target: 'grip', pose: 'indexed' },
    left: { target: 'forend', pose: 'cup' },
    mag: { pose: 'pinch' },
  },
  reload: {
    steps: [{ t: 0.08, step: 'boltOpen' }, { t: 0.5, step: 'roundIn' }, { t: 1, step: 'boltClose' }],
    tail: 0.16,
    // Al rodear la culata se adelanta el conjunto para que el ojo conserve
    // tanto el pomo como el extremo visible de la manga.
    encuadre: [
      [0, .024, -.004, .040], [.046, .002, -.008, -.078],
      [.080, .003, -.008, -.065], [.12, .022, -.010, -.004], [.14, .015, -.018, .004],
      [.17, 0, 0, 0], [.78, 0, 0, 0], [.86, -.005, 0, -.016],
      [.925, 0, .004, -.012], [.98, .014, -.006, .022], [1, .014, -.006, .022],
    ],
    tracks: {
      // El giro deja el pomo a la vista por debajo del ocular.
      gun: sniperReload,
      // La izquierda permanece bajo el guardamanos. La pista independiente
      // de la derecha sincroniza la pinza con la apertura y el cierre.
      // cerrojo: levantar y atrás en boltOpen (0.08); adelante y bajar en boltClose (1)
      boltHand: recorridoCerrojo(0, .25, .72, 1),
      boltLift: recorridoCerrojo(.25, .30, .68, .72),
      bolt: recorridoCerrojo(.30, .35, .63, .68),
    },
  },

  throw: {
    ...COMMON.throw,
    tracks: {
      ...COMMON.throw.tracks,
      gun: [
        [0, 0, 0, 0, 0, 0, 0],
        [0.2, 0.03487, -0.06957, 0.03075, -0.17, -0.13, -0.14],
        [0.6, 0.03987, -0.08957, 0.04075, -0.20, -0.14, -0.16],
        [0.8, 0.02992, -0.05974, 0.03044, -0.14, -0.11, -0.12],
        [1, 0, 0, 0, 0, 0, 0],
      ],
    },
  },

};

export default { ...COMMON, ...SNIPER };
