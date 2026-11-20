// Catálogo completo de Breach (lo comparten el hilo principal, el worker de
// render y scripts/check-audio-bank.mjs). Orden de render: armas primero.
import { Bank } from './bank.js';
import { addWeaponSounds } from './sfx-weapons.js';
import { addWorldSounds } from './sfx-world.js';

// Los MP3 del dueño (public/audio) son el cuerpo del disparo. Entran al pool
// de voces como defs `external`: mismo limitador, prioridades y topes.
export const SAMPLE_FILES = Object.freeze({
  smg: 'audio/smg.mp3', shotgun: 'audio/shotgun.mp3',
  sniper: 'audio/sniper.mp3', pistol: 'audio/pistol.mp3',
});

export function buildBank() {
  const b = new Bank();
  const G = { bus: 'combat', external: true, cat: 'sample', pitchVar: 0.03, dbVar: 0.6, steal: true, gap: 0 };
  // propio: prioridad máxima; ajeno: por debajo de pasos enemigos cercanos
  for (const w of Object.keys(SAMPLE_FILES)) {
    b.add(`gun_${w}`, { ...G, prio: 100, max: w === 'smg' ? 3 : 2, send: 0.07, group: `gun_${w}` });
    b.add(`gun_${w}_remote`, { ...G, prio: 75, max: w === 'smg' ? 5 : 3, send: 0.22, group: `gun_${w}_remote` });
  }
  addWeaponSounds(b);
  addWorldSounds(b);
  b.plan();
  return b;
}
