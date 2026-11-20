// Diseños de armas, recargas, proyectiles, balas e impactos de Breach.
// Los samples MP3 del dueño siguen siendo el cuerpo del disparo (defs
// `external` en catalog.js); aquí viven las capas alrededor: mecánica cercana,
// pegada grave, versión lejana, secuencias de recarga y todo lo que antes era
// un pitido placeholder. Helpers y varios diseños (clank/slide/thunk, bomba,
// cartucho, cambio de arma, seco, patada, impactos, ticks) son los de
// Crashterra (src/audio/sfx-weapons.ts), copiados tal cual o con el mínimo
// ajuste anotado. Todo es mono: el paneo lo pone la mezcla espacial.
import {
  ad, bank, bp, clicks, curve, dcBlock, ed, hp, knock, loopify, lp, metal, mixInto, modes, mono, noise,
  normalize, pulse, sat, scrape, SR, tone, trimTail, win,
} from './dsp.js';

const TAU = Math.PI * 2;
const M = (x, peak = 0.9) => trimTail(normalize([x], peak));

/* ------------------------------------------------------------- helpers */
// Antes (Crashterra): clank = 4 parciales modales de hasta 60 ms con el
// primero dominante, thunk = un seno que barre. Medido: 20–35 % de la energía
// de cada pieza de recarga en UN parcial que sonaba 80–140 ms → "marimba".
// Ahora todo contacto es ruido + racimo metálico corto e inarmónico (dsp.js:
// knock/metal/scrape/pulse): ningún parcial domina y nada pasa de ~25 ms
// salvo objetos que de verdad resuenan (tubo del bazuca, chapa).

/** Golpe metálico de mecanismo. base ≈ centro del color; tau = tope del racimo. */
function clank(out, r, at, base, amp, tau = 0.02) {
  knock(out, r, at, { amp, bright: base * 1.6, body: base * 0.4, dec: 0.004 + tau * 0.2, metal: 0.5,
    mf: [base * 0.55, base * 3.4], mt: [0.0015, Math.min(0.025, tau * 0.6)] });
}

/** Fricción metal contra metal (cargador en su guía, cerrojo). */
function slide(out, r, at, dur, f0, f1, amp) {
  scrape(out, r, at, dur, f0, f1, amp, { q: 1.1, grain: 0.55 });
}

/** Golpe grave seco (asentar un pestillo): pulso de presión + ruido, sin tono. */
function thunk(out, r, at, f, amp, tau = 0.03) {
  pulse(out, at, f, amp * 0.9);
  noise(out, r, { at, dur: tau * 4, color: 'pink', type: 'lp', f: f * 5, amp: amp * 0.9, env: (t) => ad(t, 0.0008, tau * 0.6) });
}

/** Pestillo pequeño: clic seco y brillante, metal de pocos ms. */
function latch(out, r, at, amp, bright = 3200) {
  knock(out, r, at, { amp, bright, body: bright * 0.3, dec: 0.003, metal: 0.3, mf: [bright * 0.55, bright * 2.2], mt: [0.0012, 0.006], n: 14 });
}

/** Pieza pesada que asienta (cargador, cerrojo): cuerpo + peso + metal corto. */
function seat(out, r, at, amp, o) {
  knock(out, r, at, { amp, bright: o.bright ?? 2000, body: o.body ?? 400, dec: o.dec ?? 0.01, weight: o.weight ?? 0.5,
    weightF: o.weightF ?? 110, metal: o.metal ?? 0.45, mf: o.mf ?? [800, 4200], mt: o.mt ?? [0.002, 0.018], n: o.n ?? 20 });
}

/** Resonancias anchas e inarmónicas de un tubo grande (Q bajo: hueco, no nota). */
// Q ≤ 2 y frecuencias que varían por variante: con Q 3–4 fijos la
// compuerta (por ventanas y canal) veía 8–12 % de la recarga en 179/370 Hz.
const TUBE = [[175, 1.6, 0.8], [405, 1.6, 0.55], [690, 1.8, 0.55], [1120, 2, 0.45], [1650, 2, 0.3]];
function hollow(x, r, mix = 0.6) {
  const y = bank(x, TUBE.map(([f, q, g]) => [f * r.vary(1, 0.1), q, g]));
  for (let i = 0; i < x.length; i++) x[i] = x[i] * (1 - mix) + y[i] * mix * 1.4;
  return x;
}

/* ------------------------------------------ capas del disparo propio */

// Mecánica del cerrojo: lo que el sample (grabado "de lejos") no trae y da
// la sensación de tener el arma en las manos.
// cerrojo abierto del subfusil: golpe atrás-adelante corto y grueso
function mechSmg(r) {
  const x = mono(0.11);
  seat(x, r, 0.003, 0.6, { bright: 2400, body: 650, dec: 0.006, weight: 0.4, weightF: 180, metal: 0.4, mf: [1300, 5200], mt: [0.0015, 0.009] });
  clicks(x, r, 0.018, 0.05, 220, 2600, 1.4, 0.2, 0.0008, (u) => 1 - u);
  lp(x, 9000);
  return M(x, 0.8);
}
// corredera de pistola: roce mínimo y un chasquido ligero
function mechPistol(r) {
  const x = mono(0.13);
  slide(x, r, 0, 0.02, 2200, 3000, 0.4);
  seat(x, r, 0.014, 0.7, { bright: 2800, body: 800, dec: 0.005, weight: 0.35, weightF: 220, metal: 0.4, mf: [1600, 6500], mt: [0.0012, 0.008] });
  lp(x, 9000);
  return M(x, 0.8);
}
/** Bombeo de la escopeta: dos golpes pesados (atrás, adelante) con su roce. */
function pump(r) {
  const x = mono(0.5);
  // atrás: el guardamanos corre y el cerrojo choca al fondo
  slide(x, r, 0, 0.06, 900, 1500, 0.5);
  seat(x, r, 0.055, 0.8, { bright: 1700, body: 300, dec: 0.012, weight: 0.7, weightF: 110, metal: 0.4, mf: [600, 3600], mt: [0.002, 0.02] });
  // adelante: más rápido y el golpe más fuerte (cierre)
  slide(x, r, 0.15, 0.045, 1500, 1000, 0.5);
  seat(x, r, 0.195, 1, { bright: 1500, body: 240, dec: 0.016, weight: 0.9, weightF: 90, metal: 0.45, mf: [500, 3200], mt: [0.003, 0.024] });
  lp(x, 8000);
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
  // el tubo resuena, pero ancho e inarmónico (antes: dos modos de 210/540 Hz)
  metal(x, r, 0.002, { n: 16, f0: 160, f1: 1100, t0: 0.012, t1: 0.05, amp: 0.35 });
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
  // siseo de la tobera: presente pero sin el aire de 8–16 kHz que dominaba el loop
  noise(hiss, r, { dur: L + 0.3, type: 'bp', f: 3000, q: 0.6, amp: 0.2 });
  mixInto(x, hiss, 0, 1);
  clicks(x, r, 0, L + 0.3, 70, 1900, 1.5, 0.2, 0.001);
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
// bote metálico contra el suelo: golpe hueco, metal corto, sin nota
function nadeBounce(r) {
  const x = mono(0.22);
  seat(x, r, 0.001, 1, { bright: 2400, body: r.range(550, 800), dec: 0.006, weight: 0.3, weightF: 240, metal: 0.5, mf: [1000, 5500], mt: [0.002, 0.022], n: 30 });
  lp(x, 9000);
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
  // chapa: resuena de verdad, pero con muchos modos inarmónicos y
  // amortiguados (antes: 6 modos con el primero dominante, 300 ms → campana)
  const base = r.range(420, 650);
  metal(x, r, 0.0005, { n: 28, f0: base, f1: base * 9, t0: 0.012, t1: 0.08, amp: 1.3 });
  noise(x, r, { dur: 0.05, color: 'pink', type: 'bp', f: base * 1.5, q: 0.8, amp: 0.4, env: (t) => ad(t, 0.0005, 0.008) });
  lp(x, 10000);
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

// Cada arma con su carácter; los instantes los fija fx/audio.js sobre la
// duración real de la recarga (tuning.js), así que aquí solo cambia el timbre.
function magOut(r, light) {
  const x = mono(0.3);
  // botón del retén, el cargador sale por su guía y queda libre
  latch(x, r, 0, light ? 0.55 : 0.5, light ? 3400 : 2800);
  slide(x, r, 0.012, light ? 0.05 : 0.08, light ? 2200 : 1600, light ? 1400 : 900, light ? 0.45 : 0.55);
  if (!light) knock(x, r, 0.095, { amp: 0.35, bright: 1400, body: 420, dec: 0.008, metal: 0.15, mf: [700, 3000], mt: [0.002, 0.01] });
  lp(x, 9000);
  return M(x, 0.8);
}
function magIn(r, light) {
  const x = mono(0.3);
  const at = light ? 0.035 : 0.055;
  slide(x, r, 0, at, light ? 1300 : 900, light ? 2100 : 1500, 0.45);
  // asienta: la pistola chasca ligero, el subfusil golpea grueso
  seat(x, r, at, 1, light
    ? { bright: 3000, body: 750, dec: 0.007, weight: 0.3, weightF: 170, metal: 0.42, mf: [1500, 6500], mt: [0.0012, 0.01] }
    : { bright: 2100, body: 380, dec: 0.012, weight: 0.65, weightF: 115, metal: 0.45, mf: [800, 4200], mt: [0.002, 0.018] });
  latch(x, r, at + (light ? 0.011 : 0.015), 0.35, light ? 3600 : 3000); // el retén engancha
  lp(x, 9000);
  return M(x, 0.9);
}
/** Manija de carga (subfusil) o corredera soltada (pistola). */
function rack(r, light) {
  const x = mono(0.35);
  if (light) {
    // pistola: palanca del retén, la corredera vuela adelante: ligera y seca
    latch(x, r, 0, 0.45, 3400);
    slide(x, r, 0.004, 0.014, 2600, 1900, 0.3);
    seat(x, r, 0.018, 1, { bright: 2700, body: 420, dec: 0.009, weight: 0.6, weightF: 130, metal: 0.45, mf: [1200, 6000], mt: [0.0015, 0.012] });
  } else {
    // subfusil: tira de la manija hasta el tope, la suelta, el cerrojo golpea
    slide(x, r, 0, 0.07, 1500, 2300, 0.5);
    seat(x, r, 0.07, 0.55, { bright: 2200, body: 520, dec: 0.007, weight: 0.25, metal: 0.35, mf: [1000, 4800], mt: [0.0015, 0.012] });
    slide(x, r, 0.14, 0.025, 2300, 1600, 0.3);
    seat(x, r, 0.165, 1, { bright: 1900, body: 260, dec: 0.014, weight: 0.9, weightF: 85, metal: 0.5, mf: [700, 4000], mt: [0.003, 0.022] });
    latch(x, r, 0.187, 0.25, 2800);
  }
  lp(x, 9000);
  return M(x, 0.92);
}
/** Cartucho entrando en el tubo: roce de la vaina, clic del elevador, muelle. */
function shellIn(r) {
  const x = mono(0.25);
  slide(x, r, 0, 0.03, 1300, 1900, 0.35);
  knock(x, r, 0.028, { amp: 0.75, bright: 2300, body: 520, dec: 0.007, weight: 0.35, weightF: 240, metal: 0.18, mf: [1400, 5000], mt: [0.0015, 0.006] });
  knock(x, r, 0.05 + r.range(0, 0.01), { amp: 0.22, bright: 2800, body: 900, dec: 0.004, metal: 0.1, mf: [1800, 5000], mt: [0.0012, 0.005] });
  lp(x, 8000);
  return M(x, 0.8);
}
/** Cerrojo del francotirador: (1) palanca arriba, (2) cerrojo atrás. */
function boltOpen(r) {
  const x = mono(0.3);
  seat(x, r, 0, 0.7, { bright: 2400, body: 600, dec: 0.006, weight: 0.2, metal: 0.38, mf: [1200, 5500], mt: [0.0015, 0.01] });
  slide(x, r, 0.05, 0.09, 1300, 2100, 0.55);
  seat(x, r, 0.14, 0.8, { bright: 2000, body: 420, dec: 0.01, weight: 0.35, weightF: 120, metal: 0.4, mf: [900, 4500], mt: [0.002, 0.016] });
  lp(x, 9000);
  return M(x, 0.85);
}
/** Cartucho a mano en la recámara. */
function roundIn(r) {
  const x = mono(0.2);
  slide(x, r, 0, 0.025, 2000, 2600, 0.25);
  knock(x, r, 0.022, { amp: 0.65, bright: 2800, body: 800, dec: 0.005, weight: 0.25, weightF: 230, metal: 0.25, mf: [1800, 6500], mt: [0.0015, 0.008] });
  lp(x, 9000);
  return M(x, 0.75);
}
/** (3) cerrojo adelante hasta el tope, (4) palanca abajo: cierra. */
function boltClose(r) {
  const x = mono(0.35);
  slide(x, r, 0, 0.08, 2100, 1300, 0.5);
  seat(x, r, 0.08, 0.9, { bright: 1900, body: 320, dec: 0.012, weight: 0.6, weightF: 100, metal: 0.45, mf: [800, 4200], mt: [0.002, 0.02] });
  seat(x, r, 0.2, 0.75, { bright: 2600, body: 520, dec: 0.007, weight: 0.3, weightF: 150, metal: 0.4, mf: [1300, 6000], mt: [0.0015, 0.012] });
  latch(x, r, 0.212, 0.3, 3000);
  lp(x, 9000);
  return M(x, 0.92);
}
/** Cohete entrando en el tubo: roce largo y hueco, aletas que tocan, asienta. */
function tubeSlide(r) {
  const x = mono(0.55);
  slide(x, r, 0, 0.35, 500, 900, 0.7);
  noise(x, r, { dur: 0.35, color: 'pink', type: 'lp', f: 400, amp: 0.3, env: (t) => win(t / 0.35, 0.2, 0.4) });
  knock(x, r, 0.06, { amp: 0.3, bright: 1500, body: 320, dec: 0.008, metal: 0.2, mf: [500, 2600], mt: [0.003, 0.02] });
  knock(x, r, 0.27, { amp: 0.3, bright: 1500, body: 300, dec: 0.008, metal: 0.2, mf: [500, 2600], mt: [0.003, 0.02] });
  seat(x, r, 0.36, 0.7, { bright: 1300, body: 170, dec: 0.02, weight: 0.7, weightF: 70, metal: 0.3, mf: [350, 2400], mt: [0.004, 0.04] });
  hollow(x, r, 0.5);
  lp(x, 7000);
  return M(x, 0.8);
}
/** Cierre del bazuca: pestillo grande y un clic de contacto/seguro. */
function tubeLock(r) {
  const x = mono(0.4);
  seat(x, r, 0, 1, { bright: 1700, body: 200, dec: 0.016, weight: 0.9, weightF: 75, metal: 0.5, mf: [450, 3500], mt: [0.003, 0.03], n: 28 });
  knock(x, r, 0.12, { amp: 0.45, bright: 2800, body: 700, dec: 0.005, metal: 0.3, mf: [1500, 6000], mt: [0.0015, 0.008] });
  hollow(x, r, 0.35);
  lp(x, 8000);
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

// arma larga: tela y correa, el arma cae en las manos, clic del selector
function switchHeavy(r) {
  const x = mono(0.55);
  noise(x, r, { dur: 0.2, color: 'pink', type: 'bp', f: 900, q: 0.7, amp: 0.45, env: (t) => win(t / 0.2, 0.3, 0.6) });
  scrape(x, r, 0.05, 0.13, 1100, 1500, 0.22, { q: 0.8, grain: 0.85 }); // cincha
  seat(x, r, 0.28, 1, { bright: 1600, body: 260, dec: 0.012, weight: 0.65, weightF: 95, metal: 0.25, mf: [600, 3500], mt: [0.002, 0.015] });
  latch(x, r, 0.36, 0.25, 2800);
  lp(x, 8000);
  return M(x, 0.85);
}
// pistola/lanzable: cuero de la funda y la mano que cierra sobre la empuñadura
function switchLight(r) {
  const x = mono(0.28);
  noise(x, r, { dur: 0.09, type: 'bp', f: curve([[0, 900], [1, 2000]]), q: 0.9, amp: 0.4, env: (t) => win(t / 0.09, 0.4, 0.5) });
  seat(x, r, 0.08, 0.8, { bright: 2200, body: 420, dec: 0.008, weight: 0.3, weightF: 140, metal: 0.2, mf: [1000, 5000], mt: [0.0015, 0.01] });
  lp(x, 8000);
  return M(x, 0.8);
}
// gatillo en seco: el martillo cae sobre nada y el gatillo se rearma
function dryClick(r) {
  const x = mono(0.12);
  knock(x, r, 0, { amp: 1, bright: 2500, body: 950, dec: 0.003, metal: 0.3, mf: [1500, 6000], mt: [0.001, 0.006], n: 16 });
  knock(x, r, 0.035 + r.range(0, 0.008), { amp: 0.3, bright: 3300, body: 1500, dec: 0.002, metal: 0.15, mf: [2000, 7000], mt: [0.001, 0.004] });
  lp(x, 9000);
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
  // cuerpo golpeado: pulso de presión + ruido grave (antes un seno que barría = bombo)
  pulse(thud, 0, 110 * kk, 1);
  noise(thud, r, { dur: 0.3, color: 'brown', type: 'lp', f: 420 * kk, amp: 1.4, env: (t) => ad(t, 0.0015, r.range(0.035, 0.06)) });
  noise(thud, r, { dur: 0.1, type: 'lp', f: 600, amp: 0.8, env: (t) => ed(t, 0.02) });
  sat(thud, 2.5);
  mixInto(x, thud, 0, 1);
  // contacto de equipo/armadura (en Crashterra era quitina)
  const cr = mono(0.12);
  clicks(cr, r, 0, 0.05, 700, 1900, 1.2, 1, 0.001, (u) => 1 - u);
  noise(cr, r, { dur: 0.08, type: 'bp', f: 1100, q: 1, amp: 0.6, env: (t) => ed(t, 0.014) });
  sat(cr, 2);
  mixInto(x, cr, 0.002, 0.4);
  noise(x, r, { at: r.range(0.008, 0.03), dur: 0.4, color: 'brown', type: 'lp', f: 160 / kk, amp: 1.2 + v * 0.1, env: (t) => ad(t, 0.01, 0.09) });
  dcBlock(x);
  return M(x, 0.97);
}

/* --------------------------------------------------------------- export */

export function addWeaponSounds(b) {
  // capas del arma propia: frontales, alta prioridad, envío corto a la sala
  const L = { bus: 'combat', prio: 100, cat: 'weapon', order: 0, pitchVar: 0.03, dbVar: 1, max: 3, gap: 0, send: 0.06 };
  b.add('mech_smg', { ...L, gen: mechSmg, variants: 4, roundRobin: true, db: -9 });
  b.add('mech_pistol', { ...L, gen: mechPistol, variants: 3, db: -8 });
  b.add('punch_light', { ...L, gen: (r) => punch(r, false), variants: 3, db: -14 });
  b.add('punch_heavy', { ...L, gen: (r) => punch(r, true), variants: 3, db: -11 });
  b.add('bazooka_fire', { ...L, gen: bazookaFire, variants: 3, db: -4, max: 2, send: 0.18 });
  // ajeno a distancia: nunca roba a los cercanos
  const D = { bus: 'combat', prio: 62, cat: 'distant', order: 1, pitchVar: 0.05, dbVar: 1.5, max: 4, gap: 0.03, send: 0.2 };
  b.add('dist_light', { ...D, gen: (r) => distant(r, false), variants: 4, db: -6 });
  b.add('dist_heavy', { ...D, gen: (r) => distant(r, true), variants: 3, db: -4, max: 3 });
  // mecánica y recargas: solo el jugador local (no hay evento de red de recarga)
  const F = { bus: 'combat', prio: 92, cat: 'handling', order: 1, pitchVar: 0.03, dbVar: 1, max: 2, gap: 0, send: 0.04 };
  b.add('pump', { ...F, gen: pump, variants: 3, db: -5, max: 1 });
  b.add('mag_out', { ...F, gen: (r) => magOut(r, false), variants: 2, db: -12 });
  b.add('mag_in', { ...F, gen: (r) => magIn(r, false), variants: 2, db: -8 });
  b.add('rack', { ...F, gen: (r) => rack(r, false), variants: 2, db: -7 });
  b.add('mag_out_light', { ...F, gen: (r) => magOut(r, true), variants: 2, db: -11 });
  b.add('mag_in_light', { ...F, gen: (r) => magIn(r, true), variants: 2, db: -9 });
  b.add('slide_release', { ...F, gen: (r) => rack(r, true), variants: 2, db: -7 });
  b.add('shell_in', { ...F, gen: shellIn, variants: 4, db: -9 });
  b.add('bolt_open', { ...F, gen: boltOpen, variants: 2, db: -10 });
  b.add('round_in', { ...F, gen: roundIn, variants: 2, db: -10 });
  b.add('bolt_close', { ...F, gen: boltClose, variants: 2, db: -8 });
  b.add('tube_slide', { ...F, gen: tubeSlide, variants: 2, db: -9 });
  b.add('tube_lock', { ...F, gen: tubeLock, variants: 2, db: -5 });
  b.add('stun_charge', { ...F, gen: stunCharge, variants: 1, db: -17, pitchVar: 0 });
  b.add('ready_chirp', { ...F, gen: readyChirp, variants: 1, db: -19, pitchVar: 0 });
  b.add('swap_heavy', { ...F, gen: switchHeavy, variants: 3, db: -8, max: 1, group: 'swap' });
  b.add('swap_light', { ...F, gen: switchLight, variants: 3, db: -10, max: 1, group: 'swap' });
  b.add('dry', { ...F, gen: dryClick, variants: 3, db: -7, max: 1, gap: 0.09 });
  b.add('melee_swing', { ...F, gen: meleeSwing, variants: 3, db: -9, max: 2 });
  b.add('melee_hit', { ...F, prio: 95, gen: meleeHit, variants: 3, db: -2, max: 2, send: 0.12 });
  // mundo: proyectiles y explosiones
  const W = { bus: 'combat', prio: 90, cat: 'explosive', order: 2, pitchVar: 0.04, dbVar: 1, max: 3, send: 0.3 };
  b.add('boom', { ...W, gen: (r) => boom(r, false), variants: 3, db: -1 });
  b.add('boom_far', { ...W, gen: (r) => boom(r, true), variants: 2, db: -4, prio: 70 });
  b.add('boom_direct', { ...W, gen: boomDirect, variants: 2, db: -4 });
  b.add('rocket_loop', { ...W, gen: rocketLoop, variants: 1, loop: true, db: -9, send: 0.15 });
  const T = { bus: 'combat', prio: 72, cat: 'throwable', order: 2, pitchVar: 0.05, dbVar: 1.5, max: 3, gap: 0.04, send: 0.15 };
  b.add('throw', { ...T, gen: throwWhoosh, variants: 3, db: -10, prio: 90 });
  b.add('nade_bounce', { ...T, gen: nadeBounce, variants: 4, db: -7 });
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
  b.add('imp_metal', { ...I, gen: impMetal, variants: 4, db: -11 });
  b.add('imp_glass', { ...I, gen: impGlass, variants: 3, db: -12 });
}
