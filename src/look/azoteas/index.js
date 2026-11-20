// Look de Azoteas: paleta, superficies y capas de vida (en este orden).
// Una manzana de la ciudad vista desde sus techos: la ciudad alrededor sigue
// una cuadrícula de calles (./city-plan.js) y solo cuatro letreros reales
// (./signage.js) ponen el color, lejos y con causa.
import { palette } from './palette.js';
import { surfaces } from './surfaces.js';
import * as stars from './stars.js';
import * as city from './city.js';
import * as signs from './signs.js';
import * as atmos from './atmos.js';

export default {
  palette, surfaces,
  life: [['stars', stars], ['city', city], ['signs', signs], ['atmos', atmos]],
};
