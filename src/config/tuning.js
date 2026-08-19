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
    aimTurnLerp: 30,      // giro hacia la cámara al apuntar/disparar
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
    momentumBoost: 0.22,  // % máx de impulso extra al evadir tras venir corriendo
    momentumRunTime: 0.45,// seg de carrera CONTINUA para el impulso pleno
    momentumRunDist: 3.2, // metros recorridos recientes para el pleno
    recovery: 0.35,       // seg entre evasiones NUEVAS (anti-spam, no lentitud;
                          // los rebotes encadenados usan sus propias ventanas)
  },
  mantle: {
    time: 0.42,           // duración del vault sobre cover bajo
    exitSpeed: 0.32,      // % de runSpeed al aterrizar arriba (paso, no empujón)
  },
  jump: {
    vel: 6.2,          // impulso vertical (apex ~1.28m: pasa bloques LOW de 1.1)
    gravity: 15,
    wallVel: 5.4,      // impulso del salto de pared
    wallPush: 3.8,     // empuje horizontal alejándose de la pared
    airControl: 0.35,  // control de movimiento en el aire
    wallMinH: 1.4,     // altura mínima de pared para el wall kick
    doubleVy: 1.8,     // impulso vertical del doble salto (NO doble altura)
    rollDur: 0.55,     // duración de la vuelta del doble salto
    dashMul: 1.15,     // multiplicador de velocidad de la vuelta direccional
    backflipLat: 1.1,  // bajo esta vel. lateral el wall kick es backflip, no giro lateral
  },
  cover: {
    snapRange: 1.7,       // distancia para engancharse a una cara de cobertura
    detachPush: 0.55,     // cuánto hay que empujar lejos del cover para soltarse
    detachTime: 0.11,
    cornerLean: 0.55,     // margen del borde para lean en esquinas
    lowHeight: 1.4,       // altura máxima que cuenta como cobertura baja (popover)
    edgeExitBoost: 0.85,  // % de runSpeed del impulso al salir por el extremo
  },
  cam: {
    sens: 0.045,          // sensibilidad ratón (deg por pixel; ~360° en 20cm a 1000dpi)
    padSens: 170,         // sensibilidad stick derecho (deg por segundo a full)
    pitchMin: -62, pitchMax: 55,
    fovNormal: 57, fovRoadie: 57, fovAim: 41, // sin FOV kick al correr
    fovLerp: 9,
    posLerp: 11,          // seguimiento de posición
    rotLag: 0,            // reservado
    shoulder: 0.82,       // desplazamiento lateral (hombro derecho, estilo Gears)
    height: 1.62, dist: 2.7,
    roadieHeight: 1.62, roadieDist: 2.7, // = cámara normal: correr NO mueve la cámara
    aimShoulder: 0.88, aimHeight: 1.58, aimDist: 1.8,
    coverDist: 3.0,
    shakeRoadie: 0,       // sin shake al correr (0 = apagado)
    shakeFire: 0.35,      // kick al disparar
    minDist: 0.5,
  },
  weapons: {
    smg: {
      name: 'METRALLETA', rpm: 620, dmg: 10, headMult: 1.6,
      mag: 50, reserve: 150, reloadTime: 1.9,
      spreadAim: 0.9, spreadHip: 3.4, spreadBlind: 5.2,   // grados
      recoil: 0.35, range: 80, pellets: 1, auto: true,
    },
    shotgun: {
      name: 'ESCOPETA', rpm: 95, dmg: 13, headMult: 1.0,
      mag: 8, reserve: 24, reloadTime: 2.1,
      spreadAim: 4.6, spreadHip: 6.4, spreadBlind: 8.0,
      recoil: 1.6, range: 24, pellets: 8, auto: false,
      falloffStart: 6, falloffEnd: 19,  // dmg pleno hasta start, 0 en end
      gibRange: 4.2,                    // one-shot gib si mata dentro de este rango
    },
  },
  combat: {
    spawnProtection: 5,   // seg de invulnerabilidad al nacer (se rompe al disparar)
    fireAlignMaxDeg: 115, // el tiro de cadera solo espera si el cuerpo apunta casi de espaldas a la cámara
    hp: 100,
    regenDelay: 3.6, regenRate: 48,
    respawnTime: 5,
    killLimit: 25,
  },
  net: {
    sendHz: 20, interpDelay: 0.12,
  },
};

// deep clone para reset del panel de tuning
export const TUNING_DEFAULTS = JSON.parse(JSON.stringify(TUNING));
