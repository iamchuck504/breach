// BREACH — vertical slice. Orquesta mundo, jugador, combate, red y UI.
import * as THREE from 'three';
import GUI from 'lil-gui';
import {initMenuPresentation,updateMapPreview} from './ui/presentation.js';
import { TUNING, TUNING_DEFAULTS } from './config/tuning.js';
import { BINDS, KB_LABELS, PAD_LABELS, keyLabel, padBtnName, loadBinds, saveBinds, resetBinds, assignBind } from './core/bindings.js';
import { LANGUAGES, t, getLanguage, setLanguage, applyTranslations, onLanguageChange } from './core/i18n.js';
import { Input } from './core/input.js';
import { SETTINGS, motionScale, setSetting, bindTuning, lookSensitivity, onSettingChange } from './core/settings.js';
import { aimFriction } from './core/gamepad.js';
import { ShoulderCamera, FirstPersonCamera } from './core/camera.js';
import { FirstPerson } from './view/first-person.js'; // viewmodel del prototipo (hasta src/view/fp de VISTA)
import { World } from './world/world.js';
import { preloadUrbanAssets, ensureMapAssets, ensurePlayableMapAssets, playableMapAssetsReady, mapAssetsReady, prefetchOtherMapAssets, onUrbanAssetArrived, urbanAssetState } from './world/urban-assets.js';
import { Rig, RAGDOLL_R } from './player/rig.js';
import { syncLocalSoldierView } from './player/soldier-bake.js';
import { Controller, PLAYER_R } from './player/controller.js';
import { RemotePlayer } from './player/remote.js';
import { Dummies } from './player/practice.js';
import { Weapons, spreadFor } from './combat/weapons.js';
import { resolveShot, applySpread, applyPelletPattern } from './combat/ballistics.js';
import { hitFields, hitAimHeights, placeHitPose, rocketAimDir, STAND, CROUCH, setHitModel } from './combat/hit-pose.js';
import { damageFalloff } from './combat/damage.js';
import { adsSetback, planeBaseAlong, shooterPlaneDistance } from './combat/shooter-plane.js';
import {evaluateBlast} from './combat/blast.js';
import {CombatPrototypes} from './combat/prototypes.js';
import {PrototypeView} from './combat/prototype-view.js';
import {BlastDebug} from './combat/blast-debug.js';
import {
  deathImpactPoint, isSniperHeadshotDeath, rocketDeathLevel,
} from './combat/death-reactions.js';
import { requiredFireBuffer } from './combat/fire-control.js';
import { canFireInState, sprintFireDelay } from './combat/fire-gates.js';
import { meleeTargetPoint, meleeHitOk } from './combat/melee-reach.js';
import { kickWorldContact } from './combat/kick-surface.js';
import { Effects } from './fx/effects.js';
import { Audio, selectAudioListener } from './fx/audio.js';
import { HUD } from './ui/hud.js';
import { ImagePipeline, QUALITY } from './render/pipeline.js';
import { AutoQuality, initialQuality } from './render/auto-quality.js';
import { SkyEnvironment } from './render/sky.js';
import { NetClient, localPose, noteLocalPose, resetTransition } from './net/client.js';
import { BotMatch, INTRO_TIME as BOT_INTRO_TIME } from './game/botmatch.js';
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
import { PowerRespawn } from './game/power-respawn.js';
const localPowerRespawn = new PowerRespawn();
let localPowerTime = 0;
import { takeDropAmmo, replacementSlot, canReplaceDrop } from './game/drop-policy.js';
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
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Cadena de imagen (bloom, curva de tono, gradación) y nivel de calidad.
// ?gfx=off|low|medium|high|ultra lo fuerza sin tocar lo guardado (pruebas).
const pipeline = new ImagePipeline(renderer);
const gfxParam = new URLSearchParams(location.search).get('gfx');
const savedQuality = localStorage.getItem('breach.video.quality');
// CALIDAD AUTOMÁTICA (por defecto mientras el jugador no elija un nivel): el
// arranque sale del equipo y, jugando, baja sola si los cuadros no aguantan.
// En navegadores automatizados (las suites, que corren en runners lentos y
// prueban la cadena aparte con ?gfx) queda el render clásico, sin medidor.
function gpuName() {
  try {
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return ''; }
}
const autoGfx = new AutoQuality({
  start: initialQuality({ gpu: gpuName(), cores: navigator.hardwareConcurrency || 0,
    memoryGb: navigator.deviceMemory || 0, coarse: coarseDisplay }),
  storage: localStorage,
});
let gfxAuto = gfxParam === 'auto' || (!QUALITY[gfxParam] && !QUALITY[savedQuality] && !navigator.webdriver);
let gfxQuality = QUALITY[gfxParam] ? gfxParam
  : gfxAuto ? autoGfx.quality
    : QUALITY[savedQuality] ? savedQuality
      : 'off';
pipeline.setQuality(gfxQuality);
window.BREACH_GFX = () => ({ auto: gfxAuto, quality: gfxQuality, scale: gfxAuto ? autoGfx.scale : 1, gpu: gpuName(), fps: autoGfx.lastFps, controller: autoGfx });
// varios render() por cuadro: las estadísticas se reinician a mano
renderer.info.autoReset = false;
function applyRenderSize() {
  renderer.setPixelRatio(pipeline.pixelRatio(BASE_PIXEL_RATIO * renderScale * (gfxAuto ? autoGfx.scale : 1), innerWidth, innerHeight));
  renderer.setSize(innerWidth, innerHeight);
}
let frameIndex = 0;
function renderFrame() {
  renderer.info.reset();
  sky.update(world, camera, pipeline.active);
  // mapa de sombras: en los niveles bajos se redibuja cuadro por medio
  const every = pipeline.active ? pipeline.quality.shadowEvery : 1;
  renderer.shadowMap.autoUpdate = every <= 1;
  if (every > 1 && frameIndex++ % every === 0) renderer.shadowMap.needsUpdate = true;
  pipeline.sun = world.sun;
  pipeline.render(scene, camera, world.theme ?? world.layout, world.look.grade);
}
// El filtro de sombras va compilado dentro de cada material: al cambiarlo
// hay que recompilarlos.
function applyShadowFilter() {
  const type = pipeline.active && pipeline.quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (renderer.shadowMap.type === type) return;
  renderer.shadowMap.type = type;
  renderer.shadowMap.needsUpdate = true;
  scene?.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) m.needsUpdate = true;
  });
}
window.BREACH_PIPELINE = pipeline;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = pipeline.active && pipeline.quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.cam.fovNormal, 1, 0.1, 200);
// Antes de una partida, Azotea funciona como backdrop 3D deliberado del menú.
// Al jugar, setLayout reutiliza este mismo World con el mapa elegido.
const sky = new SkyEnvironment(renderer, scene);
const world = new World(scene, 'azoteas');
world.look.setQuality(gfxQuality);
// al cargar un mapa se compilan sombreadores: el medidor de cuadros espera
{ const setLayout = world.setLayout.bind(world); world.setLayout = (...a) => { autoGfx.settle(); return setLayout(...a); }; }
const effects = new Effects(scene, world);
effects.setQuality(gfxQuality);
const audio = new Audio();
const smoke = new SmokeSystem(scene, world, audio);
const specials = new SpecialPickup(scene);
const rockets = new Rockets(scene, world, audio);
effects.trackRockets(rockets);
audio.setAmbience('azoteas');
const hud = new HUD();
initMenuPresentation();
const input = new Input(canvas);
const shoulderCam = new ShoulderCamera(camera, world);
// La cámara con la que se juega. Comparte la mirada (yaw/pitch/retroceso)
// con la de hombro, que queda para muerte, espectador y presentación.
const fpCam = new FirstPersonCamera(camera, world, shoulderCam);
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
  ensureMapAssets('azoteas'); // si un modelo del fondo falló, se reintenta y se repara al llegar
  audio.setAmbience('azoteas');
  updateMenuBackdrop();
}

function resize() {
  applyRenderSize();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- estado de juego ----------
const G = {
  scopeActive: false,    // estado derivado expuesto para HUD/diagnósticos
  simClock: 0,         // reloj de SIMULACIÓN (s): mezcla de postura (cámara, red, blancos) y muestras de tiro
  pendingThrowShots: [], // muestra de cada suelta (evento throwRelease)
  fireBuffer: 0,       // click de disparo pendiente mientras el cuerpo gira
  pendingShots: 0,     // tiros aprobados que esperan la pose/muzzle de este frame
  pendingRays: [],     // promesa de la cruz capturada al aprobar cada tiro
  pendingThrows: 0,    // granadas aprobadas que esperan la pose de este frame
  aimOver: { lift: 0 },  // ADS: alzada del arma para librar bordes cercanos
  throwT: 0,           // gesto de lanzamiento en curso
  throwPending: false, // el bote aún no ha salido de la mano
  editorReturn: null,  // id del mapa en edición durante un playtest
  specialRound: 0,     // ronda cuyo arma especial ya fue colocada
  specialClaimT: 0,    // anti-spam del reclamo online del pedestal
  rocketSeq: 0,        // correlación entre predicción local y cohete autoritativo
  smokeSeq: 0,         // correlación entre bote predicho y humo autoritativo
  mode: null,          // null | 'practice' | 'online'
  rig: null,           // rig local
  player: null,        // controller local
  weapons: new Weapons(),
  dummies: null,
  botMatch: null,
  crates: null,
  drops: null,         // armas caídas de los muertos
  dropSeq: 0,
  spawnProt: 0,        // protección de spawn (5s completos, incluso al atacar)
  respawnT: 0,         // countdown visible de reaparición
  selfRespawnPending: false, // únicamente el server decide si queda una vida
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
  name: 'PLAYER',
  charVariant: (() => {
    const v = parseInt(localStorage.getItem('breach.character'), 10);
    return v >= 0 && v <= 4 ? v : 0;
  })(),
  footAcc: 0,
  presentationAudioKey: '',
};
// Arma en primera persona: por ahora el viewmodel del prototipo (sin su
// tecla de cambio ni su cámara: la primera persona es la única vista al
// jugar). Se sustituye por src/view/fp/viewmodel.js cuando VISTA lo entregue.
const firstPerson = new FirstPerson({
  scene, camera, world, G,
  hint: () => {},
  canToggle: () => false,
});
firstPerson._told = true;
window.BREACH_FP = fpCam; // capturas y diagnóstico: la cámara de los ojos
window.BREACH_VM = firstPerson;

// Sonidos de manejo del arma: por los EVENTOS del arma (una vez por suceso,
// aunque se salten cuadros), no deduciéndolos del estado cuadro a cuadro.
// (AUDIO: el módulo se engancha al emisor y suena cada reloadStep, cambio,
// gatillo en seco y lanzamiento UNA vez, en el instante de la lógica)
audio.attachWeapons(G.weapons);
G.weapons.on('meleeHit', ({ connected, world: surface }) => {
  if (connected || surface) fpCam.meleeImpact(connected ? 0.5 : 0.22);
});
// Eventos de acción para los observadores, una sola vez (RED §7: viajan en `s.ev`)
for (const ev of ['swapStart', 'swapEnd', 'reloadStart', 'reloadEnd', 'reloadCancel', 'throwStart', 'throwRelease', 'throwCancel']) {
  G.weapons.on(ev, (d = {}) => G.net?.noteEvent?.(ev, d.weapon ?? d.to ?? G.weapons.cur));
}
// ajustes de mezcla propios (claves de settings.js; ausentes = por defecto)
function applyAudioSettings() {
  audio.setOwnWeaponVolume?.(SETTINGS.ownWeaponVolume ?? 1);
  audio.setHitSounds?.(SETTINGS.hitSounds ?? true);
}
applyAudioSettings();
onSettingChange((k) => { if (k === 'ownWeaponVolume' || k === 'hitSounds') applyAudioSettings(); });
// el bote sale en la suelta que publica el arma, no con un segundo reloj
// gesto cortado antes de soltar (aturdido, muerte, cambio forzado): no hay
// bote, ni suelta, ni coste; el gesto local se apaga
G.weapons.on('throwCancel', () => { G.throwPending = false; G.throwT = 0; });
G.weapons.on('throwRelease', ({ weapon, id } = {}) => {
  if (!G.throwPending || !G.player || G.player.dead) return;
  G.throwPending = false;
  // registro del instante de la suelta (pose, ojo, mira, arrojadizo) y el
  // bote sale en este mismo subpaso
  const shot = captureShot();
  if (weapon) shot.weapon = weapon;
  shot.throwId = id; // id de la suelta (weapons): viaja en el cid del lanzamiento
  throwSmoke(shot);
});

// Ajustes de cámara (src/core/settings.js, vivos: el menú los cambia).
function fpSettings() { return SETTINGS; }
// Sensibilidad de mira de este cuadro (°/px y °/s), con ADS y mira.
function fpSens(scoped) {
  const aim = !!G.player?.aim;
  const m = lookSensitivity('mouse', { aim, scoped }), pad = lookSensitivity('pad', { aim, scoped });
  return { mouse: m.x, padX: pad.x, padY: pad.y };
}
// ¿Juega en primera persona este cuadro? Vivo, en una partida y con su
// propia cámara (ni presentación ni espectador: esas siguen en hombro).
function playingMode() { return G.mode === 'practice' || G.mode === 'bots' || G.mode === 'online'; }
// Rayo de la mira: el de los ojos al jugar; el de hombro fuera de ella.
function viewRay() { return fpCam.live ? fpCam.aimRay() : shoulderCam.aimRay(); }
// Asistencia de mando: SOLO fricción (gamepad.js aimFriction, pura). Los
// blancos son la cabeza y el torso de los enemigos vivos; se descartan los
// tapados por el mapa o el humo y los protegidos. Con ratón reciente,
// protección de aparición propia o el ajuste apagado devuelve 1.
const _afEye = [0, 0, 0], _afDir = [0, 0, 0];
// Protección de aparición de un blanco, la que respeta el daño en cada modo
// (los blancos de botmatch no la llevan en el objeto: se mira el bot).
function targetProtected(tg) {
  if (tg.protected) return true;
  if (G.mode === 'bots') return (G.botMatch?.bots.find((b) => b.id === tg.id)?.protT ?? 0) > 0;
  if (G.mode === 'online') return !!G.remotes.get(tg.id)?.inv || (G.onlineBots?.botById(tg.id)?.protT ?? 0) > 0;
  return false;
}
function padAimFriction() {
  const p = G.player;
  if (!p || p.dead || input.lastDevice !== 'pad' || !SETTINGS.aimAssist) return 1;
  if (Math.hypot(input.pad.camX, input.pad.camY) < 0.05) return 1; // stick quieto: nada
  const ray = fpCam.aimRay();
  _afEye[0] = ray.origin.x; _afEye[1] = ray.origin.y; _afEye[2] = ray.origin.z;
  _afDir[0] = ray.dir.x; _afDir[1] = ray.dir.y; _afDir[2] = ray.dir.z;
  const targets = [];
  for (const tg of currentTargets()) {
    if (tg.alive === false) continue;
    // el mismo volumen que usa la balística (resolveShot): `hit` si la pose
    // difiere, si no el de siempre (los dummies de práctica: de pie/agachado)
    const v = tg.hit ?? placeHitPose(tg.hitVol ?? (tg.crouch ? CROUCH : STAND), tg.x, tg.y ?? 0, tg.z, 0);
    for (const [x, y, z, r] of [[v.hx, v.hy, v.hz, v.hr], [(v.ax + v.bx) / 2, (v.ay + v.by) / 2, (v.az + v.bz) / 2, v.br]]) {
      _v3.set(x - ray.origin.x, y - ray.origin.y, z - ray.origin.z);
      const len = _v3.length();
      const blocked = len > 0.3 && world.raycast(ray.origin, _v3.multiplyScalar(1 / len), len - 0.2, 0) !== null;
      const smoked = !!smoke.blocksSegment?.(ray.origin.x, ray.origin.y, ray.origin.z, x, y, z);
      targets.push({ pos: [x, y, z], radius: r, blocked, smoke: smoked, protected: targetProtected(tg) });
    }
  }
  return aimFriction({ device: input.lastDevice, stick: [input.pad.camX, input.pad.camY], targets,
    eye: _afEye, dir: _afDir, aim: !!p.aim, scoped: G.scopeActive, blocked: G.spawnProt > 0,
    mouseRecent: input.mouseRecent(1000), enabled: SETTINGS.aimAssist, range: G.weapons.def.range });
}
// Boca del arma visible (traza y fogonazo); sin viewmodel, delante del ojo.
function viewModelMuzzle(out) {
  if (firstPerson.vm?.root.visible) return firstPerson.muzzleWorld(out);
  return fpCam.launchPoint(out);
}
// Agachado: el estado nuevo `crouch` o, con el controlador de antes, el
// cover bajo.
function isCrouched(p) {
  const st = p.animState?.();
  return st === 'crouch' || st === 'cover_low' || !!p.crouched;
}

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
    // `onlineStartAt` solo presenta el 3…2…1. La fase recibida del servidor
    // es la única autoridad para habilitar movimiento, armas y pickups.
    return G.onlinePhase !== 'playing';
  }
  return false;
}

function localStartDeadline(message, fallbackSeconds = 0) {
  const now = Date.now() / 1000;
  const startsIn = Number(message?.startsIn);
  if (Number.isFinite(startsIn)) return now + Math.max(0, startsIn);
  const absolute = Number(message?.startAt);
  return Number.isFinite(absolute) && absolute > 0
    ? absolute : now + Math.max(0, fallbackSeconds);
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
    progress: 1 - bm.phaseT / BOT_INTRO_TIME, wait: t('flow.scouting'), ...common,
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

// Origen VISUAL de fogonazo/trazadora: con el arma muy picada (pitch -62°)
// el cañón del rig queda bajo el suelo. Solo se sube el efecto; el origen
// balístico y el rayo del tiro no se tocan.
const _fxO = new THREE.Vector3();
function fxAboveGround(v, footY) {
  const floor = world.groundHeight(v, 0, footY + 0.25) + 0.04;
  if (v.y < floor) v.y = floor;
  return v;
}

// Cañón del rig remoto observado; si no hay rig fiable (sin modelo, lejos
// del origen validado por interpolación) se conserva el origen transmitido.
function remoteMuzzle(r, fallback) {
  if (!r?.rig?.muzzleWorld || r.alive === false) return fallback;
  r.rig.root.updateWorldMatrix(true, true);
  const v = r.rig.muzzleWorld(new THREE.Vector3());
  return Number.isFinite(v.x + v.y + v.z) && v.distanceTo(fallback) < 6 ? fxAboveGround(v, r.y ?? v.y - 1.2) : fallback;
}

// Disparo o lanzamiento ya comprometido que aún no salió. Muerte, respawn y
// reset de partida lo descartan: online la muerte congelaba el gesto en
// espectador y, al reaparecer, el bote salía del cañón de la SMG inicial.
function clearPendingHandling() {
  G.throwT = 0; G.throwPending = false; G.pendingThrows = 0; G.pendingThrowShots.length = 0;
  G.pendingShots = 0; G.pendingRays.length = 0; G.fireBuffer = 0;
}

function enterSpectator() {
  audio.cancelHandling(); // recarga/bombeo programados no siguen en espectador
  clearPendingHandling();
  G.spectator.active = true;
  G.spectator.targetId = null;
  G.spectator.deathHold = 1.15;
  G.spectator.first = true;
  spectatorCamPos.copy(camera.position);
  hud.spectator(null); // primero deja respirar a la reacción de muerte
}

function exitSpectator() {
  clearPendingHandling(); // todo respawn pasa por aquí, también el de ronda
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
  if (G.respawnT > 0) respawn = t('spectator.waveIn', { count: Math.ceil(G.respawnT) });
  else if (G.mode === 'bots' && G.botMatch?.pool[G.team] <= 0) respawn = t('spectator.noRespawns');
  else if (G.mode === 'online' && !G.selfRespawnPending) respawn = t('spectator.noRespawns');
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
        team: G.team,
      }, null);
    }
    // jugando con los ojos: el oído ES el ojo (feetY = suelo de mis pasos);
    // en la cámara de muerte/presentación, el pecho como antes
    if (fpCam.live) return selectAudioListener(false, null, {
      x: camera.position.x, y: camera.position.y, z: camera.position.z,
      feetY: G.player.y ?? 0, right: shoulderCam.flatRight(), team: G.team,
    });
    return selectAudioListener(false, null, {
      x: G.player.pos.x,
      y: (G.player.y ?? 0) + 1.15,
      z: G.player.pos.z,
      right: shoulderCam.flatRight(),
      team: G.team,
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
// Superficie bajo los pies para los pasos: la tapa del collider donde se
// apoya (mismo criterio que groundHeight) o el suelo base del mapa.
audio.setSurfaceQuery((x, y, z) => {
  let best = null;
  for (const c of world.colliders) {
    if (c.moveOnly || c.h > y + 0.3 || c.h < y - 0.3) continue;
    if (x < c.minx || x > c.maxx || z < c.minz || z > c.maxz) continue;
    if (!best || c.h > best.h) best = c;
  }
  if (best?.surface) return best.surface;
  const theme = world.theme ?? world.layout;
  // Fortaleza con su look: fuera del patio viejo el suelo es tierra y hierba
  // (el mismo límite que usa el sombreador del piso).
  if (theme === 'fortaleza' && world.look.active && !world.customMap && (Math.abs(x) > 21.15 || Math.abs(z) > 26.75)) return 'earth';
  return theme === 'fortaleza' || theme === 'pueblo' ? 'stone' : 'concrete';
});
// ---------- origen del daño online (el snapshot solo trae la vida) ----------
// confirmed: hitConfirm / bot alojado / explosión / melee. guess: bala enemiga
// cuya trayectoria cruzó el cuerpo del jugador (test 3D). Una caída de vida
// usa SIEMPRE el confirmado; si aún no llegó, destella ya y espera unos ms a
// que llegue antes de recurrir al candidato inferido. Cada fuente se consume.
const hurtSrc = { confirmed: null, guess: null, pending: null };
function noteHurtSource(confirmed, x, z, id) {
  const src = { x, z, id, t: performance.now() };
  if (!confirmed) { hurtSrc.guess = src; return; }
  const p = hurtSrc.pending;
  if (p && src.t - p.t < 400) { hud.hurtArc(src, p.amount, id); hurtSrc.pending = null; hurtSrc.guess = null; return; }
  hurtSrc.confirmed = src;
}
function onlineHpDrop(amount) {
  const t = performance.now(), c = hurtSrc.confirmed;
  hurtSrc.confirmed = null;
  if (c && t - c.t < 700) { hud.hurt(c, amount, c.id); hurtSrc.guess = null; return; }
  hud.hurtFlash(true, amount);
  hurtSrc.pending = { amount, t };
}
// por cuadro: sin confirmado tras 150 ms, el candidato inferido (si es reciente)
function resolveOnlineHurt() {
  const p = hurtSrc.pending;
  if (!p) return;
  const t = performance.now();
  if (t - p.t < 150) return;
  const g = hurtSrc.guess;
  if (g && t - g.t < 700) hud.hurtArc(g, p.amount, g.id);
  hurtSrc.pending = null; hurtSrc.guess = null;
}
// distancia mínima entre el segmento del disparo o→p y el eje vertical del
// cuerpo (bx, y0..y1, bz): una bala que pasó por encima no es candidata
function shotBodyDistance(o, p, bx, y0, y1, bz) {
  const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z, e = y1 - y0;
  const rx = o.x - bx, ry = o.y - y0, rz = o.z - bz;
  const a = dx * dx + dy * dy + dz * dz, b = dy * e, c = dx * rx + dy * ry + dz * rz;
  const f = e * ry, ee = e * e, cl = (v) => Math.max(0, Math.min(1, v));
  const den = a * ee - b * b;
  let sp = den > 1e-9 ? cl((b * f - c * ee) / den) : 0;
  let tb = (b * sp + f) / ee;
  if (tb < 0) { tb = 0; sp = a > 1e-9 ? cl(-c / a) : 0; }
  else if (tb > 1) { tb = 1; sp = a > 1e-9 ? cl((b - c) / a) : 0; }
  return Math.hypot(rx + dx * sp, ry + dy * sp - e * tb, rz + dz * sp);
}

// Estado por cuadro para el audio (latido, protección, pedestal, cohetes,
// cama del menú). Objeto reutilizado: sin asignaciones por cuadro.
const audioFrame = { menu: false, playing: false, alive: false, hp01: 1, prot: 0,
  rockets: null, pedestal: null, holdT: 0, holdMax: SPECIAL_HOLD_TIME };
function updateAudioFrame(dt) {
  audioFrame.menu = !G.mode;
  audioFrame.playing = G.mode === 'online' || G.mode === 'bots' || G.mode === 'practice';
  audioFrame.alive = !!G.selfAlive && !!G.player && !G.player.dead;
  // pausa/presentación: hp01 = 1 apaga el latido (vuelve solo al reanudar)
  audioFrame.hp01 = (G.mode === 'online' || G.mode === 'bots') && !(G.mode && G.feedbackQuiet)
    ? G.selfHp / TUNING.combat.hp : 1;
  audioFrame.prot = G.spawnProt;
  audioFrame.rockets = rockets.list;
  audioFrame.pedestal = specials.active;
  audioFrame.holdT = specials.holdT;
  audio.update(dt, audioFrame);
}

// ---------- eventos del controller (feel: sonido + polvo + shake) ----------
const ctrlEvents = {
  onDodgeStart: () => {
    const k = motionScale('shake');
    audio.dodgeStart(k); input.pad.rumble(75, 0.55 * k, 0.25 * k);
  },
  onDodgeEnd: () => {
    const k = motionScale('shake');
    audio.dodgeEnd(k); input.pad.rumble(45, 0.20 * k, 0.65 * k);
  },
  onSlideStart: () => { audio.slide(); if (G.player) effects.dust(G.player.pos, 'slide', G.player.y); },
  onJump: () => { audio.jump(); },
  onLand: () => {
    audio.land();
    if (G.player) effects.dust(G.player.pos, 'land', G.player.y);
  },
  onMantle: () => {
    audio.mantle();
  },
  // Rival enganchable por la embestida: de frente, cerca, a la vista.
  meleeTarget: (range, arcDeg) => {
    const p = G.player, f = p.facing(), cosHalf = Math.cos(arcDeg * Math.PI / 360);
    let best = null;
    for (const tg of currentTargets()) {
      if (tg.alive === false || tg.protected) continue;
      const dx = tg.x - p.pos.x, dz = tg.z - p.pos.z, dist = Math.hypot(dx, dz);
      if (dist > range || dist < 0.05 || Math.abs((tg.y ?? 0) - p.y) > TUNING.melee.heightTolerance) continue;
      const dot = (dx * f.x + dz * f.z) / dist;
      if (dot < cosHalf) continue;
      _v1.set(p.pos.x, p.y + 1.08, p.pos.z); _v2.set(dx, 0, dz).normalize();
      if (world.raycast(_v1, _v2, Math.max(0, dist - 0.3)) !== null) continue;
      const score = dist + (1 - dot) * 1.2;
      if (!best || score < best.score) best = { id: tg.id, score };
    }
    return best;
  },
  meleeTargetPos: (id) => currentTargets().find((tg) => tg.id === id && tg.alive !== false) || null,
  onMeleeStart: () => {
    // El golpe tiene prioridad sobre una recarga, pero no inventa munición:
    // conserva cargador/reserva exactamente donde estaban.
    G.weapons?.interruptReload?.(); audio.cancelHandling();
    G.fireBuffer = 0;
    G.meleeHitDone = false;
    input.pad.rumble(40, 0.3, 0.2);
    G.weapons?.noteMelee?.('start'); // evento del emisor: viewmodel y audio
  },
};

// ---------- menú ----------
loadBinds();
// Sensibilidades: las guarda src/core/settings.js (importa las claves
// sueltas de antes una vez, valida y acota); TUNING.cam las refleja para la
// cámara de hombro.
bindTuning(TUNING);

const inName = document.getElementById('in-name');
const inServer = document.getElementById('in-server');
// Los avisos de red se muestran donde esté el jugador: en el menú principal
// y en la pantalla de multijugador (el mismo texto en ambos sitios).
const netStatus = {
  els: [document.getElementById('net-status'), document.getElementById('online-msg')],
  set textContent(value) { for (const el of this.els) el.textContent = value; },
  get textContent() { return this.els[0].textContent; },
};
const splash = document.getElementById('splash');
const btnEnter = document.getElementById('btn-enter');
// Sin nombre por defecto: cada jugador escribe el suyo (online es obligatorio).
inName.value = localStorage.getItem('breach.name') || '';
const isSecure = location.protocol === 'https:';
// Servidor por defecto. VITE_BREACH_SERVER se fija al compilar:
//  - 'same-origin': el propio server del juego sirve este cliente detrás de
//    TLS (imagen Docker) → mismo host, wss/ws según el protocolo de la página.
//  - una URL wss://…: cliente estático (Vercel) apuntando al server público.
// Sin variable: LAN por http en :8787; en https queda vacío (un wss ajeno
// no se puede adivinar y ws:// está bloqueado por contenido mixto).
const builtServer = (import.meta.env.VITE_BREACH_SERVER || '').trim();
const defaultServer = builtServer === 'same-origin'
  ? `${isSecure ? 'wss' : 'ws'}://${location.host}`
  : builtServer || (isSecure ? '' : `ws://${location.hostname}:8787`);
inServer.value = localStorage.getItem('breach.server') || defaultServer;

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
    // Solo los modelos del fondo del menú: los de cada mapa se piden al elegirlo.
    await Promise.all([audioReady, effects.prepare(renderer, camera, pipeline.compileTarget()), ensureMapAssets(world.layout, { timeoutMs: 15000 })]);
    // El fondo se construyó ANTES de tener sus modelos: setLayout lo rehace
    // porque llegaron piezas que faltaban (si no faltaba nada, no hace nada).
    if (!G.mode && world.layout) world.setLayout(world.layout);
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
  const button = e.target.closest?.('button:not(:disabled)');
  if (!button || !menuIsOpen()) return;
  // volver suena distinto de confirmar: el oído distingue avanzar de retroceder
  if (button.dataset.i18n === 'common.back' || /(^|-)back$/.test(button.id)) audio.uiBack();
  else audio.uiConfirm();
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
  // El cursor virtual puede acumular movementX/Y entre su último RAF y el
  // click/Esc que reanuda. Ese movimiento pertenece a la UI, no a la cámara.
  input.discardLookDelta(1);
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

// Mapa elegido/votado en una sala: sus modelos empiezan a bajar ya, para que
// la partida arranque sin espera (con retardo: ciclar el selector no baja todo).
let lobbyMapTimer = 0;
function warmLobbyMap(lobby) {
  const map = lobby?.settings?.map;
  clearTimeout(lobbyMapTimer);
  if (map && !mapAssetsReady(map)) lobbyMapTimer = setTimeout(() => ensureMapAssets(map), 500);
}

function refreshLocalLobby() {
  if (!G.lobby || G.lobbyKind !== 'local') return;
  warmLobbyMap(G.lobby);
  G.lobby.validation = validateLobby([...G.lobby.players, ...G.lobby.bots], G.lobby.settings);
  lobbyUI.render(G.lobby);
}

function openLocalLobby() {
  dismissSplash(); audio.ensure(); startSeq++;
  teardown({ keepLobby: false });
  G.lobby = defaultLocalLobby(); G.lobbyKind = 'local';
  warmLobbyMap(G.lobby);
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
  if (G.lobbyKind === 'online') {
    const net = G.net, map = G.lobby.settings?.map;
    if (!net) return;
    // El servidor manda el tiempo de todos: START no espera descargas del
    // anfitrión (bloqueaba a toda la sala). Lo que falte se repara al llegar.
    if (!mapAssetsReady(map)) ensureMapAssets(map, { timeoutMs: MAP_ASSET_TIMEOUT });
    net.lobbyStart();
  } else startBots(G.lobby);
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
document.getElementById('btn-online').addEventListener('click', () => showOnline(true));
document.getElementById('btn-online-back').addEventListener('click', () => showOnline(false));
document.getElementById('btn-lobby-create').addEventListener('click', () => connectOnlineLobby('create'));
document.getElementById('btn-lobby-join').addEventListener('click', () => connectOnlineLobby('join'));

// selector de mapa: valor inicial de lobby local y mapa de Práctica.
const btnMap = document.getElementById('btn-map');
{
  const saved = localStorage.getItem('breach.map');
  G.mapChoice = saved === 'calle' ? 'calle2' : MAPS.includes(saved) ? saved : 'fortaleza';
}
function updateMapBtn() {
  updateMapPreview(G.mapChoice);
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
  if (G.mode === 'editor') {
    if (editor?.handleEscape()) return;
    closeEditor();
    return;
  }
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
    // (sanitizeReqAt=0 = ninguna petición: sin el guard, un lock legítimo en
    // los primeros 2.5 s de vida de la página se tomaba por saneo y se soltaba)
    if (sanitizing || (sanitizeReqAt > 0 && performance.now() - sanitizeReqAt < 2500)) {
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
  // una captura legítima recién pedida (START, click al canvas) no debe
  // convertirse en un ciclo de saneo que la suelte a los 30 ms
  if (performance.now() - (input.captureAt || 0) < 600) return;
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
  // ?nolock es el modo deliberadamente windowed de editor/harness. Pedir
  // fullscreen aquí vuelve imposible redimensionar el viewport y contradice
  // la promesa de no capturar la ventana durante pruebas automatizadas.
  if (input.lockDisabled) return;
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
// + las páginas de ajustes que genera src/ui/settings-ui.js (HUD)
const optionSubCards = [audioCard, videoCard, languageCard,
  ...['aim-card', 'comfort-card', 'hudopts-card'].map((id) => document.getElementById(id)).filter(Boolean)];

const onlineCard = document.getElementById('online-card');

function hideOptionCards() {
  optionsCard.style.display = 'none';
  for (const c of optionSubCards) c.style.display = 'none';
  onlineCard.style.display = 'none'; // su sondeo se detiene solo al ocultarse
}

// ---------- Multijugador: pantalla de entrada con el estado de la sala ----------
// Antes de conectar, el jugador ve qué hay en el server (nadie / sala abierta
// con quién / partida en curso) y recibe UNA acción acorde: crear o unirse.
const inOnlineName = document.getElementById('in-online-name');
const onlineEl = {
  box: document.getElementById('online-status'),
  state: document.getElementById('online-state'),
  count: document.getElementById('online-count'),
  detail: document.getElementById('online-detail'),
  roster: document.getElementById('online-roster'),
  host: document.getElementById('online-server-host'),
  create: document.getElementById('btn-lobby-create'),
  join: document.getElementById('btn-lobby-join'),
  server: document.getElementById('server-field'),
};
const ONLINE_POLL_MS = 3000;
// Un host gratuito dormido tarda cerca de un minuto en despertar.
const ONLINE_STATUS_TIMEOUT_MS = 75000;
let onlineStatus = { kind: 'checking' };
let onlinePollSeq = 0;

function onlineStatusUrl(wsUrl) {
  if (!/^wss?:\/\/[^/]/i.test(wsUrl)) return null;
  try {
    const u = new URL(wsUrl.replace(/^ws/i, 'http'));
    return `${u.origin}/status`;
  } catch { return null; }
}

async function fetchOnlineStatus(wsUrl) {
  if (!wsUrl) return { kind: 'noServer' };
  const url = onlineStatusUrl(wsUrl);
  if (!url) return { kind: 'offline' };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ONLINE_STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
    // server sin /status (versión anterior): se puede intentar a ciegas
    if (!res.ok) return { kind: 'unknown' };
    const data = await res.json();
    if (!['empty', 'lobby', 'match'].includes(data?.state)) return { kind: 'unknown' };
    // 'joinable' lo decide el server (relevar a un bot, lugar libre…); un
    // server anterior no lo informa y se deduce del cupo
    const joinable = typeof data.joinable === 'boolean' ? data.joinable
      : data.state !== 'match' && data.slots < data.maxPlayers;
    return { kind: data.state === 'lobby' && !joinable ? 'full' : data.state, data, joinable };
  } catch { return { kind: 'offline' }; }
  finally { clearTimeout(timer); }
}

function renderOnlineStatus() {
  const { kind, data, joinable } = onlineStatus;
  const openMatch = kind === 'match' && joinable;
  onlineEl.box.dataset.state = kind;
  onlineEl.box.dataset.joinable = openMatch || kind === 'lobby' || kind === 'empty' ? '1' : '0';
  onlineEl.state.textContent = t(`online.state.${kind}`);
  onlineEl.count.textContent = data && kind !== 'empty' ? `${data.players} / ${data.maxPlayers}` : '';
  onlineEl.detail.textContent = t(`online.detail.${openMatch ? 'matchJoin' : kind}`, data ? {
    host: data.host ?? '—', map: t(`map.${data.map}`), bots: data.bots,
    round: Math.max(1, data.round), red: data.wins?.red ?? 0, blue: data.wins?.blue ?? 0,
  } : {});
  onlineEl.roster.replaceChildren(...(data && kind !== 'empty' ? data.names : []).map((name) => {
    const li = document.createElement('li'); li.textContent = name; return li;
  }));
  // Una sola acción según el estado; a ciegas ('unknown') se ofrecen ambas.
  const canCreate = kind === 'empty' || kind === 'unknown';
  const canJoin = kind === 'lobby' || kind === 'unknown' || openMatch;
  const showJoin = canJoin || kind === 'full' || kind === 'match';
  onlineEl.create.style.display = canCreate ? '' : 'none';
  onlineEl.join.style.display = showJoin ? '' : 'none';
  onlineEl.join.disabled = !canJoin;
  onlineEl.join.textContent = t(kind === 'match' ? 'online.joinMatch' : 'lobby.join');
  const url = inServer.value.trim();
  let host = url;
  try { host = new URL(url).host; } catch { /* se muestra tal cual */ }
  onlineEl.host.textContent = host;
  if (kind === 'noServer') onlineEl.server.open = true;
}

async function pollOnlineStatus() {
  const seq = ++onlinePollSeq;
  const active = () => seq === onlinePollSeq && onlineCard.style.display === 'block';
  while (active()) {
    // pestaña oculta: no sondear (tampoco mantiene despierto un host gratuito)
    if (!document.hidden) {
      const url = inServer.value.trim();
      const result = await fetchOnlineStatus(url);
      if (!active()) return;
      if (inServer.value.trim() === url) { onlineStatus = result; renderOnlineStatus(); }
    }
    await new Promise((resolve) => setTimeout(resolve, ONLINE_POLL_MS));
  }
}

function restartOnlineStatus() {
  onlineStatus = { kind: inServer.value.trim() ? 'checking' : 'noServer' };
  renderOnlineStatus();
  pollOnlineStatus();
}

function showOnline(on) {
  mainCard.style.display = on ? 'none' : 'block';
  hideOptionCards();
  controlsCard.style.display = 'none';
  charCard.style.display = 'none';
  onlineCard.style.display = on ? 'block' : 'none';
  hud.el.menu.scrollTop = 0;
  if (!on) { onlinePollSeq++; return; }
  // en línea se juega la rotación entera: sus modelos empiezan a bajar ya
  if (!playableMapAssetsReady()) {
    document.body.classList.add('map-loading');
    ensurePlayableMapAssets().then(() => document.body.classList.remove('map-loading'));
  }
  inOnlineName.value = inName.value;
  netStatus.textContent = '';
  restartOnlineStatus();
  if (!inOnlineName.value.trim() && input.lastDevice !== 'pad') inOnlineName.focus();
}
inOnlineName.addEventListener('input', () => {
  inName.value = inOnlineName.value;
  if (inOnlineName.value.trim()) netStatus.textContent = '';
});
inOnlineName.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const action = [onlineEl.create, onlineEl.join].find((b) => b.style.display !== 'none' && !b.disabled);
  action?.click();
});
inServer.addEventListener('change', () => { if (onlineCard.style.display === 'block') restartOnlineStatus(); });
onLanguageChange(() => { if (onlineCard.style.display === 'block') renderOnlineStatus(); });

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
  applyRenderSize();
});
const selQuality = document.getElementById('sel-quality');
selQuality.value = gfxAuto ? 'auto' : gfxQuality;
selQuality.addEventListener('change', () => {
  gfxAuto = selQuality.value === 'auto';
  if (gfxAuto) {
    // volver a AUTO olvida lo aprendido y prueba de nuevo desde el arranque
    autoGfx.reset();
    gfxQuality = autoGfx.quality;
    localStorage.removeItem('breach.video.quality');
  } else {
    gfxQuality = QUALITY[selQuality.value] ? selQuality.value : 'high';
    localStorage.setItem('breach.video.quality', gfxQuality);
  }
  pipeline.setQuality(gfxQuality);
  world.look.setQuality(gfxQuality);
  effects.setQuality(gfxQuality);
  applyShadowFilter();
  applyRenderSize();
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
  if (G.mode === 'editor') {
    if (editor?.handleEscape()) return true;
    closeEditor();
    return true;
  }
  // durante un playtest, Esc vuelve al editor con el mapa intacto
  if (G.editorReturn) { returnToEditor(); return true; }
  // jerarquía: subcard → Opciones → menú principal
  if (optionSubCards.some((c) => c.style.display === 'block')) { showOptions(true); return true; }
  if (controlsCard.style.display === 'block') { showOptions(true); return true; }
  if (optionsCard.style.display === 'block') { showOptions(false); return true; }
  if (charCard.style.display === 'block') { showChar(false); return true; }
  if (onlineCard.style.display === 'block') { showOnline(false); return true; }
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
          G.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y); G.rig.wallFn = (o, d, m) => world.raycast(o, d, m, 0); // arma recogida contra pared
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
async function renderCharPreviews() {
  const pr = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  // Se renderiza holgado y grande; el recorte final ajusta al soldado.
  pr.setPixelRatio(1);
  pr.setSize(1056, 1344);
  const ps = new THREE.Scene();
  ps.add(new THREE.HemisphereLight(0xd9e6f0, 0x97876e, 2.2));
  const dl = new THREE.DirectionalLight(0xffe9c4, 1.6);
  dl.position.set(2, 3, -2.5);
  ps.add(dl);
  const fill = new THREE.DirectionalLight(0xdfe8f0, 0.9); // relleno hacia la cara
  fill.position.set(2.2, 1.4, -1.4);
  ps.add(fill);
  const pc = new THREE.PerspectiveCamera(30, 176 / 224, 0.1, 20);
  const rigs = [];
  for (let v = 0; v < 5; v++) {
    const r = new Rig(ps, 'red', null, v);
    await r.visualReady;
    // Asentar piernas/torso y luego aplicar una pose de exhibición simétrica.
    for (let i = 0; i < 40; i++) r.update(1 / 30, { state: 'idle', speed: 0, aim: false, aimPitch: 0 });
    r.gunMount.visible = !!r.blenderSoldier;
    r.backMount.visible = false;
    if(!r.blenderSoldier){
      r.aimRig.rotation.set(0, 0, 0);
      r.armL.shoulder.rotation.set(0, 0, -0.13);
      r.armR.shoulder.rotation.set(0, 0, 0.13);
      r.armL.elbow.rotation.set(0, 0, 0);
      r.armR.elbow.rotation.set(0, 0, 0);
    }
    r.root.rotation.y = -0.18;
    r.root.updateWorldMatrix(true, true);
    rigs.push(r);
  }
  // El encuadre se MIDE sobre los cinco soldados (casco más alto incluido):
  // una cámara fija por números cortaba la cabeza al cambiar el modelo.
  const bounds = new THREE.Box3();
  for (const r of rigs) bounds.union(visibleBounds(r.root, _frameBox));
  frameCameraOn(pc, bounds, PREVIEW_VIEW_DIR);
  for (const r of rigs) r.root.visible = false;
  const shots = rigs.map((r) => {
    r.root.visible = true;
    pr.render(ps, pc);
    r.root.visible = false;
    return snapshotCanvas(pr.domElement);
  });
  // mismo recorte para los cinco: el selector no falsea tamaños relativos
  cropToContent(shots, 352, 448).forEach((src, v) => {
    const img = charSlots.querySelector(`button[data-v="${v}"] img`);
    if (img) img.src = src;
  });
  for (const r of rigs) r.dispose(ps);
  pr.dispose();
}

// Copia inmediata del canvas WebGL (su buffer no sobrevive al siguiente frame).
function snapshotCanvas(source) {
  const copy = document.createElement('canvas');
  copy.width = source.width; copy.height = source.height;
  copy.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0);
  return copy;
}

// Recorta un grupo de renders al contenido SÓLIDO que comparten (el halo
// translúcido no cuenta), con margen y la proporción de salida. Medir los
// píxeles dibujados es inmune a mallas auxiliares que inflan una caja 3D.
function cropToContent(shots, outW, outH, pad = 0.07) {
  const w = shots[0].width, h = shots[0].height;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const shot of shots) {
    const data = shot.getContext('2d').getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 200) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return shots.map((shot) => shot.toDataURL());
  let bw = (x1 - x0 + 1) * (1 + pad * 2), bh = (y1 - y0 + 1) * (1 + pad * 2);
  if (bw / bh < outW / outH) bw = bh * outW / outH; else bh = bw * outH / outW;
  const sx = (x0 + x1 + 1) / 2 - bw / 2, sy = (y0 + y1 + 1) / 2 - bh / 2;
  return shots.map((shot) => {
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shot, sx, sy, bw, bh, 0, 0, outW, outH);
    return out.toDataURL();
  });
}

// Caja de lo que realmente se dibuja (mallas visibles; sin etiquetas ni
// armas ocultas) y cámara que la contiene entera con un margen.
const PREVIEW_VIEW_DIR = new THREE.Vector3(0.52, 0.63, -2.75).normalize();
const _frameBox = new THREE.Box3(), _framePart = new THREE.Box3();
const _frameCenter = new THREE.Vector3(), _frameSize = new THREE.Vector3();
function visibleBounds(root, out) {
  out.makeEmpty();
  root.updateWorldMatrix(true, true);
  const visit = (o) => {
    if (!o.visible) return;
    if (o.isSkinnedMesh) {
      // cuerpo fusionado: sus vértices viven en el espacio de cada pieza; la
      // caja real sale de la pose actual (SkinnedMesh aplica los huesos)
      o.computeBoundingBox();
      out.union(_framePart.copy(o.boundingBox).applyMatrix4(o.matrixWorld));
    } else if (o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      out.union(_framePart.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
    }
    for (const child of o.children) visit(child);
  };
  visit(root);
  return out;
}
function frameCameraOn(camera, box, viewDir, margin = 1.1) {
  if (box.isEmpty()) return;
  box.getCenter(_frameCenter); box.getSize(_frameSize);
  const half = Math.tan(camera.fov * Math.PI / 360);
  const width = Math.max(_frameSize.x, _frameSize.z);
  // la cara cercana de la caja es la que manda en perspectiva: se suma media
  // profundidad para que hombros y casco no rocen el borde
  const dist = Math.max(_frameSize.y / 2 / half, width / 2 / (half * camera.aspect)) * margin + width / 2;
  camera.position.copy(_frameCenter).addScaledVector(viewDir, dist);
  camera.lookAt(_frameCenter);
  camera.updateProjectionMatrix();
}

const portraitCache = new Map();
function renderCharacterPortrait(variant = 0, team = 'red') {
  const key = `${team}:${variant | 0}`;
  if (portraitCache.has(key)) return portraitCache.get(key);
  const pr = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  pr.setPixelRatio(1);
  pr.setSize(720, 960); // holgado; el recorte final ajusta al soldado
  const ps = new THREE.Scene();
  ps.add(new THREE.HemisphereLight(0xe2eaf0, 0x5b6169, 2.25));
  const keyLight = new THREE.DirectionalLight(team === 'red' ? 0xffd8bd : 0xc8dcff, 1.8);
  keyLight.position.set(2.4, 3.6, -2.8); ps.add(keyLight);
  const rim = new THREE.DirectionalLight(team === 'red' ? 0xd94f3f : 0x4f8de0, 1.15);
  rim.position.set(-2.2, 2, 1.8); ps.add(rim);
  const pc = new THREE.PerspectiveCamera(28, 240 / 320, .1, 20);
  const rig = new Rig(ps, team, null, variant | 0);
  for (let i = 0; i < 35; i++) rig.update(1 / 30, { state: 'idle', speed: 0, aim: false, aimPitch: 0 });
  rig.root.rotation.y = -.2;
  rig.root.updateWorldMatrix(true, true);
  frameCameraOn(pc, visibleBounds(rig.root, _frameBox), PREVIEW_VIEW_DIR);
  pr.render(ps, pc);
  const data = cropToContent([snapshotCanvas(pr.domElement)], 480, 640)[0];
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
  slMouse.value = setSetting('sens', parseFloat(slMouse.value));
  updateSliderLabels();
});
slPad.addEventListener('input', () => {
  setSetting('padSensY', parseFloat(slPad.value));
  slPad.value = setSetting('padSensX', parseFloat(slPad.value));
  updateSliderLabels();
});
slZoom.addEventListener('input', () => {
  slZoom.value = setSetting('sensScope', parseFloat(slZoom.value));
  updateSliderLabels();
});
slVol.addEventListener('input', () => {
  audio.ensure();
  audio.setVolume(parseFloat(slVol.value));
  updateSliderLabels();
  audio.hit(); // bip de referencia para calibrar al oído
});
chkInvert.addEventListener('change', () => {
  input.invertY = setSetting('invertY', chkInvert.checked);
});
chkInvertPad.addEventListener('change', () => {
  input.invertYPad = setSetting('invertYPad', chkInvertPad.checked);
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
    // assignBind intercambia con la acción que tuviera la tecla: nunca dos
    if (e.code !== 'Escape') assignBind('kb', action, e.code);
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
        assignBind('pad', action, b);
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
  if (!keepNet) setHitModel(2); // fuera de una sesión online: modelo de pose
  audio.stopGameplay(); // recargas programadas, loops de cohete/pedestal
  G.protoView?.clear();G.protoEngine=null;G.protoSnapshot=null;G.protoStun=0;
  G.blastDebug?.dispose();G.blastDebug=null;
  resetSpectator();
  if (G.rig) { G.rig.dispose(scene); G.rig = null; }
  if (G.dummies) { G.dummies.dispose(); G.dummies = null; }
  if (G.botMatch) { G.botMatch.dispose(); G.botMatch = null; }
  G.onlineBots = null;
  if (G.crates) { G.crates.dispose(); G.crates = null; }
  if (G.drops) { G.drops.dispose(); G.drops = null; }
  G.player = null; // sin referencias a caras de un mapa destruido
  clearPendingHandling();
  G.aimOver.lift = 0;
  smoke.clear();
  specials.clear();
  rockets.clear();
  G.specialRound = 0;
  G.spawnProt = 0;
  G.respawnT = 0;
  G.selfRespawnPending = false;
  hud.respawnTick(null);
  hud.centerOff();  // sin "GANA ROJO" colándose a la partida siguiente
  hud.clearFeed();
  hurtSrc.confirmed = hurtSrc.guess = hurtSrc.pending = null; // nada del daño online pasa a otra partida
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

// Vida nueva (reaparición, ronda nueva, entrada tardía): la red empieza sin
// postura previa ni mezcla heredada (resetLife conserva el contador `n`).
// Directo aquí, no a través de la cámara.
function newLife(serverLife) {
  G.net?.resetLife?.(G.player, serverLife);
  G.lifeId = (G.lifeId ?? 0) + 1;
  // vida nueva en el arma: las sueltas de la vida anterior ya no se reembolsan
  G.weapons.newLife(serverLife);
}

function spawnLocal(team, spawn, serverLife) {
  G.team = team;
  G.rig = new Rig(scene, team, null, G.charVariant);
  G.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y); G.rig.wallFn = (o, d, m) => world.raycast(o, d, m, 0); // arma recogida contra pared
  G.rig.collideFn = (p, y, r = RAGDOLL_R) => world.resolveCircle(p, r, y);
  G.player = new Controller(world, shoulderCam, ctrlEvents);
  G.player.bindWeapons?.(G.weapons); // arma en mano + lanzamiento comprometido (decisión 18)
  G.player.poseClock = () => G.simClock; // la mezcla de postura con el MISMO reloj que main y la red
  G.player.respawn(spawn); newLife(serverLife);
  G.weapons.reset(); audio.cancelHandling(); clearPendingHandling();
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
  if (!position || !['bazooka','frag'].includes(ctx?.weapon)) return false;
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
    G.rig.hitReact(side, Math.min(1.2, dmg / 50), 'kick');
    if (!(G.kickDazeImmune > 0)) {
      G.kickDaze = TUNING.melee.dazeTime;
      G.kickDazeImmune = G.kickDaze + TUNING.melee.dazeImmunity;
    }
    // Empuje corto y físico: resolveCircle impide atravesar pared/cover.
    G.player.pos.x += (dx / len) * 0.13;
    G.player.pos.z += (dz / len) * 0.13;
    world.resolveCircle(G.player.pos, PLAYER_R, G.player.y);
  }
  audio.hurt({ position: shooter, amount: dmg });
  hud.hurt(shooter, dmg, fromName); // arco hacia el atacante
  shoulderCam.addShake(0.35);
  input.pad.rumble(120, 0.4, 0.6);
  if (G.selfHp > 0 && ['bazooka','frag'].includes(hitCtx?.weapon)) {
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
    G.weapons.cancelActions(); audio.cancelHandling();
    // morir a mitad del lanzamiento: el bote NO sale de una mano muerta
    G.throwT = 0; G.throwPending = false; G.pendingThrows = 0; G.pendingThrowShots.length = 0;
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
      G.respawnT = G.botMatch ? G.botMatch.waveRemaining : TUNING.combat.respawnTime;
    } else {
      G.respawnT = 0;
      hud.center(t('msg.noLives'), t('msg.waitRound'), 4500);
    }
    // El drop nace cuando desaparece el arma de la mano y en la posición
    // ACTUAL del cadáver; antes aparecía 60 ms tarde en el punto inicial.
    const dropAt = { x: G.player.pos.x, z: G.player.pos.z, y: world.groundHeight(G.player.pos, PLAYER_R, G.player.y) };
    // la granada no es un arma soltable: si estaba en mano, cae la primaria
    const dropWep = G.weapons.def.thrown || G.weapons.cur==='stun' ? G.weapons.primary : G.weapons.cur;
    const wep = dropWep, mag = G.weapons.state[dropWep].mag, res = G.weapons.state[dropWep].reserve;
    const id = 'p' + G.dropSeq++;
    const deathRig = G.rig, deathDrops = G.drops;
    if (deathDrops && TUNING.weapons[wep]?.special && mag + res > 0) deathDrops.pendingPower = (deathDrops.pendingPower || 0) + 1;
    setTimeout(() => {
      if (deathDrops && TUNING.weapons[wep]?.special && mag + res > 0) deathDrops.pendingPower--;
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

// Una partida (o un cambio de mapa) espera los modelos de SU mapa antes de
// construirlo: nunca se arma con sustitutos por tenerlos aún en vuelo. Si ya
// están, devuelve false y el arranque sigue en este mismo tick; si no, true y
// `resume` repite el arranque al llegar (o tras el tope, con sustitutos).
const MAP_ASSET_TIMEOUT = 20000;
let otherMapsTimer = 0;
function waitForMapAssets(map, resume, cancelled) {
  // los demás mapas jugables bajan después, en segundo plano y en tiempo ocioso
  if (!otherMapsTimer) otherMapsTimer = setTimeout(prefetchOtherMapAssets, 6000);
  if (!map || mapAssetsReady(map)) return false;
  document.body.classList.add('map-loading');
  ensureMapAssets(map, { timeoutMs: MAP_ASSET_TIMEOUT }).then(() => {
    document.body.classList.remove('map-loading');
    if (!cancelled()) resume();
  });
  return true;
}

// Tras la espera la sala pudo cambiar (otro mapa, bots quitados): se relee y
// se revalida; si cambió el mapa se carga el nuevo antes de arrancar.
function resumeLocalLobby(lobby, map) {
  if (G.lobby && G.lobby !== lobby) return;
  if ((lobby.settings || DEFAULT_LOBBY_SETTINGS).map !== map) { startBots(lobby); return; }
  lobby.validation = validateLobby([...lobby.players, ...lobby.bots], lobby.settings || DEFAULT_LOBBY_SETTINGS);
  if (!lobby.validation.ok) { refreshLocalLobby(); return; }
  startBots(lobby, { assetsWaited: true });
}

function startBots(lobby = G.lobby || defaultLocalLobby(), { assetsWaited = false } = {}) {
  // captura del ratón DENTRO del click de START: a los 13 s (o tras la carga)
  // el navegador ya no la concede sin otro gesto y el jugador quedaba sin
  // control, pulsando teclas que no hacían nada
  input.captureNow();
  if (!assetsWaited) {
    const map = (lobby.settings || DEFAULT_LOBBY_SETTINGS).map, seq = ++startSeq;
    if (waitForMapAssets(map, () => resumeLocalLobby(lobby, map), () => seq !== startSeq)) {
      audio.ensure(); enterFullscreen(); // dentro del gesto del usuario
      return;
    }
  }
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
  G.weapons.online = G.mode === 'online';
  G.weapons.infinite = false; // la munición infinita es SOLO de práctica
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
    stepSound, onDodgeCue,
    dropWeapon: (wep, x, z, team, y = 0, deathRig = null, specialAmmo = 0) => {
      // los bots no llevan contador de balas: sueltan un remanente plausible.
      // Aparece exactamente al soltar el arma y sigue el pequeño arrastre del
      // cadáver en vez de quedarse en la posición previa al impacto.
      const def = TUNING.weapons[wep];
      const id = 'b' + G.dropSeq++;
      const deathDrops = G.drops;
      if (deathDrops && def.special && specialAmmo > 0) deathDrops.pendingPower = (deathDrops.pendingPower || 0) + 1;
      setTimeout(() => {
        if (deathDrops && def.special && specialAmmo > 0) deathDrops.pendingPower--;
        if (!deathDrops || G.drops !== deathDrops) return;
        const rag = deathRig?.rag;
        const dx = rag ? rag.bx + rag.ox : x;
        const dz = rag ? rag.bz + rag.oz : z;
        const gy = world.groundHeight({ x: dx, z: dz }, PLAYER_R, rag?.by ?? y);
        deathDrops.spawn(id, wep, dx, dz, team,
          def.special ? Math.min(def.mag, specialAmmo) : Math.ceil(def.mag * (0.2 + Math.random() * 0.6)),
          def.special ? Math.max(0, specialAmmo - def.mag) : Math.ceil(def.reserve * Math.random() * 0.4), undefined, gy);
      }, 220);
    },
    player: () => ({
      x: G.player.pos.x, z: G.player.pos.z, y: G.player.y, alive: G.selfAlive,
      // volumen de la pose dibujada (agachado tras cover bajo, de pie al
      // apuntar por encima, tumbado en dive...): hit-pose.js
      ...localHitFields(),
    }),
    damagePlayer: (dmg, fromName, shooter, hitCtx) => damagePlayerLocal(dmg, fromName, shooter, hitCtx),
    respawnPlayer: (spawn, protect = true) => {
      G.selfAlive = true;
      G.selfHp = TUNING.combat.hp;
      G.respawnT = 0;
      G.player.respawn(spawn); newLife();
      G.weapons.reset(); audio.cancelHandling();
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
  showOnce('breach.hint.scoreboard', () => setTimeout(() => hud.hint(t('msg.scoreboardHint'), 2800), 3400));
}

// ¿Se ve la cuenta regresiva (cámara de hombro) o una presentación con su
// propia cámara? Sin construir la vista completa: se llama cada cuadro.
function flowCountdownShowing() {
  if (G.mode === 'bots') return G.botMatch?.phase === 'countdown';
  if (G.mode === 'online') {
    const remain = G.onlineStartAt - Date.now() / 1000;
    return !G.onlineRoundResult && !G.onlineFinal && remain > 0 && remain <= COUNTDOWN_TIME;
  }
  return false;
}

// Señales del arranque: "saltar" durante la presentación de vs bots y
// "clic para jugar" siempre que se esté en juego sin el ratón capturado
// (antes no había nada: las teclas no respondían y no se sabía por qué).
const skipCueEl = document.getElementById('skip-cue');
const lockPromptEl = document.getElementById('lock-prompt');
function updateStartPrompts(flowView, menuOpen) {
  const inMatch = !!G.mode && G.mode !== 'editor' && !menuOpen;
  skipCueEl?.classList.toggle('on', inMatch && G.mode === 'bots' && G.botMatch?.phase === 'intro');
  // (jugando con el control no hace falta el ratón: sin aviso)
  const needsLock = inMatch && !input.locked && !input.lockDisabled && input.lastDevice !== 'pad' &&
    (!flowView || flowView.phase === 'countdown');
  lockPromptEl?.classList.toggle('on', needsLock);
}

// Saltar la presentación de vs bots: cualquier tecla, click o botón del pad.
// Online la temporiza el servidor: no se salta. El margen inicial evita que
// el mismo gesto que pulsó START (o su eco del pad) la salte.
input.onAnyPress = () => {
  if (G.mode !== 'bots' || menuIsOpen()) return;
  G.botMatch?.skipIntro?.(0.35);
};

// Pistas de aprendizaje: se muestran una sola vez por navegador.
function showOnce(key, show) {
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch { /* sin storage: mostrar */ }
  show();
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

function closeEditor({ force = false } = {}) {
  if (!editor) return false;
  if (!force && editor.dirty && !confirm(t('editor.unsavedExit'))) return false;
  editor.close();
  editor.discardDraft();
  editorUI.show(false);
  G.mode = null;
  input.suppress = false;
  teardown();
  showMenuBackdrop();
  hud.show(false);
  hud.showMenu(true);
  return true;
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
  // el borrador se descarta cuando el mundo YA se construyó con él (si hay que
  // esperar modelos, eso ocurre después); así no contamina el selector normal
  startPractice({ fullscreen: false, onBuilt: () => editor.discardDraft() });
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

function startPractice({ fullscreen = true, assetsWaited = false, onBuilt = null } = {}) {
  input.captureNow(); // dentro del gesto (ver startBots)
  if (!assetsWaited) {
    const map = G.mapChoice, seq = ++startSeq;
    if (waitForMapAssets(map, () => startPractice({ fullscreen, assetsWaited: true, onBuilt }),
      () => seq !== startSeq || G.mapChoice !== map)) {
      audio.ensure(); if (fullscreen) enterFullscreen(); // dentro del gesto
      return;
    }
  }
  dismissSplash();
  audio.ensure();
  if (fullscreen) enterFullscreen();
  startSeq++;
  teardown();
  G.name = saveName();
  effects.clearImpacts();
  world.setLayout(G.mapChoice); // mapa elegido en el menú
  onBuilt?.(); // el playtest suelta su borrador solo con el mundo ya construido
  audio.setAmbience(G.mapChoice);
  G.mode = 'practice';
  // campo de tiro: munición infinita para TODO el arsenal (reserva eterna,
  // granadas que se reponen, sniper/bazooka recargables sin fin)
  G.weapons.online = G.mode === 'online';
  G.weapons.infinite = true;
  spawnLocal('red', world.spawns.red[1]);
  G.dummies = new Dummies(scene, world);
  G.crates = new AmmoCrates(scene, false, world.cratePos ?? undefined);
  // el pedestal arranca con el sniper y, al tomarlo, reaparece alternando
  // sniper↔bazooka: ambas especiales se prueban sin reiniciar
  if (world.specialSpot) { G.specialRound = 1; spawnSpecialForRound(); }
  hud.showMenu(false);
  showControls(false);
  hud.show(true);
  hud.score(0, 0);
  hud.center(t('msg.practice'), t('msg.practiceSub'), 2600);
  audio.roundStart();
  input.requestLock();
  // (el recordatorio "EJE Y: NORMAL — F9" salía en CADA práctica: ruido. El
  // aviso solo aparece al cambiar el ajuste, y la opción sigue en el menú)
}

async function connectOnlineLobby(action) {
  dismissSplash();
  // El nombre es obligatorio para jugar con otras personas: sin él no se
  // conecta, se abre la pantalla de multijugador y se pide ahí.
  const fromCard = onlineCard.style.display === 'block';
  const typed = (fromCard ? inOnlineName : inName).value.trim();
  if (!typed) {
    if (!fromCard) showOnline(true);
    netStatus.textContent = t('online.nameRequired');
    inOnlineName.focus();
    return;
  }
  inName.value = typed;
  audio.ensure();
  enterFullscreen();
  G.name = saveName();
  const url = inServer.value.trim();
  if (!url) { netStatus.textContent = t('msg.serverUrl'); onlineEl.server.open = true; return; }
  localStorage.setItem('breach.server', url);
  const mySeq = ++startSeq;
  // Los modelos de la rotación bajan EN SEGUNDO PLANO: entrar a la sala no
  // espera descargas (en una máquina lenta esa espera llegaba a 20 s y la sala
  // parecía lista sin estar conectada). Si la partida empieza antes, el mapa se
  // construye con sustitutos y se repara al llegar (repairMapIfDue).
  if (!playableMapAssetsReady()) ensurePlayableMapAssets({ timeoutMs: MAP_ASSET_TIMEOUT });
  netStatus.textContent = t('msg.connecting');
  const net = new NetClient();
  bindNet(net);
  try {
    const welcome = await net.connect(url, G.name, G.charVariant, action);
    // si durante el await el usuario arrancó OTRA partida (vs bots, práctica),
    // este welcome tardío no debe secuestrarla
    if (startSeq !== mySeq) { net.close(); return; }
    // DECISIÓN 16: cliente FPS + servidor sin `fps` = no se entra. Se avisa
    // y se queda en el menú (la conexión se cierra sin tocar la partida).
    if (welcome?.fps !== 1 || net.fps === false) { net.close(); showServerOutdated(); return; }
    teardown({ keepLobby: false });
    G.net = net;
    // un servidor anterior no anuncia `hp`: se valida con la regla antigua y
    // aquí se apunta con ella también (nadie ve un impacto que se descarte)
    setHitModel(welcome.hp === 2 ? 2 : 1);
    G.team = welcome.team;
    G.lobby = welcome.lobby;
    G.lobbyKind = 'online';
    G.mode = null;
    warmLobbyMap(G.lobby);
    hud.show(false); hud.showMenu(true); showControls(false); input.releaseLock();
    lobbyUI.show(G.lobby, net.id, 'online');
    audio.lobbyEnter();
    netStatus.textContent = '';
  } catch (e) {
    if (e?.code === 'server-outdated' || /server-outdated/.test(e?.message ?? '')) { showServerOutdated(); return; }
    netStatus.textContent = t('msg.error', { message: e.message });
  }
}
// "El servidor aún no está actualizado" (HUD: net.serverOutdated) y de
// vuelta al menú principal; también si llega como evento en plena sesión.
function showServerOutdated() {
  if (G.net) { try { G.net.close(); } catch { /* ya cerrada */ } }
  if (G.mode || G.lobbyKind) teardown({ keepLobby: false });
  G.mode = null;
  hud.show(false); hud.showMenu(true); input.releaseLock();
  netStatus.textContent = t('net.serverOutdated');
  hud.hint?.(t('net.serverOutdated'), 4000);
}

function onlineHumanTargets() {
  const out = [];
  if (G.player) out.push({ id: G.net.id, team: G.team, x: G.player.pos.x, z: G.player.pos.z,
    y: G.player.y, alive: G.selfAlive, hp: G.selfHp, ...localHitFields() });
  for (const r of G.remotes.values()) if (!r.bot) out.push({ id: r.id, team: r.team, x: r.x, z: r.z,
    y: r.y || 0, alive: r.alive, hp: r.hp ?? 100, ...remoteHitFields(r) });
  return out;
}

function setupOnlineBots(roster) {
  if (G.lobby?.hostId !== G.net?.id) return;
  const slots = roster.filter((p) => p.bot);
  // El primer tiro tras frenar puede caer entre dos envíos a 20 Hz. Durante
  // la recuperación, adjuntar el estado exacto antes de cualquier acción.
  const noteDodgeShot = (bot, weapon) => {
    const recovery = sprintFireDelay(weapon) + 2 / TUNING.net.sendHz;
    if (bot.dodgeCd >= TUNING.dodge.cooldown - recovery) G.net?.botState([bot]);
  };
  G.botMatch = new BotMatch(scene, world, {
    smoke, specials, rockets,
    effects, audio, hud, humans: onlineHumanTargets,
    playing: () => G.onlinePhase === 'playing',
    stepSound, onDodgeCue,
    botFire: (bot, origin, point, wep, impacts) => {
      noteDodgeShot(bot, wep);
      return G.net?.botFire(bot.id, origin, point, wep, impacts, bot);
    },
    botHit: (bot, targetId, dmg, part, gib, point, meta) => {
      // bot alojado que me pega: su posición orienta el arco de daño del snapshot
      if (targetId === G.net?.id) noteHurtSource(true, bot.pos.x, bot.pos.z, bot.id);
      return G.net?.botHit(bot.id, targetId, dmg, part, gib, point, meta);
    },
    botNade: (bot, origin, velocity, cid) => {
      noteDodgeShot(bot, 'grenade');
      return G.net?.send({ t: 'nade', bot: bot.id, o: [origin.x, origin.y, origin.z],
        v: [velocity.x, velocity.y, velocity.z], ...(cid ? { cid } : {}) });
    },
    botRocket: (bot, origin, dir, cid) => {
      noteDodgeShot(bot, 'bazooka');
      return G.net?.rocket(origin, dir, cid, bot, bot.id);
    },
    claimBotSpecial: (bot) => G.net?.send({ t: 'takeSpecial', bot: bot.id }),
  }, {
    external: true, playerTeam: G.team, rounds: G.onlineSettings.rounds, lives: G.onlineSettings.lives,
    bots: slots.map((b) => ({ id: b.id, name: b.name, team: b.team, variant: b.v,
      spawn: { x: b.x, z: b.z, yaw: b.team === 'red' ? Math.PI : 0 } })),
  });
  G.onlineBots = G.botMatch;
}

// En línea NO se espera nada entre los mensajes del servidor y construir el
// mundo: los modelos de todos los mapas de la rotación se cargan antes de
// poder entrar a una sala (connectOnlineLobby). Si aun así falta uno, se
// construye con sustituto y se repara al llegar, entre rondas.
function setupOnlineMatch(m) {
  const net = G.net; if (!net) return;
  teardown({ keepNet: true, keepLobby: true });
  G.mode = 'online';
  G.weapons.online = G.mode === 'online';
  G.weapons.infinite = false; // la munición infinita es SOLO de práctica
  G.onlineSettings = m.settings || G.lobby.settings;
  G.onlinePhase = m.phase || 'intro';
  G.onlineStartAt = localStartDeadline(m, INTRO_TIME + COUNTDOWN_TIME);
  G.onlineWins = m.wins || { red: 0, blue: 0 }; G.scores = m.lives || { red: G.onlineSettings.lives, blue: G.onlineSettings.lives };
  G.mapChoice = G.onlineSettings.map; world.setLayout(G.mapChoice); effects.clearImpacts();
  audio.setAmbience(G.mapChoice);
  const roster = m.players || [];
  const mine = roster.find((p) => p.id === net.id);
  if (!mine) return;
  spawnLocal(mine.team, { x: mine.x, z: mine.z, yaw: mine.team === 'red' ? Math.PI : 0 }, mine.life);
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
  // Los modos locales toleran el campo vacío con un nombre genérico que NO se
  // guarda: el online lo sigue pidiendo la primera vez.
  const n = inName.value.trim().toUpperCase();
  if (n) localStorage.setItem('breach.name', n);
  return n || 'PLAYER';
}

function addRemote(p) {
  const prev = G.remotes.get(p.id);
  if (prev) prev.dispose(scene); // id repetido: no dejar rigs huérfanos
  const r = new RemotePlayer(scene, p.id, p.name, p.team, p.v | 0);
  r.onDodgeCue = onDodgeCue;
  r.world = world;
  r.rig.setNameTagThroughWalls(p.team === G.team); // solo compañeros a través de muros
  r.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y); r.rig.wallFn = (o, d, m) => world.raycast(o, d, m, 0); // arma recogida contra pared
  r.rig.collideFn = (pt, y, radius = RAGDOLL_R) => world.resolveCircle(pt, radius, y);
  r.alive = p.alive !== false;
  r.bot = !!p.bot;
  // posición real desde el welcome: sin ella nacían apilados en (0,0)
  if (typeof p.x === 'number') { r.x = p.x; r.z = p.z; }
  G.remotes.set(p.id, r);
}

function reconcileLocalOnlineSnapshot(snapshot) {
  if (!G.player || !snapshot) return;
  const serverAlive = snapshot.alive !== false;
  const wasAlive = G.selfAlive;
  const respawnSeconds = Number(snapshot.resp);
  if (serverAlive) {
    G.selfRespawnPending = false;
    G.respawnT = 0;
  } else {
    if (Number.isFinite(respawnSeconds)) G.respawnT = Math.max(0, respawnSeconds);
    if (snapshot.rq !== undefined) G.selfRespawnPending = !!snapshot.rq;
  }

  if (!serverAlive && wasAlive) {
    // Fallback ante una muerte perdida por una transición/reconexión: el snap
    // no reproduce gore ni audio, pero nunca deja un jugador vivo localmente
    // cuando el servidor ya lo considera eliminado.
    G.selfAlive = false;
    G.weapons.cancelActions(); audio.cancelHandling();
    if (!G.player.dead) G.player.kill();
    enterSpectator();
  } else if (serverAlive && !wasAlive) {
    // WebSocket mantiene orden y normalmente `respawn` llega primero. Este
    // camino reconcilia el estado si la UI se montó tarde o cambió de host.
    G.selfAlive = true;
    G.player.respawn({ x: snapshot.x, z: snapshot.z, yaw: snapshot.yaw || 0 }); newLife(snapshot.life);
    G.weapons.reset(); audio.cancelHandling();
    G.rig?.setWeapon?.('smg');
    exitSpectator();
  } else {
    G.selfAlive = serverAlive;
  }

  // Durante fases bloqueadas el spawn/pose del servidor es source of truth.
  // En gameplay normal seguimos usando predicción local + `correction` para
  // no introducir rubber-banding en cada snapshot.
  if (serverAlive && G.onlinePhase !== 'playing' &&
      [snapshot.x, snapshot.y, snapshot.z].every(Number.isFinite)) {
    G.player.pos.x = snapshot.x;
    G.player.pos.z = snapshot.z;
    G.player.y = snapshot.y;
    G.player.vel.x = 0;
    G.player.vel.z = 0;
    G.player.vy = 0;
    G.player.cover = null;
    G.player.coverEntry = null;
  }
}

// ---------- red ----------
function bindNet(net) {
  // TODO handler ignora mensajes de sockets que ya no son la sesión activa
  // (sin esto, un reconectar fallido o mensajes bufereados del socket viejo
  // ejecutaban acciones — kill/respawn/teleport — sobre la partida NUEVA)
  const alive = () => G.net === net;
  net.on('lobby', (m) => {
    if (!alive()) return;
    // aviso sonoro de jugador nuevo en la sala (no en la primera foto)
    const prevPlayers = G.lobbyKind === 'online' ? (G.lobby?.players?.length ?? 0) : 0;
    if (!G.mode && prevPlayers > 0 && (m.players?.length ?? 0) > prevPlayers) audio.playerJoined();
    G.lobby = m; G.lobbyKind = 'online';
    if (!G.mode) warmLobbyMap(m);
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
  // Entrar a una partida (al empezar o ya empezada) solo con SU mapa cargado:
  // nunca se ve un mapa a medio construir. La espera tiene tope
  // (MAP_ASSET_TIMEOUT; luego se entra y se repara) y no frena a nadie: los
  // mensajes del servidor quedan retenidos en orden y se aplican al entrar,
  // así que el cliente sigue la fase real del servidor sin perder estado.
  net.on('matchStart', (m) => {
    if (!alive()) return;
    const map = m.settings?.map || G.lobby?.settings?.map;
    if (!map || mapAssetsReady(map)) { setupOnlineMatch(m); return; }
    net.hold();
    document.body.classList.add('map-loading');
    netStatus.textContent = t('common.preparing');
    ensureMapAssets(map, { timeoutMs: MAP_ASSET_TIMEOUT }).then(() => {
      document.body.classList.remove('map-loading');
      if (!alive()) return;
      setupOnlineMatch(m);
      net.release();
    });
  });
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
  // Cambios de roster con la partida empezada. El servidor decide quién
  // releva a quién; aquí solo se reflejan (y se avisa a todos).
  const rowOf = (p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot ? 1 : 0,
    variant: p.v | 0, kills: p.kills || 0, deaths: p.deaths || 0, score: (p.kills || 0) * 100 });
  const dropSlot = (id) => {
    const name = G.onlineRows.find((row) => row.id === id)?.name ?? null;
    const r = G.remotes.get(id);
    if (r) { r.dispose(scene); G.remotes.delete(id); }
    G.onlineBots?.removeExternalBot(id);
    G.onlineRows = G.onlineRows.filter((row) => row.id !== id);
    return name;
  };
  net.on('joined', (m) => {
    if (!alive() || m.id === net.id) return;
    // quien entra releva a un bot: el bot sale del mundo en este mismo paso
    const botName = m.replaced ? dropSlot(m.replaced) : null;
    addRemote(m);
    if (!G.onlineRows.some((r) => r.id === m.id)) G.onlineRows.push(rowOf(m));
    if (!G.mode) return;
    hud.hint(botName ? t('msg.joinedFor', { name: m.name, bot: botName })
      : t('msg.joined', { name: m.name }), 3200);
    audio.lobbyEnter();
  });
  net.on('left', (m) => {
    if (!alive()) return;
    const name = m.name ?? dropSlot(m.id);
    dropSlot(m.id);
    const bot = m.bot;
    if (bot) {
      // un bot cubre el lugar: lo simula el anfitrión, los demás lo ven remoto
      G.onlineRows.push(rowOf(bot));
      if (G.mode && G.lobby?.hostId === net.id && G.onlineBots) {
        G.onlineBots.addExternalBot({ id: bot.id, name: bot.name, team: bot.team, variant: bot.v,
          alive: bot.alive, spawn: { x: bot.x, z: bot.z, yaw: bot.team === 'red' ? Math.PI : 0 } });
      } else if (G.mode) addRemote(bot);
    }
    if (!G.mode || !name) return;
    hud.hint(bot ? t('msg.leftFor', { name, bot: bot.name }) : t('msg.left', { name }), 3200);
  });
  net.on('protoState',m=>{if(alive())G.protoSnapshot=m;});
  net.on('protoInventory',m=>{if(alive()&&m.id===net.id)prototypeInventory(m);});
  net.on('protoEvent',m=>{if(alive())prototypeEvent(m);});
  net.on('snap', (m) => {
    if (!alive()) return;
    G.onlinePhase = m.phase || G.onlinePhase;
    if ((G.onlinePhase === 'intro' || G.onlinePhase === 'countdown') &&
        Number.isFinite(Number(m.startsIn))) {
      G.onlineStartAt = Date.now() / 1000 + Math.max(0, Number(m.startsIn));
    } else if (G.onlinePhase === 'playing') G.onlineStartAt = 0;
    if (m.lives) G.scores = m.lives;
    if (m.wins) G.onlineWins = m.wins;
    for (const p of m.ps || []) {
      if (p.id === net.id) {
        // G.selfAlive: el golpe mortal ya sonó con 'death' — sin el guard
        // sonaba hurt + shake + rumble sobre un jugador ya muerto
        if (p.hp < G.selfHp && G.selfAlive) {
          audio.hurt({ amount: G.selfHp - p.hp }); shoulderCam.addShake(0.4); input.pad.rumble(140, 0.5, 0.7);
          // el snapshot no dice quién pegó: fuente confirmada o, si no llega, inferida
          onlineHpDrop(G.selfHp - p.hp);
        }
        G.selfHp = p.hp;
        reconcileLocalOnlineSnapshot(p);
        continue;
      }
      const hosted = G.onlineBots?.botById(p.id);
      if (hosted) {
        hosted.hostedPose = p;
        hosted.hostedPoseAt = performance.now();
        hosted.hp = p.hp; hosted.protT = p.inv ? Math.max(hosted.protT, .12) : 0;
        continue;
      }
      const r = G.remotes.get(p.id);
      if (r) { r.push(p); r.alive = !!p.alive; r.hp = p.hp; }
    }
  });
  net.on('fire', (m) => {
    if (!alive() || m.id === net.id || G.onlineBots?.botById(m.id)) return;
    if (m.w !== 'melee') G.onlineBots?.noteShot?.(m.id); // los bots alojados lo oyen
    // validar: un cliente malicioso podía mandar o/p malformados y reventar
    // el handler de todos los demás
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.p)) return;
    const o = new THREE.Vector3(...m.o), p = new THREE.Vector3(...m.p);
    const r = G.remotes.get(m.id);
    r?.applyFirePose(m.fp, m.w === 'melee' ? null : m.w);
    // un melee ajeno no es un disparo: la animación viaja por el estado y el
    // resultado por 'death'; sin trazadora, flash ni sonido de bala
    if (m.w === 'melee') return;
    // bala enemiga cuya trayectoria cruzó el cuerpo: candidata (inferida) a
    // origen del daño del próximo snapshot; nunca pisa una fuente confirmada
    if (r && r.team !== G.team && G.player && G.selfAlive) {
      const py = G.player.y || 0;
      if (shotBodyDistance(o, p, G.player.pos.x, py + 0.1, py + 1.8, G.player.pos.z) < 0.75) {
        noteHurtSource(false, o.x, o.z, m.id);
      }
    }
    // `o` es el origen de VALIDACIÓN (en ADS, la cámara del tirador ~2.2 m
    // por detrás de su cuerpo): fogonazo, trazadora, casquillo y sonido salen
    // del cañón del rig observado hacia el endpoint transmitido.
    const vo = remoteMuzzle(r, o);
    effects.tracer(vo, p, false, { team: r?.team, weapon: m.w });
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
          effects.impact(point, contact.normal, contact.surface, { origin: o });
          audio.impact(point, contact.surface);
        }
      }
    }
    effects.muzzleFlash(vo, m.w === 'shotgun' || !!TUNING.weapons[m.w]?.special, { weapon: m.w, to: p, team: r?.team });
    // el segmento disparo→impacto ya llega por red: basta para el silbido
    const remoteShot = { position: vo, end: p, enemy: r ? r.team !== G.team : true };
    audio.gun(m.w, remoteShot);
  });
  net.on('correction', (m) => {
    if (!alive() || !G.player || ![m.x, m.y, m.z].every(Number.isFinite)) return;
    // Solo llega cuando el servidor rechazó un desplazamiento físicamente
    // imposible. Limpiar momentum evita enviar de nuevo el mismo salto.
    G.player.pos.x = m.x; G.player.pos.z = m.z; G.player.y = m.y;
    G.player.vel.x = 0; G.player.vel.z = 0; G.player.vy = 0;
    if(m.reason!=='stun'){G.player.cover = null; G.player.coverEntry = null;}
  });
  net.on('hitConfirm', (m) => {
    if (!alive()) return;
    if (m.w === 'bazooka' || m.w === 'frag') {
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
      const ctx = { weapon: m.w, explosionPoint: m.ep };
      if (victimSelf) noteHurtSource(true, +m.ep[0] || 0, +m.ep[2] || 0, m.from);
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
    // el atacante remoto conectó: su gesto acorta la recuperación (remote.js)
    if (m.from !== net.id) G.remotes.get(m.from)?.applyMeleeHit?.();
    const victimPos = victimSelf ? G.player?.pos
      : victimRemote ? victimRemote
      : victimBot?.pos;
    const victimYaw = victimSelf ? G.player?.yaw
      : victimRemote ? victimRemote.yaw
      : victimBot?.yaw;
    const victimRig = victimSelf ? G.rig : (victimRemote?.rig || victimBot?.rig);
    // aturdimiento decidido por el servidor
    if (victimSelf && attacker) {
      const ap = attacker.pos || attacker;
      noteHurtSource(true, ap.x, ap.z, m.from);
    }
    if (+m.dz > 0) {
      if (victimSelf) { G.kickDaze = +m.dz; G.kickDazeImmune = +m.dz + TUNING.melee.dazeImmunity; }
      else if (victimBot) victimBot.dazeT = +m.dz;
    }
    // El atacante ya predijo la reacción local para que el golpe no espere al
    // ping. Los demás clientes la reproducen desde la confirmación autoritativa.
    if (m.from !== net.id && victimRig && attacker && victimPos) {
      const ap = attacker.pos || attacker;
      const dx = victimPos.x - ap.x, dz = victimPos.z - ap.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      const side = (dx * Math.cos(victimYaw || 0) + dz * -Math.sin(victimYaw || 0)) / len;
      victimRig.hitReact(side, Math.min(1.2, (+m.dmg || 60) / 50), 'kick', (+m.dmg || 0) >= TUNING.melee.backstabDmg);
    }
    if (m.from !== net.id) {
      const team = victimSelf ? G.team : (victimRemote?.team || victimBot?.team || 'blue');
      effects.meleeImpact(point, TEAM_HEX[team]);
      audio.meleeImpact({ position: point }, false);
    }
  });
  net.on('rocket', (m) => {
    if (G.mode !== 'online' || m.id === net.id) return;
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.d) || typeof m.rid !== 'string') return;
    const source = G.remotes.get(m.id) || G.onlineBots?.botById?.(m.id);
    source?.applyFirePose?.(m.fp, 'bazooka');
    // el lanzamiento ajeno sonaba mudo online: solo se oía la explosión
    // (los bots alojados aquí ya sonaron en su botmatch local)
    if (!G.onlineBots?.botById?.(m.id)) audio.gun('bazooka', { position: { x: m.o[0], y: m.o[1], z: m.o[2] } });
    rockets.fire(
      { x: m.o[0], y: m.o[1], z: m.o[2] },
      new THREE.Vector3(m.d[0], m.d[1], m.d[2]).normalize(),
      false,
      source ? { id: m.id, team: source.team } : null,
      m.rid,
      true,
    );
  });
  net.on('rocketAck', (m) => {
    const okVec = (v) => Array.isArray(v) && v.length === 3 &&
      v.every((n) => typeof n === 'number' && isFinite(n));
    if (typeof m.rid !== 'string') return;
    if (typeof m.cid === 'string' && rockets.bindId(m.cid, m.rid)) return;
    if (!okVec(m.o) || !okVec(m.d)) return;
    const source = G.onlineBots?.botById?.(m.id);
    rockets.fire({ x: m.o[0], y: m.o[1], z: m.o[2] },
      new THREE.Vector3(...m.d).normalize(), true,
      source ? { id: m.id, team: source.team } : null, m.rid, true);
  });
  net.on('rocketReject', (m) => {
    if (typeof m.cid === 'string') rockets.remove(m.cid);
  });
  net.on('rocketClear', () => rockets.clear());
  net.on('rocketBoom', (m) => {
    const okVec = (v) => Array.isArray(v) && v.length === 3 &&
      v.every((n) => typeof n === 'number' && isFinite(n));
    if (typeof m.rid !== 'string' || !okVec(m.p)) return;
    rockets.remove(m.rid);
    const normal = okVec(m.n) ? { x: m.n[0], y: m.n[1], z: m.n[2] } : undefined;
    const visual = okVec(m.vp) ? { x: m.vp[0], y: m.vp[1], z: m.vp[2] }
      : { x: m.p[0], y: m.p[1], z: m.p[2] };
    explodeRocket({ x: m.p[0], y: m.p[1], z: m.p[2] }, false, null, {
      kind: m.kind, direct: !!m.direct, targetId: m.target,
      normal, surface: m.surface, visualPos: visual,
    });
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
    audio.specialTaken();
    hud.hint(t('msg.specialTaken', {
      weapon: t(TUNING.weapons[m.wep].nameKey),
      removed: t(TUNING.weapons[removed].nameKey),
    }), 2400);
    input.pad.rumble(80, 0.4, 0.6);
  });
  net.on('nade', (m) => {
    if (G.mode !== 'online' || m.id === net.id) return;
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.v) || typeof m.nid !== 'string') return;
    // gesto de suelta: un jugador lo recibe por su evento `throwRelease`
    // (s.ev); solo un bot (sin eventos) lo toma de aquí → una suelta por gesto
    const thrower = G.remotes.get(m.id);
    if (thrower?.bot) thrower.applyThrow?.();
    // El vuelo remoto es visual; solo smokeStart puede crear la nube real.
    smoke.throwNade(
      { x: m.o[0], y: m.o[1], z: m.o[2] },
      { x: m.v[0], y: m.v[1], z: m.v[2] },
      { id: m.nid, authoritative: true },
    );
  });
  net.on('nadeAck', (m) => {
    if (m.id === net.id && typeof m.cid === 'string') G.weapons.confirmThrow(m.cid);
    const okVec = (v) => Array.isArray(v) && v.length === 3 &&
      v.every((n) => typeof n === 'number' && isFinite(n));
    if (typeof m.nid !== 'string') return;
    if (typeof m.cid === 'string' && smoke.bindId(m.cid, m.nid)) return;
    if (!okVec(m.o) || !okVec(m.v)) return;
    smoke.throwNade(
      { x: m.o[0], y: m.o[1], z: m.o[2] },
      { x: m.v[0], y: m.v[1], z: m.v[2] },
      { id: m.nid, authoritative: true },
    );
  });
  net.on('nadeReject', (m) => {
    if (typeof m.cid === 'string') smoke.remove(m.cid);
    // reembolso UNA vez y solo de una suelta PROPIA pendiente: weapons
    // reconoce el id (`p:<yo>:<id>`); un bot, otro jugador, un id repetido o
    // ya confirmado no acredita nada (decisión 18)
    if (m.bot || (m.id != null && m.id !== net.id)) return;
    if (typeof m.cid === 'string') G.weapons.refundThrow(m.cid, { life: m.life });
  });
  net.on('server-outdated', () => showServerOutdated());
  net.on('smokeStart', (m) => {
    const okVec = (v) => Array.isArray(v) && v.length === 3 &&
      v.every((n) => typeof n === 'number' && isFinite(n));
    if (typeof m.nid !== 'string' || !okVec(m.p)) return;
    smoke.activate(m.nid, { x: m.p[0], y: m.p[1], z: m.p[2] });
  });
  net.on('smokeEnd', (m) => {
    if (typeof m.nid === 'string') smoke.remove(m.nid);
  });
  net.on('smokeClear', () => smoke.clear());
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
      weapon: m.w, rocketDeathLevel: ['bazooka','frag'].includes(m.w) ? m.ex : 0,
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
    hud.kill(m.kn, m.kt, m.vn, m.vt, { weapon: m.w, head: m.part === 'head',
      local: m.target === net.id ? 'victim' : m.from === net.id ? 'killer' : null });
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
      G.respawnT = Number.isFinite(Number(m.respawn))
        ? Math.max(0, Number(m.respawn)) : TUNING.combat.respawnTime;
      G.selfRespawnPending = G.respawnT > 0;
      G.weapons.cancelActions(); audio.cancelHandling();
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
    } else if (m.from === net.id) {
      // confirmación SOLO de bajas propias (antes sonaba en cualquier muerte)
      audio.kill(m.part === 'head');
      hud.hitmarker('kill');
      hud.killConfirm(m.vn, m.w, m.part === 'head');
    }
  });
  net.on('crate', (m) => {
    if (!alive()) return;
    G.crates?.setState(m.i, !!m.up);
    // el refill llega SOLO con la confirmación del server (rellenar al pisar
    // la caja + reintento de 1.5s daba munición infinita si otro la ganó)
    if (!m.up && m.by === net.id && G.weapons) {
      G.weapons.refill();
      audio.crate();
      hud.hint(t('msg.ammoFull'), 1400);
      input.pad.rumble(60, 0.2, 0.3);
    }
  });
  // la vida viaja en 'life': 't' es el discriminador del protocolo (usarlo
  // de 8º argumento dejaba d.t = 'dropA' → NaN → arma invisible en online)
  net.on('dropA', (m) => { if (alive()) G.drops?.spawn(m.id, m.wep, m.x, m.z, m.team, m.mag || 0, m.res || 0, m.life ?? 8, m.y || 0); });
  net.on('dropUpdate', (m) => {
    const d = G.drops?.drops.get(m.id);
    if (d) { d.mag = m.mag; d.res = m.res; d.claimed = false; }
  });
  net.on('specialRespawn', (m) => {
    if (G.mode !== 'online' || G.onlinePhase !== 'playing' || !world.specialSpot || !TUNING.weapons[m.wep]?.special) return;
    const spot = world.specialSpot;
    specials.spawn(m.wep, spot.x, spot.z, world.groundHeight(spot, 0.4, 0.1));
  });
  net.on('dropR', (m) => { if (alive()) G.drops?.remove(m.id); });
  net.on('dropGive', (m) => {
    if (!alive()) return;
    const def = TUNING.weapons[m.wep];
    if (!def) return;
    let s = G.weapons.state[m.wep];
    if (m.replace === true && (m.slot === 0 || m.slot === 1)) {
      G.weapons.replaceSlot(m.slot, m.wep, m.mag, m.res);
      s = G.weapons.state[m.wep];
      s.mag = Math.min(def.mag, Math.max(0, m.mag || 0));
      s.reserve = Math.min(def.reserve, Math.max(0, m.res || 0));
      G.rig?.setWeapon?.(G.weapons.cur);
      audio.weaponPickup();
      hud.hint(t('msg.weaponRecovered', { weapon: t(def.nameKey) }), 1500);
      return;
    }
    if (!s) return;
    const total = m.amount || 0;
    const gained = Math.min(def.reserve, s.reserve + total) - s.reserve;
    s.reserve += gained;
    audio.ammoPickup();
    hud.hint(t('msg.bulletsOf', { count: gained, weapon: t(def.nameKey) }), 1500);
  });
  net.on('respawn', (m) => {
    if (!alive() || !G.player || !G.rig) return;
    if (m.id === net.id) {
      G.selfAlive = true;
      G.selfHp = TUNING.combat.hp;
      G.respawnT = 0;
      G.selfRespawnPending = false;
      G.player.respawn(m.spawn); newLife(m.life);
      G.weapons.reset(); audio.cancelHandling();
      G.rig.setWeapon('smg');
      exitSpectator();
      // El reset de fin de partida coloca al jugador antes de la presentación;
      // la protección empieza al terminar el 3…2…1, no 13 s antes.
      if (G.onlinePhase === 'playing') grantSpawnProtection();
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
    G.onlinePhase = 'intermission'; G.onlineStartAt = 0;
    G.onlineWins = m.wins || G.onlineWins;
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
    G.onlineStartAt = localStartDeadline(m, COUNTDOWN_TIME);
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
          G.selfRespawnPending = false;
          G.player.respawn(spawn); newLife(p.life); G.weapons.reset(); audio.cancelHandling(); exitSpectator();
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
// `team` separa pasos aliados (atenuados) de enemigos (presentes y nítidos).
function onDodgeCue(kind, x, y, z, dx, dz, team) {
  effects.dodgeCue(kind, x, y, z, dx, dz);
  if (kind === 'start') stepSound(x, z, 'dodge', y, team);
}

function stepSound(x, z, kind, y = 0, team = null) {
  if (!G.player) return;
  audio.footstep(kind, { position: { x, y: y + 0.22, z }, team });
}

// ---------- disparos ----------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
// Volumen de impacto = pose dibujada (hit-pose.js), no solo el nombre del
// estado: apuntando sobre cover bajo el estado sigue siendo cover_low pero
// el rig está de pie.
// Postura del jugador local con los campos de la red (contrato §1): la
// misma entrada para su volumen de impacto, su ojo (cámara) y el origen
// del tiro que valida el servidor.
function localPoseInput() {
  const p = G.player, ap = p.animParams();
  const pose = localPose(p, G.weapons?.cur, G.simClock);
  pose.p = pose.pitch;
  pose.ae = p.cameraYawError();
  if (ap.state === 'mantle') pose.phase = ap.mantlePhase;
  return pose;
}
function localHitFields() {
  const p = G.player;
  return hitFields(localPoseInput(), p.pos.x, p.y, p.pos.z, p.yaw);
}
const remoteHitFields = (r) => hitFields(r.hitPoseInput(), r.x, r.y ?? 0, r.z, r.yaw);

function currentTargets() {
  if (G.mode === 'practice') return G.dummies ? G.dummies.targets() : [];
  if (G.mode === 'bots') return G.botMatch ? G.botMatch.targets() : [];
  const out = [];
  if (G.mode === 'online' && G.onlineBots) out.push(...G.onlineBots.targets());
  for (const r of G.remotes.values()) {
    if (r.team !== G.team) out.push({
      id: r.id, x: r.x, z: r.z, y: r.y ?? 0, alive: r.alive,
      ...remoteHitFields(r), protected: !!r.inv,
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
    // `protected`: la espoleta ignora la protección de spawn, como el servidor
    for (const b of G.botMatch.bots) {
      if (b.alive) out.push({ id: b.id, x: b.pos.x, z: b.pos.z, y: b.y, alive: true, team: b.team, protected: b.protT > 0 });
    }
    if (G.selfAlive && G.player && !G.player.dead) {
      out.push({ id: 'player', x: G.player.pos.x, z: G.player.pos.z, y: G.player.y, alive: true, team: G.team,
        protected: G.spawnProt > 0 });
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

function staticHitDistance(origin, dir, maxDist) {
  // raycastHit incluye suelo, helipuerto y rampas; raycast es el fallback
  // simplificado usado por locomoción. La retícula debe seguir balística.
  return world.raycastHit?.(origin, dir, maxDist)?.t ??
    world.raycast(origin, dir, maxDist) ?? maxDist;
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
  localPowerRespawn.deadline = null;
  localPowerTime = 0;
  const spot = world.specialSpot;
  if (!spot) { specials.clear(); return; }
  const wep = G.specialRound % 2 === 1 ? 'sniper' : 'bazooka';
  specials.spawn(wep, spot.x, spot.z, world.groundHeight({ x: spot.x, z: spot.z }, 0.4, 0.1));
}

// Explosión del cohete: splash con caída por distancia, línea de efecto (no
// atraviesa paredes) y AUTODAÑO — dispararla cerca es un riesgo real.
function explodeRocket(pos, mine = true, owner = null, boomInfo = null) {
  const d = TUNING.weapons.bazooka;
  G.blastDebug?.show(pos,d,prototypeActors(),prototypeBlocked);
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
  // Online explosions are entirely server-owned. Offline uses the same body
  // samples and damage profile; presentation never bypasses map collision.
  if (!G.mode || !mine || G.mode === 'online') return;
  const ownerId=owner?.id??'player',team=owner?.team??G.team;
  for(const target of prototypeActors()){
    const self=target.id===ownerId;
    if(!target.alive||target.protected||(target.team===team&&!self))continue;
    const direct=!!boomInfo?.direct&&boomInfo?.targetId===target.id;
    const result=evaluateBlast(d,pos,target,prototypeBlocked,{self,direct});
    const dmg=result.damage;if(dmg<=.01)continue;
    const ctx={weapon:'bazooka',distance:result.distance,damage:dmg,part:'body',
      direct,explosionPoint:{x:pos.x,y:pos.y,z:pos.z},gib:false};
    if(target.id==='player'){
      if(G.mode==='practice')continue;
      const died=damagePlayerLocal(dmg,owner?.name??G.name,ctx.explosionPoint,ctx);
      if(died){if(self)G.botMatch?.playerSelfDeath();else G.botMatch?._onDeath('player',ownerId,false,ctx);}
    }else if(G.botMatch){
      const killed=G.botMatch.damageBot(target.id,dmg,ownerId,false,self,ctx);
      if(!owner&&killed!==null){hud.hitmarker(killed?'kill':'body');if(!killed)audio.hit();}
    }else if(G.dummies){
      effects.blood(_v3.set(target.x,(target.y??0)+.9,target.z),TEAM_HEX.blue);
      const killed=G.dummies.damage(target.id,dmg,dd=>{
        dd.rig.setDeathContext({...ctx,impact:{x:dd.x-pos.x,z:dd.z-pos.z},
          power:Math.min(1,dmg/55),vel:{x:0,z:0},state:'idle',rocketDeathLevel:rocketDeathLevel(ctx)});
        rocketDeathFx({x:dd.x,y:0,z:dd.z},'blue',ctx,0);
        G.scores.red++;hud.score(G.scores.red,G.scores.blue);hud.kill(G.name,'red',dd.name,'blue',{weapon:'bazooka',local:'killer'});hud.killConfirm(dd.name,'bazooka');audio.kill();
      });
      hud.hitmarker(killed?'kill':'body');if(!killed)audio.hit();
    }
  }
}

// Lanzar la granada de humo: sale de la mano con arco balístico. La nube la
// gestiona SmokeSystem (rebotes, delay, disipación). Si era la última, el
// personaje vuelve solo a su primaria.
function prototypeActors(){
  const p=G.player,localId=G.net?.id??'player';
  const out=p?[{id:localId,x:p.pos.x,y:p.y,z:p.pos.z,team:G.team,alive:G.selfAlive&&!p.dead,protected:G.spawnProt>0,st:p.animState(),blastH:hitAimHeights(localHitFields().hitVol).blast}]:[];
  const bots=G.mode==='online'?G.onlineBots?.bots:G.botMatch?.bots;
  const bm=G.mode==='online'?G.onlineBots:G.botMatch;
  for(const b of bots??[])out.push({id:b.id,x:b.pos.x,y:b.y,z:b.pos.z,team:b.team,alive:b.alive,protected:b.protT>0,st:b.animState(),
    ...(bm?._hitFields&&b.alive?{blastH:hitAimHeights(bm._hitFields(b).hitVol).blast}:{})});
  if(G.mode==='practice')for(const a of G.dummies?.targets()??[])out.push({...a,y:a.y??0,team:'blue',alive:a.alive!==false});
  if(G.mode==='online')for(const r of G.remotes.values())out.push({...r,protected:!!r.inv});
  return out;
}
function prototypeInventory(item){
  if(!G.weapons)return;const w=G.weapons,k=item.kind;
  if(!['frag','stun'].includes(k))return;
  const slot=k==='frag'?3:2;
  const gained=w.slots[slot]!==k||item.count>(w.state[k]?.mag??0);
  if(w.slots[slot]!==k)w.replaceSlot(slot,k,item.count,0);
  w.state[k].mag=item.count;w.state[k].reserve=0;
  // La rueda de armas solo avisa al RECOGER. Abrirla también al lanzar tapaba
  // el centro de la pantalla justo cuando hay que seguir la granada.
  if(gained)hud.weaponWheel(w);
}
function prototypeEvent(e){
  if(e.kind==='explosion'){
   G.blastDebug?.show(e.p,TUNING.weapons.frag,prototypeActors(),prototypeBlocked);
   const p=new THREE.Vector3(e.p.x,e.p.y,e.p.z);
   effects.rocketExplosion(p,{direct:false,floorY:world.groundHeight(e.p,.1,e.p.y)});audio.explosion({position:p});
  }else if(e.kind==='stun'){audio.electric({position:e.p});}
  else if(e.kind==='fuse')audio.grenadeTick({position:e.p});
  else if(e.kind==='launch'){
    // la suelta PROPIA ya suena por el evento throwRelease (audio.attachWeapons): una sola vez
    const mine=e.owner===(G.net?.id??'player');
    // frag/aturdidora propia aceptada por el servidor: ya no es reembolsable
    if(mine&&typeof e.cid==='string')G.weapons.confirmThrow?.(e.cid);
    if(!mine){if(e.weapon==='stun')audio.electric({position:e.p});else audio.throwNade({position:e.p});}
    // la frag de un jugador anima por sus eventos de lanzamiento (no es un
    // disparo: sin `firing`); la aturdidora sí es un tiro
    const remote=G.remotes.get(e.owner);if(e.weapon==='stun'||remote?.bot)remote?.applyFirePose(null,e.weapon);
    if(remote&&e.weapon==='stun'){effects.muzzleFlash(new THREE.Vector3(e.p.x,e.p.y,e.p.z));remote.rig.kick(.2);}
  }
}
function prototypeBlocked(a,b){
 const origin=new THREE.Vector3(a.x,a.y,a.z),dir=new THREE.Vector3(b.x-a.x,b.y-a.y,b.z-a.z),len=dir.length();
 return len>.02&&world.raycast(origin,dir.normalize(),len-.015)!==null;
}
function updatePrototypes(dt){
 if(!G.mode||!G.player)return;
 G.protoView??=new PrototypeView(scene);
 if(import.meta.env.DEV&&new URLSearchParams(location.search).has('blastDebug'))G.blastDebug??=new BlastDebug(scene);
 G.blastDebug?.update(dt);
 if(G.mode!=='online'){
  G.protoEngine??=new CombatPrototypes({actors:prototypeActors,physics:world,blocked:prototypeBlocked,
   experimental:new URLSearchParams(location.search).get('combatPrototype')==='1',event:prototypeEvent,
   inventory:(id,item)=>{if(id==='player')prototypeInventory(item);},
   damage:(owner,id,dmg,ctx)=>{
    if(id==='player'){
     const died=damagePlayerLocal(dmg,G.name,ctx.explosionPoint,ctx);
     if(died)G.botMatch?.playerSelfDeath();
    }else if(G.botMatch)G.botMatch.damageBot(id,dmg,owner,false,false,ctx);
    else G.dummies?.damage(id,dmg,dd=>{dd.rig.setDeathContext(ctx);});
   }});
  const active=G.mode==='practice'||G.botMatch?.phase==='playing';
  G.protoEngine.setRound(`${world.layout}:${G.botMatch?.round??0}`,active);
  G.protoEngine.tick(dt);G.protoSnapshot=G.protoEngine.snapshot();
 }
 const snap=G.protoSnapshot,states=snap?.active?snap.states??[]:[];
 G.protoStun=states.find(s=>s.id===(G.net?.id??'player'))?.remaining??0;
 if(!G.selfAlive||G.player.dead)G.protoStun=0;
 if(G.rig)G.rig.stunned=G.protoStun>0;
 for(const d of G.dummies?.list??[])d.rig.stunned=d.alive&&(states.find(s=>s.id===d.id)?.remaining??0)>0;
 for(const b of (G.mode==='online'?G.onlineBots?.bots:G.botMatch?.bots)??[]){
  b.protoStunned=b.alive&&(states.find(s=>s.id===b.id)?.remaining??0)>0;b.rig.stunned=b.protoStunned;
 }
 for(const r of G.remotes.values())if(r.rig)r.rig.stunned=r.alive&&(states.find(s=>s.id===r.id)?.remaining??0)>0;
 G.protoView.update(snap,prototypeActors(),performance.now()/1000);
}
function prototypePickup(){
 if(!G.protoSnapshot?.active||!G.selfAlive||G.protoStun>0)return false;
 const p=G.player;
 if(G.weapons.swapping||G.weapons.reloading||G.throwT>0||['melee','dodge','dive','slide','mantle'].includes(p.state))return false;
 const item=G.protoSnapshot.pickups.find(a=>a.count>0&&Math.hypot(a.x-p.pos.x,a.z-p.pos.z)<1.15&&Math.abs(a.y-p.y)<.7);
 if(!item)return false;
 const w=G.weapons,slot=item.kind==='frag'?3:2;
 if(item.kind==='frag'&&w.slots[3]==='frag'&&w.state.frag.mag>=2)return false;
 if(item.kind==='stun'&&w.slots[2]==='stun'&&w.state.stun.mag>0)return false;
 const manual=w.slots[slot]!==item.kind||item.kind==='stun';
 const button=input.lastDevice==='pad'?padBtnName(BINDS.pad.pickup):keyLabel(BINDS.kb.pickup);
 hud.pickupPrompt(manual?`[${button}] ${t('weapon.'+w.slots[slot])} → ${item.count} × ${t('weapon.'+item.kind)}`:`+ ${item.count} × ${t('weapon.'+item.kind)}`);
 if(!manual||input.pickupPressed){
  input.pickupPressed=false;
  if(G.mode==='online'){
   if((G.protoClaimAt??0)<performance.now()){G.net.send({t:'protoClaim',id:item.id,manual});G.protoClaimAt=performance.now()+350;}
  }else G.protoEngine.claim('player',item.id,manual);
 }
 return true;
}
// frag / aturdidora: en línea viajan con la muestra del tiro (`fs`)
function prototypeFire(kind,o,d,shot=null){
 // cid del lanzamiento (frag: el id de la suelta) para conciliar un rechazo
 const cid=G.mode==='online'?`p:${G.net?.id||'local'}:${shot?.throwId??`s${++G.smokeSeq}`}`:null;
 if(G.mode==='online')G.net.send({t:'protoFire',kind,cid,o:[o.x,o.y,o.z],d:[d.x,d.y,d.z],
  ...(G.net.shotSample?{fs:G.net.shotSample(G.player,kind,shot)}:{})});
 else G.protoEngine?.fire('player',kind,o,d);
}
function throwSmoke(shot) {
  const p = G.player;
  const d = TUNING.weapons.grenade;
  G.rig.setTransform(p.pos.x, p.pos.z, p.yaw, p.y);
  // El bote sale delante del OJO de la muestra de la suelta (nunca al otro
  // lado de la geometría: ojo→salida libre, lo que exige el servidor) hacia
  // el punto que promete el centro de pantalla en ese instante.
  const muzzle = fpCam.launchPoint(_v1, shot);
  const throwGuide = resolveShot(world, currentTargets(), shot.origin, shot.dir, 60, null);
  const dir = new THREE.Vector3().copy(throwGuide.point).sub(muzzle);
  // guía detrás de la mano o demasiado cerca: manda la dirección de la mira
  if (dir.dot(shot.dir) < 1.2) dir.copy(shot.dir);
  else dir.normalize();
  if(G.weapons.cur==='frag'){
    prototypeFire('frag',muzzle,dir,shot);input.pad.rumble(45,.25,.35);G.rig.kick(.5);
    return; // la selección tras el último bote la decide Weapons (vuelta prevista)
  }
  const o = { x: muzzle.x, y: muzzle.y, z: muzzle.z };
  const v = {
    x: dir.x * d.throwSpeed,
    y: dir.y * d.throwSpeed + d.throwUp,
    z: dir.z * d.throwSpeed,
  };
  const cid = G.mode === 'online' ? `p:${G.net?.id || 'local'}:${shot.throwId ?? `s${++G.smokeSeq}`}` : null;
  smoke.throwNade(o, v, cid ? { id: cid, authoritative: true } : undefined);
  audio.throwNade();
  input.pad.rumble(45, 0.25, 0.35);
  G.rig.kick(0.5);
  G.net?.send({
    t: 'nade', o: [o.x, o.y, o.z], v: [v.x, v.y, v.z],
    ...(cid ? { cid } : {}),
    ...(G.net.shotSample ? { fs: G.net.shotSample(p, 'grenade', shot) } : {}),
  });
  // sin botes restantes: la selección siguiente (vuelta de la granada
  // rápida o arma anterior) la decide Weapons, no main
}

// Golpe melee: arco frontal corto. Pega al enemigo MÁS CERCANO dentro del
// arco (un objetivo por golpe), con línea al pecho para no golpear a través
// de paredes.
G.kickPushes = [];
function resolveMelee() {
  const ml = TUNING.melee;
  const p = G.player;
  // R6: selección, alcance y barrido desde el OJO de la muestra del golpe,
  // con las MISMAS funciones que el servidor (combat/melee-reach.js): un
  // marcador contra un rival agachado o más bajo es daño de verdad.
  const shot = captureShot(); // fs.w conserva el arma equipada incluso en el primer golpe de la vida
  const eye = [shot.origin.x, shot.origin.y, shot.origin.z];
  const aimYaw = Math.atan2(-shot.dir.x, -shot.dir.z);
  let best = null;
  for (const tg of currentTargets()) {
    if (tg.alive === false || tg.protected) continue;
    const vol = tg.hit ?? placeHitPose(tg.hitVol ?? (tg.crouch ? CROUCH : STAND), tg.x, tg.y ?? 0, tg.z, 0);
    const pt = meleeTargetPoint(eye, vol, aimYaw);
    // criterio ÚNICO con el servidor: centro del blanco (0.9 m sobre los pies)
    // a ≤ 58° de la MIRADA y contacto a alcance desde el ojo
    if (!pt || !meleeHitOk(eye, aimYaw, pt.point, [tg.x, (tg.y ?? 0) + 0.9, tg.z])) continue;
    // barrido ojo → punto contra el mapa
    _v2.set(pt.point[0] - eye[0], pt.point[1] - eye[1], pt.point[2] - eye[2]);
    const len = _v2.length();
    if (len > 0.05 && world.raycast(shot.origin, _v2.multiplyScalar(1 / len), len, 0) !== null) continue;
    const dx = tg.x - p.pos.x, dz = tg.z - p.pos.z, dist = Math.hypot(dx, dz);
    const lh = Math.hypot(pt.point[0] - eye[0], pt.point[2] - eye[2]) || 1;
    const dot = ((pt.point[0] - eye[0]) * -Math.sin(aimYaw) + (pt.point[2] - eye[2]) * -Math.cos(aimYaw)) / lh;
    // lo más centrado gana sobre una diferencia mínima de distancia
    const score = pt.dist + (1 - dot) * 0.42;
    if (!best || score < best.score) best = { tg, dist, dx, dz, dot, score, point: pt.point };
  }
  if (!best) {
    const surface = kickWorldContact(world, shot.origin, shot.dir);
    if (surface) effects.meleeWorld(surface.point, surface.normal);
    return { connected: false, killed: false, world: !!surface };
  }
  const { tg, dist } = best;
  _v1.copy(shot.origin);
  const targetPoint = _v3.set(best.point[0], best.point[1], best.point[2]);
  // POR LA ESPALDA (letal) > PLACAJE en sprint > golpe normal
  const tyaw = G.mode === 'practice' ? G.dummies?.list?.find((d) => d.id === tg.id)?.yaw
    : G.mode === 'bots' ? G.botMatch?.bots.find((b) => b.id === tg.id)?.yaw
    : (G.remotes.get(tg.id)?.yaw ?? G.onlineBots?.botById(tg.id)?.yaw);
  const backstab = Number.isFinite(tyaw) && dist > 0.05 &&
    (best.dx * -Math.sin(tyaw) + best.dz * -Math.cos(tyaw)) / dist > Math.cos(ml.backstabArcDeg * Math.PI / 360);
  const tackle = !!p.meleeTackle;
  const dmg = backstab ? ml.backstabDmg : tackle ? ml.tackleDmg : ml.dmg;
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
    tg.rig?.hitReact?.(best.dot < 0.75 ? Math.sign(best.dx) : 0, tackle ? 1.2 : 1, 'kick', backstab);
    G.dummies.recoil?.(tg.id, best.dx, best.dz, tackle ? ml.tackleShove : 0.45);
    if (!(performance.now() < (tg.dazeImmuneUntil ?? 0))) {   // los muñecos no atacan: solo se marca
      const t = (tackle ? ml.tackleDaze : ml.dazeTime) * 1000;
      tg.dazeUntil = performance.now() + t; tg.dazeImmuneUntil = tg.dazeUntil + ml.dazeImmunity * 1000;
    }
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
      hud.kill(G.name, 'red', d.name, 'blue', { weapon: 'melee', local: 'killer' });
      hud.killConfirm(d.name, 'melee');
      audio.kill();
    });
    if (!killed) audio.hit();
  } else if (G.mode === 'bots' && G.botMatch) {
    const result = G.botMatch.damageBot(tg.id, dmg, 'player', false, false, ctx);
    if (result !== null) { connected = true; killed = result; if (!killed) audio.hit(); }
    if (connected && !killed) {
      // la patada desplaza al rival (repartido en unas décimas) y encaja el
      // golpe; la de sprint además lo saca de su cobertura
      const b = G.botMatch.bots.find((x) => x.id === tg.id);
      if (b) {
        const reach = tackle ? ml.tackleShove : 0.45;
        G.kickPushes.push({ b, x: best.dx / dist * reach, z: best.dz / dist * reach });
        b.rig?.hitReact?.(best.dot < 0.75 ? Math.sign(best.dx) : 0, tackle ? 1.2 : 1, 'kick', backstab);
        if (!(b.dazeImmuneT > 0)) { b.dazeT = tackle ? ml.tackleDaze : ml.dazeTime; b.dazeImmuneT = b.dazeT + ml.dazeImmunity; }
        if (tackle && b.cover) { b.cover = null; b.state = 'advance'; }
      }
    }
    victimTeam = tg.team || 'blue';
  } else if (G.net) {
    const r = G.remotes.get(tg.id);
    const b = G.onlineBots?.botById(tg.id);
    if ((r || b) && !r?.inv && !(b?.protT > 0)) {
      connected = true;
      victimTeam = r?.team || b.team;
      (r?.rig || b?.rig)?.hitReact?.(best.dot < 0.75 ? Math.sign(best.dx) : 0, tackle ? 1.2 : 1, 'kick', backstab);
      // el golpe viaja como disparo validable de corto alcance + su claim
      // origen = ojo de la muestra del golpe (RED §3: el servidor lo rehace desde ahí)
      G.net.fire(shot.origin, point, 'melee', [], G.player, shot);
      G.net.hit(tg.id, dmg, 'body', false, point);
    }
  }
  if (connected) {
    effects.meleeImpact(point, TEAM_HEX[victimTeam], impactDir);
    hud.hitmarker(killed ? 'kill' : 'body');
    input.pad.rumble(killed ? 115 : 85, 0.58, killed ? 0.95 : 0.78);
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
// Relevo del scope (ARMAS-2): el scope entra cuando el arma termina de
// subir a la cara (scopeIn01 del viewmodel ≥ 0.98); entretanto se ve el arma
// subiendo y el tiro lleva la dispersión de cadera.
function scopeEngaged() {
  if (!sniperScopeActive()) return false;
  // exige un valor de alineación DISPONIBLE: sin viewmodel activo (o sin
  // medida) la mira no entra — tampoco pegado a un muro (decisión 17)
  const vm = firstPerson.fp2?.active ? firstPerson.fp2.vm : null;
  if (!vm || vm.scopeAvailable?.() === false) return false;
  const k = vm.scopeIn01?.();
  return Number.isFinite(k) && k >= 0.98;
}
function sniperScopeActive() {
  const p = G.player, w = G.weapons;
  return !!(G.mode && p && w && G.selfAlive && !p.dead && p.aim &&
    w.cur === 'sniper' && !w.swapping && !w.reloading && p.state !== 'melee' &&
    !G.spectator.active && !matchControlsLocked() && !menuIsOpen());
}

// Dispersión del arma en este instante (semiángulo, grados): la MISMA que
// dibuja la retícula (spreadFor + spreadState del controlador).
function shotSpreadState() {
  const st = G.player.spreadState();
  // sniper subiendo al scope: aún no es el tiro exacto de la mira
  if (G.weapons.cur === 'sniper' && st.aim && !scopeEngaged()) return { ...st, aim: false };
  return st;
}
function shotSpread() {
  return spreadFor(G.weapons.cur, shotSpreadState());
}

// Retroceso MECÁNICO (mueve la mira): el patrón del arma (weapons.lastKick);
// el golpe cosmético va aparte (fpCam.kick, × ajuste `shake`).
function applyMechanicalRecoil(k, def) {
  shoulderCam.addPitchRecoil(Number.isFinite(k?.pitch) ? k.pitch : def.recoil * 0.006);
  if (Number.isFinite(k?.yaw)) shoulderCam.addYawRecoil(k.yaw);
}

// ¿Puede disparar YA? La MISMA tabla que el servidor (fire-gates.js) sobre
// el estado del controlador Y el que viaja (en una transición pueden
// diferir: manda el más estricto); el retraso sprint→disparo va en
// p.fireAligned() (controller, con sprintFireDelay de la misma tabla).
function fireGateOpen(p) {
  const w = G.weapons.cur;
  return canFireInState(p.animState(), w) && canFireInState(localPose(p, w, G.simClock).st, w);
}

// MUESTRA DE TIRO: pose, ojo, dirección, arma y dispersión de UN instante,
// el subpaso en que el arma aprueba el tiro (tras mover al jugador). La usan
// el daño local, la traza y la red (`G.net.fire(..., sample)`): el servidor
// valida el origen contra ESA pose. El
// ojo es eyeWorld(pose) exacto (= la cámara, que no tiene desplazamiento
// cosmético); la dirección, la mira de ese instante (= la cruz).
function captureShot() {
  const p = G.player, look = shoulderCam;
  const pose = localPoseInput();
  const cp = Math.cos(look.pitch);
  const dir = new THREE.Vector3(-Math.sin(look.yaw) * cp, Math.sin(look.pitch), -Math.cos(look.yaw) * cp).normalize();
  // ojo = eyeWorld de la MISMA pose que viaja en `fs` (mismo reloj de
  // simulación): el servidor lo reconstruye exactamente igual. (p.eyeWorld()
  // del controlador evalúa la mezcla de transición con su propio reloj y en
  // la salida de sprint / slide se separaba > 2 cm: rechazo `fire-origin`.)
  const origin = fpCam.shotEye(pose, p, new THREE.Vector3());
  // x/y/z/yaw/ae/pose: los campos que client.js manda como `fs` (RED)
  const lk = G.weapons.lastKick;
  // `spreadAim`: el aim con el que se calculó la dispersión de ESTE tiro
  // (viaja como fs.sa; el servidor rehace el mismo cono)
  const sst = shotSpreadState();
  return { origin, dir, pose, weapon: G.weapons.cur, spread: spreadFor(G.weapons.cur, sst), spreadAim: sst.aim, scoped: scopeEngaged(),
    kick: lk ? { pitch: lk.pitch, yaw: lk.yaw } : null,
    aim: !!p.aim, pos: { x: p.pos.x, y: p.y ?? 0, z: p.pos.z }, x: p.pos.x, y: p.y ?? 0, z: p.pos.z,
    // `t` = reloj de SIMULACIÓN en segundos (el mismo de `s.ct`): viaja como fs.ct
    yaw: p.yaw, ae: pose.ae, t: G.simClock,
    // diagnóstico: el ojo del render anterior (lo que se usaba antes)
    prevEye: fpCam.eye.clone() };
}

// Boca VISUAL del arma (traza, fogonazo, casquillo): la del viewmodel, sin
// cruzar la pared que el ojo tiene delante. La bala no sale de aquí.
function visualMuzzle(out, eye) {
  viewModelMuzzle(out);
  const d = _v3.copy(out).sub(eye), len = d.length();
  if (len > 1e-3) {
    d.multiplyScalar(1 / len);
    const hit = world.raycast(eye, d, len + 0.04, 0);
    if (hit !== null && hit < len + 0.04) out.copy(eye).addScaledVector(d, Math.max(0, hit - 0.06));
  }
  return out;
}

// TODO disparo del jugador (cadera y ADS): hitscan desde el OJO por el rayo
// central con la dispersión del arma (DECISIONES §4). El origen que va al
// servidor es ese mismo ojo (dentro de la esfera de cabeza replicada). La
// boca del viewmodel solo pone el origen de los efectos. Cohete y stun salen
// delante del ojo hacia el punto que promete el centro de pantalla.
function fireShot(ray) {
  const w = G.weapons;
  // arma del REGISTRO (la del subpaso aprobado), no la que haya ahora
  const wep = ray.weapon, def = TUNING.weapons[wep];
  // los bots oyen los disparos del jugador (percepción: shotAt)
  G.botMatch?.noteShot?.(G.mode === 'online' ? G.net?.id : 'player');
  G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
  // la muestra del subpaso en que se aprobó el tiro (pose, ojo, rayo,
  // dispersión y mira de ESE instante); recalcular aquí mezclaría instantes
  G.lastShot = ray; // diagnóstico (pruebas)
  const aiming = ray.aim;
  const scoped = ray.scoped;
  const spread = ray.spread;
  const eye = ray.origin.clone();
  const baseDir = ray.dir.clone();
  const muzzle = visualMuzzle(_v1, eye).clone();

  if (wep === 'stun' || def.projectile) {
    const launch = fpCam.launchPoint(new THREE.Vector3(), ray);
    const guide = resolveShot(world, currentTargets(), eye, baseDir, def.range || 60, null);
    // R6: convergencia COMPARTIDA con el servidor (rocketAimDir: hacia el
    // punto del rayo central, como mínimo a 2 m)
    const cd = rocketAimDir([launch.x, launch.y, launch.z], [eye.x, eye.y, eye.z], [baseDir.x, baseDir.y, baseDir.z], guide.t);
    const dir = new THREE.Vector3(cd[0], cd[1], cd[2]);
    if (wep === 'stun') {
      prototypeFire('stun', launch, applySpread(dir, spread), ray);
      effects.muzzleFlash(muzzle); G.rig.kick(.2); fpCam.kick(0.2);
      return;
    }
    // bazooka: proyectil REAL, sin hitscan — el cohete hace el daño al explotar
    const cid = G.mode === 'online' ? `p:${++G.rocketSeq}` : null;
    // owner null = cohete propio (hitmarker/feed); la espoleta recibe aparte
    // la identidad y el bando del tirador para no fusar sobre él ni aliados
    rockets.fire({ x: launch.x, y: launch.y, z: launch.z }, dir,
      true, null, cid, G.mode === 'online', { id: G.net?.id ?? 'player', team: G.team });
    // El cohete se SIMULA desde la salida junto al ojo (lo que valida el
    // servidor), pero el propio jugador no debe ver un proyectil en la cara:
    // su malla se oculta hasta que se aleja OWN_ROCKET_HIDE m (el fogonazo
    // del tubo cubre esos primeros cuadros).
    const own = rockets.list[rockets.list.length - 1];
    if (own?.mesh) { own.mesh.visible = false; ownRocketsHidden.push({ r: own, x: launch.x, y: launch.y, z: launch.z }); }
    // replicar el proyectil: los demás clientes lo ven volar y explotar
    G.net?.rocket(launch, dir, cid, G.player, null, ray);
    effects.muzzleFlash(muzzle, true, { weapon: 'bazooka', dir });
    audio.gun(wep);
    input.pad.rumble(110, 0.6, 1.0);
    G.rig.kick(def.recoil * 0.5);
    fpCam.kick(def.recoil);
    applyMechanicalRecoil(ray.kick, def);
    return;
  }

  const targets = currentTargets();
  const damageOrigin = eye;
  const planeVec = null; // el ojo ya está en el plano del tirador
  const dmgByTarget = new Map();
  let anyPoint = null;
  const worldImpacts = [];

  // Punto del EJE CENTRAL del cartucho (rayo óptico del subpaso): es lo que
  // viaja como dirección del disparo; cada perdigón se valida contra él (con
  // la escopeta, el último perdigón llegaba a 32.8° de los otros)
  const axisPoint = resolveShot(world, targets, damageOrigin, baseDir, def.range, null).point;
  for (let i = 0; i < def.pellets; i++) {
    let dir = def.pellets > 1
      ? applyPelletPattern(baseDir, spread, i, def.pellets)
      // El scope promete exactamente su punto. Fuera del scope (incluido
      // el sniper en cadera) se conserva la dispersión del arma.
      : scoped ? baseDir.clone() : applySpread(baseDir, spread);
    // alcance de ESTE perdigón con su propia proyección (convenio compartido)
    const hit = resolveShot(world, targets, damageOrigin, dir,
      def.range + planeBaseAlong(planeVec, dir.toArray()), null);
    anyPoint = hit.point;
    // TRAZA: sale de la boca visual — pero si ese segmento cruzaría un borde
    // que la bala real (desde el ojo) libró, se pliega al eje del tiro para
    // no dar la impresión de atravesar la esquina.
    let tracerFrom = fxAboveGround(_fxO.copy(muzzle), G.player.y ?? 0); // solo efecto
    {
      const segLen = _v2.copy(hit.point).sub(muzzle).length();
      if (segLen > 0.4) {
        _v2.multiplyScalar(1 / segLen);
        if (staticHitDistance(muzzle, _v2, segLen - 0.15) < segLen - 0.16) {
          const tAxis = Math.max(0, _v2.copy(muzzle).sub(damageOrigin).dot(baseDir));
          tracerFrom = damageOrigin.clone().addScaledVector(baseDir, tAxis);
        }
      }
    }
    effects.tracer(tracerFrom, hit.point, scoped && wep === 'sniper', { team: G.team, weapon: wep });
    if (hit.kind === 'world') {
      effects.impact(hit.point, hit.normal, hit.surface, {
        origin: damageOrigin,
        emphasized: scoped && wep === 'sniper',
      });
      audio.impact(hit.point, hit.surface);
      worldImpacts.push(hit.point);
    }
    if (hit.kind === 'player') {
      // distancia de daño desde el PLANO del jugador, no desde la cámara
      // misma convención que el servidor (shooter-plane.js), por perdigón
      const dist = shooterPlaneDistance(damageOrigin.toArray(), hit.point.toArray(), planeVec);
      let dmg = def.dmg * damageFalloff(def, dist);
      if (hit.part === 'head') dmg *= def.headMult;
      const e = dmgByTarget.get(hit.id) || {
        dmg: 0, part: hit.part, dist, point: hit.point, pellets: 0,
      };
      e.dmg += dmg;
      e.pellets++;
      if (hit.part === 'head') e.part = 'head';
      dmgByTarget.set(hit.id, e);
    }
  }
  // feedback de disparo (flash grande + rumble fuerte para armas pesadas)
  // casquillo, boca y rebufo del viewmodel: effects los toma de la fuente
  // local que registra el adaptador (setLocalEjectSource) cuando no se pasa `eject`
  effects.muzzleFlash(fxAboveGround(_fxO.copy(muzzle), G.player.y ?? 0), wep === 'shotgun' || !!def.special,
    { weapon: wep, dir: baseDir, team: G.team });
  audio.gun(wep);
  if (def.recoil >= 1.5) input.pad.rumble(90, 0.5, 0.9);
  else if (def.recoil >= 0.5) input.pad.rumble(55, 0.28, 0.5);
  else input.pad.rumble(45, 0.2, 0.4);
  G.rig.kick(def.recoil * 0.5);
  // retroceso: el MECÁNICO (mueve la mira) y aparte el golpe cosmético
  fpCam.kick(def.recoil);
  applyMechanicalRecoil(ray.kick, def);

  // aplicar daño
  let hitSomeone = false, hitHead = false, hitKill = false; // rango del marcador
  const onlineClaims = [];
  for (const [id, e] of dmgByTarget) {
    if (e.dmg <= 0) continue;
    const gib = def.gibRange != null && e.dist <= def.gibRange;
    if (G.mode === 'practice') {
      hitSomeone = true;
      effects.blood(e.point, TEAM_HEX.blue);
      const killed = G.dummies.damage(id, e.dmg, (d) => {
        const sniperHeadshot = isSniperHeadshotDeath(wep, e.part);
        const impact = { x: d.x - G.player.pos.x, z: d.z - G.player.pos.z };
        d.rig.setDeathContext({
          impact,
          power: Math.min(1, e.dmg / 55),
          vel: { x: 0, z: 0 },
          state: 'run',
          weapon: wep,
          distance: e.dist,
          damage: e.dmg,
          part: e.part,
          point: e.point,
          sniperHeadshot,
          gib,
        });
        G.scores.red++;
        hud.score(G.scores.red, G.scores.blue);
        hud.kill(G.name, 'red', d.name, 'blue', { weapon: wep, head: e.part === 'head', local: 'killer' });
        hud.killConfirm(d.name, wep, e.part === 'head');
        audio.kill(e.part === 'head');
        if (sniperHeadshot) effects.sniperHeadshot(e.point, TEAM_HEX.blue, impact);
        else if (gib) effects.gib(new THREE.Vector3(d.x, 0, d.z), TEAM_HEX.blue);
      });
      if (!killed) audio.hit(e.part === 'head');
      if (killed) hitKill = true;
    } else if (G.mode === 'bots' && G.botMatch) {
      const killed = G.botMatch.damageBot(id, e.dmg, 'player', gib, false, {
        weapon: wep, distance: e.dist, damage: e.dmg, part: e.part,
        point: e.point, gib,
      });
      if (killed === null) continue; // protegido o inválido: sin feedback falso
      hitSomeone = true;
      if (!killed) audio.hit(e.part === 'head');
      if (killed) hitKill = true;
    } else if (G.net) {
      const r = G.remotes.get(id);
      const b = G.onlineBots?.botById(id);
      if ((!r && !b) || r?.inv || b?.protT > 0) continue; // snapshot protegido: el server rechazará daño
      hitSomeone = true;
      effects.blood(e.point, TEAM_HEX[r?.team || b.team]);
      onlineClaims.push({
        id, dmg: e.dmg, part: e.part, gib, point: e.point, pellets: e.pellets,
      });
      audio.hit(e.part === 'head');
    }
    if (e.part === 'head') hitHead = true;
  }
  // la baja online la confirma el servidor ('death'); aquí solo cuerpo/cabeza
  if (hitSomeone) hud.hitmarker(hitKill ? 'kill' : hitHead ? 'head' : 'body');

  // replicar visual
  if (G.net && anyPoint) {
    // WebSocket conserva orden: registrar primero el disparo validable y luego
    // sus claims de daño. Antes los hits llegaban al server sin disparo asociado.
    // el origen reportado es el del DAÑO (el ojo): el server valida LOS,
    // marcas y punto final con exactamente la misma línea del tiro
    // escopeta: el eje central del cartucho; una bala: su dirección EFECTIVA
    // (la del impacto local, con su dispersión) — así el servidor acredita lo
    // que se marcó (un sniper sin mira acertando por dispersión, cabeza incluida)
    G.net.fire(damageOrigin, def.pellets > 1 ? axisPoint : anyPoint, wep, worldImpacts, G.player, ray);
    for (const c of onlineClaims) {
      G.net.hit(c.id, c.dmg, c.part, c.gib, c.point, { pellets: c.pellets });
    }
  }
}

// ---------- retícula estable de intención de cámara ----------
function updateReticle() {
  const p = G.player;
  const scoped = scopeEngaged();
  const canShow = p && !p.dead && G.mode && !menuIsOpen() &&
    p.state !== 'roadie' && p.state !== 'mantle' && p.state !== 'melee';
  if (!canShow) { hud.reticle(null); hud.sniperScope(false); return; }
  if (scoped) { hud.reticle(null); hud.sniperScope(true, { ocular: firstPerson.vm?.ocular.matte.visible }); return; }
  // relevo: lente que aparece mientras el arma sube (HUD acepta opacidad)
  const scopeIn = sniperScopeActive() ? firstPerson.fp2?.vm?.scopeIn01?.() : null;
  if (Number.isFinite(scopeIn) && scopeIn > 0.02) hud.sniperScope(true, { in01: scopeIn });
  else hud.sniperScope(false);
  // Retícula de primera persona: el MISMO semiángulo que usa el disparo
  // (spreadFor) proyectado con el FOV de juego de este cuadro.
  hud.reticle({ weapon: G.weapons.cur, spreadDeg: shotSpread(), aim: fpCam.aim01, dodging: !!p.dodge,
    aligned: fpCam.aim01 >= 0.55 && !!firstPerson.fp2?.active && firstPerson.fp2.vm.key === G.weapons.cur &&
      firstPerson.fp2.vm.sightsAligned(innerHeight), fovDeg: camera.fov });
}

// Marcadores (HUD): compañeros siempre (atenuados sin línea de vista);
// enemigos SOLO el que está bajo la retícula y a la vista, nunca a través
// de paredes.
function markerCharacters() {
  const out = [];
  if (G.mode === 'bots' && G.botMatch) {
    for (const b of G.botMatch.bots) out.push({ id: b.id, x: b.pos.x, y: b.y ?? 0, z: b.pos.z, team: b.team, name: b.name, alive: b.alive, rig: b.rig });
  } else if (G.mode === 'online') {
    for (const r of G.remotes.values()) out.push({ id: r.id, x: r.x, y: r.y ?? 0, z: r.z, team: r.team, name: r.name, alive: r.alive, rig: r.rig });
    for (const b of G.onlineBots?.bots ?? []) out.push({ id: b.id, x: b.pos.x, y: b.y ?? 0, z: b.pos.z, team: b.team, name: b.name, alive: b.alive, rig: b.rig });
  } else if (G.mode === 'practice' && G.dummies) {
    for (const d of G.dummies.targets()) out.push({ id: d.id, x: d.x, y: d.y ?? 0, z: d.z, team: 'blue', name: d.name, alive: d.alive !== false, rig: d.rig });
  }
  return out;
}
// Enemigo IDENTIFICADO este cuadro: el que el rayo central toca primero
// (resolveShot: el mapa tapa) con la línea ojo→impacto libre de humo. Solo
// él muestra nombre (etiqueta 3D del rig) y marca; un agachado tras LOW no
// asoma su nombre por encima del borde. Fuera de la vista de los ojos
// (muerte, espectador, presentación) ningún enemigo se identifica.
function identifiedEnemy() {
  if (!fpCam.live) return null;
  const ray = fpCam.aimRay();
  const targets = currentTargets();
  const hit = resolveShot(world, targets, ray.origin, ray.dir, 200, null);
  if (hit.kind !== 'player') return null;
  if (smoke.blocksSegment?.(ray.origin.x, ray.origin.y, ray.origin.z, hit.point.x, hit.point.y, hit.point.z)) return null;
  // altura REAL del tope de su cabeza (agachado tras LOW, la marca no flota)
  const tg = targets.find((t) => t.id === hit.id);
  const vol = tg?.hit ? { y: tg.hit.hy, r: tg.hit.hr } : tg ? { y: (tg.y ?? 0) + (tg.hitVol ?? (tg.crouch ? CROUCH : STAND)).h[2], r: (tg.hitVol ?? STAND).hr } : null;
  return { id: hit.id, top: vol ? vol.y + vol.r : undefined };
}
function updateMarkers() {
  const aimed = identifiedEnemy(), aimedId = aimed?.id ?? null;
  const ray = fpCam.live ? fpCam.aimRay() : null;
  const list = [];
  for (const c of markerCharacters()) {
    const ally = c.team === G.team;
    // etiqueta 3D: compañeros como siempre; enemigos solo el identificado
    if (!ally && c.rig) {
      const on = c.alive && c.id === aimedId;
      if (c.rig.showNameTag) c.rig.showNameTag(on); else if (c.rig.nameTag) c.rig.nameTag.visible = on;
    }
    if (!ray || !c.alive || (!ally && c.id !== aimedId)) continue;
    _v3.set(c.x - ray.origin.x, c.y + 1.5 - ray.origin.y, c.z - ray.origin.z);
    const dist = _v3.length();
    const occluded = ally && dist > 0.5 && world.raycast(ray.origin, _v3.multiplyScalar(1 / dist), dist - 0.3, 0) !== null;
    const tag = c.rig?.nameTag;
    const label = tag?.visible ? tag.getWorldPosition(_v3) : null;
    list.push({ x: label?.x ?? c.x, y: c.y, z: label?.z ?? c.z, labelY: label?.y, team: c.team, name: c.name, ally, occluded, aimed: !ally, dist,
      ...(!ally && Number.isFinite(aimed?.top) ? { top: aimed.top } : {}) });
  }
  hud.markers(ray ? list : null, camera);
}
// ---------- loop principal ----------
let last = performance.now();

// handle de debug/testing
window.BREACH = G;
window.BREACH_INPUT = input;
window.BREACH_CAM = camera;
window.BREACH_RENDERER = renderer; // scripts/bench-map.mjs: draw calls, triángulos, texturas
window.BREACH_AUDIO = audio;
window.BREACH_WORLD = world;
window.BREACH_ASSETS = urbanAssetState; // qué modelos hay en memoria / en vuelo
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

function stepOrdnance(dt) {
  smoke.update(dt);
  // la espoleta necesita el bando de cada cuerpo: un cohete de bot no debe
  // detonar al rozar a un compañero
  rockets.update(dt, G.mode ? allCharacterTargets() : [], explodeRocket);
}

function simStep(dt) {
  G.simClock += dt;
  hud.pickupPrompt('');
  const p = G.player;
  if (!p) return;
  updatePrototypes(dt);
  // aturdimiento por patada: sin disparo, puntería ni golpe, y más lento
  G.kickDaze = Math.max(0, (G.kickDaze ?? 0) - dt);
  G.kickDazeImmune = Math.max(0, (G.kickDazeImmune ?? 0) - dt);
  const dazed = G.kickDaze > 0 && !p.dead;
  p.dazed = dazed;
  if (dazed) { input.firePressed = false; input.meleePressed = false; G.fireBuffer = 0; hud.hint('ATURDIDO', 100); }
  if(G.protoStun>0&&!p.dead){
    G.weapons.cancelActions(); audio.cancelHandling();G.fireBuffer=0;G.pendingShots=0;G.pendingRays.length=0;G.pendingThrows=0;G.pendingThrowShots.length=0;G.throwT=0;G.throwPending=false;
    p.aim=false;p.vel.x=0;p.vel.z=0;p.firingBlind=0;
    // Keep the exact cover anchor; cancel transient evade/melee gestures.
    if(p.state!=='cover')p.state='idle';
    p.dodge=null;p.dive=null;p.slide=null;p.mantle=null;p.flip=null;p.coverEntry=null;
    const stunFloor=world.groundHeight(p.pos,PLAYER_R,p.y);
    if(!p.grounded||p.y>stunFloor+.01){p.vy=Math.min(0,p.vy)-TUNING.jump.gravity*dt;p.y+=p.vy*dt;}
    if(p.y<=stunFloor+.001){p.y=stunFloor;p.vy=0;p.grounded=true;}
    shoulderCam.setScoped(false);G.scopeActive=false;hud.sniperScope(false);
    hud.hint(`⚡ STUN ${G.protoStun.toFixed(1)}s`,100);
    G.botMatch?.update(dt);
    if(G.net){G.net.tickState(dt,p,G.weapons,G.simClock);G.net.tickBotState(dt,G.onlineBots?.bots);}
    input.consumeEdges();return;
  }

  // Una sola puerta de control gobierna intro, countdown, intermedio y cierre.
  // La simulación visual sigue viva, pero jugador, armas, pickups y bots no
  // pueden adelantarse al 3…2…1.
  if (matchControlsLocked()) {
    G.fireBuffer = 0;
    G.pendingShots = 0;
    G.pendingRays.length = 0;
    G.pendingThrows = 0; G.pendingThrowShots.length = 0;
    G.aimOver.lift = 0;
    p.update(dt, input, false);
    if (G.botMatch) G.botMatch.update(dt);
    if (G.net) { G.net.tickState(dt, p, G.weapons, G.simClock); G.net.tickBotState(dt, G.onlineBots?.bots); }
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
    if (G.net) { G.net.tickState(dt, p, G.weapons, G.simClock); G.net.tickBotState(dt, G.onlineBots?.bots); }
    input.consumeEdges();
    return;
  }

  // Se dispara en el aire y deslizando (con más dispersión: spreadFor); no
  // en sprint, trepando ni golpeando. fireAligned() ya incluye el retraso
  // sprint→disparo del arma en mano.
  if (!p.bindWeapons) p.setWeapon(G.weapons.cur); // (con bindWeapons lo sigue el controller)
  const stateOk = !p.dead && fireGateOpen(p) && input.anyDevice;
  let canFire = stateOk && p.fireAligned();
  // cualquier click que no pueda salir YA (roadie, cuerpo girando, cooldown,
  // dive/slide o recarga) queda bufereado — y el buffer dura AL MENOS
  // lo que falta de cooldown/recarga, para que el tiro encolado nunca se pierda
  const wst = G.weapons.st;
  const relRemain = G.weapons.reloading ? wst.reload : 0;
  // también durante el cambio de arma: el clic de un arma semiautomática
  // pulsado antes de terminar el gesto se perdía sin más
  if (input.firePressed && !p.dead &&
      (!canFire || wst.cd > 0 || relRemain > 0 || G.weapons.swapping)) {
    G.fireBuffer = requiredFireBuffer(p, wst, relRemain, G.weapons.swapping ? G.weapons.swapT : 0);
  }
  G.fireBuffer = Math.max(0, G.fireBuffer - dt);

  // Sin munición físicamente disponible, el gatillo no debe forzar pose de
  // tiro: evita que una recarga vacía deje al jugador expuesto sobre el cover.
  // Una recarga táctica sí puede interrumpirse porque conserva balas en el mag.
  const canInterruptReload = G.weapons.reloading &&
    (input.firePressed || G.fireBuffer > 0) && G.weapons.st.mag > 0;
  const hasAmmo = (!G.weapons.reloading || canInterruptReload) &&
    (G.weapons.st.mag > 0 || G.weapons.st.reserve > 0 || G.weapons.infinite);
  hud.pickupPrompt('');
  const prototypeNearby=prototypePickup();
  const nearbyDrop = G.selfAlive && !p.dead && !G.weapons.swapping && G.drops
    ? [...G.drops.drops.entries()].filter(([, d]) => !d.claimed &&
      canReplaceDrop(G.weapons.slots, d.wep) && Math.abs(p.y - d.y) < 0.8 &&
      Math.hypot(p.pos.x - d.x, p.pos.z - d.z) < 1.1)
      .sort((a, b) => Math.hypot(p.pos.x - a[1].x, p.pos.z - a[1].z) - Math.hypot(p.pos.x - b[1].x, p.pos.z - b[1].z))[0] : null;
  if (nearbyDrop&&!prototypeNearby) {
    const [id, d] = nearbyDrop;
    const slot = replacementSlot(G.weapons.slots, G.weapons.cur);
    const old = G.weapons.slots[slot];
    const button = input.lastDevice === 'pad' ? padBtnName(BINDS.pad.pickup) : keyLabel(BINDS.kb.pickup);
    hud.pickupPrompt(t('pickup.replace', { button, old: t('weapon.' + old + 'Short'), weapon: t('weapon.' + d.wep + 'Short') }));
    if (input.pickupPressed) {
      input.pickupPressed = false; // recoger consume la pulsación
      if (G.mode === 'online') {
        d.claimed = true; d.claimT = 1;
        G.net?.send({ t: 'takeDrop', id, replace: true, slot, expected: old });
      } else {
        G.weapons.replaceSlot(slot, d.wep, d.mag, d.res);
        G.rig.setWeapon(G.weapons.cur);
        G.drops.remove(id);
        audio.weaponPickup();
      }
    }
  }
  // pickup del arma ESPECIAL: junto al pedestal, evadir se convierte en
  // "tomar" (se consume el edge para no rodar encima) y hay que MANTENERLO
  if (!prototypeNearby && !nearbyDrop && specials.active && G.selfAlive && !p.dead && p.grounded &&
      specials.near(p.pos.x, p.pos.z, p.y)) {
    const holding = input.keys.has(BINDS.kb.pickup) || input.pad.pressed.has(BINDS.pad.pickup);
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
          // práctica: el pedestal reaparece al instante con LA OTRA especial
          // (sniper↔bazooka) — ambas se prueban sin reiniciar la sesión
          if (G.mode === 'practice') { G.specialRound++; spawnSpecialForRound(); }
          audio.specialTaken();
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
        button: input.lastDevice === 'pad' ? padBtnName(BINDS.pad.pickup) : keyLabel(BINDS.kb.pickup),
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
  // A buffered shot must not keep a released cover peek exposed.
  // En práctica no llegan snapshots. Durante esta maniobra se registra el
  // mismo cambio de pose por subpaso para que la bajada del ojo sea continua.
  if (!G.net && (input.evadePressed || p.queuedDodge) && p.dodgeCd <= 1e-8) {
    noteLocalPose(p, p.weaponKey, G.simClock - dt);
    p.offlineDodgePose = true;
  }
  p.update(dt, input, (input.fireHeld || G.fireBuffer > 0) && !p.dead && hasAmmo && !dazed);

  if (!G.net && p.offlineDodgePose) {
    noteLocalPose(p, p.weaponKey, G.simClock);
    if (!p.dodge && !p.dodgeCd) { resetTransition(p); p.offlineDodgePose = false; }
  }

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
  // tras el empujón: la cabeza (pose final, con su mezcla) fuera de la geometría
  p.settle?.();
  // El controller puede haber recuperado control o terminado de alinearse en
  // este mismo paso. Revalidar evita añadir un frame artificial de latencia.
  const stateOkAfter = !p.dead && fireGateOpen(p) && input.anyDevice;
  canFire = stateOkAfter && p.fireAligned();
  // Un clic y una esquiva pueden comenzar en el mismo paso de simulación.
  if (input.firePressed && p.state === 'dodge') {
    G.fireBuffer = Math.max(G.fireBuffer, requiredFireBuffer(p, wst, relRemain, G.weapons.swapT || 0));
  }
  if (input.fireReleased) G.weapons.dropCadenceCredit();
  G.weapons.aimHint = p.aim; // menos retroceso lateral apuntando
  const fired = p.dead ? false
    : G.weapons.update(dt, input.fireHeld && !dazed, input.firePressed || G.fireBuffer > 0, canFire && !dazed,
      p.state !== 'melee');
  // (gatillo en seco, recarga y cambio suenan por los eventos del arma)
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
    } else {
      // REGISTRO DEL TIRO: arma, pose, ojo, eje y dispersión de ESTE
      // subpaso, y se resuelve YA (daño, traza, red): ningún movimiento
      // posterior sale por la red antes que el tiro y ningún cambio de arma
      // posterior (recoger una especial) lo reinterpreta.
      fireShot(captureShot());
    }
  }
  // el gesto (G.throwT) solo anima; el bote sale con el evento
  // `throwRelease` del arma (un solo reloj: el de weapons.js)
  if (G.throwT > 0) G.throwT = Math.max(0, G.throwT - dt);

  // Recarga normal: pulsar otra vez mientras ya está en curso no modifica la
  // duración, no completa el cargador y no aplica bonus/penalizaciones.
  if (input.reloadPressed && p.state !== 'melee' && !G.weapons.reloading) {
    G.weapons.startReload();
  }

  // práctica = munición de reserva infinita (nunca te quedas sin disparar)
  if (G.mode === 'practice') {
    for (const k of G.weapons.slots) {
      const d = TUNING.weapons[k];
      if (d.thrown && k!=='frag') { if (G.weapons.state[k].mag <= 0) G.weapons.state[k].mag = d.mag; }
      else if (!d.special) G.weapons.state[k].reserve = d.reserve;
    }
  }
  // selección de arma: Q y la rueda CICLAN; 1-4 y el d-pad seleccionan
  // directo por slot. El cambio conserva una sola animación, pero acepta la
  // última intención si el jugador corrige rápidamente la selección; durante
  // melee el arma permanece ocupada en el golpe.
  if (!p.dead && p.state !== 'melee' && G.throwT <= 0) {
    let swapped = false;
    let swapTarget = null;
    if (input.slotPressed >= 0) {
      swapTarget = G.weapons.slots[input.slotPressed];
      swapped = !!swapTarget && G.weapons.startSwap(swapTarget);
    } else if (input.cycleDir !== 0) {
      swapTarget = G.weapons.cycleTarget(Math.sign(input.cycleDir));
      swapped = G.weapons.startSwap(swapTarget);
    } else if (input.swapPressed) {
      swapTarget = G.weapons.cycleTarget(1);
      swapped = G.weapons.startSwap(swapTarget);
    } else if (input.swapPrevPressed) {
      swapTarget = G.weapons.cycleTarget(-1);
      swapped = G.weapons.startSwap(swapTarget);
    }
    if (swapped) hud.weaponWheel(G.weapons, swapTarget);
    // granada rápida: cambia al arrojadizo, lo lanza y vuelve al arma de antes
    else if (input.grenadePressed && p.state !== 'dodge' && G.weapons.quickThrow()) hud.weaponWheel(G.weapons, G.weapons.selectionTarget);
  }

  // empujones de patada pendientes sobre bots
  for (let i = G.kickPushes.length - 1; i >= 0; i--) {
    const k = G.kickPushes[i], f = 1 - Math.exp(-11 * dt), mx = k.x * f, mz = k.z * f;
    if (!k.b.alive || Math.hypot(k.x, k.z) < 0.01) { G.kickPushes.splice(i, 1); continue; }
    k.b.pos.x += mx; k.b.pos.z += mz; k.x -= mx; k.z -= mz;
    world.resolveCircle(k.b.pos, 0.42, k.b.y ?? 0);
  }
  // Una sola ventana de impacto por gesto, incluso con varios subpasos.
  if (p.state === 'melee' && !G.meleeHitDone && p.meleeT >= TUNING.melee.hitAt) {
    G.meleeHitDone = true;
    const result = resolveMelee();
    p.confirmMelee(result.connected, result.killed);
    G.weapons.noteMelee('hit', result);
  }

  // pasos: por distancia recorrida; el tipo según estado y velocidad
  if ((p.state === 'run' || p.state === 'roadie') && p.speed > 1 && p.grounded) {
    G.footAcc += p.speed * dt;
    const roadie = p.state === 'roadie';
    if (G.footAcc > (roadie ? 2.1 : 1.7)) {
      G.footAcc = 0;
      audio.footstep(roadie ? 'roadie' : (p.speed < 3 ? 'walk' : 'run'));
      if (p.speed > 4) effects.dust(p.pos, 'step', p.y);
    }
  } else if (p.state === 'crouch' && p.speed > 0.6 && p.grounded) {
    // agachado: paso corto y bajo
    G.footAcc += p.speed * dt;
    if (G.footAcc > 1.4) { G.footAcc = 0; audio.footstep('crouch'); }
  }
  // ropa al agacharse/levantarse e inclinarse (flancos)
  const crouchedNow = (p.crouch01 ?? 0) >= 0.5;
  if (crouchedNow !== !!G.wasCrouched && !p.dead) audio.stance?.(crouchedNow ? 'crouch' : 'stand');
  G.wasCrouched = crouchedNow;
  const leanedNow = Math.abs(p.lean ?? 0) >= 0.5;
  if (leanedNow && !G.wasLeaned && !p.dead) audio.lean?.();
  G.wasLeaned = leanedNow;

  if (G.dummies) G.dummies.update(dt);

  // protección de spawn + countdown de respawn + cajas de munición
  G.spawnProt = Math.max(0, G.spawnProt - dt);
  G.respawnT = Math.max(0, G.respawnT - dt);

  // armas caídas: recoger = quedarse con sus balas restantes
  if (G.drops) {
    G.drops.update(dt, p.pos.x, p.pos.z, p.y, G.selfAlive && !p.dead, (id, d) => {
      const def = TUNING.weapons[d.wep];
      const s = G.weapons.state[d.wep];
      if (!s || !def || d.mag + d.res <= 0) return;
      if (s.reserve >= def.reserve) return; // reserva llena: no desperdiciarla
      if (G.mode === 'online') {
        d.claimed = true;
        d.claimT = 2; // si el server no confirma, vuelve a ser reclamable
        G.net?.send({ t: 'takeDrop', id, capacity: def.reserve - s.reserve });
        return;
      }
      // anunciar lo GANADO real (el clamp de reserva podía comerse la mayoría)
      const gained = takeDropAmmo(d, def.reserve - s.reserve);
      s.reserve += gained;
      if (d.mag + d.res <= 0) G.drops.remove(id);
      audio.ammoPickup();
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
      audio.crate();
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
    if (G.mode === 'bots') {
      localPowerTime += dt;
      const wep = G.specialRound % 2 === 1 ? 'sniper' : 'bazooka';
      const st = G.weapons.state[wep];
      const available = !!specials.active || (G.selfAlive && st && st.mag + st.reserve > 0) ||
        G.botMatch.bots.some(b => b.alive && b.wep === wep && b.specialAmmo > 0) ||
        (G.drops?.pendingPower || 0) > 0 ||
        [...(G.drops?.drops.values() || [])].some(d => d.wep === wep && d.mag + d.res > 0);
      if (localPowerRespawn.update(localPowerTime, G.botMatch.phase === 'playing', available)) spawnSpecialForRound();
    }
    // regen del jugador (igual que online, pero local)
    if (G.mode === 'bots') {
      G.playerLastHit += dt;
      if (G.selfAlive && G.playerLastHit > TUNING.combat.regenDelay && G.selfHp < TUNING.combat.hp) {
        G.selfHp = Math.min(TUNING.combat.hp, G.selfHp + TUNING.combat.regenRate * dt);
      }
    }
  }
  if (G.net) { G.net.tickState(dt, p, G.weapons, G.simClock); G.net.tickBotState(dt, G.onlineBots?.bots); }

  input.consumeEdges();
}

const OWN_ROCKET_HIDE = 2.2;
const ownRocketsHidden = [];
function revealOwnRockets() {
  for (let i = ownRocketsHidden.length - 1; i >= 0; i--) {
    const o = ownRocketsHidden[i], r = o.r;
    const gone = !rockets.list.includes(r);
    if (gone || Math.hypot(r.x - o.x, r.y - o.y, r.z - o.z) >= OWN_ROCKET_HIDE) {
      if (!gone) r.mesh.visible = true;
      ownRocketsHidden.splice(i, 1);
    }
  }
}

// Flancos de recarga ajena → audio.remoteReload / remoteReloadCancel.
const remoteReloading = new Map();
function remoteReloadEdge(id, on, wep, x, y, z, progress, total = null) {
  const was = remoteReloading.get(id); // último progreso visto mientras recargaba
  if (on && was === undefined) {
    audio.remoteReload?.(wep, { x, y: y + 1.2, z }, total ?? TUNING.weapons[wep]?.reloadTime ?? 0, progress, id);
  }
  if (on) remoteReloading.set(id, progress);
  else if (was !== undefined) {
    remoteReloading.delete(id);
    if (was < 0.75) audio.remoteReloadCancel?.(id); // cortada (muerte, cambio): sin el final
  }
}

let padWasConnected = false;
let bodyFpOn = false;

// Un mapa construido con sustitutos (modelo fallido o tope de espera) se
// repara cuando ese modelo llega: en el menú al momento y en línea solo fuera
// de una ronda en juego. Offline se rehace en su siguiente arranque.
let mapRepairPending = false;
onUrbanAssetArrived(() => { mapRepairPending = true; });
function repairMapIfDue() {
  const online = G.mode === 'online' && !['playing', 'round-finish'].includes(G.onlinePhase);
  if (!G.mode || online) {
    mapRepairPending = false;
    world.setLayout(world.layout); // no hace nada si no llegó algo que faltaba
    if (G.mode) effects.clearImpacts();
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (mapRepairPending) repairMapIfDue();
  // nunca negativo: si el reloj retrocede (pestaña restaurada, reloj de pruebas)
  // un dt < 0 hace divergir todos los suavizados exponenciales
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
  // calidad automática: si los cuadros reales no aguantan, baja un escalón
  if (gfxAuto && autoGfx.sample((now - last) / 1000, document.visibilityState === 'visible')) {
    gfxQuality = autoGfx.quality;
    pipeline.setQuality(gfxQuality);
    world.look.setQuality(gfxQuality);
    effects.setQuality(gfxQuality);
    applyShadowFilter();
    applyRenderSize();
    console.info('[gfx] auto →', gfxQuality, 'x' + autoGfx.scale, '(' + autoGfx.lastFps.toFixed(0) + ' c/s)');
  }
  last = now;
  world.look.update(dt, camera);

  // MODO EDITOR: cámara y overlays propios; el gameplay no corre
  if (G.mode === 'editor') {
    editor.update(dt);
    effects.update(dt);
    renderFrame();
    input.endFrame();
    return;
  }

  const menuOpen = menuIsOpen();
  // body.fp: composición del HUD en primera persona, puesta mientras se juega
  const fpBody = playingMode();
  if (fpBody !== bodyFpOn) { bodyFpOn = fpBody; document.body.classList.toggle('fp', fpBody); }
  if (!G.mode) updateMenuBackdrop(now);
  if (!G.mode) updateStartPrompts(null, true); // sin partida, sin señales de arranque
  const flowLocked = matchControlsLocked();
  // al desbloquear el despliegue arranca la protección REAL: la otorgada al
  // spawnear se quemaba entera durante el intro (bots y online por igual)
  if (G.flowLockedPrev && !flowLocked && (G.mode === 'online' || G.mode === 'bots')) {
    grantSpawnProtection();
  }
  const flowUnlocked = G.flowLockedPrev && !flowLocked;
  G.flowLockedPrev = flowLocked;
  input.suppress = menuOpen || flowLocked; // presentación y menú bloquean el gameplay
  // Antes de la ronda (intro / cuenta regresiva) el cursor ya se captura: si
  // se esperaba a la salida, el ratón quedaba muerto hasta el reintento de
  // captura y el teclado no contaba. Resultados y pantalla final no capturan.
  // ('intro' faltaba en vs bots: la captura del gesto de START se soltaba y
  // el keeper no podía volver a pedirla hasta la cuenta regresiva)
  const preRound = G.mode === 'online' ? ['intro', 'countdown'].includes(G.onlinePhase)
    : G.mode === 'bots' && ['starting', 'intro', 'countdown'].includes(G.botMatch?.phase);
  input.presentation = flowLocked && !menuOpen && preRound;
  if (flowUnlocked && !menuOpen && !input.locked) input.requestLock();
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

  // humo y cohetes avanzan DENTRO de los pasos de simulación (pausa incluida)
  let ordnanceStepped = false;
  if (G.mode && G.player) {
    // El input de cámara de este frame usa el estado scoped ya válido del
    // frame anterior; tras simStep se recalcula para cámara/HUD sin latencia.
    shoulderCam.setScoped(scopeEngaged());
    if (!menuOpen) {
      const spectatorLocked = G.spectator.active;
      // Con la cámara de presentación en pantalla (intro, fin de ronda) el
      // ratón no gira la cámara de hombro escondida: al llegar la cuenta
      // regresiva el jugador mira hacia donde mira su spawn.
      const lookFrozen = flowLocked && !flowCountdownShowing();
      if (!spectatorLocked && !lookFrozen && (input.locked || input.lockDisabled)) {
        shoulderCam.applyMouse(input.lookDX, input.lookDY, input.invertY);
      }
      if (!spectatorLocked && !lookFrozen && input.pad.connected) {
        // fricción de la asistencia (solo mando, solo jugando con los ojos)
        const friction = fpCam.live ? padAimFriction() : 1;
        shoulderCam.applyStick(input.pad.camX, input.pad.camY, dt, input.invertYPad, friction);
      }
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
    // Recuperar antes de simular/disparar mantiene aimRay, retícula y cámara
    // renderizada sobre el mismo pitch durante todo el frame.
    shoulderCam.recoverPitchRecoil(dt);

    // pausa real en práctica y vs bots; online la partida sigue.
    // Simulación por frame con dt variable: a ≥30 fps es EXACTAMENTE un paso
    // por frame dibujado (el fix del judder). Bajo 30 fps se recupera el
    // tiempo real con hasta 4 pasos de ≤1/30 — antes el juego entraba en
    // cámara lenta en máquinas que no sostenían 30 fps.
    const paused = menuOpen && (G.mode === 'practice' || G.mode === 'bots');
    // En pausa offline un cohete mataba a actores congelados y el humo
    // expiraba: la munición en vuelo comparte los pasos del resto del mundo.
    ordnanceStepped = true;
    // Las piezas de recarga van programadas en tiempo de audio: al pausar se
    // cortan y al reanudar se reprograman desde el progreso real del cargador.
    if (paused !== G.reloadAudioPaused) {
      G.reloadAudioPaused = paused;
      const p = G.player, k = motionScale('shake');
      if (paused) {
        audio.reloadPause();
        if (p.dodge || p.dodgeCd > TUNING.dodge.cooldown - 0.045) input.pad.rumble(0, 0, 0);
      } else {
        audio.reloadResume();
        if (p.dodge && p.dodge.t < 0.075) input.pad.rumble(75 - 1000 * p.dodge.t, 0.55 * k, 0.25 * k);
        if (!p.dodge && p.dodgeCd > TUNING.dodge.cooldown - 0.045) {
          input.pad.rumble(45 - 1000 * (TUNING.dodge.cooldown - p.dodgeCd), 0.20 * k, 0.65 * k);
        }
      }
    }
    if (!paused) {
      let acc = dt, steps = 0;
      while (acc > 1e-6 && steps < 4) {
        const st = Math.min(acc, 1 / 30);
        simStep(st);
        stepOrdnance(st);
        acc -= st; steps++;
      }
    }

    const flowView = activePresentation(Date.now() / 1000);
    updatePresentationAudio(flowView);
    hud.presentation(flowView);
    updateStartPrompts(flowView, menuOpen);
    const scopeNow = scopeEngaged();
    G.scopeActive = scopeNow; // diagnóstico/tests; sigue siendo estado derivado
    shoulderCam.setScoped(scopeNow);
    // El sniper usa 20° solo durante un scope realmente válido. Al iniciar
    // swap/melee vuelve de inmediato al ADS estándar aunque LT siga pulsado.
    shoulderCam.setAimFov(scopeNow ? G.weapons.def.fovAim : TUNING.cam.fovAim);
    // PRIMERA PERSONA = la vista de juego. Presentación, espectador y la
    // reacción de muerte siguen con la cámara de hombro.
    const presenting = !!(flowView && flowView.phase !== 'countdown');
    const eyes = !presenting && !G.spectator.active && playingMode() &&
      !G.player.dead && G.selfAlive;
    if (eyes) {
      // reaparición / ronda nueva: sin ADS/agachado alternado pegado y sin
      // mezcla de postura heredada en el cable (RED §1: resetLife)
      if (!fpCam.live) { fpCam.reset(); input.resetToggles(); }
      // reloj de SIMULACIÓN: en la pausa offline la cámara no anima (resortes, sacudida)
      fpCam.update(paused ? 0 : dt, G.player, {
        // ojo = eyeWorld(pose que viaja): mismo punto que el tiro
        pose: localPoseInput(), weapon: G.weapons.cur, scoped: scopeNow,
        scopeFov: G.weapons.def.fovAim, settings: fpSettings(), sens: fpSens(scopeNow), sensFn: lookSensitivity,
      });
    } else {
      if (fpCam.live) { fpCam.release(); shoulderCam._first = true; input.resetToggles(); }
      if (presenting) updateMatchCamera(now, flowView);
      else if (G.spectator.active) updateSpectatorCamera(dt, now);
      else shoulderCam.update(dt, G.player);
    }
    G.rig.setWeapon(G.weapons.cur, backWeapon()); // el intercambio real ocurre a mitad del gesto
    // Soldado propio visto desde SU cámara: de cerca no tapa la retícula y
    // en el scope no se dibuja delante de la lente (la sombra se queda).
    const ownView = !(flowView && flowView.phase !== 'countdown') && !G.spectator.active;
    // en primera persona el soldado propio no se dibuja (su sombra sí); en
    // la cámara de muerte / espectador / presentación se ve entero
    syncLocalSoldierView(G.rig, camera, ownView ? (fpCam.live ? 'hidden' : 'near') : 'off', fpCam.live ? 0 : shoulderCam.crowd, fpCam.live ? 0 : shoulderCam.ghost);
    // protección de spawn: highlight sutil en el color del equipo
    G.rig.root.visible = true;
    G.rig.setProtected(G.spawnProt > 0);
    G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
    const localAnim = G.player.animParams();
    // la postura que se dibuja es la que viaja (net/client postureOf): en la
    // transición agacharse↔levantarse el estado es `crouch` con la altura en
    // coverAimExposure (= ce), e inclinación por coverLean (= cl)
    const wirePose = localPose(G.player, G.weapons.cur, G.simClock);
    if (!(paused && localAnim.state === 'melee')) G.rig.update(dt, {
      ...localAnim,
      ...(G.player.dead ? {} : { state: wirePose.st === 'crouch' ? 'crouch' : localAnim.state,
        coverAimExposure: wirePose.ce, coverLean: wirePose.cl }),
      swapping: G.weapons.swapping,
      throwT: G.throwT,
      throwTotal: TUNING.weapons.grenade.throwTime,
      throwReleased: G.throwT > 0 && !G.throwPending,
      reloading: G.weapons.reloading,
      reloadT: G.weapons.reloading ? 1 - G.weapons.st.reload / G.weapons.def.reloadTime : 0,
      aimLift: G.aimOver.lift,
    });
    // arma en primera persona: después de la pose del rig (recarga, cambio,
    // kick) y antes de los tiros (su boca origina traza y fogonazo).
    // Prototipo: lee `live` y el ojo de la cámara nueva.
    firstPerson.live = fpCam.live;
    firstPerson.eye.copy(fpCam.eye);
    // el arma anima con el reloj de SIMULACIÓN: en la pausa offline se congela
    if (fpCam.live || firstPerson.vm) firstPerson.updateViewModel(paused ? 0 : dt, shoulderCam);
    for (const r of G.remotes.values()) {
      r.update(dt);
      const kicking = r.alive && r.st === 'melee';
      if (kicking && !r._wasKicking) audio.meleeSwing({ position: { x: r.x, y: r.y + 1, z: r.z } });
      r._wasKicking = kicking;
      // pasos de remotos: por distancia recorrida real, posicionales
      const mdx = r.x - (r._sx ?? r.x), mdz = r.z - (r._sz ?? r.z);
      r._sx = r.x; r._sz = r.z;
      // en el aire = por encima de SU apoyo local, no de la cota 0: galerías,
      // rampas y plataformas silenciaban a cualquiera que corriera por ellas
      const ry = r.y ?? 0;
      const airborne = r.st === 'jump' || r.st === 'flip' ||
        ry - world.groundHeight({ x: r.x, z: r.z }, PLAYER_R, ry) > 0.08;
      if (r.alive && !airborne && (r.st === 'run' || r.st === 'roadie' || r.st === 'crouch')) {
        r._facc = (r._facc ?? 0) + Math.hypot(mdx, mdz);
        const kind = r.st === 'crouch' ? 'crouch' : r.st === 'roadie' ? 'roadie' : 'run';
        if (r._facc > (kind === 'crouch' ? 1.4 : kind === 'roadie' ? 2.1 : 1.7)) {
          r._facc = 0;
          stepSound(r.x, r.z, kind, r.y ?? 0, r.team);
        }
      } else {
        r._facc = 0;
      }
      if (r._wasAir && !airborne && r.alive) stepSound(r.x, r.z, 'land', r.y ?? 0, r.team);
      r._wasAir = airborne;
      // recarga de otro jugador (flanco de `rl`): audible cerca y bajo
      remoteReloadEdge(r.id, r.alive && r.reloading, r._lastW, r.x, r.y ?? 0, r.z, r.reloadT ?? 0);
    }
    // bots (locales o alojados) recargan de verdad: que se oiga igual
    for (const b of (G.mode === 'bots' ? G.botMatch?.bots : G.mode === 'online' ? G.onlineBots?.bots : null) ?? []) {
      const wep = b.wep ?? b.weapon;
      remoteReloadEdge(b.id, b.alive && b.reloadT > 0, wep, b.pos.x, b.y ?? 0, b.pos.z,
        b.reloadTotal > 0 ? 1 - b.reloadT / b.reloadTotal : 0, b.reloadTotal);
    }

    hud.ammo(G.weapons);
    // en pausa (práctica/bots) o con la presentación encima no hay vida baja
    // visible ni latido: se reanudan solos al volver al juego
    G.feedbackQuiet = paused || !!flowView;
    hud.health(G.spectator.active || G.feedbackQuiet ? 1
      : (G.mode === 'online' || G.mode === 'bots' ? G.selfHp / TUNING.combat.hp : 1));
    if (G.mode === 'online') resolveOnlineHurt();
    // arcos de daño: rumbo desde el jugador, orientados con el yaw de cámara
    hud.feedback(paused ? 0 : dt, camera, G.player.pos.x, G.player.pos.z, G.spectator.active || G.player.dead);
    // countdown grande de reaparición (no en fin de ronda/partida: ahí la
    // cola de respawns se vació y el contador mentía, pisando "ROUND PARA…")
    const bmPhase = G.botMatch?.phase;
    if (G.botMatch && !G.botMatch.external && !G.selfAlive) G.respawnT = Math.max(0, G.botMatch.respawnQueue.find(q => q.id === 'player')?.t ?? 0);
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
    hud.setWeaponZone(firstPerson.fp2?.active ? firstPerson.fp2.vm.hudZones() : null);
    if (flowView) { hud.reticle(null); hud.sniperScope(false); }
    else updateReticle();
    updateMarkers(); // también fuera de la vista de los ojos: ahí oculta a los enemigos
    if (!G.player.dead) hud.stance({ dodgeCd: G.player.dodgeCd, crouch: G.player.crouch01 ?? 0, lean: G.player.lean ?? 0 });
  } else {
    if (fpCam.live) fpCam.release();
    G.scopeActive = false;
    shoulderCam.setScoped(false);
    hud.sniperScope(false);
  }

  if (!ordnanceStepped) stepOrdnance(dt); // sin jugador (menú, transición)
  revealOwnRockets();
  effects.update(dt);
  specials.update(dt);
  updateAudioFrame(dt);
  renderFrame();
  input.endFrame();
}
requestAnimationFrame(frame);
