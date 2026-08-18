// Audio WebAudio: sintético procedural + samples de armas (public/audio).
// Las armas usan UN sample por disparo — a 620 RPM el uzi suena exactamente
// al rate of fire real porque cada bala dispara su propia reproducción.
// M = mute.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem('breach.muted') === 'true';
    this._noise = null;
    this.samples = {};
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 1;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
    this._loadSamples();
  }

  // Samples de armas (mejor esfuerzo): si no cargan, queda el sintético.
  _loadSamples() {
    if (this._samplesReq) return;
    this._samplesReq = true;
    for (const [k, url] of [['smg', 'audio/smg.mp3'], ['shotgun', 'audio/shotgun.mp3']]) {
      fetch(url)
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { this.samples[k] = buf; })
        .catch(() => { /* sin sample: fallback sintético */ });
    }
  }

  // true si el sample sonó; rate con leve variación evita el efecto metralla
  // de fotocopia (mismo golpe idéntico 10 veces por segundo)
  _sample(k, gain, rate = 1) {
    const buf = this.samples[k];
    if (!buf || !this.ctx) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start(this.ctx.currentTime);
    return true;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('breach.muted', String(this.muted));
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  _env(gainNode, t0, a, peak, dec) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
  }

  _noiseShot(peak, dec, freq0, freq1, q = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.Q.value = q;
    f.frequency.setValueAtTime(freq0, t);
    f.frequency.exponentialRampToValueAtTime(freq1, t + dec);
    const g = this.ctx.createGain();
    this._env(g, t, 0.004, peak, dec);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dec + 0.05);
  }

  _tone(type, f0, f1, peak, dec) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dec);
    const g = this.ctx.createGain();
    this._env(g, t, 0.004, peak, dec);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dec + 0.05);
  }

  // ---------- pasos ----------
  // Paso sobre losa de piedra: golpe de talón (banda media) + toque de punta
  // más agudo un instante después + "tick" de suela dura + golpe de peso en
  // los pesados. Jitter aleatorio por paso: ningún paso suena igual al
  // anterior. pan (-1..1) y vol permiten pasos POSICIONALES de bots/remotos.
  footstep(kind = 'run', vol = 1, pan = 0) {
    if (!this.ctx || vol <= 0.01) return;
    const P = STEP_KINDS[kind] ?? STEP_KINDS.run;
    const out = this.ctx.createGain();
    out.gain.value = vol;
    if (pan && this.ctx.createStereoPanner) {
      const sp = this.ctx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, pan));
      out.connect(sp);
      sp.connect(this.master);
    } else {
      out.connect(this.master);
    }
    const j = (a, b) => a + Math.random() * (b - a);
    const f = P.f * j(0.85, 1.2);
    this._stepBurst(out, 0, P.heel, j(0.035, 0.05), f, 1.4);                                   // talón
    if (P.toe) this._stepBurst(out, j(0.055, 0.085), P.toe * j(0.7, 1.1), j(0.025, 0.04), f * j(1.7, 2.2), 1.8); // punta
    if (P.tick) this._stepBurst(out, j(0, 0.008), P.tick, 0.012, j(2600, 4200), 3);            // suela dura
    if (P.thump) {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(j(70, 95), t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.08);
      const g = this.ctx.createGain();
      this._env(g, t, 0.004, P.thump, kind === 'land' ? 0.1 : 0.06);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 0.25);
    }
    // aterrizaje: el segundo pie cae un instante después
    if (kind === 'land') this._stepBurst(out, j(0.07, 0.1), 0.14, 0.04, f * 1.3, 1.4);
  }

  _stepBurst(dest, delay, peak, dec, freq, q) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = q;
    filt.frequency.value = freq;
    const g = this.ctx.createGain();
    this._env(g, t, 0.003, peak, dec);
    src.connect(filt).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5); // offset aleatorio: textura distinta por paso
    src.stop(t + dec + 0.06);
  }

  // ambos samples normalizados a pico 0dB: el balance vive en estas ganancias
  // (bajadas 40% a pedido de Chuck: 0.75→0.45, 0.85→0.51)
  smg() {
    if (this._sample('smg', 0.45, 0.97 + Math.random() * 0.06)) return;
    this._noiseShot(0.5, 0.09, 3200, 900); this._tone('square', 190, 90, 0.12, 0.06);
  }
  shotgun() {
    if (this._sample('shotgun', 0.51, 0.98 + Math.random() * 0.04)) return;
    this._noiseShot(0.85, 0.28, 1600, 220, 2); this._tone('sine', 130, 45, 0.55, 0.22);
  }
  reload() { this._tone('square', 700, 500, 0.07, 0.04); }
  reloadDone() { this._tone('square', 900, 1200, 0.08, 0.05); }
  hit() { this._tone('sine', 1150, 900, 0.14, 0.045); }
  kill() { this._tone('sine', 500, 150, 0.3, 0.25); this._noiseShot(0.2, 0.2, 900, 200); }
  whoosh() { this._noiseShot(0.22, 0.16, 500, 2400, 0.6); }
  thump() { this._tone('sine', 110, 55, 0.4, 0.11); this._noiseShot(0.12, 0.07, 500, 150); }
  jump() { this.footstep('jump'); this._noiseShot(0.1, 0.09, 800, 2300, 0.6); }
  land() { this.footstep('land'); }
  hurt() { this._tone('sawtooth', 220, 90, 0.2, 0.12); }
  death() { this._tone('sawtooth', 320, 60, 0.35, 0.5); }
  win() { for (const [f, d] of [[520, 0], [660, 0.12], [780, 0.24]]) setTimeout(() => this._tone('sine', f, f, 0.25, 0.3), d * 1000); }
}

// parámetros por tipo de paso (ganancias de talón/punta/peso/tick + freq base)
const STEP_KINDS = {
  walk:    { heel: 0.11, toe: 0.06, thump: 0.03, tick: 0.02,  f: 520 },
  run:     { heel: 0.17, toe: 0.09, thump: 0.06, tick: 0.035, f: 470 },
  roadie:  { heel: 0.24, toe: 0.11, thump: 0.12, tick: 0.045, f: 420 },
  shuffle: { heel: 0.08, toe: 0.07, thump: 0,    tick: 0.02,  f: 680 },
  jump:    { heel: 0.12, toe: 0,    thump: 0,    tick: 0.03,  f: 750 },
  land:    { heel: 0.3,  toe: 0.16, thump: 0.24, tick: 0.05,  f: 330 },
};
