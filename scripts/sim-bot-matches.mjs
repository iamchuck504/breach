// SIMULACIÓN DE PARTIDAS 4v4 SOLO CON BOTS. Arranca una partida contra bots
// real, saca al jugador de la cuenta (un cuarto bot rojo ocupa su lugar) y
// deja correr rondas seguidas durante un tiempo, registrando quién gana, dónde
// y cuándo se muere, uso de los puestos elevados, arma especial y atascos.
// No sustituye a jugadores reales: los bots no usan granadas de fragmentación
// ni rutas creativas. Sirve para detectar sesgos de lado, muertes en el spawn
// y zonas muertas. Sirve dist/: `npm run build` antes.
//   node scripts/sim-bot-matches.mjs <mapa> [minutos=10] [carpeta de salida]
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = process.argv[2] || 'fortaleza';
const MINUTES = Math.max(1, Number(process.argv[3]) || 10);
const OUT = process.argv[4] ? path.resolve(process.argv[4]) : '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
// SIM_RUN=n permite varias corridas del mismo mapa a la vez (puerto y archivo propios)
const RUN = Number(process.env.SIM_RUN) || 0;
const PORT = 8840 + ['fortaleza', 'azoteas', 'calle2'].indexOf(MAP) + 1 + RUN * 4;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let data = null;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=low`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate((l) => { localStorage.setItem('breach.map', l); window.BREACH.mapChoice = l; }, MAP);
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached', timeout: 120000 });
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('btn-lobby-start').click());
  await page.waitForFunction(() => !!window.BREACH.botMatch, null, { timeout: 120000 });

  await page.evaluate(() => {
    const G = window.BREACH, M = G.botMatch, W = window.BREACH_WORLD;
    const S = window.__sim = { rounds: [], deaths: [], specials: { red: 0, blue: 0 }, stuck: {}, perch: { holds: { red: 0, blue: 0 }, holdS: 0, killsFrom: 0, deathsOn: 0 },
      idle: [], samples: 0, zoneTime: {}, first: null };
    // el jugador no participa: ni blanco, ni aliado, ni vidas
    M.cb.player = () => ({ x: 0, z: 0, y: 0, alive: false });
    M.cb.damagePlayer = () => false;
    M.addExternalBot({ id: 'bot-sim', name: 'Sim', team: 'red', spawn: W.spawns.red[1] });
    const roundT = () => 300 - M.timer;
    const spawnAt = new Map();
    let roundDeaths = [];
    const endRound = M._endRound.bind(M);
    M._endRound = (winner) => {
      const lives = { red: M.livesOf('red'), blue: M.livesOf('blue') };
      endRound(winner);
      S.rounds.push({ winner, seconds: +roundT().toFixed(1), lives, kills: { red: roundDeaths.filter((d) => d.team === 'blue').length, blue: roundDeaths.filter((d) => d.team === 'red').length } });
      roundDeaths = [];
      // rondas seguidas: la partida nunca llega a su final
      if (M.phase === 'final') { M.phase = 'intermission'; M.phaseT = 2; M.matchWinner = null; }
      M.wins = { red: 0, blue: 0 };
    };
    const onDeath = M._onDeath.bind(M);
    M._onDeath = (victimId, killerId, gib) => {
      const v = M.botById(victimId), k = M.botById(killerId);
      if (v && M.phase === 'playing') {
        const toward = v.team === 'red' ? 1 : -1;
        const d = { team: v.team, t: +roundT().toFixed(1), x: +v.pos.x.toFixed(1), z: +v.pos.z.toFixed(1), y: +v.y.toFixed(1),
          sinceSpawn: +((performance.now() - (spawnAt.get(v.id) ?? 0)) / 1000).toFixed(1),
          // profundidad: -1 = su propio fondo, +1 = fondo rival
          depth: +(v.pos.z * toward / W.fz).toFixed(2),
          range: k ? +Math.hypot(k.pos.x - v.pos.x, k.pos.z - v.pos.z).toFixed(1) : null, wep: k?.wep ?? null,
          victimPerch: v.perch?.phase ?? null, killerPerch: k?.perch?.phase ?? null };
        S.deaths.push(d); roundDeaths.push(d);
        if (d.victimPerch && d.victimPerch !== 'approach') S.perch.deathsOn++;
        if (d.killerPerch === 'hold') S.perch.killsFrom++;
      }
      onDeath(victimId, killerId, gib);
    };
    const take = M.botTakeSpecial.bind(M);
    M.botTakeSpecial = (bot) => { const had = bot.wep; const r = take(bot); if (bot.wep !== had) S.specials[bot.team]++; return r; };
    const proto = Object.getPrototypeOf(M.bots[0]);
    if (!proto.__simWrapped) {
      proto.__simWrapped = true;
      const rec = proto._recoverFromStuck;
      proto._recoverFromStuck = function (match, contact, requested, goal, reason = 'blocked') {
        S.stuck[reason] = (S.stuck[reason] ?? 0) + 1;
        // contra qué: el obstáculo del rodeo en curso o el del contacto
        const c = contact?.collider || this.recovery?.collider;
        const key = c?.minx !== undefined ? `${((c.minx + c.maxx) / 2).toFixed(1)},${((c.minz + c.maxz) / 2).toFixed(1)} ${(c.maxx - c.minx).toFixed(1)}x${(c.maxz - c.minz).toFixed(1)} h${c.h}` : c?.a ? `segmento ${((c.a.x + c.b.x) / 2).toFixed(1)},${((c.a.z + c.b.z) / 2).toFixed(1)}` : 'sin obstáculo';
        (S.stuckAt ??= {})[key] = (S.stuckAt[key] ?? 0) + 1;
        return rec.call(this, match, contact, requested, goal, reason);
      };
    }
    const lastPhase = new Map(), anchor = new Map(), wasAlive = new Map();
    let prev = performance.now(), acc = 0;
    const tick = (now) => {
      const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
      if (M.phase === 'intro' && M.phaseT > 1) M.phaseT = 1;
      if (G.botMatch === M && M.phase === 'playing') {
        acc += dt;
        for (const b of M.bots) {
          if (b.alive && !wasAlive.get(b.id)) spawnAt.set(b.id, now);
          wasAlive.set(b.id, b.alive);
          if (!b.alive) { anchor.delete(b.id); lastPhase.delete(b.id); continue; }
          const phase = b.perch?.phase ?? null;
          if (phase === 'hold') { S.perch.holdS += dt; if (lastPhase.get(b.id) !== 'hold') S.perch.holds[b.team]++; }
          lastPhase.set(b.id, phase);
          // quieto sin motivo: más de 8 s a menos de 1 m sin estar en cover, puesto o defensa
          const a = anchor.get(b.id);
          const busy = b.state === 'cover' || b.state === 'hold' || phase === 'hold';
          if (!a || busy || Math.hypot(a.x - b.pos.x, a.z - b.pos.z) > 1) anchor.set(b.id, { x: b.pos.x, z: b.pos.z, t: 0, logged: false });
          else { a.t += dt; if (a.t > 8 && !a.logged) { a.logged = true; S.idle.push({ id: b.id, state: b.state, role: b.role, x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1), y: +b.y.toFixed(1) }); } }
        }
        if (acc >= 0.5) {
          acc = 0;
          for (const b of M.bots) {
            if (!b.alive) continue;
            const lane = b.pos.x < -W.fx / 3 ? 'O' : b.pos.x > W.fx / 3 ? 'E' : 'C';
            const band = Math.abs(b.pos.z) < W.fz / 3 ? 'medio' : 'fondo';
            const key = `${lane}-${band}`;
            S.zoneTime[key] = (S.zoneTime[key] ?? 0) + 1; S.samples++;
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const until = Date.now() + MINUTES * 60000;
  let shot = false;
  while (Date.now() < until) {
    await page.waitForTimeout(2000);
    // una captura de un bot en su puesto, vista desde cerca
    if (OUT && !shot) {
      const cam = await page.evaluate(() => {
        const M = window.BREACH.botMatch, b = M?.bots.find((x) => x.alive && x.perch?.phase === 'hold' && Math.abs(x.y - x.perch.deck.h) < 0.1);
        if (!b) return null;
        const p = window.BREACH.player, W = window.BREACH_WORLD;
        const inward = -Math.sign(b.perch.deck.x) || 1, toward = b.team === 'red' ? 1 : -1;
        const q = { x: b.pos.x + inward * 5.5, z: b.pos.z + toward * 5.5 };
        W.resolveCircle(q, 0.4, 0);
        p.pos.x = q.x; p.pos.z = q.z; p.y = W.groundHeight(q, 0.4, 0);
        const yaw = Math.atan2(-(b.pos.x - q.x), -(b.pos.z - q.z));
        p.yaw = yaw; p.cam.yaw = yaw; p.cam.pitch = 0.12;
        return true;
      });
      if (cam) { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, `${MAP}-bot-en-puesto.png`) }); shot = true; }
    }
  }
  data = await page.evaluate(() => window.__sim);
} finally {
  await browser.close(); server.kill(); await clearClip();
}

const pct = (n, d) => d ? Math.round(100 * n / d) : 0;
const deaths = data.deaths;
const by = (team) => deaths.filter((d) => d.team === team);
const wins = { red: data.rounds.filter((r) => r.winner === 'red').length, blue: data.rounds.filter((r) => r.winner === 'blue').length, draw: data.rounds.filter((r) => !r.winner).length };
const summary = {
  mapa: MAP, minutos: MINUTES, rondas: data.rounds.length, victorias: wins,
  duracionMediaRonda: data.rounds.length ? Math.round(data.rounds.reduce((a, r) => a + r.seconds, 0) / data.rounds.length) : null,
  bajas: { rojas: by('red').length, azules: by('blue').length },
  // muertes tempranas o dentro del propio fondo: señal de spawn desprotegido
  muertesEnSpawn: { antesDe4s: deaths.filter((d) => d.sinceSpawn < 4).length, enFondoPropio: deaths.filter((d) => d.depth < -0.72).length,
    porEquipo: { rojas: by('red').filter((d) => d.depth < -0.72).length, azules: by('blue').filter((d) => d.depth < -0.72).length } },
  dondeSeMuere: { mitadPropia: pct(deaths.filter((d) => d.depth < -0.15).length, deaths.length), medio: pct(deaths.filter((d) => Math.abs(d.depth) <= 0.15).length, deaths.length), mitadRival: pct(deaths.filter((d) => d.depth > 0.15).length, deaths.length) },
  carrilDeMuerte: { oeste: pct(deaths.filter((d) => d.x < -DIM(MAP) / 3).length, deaths.length), centro: pct(deaths.filter((d) => Math.abs(d.x) <= DIM(MAP) / 3).length, deaths.length), este: pct(deaths.filter((d) => d.x > DIM(MAP) / 3).length, deaths.length) },
  distanciaDeBaja: { corta: pct(deaths.filter((d) => d.range !== null && d.range < 8).length, deaths.length), media: pct(deaths.filter((d) => d.range >= 8 && d.range < 18).length, deaths.length), larga: pct(deaths.filter((d) => d.range >= 18).length, deaths.length) },
  armaEspecial: data.specials, bajasConEspecial: deaths.filter((d) => d.wep && d.wep !== 'smg' && d.wep !== 'shotgun').length,
  puestos: { ...data.perch, holdS: Math.round(data.perch.holdS) },
  presenciaPorZona: Object.fromEntries(Object.entries(data.zoneTime).sort().map(([k, v]) => [k, pct(v, data.samples)])),
  atascos: data.stuck, atascosContra: Object.entries(data.stuckAt ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12),
quietosMasDe8s: data.idle.length, ejemplosQuietos: data.idle.slice(0, 5),
  erroresDePagina: errors.length,
};
function DIM(map) { return { fortaleza: 26, azoteas: 31.5, calle2: 29 }[map] ?? 26; }
console.log(JSON.stringify(summary, null, 1));
if (OUT) fs.writeFileSync(path.join(OUT, `${MAP}-sim${RUN ? '-' + RUN : ''}.json`), JSON.stringify({ summary, rounds: data.rounds, deaths, idle: data.idle, errors }, null, 1));
