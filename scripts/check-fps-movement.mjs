// Máquina de estados del jugador FPS (etapa B, JUGABILIDAD). Solo Node:
// mundo sintético con el World real (colisión, raycast y búsqueda de caras)
// y un suelo/techo de prueba. Cubre velocidades, posturas del contrato,
// inclinación barrida contra la pared, asomo continuo, deslizamiento,
// trepar solo LOW, retraso sprint→disparo y la ausencia de los estados
// retirados (cover_*, blind_*, dive, flip).
import * as THREE from 'three';
import { World } from '../src/world/world.js';
import { Controller, PLAYER_R } from '../src/player/controller.js';
import { TUNING } from '../src/config/tuning.js';
import { SETTINGS, setSetting } from '../src/core/settings.js';
import { requiredFireBuffer } from '../src/combat/fire-control.js';
import { hitPose, placeHitPose } from '../src/combat/hit-pose.js';
import { localPose, noteSentPose } from '../src/net/client.js';
import { Weapons } from '../src/combat/weapons.js';
import { expandedCollisionBoxes } from '../src/world/collision-layouts.js';
import { canFireInState, MOVE_GATES } from '../src/combat/fire-gates.js';

const DT = 1 / 60;
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const F = TUNING.fp;
const HEAD_R = 0.22;
const BANNED = /^(cover_|blind_)|^(dive|flip)$/;

// Penetración (m) de la esfera de cabeza REAL (hitPose de la pose que viaja,
// la misma que usa la cámara) en cajas y techos. > 0 = dentro de la geometría.
// Reloj de simulación por controlador (lo avanza run()): la pose lleva la
// mezcla de transición de estados igual que en el juego (localPose).
const CLOCK = new WeakMap();
function headIntrusion(c, boxes = [], ceilings = []) {
  const pose = localPose(c, c.weaponKey, CLOCK.get(c) ?? 0);
  const v = placeHitPose(hitPose(pose), c.pos.x, c.y, c.pos.z, c.yaw);
  let worst = -Infinity;
  const vsBox = (minx, maxx, miny, maxy, minz, maxz) => {
    const dx = Math.max(minx - v.hx, 0, v.hx - maxx), dy = Math.max(miny - v.hy, 0, v.hy - maxy), dz = Math.max(minz - v.hz, 0, v.hz - maxz);
    worst = Math.max(worst, v.hr - Math.hypot(dx, dy, dz));
  };
  for (const b of boxes) vsBox(b.minx, b.maxx, -1, b.h, b.minz, b.maxz);
  for (const b of ceilings) vsBox(b.minx, b.maxx, b.y, 99, b.minz, b.maxz);
  return worst;
}

// boxes: {minx,maxx,minz,maxz,h}; ceilings: [{minx,maxx,minz,maxz,y}]
function makeWorld(boxes = [], faces = [], ceilings = []) {
  const w = Object.create(World.prototype);
  w.colliders = boxes; w.segmentColliders = []; w.faces = faces;
  const over = (p, r, b) => p.x + r > b.minx && p.x - r < b.maxx && p.z + r > b.minz && p.z - r < b.maxz;
  w.groundHeight = (p, r = 0, y = 0) => {
    let g = 0;
    for (const b of boxes) if (over(p, r, b) && y >= b.h - 0.3) g = Math.max(g, b.h);
    return g;
  };
  w.ceilingHeight = (p, r = 0) => {
    let c = Infinity;
    for (const b of ceilings) if (over(p, r, b)) c = Math.min(c, b.y);
    return c;
  };
  return w;
}
const faceOf = (box, kind) => ({ a: { x: box.minx, z: box.maxz }, b: { x: box.maxx, z: box.maxz },
  n: { x: 0, z: 1 }, h: box.h, topY: box.h, kind, collider: box });

function makeCam(yaw = 0) {
  return {
    yaw, pitch: 0,
    flatForward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; },
    flatRight() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; },
  };
}
class TestInput {
  constructor() { this.reset(); }
  reset() {
    this.mv = { x: 0, z: 0 }; this.sprintHeld = false; this.aimHeld = false; this.crouchHeld = false;
    this.leanAxis = 0; this.jumpPressed = false; this.crouchPressed = false; this.meleePressed = false;
    this.evadePressed = false; this.released = [];
  }
  moveVec() { return this.mv; }
  releaseToggle(n) { this.released.push(n); }
  endFrame() { this.jumpPressed = false; this.crouchPressed = false; this.meleePressed = false; this.evadePressed = false; }
}
function make(world = makeWorld(), pos = { x: 0, z: 0 }, yaw = 0, ev = {}) {
  const cam = makeCam(yaw);
  const c = new Controller(world, cam, ev);
  c.respawn({ x: pos.x, z: pos.z, yaw });
  c.poseClock = () => CLOCK.get(c) ?? 0; // reloj de main (G.simClock)
  return { c, cam, input: new TestInput() };
}
function run(c, input, n, firing = false, each) {
  for (let i = 0; i < n; i++) {
    CLOCK.set(c, (CLOCK.get(c) ?? 0) + DT); c.update(DT, input, firing); // main: G.simClock avanza al empezar simStep
    // como main.js: cada paso envía su pose (la transición la define lo enviado)
    { const lp = localPose(c, c.weaponKey, CLOCK.get(c));
      noteSentPose(c, { st: lp.st, aim: lp.aim, ce: lp.ce, cl: lp.cl, pitch: lp.pitch, wep: lp.wep, sp: lp.sp }, CLOCK.get(c)); }
    each?.(i); input.endFrame();
  }
}

// ---------- velocidades (DECISIONES §2) ----------
{
  const cases = [
    ['correr', (i) => { i.mv = { x: 0, z: 1 }; }, F.runSpeed, 'run'],
    ['sprint', (i) => { i.mv = { x: 0, z: 1 }; i.sprintHeld = true; }, F.sprintSpeed, 'roadie'],
    ['agachado', (i) => { i.mv = { x: 0, z: 1 }; i.crouchHeld = true; }, F.crouchSpeed, 'crouch'],
    ['ADS', (i) => { i.mv = { x: 0, z: 1 }; i.aimHeld = true; }, F.runSpeed * F.adsMul, 'run'],
    ['lateral', (i) => { i.mv = { x: 1, z: 0 }; }, F.runSpeed, 'run'],
    ['atrás', (i) => { i.mv = { x: 0, z: -1 }; }, F.runSpeed, 'run'],
  ];
  for (const [name, set, want, st] of cases) {
    const { c, input } = make();
    set(input);
    run(c, input, 90);
    check(Math.abs(c.speed - want) < want * 0.02, `${name}: ${c.speed.toFixed(2)} m/s, esperado ${want}`);
    check(c.state === st, `${name}: estado ${c.state}, esperado ${st}`);
  }
  check(F.runSpeed === 4.8 && F.sprintSpeed === 7.0 && F.crouchSpeed === 2.3, 'cifras de DECISIONES §2 cambiadas');
  // sprint lateral o hacia atrás no existe
  const { c, input } = make();
  input.mv = { x: 1, z: 0 }; input.sprintHeld = true; run(c, input, 30);
  check(c.state !== 'roadie', 'sprint lateral permitido');
}

// ---------- cuerpo bloqueado a la vista; movimiento relativo a la vista ----------
{
  const { c, cam, input } = make();
  cam.yaw = Math.PI / 2;
  run(c, input, 6);
  check(Math.abs(c.cameraYawError()) < 1e-3, `el cuerpo no sigue a la vista (${c.cameraYawError().toFixed(3)})`);
  input.mv = { x: 0, z: 1 }; run(c, input, 60);
  const f = cam.flatForward();
  check((c.vel.x * f.x + c.vel.z * f.z) / c.speed > 0.99, 'adelante no es la dirección de la vista');
}

// ---------- estados retirados: ni con todas las teclas viejas ----------
{
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const box = { minx: -3, maxx: 3, minz: -6, maxz: -4, h: 1.1 };
  const wall = { minx: 4, maxx: 6, minz: -8, maxz: 8, h: 3 };
  const world = makeWorld([box, wall], [faceOf(box, 'low')], [{ minx: -8, maxx: -5, minz: -2, maxz: 2, y: 1.3 }]);
  const { c, cam, input } = make(world);
  const seen = new Set();
  let bad = null, maxSlide = 0;
  for (let i = 0; i < 6000; i++) {
    if (i % 12 === 0) {
      input.mv = { x: rnd() * 2 - 1, z: rnd() * 2 - 1 };
      input.sprintHeld = rnd() < 0.4; input.aimHeld = rnd() < 0.3; input.crouchHeld = rnd() < 0.3;
      input.leanAxis = [-1, 0, 0, 1][Math.floor(rnd() * 4)];
      cam.yaw += (rnd() - 0.5) * 1.2;
    }
    if (rnd() < 0.05) input.jumpPressed = true;
    if (rnd() < 0.04) input.evadePressed = true;
    if (rnd() < 0.03) input.crouchPressed = true;
    if (rnd() < 0.01) input.meleePressed = true;
    c.update(DT, input, rnd() < 0.2);
    input.endFrame();
    const st = c.animState(), ap = c.animParams();
    seen.add(st);
    if (BANNED.test(st)) bad = bad ?? `estado retirado emitido: ${st}`;
    if (!(ap.crouch >= 0 && ap.crouch <= 1 && ap.ce >= 0 && ap.ce <= 1 && ap.cl >= -1 && ap.cl <= 1)) bad = bad ?? `postura fuera de rango ${JSON.stringify({ c: ap.crouch, ce: ap.ce, cl: ap.cl })}`;
    if (c.state === 'slide') maxSlide = Math.max(maxSlide, c.speed);
    if (c.grounded && ['idle', 'run', 'crouch', 'dodge'].includes(c.state) && headIntrusion(c, [box, wall], [{ minx: -8, maxx: -5, minz: -2, maxz: 2, y: 1.3 }]) > 1e-3) bad = bad ?? `cabeza dentro de la geometría (fuzz) st ${c.state} cl ${c.lean.toFixed(2)} ce ${c.peek.toFixed(2)}`;
    if (Math.abs(c.pos.x) > 30 || Math.abs(c.pos.z) > 30) { c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; }
  }
  check(!bad, bad);
  check(maxSlide <= F.slideMaxSpeed + 1e-6, `deslizamiento a ${maxSlide.toFixed(2)} m/s (> 8)`);
  check(seen.has('crouch') && seen.has('run') && seen.has('jump'), `estados FPS no alcanzados: ${[...seen]}`);
}

// ---------- salto simple: sin doble salto ni patada de pared ----------
{
  const wall = { minx: -3, maxx: 3, minz: -2, maxz: -0.5, h: 3 };
  const { c, input } = make(makeWorld([wall], [faceOf(wall, 'high')]), { x: 0, z: 0 });
  input.jumpPressed = true; c.update(DT, input); input.endFrame();
  let apex = 0, vyAfterSecond = null;
  for (let i = 0; i < 80; i++) {
    if (i === 20) { input.jumpPressed = true; input.mv = { x: 0, z: 1 }; }
    const vy0 = c.vy;
    c.update(DT, input); input.endFrame();
    if (i === 20) vyAfterSecond = c.vy - vy0;
    apex = Math.max(apex, c.y);
  }
  check(Math.abs(apex - 1.28) < 0.04, `ápice del salto ${apex.toFixed(2)} (≈1.28)`);
  check(vyAfterSecond < 0, 'segundo salto en el aire dio impulso');
}

// ---------- agacharse: mantener, techo bajo, sprint levanta ----------
{
  const { c, input } = make();
  input.crouchHeld = true;
  let t = 0; while (c.crouch01 < 1 && t < 1) { run(c, input, 1); t += DT; }
  check(c.state === 'crouch' && Math.abs(t - F.crouchTime) < 0.04, `agacharse tardó ${t.toFixed(2)} s`);
  check(Math.abs(c.eyeHeight() - F.eyeCrouch) < 1e-6, `ojo agachado ${c.eyeHeight()}`);
  input.crouchHeld = false; run(c, input, 20);
  check(c.state === 'idle' && c.crouch01 === 0 && Math.abs(c.eyeHeight() - F.eyeStand) < 1e-6, 'no se levantó al soltar');
  // techo bajo: no se levanta y no puede sprintar
  const low = makeWorld([], [], [{ minx: -2, maxx: 2, minz: -2, maxz: 2, y: 1.3 }]);
  const b = make(low);
  b.input.crouchHeld = true; run(b.c, b.input, 20);
  b.input.crouchHeld = false; b.input.sprintHeld = true; b.input.mv = { x: 0, z: 0.0 }; run(b.c, b.input, 20);
  check(b.c.crouched && b.c.state === 'crouch', `se levantó bajo un techo de 1.3 m (${b.c.state})`);
  b.input.jumpPressed = true; run(b.c, b.input, 2);
  check(b.c.grounded && b.c.crouched, 'saltó de pie bajo un techo bajo');
  // sprint levanta del agachado (con techo libre) y suelta el alternado
  const s = make();
  s.input.crouchHeld = true; run(s.c, s.input, 20);
  s.input.crouchHeld = false; s.input.mv = { x: 0, z: 1 }; s.input.sprintHeld = true; run(s.c, s.input, 5);
  check(s.c.state === 'roadie' && !s.c.crouched, 'sprint no levanta del agachado');
}

// ---------- deslizamiento desde sprint ----------
{
  const { c, input } = make();
  input.mv = { x: 0, z: 1 }; input.sprintHeld = true; run(c, input, 60);
  input.crouchPressed = true; input.crouchHeld = true;
  let prev = Infinity, mono = true, frames = 0, start = null;
  c.update(DT, input); input.endFrame();
  check(c.state === 'slide' && c.animState() === 'slide', `agacharse en sprint no desliza (${c.state})`);
  start = c.speed;
  while (c.state === 'slide' && frames < 120) {
    c.update(DT, input); input.endFrame(); frames++;
    if (c.state === 'slide') { if (c.speed > prev + 1e-6) mono = false; prev = c.speed; }
  }
  check(start <= 8 + 1e-6 && start > F.sprintSpeed, `velocidad inicial del slide ${start.toFixed(2)}`);
  check(mono, 'la velocidad del slide no decrece');
  check(Math.abs(frames * DT - F.slideTime) < 0.05, `slide duró ${(frames * DT).toFixed(2)} s`);
  check(c.state === 'crouch', `tras el slide con agachar mantenido: ${c.state}`);
  // sin sprint no hay slide (solo agacharse)
  const b = make(); b.input.mv = { x: 0, z: 1 }; run(b.c, b.input, 60);
  b.input.crouchPressed = true; b.input.crouchHeld = true; run(b.c, b.input, 1);
  check(b.c.state === 'crouch', `agacharse corriendo (sin sprint) deslizó: ${b.c.state}`);
}

// ---------- inclinación: libre, de pie y agachado, y barrida contra pared ----------
{
  for (const crouch of [false, true]) {
    const { c, input } = make();
    input.crouchHeld = crouch; input.leanAxis = 1;
    let t = 0; while (c.lean < 1 && t < 1) { run(c, input, 1); t += DT; }
    check(c.lean === 1 && Math.abs(t - F.leanTime) < 0.04, `inclinarse ${crouch ? 'agachado' : 'de pie'}: ${c.lean} en ${t.toFixed(2)} s`);
    input.leanAxis = -1; run(c, input, 40);
    check(c.lean === -1, 'inclinación izquierda');
    check(c.animParams().cl === -1 && c.coverLeanAnim === -1, 'cl no replica la inclinación');
    input.leanAxis = 0; run(c, input, 40);
    check(c.lean === 0, 'no vuelve al centro');
  }
  // pared a cada lado a distintas distancias, de pie/agachado, cadera/ADS,
  // varios pitch: la esfera de cabeza CALIBRADA (hitPose) nunca entra
  for (const side of [1, -1]) for (const gap of [0.39, 0.45, 0.5, 0.6, 0.7]) for (const crouch of [false, true])
    for (const aim of [false, true]) for (const pitch of [-0.5, 0, 0.4]) {
      const wall = side > 0 ? { minx: gap, maxx: gap + 2, minz: -3, maxz: 3, h: 3 } : { minx: -gap - 2, maxx: -gap, minz: -3, maxz: 3, h: 3 };
      const { c, cam, input } = make(makeWorld([wall], []), { x: 0, z: 0 }, 0);
      cam.pitch = pitch; input.crouchHeld = crouch; input.aimHeld = aim; input.leanAxis = side;
      let worst = -Infinity;
      run(c, input, 50, false, () => { worst = Math.max(worst, headIntrusion(c, [wall])); });
      check(worst <= 1e-3, `inclinación ${side > 0 ? 'der' : 'izq'} pared ${gap} ${crouch ? 'agachado' : 'de pie'} ${aim ? 'ADS' : 'cadera'} pitch ${pitch}: cabeza ${(worst * 100).toFixed(1)} cm dentro (cl ${c.lean.toFixed(3)})`);
      if (gap >= 0.7 && !aim) check(Math.abs(c.lean) > 0.9, `pared lejana a ${gap} limita la inclinación (${c.lean.toFixed(2)})`);
    }
  // acercarse a la pared ya inclinado (y agachado con ADS): se recoge en el mismo paso
  for (const [crouch, aim] of [[false, false], [true, true]]) {
    const wall = { minx: 1.2, maxx: 3, minz: -3, maxz: 3, h: 3 };
    const { c, input } = make(makeWorld([wall], []), { x: 0, z: 0 }, 0);
    input.crouchHeld = crouch; input.aimHeld = aim; input.leanAxis = 1; run(c, input, 30);
    input.mv = { x: 1, z: 0 };
    let worst = -Infinity;
    run(c, input, 120, false, () => { worst = Math.max(worst, headIntrusion(c, [wall])); });
    check(worst <= 1e-3, `cabeza dentro de la pared al acercarse inclinado ${crouch ? 'agachado ADS' : 'de pie'} (${(worst * 100).toFixed(1)} cm)`);
  }
  // levantarse bajo un techo: nunca con la esfera dentro (techo a varias alturas)
  for (const cy of [1.3, 1.62, 1.7, 1.74, 1.78, 2.0]) for (const aim of [false, true]) {
    const ceil = { minx: -2, maxx: 2, minz: -2, maxz: 2, y: cy };
    const { c, input } = make(makeWorld([], [], [ceil]), { x: 0, z: 0 }, 0);
    input.crouchHeld = true; input.aimHeld = aim; run(c, input, 20);
    input.crouchHeld = false;
    let worst = -Infinity;
    run(c, input, 40, false, () => { worst = Math.max(worst, headIntrusion(c, [], [ceil])); });
    check(worst <= 1e-3, `levantarse bajo techo ${cy} ${aim ? 'ADS' : ''}: cabeza ${(worst * 100).toFixed(1)} cm dentro`);
    if (cy >= 2) check(!c.crouched, 'techo alto impide levantarse');
  }
  // asomo junto a una esquina: cara LOW delante y un pilar alto pegado al lado
  for (const px of [0.36, 0.42, 0.5]) for (const lean of [0, 1]) {
    const low = { minx: -3, maxx: 3, minz: -3, maxz: -1, h: 1.1 };
    const pillar = { minx: px, maxx: px + 1, minz: -1.2, maxz: 0.2, h: 3 };
    const faceL = { a: { x: -3, z: -1 }, b: { x: 3, z: -1 }, n: { x: 0, z: 1 }, h: 1.1, topY: 1.1, kind: 'low', collider: low };
    const { c, input } = make(makeWorld([low, pillar], [faceL]), { x: 0, z: -1 + PLAYER_R + 0.3 }, 0);
    input.crouchHeld = true; input.leanAxis = lean; run(c, input, 20);
    input.aimHeld = true;
    let worst = -Infinity;
    run(c, input, 40, false, () => { worst = Math.max(worst, headIntrusion(c, [low, pillar])); });
    check(worst <= 1e-3, `asomo junto a pilar a ${px} (cl ${lean}): cabeza ${(worst * 100).toFixed(1)} cm dentro (ce ${c.peek.toFixed(2)})`);
  }
  // AUDITORÍA 2b: agachado de cara a un muro (pies a la distancia mínima), con
  // y sin ADS: la esfera de cabeza (0.24 m por delante) no entra, y la
  // inclinación hacia la orilla libre sigue funcionando
  for (const aim of [false, true]) for (const pitch of [0, -0.45]) {
    const wall = { minx: -3, maxx: 0.5, minz: -3, maxz: -PLAYER_R - 0.02, h: 3 };
    const { c, cam, input } = make(makeWorld([wall], []), { x: 0, z: 0 }, 0);
    cam.pitch = pitch; input.crouchHeld = true; input.aimHeld = aim; input.mv = { x: 0, z: 0.4 };
    let worst = -Infinity;
    run(c, input, 60, false, () => { worst = Math.max(worst, headIntrusion(c, [wall])); });
    check(worst <= 1e-3, `agachado de cara al muro ${aim ? 'ADS' : ''} pitch ${pitch}: cabeza ${(worst * 100).toFixed(1)} cm dentro`);
    input.mv = { x: 0, z: 0 }; input.leanAxis = 1;
    run(c, input, 40, false, () => { worst = Math.max(worst, headIntrusion(c, [wall])); });
    check(c.lean > 0.9 && worst <= 1e-3, `agachado de cara al muro: inclinación a la orilla libre ${c.lean.toFixed(2)} (cabeza ${(worst * 100).toFixed(1)} cm)`);
  }
  // pasillo de 0.8 m de cara a un pilar (calle2 x −39.2): no hay sitio para
  // retrasar el cuerpo; se agacha solo hasta donde la cabeza queda libre
  {
    const pillar = { minx: -1, maxx: 1, minz: -1.6, maxz: -0.4, h: 1.9 };
    const back = { minx: -3, maxx: 3, minz: 0.4, maxz: 1.2, h: 3 };
    const { c, input } = make(makeWorld([pillar, back], []), { x: 0, z: 0 }, 0);
    input.crouchHeld = true;
    let worst = -Infinity;
    run(c, input, 60, false, () => { worst = Math.max(worst, headIntrusion(c, [pillar, back])); });
    check(worst <= 1e-3 && c.state === 'crouch' && c.crouch01 > 0.2, `pasillo estrecho agachado: cabeza ${(worst * 100).toFixed(1)} cm, crouch01 ${c.crouch01.toFixed(2)}, ${c.state}`);
  }
  // RONDA 2: fachadas de tiendas de calle2 (cajas REALES de colisión, las
  // mismas que la línea de vista del servidor), de pie y agachado, cadera,
  // ADS, inclinado y saliendo de sprint de frente contra la fachada
  {
    const boxes = expandedCollisionBoxes('calle2');
    const strips = boxes.filter((b) => Math.abs(b.maxx + 15.85) < 0.01 || Math.abs(b.minx - 15.85) < 0.01);
    check(strips.length >= 8, `fachadas de calle2: ${strips.length}`);
    let worst = -Infinity, at = null, n = 0;
    for (const b of strips) {
      const side = b.minx > 0 ? 1 : -1;                  // la fachada está hacia +x o −x
      const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;  // mirando a la fachada
      const near = boxes.filter((o) => o.maxx > -18 && o.minx < 18 && o.maxz > b.minz - 3 && o.minz < b.maxz + 3);
      for (const u of [0.2, 0.5, 0.8]) {
        const z = b.minz + (b.maxz - b.minz) * u;
        for (const [crouch, aim, lean, sprint] of [[false, false, 0, false], [false, true, 0, false], [false, true, 1, false], [false, true, -1, false],
          [true, true, 0, false], [true, false, 1, false], [false, false, 0, true], [false, true, 1, true]]) {
          const W = makeWorld(near, []);
          // solo sitios donde se puede estar (sin mobiliario encima) y con
          // la fachada libre de frente (sin jardinera en medio)
          const probe = { x: side * 14.6, z }; W.resolveCircle(probe, PLAYER_R, 0);
          if (Math.hypot(probe.x - side * 14.6, probe.z - z) > 0.01 || W.groundHeight(probe, PLAYER_R, 0) > 0.05) continue;
          if (near.some((o) => o !== b && o.maxz > z - 0.7 && o.minz < z + 0.7 && (side > 0 ? o.minx < 15.85 && o.maxx > 14.2 : o.maxx > -15.85 && o.minx < -14.2))) continue;
          const { c, input } = make(W, { x: side * 14.6, z }, yaw);
          input.mv = { x: 0, z: 1 }; input.sprintHeld = sprint;
          run(c, input, 60);
          input.sprintHeld = false; input.crouchHeld = crouch; input.aimHeld = aim; input.leanAxis = lean;
          run(c, input, 60, false, () => { const v = headIntrusion(c, near); if (v > worst) { worst = v; at = { side, z: +z.toFixed(2), crouch, aim, lean, sprint, x: +c.pos.x.toFixed(3) }; } });
          n++;
        }
      }
    }
    check(n >= 48, `pocos casos de fachada: ${n}`);
    if (process.env.VERBOSE) console.log('fachadas calle2', n, 'casos, peor', worst);
    check(worst <= 1e-3, `fachadas de calle2 (${n} casos): cabeza ${(worst * 100).toFixed(1)} cm dentro ${JSON.stringify(at)}`);
  }
  // AUDITORÍA 2a: la mezcla de transición (sprint → parar e inclinarse junto
  // a una pared) y el sprint de frente contra un muro, con la pose que viaja
  {
    const wall = { minx: PLAYER_R + 0.02, maxx: 3, minz: -9, maxz: 3, h: 3 };
    const { c, input } = make(makeWorld([wall], []), { x: 0, z: 0 }, 0);
    input.mv = { x: 0, z: 1 }; input.sprintHeld = true; run(c, input, 40);
    input.mv = { x: 0, z: 0 }; input.sprintHeld = false; input.leanAxis = 1; input.aimHeld = true;
    let worst = -Infinity;
    run(c, input, 40, false, () => { worst = Math.max(worst, headIntrusion(c, [wall])); });
    check(worst <= 1e-3, `salir del sprint junto a pared e inclinarse: cabeza ${(worst * 100).toFixed(1)} cm dentro`);
    const front = { minx: -3, maxx: 3, minz: -6, maxz: -4, h: 3 };
    const b = make(makeWorld([front], []), { x: 0, z: 0 }, 0);
    b.input.mv = { x: 0, z: 1 }; b.input.sprintHeld = true;
    let w2 = -Infinity;
    run(b.c, b.input, 120, false, () => { w2 = Math.max(w2, headIntrusion(b.c, [front])); });
    check(w2 <= 1e-3, `sprint de frente contra un muro: cabeza ${(w2 * 100).toFixed(1)} cm dentro`);
  }
  // AUDITORÍA 2a: un desplazamiento externo (empujón entre cuerpos de main.js)
  // que mete la cabeza: settle() la saca en la posición final
  {
    const wall = { minx: 0.7, maxx: 3, minz: -3, maxz: 3, h: 3 };
    const { c, input } = make(makeWorld([wall], []), { x: 0, z: 0 }, 0);
    input.leanAxis = 1; input.aimHeld = true; run(c, input, 30);
    c.pos.x += 0.25; c.world.resolveCircle(c.pos, PLAYER_R, c.y); // empujón
    check(typeof c.settle === 'function', 'falta player.settle() para después del empujón');
    c.settle?.();
    check(headIntrusion(c, [wall]) <= 1e-3, `tras el empujón la cabeza queda ${(headIntrusion(c, [wall]) * 100).toFixed(1)} cm dentro`);
    const e = c.eyeWorld?.();
    check(Array.isArray(e) && e.length === 3 && e[0] < wall.minx, `eyeWorld() resuelto: ${e}`);
  }
  // no hay inclinación en sprint ni en el aire
  const s = make(); s.input.mv = { x: 0, z: 1 }; s.input.sprintHeld = true; s.input.leanAxis = 1; run(s.c, s.input, 40);
  check(s.c.lean === 0, 'inclinación durante el sprint');
}

// ---------- asomo sobre cara LOW (ce continuo) ----------
{
  const low = { minx: -3, maxx: 3, minz: -3, maxz: -1, h: 1.1 };
  const high = { minx: -3, maxx: 3, minz: -3, maxz: -1, h: 1.9 };
  const mk = (box, kind, z = -1 + PLAYER_R + 0.4) => make(makeWorld([box], [faceOf(box, kind)]), { x: 0, z }, 0);
  const { c, input } = mk(low, 'low');
  input.crouchHeld = true; run(c, input, 20);
  check(c.peek === 0, 'asoma sin apuntar');
  input.aimHeld = true;
  let t = 0, maxStep = 0, prev = 0;
  while (c.peek < 1 && t < 1) { run(c, input, 1); t += DT; maxStep = Math.max(maxStep, c.peek - prev); prev = c.peek; }
  check(c.peek === 1 && Math.abs(t - F.peekRise) < 0.04, `asomo: ce ${c.peek} en ${t.toFixed(2)} s`);
  check(maxStep <= DT / F.peekRise + 1e-6, `ce salta ${maxStep.toFixed(3)} por cuadro`);
  check(c.animState() === 'crouch' && c.animParams().ce === 1 && c.coverAimExposure === 1, 'el asomo no replica crouch + ce');
  check(Math.abs(c.eyeHeight() - F.eyeStand) < 1e-6, `ojo asomado ${c.eyeHeight().toFixed(2)} (de pie)`);
  input.aimHeld = false; t = 0;
  while (c.peek > 0 && t < 1) { run(c, input, 1); t += DT; }
  check(Math.abs(t - F.peekFall) < 0.04, `bajar del asomo tardó ${t.toFixed(2)} s`);
  // ajuste apagado
  setSetting('autoPeek', false, { save: false });
  input.aimHeld = true; run(c, input, 30);
  check(c.peek === 0, 'asomo con autoPeek apagado');
  setSetting('autoPeek', true, { save: false });
  // cara alta, lejos, o de pie: nada
  for (const [label, w] of [['MID', mk(high, 'high')], ['lejos', mk(low, 'low', 1.8)]]) {
    w.input.crouchHeld = true; w.input.aimHeld = true; run(w.c, w.input, 40);
    check(w.c.peek === 0, `asomo sobre ${label}`);
  }
  const st = mk(low, 'low'); st.input.aimHeld = true; run(st.c, st.input, 40);
  check(st.c.peek === 0, 'asomo de pie');
  // mirando hacia otro lado
  const away = mk(low, 'low'); away.cam.yaw = Math.PI; away.input.crouchHeld = true; away.input.aimHeld = true; run(away.c, away.input, 40);
  check(away.c.peek === 0, 'asomo de espaldas a la cara');
}

// ---------- trepar: solo LOW, con la acción de salto ----------
{
  const low = { minx: -3, maxx: 3, minz: -3, maxz: -1, h: 1.1 };
  const high = { minx: -3, maxx: 3, minz: -3, maxz: -1, h: 1.9 };
  const z0 = -1 + PLAYER_R + 0.3;
  const a = make(makeWorld([low], [faceOf(low, 'low')]), { x: 0, z: z0 }, 0);
  a.input.jumpPressed = true; run(a.c, a.input, 1);
  check(a.c.state === 'mantle' && a.c.animState() === 'mantle', `no trepa LOW (${a.c.state})`);
  check(!a.c.fireAligned(), 'se puede disparar trepando');
  run(a.c, a.input, 40);
  check(Math.abs(a.c.y - 1.1) < 0.05 && a.c.state !== 'mantle', `trepar terminó a y=${a.c.y.toFixed(2)} (${a.c.state})`);
  const b = make(makeWorld([high], [faceOf(high, 'high')]), { x: 0, z: z0 }, 0);
  b.input.jumpPressed = true; run(b.c, b.input, 1);
  check(b.c.state !== 'mantle' && !b.c.grounded, 'trepa MID o no salta');
  const c = make(makeWorld([low], [faceOf(low, 'low')]), { x: 0, z: z0 }, Math.PI);
  c.input.jumpPressed = true; run(c.c, c.input, 1);
  check(c.c.state !== 'mantle', 'trepa mirando hacia otro lado');
}

// ---------- retraso sprint → disparo por arma ----------
{
  for (const [wep, delay] of [['smg', 0.15], ['shotgun', 0.22], ['sniper', 0.3]]) {
    const { c, input } = make();
    c.setWeapon(wep);
    input.mv = { x: 0, z: 1 }; input.sprintHeld = true; run(c, input, 40);
    check(!c.fireAligned(), `${wep}: dispara en sprint`);
    // la intención de disparo corta el sprint; el retraso empieza ahí
    c.update(DT, input, true); input.endFrame();
    check(c.state !== 'roadie' && input.released.includes('sprint'), `${wep}: disparar no corta el sprint`);
    const buf = requiredFireBuffer(c, { cd: 0 }, 0, 0);
    check(buf >= c.fireReadyIn() + 0.07 - 1e-9, `${wep}: el buffer (${buf.toFixed(2)}) no cubre el retraso`);
    let t = 0; while (!c.fireAligned() && t < 1) { c.update(DT, input, true); input.endFrame(); t += DT; }
    check(Math.abs(t - delay) <= DT + 1e-6, `${wep}: retraso sprint→disparo ${t.toFixed(3)} s (esperado ${delay})`);
    check(TUNING.weapons[wep].sprintToFire >= 0.15 && TUNING.weapons[wep].sprintToFire <= 0.3, `${wep}: retraso fuera de 0.15–0.3`);
  }
}

// ---------- AUDITORÍA 1: lanzamiento comprometido (DECISIONES 18) ----------
// entre throwStart y throwRelease no se entra en sprint; al soltar, el estado
// replicado es legal para el arrojadizo según la tabla compartida
for (const quick of [false, true]) {
  const { c, input } = make();
  const w = new Weapons();
  check(typeof c.bindWeapons === 'function', 'falta player.bindWeapons(weapons)');
  c.bindWeapons?.(w);
  let atRelease = null, sprintDuring = false, started = false;
  w.on('throwStart', () => { started = true; });
  w.on('throwRelease', () => { atRelease = c.animState(); });
  if (quick) w.quickThrow(); else { w.startSwap('grenade'); for (let i = 0; i < 40; i++) w.update(DT, false, false, true); }
  for (let i = 0; i < 80; i++) {
    const firing = !quick && i === 0;
    c.update(DT, input, firing);
    w.update(DT, false, firing, c.fireAligned());
    if (started) { input.mv = { x: 0, z: 1 }; input.sprintHeld = true; }
    if (started && atRelease === null && c.state === 'roadie') sprintDuring = true;
    input.endFrame();
  }
  check(started && atRelease !== null, `${quick ? 'rápida' : 'normal'}: no hubo lanzamiento`);
  check(!sprintDuring, `${quick ? 'rápida' : 'normal'}: entró en sprint antes de soltar`);
  check(atRelease && canFireInState(atRelease, 'grenade'), `${quick ? 'rápida' : 'normal'}: estado al soltar ${atRelease} ilegal`);
  check(c.state === 'roadie', `${quick ? 'rápida' : 'normal'}: el sprint retrasado no llegó tras soltar (${c.state})`);
}

// ---------- AUDITORÍA 3: entrada legal a slide/placaje (constantes para el servidor) ----------
{
  check(MOVE_GATES && MOVE_GATES.slide && MOVE_GATES.tackle, 'faltan MOVE_GATES en fire-gates.js');
  const S = MOVE_GATES?.slide ?? {}, K = MOVE_GATES?.tackle ?? {};
  check(S.minEntrySpeed === F.slideMinSpeed && S.maxSpeed === F.slideMaxSpeed && S.duration === F.slideTime && S.cooldown === F.slideCooldown,
    `constantes del slide ${JSON.stringify(S)}`);
  check(S.minCycle >= F.slideTime + F.slideCooldown - 1e-9, 'ciclo mínimo de slide');
  // la aceleración real del controller: el sprint previo mínimo nunca rechaza a un honesto
  const { c, input } = make();
  input.mv = { x: 0, z: 1 }; run(c, input, 90);
  input.sprintHeld = true; let t = 0;
  while (c.speed < F.slideMinSpeed && t < 2) { run(c, input, 1); t += DT; }
  check(S.minPriorSprint > 0 && S.minPriorSprint <= t + 1e-9 && S.minPriorSprint > t - 3 * DT, `sprint previo mínimo ${S.minPriorSprint} vs medido ${t.toFixed(3)}`);
  check(K.minEntrySpeed === F.runSpeed * 1.15 && K.topSpeed === F.tackleTopSpeed && K.maxTravel === TUNING.melee.tackleMax, `constantes del placaje ${JSON.stringify(K)}`);
  check(K.minPriorSprint > 0 && K.minPriorSprint <= S.minPriorSprint && K.minCycle > TUNING.melee.hitAt, `placaje: ciclo/sprint previo ${JSON.stringify(K)}`);
}

// ---------- placaje limitado a 11 m/s ----------
{
  const target = { id: 'b', x: 0, z: -4.4 };
  const { c, input } = make(makeWorld(), { x: 0, z: 0 }, 0, {
    meleeTarget: () => target, meleeTargetPos: () => target,
  });
  input.mv = { x: 0, z: 1 }; input.sprintHeld = true; run(c, input, 60);
  input.meleePressed = true;
  let top = 0;
  run(c, input, 20, false, () => { if (c.state === 'melee') top = Math.max(top, c.speed); });
  check(top > 0 && top <= F.tackleTopSpeed + 1e-6, `placaje a ${top.toFixed(2)} m/s`);
}

{
  const target = { id: 'b', x: 0, z: -1.5 };
  const { c, cam, input } = make(makeWorld(), { x: 0, z: 0 }, 0, {
    meleeTarget: () => target, meleeTargetPos: () => target,
  });
  input.meleePressed = true; run(c, input, 1);
  cam.yaw = Math.PI * 0.8;
  run(c, input, 1);
  check(c.state === 'melee' && Math.abs(c.cameraYawError()) <= TUNING.combat.visualAimMaxDeg * Math.PI / 180 + 1e-9,
    'girar durante una embestida debe conservar la mirada en la muestra de contacto');
}

// ---------- muerte y reaparición limpian la postura ----------
{
  const { c, input } = make();
  input.crouchHeld = true; input.leanAxis = 1; run(c, input, 30);
  c.kill();
  check(c.crouch01 === 0 && c.lean === 0 && c.peek === 0 && !c.crouched, 'kill no limpia la postura');
  check(c.animState() === 'dead', 'muerto no emite dead');
  c.respawn({ x: 1, z: 1, yaw: 0 });
  check(c.state === 'idle' && c.sinceSprint === Infinity, 'respawn no limpia');
}

if (failures.length) {
  console.error(`FPS MOVEMENT FAIL (${failures.length})\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('FPS MOVEMENT OK — velocidades, vista, sin estados retirados, salto, agachado/techo, slide, inclinación barrida, asomo, trepar LOW, sprint→disparo, placaje');
