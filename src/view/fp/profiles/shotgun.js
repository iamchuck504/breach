// ESCOPETA — perfil del arma en primera persona. Esquema en src/view/fp/profiles.js
// y src/view/fp/README.md. Arma larga y pesada de corredera: patada fuerte,
// vuelta lenta, bombeo tras cada tiro y recarga cartucho a cartucho.
//
// Lógica real (src/combat/weapons.js): 95 RPM (0.63 s entre tiros); recarga
// `perShell` de 0.46 s por cartucho, `reloadStep 'shellIn'` al final de cada
// ciclo y `pump` + `reloadEnd` tras el último. La munición la cambia la lógica.
//
// Campos nuevos que pide este perfil al código compartido (ganchos/armas-1.md,
// "Para VISTA"): `cycle` (bombeo tras el tiro), `reload.perShell` (bucle por
// cartucho + bombeo final) y la pista `mag` (el cartucho de la mano). Sin
// ellos el arma sigue funcionando con `reload.tracks` (un solo cartucho).
import { contactos } from './contactos.js';
import { reaperCycle, reaperPump, reaperTravel, reaperShellHand, pasoDeMuneca } from './crashterra.js';
import { COMMON } from './common.js';

// recorrido de la corredera (m del modelo, hacia +z: atrás, hasta el cajón)
const PUMP = 0.072 / 0.33;

// Tras el primer cartucho la mano trabaja respecto a la ventana de carga.
// La bajada a buscar otro cartucho está en reaperTravel.
const LOOP_LEFT = reaperShellHand(false);
// desplazamiento de la mano (m del modelo, marco del arma): en el
// portacartuchos 0; bajo la ventana, abajo; al empujar sube
const LOOP_LOFF = reaperTravel(.58);
//       support pinch open rack fist
const LOOP_CURL = [
  [0, 0, 1, 0, 0, 0], [0.06, 0, 0.4, 0.6, 0, 0], [0.16, 0, 0, 1, 0, 0], [0.32, 0, 0.2, 0.8, 0, 0], [0.37, 0, 1, 0, 0, 0],
  [0.9, 0, 1, 0, 0, 0], [0.97, 0, 0.6, 0.4, 0, 0], [1, 0, 1, 0, 0, 0],
];
// cartucho en la mano: aparece al cerrar los dedos sobre el del portacartuchos
// (coinciden: parece que sale de él) y entra al final
const LOOP_MAG = [[0, 0], [0.355, 0], [0.365, 1], [0.8, 1], [0.985, 0], [1, 0]];
// el PRIMER cartucho: la mano sale de la corredera (más lejos) y gira la
// muñeca; coge más tarde. Termina igual que LOOP (u = 1 ≡ u = 0 del bucle).
const FIRST = {
  left: reaperShellHand(true),
  lOff: LOOP_LOFF,
  lCurl: [[0, 0, 0, 1, 0, 0], [0.42, 0, 0.2, 0.8, 0, 0], [0.49, 0, 1, 0, 0, 0], [0.9, 0, 1, 0, 0, 0], [0.97, 0, 0.6, 0.4, 0, 0], [1, 0, 1, 0, 0, 0]],
  mag: [[0, 0], [0.485, 0], [0.495, 1], [0.82, 1], [0.985, 0], [1, 0]],
};
// empujón del cartucho: el arma cede un poco
const LOOP_GUN = [
  [0, 0, 0, 0, 0, 0, 0], [0.4, 0, -0.002, 0, -0.01, 0, 0.01], [0.86, 0, 0.003, 0, 0.012, 0, -0.01],
  [0.95, 0, 0.007, -0.002, 0.03, 0, -0.02], [1, 0, 0, 0, 0, 0, 0],
];
// postura de recarga: el arma sube algo, se acerca y gira enseñando la
// ventana de carga (por debajo) a la cámara
const HOLD = { pos: [0.012, 0.002, -0.02], rot: [0.035, -0.05, -0.26] };
// --- bombeo final (u = 0..1 sobre outro.dur) ---
const OUTRO_BOLT = [[0, 0], [0.38, 0], [0.52, 1], [0.6, 1], [0.76, 0.02], [0.82, 0], [1, 0]];

// El cartucho gira sobre su eje Z entre el portacartuchos y la ventana.
const insercion = contactos.shotgun.carga.target;
const giroCartucho = -56 * Math.PI / 180;
function girarCartucho([x, y, z]) {
  const c = Math.cos(giroCartucho), s = Math.sin(giroCartucho);
  return [c*x - s*y, s*x + c*y, z];
}
const recogida = girarCartucho(insercion.off);
recogida[0] -= .022;
recogida[1] -= .008;

// El cartucho acompaña la izquierda por debajo de los nudillos derechos.
const entradaCartucho = [
  [0.41, 0, 0, 0],
  [0.54, -2.3002, 1.6004, 1.0714],
  [0.81, -2.3002, 1.6004, 1.0714],
  [0.94, 0, 0, 0]
];
// El primer cartucho sale de la bomba y los siguientes del portacartuchos.
const salidaBomba = pasoDeMuneca([
  [0, 0, 0, 0],
  [0.05984927, 20.086917, -273.974372, -19.39194],
  [0.08792767, 20.086917, -273.974372, -19.39194],
  [0.12018745, 0, 0, 0],
  ...entradaCartucho,
]);
const salidaCartuchera = pasoDeMuneca([
  [0, 0, 0, 0],
  [0.02, 0.0973, -1.1092, 2.7857],
  [0.07, 0.0973, -1.1092, 2.7857],
  [0.13, 0, 0, 0],
  ...entradaCartucho,
]);

const SHOTGUN = {
  model: 'shotgun', scale: 0.33,
  // REAPER: encuadre en YXZ; posición trasladada al pivote de este GLB.
  apoyoLanzamiento: { out: [-.125, -.195, -.53] },
  arcoLanzamiento: [
    [0, 0, 0, 0, 0, 0],
    [0.06, -0.0375, 0.165, 0.3075, -0.18, 0.135],
  ],
  despeje: {
    recarga: [0.01, 0, 0.0145, 0, 0, 0],
    lanzamiento: [0.259, -0.018, -0.314, 0.09, 0.042, -0.042],
  },
  encuadreRecarga: [.056, .029, -.095],
  hip: { pos: [0.1515773, -0.1880063, -0.3417857], rot: [0.1015538, 0.3163301, -0.1117382] },
  // La palma sostiene la bomba por debajo. El giro deja la placa del brazal hacia la cámara.

  ads: { relief: 0.27, roll: 0 },
  adsTime: 0.27,
  sprint: { pos: [-0.02, -0.03, 0.05], rot: [-0.32, 0.4, 0.36] },
  crouch: { pos: [-0.006, -0.012, 0.008], rot: [0, 0.02, 0.05] },
  lower: { pos: [0.02, -0.1, 0.05], rot: [-0.55, 0.24, 0.22] },
  slide: { pos: [-0.02, -0.02, 0.02], rot: [-0.05, 0.08, 0.32] },
  wall: { pos: [-0.01, -0.06, 0.15], rot: [-0.6, 0.34, 0.12] },
  mass: 3.6,
  // patada fuerte: atrás y boca arriba; vuelve despacio (masa)
  recoil: { kick: 0.036, rise: 0.13, yaw: 0.018, roll: 0.05, ads: 0.62 },
  // La culata se recoge bajo la mejilla al entrar en la mira.
  parts: { presentacion: [0.025, -0.12, -0.169], mag: 'mag', bolt: 'pump', trigger: 'trigger', boltAxis: [0, 0, 1], boltTravel: PUMP, triggerTravel: 0.32, stockRise: 0.12, stockTuckADS: true },
  targets: {
    grip: contactos.shotgun.dominante.target,
    // la corredera desde abajo y la izquierda: el pulgar y el talón de la mano
    // se ven desde el ojo
    forend: contactos.shotgun.apoyo.target,
    // el cartucho en los dedos (centro del puño = centro del cartucho en su
    // reposo); la pista lOff mantiene la mano bajo la ventana
    mag: contactos.shotgun.carga.target,
    pouch: { anchor: 'saddle', axis: girarCartucho(insercion.axis), palm: girarCartucho(insercion.palm), off: recogida },
    bolt: { anchor: 'pump', axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50], off: [-0.0294, -0.0067, -0.0163] },
    wind: { cam: [-0.045, -0.12, -0.24], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
    out: { cam: [0.12, -0.145, -0.51], axis: [0.69, -0.23, 0.69], palm: [-0.22, 0.84, 0.50] },
  },
  grips: {
    right: { target: 'grip', pose: 'indexed' },
    left: { target: 'forend', pose: 'cup' },
    mag: { pose: 'pinch' },
  },

  // bombeo tras cada tiro: empieza cuando la boca ya subió (0.1 s) y acaba
  // antes del siguiente tiro posible (0.63 s)
  cycle: {
    delay: 0.1, dur: 0.44, block: 0,
    events: [{ u: 0.4, name: 'eject' }],
    tracks: {
      bolt: reaperPump,
      gun: reaperCycle,
    },
  },

  reload: {
    // pasos para el banco/pruebas genéricas (la lógica emite shellIn por cartucho)
    steps: [{ t: 1, step: 'shellIn' }],
    tail: 0.1,
    // respaldo sin `perShell` (código compartido de hoy): un cartucho con la postura incluida
    tracks: {
      gun: LOOP_GUN.map(([u, ...v]) => [u, v[0] + HOLD.pos[0], v[1] + HOLD.pos[1], v[2] + HOLD.pos[2], v[3] + HOLD.rot[0], v[4] + HOLD.rot[1], v[5] + HOLD.rot[2]])
        .concat([[1.1, 0, 0, 0, 0, 0, 0]]),
      left: FIRST.left,
      lOff: LOOP_LOFF,
      lCurl: LOOP_CURL.concat([[1.1, 1, 0, 0, 0, 0]]),
    },
    perShell: {
      hold: HOLD,
      first: { tracks: { gun: LOOP_GUN, ...FIRST, pasoMuneca: salidaBomba } },
      loop: { tracks: { pasoMuneca: salidaCartuchera, gun: LOOP_GUN, left: LOOP_LEFT, lOff: reaperTravel(.58, 1.178 / .695), lCurl: LOOP_CURL, mag: LOOP_MAG } },
      // bombeo final: la mano vuelve a la corredera mientras el arma se
      // endereza, y bombea con el arma ya casi en su sitio
      outro: {
        dur: 0.62,
        events: [{ u: 0.55, name: 'eject' }],
        tracks: {
          hold: [[0, 1], [0.15, 1], [0.5, 0.25], [0.8, 0], [1, 0]],
          left: [[0, 0, 1, 0, 0, 0, 0], [0.08, 0, 1, 0, 0, 0, 0], [0.43, 1, 0, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0, 0]],
          lCurl: [[0, 0, 1, 0, 0, 0], [0.1, 0, 0.5, 0.5, 0, 0], [0.28, 1, 0, 0, 0, 0], [1, 1, 0, 0, 0, 0]],
          lOff: [[0, 0, -0.05, 0], [0.1, 0, -0.06, 0], [0.18, 0, 0, 0], [1, 0, 0, 0]],
          pasoMuneca: pasoDeMuneca([
            [0.3, 0, 0, 0],
            [0.36, 17.55, -7.15, -7.15],
            [0.43, 0, -3, -3],
            [0.52, 0, 0, 0]
          ]),
          bolt: OUTRO_BOLT,
          mag: [[0, 0], [1, 0]],
          gun: [
            [0, 0, 0, 0, 0, 0, 0], [0.38, 0.04, -0.03, 0, 0, 0, 0], [0.52, 0.036, -0.04, 0.014, -0.04, 0.03, 0.05],
            [0.6, 0.036, -0.04, 0.014, -0.035, 0.03, 0.05], [0.78, 0.0298, -0.0169, -0.006, 0.03, -0.01, -0.02],
            [0.9, 0.0055, -0.0041, 0, 0.005, 0, 0], [1, 0, 0, 0, 0, 0, 0],
          ],
        },
      },
    },
  },

  throw: {
    ...COMMON.throw,
    tracks: {
      ...COMMON.throw.tracks,
      pasoMuneca: pasoDeMuneca([
        [0, 0, 0, 0],
        [0.02, 1.905, -13.6555, -11.5714],
        [0.07, 1.905, -13.6555, -11.5714],
        [0.15, 0, 0, 0]
      ]),
      gun: [
        [0, 0, 0, 0, 0, 0, 0],
        [0.2, 0.02399, -0.06559, 0.01555, -0.25397, -0.14961, -0.19585],
        [0.6, 0.02899, -0.08559, 0.02555, -0.30397, -0.17961, -0.23585],
        [0.8, 0.02352, -0.05741, 0.0215, -0.20233, -0.13859, -0.17873],
        [1, 0, 0, 0, 0, 0, 0],
      ],
    },
  },

};

export default { ...COMMON, ...SHOTGUN };
