// PALETA DE CALLE CERRADA: una avenida acordonada cuando todo se torció y
// abandonada después. Noche fría sobre una ciudad muerta; el color solo
// viene de lo que sigue encendido: sodio de las farolas que aguantan, las
// barras de las patrullas, los pilotos ámbar de obra, bengalas y un incendio
// lejano. Colores sRGB (hex).
export const palette = Object.freeze({
  team: { red: 0xe8402f, blue: 0x2f7fe8 },
  // asfalto y agua
  asphalt: 0x585d64, asphaltWarm: 0x5f5a54, puddle: 0x0e1218,
  // polvo y hollín de meses sin nadie
  dust: 0x8b8578, soot: 0x1b1a19, grime: 0x3d3830,
  glass: { dark: 0x10161b, dead: 0x07090b, crack: 0x9fb2bd, tv: 0x8fb6ff },
  sign: { warm: 0xffc27a, cold: 0xbfeee2 },
  lamp: { sodium: 0xff9a3c, dead: 0x24221f, fluo: 0xd9e4d2 },
  steam: 0xb9bec4, ash: 0xa8a39a,
  fire: 0xff6a24, smoke: 0x2a2624,
  sky: {
    // cenit casi negro; el horizonte, pardo del humo que refleja incendios
    stops: [[0, '#05080e'], [0.42, '#0c1420'], [0.72, '#1b2029'], [0.9, '#352a25'], [1, '#55362a']],
  },
  light: {
    moon: 0xaebfdc, moonIntensity: 2.2, moonPos: [-20, 21, 12],
    hemiSky: 0x6a7d99, hemiGround: 0x3a332b, hemiIntensity: 1.9,
    amb: 0x7e889c, ambIntensity: 0.75,
    fog: 0x1d1d22, fogDensity: 0.0085,
    fill: 0xffb478, fillIntensity: 15,
  },
  grade: { exposure: 1.08, bloom: 0.75, threshold: 0.6, shadows: [0.94, 1.0, 1.09], highs: [1.07, 1.0, 0.92], contrast: 0.17, pivot: 0.24, saturation: 0.9, vignette: 0.24, shafts: 0.0 },
});
