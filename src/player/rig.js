// Personaje 100% procedural: proporciones compactas estilo Ratchet & Clank
// (torso grande, piernas cortas, antebrazos/manos grandes, silueta clara) y
// animador de poses por estado con osciladores para ciclos de carrera.
// Lo usan igual el jugador local y los remotos (los remotos lo alimentan con
// el estado que llega por red).
import * as THREE from 'three';

const TEAM_COLORS = { red: 0xd94f3f, blue: 0x4f8de0 };
const DARK = 0x33363c, MID = 0x565b63, VISOR = 0x15171c;

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

function buildLancer(teamColor) {
  const g = new THREE.Group();
  g.add(box(0.075, 0.13, 0.58, DARK, 0, 0, -0.14));          // cuerpo
  g.add(box(0.05, 0.05, 0.34, MID, 0, 0.02, -0.48));          // cañón
  g.add(box(0.06, 0.1, 0.07, teamColor, 0, 0.09, -0.28));     // detalle equipo
  g.add(box(0.05, 0.12, 0.06, DARK, 0, -0.11, 0.02));         // grip
  g.add(box(0.055, 0.16, 0.05, MID, 0, -0.12, -0.22));        // cargador
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.66);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

function buildGnasher(teamColor) {
  const g = new THREE.Group();
  g.add(box(0.09, 0.14, 0.46, DARK, 0, 0, -0.08));
  g.add(box(0.065, 0.065, 0.26, MID, 0, 0.03, -0.38));
  g.add(box(0.07, 0.1, 0.08, teamColor, 0, 0.08, -0.16));
  g.add(box(0.05, 0.13, 0.06, DARK, 0, -0.11, 0.06));
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, -0.52);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

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

    // aimRig: pivote a la altura del pecho; contiene ambos brazos para
    // poder inclinar todo el conjunto con el pitch de la cámara al apuntar.
    this.aimRig = new THREE.Group();
    this.aimRig.position.set(0, 0.5, 0);
    this.torso.add(this.aimRig);

    const mkArm = (side) => {
      const s = side === 'L' ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.36, 0, 0);
      this.aimRig.add(shoulder);
      shoulder.add(box(0.11, 0.24, 0.11, MID, 0, -0.12, 0));        // brazo
      const elbow = new THREE.Group();
      elbow.position.set(0, -0.25, 0);
      shoulder.add(elbow);
      elbow.add(box(0.14, 0.26, 0.14, DARK, 0, -0.13, 0));          // antebrazo grande
      const hand = new THREE.Group();
      hand.position.set(0, -0.3, 0);
      elbow.add(hand);
      hand.add(ball(0.105, tc, 0, -0.02, 0));                       // manota
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

    // armas en la mano derecha
    this.gunLancer = buildLancer(tc);
    this.gunGnasher = buildGnasher(tc);
    this.armR.hand.add(this.gunLancer);
    this.armR.hand.add(this.gunGnasher);
    for (const g of [this.gunLancer, this.gunGnasher]) {
      g.position.set(0, -0.06, -0.05);
    }
    this.gunGnasher.visible = false;

    // nametag (solo remotos)
    if (name) this._addNameTag(name, tc);

    this.phase = 0;
    this._recoil = 0;
    this._deadT = 0;
    this._cur = {}; // rotaciones actuales suavizadas
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
    const q = new THREE.Quaternion();
    this.activeGun.userData.muzzle.getWorldQuaternion(q);
    return out.set(0, 0, -1).applyQuaternion(q);
  }

  kick(amount) { this._recoil = Math.min(1.2, this._recoil + amount); }

  // p: {state, speed, aim, aimPitch, firing, dead}
  update(dt, p) {
    // targets keyed por objeto Euler; escritura posterior pisa la anterior
    const T = new Map();
    const set = (o, k, v) => {
      let e = T.get(o);
      if (!e) { e = {}; T.set(o, e); }
      e[k] = v;
    };
    const get = (o, k, fb = 0) => T.get(o)?.[k] ?? fb;
    const R = (grp, x = 0, y = 0, z = 0) => {
      set(grp.rotation, 'x', x); set(grp.rotation, 'y', y); set(grp.rotation, 'z', z);
    };

    let hipsY = 0.66, rootRotX = 0, damp = 12;
    const sp = p.speed; // 0..1
    this.phase += dt * (4.5 + sp * 8.5) * (sp > 0.02 ? 1 : 0);
    const ph = this.phase;
    const swing = Math.sin(ph), swing2 = Math.sin(ph + Math.PI);
    const bob = Math.abs(Math.cos(ph));

    // pose base por estado
    switch (p.state) {
      case 'roadie': {
        damp = 10;
        R(this.torso, 0.62, 0, Math.sin(ph * 0.5) * 0.04);
        R(this.head, -0.45, 0, 0);
        R(this.legL.hip, swing * 1.05, 0, 0); R(this.legL.knee, Math.max(0, -swing) * 1.5 + 0.2, 0, 0);
        R(this.legR.hip, swing2 * 1.05, 0, 0); R(this.legR.knee, Math.max(0, -swing2) * 1.5 + 0.2, 0, 0);
        R(this.armL.shoulder, swing2 * 0.9 - 0.3, 0, -0.25); R(this.armL.elbow, -1.3, 0, 0);
        R(this.armR.shoulder, 0.55, 0, 0.3); R(this.armR.elbow, -0.5, 0, 0); // arma abajo al costado
        R(this.armR.hand, 1.25, 0, 0);
        R(this.aimRig, 0, 0, 0);
        hipsY = 0.58 + bob * 0.06;
        break;
      }
      case 'run': case 'idle': {
        const m = p.state === 'run' ? 1 : 0;
        R(this.torso, 0.12 * m + Math.sin(ph * 0.4) * 0.015, 0, swing * 0.05 * m);
        R(this.head, -0.08 * m, 0, 0);
        R(this.legL.hip, swing * 0.75 * m, 0, 0); R(this.legL.knee, (Math.max(0, -swing) * 1.1 + 0.1) * m, 0, 0);
        R(this.legR.hip, swing2 * 0.75 * m, 0, 0); R(this.legR.knee, (Math.max(0, -swing2) * 1.1 + 0.1) * m, 0, 0);
        // arma en ready bajo, dos manos cerca
        R(this.armL.shoulder, -0.5 + swing2 * 0.25 * m, 0.35, -0.15);
        R(this.armL.elbow, -1.15, 0, 0);
        R(this.armR.shoulder, -0.55 + swing * 0.12 * m, -0.12, 0.08);
        R(this.armR.elbow, -0.85, 0, 0);
        R(this.armR.hand, 0.25, 0, 0);
        R(this.aimRig, 0, 0, 0);
        hipsY = 0.66 + bob * 0.045 * m;
        break;
      }
      case 'dive': {
        damp = 16;
        R(this.torso, 0.85, 0, 0);
        R(this.head, -0.5, 0, 0);
        R(this.legL.hip, 1.0, 0, 0); R(this.legL.knee, 1.5, 0, 0);
        R(this.legR.hip, 0.7, 0, 0); R(this.legR.knee, 1.3, 0, 0);
        R(this.armL.shoulder, -1.4, 0, -0.5); R(this.armL.elbow, -0.4, 0, 0);
        R(this.armR.shoulder, 0.4, 0, 0.4); R(this.armR.elbow, -0.6, 0, 0);
        hipsY = 0.45;
        break;
      }
      case 'slide': {
        damp = 16;
        R(this.torso, -0.18, 0, 0.12);
        R(this.head, 0.1, 0, 0);
        R(this.legL.hip, -1.15, 0, 0); R(this.legL.knee, 0.35, 0, 0); // pierna extendida
        R(this.legR.hip, -0.5, 0, 0); R(this.legR.knee, 1.35, 0, 0);  // pierna doblada
        R(this.armL.shoulder, 0.9, 0, -0.7); R(this.armL.elbow, -0.3, 0, 0); // brazo atrás
        R(this.armR.shoulder, -0.9, 0, 0.2); R(this.armR.elbow, -1.0, 0, 0);
        hipsY = 0.38;
        break;
      }
      case 'cover_low': {
        R(this.torso, 0.16, 0, 0);
        R(this.head, -0.05, 0, 0);
        R(this.legL.hip, -1.35 + swing * 0.2 * sp, 0, 0); R(this.legL.knee, 1.8, 0, 0);
        R(this.legR.hip, -1.2 + swing2 * 0.2 * sp, 0, 0); R(this.legR.knee, 1.75, 0, 0);
        // arma vertical al pecho (icónico)
        R(this.armL.shoulder, -0.45, 0.5, -0.2); R(this.armL.elbow, -1.5, 0, 0);
        R(this.armR.shoulder, -1.75, 0, 0.15); R(this.armR.elbow, -1.55, 0, 0);
        R(this.armR.hand, -0.4, 0, 0);
        hipsY = 0.34;
        break;
      }
      case 'cover_high': {
        R(this.torso, 0.06, 0, 0);
        R(this.legL.hip, -0.15, 0, 0); R(this.legL.knee, 0.25, 0, 0);
        R(this.legR.hip, 0.1, 0, 0); R(this.legR.knee, 0.15, 0, 0);
        R(this.armL.shoulder, -0.45, 0.5, -0.2); R(this.armL.elbow, -1.5, 0, 0);
        R(this.armR.shoulder, -1.75, 0, 0.15); R(this.armR.elbow, -1.55, 0, 0);
        R(this.armR.hand, -0.4, 0, 0);
        hipsY = 0.6;
        break;
      }
      case 'blind_over': {
        damp = 15;
        R(this.torso, -0.12, 0, 0);
        R(this.head, 0.35, 0, 0);
        R(this.legL.hip, -1.3, 0, 0); R(this.legL.knee, 1.75, 0, 0);
        R(this.legR.hip, -1.15, 0, 0); R(this.legR.knee, 1.7, 0, 0);
        R(this.armL.shoulder, -0.6, 0.4, -0.3); R(this.armL.elbow, -1.2, 0, 0);
        R(this.armR.shoulder, -2.5, 0, 0.1); R(this.armR.elbow, -0.15, 0, 0); // brazo estirado sobre el cover
        R(this.armR.hand, Math.PI / 2 - 0.15, 0, 0);
        hipsY = 0.4;
        break;
      }
      case 'dead': {
        damp = 8;
        this._deadT += dt;
        rootRotX = -Math.min(1, this._deadT * 4) * Math.PI / 2;
        R(this.torso, 0, 0, 0); R(this.head, 0, 0, 0.3);
        R(this.armL.shoulder, -0.4, 0, -0.9); R(this.armR.shoulder, -0.3, 0, 0.9);
        R(this.legL.hip, 0.2, 0, 0); R(this.legR.hip, -0.1, 0, 0);
        hipsY = 0.66;
        break;
      }
    }
    if (p.state !== 'dead') this._deadT = 0;

    // apuntar: pisa la pose de brazos con arma al hombro + pitch
    if (p.aim && p.state !== 'dead' && p.state !== 'dive' && p.state !== 'slide') {
      damp = 18;
      const pitch = p.aimPitch ?? 0;
      R(this.aimRig, -pitch, 0, 0);
      R(this.torso, 0.08 + get(this.torso.rotation, 'x') * 0.3, -0.12, 0);
      R(this.head, -pitch * 0.4, 0, 0);
      R(this.armR.shoulder, -1.32, -0.1, 0.12); R(this.armR.elbow, -0.28, 0, 0);
      R(this.armR.hand, -0.18, 0, 0);
      R(this.armL.shoulder, -1.15, 0.55, -0.1); R(this.armL.elbow, -0.75, 0, 0);
      if (p.state === 'cover_low') hipsY = 0.56; // popover: se levanta
    } else if (p.state !== 'dead') {
      // hipfire: el torso sigue un poco el pitch para poder disparar "del cañón"
      const pitch = (p.aimPitch ?? 0) * 0.45;
      set(this.aimRig.rotation, 'x', -pitch);
    }

    // recoil
    this._recoil = Math.max(0, this._recoil - dt * 6);
    this.aimRig.position.z = this._recoil * 0.06;

    // aplicar targets con damping
    const k = 1 - Math.exp(-damp * dt);
    for (const [o, props] of T) {
      for (const prop in props) o[prop] += (props[prop] - o[prop]) * k;
    }
    this.hips.position.y += (hipsY - this.hips.position.y) * k;
    this.root.rotation.x += (rootRotX - this.root.rotation.x) * (1 - Math.exp(-10 * dt));
  }

  setTransform(x, z, yaw) {
    this.root.position.x = x;
    this.root.position.z = z;
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
