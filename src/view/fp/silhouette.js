// Máscara desde el ojo. Una muestra conserva únicamente la superficie más cercana.
// La proyección y los triángulos son los mismos que usa el material del juego.
import { Matrix4, Vector3 } from 'three';
import { RADIO_VISOR } from './scope.js';

export function silhouette(vm, projection, width = 320, height = 180, withFaces = false, colorDeCara = null) {
  const inverse = vm.root.matrixWorld.clone().invert();
  const depth = new Float32Array(width * height);
  const owner = new Uint8Array(depth.length), gun = new Uint8Array(depth.length);
  const rgba = colorDeCara ? new Uint32Array(depth.length) : null;
  const face = withFaces ? new Uint32Array(depth.length) : null;
  const names = ['fondo'];
  const vertices = [new Vector3(), new Vector3(), new Vector3()];
  const zoom = vm.prof.scope ? vm.ocular.aumento.value : 1;
  const sx = width * projection.elements[0] * zoom / 2, sy = height * projection.elements[5] * zoom / 2;
  function raster(a, b, c, id, weapon, vertex, influences, colores) {
    const ax = width / 2 - sx * a.x / a.z, ay = height / 2 + sy * a.y / a.z;
    const bx = width / 2 - sx * b.x / b.z, by = height / 2 + sy * b.y / b.z;
    const cx = width / 2 - sx * c.x / c.z, cy = height / 2 + sy * c.y / c.z;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area >= 0) return;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - ax, dy = y + 0.5 - ay;
      const u = (dx * (cy - ay) - dy * (cx - ax)) / area;
      const v = ((bx - ax) * dy - (by - ay) * dx) / area;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const i = y * width + x;
      const z = -(1 - u - v) / a.z - u / b.z - v / c.z;
      if (weapon) gun[i] = 1;
      if (z <= depth[i]) continue;
      depth[i] = z;
      owner[i] = id;
      if (rgba) {
        const [ca, cb, cc] = colores;
        const wb = -u / b.z / z, wc = -v / c.z / z;
        let rgb = 0xff000000;
        for (const bits of [0, 8, 16]) {
          const base = (ca >>> bits) & 255;
          const valor = base + (((cb >>> bits) & 255) - base) * wb + (((cc >>> bits) & 255) - base) * wc;
          rgb |= Math.round(valor) << bits;
        }
        rgba[i] = rgb;
      }
      if (face) face[i] = vertex;
      if (influences) {
        // Atribución por peso de piel en el píxel, con interpolación en perspectiva.
        const wa = -(1-u-v) / a.z, wb = -u / b.z, wc = -v / c.z;
        let max = 0;
        for (const [joint, weights] of influences) {
          const w = weights[0] * wa + weights[1] * wb + weights[2] * wc;
          if (w > max) { max = w; owner[i] = joint; }
        }
      }
    }
  }
  const weapon = vm.weapons[vm.key].mesh;
  for (const mesh of [weapon, vm.armsMesh, vm.arms?.grenade, vm.leg?.mesh]) {
    if (!mesh?.visible) continue;
    const transforms = mesh.skeleton.bones.map(b => new Matrix4().multiplyMatrices(inverse, b.matrixWorld));
    const anatomy = mesh === vm.armsMesh;
    const toRoot = new Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const offset = names.length;
    for (const bone of mesh.skeleton.bones) names.push(bone.name);
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i += 3) {
      const index = skinIndex.getX(i);
      if (mesh.skeleton.bones[index].scale.x === 0) continue;
      for (let j = 0; j < 3; j++) {
        if (anatomy) mesh.getVertexPosition(i + j, vertices[j]).applyMatrix4(toRoot);
        else vertices[j].fromBufferAttribute(position, i + j).applyMatrix4(transforms[index]);
      }
      // El material comprime Z antes del recorte. Incluso una cara a menos
      // de 1 cm se dibuja si queda delante del ojo.
      const near = -1e-6;
      let poly = vertices;
      let colores = colorDeCara?.(mesh, i, vertices);
      if (vertices.some(p => p.z > near)) {
        poly = [];
        const tonos = [];
        for (let j = 0; j < 3; j++) {
          const a = vertices[j], b = vertices[(j + 1) % 3];
          if (a.z <= near) {
            poly.push(a);
            if (colores) tonos.push(colores[j]);
          }
          if ((a.z <= near) !== (b.z <= near)) {
            const t = (near - a.z) / (b.z - a.z);
            poly.push(a.clone().lerp(b, t));
            if (colores) {
              const ca = colores[j], cb = colores[(j + 1) % 3];
              let rgb = 0xff000000;
              for (const bits of [0, 8, 16]) {
                const c = (ca >>> bits) & 255;
                rgb |= Math.round(c + (((cb >>> bits) & 255) - c) * t) << bits;
              }
              tonos.push(rgb);
            }
          }
        }
        if (colores) colores = tonos;
      }
      let influences;
      if (withFaces && poly === vertices && anatomy && mesh.geometry.userData.skinRoots[index] !== undefined) {
        influences = new Map();
        for (let j = 0; j < 3; j++) for (let k = 0; k < 4; k++) {
          const weight = skinWeight.getComponent(i + j, k);
          if (!weight) continue;
          const id = offset + skinIndex.getComponent(i + j, k);
          if (!influences.has(id)) influences.set(id, [0, 0, 0]);
          influences.get(id)[j] += weight;
        }
      }
      for (let j = 2; j < poly.length; j++) {
        raster(poly[0], poly[j - 1], poly[j], offset + index, mesh === weapon, i, influences,
          colores && [colores[0], colores[j - 1], colores[j]]);
      }
    }
  }
  if (vm.ocular.matte.visible) {
    const radio2 = (Math.min(width, height) * RADIO_VISOR) ** 2;
    for (let i = 0; i < owner.length; i++) {
      const x = i % width + .5 - width / 2, y = Math.floor(i / width) + .5 - height / 2;
      if (x*x + y*y < radio2) {
        owner[i] = gun[i] = depth[i] = 0;
        if (face) face[i] = 0;
        if (rgba) rgba[i] = 0;
      } else if (rgba && !owner[i]) rgba[i] = 0xff090706;
    }
  }
  return { width, height, names, owner, gun, depth, face, rgba };
}
