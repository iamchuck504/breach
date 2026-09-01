// SANITY de decals: simula miles de impactos alrededor de cada objeto de
// los 3 mapas por el camino REAL (effects.impact → gate → decals.add) y
// verifica que CADA decal pintado quede apoyado sobre un mesh visible —
// jamás flotando en el aire. Los impactos cuyo contacto físico cae en aire
// (collider AABB sobresaliendo del mesh) deben quedar SUPRIMIDOS por el
// gate, no pintados. Reporta también la tasa de supresión por caja como
// diagnóstico de colliders sobredimensionados.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
import { CHROME } from './lib-chrome.mjs';

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8801', '--strictPort'], { stdio: 'ignore' });
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

await page.goto('http://localhost:8801/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-practice').click());
await page.waitForTimeout(2200);

for (const layout of ['calle', 'azoteas', 'fortaleza']) {
  const r = await page.evaluate(async (layout) => {
    const W = window.BREACH_WORLD, E = window.BREACH_EFFECTS, T = window.THREE;
    const G = window.BREACH;
    for (const d of G.dummies?.list ?? []) { d.alive = false; d.respawnT = 9999; }
    W.setLayout(layout, true);
    await new Promise((r2) => setTimeout(r2, 400));

    // hook: capturar cada decal que el pool acepte
    const placed = [];
    const oldAdd = E.decals.add.bind(E.decals);
    E.decals.add = (point, normal, surface, sizeScale) => {
      placed.push({ p: point.clone?.() ?? new T.Vector3(point.x, point.y, point.z),
        n: { x: normal.x, y: normal.y, z: normal.z } });
      return oldAdd(point, normal, surface, sizeScale);
    };

    const caster = new T.Raycaster();
    caster.camera = window.BREACH_CAM;
    // ¿el punto está apoyado en un mesh visible? (retro-raycast por la normal)
    const seated = (p, n) => {
      const from = new T.Vector3(p.x + n.x * 0.25, p.y + n.y * 0.25, p.z + n.z * 0.25);
      caster.set(from, new T.Vector3(-n.x, -n.y, -n.z));
      caster.far = 0.55;
      const hits = caster.intersectObjects(W.mapGroup.children, true);
      for (const h of hits) {
        if (!h.object.isMesh) continue;
        if (Math.abs(h.distance - 0.25) < 0.15) return true;
      }
      return false;
    };

    const origin = new T.Vector3(), dir = new T.Vector3();
    const boxes = W.colliders.filter((c) => (c.maxx - c.minx) <= 12 && (c.maxz - c.minz) <= 12);
    let impacts = 0, painted = 0, suppressed = 0;
    const floating = [];
    const suppressStats = new Map();
    for (const b of boxes) {
      const w = b.maxx - b.minx, d2 = b.maxz - b.minz;
      const cx = (b.minx + b.maxx) / 2, cz = (b.minz + b.maxz) / 2;
      const top = Math.min(b.h + 0.3, 2.3);
      let boxSuppressed = 0, boxImpacts = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const span = (dx !== 0 ? d2 : w) + 0.8;
        const dist = 3.0 + (dx !== 0 ? w : d2) / 2;
        for (let y = 0.25; y <= top; y += 0.35) {
          for (let u = -span / 2; u <= span / 2; u += 0.4) {
            origin.set(cx - dx * dist + (dz !== 0 ? u : 0), y,
              cz - dz * dist + (dx !== 0 ? u : 0));
            dir.set(dx, 0, dz);
            const contact = W.raycastHit(origin, dir, dist * 2);
            if (!contact || !contact.normal) continue;
            const point = origin.clone().addScaledVector(dir, contact.t);
            impacts++; boxImpacts++;
            const before = placed.length;
            E.impact(point, contact.normal, contact.surface, { origin: origin.clone() });
            if (placed.length > before) {
              painted++;
              const dec = placed[placed.length - 1];
              if (!seated(dec.p, dec.n)) {
                if (floating.length < 8) {
                  floating.push({
                    at: [+dec.p.x.toFixed(2), +dec.p.y.toFixed(2), +dec.p.z.toFixed(2)],
                    box: `${cx.toFixed(1)},${cz.toFixed(1)}`,
                  });
                } else floating.push(1);
              }
            } else { suppressed++; boxSuppressed++; }
          }
        }
      }
      if (boxSuppressed / Math.max(1, boxImpacts) > 0.5) {
        suppressStats.set(`${cx.toFixed(1)},${cz.toFixed(1)} ${w.toFixed(1)}x${d2.toFixed(1)}`,
          +(100 * boxSuppressed / boxImpacts).toFixed(0));
      }
    }
    E.decals.add = oldAdd;
    return {
      impacts, painted, suppressed,
      floating: floating.length,
      floatingExamples: floating.slice(0, 8),
      overSuppressed: [...suppressStats.entries()].slice(0, 8),
    };
  }, layout);

  check(`${layout}: CERO decals flotando en el aire (${r.painted} pintados de ${r.impacts})`,
    r.floating === 0,
    r.floating ? JSON.stringify(r.floatingExamples) : `suprimidos-aire=${r.suppressed}`);
  if (r.overSuppressed.length) {
    console.log(`   (diagnóstico ${layout}: cajas con >50% supresión — collider muy holgado:`);
    for (const [k, v] of r.overSuppressed) console.log(`    · ${k} → ${v}%`);
  }
}

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nDECAL-FLOAT: todo verde');
await browser.close();
server.kill();
await clearClip();
process.exit(fails.length ? 1 : 0);
