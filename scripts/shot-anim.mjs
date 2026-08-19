// Matriz visual de animaciones: estados × armas × frames del swap, por
// variante — para cazar clipping (arma vs cuerpo/armadura/mochila), manos
// fuera del arma y saltos de pose con los modelos nuevos.
// Uso: node scripts/shot-anim.mjs   → scripts/anim/*.png
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outDir = path.join(root, 'scripts', 'anim');
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8786' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:8786/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1500);

// congelar el juego y montar un rig controlado a mano
await page.evaluate(() => {
  const G = window.BREACH;
  const scene = G.rig.root.parent;
  G.rig.dispose(scene);
  G.player = null; // el loop deja de pisar cámara y rig
  document.getElementById('hud').classList.remove('on');
  window.__scene = scene;
  window.__mk = (variant) => {
    if (window.__r) window.__r.dispose(window.__scene);
    const r = new window.BREACH_RIG(window.__scene, 'red', null, variant);
    r.setTransform(0, -6, 0, 0); // mira a -z
    window.__r = r;
    return true;
  };
  window.__pose = (p, frames) => {
    for (let i = 0; i < frames; i++) window.__r.update(1 / 30, p);
  };
  window.__mk(0);
});

const CAMS = {
  fr: [[1.7, 1.6, -8.3], [0, 1.0, -6]],   // 3/4 frontal derecha
  fl: [[-1.7, 1.6, -8.3], [0, 1.0, -6]],  // 3/4 frontal izquierda
  back: [[0.9, 1.6, -3.8], [0, 1.0, -6]], // espalda (arma secundaria/mochila)
  side: [[2.5, 1.2, -6], [0, 1.0, -6]],   // perfil derecho
};
async function cam(which) {
  await page.evaluate(([pos, at]) => {
    window.BREACH_CAM.position.set(...pos);
    window.BREACH_CAM.lookAt(...at);
  }, CAMS[which]);
}
async function shot(name) {
  await page.waitForTimeout(60);
  await page.screenshot({ path: path.join(outDir, name + '.png') });
  console.log('shot', name);
}
const P = (over) => ({ state: 'idle', speed: 0, aim: false, aimPitch: 0, firing: false, ...over });

// ---- estados con SMG activa (escopeta a la espalda), variante RECLUTA
const states = [
  ['idle', P({}), 45],
  ['run', P({ state: 'run', speed: 0.6 }), 45],
  ['roadie', P({ state: 'roadie', speed: 1 }), 45],
  ['jump', P({ state: 'jump' }), 40],
  ['aim', P({ aim: true, aimPitch: -0.1 }), 45],
  ['fire-hip', P({ firing: true }), 40],
  ['cover-low', P({ state: 'cover_low' }), 45],
  ['cover-high', P({ state: 'cover_high' }), 45],
  ['blind-over', P({ state: 'blind_over', firing: true }), 40],
  ['reload-mid', P({ reloading: true, reloadT: 0.5 }), 45],
  ['dive', P({ state: 'dive' }), 35],
  ['slide', P({ state: 'slide' }), 35],
];
for (const wep of ['smg', 'shotgun']) {
  await page.evaluate((w) => { window.__r.setWeapon(w); }, wep);
  for (const [name, p, frames] of states) {
    await page.evaluate(({ p, frames }) => window.__pose(p, frames), { p, frames });
    await cam('fr');
    await shot(`v0-${wep}-${name}-fr`);
    if (name === 'idle' || name === 'roadie' || name === 'cover-low') {
      await cam('back');
      await shot(`v0-${wep}-${name}-back`);
    }
  }
}

// ---- SWAP: secuencia de frames del gesto (smg→escopeta) en v0 y v1 (casco torre)
for (const variant of [0, 1]) {
  await page.evaluate((v) => window.__mk(v), variant);
  await page.evaluate(() => { window.__r.setWeapon('smg'); window.__pose({ state: 'idle', speed: 0, aim: false, aimPitch: 0 }, 50); });
  // subir al gesto de swap y capturar el barrido en 4 puntos
  for (const [tag, frames, mid] of [['a', 3, false], ['b', 6, false], ['c', 3, true], ['d', 8, false], ['e', 14, false]]) {
    await page.evaluate(({ frames, mid }) => {
      if (mid) window.__r.setWeapon('shotgun'); // el intercambio real, a mitad del gesto
      window.__pose({ state: 'idle', speed: 0, aim: false, aimPitch: 0, swapping: frames < 12 }, frames);
    }, { frames, mid });
    await cam('fr');
    await shot(`v${variant}-swap-${tag}-fr`);
  }
}

// ---- espalda por variante: arma secundaria vs mochila/armadura
for (const variant of [0, 1, 2, 3, 4]) {
  await page.evaluate((v) => window.__mk(v), variant);
  await page.evaluate(() => { window.__r.setWeapon('smg'); window.__pose({ state: 'idle', speed: 0, aim: false, aimPitch: 0 }, 45); });
  await cam('back');
  await shot(`v${variant}-back-idle`);
}
// v3 (PESADO, hombreras grandes) apuntando: ¿pauldron vs casco/cuello?
await page.evaluate(() => window.__mk(3));
await page.evaluate(() => { window.__r.setWeapon('smg'); window.__pose({ state: 'idle', speed: 0, aim: true, aimPitch: -0.15 }, 50); });
await cam('fr');
await shot('v3-smg-aim-fr');

await browser.close();
server.kill();
clearClip();
console.log('ANIM SHOTS OK →', outDir);
