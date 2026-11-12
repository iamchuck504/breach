// GRANADA EXPLOSIVA: el gesto de lanzamiento debe ser continuo (sin saltos de
// pose a mitad), el bote debe salir con el brazo ya al frente, y la granada en
// vuelo debe verse y moverse de forma continua aunque el estado llegue a 20 Hz
// (online). Capturas opcionales con SHOT_DIR.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8818;
const SHOT_DIR = process.env.SHOT_DIR || '';
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.mode === 'practice' && window.BREACH?.protoEngine, null, { timeout: 20000 });
  // esperar a que la escena deje de meter cuadros largos
  await page.evaluate(() => new Promise((res) => {
    let last = performance.now(), calm = 0; const t0 = last;
    const f = (t) => { calm = t - last < 40 ? calm + 1 : 0; last = t;
      if (calm >= 45 || t - t0 > 8000) res(); else requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }));

  // tomar granadas del pickup real y equiparlas
  const equipped = await page.evaluate(async () => {
    const G = window.BREACH;
    for (const d of G.dummies.list) d.alive = false;
    const pick = G.protoSnapshot.pickups.find((p) => p.kind === 'frag' && p.count > 0);
    if (!pick) return { error: 'sin pickup de granadas' };
    G.player.pos.x = pick.x; G.player.pos.z = pick.z; G.player.y = pick.y;
    G.protoEngine.claim('player', pick.id, true);
    G.player.pos.x = 0; G.player.pos.z = 8; G.player.y = 0;
    G.player.yaw = 0; G.player.cam.yaw = 0; G.player.cam.pitch = 0.12;
    G.weapons.startSwap('frag');
    await new Promise((r) => setTimeout(r, 900));
    return { cur: G.weapons.cur, mag: G.weapons.st.mag };
  });
  check('la granada explosiva se equipa desde su pickup', equipped.cur === 'frag' && equipped.mag === 2, JSON.stringify(equipped));

  // --- gesto: muestreo cuadro a cuadro de torso y brazo
  const startThrow = () => page.evaluate(() => {
    const G = window.BREACH, I = window.BREACH_INPUT;
    window.__throw = { samples: [], releaseAt: null, t0: performance.now() };
    const rec = window.__throw;
    const tick = (t) => {
      const rig = G.rig;
      rec.samples.push({ t: t - rec.t0, throwT: G.throwT,
        torsoY: rig.torso.rotation.y, torsoX: rig.torso.rotation.x,
        armX: rig.gunMount.rotation.x, armZ: rig.gunMount.position.z,
        flying: (G.protoSnapshot?.projectiles ?? []).length });
      if (rec.releaseAt === null && rec.samples.at(-1).flying > 0) {
        rec.releaseAt = t - rec.t0; rec.releaseArmZ = rig.gunMount.position.z; rec.releaseArmX = rig.gunMount.rotation.x;
      }
      if (t - rec.t0 < 1400) requestAnimationFrame(tick); else rec.done = true;
    };
    requestAnimationFrame(tick);
    I._mouseFire = true; I.firePressed = true;
    setTimeout(() => { I._mouseFire = false; }, 60);
  });
  await startThrow();
  if (SHOT_DIR) for (const ms of [90, 170, 250, 330, 430, 700]) {
    await page.waitForFunction((m) => performance.now() - window.__throw.t0 >= m, ms);
    await page.screenshot({ path: path.join(SHOT_DIR, `frag-${String(ms).padStart(3, '0')}.png`) });
  }
  await page.waitForFunction(() => window.__throw.done, null, { timeout: 8000 });
  const gesture = await page.evaluate(() => {
    const rec = window.__throw, s = rec.samples.filter((x) => x.throwT > 0);
    // salto máximo por cuadro, normalizado a 60 Hz, de cada articulación
    const jump = (key) => {
      let worst = 0;
      for (let i = 1; i < s.length; i++) {
        const dt = Math.max(1, s[i].t - s[i - 1].t);
        worst = Math.max(worst, Math.abs(s[i][key] - s[i - 1][key]) * (16.7 / dt));
      }
      return +worst.toFixed(3);
    };
    const range = (key) => +(Math.max(...s.map((x) => x[key])) - Math.min(...s.map((x) => x[key]))).toFixed(2);
    return { frames: s.length, releaseMs: rec.releaseAt === null ? null : Math.round(rec.releaseAt),
      releaseArmZ: +(rec.releaseArmZ ?? 0).toFixed(2), releaseArmX: +(rec.releaseArmX ?? 0).toFixed(2),
      torsoYJump: jump('torsoY'), torsoXJump: jump('torsoX'), armXJump: jump('armX'),
      torsoYRange: range('torsoY'), armXRange: range('armX') };
  });
  check('el gesto se reproduce completo (armar + latigazo visibles)',
    gesture.frames > 12 && gesture.armXRange > 1.4 && gesture.torsoYRange > 0.35, JSON.stringify(gesture));
  check('sin saltos de pose: torso y brazo avanzan de forma continua',
    gesture.torsoYJump < 0.2 && gesture.torsoXJump < 0.12 && gesture.armXJump < 0.6, JSON.stringify(gesture));
  check('el bote sale con el brazo YA al frente (no con la mano atrás)',
    gesture.releaseMs !== null && gesture.releaseArmZ < 0 && gesture.releaseArmX > -0.6, JSON.stringify(gesture));

  // --- granada en vuelo: modelo real, visible y con baliza
  const flight = await page.evaluate(() => {
    const G = window.BREACH;
    const item = [...G.protoView.items.entries()].find(([id]) => id.startsWith('projectile:'))?.[1];
    if (!item) return { error: 'sin proyectil visible' };
    const box = new window.THREE.Box3().setFromObject(item.userData.body);
    const size = box.getSize(new window.THREE.Vector3());
    return { hasModel: !!item.userData.body && item.userData.body.children.length > 1,
      hasBeacon: !!item.userData.beacon?.visible, visible: item.visible,
      size: +Math.max(size.x, size.y, size.z).toFixed(2) };
  });
  check('en vuelo se dibuja la granada real, más grande y con baliza',
    flight.hasModel && flight.hasBeacon && flight.visible && flight.size >= 0.3, JSON.stringify(flight));

  // --- continuidad con estado a 20 Hz (lo que recibe un cliente online)
  const smooth = await page.evaluate(async () => {
    const { PrototypeView } = await import('/src/combat/prototype-view.js');
    const measure = (View) => {
      const scene = new window.THREE.Scene(), view = new View(scene);
      const pos = (t) => ({ x: 6 * t, y: 1.4 + 6 * t - 7.5 * t * t, z: -9 * t }); // arco balístico
      const steps = [];
      let prev = null;
      for (let frame = 0; frame <= 60; frame++) {
        const time = frame / 60, tick = Math.floor(time * 20) / 20; // estado congelado entre ticks
        view.update({ active: true, pickups: [], states: [], projectiles: [{ id: 1, kind: 'frag', ...pos(tick), t: tick }] }, [], 100 + time);
        const m = view.items.get('projectile:1').position;
        if (prev && frame > 12) steps.push(Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z));
        prev = { x: m.x, y: m.y, z: m.z };
      }
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      const frozen = steps.filter((s) => s < mean * 0.25).length;
      return { frozenFrames: frozen, frames: steps.length,
        unevenness: +(Math.max(...steps) / Math.max(1e-6, Math.min(...steps))).toFixed(2) };
    };
    return measure(PrototypeView);
  });
  check('vuelo continuo con estado a 20 Hz: ningún cuadro congelado ni tirones',
    smooth.frozenFrames === 0 && smooth.unevenness < 2.2, JSON.stringify(smooth));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser.close();
  server.kill();
  await clearClip();
}

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nGRANADA EXPLOSIVA: todo verde');
process.exit(fails.length ? 1 : 0);
