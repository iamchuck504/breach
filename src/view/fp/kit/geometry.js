// Primitivas y pila de transformaciones de kit.ts de CRASHTERRA.
// El generador hornea una primitiva indexada por acabado y pieza móvil.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

export function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  tmpE.set(rx, ry, rz, 'XYZ');
  tmpQ.setFromEuler(tmpE);
  return new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
}

function prep(g) {
  let geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
  geo.clearGroups();
  if (!geo.attributes['normal']) geo.computeVertexNormals();
  return geo;
}

export function cbox(w, h, d, b = Math.min(w, h, d) * 0.12, rounded = false) {
  b = Math.min(b, w * 0.45, h * 0.45, d * 0.45);
  const s = new THREE.Shape();
  const hw = w / 2 - b;
  const hh = h / 2 - b;
  // El guante añade esquinas cortadas en la sección y dos bandas en los cantos.
  const corner = rounded ? Math.min(hw, hh) * 0.54 : 0;
  s.moveTo(-hw + corner, -hh);
  s.lineTo(hw - corner, -hh);
  if (corner) s.lineTo(hw, -hh + corner);
  s.lineTo(hw, hh - corner);
  if (corner) s.lineTo(hw - corner, hh);
  s.lineTo(-hw + corner, hh);
  if (corner) s.lineTo(-hw, hh - corner);
  s.lineTo(-hw, -hh + corner);
  s.closePath();
  const depth = Math.max(1e-4, d - 2 * b);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: rounded ? 2 : 1, steps: 1 });
  geo.translate(0, 0, -depth / 2);
  return prep(geo);
}

export function prism(pts, width, b = 0.004) {
  const s = new THREE.Shape();

  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const depth = Math.max(1e-4, width - 2 * b);
  const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, steps: 1 });
  geo.translate(0, 0, -depth / 2);
  const p = prep(geo);
  p.rotateY(-Math.PI / 2);
  return p;
}

export function cyl(r, h, seg = 16, r2 = r) {
  const geo = new THREE.CylinderGeometry(r2, r, h, seg, 1);
  geo.rotateX(-Math.PI / 2);
  return prep(geo);
}

export function ccyl(r, h, seg = 16, b = Math.min(r, h) * 0.18) {
  return lathe([[0, -h / 2], [r - b, -h / 2], [r, -h / 2 + b], [r, h / 2 - b], [r - b, h / 2], [0, h / 2]], seg);
}

export function lathe(pts, seg = 18) {
  const p = pts[pts.length - 1][1] < pts[0][1] ? [...pts].reverse() : pts;
  const bands = [];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i];
    const c = p[i + 1];
    if (Math.abs(a[0] - c[0]) < 1e-6 && Math.abs(a[1] - c[1]) < 1e-6) continue;
    if (a[0] <= 0 && c[0] <= 0) continue;
    const g = new THREE.LatheGeometry([new THREE.Vector2(Math.max(0, a[0]), a[1]), new THREE.Vector2(Math.max(0, c[0]), c[1])], seg);
    // En el eje la sección termina en abanico, con una sola cara por sector.
    if (a[0] === 0 || c[0] === 0) {
      const indices = g.index.array, fan = [];
      for (let j = a[0] === 0 ? 3 : 0; j < indices.length; j += 6) {
        fan.push(indices[j], indices[j + 1], indices[j + 2]);
      }
      g.setIndex(fan);
    }
    g.rotateX(Math.PI / 2);
    bands.push(prep(g));
  }
  const geo = bands.length > 1 ? mergeGeometries(bands, false) : bands[0];
  if (bands.length > 1) for (const b of bands) b.dispose();
  return geo;
}

export function tube(pts, r, seg = 18, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return prep(new THREE.TubeGeometry(curve, seg, r, radial, false));
}

export class Builder {
  parts = new Map();
  stack = [new THREE.Matrix4()];

  push(matrix) {
    this.stack.push(new THREE.Matrix4().multiplyMatrices(this.stack.at(-1), matrix));
    return this;
  }

  pop() {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }

  add(geo, matrix, surface) {
    tmpM.copy(this.stack.at(-1));
    if (matrix) tmpM.multiply(matrix);
    geo.applyMatrix4(tmpM);
    if (!this.parts.has(surface)) this.parts.set(surface, []);
    this.parts.get(surface).push(geo);
    return this;
  }

  build() {
    const result = [];
    for (const [surface, parts] of this.parts) {
      const merged = mergeGeometries(parts, false);
      const geometry = mergeVertices(merged, 1e-6);
      result.push({ surface, geometry });
      merged.dispose();
      for (const part of parts) part.dispose();
    }
    this.parts.clear();
    return result;
  }
}
