// Audio 100% procedural con WebAudio (sin assets). M = mute.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem('breach.muted') === 'true';
    this._noise = null;
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

  lancer() { this._noiseShot(0.5, 0.09, 3200, 900); this._tone('square', 190, 90, 0.12, 0.06); }
  gnasher() { this._noiseShot(0.85, 0.28, 1600, 220, 2); this._tone('sine', 130, 45, 0.55, 0.22); }
  reload() { this._tone('square', 700, 500, 0.07, 0.04); }
  reloadDone() { this._tone('square', 900, 1200, 0.08, 0.05); }
  hit() { this._tone('sine', 1150, 900, 0.14, 0.045); }
  kill() { this._tone('sine', 500, 150, 0.3, 0.25); this._noiseShot(0.2, 0.2, 900, 200); }
  whoosh() { this._noiseShot(0.22, 0.16, 500, 2400, 0.6); }
  thump() { this._tone('sine', 110, 55, 0.4, 0.11); this._noiseShot(0.12, 0.07, 500, 150); }
  footstep() { this._noiseShot(0.05, 0.045, 700, 250); }
  hurt() { this._tone('sawtooth', 220, 90, 0.2, 0.12); }
  death() { this._tone('sawtooth', 320, 60, 0.35, 0.5); }
  win() { for (const [f, d] of [[520, 0], [660, 0.12], [780, 0.24]]) setTimeout(() => this._tone('sine', f, f, 0.25, 0.3), d * 1000); }
}
