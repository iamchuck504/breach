// Diseños de armas, recargas, proyectiles, balas e impactos de Breach.
// Los samples MP3 del dueño siguen siendo el cuerpo del disparo (defs
// `external` en catalog.js); aquí viven las capas alrededor: mecánica cercana,
// pegada grave, versión lejana, secuencias de recarga y todo lo que antes era
// un pitido placeholder. Helpers y varios diseños (clank/slide/thunk, bomba,
// cartucho, cambio de arma, seco, patada, impactos, ticks) son los de
// Crashterra (src/audio/sfx-weapons.ts), copiados tal cual o con el mínimo
// ajuste anotado. Todo es mono: el paneo lo pone la mezcla espacial.
import {
  ad, bp, clicks, curve, dcBlock, ed, hp, loopify, lp, mixInto, modes, mono, noise,
  normalize, sat, SR, tone, trimTail, win,
} from './dsp.js';

const TAU = Math.PI * 2;
const M = (x, peak = 0.9) => trimTail(normalize([x], peak));

/* ------------------------------------------------- helpers (Crashterra) */

/** "Clank" metálico corto con tick de excitación. */
function clank(out, r, at, base, amp, tau = 0.05) {
  const k = r.vary(1, 0.05);
  modes(out, at, [
    [base * k, tau, 0.5],
    [base * 2.71 * k, tau * 0.7, 0.32],
    [base * 4.93 * k, tau * 0.45, 0.2],
    [base * 7.6 * k, tau * 0.3, 0.12],
  ], amp, r);
  noise(out, r, { at, dur: 0.012, type: 'hp', f: 2500, amp: amp * 0.6, env: (t) => ed(t, 0.0018) });
}

/** Fricción metal contra metal (cargador en su guía, cerrojo). */
function slide(out, r, at, dur, f0, f1, amp) {
  const x = mono(dur);
  noise(x, r, { dur, amp: 1 });
  bp(x, curve([[0, f0], [1, f1]]), 2.2);
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    m += (r.n() - m) * 0.02;
    x[i] *= win(i / x.length, 0.15, 0.3) * (0.6 + Math.abs(m) * 3);
  }
  mixInto(out, x, at, amp);
}

/** Golpe grave seco (asentar un pestillo). */
function thunk(out, r, at, f, amp, tau = 0.03) {
  tone(out, { at, dur: tau * 6, f: curve([[0, f * 1.6], [0.2, f], [1, f * 0.8]]), env: (t) => ad(t, 0.001, tau), amp });
  noise(out, r, { at, dur: tau * 3, type: 'lp', f: f * 6, amp: amp * 0.5, env: (t) => ed(t, tau * 0.4) });
}

/* ------------------------------------------ capas del disparo propio */

// Mecánica del cerrojo: lo que el sample (grabado "de lejos") no trae y da
// la sensación de tener el arma en las manos.
function mechSmg(r) {
  const x = mono(0.11);
  clank(x, r, 0.003, r.range(1750, 2050), 0.5, 0.014);
  thunk(x, r, 0.002, 190, 0.35, 0.01);
  clicks(x, r, 0.018, 0.05, 260, 3400, 2, 0.25, 0.0008, (u) => 1 - u);
  return M(x, 0.8);
}
function mechPistol(r) {
  const x = mono(0.13);
  slide(x, r, 0, 0.022, 2600, 3400, 0.45);
  clank(x, r, 0.014, r.range(2150, 2450), 0.6, 0.02);
  thunk(x, r, 0.014, 230, 0.35, 0.012);
  return M(x, 0.8);
}
/** Bombeo de la escopeta (Crashterra reaperPump, mono). */
function pump(r) {
  const x = mono(0.5);
  slide(x, r, 0, 0.06, 1800, 2600, 0.45);
  clank(x, r, 0.05, 1150, 0.55, 0.03);
  thunk(x, r, 0.05, 140, 0.5, 0.02);
  slide(x, r, 0.15, 0.05, 2400, 1700, 0.45);
  clank(x, r, 0.195, 880, 0.85, 0.05);
  thunk(x, r, 0.195, 110, 0.9, 0.03);
  return M(x, 0.95);
}
/** Pegada grave bajo el sample: peso en el pecho sin tocar su timbre. */
function punch(r, heavy) {
  const d = heavy ? 0.26 : 0.14;
  const x = mono(d);
  const k = r.vary(1, 0.14);
  tone(x, { dur: d, f: curve([[0, (heavy ? 120 : 150) * k], [0.12, (heavy ? 58 : 75) * k], [1, (heavy ? 36 : 48) * k]]),
    env: (t) => ad(t, 0.0015, heavy ? 0.055 : 0.03), amp: 1 });
  sat(x, heavy ? 2.2 : 1.7);
  noise(x, r, { dur: 0.03, type: 'lp', f: 900, amp: 0.35, env: (t) => ed(t, 0.006) });
  lp(x, 900);
  dcBlock(x);
  return M(x, 0.9);
}

/* -------------------------------------------- disparo ajeno a distancia */

// Un disparo lejano no es el cercano filtrado: pierde el crack, conserva un
// "pop" grave y rebota en fachadas. Se cruza con el sample según distancia.
function distant(r, heavy) {
  const d = heavy ? 1.5 : 1.05;
  const x = mono(d);
  const pop = mono(0.25);
  noise(pop, r, { dur: 0.25, color: 'pink', amp: 1, env: (t) => ad(t, 0.0015, heavy ? 0.05 : 0.03) });
  lp(pop, heavy ? 700 : 1100);
  tone(pop, { dur: 0.2, f: curve([[0, heavy ? 90 : 120], [1, heavy ? 45 : 60]]), amp: heavy ? 0.8 : 0.5, env: (t) => ad(t, 0.002, heavy ? 0.06 : 0.035) });
  mixInto(x, pop, 0, 1);
  // rebotes: copias cada vez más oscuras y espaciadas de forma irregular
  let at = r.range(0.09, 0.15);
  let a = 0.42;
  for (let i = 0; i < (heavy ? 6 : 4) && at < d - 0.2; i++) {
    const e = pop.slice();
    lp(e, (heavy ? 600 : 900) / (1 + i * 0.45));
    mixInto(x, e, at, a);
    at += r.range(0.08, 0.2) * (1 + i * 0.25);
    a *= r.range(0.55, 0.7);
  }
  dcBlock(x);
  return M(x, 0.9);
}

/* ------------------------------------------------------------ bazooka */

function bazookaFire(r) {
  const d = 0.8;
  const x = mono(d);
  // golpe de la carga propulsora dentro del tubo
  thunk(x, r, 0, 72 * r.vary(1, 0.05), 1, 0.06);
  noise(x, r, { dur: 0.12, type: 'lp', f: 1200, amp: 0.8, env: (t) => ad(t, 0.001, 0.025) });
  modes(x, 0.002, [[210 * r.vary(1, 0.04), 0.09, 0.3], [540, 0.05, 0.12]], 1, r);
  // chorro saliendo: barrido de ruido hacia arriba
  noise(x, r, { at: 0.03, dur: 0.6, type: 'bp', f: curve([[0, 700], [1, 2800]]), q: 0.8, amp: 0.6, env: (t) => win(t / 0.6, 0.08, 0.7) });
  sat(x, 1.6);
  dcBlock(x);
  return M(x, 0.95);
}

/** Motor del cohete en vuelo: rugido con chisporroteo, loop exacto. */
function rocketLoop(r) {
  const L = 1.2;
  const x = mono(L + 0.3);
  noise(x, r, { dur: L + 0.3, color: 'brown', amp: 1 });
  bp(x, 950, 0.7);
  const hiss = mono(L + 0.3);
  noise(hiss, r, { dur: L + 0.3, type: 'hp', f: 3500, amp: 0.25 });
  mixInto(x, hiss, 0, 1);
  clicks(x, r, 0, L + 0.3, 70, 2400, 2, 0.2, 0.001);
  // aleteo de llama: AM con ciclos enteros sobre el loop
  for (let i = 0; i < x.length; i++) x[i] *= 0.8 + 0.2 * Math.sin((TAU * 23 * i) / (SR * L));
  return [normalize([loopify(x, L, 0.3)], 0.8)[0]];
}

/* --------------------------------------------------------- explosiones */

function boom(r, far) {
  const d = far ? 2.4 : 1.9;
  const x = mono(d);
  if (!far) {
    noise(x, r, { dur: 0.012, amp: 1, env: (t) => ed(t, 0.002) });
    noise(x, r, { dur: 0.05, type: 'hp', f: 1500, amp: 0.6, env: (t) => ad(t, 0.0005, 0.01) });
  }
  const sub = mono(1.2);
  tone(sub, { dur: 1.2, f: curve([[0, far ? 60 : 85], [0.1, 42], [1, 26]]), amp: 1, env: (t) => ad(t, 0.003, far ? 0.35 : 0.25) });
  sat(sub, 2.6);
  mixInto(x, sub, far ? 0.01 : 0, 0.95);
  const body = mono(d);
  noise(body, r, { dur: d, color: 'brown', amp: 1.6, env: (t) => ad(t, 0.004, far ? 0.5 : 0.32) });
  lp(body, curve([[0, far ? 500 : 1800], [1, 140]]));
  mixInto(x, body, 0, 0.9);
  // escombros que caen
  if (!far) clicks(x, r, 0.08, 1, 55, 2600, 1.4, 0.3, 0.0012, (u) => (1 - u) * (1 - u));
  dcBlock(x);
  return M(x, 0.97);
}
/** Capa extra del impacto directo en un cuerpo: crack seco medio-agudo. */
function boomDirect(r) {
  const x = mono(0.3);
  noise(x, r, { dur: 0.12, type: 'bp', f: r.range(1700, 2300), q: 1.1, amp: 1, env: (t) => ad(t, 0.0005, 0.02) });
  clicks(x, r, 0, 0.08, 900, 2200, 1.2, 0.8, 0.001, (u) => 1 - u);
  thunk(x, r, 0, 150, 0.6, 0.02);
  sat(x, 2);
  return M(x, 0.9);
}

/* ----------------------------------------------------------- lanzables */

/** Lanzamiento: el whoosh de la patada de Crashterra, más corto y ligero. */
function throwWhoosh(r) {
  const d = 0.22;
  const x = mono(d);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 600], [0.5, 2200], [1, 900]]), q: 1.1, amp: 1, env: (t) => win(t / d, 0.45, 0.5) });
  return M(x, 0.8);
}
function nadeBounce(r) {
  const x = mono(0.22);
  const f = r.range(1300, 2100);
  modes(x, 0.001, [[f, 0.03, 0.5], [f * 2.31, 0.02, 0.3], [f * 3.9, 0.012, 0.2]], 1, r);
  noise(x, r, { dur: 0.01, type: 'hp', f: 2500, amp: 0.5, env: (t) => ed(t, 0.0015) });
  thunk(x, r, 0, 260, 0.25, 0.01);
  return M(x, 0.85);
}
function smokeHiss(r) {
  const d = 1.6;
  const x = mono(d);
  noise(x, r, { dur: 0.02, type: 'lp', f: 900, amp: 0.8, env: (t) => ed(t, 0.004) });
  thunk(x, r, 0, 180, 0.5, 0.02);
  noise(x, r, { at: 0.02, dur: d - 0.02, type: 'bp', f: curve([[0, 2200], [0.3, 3400], [1, 2600]]), q: 0.6, amp: 0.6,
    env: (t) => win(t / (d - 0.02), 0.04, 0.6) });
  return M(x, 0.8);
}
function stunZap(r) {
  const d = 0.38;
  const x = mono(d);
  tone(x, { dur: d, f: curve([[0, 1300 * r.vary(1, 0.06)], [0.3, 420], [1, 130]]), wave: 'saw', amp: 0.7, env: (t) => ad(t, 0.001, 0.07) });
  const rm = r.range(900, 1400);
  for (let i = 0; i < x.length; i++) x[i] *= 0.55 + 0.45 * Math.sin((TAU * rm * i) / SR);
  clicks(x, r, 0, 0.3, 380, 3800, 1.3, 0.5, 0.0008, (u) => 1 - u);
  bp(x, 1800, 0.6);
  return M(x, 0.85);
}
function fuseTick(r) {
  const x = mono(0.06);
  tone(x, { dur: 0.05, f: 1550 * r.vary(1, 0.03), wave: 'square', amp: 0.4, env: (t) => ad(t, 0.0005, 0.01) });
  modes(x, 0, [[3200, 0.008, 0.3]], 1, r);
  return M(x, 0.7);
}

/* --------------------------------------------------------------- balas */

/** Silbido subsónico de una bala que pasa cerca (pistola/subfusil/perdigón). */
function whiz(r) {
  const d = r.range(0.16, 0.24);
  const x = mono(d + 0.02);
  const f0 = r.range(2600, 3400);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, f0], [1, f0 * 0.38]]), q: 3.2, amp: 1, env: (t) => win(t / d, 0.45, 0.5) });
  tone(x, { dur: d, f: curve([[0, f0 * 0.62], [1, f0 * 0.25]]), amp: 0.18, env: (t) => win(t / d, 0.5, 0.45) });
  return M(x, 0.85);
}
/** Chasquido supersónico (francotirador): onda N casi instantánea. */
function crack(r) {
  const x = mono(0.12);
  noise(x, r, { dur: 0.003, type: 'hp', f: 2500, amp: 1, env: (t) => ed(t, 0.0006) });
  noise(x, r, { dur: 0.03, type: 'bp', f: r.range(2800, 3600), q: 1.5, amp: 0.6, env: (t) => ed(t, 0.004) });
  noise(x, r, { at: 0.012, dur: 0.09, type: 'lp', f: 1800, amp: 0.15, env: (t) => ed(t, 0.025) });
  return M(x, 0.95);
}

/* ---------------------------------------------------- impactos (Crashterra) */

function impStone(r) {
  const x = mono(0.3);
  noise(x, r, { dur: 0.012, type: 'hp', f: 1100, amp: 1, env: (t) => ed(t, 0.0018) });
  noise(x, r, { dur: 0.08, type: 'bp', f: r.range(1500, 2200), q: 1.5, amp: 0.7, env: (t) => ed(t, 0.012) });
  clicks(x, r, 0.01, 0.13, 260, 3200, 1.5, 0.35, 0.0008, (u) => 1 - u);
  tone(x, { dur: 0.04, f: 190 * r.vary(1, 0.1), amp: 0.4, env: (t) => ad(t, 0.0008, 0.01) });
  return M(x, 0.85);
}
// hormigón: entre la roca y la tierra de Crashterra (polvo más grave)
function impConcrete(r) {
  const x = mono(0.3);
  noise(x, r, { dur: 0.01, type: 'hp', f: 900, amp: 0.9, env: (t) => ed(t, 0.0016) });
  noise(x, r, { dur: 0.09, type: 'bp', f: r.range(1000, 1500), q: 1.2, amp: 0.7, env: (t) => ed(t, 0.014) });
  noise(x, r, { dur: 0.1, type: 'lp', f: 600, amp: 0.5, env: (t) => ad(t, 0.001, 0.02) });
  clicks(x, r, 0.02, 0.14, 160, 2800, 2, 0.22, 0.001, (u) => 1 - u);
  return M(x, 0.85);
}
function impMetal(r) {
  const x = mono(0.6);
  noise(x, r, { dur: 0.008, type: 'hp', f: 2000, amp: 0.8, env: (t) => ed(t, 0.0012) });
  const base = r.range(480, 700);
  const ratios = [1, 1.59, 2.32, 3.14, 4.41, 5.8];
  modes(x, 0.0005, ratios.map((q, i) => [base * q * r.vary(1, 0.02), r.range(0.08, 0.2) / (1 + i * 0.25), 0.4 / (1 + i * 0.4)]), 1, r);
  return M(x, 0.85);
}
function impGlass(r) {
  const x = mono(0.45);
  noise(x, r, { dur: 0.006, type: 'hp', f: 4000, amp: 0.9, env: (t) => ed(t, 0.001) });
  for (let i = 0; i < 7; i++) {
    const f = r.range(2800, 7500);
    modes(x, r.range(0.002, 0.12) * (i / 7), [[f, r.range(0.02, 0.06), 0.3], [f * 1.71, 0.015, 0.15]], 1, r);
  }
  clicks(x, r, 0.02, 0.3, 90, 5200, 3, 0.25, 0.0006, (u) => (1 - u) * (1 - u));
  return M(x, 0.8);
}

/* ------------------------------------------------------------- recargas */

function magOut(r, light) {
  const x = mono(0.3);
  clank(x, r, 0, light ? 2600 : 1900, 0.45, 0.015);
  slide(x, r, 0.02, light ? 0.06 : 0.09, light ? 2200 : 1500, light ? 1400 : 900, 0.5);
  return M(x, 0.8);
}
function magIn(r, light) {
  const x = mono(0.3);
  slide(x, r, 0, light ? 0.04 : 0.06, light ? 1300 : 900, light ? 2100 : 1500, 0.4);
  clank(x, r, light ? 0.04 : 0.06, light ? 1700 : 1150, 0.8, light ? 0.025 : 0.035);
  thunk(x, r, light ? 0.04 : 0.06, light ? 190 : 140, 0.7, 0.02);
  return M(x, 0.9);
}
/** Manija de carga (subfusil) o corredera soltada (pistola). */
function rack(r, light) {
  const x = mono(0.35);
  if (!light) {
    slide(x, r, 0, 0.07, 1700, 2500, 0.45);
    clank(x, r, 0.07, 1300, 0.5, 0.025);
  }
  const at = light ? 0 : 0.14;
  slide(x, r, at, 0.03, 2500, 1800, 0.3);
  clank(x, r, at + 0.025, light ? 1500 : 980, 0.9, 0.04);
  thunk(x, r, at + 0.025, light ? 170 : 120, 0.75, 0.025);
  return M(x, 0.92);
}
/** Cartucho entrando (Crashterra reaperShell, mono). */
function shellIn(r) {
  const x = mono(0.25);
  slide(x, r, 0, 0.035, 2200, 3000, 0.3);
  modes(x, 0.03, [[3300 * r.vary(1, 0.05), 0.01, 0.4], [5100, 0.006, 0.25]], 1, r);
  noise(x, r, { at: 0.03, dur: 0.04, type: 'bp', f: 900, q: 3, amp: 0.5, env: (t) => ed(t, 0.007) });
  thunk(x, r, 0.032, 200, 0.35, 0.012);
  return M(x, 0.8);
}
function boltOpen(r) {
  const x = mono(0.3);
  clank(x, r, 0, 1500, 0.5, 0.02);
  slide(x, r, 0.04, 0.09, 1400, 2300, 0.55);
  return M(x, 0.85);
}
function roundIn(r) {
  const x = mono(0.2);
  modes(x, 0.01, [[2900 * r.vary(1, 0.04), 0.012, 0.4], [4400, 0.008, 0.2]], 1, r);
  thunk(x, r, 0.012, 230, 0.4, 0.012);
  slide(x, r, 0.03, 0.04, 2000, 2600, 0.2);
  return M(x, 0.75);
}
function boltClose(r) {
  const x = mono(0.35);
  slide(x, r, 0, 0.08, 2300, 1400, 0.5);
  clank(x, r, 0.08, 1050, 0.9, 0.04);
  thunk(x, r, 0.08, 120, 0.8, 0.025);
  clank(x, r, 0.19, 1400, 0.45, 0.02);
  return M(x, 0.92);
}
function tubeSlide(r) {
  const x = mono(0.55);
  slide(x, r, 0, 0.35, 500, 900, 0.7);
  noise(x, r, { dur: 0.35, type: 'lp', f: 400, amp: 0.3, env: (t) => win(t / 0.35, 0.2, 0.4) });
  return M(x, 0.8);
}
function tubeLock(r) {
  const x = mono(0.4);
  clank(x, r, 0, 640, 0.9, 0.06);
  thunk(x, r, 0, 90, 1, 0.04);
  clank(x, r, 0.12, 1250, 0.4, 0.02);
  return M(x, 0.95);
}
/** Recarga del aturdidor: condensador que sube (Crashterra vesperCharge alargado). */
function stunCharge(r) {
  const d = 1.1;
  const x = mono(d);
  tone(x, { dur: d, f: curve([[0, 500], [1, 2900]]), wave: 'tri', amp: 0.45, env: (t) => win(t / d, 0.2, 0.08) });
  tone(x, { dur: d, f: curve([[0, 1000], [1, 4400]]), amp: 0.15, env: (t) => win(t / d, 0.4, 0.08) });
  noise(x, r, { dur: d, type: 'hp', f: 6000, amp: 0.05, env: (t) => t / d });
  return M(x, 0.7);
}
function readyChirp(r) {
  const x = mono(0.25);
  tone(x, { dur: 0.05, f: 1500, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.002, 0.018) });
  tone(x, { at: 0.05, dur: 0.15, f: 2250, wave: 'tri', amp: 0.6, env: (t) => ad(t, 0.002, 0.04) });
  lp(x, 6000);
  return M(x, 0.7);
}

/* ------------------------------------------------- manejo (Crashterra) */

function switchHeavy(r) {
  const x = mono(0.55);
  noise(x, r, { dur: 0.2, type: 'bp', f: 1800, q: 0.7, amp: 0.35, env: (t) => win(t / 0.2, 0.3, 0.6) });
  clicks(x, r, 0.05, 0.12, 120, 2600, 3, 0.4, 0.002);
  clank(x, r, 0.28, 520 * r.vary(1, 0.06), 0.6, 0.05);
  thunk(x, r, 0.28, 100, 0.6, 0.03);
  slide(x, r, 0.2, 0.08, 1500, 2300, 0.25);
  return M(x, 0.85);
}
function switchLight(r) {
  const x = mono(0.28);
  noise(x, r, { dur: 0.09, type: 'bp', f: curve([[0, 1200], [1, 3200]]), q: 0.9, amp: 0.4, env: (t) => win(t / 0.09, 0.4, 0.5) });
  clank(x, r, 0.08, 980 * r.vary(1, 0.06), 0.5, 0.025);
  thunk(x, r, 0.08, 160, 0.35, 0.015);
  return M(x, 0.8);
}
// gatillo en seco: el de Crashterra sin el zumbido eléctrico "sin carga"
function dryClick(r) {
  const x = mono(0.12);
  modes(x, 0, [[3900 * r.vary(1, 0.05), 0.008, 0.5], [6100, 0.005, 0.3], [1500, 0.012, 0.25]], 1, r);
  noise(x, r, { dur: 0.004, type: 'hp', f: 3000, amp: 0.5, env: (t) => ed(t, 0.0008) });
  return M(x, 0.7);
}

/* ------------------------------------------------- cuerpo a cuerpo (Crashterra) */

function meleeSwing(r) {
  const d = 0.26;
  const x = mono(d);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 450], [0.45, 1900], [1, 600]]), q: 1.1, amp: 1, env: (t) => win(t / d, 0.45, 0.5) });
  const flap = mono(d);
  noise(flap, r, { dur: d, type: 'lp', f: 900, amp: 1 });
  for (let i = 0; i < flap.length; i++) flap[i] *= (0.5 + 0.5 * Math.sin((TAU * 34 * i) / SR)) * win(i / flap.length, 0.3, 0.4);
  mixInto(x, flap, 0, 0.4);
  return M(x, 0.85);
}
function meleeHit(r, v) {
  const d = 0.6;
  const x = mono(d);
  const thud = mono(0.4);
  const kk = r.vary(1, 0.1) * (1 + (v - 1) * 0.07);
  tone(thud, { dur: 0.4, f: curve([[0, 160 * kk], [0.1, 70 * kk], [1, 42 * kk]]), amp: 1, env: (t) => ad(t, 0.0015, r.range(0.06, 0.1)) });
  noise(thud, r, { dur: 0.1, type: 'lp', f: 600, amp: 0.8, env: (t) => ed(t, 0.02) });
  sat(thud, 2.5);
  mixInto(x, thud, 0, 1);
  // contacto de equipo/armadura (en Crashterra era quitina)
  const cr = mono(0.12);
  clicks(cr, r, 0, 0.05, 700, 1900, 1.2, 1, 0.001, (u) => 1 - u);
  noise(cr, r, { dur: 0.08, type: 'bp', f: 1100, q: 1, amp: 0.6, env: (t) => ed(t, 0.014) });
  sat(cr, 2);
  mixInto(x, cr, 0.002, 0.4);
  tone(x, { at: r.range(0.008, 0.03), dur: 0.5, f: curve([[0, 62 / kk], [1, 26 / kk]]), amp: 0.6 + v * 0.05, env: (t) => ad(t, 0.01, 0.16) });
  dcBlock(x);
  return M(x, 0.97);
}

/* --------------------------------------------------------------- export */

export function addWeaponSounds(b) {
  // capas del arma propia: frontales, alta prioridad, envío corto a la sala
  const L = { bus: 'combat', prio: 100, cat: 'weapon', order: 0, pitchVar: 0.03, dbVar: 1, max: 3, gap: 0, send: 0.06 };
  b.add('mech_smg', { ...L, gen: mechSmg, variants: 4, roundRobin: true, db: -11 });
  b.add('mech_pistol', { ...L, gen: mechPistol, variants: 3, db: -10 });
  b.add('punch_light', { ...L, gen: (r) => punch(r, false), variants: 3, db: -14 });
  b.add('punch_heavy', { ...L, gen: (r) => punch(r, true), variants: 3, db: -11 });
  b.add('bazooka_fire', { ...L, gen: bazookaFire, variants: 3, db: -4, max: 2, send: 0.18 });
  // ajeno a distancia: nunca roba a los cercanos
  const D = { bus: 'combat', prio: 62, cat: 'distant', order: 1, pitchVar: 0.05, dbVar: 1.5, max: 4, gap: 0.03, send: 0.2 };
  b.add('dist_light', { ...D, gen: (r) => distant(r, false), variants: 4, db: -6 });
  b.add('dist_heavy', { ...D, gen: (r) => distant(r, true), variants: 3, db: -4, max: 3 });
  // mecánica y recargas: solo el jugador local (no hay evento de red de recarga)
  const F = { bus: 'combat', prio: 92, cat: 'handling', order: 1, pitchVar: 0.03, dbVar: 1, max: 2, gap: 0, send: 0.04 };
  b.add('pump', { ...F, gen: pump, variants: 3, db: -9, max: 1 });
  b.add('mag_out', { ...F, gen: (r) => magOut(r, false), variants: 2, db: -12 });
  b.add('mag_in', { ...F, gen: (r) => magIn(r, false), variants: 2, db: -10 });
  b.add('rack', { ...F, gen: (r) => rack(r, false), variants: 2, db: -10 });
  b.add('mag_out_light', { ...F, gen: (r) => magOut(r, true), variants: 2, db: -13 });
  b.add('mag_in_light', { ...F, gen: (r) => magIn(r, true), variants: 2, db: -11 });
  b.add('slide_release', { ...F, gen: (r) => rack(r, true), variants: 2, db: -11 });
  b.add('shell_in', { ...F, gen: shellIn, variants: 4, db: -12 });
  b.add('bolt_open', { ...F, gen: boltOpen, variants: 2, db: -11 });
  b.add('round_in', { ...F, gen: roundIn, variants: 2, db: -13 });
  b.add('bolt_close', { ...F, gen: boltClose, variants: 2, db: -9 });
  b.add('tube_slide', { ...F, gen: tubeSlide, variants: 2, db: -12 });
  b.add('tube_lock', { ...F, gen: tubeLock, variants: 2, db: -9 });
  b.add('stun_charge', { ...F, gen: stunCharge, variants: 1, db: -17, pitchVar: 0 });
  b.add('ready_chirp', { ...F, gen: readyChirp, variants: 1, db: -19, pitchVar: 0 });
  b.add('swap_heavy', { ...F, gen: switchHeavy, variants: 3, db: -10, max: 1, group: 'swap' });
  b.add('swap_light', { ...F, gen: switchLight, variants: 3, db: -11, max: 1, group: 'swap' });
  b.add('dry', { ...F, gen: dryClick, variants: 3, db: -9, max: 1, gap: 0.09 });
  b.add('melee_swing', { ...F, gen: meleeSwing, variants: 3, db: -9, max: 2 });
  b.add('melee_hit', { ...F, prio: 95, gen: meleeHit, variants: 3, db: -3, max: 2, send: 0.12 });
  // mundo: proyectiles y explosiones
  const W = { bus: 'combat', prio: 90, cat: 'explosive', order: 2, pitchVar: 0.04, dbVar: 1, max: 3, send: 0.3 };
  b.add('boom', { ...W, gen: (r) => boom(r, false), variants: 3, db: -1 });
  b.add('boom_far', { ...W, gen: (r) => boom(r, true), variants: 2, db: -4, prio: 70 });
  b.add('boom_direct', { ...W, gen: boomDirect, variants: 2, db: -6 });
  b.add('rocket_loop', { ...W, gen: rocketLoop, variants: 1, loop: true, db: -9, send: 0.15 });
  const T = { bus: 'combat', prio: 72, cat: 'throwable', order: 2, pitchVar: 0.05, dbVar: 1.5, max: 3, gap: 0.04, send: 0.15 };
  b.add('throw', { ...T, gen: throwWhoosh, variants: 3, db: -10, prio: 90 });
  b.add('nade_bounce', { ...T, gen: nadeBounce, variants: 4, db: -10 });
  b.add('smoke_hiss', { ...T, gen: smokeHiss, variants: 2, db: -10 });
  b.add('stun_zap', { ...T, gen: stunZap, variants: 3, db: -7 });
  b.add('fuse_tick', { ...T, gen: fuseTick, variants: 2, db: -16, max: 2, gap: 0.08 });
  // balas que pasan cerca: información de amenaza, alta prioridad
  const B = { bus: 'combat', prio: 88, cat: 'bullet', order: 1, pitchVar: 0.08, dbVar: 1.5, max: 3, gap: 0.03 };
  b.add('whiz', { ...B, gen: whiz, variants: 4, db: -8 });
  b.add('crack', { ...B, gen: crack, variants: 3, db: -5, max: 2 });
  // impactos: posicionales, con tope y sin robar
  const I = { bus: 'combat', prio: 40, cat: 'impact', order: 2, pitchVar: 0.07, dbVar: 2, max: 4, gap: 0.03, steal: false, send: 0.1, group: 'impact' };
  b.add('imp_stone', { ...I, gen: impStone, variants: 4, db: -5 });
  b.add('imp_concrete', { ...I, gen: impConcrete, variants: 4, db: -5 });
  b.add('imp_metal', { ...I, gen: impMetal, variants: 4, db: -12 });
  b.add('imp_glass', { ...I, gen: impGlass, variants: 3, db: -12 });
}
