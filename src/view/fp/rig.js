// Viewmodel de Breach: agarres en el espacio del arma y mangas desde la
// muñeca. El guante usa −Z para los dedos y +Y para el dorso.
import * as THREE from 'three';
import { ARMS, LEFT_CHANNELS } from './profiles.js';

const _m = new THREE.Matrix4();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler(0, 0, 0, 'YXZ');

// Base ortonormal (eje, palma, eje×palma) como matriz de rotación.
function basis(axis, palm, out) {
  _a.copy(axis).normalize();
  _b.copy(palm).addScaledVector(_a, -palm.dot(_a)).normalize();
  _c.crossVectors(_a, _b);
  return out.makeBasis(_a, _b, _c);
}

// La bolsa del bote, su preparación y la extensión de la mano quedan a
// la izquierda del arma. La cartuchera de la escopeta está en el propio cajón.
const salidaPorDebajo = [-.09, -.19, 0];
const gestosBote = { pouch: [-.105,-.285,-.32], wind: [-.16,-.13,-.24], out: [-.125,-.15,-.53] };

// El guante pasa por fuera del contorno antes de cerrarse. El arco se
// expresa en el marco del arma y llega a cero en ambos puntos de contacto.
function rodear(posicion, curva, progreso, fuerza, giro) {
  if (!curva || !fuerza || progreso <= 0 || progreso >= 1) return;
  const peso = Math.sin(Math.PI * progreso);
  _a.fromArray(curva).addScaledVector(_e.fromArray(curva, 3), 2 * progreso - 1);
  posicion.addScaledVector(_a.applyQuaternion(giro), fuerza * peso);
}

// Frena antes de llegar a una pieza móvil. Se limita también la aceleración
// cuando se cancela el gesto y cambia el destino en mitad del recorrido.
function seguirContacto(pos, velocidad, anterior, destino, dt) {
  const aceleracion = 65;
  const objetivo = _a.copy(destino).sub(anterior).multiplyScalar(1 / dt);
  const error = _b.copy(anterior).sub(pos);
  const distancia = error.length(), freno = aceleracion * dt / 2;
  const rapidez = Math.sqrt(2 * aceleracion * distancia + freno * freno) - freno;
  error.multiplyScalar(Math.min(1 / dt, rapidez / Math.max(distancia, 1e-9)));
  velocidad.add(error.add(objetivo).sub(velocidad).clampLength(0, aceleracion * dt));
  pos.addScaledVector(velocidad, dt);
}

export class ArmRig {
  /**
   * Cada mano aporta el centro de contacto y los ejes del guante exportado.
   * art.fore: longitud del antebrazo en la malla.
   */
  constructor(hands, art = { fore: 0.31 }) {
    this.hands = hands; this.art = art;
    this.profile = null; this.s = 1; this.hs = 1;
    this.anchors = null;
    // marcos de agarre de cada mano en su espacio local (sin escala)
    this.handGrip = {};
    for (const side of ['R', 'L']) {
      const g = hands[side].grip;
      const rot = basis(new THREE.Vector3(...g.axis), new THREE.Vector3(...g.palm), new THREE.Matrix4());
      this.handGrip[side] = { wrist: new THREE.Vector3(...(g.wrist ?? [0, 0, 0])), inv: rot.transpose(), center: new THREE.Vector3(...g.center) };
    }
    // estado por cuadro (todo preasignado)
    this.gunPos = new THREE.Vector3(); this.gunQuat = new THREE.Quaternion();
    this.out = {};
    for (const side of ['R', 'L']) {
      this.out[side] = {
        elbow: new THREE.Vector3(), wrist: new THREE.Vector3(), wristQuat: new THREE.Quaternion(),
        fore: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
        hand: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
        side: side === 'R' ? 1 : -1,
        target: new THREE.Vector3(), // dónde DEBE estar el centro del agarre (prueba de contacto)
      };
    }
    this.rightTravel = new THREE.Vector3();
    this.rightVelocity = new THREE.Vector3();
    this.rightPrevious = new THREE.Vector3();
    this.supportDirection = new THREE.Vector3();
    this.leftWeights = new Float64Array(5);
    this.frames = { R: new Map(), L: new Map() };
    // mano izquierda suavizada EN EL MARCO DEL ARMA (no se queda atrás con el
    // retroceso; solo se suaviza el cambio de objetivo)
    this.lPos = new THREE.Vector3(); this.lVel = new THREE.Vector3(); this.lQuat = new THREE.Quaternion(); this.lInit = false;
    this._pt = new THREE.Vector3(); this._off = new THREE.Vector3(); this._loc = new THREE.Vector3();
    this._acc2 = new THREE.Vector3(); this._tv = new THREE.Vector3(); this._prevLoc = new THREE.Vector3(); this._qa = new THREE.Quaternion(); this._qi = new THREE.Quaternion();
  }

  setProfile(profile, anchors) {
    this.profile = profile; this.s = profile.scale; this.hs = profile.scale / (this.art.mounts?.[profile.model] ?? 1); this.anchors = anchors;
    this.rightScale = this.hs * (profile.triggerArm?.scale ?? 1);
    this.leftScale = this.hs * (profile.supportArm?.scale ?? 1);
    for (const side of ['R', 'L']) {
      const frames = this.frames[side];
      frames.clear();
      for (const spec of Object.values(profile.targets)) {
        // Transformación escrita en el perfil, independiente de cámara y manga.
        const rot = basis(_d.fromArray(spec.axis), _e.fromArray(spec.palm), _m);
        frames.set(spec, new THREE.Quaternion().setFromRotationMatrix(rot.multiply(this.handGrip[side].inv)));
      }
    }
    this.lInit = false;
  }

  // punto del modelo del arma (+ desplazamiento opcional) → cámara
  gunPoint(m, out, off) {
    const g = this.anchors.grip;
    const ox = off ? off[0] : 0, oy = off ? off[1] : 0, oz = off ? off[2] : 0;
    return out.set((m[0] + ox - g[0]) * this.s, (m[1] + oy - g[1]) * this.s, (m[2] + oz - g[2]) * this.s).applyQuaternion(this.gunQuat).add(this.gunPos);
  }

  /** Marco de la mano (pos de su origen + rotación) para un objetivo del perfil. */
  handFrameFor(side, spec, outPos, outQuat) {
    const hg = this.handGrip[side];
    if (spec.anchor) this.gunPoint(this.anchors[spec.anchor], _d, spec.off);
    else _d.fromArray(spec.cam);
    outQuat.copy(this.frames[side].get(spec));
    if (spec.anchor) outQuat.premultiply(this.gunQuat);
    // El punto sostenido queda en el centro de los dedos aun al girar el guante.
    outPos.copy(hg.center).multiplyScalar(side === 'L' ? this.leftScale : this.rightScale).applyQuaternion(outQuat).negate().add(_d);
    return outPos;
  }

  /**
   * gun: [px,py,pz, rx,ry,rz] del ancla grip (anim.out.gun); a = anim.out.
   * Coloca las manos y extiende las mangas desde las muñecas.
   */
  update(dt, gun, a) {
    const p = this.profile;
    // pausa: con dt = 0 las manos se quedan donde están (bit a bit)
    if (!(dt > 0) && this.lInit) return;
    if (p.supportArm) {
      this.supportDirection.fromArray(p.supportArm.elbowDirection)
        .lerp(_d.fromArray(p.supportArm.elbowDirectionADS), a.aim ?? 0);
    }
    this.gunPos.set(gun[0], gun[1], gun[2]);
    this.gunQuat.setFromEuler(_eu.set(gun[3], gun[4], gun[5], 'YXZ'));
    // Dominante en la empuñadura hasta que alcance el cerrojo.
    const R = this.out.R;
    this.handFrameFor('R', p.targets[p.grips.right.target], R.hand.pos, R.hand.quat);
    this.gunPoint(this.anchors[p.targets[p.grips.right.target].anchor], R.target, p.targets[p.grips.right.target].off);
    // El pomo se desplaza y gira alrededor del pivote real del cerrojo.
    this.boltWeight = a.boltHand ?? 0;
    if (this.boltWeight) {
      const spec = p.targets.bolt;
      this.handFrameFor('R', spec, this._pt, this._qa);
      const pivot = this.gunPoint(p.parts.boltPivot, this._loc);
      const rot = _q.setFromAxisAngle(_a.set(0, 0, 1).applyQuaternion(this.gunQuat), (p.parts.anim.bolt.giroFP ?? p.parts.anim.bolt.rot[2]) * (a.parts?.bolt ?? 0));
      this._pt.sub(pivot).applyQuaternion(rot).add(pivot)
        .addScaledVector(_a.fromArray(p.parts.boltAxis).applyQuaternion(this.gunQuat), this.s * a.bolt * p.parts.boltTravel);
      R.hand.pos.lerp(this._pt, this.boltWeight);
      // La mano rodea el cajón por detrás al pasar al pomo del lado opuesto.
      const arco = Math.sin(Math.PI * this.boltWeight) * this.s;
      const curva = p.parts.arcoCerrojo;
      _a.fromArray(curva).addScaledVector(_e.fromArray(curva, 3), 2 * this.boltWeight - 1);
      // A media altura la muñeca rodea el costado libre del cajón.
      const medio = Math.sin(Math.PI * this.boltWeight) ** 2;
      _a.addScaledVector(_e.fromArray(p.parts.pasoCerrojo), medio);
      R.hand.pos.addScaledVector(_a.applyQuaternion(this.gunQuat), arco);
      R.hand.quat.slerp(this._qa.premultiply(rot), this.boltWeight);
      R.target.copy(this.handGrip.R.center).multiplyScalar(this.rightScale).applyQuaternion(R.hand.quat).add(R.hand.pos);
    }
    if (p.scope && dt > 0) {
      const destino = this._loc.copy(R.target).sub(this.gunPos).applyQuaternion(_q.copy(this.gunQuat).invert());
      if (!this.lInit) {
        this.rightTravel.copy(destino);
        this.rightVelocity.set(0, 0, 0);
      } else {
        seguirContacto(this.rightTravel, this.rightVelocity, this.rightPrevious, destino, dt);
      }
      // Al cerrar la pinza, la traslación de la palanca se transmite sin
      // retraso del resorte, igual que el recorrido de la bomba.
      const fijacion = THREE.MathUtils.smoothstep(this.boltWeight, .97, .999);
      if (fijacion) this.rightTravel.lerp(destino, fijacion);
      this.rightPrevious.copy(destino);
      R.hand.pos.copy(this.rightTravel).applyQuaternion(this.gunQuat).add(this.gunPos)
        .sub(_a.copy(this.handGrip.R.center).multiplyScalar(this.rightScale).applyQuaternion(R.hand.quat));
    }
    // izquierda: mezcla de objetivos
    const Lo = this.out.L;
    let first = null, movingContact = 0;
    let qx = 0, qy = 0, qz = 0, qw = 0;
    const tgtPt = Lo.target.set(0, 0, 0);
    const apoyo = a.left[0];
    const libera = THREE.MathUtils.smoothstep(1 - apoyo, 0, p.supportArm.desenrollar ?? .009);
    // Primero se desenrollan los dedos. Después se desplaza la muñeca.
    const apoyoFijo = p.targets.forend.anchor && p.grips.left.pose !== 'libre';
    const ocupar = apoyoFijo && apoyo < 1 ? 1 - THREE.MathUtils.smoothstep(1 - apoyo, .12, 1) : apoyo;
    this.retiro = !p.thrown ? THREE.MathUtils.smoothstep(1-apoyo, 0, p.supportArm.apertura ?? .13)
      * (1 - THREE.MathUtils.smoothstep(1-apoyo, .64, .98)) * (p.supportArm.extension ?? 1) : 0;
    for (let i = 0; i < LEFT_CHANNELS.length; i++) {
      let w = a.left[i];
      if (w < 1e-4) continue;
      if (!p.thrown) w *= (i === 0)
        ? ocupar / Math.max(apoyo, 1e-8) : (1 - ocupar) / Math.max(1 - apoyo, 1e-8);
      const spec = p.targets[LEFT_CHANNELS[i]] ?? p.targets.forend;
      if (p.parts.boltAxis && spec.anchor === p.parts.bolt && p.targets.forend.anchor === spec.anchor) movingContact += w;
      const q = _q.copy(this.frames.L.get(spec));
      if (spec.anchor) q.premultiply(this.gunQuat);
      if (p.parts.giroCartuchera && LEFT_CHANNELS[i] === 'pouch' && a.action === 'reload') {
        // Una vez libre del apoyo se presenta la ojiva de perfil.
        const giro = p.parts.giroCartuchera * (1 - THREE.MathUtils.smoothstep(apoyo, .1, .35));
        q.premultiply(this._qi.setFromAxisAngle(_a.set(0, 1, 0), giro));
      }
      if (!first) first = this._qa.copy(q);
      const signedWeight = q.dot(first) < 0 ? -w : w;
      qx += q.x * signedWeight; qy += q.y * signedWeight; qz += q.z * signedWeight; qw += q.w * signedWeight;
      if (spec.anchor) this.gunPoint(this.anchors[spec.anchor], this._pt, spec.off); else this._pt.set(...spec.cam);
      const bote = p.apoyoLanzamiento?.[LEFT_CHANNELS[i]] ?? gestosBote[LEFT_CHANNELS[i]];
      if (!p.thrown && bote && a.manoLanzamiento) this._pt.lerp(_a.fromArray(bote), a.manoLanzamiento);
      tgtPt.addScaledVector(this._pt, w);
    }
    const qa = this._qa.set(qx, qy, qz, qw).normalize();
    // desplazamiento de la pista (marco del arma, m del modelo)
    const off = this._off.set(a.lOff[0] * this.s, a.lOff[1] * this.s, a.lOff[2] * this.s).applyQuaternion(this.gunQuat);
    // Al cerrar los dedos en la bomba, su desplazamiento proviene del hueso móvil.
    // La curva de viaje puede rebasar el cero al volver al apoyo. Al
    // asentarse la mano, los dedos acompañan la superficie rígida.
    const seated = apoyoFijo ? THREE.MathUtils.smoothstep(apoyo, 0.95, 0.999) : 0;
    tgtPt.addScaledVector(off, (1 - seated) * (1 - movingContact));
    // El ancla de una corredera viaja con la pieza móvil.
    const travel = movingContact * (a.bolt ?? 0) * (p.parts.boltTravel ?? 0);
    // Entre dos agarres, la muñeca pasa bajo las piezas que sobresalen
    // del cajón. El arco se anula en ambos extremos del recorrido.
    if (apoyoFijo) {
      const arco = Math.sin(Math.PI * apoyo) * this.s * libera;
      tgtPt.addScaledVector(_a.fromArray(p.supportArm.salida ?? salidaPorDebajo).applyQuaternion(this.gunQuat), arco);
    }
    // En la última parte de la inserción la munición sale de la pinza y
    // entra en el alojamiento. Los nudillos se quedan fuera de su ventana.
    if (p.parts.presentacion) {
      tgtPt.addScaledVector(_a.fromArray(p.parts.presentacion).applyQuaternion(this.gunQuat), this.s * a.left[1]);
    }
    // Al lanzar un bote con un arma equipada, el guante rodea la carcasa
    // por caminos distintos al salir de la empuñadura y al recuperar el apoyo.
    if (p.arcoLanzamiento && a.manoLanzamiento && apoyo > 0 && apoyo < 1) {
      const curva = p.arcoLanzamiento[Number(a.left[5] > .000001)];
      const peso = Math.sin(Math.PI * apoyo) ** .85 * a.manoLanzamiento
        * libera;
      _a.fromArray(curva).addScaledVector(_e.fromArray(curva, 3), 2 * (apoyo - .65));
      tgtPt.addScaledVector(_a.applyQuaternion(this.gunQuat), this.s * peso);
    }
    const paso = p.despeje;
    if (paso) {
      const lanza = a.manoLanzamiento ?? 0;
      const apertura = p.supportArm.desenrollar ? libera : 1;
      rodear(tgtPt, paso.recarga, apoyo, this.s * (1 - lanza) * apertura, this.gunQuat);
      rodear(tgtPt, paso.lanzamiento, apoyo, this.s * lanza * apertura, this.gunQuat);
      if (a.left[2] > 0) rodear(tgtPt, paso.transporte, a.left[1], this.s, this.gunQuat);
      if (a.left[1] > .96) rodear(tgtPt, paso.brocal, a.mag, this.s, this.gunQuat);
    }
    const qi = this._qi.copy(this.gunQuat).invert();
    const loc = this._loc.copy(tgtPt).sub(this.gunPos).applyQuaternion(qi);
    // La pinza que transporta el cartucho se separa de la bomba antes de
    // acelerar. La muñeca conserva su velocidad si se interrumpe la recarga.
    if (p.reload.perShell && a.pasoMuneca) loc.addScaledVector(_e.fromArray(a.pasoMuneca), this.hs / 1000);
    const relQ = qa.premultiply(qi);
    if (!this.lInit) {
      this.lPos.copy(loc);
      this.lVel.set(0, 0, 0);
      this.lQuat.copy(relQ);
      this.lInit = true;
    } else {
      seguirContacto(this.lPos, this.lVel, this._prevLoc, loc, dt);
      const ang = this.lQuat.angleTo(relQ), lim = 9 * dt;
      const step = Math.min(lim, Math.max(lim * 0.25, ang * (1 - Math.exp(-22 * dt))));
      if (ang > 1e-6) this.lQuat.rotateTowards(relQ, step);
    }
    if (p.thrown && a.action === 'throw') {
      // La pinza se acerca por el costado libre de la anilla y sale con ella.
      // Ambos recorridos coinciden en el asiento, donde se detiene la muñeca.
      const recorrido = p.parts.anilla?.[Number(a.parts.pin > 0)];
      if (recorrido) {
        const peso = a.left[3];
        const arco = Math.sin(Math.PI * Math.min(1, peso)) ** (2 / 3);
        _a.fromArray(recorrido).addScaledVector(_e.fromArray(recorrido, 3), 4 * (peso - .9));
        loc.addScaledVector(_a, this.s * arco);
      }
      // La pinza tiene una trayectoria con parada en la anilla. Guardar
      // su velocidad permite que un cambio interrumpa el gesto sin salto.
      this.lVel.copy(loc).sub(this._prevLoc).multiplyScalar(1 / Math.max(dt, 1e-6));
      this.lPos.copy(loc);
      this.lQuat.copy(relQ);
    }
    // La mano termina el giro bajo la tapa antes de asentarla con la palma.
    if (p.grips.left.pose === 'libre' && a.action === 'reload') {
      const union = THREE.MathUtils.smoothstep(a.left[1] + a.left[3], .12, .95);
      this.lQuat.slerp(relQ, union);
    }
    this._prevLoc.copy(loc);
    const lp = Lo.hand.pos.copy(this.lPos).applyQuaternion(this.gunQuat).add(this.gunPos);
    if (travel) {
      this._off.fromArray(p.parts.boltAxis).applyQuaternion(this.gunQuat).multiplyScalar(travel * this.s);
      tgtPt.add(this._off);
      lp.add(this._off);
    }
    const free = p.thrown ? 1 - a.left[3] : p.targets.forend.anchor ? 1 - apoyo : 1;
    lp.x += a.lLag[0] * free;
    lp.y += a.lLag[1] * free;
    Lo.hand.quat.copy(this.gunQuat).multiply(this.lQuat);
    const contact = p.thrown ? THREE.MathUtils.smoothstep(a.left[3], .7, .99)
      : THREE.MathUtils.smoothstep(apoyo, 0.55, 0.998);
    Lo.hand.quat.slerp(_q.copy(this.gunQuat).multiply(relQ), contact);
    // El resorte sigue el contacto. Girar un guante grande alrededor de la
    // muñeca desplazaría los dedos aunque el objetivo estuviera inmóvil.
    lp.sub(_e.copy(this.handGrip.L.center).multiplyScalar(this.leftScale).applyQuaternion(Lo.hand.quat));
    // Las poses se mezclan en ángulos articulares, antes de aplicar la FK.
    const pinch = p.thrown || a.magHide ? 0 : THREE.MathUtils.smoothstep(a.mag ?? 0, 0.35, 0.98);
    const seat = p.thrown ? 0 : THREE.MathUtils.smoothstep(apoyo, 0.75, 0.998) * (1 - pinch);
    const weights = this.leftWeights;
    for (let i = 0; i < weights.length; i++) weights[i] = a.lCurl[i] * (1 - pinch - seat);
    weights[0] += seat;
    weights[1] += pinch;
    for (const side of ['R', 'L']) this.solve(side, a.aim);
  }

  // La manga parte de la bocamanga del guante. El extremo proximal queda
  // bajo la ventana del jugador y conserva la sección del brazal del soldado.
  solve(side, aim = 0) {
    const o = this.out[side];
    const support = side === 'L' ? this.profile.supportArm : this.profile.triggerArm;
    const scale = side === 'L' ? this.leftScale : this.rightScale;
    const W = o.wrist.copy(this.handGrip[side].wrist).multiplyScalar(scale).applyQuaternion(o.hand.quat).add(o.hand.pos);
    // La dirección de la manga se elige en el marco de la mano. El borde
    // inferior fija su longitud visible, nunca el ángulo de la muñeca.
    const wristQuat = o.wristQuat.copy(o.hand.quat);
    const inverse = _q.copy(wristQuat).invert();
    const depth = Math.max(0.08, -W.z);
    const back = _e;
    // El codo de CRASHTERRA es un punto fijo de cámara. La muñeca sigue
    // el guardamanos incluso al bombear o levantar el arma para recargar.
    if (support && side === 'L') back.copy(this.supportDirection);
    else if (support) {
      back.fromArray(support.elbowDirection);
      if (support.direccionAlApuntar) back.lerp(_d.fromArray(support.direccionAlApuntar), aim);
    }
    else if (this.profile.thrown) back.set((o.side > 0 ? 0.72 : -0.12) - W.x / depth * 0.32, -1, 0.4);
    else back.fromArray(side === 'L' ? this.profile.elbowL ?? ARMS.elbows.L : ARMS.elbows.R).sub(W);
    back.normalize().applyQuaternion(inverse);
    // La junta gira como máximo quince grados respecto al eje del guante.
    const lateral = Math.hypot(back.x, back.y);
    const limite = Math.tan(14.5 * Math.PI / 180);
    if (lateral > limite * back.z) back.set(back.x * limite / (lateral || 1), back.y * limite / (lateral || 1), 1);
    back.normalize().applyQuaternion(wristQuat);
    // El puño solapa el brazal hasta el plano de la bocamanga.
    const sleeveScale = support ? this.hs * support.sleeveScale : this.hs;
    const inset = support?.cuffInset ?? 0;
    const cuff = THREE.MathUtils.lerp(inset, support?.cuffInsetADS ?? inset, aim);
    const length = (this.art.fore - cuff) * sleeveScale;
    const E = o.elbow.copy(W).addScaledVector(back, length);
    const twist = support ? support.twist : ARMS.twist[side];
    // El exportador expresa guante y brazal en el mismo marco. Transportar
    // ese marco a la dirección del antebrazo respeta el giro de la muñeca.
    _a.set(0, 0, -1).applyQuaternion(wristQuat);
    _b.copy(W).sub(E).normalize();
    _q.setFromUnitVectors(_a, _b);
    _e.set(1, 0, 0).applyQuaternion(wristQuat).applyQuaternion(_q);
    this._bone(o.fore, E, W, _e, twist, sleeveScale);
    if (support?.boca) {
      // El centro de la tapa coincide con el asiento incluso al sacar el cargador.
      o.fore.pos.copy(W).add(_a.fromArray(support.asiento).multiplyScalar(scale).applyQuaternion(o.hand.quat))
        .sub(_b.fromArray(support.boca).multiplyScalar(sleeveScale).applyQuaternion(o.fore.quat));
      E.copy(o.fore.pos);
    }
    o.hand.scale.setScalar(scale);
  }

  _bone(b, from, to, nx, twist, scale) {
    const y = _a.copy(from).sub(to).normalize();
    const xx = _b.copy(nx).addScaledVector(y, -nx.dot(y)).normalize();
    if (twist) xx.applyAxisAngle(y, twist);
    // En posición neutra el canto del pulgar queda arriba. Medimos el
    // giro de la manga alrededor de su propio eje en ese plano transversal.
    const neutral = _d.set(0, -1, 0).addScaledVector(y, y.y);
    if (neutral.lengthSq() > 1e-8) {
      neutral.normalize();
      const roll = Math.atan2(_c.crossVectors(neutral, xx).dot(y), neutral.dot(xx));
      const limit = 85 * Math.PI / 180;
      xx.applyAxisAngle(y, THREE.MathUtils.clamp(roll, -limit, limit) - roll);
    }
    const z = _c.crossVectors(xx, y);
    _m.makeBasis(xx, y, z);
    b.quat.setFromRotationMatrix(_m);
    b.pos.copy(from);
    b.scale.setScalar(scale);
  }
}

