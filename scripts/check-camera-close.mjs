// CÁMARA DE CERCA: el soldado propio no puede tapar la mira.
// Con una pared detrás, en un rincón, en un callejón o bajo un techo bajo la
// cámara de hombro se acerca; antes se replegaba hasta el pecho y el casco
// llenaba la pantalla (run 4). Aquí se mide, con la cámara y el material
// reales, qué fracción de la caja central (20%×20% alrededor de la
// retícula) y de la lente del scope tapa el soldado local. Colliders
// sintéticos en un claro de Fortaleza: geometría exacta y determinista.
// Medida: renders crudos del mismo cuadro, solo luces + soldado sobre blanco:
// con el fundido, sin soldado y con el fundido apagado (uLocal=0). Píxel
// distinto = tapado; la trama cuenta tal cual (cobertura EFECTIVA = silueta
// × fracción que se dibuja). Regla: en campo abierto el fundido no cambia un
// solo píxel; de cerca el centro queda translúcido y de forma UNIFORME (sin
// agujero en pantalla alrededor de la retícula).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from './lib-chrome.mjs';
import { freePort, waitGame, waitHttp } from './lib-test.mjs';
// puertos libres: en esta máquina hay huérfanos en puertos fijos (PRUEBAS)
const FREE_PORT = await freePort();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = FREE_PORT;
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await waitHttp(`http://127.0.0.1:${PORT}/`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  let pageErrors = 0;
  page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
  // un sombreador del soldado que no compila lo "borra" y pasaría la prueba
  page.on('console', (m) => { if (m.type() === 'error' && /shader|program/i.test(m.text())) { pageErrors++; console.log('GLERROR:', m.text().slice(0, 200)); } });
  await page.goto(`http://127.0.0.1:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => { localStorage.setItem('breach.map', 'fortaleza'); window.BREACH.mapChoice = 'fortaleza'; });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.player && window.BREACH?.rig && window.BREACH_WORLD?.layout === 'fortaleza',
    null, { timeout: 60000 });
  await waitGame(page, 1.5);

  // claro sintético: fuera todos los colliders a menos de 12 m del punto
  await page.evaluate(() => {
    const G = window.BREACH, W = window.BREACH_WORLD;
    for (const d of G.dummies?.list ?? []) { d.alive = false; d.respawnT = 1e9; }
    const X = 0, Z = -12, R = 12;
    const near = (c) => c.maxx > X - R && c.minx < X + R && c.maxz > Z - R && c.minz < Z + R;
    for (let i = W.colliders.length - 1; i >= 0; i--) if (near(W.colliders[i])) W.colliders.splice(i, 1);
    for (let i = W.faces.length - 1; i >= 0; i--) if (W.faces[i].collider && near(W.faces[i].collider)) W.faces.splice(i, 1);
    window.__base = W.colliders.length;
    setInterval(() => {
      const Wp = G.weapons; if (!Wp?.st) return;
      if (Wp.st.mag < 3) Wp.st.mag = Wp.def.mag;
      Wp.st.reload = 0; G.spawnProt = 0;
    }, 16);
    const THREE = window.THREE, Rr = window.BREACH_RENDERER, cam = window.BREACH_CAM;
    const w = 320;
    window.__measure = () => {
      const h = Math.round(w / cam.aspect);
      let scene = G.rig.root; while (scene.parent) scene = scene.parent;
      const rt = window.__rt ??= new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType });
      const A = new Float32Array(w * h * 4), B = new Float32Array(w * h * 4), C = new Float32Array(w * h * 4);
      // solo luces + soldado local, fondo blanco: nada del mapa lo tapa
      const off = [];
      for (const o of scene.children) if (o.visible && !o.isLight && o !== G.rig.root) { off.push(o); o.visible = false; }
      const bg = scene.background, fog = scene.fog;
      scene.background = new THREE.Color(1, 1, 1); scene.fog = null;
      scene.updateMatrixWorld(true); cam.updateMatrixWorld(true);
      const prev = Rr.getRenderTarget();
      Rr.setRenderTarget(rt); Rr.render(scene, cam); Rr.readRenderTargetPixels(rt, 0, 0, w, h, A);
      G.rig.root.visible = false;
      Rr.render(scene, cam); Rr.readRenderTargetPixels(rt, 0, 0, w, h, B);
      G.rig.root.visible = true;
      const us = new Set();
      G.rig.root.traverse((o) => { const u = o.material?.userData?.soldierUniforms; if (u?.uLocal) us.add(u); });
      const prevL = [...us].map((u) => u.uLocal.value);
      for (const u of us) u.uLocal.value = 0;
      Rr.render(scene, cam); Rr.readRenderTargetPixels(rt, 0, 0, w, h, C);
      [...us].forEach((u, i) => { u.uLocal.value = prevL[i]; });
      Rr.setRenderTarget(prev);
      for (const o of off) o.visible = true;
      scene.background = bg; scene.fog = fog;
      let c20 = 0, n20 = 0, lens = 0, nl = 0, all = 0, raw = 0, raw20 = 0, changed = 0;
      const lr = 0.43 * Math.min(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const diff = (P, Q) => (Math.max(Math.abs(P[i] - Q[i]), Math.abs(P[i + 1] - Q[i + 1]), Math.abs(P[i + 2] - Q[i + 2])) > 2e-3 ? 1 : 0);
        const on = diff(A, B), onRaw = diff(C, B);
        all += on; raw += onRaw; changed += diff(A, C);
        const dx = x + 0.5 - w / 2, dy = y + 0.5 - h / 2;
        if (Math.abs(dx) <= w * 0.1 && Math.abs(dy) <= h * 0.1) { n20++; c20 += on; raw20 += onRaw; }
        if (Math.hypot(dx, dy) <= lr) { nl++; lens += on; }
      }
      const head = G.rig.head.getWorldPosition(new THREE.Vector3());
      return { all: all / (w * h), c20: c20 / n20, raw: raw / (w * h), raw20: raw20 / n20, changed: changed / (w * h), lens: lens / nl, head: cam.position.distanceTo(head), scope: !!G.scopeActive };
    };
  });

  // jugador en (0,-12) mirando a -z; cajas relativas a él
  const SCEN = [
    { name: 'campo abierto', boxes: [] },
    { name: 'pared detrás', boxes: [{ minx: -4, maxx: 4, minz: -11.55, maxz: -10.9, h: 4 }] },
    { name: 'rincón (pared detrás y a la derecha)', boxes: [
      { minx: -4, maxx: 4, minz: -11.55, maxz: -10.9, h: 4 }, { minx: 0.5, maxx: 1.2, minz: -16, maxz: -10.9, h: 4 }] },
    { name: 'callejón (0.6 m a la derecha, 1 m a la izquierda)', boxes: [
      { minx: 0.6, maxx: 1.3, minz: -20, maxz: -4, h: 4 }, { minx: -1.7, maxx: -1.0, minz: -20, maxz: -4, h: 4 }] },
    // FPS: muro DELANTE pegado (el ojo va 10 cm por delante de los pies) y una esquina delante
    { name: 'muro delante a 0.42 m', boxes: [{ minx: -4, maxx: 4, minz: -13, maxz: -12.42, h: 4 }] },
    { name: 'esquina delante a la derecha', boxes: [{ minx: 0.2, maxx: 4, minz: -13, maxz: -12.45, h: 4 }, { minx: 0.42, maxx: 1.2, minz: -12.45, maxz: -10, h: 4 }] },
    { name: 'techo bajo y pared detrás', boxes: [
      { minx: -4, maxx: 4, minz: -11.55, maxz: -10.9, h: 4 }, { minx: -4, maxx: 4, minz: -14, maxz: -10.9, h: 2.7, minY: 2.35 }] },
  ];
  const cases = [];
  for (const s of SCEN) {
    for (const [mode, w, pitch] of [['hip', 'smg', -0.05], ['ADS', 'smg', -0.05], ['ADS', 'shotgun', 0.4], ['ADS', 'smg', -0.5], ['scope', 'sniper', -0.05]]) {
      const r = await page.evaluate(async ([s, mode, w, pitch]) => {
        const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT, P = G.player;
        // espera en tiempo de juego (PRUEBAS: nunca reloj de pared)
        const sleep = (ms) => new Promise((res) => { const end = G.simClock + ms / 1000; const f = () => (G.simClock >= end ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
        I._mouseAim = false; I._mouseFire = false;
        await sleep(100);
        W.colliders.length = window.__base;
        for (const b of s.boxes) W.colliders.push({ ...b, surface: 'concrete' });
        G.weapons.reset();
        if (w === 'sniper') G.weapons.giveSpecial(w); else G.weapons.cur = w;
        P.cover = null; P.state = 'idle'; P.vel.x = 0; P.vel.z = 0;
        P.pos.x = 0; P.pos.z = -12; P.y = 0; P.yaw = 0; P.cam.yaw = 0; P.cam.pitch = pitch;
        await sleep(150);
        if (mode !== 'hip') I._mouseAim = true;
        await sleep(1100);
        P.cam.pitch = pitch; P.cam.clearPitchRecoil();
        await sleep(250);
        // cámara de los ojos: dónde está respecto a cada caja (distancia punto-caja 3D)
        const cam = window.BREACH_CAM.position, fp = window.BREACH_FP;
        let wallDist = Infinity;
        for (const b of W.colliders) {
          const dx = Math.max(b.minx - cam.x, 0, cam.x - b.maxx), dz = Math.max(b.minz - cam.z, 0, cam.z - b.maxz);
          const dy = Math.max((b.minY ?? 0) - cam.y, 0, cam.y - b.h);
          wallDist = Math.min(wallDist, Math.hypot(dx, dy, dz));
        }
        return { ...window.__measure(), live: !!fp?.live, eyeGap: fp?.eye ? fp.eye.distanceTo(cam) : null, wallDist, pos: [P.pos.x, P.pos.z] };
      }, [s, mode, w, pitch]);
      const label = `${s.name} · ${mode} ${w} pitch ${pitch}`;
      cases.push(label);
      // PRUEBAS (corrida 6, FPS): jugando, la cámara es la de los ojos. Se retiraron
      // "cámara de hombro en su órbita", "soldado visible ≥5 %" y "fundido uniforme
      // del soldado propio": esa vista (hombro sobre el soldado vivo) ya no existe
      // jugando (solo muerte/espectador/presentación). Su garantía pasa a la cámara
      // de los ojos en los mismos rincones: nunca dentro ni pegada a la geometría,
      // en el ojo, y el cuerpo propio no tapa nada (oculto; queda su sombra).
      check(`${label}: cámara de los ojos activa en el ojo`, r.live && r.eyeGap != null && r.eyeGap < 1e-3, JSON.stringify({ live: r.live, eyeGap: r.eyeGap }));
      check(`${label}: cámara fuera de la geometría (${(r.wallDist * 100).toFixed(1)} cm ≥ 4.5 cm)`, r.wallDist >= 0.045);
      check(`${label}: el cuerpo propio no tapa la vista (${(r.all * 100).toFixed(2)}% de píxeles)`, r.all === 0);
      // con un muro DELANTE pegado el rifle se retrae y la mira no llega a entrar
      // (observación enviada a VISTA en ganchos/pruebas.md): ahí solo se exige la lente limpia si entra
      const frontWall = s.name.startsWith('muro delante') || s.name.startsWith('esquina delante');
      if (mode === 'scope' && !frontWall) check(`${label}: scope activo y la lente sin soldado (${(r.lens * 100).toFixed(2)}%)`, r.scope && r.lens === 0);
      if (mode === 'scope' && frontWall) { console.log(`NOTA ${label}: scope ${r.scope ? 'activo' : 'NO entra (arma retraída)'}`); if (r.scope) check(`${label}: lente sin soldado`, r.lens === 0); }
    }
  }
  check('sin errores de página', pageErrors === 0, `${pageErrors}`);
} finally {
  await browser.close();
  server.kill();
}
if (fails.length) {
  console.log(`\nCAMERA CLOSE FAIL (${fails.length}): ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nCAMERA CLOSE OK · pared detrás · rincón · callejón · techo bajo · scope · campo abierto intacto');
