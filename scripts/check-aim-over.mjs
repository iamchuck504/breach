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
import { CHROME } from './lib-chrome.mjs';

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
  const lift = G.aimOver.lift;
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
    lift, baseMuzzleY: baseY, muzzleY: muzzle.y,
    magBefore, magAfter: G.weapons.st.mag,
    shotZ: tracerPoint?.z ?? null,
    crossBlockedClass: cross.classList.contains('blocked'),
    crossCentered: style.left === '50%' || cross.style.left === '50%' || cross.style.left === '',
  };
});
check('el borde cercano activa la alzada del arma',
  librable.lift >= 0.08 && librable.lift <= 0.34,
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
  const t0 = performance.now();
  let firstShotMs = null;
  const prevPush = hits.push.bind(hits);
  hits.push = (v) => { if (firstShotMs === null) firstShotMs = performance.now() - t0; return prevPush(v); };
  I._mouseAim = true; I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 700));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 150));
  E.tracer = oldTracer;
  const onBox = hits.filter(([, y, z]) => z > 11.5 && z < 12.5 && y < 1.4).length;
  const beyond = hits.filter(([, , z]) => z < 10).length;
  return { shots: hits.length, onBox, beyond, mag: G.weapons.st.mag, firstShotMs };
});
check('click instantáneo: NINGUNA bala se estampa en la caja',
  impaciente.onBox === 0 && impaciente.shots > 0 && impaciente.beyond === impaciente.shots,
  JSON.stringify(impaciente));
check('el gatillo responde YA (sin negaciones ni esperas)',
  impaciente.firstShotMs !== null && impaciente.firstShotMs < 250,
  `primer tiro a ${Math.round(impaciente.firstShotMs ?? 9999)}ms`);

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
// 1e) TORTURA (la prueba que importa): 4s de fuego sostenido + spam de clicks
//     con la mira BARRIENDO el borde sin parar, y un dummy vivo detrás del
//     bloque (el guide del tiro incluye personajes). El contrato absoluto:
//     CERO impactos de mundo a quemarropa en ADS.
// ---------------------------------------------------------------------------
const tortura = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT, E = window.BREACH_EFFECTS;
  // dummy vivo asomado tras la caja
  const d = G.dummies.list[0];
  d.alive = true; d.x = 14; d.z = 6; d.respawnT = 9999;
  G.weapons.cur = 'smg';
  G.weapons.st.mag = 50; G.weapons.st.reserve = 999; G.weapons.st.cd = 0;
  let nearSlams = 0, shots = 0, legitClose = 0;
  const W = window.BREACH_WORLD, V3 = window.THREE.Vector3;
  const oldTracer = E.tracer;
  // BUG = PARALAJE puro: la bala pega CERCA mientras el círculo prometía
  // LEJOS *y* la cámara con el MISMO desvío del tiro también libraba. Si la
  // versión de cámara del rayo desviado pega igual, es dispersión visible
  // desde el círculo (cono real del arma): legítimo, no cuenta. Pegar la
  // caja cuando el círculo apunta A la caja tampoco cuenta (veraz).
  E.tracer = function (o, p2, em) {
    shots++;
    const shotDist = p2.distanceTo(o);
    if (shotDist < 3) {
      // misma fuente que fireShot: aimRay (cámara colisionada, SIN shake)
      const ray = G.player.cam.aimRay();
      const cast = (origin, d2) => W.raycastHit(origin, d2, 60)?.t ??
        W.raycast(origin, d2, 60) ?? 60;
      const camCentral = cast(ray.origin, ray.dir);
      const shotDir = p2.clone().sub(o).normalize();
      const camAlongShot = cast(ray.origin, shotDir);
      // pared RASANTE: si la cámara con el mismo desvío pega la misma
      // superficie (aunque más adelante — la distancia al impacto es
      // inestable en rasantes), es dispersión visible, no paralaje engañoso
      if (camCentral > shotDist + 1.8 &&
          camAlongShot > Math.max(shotDist + 1.8, shotDist * 3)) {
        nearSlams++;
        (window.__slams ??= []).push({
          o: [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)],
          p2: [+p2.x.toFixed(2), +p2.y.toFixed(2), +p2.z.toFixed(2)],
          shotDist: +shotDist.toFixed(2),
          camCentral: +camCentral.toFixed(1), camAlongShot: +camAlongShot.toFixed(1),
          lift: +G.aimOver.lift.toFixed(3),
          pitch: +G.player.cam.pitch.toFixed(3), yaw: +G.player.cam.yaw.toFixed(3),
          state: G.player.state, wep: G.weapons.cur,
        });
      } else legitClose++;
    }
    return oldTracer.call(this, o, p2, em);
  };
  I._mouseAim = true; I._mouseFire = true;
  for (let i = 0; i < 40; i++) {
    const t = i * 0.1;
    G.player.cam.pitch = -0.03 + Math.sin(t * 2.4) * 0.09;
    G.player.cam.yaw = Math.sin(t * 1.7) * 0.14;
    I.firePressed = true; // spam de click además del fuego sostenido
    await new Promise((r) => setTimeout(r, 100));
  }
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 250));
  E.tracer = oldTracer;
  d.alive = false;
  G.player.cam.pitch = -0.02; G.player.cam.yaw = 0;
  G.weapons.st.reserve = 150;
  await new Promise((r) => setTimeout(r, 400));
  return { nearSlams, shots, legitClose, slams: window.__slams ?? [] };
});
check('TORTURA: cero balas estampadas (círculo lejos, bala cerca) en 4s de barrido+spam',
  tortura.nearSlams === 0 && tortura.shots > 10,
  JSON.stringify(tortura));

// ---------------------------------------------------------------------------
// 2) SIN ATRAVESAR: un muro alto que también tapa la VISTA — el círculo
//    apunta al muro y la bala pega el muro (la retícula es veraz, jamás
//    concede wall penetration). El gatillo responde igual.
// ---------------------------------------------------------------------------
const muro = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  const E = window.BREACH_EFFECTS;
  W.colliders[W.colliders.length - 1].h = 2.6; // ahora tapa cuerpo Y cámara
  await new Promise((r) => setTimeout(r, 400));
  let tracerPoint = null;
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) { tracerPoint = tracerPoint ?? p2.clone(); return oldTracer.call(this, o, p2, em); };
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 150));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 150));
  E.tracer = oldTracer;
  W.colliders[W.colliders.length - 1].h = 1.28; // restaurar para las fases siguientes
  return {
    magBefore, magAfter: G.weapons.st.mag,
    shotZ: tracerPoint?.z ?? null,
    crossBlocked: document.getElementById('crosshair').classList.contains('blocked'),
  };
});
check('muro que tapa la vista: la bala pega el muro (veraz, sin atravesar)',
  muro.magAfter < muro.magBefore && muro.shotZ !== null &&
  Math.abs(muro.shotZ - 12.3) < 0.8 && !muro.crossBlocked,
  JSON.stringify(muro));

// ---------------------------------------------------------------------------
// 3) KILL SWITCH en vivo: enabled=0 restaura el comportamiento anterior
// ---------------------------------------------------------------------------
const apagado = await page.evaluate(async () => {
  const G = window.BREACH, I = window.BREACH_INPUT, E = window.BREACH_EFFECTS;
  const TUNING = (await import('/src/config/tuning.js')).TUNING;
  TUNING.aimOver.enabled = 0; // apaga SOLO el acomodo visual del arma
  await new Promise((r) => setTimeout(r, 700));
  const lift = G.aimOver.lift;
  let tracerPoint = null, tracerOrigin = null;
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) {
    tracerOrigin = o.clone(); tracerPoint = p2.clone();
    return oldTracer.call(this, o, p2, em);
  };
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 90));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 120));
  E.tracer = oldTracer;
  TUNING.aimOver.enabled = 1;
  // el TRAZO visual tampoco puede cruzar el borde: con el arma abajo (sin
  // acomodo) el tracer se pliega al eje óptico en vez de atravesar la caja
  let tracerClean = null;
  if (tracerOrigin && tracerPoint) {
    const W = window.BREACH_WORLD;
    const d = tracerPoint.clone().sub(tracerOrigin);
    const len = d.length();
    d.multiplyScalar(1 / len);
    const t = W.raycastHit(tracerOrigin, d, len - 0.2)?.t ??
      W.raycast(tracerOrigin, d, len - 0.2) ?? (len - 0.2);
    tracerClean = t >= len - 0.21;
  }
  return {
    lift, fired: G.weapons.st.mag < magBefore,
    shotZ: tracerPoint?.z ?? null, tracerClean,
    tracerY: tracerOrigin ? +tracerOrigin.y.toFixed(2) : null,
  };
});
check('kill switch visual: sin alzada del arma, el DAÑO sigue el eje óptico',
  apagado.lift < 0.03 && apagado.fired &&
  apagado.shotZ !== null && apagado.shotZ < 10,
  `lift=${apagado.lift?.toFixed(3)} shotZ=${apagado.shotZ?.toFixed(1)}`);
check('el TRAZO visual no atraviesa el borde (se pliega al eje)',
  apagado.tracerClean === true, `origenY=${apagado.tracerY}`);

// ---------------------------------------------------------------------------
// 4) HIPFIRE intacto: sin ADS no hay alzada ni bloqueo, el eje físico manda
// ---------------------------------------------------------------------------
const hip = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  I._mouseAim = false;
  await new Promise((r) => setTimeout(r, 500));
  const lift = G.aimOver.lift;
  const magBefore = G.weapons.st.mag;
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 90));
  I._mouseFire = false;
  await new Promise((r) => setTimeout(r, 120));
  // limpiar la caja sintética
  W.colliders.length = window.__baseColliders;
  return { lift, fired: G.weapons.st.mag < magBefore };
});
check('hipfire intacto: sin alzada, dispara normal',
  hip.lift === 0 && hip.fired === true, JSON.stringify(hip));

// ---------------------------------------------------------------------------
// 5) PEGADO A UN OBJETO GRANDE (caso bus): el trace nace en la CÁMARA — la
//    bala pega la cara FRONTAL, jamás nace dentro y sale por atrás.
// ---------------------------------------------------------------------------
const pegado = await page.evaluate(async () => {
  const G = window.BREACH, W = window.BREACH_WORLD, I = window.BREACH_INPUT;
  const E = window.BREACH_EFFECTS;
  // "bus" sintético pegado al jugador (cara frontal a 0.5m)
  W.colliders.push({ minx: 11, minz: 8.4, maxx: 17, maxz: 11.4, h: 3, surface: 'metal' });
  G.player.pos.x = 14; G.player.pos.z = 11.9;
  G.player.yaw = 0; G.player.cam.yaw = 0; G.player.cam.pitch = 0;
  G.weapons.cur = 'smg'; G.weapons.st.mag = 50; G.weapons.st.cd = 0;
  I._mouseAim = true;
  await new Promise((r) => setTimeout(r, 500));
  let tracerPoint = null;
  const oldTracer = E.tracer;
  E.tracer = function (o, p2, em) { tracerPoint = tracerPoint ?? p2.clone(); return oldTracer.call(this, o, p2, em); };
  I._mouseFire = true; I.firePressed = true;
  await new Promise((r) => setTimeout(r, 120));
  I._mouseFire = false; I._mouseAim = false;
  await new Promise((r) => setTimeout(r, 120));
  E.tracer = oldTracer;
  W.colliders.pop();
  return { shotZ: tracerPoint?.z ?? null };
});
check('pegado a un objeto grande: la bala pega la cara FRONTAL (no sale detrás)',
  pegado.shotZ !== null && pegado.shotZ > 11.3,
  `impacto z=${pegado.shotZ?.toFixed(2)} (cara frontal en 11.4, trasera en 8.4)`);

// ---------------------------------------------------------------------------
// 6) DECAL FLOTANTE: un contacto físico SIN superficie visual cerca (el
//    collider sobresale del mesh) no pinta marca; contra una pared real sí.
// ---------------------------------------------------------------------------
const decalGate = await page.evaluate(() => {
  const E = window.BREACH_EFFECTS, T = window.THREE;
  const count = () => E.decals?.activeCount ?? null; // ImpactDecalPool
  const before = count();
  // punto en el AIRE (centro del mapa, 2m de altura, sin mesh cerca)
  E.impact(new T.Vector3(14, 2.4, -2), { x: 0, y: 0, z: 1 }, 'concrete',
    { origin: new T.Vector3(14, 2.4, 4) });
  const afterAir = count();
  // contra el muro perimetral real
  E.impact(new T.Vector3(14, 1.2, -26.7), { x: 0, y: 0, z: 1 }, 'stone',
    { origin: new T.Vector3(14, 1.3, -20) });
  const afterWall = count();
  return { before, afterAir, afterWall, countable: before !== null };
});
check('decal flotante bloqueado; decal en pared real intacto',
  !decalGate.countable ||
  (decalGate.afterAir === decalGate.before && decalGate.afterWall === decalGate.before + 1),
  JSON.stringify(decalGate));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nAIM-OVER: todo verde');
await browser.close();
server.kill();
await clearClip();
process.exit(fails.length ? 1 : 0);
