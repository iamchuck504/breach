// Registro de sonidos + render en segundo plano. Portado de Crashterra
// (src/audio/bank.ts). Cada SoundDef tiene un `gen` que renderiza una variante
// a Float32Array (ver dsp.js); el Bank las renderiza por prioridad (`order`
// más bajo primero) y crea los AudioBuffer perezosamente al primer uso.
// Añadido para Breach: defs `external` (los samples MP3 decodificados por el
// navegador entran al mismo pool de voces sin pasar por el render).
import { R, SR } from './dsp.js';

export class Bank {
  defs = new Map();
  data = new Map();
  bufs = new WeakMap();
  ext = new Map();
  last = new Map();
  queue = [];
  qi = 0;
  done = 0;
  genMs = new Map();
  /** Trabajo individual más largo en ms (detector de tirones). */
  maxJobMs = 0;
  totalMs = 0;
  seed;
  /** En el navegador: soltar el PCM en cuanto existe su AudioBuffer (no duplicar memoria). */
  releasePcm = false;

  constructor(seed = 0x5eed) {
    this.seed = seed;
  }

  add(name, d) {
    const def = {
      name,
      variants: 3,
      bus: 'combat',
      prio: 50,
      db: 0,
      group: name,
      max: 4,
      gap: 0.03,
      steal: true,
      pitchVar: 0.04,
      dbVar: 1.5,
      // envío a la cola acústica del mapa (0 = seco)
      send: 0,
      order: 5,
      loop: false,
      cat: 'misc',
      roundRobin: false,
      external: false,
      ...d,
    };
    if (def.external) def.variants = 1;
    this.defs.set(name, def);
    this.data.set(name, new Array(def.variants).fill(null));
  }

  /** Cola de render (tras todos los add()): dentro de cada banda, la variante 0 de todo primero. */
  plan() {
    const list = [...this.defs.values()].filter((d) => !d.external).sort((a, b) => a.order - b.order);
    this.queue = [];
    const maxV = Math.max(1, ...list.map((d) => d.variants));
    const bands = new Map();
    for (const d of list) {
      const b = bands.get(d.order) ?? [];
      b.push(d);
      bands.set(d.order, b);
    }
    for (const order of [...bands.keys()].sort((a, b) => a - b)) {
      const band = bands.get(order);
      for (let v = 0; v < maxV; v++) for (const d of band) if (v < d.variants) this.queue.push([d, v]);
    }
    this.qi = 0;
  }

  /** Variantes aún sin render/recibir. */
  get pending() {
    return this.queue.length - this.done;
  }

  get total() {
    return this.queue.length;
  }

  /** Renderiza trabajos hasta agotar `budgetMs`. true cuando todo está listo. */
  step(budgetMs) {
    const t0 = performance.now();
    while (this.qi < this.queue.length) {
      const [d, v] = this.queue[this.qi++];
      if (this.ready(d.name, v)) continue;
      this.renderOne(d, v);
      if (performance.now() - t0 >= budgetMs) break;
    }
    return this.qi >= this.queue.length;
  }

  /** Renderiza la siguiente variante de la cola y la devuelve (lado worker). */
  renderNext() {
    while (this.qi < this.queue.length) {
      const [d, v] = this.queue[this.qi++];
      if (this.ready(d.name, v)) continue;
      const t = performance.now();
      this.renderOne(d, v);
      return { name: d.name, v, ch: this.pcm(d.name, v), ms: performance.now() - t };
    }
    return null;
  }

  /** Acepta una variante renderizada en otro hilo (el worker). */
  accept(name, v, ch, ms) {
    const arr = this.data.get(name);
    if (!arr || arr[v]) return;
    arr[v] = ch;
    this.done++;
    this.genMs.set(name, (this.genMs.get(name) ?? 0) + ms);
    this.totalMs += ms;
    if (ms > this.maxJobMs) this.maxJobMs = ms;
  }

  renderAll() {
    while (!this.step(1e9));
  }

  renderOne(d, v) {
    const t = performance.now();
    const r = new R((this.seed ^ hash(d.name)) + v * 7919);
    const ch = d.gen(r, v);
    for (const c of ch) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) c[i] = 0;
    const arr = this.data.get(d.name);
    if (!arr[v]) this.done++;
    arr[v] = ch;
    const ms = performance.now() - t;
    this.genMs.set(d.name, (this.genMs.get(d.name) ?? 0) + ms);
    this.totalMs += ms;
    if (ms > this.maxJobMs) this.maxJobMs = ms;
  }

  /** PCM crudo de una variante (null mientras no se renderizó). */
  pcm(name, v) {
    return this.data.get(name)?.[v] ?? null;
  }

  /** Bytes de PCM residentes (presupuesto de memoria). */
  pcmBytes() {
    let n = 0;
    for (const arr of this.data.values()) for (const ch of arr) if (ch) for (const c of ch) n += c.byteLength;
    return n;
  }

  /** Fuerza el render de un sonido ahora (uso offline). */
  ensure(name) {
    const d = this.defs.get(name);
    if (!d || d.external) return;
    const arr = this.data.get(name);
    for (let v = 0; v < d.variants; v++) if (!arr[v]) this.renderOne(d, v);
  }

  /** Siguiente variante (aleatoria sin repetir inmediata, o round-robin). */
  pick(d, rnd) {
    const n = d.variants;
    if (n <= 1) return 0;
    const last = this.last.get(d.name) ?? -1;
    let v;
    if (d.roundRobin) v = (last + 1) % n;
    else {
      v = Math.floor(rnd * (n - 1));
      if (v >= last && last >= 0) v++;
      if (v >= n) v = n - 1;
    }
    this.last.set(d.name, v);
    return v;
  }

  /** Sample decodificado por el navegador para un def `external`. */
  setExternal(name, buffer) {
    if (this.defs.get(name)?.external && buffer) this.ext.set(name, buffer);
  }

  /** AudioBuffer de una variante, creado al primer uso. null si el PCM no está. */
  buffer(ctx, name, v) {
    const ext = this.ext.get(name);
    if (ext) return ext;
    let m = this.bufs.get(ctx);
    if (!m) this.bufs.set(ctx, (m = new Map()));
    let arr = m.get(name);
    if (!arr) m.set(name, (arr = []));
    const have = arr[v];
    if (have) return have;
    const ch = this.pcm(name, v);
    if (!ch) return null;
    const b = ctx.createBuffer(ch.length, ch[0].length, SR);
    for (let i = 0; i < ch.length; i++) b.copyToChannel(ch[i], i);
    arr[v] = b;
    if (this.releasePcm) this.data.get(name)[v] = RELEASED;
    return b;
  }

  ready(name, v) {
    if (this.ext.has(name)) return true;
    return !!this.data.get(name)?.[v];
  }
}

// marcador de variante ya convertida a AudioBuffer (cuenta como lista)
const RELEASED = Object.freeze([]);

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
