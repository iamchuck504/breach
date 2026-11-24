// Regresiones deterministas de la máquina de estados del jugador. Sin navegador.
// PRUEBAS (corrida 6, FPS): se retiraron los bloques de rodada/evadir, cobertura
// pegada y blindfire (mecánicas retiradas del jugador; ver run6/pruebas/tabla.md).
// Lo que garantizaban y sigue vivo está en check-fps-movement (sin dive/flip,
// slide ≤8 m/s, la inclinación nunca mete la cabeza, el asomo baja al soltar).
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
    this.crouchHeld = false;
    this.aimHeld = false;
    this.firePressed = false;
    this.weaponPressed = false;
  }
  moveVec() { return this.mv; }
  endFrame() { this.jumpPressed = false; this.crouchPressed = false; }
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
  const controller = new Controller(world, camera, {});
  controller.respawn({ x: 0, z: 0, yaw: 0 });
  return { controller, world, ranges };
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

// Correr normal debe ser run lógico.
{
  const { controller } = makeController();
  const input = new TestInput();
  input.mv = { x: 0, z: 1 };
  frame(controller, input, 90);
  check(controller.state === "run", `carrera normal quedó en ${controller.state}`);
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

// La muerte tiene prioridad sobre cualquier transición de movimiento: ningún
// estado ni postura FPS (slide, mantle, sprint, agachado, inclinado, asomado,
// golpe) sobrevive hasta espectador o reaparición.
for (const state of ["slide", "mantle", "roadie", "crouch", "melee"]) {
  const { controller } = makeController();
  controller.state = state;
  controller.slide = { t: 0.1, dur: 0.5, dir: { x: 1, z: 0 } };
  controller.mantle = { t: 0.2, dur: 0.6 };
  controller.crouched = true; controller.crouch01 = 1;
  controller.lean = -1; controller.peek = 0.6;
  controller.aim = true;
  controller.vel = { x: 5, z: -2 };
  controller.kill();
  check(controller.dead && controller.state === "idle",
    `muerte desde ${state} dejó estado ${controller.state}`);
  check(!controller.slide && !controller.mantle && !controller.aim && !controller.crouched &&
    controller.crouch01 === 0 && controller.lean === 0 && controller.peek === 0 &&
    controller.stanceLow === 0 && controller.speed === 0,
  `muerte desde ${state} conservó estado transitorio`);
  controller.respawn({ x: 0, z: 0, yaw: 0 });
  check(!controller.dead && controller.state === "idle" && controller.grounded,
    `respawn después de ${state} no recuperó control`);
}

if (failures.length) {
  for (const failure of failures) console.error("FALLO:", failure);
  process.exit(1);
}
console.log("CONTROLLER OK");
