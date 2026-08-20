import { AUDIO_PROFILES, spatialAudioMix } from '../src/fx/audio.js';

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

for (const [name, profile] of Object.entries(AUDIO_PROFILES)) {
  const distances = [0, profile.near, profile.near + 5,
    (profile.near + profile.far) * 0.5, profile.far * 0.9, profile.far];
  const mixes = distances.map((d) => spatialAudioMix(d, 0, false, name));
  for (let i = 1; i < mixes.length; i++) {
    check(mixes[i].gain <= mixes[i - 1].gain + 1e-9,
      `${name}: volumen aumentó con distancia (${distances[i - 1]} -> ${distances[i]})`);
    check(mixes[i].cutoff <= mixes[i - 1].cutoff + 1e-9,
      `${name}: recuperó agudos con distancia (${distances[i - 1]} -> ${distances[i]})`);
  }
  check(mixes[0].gain === 1, `${name}: fuente cercana no conserva ganancia plena`);
  check(mixes.at(-1).gain === 0, `${name}: fuente fuera de rango sigue audible`);
}

const gunNear = spatialAudioMix(3, 0, false, 'gunshot');
const gunMid = spatialAudioMix(24, 0, false, 'gunshot');
const gunFar = spatialAudioMix(58, 0, false, 'gunshot');
check(gunNear.gain > gunMid.gain && gunMid.gain > gunFar.gain,
  'disparo cercano/medio/lejano no tiene jerarquía clara');
check(gunFar.cutoff < gunMid.cutoff && gunMid.cutoff < gunNear.cutoff,
  'disparo lejano no pierde presencia/agudos');

for (const name of Object.keys(AUDIO_PROFILES)) {
  const open = spatialAudioMix(10, 0.4, false, name);
  const blocked = spatialAudioMix(10, 0.4, true, name);
  check(blocked.gain < open.gain && blocked.cutoff < open.cutoff,
    `${name}: la oclusión no reduce nivel y presencia`);
}

check(spatialAudioMix(4, 2, false, 'footstep').pan === 0.92,
  'paneo derecho no se limitó correctamente');
check(spatialAudioMix(4, -2, false, 'footstep').pan === -0.92,
  'paneo izquierdo no se limitó correctamente');

if (failures.length) {
  failures.forEach((failure) => console.error('AUDIO FALLO:', failure));
  process.exit(1);
}
console.log(`SPATIAL AUDIO OK · gun ${gunNear.gain.toFixed(2)} → ${gunMid.gain.toFixed(2)} → ${gunFar.gain.toFixed(2)} · distancia/altura/pan/oclusión`);
