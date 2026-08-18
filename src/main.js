// BREACH — vertical slice. Orquesta mundo, jugador, combate, red y UI.
import * as THREE from 'three';
import GUI from 'lil-gui';
import { TUNING, TUNING_DEFAULTS } from './config/tuning.js';
import { BINDS, KB_LABELS, PAD_LABELS, keyLabel, padBtnName, loadBinds, saveBinds, resetBinds } from './core/bindings.js';
import { Input } from './core/input.js';
import { ShoulderCamera } from './core/camera.js';
import { World } from './world/world.js';
import { Rig } from './player/rig.js';
import { Controller, PLAYER_R } from './player/controller.js';
import { RemotePlayer } from './player/remote.js';
import { Dummies } from './player/practice.js';
import { Weapons } from './combat/weapons.js';
import { resolveShot, applySpread } from './combat/ballistics.js';
import { Effects } from './fx/effects.js';
import { Audio } from './fx/audio.js';
import { HUD } from './ui/hud.js';
import { NetClient } from './net/client.js';

const TEAM_HEX = { red: 0xd94f3f, blue: 0x4f8de0 };

// ---------- setup base ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.cam.fovNormal, 1, 0.1, 200);
const world = new World(scene);
const effects = new Effects(scene);
const audio = new Audio();
const hud = new HUD();
const input = new Input(canvas);
const shoulderCam = new ShoulderCamera(camera, world);

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
  remotes: new Map(),  // id -> RemotePlayer
  net: null,
  selfHp: TUNING.combat.hp,
  selfAlive: true,
  scores: { red: 0, blue: 0 },
  team: 'red',
  name: 'CHUCK',
  footAcc: 0,
  wasReloading: false,
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
};

// ---------- menú ----------
loadBinds();
{
  const sm = parseFloat(localStorage.getItem('breach.sens.mouse'));
  if (sm > 0) TUNING.cam.sens = sm;
  const sp = parseFloat(localStorage.getItem('breach.sens.pad'));
  if (sp > 0) TUNING.cam.padSens = sp;
}

const inName = document.getElementById('in-name');
const inServer = document.getElementById('in-server');
const netStatus = document.getElementById('net-status');
inName.value = localStorage.getItem('breach.name') || 'CHUCK';
const isSecure = location.protocol === 'https:';
inServer.value = localStorage.getItem('breach.server') ||
  (isSecure ? '' : `ws://${location.hostname}:8787`);

const mainCard = document.querySelector('#menu .menu-card');
const controlsCard = document.getElementById('controls-card');
const btnResume = document.getElementById('btn-resume');

const menuIsOpen = () => !hud.el.menu.classList.contains('off');

function openMenu() {
  hud.showMenu(true);
  showControls(false);
  btnResume.style.display = G.mode ? 'flex' : 'none';
  input.releaseLock();
}
function closeMenu() {
  if (!G.mode) return; // sin partida no hay a dónde volver
  hud.showMenu(false);
  showControls(false);
  cancelRebind();
  input.requestLock();
}

document.getElementById('btn-practice').addEventListener('click', () => startPractice());
document.getElementById('btn-online').addEventListener('click', () => startOnline());
btnResume.addEventListener('click', () => closeMenu());
document.getElementById('btn-pause').addEventListener('click', () => openMenu());

input.onEscape = () => {
  if (!G.mode) return;
  if (menuIsOpen()) closeMenu(); else openMenu();
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
const chkInvert = document.getElementById('chk-invert');
const chkInvertPad = document.getElementById('chk-invert-pad');
let rebinding = null; // { cancel() }

function showControls(on) {
  mainCard.style.display = on ? 'none' : 'block';
  controlsCard.style.display = on ? 'block' : 'none';
  if (on) {
    renderBinds();
    slMouse.value = TUNING.cam.sens;
    slPad.value = TUNING.cam.padSens;
    chkInvert.checked = input.invertY;
    chkInvertPad.checked = input.invertYPad;
    updateSliderLabels();
  } else cancelRebind();
}
document.getElementById('btn-controls').addEventListener('click', () => showControls(true));
document.getElementById('btn-back').addEventListener('click', () => showControls(false));
document.getElementById('btn-reset-binds').addEventListener('click', () => { resetBinds(); renderBinds(); });

function updateSliderLabels() {
  slMouseV.textContent = Number(slMouse.value).toFixed(3);
  slPadV.textContent = slPad.value + '°/s';
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
chkInvert.addEventListener('change', () => {
  input.invertY = chkInvert.checked;
  localStorage.setItem('breach.invertY', String(input.invertY));
});
chkInvertPad.addEventListener('change', () => {
  input.invertYPad = chkInvertPad.checked;
  localStorage.setItem('breach.invertYPad', String(input.invertYPad));
});

function cancelRebind() {
  if (rebinding) { rebinding.cancel(); rebinding = null; }
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
  const h = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', h, true);
    rebinding = null;
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
  const startPressed = new Set(input.pad.pressed);
  const t0 = performance.now();
  const iv = setInterval(() => {
    for (const b of input.pad.pressed) {
      if (!startPressed.has(b)) {
        clearInterval(iv);
        rebinding = null;
        BINDS.pad[action] = b;
        saveBinds();
        renderBinds();
        return;
      }
    }
    for (const b of startPressed) if (!input.pad.pressed.has(b)) startPressed.delete(b);
    if (performance.now() - t0 > 6000) { clearInterval(iv); rebinding = null; renderBinds(); }
  }, 30);
  rebinding = { cancel: () => clearInterval(iv) };
}

// ---------- panel de tuning (F10) ----------
let gui = null;
input.onToggleTuning = () => {
  if (gui) { gui.destroy(); gui = null; return; }
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
function teardown() {
  if (G.rig) { G.rig.dispose(scene); G.rig = null; }
  if (G.dummies) { G.dummies.dispose(); G.dummies = null; }
  for (const r of G.remotes.values()) r.dispose(scene);
  G.remotes.clear();
  if (G.net) { G.net.close(); G.net = null; }
  G.scores = { red: 0, blue: 0 };
  G.selfHp = TUNING.combat.hp;
  G.selfAlive = true;
}

function spawnLocal(team, spawn) {
  G.team = team;
  G.rig = new Rig(scene, team);
  G.player = new Controller(world, shoulderCam, ctrlEvents);
  G.player.respawn(spawn);
  G.weapons.reset();
  G.rig.setWeapon('lancer');
}

function startPractice() {
  audio.ensure();
  teardown();
  G.name = saveName();
  G.mode = 'practice';
  spawnLocal('red', world.spawns.red[1]);
  G.dummies = new Dummies(scene);
  hud.showMenu(false);
  showControls(false);
  hud.show(true);
  hud.score(0, 0);
  hud.center('PRÁCTICA', 'blancos móviles en el lado azul', 2600);
  input.requestLock();
  setTimeout(() => hud.hint('EJE Y: ' + (input.invertY ? 'INVERTIDO' : 'NORMAL') + ' — F9 CAMBIA', 3000), 3000);
}

async function startOnline() {
  audio.ensure();
  G.name = saveName();
  const url = inServer.value.trim();
  if (!url) { netStatus.textContent = 'Escribe la URL del servidor (npm run server)'; return; }
  localStorage.setItem('breach.server', url);
  netStatus.textContent = 'Conectando…';
  const net = new NetClient();
  bindNet(net);
  try {
    const welcome = await net.connect(url, G.name);
    teardown();
    G.net = net;
    G.mode = 'online';
    spawnLocal(welcome.team, welcome.spawn);
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
    netStatus.textContent = 'Error: ' + e.message;
  }
}

function saveName() {
  const n = (inName.value.trim() || 'CHUCK').toUpperCase();
  localStorage.setItem('breach.name', n);
  return n;
}

function addRemote(p) {
  const r = new RemotePlayer(scene, p.id, p.name, p.team);
  r.alive = p.alive !== false;
  G.remotes.set(p.id, r);
}

// ---------- red ----------
function bindNet(net) {
  net.on('joined', (m) => { if (m.id !== net.id) { addRemote(m); hud.hint(m.name + ' ENTRÓ', 1400); } });
  net.on('left', (m) => {
    const r = G.remotes.get(m.id);
    if (r) { r.dispose(scene); G.remotes.delete(m.id); }
  });
  net.on('snap', (m) => {
    for (const p of m.ps) {
      if (p.id === net.id) {
        if (p.hp < G.selfHp) { audio.hurt(); shoulderCam.addShake(0.4); input.pad.rumble(140, 0.5, 0.7); }
        G.selfHp = p.hp;
        continue;
      }
      const r = G.remotes.get(p.id);
      if (r) { r.push(p); r.alive = !!p.alive; }
    }
  });
  net.on('fire', (m) => {
    if (m.id === net.id) return;
    const o = new THREE.Vector3(...m.o), p = new THREE.Vector3(...m.p);
    effects.tracer(o, p);
    effects.muzzleFlash(o, m.w === 'gnasher');
    if (m.w === 'gnasher') audio.gnasher(); else audio.lancer();
    const r = G.remotes.get(m.id);
    if (r) r.firing = 0.45;
  });
  net.on('death', (m) => {
    const victim = m.target === net.id ? null : G.remotes.get(m.target);
    const pos = victim ? { x: victim.x, z: victim.z } : (G.player ? G.player.pos : { x: 0, z: 0 });
    const vteam = victim ? victim.team : G.team;
    if (m.gib) effects.gib(new THREE.Vector3(pos.x, 0, pos.z), TEAM_HEX[vteam]);
    else effects.blood(new THREE.Vector3(pos.x, 1, pos.z), TEAM_HEX[vteam]);
    hud.kill(m.kn, m.kt, m.vn, m.vt);
    if (m.target === net.id) {
      G.selfAlive = false;
      G.player.kill();
      audio.death();
      input.pad.rumble(350, 0.8, 1.0);
      hud.center('ELIMINADO', 'respawn en ' + TUNING.combat.respawnTime + 's', TUNING.combat.respawnTime * 1000);
    } else if (m.from === net.id) {
      audio.kill();
      hud.hitmarker();
    } else {
      audio.kill();
    }
  });
  net.on('respawn', (m) => {
    if (m.id === net.id) {
      G.selfAlive = true;
      G.selfHp = TUNING.combat.hp;
      G.player.respawn(m.spawn);
      G.weapons.reset();
      G.rig.setWeapon('lancer');
      hud.centerOff();
    } else {
      const r = G.remotes.get(m.id);
      if (r) r.alive = true;
    }
  });
  net.on('score', (m) => { G.scores = { red: m.red, blue: m.blue }; hud.score(m.red, m.blue); });
  net.on('win', (m) => {
    audio.win();
    hud.center('GANA ' + (m.team === 'red' ? 'ROJO' : 'AZUL'), 'reiniciando…', 4000);
  });
  net.on('full', () => { netStatus.textContent = 'Servidor lleno (8/8)'; });
  net.on('close', () => {
    if (G.mode === 'online') {
      G.mode = null;
      hud.show(false);
      hud.showMenu(true);
      netStatus.textContent = 'Desconectado del servidor';
      input.releaseLock();
    }
  });
}

// ---------- disparos ----------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function currentTargets() {
  if (G.mode === 'practice') return G.dummies.targets();
  const out = [];
  for (const r of G.remotes.values()) {
    if (r.team !== G.team) out.push({ id: r.id, x: r.x, z: r.z, y: r.y ?? 0, alive: r.alive });
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
    // desde cover el cañón puede estar dentro del collider: adelantar el origen
    if (inCover) origin.addScaledVector(baseDir, 0.4);
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

  // feedback de disparo
  effects.muzzleFlash(muzzle, w.cur === 'gnasher');
  if (w.cur === 'gnasher') { audio.gnasher(); input.pad.rumble(90, 0.5, 0.9); }
  else { audio.lancer(); input.pad.rumble(45, 0.2, 0.4); }
  G.rig.kick(def.recoil * 0.5);
  shoulderCam.addShake(def.recoil * TUNING.cam.shakeFire);
  shoulderCam.pitch += def.recoil * 0.006;

  // aplicar daño
  let hitSomeone = false;
  for (const [id, e] of dmgByTarget) {
    if (e.dmg <= 0) continue;
    hitSomeone = true;
    const gib = w.cur === 'gnasher' && e.dist <= TUNING.weapons.gnasher.gibRange;
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
function updateReticle() {
  const p = G.player;
  const canShow = p && !p.dead && G.mode &&
    p.state !== 'roadie' && p.state !== 'dive' && p.state !== 'slide' && p.state !== 'flip';
  if (!canShow) { hud.reticle(false, null); return; }
  if (p.aim) { hud.reticle(true, null); return; }
  const dir = hipDir();
  // origen: el cañón real si está disparando / en cover; si está relajado
  // (low-ready), el pecho — donde quedará el arma al levantar a postura de tiro
  let muzzle;
  if (p.firingBlind > 0 || p.state === 'cover') {
    muzzle = _v1.copy(G.rig.muzzleWorld(_v2));
    if (p.state === 'cover') muzzle.addScaledVector(dir, 0.4);
  } else {
    G.rig.root.updateWorldMatrix(true, true);
    muzzle = G.rig.aimRig.getWorldPosition(_v1).addScaledVector(dir, 0.3);
  }
  const hit = resolveShot(world, currentTargets(), muzzle, dir, 60, null);
  _v3.copy(hit.point).project(camera);
  if (_v3.z > 1) { hud.reticle(false, null); return; }
  hud.reticle(false, {
    x: (_v3.x * 0.5 + 0.5) * innerWidth,
    y: (-_v3.y * 0.5 + 0.5) * innerHeight,
  });
}

// ---------- loop principal ----------
const FIXED = 1 / 60;
let acc = 0, last = performance.now();

// handle de debug/testing
window.BREACH = G;
window.BREACH_INPUT = input;
window.THREE = THREE;

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function simStep(dt) {
  const p = G.player;
  if (!p) return;

  const stateOk = !p.dead && p.state !== 'dive' && p.state !== 'slide' &&
    p.state !== 'roadie' && p.state !== 'flip' && input.anyDevice;
  // giro brusco: el tiro NO sale hasta que el cuerpo esté alineado con la
  // cámara (el trigger fuerza el giro rápido; nunca dispara "por la espalda")
  const maxA = TUNING.combat.fireAlignMaxDeg * Math.PI / 180;
  const aligned = Math.abs(angDiff(shoulderCam.yaw, p.yaw)) < maxA;
  const canFire = stateOk && aligned;
  if (input.firePressed && stateOk && !aligned) G.fireBuffer = 0.3;
  G.fireBuffer = Math.max(0, G.fireBuffer - dt);
  const wasReloading = G.weapons.reloading;

  const fired = G.weapons.update(dt, input.fireHeld, input.firePressed || G.fireBuffer > 0, canFire);
  if (fired) G.fireBuffer = 0;
  p.update(dt, input, (input.fireHeld || G.fireBuffer > 0) && stateOk);
  if (fired) fireShot();

  if (input.reloadPressed && G.weapons.startReload()) audio.reload();
  if (wasReloading && !G.weapons.reloading) audio.reloadDone();
  if (input.swapPressed && !p.dead) {
    G.weapons.swap();
    G.rig.setWeapon(G.weapons.cur);
    audio.reload();
  }

  // pasos: por distancia recorrida
  if ((p.state === 'run' || p.state === 'roadie') && p.speed > 1) {
    G.footAcc += p.speed * dt;
    const stride = p.state === 'roadie' ? 2.1 : 1.7;
    if (G.footAcc > stride) { G.footAcc = 0; audio.footstep(); }
  }

  if (G.dummies) G.dummies.update(dt);
  if (G.net) G.net.tickState(dt, p, G.weapons);

  input.consumeEdges();
}

let padWasConnected = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const menuOpen = menuIsOpen();
  input.pollPad(dt, !!G.mode && !menuOpen);
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
      if (input.locked) shoulderCam.applyMouse(input.mouseDX, input.mouseDY, input.invertY);
      if (input.pad.connected) shoulderCam.applyStick(input.pad.camX, input.pad.camY, dt, input.invertYPad);
    }

    // pausa real en práctica; online la partida sigue
    const paused = menuOpen && G.mode === 'practice';
    if (paused) {
      acc = 0;
    } else {
      acc += dt;
      let steps = 0;
      while (acc >= FIXED && steps < 5) { simStep(FIXED); acc -= FIXED; steps++; }
    }

    shoulderCam.update(dt, G.player);
    G.rig.setTransform(G.player.pos.x, G.player.pos.z, G.player.yaw, G.player.y);
    G.rig.update(dt, G.player.animParams());
    for (const r of G.remotes.values()) r.update(dt);

    hud.ammo(G.weapons);
    hud.health(G.mode === 'online' ? G.selfHp / TUNING.combat.hp : 1);
    updateReticle();
  }

  effects.update(dt);
  renderer.render(scene, camera);
  input.endFrame();
}
requestAnimationFrame(frame);
