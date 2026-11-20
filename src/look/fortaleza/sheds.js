// Cobertizos de la liza (establo y fragua), leídos de los colliders: su
// tejado de tablas es una losa fina a ~3.8-4.05 m pegada a la muralla. Lo
// usan la lona (cloth) y el humo y las pavesas de la fragua (atmos), que
// deben caer en el mismo sitio.
export function shedRoofs(colliders) {
  return colliders.filter((c) => {
    const minY = c.minY ?? 0;
    return minY >= 3.5 && c.h - minY < 0.5 && Math.min(Math.abs(c.minx), Math.abs(c.maxx)) > 30;
  });
}

export const CHIMNEY_TOP = 5.6;

// La fragua es el cobertizo corto (7.6 m de fondo; el establo mide 10.8).
// Su chimenea va pegada a la muralla, algo desplazada del centro.
export function forgeChimneys(colliders) {
  return shedRoofs(colliders).filter((c) => c.maxz - c.minz < 9).map((c) => {
    const east = c.minx > 0;
    return { x: east ? c.maxx - 0.75 : c.minx + 0.75, z: (c.minz + c.maxz) / 2 + (east ? 1.6 : -1.6), roof: c };
  });
}
