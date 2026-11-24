// Proyecta la malla de cadera con independencia de la animación en curso.
// Recorta antes de dividir por profundidad. Un hombro fuera de pantalla
// no debe reservar una esquina entera del HUD.
import * as THREE from 'three';
const point = new THREE.Vector3();
const unit = new THREE.Vector3(1, 1, 1);
const matrix = (pos, quat, scale) => new THREE.Matrix4().compose(pos, quat, scale);
const distances = [v => v.z - 0.01, v => v.z + v.x, v => v.z - v.x,
  v => v.z + v.y, v => v.z - v.y];

function includeMesh(bounds, mesh, transforms, projection, geometry = mesh.geometry) {
  const { position, skinIndex, skinWeight } = geometry.attributes;
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const sx = projection.elements[0], sy = projection.elements[5];
  for (let i = 0; i < position.count; i += 3) {
    const skeleton = transforms.skeleton ?? mesh.skeleton;
    const bone = skeleton.bones[skinIndex.getX(i)];
    const transform = transforms.get(bone);
    if (!transform) continue;
    for (let j = 0; j < 3; j++) {
      const v = vertices[j];
      if (geometry.userData.skinRoots?.[skinIndex.getX(i)] !== undefined) {
        v.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const weight = skinWeight.getComponent(i+j, k);
          if (weight) v.addScaledVector(point.fromBufferAttribute(position, i+j)
            .applyMatrix4(transforms.get(skeleton.bones[skinIndex.getComponent(i+j,k)])), weight);
        }
      } else v.fromBufferAttribute(position, i + j).applyMatrix4(transform);
      v.set(v.x * sx, v.y * sy, -v.z);
    }
    let poly = vertices;
    for (const distance of distances) {
      if (poly.every(v => distance(v) >= 0)) continue;
      if (poly.every(v => distance(v) < 0)) { poly = []; break; }
      const clipped = [];
      for (let j = 0; j < poly.length; j++) {
        const a = poly[j], b = poly[(j + 1) % poly.length], da = distance(a), db = distance(b);
        if (da >= 0) clipped.push(a);
        if ((da < 0) !== (db < 0)) clipped.push(a.clone().lerp(b, da / (da - db)));
      }
      poly = clipped;
    }
    for (const v of poly) {
      const x = 0.5 + 0.5 * v.x / v.z, y = 0.5 - 0.5 * v.y / v.z;
      bounds.x0 = Math.min(bounds.x0, x); bounds.x1 = Math.max(bounds.x1, x);
      bounds.y0 = Math.min(bounds.y0, y); bounds.y1 = Math.max(bounds.y1, y);
    }
  }
}

export function hipBounds(w, arms, rig, projection, armGeometry) {
  const bounds = { x0: 1, y0: 1, x1: 0, y1: 0 };
  const transforms = new Map();
  const model = matrix(rig.gunPos, rig.gunQuat, unit.clone().multiplyScalar(w.prof.scale));
  model.multiply(new THREE.Matrix4().makeTranslation(...w.anchors.grip.map(v => -v)));
  for (const [name, part] of Object.entries(w.partBones)) {
    if (name === 'stock' && w.prof.parts.stockHidden) continue;
    const p = part.rest.clone();
    if (name === 'stock') {
      p.z -= w.prof.parts.stockFold ?? 0;
      p.y += w.prof.parts.stockRise ?? 0;
    }
    const transform = model.clone().multiply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    if (name === 'sight_rear' && w.prof.parts.sightHipScale) {
      transform.scale(unit.clone().multiplyScalar(w.prof.parts.sightHipScale));
    }
    transforms.set(part.bone, transform);
  }
  includeMesh(bounds, w.mesh, transforms, projection);
  for (const side of ['R', 'L']) {
    const pose = rig.out[side], bones = arms.seg[side];
    for (const name of ['fore', 'hand']) {
      const b = pose[name];
      transforms.set(bones[name], matrix(b.pos, b.quat, b.scale));
    }
      const hand = arms.anatomy[side], worlds = [];
    const held = hand.poses[w.prof.model + '_apoyo'] ?? hand.poses.apoyo;
    hand.joints.forEach((joint, i) => {
      const data = hand.bones[i], parent = worlds[data.parent] ?? transforms.get(bones.hand);
      const world = parent.clone().multiply(matrix(joint.position, held[i], unit));
      worlds.push(world);
      transforms.set(joint, world.clone().multiply(new THREE.Matrix4().fromArray(data.inv)));
    });
  }
  includeMesh(bounds, arms.mesh, transforms, projection, armGeometry);
  return bounds;
}

