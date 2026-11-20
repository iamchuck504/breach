// PALETA DE FORTALEZA: castillo militar en uso, hora dorada. Sobria, cálida
// y algo severa: el color sale de la piedra, la teja, la madera, el hierro, el
// fuego, el cielo y el campo. Colores sRGB (hex).
// Regla de legibilidad del juego: el rojo y el azul SATURADOS son de los
// equipos (y de su heráldica); el entorno nunca los usa.
export const palette = Object.freeze({
    team: { red: 0xe8402f, blue: 0x2f7fe8 },
    // piedra: una sola familia de caliza. Base gris miel, sillares sueltos más
    // claros, ocres (óxido de la propia piedra) o grises (piedra más fría)
    stone: { base: 0xb4a588, light: 0xcbbe9f, warm: 0xb89c74, grey: 0x9a978c, cope: 0xd6ccb2, plinth: 0x7c7262, mortar: 0x675e52, damp: 0x5c5649 },
    moss: 0x5f7234, lichen: 0xb2a873, ivy: 0x3d6a2c,
    // teja árabe: solo la variación natural del barro cocido y del tiempo
    roof: { tile: 0xb0583a, tileDark: 0x8a412c, tileOld: 0x7d6150 },
    wood: { oak: 0x75533a, dark: 0x4a3426 },
    metal: { iron: 0x34363a, bronze: 0x8a6c3e },
    ground: { grass: 0x6b8840, grassDeep: 0x46652e, grassDry: 0xa69a5c, dirt: 0x8c7356, earth: 0x7a6852, flag: 0xb8ad95, flagWarm: 0xc2ab88 },
    // heráldica y lona: tela teñida y gastada, no de fiesta
    cloth: { linen: 0xd6cbb0, canvas: 0xae9f80, gold: 0xc4a35e, trim: 0x2e2824 },
    // flores silvestres del pie de muro y del prado: pocas y apagadas
    flowers: [0xebe5d4, 0xd8c35c, 0x8d88b4, 0xa9452f],
    // follaje: tres verdes y dos toques de otoño (solo como pincelada)
    foliage: [0x55733a, 0x6a8443, 0x3e5d36, 0xa8843c, 0x95582f],
    fire: { core: 0xffe29a, flame: 0xff9a3d, ember: 0xff5a1f, smoke: 0x5c5751, smokeLit: 0xb9a48c },
    sky: {
      stops: [[0, '#335a8a'], [0.40, '#5c8db6'], [0.68, '#a6b9bf'], [0.86, '#e9c28a'], [1, '#e8925a']],
      cloudLit: 0xffdcae, cloudShade: 0x8c8490, cloudRim: 0xfff0d2,
      horizon: 0xe2b88e, far: 0x7b8295, farWarm: 0xa6928a,
    },
    light: {
      sun: 0xffcf96, sunIntensity: 2.85,
      hemiSky: 0x88a9cc, hemiGround: 0xa48a6a, hemiIntensity: 1.12,
      amb: 0x98a3c8, ambIntensity: 0.10,
      fog: 0xdfc2a2, fogDensity: 0.0046,
    },
    grade: { exposure: 1.02, bloom: 0.46, threshold: 0.95, shadows: [0.92, 0.98, 1.09], highs: [1.06, 1.0, 0.9], contrast: 0.19, pivot: 0.36, saturation: 1.04, vignette: 0.22, shafts: 0.40 },
});
