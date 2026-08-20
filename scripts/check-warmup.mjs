import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8801' }, stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 900));

let browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:8801/?nolock=1', { waitUntil: 'networkidle' });

  const started = Date.now();
  await page.click('#btn-enter');
  await page.waitForSelector('#splash.off', { state: 'attached' });
  const warmMs = Date.now() - started;
  const prepared = await page.evaluate(() => ({
    audio: Object.keys(window.BREACH_AUDIO.samples).sort(),
    audioPrepared: window.BREACH_AUDIO._prepared,
    effectsPrepared: window.BREACH_EFFECTS._prepared,
    transient: window.BREACH_EFFECTS.items.length,
    tracersFree: window.BREACH_EFFECTS._tracerPool.free.length,
    flashesFree: window.BREACH_EFFECTS._flashPools.map((p) => p.free.length),
  }));

  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(700);
  const lightResult = await page.evaluate(() => {
    const scene = window.BREACH_EFFECTS.scene;
    const activePoints = () => {
      let count = 0;
      scene.traverse((o) => {
        if (!o.isPointLight) return;
        let p = o;
        while (p && p.visible) p = p.parent;
        if (!p) count++;
      });
      return count;
    };
    const totalPoints = () => {
      let count = 0; scene.traverse((o) => { if (o.isPointLight) count++; }); return count;
    };
    const before = { active: activePoints(), total: totalPoints() };
    window.BREACH_EFFECTS.muzzleFlash(new window.THREE.Vector3(0, 1, 0));
    const firing = { active: activePoints(), total: totalPoints() };
    const crate = window.BREACH.crates.crates[0];
    window.BREACH.weapons.state.smg.mag = 1;
    window.BREACH.crates.update(1 / 60, crate.x, crate.z, 0, true, () => {});
    const afterPickup = { active: activePoints(), total: totalPoints(), crateUp: crate.up };
    return { before, firing, afterPickup };
  });

  const fail = [];
  if (!prepared.audioPrepared || prepared.audio.join(',') !== 'shotgun,smg') fail.push('audio no preparado');
  if (!prepared.effectsPrepared || prepared.transient !== 0) fail.push('efectos no limpiados');
  if (prepared.tracersFree !== 32 || prepared.flashesFree.some((n) => n !== 16)) fail.push('pool incompleto');
  if (lightResult.before.total !== lightResult.firing.total) fail.push('disparo agregó una PointLight');
  if (lightResult.before.active !== lightResult.firing.active) fail.push('disparo cambió luces activas');
  if (lightResult.before.total !== lightResult.afterPickup.total ||
      lightResult.before.active !== lightResult.afterPickup.active) {
    fail.push('pickup cambió la configuración de luces');
  }
  if (lightResult.afterPickup.crateUp) fail.push('la caja no se recogió');
  if (errors.length) fail.push(...errors);
  if (fail.length) throw new Error(fail.join(' · '));
  console.log(`WARMUP OK · ${warmMs}ms · audio/efectos/pools · luces estables`);
} finally {
  await browser?.close();
  server.kill();
}
