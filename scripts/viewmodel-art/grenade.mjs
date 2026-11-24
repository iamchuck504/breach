// GRANADA DE HUMO — reglas de piezas para scripts/build-viewmodel-art.mjs.
// Formato: ver scripts/viewmodel-art/smg.mjs y src/view/fp/README.md.
// Coordenadas del MODELO: x derecha, y arriba, -z adelante.
//
// Del original (art/characters/blender-source/grenade.glb, 21 islas, 2.6 k
// triángulos — ya es de primer plano: no se simplifica):
//   cuerpo (bote de grafito, tapa, fondo y tres bandas de metal), cabeza de
//   la espoleta (bloque de metal arriba), cuchara (barra mecanizada por la
//   espalda, de abajo a la cabeza), anilla (aro de metal a la izquierda de la
//   cabeza), almohadilla de goma, marcas rojas y LED.
// Piezas: `body` (bote, tapa, fondo, bandas, cabeza de la espoleta, goma,
// marcas, LED), `spoon` (la cuchara, nodo propio con bisagra arriba) y `pin`
// (la anilla: la arranca la mano izquierda al empezar el lanzamiento).
// El kit añade la camisa, el cuello y la placa de identificación.
import { cbox, ccyl, T } from '../../src/view/fp/kit/geometry.js';
import { bolt, inventoryMark } from '../../src/view/fp/kit/hardware.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

function sculpt(piece) {
  const b = piece('body');
  // Camisa estriada del bote y cuello moleteado bajo la anilla.
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    b.add(cbox(0.010, 0.123, 0.006, 0.002), T(0.051 * Math.sin(a), 0.024, 0.051 * Math.cos(a), 0, a), SURF.rubber);
  }
  for (const y of [0.103, 0.117, 0.132]) b.add(ccyl(0.057, 0.006, 24, 0.001), T(0, y, 0, Math.PI / 2), SURF.metal);
  b.add(cbox(0.037, 0.06, 0.005, 0.002), T(0, 0.045, 0.054), SURF.ceramic);
  for (let i = 0; i < 4; i++) b.add(cbox(0.023 - i * 0.003, 0.003, 0.0015), T(0, 0.062 - i * 0.009, 0.057), SURF.mark);
  bolt(piece('spoon'), 0.013, 0.17, 0.035, 0, Math.PI / 2, 0.006);
  // Chapa esmaltada orientada hacia el jugador, al lado de la cuchara.
  b.push(T(-0.037, 0.072, 0.039, 0, -0.75));
  b.add(cbox(0.037, 0.028, 0.005, 0.002), null, SURF.ceramic);
  b.push(T(0, 0, 0.003, 0, Math.PI / 2));
  inventoryMark(b, '02', 0, 0, -0.006, 0.007);
  b.pop().pop();
}

export default ({ sockets }) => ({
  sculpt,
  rules: [
    // anilla: aro de metal a la izquierda de la cabeza; centro (-0.048, 0.172, 0)
    { part: 'pin', from: 'grip', mat: 'slate', box: [[-0.06, -0.04], [0.13, 0.17], [-0.03, 0]] },
    // cuchara: barra mecanizada por la espalda; centro (0, 0.069, 0.034)
    { part: 'spoon', from: 'grip', mat: 'machined', box: [[-0.02, 0.02], [0.03, 0.06], [0, 0.03]] },
  ],
  build: [],
  pivots: {
    body: [0, 0, 0],
    pin: [-0.048, 0.172, 0],          // centro de la anilla
    spoon: [0, 0.179, 0.034],         // bisagra de la cuchara, arriba
  },
  anchors: {
    // anclas para el sistema común: la "boca" es la cabeza de la espoleta;
    // la línea de mira es virtual (por encima del bote), solo sirve para
    // que la ADS deje la granada abajo, lista para lanzar
    muzzle: [0, 0.17, -0.12],
    grip: sockets.grip,
    forend: [-0.048, 0.172, 0],        // la anilla: ahí mete el dedo la izquierda
    mag: sockets.mag,
    sight_rear: [0, 0.27, 0.03],
    sight_front: [0, 0.27, -0.04],
    eject: [0, 0.17, 0],
    pin: [-0.048, 0.172, 0],
    lever: [0, 0.07, 0.034],
  },
});
