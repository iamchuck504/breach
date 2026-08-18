// Personaje 100% procedural: proporciones compactas estilo Ratchet & Clank
// (torso grande, piernas cortas, antebrazos/manos grandes, silueta clara).
//
// Sujeción del arma: el arma vive en un "gunMount" (hijo del aimRig, a la
// altura del pecho). Cada estado define la POSTURA del mount (moderada en
// hipfire/blindfire, pronunciada en ADS, vertical en cover, baja en roadie)
// y las manos se colocan sobre las anclas del arma (grip / forend) con IK
// analítico de dos huesos — ambas manos siempre en contacto, sin poses
// robóticas. El pitch de la cámara inclina el aimRig completo (brazos+arma).
import * as THREE from 'three';

const TEAM_COLORS = { red: 0xd94f3f, blue: 0x4f8de0 };
const DARK = 0x33363c, MID = 0x565b63, VISOR = 0x15171c;

const L1 = 0.28, L2 = 0.36; // largo húmero / antebrazo (pivotes)

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
function ball(r, color, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  return m;
}
function anchor(parent, x, y, z) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

function buildLancer(teamColor) {
  const g = new THREE.Group();
  g.add(box(0.075, 0.13, 0.58, DARK, 0, 0, -0.14));          // cuerpo
  g.add(box(0.05, 0.05, 0.34, MID, 0, 0.02, -0.48));          // cañón
  g.add(box(0.06, 0.1, 0.07, teamColor, 0, 0.09, -0.28));     // detalle equipo
  g.add(box(0.05, 0.12, 0.06, DARK, 0, -0.11, 0.02));         // grip
  g.add(box(0.055, 0.16, 0.05, MID, 0, -0.12, -0.22));        // cargador
  g.userData.muzzle = anchor(g, 0, 0.02, -0.66);
  g.userData.grip = anchor(g, 0, -0.1, 0.03);
  g.userData.forend = anchor(g, 0, -0.09, -0.18);
  return g;
}

function buildGnasher(teamColor) {
  const g = new THREE.Group();
  g.add(box(0.09, 0.14, 0.46, DARK, 0, 0, -0.08));
  g.add(box(0.065, 0.065, 0.26, MID, 0, 0.03, -0.38));
  g.add(box(0.07, 0.1, 0.08, teamColor, 0, 0.08, -0.16));
  g.add(box(0.05, 0.13, 0.06, DARK, 0, -0.11, 0.06));
  g.userData.muzzle = anchor(g, 0, 0.03, -0.52);
  g.userData.grip = anchor(g, 0, -0.1, 0.06);
  g.userData.forend = anchor(g, 0, -0.09, -0.14);
  return g;
}

// temporales del IK
const IK_S = new THREE.Vector3(), IK_V = new THREE.Vector3(), IK_POLE = new THREE.Vector3();
const IK_N = new THREE.Vector3(), IK_U = new THREE.Vector3();
const IK_X = new THREE.Vector3(), IK_Y = new THREE.Vector3(), IK_Z = new THREE.Vector3();
const IK_T1 = new THREE.Vector3(), IK_T2 = new THREE.Vector3(), IK_H = new THREE.Vector3();
const IK_M = new THREE.Matrix4(), IK_Q = new THREE.Quaternion(), IK_QE = new THREE.Quaternion();
const IK_BQ = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const TMP_A = new THREE.Vector3(), TMP_B = new THREE.Vector3();
const clamp01 = (v) => Math.min(1, Math.max(-1, v));

export class Rig {
  constructor(scene, team, name = null) {
    this.team = team;
    const tc = TEAM_COLORS[team];

    this.root = new THREE.Group();
    scene.add(this.root);

    // --- jerarquía
    this.hips = new THREE.Group();
    this.hips.position.y = 0.66;
    this.root.add(this.hips);

    this.torso = new THREE.Group();
    this.hips.add(this.torso);
    this.torso.add(box(0.5, 0.34, 0.3, MID, 0, 0.17, 0));           // abdomen
    this.torso.add(box(0.62, 0.3, 0.38, tc, 0, 0.44, 0));           // pecho grande
    this.torso.add(box(0.5, 0.08, 0.4, DARK, 0, 0.6, 0));           // hombreras base
    this.torso.add(ball(0.15, tc, -0.36, 0.55, 0));                 // hombrera L
    this.torso.add(ball(0.15, tc, 0.36, 0.55, 0));                  // hombrera R

    this.head = new THREE.Group();
    this.head.position.set(0, 0.66, 0);
    this.torso.add(this.head);
    this.head.add(ball(0.185, MID, 0, 0.14, 0, 1, 1.05, 1));        // casco
    this.head.add(box(0.24, 0.09, 0.06, VISOR, 0, 0.14, -0.16));    // visor
    this.head.add(box(0.06, 0.05, 0.05, tc, 0, 0.3, 0));            // cresta

    // aimRig: pivote a la altura del pecho; contiene brazos + arma para
    // inclinar todo el conjunto con el pitch de la cámara.
    this.aimRig = new THREE.Group();
    this.aimRig.position.set(0, 0.5, 0);
    this.torso.add(this.aimRig);

    const mkArm = (side) => {
      const s = side === 'L' ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.36, 0, 0);
      this.aimRig.add(shoulder);
      shoulder.add(box(0.11, 0.27, 0.11, MID, 0, -0.14, 0));        // brazo
      const elbow = new THREE.Group();
      elbow.position.set(0, -L1, 0);
      shoulder.add(elbow);
      elbow.add(box(0.14, 0.32, 0.14, DARK, 0, -0.16, 0));          // antebrazo grande
      const hand = new THREE.Group();
      hand.position.set(0, -L2, 0);
      elbow.add(hand);
      hand.add(ball(0.105, tc, 0, -0.01, 0));                       // manota
      return { shoulder, elbow, hand };
    };
    this.armL = mkArm('L');
    this.armR = mkArm('R');

    const mkLeg = (side) => {
      const s = side === 'L' ? -1 : 1;
      const hip = new THREE.Group();
      hip.position.set(s * 0.15, 0.02, 0);
      this.hips.add(hip);
      hip.add(box(0.17, 0.3, 0.19, MID, 0, -0.15, 0));              // muslo
      const knee = new THREE.Group();
      knee.position.set(0, -0.32, 0);
      hip.add(knee);
      knee.add(box(0.15, 0.24, 0.17, DARK, 0, -0.12, 0));           // canilla
      knee.add(box(0.17, 0.1, 0.26, DARK, 0, -0.3, -0.04));         // botota
      return { hip, knee };
    };
    this.legL = mkLeg('L');
    this.legR = mkLeg('R');

    // arma montada al pecho; las manos la alcanzan por IK
    this.gunMount = new THREE.Group();
    this.aimRig.add(this.gunMount);
    this.gunLancer = buildLancer(tc);
    this.gunGnasher = buildGnasher(tc);
    // armas sobredimensionadas (estilo Ratchet/Gears): leen desde atrás
    this.gunLancer.scale.set(1.3, 1.3, 1.35);
    this.gunGnasher.scale.set(1.35, 1.35, 1.4);
    this.gunMount.add(this.gunLancer);
    this.gunMount.add(this.gunGnasher);
    this.gunGnasher.visible = false;

    if (name) this._addNameTag(name, tc);

    this.phase = 0;
    this._recoil = 0;
    this._deadT = 0;
  }

  _addNameTag(name, tc) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = '600 30px "Geist Mono", monospace';
    g.textAlign = 'center';
    g.fillStyle = '#' + new THREE.Color(tc).getHexString();
    g.fillText(name.slice(0, 14), 128, 42);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(1.5, 0.38, 1);
    sp.position.y = 2.05;
    this.root.add(sp);
    this.nameTag = sp;
  }

  setWeapon(wep) {
    this.gunLancer.visible = wep === 'lancer';
    this.gunGnasher.visible = wep === 'gnasher';
  }

  get activeGun() { return this.gunLancer.visible ? this.gunLancer : this.gunGnasher; }

  muzzleWorld(out) {
    this.root.updateWorldMatrix(true, true);
    return this.activeGun.userData.muzzle.getWorldPosition(out);
  }

  gunForward(out) {
    this.root.updateWorldMatrix(true, true);
    const q = IK_Q;
    this.activeGun.userData.muzzle.getWorldQuaternion(q);
    return out.set(0, 0, -1).applyQuaternion(q);
  }

  kick(amount) { this._recoil = Math.min(1.2, this._recoil + amount); }

  // IK analítico de dos huesos en espacio del aimRig. Prueba las dos
  // soluciones de codo y elige la que alcanza el target con el codo
  // hacia abajo/afuera (vector polo).
  _ikArm(arm, side, target) {
    IK_S.set(side * 0.36, 0, 0);
    IK_V.copy(target).sub(IK_S);
    let d = IK_V.length();
    d = Math.min(L1 + L2 - 0.02, Math.max(0.12, d));
    IK_V.normalize();
    IK_POLE.set(side * 0.7, -0.75, -0.4).normalize();
    IK_N.crossVectors(IK_V, IK_POLE);
    if (IK_N.lengthSq() < 1e-5) IK_N.set(0, 0, -side);
    IK_N.normalize();
    const a = Math.acos(clamp01((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const bend = Math.PI - Math.acos(clamp01((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)));

    let bestErr = Infinity, bestBend = 0;
    for (const sa of [1, -1]) {
      IK_U.copy(IK_V).applyAxisAngle(IK_N, a * sa); // dirección del húmero
      IK_Y.copy(IK_U).negate();
      IK_Z.crossVectors(IK_N, IK_Y).normalize();
      IK_X.crossVectors(IK_Y, IK_Z).normalize();
      IK_M.makeBasis(IK_X, IK_Y, IK_Z);
      IK_Q.setFromRotationMatrix(IK_M);
      for (const sb of [1, -1]) {
        IK_T1.set(0, -L1, 0).applyQuaternion(IK_Q);
        IK_QE.setFromAxisAngle(AXIS_X, bend * sb);
        IK_T2.set(0, -L2, 0).applyQuaternion(IK_QE).applyQuaternion(IK_Q);
        IK_H.copy(IK_S).add(IK_T1).add(IK_T2);
        const err = IK_H.distanceTo(target) - IK_T1.dot(IK_POLE) * 0.03;
        if (err < bestErr) {
          bestErr = err;
          IK_BQ.copy(IK_Q);
          bestBend = bend * sb;
        }
      }
    }
    arm.shoulder.quaternion.copy(IK_BQ);
    arm.elbow.rotation.set(bestBend, 0, 0);
  }

  // p: {state, speed, aim, aimPitch, twist}
  update(dt, p) {
    // Convenciones (el personaje mira a -Z local):
    //   torso.x: − adelante, + atrás   |   head.x: + mirar arriba
    //   shoulder/elbow.x: + brazo hacia adelante   |   knee.x: − doblar rodilla
    const T = new Map();
    const set = (o, k, v) => {
      let e = T.get(o);
      if (!e) { e = {}; T.set(o, e); }
      e[k] = v;
    };
    const R = (grp, x = 0, y = 0, z = 0) => {
      set(grp.rotation, 'x', x); set(grp.rotation, 'y', y); set(grp.rotation, 'z', z);
    };
    // postura del arma: posición/rotación del mount (relativo al pecho)
    const M = (x, y, z, rx = 0, ry = 0, rz = 0) => {
      set(this.gunMount.position, 'x', x);
      set(this.gunMount.position, 'y', y);
      set(this.gunMount.position, 'z', z);
      R(this.gunMount, rx, ry, rz);
    };

    let hipsY = 0.66, rootRotX = 0, damp = 12;
    let leftOnGun = false, ikArms = true;
    const sp = p.speed;
    this.phase += dt * (4.5 + sp * 8.5) * (sp > 0.02 ? 1 : 0);
    const ph = this.phase;
    const swing = Math.sin(ph), swing2 = Math.sin(ph + Math.PI);
    const bob = Math.abs(Math.cos(ph));
    const pitch = p.aimPitch ?? 0;

    switch (p.state) {
      case 'roadie': {
        damp = 10;
        R(this.torso, -0.55, 0, Math.sin(ph * 0.5) * 0.04);
        R(this.head, 0.42, 0, 0);
        R(this.legL.hip, swing * 1.05, 0, 0); R(this.legL.knee, -(Math.max(0, -swing) * 1.5 + 0.2), 0, 0);
        R(this.legR.hip, swing2 * 1.05, 0, 0); R(this.legR.knee, -(Math.max(0, -swing2) * 1.5 + 0.2), 0, 0);
        R(this.armL.shoulder, swing2 * 0.9 + 0.2, 0, -0.2); R(this.armL.elbow, 1.25, 0, 0);
        // arma baja al costado, una mano
        M(0.16, -0.34, -0.1, -0.5, 0.05, 0);
        R(this.aimRig, 0, 0, 0);
        hipsY = 0.58 + bob * 0.06;
        break;
      }
      case 'run': case 'idle': {
        const m = p.state === 'run' ? 1 : 0;
        const tw = p.twist ?? 0; // torso/cabeza giran hacia la cámara
        R(this.torso, -0.1 * m + Math.sin(ph * 0.4) * 0.015, tw * 0.55, swing * 0.04 * m);
        R(this.head, 0.05 * m, tw * 0.35, 0);
        R(this.legL.hip, swing * 0.75 * m, 0, 0); R(this.legL.knee, -(Math.max(0, -swing) * 1.1 + 0.1) * m, 0, 0);
        R(this.legR.hip, swing2 * 0.75 * m, 0, 0); R(this.legR.knee, -(Math.max(0, -swing2) * 1.1 + 0.1) * m, 0, 0);
        leftOnGun = true;
        if (p.firing) {
          // blindfire de cadera: postura de apunte MODERADA (arma al frente, pecho)
          M(0.14, -0.12, -0.26, 0, 0.06, 0);
        } else {
          // low-ready diagonal (Gears): cruzada e inclinada, el cañón asoma
          // sobre el hombro izquierdo visto desde atrás
          M(0.16, -0.21 + bob * 0.01 * m, -0.24, 0.3, 0.4, 0.05);
        }
        hipsY = 0.66 + bob * 0.045 * m;
        break;
      }
      case 'jump': {
        // salto normal: piernas recogidas asimétricas, arma al pecho
        damp = 14;
        R(this.torso, -0.18, 0, 0.03);
        R(this.head, 0.1, 0, 0);
        R(this.legL.hip, 0.55, 0, 0); R(this.legL.knee, -1.0, 0, 0);
        R(this.legR.hip, 0.2, 0, 0); R(this.legR.knee, -0.5, 0, 0);
        leftOnGun = true;
        M(0.15, -0.16, -0.22, 0, 0.15, 0);
        hipsY = 0.66;
        break;
      }
      case 'flip': {
        // patada de pared Matrix: giro LATERAL con piernas semi-recogidas,
        // arma al frente en ambas manos para disparar en el aire
        damp = 20;
        R(this.torso, -0.2, 0, 0);
        R(this.head, 0.05, 0, 0);
        R(this.legL.hip, 1.25, 0, 0.15); R(this.legL.knee, -1.7, 0, 0);
        R(this.legR.hip, 1.05, 0, -0.15); R(this.legR.knee, -1.5, 0, 0);
        leftOnGun = true;
        M(0.13, -0.12, -0.24, 0, 0.05, 0);
        set(this.aimRig.rotation, 'x', pitch * 0.85); // apunta con la cámara en el aire
        hipsY = 0.72;
        break;
      }
      case 'dive': {
        damp = 16;
        R(this.torso, -0.8, 0, 0);
        R(this.head, 0.3, 0, 0);
        R(this.legL.hip, 0.9, 0, 0); R(this.legL.knee, -1.4, 0, 0);
        R(this.legR.hip, 0.6, 0, 0); R(this.legR.knee, -1.2, 0, 0);
        R(this.armL.shoulder, 0.6, 0, -0.45); R(this.armL.elbow, 0.4, 0, 0);
        M(0.12, -0.22, -0.16, -0.3, 0, 0);
        hipsY = 0.45;
        break;
      }
      case 'slide': {
        damp = 16;
        R(this.torso, 0.2, 0, 0.1);
        R(this.head, -0.05, 0, 0);
        R(this.legL.hip, 1.2, 0, 0); R(this.legL.knee, -0.3, 0, 0);   // pierna extendida
        R(this.legR.hip, 0.55, 0, 0); R(this.legR.knee, -1.3, 0, 0);  // pierna doblada
        R(this.armL.shoulder, -0.6, 0, -0.5); R(this.armL.elbow, 0.3, 0, 0); // brazo atrás
        M(0.12, -0.15, -0.2, 0.05, 0, 0);
        hipsY = 0.38;
        break;
      }
      case 'cover_low': case 'cover_high': {
        const low = p.state === 'cover_low';
        const lat = p.latMove ?? 0;         // -1..1: paso lateral
        const stepping = Math.abs(lat) > 0.12;
        const stepSw = stepping ? Math.sin(ph * 1.5) : 0;
        leftOnGun = true;
        if (low) {
          // agachado PROFUNDO de espaldas al bloque: la cabeza queda bajo el borde
          R(this.torso, -0.72 + (stepping ? Math.abs(stepSw) * 0.04 : 0), lat * 0.18, -lat * 0.1);
          R(this.head, 0.55, lat * 0.35, 0);
          R(this.legL.hip, 1.85 + stepSw * 0.3 * lat, 0, lat * 0.2);
          R(this.legL.knee, -2.35, 0, 0);
          R(this.legR.hip, 1.7 - stepSw * 0.3 * lat, 0, lat * 0.2);
          R(this.legR.knee, -2.25, 0, 0);
          hipsY = 0.18 + (stepping ? Math.abs(Math.cos(ph * 1.5)) * 0.02 : 0);
        } else {
          // de pie con la espalda apoyada en la pared
          R(this.torso, 0.14, lat * 0.15, -lat * 0.07);
          R(this.head, 0.02, lat * 0.45, 0);
          R(this.legL.hip, -0.05 + stepSw * 0.35 * lat, 0, 0.06 + lat * 0.15);
          R(this.legL.knee, -0.2 - Math.max(0, stepSw * lat) * 0.4, 0, 0);
          R(this.legR.hip, 0.05 - stepSw * 0.35 * lat, 0, -0.06 + lat * 0.15);
          R(this.legR.knee, -0.15 - Math.max(0, -stepSw * lat) * 0.4, 0, 0);
          hipsY = 0.62 + (stepping ? Math.abs(Math.cos(ph * 1.5)) * 0.02 : 0);
        }
        // arma al pecho: vertical relajada, o al frente si está disparando
        if (p.firing) {
          M(0.14, -0.12, -0.26, 0, 0.06, 0);
          set(this.aimRig.rotation, 'x', pitch * 0.85);
        } else {
          M(0.07, -0.06, -0.2, 1.25, 0, 0.06);
          R(this.aimRig, 0, 0, 0);
        }
        break;
      }
      case 'blind_over': {
        damp = 15;
        R(this.torso, -0.05, 0, 0);
        R(this.head, 0.25, 0, 0);
        R(this.legL.hip, 1.3, 0, 0); R(this.legL.knee, -1.7, 0, 0);
        R(this.legR.hip, 1.15, 0, 0); R(this.legR.knee, -1.65, 0, 0);
        // arma por encima del cover, mano izq. apoyada cerca del pecho
        R(this.armL.shoulder, 0.5, -0.5, -0.15); R(this.armL.elbow, 1.4, 0, 0);
        M(0.04, 0.28, -0.18, 0, 0, 0);
        hipsY = 0.42;
        break;
      }
      case 'dead': {
        damp = 8;
        ikArms = false;
        this._deadT += dt;
        rootRotX = -Math.min(1, this._deadT * 4) * Math.PI / 2;
        R(this.torso, 0, 0, 0); R(this.head, 0, 0, 0.3);
        R(this.armL.shoulder, 0.4, 0, -0.9); R(this.armR.shoulder, 0.3, 0, 0.9);
        R(this.armL.elbow, 0.2, 0, 0); R(this.armR.elbow, 0.2, 0, 0);
        R(this.legL.hip, 0.2, 0, 0); R(this.legR.hip, -0.1, 0, 0);
        M(0.1, -0.2, -0.15, 0.3, 0, 0);
        hipsY = 0.66;
        break;
      }
    }
    if (p.state !== 'dead') this._deadT = 0;

    // ADS: postura pronunciada — arma al hombro, pitch completo de cámara
    if (p.aim && p.state !== 'dead' && p.state !== 'dive' && p.state !== 'slide') {
      damp = 18;
      leftOnGun = true;
      const lean = p.coverLean ?? 0; // asomarse en la orilla de pared alta
      R(this.aimRig, pitch, 0, lean * 0.1);
      R(this.torso, -0.12, -0.15, -lean * 0.22);
      R(this.head, pitch * 0.25, 0, lean * 0.08);
      // arma al hombro derecho, a la altura de la mejilla (pronunciada)
      M(0.1, 0.06, -0.28, 0, 0.05, 0);
      if (p.state === 'cover_low') hipsY = 0.56; // popover: se levanta y apunta
      if (lean) {
        // piernas plantadas hacia la pared, torso fuera de la esquina
        R(this.legL.hip, 0, 0, 0.1 + lean * 0.12);
        R(this.legR.hip, 0, 0, -0.1 + lean * 0.12);
      }
    } else if (p.state !== 'dead') {
      // hipfire/blindfire: postura moderada — el conjunto sigue parte del pitch
      const hipPitch = p.state === 'blind_over' ? pitch * 0.8
        : (p.state === 'idle' || p.state === 'run') ? pitch * (p.firing ? 0.85 : 0.5) : 0;
      if (p.state !== 'roadie' && !(p.state === 'cover_low' || p.state === 'cover_high')) {
        set(this.aimRig.rotation, 'x', hipPitch);
      } else if (p.state === 'cover_low' || p.state === 'cover_high') {
        set(this.aimRig.rotation, 'x', 0);
      }
    }

    // recoil: empuja el conjunto brazos+arma hacia atrás
    this._recoil = Math.max(0, this._recoil - dt * 6);
    this.aimRig.position.z = this._recoil * 0.06;

    // aplicar targets con damping
    const k = 1 - Math.exp(-damp * dt);
    for (const [o, props] of T) {
      for (const prop in props) o[prop] += (props[prop] - o[prop]) * k;
    }
    // desplazamiento lateral de cadera al asomarse (lean)
    const hipsX = p.aim && p.coverLean ? p.coverLean * 0.1 : 0;
    this.hips.position.x += (hipsX - this.hips.position.x) * k;
    this.hips.position.y += (hipsY - this.hips.position.y) * k;
    this.root.rotation.x += (rootRotX - this.root.rotation.x) * (1 - Math.exp(-10 * dt));

    // patada de pared: giro completo LATERAL (roll) alrededor de la cadera
    if (p.state === 'flip') {
      this.hips.rotation.z = -(p.flipDir ?? 1) * (p.flipT ?? 0) * Math.PI * 2;
      this.hips.rotation.x = 0;
    } else {
      this.hips.rotation.z = 0; // 2π ≡ 0: aterriza limpio
      this.hips.rotation.x = 0;
    }

    // IK: manos sobre el arma (después del damping, sobre la pose ya aplicada)
    if (ikArms) {
      this.root.updateWorldMatrix(true, true);
      const gun = this.activeGun;
      gun.userData.grip.getWorldPosition(TMP_A);
      this._ikArm(this.armR, 1, this.aimRig.worldToLocal(TMP_A));
      if (leftOnGun) {
        gun.userData.forend.getWorldPosition(TMP_B);
        this._ikArm(this.armL, -1, this.aimRig.worldToLocal(TMP_B));
      }
    }
  }

  setTransform(x, z, yaw, y = 0) {
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
  }

  setVisible(v) { this.root.visible = v; }

  dispose(scene) {
    scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
  }
}
