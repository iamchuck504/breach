// Regresiones deterministas de la máquina de estados. No necesita navegador:
// ataca directamente las combinaciones que antes daban falsos positivos en
// el harness visual (dive->dive, acciones simultáneas y momentum lógico).
import { Controller } from '../src/player/controller.js';
import { TUNING } from '../src/config/tuning.js';
import { DEFAULT_LOADOUT, Weapons } from '../src/combat/weapons.js';
import { PAD_DPAD_SLOTS } from '../src/core/bindings.js';

const DT = 1 / 60;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

class TestInput {
  constructor() {
    this.mv = { x: 0, z: 0 };
    this.sprintHeld = false;
    this.jumpPressed = false;
    this.evadePressed = false;
    this.aimHeld = false;
    this.firePressed = false;
    this.weaponPressed = false;
  }
  moveVec() { return this.mv; }
  endFrame() { this.jumpPressed = false; this.evadePressed = false; }
}

function makeController() {
  const ranges = [];
  const world = {
    findCover(_p, _d, range) { ranges.push(range); return null; },
    resolveCircle() {},
    groundHeight() { return 0; },
    raycast() { return null; },
  };
  const camera = {
    flatForward() { return { x: 0, z: -1 }; },
    flatRight() { return { x: 1, z: 0 }; },
    yaw: 0,
    pitch: 0,
    thirdPerson: true,
    targetYaw: 0,
  };
  let dives = 0;
  const controller = new Controller(world, camera, { onDive() { dives++; } });
  controller.respawn({ x: 0, z: 0, yaw: 0 });
  return { controller, world, ranges, dives: () => dives };
}

function frame(controller, input, count = 1) {
  for (let i = 0; i < count; i++) {
    controller.update(DT, input);
    input.endFrame();
  }
}

// Selección directa: teclado 1–4 conserva el orden del loadout y la cruceta
// utiliza el layout espacial solicitado (escopeta izquierda, SMG derecha).
check(DEFAULT_LOADOUT.join(',') === 'smg,shotgun,pistol,grenade',
  `orden numérico inválido (${DEFAULT_LOADOUT.join(',')})`);
check(DEFAULT_LOADOUT[PAD_DPAD_SLOTS[12]] === 'grenade' &&
  DEFAULT_LOADOUT[PAD_DPAD_SLOTS[13]] === 'pistol' &&
  DEFAULT_LOADOUT[PAD_DPAD_SLOTS[14]] === 'shotgun' &&
  DEFAULT_LOADOUT[PAD_DPAD_SLOTS[15]] === 'smg',
`mapeo de cruceta inválido (${JSON.stringify(PAD_DPAD_SLOTS)})`);

function putAtCoverEdge(controller, h = 1.1) {
  controller.cover = {
    a: { x: -3, z: 0 }, b: { x: 3, z: 0 }, n: { x: 0, z: 1 }, h,
  };
  controller.state = 'cover';
  controller.stateT = 0.5;
  controller.pos = { x: 3 - 0.38 * 0.7, z: 0.38 };
  controller.vel = { x: 0, z: 0 };
}

// Correr normal debe ser run lógico y ganar momentum real.
{
  const { controller } = makeController();
  const input = new TestInput();
  input.mv = { x: 0, z: 1 };
  frame(controller, input, 90);
  check(controller.state === 'run', `carrera normal quedó en ${controller.state}`);
  check(controller.runT > 1, `carrera no acumuló tiempo (${controller.runT})`);
  check(controller.runDist >= TUNING.evade.momentumRunDist,
    `carrera no acumuló distancia (${controller.runDist})`);
}

// Spam en campo abierto nunca puede reiniciar dive->dive.
{
  const { controller, dives } = makeController();
  const input = new TestInput();
  input.mv = { x: 0, z: 1 };
  let restarts = 0;
  for (let i = 0; i < 300; i++) {
    const beforeState = controller.state;
    const beforeT = controller.stateT;
    input.evadePressed = i === 0 || i % 12 === 0;
    controller.update(DT, input);
    if (beforeState === 'dive' && controller.state === 'dive' && controller.stateT < beforeT) restarts++;
    input.endFrame();
  }
  check(restarts === 0, `spam reinició dive ${restarts} veces`);
  // Pulsos cada 200 ms: como cada dive dura 360 ms, solo uno de cada dos
  // puede iniciar otro; no existe espera adicional después de terminar.
  check(dives() >= 12 && dives() <= 14, `spam inició ${dives()} evasiones en 5 s`);
}

// Al recuperar control, la siguiente pulsación funciona en el primer frame.
{
  const { controller, dives } = makeController();
  const input = new TestInput();
  input.mv = { x: 0, z: 1 };
  input.evadePressed = true;
  frame(controller, input);
  let guard = 0;
  while (controller.state === 'dive' && guard++ < 60) frame(controller, input);
  check(controller.state === 'run', `evade no devolvió control (${controller.state})`);
  input.evadePressed = true;
  frame(controller, input);
  check(controller.state === 'dive' && dives() === 2,
    `segunda pulsación inmediata no inició evade (${controller.state}, ${dives()})`);
}

// Mantener el botón no genera otro edge al terminar la animación.
{
  const { controller, dives } = makeController();
  const input = new TestInput();
  input.mv = { x: 0, z: 1 };
  input.evadePressed = true; // único keydown válido
  frame(controller, input);
  input.evadeHeld = true;    // el controlador deliberadamente no consume held
  frame(controller, input, 120);
  check(dives() === 1, `botón mantenido inició ${dives()} evasiones`);
}

// Un input opuesto durante dive no invierte la velocidad instantáneamente.
{
  const { controller } = makeController();
  const input = new TestInput();
  input.mv = { x: 1, z: 0 };
  input.evadePressed = true;
  frame(controller, input);
  frame(controller, input, 11);
  const before = { ...controller.vel };
  input.mv = { x: -1, z: 0 };
  input.evadePressed = true;
  frame(controller, input, 2);
  check(before.x * controller.vel.x + before.z * controller.vel.z > 0,
    'evade opuesto invirtió la velocidad en seco');
}

// Sprint+evade sin carrera previa no obtiene alcance roadie.
{
  const { controller, ranges } = makeController();
  const input = new TestInput();
  frame(controller, input, 10);
  input.mv = { x: 0, z: 1 };
  input.sprintHeld = true;
  input.evadePressed = true;
  frame(controller, input);
  check(Math.max(...ranges) <= TUNING.evade.slideMaxDist,
    `sprint+evade regaló alcance ${Math.max(...ranges)}`);
}

// En el extremo, botones explícitos ganan a la salida automática.
{
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller);
  input.mv = { x: 1, z: 0 };
  input.sprintHeld = true;
  input.jumpPressed = true;
  frame(controller, input);
  check(controller.state === 'run' && !controller.grounded,
    `Shift+salto terminó ${controller.state}, grounded=${controller.grounded}`);
}
{
  const { controller, dives } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller);
  input.mv = { x: 1, z: 0 };
  input.sprintHeld = true;
  input.evadePressed = true;
  frame(controller, input);
  check(controller.state === 'dive' && dives() === 1,
    `Shift+evade terminó ${controller.state}`);
}
{
  const { controller, dives } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller);
  input.mv = { x: 0.72, z: 0.72 };
  input.evadePressed = true;
  frame(controller, input);
  check(controller.state === 'dive' && dives() === 1,
    `evade diagonal de extremo terminó ${controller.state}`);
}

// El stick lateral queda locked-in incluso sostenido contra el extremo.
{
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller, 2.1);
  input.mv = { x: 1, z: 0 };
  frame(controller, input, 90);
  check(controller.state === 'cover' && !!controller.cover,
    `stick lateral expulsó del cover (${controller.state})`);
  check(controller.speed < 0.05,
    `stick contra el extremo dejó velocidad fantasma (${controller.speed})`);
}

// En cover alto, disparar desde la orilla activa blindfire contextual aunque
// la cámara no apunte con precisión alrededor de la esquina.
for (const side of [-1, 1]) {
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller, 2.1);
  if (side < 0) controller.pos.x = -3 + 0.38 * 0.7;
  frame(controller, input, 1);
  controller.update(DT, input, true);
  check(controller.state === 'cover' && !!controller.blindMode,
    `blindfire alto ${side < 0 ? 'izquierdo' : 'derecho'} no activó pose`);
}

// Engancharse a una cobertura cercana absorbe distancia y momentum en varios
// frames; nunca teletransporta ni borra en seco la componente paralela.
{
  const { controller } = makeController();
  const input = new TestInput();
  const face = {
    a: { x: -3, z: 0 }, b: { x: 3, z: 0 }, n: { x: 0, z: 1 }, h: 2.1,
  };
  controller.pos = { x: 0, z: 1.05 };
  controller.vel = { x: 2.2, z: -4.4 };
  const before = { ...controller.pos };
  controller._enterCover(face, { x: 0, z: 0.38 });
  check(controller.pos.x === before.x && controller.pos.z === before.z,
    'entrada a cover cambió la posición en el mismo frame');
  check(controller.vel.x > 1 && Math.abs(controller.vel.z) < 0.01,
    `entrada a cover no conservó momentum paralelo (${controller.vel.x}, ${controller.vel.z})`);
  controller.update(DT, input, false);
  const firstStep = Math.hypot(controller.pos.x - before.x, controller.pos.z - before.z);
  check(firstStep > 0.001 && firstStep < 0.2,
    `primer frame de entrada a cover fue inválido (${firstStep})`);
  for (let i = 0; i < 20; i++) controller.update(DT, input, false);
  check(Math.abs(controller.pos.z - 0.38) < 0.015 && !controller.coverEntry,
    `entrada a cover no se asentó (${controller.pos.z}, entry=${!!controller.coverEntry})`);
}

// La transición lateral de blindfire queda lista temprano; el chequeo físico
// de muzzle/brazos sigue siendo la autoridad final en el loop de combate.
{
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller, 2.1);
  let readyFrame = 0;
  while (controller.blindPoseExposure < TUNING.cover.blindFireReady && readyFrame < 10) {
    controller.update(DT, input, true);
    readyFrame++;
  }
  check(readyFrame <= 2 && !!controller.blindMode,
    `blindfire lateral tardó ${readyFrame} frames en quedar listo`);
}

// Pendiente descendente: los pies permanecen adheridos al suelo y el rig
// recibe pitch negativo, sin alternar entre grounded/airborne.
{
  const { controller, world } = makeController();
  world.groundHeight = (p) => Math.max(0, Math.min(1, 1 + p.z * 0.2));
  controller.respawn({ x: 0, z: 0, yaw: 0 });
  controller.y = 1;
  const input = new TestInput();
  input.mv = { x: 0, z: 1 };
  let airFrames = 0, minPitch = 0;
  for (let i = 0; i < 80; i++) {
    controller.update(DT, input, false);
    if (!controller.grounded) airFrames++;
    minPitch = Math.min(minPitch, controller.groundPitch);
  }
  check(airFrames === 0, `bajada de rampa produjo ${airFrames} frames en el aire`);
  check(minPitch < -0.08, `bajada de rampa no inclinó el cuerpo (${minPitch})`);
  check(Math.abs(controller.y - world.groundHeight(controller.pos)) < 0.01,
    `pies se separaron de la rampa (${controller.y})`);
}

// Entrar de lado a una superficie alta no puede elevar al personaje sin una
// transición válida. El movimiento queda bloqueado en el borde.
{
  const { controller, world } = makeController();
  world.groundHeight = (p, r = 0) =>
    (Math.abs(p.x) - r <= 1.55 && Math.abs(p.z) < 2 ? 0.9 : 0);
  controller.respawn({ x: 2.05, z: 0, yaw: 0 });
  const input = new TestInput();
  input.mv = { x: -1, z: 0 };
  frame(controller, input, 90);
  check(controller.y < 0.02, `aproximación lateral subió sin animación (${controller.y})`);
  check(controller.pos.x >= 1.9,
    `personaje atravesó el costado elevado (${controller.pos.x})`);
}

// La adaptación visual de una pendiente no puede filtrarse a la vida
// siguiente después de spectator/respawn.
{
  const { controller } = makeController();
  controller.groundPitch = -0.24;
  controller.respawn({ x: 2, z: 3, yaw: 0.5 });
  check(controller.groundPitch === 0,
    `respawn conservó la inclinación anterior (${controller.groundPitch})`);
}

// Salidas explícitas: sprint+lateral sale; stick atrás usa detach filtrado.
{
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller, 2.1);
  input.mv = { x: 1, z: 0 };
  input.sprintHeld = true;
  frame(controller, input);
  check(controller.state === 'roadie', `sprint+lateral terminó ${controller.state}`);
}
{
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller, 2.1);
  input.mv = { x: 0, z: -1 };
  frame(controller, input, 12);
  check(controller.state === 'run' && !controller.cover,
    `stick atrás no hizo detach (${controller.state})`);
}

// Un diagonal principalmente lateral no debe confundirse con stick atrás.
{
  const { controller } = makeController();
  const input = new TestInput();
  putAtCoverEdge(controller, 2.1);
  input.mv = { x: 1, z: -0.25 };
  frame(controller, input, 30);
  check(controller.state === 'cover' && !!controller.cover,
    `diagonal lateral expulsó del cover (${controller.state})`);
}

// Muerte cancela swap/reload y conserva el arma visible en ese instante.
{
  const weapons = new Weapons();
  weapons.startSwap();
  weapons.update(0.12, false, false, false);
  const atDeath = weapons.cur;
  weapons.cancelActions();
  weapons.update(0.3, false, false, false);
  check(weapons.cur === atDeath && !weapons.swapping && !weapons.reloading,
    `arma cambió tras morir (${atDeath} -> ${weapons.cur})`);
}

// La muerte tiene prioridad sobre cualquier transición de movimiento. Ningún
// estado de cover/evade/mantle puede sobrevivir hasta spectator o respawn.
for (const state of ['cover', 'slide', 'dive', 'mantle', 'roadie']) {
  const { controller } = makeController();
  controller.state = state;
  controller.cover = { a: { x: -2, z: 0 }, b: { x: 2, z: 0 }, h: 2 };
  controller.coverEntry = { target: { x: 0, z: 0.38 }, t: 0.02, dur: 0.15, tangentSpeed: 2 };
  controller.slide = { target: { x: 1, z: 1 }, face: controller.cover, dir: { x: 1, z: 0 } };
  controller.dive = { dir: { x: 1, z: 0 } };
  controller.mantle = { t: 0.2, dur: 0.6 };
  controller.aim = true;
  controller.firingBlind = 0.25;
  controller.blindMode = 'right';
  controller.vel = { x: 5, z: -2 };
  controller.kill();
  check(controller.dead && controller.state === 'idle',
    `muerte desde ${state} dejó estado ${controller.state}`);
  check(!controller.cover && !controller.coverEntry && !controller.slide &&
    !controller.dive && !controller.mantle && !controller.aim &&
    !controller.blindMode && controller.firingBlind === 0 && controller.speed === 0,
  `muerte desde ${state} conservó estado transitorio`);
  controller.respawn({ x: 0, z: 0, yaw: 0 });
  check(!controller.dead && controller.state === 'idle' && controller.grounded,
    `respawn después de ${state} no recuperó control`);
}

if (failures.length) {
  for (const failure of failures) console.error('FALLO:', failure);
  process.exit(1);
}
console.log('CONTROLLER OK');
