// Diagnóstico del flujo cover→mantle del smoke: ¿por qué el snap no entra?
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
  env: { ...process.env, PORT: '8785' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8785/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const enter = document.getElementById('btn-enter');
  if (enter) enter.click();
});
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1500);
const setup = await page.evaluate(() => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
  if (!f) return { err: 'sin cara LOW n.z<-0.9' };
  const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
  G.player.pos.x = mx; G.player.pos.z = mz - 1.2;
  G.player.cam.yaw = Math.PI; G.player.yaw = Math.PI;
  G.player.vel.x = 0; G.player.vel.z = 0;
  G.player.y = 0;
  return { face: { mx: +mx.toFixed(2), mz: +mz.toFixed(2), h: f.h }, mode: G.mode };
});
console.log('SETUP:', JSON.stringify(setup));
await page.waitForTimeout(300);
const pre = await page.evaluate(() => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  const P = G.player;
  const dir = { x: -Math.sin(P.yaw), z: -Math.cos(P.yaw) };
  const snap = W.findCover(P.pos, dir, 1.7, 0.38, 0.3);
  return {
    pos: [+P.pos.x.toFixed(2), +P.pos.z.toFixed(2)], yaw: +P.yaw.toFixed(2),
    grounded: P.grounded, state: P.state,
    snap: snap ? { d: +snap.dist.toFixed(2), h: snap.face.h } : null,
    suppress: window.BREACH_INPUT.suppress, menu: !document.getElementById('menu').classList.contains('off'),
  };
});
console.log('PRE:', JSON.stringify(pre));
await page.keyboard.press('Space');
await page.waitForTimeout(300);
const post = await page.evaluate(() => ({
  state: window.BREACH.player.state,
  pos: [+window.BREACH.player.pos.x.toFixed(2), +window.BREACH.player.pos.z.toFixed(2)],
}));
console.log('POST:', JSON.stringify(post));
await browser.close();
server.kill();
clearClip();
