import { equipPose } from './crashterra.js';

// Datos compartidos por todas las armas: canales de la mano izquierda,
// perfiles de dedos, escala de brazos y gestos comunes (cambio, golpe,
// lanzamiento). Lo edita VISTA (brazos); cada arma vive en su propio archivo.
export const LEFT_CHANNELS = ['forend', 'mag', 'pouch', 'bolt', 'wind', 'out'];
export const CURL_CHANNELS = ['support', 'pinch', 'open', 'rack', 'fist'];
// Medidas del arte del soldado en primera persona.
export const ARMS = {

  elbows: { R: [0.34, -0.62, -0.12], L: [-0.30, -0.62, -0.40] },
  // giro del antebrazo sobre su eje: la placa del brazal (color de equipo) hacia la cámara
  twist: { R: 0, L: Math.PI },
};

// Gestos comunes (todas las armas largas); cada perfil puede sobrescribirlos.
export const COMMON = {

  swap: {
    // 0..0.5 se guarda (a la mitad cambia el modelo), 0.5..1 se saca
    tracks: {
      gun: equipPose,
    },
  },
  // Las manos mantienen el agarre mientras el arma se aparta de la pierna.
  melee: { tracks: {} },
  throw: {
    // la mano izquierda suelta el guardamanos, coge el bote, carga y lanza;
    // el arma baja a la derecha. `release` = fracción real de la suelta.
    tracks: {
      gun: [
        [0, 0, 0, 0, 0, 0, 0], [0.2, 0.035, -0.07, 0.03, -0.25, -0.22, -0.3], [0.6, 0.04, -0.09, 0.04, -0.3, -0.25, -0.34],
        [0.8, 0.03, -0.06, 0.03, -0.2, -0.18, -0.24], [1, 0, 0, 0, 0, 0, 0],
      ],
      //       forend mag pouch bolt wind out
      left: [
        [0, 1, 0, 0, 0, 0, 0], [0.16, 0, 0, 1, 0, 0, 0], [0.24, 0, 0, 1, 0, 0, 0], [0.5, 0, 0, 0, 0, 1, 0],
        [0.6, 0, 0, 0, 0, 1, 0], [0.7, 0, 0, 0, 0, 0, 1], [0.78, 0.22, 0, 0, 0, 0, 0.78], [0.89, 0.76, 0, 0, 0, 0, 0.24], [0.96, 0.974, 0, 0, 0, 0, 0.026], [1, 1, 0, 0, 0, 0, 0],
      ],
      lCurl: [[0, 1, 0, 0, 0, 0], [0.14, 0, 0, 1, 0, 0], [0.22, 0, 0, 0, 0, 1], [0.69, 0, 0, 0, 0, 1], [0.74, 0, 0, 1, 0, 0], [1, 1, 0, 0, 0, 0]],
      nade: [[0, 0], [0.2, 0], [0.21, 1], [0.69, 1], [0.7, 0], [1, 0]],
    },
    // la suelta de la pista ("out") está en 0.7: se reescala a la real
    releaseAt: 0.7,
  },
};
