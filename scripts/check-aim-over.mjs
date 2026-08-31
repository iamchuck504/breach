// AIM-OVER (ADS): un borde cercano que tapa el cañón pero no el círculo se
// libra ALZANDO el arma (la bala sigue naciendo del muzzle real, la retícula
// jamás se mueve/recolorea); si ni el tope libra, el gatillo queda inerte y
// el arma se inclina. TUNING.aimOver.enabled=0 restaura el comportamiento
// anterior en vivo (kill switch). Colliders sintéticos: geometría exacta.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8797', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

await page.goto('http://localhost:8797/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(1800);

// escenario: campo abierto de fortaleza + caja de colisión sintética delante
await page.evaluate(() => {
  const G = window.BREACH, W = window.BREACH_WORLD;
  for (const d of G.dummies.list) d.alive = false;
  G.weapons.cur = 'smg';
  G.weapons.st.mag = 50; G.weapons.st.cd = 0;
  G.player.pos.x = 14; G.player.pos.z = 14;
  G.player.yaw = 0; G.player.cam.yaw = 0;
  window.__baseColliders = W.colliders.length;
});

// ---------------------------------------------------------------------------
// 1) BORDE LIBRABLE (el caso de la captura): caja h1.28 a ~1m del cañón
//    (base analítica 1.2: el borde tapa el cañón; la cámara a 1.51 lo libra)
// ---------------------------------------------------------------------------
const librable = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  const E = window.BREACH_EFFECTS;
  W.colliders.push({ minx: 12.5, minz: 11.7, maxx: 15.5, maxz: 12.3, h: 1.28, surface: 'concrete' });
  G.player.cam.pitch = -0.02;
  I._mouseAim = true;
  await new Promise((r) => setTimeout(r, 900));
  const lift = G.aimOver.lift, blocked = G.aimOver.blocked;
  // sin aim-over ¿la línea base del cañón estaba tapada de verdad?
  G.rig.root.updateWorldMatrix(true, true);
  const muzzle = G.rig.muzzleWorld(new window.THREE.Vector3());
  const baseY = muzzle.y - lift;
  let tracerPoint = null;
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) { tracerPoint = p2.clone(); return oldTracer.call(this, o, p2, em); };
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 90));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 120));
  E.tracer = oldTracer;
  const cross = document.getElementById('crosshair');
  const style = getComputedStyle(cross);
  return {
    lift, blocked, baseMuzzleY: baseY, muzzleY: muzzle.y,
    magBefore, magAfter: G.weapons.st.mag,
    shotZ: tracerPoint?.z ?? null,
    crossBlockedClass: cross.classList.contains('blocked'),
    crossCentered: style.left === '50%' || cross.style.left === '50%' || cross.style.left === '',
  };
});
check('el borde cercano activa la alzada del arma',
  librable.lift >= 0.08 && librable.lift <= 0.34 && !librable.blocked,
  `lift=${librable.lift?.toFixed(2)}`);
check('el disparo LIBRA la caja y pega lejos (donde promete el círculo)',
  librable.magAfter < librable.magBefore && librable.shotZ !== null && librable.shotZ < 10,
  `shotZ=${librable.shotZ?.toFixed(1)} (caja en z≈12)`);
check('la retícula ni se movió ni se recoloreó',
  !librable.crossBlockedClass && librable.crossCentered);

// ---------------------------------------------------------------------------
// 1b) GATILLO IMPACIENTE: aim + click EN EL MISMO INSTANTE. El arma aún está
//     subiendo — ninguna bala puede estamparse en la caja: el click espera
//     en el buffer y sale cuando el cañón libra.
// ---------------------------------------------------------------------------
const impaciente = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT, E = window.BREACH_EFFECTS;
  I._mouseAim = false;
  await new Promise((r) => setTimeout(r, 450));
  G.weapons.st.mag = 50; G.weapons.st.cd = 0;
  const hits = [];
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) { hits.push([p2.x, p2.y, p2.z]); return oldTracer.call(this, o, p2, em); };
  // aim y fire en el MISMO frame
  I._mouseAim = true; I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 700));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 150));
  E.tracer = oldTracer;
  const onBox = hits.filter(([, y, z]) => z > 11.5 && z < 12.5 && y < 1.4).length;
  const beyond = hits.filter(([, , z]) => z < 10).length;
  return { shots: hits.length, onBox, beyond, mag: G.weapons.st.mag };
});
check('click instantáneo: NINGUNA bala se estampa en la caja',
  impaciente.onBox === 0 && impaciente.shots > 0 && impaciente.beyond === impaciente.shots,
  JSON.stringify(impaciente));

// ---------------------------------------------------------------------------
// 1c) APUNTANDO HACIA ABAJO: el muzzle real gira por debajo de la base — el
//     caso que se escapaba con la base analítica fija (reporte de Chuck).
// ---------------------------------------------------------------------------
const picado = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT, E = window.BREACH_EFFECTS;
  G.player.cam.pitch = -0.08; // la mira cae al suelo lejano tras la caja
  G.weapons.st.mag = 50; G.weapons.st.cd = 0;
  await new Promise((r) => setTimeout(r, 500));
  const lift = G.aimOver.lift;
  const hits = [];
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) { hits.push([p2.x, p2.y, p2.z]); return oldTracer.call(this, o, p2, em); };
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 400));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 150));
  E.tracer = oldTracer;
  const onBox = hits.filter(([, y, z]) => z > 11.5 && z < 12.5 && y < 1.4).length;
  return { lift, shots: hits.length, onBox };
});
check('apuntando hacia abajo la alzada compensa el giro del cañón',
  picado.onBox === 0 && picado.shots > 0 && picado.lift > 0.05,
  JSON.stringify(picado));

// ---------------------------------------------------------------------------
// 1d) BARRIDO DE ARMAS: pistola (cañón corto) y escopeta (8 pellets con
//     dispersión) tampoco estampan nada en la caja.
// ---------------------------------------------------------------------------
for (const wep of ['pistol', 'shotgun']) {
  const sweep = await page.evaluate(async (wep) => {
    const G = window.BREACH, I = window.BREACH_INPUT, E = window.BREACH_EFFECTS;
    G.player.cam.pitch = -0.02;
    G.weapons.cur = wep;
    G.weapons.st.mag = G.weapons.def.mag; G.weapons.st.cd = 0; G.weapons.st.reload = 0;
    await new Promise((r) => setTimeout(r, 550));
    const hits = [];
    const oldTracer = E.tracer;
    E.tracer = function (o, p2, em) { hits.push([p2.x, p2.y, p2.z]); return oldTracer.call(this, o, p2, em); };
    I._mouseFire = true; I.firePressed = true;
    await new Promise((r) => setTimeout(r, 350));
    I._mouseFire = false;
    await new Promise((r) => setTimeout(r, 150));
    E.tracer = oldTracer;
    const onBox = hits.filter(([, y, z]) => z > 11.5 && z < 12.5 && y < 1.4).length;
    return { lift: G.aimOver.lift, shots: hits.length, onBox };
  }, wep);
  // escopeta: el cono de 4.6° puede morder el borde con UN pellet extremo —
  // eso es dispersión legítima (el propio rayo de cámara del pellet roza la
  // caja); el contrato es que el central y ≥7/8 libran
  const ok = wep === 'shotgun'
    ? sweep.onBox <= 1 && sweep.shots >= 8
    : sweep.onBox === 0 && sweep.shots > 0;
  check(`${wep}: el cono libra la caja (central + resto del patrón)`, ok, JSON.stringify(sweep));
}
await page.evaluate(() => { window.BREACH.weapons.cur = 'smg'; window.BREACH.weapons.st.mag = 50; });

// ---------------------------------------------------------------------------
// 2) BLOQUEO TOTAL (salvaguarda): con maxLift 0.34 ≈ paralaje cámara-arma,
//    casi toda vista libre es alcanzable — geometría "cámara libra pero ni el
//    tope libra" es exótica. Se fuerza bajando el tope EN VIVO (mismo knob
//    del F10) para validar el mecanismo: gatillo inerte + arma inclinada.
// ---------------------------------------------------------------------------
const bloqueado = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  const E = window.BREACH_EFFECTS;
  const TUNING = (await import('/src/config/tuning.js')).TUNING;
  TUNING.aimOver.maxLift = 0.05; // ningún escalón libra la caja h1.28
  await new Promise((r) => setTimeout(r, 700));
  const blocked = G.aimOver.blocked, lift = G.aimOver.lift;
  let tracerCalls = 0;
  const oldTracer = E.tracer;
  E.tracer = function (...a) { tracerCalls++; return oldTracer.apply(this, a); };
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 400));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 450));
  E.tracer = oldTracer;
  G.rig.root.updateWorldMatrix(true, true);
  const fwd = G.rig.gunForward(new window.THREE.Vector3()).normalize();
  return {
    blocked, lift, magBefore, magAfter: G.weapons.st.mag, tracerCalls,
    gunDipY: fwd.y, camPitch: G.player.cam.pitch,
  };
});
check('bloqueo irremediable detectado (sin alzada suficiente)',
  bloqueado.blocked === true, `lift=${bloqueado.lift?.toFixed(2)}`);
check('gatillo inerte: ni bala ni munición desperdiciada',
  bloqueado.magAfter === bloqueado.magBefore && bloqueado.tracerCalls === 0,
  `mag=${bloqueado.magAfter}/${bloqueado.magBefore} tracers=${bloqueado.tracerCalls}`);
check('el arma se inclina hacia abajo (aviso físico, no de HUD)',
  bloqueado.gunDipY < -0.3,
  `gunForward.y=${bloqueado.gunDipY?.toFixed(2)} con cámara a ${bloqueado.camPitch}`);

// ---------------------------------------------------------------------------
// 3) KILL SWITCH en vivo: enabled=0 restaura el comportamiento anterior
// ---------------------------------------------------------------------------
const apagado = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT, E = window.BREACH_EFFECTS;
  const TUNING = (await import('/src/config/tuning.js')).TUNING;
  TUNING.aimOver.enabled = 0;
  TUNING.aimOver.maxLift = 0.34; // restaurar el tope tocado en la fase 2
  await new Promise((r) => setTimeout(r, 700));
  const blocked = G.aimOver.blocked, lift = G.aimOver.lift;
  let tracerPoint = null;
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) { tracerPoint = p2.clone(); return oldTracer.call(this, o, p2, em); };
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 90));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 120));
  E.tracer = oldTracer;
  TUNING.aimOver.enabled = 1;
  return {
    blocked, lift, fired: G.weapons.st.mag < magBefore,
    shotZ: tracerPoint?.z ?? null,
  };
});
check('kill switch: sin alzada ni bloqueo, el tiro vuelve a pegar en la caja',
  apagado.blocked === false && apagado.lift < 0.03 && apagado.fired &&
  apagado.shotZ !== null && Math.abs(apagado.shotZ - 12.3) < 0.8,
  `lift=${apagado.lift?.toFixed(3)} shotZ=${apagado.shotZ?.toFixed(1)}`);

// ---------------------------------------------------------------------------
// 4) HIPFIRE intacto: sin ADS no hay alzada ni bloqueo, el eje físico manda
// ---------------------------------------------------------------------------
const hip = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  I._mouseAim = false;
  await new Promise((r) => setTimeout(r, 500));
  const lift = G.aimOver.lift, blocked = G.aimOver.blocked;
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 90));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 120));
  // limpiar la caja sintética
  W.colliders.length = window.__baseColliders;
  return { lift, blocked, fired: G.weapons.st.mag < magBefore };
});
check('hipfire intacto: sin alzada, sin bloqueo, dispara normal',
  hip.lift === 0 && hip.blocked === false && hip.fired === true, JSON.stringify(hip));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nAIM-OVER: todo verde');
await browser.close();
server.kill();
await clearClip();
process.exit(fails.length ? 1 : 0);
