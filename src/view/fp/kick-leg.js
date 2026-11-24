import { Bone, MathUtils, Matrix4, Vector3 } from 'three';
import { SOLDIER_SKINS } from '../../player/soldier-skins.js';
import { BLENDER_LEG_SCALE } from '../../player/blender-soldier.js';


// Longitud entre pivotes del soldado con la corrección de blender-soldier.js.
const BONE_LENGTH = 0.32 * BLENDER_LEG_SCALE;
const TRAJECTORY_SCALE = 2 * BONE_LENGTH / (0.52 + 0.56);
// HIP, F_HIDE, F_CHAMBER, F_STRIKE y POLE de CRASHTERRA (view.ts).
// Se traslada el conjunto ya escalado para alojar la bota ancha de Breach
// delante del plano cercano y a la izquierda del arma que baja por la derecha.
// Cadera en metros del soldado. Deja pasar el brazal de apoyo al salir de ADS.
const hip = new Vector3(-0.397, -0.767, -1.433);
const up = new Vector3(0, 1, 0);
const lateral = new Vector3(1, 0, 0);
const yaw = -0.22;
function footTarget(x, y, z) {
  return new Vector3(x + 0.02, y + 0.66, z + 0.06).multiplyScalar(TRAJECTORY_SCALE)
    .applyAxisAngle(lateral, 0.10).applyAxisAngle(up, yaw).add(hip);
}
const hidden = footTarget(0, -1.25, -0.1);
const chamber = footTarget(-0.05, -0.72, -0.62);
const strike = footTarget(-0.06, -0.34, -1.04);
const hipHidden = new Vector3(-0.13333, -0.13333, 0);
const hipChamber = new Vector3(-0.26667, 0.075, 0);
const hipStrike = new Vector3(0, 0.05833, 0);
const pole = new Vector3(0.05, 0.7, -1.0).applyAxisAngle(up, yaw);
const hinge = new Vector3();
const xAxis = new Vector3(), yAxis = new Vector3(), zAxis = new Vector3();
const basis = new Matrix4();
const clamp01 = t => MathUtils.clamp(t, 0, 1);
const easeOutCubic = t => 1 - (1 - clamp01(t)) ** 3;
const easeInOut = t => MathUtils.smoothstep(t, 0, 1);

// orientBone y solveTwoBone de CRASHTERRA (view/suit.ts), con dos huesos
// de igual longitud y el polo ya expresado con respecto a la cadera.
function orientBone(bone, from, to, boot = false) {
  yAxis.subVectors(to, from).normalize();
  // La placa y la puntera siguen la misma bisagra. Proyectar el polo
  // sobre cada hueso por separado puede dar media vuelta al muslo al alzarlo.
  xAxis.copy(hinge);
  if (boot) xAxis.negate();
  zAxis.crossVectors(xAxis, yAxis);
  basis.makeBasis(xAxis, yAxis, zAxis);
  bone.quaternion.setFromRotationMatrix(basis);
  bone.position.copy(from);
}
function solveTwoBone(root, foot, knee) {
  yAxis.subVectors(foot, root);
  const reach = yAxis.length(), maxReach = BONE_LENGTH * 2 * 0.999;
  const distance = Math.min(reach, maxReach);
  yAxis.normalize();
  if (reach > maxReach) foot.copy(root).addScaledVector(yAxis, distance);
  zAxis.copy(pole).addScaledVector(yAxis, -pole.dot(yAxis));
  if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 1, 0);
  zAxis.normalize();
  hinge.crossVectors(yAxis, zAxis).normalize();
  const cos = distance / (2 * BONE_LENGTH);
  knee.copy(root).addScaledVector(yAxis, BONE_LENGTH * cos)
    .addScaledVector(zAxis, BONE_LENGTH * Math.sqrt(Math.max(0, 1 - cos * cos)));
}

export function createKickLeg(scene3, root, mergeRigid, skinned, material, variant = 0) {
  const bones = ['thigh', 'shin', 'foot'].map(name => {
    const bone = new Bone();
    bone.name = `fp_kick_${name}`;

    root.add(bone);
    return bone;
  });
  const [thigh, shin, boot] = bones;
  const entries = [
    { node: scene3.getObjectByName('thigh'), bone: 0, region: 'thigh' },
    { node: scene3.getObjectByName('kneecap'), bone: 1, region: 'kneecap' },
    { node: scene3.getObjectByName('shin'), bone: 1, region: 'shin' },
    { node: scene3.getObjectByName('foot'), bone: 2, region: 'foot' },
  ];
  const geometries = new Map();
  function geometryFor(index) {
    const skin = SOLDIER_SKINS[index] ? index : 0;
    if (!geometries.has(skin)) geometries.set(skin, mergeRigid(entries, skin));
    return geometries.get(skin);
  }
  const mesh = skinned(geometryFor(variant), bones, material, 'fp-kick-leg');
  mesh.visible = false;
  root.add(mesh);
  const pelvis = new Vector3(), foot = new Vector3(), knee = new Vector3();
  return {
    mesh, thigh, shin, boot,
    setVariant(index) { mesh.geometry = geometryFor(index); },
    dispose() {
      mesh.skeleton.dispose();
      mesh.removeFromParent();
      for (const bone of bones) bone.removeFromParent();
      for (const geometry of geometries.values()) geometry.dispose();
    },
    // updateLeg de view.ts. El resorte de contacto lo avanza el reloj
    // de animación del arma; su recorrido recibe la misma escala que el pie.
    update(phase, progress, jolt = 0, scale = 1 / root.scale.x) {
      mesh.visible = phase === 'windup' || phase === 'strike' || phase === 'recover';
      if (!mesh.visible) return;
      const t = clamp01(progress);
      let lift = 1, extension = 0;
      if (phase === 'windup') {
        lift = easeOutCubic(t);
      } else if (phase === 'strike') {
        extension = easeOutCubic(t * 2.4);
      } else {
        extension = 1 - easeInOut(t / 0.55);
        lift = 1 - easeInOut((t - 0.3) / 0.7);
      }
      // La pelvis acompaña el empuje. La rodilla entra desde abajo y la
      // bota recorre la diagonal hacia el blanco sin agrandar las piezas.
      pelvis.lerpVectors(hipChamber, hipStrike, extension).lerp(hipHidden, 1 - lift);
      foot.lerpVectors(chamber, strike, extension).lerp(hidden, 1 - lift).add(pelvis);
      pelvis.add(hip);
      const offset = jolt * TRAJECTORY_SCALE;
      foot.z += offset;
      foot.y -= offset * 0.3;
      pelvis.z += offset * 0.4;
      solveTwoBone(pelvis, foot, knee);
      orientBone(thigh, pelvis, knee);
      orientBone(shin, knee, foot);
      orientBone(boot, foot, knee, true);
      for (const bone of bones) {
        bone.position.multiplyScalar(scale);
        bone.scale.setScalar(scale);
      }
    },
  };
}
