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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = '8823';
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', PORT, '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

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
  await page.waitForTimeout(1500);

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
    { name: 'techo bajo y pared detrás', boxes: [
      { minx: -4, maxx: 4, minz: -11.55, maxz: -10.9, h: 4 }, { minx: -4, maxx: 4, minz: -14, maxz: -10.9, h: 2.7, minY: 2.35 }] },
  ];
  const cases = [];
  for (const s of SCEN) {
    for (const [mode, w, pitch] of [['hip', 'smg', -0.05], ['ADS', 'smg', -0.05], ['ADS', 'shotgun', 0.4], ['ADS', 'smg', -0.5], ['scope', 'sniper', -0.05]]) {
      const r = await page.evaluate(async ([s, mode, w, pitch]) => {
        const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT, P = G.player;
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
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
        // sin obstáculos la cámara debe estar EXACTAMENTE donde siempre
        const c = P.cam, cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
        const sh = c._rig.shoulder * c._side, d = c._rig.dist;
        const want = [c.pivot.x + sy * cp * d + cy * sh, c.pivot.y - sp * d + 0.12, c.pivot.z + cy * cp * d - sy * sh];
        const drift = Math.hypot(c.pos.x - want[0], c.pos.y - want[1], c.pos.z - want[2]);
        return { ...window.__measure(), drift, pos: [P.pos.x, P.pos.z] };
      }, [s, mode, w, pitch]);
      const label = `${s.name} · ${mode} ${w} pitch ${pitch}`;
      cases.push(label);
      if (s.boxes.length === 0) {
        check(`${label}: cámara intacta (desvío ${r.drift.toFixed(4)} m)`, r.drift < 1e-3);
        // y el soldado se ve entero fuera del scope (≈9-18% de la pantalla)
        if (mode !== 'scope') {
          check(`${label}: soldado visible (${(r.all * 100).toFixed(0)}% ≥ 5%)`, r.all >= 0.05);
          check(`${label}: idéntico a sin fundido (${(r.changed * 100).toFixed(2)}% de píxeles cambiados)`, r.changed === 0);
        }
      }
      if (mode === 'scope') {
        check(`${label}: scope activo y la lente sin soldado (${(r.lens * 100).toFixed(2)}%)`, r.scope && r.lens === 0);
      } else {
        check(`${label}: centro tapado (efectivo) ${(r.c20 * 100).toFixed(1)}% ≤ 25% (silueta ${(r.raw20 * 100).toFixed(0)}%, pantalla ${(r.all * 100).toFixed(0)}%, casco a ${r.head.toFixed(2)} m)`,
          r.c20 <= 0.25 && r.all <= 0.25);
        // sin agujero en pantalla: el centro se aclara en la misma proporción
        // que el resto del soldado (±0.2), nunca se vacía solo él
        if (r.raw20 > 0.5 && r.raw > 0.05) {
          const kc = r.c20 / r.raw20, ka = r.all / r.raw;
          check(`${label}: fundido uniforme, sin círculo (centro ${kc.toFixed(2)} · resto ${ka.toFixed(2)})`, Math.abs(kc - ka) <= 0.2);
        }
      }
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
