// Observa muertes en el modo bots y mide el desplazamiento del cadáver
// (el ragdoll debe deslizar <1m, no salir volando del mapa).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8796' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8796/?nolock=1', { waitUntil: 'networkidle' });
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
// esperar la primera muerte de un bot y seguir su cadáver
let tracked = null;
for (let i = 0; i < 240 && !tracked; i++) {
  await page.waitForTimeout(250);
  tracked = await page.evaluate(() => {
    const dead = window.BREACH.botMatch.bots.find((b) => !b.alive);
    return dead ? dead.id : null;
  });
}
if (!tracked) { console.log('sin muertes en 60s'); process.exit(1); }
console.log('siguiendo cadáver de', tracked);

const samples = [];
for (let i = 0; i < 10; i++) {
  const s = await page.evaluate((id) => {
    const b = window.BREACH.botMatch.bots.find((x) => x.id === id);
    if (!b) return null;
    return {
      alive: b.alive,
      pos: [+b.pos.x.toFixed(2), +b.pos.z.toFixed(2)],
      rig: [+b.rig.root.position.x.toFixed(2), +b.rig.root.position.y.toFixed(2), +b.rig.root.position.z.toFixed(2)],
      rag: b.rig.rag ? { ox: +b.rig.rag.ox.toFixed(2), oz: +b.rig.rag.oz.toFixed(2), vx: +b.rig.rag.vx.toFixed(2) } : null,
    };
  }, tracked);
  console.log(i * 150 + 'ms', JSON.stringify(s));
  if (!s || s.alive) break;
  samples.push(s);
  if (i === 2) {
    // acercar la cámara del jugador al cadáver para verlo
    await page.evaluate((id) => {
      const b = window.BREACH.botMatch.bots.find((x) => x.id === id);
      const P = window.BREACH.player;
      P.pos.x = b.pos.x + 2.5; P.pos.z = b.pos.z + 2.5;
      P.cam.yaw = Math.atan2(-(b.pos.x - P.pos.x), -(b.pos.z - P.pos.z));
      P.cam.pitch = -0.4;
    }, tracked);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(root, 'scripts', 'shot-corpse.png') });
  }
  await page.waitForTimeout(150);
}
const first = samples[0], last = samples[samples.length - 1];
if (first && last) {
  const d = Math.hypot(last.rig[0] - first.pos[0], last.rig[2] - first.pos[1]);
  console.log('desplazamiento total del cadáver:', d.toFixed(2) + 'm');
}
await browser.close();
clearClip();
server.kill();
