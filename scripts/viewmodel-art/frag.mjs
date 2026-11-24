// Cuerpo con gajos y tres cinchas, siguiendo la frag oliva del soldado.
import grenade from './grenade.mjs';
import { cbox, ccyl, T } from '../../src/view/fp/kit/geometry.js';
import { SURF } from '../../src/view/fp/kit/surfaces.js';

export const source = 'grenade';
export default (ctx) => {
  const base = grenade(ctx);
  return {
    ...base,
    anchors: { ...base.anchors, sight_rear: [0, 0.31, 0.03], sight_front: [0, 0.31, -0.04] },
    sculpt(piece) {
      base.sculpt(piece);
      const b = piece('body');
      for (let row = 0; row < 3; row++) {
        const y = -0.048 + row * 0.056, r = row === 1 ? 0.071 : 0.065;
        b.add(ccyl(r, 0.056, 16, 0.005), T(0, y, 0, Math.PI / 2), SURF.polymer);
        for (let i = 0; i < 12; i++) {
          const a = i * Math.PI / 6;
          b.add(cbox(0.028, 0.042, 0.009, 0.004), T(r * Math.sin(a), y, r * Math.cos(a), 0, a), SURF.metal);
        }
      }
    },
  };
};
