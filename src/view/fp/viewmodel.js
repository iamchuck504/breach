// ARMA Y BRAZOS EN PRIMERA PERSONA (CONTRATO §5).
//
//   const vm = createViewModel({ scene, camera, team, variant, assets? })
//   await vm.ready
//   vm.setWeapon('smg')            → false si el arma aún no tiene perfil
//   vm.event('fire'), vm.event('reloadStep', { name: 'magOut' }) …
//   vm.update(dt, state)           estado del contrato; sin asignaciones
//   vm.muzzleWorld(out), vm.ejectWorld(out, dirOut)
//   vm.dispose()
//
// Dos SkinnedMesh para el arma y los brazos. Las piezas rígidas tienen
// un peso por vértice. El montaje conserva los cuatro pesos de cada guante.
// Las piezas y falanges cuelgan de un nodo que sigue la cámara. El material
// aplica la proyección propia y comprime la profundidad (material.js).
import * as THREE from 'three';
import { SOLDIER_SKINS } from '../../player/soldier-skins.js';
import { loadGLB } from './assets.js';
import { vmMaterial, limbMaterial, surfaceOf, updateViewModelProjection, viewModelToMainView } from './material.js';
import { viewModelUniforms } from '../../render/pipeline.js';
import { PROFILES, hasProfile } from './profiles.js';
import { createAnim, setProfile, stepAnim, animEvent, cancelKick, deriveAds, rotYXZ } from './anim.js';
import { createKickLeg } from './kick-leg.js';
import { cajaManos, meshScreenRect } from './screen-zones.js';
import { hipBounds } from './hip-bounds.js';
import { crearOcular } from './scope.js';
import { ArmRig } from './rig.js';
import { faseDeLosDedos, giroCerrojo, liberarCerrojo, recorrerFalange, transiciones } from './hand/transicion.js';

let loaded = null;

// ---------- fusión con piel rígida ----------
// entries: [{ mesh, bone, region }]. La geometría ya está en el espacio del
// hueso (el pivote de cada pieza), así que las matrices inversas son la identidad.
const c8 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
// tint: { 'subcadena de material': [r, g, b] } recolorea superficies (variantes
// de un mismo arte: frag sobre el bote de humo, stun sobre la pistola)
function mergeRigid(entries, variant, tint = null) {
  let total = 0;
  const parts = [];
  for (const e of entries) {
    // la malla del propio nodo (una primitiva) o sus primitivas (varias);
    // (mallas 'm_…'); los nodos hijos (falanges, bote, anclas) son otras entradas
    const meshes = [];
    if (e.geometry) meshes.push(e);
    else {
      if (e.node.isMesh) meshes.push(e.node);
      for (const o of e.node.children) if (o.isMesh && o.name.startsWith('m_')) meshes.push(o);
    }
    for (const m of meshes) {
      const g = m.geometry, idx = g.index;
      const n = idx ? idx.count : g.attributes.position.count;
      const mname = m.materialName ?? m.material.name;
      const surf = surfaceOf(mname, e.region, variant);
      if (e.region === 'gun') {
        // Los factores del GLB varían incluso entre piezas de igual familia.
        // Se conserva algo del albedo de la paleta de juego en las sombras.
        surf.color = m.material.color.clone().lerp(surf.color, 0.25);
        surf.rough = m.material.roughness;
        surf.metal = m.material.metalness;
        if (surf.glow) surf.glow = m.material.emissiveIntensity;
      }
      if (tint) for (const k in tint) if (mname.toLowerCase().includes(k)) {
        const t = tint[k]; surf.color = surf.color.clone().setRGB(t[0], t[1], t[2]);
        surf.team = 0;
        if (t[3] !== undefined) surf.glow = t[3];
      }
      parts.push({ g, idx, n, surf, offsetY: e.offsetY ?? 0, bone: e.bone, firstJoint: e.firstJoint, seed: (parts.length * 37 + 11) % 251 });
      total += n;
    }
  }
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), W = new Float32Array(total);
  const C = new Uint8Array(total * 3), S = new Uint8Array(total * 4), D = new Uint8Array(total * 2);
  const SI = new Uint16Array(total * 4), SW = new Float32Array(total * 4);
  const skinRoots = {};
  let o = 0;
  for (const p of parts) {
    if (p.firstJoint !== undefined) {
      const joints = p.g.attributes._fp_joints;
      for (const index of joints.array) skinRoots[p.firstJoint + index] = p.firstJoint;
    }
    const pos = p.g.attributes.position, nor = p.g.attributes.normal, wear = p.g.attributes._wear;
    for (let k = 0; k < p.n; k++) {
      const i = p.idx ? p.idx.getX(k) : k;
      P[o * 3] = pos.getX(i); P[o * 3 + 1] = pos.getY(i) + p.offsetY; P[o * 3 + 2] = pos.getZ(i);
      N[o * 3] = nor.getX(i); N[o * 3 + 1] = nor.getY(i); N[o * 3 + 2] = nor.getZ(i);
      W[o] = wear ? wear.getX(i) : 0;
      C[o * 3] = c8(p.surf.color.r); C[o * 3 + 1] = c8(p.surf.color.g); C[o * 3 + 2] = c8(p.surf.color.b);
      S[o * 4] = c8(p.surf.rough); S[o * 4 + 1] = c8(p.surf.metal); S[o * 4 + 2] = c8(p.surf.glow / 8); S[o * 4 + 3] = c8(p.surf.team);
      D[o * 2] = p.surf.kind; D[o * 2 + 1] = p.seed;
      SI[o * 4] = p.bone; SW[o * 4] = 1;
      if (p.firstJoint !== undefined) {
        for (let j = 0; j < 4; j++) {
          SI[o * 4 + j] = p.firstJoint + p.g.attributes._fp_joints.getComponent(i, j);
          SW[o * 4 + j] = p.g.attributes._fp_weights.getComponent(i, j);
        }
      }
      o++;
    }
  }
  const geo = new THREE.BufferGeometry();
  if (Object.keys(skinRoots).length) geo.userData.skinRoots = skinRoots;
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('aWear', new THREE.BufferAttribute(W, 1));
  geo.setAttribute('color', new THREE.BufferAttribute(C, 3, true));
  geo.setAttribute('aSurf', new THREE.BufferAttribute(S, 4, true));
  geo.setAttribute('aDetail', new THREE.BufferAttribute(D, 2, true));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
  return geo;
}
function skinned(geo, bones, material, name, inverses = bones.map(() => new THREE.Matrix4())) {
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.name = name;
  mesh.frustumCulled = false;     // proyección propia: el frustum del mundo no aplica
  mesh.castShadow = false;        // la sombra es la del soldado propio (oculto)
  mesh.receiveShadow = true;
  mesh.renderOrder = 10;
  mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
  return mesh;
}
const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export function createViewModel({ scene, camera, team = 'red', variant = 0, assets = null }) {
  const root = new THREE.Group();
  root.name = 'fp-viewmodel-v2';
  root.visible = false;
  const ocular = crearOcular();
  root.add(ocular.matte);
  scene.add(root);
  const self = {
    root, ocular, key: null, team, variant, visible: false,
    gunMesh: null, armsMesh: null, anim: null, rig: null, prof: null,
    weapons: {}, arms: null,
  };
  const material = () => vmMaterial(self.team);
  const materialBrazos = () => limbMaterial(self.team, true);
  // ---------- brazos ----------
  function buildArms(scene3) {
    const bones = [], inverses = [], entries = [], seg = {}, anatomy = {};
    for (const side of ['R', 'L']) {
      const fore = new THREE.Bone(), hand = new THREE.Bone();
      fore.name = 'fp_fore_' + side;
      hand.name = 'fp_hand_' + side;
      root.add(fore, hand);
      seg[side] = { fore, hand };
      entries.push({ node: scene3.getObjectByName('forearm_' + side), bone: bones.length, region: 'forearm_' + side });
      // Al subir el codo entra en cuadro la manga original del brazo superior.
      const manga = scene3.getObjectByName('upper_arm_' + side);
      entries.push({ node: manga, bone: bones.length, region: manga.name,
        offsetY: -scene3.getObjectByName('forearm_' + side).position.y });
      bones.push(fore);
      inverses.push(new THREE.Matrix4());
    }
    for (const side of ['L', 'R']) {
      const node = scene3.getObjectByName('anatomica_' + side);
      const data = node.userData, firstJoint = bones.length;
      const joints = data.bones.map((b, i) => {
        const bone = new THREE.Bone();
        bone.name = 'fp_' + side + '_' + b.name;
        bone.position.fromArray(b.pos);
        bone.quaternion.fromArray(b.rot);
        if (i) bones[firstJoint + b.parent].add(bone);
        else seg[side].hand.add(bone);
        bones.push(bone);
        inverses.push(new THREE.Matrix4().fromArray(b.inv));
        return bone;
      });
      const poses = Object.fromEntries(Object.entries(data.rotations).map(([key, list]) =>
        [key, list.map(q => new THREE.Quaternion().fromArray(q))]));
      const dedos = data.bones.map(b => b.name.split('-')[0]);
      const metacarpianos = data.bones.map(b => b.name.endsWith('-metacarpal'));
      anatomy[side] = { ...data, poses, joints, dedos, metacarpianos };
      entries.push({ node, firstJoint, region: 'hand_' + side });
    }
    const geometries = SOLDIER_SKINS.map((_, variant) => mergeRigid(entries, variant));
    const geometryFor = variant => geometries[variant] ?? geometries[0];
    const mesh = skinned(geometryFor(self.variant), bones, materialBrazos(), 'fp-arms', inverses);
    const bote = new THREE.Bone();
    bote.name = 'fp_grenade';
    seg.L.hand.add(bote);
    const grenade = skinned(mergeRigid([{ node: scene3.getObjectByName('grenade'), bone: 0, region: 'gun' }], 0),
      [bote], material(), 'fp-bote');
    grenade.visible = false;
    root.add(mesh, grenade);
    const art = scene3.getObjectByName('fp_arms').userData;
    return { mesh, grenade, seg, geometries, geometryFor, anatomy, rig: new ArmRig(anatomy, art),
      leftBones: [seg.L.fore, ...anatomy.L.joints].map(b => bones.indexOf(b)) };
  }

  // ---------- un arma ----------
  function buildWeapon(key, scene3) {
    const top = scene3.getObjectByName(`${PROFILES[key].model}_fp`) ?? scene3.getObjectByName(`${key}_fp`);
    const info = top.userData;
    const pivot = new THREE.Object3D(); pivot.name = `fp_${key}_pivot`;
    const model = new THREE.Object3D(); model.name = `fp_${key}_model`;
    pivot.add(model); root.add(pivot);
    const bones = [], entries = [], partBones = {};
    for (const part of info.parts) {
      const node = top.getObjectByName(part);
      const b = new THREE.Bone(); b.name = `fp_${key}_${part}`;
      b.position.copy(node.position);
      // el cargador vuela con la mano: hueso suelto (marco de cámara)
      if (part === (PROFILES[key].parts?.mag ?? 'mag')) root.add(b); else model.add(b);
      entries.push({ node, bone: bones.length, region: 'gun' }); bones.push(b);
      partBones[part] = { bone: b, rest: node.position.clone() };
    }
    const geo = mergeRigid(entries, self.variant, PROFILES[key].tint);
    const mesh = skinned(geo, bones, material(), `fp-${key}`);
    root.add(mesh);
    const anchors = info.sockets;
    const prof = PROFILES[key];
    model.position.set(-anchors.grip[0], -anchors.grip[1], -anchors.grip[2]);
    pivot.scale.setScalar(prof.scale);
    const ads = deriveAds(anchors, prof.scale, prof.ads.relief, prof.ads.roll ?? 0);
    // papeles → nodo del GLB que el perfil declara (la corredera de la pistola
    // es `slide`, la bomba de la escopeta `pump`; antes solo se movía un nodo
    // llamado `bolt`)
    const roles = { mag: partBones[prof.parts?.mag ?? 'mag'] ?? null, bolt: partBones[prof.parts?.bolt ?? 'bolt'] ?? null, trigger: partBones[prof.parts?.trigger ?? 'trigger'] ?? null };
    const w = { key, mesh, bodyBones: bones.map((_, i) => i), pivot, model, partBones, roles, anchors, prof, ads, magHand: undefined, visible: false };
    if (prof.thrown && partBones.pin) w.ring = { held: false, seated: false };
    const guide = prof.parts?.magGuide;
    if (guide && roles.mag) w.magGuide = {
      axis: vec(guide.axis).normalize(), heel: vec(anchors.mag).sub(roles.mag.rest).multiplyScalar(prof.scale),
      clear: guide.clear * prof.scale, blend: guide.blend * prof.scale,
    };
    if (w.magGuide && prof.reload.tracks.pasoMuneca) {
      w.manoAntesDeGuia = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    }
    // sonda de pared: la boca en las posturas de REPOSO (cadera y ADS), no en
    // la animada (si no, al recogerse el arma la pared "desaparece" y vuelve)
    const mz = anchors.muzzle, gz = anchors.grip;
    const rel = [(mz[0] - gz[0]) * prof.scale, (mz[1] - gz[1]) * prof.scale, (mz[2] - gz[2]) * prof.scale];
    const probe = (pose) => { const r = rotYXZ(pose[3], pose[4], pose[5], rel); return new THREE.Vector3(r[0] + pose[0], r[1] + pose[1], r[2] + pose[2]); };
    w.probe = { hip: probe([...prof.hip.pos, ...prof.hip.rot]), ads: probe(ads) };
    w.len = Math.hypot(...rel);
    mesh.visible = false;
    return w;
  }

  self.ready = (async () => {
    const keys = Object.keys(PROFILES);
    const [armsScene, legScene, ...weaponScenes] = await Promise.all([
      assets?.arms ?? loadGLB('arms'),
      assets ? assets['kick-leg'] : loadGLB('kick-leg'),
      // un arma que no carga (GLB aún sin generar) no impide dibujar las demás
      ...keys.map((k) => Promise.resolve(assets?.[k] ?? loadGLB(PROFILES[k].model)).catch((e) => { console.warn(`[fp] ${k}: sin GLB`, e?.message ?? e); return null; })),
    ]);
    self.arms = buildArms(armsScene);
    if (legScene) self.leg = createKickLeg(legScene, root, mergeRigid, skinned, limbMaterial(self.team), self.variant);
    keys.forEach((k, i) => {
      if (!weaponScenes[i]) return;
      try { self.weapons[k] = buildWeapon(k, weaponScenes[i]); } catch (e) { console.warn(`[fp] ${k}: arma no construida`, e); }
    });
    self.armsMesh = self.arms.mesh;
    self.armsMesh.visible = false;
    loaded = true;
    return self;
  })();

  // posición del cargador dentro de la mano izquierda (constante por arma):
  // la mano en su objetivo 'mag' con el arma en reposo, y el cargador en su sitio
  const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _mp = new THREE.Vector3(), _mq = new THREE.Quaternion();
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
  const _giroPinza = new THREE.Quaternion(), _ejePinza = new THREE.Vector3(), _centroPinza = new THREE.Vector3();
  const _rail = new THREE.Vector3(), _heelDelta = new THREE.Vector3(), _heel = new THREE.Vector3();
  function piezaEnMano(w, objetivo, pieza) {
    const rig = self.arms.rig;
    rig.setProfile(w.prof, w.anchors);
    rig.gunPos.set(0, 0, 0); rig.gunQuat.identity();
    rig.handFrameFor('L', objetivo, _hp, _hq);
    rig.gunPoint(pieza.rest.toArray(), _mp);
    // offset = inv(mano) · cargador
    const inv = _q.copy(_hq).invert();
    return { pos: _mp.clone().sub(_hp).applyQuaternion(inv), quat: inv.clone() };
  }

  self.setTeam = (team) => {
    if (team === self.team) return;
    self.team = team;
    const m = material();
    if (self.armsMesh) self.armsMesh.material = materialBrazos();
    if (self.arms?.grenade) self.arms.grenade.material = m;
    if (self.leg) self.leg.mesh.material = limbMaterial(team);
    for (const w of Object.values(self.weapons)) w.mesh.material = m;
  };

  self.setVariant = (variant) => {
    if (self.variant === variant) return;
    self.variant = variant;
    self.leg?.setVariant(variant);
    if (!self.armsMesh) return;
    self.armsMesh.geometry = self.arms.geometryFor(variant);
  };

  // Devuelve false mientras el modelo elegido no esté disponible.
  self.setWeapon = (key) => {
    if (!self.arms || !hasProfile(key) || !self.weapons[key]) return false;
    if (self.key === key) return true;
    try {
      const w = self.weapons[key];
      if (w.ring) {
        w.ring.held = w.ring.seated = false;
        w.ring.grip ??= piezaEnMano(w, w.prof.targets.bolt, w.partBones.pin);
      }
      if (w.magHand === undefined) w.magHand = w.roles.mag && w.prof.targets?.mag ? piezaEnMano(w, w.prof.targets.mag, w.roles.mag) : null;
      for (const o of Object.values(self.weapons)) o.mesh.visible = false;
      if (self.arms.grenade) self.arms.grenade.visible = false;
      if (self.leg) self.leg.mesh.visible = false;
      self.key = key; self.prof = w.prof;
      self.armsMesh.geometry = self.arms.geometryFor(self.variant);
      self.armsMesh.material = materialBrazos();
      self.arms.rig.setProfile(w.prof, w.anchors);
      // Las curvas están en el marco de composición del visor. Convertir
      // el conjunto, incluida la distancia al ojo, a metros del soldado
      // deja su anatomía a 1:1 y el arma a la escala de su montaje de mundo.
      root.scale.setScalar(1 / self.arms.rig.hs);
      root.updateMatrixWorld(true);
      if (!self.anim) self.anim = createAnim(w.prof, w.ads); else setProfile(self.anim, w.prof, w.ads);
      self.anim.len = w.len;
      // Algunas piezas (por ejemplo, la tapa del lanzador) rebasan la boca.
      const reach = Math.max(...Object.values(w.anchors).map(anchor => {
        const local = anchor.map((v, i) => (v - w.anchors.grip[i]) * w.prof.scale);
        return -rotYXZ(...w.ads.slice(3), local)[2] - w.ads[2];
      }));
      self.anim.adsRetreat = Math.max(0, reach - 0.27);
      return true;
    } catch (e) {
      console.warn(`[fp] setWeapon(${key})`, e);
      self.key = null;
      return false;
    }
  };

  self.event = (name, data) => { if (self.anim) animEvent(self.anim, name, data); };

  const STATE0 = { aim01: 0, speed: 0 };
  // 'step' avanza la pose oculta. 'scope' dibuja el fusil alrededor del ocular.
  self.update = (dt, state = STATE0, show = true) => {
    const w = self.key && self.weapons[self.key];
    const on = !!(show && w && self.anim);
    root.visible = on && show !== 'step';
    ocular.matte.visible = false;
    self._on = on;
    if (!on) {
      if (self.anim) cancelKick(self.anim);
      if (self.leg) self.leg.mesh.visible = false;
      self._scopeIn = 0;
      return false;
    }
    self.armsMesh.visible = true;
    camera.updateMatrixWorld();
    root.position.setFromMatrixPosition(camera.matrixWorld);
    root.quaternion.setFromRotationMatrix(camera.matrixWorld);
    updateViewModelProjection(camera); // también la actualiza la cadena; sin coste si no cambió
    const a = stepAnim(self.anim, dt, state);
    const kick = self.anim.kick;
    self.leg?.update(kick.phase, kick.t, kick.leg.x, self.arms.rig.hs);
    // sucesos de las pistas (expulsión del cartucho en el bombeo…)
    if (a.events.length && self.onAnimEvent) for (const e of a.events) self.onAnimEvent(e, self.key);
    const g = a.gun, p = w.prof;
    w.mesh.visible = a.show > 0.5; // pista `show`: el objeto lanzado ya no está en la mano
    w.pivot.position.set(g[0], g[1], g[2]);
    w.pivot.quaternion.setFromEuler(_e.set(g[3], g[4], g[5], 'YXZ'));
    // piezas
    const pb = w.partBones;
    if (p.parts.sightHipScale) {
      // El perfil conserva el contorno de cadera y la abertura útil al acercar el ojo.
      pb.sight_rear.bone.scale.setScalar(THREE.MathUtils.lerp(p.parts.sightHipScale, 1, a.aim));
    }
    const ba = p.parts.boltAxis;
    const R = w.roles;
    if (R.bolt && ba) R.bolt.bone.position.copy(R.bolt.rest).addScaledVector(_v.set(ba[0], ba[1], ba[2]), a.bolt * p.parts.boltTravel);
    // pistas por pieza (parts.anim): { nodo: { track, move: [m del modelo a 1], rot: [rad a 1] } }
    const pa = p.parts.anim;
    if (pa && a.parts) for (const k in pa) {
      const b = pb[k]; if (!b) continue;
      const v = a.parts[k] ?? 0, e = pa[k];
      if (b !== R.bolt && b !== R.mag) b.bone.position.copy(b.rest);
      if (e.move) b.bone.position.x += e.move[0] * v, b.bone.position.y += e.move[1] * v, b.bone.position.z += e.move[2] * v;
      if (e.rot) b.bone.rotation.set(e.rot[0] * v, e.rot[1] * v, (e.giroFP ?? e.rot[2]) * v);
    }
    if (R.trigger) R.trigger.bone.rotation.x = -THREE.MathUtils.clamp(a.trigger, 0, 1) * (p.parts.triggerTravel ?? 0);
    // La cantonera apoya sobre el hombro. Al acercar la mejilla para ADS
    // se recoge hacia su pivote sin atravesar el puño del gatillo.
    if (pb.stock) {
      const stock = pb.stock;
      stock.bone.position.copy(stock.rest);
      stock.bone.position.z -= p.parts.stockFold ?? 0;
      stock.bone.position.y += p.parts.stockRise ?? 0;
      const tuck = p.parts.stockTuckADS ? THREE.MathUtils.smoothstep(a.aim, 0.15, 0.85) : 0;
      stock.bone.scale.setScalar(p.parts.stockHidden ? 0 : 1 - tuck);
    }
    // brazos
    const rig = self.arms.rig;
    const reposo = !rig.lInit;
    rig.update(dt, g, a);
    // La guía se resuelve siempre desde la muñeca animada, también al
    // redibujar un cuadro en pausa sin avanzar los resortes.
    if (w.manoAntesDeGuia) {
      const mano = rig.out.L.hand, previa = w.manoAntesDeGuia;
      if (dt > 0 || reposo) {
        previa.pos.copy(mano.pos);
        previa.quat.copy(mano.quat);
      } else {
        mano.pos.copy(previa.pos);
        mano.quat.copy(previa.quat);
        rig.solve('L', a.aim);
      }
    }
    let contactoCargador = 0;
    // cargador: en el arma o en la mano izquierda (mezcla corta al encajar)
    if (R.mag && (w.magHand || a.mag <= 1e-4)) {
      const mb = R.mag.bone;
      // en el arma (marco de cámara)
      w.pivot.updateMatrixWorld(true);
      _m.copy(root.matrixWorld).invert().multiply(w.model.matrixWorld);
      _v.copy(R.mag.rest).applyMatrix4(_m);
      _q.copy(w.pivot.quaternion);
      if (a.mag > 1e-4 && w.magHand) {
        const lh = rig.out.L.hand;
        _v2.copy(w.magHand.pos).multiplyScalar(1).applyQuaternion(lh.quat).add(lh.pos);
        _q2.copy(lh.quat).multiply(w.magHand.quat);
        // La guía actúa sobre la posición ya mezclada. Incluso al entregar
        // el cargador, una punta dentro del brocal sigue su eje.
        const grasp = Math.min(1, a.mag / .98);
        _v2.lerp(_v, 1 - grasp);
        _q2.slerp(_q, 1 - grasp);
        if (w.magGuide) {
          // La mano tira del talón. Mientras la punta cruza el brocal, éste
          // guía la pieza aunque la muñeca todavía esté terminando su giro.
          const guide = w.magGuide;
          _rail.copy(guide.axis).applyQuaternion(_q);
          _heel.copy(guide.heel).applyQuaternion(_q);
          _heelDelta.copy(guide.heel).applyQuaternion(_q2).sub(_heel).add(_v2).sub(_v);
          const travel = Math.max(0, _heelDelta.dot(_rail));
          const free = THREE.MathUtils.smoothstep(travel, guide.clear, guide.clear + guide.blend);
          _heel.copy(_v).addScaledVector(_rail, travel);
          // Fuera de la guía, la muñeca vuelca el cargador hacia el costado.
          // El giro pivota en la pinza, que conserva el talón entre los dedos.
          const giro = THREE.MathUtils.smoothstep(travel, guide.clear + guide.blend, guide.clear + guide.blend + .035);
          if (giro > 0) {
            _giroPinza.setFromAxisAngle(_ejePinza.set(0, 0, 1).applyQuaternion(_q), 2.65 * giro);
            _centroPinza.copy(rig.handGrip.L.center).multiplyScalar(rig.leftScale).applyQuaternion(lh.quat).add(lh.pos);
            _v2.sub(_centroPinza).applyQuaternion(_giroPinza).add(_centroPinza);
            _q2.premultiply(_giroPinza);
          }
          _v2.lerp(_heel, 1 - free);
          _q2.slerp(_q, 1 - free);
        }
        _v.copy(_v2);
        _q.copy(_q2);
      }
      mb.position.copy(_v); mb.quaternion.copy(_q); mb.scale.setScalar(a.magHide ? 0 : p.scale);
      if (w.magGuide && w.magHand && !a.magHide && (a.mag > 0 || a.left[1] > 0)) {
        // Al pasar por el brocal, la guía orienta también la mano que lleva
        // el cargador. Fuera del brocal ambos ya comparten el mismo marco.
        const hand = rig.out.L.hand;
        _q2.copy(w.magHand.quat).invert().premultiply(mb.quaternion);
        _v2.copy(w.magHand.pos).applyQuaternion(_q2).negate().add(mb.position);
        // El talón ya insertado sigue siendo el apoyo de la pinza, incluso
        // después de que el cargador haya pasado al marco del arma.
        const cerca = 1 - THREE.MathUtils.smoothstep(hand.pos.distanceTo(_v2), .025, .055);
        contactoCargador = cerca * THREE.MathUtils.smoothstep(a.left[1], .15, .96);
        // La mano corta ya sostiene la tapa mientras la guía mantiene
        // recto el cargador. Cerrar la pinza antes de liberarlo del brocal.
        const corta = p.grips.left.pose === 'libre';
        const grasp = THREE.MathUtils.smoothstep(a.mag, 0, corta ? .65 : 1);
        if (corta) contactoCargador = Math.max(contactoCargador, grasp);
        hand.pos.lerp(_v2, grasp);
        hand.quat.slerp(_q2, grasp);
        rig.solve('L');
      }
    }
    // Al acercarse al brocal, los dedos pasan junto al talón. Una vez
    // sujeto el cargador, mano y pieza conservan el mismo marco rígido.
    const paso = a.pasoMuneca;
    if (w.manoAntesDeGuia && a.mag < .98 && (paso[0] || paso[1] || paso[2])) {
      const libre = 1 - THREE.MathUtils.smoothstep(a.mag, .60, .98);
      _v.fromArray(paso).multiplyScalar(libre * rig.hs / 1000).applyQuaternion(w.pivot.quaternion);
      rig.out.L.hand.pos.add(_v);
      rig.solve('L', a.aim);
    }
    for (const side of ['R', 'L']) {
      const o = rig.out[side], s = self.arms.seg[side];
      s.fore.position.copy(o.fore.pos); s.fore.quaternion.copy(o.fore.quat); s.fore.scale.copy(o.fore.scale);
      s.hand.position.copy(o.hand.pos); s.hand.quaternion.copy(o.hand.quat); s.hand.scale.copy(o.hand.scale);
      const { poses, joints, dedos, metacarpianos } = self.arms.anatomy[side];
      const anilla = w.ring && a.action === 'throw' && (a.left[3] > .99 || w.ring.seated) ? 1 : 0;
      const pinch = THREE.MathUtils.clamp(Math.max(anilla, contactoCargador, rig.leftWeights[1], (p.scope || p.grips.left.pose === 'libre' ? 0 : rig.leftWeights[3]), (a.magHide ? 0 : a.mag)), 0, 1);
      const open = THREE.MathUtils.clamp(rig.leftWeights[2], 0, 1 - pinch);
      const libre = side === 'L' && p.grips.left.pose === 'libre';
      const held = libre ? poses.abierta : poses[p.model + '_apoyo'] ?? poses.apoyo;
      const recorrido = side === 'L' && transiciones[p.model];
      const fase = libre ? .5 + .5 * pinch : recorrido ? faseDeLosDedos(rig.retiro, open, pinch) : 0;
      const cerrando = fase > .5;
      const pinza = poses[p.model + '_pinza'] ?? poses.pinza;
      for (let i = 0; i < joints.length; i++) {
        const q = joints[i].quaternion.copy(held[i]);
        if (side === 'R') {
          if (p.thrown) q.slerp(poses.abierta[i], a.rOpen ?? 0);
          else {
            q.slerp((poses[p.model + '_disparo'] ?? poses.disparo)[i], THREE.MathUtils.clamp(a.trigger, 0, 1));
            if (rig.boltWeight) {
              recorrerFalange(q, q, (poses.sniper_cerrojo ?? poses.pinza)[i], rig.boltWeight,
                giroCerrojo[dedos[i]], metacarpianos[i]);
              if (metacarpianos[i]) liberarCerrojo(q, dedos[i], rig.boltWeight);
            }
          }
        } else if (recorrido && fase > 0) {
          recorrerFalange(q, cerrando ? poses.abierta[i] : held[i], cerrando ? pinza[i] : poses.abierta[i],
            cerrando ? 2 * fase - 1 : 2 * fase, recorrido[cerrando ? 'cerrar' : 'abrir']?.[dedos[i]], metacarpianos[i]);
        } else {
          const retiro = poses[p.model + '_retiro'];
          if (retiro && rig.retiro) q.slerp(retiro[i], rig.retiro);
          // Al soltar el guardamanos del francotirador, las falanges se
          // estiran en el mismo plano que usaron para despegarse de él.
          const libre = p.scope && retiro ? retiro : poses.abierta;
          if (open) q.slerp(libre[i], open / (1 - pinch) * (1 - rig.retiro));
          if (pinch) q.slerp(pinza[i], pinch);
        }
      }
    }
    const grenade = self.arms.grenade;
    if (grenade) {
      grenade.visible = !!a.nade;
      if (grenade.visible) grenade.skeleton.bones[0].position.fromArray(rig.hands.L.grip.center);
      // El bote conserva su tamaño al heredar la escala del guante de apoyo.
      grenade.skeleton.bones[0].scale.setScalar(rig.art.mounts.grenade / (p.supportArm?.scale ?? 1));
    }
    if (w.ring) {
      const pin = pb.pin.bone;
      const preparing = a.action === 'throw' && w.mesh.visible;
      const pulling = preparing && a.parts.pin > 0;
      // El marco de la anilla procede de la pinza cerrada sobre el bote.
      // No depende del primer cuadro que alcance el muestreo de la animación.
      if (pulling) w.ring.seated = true;
      w.ring.held = pulling;
      if (pulling) {
        const mano = rig.out.L.hand, union = w.ring.grip;
        _v.copy(union.pos).applyQuaternion(mano.quat).add(mano.pos);
        _q.copy(mano.quat).multiply(union.quat);
        _m.compose(_v, _q, _v2.setScalar(p.scale));
        w.model.updateWorldMatrix(true, false);
        _m.premultiply(_m2.copy(w.model.matrixWorld).invert().multiply(root.matrixWorld));
        _m.decompose(pin.position, pin.quaternion, pin.scale);
      } else {
        if (!preparing) w.ring.seated = false;
        pin.position.copy(pb.pin.rest);
        pin.quaternion.identity();
        pin.scale.setScalar(1);
      }
    }
    measureScope(w, state, a);
    if (p.scope) {
      const completo = show === 'scope' && a.adsBlock < .5;
      ocular.actualizar(camera.aspect, p, completo ? 1 : self._scopeIn, completo);
      self.armsMesh.material = ocular.material(materialBrazos());
      w.mesh.material = ocular.material(material());
    }
    root.updateMatrixWorld(true);
    return true;
  };

  // Punto de cámara → punto del MUNDO que se ve en el mismo píxel (el arma
  // se dibuja con su FOV fijo; el mundo, con el del jugador).
  function apparent(camPt, out) {
    return viewModelToMainView(out.copy(camPt), camera).applyMatrix4(camera.matrixWorld);
  }
  const _a = new THREE.Vector3();
  self.anchorCam = (name, out) => {
    const w = self.weapons[self.key];
    const an = w.anchors[name] ?? w.anchors.grip;
    return self.arms.rig.gunPoint(an, out);
  };
  // Comprueba alza y guion tal como se dibujan, incluidos retroceso y transiciones.
  self.sightsAligned = (height) => {
    const w = self.weapons[self.key];
    if (!root.visible || !w?.mesh.visible || w.prof.thrown) return false;
    const proj = viewModelUniforms.uVMProj.value;
    const aligned = (name) => {
      if (!w.anchors[name]) return false;
      const p = self.anchorCam(name, _a).applyMatrix4(proj);
      return p.z >= -1 && p.z <= 1 && Math.hypot(p.x * camera.aspect, p.y) * height / 2 <= 1;
    };
    return aligned('sight_rear') && aligned('sight_front');
  };
  self.muzzleWorld = (out) => apparent(self.anchorCam('muzzle', _a), out);
  self.anchorWorld = (name, out) => apparent(self.anchorCam(name, _a), out);
  /** Ventana de expulsión (mundo aparente) y dirección de expulsión (mundo). */
  /** Dirección del cañón (mundo): el fogonazo se adelanta por ella. */
  self.barrelWorld = (out) => out.set(0, 0, -1).applyQuaternion(self.arms.rig.gunQuat).applyQuaternion(root.quaternion);
  /**
   * 0..1: cuánto ha llegado el ocular al ojo, medido sobre la postura DIBUJADA
   * (la que ve el jugador). Solo armas con `scope` en su perfil; el resto 1.
   */
  // Ventana de entrada: el ocular a 1.5 cm de su sitio → 0; a 0.3 cm → 1.
  // Monótono: mientras se pide apuntar solo sube; al soltar (o cambio,
  // recarga, golpe, muerte: todos bloquean la ADS) solo baja. Se mide en
  // `update` sobre la postura dibujada; aquí solo se lee.
  self._scopeIn = 0;
  // ¿Hay alineación que medir? Solo con un arma nueva activa (animándose,
  // dibujada o en modo 'step' bajo la mira). Sin ella NO hay mira (R11).
  self._on = false;
  self.scopeAvailable = () => !!(self._on && self.key && self.anim && self.weapons[self.key]);
  self.scopeIn01 = () => {
    if (!self.scopeAvailable()) return 0;
    const w = self.weapons[self.key];
    if (!(w.prof.scope ?? self.key === 'sniper')) return 1;
    return self._scopeIn;
  };
  function measureScope(w, state, a) {
    if (!(w.prof.scope ?? self.key === 'sniper')) { self._scopeIn = 0; return; }
    const v = self.anchorCam('sight_rear', _a);
    const d = Math.hypot(v.x, v.y, v.z + w.prof.ads.relief);
    const t = Math.min(1, Math.max(0, (d - 0.003) / 0.012));
    const raw = 1 - t * t * (3 - 2 * t);
    // Valor PRESENTE (DECISIONES 17), monótono solo dentro de una subida o
    // una bajada: se pide mira = apuntar sin recarga/cambio/golpe (adsBlock),
    // sin sprint y sin pared delante (el arma se retrae: la mira no entra).
    // Subiendo: max(anterior, presente). Puesta: se queda mientras se pida
    // (el retroceso no la quita). Al dejar de pedirse: min(anterior, presente).
    const wants = (state.aim01 ?? 0) > 0.5 && a.adsBlock < 0.5 && !state.sprint && (state.wallNear ?? 0) < 0.05;
    if (!wants) self._scopeIn = Math.min(self._scopeIn, raw);
    else if (self._scopeIn < 0.98) self._scopeIn = Math.max(self._scopeIn, raw);
  }
  self.ejectWorld = (out, dirOut) => {
    apparent(self.anchorCam('eject', _a), out);
    if (dirOut) {
      // a la derecha del arma, algo arriba y atrás
      dirOut.set(1, 0.55, 0.25).normalize().applyQuaternion(self.arms.rig.gunQuat).applyQuaternion(root.quaternion);
    }
    return out;
  };

  // Rectángulos normalizados de la postura dibujada en este cuadro.
  // El cargador pertenece al arma incluso cuando viaja con la mano.
  const inverseRoot = new THREE.Matrix4();
  self.handScreenRect = (lados, ancho, alto) => cajaManos(self, viewModelUniforms.uVMProj.value, lados, ancho, alto);
  self.hudZones = () => {
    if (!root.visible || !self.key) return null;
    inverseRoot.copy(root.matrixWorld).invert();
    const w = self.weapons[self.key], arms = self.arms;
    const projection = viewModelUniforms.uVMProj.value;
    return {
      body: meshScreenRect(w.mesh, inverseRoot, projection, w.bodyBones),
      sleeve: meshScreenRect(arms.mesh, inverseRoot, projection, arms.leftBones),
    };
  };

  /**
   * Rectángulo del arma y los brazos EN CADERA, en fracciones de la ventana
   * (0..1, y hacia abajo), para revisar la composición en reposo. Usa la proyección del
   * arma: no depende del FOV del jugador.
   */
  self.screenRect = (key = self.key ?? 'smg') => {
    const w = self.weapons[key];
    if (!w) return null;
    const source = self.arms.rig;
    const rig = source.measureRig ??= new ArmRig(source.hands, source.art);
    rig.setProfile(w.prof, w.anchors);
    const hip = w.prof.hip;
    const gun = [...hip.pos, ...hip.rot];
    const still = { left: [1, 0, 0, 0, 0, 0], lOff: [0, 0, 0], lCurl: [1, 0, 0, 0, 0], trigger: 0, lLag: [0, 0, 0] };
    rig.update(1, gun, still);
    updateViewModelProjection(camera);
    const P = viewModelUniforms.uVMProj.value;
    return hipBounds(w, self.arms, rig, P, self.arms.geometryFor(self.variant));
  };

  self.dispose = () => {
    root.removeFromParent();
    ocular.dispose();
    self.leg?.dispose();
    self.armsMesh?.skeleton.dispose();
    self.arms?.grenade?.geometry.dispose();
    self.arms?.grenade?.skeleton.dispose();
    for (const w of Object.values(self.weapons)) w.mesh.geometry.dispose();
    for (const geometry of self.arms?.geometries ?? []) geometry?.dispose();
  };
  return self;
}

export const viewModelLoaded = () => loaded;
