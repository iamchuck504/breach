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
