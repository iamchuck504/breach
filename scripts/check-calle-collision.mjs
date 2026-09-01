import { strict as assert } from 'node:assert';
import { BLOCK } from '../src/world/block-heights.js';
import { collisionBoxesFor } from '../src/world/collision-layouts.js';
import { firstMapIntersection } from '../server/map-geometry.js';

const hit = (origin, direction, distance) => firstMapIntersection('calle',
  { x: origin[0], y: origin[1], z: origin[2] },
  { x: direction[0], y: direction[1], z: direction[2] }, distance);

// El cover base permanece LOW, mientras niveles sólidos sin cover aproximan
// la silueta MEDIDA del mesh (auditoría de hitboxes): cuerpo completo hasta
// el cinturón, cabina baja y techo — sin dejar pasar balas por defensas ni
// inventar paredes rectangulares sobre el parabrisas.
const calle = collisionBoxesFor('calle');
const nearSedan = (b) => b.x === 6.5 && Math.abs(b.z - -21) < 0.4;
const sedanBody = calle.find((b) => nearSedan(b) && b.h === BLOCK.LOW);
const sedanCabins = calle.filter((b) => nearSedan(b) && b.style === 'solid');
assert(sedanBody && sedanCabins.length === 3,
  'sedán debe conservar cuerpo LOW y tres niveles físicos (cinturón/pilares/techo)');
const sedanTiers = [...sedanCabins].sort((a, b) => a.h - b.h);
assert(sedanTiers[0].d > sedanTiers[1].d && sedanTiers[1].d > sedanTiers[2].d,
  'los niveles deben estrecharse siguiendo parabrisas y vidrio trasero');
assert(sedanBody.w >= 2.2 && sedanBody.d >= 4.7,
  'el cuerpo LOW debe cubrir el mesh medido (2.32x4.76): sin balas por las defensas');
assert.notEqual(hit([4.8, 1.35, -21.08], [1, 0, 0], 3.4), null,
  'un tiro a través de la cabina del sedán debe bloquearse');
assert.equal(hit([4.8, 1.35, -22.2], [1, 0, 0], 3.4), null,
  'detrás del vidrio trasero, sobre el cinturón, el tiro pasa limpio');
assert.notEqual(hit([4.8, 1.52, -20.9], [1, 0, 0], 3.4), null,
  'el techo del sedán detiene el tiro');
assert.equal(hit([4.8, 1.52, -21.8], [1, 0, 0], 3.4), null,
  'sobre los pilares, fuera del techo, el tiro pasa');
assert.equal(hit([4.8, 1.35, -19.15], [1, 0, 0], 3.4), null,
  'un tiro por encima del capó no debe chocar con una caja alta invisible');

assert.notEqual(hit([-4.05, 1.80, -28.05], [1, 0, 0], 3.1), null,
  'el techo alto del SUV debe bloquear disparos');
assert.equal(hit([-4.05, 1.80, -26.95], [1, 0, 0], 3.1), null,
  'el nivel superior del SUV no debe flotar fuera de su techo');
assert.equal(hit([-4.05, 1.80, -26.00], [1, 0, 0], 3.1), null,
  'el capó del SUV no debe heredar la altura completa de la cabina');
// El caso reportado por Chuck: disparar POR ENCIMA del capó a alguien del
// otro lado. El capó es bajo (solo el cuerpo LOW): a la altura del pecho el
// tiro debe pasar limpio; sobre la mitad trasera (cuerpo alto) sí bloquea.
assert.equal(hit([-4.05, 1.35, -26.40], [1, 0, 0], 3.1), null,
  'por encima del capó del SUV el tiro debe pasar (sin pared invisible)');
assert.notEqual(hit([-4.05, 1.35, -28.50], [1, 0, 0], 3.1), null,
  'el cuerpo alto trasero del SUV sí detiene el tiro');

const nearRot = (b) => Math.abs(b.x - -3) < 0.4 && b.z === -5.5;
const rotatedBody = calle.find((b) => nearRot(b) && b.h === BLOCK.LOW);
const rotatedCabins = calle.filter((b) => nearRot(b) &&
  b.style === 'solid').sort((a, b) => a.h - b.h);
assert(rotatedBody && rotatedCabins.length === 3,
  'el sedán transversal debe usar la misma silueta escalonada');
assert(rotatedBody.w > rotatedBody.d &&
  rotatedCabins[0].w > rotatedCabins[1].w && rotatedCabins[1].w > rotatedCabins[2].w,
  'al rotar el sedán, la pendiente debe rotar con su silueta');

// A la altura del pecho, el frente abierto del kiosco deja ver el interior;
// el respaldo sigue deteniendo el disparo. A altura LOW, el mostrador sí es
// sólido y utilizable como cobertura.
assert.equal(hit([-14.35, 1.40, -27.45], [0, 0, -1], 1.85), null,
  'el hueco frontal del kiosco no debe ser un cubo HIGH invisible');
assert.notEqual(hit([-14.35, 1.40, -27.45], [0, 0, -1], 2.6), null,
  'el respaldo real del kiosco debe bloquear');
assert.notEqual(hit([-14.35, 0.75, -27.45], [0, 0, -1], 1.2), null,
  'el mostrador LOW del kiosco debe bloquear');

// Carrito de café por piezas (reporte de Chuck: el hueco de servicio entre
// mostrador y toldo se VE abierto y las balas pegaban pared invisible).
// Solo lo dibujado detiene: mostrador, máquina, postes y letrero.
assert.notEqual(hit([14.35, 1.05, -9.8], [0, 0, 1], 2.6), null,
  'la base del carrito de café debe recibir impactos hasta LOW');
assert.equal(hit([14.35, 1.60, -9.8], [0, 0, 1], 2.6), null,
  'el hueco de servicio del carrito deja pasar el tiro (no hay pared invisible)');
assert.notEqual(hit([14.43, 1.35, -9.8], [0, 0, 1], 2.6), null,
  'la máquina de café sobre el mostrador sí detiene el tiro');
assert.equal(hit([14.35, 2.25, -9.8], [0, 0, 1], 2.6), null,
  'por encima del carrito el tiro pasa limpio');

console.log('CALLE COLLISION OK · vehículos por silueta · kioscos abiertos · coffee LOW');
