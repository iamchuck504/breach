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

// --- Armado por stick: el drift no camina; un gesto real sí (run3/inicio).
{
  const fresh = () => new PadInput();
  const step = (inp, n = 1) => { for (let i = 0; i < n; i++) inp.poll(1 / 60); };
  // stick gastado en reposo a -0.42: ni solo ni tras pulsar botones del menú
  let p = fresh(); const worn = pad('Xbox Controller', 0, 'standard', [0.03, -0.42, 0, 0]);
  exposed = [worn]; step(p, 5);
  press(worn, 0, true); step(p); press(worn, 0, false); step(p, 3);
  check(p.moveZ === 0 && p.moveX === 0, `drift -0.42 caminó (${p.moveZ})`);
  // HID no estándar con eje clavado en -1
  p = fresh(); exposed = [pad('Generic USB HID', 0, '', [0, -1, 0, 0, 0, -1])]; step(p, 10);
  check(p.moveZ === 0, 'eje clavado de HID no estándar movió al jugador');
  // centro → inclinación deliberada
  p = fresh(); const a = pad('Xbox Controller', 0); exposed = [a]; step(p, 3);
  a.axes[1] = -0.3; step(p);
  check(p.moveZ > 0, 'inclinar desde el centro no armó el stick');
  // empuje sostenido SIN cambios grandes, con el temblor de un pulgar real
  // (±0.01): el jugador que ya empuja al empezar la partida se mueve
  p = fresh(); const b = pad('Xbox Controller', 0, 'standard', [0, -0.45, 0, 0]); exposed = [b];
  for (let i = 0; i < 30; i++) { b.axes[1] = -0.45 + Math.sin(i * 1.7) * 0.01; step(p); }
  check(p.moveZ > 0.2, `empuje sostenido de 0.45 con temblor no movió (${p.moveZ})`);
  // el mismo 0.45 perfectamente constante (eje atascado): no
  p = fresh(); const stuck = pad('Xbox Controller', 0, 'standard', [0, -0.45, 0, 0]); exposed = [stuck]; step(p, 60);
  check(p.moveZ === 0, 'un 0.45 constante (sin temblor) se tomó por gesto');
  // drift de 0.2 con ruido: por debajo del umbral de temblor, nunca
  p = fresh(); const d2 = pad('Xbox Controller', 0, 'standard', [0, 0.2, 0, 0]); exposed = [d2];
  for (let i = 0; i < 60; i++) { d2.axes[1] = 0.21 + Math.sin(i) * 0.008; step(p); }
  check(p.moveZ === 0, 'drift de 0.2 movió al jugador');
  // empuje claramente deliberado (≥ 0.5) al aparecer: al instante
  p = fresh(); exposed = [pad('Xbox Controller', 0, 'standard', [0, -0.62, 0, 0])]; step(p);
  check(p.moveZ > 0.4, 'empuje de 0.62 no armó al momento');
  // el teclado toma el control: un stick quieto en la banda ambigua se calla
  p = fresh(); const k = pad('Xbox Controller', 0); exposed = [k]; step(p, 2);
  k.axes[1] = -0.35; step(p);
  check(p.moveZ > 0, 'centro→0.35 no armó');
  p.disarm(); step(p, 30);
  check(p.moveZ === 0, 'disarm no detuvo un stick quieto en 0.35');
  k.axes[1] = 0; step(p); k.axes[1] = -0.35; step(p);
  check(p.moveZ > 0, 'el pad no volvió tras soltar y volver a inclinar');
  // los sticks son independientes: el derecho con drift no gira la cámara
  p = fresh(); const c2 = pad('Xbox Controller', 0, 'standard', [0, 0, 0.4, 0]); exposed = [c2]; step(p, 3);
  c2.axes[1] = -0.6; step(p);
  check(p.moveZ > 0 && p.camX === 0, 'el drift del stick derecho se armó con el izquierdo');
}

console.log('STEAM CONTROLLER OK · virtual prioritario · hot-swap · índices dispersos · sin fantasma/duplicados');
