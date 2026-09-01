// Regresión de Steam Input: pads virtuales/physical duplicados, índices con
// huecos, ejes DInput en -1 y hot-swap sin recargar la página.
import { PadInput } from '../src/core/gamepad.js';

const buttons = () => Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
const pad = (id, index, mapping = 'standard', axes = [0, 0, 0, 0]) => ({
  id, index, mapping, connected: true, axes, buttons: buttons(),
});
const press = (gp, index, down = true) => {
  gp.buttons[index].pressed = down;
  gp.buttons[index].value = down ? 1 : 0;
};
const check = (ok, message) => { if (!ok) throw new Error(message); };

let exposed = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { getGamepads: () => exposed },
});

const input = new PadInput();
const receiver = pad('Generic DInput Receiver', 4, '', [0, 0, -1, 0, 0, -1]);
const steam = pad('Steam Virtual Gamepad', 9);

// Array disperso y receiver con gatillos en -1: Steam estándar debe ganar el
// fallback incluso antes del primer gesto.
exposed = [null, null, receiver, null, steam];
input.poll(1 / 60);
check(input.connected, 'no detectó ningún control con Steam abierto');
check(input._idx === 9, `eligió receiver fantasma en vez de Steam (${input._idx})`);

press(steam, 0, true);
input.poll(1 / 60);
check(input.justPressed.has(0), 'A del pad virtual no produjo edge');
input.poll(1 / 60);
check(!input.justPressed.has(0), 'A sostenido produjo inputs duplicados');
press(steam, 0, false);
input.poll(1 / 60);

// Steam aparece después de iniciar con un pad físico. Un drift estático del
// dispositivo anterior no puede impedir que el virtual activo tome control.
const physical = pad('Xbox Controller', 3);
physical.axes[0] = 0.85;
exposed = [physical];
input.poll(1 / 60);
check(input._idx === 3 && input.moveX > 0.7, 'el pad físico inicial no respondió');
physical.axes[0] = 0;
input.poll(1 / 60);

const steamHot = pad('Steam Input Virtual Controller', 7);
physical.axes[2] = 0.42; // drift viejo que antes dejaba el índice pegado
steamHot.axes[1] = -0.92;
exposed = [physical, null, steamHot];
input.poll(1 / 60);
check(input._idx === 7, `hot-swap no adoptó Steam Input (${input._idx})`);
check(input.moveZ > 0.8, `stick virtual no llegó a gameplay (${input.moveZ})`);

// El mismo botón puede aparecer en físico+virtual. Solo el pad estándar de
// Steam manda y cada pulsación sigue generando un único edge.
press(physical, 1, true);
press(steamHot, 1, true);
input.poll(1 / 60);
check(input._idx === 7 && input.justPressed.has(1), 'botón duplicado no priorizó Steam');
input.poll(1 / 60);
check(!input.justPressed.has(1), 'botón duplicado se repitió al mantenerlo');

// Cerrar Steam desconecta el virtual: el físico restante se recupera sin
// reload y sin conservar sticks/botones del dispositivo desaparecido.
press(physical, 1, false);
physical.axes[2] = 0;
physical.axes[0] = -0.8;
exposed = [physical];
input.poll(1 / 60);
check(input._idx === 3 && input.moveX < -0.65, 'no recuperó el pad físico al cerrar Steam');

console.log('STEAM CONTROLLER OK · virtual prioritario · hot-swap · índices dispersos · sin fantasma/duplicados');
