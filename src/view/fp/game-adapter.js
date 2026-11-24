// Puente juego → arma en primera persona: arma el `state` del CONTRATO §5
// con el estado real (jugador, armas, cámara) y reenvía los eventos del
// emisor de `Weapons` (CONTRATO §4) al viewmodel. Lo usa first-person.js
// mientras main.js llame a su API; el integrador puede usarlo directamente.
//
// Fuente de eventos: el emisor de src/combat/weapons.js (fire, dry,
// reload*, swap*, meleeStart/Hit, throwStart/Release). Lo que el emisor aún
// no publica (aterrizaje y daño recibido) se deduce aquí.
import * as THREE from 'three';
import { createViewModel } from './viewmodel.js';
import { hasProfile, PROFILES } from './profiles.js';
import { TUNING } from '../../config/tuning.js';
import { SWAP_TIME } from '../../combat/weapons.js';
import { setLocalEjectSource, requestLocalEject } from '../../fx/effects.js';
import { VM_FILL } from './material.js';
import { motionScale } from '../../core/settings.js';

// arma → suceso que expulsa la vaina (si no es el disparo)
const EJECT_ON = { sniper: 'boltOpen' };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const angleDelta = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const FORWARD = ['fire', 'dry', 'reloadStart', 'reloadStep', 'reloadEnd', 'reloadCancel',
  'swapStart', 'swapMid', 'swapEnd', 'swapCancel', 'meleeStart', 'meleeHit', 'throwStart', 'throwRelease'];

export class FpAdapter {
  /** ctx: { scene, camera, world, G } */
  constructor(ctx, assets = null) {
    this.ctx = ctx;
    this.vm = createViewModel({ scene: ctx.scene, camera: ctx.camera, team: ctx.G?.team ?? 'red', variant: ctx.G?.charVariant ?? 0, assets });
    this.ready = false;
    // la pista del arma pide la expulsión (escopeta: al bombear, no al disparar)
    // expulsión fuera del disparo: la pista lo pide ('eject', bombeo) o un paso
    // de recarga del perfil (`ejectOn`; el cerrojo del sniper: 'boltOpen')
    this.vm.onAnimEvent = (name, key) => {
      if (!this.active) return;
      const on = PROFILES[key]?.ejectOn ?? EJECT_ON[key] ?? 'eject';
      if (name === on) requestLocalEject(key);
    };
    this.vm.ready.then(() => { this.ready = true; }).catch((e) => console.warn('[fp] viewmodel sin cargar:', e));
    this.active = false;
    this.state = { aim01: 0, speed: 0, sprint: false, crouch01: 0, lean: 0, airborne: false, landed: 0, hurtDir: null,
      reloadT: 0, swapping: 0, throwT: 0, meleeT: 0, dazed: false, wallNear: 0, slide: false, mantle: false,
      yawRate: 0, pitchRate: 0, fireHeld: false, runSpeed: TUNING.move?.runSpeed ?? 4.8 };
    this._weapons = null; this._unsub = [];
    this._prevYaw = null; this._prevPitch = 0;
    this._wasGrounded = true; this._minVy = 0;
    this._hp = null; this._t = 0; this._lastFire = -1; this._drawAt = -1;
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this.source = 'ninguna';
    // casquillos del jugador desde la ventana de expulsión, a tamaño real
    this._opticalAxis = new THREE.Vector3(0, 0, -1);
    this._ej = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), barrel: new THREE.Vector3(), backblast: null, noCasing: false, aim: 0 };
    this._bb = new THREE.Vector3();
    setLocalEjectSource(() => (this.active ? (this.vm.ejectWorld(this._ej.pos, this._ej.dir), this.vm.barrelWorld(this._ej.barrel), this._ej.aim = this.vm.anim?.aim ?? 0, this._fillEject(), this._ej) : null));
  }

  // Suscripción al emisor (se rehace si G.weapons cambia de instancia).
  _bind(w) {
    if (this._weapons === w) return;
    for (const off of this._unsub) off();
    this._unsub.length = 0;
    this._weapons = w;
    if (!w || typeof w.on !== 'function') { this.source = 'deducida'; return; }
    this.source = 'emisor';
    for (const ev of FORWARD) {
      this._unsub.push(w.on(ev, (d) => this._onWeaponEvent(ev, d || {})));
    }
  }

  _onWeaponEvent(ev, d) {
    if (!this.active && ev !== 'swapStart' && ev !== 'swapMid') return;
    const w = this._weapons;
    const key = d.weapon ?? w?.cur;
    switch (ev) {
      case 'swapStart':
        // guardar el arma con perfil; sacar la nueva la hace swapMid/draw
        if (hasProfile(d.from ?? w.cur)) this.vm.event('swapStart', { total: d.total ?? SWAP_TIME });
        break;
      case 'swapMid':
        if (hasProfile(key) && this.vm.setWeapon(key)) { this.vm.event('swapStart', { total: SWAP_TIME, draw: true }); this._drawAt = this._t; }
        break;
      case 'fire':
        this._lastFire = this._t;
        if (hasProfile(key)) {
          const empty = (w?.st?.mag ?? 1) === 0;
          this.vm.event('fire', { ...d, empty, recambio: key === 'stun' && !empty ? w.st.cd : 0 });
        }
        break;
      case 'meleeStart': this.vm.event('meleeStart', this._meleeData()); break;
      case 'meleeHit': {
        const p = this.ctx.G.player;
        this.vm.event('meleeHit', { ...d, total: p.meleeEndT, elapsed: p.meleeT });
        break;
      }
      case 'throwStart': {
        const total = d.total ?? 0.5;
        this.vm.event('throwStart', { total, release: (d.release ?? total * 0.6) / total });
        break;
      }
      default:
        if (!hasProfile(key)) return;
        this.vm.event(ev, d);
    }
  }

  _meleeData() {
    const p = this.ctx.G.player;
    const total = p?.meleeEndT || TUNING.melee?.time || 0.6;
    return { total, hitAt: TUNING.melee.hitAt / total, authoritative: true };
  }

  /**
   * Un cuadro. sc = cámara de mira (yaw/pitch, _scoped). Devuelve true si el
   * arma nueva está en pantalla (el prototipo no debe dibujar).
   */
  update(dt, sc, live) {
    const { G, world } = this.ctx;
    const p = G.player, w = G.weapons;
    this._t += dt;
    this._bind(w);
    // En el visor completo se conservan el fusil y los dedos fuera del cristal.
    const scoped = !!(sc?._scoped || G.scopeActive);
    const show = !!(this.ready && live && p && w && !p.dead && hasProfile(w.cur) && (!scoped || this.active));
    if (!show) {
      if (this.active) this.vm.update(dt, this.state, false);
      this.active = false;
      this._prevYaw = null;
      return false;
    }
    this.vm.setTeam(G.rig?.team ?? G.team ?? 'red');
    this.vm.setVariant(G.rig?.variant ?? G.charVariant ?? 0);
    const was = this.active;
    if (!this.vm.setWeapon(w.cur)) {
      this.vm.update(dt, this.state, false);
      this.active = false;
      return false;
    }
    this.active = true;
    // recién visible (aparecer, salir del scope, terminar un cambio desde un
    // arma sin perfil): se saca el arma
    if (!was && this._t - this._drawAt > 0.05) {
      if (w.swapping) this.vm.event('swapStart', { total: SWAP_TIME, draw: true });
      else this.vm.event('draw', { total: SWAP_TIME * 0.6 });
    }
    const s = this.state, def = w.def;
    const st = p.animState?.() ?? p.state;
    s.aim01 = p.aim ? 1 : 0;
    s.speed = p.grounded ? (p.speed ?? 0) : 0;
    s.sprint = st === 'roadie' && !!p.grounded;
    s.crouch01 = Number.isFinite(p.crouch01) ? p.crouch01 : (st === 'crouch' || st === 'cover_low' || p.crouched ? 1 : 0);
    s.lean = Number.isFinite(p.lean) ? p.lean : (p.leanAnim ?? p.coverLeanAnim ?? 0);
    s.airborne = !p.grounded;
    s.dodge = this.ctx.camera.userData.dodgeFX;
    s.slide = st === 'slide';
    s.mantle = st === 'mantle' || st === 'dive';
    s.dazed = !!p.dazed || (G.protoStun ?? 0) > 0;
    s.reloadT = w.reloading ? clamp01(1 - w.st.reload / Math.max(1e-3, def.reloadTime)) : 0;
    s.swapping = w.swapping ? clamp01(1 - w.swapT / SWAP_TIME) : 0;
    s.fireHeld = this._t - this._lastFire < 0.13;
    // accesibilidad: balanceo (bob × movimiento reducido) y sacudidas del arma
    const mb = motionScale('bob'), ms = motionScale('shake');
    s.bob = Number.isFinite(mb) ? mb : 1; s.shake = Number.isFinite(ms) ? ms : 1;
    // giro de la vista (rad/s)
    if (this._prevYaw === null) { this._prevYaw = sc.yaw; this._prevPitch = sc.pitch; }
    const inv = dt > 1e-4 ? 1 / dt : 0;
    s.yawRate = angleDelta(this._prevYaw, sc.yaw) * inv;
    s.pitchRate = (sc.pitch - this._prevPitch) * inv;
    this._prevYaw = sc.yaw; this._prevPitch = sc.pitch;

    // La simulación puede dar varios subpasos por render y detener el gesto
    // durante el hit-stop. La pierna usa esa misma muestra.
    s.meleeElapsed = p.state === 'melee' ? p.meleeT : null;
    s.meleeEnd = p.meleeEndT;
    if (!was && s.meleeElapsed != null && !s.dazed) this.vm.event('meleeStart', this._meleeData());
    // (el respaldo por el flanco de G.throwT se retiró: el emisor ya publica
    // throwStart del mismo lanzamiento y era un segundo inicio — R10)
    // aterrizaje
    if (!p.grounded) this._minVy = Math.min(this._minVy, p.vy ?? 0);
    if (p.grounded && !this._wasGrounded) this.vm.event('land', { speed: -this._minVy });
    if (p.grounded) this._minVy = 0;
    this._wasGrounded = !!p.grounded;
    // daño recibido: dirección relativa a la vista si el HUD la conoce
    const hp = p.hp ?? G.selfHp;
    if (this._hp !== null && Number.isFinite(hp) && hp < this._hp) {
      let dir = 0;
      const src = G.lastHurtFrom;
      if (src && Number.isFinite(src.x)) dir = angleDelta(sc.yaw, Math.atan2(-(src.x - p.pos.x), -(src.z - p.pos.z)));
      this.vm.event('hurt', { dir, amount: Math.min(1.5, (this._hp - hp) / 25) });
    }
    this._hp = Number.isFinite(hp) ? hp : this._hp;

    // pared delante: rayo del ojo hacia la boca del arma (cuadro anterior)
    const cam = this.ctx.camera;
    // (boca en la postura de REPOSO mezclada por ADS, +13 cm: estable mientras el arma
    // se recoge). wallNear = 0 con la pared a la distancia de la boca, 1 con
    // ella a 0.3 m (lo más cerca que llega el ojo)
    const pr = this.vm.weapons[w.cur]?.probe;
    let wall = 0;
    if (pr) {
      const m = this._v.copy(pr.hip).lerp(pr.ads, clamp01(this.vm.anim?.aim ?? 0));
      const reach = m.length() + 0.13;
      const dir = this._w.copy(m).normalize();
      // Al apuntar, la sonda converge hacia la línea óptica: si el ojo ya
      // libra la cobertura, el borde bajo el cañón no recoge el arma.
      dir.lerp(this._opticalAxis, clamp01(this.vm.anim?.aim ?? 0)).normalize().applyQuaternion(cam.quaternion);
      const hit = world.raycast(cam.position, dir, reach, 0);
      if (hit !== null) wall = clamp01((reach - hit) / Math.max(0.1, reach - 0.3));
    }
    s.wallNear = wall;
    // relleno del arma con el ambiente del mapa (hemisferio + ambiente)
    const hemi = world.hemi, amb = world.amb, f = VM_FILL.uVmFill.value;
    if (hemi || amb) {
      const hi = hemi ? hemi.intensity * 0.5 : 0, ai = amb ? amb.intensity : 0;
      f.setRGB(
        (hemi ? (hemi.color.r + hemi.groundColor.r) * hi : 0) + (amb ? amb.color.r * ai : 0),
        (hemi ? (hemi.color.g + hemi.groundColor.g) * hi : 0) + (amb ? amb.color.g * ai : 0),
        (hemi ? (hemi.color.b + hemi.groundColor.b) * hi : 0) + (amb ? amb.color.b * ai : 0));
      // Rebote tenue de la misma cromaticidad. La cota inferior ayuda a
      // leer el grafito en Azoteas; la superior conserva el contraste al sol.
      const luminance = 0.2126 * f.r + 0.7152 * f.g + 0.0722 * f.b;
      if (luminance > 0) f.multiplyScalar(THREE.MathUtils.clamp(0.20 * luminance, 0.045, 0.10) / luminance);
    }
    this.vm.update(dt, s, scoped && this.vm.prof.scope ? 'scope' : true);
    return true;
  }

  // datos del arma actual para el fogonazo local (rebufo, vaina diferida)
  _fillEject() {
    const key = this.vm.key, w = this.vm.weapons[key];
    this._ej.noCasing = !!(PROFILES[key]?.ejectOn ?? EJECT_ON[key]) || key === 'shotgun';
    this._ej.backblast = w?.anchors.backblast ? this.vm.anchorWorld('backblast', this._bb) : null;
  }
  muzzleWorld(out) { return this.vm.muzzleWorld(out); }
  ejectWorld(out, dir) { return this.vm.ejectWorld(out, dir); }
  get root() { return this.vm.root; }
}

export { PROFILES };
