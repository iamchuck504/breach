// Smoke test headless: carga el juego, entra a práctica, simula movimiento,
// evade y disparo, y captura screenshots. Reporta errores de consola/página.
// Uso: node scripts/smoke.mjs  (requiere dist/ y server corriendo, o levanta el suyo)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8791' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const errors = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
  });

  await page.goto('http://localhost:8791/?nolock=1', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-menu.png') });

  // atravesar el splash antes de usar el menú principal
  await page.click('#btn-enter');
  await page.waitForSelector('#splash.off', { state: 'attached' });

  // entrar a práctica
  await page.click('#btn-practice');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-spawn.png') });

  // moverse + roadie + evade + disparo
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-roadie.png') });
  await page.keyboard.press(' ');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-evade.png') });
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await page.mouse.move(640, 360);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-fire.png') });

  // ADS
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-aim.png') });
  await page.mouse.up({ button: 'right' });

  // ---- gamepad simulado: un pad FANTASMA (sin actividad) en el índice 0
  // y el pad real (stick adelante) en el índice 1 — debe adoptar el activo ----
  await page.evaluate(() => {
    const mkPad = (index, axes) => ({
      id: index === 0 ? 'PhantomPad' : 'FakePad', connected: true,
      mapping: 'standard', index, axes,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    });
    const phantom = mkPad(0, [0, 0, 0, 0]);
    const real = mkPad(1, [0, -1, 0, 0]);
    navigator.getGamepads = () => [phantom, real];
    window.__pad = real;
  });
  await page.waitForTimeout(400);
  const padOn = await page.evaluate(() => window.BREACH_INPUT.pad.connected);
  // a campo abierto (fuera de cover) para medir movimiento libre
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.cover = null; P.state = 'run'; P.pos.x = 0; P.pos.z = -6;
  });
  await page.waitForTimeout(150);
  const p0 = await page.evaluate(() => ({ x: window.BREACH.player.pos.x, z: window.BREACH.player.pos.z }));
  await page.waitForTimeout(1000);
  const p1 = await page.evaluate(() => ({ x: window.BREACH.player.pos.x, z: window.BREACH.player.pos.z }));
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const padCtx = await page.evaluate(() => ({
    st: window.BREACH.player.state,
    yaw: +window.BREACH.player.yaw.toFixed(2),
    cam: +window.BREACH.player.cam.yaw.toFixed(2),
    spd: +window.BREACH.player.speed.toFixed(2),
    padId: window.BREACH_INPUT.pad.info?.id,
  }));
  console.log('PAD:', JSON.stringify({ connected: padOn, moved: +moved.toFixed(2), ...padCtx }));
  if (!padOn) errors.push('PAD: no detectado');
  if (moved < 0.4) errors.push('PAD: el stick no movió al jugador (moved=' + moved.toFixed(2) + ')');
  if (padCtx.padId !== 'FakePad') errors.push('PAD: adoptó el pad fantasma en vez del activo (' + padCtx.padId + ')');
  await page.evaluate(() => { window.__pad.axes[1] = 0; });

  // ---- salto normal (F) y vuelta de gato contra el pilar central ----
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.cover = null; P.state = 'idle'; P.pos.x = 0; P.pos.z = -6;
  });
  await page.keyboard.press('f');
  await page.waitForTimeout(230);
  const jumpY = await page.evaluate(() => +window.BREACH.player.y.toFixed(2));
  console.log('JUMP:', JSON.stringify({ y: jumpY }));
  if (jumpY < 0.25) errors.push('JUMP: no despegó (y=' + jumpY + ')');
  await page.waitForTimeout(900); // aterrizar

  // Matrix kick: saltar HACIA la pared y en el aire volver a presionar salto
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.cover = null; P.state = 'idle'; P.pos.x = 0; P.pos.z = -1.45;
    P.cam.yaw = Math.PI; P.yaw = Math.PI; // de cara al pilar central
  });
  await page.waitForTimeout(80);
  await page.keyboard.press('f');      // salto normal
  await page.waitForTimeout(200);      // subiendo…
  await page.keyboard.press('f');      // patada de pared en el aire
  await page.waitForTimeout(160);
  const flip = await page.evaluate(() => ({
    st: window.BREACH.player.state,
    y: +window.BREACH.player.y.toFixed(2),
    z: +window.BREACH.player.pos.z.toFixed(2),
  }));
  console.log('WALLJUMP:', JSON.stringify(flip));
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-flip.png') });
  if (flip.st !== 'flip') errors.push('WALLJUMP: no entró en flip (st=' + flip.st + ')');
  if (flip.z > -1.5) errors.push('WALLJUMP: no se alejó de la pared (z=' + flip.z + ')');
  // disparar EN EL AIRE durante el flip
  const ammoBefore = await page.evaluate(() => window.BREACH.weapons.st.mag);
  await page.mouse.down();
  await page.waitForTimeout(180);
  await page.mouse.up();
  const ammoAfter = await page.evaluate(() => window.BREACH.weapons.st.mag);
  console.log('AIRFIRE:', JSON.stringify({ before: ammoBefore, after: ammoAfter }));
  if (ammoAfter >= ammoBefore) errors.push('AIRFIRE: no disparó durante el flip');
  await page.waitForTimeout(800); // aterrizar antes de seguir

  // doble salto: salto + dirección + salto = vuelta hacia esa dirección
  await page.evaluate(() => { const P = window.BREACH.player; P.pos.x = 0; P.pos.z = -6; });
  await page.keyboard.press('f');
  await page.waitForTimeout(180);
  await page.keyboard.down('d');
  await page.keyboard.press('f');
  await page.waitForTimeout(100);
  const dj = await page.evaluate(() => ({
    st: window.BREACH.player.state,
    axis: window.BREACH.player.flip?.axis,
    used: window.BREACH.player.usedDouble,
  }));
  await page.keyboard.up('d');
  console.log('DOUBLEJUMP:', JSON.stringify(dj));
  if (dj.st !== 'flip' || !dj.used) errors.push('DOUBLEJUMP: no hizo la vuelta (' + JSON.stringify(dj) + ')');
  if (dj.axis !== 'z') errors.push('DOUBLEJUMP: stick derecha debería dar giro lateral, dio ' + dj.axis);
  await page.waitForTimeout(800);

  // ---- MANTLE: cubierto tras un bloque BAJO + adelante+evadir = subirse ----
  await page.evaluate(() => {
    const G = window.BREACH, W = window.BREACH_WORLD;
    // cara LOW mirando a -z (el jugador se cubre desde el sur): buscar una
    const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
    const mx = (c => (c.a.x + c.b.x) / 2)(f), mz = (c => (c.a.z + c.b.z) / 2)(f);
    G.player.pos.x = mx; G.player.pos.z = mz - 1.2;
    G.player.cam.yaw = Math.PI; // mirando a +z (hacia el bloque)
    G.player.yaw = Math.PI;     // el cuerpo ya girado (el lerp tarda ~0.4s)
    G.player.vel.x = 0; G.player.vel.z = 0;
  });
  await page.waitForTimeout(250);
  // snap al cover pegado (reintento: el primer edge a veces cae en un frame
  // de transición del test anterior)
  let inCover = '';
  for (let i = 0; i < 3 && inCover !== 'cover'; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(320);
    inCover = await page.evaluate(() => window.BREACH.player.state);
  }
  await page.keyboard.down('w');      // hacia el bloque
  await page.waitForTimeout(150);
  let midMantle = '';
  for (let i = 0; i < 3 && midMantle !== 'mantle'; i++) {
    await page.keyboard.press('Space'); // + evadir = mantle
    await page.waitForTimeout(180);
    midMantle = await page.evaluate(() => window.BREACH.player.state);
  }
  await page.keyboard.up('w'); // soltar: seguir empujando te baja del bloque (0.9m)
  await page.waitForTimeout(650);
  const afterMantle = await page.evaluate(() => ({
    st: window.BREACH.player.state, y: +window.BREACH.player.y.toFixed(2),
  }));
  await page.keyboard.up('w');
  console.log('MANTLE:', JSON.stringify({ inCover, midMantle, ...afterMantle }));
  if (inCover !== 'cover') errors.push('MANTLE: no entró a cover (' + inCover + ')');
  if (midMantle !== 'mantle') errors.push('MANTLE: no inició el vault (' + midMantle + ')');
  if (afterMantle.y < 0.9) errors.push('MANTLE: no terminó ENCIMA del bloque (y=' + afterMantle.y + ')');
  await page.evaluate(() => { const P = window.BREACH.player; P.pos.x = 0; P.pos.z = -14; P.y = 0; });
  await page.waitForTimeout(400);

  // ---- EDGE-EXIT: correr + stick más allá del extremo = salir corriendo ----
  await page.evaluate(() => {
    const G = window.BREACH, W = window.BREACH_WORLD;
    const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
    const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
    const P = G.player;
    P.pos.x = mx; P.pos.z = mz - 1.2; P.y = 0;
    P.cam.yaw = Math.PI; P.yaw = Math.PI;
    P.vel.x = 0; P.vel.z = 0;
  });
  await page.waitForTimeout(250);
  let edgeCover = '';
  for (let i = 0; i < 3 && edgeCover !== 'cover'; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    edgeCover = await page.evaluate(() => window.BREACH.player.state);
  }
  await page.keyboard.down('a');
  await page.waitForTimeout(800);           // desplazarse hasta el extremo
  await page.keyboard.down('Shift');        // correr + lateral hacia fuera
  await page.waitForTimeout(400);
  const edgeExit = await page.evaluate(() => window.BREACH.player.state);
  await page.keyboard.up('a');
  await page.keyboard.up('Shift');
  console.log('EDGE-EXIT:', JSON.stringify({ edgeCover, edgeExit }));
  if (edgeCover !== 'cover') errors.push('EDGE-EXIT: no entró a cover');
  if (edgeExit !== 'roadie' && edgeExit !== 'run') {
    errors.push('EDGE-EXIT: no salió corriendo del extremo (' + edgeExit + ')');
  }
  await page.waitForTimeout(400);

  // ---- EVADE-READY: bloqueado durante el dive, listo al recuperar control ----
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.pos.x = 0; P.pos.z = -10; P.y = 0;
    P.cam.yaw = Math.PI; P.yaw = Math.PI;
    P.vel.x = 0; P.vel.z = 0; P.vy = 0; P.grounded = true;
    P.cover = null; P.slide = null; P.dive = null; P.mantle = null;
    P.state = 'idle'; P.stateT = 0; P.chain = 0; P.evadeCooldown = 0;
    window.__evadeFindCover = P.world.findCover;
    P.world.findCover = () => null;
  });
  await page.keyboard.down('s'); // alejándose de coberturas (dive al vacío)
  await page.waitForTimeout(80);
  await page.keyboard.press('Space');
  await page.waitForTimeout(40);
  const firstState = await page.evaluate(() => window.BREACH.player.state);
  await page.waitForTimeout(40);
  await page.keyboard.press('Space'); // durante el dive: no debe reiniciarlo
  await page.waitForTimeout(80);
  const activeState = await page.evaluate(() => window.BREACH.player.state);
  await page.waitForTimeout(240); // >0.36s total: ya recuperó control
  await page.keyboard.press('Space');
  await page.waitForTimeout(80);
  const immediateReady = await page.evaluate(() => window.BREACH.player.state);
  await page.keyboard.up('s');
  await page.evaluate(() => {
    const P = window.BREACH.player;
    if (window.__evadeFindCover) {
      P.world.findCover = window.__evadeFindCover;
      delete window.__evadeFindCover;
    }
  });
  console.log('EVADE-READY:', JSON.stringify({ inicio: firstState, durante: activeState, siguiente: immediateReady }));
  if (firstState !== 'dive' || activeState !== 'dive') {
    errors.push('EVADE-READY: perdió el dive activo (' + firstState + '/' + activeState + ')');
  }
  if (immediateReady !== 'dive' && immediateReady !== 'slide' && immediateReady !== 'cover') {
    errors.push('EVADE-READY: la siguiente pulsación no salió inmediatamente (' + immediateReady + ')');
  }
  await page.waitForTimeout(700);

  // reset a campo abierto: la última evasión del test anterior a veces
  // termina EN COVER (pared alta centro = apuntar suprimido por diseño)
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.cover = null; P.slide = null; P.dive = null;
    P.state = 'idle'; P.stateT = 0;
    P.pos.x = 0; P.pos.z = -12; P.vel.x = 0; P.vel.z = 0;
  });
  await page.waitForTimeout(250);

  // retícula ADS por arma: la escopeta debe dibujar un anillo mucho mayor.
  // Con POLLING: a tiempo fijo, bajo carga el anillo podía leerse antes del
  // primer refresco (40 = valor por defecto del SVG) — falso negativo.
  const readRing = async () => {
    let r = 40;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(120);
      r = await page.evaluate(() => +document.getElementById('cross-ring').getAttribute('r'));
      if (r !== 40) break;
    }
    return r;
  };
  await page.mouse.down({ button: 'right' });
  const rSmg = await readRing();
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('q'); // cambiar a escopeta (con animación)
  await page.waitForTimeout(750);
  await page.mouse.down({ button: 'right' });
  const rSgR = await readRing();
  const rSg = await page.evaluate((rr) => ({
    r: rr,
    wep: window.BREACH.weapons.cur,
  }), rSgR);
  await page.mouse.up({ button: 'right' });
  console.log('RETICLE:', JSON.stringify({ smg: rSmg, shotgun: rSg.r, wep: rSg.wep }));
  if (rSg.wep !== 'shotgun') errors.push('RETICLE: el swap no llegó a escopeta');
  if (!(rSg.r > rSmg * 3)) {
    const dbg = await page.evaluate(() => ({
      menu: !document.getElementById('menu').classList.contains('off'),
      suppress: window.BREACH_INPUT.suppress,
      aim: window.BREACH.player.aim,
      aimHeld: window.BREACH_INPUT.aimHeld,
      st: window.BREACH.player.state,
      cls: document.getElementById('crosshair').getAttribute('class'),
    }));
    errors.push('RETICLE: anillo de escopeta no es mayor (' + rSmg + ' vs ' + rSg.r + ') dbg=' + JSON.stringify(dbg));
  }
  await page.keyboard.press('q'); // volver a metralleta
  await page.waitForTimeout(700);

  // recarga manual: barra en modo "reloading" + animación
  await page.keyboard.press('r');
  await page.waitForTimeout(350);
  const rel = await page.evaluate(() => ({
    reloading: window.BREACH.weapons.reloading,
    barClass: document.getElementById('wep-bar').classList.contains('reloading'),
  }));
  console.log('RELOAD:', JSON.stringify(rel));
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-reload.png') });
  if (!rel.reloading || !rel.barClass) errors.push('RELOAD: barra/estado de recarga no activo');
  await page.waitForTimeout(1800);
  const magFull = await page.evaluate(() => window.BREACH.weapons.st.mag);
  if (magFull !== 50) errors.push('RELOAD: no rellenó el cargador (mag=' + magFull + ')');

  // cadencia de escopeta: clicks rápidos → un bombazo por cooldown, sin comerse clicks
  await page.keyboard.press('q');
  await page.waitForTimeout(750);
  const sg0 = await page.evaluate(() => window.BREACH.weapons.st.mag);
  for (let i = 0; i < 9; i++) {
    await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
    await page.waitForTimeout(210);
  }
  await page.waitForTimeout(300);
  const sg1 = await page.evaluate(() => ({ mag: window.BREACH.weapons.st.mag, wep: window.BREACH.weapons.cur }));
  console.log('SHOTGUN-RATE:', JSON.stringify({ antes: sg0, despues: sg1.mag, wep: sg1.wep }));
  // 2.25s de clicks con cd 0.63s → deben salir al menos 3 bombazos
  if (sg0 - sg1.mag < 3) errors.push('SHOTGUN-RATE: salieron ' + (sg0 - sg1.mag) + ' tiros, esperaba >= 3');
  await page.keyboard.press('q');
  await page.waitForTimeout(750);

  // disparar corriendo HACIA ATRÁS (el cuerpo debe encarar a la cámara y tirar)
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.pos.x = 0; P.pos.z = -5; P.cover = null; P.state = 'idle';
    P.cam.yaw = Math.PI; P.yaw = Math.PI;
  });
  await page.keyboard.down('s');
  await page.waitForTimeout(300); // retrocediendo, cuerpo tendería a mirar atrás
  const bk0 = await page.evaluate(() => window.BREACH.weapons.st.mag);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.keyboard.up('s');
  const bk1 = await page.evaluate(() => window.BREACH.weapons.st.mag);
  console.log('BACKFIRE:', JSON.stringify({ antes: bk0, despues: bk1 }));
  if (bk1 >= bk0) errors.push('BACKFIRE: no disparó moviéndose hacia atrás');

  // disparar en el aire saltando DESDE roadie run (cancela el sprint y tira)
  await page.evaluate(() => { const P = window.BREACH.player; P.pos.x = 0; P.pos.z = -8; });
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(400);
  await page.keyboard.press('f');
  await page.waitForTimeout(120);
  const rjAmmo0 = await page.evaluate(() => window.BREACH.weapons.st.mag);
  await page.mouse.down();
  await page.waitForTimeout(220);
  await page.mouse.up();
  const rj = await page.evaluate(() => ({
    mag: window.BREACH.weapons.st.mag,
    y: +window.BREACH.player.y.toFixed(2),
  }));
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  console.log('ROADIEJUMP-FIRE:', JSON.stringify({ antes: rjAmmo0, despues: rj.mag, y: rj.y }));
  if (rj.mag >= rjAmmo0) errors.push('ROADIEJUMP-FIRE: no disparó en el aire tras saltar desde roadie');
  await page.waitForTimeout(600);

  // ---- menú de pausa + panel de controles ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const paused = await page.evaluate(() => ({
    menuOpen: !document.getElementById('menu').classList.contains('off'),
    resumeVisible: document.getElementById('btn-resume').style.display !== 'none',
  }));
  console.log('PAUSE:', JSON.stringify(paused));
  if (!paused.menuOpen || !paused.resumeVisible) errors.push('PAUSE: menú/reanudar no visible');
  await page.evaluate(() => document.getElementById('btn-controls').click());
  await page.waitForTimeout(200);
  const ctrls = await page.evaluate(() => ({
    kbRows: document.getElementById('kb-rows').children.length,
    padRows: document.getElementById('pad-rows').children.length,
  }));
  console.log('CONTROLS:', JSON.stringify(ctrls));
  if (ctrls.kbRows !== 10 || ctrls.padRows !== 9) errors.push('CONTROLS: filas esperadas 10/9, got ' + ctrls.kbRows + '/' + ctrls.padRows);
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-controls.png') });
  await page.evaluate(() => document.getElementById('btn-back').click());
  await page.evaluate(() => document.getElementById('btn-resume').click());
  await page.waitForTimeout(300);

  // estado del juego para verificación
  const state = await page.evaluate(() => ({
    hudOn: document.getElementById('hud').classList.contains('on'),
    menuOff: document.getElementById('menu').classList.contains('off'),
    ammo: document.getElementById('wep-mag').textContent,
    playerState: window.BREACH.player?.state,
  }));
  console.log('STATE:', JSON.stringify(state));

  // ---- modo VS BOTS: mapa arena, 7 bots, vidas 15/15, scoreboard con Tab ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.waitForTimeout(1500);
  const bots = await page.evaluate(() => ({
    mode: window.BREACH.mode,
    bots: window.BREACH.botMatch.bots.length,
    livesR: window.BREACH.botMatch.livesOf('red'),
    livesB: window.BREACH.botMatch.livesOf('blue'),
    timer: Math.round(window.BREACH.botMatch.timer),
    layout: window.BREACH.player ? document.title && 'arena' : '?',
  }));
  console.log('BOTS:', JSON.stringify(bots));
  if (bots.mode !== 'bots' || bots.bots !== 7) errors.push('BOTS: modo/bots mal (' + JSON.stringify(bots) + ')');
  if (bots.livesR !== 15 || bots.livesB > 15) errors.push('BOTS: vidas iniciales mal (' + bots.livesR + '/' + bots.livesB + ')');
  // protección de spawn: activa al nacer, se rompe al disparar
  const prot0 = await page.evaluate(() => +window.BREACH.spawnProt.toFixed(1));
  if (!(prot0 > 3)) errors.push('PROT: sin protección al nacer (' + prot0 + ')');
  await page.mouse.down();
  await page.waitForTimeout(250);
  await page.mouse.up();
  const afterFire = await page.evaluate(() => ({
    prot: window.BREACH.spawnProt, mag: window.BREACH.weapons.st.mag,
  }));
  console.log('PROT:', JSON.stringify({ alNacer: prot0, trasDisparar: afterFire.prot }));
  if (afterFire.prot !== 0) errors.push('PROT: no se rompió al disparar');

  // caja de munición: recarga todo y se consume
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.pos.x = 7; P.pos.z = 0; P.cover = null; P.state = 'idle';
  });
  await page.waitForTimeout(400);
  const crate = await page.evaluate(() => ({
    mag: window.BREACH.weapons.st.mag,
    up: window.BREACH.crates.crates[0].up,
  }));
  console.log('CRATE:', JSON.stringify({ antesMag: afterFire.mag, despuesMag: crate.mag, up: crate.up }));
  if (crate.mag !== 50 || crate.up) errors.push('CRATE: no recargó/consumió (' + JSON.stringify(crate) + ')');

  // observar la IA: conductas (cover/rush/salto/escopeta) + que nadie se atasque
  const seen = { cover: false, rush: false, jump: false, shotgun: false, drop: false };
  const walked = [0, 0, 0, 0, 0, 0, 0];
  let prevPos = null;
  let samples = 0;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(500);
    samples++;
    const states = await page.evaluate(() =>
      window.BREACH.botMatch.bots.map((b) => ({ st: b.state, y: b.y, w: b.wep, x: b.pos.x, z: b.pos.z })));
    if (await page.evaluate(() => window.BREACH.drops.drops.size > 0)) seen.drop = true;
    if (prevPos) {
      states.forEach((b, j) => { walked[j] += Math.hypot(b.x - prevPos[j].x, b.z - prevPos[j].z); });
    }
    prevPos = states;
    for (const b of states) {
      if (b.st === 'cover') seen.cover = true;
      if (b.st === 'rush') seen.rush = true;
      if (b.y > 0.25) seen.jump = true;
      if (b.w === 'shotgun') seen.shotgun = true;
    }
    // el drop también es condición de corte: sin esperarlo, la ventana podía
    // cerrarse antes de la primera muerte (falso negativo aleatorio)
    if (seen.cover && seen.rush && seen.jump && seen.shotgun && seen.drop && samples >= 16) break;
  }
  const minWalk = Math.min(...walked.map((w) => +w.toFixed(1)));
  console.log('AI:', JSON.stringify({ ...seen, minWalk, secs: samples / 2 }));
  if (!seen.jump) errors.push('AI: ningún bot saltó');
  if (!seen.shotgun && !seen.rush) errors.push('AI: nadie cambió a escopeta/rusheó');
  if (!seen.cover) errors.push('AI: nadie se cubrió');
  if (!seen.drop) errors.push('DROPS: ninguna arma cayó al morir alguien');
  if (minWalk < 1.5) errors.push('AI: hay un bot atascado (recorrió ' + minWalk + 'm en ' + samples / 2 + 's)');

  await page.keyboard.down('Tab');
  await page.waitForTimeout(300);
  const sb = await page.evaluate(() => ({
    on: document.getElementById('scoreboard').classList.contains('on'),
    rows: document.querySelectorAll('#scoreboard .sb-row:not(.sb-cols-head)').length,
  }));
  await page.screenshot({ path: path.join(root, 'scripts', 'shot-bots.png') });
  await page.keyboard.up('Tab');
  console.log('SCOREBOARD:', JSON.stringify(sb));
  if (!sb.on || sb.rows !== 8) errors.push('SCOREBOARD: esperaba 8 filas visibles, got ' + JSON.stringify(sb));

  // ---- multijugador: dos clientes en el mismo server ----
  const ctx2 = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('P2 PAGEERROR: ' + e.message));
  await p2.goto('http://localhost:8791/?nolock=1', { waitUntil: 'networkidle' });
  for (const pg of [page, p2]) {
    // si el juego está corriendo, abrir el menú con Esc primero
    const menuOff = await pg.evaluate(() => document.getElementById('menu').classList.contains('off'));
    if (menuOff) { await pg.keyboard.press('Escape'); await pg.waitForTimeout(300); }
    await pg.evaluate(() => {
      document.getElementById('in-server').value = 'ws://localhost:8791';
      document.getElementById('btn-online').click();
    });
    await pg.waitForTimeout(800);
  }
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  const mp = {
    p1: await page.evaluate(() => ({ mode: window.BREACH.mode, team: window.BREACH.team, remotes: window.BREACH.remotes.size })),
    p2: await p2.evaluate(() => ({ mode: window.BREACH.mode, team: window.BREACH.team, remotes: window.BREACH.remotes.size })),
  };
  console.log('MP:', JSON.stringify(mp));
  await p2.screenshot({ path: path.join(root, 'scripts', 'shot-mp.png') });
  if (mp.p1.mode !== 'online' || mp.p2.mode !== 'online') errors.push('MP: algún cliente no conectó');
  if (mp.p1.remotes !== 1 || mp.p2.remotes !== 1) errors.push('MP: remotes esperados 1/1, got ' + mp.p1.remotes + '/' + mp.p2.remotes);
  if (mp.p1.team === mp.p2.team) errors.push('MP: ambos en el mismo equipo');
  await ctx2.close();
} catch (e) {
  errors.push('FATAL: ' + e.message);
} finally {
  await browser?.close();
  server.kill();
  clearClip(); // que la suite JAMÁS deje el mouse físico confinado
}

if (errors.length) {
  console.log('ERRORS (' + errors.length + '):');
  for (const e of errors.slice(0, 15)) console.log('  ' + e);
  process.exit(1);
}
console.log('SMOKE OK');
