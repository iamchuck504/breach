// Multijugador con DOS clientes reales: el arma en mano se replica (pistola
// y granada en el rig remoto), la granada de humo aparece en ambos clientes,
// y el melee mata a través de la validación del server (fire+hit reales).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT: '8798', INTRO_TIME: '2', COUNTDOWN_TIME: '1',
    NODE_ENV: 'test', ALLOW_TEST_TELEPORTS: '1' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};
let pageErrors = 0;

const mkClient = async (name) => {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => { pageErrors++; console.log(`PAGEERROR ${name}:`, e.message); });
  await pg.goto('http://localhost:8798/?nolock=1', { waitUntil: 'networkidle' });
  await pg.evaluate(() => document.getElementById('btn-enter')?.click());
  await pg.waitForSelector('#splash.off', { state: 'attached' });
  await pg.evaluate((n) => {
    document.getElementById('in-name').value = n;
    document.getElementById('in-server').value = 'ws://localhost:8798';
  }, name);
  return pg;
};

const p1 = await mkClient('ALFA');
const p2 = await mkClient('BRAVO');
await p1.evaluate(() => document.getElementById('btn-lobby-create').click());
await p1.waitForTimeout(900);
await p2.evaluate(() => document.getElementById('btn-lobby-join').click());
await p1.waitForFunction(() => {
  const b = document.getElementById('btn-lobby-start');
  return b && !b.disabled;
}, null, { timeout: 15000 });
await p1.evaluate(() => document.getElementById('btn-lobby-start').click());
for (const pg of [p1, p2]) {
  await pg.waitForFunction(
    () => window.BREACH.mode === 'online' && window.BREACH.remotes.size > 0,
    null, { timeout: 30000 },
  );
}
// dejar expirar la protección de spawn del server (5s desde el arranque real)
await p1.waitForTimeout(6000);

// --- arma en mano replicada: pistola y granada visibles en el rig remoto
await p1.evaluate(() => { window.BREACH_INPUT.slotPressed = 2; });
await p1.waitForTimeout(1300);
let seen = await p2.evaluate(() => {
  const r = [...window.BREACH.remotes.values()][0];
  return r?.rig?._wep ?? null;
});
check('P2 ve la PISTOLA en la mano de P1', seen === 'pistol', `wep=${seen}`);
await p1.evaluate(() => { window.BREACH_INPUT.slotPressed = 3; });
await p1.waitForTimeout(1300);
seen = await p2.evaluate(() => [...window.BREACH.remotes.values()][0]?.rig?._wep ?? null);
check('P2 ve la GRANADA en la mano de P1', seen === 'grenade', `wep=${seen}`);

// --- granada replicada: P1 lanza, la nube existe en ambos clientes
await p1.evaluate(() => {
  window.BREACH.player.cam.pitch = 0.4;
  window.BREACH_INPUT.firePressed = true;
});
await p1.waitForTimeout(2600);
const nadeBoth = {
  p1: await p1.evaluate(() => window.BREACH_SMOKE.clouds.length + window.BREACH_SMOKE.projs.length),
  p2: await p2.evaluate(() => window.BREACH_SMOKE.clouds.length + window.BREACH_SMOKE.projs.length),
};
check('la nube de humo existe en AMBOS clientes', nadeBoth.p1 > 0 && nadeBoth.p2 > 0,
  JSON.stringify(nadeBoth));

// --- melee online validado por el server: dos golpes matan
await p1.evaluate(() => { window.BREACH_INPUT.slotPressed = 0; });
await p2.evaluate(() => {
  const p = window.BREACH.player;
  p.pos.x = 0; p.pos.z = 5; p.vel.x = 0; p.vel.z = 0;
});
await p1.evaluate(() => {
  const p = window.BREACH.player;
  p.pos.x = 0; p.pos.z = 6.1; p.vel.x = 0; p.vel.z = 0;
  p.cam.yaw = Math.PI; p.yaw = Math.PI; // mirando a -z … hacia P2 en z menor
});
await p1.waitForTimeout(600); // sync de posiciones (20 Hz)
const hpBefore = await p2.evaluate(() => window.BREACH.selfHp);
for (let i = 0; i < 3; i++) {
  await p1.evaluate(() => {
    const p = window.BREACH.player;
    const r = [...window.BREACH.remotes.values()][0];
    if (r) {
      p.yaw = Math.atan2(-(r.x - p.pos.x), -(r.z - p.pos.z));
      p.cam.yaw = p.yaw;
    }
    window.BREACH_INPUT.meleePressed = true;
  });
  await p1.waitForTimeout(850);
}
const meleeOut = {
  hpBefore,
  p2dead: await p2.evaluate(() => !window.BREACH.selfAlive || !!window.BREACH.player?.dead),
  p2hp: await p2.evaluate(() => Math.round(window.BREACH.selfHp)),
};
check('melee online mata con la validación del server',
  meleeOut.p2dead || meleeOut.p2hp < hpBefore, JSON.stringify(meleeOut));

// --- disparo de pistola online: el server lo acepta (sin desconexión)
await p1.evaluate(() => { window.BREACH_INPUT.slotPressed = 2; });
await p1.waitForTimeout(900);
await p1.evaluate(() => {
  window.BREACH.player.cam.pitch = 0;
  window.BREACH_INPUT.firePressed = true;
  window.BREACH_INPUT._mouseFire = true;
});
await p1.waitForTimeout(300);
await p1.evaluate(() => { window.BREACH_INPUT._mouseFire = false; });
await p1.waitForTimeout(400);
const still = {
  p1: await p1.evaluate(() => window.BREACH.mode),
  mag: await p1.evaluate(() => window.BREACH.weapons.state.pistol.mag),
};
check('pistola dispara online sin romper la sesión', still.p1 === 'online' && still.mag < 12,
  JSON.stringify(still));

// --- ARMA ESPECIAL online: el pedestal existe en ambos clientes y SOLO uno
// se la lleva aunque los dos reclamen en el mismo instante
const pedestalBoth = {
  p1: await p1.evaluate(() => window.BREACH_SPECIALS.active?.wep ?? null),
  p2: await p2.evaluate(() => window.BREACH_SPECIALS.active?.wep ?? null),
};
check('el pedestal existe en ambos clientes', pedestalBoth.p1 === 'sniper' && pedestalBoth.p2 === 'sniper',
  JSON.stringify(pedestalBoth));

// ambos se plantan encima y mantienen evadir a la vez
for (const pg of [p1, p2]) {
  await pg.evaluate(() => {
    const S = window.BREACH_SPECIALS, p = window.BREACH.player;
    if (S.active) { p.pos.x = S.active.x; p.pos.z = S.active.z; p.y = S.active.y; }
    p.vel.x = 0; p.vel.z = 0; p.state = 'idle'; p.cover = null;
    window.BREACH_INPUT.keys.add('Space');
  });
}
await p1.waitForTimeout(1800);
for (const pg of [p1, p2]) {
  await pg.evaluate(() => window.BREACH_INPUT.keys.delete('Space'));
}
await p1.waitForTimeout(600);
const claim = {
  p1: await p1.evaluate(() => window.BREACH.weapons.slots.includes('sniper')),
  p2: await p2.evaluate(() => window.BREACH.weapons.slots.includes('sniper')),
  goneP1: await p1.evaluate(() => !window.BREACH_SPECIALS.active),
  goneP2: await p2.evaluate(() => !window.BREACH_SPECIALS.active),
};
check('exactamente UN jugador se lleva la especial',
  (claim.p1 ? 1 : 0) + (claim.p2 ? 1 : 0) === 1, JSON.stringify(claim));
check('el pedestal desaparece en AMBOS clientes', claim.goneP1 && claim.goneP2,
  JSON.stringify(claim));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nMP-ARSENAL: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nMP-ARSENAL: todo verde');
