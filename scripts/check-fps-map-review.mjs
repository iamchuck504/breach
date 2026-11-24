// Los tres mapas a la altura de los OJOS FPS (PEDIDO §18.3/§18.5/§18.17; PRUEBAS,
// corrida 6). Convierte en comprobación las medidas de scripts/fp-map-review.mjs
// (MAPAS), que usan las mismas piezas que el juego: World real sin mallas,
// firstMapIntersection del servidor y eyeWorld/hitPose. Sustituye la garantía
// de check-rooftop-cover / check-storefront-cover de "la cobertura tapa de
// verdad" (antes con la cobertura pegada) por la regla FPS en cada cara real:
//  - el cliente y el servidor coinciden en la línea de visión (0 discrepancias);
//  - toda cara LOW tapa a un jugador AGACHADO detrás y toda cara MID a uno DE PIE;
//  - el ojo nunca queda al otro lado de una pared en ninguna postura (asomo,
//    inclinación) ni dentro de la geometría;
//  - techos: la cabeza no roza y siempre se puede levantar;
//  - trepar (solo LOW) no abre zonas nuevas (las líneas de vista de los mapas
//    aprobados no cambian);
//  - el spawn no se ve desde la mitad rival (≤ 1 % de sus celdas).
// Node puro (~20 s, --quick como recomienda MAPAS).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { review, headlessWorld } from './fp-map-review.mjs';
import { eyeWorld } from '../src/combat/hit-pose.js';

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };
for (const layout of ['fortaleza', 'azoteas', 'calle2']) {
  const r = review(layout, { quick: true });
  const tag = (s) => `${layout}: ${s}`;
  check(r.losCheck.mismatch === 0, tag(`línea de visión cliente≠servidor en ${r.losCheck.mismatch}/${r.losCheck.checked}`));
  check(r.spawn.seenFromEnemyHalfPct <= 1, tag(`spawn visto desde el ${r.spawn.seenFromEnemyHalfPct}% de la mitad rival`));
  check(r.cover.low.leaky.length === 0, tag(`LOW que no tapa agachado: ${JSON.stringify(r.cover.low.leaky)}`));
  check(r.cover.mid.leaky.length === 0, tag(`MID que no tapa de pie: ${JSON.stringify(r.cover.mid.leaky)}`));
  check(r.poke.eyeInside === 0 && r.poke.eyeThrough === 0, tag(`ojo dentro/al otro lado de la geometría: ${JSON.stringify(r.poke.list)}`));
  check(r.ceilings.headClip.length === 0 && r.ceilings.cantStand.length === 0,
    tag(`techos: cabeza roza ${r.ceilings.headClip.length}, no se puede levantar ${r.ceilings.cantStand.length}`));
  check(r.mantle.newArea.length === 0, tag(`trepar abre ${r.mantle.newArea.length} zonas nuevas`));
  console.log(`${layout}: LOS ${r.losCheck.mismatch}/${r.losCheck.checked} · spawn ${r.spawn.seenFromEnemyHalfPct}% · LOW ${r.cover.low.leaky.length}/${r.cover.low.faces} · MID ${r.cover.mid.leaky.length}/${r.cover.mid.faces} · ojo ${r.poke.eyeThrough}/${r.poke.tested} · trepar ${r.mantle.ok}/${r.mantle.samples}`);
}
// Barandilla del deck de Azoteas apuntando hacia ABAJO (traslado de check-blindfire
// "barandilla, cabeceo descendente"): de pie o asomado (ce 1 + ADS) junto a la
// barandilla LOW del deck, un tiro desde el OJO con cabeceo −0.28 rad pasa por
// encima de la barandilla (el primer impacto queda más allá de su plano).
{
  const W = headlessWorld('azoteas');
  const rails = W.faces.filter((f) => (f.baseY ?? 0) > 0.5 && Math.abs(f.h - 1.1) < 0.01 && Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z) > 1);
  let tested = 0;
  for (const f of rails) {
    const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2, y = f.baseY;
    const px = mx + f.n.x * 0.42, pz = mz + f.n.z * 0.42, yaw = Math.atan2(f.n.x, f.n.z); // de cara a la barandilla
    for (const pose of [{ st: 'idle', aim: true, wep: 'smg' }, { st: 'crouch', aim: true, ce: 1, wep: 'smg' }]) {
      const e = eyeWorld({ ...pose, p: -0.28, pitch: -0.28 }, px, y, pz, yaw);
      const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(-0.28), Math.sin(-0.28), -Math.cos(yaw) * Math.cos(-0.28));
      const t = W.raycast(new THREE.Vector3(...e), dir, 30);
      const along = (e[0] - mx) * f.n.x + (e[2] - mz) * f.n.z; // distancia del ojo al plano de la barandilla
      tested++;
      check(t === null || t * Math.hypot(dir.x, dir.z) > along + 0.05,
        `azoteas: tiro hacia abajo desde ${pose.st} pega la barandilla del deck (${[mx, mz].map((v) => v.toFixed(1))}, t=${t})`);
    }
  }
  check(tested >= 8, `azoteas: pocas barandillas de deck probadas (${tested})`);
  console.log(`azoteas: barandilla del deck con cabeceo −0.28 · ${tested} casos`);
}
// EXCEPCIONES EXPLÍCITAS de fp-map-review (MAPAS, revisadas por PRUEBAS el 2026-11-20):
// 1) La herramienta solo juzga caras de cobertura de ≥ 1.2 m. Una testa de 0.9 m de
//    un bloque LOW no promete tapar un cono de 60° (lo tapa su costado largo, que sí
//    se juzga). Verificado: las dos "fugas" (fortaleza −26.5,−33.4; calle2 ±7.7,±33.4)
//    eran testas de 0.90 m de bloques de 2.6×0.9 y 2.4×0.9 m. Para que la regla no
//    pueda esconder una fuga real tras una edición de mapa: (a) el número de caras
//    excluidas por mapa está CONGELADO; (b) cada cara excluida debe ser la testa de
//    un bloque cuyo costado largo (≥ 1.2 m) sí se juzga.
// 2) El sondeo del ojo resuelve el cuerpo como el juego (resolveCircle contra TODAS las
//    cajas). En el carrito de café de calle2 la tapa (1.21 m) es 1 cm más ancha que su
//    base LOW: sin resolver, el sondeo quedaba 1 cm dentro y el ojo "atravesaba". Se
//    afirma que el cuerpo resuelto es el que se mide y que desde ahí el ojo no atraviesa.
{
  const EXCLUDED = { fortaleza: 84, azoteas: 96, calle2: 24 }; // caras LOW/MID < 1.2 m (medido 2026-11-20)
  const R = 0.38;
  for (const layout of Object.keys(EXCLUDED)) {
    const W = headlessWorld(layout);
    const len = (f) => Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
    const cover = W.faces.filter((f) => f.kind === 'low' || f.kind === 'mid');
    const short = cover.filter((f) => len(f) < 1.2);
    check(short.length === EXCLUDED[layout], `${layout}: caras excluidas por la regla de 1.2 m = ${short.length} (congeladas ${EXCLUDED[layout]}): revisar cada cara nueva antes de actualizar`);
    const orphan = short.filter((f) => !f.collider || !cover.some((g) => g !== f && g.collider === f.collider && len(g) >= 1.2));
    check(orphan.length === 0, `${layout}: ${orphan.length} caras cortas que no son testa de un bloque con costado largo juzgado: ${JSON.stringify(orphan.slice(0, 4).map((f) => [f.a, f.b]))}`);
    console.log(`${layout}: ${short.length} caras de cobertura < 1.2 m excluidas (todas testas de bloques con costado juzgado: ${orphan.length === 0})`);
  }
  const C2 = headlessWorld('calle2');
  for (const [x, z, yaw] of [[13.29, -12.19, 225], [-13.29, 12.01, 45]]) {
    const q = { x, z }; C2.resolveCircle(q, R, 0);
    const moved = Math.hypot(q.x - x, q.z - z);
    check(moved > 0.005, `calle2 carrito (${x}, ${z}): el sondeo ya no queda dentro de la tapa (desplazamiento ${moved.toFixed(3)} m): revisar la excepción`);
    const e = eyeWorld({ st: 'crouch', ce: 0, cl: -1 }, q.x, 0, q.z, yaw * Math.PI / 180);
    const d = new THREE.Vector3(e[0] - q.x, 0, e[2] - q.z), L = d.length();
    const through = L > 1e-4 && C2.raycast(new THREE.Vector3(q.x, e[1], q.z), d.normalize(), L) !== null;
    check(!through, `calle2 carrito (${x}, ${z}): desde el cuerpo RESUELTO el ojo atraviesa la geometría`);
  }
}
for (const f of fails) console.error('FALLO:', f);
assert.equal(fails.length, 0, `${fails.length} fallos de mapas a la altura de los ojos`);
console.log('FPS MAP REVIEW OK · fortaleza, azoteas, calle2');
