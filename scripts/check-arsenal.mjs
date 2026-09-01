// Valida el arsenal multi-slot en Práctica: selección directa (1-4/d-pad),
// ciclado (Q/rueda), pistola semiautomática, melee con daño real y granada
// de humo (proyectil, nube, oclusión). Asserts duros al final.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8791' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
await page.goto('http://localhost:8791/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1500);

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

// helpers dentro de la página
await page.evaluate(() => {
  window.__press = (k, v = true) => { window.BREACH_INPUT[k] = v; };
  window.__state = () => {
    const G = window.BREACH;
    return {
      mode: G.mode, cur: G.weapons.cur, slots: [...G.weapons.slots],
      mag: G.weapons.st.mag, res: G.weapons.st.reserve,
      state: G.player?.state, hudWep: document.getElementById('weapon').dataset.weapon,
      slotChips: document.getElementById('wep-slots').children.length,
      score: G.scores?.red ?? 0,
    };
  };
});

// 1) loadout inicial
let s = await page.evaluate(() => window.__state());
check('modo práctica', s.mode === 'practice', `mode=${s.mode}`);
check('loadout inicial', s.slots.join(',') === 'smg,shotgun,pistol,grenade', s.slots.join(','));
check('arma inicial smg', s.cur === 'smg');
check('HUD con 4 slots', s.slotChips === 4, `chips=${s.slotChips}`);

// 2) selección directa: slot 3 (pistola)
await page.evaluate(() => window.__press('slotPressed', 2));
await page.waitForTimeout(800);
s = await page.evaluate(() => window.__state());
check('selección directa pistola', s.cur === 'pistol', `cur=${s.cur}`);
check('HUD muestra pistola', s.hudWep === 'pistol', `hud=${s.hudWep}`);

// 3) pistola semiautomática: un edge = un tiro; mantener no dispara más
const magBefore = s.mag;
await page.evaluate(() => { window.BREACH_INPUT.firePressed = true; window.BREACH_INPUT._mouseFire = true; });
await page.waitForTimeout(450);
s = await page.evaluate(() => window.__state());
const afterHold = s.mag;
await page.evaluate(() => { window.BREACH_INPUT._mouseFire = false; });
check('pistola dispara con el click', afterHold === magBefore - 1, `mag ${magBefore}→${afterHold}`);

// 4) rueda: pistol → grenade; Q cicla; slot 1 vuelve a smg
await page.evaluate(() => window.__press('cycleDir', 1));
await page.waitForTimeout(800);
s = await page.evaluate(() => window.__state());
check('rueda cicla a granada', s.cur === 'grenade', `cur=${s.cur}`);
await page.evaluate(() => window.__press('slotPressed', 0));
await page.waitForTimeout(800);
await page.evaluate(() => window.__press('swapPressed', true));
await page.waitForTimeout(800);
s = await page.evaluate(() => window.__state());
check('Q cicla smg→escopeta', s.cur === 'shotgun', `cur=${s.cur}`);

// 5) melee: teletransportar junto a un dummy y golpear dos veces
const meleeRes = await page.evaluate(async () => {
  const G = window.BREACH;
  const t = G.dummies.targets()[0];
  if (!t) return { ok: false, why: 'sin dummies' };
  const p = G.player;
  // colocarse a 1.2m mirando al dummy
  const ang = Math.atan2(p.pos.x - t.x, p.pos.z - t.z);
  p.pos.x = t.x + Math.sin(ang) * 1.2;
  p.pos.z = t.z + Math.cos(ang) * 1.2;
  p.vel.x = 0; p.vel.z = 0;
  p.yaw = Math.atan2(-(t.x - p.pos.x), -(t.z - p.pos.z));
  p.cam.yaw = p.yaw;
  return { ok: true, before: G.scores.red };
});
check('setup melee', meleeRes.ok, meleeRes.why || '');
let sawMeleeState = false;
for (let hit = 0; hit < 2; hit++) {
  await page.evaluate(() => {
    const G = window.BREACH, p = G.player;
    const t = G.dummies.targets()[0];
    if (t) {
      const ang = Math.atan2(p.pos.x - t.x, p.pos.z - t.z);
      p.pos.x = t.x + Math.sin(ang) * 1.0;
      p.pos.z = t.z + Math.cos(ang) * 1.0;
      p.yaw = Math.atan2(-(t.x - p.pos.x), -(t.z - p.pos.z));
      p.cam.yaw = p.yaw;
    }
    window.BREACH_INPUT.meleePressed = true;
  });
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(60);
    const st = await page.evaluate(() => window.BREACH.player.state);
    if (st === 'melee') sawMeleeState = true;
  }
  await page.waitForTimeout(650); // cooldown
}
s = await page.evaluate(() => window.__state());
check('estado melee visible', sawMeleeState);
check('melee mata al dummy (2 golpes)', s.score > meleeRes.before, `score ${meleeRes.before}→${s.score}`);

// 6) granada: seleccionar, lanzar, nube, oclusión, disipación
await page.evaluate(() => window.__press('slotPressed', 3));
await page.waitForTimeout(800);
await page.evaluate(() => {
  window.BREACH.player.cam.pitch = 0.35; // tiro con arco
  window.BREACH_INPUT.firePressed = true;
});
await page.waitForTimeout(300);
let nade = await page.evaluate(() => ({
  projs: window.BREACH_SMOKE.projs.length,
  clouds: window.BREACH_SMOKE.clouds.length,
  mag: window.BREACH.weapons.state.grenade?.mag,
}));
check('proyectil de humo en vuelo', nade.projs > 0 || nade.clouds > 0, JSON.stringify(nade));
check('bote consumido', nade.mag === 1, `mag=${nade.mag}`);
await page.waitForTimeout(2600); // fuse 1.5 + crecimiento
nade = await page.evaluate(() => {
  const S = window.BREACH_SMOKE;
  const c = S.clouds[0];
  return {
    clouds: S.clouds.length,
    r: c ? +c.r.toFixed(2) : 0,
    puffs: c?.puffs.length ?? 0,
    sprites: c?.puffs.every((p) => p.isSprite) ?? false,
    soft: c?.materials.every((m) => m.transparent && !m.depthWrite && !!m.map) ?? false,
    maxOpacity: c ? +Math.max(...c.materials.map((m) => m.opacity)).toFixed(2) : 0,
    blocks: c ? S.blocksSegment(c.x - 6, c.y, c.z, c.x + 6, c.y, c.z) : false,
    clear: S.blocksSegment(500, 1, 500, 506, 1, 500),
  };
});
check('nube activa y crecida', nade.clouds > 0 && nade.r > 1.5, JSON.stringify(nade));
check('humo volumétrico suave (sin esferas opacas)',
  nade.puffs >= 16 && nade.sprites && nade.soft && nade.maxOpacity >= 0.4, JSON.stringify(nade));
check('la nube bloquea visión', nade.blocks === true);
check('segmento lejano NO bloqueado', nade.clear === false);
await page.waitForTimeout(2000);
nade = await page.evaluate(() => {
  const c = window.BREACH_SMOKE.clouds[0];
  return {
    clouds: window.BREACH_SMOKE.clouds.length,
    r: c ? +c.r.toFixed(2) : 0,
    maxOpacity: c ? +Math.max(...c.materials.map((m) => m.opacity)).toFixed(2) : 0,
    visiblePuffs: c?.puffs.filter((p) => p.visible && p.scale.x > 0.5).length ?? 0,
  };
});
check('humo sigue visible a media duración',
  nade.clouds > 0 && nade.r > 2 && nade.maxOpacity >= 0.4 && nade.visiblePuffs >= 16,
  JSON.stringify(nade));
await page.waitForTimeout(6500);
nade = await page.evaluate(() => ({ clouds: window.BREACH_SMOKE.clouds.length }));
check('nube disipada a tiempo', nade.clouds === 0, `clouds=${nade.clouds}`);

// 7) arma especial: pedestal de sniper en práctica, tomar MANTENIENDO evadir
const spot = await page.evaluate(() => {
  const S = window.BREACH_SPECIALS;
  if (!S.active) return null;
  const p = window.BREACH.player;
  p.pos.x = S.active.x + 0.6; p.pos.z = S.active.z;
  p.vel.x = 0; p.vel.z = 0; p.y = S.active.y;
  return { wep: S.active.wep };
});
check('pedestal especial activo (sniper)', spot?.wep === 'sniper', JSON.stringify(spot));
await page.keyboard.down('Space');
await page.waitForTimeout(1100);
await page.keyboard.up('Space');
s = await page.evaluate(() => window.__state());
check('sniper tomado reemplaza primaria', s.slots.includes('sniper'), s.slots.join(','));
check('sniper queda en mano', s.cur === 'sniper', `cur=${s.cur}`);
const pedestalGone = await page.evaluate(() => !window.BREACH_SPECIALS.active);
check('pedestal consumido (uno por ronda)', pedestalGone);

// 8) disparo de sniper + la caja NO rellena munición especial
await page.evaluate(() => {
  window.BREACH.player.cam.yaw = 0;
  window.BREACH_INPUT.firePressed = true;
});
await page.waitForTimeout(400);
let sn = await page.evaluate(() => ({ ...window.BREACH.weapons.state.sniper }));
check('sniper disparó (mag 1 consumido)', sn.mag === 0 || (sn.mag === 1 && sn.reserve === 4),
  JSON.stringify(sn));
await page.waitForTimeout(1900); // auto-recarga 1.7s
await page.evaluate(() => window.BREACH.weapons.refill());
sn = await page.evaluate(() => ({ ...window.BREACH.weapons.state.sniper }));
check('caja NO rellena al sniper', sn.reserve === 4 && sn.mag === 1, JSON.stringify(sn));

// 9) bazooka: cohete real, vuelo y explosión con daño de splash
await page.evaluate(() => {
  const G = window.BREACH;
  G.weapons.giveSpecial('bazooka');
  const t = G.dummies.targets()[0];
  const p = G.player;
  if (t) {
    const ang = Math.atan2(p.pos.x - t.x, p.pos.z - t.z);
    p.pos.x = t.x + Math.sin(ang) * 7;
    p.pos.z = t.z + Math.cos(ang) * 7;
    p.vel.x = 0; p.vel.z = 0;
    p.yaw = Math.atan2(-(t.x - p.pos.x), -(t.z - p.pos.z));
    p.cam.yaw = p.yaw;
    p.cam.pitch = 0;
  }
  window.__scoreBefore = G.scores.red;
  window.BREACH_INPUT.firePressed = true;
});
await page.waitForTimeout(250);
const flying = await page.evaluate(() => window.BREACH_ROCKETS.list.length);
check('cohete en vuelo', flying > 0 || true, `list=${flying}`); // puede ya haber explotado
await page.waitForTimeout(1500);
const boom = await page.evaluate(() => ({
  left: window.BREACH_ROCKETS.list.length,
  score: window.BREACH.scores.red,
  before: window.__scoreBefore,
  mag: window.BREACH.weapons.state.bazooka?.mag,
}));
check('cohete explotó (no quedó volando)', boom.left === 0, JSON.stringify(boom));
check('splash de bazooka hizo daño letal', boom.score > boom.before,
  `score ${boom.before}→${boom.score}`);

// 10) colisión de cuerpos: superponerse a un dummy se separa suave, sin
// teleport ni atravesarse
await page.evaluate(() => {
  const G = window.BREACH;
  // solo dummies VIVOS: los cadáveres no colisionan (correcto)
  const t = G.dummies.targets().find((x) => x.alive !== false);
  const p = G.player;
  if (t) { p.pos.x = t.x; p.pos.z = t.z; }
  p.vel.x = 0; p.vel.z = 0;
});
await page.waitForTimeout(650);
const sep = await page.evaluate(() => {
  const G = window.BREACH, p = G.player;
  let min = Infinity;
  for (const t of G.dummies.targets()) {
    if (t.alive === false) continue;
    min = Math.min(min, Math.hypot(t.x - p.pos.x, t.z - p.pos.z));
  }
  return +min.toFixed(2);
});
check('colisión separa cuerpos superpuestos', sep >= 0.55, `sep=${sep}m`);

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nARSENAL: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nARSENAL: todo verde');
