// Localización central de todo texto visible. English es siempre el fallback
// y el idioma inicial cuando aún no existe una preferencia guardada.
export const LANGUAGES = Object.freeze([
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'ja', label: '日本語' },
  { code: 'it', label: 'Italiano' },
  { code: 'zh', label: '中文' },
]);

const en = {
  'common.enter': 'ENTER', 'common.preparing': 'PREPARING…', 'common.play': 'PLAY',
  'common.pause': 'PAUSE', 'common.resume': 'RESUME', 'common.back': 'BACK',
  'common.change': 'CHANGE', 'common.fullscreen': 'FULLSCREEN',
  'common.exitFullscreen': 'EXIT FULLSCREEN', 'common.character': 'CHARACTER',
  'common.controls': 'CONTROLS', 'common.reset': 'RESET', 'common.localSave': 'LOCAL SAVE',
  'menu.tagline': '4v4 · RED VS BLUE · v0.1', 'menu.selectMode': 'SELECT A MODE',
  'menu.currentMatch': 'CURRENT MATCH', 'menu.bots': 'VS BOTS (4v4)',
  'menu.botsSub': 'ROUND-BASED MATCH · BEST OF 3', 'menu.practice': 'PRACTICE',
  'menu.practiceSub': 'MOVING TARGETS · NO SCORE', 'menu.multiplayer': 'MULTIPLAYER',
  'menu.multiplayerSub': 'DIRECT SERVER CONNECTION', 'menu.preparation': 'LOADOUT',
  'menu.name': 'NAME', 'menu.map': 'MAP', 'menu.mapValue': 'MAP: {map}',
  'menu.mapNote': 'Affects VS Bots and Practice. Multiplayer uses Fortress.',
  'menu.server': 'MULTIPLAYER SERVER', 'menu.move': 'MOVE', 'menu.run': 'RUN',
  'menu.coverEvade': 'COVER / EVADE', 'menu.pauseHint': 'PAUSE',
  'menu.cosmetic': 'COSMETIC SELECTION', 'menu.sameHitbox': 'SAME HITBOX · SAME PROPORTIONS',
  'menu.characterTitle': 'CHARACTER', 'menu.chooseSoldier': 'CHOOSE YOUR SOLDIER',
  'menu.inputDevices': 'KEYBOARD AND CONTROLLER', 'menu.controlsTitle': 'CONTROLS',
  'menu.rebindHint': 'SELECT A BINDING, THEN PRESS A KEY OR BUTTON',
  'menu.keyboard': 'KEYBOARD', 'menu.controller': 'CONTROLLER',
  'menu.mouseSensitivity': 'MOUSE SENS.', 'menu.stickSensitivity': 'STICK SENS.',
  'menu.volumeMute': 'VOLUME (M TO MUTE)', 'menu.invertMouse': 'INVERT Y — MOUSE (F9)',
  'menu.invertController': 'INVERT Y — CONTROLLER', 'menu.noController': 'NO CONTROLLER DETECTED',
  'menu.language': 'LANGUAGE', 'menu.axes': 'AXES', 'menu.buttons': 'BUTTONS',
  'hud.red': 'RED', 'hud.blue': 'BLUE', 'hud.eliminations': 'KILLS', 'hud.lives': 'LIVES',
  'hud.scoreboard': 'SCOREBOARD', 'hud.pointsPerKill': '100 PTS PER KILL',
  'hud.teamRed': 'RED TEAM', 'hud.teamBlue': 'BLUE TEAM', 'hud.name': 'NAME',
  'hud.activeWeapon': 'ACTIVE WEAPON', 'hud.reserve': 'RESERVE',
  'hud.switching': 'SWITCHING WEAPON', 'hud.reloading': 'RELOADING', 'hud.noAmmo': 'NO AMMO',
  'hud.spectating': 'SPECTATING', 'hud.waitingTeammate': 'WAITING FOR TEAMMATE',
  'hud.respawning': 'RESPAWNING', 'hud.deployment': 'DEPLOYMENT',
  'hud.preparingCombat': 'PREPARING COMBAT', 'hud.getReady': 'GET READY',
  'hud.matchMvp': 'MATCH MVP', 'hud.result': 'RESULT', 'hud.kills': 'KILLS',
  'hud.deaths': 'DEATHS', 'hud.points': 'PTS', 'hud.you': 'YOU',
  'hud.waitingPlayers': 'WAITING FOR PLAYERS',
  'weapon.smg': 'SUBMACHINE GUN', 'weapon.shotgun': 'SHOTGUN',
  'map.fortaleza': 'FORTRESS', 'map.azoteas': 'ROOFTOPS',
  'mode.teamDeathmatch': 'TEAM DEATHMATCH', 'mode.teamDeathmatchShort': 'TDM',
  'flow.deploymentBots': 'DEPLOYMENT // VS BOTS', 'flow.bestOf3': 'BEST OF 3',
  'flow.livesPerTeam': '{count} LIVES PER TEAM', 'flow.round': 'ROUND {round}',
  'flow.scouting': 'SCOUTING THE BATTLEFIELD', 'flow.roundEnded': 'ROUND COMPLETE',
  'flow.roundFor': 'ROUND FOR {team}', 'flow.roundDraw': 'ROUND DRAW',
  'flow.nextDeployment': 'NEXT DEPLOYMENT SHORTLY', 'flow.matchEnded': 'MATCH COMPLETE',
  'flow.victory': 'VICTORY', 'flow.defeat': 'DEFEAT', 'flow.finalResult': 'FINAL RESULT',
  'flow.matchScore': 'MATCH SCORE', 'flow.winnerTeam': '{team} TEAM WINS',
  'flow.deploymentOnline': 'DEPLOYMENT // ONLINE', 'flow.firstTo': 'FIRST TO {count}',
  'flow.players': '{count}/8 PLAYERS', 'flow.syncing': 'SYNCING SQUADS',
  'flow.prepare': 'GET READY',
  'spectator.respawnsIn': 'RESPAWN IN {count}',
  'spectator.noRespawns': 'NO RESPAWNS · UNTIL ROUND END',
  'spectator.waitingRespawn': 'WAITING TO RESPAWN', 'spectator.switch': 'SWITCH',
  'spectator.noTeammates': 'NO ACTIVE TEAMMATES',
  'msg.bounce': 'BOUNCE ×{count}', 'msg.audioOn': 'AUDIO ON', 'msg.audioOff': 'AUDIO OFF',
  'msg.mouseAxis': 'MOUSE Y AXIS: {state}', 'msg.normal': 'NORMAL', 'msg.inverted': 'INVERTED',
  'msg.spawnProtection': 'SPAWN PROTECTION — BREAKS WHEN FIRING', 'msg.protectionBroken': 'PROTECTION BROKEN',
  'msg.noLives': 'NO LIVES', 'msg.waitRound': 'WAITING FOR ROUND END',
  'msg.scoreboardHint': 'TAB / VIEW: SCOREBOARD', 'msg.practice': 'PRACTICE',
  'msg.practiceSub': 'MOVING TARGETS ON THE BLUE SIDE',
  'msg.axisHint': 'Y AXIS: {state} — F9 TO CHANGE', 'msg.serverUrl': 'ENTER THE SERVER URL',
  'msg.connecting': 'CONNECTING…', 'msg.error': 'ERROR: {message}',
  'msg.joined': '{name} JOINED', 'msg.ammoFull': 'AMMO FULL',
  'msg.bulletsOf': '+{count} {weapon} ROUNDS', 'msg.controllerConnected': 'CONTROLLER CONNECTED',
  'msg.controllerDisconnected': 'CONTROLLER DISCONNECTED', 'msg.serverFull': 'SERVER FULL (8/8)',
  'msg.serverDisconnected': 'DISCONNECTED FROM SERVER',
  'binding.forward': 'FORWARD', 'binding.back': 'BACK', 'binding.left': 'LEFT',
  'binding.right': 'RIGHT', 'binding.sprint': 'RUN', 'binding.evade': 'COVER / EVADE',
  'binding.jump': 'JUMP', 'binding.reload': 'RELOAD', 'binding.swap': 'SWITCH WEAPON',
  'binding.score': 'SCOREBOARD', 'binding.aim': 'AIM', 'binding.fire': 'FIRE',
  'binding.pause': 'PAUSE', 'key.left': 'LEFT', 'key.right': 'RIGHT',
  'key.space': 'SPACE', 'key.arrow': 'ARROW', 'key.button': 'BTN',
  'character.0': 'RECRUIT', 'character.1': 'SENTINEL', 'character.2': 'SCOUT',
  'character.3': 'HEAVY', 'character.4': 'GHOST',
  'network.timeout': 'CONNECTION TIMED OUT', 'network.failed': 'COULD NOT CONNECT',
  'network.closed': 'CONNECTION CLOSED',
};

const es = {
  ...en,
  'common.enter': 'ENTRAR', 'common.preparing': 'PREPARANDO…', 'common.play': 'JUGAR',
  'common.pause': 'PAUSA', 'common.resume': 'REANUDAR', 'common.back': 'VOLVER',
  'common.change': 'CAMBIAR', 'common.fullscreen': 'PANTALLA COMPLETA',
  'common.exitFullscreen': 'SALIR DE PANTALLA COMPLETA', 'common.character': 'PERSONAJE',
  'common.controls': 'CONTROLES', 'common.reset': 'RESTABLECER', 'common.localSave': 'GUARDADO LOCAL',
  'menu.tagline': '4v4 · ROJO VS AZUL · v0.1', 'menu.selectMode': 'SELECCIONA UN MODO',
  'menu.currentMatch': 'PARTIDA ACTUAL', 'menu.bots': 'VS BOTS (4v4)',
  'menu.botsSub': 'PARTIDA POR RONDAS · MEJOR DE 3', 'menu.practice': 'PRÁCTICA',
  'menu.practiceSub': 'BLANCOS MÓVILES · SIN PUNTUACIÓN', 'menu.multiplayer': 'MULTIJUGADOR',
  'menu.multiplayerSub': 'CONEXIÓN DIRECTA A SERVIDOR', 'menu.preparation': 'PREPARACIÓN',
  'menu.name': 'NOMBRE', 'menu.map': 'MAPA', 'menu.mapValue': 'MAPA: {map}',
  'menu.mapNote': 'Afecta VS Bots y Práctica. Multijugador usa Fortaleza.',
  'menu.server': 'SERVIDOR MULTIJUGADOR', 'menu.move': 'MOVER', 'menu.run': 'CORRER',
  'menu.coverEvade': 'COBERTURA / EVADIR', 'menu.pauseHint': 'PAUSA',
  'menu.cosmetic': 'SELECCIÓN ESTÉTICA', 'menu.sameHitbox': 'MISMO HITBOX · MISMAS PROPORCIONES',
  'menu.characterTitle': 'PERSONAJE', 'menu.chooseSoldier': 'ELIGE TU SOLDADO',
  'menu.inputDevices': 'TECLADO Y CONTROL', 'menu.controlsTitle': 'CONTROLES',
  'menu.rebindHint': 'ELIGE UN BINDING Y PRESIONA UNA TECLA O BOTÓN',
  'menu.keyboard': 'TECLADO', 'menu.controller': 'CONTROL',
  'menu.mouseSensitivity': 'SENS. RATÓN', 'menu.stickSensitivity': 'SENS. STICK',
  'menu.volumeMute': 'VOLUMEN (M SILENCIA)', 'menu.invertMouse': 'EJE Y INVERTIDO — RATÓN (F9)',
  'menu.invertController': 'EJE Y INVERTIDO — CONTROL', 'menu.noController': 'SIN CONTROL DETECTADO',
  'menu.language': 'IDIOMA', 'menu.axes': 'EJES', 'menu.buttons': 'BOTONES',
  'hud.red': 'ROJO', 'hud.blue': 'AZUL', 'hud.eliminations': 'BAJAS', 'hud.lives': 'VIDAS',
  'hud.scoreboard': 'MARCADOR', 'hud.pointsPerKill': '100 PTS POR BAJA',
  'hud.teamRed': 'EQUIPO ROJO', 'hud.teamBlue': 'EQUIPO AZUL', 'hud.name': 'NOMBRE',
  'hud.activeWeapon': 'ARMA ACTIVA', 'hud.reserve': 'RESERVA',
  'hud.switching': 'CAMBIANDO ARMA', 'hud.reloading': 'RECARGANDO', 'hud.noAmmo': 'SIN MUNICIÓN',
  'hud.spectating': 'ESPECTANDO', 'hud.waitingTeammate': 'ESPERANDO COMPAÑERO',
  'hud.respawning': 'REAPARECIENDO', 'hud.deployment': 'DESPLIEGUE',
  'hud.preparingCombat': 'PREPARANDO COMBATE', 'hud.getReady': 'PREPÁRATE',
  'hud.matchMvp': 'MVP DE LA PARTIDA', 'hud.result': 'RESULTADO', 'hud.kills': 'BAJAS',
  'hud.deaths': 'MUERTES', 'hud.points': 'PTS', 'hud.you': 'TÚ',
  'hud.waitingPlayers': 'ESPERANDO JUGADORES',
  'weapon.smg': 'SUBFUSIL', 'weapon.shotgun': 'ESCOPETA',
  'map.fortaleza': 'FORTALEZA', 'map.azoteas': 'AZOTEAS',
  'mode.teamDeathmatch': 'MUERTE POR EQUIPOS', 'mode.teamDeathmatchShort': 'MPE',
  'flow.deploymentBots': 'DESPLIEGUE // VS BOTS', 'flow.bestOf3': 'MEJOR DE 3',
  'flow.livesPerTeam': '{count} VIDAS POR EQUIPO', 'flow.round': 'RONDA {round}',
  'flow.scouting': 'RECONOCIENDO EL CAMPO DE BATALLA', 'flow.roundEnded': 'FIN DE RONDA',
  'flow.roundFor': 'RONDA PARA {team}', 'flow.roundDraw': 'RONDA EMPATADA',
  'flow.nextDeployment': 'SIGUIENTE DESPLIEGUE EN BREVE', 'flow.matchEnded': 'PARTIDA TERMINADA',
  'flow.victory': 'VICTORIA', 'flow.defeat': 'DERROTA', 'flow.finalResult': 'RESULTADO FINAL',
  'flow.matchScore': 'MARCADOR DE LA PARTIDA', 'flow.winnerTeam': 'GANA EL EQUIPO {team}',
  'flow.deploymentOnline': 'DESPLIEGUE // ONLINE', 'flow.firstTo': 'PRIMERO A {count}',
  'flow.players': '{count}/8 JUGADORES', 'flow.syncing': 'SINCRONIZANDO ESCUADRAS',
  'flow.prepare': 'PREPÁRATE',
  'spectator.respawnsIn': 'REAPARECES EN {count}', 'spectator.noRespawns': 'SIN RESPAWNS · HASTA FIN DE RONDA',
  'spectator.waitingRespawn': 'ESPERANDO RESPAWN', 'spectator.switch': 'CAMBIAR',
  'spectator.noTeammates': 'SIN COMPAÑEROS ACTIVOS',
  'msg.bounce': 'REBOTE ×{count}', 'msg.audioOn': 'AUDIO ACTIVO', 'msg.audioOff': 'AUDIO SILENCIADO',
  'msg.mouseAxis': 'EJE Y RATÓN: {state}', 'msg.normal': 'NORMAL', 'msg.inverted': 'INVERTIDO',
  'msg.spawnProtection': 'PROTECCIÓN DE SPAWN — SE ROMPE AL DISPARAR', 'msg.protectionBroken': 'PROTECCIÓN ROTA',
  'msg.noLives': 'SIN VIDAS', 'msg.waitRound': 'ESPERANDO EL FINAL DE LA RONDA',
  'msg.scoreboardHint': 'TAB / VIEW: MARCADOR', 'msg.practice': 'PRÁCTICA',
  'msg.practiceSub': 'BLANCOS MÓVILES EN EL LADO AZUL', 'msg.axisHint': 'EJE Y: {state} — F9 CAMBIA',
  'msg.serverUrl': 'ESCRIBE LA URL DEL SERVIDOR', 'msg.connecting': 'CONECTANDO…',
  'msg.error': 'ERROR: {message}', 'msg.joined': '{name} ENTRÓ', 'msg.ammoFull': 'MUNICIÓN COMPLETA',
  'msg.bulletsOf': '+{count} BALAS DE {weapon}', 'msg.controllerConnected': 'CONTROL CONECTADO',
  'msg.controllerDisconnected': 'CONTROL DESCONECTADO', 'msg.serverFull': 'SERVIDOR LLENO (8/8)',
  'msg.serverDisconnected': 'DESCONECTADO DEL SERVIDOR',
  'binding.forward': 'ADELANTE', 'binding.back': 'ATRÁS', 'binding.left': 'IZQUIERDA',
  'binding.right': 'DERECHA', 'binding.sprint': 'CORRER', 'binding.evade': 'COBERTURA / EVADIR',
  'binding.jump': 'SALTAR', 'binding.reload': 'RECARGAR', 'binding.swap': 'CAMBIAR ARMA',
  'binding.score': 'MARCADOR', 'binding.aim': 'APUNTAR', 'binding.fire': 'DISPARAR',
  'binding.pause': 'PAUSA', 'key.left': 'IZQ', 'key.right': 'DER', 'key.space': 'ESPACIO',
  'key.arrow': 'FLECHA', 'key.button': 'BOTÓN',
  'character.0': 'RECLUTA', 'character.1': 'CENTINELA', 'character.2': 'EXPLORADOR',
  'character.3': 'PESADO', 'character.4': 'FANTASMA',
  'network.timeout': 'TIEMPO DE CONEXIÓN AGOTADO', 'network.failed': 'NO SE PUDO CONECTAR',
  'network.closed': 'CONEXIÓN CERRADA',
};

const pt = { ...en,
  'common.enter':'ENTRAR','common.preparing':'PREPARANDO…','common.play':'JOGAR','common.pause':'PAUSA','common.resume':'CONTINUAR','common.back':'VOLTAR','common.change':'ALTERAR','common.fullscreen':'TELA CHEIA','common.exitFullscreen':'SAIR DA TELA CHEIA','common.character':'PERSONAGEM','common.controls':'CONTROLES','common.reset':'REDEFINIR','common.localSave':'SALVO LOCALMENTE',
  'menu.tagline':'4v4 · VERMELHO VS AZUL · v0.1','menu.selectMode':'SELECIONE UM MODO','menu.currentMatch':'PARTIDA ATUAL','menu.bots':'VS BOTS (4v4)','menu.botsSub':'PARTIDA EM RODADAS · MELHOR DE 3','menu.practice':'TREINO','menu.practiceSub':'ALVOS MÓVEIS · SEM PONTUAÇÃO','menu.multiplayer':'MULTIJOGADOR','menu.multiplayerSub':'CONEXÃO DIRETA AO SERVIDOR','menu.preparation':'PREPARAÇÃO','menu.name':'NOME','menu.map':'MAPA','menu.mapValue':'MAPA: {map}','menu.mapNote':'Afeta VS Bots e Treino. O Multijogador usa Fortaleza.','menu.server':'SERVIDOR MULTIJOGADOR','menu.move':'MOVER','menu.run':'CORRER','menu.coverEvade':'COBERTURA / ESQUIVAR','menu.pauseHint':'PAUSA','menu.cosmetic':'SELEÇÃO VISUAL','menu.sameHitbox':'MESMO HITBOX · MESMAS PROPORÇÕES','menu.characterTitle':'PERSONAGEM','menu.chooseSoldier':'ESCOLHA SEU SOLDADO','menu.inputDevices':'TECLADO E CONTROLE','menu.controlsTitle':'CONTROLES','menu.rebindHint':'SELECIONE UM COMANDO E PRESSIONE UMA TECLA OU BOTÃO','menu.keyboard':'TECLADO','menu.controller':'CONTROLE','menu.mouseSensitivity':'SENS. DO MOUSE','menu.stickSensitivity':'SENS. DO ANALÓGICO','menu.volumeMute':'VOLUME (M SILENCIA)','menu.invertMouse':'INVERTER Y — MOUSE (F9)','menu.invertController':'INVERTER Y — CONTROLE','menu.noController':'NENHUM CONTROLE DETECTADO','menu.language':'IDIOMA','menu.axes':'EIXOS','menu.buttons':'BOTÕES',
  'hud.red':'VERMELHO','hud.blue':'AZUL','hud.eliminations':'ABATES','hud.lives':'VIDAS','hud.scoreboard':'PLACAR','hud.pointsPerKill':'100 PTS POR ABATE','hud.teamRed':'EQUIPE VERMELHA','hud.teamBlue':'EQUIPE AZUL','hud.name':'NOME','hud.activeWeapon':'ARMA ATIVA','hud.reserve':'RESERVA','hud.switching':'TROCANDO ARMA','hud.reloading':'RECARREGANDO','hud.noAmmo':'SEM MUNIÇÃO','hud.spectating':'OBSERVANDO','hud.waitingTeammate':'AGUARDANDO COMPANHEIRO','hud.respawning':'REAPARECENDO','hud.deployment':'POSICIONAMENTO','hud.preparingCombat':'PREPARANDO COMBATE','hud.getReady':'PREPARE-SE','hud.matchMvp':'MVP DA PARTIDA','hud.result':'RESULTADO','hud.kills':'ABATES','hud.deaths':'MORTES','hud.points':'PTS','hud.you':'VOCÊ','hud.waitingPlayers':'AGUARDANDO JOGADORES',
  'weapon.smg':'SUBMETRALHADORA','weapon.shotgun':'ESCOPETA','map.fortaleza':'FORTALEZA','map.azoteas':'TELHADOS','mode.teamDeathmatch':'MATA-MATA EM EQUIPE','mode.teamDeathmatchShort':'MME',
  'flow.deploymentBots':'POSICIONAMENTO // VS BOTS','flow.bestOf3':'MELHOR DE 3','flow.livesPerTeam':'{count} VIDAS POR EQUIPE','flow.round':'RODADA {round}','flow.scouting':'RECONHECENDO O CAMPO DE BATALHA','flow.roundEnded':'FIM DA RODADA','flow.roundFor':'RODADA PARA {team}','flow.roundDraw':'RODADA EMPATADA','flow.nextDeployment':'PRÓXIMO POSICIONAMENTO EM BREVE','flow.matchEnded':'PARTIDA ENCERRADA','flow.victory':'VITÓRIA','flow.defeat':'DERROTA','flow.finalResult':'RESULTADO FINAL','flow.matchScore':'PLACAR DA PARTIDA','flow.winnerTeam':'EQUIPE {team} VENCE','flow.deploymentOnline':'POSICIONAMENTO // ONLINE','flow.firstTo':'PRIMEIRO A {count}','flow.players':'{count}/8 JOGADORES','flow.syncing':'SINCRONIZANDO EQUIPES','flow.prepare':'PREPARE-SE',
  'spectator.respawnsIn':'REAPARECE EM {count}','spectator.noRespawns':'SEM REAPARECIMENTOS · ATÉ O FIM DA RODADA','spectator.waitingRespawn':'AGUARDANDO REAPARECER','spectator.switch':'TROCAR','spectator.noTeammates':'SEM COMPANHEIROS ATIVOS',
  'msg.bounce':'REBOTE ×{count}','msg.audioOn':'ÁUDIO LIGADO','msg.audioOff':'ÁUDIO DESLIGADO','msg.mouseAxis':'EIXO Y DO MOUSE: {state}','msg.normal':'NORMAL','msg.inverted':'INVERTIDO','msg.spawnProtection':'PROTEÇÃO INICIAL — TERMINA AO ATIRAR','msg.protectionBroken':'PROTEÇÃO ENCERRADA','msg.noLives':'SEM VIDAS','msg.waitRound':'AGUARDANDO O FIM DA RODADA','msg.scoreboardHint':'TAB / VIEW: PLACAR','msg.practice':'TREINO','msg.practiceSub':'ALVOS MÓVEIS NO LADO AZUL','msg.axisHint':'EIXO Y: {state} — F9 ALTERA','msg.serverUrl':'DIGITE A URL DO SERVIDOR','msg.connecting':'CONECTANDO…','msg.error':'ERRO: {message}','msg.joined':'{name} ENTROU','msg.ammoFull':'MUNIÇÃO COMPLETA','msg.bulletsOf':'+{count} CARTUCHOS DE {weapon}','msg.controllerConnected':'CONTROLE CONECTADO','msg.controllerDisconnected':'CONTROLE DESCONECTADO','msg.serverFull':'SERVIDOR LOTADO (8/8)','msg.serverDisconnected':'DESCONECTADO DO SERVIDOR',
  'binding.forward':'FRENTE','binding.back':'TRÁS','binding.left':'ESQUERDA','binding.right':'DIREITA','binding.sprint':'CORRER','binding.evade':'COBERTURA / ESQUIVAR','binding.jump':'PULAR','binding.reload':'RECARREGAR','binding.swap':'TROCAR ARMA','binding.score':'PLACAR','binding.aim':'MIRAR','binding.fire':'ATIRAR','binding.pause':'PAUSA','key.left':'ESQ','key.right':'DIR','key.space':'ESPAÇO','key.arrow':'SETA','key.button':'BOTÃO','character.0':'RECRUTA','character.1':'SENTINELA','character.2':'BATEDOR','character.3':'PESADO','character.4':'FANTASMA','network.timeout':'TEMPO DE CONEXÃO ESGOTADO','network.failed':'NÃO FOI POSSÍVEL CONECTAR','network.closed':'CONEXÃO ENCERRADA',
};

const fr = { ...en,
  'common.enter':'ENTRER','common.preparing':'PRÉPARATION…','common.play':'JOUER','common.pause':'PAUSE','common.resume':'REPRENDRE','common.back':'RETOUR','common.change':'CHANGER','common.fullscreen':'PLEIN ÉCRAN','common.exitFullscreen':'QUITTER LE PLEIN ÉCRAN','common.character':'PERSONNAGE','common.controls':'COMMANDES','common.reset':'RÉINITIALISER','common.localSave':'SAUVEGARDE LOCALE',
  'menu.tagline':'4v4 · ROUGE VS BLEU · v0.1','menu.selectMode':'CHOISISSEZ UN MODE','menu.currentMatch':'PARTIE EN COURS','menu.bots':'VS BOTS (4v4)','menu.botsSub':'PARTIE PAR MANCHES · 2 SUR 3','menu.practice':'ENTRAÎNEMENT','menu.practiceSub':'CIBLES MOBILES · SANS SCORE','menu.multiplayer':'MULTIJOUEUR','menu.multiplayerSub':'CONNEXION DIRECTE AU SERVEUR','menu.preparation':'PRÉPARATION','menu.name':'NOM','menu.map':'CARTE','menu.mapValue':'CARTE : {map}','menu.mapNote':'Affecte VS Bots et Entraînement. Le multijoueur utilise Forteresse.','menu.server':'SERVEUR MULTIJOUEUR','menu.move':'SE DÉPLACER','menu.run':'COURIR','menu.coverEvade':'COUVERTURE / ESQUIVE','menu.pauseHint':'PAUSE','menu.cosmetic':'SÉLECTION VISUELLE','menu.sameHitbox':'MÊME HITBOX · MÊMES PROPORTIONS','menu.characterTitle':'PERSONNAGE','menu.chooseSoldier':'CHOISISSEZ VOTRE SOLDAT','menu.inputDevices':'CLAVIER ET MANETTE','menu.controlsTitle':'COMMANDES','menu.rebindHint':'CHOISISSEZ UNE COMMANDE PUIS APPUYEZ SUR UNE TOUCHE','menu.keyboard':'CLAVIER','menu.controller':'MANETTE','menu.mouseSensitivity':'SENS. SOURIS','menu.stickSensitivity':'SENS. STICK','menu.volumeMute':'VOLUME (M COUPE LE SON)','menu.invertMouse':'INVERSER Y — SOURIS (F9)','menu.invertController':'INVERSER Y — MANETTE','menu.noController':'AUCUNE MANETTE DÉTECTÉE','menu.language':'LANGUE','menu.axes':'AXES','menu.buttons':'BOUTONS',
  'hud.red':'ROUGE','hud.blue':'BLEU','hud.eliminations':'ÉLIM.','hud.lives':'VIES','hud.scoreboard':'TABLEAU DES SCORES','hud.pointsPerKill':'100 PTS PAR ÉLIM.','hud.teamRed':'ÉQUIPE ROUGE','hud.teamBlue':'ÉQUIPE BLEUE','hud.name':'NOM','hud.activeWeapon':'ARME ACTIVE','hud.reserve':'RÉSERVE','hud.switching':'CHANGEMENT D’ARME','hud.reloading':'RECHARGEMENT','hud.noAmmo':'SANS MUNITIONS','hud.spectating':'SPECTATEUR','hud.waitingTeammate':'EN ATTENTE D’UN ALLIÉ','hud.respawning':'RÉAPPARITION','hud.deployment':'DÉPLOIEMENT','hud.preparingCombat':'PRÉPARATION DU COMBAT','hud.getReady':'PRÉPAREZ-VOUS','hud.matchMvp':'MVP DE LA PARTIE','hud.result':'RÉSULTAT','hud.kills':'ÉLIM.','hud.deaths':'MORTS','hud.points':'PTS','hud.you':'VOUS','hud.waitingPlayers':'EN ATTENTE DE JOUEURS',
  'weapon.smg':'PISTOLET-MITRAILLEUR','weapon.shotgun':'FUSIL À POMPE','map.fortaleza':'FORTERESSE','map.azoteas':'TOITS','mode.teamDeathmatch':'MATCH À MORT PAR ÉQUIPE','mode.teamDeathmatchShort':'MME',
  'flow.deploymentBots':'DÉPLOIEMENT // VS BOTS','flow.bestOf3':'2 SUR 3','flow.livesPerTeam':'{count} VIES PAR ÉQUIPE','flow.round':'MANCHE {round}','flow.scouting':'RECONNAISSANCE DU CHAMP DE BATAILLE','flow.roundEnded':'FIN DE MANCHE','flow.roundFor':'MANCHE POUR {team}','flow.roundDraw':'MANCHE NULLE','flow.nextDeployment':'PROCHAIN DÉPLOIEMENT SOUS PEU','flow.matchEnded':'PARTIE TERMINÉE','flow.victory':'VICTOIRE','flow.defeat':'DÉFAITE','flow.finalResult':'RÉSULTAT FINAL','flow.matchScore':'SCORE DE LA PARTIE','flow.winnerTeam':'L’ÉQUIPE {team} GAGNE','flow.deploymentOnline':'DÉPLOIEMENT // EN LIGNE','flow.firstTo':'PREMIER À {count}','flow.players':'{count}/8 JOUEURS','flow.syncing':'SYNCHRONISATION DES ÉQUIPES','flow.prepare':'PRÉPAREZ-VOUS',
  'spectator.respawnsIn':'RÉAPPARITION DANS {count}','spectator.noRespawns':'PLUS DE RÉAPPARITIONS · JUSQU’À LA FIN','spectator.waitingRespawn':'EN ATTENTE DE RÉAPPARITION','spectator.switch':'CHANGER','spectator.noTeammates':'AUCUN ALLIÉ ACTIF',
  'msg.bounce':'REBOND ×{count}','msg.audioOn':'SON ACTIVÉ','msg.audioOff':'SON COUPÉ','msg.mouseAxis':'AXE Y SOURIS : {state}','msg.normal':'NORMAL','msg.inverted':'INVERSÉ','msg.spawnProtection':'PROTECTION DE DÉPART — DISPARAÎT EN TIRANT','msg.protectionBroken':'PROTECTION TERMINÉE','msg.noLives':'PLUS DE VIES','msg.waitRound':'EN ATTENTE DE LA FIN DE MANCHE','msg.scoreboardHint':'TAB / VIEW : SCORES','msg.practice':'ENTRAÎNEMENT','msg.practiceSub':'CIBLES MOBILES CÔTÉ BLEU','msg.axisHint':'AXE Y : {state} — F9 POUR CHANGER','msg.serverUrl':'SAISISSEZ L’URL DU SERVEUR','msg.connecting':'CONNEXION…','msg.error':'ERREUR : {message}','msg.joined':'{name} A REJOINT','msg.ammoFull':'MUNITIONS COMPLÈTES','msg.bulletsOf':'+{count} CARTOUCHES DE {weapon}','msg.controllerConnected':'MANETTE CONNECTÉE','msg.controllerDisconnected':'MANETTE DÉCONNECTÉE','msg.serverFull':'SERVEUR COMPLET (8/8)','msg.serverDisconnected':'DÉCONNECTÉ DU SERVEUR',
  'binding.forward':'AVANCER','binding.back':'RECULER','binding.left':'GAUCHE','binding.right':'DROITE','binding.sprint':'COURIR','binding.evade':'COUVERTURE / ESQUIVE','binding.jump':'SAUTER','binding.reload':'RECHARGER','binding.swap':'CHANGER D’ARME','binding.score':'SCORES','binding.aim':'VISER','binding.fire':'TIRER','binding.pause':'PAUSE','key.left':'GAUCHE','key.right':'DROITE','key.space':'ESPACE','key.arrow':'FLÈCHE','key.button':'BOUTON','character.0':'RECRUE','character.1':'SENTINELLE','character.2':'ÉCLAIREUR','character.3':'LOURD','character.4':'FANTÔME','network.timeout':'DÉLAI DE CONNEXION DÉPASSÉ','network.failed':'CONNEXION IMPOSSIBLE','network.closed':'CONNEXION FERMÉE',
};

const it = { ...en,
  'common.enter':'ENTRA','common.preparing':'PREPARAZIONE…','common.play':'GIOCA','common.pause':'PAUSA','common.resume':'RIPRENDI','common.back':'INDIETRO','common.change':'CAMBIA','common.fullscreen':'SCHERMO INTERO','common.exitFullscreen':'ESCI DA SCHERMO INTERO','common.character':'PERSONAGGIO','common.controls':'COMANDI','common.reset':'RIPRISTINA','common.localSave':'SALVATAGGIO LOCALE',
  'menu.tagline':'4v4 · ROSSO VS BLU · v0.1','menu.selectMode':'SELEZIONA UNA MODALITÀ','menu.currentMatch':'PARTITA ATTUALE','menu.bots':'VS BOT (4v4)','menu.botsSub':'PARTITA A ROUND · AL MEGLIO DI 3','menu.practice':'ALLENAMENTO','menu.practiceSub':'BERSAGLI MOBILI · SENZA PUNTEGGIO','menu.multiplayer':'MULTIGIOCATORE','menu.multiplayerSub':'CONNESSIONE DIRETTA AL SERVER','menu.preparation':'PREPARAZIONE','menu.name':'NOME','menu.map':'MAPPA','menu.mapValue':'MAPPA: {map}','menu.mapNote':'Vale per VS Bot e Allenamento. Il multigiocatore usa Fortezza.','menu.server':'SERVER MULTIGIOCATORE','menu.move':'MUOVI','menu.run':'CORRI','menu.coverEvade':'COPERTURA / SCHIVA','menu.pauseHint':'PAUSA','menu.cosmetic':'SELEZIONE ESTETICA','menu.sameHitbox':'STESSA HITBOX · STESSE PROPORZIONI','menu.characterTitle':'PERSONAGGIO','menu.chooseSoldier':'SCEGLI IL TUO SOLDATO','menu.inputDevices':'TASTIERA E CONTROLLER','menu.controlsTitle':'COMANDI','menu.rebindHint':'SELEZIONA UN COMANDO E PREMI UN TASTO','menu.keyboard':'TASTIERA','menu.controller':'CONTROLLER','menu.mouseSensitivity':'SENS. MOUSE','menu.stickSensitivity':'SENS. STICK','menu.volumeMute':'VOLUME (M SILENZIA)','menu.invertMouse':'INVERTI Y — MOUSE (F9)','menu.invertController':'INVERTI Y — CONTROLLER','menu.noController':'NESSUN CONTROLLER RILEVATO','menu.language':'LINGUA','menu.axes':'ASSI','menu.buttons':'PULSANTI',
  'hud.red':'ROSSO','hud.blue':'BLU','hud.eliminations':'UCCISIONI','hud.lives':'VITE','hud.scoreboard':'CLASSIFICA','hud.pointsPerKill':'100 PT PER UCCISIONE','hud.teamRed':'SQUADRA ROSSA','hud.teamBlue':'SQUADRA BLU','hud.name':'NOME','hud.activeWeapon':'ARMA ATTIVA','hud.reserve':'RISERVA','hud.switching':'CAMBIO ARMA','hud.reloading':'RICARICA','hud.noAmmo':'SENZA MUNIZIONI','hud.spectating':'SPETTATORE','hud.waitingTeammate':'IN ATTESA DI UN COMPAGNO','hud.respawning':'RIENTRO','hud.deployment':'SCHIERAMENTO','hud.preparingCombat':'PREPARAZIONE AL COMBATTIMENTO','hud.getReady':'PREPARATI','hud.matchMvp':'MVP DELLA PARTITA','hud.result':'RISULTATO','hud.kills':'UCCISIONI','hud.deaths':'MORTI','hud.points':'PT','hud.you':'TU','hud.waitingPlayers':'IN ATTESA DI GIOCATORI',
  'weapon.smg':'MITRA','weapon.shotgun':'FUCILE A POMPA','map.fortaleza':'FORTEZZA','map.azoteas':'TETTI','mode.teamDeathmatch':'DEATHMATCH A SQUADRE','mode.teamDeathmatchShort':'SDM',
  'flow.deploymentBots':'SCHIERAMENTO // VS BOT','flow.bestOf3':'AL MEGLIO DI 3','flow.livesPerTeam':'{count} VITE PER SQUADRA','flow.round':'ROUND {round}','flow.scouting':'RICOGNIZIONE DEL CAMPO','flow.roundEnded':'FINE ROUND','flow.roundFor':'ROUND ALLA SQUADRA {team}','flow.roundDraw':'ROUND PAREGGIATO','flow.nextDeployment':'PROSSIMO SCHIERAMENTO A BREVE','flow.matchEnded':'PARTITA TERMINATA','flow.victory':'VITTORIA','flow.defeat':'SCONFITTA','flow.finalResult':'RISULTATO FINALE','flow.matchScore':'PUNTEGGIO PARTITA','flow.winnerTeam':'VINCE LA SQUADRA {team}','flow.deploymentOnline':'SCHIERAMENTO // ONLINE','flow.firstTo':'PRIMO A {count}','flow.players':'{count}/8 GIOCATORI','flow.syncing':'SINCRONIZZAZIONE SQUADRE','flow.prepare':'PREPARATI',
  'spectator.respawnsIn':'RIENTRO TRA {count}','spectator.noRespawns':'NESSUN RIENTRO · FINO A FINE ROUND','spectator.waitingRespawn':'IN ATTESA DI RIENTRARE','spectator.switch':'CAMBIA','spectator.noTeammates':'NESSUN COMPAGNO ATTIVO',
  'msg.bounce':'RIMBALZO ×{count}','msg.audioOn':'AUDIO ATTIVO','msg.audioOff':'AUDIO DISATTIVATO','msg.mouseAxis':'ASSE Y MOUSE: {state}','msg.normal':'NORMALE','msg.inverted':'INVERTITO','msg.spawnProtection':'PROTEZIONE INIZIALE — TERMINA SPARANDO','msg.protectionBroken':'PROTEZIONE TERMINATA','msg.noLives':'NESSUNA VITA','msg.waitRound':'IN ATTESA DI FINE ROUND','msg.scoreboardHint':'TAB / VIEW: CLASSIFICA','msg.practice':'ALLENAMENTO','msg.practiceSub':'BERSAGLI MOBILI SUL LATO BLU','msg.axisHint':'ASSE Y: {state} — F9 CAMBIA','msg.serverUrl':'INSERISCI L’URL DEL SERVER','msg.connecting':'CONNESSIONE…','msg.error':'ERRORE: {message}','msg.joined':'{name} È ENTRATO','msg.ammoFull':'MUNIZIONI COMPLETE','msg.bulletsOf':'+{count} COLPI PER {weapon}','msg.controllerConnected':'CONTROLLER CONNESSO','msg.controllerDisconnected':'CONTROLLER DISCONNESSO','msg.serverFull':'SERVER PIENO (8/8)','msg.serverDisconnected':'DISCONNESSO DAL SERVER',
  'binding.forward':'AVANTI','binding.back':'INDIETRO','binding.left':'SINISTRA','binding.right':'DESTRA','binding.sprint':'CORRI','binding.evade':'COPERTURA / SCHIVA','binding.jump':'SALTA','binding.reload':'RICARICA','binding.swap':'CAMBIA ARMA','binding.score':'CLASSIFICA','binding.aim':'MIRA','binding.fire':'SPARA','binding.pause':'PAUSA','key.left':'SIN','key.right':'DES','key.space':'SPAZIO','key.arrow':'FRECCIA','key.button':'PULSANTE','character.0':'RECLUTA','character.1':'SENTINELLA','character.2':'ESPLORATORE','character.3':'PESANTE','character.4':'FANTASMA','network.timeout':'TEMPO DI CONNESSIONE SCADUTO','network.failed':'CONNESSIONE NON RIUSCITA','network.closed':'CONNESSIONE CHIUSA',
};

const ja = { ...en,
  'common.enter':'開始','common.preparing':'準備中…','common.play':'プレイ','common.pause':'ポーズ','common.resume':'再開','common.back':'戻る','common.change':'変更','common.fullscreen':'全画面','common.exitFullscreen':'全画面を終了','common.character':'キャラクター','common.controls':'操作設定','common.reset':'リセット','common.localSave':'ローカル保存',
  'menu.tagline':'4対4 · レッド VS ブルー · v0.1','menu.selectMode':'モードを選択','menu.currentMatch':'現在のマッチ','menu.bots':'BOT戦 (4対4)','menu.botsSub':'ラウンド制 · 2本先取','menu.practice':'練習','menu.practiceSub':'移動ターゲット · スコアなし','menu.multiplayer':'マルチプレイヤー','menu.multiplayerSub':'サーバーへ直接接続','menu.preparation':'出撃準備','menu.name':'名前','menu.map':'マップ','menu.mapValue':'マップ：{map}','menu.mapNote':'BOT戦と練習に適用。マルチプレイヤーはフォートレスを使用。','menu.server':'マルチプレイヤーサーバー','menu.move':'移動','menu.run':'走る','menu.coverEvade':'カバー / 回避','menu.pauseHint':'ポーズ','menu.cosmetic':'外観選択','menu.sameHitbox':'同じ当たり判定 · 同じ体格','menu.characterTitle':'キャラクター','menu.chooseSoldier':'兵士を選択','menu.inputDevices':'キーボードとコントローラー','menu.controlsTitle':'操作設定','menu.rebindHint':'項目を選び、キーまたはボタンを押してください','menu.keyboard':'キーボード','menu.controller':'コントローラー','menu.mouseSensitivity':'マウス感度','menu.stickSensitivity':'スティック感度','menu.volumeMute':'音量（Mでミュート）','menu.invertMouse':'Y軸反転 — マウス (F9)','menu.invertController':'Y軸反転 — コントローラー','menu.noController':'コントローラー未検出','menu.language':'言語','menu.axes':'軸','menu.buttons':'ボタン',
  'hud.red':'レッド','hud.blue':'ブルー','hud.eliminations':'キル','hud.lives':'残機','hud.scoreboard':'スコアボード','hud.pointsPerKill':'1キル 100 PTS','hud.teamRed':'レッドチーム','hud.teamBlue':'ブルーチーム','hud.name':'名前','hud.activeWeapon':'使用中の武器','hud.reserve':'予備','hud.switching':'武器切替中','hud.reloading':'リロード中','hud.noAmmo':'弾薬なし','hud.spectating':'観戦中','hud.waitingTeammate':'味方を待機中','hud.respawning':'復活中','hud.deployment':'出撃','hud.preparingCombat':'戦闘準備中','hud.getReady':'準備せよ','hud.matchMvp':'マッチMVP','hud.result':'結果','hud.kills':'キル','hud.deaths':'デス','hud.points':'PTS','hud.you':'自分','hud.waitingPlayers':'プレイヤー待機中',
  'weapon.smg':'サブマシンガン','weapon.shotgun':'ショットガン','map.fortaleza':'フォートレス','map.azoteas':'屋上','mode.teamDeathmatch':'チームデスマッチ','mode.teamDeathmatchShort':'チーム戦',
  'flow.deploymentBots':'出撃 // BOT戦','flow.bestOf3':'2本先取','flow.livesPerTeam':'各チーム {count} 残機','flow.round':'ラウンド {round}','flow.scouting':'戦場を偵察中','flow.roundEnded':'ラウンド終了','flow.roundFor':'{team}チームがラウンド獲得','flow.roundDraw':'ラウンド引き分け','flow.nextDeployment':'まもなく次の出撃','flow.matchEnded':'マッチ終了','flow.victory':'勝利','flow.defeat':'敗北','flow.finalResult':'最終結果','flow.matchScore':'マッチスコア','flow.winnerTeam':'{team}チームの勝利','flow.deploymentOnline':'出撃 // オンライン','flow.firstTo':'{count}キル先取','flow.players':'{count}/8 プレイヤー','flow.syncing':'部隊を同期中','flow.prepare':'準備せよ',
  'spectator.respawnsIn':'復活まで {count}','spectator.noRespawns':'復活なし · ラウンド終了まで','spectator.waitingRespawn':'復活待機中','spectator.switch':'切替','spectator.noTeammates':'生存中の味方なし',
  'msg.bounce':'バウンス ×{count}','msg.audioOn':'オーディオ ON','msg.audioOff':'オーディオ OFF','msg.mouseAxis':'マウスY軸：{state}','msg.normal':'通常','msg.inverted':'反転','msg.spawnProtection':'出撃保護 — 発砲で解除','msg.protectionBroken':'保護解除','msg.noLives':'残機なし','msg.waitRound':'ラウンド終了を待機中','msg.scoreboardHint':'TAB / VIEW：スコアボード','msg.practice':'練習','msg.practiceSub':'ブルー側の移動ターゲット','msg.axisHint':'Y軸：{state} — F9で変更','msg.serverUrl':'サーバーURLを入力','msg.connecting':'接続中…','msg.error':'エラー：{message}','msg.joined':'{name} が参加','msg.ammoFull':'弾薬最大','msg.bulletsOf':'{weapon} +{count}発','msg.controllerConnected':'コントローラー接続','msg.controllerDisconnected':'コントローラー切断','msg.serverFull':'サーバー満員 (8/8)','msg.serverDisconnected':'サーバーから切断',
  'binding.forward':'前進','binding.back':'後退','binding.left':'左','binding.right':'右','binding.sprint':'走る','binding.evade':'カバー / 回避','binding.jump':'ジャンプ','binding.reload':'リロード','binding.swap':'武器切替','binding.score':'スコアボード','binding.aim':'照準','binding.fire':'射撃','binding.pause':'ポーズ','key.left':'左','key.right':'右','key.space':'スペース','key.arrow':'矢印','key.button':'ボタン','character.0':'新兵','character.1':'センチネル','character.2':'スカウト','character.3':'ヘビー','character.4':'ゴースト','network.timeout':'接続がタイムアウトしました','network.failed':'接続できませんでした','network.closed':'接続が終了しました',
};

const zh = { ...en,
  'common.enter':'进入','common.preparing':'准备中…','common.play':'开始游戏','common.pause':'暂停','common.resume':'继续','common.back':'返回','common.change':'更改','common.fullscreen':'全屏','common.exitFullscreen':'退出全屏','common.character':'角色','common.controls':'控制','common.reset':'重置','common.localSave':'本地保存',
  'menu.tagline':'4对4 · 红队 VS 蓝队 · v0.1','menu.selectMode':'选择模式','menu.currentMatch':'当前比赛','menu.bots':'对战机器人 (4对4)','menu.botsSub':'回合制 · 三局两胜','menu.practice':'训练','menu.practiceSub':'移动目标 · 不计分','menu.multiplayer':'多人游戏','menu.multiplayerSub':'直接连接服务器','menu.preparation':'战前准备','menu.name':'名称','menu.map':'地图','menu.mapValue':'地图：{map}','menu.mapNote':'用于机器人对战和训练。多人游戏使用要塞。','menu.server':'多人服务器','menu.move':'移动','menu.run':'奔跑','menu.coverEvade':'掩体 / 闪避','menu.pauseHint':'暂停','menu.cosmetic':'外观选择','menu.sameHitbox':'相同判定范围 · 相同比例','menu.characterTitle':'角色','menu.chooseSoldier':'选择你的士兵','menu.inputDevices':'键盘和控制器','menu.controlsTitle':'控制','menu.rebindHint':'选择绑定，然后按下按键或按钮','menu.keyboard':'键盘','menu.controller':'控制器','menu.mouseSensitivity':'鼠标灵敏度','menu.stickSensitivity':'摇杆灵敏度','menu.volumeMute':'音量（M 静音）','menu.invertMouse':'反转Y轴 — 鼠标 (F9)','menu.invertController':'反转Y轴 — 控制器','menu.noController':'未检测到控制器','menu.language':'语言','menu.axes':'轴','menu.buttons':'按钮',
  'hud.red':'红队','hud.blue':'蓝队','hud.eliminations':'击杀','hud.lives':'生命','hud.scoreboard':'记分板','hud.pointsPerKill':'每次击杀 100 分','hud.teamRed':'红队','hud.teamBlue':'蓝队','hud.name':'名称','hud.activeWeapon':'当前武器','hud.reserve':'备用','hud.switching':'正在切换武器','hud.reloading':'正在装填','hud.noAmmo':'弹药耗尽','hud.spectating':'观战中','hud.waitingTeammate':'等待队友','hud.respawning':'正在重生','hud.deployment':'部署','hud.preparingCombat':'准备战斗','hud.getReady':'准备','hud.matchMvp':'本场MVP','hud.result':'结果','hud.kills':'击杀','hud.deaths':'死亡','hud.points':'分','hud.you':'你','hud.waitingPlayers':'等待玩家',
  'weapon.smg':'冲锋枪','weapon.shotgun':'霰弹枪','map.fortaleza':'要塞','map.azoteas':'屋顶','mode.teamDeathmatch':'团队死斗','mode.teamDeathmatchShort':'团队战',
  'flow.deploymentBots':'部署 // 机器人对战','flow.bestOf3':'三局两胜','flow.livesPerTeam':'每队 {count} 条生命','flow.round':'第 {round} 回合','flow.scouting':'侦察战场','flow.roundEnded':'回合结束','flow.roundFor':'{team}赢得回合','flow.roundDraw':'回合平局','flow.nextDeployment':'即将开始下一次部署','flow.matchEnded':'比赛结束','flow.victory':'胜利','flow.defeat':'失败','flow.finalResult':'最终结果','flow.matchScore':'比赛得分','flow.winnerTeam':'{team}获胜','flow.deploymentOnline':'部署 // 在线','flow.firstTo':'先到 {count}','flow.players':'{count}/8 玩家','flow.syncing':'正在同步小队','flow.prepare':'准备',
  'spectator.respawnsIn':'{count} 后重生','spectator.noRespawns':'无法重生 · 直到回合结束','spectator.waitingRespawn':'等待重生','spectator.switch':'切换','spectator.noTeammates':'没有存活队友',
  'msg.bounce':'反弹 ×{count}','msg.audioOn':'音频开启','msg.audioOff':'音频关闭','msg.mouseAxis':'鼠标Y轴：{state}','msg.normal':'正常','msg.inverted':'反转','msg.spawnProtection':'出生保护 — 开火后解除','msg.protectionBroken':'保护已解除','msg.noLives':'生命耗尽','msg.waitRound':'等待回合结束','msg.scoreboardHint':'TAB / VIEW：记分板','msg.practice':'训练','msg.practiceSub':'蓝方移动目标','msg.axisHint':'Y轴：{state} — F9 更改','msg.serverUrl':'输入服务器地址','msg.connecting':'正在连接…','msg.error':'错误：{message}','msg.joined':'{name} 已加入','msg.ammoFull':'弹药已满','msg.bulletsOf':'{weapon} +{count} 发','msg.controllerConnected':'控制器已连接','msg.controllerDisconnected':'控制器已断开','msg.serverFull':'服务器已满 (8/8)','msg.serverDisconnected':'已断开服务器连接',
  'binding.forward':'前进','binding.back':'后退','binding.left':'左','binding.right':'右','binding.sprint':'奔跑','binding.evade':'掩体 / 闪避','binding.jump':'跳跃','binding.reload':'装填','binding.swap':'切换武器','binding.score':'记分板','binding.aim':'瞄准','binding.fire':'射击','binding.pause':'暂停','key.left':'左','key.right':'右','key.space':'空格','key.arrow':'方向键','key.button':'按钮','character.0':'新兵','character.1':'哨兵','character.2':'侦察兵','character.3':'重装兵','character.4':'幽灵','network.timeout':'连接超时','network.failed':'无法连接','network.closed':'连接已关闭',
};

const DICTIONARIES = Object.freeze({ en, es, pt, fr, ja, it, zh });
const valid = new Set(LANGUAGES.map((l) => l.code));
const storage = typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
const savedLanguage = storage?.getItem('breach.language');
let language = valid.has(savedLanguage) ? savedLanguage : 'en';
const listeners = new Set();

export function getLanguage() { return language; }

export function t(key, vars = {}) {
  let value = DICTIONARIES[language]?.[key] ?? en[key] ?? key;
  for (const [name, replacement] of Object.entries(vars)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

export function applyTranslations(root = globalThis.document) {
  if (!root || typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dataset.lang = language;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}

export function setLanguage(next) {
  if (!valid.has(next)) next = 'en';
  language = next;
  storage?.setItem('breach.language', language);
  applyTranslations();
  for (const listener of listeners) listener(language);
}

export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function translationAudit() {
  const required = Object.keys(en);
  return Object.fromEntries(Object.entries(DICTIONARIES).map(([code, dict]) => [
    code, required.filter((key) => dict[key] === undefined),
  ]));
}
