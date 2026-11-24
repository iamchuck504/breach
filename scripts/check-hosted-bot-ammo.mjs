// Bots ALOJADOS honestos bajo la contabilidad del servidor (cargador,
// reserva, recarga, especiales y evidencia de cambio de arma): una partida
// alojada larga, con varias recargas, no puede tener NI UN disparo de bot
// rechazado. Cuenta los botFire enviados por el host frente a los `fire`
// difundidos por el servidor con el id del bot, y cohetes/humo rechazados.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { freePort } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = FREE_PORT;
const SECONDS = Number(process.env.BOT_AMMO_SECONDS || 180); // tope; termina antes al cumplir
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port), INTRO_TIME: '0', COUNTDOWN_TIME: '0',
    NODE_ENV: 'test', BREACH_LOG_FIRE_REJECTS: '1' },
  stdio: ['ignore', 'pipe', 'ignore'],
});
// motivos de rechazo que el servidor reporta (solo en pruebas)
const rejectLog = [], nadeLog = [];
createInterface({ input: server.stdout }).on('line', line => {
  if (line.startsWith('[botFire rechazado]')) rejectLog.push(line);
  if (line.startsWith('[nade rechazado]')) nadeLog.push(line);
});
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = false;
try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&gfx=low`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.evaluate((p) => {
    document.getElementById('in-name').value = 'HOST';
    document.getElementById('in-server').value = `ws://127.0.0.1:${p}`;
  }, port);
  await page.evaluate(() => document.getElementById('btn-lobby-create').click());
  await page.waitForFunction(() => window.BREACH?.net?.connected && window.BREACH?.lobby?.hostId, null, { timeout: 20000, polling: 100 });
  for (const team of ['red', 'red', 'red', 'blue', 'blue', 'blue', 'blue']) {
    await page.evaluate((t) => window.BREACH.net.lobbyAddBot(t), team);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.BREACH.net.lobbyStart());
  await page.waitForFunction(() => window.BREACH?.mode === 'online' && window.BREACH?.onlineBots?.bots?.length >= 6,
    null, { timeout: 30000, polling: 100 });
  await page.evaluate(() => {
    const G = window.BREACH, N = G.net, M = G.onlineBots;
    const c = window.__ammo = { sent: {}, echoed: {}, rocketRej: 0, nadeRej: 0, launchRejects: [], reloads: 0, bySent: {}, pend: [], deaths: [] };
    const key = (id, p) => `${id}|${p.x.toFixed(2)}|${p.y.toFixed(2)}|${p.z.toFixed(2)}`;
    const f0 = N.botFire.bind(N);
    N.botFire = (id, o, p, w, ...rest) => {
      c.sent[id] = (c.sent[id] || 0) + 1; c.bySent[w] = (c.bySent[w] || 0) + 1;
      c.pend.push({ k: key(id, p), id, t: performance.now(), playing: G.onlinePhase === 'playing' });
      return f0(id, o, p, w, ...rest);
    };
    const d0 = N.handlers.death;
    N.handlers.death = (m) => { c.deaths.push({ id: m.target, t: performance.now() }); return d0?.(m); };
    for (const [t, key] of [['fire', 'echoed'], ['rocketReject', 'rocketRej'], ['nadeReject', 'nadeRej']]) {
      const h0 = N.handlers[t];
      N.handlers[t] = (m) => {
        if (t === 'fire') {
          if (M.botById(m.id)) {
            c.echoed[m.id] = (c.echoed[m.id] || 0) + 1;
            // el servidor puede recortar el endpoint contra el mapa: casar por bot y orden
            const k = `${m.id}|${m.p.map((v) => v.toFixed(2)).join('|')}`;
            const i = c.pend.findIndex((e) => e.k === k) >= 0 ? c.pend.findIndex((e) => e.k === k) : c.pend.findIndex((e) => e.id === m.id);
            if (i >= 0) c.pend.splice(i, 1);
          }
        }
        else if (typeof m.cid === 'string' && /^(b|nb):/.test(m.cid)) {
          c[key]++;
          c.launchRejects.push({ id: m.id, life: m.life, cid: m.cid, reason: m.reason });
        }
        return h0?.(m);
      };
    }
    // recargas reales de los bots (flanco de reloadT)
    const was = new Map();
    c.timer = setInterval(() => {
      for (const b of M.bots) {
        const r = b.reloadT > 0;
        if (r && !was.get(b.id)) c.reloads++;
        was.set(b.id, r);
      }
    }, 50);
  });
  // jugar hasta ≥ 6 recargas reales y ≥ 200 disparos (o el tope de tiempo)
  for (let t = 0; t < SECONDS; t += 5) {
    await page.waitForTimeout(5000);
    const p = await page.evaluate(() => ({ r: window.__ammo.reloads, n: Object.values(window.__ammo.sent).reduce((a, b) => a + b, 0) }));
    if (p.r >= 6 && p.n >= 200) break;
  }
  // dejar llegar los últimos ecos
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const c = window.__ammo; clearInterval(c.timer);
    const ids = Object.keys(c.sent);
    const sent = ids.reduce((a, id) => a + c.sent[id], 0);
    const echoed = ids.reduce((a, id) => a + (c.echoed[id] || 0), 0);
    // sin eco: descartar los que viajaban cuando el bot murió o acabó la ronda
    // (el servidor rechaza con razón los tiros de un muerto); el resto cuenta
    // sin eco aún al cortar la medición (enviado en el último segundo): en vuelo
    const tEnd = performance.now();
    c.pend = c.pend.filter((e) => tEnd - e.t > 1000);
    const lostToDeath = c.pend.filter((e) => !e.playing || c.deaths.some((d) => d.id === e.id && d.t >= e.t - 50 && d.t - e.t < 600)).length;
    return { sent, echoed, rejected: c.pend.length - lostToDeath, lostToDeath, perBot: ids.map((id) => [id, c.sent[id], c.echoed[id] || 0]),
      byWeapon: c.bySent, rocketRej: c.rocketRej, nadeRej: c.nadeRej, launchRejects: c.launchRejects, reloads: c.reloads, phase: window.BREACH.onlinePhase };
  });
  // el servidor dice POR QUÉ rechazó: un bot ya muerto, aturdido por una patada
  // o aturdido por stun en el servidor (el host aún no lo sabía: el tiro
  // viajaba cuando murió) o la ronda terminada son rechazos correctos; el
  // resto, incluido lo que no casó en el cliente sin motivo, cuenta
  const reasons = rejectLog.map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  const legit = reasons.filter((x) => !x.alive || x.dazed || x.stunned || x.phase !== 'playing').length;
  r.honestRejected = Math.max(reasons.length - legit, r.rejected + r.lostToDeath - legit);
  const ok = r.sent > 200 && r.reloads >= 6 && r.honestRejected === 0 && r.rocketRej === 0 && r.nadeRej === 0 && errors.length === 0;
  console.log(`${ok ? 'OK ' : 'FAIL'} bots alojados: ${r.sent} disparos, ${r.honestRejected} honestos rechazados (${legit} de bots ya muertos), ${r.reloads} recargas, cohetes/humo rechazados ${r.rocketRej}/${r.nadeRej}`);
  console.log(JSON.stringify({ ...r, errors }));
  if (rejectLog.length) console.log(rejectLog.slice(0, 5).join('\n'));
  if (nadeLog.length) console.log(nadeLog.join('\n'));
  failed = !ok;
} finally {
  await browser.close();
  server.kill();
}
if (failed) { console.error('HOSTED BOT AMMO FAILED'); process.exit(1); }
console.log('HOSTED BOT AMMO OK — bots honestos nunca rechazados bajo la contabilidad del servidor');
