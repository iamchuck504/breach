// Verificación sin oídos del motor de audio (src/audio + src/fx/audio.js),
// solo Node. Portado del espíritu de tools/audio-sfx.mjs de Crashterra:
//   1. banco: render completo, tiempo, memoria, tabla de sonoridad; ninguno
//      mudo ni saturado, variantes distintas, loops sin salto, IRs con cola;
//   2. cobertura: cada evento del juego arranca el sonido que le toca (facade
//      real sobre un AudioContext simulado);
//   3. mezcla de 8 jugadores (10 s de combate scriptado con el facade real),
//      renderizada offline con el mismo grafo: pico ≤ 1, reducción del
//      limitador acotada, pasos enemigos audibles sobre el combate;
//   4. fugas: 20 "rondas" seguidas sin crecimiento de nodos ni voces colgadas.
// Uso: node scripts/check-audio-bank.mjs [--table]
// Los samples MP3 entran a la mezcla si hay ffmpeg (si no, se avisa).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from '../src/audio/analysis.js';
import { SR } from '../src/audio/dsp.js';
import { MAX_VOICES, softClipCurve } from '../src/audio/engine.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

/* ------------------------------------------------ entorno de navegador simulado */

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
let sampleBytes = null;
function decodeSample(file) {
  try {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(root, 'public', file),
      '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 64 << 20 });
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
  } catch { return null; }
}
globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => ({ url }) });

class Param {
  constructor(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
let nodeCount = 0;
class Node {
  constructor(ctx) { this.ctx = ctx; this.outs = new Set(); nodeCount++; }
  connect(n) { this.outs.add(n); return n; }
  disconnect(n) { if (n) this.outs.delete(n); else this.outs.clear(); }
}
class MockBuffer {
  constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this.ch = []; }
  copyToChannel(data, i) { this.ch[i] = data; }
  getChannelData(i) { return (this.ch[i] ??= new Float32Array(this.length)); }
}
class Source extends Node {
  constructor(ctx) { super(ctx); this.playbackRate = new Param(1); this.loop = false; this.onended = null; this.startAt = null; this.stopAt = Infinity; }
  start(t = 0, offset = 0) { this.startAt = t; this.offset = offset; this.ctx.live.add(this); }
  stop(t = 0) { this.stopAt = Math.min(this.stopAt, t); }
}
class MockCtx {
  constructor() { this.currentTime = 0; this.sampleRate = mockRate; this.state = 'running'; this.destination = new Node(this); this.live = new Set(); }
  createGain() { const n = new Node(this); n.gain = new Param(1); return n; }
  createBiquadFilter() { const n = new Node(this); n.type = 'lowpass'; n.frequency = new Param(350); n.Q = new Param(1); return n; }
  createStereoPanner() { const n = new Node(this); n.pan = new Param(0); return n; }
  createDynamicsCompressor() {
    const n = new Node(this);
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param(0);
    return n;
  }
  createWaveShaper() { const n = new Node(this); n.curve = null; return n; }
  // como Chrome: un IR a otra frecuencia que la del contexto lanza NotSupportedError
  createConvolver() {
    if (mockConvolverBroken) throw new Error('NotSupportedError: convolver roto (prueba)');
    const n = new Node(this); n.normalize = true; let b = null;
    Object.defineProperty(n, 'buffer', { get: () => b, set: (v) => {
      if (v && v.sampleRate !== this.sampleRate) throw new Error(`NotSupportedError: IR a ${v.sampleRate} Hz en contexto de ${this.sampleRate} Hz`);
      b = v;
    } });
    return n;
  }
  createOscillator() { const n = new Source(this); n.frequency = new Param(440); n.type = 'sine'; return n; }
  createBufferSource() { return new Source(this); }
  createBuffer(ch, len, sr) { return new MockBuffer(ch, len, sr); }
  async decodeAudioData(ab) {
    const pcm = sampleBytes?.[ab.url] ?? null;
    const b = new MockBuffer(1, pcm ? pcm.length : Math.round(SR * 0.3), SR);
    b.ch[0] = pcm ?? new Float32Array(b.length);
    return b;
  }
  resume() { return Promise.resolve(); }
  // avanza el reloj y dispara onended de las fuentes que terminaron
  advance(dt) {
    this.currentTime += dt;
    for (const s of [...this.live]) {
      const len = s.buffer ? s.buffer.duration / (s.playbackRate.value || 1) : 0.3;
      const end = s.loop ? s.stopAt : Math.min(s.stopAt, (s.startAt ?? 0) + len);
      if (this.currentTime >= end) { this.live.delete(s); s.onended?.(); }
    }
  }
}
let mockRate = SR;
let mockConvolverBroken = false;
globalThis.window = { AudioContext: MockCtx };

const { Audio, SPACE_PROFILES } = await import('../src/fx/audio.js');
const { SAMPLE_FILES } = await import('../src/audio/catalog.js');

/* ---------------------------------------------------------------- 1. banco */

const audio = new Audio();
const bank = audio.bank;
const t0 = performance.now();
bank.renderAll();
const renderMs = performance.now() - t0;
const mb = bank.pcmBytes() / 1e6;
let renders = 0;
const rows = [];
for (const d of bank.defs.values()) {
  if (d.external) continue;
  const ms = [];
  for (let v = 0; v < d.variants; v++) {
    const pcm = bank.pcm(d.name, v);
    renders++;
    ms.push(measure(pcm, d.cat === 'ir' ? 1 : Math.pow(10, d.db / 20)));
  }
  const avg = (k) => ms.reduce((s, m) => s + m[k], 0) / ms.length;
  // correlación máxima entre variantes (mismo diseño repetido = metralla)
  let maxCorr = 0;
  for (let a = 0; a < d.variants; a++) for (let b = a + 1; b < d.variants; b++) {
    const x = bank.pcm(d.name, a)[0], y = bank.pcm(d.name, b)[0];
    const n = Math.min(x.length, y.length);
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < n; i++) { xy += x[i] * y[i]; xx += x[i] * x[i]; yy += y[i] * y[i]; }
    maxCorr = Math.max(maxCorr, Math.abs(xy) / Math.sqrt(xx * yy + 1e-12));
  }
  const ch = bank.pcm(d.name, 0).length;
  rows.push({ name: d.name, cat: d.cat, v: d.variants, ch, dur: avg('dur'), peak: Math.max(...ms.map((m) => m.peakDb)),
    rawPeak: Math.max(...ms.map((m) => m.peakDb - (d.cat === 'ir' ? 0 : d.db))),
    lufs: avg('lufsMax'), cent: avg('centroid'), corr: maxCorr });
  const r = rows.at(-1);
  check(r.rawPeak > -45, `${d.name}: casi mudo (${r.rawPeak.toFixed(1)} dBFS)`);
  check(r.rawPeak <= -0.1, `${d.name}: satura (${r.rawPeak.toFixed(2)} dBFS)`);
  if (d.variants > 1) check(maxCorr < 0.98, `${d.name}: variantes casi idénticas (corr ${maxCorr.toFixed(3)})`);
  if (d.loop) {
    // el salto final→inicio no debe destacar sobre el paso típico entre muestras
    for (const c of bank.pcm(d.name, 0)) {
      let acc = 0;
      for (let i = 1; i < c.length; i++) acc += (c[i] - c[i - 1]) ** 2;
      const typical = Math.sqrt(acc / (c.length - 1));
      const jump = Math.abs(c[c.length - 1] - c[0]);
      check(jump <= Math.max(0.01, 4 * typical), `${d.name}: el loop salta (${jump.toFixed(3)} vs ${typical.toFixed(3)} típico)`);
    }
  }
}
for (const sp of Object.values(SPACE_PROFILES)) {
  const ir = bank.pcm(sp.ir, 0);
  check(ir && ir.length === 2 && ir[0].length > SR * 0.4, `${sp.ir}: IR ausente o sin cola`);
}
check(mb < 40, `PCM del banco ${mb.toFixed(1)} MB (> 40 MB)`);
check(bank.maxJobMs < 400, `trabajo de render más largo ${bank.maxJobMs.toFixed(0)} ms`);
const weaponsFirst = bank.queue.findIndex(([d]) => d.order > 0) > 0 &&
  bank.queue.slice(0, bank.queue.findIndex(([d]) => d.order > 0)).every(([d]) => d.cat === 'weapon');
check(weaponsFirst, 'la banda de armas no se renderiza primero');

const byCat = new Map();
for (const r of rows) {
  const c = byCat.get(r.cat) ?? { n: 0, v: 0, lufsMin: Infinity, lufsMax: -Infinity, peak: -Infinity };
  c.n++; c.v += r.v; c.lufsMin = Math.min(c.lufsMin, r.lufs); c.lufsMax = Math.max(c.lufsMax, r.lufs); c.peak = Math.max(c.peak, r.peak);
  byCat.set(r.cat, c);
}
console.log(`BANCO · ${bank.defs.size} defs (${rows.length} sintetizados + ${bank.defs.size - rows.length} samples) · ${renders} variantes · ${renderMs.toFixed(0)} ms · trabajo máx ${bank.maxJobMs.toFixed(0)} ms · ${mb.toFixed(1)} MB PCM`);
console.log('categoría      sonidos variantes  LUFS-max (min..max, con nivel de mezcla)  pico dB');
for (const [cat, c] of byCat) console.log(`  ${cat.padEnd(12)} ${String(c.n).padStart(4)} ${String(c.v).padStart(8)}      ${c.lufsMin.toFixed(1).padStart(6)} .. ${c.lufsMax.toFixed(1).padStart(6)}              ${c.peak.toFixed(1)}`);
if (process.argv.includes('--table')) {
  console.log('\nsonido               cat        var ch  dur s  pico dB  LUFS   centroide  corr');
  for (const r of rows) console.log(`  ${r.name.padEnd(18)} ${r.cat.padEnd(10)} ${String(r.v).padStart(2)} ${r.ch}  ${r.dur.toFixed(2).padStart(5)}  ${r.peak.toFixed(1).padStart(6)}  ${r.lufs.toFixed(1).padStart(5)}  ${Math.round(r.cent).toString().padStart(6)}  ${r.corr.toFixed(2)}`);
}

/* ------------------------------------------------- facade real + grabación */

sampleBytes = {};
let haveSamples = true;
for (const f of Object.values(SAMPLE_FILES)) {
  const pcm = decodeSample(f);
  if (!pcm) haveSamples = false;
  sampleBytes[f] = pcm;
}
if (!haveSamples) console.log('AVISO: sin ffmpeg, los samples MP3 entran mudos a la mezcla offline');
await audio.ensure();
const ctx = audio.ctx;
const eng = audio.engine;
const rec = [];
const realPlay = eng.play.bind(eng);
eng.play = (name, o = {}) => {
  const slot = realPlay(name, o);
  if (slot && recording) {
    rec.push({ name, at: slot.start, buf: slot.src.buffer, rate: slot.src.playbackRate.value, gain: slot.g.gain.value,
      send: slot.s.gain.value, pan: slot.p.pan.value, cut: slot.f.frequency.value, bus: slot.def.bus, prio: slot.prio });
  }
  return slot;
};
let recording = false;
// oyente fijo: jugador rojo en el origen mirando a -Z
let listener = { x: 0, y: 1.15, z: 0, right: { x: 1, z: 0 }, team: 'red' };
audio.setSpatialContext(() => listener, null);
audio.setSurfaceQuery(() => 'stone');
audio.setAmbience('fortaleza');
await audio.prepare();

/* ------------------------------------------------------- 2. cobertura de eventos */

const P = (x, z, y = 1.2) => ({ x, y, z });
const coverage = [
  ['gun smg propio', () => audio.gun('smg'), ['gun_smg', 'mech_smg', 'punch_light']],
  ['gun pistol propio', () => audio.gun('pistol'), ['gun_pistol', 'mech_pistol']],
  ['gun shotgun propio + bombeo', () => audio.gun('shotgun'), ['gun_shotgun', 'punch_heavy', 'pump']],
  ['gun sniper propio', () => audio.gun('sniper'), ['gun_sniper', 'punch_heavy']],
  ['gun bazooka propio', () => audio.gun('bazooka'), ['bazooka_fire']],
  ['disparo ajeno cercano', () => audio.gun('smg', { position: P(0, -8) }), ['gun_smg_remote']],
  ['disparo ajeno lejano', () => audio.gun('shotgun', { position: P(0, -60) }), ['gun_shotgun_remote', 'dist_heavy']],
  ['bazooka ajena (online)', () => audio.gun('bazooka', { position: P(10, -10) }), ['bazooka_fire']],
  ['silbido de bala enemiga', () => audio.gun('pistol', { position: P(0, -30), end: P(1, 10), team: 'blue' }), ['whiz']],
  ['chasquido de sniper enemigo', () => audio.gun('sniper', { position: P(0, -40), end: P(1.2, 20), enemy: true }), ['crack']],
  ['bala aliada no silba', () => audio.gun('pistol', { position: P(0, -30), end: P(1, 10), team: 'red' }), [], ['whiz']],
  ['recarga smg', () => { audio.reload('smg', 1.9); }, ['mag_out', 'mag_in']],
  ['fin recarga smg', () => audio.reloadDone('smg'), ['rack']],
  ['recarga pistola', () => { audio.reload('pistol', 1.35); audio.reloadDone('pistol'); }, ['mag_out_light', 'mag_in_light', 'slide_release']],
  ['cartucho + bombeo', () => { audio.shellIn(); audio.reloadDone('shotgun'); }, ['shell_in', 'pump']],
  ['recarga sniper', () => { audio.reload('sniper', 1.7); audio.reloadDone('sniper'); }, ['bolt_open', 'round_in', 'bolt_close']],
  ['recarga bazooka', () => { audio.reload('bazooka', 2.3); audio.reloadDone('bazooka'); }, ['tube_slide', 'tube_lock']],
  ['recarga aturdidor', () => { audio.reload('stun', 1.5); audio.reloadDone('stun'); }, ['stun_charge', 'ready_chirp']],
  ['cambio a pesada', () => audio.swap('smg'), ['swap_heavy']],
  ['cambio a ligera', () => audio.swap('pistol'), ['swap_light']],
  ['gatillo en seco', () => audio.dry(), ['dry']],
  ['impacto piedra', () => audio.impact(P(3, -4), 'stone'), ['imp_stone']],
  ['impacto metal', () => audio.impact(P(3, -4), 'metal'), ['imp_metal']],
  ['impacto hormigón', () => audio.impact(P(3, -4), 'concrete'), ['imp_concrete']],
  ['impacto vidrio', () => audio.impact(P(3, -4), 'glass'), ['imp_glass']],
  ['explosión cercana directa', () => audio.explosion({ position: P(4, -6), direct: true }), ['boom', 'boom_direct']],
  ['explosión lejana', () => audio.explosion({ position: P(0, -50) }), ['boom', 'boom_far']],
  ['rebote de bote', () => audio.nadeBounce({ position: P(2, -5) }), ['nade_bounce']],
  ['humo', () => audio.smokePop({ position: P(2, -5) }), ['smoke_hiss']],
  ['aturdidor', () => audio.electric({ position: P(2, -5) }), ['stun_zap']],
  ['espoleta', () => audio.grenadeTick({ position: P(2, -5) }), ['fuse_tick']],
  ['lanzar', () => audio.throwNade(), ['throw']],
  ['melee: golpe al aire', () => audio.meleeSwing(), ['melee_swing']],
  ['melee: impacto', () => audio.meleeImpact(null, true), ['melee_hit']],
  ['hit cuerpo', () => audio.hit(false), ['hit_tick']],
  ['hit cabeza', () => audio.hit(true), ['hit_head']],
  ['baja', () => audio.kill(false), ['kill_confirm']],
  ['baja a la cabeza', () => audio.kill(true), ['kill_head']],
  ['daño direccional', () => audio.hurt({ position: P(-5, 0), amount: 30 }), ['hurt']],
  ['muerte', () => audio.death(), ['death']],
  ['reaparición', () => audio.respawn(), ['respawn']],
  ['fin de protección', () => audio.protectionEnd(), ['prot_end']],
  ['caja', () => audio.crate(), ['crate']],
  ['munición', () => audio.ammoPickup(), ['ammo_pickup']],
  ['arma recogida', () => audio.weaponPickup(), ['weapon_pickup']],
  ['especial tomada', () => audio.specialTaken(), ['special_taken']],
  ['pedestal reaparece', () => audio.specialSpawn(P(5, -5, 0.9)), ['pedestal_spawn']],
  ['paso propio piedra', () => audio.footstep('run'), ['step_stone']],
  ['paso enemigo', () => audio.footstep('run', { position: P(3, -3, 0.22), team: 'blue' }), ['step_stone']],
  ['paso agachado (equipo)', () => audio.footstep('roadie'), ['step_stone', 'gear']],
  ['arrastre en cobertura', () => audio.footstep('shuffle'), ['step_scuff']],
  ['aterrizaje', () => audio.land(), ['land']],
  ['salto', () => audio.jump(), ['jump']],
  ['deslizamiento', () => audio.slide(), ['slide']],
  ['contacto con cobertura', () => audio.thump(), ['cover_hit']],
  ['evasión', () => audio.dive(), ['dive']],
  ['trepar', () => audio.mantle(), ['mantle']],
  ['whoosh', () => audio.whoosh(), ['whoosh']],
  ['ui mover', () => audio.uiMove(), ['ui_move']],
  ['ui confirmar', () => audio.uiConfirm(), ['ui_confirm']],
  ['ui volver', () => audio.uiBack(), ['ui_back']],
  ['entrar al lobby', () => audio.lobbyEnter(), ['lobby_enter']],
  ['jugador nuevo', () => audio.playerJoined(), ['player_joined']],
  ['cuenta atrás', () => { audio.countdown(3); }, ['count_tick']],
  ['inicio de ronda', () => audio.roundStart(), ['count_go']],
  ['fin de ronda', () => audio.roundEnd(), ['round_end']],
  ['victoria', () => audio.win(), ['match_win']],
  ['derrota', () => audio.defeat(), ['match_lose']],
  ['mvp', () => audio.mvp(), ['mvp']],
];
let covered = 0;
for (const [label, fn, expect, forbid = []] of coverage) {
  ctx.advance(1.5); // separa eventos: ni topes de grupo ni huecos mínimos interfieren
  const before = { ...eng.started };
  fn();
  const got = (n) => (eng.started[n] ?? 0) - (before[n] ?? 0);
  const miss = expect.filter((n) => got(n) <= 0);
  const extra = forbid.filter((n) => got(n) > 0);
  check(!miss.length && !extra.length, `cobertura: "${label}" ${miss.length ? 'no arrancó ' + miss.join(',') : ''}${extra.length ? ' arrancó ' + extra.join(',') : ''}`);
  if (!miss.length && !extra.length) covered++;
}
// por cuadro: cama del menú, latido, protección, pedestal, cohetes
const frame = { menu: true, playing: false, alive: true, hp01: 1, prot: 0, rockets: [], pedestal: null, holdT: 0, holdMax: 1 };
audio.update(1 / 60, frame);
check(eng.loops.get('menu_bed')?.running, 'cama del menú no arrancó en el menú');
frame.menu = false; frame.playing = true; frame.hp01 = 0.15;
const hb = eng.started.heartbeat ?? 0;
for (let i = 0; i < 120; i++) { ctx.advance(1 / 60); audio.update(1 / 60, frame); }
check((eng.started.heartbeat ?? 0) - hb >= 2, 'vida baja sin latido');
check(!eng.loops.get('menu_bed')?.running, 'la cama del menú sigue en partida');
frame.hp01 = 1;
const rocket = { x: 0, y: 1.5, z: -10 };
frame.rockets = [rocket];
frame.pedestal = { x: 5, y: 0, z: -5 };
frame.holdT = 0.5;
audio.update(1 / 60, frame);
check(eng.loops.get('rocket0')?.running, 'cohete en vuelo sin loop');
check(eng.loops.get('pedestal_hum')?.running && eng.loops.get('pedestal_hold')?.running, 'pedestal sin zumbido/agarre');
frame.rockets = []; frame.pedestal = null; frame.holdT = 0;
audio.update(1 / 60, frame);
check(!eng.loops.get('rocket0')?.running && !eng.loops.get('pedestal_hum')?.running, 'loops de cohete/pedestal no se detienen');
const resp = eng.started.respawn ?? 0;
ctx.advance(3);
frame.prot = 2; audio.update(1 / 60, frame);
frame.prot = 0; audio.update(1 / 60, frame);
check((eng.started.respawn ?? 0) > resp && (eng.started.prot_end ?? 0) > 0, 'protección de spawn sin aviso');
// la recarga interrumpida no deja piezas programadas sonando
audio.reload('smg', 1.9);
audio.reloadCancel();
ctx.advance(0.01);
check(!eng.voices.some((v) => v.tag === 'reload' && eng.isActive(v, ctx.currentTime)), 'recarga cancelada deja piezas programadas');
console.log(`COBERTURA · ${covered}/${coverage.length} eventos + 6 controladores por cuadro`);

/* --------------------------------------------- 3. mezcla de 8 jugadores offline */

ctx.advance(5);
const mixStart = ctx.currentTime;
rec.length = 0;
recording = true;
const DUR = 10;
const rnd = (() => { let a = 7; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296); })();
// 3 aliados + 4 enemigos alrededor, a 6–55 m; un enemigo camina hacia nosotros
const others = [
  { team: 'red', x: -6, z: 4, w: 'smg' }, { team: 'red', x: 8, z: 6, w: 'shotgun' }, { team: 'red', x: 3, z: 14, w: 'pistol' },
  { team: 'blue', x: -10, z: -24, w: 'smg' }, { team: 'blue', x: 14, z: -30, w: 'smg' }, { team: 'blue', x: -4, z: -55, w: 'sniper' },
  { team: 'blue', x: 6, z: -12, w: 'shotgun', walker: true },
];
const nextShot = others.map(() => rnd() * 0.5);
const nextStep = others.map(() => rnd() * 0.4);
let mySmg = 0, explosionDone = false;
const dt = 1 / 120;
for (let t = 0; t < DUR; t += dt) {
  ctx.advance(dt);
  // ráfagas propias de SMG: 1.2 s de cada 2.5 s a 620 rpm
  if ((t % 2.5) < 1.2 && t >= mySmg) { audio.gun('smg'); mySmg = t + 60 / 620; if (rnd() < 0.35) audio.hit(rnd() < 0.2); }
  others.forEach((o, i) => {
    if (o.walker) o.z = -12 + t * 0.6;
    const pos = { x: o.x, y: 1.35, z: o.z };
    if (t >= nextShot[i] && !(o.walker && t > 6)) {
      const rate = o.w === 'smg' ? 60 / 620 : o.w === 'sniper' ? 1.8 : o.w === 'shotgun' ? 0.7 : 0.25;
      const enemyAim = o.team === 'blue' && rnd() < 0.15;
      audio.gun(o.w, { position: pos, end: enemyAim ? { x: rnd() * 2 - 1, y: 1.2, z: 12 } : { x: o.x * 0.3, y: 1, z: o.z * 0.3 }, team: o.team });
      audio.impact({ x: o.x * 0.3, y: 1, z: o.z * 0.3 }, rnd() < 0.3 ? 'metal' : 'stone');
      nextShot[i] = t + rate * (o.w === 'smg' && rnd() < 0.1 ? 8 : 1);
    }
    if (t >= nextStep[i]) {
      audio.footstep('run', { position: { x: o.x, y: 0.22, z: o.z }, team: o.team });
      nextStep[i] = t + 0.36;
    }
  });
  if (!explosionDone && t > 6.5) { explosionDone = true; audio.explosion({ position: { x: 7, y: 0.5, z: -9 } }); }
}
recording = false;
const N = Math.ceil((DUR + 3) * SR);
const bus = { combat: [new Float32Array(N), new Float32Array(N)], other: [new Float32Array(N), new Float32Array(N)], send: new Float32Array(N) };
const stepMarks = [];
const hpA = Math.exp((-2 * Math.PI * 1000) / SR);
for (const r of rec) {
  const src = r.buf?.ch;
  if (!src?.[0]) continue;
  const s0 = Math.round((r.at - mixStart) * SR);
  const pl = Math.cos(((r.pan + 1) * Math.PI) / 4), pr = Math.sin(((r.pan + 1) * Math.PI) / 4);
  const a = Math.exp((-2 * Math.PI * Math.min(r.cut, 20000)) / SR);
  const out = r.bus === 'combat' ? bus.combat : bus.other;
  let y0 = 0, y1 = 0, lo = 0, band = 0;
  const isStep = r.name.startsWith('step_');
  const len = Math.floor(src[0].length / r.rate);
  for (let i = 0; i < len; i++) {
    const j = Math.floor(i * r.rate);
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const xl = src[0][j], xr = (src[1] ?? src[0])[j];
    y0 = xl + (y0 - xl) * a; y1 = xr + (y1 - xr) * a;
    // panner estéreo de WebAudio con fuente mono: ley de igual potencia
    if (src.length === 1) { out[0][k] += y0 * r.gain * pl; out[1][k] += y0 * r.gain * pr; }
    else { out[0][k] += y0 * r.gain; out[1][k] += y1 * r.gain; }
    bus.send[k] += y0 * r.send;
    if (isStep) { lo = y0 + (lo - y0) * hpA; band += ((y0 - lo) * r.gain) ** 2; }
  }
  if (isStep) stepMarks.push({ k: s0, len, band, enemy: r.prio >= 80 });
}
// compresor (modelo de alimentación directa: detector de pico, rodilla, ataque/liberación)
function compress(chs, { threshold, knee, ratio, attack, release }, grOut = null) {
  const aA = Math.exp(-1 / (attack * SR)), aR = Math.exp(-1 / (release * SR));
  let g = 0;
  for (let i = 0; i < chs[0].length; i++) {
    const x = db(Math.max(Math.abs(chs[0][i]), Math.abs(chs[1][i])));
    const over = x - threshold;
    let red = 0;
    if (over > knee / 2) red = over * (1 - 1 / ratio);
    else if (over > -knee / 2) red = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
    g = red > g ? aA * g + (1 - aA) * red : aR * g + (1 - aR) * red;
    const k = Math.pow(10, -g / 20);
    chs[0][i] *= k; chs[1][i] *= k;
    if (grOut) grOut[i] = g;
  }
}
compress(bus.combat, { threshold: eng.combatComp.threshold.value, knee: eng.combatComp.knee.value, ratio: eng.combatComp.ratio.value,
  attack: eng.combatComp.attack.value, release: eng.combatComp.release.value });
// cola del mapa: convolución por FFT del envío con el IR de la fortaleza
const ir = bank.pcm(SPACE_PROFILES.fortaleza.ir, 0);
const wet = [convolve(bus.send, ir[0], N), convolve(bus.send, ir[1], N)];
const pre = [new Float32Array(N), new Float32Array(N)];
const lvl = SPACE_PROFILES.fortaleza.level;
for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) pre[c][i] = bus.combat[c][i] + bus.other[c][i] + wet[c][i] * lvl;
let prePeak = 0;
for (const c of pre) for (const v of c) prePeak = Math.max(prePeak, Math.abs(v));
const gr = new Float32Array(N);
const lim = [pre[0].slice(), pre[1].slice()];
compress(lim, { threshold: eng.comp.threshold.value, knee: eng.comp.knee.value, ratio: eng.comp.ratio.value,
  attack: eng.comp.attack.value, release: eng.comp.release.value }, gr);
const curve = softClipCurve();
let peak = 0;
for (const c of lim) for (let i = 0; i < N; i++) {
  const x = Math.max(-1, Math.min(1, c[i] * 0.5));
  const pos = (x + 1) * 0.5 * (curve.length - 1);
  const i0 = Math.floor(pos), f = pos - i0;
  c[i] = curve[i0] * (1 - f) + (curve[Math.min(curve.length - 1, i0 + 1)] ?? 0) * f;
  peak = Math.max(peak, Math.abs(c[i]));
}
// reducción por ventanas de 50 ms con señal
const W = Math.round(SR * 0.05);
const grWin = [];
for (let s = 0; s + W <= N; s += W) {
  let e = 0, m = 0;
  for (let i = s; i < s + W; i++) { e += pre[0][i] ** 2; m = Math.max(m, gr[i]); }
  if (e / W > 1e-7) grWin.push(m);
}
const frac = (th) => grWin.filter((x) => x > th).length / Math.max(1, grWin.length);
// pasos sobre el combate: energía 1 kHz+ del paso frente al resto de la mezcla
// en su misma ventana (margen en dB). La regla de legibilidad exige que el
// enemigo quede claramente por encima del aliado a distancias parecidas.
const mixHp = new Float32Array(N);
{ let lo = 0; for (let i = 0; i < N; i++) { const m = (pre[0][i] + pre[1][i]) * 0.5; lo = m + (lo - m) * hpA; mixHp[i] = m - lo; } }
const margins = { enemy: [], friend: [] };
for (const m of stepMarks) {
  let e = 0;
  for (let i = m.k; i < Math.min(N, m.k + m.len); i++) e += mixHp[i] ** 2;
  margins[m.enemy ? 'enemy' : 'friend'].push(10 * Math.log10(m.band / Math.max(1e-12, e * 0.5 - m.band * 0.5)));
}
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : -Infinity; };
let rms = 0;
for (let i = 0; i < N; i++) rms += lim[0][i] ** 2 + lim[1][i] ** 2;
rms = Math.sqrt(rms / (2 * N));
console.log(`MEZCLA 8 JUGADORES · ${rec.length} voces en ${DUR}s · pico voces ${eng.stats.peakVoices}/${MAX_VOICES} · pico pre-limitador ${prePeak.toFixed(2)} · pico final ${peak.toFixed(3)} · RMS ${db(rms).toFixed(1)} dBFS · GR>3dB en ${(frac(3) * 100).toFixed(0)}% · GR>6dB en ${(frac(6) * 100).toFixed(0)}% · robadas ${eng.stats.stolen} · descartadas ${eng.stats.dropped}`);
check(peak <= 1, `pico de la mezcla ${peak.toFixed(3)} > 1`);
check(frac(3) < 0.25, `limitador bombeando: ${(frac(3) * 100).toFixed(0)}% de ventanas con más de 3 dB de reducción`);
check(eng.stats.peakVoices <= MAX_VOICES, 'voces por encima del pool');
console.log(`PASOS EN COMBATE · margen sobre el resto de la mezcla (1 kHz+): enemigo mediana ${median(margins.enemy).toFixed(1)} dB (${margins.enemy.length}), aliado ${median(margins.friend).toFixed(1)} dB (${margins.friend.length})`);
check(margins.enemy.length > 0, 'ningún paso enemigo sobrevivió a la mezcla de combate');
check(median(margins.enemy) > median(margins.friend) + 3, 'pasos enemigos no destacan sobre los aliados en combate');
if (haveSamples) fs.writeFileSync(path.join(process.env.TMPDIR || '/tmp', 'breach-mix8.f32'), Buffer.from(new Float32Array([...lim[0]]).buffer));

function convolve(x, h, n) {
  let size = 1;
  while (size < x.length + h.length) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(x); br.set(h);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
  }
  fft(ar, ai, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ar[i] / size;
  return out;
}
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
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

/* ------------------- 5. robustez: frecuencias de contexto, rechazos, balas */

const { bulletPass } = await import('../src/fx/audio.js');
for (const [rate, broken] of [[48000, false], [44100, false], [48000, true]]) {
  mockRate = rate; mockConvolverBroken = broken;
  const a = new Audio();
  a.bank.renderAll();
  let threw = null;
  try {
    await a.ensure();
    a.setSpatialContext(() => listener, null);
    for (const m of ['fortaleza', 'azoteas', 'calle2']) {
      a.setAmbience(m);
      a.update(1 / 60, { menu: false, playing: true, alive: true, hp01: 1, prot: 0, rockets: [], pedestal: null, holdT: 0, holdMax: 1 });
      const sp = a.engine.space;
      if (!broken) check(sp?.ready && a.engine.convolver.buffer?.sampleRate === rate, `${rate} Hz: cola de ${m} no lista (${JSON.stringify(sp)})`);
    }
    a.gun('smg');
    check((a.engine.started.gun_smg ?? 0) > 0 || !haveSamples, `${rate} Hz${broken ? ' (convolver roto)' : ''}: el disparo dejó de sonar`);
  } catch (e) { threw = e.message; }
  check(!threw, `${rate} Hz${broken ? ' con convolver roto' : ''}: el audio lanzó hacia el juego (${threw})`);
  a.setAmbience(null);
}
mockRate = SR; mockConvolverBroken = false;
// un método que falla por dentro nunca propaga la excepción
{
  const a = new Audio();
  a.engine = { play() { throw new Error('boom'); }, stopTag() { throw new Error('boom'); } };
  a.ctx = ctx;
  let threw = false;
  try { a.hit(); a.reload('smg', 1.9); a.death(); a.stopGameplay(); } catch { threw = true; }
  check(!threw, 'un fallo interno del audio se propagó al juego');
}
// grupo de pasos lleno: el aliado no roba al enemigo; el enemigo sí al aliado.
// Un rechazo deliberado tampoco cae al sintetizador sin gestionar.
ctx.advance(5);
for (let i = 0; i < 10; i++) audio.footstep('run', { position: { x: 2, y: 0.22, z: -2 - i * 0.1 }, team: 'blue' });
const enemySteps = () => eng.voices.filter((v) => v.def?.group === 'step' && eng.isActive(v, ctx.currentTime) && v.prio >= 80).length;
const e0 = enemySteps();
const n0 = nodeCount;
audio.footstep('run', { position: { x: 2, y: 0.22, z: -2 }, team: 'red' });
check(enemySteps() === e0 && e0 === 10, `un paso aliado robó a uno enemigo (${e0} → ${enemySteps()})`);
check(nodeCount - n0 <= 2, `un paso rechazado creó ${nodeCount - n0} nodos fuera del pool`);
ctx.advance(2);
for (let i = 0; i < 10; i++) audio.footstep('run', { position: { x: 2, y: 0.22, z: -2 - i * 0.1 }, team: 'red' });
audio.footstep('run', { position: { x: 2, y: 0.22, z: -2 }, team: 'blue' });
check(enemySteps() === 1, 'un paso enemigo no pudo entrar en un grupo lleno de aliados');
// bala detenida por un muro justo delante del oyente: no pasa a su lado
check(bulletPass({ x: 0, y: 1.2, z: -30 }, { x: 0, y: 1.2, z: -0.5 }, { x: 0.2, y: 1.15, z: 0.3, right: { x: 1, z: 0 } }) === null,
  'bulletPass silba más allá del impacto');
check(bulletPass({ x: 0, y: 1.2, z: -30 }, { x: 1, y: 1.2, z: 20 }, { x: 0, y: 1.15, z: 0, right: { x: 1, z: 0 } })?.dist < 1.2,
  'bulletPass no detecta una bala que pasa a 1 m');
// morir a mitad de recarga corta las piezas programadas
ctx.advance(2);
audio.reload('sniper', 1.7);
audio.death();
ctx.advance(0.01);
check(!eng.voices.some((v) => (v.tag === 'reload' || v.tag === 'pump') && eng.isActive(v, ctx.currentTime)), 'la recarga sigue sonando tras morir');
// el resto de caminos que cancelan la acción del arma (aturdido, muerte por
// snapshot/espectador, reinicio de armas, cambio, arma recogida, fin de partida)
for (const [label, cut] of [['cancelHandling', () => audio.cancelHandling()], ['swap', () => audio.swap('pistol')],
  ['weaponPickup', () => audio.weaponPickup()], ['specialTaken', () => audio.specialTaken()], ['stopGameplay', () => audio.stopGameplay()]]) {
  ctx.advance(2);
  audio.reload('smg', 1.9);
  audio.gun('shotgun');
  cut();
  ctx.advance(0.01);
  check(!eng.voices.some((v) => (v.tag === 'reload' || v.tag === 'pump') && eng.isActive(v, ctx.currentTime)), `${label}: la recarga/bombeo programados siguen sonando`);
}
ctx.advance(4);
console.log('ROBUSTEZ · 48/44.1 kHz, convolver roto, fallo interno, robo por prioridad, bala contra muro, recarga al morir');

/* ------------------------------------------------------------- 4. fugas */

const nodes = [];
for (let round = 0; round < 20; round++) {
  for (let i = 0; i < 60; i++) {
    audio.gun(i % 3 ? 'smg' : 'shotgun', i % 2 ? { position: { x: i, y: 1, z: -20 }, team: 'blue' } : null);
    audio.footstep('run', { position: { x: 4, y: 0.2, z: -i * 0.3 }, team: 'blue' });
    audio.impact({ x: 2, y: 1, z: -6 }, 'stone');
    if (i % 20 === 0) { audio.reload('smg', 1.9); audio.reloadCancel(); audio.explosion({ position: { x: 5, y: 1, z: -8 } }); }
    ctx.advance(0.05);
  }
  ctx.advance(4);
  nodes.push(eng.totalNodes());
}
const voicesLeft = eng.activeCount();
console.log(`FUGAS · nodos tras cada ronda ${nodes[1]} → ${nodes.at(-1)} · nodos transitorios vivos ${eng.liveNodes()} · voces activas ${voicesLeft}`);
check(nodes.at(-1) <= nodes[1], `los nodos crecen entre rondas: ${nodes[1]} → ${nodes.at(-1)}`);
check(eng.liveNodes() === 0 && voicesLeft === 0, 'quedan voces/nodos colgados tras 4 s de silencio');

if (fails.length) {
  console.error(`\nAUDIO BANK FALLO (${fails.length}):\n  ` + fails.join('\n  '));
  process.exit(1);
}
console.log('AUDIO BANK OK');
process.exit(0);
