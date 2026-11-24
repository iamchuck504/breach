import { Euler, MathUtils, Quaternion } from 'three';

// Del apoyo a la mano abierta y de ahí a la pinza. El exponente
// escalona los dedos vecinos. El giro local del metacarpiano alcanza
// su máximo a mitad del arco y desaparece en ambos contactos.
const pistola = {
  cerrar: { ring: [.8, 63, -15, 39] },
};
export const giroCerrojo = { index: [1, 0, 32], ring: [1, 52] };
export const transiciones = {
  smg: {
    abrir: {
      middle: [1.002148, 0.003153, 0.065364, -0.022068],
      ring: [0.998871, 52.00667, -0.041548, 0.048567],
      pinky: [2.2, -32.0],
    },
    cerrar: { index: [1, -16] },
  },
  pistol: pistola,
  stun: pistola,
  shotgun: { abrir: {
    index: [1.370383, 8.270075, 13.332347, 19.548878],
    middle: [4.42349, -3.012487, -16.190381, -11.91445],
    ring: [2.291662, 61.982688, 1.280814, 8.534192],
    pinky: [3.558128, -30.462612, 20.113864, -9.464234],
    thumb: [0.97896, -4.224467, -1.837437, 11.661355],
  } },
  sniper: { abrir: {
    index: [1.078202, 21.932768, -2.621863, 22.92429],
    middle: [1.452851, 7.308358, 11.652625, -17.664603],
    ring: [1.252421, 18.385076, -11.077675, -17.320626],
    pinky: [1, 0, 0, 0],
    thumb: [1, 0, 0, 0],
  } },
  bazooka: { abrir: { pinky: [2.2, -72, 4] } },
};

const arco = new Quaternion(), giro = new Euler();

export function faseDeLosDedos(retiro, abierta, pinza) {
  const despegue = .4 * retiro;
  const libre = pinza < 1 ? abierta / (1 - pinza) * (1 - retiro) : 0;
  return MathUtils.lerp(.5 * MathUtils.lerp(despegue, 1, libre), 1, pinza);
}

export function recorrerFalange(q, desde, hasta, u, ajuste, metacarpiano) {
  const avance = ajuste ? u ** ajuste[0] : u;
  q.copy(desde).slerp(hasta, avance);
  if (metacarpiano && ajuste?.length > 1 && avance > 0 && avance < 1) {
    const peso = Math.sin(Math.PI * avance) * MathUtils.DEG2RAD;
    giro.set(peso * ajuste[1], peso * (ajuste[2] ?? 0), peso * (ajuste[3] ?? 0));
    q.multiply(arco.setFromEuler(giro));
  }
}

// Al salir del puño, cada nudillo rodea el borde de la carcasa antes de
// acompañar la muñeca al cerrojo. Al regresar recorre el mismo arco.
const salidaCerrojo = {
  index: [[0, 0, 0], [0.066867, -0.059828, -0.002753], [-0.523721, -0.041402, -1.01813], [-2.5, -0.417522, -0.721171], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
  middle: [[0, 0, 0], [0.612864, -0.531317, -0.684051], [1.056451, -0.2895, 1.728312], [0.005594, 0.167162, -0.000719], [0.012365, -0.008292, 0.007199], [0, 0, 0], [0, 0, 0]],
  ring: [[0, 0, 0], [0.056346, -1.167949, 0.007944], [-1.483327, -0.223557, -1.603807], [-0.280304, -0.146701, 0.413905], [0.0, 0.002936, 7.3e-05], [0, 0, 0], [0, 0, 0]],
};
const tramosCerrojo = [0, .004, .012, .027, .055, .10, .15];

export function liberarCerrojo(q, dedo, u) {
  const puntos = salidaCerrojo[dedo];
  if (!puntos || u <= 0 || u >= tramosCerrojo.at(-1)) return;
  const i = tramosCerrojo.findIndex(t => t >= u);
  const t = MathUtils.smoothstep(u, tramosCerrojo[i-1], tramosCerrojo[i]);
  const a = puntos[i-1], b = puntos[i];
  giro.set(MathUtils.lerp(a[0], b[0], t), MathUtils.lerp(a[1], b[1], t), MathUtils.lerp(a[2], b[2], t));
  q.multiply(arco.setFromEuler(giro));
}
