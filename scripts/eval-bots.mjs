// EVALUACIÓN DE BOTS desde el punto de vista de un jugador. Arranca una
// partida VS Bots real (dist/ servido por el server del repo) y la deja correr
// con el reloj acelerado (cada cuadro avanza --step ms de juego; el juego da
// hasta 3 pasos de 1/30 s por cuadro, igual que en una máquina lenta).
//   node scripts/eval-bots.mjs <mapa> <minutos de juego> <salida> [--mode=human|bots]
//        [--frames=12] [--lab] [--seed=1] [--port=8871] [--step=100] [--segment=70]
// --mode=human: el jugador (rojo) sigue un guion: quedarse en el spawn, plantarse
//   al descubierto, aguantar desde cobertura, empujar, flanquear, campear una
//   esquina (70 s cada uno, en ciclo). --mode=bots: un bot ocupa su lugar.
// --lab: después, duelos controlados a 5/15/30 m (quieto y en movimiento) para
//   reacción, TTK y precisión contra un humano visible (con modo dios).
// Salida: <mapa>-<modo>.json, mapa de calor de atascos (SVG/PNG) y cuadros
// (cenital + vista del bot) de los episodios de atasco.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));
const [MAP = 'fortaleza', MIN = '5', OUTARG = '.'] = args.filter((a) => !a.startsWith('--'));
const OUT = path.resolve(OUTARG);
fs.mkdirSync(OUT, { recursive: true });
const MODE = flags.mode || 'human';
const PORT = Number(flags.port) || 8871;
const STEP = Number(flags.step) || 100;
const SEED = Number(flags.seed) || 1;
const tag = `${MAP}-${MODE}${flags.lab ? '-lab' : ''}`;

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const errors = [];
let data = null;
const frameFiles = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(e.message));
  // reloj de juego acelerado y azar con semilla (mismas semillas antes/después)
  await page.addInitScript(({ step, seed }) => {
    let s = seed >>> 0;
    Math.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const raf = window.requestAnimationFrame.bind(window);
    let vt = performance.now();
    const adv = () => { vt += step; raf(adv); };
    raf(adv);
    window.requestAnimationFrame = (cb) => raf(() => cb(vt));
  }, { step: STEP, seed: SEED });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=low`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, MAP);
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('btn-lobby-start').click());
  await page.waitForFunction(() => !!window.BREACH.botMatch, null, { timeout: 120000 });
  const src = fs.readFileSync(path.join(root, 'scripts', 'eval-bots-page.js'), 'utf8');
  await page.evaluate(([code, cfg]) => (0, eval)(code)(cfg), [src, { mode: MODE, frames: Number(flags.frames ?? 12), segment: Number(flags.segment) || 70 }]);
  // saltar la presentación de la primera ronda
  await page.evaluate(() => {
    const M = window.BREACH.botMatch;
    const tick = () => { if (M.phase === 'intro' && M.phaseT > 0.5) M.phaseT = 0.5; if (M.phase === 'countdown' && M.phaseT > 0.5) M.phaseT = 0.5; requestAnimationFrame(tick); };
    tick();
  });
  const target = Number(MIN) * 60;
  const t0 = Date.now();
  let lastLog = 0;
  const pull = async () => {
    const fr = await page.evaluate(() => window.__ev.frames.splice(0));
    for (const f of fr) {
      const base = path.join(OUT, 'frames-raw', `${MAP}-${MODE}-ep${f.ep}-${f.n}`);
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(base + '-top.jpg', Buffer.from(f.top.split(',')[1], 'base64'));
      fs.writeFileSync(base + '-eye.jpg', Buffer.from(f.eye.split(',')[1], 'base64'));
      frameFiles.push({ ep: f.ep, n: f.n, base });
    }
  };
  for (;;) {
    await page.waitForTimeout(3000);
    const playT = await page.evaluate(() => window.__ev.playT);
    await pull();
    if (Date.now() - lastLog > 60000) { lastLog = Date.now(); console.error(`[${tag}] juego ${(playT / 60).toFixed(1)} / ${MIN} min, pared ${((Date.now() - t0) / 60000).toFixed(1)} min`); }
    if (playT >= target) break;
  }
  if (flags.lab) {
    await page.evaluate(() => window.__ev.runLab([5, 15, 30], 5, ['front', 'side', 'back']));
  }
  await page.evaluate(() => window.__ev.finish());
  await pull();
  data = await page.evaluate(() => {
    const { frames, finish, runLab, repro, cfg, ...rest } = window.__ev;
    const W = window.BREACH_WORLD;
    rest.geometry = {
      fx: W.fx, fz: W.fz,
      boxes: W.colliders.filter((c) => !c.walkSurface).map((c) => [+c.minx.toFixed(2), +c.minz.toFixed(2), +c.maxx.toFixed(2), +c.maxz.toFixed(2), +c.h.toFixed(2), c.moveOnly ? 1 : 0, c.minY ? 1 : 0]),
      segs: W.segmentColliders.map((s) => [+s.a.x.toFixed(2), +s.a.z.toFixed(2), +s.b.x.toFixed(2), +s.b.z.toFixed(2)]),
    };
    const N = W.navigation;
    rest.geometry.walk = N ? { nx: N.nx, nz: N.nz, cell: (2 * N.fx) / N.nx, bits: Array.from(N.height, (h) => Number.isNaN(h) ? 0 : h > 0.2 ? 2 : 1).join('') } : null;
    return rest;
  });
  data.wallMinutes = +((Date.now() - t0) / 60000).toFixed(1);
} finally {
  await browser.close(); server.kill();
}

// ---------- resumen ----------
const d = data;
const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : 0;
const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const eps = d.episodes;
const heatTop = Object.entries(d.heat).sort((a, b) => b[1] - a[1]);
// agrupar celdas vecinas en "puntos de atasco" (3x3 m)
const spots = [];
for (const [k, v] of heatTop) {
  const [x, z] = k.split(',').map(Number);
  const s = spots.find((q) => Math.abs(q.x - x) <= 2 && Math.abs(q.z - z) <= 2);
  if (s) s.sec += v; else spots.push({ x, z, sec: v });
}
spots.sort((a, b) => b.sec - a.sec);
const shots = Object.fromEntries(Object.entries(d.shots).sort().map(([k, s]) => [k, { tiros: s.shots, acierto: pct(s.hits, s.shots), aHumano: s.atHuman, aciertoHumano: pct(s.hitsHuman, s.atHuman) }]));
const rounds = d.rounds;
const summary = {
  mapa: MAP, modo: MODE, minutosDeJuego: +(d.playT / 60).toFixed(1), minutosDePared: d.wallMinutes, erroresDePagina: errors.length,
  atasco: {
    // % del tiempo con intención de moverse
    sinAvance2sPct: pct(d.stuckT, d.intentT), bloqueadoPct: pct(d.blockedT, d.intentT), vaivenPct: pct(d.jitterT, d.intentT), vaivenPorEstado: d.jitterBy,
    peoresVaiven: Object.entries(d.jitterHeat).sort((a, b) => b[1] - a[1]).slice(0, 5),
    segundosPorBotMinuto: +(d.stuckT / Math.max(1, d.aliveT / 60)).toFixed(2),
    episodios: eps.length, episodiosMas5s: eps.filter((e) => e.dur >= 5).length, episodiosMas10s: eps.filter((e) => e.dur >= 10).length,
    porEstado: eps.reduce((o, e) => { const k = e.state + (e.state === 'cover' ? ':' + e.coverPhase : '') + (e.perch ? ':' + e.perch : ''); o[k] = +((o[k] ?? 0) + e.dur).toFixed(1); return o; }, {}),
    peoresPuntos: spots.slice(0, 8).map((s) => ({ x: s.x, z: s.z, seg: +s.sec.toFixed(1) })),
    rodeos: d.recover,
  },
  botSinMunicionS: d.botDryS ?? null,
  ociosoPct: pct(d.idleT, d.aliveT), ociosoPorEstado: Object.fromEntries(Object.entries(d.idleBy ?? {}).map(([k, v]) => [k, Math.round(v)])), mirandoParedPct: pct(d.wallT, d.aliveT), esperandoEnSpawnPct: pct(d.spawnWaitT, d.aliveT),
  espaldaAAmenazaPct: pct(d.backT, d.aliveT),
  estados: Object.fromEntries(Object.entries(d.stateTime).map(([k, v]) => [k, pct(v, d.aliveT)])),
  tiros: shots, tirosContraCobertura: d.intoCover, tirosTotales: Object.values(d.shots).reduce((a, s) => a + s.shots, 0),
  giroAlRecibirTiroPorDetras: { mediana: med(d.turnToHit), nunca3sPct: pct(d.turnToHit.filter((x) => x == null).length, d.turnToHit.length), n: d.turnToHit.length },
  giroAlMorirAliado: { mediana: med(d.allyDeathTurn), nunca3sPct: pct(d.allyDeathTurn.filter((x) => x == null).length, d.allyDeathTurn.length), n: d.allyDeathTurn.length },
  agrupamiento: { tresA5mPct: pct(d.group3, d.groupSamples), parejasA2_5mPorMuestra: +(d.pairsClose / Math.max(1, d.samples)).toFixed(2), bajasEnElMismoSitio: d.doorwayDeaths, bajas: d.deaths.length },
  kit: d.kit,
  rondas: { n: rounds.length, porTiempo: rounds.filter((r) => r.timeout).length, rojo: rounds.filter((r) => r.winner === 'red').length, azul: rounds.filter((r) => r.winner === 'blue').length,
    duracionMedia: rounds.length ? Math.round(rounds.reduce((a, r) => a + r.seconds, 0) / rounds.length) : null,
    primerContactoMediana: med(rounds.map((r) => r.firstShot)), vidasRestantesGanador: rounds.map((r) => Math.max(r.lives.red, r.lives.blue)) },
  costoIA: { pasos: d.cost.n, msMedio: +(d.cost.sum / Math.max(1, d.cost.n)).toFixed(3), msMax: +d.cost.max.toFixed(2),
    p95: (() => { let acc = 0; for (let i = 0; i < 60; i++) { acc += d.cost.hist[i]; if (acc >= d.cost.n * 0.95) return +(i * 0.05 + 0.05).toFixed(2); } return 3; })() },
};
if (MODE === 'human') {
  const by = {};
  for (const s of d.segments) (by[s.kind] ??= []).push(s);
  summary.humano = {
    muertes: d.trades.humanDeaths, vengadasPorAliadoEn5s: d.trades.traded,
    aliadoA15mEnCombatePct: pct(d.allyNearHuman.withAlly, d.allyNearHuman.inContact),
    porComportamiento: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, {
      n: v.length,
      primerTiroRecibidoMediana: med(v.map((s) => s.firstShotAt)),
      sinContactoPct: pct(v.filter((s) => s.firstShotAt == null).length, v.length),
      muertesPorMin: +(v.reduce((a, s) => a + s.deaths, 0) / Math.max(1, v.reduce((a, s) => a + s.t, 0) / 60)).toFixed(2),
      bajasPorMin: +(v.reduce((a, s) => a + s.kills, 0) / Math.max(1, v.reduce((a, s) => a + s.t, 0) / 60)).toFixed(2),
      danoRecibidoPorMin: Math.round(v.reduce((a, s) => a + s.dmgTaken, 0) / Math.max(1, v.reduce((a, s) => a + s.t, 0) / 60)),
      golpesPorLaEspaldaPct: pct(v.reduce((a, s) => a + s.hitsFromBehind, 0), v.reduce((a, s) => a + s.hitsTaken, 0)),
      enemigoMasCercanoMedio: med(v.map((s) => s.nearestEnemy)), aliadoMedio: med(v.map((s) => s.allyDist)),
      expuestoPct: pct(v.reduce((a, s) => a + s.exposedT, 0), v.reduce((a, s) => a + s.samples * 0.5, 0)),
    }])),
  };
}
if (d.lab?.length) {
  const groups = {};
  for (const t of d.lab) (groups[`${t.d}m-${t.moving ? 'moviendose' : 'quieto'}-${t.facing}`] ??= []).push(t);
  summary.duelo = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, {
    n: v.length, reaccionMediana: med(v.map((t) => t.firstShot)), sinDisparo8sPct: pct(v.filter((t) => t.firstShot == null).length, v.length),
    ttkMediana: med(v.map((t) => t.ttk)), sinMatar8sPct: pct(v.filter((t) => t.ttk == null).length, v.length),
    acierto: pct(v.reduce((a, t) => a + t.hits, 0), v.reduce((a, t) => a + t.shots, 0)), danoMedio8s: Math.round(v.reduce((a, t) => a + t.dmg, 0) / v.length),
    armas: [...new Set(v.map((t) => t.wep))].join(','),
  }]));
}
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, `${tag}.json`), JSON.stringify({ summary, episodes: eps, rounds, deaths: d.deaths, segments: d.segments, lab: d.lab, jitter: d.jitterSamples, errors: errors.slice(0, 20) }, null, 1));

// ---------- mapa de calor de atascos ----------
const g = d.geometry, S = 9, pad = 10;
const Wd = (g.fx * 2) * S + pad * 2, Hd = (g.fz * 2) * S + pad * 2;
const X = (x) => pad + (x + g.fx) * S, Z = (z) => pad + (z + g.fz) * S;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${Hd + 34}" font-family="monospace"><rect width="100%" height="100%" fill="#111"/>`;
if (g.walk) {
  const c = g.walk.cell;
  for (let j = 0; j < g.walk.nz; j++) for (let i = 0; i < g.walk.nx; i++) {
    const v = g.walk.bits[j * g.walk.nx + i];
    if (v === '0') continue;
    svg += `<rect x="${X(-g.fx + i * c).toFixed(1)}" y="${Z(-g.fz + j * c).toFixed(1)}" width="${(c * S).toFixed(1)}" height="${(c * S).toFixed(1)}" fill="${v === '2' ? '#3b4a5c' : '#2c3330'}"/>`;
  }
}
for (const [a, b, c2, e, h, mo, minY] of g.boxes) svg += `<rect x="${X(a)}" y="${Z(b)}" width="${((c2 - a) * S).toFixed(1)}" height="${((e - b) * S).toFixed(1)}" fill="${mo ? 'none' : minY ? '#7a6a40' : h <= 1.2 ? '#777' : '#bbb'}" stroke="${mo ? '#e0a020' : 'none'}" stroke-dasharray="${mo ? '3,2' : ''}" opacity="0.85"/>`;
for (const [ax, az, bx, bz] of g.segs) svg += `<line x1="${X(ax)}" y1="${Z(az)}" x2="${X(bx)}" y2="${Z(bz)}" stroke="#ddd" stroke-width="2"/>`;
const maxH = Math.max(1, ...Object.values(d.heat));
for (const [k, v] of Object.entries(d.heat)) {
  const [x, z] = k.split(',').map(Number);
  svg += `<rect x="${X(x)}" y="${Z(z)}" width="${S}" height="${S}" fill="#ff2a2a" opacity="${(0.25 + 0.75 * Math.min(1, v / maxH)).toFixed(2)}"/>`;
}
spots.slice(0, 3).forEach((s, i) => { svg += `<circle cx="${X(s.x + 0.5)}" cy="${Z(s.z + 0.5)}" r="${S * 2.4}" fill="none" stroke="#ffe000" stroke-width="2"/><text x="${X(s.x) + S * 2.6}" y="${Z(s.z)}" fill="#ffe000" font-size="14">${i + 1}: ${s.sec.toFixed(0)}s</text>`; });
svg += `<text x="${pad}" y="${Hd + 22}" fill="#eee" font-size="13">${MAP} ${MODE}: atasco ${summary.atasco.sinAvance2sPct}% del tiempo con intención de moverse · ${eps.length} episodios · ${summary.minutosDeJuego} min</text></svg>`;
fs.writeFileSync(path.join(OUT, `${tag}-atascos.svg`), svg);
try { execFileSync(process.execPath, [path.join(root, 'scripts', 'svg-to-png.mjs'), path.join(OUT, `${tag}-atascos.png`), path.join(OUT, `${tag}-atascos.svg`)], { stdio: 'ignore' }); } catch {}

// ---------- cuadros de los 3 peores puntos ----------
const fdir = path.join(OUT, 'frames');
fs.mkdirSync(fdir, { recursive: true });
spots.slice(0, 3).forEach((s, i) => {
  const ep = eps.filter((e) => frameFiles.some((f) => f.ep === e.id) && Math.abs(Math.floor(e.x) - s.x) <= 2 && Math.abs(Math.floor(e.z) - s.z) <= 2).sort((a, b) => b.dur - a.dur)[0];
  if (!ep) return;
  for (const f of frameFiles.filter((q) => q.ep === ep.id)) for (const v of ['top', 'eye']) {
    const dst = path.join(fdir, `${MAP}-${MODE}-punto${i + 1}-${v}-${f.n}.png`);
    try { execFileSync('sips', ['-s', 'format', 'png', `${f.base}-${v}.jpg`, '--out', dst], { stdio: 'ignore' }); } catch {}
  }
  fs.writeFileSync(path.join(fdir, `${MAP}-${MODE}-punto${i + 1}.json`), JSON.stringify(ep, null, 1));
});
