// Audio WebAudio de Breach. Facade estable sobre el motor portado de
// Crashterra (src/audio/): banco de ~90 sonidos procedurales renderizados en
// un worker, pool fijo de voces con prioridades y topes por grupo, limitador
// maestro + soft-clip, cola acústica por mapa. Los cuatro MP3 del dueño
// (public/audio) siguen siendo el cuerpo de los disparos.
// La espacialización es la de Breach y vive aquí: distancia 3D, paneo,
// pérdida gradual de agudos y oclusión por geometría (spatialAudioMix +
// callback de rayo de main). Mientras el banco no terminó de renderizar, cada
// evento cae al sintetizador original de abajo: el primer disparo nunca espera.
// M = mute.
import { Engine } from '../audio/engine.js';
import { buildBank, SAMPLE_FILES } from '../audio/catalog.js';
import { IR_OF_MAP } from '../audio/sfx-world.js';

export const AUDIO_PROFILES = Object.freeze({
  footstep: Object.freeze({ near: 1.6, far: 26, rolloff: 0.16, farHz: 3200,
    occludedGain: 0.62, occludedHz: 1450 }),
  gunshot: Object.freeze({ near: 2.4, far: 82, rolloff: 0.09, farHz: 2600,
    occludedGain: 0.48, occludedHz: 1850 }),
  impact: Object.freeze({ near: 1.2, far: 30, rolloff: 0.16, farHz: 2300,
    occludedGain: 0.5, occludedHz: 1300 }),
});

export const AMBIENCE_PROFILES = Object.freeze({
  // Todos los mapas usan acentos espaciados, no una capa de ruido continuo.
  // Esto conserva la orientación sonora y evita fatiga/"hiss" sobre combate.
  fortaleza: Object.freeze({ continuousNoise: false, gain: 0.015, pulseMinMs: 6200 }),
  azoteas: Object.freeze({ continuousNoise: false, gain: 0.014, pulseMinMs: 4800 }),
  calle: Object.freeze({ continuousNoise: false, gain: 0.013, pulseMinMs: 5200 }),
  metro: Object.freeze({ continuousNoise: false, gain: 0.016, pulseMinMs: 4300 }),
  prision: Object.freeze({ continuousNoise: false, gain: 0.012, pulseMinMs: 6500 }),
  pueblo: Object.freeze({ continuousNoise: false, gain: 0.012, pulseMinMs: 7000 }),
});

// Cola acústica por mapa (IR del banco + nivel de retorno). Los mapas
// heredados reutilizan la respuesta más parecida.
export const SPACE_PROFILES = Object.freeze({
  fortaleza: Object.freeze({ ir: IR_OF_MAP.fortaleza, level: 0.55 }),
  azoteas: Object.freeze({ ir: IR_OF_MAP.azoteas, level: 0.4 }),
  calle: Object.freeze({ ir: IR_OF_MAP.calle, level: 0.5 }),
  metro: Object.freeze({ ir: IR_OF_MAP.calle, level: 0.6 }),
  prision: Object.freeze({ ir: IR_OF_MAP.fortaleza, level: 0.45 }),
  pueblo: Object.freeze({ ir: IR_OF_MAP.fortaleza, level: 0.35 }),
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

// Paso por la cabeza del oyente: punto más cercano del segmento disparo→
// impacto que ya llega por red. Pura para poder verificarla en Node. null si
// la bala no pasa cerca, si nace junto al oyente (ya suena el disparo) o si
// el punto más cercano cae fuera del tramo recorrido.
export function bulletPass(origin, end, listener, radius = 3.2) {
  if (!origin || !end || !listener) return null;
  const dx = end.x - origin.x, dy = end.y - origin.y, dz = end.z - origin.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1) return null;
  const lx = listener.x - origin.x, ly = listener.y - origin.y, lz = listener.z - origin.z;
  if (lx * lx + ly * ly + lz * lz < 16) return null;
  const t = (lx * dx + ly * dy + lz * dz) / len2;
  // t > 1: el punto más cercano cae más allá del impacto (la bala se detuvo
  // antes, p. ej. en un muro delante del oyente): no pasó a su lado
  if (t <= 0.02 || t > 1) return null;
  const px = origin.x + dx * t, py = origin.y + dy * t, pz = origin.z + dz * t;
  const ox = px - listener.x, oy = py - listener.y, oz = pz - listener.z;
  const dist = Math.hypot(ox, oy, oz);
  if (dist > radius) return null;
  const right = listener.right ?? { x: 1, z: 0 };
  const h = Math.max(0.001, Math.hypot(ox, oz));
  const side = dist < 0.25 ? 0 : (ox * right.x + oz * right.z) / h;
  return { dist, t, point: { x: px, y: py, z: pz }, side: Math.max(-0.92, Math.min(0.92, side)),
    gain: Math.pow(1 - dist / radius, 1.2) };
}

// Relación del oyente con quien emite el sonido: propio / aliado / enemigo.
// Sin bando conocido se trata como enemigo (la información de amenaza manda).
export function footstepRelation(listenerTeam, sourceTeam) {
  if (!sourceTeam || !listenerTeam) return 'enemy';
  return sourceTeam === listenerTeam ? 'friend' : 'enemy';
}

// Ganancias de los samples: las mismas que Breach ya tenía (cuerpo intacto).
const LOCAL_GAIN = { smg: 0.39, shotgun: 0.46, pistol: 0.42, sniper: 0.55 };
const REMOTE_GAIN = { smg: 0.34, shotgun: 0.39, pistol: 0.36, sniper: 0.48 };
const HEAVY = new Set(['shotgun', 'sniper', 'bazooka']);
const STEP_OF = { stone: 'step_stone', metal: 'step_metal', concrete: 'step_concrete', glass: 'step_concrete', earth: 'step_earth' };
const IMPACT_OF = { metal: 'imp_metal', stone: 'imp_stone', glass: 'imp_glass' };
// pasos: propio discreto, aliado atenuado y oscuro, enemigo presente y nítido
const STEP_REL = Object.freeze({
  own: Object.freeze({ volume: 0.8, cut: 20000, prio: 60 }),
  friend: Object.freeze({ volume: 0.55, cut: 2600, prio: 45 }),
  enemy: Object.freeze({ volume: 1.35, cut: 20000, prio: 86 }),
});
const STEP_KIND_VOL = { walk: 0.7, run: 0.92, roadie: 1.05, land: 1.1, jump: 0.6 };
const ROCKET_LOOPS = 3;

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
    this._surfaceAt = null;
    this.combatBus = null;
    this.worldBus = null;
    this.uiBus = null;
    this.ambBus = null;
    this._impactWindow = 0;
    this._impactCount = 0;
    this._ambienceName = null;
    this._ambienceNodes = null;
    // motor portado de Crashterra: el catálogo se declara ya (barato) y el
    // PCM se renderiza en un worker desde la carga de la página
    this.bank = buildBank();
    this.bank.releasePcm = typeof window !== 'undefined' && typeof Worker !== 'undefined';
    this.engine = null;
    this._worker = null;
    this._useWorker = false;
    this._pumpTimer = null;
    this._threat = null;
    this._menuOn = false;
    this._heartNext = 0;
    this._prot = 0;
    this._lastRoundStart = -10;
    this._pedestal = null;
    this._pedestalTick = 0;
    this._rocketSlots = new Array(ROCKET_LOOPS).fill(null);
    this._startRender();
  }

  // ---------- render del banco ----------
  _startRender() {
    if (typeof window === 'undefined' || this.bank.pending <= 0) return;
    if (typeof Worker !== 'undefined') {
      try {
        const w = new Worker(new URL('../audio/render.worker.js', import.meta.url), { type: 'module' });
        this._worker = w;
        this._useWorker = true;
        w.onmessage = (e) => {
          const m = e.data;
          if (m.done) { w.terminate(); this._worker = null; this._useWorker = false; return; }
          this._renderer = 'worker';
          this.bank.accept(m.name, m.v, m.ch, m.ms);
        };
        w.onerror = (e) => {
          e.preventDefault?.();
          console.warn('[audio] worker de render falló; render en el hilo principal');
          w.terminate();
          this._worker = null;
          this._useWorker = false;
          this._pump();
        };
        w.postMessage('go');
        return;
      } catch { /* sin worker de módulo: render troceado abajo */ }
    }
    this._pump();
  }

  // Respaldo: trabajos de 4 ms con huecos para no robar cuadros.
  _pump() {
    if (this._pumpTimer !== null) return;
    this._renderer = 'main';
    const tick = () => {
      this._pumpTimer = null;
      if (this.bank.step(4)) return;
      this._pumpTimer = setTimeout(tick, 8);
    };
    this._pumpTimer = setTimeout(tick, 0);
  }

  // Los callbacks viven en main para que Audio no dependa de Three.js/World.
  setSpatialContext(listener, occluded = null) {
    this._listener = listener;
    this._occluded = occluded;
  }

  // (x, y, z) → 'stone' | 'concrete' | 'metal' | 'glass'. Lo da main.
  setSurfaceQuery(fn) {
    this._surfaceAt = fn;
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    localStorage.setItem('breach.volume', String(this.volume));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.engine = new Engine(this.ctx, this.bank, this.ctx.destination);
      this.master = this.engine.master;
      this.master.gain.value = this.muted ? 0 : this.volume;
      // combatBus conserva el compresor de pegamento de antes; pasos y UI no
      // quedan enterrados por él. Todo termina en el limitador maestro.
      this.combatBus = this.engine.combat;
      this.worldBus = this.engine.world;
      this.uiBus = this.engine.ui;
      this.ambBus = this.engine.amb;
      const len = this.ctx.sampleRate * 1;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf;
      this._samplesReady = this._loadSamples();
      if (this._ambienceName) this._startAmbience(this._ambienceName);
      this._applySpace();
    }
    const resumed = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    return Promise.all([resumed, this._samplesReady || Promise.resolve()]);
  }

  // Samples de armas (mejor esfuerzo): si no cargan, queda el sintético.
  _loadSamples() {
    if (this._samplesReq) return this._samplesReady || Promise.resolve();
    this._samplesReq = true;
    const jobs = [];
    for (const [k, url] of Object.entries(SAMPLE_FILES)) {
      jobs.push(fetch(url)
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => {
          this.samples[k] = buf;
          this.bank.setExternal(`gun_${k}`, buf);
          this.bank.setExternal(`gun_${k}_remote`, buf);
        })
        .catch(() => { /* sin sample: fallback sintético */ }));
    }
    return Promise.all(jobs);
  }

  // Se llama desde el gesto de ENTRAR: desbloquea WebAudio, espera los
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
    // AudioBuffers de la banda de armas ya renderizada: el primer disparo
    // no paga la copia del PCM.
    for (const def of this.bank.defs.values()) {
      if (def.order > 1 || def.external) continue;
      for (let v = 0; v < def.variants; v++) if (this.bank.ready(def.name, v)) this.bank.buffer(this.ctx, def.name, v);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    silent.disconnect();
  }

  // Mezcla espacial de un evento del mundo (null = local/frontal).
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

  _listenerPose() {
    try { return this._listener?.() ?? null; } catch { return null; }
  }

  // Reproduce un sonido del banco. false = no listo / culled / sin motor
  // (el llamador decide si cae al sintetizador original).
  // true también si el motor lo rechazó a propósito (tope de voces, hueco
  // mínimo, inaudible): el sintetizador original es SOLO para "el banco aún
  // no tiene este sonido", nunca una vía para saltarse el pool de 32 voces.
  _play(name, opts) {
    const eng = this.engine;
    if (!eng) return false;
    if (eng.play(name, opts)) return true;
    return eng.lastReject !== 'missing' && eng.lastReject !== 'notReady';
  }

  // Igual que _play pero con la mezcla espacial ya resuelta para `position`.
  _playAt(name, position, profileName, opts = {}) {
    if (!this.engine) return false;
    if (!position) return this._play(name, opts);
    const mix = this._spatial(position, profileName);
    if (mix.gain <= 0.001) return this.bank.ready(name, 0); // demasiado lejos: atendido
    opts.mix = mix;
    return this._play(name, opts);
  }

  _now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('breach.muted', String(this.muted));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  // ---------- ambiente y espacio del mapa ----------
  // Un único bed ambiental, muy por debajo de pasos y combate. Se conserva
  // la intención antes de que WebAudio se desbloquee y se cambia con fade para
  // que menú/transiciones de mapa nunca produzcan un corte audible.
  setAmbience(name = null) {
    if (name === 'calle2') name = 'calle';
    const next = AMBIENCE_PROFILES[name] ? name : null;
    if (this._ambienceName === next && (!!this._ambienceNodes === !!next)) return;
    this._ambienceName = next;
    this._stopAmbience();
    if (next && this.ctx && this._noise) this._startAmbience(next);
    this._applySpace();
  }

  // El IR puede no estar renderizado aún: update() reintenta.
  _applySpace() {
    if (!this.engine) return;
    const sp = SPACE_PROFILES[this._ambienceName];
    this._spaceOk = this.engine.setSpace(sp?.ir ?? null, sp?.level ?? 0);
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
    gain.connect(this.ambBus || this.master);
    const nodes = { gain, sources: [], timers: new Set() };
    const hum = this.ctx.createOscillator();
    // Cama tonal casi imperceptible: sitúa el lugar sin crear una capa de
    // ruido blanco. La personalidad llega en acentos cortos y espaciados.
    hum.type = 'sine';
    hum.frequency.value = { azoteas: 49, metro: 41, calle: 46 }[name] ?? 47;
    const humGain = this.ctx.createGain();
    humGain.gain.value = { azoteas: 0.025, metro: 0.065, calle: 0.035, prision: 0.028, pueblo: 0.022 }[name] ?? 0.03;
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
    else this._scheduleMapAmbience(name, nodes, 2400 + Math.random() * 1600);
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

  // Acentos ambientales sintéticos, bajos en la mezcla y con huecos largos.
  // Se mantienen deliberadamente no-direccionales: son atmósfera de mapa, no
  // información de combate que pueda confundirse con pasos o disparos.
  _scheduleMapAmbience(name, nodes, delay) {
    const timer = setTimeout(() => {
      nodes.timers.delete(timer);
      if (this._ambienceNodes !== nodes || !this.ctx || !this._noise) return;
      const now = this.ctx.currentTime;
      const profile = AMBIENCE_PROFILES[name] || { pulseMinMs: 6000 };
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noise;
      const filter = this.ctx.createBiquadFilter();
      const accent = this.ctx.createGain();
      let duration = 0.7;
      let peak = 0.035;
      if (name === 'calle') {
        // tráfico lejano / un soplo de calle, no una sirena constante
        filter.type = 'bandpass'; filter.frequency.value = 380 + Math.random() * 260; filter.Q.value = 0.55;
        duration = 0.8 + Math.random() * 0.55; peak = 0.045;
      } else if (name === 'metro') {
        // ventilación que respira y pequeño toque metálico de túnel
        filter.type = 'bandpass'; filter.frequency.value = 150 + Math.random() * 80; filter.Q.value = 1.4;
        duration = 0.55 + Math.random() * 0.45; peak = 0.055;
        this._tone('sine', 260 + Math.random() * 80, 170 + Math.random() * 45, 0.012, 0.32, nodes.gain);
      } else if (name === 'prision') {
        // golpe de reja remoto: breve y sin competir con una granada/arma
        filter.type = 'bandpass'; filter.frequency.value = 820 + Math.random() * 260; filter.Q.value = 4.2;
        duration = 0.16; peak = 0.026;
        this._tone('triangle', 760 + Math.random() * 210, 320, 0.009, 0.18, nodes.gain);
      } else if (name === 'pueblo') {
        // viento entre ruinas + un chirrido/ave muy ocasional
        filter.type = 'lowpass'; filter.frequency.value = 520 + Math.random() * 180; filter.Q.value = 0.55;
        duration = 0.7 + Math.random() * 0.6; peak = 0.025;
        this._tone('sine', 1500 + Math.random() * 500, 2100 + Math.random() * 450, 0.006, 0.11, nodes.gain);
      } else {
        // fortaleza: aire y una resonancia muy baja, nunca un loop perceptible
        filter.type = 'lowpass'; filter.frequency.value = 340 + Math.random() * 130; filter.Q.value = 0.5;
        duration = 0.65 + Math.random() * 0.45; peak = 0.026;
      }
      accent.gain.setValueAtTime(0.0001, now);
      accent.gain.exponentialRampToValueAtTime(peak, now + 0.08);
      accent.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      noise.connect(filter).connect(accent).connect(nodes.gain);
      noise.start(now, Math.random() * 0.12, Math.min(0.98, duration));
      noise.stop(now + duration + 0.03);
      nodes.sources.push(noise);
      noise.onended = () => {
        const i = nodes.sources.indexOf(noise);
        if (i >= 0) nodes.sources.splice(i, 1);
      };
      this._scheduleMapAmbience(name, nodes, profile.pulseMinMs + Math.random() * 6500);
    }, delay);
    nodes.timers.add(timer);
  }

  // ---------- por cuadro: loops, latido, protección, cama del menú ----------
  // f: { menu, playing, alive, hp01, prot, rockets, pedestal, holdT, holdMax }
  // (objeto reutilizado por main: sin asignaciones por cuadro en el llamador).
  update(dt, f) {
    const eng = this.engine;
    if (!eng || !f) return;
    if (!this._spaceOk) this._applySpace();
    this._updateMenuBed(!!f.menu);
    this._updateHeart(f);
    this._updateProtection(f);
    this._updatePedestal(f);
    this._updateRockets(f.rockets);
  }

  _updateMenuBed(on) {
    const l = this.engine.loop('menu_bed');
    if (!l) return;
    if (on && !this._menuOn) {
      if (!l.running && !l.start()) return;
      l.set(1, 1, 20000, 0, 0.8);
      this._menuOn = true;
    } else if (!on && this._menuOn) {
      this._menuOn = false;
      l.stop(1.2);
    }
  }

  // Vida baja: latido cuyo tempo sube a medida que baja la vida.
  _updateHeart(f) {
    const now = this._now();
    if (!f.playing || !f.alive || !(f.hp01 < 0.3)) { this._heartNext = 0; return; }
    if (!this._heartNext) this._heartNext = now;
    if (now < this._heartNext) return;
    const bpm = 72 + (0.3 - f.hp01) * 160;
    this._heartNext = now + 60 / bpm;
    this._play('heartbeat', { volume: 0.7 + (0.3 - f.hp01) * 1.2 });
  }

  // Protección de spawn: subida = reaparición, bajada a 0 = ya eres vulnerable.
  _updateProtection(f) {
    const p = f.prot > 0 ? f.prot : 0;
    if (f.alive && f.playing) {
      if (p > 0 && this._prot <= 0 && this._now() - this._lastRoundStart > 1.5) this.respawn();
      else if (p <= 0 && this._prot > 0) this.protectionEnd();
    }
    this._prot = p;
  }

  _updatePedestal(f) {
    const a = f.pedestal;
    const hum = this.engine.loop('pedestal_hum');
    const hold = this.engine.loop('pedestal_hold');
    if (a !== this._pedestal) {
      if (a && f.playing) this.specialSpawn({ x: a.x, y: (a.y ?? 0) + 0.9, z: a.z });
      this._pedestal = a;
    }
    if (!a || !f.playing) {
      hum?.stop(0.4);
      hold?.stop(0.1);
      return;
    }
    // zumbido posicional; el rayo de oclusión se refresca cada 4 cuadros
    if (hum && (hum.running || hum.start()) && (this._pedestalTick = (this._pedestalTick + 1) % 4) === 0) {
      const mix = this._spatial({ x: a.x, y: (a.y ?? 0) + 0.9, z: a.z }, 'footstep');
      hum.set(mix.gain, 1, mix.cutoff, mix.pan, 0.12);
    }
    const k = f.holdMax > 0 ? clamp01(f.holdT / f.holdMax) : 0;
    if (k > 0 && hold && (hold.running || hold.start())) hold.set(0.6 + 0.6 * k, 0.8 + 0.7 * k, 20000, 0, 0.03);
    else hold?.stop(0.08);
  }

  // Vuelo de cohetes: hasta 3 loops posicionales, asignados por objeto.
  _updateRockets(list) {
    const slots = this._rocketSlots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && !(list && list.includes(s))) {
        slots[i] = null;
        this.engine.loop('rocket_loop', `rocket${i}`)?.stop(0.12);
      }
    }
    if (!list) return;
    for (const r of list) {
      let i = slots.indexOf(r);
      if (i < 0) {
        i = slots.indexOf(null);
        if (i < 0) continue;
        slots[i] = r;
      }
      const l = this.engine.loop('rocket_loop', `rocket${i}`);
      if (!l || !(l.running || l.start(i * 0.37))) continue;
      const mix = this._spatial(r, 'gunshot');
      l.set(mix.gain, 1, mix.cutoff, mix.pan, 0.03);
    }
  }

  // ---------- síntesis original (respaldo mientras el banco renderiza) ----------
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
    tail.connect(destination || this.uiBus || this.master);
    return out;
  }

  // true si el sample sonó; rate con leve variación evita el efecto metralla
  // de fotocopia (mismo golpe idéntico 10 veces por segundo)
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
    src.connect(f).connect(g).connect(destination || this.uiBus || this.master);
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
    o.connect(g).connect(destination || this.uiBus || this.master);
    o.start(t); o.stop(t + dec + 0.05);
  }

  // ---------- pasos ----------
  // Superficie bajo el emisor (piedra/hormigón/metal), relación con el oyente
  // (propio/aliado/enemigo) y tipo de paso. Para compatibilidad también acepta
  // (kind, vol, pan): esa firma antigua usa el sintetizador original.
  // options: { position, team, gain }.
  footstep(kind = 'run', options = null, legacyPan = 0) {
    if (!this.ctx) return;
    if (typeof options === 'number') {
      this._legacyFootstep(kind, { gain: options }, legacyPan);
      return;
    }
    const opts = options || {};
    if (this._bankStep(kind, opts)) return;
    this._legacyFootstep(kind, opts, 0);
  }

  _surfaceUnder(pos) {
    if (!this._surfaceAt || !pos) return 'concrete';
    try { return this._surfaceAt(pos.x, pos.y, pos.z) || 'concrete'; } catch { return 'concrete'; }
  }

  _bankStep(kind, opts) {
    if (!this.engine) return false;
    const own = !opts.position;
    let feet = opts.position ? { x: opts.position.x, y: (opts.position.y ?? 0) - 0.22, z: opts.position.z } : null;
    if (own) {
      const L = this._listenerPose();
      feet = L ? { x: L.x, y: L.y - 1.15, z: L.z } : null;
    }
    const rel = own ? 'own' : footstepRelation(this._listenerPose()?.team, opts.team);
    const R = STEP_REL[rel];
    const name = kind === 'shuffle' ? 'step_scuff' : STEP_OF[this._surfaceUnder(feet)] ?? 'step_concrete';
    const volume = (STEP_KIND_VOL[kind] ?? 1) * R.volume * (opts.gain ?? 1);
    const base = { volume, cut: R.cut, prio: R.prio, pitch: kind === 'roadie' ? 0.93 : kind === 'land' ? 0.9 : 1 };
    const ok = own ? this._play(name, base) : this._playAt(name, opts.position, 'footstep', base);
    if (!ok) return false;
    if (kind === 'roadie') {
      const g = { volume: volume * 0.8, cut: R.cut, prio: R.prio - 5 };
      if (own) this._play('gear', g); else this._playAt('gear', opts.position, 'footstep', g);
    } else if (kind === 'land') {
      const g = { volume: own ? 1 : volume, prio: R.prio };
      if (own) this._play('land', g); else this._playAt('land', opts.position, 'footstep', g);
    }
    return true;
  }

  _legacyFootstep(kind, opts, legacyPan) {
    const P = STEP_KINDS[kind] ?? STEP_KINDS.run;
    if (legacyPan && this.ctx.createStereoPanner) {
      // La firma antigua ya traía paneo calculado externamente.
      const out = this.ctx.createGain();
      out.gain.value = opts.gain ?? 1;
      const sp = this.ctx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, legacyPan));
      out.connect(sp).connect(this.worldBus || this.master);
      this._renderFootstep(P, kind, out);
      return;
    }
    const localGain = opts.position ? 1.18 : 1.08;
    const out = this._eventOutput(localGain, opts, 'footstep', this.worldBus || this.master);
    if (!out) return;
    this._renderFootstep(P, kind, out);
  }

  // Paso sintético original: talón + punta + tick de suela + peso.
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

  // ---------- armas ----------
  // El arma propia permanece frontal y con presencia. Una posición convierte
  // el evento en disparo ajeno: espacial, atenuado, filtrado por el mundo y
  // cruzado con su versión lejana. options: { position, end, team, enemy }.
  _shot(w, options) {
    if (!this.engine) return false;
    const remote = !!options?.position;
    if (!remote) {
      if (!this._play(`gun_${w}`, { volume: LOCAL_GAIN[w] })) return false;
      if (w === 'smg') { this._play('mech_smg'); this._play('punch_light'); }
      else if (w === 'pistol') { this._play('mech_pistol'); this._play('punch_light'); }
      else if (w === 'shotgun') {
        this._play('punch_heavy');
        // bombeo tras el disparo (cadencia 95 rpm → ciclo de 0.63 s)
        this._play('pump', { at: this._now() + 0.3, tag: 'pump' });
      } else this._play('punch_heavy');
      return true;
    }
    const mix = this._spatial(options.position, 'gunshot');
    this._bulletPass(w, options);
    if (mix.gain <= 0.001) return !!this.samples[w];
    // cercano → sample; lejano → "pop" y rebotes. Cruce entre 16 y 50 m.
    const far = clamp01((mix.distance - 16) / 34);
    const ok = this._play(`gun_${w}_remote`, { volume: REMOTE_GAIN[w] * (1 - far * 0.65), mix });
    if (!ok) return false;
    this._distantLayer(w, mix, far);
    return true;
  }

  _distantLayer(w, mix, far) {
    if (far <= 0.05) return;
    // el lejano cae más despacio que el cercano: se oye "a lo lejos"
    const farMix = { gain: Math.pow(mix.gain, 0.6), pan: mix.pan, cutoff: Math.min(mix.cutoff, 3000), occluded: mix.occluded };
    this._play(HEAVY.has(w) ? 'dist_heavy' : 'dist_light', { volume: far * 0.9, mix: farMix });
  }

  // Silbido o chasquido de una bala enemiga que pasa cerca + recuerdo de la
  // dirección de la amenaza (para el daño direccional sin dato de origen).
  _bulletPass(w, options) {
    if (!options.end || w === 'bazooka') return;
    const L = this._listenerPose();
    if (!L) return;
    const enemy = options.enemy ?? (footstepRelation(L.team, options.team) === 'enemy');
    if (!enemy) return;
    const pass = bulletPass(options.position, options.end, L);
    if (!pass) return;
    this._threat = { x: options.position.x, z: options.position.z, t: this._now() };
    this._play(w === 'sniper' ? 'crack' : 'whiz', { volume: pass.gain * 1.2, pan: pass.side, force: true });
  }

  smg(options = null) {
    if (this._shot('smg', options)) return;
    const remote = !!options?.position;
    const gain = remote ? 0.34 : 0.39;
    if (this._sample('smg', gain, 0.97 + Math.random() * 0.06, options)) return;
    const out = this._eventOutput(remote ? 0.72 : 0.82, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.5, 0.09, 3200, 900, 1, out);
    this._tone('square', 190, 90, 0.12, 0.06, out);
  }
  shotgun(options = null) {
    if (this._shot('shotgun', options)) return;
    const remote = !!options?.position;
    const gain = remote ? 0.39 : 0.46;
    if (this._sample('shotgun', gain, 0.98 + Math.random() * 0.04, options)) return;
    const out = this._eventOutput(remote ? 0.72 : 0.86, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.85, 0.28, 1600, 220, 2, out);
    this._tone('sine', 130, 45, 0.55, 0.22, out);
  }
  // pistola: sample real (Elevenlabs de Chuck) — pegada seca y compacta;
  // el sintético queda de respaldo si el mp3 no carga
  pistol(options = null) {
    if (this._shot('pistol', options)) return;
    const remote = !!options?.position;
    const gain = remote ? 0.36 : 0.42;
    if (this._sample('pistol', gain, 0.97 + Math.random() * 0.06, options)) return;
    const out = this._eventOutput(remote ? 0.66 : 0.76, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.5, 0.06, 4200, 1400, 1.1, out);
    this._tone('square', 300, 130, 0.1, 0.045, out);
  }
  // francotirador: sample real (Elevenlabs de Chuck): crack + eco de cañón largo
  sniper(options = null) {
    if (this._shot('sniper', options)) return;
    const remote = !!options?.position;
    const gain = remote ? 0.48 : 0.55;
    if (this._sample('sniper', gain, 0.98 + Math.random() * 0.04, options)) return;
    const out = this._eventOutput(remote ? 0.8 : 0.9, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.95, 0.12, 2600, 700, 1.4, out);
    this._noiseShot(0.4, 0.34, 700, 140, 1.8, out);
    this._tone('sine', 100, 40, 0.5, 0.3, out);
  }
  // bazooka: golpe sordo del lanzamiento + chorro del cohete saliendo
  bazooka(options = null) {
    const remote = !!options?.position;
    if (!remote && this._play('bazooka_fire', { volume: 1 })) { this._play('punch_heavy'); return; }
    if (remote) {
      const mix = this._spatial(options.position, 'gunshot');
      if (mix.gain <= 0.001 && this.bank.ready('bazooka_fire', 0)) return;
      const far = clamp01((mix.distance - 16) / 34);
      if (this._play('bazooka_fire', { volume: 0.85 * (1 - far * 0.6), mix })) { this._distantLayer('bazooka', mix, far); return; }
    }
    const out = this._eventOutput(remote ? 0.78 : 0.88, options, 'gunshot', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.7, 0.2, 900, 180, 1.6, out);
    this._noiseShot(0.35, 0.4, 1900, 2600, 0.7, out);
    this._tone('sine', 85, 40, 0.5, 0.28, out);
  }
  // explosión: transiente + cola grave cercana, retumbo lejano, crack extra
  // en impacto directo. Una explosión cercana baja el ambiente un instante.
  explosion(options = null) {
    const direct = !!options?.direct;
    if (this.engine && this.bank.ready('boom', 0)) {
      const mix = this._spatial(options?.position, 'gunshot');
      if (mix.gain <= 0.001) return;
      const far = clamp01((mix.distance - 14) / 30);
      if (this._play('boom', { volume: (direct ? 1.1 : 1) * (1 - far * 0.7), mix })) {
        if (far > 0.05) this._play('boom_far', { volume: far, mix: { gain: Math.pow(mix.gain, 0.6), pan: mix.pan, cutoff: Math.min(mix.cutoff, 2000), occluded: mix.occluded } });
        if (direct) this._play('boom_direct', { mix });
        if (mix.distance < 30) this.engine.duck(6 * (1 - mix.distance / 30));
        return;
      }
    }
    const out = this._eventOutput(direct ? 1.08 : 0.96, options,
      'gunshot', this.combatBus || this.master);
    if (!out) return;
    // El primer transiente da lectura inmediata; la cola grave conserva peso
    // a distancia y el crack extra distingue el impacto directo en un cuerpo.
    this._noiseShot(direct ? 1.18 : 1.02, direct ? 0.56 : 0.5,
      direct ? 880 : 700, 82, direct ? 1.9 : 1.6, out);
    this._noiseShot(direct ? 0.62 : 0.46, direct ? 0.28 : 0.22,
      direct ? 3100 : 2400, 560, 1.2, out);
    this._tone('sine', direct ? 78 : 70, 30, direct ? 0.82 : 0.7,
      direct ? 0.62 : 0.5, out);
    if (direct) this._tone('square', 240, 68, 0.12, 0.11, out);
  }
  // rebote metálico del bote de humo contra el suelo/paredes
  nadeBounce(options = null) {
    if (this._playAt('nade_bounce', options?.position, 'impact', {})) return;
    const out = this._eventOutput(0.5, options, 'impact', this.combatBus || this.master);
    if (!out) return;
    this._noiseShot(0.18, 0.05, 4800, 1700, 2.2, out);
    this._tone('sine', 1500 + Math.random() * 500, 700, 0.09, 0.08, out);
  }
  // siseo del humo activándose
  smokePop(options = null) {
    if (this._playAt('smoke_hiss', options?.position, 'impact', {})) return;
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
    const name = IMPACT_OF[surface] ?? 'imp_concrete';
    if (this.bank.ready(name, 0)) {
      // jitter por contacto: dos perdigones no suenan como un solo golpe
      if (this._playAt(name, position, 'impact', { at: now + this._impactCount * 0.011, force: this._impactCount > 0 })) this._impactCount++;
      return;
    }
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

  // ---------- recarga, cambio, seco ----------
  // Secuencia programada sobre la duración REAL de la recarga del arma; la
  // pieza final suena en reloadDone, en el instante exacto en que el
  // cargador queda lleno. Cancelar (melee, disparo, cambio) corta lo pendiente.
  // `progress` (0..1) reanuda una recarga ya empezada (fin de una pausa):
  // solo se programan las piezas que faltan, contadas desde ese punto.
  reload(wep = null, duration = 0, progress = 0) {
    if (!wep || !(duration > 0) || !this.engine) {
      if (!progress && (!wep || !this.engine)) this._tone('square', 700, 500, 0.07, 0.04);
      return;
    }
    this.reloadCancel();
    const t0 = this._now();
    const T = (k) => ({ at: t0 + (k - progress) * duration, tag: 'reload' });
    const cue = (name, k) => k < progress || this._play(name, T(k));
    let ok = true;
    if (wep === 'smg') ok = cue('mag_out', 0.15) && cue('mag_in', 0.62);
    else if (wep === 'pistol') ok = cue('mag_out_light', 0.12) && cue('mag_in_light', 0.55);
    else if (wep === 'sniper') ok = cue('bolt_open', 0.08) && cue('round_in', 0.5);
    else if (wep === 'bazooka') ok = cue('tube_slide', 0.25);
    else if (wep === 'stun') ok = cue('stun_charge', 0.15);
    // escopeta: cada cartucho suena al insertarse (shellIn), sin pieza inicial
    if (!ok && wep !== 'shotgun' && !progress) this._tone('square', 700, 500, 0.07, 0.04);
  }
  reloadDone(wep = null) {
    const piece = { smg: 'rack', pistol: 'slide_release', sniper: 'bolt_close', bazooka: 'tube_lock', stun: 'ready_chirp' }[wep];
    if (wep === 'shotgun' && this._play('pump', { at: this._now() + 0.08, tag: 'pump' })) {
      this._pumpAt = this._now() + 0.08; return;
    }
    if (piece && this._play(piece)) return;
    this._tone('square', 900, 1200, 0.08, 0.05);
  }
  reloadCancel() {
    this.engine?.stopTag('reload', 0.04);
  }
  // Pausa offline: las piezas programadas en tiempo de audio se cortan; el
  // bombeo que aún no sonó guarda lo que le faltaba para reanudarse igual.
  reloadPause() {
    this.reloadCancel();
    const left = (this._pumpAt ?? 0) - this._now();
    if (left > 0) { this._pumpLeft = left; this.engine?.stopTag('pump', 0.02); }
    this._pumpAt = 0;
  }
  reloadResume() {
    if (this._pumpLeft > 0 && this._play('pump', { at: this._now() + this._pumpLeft, tag: 'pump' })) {
      this._pumpAt = this._now() + this._pumpLeft;
    }
    this._pumpLeft = 0;
  }
  shellIn() {
    if (!this._play('shell_in')) this._tone('square', 900, 1200, 0.08, 0.05);
  }
  swap(target = null) {
    this.reloadCancel();
    this.engine?.stopTag('pump', 0.04);
    const light = target === 'pistol' || target === 'stun' || target === 'frag' || target === 'grenade';
    if (!this._play(light ? 'swap_light' : 'swap_heavy')) this._tone('square', 700, 500, 0.07, 0.04);
  }
  dry() {
    if (!this._play('dry')) this._tone('square', 1800, 1500, 0.04, 0.02);
  }

  // ---------- feedback de combate ----------
  hit(head = false) {
    if (this._play(head ? 'hit_head' : 'hit_tick')) return;
    this._tone('sine', head ? 1500 : 1150, 900, 0.14, 0.045);
  }
  kill(head = false) {
    if (this._play(head ? 'kill_head' : 'kill_confirm')) return;
    this._tone('sine', 500, 150, 0.3, 0.25); this._noiseShot(0.2, 0.2, 900, 200);
  }
  // Daño recibido con dirección: paneo hacia quien disparó (dato del golpe o,
  // si no llega, el último disparo enemigo que pasó cerca).
  hurt(options = null) {
    let src = options?.position ?? null;
    if (!src && this._threat && this._now() - this._threat.t < 0.7) src = this._threat;
    let pan = 0;
    const L = src ? this._listenerPose() : null;
    if (L) {
      const dx = src.x - L.x, dz = src.z - L.z;
      const d = Math.hypot(dx, dz) || 1;
      const right = L.right ?? { x: 1, z: 0 };
      pan = ((dx * right.x + dz * right.z) / d) * 0.55;
    }
    const amount = options?.amount ?? 20;
    if (this._play('hurt', { pan, volume: Math.max(0.55, Math.min(1.3, 0.55 + amount / 40)) })) return;
    this._tone('sawtooth', 220, 90, 0.2, 0.12);
  }
  death() {
    this._heartNext = 0;
    this._stopHandling();
    if (!this._play('death')) this._tone('sawtooth', 320, 60, 0.35, 0.5);
  }
  respawn() { this._play('respawn'); }
  protectionEnd() { this._play('prot_end'); }

  // ---------- recogidas y pedestal ----------
  crate() { if (!this._play('crate')) this._tone('square', 900, 1200, 0.08, 0.05); }
  ammoPickup() { if (!this._play('ammo_pickup')) this._tone('square', 900, 1200, 0.08, 0.05); }
  weaponPickup() {
    this._stopHandling(); // el arma en mano cambió: la recarga pendiente no sigue
    if (!this._play('weapon_pickup')) this._tone('square', 900, 1200, 0.08, 0.05);
  }
  specialTaken() {
    this._stopHandling();
    this.engine?.loop('pedestal_hold')?.stop(0.05);
    if (!this._play('special_taken')) this._tone('square', 900, 1200, 0.08, 0.05);
  }
  specialSpawn(position = null) { this._playAt('pedestal_spawn', position, 'gunshot', {}); }

  // ---------- movimiento ----------
  whoosh() { if (!this._play('whoosh')) this._noiseShot(0.22, 0.16, 500, 2400, 0.6); }
  meleeSwing() { if (!this._play('melee_swing')) this.whoosh(); }
  slide() { if (!this._play('slide')) this.whoosh(); }
  dive() { if (!this._play('dive')) this.whoosh(); }
  mantle() {
    if (this._play('mantle')) return;
    this.footstep('jump', 0.9);
    this.whoosh();
  }
  electric(options = null) {
    if (this._playAt('stun_zap', options?.position, 'impact', {})) return;
    const out = this._eventOutput(0.55, options, 'impact', this.combatBus || this.master); if (!out) return;
    this._tone('sawtooth', 1250, 130, 0.10, 0.22, out); this._noiseShot(0.12, 0.16, 3500, 700, 1.6, out);
  }
  grenadeTick(options = null) {
    if (this._playAt('fuse_tick', options?.position, 'impact', {})) return;
    const out = this._eventOutput(0.22, options, 'impact', this.combatBus || this.master); if (out) this._tone('square', 1450, 1700, 0.08, 0.055, out);
  }
  throwNade(options = null) { if (!this._playAt('throw', options?.position, 'impact', {})) this.whoosh(); }
  // contacto con la cobertura (nombre heredado: thump)
  thump() {
    if (this._play('cover_hit')) return;
    this._tone('sine', 110, 55, 0.4, 0.11); this._noiseShot(0.12, 0.07, 500, 150);
  }
  meleeImpact(options = null, lethal = false) {
    if (this._playAt('melee_hit', options?.position, 'impact', { volume: lethal ? 1.2 : 1, pitch: lethal ? 0.9 : 1 })) return;
    const out = this._eventOutput(lethal ? 0.78 : 0.66, options,
      'impact', this.combatBus || this.master);
    if (!out) return;
    // Golpe grave (masa) + crack corto (contacto de arma/armadura).
    this._tone('sine', lethal ? 105 : 125, 48, lethal ? 0.26 : 0.19,
      lethal ? 0.19 : 0.14, out);
    this._noiseShot(lethal ? 0.42 : 0.32, 0.075, 1250, 220, 1.45, out);
    this._tone('triangle', 620, 190, 0.055, 0.055, out);
  }
  jump() {
    if (this._play('jump')) return;
    this.footstep('jump'); this._noiseShot(0.1, 0.09, 800, 2300, 0.6);
  }
  land() { this.footstep('land'); }

  // ---------- ronda, menú y lobby ----------
  win() {
    if (this._play('match_win')) return;
    for (const [f, d] of [[520, 0], [660, 0.12], [780, 0.24]]) setTimeout(() => this._tone('sine', f, f, 0.25, 0.3), d * 1000);
  }
  uiMove() { if (!this._play('ui_move')) this._tone('sine', 690, 760, 0.035, 0.035); }
  uiConfirm() { if (!this._play('ui_confirm')) this._tone('triangle', 410, 620, 0.065, 0.075); }
  uiBack() { if (!this._play('ui_back')) this._tone('triangle', 620, 410, 0.06, 0.07); }
  lobbyEnter() {
    if (this._play('lobby_enter')) return;
    this._tone('triangle', 220, 360, 0.09, 0.13);
    setTimeout(() => this._tone('sine', 520, 620, 0.06, 0.11), 85);
  }
  playerJoined() { if (!this._play('player_joined')) this._tone('sine', 990, 1320, 0.05, 0.12); }
  countdown(value = 3) {
    const last = value <= 1;
    if (this._play('count_tick', { pitch: last ? 1.5 : 1 })) return;
    this._tone('square', last ? 560 : 420, last ? 760 : 470, last ? 0.14 : 0.09, last ? 0.13 : 0.08);
  }
  roundStart() {
    this._lastRoundStart = this._now();
    if (this._play('count_go')) return;
    this._tone('triangle', 260, 520, 0.15, 0.18);
    setTimeout(() => this._tone('sine', 720, 880, 0.11, 0.16), 95);
  }
  roundEnd() { if (!this._play('round_end')) this._tone('triangle', 460, 230, 0.12, 0.24); }
  defeat() { if (!this._play('match_lose')) this._tone('sawtooth', 260, 95, 0.12, 0.34); }
  mvp() {
    if (this._play('mvp')) return;
    for (const [f, d] of [[330, 0], [440, 0.09], [660, 0.2]]) {
      setTimeout(() => this._tone('triangle', f, f * 1.05, 0.075, 0.16), d * 1000);
    }
  }

  // ---------- diagnóstico (window.BREACH_AUDIO.debug) ----------
  get debug() {
    const eng = this.engine;
    return {
      started: eng ? eng.started : {},
      stats: eng ? eng.stats : null,
      voices: eng ? eng.activeCount() : 0,
      liveNodes: eng ? eng.liveNodes() : 0,
      totalNodes: eng ? eng.totalNodes() : 0,
      pendingRenders: this.bank.pending,
      renderMs: +this.bank.totalMs.toFixed(1),
      maxJobMs: +this.bank.maxJobMs.toFixed(1),
      worker: this._useWorker,
      renderer: this._renderer ?? null,
      pcmMB: +(this.bank.pcmBytes() / 1e6).toFixed(2),
      space: eng?.space ?? null,
      state: this.ctx?.state ?? 'none',
    };
  }

  // Recarga y bombeo programados: mueren con el jugador o con su arma.
  _stopHandling() {
    this.engine?.stopTag('reload', 0.04);
    this.engine?.stopTag('pump', 0.04);
  }

  // Acción de arma cancelada por el juego (aturdido, muerte por snapshot,
  // espectador, reinicio de armas): corta recarga y bombeo programados.
  cancelHandling() {
    this._stopHandling();
  }

  // Fin de partida / salida al menú: nada del gameplay sigue sonando.
  stopGameplay() {
    this._stopHandling();
    this._heartNext = 0;
    const eng = this.engine;
    if (!eng) return;
    for (let i = 0; i < this._rocketSlots.length; i++) {
      this._rocketSlots[i] = null;
      eng.loop('rocket_loop', `rocket${i}`)?.stop(0.1);
    }
    eng.loop('pedestal_hum')?.stop(0.3);
    eng.loop('pedestal_hold')?.stop(0.05);
    this._pedestal = null;
    eng.stopBuses(['combat', 'world'], 0.08);
  }
}

// Blindaje: ningún método público del audio puede lanzar hacia el juego (un
// fallo de WebAudio jamás corta un cambio de mapa ni el arranque de partida).
const audioFaults = new Set();
function audioFault(key, e) {
  if (audioFaults.has(key)) return;
  audioFaults.add(key);
  console.warn(`[audio] ${key} falló y se ignoró:`, e?.message ?? e);
}
for (const key of Object.getOwnPropertyNames(Audio.prototype)) {
  if (key === 'constructor' || key.startsWith('_')) continue;
  const desc = Object.getOwnPropertyDescriptor(Audio.prototype, key);
  if (typeof desc.value !== 'function') continue;
  const fn = desc.value;
  Audio.prototype[key] = function guarded(...args) {
    try {
      const r = fn.apply(this, args);
      return r && typeof r.then === 'function' ? r.catch((e) => audioFault(key, e)) : r;
    } catch (e) {
      audioFault(key, e);
      return undefined;
    }
  };
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
