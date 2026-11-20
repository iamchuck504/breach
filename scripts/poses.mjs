// Verificación de poses del rig: screenshots orbitando al personaje +
// chequeo numérico de que el cañón apunta hacia el facing del personaje.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  env: { ...process.env, BREACH_FILL_BOTS: '0', PORT: '8792' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const gunCheck = `(() => {
  const G = window.BREACH;
  const R = G.rig;
  const v = new window.THREE.Vector3();
  R.gunForward(v);
  const f = G.player.facing();
  // distancia de cada mano a su ancla en el arma (deben estar EN el arma)
  R.root.updateWorldMatrix(true, true);
  const a = new window.THREE.Vector3(), b = new window.THREE.Vector3();
  const gun = R.activeGun;
  R.armR.hand.getWorldPosition(a); gun.userData.grip.getWorldPosition(b);
  const handR = +a.distanceTo(b).toFixed(3);
  // mano izquierda: hueco hasta la superficie VISIBLE del arma (menos el
  // radio de la mano). Ya no se exige el guardamanos: en cadera y ADS la
  // izquierda toma el punto más adelantado del arma que el brazo alcanza.
  R.armL.hand.getWorldPosition(a);
  let near = Infinity;
  const w = new window.THREE.Vector3();
  gun.updateMatrixWorld(true);
  gun.traverse((o) => {
    if (!o.isMesh) return;
    for (let q = o; q && q !== gun.parent; q = q.parent) if (!q.visible) return;
    const pos = o.geometry.attributes.position;
    for (let k = 0; k < pos.count; k++) near = Math.min(near, w.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld).distanceTo(a));
  });
  const handL = +Math.max(0, near - 0.055).toFixed(3);
  return { dot: +(v.x * f.x + v.z * f.z).toFixed(3), y: +v.y.toFixed(3), state: G.player.animState(), handR, handL };
})()`;

let browser;
const problems = [];
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => problems.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8792/?nolock=1', { waitUntil: 'networkidle' });
  await page.click('#btn-enter');
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.click('#btn-practice');
  await page.waitForTimeout(800);

  // campo abierto + cámara orbitada para ver al personaje de frente-lado
  await page.evaluate(() => {
    const G = window.BREACH;
    G.player.pos.x = 0; G.player.pos.z = -6;
    G.player.cam.yaw = Math.PI * 0.72;
    G.player.cam.pitch = -0.15;
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-idle.png') });
  const idle = await page.evaluate(gunCheck);
  console.log('IDLE:', JSON.stringify(idle));
  if (idle.dot < 0.7) problems.push('idle: cañón no apunta al frente (dot=' + idle.dot + ')');

  // el cuerpo debe seguir a la cámara en reposo, con la retícula cerca del centro
  const track = await page.evaluate(() => {
    const G = window.BREACH;
    let d = G.player.cam.yaw - G.player.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const el = document.getElementById('barrel-dot');
    return {
      yawDiff: +Math.abs(d).toFixed(3),
      dotOn: el.classList.contains('on'),
      dx: +(parseFloat(el.style.left) - innerWidth / 2).toFixed(0),
      dy: +(parseFloat(el.style.top) - innerHeight / 2).toFixed(0),
    };
  });
  console.log('TRACK:', JSON.stringify(track));
  if (track.yawDiff > 0.15) problems.push('idle: el cuerpo no sigue a la cámara (yawDiff=' + track.yawDiff + ')');
  // el paralaje del punto crece cuando el ray pega en geometría cercana
  if (!track.dotOn || Math.abs(track.dx) > 230 || Math.abs(track.dy) > 230) {
    problems.push('retícula lejos del centro: ' + JSON.stringify(track));
  }

  // ADS
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-aim.png') });
  const aim = await page.evaluate(gunCheck);
  console.log('AIM:', JSON.stringify(aim));
  if (aim.dot < 0.85) problems.push('aim: cañón no apunta al frente (dot=' + aim.dot + ')');
  for (const [nm, st] of [['idle', idle], ['aim', aim]]) {
    if (st.handR > 0.08) problems.push(nm + ': mano derecha fuera del arma (' + st.handR + 'm)');
    // D1 (run2): en cadera la izquierda flotaba 0,32 m fuera del arma. La
    // postura perfilada (HIP_BLADE en rig.js) la pone sobre el arma.
    if (st.handL > 0.04) problems.push(nm + ': mano izquierda fuera del arma (' + st.handL + 'm de hueco)');
  }
  await page.mouse.up({ button: 'right' });

  // Cambio de arma: las hombreras deben acompañar al pivote animado del brazo.
  // Se mide lo que SE DIBUJA: el cuerpo es una sola SkinnedMesh horneada
  // (soldier-bake.js), así que el padre de un nodo no prueba nada. Se toman
  // los vértices de la hombrera por el hueso al que están ligados —soldado
  // Blender: hueso 'segment_pauldron_L/R' (bajo el pivote del brazo); legacy
  // (?soldier=legacy): la hombrera procedural va ligada al propio pivote
  // 'shoulder-L/R', de la que se toma la parte alta— y se les aplica el skinning
  // (getVertexPosition). Deben (1) ir rígidos con el pivote del brazo, en
  // reposo y durante el gesto, y (2) desplazarse con él durante el gesto.
  const pauldrons = `(() => {
    const T = window.THREE, R = window.BREACH.rig, body = R._bodyMesh;
    if (!body?.isSkinnedMesh) return { active: window.BREACH.weapons.swapping, error: 'sin cuerpo horneado' };
    R.root.updateMatrixWorld(true);
    body.skeleton.update();
    const bones = body.skeleton.bones, g = body.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const under = (b, anc) => { for (let q = b; q; q = q.parent) if (q === anc) return true; return false; };
    const v = new T.Vector3(), side = {};
    for (const s of ['L', 'R']) {
      const sh = R['arm' + s].shoulder;
      let bi = bones.findIndex((b) => /pauldron/i.test(b.name) && under(b, sh)), kind = 'blender';
      if (bi < 0) { bi = bones.indexOf(sh); kind = 'legacy'; }
      const idx = [];
      if (bi >= 0) for (let k = 0; k < g.attributes.position.count && idx.length < 400; k++) {
        let on = false;
        for (let c = 0; c < 4; c++) if (si.getComponent(k, c) === bi && sw.getComponent(k, c) > 0.5) on = true;
        if (!on) continue;
        if (kind === 'legacy') { // parte alta del hombro = la hombrera
          body.getVertexPosition(k, v).applyMatrix4(body.matrixWorld); sh.worldToLocal(v);
          if (v.y < 0.02) continue;
        }
        idx.push(k);
      }
      const local = [], inRoot = [];
      for (const k of idx) {
        body.getVertexPosition(k, v).applyMatrix4(body.matrixWorld);
        inRoot.push(R.root.worldToLocal(v.clone()).toArray());
        local.push(sh.worldToLocal(v.clone()).toArray());
      }
      side[s] = { kind, bone: bi >= 0 ? bones[bi].name : null, n: idx.length, local, inRoot };
    }
    return { active: window.BREACH.weapons.swapping, side };
  })()`;
  const rest = await page.evaluate(pauldrons);
  await page.keyboard.press('q');
  let swap = null;
  for (let i = 0; i < 10 && !swap?.active; i++) {
    await page.waitForTimeout(40);
    swap = await page.evaluate(pauldrons);
  }
  await page.waitForTimeout(140); // mitad del gesto
  swap = await page.evaluate(pauldrons);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-swap.png') });
  const maxDev = (a, b) => a.reduce((m, p, i) => Math.max(m, Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2])), 0);
  const meanDev = (a, b) => a.reduce((m, p, i) => m + Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2]), 0) / Math.max(1, a.length);
  const summary = { active: swap.active, error: rest.error ?? swap.error };
  if (!summary.error) {
    for (const s of ['L', 'R']) {
      const r0 = rest.side[s], r1 = swap.side[s];
      summary[s] = { kind: r0.kind, bone: r0.bone, n: r0.n,
        // rigidez respecto al pivote del brazo (mm) y recorrido con el gesto (m)
        rigidMm: r0.n && r0.n === r1.n ? +(maxDev(r0.local, r1.local) * 1000).toFixed(2) : null,
        moved: r0.n && r0.n === r1.n ? +meanDev(r0.inRoot, r1.inRoot).toFixed(3) : null,
        // en reposo, pegada al hombro: ningún vértice a más de 0,35 m del pivote
        restReach: +Math.max(0, ...r0.local.map((p) => Math.hypot(...p))).toFixed(3) };
    }
  }
  console.log('SWAP:', JSON.stringify(summary));
  if (summary.error) problems.push('swap: ' + summary.error);
  if (!swap.active) problems.push('swap: el cambio de arma no llegó a estar activo al medir');
  for (const s of ['L', 'R']) {
    const m = summary[s];
    if (!m) continue;
    if (m.n < 20) { problems.push('swap: hombrera ' + s + ' sin vértices dibujados ligados a su hueso (' + JSON.stringify(m) + ')'); continue; }
    // ligada a otro hueso (torso, cadera…) se separaría del pivote al girar
    if (!(m.restReach <= 0.35)) problems.push('swap: la hombrera ' + s + ' no está sobre el hombro en reposo (' + m.restReach + ' m del pivote)');
    if (!(m.rigidMm <= 1)) problems.push('swap: la hombrera ' + s + ' no va rígida con el brazo (' + m.rigidMm + ' mm)');
  }
  // el gesto lleva el arma al hombro derecho: su hombrera debe desplazarse con él
  if (summary.R && !(summary.R.moved > 0.02)) {
    problems.push('swap: la hombrera derecha no acompañó el gesto (recorrido ' + summary.R.moved + ' m)');
  }
  // Regresar al SMG y dejar concluir el gesto/damping antes de volver a medir.
  await page.waitForTimeout(850);
  await page.keyboard.press('q');
  await page.waitForTimeout(1200);

  // hipfire: DISPARANDO, el cañón debe ser colineal con la línea de tiro real
  await page.evaluate(() => {
    const P = window.BREACH.player;
    P.pos.x = 0; P.pos.z = -6; P.cam.pitch = -0.3;
  });
  await page.mouse.down();
  // esperar CONVERGENCIA del damping (los hitches de compilación de shaders
  // en headless retrasan los primeros frames: medir a tiempo fijo daba
  // falsos negativos con la pose a medio camino)
  let fireAlign = 0;
  for (let i = 0; i < 12 && fireAlign < 0.96; i++) {
    await page.waitForTimeout(250);
    fireAlign = await page.evaluate(`(() => {
      const G = window.BREACH;
      const v = new window.THREE.Vector3();
      G.rig.gunForward(v);
      const yaw = G.player.cam.yaw, p = G.player.cam.pitch;
      const d = new window.THREE.Vector3(
        -Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
      return +v.dot(d).toFixed(3);
    })()`);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('FIREALIGN:', JSON.stringify({ dot: fireAlign }));
  if (fireAlign < 0.96) problems.push('hipfire: el cañón no es colineal con el tiro (dot=' + fireAlign + ')');

  // roadie (perfil)
  await page.keyboard.down('Shift');
  await page.keyboard.down('a');
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-roadie.png') });
  // antes solo se fotografiaba: confirmar que la foto es de verdad un roadie
  const roadieSt = await page.evaluate(() => window.BREACH.player.state);
  console.log('ROADIE:', JSON.stringify({ st: roadieSt }));
  if (roadieSt !== 'roadie') problems.push('roadie: Shift+A no produjo roadie (st=' + roadieSt + ')');
  await page.keyboard.up('a'); await page.keyboard.up('Shift');
  await page.waitForTimeout(300);

  // cover contra un bloque LOW (1.1). El bloque fijo de (-1.5,-6) desapareció
  // en maps v3 (f0b9959): desde (-1.5,-4.4) el jugador acababa en cover_high
  // contra la torre del homenaje y el chequeo de la cabeza (condicionado a
  // cover_low) pasaba sin medir nada. Misma búsqueda de cara LOW a nivel de
  // suelo que smoke.mjs / check-movement.mjs.
  const lowFace = await page.evaluate(() => {
    const G = window.BREACH, W = window.BREACH_WORLD;
    const f = W.faces.find((c) => c.h <= 1.2 && c.n.z < -0.9 && !c.baseY);
    if (!f) return null;
    const P = G.player;
    P.cover = null; P.state = 'idle'; P.y = 0; P.vel.x = 0; P.vel.z = 0;
    P.pos.x = (f.a.x + f.b.x) / 2; P.pos.z = (f.a.z + f.b.z) / 2 - 1.2;
    P.cam.yaw = Math.PI; P.yaw = Math.PI; P.cam.pitch = -0.15; // mirando a +z, al bloque
    return { h: f.h, x: +P.pos.x.toFixed(2), z: +P.pos.z.toFixed(2) };
  });
  if (!lowFace) problems.push('cover bajo: precondición — no hay cara LOW a nivel de suelo');
  await page.waitForTimeout(250);
  // snap al cover (reintento como en smoke: el primer edge puede caer en un
  // frame de transición del bloque anterior)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(' ');
    await page.waitForTimeout(320);
    if (await page.evaluate(() => window.BREACH.player.state === 'cover')) break;
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(root, 'scripts', 'pose-cover.png') });
  const cover = await page.evaluate(`(() => {
    const G = window.BREACH;
    G.rig.root.updateWorldMatrix(true, true);
    const v = new window.THREE.Vector3();
    G.rig.head.getWorldPosition(v);
    return { st: G.player.state, anim: G.player.animState(), headTop: +(v.y + 0.34).toFixed(2) };
  })()`);
  console.log('COVER:', JSON.stringify({ face: lowFace, ...cover }));
  if (cover.anim !== 'cover_low') {
    problems.push('cover bajo: no entró en cover_low contra el bloque LOW (' + JSON.stringify(cover) + ')');
  } else if (cover.headTop > 1.08) {
    problems.push('cover bajo: la cabeza asoma sobre el bloque LOW (top=' + cover.headTop + 'm vs 1.1)');
  }
} catch (e) {
  problems.push('FATAL: ' + e.message);
} finally {
  await browser?.close();
  clearClip();
  server.kill();
}

if (problems.length) {
  for (const p of problems) console.log('PROBLEMA: ' + p);
  process.exit(1);
}
console.log('POSES OK');
