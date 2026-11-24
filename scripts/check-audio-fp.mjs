// Audio en primera persona, sin oídos (solo Node). Render offline con la
// automatización real del motor (src/audio/offline.js: envolventes, recortes
// de cola, oído cerrado por explosiones, duck, compresores con compensación).
//   1. banco: confirmaciones (cuerpo/cabeza/baja) distintas entre sí, cortas
//      y sin altura; coste de render;
//   2. sincronía por eventos: cada reloadStep suena UNA vez (también saltando
//      cuadros), reloadCancel corta, la pausa congela el bombeo pendiente, los
//      métodos de línea de tiempo no duplican con el emisor enganchado;
//      todo paso de recarga de los perfiles (src/view/fp/profiles) tiene
//      sonido; el bombeo cae donde el viewmodel mueve la corredera;
//   3. disparo propio: tiempo durante el que tapa un paso enemigo a 10 m;
//   4. confirmación de impacto audible sobre el propio disparo;
//   5. explosión cercana: sin recorte, sonoridad acotada, agudos que se
//      apartan y vuelven;
//   6. pasos propios desde la cabeza: sin fondo agudo al esprintar,
//      agachado más bajo que andando;
//   7. tiroteo 4v4 sostenido: margen, voces, nada importante descartado,
//      pasos enemigos ≥ 3 dB sobre los aliados.
// Uso: node scripts/check-audio-fp.mjs [--verbose]
import { execFileSync } from 'node:child_process';
import { evalTrack } from '../src/view/fp/anim.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const warns = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
const dB = (x) => 10 * Math.log10(Math.max(1e-20, x));
const verbose = process.argv.includes('--verbose');
// el motor elige variante, tono y nivel con Math.random: semilla fija para
// que cada corrida mida exactamente lo mismo (--seed N para barrer otras)
{
  const si = process.argv.indexOf('--seed');
  let a = (si > 0 ? Number(process.argv[si + 1]) : 0x9e3779b9) >>> 0;
  Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const { SR } = await import('../src/audio/dsp.js');
const OFF = await import('../src/audio/offline.js');
const { measure, tonality } = await import('../src/audio/analysis.js');

/* ------------------------------------------------ entorno: contexto offline */

const pcmCache = new Map();
let haveSamples = true;
function decode(url) {
  if (pcmCache.has(url)) return pcmCache.get(url);
  let pcm = null;
  try {
    const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(root, 'public', url),
      '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 64 << 20 });
    pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
  } catch { haveSamples = false; }
  pcmCache.set(url, pcm);
  return pcm;
}
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
globalThis.fetch = async (url) => ({ ok: true, arrayBuffer: async () => ({ url }) });
const { Ctx } = OFF.createOfflineContext({ sampleRate: SR, decode });
globalThis.window = { AudioContext: Ctx };

const { Audio, FP_MIX, HANDLING_DELAYS, RELOAD_PIECES, reloadPieceFor } = await import('../src/fx/audio.js');
const { Weapons, reloadTimeline } = await import('../src/combat/weapons.js');
const { TUNING } = await import('../src/config/tuning.js');

const audio = new Audio();
const bank = audio.bank;
const tr0 = performance.now();
bank.renderAll();
const renderMs = performance.now() - tr0;
await audio.ensure();
if (!haveSamples) warns.push('sin ffmpeg: los MP3 del dueño entran mudos (disparos propios sin cuerpo)');
const ctx = audio.ctx;
const eng = audio.engine;
const rec = [];
const realPlay = eng.play.bind(eng);
eng.play = (name, o = {}) => {
  const slot = realPlay(name, o);
  if (slot) { slot.src._name = name; slot.src._prio = slot.prio; slot.src._tag = o.tag ?? ''; rec.push({ name, at: slot.start, src: slot.src, prio: slot.prio, o }); }
  return slot;
};
// Oyente = ojo (primera persona): 1.48 m sobre el suelo, mirando a −Z.
const L = { x: 0, y: 1.48, feetY: 0, z: 0, right: { x: 1, z: 0 }, team: 'red' };
audio.setSpatialContext(() => L, null);
audio.setSurfaceQuery(() => 'stone');
audio.setAmbience('fortaleza');
const step = 1 / 240;
const run = (sec, each) => { for (let t = 0; t < sec - 1e-9; t += step) { each?.(t); ctx.advance(step); } };
const settle = () => run(4);
const sounded = (r) => r.src.stopAt > r.at + 0.002; // no la cortaron antes de empezar
const since = (t) => rec.filter((r) => r.at >= t - 1e-6);
const render = (t0, t1, mute) => OFF.renderGraph(ctx, t0, t1, mute ? { mute } : {});
const env16 = (chs) => OFF.bandEnvelope(chs, SR, 1000, 6000, 10);

/* ----------------------------------------------------------------- 1. banco */

const pcm = (name, v = 0) => bank.pcm(name, v);
const feat = (name) => {
  const out = [];
  for (let v = 0; v < bank.defs.get(name).variants; v++) {
    const ch = pcm(name, v);
    const m = measure(ch);
    const x = ch[0];
    let lo = 0, tot = 0;
    const y = OFF.bandpass(x, SR, 0, 300);
    for (let i = 0; i < x.length; i++) { tot += x[i] * x[i]; lo += y[i] * y[i]; }
    // cuerpo: −20 dB de la envolvente de 5 ms
    const W = Math.round(SR * 0.005), e = [];
    for (let s = 0; s < x.length; s += W) { let a = 0; for (let i = s; i < Math.min(x.length, s + W); i++) a += x[i] * x[i]; e.push(a); }
    let im = 0; for (let i = 1; i < e.length; i++) if (e[i] > e[im]) im = i;
    let last = im; for (let i = im; i < e.length; i++) if (e[i] >= e[im] * 0.01) last = i;
    out.push({ cent: m.centroid, low: lo / tot, bodyMs: (last - im + 1) * 5, t: tonality(x) });
  }
  const avg = (k) => out.reduce((a, b) => a + b[k], 0) / out.length;
  return { cent: avg('cent'), low: avg('low'), bodyMs: Math.max(...out.map((o) => o.bodyMs)), dom: Math.max(...out.map((o) => o.t.domFrac)), note: Math.max(...out.map((o) => o.t.note)) };
};
const FB = {};
for (const n of ['hit_tick', 'hit_head', 'kill_confirm', 'kill_head', 'hurt', 'heartbeat']) FB[n] = feat(n);
for (const [n, f] of Object.entries(FB)) {
  check(f.dom <= 0.2 && f.note <= 0.6, `${n}: tiene altura (${(f.dom * 100).toFixed(0)} % en un parcial, nota ${f.note.toFixed(2)})`);
}
check(FB.hit_head.cent >= FB.hit_tick.cent * 1.5, `cabeza y cuerpo no se distinguen por brillo (${FB.hit_head.cent.toFixed(0)} vs ${FB.hit_tick.cent.toFixed(0)} Hz)`);
check(FB.kill_confirm.low >= 0.6 && FB.hit_tick.low <= 0.4, `la baja no pesa más que el impacto (graves <300 Hz: baja ${(FB.kill_confirm.low * 100).toFixed(0)} %, impacto ${(FB.hit_tick.low * 100).toFixed(0)} %)`);
check(FB.hit_tick.bodyMs <= 70 && FB.hit_head.bodyMs <= 90, `confirmación de impacto larga (cuerpo ${FB.hit_tick.bodyMs} ms, cabeza ${FB.hit_head.bodyMs} ms; máx 70/90)`);
check(FB.kill_confirm.bodyMs <= 260 && FB.kill_confirm.bodyMs >= FB.hit_tick.bodyMs * 2, `baja: duración fuera de rango (${FB.kill_confirm.bodyMs} ms)`);
check(FB.kill_head.cent >= FB.kill_confirm.cent * 1.3, `baja a la cabeza no se distingue de la baja (${FB.kill_head.cent.toFixed(0)} vs ${FB.kill_confirm.cent.toFixed(0)} Hz)`);
check(FB.hurt.bodyMs <= 160, `daño recibido largo (${FB.hurt.bodyMs} ms; máx 160): tapa información`);
console.log(`BANCO FP · render ${renderMs.toFixed(0)} ms · trabajo máx ${bank.maxJobMs.toFixed(0)} ms · confirmaciones: cuerpo ${FB.hit_tick.cent.toFixed(0)} Hz/${FB.hit_tick.bodyMs} ms, cabeza ${FB.hit_head.cent.toFixed(0)} Hz/${FB.hit_head.bodyMs} ms, baja ${FB.kill_confirm.cent.toFixed(0)} Hz/${FB.kill_confirm.bodyMs} ms (graves ${(FB.kill_confirm.low * 100).toFixed(0)} %), baja cabeza ${FB.kill_head.cent.toFixed(0)} Hz · peor parcial ${(Math.max(...Object.values(FB).map((f) => f.dom)) * 100).toFixed(0)} %`);
// coste: el banco del corrido 3 medía 440–500 ms y 60–100 ms de trabajo
// máximo en la Mac del dueño. En CI (máquina ~13× más lenta) solo se informa.
if (!process.env.CI) {
  check(renderMs < 900, `render del banco ${renderMs.toFixed(0)} ms (> 900)`);
  check(bank.maxJobMs < 150, `trabajo de render más largo ${bank.maxJobMs.toFixed(0)} ms (> 150)`);
}

/* ------------------------------------------- 2. sincronía por eventos del arma */

const W = new Weapons();
const prep2 = (w, mag) => {
  if (!W.slots.includes(w)) W.slots[0] = w;
  if (!W.state[w]) W.state[w] = W._freshState(w);
  W.cur = w; W.swapT = 0; W.state[w].reload = 0; W.state[w].mag = mag; W.state[w].reserve = 99;
};
W.infinite = true;
check(audio.attachWeapons(W), 'attachWeapons no se enganchó al emisor');
const evLog = [];
for (const ev of ['reloadStep', 'reloadCancel', 'swapStart', 'swapMid', 'dry', 'throwStart', 'throwRelease']) W.on(ev, (d) => evLog.push({ ev, name: d?.name, at: ctx.currentTime }));
const tick = (dt, fire = false, pressed = false) => { W.update(dt, fire, pressed, true, true); ctx.advance(dt); };
const pieces = (t0, list) => since(t0).filter((r) => list.includes(r.name));
// (a) cada paso UNA vez, también con cuadros largos (0.1 s)
for (const [w, dt] of [['smg', 1 / 60], ['smg', 0.1], ['pistol', 1 / 60], ['sniper', 1 / 30], ['bazooka', 1 / 60]]) {
  settle();
  W.slots = ['smg', 'shotgun', 'pistol', 'sniper', 'bazooka', 'smoke'].filter((k) => TUNING.weapons[k]);
  for (const k of W.slots) if (!W.state[k]) W.state[k] = W._freshState(k);
  W.cur = w; W.swapT = 0;
  W.state[w].mag = Math.max(0, TUNING.weapons[w].mag - 1);
  W.state[w].reload = 0;
  evLog.length = 0;
  const t0 = ctx.currentTime;
  check(W.startReload(), `${w}: la recarga no arrancó`);
  for (let t = 0; t < TUNING.weapons[w].reloadTime + 0.3; t += dt) tick(dt);
  const steps = evLog.filter((e) => e.ev === 'reloadStep');
  const want = reloadTimeline(w).map((s) => s.step);
  check(JSON.stringify(steps.map((e) => e.name)) === JSON.stringify(want), `${w} @${dt.toFixed(3)}: pasos emitidos ${steps.map((e) => e.name)} ≠ ${want}`);
  for (const e of steps) {
    const piece = reloadPieceFor(w, e.name);
    const hits = since(t0).filter((r) => r.name === piece && Math.abs(r.at - e.at) < 0.002);
    check(hits.length === 1, `${w} @${dt.toFixed(3)}: ${e.name} sonó ${hits.length} veces en su instante (se espera 1 ${piece})`);
  }
  const all = pieces(t0, want.map((s) => reloadPieceFor(w, s)));
  check(all.length === want.length, `${w} @${dt.toFixed(3)}: ${all.length} piezas de recarga para ${want.length} pasos`);
}
// (b) escopeta: un cartucho por shellIn y el bombeo diferido hasta la corredera
{
  settle();
  W.cur = 'shotgun'; W.state.shotgun.mag = TUNING.weapons.shotgun.mag - 3; W.state.shotgun.reload = 0;
  evLog.length = 0;
  const t0 = ctx.currentTime;
  W.startReload();
  for (let t = 0; t < 3 * TUNING.weapons.shotgun.reloadTime + 0.6; t += 1 / 60) tick(1 / 60);
  const shells = evLog.filter((e) => e.name === 'shellIn').length;
  const ins = pieces(t0, ['shell_in']).length;
  const pumps = pieces(t0, ['pump']).filter(sounded);
  const pumpEv = evLog.find((e) => e.name === 'pump');
  check(shells === 3 && ins === 3, `escopeta: ${shells} shellIn → ${ins} shell_in (3 esperados)`);
  check(pumps.length === 1 && pumpEv && Math.abs(pumps[0].at - pumpEv.at - HANDLING_DELAYS.pumpAfterReload) < 0.003,
    `escopeta: bombeo final ${pumps.length} veces, retraso ${pumps[0] ? (pumps[0].at - (pumpEv?.at ?? 0)).toFixed(3) : '-'} s (esperado ${HANDLING_DELAYS.pumpAfterReload})`);
}
// (c) cancelar a mitad: suena lo hecho, nada de lo que falta, la pieza en curso se apaga
{
  settle();
  W.cur = 'smg'; W.state.smg.mag = 10; W.state.smg.reload = 0;
  evLog.length = 0;
  const t0 = ctx.currentTime;
  W.startReload();
  const rt = TUNING.weapons.smg.reloadTime;
  for (let t = 0; t < rt * 0.3; t += 1 / 60) tick(1 / 60);
  tick(1 / 60, true, true); // gatillo nuevo con balas: cancela (weapons.js)
  const tc = ctx.currentTime;
  for (let t = 0; t < rt; t += 1 / 60) tick(1 / 60);
  const after = since(tc).filter((r) => ['mag_in', 'rack'].includes(r.name));
  check(evLog.some((e) => e.ev === 'reloadCancel'), 'cancelar: weapons.js no emitió reloadCancel');
  check(after.length === 0, `cancelar: sonaron ${after.map((r) => r.name)} después de reloadCancel`);
  const out = since(t0).find((r) => r.name === 'mag_out');
  const ends = out ? Math.min(out.src.stopAt, out.at + out.src.buffer.duration / (out.src.playbackRate.v0 || 1)) : Infinity;
  check(ends <= tc + 0.06, `cancelar: la pieza en curso sigue ${((ends - tc) * 1000).toFixed(0)} ms tras reloadCancel (máx 60)`);
}
// (d) pausa: la lógica congelada no emite; el bombeo pendiente espera y suena una vez
{
  settle();
  W.cur = 'smg'; W.state.smg.mag = 0; W.state.smg.reload = 0;
  evLog.length = 0;
  W.startReload();
  const rt = TUNING.weapons.smg.reloadTime;
  for (let t = 0; t < rt * 0.3; t += 1 / 60) tick(1 / 60);
  audio.reloadPause();
  const tp = ctx.currentTime;
  run(2); // pausa: sin W.update
  audio.reloadResume();
  // main reprograma con el respaldo al reanudar: con el emisor no debe sonar nada
  audio.reload('smg', rt, 0.3);
  const during = since(tp).filter((r) => r.at < tp + 2);
  check(during.length === 0, `pausa: sonaron ${during.map((r) => r.name)} con la partida en pausa`);
  const tr = ctx.currentTime;
  for (let t = 0; t < rt; t += 1 / 60) tick(1 / 60);
  const rest = since(tr).filter((r) => ['mag_out', 'mag_in', 'rack'].includes(r.name));
  check(rest.map((r) => r.name).join() === 'mag_in,rack', `pausa: tras reanudar sonaron [${rest.map((r) => r.name)}] (se espera mag_in,rack una vez)`);
  // escopeta: pausa dentro del retraso del bombeo
  settle();
  W.cur = 'shotgun'; W.state.shotgun.mag = TUNING.weapons.shotgun.mag - 1; W.state.shotgun.reload = 0;
  evLog.length = 0;
  W.startReload();
  let tPump = null;
  for (let t = 0; t < 1.2 && tPump === null; t += 1 / 60) { tick(1 / 60); if (evLog.some((e) => e.name === 'pump')) tPump = ctx.currentTime; }
  run(0.1);
  audio.reloadPause();
  run(1.5);
  audio.reloadResume();
  run(1);
  const p = rec.filter((r) => r.name === 'pump' && r.at >= tPump - 0.02 && sounded(r));
  check(p.length === 1 && p[0].at > tPump + 1.5, `pausa: bombeo pendiente sonó ${p.length} veces (${p.map((r) => (r.at - tPump).toFixed(2))} s tras el evento; se espera 1, después de la pausa)`);
}
// (d2) pausa a mitad de recarga ANTES de cada paso, en cada arma: ninguna pieza
// suena en pausa, cada paso suena una vez al reanudar (ni perdido ni doble), y
// la escopeta bombea una vez. main al reanudar llama reload(…, progress): no-op.
{
  let nPause = 0;
  for (const w of ['smg', 'pistol', 'sniper', 'bazooka', 'shotgun']) {
    const rt = TUNING.weapons[w].reloadTime;
    const tl = w === 'shotgun' ? null : reloadTimeline(w);
    const points = tl ? tl.map((st) => Math.max(0.02, st.t - 0.05)) : [0.3, 1.2, 1.38 + 0.1];
    for (const pt of points) {
      settle();
      prep2(w, w === 'shotgun' ? TUNING.weapons.shotgun.mag - 3 : 0);
      evLog.length = 0;
      const t0 = ctx.currentTime;
      W.startReload();
      for (let t = 0; t < pt * (tl ? rt : 1); t += 1 / 60) tick(1 / 60);
      audio.reloadPause();
      const tp = ctx.currentTime;
      run(1.5);
      const tr = ctx.currentTime;
      audio.reloadResume();
      audio.reload(w, rt, pt);
      for (let t = 0; t < (tl ? rt : 3 * rt) + 0.8; t += 1 / 60) tick(1 / 60);
      run(0.6);
      const steps = evLog.filter((e) => e.ev === 'reloadStep');
      const pieces = since(t0).filter((r) => sounded(r) && Object.values(RELOAD_PIECES[w]).includes(r.name));
      const inPause = pieces.filter((r) => r.at > tp + 0.001 && r.at < tr - 0.001);
      check(inPause.length === 0, `pausa ${w}@${pt}: sonaron ${inPause.map((r) => r.name)} en pausa`);
      check(pieces.length === steps.length, `pausa ${w}@${pt}: ${pieces.length} piezas para ${steps.length} pasos (${pieces.map((r) => r.name)})`);
      if (w === 'shotgun') check(pieces.filter((r) => r.name === 'pump').length === 1, `pausa escopeta@${pt}: bombeo ${pieces.filter((r) => r.name === 'pump').length} veces`);
      nPause++;
    }
  }
  console.log(`PAUSA EN CADA PASO · ${nPause} casos: nada en pausa, cada paso una vez, bombeo una vez`);
}
// (e) cambio, seco, granada, y los métodos viejos no duplican
{
  settle();
  W.cur = 'smg'; W.state.smg.mag = 20; W.swapT = 0;
  evLog.length = 0;
  const t0 = ctx.currentTime;
  W.startSwap('pistol');
  for (let t = 0; t < 0.7; t += 1 / 60) tick(1 / 60);
  const hol = pieces(t0, ['holster_heavy', 'holster_light']), drw = pieces(t0, ['draw_light', 'draw_heavy']);
  const mid = evLog.find((e) => e.ev === 'swapMid');
  check(hol.length === 1 && hol[0].name === 'holster_heavy' && Math.abs(hol[0].at - t0) < 0.03, 'cambio: guardar la SMG no sonó una vez en swapStart');
  check(drw.length === 1 && drw[0].name === 'draw_light' && mid && Math.abs(drw[0].at - mid.at) < 0.002, 'cambio: sacar la pistola no sonó una vez en swapMid');
  const t1 = ctx.currentTime;
  audio.swap('smg'); audio.dry(); audio.shellIn(); audio.reloadDone('smg'); audio.reload('smg', 1.9); audio.throwNade();
  check(since(t1).length === 0, `con el emisor enganchado los métodos de línea de tiempo duplicaron: ${since(t1).map((r) => r.name)}`);
  W.cur = 'pistol'; W.state.pistol.mag = 0; W.state.pistol.reserve = 0; W.infinite = false;
  const t2 = ctx.currentTime;
  tick(1 / 60, true, true); tick(1 / 60, true, true);
  for (let i = 0; i < 9; i++) tick(1 / 60, false, false);
  tick(1 / 60, true, true);
  check(pieces(t2, ['dry']).length === 2, `seco: ${pieces(t2, ['dry']).length} chasquidos para 2 pulsaciones`);
  W.infinite = true;
}
// (e2) cada acción propia → exactamente un sonido de manejo/suelta, a 30, 60
// y 144 Hz y con cuadros saltados (0.1 s); y main puede seguir llamando los
// métodos viejos (throwNade sin posición, reload, swap…) sin duplicar.
{
  const HANDLE = ['throw', 'nade_ready', 'stun_zap', 'holster_heavy', 'holster_light', 'draw_heavy', 'draw_light', 'dry',
    'mag_out', 'mag_in', 'rack', 'mag_out_light', 'mag_in_light', 'slide_release', 'shell_in', 'pump', 'bolt_open', 'round_in',
    'bolt_close', 'tube_slide', 'tube_lock', 'swap_heavy', 'swap_light', 'whoosh'];
  const count = (t0) => { const c = {}; for (const r of since(t0)) if (HANDLE.includes(r.name) && sounded(r)) c[r.name] = (c[r.name] ?? 0) + 1; return c; };
  const legacy = () => { audio.throwNade(); audio.reload(W.cur, 1); audio.reloadDone(W.cur); audio.shellIn(); audio.swap(W.cur); audio.dry(); };
  const prep = (w, mag) => {
    if (!W.slots.includes(w)) W.slots[3] = w;
    if (!W.state[w]) W.state[w] = W._freshState(w);
    W.cur = w; W.swapT = 0; W.state[w].reload = 0; W.state[w].mag = mag; W._throw = null; W._quick = null; W._afterThrow = null;
  };
  const cases = [
    ['granada de humo', () => prep('grenade', 2), true, { nade_ready: 1, throw: 1 }],
    ['granada frag', () => prep('frag', 2), true, { nade_ready: 1, throw: 1 }],
    ['aturdidor', () => prep('stun', 4), true, { stun_zap: 1 }],
    ['recarga subfusil', () => { prep('smg', 0); W.startReload(); }, false, { mag_out: 1, mag_in: 1, rack: 1 }],
    ['recarga bazuca', () => { prep('bazooka', 0); W.state.bazooka.reserve = 2; W.startReload(); }, false, { tube_slide: 1, tube_lock: 1 }],
  ];
  let nCases = 0;
  for (const hz of [30, 60, 144, 10]) {
    for (const [label, setup, pull, want] of cases) {
      if (!TUNING.weapons[label.includes('frag') ? 'frag' : label.includes('humo') ? 'grenade' : label.includes('aturdidor') ? 'stun' : 'smg']) continue;
      settle();
      setup();
      const t0 = ctx.currentTime;
      let first = true;
      for (let t = 0; t < 2.6; t += 1 / hz) {
        const f = pull && first; first = false;
        W.update(1 / hz, f, f, true, true);
        if (pull && f) legacy(); // main: throwNade()/gun() en el mismo paso
        ctx.advance(1 / hz);
      }
      legacy();
      run(0.5);
      const got = count(t0);
      const ok = JSON.stringify(Object.keys(got).sort().map((k) => `${k}:${got[k]}`)) === JSON.stringify(Object.keys(want).sort().map((k) => `${k}:${want[k]}`));
      nCases++;
      check(ok, `${label} @${hz} Hz: sonidos de manejo ${JSON.stringify(got)} (se espera ${JSON.stringify(want)})`);
    }
  }
  W.slots[3] = 'grenade';
  console.log(`ACCIONES PROPIAS · ${nCases} casos: humo, frag, aturdidor, recargas — un sonido por paso a 30/60/144 Hz y a 10 Hz (cuadros saltados), métodos viejos sin duplicar`);
}
// (f) cada paso de recarga de los perfiles y de weapons.js tiene sonido
{
  const names = [];
  for (const [w, prof] of Object.entries(PROFILES)) {
    for (const key of ['reload', 'reloadEmpty']) {
      for (const st of prof[key]?.steps ?? []) {
        const piece = reloadPieceFor(w, st.step);
        names.push(`${w}.${st.step}`);
        check(piece && bank.defs.has(piece), `perfil ${w}: paso ${st.step} sin sonido`);
      }
      const logic = reloadTimeline(w).map((s) => `${s.t}:${s.step}`).join();
      const view = (prof[key]?.steps ?? []).map((s) => `${s.t}:${s.step}`).join();
      if (prof[key]?.steps?.length && w !== 'shotgun' && logic !== view) warns.push(`perfil ${w} (${key}) [${view}] ≠ weapons.js [${logic}]: la mano sigue a weapons.js`);
    }
  }
  for (const w of Object.keys(TUNING.weapons)) for (const st of reloadTimeline(w)) {
    check(reloadPieceFor(w, st.step), `weapons.js: ${w}.${st.step} sin sonido`);
    names.push(`${w}.${st.step}`);
  }
  // el bombeo cae cuando el viewmodel mueve la corredera (±30 ms)
  const sg = PROFILES.shotgun;
  const value = [0];
  const reach = (track, from, test) => {
    for (let i = Math.round(from * 1000); i <= 1000; i++) {
      if (test(evalTrack(track, i / 1000, value)[0])) return i / 1000;
    }
    throw new Error('La corredera no alcanzó el extremo de la pista');
  };
  const PUMP_BACK = 0.055, PUMP_FWD = 0.195; // golpes del sonido 'pump' (sfx-weapons.js)
  const al = [];
  if (sg.cycle?.tracks?.bolt) {
    const back = sg.cycle.delay + sg.cycle.dur * reach(sg.cycle.tracks.bolt, 0, (v) => v >= 0.97);
    const ub = reach(sg.cycle.tracks.bolt, 0, (v) => v >= 0.97);
    const fwd = sg.cycle.delay + sg.cycle.dur * reach(sg.cycle.tracks.bolt, ub, (v) => v <= 0.05);
    al.push(['tras el tiro', back, fwd, HANDLING_DELAYS.pumpAfterShot]);
  }
  const outro = sg.reload?.perShell?.outro;
  if (outro?.tracks?.bolt) {
    const ub = reach(outro.tracks.bolt, 0, (v) => v >= 0.97);
    al.push(['fin de recarga', outro.dur * ub, outro.dur * reach(outro.tracks.bolt, ub, (v) => v <= 0.05), HANDLING_DELAYS.pumpAfterReload]);
  }
  for (const [label, back, fwd, delay] of al) {
    const db_ = delay + PUMP_BACK - back, df = delay + PUMP_FWD - fwd;
    check(Math.abs(db_) <= 0.03 && Math.abs(df) <= 0.035, `bombeo ${label}: el sonido se separa de la corredera (atrás ${(db_ * 1000).toFixed(0)} ms, adelante ${(df * 1000).toFixed(0)} ms)`);
    if (verbose) console.log(`  bombeo ${label}: atrás ${(db_ * 1000).toFixed(0)} ms, adelante ${(df * 1000).toFixed(0)} ms`);
  }
  console.log(`SINCRONÍA · ${new Set(names).size} pasos de recarga con sonido · bombeo alineado con la corredera (${al.length} gestos) · cancelación, pausa y cuadros saltados OK si no hay fallos arriba`);
}
audio.detachWeapons();

/* --------------------------------------------- 3. disparo propio y pasos a 10 m */

// paso enemigo de referencia a 10 m: pico de banda 1–6 kHz
const stepRef = {};
for (const d of [10, 20]) {
  settle();
  const t0 = ctx.currentTime;
  for (let i = 0; i < 6; i++) { audio.footstep('run', { position: { x: d * 0.6, y: 0.22, z: -d * 0.8 }, team: 'blue' }); run(0.36); }
  const e = env16(render(t0, t0 + 2.2));
  const pk = [];
  for (let i = 0; i < 6; i++) { let m = 0; for (let k = i * 36; k < i * 36 + 20; k++) m = Math.max(m, e[k] ?? 0); pk.push(m); }
  pk.sort((a, b) => a - b);
  stepRef[d] = pk[3];
}
// presupuesto: el cuerpo del disparo (ms) en que se acepta tapar el paso
const MASK_BUDGET = { smg: 130, pistol: 170, shotgun: 250, sniper: 420, bazooka: 450 };
const own = {};
const mid3 = (a) => [...a].sort((x, y) => x - y)[1];
for (const w of ['smg', 'pistol', 'shotgun', 'sniper', 'bazooka']) {
  const reps = [];
  for (let k = 0; k < 3; k++) {
    settle();
    const t0 = ctx.currentTime;
    audio.gun(w);
    run(3);
    // el bombeo es mecanismo, se mide aparte
    const shot = render(t0, t0 + 3, (s) => s._name === 'pump');
    const e = env16(shot);
    const clear = (lvl) => { let last = 0; for (let i = 0; i < e.length; i++) if (e[i] >= lvl) last = i; return (last + 1) * 10; };
    const m = measure(shot);
    let pk = 0; for (const c of shot) for (const v of c) pk = Math.max(pk, Math.abs(v));
    const r = { mask10: clear(stepRef[10]), mask20: clear(stepRef[20]), lufs: m.lufsMax, peak: pk };
    if (w === 'shotgun') { const full = env16(render(t0, t0 + 3)); let last = 0; for (let i = 0; i < full.length; i++) if (full[i] >= stepRef[10]) last = i; r.withPump = (last + 1) * 10; }
    reps.push(r);
  }
  own[w] = { mask10: mid3(reps.map((r) => r.mask10)), mask20: mid3(reps.map((r) => r.mask20)), lufs: mid3(reps.map((r) => r.lufs)),
    peak: Math.max(...reps.map((r) => r.peak)), withPump: w === 'shotgun' ? mid3(reps.map((r) => r.withPump)) : undefined };
  const pk = own[w].peak;
  check(own[w].mask10 <= MASK_BUDGET[w], `disparo propio ${w}: tapa un paso enemigo a 10 m durante ${own[w].mask10} ms (máx ${MASK_BUDGET[w]})`);
  check(pk <= 0.985, `disparo propio ${w}: pico ${pk.toFixed(3)}`);
}
console.log('DISPARO PROPIO · tapa un paso enemigo a 10 m / 20 m durante: ' + Object.entries(own).map(([w, o]) => `${w} ${o.mask10}/${o.mask20} ms`).join(', ') +
  ` · escopeta con bombeo ${own.shotgun.withPump} ms · LUFS-M máx ${Object.entries(own).map(([w, o]) => `${w} ${o.lufs.toFixed(1)}`).join(', ')}`);
check(own.smg.lufs - dB(stepRef[10]) > 0, 'sin datos de sonoridad');

/* ------------------------------------- 4. confirmación de impacto sobre el disparo */

const hitMargin = {};
// banda de cada señal (donde está ≥ 80 % de su energía): el cuerpo es una
// palmada de ~2 kHz, la cabeza un doble chasquido de 4–9 kHz
const HIT_BAND = { hit_tick: [1200, 6000], hit_head: [3000, 12000] };
for (const [label, head, w] of [['cuerpo', false, 'smg'], ['cabeza', true, 'smg'], ['cuerpo escopeta', false, 'shotgun'], ['cabeza francotirador', true, 'sniper']]) {
  const name = head ? 'hit_head' : 'hit_tick';
  const [lo, hi] = HIT_BAND[name];
  const reps = [];
  // 4 repeticiones (variantes y tono cambian): mediana
  for (let k = 0; k < 4; k++) {
    settle();
    const t0 = ctx.currentTime;
    audio.gun(w);
    run(0.03);
    audio.hit(head);
    run(0.6);
    // cada parte por separado (el limitador maestro aplica la misma ganancia a
    // las dos en la mezcla: restar mezclas confundiría su bombeo con la señal)
    const only = render(t0, t0 + 0.6, (s) => s._name !== name), rest = render(t0, t0 + 0.6, (s) => s._name === name);
    // ventana = el chasquido (25 ms desde que llega)
    const a = Math.round(0.03 * SR), b = Math.round(0.055 * SR);
    let S = 0, M = 0;
    const fb = only.map((c) => OFF.bandpass(c, SR, lo, hi)), rb = rest.map((c) => OFF.bandpass(c, SR, lo, hi));
    for (let c = 0; c < 2; c++) for (let i = a; i < b; i++) { S += fb[c][i] * fb[c][i]; M += rb[c][i] * rb[c][i]; }
    reps.push(dB(S / M));
  }
  reps.sort((x, y) => x - y);
  hitMargin[label] = (reps[1] + reps[2]) / 2;
  check(hitMargin[label] >= -4, `confirmación (${label}) enterrada bajo el propio disparo: ${hitMargin[label].toFixed(1)} dB en ${lo / 1000}–${hi / 1000} kHz (mín −4)`);
}
console.log('CONFIRMACIÓN · margen sobre el propio disparo (en su banda, 25 ms, mediana de 4): ' + Object.entries(hitMargin).map(([k, v]) => `${k} ${v.toFixed(1)} dB`).join(', '));

/* ----------------------------------------------------- 5. explosión cercana */

// referencia de sonoridad: ráfaga propia de subfusil (1 s a 620 rpm)
settle();
let tB = ctx.currentTime;
{ let next = 0; run(1, (t) => { if (t >= next) { audio.gun('smg'); next += 60 / 620; } }); run(0.5); }
const burst = render(tB, tB + 1.5);
const burstLufs = measure(burst).lufsMax;
const blast = {};
for (const d of [3, 8]) {
  for (const muffle of [true, false]) {
    settle();
    const real = eng.earMuffle;
    if (!muffle) eng.earMuffle = () => 0;
    const t0 = ctx.currentTime;
    audio.explosion({ position: { x: d * 0.6, y: 0.4, z: -d * 0.8 } });
    run(2.5);
    eng.earMuffle = real;
    const out = render(t0, t0 + 2.5);
    let pk = 0, hot = 0;
    for (const c of out) for (const v of c) { pk = Math.max(pk, Math.abs(v)); if (Math.abs(v) > 0.8 * 0.985) hot++; }
    const hf = OFF.bandEnvelope(out, SR, 4000, 16000, 10);
    // el pico doloroso: primeros 200 ms
    let e1 = 0; for (let i = 0; i < 20; i++) e1 += hf[i];
    const k = `${d}${muffle ? '' : '_sin'}`;
    blast[k] = { peak: pk, hot: hot / (2 * out[0].length), lufs: measure(out).lufsMax, hf: e1, earAt1s: eng.ear.frequency.at(t0 + 1.2), grLong: (eng.comp.reductionTrace ?? []).filter((g) => g > 8).length * 128 / SR };
  }
}
for (const d of [3, 8]) {
  const b = blast[d], s = blast[`${d}_sin`];
  const duck = 10 * Math.log10(s.hf / Math.max(1e-30, b.hf));
  b.duck = duck;
  check(b.peak <= 0.985, `explosión a ${d} m: pico ${b.peak.toFixed(3)}`);
  check(b.lufs - burstLufs <= 6, `explosión a ${d} m: ${(b.lufs - burstLufs).toFixed(1)} LU sobre una ráfaga propia (máx +6)`);
  check(duck >= (d <= 3 ? 6 : 2), `explosión a ${d} m: los agudos solo se apartan ${duck.toFixed(1)} dB en 0–200 ms (mín ${d <= 3 ? 6 : 2})`);
  check(b.earAt1s >= 15000, `explosión a ${d} m: el oído sigue cerrado a 1.2 s (${b.earAt1s.toFixed(0)} Hz)`);
  check(b.grLong <= 0.15, `explosión a ${d} m: el limitador baja > 8 dB durante ${(b.grLong * 1000).toFixed(0)} ms (máx 150)`);
}
console.log(`EXPLOSIÓN CERCANA · 3 m: pico ${blast[3].peak.toFixed(3)}, ${(blast[3].lufs - burstLufs).toFixed(1)} LU sobre ráfaga propia, agudos −${blast[3].duck.toFixed(1)} dB (0–200 ms), oído a 1.2 s ${(blast[3].earAt1s / 1000).toFixed(1)} kHz · 8 m: ${(blast[8].lufs - burstLufs).toFixed(1)} LU, agudos −${blast[8].duck.toFixed(1)} dB`);

/* ---------------------------------------------- 6. pasos propios desde la cabeza */

const ownSteps = {};
for (const [kind, spd, dist] of [['roadie', 7.0, 2.1], ['run', 4.8, 1.7], ['walk', 2.5, 1.7], ['crouch', 2.3, 1.4]]) {
  settle();
  const t0 = ctx.currentTime;
  const times = [];
  let next = 0.05;
  run(6, (t) => { if (t >= next) { times.push(t); audio.footstep(kind); next += dist / spd; } });
  const out = render(t0, t0 + 6.4);
  const hp = out.map((c) => OFF.bandpass(c, SR, 3000, 20000));
  const E = (x, a, b) => { let e = 0; for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) e += x[i] * x[i]; return e / Math.max(1, b - a); };
  const fl = [];
  for (let i = 1; i < times.length; i++) {
    const s = Math.round(times[i] * SR), p = Math.round(times[i - 1] * SR);
    fl.push(dB((E(hp[0], s - Math.round(0.07 * SR), s) + E(hp[1], s - Math.round(0.07 * SR), s)) / (E(hp[0], p, p + Math.round(0.04 * SR)) + E(hp[1], p, p + Math.round(0.04 * SR)))));
  }
  fl.sort((a, b) => a - b);
  ownSteps[kind] = { floor: fl[fl.length >> 1], lufs: measure(out).lufsMax };
}
check(ownSteps.roadie.floor <= -18, `sprint propio: agudo entre zancadas a ${ownSteps.roadie.floor.toFixed(1)} dB (máx −18)`);
check(ownSteps.crouch.lufs <= ownSteps.walk.lufs - 6, `agachado no es más silencioso que andar (${ownSteps.crouch.lufs.toFixed(1)} vs ${ownSteps.walk.lufs.toFixed(1)} LUFS)`);
console.log('PASOS PROPIOS (oído en el ojo) · LUFS-M máx ' + Object.entries(ownSteps).map(([k, v]) => `${k} ${v.lufs.toFixed(1)}`).join(', ') + ` · agudo entre zancadas al esprintar ${ownSteps.roadie.floor.toFixed(1)} dB`);

/* ------------------------------------- 6b. cohete que pasa cerca (Doppler) */
{
  settle();
  const t0 = ctx.currentTime;
  const r = { x: 1.6, y: 1.5, z: -30 };
  const frame = { menu: false, playing: true, alive: true, hp01: 1, prot: 0, rockets: [r], pedestal: null, holdT: 0, holdMax: 1 };
  const rates = [];
  for (let i = 0; i < 90; i++) {
    r.z += 40 / 60;
    audio.update(1 / 60, frame);
    const l = eng.loops.get('rocket0');
    if (l?.src) rates.push({ z: r.z, rate: l.src.playbackRate.at(ctx.currentTime + 0.2) });
    ctx.advance(1 / 60);
  }
  frame.rockets = []; audio.update(1 / 60, frame);
  const passes = since(t0).filter((x) => x.name === 'rocket_pass').length;
  const ap = rates.filter((x) => x.z < -6).map((x) => x.rate), rc = rates.filter((x) => x.z > 6).map((x) => x.rate);
  const avg = (a) => a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
  check(passes === 1, `cohete: la ráfaga de paso sonó ${passes} veces (1 esperada)`);
  check(avg(ap) > 1.06 && avg(rc) < 0.95, `cohete: Doppler ausente (acercándose ×${avg(ap).toFixed(2)}, alejándose ×${avg(rc).toFixed(2)})`);
  console.log(`COHETE · pasa a 1.6 m: ráfaga ${passes}× · Doppler ×${avg(ap).toFixed(2)} → ×${avg(rc).toFixed(2)}`);
}

/* ----------------------------------------------------- 7. tiroteo 4v4 sostenido */

settle();
const DUR = 12;
const t4 = ctx.currentTime;
const rnd = (() => { let a = 11; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296); })();
const players = [
  { team: 'red', x: -7, z: 5, w: 'smg' }, { team: 'red', x: 9, z: 7, w: 'shotgun' }, { team: 'red', x: 4, z: 16, w: 'pistol' },
  { team: 'blue', x: -9, z: -12, w: 'smg' }, { team: 'blue', x: 11, z: -9, w: 'shotgun' }, { team: 'blue', x: -4, z: -30, w: 'sniper' },
  { team: 'blue', x: 5, z: -16, w: 'smg' },
];
const calls = { own: 0, hit: 0, enemyNear: 0 };
const nextShot = players.map(() => rnd() * 0.6), nextStep = players.map(() => rnd() * 0.4);
let mine = 0, nb = 0;
const before = { ...eng.started };
const stepAt = [];
run(DUR, (t) => {
  if ((t % 2.4) < 1.3 && t >= mine) {
    audio.gun('smg'); calls.own++; mine = t + 60 / 620;
    if (rnd() < 0.3) { const head = rnd() < 0.2; audio.hit(head); calls.hit++; }
  }
  if (t >= 4 && nb === 0) { audio.explosion({ position: { x: 6, y: 0.4, z: -7 } }); nb++; }
  if (t >= 8.5 && nb === 1) { audio.explosion({ position: { x: -12, y: 0.4, z: -20 } }); audio.kill(true); nb++; }
  players.forEach((o, i) => {
    o.z += (o.team === 'blue' ? 0.004 : -0.002);
    const pos = { x: o.x, y: 1.35, z: o.z };
    if (t >= nextShot[i]) {
      const rate = o.w === 'smg' ? 60 / 620 : o.w === 'sniper' ? 1.8 : o.w === 'shotgun' ? 0.7 : 0.25;
      const aimMe = o.team === 'blue' && rnd() < 0.2;
      audio.gun(o.w, { position: pos, end: aimMe ? { x: rnd() * 2 - 1, y: 1.4, z: 10 } : { x: o.x * 0.2, y: 1, z: o.z * 0.2 }, team: o.team });
      audio.impact({ x: o.x * 0.3, y: 1, z: o.z * 0.3 }, rnd() < 0.3 ? 'metal' : 'stone');
      nextShot[i] = t + rate * (o.w === 'smg' && rnd() < 0.12 ? 9 : 1);
    }
    if (t >= nextStep[i]) {
      audio.footstep('run', { position: { x: o.x, y: 0.22, z: o.z }, team: o.team });
      const d = Math.hypot(o.x, o.z);
      stepAt.push({ t: ctx.currentTime, enemy: o.team === 'blue', d });
      if (o.team === 'blue' && d < 15) calls.enemyNear++;
      nextStep[i] = t + 0.36;
    }
  });
});
const got = (n) => (eng.started[n] ?? 0) - (before[n] ?? 0);
const own4 = got('gun_smg');
const hits4 = got('hit_tick') + got('hit_head');
const enemyNearPlayed = rec.filter((r) => r.at >= t4 && r.name.startsWith('step_') && r.prio >= 80 && (() => { return true; })()).length;
const full4 = render(t4, t4 + DUR + 1);
const isStep = (s) => s._name?.startsWith('step_');
const noSteps = render(t4, t4 + DUR + 1, isStep);
const noEnemy = render(t4, t4 + DUR + 1, (s) => isStep(s) && s._prio >= 80);
const noFriend = render(t4, t4 + DUR + 1, (s) => isStep(s) && s._prio < 80);
let pk4 = 0, hot4 = 0;
for (const c of full4) for (const v of c) { pk4 = Math.max(pk4, Math.abs(v)); if (Math.abs(v) > 0.8 * 0.985) hot4++; }
const grT = eng.comp.reductionTrace ?? [];
const gr6 = grT.filter((g) => g > 6).length / Math.max(1, grT.length);
const band = (chs) => chs.map((c) => OFF.bandpass(c, SR, 1000, 6000));
const [Bf, Bn, Be, Bfr] = [full4, noSteps, noEnemy, noFriend].map(band);
const margins = { enemy: [], friend: [] };
for (const s of stepAt) {
  const a = Math.round((s.t - t4) * SR), b = a + Math.round(0.08 * SR);
  let S = 0, M = 0;
  const other = s.enemy ? Be : Bfr;
  for (let c = 0; c < 2; c++) for (let i = a; i < Math.min(b, Bf[c].length); i++) { const d = Bf[c][i] - other[c][i]; S += d * d; M += Bn[c][i] ** 2; }
  if (S > 0) margins[s.enemy ? 'enemy' : 'friend'].push(dB(S / M));
}
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : -Infinity; };
console.log(`TIROTEO 4v4 · ${rec.filter((r) => r.at >= t4).length} voces en ${DUR} s · pico voces ${eng.stats.peakVoices}/32 · pico ${pk4.toFixed(3)} · muestras en la rodilla del recorte ${(hot4 / (2 * full4[0].length) * 100).toFixed(2)} % · limitador >6 dB en ${(gr6 * 100).toFixed(1)} % de bloques · disparos propios ${own4}/${calls.own} · confirmaciones ${hits4}/${calls.hit} · pasos: enemigo mediana ${med(margins.enemy).toFixed(1)} dB (${margins.enemy.length}), aliado ${med(margins.friend).toFixed(1)} dB (${margins.friend.length})`);
check(pk4 <= 0.985, `4v4: pico ${pk4.toFixed(3)}`);
check(hot4 / (2 * full4[0].length) <= 0.005, `4v4: ${(hot4 / (2 * full4[0].length) * 100).toFixed(2)} % de muestras en la rodilla del recorte (máx 0.5 %)`);
check(gr6 <= 0.1, `4v4: limitador > 6 dB en ${(gr6 * 100).toFixed(1)} % de los bloques (máx 10 %)`);
check(eng.stats.peakVoices <= 32, '4v4: voces por encima del pool');
check(own4 === calls.own, `4v4: se perdieron disparos propios (${own4}/${calls.own})`);
check(hits4 === calls.hit, `4v4: se perdieron confirmaciones (${hits4}/${calls.hit})`);
check(med(margins.enemy) >= med(margins.friend) + 3, `4v4: pasos enemigos ${med(margins.enemy).toFixed(1)} dB vs aliados ${med(margins.friend).toFixed(1)} dB (enemigo ≥ aliado + 3)`);
void enemyNearPlayed;

// Una fuente por capa. La pausa retiene el cursor original del silbido.
settle();
const dodgeAt = ctx.currentTime;
audio.dodgeStart();
const air = since(dodgeAt).find(r => r.name === 'dodge_air');
check(!!air, 'esquiva sin silbido');
if (air) {
  run(0.02);
  audio.reloadPause();
  check(air.src.playbackRate.value === 0, 'el silbido avanza durante la pausa');
  run(0.03);
  audio.reloadResume();
  check(air.src.playbackRate.value > 0, 'el silbido sigue detenido');
}
run(TUNING.dodge.duration);
audio.dodgeEnd();
const cues = since(dodgeAt).filter(r => r.o.tag === 'dodge').map(r => r.name);
check(cues.length === 4 && ['dodge_air','cloth','step_scuff'].every(k => cues.includes(k)) &&
  cues.some(k => k.startsWith('step_') && k !== 'step_scuff'), 'eventos de esquiva: ' + cues.join(', '));

// Un arranque por gesto; solo pared y soldado generan sonido de contacto.
audio.attachWeapons(W);
for (const hz of [30, 60, 144]) {
  for (const result of [{ connected: true }, { world: true }, { connected: false }]) {
    settle();
    const from = ctx.currentTime;
    W.noteMelee('start');
    const voice = since(from).find(r => r.name === 'melee_swing');
    if (hz === 60 && result.world && voice) {
      ctx.advance(0.015);
      audio.reloadPause();
      check(voice.src.playbackRate.value === 0, 'el silbido de la patada avanza en pausa');
      ctx.advance(0.12);
      audio.reloadResume();
      check(voice.src.playbackRate.value > 0, 'el silbido no reanudó su cursor');
    }
    ctx.advance(Math.ceil(TUNING.melee.hitAt * hz) / hz);
    const impactAt = ctx.currentTime;
    W.noteMelee('hit', result);
    const swing = since(from).filter(r => r.name === 'melee_swing');
    const hit = since(from).filter(r => r.name === 'melee_hit');
    check(swing.length === 1 && Math.abs(swing[0].at - from) < 0.002, 'silbido desincronizado o duplicado');
    check(hit.length === Number(!!(result.connected || result.world)), 'impacto omitido o duplicado');
    if (hit.length) {
      const { at, o } = hit[0];
      check(Math.abs(at - impactAt) < 0.002 && o.tag === 'melee' && o.send === FP_MIX.ownHandlingSend && o.owner === 'own' &&
        o.volume === (result.world ? 0.7 : 1) && o.pitch === (result.world ? 1.12 : 1), 'mezcla FP o instante de la patada');
    }
  }
}
audio.detachWeapons();

if (verbose) console.log({ own, hitMargin, blast, ownSteps });
for (const w of warns) console.log('AVISO: ' + w);
if (fails.length) {
  console.error(`\nAUDIO FP FALLO (${fails.length}):\n  ` + fails.join('\n  '));
  process.exit(1);
}
console.log('AUDIO FP OK');
process.exit(0);
