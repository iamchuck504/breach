// Contrato de la calidad automática: el nivel de arranque sale del equipo y
// el controlador baja por escalones cuando los cuadros se sostienen bajos,
// sin reaccionar a tirones sueltos ni a la pestaña oculta.
import assert from 'node:assert/strict';
import { AutoQuality, initialQuality, AUTO_STEPS } from '../src/render/auto-quality.js';

const angle = (gpu) => `ANGLE (${gpu} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
const cases = [
  [{ gpu: angle('Intel, Intel(R) UHD Graphics 620') , cores: 8, memoryGb: 8 }, 'low'],
  [{ gpu: angle('Intel, Intel(R) HD Graphics 4000'), cores: 4, memoryGb: 8 }, 'low'],
  [{ gpu: angle('Intel, Intel(R) Iris(R) Xe Graphics'), cores: 8, memoryGb: 8 }, 'medium'],
  [{ gpu: angle('AMD, AMD Radeon(TM) Graphics'), cores: 12, memoryGb: 8 }, 'medium'],
  [{ gpu: angle('NVIDIA, NVIDIA GeForce GTX 1050 Ti'), cores: 8, memoryGb: 8 }, 'medium'],
  [{ gpu: angle('NVIDIA, NVIDIA GeForce RTX 3060'), cores: 12, memoryGb: 8 }, 'high'],
  [{ gpu: angle('NVIDIA, NVIDIA GeForce RTX 3060'), cores: 4, memoryGb: 8 }, 'medium'],
  [{ gpu: angle('NVIDIA, NVIDIA GeForce RTX 3060'), cores: 2, memoryGb: 4 }, 'low'],
  [{ gpu: angle('AMD, AMD Custom GPU 0405 (radeonsi, vangogh)'), cores: 8, memoryGb: 8 }, 'high'], // Steam Deck: lo afina el medidor
  [{ gpu: 'Apple M1', cores: 8, memoryGb: 8 }, 'medium'],
  [{ gpu: 'Apple M2 Pro', cores: 10, memoryGb: 8 }, 'high'],
  [{ gpu: 'Mali-G57', cores: 8, memoryGb: 4, coarse: true }, 'low'],
  [{ gpu: 'Adreno (TM) 740', cores: 8, memoryGb: 8, coarse: true }, 'medium'],
  [{ gpu: 'Google SwiftShader', cores: 8 }, 'off'],
  [{ gpu: '', cores: 0, memoryGb: 0 }, 'high'], // navegador que oculta todo: lo afina el medidor
];
for (const [info, want] of cases) assert.equal(initialQuality(info), want, `${info.gpu || '(sin nombre)'} → ${want}`);

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const run = (aq, fps, seconds) => { let changed = 0; for (let i = 0; i < fps * seconds; i++) if (aq.sample(1 / fps)) changed++; return changed; };

// a 60 c/s no baja nunca
let s = store(), aq = new AutoQuality({ start: 'high', storage: s });
assert.equal(run(aq, 60, 60), 0); assert.equal(aq.quality, 'high');
// a 30 c/s sostenidos baja un escalón cada ~11 s (asentar 5 + tres ventanas de 2)
assert.equal(run(aq, 30, 12), 1); assert.equal(aq.quality, 'medium');
assert.equal(run(aq, 30, 12), 1); assert.equal(aq.quality, 'low');
// y deja de bajar en cuanto los cuadros se recuperan
assert.equal(run(aq, 60, 30), 0); assert.equal(aq.quality, 'low');
// un bache corto (4 s) no cuenta
aq = new AutoQuality({ start: 'high' }); run(aq, 60, 10);
assert.equal(run(aq, 30, 4), 0); assert.equal(run(aq, 60, 10), 0); assert.equal(aq.quality, 'high');
// tirones de carga (>250 ms) y pestaña oculta se ignoran
aq = new AutoQuality({ start: 'high' }); run(aq, 60, 6);
for (let i = 0; i < 200; i++) { assert.equal(aq.sample(0.4), false); assert.equal(aq.sample(1 / 20, false), false); }
assert.equal(aq.quality, 'high');
// toca fondo sin pasarse: efectos fuera y resolución al 50 %
aq = new AutoQuality({ start: 'low' }); run(aq, 20, 200);
assert.equal(aq.quality, 'off'); assert.equal(aq.scale, 0.5); assert.equal(aq.floor, true);
// lo aprendido se recuerda una semana y solo si es más barato que el arranque
let t = 1e12; s = store(); aq = new AutoQuality({ start: 'high', storage: s, now: () => t }); run(aq, 30, 12);
assert.equal(new AutoQuality({ start: 'high', storage: s, now: () => t + 864e5 }).quality, 'medium');
assert.equal(new AutoQuality({ start: 'high', storage: s, now: () => t + 8 * 864e5 }).quality, 'high');
assert.equal(new AutoQuality({ start: 'low', storage: s, now: () => t }).quality, 'low');
// reiniciar olvida
aq = new AutoQuality({ start: 'high', storage: s, now: () => t }); aq.reset();
assert.equal(aq.quality, 'high'); assert.equal(s.getItem('breach.video.auto'), null);
assert.equal(AUTO_STEPS[0].quality, 'high');
console.log('CALIDAD AUTOMÁTICA OK:', cases.length, 'equipos y el controlador de cuadros');
