// Identidad de Bazooka: clasificación letal, impacto directo/ambiental,
// recursos reutilizados, limpieza de VFX y restauración del rig tras respawn.
import * as THREE from 'three';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rocketDeathLevel } from '../src/combat/death-reactions.js';
import { Effects } from '../src/fx/effects.js';
import { Rockets } from '../src/game/special.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';
const PORT = '8817';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

check('impacto directo letal usa destrucción total',
  rocketDeathLevel('bazooka', 0.7, 115, true) === 2);
check('splash letal cercano usa daño severo parcial',
  rocketDeathLevel('bazooka', 1.8, 78, false) === 1);
check('splash lejano conserva muerte normal',
  rocketDeathLevel('bazooka', 3.4, 52, false) === 0);
check('otras armas nunca heredan gore explosivo',
  rocketDeathLevel('shotgun', 0.2, 200, true) === 0);
check('autoridad online puede imponer nivel cero',
  rocketDeathLevel({ weapon: 'bazooka', distance: 0.2, damage: 115,
    direct: true, rocketDeathLevel: 0 }) === 0);

// La simulación reporta el tipo real de detonación sin cambiar el daño.
const fakeScene = new THREE.Scene();
let worldHit = null;
const fakeWorld = { raycastHit: () => worldHit };
const rockets = new Rockets(fakeScene, fakeWorld, null);
let detonation = null;
rockets.fire({ x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: -1 });
const firstResources = rockets.list[0].mesh.children.map((m) => [m.geometry, m.material]);
rockets.update(0.01, [{ id: 'victim', x: 0, y: 0, z: -0.26, alive: true }],
  (pos, mine, owner, info) => { detonation = { pos, mine, owner, info }; });
check('espoleta cercana identifica impacto directo y objetivo',
  detonation?.info?.direct === true && detonation.info.targetId === 'victim',
  JSON.stringify(detonation?.info));

worldHit = { t: 0.1, normal: { x: 1, y: 0, z: 0 }, surface: 'metal' };
rockets.fire({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 });
const secondResources = rockets.list[0].mesh.children.map((m) => [m.geometry, m.material]);
detonation = null;
rockets.update(0.01, [], (pos, mine, owner, info) => { detonation = { pos, info }; });
check('impacto del mundo conserva normal y material',
  detonation?.info?.direct === false && detonation.info.surface === 'metal' &&
    detonation.info.normal.x === 1, JSON.stringify(detonation?.info));
check('cohetes reutilizan geometrías y materiales GPU',
  firstResources.length === secondResources.length && firstResources.every((r, i) =>
    r[0] === secondResources[i][0] && r[1] === secondResources[i][1]));

// En online el mesh se predice, pero ni paredes ni jugadores locales pueden
// detonarlo antes de la confirmación autoritativa.
rockets.clear(); worldHit = { t: 0.05, normal: { x: 0, y: 0, z: 1 }, surface: 'metal' };
let predictedBoom = false;
rockets.fire({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 },
  true, null, 'client:1', true);
rockets.update(0.25, [{ id: 'victim', x: 0, y: 0, z: -0.2, alive: true }],
  () => { predictedBoom = true; });
const bound = rockets.bindId('client:1', 'r77');
const removed = rockets.remove('r77');
check('predicción online espera detonación del servidor',
  !predictedBoom && bound && removed && rockets.list.length === 0);

// La explosión debe crear una lectura más rica, scorch persistente y limpiar
// todos los objetos temporales después de su TTL.
const fxScene = new THREE.Scene();
const fxWorld = {
  groundHeight: () => 0,
  raycastHit: () => null,
};
const effects = new Effects(fxScene, fxWorld);
const origin = new THREE.Vector3(0, 0.4, 0);
const beforeDecals = effects.decals.activeCount;
effects.rocketExplosion(origin, {
  direct: false, normal: { x: 0, y: 1, z: 0 }, surface: 'concrete', floorY: 0,
});
const worldItems = effects.items.length;
check('explosión ambiental crea bola, onda, debris y humo', worldItems >= 6,
  `items=${worldItems}`);
check('impacto ambiental deja scorch persistente',
  effects.decals.activeCount === beforeDecals + 1);
effects.update(3);
check('VFX temporales de explosión se limpian', effects.items.length === 0,
  `items=${effects.items.length}`);
effects.rocketExplosion(origin, { direct: true, surface: 'flesh', floorY: 0 });
check('impacto directo no proyecta decal sobre personaje',
  effects.decals.activeCount === beforeDecals + 1);
check('impacto directo conserva efecto reforzado', effects.items.length >= 6,
  `items=${effects.items.length}`);
effects.update(3);

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, PORT }, stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 900));

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
  await page.waitForFunction(() => !!window.BREACH?.rig, null, { timeout: 10000 });
  await page.waitForTimeout(700);

  const rigCycle = await page.evaluate(() => {
    const R = window.BREACH.rig;
    const alive = { state: 'idle', speed: 0, aim: false, aimPitch: 0 };
    const dead = { state: 'dead', speed: 0, aim: false, aimPitch: 0 };
    const reset = () => R.update(1 / 60, alive);
    const kill = (level) => {
      R.setDeathContext({
        weapon: 'bazooka', rocketDeathLevel: level,
        damage: level === 2 ? 115 : 72, distance: level === 2 ? 0.5 : 1.9,
        impact: { x: 1, z: 0 }, vel: { x: 0, z: 0 }, power: 1,
      });
      R.update(1 / 60, dead);
    };
    reset();
    kill(2);
    const total = !R.torso.visible && !R.legL.hip.visible && !R.legR.hip.visible;
    reset();
    const totalRestored = R.torso.visible && R.legL.hip.visible && R.legR.hip.visible;
    kill(1);
    const partial = R.torso.visible &&
      (!R.armL.shoulder.visible !== !R.armR.shoulder.visible) &&
      (!R.legL.knee.visible !== !R.legR.knee.visible);
    reset();
    const partialRestored = R._deathHidden.length === 0 && R.torso.visible &&
      R.armL.shoulder.visible && R.armR.shoulder.visible &&
      R.legL.knee.visible && R.legR.knee.visible;
    kill(0);
    const normal = R._deathHidden.length === 0 && R.torso.visible && R.head.visible;
    reset();
    return { total, totalRestored, partial, partialRestored, normal };
  });
  check('muerte directa reemplaza la silueta corporal por restos', rigCycle.total,
    JSON.stringify(rigCycle));
  check('splash cercano aplica daño parcial, no destrucción total', rigCycle.partial,
    JSON.stringify(rigCycle));
  check('muerte explosiva normal no oculta partes', rigCycle.normal,
    JSON.stringify(rigCycle));
  check('respawn restaura todas las piezas ocultas',
    rigCycle.totalRestored && rigCycle.partialRestored, JSON.stringify(rigCycle));
  check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);
} finally {
  await browser?.close();
  server.kill();
}

if (failures.length) {
  console.error(`BAZOOKA CHECK FAILED (${failures.length})`);
  process.exit(1);
}
console.log('BAZOOKA OK — explosión, muerte contextual, pooling y restauración');
