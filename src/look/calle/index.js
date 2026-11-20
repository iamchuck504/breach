// Look de Calle Cerrada: paleta, superficies y capas de vida (en este orden).
// surfaces prepara ctx.calle (las fuentes de luz del operativo) que leen
// cordon y ruina: por eso va primero.
import { palette } from './palette.js';
import { surfaces } from './surfaces.js';
import * as cordon from './cordon.js';
import * as ruina from './ruina.js';
import * as atmos from './atmos.js';

export default { palette, surfaces, life: [['cordon', cordon], ['ruina', ruina], ['atmos', atmos]] };
