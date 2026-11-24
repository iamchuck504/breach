// Portado tal cual de Crashterra (src/audio/analysis.ts) a JS plano: los scripts de
// verificación en Node importan src/ sin compilar. No editar el DSP aquí sin
// re-medir con scripts/check-audio-bank.mjs.
/**
 * Measurement helpers for balancing (used by the showcase table and the offline lab).
 * LUFS-ish: BS.1770 K-weighting, 400 ms momentary windows, max over the sound,
 * channels summed in power. Centroid: magnitude-weighted mean frequency.
 */
import { SR } from './dsp.js';

const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

/** BS.1770 K-weighting coefficients derived for an arbitrary rate. */
function kweight(sr) {
  // stage 1: high shelf
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const b1 = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0];
  const a1 = [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // stage 2: high pass
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const b2 = [1, -2, 1];
  const a2 = [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [b1, a1, b2, a2];
}

function biquad(x, b, a) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b[0] * v + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    y[i] = o;
  }
  return y;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export function centroidOf(x, sr = SR) {
  const N = 2048;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let num = 0;
  let den = 0;
  let pn = 0;
  let pd = 0;
  for (let s = 0; s + N <= Math.max(N, x.length); s += N / 2) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = (x[s + i] ?? 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    // per-frame magnitude centroid, averaged with frame-energy weights
    let fn = 0, fd = 0, e = 0;
    for (let k = 1; k < N / 2; k++) {
      const p2 = re[k] * re[k] + im[k] * im[k];
      const m = Math.sqrt(p2);
      fn += m * ((k * sr) / N);
      fd += m;
      e += p2;
      pn += p2 * ((k * sr) / N);
      pd += p2;
    }
    if (fd > 0) {
      num += (fn / fd) * e;
      den += e;
    }
  }
  return [den > 0 ? num / den : 0, pd > 0 ? pn / pd : 0];
}

export function measure(ch, gain = 1, sr = SR) {
  const n = ch[0].length;
  const monoMix = new Float32Array(n);
  let peak = 0;
  for (const c of ch) for (let i = 0; i < n; i++) {
    const v = c[i] * gain;
    monoMix[i] += v / ch.length;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // duration to -60 dB of peak
  let end = 0;
  const th = peak * 0.001;
  for (let i = n - 1; i >= 0; i--) if (Math.abs(monoMix[i]) > th) { end = i; break; }
  // rms over the audible part
  const th40 = peak * 0.01;
  let sum = 0;
  let cnt = 0;
  const win = Math.round(sr * 0.01);
  for (let s = 0; s < n; s += win) {
    let e = 0;
    let m = 0;
    for (let i = s; i < Math.min(n, s + win); i++) { e += monoMix[i] * monoMix[i]; m = Math.max(m, Math.abs(monoMix[i])); }
    if (m > th40) { sum += e; cnt += Math.min(win, n - s); }
  }
  const rms = cnt ? Math.sqrt(sum / cnt) : 0;
  // momentary K-weighted loudness, 400 ms windows, 100 ms hop (zero-padded for short sounds)
  const [b1, a1, b2, a2] = kweight(sr);
  const W = Math.round(sr * 0.4);
  const H = Math.round(sr * 0.1);
  let lmax = -120;
  const kw = ch.map((c) => {
    const x = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) x[i] = c[i] * gain;
    return biquad(biquad(x, b1, a1), b2, a2);
  });
  for (let s = 0; s < Math.max(1, n - W + H); s += H) {
    let z = 0;
    for (const k of kw) {
      let e = 0;
      for (let i = s; i < Math.min(n, s + W); i++) e += k[i] * k[i];
      z += e / W;
    }
    // mono content is reproduced on both speakers: count it twice like a stereo file
    if (ch.length === 1) z *= 2;
    const l = -0.691 + 10 * Math.log10(Math.max(1e-12, z));
    if (l > lmax) lmax = l;
  }
  const [centroid, ecentroid] = centroidOf(monoMix, sr);
  return { dur: end / sr, peakDb: db(peak), rmsDb: db(rms), lufsMax: lmax, centroid, ecentroid };
}

/* -------------------------------------------- timbre (añadido para Breach) */
// "¿Es una nota?" sin oídos: cuánta energía cae en el parcial estrecho más
// fuerte y cuánto tarda en caer 20 dB. Un objeto (cargador, cerrojo, bota) da
// ~0; un seno o 3–4 modos largos (marimba, tambor) dan 0.2–0.8 con 50–300 ms.
// Lo usa scripts/check-audio-bank.mjs como compuerta; mismo método que
// run3/audio/medir.mjs del overhaul.

const TAU2 = Math.PI * 2;
function powerSpec(x, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(x.subarray(0, Math.min(N, x.length)));
  fft(re, im);
  const P = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  return P;
}
function medianAround(S, hz, k, oct) {
  const f = k * hz;
  const a = Math.max(1, Math.floor((f * Math.pow(2, -oct)) / hz));
  const b = Math.min(S.length - 1, Math.ceil((f * Math.pow(2, oct)) / hz));
  const step = Math.max(1, Math.floor((b - a) / 200));
  const v = [];
  for (let i = a; i <= b; i += step) v.push(S[i]);
  v.sort((p, q) => p - q);
  return v[v.length >> 1] || 1e-20;
}
/** Pico estrecho más fuerte (suavizado ±2 bins) con prominencia ≥ minProm dB sobre la mediana de 1/3 oct. */
function strongestPeak(P, hz, lo, hi, minProm) {
  const S = new Float64Array(P.length);
  for (let k = 2; k < P.length - 2; k++) S[k] = (P[k - 2] + P[k - 1] + P[k] + P[k + 1] + P[k + 2]) / 5;
  const guard = Math.max(2, Math.round(12 / hz));
  let best = null;
  for (let k = Math.ceil(lo / hz); k <= Math.min(P.length - 3 - guard, Math.floor(hi / hz)); k++) {
    if (S[k] <= 0 || (best && S[k] <= best.p)) continue;
    let isMax = true;
    for (let j = 1; j <= guard && isMax; j++) if (S[k - j] > S[k] || S[k + j] > S[k]) isMax = false;
    if (!isMax) continue;
    const prom = 10 * Math.log10(S[k] / medianAround(S, hz, k, 1 / 3));
    if (prom >= minProm) best = { k, f: k * hz, p: S[k], prom };
  }
  return best;
}
function ringAt(x, f, sr) {
  const N = 1024, H = 64;
  const k = Math.round((f * N) / sr);
  const re = new Float64Array(N), im = new Float64Array(N);
  const lev = [];
  for (let s = -N / 2; s < x.length; s += H) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) { const j = s + i; re[i] = j >= 0 && j < x.length ? x[j] * (0.5 - 0.5 * Math.cos((TAU2 * i) / N)) : 0; }
    fft(re, im);
    let m = 0;
    for (let j = Math.max(1, k - 1); j <= Math.min(N / 2 - 1, k + 1); j++) m = Math.max(m, re[j] * re[j] + im[j] * im[j]);
    lev.push(m);
  }
  let imax = 0;
  for (let i = 1; i < lev.length; i++) if (lev[i] > lev[imax]) imax = i;
  let last = imax;
  for (let i = imax; i < lev.length; i++) if (lev[i] >= lev[imax] * 0.01) last = i;
  return ((last - imax) * H * 1000) / sr;
}

function tonalOfSpectrum(P, hz, x, sr, from = 0) {
  let tot = 0;
  for (let k = 1; k < P.length; k++) tot += P[k];
  const pk = strongestPeak(P, hz, 60, 16000, 10);
  if (!pk || tot <= 0) return { domHz: 0, domFrac: 0, ringMs: 0, note: 0 };
  const w = Math.max(15, 0.01 * pk.f);
  let e = 0, nb = 0;
  for (let k = Math.max(0, Math.floor((pk.f - w) / hz)); k <= Math.min(P.length - 1, Math.ceil((pk.f + w) / hz)); k++) { e += P[k]; nb++; }
  // solo lo que sobresale del continuo vecino (mediana de 1/3 oct): un ruido
  // oscuro y estrecho no es un parcial; un tono sí sobresale casi entero
  const domFrac = Math.max(0, e - medianAround(P, hz, pk.k, 1 / 3) * nb) / tot;
  // el anillo se mide desde la ventana: un tono tardío no hereda el máximo del ruido anterior
  const ringMs = ringAt(from ? x.subarray(from) : x, pk.f, sr);
  return { domHz: Math.round(pk.f), domFrac, ringMs, note: (domFrac * Math.max(0, ringMs - 25)) / 10 };
}

/**
 * { domHz, domFrac, ringMs, note } de un sonido mono. note = domFrac·max(0, ring−25 ms)/10.
 * Espectro del sonido entero (hasta 3 s) y, además, ventanas solapadas de
 * 0.74 s a lo largo de TODO el clip: un tono que solo aparece al final de un
 * clip largo también cuenta. Se ignoran ventanas 20 dB por debajo de la más
 * fuerte (colas donde cualquier resto parece "dominar"). Devuelve el peor.
 */
export function tonality(x, sr = SR) {
  let N = 16384;
  while (N < x.length && N < 131072) N <<= 1;
  let worst = tonalOfSpectrum(powerSpec(x, N), sr / N, x, sr);
  const W = 32768, H = W / 2;
  if (x.length > W) {
    const wins = [];
    for (let s = 0; s < x.length; s += H) {
      const seg = new Float32Array(W);
      let e = 0;
      for (let i = 0; i < W && s + i < x.length; i++) { const v = x[s + i] * (0.5 - 0.5 * Math.cos((TAU2 * i) / W)); seg[i] = v; e += v * v; }
      wins.push({ seg, e, s });
      if (s + W >= x.length) break;
    }
    const emax = Math.max(...wins.map((w) => w.e));
    // Se analiza una ventana si está a menos de 20 dB de la más fuerte O si
    // por sí sola es audible: RMS ≥ −45 dBFS en el PCM del banco. El banco
    // normaliza cada sonido a pico ≈ −1 dBFS y lo reproduce a −2..−24 dB
    // (def.db): −45 dBFS de PCM llega a ≈ −55 dBFS con un nivel típico de
    // −10 dB, por encima del ambiente (~−60 dBFS) y audible con auriculares en
    // un momento tranquilo. Más abajo solo hay colas que el ruido de la
    // partida tapa.
    const floor = W * Math.pow(10, -45 / 10);
    let frac = worst;
    for (const w of wins) {
      if (w.e < emax * 0.01 && w.e < floor) continue;
      const t = tonalOfSpectrum(powerSpec(w.seg, W), sr / W, x, sr, w.s);
      if (t.note > worst.note) worst = t;
      if (t.domFrac > frac.domFrac) frac = t;
    }
    // la peor nota y la mayor concentración pueden venir de ventanas distintas
    if (frac.domFrac > worst.domFrac) worst = { ...worst, domFrac: frac.domFrac, domHz: frac.domHz };
  }
  return worst;
}

/** Espectro medio (Welch 4096): fracción de energía ≥ f Hz y pico estrecho persistente más prominente (dB). */
export function longTerm(x, sr = SR) {
  const N = 4096, H = 2048;
  const P = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += H) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((TAU2 * i) / N));
    fft(re, im);
    for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k];
  }
  const hz = sr / N;
  let tot = 0;
  for (let k = 1; k < N / 2; k++) tot += P[k];
  const above = (f) => { let e = 0; for (let k = Math.ceil(f / hz); k < N / 2; k++) e += P[k]; return e / Math.max(1e-30, tot); };
  // pico persistente con resolución fina (16384, Welch)
  const M = 16384;
  const Q = new Float64Array(M / 2);
  const r2 = new Float64Array(M), i2 = new Float64Array(M);
  for (let s = 0; s + M <= x.length; s += M / 2) {
    r2.fill(0); i2.fill(0);
    for (let i = 0; i < M; i++) r2[i] = x[s + i] * (0.5 - 0.5 * Math.cos((TAU2 * i) / M));
    fft(r2, i2);
    for (let k = 0; k < M / 2; k++) Q[k] += r2[k] * r2[k] + i2[k] * i2[k];
  }
  // el pico más PROMINENTE (no el más fuerte): un tono que asoma sobre su entorno
  const qh = sr / M;
  const S = new Float64Array(Q.length);
  for (let k = 2; k < Q.length - 2; k++) S[k] = (Q[k - 2] + Q[k - 1] + Q[k] + Q[k + 1] + Q[k + 2]) / 5;
  let peakDb = 0, peakHz = 0;
  const guard = Math.max(2, Math.round(12 / qh));
  for (let k = Math.ceil(100 / qh); k <= Math.floor(14000 / qh); k++) {
    let isMax = S[k] > 0;
    for (let j = 1; j <= guard && isMax; j++) if (S[k - j] > S[k] || S[k + j] > S[k]) isMax = false;
    if (!isMax) continue;
    const prom = 10 * Math.log10(S[k] / medianAround(S, qh, k, 1 / 3));
    if (prom > peakDb) { peakDb = prom; peakHz = Math.round(k * qh); }
  }
  return { above, peakDb, peakHz };
}

/** rt60 (s) de la banda de octava fc de un IR mono (STFT + integración de Schroeder, −5..−25 dB). */
export function rt60Band(x, fc, sr = SR) {
  const N = 1024, H = 128;
  const k0 = Math.ceil(((fc / Math.SQRT2) * N) / sr), k1 = Math.floor(((fc * Math.SQRT2) * N) / sr);
  const re = new Float64Array(N), im = new Float64Array(N);
  const e = [];
  for (let s = 0; s + N <= x.length; s += H) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((TAU2 * i) / N));
    fft(re, im);
    let a = 0;
    for (let k = k0; k <= k1; k++) a += re[k] * re[k] + im[k] * im[k];
    e.push(a);
  }
  let acc = 0;
  const E = new Float64Array(e.length);
  for (let i = e.length - 1; i >= 0; i--) { acc += e[i]; E[i] = acc; }
  let i5 = -1, i25 = -1;
  for (let i = 0; i < E.length; i++) {
    const L = 10 * Math.log10(Math.max(1e-30, E[i] / E[0]));
    if (i5 < 0 && L <= -5) i5 = i;
    if (L <= -25) { i25 = i; break; }
  }
  return i5 < 0 || i25 < 0 ? null : (((i25 - i5) * H) / sr) * 3;
}
