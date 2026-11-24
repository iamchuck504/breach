// CABEZA DIBUJADA = CABEZA IMPACTABLE para un soldado remoto (revisión de la
// rebanada): rig real (Blender) alimentado como remote.js (`interpolated`,
// `poseTr` de transitionOf) frente a hitPose con la misma pose interpolada, en
// agacharse/levantarse, asomo, inclinarse (de pie y agachado), inicio/fin de
// sprint y deslizamiento, a 30/60/144 Hz. Centro de cabeza con el método de
// calibrate-hit-pose (caja del casco + visor), anclado en idle = 1,52.
//   node scripts/with-dev-server.mjs check-rig-net-pose
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';

// ≤2 cm en las transiciones de postura; sprint y deslizamiento quedan
// informados (el volumen de la carrera es el de pie: ver ganchos/rig.md)
const STRICT = /agacharse|asomo|inclinarse/;
const TOL = 0.021;
const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5200') + '/?nolock=1');
  const out = await page.evaluate(async () => {
  const NET = true;
  // Cabeza DIBUJADA (rig real, Blender, método de calibrate-hit-pose) frente a
  // la cabeza del VOLUMEN (hitPose) en un rig alimentado como remote.js.
  const T = await import('/node_modules/three/build/three.module.js');
  const H = await import('/src/combat/hit-pose.js');
  const { Rig } = await import('/src/player/rig.js');
  const r = new Rig(new T.Scene(), 'red', null, 0); r.groundFn = () => 0; await r.visualReady;
  r.setWeapon('smg', 'shotgun'); r.setTransform(0, 0, 0, 0); r.update(1 / 60, { state: 'idle', speed: 0, aim: false });
  const m = r._bodyMesh, bones = m.skeleton.bones, si = m.geometry.attributes.skinIndex, pos = m.geometry.attributes.position, V = new T.Vector3();
  const headIdx = []; for (let i = 0; i < pos.count; i++) { let ok = false; for (let n = bones[si.getX(i)]; n && n !== r.root; n = n.parent) if (n === r.head) { ok = true; break; } if (ok) headIdx.push(i); }
  const visorB = bones.indexOf(r.head);
  const head = () => {
    r.root.updateMatrixWorld(true);
    const mn = [9, 9, 9], mx = [-9, -9, -9], vs = [0, 0, 0, 0];
    for (const i of headIdx) { m.getVertexPosition(i, V); V.applyMatrix4(m.matrixWorld); const l = [-V.z, V.x, V.y];
      for (let a = 0; a < 3; a++) { if (l[a] < mn[a]) mn[a] = l[a]; if (l[a] > mx[a]) mx[a] = l[a]; }
      if (si.getX(i) === visorB) { vs[0] += l[0]; vs[1] += l[1]; vs[2] += l[2]; vs[3]++; } }
    return mn.map((v, a) => ((v + mx[a]) / 2 + vs[a] / vs[3]) / 2);
  };
  const BASE = { state: 'idle', speed: 0, aim: false, aimPitch: 0, aimYawErr: 0, twist: 0, firing: false, moveForward: 1, moveSide: 0, coverLean: 0, coverAimExposure: 0, groundPitch: 0 };
  r.setWeapon('smg', 'shotgun'); r.setTransform(0, 0, 0, 0);
  for (let i = 0; i < 120; i++) r.update(1 / 60, BASE);
  const h0 = head(), oh = [0 - h0[0], 0 - h0[1], 1.52 - h0[2]];
  const ss = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const ramp = (t, a, d) => Math.max(0, Math.min(1, (t - a) / d));
  // movimiento del cliente → campos del cable
  const SC = {
    'agacharse/levantarse': [2.2, (t) => { const low = t < 1.3 ? ss(ramp(t, 0.5, 0.18)) : 1 - ss(ramp(t, 1.3, 0.18)); return { st: low > 0.005 ? 'crouch' : 'idle', ce: 1 - low }; }],
    'asomo': [2.0, (t) => { const aim = t >= 0.4 && t < 1.2; const ce = t < 1.2 ? ramp(t, 0.45, 1 / 6) : 1 - ramp(t, 1.2, 1 / 6); return { st: 'crouch', aim, ce }; }],
    'inclinarse de pie': [2.2, (t) => ({ st: 'idle', aim: true, ce: undefined, cl: ramp(t, 0.4, 1 / 6) - 2 * ramp(t, 1.0, 2 / 6) + ramp(t, 1.6, 1 / 6) })],
    'inclinarse agachado': [2.2, (t) => ({ st: 'crouch', aim: true, ce: 0, cl: ramp(t, 0.4, 1 / 6) - 2 * ramp(t, 1.0, 2 / 6) + ramp(t, 1.6, 1 / 6) })],
    'sprint inicio/fin': [2.0, (t) => ({ st: t >= 0.5 && t < 1.3 ? 'roadie' : 'run', sp: t >= 0.5 && t < 1.3 ? 1 : 0.6 })],
    'deslizamiento': [2.4, (t) => t < 0.5 ? { st: 'roadie', sp: 1 } : t < 1.0 ? { st: 'slide', sp: 0.9 } : (() => { const low = 1 - ss(ramp(t, 1.5, 0.18)); return { st: low > 0.005 ? 'crouch' : 'idle', ce: 1 - low, sp: 0 }; })()],
  };
  const out = {};
  for (const hz of [30, 60, 144]) for (const [name, [dur, f]] of Object.entries(SC)) {
    const hist = [];
    for (let t = 0; t <= dur + 0.1; t += 1 / 20) { const c = f(t); hist.push({ at: +t.toFixed(4), st: c.st, aim: !!c.aim, ce: c.ce, cl: c.cl ?? 0, p: 0, w: 'smg', sp: c.sp ?? 0 }); }
    // reposo en el primer estado
    const p0 = H.poseAt(hist, 0);
    for (let i = 0; i < 90; i++) r.update(1 / 60, { ...BASE, state: p0.st, aim: p0.aim, coverAimExposure: p0.ce ?? 0, coverLean: p0.cl, speed: p0.sp, interpolated: NET });
    let worst = 0, at = 0, sum = 0, n = 0;
    for (let t = 0; t < dur; t += 1 / hz) {
      const pose = H.poseAt(hist, t), tr = H.transitionOf(hist, pose.i, t);
      const vol = H.hitPose({ st: pose.st, aim: pose.aim, ce: pose.ce, cl: pose.cl, pitch: 0, wep: 'smg', sp: pose.sp, ...(tr || {}) });
      r.update(1 / hz, { ...BASE, state: pose.st, aim: pose.aim, coverAimExposure: Number.isFinite(pose.ce) ? pose.ce : 0, coverLean: pose.cl, speed: pose.sp,
        interpolated: NET, poseTr: NET ? tr || null : undefined });
      const h = head().map((v, a) => v + oh[a]);
      const g = Math.hypot(h[0] - vol.h[0], h[1] - vol.h[1], h[2] - vol.h[2]);
      if (g > worst) { worst = g; at = t; }
      sum += g; n++;
    }
    out[`${name} @${hz}`] = { max: +(worst * 100).toFixed(1), at: +at.toFixed(2), mean: +(sum / n * 100).toFixed(1) };
  }
  return out;
});
  const bad = [];
  for (const [k, v] of Object.entries(out)) if (STRICT.test(k) && v.max > TOL * 100) bad.push(`${k}: ${v.max} cm (t=${v.at})`);
  console.log(JSON.stringify({ out, errors }, null, 1));
  if (bad.length || errors.length) { console.error('✗ CABEZA REMOTA: ' + bad.join(' · ')); process.exitCode = 1; }
  else console.log('✓ CABEZA REMOTA OK: dibujada = volumen (≤2 cm) en agacharse, asomo e inclinarse a 30/60/144 Hz');
} finally { await browser.close(); }
