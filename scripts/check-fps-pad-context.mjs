// Mando FPS (etapa B, JUGABILIDAD). Solo Node, con un Gamepad API simulado:
// - la cruceta asignada a una acción NO selecciona además un arma;
// - inclinarse por defecto (L3/R3 compartidos) solo actúa apuntando, como
//   alternar, y entonces L3/R3 no esprintan ni agachan; sin apuntar son
//   sprint/agacharse como siempre.
const noop = () => {};
globalThis.window = { addEventListener: noop };
globalThis.document = { addEventListener: noop, pointerLockElement: null };
globalThis.location = { search: '?nolock=1' };
let pads = [];
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux', getGamepads: () => pads }, configurable: true });
const { Input } = await import('../src/core/input.js');
const { BINDS, BIND_DEFAULTS, loadBinds } = await import('../src/core/bindings.js');
loadBinds(null);

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const mkPad = () => ({ index: 0, id: 'Xbox test', mapping: 'standard', connected: true, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
const pad = mkPad(); pads = [pad];
const input = new Input({ addEventListener: noop });
const press = (i, on) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
const frame = () => { input.pollPad(1 / 60, true); };
const tap = (i) => { press(i, true); frame(); const st = { slot: input.slotPressed, crouch: input.crouchPressed, lean: input.leanAxis, crouchHeld: input.crouchHeld, sprint: input.sprintHeld }; input.consumeEdges(); press(i, false); frame(); input.consumeEdges(); return st; };
frame();

// cruceta por defecto: elige arma
check(tap(14).slot === 1, 'cruceta izquierda no elige la escopeta');
// cruceta asignada a inclinarse: no elige arma
BINDS.pad.leanLeft = 14;
check(tap(14).slot === -1, 'inclinarse en la cruceta también selecciona arma');
press(14, true); frame();
check(input.leanAxis === -1, 'inclinación en botón propio no se mantiene');
press(14, false); frame(); input.consumeEdges();
BINDS.pad.leanLeft = BIND_DEFAULTS.pad.leanLeft;

// por defecto: L3/R3 sin apuntar = sprint / agacharse, sin inclinar
check(BIND_DEFAULTS.pad.leanLeft === BIND_DEFAULTS.pad.sprint && BIND_DEFAULTS.pad.leanRight === BIND_DEFAULTS.pad.crouch, 'inclinación por defecto en L3/R3');
let s = tap(11);
check(s.crouch && s.lean === 0, `R3 sin apuntar: agacharse ${s.crouch}, inclinación ${s.lean}`);
press(10, true); frame();
check(input.sprintHeld && input.leanAxis === 0, 'L3 sin apuntar no esprinta o inclina');
press(10, false); frame(); input.consumeEdges();
// apuntando: R3 inclina a la derecha (alternar), sin agacharse
press(6, true); frame(); input.aimHeld;
s = tap(11);
check(!s.crouch && !input.crouchHeld && input.leanAxis === 1, `R3 apuntando: agacharse ${s.crouch}, inclinación ${input.leanAxis}`);
s = tap(10);
check(input.leanAxis === -1, `L3 apuntando no cambia a la izquierda (${input.leanAxis})`);
s = tap(10);
check(input.leanAxis === 0, 'pulsar otra vez no endereza');
tap(11);
press(6, false); frame();
check(input.leanAxis === 0, 'soltar el ADS no endereza');
// agachado (mantener R3) y luego apuntar: sigue agachado
press(11, true); frame(); input.consumeEdges();
press(6, true); frame();
check(input.crouchHeld, 'apuntar con R3 ya mantenido levanta al jugador');
press(11, false); press(6, false); frame();

if (failures.length) { console.error(`FPS PAD CONTEXT FAIL (${failures.length})\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log('FPS PAD CONTEXT OK — cruceta asignada no elige arma; inclinación L3/R3 solo apuntando (alternar), sprint/agacharse fuera de ADS');
