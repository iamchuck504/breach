// Look de Fortaleza: paleta, superficies y capas de vida (en este orden).
import { palette } from './palette.js';
import { surfaces } from './surfaces.js';
import * as flora from './flora.js';
import * as cloth from './cloth.js';
import * as atmos from './atmos.js';

export default { palette, surfaces, life: [['flora', flora], ['cloth', cloth], ['atmos', atmos]] };
