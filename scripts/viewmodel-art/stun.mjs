// El módulo cian y sus tres anillos identifican la aturdidora de Breach.
import pistol from './pistol.mjs';
import { cbox, ccyl, prism, T } from '../../src/view/fp/kit/geometry.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

export const source = 'pistol';
export default (ctx) => {
  const base = pistol(ctx);
  return { ...base, sculpt(piece) {
    base.sculpt(piece);
    const b = piece('slide');
    for (const z of [-0.282, -0.242, -0.202]) {
      b.add(ccyl(0.062, 0.018, 16), T(0, 0.12, z), SURF.metalDark);
      b.add(ccyl(0.063, 0.006, 16), T(0, 0.12, z), SURF.dot);
    }
    b.add(cbox(0.132, 0.074, 0.099, 0.009), T(0, 0.117, -0.147), SURF.metalDark);
    // Las protecciones sobresalen por delante de los anillos; el emisor
    // queda encastrado en cada mejilla, visible por tres ventanas.
    for (const side of [-1, 1]) {
      b.add(prism([[-0.357, 0.145], [-0.337, 0.163], [-0.196, 0.16], [-0.181, 0.15], [-0.195, 0.140]], 0.017, 0.003), T(side * 0.054, 0, 0), SURF.ceramic);
      for (let i = 0; i < 3; i++) b.add(cbox(0.003, 0.008, 0.015, 0.001), T(side * 0.0665, 0.119, -0.172 + i * 0.023), SURF.dot);
    }
  } };
};
