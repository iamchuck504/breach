// Foley del soldado, feedback de combate, recogidas, pedestal, interfaz,
// stingers de ronda, cama del menú y las respuestas al impulso de cada mapa.
// Pasos, salto, aterrizaje, daño, latido, UI y stingers parten de los de
// Crashterra (src/audio/sfx-world.ts / sfx-weapons.ts) con los ajustes
// anotados (sin "traje" sci-fi: Breach son soldados).
import {
  ad, bp, clicks, curve, dcBlock, ed, fm, hp, len, loopify, lp, mixInto, modes, mono, noise,
  normalize, reverb, sat, SR, tone, trimTail, vocal, widen, win, withRoom,
} from './dsp.js';

const TAU = Math.PI * 2;
const M = (x, peak = 0.9) => trimTail(normalize([x], peak));
const W = (x, peak = 0.8, ms = 0.35) => trimTail(normalize(widen(x, ms), peak));

/* --------------------------------------------------------------- pasos */

// piedra de la fortaleza: el paso de roca de Crashterra
function stepStone(r) {
  const x = mono(0.14);
  tone(x, { dur: 0.04, f: 140 * r.vary(1, 0.1), amp: 0.5, env: (t) => ad(t, 0.001, 0.01) });
  noise(x, r, { dur: 0.04, type: 'bp', f: 1600 * r.vary(1, 0.15), q: 1.5, amp: 0.7, env: (t) => ed(t, 0.008) });
  clicks(x, r, 0.004, 0.04, 200, 3500, 1.5, 0.25, 0.0008, (u) => 1 - u);
  return M(x, 0.75);
}
// hormigón/asfalto: suela de goma, más grave y con arenilla
function stepConcrete(r) {
  const x = mono(0.16);
  tone(x, { dur: 0.05, f: curve([[0, 120 * r.vary(1, 0.1)], [1, 70]]), amp: 0.55, env: (t) => ad(t, 0.0015, 0.012) });
  noise(x, r, { dur: 0.06, type: 'bp', f: 1050 * r.vary(1, 0.15), q: 1.1, amp: 0.65, env: (t) => ad(t, 0.001, 0.011) });
  clicks(x, r, 0.006, 0.07, 240, 3000, 1.6, 0.2, 0.0007, (u) => 1 - u);
  return M(x, 0.75);
}
function stepMetal(r) {
  const x = mono(0.3);
  tone(x, { dur: 0.05, f: 110, amp: 0.5, env: (t) => ad(t, 0.001, 0.014) });
  const b = r.range(380, 460);
  modes(x, 0.001, [[b, 0.06, 0.25], [b * 2.7, 0.04, 0.15], [b * 5.9, 0.025, 0.08]], 1, r);
  noise(x, r, { dur: 0.02, type: 'hp', f: 2000, amp: 0.3, env: (t) => ed(t, 0.003) });
  return M(x, 0.75);
}
/** Arrastre lateral pegado al muro. */
function scuff(r) {
  const d = r.range(0.11, 0.15);
  const x = mono(d + 0.02);
  noise(x, r, { dur: d, type: 'bp', f: r.range(1300, 1900), q: 0.9, amp: 0.8, env: (t) => win(t / d, 0.25, 0.5) });
  clicks(x, r, 0, d, 160, 3200, 1.5, 0.18, 0.0007);
  return M(x, 0.7);
}
/** Traqueteo de equipo al correr agachado. */
function gear(r) {
  const x = mono(0.16);
  clicks(x, r, 0, 0.1, 140, 2600, 3, 0.4, 0.0015, (u) => 1 - u);
  modes(x, 0.01, [[r.range(1200, 1600), 0.02, 0.2], [r.range(2600, 3100), 0.012, 0.12]], 1, r);
  return M(x, 0.6);
}

/* --------------------------------------------------------- movimiento */

function jump(r) {
  const x = mono(0.3);
  noise(x, r, { dur: 0.15, type: 'bp', f: curve([[0, 700], [1, 1800]]), q: 0.9, amp: 0.4, env: (t) => win(t / 0.15, 0.3, 0.6) });
  noise(x, r, { dur: 0.05, type: 'lp', f: 1500, amp: 0.5, env: (t) => ad(t, 0.002, 0.01) });
  const br = mono(0.2);
  vocal(br, r, { dur: 0.18, f0: () => 140, amp: (u) => win(u, 0.15, 0.6), formants: [[650, 4, 1], [1200, 5, 0.6]], breath: 0.95 });
  mixInto(x, br, 0.02, 0.3);
  return M(x, 0.7);
}
function land(r, v) {
  const heavy = v >= 2;
  const x = mono(heavy ? 0.5 : 0.28);
  const k = r.vary(1, 0.14);
  tone(x, { dur: 0.25, f: curve([[0, (heavy ? 110 : 90) * k], [1, 40 * k]]), amp: 1, env: (t) => ad(t, 0.002, heavy ? 0.07 : 0.04) });
  noise(x, r, { dur: 0.12, type: 'lp', f: 1400, amp: 0.7, env: (t) => ad(t, 0.002, 0.025) });
  clicks(x, r, 0.005, 0.1, 260, 3000, 1.5, 0.3, 0.0008, (u) => 1 - u);
  if (heavy) {
    modes(x, 0.01, [[640, 0.05, 0.12], [1720, 0.03, 0.08]], 1, r);
    clicks(x, r, 0.03, 0.12, 80, 2400, 3, 0.25, 0.002);
  }
  sat(x, 1.5);
  return M(x, 0.9);
}
/** Deslizamiento a cobertura: tela + suelo rozando. */
function slideFoley(r) {
  const d = 0.48;
  const x = mono(d);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 1600], [1, 700]]), q: 0.8, amp: 0.7, env: (t) => win(t / d, 0.08, 0.55) });
  noise(x, r, { dur: d, type: 'lp', f: 420, amp: 0.6, env: (t) => win(t / d, 0.1, 0.5) });
  clicks(x, r, 0.02, d - 0.1, 120, 2600, 1.6, 0.22, 0.0008, (u) => 1 - u);
  return M(x, 0.8);
}
/** Espalda contra la cobertura: golpe sordo + equipo. */
function coverHit(r) {
  const x = mono(0.32);
  tone(x, { dur: 0.18, f: curve([[0, 105 * r.vary(1, 0.1)], [1, 48]]), amp: 1, env: (t) => ad(t, 0.0015, 0.04) });
  noise(x, r, { dur: 0.08, type: 'lp', f: 800, amp: 0.7, env: (t) => ad(t, 0.001, 0.018) });
  clicks(x, r, 0.01, 0.09, 110, 2500, 3, 0.3, 0.0015, (u) => 1 - u);
  sat(x, 1.5);
  return M(x, 0.9);
}
/** Evasión/rodada: aire + golpe de hombro + tela. */
function dive(r) {
  const d = 0.6;
  const x = mono(d);
  noise(x, r, { dur: 0.24, type: 'bp', f: curve([[0, 500], [0.5, 1700], [1, 700]]), q: 1, amp: 0.8, env: (t) => win(t / 0.24, 0.4, 0.5) });
  tone(x, { at: 0.22, dur: 0.15, f: curve([[0, 95], [1, 45]]), amp: 0.8, env: (t) => ad(t, 0.002, 0.04) });
  noise(x, r, { at: 0.22, dur: 0.3, type: 'bp', f: 1300, q: 0.8, amp: 0.4, env: (t) => win(t / 0.3, 0.05, 0.6) });
  clicks(x, r, 0.24, 0.14, 100, 2500, 3, 0.25, 0.0015, (u) => 1 - u);
  return M(x, 0.85);
}
/** Trepar: manos que golpean el borde, roce y esfuerzo. */
function mantle(r) {
  const x = mono(0.55);
  noise(x, r, { dur: 0.03, type: 'bp', f: 1500, q: 1, amp: 0.8, env: (t) => ed(t, 0.006) });
  tone(x, { dur: 0.06, f: 150, amp: 0.4, env: (t) => ad(t, 0.001, 0.015) });
  noise(x, r, { at: 0.08, dur: 0.22, type: 'bp', f: curve([[0, 700], [1, 1300]]), q: 1.2, amp: 0.45, env: (t) => win(t / 0.22, 0.2, 0.5) });
  const br = mono(0.3);
  vocal(br, r, { dur: 0.26, f0: () => 125, amp: (u) => win(u, 0.1, 0.6), formants: [[600, 4, 1], [1100, 5, 0.5]], breath: 0.9 });
  mixInto(x, br, 0.05, 0.35);
  return M(x, 0.8);
}
function whoosh(r) {
  const d = r.range(0.16, 0.22);
  const x = mono(d + 0.02);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 500], [0.5, 1800], [1, 700]]), q: 0.9, amp: 1, env: (t) => win(t / d, 0.45, 0.5) });
  return M(x, 0.75);
}

/* ------------------------------------------------- feedback de combate */

function hitTick(r) {
  const x = mono(0.06);
  tone(x, { dur: 0.05, f: 3600 * r.vary(1, 0.07), amp: 0.7, env: (t) => ad(t, 0.0004, 0.007) });
  noise(x, r, { dur: 0.004, type: 'hp', f: 5000, amp: 0.4, env: (t) => ed(t, 0.0006) });
  return [x];
}
// cabeza: más agudo y con un "tink" metálico corto: se distingue sin mirar
function hitHead(r) {
  const x = mono(0.16);
  tone(x, { dur: 0.05, f: 4800 * r.vary(1, 0.04), amp: 0.6, env: (t) => ad(t, 0.0004, 0.006) });
  modes(x, 0.002, [[2650 * r.vary(1, 0.03), 0.035, 0.4], [6900, 0.018, 0.15]], 1, r);
  noise(x, r, { dur: 0.004, type: 'hp', f: 6000, amp: 0.4, env: (t) => ed(t, 0.0006) });
  return M(x, 0.8);
}
function killConfirm(r, head) {
  const x = mono(head ? 0.6 : 0.42);
  tone(x, { dur: 0.08, f: 1250, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.001, 0.03) });
  tone(x, { at: 0.055, dur: 0.3, f: 1875, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.001, 0.07) });
  tone(x, { at: 0.055, dur: 0.3, f: 3750, amp: 0.15, env: (t) => ad(t, 0.001, 0.05) });
  tone(x, { dur: 0.06, f: curve([[0, 260], [1, 140]]), amp: 0.5, env: (t) => ad(t, 0.001, 0.02) });
  noise(x, r, { dur: 0.005, type: 'hp', f: 4000, amp: 0.2, env: (t) => ed(t, 0.001) });
  if (head) modes(x, 0.13, [[2812, 0.12, 0.35], [5625, 0.06, 0.12]], 1, r);
  lp(x, 7000);
  return W(x, 0.8, 0.3);
}
// daño recibido: el golpe al cuerpo de Crashterra sin la alarma del traje
function hurt(r) {
  const x = mono(0.3);
  const k = r.vary(1, 0.16);
  tone(x, { dur: 0.15, f: curve([[0, 130 * k], [1, 60 * k]]), amp: 1, env: (t) => ad(t, 0.001, 0.035) });
  noise(x, r, { dur: 0.1, type: 'bp', f: 900, q: 0.8, amp: 0.8, env: (t) => ad(t, 0.0008, 0.02) });
  clicks(x, r, 0, 0.04, 600, 2000, 1.5, 0.4, 0.001, (u) => 1 - u);
  sat(x, 2);
  return M(x, 0.9);
}
function heartbeat1(x, at, amp, k = 1) {
  tone(x, { at, dur: 0.2, f: curve([[0, 70 * k], [1, 42 * k]]), amp, env: (t) => ad(t, 0.006, 0.045) });
}
function heartbeat(r) {
  const x = mono(0.6);
  const k = r.vary(1, 0.1);
  heartbeat1(x, 0, 1, k);
  heartbeat1(x, r.range(0.24, 0.29), 0.7, k * 0.94);
  noise(x, r, { dur: 0.05, type: 'lp', f: 200, amp: 0.3, env: (t) => ed(t, 0.01) });
  lp(x, 300);
  return M(x, 0.9);
}
function death(r) {
  const d = 1.9;
  const x = mono(d);
  tone(x, { dur: 0.4, f: curve([[0, 140], [1, 40]]), amp: 1, env: (t) => ad(t, 0.001, 0.09) });
  noise(x, r, { dur: 0.2, type: 'bp', f: 700, q: 0.8, amp: 0.8, env: (t) => ed(t, 0.04) });
  // el mundo se apaga: un tono que cae + latidos finales
  tone(x, { at: 0.12, dur: 1.5, f: curve([[0, 420], [1, 55]]), wave: 'tri', amp: 0.18, env: (t) => win(t / 1.5, 0.05, 0.6) });
  for (const at of [0.7, 1.0, 1.5]) heartbeat1(x, at, 0.5);
  sat(x, 1.4);
  return trimTail(normalize(withRoom(x, 0.15, 1, 0.5, 1, 0.3), 0.9));
}
function respawn(r) {
  const d = 0.8;
  const x = mono(d);
  tone(x, { dur: d, f: curve([[0, 330], [1, 660]]), wave: 'tri', amp: 0.35, env: (t) => win(t / d, 0.25, 0.5) });
  fm(x, { dur: d, f: curve([[0, 990], [1, 1320]]), ratio: 1.5, index: () => 0.6, amp: (u) => 0.08 * win(u, 0.4, 0.5) });
  noise(x, r, { dur: d, type: 'hp', f: 5000, amp: 0.04, env: (t) => win(t / d, 0.5, 0.4) });
  return trimTail(normalize(withRoom(x, 0.2, 0.6, 0.4, 0.8, 0.2), 0.6));
}
function protEnd(r) {
  const x = mono(0.25);
  tone(x, { dur: 0.08, f: 1320, wave: 'tri', amp: 0.5, env: (t) => ad(t, 0.001, 0.03) });
  tone(x, { at: 0.07, dur: 0.14, f: 880, wave: 'tri', amp: 0.45, env: (t) => ad(t, 0.001, 0.045) });
  noise(x, r, { dur: 0.001, amp: 0 });
  return W(x, 0.6);
}

/* ------------------------------------------------------------ recogidas */

// caja de munición: el "resupply done" de Crashterra
function crate(r) {
  const x = mono(0.8);
  modes(x, 0, [[520, 0.06, 0.5], [1400, 0.04, 0.3], [2600, 0.025, 0.2]], 1, r);
  tone(x, { dur: 0.08, f: 110, amp: 0.7, env: (t) => ad(t, 0.001, 0.025) });
  noise(x, r, { at: 0.08, dur: 0.06, type: 'bp', f: 2000, q: 2, amp: 0.3, env: (t) => win(t / 0.06, 0.2, 0.5) });
  modes(x, 0.13, [[700, 0.05, 0.4], [1900, 0.03, 0.25]], 1, r);
  tone(x, { at: 0.2, dur: 0.12, f: 1320, wave: 'tri', amp: 0.35, env: (t) => ad(t, 0.002, 0.04) });
  tone(x, { at: 0.3, dur: 0.4, f: 1980, wave: 'tri', amp: 0.35, env: (t) => ad(t, 0.002, 0.09) });
  return trimTail(normalize(withRoom(x, 0.12, 0.5, 0.5, 0.8, 0.2), 0.85));
}
/** Balas sueltas de un arma caída: cargadores que chocan. */
function ammoPickup(r) {
  const x = mono(0.35);
  clicks(x, r, 0, 0.12, 160, 2900, 3, 0.45, 0.0015, (u) => 1 - u);
  modes(x, 0.05, [[r.range(1700, 2100), 0.03, 0.4], [r.range(3300, 3900), 0.02, 0.2]], 1, r);
  modes(x, 0.12, [[r.range(1400, 1700), 0.04, 0.35]], 1, r);
  tone(x, { at: 0.12, dur: 0.05, f: 180, amp: 0.4, env: (t) => ad(t, 0.001, 0.012) });
  return M(x, 0.8);
}
function weaponPickup(r) {
  const x = mono(0.5);
  noise(x, r, { dur: 0.16, type: 'bp', f: 1700, q: 0.7, amp: 0.35, env: (t) => win(t / 0.16, 0.3, 0.6) });
  modes(x, 0.14, [[560 * r.vary(1, 0.05), 0.05, 0.5], [1520, 0.03, 0.3], [2760, 0.02, 0.2]], 1, r);
  tone(x, { at: 0.14, dur: 0.1, f: 110, amp: 0.6, env: (t) => ad(t, 0.001, 0.025) });
  modes(x, 0.26, [[1180, 0.03, 0.35]], 1, r);
  return M(x, 0.85);
}
/** Arma especial tomada: golpe de pedestal + campanada ascendente. */
function specialTaken(r) {
  const x = mono(1.3);
  tone(x, { dur: 0.6, f: 110, amp: 0.4, env: (t) => ad(t, 0.005, 0.18) });
  modes(x, 0, [[620, 0.06, 0.4], [1660, 0.04, 0.25]], 1, r);
  [880, 1318.5, 1760].forEach((f, i) => modes(x, 0.08 + i * 0.1, [[f, 0.28, 0.35], [f * 2, 0.12, 0.1]], 1, r));
  return trimTail(normalize(withRoom(x, 0.35, 1.1, 0.4, 1.1, 0.5), 0.8));
}
/** Zumbido del pedestal: loop exacto (ciclos enteros sobre L). */
function pedestalHum(r) {
  const L = 2.4;
  const x = mono(L + 0.5);
  for (const [k, a] of [[264, 0.5], [396, 0.25], [528, 0.12], [1584, 0.05]]) {
    tone(x, { dur: L + 0.5, f: k / L, amp: a });
  }
  const sh = mono(L + 0.5);
  noise(sh, r, { dur: L + 0.5, type: 'bp', f: 3200, q: 4, amp: 0.15 });
  for (let i = 0; i < sh.length; i++) sh[i] *= 0.5 + 0.5 * Math.sin((TAU * 3 * i) / (SR * L));
  mixInto(x, sh, 0, 1);
  return [normalize([loopify(x, L, 0.4)], 0.7)[0]];
}
/** Carga del agarre: tono que sube con el progreso (el rate lo mueve). */
function pedestalHold(r) {
  const L = 1;
  const x = mono(L + 0.3);
  tone(x, { dur: L + 0.3, f: 440, wave: 'tri', amp: 0.4 });
  tone(x, { dur: L + 0.3, f: 662, amp: 0.2 });
  for (let i = 0; i < x.length; i++) x[i] *= 0.7 + 0.3 * Math.sin((TAU * 12 * i) / (SR * L));
  noise(x, r, { dur: L + 0.3, type: 'hp', f: 6000, amp: 0.03 });
  return [normalize([loopify(x, L, 0.3)], 0.6)[0]];
}
function pedestalSpawn(r) {
  const d = 1.3;
  const x = mono(d);
  tone(x, { dur: 0.5, f: curve([[0, 70], [1, 45]]), amp: 0.7, env: (t) => ad(t, 0.003, 0.14) });
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 1200], [1, 4800]]), q: 2.5, amp: 0.25, env: (t) => win(t / d, 0.5, 0.4) });
  modes(x, 0.55, [[1318.5, 0.3, 0.3], [1975.5, 0.2, 0.15]], 1, r);
  return trimTail(normalize(withRoom(x, 0.3, 1.2, 0.4, 1.1, 0.5), 0.75));
}

/* ------------------------------------------------- interfaz (Crashterra) */

function uiMove(r) {
  const x = mono(0.05);
  tone(x, { dur: 0.045, f: 1900 * r.vary(1, 0.01), wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.0005, 0.008) });
  return [x];
}
function uiConfirm() {
  const x = mono(0.25);
  tone(x, { dur: 0.06, f: 880, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.001, 0.025) });
  tone(x, { at: 0.055, dur: 0.18, f: 1320, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.001, 0.05) });
  return W(x, 0.7);
}
function uiBack() {
  const x = mono(0.22);
  tone(x, { dur: 0.06, f: 1100, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.001, 0.025) });
  tone(x, { at: 0.055, dur: 0.15, f: 740, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.001, 0.045) });
  return W(x, 0.7);
}
function lobbyEnter(r) {
  const x = mono(0.6);
  tone(x, { dur: 0.14, f: curve([[0, 220], [1, 330]]), wave: 'tri', amp: 0.5, env: (t) => ad(t, 0.003, 0.05) });
  tone(x, { at: 0.09, dur: 0.4, f: 660, wave: 'tri', amp: 0.4, env: (t) => ad(t, 0.002, 0.1) });
  modes(x, 0.09, [[1320, 0.15, 0.15]], 1, r);
  return trimTail(normalize(withRoom(x, 0.2, 0.8, 0.4, 0.9, 0.3), 0.7));
}
function playerJoined(r) {
  const x = mono(0.5);
  modes(x, 0, [[987.8, 0.12, 0.35], [1975.5, 0.06, 0.1]], 1, r);
  modes(x, 0.08, [[1318.5, 0.16, 0.35], [2637, 0.07, 0.1]], 1, r);
  return W(x, 0.65);
}

/* ------------------------------------------------------------- stingers */

function brassHit(x, at, freqs, d, amp) {
  const t = mono(d);
  for (const f of freqs) {
    tone(t, { dur: d, f, wave: 'saw', amp: 0.3, env: (tt) => ad(tt, 0.01, d * 0.35), vib: [5, 0.003] });
    tone(t, { dur: d, f: f * 1.004, wave: 'saw', amp: 0.2, env: (tt) => ad(tt, 0.015, d * 0.35) });
  }
  lp(t, curve([[0, 3500], [0.3, 900], [1, 400]]));
  mixInto(x, t, at, amp);
}
function countTick(r) {
  const x = mono(0.3);
  modes(x, 0, [[880, 0.05, 0.5], [1760, 0.03, 0.2]], 1, r);
  tone(x, { dur: 0.1, f: 110, amp: 0.5, env: (t) => ad(t, 0.002, 0.03) });
  return W(x, 0.7);
}
// "¡ya!": golpe de tambor + metales cortos (waveStart de Crashterra comprimido)
function countGo(r) {
  const d = 1.1;
  const x = mono(d);
  tone(x, { dur: 0.6, f: curve([[0, 95], [0.2, 52], [1, 40]]), amp: 1, env: (t) => ad(t, 0.003, 0.16) });
  noise(x, r, { dur: 0.12, type: 'lp', f: 1000, amp: 0.6, env: (t) => ed(t, 0.025) });
  brassHit(x, 0.01, [110, 164.8, 220], d * 0.8, 0.55);
  sat(x, 1.3);
  dcBlock(x);
  return trimTail(normalize(withRoom(x, 0.3, 1.3, 0.5, 1.1, 0.6), 0.9));
}
// fin de ronda neutro: dos campanas que bajan (ni victoria ni derrota)
function roundEnd(r) {
  const x = mono(1.4);
  modes(x, 0, [[659.25, 0.4, 0.3], [1318.5, 0.2, 0.1]], 1, r);
  modes(x, 0.16, [[493.9, 0.5, 0.3], [987.8, 0.25, 0.1]], 1, r);
  tone(x, { dur: 1.2, f: 123.5, wave: 'tri', amp: 0.12, env: (t) => win(t / 1.2, 0.1, 0.7) });
  return trimTail(normalize(withRoom(x, 0.35, 1.3, 0.4, 1.1, 0.6), 0.75));
}
function victory(r) {
  const d = 2;
  const x = mono(d);
  for (const f of [261.6, 329.6, 392, 523.25]) tone(x, { dur: d, f, wave: 'saw', amp: 0.15, env: (t) => win(t / d, 0.15, 0.6) });
  lp(x, curve([[0, 600], [0.4, 3500], [1, 1200]]));
  [1046.5, 1318.5, 1568].forEach((f, i) => modes(x, 0.2 + i * 0.1, [[f, 0.4, 0.15]], 1, r));
  return trimTail(normalize(withRoom(x, 0.35, 1.6, 0.4, 1.2, 0.6), 0.8));
}
function defeat(r) {
  const d = 2.2;
  const x = mono(d);
  for (const f of [110, 130.8, 164.8]) tone(x, { dur: d, f: curve([[0, f], [1, f * 0.84]]), wave: 'saw', amp: 0.18, env: (t) => win(t / d, 0.08, 0.6) });
  lp(x, curve([[0, 1400], [1, 300]]));
  tone(x, { dur: 1.5, f: 41, amp: 0.4, env: (t) => ad(t, 0.01, 0.5) });
  noise(x, r, { dur: 0.001, amp: 0 });
  return trimTail(normalize(withRoom(x, 0.3, 1.6, 0.5, 1.2, 0.6), 0.8));
}
function mvp(r) {
  const x = mono(1.4);
  [1318.5, 1760, 2637].forEach((f, i) => modes(x, i * 0.14, [[f, 0.25, 0.4], [f * 2.0, 0.12, 0.1]], 1, r));
  tone(x, { dur: 0.6, f: 110, amp: 0.3, env: (t) => ad(t, 0.01, 0.2) });
  return trimTail(normalize(withRoom(x, 0.4, 1.2, 0.4, 1.1, 0.5), 0.75));
}

/* ---------------------------------------------------------- cama del menú */

// Pad tranquilo en La menor con ciclos enteros sobre L: el loop cierra solo
// y el crossfade de loopify absorbe el arranque del filtro.
function menuBed(r) {
  const L = 9.6;
  const n = L + 1.2;
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const x = mono(n);
    const det = ch ? 1.0015 : 0.9985;
    for (const [hz, a] of [[110, 0.3], [130.8, 0.22], [164.8, 0.22], [220, 0.12], [329.6, 0.05]]) {
      const k = Math.round(hz * det * L);
      tone(x, { dur: n, f: k / L, wave: 'saw', amp: a });
    }
    // filtro que respira dos veces por loop
    lp(x, (u) => 420 + 260 * (0.5 - 0.5 * Math.cos(TAU * 2 * (u * n) / L)), 0.6);
    const air = mono(n);
    noise(air, r, { dur: n, type: 'bp', f: 2400, q: 0.6, amp: 0.05 });
    mixInto(x, air, 0, 1);
    out.push(loopify(x, L, 1.2));
  }
  return normalize(out, 0.5);
}

/* ------------------------------------- respuestas al impulso de los mapas */

// Un ConvolverNode por mapa en el bus world. Cada IR es la reverb Freeverb de
// Crashterra excitada por un impulso, más reflexiones tempranas propias del
// lugar: patio de piedra, azoteas abiertas con rebote lejano, calle cañón.
function impulse(r, rt, damp, size, early) {
  const x = mono(0.02);
  x[0] = 1;
  const ir = reverb(x, rt, damp, size, rt + 0.1);
  for (const [at, g, f] of early) {
    for (let ch = 0; ch < 2; ch++) {
      const e = mono(0.03);
      noise(e, r, { dur: 0.03, type: 'lp', f, amp: 1, env: (t) => ed(t, 0.004) });
      mixInto(ir[ch], e, at * (ch ? 1.07 : 1), g * (ch ? 0.85 : 1));
    }
  }
  for (const c of ir) {
    hp(c, 120);
    lp(c, 6500);
    for (let i = 0; i < Math.min(c.length, 32); i++) c[i] *= i / 32; // sin directo: el seco ya suena
  }
  return normalize(ir, 0.35);
}

export function addWorldSounds(b) {
  // pasos: bus world (sin compresor de combate, nunca duckeado). El facade
  // separa propio / aliado / enemigo con nivel, brillo y prioridad.
  const S = { bus: 'world', prio: 60, cat: 'step', order: 1, pitchVar: 0.06, dbVar: 1.5, max: 10, gap: 0, group: 'step', send: 0.05 };
  b.add('step_stone', { ...S, gen: stepStone, variants: 6, db: -12 });
  b.add('step_concrete', { ...S, gen: stepConcrete, variants: 6, db: -12 });
  b.add('step_metal', { ...S, gen: stepMetal, variants: 5, db: -15 });
  b.add('step_scuff', { ...S, gen: scuff, variants: 4, db: -18 });
  b.add('gear', { ...S, gen: gear, variants: 4, db: -22, group: 'gear', max: 3 });
  const P = { bus: 'world', prio: 80, cat: 'foley', order: 2, pitchVar: 0.05, dbVar: 1.5, max: 2, gap: 0.05 };
  b.add('jump', { ...P, gen: jump, variants: 3, db: -15 });
  b.add('land', { ...P, gen: land, variants: 4, db: -10 });
  b.add('slide', { ...P, gen: slideFoley, variants: 3, db: -14 });
  b.add('cover_hit', { ...P, gen: coverHit, variants: 3, db: -10 });
  b.add('dive', { ...P, gen: dive, variants: 3, db: -12 });
  b.add('mantle', { ...P, gen: mantle, variants: 2, db: -13 });
  b.add('whoosh', { ...P, gen: whoosh, variants: 3, db: -15 });
  // feedback: bus ui, máxima prioridad, nunca robado por el mundo
  const H = { bus: 'ui', prio: 96, cat: 'feedback', order: 1, pitchVar: 0.02, dbVar: 0.5, max: 2 };
  b.add('hit_tick', { ...H, gen: hitTick, variants: 3, db: -14, gap: 0.03 });
  b.add('hit_head', { ...H, gen: hitHead, variants: 2, db: -14, gap: 0.03 });
  b.add('kill_confirm', { ...H, gen: (r) => killConfirm(r, false), variants: 1, db: -9, gap: 0.05 });
  b.add('kill_head', { ...H, gen: (r) => killConfirm(r, true), variants: 1, db: -9, gap: 0.05 });
  b.add('hurt', { ...H, prio: 90, gen: hurt, variants: 4, db: -10, gap: 0.08, pitchVar: 0.05 });
  b.add('heartbeat', { ...H, prio: 85, gen: heartbeat, variants: 2, db: -10, max: 1, gap: 0.2 });
  b.add('death', { ...H, prio: 99, gen: death, variants: 1, db: -6, order: 3 });
  b.add('respawn', { ...H, gen: respawn, variants: 1, db: -17, order: 3 });
  b.add('prot_end', { ...H, gen: protEnd, variants: 1, db: -21, order: 3 });
  const R = { bus: 'ui', prio: 90, cat: 'pickup', order: 3, pitchVar: 0.02, dbVar: 0.5, max: 1 };
  b.add('crate', { ...R, gen: crate, variants: 1, db: -12 });
  b.add('ammo_pickup', { ...R, gen: ammoPickup, variants: 3, db: -12 });
  b.add('weapon_pickup', { ...R, gen: weaponPickup, variants: 2, db: -11 });
  b.add('special_taken', { ...R, gen: specialTaken, variants: 1, db: -11 });
  // el pedestal es un objeto del mundo: posicional y con cola de sala
  const PD = { bus: 'world', prio: 30, cat: 'pedestal', order: 4, pitchVar: 0, dbVar: 0, send: 0.2 };
  b.add('pedestal_hum', { ...PD, gen: pedestalHum, variants: 1, loop: true, db: -16 });
  b.add('pedestal_hold', { ...PD, bus: 'ui', gen: pedestalHold, variants: 1, loop: true, db: -20, send: 0 });
  b.add('pedestal_spawn', { ...PD, gen: pedestalSpawn, variants: 1, db: -10, max: 1 });
  const U = { bus: 'ui', prio: 95, cat: 'ui', order: 3, pitchVar: 0, dbVar: 0, max: 2, gap: 0.02 };
  b.add('ui_move', { ...U, gen: uiMove, variants: 1, db: -20 });
  b.add('ui_confirm', { ...U, gen: () => uiConfirm(), variants: 1, db: -20 });
  b.add('ui_back', { ...U, gen: () => uiBack(), variants: 1, db: -19 });
  b.add('lobby_enter', { ...U, gen: lobbyEnter, variants: 1, db: -16 });
  b.add('player_joined', { ...U, gen: playerJoined, variants: 1, db: -18 });
  const ST = { ...U, cat: 'stinger', order: 4, max: 1, variants: 1 };
  b.add('count_tick', { ...ST, gen: countTick, db: -15, max: 2 });
  b.add('count_go', { ...ST, gen: countGo, db: -14 });
  b.add('round_end', { ...ST, gen: roundEnd, db: -13 });
  b.add('match_win', { ...ST, gen: victory, db: -14 });
  b.add('match_lose', { ...ST, gen: defeat, db: -14 });
  b.add('mvp', { ...ST, gen: mvp, db: -13 });
  b.add('menu_bed', { bus: 'music', prio: 5, cat: 'music', order: 6, variants: 1, loop: true, db: -20, pitchVar: 0, dbVar: 0, gen: menuBed });
  // IRs: nunca se reproducen, se cargan en el ConvolverNode del mapa
  const IR = { bus: 'world', cat: 'ir', order: 3, variants: 1, pitchVar: 0, dbVar: 0 };
  b.add('ir_fortaleza', { ...IR, gen: (r) => impulse(r, 1.5, 0.35, 1.2, [[0.021, 0.5, 2400], [0.037, 0.35, 2000], [0.058, 0.25, 1600]]) });
  b.add('ir_azoteas', { ...IR, gen: (r) => impulse(r, 0.7, 0.55, 0.8, [[0.012, 0.3, 3000], [0.19, 0.28, 1200], [0.33, 0.12, 900]]) });
  b.add('ir_calle', { ...IR, gen: (r) => impulse(r, 1.1, 0.45, 1, [[0.016, 0.4, 2800], [0.045, 0.3, 2200], [0.09, 0.2, 1800], [0.135, 0.12, 1400]]) });
}

export const IR_OF_MAP = Object.freeze({ fortaleza: 'ir_fortaleza', azoteas: 'ir_azoteas', calle: 'ir_calle' });
