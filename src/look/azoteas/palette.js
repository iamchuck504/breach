// PALETA DE AZOTEAS: techos de la ciudad en una noche despejada.
// Colores sRGB (hex). Los techos son de materiales reales (concreto, brea,
// grava, chapa galvanizada, esmalte gris de los equipos): el color NO está
// en ellos sino en los letreros de los edificios vecinos y en lo que su luz
// les hace (./signage.js). Regla de legibilidad del juego: el rojo y el azul
// SATURADOS son de los equipos; ningún neón baña el campo con esos dos.
// De noche manda el valor: remates y bordes de cobertura CLAROS sobre un
// piso de valor medio-oscuro y poco contraste.
export const palette = Object.freeze({
  team: { red: 0xe8402f, blue: 0x2f7fe8 },
  // concreto de pretiles y muros: gris cálido, remate (albardilla) claro
  concrete: { body: 0x7b7a76, dark: 0x5c5c5a, cope: 0xc9c5bb, plinth: 0x3f4044, stain: 0x34363b },
  // forro de los equipos por familia: esmalte gris de las enfriadoras,
  // galvanizado de los ductos, caseta de concreto pintado, acero de las
  // entreplantas. Una familia, un material: nada de "un color por bloque".
  skin: { ac: 0x8d9393, vent: 0x9ea5a8, hut: 0x84878a, deck: 0x50565b },
  // tapas: chapa de las enfriadoras, galvanizado, grava sobre las casetas
  top: { ac: 0xb3b8b6, vent: 0xb0b6b8, hut: 0xa29e95, deck: 0x6e7479 },
  duct: { metal: 0xa3aaad, seam: 0x5d6266 },
  steel: { dark: 0x2b2f34, mid: 0x4f565c, light: 0x8a9196 },
  // pintura de seguridad: solo donde un techo real la lleva (bordes de
  // entreplanta, puentes, helipuerto)
  hazard: 0xd9a63a, hazardDark: 0x24262a,
  // piso: losetas de paso sobre la azotea principal, membrana con grava en
  // las vecinas (una al oeste más fría, otra al este más gastada)
  floor: { membrane: 0x55575a, paver: 0x6b6c6c, joint: 0x2e3034, westRoof: 0x4c4f53, eastRoof: 0x56544f, gravel: 0x7a7872 },
  // luces del propio techo
  lamp: { warm: 0xffd9a0, white: 0xf2f4ff, helipad: 0x6dffa0, amber: 0xffb347, beacon: 0xff3a2a },
  // neones y cajas de luz de los vecinos (ver ./signage.js)
  neon: {
    warm: 0xffe4c2, violet: 0xa476ff, green: 0x2bff6e, greenDark: 0x0d7a37,
    amber: 0xffa53a, orange: 0xff8a2a, teal: 0x34ffd6, magenta: 0xff3fb4, led: 0xffb04a,
    box: 0xfff0d6, boxInk: 0x2a2521, white: 0xe8eeff,
  },
  // ventanas: blancos realistas, mayoría a oscuras
  windows: { warm: 0xffd9a6, cool: 0xdde8ff, tv: 0x8fb6ff, glass: 0x0b0e14 },
  sky: {
    // cielo despejado: casi negro en el cenit, añil, y solo abajo la bruma
    // de la ciudad
    stops: [[0, '#02040a'], [0.42, '#050b1c'], [0.74, '#0c1630'], [0.92, '#1b2438'], [1, '#2f3443']],
    street: 0x0b0c10, moon: 0xe9ecf5,
  },
  light: {
    moon: 0xbfd0ee, moonIntensity: 1.55,
    hemiSky: 0x6178a4, hemiGround: 0x3a3b42, hemiIntensity: 1.15,
    amb: 0x56637c, ambIntensity: 0.42,
    // bruma azul gris: lo lejano se funde, el campo casi no la nota
    fog: 0x262c3a, fogDensity: 0.0072,
  },
  grade: { exposure: 1.06, bloom: 0.85, threshold: 0.8, shadows: [0.95, 0.99, 1.07], highs: [1.04, 1.0, 0.97], contrast: 0.15, pivot: 0.22, saturation: 1.04, vignette: 0.2, shafts: 0.06 },
});
