// Geometría rígida en el espacio local de cada hueso del GLB dibujado.
import { Box3, Matrix4, Ray, Triangle, Vector3 } from 'three';

const point = new Vector3(), closest = new Vector3(), hit = new Vector3();
const ray = new Ray(point, new Vector3(1, 0.000031, 0.000017).normalize());
const relative = new Matrix4(), movingBox = new Box3();

function tree(faces) {
  const box = new Box3();
  for (const f of faces) box.union(f.box);
  if (faces.length <= 12) return { box, faces };
  const size = box.getSize(new Vector3());
  const axis = ['x', 'y', 'z'].sort((a, b) => size[b] - size[a])[0];
  faces.sort((a, b) => a.box.min[axis] + a.box.max[axis] - b.box.min[axis] - b.box.max[axis]);
  const mid = faces.length >> 1;
  return { box, left: tree(faces.slice(0, mid)), right: tree(faces.slice(mid)) };
}

export function surfaces(mesh, includeBone, includeTriangle, bindLocal = false) {
  const result = new Map(), { position, skinIndex } = mesh.geometry.attributes;
  for (let i = 0; i < position.count; i += 3) {
    const bone = mesh.skeleton.bones[skinIndex.getX(i)];
    if (includeBone && !includeBone(bone)) continue;
    const tri = new Triangle(...[0, 1, 2].map(j => {
      const p = new Vector3().fromBufferAttribute(position, i + j);
      return bindLocal ? p.applyMatrix4(mesh.skeleton.boneInverses[skinIndex.getX(i + j)]) : p;
    }));
    if (tri.getArea() < 1e-13 || (includeTriangle && !includeTriangle(tri))) continue;
    if (!result.has(bone)) result.set(bone, { bone, faces: [], inverse: new Matrix4(), pairs: new Map() });
    const normal = tri.getNormal(new Vector3());
    result.get(bone).faces.push({ tri, box: new Box3().setFromPoints([tri.a, tri.b, tri.c]), crossing: Math.sign(normal.dot(ray.direction)) });
  }
  for (const s of result.values()) {
    s.tree = tree(s.faces);
    // Vértices únicos de la piel de cada falange. Incluye también sus caras laterales.
    const points = new Map();
    for (const { tri } of s.faces) for (const v of [tri.a, tri.b, tri.c]) points.set(v.toArray().join(','), v);
    s.points = [...points.values()];
  }
  return result;
}

let nearest, winding;
function visit(node) {
  const crosses = ray.intersectsBox(node.box);
  if (!crosses && node.box.distanceToPoint(point) >= nearest) return;
  if (node.faces) {
    for (const { tri, box, crossing } of node.faces) {
      if (box.distanceToPoint(point) < nearest) nearest = Math.min(nearest, tri.closestPointToPoint(point, closest).distanceTo(point));
      if (crosses && ray.intersectsBox(box) && ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit)) winding += crossing;
    }
    return;
  }
  visit(node.left);
  visit(node.right);
}

export function prepare(s) {
  s.inverse.copy(s.bone.matrixWorld).invert();
  s.scale = s.bone.matrixWorld.getMaxScaleOnAxis();
}

// Distancia mínima con signo de vértices de la falange a una pieza. Un
// índice de giro positivo incluye las uniones de carcasas cerradas solapadas.
export function clearance(pad, supports, maximo = Infinity) {
  let best = maximo;
  for (const support of supports) {
    if (!support.scale) continue;
    relative.multiplyMatrices(support.inverse, pad.bone.matrixWorld);
    movingBox.copy(pad.tree.box).applyMatrix4(relative);
    const box = support.tree.box;
    const dx = Math.max(0, box.min.x - movingBox.max.x, movingBox.min.x - box.max.x);
    const dy = Math.max(0, box.min.y - movingBox.max.y, movingBox.min.y - box.max.y);
    const dz = Math.max(0, box.min.z - movingBox.max.z, movingBox.min.z - box.max.z);
    const lower = Math.hypot(dx, dy, dz) * support.scale;
    if (lower > Math.max(0, best)) continue;
    let cache = support.pairs.get(pad);
    if (!cache) { cache = new Map(); support.pairs.set(pad, cache); }
    const key = relative.elements.map(v => Math.round(v * 1e6)).join(',');
    let d = cache.get(key);
    if (d === undefined) {
      d = Infinity;
      for (const p of pad.points) {
        point.copy(p).applyMatrix4(relative);
        if (box.distanceToPoint(point) > Math.max(0, d)) continue;
        nearest = Infinity; winding = 0;
        visit(support.tree);
        d = Math.min(d, winding > 0 ? -nearest : nearest);
      }
      d *= support.scale;
      if (cache.size > 4096) cache.clear();
      cache.set(key, d);
    }
    best = Math.min(d, best);
  }
  return best * 1000;
}

export function blocks(surface, target) {
  const r = new Ray(new Vector3(), target.clone().normalize()).applyMatrix4(surface.inverse);
  const end = target.clone().applyMatrix4(surface.inverse);
  function intersects(n) {
    if (!r.intersectsBox(n.box)) return false;
    if (!n.faces) return intersects(n.left) || intersects(n.right);
    return n.faces.some(({ tri }) => r.intersectTriangle(tri.a, tri.b, tri.c, false, hit) &&
      r.origin.distanceToSquared(hit) < r.origin.distanceToSquared(end));
  }
  return intersects(surface.tree);
}

// Punto más cercano de la malla al centro de la palma. La dirección sale
// de triángulos transformados, independientemente del ancla que usa la IK.
export function nearestSurface(world, supports) {
  const result = new Vector3();
  let best = Infinity;
  function walk(node, support) {
    if (node.box.distanceToPoint(point) * support.scale >= best) return;
    if (node.faces) {
      for (const { tri } of node.faces) {
        tri.closestPointToPoint(point, closest);
        const d = point.distanceTo(closest) * support.scale;
        if (d < best) { best = d; result.copy(closest).applyMatrix4(support.bone.matrixWorld); }
      }
    } else {
      const leftFirst = node.left.box.distanceToPoint(point) < node.right.box.distanceToPoint(point);
      walk(leftFirst ? node.left : node.right, support);
      walk(leftFirst ? node.right : node.left, support);
    }
  }
  for (const support of supports) {
    point.copy(world).applyMatrix4(support.inverse);
    walk(support.tree, support);
  }
  return result;
}
