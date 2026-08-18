// Analiza la envolvente de los raw PCM (s16le 16kHz mono) del temp:
// onsets del uzi (cadencia interna) y arranque/cola de la escopeta.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SR = 16000, WIN = 0.005; // ventanas de 5ms

function envelope(file) {
  const raw = fs.readFileSync(file);
  const n = raw.length / 2;
  const win = Math.round(SR * WIN);
  const env = [];
  for (let i = 0; i + win <= n; i += win) {
    let acc = 0;
    for (let j = 0; j < win; j++) {
      const s = raw.readInt16LE((i + j) * 2) / 32768;
      acc += s * s;
    }
    env.push(Math.sqrt(acc / win));
  }
  return env;
}

function onsets(env, rise = 2.6, floor = 0.02) {
  const out = [];
  for (let i = 2; i < env.length; i++) {
    if (env[i] > floor && env[i] > env[i - 2] * rise) {
      if (!out.length || i - out[out.length - 1] > 8) out.push(i); // ≥40ms aparte
    }
  }
  return out.map((i) => +(i * WIN).toFixed(3));
}

for (const [name, file] of [['UZI', 'uzi.raw'], ['ESCOPETA', 'shot.raw']]) {
  const env = envelope(path.join(os.tmpdir(), file));
  const peak = Math.max(...env);
  const on = onsets(env);
  const gaps = on.slice(1).map((t, i) => +(t - on[i]).toFixed(3));
  // fin útil: última ventana sobre el 2% del pico
  let end = env.length - 1;
  while (end > 0 && env[end] < peak * 0.02) end--;
  console.log(name, JSON.stringify({
    peak: +peak.toFixed(3),
    onsets: on,
    gaps,
    endUtil: +(end * WIN).toFixed(3),
  }));
}
