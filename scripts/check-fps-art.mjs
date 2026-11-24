// Arte del arma en primera persona (scripts/build-viewmodel-art.mjs):
//  · los GLB de public/assets/fp/ traen las piezas, las anclas y los dedos;
//  · presupuesto: arma + brazos ≤ 45 000 triángulos;
//  · regenerar da EXACTAMENTE los mismos bytes (determinista, y el archivo
//    del repositorio está al día con el script);
//  · la línea de mira es recta (alza y guion a la misma altura) y los
//    pivotes caen dentro de su pieza.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, writeGLB } from './simplify-soldier-art.mjs';
import { buildWeapon, buildArms, buildKickLeg, WEAPONS } from './build-viewmodel-art.mjs';

// Decisión 20: GLB completos, detalle de primer plano y manos articuladas del soldado.
const MAX_VM_TRIANGLES = 45_000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FP = path.join(root, 'public/assets/fp');
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-art-'));

const trisOf = (json, accessor) => {
  let t = 0;
  for (const m of json.meshes) for (const p of m.primitives) t += accessor(p.indices).length / 3;
  return t;
};
const REQUIRED_ANCHORS = ['muzzle', 'grip', 'forend', 'mag', 'sight_rear', 'sight_front', 'eject'];
let budget = 0, worstWeapon = 0; // presupuesto: el arma más pesada + brazos

for (const key of Object.keys(WEAPONS)) {
  const file = path.join(FP, `${key}.glb`);
  ok(fs.existsSync(file), `${key}.glb existe`);
  if (!fs.existsSync(file)) continue;
  const { json, accessor } = readGLB(file);
  const top = json.nodes[0];
  const names = json.nodes.map((n) => n.name);
  for (const part of Object.keys(WEAPONS[key].pivots)) {
    const n = json.nodes.find((x) => x.name === part);
    ok(n && n.mesh != null, `${key}: pieza ${part} con malla`);
  }
  for (const a of REQUIRED_ANCHORS) {
    ok(names.includes(`anchor_${a}`) && Array.isArray(top.extras?.sockets?.[a]), `${key}: ancla ${a}`);
  }
  const s = top.extras.sockets;
  ok(Math.abs(s.sight_rear[1] - s.sight_front[1]) < 1e-6 && Math.abs(s.sight_rear[0]) < 1e-6 && Math.abs(s.sight_front[0]) < 1e-6,
    `${key}: línea de mira recta y centrada`);
  ok(s.sight_front[2] < s.sight_rear[2] && s.muzzle[2] < s.sight_front[2], `${key}: alza → guion → boca hacia -z`);
  const t = trisOf(json, accessor);
  worstWeapon = Math.max(worstWeapon, t);
  // Se conservan los biseles del original, excepto las islas sustituidas.
  ok(t > (WEAPONS[key].replace ? 5500 : json.asset.extras.sourceTris), `${key}: ${t} triángulos`);
  ok(json.materials.length >= 6 && json.materials.every((m) => m.pbrMetallicRoughness), `${key}: materiales PBR originales (${json.materials.length})`);
  const emissive = 'KHR_materials_emissive_strength';
  ok(json.materials.some(m => m.extensions?.[emissive]) && json.extensionsUsed?.includes(emissive),
    `${key}: intensidad emisiva original declarada al cargador GLTF`);
  // desgaste por vértice presente y en rango
  let wearMax = 0;
  for (const m of json.meshes) for (const p of m.primitives) for (const w of accessor(p.attributes._WEAR)) wearMax = Math.max(wearMax, w);
  ok(wearMax > 0.5 && wearMax <= 1, `${key}: atributo de desgaste (_WEAR máx ${wearMax.toFixed(2)})`);
  // bytes estables
  const r = buildWeapon(key);
  const out = path.join(tmp, `${key}.glb`);
  writeGLB(out, r.json, r.chunks);
  ok(Buffer.compare(fs.readFileSync(out), fs.readFileSync(file)) === 0, `${key}: regenerar da los mismos bytes`);
}

{
  const file = path.join(FP, 'arms.glb');
  ok(fs.existsSync(file), 'arms.glb existe');
  const { json, accessor } = readGLB(file);
  const names = new Set(json.nodes.map((n) => n.name));
  for (const side of ['R', 'L']) {
    for (const n of [`upper_arm_${side}`, `forearm_${side}`, `anatomica_${side}`]) ok(names.has(n), `brazos: ${n}`);
    const hand = json.nodes.find((n) => n.name === `anatomica_${side}`);
    const g = hand.extras?.grip;
    const upper = json.nodes.find(n => n.name === `upper_arm_${side}`);
    const shell = upper.children.map(i => json.nodes[i]).find(n => n.name === `pauldron_${side}`);
    ok(shell?.mesh != null, `brazos: hombrera original en el pivote del hombro ${side}`);
    ok(g?.wrist?.length === 3 && g.wrist.every(Number.isFinite) && hand.extras.bones[0].name === 'wrist',
      `brazos: bocamanga esculpida del guante ${side}`);
    ok(g && g.center.length === 3 && Math.abs(Math.hypot(...g.axis) - 1) < 1e-3 && Math.abs(Math.hypot(...g.palm) - 1) < 1e-3, `brazos: marco de agarre ${side}`);
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      const segs = hand.extras.bones.filter(b => b.name.startsWith(f) && b.name.includes('phalanx'));
      ok(segs.length === (f === 'thumb' ? 2 : 3), `brazos: ${side} ${f} con ${segs.length} falanges`);

    }
  }
  ok(names.has('grenade'), 'brazos: bote para el lanzamiento');
  const t = trisOf(json, accessor);
  budget += t;
  ok(t > 0 && t + worstWeapon <= MAX_VM_TRIANGLES, `brazos: ${t} triángulos`);
  const r = await buildArms();
  const moldes = fs.readFileSync(path.join(root, 'src/view/fp/hand/punos.json'), 'utf8');
  ok(moldes === JSON.stringify(r.punos) + '\n', 'ambos puños del banco reproducen las islas del soldado');
  const out = path.join(tmp, 'arms.glb');
  writeGLB(out, r.json, r.chunks);
  ok(Buffer.compare(fs.readFileSync(out), fs.readFileSync(file)) === 0, 'brazos: regenerar da los mismos bytes');
}
budget += worstWeapon;
ok(budget <= MAX_VM_TRIANGLES, `presupuesto (arma más pesada + brazos): ${budget} ≤ ${MAX_VM_TRIANGLES} triángulos`);
{
  const file = path.join(FP, 'kick-leg.glb');
  const leg = buildKickLeg(), copy = path.join(tmp, 'kick-leg.glb');
  writeGLB(copy, leg.json, leg.chunks);
  ok(fs.readFileSync(copy).equals(fs.readFileSync(file)), 'pierna: regenerar desde el soldado da los mismos bytes');
  ok(budget + leg.report.tris <= MAX_VM_TRIANGLES, `patada con el arma más pesada: ${budget + leg.report.tris} triángulos`);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (fail) { console.log(`\n${fail} fallo(s)`); process.exit(1); }
console.log('\ncheck-fps-art: todo bien');
