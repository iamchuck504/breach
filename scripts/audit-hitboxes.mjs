// AUDITORÍA de hitboxes: compara la silueta VISUAL real (raycast Three.js
// contra los meshes del mapa) con la geometría FÍSICA (colliders AABB +
// segmentos). Dispara rejillas de rayos horizontales alrededor de cada
// collider y reporta AGUJEROS (lo visible no para la bala) y FANTASMAS
// (pared invisible sin nada que ver). Además, un barrido top-down detecta
// volumen visual jugable SIN ningún collider debajo.
//   node scripts/audit-hitboxes.mjs [mapa] [tolerancia]
//   (default: calle 0.30 — tolerancia en metros para contar
//   agujero/fantasma; 0.15 sirve como diagnóstico fino de "no me puedo
//   pegar al objeto", con ruido esperable en siluetas curvas)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';
const LAYOUT = process.argv[2] || 'calle';
const TOL = Number(process.argv[3]) || 0.30;

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8799', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto('http://localhost:8799/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(async (layout) => {
  window.BREACH.mapChoice = layout;
  document.getElementById('btn-practice').click();
}, LAYOUT);
await page.waitForTimeout(2600);

const report = await page.evaluate(async ([layout, TOL]) => {
  const W = window.BREACH_WORLD, T = window.THREE;
  const G = window.BREACH;
  for (const d of G.dummies?.list ?? []) { d.alive = false; d.respawnT = 9999; }
  await new Promise((r) => setTimeout(r, 300));

  // ---------- raycast VISUAL (meshes reales, sin suelo/overlays) ----------
  const caster = new T.Raycaster();
  caster.far = 500;
  caster.camera = window.BREACH_CAM; // los Sprite.raycast exigen cámara
  const skip = (obj) => {
    for (let o = obj; o; o = o.parent) {
      if (o.name === 'editor-overlay') return true;
    }
    return false;
  };
  // suelo/planos horizontales gigantes irrelevantes con rayos horizontales
  const visualHit = (origin, dir, maxDist) => {
    caster.set(origin, dir);
    caster.far = maxDist;
    const hits = caster.intersectObjects(W.mapGroup.children, true);
    for (const h of hits) {
      if (h.distance < 0.02) continue;
      if (!h.object.isMesh && !h.object.isSprite) continue;
      if (h.object.isSprite) continue;
      if (skip(h.object)) continue;
      // planos rasantes al rayo (suelos/marcas) no cuentan
      if (h.face && Math.abs(h.face.normal.clone()
        .transformDirection(h.object.matrixWorld).dot(dir)) < 0.08) continue;
      return h;
    }
    return null;
  };
  const physHitFull = (origin, dir, maxDist) => {
    const h = W.raycastHit(origin, dir, maxDist);
    if (h) return h;
    const t = W.raycast(origin, dir, maxDist);
    return t === null || t === undefined ? null : { t, collider: null };
  };
  const physHit = (origin, dir, maxDist) => physHitFull(origin, dir, maxDist)?.t ?? null;

  // ---------- ÁREA ALCANZABLE ----------
  // Relleno desde los spawns con la física real del juego (mismo radio de
  // cuerpo, mismos colliders, escaleras y cubiertas). Decoración que queda
  // detrás de las murallas —torreones de esquina, torres lejanas, árboles—
  // no puede recibir un disparo desde ningún sitio donde quepa un jugador:
  // exigirle colisión sería inventar física fuera del mapa.
  const BODY_R = 0.38, CELL = 0.3;
  const gx = Math.ceil(W.fx * 2 / CELL), gz = Math.ceil(W.fz * 2 / CELL);
  const reach = new Float32Array(gx * gz).fill(NaN); // altura del suelo por celda alcanzable
  const cellOf = (x, z) => [Math.floor((x + W.fx) / CELL), Math.floor((z + W.fz) / CELL)];
  const centreOf = (i, j) => [-W.fx + (i + 0.5) * CELL, -W.fz + (j + 0.5) * CELL];
  const spawnPoints = [...(W.spawns?.red ?? []), ...(W.spawns?.blue ?? [])];
  const queue = [];
  for (const s of spawnPoints) {
    const [i, j] = cellOf(s.x, s.z);
    if (i < 0 || j < 0 || i >= gx || j >= gz || !Number.isNaN(reach[j * gx + i])) continue;
    reach[j * gx + i] = W.groundHeight({ x: s.x, z: s.z }, BODY_R, 0);
    queue.push([i, j]);
  }
  let reachable = queue.length;
  while (queue.length) {
    const [i, j] = queue.pop();
    const y = reach[j * gx + i];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= gx || b >= gz || !Number.isNaN(reach[b * gx + a])) continue;
      const [x, z] = centreOf(a, b);
      const q = { x, z };
      W.resolveCircle(q, BODY_R, y);
      if (Math.hypot(q.x - x, q.z - z) > 0.06) continue; // el cuerpo no cabe ahí
      const g = W.groundHeight({ x, z }, BODY_R, y);
      if (g - y > 0.3) continue;                          // escalón que exige salto
      reach[b * gx + a] = g; reachable++;
      queue.push([a, b]);
    }
  }
  // ¿Puede salir un disparo desde algún sitio alcanzable hasta este punto?
  // Basta una celda alcanzable a menos de 2 m con línea física despejada.
  const _from = new T.Vector3(), _to = new T.Vector3();
  const shootable = (x, y, z) => {
    const [ci, cj] = cellOf(x, z), span = Math.ceil(2 / CELL);
    for (let j = cj - span; j <= cj + span; j++) for (let i = ci - span; i <= ci + span; i++) {
      if (i < 0 || j < 0 || i >= gx || j >= gz) continue;
      const g = reach[j * gx + i];
      if (Number.isNaN(g)) continue;
      const [sx, sz] = centreOf(i, j);
      const flat = Math.hypot(sx - x, sz - z);
      if (flat > 2) continue;
      _from.set(sx, Math.max(y, g + 0.3), sz);
      _to.set(x - sx, y - _from.y, z - sz);
      const len = _to.length();
      if (len < 0.08) return true;
      if (physHit(_from, _to.multiplyScalar(1 / len), len - 0.06) === null) return true;
    }
    return false;
  };
  // TOLERANCIA en cualquier dirección: un relieve que sobresale menos de TOL
  // de un collider ya se aceptaba de frente (el rayo pega la caja poco
  // después); visto de canto el rayo pasa paralelo a la cara y no la toca
  // nunca. El criterio es el mismo en ambos casos: ¿hay física a menos de
  // TOL del punto dibujado?
  const covered = (x, y, z) => W.colliders.some((c) =>
    x > c.minx - TOL - 1e-3 && x < c.maxx + TOL + 1e-3 && z > c.minz - TOL - 1e-3 && z < c.maxz + TOL + 1e-3 &&
    y < c.h + TOL && y > (c.minY ?? 0) - TOL);
  let outOfReach = 0, withinTolerance = 0;

  // ---------- 1) rejillas alrededor de cada collider ----------
  const boxes = W.colliders.map((c) => ({ ...c }));
  const findings = [];
  const origin = new T.Vector3(), dir = new T.Vector3();
  const _down = new T.Vector3(0, -1, 0);
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi];
    const w = b.maxx - b.minx, d2 = b.maxz - b.minz;
    if (w > 12 || d2 > 12) continue; // muros perimetrales/escudos: aparte
    const cx = (b.minx + b.maxx) / 2, cz = (b.minz + b.maxz) / 2;
    // altura JUGABLE: techos/toldos por encima de 2.3 no reciben tiros útiles
    const top = Math.min(b.h + 0.5, 2.3);
    let holes = 0, ghosts = 0, rays = 0, holesLow = 0, ghostsLow = 0;
    const examples = [];
    // margen fantasma por dirección de entrada (cuánto sobra cada cara) y
    // fantasmas por franja de altura (cuánto sobra por arriba)
    const faceGhost = { px: [], nx: [], pz: [], nz: [] };
    const ghostByBand = new Map();
    for (const [dx, dz, face] of [[1, 0, 'px'], [-1, 0, 'nx'], [0, 1, 'pz'], [0, -1, 'nz']]) {
      const span = (dx !== 0 ? d2 : w) + 1.2;
      const dist = 3.0 + (dx !== 0 ? w : d2) / 2;
      for (let y = 0.18; y <= top; y += 0.14) {
        for (let u = -span / 2; u <= span / 2; u += 0.16) {
          const ox = cx - dx * dist + (dz !== 0 ? u : 0);
          const oz = cz - dz * dist + (dx !== 0 ? u : 0);
          origin.set(ox, y, oz);
          dir.set(dx, 0, dz);
          const maxDist = dist * 2;
          const v = visualHit(origin, dir, maxDist);
          const ph = physHitFull(origin, dir, maxDist);
          const p = ph?.t ?? null;
          const vt = v ? v.distance : null;
          // atribuir SOLO lo que ocurre en ESTA caja: sin esto, cada rayo
          // que cruza el pasillo contamina la caja con discrepancias ajenas
          const inCell = (t) => {
            if (t === null) return false;
            const hx = ox + dx * t, hz = oz + dz * t;
            return hx > b.minx - 0.4 && hx < b.maxx + 0.4 &&
              hz > b.minz - 0.4 && hz < b.maxz + 0.4;
          };
          const ghostHere = p !== null && (vt === null || vt > p + TOL) &&
            (ph.collider === b || (ph.collider === null && inCell(p)));
          // +1 mm: una pieza que sobresale EXACTAMENTE la tolerancia no debe caer de
          // un lado u otro por redondeo de coma flotante
          let holeHere = vt !== null && (p === null || p > vt + TOL + 1e-3) && inCell(vt);
          // VOLADIZOS COLGANTES (letreros/banners que cuelgan de un alero,
          // por encima de la cabeza): si bajo el punto impactado hay AIRE
          // (ningún mesh en los 0.55m inferiores), una caja desde el suelo
          // sería una cortina invisible sobre un hueco visible — exento.
          if (holeHere && y > 1.75) {
            const hx = ox + dx * vt, hz = oz + dz * vt;
            origin.set(hx + dx * 0.04, y - 0.1, hz + dz * 0.04);
            caster.set(origin, _down);
            caster.far = 0.55;
            const below = caster.intersectObjects(W.mapGroup.children, true)
              .some((th) => th.object.isMesh && !skip(th.object));
            if (!below) holeHere = false;
          }
          // guijarros/faldas de derrubio: si el tope visual LOCAL del punto
          // impactado queda bajo 0.52, es decoración de suelo sin física
          // (no hay prone; cubrirla bloquearía tiros legítimos a los pies)
          if (holeHere && y < 0.55) {
            const hx = ox + dx * vt, hz = oz + dz * vt;
            origin.set(hx + dx * 0.06, 2.9, hz + dz * 0.06);
            caster.set(origin, _down);
            caster.far = 3.0;
            const tops = caster.intersectObjects(W.mapGroup.children, true);
            for (const th of tops) {
              if (!th.object.isMesh || skip(th.object)) continue;
              const mat2 = Array.isArray(th.object.material)
                ? th.object.material[0] : th.object.material;
              if (mat2?.transparent) continue;
              if (2.9 - th.distance < 0.52) holeHere = false;
              break;
            }
          }
          if (holeHere) {
            const hx = ox + dx * vt, hz = oz + dz * vt;
            if (covered(hx, y, hz)) { holeHere = false; withinTolerance++; }
            else if (!shootable(hx, y, hz)) { holeHere = false; outOfReach++; }
          }
          const okHere = ph?.collider === b && !ghostHere && !holeHere;
          if (!ghostHere && !holeHere && !okHere) continue;
          rays++;
          if (holeHere) {
            holes++;
            if (y < 2.1) holesLow++;
            if (examples.length < 3) {
              examples.push({
                at: [+(ox + dx * vt).toFixed(2), +y.toFixed(2), +(oz + dz * vt).toFixed(2)],
                mesh: v.object.name || v.object.parent?.name || '?',
                miss: +(p === null ? 99 : p - vt).toFixed(2),
              });
            }
          } else {
            ghosts++;
            if (y < 2.1) ghostsLow++;
            faceGhost[face].push(vt === null ? 99 : vt - p);
            const band = +(Math.round(y / 0.35) * 0.35).toFixed(2);
            ghostByBand.set(band, (ghostByBand.get(band) ?? 0) + 1);
          }
        }
      }
    }
    if (holes + ghosts > 0) {
      const faceStats = {};
      for (const [k, list] of Object.entries(faceGhost)) {
        if (!list.length) continue;
        const finite = list.filter((m) => m < 90);
        faceStats[k] = {
          n: list.length,
          margin: finite.length
            ? +(finite.reduce((a2, m) => a2 + m, 0) / finite.length).toFixed(2)
            : 'air',
        };
      }
      findings.push({
        box: { x: +cx.toFixed(1), z: +cz.toFixed(1), w: +w.toFixed(2), d: +d2.toFixed(2), h: b.h },
        rays, holes, ghosts, holesLow, ghostsLow,
        holePct: +(100 * holes / rays).toFixed(1),
        ghostPct: +(100 * ghosts / rays).toFixed(1),
        examples,
        faces: faceStats,
        bands: [...ghostByBand.entries()].sort((a2, b3) => b3[1] - a2[1]).slice(0, 3),
      });
    }
  }
  findings.sort((a, b2) => (b2.holes + b2.ghosts) - (a.holes + a.ghosts));

  // ---------- 2) volumen visual SIN collider (top-down) ----------
  const down = new T.Vector3(0, -1, 0);
  const orphan = [];
  const step = 0.6;
  for (let x = -W.fx + 0.5; x < W.fx; x += step) {
    for (let z = -W.fz + 0.5; z < W.fz; z += step) {
      origin.set(x, 3.4, z);
      caster.set(origin, down);
      caster.far = 3.3;
      const hits = caster.intersectObjects(W.mapGroup.children, true);
      let topY = null, name = '';
      let hasLowVisual = false;
      for (const h of hits) {
        if (!h.object.isMesh || skip(h.object)) continue;
        // marcas pintadas (roofMark, hazard) son planos transparentes sin
        // volumen: no cuentan como "dibujo" que deba tener física
        const mat = Array.isArray(h.object.material)
          ? h.object.material[0] : h.object.material;
        if (mat?.transparent) continue;
        const y = 3.4 - h.distance;
        if (topY === null) {
          if (y > 0.32 && y < 3.0) { topY = y; name = h.object.name || h.object.parent?.name || '?'; }
          else break;
          continue;
        }
        // ¿hay dibujo POR DEBAJO del primer techo? (para distinguir un
        // objeto macizo de un techo hueco transitable)
        if (y > 0.1 && y < 2.05) { hasLowVisual = true; break; }
      }
      // techos huecos de marquesinas/kioscos (tope <=2.3 pero interior
      // vacío): voladizo transitable, no exige collider
      if (topY !== null && topY > 2.02 && !hasLowVisual) topY = null;
      if (topY === null) continue;
      // ¿hay collider/segmento en esta celda a esa altura?
      const p = { x, z };
      const inBox = W.colliders.some((c) => x > c.minx - 0.05 && x < c.maxx + 0.05 &&
        z > c.minz - 0.05 && z < c.maxz + 0.05 && c.h > 0.3);
      const nearSeg = (W.segmentColliders ?? []).some((s) => {
        const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
        const len = Math.hypot(dx, dz) || 1;
        const t = Math.max(0, Math.min(1, ((x - s.a.x) * dx + (z - s.a.z) * dz) / (len * len)));
        const px = s.a.x + dx * t, pz = s.a.z + dz * t;
        return Math.hypot(x - px, z - pz) < 0.5;
      });
      const onZone = (W.surfaceZones ?? []).length > 0 &&
        W.groundHeight({ x, z }, 0.3, 3) > 0.3;
      if (!inBox && !nearSeg && !onZone) {
        if (!shootable(x, Math.min(topY, 1.6) * 0.6, z)) { outOfReach++; continue; }
        orphan.push({ x: +x.toFixed(1), z: +z.toFixed(1), topY: +topY.toFixed(2), name });
      }
    }
  }
  // agrupar huérfanos contiguos para leerlos
  const groups = [];
  for (const o of orphan) {
    const g = groups.find((gr) => Math.hypot(gr.x - o.x, gr.z - o.z) < 2.2);
    if (g) { g.n++; g.maxY = Math.max(g.maxY, o.topY); if (!g.names.includes(o.name)) g.names.push(o.name); }
    else groups.push({ x: o.x, z: o.z, n: 1, maxY: o.topY, names: [o.name] });
  }
  groups.sort((a, b2) => b2.n - a.n);

  return {
    layout, colliders: boxes.length,
    findings: findings.slice(0, 24),
    totalFindings: findings.length,
    orphanGroups: groups.slice(0, 20),
    totalOrphans: orphan.length,
    reach: {
      cells: reachable, total: gx * gz, outOfReach, withinTolerance,
      spawns: spawnPoints.length,
      spawnsReached: spawnPoints.filter((s) => { const [i, j] = cellOf(s.x, s.z); return !Number.isNaN(reach[j * gx + i]); }).length,
    },
  };
}, [LAYOUT, TOL]);

console.log(`=== AUDIT ${report.layout} · ${report.colliders} colliders ===`);
// Lo que se descarta se DICE: cuántas discrepancias quedaron fuera del área
// alcanzable y cuántas dentro de la tolerancia. Si el relleno del área
// alcanzable fallara (pocas celdas, spawns sin alcanzar), descartaría de más
// y la auditoría pasaría en falso: por eso eso mismo es un fallo.
const reachPct = 100 * report.reach.cells / report.reach.total;
console.log(`área alcanzable: ${report.reach.cells}/${report.reach.total} celdas (${reachPct.toFixed(0)}%) · ` +
  `spawns ${report.reach.spawnsReached}/${report.reach.spawns}`);
console.log(`descartadas: ${report.reach.outOfReach} fuera del área alcanzable · ` +
  `${report.reach.withinTolerance} dentro de la tolerancia (${TOL} m)`);
console.log(`\n-- Discrepancias por collider (${report.totalFindings}) --`);
// UMBRAL: por debajo de y2.1 (altura jugable real) no se tolera NINGÚN
// agujero y solo fantasmas marginales. Lo que quede por encima son aleros
// y voladizos de toldos, irrepresentables con cajas que nacen del suelo.
const failures = [];
if (!report.reach.spawns || report.reach.spawnsReached < report.reach.spawns || reachPct < 25) {
  failures.push(`área alcanzable sospechosa (${reachPct.toFixed(0)}% del mapa, spawns ${report.reach.spawnsReached}/${report.reach.spawns}): revisar el relleno antes de fiarse del resultado`);
}
for (const f of report.findings) {
  if (f.holesLow > 0) {
    failures.push(`caja(${f.box.x},${f.box.z}): ${f.holesLow} agujeros bajo y2.1`);
  }
  if (f.ghostsLow > 5 && f.ghostPct > 10) {
    failures.push(`caja(${f.box.x},${f.box.z}): ${f.ghostsLow} fantasmas bajo y2.1 (${f.ghostPct}%)`);
  }
  console.log(`caja(${f.box.x},${f.box.z} ${f.box.w}x${f.box.d} h${f.box.h}) ` +
    `AGUJEROS ${f.holes}/${f.rays} (${f.holePct}%) fantasmas ${f.ghosts} (${f.ghostPct}%)`);
  for (const e of f.examples) console.log(`   · ${e.mesh} @ [${e.at}] miss=${e.miss}`);
  if (f.ghostPct > 8) {
    console.log(`   caras: ${JSON.stringify(f.faces)} bandas-y: ${JSON.stringify(f.bands)}`);
  }
}
console.log(`\n-- Volumen visual SIN collider (${report.totalOrphans} celdas) --`);
for (const g of report.orphanGroups) {
  console.log(`(${g.x},${g.z}) x${g.n} altoMax=${g.maxY} · ${g.names.slice(0, 3).join(', ')}`);
  // techos por encima de 2.3 (interiores huecos de kioscos) no son jugables
  if (g.n >= 2 && g.maxY <= 2.3) {
    failures.push(`huérfano (${g.x},${g.z}) x${g.n} altoMax=${g.maxY} sin collider`);
  }
}

await browser.close();
server.kill();
await clearClip();

if (failures.length) {
  console.log(`\n✗ AUDIT ${report.layout} FALLA (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ AUDIT ${report.layout} OK: sin agujeros ni fantasmas bajo y2.1`);
