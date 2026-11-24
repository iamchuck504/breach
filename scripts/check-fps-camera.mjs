// CÁMARA DE PRIMERA PERSONA (pura, Node): el invariante de juego limpio y
// los límites de lo cosmético. Recorre secuencias aleatorias de posturas
// (de pie, agachado con asomo, inclinación, ADS, deslizar, trepar,
// aterrizajes, sacudidas, retroceso) a cuadros de 30–144 fps y comprueba:
//  · el ojo de la cámara nunca sale de la bola EYE_MAX de la cabeza de la
//    postura replicada de ESE cuadro (lo que el servidor y los demás ven);
//  · en reposo la cámara no se mueve (sin respiración ni deriva);
//  · FOV vertical dentro de 60–100 (ADS y mira cierran, nunca abren);
//  · con reduceMotion no hay balanceo al andar y la sacudida queda acotada;
//  · plano cercano de primera persona y rayo central = mirada (yaw/pitch).
import * as THREE from 'three';
import { ShoulderCamera, FirstPersonCamera, FP_EYE_RADIUS, FP_NEAR, eyeFromPose, springStep } from '../src/core/camera.js';
import { hitPose } from '../src/combat/hit-pose.js';

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const world = { raycast: () => null };
const make = () => {
  const cam = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 200);
  const look = new ShoulderCamera(cam, world);
  return { cam, look, fp: new FirstPersonCamera(cam, world, look) };
};
const headWorld = (pose, p) => {
  const h = hitPose(pose).h, yaw = p.yaw;
  return new THREE.Vector3(p.pos.x - Math.sin(yaw) * h[0] + Math.cos(yaw) * h[1], p.y + h[2], p.pos.z - Math.cos(yaw) * h[0] - Math.sin(yaw) * h[1]);
};

// 1) invariante bajo secuencias aleatorias
{
  const { cam, look, fp } = make();
  const p = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, vy: 0, grounded: true, speed: 0, aim: false, state: 'idle' };
  const states = ['idle', 'run', 'crouch', 'crouch', 'slide', 'mantle', 'jump', 'roadie'];
  let worst = 0, ce = 0, ceT = 0, cl = 0, clT = 0, st = 'idle', hold = 0;
  for (let i = 0; i < 20000; i++) {
    const dt = 1 / [30, 60, 144][i % 3];
    if (--hold <= 0) {
      st = states[Math.floor(rnd() * states.length)]; hold = 10 + Math.floor(rnd() * 80);
      ceT = rnd() < 0.5 ? 0 : 1; clT = rnd() < 0.6 ? 0 : (rnd() < 0.5 ? -1 : 1);
      p.aim = rnd() < 0.4; p.speed = rnd() * 7; p.grounded = st !== 'jump' && st !== 'mantle';
      if (rnd() < 0.2) look.addShake(rnd() * 1.5);
      if (rnd() < 0.3) fp.kick(rnd() * 2);
    }
    // ce/cl continuos como los da el controlador (~0.2 s)
    ce += Math.sign(ceT - ce) * Math.min(Math.abs(ceT - ce), dt / 0.2);
    cl += Math.sign(clT - cl) * Math.min(Math.abs(clT - cl), dt / 0.15);
    p.vy = p.grounded ? 0 : -8 * rnd();
    p.yaw += (rnd() - 0.5) * 0.2; look.yaw = p.yaw; look.pitch = (rnd() - 0.5) * 1.2;
    p.pos.x += Math.sin(i * 0.01) * p.speed * dt;
    if (i % 400 === 0) p.y = rnd() < 0.5 ? 0 : 0.3; // escalón
    const pose = { st, aim: p.aim ? 1 : 0, ce, cl, pitch: look.pitch, p: look.pitch, phase: (i % 60) / 60, wep: 'smg' };
    fp.update(dt, p, { pose, weapon: 'smg' });
    worst = Math.max(worst, cam.position.distanceTo(headWorld(pose, p)), fp.eye.distanceTo(headWorld(pose, p)));
  }
  check('ojo siempre dentro de la bola EYE_MAX de la cabeza replicada', worst <= FP_EYE_RADIUS + 1e-6, `peor ${worst.toFixed(4)} (máx ${FP_EYE_RADIUS})`);
  check('plano cercano de primera persona', cam.near === FP_NEAR, String(cam.near));
}

// 2) en reposo la cámara está quieta
{
  const { cam, fp } = make();
  const p = { pos: { x: 3, z: 1 }, y: 0, yaw: 0.4, vy: 0, grounded: true, speed: 0, aim: false, state: 'idle' };
  const pose = { st: 'idle' };
  for (let i = 0; i < 120; i++) fp.update(1 / 60, p, { pose });
  const a = cam.position.clone(), q = cam.quaternion.clone();
  let drift = 0, turn = 0;
  for (let i = 0; i < 600; i++) {
    fp.update(1 / 60, p, { pose });
    drift = Math.max(drift, cam.position.distanceTo(a)); turn = Math.max(turn, cam.quaternion.angleTo(q));
  }
  check('estable en reposo (sin deriva ni respiración)', drift < 1e-6 && turn < 1e-6, `pos ${drift.toExponential(1)} rot ${turn.toExponential(1)}`);
  const e = eyeFromPose(pose);
  // la altura sale SOLO de eyeFromPose (RED la fija; nada de constantes aquí)
  check('ojo de pie = eyeFromPose (sin constantes)', Math.abs(fp.eye.y - e.y) < 1e-9 && e.y > 1.3 && e.y < 1.75, `${fp.eye.y.toFixed(3)} vs ${e.y.toFixed(3)}`);
}

// 3) FOV: ajuste, ADS y mira
{
  const { cam, look, fp } = make();
  const p = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, grounded: true, speed: 0, aim: false, state: 'idle' };
  const run = (o, n = 120) => { for (let i = 0; i < n; i++) fp.update(1 / 60, p, { pose: { st: 'idle', aim: p.aim ? 1 : 0 }, weapon: 'smg', ...o }); return cam.fov; };
  check('FOV por defecto 72', Math.abs(run({}) - 72) < 0.01, cam.fov.toFixed(2));
  check('FOV del ajuste (95) y acotado (130→100, 30→60)',
    Math.abs(run({ settings: { fov: 95 } }) - 95) < 0.01 && Math.abs(run({ settings: { fov: 130 } }) - 100) < 0.01 && Math.abs(run({ settings: { fov: 30 } }) - 60) < 0.01);
  p.aim = true;
  const ads = run({});
  check('ADS cierra el FOV sin saltos', ads < 72 && ads > 40, ads.toFixed(1));
  let maxStep = 0, prev = cam.fov; p.aim = false;
  for (let i = 0; i < 60; i++) { fp.update(1 / 60, p, { pose: { st: 'idle' }, weapon: 'smg' }); maxStep = Math.max(maxStep, Math.abs(cam.fov - prev)); prev = cam.fov; }
  check('ADS → cadera: transición continua (≤ 3°/cuadro a 60 fps)', maxStep <= 3, maxStep.toFixed(2));
  p.aim = true;
  check('mira del sniper usa su FOV', Math.abs(run({ scoped: true, scopeFov: 20 }) - 20) < 0.05, cam.fov.toFixed(2));
  // sensibilidad proporcional al FOV
  p.aim = false; run({ sens: { mouse: 0.05, padX: 170, padY: 120 } });
  const hip = look.lookDeg; p.aim = true; run({ sens: { mouse: 0.05, padX: 170, padY: 120 } });
  check('sensibilidad ADS proporcional al FOV', Math.abs(look.lookDeg / hip - cam.fov / 72) < 1e-6, (look.lookDeg / hip).toFixed(3));
  check('mando: X e Y por separado', Math.abs(look.padDeg.y / look.padDeg.x - 120 / 170) < 1e-6);
}

// 4) movimiento reducido
{
  const { cam, look, fp } = make();
  const p = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, grounded: true, speed: 4.8, aim: false, state: 'run' };
  const sweep = (settings) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 240; i++) { fp.update(1 / 60, p, { pose: { st: 'run' }, settings }); lo = Math.min(lo, cam.position.y); hi = Math.max(hi, cam.position.y); }
    return hi - lo;
  };
  const bob = sweep({ bob: 1 }), none = sweep({ bob: 1, reduceMotion: true });
  check('al correr el ojo no se bambolea (el balanceo es del arma; el ojo = eyeWorld)', bob < 1e-6 && none < 1e-6, `${bob.toExponential(1)} ${none.toExponential(1)}`);
  // DECISIÓN: lo cosmético nunca gira la mira. Con sacudidas y golpes de
  // retroceso a tope, el píxel central = el rayo del tiro (mismo origen y
  // misma dirección), en cada cuadro.
  p.speed = 0; let worstDir = 0, worstPos = 0;
  for (let i = 0; i < 240; i++) {
    look.addShake(1.5); fp.kick(1.5); look.yaw += 0.01; look.pitch = Math.sin(i * 0.05) * 0.5;
    fp.update(1 / [10, 30, 60, 144][i % 4], p, { pose: { st: 'idle' } });
    cam.updateMatrixWorld(true);
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const r = fp.aimRay();
    worstDir = Math.max(worstDir, dir.angleTo(r.dir)); worstPos = Math.max(worstPos, cam.position.distanceTo(r.origin));
  }
  check('cruz = eje balístico con sacudida y retroceso (centro de pantalla = rayo del tiro)', worstDir < 1e-6 && worstPos < 1e-9,
    `ángulo ${(worstDir * 180 / Math.PI).toExponential(1)}° · origen ${worstPos.toExponential(1)} m`);
  const r = fp.aimRay();
  check('el rayo central sale del ojo', r.origin.distanceTo(fp.eye) < 1e-9);
}


// 5) resortes (golpe de retroceso k=26, aterrizaje k=11): a 10–144 c/s con
// impulsos aleatorios durante diez minutos simulados → acotados, finitos y
// con la misma respuesta asentada a cualquier ritmo. Control negativo: el
// integrador de antes (Euler semi-implícito) diverge con ese mismo guion.
{
  const euler = (x, v, w, dt) => { const a = -w * w * x - 2 * w * v; v += a * dt; return [x + v * dt, v]; };
  const run = (step, w, fps) => {
    let x = 0, v = 0, worst = 0, finite = true; seed = 99;
    const dt = 1 / fps, n = Math.round(600 * fps);
    let nextImp = 0;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      if (t >= nextImp) { v += 0.4 * rnd(); nextImp = t + 0.05 + rnd() * 2; }
      [x, v] = step(x, v, w, dt);
      if (!Number.isFinite(x) || !Number.isFinite(v)) { finite = false; break; }
      worst = Math.max(worst, Math.abs(x));
    }
    return { finite, worst };
  };
  for (const [name, w] of [['retroceso', 26], ['aterrizaje', 11]]) {
    const rows = [10, 15, 25, 30, 60, 144].map((fps) => ({ fps, ...run(springStep, w, fps) }));
    // pico de UN impulso v0 a 10 y a 144 c/s (respuesta asentada comparable)
    const peak = (fps) => { let x = 0, v = 1, m = 0; for (let i = 0; i < fps * 3; i++) { [x, v] = springStep(x, v, w, 1 / fps); m = Math.max(m, x); } return { m, x }; };
    const p10 = peak(10), p144 = peak(144), exact = 1 / (w * Math.E);
    check(`resorte ${name}: finito y acotado 10 min a 10/15/25/30/60/144 c/s`,
      rows.every((r) => r.finite && r.worst < 0.5), rows.map((r) => `${r.fps}:${r.worst.toFixed(3)}`).join(' '));
    check(`resorte ${name}: misma respuesta a 10 y 144 c/s (pico ≤ exacto, asienta a 0)`,
      p10.m <= exact + 1e-9 && Math.abs(p144.m - exact) < 0.02 * exact && Math.abs(p10.x) < 1e-6 && Math.abs(p144.x) < 1e-6,
      `pico 10c/s ${p10.m.toFixed(4)} · 144c/s ${p144.m.toFixed(4)} · exacto ${exact.toFixed(4)}`);
    const old = [25, 30].map((fps) => run(euler, w, fps));
    if (w === 26) check('control: el integrador anterior diverge con el mismo guion (25/30 c/s)', old.some((r) => !r.finite || r.worst > 10), JSON.stringify(old));
  }
  // la cámara entera a 10 c/s 10 min con golpes, saltos y sacudidas: finita
  const { cam, look, fp } = make();
  const p = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, vy: 0, grounded: true, speed: 4, aim: false, state: 'run' };
  let ok = true; seed = 5;
  for (let i = 0; i < 6000; i++) {
    if (rnd() < 0.2) fp.kick(rnd() * 3); if (rnd() < 0.05) look.addShake(2);
    p.grounded = i % 40 > 8; p.vy = p.grounded ? 0 : -9;
    fp.update(0.1, p, { pose: { st: 'run' } });
    if (![cam.position.x, cam.position.y, cam.position.z, cam.fov, cam.quaternion.w].every(Number.isFinite)) { ok = false; break; }
  }
  check('cámara completa 10 min a 10 c/s: finita', ok, `fov ${cam.fov.toFixed(2)} y ${cam.position.y.toFixed(3)}`);
}

// 6) paredes: la cámara NO corrige el ojo por su cuenta (cámara = ojo del
// tiro = eyeWorld). Con un muro a 0.39 m: en toda postura LEGAL (esfera de
// cabeza fuera del muro, lo que garantiza el controlador) el ojo queda a
// ≥ 4.5 cm del muro (esquina del plano cercano) y es exactamente eyeWorld.
{
  const HP = await import('../src/combat/hit-pose.js');
  const WALL = 0.39;
  const wallWorld = { raycast: (o, d, max) => {
    if (d.x <= 1e-9) return null;
    const t = (WALL - o.x) / d.x; return t >= 0 && t <= max ? t : null;
  } };
  const cam = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 200);
  const look = new ShoulderCamera(cam, wallWorld), fp = new FirstPersonCamera(cam, wallWorld, look);
  let legal = 0, close = 0, notEye = 0; seed = 11;
  for (let i = 0; i < 6000; i++) {
    const yaw = rnd() < 0.5 ? 0 : -Math.PI / 2 * rnd();
    const p = { pos: { x: 0, z: 0 }, y: 0, yaw, vy: 0, grounded: true, speed: 0, aim: rnd() < 0.5, state: 'idle' };
    look.yaw = yaw; look.pitch = 0;
    const st = rnd() < 0.5 ? 'crouch' : 'idle';
    const pose = { st, aim: p.aim ? 1 : 0, ce: st === 'crouch' ? rnd() : 1, cl: rnd(), pitch: 0, wep: 'smg' };
    fp.update(1 / [10, 30, 144][i % 3], p, { pose });
    const e = HP.eyeWorld(pose, 0, 0, 0, yaw);
    if (Math.hypot(fp.eye.x - e[0], fp.eye.y - e[1], fp.eye.z - e[2]) > 1e-9) notEye++;
    const head = headWorld(pose, p);
    if (WALL - head.x < 0.22) continue; // postura ilegal: la impide el controlador
    legal++;
    if (fp.eye.x > WALL - 0.045 + 1e-6) close++;
  }
  check('cámara = eyeWorld también junto a un muro (sin corrección privada)', notEye === 0, `${notEye}/6000`);
  check('muro a 0.39 m: en posturas legales el ojo queda a ≥ 4.5 cm', legal > 500 && close === 0, `${close}/${legal}`);
}

// 7) el ojo de la cámara ES eyeWorld(pose) (origen que valida el servidor,
// tolerancia 2 cm) en cualquier postura sin pared cerca, saltos y aterrizajes incluidos
{
  const HP = await import('../src/combat/hit-pose.js');
  const { cam, look, fp } = make();
  const p = { pos: { x: 1, z: 2 }, y: 0, yaw: 0.3, vy: 0, grounded: true, speed: 4, aim: false, state: 'run' };
  let worst = 0; seed = 21;
  for (let i = 0; i < 3000; i++) {
    p.grounded = i % 50 > 10; p.vy = p.grounded ? 0 : -8; p.y = p.grounded ? 0 : 0.5 * rnd();
    p.yaw += 0.01; look.yaw = p.yaw; look.pitch = (rnd() - 0.5);
    const pose = { st: ['idle', 'run', 'crouch', 'slide', 'jump'][i % 5], aim: i % 3 === 0 ? 1 : 0, ce: rnd(), cl: rnd() * 2 - 1, pitch: look.pitch, wep: 'smg' };
    if (rnd() < 0.1) { look.addShake(1); fp.kick(1); }
    fp.update(1 / [10, 30, 60, 144][i % 4], p, { pose });
    const e = HP.eyeWorld(pose, p.pos.x, p.y, p.pos.z, p.yaw);
    const dd = Math.hypot(cam.position.x - e[0], cam.position.y - e[1], cam.position.z - e[2]);
    worst = Math.max(worst, dd);
  }
  check('cámara = eyeWorld(pose) (≤ 2 cm, la tolerancia del servidor)', worst <= 0.02, worst.toFixed(4));
}

// 8) la sensibilidad cuenta EN EL INSTANTE: cambiar el ajuste y girar en el
// mismo tick usa el valor nuevo (check-sniper-identity: razón 1.25/0.35)
{
  const { look, fp } = make();
  const p = { pos: { x: 0, z: 0 }, y: 0, yaw: 0, grounded: true, speed: 0, aim: true, state: 'idle' };
  const live = { sensScope: 0.75 };
  const sensFn = (dev, { aim, scoped }) => ({ x: 0.045 * (scoped ? live.sensScope : 1), y: 0.045 });
  fp.update(1 / 60, p, { pose: { st: 'idle', aim: 1 }, scoped: true, scopeFov: 20, sensFn });
  const turn = (v) => { live.sensScope = v; const y0 = look.yaw; look.applyMouse(100, 0, false); const d = Math.abs(look.yaw - y0); look.yaw = y0; return d; };
  const slow = turn(0.35), fast = turn(1.25);
  check('sensibilidad con mira: el ajuste cuenta en el mismo tick', Math.abs(fast / slow - 1.25 / 0.35) < 1e-6, (fast / slow).toFixed(3));
}

// 9) SALIR DEL SPRINT JUNTO A UNA PARED (geometría real: World.raycast sobre
// cajas): controlador de verdad, empujón y settle() como main.js; la cámara
// lee p.eyeWorld() y el registro del tiro también → mismo punto, y el ojo
// nunca a menos de 4.5 cm de la pared.
{
  const { World } = await import('../src/world/world.js');
  const { Controller } = await import('../src/player/controller.js');
  const { localPose } = await import('../src/net/client.js');
  const mkWorld = (boxes) => {
    const w = Object.create(World.prototype);
    w.colliders = boxes; w.segmentColliders = []; w.faces = [];
    const over = (q, r, b) => q.x + r > b.minx && q.x - r < b.maxx && q.z + r > b.minz && q.z - r < b.maxz;
    w.groundHeight = (q, r = 0, y = 0) => { let g = 0; for (const b of boxes) if (over(q, r, b) && y >= b.h - 0.3) g = Math.max(g, b.h); return g; };
    w.ceilingHeight = () => Infinity;
    return w;
  };
  const wall = { minx: 0.42, maxx: 3, minz: -30, maxz: 30, h: 3 }; // a 4 cm del radio del cuerpo
  const world = mkWorld([wall]);
  const cam = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 200);
  const look = new ShoulderCamera(cam, world), fp = new FirstPersonCamera(cam, world, look);
  const c = new Controller(world, look, {});
  c.respawn({ x: 0, z: 0, yaw: 0 }); look.yaw = 0;
  const input = { mv: { x: 0, z: 1 }, sprintHeld: true, aimHeld: false, crouchHeld: false, leanAxis: 0, jumpPressed: false, crouchPressed: false,
    meleePressed: false, evadePressed: false, moveVec() { return this.mv; }, releaseToggle() {}, endFrame() { this.jumpPressed = this.crouchPressed = false; } };
  let t = 0, worstGap = 0, minClear = Infinity, n = 0;
  const probe = (e) => { let m = Infinity; for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; const h = world.raycast(e, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 1, 0); if (h !== null) m = Math.min(m, h); } return m; };
  for (let i = 0; i < 360; i++) {
    const dt = 1 / [30, 60, 144][i % 3];
    if (i === 120) { input.sprintHeld = false; input.leanAxis = 1; input.aimHeld = true; }   // sale del sprint, se inclina hacia la pared
    if (i === 200) { input.mv = { x: 0.7, z: 0.7 }; }                                         // hacia la pared
    if (i === 260) { c.pos.x += 0.2; world.resolveCircle(c.pos, 0.38, c.y); }              // empujón entre cuerpos
    c.update(dt, input, false); t += dt;
    c.settle?.();
    const pose = { ...localPose(c, 'smg', t), ae: c.cameraYawError() };
    const ew = c.eyeWorld();
    fp.update(dt, c, { pose, eye: ew });
    worstGap = Math.max(worstGap, Math.hypot(cam.position.x - ew[0], cam.position.y - ew[1], cam.position.z - ew[2]));
    minClear = Math.min(minClear, probe(cam.position)); n++;
    input.endFrame();
  }
  check('salir del sprint junto a pared: cámara = ojo del tiro (p.eyeWorld)', worstGap < 1e-9, worstGap.toExponential(1));
  check('salir del sprint junto a pared: ojo a ≥ 4.5 cm de la pared real', minClear >= 0.045, `mínimo ${minClear.toFixed(3)} m en ${n} cuadros`);
}

console.log(fails.length ? `FALLAN ${fails.length}` : 'TODO OK');
process.exit(fails.length ? 1 : 0);
