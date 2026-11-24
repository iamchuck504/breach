// Render offline del grafo WebAudio que arma el motor (solo Node: pruebas y
// página de escucha; el juego nunca lo importa). A diferencia del render
// aproximado de check-audio-bank (que suma cada voz con su ganancia inicial),
// aquí se evalúa la AUTOMATIZACIÓN real de cada parámetro (envolventes,
// recortes de cola, duck, filtro del oído, fundidos de stopTag), las
// conexiones con su intervalo de vida, el compresor con ganancia de
// compensación (como el DynamicsCompressor de la especificación) y el
// convolver estéreo. Así la mezcla en primera persona se mide sin oídos con
// lo que de verdad programa src/fx/audio.js.
//
// Uso: const off = createOfflineContext({ sampleRate, decode });
//      globalThis.window = { AudioContext: off.Ctx };  (antes de new Audio())
//      … mover el reloj con ctx.advance(dt) …
//      const [L, R] = renderGraph(ctx, t0, t1, { mute });
// Simplificaciones conocidas: osciladores en silencio (solo los usa el
// sintetizador de respaldo y la cama tonal de ambiente, ~−75 dBFS), el
// detector del compresor es de pico con ataque/liberación exponenciales
// (Chrome usa una curva de liberación adaptativa) y la lectura de buffers es
// lineal.

const BLOCK = 128;
const TAU = Math.PI * 2;

/* --------------------------------------------------------------- AudioParam */

class OParam {
  constructor(ctx, v) { this.ctx = ctx; this.v0 = v; this.ev = []; }
  _add(e) {
    let i = this.ev.length;
    while (i > 0 && this.ev[i - 1].t > e.t) i--;
    this.ev.splice(i, 0, e);
    return this;
  }
  get value() { return this.at(this.ctx.currentTime); }
  set value(v) {
    // asignar .value = setValueAtTime(v, ahora)
    if (!this.ev.length) { this.v0 = v; return; }
    this._add({ k: 's', t: this.ctx.currentTime, v });
  }
  setValueAtTime(v, t) { return this._add({ k: 's', t, v }); }
  linearRampToValueAtTime(v, t) { return this._add({ k: 'l', t, v }); }
  exponentialRampToValueAtTime(v, t) { return this._add({ k: 'e', t, v }); }
  setTargetAtTime(v, t, tau) { return this._add({ k: 'g', t, v, tau }); }
  cancelScheduledValues(t) { this.ev = this.ev.filter((e) => e.t < t); return this; }
  at(t) {
    let mode = 0, cv = this.v0, t0 = 0, tg = 0, tau = 1, tp = 0;
    const val = (x) => (mode === 0 ? cv : tg + (cv - tg) * Math.exp(-(x - t0) / tau));
    for (const e of this.ev) {
      if (e.t > t) {
        if (e.k === 'l' || e.k === 'e') {
          const vp = val(tp), u = (t - tp) / Math.max(1e-9, e.t - tp);
          if (e.k === 'l') return vp + (e.v - vp) * u;
          return vp > 0 && e.v > 0 ? vp * Math.pow(e.v / vp, u) : vp;
        }
        break;
      }
      if (e.k === 'g') { const vs = val(e.t); mode = 1; cv = vs; t0 = e.t; tg = e.v; tau = Math.max(1e-6, e.tau); }
      else { mode = 0; cv = e.v; }
      tp = e.t;
    }
    return val(t);
  }
}

/* ------------------------------------------------------------------- nodos */

let nodeSeq = 0;
class ONode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.ins = []; this.id = ++nodeSeq; this.outs = new Set(); ctx.allNodes++; }
  connect(n) {
    const t = this.ctx.currentTime;
    n.ins.push({ from: this, t0: t, t1: Infinity });
    this.outs.add(n);
    return n;
  }
  disconnect(n) {
    const t = this.ctx.currentTime;
    const close = (dst) => { for (const e of dst.ins) if (e.from === this && e.t1 === Infinity) e.t1 = t; };
    if (n) { close(n); this.outs.delete(n); } else { for (const d of this.outs) close(d); this.outs.clear(); }
  }
}

export class OBuffer {
  constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this.ch = []; }
  copyToChannel(d, i) { this.ch[i] = d; }
  getChannelData(i) { return (this.ch[i] ??= new Float32Array(this.length)); }
}

class OSource extends ONode {
  constructor(ctx, osc = false) {
    super(ctx, osc ? 'osc' : 'src');
    this.playbackRate = new OParam(ctx, 1);
    this.loop = false; this.onended = null; this.startAt = null; this.stopAt = Infinity; this.offset = 0; this.buffer = null;
  }
  start(t = 0, offset = 0, dur = undefined) {
    this.startAt = Math.max(t, this.ctx.currentTime); this.offset = offset || 0;
    if (dur !== undefined) this.stopAt = Math.min(this.stopAt, this.startAt + dur);
    this.ctx.live.add(this);
  }
  stop(t = 0) { this.stopAt = Math.min(this.stopAt, Math.max(t, this.ctx.currentTime)); }
  endTime() {
    if (this.kind === 'osc' || !this.buffer) return this.stopAt;
    if (this.loop) return this.stopAt;
    const rate = this.playbackRate.v0 || 1;
    return Math.min(this.stopAt, (this.startAt ?? 0) + (this.buffer.duration - this.offset) / rate);
  }
}

class Ctx {
  constructor(opts) {
    this.sampleRate = opts.sampleRate; this.currentTime = 0; this.state = 'running';
    this.live = new Set(); this.allNodes = 0; this._decode = opts.decode;
    this.destination = new ONode(this, 'dest');
  }
  createGain() { const n = new ONode(this, 'gain'); n.gain = new OParam(this, 1); return n; }
  createBiquadFilter() {
    const n = new ONode(this, 'biquad'); n.type = 'lowpass';
    n.frequency = new OParam(this, 350); n.Q = new OParam(this, 1); n.gain = new OParam(this, 0); return n;
  }
  createStereoPanner() { const n = new ONode(this, 'pan'); n.pan = new OParam(this, 0); return n; }
  createDynamicsCompressor() {
    const n = new ONode(this, 'comp');
    n.threshold = new OParam(this, -24); n.knee = new OParam(this, 30); n.ratio = new OParam(this, 12);
    n.attack = new OParam(this, 0.003); n.release = new OParam(this, 0.25); n.reduction = 0; return n;
  }
  createWaveShaper() { const n = new ONode(this, 'shaper'); n.curve = null; return n; }
  createConvolver() { const n = new ONode(this, 'conv'); n.normalize = true; n.buffer = null; return n; }
  createOscillator() { const n = new OSource(this, true); n.frequency = new OParam(this, 440); n.type = 'sine'; return n; }
  createBufferSource() { return new OSource(this); }
  createBuffer(ch, len, sr) { return new OBuffer(ch, len, sr); }
  async decodeAudioData(ab) {
    const pcm = this._decode ? this._decode(ab.url) : null;
    const b = new OBuffer(1, pcm ? pcm.length : 4410, this.sampleRate);
    b.ch[0] = pcm ?? new Float32Array(b.length);
    return b;
  }
  resume() { return Promise.resolve(); }
  advance(dt) {
    this.currentTime += dt;
    for (const s of [...this.live]) {
      if (this.currentTime >= s.endTime()) { this.live.delete(s); s.onended?.(); }
    }
  }
}

export function createOfflineContext(opts = {}) {
  const o = { sampleRate: opts.sampleRate ?? 44100, decode: opts.decode ?? null };
  return { Ctx: class extends Ctx { constructor() { super(o); } } };
}

/* ------------------------------------------------------------------- render */

// Coeficientes RBJ de la especificación WebAudio (Q en dB para paso bajo/alto).
function biquadCoef(type, f, Q, sr) {
  const w0 = (TAU * Math.max(10, Math.min(sr * 0.499, f))) / sr, c = Math.cos(w0), s = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass' || type === 'highpass') {
    const alpha = s / (2 * Math.pow(10, Q / 20));
    if (type === 'lowpass') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
  } else {
    const alpha = s / (2 * Math.max(1e-4, Q));
    b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/**
 * Renderiza destination entre t0 y t1 (s). opts.mute(src) → true silencia esa
 * fuente (src._name lo pone la grabación). opts.tap: nodo extra cuya salida
 * también se devuelve (p. ej. un bus). Dos pasadas: la primera junta la
 * entrada del convolver, se convoluciona entera por FFT, la segunda mezcla.
 */
export function renderGraph(ctx, t0, t1, opts = {}) {
  const sr = ctx.sampleRate;
  const N = Math.ceil((t1 - t0) * sr);
  const nb = Math.ceil(N / BLOCK);
  const convs = new Set();
  const seen = new Set();
  (function walk(n) { if (seen.has(n)) return; seen.add(n); if (n.kind === 'conv') convs.add(n); for (const e of n.ins) walk(e.from); })(ctx.destination);
  const convIn = new Map();
  const convOut = new Map();
  for (const c of convs) convIn.set(c, [new Float32Array(N), new Float32Array(N)]);
  let pass = 0;
  const out = [new Float32Array(N), new Float32Array(N)];
  const tapOut = opts.tap ? [new Float32Array(N), new Float32Array(N)] : null;
  for (pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      for (const c of convs) {
        const ir = c.buffer, x = convIn.get(c);
        if (!ir) { convOut.set(c, [new Float32Array(N), new Float32Array(N)]); continue; }
        const h0 = ir.getChannelData(0), h1 = ir.numberOfChannels > 1 ? ir.getChannelData(1) : h0;
        convOut.set(c, [fftConvolve(x[0], h0, N), fftConvolve(x[1], h1, N)]);
      }
    }
    const st = new Map(); // estado por nodo de esta pasada
    for (let b = 0; b < nb; b++) {
      const i0 = b * BLOCK, n = Math.min(BLOCK, N - i0);
      const tb = t0 + i0 / sr;
      const memo = new Map();
      const pull = (node) => {
        const m = memo.get(node);
        if (m) return m;
        const r = proc(node);
        memo.set(node, r);
        return r;
      };
      const sumIns = (node) => {
        let L = null, R = null, mono = true;
        const te = tb + n / sr;
        for (const e of node.ins) {
          if (e.t1 <= tb || e.t0 >= te) continue;
          const r = pull(e.from);
          if (!r) continue;
          if (!L) { L = new Float32Array(n); R = new Float32Array(n); }
          // conexión que abre o cierra dentro del bloque: por muestra
          const a = e.t0 > tb ? Math.max(0, Math.round((e.t0 - tb) * sr)) : 0;
          const z = e.t1 < te ? Math.min(n, Math.round((e.t1 - tb) * sr)) : n;
          for (let i = a; i < z; i++) { L[i] += r.L[i]; R[i] += r.R[i]; }
          if (!r.mono) mono = false;
        }
        return L ? { L, R, mono } : null;
      };
      const S = (node) => { let s = st.get(node); if (!s) st.set(node, (s = {})); return s; };
      const proc = (node) => {
        switch (node.kind) {
          case 'src': {
            const s0 = node.startAt;
            if (s0 === null || !node.buffer) return null;
            if (opts.mute?.(node)) return null;
            const te = tb + n / sr, end = node.endTime();
            if (end <= tb || s0 >= te) return null;
            const buf = node.buffer, ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
            const L = new Float32Array(n), R = ch1 ? new Float32Array(n) : L;
            const k = buf.sampleRate / sr;
            const s = S(node);
            if (s.pos === undefined) { s.pos = node.offset * buf.sampleRate; s.t = s0; }
            const rate = node.playbackRate.at(tb) || 1;
            const len = buf.length;
            for (let i = 0; i < n; i++) {
              const t = tb + i / sr;
              if (t < s0 || t >= end) continue;
              let p = s.pos;
              if (node.loop) p %= len;
              else if (p >= len - 1) { s.pos += rate * k; continue; }
              const j = Math.floor(p), f = p - j, j1 = node.loop ? (j + 1) % len : j + 1;
              L[i] = ch0[j] * (1 - f) + ch0[j1] * f;
              if (ch1) R[i] = ch1[j] * (1 - f) + ch1[j1] * f;
              s.pos += rate * k;
            }
            return { L, R, mono: !ch1 };
          }
          case 'osc': return null;
          case 'gain': {
            const x = sumIns(node);
            if (!x) return null;
            const g0 = node.gain.at(tb), g1 = node.gain.at(tb + n / sr);
            const L = x.L, R = x.R;
            if (Math.abs(g1 - g0) < 1e-7) { for (let i = 0; i < n; i++) { L[i] *= g0; R[i] *= g0; } }
            else {
              // automatización dentro del bloque: por tramos de 16 muestras
              for (let a = 0; a < n; a += 16) {
                const g = node.gain.at(tb + (a + 8) / sr);
                for (let i = a; i < Math.min(n, a + 16); i++) { L[i] *= g; R[i] *= g; }
              }
            }
            return x;
          }
          case 'biquad': {
            const x = sumIns(node);
            const s = S(node);
            if (!x) { s.z = null; return null; }
            const c = biquadCoef(node.type, node.frequency.at(tb), node.Q.at(tb), sr);
            if (!s.z) s.z = [0, 0, 0, 0, 0, 0, 0, 0];
            const z = s.z;
            for (let ch = 0; ch < 2; ch++) {
              const y = ch ? x.R : x.L;
              if (ch && x.mono) break;
              let x1 = z[ch * 4], x2 = z[ch * 4 + 1], y1 = z[ch * 4 + 2], y2 = z[ch * 4 + 3];
              for (let i = 0; i < n; i++) {
                const v = y[i];
                const o = c[0] * v + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
                x2 = x1; x1 = v; y2 = y1; y1 = Math.abs(o) < 1e-25 ? 0 : o; y[i] = y1;
              }
              z[ch * 4] = x1; z[ch * 4 + 1] = x2; z[ch * 4 + 2] = y1; z[ch * 4 + 3] = y2;
            }
            if (x.mono) x.R.set(x.L);
            return x;
          }
          case 'pan': {
            const x = sumIns(node);
            if (!x) return null;
            const p = Math.max(-1, Math.min(1, node.pan.at(tb)));
            const L = new Float32Array(n), R = new Float32Array(n);
            if (x.mono) {
              const u = (p + 1) / 2, gl = Math.cos((u * Math.PI) / 2), gr = Math.sin((u * Math.PI) / 2);
              for (let i = 0; i < n; i++) { L[i] = x.L[i] * gl; R[i] = x.L[i] * gr; }
            } else if (p <= 0) {
              const u = p + 1, gl = Math.cos((u * Math.PI) / 2), gr = Math.sin((u * Math.PI) / 2);
              for (let i = 0; i < n; i++) { L[i] = x.L[i] + x.R[i] * gl; R[i] = x.R[i] * gr; }
            } else {
              const u = p, gl = Math.cos((u * Math.PI) / 2), gr = Math.sin((u * Math.PI) / 2);
              for (let i = 0; i < n; i++) { L[i] = x.L[i] * gl; R[i] = x.R[i] + x.L[i] * gr; }
            }
            return { L, R, mono: false };
          }
          case 'comp': return compressBlock(node, sumIns(node), n, S(node), sr, tb);
          case 'shaper': {
            const x = sumIns(node);
            if (!x || !node.curve) return x;
            const cv = node.curve, m = cv.length - 1;
            for (const y of x.mono ? [x.L] : [x.L, x.R]) for (let i = 0; i < n; i++) {
              const v = Math.max(-1, Math.min(1, y[i])), pos = (v + 1) * 0.5 * m, j = Math.floor(pos), f = pos - j;
              y[i] = cv[j] * (1 - f) + cv[Math.min(m, j + 1)] * f;
            }
            if (x.mono) x.R.set(x.L);
            return x;
          }
          case 'conv': {
            const x = sumIns(node);
            if (pass === 0) {
              if (x) { const buf = convIn.get(node); buf[0].set(x.L, i0); buf[1].set(x.mono ? x.L : x.R, i0); }
              return null;
            }
            const w = convOut.get(node);
            return { L: w[0].slice(i0, i0 + n), R: w[1].slice(i0, i0 + n), mono: false };
          }
          case 'dest': return sumIns(node);
          default: return sumIns(node);
        }
      };
      const r = pull(ctx.destination);
      if (pass === 1 && r) { out[0].set(r.L, i0); out[1].set(r.R, i0); }
      if (pass === 1 && tapOut) { const t = memo.get(opts.tap); if (t) { tapOut[0].set(t.L, i0); tapOut[1].set(t.R, i0); } }
    }
  }
  return tapOut ? { out, tap: tapOut } : out;
}

// DynamicsCompressor (especificación): detector de pico estéreo, curva con
// rodilla, ataque/liberación, 6 ms de anticipación y ganancia de compensación
// (1/fullRangeGain)^0.6. node.reductionTrace guarda la reducción por bloque.
function compressBlock(node, x, n, s, sr, tb) {
  const th = node.threshold.at(tb), kn = node.knee.at(tb), ra = node.ratio.at(tb);
  const at = Math.max(1e-4, node.attack.at(tb)), rl = Math.max(1e-3, node.release.at(tb));
  const curveDb = (xd) => {
    const over = xd - th;
    if (over <= -kn / 2) return xd;
    if (over < kn / 2) return xd - ((over + kn / 2) ** 2 / (2 * Math.max(1e-6, kn))) * (1 - 1 / ra);
    return th + over / ra;
  };
  const makeup = Math.pow(1 / Math.pow(10, curveDb(0) / 20), 0.6);
  const D = Math.round(0.006 * sr);
  if (!s.dl) { s.dl = [new Float32Array(D), new Float32Array(D)]; s.di = 0; s.g = 0; s.trace = []; node.reductionTrace = s.trace; }
  const aA = Math.exp(-1 / (at * sr)), aR = Math.exp(-1 / (rl * sr));
  const L = new Float32Array(n), R = new Float32Array(n);
  let maxRed = 0;
  for (let i = 0; i < n; i++) {
    const xl = x ? x.L[i] : 0, xr = x ? (x.mono ? x.L[i] : x.R[i]) : 0;
    const lv = 20 * Math.log10(Math.max(1e-9, Math.abs(xl), Math.abs(xr)));
    const red = lv - curveDb(lv);
    s.g = red > s.g ? aA * s.g + (1 - aA) * red : aR * s.g + (1 - aR) * red;
    if (s.g > maxRed) maxRed = s.g;
    const k = Math.pow(10, -s.g / 20) * makeup;
    const dl = s.dl, j = s.di;
    L[i] = dl[0][j] * k; R[i] = dl[1][j] * k;
    dl[0][j] = xl; dl[1][j] = xr; s.di = (j + 1) % D;
  }
  s.trace.push(maxRed);
  return { L, R, mono: false };
}

function fftConvolve(x, h, n) {
  let size = 1;
  while (size < x.length + h.length) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(x); br.set(h);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < size; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
  fft(ar, ai, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ar[i] / size;
  return out;
}

export function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/* ----------------------------------------------------------- medidas útiles */

/** Energía por ventanas (ms) de la banda [lo, hi] Hz (SVF de 2º orden). */
export function bandEnvelope(chs, sr, lo, hi, winMs = 10) {
  const W = Math.max(1, Math.round((sr * winMs) / 1000));
  const n = chs[0].length, out = new Float64Array(Math.ceil(n / W));
  for (const x of chs) {
    const y = bandpass(x, sr, lo, hi);
    for (let i = 0; i < n; i++) out[(i / W) | 0] += y[i] * y[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= W * chs.length;
  return out;
}
export function bandpass(x, sr, lo, hi) {
  let y = x;
  if (lo > 0) y = svf(y, sr, lo, 'hp');
  if (hi < sr / 2) y = svf(y, sr, hi, 'lp');
  return y;
}
function svf(x, sr, f, type) {
  const g = Math.tan((Math.PI * f) / sr), k = Math.SQRT2;
  const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
  let ic1 = 0, ic2 = 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v3 = x[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    y[i] = type === 'lp' ? v2 : x[i] - k * v1 - v2;
  }
  return y;
}
