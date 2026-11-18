// Semiancho (fx) y semilargo (fz) del campo de cada mapa, en metros. Fuente
// única: la leen World, la navegación de bots y los scripts de análisis.
import { CALLE_2 } from './calle-expansion.js';

// AZOTEAS v3: la azotea principal, dos azoteas vecinas y los puentes.
export const AZOTEAS_3 = Object.freeze({
  mainX: 31.5,                 // cara interior del pretil de la azotea principal
  gap: Object.freeze([32.3, 36.9]),   // el vacío entre azoteas (|x|)
  annexX: Object.freeze([37.7, 52.4]), // interior de la azotea vecina (|x|)
  annexZ: 26,                  // semilargo de la azotea vecina
  bridges: Object.freeze([-20, 0, 20]), bridgeHalf: 1.6,
});
const A = AZOTEAS_3;
export const MAP_DIMS = Object.freeze({
  arena: [11, 13], fortaleza: [39.6, 35.6], azoteas: [A.annexX[1], 40],
  calle: [17, 42], metro: [16, 26], prision: [22, 30], pueblo: [26, 34],
  calle2: [CALLE_2.fx, CALLE_2.fz],
});

// Losas de suelo de los mapas que no son un rectángulo: [x0, x1, z0, z1].
// Fuera de ellas no hay suelo (se ve lo que haya debajo).
export const MAP_FLOORS = Object.freeze({
  azoteas: Object.freeze({
    tintHalf: 31,
    rects: Object.freeze([
      [-A.gap[0], A.gap[0], -40.8, 40.8],
      ...[1, -1].flatMap((s) => [
        [Math.min(s * A.gap[1], s * (A.annexX[1] + 0.8)), Math.max(s * A.gap[1], s * (A.annexX[1] + 0.8)), -A.annexZ - 0.8, A.annexZ + 0.8],
        ...A.bridges.map((z) => [Math.min(s * A.gap[0], s * A.gap[1]), Math.max(s * A.gap[0], s * A.gap[1]), z - A.bridgeHalf - 0.3, z + A.bridgeHalf + 0.3]),
      ]),
    ]),
  }),
});
