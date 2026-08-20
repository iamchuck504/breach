// Audio WebAudio: sintético procedural + samples de armas (public/audio).
// La mezcla separa eventos locales/UI de fuentes del mundo. Estas últimas
// comparten una curva espacial coherente: distancia 3D, paneo, pérdida gradual
// de agudos y oclusión por geometría. M = mute.

export const AUDIO_PROFILES = Object.freeze({
  footstep: Object.freeze({ near: 1.6, far: 26, rolloff: 0.16, farHz: 3200,
    occludedGain: 0.62, occludedHz: 1450 }),
  gunshot: Object.freeze({ near: 2.4, far: 82, rolloff: 0.09, farHz: 2600,
    occludedGain: 0.48, occludedHz: 1850 }),
  impact: Object.freeze({ near: 1.2, far: 30, rolloff: 0.16, farHz: 2300,
    occludedGain: 0.5, occludedHz: 1300 }),
});

export const AMBIENCE_PROFILES = Object.freeze({
  fortaleza: Object.freeze({ continuousNoise: true, gain: 0.016 }),
  azoteas: Object.freeze({ continuousNoise: false, gain: 0.014, pulseMinMs: 4800 }),
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Selección pura de referencia: permite verificar que spectator nunca vuelva
// a heredar accidentalmente la posición del cadáver local.
export function selectAudioListener(spectating, cameraPose, playerPose) {
  return spectating ? cameraPose : playerPose;
}

// Función pura para poder verificar la mezcla sin depender de WebAudio.
export function spatialAudioMix(distance, lateral = 0, occluded = false,
  profileName = 'gunshot') {
  const p = AUDIO_PROFILES[profileName] ?? AUDIO_PROFILES.gunshot;
  const d = Math.max(0, Number.isFinite(distance) ? distance : p.far);
  if (d >= p.far) return { gain: 0, pan: clamp01((lateral + 1) * 0.5) * 2 - 1,
    cutoff: p.farHz, distance: d, occluded };
  const delta = Math.max(0, d - p.near);
  const inverse = 1 / (1 + delta * p.rolloff);
  // Los últimos 25% se desvanecen suavemente hasta silencio, sin corte seco.
  const edge = clamp01((p.far - d) / (p.far * 0.25));
  let gain = inverse * Math.sqrt(edge);
  const t = clamp01((d - p.near) / (p.far - p.near));
  let cutoff = 19000 * Math.pow(p.farHz / 19000, t);
  if (occluded) {
    gain *= p.occludedGain;
    cutoff = Math.min(cutoff, p.occludedHz);
  }
  return {
    gain,
    pan: Math.max(-0.92, Math.min(0.92, lateral)),
    cutoff,
    distance: d,
    occluded,
  };
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem('breach.muted') === 'true';
    const v = parseFloat(localStorage.getItem('breach.volume'));
    this.volume = v >= 0 && v <= 1 ? v : 0.5; // volumen general (slider)
    this._noise = null;
    this.samples = {};
    this._samplesReady = null;
    this._prepared = false;
    this._listener = null;
    this._occluded = null;
    this.combatBus = null;
    this.worldBus = null;
    this._impactWindow = 0;
    this._impactCount = 0;
    this._ambienceName = null;
    this._ambienceNodes = null;
  }

  // Los callbacks viven en main para que Audio no dependa de Three.js/World.
  setSpatialContext(listener, occluded = null) {
    this._listener = listener;
    this._occluded = occluded;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    localStorage.setItem('breach.volume', String(this.volume));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
      // Los picos de varias armas simultáneas se controlan aquí; pasos y UI no
      // quedan enterrados por el compresor del bus de combate.
      this.combatBus = this.ctx.createGain();
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 14;
      limiter.ratio.value = 5;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.16;
      this.combatBus.connect(limiter).connect(this.master);
      this.worldBus = this.ctx.createGain();
      this.worldBus.gain.value = 1;
      this.worldBus.connect(this.master);
      const len = this.ctx.sampleRate * 1;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf;
      this._samplesReady = this._loadSamples();
      if (this._ambienceName) this._startAmbience(this._ambienceName);
    }
    const resumed = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    return Promise.all([resumed, this._samplesReady || Promise.resolve()]);
  }

  // Samples de armas (mejor esfuerzo): si no cargan, queda el sintético.
  _loadSamples() {
    if (this._samplesReq) return this._samplesReady || Promise.resolve();
    this._samplesReq = true;
    const jobs = [];
    for (const [k, url] of [['smg', 'audio/smg.mp3'], ['shotgun', 'audio/shotgun.mp3']]) {
      jobs.push(fetch(url)
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { this.samples[k] = buf; })
        .catch(() => { /* sin sample: fallback sintético */ }));
    }
    return Promise.all(jobs);
  }

  // Se llama desde el gesto de ENTRAR: desbloquea WebAudio, espera los dos
  // samples y ejercita silenciosamente los nodos usados durante gameplay.
  // Así el primer disparo/pickup no paga inicialización del motor de audio.
  async prepare() {
    await this.ensure();
    if (this._prepared || !this.ctx) return;
    this._prepared = true;
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    silent.connect(this.master);
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const filter = this.ctx.createBiquadFilter();
    const osc = this.ctx.createOscillator();
    const pan = this.ctx.createStereoPanner?.();
    src.connect(filter).connect(silent);
    osc.connect(pan || silent);
    if (pan) pan.connect(silent);
    src.start(t, 0, 0.002);
    osc.start(t); osc.stop(t + 0.002);
    await new Promise((resolve) => setTimeout(resolve, 0));
    silent.disconnect();
  }

  // true si el sample sonó; rate con leve variación evita el efecto metralla
  // de fotocopia (mismo golpe idéntico 10 veces por segundo)
  _spatial(position, profileName) {
    if (!position || !this._listener) return spatialAudioMix(0, 0, false, profileName);
    const listener = this._listener();
    if (!listener) return spatialAudioMix(0, 0, false, profileName);
    const sx = position.x ?? 0, sy = position.y ?? 0, sz = position.z ?? 0;
    const dx = sx - listener.x, dy = sy - listener.y, dz = sz - listener.z;
    const distance = Math.hypot(dx, dy, dz);
    const horizontal = Math.max(0.001, Math.hypot(dx, dz));
    const right = listener.right ?? { x: 1, z: 0 };
    const lateral = (dx * right.x + dz * right.z) / horizontal;
    let blocked = false;
    if (this._occluded && distance > 1.5) {
      try { blocked = !!this._occluded({ x: sx, y: sy, z: sz }, listener); }
      catch { blocked = false; }
    }
    return spatialAudioMix(distance, lateral, blocked, profileName);
  }

  _eventOutput(baseGain, options, profileName, destination) {
    if (!this.ctx) return null;
    const opts = options && typeof options === 'object' ? options : {};
    const mix = this._spatial(opts.position, profileName);
    const gain = baseGain * (opts.gain ?? 1) * mix.gain;
    if (gain <= 0.001) return null;
    const out = this.ctx.createGain();
    out.gain.value = gain;
    let tail = out;
    if (mix.cutoff < 18500) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = mix.occluded ? 0.72 : 0.25;
      filter.frequency.value = Math.max(500, mix.cutoff);
      tail.connect(filter);
      tail = filter;
    }
    if (opts.position && this.ctx.createStereoPanner) {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = mix.pan;
      tail.connect(pan);
      tail = pan;
    }
    tail.connect(destination || this.master);
    return out;
  }

  _sample(k, gain, rate = 1, options = null) {
    const buf = this.samples[k];
    if (!buf || !this.ctx) return false;
    const out = this._eventOutput(gain, options, 'gunshot', this.combatBus || this.master);
    // Fuente demasiado lejana: se considera atendida para no disparar el
    // fallback sintético sin atenuación.
    if (!out) return true;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(out);
    src.start(this.ctx.currentTime);
    return true;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('breach.muted', String(this.muted));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  // Un único bed ambiental, muy por debajo de pasos y combate. Se conserva
  // la intención antes de que WebAudio se desbloquee y se cambia con fade para
  // que menú/transiciones de mapa nunca produzcan un corte audible.
  setAmbience(name = null) {
    const next = name === 'fortaleza' || name === 'azoteas' ? name : null;
    if (this._ambienceName === next && (!!this._ambienceNodes === !!next)) return;
    this._ambienceName = next;
    this._stopAmbience();
    if (next && this.ctx && this._noise) this._startAmbience(next);
  }

  _stopAmbience() {
    const nodes = this._ambienceNodes;
    this._ambienceNodes = null;
    if (!nodes || !this.ctx) return;
    const now = this.ctx.currentTime;
    nodes.gain.gain.cancelScheduledValues(now);
    nodes.gain.gain.setValueAtTime(Math.max(0.0001, nodes.gain.gain.value), now);
    nodes.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    for (const timer of nodes.timers || []) clearTimeout(timer);
    setTimeout(() => {
      for (const source of nodes.sources || []) {
        try { source.stop(); } catch { /* ya detenido */ }
      }
      nodes.gain.disconnect();
    }, 420);
  }

  _startAmbience(name) {
    if (!this.ctx || !this._noise || this._ambienceNodes) return;
    const now = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(AMBIENCE_PROFILES[name].gain, now + 0.8);
    gain.connect(this.worldBus || this.master);
    const nodes = { gain, sources: [], timers: new Set() };
    const hum = this.ctx.createOscillator();
    hum.type = 'sine'; hum.frequency.value = name === 'azoteas' ? 49 : 47;
    const humGain = this.ctx.createGain();
    humGain.gain.value = name === 'azoteas' ? 0.045 : 0.32;
    hum.connect(humGain).connect(gain);
    hum.start(now); nodes.sources.push(hum);

    if (AMBIENCE_PROFILES[name].continuousNoise) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noise; noise.loop = true;
      const wind = this.ctx.createBiquadFilter();
      wind.type = 'lowpass'; wind.frequency.value = 260; wind.Q.value = 0.7;
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.value = 0.22;
      noise.connect(wind).connect(noiseGain).connect(gain);
      noise.start(now); nodes.sources.push(noise);
    }
    this._ambienceNodes = nodes;
    if (name === 'azoteas') this._scheduleRooftopAmbience(nodes, 1800);
  }

  _scheduleRooftopAmbience(nodes, delay) {
    const timer = setTimeout(() => {
      nodes.timers.delete(timer);
      if (this._ambienceNodes !== nodes || !this.ctx || !this._noise) return;
      const now = this.ctx.currentTime;
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noise;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 190 + Math.random() * 150;
      filter.Q.value = 0.65;
      const gust = this.ctx.createGain();
      gust.gain.setValueAtTime(0.0001, now);
      gust.gain.exponentialRampToValueAtTime(0.13 + Math.random() * 0.07, now + 0.22);
      gust.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      noise.connect(filter).connect(gust).connect(nodes.gain);
      noise.start(now, Math.random() * 0.08, 0.95);
      noise.stop(now + 1);
      nodes.sources.push(noise);
      noise.onended = () => {
        const i = nodes.sources.indexOf(noise);
        if (i >= 0) nodes.sources.splice(i, 1);
      };
      // Ráfagas bajas y separadas: sugieren viento/ciudad sin mantener un
      // hiss continuo por encima de pasos y combate.
      this._scheduleRooftopAmbience(nodes, AMBIENCE_PROFILES.azoteas.pulseMinMs + Math.random() * 5200);
    }, delay);
    nodes.timers.add(timer);
  }

  _env(gainNode, t0, a, peak, dec) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(peak, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
  }

  _noiseShot(peak, dec, freq0, freq1, q = 1, destination = null) {
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
    src.connect(f).connect(g).connect(destination || this.master);
    src.start(t); src.stop(t + dec + 0.05);
  }

  _tone(type, f0, f1, peak, dec, destination = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dec);
    const g = this.ctx.createGain();
    this._env(g, t, 0.004, peak, dec);
    o.connect(g).connect(destination || this.master);
    o.start(t); o.stop(t + dec + 0.05);
  }

  // ---------- pasos ----------
  // Paso sobre losa de piedra: golpe de talón (banda media) + toque de punta
  // más agudo un instante después + "tick" de suela dura + golpe de peso en
  // los pesados. Jitter aleatorio por paso: ningún paso suena igual al
  // anterior. Para compatibilidad, también acepta (kind, vol, pan), aunque el
  // gameplay usa {position, gain} para aplicar distancia/altura/oclusión.
  footstep(kind = 'run', options = null, legacyPan = 0) {
    if (!this.ctx) return;
    const P = STEP_KINDS[kind] ?? STEP_KINDS.run;
    let opts;
    if (typeof options === 'number') {
      opts = { gain: options };
      // La firma antigua ya traía paneo calculado externamente.
      if (legacyPan && this.ctx.createStereoPanner) {
        const out = this.ctx.createGain();
        out.gain.value = options;
        const sp = this.ctx.createStereoPanner();
        sp.pan.value = Math.max(-1, Math.min(1, legacyPan));
        out.connect(sp).connect(this.worldBus || this.master);
        this._renderFootstep(P, kind, out);
        return;
      }
    } else opts = options || {};
    const localGain = opts.position ? 1.18 : 1.08;
    const out = this._eventOutput(localGain, opts, 'footstep', this.worldBus || this.master);
    if (!out) return;
    this._renderFootstep(P, kind, out);
  }

  _renderFootstep(P, kind, out) {
    if (!this.ctx) return;
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

  // El arma propia permanece frontal y con presencia. Una posición convierte
  // el evento en disparo ajeno: espacial, atenuado y filtrado por el mundo.
  smg(options = null) {
    const remote = !!options?.position;
    const gain = remote ? 0.34 : 0.39;
    if (this._sample('smg', gain, 0.97 + Math.random() * 0.06, options)) return;
    const out = this._eventOutput(remote ? 0.72 : 0.82, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.5, 0.09, 3200, 900, 1, out);
    this._tone('square', 190, 90, 0.12, 0.06, out);
  }
  shotgun(options = null) {
    const remote = !!options?.position;
    const gain = remote ? 0.39 : 0.46;
    if (this._sample('shotgun', gain, 0.98 + Math.random() * 0.04, options)) return;
    const out = this._eventOutput(remote ? 0.72 : 0.86, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.85, 0.28, 1600, 220, 2, out);
    this._tone('sine', 130, 45, 0.55, 0.22, out);
  }
  // pistola: crack seco y corto, más agudo que la SMG (sin sample: síntesis)
  pistol(options = null) {
    const remote = !!options?.position;
    const out = this._eventOutput(remote ? 0.66 : 0.76, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.5, 0.06, 4200, 1400, 1.1, out);
    this._tone('square', 300, 130, 0.1, 0.045, out);
  }
  // francotirador: crack violento con cola grave (eco de cañón largo)
  sniper(options = null) {
    const remote = !!options?.position;
    const out = this._eventOutput(remote ? 0.8 : 0.9, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.95, 0.12, 2600, 700, 1.4, out);
    this._noiseShot(0.4, 0.34, 700, 140, 1.8, out);
    this._tone('sine', 100, 40, 0.5, 0.3, out);
  }
  // bazooka: golpe sordo del lanzamiento + whoosh del cohete saliendo
  bazooka(options = null) {
    const remote = !!options?.position;
    const out = this._eventOutput(remote ? 0.78 : 0.88, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.7, 0.2, 900, 180, 1.6, out);
    this._noiseShot(0.35, 0.4, 1900, 2600, 0.7, out);
    this._tone('sine', 85, 40, 0.5, 0.28, out);
  }
  // explosión del cohete: impacto grave con escombros
  explosion(options = null) {
    const out = this._eventOutput(0.95, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(1.0, 0.5, 700, 90, 1.6, out);
    this._noiseShot(0.45, 0.22, 2400, 600, 1.1, out);
    this._tone('sine', 70, 32, 0.7, 0.5, out);
  }
  // rebote metálico del bote de humo contra el suelo/paredes
  nadeBounce(options = null) {
    const out = this._eventOutput(0.5, options, 'impact', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.18, 0.05, 4800, 1700, 2.2, out);
    this._tone('sine', 1500 + Math.random() * 500, 700, 0.09, 0.08, out);
  }
  // siseo del humo activándose
  smokePop(options = null) {
    const out = this._eventOutput(0.6, options, 'impact', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.4, 0.6, 2400, 3200, 0.5, out);
    this._tone('sine', 220, 90, 0.12, 0.1, out);
  }
  // despachador genérico por id de arma (tabla, sin ifs repartidos por main)
  gun(wep, options = null) {
    switch (wep) {
      case 'shotgun': return this.shotgun(options);
      case 'pistol': return this.pistol(options);
      case 'sniper': return this.sniper(options);
      case 'bazooka': return this.bazooka(options);
      default: return this.smg(options);
    }
  }

  impact(position, surface = 'concrete') {
    if (!this.ctx || !position) return;
    const now = this.ctx.currentTime;
    if (now - this._impactWindow > 0.055) {
      this._impactWindow = now;
      this._impactCount = 0;
    }
    // Una escopeta conserva varios contactos, pero no crea ocho transientes
    // idénticos que tapen pasos/disparos.
    if (this._impactCount >= 2) return;
    const out = this._eventOutput(surface === 'metal' ? 0.52 : 0.42,
      { position }, 'impact', this.combatBus || this.master);
    if (!out) return;
    this._impactCount++;
    if (surface === 'metal') {
      this._noiseShot(0.16, 0.055, 5200, 1900, 2.4, out);
      this._tone('sine', 2100 + Math.random() * 650, 900, 0.1, 0.09, out);
    } else {
      const stone = surface === 'stone';
      this._noiseShot(stone ? 0.2 : 0.16, 0.075,
        stone ? 2300 : 1800, stone ? 520 : 380, 1.2, out);
      this._tone('triangle', stone ? 180 : 135, 70, 0.055, 0.065, out);
    }
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
  uiMove() { this._tone('sine', 690, 760, 0.035, 0.035); }
  uiConfirm() { this._tone('triangle', 410, 620, 0.065, 0.075); }
  lobbyEnter() {
    this._tone('triangle', 220, 360, 0.09, 0.13);
    setTimeout(() => this._tone('sine', 520, 620, 0.06, 0.11), 85);
  }
  countdown(value = 3) {
    const last = value <= 1;
    this._tone('square', last ? 560 : 420, last ? 760 : 470, last ? 0.14 : 0.09, last ? 0.13 : 0.08);
  }
  roundStart() {
    this._tone('triangle', 260, 520, 0.15, 0.18);
    setTimeout(() => this._tone('sine', 720, 880, 0.11, 0.16), 95);
  }
  roundEnd() { this._tone('triangle', 460, 230, 0.12, 0.24); }
  defeat() { this._tone('sawtooth', 260, 95, 0.12, 0.34); }
  mvp() {
    for (const [f, d] of [[330, 0], [440, 0.09], [660, 0.2]]) {
      setTimeout(() => this._tone('triangle', f, f * 1.05, 0.075, 0.16), d * 1000);
    }
  }
}

// parámetros por tipo de paso (ganancias de talón/punta/peso/tick + freq base)
const STEP_KINDS = {
  walk:    { heel: 0.14, toe: 0.075, thump: 0.04, tick: 0.025, f: 520 },
  run:     { heel: 0.21, toe: 0.11,  thump: 0.075, tick: 0.04, f: 470 },
  roadie:  { heel: 0.29, toe: 0.135, thump: 0.14, tick: 0.052, f: 420 },
  shuffle: { heel: 0.1,  toe: 0.085, thump: 0,    tick: 0.025, f: 680 },
  jump:    { heel: 0.14, toe: 0,     thump: 0,    tick: 0.035, f: 750 },
  land:    { heel: 0.34, toe: 0.18,  thump: 0.27, tick: 0.058, f: 330 },
};
