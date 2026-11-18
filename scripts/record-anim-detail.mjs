// CLIPS DE DETALLE de la marcha: un movimiento por clip, cámara de PERFIL
// pegada al cuerpo y CÁMARA LENTA (se captura cada paso de 1/60 s y se
// reproduce a un cuarto de velocidad). El clip general (record-anim-clips)
// encadena acciones de un segundo a tamaño pequeño y ahí la diferencia entre
// dos versiones del rig no se aprecia; aquí sí.
//   node scripts/record-anim-detail.mjs <carpeta> [guion ...]
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
const OUT = path.resolve(process.argv[2] || 'artifacts/anim-detail');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 8831);
const SLOW = Number(process.env.SLOW || 4);

// rumbo: con -π/2 la W avanza hacia +x; con 0 la D (derecha) va hacia +x; con
// +π/2 la S (atrás) va hacia +x. Así todos recorren el mismo carril.
// vista: 'perfil' (cámara al costado del carril) o 'juego' (la del jugador).
const SCRIPTS = {
  trote: { rumbo: -Math.PI / 2, dura: 3.0, pasos: [[0.3, 'down:KeyW'], [2.4, 'up:KeyW']] },
  sprint: { rumbo: -Math.PI / 2, dura: 2.2, pasos: [[0.2, 'down:ShiftLeft'], [0.2, 'down:KeyW'], [1.5, 'up:KeyW'], [1.5, 'up:ShiftLeft']] },
  lateral: { rumbo: 0, dura: 3.4, pasos: [[0.1, 'aim:1'], [0.5, 'down:KeyD'], [3.0, 'up:KeyD']] }, // sin apuntar el cuerpo gira hacia donde corre: el paso lateral solo existe apuntando
  retroceso: { rumbo: Math.PI / 2, dura: 3.0, pasos: [[0.3, 'down:KeyS'], [2.4, 'up:KeyS']] },
  apuntando: { rumbo: -Math.PI / 2, dura: 3.2, pasos: [[0.1, 'aim:1'], [0.5, 'down:KeyW'], [2.8, 'up:KeyW']] },
  salto: { rumbo: -Math.PI / 2, dura: 3.0, pasos: [[0.3, 'jump'], [1.4, 'down:KeyW'], [1.9, 'jump'], [2.8, 'up:KeyW']] },
  // media vuelta de la cámara mientras se corre: respuesta de vista y de cuerpo
  giro: { rumbo: -Math.PI / 2, vista: 'juego', dura: 2.6, pasos: [[0.2, 'down:KeyW'], [1.0, 'turn:3.1416'], [2.4, 'up:KeyW']] },
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
    await page.evaluate((MAP) => { window.BREACH.mapChoice = MAP; document.getElementById('btn-practice').click(); }, process.env.MAP || 'fortaleza');
    await page.waitForFunction(() => !!window.BREACH.player, null, { timeout: 30000 });
    await page.waitForTimeout(3500);
    await page.clock.install();
    // install() deja el reloj corriendo: sin pausarlo, el juego sigue avanzando
    // en tiempo real durante cada captura y el clip no es paso a paso
    await page.clock.pauseAt(Date.now() + 1000);
    const lane = await page.evaluate(([sc]) => {
      const G = window.BREACH, I = window.BREACH_INPUT, W = G.player.world;
      for (const d of G.dummies?.list ?? []) { d.alive = false; d.respawnT = 1e9; d.rig.root.visible = false; }
      document.getElementById('hud').style.visibility = 'hidden';
      // CARRIL: 20 m despejados a lo largo de +x, con 5 m libres hacia -z para
      // la cámara. Se busca con la propia colisión del juego.
      const free = (x, z) => { const p = { x, z }; W.resolveCircle(p, 0.7, 0); return Math.hypot(p.x - x, p.z - z) < 1e-4 && Math.abs(W.groundHeight({ x, z }, 0.3, 0)) < 0.25; };
      const LEN = 11.5;
      // eje 0: carril hacia +x con la cámara en -z; eje 1: hacia +z con la cámara en +x
      const AX = [{ d: [1, 0], n: [0, -1], turn: 0 }, { d: [1, 0], n: [0, 1], turn: 0 }, { d: [0, 1], n: [1, 0], turn: -Math.PI / 2 }, { d: [0, 1], n: [-1, 0], turn: -Math.PI / 2 }];
      let best = null;
      for (const ax of AX) for (let a = -24; a <= 24 && !best; a += 0.5) for (let b = -30; b <= 30 - LEN && !best; b += 1) {
        // a = posición transversal, b = inicio a lo largo
        const at = (s, k) => [ax.d[0] * (b + s) + Math.abs(ax.d[1]) * a + ax.n[0] * k, ax.d[1] * (b + s) + Math.abs(ax.d[0]) * a + ax.n[1] * k];
        let ok = true;
        for (let s = 0; s <= LEN && ok; s += 0.5) for (const k of [0, 1, 2, 3]) { const q = at(s, k); if (!free(q[0], q[1])) { ok = false; break; } }
        if (ok) { const q = at(0.5, 0); best = { x: q[0], z: q[1], ax }; }
      }
      if (!best) return { diag: 1 };
      window.__place = () => {
        const q = G.player;
        q.pos.x = best.x; q.pos.z = best.z; q.y = 0; q.vy = 0; q.vel.x = q.vel.z = 0; q.grounded = true;
        q.cover = null; q.slide = null; q.dive = null; if (q.state !== 'idle') q._setState('idle');
        q.yaw = sc.rumbo + best.ax.turn; q.cam.yaw = q.yaw; q.cam.pitch = -0.04; q.cam._first = true;
        G.spawnProt = 0;
      };
      window.__act = (a) => {
        const [k, v] = a.split(':');
        if (k === 'down') I.keys.add(v); else if (k === 'up') I.keys.delete(v);
        else if (k === 'jump') I.jumpPressed = true;
        else if (k === 'aim') I._mouseAim = v === '1';
        else if (k === 'turn') G.player.cam.yaw += Number(v); // giro de ratón instantáneo
      };
      if (sc.vista !== 'juego') {
        const follow = G.player.cam, update = follow.update.bind(follow);
        follow.update = (dt, player) => {
          update(dt, player);
          const c = follow.camera, x = player.pos.x, z = player.pos.z;
          c.position.set(x + best.ax.n[0] * 3.7, 0.95, z + best.ax.n[1] * 3.7);
          c.up.set(0, 1, 0); c.lookAt(x, 0.9, z);
          if (c.fov !== 40) { c.fov = 40; c.updateProjectionMatrix(); }
        };
      }
      return [best.x, best.z, best.ax.turn];
    }, [sc]);
    if (lane.diag) { console.log('sin carril despejado', JSON.stringify(lane.diag)); await page.close(); continue; }
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
      await page.locator('#game').screenshot({ path: path.join(dir, `f${String(shot++).padStart(4, '0')}.png`) });
    }
    const end = await page.evaluate(() => [+window.BREACH.player.pos.x.toFixed(2), +window.BREACH.player.pos.z.toFixed(2)]);
    await page.close();
    const mp4 = path.join(OUT, `${name}.mp4`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(60 / SLOW), '-i', path.join(dir, 'f%04d.png'), '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4]);
    if (r.status !== 0) console.log('ffmpeg falló:', String(r.stderr).slice(0, 300));
    else { fs.rmSync(dir, { recursive: true, force: true }); console.log('clip', name, `carril ${lane} → ${end}`, `(${shot} cuadros)`); }
  }
} finally {
  await browser.close(); server.kill(); await clearClip();
}
