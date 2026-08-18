// Todos los valores de game feel viven aquí. F10 abre el panel en vivo (lil-gui).
// Unidades: metros, segundos, grados. Los lerp son "suavizado por segundo" (más alto = más rápido).

export const TUNING = {
  move: {
    runSpeed: 4.8,        // jog normal
    roadieSpeed: 7.6,     // roadie run
    accel: 46,            // aceleración al empezar a moverse
    decel: 34,            // frenado al soltar
    turnLerp: 15,         // giro del personaje hacia la dirección de movimiento
    roadieTurnLerp: 6.5,  // roadie gira más pesado (feel Gears)
    aimTurnLerp: 22,      // giro hacia la cámara al apuntar
    coverStrafe: 3.5,     // velocidad lateral pegado a cobertura
  },
  evade: {
    diveSpeed: 8.2,       // dash/roll sin cobertura
    diveTime: 0.36,
    diveCancelPct: 0.5,   // % del dive tras el cual se puede cancelar en otro evade
    slideSpeed: 9.4,      // slide hacia cobertura
    slideMaxDist: 4.4,    // alcance de búsqueda de cobertura desde jog
    roadieSlideDist: 5.8, // alcance desde roadie run
    bounceWindow: 0.30,   // seg tras tocar cover en los que evadir sale instantáneo
    bounceRange: 5.6,     // alcance de búsqueda de la siguiente cobertura al wallbouncear
    bounceCooldown: 0.06,
    chainSpeedBonus: 0.05,// % de velocidad extra por rebote encadenado
    chainMax: 5,
  },
  cover: {
    snapRange: 1.7,       // distancia para engancharse a una cara de cobertura
    detachPush: 0.55,     // cuánto hay que empujar lejos del cover para soltarse
    detachTime: 0.11,
    cornerLean: 0.55,     // margen del borde para lean en esquinas
    lowHeight: 1.4,       // altura máxima que cuenta como cobertura baja (popover)
  },
  cam: {
    sens: 0.045,          // sensibilidad ratón (deg por pixel; ~360° en 20cm a 1000dpi)
    padSens: 170,         // sensibilidad stick derecho (deg por segundo a full)
    pitchMin: -62, pitchMax: 55,
    fovNormal: 57, fovRoadie: 66, fovAim: 41,
    fovLerp: 9,
    posLerp: 11,          // seguimiento de posición
    rotLag: 0,            // reservado
    shoulder: 0.82,       // desplazamiento lateral (hombro derecho, estilo Gears)
    height: 1.62, dist: 2.7,
    roadieHeight: 1.18, roadieDist: 3.1,
    aimShoulder: 0.88, aimHeight: 1.58, aimDist: 1.8,
    coverDist: 3.0,
    shakeRoadie: 0.7,     // amplitud de shake en roadie
    shakeFire: 0.35,      // kick al disparar
    minDist: 0.5,
  },
  weapons: {
    lancer: {
      name: 'LANCER', rpm: 620, dmg: 10, headMult: 1.6,
      mag: 50, reserve: 150, reloadTime: 1.9,
      spreadAim: 0.9, spreadHip: 3.4, spreadBlind: 5.2,   // grados
      recoil: 0.35, range: 80, pellets: 1, auto: true,
    },
    gnasher: {
      name: 'GNASHER', rpm: 68, dmg: 13, headMult: 1.0,
      mag: 8, reserve: 24, reloadTime: 2.1,
      spreadAim: 4.6, spreadHip: 6.4, spreadBlind: 8.0,
      recoil: 1.6, range: 24, pellets: 8, auto: false,
      falloffStart: 6, falloffEnd: 19,  // dmg pleno hasta start, 0 en end
      gibRange: 4.2,                    // one-shot gib si mata dentro de este rango
    },
  },
  combat: {
    hp: 100,
    regenDelay: 3.6, regenRate: 48,
    respawnTime: 4,
    killLimit: 25,
  },
  net: {
    sendHz: 20, interpDelay: 0.12,
  },
};

// deep clone para reset del panel de tuning
export const TUNING_DEFAULTS = JSON.parse(JSON.stringify(TUNING));
