// CLIPS COMPARABLES de movimiento y animación. Reproduce guiones de entradas
// en el juego real (modo práctica) con el reloj del navegador controlado: el
// juego avanza exactamente 1/60 s por paso, así el mismo guion produce el
// mismo clip en cualquier máquina y en cualquier versión del código.
//   node scripts/record-anim-clips.mjs <carpeta> [guion ...]
// Deja <guion>.mp4 (30 fps) en la carpeta. Sirve dist/: `npm run build` antes.
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || 'artifacts/anim-clips');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8829;
const EAST = -Math.PI / 2, NORTH = Math.PI; // rumbo de cámara: W avanza hacia +x / +z

// Guion: { en: [x, z], rumbo, cam: [dx, dy, dz], dura, pasos: [[t, acción], ...] }
// acciones: 'down:Key', 'up:Key', 'evade', 'jump', 'melee', 'reload', 'slot:n',
// 'aim:0|1', 'fire:0|1', 'click' (un disparo)
const SCRIPTS = {
  locomocion: { en: [-5, -13.4], rumbo: EAST, cam: [0.6, 1.45, -3.6], dura: 8.4, pasos: [
    [0.3, 'down:KeyW'], [1.7, 'up:KeyW'], [2.3, 'down:KeyS'], [3.3, 'up:KeyS'],
    [3.7, 'down:KeyD'], [4.5, 'up:KeyD'], [4.6, 'down:KeyA'], [5.4, 'up:KeyA'],
    [5.8, 'down:ShiftLeft'], [5.8, 'down:KeyW'], [6.8, 'up:KeyW'], [6.8, 'down:KeyS'], [7.9, 'up:KeyS'], [7.9, 'up:ShiftLeft'],
  ] },
  apuntar: { en: [-4, -13.4], rumbo: EAST, cam: [-0.4, 1.45, -3.0], dura: 6.2, pasos: [
    [0.5, 'aim:1'], [1.1, 'fire:1'], [1.8, 'fire:0'], [2.0, 'down:KeyW'], [3.0, 'up:KeyW'], [3.1, 'down:KeyD'], [3.8, 'up:KeyD'],
    [4.0, 'aim:0'], [4.4, 'fire:1'], [5.0, 'fire:0'], [5.2, 'down:KeyW'], [5.2, 'fire:1'], [5.9, 'fire:0'], [5.9, 'up:KeyW'],
  ] },
  esquivar: { en: [-5, -13.4], rumbo: EAST, cam: [1.0, 1.5, -3.8], dura: 4.6, pasos: [
    [0.3, 'down:KeyW'], [0.9, 'evade'], [1.9, 'evade'], [2.6, 'fire:1'], [3.0, 'fire:0'], [3.2, 'up:KeyW'], [3.4, 'down:KeyS'], [3.5, 'evade'], [4.2, 'up:KeyS'],
  ] },
  cobertura: { en: [-8.5, -7.4], rumbo: NORTH, cam: [3.0, 1.6, -2.6], dura: 8.0, pasos: [
    [0.3, 'down:KeyW'], [0.5, 'evade'], [0.9, 'up:KeyW'], [1.6, 'down:KeyD'], [2.3, 'up:KeyD'], [2.4, 'down:KeyA'], [3.4, 'up:KeyA'],
    [3.7, 'aim:1'], [4.3, 'fire:1'], [4.9, 'fire:0'], [5.2, 'aim:0'], [5.6, 'fire:1'], [6.1, 'fire:0'],
    [6.5, 'down:KeyW'], [6.6, 'evade'], [7.4, 'up:KeyW'],
  ] },
  salto: { en: [-5, -13.4], rumbo: EAST, cam: [0.8, 1.5, -3.8], dura: 4.6, pasos: [
    [0.4, 'jump'], [1.6, 'down:KeyW'], [2.1, 'jump'], [3.3, 'jump'], [3.5, 'jump'], [4.3, 'up:KeyW'],
  ] },
  armas: { en: [-4, -13.4], rumbo: EAST, cam: [-0.5, 1.45, -2.8], dura: 8.0, pasos: [
    [0.3, 'fire:1'], [0.8, 'fire:0'], [1.0, 'reload'], [3.2, 'slot:1'], [4.1, 'slot:2'], [5.0, 'slot:3'], [5.8, 'down:KeyW'], [6.0, 'click'], [7.2, 'up:KeyW'], [7.2, 'slot:0'],
  ] },
  melee: { en: [-4, -13.4], rumbo: EAST, cam: [0.6, 1.45, -3.0], dura: 3.4, pasos: [
    [0.4, 'melee'], [1.3, 'down:KeyW'], [1.9, 'melee'], [2.9, 'up:KeyW'],
  ] },
};
const wanted = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(SCRIPTS);

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const name of wanted) {
    const sc = SCRIPTS[name];
    if (!sc) { console.log('guion desconocido:', name); continue; }
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=off`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.getElementById('btn-enter')?.click());
    await page.waitForSelector('#splash.off', { state: 'attached' });
    await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; document.getElementById('btn-practice').click(); });
    await page.waitForFunction(() => !!window.BREACH.player, null, { timeout: 30000 });
    await page.waitForTimeout(3500); // modelos, sombreadores y retardo de entrada
    // a partir de aquí el tiempo del juego lo marca el guion
    await page.clock.install();
    await page.evaluate(([sc]) => {
      const G = window.BREACH, p = G.player, I = window.BREACH_INPUT;
      for (const d of G.dummies?.list ?? []) { d.alive = false; d.respawnT = 1e9; d.rig.root.visible = false; }
      document.getElementById('hud').style.visibility = 'hidden';
      // se recoloca DESPUÉS de asentar (ver más abajo): el arranque de la
      // práctica todavía puede devolver al jugador a su punto de aparición
      window.__place = () => {
        const q = G.player;
        q.pos.x = sc.en[0]; q.pos.z = sc.en[1]; q.y = 0; q.vy = 0; q.vel.x = q.vel.z = 0; q.grounded = true;
        q.cover = null; q.slide = null; q.dive = null; if (q.state !== 'idle') q._setState('idle');
        q.yaw = sc.rumbo; q.cam.yaw = sc.rumbo; q.cam.pitch = -0.04; q.cam._first = true;
        G.spawnProt = 0;
      };
      G.weapons.infinite = false;
      window.__act = (a) => {
        const [k, v] = a.split(':');
        if (k === 'down') I.keys.add(v); else if (k === 'up') I.keys.delete(v);
        else if (k === 'evade') I.evadePressed = true; else if (k === 'jump') I.jumpPressed = true;
        else if (k === 'melee') I.meleePressed = true; else if (k === 'reload') I.reloadPressed = true;
        else if (k === 'slot') I.slotPressed = Number(v);
        else if (k === 'aim') I._mouseAim = v === '1';
        else if (k === 'fire') { I._mouseFire = v === '1'; if (v === '1') I.firePressed = true; }
        else if (k === 'click') I.firePressed = true;
      };
      // cámara de observador: sigue al personaje con un desfase fijo en el mundo
      // Se engancha a la cámara del juego: tras colocarla él, se sustituye por
      // la del observador ANTES de que dibuje el cuadro. La puntería no se
      // entera (usa sus propios ángulos, no el objeto cámara).
      const follow = G.player.cam, update = follow.update.bind(follow);
      follow.update = (dt, player) => {
        update(dt, player);
        const c = follow.camera, x = player.pos.x, y = player.y ?? 0, z = player.pos.z;
        // encuadre de cuerpo entero: se ven los pies y queda aire por arriba
        c.position.set(x + sc.cam[0], y * 0.5 + sc.cam[1] - 0.25, z + sc.cam[2]);
        c.up.set(0, 1, 0); c.lookAt(x, y * 0.5 + 0.85, z);
        if (c.fov !== 50) { c.fov = 50; c.updateProjectionMatrix(); }
      };
      window.__observe = () => {};
    }, [sc]);
    const dir = path.join(OUT, `_${name}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 30; i++) await page.clock.runFor(1000 / 60);
    await page.evaluate(() => window.__place());
    for (let i = 0; i < 40; i++) await page.clock.runFor(1000 / 60); // asentar la pose inicial
    const at = await page.evaluate(() => [window.BREACH.player.pos.x, window.BREACH.player.pos.z, window.BREACH.player.state]);
    if (Math.hypot(at[0] - sc.en[0], at[1] - sc.en[1]) > 0.6) console.log('AVISO', name, 'no quedó en su sitio:', at);
    const steps = Math.round(sc.dura * 60);
    let next = 0, shot = 0;
    for (let f = 0; f < steps; f++) {
      const t = f / 60;
      while (next < sc.pasos.length && sc.pasos[next][0] <= t + 1e-6) { await page.evaluate((a) => window.__act(a), sc.pasos[next][1]); next++; }
      await page.clock.runFor(1000 / 60);
      if (f % 2 === 1) {
        await page.evaluate(() => window.__observe());
        await page.locator('#game').screenshot({ path: path.join(dir, `f${String(shot++).padStart(4, '0')}.png`) });
      }
    }
    await page.close();
    const mp4 = path.join(OUT, `${name}.mp4`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);
    if (r.status !== 0) console.log('ffmpeg falló:', String(r.stderr).slice(0, 300));
    else { fs.rmSync(dir, { recursive: true, force: true }); console.log('clip', mp4, `(${shot} cuadros)`); }
  }
} finally {
  await browser.close(); server.kill(); await clearClip();
}
