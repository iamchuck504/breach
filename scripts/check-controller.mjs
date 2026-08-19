// Regresiones deterministas de la máquina de estados. No necesita navegador:
// ataca directamente las combinaciones que antes daban falsos positivos en
// el harness visual (dive->dive, acciones simultáneas y momentum lógico).
import { Controller } from '../src/player/controller.js';
import { TUNING } from '../src/config/tuning.js';
import { Weapons } from '../src/combat/weapons.js';

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
  check(dives() <= 8, `spam inició ${dives()} evasiones en 5 s`);
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

if (failures.length) {
  for (const failure of failures) console.error('FALLO:', failure);
  process.exit(1);
}
console.log('CONTROLLER OK');
