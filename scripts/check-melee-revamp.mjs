// Contrato del melee renovado: contacto temprano, un hit por gesto, recovery
// contextual, recorrido limitado, cover-edge, armas y cancelaciones limpias.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { TUNING } from '../src/config/tuning.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8802;
const chrome = process.env.CHROME_PATH || undefined;
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 850));

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const fails = [];
let pageErrors = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForTimeout(1400);

  await page.evaluate(() => {
    window.__meleeSetup = (distance = 1.12) => {
      const G = window.BREACH;
      const d = G.dummies.list[0];
      const p = G.player;
      d.alive = true; d.hp = 100; d.respawnT = 0; d.hitOX = 0; d.hitOZ = 0;
      p.pos.x = d.x; p.pos.z = d.z - distance; p.y = d.y ?? 0;
      p.vel.x = 0; p.vel.z = 0; p.vy = 0; p.grounded = true;
      p.yaw = Math.PI; p.cam.yaw = Math.PI; p.cam.pitch = 0;
      p.cover = null; p.coverEntry = null; p.slide = null; p.dive = null; p.mantle = null;
      p.state = 'idle'; p.stateT = 0; p.meleeCd = 0;
      return d.id;
    };
  });

  // Acierto: ventana temprana, 60 de daño, un solo contacto y menos recovery.
  const hit = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH, id = window.__meleeSetup();
    const d = G.dummies.list.find((x) => x.id === id);
    const x0 = G.player.pos.x, z0 = G.player.pos.z;
    const t0 = performance.now();
    window.BREACH_INPUT.meleePressed = true;
    let hitMs = null, endMs = null, freezeSeen = false;
    while (performance.now() - t0 < 900) {
      await wait(12);
      if (d.hp < 100 && hitMs === null) hitMs = performance.now() - t0;
      if (G.player.meleeFreezeT > 0) freezeSeen = true;
      if (hitMs !== null && G.player.state !== 'melee') { endMs = performance.now() - t0; break; }
    }
    return {
      hp: d.hp, hitMs, endMs, freezeSeen,
      travel: Math.hypot(G.player.pos.x - x0, G.player.pos.z - z0),
      meleeTravel: G.player.meleeTravel,
      connected: G.player.meleeConnected,
    };
  });
  check('contacto temprano y confiable', hit.hitMs >= 75 && hit.hitMs <= 230, JSON.stringify(hit));
  check('un gesto aplica exactamente un golpe', hit.hp === 40, JSON.stringify(hit));
  check('hit-stop local breve sin congelar el mundo', hit.freezeSeen, JSON.stringify(hit));
  // La posición final también incluye la resolución contra geometría/cuerpos,
  // que depende del punto exacto donde esté el dummy. El contrato del ataque
  // es meleeTravel: esa es la distancia aportada exclusivamente por el lunge.
  check('embestida limitada (no dash)',
    hit.meleeTravel <= TUNING.melee.maxLunge + 0.002, JSON.stringify(hit));

  const miss = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH;
    window.__meleeSetup(5);
    const t0 = performance.now();
    window.BREACH_INPUT.meleePressed = true;
    while (G.player.state !== 'melee' && performance.now() - t0 < 200) await wait(8);
    while (G.player.state === 'melee' && performance.now() - t0 < 1000) await wait(8);
    return { endMs: performance.now() - t0, connected: G.player.meleeConnected };
  });
  check('fallar penaliza más que conectar', !miss.connected && miss.endMs > hit.endMs + 70,
    `hit=${Math.round(hit.endMs)}ms miss=${Math.round(miss.endMs)}ms`);

  // Una sola pulsación no se repite al quedar disponible de nuevo.
  const held = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH, id = window.__meleeSetup();
    const d = G.dummies.list.find((x) => x.id === id);
    window.BREACH_INPUT.meleePressed = true;
    await wait(1100);
    return { hp: d.hp, state: G.player.state };
  });
  check('mantener una pulsación no auto-repite melee', held.hp === 40 && held.state !== 'melee', JSON.stringify(held));

  // Recovery bloquea evade y weapon switch; la recarga sí se corta limpiamente.
  const locks = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH;
    window.__meleeSetup(5);
    const before = G.weapons.cur;
    window.BREACH_INPUT.meleePressed = true;
    await wait(70);
    window.BREACH_INPUT.evadePressed = true;
    window.BREACH_INPUT.slotPressed = 1;
    await wait(120);
    return { state: G.player.state, cur: G.weapons.cur, before, swapping: G.weapons.swapping };
  });
  check('recovery no se cancela con evade/swap', locks.state === 'melee' &&
    locks.cur === locks.before && !locks.swapping, JSON.stringify(locks));

  await page.waitForTimeout(500);
  const reload = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH;
    G.weapons.state[G.weapons.cur].mag = 7;
    G.weapons.startReload();
    const mag = G.weapons.st.mag;
    window.BREACH_INPUT.meleePressed = true;
    await wait(120);
    return { mag, after: G.weapons.st.mag, reloading: G.weapons.reloading,
      state: G.player.state };
  });
  check('melee corta reload sin regalar munición', reload.after === reload.mag &&
    !reload.reloading && reload.state === 'melee', JSON.stringify(reload));

  // Contexto de cover: centro alto permanece locked-in; orilla sale a melee.
  await page.waitForTimeout(500);
  const cover = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH, W = window.BREACH_WORLD, p = G.player;
    const f = W.faces.find((q) => q.h > 1.25 && Math.hypot(q.b.x - q.a.x, q.b.z - q.a.z) > 2.8);
    if (!f) return { why: 'sin cover alto largo' };
    const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z, len = Math.hypot(tx, tz);
    const ux = tx / len, uz = tz / len;
    const place = (u) => {
      p.pos.x = f.a.x + ux * u + f.n.x * 0.38;
      p.pos.z = f.a.z + uz * u + f.n.z * 0.38;
      p.y = 0; p.vel.x = 0; p.vel.z = 0; p.grounded = true;
      p.cover = f; p.coverEntry = null; p.state = 'cover'; p.stateT = 0;
      p.meleeCd = 0; p.cam.yaw = p.yaw;
    };
    place(len / 2);
    window.BREACH_INPUT.meleePressed = true;
    await wait(90);
    const center = p.state;
    place(0.42);
    window.BREACH_INPUT.meleePressed = true;
    await wait(90);
    return { center, edge: p.state, detached: !p.cover };
  });
  check('cover alto central no atraviesa la pared', cover.center === 'cover', JSON.stringify(cover));
  check('orilla de cover activa melee contextual', cover.edge === 'melee' && cover.detached,
    JSON.stringify(cover));

  // Todas las familias de arma producen una pose finita y conservan su modelo.
  const weapons = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const G = window.BREACH, ids = ['smg', 'shotgun', 'pistol', 'sniper', 'bazooka'];
    const out = [];
    for (const wep of ids) {
      if (!G.weapons.state[wep]) G.weapons.state[wep] = { mag: 1, reserve: 0, cd: 0, reload: 0 };
      G.weapons.cur = wep; G.rig.setWeapon(wep);
      window.__meleeSetup(5);
      window.BREACH_INPUT.meleePressed = true;
      await wait(170);
      G.rig.root.updateWorldMatrix(true, true);
      const vals = [G.rig.torso.rotation.x, G.rig.torso.rotation.y,
        G.rig.gunMount.position.x, G.rig.gunMount.position.y, G.rig.gunMount.position.z];
      out.push({ wep, finite: vals.every(Number.isFinite), active: G.rig._wep === wep });
      await wait(430);
    }
    return out;
  });
  check('poses válidas con todas las armas', weapons.every((w) => w.finite && w.active),
    JSON.stringify(weapons));

  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  clearClip();
  await browser.close();
  server.kill();
}

if (fails.length) {
  console.error(`\nMELEE REVAMP: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nMELEE REVAMP: todo verde');
