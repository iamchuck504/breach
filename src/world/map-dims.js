// Semiancho (fx) y semilargo (fz) del campo de cada mapa, en metros. Fuente
// única: la leen World, la navegación de bots y los scripts de análisis.
import { CALLE_2 } from './calle-expansion.js';

export const MAP_DIMS = Object.freeze({
  arena: [11, 13], fortaleza: [26, 26.6], azoteas: [31.5, 40],
  calle: [17, 42], metro: [16, 26], prision: [22, 30], pueblo: [26, 34],
  calle2: [CALLE_2.fx, CALLE_2.fz],
});
