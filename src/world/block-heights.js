// Alturas canónicas compartidas por el runtime y los mapas por datos.
// Mantenerlas fuera de world.js evita que el catálogo del editor dependa de
// la clase World que, a su vez, consume ese catálogo.
export const BLOCK = Object.freeze({ LOW: 1.1, MID: 1.9, HIGH: 3.0 });
