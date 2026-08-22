// Integración visual/funcional del arsenal y selector de cuatro direcciones.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const PORT = '8821';
const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT }, stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 900));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

let browser;
let pageErrors = 0;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => {
    pageErrors++;
    console.log('PAGEERROR:', error.message);
  });
  await page.goto(`http://localhost:${PORT}/?nolock=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.BREACH.mapChoice = 'fortaleza'; });
  await page.evaluate(() => document.getElementById('btn-practice').click());
  await page.waitForFunction(() => !!window.BREACH?.weapons && !!window.BREACH?.rig,
    null, { timeout: 10000 });
  await page.waitForTimeout(1200);

  const initial = await page.evaluate(() => ({
    current: document.querySelector('#weapon-icon-current svg')?.dataset.icon,
    sectors: [...document.querySelectorAll('#weapon-wheel .wheel-sector')].map((el) => ({
      slot: +el.dataset.slot,
      weapon: el.dataset.weapon,
      icon: el.querySelector('svg')?.dataset.icon,
    })),
  }));
  check('HUD usa la ilustración del arma real', initial.current === 'smg', JSON.stringify(initial));
  check('wheel contiene exactamente cuatro slots reales', initial.sectors.length === 4 &&
    initial.sectors.every((s) => s.weapon === s.icon), JSON.stringify(initial.sectors));
  const bySlot = Object.fromEntries(initial.sectors.map((s) => [s.slot, s.weapon]));
  check('direcciones: arriba granada / abajo pistola / izquierda slot 2 / derecha slot 1',
    bySlot[3] === 'grenade' && bySlot[2] === 'pistol' &&
    bySlot[1] === 'shotgun' && bySlot[0] === 'smg', JSON.stringify(bySlot));

  await page.evaluate(() => { window.BREACH_INPUT.slotPressed = 1; });
  await page.waitForTimeout(80);
  const shown = await page.evaluate(() => {
    const wheel = document.getElementById('weapon-wheel');
    const selected = wheel.querySelector('.wheel-sector.selected');
    const rect = wheel.getBoundingClientRect();
    return {
      on: wheel.classList.contains('on'), count: document.querySelectorAll('#weapon-wheel').length,
      weapon: selected?.dataset.weapon, slot: +(selected?.dataset.slot ?? -1),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      viewport: { w: innerWidth, h: innerHeight },
    };
  });
  check('cambio muestra un único wheel y resalta el destino inmediatamente',
    shown.on && shown.count === 1 && shown.weapon === 'shotgun' && shown.slot === 1,
    JSON.stringify(shown));
  check('wheel es compacto, centrado y queda dentro del viewport',
    shown.rect.x >= 0 && shown.rect.y >= 0 &&
    shown.rect.x + shown.rect.w <= shown.viewport.w && shown.rect.y + shown.rect.h <= shown.viewport.h &&
    shown.rect.w < shown.viewport.w * 0.35, JSON.stringify(shown.rect));
  await page.waitForTimeout(760);
  const faded = await page.evaluate(() => {
    const w = document.getElementById('weapon-wheel');
    return !w.classList.contains('on') && !w.classList.contains('leaving');
  });
  check('wheel desaparece después de 0.5 s con salida limpia', faded);

  // Tres correcciones de intención dentro de la misma animación: no deben
  // crear overlays ni quedarse con un highlight anterior.
  await page.evaluate(() => { window.BREACH_INPUT.slotPressed = 2; });
  await page.waitForTimeout(55);
  await page.evaluate(() => { window.BREACH_INPUT.slotPressed = 3; });
  await page.waitForTimeout(55);
  await page.evaluate(() => { window.BREACH_INPUT.slotPressed = 0; });
  await page.waitForTimeout(80);
  const rapid = await page.evaluate(() => ({
    wheels: document.querySelectorAll('#weapon-wheel').length,
    selected: document.querySelector('#weapon-wheel .wheel-sector.selected')?.dataset.weapon,
    intent: window.BREACH.weapons.selectionTarget,
  }));
  check('cambio rápido conserva un wheel y la última intención',
    rapid.wheels === 1 && rapid.selected === 'smg' && rapid.intent === 'smg', JSON.stringify(rapid));
  await page.waitForTimeout(850);

  const pickup = await page.evaluate(async () => {
    const G = window.BREACH;
    const replaced = G.weapons.giveSpecial('sniper');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const idx = G.weapons.slots.indexOf('sniper');
    const sector = document.querySelector(`#weapon-wheel .wheel-sector[data-slot="${idx}"]`);
    return {
      replaced, idx, cur: G.weapons.cur, on: document.getElementById('weapon-wheel').classList.contains('on'),
      sectorWeapon: sector?.dataset.weapon, icon: sector?.querySelector('svg')?.dataset.icon,
      selected: sector?.classList.contains('selected'),
    };
  });
  check('pickup especial reemplaza visualmente el slot real', pickup.cur === 'sniper' &&
    pickup.sectorWeapon === 'sniper' && pickup.icon === 'sniper' && pickup.selected && pickup.on,
  JSON.stringify(pickup));

  const reset = await page.evaluate(async () => {
    window.BREACH.weapons.reset();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      slots: window.BREACH.weapons.slots.join(','),
      sectors: [...document.querySelectorAll('#weapon-wheel .wheel-sector')]
        .map((el) => [Number(el.dataset.slot), el.dataset.weapon]),
      icon: document.querySelector('#weapon-icon-current svg')?.dataset.icon,
    };
  });
  const resetSlots = Object.fromEntries(reset.sectors);
  check('respawn/reset restaura loadout e ilustraciones', reset.slots === 'smg,shotgun,pistol,grenade' &&
    resetSlots[0] === 'smg' && resetSlots[1] === 'shotgun' && reset.icon === 'smg', JSON.stringify(reset));

  // Construir cada modelo y verificar anchors/identidad geométrica. Las armas
  // largas deben superar claramente a pistola/granada sin escalas absurdas.
  const models = await page.evaluate(() => {
    const G = window.BREACH;
    const result = {};
    for (const weapon of ['smg', 'shotgun', 'pistol', 'grenade', 'sniper', 'bazooka']) {
      G.rig.setWeapon(weapon);
      const gun = G.rig.activeGun;
      let meshes = 0;
      gun.traverse((o) => { if (o.isMesh) meshes++; });
      const a = gun.userData;
      const finite = ['muzzle', 'grip'].every((key) => a[key] &&
        [a[key].position.x, a[key].position.y, a[key].position.z].every(Number.isFinite));
      result[weapon] = { meshes, finite, muzzleZ: a.muzzle?.position.z, oneHand: !!a.oneHand };
    }
    return result;
  });
  check('los seis modelos refinados construyen sin anchors inválidos',
    Object.values(models).every((m) => m.meshes >= 4 && m.finite), JSON.stringify(models));
  check('siluetas mantienen categorías y escala relativa',
    models.sniper.muzzleZ < models.shotgun.muzzleZ &&
    models.shotgun.muzzleZ < models.pistol.muzzleZ && models.pistol.oneHand && models.grenade.oneHand,
  JSON.stringify(models));

  await page.setViewportSize({ width: 800, height: 600 });
  await page.evaluate(() => { window.BREACH_INPUT.slotPressed = 1; });
  await page.waitForTimeout(80);
  const small = await page.evaluate(() => {
    const r = document.getElementById('weapon-wheel').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  check('wheel responde en 800×600 sin clipping', small.x >= 0 && small.y >= 0 &&
    small.x + small.w <= small.vw && small.y + small.h <= small.vh, JSON.stringify(small));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  if (browser) await browser.close();
  server.kill();
  await clearClip();
}

if (failures.length) {
  console.log(`\nWEAPON-WHEEL: ${failures.length} fallos → ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\nWEAPON-WHEEL: modelos, iconos, slots y transiciones estables');
