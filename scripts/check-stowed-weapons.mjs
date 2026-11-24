// ARMAS GUARDADAS: la de la espalda y la pistola enfundada no atraviesan el
// cuerpo dibujado ni se tocan entre sí, en las posturas en que se ven
// (reposo, carrera, sprint, coberturas, mantle, patada, esquiva, caída), en
// las diez variantes del modelo Blender y en el avatar procedural; la de la
// espalda no asoma sobre el casco. Mide con los vértices skinned del cuerpo
// (prueba de paridad de rayos por pieza) y los del modelo del arma.
//   node scripts/with-dev-server.mjs check-stowed-weapons
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import fs from 'node:fs';

const browser = await chromium.launch({ executablePath: CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto((process.env.BASE || 'http://127.0.0.1:5200') + '/?nolock=1');
  const report = await page.evaluate(async () => {
    const T = await import('/node_modules/three/build/three.module.js');
    const { Rig } = await import('/src/player/rig.js');
    const scene = new T.Scene(), V = new T.Vector3();
    // cuerpo en el mundo: posiciones, triángulos y caja por pieza (hueso)
    const bake = (r) => {
      const m = r._bodyMesh; r.root.updateMatrixWorld(true);
      const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, n = pos.count;
      const P = new Float32Array(n * 3), B = new Uint16Array(n), nb = m.skeleton.bones.length;
      const box = new Float32Array(nb * 6).fill(Infinity);
      for (let b = 0; b < nb; b++) { box[b * 6 + 3] = box[b * 6 + 4] = box[b * 6 + 5] = -Infinity; }
      for (let i = 0; i < n; i++) {
        m.getVertexPosition(i, V).applyMatrix4(m.matrixWorld);
        P[i * 3] = V.x; P[i * 3 + 1] = V.y; P[i * 3 + 2] = V.z;
        const b = B[i] = si.getX(i), o = b * 6;
        box[o] = Math.min(box[o], V.x); box[o + 1] = Math.min(box[o + 1], V.y); box[o + 2] = Math.min(box[o + 2], V.z);
        box[o + 3] = Math.max(box[o + 3], V.x); box[o + 4] = Math.max(box[o + 4], V.y); box[o + 5] = Math.max(box[o + 5], V.z);
      }
      return { P, B, box, nb, n };
    };
    const DIRS = [[0.5774, 0.5774, 0.5774], [-0.8018, 0.2673, 0.5345], [0.1361, -0.6804, -0.7201], [0.2, 0.3, -0.9327], [-0.4, -0.9, 0.1732]];
    // profundidad a la que el punto queda dentro de alguna pieza (0 = fuera)
    const inside = (body, tris, x, y, z) => {
      let odd = 0, depth = Infinity;
      for (const [dx, dy, dz] of DIRS) {
        let c = 0, near = Infinity;
        const P = body.P;
        for (let t = 0; t < tris.length; t += 3) {
          const a = tris[t] * 3, b = tris[t + 1] * 3, cc = tris[t + 2] * 3;
          const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
          const e2x = P[cc] - P[a], e2y = P[cc + 1] - P[a + 1], e2z = P[cc + 2] - P[a + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det, tx = x - P[a], ty = y - P[a + 1], tz = z - P[a + 2];
          const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
          const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (tt > 1e-6) { c++; near = Math.min(near, tt); }
        }
        if (c & 1) { odd++; depth = Math.min(depth, near); }
      }
      return odd >= 4 ? depth : 0;
    };
    const gunPts = (g, max = 140) => {
      const m = g.userData.bakedMesh, pos = m.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / max)), out = [];
      m.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i += step) { V.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); out.push([V.x, V.y, V.z]); }
      return out;
    };
    // triángulos de las piezas cuya caja toca la del arma (las piezas son cerradas)
    const trisNear = (body, pts) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      const keep = new Uint8Array(body.nb);
      for (let b = 0; b < body.nb; b++) {
        const o = b * 6; let ok = true;
        for (let k = 0; k < 3; k++) if (body.box[o + k] > hi[k] + 0.02 || body.box[o + 3 + k] < lo[k] - 0.02) ok = false;
        keep[b] = ok ? 1 : 0;
      }
      const t = [];
      for (let i = 0; i < body.n; i += 3) if (keep[body.B[i]]) t.push(i, i + 1, i + 2);
      return t;
    };
    const STATES = [
      ['reposo', { state: 'idle' }], ['carrera', { state: 'run', speed: 0.62 }], ['sprint', { state: 'roadie', speed: 1 }],
      ['cover bajo', { state: 'cover_low' }], ['cover alto', { state: 'cover_high' }], ['mantle', { state: 'mantle', mantlePhase: 0.5 }],
      ['patada', { state: 'melee', meleePhase: 0.5 }], ['esquiva', { state: 'dive', evadePhase: 0.4 }],
      // capa FPS (corrida 6); antes de la caída, que reinicia la zancada (la
      // carrera de la siguiente arma se mide en la misma fase que antes)
      ['agachado', { state: 'crouch', coverAimExposure: 0 }], ['agachado ADS inclinado', { state: 'crouch', aim: true, coverLean: 1, coverAimExposure: 0 }],
      ['inclinado I', { state: 'idle', aim: true, coverLean: -1 }], ['deslizamiento', { state: 'slide' }],
      ['caída', { state: 'dead' }, 8],
    ];
    const rows = [];
    const random = Math.random; Math.random = () => 0.5;
    for (const avatar of ['blender', 'legacy']) {
      history.replaceState(null, '', `/?nolock=1&soldier=${avatar}`);
      for (const team of avatar === 'blender' ? ['red', 'blue'] : ['red']) for (let v = 0; v < 5; v++) {
        const r = new Rig(scene, team, null, v); r.groundFn = () => 0; await r.visualReady;
        // también recién construido, sin re-equipar (el cuerpo se fusiona
        // después de montar las armas de fábrica)
        const cases = [['shotgun', 'recién creado', { state: 'idle' }, 1, true]];
        for (const back of ['smg', 'shotgun', 'sniper', 'bazooka']) for (const [name, p, frames = 70] of STATES) cases.push([back, name, p, frames, false]);
        for (const [back, name, p, frames, fresh] of cases) {
          const hand = back === 'smg' ? 'shotgun' : 'smg';
          {
            if (!fresh) r.setWeapon(hand, back);
            r.setTransform(0, 0, 0, 0);
            if (!fresh) for (let i = 0; i < 40; i++) r.update(1 / 60, { state: 'idle', speed: 0, aim: false });
            for (let i = 0; i < frames; i++) r.update(1 / 60, { speed: 0, aim: false, aimPitch: 0, ...p });
            r.root.updateMatrixWorld(true);
            const body = bake(r), row = { avatar, team, v, back, name, in: 0, deep: 0, pistolIn: 0, pistolDeep: 0, touch: 0, top: 0, helmet: 0 };
            const bp = gunPts(r.guns[back]), pp = r.guns.pistol.parent ? gunPts(r.guns.pistol) : [];
            for (const [list, k, d] of [[bp, 'in', 'deep'], [pp, 'pistolIn', 'pistolDeep']]) {
              const tris = trisNear(body, list);
              for (const [x, y, z] of list) {
                const dep = inside(body, tris, x, y, z);
                if (dep > 0.012) { row[k]++; row[d] = Math.max(row[d], +dep.toFixed(3)); }
              }
            }
            // arma con arma: distancia mínima entre las nubes de puntos
            let md = Infinity;
            for (const a of bp) for (const b of pp) md = Math.min(md, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
            row.touch = pp.length ? +md.toFixed(3) : null;
            row.top = +Math.max(...bp.map((q) => q[1])).toFixed(3);
            let helmet = -Infinity;
            for (let i = 0; i < body.n; i++) if (body.P[i * 3 + 1] > helmet) helmet = body.P[i * 3 + 1];
            row.helmet = +helmet.toFixed(3);
            rows.push(row);
          }
        }
        r.dispose(scene);
      }
    }
    Math.random = random;
    return rows;
  });
  if (process.env.BREACH_STOW_OUT) fs.writeFileSync(process.env.BREACH_STOW_OUT, JSON.stringify(report));
  const bad = [];
  for (const r of report) {
    const id = `${r.avatar} ${r.team}${r.v} ${r.back} ${r.name}`;
    if (r.in > 2 || r.deep > 0.03) bad.push(`${id}: espalda dentro del cuerpo ${r.in} puntos (máx ${r.deep} m)`);
    if (r.pistolIn > 2 || r.pistolDeep > 0.03) bad.push(`${id}: pistola dentro del cuerpo ${r.pistolIn} puntos (máx ${r.pistolDeep} m)`);
    if (r.touch !== null && r.touch < 0.02) bad.push(`${id}: la pistola toca el arma de la espalda (${r.touch} m)`);
    if ((r.name === 'reposo' || r.name === 'recién creado') && r.top > r.helmet - 0.01) bad.push(`${id}: el arma asoma sobre el casco (${r.top} ≥ ${r.helmet})`);
  }
  const worst = [...report].sort((a, b) => (b.in + b.pistolIn) - (a.in + a.pistolIn)).slice(0, 6);
  console.log(JSON.stringify({ casos: report.length, peores: worst, errors }, null, 1));
  if (bad.length || errors.length) {
    console.error(`✗ ARMAS GUARDADAS: ${bad.length} fallos en ${report.length} casos\n - ` + bad.slice(0, 30).join('\n - '));
    process.exitCode = 1;
  } else console.log(`✓ ARMAS GUARDADAS OK: ${report.length} casos (2 avatares, 10 variantes, 4 armas, 13 posturas y recién creado) sin atravesar cuerpo ni casco`);
} finally { await browser.close(); }
