// Genera los modelos de mundo y sus iconos desde exactamente las piezas de primera persona.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeapon, WEAPONS, wearOf } from './build-viewmodel-art.mjs';
import { creaseNormals, simplify, weld, writeGLB } from './simplify-soldier-art.mjs';
import { renderWeaponIcon } from './weapon-icon-raster.mjs';
import { PROFILES } from '../src/view/fp/profiles.js';

import { WEAPON_BUILDERS, WEAPON_SCALES, applyEquippedWeaponVisualScale } from '../src/player/rig.js';

const assets = fileURLToPath(new URL('../public/assets/', import.meta.url));
const native = JSON.parse(fs.readFileSync(path.join(assets, 'characters/blender/weapons.json')));
function mountSockets(key) {
  if (native[key]) return native[key].sockets;
  const gun = WEAPON_BUILDERS[key](0);
  applyEquippedWeaponVisualScale(gun, key);
  return Object.fromEntries(['muzzle', 'grip', 'aimSupport', 'mag'].filter(k => gun.userData[k])
    .map(k => [k, gun.userData[k].position.toArray().map((v, i) => v * WEAPON_SCALES[key][i])]));
}
// Longitud del modelo equipado anterior (eje Z, altura Y en las granadas).
// Incluye la escala del montaje. Frag y stun eran modelos procedurales.
const LENGTH = {
  smg: 1.3731, shotgun: 1.7855, pistol: 0.4999, sniper: 2.1051,
  bazooka: 1.5250, grenade: 0.2900, frag: 0.2900, stun: 0.49105,
};

export function buildWorldWeapon(key) {
  const { json, chunks: source } = buildWeapon(key);
  const prims = json.meshes.flatMap(m => m.primitives);
  const meshes = prims.map(p => weld(source[p.attributes.POSITION].data, source[p.indices].data));
  // Cola de error común, sin cruzar material ni pivote. A tres metros, un
  // bisel de dos milímetros ocupa menos de un píxel a 720p.
  const lod = simplify(meshes, { tris: 3500, err: 0.002 });
  const chunks = [];
  let triangles = 0;
  function attr(data, type, componentType, target, count, bounds = {}) {
    chunks.push({ data, target, accessor: { type, componentType, count, ...bounds } });
    return chunks.length - 1;
  }
  for (const [i, p] of prims.entries()) {
    // Una primitiva muy pequeña sigue teniendo su material y su pieza.
    const mesh = lod.prims[i].faces.length ? lod.prims[i] : meshes[i];
    const { P, N, I } = creaseNormals(mesh, 34 * Math.PI / 180);
    const min = [Infinity, Infinity, Infinity], max = min.map(() => -Infinity);
    for (let j = 0; j < P.length; j++) {
      min[j % 3] = Math.min(min[j % 3], P[j]);
      max[j % 3] = Math.max(max[j % 3], P[j]);
    }
    p.attributes = {
      POSITION: attr(P, 'VEC3', 5126, 34962, P.length / 3, { min, max }),
      NORMAL: attr(N, 'VEC3', 5126, 34962, N.length / 3),
      _WEAR: attr(wearOf({ P, N, I }), 'SCALAR', 5126, 34962, P.length / 3),
    };
    p.indices = attr(Uint16Array.from(I), 'SCALAR', 5123, 34963, I.length);
    triangles += I.length / 3;
  }
  // El perfil de cadera asienta la cantonera en el hombro en reposo.
  const stock = json.nodes.find(n => n.name === 'stock');
  if (stock) {
    stock.translation[1] += PROFILES[key].parts.stockRise ?? 0;
    stock.translation[2] -= PROFILES[key].parts.stockFold ?? 0;
  }
  const axis = ['grenade', 'frag'].includes(key) ? 1 : 2;
  let low = Infinity, high = -Infinity;
  for (const node of json.nodes.filter(n => n.mesh != null)) {
    const origin = node.translation?.[axis] ?? 0;
    for (const p of json.meshes[node.mesh].primitives) {
      const a = chunks[p.attributes.POSITION].accessor;
      low = Math.min(low, origin + a.min[axis]);
      high = Math.max(high, origin + a.max[axis]);
    }
  }
  const top = json.nodes[0];
  top.name = key + '_world';
  delete top.extras.fp;
  top.extras.mountSockets = mountSockets(key);
  top.extras.worldScale = LENGTH[key] / (high - low);
  json.asset.extras = { source: json.asset.extras.source, triangles };
  return { json, chunks };
}

export function writeWorldWeapons() {
  const dir = path.join(assets, 'weapons');
  fs.mkdirSync(dir, { recursive: true });
  for (const key of Object.keys(WEAPONS)) {
    const { json, chunks } = buildWorldWeapon(key);
    writeGLB(path.join(dir, key + '.glb'), json, chunks);
    fs.writeFileSync(path.join(assets, 'ui', key + '.png'), renderWeaponIcon(key, json, chunks));
    console.log(key, json.asset.extras.triangles);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeWorldWeapons();
