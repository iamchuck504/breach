// Portado tal cual de Crashterra (src/audio/dsp.ts) a JS plano: los scripts de
// verificación en Node importan src/ sin compilar. No editar el DSP aquí sin
// re-medir con scripts/check-audio-bank.mjs.
/**
 * Offline DSP toolkit used to pre-render every CRASHTERRA sound into Float32Arrays.
 * Pure functions over typed arrays: no Web Audio, no allocation inside sample loops.
 * Everything renders at a fixed SR so a sound is identical on every machine.
 */

export const SR = 44100;
/** Every layer fades out over its last EDGE samples so truncated envelopes never click. */
const EDGE = 160;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ rng */

export class R {
  a;
  constructor(seed) {
    this.a = seed >>> 0 || 1;
  }
  next() {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.next();
  }
  /** Symmetric: x * (1 +- amount). */
  vary(x, amount) {
    return x * (1 + (this.next() * 2 - 1) * amount);
  }
  int(a, b) {
    return Math.floor(a + (b - a + 1) * this.next());
  }
  chance(p) {
    return this.next() < p;
  }
  /** White noise sample in [-1, 1). */
  n() {
    return this.next() * 2 - 1;
  }
}

/* -------------------------------------------------------------- buffers */

export const len = (sec, sr = SR) => Math.max(1, Math.round(sec * sr));
export const mono = (sec, sr = SR) => new Float32Array(len(sec, sr));
export const stereo = (sec, sr = SR) => [mono(sec, sr), mono(sec, sr)];

export function peakOf(chs) {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) {
    const v = Math.abs(c[i]);
    if (v > p) p = v;
  }
  return p;
}

export function normalize(chs, peak = 0.95) {
  const p = peakOf(chs);
  if (p > 1e-9) {
    const k = peak / p;
    for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k;
  }
  return chs;
}

export function gain(x, k) {
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

/** out[at..] += src * k */
export function mixInto(out, src, at = 0, k = 1) {
  const o = Math.round(at * SR);
  const n = Math.min(src.length, out.length - o);
  for (let i = Math.max(0, -o); i < n; i++) out[o + i] += src[i] * k;
}

export function fadeIn(x, sec) {
  const n = Math.min(x.length, len(sec));
  for (let i = 0; i < n; i++) x[i] *= i / n;
  return x;
}

export function fadeOut(x, sec) {
  const n = Math.min(x.length, len(sec));
  const s = x.length - n;
  for (let i = 0; i < n; i++) x[s + i] *= 1 - i / n;
  return x;
}

/** Trim trailing near-silence (keeps a tiny fade). */
export function trimTail(chs, thresh = 0.0006) {
  let end = 0;
  for (const c of chs) for (let i = c.length - 1; i > end; i--) if (Math.abs(c[i]) > thresh) { end = i; break; }
  const n = Math.min(chs[0].length, end + len(0.01));
  const out = chs.map((c) => c.slice(0, n));
  for (const c of out) fadeOut(c, Math.min(0.02, n / SR / 4));
  return out;
}

/** Remove DC with a gentle high-pass (20 Hz). */
export function dcBlock(x, fc = 20, sr = SR) {
  const r = Math.exp((-TAU * fc) / sr);
  let xp = 0;
  let yp = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    yp = v - xp + r * yp;
    xp = v;
    x[i] = yp;
  }
  return x;
}

/* ------------------------------------------------------------ shaping */

/** Soft saturation with makeup so small signals keep their level. */
export function sat(x, drive) {
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) * k;
  return x;
}

/** Asymmetric saturation (adds even harmonics, a "chewy" mechanical character). */
export function asat(x, drive, bias = 0.25) {
  const off = Math.tanh(bias * drive);
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = (Math.tanh((x[i] + bias) * drive) - off) * k;
  return dcBlock(x);
}

/** Bit/sample crush for electrical grit. */
export function crush(x, hold, bits) {
  const q = Math.pow(2, bits - 1);
  let h = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) h = Math.round(x[i] * q) / q;
    x[i] = h;
  }
  return x;
}

/* ------------------------------------------------------------- filters */

/** Topology-preserving state variable filter (Simper). Set per sample or per block. */
export class SVF {
  lp = 0;
  bp = 0;
  hp = 0;
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  /** 1/Q: multiply bp by k for a unity-peak band-pass. */
  k = 1;
  lastF = -1;
  lastQ = -1;
  sr;
  constructor(f = 1000, q = 0.707, sr = SR) {
    this.sr = sr;
    this.set(f, q);
  }
  set(f, q) {
    if (f === this.lastF && q === this.lastQ) return;
    this.lastF = f;
    this.lastQ = q;
    const fc = Math.min(Math.max(f, 5), this.sr * 0.49);
    const g = Math.tan((Math.PI * fc) / this.sr);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }
  reset() {
    this.ic1 = this.ic2 = 0;
  }
}

const pv = (p, u) => (typeof p === 'number' ? p : p(u));

/**
 * Filter a whole buffer in place. `f`/`q` may be functions of normalised time u (0..1),
 * evaluated every 16 samples. bp output is gain-normalised (peak 1 at fc).
 */
export function filt(x, type, f, q = 0.707, sr = SR) {
  const s = new SVF(pv(f, 0), pv(q, 0), sr);
  const n = x.length;
  const dyn = typeof f !== 'number' || typeof q !== 'number';
  for (let i = 0; i < n; i++) {
    if (dyn && (i & 15) === 0) {
      const u = i / n;
      s.set(pv(f, u), pv(q, u));
    }
    s.tick(x[i]);
    x[i] = type === 'lp' ? s.lp : type === 'hp' ? s.hp : s.bp * s.k;
  }
  return x;
}

export const lp = (x, f, q = 0.707) => filt(x, 'lp', f, q);
export const hp = (x, f, q = 0.707) => filt(x, 'hp', f, q);
export const bp = (x, f, q = 1) => filt(x, 'bp', f, q);

/** Parallel resonant bank (formants / body modes). Returns a new buffer. */
export function bank(x, bands, shift = 1) {
  const out = new Float32Array(x.length);
  const n = x.length;
  for (const [f, q, g] of bands) {
    const s = new SVF(f, q);
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0 && typeof shift !== 'number') s.set(f * shift(i / n), q);
      else if (i === 0) s.set(f * pv(shift, 0), q);
      s.tick(x[i]);
      out[i] += s.bp * s.k * g;
    }
  }
  return out;
}

/** Feedback comb (metallic resonance). */
export function comb(x, delaySec, fb, mix = 1) {
  const d = Math.max(1, Math.round(delaySec * SR));
  const line = new Float32Array(d);
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] + line[p] * fb;
    line[p] = y;
    p = (p + 1) % d;
    x[i] = x[i] * (1 - mix) + y * mix;
  }
  return x;
}

/* ---------------------------------------------------------- envelopes */

/** Exponential decay envelope value at t with time constant tau. */
export const ed = (t, tau) => Math.exp(-t / tau);

/** Attack-decay: linear-ish attack then exponential decay. */
export const ad = (t, atk, tau) =>
  t < 0 ? 0 : t < atk ? Math.sin((t / atk) * Math.PI * 0.5) : Math.exp(-(t - atk) / tau);

/** Smooth window over [0,1] with attack/release fractions. */
export function win(u, a, r) {
  if (u <= 0 || u >= 1) return 0;
  const x = u < a ? u / a : 1;
  const y = u > 1 - r ? (1 - u) / r : 1;
  return Math.sin(x * Math.PI * 0.5) * Math.sin(y * Math.PI * 0.5);
}

/** Piecewise exponential curve through [t, value] points (t normalised 0..1, values > 0). */
export function curve(pts) {
  return (u) => {
    if (u <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [t1, v1] = pts[i];
      if (u <= t1) {
        const [t0, v0] = pts[i - 1];
        const k = (u - t0) / Math.max(1e-6, t1 - t0);
        return v0 * Math.pow(v1 / v0, k);
      }
    }
    return pts[pts.length - 1][1];
  };
}

/** Linear piecewise curve (for amplitudes that reach 0). */
export function lcurve(pts) {
  return (u) => {
    if (u <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [t1, v1] = pts[i];
      if (u <= t1) {
        const [t0, v0] = pts[i - 1];
        return v0 + (v1 - v0) * ((u - t0) / Math.max(1e-6, t1 - t0));
      }
    }
    return pts[pts.length - 1][1];
  };
}

/* --------------------------------------------------------- generators */

function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** Additive band-limited oscillator rendered into `out`. */
export function tone(out, o) {
  const s0 = Math.round((o.at ?? 0) * SR);
  const n = Math.min(out.length - s0, len(o.dur));
  const wave = o.wave ?? 'sine';
  const amp = o.amp ?? 1;
  let ph = o.phase ?? 0;
  let jit = 0;
  const pw = o.pw ?? 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let f = pv(o.f, i / n);
    if (o.vib) f *= 1 + Math.sin(TAU * o.vib[0] * t) * o.vib[1];
    if (o.jitter && o.rng) {
      jit += (o.rng.n() - jit) * 0.002;
      f *= 1 + jit * o.jitter * 20;
    }
    const dt = f / SR;
    let v;
    switch (wave) {
      case 'sine': v = Math.sin(TAU * ph); break;
      case 'saw': v = 2 * ph - 1 - blep(ph, dt); break;
      case 'square':
      case 'pulse': {
        const w = wave === 'square' ? 0.5 : pw;
        v = (ph < w ? 1 : -1) + blep(ph, dt) - blep((ph + 1 - w) % 1, dt);
        break;
      }
      case 'tri': v = 1 - 4 * Math.abs(ph - 0.5); break;
    }
    const e = (o.env ? o.env(t) : 1) * (i > n - EDGE ? (n - i) / EDGE : 1);
    out[s0 + i] += v * e * amp;
    ph += dt;
    if (ph >= 1) ph -= Math.floor(ph);
  }
  return out;
}

/** Filtered noise layer rendered into `out`. */
export function noise(out, r, o) {
  const s0 = Math.round((o.at ?? 0) * SR);
  const n = Math.min(out.length - s0, len(o.dur));
  if (n <= 0) return out;
  const tmp = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = r.n();
    if (o.color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      tmp[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else if (o.color === 'brown') {
      br = (br + 0.02 * w) / 1.02;
      tmp[i] = br * 3.5;
    } else tmp[i] = w;
  }
  if (o.type && o.f !== undefined) filt(tmp, o.type, o.f, o.q ?? (o.type === 'bp' ? 1 : 0.707));
  const amp = o.amp ?? 1;
  for (let i = 0; i < n; i++) out[s0 + i] += tmp[i] * (o.env ? o.env(i / SR) : 1) * amp * (i > n - EDGE ? (n - i) / EDGE : 1);
  return out;
}

/** Damped sinusoid modes (modal synthesis): metal, chitin, glass, bells. */
export function modes(out, at, list, amp = 1, rng) {
  const s0 = Math.round(at * SR);
  for (const [f, tau, a] of list) {
    const n = Math.min(out.length - s0, len(tau * 7));
    const w = (TAU * f) / SR;
    const ph = rng ? rng.next() * TAU : 0;
    // Recursive oscillator: y[n] = 2cos(w) y[n-1] - y[n-2]
    let y1 = Math.sin(ph - w);
    let y2 = Math.sin(ph - 2 * w);
    const c = 2 * Math.cos(w);
    const dec = Math.exp(-1 / (tau * SR));
    let e = a * amp;
    for (let i = 0; i < n; i++) {
      const y = c * y1 - y2;
      y2 = y1;
      y1 = y;
      out[s0 + i] += y * e;
      e *= dec;
    }
  }
  return out;
}

/** Short random click train (chitin chatter, gear ticks, crackle). */
export function clicks(out, r, at, dur, rate, f, q, amp, decay = 0.0015, env) {
  let t = at;
  const end = at + dur;
  const tmp = new Float32Array(out.length);
  while (t < end) {
    const s = Math.round(t * SR);
    const a = amp * (env ? env((t - at) / dur) : 1) * r.range(0.5, 1);
    const nn = Math.min(tmp.length - s, len(decay * 6));
    for (let i = 0; i < nn; i++) tmp[s + i] += r.n() * a * Math.exp(-i / (decay * SR));
    t += (1 / rate) * r.range(0.35, 1.65);
  }
  bp(tmp, (u) => f * (0.85 + 0.3 * Math.sin(u * 37)), q);
  lp(tmp, Math.min(18000, f * 2.2));
  for (let i = 0; i < out.length; i++) out[i] += tmp[i];
  return out;
}

/* ------------------------------------------------------------- reverb */

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const APS = [556, 441, 341, 225];

/**
 * Freeverb-style stereo room from a mono source. Returns [L, R] of length x.length + tail.
 * `rt` ~ seconds to -60 dB, `damp` 0..1 high damping, `size` scales delay lengths.
 */
export function reverb(x, rt, damp = 0.4, size = 1, tail = 0) {
  const n = x.length + len(tail);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const o = out[ch];
    const spread = ch * 23;
    for (const c of COMBS) {
      const d = Math.round((c + spread) * size * (SR / 44100));
      const fb = Math.pow(10, (-3 * d) / (rt * SR));
      const line = new Float32Array(d);
      let p = 0;
      let store = 0;
      for (let i = 0; i < n; i++) {
        const y = line[p];
        store = y * (1 - damp) + store * damp;
        line[p] = (i < x.length ? x[i] : 0) + store * fb;
        p = p + 1 === d ? 0 : p + 1;
        o[i] += y;
      }
    }
    for (const a of APS) {
      const d = Math.round((a + spread) * size * (SR / 44100));
      const line = new Float32Array(d);
      let p = 0;
      for (let i = 0; i < n; i++) {
        const b = line[p];
        const v = o[i];
        line[p] = v + b * 0.5;
        o[i] = b - v;
        p = p + 1 === d ? 0 : p + 1;
      }
    }
    gain(o, 0.12);
  }
  return out;
}

/** Mono dry + stereo wet. */
export function withRoom(dry, wet, rt, damp = 0.45, size = 1, tail = rt) {
  const r = reverb(dry, rt, damp, size, tail);
  for (let ch = 0; ch < 2; ch++) {
    const o = r[ch];
    for (let i = 0; i < o.length; i++) o[i] = o[i] * wet + (i < dry.length ? dry[i] : 0);
  }
  return r;
}

/** Copy mono to two channels with a tiny Haas offset for width. */
export function widen(x, ms = 0.35, sideGain = 0.9) {
  const d = len(ms / 1000);
  const L = x.slice();
  const Rr = new Float32Array(x.length);
  for (let i = d; i < x.length; i++) Rr[i] = x[i - d] * sideGain + x[i] * (1 - sideGain);
  return [L, Rr];
}

/**
 * Make a seamlessly looping buffer from `src` (which must be at least loopSec + xf long):
 * the overhang past the loop end is crossfaded (equal power) onto the head, so
 * sample n-1 flows straight into sample 0.
 */
export function loopify(src, loopSec, xf) {
  const n = len(loopSec);
  const m = Math.min(len(xf), src.length - n, n);
  const out = src.slice(0, n);
  for (let i = 0; i < m; i++) {
    const k = i / m;
    out[i] = src[n + i] * Math.cos(k * Math.PI * 0.5) + src[i] * Math.sin(k * Math.PI * 0.5);
  }
  return out;
}

/* --------------------------------------------------------------- vocal */

/** Source-filter creature voice: glottal pulse + breath -> formant bank. */
export function vocal(out, r, o) {
  const s0 = Math.round((o.at ?? 0) * SR);
  const n = Math.min(out.length - s0, len(o.dur));
  if (n <= 0) return out;
  const src = new Float32Array(n);
  const subBuf = new Float32Array(n);
  let ph = 0;
  let ph2 = 0;
  let jit = 0;
  let jitT = 0;
  const pw = o.pw ?? 0.3;
  const breath = o.breath ?? 0.15;
  const rough = o.rough ?? 0;
  const rr = o.roughRatio ?? 0.5;
  let rph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if (o.jitter) {
      jitT += (r.n() - jitT) * 0.01;
      jit += (jitT - jit) * 0.01;
    }
    const f = o.f0(u) * (1 + jit * (o.jitter ?? 0) * 6);
    const dt = f / SR;
    // band-limited pulse: saw minus delayed saw
    const s1 = 2 * ph - 1 - blep(ph, dt);
    let p2 = ph + pw;
    if (p2 >= 1) p2 -= 1;
    const s2 = 2 * p2 - 1 - blep(p2, dt);
    let v = (s1 - s2) * 0.5;
    if (rough > 0) {
      rph += (f * rr) / SR;
      if (rph >= 1) rph -= 1;
      v *= 1 - rough * (0.5 + 0.5 * Math.sin(TAU * rph));
    }
    const a = o.amp(u);
    src[i] = (v * (1 - breath) + r.n() * breath * 0.7) * a;
    if (o.sub) subBuf[i] = Math.sin(TAU * ph2) * a * o.sub;
    ph += dt;
    if (ph >= 1) ph -= 1;
    ph2 += dt * 0.5;
    if (ph2 >= 1) ph2 -= 1;
  }
  const shaped = bank(src, o.formants, o.shift ?? 1);
  for (let i = 0; i < n; i++) out[s0 + i] += shaped[i] + subBuf[i];
  return out;
}

/** FM operator pair: carrier f, modulator ratio and index contours. */
export function fm(out, o) {
  const s0 = Math.round((o.at ?? 0) * SR);
  const n = Math.min(out.length - s0, len(o.dur));
  let pc = 0;
  let pm = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = o.f(u);
    pm += (f * o.ratio) / SR;
    const m = Math.sin(TAU * pm + last * (o.fb ?? 0)) * o.index(u);
    last = m;
    pc += f / SR;
    out[s0 + i] += Math.sin(TAU * pc + m) * o.amp(u) * (i > n - EDGE ? (n - i) / EDGE : 1);
    if (pc > 1e6) pc -= 1e6;
    if (pm > 1e6) pm -= 1e6;
  }
  return out;
}
