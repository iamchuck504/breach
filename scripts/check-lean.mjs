// Inclinarse (Q/E) en orillas REALES de los mapas: la cabeza no entra en la
// geometría y el ojo (origen del tiro) queda fuera de muros y fachadas.
// PRUEBAS (corrida 6, FPS). Sustituye a:
//  - check-lean vieja (cambio de hombro de la cámara al asomarse de una
//    cobertura alta pegada; ya no hay cámara de hombro jugando);
//  - check-alley-peek y check-facade-peek (la BOCA del rig no salía dentro de
//    las fachadas de calle2 al asomarse; el tiro ahora sale del ojo);
//  - check-blind-protection en su parte viva (cañón/cabeza sin obstrucción en
//    la orilla, alto y bajo, varias armas y cabeceos).
// check-fps-movement ya barre la esfera de cabeza contra paredes sintéticas;
// aquí la misma regla contra los colisionadores y las mallas visuales de
// calle2 (fachadas District_/Existing_envelope) y fortaleza.
// Sin bucle de juego: módulos cargados del dev server (BASE) y pasos fijos de
// 1/60 s, así que no depende del reloj ni de la GPU.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';
import { DEV_BASE } from './lib-test.mjs';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(DEV_BASE + '/?nolock=1');
  const report = await page.evaluate(async () => {
    const T = await import('/node_modules/three/build/three.module.js');
    const { World } = await import('/src/world/world.js');
    const { Controller, PLAYER_R } = await import('/src/player/controller.js');
    const { localPose } = await import('/src/net/client.js');
    const { eyeWorld, hitFields, HEAD_R } = await import('/src/combat/hit-pose.js');
    const { preloadUrbanAssets } = await import('/src/world/urban-assets.js');
    await preloadUrbanAssets();
    const out = { maps: {}, fails: [] };
    for (const layout of ['calle2', 'fortaleza']) {
      const scene = new T.Scene(), w = new World(scene, layout);
      w.mapGroup?.updateMatrixWorld(true);
      const visual = layout === 'calle2'
        ? w._getImpactReceivers().filter((m) => /District_|Existing_envelope/.test(m.name)) : [];
      // orillas: caras ALTAS (no se ve por encima) o con margen de asomo de calle2
      const faces = w.faces.filter((f) => (f.h >= 1.9 || f.peekMargin) &&
        Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z) >= 1.2 && Math.abs(f.a.z) < 60 && Math.abs(f.a.x) < 60);
      let cases = 0, leaned = 0;
      const ray = new T.Raycaster();
      const O = new T.Vector3(), D = new T.Vector3();
      for (const face of faces) {
        const tx = face.b.x - face.a.x, tz = face.b.z - face.a.z, len = Math.hypot(tx, tz);
        const ux = tx / len, uz = tz / len;
        for (const [edge, u] of [['a', 0.5], ['b', len - 0.5]]) {
          const gap = Math.max(PLAYER_R + 0.02, face.standOff ?? 0);
          const x = face.a.x + ux * u + face.n.x * gap, z = face.a.z + uz * u + face.n.z * gap;
          if (w.groundHeight({ x, z }, PLAYER_R, 0) > 0.05) continue; // solo suelo de calle/patio
          const probe = { x, z }; w.resolveCircle(probe, PLAYER_R, 0);
          if (Math.hypot(probe.x - x, probe.z - z) > 0.05) continue; // sin sitio para estar ahí
          const yaw = Math.atan2(face.n.x, face.n.z); // mirando a la cara
          const cam = { yaw, pitch: 0,
            flatForward() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; },
            flatRight() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; } };
          const right = cam.flatRight();
          // hacia la orilla en el marco de la vista
          const toEdge = Math.sign((edge === 'a' ? -1 : 1) * (ux * right.x + uz * right.z)) || 1;
          for (const crouch of [false, true]) for (const aim of [false, true]) for (const side of [toEdge, -toEdge]) {
            for (const pitch of [0, -0.45]) {
              const p = new Controller(w, cam);
              p.respawn({ x, z, yaw }); cam.yaw = yaw; cam.pitch = pitch;
              const input = { moveVec: () => ({ x: 0, z: 0 }), aimHeld: aim, sprintHeld: false, jumpPressed: false,
                meleePressed: false, crouchHeld: crouch, crouchPressed: false, leanAxis: side };
              // un cuadro del juego: movimiento y después settle() (main.js lo llama tras el
              // empujón entre cuerpos; aquí no hay otros cuerpos)
              for (let i = 0; i < 60; i++) { p.update(1 / 60, input, false); p.settle?.(); }
              cases++;
              const pose = localPose(p, 'smg', 1000 + cases);
              const eye = eyeWorld({ ...pose, ae: 0 }, p.pos.x, p.y, p.pos.z, p.yaw);
              const hf = hitFields(pose, p.pos.x, p.y, p.pos.z, p.yaw).hit;
              const head = hf ? [hf.hx, hf.hy, hf.hz] : eye;
              const tag = { layout, face: [face.a, face.b].map((q) => [+q.x.toFixed(2), +q.z.toFixed(2)]), edge, crouch, aim, side, pitch, lean: +p.lean.toFixed(2) };
              // 1) del eje del cuerpo (a la altura de la cabeza) al borde de la esfera: nada
              const sx = head[0] - p.pos.x, sz = head[2] - p.pos.z, sl = Math.hypot(sx, sz);
              const reach = sl + HEAD_R * 0.98;
              if (sl > 1e-4) {
                O.set(p.pos.x, head[1], p.pos.z); D.set(sx / sl, 0, sz / sl);
                if (w.raycast(O, D, reach) !== null) out.fails.push({ why: 'cabeza dentro de un colisionador', ...tag });
                if (visual.length) {
                  ray.set(O, D); ray.near = 0; ray.far = reach;
                  const hit = ray.intersectObjects(visual, false)[0];
                  if (hit) out.fails.push({ why: `cabeza dentro de ${hit.object.name}`, d: +hit.distance.toFixed(3), ...tag });
                }
              }
              // 2) el ojo (origen del tiro) visto desde el centro de la cabeza: libre
              const ex = eye[0] - head[0], ey = eye[1] - head[1], ez = eye[2] - head[2], el = Math.hypot(ex, ey, ez);
              if (el > 1e-4) {
                O.set(head[0], head[1], head[2]); D.set(ex / el, ey / el, ez / el);
                if (w.raycast(O, D, el) !== null) out.fails.push({ why: 'ojo tras geometría desde su cabeza', ...tag });
              }
              // 3) hacia la orilla hay sitio: la inclinación ocurre (al otro lado no se exige)
              if (side === toEdge) {
                if (Math.abs(p.lean) > 0.9) leaned++;
                else {
                  // ¿la orilla está LIBRE? La cabeza inclinada al máximo (cl = ±1, misma pose
                  // que viaja) no debe encontrar nada entre el eje del cuerpo y su borde.
                  const full = hitFields({ ...pose, cl: side }, p.pos.x, p.y, p.pos.z, p.yaw).hit;
                  let blocker = null;
                  if (full) {
                    // esfera de cabeza a inclinación máxima contra cada caja (2 cm = margen del controlador)
                    for (const c of w.colliders) {
                      if (c.moveOnly) continue;
                      const dx = Math.max(c.minx - full.hx, 0, full.hx - c.maxx), dz = Math.max(c.minz - full.hz, 0, full.hz - c.maxz);
                      const dy = Math.max((c.minY ?? 0) - full.hy, 0, full.hy - c.h);
                      if (Math.hypot(dx, dy, dz) < full.hr + 0.02) { blocker = `esfera toca x[${c.minx.toFixed(2)},${c.maxx.toFixed(2)}] z[${c.minz.toFixed(2)},${c.maxz.toFixed(2)}] h ${c.h}`; break; }
                    }
                  }
                  if (full && !blocker) {
                    const fx = full.hx - p.pos.x, fz = full.hz - p.pos.z, fl = Math.hypot(fx, fz);
                    O.set(p.pos.x, full.hy, p.pos.z); D.set(fx / fl, 0, fz / fl);
                    const h = w.raycastHit?.(O, D, fl + HEAD_R) ?? (w.raycast(O, D, fl + HEAD_R) !== null ? {} : null);
                    if (h) { const c = h.collider; blocker = c ? `colisionador x[${c.minx?.toFixed(2)},${c.maxx?.toFixed(2)}] z[${c.minz?.toFixed(2)},${c.maxz?.toFixed(2)}] h ${c.h}` : 'colisionador'; }
                    else if (visual.length) {
                      ray.set(O, D); ray.near = 0; ray.far = fl + HEAD_R;
                      const hv = ray.intersectObjects(visual, false)[0];
                      if (hv) blocker = `malla ${hv.object.name}`;
                    }
                  }
                  if (blocker) (out.blocked ??= []).push({ ...tag, blocker, at: [+p.pos.x.toFixed(2), +p.pos.z.toFixed(2)] });
                  else out.fails.push({ why: 'no se inclina hacia la orilla LIBRE', at: [+p.pos.x.toFixed(2), +p.pos.z.toFixed(2)], ...tag });
                }
              }
              if (p.state !== (crouch ? 'crouch' : 'idle')) out.fails.push({ why: `estado ${p.state}`, ...tag });
            }
          }
        }
      }
      out.maps[layout] = { faces: faces.length, cases, leanedToEdge: leaned, visualMeshes: visual.length };
    }
    return out;
  });
  const fsx = await import('node:fs');
  fsx.writeFileSync('/tmp/check-lean-blocked.json', JSON.stringify({ blocked: report.blocked ?? [], fails: report.fails }, null, 1));
  const blockedBy = {};
  for (const b of report.blocked ?? []) { const k = `${b.layout}`; blockedBy[k] = (blockedBy[k] ?? 0) + 1; }
  console.log('ORILLA NO LIBRE (excluidos por precondición)', JSON.stringify(blockedBy));
  console.log(JSON.stringify(report.maps));
  const byWhy = {};
  for (const f of report.fails) { const k = `${f.layout} · ${f.why.replace(/ [A-Z][\w-]*$/, '')} · ${f.crouch ? 'agachado' : 'de pie'}${f.aim ? ' ADS' : ''}`; byWhy[k] = (byWhy[k] ?? 0) + 1; }
  if (report.fails.length) console.log('FALLOS POR TIPO', JSON.stringify(byWhy));
  for (const f of report.fails.slice(0, 8)) console.log('FAIL', JSON.stringify(f));
  assert.ok(report.maps.calle2?.cases >= 100 && report.maps.fortaleza?.cases >= 100,
    `pocos casos: ${JSON.stringify(report.maps)}`);
  assert.ok(report.maps.calle2.visualMeshes > 0, 'calle2 sin mallas de fachada que medir');
  // PRECONDICIÓN "orilla libre" (PRUEBAS, revisada caso a caso el 2026-11-20): un caso
  // solo exige inclinación completa si la cabeza inclinada al máximo cabe (esfera +
  // 2 cm de margen del controlador, colisionadores y fachadas). Los 46 casos que no
  // cumplen se inspeccionaron contra la geometría real: postes de 2.28 m junto a las
  // caras de z ±29.8 de calle2 (16), esquinas con los muros z ±41.92 y el límite del
  // mapa x ±40.8 / edificios x ±29 (12 con el camino lateral tapado + 12 en que la
  // esfera entra 2–3 cm en el muro perpendicular), el pasillo de 0.8 m del pilar
  // x ±39.2 (4) y la torre de fortaleza en (±23.6, ±29.2) junto a las caras x ±21.8 (2).
  // El número queda CONGELADO: una edición de mapa o de la inclinación que cambie
  // cuántos casos se excluyen debe revisarse caso a caso antes de tocarlo.
  const EXCLUDED = { calle2: 44, fortaleza: 2 };
  for (const [m, n] of Object.entries(EXCLUDED)) {
    const got = (report.blocked ?? []).filter((b) => b.layout === m).length;
    assert.equal(got, n, `${m}: ${got} casos sin orilla libre (congelados ${n}); revisar /tmp/check-lean-blocked.json`);
  }
  assert.equal(report.fails.length, 0, `${report.fails.length} fallos de inclinación en orillas reales`);
  assert.equal(errors.length, 0, `errores de página: ${errors.join(' | ')}`);
  console.log('LEAN (orillas reales) OK');
} finally {
  await browser.close();
}
