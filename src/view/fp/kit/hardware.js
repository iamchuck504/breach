// Riel de rig.ts y cabeza hexagonal de suit.ts de CRASHTERRA.
import { cbox, ccyl, T } from './geometry.js';
import { SURF } from './surfaces.js';

export function rail(b, y, z0, z1, w = 0.024) {
  b.add(cbox(w, 0.007, Math.abs(z1 - z0), 0.0015), T(0, y + 0.0035, (z0 + z1) / 2), SURF.metalDark);
  const n = Math.floor(Math.abs(z1 - z0) / 0.01);
  for (let i = 0; i < n; i++) {
    b.add(cbox(w + 0.004, 0.005, 0.0055, 0.0012), T(0, y + 0.0095, z0 + (i + 0.5) * (z1 - z0) / n), SURF.metal);
  }
}

export function bolt(b, x, y, z, rx, ry, r = 0.0045) {
  b.push(T(x, y, z, rx, ry));
  b.add(ccyl(r, 0.004, 6, 0.0012), null, SURF.light);
  b.add(ccyl(r * 0.47, 0.0008, 6, 0.0002), T(0, 0, 0.002), SURF.black);
  b.pop();
}

// Pequeños numerales de inventario sobre el panel izquierdo.
// El plano local XY se gira hacia el jugador y viaja con la pieza.
export function inventoryMark(b, digits, x, y, z, size) {
  const strokes = [[0, 1, 1], [0.5, 0.5, 0], [0.5, -0.5, 0], [0, -1, 1],
    [-0.5, -0.5, 0], [-0.5, 0.5, 0], [0, 0, 1]];
  const segments = ['012345', '12', '01643', '01623', '5612', '05623', '054326', '012', '0123456', '012356'];
  b.push(T(x, y, z, 0, -Math.PI / 2, 0, size, size, size));
  for (let i = 0; i < digits.length; i++) {
    for (const k of segments[digits[i]]) {
      const [u, v, horizontal] = strokes[k];
      b.add(cbox(horizontal ? 0.84 : 0.16, horizontal ? 0.16 : 0.84, 0.06, 0.016),
        T(u + i * 1.48, v, 0), SURF.mark);
    }
  }
  b.pop();
}
