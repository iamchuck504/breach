// PERFILES DEL ARMA EN PRIMERA PERSONA (CONTRATO §5). Solo datos.
//
// Espacio de cámara: x derecha, y arriba, -z delante, metros reales.
// Rotaciones: Euler YXZ en radianes (x = cabeceo, + boca arriba; y =
// guiñada, + boca a la izquierda; z = alabeo, + parte de arriba a la
// izquierda). Las posturas son DÓNDE va el ancla `grip` del arma (la
// empuñadura); el arma gira alrededor de ella.
//
// Esquema (común a todos los modelos):
//   model      nombre del GLB en public/assets/fp/ (scripts/build-viewmodel-art.mjs)
//   scale      tamaño del arma en el marco de las curvas. El montaje de
//              tercera persona convierte todo el conjunto a metros del soldado.
//   hip        { pos, rot } postura de cadera
//   ads        { relief, roll } — la postura ADS se DERIVA de sight_rear y
//              sight_front (anim.deriveAds): el alza queda en el eje óptico a
//              `relief` metros del ojo; nada de capturas
//   sprint / crouch / lower (trepar) / slide / wall: posturas ADITIVAS
//   mass       kg: rigidez y lentitud de los resortes (pesado = más lento y más inercia)
//   adsTime    segundos de entrada a ADS
//   recoil     { kick (m atrás), rise (rad), yaw (rad), roll (rad), ads (factor en ADS) }
//   parts      piezas móviles del GLB: { mag, bolt, trigger, boltAxis, boltTravel, triggerTravel, stockFold }
//              (stockFold: culata plegada en primera persona, m del modelo)
//   targets    marcos de mano: `anchor` (en el arma) o `cam` (en cámara);
//              `axis` = dirección meñique→índice, `palm` = normal exterior del dorso (+Y del guante)
//   grips      { right, left }: cada agarre declara su objetivo, pose y ángulos locales
//   reload     { steps: [{ t, step }], tracks } — t normalizado a reloadTime;
//              los pasos coinciden con las piezas de audio (src/fx/audio.js)
//   swap / melee / throw: líneas de tiempo (normalizadas a su duración real)
// Pistas: [[u, valores…], …], interpolación Catmull-Rom. Canales:
//   gun   [u, px, py, pz, rx, ry, rz]  (aditivo sobre la postura base)
//   left  [u, …pesos por LEFT_CHANNELS]
//   lOff  [u, dx, dy, dz] desplazamiento de la mano izq. en el marco del arma (m del modelo)
//   lCurl [u, …pesos por CURL_CHANNELS]
//   bolt  [u, recorrido 0..1]
//   nade  [u, visible 0..1]

//
// Este índice SOLO importa: cada arma está en profiles/<arma>.js y los datos
// comunes en profiles/common.js. Añadir un arma = una línea aquí.
export { LEFT_CHANNELS, CURL_CHANNELS, ARMS } from './profiles/common.js';
import { contactos } from './profiles/contactos.js';
import { brazal } from './profiles/robot.js';
import smg from './profiles/smg.js';
import shotgun from './profiles/shotgun.js';
import pistol from './profiles/pistol.js';
import sniper from './profiles/sniper.js';
import bazooka from './profiles/bazooka.js';
import grenade from './profiles/grenade.js';

// La frag y la aturdidora tienen GLB propios y comparten pistas con sus familias.
const frag = {
  ...grenade, model: 'frag',
  // El relieve del bote sobresale junto al pasador. La muñeca lo rodea
  // antes de que el índice y el pulgar se cierren sobre la anilla.
  parts: {
    ...grenade.parts,
    anilla: [[-.132, 0, -.12, -.12, 0, -.015], grenade.parts.anilla[1]],
  },
  ads: { relief: 0.26, roll: 0.5 },
  hip: { pos: [.15125, -.10114, -.49181], rot: [.24375, -.41795, .17381] },
  throw: {
    ...grenade.throw,
    tracks: {
      ...grenade.throw.tracks,
      gun: [
        [0, 0, 0, 0, 0, 0, 0],
        [0.12, 0.00467, 0.00467, 0.038, 0.115, -0.06667, 0.03],
        [0.26, 0.019, 0.02, 0.074, 0.19, -0.105, 0.05],
        [0.42, 0.019, 0.02, 0.074, 0.19, -0.105, 0.05],
        [0.56, -0.00351, 0.01321, -0.008, -0.08, 0.05151, -0.05],
        [0.69, -0.012, -0.035, 0.012, -0.2, 0.08, -0.07],
        [0.8, -0.004, -0.082, 0.045, -0.32, 0.05, -0.04],
        [1, 0, -0.06, 0.032, -0.16, 0, 0],
      ],
    },
  },
  targets: {
    ...grenade.targets,
    grip: contactos.frag.dominante.target,
    bolt: contactos.frag.anilla.target,
  },
  tint: { graphite: [0.055, 0.068, 0.039], 'acero pavonado': [0.21, 0.245, 0.12], 'painted red': [0.36, 0.39, 0.16], led: [0.8, 0.42, 0.10, 0.8] },
};
const stun = { ...pistol, model: 'stun',
  encuadreRecarga: [.15, -.073, -.098],
  // La celda es más corta y puede salir desde abajo sin elevar el arma.
  reload: { ...pistol.reload, encuadre: [[0, 0, 0, 0], [.50, 0, 0, 0],
    ...pistol.reload.encuadre.filter(([fase]) => fase >= .65)] },
  parts: { ...pistol.parts, magGuide: { ...pistol.parts.magGuide, extraccion: .087 } },
  ejectOn: 'none', tint: { 'painted red': [0.05, 0.30, 0.38, 0], led: [0.10, 0.66, 0.79, 0.85] } };

export const PROFILES = {
  smg,
  shotgun,
  pistol,
  sniper,
  bazooka,
  grenade,
  frag,
  stun,
};

// El gancho de la izquierda recibe la pieza móvil de cada arma larga.
const montajes = {
  shotgun: [2.65, 1.6], sniper: [2.65, 1.6], bazooka: [2.55, 1.55],
  pistol: [1.504691, 1.83], stun: [1.45, 1.76349], grenade: [1.25, 1.85], frag: [1.25, 1.85],
};
// Escala uniforme de la fundición, medida en el borde inferior a 1280 × 720.
const apoyoCorto = { sleeveScale: .76, desenrollar: 0.011921, extension: .015, salida: [-.135, -.100, -.19], twist: .93785, elbowDirection: [-.67236, -.68968, .53281] };
const dominanteCorta = { sleeveScale: .865, twist: -.75599, elbowDirection: [.12, -.48, .9] };
const mangas = {
  pistol: [apoyoCorto, dominanteCorta],
  stun: [{ ...apoyoCorto, sleeveScale: .734, desenrollar: .001, apertura: .36,
    extension: .241303, salida: [-.155, -.03, -.19] }, { ...dominanteCorta, sleeveScale: .834 }],
  bazooka: [{ sleeveScale: 1.145, salida: [.0415, -.2455, .017], desenrollar: .033, extension: .0245, twist: 1.02848, elbowDirection: [.02399, -.21017, .97737] }],
  sniper: [{ sleeveScale: 1.236, desenrollar: 0.001000, apertura: 0.202206, extension: 0.976227, twist: 1.30348 }, { sleeveScale: .75, asiento: [.008, -.001, .008] }],
  shotgun: [{ sleeveScale: 1.196, extension: 0.708, salida: [-.066, -.2035, .051], elbowDirection: [-0.4297, -0.2331, 0.8724] }, { direccionAlApuntar: [1, -1, 1] }],
  grenade: [undefined, { sleeveScale: 1.86, twist: -1.93473 }],
  frag: [undefined, { sleeveScale: 1.53, elbowDirection: [.48, -.24375, .38] }],
};
for (const [key, [izquierda, derecha]] of Object.entries(montajes)) {
  const p = PROFILES[key];
  p.supportArm = brazal('L', izquierda, mangas[key]?.[0]);
  p.triggerArm = brazal('R', derecha, mangas[key]?.[1]);
}
smg.triggerArm = brazal('R', 1, { direccionAlApuntar: [1, -1, 1] });

export const hasProfile = (key) => Object.prototype.hasOwnProperty.call(PROFILES, key);
