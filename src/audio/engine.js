// Mezclador en tiempo real. Portado de Crashterra (src/audio/engine.ts):
// grafo de buses + limitador maestro con soft-clip, pool FIJO de voces
// (cadena filtro → ganancia → paneo persistente; por reproducción solo se
// crea la fuente y su envolvente), canales de loop persistentes.
// Diferencias para Breach (PvP en tercera persona):
//   - la espacialización NO vive aquí: el facade (src/fx/audio.js) calcula la
//     mezcla con spatialAudioMix + oclusión por rayo y la pasa en `o.mix`;
//   - buses propios del juego: combat (con su compresor de pegamento), world
//     (pasos/foley, nunca comprimido ni duckeado), ui, amb y music;
//   - envío por voz a una cola acústica por mapa (un ConvolverNode compartido).

import { SR as SR_BANK } from './dsp.js';

export const MAX_VOICES = 32;
export const EAR_OPEN_HZ = 20000;

const dbToLin = (db) => Math.pow(10, db / 20);

class Voice {
  src = null;
  env = null;
  bus = null;
  def = null;
  start = 0;
  end = 0;
  prio = 0;
  owner = '';
  tag = '';
  base = 0;
  constructor(ctx, spaceIn) {
    this.f = ctx.createBiquadFilter();
    this.f.type = 'lowpass';
    this.f.frequency.value = 20000;
    this.f.Q.value = 0.5;
    this.g = ctx.createGain();
    this.p = ctx.createStereoPanner();
    this.s = ctx.createGain();
    this.s.gain.value = 0;
    this.f.connect(this.g).connect(this.p);
    this.p.connect(this.s).connect(spaceIn);
  }
}

/** Canal de loop persistente (vuelo del cohete, pedestal, cama del menú). */
export class LoopCh {
  src = null;
  running = false;
  constructor(eng, name, def, bus) {
    this.eng = eng;
    this.name = name;
    this.def = def;
    const ctx = eng.ctx;
    this.f = ctx.createBiquadFilter();
    this.f.type = 'lowpass';
    this.f.frequency.value = 20000;
    this.f.Q.value = 0.5;
    this.g = ctx.createGain();
    this.g.gain.value = 0;
    this.p = ctx.createStereoPanner();
    this.s = ctx.createGain();
    this.s.gain.value = 0;
    this.f.connect(this.g).connect(this.p).connect(bus);
    this.p.connect(this.s).connect(eng.spaceIn);
  }
  /** Arranca en silencio (hasta set()). false si el buffer aún no está renderizado. */
  start(offset = 0) {
    if (this.running) return true;
    const buf = this.eng.bank.buffer(this.eng.ctx, this.name, 0);
    if (!buf) return false;
    const s = this.eng.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(this.f);
    s.start(this.eng.ctx.currentTime, offset % buf.duration);
    this.eng.nodeLive += 1;
    s.onended = () => {
      s.disconnect();
      this.eng.nodeLive -= 1;
    };
    this.src = s;
    this.running = true;
    return true;
  }
  /** Ganancia (lineal; el nivel del def se aplica aquí), rate, corte, paneo y envío, suavizados. */
  set(gain, rate = 1, cut = 20000, pan = 0, tau = 0.04, send = this.def.send) {
    if (!this.running) return;
    const t = this.eng.ctx.currentTime;
    const g = gain * dbToLin(this.def.db);
    this.g.gain.setTargetAtTime(g, t, tau);
    this.s.gain.setTargetAtTime(g * send, t, tau);
    if (this.src) this.src.playbackRate.setTargetAtTime(rate, t, tau);
    this.f.frequency.setTargetAtTime(cut, t, tau);
    this.p.pan.setTargetAtTime(pan, t, tau);
  }
  stop(fade = 0.15) {
    if (!this.running) return;
    const t = this.eng.ctx.currentTime;
    this.g.gain.cancelScheduledValues(t);
    this.g.gain.setTargetAtTime(0, t, fade / 4);
    this.s.gain.cancelScheduledValues(t);
    this.s.gain.setTargetAtTime(0, t, fade / 4);
    this.src?.stop(t + fade);
    this.src = null;
    this.running = false;
  }
}

export class Engine {
  voices = [];
  loops = new Map();
  lastStart = new Map();
  /** Nodos transitorios vivos (fuentes + envolventes). */
  nodeLive = 0;
  started = {};
  stats = { played: 0, dropped: 0, stolen: 0, gapSkipped: 0, notReady: 0, culled: 0, peakVoices: 0 };

  constructor(ctx, bank, dest = ctx.destination) {
    this.ctx = ctx;
    this.bank = bank;
    const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.combat = G();
    this.world = G();
    this.ui = G();
    this.amb = G();
    this.music = G();
    this.ambDuck = G();
    this.musicDuck = G();
    this.spaceIn = G();
    this.spaceOut = G(0);
    // sin ConvolverNode utilizable el juego suena igual, solo sin cola de sala
    try {
      this.convolver = ctx.createConvolver();
      this.convolver.normalize = false;
    } catch {
      this.convolver = null;
    }
    this.pre = G();
    // Oído (primera persona): paso bajo común a combate, mundo, ambiente y
    // sala. Una explosión cercana lo cierra un instante y vuelve solo
    // (earMuffle): pesa en graves sin pico doloroso de agudos. La interfaz
    // (confirmación de impacto) no pasa por aquí: sigue legible.
    this.ear = ctx.createBiquadFilter();
    this.ear.type = 'lowpass';
    this.ear.frequency.value = EAR_OPEN_HZ;
    this.ear.Q.value = -3; // Butterworth (Q en dB en el paso bajo de WebAudio): sin realce en el corte
    // Pegamento del bus de combate: mismos parámetros que el compresor que
    // Breach ya tenía (varias armas a la vez no saturan; pasos y UI quedan fuera).
    this.combatComp = ctx.createDynamicsCompressor();
    this.combatComp.threshold.value = -10;
    this.combatComp.knee.value = 14;
    this.combatComp.ratio.value = 5;
    this.combatComp.attack.value = 0.004;
    this.combatComp.release.value = 0.16;
    // Limitador maestro rápido + soft-clip detrás: la suma nunca pasa de 1.0.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -4;
    this.comp.knee.value = 3;
    this.comp.ratio.value = 16;
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.14;
    this.clipIn = G(0.5);
    this.clip = ctx.createWaveShaper();
    this.clip.curve = softClipCurve();
    this.master = G();
    this.ear.connect(this.pre);
    this.combat.connect(this.combatComp).connect(this.ear);
    this.world.connect(this.ear);
    this.ui.connect(this.pre);
    this.amb.connect(this.ambDuck).connect(this.ear);
    this.music.connect(this.musicDuck).connect(this.pre);
    if (this.convolver) this.spaceIn.connect(this.convolver).connect(this.spaceOut);
    this.spaceOut.connect(this.ear);
    this.pre.connect(this.comp).connect(this.clipIn).connect(this.clip).connect(this.master).connect(dest);
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(ctx, this.spaceIn));
    this.persistentNodes = 23 + MAX_VOICES * 4;
    this.space = null;
  }

  busNode(b) {
    return b === 'world' ? this.world : b === 'ui' ? this.ui : b === 'amb' ? this.amb
      : b === 'music' ? this.music : this.combat;
  }

  /** Cola acústica del mapa: IR renderizado en el banco + nivel de retorno. */
  // Devuelve true cuando ya no hace falta reintentar (listo, sin IR o fallo
  // definitivo). Nunca lanza: una cola de sala jamás puede cortar un cambio
  // de mapa.
  setSpace(irName, level) {
    const t = this.ctx.currentTime;
    if (this.space?.name === irName && this.space.ready) {
      this.spaceOut.gain.setTargetAtTime(level, t, 0.3);
      return true;
    }
    this.space = { name: irName, level, ready: false };
    this.spaceOut.gain.setTargetAtTime(0, t, 0.1);
    if (!irName) return true;
    const pcm = this.bank.pcm(irName, 0);
    if (!pcm || !pcm.length) return false; // aún renderizando: update() reintenta
    try {
      // el ConvolverNode exige la frecuencia real del contexto (48 kHz en
      // muchos equipos): el IR se remuestrea, nunca se asigna a 44.1 kHz
      const buf = resampledBuffer(this.ctx, pcm, SR_BANK);
      const conv = this.ctx.createConvolver();
      conv.normalize = false;
      conv.buffer = buf;
      // un convolver nuevo por IR: reasignar buffer en caliente no es portable
      if (this.convolver) {
        try { this.spaceIn.disconnect(this.convolver); } catch { /* no conectado */ }
        this.convolver.disconnect();
      }
      this.convolver = conv;
      this.spaceIn.connect(conv).connect(this.spaceOut);
      this.space.ready = true;
      this.spaceOut.gain.setTargetAtTime(level, t, 0.3);
    } catch (e) {
      console.warn('[audio] cola del mapa desactivada:', e?.message ?? e);
      this.space.failed = true;
    }
    return true;
  }

  /** Duck breve de ambiente/música (explosiones cercanas). Nunca toca pasos ni combate. */
  duck(depthDb, hold = 0.25, release = 0.9) {
    const t = this.ctx.currentTime;
    const v = dbToLin(-Math.abs(depthDb));
    for (const g of [this.ambDuck.gain, this.musicDuck.gain]) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(v, t, 0.02);
      g.setTargetAtTime(1, t + hold, release / 4);
    }
  }

  /**
   * Oído cerrado por una explosión cercana: el corte baja a `hz` ya, se
   * sostiene `hold` s y vuelve a abierto con una rampa exponencial de
   * `recover` s (lineal en octavas). Una segunda explosión más débil no abre
   * un oído que ya está más cerrado.
   */
  earMuffle(hz, hold = 0.08, recover = 0.9) {
    const t = this.ctx.currentTime;
    const f = this.ear.frequency;
    const cur = f.value;
    const target = Math.max(200, Math.min(EAR_OPEN_HZ, Math.min(hz, cur < EAR_OPEN_HZ * 0.98 ? cur : hz)));
    f.cancelScheduledValues(t);
    f.setValueAtTime(target, t);
    f.setValueAtTime(target, t + hold);
    f.exponentialRampToValueAtTime(EAR_OPEN_HZ, t + hold + recover);
    this.earUntil = t + hold + recover;
    return target;
  }

  isActive(v, now) {
    return !!v.def && now < v.end;
  }

  activeCount() {
    const now = this.ctx.currentTime;
    let n = 0;
    for (const v of this.voices) if (this.isActive(v, now)) n++;
    return n;
  }

  /**
   * o: { mix:{gain,pan,cut,occluded}, volume, pitch, at, pan, variant, tag,
   *      owner, force, send, cut, prio, tail }. Devuelve la voz o null (no listo/cap/culled).
   * tail: { after, db, tau } — recorte de cola: pasado `after` s del inicio,
   * la voz baja `db` dB con constante `tau` (disparo propio en primera
   * persona: cuerpo intacto, cola que deja oír pasos enseguida).
   */
  play(name, o = {}) {
    const def = this.bank.defs.get(name);
    // motivo del último rechazo: el facade solo cae al sintetizador original
    // si el sonido aún no existe ('missing'/'notReady'), nunca por un tope
    this.lastReject = 'missing';
    if (!def || def.loop) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const at = Math.max(now, o.at ?? now);
    const last = this.lastStart.get(def.group);
    if (!o.force && last !== undefined && at - last < def.gap && at >= last) {
      this.stats.gapSkipped++;
      this.lastReject = 'gap';
      return null;
    }
    const v = o.variant !== undefined ? Math.min(def.variants - 1, o.variant) : this.bank.pick(def, Math.random());
    const buf = this.bank.buffer(ctx, name, v);
    if (!buf) {
      this.stats.notReady++;
      this.lastReject = 'notReady';
      return null;
    }
    const mix = o.mix;
    const base = dbToLin(def.db + (Math.random() * 2 - 1) * def.dbVar) * (o.volume ?? 1) * (mix ? mix.gain : 1);
    if (base < 0.0015) {
      this.stats.culled++;
      this.lastReject = 'culled';
      return null;
    }
    const pan = mix ? mix.pan : (o.pan ?? 0);
    const cut = Math.min(o.cut ?? 20000, mix && mix.cutoff < 18500 ? Math.max(500, mix.cutoff) : 20000);
    // prioridad por evento: un paso enemigo cercano pesa más que uno aliado
    const prio = o.prio ?? def.prio;
    // tope por grupo
    // dentro del grupo lleno se roba la de MENOR prioridad (y más vieja) que
    // no nos supere: un paso aliado nunca corta uno enemigo
    let groupN = 0;
    let victim = null;
    for (const x of this.voices) {
      if (x.def && x.def.group === def.group && this.isActive(x, now)) {
        groupN++;
        if (x.prio > prio) continue;
        if (!victim || x.prio < victim.prio || (x.prio === victim.prio && x.start < victim.start)) victim = x;
      }
    }
    let slot = null;
    if (groupN >= def.max) {
      if (!def.steal || !victim) {
        this.stats.dropped++;
        this.lastReject = 'cap';
        return null;
      }
      slot = victim;
    }
    if (!slot) {
      for (const x of this.voices) if (!this.isActive(x, now)) { slot = x; break; }
    }
    if (!slot) {
      // robar la voz de menor prioridad (y más vieja) que no nos supere
      let best = null;
      for (const x of this.voices) {
        const xp = x.prio;
        if (xp > prio) continue;
        if (!best || xp < best.prio || (xp === best.prio && x.start < best.start)) best = x;
      }
      if (!best) {
        this.stats.dropped++;
        this.lastReject = 'cap';
        return null;
      }
      slot = best;
    }
    if (this.isActive(slot, now)) {
      this.stats.stolen++;
      this.release(slot, 0.012);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = (o.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * def.pitchVar);
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    if (o.tail && o.tail.db > 0) {
      const ta = at + Math.max(0, o.tail.after);
      env.gain.setValueAtTime(1, ta);
      env.gain.setTargetAtTime(dbToLin(-o.tail.db), ta, Math.max(0.005, o.tail.tau ?? 0.04));
    }
    src.connect(env).connect(slot.f);
    this.nodeLive += 2;
    src.onended = () => {
      src.disconnect();
      env.disconnect();
      this.nodeLive -= 2;
      if (slot.src === src) slot.src = null;
    };
    if (slot.bus !== def.bus) {
      if (slot.bus) slot.p.disconnect(this.busNode(slot.bus));
      slot.p.connect(this.busNode(def.bus));
      slot.bus = def.bus;
    }
    const gp = slot.g.gain;
    gp.cancelScheduledValues(now);
    gp.setValueAtTime(base, now);
    slot.base = base;
    const send = (o.send ?? def.send) * base;
    slot.s.gain.cancelScheduledValues(now);
    slot.s.gain.setValueAtTime(send, now);
    slot.p.pan.cancelScheduledValues(now);
    slot.p.pan.setValueAtTime(pan, now);
    slot.f.frequency.cancelScheduledValues(now);
    slot.f.frequency.setValueAtTime(cut, now);
    slot.f.Q.setValueAtTime(mix?.occluded ? 0.72 : 0.5, now);
    src.start(at);
    slot.src = src;
    slot.env = env;
    slot.def = def;
    slot.prio = prio;
    slot.start = at;
    slot.end = at + buf.duration / rate + 0.02;
    slot.owner = o.owner ?? '';
    slot.tag = o.tag ?? '';
    this.lastStart.set(def.group, at);
    this.started[name] = (this.started[name] ?? 0) + 1;
    this.stats.played++;
    const act = this.activeCount();
    if (act > this.stats.peakVoices) this.stats.peakVoices = act;
    return slot;
  }

  /** Funde la fuente actual de una voz y libera el slot. */
  release(v, fade = 0.03) {
    const now = this.ctx.currentTime;
    if (v.src && v.env) {
      const e = v.env.gain;
      e.cancelScheduledValues(now);
      e.setValueAtTime(e.value, now);
      e.linearRampToValueAtTime(0, now + fade);
      // una fuente programada a futuro (secuencia de recarga) muere sin sonar
      v.src.stop(now + fade + 0.005);
    }
    v.src = null;
    v.env = null;
    v.def = null;
    v.end = 0;
    v.owner = '';
    v.tag = '';
    v.pausedVoice = null;
  }

  stopWhere(pred, fade = 0.03) {
    const now = this.ctx.currentTime;
    let n = 0;
    for (const v of this.voices) if (this.isActive(v, now) && pred(v)) { this.release(v, fade); n++; }
    return n;
  }

  /** Baja un instante las voces que cumplan `pred` (−db, sostiene `hold`, vuelve en `release`). */
  duckVoices(pred, db, hold = 0.05, release = 0.08) {
    const now = this.ctx.currentTime;
    const k = dbToLin(-Math.abs(db));
    let n = 0;
    for (const v of this.voices) {
      if (!this.isActive(v, now) || !pred(v)) continue;
      const g = v.g.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(v.base, now);
      g.setTargetAtTime(v.base * k, now, 0.002);
      g.setTargetAtTime(v.base, now + hold, release / 3);
      n++;
    }
    return n;
  }

  // Congela el cursor de una muestra ya emitida y conserva su variante y
  // mezcla. Al reanudar no se emite otra pisada ni se reinicia el silbido.
  pauseTag(tag, paused) {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.tag !== tag || !v.src || !this.isActive(v, now)) continue;
      const rate = v.src.playbackRate;
      if (paused && !v.pausedVoice) {
        v.pausedVoice = { rate: rate.value, left: v.end - now };
        rate.setValueAtTime(0, now);
        v.env.gain.setValueAtTime(0, now);
        v.end = Infinity;
      } else if (!paused && v.pausedVoice) {
        rate.setValueAtTime(v.pausedVoice.rate, now);
        v.env.gain.setValueAtTime(1, now);
        v.end = now + v.pausedVoice.left;
        v.pausedVoice = null;
      }
    }
  }

  stopTag(tag, fade = 0.03) {
    return this.stopWhere((v) => v.tag === tag, fade);
  }

  /** Canal de loop; `key` permite varias instancias del mismo sonido (cohetes). */
  loop(name, key = name) {
    let l = this.loops.get(key);
    if (l) return l;
    const def = this.bank.defs.get(name);
    if (!def || !def.loop) return null;
    l = new LoopCh(this, name, def, this.busNode(def.bus));
    this.loops.set(key, l);
    return l;
  }

  stopBuses(buses, fade = 0.04) {
    return this.stopWhere((v) => !!v.def && buses.includes(v.def.bus), fade);
  }

  liveNodes() {
    return this.nodeLive;
  }

  totalNodes() {
    return this.persistentNodes + this.loops.size * 5 + this.nodeLive;
  }
}

/** AudioBuffer a la frecuencia del contexto (interpolación lineal). */
export function resampledBuffer(ctx, pcm, srcRate) {
  const rate = ctx.sampleRate || srcRate;
  const k = srcRate / rate;
  const n = Math.max(1, Math.round(pcm[0].length / k));
  const b = ctx.createBuffer(pcm.length, n, rate);
  for (let c = 0; c < pcm.length; c++) {
    const x = pcm[c];
    const y = rate === srcRate ? x : new Float32Array(n);
    if (rate !== srcRate) {
      for (let i = 0; i < n; i++) {
        const p = i * k, i0 = Math.floor(p), f = p - i0;
        y[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f;
      }
    }
    b.copyToChannel(y, c);
  }
  return b;
}

/**
 * Soft-clip alimentado a media ganancia: la entrada [-2, 2] cae en [-1, 1].
 * Lineal (ganancia unidad) hasta 0.8, luego rodilla tanh que satura en 0.985.
 */
export function softClipCurve() {
  const n = 4097;
  const c = new Float32Array(n);
  const knee = 0.8;
  const ceil = 0.985;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}
