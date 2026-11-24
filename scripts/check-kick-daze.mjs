// La patada ATURDE: el bot pateado no dispara ni golpea mientras dura, se le
// empuja, y no puede volver a aturdirse hasta pasado el margen. Y al revés:
// el jugador pateado por un bot no puede disparar ni apuntar.
//   node scripts/check-kick-daze.mjs   (requiere dist/: npm run build)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { freePort } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = FREE_PORT;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let fail = 0;
const ok = (c, name, data) => { console.log(c ? 'OK  ' : 'FAIL', name, '—', JSON.stringify(data)); if (!c) fail++; };
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=off`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-bots').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('btn-lobby-start').click());
  await page.waitForFunction(() => window.BREACH.botMatch && !window.BREACH.botMatch.controlsLocked(), null, { timeout: 30000 });
  await page.waitForTimeout(500);

  // 1) patear a un bot enemigo colocado delante
  const kicked = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT, p = G.player, M = G.botMatch;
    const b = M.bots.find((x) => x.team !== M.playerTeam && x.alive);
    b.protT = 0; G.spawnProt = 0;
    // un rumbo con 2,6 m despejados delante (el punto de aparición puede mirar a un muro)
    let hx = 0, hz = 0;
    for (let k = 0; k < 16; k++) {
      const yaw = k * Math.PI / 8, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      let clear = true;
      for (let d = 0.5; d <= 3.2 && clear; d += 0.3) { const q = { x: p.pos.x + fx * d, z: p.pos.z + fz * d }; const x = q.x, z = q.z; p.world.resolveCircle(q, 0.5, p.y); if (Math.hypot(q.x - x, q.z - z) > 1e-4) clear = false; }
      if (clear) { p.yaw = yaw; p.cam.yaw = yaw; hx = p.pos.x + fx * 2.6; hz = p.pos.z + fz * 2.6; break; }
    }
    const hold = () => { b.pos.x = hx; b.pos.z = hz; b.y = p.y; b.yaw = Math.atan2(-(p.pos.x - hx), -(p.pos.z - hz)); };
    b.hp = 1000;
    hold();
    const hp0 = 1000, x0 = hx, z0 = hz;
    I.meleePressed = true;
    let dazeMax = 0, shotsWhileDazed = 0, sawDaze = false; const states = [];
    const shoot = M.botShoot.bind(M);
    M.botShoot = (bot, ...rest) => { if (bot === b && bot.dazeT > 0) shotsWhileDazed++; return shoot(bot, ...rest); };
    for (let i = 0; i < 90; i++) {
      if (!sawDaze) hold();
      G.selfHp = 100; // los otros bots disparan durante la prueba
      await new Promise((r) => requestAnimationFrame(r));
      if (states[states.length - 1] !== p.state) states.push(p.state);
      if (b.dazeT > 0) { sawDaze = true; dazeMax = Math.max(dazeMax, b.dazeT); }
    }
    const immune = b.dazeImmuneT;
    return { st: states.join('>'), dead: p.dead, hp0, hp: b.hp, alive: b.alive, dazeMax: +dazeMax.toFixed(2), shotsWhileDazed, immune: +immune.toFixed(2),
      pushed: +Math.hypot(b.pos.x - x0, b.pos.z - z0).toFixed(2) };
  });
  ok(kicked.hp < kicked.hp0, 'la patada conecta contra un bot', kicked);
  ok(kicked.dazeMax > 0.3, 'el bot queda aturdido', kicked);
  ok(kicked.shotsWhileDazed === 0, 'aturdido no dispara', kicked);

  // 2) el jugador pateado por un bot queda aturdido y sin puntería
  const self = await page.evaluate(async () => {
    const G = window.BREACH, I = window.BREACH_INPUT, p = G.player, M = G.botMatch;
    G.spawnProt = 0; G.kickDaze = 0; G.kickDazeImmune = 0;
    const b = M.bots.find((x) => x.team !== M.playerTeam && x.alive);
    const hp0 = G.selfHp;
    const result = M.botMelee ? (() => { b.pos.x = p.pos.x + 1.2; b.pos.z = p.pos.z; b.y = p.y; b.yaw = Math.atan2(1.2, 0); return M.botMelee(b); })() : null;
    const dazeAfter = G.kickDaze;
    I._mouseAim = true;
    let aimed = false;
    for (let i = 0; i < 12; i++) { await new Promise((r) => requestAnimationFrame(r)); if (p.aim) aimed = true; }
    I._mouseAim = false;
    return { hp0, hp: G.selfHp, result, dazeAfter: +(+dazeAfter).toFixed(2), aimedWhileDazed: aimed, dazed: !!p.dazed };
  });
  ok(self.dazeAfter > 0.3, 'el jugador pateado queda aturdido', self);
  ok(!self.aimedWhileDazed, 'aturdido no puede apuntar', self);
  ok(errors.length === 0, 'sin errores de página', errors.slice(0, 3));
} finally {
  await browser.close(); server.kill();
}
console.log(fail ? `\nPATADA ATURDE: ${fail} fallo(s)` : '\nPATADA ATURDE: todo verde');
process.exit(fail ? 1 : 0);
