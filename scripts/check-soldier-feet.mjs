// APOYO DE LOS PIES con la suela DIBUJADA (vértices skinned de la bota), en
// el modelo Blender (diez variantes) y en el avatar procedural:
//  · posturas apoyadas (reposo, coberturas, ADS sobre cobertura, ciegos,
//    deslizamiento, patada, aterrizaje, agachado, asomo, inclinado): cada
//    suela a ±1,5 cm del suelo;
//  · marcha: ninguna suela bajo el suelo y cada pie lo toca en su apoyo
//    (la carrera clásica de frente, por tiempo, solo se exige no hundirse);
//  · piernas en el aire (salto, esquiva, patada): no atraviesan el suelo;
//  · nada del cuerpo bajo el suelo; misma pose a 30/60/144 Hz; en rampa.
//   node scripts/with-dev-server.mjs check-soldier-feet
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import fs from 'node:fs';

const TOL = 0.015;
const SC = [
  // [nombre, parámetros, modo: 'apoyo' | 'izq' (solo la izquierda pisa) | 'marcha' | 'clasica' | 'libre', velocidad, adelante, lado]
  ['reposo', {}, 'apoyo'],
  ['cover bajo', { state: 'cover_low' }, 'apoyo'],
  ['cover bajo ADS', { state: 'cover_low', aim: true, coverAimExposure: 1, coverKind: 'low' }, 'apoyo'],
  ['cover bajo ADS abajo', { state: 'cover_low', aim: true, coverAimExposure: 1, coverKind: 'low', aimPitch: -0.55 }, 'apoyo'],
  ['cover bajo asomado', { state: 'cover_low', aim: true, coverLean: 1, coverAimExposure: 1 }, 'apoyo'],
  ['cover alto', { state: 'cover_high' }, 'apoyo'],
  ['cover alto ADS', { state: 'cover_high', aim: true, coverLean: -1, coverAimExposure: 1 }, 'apoyo'],
  ['ciego encima', { state: 'blind_over', firing: true, blindPoseExposure: 1 }, 'apoyo'],
  ['ciego bajo', { state: 'blind_low_right', firing: true, blindPoseExposure: 1, coverLean: 1 }, 'apoyo'],
  ['ciego alto', { state: 'blind_high_left', firing: true, blindPoseExposure: 1, coverLean: -1 }, 'apoyo'],
  ['deslizamiento', { state: 'slide' }, 'apoyo'],
  ['patada', { state: 'melee', meleePhase: 0.5 }, 'izq'],
  ['caminar apuntando', { state: 'run', speed: 2.16 / 7.6, aim: true }, 'marcha', 2.16, 1, 0],
  ['lateral', { state: 'run', speed: 4.8 / 7.6, moveForward: 0, moveSide: 1 }, 'marcha', 4.8, 0, 1],
  ['atrás', { state: 'run', speed: 4.8 / 7.6, moveForward: -1 }, 'marcha', 4.8, -1, 0],
  ['trote', { state: 'run', speed: 4.8 / 7.6 }, 'clasica', 4.8, 1, 0],
  ['sprint', { state: 'roadie', speed: 1 }, 'clasica', 7.6, 1, 0],
  // capa FPS (corrida 6): agachado, asomo `ce`, inclinación `cl`
  ['agachado', { state: 'crouch', coverAimExposure: 0 }, 'apoyo'],
  ['agachado ADS', { state: 'crouch', aim: true, coverAimExposure: 0 }, 'apoyo'],
  ['asomo ce .5', { state: 'crouch', aim: true, coverAimExposure: 0.5 }, 'apoyo'],
  ['inclinado D ADS', { state: 'idle', aim: true, coverLean: 1 }, 'apoyo'],
  ['inclinado I', { state: 'idle', coverLean: -1 }, 'apoyo'],
  ['agachado inclinado D', { state: 'crouch', aim: true, coverLean: 1, coverAimExposure: 0 }, 'apoyo'],
  ['agachado inclinado I', { state: 'crouch', aim: true, coverLean: -1, coverAimExposure: 0 }, 'apoyo'],
  ['agachado andando', { state: 'crouch', speed: 2.3 / 7.6, coverAimExposure: 0 }, 'marcha', 2.3, 1, 0],
  ['agachado lateral', { state: 'crouch', speed: 2.3 / 7.6, moveForward: 0, moveSide: -1, coverAimExposure: 0 }, 'marcha', 2.3, 0, -1],
  ['agachado atrás', { state: 'crouch', speed: 2.3 / 7.6, moveForward: -1, aim: true, coverAimExposure: 0 }, 'marcha', 2.3, -1, 0],
  ['salto', { state: 'jump', vy: 0 }, 'libre'],
  ['esquiva', { state: 'dive', evadePhase: 0.5 }, 'libre'],
];

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5200') + '/?nolock=1');
  const report = await page.evaluate(async (SC) => {
    const T = await import('/node_modules/three/build/three.module.js');
    const { Rig } = await import('/src/player/rig.js');
    const scene = new T.Scene(), V = new T.Vector3();
    // suela: vértices de la bota (subárbol del tobillo) a <1,2 cm de su fondo
    const soles = (r) => [r.legL, r.legR].map((leg) => {
      const m = r._bodyMesh, pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, bones = m.skeleton.bones;
      const q = leg.ankle.quaternion.clone(); leg.ankle.quaternion.identity(); r.root.updateMatrixWorld(true);
      const inv = new T.Matrix4().copy(leg.ankle.matrixWorld).invert(), cand = [];
      let lo = Infinity;
      for (let i = 0; i < pos.count; i++) {
        let ok = false; for (let n = bones[si.getX(i)]; n && n !== r.root; n = n.parent) if (n === leg.ankle) { ok = true; break; }
        if (!ok) continue;
        m.getVertexPosition(i, V).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
        cand.push([i, V.y]); lo = Math.min(lo, V.y);
      }
      leg.ankle.quaternion.copy(q); r.root.updateMatrixWorld(true);
      return cand.filter(([, y]) => y < lo + 0.012).map(([i]) => i);
    });
    const run = async (r, sc, hz = 60, slope = 0) => {
      const [name, p, mode, speed = 0, f = 1, sd = 0] = sc;
      const floor = (x, z) => Math.tan(slope) * -z;
      r.groundFn = (x, z) => floor(x, z);
      const set = soles(r), m = r._bodyMesh, dt = 1 / hz;
      // piernas (muslo, tibia, bota): lo que el apoyo coloca. El torso y lo
      // que cuelga de él (faldón, pelvis) depende de la altura de cadera de
      // cada postura, que este ajuste no toca.
      const legVerts = [];
      { const si = m.geometry.attributes.skinIndex, bones = m.skeleton.bones;
        for (let v = 0; v < si.count; v += 3) for (let n = bones[si.getX(v)]; n && n !== r.root; n = n.parent) if (n === r.legL.hip || n === r.legR.hip) { legVerts.push(v); break; } }
      let x = 0, z = 0;
      r.setTransform(0, 0, 0, 0);
      for (let i = 0; i < 0.7 * hz; i++) r.update(dt, { state: 'idle', speed: 0, aim: false, groundPitch: slope });
      const res = { L: [Infinity, -Infinity], R: [Infinity, -Infinity], body: Infinity };
      const l = Math.hypot(f, sd) || 1;
      for (let i = 0; i < 2.4 * hz; i++) {
        x += speed * sd / l * dt; z -= speed * f / l * dt;
        r.setTransform(x, z, 0, floor(x, z));
        r.update(dt, { state: 'idle', speed: 0, aim: false, aimPitch: 0, groundPitch: slope, ...p });
        if (i < 1.2 * hz) continue;
        r.root.updateMatrixWorld(true);
        ['L', 'R'].forEach((k, j) => {
          let lo = Infinity;
          for (const v of set[j]) { m.getVertexPosition(v, V).applyMatrix4(m.matrixWorld); lo = Math.min(lo, V.y - floor(V.x, V.z)); }
          res[k][0] = Math.min(res[k][0], lo); res[k][1] = Math.max(res[k][1], lo);
        });
        if (i % 9 === 0) {
          for (const v of legVerts) { m.getVertexPosition(v, V).applyMatrix4(m.matrixWorld); res.body = Math.min(res.body, V.y - floor(V.x, V.z)); }
        }
      }
      for (const k of ['L', 'R', 'body']) res[k] = Array.isArray(res[k]) ? res[k].map((v) => +v.toFixed(4)) : +res[k].toFixed(4);
      return { name, mode, hz, slope, ...res };
    };
    const rows = [];
    for (const avatar of ['blender', 'legacy']) {
      history.replaceState(null, '', `/?nolock=1&soldier=${avatar}`);
      for (const team of avatar === 'blender' ? ['red', 'blue'] : ['red']) for (let v = 0; v < 5; v++) {
        const r = new Rig(scene, team, null, v); await r.visualReady;
        r.update(1 / 60, { state: 'idle', speed: 0, aim: false });
        r.setWeapon('smg', 'shotgun');
        const list = team === 'red' && v === 0 ? SC : SC.filter((s) => s[2] === 'apoyo');
        for (const sc of list) rows.push({ avatar, team, v, ...(await run(r, sc)) });
        if (team === 'red' && v === 0) {
          for (const hz of [30, 144]) for (const sc of [SC[0], SC[1], SC[2], ...SC.filter((c) => c[0] === 'agachado' || c[0] === 'agachado inclinado D')]) rows.push({ avatar, team, v, ...(await run(r, sc, hz)) });
          rows.push({ avatar, team, v, ...(await run(r, ['rampa reposo', {}, 'apoyo'], 60, 0.22)) });
          rows.push({ avatar, team, v, ...(await run(r, ['rampa apuntando', { state: 'run', speed: 2.16 / 7.6, aim: true }, 'marcha', 2.16, 1, 0], 60, 0.22)) });
        }
        r.dispose(scene);
      }
    }
    return rows;
  }, SC);
  if (process.env.BREACH_FEET_OUT) fs.writeFileSync(process.env.BREACH_FEET_OUT, JSON.stringify(report));
  const bad = [];
  const key = (r) => `${r.avatar} ${r.team}${r.v} ${r.name}${r.hz !== 60 ? ' @' + r.hz : ''}`;
  for (const r of report) {
    const lo = Math.min(r.L[0], r.R[0]);
    if (lo < -TOL) bad.push(`${key(r)}: suela ${lo} m bajo el suelo`);
    if (r.body < -TOL) bad.push(`${key(r)}: pierna ${r.body} m bajo el suelo`);
    // el avatar procedural (respaldo) tiene la pierna más corta: con la
    // cadera a 0,86 m (ADS sobre cobertura baja apuntando abajo) ni de
    // puntillas llega; se le admiten 5 cm
    const tolUp = r.avatar === 'legacy' && r.name === 'cover bajo ADS abajo' ? 0.05 : TOL;
    if (r.mode === 'apoyo') for (const k of ['L', 'R']) if (r[k][1] > tolUp) bad.push(`${key(r)}: pie ${k} a ${r[k][1]} m del suelo`);
    if (r.mode === 'izq' && r.L[1] > TOL) bad.push(`${key(r)}: el pie de apoyo flota ${r.L[1]} m`);
    if (r.mode === 'marcha') for (const k of ['L', 'R']) if (r[k][0] > TOL) bad.push(`${key(r)}: el pie ${k} nunca pisa (${r[k][0]} m)`);
  }
  // misma pose a 30/60/144 Hz
  for (const r of report.filter((x) => x.hz !== 60)) {
    const ref = report.find((x) => x.hz === 60 && x.avatar === r.avatar && x.team === r.team && x.v === r.v && x.name === r.name && !x.slope);
    if (ref && Math.max(Math.abs(ref.L[0] - r.L[0]), Math.abs(ref.R[0] - r.R[0])) > 0.004) bad.push(`${key(r)}: distinto a 60 Hz (${r.L[0]}/${ref.L[0]})`);
  }
  console.log(JSON.stringify({ casos: report.length, errors }));
  if (bad.length || errors.length) {
    console.error(`✗ PIES: ${bad.length} fallos\n - ` + bad.slice(0, 30).join('\n - '));
    process.exitCode = 1;
  } else console.log(`✓ PIES OK: ${report.length} casos (2 avatares, 10 variantes, 30/60/144 Hz, rampa) con la suela dibujada en el suelo`);
} finally { await browser.close(); }
