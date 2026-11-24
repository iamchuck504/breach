// El tiro usa UN instante: a 16/50/100 ms por cuadro, saltando y con el
// asomo sobre LOW, cada muestra de tiro tiene origen, pose y rayo del mismo
// subpaso. Compara con lo de antes (ojo del render anterior).
import { actionKeys } from './lib-test.mjs';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu'] });
const fails = [];
const check = (n, ok, x = '') => { console.log(`${ok ? 'OK ' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!ok) fails.push(n); };
for (const FT of [16, 50, 100]) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  await page.addInitScript((ft) => {
    const o = window.requestAnimationFrame.bind(window); let vt = 0, lastTs = -1; window.requestAnimationFrame = (cb) => o((ts) => { if (ts !== lastTs) { lastTs = ts; vt += ft; } cb(vt); });
  }, FT);
  await page.goto('' + (process.env.BASE || 'http://127.0.0.1:5200') + '/?nolock=1&gfx=off', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH.mode === 'practice' && window.BREACH.player);
  const kb = await actionKeys(page, 'jump', 'evade', 'crouch');
  const res = await page.evaluate(async kb => {
    const HP = await import('/src/combat/hit-pose.js');
    const G = window.BREACH, I = window.BREACH_INPUT, W = window.BREACH_WORLD, p = G.player;
    const fr = (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const shots = []; let last = null;
    const collect = () => { const s = G.lastShot; if (s && s !== last) { last = s; shots.push(s); } };
    const loop = async (n) => { for (let i = 0; i < n; i++) { await fr(1); collect(); } };
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    await fr(20);
    // Un solo clic al primer cuadro que observa la salida. sinceSprint mide
    // la recuperación desde el subpaso exacto en que acabó la esquiva.
    const { sprintFireDelay } = await import('/src/combat/fire-gates.js');
    key('keydown', kb.evade);
    for (let i = 0; !p.dodge && i < 60; i++) await fr(1);
    key('keyup', kb.evade);
    if (!p.dodge) throw new Error('La esquiva no arrancó');
    for (let i = 0; p.dodge && i < 60; i++) await fr(1);
    if (p.dodge) throw new Error('La esquiva no terminó');
    const readyAt = G.simClock - p.sinceSprint + sprintFireDelay(G.weapons.cur);
    const beforeDodgeShot = G.lastShot;
    I.firePressed = true;
    for (let i = 0; G.lastShot === beforeDodgeShot && i < 60; i++) await fr(1);
    const dodgeShot = G.lastShot;
    if (!dodgeShot || dodgeShot === beforeDodgeShot) throw new Error('Sin tiro tras la esquiva');
    const dodgeEye = HP.eyeWorld(dodgeShot.pose, dodgeShot.x, dodgeShot.y, dodgeShot.z, dodgeShot.yaw);
    const dodgeError = dodgeShot.origin.distanceTo({ x: dodgeEye[0], y: dodgeEye[1], z: dodgeEye[2] });
    last = dodgeShot;
    // (a) disparar saltando
    I._mouseFire = true; I.firePressed = true;
    for (let k = 0; k < 3; k++) { key('keydown', kb.jump); await loop(2); key('keyup', kb.jump); await loop(12); }
    I._mouseFire = false; I.fireReleased = true;
    // (b) asomo: junto a una cara LOW, agachado, apuntar y disparar mientras sube
    const f = (W.faces || []).filter((q) => q.kind === 'low' && !(q.baseY > 0.05) && Math.hypot(q.b.x - q.a.x, q.b.z - q.a.z) > 1.2)
      .map((q) => ({ q, x: (q.a.x + q.b.x) / 2 + q.n.x * 0.75, z: (q.a.z + q.b.z) / 2 + q.n.z * 0.75 }))
      .find((c) => { const t = { x: c.x, z: c.z }; W.resolveCircle(t, 0.38, 0); return Math.hypot(t.x - c.x, t.z - c.z) < 0.01; });
    if (f) {
      await fr(10);
      for (let i = 0; !p.grounded && i < 90; i++) await fr(1);
      if (!p.grounded) throw new Error('El jugador no aterrizó antes del asomo');
      p.pos.x = f.x; p.pos.z = f.z; p.y = 0; p.cam.yaw = p.yaw = Math.atan2(f.q.n.x, f.q.n.z); p.cam.pitch = -0.02;
      key('keydown', kb.crouch); await loop(10);
      I._mouseAim = true; I._mouseFire = true; I.firePressed = true;
      await loop(8);
      I._mouseFire = false; I._mouseAim = false; key('keyup', kb.crouch);
    }
    const out = shots.map((s) => {
      const e = HP.eyeWorld(s.pose, s.pos.x, s.pos.y, s.pos.z, s.yaw);
      const h = HP.hitPose(s.pose).h, yaw = s.yaw;
      const hx = s.pos.x - Math.sin(yaw) * h[0] + Math.cos(yaw) * h[1], hy = s.pos.y + h[2], hz = s.pos.z - Math.cos(yaw) * h[0] - Math.sin(yaw) * h[1];
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const o = [s.origin.x, s.origin.y, s.origin.z], pe = [s.prevEye.x, s.prevEye.y, s.prevEye.z];
      return { st: s.pose.st, ce: s.pose.ce, y: s.pos.y, toEye: d(o, e), toHead: d(o, [hx, hy, hz]), prevToHead: d(pe, [hx, hy, hz]) };
    });
    return { dodgeError, dodgeLag: dodgeShot.t - readyAt, n: out.length, peek: !!f, worstToHead: Math.max(...out.map((r) => r.toHead)), worstToEye: Math.max(...out.map((r) => r.toEye)),
      worstPrev: Math.max(...out.map((r) => r.prevToHead)), airborne: out.filter((r) => r.y > 0.05).length, crouch: out.filter((r) => r.st === 'crouch').length };
  }, kb);
  check(`${FT} ms: primer tiro al recuperar la esquiva, origen = ojo de su muestra`,
    res.dodgeLag >= -1e-8 && res.dodgeLag <= 1 / 30 + 1e-8 && res.dodgeError <= 0.02,
    `retraso ${res.dodgeLag.toFixed(3)} s, error ${res.dodgeError.toFixed(4)} m`);
  check(`${FT} ms: muestras de tiro (${res.n}; en el aire ${res.airborne}; agachado/asomo ${res.crouch})`, res.n > 5 && res.airborne > 0 && res.crouch > 0, JSON.stringify(res));
  check(`${FT} ms: origen dentro de la cabeza de SU pose (≤ 0.12)`, res.worstToHead <= 0.1201, res.worstToHead.toFixed(3));
  check(`${FT} ms: origen = eyeWorld(pose) de SU subpaso (≤ 0.02, tolerancia del servidor)`, res.worstToEye <= 0.02, res.worstToEye.toFixed(3));
  console.log(`   antes (ojo del render anterior) llegaba a ${res.worstPrev.toFixed(3)} m de la cabeza de la pose del tiro`);
  await page.close();
}
await browser.close();
console.log(fails.length ? `FALLAN ${fails.length}` : 'FPS SHOT INSTANT OK');
process.exit(fails.length ? 1 : 0);
