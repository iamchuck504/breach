// Foley del soldado, feedback de combate, recogidas, pedestal, interfaz,
// stingers de ronda, cama del menú y las respuestas al impulso de cada mapa.
// Pasos, salto, aterrizaje, daño, latido, UI y stingers parten de los de
// Crashterra (src/audio/sfx-world.ts / sfx-weapons.ts) con los ajustes
// anotados (sin "traje" sci-fi: Breach son soldados).
import {
  ad, bp, clicks, curve, dcBlock, ed, fm, hp, knock, len, loopify, lp, metal, mixInto, modes, mono, noise, noiseIR,
  normalize, pulse, sat, scrape, SR, tone, trimTail, vocal, widen, win, withRoom,
} from './dsp.js';

const TAU = Math.PI * 2;
const M = (x, peak = 0.9) => trimTail(normalize([x], peak));
const W = (x, peak = 0.8, ms = 0.35) => trimTail(normalize(widen(x, ms), peak));

/* --------------------------------------------------------------- pasos */

// Un paso de bota es RUIDO, no una nota. Tres capas, todas sin altura
// definida: el golpe sordo del talón (ruido grave), la palmada de la suela un
// instante después (banda ancha) y el roce con arenilla contra el piso.
// La primera versión usaba un seno puro de 110-140 Hz que se apagaba en 10 ms
// y casi nada más: el 95 % de la energía quedaba bajo 250 Hz, tres cuartas
// partes en un solo tono, durante 40 ms. Sonaba a tambor seco.
function bootStep(r, o) {
  const x = mono(o.len);
  const heel = r.range(0.001, 0.005);
  const toe = heel + r.range(o.gap[0], o.gap[1]); // talón → suela
  noise(x, r, { at: heel, dur: o.thudDur, color: 'pink', type: 'bp', f: o.thudF * r.vary(1, 0.2), q: 0.8, amp: o.thud * r.range(0.8, 1.1),
    env: (t) => ad(t, 0.003, o.thudDur * 0.3) });
  noise(x, r, { at: toe, dur: o.slapDur, type: 'bp', f: o.slapF * r.vary(1, 0.22), q: 0.7, amp: o.slap * r.range(0.75, 1.1),
    env: (t) => ad(t, 0.002, o.slapDur * 0.28) });
  noise(x, r, { at: toe + 0.004, dur: o.gritDur, color: 'pink', type: 'bp', f: o.gritF * r.vary(1, 0.25), q: 0.5, amp: o.grit * r.range(0.7, 1.15),
    env: (t) => win(t / o.gritDur, 0.08, 0.78) });
  if (o.grains) clicks(x, r, toe, o.gritDur * 0.9, o.grains, o.grainF, 1.2, o.grainAmp, 0.0007, (u) => 1 - u);
  // sin brillo por encima de ~7 kHz: a ritmo de sprint ese aire se sumaba en siseo
  lp(x, 7000);
  return x;
}
// piedra labrada: seca y con algo de arenilla suelta
function stepStone(r) {
  return M(bootStep(r, { len: 0.2, gap: [0.016, 0.03], thudF: 190, thud: 1.5, thudDur: 0.06, slapF: 1050, slap: 0.5, slapDur: 0.05,
    gritF: 2100, grit: 0.15, gritDur: 0.085, grains: 130, grainF: 2400, grainAmp: 0.065 }), 0.75);
}
// hormigón/asfalto: suela de goma, más grave y con más roce
function stepConcrete(r) {
  return M(bootStep(r, { len: 0.22, gap: [0.018, 0.034], thudF: 165, thud: 1.7, thudDur: 0.065, slapF: 850, slap: 0.46, slapDur: 0.055,
    gritF: 1800, grit: 0.19, gritDur: 0.1, grains: 170, grainF: 2200, grainAmp: 0.06 }), 0.75);
}
// chapa: el mismo paso con un timbre metálico corto e inarmónico encima (una
// plancha, no una campana) y menos arenilla
function stepMetal(r) {
  const x = bootStep(r, { len: 0.26, gap: [0.014, 0.026], thudF: 210, thud: 1.8, thudDur: 0.05, slapF: 1500, slap: 0.46, slapDur: 0.04,
    gritF: 2800, grit: 0.1, gritDur: 0.06 });
  // la chapa vibra: muchos modos inarmónicos muy cortos (antes 4 parciales con el primero dominante)
  const b = r.range(340, 500);
  metal(x, r, 0.012, { n: 18, f0: b, f1: b * 9, t0: 0.004, t1: 0.03, amp: 0.3 });
  return M(x, 0.75);
}
// tierra compacta y hierba: golpe blando, sin palmada, con un susurro de hierba
function stepEarth(r) {
  return M(bootStep(r, { len: 0.24, gap: [0.02, 0.036], thudF: 140, thud: 2.1, thudDur: 0.08, slapF: 600, slap: 0.3, slapDur: 0.06,
    gritF: 3000, grit: 0.11, gritDur: 0.12 }), 0.72);
}
/** Arrastre lateral pegado al muro. */
function scuff(r) {
  const d = r.range(0.11, 0.15);
  const x = mono(d + 0.02);
  noise(x, r, { dur: d, type: 'bp', f: r.range(1300, 1900), q: 0.9, amp: 0.8, env: (t) => win(t / d, 0.25, 0.5) });
  clicks(x, r, 0, d, 160, 3200, 1.5, 0.18, 0.0007);
  return M(x, 0.7);
}
/**
 * Equipo al esprintar: tela, cinchas y algún golpe blando (cargador en su
 * funda). Antes eran clics a 2.6 kHz y dos modos de 1.2–3.1 kHz: un
 * cascabel en cada zancada.
 */
function gear(r, v) {
  const x = mono(0.18);
  noise(x, r, { dur: 0.12, color: 'pink', type: 'bp', f: r.range(650, 1050), q: 0.7, amp: 0.6, env: (t) => win(t / 0.12, 0.25, 0.6) });
  scrape(x, r, 0.01, 0.08, 800, 1200, 0.25, { q: 0.8, grain: 0.9 });
  // solo algunas variantes golpean: el equipo no suena igual en cada paso
  if (v % 2 === 0) knock(x, r, r.range(0.02, 0.05), { amp: 0.55, bright: 1100, body: 300, dec: 0.01, weight: 0.3, weightF: 150, metal: 0.06, mf: [600, 2200], mt: [0.002, 0.008] });
  lp(x, 3500);
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
  // dos botas que caen: presión grave + ruido, sin el seno que barría (bombo)
  pulse(x, 0, (heavy ? 80 : 95) * k, 0.9);
  noise(x, r, { dur: 0.25, color: 'brown', type: 'lp', f: (heavy ? 320 : 380) * k, amp: 1.5, env: (t) => ad(t, 0.002, heavy ? 0.05 : 0.03) });
  noise(x, r, { dur: 0.12, type: 'lp', f: 1400, amp: 0.7, env: (t) => ad(t, 0.002, 0.025) });
  clicks(x, r, 0.005, 0.1, 220, 2400, 1.3, 0.25, 0.0008, (u) => 1 - u);
  if (heavy) {
    knock(x, r, 0.012, { amp: 0.35, bright: 1300, body: 350, dec: 0.012, metal: 0.15, mf: [500, 2500], mt: [0.002, 0.015] });
    scrape(x, r, 0.03, 0.12, 900, 700, 0.2, { q: 0.8, grain: 0.9 });
  }
  sat(x, 1.5);
  return M(x, 0.9);
}
/**
 * Deslizamiento en primera persona (0.5 s, velocidad que cae a ×0.42):
 * caída del cuerpo al suelo, roce que pierde fuerza con la velocidad y un
 * arrastre corto de frenada al final. Todo ruido con forma.
 */
function slideFoley(r) {
  const d = 0.62;
  const x = mono(d);
  // arranque: cadera y bota golpean el suelo + tela
  pulse(x, 0, 120 * r.vary(1, 0.1), 0.6);
  noise(x, r, { dur: 0.08, color: 'brown', type: 'lp', f: 420, amp: 1.1, env: (t) => ad(t, 0.002, 0.025) });
  noise(x, r, { dur: 0.1, color: 'pink', type: 'bp', f: 1100, q: 0.7, amp: 0.45, env: (t) => win(t / 0.1, 0.2, 0.6) });
  // roce: la energía y el brillo bajan con la velocidad (1 → 0.42)
  const sc = mono(0.5);
  noise(sc, r, { dur: 0.5, type: 'bp', f: curve([[0, 1500], [1, 650]]), q: 0.8, amp: 0.75, env: (t) => win(t / 0.5, 0.08, 0.25) * (1 - 0.58 * (t / 0.5)) });
  noise(sc, r, { dur: 0.5, color: 'brown', type: 'lp', f: 380, amp: 0.55, env: (t) => win(t / 0.5, 0.1, 0.3) * (1 - 0.5 * (t / 0.5)) });
  clicks(sc, r, 0.02, 0.42, 140, 2400, 1.6, 0.2, 0.0008, (u) => 1 - 0.7 * u);
  mixInto(x, sc, 0.02, 1);
  // frenada: la bota muerde el suelo
  knock(x, r, 0.47 + r.range(0, 0.03), { amp: 0.4, bright: 1300, body: 380, dec: 0.012, weight: 0.3, weightF: 110, metal: 0.04, mf: [500, 2000], mt: [0.002, 0.006] });
  noise(x, r, { at: 0.47, dur: 0.12, type: 'bp', f: 900, q: 0.8, amp: 0.3, env: (t) => win(t / 0.12, 0.1, 0.6) });
  lp(x, 6500);
  dcBlock(x);
  return M(x, 0.8);
}
// Ráfaga de la esquiva FPS: el silbido cae con la velocidad del cuerpo.
// La tela y las dos pisadas entran por sus propios eventos de simulación.
function dodgeAir(r) {
  const d = 0.24, x = mono(d);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 750], [0.16, 2900], [1, 540]]),
    q: 1.5, amp: 0.85, env: t => win(t / d, 0.12, 0.77) });
  return M(x, 0.8);
}
// Un único sonido espacial: el contacto de la suela ancla el soplo y la tela.
function dodgeStep(r, variant) {
  const x = mono(0.26);
  mixInto(x, stepConcrete(r)[0], 0, 0.83);
  mixInto(x, dodgeAir(r)[0], 0.008, 0.57);
  mixInto(x, cloth(r, variant)[0], 0.018, 0.43);
  return M(x, 0.8);
}
/** Espalda contra la cobertura: golpe sordo + equipo. */
function coverHit(r) {
  const x = mono(0.32);
  pulse(x, 0, 90 * r.vary(1, 0.1), 0.9);
  noise(x, r, { dur: 0.2, color: 'brown', type: 'lp', f: 360, amp: 1.4, env: (t) => ad(t, 0.0015, 0.035) });
  noise(x, r, { dur: 0.08, type: 'lp', f: 800, amp: 0.7, env: (t) => ad(t, 0.001, 0.018) });
  // equipo contra la cobertura: golpe blando, no cascabel
  knock(x, r, 0.012, { amp: 0.3, bright: 1200, body: 380, dec: 0.01, metal: 0.1, mf: [600, 2400], mt: [0.002, 0.01] });
  sat(x, 1.5);
  return M(x, 0.9);
}
/** Evasión/rodada: aire + golpe de hombro + tela. */
function dive(r) {
  const d = 0.6;
  const x = mono(d);
  noise(x, r, { dur: 0.24, type: 'bp', f: curve([[0, 500], [0.5, 1700], [1, 700]]), q: 1, amp: 0.8, env: (t) => win(t / 0.24, 0.4, 0.5) });
  pulse(x, 0.22, 85, 0.7);
  noise(x, r, { at: 0.22, dur: 0.15, color: 'brown', type: 'lp', f: 340, amp: 1.2, env: (t) => ad(t, 0.002, 0.035) });
  noise(x, r, { at: 0.22, dur: 0.3, type: 'bp', f: 1300, q: 0.8, amp: 0.4, env: (t) => win(t / 0.3, 0.05, 0.6) });
  scrape(x, r, 0.24, 0.14, 1000, 800, 0.2, { q: 0.8, grain: 0.9 });
  return M(x, 0.85);
}
/**
 * Trepar sobre una cobertura baja (0.42 s, TUNING.mantle.time): las dos
 * manos golpean el borde, roce de tela y equipo contra el canto, aire y las
 * botas que caen arriba al final del gesto.
 */
function mantle(r) {
  const x = mono(0.62);
  for (const at of [0, 0.045 + r.range(0, 0.02)]) {
    noise(x, r, { at, dur: 0.02, type: 'bp', f: r.range(1300, 1800), q: 0.9, amp: 0.7, env: (t) => ed(t, 0.004) });
    pulse(x, at, 150 * r.vary(1, 0.1), 0.35);
  }
  scrape(x, r, 0.09, 0.22, 800, 1300, 0.35, { q: 0.8, grain: 0.85 });
  noise(x, r, { at: 0.08, dur: 0.24, color: 'pink', type: 'bp', f: 950, q: 0.7, amp: 0.3, env: (t) => win(t / 0.24, 0.25, 0.5) });
  knock(x, r, 0.2, { amp: 0.25, bright: 1100, body: 320, dec: 0.01, weight: 0.2, weightF: 140, metal: 0.05, mf: [500, 2000], mt: [0.002, 0.008] });
  // botas arriba
  const at = 0.4 + r.range(0, 0.03);
  pulse(x, at, 95 * r.vary(1, 0.1), 0.7);
  noise(x, r, { at, dur: 0.12, color: 'brown', type: 'lp', f: 380, amp: 1.1, env: (t) => ad(t, 0.002, 0.03) });
  noise(x, r, { at: at + 0.004, dur: 0.06, type: 'lp', f: 1400, amp: 0.45, env: (t) => ad(t, 0.002, 0.016) });
  lp(x, 7000);
  dcBlock(x);
  return M(x, 0.8);
}
/** Tela y equipo al agacharse, levantarse o inclinarse: susurro corto, sin golpe metálico. */
function cloth(r, v) {
  const d = r.range(0.12, 0.2);
  const x = mono(d + 0.05);
  noise(x, r, { dur: d, color: 'pink', type: 'bp', f: r.range(650, 1250), q: 0.7, amp: 0.6, env: (t) => win(t / d, 0.3, 0.55) });
  scrape(x, r, 0.01, d * 0.7, 900, 1300, 0.18, { q: 0.8, grain: 0.9 });
  if (v % 3 === 0) knock(x, r, d * 0.6, { amp: 0.3, bright: 1100, body: 300, dec: 0.009, weight: 0.2, weightF: 150, metal: 0.04, mf: [600, 2000], mt: [0.002, 0.006] });
  lp(x, 5000);
  return M(x, 0.6);
}
function whoosh(r) {
  const d = r.range(0.16, 0.22);
  const x = mono(d + 0.02);
  noise(x, r, { dur: d, type: 'bp', f: curve([[0, 500], [0.5, 1800], [1, 700]]), q: 0.9, amp: 1, env: (t) => win(t / d, 0.45, 0.5) });
  return M(x, 0.75);
}

/* ------------------------------------------------- feedback de combate */

// Confirmaciones de impacto y de baja: percusión, nunca notas (el dueño ya
// rechazó las "campanitas"). Antes: seno de 3.6 kHz (cuerpo), 4.8 kHz +
// modos de 2.65 kHz (cabeza) y una quinta 1250/1875 Hz en triangular (baja).
// Ahora se distinguen por golpe, brillo y ritmo, no por altura:
//   cuerpo  — palmada seca y acolchada (~2 kHz), 50 ms;
//   cabeza  — doble chasquido brillante (~4–6 kHz) con racimo metálico de
//             pocos ms (el casco), 70 ms;
//   baja    — golpe grave de peso + chasquido, 200 ms (cabeza: con el doble
//             chasquido encima).
function hitTick(r) {
  const x = mono(0.07);
  noise(x, r, { dur: 0.012, type: 'bp', f: r.range(1900, 2500), q: 0.9, amp: 1, env: (t) => ad(t, 0.0004, 0.0035) });
  noise(x, r, { dur: 0.04, color: 'pink', type: 'bp', f: 950, q: 0.8, amp: 0.55, env: (t) => ad(t, 0.0005, 0.008) });
  pulse(x, 0, 170 * r.vary(1, 0.08), 0.08);
  lp(x, 9000);
  return M(x, 0.85);
}
function headTicks(x, r, at, amp) {
  for (const [dt, a] of [[0, 1], [0.011 + r.range(0, 0.002), 0.75]]) {
    noise(x, r, { at: at + dt, dur: 0.006, type: 'hp', f: 3200, amp: amp * a, env: (t) => ed(t, 0.0009) });
    noise(x, r, { at: at + dt, dur: 0.02, type: 'bp', f: r.range(4600, 5800), q: 1.1, amp: amp * a * 0.6, env: (t) => ed(t, 0.0028) });
  }
  // el casco: racimo metálico inarmónico de 1.5–5 ms (no una campana)
  metal(x, r, at + 0.001, { n: 14, f0: 2600, f1: 9500, t0: 0.0015, t1: 0.005, amp: amp * 0.55 });
}
function hitHead(r) {
  const x = mono(0.09);
  headTicks(x, r, 0, 1);
  pulse(x, 0, 220, 0.18);
  lp(x, 11000);
  return M(x, 0.85);
}
function killConfirm(r, head) {
  const x = mono(head ? 0.26 : 0.24);
  const k = r.vary(1, 0.06);
  // peso: presión + ruido grave; un segundo golpe más blando (el cuerpo que cae)
  pulse(x, 0, 95 * k, 1);
  noise(x, r, { dur: 0.12, color: 'brown', type: 'lp', f: 320, amp: 1.5, env: (t) => ad(t, 0.0015, 0.03) });
  noise(x, r, { at: 0.004, dur: 0.02, type: 'bp', f: 1700, q: 0.9, amp: 0.55, env: (t) => ed(t, 0.004) });
  pulse(x, 0.075, 70 * k, 0.5);
  noise(x, r, { at: 0.075, dur: 0.12, color: 'brown', type: 'lp', f: 260, amp: 0.8, env: (t) => ad(t, 0.002, 0.035) });
  if (head) headTicks(x, r, 0, 0.8);
  sat(x, 1.6);
  lp(x, head ? 11000 : 6000);
  dcBlock(x);
  return M(x, 0.9);
}
// daño recibido: golpe al cuerpo + desgarro de banda media. Sin el seno que
// barría (130→60 Hz). La dirección la da el paneo y, si viene de atrás, el
// corte de agudos que aplica el facade (delante = más brillante).
function hurt(r) {
  const x = mono(0.2);
  const k = r.vary(1, 0.14);
  pulse(x, 0, 110 * k, 0.9);
  noise(x, r, { dur: 0.12, color: 'brown', type: 'lp', f: 380 * k, amp: 1.3, env: (t) => ad(t, 0.001, 0.028) });
  noise(x, r, { at: 0.002, dur: 0.06, type: 'bp', f: r.range(1300, 1900), q: 0.8, amp: 0.6, env: (t) => ad(t, 0.0008, 0.012) });
  clicks(x, r, 0, 0.035, 600, 2000, 1.5, 0.3, 0.001, (u) => 1 - u);
  sat(x, 1.8);
  lp(x, 7000);
  dcBlock(x);
  return M(x, 0.9);
}
// latido: dos golpes de presión grave (lub-dub), sin seno barrido
function heartbeat1(x, r, at, amp, k = 1) {
  pulse(x, at, 65 * k, amp);
  noise(x, r, { at, dur: 0.14, color: 'brown', type: 'lp', f: 170 * k, amp: amp * 1.4, env: (t) => ad(t, 0.006, 0.04) });
}
function heartbeat(r) {
  const x = mono(0.55);
  const k = r.vary(1, 0.1);
  heartbeat1(x, r, 0, 1, k);
  heartbeat1(x, r, r.range(0.24, 0.29), 0.7, k * 0.94);
  lp(x, 380);
  dcBlock(x, 12);
  return M(x, 0.9);
}
function death(r) {
  const d = 1.9;
  const x = mono(d);
  tone(x, { dur: 0.4, f: curve([[0, 140], [1, 40]]), amp: 1, env: (t) => ad(t, 0.001, 0.09) });
  noise(x, r, { dur: 0.2, type: 'bp', f: 700, q: 0.8, amp: 0.8, env: (t) => ed(t, 0.04) });
  // el mundo se apaga: un tono que cae + latidos finales
  tone(x, { at: 0.12, dur: 1.5, f: curve([[0, 420], [1, 55]]), wave: 'tri', amp: 0.18, env: (t) => win(t / 1.5, 0.05, 0.6) });
  for (const at of [0.7, 1.0, 1.5]) heartbeat1(x, r, at, 0.5);
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

// Recogidas como objetos (antes: campanillas y tonos triangulares en
// intervalos musicales, con la reverb de peine encima).
// caja de munición: dos cierres, la tapa, cargadores que se toman
function crate(r) {
  const x = mono(0.7);
  knock(x, r, 0, { amp: 0.5, bright: 2600, body: 800, dec: 0.004, metal: 0.3, mf: [1400, 5500], mt: [0.0015, 0.008] });
  knock(x, r, 0.055, { amp: 0.45, bright: 2400, body: 750, dec: 0.004, metal: 0.3, mf: [1400, 5500], mt: [0.0015, 0.008] });
  knock(x, r, 0.13, { amp: 1, bright: 1300, body: 240, dec: 0.022, weight: 0.6, weightF: 95, metal: 0.15, mf: [350, 2000], mt: [0.003, 0.02] });
  knock(x, r, 0.3, { amp: 0.6, bright: 2200, body: 600, dec: 0.007, weight: 0.2, metal: 0.4, mf: [1000, 5000], mt: [0.002, 0.014] });
  scrape(x, r, 0.33, 0.06, 1400, 1000, 0.25);
  knock(x, r, 0.4, { amp: 0.5, bright: 2000, body: 520, dec: 0.008, weight: 0.2, metal: 0.4, mf: [900, 4500], mt: [0.002, 0.016] });
  lp(x, 8000);
  return M(x, 0.85);
}
/** Balas sueltas de un arma caída: cargadores que chocan. */
function ammoPickup(r) {
  const x = mono(0.35);
  scrape(x, r, 0, 0.08, 1500, 1100, 0.3, { grain: 0.8 });
  knock(x, r, 0.05, { amp: 0.8, bright: 2300, body: 650, dec: 0.007, weight: 0.2, metal: 0.42, mf: [1100, 5200], mt: [0.002, 0.014] });
  knock(x, r, 0.12 + r.range(0, 0.02), { amp: 0.6, bright: 2000, body: 520, dec: 0.008, weight: 0.25, metal: 0.38, mf: [900, 4500], mt: [0.002, 0.016] });
  lp(x, 8500);
  return M(x, 0.8);
}
// arma del suelo: correa/tela, el arma golpea las manos, el seguro
function weaponPickup(r) {
  const x = mono(0.5);
  noise(x, r, { dur: 0.16, color: 'pink', type: 'bp', f: 1100, q: 0.7, amp: 0.4, env: (t) => win(t / 0.16, 0.3, 0.6) });
  scrape(x, r, 0.03, 0.1, 1000, 1400, 0.2, { q: 0.8, grain: 0.85 });
  knock(x, r, 0.14, { amp: 1, bright: 1700, body: 280, dec: 0.013, weight: 0.65, weightF: 100, metal: 0.3, mf: [600, 3600], mt: [0.002, 0.018] });
  knock(x, r, 0.26, { amp: 0.4, bright: 2800, body: 800, dec: 0.004, metal: 0.3, mf: [1500, 6000], mt: [0.0015, 0.008] });
  lp(x, 8000);
  return M(x, 0.85);
}
/** Arma especial tomada: las abrazaderas del pedestal sueltan con un siseo neumático. */
function specialTaken(r) {
  const x = mono(1.0);
  knock(x, r, 0, { amp: 1, bright: 1500, body: 180, dec: 0.02, weight: 0.9, weightF: 70, metal: 0.4, mf: [400, 3000], mt: [0.003, 0.035] });
  knock(x, r, 0.07, { amp: 0.7, bright: 1700, body: 240, dec: 0.016, weight: 0.6, weightF: 85, metal: 0.4, mf: [500, 3200], mt: [0.003, 0.03] });
  noise(x, r, { at: 0.06, dur: 0.6, type: 'bp', f: curve([[0, 2600], [1, 1300]]), q: 0.8, amp: 0.3, env: (t) => ad(t, 0.01, 0.16) });
  scrape(x, r, 0.25, 0.14, 900, 1300, 0.25, { q: 0.8, grain: 0.85 });
  knock(x, r, 0.42, { amp: 0.7, bright: 1600, body: 260, dec: 0.013, weight: 0.6, weightF: 100, metal: 0.3, mf: [600, 3600], mt: [0.002, 0.018] });
  lp(x, 7500);
  return M(x, 0.8);
}
/**
 * Zumbido del pedestal: un transformador (zumbido de red a 100 Hz con su
 * zumbido rasposo), loop exacto con ciclos enteros sobre L. Sin el brillo de
 * 3.2 kHz que tenía: cerca del pedestal quedaba una banda aguda continua.
 */
function pedestalHum(r) {
  const L = 2.4;
  const x = mono(L + 0.5);
  for (const [k, a] of [[240, 0.35], [480, 0.22], [720, 0.08]]) tone(x, { dur: L + 0.5, f: k / L, amp: a });
  const buzz = mono(L + 0.5);
  noise(buzz, r, { dur: L + 0.5, color: 'pink', type: 'lp', f: 1500, amp: 0.5 });
  // el zumbido raspa al ritmo de la red (100 Hz, rectificado)
  for (let i = 0; i < buzz.length; i++) buzz[i] *= Math.pow(Math.abs(Math.sin((TAU * 120 * i) / (SR * L))), 6);
  mixInto(x, buzz, 0, 1);
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
// el arma sube: siseo hidráulico, el soporte llega arriba y traba (antes:
// campanas de 1318/1975 Hz con la reverb de peine)
function pedestalSpawn(r) {
  const d = 1.1;
  const x = mono(d);
  noise(x, r, { dur: 0.6, type: 'bp', f: curve([[0, 900], [1, 1800]]), q: 0.8, amp: 0.3, env: (t) => win(t / 0.6, 0.3, 0.3) });
  scrape(x, r, 0.05, 0.5, 400, 700, 0.35, { q: 0.9, grain: 0.4 });
  knock(x, r, 0.58, { amp: 1, bright: 1400, body: 170, dec: 0.022, weight: 0.9, weightF: 70, metal: 0.4, mf: [350, 2800], mt: [0.003, 0.04] });
  knock(x, r, 0.68, { amp: 0.5, bright: 2600, body: 700, dec: 0.005, metal: 0.3, mf: [1400, 5500], mt: [0.0015, 0.01] });
  lp(x, 7000);
  return M(x, 0.75);
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

// Un ConvolverNode por mapa en el bus world. Antes cada IR era la reverb
// Freeverb (8 peines + 4 pasatodo de retardo fijo) excitada por un impulso:
// picos estables de hasta 8 dB en la cola (timbre metálico) y agudos de 4 kHz
// que duraban 0.7 del tiempo de los medios, alimentados por cada paso. Ahora
// es ruido con forma (dsp.noiseIR): denso, sin modos, y los agudos mueren
// mucho antes que los medios. Reflexiones tempranas propias del lugar: patio
// de piedra, azoteas abiertas con rebote lejano, calle cañón.
// energy: energía por canal del IR anterior, para que el retorno de sala de
// disparos y explosiones conserve su nivel.
function impulse(r, rts, sec, early, energy) {
  const ir = noiseIR(r, rts, sec);
  for (const [at, g, f] of early) {
    for (let ch = 0; ch < 2; ch++) {
      const e = mono(0.03);
      noise(e, r, { dur: 0.03, type: 'lp', f, amp: 1, env: (t) => ed(t, 0.004) });
      mixInto(ir[ch], e, at * (ch ? 1.07 : 1), g * (ch ? 0.85 : 1));
    }
  }
  for (const c of ir) {
    hp(c, 120);
    lp(c, 5200);
    for (let i = 0; i < Math.min(c.length, 32); i++) c[i] *= i / 32; // sin directo: el seco ya suena
    let e = 0;
    for (let i = 0; i < c.length; i++) e += c[i] * c[i];
    const k = Math.sqrt(energy / Math.max(1e-9, e));
    for (let i = 0; i < c.length; i++) c[i] *= k;
    fadeTail(c, 0.08);
  }
  return ir;
}
function fadeTail(c, sec) {
  const n = Math.min(c.length, len(sec));
  for (let i = 0; i < n; i++) c[c.length - n + i] *= 1 - i / n;
}

export function addWorldSounds(b) {
  // pasos: bus world (sin compresor de combate, nunca duckeado). El facade
  // separa propio / aliado / enemigo con nivel, brillo y prioridad.
  // send: cuánto entra a la cola acústica del mapa (un paso sin nada de sala
  // suena pegado al oído). 0.16 metía en la sala tanta energía como el paso
  // seco: a ritmo de sprint la cola nunca se vaciaba (fondo continuo). 0.08
  // la deja ~7 dB bajo el paso, ya con la cola oscura de noiseIR.
  const S = { bus: 'world', prio: 60, cat: 'step', order: 1, pitchVar: 0.08, dbVar: 1.8, max: 10, gap: 0, group: 'step', send: 0.08 };
  b.add('step_stone', { ...S, gen: stepStone, variants: 8, db: -13 });
  b.add('step_concrete', { ...S, gen: stepConcrete, variants: 8, db: -13 });
  b.add('step_metal', { ...S, gen: stepMetal, variants: 6, db: -14 });
  b.add('step_earth', { ...S, gen: stepEarth, variants: 8, db: -14 });
  b.add('dodge_step', { ...S, gen: dodgeStep, variants: 3, db: -13 });
  b.add('step_scuff', { ...S, gen: scuff, variants: 4, db: -18 });
  b.add('gear', { ...S, gen: gear, variants: 6, db: -24, group: 'gear', max: 3 });
  const P = { bus: 'world', prio: 80, cat: 'foley', order: 2, pitchVar: 0.05, dbVar: 1.5, max: 2, gap: 0.05 };
  b.add('jump', { ...P, gen: jump, variants: 3, db: -15 });
  b.add('land', { ...P, gen: land, variants: 4, db: -5 });
  b.add('slide', { ...P, gen: slideFoley, variants: 3, db: -13 });
  b.add('cover_hit', { ...P, gen: coverHit, variants: 3, db: -5 });
  b.add('dodge_air', { ...P, gen: dodgeAir, variants: 3, db: -12 });
  b.add('dive', { ...P, gen: dive, variants: 3, db: -10 });
  b.add('mantle', { ...P, gen: mantle, variants: 3, db: -12 });
  // agacharse / levantarse / inclinarse (primera persona)
  b.add('cloth', { ...P, gen: cloth, variants: 6, db: -22, max: 2, gap: 0.08, group: 'cloth' });
  b.add('whoosh', { ...P, gen: whoosh, variants: 3, db: -15 });
  // feedback: bus ui, máxima prioridad, nunca robado por el mundo
  const H = { bus: 'ui', prio: 96, cat: 'feedback', order: 1, pitchVar: 0.02, dbVar: 0.5, max: 2 };
  // +14 dB respecto a tercera persona: en primera persona llegan sobre el
  // cuerpo del propio disparo, a medio metro (y lo bajan un instante: hitDuck)
  b.add('hit_tick', { ...H, gen: hitTick, variants: 3, db: 1, gap: 0.03 });
  b.add('hit_head', { ...H, gen: hitHead, variants: 3, db: 1, gap: 0.03 });
  b.add('kill_confirm', { ...H, gen: (r) => killConfirm(r, false), variants: 2, db: -9, gap: 0.05 });
  b.add('kill_head', { ...H, gen: (r) => killConfirm(r, true), variants: 2, db: -9, gap: 0.05 });
  // sin el seno barrido de antes la energía K-ponderada cae ~8 dB: el nivel
  // se repone para que el golpe y el latido se sigan notando (−3 dB vs antes)
  b.add('hurt', { ...H, prio: 90, gen: hurt, variants: 4, db: -5, gap: 0.08, pitchVar: 0.05 });
  b.add('heartbeat', { ...H, prio: 85, gen: heartbeat, variants: 2, db: -6, max: 1, gap: 0.2 });
  b.add('death', { ...H, prio: 99, gen: death, variants: 1, db: -6, order: 3 });
  b.add('respawn', { ...H, gen: respawn, variants: 1, db: -17, order: 3 });
  b.add('prot_end', { ...H, gen: protEnd, variants: 1, db: -21, order: 3 });
  const R = { bus: 'ui', prio: 90, cat: 'pickup', order: 3, pitchVar: 0.02, dbVar: 0.5, max: 1 };
  b.add('crate', { ...R, gen: crate, variants: 1, db: -7 });
  b.add('ammo_pickup', { ...R, gen: ammoPickup, variants: 3, db: -8 });
  b.add('weapon_pickup', { ...R, gen: weaponPickup, variants: 2, db: -7 });
  b.add('special_taken', { ...R, gen: specialTaken, variants: 1, db: -4 });
  // el pedestal es un objeto del mundo: posicional y con cola de sala
  const PD = { bus: 'world', prio: 30, cat: 'pedestal', order: 4, pitchVar: 0, dbVar: 0, send: 0.2 };
  b.add('pedestal_hum', { ...PD, gen: pedestalHum, variants: 1, loop: true, db: -17 });
  b.add('pedestal_hold', { ...PD, bus: 'ui', gen: pedestalHold, variants: 1, loop: true, db: -20, send: 0 });
  b.add('pedestal_spawn', { ...PD, gen: pedestalSpawn, variants: 1, db: -3, max: 1 });
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
  // rt60 por octava (s): medios como antes, agudos mucho más cortos
  b.add('ir_fortaleza', { ...IR, gen: (r) => impulse(r, [[125, 1.3], [250, 1.35], [500, 1.3], [1000, 1.15], [2000, 0.8], [4000, 0.42], [8000, 0.24]], 1.7,
    [[0.021, 0.5, 2000], [0.037, 0.35, 1700], [0.058, 0.25, 1400]], 16.3) });
  b.add('ir_azoteas', { ...IR, gen: (r) => impulse(r, [[125, 0.7], [250, 0.72], [500, 0.7], [1000, 0.6], [2000, 0.42], [4000, 0.25], [8000, 0.15]], 1.0,
    [[0.012, 0.3, 2400], [0.19, 0.28, 1100], [0.33, 0.12, 800]], 21.5) });
  b.add('ir_calle', { ...IR, gen: (r) => impulse(r, [[125, 1.0], [250, 1.05], [500, 1.0], [1000, 0.9], [2000, 0.62], [4000, 0.36], [8000, 0.2]], 1.35,
    [[0.016, 0.4, 2300], [0.045, 0.3, 1900], [0.09, 0.2, 1600], [0.135, 0.12, 1300]], 15.0) });
}

export const IR_OF_MAP = Object.freeze({ fortaleza: 'ir_fortaleza', azoteas: 'ir_azoteas', calle: 'ir_calle' });
