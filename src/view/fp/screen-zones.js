// En cada pieza rígida muchos triángulos comparten vértices. Se indexan una
// vez para proyectar cada posición una sola vez por cuadro.
import { Matrix4, Vector3 } from 'three';

const indexed = new WeakMap();
function partsOf(mesh) {
  const geometry = mesh.geometry;
  if (indexed.has(geometry)) return indexed.get(geometry);
  const { position, skinIndex } = geometry.attributes;
  const parts = mesh.skeleton.bones.map(() => ({ points: [], indices: [], lookup: new Map() }));
  for (let i = 0; i < position.count; i++) {
    const joint = skinIndex.getX(i), root = geometry.userData.skinRoots?.[joint];
    const part = parts[root ?? joint];
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const key = root === undefined ? [x, y, z].join(',') : [x, y, z,
      ...Array.from({ length: 4 }, (_, k) => [skinIndex.getComponent(i,k), geometry.attributes.skinWeight.getComponent(i,k)])].join(',');
    let index = part.lookup.get(key);
    if (index === undefined) {
      index = part.points.length;
      part.lookup.set(key, index);
      part.points.push(new Vector3(x, y, z));
      if (root !== undefined) (part.skin ??= []).push(i);
    }
    part.indices.push(index);
  }
  for (const part of parts) {
    delete part.lookup;
    part.clip = part.points.map(() => new Vector3());
    part.codes = new Uint8Array(part.points.length);
  }
  indexed.set(geometry, parts);
  return parts;
}

// Coordenadas homogéneas (x, y, w). El shader comprime z, de modo que
// los bordes visibles los deciden los cuatro planos laterales.
const planes = [v => v.z + v.x, v => v.z - v.x, v => v.z + v.y, v => v.z - v.y];
function include(rect, v) {
  if (v.z <= 0) return;
  const x = 0.5 + 0.5 * v.x / v.z, y = 0.5 - 0.5 * v.y / v.z;
  rect.x0 = Math.min(x, rect.x0); rect.y0 = Math.min(y, rect.y0);
  rect.x1 = Math.max(x, rect.x1); rect.y1 = Math.max(y, rect.y1);
}
function includeClipped(rect, polygon, mask) {
  for (let i = 0; i < planes.length && polygon.length; i++) {
    if (!(mask & (1 << i))) continue;
    const distance = planes[i], next = [];
    let a = polygon.at(-1), da = distance(a);
    for (const b of polygon) {
      const db = distance(b);
      if ((da < 0) !== (db < 0)) next.push(a.clone().lerp(b, da / (da - db)));
      if (db >= 0) next.push(b);
      a = b; da = db;
    }
    polygon = next;
  }
  for (const p of polygon) include(rect, p);
}

const transform = new Matrix4();
export function meshScreenRect(mesh, inverseRoot, projection, bones) {
  if (!mesh.visible) return null;
  const parts = partsOf(mesh);
  const rect = { x0: 1, y0: 1, x1: 0, y1: 0 };
  for (const index of bones) {
    const bone = mesh.skeleton.bones[index];
    if (bone.scale.x === 0) continue;
    transform.multiplyMatrices(inverseRoot, bone.matrixWorld);
    const { points, clip, codes, indices, skin } = parts[index];
    if (skin) transform.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    let outside = 0, common = 15;
    for (let i = 0; i < points.length; i++) {
      const v = clip[i];
      if (skin) mesh.getVertexPosition(skin[i], v);
      else v.copy(points[i]);
      v.applyMatrix4(transform);
      v.set(v.x * projection.elements[0], v.y * projection.elements[5], -v.z);
      const code = (v.x < -v.z ? 1 : 0) | (v.x > v.z ? 2 : 0) |
        (v.y < -v.z ? 4 : 0) | (v.y > v.z ? 8 : 0);
      codes[i] = code;
      outside |= code; common &= code;
      if (!code) include(rect, v);
    }
    if (!outside || common) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const mask = codes[a] | codes[b] | codes[c];
      if (mask && !(codes[a] & codes[b] & codes[c])) includeClipped(rect, [clip[a], clip[b], clip[c]], mask);
    }
  }
  if (rect.x0 >= rect.x1 || rect.y0 >= rect.y1) return null;
  rect.x0 = Math.max(0, rect.x0); rect.y0 = Math.max(0, rect.y0);
  rect.x1 = Math.min(1, rect.x1); rect.y1 = Math.min(1, rect.y1);
  return rect;
}

// Caja en el cuadro original, con margen para la piel alrededor de los huesos.
export function cajaManos(vm, proyeccion, lados, ancho, alto) {
  const puntos = [];
  const zoom = vm.prof.scope ? vm.ocular.aumento.value : 1;
  for (const lado of lados) {
    const visibles = [];
    for (const h of vm.arms.anatomy[lado].joints) {
      const p = vm.root.worldToLocal(h.getWorldPosition(new Vector3()));
      if (p.z >= -.001) continue;
      p.applyMatrix4(proyeccion);
      visibles.push([(1 + p.x * zoom) * ancho / 2, (1 - p.y * zoom) * alto / 2]);
    }
    // Una mano aparcada fuera del encuadre no ensancha la caja de la otra.
    if (lados.length === 1 || visibles.some(([x,y]) => x >= -32 && x <= ancho+32 && y >= -32 && y <= alto+32)) {
      puntos.push(...visibles);
    }
  }
  // Si la mano cae fuera de cuadro se conserva el borde correspondiente.
  function intervalo(eje, limite) {
    const valores = puntos.map(p => p[eje]);
    if (!valores.length) return [0, limite];
    const margen = Math.min(Math.floor(limite / 2), Math.max(20, Math.ceil(limite * .035)));
    const inicio = Math.max(0, Math.min(limite - 2*margen, Math.floor(Math.min(...valores)) - margen));
    const fin = Math.max(inicio + 2*margen, Math.min(limite, Math.ceil(Math.max(...valores)) + margen));
    return [inicio, fin - inicio];
  }
  const [x, width] = intervalo(0, ancho), [y, height] = intervalo(1, alto);
  return { x, y, width, height };
}
