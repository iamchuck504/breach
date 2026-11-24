// Utilidades comunes de las suites (PRUEBAS, corrida 6).
// - freePort(): puerto libre del sistema. Ninguna suite fija un puerto: en
//   esta máquina hay procesos huérfanos en 8795/8797/8799/8817/8862/9095 y
//   dos suites con el mismo número chocaban entre sí.
// - waitGame()/waitFrames(): esperas en TIEMPO DE JUEGO (G.simClock) o en
//   cuadros dibujados, nunca en reloj de pared. El runner de CI no tiene GPU
//   y va ~13× más lento: la simulación hace como mucho 4 pasos de 1/30 por
//   cuadro, así que un segundo de reloj puede ser 0.1 s de juego.
import net from 'node:net';

// Consultar el Input vivo funciona tanto en Vite como en el dist empaquetado.
export async function actionKeys(page, ...actions) {
  return page.evaluate(names => Object.fromEntries(names.map(action => {
    const code = window.BREACH_INPUT.keyForAction(action);
    if (!code) throw new Error('Acción sin tecla asignada: ' + action);
    return [action, code];
  })), actions);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Espera a que un servidor HTTP responda (sondeo, no una espera fija).
export async function waitHttp(url, { tries = 600, every = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* arrancando */ }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`sin respuesta de ${url}`);
}

// Avanza `seconds` de tiempo de JUEGO en la página (BREACH.simClock).
// `timeout` es solo la red de seguridad de reloj real (no criterio de éxito).
export async function waitGame(page, seconds, { timeout = 600000 } = {}) {
  const t0 = await page.evaluate(() => window.BREACH?.simClock ?? 0);
  await page.waitForFunction((end) => (window.BREACH?.simClock ?? 0) >= end,
    t0 + seconds, { timeout, polling: 'raf' });
}

// Espera `n` cuadros dibujados (requestAnimationFrame).
export async function waitFrames(page, n = 1) {
  await page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);
}

// Hasta que `fn()` (en la página) sea verdadero, como mucho `seconds` de juego.
// Devuelve true/false (no lanza) para que la suite dé su propio mensaje.
export async function untilGame(page, fn, seconds, arg) {
  const deadline = await page.evaluate(s => window.BREACH.simClock + s, seconds);
  // Cada predicado se evalúa una sola vez por sondeo: algunos pulsan el
  // gatillo en el mismo cuadro. Un objeto también puede comunicar el false final.
  const poll = new Function('ctx', `
    if (window.BREACH.simClock > ctx.deadline) return { ok: false };
    return (${fn})(ctx.arg) ? { ok: true } : false;
  `);
  const result = await page.waitForFunction(poll, { arg, deadline }, { polling: 'raf', timeout: Math.min(300000, Math.max(30000, seconds * 20000)) });
  try { return (await result.jsonValue()).ok; }
  finally { await result.dispose(); }
}

// Base del dev server que levanta with-dev-server.mjs (puerto libre propio).
export const DEV_BASE = process.env.BASE || 'http://127.0.0.1:5200';

// Origen de tiro de un cliente FPS: el ojo EXACTO de la pose que el servidor
// tiene de ese jugador (st/yaw/posición del último estado `s` enviado).
// El servidor exige ≤0.02 m (server.js fpsOriginLegal); y+1.1 ya no vale.
import { eyeWorld } from '../src/combat/hit-pose.js';
export const eyeAt = (x, y, z, yaw = 0, st = 'idle') =>
  eyeWorld({ st, aim: 0, p: 0, ce: 1, cl: 0 }, x, y, z, yaw).map((v) => +v.toFixed(3));

// Salida de un proyectil humano FPS (cohete, humo, frag, aturdidora): la que el
// servidor reconstruye = ojo + desplazamiento del arma en el marco de la cámara
// (launchWorld de hit-pose.js, ±0.06 m). `pitch`/`st` deben ser los del último
// estado `s` enviado. Devuelve { o, d } (d = eje de la mira).
import { launchWorld } from '../src/combat/hit-pose.js';
export const launchAt = (x, y, z, yaw = 0, { pitch = 0, st = 'idle' } = {}) => {
  const L = launchWorld({ st, aim: 0, ce: 1, cl: 0, pitch, p: pitch }, x, y, z, yaw);
  return { o: L.launch.map((v) => +v.toFixed(3)), d: L.fwd.map((v) => +v.toFixed(4)) };
};
