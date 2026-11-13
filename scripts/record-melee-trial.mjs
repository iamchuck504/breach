// CLIPS DE PRUEBA DEL GOLPE cuerpo a cuerpo: un rival quieto en un carril de
// Fortaleza, cámara de perfil, media velocidad y la vida del rival en pantalla.
//   node scripts/record-melee-trial.mjs <carpeta> [escena ...]
// BREACH_ROOT = árbol cuyo servidor y dist/ se graban (por defecto, este).
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { CHROME } from './lib-chrome.mjs';

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.BREACH_ROOT ? path.resolve(process.env.BREACH_ROOT) : here;
const OUT = path.resolve(process.argv[2] || 'artifacts/melee-trial');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 8833);
const Z = -22.5, X0 = -8; // carril despejado de Fortaleza, hacia +x

// rival: [distancia, 'frente' | 'espalda'] o null
const SCENES = {
  embestida: { rival: [3.2, 'frente'], dura: 2.8, pasos: [[0.5, 'melee'], [1.7, 'melee']] },
  placaje: { rival: [9.6, 'frente'], dura: 2.6, pasos: [[0.2, 'down:ShiftLeft'], [0.2, 'down:KeyW'], [1.0, 'melee'], [1.4, 'up:KeyW'], [1.4, 'up:ShiftLeft']] },
  espalda: { rival: [3.0, 'espalda'], dura: 2.2, pasos: [[0.5, 'melee']] },
  fallo: { rival: null, dura: 1.8, pasos: [[0.4, 'melee']] },
};
const wanted = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(SCENES);

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root, env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 750));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const name of wanted) {
    const sc = SCENES[name];
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/?nolock=1&gfx=off`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.getElementById('btn-enter')?.click());
    await page.waitForSelector('#splash.off', { state: 'attached' });
    await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; document.getElementById('btn-practice').click(); });
    await page.waitForFunction(() => !!window.BREACH.player, null, { timeout: 30000 });
    await page.waitForTimeout(3500);
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1000);
    await page.evaluate(([sc, X0, Z]) => {
      const G = window.BREACH, I = window.BREACH_INPUT, D = G.dummies;
      document.getElementById('hud').style.visibility = 'hidden';
      const tag = document.createElement('div');
      tag.style.cssText = 'position:fixed;left:20px;bottom:18px;z-index:99999;font:600 22px Arial;color:#fff;background:rgba(0,0,0,.6);padding:6px 12px;border-radius:6px';
      document.body.appendChild(tag);
      const rival = D.list[0];
      for (const d of D.list) if (d !== rival || !sc.rival) { d.alive = false; d.respawnT = 1e9; d.rig.root.visible = false; }
      if (!sc.rival) tag.textContent = 'Sin rival: golpe al aire';
      // el rival se queda quieto en el carril (conserva el empujón del golpe)
      const update = D.update.bind(D);
      D.update = (dt) => {
        update(dt);
        if (!sc.rival) return;
        if (rival.alive) {
          rival.x = X0 + sc.rival[0] + rival.hitOX; rival.z = Z + rival.hitOZ;
          rival.yaw = sc.rival[1] === 'frente' ? Math.PI / 2 : -Math.PI / 2;
          rival.rig.setTransform(rival.x, rival.z, rival.yaw);
        } else rival.respawnT = 1e9;
        tag.textContent = rival.alive ? `Vida del rival: ${Math.max(0, Math.round(rival.hp))}` : 'Rival eliminado';
      };
      window.__place = () => {
        const q = G.player;
        q.pos.x = X0; q.pos.z = Z; q.y = 0; q.vy = 0; q.vel.x = q.vel.z = 0; q.grounded = true;
        q.cover = null; q.slide = null; q.dive = null; if (q.state !== 'idle') q._setState('idle');
        q.yaw = -Math.PI / 2; q.cam.yaw = q.yaw; q.cam.pitch = -0.04; q.cam._first = true;
        G.spawnProt = 0;
      };
      window.__act = (a) => {
        const [k, v] = a.split(':');
        if (k === 'down') I.keys.add(v); else if (k === 'up') I.keys.delete(v);
        else if (k === 'melee') I.meleePressed = true;
      };
      const follow = G.player.cam, camUpdate = follow.update.bind(follow);
      const span = sc.rival ? sc.rival[0] : 3;
      follow.update = (dt, player) => {
        camUpdate(dt, player);
        const c = follow.camera, x = span > 6 ? Math.max(player.pos.x, X0 + span - 3.4) + 1.4 : X0 + span * 0.5;
        c.position.set(x, 1.1, Z - 3.6);
        c.up.set(0, 1, 0); c.lookAt(x, 0.95, Z);
        if (c.fov !== 48) { c.fov = 48; c.updateProjectionMatrix(); }
      };
    }, [sc, X0, Z]);
    const dir = path.join(OUT, `_${name}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 30; i++) await page.clock.runFor(1000 / 60);
    await page.evaluate(() => window.__place());
    for (let i = 0; i < 40; i++) await page.clock.runFor(1000 / 60);
    const steps = Math.round(sc.dura * 60);
    let next = 0, shot = 0;
    for (let f = 0; f < steps; f++) {
      const t = f / 60;
      while (next < sc.pasos.length && sc.pasos[next][0] <= t + 1e-6) { await page.evaluate((a) => window.__act(a), sc.pasos[next][1]); next++; }
      await page.clock.runFor(1000 / 60);
      await page.screenshot({ path: path.join(dir, `f${String(shot++).padStart(4, '0')}.png`) });
    }
    const end = await page.evaluate(() => { const G = window.BREACH, d = G.dummies.list[0]; return { x: +G.player.pos.x.toFixed(2), hp: d.hp, vivo: d.alive }; });
    await page.close();
    const mp4 = path.join(OUT, `${name}.mp4`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4]);
    if (r.status !== 0) console.log('ffmpeg falló:', String(r.stderr).slice(0, 300));
    else { fs.rmSync(dir, { recursive: true, force: true }); console.log('clip', name, JSON.stringify(end)); }
  }
} finally {
  await browser.close(); server.kill(); await clearClip();
}
