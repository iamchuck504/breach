// Sanity check AGRESIVO de movilidad + muertes: spamea inputs, cambia
// direcciones, encadena cover/evade, prueba extremos/paredes y mata al
// personaje en plena transición. Instrumenta cada paso de simulación con
// detectores de: teleports, NaN, estados inválidos, velocidad desbocada,
// bloqueo sin control y cadáveres dentro de geometría.
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
  env: { ...process.env, PORT: '8784' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const problems = [];
page.on('pageerror', (e) => problems.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:8784/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  document.getElementById('btn-enter')?.click();
  document.getElementById('btn-practice').click();
});
await page.waitForTimeout(1800);

// instrumentación: registrar CADA paso de sim y detectar anomalías
await page.evaluate(() => {
  const P = window.BREACH.player;
  const orig = P.update.bind(P);
  window.__mon = {
    issues: [], maxSpeed: 0, evades: 0, lastX: P.pos.x, lastZ: P.pos.z,
    ignoreTeleport: 0, lastState: P.state, stuckT: 0,
  };
  const VALID = new Set(['idle', 'run', 'roadie', 'dive', 'slide', 'cover', 'flip', 'mantle', 'dead']);
  P.update = (dt, input, firing) => {
    const m = window.__mon;
    const wasState = P.state;
    orig(dt, input, firing);
    // NaN / estado inválido / combos rotos
    if (!isFinite(P.pos.x) || !isFinite(P.pos.z) || !isFinite(P.y)) m.issues.push('NaN en posición');
    if (!VALID.has(P.state)) m.issues.push('estado desconocido: ' + P.state);
    if (P.state === 'cover' && !P.cover) m.issues.push('cover sin face');
    if (P.state === 'mantle' && !P.mantle) m.issues.push('mantle sin datos');
    if (P.state === 'slide' && !P.slide) m.issues.push('slide sin datos');
    if (P.y < -0.05) m.issues.push('bajo el suelo: y=' + P.y.toFixed(2));
    // teleports (fuera de los del propio test y del SNAP de entrada a cover,
    // que por diseño jala hasta snapRange)
    const enteredCover = P.state === 'cover' && wasState !== 'cover';
    const moved = Math.hypot(P.pos.x - m.lastX, P.pos.z - m.lastZ);
    if (m.ignoreTeleport > 0) m.ignoreTeleport--;
    else if (!enteredCover && moved > 16 * dt + 0.6) m.issues.push('teleport: ' + moved.toFixed(2) + 'm en un paso');
    m.lastX = P.pos.x; m.lastZ = P.pos.z;
    // velocidad desbocada (tope teórico slide con cadena+momentum ≈ 13.8)
    if (P.speed > m.maxSpeed) m.maxSpeed = P.speed;
    if (P.speed > 15) m.issues.push('velocidad desbocada: ' + P.speed.toFixed(1));
    // conteo de evasiones iniciadas
    if ((P.state === 'dive' || P.state === 'slide') && wasState !== 'dive' && wasState !== 'slide') m.evades++;
  };
  window.__tp = (x, z, yaw = Math.PI) => {
    const p = window.BREACH.player;
    p.pos.x = x; p.pos.z = z; p.y = 0; p.vel.x = 0; p.vel.z = 0;
    p.cam.yaw = yaw; p.yaw = yaw; p.evadeRecovery = 0; p.chain = 0;
    p.cover = null; p.slide = null; p.dive = null; p.mantle = null;
    p.state = 'idle'; p.stateT = 0; // teleport limpio: sin estado arrastrado
    window.__mon.ignoreTeleport = 4;
  };
  window.__issues = () => { const i = window.__mon.issues.splice(0); return i; };
});

const flush = async (tag) => {
  const iss = await page.evaluate(() => window.__issues());
  for (const i of [...new Set(iss)]) problems.push(tag + ': ' + i);
};
const key = async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); };

// ---- FASE 1: spam de evade en campo abierto (20 pulsaciones rápidas) ----
await page.evaluate(() => { window.__tp(0, -10); window.__mon.evades = 0; });
await page.keyboard.down('s');
for (let i = 0; i < 20; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(90); }
await page.keyboard.up('s');
const spam = await page.evaluate(() => window.__mon.evades);
// 20 presses en ~1.9s: con dive 0.36 + recovery 0.35 caben ~3; margen: ≤5
if (spam > 5) problems.push(`SPAM: ${spam} evasiones en 1.9s de spam (esperaba ≤5)`);
await flush('spam');

// ---- FASE 2: mantener presionado (edge-triggered: 1 sola) ----
await page.evaluate(() => { window.__tp(0, -10); window.__mon.evades = 0; });
await page.keyboard.down('s');
await key('Space', 1500);
await page.keyboard.up('s');
const held = await page.evaluate(() => window.__mon.evades);
if (held > 1) problems.push(`HOLD: mantener evade produjo ${held} evasiones`);
await flush('hold');

// ---- FASE 3: direcciones opuestas + evade alternado ----
await page.evaluate(() => { window.__tp(0, -8); window.__mon.evades = 0; });
for (let i = 0; i < 6; i++) {
  const k = i % 2 ? 'a' : 'd';
  await page.keyboard.down(k);
  await page.keyboard.press('Space');
  await page.waitForTimeout(240);
  await page.keyboard.up(k);
}
await flush('opuestas');

// ---- FASE 4: evade→cover→evade encadenado junto a bloques reales ----
await page.evaluate(() => window.__tp(-4.5, -14, Math.PI));
for (let i = 0; i < 8; i++) {
  await page.keyboard.down('w');
  await page.keyboard.press('Space');
  await page.waitForTimeout(320);
  await page.keyboard.up('w');
  await page.keyboard.down('s');
  await page.keyboard.press('Space');
  await page.waitForTimeout(320);
  await page.keyboard.up('s');
}
await flush('cadena');

// ---- FASE 5: contra pared/esquina — sin atascos permanentes ----
await page.evaluate(() => window.__tp(-19.5, -10, Math.PI / 2)); // mirando muralla oeste
await key('w', 1600); // empujar contra la pared
const walled = await page.evaluate(() => ({ st: window.BREACH.player.state, sp: +window.BREACH.player.speed.toFixed(1) }));
if (walled.st !== 'run' && walled.st !== 'idle' && walled.st !== 'cover') {
  problems.push('PARED: estado raro empujando pared: ' + walled.st);
}
await key('s', 500); // recuperar control alejándose
const unwalled = await page.evaluate(() => +window.BREACH.player.speed.toFixed(1));
if (unwalled < 1) problems.push('PARED: no recuperó movimiento al alejarse (speed=' + unwalled + ')');
await flush('pared');

// ---- FASE 6: salidas por el extremo del cover (ambos extremos y ángulos) ----
const coverExitTest = async (tag, keys, expect, holdMs) => {
  await page.evaluate(() => {
    const W = window.BREACH_WORLD;
    const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
    window.__tp((f.a.x + f.b.x) / 2, (f.a.z + f.b.z) / 2 - 1.2, Math.PI);
  });
  await page.waitForTimeout(250);
  let st = '';
  for (let i = 0; i < 3 && st !== 'cover'; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    st = await page.evaluate(() => window.BREACH.player.state);
  }
  if (st !== 'cover') { problems.push(`SALIDA ${tag}: no entró a cover`); return; }
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(holdMs);
  const out = await page.evaluate(() => window.BREACH.player.state);
  for (const k of keys) await page.keyboard.up(k);
  if (!expect.includes(out)) problems.push(`SALIDA ${tag}: esperaba ${expect.join('/')}, quedó en ${out}`);
  console.log(`salida ${tag}: ${out}`);
  await page.waitForTimeout(300);
  await flush('salida-' + tag);
};
await coverExitTest('sprint+lateral-B', ['Shift', 'a'], ['roadie', 'run'], 1200);
await coverExitTest('sprint+lateral-A', ['Shift', 'd'], ['roadie', 'run'], 1200);
await coverExitTest('lateral-al-tope', ['a'], ['run', 'idle'], 1500);      // sin sprint: camina fuera
await coverExitTest('diagonal-fuera', ['s', 'd'], ['run', 'idle', 'dive'], 700); // away>0.3 sale sin sprint
await coverExitTest('lateral-corto-NO-sale', ['d'], ['cover'], 350);       // en el centro: sigue desplazándose

// ---- FASE 7: muertes en plena transición ----
const dieIn = async (tag, prep, expectState = null) => {
  await page.evaluate(() => window.__tp(0, -12));
  await page.waitForTimeout(200);
  const cleanup = (await prep()) || (() => {});
  const res = await page.evaluate(() => {
    const G = window.BREACH, P = G.player, R = G.rig, W = window.BREACH_WORLD;
    const stAtDeath = P.animState(); // (P.state funde idle/run; animState distingue)
    R.setDeathContext({
      impact: { x: -Math.sin(P.cam.yaw), z: -Math.cos(P.cam.yaw) },
      power: 0.8,
      vel: { x: P.vel.x, z: P.vel.z },
      state: P.animState(),
    });
    P.kill();
    window.__mon.ignoreTeleport = 6;
    return { stAtDeath };
  });
  await cleanup();
  if (expectState && res.stAtDeath !== expectState) {
    problems.push(`MUERTE ${tag}: el harness no llegó al estado (${res.stAtDeath} ≠ ${expectState})`);
  }
  await page.waitForTimeout(1400);
  const post = await page.evaluate(() => {
    const R = window.BREACH.rig, W = window.BREACH_WORLD;
    const r = R.rag;
    if (!r) return { err: 'sin ragdoll' };
    const px = r.bx + r.ox, pz = r.bz + r.oz;
    const probe = { x: px, z: pz };
    W.resolveCircle(probe, 0.22, r.by);
    return {
      disp: +Math.hypot(r.ox, r.oz).toFixed(2),
      by: +r.by.toFixed(2), floorY: +r.floorY.toFixed(2),
      inWall: Math.hypot(probe.x - px, probe.z - pz) > 0.12,
      nan: !isFinite(px) || !isFinite(pz) || !isFinite(r.by),
    };
  });
  if (post.err) problems.push(`MUERTE ${tag}: ${post.err}`);
  else {
    if (post.disp > 1.3) problems.push(`MUERTE ${tag}: cadáver voló ${post.disp}m`);
    if (post.by < post.floorY - 0.02) problems.push(`MUERTE ${tag}: cuerpo bajo el suelo (${post.by} < ${post.floorY})`);
    if (post.inWall) problems.push(`MUERTE ${tag}: cadáver dentro de una pared`);
    if (post.nan) problems.push(`MUERTE ${tag}: NaN en el cadáver`);
  }
  // revivir limpio
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.respawn({ x: 0, z: -12, yaw: Math.PI });
    G.selfAlive = true; G.selfHp = 100;
    window.__mon.ignoreTeleport = 6;
  });
  await page.waitForTimeout(300);
  const revived = await page.evaluate(() => ({
    st: window.BREACH.player.state, rag: !!window.BREACH.rig.rag,
    rec: window.BREACH.player.evadeRecovery, mant: !!window.BREACH.player.mantle,
  }));
  if (revived.rag) problems.push(`MUERTE ${tag}: el ragdoll no se limpió al revivir`);
  if (revived.mant) problems.push(`MUERTE ${tag}: mantle pegado tras revivir`);
  await flush('muerte-' + tag);
  console.log(`muerte ${tag}: st=${res.stAtDeath} disp=${post.disp ?? '?'}m`);
};

// posicionarse frente a una cara LOW real (mismo método probado del smoke)
const gotoLowFace = async () => {
  await page.evaluate(() => {
    const W = window.BREACH_WORLD;
    const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
    const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
    window.__tp(mx, mz - 1.2, Math.PI);
  });
  await page.waitForTimeout(250);
  let st = '';
  for (let i = 0; i < 3 && st !== 'cover'; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    st = await page.evaluate(() => window.BREACH.player.state);
  }
  return st;
};

await dieIn('idle', async () => {}, null);
await dieIn('corriendo', async () => {
  await page.keyboard.down('w'); await page.waitForTimeout(500);
  return async () => page.keyboard.up('w');
}, 'run');
await dieIn('roadie', async () => {
  await page.keyboard.down('w'); await page.keyboard.down('Shift');
  await page.waitForTimeout(600);
  return async () => { await page.keyboard.up('Shift'); await page.keyboard.up('w'); };
}, 'roadie');
await dieIn('dive', async () => {
  await page.keyboard.down('s'); await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  return async () => page.keyboard.up('s');
}, 'dive');
await dieIn('cover', async () => { await gotoLowFace(); }, 'cover_low');
await dieIn('mantle', async () => {
  await gotoLowFace();
  await page.keyboard.down('w');
  await page.keyboard.press('Space'); // mantle
  await page.waitForTimeout(160);     // matar a MITAD del vault
  return async () => page.keyboard.up('w');
}, 'mantle');
// muerte pegado a una pared, corriendo hacia ella
await page.evaluate(() => window.__tp(-19.8, -10, Math.PI / 2));
await page.keyboard.down('w');
await page.waitForTimeout(400);
await page.keyboard.up('w');
await dieIn('pared', async () => { await page.evaluate(() => { window.__mon.ignoreTeleport = 4; }); });

const fin = await page.evaluate(() => ({ maxSpeed: +window.__mon.maxSpeed.toFixed(1) }));
console.log('MOV-CHECK:', JSON.stringify({ maxSpeed: fin.maxSpeed, problemas: problems.length }));
await browser.close();
server.kill();
clearClip();
if (problems.length) {
  for (const p of [...new Set(problems)].slice(0, 20)) console.log('  PROBLEMA: ' + p);
  console.log('MOV FALLO');
  process.exit(1);
}
console.log('MOV OK');
