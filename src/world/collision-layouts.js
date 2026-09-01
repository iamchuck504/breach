// Geometría jugable compartida entre World (cliente) y la autoridad online.
// Estas cajas son la fuente única para movimiento, cover y línea de tiro.
import { BLOCK } from './block-heights.js';

const { LOW, MID, HIGH } = BLOCK;
const make = (x, z, w, d, h, style, options = {}) =>
  Object.freeze({ x, z, w, d, h, style, ...options });
const freeze = (items) => Object.freeze(items.map(Object.freeze));

const fortaleza = freeze([
  make(0, -27, 44, 0.8, HIGH, 'wall', { mirror: false }),
  make(0, 27, 44, 0.8, HIGH, 'wall', { mirror: false }),
  make(-21.4, 0, 0.8, 55.2, HIGH, 'wall', { mirror: false }),
  make(21.4, 0, 0.8, 55.2, HIGH, 'wall', { mirror: false }),
  make(0, -20.9, 8, 1, HIGH, 'high'),
  make(-6, -20.2, 2.6, 0.9, LOW, 'low'),
  make(6, -20.2, 2.6, 0.9, LOW, 'low'),
  make(-8.5, -16, 5, 1, MID, 'mid'),
  make(5.5, -17, 3, 3, LOW, 'low'),
  make(-14.5, -12, 1, 6.5, HIGH, 'high'),
  make(-17.5, -8.5, 1.8, 0.9, LOW, 'low'),
  make(11.5, -12.5, 1, 5, HIGH, 'high'),
  make(9.5, -10.5, 3, 1, HIGH, 'high'),
  make(-2, -11, 2.6, 0.9, LOW, 'low'),
  make(2.5, -8.5, 2.6, 0.9, LOW, 'low'),
  make(-1.5, -6, 2.6, 0.9, LOW, 'low'),
  make(7, -6, 1.2, 1.2, HIGH, 'high'),
  make(-11, -5, 1.2, 1.2, HIGH, 'high'),
  make(-19, -3.5, 1.6, 0.9, LOW, 'low'),
  make(18.5, -6, 0.9, 2.4, LOW, 'low'),
  make(5, -2.5, 3.2, 0.9, MID, 'mid'),
  make(-8.5, -1.5, 2.4, 2.4, LOW, 'low'),
  make(0, 0, 1.8, 1.8, HIGH, 'high', { mirror: false, top: 0xffb075 }),
  make(-5.5, 0.6, 0.9, 2.4, LOW, 'low'),
  // AUDITORÍA de hitboxes: decoración MEDIDA sin física (el espejo crea el
  // par). Antorchas junto a los muros N/S y rocas/derrubio al pie de los
  // muros — las balas atravesaban el dibujo visible.
  make(-10.3, 25.9, 0.7, 0.7, 1.62, 'low', { visual: false, cover: false }),
  make(-10.4, 25.75, 1.8, 1.5, 0.5, 'low', { visual: false, cover: false }),
  make(-19.75, -18.2, 1.5, 1.9, 0.84, 'low', { visual: false, cover: false }),
  make(-20.35, -6.7, 1.7, 1.7, 0.84, 'low', { visual: false, cover: false }),
  // pilastra del muro este (medida: x 20.4-20.6, z ±2.3, alto 2.5) — solo
  // existe en el lado este, sin espejo
  make(20.7, 0, 0.7, 4.7, 2.5, 'low',
    { visual: false, cover: false, mirror: false }),
  make(-20.1, -22.4, 1.2, 2.8, 0.64, 'low', { visual: false, cover: false }),
  make(-20.1, -15, 1.0, 0.8, 0.6, 'low', { visual: false, cover: false }),
  make(-19.65, 3.6, 1.2, 1.3, 0.54, 'low', { visual: false, cover: false }),
  make(20.1, 2.7, 1.2, 1.2, 0.54, 'low', { visual: false, cover: false }),
  make(19.95, -3.6, 1.1, 1.2, 0.54, 'low', { visual: false, cover: false }),
  make(19.8, -18.3, 1.6, 2.1, 0.56, 'low', { visual: false, cover: false }),
  make(20.2, -2, 1.3, 1.5, 0.62, 'low', { visual: false, cover: false }),
  make(-20.05, 9.7, 1.1, 1.7, 0.46, 'low', { visual: false, cover: false }),
  make(18.2, -10.6, 0.8, 0.8, 0.45, 'low', { visual: false, cover: false }),
  make(-6.4, 25.45, 1.9, 1.9, 0.58, 'low', { visual: false, cover: false }),
  make(-12.85, -25.5, 1.6, 1.7, 0.46, 'low', { visual: false, cover: false }),
  make(-15.2, -15.8, 0.8, 0.8, 0.5, 'low', { visual: false, cover: false }),
]);

const azoteas = freeze([
  make(0, -40.4, 65, 0.8, HIGH, 'wall', { mirror: false }),
  make(0, 40.4, 65, 0.8, HIGH, 'wall', { mirror: false }),
  make(-31.9, 0, 0.8, 82, HIGH, 'wall', { mirror: false }),
  make(31.9, 0, 0.8, 82, HIGH, 'wall', { mirror: false }),
  make(0, -31.35, 8, 1.2, HIGH, 'hut'),
  make(-8.2, -27.7, 4, 2.2, LOW, 'ac'),
  make(-8.2, -27.7, 3.9, 2.1, 1.18, 'ac', { visual: false, cover: false }),
  make(11.5, -22.8, 3.8, 3.8, LOW, 'glass'),
  make(-12.2, -22.1, 5.6, 1.1, MID, 'hut'),
  make(-26.3, -31.5, 6, 4, LOW, 'ac'),
  // AUDITORÍA de hitboxes: las tapas/rejillas visuales de AC, vents y la
  // caseta MID sobresalen 10-15cm de su caja — un tiro rasante por encima
  // atravesaba la tapa visible. Tapas 'solid' (sin cover: no son bloques
  // jugables, la regla LOW/MID/HIGH no aplica, como las cabinas de autos).
  make(-26.3, -31.5, 5.9, 3.9, 1.26, 'ac', { visual: false, cover: false }),
  make(26, -31.5, 5.5, 2.6, MID, 'hut'),
  // techo medido a 2.52: el cap 2.06 dejaba pasar tiros a 2.1-2.3
  make(26, -31.5, 5.4, 2.5, 2.30, 'hut', { visual: false, cover: false }),
  make(-27, -23.5, 1.4, 5, LOW, 'vent'),
  // ducto largo MEDIDO por bandas: labio perimetral a 1.16, lomo central
  // 0.6 de ancho a 1.34 y ramal transversal en T (4.0x0.4 a 1.45)
  make(-27, -23.5, 1.44, 5.04, 1.18, 'vent', { visual: false, cover: false }),
  make(-27, -23.5, 0.64, 4.94, 1.36, 'vent', { visual: false, cover: false }),
  make(-27, -23.5, 4.05, 0.45, 1.46, 'vent', { visual: false, cover: false }),
  // tapas finales del ducto: suben a ~1.34 en todo el ancho de las puntas
  make(-27, -25.78, 1.42, 0.52, 1.36, 'vent', { visual: false, cover: false }),
  make(-27, -21.22, 1.42, 0.52, 1.36, 'vent', { visual: false, cover: false }),
  make(27, -23.2, 4, 1.4, LOW, 'vent'),
  make(27, -23.2, 4.02, 1.42, 1.32, 'vent', { visual: false, cover: false }),
  make(-20.25, -15.75, 2.8, 2.8, HIGH, 'hut'),
  make(-25, -6.8, 2.4, 6.2, MID, 'hut'),
  // torre de la caseta MEDIDA: 2.0x5.55 hasta 4.38 (la caja 1.7x1.7 dejaba
  // el resto de la torre como agujero a y2.0+)
  make(-25, -6.8, 2.0, 5.55, HIGH, 'hut', { visual: false }),
  make(-2, -15.6, 5.5, 2.5, LOW, 'ac'),
  make(-2, -15.6, 5.4, 2.4, 1.22, 'ac', { visual: false, cover: false }),
  make(-4, -9.5, 3.6, 1.4, LOW, 'ac', { visual: false }),
  make(18, -14, 1.1, 5.2, HIGH, 'hut'),
  make(25.2, -17.2, 1.1, 3, LOW, 'vent'),
  make(27.2, -7.2, 3, 1.1, LOW, 'vent'),
  make(9.6, -4.3, 4.2, 1.1, MID, 'hut'),
  make(-9.3, -5.2, 3, 2.6, LOW, 'ac'),
  make(-9.3, -5.2, 2.9, 2.5, 1.18, 'ac', { visual: false, cover: false }),
  // tubería decorativa al pie de los muros oeste/sur (cilindros medidos a
  // y0.4): las balas rastreras atravesaban el dibujo. El espejo crea las
  // tiras de los muros este/norte.
  make(-31, -14.45, 0.6, 16.5, 0.42, 'vent', { visual: false, cover: false }),
  make(-12.4, -39.5, 15.6, 0.6, 0.42, 'vent', { visual: false, cover: false }),
]);

function calleSpecs() {
  const out = [
    make(0, -42.4, 36, 0.8, HIGH, 'wall', { mirror: false, visual: false }),
    make(0, 42.4, 36, 0.8, HIGH, 'wall', { mirror: false, visual: false }),
    // AUDITORÍA de hitboxes: las fachadas laterales empiezan en x ±16.15 —
    // el muro en ±17.4 dejaba 0.85m de calle DENTRO del edificio visual
    // (se caminaba y disparaba dentro de la fachada, decals flotando).
    // visual:false OBLIGATORIO: sin él, la caja se dibuja como una muralla
    // gris DELANTE de todos los negocios (queja de Chuck) — los edificios
    // reales ya son el dibujo de este plano físico.
    make(-16.55, 0, 0.8, 86, HIGH, 'wall', { mirror: false, visual: false }),
    make(16.55, 0, 0.8, 86, HIGH, 'wall', { mirror: false, visual: false }),
    // BUS atravesado (escudo de spawn): medido 9.35x3.06 con morro/cola
    // bajos que sobresalían del torso — las balas pasaban por las puntas.
    make(0, -34.5, 9.2, 2.92, HIGH, 'high', { visual: false }),
    make(0, -34.5, 9.35, 3.06, LOW, 'low', { visual: false }),
    make(-6.1, -33.4, 2.4, 0.9, LOW, 'low', { visual: false }),
    make(6.1, -33.4, 2.4, 0.9, LOW, 'low', { visual: false }),
    make(-1.2, -8.7, 3.2, 0.9, MID, 'mid', { visual: false }),
    make(-6.5, -1.5, 3.0, 7.15, HIGH, 'high', { visual: false }),
    make(-15.15, -8, 2.5, 2.5, LOW, 'low', { visual: false }),
    // arbusto de la jardinera: sobresale de la caja LOW hasta ~1.45
    make(-15.15, -8, 2.2, 2.2, 1.45, 'low', { visual: false, cover: false }),
    make(14.35, -8.5, 1.36, 0.78, LOW, 'low', { visual: false }),
    // Carrito de café por PIEZAS MEDIDAS (queja de Chuck: la silueta sólida
    // completa tapaba el hueco de servicio visible entre mostrador y toldo
    // — pared invisible en pleno centro). Como el kiosco: solo lo dibujado
    // detiene balas; el toldo (losa a 2.15) queda como voladizo exento.
    make(14.35, -8.5, 1.38, 0.78, 1.21, 'low', { visual: false, cover: false }),
    make(14.43, -8.46, 0.68, 0.26, 1.46, 'low', { visual: false, cover: false }),
    // postes de esquina del toldo, medidos en x 13.81/14.89 (mirror
    // explícito: el estilo 'solid' de Calle trae mirror:false en el
    // cliente). El toldo (losa a 2.15) y el letrero COFFEE que cuelga del
    // alero (1.86-2.15) quedan SIN física: son voladizos colgantes — una
    // caja desde el suelo sería la pared invisible que reportó Chuck.
    make(13.81, -8.84, 0.12, 0.12, 2.16, 'solid',
      { visual: false, cover: false, mirror: true }),
    make(14.89, -8.84, 0.12, 0.12, 2.16, 'solid',
      { visual: false, cover: false, mirror: true }),
    make(13.81, -8.2, 0.12, 0.12, 2.16, 'solid',
      { visual: false, cover: false, mirror: true }),
    make(14.89, -8.2, 0.12, 0.12, 2.16, 'solid',
      { visual: false, cover: false, mirror: true }),
    make(3.6, -2.2, 2.4, 0.9, LOW, 'low', { visual: false }),
  ];

  // VEHÍCULOS con perfiles MEDIDOS contra los meshes reales (auditoría de
  // hitboxes): el sedán procedural mide 2.26x4.76 de cuerpo (la base vieja
  // 2.02x4.45 dejaba pasar balas por defensas y costados) y el SUV GLB
  // lleva capó/portón ALTOS a lo largo de todo el cuerpo (los pisos cortos
  // centrados dejaban pasar tiros por el morro y la cola, decals en la
  // fachada de la panadería a través del auto). La base LOW conserva el
  // cover táctico; los pisos 'solid' no crean caras nuevas.
  // Los pisos altos llevan OFFSET longitudinal donde la silueta es
  // asimétrica (la cabina del SUV vive en la mitad trasera: un piso alto a
  // lo largo de todo el auto era una pared invisible sobre el capó — no se
  // podía dañar a alguien parado detrás). El espejo de make() invierte el
  // offset automáticamente, así la orientación del auto espejado cuadra.
  const addVehicle = (x, z, { rotated = false, suv = false } = {}) => {
    const swap = (w, d) => rotated ? [d, w] : [w, d];
    const tier = (width, length, height, shift, style = 'solid', extra = {}) => {
      const [w, d] = swap(width, length);
      const [ox, oz] = rotated ? [shift, 0] : [0, shift];
      out.push(make(x + ox, z + oz, w, d, height, style, {
        visual: false, mirror: true, ...extra,
      }));
    };
    if (suv) {
      tier(1.74, 4.5, LOW, 0, 'low', { mirror: true });   // cuerpo/capó bajo
      tier(2.06, 2.85, 1.5, -0.57); // cuerpo alto+espejos (mitad trasera medida)
      tier(1.72, 2.0, 2.0, -0.6);   // cabina/techo
    } else {
      tier(2.32, 4.76, LOW, 0, 'low', { mirror: true });  // cuerpo completo
      tier(2.32, 4.76, 1.0, 0);     // cinturón (full: medido a y0.95)
      tier(2.24, 2.2, 1.47, 0.15);  // espejos+cabina/pilares (descentrada)
      tier(2.0, 1.34, 1.57, 0.15);  // techo
    }
  };
  addVehicle(-2.5, -28, { suv: true });
  addVehicle(6.5, -21);
  addVehicle(-6.5, -16);
  addVehicle(3, -10.5);
  addVehicle(-3, -5.5, { rotated: true });

  // Un kiosco abierto no puede compartir el cubo HIGH que ocupaba toda su
  // huella. Se modelan únicamente respaldo, laterales, postes y mostrador;
  // el hueco de servicio permanece físicamente transitable y visible.
  // Kioscos: huella MEDIDA contra el mesh (news 1.93x2.31, hotdog 1.83x2.21,
  // centro corrido 0.19 hacia atrás) — el visual sobresalía del spec y las
  // balas entraban por los costados. El hueco de servicio sigue transitable.
  // Kioscos FIELES al builder addSidewalkKiosk (queja de Chuck: repisas y
  // paneles engordados bloqueaban balas de forma invisible). Piezas 1:1 con
  // el dibujo: respaldo 0.11, costados de vidrio SOLO el 58% trasero con
  // 0.10 de grosor, postes de esquina, mostrador+labio a LOW y la fila de
  // condimentos. El frente queda ABIERTO de 1.1 a ~2.2; techo/alero/letrero
  // (>=2.18) son voladizos exentos.
  const addKiosk = (x, z, w, d, toward, decorLink) => {
    const frontZ = z + toward * (d / 2 + 0.026);
    const backZ = z - toward * (d / 2 - 0.055);
    const linked = { visual: false, mirror: false, decorLink };
    out.push(make(x, backZ, w - 0.10, 0.11, 2.30, 'shelter', linked));
    for (const side of [-1, 1]) {
      out.push(make(x + side * (w / 2 - 0.05), z - toward * d * 0.20,
        0.10, d * 0.58, 2.28, 'shelter', linked));
      out.push(make(x + side * (w / 2 - 0.055), frontZ - toward * 0.055,
        0.11, 0.11, 2.45, 'solid', { ...linked, cover: false }));
    }
    out.push(make(x, frontZ - toward * 0.06, w - 0.16, 0.18, LOW, 'low', linked));
    out.push(make(x, frontZ + toward * 0.11, w + 0.04, 0.38, 1.12, 'low',
      { ...linked, cover: false }));
    out.push(make(x, frontZ - toward * 0.01, 0.64, 0.12, 1.32, 'solid',
      { ...linked, cover: false }));
  };
  addKiosk(-14.35, -29, 1.75, 1.75, 1, 'kiosk:news:south-left');
  addKiosk(14.35, 29, 1.75, 1.75, -1, 'kiosk:news:north-right');
  addKiosk(14.35, -26, 1.65, 1.65, 1, 'kiosk:hotdog:south-right');
  addKiosk(-14.35, 26, 1.65, 1.65, -1, 'kiosk:hotdog:north-left');
  // carteles de pie junto a cada kiosco (medidos): no tenían NINGUNA física
  // (mirror explícito: crea el par de los kioscos del lado norte)
  out.push(make(-15.13, -28.1, 0.4, 0.26, 2.3, 'solid',
    { visual: false, mirror: true }));
  out.push(make(13.62, -25.15, 0.4, 0.26, 2.3, 'solid',
    { visual: false, mirror: true }));
  for (const z of [-35, -25, -15, -5, 5, 15, 25, 35]) {
    // poste real medido: 0.2 de grosor con cara en ±12.69 — más grueso era
    // pared invisible y los decals del borde se suprimían por caer en aire
    out.push(make(-12.6, z, 0.22, 0.22, 6.2, 'solid', {
      mirror: false, decorLink: `streetlight:left:${z}`,
    }));
    out.push(make(12.6, z, 0.22, 0.22, 6.2, 'solid', {
      mirror: false, decorLink: `streetlight:right:${z}`,
    }));
  }
  out.push(make(-12.45, -11, 0.46, 0.46, 0.68, 'solid', {
    mirror: false, decorLink: 'hydrant:left',
  }));
  out.push(make(12.45, 11, 0.46, 0.46, 0.68, 'solid', {
    mirror: false, decorLink: 'hydrant:right',
  }));
  // Parada de bus: el GLB real ocupa x 13.72..14.98 (los costados del spec
  // arrancaban en 13.88 — 16cm de marquesina/lateral penetrables y decals
  // clavados 0.9m adentro). Frente abierto intacto (cover en U).
  for (const [side, z] of [[1, -37], [-1, 37]]) {
    const decorLink = `busShelter:${side > 0 ? 'right' : 'left'}`;
    out.push(make(side * 14.88, z, 0.2, 3.53, 2.45, 'shelter', {
      mirror: false, decorLink,
    }));
    for (const dz of [-1.6, 1.6]) {
      out.push(make(side * 14.35, z + dz, 1.26, 0.5, 2.45, 'shelter', {
        mirror: false, decorLink,
      }));
    }
    // interior del GLB (banca con respaldo + paneles de vidrio a varias
    // alturas): sellado como bloque — la navegación ya estaba bloqueada por
    // la banca y las balas se colaban entre panel y panel
    out.push(make(side * 14.38, z, 1.2, 3.1, 2.45, 'solid', {
      mirror: false, decorLink,
    }));
  }
  return freeze(out);
}

const calle = calleSpecs();
export const COLLISION_LAYOUTS = Object.freeze({ fortaleza, azoteas, calle });

export const HELIPAD = Object.freeze({
  height: LOW,
  radius: 6.2,
  edge: 6.2 * Math.cos(Math.PI / 8),
  diagonal: 6.2 * (Math.cos(Math.PI / 8) + Math.sin(Math.PI / 8)),
  rampLength: 5,
  rampHalfWidth: 1.55,
});

export function collisionBoxesFor(layout) {
  return COLLISION_LAYOUTS[layout] || Object.freeze([]);
}

export function expandedCollisionBoxes(layout) {
  const out = [];
  const place = (box, x, z) => out.push({
    minx: x - box.w / 2, maxx: x + box.w / 2,
    minz: z - box.d / 2, maxz: z + box.d / 2,
    h: box.h,
  });
  for (const box of collisionBoxesFor(layout)) {
    place(box, box.x, box.z);
    if (box.mirror !== false && (box.x !== 0 || box.z !== 0)) place(box, -box.x, -box.z);
  }
  return out;
}

export function helipadSegments() {
  const verts = Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + i * Math.PI / 4;
    return { x: Math.sin(a) * HELIPAD.radius, z: Math.cos(a) * HELIPAD.radius };
  });
  const out = [];
  const add = (a, b) => {
    const tx = b.x - a.x, tz = b.z - a.z;
    const len = Math.hypot(tx, tz); if (len < 0.05) return;
    out.push({ a, b, n: { x: -tz / len, z: tx / len }, half: 0.08,
      h: HELIPAD.height + LOW });
  };
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const rampSide = Math.abs(a.z - b.z) < 0.01 && Math.abs(a.z) > HELIPAD.edge - 0.05;
    if (!rampSide) { add(a, b); continue; }
    const z = a.z;
    if (a.x < b.x) {
      add(a, { x: -HELIPAD.rampHalfWidth, z });
      add({ x: HELIPAD.rampHalfWidth, z }, b);
    } else {
      add(a, { x: HELIPAD.rampHalfWidth, z });
      add({ x: -HELIPAD.rampHalfWidth, z }, b);
    }
  }
  return out;
}
