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
// Playwright resuelve automáticamente la revisión compatible instalada.
// CHROME_PATH sigue permitiendo un override explícito en CI.
const launchOptions = process.env.CHROME_PATH
  ? { executablePath: process.env.CHROME_PATH }
  : {};
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8784' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ ...launchOptions, headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const problems = [];
page.on('pageerror', (e) => problems.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:8784/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1800);

// instrumentación: registrar CADA paso de sim y detectar anomalías
await page.evaluate(() => {
  const P = window.BREACH.player;
  const orig = P.update.bind(P);
  window.__mon = {
    issues: [], maxSpeed: 0, evades: 0, diveRestarts: 0,
    lastX: P.pos.x, lastZ: P.pos.z, lastY: P.y, lastGrounded: P.grounded,
    ignoreTeleport: 0,
    lastState: P.state, stuckT: 0,
  };
  const oldDive = P.ev.onDive;
  const oldSlide = P.ev.onSlideStart;
  P.ev.onDive = (...args) => { window.__mon.evades++; oldDive?.(...args); };
  P.ev.onSlideStart = (...args) => { window.__mon.evades++; oldSlide?.(...args); };
  const VALID = new Set(['idle', 'run', 'roadie', 'dive', 'slide', 'cover', 'flip', 'mantle', 'melee', 'dead']);
  P.update = (dt, input, firing) => {
    const m = window.__mon;
    const wasState = P.state;
    const wasCover = P.cover;
    const wasStateT = P.stateT;
    orig(dt, input, firing);
    // NaN / estado inválido / combos rotos
    if (!isFinite(P.pos.x) || !isFinite(P.pos.z) || !isFinite(P.y)) m.issues.push('NaN en posición');
    if (!VALID.has(P.state)) m.issues.push('estado desconocido: ' + P.state);
    if (P.state === 'cover' && !P.cover) m.issues.push('cover sin face');
    if (P.state === 'mantle' && !P.mantle) m.issues.push('mantle sin datos');
    if (P.state === 'slide' && !P.slide) m.issues.push('slide sin datos');
    if (P.y < -0.05) m.issues.push('bajo el suelo: y=' + P.y.toFixed(2));
    // Teleports: entrar a cover ya no es una excepción; también debe respetar
    // una corrección acotada y visible en varios frames.
    const moved = Math.hypot(P.pos.x - m.lastX, P.pos.z - m.lastZ);
    const ignoringTeleport = m.ignoreTeleport > 0;
    if (ignoringTeleport) m.ignoreTeleport--;
    else if (moved > 15 * dt + 0.08) m.issues.push('teleport: ' + moved.toFixed(2) + 'm en un paso');
    const rose = P.y - m.lastY;
    // el mantle sube GUIADO con grounded=true: su tramo empinado llega a
    // +0.27m por paso a dt=1/30 y es legítimo (el detector busca subir
    // desniveles caminando SIN transición, y el mantle es la transición)
    if (!ignoringTeleport && m.lastGrounded && P.grounded && rose > 0.2 &&
        P.state !== 'mantle' && wasState !== 'mantle') {
      m.issues.push('step-up sin transición: +' + rose.toFixed(2) + 'm');
    }
    m.lastX = P.pos.x; m.lastZ = P.pos.z;
    m.lastY = P.y; m.lastGrounded = P.grounded;
    // velocidad desbocada (tope teórico slide con cadena+momentum ≈ 13.8)
    if (P.speed > m.maxSpeed) m.maxSpeed = P.speed;
    if (P.speed > 15) m.issues.push('velocidad desbocada: ' + P.speed.toFixed(1));
    if (wasState === 'dive' && P.state === 'dive' && P.stateT < wasStateT) m.diveRestarts++;
    if (wasState === 'cover' && P.state !== 'cover') {
      const mv = input.moveVec(), f = P.cam.flatForward(), r = P.cam.flatRight();
      const wx = f.x * mv.z + r.x * mv.x, wz = f.z * mv.z + r.z * mv.x;
      m.lastCoverExit = {
        to: P.state, sprint: input.sprintHeld, jump: input.jumpPressed,
        evade: input.evadePressed, mv: { ...mv }, world: { x: wx, z: wz },
        yaw: P.cam.yaw, normal: wasCover ? { ...wasCover.n } : null,
        away: wasCover ? wx * wasCover.n.x + wz * wasCover.n.z : null,
      };
    }
  };
  window.__tp = (x, z, yaw = Math.PI) => {
    const p = window.BREACH.player;
    p.pos.x = x; p.pos.z = z; p.y = 0; p.vel.x = 0; p.vel.z = 0;
    p.cam.yaw = yaw; p.yaw = yaw; p.chain = 0;
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
await page.evaluate(() => { window.__tp(0, -10); window.__mon.evades = 0; window.__mon.diveRestarts = 0; });
await page.keyboard.down('s');
for (let i = 0; i < 20; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(90); }
await page.keyboard.up('s');
const spam = await page.evaluate(() => window.__mon.evades);
const diveRestarts = await page.evaluate(() => window.__mon.diveRestarts);
// Solo cuentan pulsaciones hechas cuando el evade anterior ya terminó.
if (spam > 7) problems.push(`SPAM: ${spam} evasiones en 1.9s (esperaba ≤7)`);
if (diveRestarts > 0) problems.push(`SPAM: dive se reinició ${diveRestarts} veces sin terminar`);
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
    const W = window.BREACH_WORLD, P = window.BREACH.player;
    const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9);
    const x = (f.a.x + f.b.x) / 2 + f.n.x * 0.38;
    const z = (f.a.z + f.b.z) / 2 + f.n.z * 0.38;
    window.__tp(x, z, Math.PI);
    P.cover = f; P.state = 'cover'; P.stateT = 0.5;
    window.__mon.lastCoverExit = null;
  });
  await page.waitForTimeout(120);
  const st = await page.evaluate(() => window.BREACH.player.state);
  if (st !== 'cover') { problems.push(`SALIDA ${tag}: no entró a cover`); return; }
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(holdMs);
  const result = await page.evaluate(() => ({
    state: window.BREACH.player.state,
    exit: window.__mon.lastCoverExit ?? null,
  }));
  const out = result.state;
  for (const k of keys) await page.keyboard.up(k);
  if (!expect.includes(out)) problems.push(`SALIDA ${tag}: esperaba ${expect.join('/')}, quedó en ${out} ${JSON.stringify(result.exit)}`);
  console.log(`salida ${tag}: ${out}`);
  await page.waitForTimeout(300);
  await flush('salida-' + tag);
};
await coverExitTest('sprint+lateral-B', ['Shift', 'a'], ['roadie', 'run'], 1200);
await coverExitTest('sprint+lateral-A', ['Shift', 'd'], ['roadie', 'run'], 1200);
await coverExitTest('lateral-al-tope-LOCK', ['a'], ['cover'], 1500);       // lateral sostenido: queda locked-in
await coverExitTest('diagonal-atras-detach', ['s', 'd'], ['run', 'idle'], 700); // componente atrás claro: detach
await coverExitTest('lateral-corto-NO-sale', ['d'], ['cover'], 150);       // pulso corto en centro: sigue cubierto
await coverExitTest('atras-detach', ['s'], ['run', 'idle'], 700);          // atrás claro: salida explícita

// ---- FASE 7: muertes en plena transición ----
const dieIn = async (tag, prep, expectState = null, keepPosition = false) => {
  if (!keepPosition) await page.evaluate(() => window.__tp(0, -12));
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
    W.resolveCircle(probe, 0.58, r.by);
    return {
      disp: +Math.hypot(r.ox, r.oz).toFixed(2),
      by: +r.by.toFixed(2), floorY: +r.floorY.toFixed(2),
      inWall: Math.hypot(probe.x - px, probe.z - pz) > 0.12,
      nan: !isFinite(px) || !isFinite(pz) || !isFinite(r.by),
      corpseMaterials: R._corpseVisual?.entries.length || 0,
      corpseAmount: +(R._corpseVisual?.amount ?? 0).toFixed(2),
      // la pistola ENFUNDADA se queda con el cuerpo; mano/espalda deben caer
      gunsHidden: Object.values(R.guns).every((g) => g.parent === R.holsterMount || !g.visible),
      hiddenParts: R._deathHidden.length,
    };
  });
  if (post.err) problems.push(`MUERTE ${tag}: ${post.err}`);
  else {
    if (post.disp > 1.3) problems.push(`MUERTE ${tag}: cadáver voló ${post.disp}m`);
    if (post.by < post.floorY - 0.02) problems.push(`MUERTE ${tag}: cuerpo bajo el suelo (${post.by} < ${post.floorY})`);
    if (post.inWall) problems.push(`MUERTE ${tag}: cadáver dentro de una pared`);
    if (post.nan) problems.push(`MUERTE ${tag}: NaN en el cadáver`);
    if (!post.corpseMaterials || post.corpseAmount < 0.95) problems.push(`MUERTE ${tag}: tratamiento apagado incompleto`);
    if (!post.gunsHidden) problems.push(`MUERTE ${tag}: arma todavía integrada a la silueta`);
    if (post.hiddenParts) problems.push(`MUERTE ${tag}: muerte normal ocultó ${post.hiddenParts} piezas`);
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
    mant: !!window.BREACH.player.mantle,
    corpseVisual: !!window.BREACH.rig._corpseVisual,
    hiddenParts: window.BREACH.rig._deathHidden.length,
    gunsVisible: Object.values(window.BREACH.rig.guns).every((g) => g.visible),
  }));
  if (revived.rag) problems.push(`MUERTE ${tag}: el ragdoll no se limpió al revivir`);
  if (revived.mant) problems.push(`MUERTE ${tag}: mantle pegado tras revivir`);
  if (revived.corpseVisual || revived.hiddenParts || !revived.gunsVisible) {
    problems.push(`MUERTE ${tag}: apariencia de cadáver no se restauró al revivir`);
  }
  await flush('muerte-' + tag);
  console.log(`muerte ${tag}: st=${res.stAtDeath} disp=${post.disp ?? '?'}m mute=${post.corpseAmount ?? '?'}`);
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
await dieIn('pared', async () => { await page.evaluate(() => { window.__mon.ignoreTeleport = 4; }); }, null, true);

// Remate extremo de escopeta: daño corporal contextual y reversible.
await page.evaluate(() => {
  const G = window.BREACH, P = G.player;
  window.__tp(0, -12);
  G.rig.setDeathContext({
    impact: { x: 1, z: 0 }, power: 1, vel: { x: 0, z: 0 }, state: 'idle',
    weapon: 'shotgun', distance: 1.2, damage: 104, part: 'body', gib: true,
  });
  P.kill();
  window.__mon.ignoreTeleport = 6;
});
await page.waitForTimeout(1300);
const severe = await page.evaluate(() => ({
  hidden: window.BREACH.rig._deathHidden.length,
  armGone: !window.BREACH.rig.armL.shoulder.visible || !window.BREACH.rig.armR.shoulder.visible,
  lowerLegGone: !window.BREACH.rig.legL.knee.visible || !window.BREACH.rig.legR.knee.visible,
}));
if (severe.hidden !== 2 || !severe.armGone || !severe.lowerLegGone) {
  problems.push('MUERTE escopeta: daño contextual no ocultó brazo + pierna inferior');
}
await page.evaluate(() => {
  const G = window.BREACH;
  G.player.respawn({ x: 0, z: -12, yaw: Math.PI });
  G.selfAlive = true; G.selfHp = 100;
  window.__mon.ignoreTeleport = 6;
});
await page.waitForTimeout(300);
const severeReset = await page.evaluate(() => ({
  hidden: window.BREACH.rig._deathHidden.length,
  allVisible: window.BREACH.rig.armL.shoulder.visible && window.BREACH.rig.armR.shoulder.visible &&
    window.BREACH.rig.legL.knee.visible && window.BREACH.rig.legR.knee.visible,
}));
if (severeReset.hidden || !severeReset.allVisible) problems.push('MUERTE escopeta: piezas no restauradas al respawn');

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
