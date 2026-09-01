// Todos los valores de game feel viven aquí. F10 abre el panel en vivo (lil-gui).
// Unidades: metros, segundos, grados. Los lerp son "suavizado por segundo" (más alto = más rápido).

export const TUNING = {
  move: {
    runSpeed: 4.8,        // jog normal
    roadieSpeed: 7.6,     // velocidad de sprint (identificador interno legado)
    accel: 46,            // aceleración al empezar a moverse
    decel: 34,            // frenado al soltar
    turnLerp: 15,         // giro del personaje hacia la dirección de movimiento
    roadieTurnLerp: 6.5,  // el sprint gira con más peso
    coverStrafe: 3.5,     // velocidad lateral pegado a cobertura
    maxStepUp: 0.16,      // desnivel máximo automático; más alto exige mantle/salto
    groundStickDown: 0.24,// sigue pendientes descendentes sin microcaídas
    groundPitchLerp: 12,  // adaptación visual del cuerpo a la pendiente
  },
  evade: {
    diveSpeed: 8.2,       // dash/roll sin cobertura
    diveTime: 0.36,
    diveCancelPct: 0.5,   // % del dive tras el cual se puede cancelar en otro evade
    slideSpeed: 9.4,      // slide hacia cobertura
    slideMaxDist: 4.4,    // alcance de búsqueda de cobertura desde jog
    roadieSlideDist: 5.8, // alcance desde sprint
    bounceWindow: 0.30,   // seg tras tocar cover en los que evadir sale instantáneo
    bounceRange: 5.6,     // alcance de búsqueda de la siguiente cobertura al wallbouncear
    bounceCooldown: 0.06,
    chainSpeedBonus: 0.05,// % de velocidad extra por rebote encadenado
    chainMax: 5,
    momentumBoost: 0.22,  // % máx de impulso extra al evadir tras venir corriendo
    momentumRunTime: 0.45,// seg de carrera CONTINUA para el impulso pleno
    momentumRunDist: 3.2, // metros recorridos recientes para el pleno
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
    directAttachRange: 0.78, // más lejos entra mediante slide, no con corrección seca
    enterPullSpeed: 8.5,  // absorción rápida de la distancia restante al cover
    enterLerp: 18,
    enterMinTime: 0.07,
    enterMaxTime: 0.18,
    enterMomentumDamp: 12,// conserva brevemente momentum paralelo a la pared
    detachPush: 0.55,     // cuánto hay que empujar lejos del cover para soltarse
    detachTime: 0.11,
    cornerLean: 0.55,     // margen del borde para lean en esquinas
    lowHeight: 1.4,       // altura máxima que cuenta como cobertura baja (popover)
    edgeExitBoost: 0.85,  // % de runSpeed del impulso al salir por el extremo
    blindEnterRate: 34,   // brazos/arma salen rápido desde una orilla válida
    blindExitRate: 32,
    blindFireReady: 0.62, // clearance físico sigue siendo obligatorio
  },
  cam: {
    sens: 0.045,          // sensibilidad ratón (deg por pixel; ~360° en 20cm a 1000dpi)
    maxMouseStepDeg: 15,  // techo por frame contra deltas tardíos/acumulados de pointer-lock
    padSens: 170,         // sensibilidad stick derecho (deg por segundo a full)
    touchSens: 2.4,       // mirada táctil: factor sobre el pixel arrastrado
    zoomSens: 0.75,       // multiplicador adicional dentro del scope del sniper
    pitchMin: -62, pitchMax: 55,
    fovNormal: 57, fovRoadie: 57, fovAim: 41, // sin FOV kick al correr
    fovLerp: 9,
    posLerp: 11,          // seguimiento de posición
    rotLag: 0,            // reservado
    shoulder: 0.82,       // desplazamiento lateral sobre el hombro derecho
    height: 1.62, dist: 2.7,
    roadieHeight: 1.62, roadieDist: 2.7, // = cámara normal: correr NO mueve la cámara
    // ADS acerca y cierra el FOV, pero conserva una vista limpia por encima
    // del hombro. La cámara elige el objetivo central y el muzzle sigue siendo
    // el origen físico; cualquier geometría entre ambos detiene el disparo.
    // Encuadre tipo shooter over-the-shoulder: el personaje ocupa el tercio
    // izquierdo y el zoom favorece el espacio jugable, no su espalda.
    aimShoulder: 1.08, aimHeight: 1.60, aimDist: 2.2,
    coverDist: 3.0,
    shakeRoadie: 0,       // sin shake al correr (0 = apagado)
    shakeFire: 0.35,      // kick al disparar
    pitchRecoilRecover: 12, // retorno exponencial; ~90% en 0.2 s
    pitchRecoilMaxDeg: 4, // evita acumular elevación sin límite en automático
    minDist: 0.5,
  },
  // ADS: la cámara va ~0.3m por encima del cañón (medido: muzzle SMG ~1.22,
  // cámara ~1.51), así que un borde a la altura del pecho (pegado O a unos
  // metros) corta la línea del arma aunque el círculo vea libre. Ni la
  // retícula se mueve ni la bala nace "en los ojos" (vetado: se siente
  // trampa): el PERSONAJE levanta el arma lo justo para librar el borde; si
  // ni el tope libra, el arma se inclina y el gatillo queda inerte.
  // enabled 0 = comportamiento anterior (kill switch en vivo, F10).
  aimOver: {
    enabled: 1,
    // El paralaje cámara-arma sigue siendo de centímetros hasta media
    // distancia: 2.4 dejaba escapar estampados contra bordes a 3-4m.
    nearDist: 4,    // estorbos a menos de esto del cañón cuentan (m)
    maxLift: 0.34,  // tope del gesto: deja el muzzle ~altura de los ojos (m)
    rise: 14,       // subida exponencial (por segundo; rápida = menos espera del gatillo)
    fall: 7,        // bajada exponencial
  },
  weapons: {
    smg: {
      nameKey: 'weapon.smg', rpm: 620, dmg: 10, headMult: 1.6,
      mag: 50, reserve: 150, reloadTime: 1.9,
      spreadAim: 0.9, spreadHip: 3.4, spreadBlind: 5.2,   // grados
      recoil: 0.35, range: 80, pellets: 1, auto: true,
      // Conserva daño pleno en las distancias normales de combate y cae de
      // forma leve hasta 8 dmg en la sightline extrema del mapa más grande.
      falloffStart: 35, falloffEnd: 80, falloffMin: 0.8,
    },
    shotgun: {
      nameKey: 'weapon.shotgun', rpm: 95, dmg: 13, headMult: 1.0,
      mag: 8, reserve: 24, reloadTime: 0.46, perShell: true,
      spreadAim: 4.6, spreadHip: 6.4, spreadBlind: 8.0,
      recoil: 1.6, range: 24, pellets: 8, auto: false,
      falloffStart: 6, falloffEnd: 19,  // dmg pleno hasta start, 0 en end
      gibRange: 4.2,                    // one-shot gib si mata dentro de este rango
    },
    pistol: {
      nameKey: 'weapon.pistol', rpm: 260, dmg: 22, headMult: 2.0,
      mag: 12, reserve: 48, reloadTime: 1.35,
      spreadAim: 0.7, spreadHip: 2.4, spreadBlind: 4.2,
      recoil: 0.55, range: 60, pellets: 1, auto: false,
      oneHand: true,
    },
    grenade: {
      nameKey: 'weapon.grenade', rpm: 40, dmg: 0, headMult: 1,
      mag: 2, reserve: 0, reloadTime: 0,
      spreadAim: 0, spreadHip: 0, spreadBlind: 0,
      recoil: 0.2, range: 0, pellets: 0, auto: false,
      oneHand: true, thrown: true,
      throwSpeed: 12, throwUp: 4.2,   // velocidad inicial del lanzamiento
      throwTime: 0.5,                 // duración del gesto de lanzamiento
      throwRelease: 0.24,             // instante en que el bote sale de la mano
      fuse: 1.5,                      // seg desde el lanzamiento hasta activarse
      smokeTime: 7,                   // seg de nube plena
      smokeRadius: 2.9,               // radio de la nube (bloquea visión)
    },
    // Armas ESPECIALES de mapa: no van en el loadout inicial, se recogen en el
    // punto marcado del mapa (una por ronda, alternando) y su munición NO se
    // rellena en cajas.
    sniper: {
      nameKey: 'weapon.sniper', rpm: 34, dmg: 85, headMult: 2.2, // headshot letal
      mag: 1, reserve: 5, reloadTime: 1.7,
      // Dentro del scope, retícula y trayectoria son exactamente el mismo
      // rayo. Hip/blindfire conservan la imprecisión propia del power weapon.
      spreadAim: 0, spreadHip: 5.2, spreadBlind: 7.0,
      recoil: 2.4, range: 130, pellets: 1, auto: false,
      special: true,
      // mira telescópica: zoom real al apuntar (vs 41 normal). La cámara ya
      // escala la sensibilidad por FOV, así que el pulso fino sale solo.
      fovAim: 20,
    },
    bazooka: {
      nameKey: 'weapon.bazooka', rpm: 28, dmg: 115, headMult: 1,
      mag: 1, reserve: 2, reloadTime: 2.3,
      spreadAim: 0.4, spreadHip: 1.8, spreadBlind: 3.0,
      recoil: 2.8, range: 110, pellets: 1, auto: false,
      special: true, projectile: true,
      projSpeed: 26, splashRadius: 4.2, // el splash también daña al tirador
    },
  },
  melee: {
    dmg: 60,          // dos golpes matan a un rival sano
    range: 1.82,      // alcance físico desde el centro del atacante
    arcDeg: 108,      // arco tolerante, todavía inequívocamente frontal
    acquireArcDeg: 124, // cono donde puede ayudar a orientar, no lock-on
    assistDeg: 16,    // corrección máxima del cuerpo hacia cámara/objetivo
    assistTurnDeg: 300,
    time: 0.48,       // duración máxima: golpe fallado + recovery
    hitAt: 0.13,      // contacto temprano y reactivo
    hitRecovery: 0.21,
    killRecovery: 0.25,
    missRecovery: 0.35,
    hitStop: 0.035,   // pausa solo del gesto local; el mundo no se congela
    inputGuard: 0.045,// separa pulsaciones sin cooldown artificial largo
    lungeSpeed: 2.05,
    runLungeBonus: 0.8,
    maxLunge: 0.3,    // nunca es un dash ni magnetiza al blanco
    heightTolerance: 1.35,
    wallPadding: 0.18,
    botCooldownMin: 0.68,
    botCooldownMax: 1.05,
  },
  combat: {
    spawnProtection: 5,   // seg de invulnerabilidad al nacer (se rompe al disparar)
    // Cámara, cuerpo y arma comparten este margen. Fuera de él el input queda
    // bufereado mientras el cuerpo gira, en vez de disparar visualmente al revés.
    fireAlignMaxDeg: 50,
    visualAimMaxDeg: 52,  // giro máximo que compensa naturalmente el torso/arma
    bodyTurnAimDeg: 600,  // velocidad angular máxima apuntando/disparando
    bodyTurnBlindDeg: 420,// blindfire en cover: giro más pesado, nunca snap 180°
    bodyTurnFollowDeg: 360,
    hp: 100,
    botDamageScale: 0.7,
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
