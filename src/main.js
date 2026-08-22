// BREACH — vertical slice. Orquesta mundo, jugador, combate, red y UI.
import * as THREE from 'three';
import GUI from 'lil-gui';
import { TUNING, TUNING_DEFAULTS } from './config/tuning.js';
import { BINDS, KB_LABELS, PAD_LABELS, keyLabel, padBtnName, loadBinds, saveBinds, resetBinds } from './core/bindings.js';
import { LANGUAGES, t, getLanguage, setLanguage, applyTranslations, onLanguageChange } from './core/i18n.js';
import { Input } from './core/input.js';
import { ShoulderCamera } from './core/camera.js';
import { World } from './world/world.js';
import { preloadUrbanAssets } from './world/urban-assets.js';
import { Rig, RAGDOLL_R } from './player/rig.js';
import { Controller, PLAYER_R } from './player/controller.js';
import { RemotePlayer } from './player/remote.js';
import { Dummies } from './player/practice.js';
import { Weapons } from './combat/weapons.js';
import { resolveShot, resolveGuidedShot, applySpread, applyPelletPattern } from './combat/ballistics.js';
import { damageFalloff, rocketSplashDamage } from './combat/damage.js';
import {
  deathImpactPoint, isSniperHeadshotDeath, rocketDeathLevel,
} from './combat/death-reactions.js';
import { muzzleHasClearance, segmentsHaveClearance } from './combat/cover-fire.js';
import { requiredFireBuffer } from './combat/fire-control.js';
import { Effects } from './fx/effects.js';
import { Audio, selectAudioListener } from './fx/audio.js';
import { HUD } from './ui/hud.js';
import { NetClient } from './net/client.js';
import { BotMatch } from './game/botmatch.js';
import { SmokeSystem } from './game/smoke.js';
import {
  mapLayoutId, isCustomLayout, getMap, listMaps, listPlayableMaps, footprint,
  exportableMap, serializeMap, parseMapFile,
} from './world/map-data.js';
import { SpecialPickup, Rockets, SPECIAL_HOLD_TIME } from './game/special.js';
import {
  DEFAULT_LOBBY_SETTINGS, MAPS, MAX_PLAYERS, TEAM_CAPACITY, makeBotName,
  nextLobbyMap, normalizeLobbySettings, validateLobby,
} from './game/lobby-rules.js';
import { AmmoCrates } from './game/crates.js';
import { WeaponDrops } from './game/drops.js';
import { LobbyUI } from './ui/lobby.js';
import { MenuControllerNavigator } from './ui/menu-controller.js';

applyTranslations();

const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };

// ---------- setup base ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// En pantallas táctiles/DPR alto, 2× cuadruplica el fill-rate sin aportar
// legibilidad al shooter. Escritorio conserva el máximo; móvil usa un techo
// más sensato y estable.
const coarseDisplay = matchMedia('(pointer: coarse)').matches;
const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, coarseDisplay ? 1.35 : 2);
// escala de render de Opciones → Video (persistida); 1 = resolución completa
let renderScale = parseFloat(localStorage.getItem('breach.video.scale') || '1') || 1;
renderer.setPixelRatio(BASE_PIXEL_RATIO * renderScale);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // bordes de sombra nítidos, sin suavizado

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.cam.fovNormal, 1, 0.1, 200);
// Antes de una partida, Azotea funciona como backdrop 3D deliberado del menú.
// Al jugar, setLayout reutiliza este mismo World con el mapa elegido.
const world = new World(scene, 'azoteas');
const effects = new Effects(scene, world);
const audio = new Audio();
const smoke = new SmokeSystem(scene, world, audio);
const specials = new SpecialPickup(scene);
const rockets = new Rockets(scene, world, audio);
audio.setAmbience('azoteas');
const hud = new HUD();
const input = new Input(canvas);
const shoulderCam = new ShoulderCamera(camera, world);
const MENU_CAM_POS = new THREE.Vector3(18, 7.2, -25.5);
const MENU_CAM_TARGET = new THREE.Vector3(3, 2.3, -1.5);
const menuCamTarget = new THREE.Vector3();

function updateMenuBackdrop(now = performance.now()) {
  const t = now * 0.00012;
  camera.position.set(
    MENU_CAM_POS.x + Math.sin(t) * 0.38,
    MENU_CAM_POS.y + Math.sin(t * 0.73) * 0.09,
    MENU_CAM_POS.z + Math.cos(t * 0.81) * 0.24,
  );
  menuCamTarget.copy(MENU_CAM_TARGET);
  menuCamTarget.y += Math.sin(t * 0.57) * 0.06;
  camera.lookAt(menuCamTarget);
  if (camera.fov !== 50) {
    camera.fov = 50;
    camera.updateProjectionMatrix();
  }
}

function showMenuBackdrop() {
  effects.clearImpacts();
  world.setLayout('azoteas');
  audio.setAmbience('azoteas');
  updateMenuBackdrop();
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- estado de juego ----------
const G = {
  scopeActive: false,    // estado derivado expuesto para HUD/diagnósticos
  fireBuffer: 0,       // click de disparo pendiente mientras el cuerpo gira
  pendingShots: 0,     // tiros aprobados que esperan la pose/muzzle de este frame
  pendingThrows: 0,    // granadas aprobadas que esperan la pose de este frame
  throwT: 0,           // gesto de lanzamiento en curso
  throwPending: false, // el bote aún no ha salido de la mano
  editorReturn: null,  // id del mapa en edición durante un playtest
  specialRound: 0,     // ronda cuyo arma especial ya fue colocada
  specialClaimT: 0,    // anti-spam del reclamo online del pedestal
  mode: null,          // null | 'practice' | 'online'
  rig: null,           // rig local
  player: null,        // controller local
  weapons: new Weapons(),
  dummies: null,
  botMatch: null,
  crates: null,
  drops: null,         // armas caídas de los muertos
  dropSeq: 0,
  spawnProt: 0,        // protección de spawn (5s, se rompe al disparar)
  respawnT: 0,         // countdown visible de reaparición
  playerLastHit: 99,
  remotes: new Map(),  // id -> RemotePlayer
  onlineRows: [],      // kills/deaths autoritativos expuestos por el servidor
  onlineStartAt: 0,    // epoch (s): el server bloquea combate hasta este instante
  onlineFinal: null,   // { team, rows, at } durante resultado/scoreboard/MVP
  onlineRoundResult: null,
  onlineSettings: { ...DEFAULT_LOBBY_SETTINGS },
  onlineWins: { red: 0, blue: 0 },
  onlinePhase: 'lobby',
  onlineBots: null,    // IA de bots autoritativa solo en el cliente host
  lobby: null,
  lobbyKind: null,
  flowLockedPrev: false,
  spectator: { active: false, targetId: null, deathHold: 0, first: true },
  net: null,
  selfHp: TUNING.combat.hp,
  selfAlive: true,
  scores: { red: 0, blue: 0 },
  team: 'red',
  name: 'CHUCK',
  charVariant: (() => {
    const v = parseInt(localStorage.getItem('breach.character'), 10);
    return v >= 0 && v <= 4 ? v : 0;
  })(),
  footAcc: 0,
  presentationAudioKey: '',
};

// los mapas del editor traen su propio nombre; los del juego pasan por i18n
const mapLabel = (map) => (isCustomLayout(map)
  ? (getMap(map)?.name ?? 'MAPA')
  : t(`map.${map || 'fortaleza'}`));
const teamLabel = (team) => t(team === 'red' ? 'hud.red' : 'hud.blue');
const INTRO_TIME = 10;
const COUNTDOWN_TIME = 3;
const FINAL_PRESENTATION_TIME = 11;
const matchCamTarget = new THREE.Vector3();
const spectatorCamPos = new THREE.Vector3();
const spectatorDesired = new THREE.Vector3();
const spectatorPivot = new THREE.Vector3();
const spectatorRay = new THREE.Vector3();

function matchControlsLocked() {
  if (G.mode === 'bots' && G.botMatch) return G.botMatch.controlsLocked();
  if (G.mode === 'online') {
    return !!G.onlineFinal || (G.onlineStartAt > Date.now() / 1000);
  }
  return false;
}

function mvpOf(rows) {
  return [...(rows || [])].sort((a, b) =>
    (b.score ?? b.kills * 100) - (a.score ?? a.kills * 100) ||
    (a.deaths ?? 0) - (b.deaths ?? 0) || String(a.name).localeCompare(String(b.name)))[0] || null;
}

function botPresentation() {
  const bm = G.botMatch;
  if (!bm) return null;
  const common = { rows: bm.statRows(), localId: 'player' };
  if (bm.phase === 'intro') return {
    phase: 'intro', kicker: t('flow.deploymentBots'), title: mapLabel(G.mapChoice),
    sub: t('mode.teamDeathmatch'), meta: [t('flow.bestOfN', { count: bm.roundLimit }), t('flow.livesPerTeam', { count: bm.livesPerTeam }), t('flow.round', { round: bm.round })],
    progress: 1 - bm.phaseT / INTRO_TIME, wait: t('flow.scouting'), ...common,
  };
  if (bm.phase === 'countdown') return {
    phase: 'countdown', count: Math.max(1, Math.ceil(bm.phaseT)), sub: t('flow.round', { round: bm.round }),
  };
  if (bm.phase === 'intermission') return {
    phase: 'final-score', kicker: t('flow.roundEnded'),
    title: bm.roundWinner ? t('flow.roundFor', { team: teamLabel(bm.roundWinner) }) : t('flow.roundDraw'),
    sub: t('flow.nextDeployment'), red: bm.wins.red, blue: bm.wins.blue, ...common,
  };
  if (bm.phase === 'final') {
    const elapsed = FINAL_PRESENTATION_TIME - bm.phaseT;
    const won = bm.matchWinner === G.team;
    if (elapsed < 2.8) return {
      phase: 'result', kicker: t('flow.matchEnded'), title: t(won ? 'flow.victory' : 'flow.defeat'),
      sub: t('flow.winnerTeam', { team: teamLabel(bm.matchWinner) }), red: bm.wins.red, blue: bm.wins.blue,
    };
    if (elapsed < 7.2) return {
      phase: 'final-score', kicker: t('flow.finalResult'), title: t(won ? 'flow.victory' : 'flow.defeat'),
      sub: t('flow.matchScore'), red: bm.wins.red, blue: bm.wins.blue, ...common,
    };
    const mvp = mvpOf(common.rows);
    return { phase: 'mvp', mvp, portrait: mvp ? renderCharacterPortrait(mvp.variant, mvp.team) : null };
  }
  return null;
}

function onlinePresentation(now = Date.now() / 1000) {
  if (G.mode !== 'online') return null;
  if (G.onlineRoundResult) {
    const r = G.onlineRoundResult;
    return { phase: 'final-score', kicker: t('flow.roundEnded'),
      title: t('flow.roundFor', { team: teamLabel(r.winner) }), sub: t('flow.nextDeployment'),
      red: r.wins.red, blue: r.wins.blue, rows: r.rows || G.onlineRows, localId: G.net?.id };
  }
  if (G.onlineFinal) {
    const f = G.onlineFinal;
    const elapsed = now - f.at;
    const won = f.team === G.team;
    if (elapsed < 2.8) return {
      phase: 'result', kicker: t('flow.matchEnded'), title: t(won ? 'flow.victory' : 'flow.defeat'),
      sub: t('flow.winnerTeam', { team: teamLabel(f.team) }), red: f.wins?.red ?? G.onlineWins.red, blue: f.wins?.blue ?? G.onlineWins.blue,
    };
    if (elapsed < 7.2) return {
      phase: 'final-score', kicker: t('flow.finalResult'), title: t(won ? 'flow.victory' : 'flow.defeat'),
      sub: t('flow.matchScore'), red: f.wins?.red ?? G.onlineWins.red, blue: f.wins?.blue ?? G.onlineWins.blue,
      rows: f.rows || G.onlineRows, localId: G.net?.id,
    };
    const mvp = mvpOf(f.rows || G.onlineRows);
    return { phase: 'mvp', mvp, portrait: mvp ? renderCharacterPortrait(mvp.variant, mvp.team) : null };
  }
  const remain = G.onlineStartAt - now;
  if (remain <= 0) return null;
  if (remain > COUNTDOWN_TIME) return {
    phase: 'intro', kicker: t('flow.deploymentOnline'), title: mapLabel(G.onlineSettings.map), sub: t('mode.teamDeathmatch'),
    meta: [t('flow.bestOfN', { count: G.onlineSettings.rounds }), t('flow.livesPerTeam', { count: G.onlineSettings.lives }), t('flow.players', { count: G.onlineRows.length })],
    progress: 1 - (remain - COUNTDOWN_TIME) / INTRO_TIME, wait: t('flow.syncing'),
    rows: G.onlineRows, localId: G.net?.id,
  };
  return { phase: 'countdown', count: Math.max(1, Math.ceil(remain)), sub: t('flow.prepare') };
}

function activePresentation(now = Date.now() / 1000) {
  return G.mode === 'bots' ? botPresentation() : onlinePresentation(now);
}

function updatePresentationAudio(view) {
  const key = !view ? 'gameplay' : view.phase === 'countdown'
    ? `countdown:${view.count}`
    : view.phase;
  if (key === G.presentationAudioKey) return;
  const previous = G.presentationAudioKey;
  G.presentationAudioKey = key;
  if (view?.phase === 'countdown') audio.countdown(view.count);
  else if (view?.phase === 'result') {
    const won = G.mode === 'bots'
      ? G.botMatch?.matchWinner === G.team
      : G.onlineFinal?.team === G.team;
    if (won) audio.win(); else audio.defeat();
  } else if (view?.phase === 'final-score' && previous !== 'result') audio.roundEnd();
  else if (view?.phase === 'mvp') audio.mvp();
}

function updateMatchCamera(now, view) {
  const t = now * 0.00011;
  // la órbita de presentación escala con el mapa REAL en pantalla: mapas
  // grandes suben y alejan la cámara; chicos la acercan
  const radiusX = Math.min(world.fx + 5, 34);
  const radiusZ = Math.min(world.fz + 4, 42);
  const wide = Math.max(world.fx, world.fz) > 28;
  const baseY = wide ? 10.5 : 8.8;
  const side = view?.phase === 'mvp' ? -1 : 1;
  camera.position.set(Math.sin(t) * radiusX * side, baseY + Math.sin(t * .7) * .5, Math.cos(t) * radiusZ);
  matchCamTarget.set(0, wide ? 1.3 : 1.7, 0);
  camera.lookAt(matchCamTarget);
  if (Math.abs(camera.fov - 52) > .01) { camera.fov = 52; camera.updateProjectionMatrix(); }
}

function spectatorTargets() {
  const targets = [];
  if (G.botMatch) {
    for (const b of G.botMatch.bots) if (b.team === G.team && b.alive) targets.push({
      id: b.id, name: b.name, x: b.pos.x, z: b.pos.z, y: b.y || 0, yaw: b.yaw || 0,
    });
  }
  for (const r of G.remotes.values()) if (r.team === G.team && r.alive) targets.push({
    id: r.id, name: r.name, x: r.x, z: r.z, y: r.y || 0, yaw: r.yaw || 0,
  });
  return targets;
}

function spectatorTarget() {
  const list = spectatorTargets();
  if (!list.length) { G.spectator.targetId = null; return null; }
  let target = list.find((t) => t.id === G.spectator.targetId);
  if (!target) {
    target = list[0];
    G.spectator.targetId = target.id;
    G.spectator.first = true;
  }
  return target;
}

function cycleSpectator(dir) {
  const list = spectatorTargets();
  if (list.length < 2) return;
  const current = Math.max(0, list.findIndex((t) => t.id === G.spectator.targetId));
  const next = (current + dir + list.length) % list.length;
  G.spectator.targetId = list[next].id;
  G.spectator.first = true;
}

function enterSpectator() {
  G.spectator.active = true;
  G.spectator.targetId = null;
  G.spectator.deathHold = 1.15;
  G.spectator.first = true;
  spectatorCamPos.copy(camera.position);
  hud.spectator(null); // primero deja respirar a la reacción de muerte
}

function exitSpectator() {
  if (!G.spectator.active) return;
  G.spectator.active = false;
  G.spectator.targetId = null;
  G.spectator.deathHold = 0;
  G.spectator.first = true;
  // La shoulder camera parte de la última posición observada y converge al
  // spawn; así el respawn no corta de golpe a otra punta del mapa.
  shoulderCam.pos.copy(camera.position);
  shoulderCam._first = false;
  hud.spectator(null);
}

function resetSpectator() {
  G.spectator.active = false;
  G.spectator.targetId = null;
  G.spectator.deathHold = 0;
  G.spectator.first = true;
  hud.spectator(null);
}

function spectatorView() {
  if (!G.spectator.active || G.spectator.deathHold > 0) return null;
  const target = spectatorTarget();
  let respawn = '';
  if (G.respawnT > 0) respawn = t('spectator.respawnsIn', { count: Math.ceil(G.respawnT) });
  else if (G.mode === 'bots' && G.botMatch?.pool[G.team] <= 0) respawn = t('spectator.noRespawns');
  else if (!G.selfAlive) respawn = t('spectator.waitingRespawn');
  return {
    name: target?.name || t('hud.waitingTeammate'),
    controls: target
      ? `${keyLabel(BINDS.kb.swap)}/${keyLabel(BINDS.kb.reload)} · ${padBtnName(BINDS.pad.reload)} ${t('spectator.switch')}`
      : t('spectator.noTeammates'),
    respawn,
    ready: G.respawnT > 0 && G.respawnT <= 1,
  };
}

function updateSpectatorCamera(dt, now) {
  if (G.spectator.deathHold > 0) {
    shoulderCam.update(dt, G.player);
    return;
  }
  const target = spectatorTarget();
  if (!target) {
    updateMatchCamera(now, { phase: 'result' });
    return;
  }
  spectatorPivot.set(target.x, target.y + 1.28, target.z);
  const sy = Math.sin(target.yaw), cy = Math.cos(target.yaw);
  spectatorDesired.set(
    spectatorPivot.x + sy * 4.6 + cy * .72,
    spectatorPivot.y + 1.45,
    spectatorPivot.z + cy * 4.6 - sy * .72,
  );
  spectatorRay.copy(spectatorDesired).sub(spectatorPivot);
  const len = spectatorRay.length();
  if (len > .01) {
    spectatorRay.multiplyScalar(1 / len);
    const hit = world.raycast(spectatorPivot, spectatorRay, len + .2, .24);
    if (hit !== null && hit < len) {
      spectatorDesired.copy(spectatorPivot).addScaledVector(spectatorRay, Math.max(.75, hit - .16));
    }
  }
  if (G.spectator.first) {
    spectatorCamPos.copy(camera.position);
    G.spectator.first = false;
  }
  spectatorCamPos.lerp(spectatorDesired, 1 - Math.exp(-7.5 * dt));
  camera.position.copy(spectatorCamPos);
  camera.lookAt(spectatorPivot);
  camera.fov += (58 - camera.fov) * (1 - Math.exp(-8 * dt));
  camera.updateProjectionMatrix();
}

// El listener sigue al pecho del jugador, mientras la lateralidad sigue la
// cámara (lo que el jugador percibe como izquierda/derecha). Un ray corto
// contra el mundo alimenta la oclusión; se ignora el último tramo para no
// confundir la propia cobertura del emisor con una pared intermedia.
const audioOccOrigin = new THREE.Vector3();
const audioOccDir = new THREE.Vector3();
const audioListenerRight = new THREE.Vector3();
audio.setSpatialContext(
  () => {
    if (!G.player) return null;
    // Al espectar, cámara y listener son literalmente la misma referencia.
    // El callback se evalúa en cada evento, así que cycling y muerte del
    // observado actualizan el espacio sonoro en el mismo frame que la cámara.
    if (G.spectator.active && G.spectator.deathHold <= 0) {
      audioListenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      const rl = Math.max(0.001, Math.hypot(audioListenerRight.x, audioListenerRight.z));
      return selectAudioListener(true, {
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
        right: { x: audioListenerRight.x / rl, z: audioListenerRight.z / rl },
      }, null);
    }
    return selectAudioListener(false, null, {
      x: G.player.pos.x,
      y: (G.player.y ?? 0) + 1.15,
      z: G.player.pos.z,
      right: shoulderCam.flatRight(),
    });
  },
  (source, listener) => {
    audioOccOrigin.set(listener.x, listener.y, listener.z);
    audioOccDir.set(source.x - listener.x, source.y - listener.y, source.z - listener.z);
    const distance = audioOccDir.length();
    if (distance < 1.5) return false;
    audioOccDir.multiplyScalar(1 / distance);
    const hit = world.raycast(audioOccOrigin, audioOccDir, distance, 0.04);
    return hit !== null && hit < distance - 0.6;
  },
);

// ---------- eventos del controller (feel: sonido + polvo + shake) ----------
const ctrlEvents = {
  onSlideStart: () => { audio.whoosh(); },
  onCoverEnter: () => {
    audio.thump();
    shoulderCam.addShake(0.35);
    input.pad.rumble(60, 0.15, 0.4);
    if (G.player) effects.dust(G.player.pos);
  },
  onBounce: (chain) => {
    audio.whoosh();
    if (G.player) effects.dust(G.player.pos);
    if (chain >= 2) hud.hint(t('msg.bounce', { count: chain }), 700);
  },
  onDive: () => { audio.whoosh(); },
  onJump: () => { audio.jump(); },
  onDoubleJump: () => {
    audio.whoosh();
    input.pad.rumble(50, 0.2, 0.35);
  },
  onWallJump: () => {
    audio.whoosh();
    audio.jump();
    input.pad.rumble(70, 0.25, 0.45);
    if (G.player) effects.dust(G.player.pos);
  },
  onLand: () => {
    audio.land();
    if (G.player) effects.dust(G.player.pos);
  },
  onMantle: () => {
    audio.footstep('jump', 0.9);
    audio.whoosh();
  },
  onMeleeStart: () => {
    // El golpe tiene prioridad sobre una recarga, pero no inventa munición:
    // conserva cargador/reserva exactamente donde estaban.
    G.weapons?.interruptReload?.();
    G.fireBuffer = 0;
  },
};

// ---------- menú ----------
loadBinds();
{
  // clamp a los rangos de los sliders: un valor corrupto guardado no puede
  // dejar la sensibilidad microscópica/gigante
  const sm = parseFloat(localStorage.getItem('breach.sens.mouse'));
  if (sm > 0) TUNING.cam.sens = Math.min(0.12, Math.max(0.01, sm));
  const sp = parseFloat(localStorage.getItem('breach.sens.pad'));
  if (sp > 0) TUNING.cam.padSens = Math.min(320, Math.max(60, sp));
  const sz = parseFloat(localStorage.getItem('breach.sens.zoom'));
  if (sz > 0) TUNING.cam.zoomSens = Math.min(1.25, Math.max(0.35, sz));
}

const inName = document.getElementById('in-name');
const inServer = document.getElementById('in-server');
const netStatus = document.getElementById('net-status');
const splash = document.getElementById('splash');
const btnEnter = document.getElementById('btn-enter');
inName.value = localStorage.getItem('breach.name') || 'CHUCK';
const isSecure = location.protocol === 'https:';
inServer.value = localStorage.getItem('breach.server') ||
  (isSecure ? '' : `ws://${location.hostname}:8787`);

const mainCard = document.getElementById('main-card');
const controlsCard = document.getElementById('controls-card');
const btnResume = document.getElementById('btn-resume');
const menuPrompts = document.getElementById('menu-prompts');
let menuNavigator = null;

// El editor es una herramienta de autoría, no parte del juego distribuido.
// Usar únicamente DEV permite a Vite eliminar también sus imports/chunks del
// build de producción; no basta con esconder el botón en runtime.
const editorLocalOnly = import.meta.env.DEV;
let btnEditor = null;
if (editorLocalOnly) {
  btnEditor = document.createElement('button');
  btnEditor.className = 'btn';
  btnEditor.id = 'btn-editor';
  btnEditor.textContent = 'MAP EDITOR';
  document.getElementById('btn-fullscreen')?.before(btnEditor);
}

function dismissSplash() { splash.classList.add('off'); }
let preparePromise = null;
function prepareGame() {
  if (preparePromise) return preparePromise;
  // AudioContext debe crearse sincrónicamente dentro del gesto del usuario.
  const audioReady = audio.prepare();
  preparePromise = (async () => {
    await new Promise(requestAnimationFrame); // pintar PREPARANDO antes del trabajo GPU
    await Promise.all([audioReady, effects.prepare(renderer, camera), preloadUrbanAssets()]);
    await new Promise(requestAnimationFrame);
  })();
  return preparePromise;
}
btnEnter.addEventListener('click', async () => {
  if (btnEnter.disabled) return;
  btnEnter.disabled = true;
  btnEnter.textContent = t('common.preparing');
  try { await prepareGame(); }
  catch (e) { console.warn('Warm-up parcial:', e); }
  dismissSplash();
  btnEnter.textContent = t('common.enter');
  inName.focus();
  inName.select();
});
btnEnter.focus();

const menuIsOpen = () => !hud.el.menu.classList.contains('off');

let lastUiHover = null;
document.addEventListener('pointerover', (e) => {
  const button = e.target.closest?.('button:not(:disabled)');
  if (!button || button === lastUiHover || !menuIsOpen()) return;
  lastUiHover = button;
  audio.uiMove();
});
document.addEventListener('pointerout', (e) => {
  if (lastUiHover && !lastUiHover.contains(e.relatedTarget)) lastUiHover = null;
});
document.addEventListener('click', (e) => {
  if (e.target.closest?.('button:not(:disabled)') && menuIsOpen()) audio.uiConfirm();
});

function openMenu() {
  if (G.mode) lobbyUI.hide();
  hud.showMenu(true);
  showControls(false);
  hud.el.menu.classList.toggle('in-match-bg', !!G.mode);
  btnResume.style.display = G.mode ? 'flex' : 'none';
  mainCard.classList.toggle('in-match', !!G.mode);
  document.getElementById('menu-title').textContent = t(G.mode ? 'common.pause' : 'common.play');
  document.getElementById('menu-kicker').textContent = t(G.mode ? 'menu.currentMatch' : 'menu.selectMode');
  // NO soltamos el pointer lock: el menú se usa con el cursor virtual.
  // (Cada exit de lock es una oportunidad para el bug de ClipCursor de
  // Chromium/Windows que deja el cursor confinado.)
  vc.x = innerWidth / 2;
  vc.y = innerHeight / 2;
  hud.el.menu.scrollTop = 0;
}
function closeMenu() {
  if (!G.mode) return; // sin partida no hay a dónde volver
  hud.showMenu(false);
  showControls(false);
  cancelRebind();
  cancelSanitize();       // un saneo en vuelo no debe robarse el lock legítimo
  vDrag = null;
  document.activeElement?.blur?.(); // el foco en un input no debe comerse teclas
  if (!input.locked) input.requestLock();
  // reanudar con Esc: el exitPointerLock del MISMO keydown aún no aterrizó,
  // así que input.locked sigue true aquí y el requestLock de arriba no corre
  // — sin este reintento el mouse quedaba muerto hasta el keeper (1.6 s)
  setTimeout(() => {
    if (G.mode && !menuIsOpen() && !input.locked && document.hasFocus()) input.requestLock();
  }, 60);
}

// ---------- cursor virtual (menú en pausa con pointer lock activo) ----------
const vcursorEl = document.getElementById('vcursor');
const vc = { x: innerWidth / 2, y: innerHeight / 2 };
let vDrag = null;   // slider siendo arrastrado
let vHover = null;  // elemento con hover simulado

function vDragUpdate() {
  const r = vDrag.getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (vc.x - r.left) / Math.max(1, r.width)));
  const min = +vDrag.min || 0, max = +vDrag.max || 100, step = +vDrag.step || 1;
  const val = Math.round((min + t * (max - min)) / step) * step;
  vDrag.value = val;
  vDrag.dispatchEvent(new Event('input', { bubbles: true }));
}

input.onLockedMouseDown = (btn) => {
  if (sanitizing) return true; // lock transitorio del saneo: ignorar el click
  if (!menuIsOpen()) return false; // jugando: el click es disparo/apuntar
  if (btn === 0) {
    const el = document.elementFromPoint(vc.x, vc.y);
    if (el) {
      if (el.tagName === 'INPUT' && el.type === 'range') { vDrag = el; vDragUpdate(); }
      else if (el.tagName === 'INPUT' && el.type === 'checkbox') el.click(); // toggle directo
      else if (el.tagName === 'INPUT') el.focus();
      else {
        // solo elementos interactivos: nada de clicks fantasma en el vacío
        const t = el.closest('button, label, a');
        if (t) t.click();
      }
    }
  }
  return true; // el menú consume cualquier botón
};
input.onLockedMouseUp = () => { vDrag = null; };

const lobbyUI = new LobbyUI({
  leave: () => leaveLobby(),
  start: () => startLobbyMatch(),
  team: (team) => lobbyAction('team', { team }),
  addBot: (team) => lobbyAction('addBot', { team }),
  removeBot: (id) => lobbyAction('removeBot', { id }),
  moveBot: (id, team) => lobbyAction('moveBot', { id, team }),
  settings: (value) => lobbyAction('settings', value),
});

function defaultLocalLobby() {
  const player = { id: 'player', name: saveName(), team: 'red', bot: 0, host: 1, v: G.charVariant, alive: true };
  const bots = [];
  for (const team of ['red', 'blue']) {
    const count = team === 'red' ? 3 : 4;
    for (let i = 0; i < count; i++) {
      const occupied = [player, ...bots].map((p) => p.name);
      bots.push({ id: `local-b${bots.length + 1}`, name: makeBotName(team, occupied), team, bot: 1, v: bots.length % 5, alive: true });
    }
  }
  const state = { phase: 'lobby', hostId: 'player', settings: normalizeLobbySettings({ ...DEFAULT_LOBBY_SETTINGS, map: G.mapChoice }, { allowCustom: true }),
    players: [player], bots, maxPlayers: MAX_PLAYERS, teamCapacity: TEAM_CAPACITY };
  state.validation = validateLobby([...state.players, ...state.bots], state.settings);
  return state;
}

function refreshLocalLobby() {
  if (!G.lobby || G.lobbyKind !== 'local') return;
  G.lobby.validation = validateLobby([...G.lobby.players, ...G.lobby.bots], G.lobby.settings);
  lobbyUI.render(G.lobby);
}

function openLocalLobby() {
  dismissSplash(); audio.ensure(); startSeq++;
  teardown({ keepLobby: false });
  G.lobby = defaultLocalLobby(); G.lobbyKind = 'local';
  hud.show(false); hud.showMenu(true); showControls(false); input.releaseLock();
  lobbyUI.show(G.lobby, 'player', 'local');
  audio.lobbyEnter();
}

function lobbyAction(action, value) {
  if (!G.lobby) return;
  if (G.lobbyKind === 'online') {
    if (action === 'team') G.net?.lobbyTeam(value.team);
    if (action === 'addBot') G.net?.lobbyAddBot(value.team);
    if (action === 'removeBot') G.net?.lobbyRemoveBot(value.id);
    if (action === 'moveBot') G.net?.lobbyBotTeam(value.id, value.team);
    if (action === 'settings') G.net?.lobbySettings(value);
    return;
  }
  const slots = () => [...G.lobby.players, ...G.lobby.bots];
  const teamRoom = (team, skip = '') => slots().filter((p) => p.id !== skip && p.team === team).length < TEAM_CAPACITY;
  if (action === 'team' && G.lobby.players[0].team !== value.team) {
    const player = G.lobby.players[0];
    if (teamRoom(value.team, player.id)) player.team = value.team;
    else {
      // La acción de la UI dice explícitamente "cambiar con bot": conserva
      // tamaño y balance sin borrar ni mover jugadores silenciosamente.
      const bot = G.lobby.bots.find((b) => b.team === value.team);
      if (bot) { bot.team = player.team; player.team = value.team; }
    }
  }
  if (action === 'settings') {
    // el lobby LOCAL acepta mapas del editor; el online no (el server no los conoce)
    G.lobby.settings = normalizeLobbySettings({ ...G.lobby.settings, ...value },
      { allowCustom: G.lobbyKind !== 'online' });
  }
  if (action === 'removeBot') G.lobby.bots = G.lobby.bots.filter((b) => b.id !== value.id);
  if (action === 'moveBot') {
    const b = G.lobby.bots.find((x) => x.id === value.id);
    if (b && teamRoom(value.team, b.id)) b.team = value.team;
  }
  if (action === 'addBot' && slots().length < MAX_PLAYERS && teamRoom(value.team)) {
    const occupied = slots().map((p) => p.name);
    const seq = 1 + Math.max(0, ...G.lobby.bots.map((b) => +(b.id.match(/\d+$/)?.[0] || 0)));
    G.lobby.bots.push({ id: `local-b${seq}`, name: makeBotName(value.team, occupied), team: value.team, bot: 1, v: seq % 5, alive: true });
  }
  refreshLocalLobby();
}

function startLobbyMatch() {
  if (!G.lobby?.validation?.ok) return;
  if (G.lobbyKind === 'online') G.net?.lobbyStart();
  else startBots(G.lobby);
}

function showMainMenuFromLobby(message = '') {
  lobbyUI.hide(); mainCard.style.display = '';
  G.lobby = null; G.lobbyKind = null; G.mode = null;
  hud.el.menu.classList.remove('in-match-bg');
  mainCard.classList.remove('in-match');
  btnResume.style.display = 'none';
  document.getElementById('menu-title').textContent = t('common.play');
  document.getElementById('menu-kicker').textContent = t('menu.selectMode');
  showMenuBackdrop(); hud.show(false); hud.showMenu(true); showControls(false);
  hud.el.menu.scrollTop = 0;
  netStatus.textContent = message; input.releaseLock();
}

function leaveLobby() {
  startSeq++;
  if (G.net) teardown({ keepLobby: false });
  else { G.lobby = null; G.lobbyKind = null; }
  showMainMenuFromLobby();
}

document.getElementById('btn-bots').addEventListener('click', openLocalLobby);
document.getElementById('btn-practice').addEventListener('click', () => startPractice());
document.getElementById('btn-online').addEventListener('click', () => { inServer.focus(); netStatus.textContent = t('lobby.create') + ' / ' + t('lobby.join'); });
document.getElementById('btn-lobby-create').addEventListener('click', () => connectOnlineLobby('create'));
document.getElementById('btn-lobby-join').addEventListener('click', () => connectOnlineLobby('join'));

// selector de mapa: valor inicial de lobby local y mapa de Práctica.
const btnMap = document.getElementById('btn-map');
{
  const saved = localStorage.getItem('breach.map');
  G.mapChoice = MAPS.includes(saved) ? saved : 'fortaleza';
}
function updateMapBtn() {
  document.getElementById('map-label').textContent = t('menu.mapValue', { map: mapLabel(G.mapChoice) });
}
btnMap.addEventListener('click', () => {
  // cicla los mapas del juego + los JUGABLES creados en el editor
  const all = [...MAPS, ...listPlayableMaps().map((m) => mapLayoutId(m))];
  G.mapChoice = all[(all.indexOf(G.mapChoice) + 1) % all.length];
  localStorage.setItem('breach.map', G.mapChoice);
  updateMapBtn();
});
updateMapBtn();
btnResume.addEventListener('click', () => closeMenu());
document.getElementById('btn-pause').addEventListener('click', () => openMenu());
document.getElementById('btn-pause-controls').addEventListener('click', () => showOptions(true));

function leaveCurrentMatch() {
  if (!G.mode) return;
  startSeq++;
  if (G.mode === 'bots' && G.lobby) {
    G.mode = null;
    teardown({ keepLobby: true });
    showMenuBackdrop(); hud.show(false); hud.showMenu(true); input.releaseLock();
    lobbyUI.show(G.lobby, 'player', 'local');
    audio.lobbyEnter();
    return;
  }
  G.mode = null;
  teardown({ keepLobby: false });
  showMainMenuFromLobby();
}
document.getElementById('btn-leave-match').addEventListener('click', leaveCurrentMatch);

// pantalla completa (botón del menú + ícono del HUD)
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      // soltar NOSOTROS el lock antes (limpio); si no, el navegador lo tira
      // por su camino interno al salir de fullscreen (el sucio)
      input.releaseLock();
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  } catch { /* sin soporte */ }
}
document.getElementById('btn-fullscreen').addEventListener('click', () => toggleFullscreen());
document.getElementById('btn-pause-fullscreen').addEventListener('click', () => toggleFullscreen());
document.getElementById('btn-fs').addEventListener('click', () => toggleFullscreen());
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  const fsLabel = on ? t('common.exitFullscreen') : t('common.fullscreen');
  document.getElementById('fullscreen-label').textContent = fsLabel;
  document.getElementById('video-fullscreen-label').textContent = fsLabel;
  // en fullscreen, capturar Esc (Keyboard Lock API): ni Esc suelta el pointer
  // lock → el bug de ClipCursor no tiene forma de dispararse jugando.
  // Registramos si fue CONCEDIDO: si falla, Esc mantiene el exit programático.
  if (on) {
    try {
      const kp = navigator.keyboard?.lock?.(['Escape']);
      if (kp && kp.then) kp.then(() => { input.kbLocked = true; }).catch(() => { input.kbLocked = false; });
    } catch { input.kbLocked = false; }
  } else {
    input.kbLocked = false;
    try { navigator.keyboard?.unlock?.(); } catch { /* ok */ }
    // FUERA del try: si unlock() lanzara, saldríamos de fullscreen con el
    // lock puesto y sin pausar (la salida sucia que queremos eliminar)
    if (input.locked) input.releaseLock();
    if (G.mode && !menuIsOpen()) openMenu();
  }
});

input.onEscape = () => {
  // el editor y su playtest tienen su propia salida (no abren la pausa)
  if (G.mode === 'editor') { closeEditor(); return; }
  if (G.editorReturn) { returnToEditor(); return; }
  if ((menuIsOpen() || !splash.classList.contains('off')) && menuNavigator?.back()) return;
  if (!G.mode) return;
  if (menuIsOpen()) closeMenu(); else openMenu();
};

// ---------- saneamiento del ClipCursor (bug de Chromium/Windows con escala) ----------
// Un exit "sucio" del pointer lock (blur, Esc del navegador) puede dejar el
// cursor confinado a nivel de OS. Reparación 100% desde la página: un ciclo
// lock→exit CON FOCO fija un clip fresco y lo limpia por el camino sano.
// Se dispara al recuperar el foco o al primer click tras un unlock.
let lockUsed = false;       // hubo al menos un lock en esta sesión
let needSanitize = false;   // hubo un unlock que pudo dejar clip sucio
let sanitizing = false;
let sanitizeExiting = false; // el próximo unlock es NUESTRO exit del saneo
let sanitizeAt = 0;
let sanitizeGen = 0;        // generación: cancelar invalida timeouts en vuelo
let sanitizeReqAt = 0;      // última petición de lock DEL SANEO (aunque el
                            // rescate ya haya soltado el flag, si el lock
                            // llega tarde sigue siendo un lock de saneo)

function cancelSanitize() { sanitizing = false; sanitizeGen++; sanitizeReqAt = 0; }

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    lockUsed = true;
    // también cuenta como saneo un lock que llegó tarde (>500ms, con el
    // rescate ya disparado): tratarlo como legítimo re-capturaba el mouse
    // solo y dejaba el clip sin sanear (recaída bajo carga de CPU)
    if (sanitizing || performance.now() - sanitizeReqAt < 2500) {
      sanitizeReqAt = 0;
      const gen = ++sanitizeGen;
      // lock del ciclo de saneamiento: salir por el camino limpio, salvo que
      // el jugador reanude en estos 30ms (cancelSanitize invalida la gen)
      setTimeout(() => {
        sanitizing = false;
        if (gen !== sanitizeGen) return;
        needSanitize = false;
        if (document.pointerLockElement === canvas) {
          sanitizeExiting = true;
          input.cleanExitAt = performance.now();
          document.exitPointerLock();
        }
      }, 30);
    } else {
      // lock legítimo del jugador: el clip queda fresco, nada que sanear
      needSanitize = false;
    }
  } else {
    // unlock: sospechoso de dejar clip pegado, SALVO que sea nuestro propio
    // exit del saneo (evita re-armarse en loop) o un exit limpio con foco
    const cleanExit = performance.now() - input.cleanExitAt < 300;
    needSanitize = !sanitizeExiting && !cleanExit;
    sanitizeExiting = false;
  }
});
// si el navegador DENIEGA el lock del saneo por la vía del evento (no todas
// las denegaciones rechazan la promesa), liberar el flag — si se quedara
// pegado, TODOS los clicks se consumirían y no se podría disparar nunca más
document.addEventListener('pointerlockerror', () => { sanitizing = false; sanitizeReqAt = 0; });

function sanitizeClip() {
  if (input.lockDisabled) return; // ?nolock: ni el saneo pide lock
  if (!lockUsed || !needSanitize || sanitizing || input.locked || !G.mode) return;
  if (!document.hasFocus() || performance.now() - sanitizeAt < 1500) return;
  sanitizeAt = performance.now();
  sanitizing = true;
  sanitizeReqAt = performance.now();
  // rescate: si en 500ms no llegó ni lock ni error, soltar el flag (los
  // clicks vuelven a funcionar); sanitizeReqAt sigue marcando la petición
  // en vuelo por si el lock aterriza tarde
  setTimeout(() => { if (sanitizing && !input.locked) sanitizing = false; }, 500);
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { sanitizing = false; });
  } catch { sanitizing = false; }
}
window.addEventListener('focus', () => setTimeout(sanitizeClip, 120));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(sanitizeClip, 120);
});
// fallback con gesto: primer click tras un unlock (por si el saneamiento
// sin gesto fue denegado por el navegador)
document.addEventListener('pointerdown', () => { setTimeout(sanitizeClip, 80); }, true);

// pantalla completa automática al iniciar partida: con Keyboard Lock activo
// ni Esc suelta el pointer lock → sin salidas sucias durante el juego
function enterFullscreen() {
  try {
    if (!document.fullscreenElement) {
      const p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    }
  } catch { /* sin soporte */ }
}

// keeper de re-captura: si estamos jugando (menú cerrado) sin lock y con foco,
// reintentar cada 1.6s — cubre el cooldown de Esc del navegador, despausar
// con gamepad (sin gesto) y el lock pedido tras un await
let lastKeep = 0;
// alt-tab / cambio de ventana: soltar el mouse y abrir la pausa
input.onFocusLost = () => {
  vDrag = null; // un slider agarrado no debe seguir arrastrándose al volver
  if (G.mode && !menuIsOpen()) openMenu();
};
input.onToggleMute = () => {
  const m = audio.toggleMute();
  hud.hint(t(m ? 'msg.audioOff' : 'msg.audioOn'), 900);
};
input.onInvertChanged = (inv) => {
  hud.hint(t('msg.mouseAxis', { state: t(inv ? 'msg.inverted' : 'msg.normal') }), 1200);
  chkInvert.checked = inv;
};

// ---------- panel de controles ----------
const kbRows = document.getElementById('kb-rows');
const padRows = document.getElementById('pad-rows');
const padStatus = document.getElementById('pad-status');
const slMouse = document.getElementById('sl-mouse');
const slMouseV = document.getElementById('sl-mouse-v');
const slPad = document.getElementById('sl-pad');
const slPadV = document.getElementById('sl-pad-v');
const slZoom = document.getElementById('sl-zoom');
const slZoomV = document.getElementById('sl-zoom-v');
const slVol = document.getElementById('sl-vol');
const slVolV = document.getElementById('sl-vol-v');
const chkInvert = document.getElementById('chk-invert');
const chkInvertPad = document.getElementById('chk-invert-pad');
const selLanguage = document.getElementById('sel-language');
let rebinding = null; // { cancel() }

for (const language of LANGUAGES) {
  const option = document.createElement('option');
  option.value = language.code;
  option.textContent = language.label;
  selLanguage.append(option);
}
selLanguage.value = getLanguage();
selLanguage.addEventListener('change', () => setLanguage(selLanguage.value));

// ---------- Opciones: hub + subcards (Audio / Video / Idioma / Controles) ----------
const optionsCard = document.getElementById('options-card');
const audioCard = document.getElementById('audio-card');
const videoCard = document.getElementById('video-card');
const languageCard = document.getElementById('language-card');
const optionSubCards = [audioCard, videoCard, languageCard];

function hideOptionCards() {
  optionsCard.style.display = 'none';
  for (const c of optionSubCards) c.style.display = 'none';
}

function showOptions(on) {
  mainCard.style.display = on ? 'none' : 'block';
  hideOptionCards();
  controlsCard.style.display = 'none';
  charCard.style.display = 'none';
  optionsCard.style.display = on ? 'block' : 'none';
  hud.el.menu.scrollTop = 0;
  if (!on) cancelRebind();
}

function showSubCard(card) {
  mainCard.style.display = 'none';
  hideOptionCards();
  controlsCard.style.display = 'none';
  charCard.style.display = 'none';
  card.style.display = 'block';
  hud.el.menu.scrollTop = 0;
  if (card === audioCard) {
    slVol.value = audio.volume;
    updateSliderLabels();
  }
}

function showControls(on) {
  // on=false es el "reset a menú principal" que usan openMenu/lobby
  mainCard.style.display = on ? 'none' : 'block';
  hideOptionCards();
  controlsCard.style.display = on ? 'block' : 'none';
  charCard.style.display = 'none';
  hud.el.menu.scrollTop = 0;
  if (on) {
    renderBinds();
    slMouse.value = TUNING.cam.sens;
    slPad.value = TUNING.cam.padSens;
    slZoom.value = TUNING.cam.zoomSens;
    chkInvert.checked = input.invertY;
    chkInvertPad.checked = input.invertYPad;
    updateSliderLabels();
  } else cancelRebind();
}
document.getElementById('btn-options').addEventListener('click', () => showOptions(true));
document.getElementById('btn-options-back').addEventListener('click', () => showOptions(false));
document.getElementById('btn-opt-audio').addEventListener('click', () => showSubCard(audioCard));
document.getElementById('btn-opt-video').addEventListener('click', () => showSubCard(videoCard));
document.getElementById('btn-opt-language').addEventListener('click', () => showSubCard(languageCard));
document.getElementById('btn-opt-controls').addEventListener('click', () => showControls(true));
document.getElementById('btn-audio-back').addEventListener('click', () => showOptions(true));
document.getElementById('btn-video-back').addEventListener('click', () => showOptions(true));
document.getElementById('btn-language-back').addEventListener('click', () => showOptions(true));
document.getElementById('btn-back').addEventListener('click', () => showOptions(true));

// ---------- video: pantalla completa, sombras y escala de render ----------
const chkShadows = document.getElementById('chk-shadows');
const selScale = document.getElementById('sel-scale');
document.getElementById('btn-video-fullscreen').addEventListener('click', () => toggleFullscreen());
function applyShadows(on) {
  if (world.sun) world.sun.castShadow = on;
}
chkShadows.checked = localStorage.getItem('breach.video.shadows') !== '0';
applyShadows(chkShadows.checked);
chkShadows.addEventListener('change', () => {
  localStorage.setItem('breach.video.shadows', chkShadows.checked ? '1' : '0');
  applyShadows(chkShadows.checked);
});
selScale.value = String(renderScale);
if (selScale.selectedIndex < 0) selScale.value = '1';
selScale.addEventListener('change', () => {
  renderScale = parseFloat(selScale.value) || 1;
  localStorage.setItem('breach.video.scale', String(renderScale));
  renderer.setPixelRatio(BASE_PIXEL_RATIO * renderScale);
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- selección de personaje ----------
const charCard = document.getElementById('char-card');
const charSlots = document.getElementById('char-slots');

function showChar(on) {
  mainCard.style.display = on ? 'none' : 'block';
  controlsCard.style.display = 'none';
  hideOptionCards();
  charCard.style.display = on ? 'block' : 'none';
  hud.el.menu.scrollTop = 0;
  if (on) buildCharUI();
}
document.getElementById('btn-character').addEventListener('click', () => showChar(true));
document.getElementById('btn-char-back').addEventListener('click', () => showChar(false));

function navigateMenuBack() {
  if (!splash.classList.contains('off')) return false;
  // en el editor, Esc sale de él (no abre la pausa del juego)
  if (G.mode === 'editor') { closeEditor(); return true; }
  // durante un playtest, Esc vuelve al editor con el mapa intacto
  if (G.editorReturn) { returnToEditor(); return true; }
  // jerarquía: subcard → Opciones → menú principal
  if (optionSubCards.some((c) => c.style.display === 'block')) { showOptions(true); return true; }
  if (controlsCard.style.display === 'block') { showOptions(true); return true; }
  if (optionsCard.style.display === 'block') { showOptions(false); return true; }
  if (charCard.style.display === 'block') { showChar(false); return true; }
  if (!lobbyUI.root.classList.contains('off')) { leaveLobby(); return true; }
  if (G.mode && menuIsOpen()) { closeMenu(); return true; }
  return false;
}

menuNavigator = new MenuControllerNavigator({
  menu: hud.el.menu,
  splash,
  prompts: menuPrompts,
  onMove: () => audio.uiMove(),
  onBack: navigateMenuBack,
});

function buildCharUI() {
  if (!charSlots.children.length) {
    for (let v = 0; v < 5; v++) {
      const b = document.createElement('button');
      b.className = 'char-slot';
      b.dataset.v = v;
      b.dataset.navKey = `char:${v}`;
      const name = t(`character.${v}`);
      b.innerHTML = `<img alt="${name}"><span>${name}</span>`;
      b.addEventListener('click', () => {
        G.charVariant = v;
        localStorage.setItem('breach.character', String(v));
        updateCharSel();
        // en partida: el cambio aplica al instante (rig nuevo en el sitio)
        if (G.rig && G.player && G.mode) {
          G.rig.dispose(scene);
          G.rig = new Rig(scene, G.team, null, v);
          G.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y);
          G.rig.collideFn = (p, y, r = RAGDOLL_R) => world.resolveCircle(p, r, y);
          G.rig.setWeapon(G.weapons.cur, backWeapon());
        }
      });
      charSlots.append(b);
    }
    renderCharPreviews();
  }
  updateCharSel();
  translateCharacterSlots();
}
function translateCharacterSlots() {
  for (const b of charSlots.children) {
    const name = t(`character.${b.dataset.v}`);
    const img = b.querySelector('img');
    const label = b.querySelector('span');
    if (img) img.alt = name;
    if (label) label.textContent = name;
  }
}
function updateCharSel() {
  for (const b of charSlots.children) b.classList.toggle('sel', +b.dataset.v === G.charVariant);
}

// Previews 3D: pose neutral sin armas para que casco, peto y proporciones se
// lean completos. Una sola cámara/escala para las cinco variantes: el selector
// no falsea el tamaño relativo de ningún soldado.
function renderCharPreviews() {
  const pr = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  pr.setSize(176, 224);
  const ps = new THREE.Scene();
  ps.add(new THREE.HemisphereLight(0xd9e6f0, 0x97876e, 2.2));
  const dl = new THREE.DirectionalLight(0xffe9c4, 1.6);
  dl.position.set(2, 3, -2.5);
  ps.add(dl);
  const fill = new THREE.DirectionalLight(0xdfe8f0, 0.9); // relleno hacia la cara
  fill.position.set(2.2, 1.4, -1.4);
  ps.add(fill);
  const pc = new THREE.PerspectiveCamera(30, 176 / 224, 0.1, 10);
  pc.position.set(0.52, 1.47, -2.75);
  pc.lookAt(0, 0.84, 0);
  for (let v = 0; v < 5; v++) {
    const r = new Rig(ps, 'red', null, v);
    // Asentar piernas/torso y luego aplicar una pose de exhibición simétrica.
    for (let i = 0; i < 40; i++) r.update(1 / 30, { state: 'idle', speed: 0, aim: false, aimPitch: 0 });
    r.gunMount.visible = false;
    r.backMount.visible = false;
    r.aimRig.rotation.set(0, 0, 0);
    r.armL.shoulder.rotation.set(0, 0, -0.13);
    r.armR.shoulder.rotation.set(0, 0, 0.13);
    r.armL.elbow.rotation.set(0, 0, 0);
    r.armR.elbow.rotation.set(0, 0, 0);
    r.root.rotation.y = -0.18;
    r.root.updateWorldMatrix(true, true);
    pr.render(ps, pc);
    const img = charSlots.querySelector(`button[data-v="${v}"] img`);
    if (img) img.src = pr.domElement.toDataURL();
    r.dispose(ps);
  }
  pr.dispose();
}

const portraitCache = new Map();
function renderCharacterPortrait(variant = 0, team = 'red') {
  const key = `${team}:${variant | 0}`;
  if (portraitCache.has(key)) return portraitCache.get(key);
  const pr = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  pr.setPixelRatio(1);
  pr.setSize(240, 320);
  const ps = new THREE.Scene();
  ps.add(new THREE.HemisphereLight(0xe2eaf0, 0x5b6169, 2.25));
  const keyLight = new THREE.DirectionalLight(team === 'red' ? 0xffd8bd : 0xc8dcff, 1.8);
  keyLight.position.set(2.4, 3.6, -2.8); ps.add(keyLight);
  const rim = new THREE.DirectionalLight(team === 'red' ? 0xd94f3f : 0x4f8de0, 1.15);
  rim.position.set(-2.2, 2, 1.8); ps.add(rim);
  const pc = new THREE.PerspectiveCamera(28, 240 / 320, .1, 10);
  pc.position.set(.58, 1.42, -2.72); pc.lookAt(0, .9, 0);
  const rig = new Rig(ps, team, null, variant | 0);
  for (let i = 0; i < 35; i++) rig.update(1 / 30, { state: 'idle', speed: 0, aim: false, aimPitch: 0 });
  rig.root.rotation.y = -.2;
  rig.root.updateWorldMatrix(true, true);
  pr.render(ps, pc);
  const data = pr.domElement.toDataURL('image/png');
  rig.dispose(ps); pr.dispose();
  portraitCache.set(key, data);
  return data;
}
document.getElementById('btn-reset-binds').addEventListener('click', () => { resetBinds(); renderBinds(); });

function updateSliderLabels() {
  slMouseV.textContent = Number(slMouse.value).toFixed(3);
  slPadV.textContent = slPad.value + '°/s';
  slZoomV.textContent = Math.round(Number(slZoom.value) * 100) + '%';
  slVolV.textContent = Math.round(audio.volume * 100) + '%';
}
slMouse.addEventListener('input', () => {
  TUNING.cam.sens = parseFloat(slMouse.value);
  localStorage.setItem('breach.sens.mouse', slMouse.value);
  updateSliderLabels();
});
slPad.addEventListener('input', () => {
  TUNING.cam.padSens = parseFloat(slPad.value);
  localStorage.setItem('breach.sens.pad', slPad.value);
  updateSliderLabels();
});
slZoom.addEventListener('input', () => {
  TUNING.cam.zoomSens = parseFloat(slZoom.value);
  localStorage.setItem('breach.sens.zoom', slZoom.value);
  updateSliderLabels();
});
slVol.addEventListener('input', () => {
  audio.ensure();
  audio.setVolume(parseFloat(slVol.value));
  updateSliderLabels();
  audio.hit(); // bip de referencia para calibrar al oído
});
chkInvert.addEventListener('change', () => {
  input.invertY = chkInvert.checked;
  localStorage.setItem('breach.invertY', String(input.invertY));
});
chkInvertPad.addEventListener('change', () => {
  input.invertYPad = chkInvertPad.checked;
  localStorage.setItem('breach.invertYPad', String(input.invertYPad));
});
// (la opción de raw input se eliminó: era el camino con el bug de ClipCursor)
localStorage.removeItem('breach.rawInput');

function cancelRebind() {
  if (rebinding) { rebinding.cancel(); rebinding = null; }
  input.rebinding = false;
}

function renderBinds() {
  cancelRebind();
  kbRows.innerHTML = '';
  for (const action in KB_LABELS) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const label = document.createElement('span');
    label.textContent = t(KB_LABELS[action]);
    const btn = document.createElement('button');
    btn.className = 'bind-btn';
    btn.dataset.navKey = `bind:keyboard:${action}`;
    btn.dataset.navColumn = 'keyboard';
    btn.textContent = keyLabel(BINDS.kb[action]);
    btn.addEventListener('click', () => startRebindKb(action, btn));
    row.append(label, btn);
    kbRows.append(row);
  }
  padRows.innerHTML = '';
  for (const action in PAD_LABELS) {
    const row = document.createElement('div');
    row.className = 'bind-row';
    const label = document.createElement('span');
    label.textContent = t(PAD_LABELS[action]);
    const btn = document.createElement('button');
    btn.className = 'bind-btn';
    btn.dataset.navKey = `bind:controller:${action}`;
    btn.dataset.navColumn = 'controller';
    btn.textContent = padBtnName(BINDS.pad[action]);
    btn.addEventListener('click', () => startRebindPad(action, btn));
    row.append(label, btn);
    padRows.append(row);
  }
}

onLanguageChange((language) => {
  selLanguage.value = language;
  hud.invalidateLanguage();
  updateMapBtn();
  translateCharacterSlots();
  renderBinds();
  document.getElementById('menu-title').textContent = t(G.mode ? 'common.pause' : 'common.play');
  document.getElementById('menu-kicker').textContent = t(G.mode ? 'menu.currentMatch' : 'menu.selectMode');
  document.getElementById('fullscreen-label').textContent = t(document.fullscreenElement
    ? 'common.exitFullscreen' : 'common.fullscreen');
  document.getElementById('video-fullscreen-label').textContent = t(document.fullscreenElement
    ? 'common.exitFullscreen' : 'common.fullscreen');
  if (!input.pad.connected) padStatus.textContent = t('menu.noController');
  if (G.lobby) lobbyUI.render(G.lobby);
  menuNavigator?.refreshPrompts();
});

function startRebindKb(action, btn) {
  cancelRebind();
  btn.textContent = '· · ·';
  btn.classList.add('listening');
  input.rebinding = true; // Esc cancela el rebind SIN soltar el pointer lock
  const h = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', h, true);
    rebinding = null;
    input.rebinding = false;
    if (e.code !== 'Escape') { BINDS.kb[action] = e.code; saveBinds(); }
    renderBinds();
  };
  window.addEventListener('keydown', h, true);
  rebinding = { cancel: () => window.removeEventListener('keydown', h, true) };
}

function startRebindPad(action, btn) {
  cancelRebind();
  btn.textContent = '· · ·';
  btn.classList.add('listening');
  input.rebinding = true; // el botón de pausa actual no debe cerrar el menú
  const startPressed = new Set(input.pad.pressed);
  const t0 = performance.now();
  const iv = setInterval(() => {
    for (const b of input.pad.pressed) {
      if (!startPressed.has(b)) {
        clearInterval(iv);
        rebinding = null;
        input.rebinding = false;
        BINDS.pad[action] = b;
        saveBinds();
        renderBinds();
        return;
      }
    }
    for (const b of startPressed) if (!input.pad.pressed.has(b)) startPressed.delete(b);
    if (performance.now() - t0 > 6000) { clearInterval(iv); rebinding = null; input.rebinding = false; renderBinds(); }
  }, 30);
  rebinding = { cancel: () => clearInterval(iv) };
}

// ---------- panel de tuning (F10) ----------
let gui = null;
let lockSuspended = false; // F10 abierto: el keeper NO debe recapturar el mouse
input.onToggleTuning = () => {
  if (gui) { gui.destroy(); gui = null; lockSuspended = false; return; }
  lockSuspended = true;
  gui = new GUI({ title: 'BREACH TUNING' });
  const addRec = (obj, folder) => {
    for (const k in obj) {
      const visibleName = k.replace(/roadie/gi, 'run');
      if (typeof obj[k] === 'number') folder.add(obj, k).name(visibleName);
      else if (typeof obj[k] === 'object') addRec(obj[k], folder.addFolder(visibleName));
    }
  };
  addRec(TUNING, gui);
  gui.add({ reset: () => { deepCopy(TUNING_DEFAULTS, TUNING); gui.destroy(); gui = null; } }, 'reset');
  input.releaseLock();
};
function deepCopy(src, dst) {
  for (const k in src) {
    if (typeof src[k] === 'object') deepCopy(src[k], dst[k]);
    else dst[k] = src[k];
  }
}

// ---------- ciclo de vida de partida ----------
let startSeq = 0; // n° de arranque de partida: invalida continuaciones tardías

function teardown({ keepNet = false, keepLobby = true } = {}) {
  resetSpectator();
  if (G.rig) { G.rig.dispose(scene); G.rig = null; }
  if (G.dummies) { G.dummies.dispose(); G.dummies = null; }
  if (G.botMatch) { G.botMatch.dispose(); G.botMatch = null; }
  G.onlineBots = null;
  if (G.crates) { G.crates.dispose(); G.crates = null; }
  if (G.drops) { G.drops.dispose(); G.drops = null; }
  G.player = null; // sin referencias a caras de un mapa destruido
  G.fireBuffer = 0;
  G.pendingShots = 0;
  G.pendingThrows = 0;
  smoke.clear();
  specials.clear();
  rockets.clear();
  G.specialRound = 0;
  G.spawnProt = 0;
  G.respawnT = 0;
  hud.respawnTick(null);
  hud.centerOff();  // sin "GANA ROJO" colándose a la partida siguiente
  hud.clearFeed();
  hud.timer(null);
  hud.roundPips(null);
  hud.scoreboard(null);
  hud.presentation(null);
  for (const r of G.remotes.values()) r.dispose(scene);
  G.remotes.clear();
  if (G.net && !keepNet) { G.net.close(); G.net = null; }
  G.scores = { red: 0, blue: 0 };
  G.selfHp = TUNING.combat.hp;
  G.selfAlive = true;
  G.dropSeq = 0;
  G.playerLastHit = 99;
  G.footAcc = 0;
  G.onlineRows = [];
  G.onlineStartAt = 0;
  G.onlineFinal = null;
  G.onlineRoundResult = null;
  G.onlinePhase = keepNet ? G.onlinePhase : 'lobby';
  G.flowLockedPrev = false;
  G.presentationAudioKey = '';
  if (!keepLobby) { G.lobby = null; G.lobbyKind = null; }
}

function spawnLocal(team, spawn) {
  G.team = team;
  G.rig = new Rig(scene, team, null, G.charVariant);
  G.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y);
  G.rig.collideFn = (p, y, r = RAGDOLL_R) => world.resolveCircle(p, r, y);
  G.player = new Controller(world, shoulderCam, ctrlEvents);
  G.player.respawn(spawn);
  G.weapons.reset();
  G.rig.setWeapon('smg');
}

function grantSpawnProtection() {
  G.spawnProt = TUNING.combat.spawnProtection;
  hud.hint(t('msg.spawnProtection'), 2200);
}

function rocketDeathFx(victimPos, team, ctx, floorY = 0) {
  const level = rocketDeathLevel(ctx);
  if (!level || !victimPos) return 0;
  const raw = ctx?.explosionPoint;
  const ep = Array.isArray(raw)
    ? { x: raw[0], y: raw[1], z: raw[2] }
    : raw;
  const direction = ep && Number.isFinite(ep.x) && Number.isFinite(ep.z)
    ? { x: victimPos.x - ep.x, y: 0.16, z: victimPos.z - ep.z }
    : ctx?.impact || null;
  effects.rocketDeath(victimPos, TEAM_HEX[team], level, direction, floorY);
  return level;
}

// Reacción física corta para una explosión NO letal. La distancia real ya
// determinó el daño; aquí solo traducimos ese daño a lectura corporal sin
// convertir la bazooka en una fuente de launch/exploits de movimiento.
function applyRocketImpact(position, y, yaw, rig, ctx, damage, radius = PLAYER_R) {
  if (!position || ctx?.weapon !== 'bazooka') return false;
  const raw = ctx.explosionPoint;
  const ep = Array.isArray(raw)
    ? { x: raw[0], y: raw[1], z: raw[2] }
    : raw;
  if (!ep || !Number.isFinite(ep.x) || !Number.isFinite(ep.z)) return false;
  const dx = position.x - ep.x, dz = position.z - ep.z;
  const len = Math.max(0.08, Math.hypot(dx, dz));
  const strength = Math.max(0.09, Math.min(0.34, (+damage || 0) / 260));
  position.x += (dx / len) * strength;
  position.z += (dz / len) * strength;
  world.resolveCircle(position, radius, y);
  const side = (dx * Math.cos(yaw || 0) + dz * -Math.sin(yaw || 0)) / len;
  rig?.hitReact(side, Math.min(1.2, 0.45 + (+damage || 0) / 85), 'explosion');
  return true;
}

function damagePlayerLocal(dmg, fromName, shooter, hitCtx = null) {
  if (!G.selfAlive) return false;
  if (G.spawnProt > 0) return false; // protegido: sin daño
  G.selfHp -= dmg;
  G.playerLastHit = 0;
  if (hitCtx?.weapon === 'melee' && shooter && G.player) {
    const dx = G.player.pos.x - shooter.x, dz = G.player.pos.z - shooter.z;
    const len = Math.max(0.001, Math.hypot(dx, dz));
    const rightX = Math.cos(G.player.yaw), rightZ = -Math.sin(G.player.yaw);
    const side = (dx * rightX + dz * rightZ) / len;
    G.rig.hitReact(side, Math.min(1.2, dmg / 50), 'melee');
    // Empuje corto y físico: resolveCircle impide atravesar pared/cover.
    G.player.pos.x += (dx / len) * 0.13;
    G.player.pos.z += (dz / len) * 0.13;
    world.resolveCircle(G.player.pos, PLAYER_R, G.player.y);
  }
  audio.hurt();
  shoulderCam.addShake(0.35);
  input.pad.rumble(120, 0.4, 0.6);
  if (G.selfHp > 0 && hitCtx?.weapon === 'bazooka') {
    applyRocketImpact(G.player.pos, G.player.y, G.player.yaw, G.rig,
      hitCtx, dmg);
  }
  if (G.selfHp <= 0) {
    G.selfHp = 0;
    G.selfAlive = false;
    const sniperHeadshot = isSniperHeadshotDeath(hitCtx);
    const explosiveLevel = rocketDeathLevel(hitCtx);
    const impactPoint = deathImpactPoint(hitCtx, {
      x: G.player.pos.x, y: G.player.y, z: G.player.pos.z,
    });
    const impact = shooter
      ? { x: G.player.pos.x - shooter.x, z: G.player.pos.z - shooter.z }
      : null;
    G.weapons.cancelActions();
    // morir a mitad del lanzamiento: el bote NO sale de una mano muerta
    G.throwT = 0; G.throwPending = false; G.pendingThrows = 0;
    // contexto físico de la muerte ANTES de matar (kill() borra la velocidad):
    // dirección del tiro, potencia del golpe final, momentum y estado
    G.rig.setDeathContext({
      impact,
      power: Math.min(1, dmg / 55),
      vel: { x: G.player.vel.x, z: G.player.vel.z },
      state: G.player.animState(),
      weapon: hitCtx?.weapon,
      distance: hitCtx?.distance,
      damage: hitCtx?.damage ?? dmg,
      part: hitCtx?.part,
      point: impactPoint,
      sniperHeadshot,
      rocketDeathLevel: explosiveLevel,
      explosionPoint: hitCtx?.explosionPoint,
      gib: !!hitCtx?.gib,
    });
    if (sniperHeadshot) {
      effects.sniperHeadshot(impactPoint, TEAM_HEX[G.team], impact, G.player.y);
    } else if (explosiveLevel) {
      rocketDeathFx({ x: G.player.pos.x, y: G.player.y, z: G.player.pos.z },
        G.team, { ...hitCtx, rocketDeathLevel: explosiveLevel, impact }, G.player.y);
    }
    G.player.kill();
    enterSpectator();
    audio.death();
    input.pad.rumble(350, 0.8, 1.0);
    // countdown solo si de verdad queda respawn en el pool del equipo
    if (!G.botMatch || G.botMatch.pool[G.team] > 0) {
      G.respawnT = TUNING.combat.respawnTime;
    } else {
      G.respawnT = 0;
      hud.center(t('msg.noLives'), t('msg.waitRound'), 4500);
    }
    // El drop nace cuando desaparece el arma de la mano y en la posición
    // ACTUAL del cadáver; antes aparecía 60 ms tarde en el punto inicial.
    const dropAt = { x: G.player.pos.x, z: G.player.pos.z, y: world.groundHeight(G.player.pos, PLAYER_R, G.player.y) };
    // la granada no es un arma soltable: si estaba en mano, cae la primaria
    const dropWep = G.weapons.def.thrown ? G.weapons.primary : G.weapons.cur;
    const wep = dropWep, mag = G.weapons.state[dropWep].mag, res = G.weapons.state[dropWep].reserve;
    const id = 'p' + G.dropSeq++;
    const deathRig = G.rig, deathDrops = G.drops;
    setTimeout(() => {
      if (!deathDrops || G.rig !== deathRig || G.drops !== deathDrops) return;
      const rag = deathRig.rag;
      const x = rag ? rag.bx + rag.ox : dropAt.x;
      const z = rag ? rag.bz + rag.oz : dropAt.z;
      const y = rag ? world.groundHeight({ x, z }, PLAYER_R, rag.by) : dropAt.y;
      deathDrops.spawn(id, wep, x, z, G.team, mag, res, undefined, y);
    }, 220);
    return true;
  }
  return false;
}

function startBots(lobby = G.lobby || defaultLocalLobby()) {
  dismissSplash();
  audio.ensure();
  enterFullscreen();
  startSeq++;
  teardown({ keepLobby: true });
  G.name = saveName();
  effects.clearImpacts();
  G.lobby = lobby; G.lobbyKind = 'local';
  const config = lobby.settings || DEFAULT_LOBBY_SETTINGS;
  G.mapChoice = config.map;
  world.setLayout(config.map);
  audio.setAmbience(config.map);
  G.mode = 'bots';
  const localSlot = lobby.players.find((p) => p.id === 'player') || lobby.players[0];
  spawnLocal(localSlot.team, world.spawns[localSlot.team][0]);
  G.selfHp = TUNING.combat.hp;
  G.selfAlive = true;
  G.playerLastHit = 99;
  G.crates = new AmmoCrates(scene, false, world.cratePos ?? undefined);
  G.drops = new WeaponDrops(scene);
  G.botMatch = new BotMatch(scene, world, {
    smoke, specials, rockets,
    effects, audio, hud,
    playerName: G.name,
    playerVariant: G.charVariant,
    stepSound,
    dropWeapon: (wep, x, z, team, y = 0, deathRig = null) => {
      // los bots no llevan contador de balas: sueltan un remanente plausible.
      // Aparece exactamente al soltar el arma y sigue el pequeño arrastre del
      // cadáver en vez de quedarse en la posición previa al impacto.
      const def = TUNING.weapons[wep];
      const id = 'b' + G.dropSeq++;
      const deathDrops = G.drops;
      setTimeout(() => {
        if (!deathDrops || G.drops !== deathDrops) return;
        const rag = deathRig?.rag;
        const dx = rag ? rag.bx + rag.ox : x;
        const dz = rag ? rag.bz + rag.oz : z;
        const gy = world.groundHeight({ x: dx, z: dz }, PLAYER_R, rag?.by ?? y);
        deathDrops.spawn(id, wep, dx, dz, team,
          Math.ceil(def.mag * (0.2 + Math.random() * 0.6)),
          Math.ceil(def.reserve * Math.random() * 0.4), undefined, gy);
      }, 220);
    },
    player: () => ({
      x: G.player.pos.x, z: G.player.pos.z, y: G.player.y, alive: G.selfAlive,
      // agachado tras cover bajo: hitbox reducida (la cabeza ya no flota
      // sobre el bloque invisible para los bots)
      crouch: isCrouchState(G.player.animState()),
    }),
    damagePlayer: (dmg, fromName, shooter, hitCtx) => damagePlayerLocal(dmg, fromName, shooter, hitCtx),
    respawnPlayer: (spawn, protect = true) => {
      G.selfAlive = true;
      G.selfHp = TUNING.combat.hp;
      G.respawnT = 0;
      G.player.respawn(spawn);
      G.weapons.reset();
      exitSpectator();
      if (protect) grantSpawnProtection();
    },
    onRoundStart: () => { grantSpawnProtection(); audio.roundStart(); },
    onMatchEnd: () => {
      const bm = G.botMatch; // identidad, no modo: el string 'bots' también
      setTimeout(() => {     // es cierto para una partida NUEVA (la mataba)
        if (!bm || G.botMatch !== bm) return;
        const next = G.lobby?.settings?.postMatch;
        if (next === 'next-map') {
          G.lobby.settings.map = nextLobbyMap(G.lobby.settings.map);
          G.lobby.validation = validateLobby([...G.lobby.players, ...G.lobby.bots], G.lobby.settings);
          startBots(G.lobby);
        } else {
          G.mode = null;
          teardown({ keepLobby: true });
          showMenuBackdrop(); hud.show(false); hud.showMenu(true); input.releaseLock();
          lobbyUI.show(G.lobby, 'player', 'local');
        }
      }, 180);
    },
  }, {
    playerTeam: localSlot.team, rounds: config.rounds, lives: config.lives,
    bots: lobby.bots.map((b) => ({ id: b.id, name: b.name, team: b.team, variant: b.v })),
  });
  lobbyUI.hide();
  hud.showMenu(false);
  showControls(false);
  hud.show(true);
  input.requestLock();
  setTimeout(() => hud.hint(t('msg.scoreboardHint'), 2800), 3400);
}

// ---------------------------------------------------------------------------
// EDITOR DE MAPAS. Vive fuera del flujo de partida: abre su propio modo, y el
// Playtest arranca una partida REAL sobre el mapa en edición (mismo pipeline
// de datos) y devuelve el control al editor sin perder nada.
// ---------------------------------------------------------------------------
let editor = null, editorUI = null, editorLoadPromise = null;

async function ensureEditor() {
  if (editor) return editor;
  if (!editorLoadPromise) editorLoadPromise = (async () => {
    const [{ MapEditor }, { EditorUI }] = await Promise.all([
      import('./editor/editor.js'),
      import('./editor/editor-ui.js'),
    ]);
    editor = new MapEditor({
      scene, camera, renderer, world, canvas: renderer.domElement,
    });
    editorUI = new EditorUI(editor, {
      onPlaytest: () => editorPlaytest(),
      onExit: () => closeEditor(),
    });
    // ratón del editor sobre el canvas (el juego no tiene pointer lock aquí)
    const el = renderer.domElement;
    const nx = (e) => (e.clientX / innerWidth) * 2 - 1;
    const ny = (e) => -(e.clientY / innerHeight) * 2 + 1;
    el.addEventListener('mousedown', (e) => {
      if (G.mode !== 'editor') return;
      editor.onPointerDown(nx(e), ny(e), { shift: e.shiftKey, alt: e.altKey, button: e.button });
    });
    window.addEventListener('mousemove', (e) => {
      if (G.mode !== 'editor') return;
      editor.onPointerMove(nx(e), ny(e), e.movementX, e.movementY);
    });
    window.addEventListener('mouseup', () => { if (G.mode === 'editor') editor.onPointerUp(); });
    el.addEventListener('contextmenu', (e) => { if (G.mode === 'editor') e.preventDefault(); });
    return editor;
  })();
  return editorLoadPromise;
}

async function openEditor(map = null) {
  if (!editorLocalOnly) return;
  dismissSplash();
  startSeq++;
  // El editor usa cursor real. Cancelar primero cualquier intento automático
  // de recaptura y abandonar fullscreen evita el ClipCursor perdido al volver
  // de un playtest o abrir la herramienta desde una partida.
  input.suppress = true;
  cancelSanitize();
  input.releaseLock();
  if (document.pointerLockElement) {
    input.cleanExitAt = performance.now();
    try { document.exitPointerLock(); } catch { /* ya liberado */ }
  }
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch { /* el editor sigue windowed lógico */ }
  }
  cancelSanitize();
  teardown();
  // la biblioteca urbana (GLB) del editor y los clones de Calle la necesitan
  // aunque nunca se haya preparado una partida
  await Promise.all([ensureEditor(), preloadUrbanAssets()]);
  G.mode = 'editor';
  G.editorReturn = null;
  hud.showMenu(false);
  hud.show(false);
  showControls(false);
  editor.open(map ?? editor.map);
  editorUI.show(true);
}

function closeEditor() {
  if (!editor) return;
  editor.close();
  editor.discardDraft();
  editorUI.show(false);
  G.mode = null;
  input.suppress = false;
  teardown();
  showMenuBackdrop();
  hud.show(false);
  hud.showMenu(true);
}

// Playtest: valida el borrador y entra a jugarlo sin guardarlo implícitamente.
function editorPlaytest() {
  if (!editor) return;
  const report = editor.validate();
  const blocking = report.filter((r) => r.level === 'error');
  if (blocking.length &&
      !confirm(`${t('editor.playtestProblems', { count: blocking.length })}\n\n` +
        blocking.map((b) => '• ' + (b.i18nKey ? t(b.i18nKey, b.vars) : b.msg)).join('\n') +
        `\n\n${t('editor.playtestAnyway')}`)) return;
  const layout = mapLayoutId(editor.map);
  editor.close();
  editorUI.show(false);
  input.suppress = false;
  G.editorReturn = JSON.parse(JSON.stringify(editor.map)); // volver al mismo borrador
  G.mapChoice = layout;
  startPractice({ fullscreen: false });
  editor.discardDraft(); // el mundo ya fue construido; no contaminar el selector normal
  hud.hint(t('editor.playtestHint'), 3200);
}

// Vuelta desde el playtest al editor, con el mapa intacto
function returnToEditor() {
  const draft = G.editorReturn;
  G.editorReturn = null;
  openEditor(draft ?? editor?.map ?? null);
}

btnEditor?.addEventListener('click', () => openEditor());
// `?editor=1` (solo DEV): entrar directo al editor sin pasar por el menú —
// lo usa el acceso directo del escritorio. Microtask: el módulo ya terminó
// de inicializar todo (hud, input, loop) cuando corre.
if (editorLocalOnly && new URLSearchParams(location.search).has('editor')) {
  Promise.resolve().then(() => openEditor());
}

function startPractice({ fullscreen = true } = {}) {
  dismissSplash();
  audio.ensure();
  if (fullscreen) enterFullscreen();
  startSeq++;
  teardown();
  G.name = saveName();
  effects.clearImpacts();
  world.setLayout(G.mapChoice); // mapa elegido en el menú
  audio.setAmbience(G.mapChoice);
  G.mode = 'practice';
  spawnLocal('red', world.spawns.red[1]);
  G.dummies = new Dummies(scene, world);
  G.crates = new AmmoCrates(scene, false, world.cratePos ?? undefined);
  // en práctica el pedestal especial siempre ofrece el sniper (probar tiro)
  if (world.specialSpot) { G.specialRound = 1; spawnSpecialForRound(); }
  hud.showMenu(false);
  showControls(false);
  hud.show(true);
  hud.score(0, 0);
  hud.center(t('msg.practice'), t('msg.practiceSub'), 2600);
  audio.roundStart();
  input.requestLock();
  setTimeout(() => hud.hint(t('msg.axisHint', { state: t(input.invertY ? 'msg.inverted' : 'msg.normal') }), 3000), 3000);
}

async function connectOnlineLobby(action) {
  dismissSplash();
  audio.ensure();
  enterFullscreen();
  G.name = saveName();
  const url = inServer.value.trim();
  if (!url) { netStatus.textContent = t('msg.serverUrl'); return; }
  localStorage.setItem('breach.server', url);
  netStatus.textContent = t('msg.connecting');
  const net = new NetClient();
  bindNet(net);
  const mySeq = ++startSeq;
  try {
    const welcome = await net.connect(url, G.name, G.charVariant, action);
    // si durante el await el usuario arrancó OTRA partida (vs bots, práctica),
    // este welcome tardío no debe secuestrarla
    if (startSeq !== mySeq) { net.close(); return; }
    teardown({ keepLobby: false });
    G.net = net;
    G.team = welcome.team;
    G.lobby = welcome.lobby;
    G.lobbyKind = 'online';
    G.mode = null;
    hud.show(false); hud.showMenu(true); showControls(false); input.releaseLock();
    lobbyUI.show(G.lobby, net.id, 'online');
    audio.lobbyEnter();
    netStatus.textContent = '';
  } catch (e) {
    netStatus.textContent = t('msg.error', { message: e.message });
  }
}

function onlineHumanTargets() {
  const out = [];
  if (G.player) out.push({ id: G.net.id, team: G.team, x: G.player.pos.x, z: G.player.pos.z,
    y: G.player.y, alive: G.selfAlive, hp: G.selfHp, crouch: isCrouchState(G.player.animState()) });
  for (const r of G.remotes.values()) if (!r.bot) out.push({ id: r.id, team: r.team, x: r.x, z: r.z,
    y: r.y || 0, alive: r.alive, hp: r.hp ?? 100, crouch: isCrouchState(r.st) });
  return out;
}

function setupOnlineBots(roster) {
  if (G.lobby?.hostId !== G.net?.id) return;
  const slots = roster.filter((p) => p.bot);
  G.botMatch = new BotMatch(scene, world, {
    smoke, specials, rockets,
    effects, audio, hud, humans: onlineHumanTargets,
    playing: () => G.onlinePhase === 'playing',
    stepSound,
    botFire: (bot, origin, point, wep, impacts) => G.net?.botFire(bot.id, origin, point, wep, impacts),
    botHit: (bot, targetId, dmg, part, gib, point, meta) =>
      G.net?.botHit(bot.id, targetId, dmg, part, gib, point, meta),
    claimBotSpecial: (bot) => G.net?.send({ t: 'takeSpecial', bot: bot.id }),
  }, {
    external: true, playerTeam: G.team, rounds: G.onlineSettings.rounds, lives: G.onlineSettings.lives,
    bots: slots.map((b) => ({ id: b.id, name: b.name, team: b.team, variant: b.v,
      spawn: { x: b.x, z: b.z, yaw: b.team === 'red' ? Math.PI : 0 } })),
  });
  G.onlineBots = G.botMatch;
}

function setupOnlineMatch(m) {
  const net = G.net; if (!net) return;
  teardown({ keepNet: true, keepLobby: true });
  G.mode = 'online'; G.onlineSettings = m.settings || G.lobby.settings;
  G.onlinePhase = m.phase || 'intro'; G.onlineStartAt = m.startAt || 0;
  G.onlineWins = m.wins || { red: 0, blue: 0 }; G.scores = m.lives || { red: G.onlineSettings.lives, blue: G.onlineSettings.lives };
  G.mapChoice = G.onlineSettings.map; world.setLayout(G.mapChoice); effects.clearImpacts();
  audio.setAmbience(G.mapChoice);
  const roster = m.players || [];
  const mine = roster.find((p) => p.id === net.id);
  if (!mine) return;
  spawnLocal(mine.team, { x: mine.x, z: mine.z, yaw: mine.team === 'red' ? Math.PI : 0 });
  G.crates = new AmmoCrates(scene, true, world.cratePos ?? undefined);
  G.drops = new WeaponDrops(scene);
  spawnOnlineSpecial(m.special);
  G.onlineRows = roster.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot,
    variant: p.v | 0, kills: p.kills || 0, deaths: p.deaths || 0, score: (p.kills || 0) * 100 }));
  const host = G.lobby?.hostId === net.id;
  for (const p of roster) if (p.id !== net.id && !(host && p.bot)) addRemote(p);
  setupOnlineBots(roster);
  lobbyUI.hide(); hud.showMenu(false); showControls(false); hud.show(true);
  hud.score(G.scores.red, G.scores.blue, 'hud.lives'); hud.roundPips(G.onlineWins.red, G.onlineWins.blue);
  input.requestLock();
}

function saveName() {
  const n = (inName.value.trim() || 'CHUCK').toUpperCase();
  localStorage.setItem('breach.name', n);
  return n;
}

function addRemote(p) {
  const prev = G.remotes.get(p.id);
  if (prev) prev.dispose(scene); // id repetido: no dejar rigs huérfanos
  const r = new RemotePlayer(scene, p.id, p.name, p.team, p.v | 0);
  r.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y);
  r.rig.collideFn = (pt, y, radius = RAGDOLL_R) => world.resolveCircle(pt, radius, y);
  r.alive = p.alive !== false;
  r.bot = !!p.bot;
  // posición real desde el welcome: sin ella nacían apilados en (0,0)
  if (typeof p.x === 'number') { r.x = p.x; r.z = p.z; }
  G.remotes.set(p.id, r);
}

// ---------- red ----------
function bindNet(net) {
  // TODO handler ignora mensajes de sockets que ya no son la sesión activa
  // (sin esto, un reconectar fallido o mensajes bufereados del socket viejo
  // ejecutaban acciones — kill/respawn/teleport — sobre la partida NUEVA)
  const alive = () => G.net === net;
  net.on('lobby', (m) => {
    if (!alive()) return;
    G.lobby = m; G.lobbyKind = 'online';
    const mine = m.players?.find((p) => p.id === net.id); if (mine) G.team = mine.team;
    if (!G.mode) lobbyUI.show(m, net.id, 'online');
  });
  net.on('lobbyError', (m) => {
    if (!alive()) return;
    const message = m.code === 'invalid' && m.detail
      ? m.detail.split(',').map((code) => t(`lobby.error.${code}`)).join(' · ')
      : t(`lobby.error.${m.code}`);
    netStatus.textContent = message;
    if (G.lobby) {
      G.lobby.validation = { ...(G.lobby.validation || {}), ok: false,
        errors: m.detail ? m.detail.split(',') : [m.code] };
      lobbyUI.render(G.lobby);
    }
  });
  net.on('matchStart', (m) => { if (alive()) setupOnlineMatch(m); });
  net.on('host', (m) => {
    if (!alive()) return;
    if (G.lobby) G.lobby.hostId = m.id;
    if (!G.mode) lobbyUI.render(G.lobby);
    else if (m.id === net.id && !G.onlineBots) {
      const roster = G.onlineRows.map((row) => {
        const r = G.remotes.get(row.id);
        return { ...row, v: row.variant, x: r?.x || 0, z: r?.z || 0 };
      });
      for (const p of roster) if (p.bot) {
        const r = G.remotes.get(p.id); if (r) { r.dispose(scene); G.remotes.delete(p.id); }
      }
      setupOnlineBots(roster);
    }
  });
  net.on('joined', (m) => {
    if (!alive() || m.id === net.id) return;
    addRemote(m);
    if (!G.onlineRows.some((r) => r.id === m.id)) G.onlineRows.push({
      id: m.id, name: m.name, team: m.team, variant: m.v | 0, kills: 0, deaths: 0, score: 0,
    });
    hud.hint(t('msg.joined', { name: m.name }), 1400);
  });
  net.on('left', (m) => {
    if (!alive()) return;
    const r = G.remotes.get(m.id);
    if (r) { r.dispose(scene); G.remotes.delete(m.id); }
    G.onlineRows = G.onlineRows.filter((row) => row.id !== m.id);
  });
  net.on('snap', (m) => {
    if (!alive()) return;
    G.onlinePhase = m.phase || G.onlinePhase;
    if (m.lives) G.scores = m.lives;
    if (m.wins) G.onlineWins = m.wins;
    for (const p of m.ps) {
      if (p.id === net.id) {
        // G.selfAlive: el golpe mortal ya sonó con 'death' — sin el guard
        // sonaba hurt + shake + rumble sobre un jugador ya muerto
        if (p.hp < G.selfHp && G.selfAlive) { audio.hurt(); shoulderCam.addShake(0.4); input.pad.rumble(140, 0.5, 0.7); }
        G.selfHp = p.hp;
        continue;
      }
      const hosted = G.onlineBots?.botById(p.id);
      if (hosted) { hosted.hp = p.hp; hosted.protT = p.inv ? Math.max(hosted.protT, .12) : 0; continue; }
      const r = G.remotes.get(p.id);
      if (r) { r.push(p); r.alive = !!p.alive; r.hp = p.hp; }
    }
  });
  net.on('fire', (m) => {
    if (!alive() || m.id === net.id || G.onlineBots?.botById(m.id)) return;
    // validar: un cliente malicioso podía mandar o/p malformados y reventar
    // el handler de todos los demás
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.p)) return;
    const o = new THREE.Vector3(...m.o), p = new THREE.Vector3(...m.p);
    // un melee ajeno no es un disparo: la animación viaja por el estado y el
    // resultado por 'death'; sin trazadora, flash ni sonido de bala
    if (m.w === 'melee') return;
    effects.tracer(o, p);
    // Servidores nuevos reenvían todos los impactos estáticos de la escopeta;
    // con servidores anteriores, el endpoint único mantiene compatibilidad.
    const remoteMarks = Array.isArray(m.d) ? m.d.filter(okVec).slice(0, 8) : [m.p];
    for (const packed of remoteMarks) {
      const endpoint = new THREE.Vector3(...packed);
      const remoteDir = endpoint.sub(o);
      const remoteLen = remoteDir.length();
      if (remoteLen > 0.001) {
        remoteDir.multiplyScalar(1 / remoteLen);
        const contact = world.raycastHit(o, remoteDir, remoteLen + 0.08);
        if (contact && Math.abs(contact.t - remoteLen) < 0.12) {
          const point = o.clone().addScaledVector(remoteDir, contact.t);
          effects.impact(point, contact.normal, contact.surface);
          audio.impact(point, contact.surface);
        }
      }
    }
    effects.muzzleFlash(o, m.w === 'shotgun' || !!TUNING.weapons[m.w]?.special);
    const remoteShot = { position: o };
    audio.gun(m.w, remoteShot);
    const r = G.remotes.get(m.id);
    if (r) r.firing = 0.45;
  });
  net.on('hitConfirm', (m) => {
    if (!alive()) return;
    if (m.w === 'bazooka') {
      if (!Array.isArray(m.ep) || m.ep.length !== 3) return;
      const victimSelf = m.target === net.id;
      const victimRemote = victimSelf ? null : G.remotes.get(m.target);
      const victimBot = G.onlineBots?.botById(m.target);
      const victimPos = victimSelf ? G.player?.pos
        : victimRemote ? victimRemote
        : victimBot?.pos;
      const victimYaw = victimSelf ? G.player?.yaw
        : victimRemote ? victimRemote.yaw
        : victimBot?.yaw;
      const victimRig = victimSelf ? G.rig : (victimRemote?.rig || victimBot?.rig);
      if (!victimPos) return;
      const ctx = { weapon: 'bazooka', explosionPoint: m.ep };
      // Solo el dueño de una entidad modifica su posición. Los demás clientes
      // reproducen la reacción del torso y dejan la posición a su snapshot.
      if (victimSelf || victimBot) {
        const y = victimSelf ? G.player.y : victimBot.y;
        applyRocketImpact(victimPos, y, victimYaw, victimRig, ctx, +m.dmg || 0,
          victimSelf ? PLAYER_R : 0.38);
        if (victimBot) {
          victimBot.commitMove = false;
          victimBot.decisionT = 0;
        }
      } else {
        const dx = victimPos.x - m.ep[0], dz = victimPos.z - m.ep[2];
        const len = Math.max(0.08, Math.hypot(dx, dz));
        const side = (dx * Math.cos(victimYaw || 0)
          + dz * -Math.sin(victimYaw || 0)) / len;
        victimRig?.hitReact(side,
          Math.min(1.2, 0.45 + (+m.dmg || 0) / 85), 'explosion');
      }
      return;
    }
    if (m.w !== 'melee' || !Array.isArray(m.p) || m.p.length !== 3) return;
    const point = new THREE.Vector3(+m.p[0] || 0, +m.p[1] || 0, +m.p[2] || 0);
    const victimSelf = m.target === net.id;
    const victimRemote = victimSelf ? null : G.remotes.get(m.target);
    const victimBot = G.onlineBots?.botById(m.target);
    const attacker = m.from === net.id ? G.player
      : (G.remotes.get(m.from) || G.onlineBots?.botById(m.from));
    const victimPos = victimSelf ? G.player?.pos
      : victimRemote ? victimRemote
      : victimBot?.pos;
    const victimYaw = victimSelf ? G.player?.yaw
      : victimRemote ? victimRemote.yaw
      : victimBot?.yaw;
    const victimRig = victimSelf ? G.rig : (victimRemote?.rig || victimBot?.rig);
    // El atacante ya predijo la reacción local para que el golpe no espere al
    // ping. Los demás clientes la reproducen desde la confirmación autoritativa.
    if (m.from !== net.id && victimRig && attacker && victimPos) {
      const ap = attacker.pos || attacker;
      const dx = victimPos.x - ap.x, dz = victimPos.z - ap.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      const side = (dx * Math.cos(victimYaw || 0) + dz * -Math.sin(victimYaw || 0)) / len;
      victimRig.hitReact(side, Math.min(1.2, (+m.dmg || 60) / 50), 'melee');
    }
    if (m.from !== net.id) {
      const team = victimSelf ? G.team : (victimRemote?.team || victimBot?.team || 'blue');
      effects.meleeImpact(point, TEAM_HEX[team]);
      audio.meleeImpact({ position: point }, false);
    }
  });
  net.on('rocket', (m) => {
    if (!alive() || m.id === net.id) return;
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.d)) return;
    // mine=false: se ve y se oye, pero el daño lo reclama su dueño
    const source = G.remotes.get(m.id) || G.onlineBots?.botById?.(m.id);
    rockets.fire(
      { x: m.o[0], y: m.o[1], z: m.o[2] },
      new THREE.Vector3(m.d[0], m.d[1], m.d[2]).normalize(),
      false,
      source ? { id: m.id, team: source.team } : null,
    );
  });
  // arma especial online: el SERVIDOR decide quién se la lleva
  net.on('specialTaken', (m) => {
    specials.clear();
    if (!TUNING.weapons[m.wep]) return;
    if (m.id !== net.id) {
      G.onlineBots?.grantBotSpecial?.(m.id, m.wep);
      return;
    }
    const removed = G.weapons.giveSpecial(m.wep);
    audio.reloadDone();
    hud.hint(t('msg.specialTaken', {
      weapon: t(TUNING.weapons[m.wep].nameKey),
      removed: t(TUNING.weapons[removed].nameKey),
    }), 2400);
    input.pad.rumble(80, 0.4, 0.6);
  });
  net.on('nade', (m) => {
    if (!alive() || m.id === net.id) return;
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.v)) return;
    // cada cliente simula el mismo proyectil desde el mismo estado inicial:
    // la física es determinista y la nube cae en el mismo lugar para todos
    smoke.throwNade(
      { x: m.o[0], y: m.o[1], z: m.o[2] },
      { x: m.v[0], y: m.v[1], z: m.v[2] },
    );
  });
  net.on('death', (m) => {
    if (!alive() || !G.player) return;
    const isSelf = m.target === net.id;
    const hostedVictim = G.onlineBots?.botById(m.target);
    const victim = isSelf ? null : G.remotes.get(m.target);
    // `hs` solo lo produce el servidor después de validar arma, zona y
    // letalidad. El cliente nunca predice/desmiembra un headshot online.
    const sniperHeadshot = !!m.hs && isSniperHeadshotDeath(m.w, m.part);
    // `ex` también es autoritativo: el cliente solo presenta el nivel que el
    // servidor derivó de arma, distancia real a la explosión y daño letal.
    const explosiveLevel = rocketDeathLevel({
      weapon: m.w, rocketDeathLevel: m.w === 'bazooka' ? m.ex : 0,
    });
    const killer = m.from === net.id
      ? { x: G.player.pos.x, z: G.player.pos.z }
      : (() => {
        const k = G.remotes.get(m.from) || G.onlineBots?.botById(m.from)?.pos;
        return k ? { x: k.x, z: k.z } : null;
      })();
    const deathCtx = {
      weapon: m.w, distance: m.dist, damage: m.dmg, part: m.part,
      point: m.p, sniperHeadshot, rocketDeathLevel: explosiveLevel,
      explosionPoint: m.ep, gib: !!m.gib,
    };
    const deathImpactFor = (pos) => {
      const ep = Array.isArray(m.ep) ? { x: m.ep[0], z: m.ep[2] } : null;
      if (explosiveLevel && ep) return { x: pos.x - ep.x, z: pos.z - ep.z };
      return killer ? { x: pos.x - killer.x, z: pos.z - killer.z } : null;
    };
    // sin víctima conocida y no soy yo: solo killfeed (el fallback anterior
    // reventaba la sangre encima del jugador local)
    if (victim || isSelf) {
      const pos = victim
        ? { x: victim.x, y: victim.y || 0, z: victim.z }
        : { x: G.player.pos.x, y: G.player.y || 0, z: G.player.pos.z };
      const vteam = victim ? victim.team : G.team;
      const impact = deathImpactFor(pos);
      if (sniperHeadshot) {
        effects.sniperHeadshot(deathImpactPoint(deathCtx, pos), TEAM_HEX[vteam], impact, pos.y);
      } else if (explosiveLevel) {
        rocketDeathFx(pos, vteam, { ...deathCtx, impact }, pos.y);
      } else if (m.gib) effects.gib(new THREE.Vector3(pos.x, pos.y, pos.z), TEAM_HEX[vteam]);
      else effects.blood(new THREE.Vector3(pos.x, 1, pos.z), TEAM_HEX[vteam]);
    }
    if (hostedVictim) {
      const attacker = m.from === net.id ? G.player?.pos : (G.onlineBots?.botById(m.from)?.pos || G.remotes.get(m.from));
      G.onlineBots.killExternal(m.target, {
        impact: attacker ? { x: hostedVictim.pos.x - attacker.x, z: hostedVictim.pos.z - attacker.z } : null,
        ...deathCtx,
      });
      const hostedPos = { x: hostedVictim.pos.x, y: hostedVictim.y || 0, z: hostedVictim.pos.z };
      const hostedImpact = deathImpactFor(hostedPos);
      if (sniperHeadshot) {
        effects.sniperHeadshot(deathImpactPoint(deathCtx, hostedPos), TEAM_HEX[hostedVictim.team], hostedImpact, hostedPos.y);
      } else if (explosiveLevel) {
        rocketDeathFx(hostedPos, hostedVictim.team,
          { ...deathCtx, impact: hostedImpact }, hostedPos.y);
      } else if (m.gib) effects.gib(new THREE.Vector3(hostedPos.x, hostedPos.y, hostedPos.z), TEAM_HEX[hostedVictim.team]);
      else effects.blood(new THREE.Vector3(hostedVictim.pos.x, hostedVictim.y + 1, hostedVictim.pos.z), TEAM_HEX[hostedVictim.team]);
    }
    hud.kill(m.kn, m.kt, m.vn, m.vt);
    const killerRow = G.onlineRows.find((r) => r.id === m.from);
    const victimRow = G.onlineRows.find((r) => r.id === m.target);
    if (killerRow) { killerRow.kills++; killerRow.score = killerRow.kills * 100; }
    if (victimRow) victimRow.deaths++;
    // contexto físico para el ragdoll (dirección del tiro + momentum previo)
    if (victim) {
      victim.alive = false; // cycling spectator no espera al siguiente snapshot
      // velocidad aproximada del remoto desde sus últimos snapshots
      const b = victim.buf;
      let rv = { x: 0, z: 0 };
      if (b.length >= 2) {
        const s1 = b[b.length - 2], s2 = b[b.length - 1];
        const dt2 = Math.max(0.03, s2.rt - s1.rt);
        rv = { x: (s2.x - s1.x) / dt2, z: (s2.z - s1.z) / dt2 };
      }
      victim.rig.setDeathContext({
        impact: deathImpactFor(victim),
        power: m.gib || m.w === 'melee' || explosiveLevel ? 1 : sniperHeadshot ? 0.95 : 0.6,
        vel: rv,
        state: victim.st,
        ...deathCtx,
      });
    }
    if (m.target === net.id) {
      G.selfAlive = false;
      G.weapons.cancelActions();
      G.rig.setDeathContext({
        impact: deathImpactFor(G.player.pos),
        power: m.gib || m.w === 'melee' || explosiveLevel ? 1 : sniperHeadshot ? 0.95 : 0.6,
        vel: { x: G.player.vel.x, z: G.player.vel.z },
        state: G.player.animState(),
        ...deathCtx,
      });
      G.player.kill();
      enterSpectator();
      audio.death();
      input.pad.rumble(350, 0.8, 1.0);
      G.respawnT = TUNING.combat.respawnTime;
    } else if (m.from === net.id) {
      audio.kill();
      hud.hitmarker();
    } else {
      audio.kill();
    }
  });
  net.on('crate', (m) => {
    if (!alive()) return;
    G.crates?.setState(m.i, !!m.up);
    // el refill llega SOLO con la confirmación del server (rellenar al pisar
    // la caja + reintento de 1.5s daba munición infinita si otro la ganó)
    if (!m.up && m.by === net.id && G.weapons) {
      G.weapons.refill();
      audio.reloadDone();
      hud.hint(t('msg.ammoFull'), 1400);
      input.pad.rumble(60, 0.2, 0.3);
    }
  });
  // la vida viaja en 'life': 't' es el discriminador del protocolo (usarlo
  // de 8º argumento dejaba d.t = 'dropA' → NaN → arma invisible en online)
  net.on('dropA', (m) => { if (alive()) G.drops?.spawn(m.id, m.wep, m.x, m.z, m.team, 0, 0, m.life ?? 8, m.y || 0); });
  net.on('dropR', (m) => { if (alive()) G.drops?.remove(m.id); });
  net.on('dropGive', (m) => {
    if (!alive()) return;
    const def = TUNING.weapons[m.wep];
    if (!def) return;
    let s = G.weapons.state[m.wep];
    if (!s && def.special) {
      G.weapons.giveSpecial(m.wep);
      s = G.weapons.state[m.wep];
      s.mag = Math.min(def.mag, Math.max(0, m.mag || 0));
      s.reserve = Math.min(def.reserve, Math.max(0, m.res || 0));
      G.rig?.setWeapon?.(m.wep);
      audio.reloadDone();
      hud.hint(t('msg.weaponRecovered', { weapon: t(def.nameKey) }), 1500);
      return;
    }
    if (!s) return;
    const total = (m.mag || 0) + (m.res || 0);
    const gained = Math.min(def.reserve, s.reserve + total) - s.reserve;
    s.reserve += gained;
    audio.reloadDone();
    hud.hint(t('msg.bulletsOf', { count: gained, weapon: t(def.nameKey) }), 1500);
  });
  net.on('respawn', (m) => {
    if (!alive() || !G.player || !G.rig) return;
    if (m.id === net.id) {
      G.selfAlive = true;
      G.selfHp = TUNING.combat.hp;
      G.respawnT = 0;
      G.player.respawn(m.spawn);
      G.weapons.reset();
      G.rig.setWeapon('smg');
      exitSpectator();
      // El reset de fin de partida coloca al jugador antes de la presentación;
      // la protección empieza al terminar el 3…2…1, no 13 s antes.
      if (!G.onlineFinal && G.onlineStartAt <= Date.now() / 1000) grantSpawnProtection();
      hud.centerOff();
    } else if (G.onlineBots?.botById(m.id)) {
      G.onlineBots.respawnExternal(m.id, m.spawn);
    } else {
      const r = G.remotes.get(m.id);
      if (r) {
        r.alive = true;
        // teleport limpio al spawn: sin esto interpolaba deslizándose
        // desde la posición de la muerte cruzando medio mapa
        r.buf.length = 0;
        if (m.spawn) { r.x = m.spawn.x; r.z = m.spawn.z; r.y = 0; }
      }
    }
  });
  net.on('score', (m) => { if (alive()) {
    G.scores = { red: m.red, blue: m.blue }; if (m.wins) G.onlineWins = m.wins;
    hud.score(m.red, m.blue, 'hud.lives'); hud.roundPips(G.onlineWins.red, G.onlineWins.blue);
  } });
  net.on('roundEnd', (m) => {
    if (!alive()) return;
    G.onlinePhase = 'intermission'; G.onlineWins = m.wins || G.onlineWins;
    G.onlineRoundResult = { winner: m.winner, wins: G.onlineWins,
      rows: (m.rows || G.onlineRows).map((r) => ({ ...r, score: r.score ?? (r.kills || 0) * 100 })) };
  });
  net.on('win', (m) => {
    if (!alive()) return;
    G.onlineStartAt = 0;
    G.onlineFinal = {
      team: m.team, at: Date.now() / 1000,
      rows: (m.rows || G.onlineRows).map((r) => ({ ...r, score: r.score ?? (r.kills || 0) * 100 })),
      wins: m.wins || { ...G.onlineWins },
    };
    G.onlineRoundResult = null; G.onlinePhase = 'final';
  });
  net.on('prepare', (m) => {
    if (!alive()) return;
    G.onlineFinal = null;
    G.onlineRoundResult = null; G.onlinePhase = m.phase || 'countdown';
    G.onlineStartAt = m.startAt || (Date.now() / 1000 + INTRO_TIME + COUNTDOWN_TIME);
    spawnOnlineSpecial(m.special);
    if (m.lives) G.scores = m.lives;
    if (m.wins) G.onlineWins = m.wins;
    if (m.players) G.onlineRows = m.players.map((p) => ({
      id: p.id, name: p.name, team: p.team, bot: p.bot, variant: p.v | 0,
      kills: p.kills || 0, deaths: p.deaths || 0, score: (p.kills || 0) * 100,
    }));
    if (m.players && G.player) {
      for (const p of m.players) {
        const spawn = { x: p.x, z: p.z, yaw: p.team === 'red' ? Math.PI : 0 };
        if (p.id === net.id) {
          G.selfAlive = true; G.selfHp = TUNING.combat.hp; G.respawnT = 0;
          G.player.respawn(spawn); G.weapons.reset(); exitSpectator();
        } else if (G.onlineBots?.botById(p.id)) G.onlineBots.respawnExternal(p.id, spawn);
        else {
          const r = G.remotes.get(p.id);
          if (r) { r.alive = true; r.buf.length = 0; r.x = p.x; r.z = p.z; r.y = 0; }
        }
      }
    }
    hud.centerOff();
  });
  net.on('start', () => {
    if (!alive()) return;
    G.onlineStartAt = 0; G.onlinePhase = 'playing'; G.onlineRoundResult = null;
    audio.roundStart();
  });
  net.on('returnLobby', () => {
    if (!alive()) return;
    teardown({ keepNet: true, keepLobby: true });
    G.mode = null; G.onlinePhase = 'lobby';
    showMenuBackdrop(); hud.show(false); hud.showMenu(true); input.releaseLock();
    if (G.lobby) { lobbyUI.show(G.lobby, net.id, 'online'); audio.lobbyEnter(); }
  });
  net.on('close', () => {
    if (!alive()) return; // un intento de conexión fallido no mata la partida en curso
    G.mode = null;
    teardown({ keepLobby: false });
    showMainMenuFromLobby(t('msg.serverDisconnected'));
  });
}

// ---------- pasos posicionales (bots / remotos) ----------
// Todos los pasos ajenos usan la misma curva 3D que disparos e impactos.
function stepSound(x, z, kind, y = 0) {
  if (!G.player) return;
  audio.footstep(kind, { position: { x, y: y + 0.22, z } });
}

// ---------- disparos ----------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const CROUCH_STATES = new Set(['cover_low', 'blind_over', 'blind_low_left', 'blind_low_right']);
const isCrouchState = (st) => CROUCH_STATES.has(st);

function currentTargets() {
  if (G.mode === 'practice') return G.dummies ? G.dummies.targets() : [];
  if (G.mode === 'bots') return G.botMatch ? G.botMatch.targets() : [];
  const out = [];
  if (G.mode === 'online' && G.onlineBots) out.push(...G.onlineBots.targets());
  for (const r of G.remotes.values()) {
    if (r.team !== G.team) out.push({
      id: r.id, x: r.x, z: r.z, y: r.y ?? 0, alive: r.alive,
      crouch: isCrouchState(r.st), protected: !!r.inv,
    });
  }
  return out;
}

// Cuerpos de TODOS los personajes vivos (ambos equipos) para la colisión
// jugador-personaje; currentTargets() no sirve aquí porque excluye aliados.
function characterBodies() {
  const out = [];
  if (G.mode === 'bots' && G.botMatch) {
    for (const b of G.botMatch.bots) if (b.alive) out.push({ x: b.pos.x, z: b.pos.z, y: b.y });
  } else if (G.mode === 'practice' && G.dummies) {
    for (const tg of G.dummies.targets()) {
      if (tg.alive !== false) out.push({ x: tg.x, z: tg.z, y: tg.y ?? 0 });
    }
  } else if (G.mode === 'online') {
    for (const r of G.remotes.values()) {
      if (r.alive) out.push({ x: r.x, z: r.z, y: r.y ?? 0 });
    }
    for (const b of G.onlineBots?.bots ?? []) {
      if (b.alive) out.push({ x: b.pos.x, z: b.pos.z, y: b.y });
    }
  }
  return out;
}

// Todos los personajes vivos CON su equipo (para la espoleta de los cohetes,
// que debe distinguir bandos sin importar quién lo lanzó).
function allCharacterTargets() {
  const out = [];
  if (G.mode === 'bots' && G.botMatch) {
    for (const b of G.botMatch.bots) {
      if (b.alive) out.push({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true, team: b.team });
    }
    if (G.selfAlive && G.player && !G.player.dead) {
      out.push({ id: 'player', x: G.player.pos.x, z: G.player.pos.z, y: G.player.y, alive: true, team: G.team });
    }
    return out;
  }
  if (G.mode === 'online') {
    if (G.selfAlive && G.player && !G.player.dead) {
      out.push({ id: G.net?.id, x: G.player.pos.x, z: G.player.pos.z, y: G.player.y,
        alive: true, team: G.team });
    }
    for (const r of G.remotes.values()) if (r.alive) {
      out.push({ id: r.id, x: r.x, z: r.z, y: r.y ?? 0, alive: true, team: r.team });
    }
    for (const b of G.onlineBots?.bots ?? []) if (b.alive) {
      out.push({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true, team: b.team });
    }
    return out;
  }
  return currentTargets();
}

// Dirección de hipfire/blindfire: paralela a la cámara, con ORIGEN en el cañón
// La mira sigue a la cámara; el personaje rota para acompañarla.
function hipDir() {
  const f = shoulderCam.flatForward();
  const p = shoulderCam.pitch;
  const cp = Math.cos(p), sp = Math.sin(p);
  return new THREE.Vector3(f.x * cp, sp, f.z * cp).normalize();
}

function staticHitDistance(origin, dir, maxDist) {
  // raycastHit incluye suelo, helipuerto y rampas; raycast es el fallback
  // simplificado usado por locomoción. La retícula debe seguir balística.
  return world.raycastHit?.(origin, dir, maxDist)?.t ??
    world.raycast(origin, dir, maxDist) ?? maxDist;
}

function currentFireDirection(muzzle, maxRange = 80) {
  if (!G.player.aim) return hipDir();
  const ray = shoulderCam.aimRay();
  const guide = resolveShot(world, currentTargets(), ray.origin, ray.dir, maxRange, null);
  return _v3.copy(guide.point).sub(muzzle).normalize();
}

function coverFireClear() {
  const p = G.player;
  if (!p || p.state !== 'cover' || !p.cover) return true;
  G.rig.setTransform(p.pos.x, p.pos.z, p.yaw, p.y);
  G.rig.root.updateWorldMatrix(true, true);
  const muzzle = G.rig.muzzleWorld(_v1);
  const weaponRoot = G.rig.gunMount.getWorldPosition(_v2);
  const dir = currentFireDirection(muzzle, G.weapons?.def?.range ?? 80);
  if (!muzzleHasClearance(world, p.cover, weaponRoot, muzzle, dir)) return false;
  if (p.blindMode === 'left' || p.blindMode === 'right') {
    const point = (o) => o.getWorldPosition(new THREE.Vector3());
    const segments = [];
    for (const arm of [G.rig.armL, G.rig.armR]) {
      const shoulder = point(arm.shoulder), elbow = point(arm.elbow), hand = point(arm.hand);
      segments.push([shoulder, elbow], [elbow, hand]);
    }
    if (!segmentsHaveClearance(world, segments)) return false;
  }
  return true;
}

function coverPoseReady(wantsAim, wantsFire) {
  const p = G.player;
  if (!p || p.state !== 'cover' || !p.cover) return true;
  // El primer click del mismo frame que inicia ADS/blindfire debe entrar al
  // buffer, no consumirse ni perderse antes de que el rig adopte la pose.
  const low = p.cover.h <= TUNING.cover.lowHeight;
  if (wantsAim && low && p.coverAimExposure < 0.82) return false;
  if (wantsFire && !wantsAim &&
      (!p.blindMode || p.blindPoseExposure < TUNING.cover.blindFireReady)) return false;
  return true;
}

// Online: el arma de la ronda la decide el SERVIDOR (llega en matchStart/
// prepare). El cliente solo dibuja el pedestal.
function spawnOnlineSpecial(info) {
  const spot = world.specialSpot;
  specials.clear();
  rockets.clear();
  if (!spot || !info?.wep || !TUNING.weapons[info.wep]) return;
  specials.spawn(info.wep, spot.x, spot.z,
    world.groundHeight({ x: spot.x, z: spot.z }, 0.4, 0.1));
}

// Coloca el arma especial de la ronda en el pedestal del mapa (si lo tiene)
function spawnSpecialForRound() {
  const spot = world.specialSpot;
  if (!spot) { specials.clear(); return; }
  const wep = G.specialRound % 2 === 1 ? 'sniper' : 'bazooka';
  specials.spawn(wep, spot.x, spot.z, world.groundHeight({ x: spot.x, z: spot.z }, 0.4, 0.1));
}

// Explosión del cohete: splash con caída por distancia, línea de efecto (no
// atraviesa paredes) y AUTODAÑO — dispararla cerca es un riesgo real.
function explodeRocket(pos, mine = true, owner = null, boomInfo = null) {
  const d = TUNING.weapons.bazooka;
  const R = d.splashRadius;
  _v1.set(pos.x, pos.y, pos.z);
  const visualPos = boomInfo?.visualPos || pos;
  _v3.set(visualPos.x, visualPos.y, visualPos.z);
  const blastFloor = world.groundHeight(
    { x: visualPos.x, z: visualPos.z }, 0.08, visualPos.y);
  effects.rocketExplosion(_v3, {
    direct: !!boomInfo?.direct,
    normal: boomInfo?.normal,
    surface: boomInfo?.surface,
    floorY: blastFloor,
  });
  audio.explosion({ position: _v3, direct: !!boomInfo?.direct });
  if (G.player) {
    const pd = Math.hypot(G.player.pos.x - pos.x, (G.player.y + 1) - pos.y,
      G.player.pos.z - pos.z);
    const feedback = Math.max(0, 2.15 - pd * 0.18);
    shoulderCam.addShake(feedback);
    if (feedback > 0.18) input.pad.rumble(
      Math.round(80 + Math.min(180, feedback * 75)),
      Math.min(0.72, 0.28 + feedback * 0.16),
      Math.min(1, 0.45 + feedback * 0.22));
  }
  // el cohete de OTRO jugador solo se ve y se oye: su daño lo reclama su
  // dueño contra el servidor (si no, cada cliente aplicaría el splash)
  if (!G.mode || !mine) return;
  const splash = (dist) => rocketSplashDamage(d, dist);
  const deathContext = (targetId, dist, dmg) => {
    const direct = !!boomInfo?.direct && boomInfo?.targetId === targetId;
    return {
      weapon: 'bazooka', distance: dist, damage: dmg, part: 'body',
      direct, explosionPoint: { x: pos.x, y: pos.y, z: pos.z }, gib: false,
    };
  };
  const onlineSplash = [];

  // En online, los bots pertenecen al host pero el disparo sigue siendo del
  // bot. Registrar fire/hit con su id evita atribuir el splash al host.
  if (owner && G.mode === 'online' && G.net && G.onlineBots) {
    const losOK = (x, y, z) => {
      _v2.set(x - pos.x, y - pos.y, z - pos.z);
      const len = _v2.length();
      return len <= 0.4 || world.raycast(_v1, _v2.normalize(), len - 0.2) === null;
    };
    for (const tg of allCharacterTargets()) {
      if (tg.alive === false || tg.id === owner.id || tg.team === owner.team) continue;
      const ty = (tg.y ?? 0) + 0.9;
      const dist = Math.hypot(tg.x - pos.x, ty - pos.y, tg.z - pos.z);
      if (dist > R || !losOK(tg.x, ty, tg.z)) continue;
      onlineSplash.push({ id: tg.id, dmg: splash(dist), point: { x: tg.x, y: ty, z: tg.z } });
    }
    const self = G.onlineBots.botById(owner.id);
    let selfHit = null;
    if (self?.alive) {
      const sy = self.y + 0.9;
      const sd = Math.hypot(self.pos.x - pos.x, sy - pos.y, self.pos.z - pos.z);
      if (sd < R && losOK(self.pos.x, sy, self.pos.z)) {
        selfHit = { id: self.id, dmg: splash(sd) * 0.7, point: { x: self.pos.x, y: sy, z: self.pos.z } };
      }
    }
    _v2.copy(_v1);
    G.net.botFire(owner.id, _v1, _v2, 'bazooka', []);
    for (const c of onlineSplash) G.net.botHit(owner.id, c.id, c.dmg, 'body', false, c.point);
    if (selfHit) G.net.botHit(owner.id, selfHit.id, selfHit.dmg, 'body', false, selfHit.point);
    return;
  }

  // Cohete lanzado por un BOT: daña al bando contrario (jugador incluido) y
  // a su propio dueño si se pasó de cerca. No toca a sus compañeros.
  if (owner && G.mode === 'bots' && G.botMatch) {
    const losOK = (x, y, z) => {
      _v2.set(x - pos.x, y - pos.y, z - pos.z);
      const len = _v2.length();
      return len <= 0.4 || world.raycast(_v1, _v2.normalize(), len - 0.2) === null;
    };
    for (const b of G.botMatch.bots) {
      if (!b.alive || b.team === owner.team) continue;
      const by = b.y + 0.9;
      const dist = Math.hypot(b.pos.x - pos.x, by - pos.y, b.pos.z - pos.z);
      if (dist > R || !losOK(b.pos.x, by, b.pos.z)) continue;
      const dmg = splash(dist);
      const ctx = deathContext(b.id, dist, dmg);
      G.botMatch.damageBot(b.id, dmg, owner.id, false, false, ctx);
    }
    // al jugador solo si es del bando contrario
    const p = G.player;
    if (p && G.selfAlive && !p.dead && G.team !== owner.team) {
      const sy = p.y + 0.9;
      const sd = Math.hypot(p.pos.x - pos.x, sy - pos.y, p.pos.z - pos.z);
      if (sd < R && losOK(p.pos.x, sy, p.pos.z)) {
        const dmg = splash(sd);
        const died = damagePlayerLocal(dmg, owner.name ?? 'BOT', { x: pos.x, z: pos.z },
          deathContext('player', sd, dmg));
        if (died) G.botMatch._onDeath('player', owner.id, false);
      }
    }
    // autodaño del bot que lo disparó (mismo riesgo que el jugador)
    const self = G.botMatch.bots.find((b) => b.id === owner.id);
    if (self?.alive) {
      const sy = self.y + 0.9;
      const sd = Math.hypot(self.pos.x - pos.x, sy - pos.y, self.pos.z - pos.z);
      if (sd < R && losOK(self.pos.x, sy, self.pos.z)) {
        const dmg = splash(sd) * 0.7;
        G.botMatch.damageBot(self.id, dmg, self.id, false, true,
          deathContext(self.id, sd, dmg));
      }
    }
    return;
  }
  const losClear = (x, y, z) => {
    _v2.set(x - pos.x, y - pos.y, z - pos.z);
    const len = _v2.length();
    return len <= 0.4 || world.raycast(_v1, _v2.normalize(), len - 0.2) === null;
  };
  for (const tg of currentTargets()) {
    if (tg.alive === false) continue;
    const ty = (tg.y ?? 0) + 0.9;
    const dist = Math.hypot(tg.x - pos.x, ty - pos.y, tg.z - pos.z);
    if (dist > R || !losClear(tg.x, ty, tg.z)) continue;
    const dmg = splash(dist);
    const ctx = deathContext(tg.id, dist, dmg);
    if (G.mode === 'practice' && G.dummies) {
      effects.blood(_v3.set(tg.x, ty, tg.z), TEAM_HEX.blue);
      const killed = G.dummies.damage(tg.id, dmg, (dd) => {
        dd.rig.setDeathContext({
          impact: { x: dd.x - pos.x, z: dd.z - pos.z },
          power: Math.min(1, dmg / 55), vel: { x: 0, z: 0 }, state: 'run',
          rocketDeathLevel: rocketDeathLevel(ctx), ...ctx,
        });
        rocketDeathFx({ x: dd.x, y: 0, z: dd.z }, 'blue', ctx, 0);
        G.scores.red++;
        hud.score(G.scores.red, G.scores.blue);
        hud.kill(G.name, 'red', dd.name, 'blue');
        audio.kill();
      });
      hud.hitmarker();
      if (!killed) audio.hit();
    } else if (G.mode === 'bots' && G.botMatch) {
      const killed = G.botMatch.damageBot(tg.id, dmg, 'player', false, false, ctx);
      if (killed !== null) { hud.hitmarker(); if (!killed) audio.hit(); }
    } else if (G.net) {
      const r = G.remotes.get(tg.id);
      const b = G.onlineBots?.botById(tg.id);
      if ((!r && !b) || r?.inv || b?.protT > 0) continue;
      effects.blood(_v3.set(tg.x, ty, tg.z), TEAM_HEX[r?.team || b.team]);
      onlineSplash.push({ id: tg.id, dmg, point: { x: tg.x, y: ty, z: tg.z } });
      hud.hitmarker();
    }
  }
  // el server valida el disparo (explosión) y luego cada reclamo de daño
  const p = G.player;
  if (G.net) {
    _v2.set(pos.x, pos.y, pos.z);
    G.net.fire(_v1, _v2, 'bazooka', []);
    for (const c of onlineSplash) G.net.hit(c.id, c.dmg, 'body', false, c.point);
    if (p && G.selfAlive && !p.dead) {
      const sy = p.y + 0.9;
      const sd = Math.hypot(p.pos.x - pos.x, sy - pos.y, p.pos.z - pos.z);
      if (sd < R && losClear(p.pos.x, sy, p.pos.z)) {
        G.net.hit(G.net.id, splash(sd) * 0.7, 'body', false,
          { x: p.pos.x, y: sy, z: p.pos.z });
      }
    }
  }
  // autodaño (70% del splash) — solo donde hay muerte real del jugador
  if (G.mode === 'bots' && p && G.selfAlive && !p.dead) {
    const sy = p.y + 0.9;
    const sd = Math.hypot(p.pos.x - pos.x, sy - pos.y, p.pos.z - pos.z);
    if (sd < R && losClear(p.pos.x, sy, p.pos.z)) {
      const dmg = splash(sd) * 0.7;
      const died = damagePlayerLocal(dmg, G.name, { x: pos.x, z: pos.z },
        deathContext('player', sd, dmg));
      // el suicidio también consume vida y agenda respawn (sin esto el
      // jugador quedaba espectando para siempre)
      if (died && G.botMatch) G.botMatch.playerSelfDeath();
    }
  }
}

// Lanzar la granada de humo: sale de la mano con arco balístico. La nube la
// gestiona SmokeSystem (rebotes, delay, disipación). Si era la última, el
// personaje vuelve solo a su primaria.
function throwSmoke() {
  const p = G.player;
  const d = TUNING.weapons.grenade;
  G.rig.setTransform(p.pos.x, p.pos.z, p.yaw, p.y);
  const muzzle = G.rig.muzzleWorld(_v1);
  const dir = p.aim ? shoulderCam.aimRay().dir.clone() : hipDir();
  const o = { x: muzzle.x, y: muzzle.y, z: muzzle.z };
  const v = {
    x: dir.x * d.throwSpeed,
    y: dir.y * d.throwSpeed + d.throwUp,
    z: dir.z * d.throwSpeed,
  };
  smoke.throwNade(o, v);
  audio.whoosh();
  input.pad.rumble(45, 0.25, 0.35);
  G.rig.kick(0.5);
  G.net?.send({ t: 'nade', o: [o.x, o.y, o.z], v: [v.x, v.y, v.z] });
  // sin botes restantes: cambiar solo a la primaria (nunca quedarse
  // apuntando con la mano vacía)
  if (G.weapons.st.mag <= 0) G.weapons.startSwap(G.weapons.primary);
}

// Golpe melee: arco frontal corto. Pega al enemigo MÁS CERCANO dentro del
// arco (un objetivo por golpe), con línea al pecho para no golpear a través
// de paredes.
function resolveMelee() {
  const ml = TUNING.melee;
  const p = G.player;
  const f = p.facing();
  const cosHalf = Math.cos(ml.arcDeg * Math.PI / 360);
  let best = null;
  for (const tg of currentTargets()) {
    if (tg.alive === false || tg.protected) continue;
    const dx = tg.x - p.pos.x, dz = tg.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > ml.range) continue;
    if (Math.abs((tg.y ?? 0) - p.y) > ml.heightTolerance) continue;
    const dot = dist < 0.001 ? 1 : (dx * f.x + dz * f.z) / dist;
    if (dot < cosHalf) continue;
    // Lo más centrado gana sobre una diferencia mínima de distancia. Evita
    // que un hombro lateral robe el golpe al objetivo claramente frontal.
    const score = dist + (1 - dot) * 0.42;
    if (!best || score < best.score) best = { tg, dist, dx, dz, dot, score };
  }
  // el golpe rompe la protección de spawn propia aunque pegue al aire
  if (G.spawnProt > 0) { G.spawnProt = 0; hud.hint(t('msg.protectionBroken'), 900); }
  if (!best) return { connected: false, killed: false };
  const { tg, dist } = best;
  _v1.set(p.pos.x, p.y + 1.08, p.pos.z);
  const targetPoint = _v3.set(tg.x, (tg.y ?? 0) + (tg.crouch ? 0.78 : 1.02), tg.z);
  _v2.copy(targetPoint).sub(_v1);
  const strikeLen = _v2.length();
  if (strikeLen > 0.4 && world.raycast(_v1, _v2.normalize(),
      Math.max(0, strikeLen - ml.wallPadding)) !== null) {
    return { connected: false, killed: false };
  }
  const dmg = ml.dmg;
  const point = targetPoint.clone();
  const impactDir = new THREE.Vector3(best.dx, 0.12, best.dz).normalize();
  const attackerState = p.meleeEntryState || 'idle';
  const ctx = { weapon: 'melee', distance: dist, damage: dmg, part: 'body', gib: false,
    attackerState };
  let connected = false;
  let killed = false;
  let victimTeam = 'blue';
  if (G.mode === 'practice' && G.dummies) {
    connected = true;
    tg.rig?.hitReact?.(best.dot < 0.75 ? Math.sign(best.dx) : 0, 1, 'melee');
    G.dummies.recoil?.(tg.id, best.dx, best.dz, 0.16);
    killed = G.dummies.damage(tg.id, dmg, (d) => {
      d.rig.setDeathContext({
        impact: { x: d.x - p.pos.x, z: d.z - p.pos.z },
        power: Math.min(1, dmg / 55),
        vel: { x: best.dx * 0.18, z: best.dz * 0.18 },
        state: d.rigState || 'run',
        ...ctx,
      });
      G.scores.red++;
      hud.score(G.scores.red, G.scores.blue);
      hud.kill(G.name, 'red', d.name, 'blue');
      audio.kill();
    });
    if (!killed) audio.hit();
  } else if (G.mode === 'bots' && G.botMatch) {
    const result = G.botMatch.damageBot(tg.id, dmg, 'player', false, false, ctx);
    if (result !== null) { connected = true; killed = result; if (!killed) audio.hit(); }
    victimTeam = tg.team || 'blue';
  } else if (G.net) {
    const r = G.remotes.get(tg.id);
    const b = G.onlineBots?.botById(tg.id);
    if ((r || b) && !r?.inv && !(b?.protT > 0)) {
      connected = true;
      victimTeam = r?.team || b.team;
      (r?.rig || b?.rig)?.hitReact?.(best.dot < 0.75 ? Math.sign(best.dx) : 0, 1, 'melee');
      // el golpe viaja como disparo validable de corto alcance + su claim
      G.net.fire(_v1, point, 'melee', []);
      G.net.hit(tg.id, dmg, 'body', false, point);
    }
  }
  if (connected) {
    effects.meleeImpact(point, TEAM_HEX[victimTeam], impactDir);
    hud.hitmarker();
    audio.meleeImpact(null, killed);
    input.pad.rumble(killed ? 115 : 85, 0.58, killed ? 0.95 : 0.78);
    shoulderCam.addShake(killed ? 0.48 : 0.34);
  }
  return { connected, killed };
}

// primaria que se ve cargada a la espalda: la que no está en mano (con
// pistola o granada en mano se muestra la del segundo slot)
function backWeapon() {
  const w = G.weapons;
  return w.cur === w.slots[1] ? w.slots[0] : w.slots[1];
}

// Única fuente de verdad del scope. Es derivado, no un toggle: cualquier
// acción incompatible lo apaga en ese mismo frame y nunca puede quedar
// pegado después de cambiar arma, morir, golpear o entrar a spectator.
function sniperScopeActive() {
  const p = G.player, w = G.weapons;
  return !!(G.mode && p && w && G.selfAlive && !p.dead && p.aim &&
    w.cur === 'sniper' && !w.swapping && p.state !== 'melee' &&
    !G.spectator.active && !matchControlsLocked() && !menuIsOpen());
}

function fireShot() {
  const w = G.weapons, def = w.def;
  const aiming = G.player.aim;
  const scoped = sniperScopeActive();
  const inCover = G.player.state === 'cover';
  const spread = aiming ? def.spreadAim : (inCover ? def.spreadBlind : def.spreadHip);

  // El controller ya pudo girar este frame; sincronizar el root antes de leer
  // el muzzle evita lanzar el tracer desde la pose espacial anterior.
  G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
  const muzzle = G.rig.muzzleWorld(_v1).clone();
  let baseDir, origin, cameraOrigin = null;
  if (aiming) {
    const ray = shoulderCam.aimRay();
    baseDir = ray.dir.clone();
    // La cámara elige el punto percibido; la balística sale desde el cuerpo
    // para que una esquina entre arma y objetivo sí pueda bloquear el tiro.
    cameraOrigin = ray.origin.clone();
    origin = muzzle.clone();
  } else {
    baseDir = hipDir();
    origin = muzzle.clone();
  }

  // bazooka: proyectil REAL, sin hitscan — el cohete hace el daño al explotar
  if (def.projectile) {
    rockets.fire({ x: muzzle.x, y: muzzle.y, z: muzzle.z }, baseDir);
    // replicar el proyectil: los demás clientes lo ven volar y explotar
    G.net?.send({
      t: 'rocket',
      o: [muzzle.x, muzzle.y, muzzle.z],
      d: [baseDir.x, baseDir.y, baseDir.z],
    });
    if (G.spawnProt > 0) { G.spawnProt = 0; hud.hint(t('msg.protectionBroken'), 900); }
    effects.muzzleFlash(muzzle, true);
    audio.gun(w.cur);
    input.pad.rumble(110, 0.6, 1.0);
    G.rig.kick(def.recoil * 0.5);
    shoulderCam.addShake(def.recoil * TUNING.cam.shakeFire);
    shoulderCam.pitch = Math.min(TUNING.cam.pitchMax * Math.PI / 180,
      shoulderCam.pitch + def.recoil * 0.006);
    return;
  }

  const targets = currentTargets();
  const dmgByTarget = new Map();
  let anyPoint = null;
  const worldImpacts = [];

  for (let i = 0; i < def.pellets; i++) {
    let dir = def.pellets > 1
      ? applyPelletPattern(baseDir, spread, i, def.pellets)
      // El scope promete exactamente su punto. Fuera del scope (incluido
      // hip/blindfire del sniper) se conserva la dispersión configurada.
      : scoped ? baseDir.clone() : applySpread(baseDir, spread);
    const hit = aiming
      ? resolveGuidedShot(world, targets, cameraOrigin, origin, dir, def.range, null)
      : resolveShot(world, targets, origin, dir, def.range, null);
    anyPoint = hit.point;
    effects.tracer(muzzle, hit.point);
    if (hit.kind === 'world') {
      effects.impact(hit.point, hit.normal, hit.surface);
      audio.impact(hit.point, hit.surface);
      worldImpacts.push(hit.point);
    }
    if (hit.kind === 'player') {
      let dmg = def.dmg * damageFalloff(def, hit.t);
      if (hit.part === 'head') dmg *= def.headMult;
      const e = dmgByTarget.get(hit.id) || {
        dmg: 0, part: hit.part, dist: hit.t, point: hit.point, pellets: 0,
      };
      e.dmg += dmg;
      e.pellets++;
      if (hit.part === 'head') e.part = 'head';
      dmgByTarget.set(hit.id, e);
    }
  }

  // disparar rompe la protección de spawn
  if (G.spawnProt > 0) { G.spawnProt = 0; hud.hint(t('msg.protectionBroken'), 900); }

  // feedback de disparo (flash grande + rumble fuerte para armas pesadas)
  effects.muzzleFlash(muzzle, w.cur === 'shotgun' || !!def.special);
  audio.gun(w.cur);
  if (def.recoil >= 1.5) input.pad.rumble(90, 0.5, 0.9);
  else if (def.recoil >= 0.5) input.pad.rumble(55, 0.28, 0.5);
  else input.pad.rumble(45, 0.2, 0.4);
  G.rig.kick(def.recoil * 0.5);
  shoulderCam.addShake(def.recoil * TUNING.cam.shakeFire);
  shoulderCam.pitch = Math.min(TUNING.cam.pitchMax * Math.PI / 180,
    shoulderCam.pitch + def.recoil * 0.006);

  // aplicar daño
  let hitSomeone = false;
  const onlineClaims = [];
  for (const [id, e] of dmgByTarget) {
    if (e.dmg <= 0) continue;
    const gib = def.gibRange != null && e.dist <= def.gibRange;
    if (G.mode === 'practice') {
      hitSomeone = true;
      effects.blood(e.point, TEAM_HEX.blue);
      const killed = G.dummies.damage(id, e.dmg, (d) => {
        const sniperHeadshot = isSniperHeadshotDeath(w.cur, e.part);
        const impact = { x: d.x - G.player.pos.x, z: d.z - G.player.pos.z };
        d.rig.setDeathContext({
          impact,
          power: Math.min(1, e.dmg / 55),
          vel: { x: 0, z: 0 },
          state: 'run',
          weapon: w.cur,
          distance: e.dist,
          damage: e.dmg,
          part: e.part,
          point: e.point,
          sniperHeadshot,
          gib,
        });
        G.scores.red++;
        hud.score(G.scores.red, G.scores.blue);
        hud.kill(G.name, 'red', d.name, 'blue');
        audio.kill();
        if (sniperHeadshot) effects.sniperHeadshot(e.point, TEAM_HEX.blue, impact);
        else if (gib) effects.gib(new THREE.Vector3(d.x, 0, d.z), TEAM_HEX.blue);
      });
      if (!killed) audio.hit();
    } else if (G.mode === 'bots' && G.botMatch) {
      const killed = G.botMatch.damageBot(id, e.dmg, 'player', gib, false, {
        weapon: w.cur, distance: e.dist, damage: e.dmg, part: e.part,
        point: e.point, gib,
      });
      if (killed === null) continue; // protegido o inválido: sin feedback falso
      hitSomeone = true;
      if (!killed) audio.hit();
    } else if (G.net) {
      const r = G.remotes.get(id);
      const b = G.onlineBots?.botById(id);
      if ((!r && !b) || r?.inv || b?.protT > 0) continue; // snapshot protegido: el server rechazará daño
      hitSomeone = true;
      effects.blood(e.point, TEAM_HEX[r?.team || b.team]);
      onlineClaims.push({
        id, dmg: e.dmg, part: e.part, gib, point: e.point, pellets: e.pellets,
      });
      audio.hit();
    }
  }
  if (hitSomeone) hud.hitmarker();

  // replicar visual
  if (G.net && anyPoint) {
    // WebSocket conserva orden: registrar primero el disparo validable y luego
    // sus claims de daño. Antes los hits llegaban al server sin disparo asociado.
    G.net.fire(muzzle, anyPoint, w.cur, worldImpacts);
    for (const c of onlineClaims) {
      G.net.hit(c.id, c.dmg, c.part, c.gib, c.point, { pellets: c.pellets });
    }
  }
}

// ---------- retícula de cañón (shoot from the barrel) ----------
function updateReticle() {
  const p = G.player;
  const scoped = sniperScopeActive();
  const canShow = p && !p.dead && G.mode && !menuIsOpen() &&
    p.state !== 'roadie' && p.state !== 'dive' && p.state !== 'slide' &&
    p.state !== 'melee';
  if (!canShow) { hud.reticle(false, null); hud.sniperScope(false); return; }

  // shoulderCam.update cambia position/rotation antes de llegar aquí, pero
  // renderer.render actualiza matrices DESPUÉS. Proyectar sin esto usaba la
  // cámara del frame anterior, muy visible durante un giro rápido.
  camera.updateMatrixWorld();

  if (p.aim) {
    // ADS: la cámara define la intención, pero el anillo se coloca sobre el
    // primer punto que la trayectoria física DESDE EL MUZZLE puede alcanzar.
    // Así una caja/esquina entre arma y objetivo desplaza la retícula al
    // obstáculo en lugar de mantener una promesa falsa en el centro.
    const def = G.weapons.def;
    const ringPx = Math.tan(def.spreadAim * Math.PI / 180) /
      Math.tan(camera.fov * Math.PI / 360) * (innerHeight / 2);
    const ray = shoulderCam.aimRay();
    const guideT = staticHitDistance(ray.origin, ray.dir, 200);
    G.rig.root.updateWorldMatrix(true, true);
    const muzzle = G.rig.muzzleWorld(_v1);
    const hit = def.projectile
      // Los cohetes conservan la dirección paralela a cámara que usa fireShot.
      ? resolveShot(world, currentTargets(), muzzle, ray.dir, def.range, null)
      : resolveGuidedShot(world, currentTargets(), ray.origin, muzzle,
        ray.dir, def.range, null);
    _v3.copy(hit.point).project(camera);
    if (_v3.z > 1) { hud.reticle(false, null); hud.sniperScope(false); return; }
    const tx = (_v3.x * 0.5 + 0.5) * innerWidth;
    const ty = (-_v3.y * 0.5 + 0.5) * innerHeight;
    if (scoped) {
      hud.reticle(false, null);
      hud.sniperScope(true, { x: tx, y: ty }, {
        inRange: guideT <= def.range,
        blocked: Math.hypot(tx - innerWidth * 0.5, ty - innerHeight * 0.5) > 7,
      });
      return;
    }
    hud.sniperScope(false);
    hud.reticle(true, { x: tx, y: ty }, {
      r: Math.min(190, ringPx),
      inRange: guideT <= def.range,
    });
    return;
  }

  // Hip/blind: proyectar el MISMO rayo central que usa fireShot. Sin smoothing:
  // al girar rápido, una retícula atrasada también comunica un impacto falso.
  const dir = hipDir();
  hud.sniperScope(false);
  G.rig.root.updateWorldMatrix(true, true);
  const origin = G.rig.muzzleWorld(_v1);
  const t = staticHitDistance(origin, dir, 60);
  _v3.copy(origin).addScaledVector(dir, t).project(camera);
  if (_v3.z > 1) { hud.reticle(false, null); hud.sniperScope(false); return; }
  const tx = (_v3.x * 0.5 + 0.5) * innerWidth;
  const ty = (-_v3.y * 0.5 + 0.5) * innerHeight;
  hud.reticle(false, { x: tx, y: ty });
}

// ---------- loop principal ----------
let last = performance.now();

// handle de debug/testing
window.BREACH = G;
window.BREACH_INPUT = input;
window.BREACH_CAM = camera;
window.BREACH_AUDIO = audio;
window.BREACH_WORLD = world;
window.BREACH_EFFECTS = effects;
window.BREACH_SMOKE = smoke;
// Editor: API de diagnóstico disponible únicamente en el entorno de autoría.
if (editorLocalOnly) {
  Object.defineProperty(window, 'BREACH_EDITOR', { get: () => editor });
  window.BREACH_EDITOR_PLAYTEST = () => editorPlaytest();
  window.BREACH_MAPDATA = {
    mapLayoutId, isCustomLayout, getMap, listMaps, footprint,
    exportableMap, serializeMap, parseMapFile,
  };
}
window.BREACH_SPECIALS = specials;
window.BREACH_ROCKETS = rockets;
window.BREACH_RIG = Rig; // para tests visuales de poses/animaciones
window.THREE = THREE;

function simStep(dt) {
  const p = G.player;
  if (!p) return;

  // Una sola puerta de control gobierna intro, countdown, intermedio y cierre.
  // La simulación visual sigue viva, pero jugador, armas, pickups y bots no
  // pueden adelantarse al 3…2…1.
  if (matchControlsLocked()) {
    G.fireBuffer = 0;
    G.pendingShots = 0;
    G.pendingThrows = 0;
    p.update(dt, input, false);
    if (G.botMatch) G.botMatch.update(dt);
    if (G.net) { G.net.tickState(dt, p, G.weapons); G.net.tickBotState(dt, G.onlineBots?.bots); }
    input.consumeEdges();
    return;
  }

  if (G.spectator.active) {
    G.spectator.deathHold = Math.max(0, G.spectator.deathHold - dt);
    if (G.spectator.deathHold <= 0) {
      if (input.swapPressed) cycleSpectator(-1);
      if (input.reloadPressed || input.firePressed) cycleSpectator(1);
    }
    G.respawnT = Math.max(0, G.respawnT - dt);
    // El mundo continúa vivo mientras observamos, pero el cadáver local no
    // puede recargar, disparar, recoger objetos ni controlar al compañero.
    G.drops?.update(dt, p.pos.x, p.pos.z, p.y, false, () => {});
    G.crates?.update(dt, p.pos.x, p.pos.z, p.y, false, () => {});
    if (G.botMatch) G.botMatch.update(dt);
    if (G.net) { G.net.tickState(dt, p, G.weapons); G.net.tickBotState(dt, G.onlineBots?.bots); }
    input.consumeEdges();
    return;
  }

  // (el flip Matrix SÍ permite disparar en el aire)
  const stateOk = !p.dead && p.state !== 'dive' && p.state !== 'slide' &&
    p.state !== 'roadie' && p.state !== 'mantle' && p.state !== 'melee' && input.anyDevice;
  // Un giro grande se resuelve como rotación progresiva y buffer de disparo.
  // ADS y blindfire usan el mismo criterio: la cámara manda, pero el cañón
  // debe poder representarla visualmente antes de emitir el proyectil.
  const aligned = p.fireAligned();
  const wantsFire = input.fireHeld || input.firePressed || G.fireBuffer > 0;
  let canFire = stateOk && aligned &&
    coverPoseReady(input.aimHeld, wantsFire) && (!wantsFire || coverFireClear());
  // cualquier click que no pueda salir YA (roadie, cuerpo girando, cooldown,
  // dive/slide o recarga) queda bufereado — y el buffer dura AL MENOS
  // lo que falta de cooldown/recarga, para que el tiro encolado nunca se pierda
  const wst = G.weapons.st;
  const relRemain = G.weapons.reloading ? wst.reload : 0;
  if (input.firePressed && !p.dead &&
      (!canFire || wst.cd > 0 || relRemain > 0)) {
    G.fireBuffer = requiredFireBuffer(p, wst, relRemain);
  }
  G.fireBuffer = Math.max(0, G.fireBuffer - dt);
  const wasReloading = G.weapons.reloading;

  // Sin munición físicamente disponible, el gatillo no debe forzar pose de
  // tiro: evita que una recarga vacía deje al jugador expuesto sobre el cover.
  // Una recarga táctica sí puede interrumpirse porque conserva balas en el mag.
  const canInterruptReload = G.weapons.reloading &&
    (input.firePressed || G.fireBuffer > 0) && G.weapons.st.mag > 0;
  const hasAmmo = (!G.weapons.reloading || canInterruptReload) &&
    (G.weapons.st.mag > 0 || G.weapons.st.reserve > 0);
  // pickup del arma ESPECIAL: junto al pedestal, evadir se convierte en
  // "tomar" (se consume el edge para no rodar encima) y hay que MANTENERLO
  if (specials.active && G.selfAlive && !p.dead && p.grounded &&
      specials.near(p.pos.x, p.pos.z, p.y)) {
    const holding = input.keys.has(BINDS.kb.evade) || input.pad.pressed.has(BINDS.pad.evade);
    input.evadePressed = false;
    if (holding) {
      specials.holdT += dt;
      if (specials.holdT >= SPECIAL_HOLD_TIME) {
        if (G.net) {
          // ONLINE: el servidor decide. Se reclama y se espera 'specialTaken'
          // (dos jugadores a la vez → un solo ganador, sin duplicados).
          specials.holdT = 0;
          if (!G.specialClaimT || G.specialClaimT <= 0) {
            G.specialClaimT = 1.5;
            G.net.send({ t: 'takeSpecial' });
          }
        } else {
          const wep = specials.take();
          const removed = G.weapons.giveSpecial(wep);
          audio.reloadDone();
          hud.hint(t('msg.specialTaken', {
            weapon: t(TUNING.weapons[wep].nameKey),
            removed: t(TUNING.weapons[removed].nameKey),
          }), 2400);
          input.pad.rumble(80, 0.4, 0.6);
        }
      } else {
        hud.hint(t('msg.specialHold', {
          pct: Math.min(99, Math.round((specials.holdT / SPECIAL_HOLD_TIME) * 100)),
        }), 400);
      }
    } else {
      specials.holdT = 0;
      hud.hint(t('msg.specialNear', {
        weapon: t(TUNING.weapons[specials.active.wep].nameKey),
      }), 700);
    }
  } else if (specials.active) {
    specials.holdT = 0;
  }
  if (G.specialClaimT > 0) G.specialClaimT -= dt;

  // Un cambio de arma o el lanzamiento de una granada ya comprometidos no se
  // cancelan con B/V. Durante melee ocurre lo inverso: swap/evade quedan
  // bloqueados por el estado hasta terminar su recovery.
  if (input.meleePressed && (G.weapons.swapping || G.throwT > 0)) {
    input.meleePressed = false;
  }

  // la intención de disparo SIEMPRE llega al controller: cancela el roadie
  // (en tierra o en el aire) y gira el cuerpo para disparar
  p.update(dt, input, (input.fireHeld || G.fireBuffer > 0) && !p.dead && hasAmmo);

  // colisión de cuerpos del jugador: suave y sin atrapamiento (mitad del
  // solape por paso, con tope). Cover y mantle gestionan su propia posición:
  // empujar ahí rompería el snap contra la pared.
  if (!p.dead && p.state !== 'cover' && p.state !== 'mantle') {
    const bodyR = 0.72, maxBodyPush = 3 * dt;
    for (const o of characterBodies()) {
      if (Math.abs(o.y - p.y) > 1.4) continue;
      const dx = p.pos.x - o.x, dz = p.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d >= bodyR || d < 0.001) continue;
      const push = Math.min((bodyR - d) * 0.5, maxBodyPush);
      p.pos.x += (dx / d) * push;
      p.pos.z += (dz / d) * push;
      world.resolveCircle(p.pos, PLAYER_R, p.y);
    }
  }
  // El controller puede haber recuperado control o terminado de alinearse en
  // este mismo paso. Revalidar evita añadir un frame artificial de latencia.
  const stateOkAfter = !p.dead && p.state !== 'dive' && p.state !== 'slide' &&
    p.state !== 'roadie' && p.state !== 'mantle' && p.state !== 'melee' && input.anyDevice;
  canFire = stateOkAfter && p.fireAligned() &&
    coverPoseReady(p.aim, wantsFire) && (!wantsFire || coverFireClear());
  const fired = p.dead ? false
    : G.weapons.update(dt, input.fireHeld, input.firePressed || G.fireBuffer > 0, canFire);
  // Tras la primera inserción desde 0, conservar margen para que cover/arma
  // alcancen una pose válida antes de consumir el click que estaba esperando.
  if (G.weapons.reloadInserted > 0 && G.fireBuffer > 0) G.fireBuffer = Math.max(G.fireBuffer, 0.3);
  if (fired) G.fireBuffer = 0;
  // Resolver después de actualizar el rig: con origen físico en el muzzle, un
  // tiro emitido antes de aplicar la pose del frame nacía en la postura vieja.
  // La granada no es hitscan: va por su propio canal de lanzamiento.
  if (fired) {
    // el bote NO sale en el frame del click: arranca el gesto y se suelta en
    // el latigazo (throwRelease), como cualquier lanzamiento real
    if (G.weapons.def.thrown) {
      G.throwT = TUNING.weapons.grenade.throwTime;
      G.throwPending = true;
    } else G.pendingShots++;
  }
  if (G.throwT > 0) {
    G.throwT = Math.max(0, G.throwT - dt);
    const released = TUNING.weapons.grenade.throwTime - TUNING.weapons.grenade.throwRelease;
    if (G.throwPending && G.throwT <= released) {
      G.throwPending = false;
      G.pendingThrows++;
    }
  }

  // Recarga normal: pulsar otra vez mientras ya está en curso no modifica la
  // duración, no completa el cargador y no aplica bonus/penalizaciones.
  if (input.reloadPressed && p.state !== 'melee' && !G.weapons.reloading) {
    G.weapons.startReload();
  }
  if (!wasReloading && G.weapons.reloading) audio.reload(); // incluye auto-recarga
  // Una recarga interrumpida abandona el gesto sin reproducir el sonido que
  // comunica cargador completo.
  if (G.weapons.reloadInserted > 0) audio.reloadDone();
  else if (wasReloading && !G.weapons.reloading && !G.weapons.reloadInterrupted) audio.reloadDone();

  // práctica = munición de reserva infinita (nunca te quedas sin disparar)
  if (G.mode === 'practice') {
    for (const k of G.weapons.slots) {
      const d = TUNING.weapons[k];
      if (d.thrown) { if (G.weapons.state[k].mag <= 0) G.weapons.state[k].mag = d.mag; }
      else if (!d.special) G.weapons.state[k].reserve = d.reserve;
    }
  }
  // selección de arma: Q y la rueda CICLAN; 1-4 y el d-pad seleccionan
  // directo por slot. Un cambio ya en curso ignora inputs nuevos (sin
  // dobles cambios ni exploits de animación); durante el melee el arma
  // está ocupada en el golpe.
  if (!p.dead && p.state !== 'melee' && G.throwT <= 0) {
    let swapped = false;
    if (input.slotPressed >= 0) {
      const target = G.weapons.slots[input.slotPressed];
      swapped = !!target && G.weapons.startSwap(target);
    } else if (input.cycleDir !== 0) {
      swapped = G.weapons.startSwap(G.weapons.cycleTarget(Math.sign(input.cycleDir)));
    } else if (input.swapPressed) {
      swapped = G.weapons.startSwap();
    }
    if (swapped) audio.reload();
  }

  // melee: whoosh al armar el golpe y UNA sola ventana de impacto por gesto
  if (p.state === 'melee') {
    if (!G.meleeSwung) {
      G.meleeSwung = true;
      audio.whoosh();
      input.pad.rumble(40, 0.3, 0.2);
    }
    if (!G.meleeHitDone && p.meleeT >= TUNING.melee.hitAt) {
      G.meleeHitDone = true;
      const result = resolveMelee();
      p.confirmMelee(result.connected, result.killed);
    }
  } else {
    G.meleeSwung = false;
    G.meleeHitDone = false;
  }

  // pasos: por distancia recorrida; el tipo según estado y velocidad
  if ((p.state === 'run' || p.state === 'roadie') && p.speed > 1 && p.grounded) {
    G.footAcc += p.speed * dt;
    const roadie = p.state === 'roadie';
    if (G.footAcc > (roadie ? 2.1 : 1.7)) {
      G.footAcc = 0;
      audio.footstep(roadie ? 'roadie' : (p.speed < 3 ? 'walk' : 'run'));
    }
  } else if (p.state === 'cover' && p.speed > 1) {
    // paso lateral pegado al muro: shuffle corto
    G.footAcc += p.speed * dt;
    if (G.footAcc > 0.95) { G.footAcc = 0; audio.footstep('shuffle'); }
  }

  if (G.dummies) G.dummies.update(dt);

  // protección de spawn + countdown de respawn + cajas de munición
  G.spawnProt = Math.max(0, G.spawnProt - dt);
  G.respawnT = Math.max(0, G.respawnT - dt);

  // armas caídas: recoger = quedarse con sus balas restantes
  if (G.drops) {
    G.drops.update(dt, p.pos.x, p.pos.z, p.y, G.selfAlive && !p.dead, (id, d) => {
      const def = TUNING.weapons[d.wep];
      const s = G.weapons.state[d.wep];
      if (!s) {
        if (def.special) {
          if (G.mode === 'online') {
            d.claimed = true;
            d.claimT = 2;
            G.net?.send({ t: 'takeDrop', id });
          } else {
            G.weapons.giveSpecial(d.wep);
            const specialState = G.weapons.state[d.wep];
            specialState.mag = Math.min(def.mag, Math.max(0, d.mag || 0));
            specialState.reserve = Math.min(def.reserve, Math.max(0, d.res || 0));
            G.rig?.setWeapon?.(d.wep);
            G.drops.remove(id);
            audio.reloadDone();
            hud.hint(t('msg.weaponRecovered', { weapon: t(def.nameKey) }), 1500);
          }
          return;
        }
        // no llevas esa arma: si es una primaria normal del suelo y tu slot
        // primario carga una ESPECIAL ya vacía, la recuperas en su lugar
        if (def.thrown) return;
        for (const idx of [0, 1]) {
          const curW = G.weapons.slots[idx];
          const curDef = TUNING.weapons[curW];
          const curSt = G.weapons.state[curW];
          if (curDef.special && curSt.mag <= 0 && curSt.reserve <= 0) {
            G.weapons.replaceSlot(idx, d.wep,
              Math.min(d.mag, def.mag), Math.min(d.res, def.reserve));
            G.drops.remove(id);
            audio.reloadDone();
            hud.hint(t('msg.weaponRecovered', { weapon: t(def.nameKey) }), 1600);
            input.pad.rumble(50, 0.15, 0.25);
            return;
          }
        }
        return;
      }
      if (s.reserve >= def.reserve) return; // reserva llena: no desperdiciarla
      if (G.mode === 'online') {
        d.claimed = true;
        d.claimT = 2; // si el server no confirma, vuelve a ser reclamable
        G.net?.send({ t: 'takeDrop', id });
        return;
      }
      // anunciar lo GANADO real (el clamp de reserva podía comerse la mayoría)
      const gained = Math.min(def.reserve, s.reserve + d.mag + d.res) - s.reserve;
      s.reserve += gained;
      G.drops.remove(id);
      audio.reloadDone();
      hud.hint(t('msg.bulletsOf', { count: gained, weapon: t(def.nameKey) }), 1500);
      input.pad.rumble(50, 0.15, 0.25);
    });
  }
  if (G.crates) {
    G.crates.update(dt, p.pos.x, p.pos.z, p.y, G.selfAlive && !p.dead, (i) => {
      if (G.net) {
        // online: solo reclamar; el refill llega con la confirmación del
        // server (rellenar aquí + reintento de 1.5s = munición infinita)
        G.net.send({ t: 'crate', i });
        return;
      }
      G.weapons.refill();
      audio.reloadDone();
      hud.hint(t('msg.ammoFull'), 1400);
      input.pad.rumble(60, 0.2, 0.3);
    });
  }

  if (G.botMatch) {
    G.botMatch.update(dt);
    // arma especial del mapa: UNA por ronda, alternando (impar=sniper,
    // par=bazooka); aparece cuando el despliegue libera los controles
    if (G.mode === 'bots' && G.botMatch.round !== G.specialRound &&
        !G.botMatch.controlsLocked()) {
      G.specialRound = G.botMatch.round;
      spawnSpecialForRound();
    }
    // regen del jugador (igual que online, pero local)
    if (G.mode === 'bots') {
      G.playerLastHit += dt;
      if (G.selfAlive && G.playerLastHit > TUNING.combat.regenDelay && G.selfHp < TUNING.combat.hp) {
        G.selfHp = Math.min(TUNING.combat.hp, G.selfHp + TUNING.combat.regenRate * dt);
      }
    }
  }
  if (G.net) { G.net.tickState(dt, p, G.weapons); G.net.tickBotState(dt, G.onlineBots?.bots); }

  input.consumeEdges();
}

let padWasConnected = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // MODO EDITOR: cámara y overlays propios; el gameplay no corre
  if (G.mode === 'editor') {
    editor.update(dt);
    effects.update(dt);
    renderer.render(scene, camera);
    input.endFrame();
    return;
  }

  const menuOpen = menuIsOpen();
  if (!G.mode) updateMenuBackdrop(now);
  const flowLocked = matchControlsLocked();
  // al desbloquear el despliegue arranca la protección REAL: la otorgada al
  // spawnear se quemaba entera durante el intro (bots y online por igual)
  if (G.flowLockedPrev && !flowLocked && (G.mode === 'online' || G.mode === 'bots')) {
    grantSpawnProtection();
  }
  G.flowLockedPrev = flowLocked;
  input.suppress = menuOpen || flowLocked; // presentación y menú bloquean el gameplay
  input.pollPad(dt, !!G.mode && !menuOpen && !flowLocked);
  menuNavigator.poll(input.pad, dt, input.rebinding);

  // cursor virtual: menú abierto con pointer lock activo
  const vcOn = menuOpen && input.locked;
  vcursorEl.classList.toggle('on', vcOn);
  if (vcOn) {
    vc.x = Math.min(innerWidth - 2, Math.max(0, vc.x + input.mouseDX));
    vc.y = Math.min(innerHeight - 2, Math.max(0, vc.y + input.mouseDY));
    vcursorEl.style.left = vc.x + 'px';
    vcursorEl.style.top = vc.y + 'px';
    if (vDrag) vDragUpdate();
    const el = document.elementFromPoint(vc.x, vc.y);
    const target = el?.closest?.('.btn, .bind-btn, .char-slot, #btn-resume') ?? null;
    if (vHover !== target) {
      vHover?.classList.remove('vhover');
      target?.classList.add('vhover');
      vHover = target;
    }
  } else if (vHover) {
    vHover.classList.remove('vhover');
    vHover = null;
  }
  if (input.pad.connected !== padWasConnected) {
    padWasConnected = input.pad.connected;
    hud.hint(t(padWasConnected ? 'msg.controllerConnected' : 'msg.controllerDisconnected'), 1600);
    if (!padWasConnected) {
      padStatus.textContent = t('menu.noController');
      padStatus.classList.remove('on');
    }
  }
  // diagnóstico en vivo con el panel de controles abierto: id, mapping,
  // ejes y botones presionados (para depurar pads raros/fantasma)
  if (input.pad.connected && input.pad.info && controlsCard.style.display === 'block') {
    const i = input.pad.info;
    padStatus.textContent =
      i.id + ' · ' + i.mapping +
      ` · ${t('menu.axes')} [` + [...i.axes].slice(0, 4).map((a) => a.toFixed(1)).join(', ') + ']' +
      ` · ${t('menu.buttons')} [` + (i.pressed.join(',') || '—') + ']';
    padStatus.classList.add('on');
  }
  if (menuOpen) input.consumeEdges();

  if (G.mode && G.player) {
    // El input de cámara de este frame usa el estado scoped ya válido del
    // frame anterior; tras simStep se recalcula para cámara/HUD sin latencia.
    shoulderCam.setScoped(sniperScopeActive());
    if (!menuOpen) {
      const spectatorLocked = G.spectator.active;
      if (!spectatorLocked && (input.locked || input.lockDisabled)) shoulderCam.applyMouse(input.mouseDX, input.mouseDY, input.invertY);
      if (!spectatorLocked && input.pad.connected) shoulderCam.applyStick(input.pad.camX, input.pad.camY, dt, input.invertYPad);
      // keeper: jugando sin lock (cooldown de Esc, despausa con gamepad,
      // lock post-await) → reintentar captura periódicamente
      // lockSuspended (F10): sin él, el keeper robaba el mouse al panel de
      // tuning y cada click al canvas disparaba el arma
      if (!input.locked && document.hasFocus() && !sanitizing && !lockSuspended &&
          now - lastKeep > 1600) {
        lastKeep = now;
        input.requestLock();
      }
    }

    // pausa real en práctica y vs bots; online la partida sigue.
    // Simulación por frame con dt variable: a ≥30 fps es EXACTAMENTE un paso
    // por frame dibujado (el fix del judder). Bajo 30 fps se recupera el
    // tiempo real con hasta 4 pasos de ≤1/30 — antes el juego entraba en
    // cámara lenta en máquinas que no sostenían 30 fps.
    const paused = menuOpen && (G.mode === 'practice' || G.mode === 'bots');
    if (!paused) {
      let acc = dt, steps = 0;
      while (acc > 1e-6 && steps < 4) {
        const st = Math.min(acc, 1 / 30);
        simStep(st);
        acc -= st; steps++;
      }
    }

    const flowView = activePresentation(Date.now() / 1000);
    updatePresentationAudio(flowView);
    hud.presentation(flowView);
    const scopeNow = sniperScopeActive();
    G.scopeActive = scopeNow; // diagnóstico/tests; sigue siendo estado derivado
    shoulderCam.setScoped(scopeNow);
    // El sniper usa 20° solo durante un scope realmente válido. Al iniciar
    // swap/melee vuelve de inmediato al ADS estándar aunque LT siga pulsado.
    shoulderCam.setAimFov(scopeNow ? G.weapons.def.fovAim : TUNING.cam.fovAim);
    if (flowView && flowView.phase !== 'countdown') updateMatchCamera(now, flowView);
    else if (G.spectator.active) updateSpectatorCamera(dt, now);
    else shoulderCam.update(dt, G.player);
    G.rig.setWeapon(G.weapons.cur, backWeapon()); // el intercambio real ocurre a mitad del gesto
    // protección de spawn: highlight sutil en el color del equipo
    G.rig.root.visible = true;
    G.rig.setProtected(G.spawnProt > 0);
    G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
    G.rig.update(dt, {
      ...G.player.animParams(),
      swapping: G.weapons.swapping,
      throwT: G.throwT,
      throwTotal: TUNING.weapons.grenade.throwTime,
      throwReleased: G.throwT > 0 && !G.throwPending,
      reloading: G.weapons.reloading,
      reloadT: G.weapons.reloading ? 1 - G.weapons.st.reload / G.weapons.def.reloadTime : 0,
    });
    while (G.pendingShots > 0) {
      fireShot();
      G.pendingShots--;
    }
    while (G.pendingThrows > 0) {
      throwSmoke();
      G.pendingThrows--;
    }
    for (const r of G.remotes.values()) {
      r.update(dt);
      // pasos de remotos: por distancia recorrida real, posicionales
      const mdx = r.x - (r._sx ?? r.x), mdz = r.z - (r._sz ?? r.z);
      r._sx = r.x; r._sz = r.z;
      const airborne = r.st === 'jump' || r.st === 'flip' || (r.y ?? 0) > 0.08;
      if (r.alive && !airborne && (r.st === 'run' || r.st === 'roadie')) {
        r._facc = (r._facc ?? 0) + Math.hypot(mdx, mdz);
        const roadie = r.st === 'roadie';
        if (r._facc > (roadie ? 2.1 : 1.7)) {
          r._facc = 0;
          stepSound(r.x, r.z, roadie ? 'roadie' : 'run', r.y ?? 0);
        }
      } else {
        r._facc = 0;
      }
      if (r._wasAir && !airborne && r.alive) stepSound(r.x, r.z, 'land', r.y ?? 0);
      r._wasAir = airborne;
    }

    hud.ammo(G.weapons);
    hud.health(G.spectator.active ? 1
      : (G.mode === 'online' || G.mode === 'bots' ? G.selfHp / TUNING.combat.hp : 1));
    // countdown grande de reaparición (no en fin de ronda/partida: ahí la
    // cola de respawns se vació y el contador mentía, pisando "ROUND PARA…")
    const bmPhase = G.botMatch?.phase;
    if (!G.spectator.active && !G.selfAlive && G.respawnT > 0 && bmPhase !== 'over' && bmPhase !== 'intermission') {
      hud.respawnTick(Math.ceil(G.respawnT));
    } else {
      hud.respawnTick(null);
    }
    hud.spectator(!flowView ? spectatorView() : null);
    if (G.mode === 'bots' && G.botMatch) {
      hud.score(G.botMatch.livesOf('red'), G.botMatch.livesOf('blue'), 'hud.lives');
      hud.timer(G.botMatch.timer);
      hud.roundPips(G.botMatch.wins.red, G.botMatch.wins.blue);
      hud.scoreboard(!flowView && input.scoreHeld && !menuOpen ? G.botMatch.statRows() : null);
    } else if (G.mode === 'online') {
      hud.scoreboard(!flowView && input.scoreHeld && !menuOpen ? G.onlineRows : null, G.net?.id);
    }
    if (flowView) { hud.reticle(false, null); hud.sniperScope(false); }
    else updateReticle();
  } else {
    G.scopeActive = false;
    shoulderCam.setScoped(false);
    hud.sniperScope(false);
  }

  effects.update(dt);
  smoke.update(dt);
  specials.update(dt);
  // la espoleta necesita el bando de cada cuerpo: un cohete de bot no debe
  // detonar al rozar a un compañero
  rockets.update(dt, G.mode ? allCharacterTargets() : [], explodeRocket);
  renderer.render(scene, camera);
  input.endFrame();
}
requestAnimationFrame(frame);
