// Observa una partida vs bots y mide separación, ancho de despliegue, destinos
// tácticos, concentración central, variedad de roles y visitas a cobertura.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8789' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
const LAYOUT = process.argv[2] || 'fortaleza';
const DURATION = Math.max(10, Number(process.argv[3]) || 30);
await page.goto('http://localhost:8789/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate((l) => { window.BREACH.mapChoice = l; }, LAYOUT);
// btn-bots abre el LOBBY local; iniciar y esperar el fin del despliegue
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-bots').click());
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('btn-lobby-start').click());
await page.waitForFunction(
  () => window.BREACH.botMatch && !window.BREACH.botMatch.controlsLocked(),
  null, { timeout: 30000 },
);

let flips = 0, covers = 0, minDistAcc = 0, samples = 0;
let goalDistAcc = 0, goalSamples = 0, spanAcc = 0, spanSamples = 0;
let center = 0, positions = 0, coverSafeN = 0, coverUnsafeN = 0;
const coverSeen = new Set();
const rolesSeen = new Set(), zonesSeen = new Set();
for (let i = 0; i < DURATION * 2; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => {
    const bots = window.BREACH.botMatch?.bots ?? [];
    let flip = 0;
    const inCover = [];
    let minD = Infinity, minGoalD = Infinity, span = 0, center = 0, positions = 0;
    const roles = [], zones = [];
    const fx = window.BREACH_WORLD?.fx ?? 21;
    const fz = window.BREACH_WORLD?.fz ?? 26.6;
    // covers SEGUROS de verdad: escondido (hide/peek) con la línea de tiro
    // del enemigo más cercano bloqueada desde su postura real
    let coverSafe = 0, coverUnsafe = 0;
    const T = window.THREE, W = window.BREACH_WORLD;
    const _o = new T.Vector3(), _d = new T.Vector3();
    for (const b of bots) {
      if (!b.alive) continue;
      if (b.flip) flip++;
      if (b.state === 'cover') inCover.push(b.id);
      // solo la fase 'hide': el peek se asoma a disparar A PROPÓSITO
      if (b.state === 'cover' && b.coverPhase === 'hide' && W) {
        let ne = null, nd = Infinity;
        for (const o of bots) {
          if (!o.alive || o.team === b.team) continue;
          const d = Math.hypot(o.pos.x - b.pos.x, o.pos.z - b.pos.z);
          if (d < nd) { nd = d; ne = o; }
        }
        if (ne && nd < 28) {
          const eye = b.cover?.low ? 0.8 : 1.2;
          _o.set(b.pos.x, eye, b.pos.z);
          _d.set(ne.pos.x - b.pos.x, 0.1, ne.pos.z - b.pos.z);
          const len = _d.length();
          _d.normalize();
          if (W.raycast(_o, _d, len) !== null) coverSafe++; else coverUnsafe++;
        }
      }
      roles.push(b.role);
      center += Math.abs(b.pos.x) < fx * 0.3 ? 1 : 0;
      positions++;
      const lane = b.pos.x < -fx / 3 ? 'L' : b.pos.x > fx / 3 ? 'R' : 'C';
      const depth = Math.max(0, Math.min(3, Math.floor((b.pos.z + fz) / (fz * 0.5))));
      zones.push(`${b.team}:${lane}${depth}`);
      for (const o of bots) {
        if (o === b || !o.alive || o.team !== b.team) continue;
        const d = Math.hypot(b.pos.x - o.pos.x, b.pos.z - o.pos.z);
        if (d < minD) minD = d;
        if (b.tacticalGoal && o.tacticalGoal) {
          const gd = Math.hypot(b.tacticalGoal.x - o.tacticalGoal.x,
            b.tacticalGoal.z - o.tacticalGoal.z);
          if (gd < minGoalD) minGoalD = gd;
        }
      }
    }
    for (const team of ['red', 'blue']) {
      const xs = bots.filter((b) => b.alive && b.team === team).map((b) => b.pos.x);
      if (xs.length > 1) span += Math.max(...xs) - Math.min(...xs);
    }
    return {
      flip, inCover, roles, zones, center, positions, fx, coverSafe, coverUnsafe,
      minD: isFinite(minD) ? +minD.toFixed(2) : null,
      minGoalD: isFinite(minGoalD) ? +minGoalD.toFixed(2) : null,
      span: span / 2,
    };
  });
  flips += s.flip;
  for (const id of s.inCover) coverSeen.add(id);
  for (const role of s.roles) rolesSeen.add(role);
  for (const zone of s.zones) zonesSeen.add(zone);
  center += s.center; positions += s.positions;
  coverSafeN += s.coverSafe; coverUnsafeN += s.coverUnsafe;
  if (s.minD !== null) { minDistAcc += s.minD; samples++; }
  if (s.minGoalD !== null) { goalDistAcc += s.minGoalD; goalSamples++; }
  spanAcc += s.span / s.fx; spanSamples++;
}
covers = coverSeen.size;
const avgMin = +(minDistAcc / Math.max(1, samples)).toFixed(2);
const avgGoalMin = +(goalDistAcc / Math.max(1, goalSamples)).toFixed(2);
const avgSpanRatio = +(spanAcc / Math.max(1, spanSamples)).toFixed(2);
const centerRatio = +(center / Math.max(1, positions)).toFixed(2);
console.log('AI-CHECK:', JSON.stringify({
  segundos: DURATION,
  flipsVistos: flips,
  botsQueCubrieron: covers,
  distMinPromedio: avgMin,
  destinosMinPromedio: avgGoalMin,
  anchoEscuadraNormalizado: avgSpanRatio,
  concentracionCentro: centerRatio,
  rolesObservados: [...rolesSeen],
  zonasVisitadas: zonesSeen.size,
  coverSeguro: coverSafeN, coverExpuesto: coverUnsafeN,
  pageErrors,
}));

await browser.close();
server.kill();
clearClip();

// asertos anti-regresión (el cover es situacional: no se exige).
// Nota: animación y combate conservan variación, por lo que los números cambian
// entre corridas; los umbrales validan la capa táctica, no un guion exacto.
// cover seguro: con muestra suficiente, ≥75% de los escondites deben romper
// de verdad la línea de tiro del enemigo más cercano
const coverOk = (coverSafeN + coverUnsafeN) < 5 ||
  coverSafeN / (coverSafeN + coverUnsafeN) >= 0.75;
const ok = pageErrors === 0 && avgMin > 2.4 && avgGoalMin > 2.4 &&
  avgSpanRatio > 0.24 && centerRatio < 0.72 && rolesSeen.size >= 4 &&
  zonesSeen.size >= 8 && coverOk;
console.log(ok ? 'AI OK' : 'AI FALLO ' + JSON.stringify({
  avgMin, avgGoalMin, avgSpanRatio, centerRatio, roles: rolesSeen.size,
  zones: zonesSeen.size, coverSafeN, coverUnsafeN, pageErrors,
}));
process.exit(ok ? 0 : 1);
