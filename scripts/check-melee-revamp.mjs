// Contrato del melee renovado: contacto temprano, un hit por gesto, recovery
// contextual, recorrido limitado, golpe contra pared sin atravesarla, armas y
// cancelaciones limpias.
// PRUEBAS (corrida 6): todo se mide en TIEMPO DE JUEGO (G.simClock), con el
// instante EXACTO del paso de simulación en que cambia cada cosa (trazas por
// accesor), nunca con reloj de pared: el runner de CI va ~13× más lento y el
// sondeo de 8-12 ms sobre cuadros irregulares hacía fallar la suite allí.
// La comprobación vieja de "cobertura alta central / orilla" (pegarse a la
// cobertura ya no existe) se traslada a su garantía: golpear de frente a una
// pared alta no mete el cuerpo en ella.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';
import { freePort, waitHttp, waitFrames } from './lib-test.mjs';
import { TUNING } from '../src/config/tuning.js';
import { PLAYER_R } from '../src/player/controller.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = await freePort();
import { CHROME as chrome } from './lib-chrome.mjs';
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: String(port) }, stdio: 'ignore',
});

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const fails = [];
let pageErrors = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
const STEP = 1 / 30; // paso máximo de simulación de main.js
const ML = TUNING.melee;

try {
  await waitHttp(`http://127.0.0.1:${port}/`);
  await page.goto(`http://127.0.0.1:${port}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => window.BREACH?.player && window.BREACH.dummies?.list?.length > 0 &&
    (window.BREACH.simClock ?? 0) > 0.5, null, { timeout: 600000, polling: 'raf' });
  await waitFrames(page, 10);

  await page.evaluate(() => {
    const G = window.BREACH;
    // espera en tiempo de juego
    window.__gwait = (s) => new Promise((res) => {
      const end = G.simClock + s;
      const f = () => (G.simClock >= end ? res() : requestAnimationFrame(f));
      requestAnimationFrame(f);
    });
    // registra [simClock, valor] en cada asignación de obj[key] (simClock ya
    // vale el final del paso en curso: main.js lo suma al empezar simStep)
    window.__trace = (obj, key) => {
      let v = obj[key];
      const log = [];
      Object.defineProperty(obj, key, {
        configurable: true, enumerable: true, get: () => v,
        set: (nv) => { if (nv !== v) log.push([G.simClock, nv]); v = nv; },
      });
      return { log, stop: () => { delete obj[key]; obj[key] = v; } };
    };
    window.__meleeSetup = (distance = 1.12) => {
      const d = G.dummies.list[0];
      const p = G.player;
      d.alive = true; d.hp = 100; d.respawnT = 0; d.hitOX = 0; d.hitOZ = 0;
      p.pos.x = d.x; p.pos.z = d.z - distance; p.y = d.y ?? 0;
      p.vel.x = 0; p.vel.z = 0; p.vy = 0; p.grounded = true;
      p.yaw = Math.PI; p.cam.yaw = Math.PI; p.cam.pitch = 0;
      if (distance < 2) {
        // El muñeco patrulla mirando hacia donde camina y por la espalda la
        // patada es letal: el golpe medido se da de frente, a mitad de tramo
        // para que no se dé la vuelta durante la medición.
        const a = d.path[d.seg], b = d.path[1 - d.seg];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
        d.u = 0.3; d.x = a.x + dx * d.u; d.z = a.z + dz * d.u;
        p.pos.x = d.x + dx / len * distance; p.pos.z = d.z + dz / len * distance;
        p.yaw = p.cam.yaw = Math.atan2(dx, dz);
      }
      p.slide = null; p.mantle = null;
      p.state = 'idle'; p.stateT = 0; p.meleeCd = 0;
      return d.id;
    };
    // un gesto completo, con los instantes exactos de juego
    window.__gesture = async (distance, { maxS = 1.5 } = {}) => {
      const id = window.__meleeSetup(distance);
      const d = G.dummies.list.find((x) => x.id === id);
      const p = G.player;
      const st = window.__trace(p, 'state'), hp = window.__trace(d, 'hp');
      const x0 = p.pos.x, z0 = p.pos.z;
      let freezeSeen = false;
      window.BREACH_INPUT.meleePressed = true;
      const end = G.simClock + maxS;
      while (G.simClock < end) {
        await new Promise((r) => requestAnimationFrame(r));
        if (p.meleeFreezeT > 0) freezeSeen = true;
        const started = st.log.find(([, v]) => v === 'melee');
        if (started && st.log.some(([t, v]) => v !== 'melee' && t > started[0])) break;
      }
      st.stop(); hp.stop();
      const start = st.log.find(([, v]) => v === 'melee')?.[0] ?? null;
      const stop = start == null ? null : st.log.find(([t, v]) => v !== 'melee' && t > start)?.[0] ?? null;
      const hit = hp.log.find(([, v]) => v < 100)?.[0] ?? null;
      return {
        hp: d.hp, start, hitAfter: hit != null && start != null ? hit - start : null,
        dur: stop != null ? stop - start : null, freezeSeen,
        travel: Math.hypot(p.pos.x - x0, p.pos.z - z0), meleeTravel: p.meleeTravel,
        connected: p.meleeConnected,
      };
    };
  });

  // Acierto: ventana temprana, 60 de daño, un solo contacto y menos recovery.
  const hit = await page.evaluate(() => window.__gesture());
  // contacto en TUNING.melee.hitAt de juego desde que empieza el gesto (±1–2 pasos)
  check('contacto temprano y confiable', hit.hitAfter != null &&
    hit.hitAfter >= ML.hitAt - STEP - 1e-6 && hit.hitAfter <= ML.hitAt + 2 * STEP + 1e-6, JSON.stringify(hit));
  check('un gesto aplica exactamente un golpe', hit.hp === 100 - ML.dmg, JSON.stringify(hit));
  check('hit-stop local breve sin congelar el mundo', hit.freezeSeen, JSON.stringify(hit));
  // La posición final también incluye la resolución contra geometría/cuerpos;
  // el contrato del ataque es meleeTravel (lo que aporta solo la embestida).
  check('embestida limitada (no dash)',
    hit.meleeTravel <= ML.lungeMax + 0.002, JSON.stringify(hit));

  const miss = await page.evaluate(() => window.__gesture(5));
  // nominal: el fallo dura (missRecovery − hitRecovery) más que el acierto;
  // el hit-stop alarga el acierto, así que basta con la mitad de la diferencia
  const minGap = (ML.missRecovery - ML.hitRecovery) / 2;
  check('fallar penaliza más que conectar', !miss.connected && miss.dur != null && hit.dur != null &&
    miss.dur > hit.dur + minGap, `acierto=${hit.dur?.toFixed(3)}s fallo=${miss.dur?.toFixed(3)}s (juego, mín. +${minGap.toFixed(3)})`);

  // Una sola pulsación no se repite al quedar disponible de nuevo.
  const held = await page.evaluate(async () => {
    const G = window.BREACH, id = window.__meleeSetup();
    const d = G.dummies.list.find((x) => x.id === id);
    window.BREACH_INPUT.meleePressed = true;
    await window.__gwait(1.1);
    return { hp: d.hp, state: G.player.state };
  });
  check('mantener una pulsación no auto-repite melee', held.hp === 100 - ML.dmg && held.state !== 'melee', JSON.stringify(held));

  // El recovery no se cancela con cambio de arma ni con agacharse/saltar
  // (antes: evadir, que ya no existe); la recarga sí se corta limpiamente.
  const locks = await page.evaluate(async () => {
    const G = window.BREACH;
    window.__meleeSetup(5);
    const before = G.weapons.cur;
    window.BREACH_INPUT.meleePressed = true;
    await window.__gwait(0.07);
    window.BREACH_INPUT.crouchPressed = true;
    window.BREACH_INPUT.jumpPressed = true;
    window.BREACH_INPUT.slotPressed = 1;
    await window.__gwait(0.12);
    return { state: G.player.state, cur: G.weapons.cur, before, swapping: G.weapons.swapping };
  });
  check('recovery no se cancela con agacharse/saltar/cambio de arma', locks.state === 'melee' &&
    locks.cur === locks.before && !locks.swapping, JSON.stringify(locks));

  // la patada fallada anterior tiene que haber terminado antes de la siguiente
  await page.evaluate((s) => window.__gwait(s), ML.hitAt + ML.missRecovery + 0.5);
  const reload = await page.evaluate(async () => {
    const G = window.BREACH;
    G.weapons.state[G.weapons.cur].mag = 7;
    G.weapons.startReload();
    const mag = G.weapons.st.mag;
    window.BREACH_INPUT.meleePressed = true;
    await window.__gwait(0.12);
    return { mag, after: G.weapons.st.mag, reloading: G.weapons.reloading,
      state: G.player.state };
  });
  check('melee corta reload sin regalar munición', reload.after === reload.mag &&
    !reload.reloading && reload.state === 'melee', JSON.stringify(reload));

  // Golpe de frente contra una pared alta: el gesto ocurre (en primera persona
  // no hay cobertura que lo bloquee) y el cuerpo NO entra en la pared.
  await page.evaluate((s) => window.__gwait(s), ML.hitAt + ML.missRecovery + 0.3);
  const wall = await page.evaluate(async (R) => {
    const G = window.BREACH, W = window.BREACH_WORLD, p = G.player;
    for (const d of G.dummies.list) { d.alive = false; d.respawnT = 9999; }
    const f = W.faces.find((q) => q.h > 1.95 && Math.hypot(q.b.x - q.a.x, q.b.z - q.a.z) > 2.8);
    if (!f) return { why: 'sin pared alta larga' };
    const tx = f.b.x - f.a.x, tz = f.b.z - f.a.z, len = Math.hypot(tx, tz);
    const ux = tx / len, uz = tz / len;
    const out = [];
    for (const gap of [0.42, 0.6]) {
      p.pos.x = f.a.x + ux * len / 2 + f.n.x * gap;
      p.pos.z = f.a.z + uz * len / 2 + f.n.z * gap;
      p.y = 0; p.vel.x = 0; p.vel.z = 0; p.vy = 0; p.grounded = true;
      p.state = 'idle'; p.stateT = 0; p.meleeCd = 0;
      p.yaw = p.cam.yaw = Math.atan2(f.n.x, f.n.z); p.cam.pitch = 0; // de cara a la pared
      window.BREACH_INPUT.meleePressed = true;
      let sawMelee = false, minDist = Infinity;
      const end = G.simClock + 1.2;
      while (G.simClock < end) {
        await new Promise((r) => requestAnimationFrame(r));
        if (p.state === 'melee') sawMelee = true;
        minDist = Math.min(minDist, (p.pos.x - f.a.x) * f.n.x + (p.pos.z - f.a.z) * f.n.z);
        if (sawMelee && p.state !== 'melee') break;
      }
      out.push({ gap, sawMelee, minDist: +minDist.toFixed(3) });
    }
    for (const d of G.dummies.list) { d.respawnT = 0; }
    return { out, R };
  }, PLAYER_R);
  check('golpe contra pared alta: el gesto ocurre', wall.out?.every((w) => w.sawMelee), JSON.stringify(wall));
  check('golpe contra pared alta: el cuerpo no entra en la pared',
    wall.out?.every((w) => w.minDist >= PLAYER_R - 0.03), JSON.stringify(wall));

  // Todas las familias de arma producen una pose finita y conservan su modelo
  // (el rig de tercera persona sigue simulándose: sombra, cámara de muerte, red).
  const weapons = await page.evaluate(async () => {
    const G = window.BREACH, ids = ['smg', 'shotgun', 'pistol', 'sniper', 'bazooka'];
    const out = [];
    for (const d of G.dummies.list) { d.alive = true; d.respawnT = 0; }
    for (const wep of ids) {
      if (!G.weapons.state[wep]) G.weapons.state[wep] = { mag: 1, reserve: 0, cd: 0, reload: 0 };
      G.weapons.cur = wep; G.rig.setWeapon(wep);
      window.__meleeSetup(5);
      window.BREACH_INPUT.meleePressed = true;
      await window.__gwait(0.17);
      G.rig.root.updateWorldMatrix(true, true);
      const vals = [G.rig.torso.rotation.x, G.rig.torso.rotation.y,
        G.rig.gunMount.position.x, G.rig.gunMount.position.y, G.rig.gunMount.position.z];
      out.push({ wep, finite: vals.every(Number.isFinite), active: G.rig._wep === wep });
      await window.__gwait(0.43);
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
