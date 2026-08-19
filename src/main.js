// BREACH — vertical slice. Orquesta mundo, jugador, combate, red y UI.
import * as THREE from 'three';
import GUI from 'lil-gui';
import { TUNING, TUNING_DEFAULTS } from './config/tuning.js';
import { BINDS, KB_LABELS, PAD_LABELS, keyLabel, padBtnName, loadBinds, saveBinds, resetBinds } from './core/bindings.js';
import { Input } from './core/input.js';
import { ShoulderCamera } from './core/camera.js';
import { World } from './world/world.js';
import { Rig, CHAR_NAMES } from './player/rig.js';
import { Controller, PLAYER_R } from './player/controller.js';
import { RemotePlayer } from './player/remote.js';
import { Dummies } from './player/practice.js';
import { Weapons } from './combat/weapons.js';
import { resolveShot, applySpread } from './combat/ballistics.js';
import { Effects } from './fx/effects.js';
import { Audio } from './fx/audio.js';
import { HUD } from './ui/hud.js';
import { NetClient } from './net/client.js';
import { BotMatch } from './game/botmatch.js';
import { AmmoCrates } from './game/crates.js';
import { WeaponDrops } from './game/drops.js';

const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };

// ---------- setup base ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// En pantallas táctiles/DPR alto, 2× cuadruplica el fill-rate sin aportar
// legibilidad al shooter. Escritorio conserva el máximo; móvil usa un techo
// más sensato y estable.
const coarseDisplay = matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, coarseDisplay ? 1.35 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // bordes de sombra nítidos, sin suavizado

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.cam.fovNormal, 1, 0.1, 200);
// Antes de una partida, Azotea funciona como backdrop 3D deliberado del menú.
// Al jugar, setLayout reutiliza este mismo World con el mapa elegido.
const world = new World(scene, 'azoteas');
const effects = new Effects(scene);
const audio = new Audio();
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
  world.setLayout('azoteas');
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
  fireBuffer: 0,       // click de disparo pendiente mientras el cuerpo gira
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
};

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
    if (chain >= 2) hud.hint('BOUNCE ×' + chain, 700);
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

function dismissSplash() { splash.classList.add('off'); }
btnEnter.addEventListener('click', () => {
  dismissSplash();
  inName.focus();
  inName.select();
});
btnEnter.focus();

const menuIsOpen = () => !hud.el.menu.classList.contains('off');

function openMenu() {
  hud.showMenu(true);
  showControls(false);
  hud.el.menu.classList.toggle('in-match-bg', !!G.mode);
  btnResume.style.display = G.mode ? 'flex' : 'none';
  mainCard.classList.toggle('in-match', !!G.mode);
  document.getElementById('menu-title').textContent = G.mode ? 'PAUSA' : 'JUGAR';
  document.getElementById('menu-kicker').textContent = G.mode ? 'Partida actual' : 'Selecciona un modo';
  // NO soltamos el pointer lock: el menú se usa con el cursor virtual.
  // (Cada exit de lock es una oportunidad para el bug de ClipCursor de
  // Chromium/Windows que deja el cursor confinado.)
  vc.x = innerWidth / 2;
  vc.y = innerHeight / 2;
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

document.getElementById('btn-bots').addEventListener('click', () => startBots());
document.getElementById('btn-practice').addEventListener('click', () => startPractice());
document.getElementById('btn-online').addEventListener('click', () => startOnline());

// selector de mapa (VS Bots y Práctica; online lo fija el server: Fortaleza)
const btnMap = document.getElementById('btn-map');
const MAP_LABELS = { fortaleza: 'FORTALEZA', azoteas: 'AZOTEAS' };
G.mapChoice = localStorage.getItem('breach.map') === 'azoteas' ? 'azoteas' : 'fortaleza';
function updateMapBtn() { document.getElementById('map-label').textContent = 'Mapa: ' + MAP_LABELS[G.mapChoice]; }
btnMap.addEventListener('click', () => {
  G.mapChoice = G.mapChoice === 'fortaleza' ? 'azoteas' : 'fortaleza';
  localStorage.setItem('breach.map', G.mapChoice);
  updateMapBtn();
});
updateMapBtn();
btnResume.addEventListener('click', () => closeMenu());
document.getElementById('btn-pause').addEventListener('click', () => openMenu());

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
document.getElementById('btn-fs').addEventListener('click', () => toggleFullscreen());
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  document.getElementById('fullscreen-label').textContent = on
    ? 'Salir de pantalla completa' : 'Pantalla completa';
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
  hud.hint(m ? 'AUDIO OFF' : 'AUDIO ON', 900);
};
input.onInvertChanged = (inv) => {
  hud.hint('EJE Y RATÓN: ' + (inv ? 'INVERTIDO' : 'NORMAL'), 1200);
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
const slVol = document.getElementById('sl-vol');
const slVolV = document.getElementById('sl-vol-v');
const chkInvert = document.getElementById('chk-invert');
const chkInvertPad = document.getElementById('chk-invert-pad');
let rebinding = null; // { cancel() }

function showControls(on) {
  mainCard.style.display = on ? 'none' : 'block';
  controlsCard.style.display = on ? 'block' : 'none';
  charCard.style.display = 'none';
  if (on) {
    renderBinds();
    slMouse.value = TUNING.cam.sens;
    slPad.value = TUNING.cam.padSens;
    slVol.value = audio.volume;
    chkInvert.checked = input.invertY;
    chkInvertPad.checked = input.invertYPad;
    updateSliderLabels();
  } else cancelRebind();
}
document.getElementById('btn-controls').addEventListener('click', () => showControls(true));
document.getElementById('btn-back').addEventListener('click', () => showControls(false));

// ---------- selección de personaje ----------
const charCard = document.getElementById('char-card');
const charSlots = document.getElementById('char-slots');

function showChar(on) {
  mainCard.style.display = on ? 'none' : 'block';
  controlsCard.style.display = 'none';
  charCard.style.display = on ? 'block' : 'none';
  if (on) buildCharUI();
}
document.getElementById('btn-character').addEventListener('click', () => showChar(true));
document.getElementById('btn-char-back').addEventListener('click', () => showChar(false));

function buildCharUI() {
  if (!charSlots.children.length) {
    for (let v = 0; v < 5; v++) {
      const b = document.createElement('button');
      b.className = 'char-slot';
      b.dataset.v = v;
      b.innerHTML = `<img alt="${CHAR_NAMES[v]}"><span>${CHAR_NAMES[v]}</span>`;
      b.addEventListener('click', () => {
        G.charVariant = v;
        localStorage.setItem('breach.character', String(v));
        updateCharSel();
        // en partida: el cambio aplica al instante (rig nuevo en el sitio)
        if (G.rig && G.player && G.mode) {
          G.rig.dispose(scene);
          G.rig = new Rig(scene, G.team, null, v);
          G.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y);
          G.rig.setWeapon(G.weapons.cur);
        }
      });
      charSlots.append(b);
    }
    renderCharPreviews();
  }
  updateCharSel();
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
document.getElementById('btn-reset-binds').addEventListener('click', () => { resetBinds(); renderBinds(); });

function updateSliderLabels() {
  slMouseV.textContent = Number(slMouse.value).toFixed(3);
  slPadV.textContent = slPad.value + '°/s';
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
    label.textContent = KB_LABELS[action];
    const btn = document.createElement('button');
    btn.className = 'bind-btn';
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
    label.textContent = PAD_LABELS[action];
    const btn = document.createElement('button');
    btn.className = 'bind-btn';
    btn.textContent = padBtnName(BINDS.pad[action]);
    btn.addEventListener('click', () => startRebindPad(action, btn));
    row.append(label, btn);
    padRows.append(row);
  }
}

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
      if (typeof obj[k] === 'number') folder.add(obj, k);
      else if (typeof obj[k] === 'object') addRec(obj[k], folder.addFolder(k));
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

function teardown() {
  if (G.rig) { G.rig.dispose(scene); G.rig = null; }
  if (G.dummies) { G.dummies.dispose(); G.dummies = null; }
  if (G.botMatch) { G.botMatch.dispose(); G.botMatch = null; }
  if (G.crates) { G.crates.dispose(); G.crates = null; }
  if (G.drops) { G.drops.dispose(); G.drops = null; }
  G.player = null; // sin referencias a caras de un mapa destruido
  G.fireBuffer = 0;
  G.spawnProt = 0;
  G.respawnT = 0;
  hud.respawnTick(null);
  hud.centerOff();  // sin "GANA ROJO" colándose a la partida siguiente
  hud.clearFeed();
  hud.timer(null);
  hud.roundPips(null);
  hud.scoreboard(null);
  for (const r of G.remotes.values()) r.dispose(scene);
  G.remotes.clear();
  if (G.net) { G.net.close(); G.net = null; }
  G.scores = { red: 0, blue: 0 };
  G.selfHp = TUNING.combat.hp;
  G.selfAlive = true;
  G.dropSeq = 0;
  G.playerLastHit = 99;
  G.footAcc = 0;
}

function spawnLocal(team, spawn) {
  G.team = team;
  G.rig = new Rig(scene, team, null, G.charVariant);
  G.rig.groundFn = (x, z, y) => world.groundHeight({ x, z }, PLAYER_R, y);
  G.rig.collideFn = (p, y) => world.resolveCircle(p, 0.3, y);
  G.player = new Controller(world, shoulderCam, ctrlEvents);
  G.player.respawn(spawn);
  G.weapons.reset();
  G.rig.setWeapon('smg');
}

function grantSpawnProtection() {
  G.spawnProt = TUNING.combat.spawnProtection;
  hud.hint('PROTECCIÓN DE SPAWN — SE ROMPE AL DISPARAR', 2200);
}

function damagePlayerLocal(dmg, fromName, shooter) {
  if (!G.selfAlive) return false;
  if (G.spawnProt > 0) return false; // protegido: sin daño
  G.selfHp -= dmg;
  G.playerLastHit = 0;
  audio.hurt();
  shoulderCam.addShake(0.35);
  input.pad.rumble(120, 0.4, 0.6);
  if (G.selfHp <= 0) {
    G.selfHp = 0;
    G.selfAlive = false;
    // contexto físico de la muerte ANTES de matar (kill() borra la velocidad):
    // dirección del tiro, potencia del golpe final, momentum y estado
    G.rig.setDeathContext({
      impact: shooter
        ? { x: G.player.pos.x - shooter.x, z: G.player.pos.z - shooter.z }
        : null,
      power: Math.min(1, dmg / 55),
      vel: { x: G.player.vel.x, z: G.player.vel.z },
      state: G.player.animState(),
    });
    G.player.kill();
    audio.death();
    input.pad.rumble(350, 0.8, 1.0);
    // countdown solo si de verdad queda respawn en el pool del equipo
    if (!G.botMatch || G.botMatch.pool.red > 0) {
      G.respawnT = TUNING.combat.respawnTime;
    } else {
      G.respawnT = 0;
      hud.center('SIN VIDAS', 'esperando el final de la ronda', 4500);
    }
    // el arma se le CAE de las manos durante el desplome (~0.28s), no aparece
    // teletransportada al piso en el frame de la muerte
    const dropAt = { x: G.player.pos.x, z: G.player.pos.z, y: world.groundHeight(G.player.pos, PLAYER_R, G.player.y) };
    const wep = G.weapons.cur, mag = G.weapons.st.mag, res = G.weapons.st.reserve;
    const id = 'p' + G.dropSeq++;
    setTimeout(() => {
      G.drops?.spawn(id, wep, dropAt.x, dropAt.z, 'red', mag, res, undefined, dropAt.y);
    }, 280);
    return true;
  }
  return false;
}

function startBots() {
  dismissSplash();
  audio.ensure();
  enterFullscreen();
  startSeq++;
  teardown();
  G.name = saveName();
  world.setLayout(G.mapChoice); // mapa elegido en el menú
  G.mode = 'bots';
  spawnLocal('red', world.spawns.red[0]);
  G.selfHp = TUNING.combat.hp;
  G.selfAlive = true;
  G.playerLastHit = 99;
  G.crates = new AmmoCrates(scene, false, world.cratePos ?? undefined);
  G.drops = new WeaponDrops(scene);
  G.botMatch = new BotMatch(scene, world, {
    effects, audio, hud,
    playerName: G.name,
    stepSound,
    dropWeapon: (wep, x, z, team, y = 0) => {
      // los bots no llevan contador de balas: sueltan un remanente plausible.
      // El drop aparece cuando el arma se le CAE de las manos (~0.28s), en
      // sincronía con el ragdoll — no teletransportada al morir
      const def = TUNING.weapons[wep];
      const id = 'b' + G.dropSeq++;
      const gy = world.groundHeight({ x, z }, PLAYER_R, y);
      setTimeout(() => {
        G.drops?.spawn(id, wep, x, z, team,
          Math.ceil(def.mag * (0.2 + Math.random() * 0.6)),
          Math.ceil(def.reserve * Math.random() * 0.4), undefined, gy);
      }, 280);
    },
    player: () => ({
      x: G.player.pos.x, z: G.player.pos.z, y: G.player.y, alive: G.selfAlive,
      // agachado tras cover bajo: hitbox reducida (la cabeza ya no flota
      // sobre el bloque invisible para los bots)
      crouch: G.player.animState() === 'cover_low',
    }),
    damagePlayer: (dmg) => damagePlayerLocal(dmg),
    respawnPlayer: (spawn) => {
      G.selfAlive = true;
      G.selfHp = TUNING.combat.hp;
      G.respawnT = 0;
      G.player.respawn(spawn);
      G.weapons.reset();
      grantSpawnProtection();
    },
    onMatchEnd: () => {
      const bm = G.botMatch; // identidad, no modo: el string 'bots' también
      setTimeout(() => {     // es cierto para una partida NUEVA (la mataba)
        if (!bm || G.botMatch !== bm) return;
        G.mode = null;
        teardown();
        showMenuBackdrop();
        hud.show(false);
        input.releaseLock(); // en el menú principal el cursor queda libre
        openMenu();
      }, 6500);
    },
  });
  hud.showMenu(false);
  showControls(false);
  hud.show(true);
  input.requestLock();
  setTimeout(() => hud.hint('TAB / VIEW: MARCADOR', 2800), 3400);
}

function startPractice() {
  dismissSplash();
  audio.ensure();
  enterFullscreen();
  startSeq++;
  teardown();
  G.name = saveName();
  world.setLayout(G.mapChoice); // mapa elegido en el menú
  G.mode = 'practice';
  spawnLocal('red', world.spawns.red[1]);
  G.dummies = new Dummies(scene);
  G.crates = new AmmoCrates(scene, false, world.cratePos ?? undefined);
  hud.showMenu(false);
  showControls(false);
  hud.show(true);
  hud.score(0, 0);
  hud.center('PRÁCTICA', 'blancos móviles en el lado azul', 2600);
  input.requestLock();
  setTimeout(() => hud.hint('EJE Y: ' + (input.invertY ? 'INVERTIDO' : 'NORMAL') + ' — F9 CAMBIA', 3000), 3000);
}

async function startOnline() {
  dismissSplash();
  audio.ensure();
  enterFullscreen();
  G.name = saveName();
  const url = inServer.value.trim();
  if (!url) { netStatus.textContent = 'Escribe la URL del servidor (npm run server)'; return; }
  localStorage.setItem('breach.server', url);
  netStatus.textContent = 'Conectando…';
  const net = new NetClient();
  bindNet(net);
  const mySeq = ++startSeq;
  try {
    const welcome = await net.connect(url, G.name, G.charVariant);
    // si durante el await el usuario arrancó OTRA partida (vs bots, práctica),
    // este welcome tardío no debe secuestrarla
    if (startSeq !== mySeq) { net.close(); return; }
    teardown();
    world.setLayout('fortaleza'); // mapa grande de multijugador
    G.net = net;
    G.mode = 'online';
    spawnLocal(welcome.team, welcome.spawn);
    G.crates = new AmmoCrates(scene, true); // online: el server manda
    if (welcome.crates) welcome.crates.forEach((up, i) => G.crates.setState(i, !!up));
    G.drops = new WeaponDrops(scene);
    if (welcome.drops) for (const d of welcome.drops) G.drops.spawn(d.id, d.wep, d.x, d.z, d.team, 0, 0, d.t, d.y || 0);
    grantSpawnProtection();
    G.scores = welcome.scores;
    for (const p of welcome.players) {
      if (p.id !== net.id) addRemote(p);
    }
    hud.showMenu(false);
    showControls(false);
    hud.show(true);
    hud.score(G.scores.red, G.scores.blue);
    hud.center('EQUIPO ' + (welcome.team === 'red' ? 'ROJO' : 'AZUL'), 'primero a ' + TUNING.combat.killLimit, 2600);
    netStatus.textContent = '';
    input.requestLock();
    setTimeout(() => hud.hint('EJE Y: ' + (input.invertY ? 'INVERTIDO' : 'NORMAL') + ' — F9 CAMBIA', 3000), 3000);
  } catch (e) {
    if (!netStatus.textContent.startsWith('Servidor lleno')) {
      netStatus.textContent = 'Error: ' + e.message;
    }
  }
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
  r.rig.collideFn = (pt, y) => world.resolveCircle(pt, 0.3, y);
  r.alive = p.alive !== false;
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
  net.on('joined', (m) => { if (alive() && m.id !== net.id) { addRemote(m); hud.hint(m.name + ' ENTRÓ', 1400); } });
  net.on('left', (m) => {
    if (!alive()) return;
    const r = G.remotes.get(m.id);
    if (r) { r.dispose(scene); G.remotes.delete(m.id); }
  });
  net.on('snap', (m) => {
    if (!alive()) return;
    for (const p of m.ps) {
      if (p.id === net.id) {
        // G.selfAlive: el golpe mortal ya sonó con 'death' — sin el guard
        // sonaba hurt + shake + rumble sobre un jugador ya muerto
        if (p.hp < G.selfHp && G.selfAlive) { audio.hurt(); shoulderCam.addShake(0.4); input.pad.rumble(140, 0.5, 0.7); }
        G.selfHp = p.hp;
        continue;
      }
      const r = G.remotes.get(p.id);
      if (r) { r.push(p); r.alive = !!p.alive; }
    }
  });
  net.on('fire', (m) => {
    if (!alive() || m.id === net.id) return;
    // validar: un cliente malicioso podía mandar o/p malformados y reventar
    // el handler de todos los demás
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));
    if (!okVec(m.o) || !okVec(m.p)) return;
    const o = new THREE.Vector3(...m.o), p = new THREE.Vector3(...m.p);
    effects.tracer(o, p);
    effects.muzzleFlash(o, m.w === 'shotgun');
    if (m.w === 'shotgun') audio.shotgun(); else audio.smg();
    const r = G.remotes.get(m.id);
    if (r) r.firing = 0.45;
  });
  net.on('death', (m) => {
    if (!alive() || !G.player) return;
    const isSelf = m.target === net.id;
    const victim = isSelf ? null : G.remotes.get(m.target);
    // sin víctima conocida y no soy yo: solo killfeed (el fallback anterior
    // reventaba la sangre encima del jugador local)
    if (victim || isSelf) {
      const pos = victim ? { x: victim.x, z: victim.z } : G.player.pos;
      const vteam = victim ? victim.team : G.team;
      if (m.gib) effects.gib(new THREE.Vector3(pos.x, 0, pos.z), TEAM_HEX[vteam]);
      else effects.blood(new THREE.Vector3(pos.x, 1, pos.z), TEAM_HEX[vteam]);
    }
    hud.kill(m.kn, m.kt, m.vn, m.vt);
    // contexto físico para el ragdoll (dirección del tiro + momentum previo)
    const killer = m.from === net.id
      ? { x: G.player.pos.x, z: G.player.pos.z }
      : (() => { const k = G.remotes.get(m.from); return k ? { x: k.x, z: k.z } : null; })();
    if (victim) {
      // velocidad aproximada del remoto desde sus últimos snapshots
      const b = victim.buf;
      let rv = { x: 0, z: 0 };
      if (b.length >= 2) {
        const s1 = b[b.length - 2], s2 = b[b.length - 1];
        const dt2 = Math.max(0.03, s2.rt - s1.rt);
        rv = { x: (s2.x - s1.x) / dt2, z: (s2.z - s1.z) / dt2 };
      }
      victim.rig.setDeathContext({
        impact: killer ? { x: victim.x - killer.x, z: victim.z - killer.z } : null,
        power: m.gib ? 1 : 0.6,
        vel: rv,
        state: victim.st,
      });
    }
    if (m.target === net.id) {
      G.selfAlive = false;
      G.rig.setDeathContext({
        impact: killer ? { x: G.player.pos.x - killer.x, z: G.player.pos.z - killer.z } : null,
        power: m.gib ? 1 : 0.6,
        vel: { x: G.player.vel.x, z: G.player.vel.z },
        state: G.player.animState(),
      });
      G.player.kill();
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
      hud.hint('MUNICIÓN COMPLETA', 1400);
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
    const s = G.weapons.state[m.wep];
    const total = (m.mag || 0) + (m.res || 0);
    const gained = Math.min(def.reserve, s.reserve + total) - s.reserve;
    s.reserve += gained;
    audio.reloadDone();
    hud.hint('+' + gained + ' BALAS DE ' + def.name, 1500);
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
      grantSpawnProtection();
      hud.centerOff();
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
  net.on('score', (m) => { if (alive()) { G.scores = { red: m.red, blue: m.blue }; hud.score(m.red, m.blue); } });
  net.on('win', (m) => {
    if (!alive()) return;
    audio.win();
    hud.center('GANA ' + (m.team === 'red' ? 'ROJO' : 'AZUL'), 'reiniciando…', 4000);
  });
  net.on('full', () => { netStatus.textContent = 'Servidor lleno (8/8)'; });
  net.on('close', () => {
    if (!alive()) return; // un intento de conexión fallido no mata la partida en curso
    if (G.mode === 'online') {
      G.mode = null;
      teardown(); // limpiar escena completa (rigs remotos, drops, cajas)
      showMenuBackdrop();
      hud.show(false);
      openMenu(); // (no showMenu directo: dejaba visible un REANUDAR muerto)
      netStatus.textContent = 'Desconectado del servidor';
      input.releaseLock();
    }
  });
}

// ---------- pasos posicionales (bots / remotos) ----------
// Volumen por distancia + paneo estéreo según el lado respecto a la cámara:
// escuchas POR DÓNDE viene el que corre.
function stepSound(x, z, kind) {
  if (!G.player) return;
  const dx = x - G.player.pos.x, dz = z - G.player.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > 24) return;
  const vol = Math.pow(Math.max(0, 1 - d / 24), 1.4) * 0.8;
  const rt = shoulderCam.flatRight();
  const pan = Math.max(-0.85, Math.min(0.85, (dx * rt.x + dz * rt.z) / Math.max(3.5, d)));
  audio.footstep(kind, vol, pan);
}

// ---------- disparos ----------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function currentTargets() {
  if (G.mode === 'practice') return G.dummies ? G.dummies.targets() : [];
  if (G.mode === 'bots') return G.botMatch ? G.botMatch.targets() : [];
  const out = [];
  for (const r of G.remotes.values()) {
    if (r.team !== G.team) out.push({ id: r.id, x: r.x, z: r.z, y: r.y ?? 0, alive: r.alive, crouch: r.st === 'cover_low' });
  }
  return out;
}

function falloff(def, dist) {
  if (!def.falloffStart) return 1;
  if (dist <= def.falloffStart) return 1;
  if (dist >= def.falloffEnd) return 0;
  return 1 - (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart);
}

// Dirección de hipfire/blindfire: paralela a la cámara, con ORIGEN en el cañón
// (Gears 5: la mira sigue a la cámara; el personaje rota para acompañarla).
function hipDir() {
  const f = shoulderCam.flatForward();
  const p = shoulderCam.pitch;
  const cp = Math.cos(p), sp = Math.sin(p);
  return new THREE.Vector3(f.x * cp, sp, f.z * cp).normalize();
}

function fireShot() {
  const w = G.weapons, def = w.def;
  const aiming = G.player.aim;
  const inCover = G.player.state === 'cover';
  const spread = aiming ? def.spreadAim : (inCover ? def.spreadBlind : def.spreadHip);

  const muzzle = G.rig.muzzleWorld(_v1).clone();
  let baseDir, origin;
  if (aiming) {
    const ray = shoulderCam.aimRay();
    baseDir = ray.dir.clone();
    // origen en cámara para precisión, tracer desde el cañón
    origin = ray.origin.clone();
  } else {
    baseDir = hipDir();
    origin = muzzle.clone();
    const f = G.player.cover;
    if (inCover && f && f.h <= TUNING.cover.lowHeight) {
      // blindfire SOBRE el bloque bajo: origen encima del borde, DENTRO de la
      // huella del bloque propio (más allá del bloque permitía disparar a
      // través de él contra blancos en esa banda)
      origin.set(
        G.player.pos.x - f.n.x * 0.45,
        f.h + 0.14,
        G.player.pos.z - f.n.z * 0.45,
      );
    } else {
      // desde cover alto el cañón puede estar dentro del collider: adelantar
      if (inCover) origin.addScaledVector(baseDir, 0.4);
      // pegado a una pared el cañón la atraviesa: disparar desde el punto de
      // contacto (los impactos se ven en la pared en vez de "no disparar")
      const chest = G.rig.aimRig.getWorldPosition(_v3);
      const toM = origin.clone().sub(chest);
      const mLen = toM.length();
      if (mLen > 0.01) {
        toM.normalize();
        const tb = world.raycast(chest, toM, mLen);
        if (tb !== null) {
          origin.copy(chest).addScaledVector(toM, Math.max(0.05, tb - 0.03));
          muzzle.copy(origin); // flash y tracer desde el punto visible
        }
      }
    }
  }

  const targets = currentTargets();
  const dmgByTarget = new Map();
  let anyPoint = null;

  for (let i = 0; i < def.pellets; i++) {
    const dir = applySpread(baseDir, spread);
    const hit = resolveShot(world, targets, origin, dir, def.range, null);
    anyPoint = hit.point;
    effects.tracer(muzzle, hit.point);
    if (hit.kind === 'world') effects.impact(hit.point);
    if (hit.kind === 'player') {
      let dmg = def.dmg * falloff(def, hit.t);
      if (hit.part === 'head') dmg *= def.headMult;
      const e = dmgByTarget.get(hit.id) || { dmg: 0, part: hit.part, dist: hit.t, point: hit.point };
      e.dmg += dmg;
      if (hit.part === 'head') e.part = 'head';
      dmgByTarget.set(hit.id, e);
    }
  }

  // disparar rompe la protección de spawn
  if (G.spawnProt > 0) { G.spawnProt = 0; hud.hint('PROTECCIÓN ROTA', 900); }

  // feedback de disparo
  effects.muzzleFlash(muzzle, w.cur === 'shotgun');
  if (w.cur === 'shotgun') { audio.shotgun(); input.pad.rumble(90, 0.5, 0.9); }
  else { audio.smg(); input.pad.rumble(45, 0.2, 0.4); }
  G.rig.kick(def.recoil * 0.5);
  shoulderCam.addShake(def.recoil * TUNING.cam.shakeFire);
  shoulderCam.pitch = Math.min(TUNING.cam.pitchMax * Math.PI / 180,
    shoulderCam.pitch + def.recoil * 0.006);

  // aplicar daño
  let hitSomeone = false;
  for (const [id, e] of dmgByTarget) {
    if (e.dmg <= 0) continue;
    hitSomeone = true;
    const gib = w.cur === 'shotgun' && e.dist <= TUNING.weapons.shotgun.gibRange;
    if (G.mode === 'practice') {
      effects.blood(e.point, TEAM_HEX.blue);
      const killed = G.dummies.damage(id, e.dmg, (d) => {
        G.scores.red++;
        hud.score(G.scores.red, G.scores.blue);
        hud.kill(G.name, 'red', d.name, 'blue');
        audio.kill();
        if (gib) effects.gib(new THREE.Vector3(d.x, 0, d.z), TEAM_HEX.blue);
      });
      if (!killed) audio.hit();
    } else if (G.mode === 'bots' && G.botMatch) {
      const killed = G.botMatch.damageBot(id, e.dmg, 'player', gib);
      if (!killed) audio.hit();
    } else if (G.net) {
      const r = G.remotes.get(id);
      if (r) effects.blood(e.point, TEAM_HEX[r.team]);
      G.net.hit(id, e.dmg, e.part, gib);
      audio.hit();
    }
  }
  if (hitSomeone) hud.hitmarker();

  // replicar visual
  if (G.net && anyPoint) G.net.fire(muzzle, anyPoint, w.cur);
}

// ---------- retícula de cañón (shoot from the barrel) ----------
let dotX = 0, dotY = 0, dotWasOn = false;

function updateReticle() {
  const p = G.player;
  const canShow = p && !p.dead && G.mode && !menuIsOpen() &&
    p.state !== 'roadie' && p.state !== 'dive' && p.state !== 'slide';
  if (!canShow) { hud.reticle(false, null); dotWasOn = false; return; }

  if (p.aim) {
    // ADS: anillo del tamaño real del cono de dispersión del arma,
    // atenuado si el punto apuntado queda fuera de su rango efectivo
    dotWasOn = false;
    const def = G.weapons.def;
    const ringPx = Math.tan(def.spreadAim * Math.PI / 180) /
      Math.tan(camera.fov * Math.PI / 360) * (innerHeight / 2);
    const ray = shoulderCam.aimRay();
    const t = world.raycast(ray.origin, ray.dir, 200) ?? 200;
    hud.reticle(true, null, { r: Math.min(190, ringPx), inRange: t <= def.range });
    return;
  }

  // hip/blind: punto proyectado ESTABLE — origen fijo en el pecho (no cambia
  // con la pose del arma), solo contra geometría (no "pesca" enemigos) y
  // con suavizado de pantalla para que nunca brinque
  const dir = hipDir();
  G.rig.root.updateWorldMatrix(true, true);
  let origin;
  const cf = p.cover;
  if (p.state === 'cover' && cf && cf.h <= TUNING.cover.lowHeight) {
    // la retícula usa el mismo origen que el blindfire: sobre el borde del bloque
    origin = _v1.set(p.pos.x - cf.n.x * 0.45, cf.h + 0.14, p.pos.z - cf.n.z * 0.45);
  } else {
    origin = G.rig.aimRig.getWorldPosition(_v1)
      .addScaledVector(dir, p.state === 'cover' ? 0.9 : 0.3);
  }
  const t = world.raycast(origin, dir, 60) ?? 60;
  _v3.copy(origin).addScaledVector(dir, t).project(camera);
  if (_v3.z > 1) { hud.reticle(false, null); dotWasOn = false; return; }
  const tx = (_v3.x * 0.5 + 0.5) * innerWidth;
  const ty = (-_v3.y * 0.5 + 0.5) * innerHeight;
  if (!dotWasOn) { dotX = tx; dotY = ty; dotWasOn = true; }
  else { dotX += (tx - dotX) * 0.4; dotY += (ty - dotY) * 0.4; }
  hud.reticle(false, { x: dotX, y: dotY });
}

// ---------- loop principal ----------
let last = performance.now();

// handle de debug/testing
window.BREACH = G;
window.BREACH_INPUT = input;
window.BREACH_CAM = camera;
window.BREACH_AUDIO = audio;
window.BREACH_WORLD = world;
window.BREACH_RIG = Rig; // para tests visuales de poses/animaciones
window.THREE = THREE;

function angDiff(a, b) {
  // módulo, no while: un delta gigante (dato corrupto) colgaba el bucle
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function simStep(dt) {
  const p = G.player;
  if (!p) return;

  // (el flip Matrix SÍ permite disparar en el aire)
  const stateOk = !p.dead && p.state !== 'dive' && p.state !== 'slide' &&
    p.state !== 'roadie' && input.anyDevice;
  // giro brusco: el tiro de CADERA espera solo si el cuerpo apunta casi de
  // espaldas (el trigger fuerza el giro rápido). Apuntando (ADS) nunca se
  // bloquea: la bala sale de la cámara.
  const maxA = TUNING.combat.fireAlignMaxDeg * Math.PI / 180;
  const aligned = p.aim || Math.abs(angDiff(shoulderCam.yaw, p.yaw)) < maxA;
  const canFire = stateOk && aligned;
  // cualquier click que no pueda salir YA (roadie, cuerpo girando, cooldown,
  // dive/slide, final de recarga) queda bufereado — y el buffer dura AL MENOS
  // lo que falta de cooldown/recarga, para que el tiro encolado nunca se pierda
  const wst = G.weapons.st;
  const relRemain = G.weapons.reloading ? wst.reload : 0;
  if (input.firePressed && !p.dead &&
      (!canFire || wst.cd > 0 || (relRemain > 0 && relRemain < 0.45))) {
    G.fireBuffer = Math.max(0.3, wst.cd + 0.06, relRemain + 0.06);
  }
  G.fireBuffer = Math.max(0, G.fireBuffer - dt);
  const wasReloading = G.weapons.reloading;

  // sin poder disparar YA, el gatillo no debe forzar pose de tiro: ni seco
  // total (mantenía blind_over y bloqueaba el roadie) ni RECARGANDO (un click
  // latcheaba la pose los ~2s de recarga, asomándote expuesto sobre el cover)
  const hasAmmo = !G.weapons.reloading &&
    (G.weapons.st.mag > 0 || G.weapons.st.reserve > 0);
  const fired = p.dead ? false
    : G.weapons.update(dt, input.fireHeld, input.firePressed || G.fireBuffer > 0, canFire);
  if (fired) G.fireBuffer = 0;
  // la intención de disparo SIEMPRE llega al controller: cancela el roadie
  // (en tierra o en el aire) y gira el cuerpo para disparar
  p.update(dt, input, (input.fireHeld || G.fireBuffer > 0) && !p.dead && hasAmmo);
  if (fired) fireShot();

  if (input.reloadPressed) G.weapons.startReload();
  if (!wasReloading && G.weapons.reloading) audio.reload(); // incluye auto-recarga
  if (wasReloading && !G.weapons.reloading) audio.reloadDone();

  // práctica = munición de reserva infinita (nunca te quedas sin disparar)
  if (G.mode === 'practice') {
    for (const k of ['smg', 'shotgun']) {
      G.weapons.state[k].reserve = TUNING.weapons[k].reserve;
    }
  }
  if (input.swapPressed && !p.dead && G.weapons.startSwap()) audio.reload();

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
      hud.hint('+' + gained + ' BALAS DE ' + def.name, 1500);
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
      hud.hint('MUNICIÓN COMPLETA', 1400);
      input.pad.rumble(60, 0.2, 0.3);
    });
  }

  if (G.botMatch) {
    G.botMatch.update(dt);
    // regen del jugador (igual que online, pero local)
    G.playerLastHit += dt;
    if (G.selfAlive && G.playerLastHit > TUNING.combat.regenDelay && G.selfHp < TUNING.combat.hp) {
      G.selfHp = Math.min(TUNING.combat.hp, G.selfHp + TUNING.combat.regenRate * dt);
    }
  }
  if (G.net) G.net.tickState(dt, p, G.weapons);

  input.consumeEdges();
}

let padWasConnected = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const menuOpen = menuIsOpen();
  if (!G.mode) updateMenuBackdrop(now);
  input.suppress = menuOpen; // con menú abierto los inputs de juego se ignoran
  input.pollPad(dt, !!G.mode && !menuOpen);

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
    hud.hint(padWasConnected ? 'CONTROL CONECTADO' : 'CONTROL DESCONECTADO', 1600);
    if (!padWasConnected) {
      padStatus.textContent = 'SIN CONTROL DETECTADO';
      padStatus.classList.remove('on');
    }
  }
  // diagnóstico en vivo con el panel de controles abierto: id, mapping,
  // ejes y botones presionados (para depurar pads raros/fantasma)
  if (input.pad.connected && input.pad.info && controlsCard.style.display === 'block') {
    const i = input.pad.info;
    padStatus.textContent =
      i.id + ' · ' + i.mapping +
      ' · ejes [' + [...i.axes].slice(0, 4).map((a) => a.toFixed(1)).join(', ') + ']' +
      ' · botones [' + (i.pressed.join(',') || '—') + ']';
    padStatus.classList.add('on');
  }
  if (menuOpen) input.consumeEdges();

  if (G.mode && G.player) {
    if (!menuOpen) {
      if (input.locked || input.lockDisabled) shoulderCam.applyMouse(input.mouseDX, input.mouseDY, input.invertY);
      if (input.pad.connected) shoulderCam.applyStick(input.pad.camX, input.pad.camY, dt, input.invertYPad);
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

    shoulderCam.update(dt, G.player);
    G.rig.setWeapon(G.weapons.cur); // el intercambio real ocurre a mitad del gesto
    // protección de spawn: highlight sutil en el color del equipo
    G.rig.root.visible = true;
    G.rig.setProtected(G.spawnProt > 0);
    G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
    G.rig.update(dt, {
      ...G.player.animParams(),
      swapping: G.weapons.swapping,
      reloading: G.weapons.reloading,
      reloadT: G.weapons.reloading ? 1 - G.weapons.st.reload / G.weapons.def.reloadTime : 0,
    });
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
          stepSound(r.x, r.z, roadie ? 'roadie' : 'run');
        }
      } else {
        r._facc = 0;
      }
      if (r._wasAir && !airborne && r.alive) stepSound(r.x, r.z, 'land');
      r._wasAir = airborne;
    }

    hud.ammo(G.weapons);
    hud.health(G.mode === 'online' || G.mode === 'bots' ? G.selfHp / TUNING.combat.hp : 1);
    // countdown grande de reaparición (no en fin de ronda/partida: ahí la
    // cola de respawns se vació y el contador mentía, pisando "ROUND PARA…")
    const bmPhase = G.botMatch?.phase;
    if (!G.selfAlive && G.respawnT > 0 && bmPhase !== 'over' && bmPhase !== 'intermission') {
      hud.respawnTick(Math.ceil(G.respawnT));
    } else {
      hud.respawnTick(null);
    }
    if (G.mode === 'bots' && G.botMatch) {
      hud.score(G.botMatch.livesOf('red'), G.botMatch.livesOf('blue'));
      hud.timer(G.botMatch.timer);
      hud.roundPips(G.botMatch.wins.red, G.botMatch.wins.blue);
      hud.scoreboard(input.scoreHeld && !menuOpen ? G.botMatch.statRows() : null);
    }
    updateReticle();
  }

  effects.update(dt);
  renderer.render(scene, camera);
  input.endFrame();
}
requestAnimationFrame(frame);
