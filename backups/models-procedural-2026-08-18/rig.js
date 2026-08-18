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
const SKIN = 0xc9a077, HAIR = 0x4a3524;

// Primitivas y materiales compartidos por TODOS los rigs. Antes cada pieza de
// cada personaje creaba su propio geometry/material: mucha memoria, uploads y
// compilaciones repetidas para objetos visualmente idénticos.
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1);
const BALL_GEO = new THREE.SphereGeometry(1, 14, 10);
BOX_GEO.userData.shared = BALL_GEO.userData.shared = true;

// Gradiente toon de cuatro pasos: conserva el coste ligero del estilo actual,
// pero da más lectura de volumen y una silueta chibi menos plana.
const TOON_GRADIENT = new THREE.DataTexture(new Uint8Array([
  70, 70, 70, 255,
  125, 125, 125, 255,
  190, 190, 190, 255,
  255, 255, 255, 255,
]), 4, 1, THREE.RGBAFormat);
TOON_GRADIENT.minFilter = TOON_GRADIENT.magFilter = THREE.NearestFilter;
TOON_GRADIENT.needsUpdate = true;
TOON_GRADIENT.userData.cached = true;

const MATERIALS = new Map();
function toonMaterial(color) {
  let mat = MATERIALS.get(color);
  if (!mat) {
    mat = new THREE.MeshToonMaterial({ color, gradientMap: TOON_GRADIENT });
    mat.userData.shared = true;
    MATERIALS.set(color, mat);
  }
  return mat;
}

// 5 variantes de soldado por equipo — SOLO estética: mismas proporciones,
// mismo hitbox (la cápsula de ballistics es analítica, independiente del
// modelo) y el pecho SIEMPRE del color del equipo. Ningún accesorio sale
// más de ~3cm de la silueta base.
export const CHAR_NAMES = ['RECLUTA', 'CENTINELA', 'EXPLORADOR', 'PESADO', 'FANTASMA'];

const L1 = 0.28, L2 = 0.36; // largo húmero / antebrazo (pivotes)

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(BOX_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = true;
  return m;
}
function ball(r, color, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(BALL_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(r * sx, r * sy, r * sz);
  m.castShadow = true;
  return m;
}
function anchor(parent, x, y, z) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

// METRALLETA: subfusil compacto — cuerpo corto, riel superior, cargador
// largo con base de color, bocacha ancha y culata plegable.
export function buildSMG(teamColor) {
  const g = new THREE.Group();
  g.add(box(0.085, 0.14, 0.36, DARK, 0, 0, -0.06));           // cuerpo compacto
  g.add(box(0.06, 0.045, 0.2, MID, 0, 0.095, -0.1));          // riel superior
  g.add(box(0.05, 0.05, 0.2, MID, 0, 0.025, -0.33));          // cañón corto
  g.add(box(0.08, 0.08, 0.1, DARK, 0, 0.025, -0.45));         // bocacha ancha
  g.add(box(0.055, 0.2, 0.075, MID, 0, -0.17, -0.03));        // cargador largo
  g.add(box(0.06, 0.06, 0.09, teamColor, 0, -0.29, -0.03));   // base del cargador
  g.add(box(0.05, 0.11, 0.05, DARK, 0, -0.1, 0.08));          // empuñadura
  g.add(box(0.028, 0.07, 0.16, MID, 0, 0.02, 0.2));           // culata plegable
  g.add(box(0.062, 0.09, 0.06, teamColor, 0, 0.04, -0.19));   // detalle equipo
  g.userData.muzzle = anchor(g, 0, 0.025, -0.52);
  g.userData.grip = anchor(g, 0, -0.09, 0.06);
  g.userData.forend = anchor(g, 0, -0.08, -0.16);
  g.userData.mag = anchor(g, 0, -0.24, -0.03); // base del cargador (recarga)
  return g;
}

// ESCOPETA: pump-action — cañón + tubo de carga, bomba y culata de madera.
export function buildShotgun(teamColor) {
  const WOOD = 0x8a5a32;
  const g = new THREE.Group();
  g.add(box(0.085, 0.13, 0.3, DARK, 0, 0, 0.0));              // receptor
  g.add(box(0.058, 0.058, 0.44, MID, 0, 0.04, -0.36));        // cañón
  g.add(box(0.05, 0.05, 0.4, DARK, 0, -0.035, -0.33));        // tubo de carga
  g.add(box(0.085, 0.085, 0.16, WOOD, 0, -0.035, -0.3));      // bomba (pump)
  g.add(box(0.075, 0.13, 0.2, WOOD, 0, -0.02, 0.22));         // culata de madera
  g.add(box(0.062, 0.1, 0.06, teamColor, 0, 0.075, 0.02));    // detalle equipo
  g.userData.muzzle = anchor(g, 0, 0.04, -0.6);
  g.userData.grip = anchor(g, 0, -0.08, 0.09);
  g.userData.forend = anchor(g, 0, -0.06, -0.3);              // mano izq. EN la bomba
  g.userData.mag = anchor(g, 0, -0.1, -0.06);                 // ventana de carga (recarga)
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
  constructor(scene, team, name = null, variant = 0) {
    this.team = team;
    this.variant = variant = Math.min(4, Math.max(0, variant | 0));
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
    this._buildHead(tc, variant);

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
    this._variantExtras(tc, variant);

    // arma activa montada al pecho (las manos la alcanzan por IK);
    // la otra va cargada a la ESPALDA en diagonal
    this.gunMount = new THREE.Group();
    this.aimRig.add(this.gunMount);
    this.backMount = new THREE.Group();
    this.backMount.position.set(-0.06, 0.3, 0.26);
    this.backMount.rotation.set(Math.PI / 2, 0, 0.4);
    this.torso.add(this.backMount);
    this.gunSMG = buildSMG(tc);
    this.gunShotgun = buildShotgun(tc);
    // armas sobredimensionadas (estilo Ratchet/Gears): leen desde atrás
    this.gunSMG.scale.set(1.3, 1.3, 1.35);
    this.gunShotgun.scale.set(1.35, 1.35, 1.4);
    this._wep = null;
    this.setWeapon('smg');

    if (name) this._addNameTag(name, tc);

    this.phase = 0;
    this._recoil = 0;
    this._deadT = 0;
    this.rag = null; // estado del ragdoll de muerte
    this.groundFn = null; // (x,z,y)->alturaSuelo — lo inyecta quien tiene el world
  }

  // Cabeza por variante — todas dentro del mismo volumen del casco base.
  _buildHead(tc, v) {
    const h = this.head;
    // los rasgos frontales sobresalen ~2cm del casco: a ras de la esfera la
    // curvatura los ocultaba desde casi todos los ángulos
    if (v === 1) {          // CENTINELA: casco cerrado, visor panorámico
      h.add(ball(0.185, DARK, 0, 0.14, 0, 1, 1.05, 1));
      h.add(box(0.3, 0.12, 0.06, VISOR, 0, 0.13, -0.185));
      h.add(box(0.2, 0.04, 0.28, tc, 0, 0.31, 0));                  // franja superior
    } else if (v === 2) {   // EXPLORADOR: sin casco — pelo y goggles en la frente
      h.add(ball(0.175, SKIN, 0, 0.13, 0, 1, 1.06, 1));
      h.add(box(0.3, 0.12, 0.3, HAIR, 0, 0.28, 0.03));              // pelo
      h.add(box(0.26, 0.07, 0.07, DARK, 0, 0.23, -0.165));          // goggles arriba
      h.add(box(0.3, 0.05, 0.06, tc, 0, 0.08, -0.175));             // pañuelo del equipo
    } else if (v === 3) {   // PESADO: casco con placas laterales y mentonera
      h.add(ball(0.185, MID, 0, 0.14, 0, 1, 1.05, 1));
      h.add(box(0.24, 0.09, 0.06, VISOR, 0, 0.14, -0.19));
      h.add(box(0.05, 0.13, 0.16, DARK, -0.175, 0.12, 0));
      h.add(box(0.05, 0.13, 0.16, DARK, 0.175, 0.12, 0));
      h.add(box(0.16, 0.06, 0.06, DARK, 0, 0.02, -0.18));           // mentonera
    } else if (v === 4) {   // FANTASMA: pasamontañas oscuro, goggles del equipo
      h.add(ball(0.183, DARK, 0, 0.14, 0, 1, 1.05, 1));
      h.add(box(0.24, 0.06, 0.06, tc, 0, 0.16, -0.19));             // goggles finos
      h.add(box(0.1, 0.05, 0.05, VISOR, 0, 0.03, -0.185));          // máscara
    } else {                // RECLUTA: el clásico
      h.add(ball(0.185, MID, 0, 0.14, 0, 1, 1.05, 1));
      h.add(box(0.24, 0.09, 0.06, VISOR, 0, 0.14, -0.19));
      h.add(box(0.06, 0.05, 0.05, tc, 0, 0.3, 0));                  // cresta
    }
  }

  // Detalles de pecho/extremidades por variante (≤3cm sobre la silueta).
  _variantExtras(tc, v) {
    const t = this.torso;
    if (v === 1) {
      t.add(box(0.2, 0.2, 0.03, MID, 0, 0.44, -0.195));             // placa central
    } else if (v === 2) {
      const strap = box(0.08, 0.42, 0.03, DARK, 0, 0.44, -0.2);     // correa cruzada
      strap.rotation.z = 0.65;
      t.add(strap);
    } else if (v === 3) {
      t.add(box(0.44, 0.06, 0.03, DARK, 0, 0.5, -0.2));             // listones de blindaje
      t.add(box(0.44, 0.06, 0.03, DARK, 0, 0.38, -0.2));
      this.legL.knee.add(ball(0.07, tc, 0, -0.06, -0.09));          // rodilleras
      this.legR.knee.add(ball(0.07, tc, 0, -0.06, -0.09));
    } else if (v === 4) {
      this.armR.shoulder.add(box(0.125, 0.06, 0.125, tc, 0, -0.09, 0)); // banda al brazo
      t.add(box(0.3, 0.05, 0.03, DARK, 0, 0.35, -0.2));             // cincho bajo
    }
  }

  // Impulso y pose de desparrame aleatorios para esta muerte.
  // ANCLA la posición de muerte: el cadáver se queda ahí (desliza <40cm),
  // peso muerto — nada de salir volando.
  _startRagdoll() {
    const yaw = this.root.rotation.y;
    const back = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const lat = Math.random() * 2 - 1;
    const spd = 0.6 + Math.random() * 0.6;
    const rnd = (a, b) => a + Math.random() * (b - a);
    this.rag = {
      bx: this.root.position.x, bz: this.root.position.z, byaw: yaw,
      by: this.root.position.y, vyy: 0, // caída vertical real (muerte en el aire)
      // suelo REAL bajo el cadáver: clavar a y=0 enterraba el cuerpo dentro
      // del bloque si moría parado sobre uno (groundFn lo inyecta quien
      // tiene el world: main / botmatch / addRemote)
      floorY: this.groundFn
        ? this.groundFn(this.root.position.x, this.root.position.z, this.root.position.y)
        : 0,
      ox: 0, oz: 0, oy: 0,
      vx: (back.x + right.x * lat * 0.8) * spd,
      vz: (back.z + right.z * lat * 0.8) * spd,
      vy: 0,
      ang: 0,
      hit: false, flopT: 0, // impacto contra el suelo → flop de extremidades
      fl: [rnd(0.15, 0.45), rnd(0.15, 0.45), rnd(0.1, 0.35), rnd(0.1, 0.35), rnd(0.25, 0.55), rnd(0.5, 1)],
      axis: Math.abs(lat) > 0.6 ? 'z' : 'x',
      angTarget: (Math.abs(lat) > 0.6 ? (lat > 0 ? -1 : 1) : 1) * (Math.PI / 2) * rnd(0.9, 1.05),
      tilt: rnd(-0.35, 0.35),
      spin: rnd(-0.5, 0.5),
      pose: [
        rnd(-0.2, 0.2), rnd(-0.3, 0.3), rnd(-0.4, 0.2), rnd(-0.4, 0.4),
        rnd(0.2, 0.9), rnd(0.4, 1.0), rnd(0.1, 0.6),
        rnd(0.2, 0.9), rnd(0.4, 1.0), rnd(0.1, 0.6),
        rnd(-0.2, 0.5), rnd(0.1, 0.4), rnd(-0.6, -0.1),
        rnd(-0.3, 0.4), rnd(-0.7, -0.2),
      ],
    };
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
    if (this._wep === wep) return;
    this._wep = wep;
    const act = wep === 'smg' ? this.gunSMG : this.gunShotgun;
    const back = wep === 'smg' ? this.gunShotgun : this.gunSMG;
    this.gunMount.add(act);
    act.position.set(0, 0, 0);
    act.rotation.set(0, 0, 0);
    this.backMount.add(back);
    back.position.set(0, 0, 0);
    back.rotation.set(0, 0, 0);
  }

  get activeGun() { return this._wep === 'smg' ? this.gunSMG : this.gunShotgun; }

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
      case 'run': case 'idle': default: { // default: estados desconocidos (red) caen a idle
        const m = p.state === 'run' ? 1 : 0;
        const tw = p.twist ?? 0; // torso/cabeza giran hacia la cámara
        R(this.torso, -0.1 * m + Math.sin(ph * 0.4) * 0.015, tw * 0.55, swing * 0.04 * m);
        R(this.head, 0.05 * m, tw * 0.35, 0);
        R(this.legL.hip, swing * 0.75 * m, 0, 0); R(this.legL.knee, -(Math.max(0, -swing) * 1.1 + 0.1) * m, 0, 0);
        R(this.legR.hip, swing2 * 0.75 * m, 0, 0); R(this.legR.knee, -(Math.max(0, -swing2) * 1.1 + 0.1) * m, 0, 0);
        leftOnGun = true;
        if (p.firing) {
          // blindfire de cadera: arma al frente SIN canteo, colineal al tiro
          damp = 18;
          M(0.15, -0.1, -0.26, 0, 0, 0);
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
        M(0.13, -0.12, -0.24, 0, 0, 0);
        set(this.aimRig.rotation, 'x', pitch); // apunta con la cámara en el aire
        set(this.aimRig.rotation, 'y', p.aimYawErr ?? 0);
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
        // (el pitch/yaw del tiro lo aplica el bloque post-switch del aimRig)
        if (p.firing) {
          damp = 16;
          M(0.15, -0.1, -0.26, 0, 0, 0);
        } else {
          M(0.07, -0.06, -0.2, 1.25, 0, 0.06);
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
        // ragdoll de PESO MUERTO en dos fases: rodillas que ceden y caída
        // ACELERADA por gravedad (tope seco), y al impactar un flop de
        // extremidades amortiguado (flexible, pero se apaga rápido = peso)
        if (!this.rag) this._startRagdoll();
        this.activeGun.visible = false; // el arma cae al suelo (WeaponDrops)
        damp = 3.2; // articulaciones flojas: van rezagadas detrás del cuerpo
        ikArms = false;
        const rg = this.rag;
        const rp = rg.pose;
        // flop al impactar: oscilación amortiguada, coeficiente por miembro
        const flop = rg.hit ? Math.sin(rg.flopT * 24) * Math.exp(-rg.flopT * 8) : 0;
        R(this.torso, rp[0] + flop * rg.fl[5] * 0.4, rp[1], 0);
        R(this.head, rp[2] + flop * rg.fl[4], 0, rp[3]);
        R(this.armL.shoulder, rp[4] + flop * rg.fl[0], 0, -Math.abs(rp[5]));
        R(this.armL.elbow, rp[6] + flop * rg.fl[0] * 0.7, 0, 0);
        R(this.armR.shoulder, rp[7] + flop * rg.fl[1], 0, Math.abs(rp[8]));
        R(this.armR.elbow, rp[9] + flop * rg.fl[1] * 0.7, 0, 0);
        R(this.legL.hip, rp[10] + flop * rg.fl[2], 0, rp[11]);
        R(this.legL.knee, rp[12], 0, 0);
        R(this.legR.hip, rp[13] + flop * rg.fl[3], 0, -rp[11]);
        R(this.legR.knee, rp[14], 0, 0);
        R(this.aimRig, 0, 0, 0);
        M(0.12, -0.18, -0.14, 0.4, 0, 0.2);
        break;
      }
    }
    if (p.state !== 'dead') this._deadT = 0;

    // ADS: postura pronunciada — arma al hombro, pitch completo de cámara.
    // roadie/blind_over excluidos: su brazo izq. es pose Euler y el IK de
    // aquí peleaba con ella (temblor) si un remoto llegaba con st+aim juntos
    if (p.aim && p.state !== 'dead' && p.state !== 'dive' && p.state !== 'slide' &&
        p.state !== 'roadie' && p.state !== 'blind_over') {
      damp = 18;
      leftOnGun = true;
      const lean = p.coverLean ?? 0; // asomarse en la orilla de pared alta
      R(this.aimRig, pitch, (p.aimYawErr ?? 0) * 0.9, lean * 0.1);
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
      // hipfire/blindfire: al DISPARAR, el arma apunta EXACTAMENTE a la línea
      // de tiro (pitch completo + corrección de yaw mientras el cuerpo gira);
      // relajado, solo sigue la mitad del pitch (ready natural)
      const yawErr = p.aimYawErr ?? 0;
      if (p.state === 'blind_over') {
        set(this.aimRig.rotation, 'x', pitch);
        set(this.aimRig.rotation, 'y', yawErr);
      } else if (p.state === 'cover_low' || p.state === 'cover_high') {
        set(this.aimRig.rotation, 'x', p.firing ? pitch : 0);
        set(this.aimRig.rotation, 'y', p.firing ? yawErr : 0);
      } else if (p.state === 'dive' || p.state === 'slide') {
        // sin target explícito, dive/slide heredaban el pitch/yaw del frame
        // anterior y el arma quedaba apuntando al cielo mientras ruedas
        set(this.aimRig.rotation, 'x', 0);
        set(this.aimRig.rotation, 'y', 0);
      } else if (p.state !== 'roadie' && p.state !== 'flip') {
        // (roadie y flip fijan su propio aimRig dentro del switch)
        set(this.aimRig.rotation, 'x', pitch * (p.firing ? 1 : 0.5));
        set(this.aimRig.rotation, 'y', p.firing ? yawErr : 0);
      }
      // el roll del lean de ADS no debe quedarse pegado en hipfire
      set(this.aimRig.rotation, 'z', 0);
    }

    // recarga solo en posturas con el arma al frente (en dive/slide/roadie/
    // blind_over el gunMount/brazo izq. tienen pose propia: pisarla inclinaba
    // el arma fuera de la mano) — misma whitelist que el IK de recarga
    const reloadPose = p.reloading &&
      (p.state === 'idle' || p.state === 'run' || p.state === 'jump' ||
       p.state === 'cover_low' || p.state === 'cover_high');

    // cambio de arma: el arma barre hacia el hombro/espalda y regresa
    // (el modelo se intercambia a mitad del gesto, en Weapons.update)
    if (p.swapping && p.state !== 'dead') {
      M(0.15, 0.28, 0.05, 1.5, 0, 0.35);
      set(this.aimRig.rotation, 'x', 0);
      set(this.aimRig.rotation, 'y', 0); // sin guiño lateral heredado del latch de tiro
    }

    // recarga: el arma se inclina y la mano izquierda baja al cargador
    if (reloadPose && p.state !== 'dead') {
      set(this.gunMount.rotation, 'x', -0.12);
      set(this.gunMount.rotation, 'z', 0.3);
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

    // vuelta en el aire alrededor de la cadera: eje según la dirección
    // ('z' = giro lateral Matrix, 'x' = backflip/frontflip)
    if (p.state === 'flip') {
      const ang = (p.flipT ?? 0) * Math.PI * 2;
      if ((p.flipAxis ?? 'z') === 'x') {
        this.hips.rotation.x = (p.flipDir ?? 1) * ang;
        this.hips.rotation.z = 0;
      } else {
        this.hips.rotation.z = -(p.flipDir ?? 1) * ang;
        this.hips.rotation.x = 0;
      }
    } else if (p.state !== 'dead') {
      this.hips.rotation.z = 0; // 2π ≡ 0: aterriza limpio
      this.hips.rotation.x = 0;
    }

    // física del ragdoll: peso muerto anclado al lugar de la muerte.
    // La rotación de caída ACELERA (gravedad) y para en seco contra el
    // suelo; ahí dispara el flop de extremidades del case 'dead'.
    if (p.state === 'dead' && this.rag) {
      const r = this.rag;
      const fr = Math.exp(-6 * dt);
      r.vx *= fr; r.vz *= fr;
      r.ox += r.vx * dt; r.oz += r.vz * dt;
      // el desplome de rodillas solo progresa CERCA del suelo: muriendo en el
      // aire el cuerpo apenas se ladea mientras cae y colapsa al aterrizar
      // (antes completaba el flop en el aire y bajaba rígido el resto)
      const onGround = r.by <= r.floorY + 0.08;
      if (r.ang < 1) {
        if (onGround) {
          r.ang = Math.min(1, r.ang + dt * (0.9 + r.ang * 7.5)); // cae acelerando
          if (r.ang >= 1 && !r.hit) { r.hit = true; r.flopT = 0; }
        } else {
          r.ang = Math.min(0.35, r.ang + dt * 0.6);
        }
      } else if (r.hit) {
        r.flopT += dt;
      }
      const fall = r.ang * r.ang; // ease-in: el desplome gana velocidad
      const a = fall * r.angTarget;
      if (r.axis === 'x') { this.hips.rotation.x = a; this.hips.rotation.z = r.tilt * fall; }
      else { this.hips.rotation.z = a; this.hips.rotation.x = r.tilt * fall; }
      // rodillas que ceden: la cadera baja con la caída (golpe, no flotación)
      this.hips.position.y = 0.66 - 0.37 * fall;
      // gravedad hasta el suelo REAL bajo el cadáver (bloques incluidos)
      if (r.by > r.floorY) {
        r.vyy -= 22 * dt;
        r.by = Math.max(r.floorY, r.by + r.vyy * dt);
      }
      this.root.position.set(r.bx + r.ox, r.by, r.bz + r.oz);
      this.root.rotation.y = r.byaw + r.spin * fall;
    } else if (p.state !== 'dead') {
      if (this.rag) {
        this.rag = null;
        this.gunSMG.visible = true;
        this.gunShotgun.visible = true;
        this.hips.position.y = 0.66; // sin "brotar" del suelo al revivir
      }
    }

    // IK: manos sobre el arma (después del damping, sobre la pose ya aplicada)
    if (ikArms) {
      this.root.updateWorldMatrix(true, true);
      const gun = this.activeGun;
      gun.userData.grip.getWorldPosition(TMP_A);
      this._ikArm(this.armR, 1, this.aimRig.worldToLocal(TMP_A));
      // el gesto de recarga solo aplica en posturas con el arma al frente
      // (misma whitelist que reloadPose, calculada arriba)
      const reloadIk = reloadPose;
      if (leftOnGun || reloadIk) {
        const a = reloadIk ? (gun.userData.mag ?? gun.userData.forend) : gun.userData.forend;
        a.getWorldPosition(TMP_B);
        const tgt = this.aimRig.worldToLocal(TMP_B);
        if (reloadIk) tgt.y -= 0.16 * Math.sin(Math.PI * (p.reloadT ?? 0));
        this._ikArm(this.armL, -1, tgt);
      }
    }
  }

  setTransform(x, z, yaw, y = 0) {
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
  }

  setVisible(v) { this.root.visible = v; }

  // Spawn protection: OUTLINE sutil del color del equipo — silueta de
  // contorno (backface escalado), no cubre el cuerpo
  setProtected(on) {
    if (this._prot === on) return;
    this._prot = on;
    if (on && !this._outlines) this._buildOutline();
    if (this._outlines) for (const o of this._outlines) o.visible = on;
  }

  _buildOutline() {
    this._outlineMat = new THREE.MeshBasicMaterial({
      color: TEAM_COLORS[this.team],
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.45,
    });
    const pairs = [];
    const collect = (node) => {
      if (node === this.gunMount || node === this.backMount || node === this.nameTag) return;
      if (node.isMesh) pairs.push(node);
      for (const c of node.children) collect(c);
    };
    collect(this.root);
    this._outlines = pairs.map((mesh) => {
      const o = new THREE.Mesh(mesh.geometry, this._outlineMat);
      o.position.copy(mesh.position);
      o.rotation.copy(mesh.rotation);
      o.scale.copy(mesh.scale).multiplyScalar(1.05);
      o.visible = false;
      mesh.parent.add(o);
      return o;
    });
  }

  dispose(scene) {
    scene.remove(this.root);
    const geos = new Set(), mats = new Set(), maps = new Set();
    this.root.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) geos.add(o.geometry);
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m.userData.shared) return;
          if (m.map && !m.map.userData.cached) maps.add(m.map);
          mats.add(m);
        });
      }
    });
    for (const g of geos) g.dispose();
    for (const t of maps) t.dispose(); // CanvasTexture única del nametag
    for (const m of mats) m.dispose();
  }
}
