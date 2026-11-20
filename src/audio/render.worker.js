// Render en segundo plano: construye el mismo catálogo y renderiza cada
// variante por prioridad (armas primero), transfiriendo cada buffer al hilo
// principal. El arranque nunca gasta tiempo de DSP en el hilo del juego.
import { buildBank } from './catalog.js';

self.onmessage = () => {
  const bank = buildBank();
  for (;;) {
    const job = bank.renderNext();
    if (!job) break;
    const ch = job.ch.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
    self.postMessage({ name: job.name, v: job.v, ch, ms: job.ms }, ch.map((c) => c.buffer));
  }
  self.postMessage({ done: true });
};
