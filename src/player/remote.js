// Jugador remoto: buffer de snapshots + interpolación con retraso fijo.
import * as THREE from 'three';
import { TUNING } from '../config/tuning.js';
import { dodgeCues, DODGE_PREP } from './dodge.js';
import { pushRemoteSample, dodgeFraction, advanceMissingDodge } from './dodge-playback.js';
import { Rig } from './rig.js';
// inferFlip y la duración del salto de pared viven en hit-pose.js: el
// servidor reconstruye la vuelta con las mismas reglas al validar impactos
import { inferFlip, WALL_FLIP_DUR, hitModel, poseAt, transitionOf } from '../combat/hit-pose.js';
export { inferFlip };

// módulo, NO bucle while: con un delta enorme (dato remoto corrupto) el
// while nunca terminaba por precisión float y congelaba la pestaña entera
const lerpAngle = (a, b, k) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

// El snapshot trae la fase de esquiva. Las demás fases y velocidades
// se derivan de lo que el
// observador ya tiene (pares de snapshots y el instante de entrada a cada
// estado). Ventana de 0,15 s: con server y cliente a 20 Hz sin sincronizar,
// a veces llegan dos estados iguales seguidos y un par suelto daba 0 y luego
// el doble.
const VEL_WINDOW = 0.15;
const SWAP_HALF = 0.55 / 2; // weapons.js SWAP_TIME: el modelo cambia a mitad del gesto

// Mismo cálculo que controller.js (pendiente longitudinal para el rig): dos
// muestras del suelo delante y detrás del cuerpo. Lo usan remotos y bots.
export function groundPitchTarget(groundFn, x, z, yaw, y) {
  if (!groundFn) return 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), d = 0.42;
  const top = (y || 0) + TUNING.move.maxStepUp;
  const front = groundFn(x + fx * d, z + fz * d, top);
  const back = groundFn(x - fx * d, z - fz * d, top);
  if (!Number.isFinite(front) || !Number.isFinite(back) || Math.abs(front - back) > 0.5) return 0;
  return clamp(Math.atan2(front - back, d * 2), -0.3, 0.3);
}

export class RemotePlayer {
  // rig inyectable: las pruebas de Node reproducen el flujo de snapshots sin WebGL
  constructor(scene, id, name, team, variant = 0, rig = null) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.rig = rig ?? new Rig(scene, team, name, variant);
    this.buf = []; // {rt, x, z, yaw, st, aim, p, w, sp}
    this.alive = true;
    this.x = 0; this.z = 0; this.yaw = 0;
    this.st = 'idle'; this.aim = false; this.pitch = 0; this.aimErr = 0; this.sp = 0;
    this.coverLean = 0; this.coverExposure = 1; this.coverKind = null;
    this.aimSide = 1;
    this.aimLineOrigin = new THREE.Vector3(); this.aimLineDir = new THREE.Vector3();
    this.firing = 0; // timer, lo activa el evento de fuego remoto
    // derivados para el rig (lo que el jugador local le pasa y la red no trae)
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.stEntry = 0; this._stPrev = null;
    this.flipInfo = null; this.meleeTackle = false;
    this.groundPitch = 0;
    this.throwT = 0;
    this.reloading = false; this.reloadT = 0; this._reloadDone = false;
    this._swapShown = 0;
    this._sA = { x: 0, y: 0, z: 0 }; this._sB = { x: 0, y: 0, z: 0 };
    this._sC = { x: 0, y: 0, z: 0 }; this._sD = { x: 0, y: 0, z: 0 };
  }

  push(s, rt = performance.now() / 1000) {
    // `at` = rt: el buffer sirve tal cual de historial a hit-pose.js
    // (poseAt/transitionOf), sin copiarlo en cada consulta de impacto
    pushRemoteSample(this.buf, s, rt);
  }

  // posición interpolada del buffer en un instante de recepción dado
  _sampleAt(rt, out) {
    const b = this.buf;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].rt > rt) i--;
    const s1 = b[Math.max(0, i - 1)], s2 = b[i];
    const span = Math.max(1e-4, s2.rt - s1.rt);
    const k = clamp((rt - s1.rt) / span, 0, 1);
    const posK = dodgeFraction(s1, s2, rt, k);
    out.x = s1.x + (s2.x - s1.x) * posK;
    out.y = fin(s1.y) + (fin(s2.y) - fin(s1.y)) * posK;
    out.z = s1.z + (s2.z - s1.z) * posK;
    return out;
  }

  // velocidad media en [a, b] (tiempo de recepción) sobre la trayectoria interpolada
  _velocity(a, b, out) {
    const p = this._sampleAt(a, this._sC), q = this._sampleAt(b, this._sD);
    const w = Math.max(1e-3, b - a);
    out.x = (q.x - p.x) / w; out.y = (q.y - p.y) / w; out.z = (q.z - p.z) / w;
    return out;
  }

  // El evento de disparo viaja inmediatamente, mientras la pose normal se
  // interpola con retraso. Aplicar este pequeño snapshot visual evita mostrar
  // el flash sobre low-ready cuando el tirador ya había asentado ADS.
  applyFirePose(pose, weapon) {
    // Corrida 6: el evento de fuego solo da fogonazo y brazos (lado del
    // arma). Cabeza, torso y volumen salen SIEMPRE de la pose aceptada e
    // interpolada de los snapshots: antes `fp` imponía postura, ADS,
    // exposición e inclinación ~160 ms (y una ráfaga lo renovaba) mientras
    // los impactos se resolvían contra los snapshots.
    const hasPose = !!pose && typeof pose === 'object' && !Array.isArray(pose);
    if (hasPose && Number.isFinite(pose.cl) && pose.a) {
      this.aimSide = Math.abs(pose.cl) > 0.1 ? Math.sign(pose.cl) : 1;
    }
    if (typeof weapon === 'string') {
      this._lastW = weapon;
      this.rig.setWeapon(weapon);
    }
    this.rig.fireWeaponParts?.();
    this.firing = 0.45;
  }

  // Bote lanzado ('nade'): el mensaje llega en el instante de la suelta, así
  // que el gesto se muestra desde ahí (brazo al frente y acompañamiento). El
  // arranque del gesto no viaja por red.
  applyThrow() {
    const g = TUNING.weapons.grenade;
    this.throwT = g.throwTime - g.throwRelease;
  }

  _onEvent(type, weapon, now) {
    this._evSeen = true;
    const g = TUNING.weapons.grenade;
    if (type === 'swapStart') this._swapShown = now;
    else if (type === 'reloadCancel') { this.reloading = false; this.reloadT = 0; this._reloadDone = true; }
    else if (type === 'throwStart') this.throwT = g.throwTime;
    else if (type === 'throwRelease') this.applyThrow();
    else if (type === 'throwCancel') this.throwT = 0;
  }

  // Su golpe conectó (hitConfirm): como en controller.js, el gesto termina
  // antes (hitAt + hitRecovery en vez de la duración del golpe fallado).
  applyMeleeHit(now = performance.now() / 1000) { this._meleeHitAt = now; }

  // Recarga a partir de `rl` (progreso que manda el tirador mientras recarga,
  // como el reloadT de su rig; la escopeta, por cartucho). Entre snapshots se
  // interpola (con vuelta a 0 en cada cartucho). Si el campo desaparece, se
  // distingue fin de cancelación por lo que faltaba: si cabía en el hueco
  // entre snapshots, terminó (se dibuja hasta 1 y el rig hace el gesto final);
  // si no, se canceló y el gesto se corta ahí. Sin `rl` (servidor o tirador
  // de versión anterior) no se dibuja recarga, como hasta ahora.
  _reloadAt(t, s1, s2, b) {
    const def = TUNING.weapons[s2?.w ?? 'smg'] || TUNING.weapons.smg;
    const rate = 1 / Math.max(0.05, def.reloadTime || 1);
    const r1 = Number.isFinite(s1?.rl) ? s1.rl : null, r2 = Number.isFinite(s2?.rl) ? s2.rl : null;
    let on = false, v = 0;
    if (s1 && s2 && s1 !== s2 && r1 != null && r2 != null) {
      const span = Math.max(1e-4, s2.rt - s1.rt), k = clamp((t - s1.rt) / span, 0, 1);
      const to = r2 < r1 - 0.02 ? r2 + 1 : r2; // nuevo cartucho: el ciclo vuelve a 0
      v = r1 + (to - r1) * k; if (v > 1) v -= 1;
      on = true;
    } else if (r1 != null && s1 !== s2) {
      // último snapshot con recarga: ¿le daba tiempo a terminar antes del siguiente?
      // (hueco mínimo = un envío del cliente: las llegadas se amontonan)
      const ended = r1 + Math.max(s2.rt - s1.rt, 1 / TUNING.net.sendHz) * rate * 1.25 >= 1;
      // terminó: llega a 1 como muy tarde al final del hueco (si no, con
      // snapshots irregulares el rig nunca veía el cierre y no hacía el gesto final)
      const k = clamp((t - s1.rt) / Math.max(1e-4, s2.rt - s1.rt), 0, 1);
      if (ended) { v = Math.min(1, Math.max(r1 + (t - s1.rt) * rate, r1 + (1 - r1) * k)); on = !this._reloadDone; if (v >= 1) this._reloadDone = true; }
    } else if (r2 != null) {
      // empezó dentro de este intervalo: avanza hacia el primer valor recibido
      v = Math.max(0, r2 - (s2.rt - t) * rate);
      on = s1 === s2 || t >= s2.rt - r2 / rate;
    } else if (b.length === 1 && r1 != null) { v = r1; on = true; }
    if (!on) this._reloadDone = this._reloadDone && r1 != null && r2 == null;
    // monótono dentro del mismo ciclo (los tiempos de llegada tiemblan)
    if (on && this.reloading && v < this.reloadT && v > this.reloadT - 0.5) v = this.reloadT;
    this.reloading = on;
    this.reloadT = on ? clamp(v, 0, 1) : 0;
  }

  // Al entrar a un estado: fase desde ese instante y datos de la entrada
  // (eje/sentido del flip por el recorrido, patada en carrera por velocidad).
  _enterState(st, t, prevSnap, entrySnap) {
    this.stEntry = t;
    this.flipInfo = null;
    // el eje del flip se decide en cuanto el buffer trae 0,15 s de vuelo
    // (ver _classifyFlip); hasta entonces la fase avanza con el eje por defecto
    this._flipCam = fin(entrySnap?.yaw, this.yaw) + fin(entrySnap?.ae);
    if (st === 'melee') {
      // controller.js: tackle si entra a > runSpeed·1,15 (sp = speed / roadieSpeed)
      const sp = fin(prevSnap?.sp, this.sp) * TUNING.move.roadieSpeed;
      this.meleeTackle = sp > TUNING.move.runSpeed * 1.15;
    } else this.meleeTackle = false;
  }

  // Dirección por la trayectoria interpolada; magnitud por `sp` del snapshot
  // (la velocidad real del cliente, sin el ruido de los tiempos de llegada:
  // con 20 Hz contra 20 Hz un par de snapshots puede medir 0,6× o 1,5×).
  // Pura sobre el buffer: la usan el dibujo (entrada del estado dibujado) y
  // el volumen de impacto (entrada del estado de los snapshots).
  _flipAt(t, camYaw) {
    const b = this.buf, RS = TUNING.move.roadieSpeed;
    const pre = this._velocity(t - 0.1, t, { x: 0, y: 0, z: 0 });
    const post = this._velocity(t + 0.03, t + 0.16, { x: 0, y: 0, z: 0 });
    let k = b.findIndex((q) => q.rt > t && q.st === 'flip');
    if (k >= 0) {
      const sPre = b[Math.max(0, k - 1)].sp, sPost = (b[k + 1]?.st === 'flip' ? b[k + 1] : b[k]).sp;
      const scale = (v, sp) => {
        const h = Math.hypot(v.x, v.z);
        if (Number.isFinite(sp) && h > 1e-3) { v.x *= sp * RS / h; v.z *= sp * RS / h; }
      };
      scale(pre, sPre); scale(post, sPost);
    }
    return inferFlip(pre, post, camYaw);
  }

  // Fase del mantle desde `entry` en el instante de pantalla t: si el buffer
  // ya muestra el final, llega a 1 justo ahí (lo dibujado dura lo que
  // duraron los snapshots, ±50 ms de 0,42 s). Pura sobre el buffer.
  _mantlePhaseAt(entry, t) {
    const b = this.buf, since = Math.max(0, t - entry);
    let end = null;
    for (let j = 0; j < b.length; j++) {
      if (b[j].rt > t && b[j].st !== 'mantle') { end = j > 0 ? b[j - 1].rt : null; break; }
    }
    return Math.min(1, Math.max(since / TUNING.mantle.time, end != null ? since / Math.max(1e-3, since + end - t) : 0));
  }

  update(dt, scene, now = performance.now() / 1000) {
    const oldX = this.x, oldZ = this.z;
    const t = now - TUNING.net.interpDelay;
    const b = this.buf;
    const holdFirePose = (this.firePoseT ?? 0) > 0;
    let s1 = null, s2 = null;
    if (b.length > 0) {
      let i = b.length - 1;
      while (i > 0 && b[i - 1].rt > t) i--;
      s1 = b[Math.max(0, i - 1)]; s2 = b[i];
      const span = Math.max(1e-4, s2.rt - s1.rt);
      const k = Math.max(0, Math.min(1, (t - s1.rt) / span));
      const posK = dodgeFraction(s1, s2, t, k);
      this.x = s1.x + (s2.x - s1.x) * posK;
      this.z = s1.z + (s2.z - s1.z) * posK;
      this.y = (s1.y ?? 0) + ((s2.y ?? 0) - (s1.y ?? 0)) * posK;
      if (s2.dash && t > s2.rt) advanceMissingDodge(this, s2, t);
      this.yaw = lerpAngle(s1.yaw, s2.yaw, k);
      if (!holdFirePose) {
        this.st = typeof s2.st === 'string' ? s2.st : 'idle'; this.aim = !!s2.aim;
        this.pitch = (s1.p ?? 0) + ((s2.p ?? 0) - (s1.p ?? 0)) * k;
        this.aimErr = (s1.ae ?? 0) + ((s2.ae ?? 0) - (s1.ae ?? 0)) * k;
        this.coverLean = (s1.cl ?? 0) + ((s2.cl ?? 0) - (s1.cl ?? 0)) * k;
        // hit-pose: sin `ce` en el snapshot el volumen usa la regla antigua
        // (agachado) y el rig se dibuja igual: lo que se ve es lo impactable
        this.ceKnown = Number.isFinite(s2.ce);
        // con un servidor anterior (modelo 1) se dibuja agachado: es lo que se traza
        // (crouch: altura de cabeza, interpolada desde la del snapshot previo
        // aunque fuera de pie: ce=1 de pie, nunca salta)
        this.coverExposure = this.ceKnown && hitModel() === 2 ? (s1.ce ?? s2.ce) + (s2.ce - (s1.ce ?? s2.ce)) * k : 0;
        this.coverKind = s2.ck ?? null;
      }
      // ESTADO DE IMPACTO: función pura del flujo de snapshots (lo mismo que
      // reconstruye el servidor: estado, entrada, eje/sentido/duración del
      // flip, fases, exposición, asomado). Un evento de fuego (applyFirePose)
      // solo sustituye la PRESENTACIÓN (this.st/aim/... de arriba), nunca esto.
      const hs = this._hitSnap ||= {};
      if (s2.st === 'dodge') {
        const age = s1.st === 'dodge' ? (s1.dg ?? 0) : 0;
        this.dodgePhase = s2.dash ? clamp((t - s2.dash.start) / TUNING.dodge.duration, 0, 1) : Math.min(1, (age + ((s2.dg ?? age) - age) * k) / TUNING.dodge.duration);
      }
      hs.st = s2.st; hs.aim = !!s2.aim;
      hs.pitch = (s1.p ?? 0) + ((s2.p ?? 0) - (s1.p ?? 0)) * k;
      hs.cl = (s1.cl ?? 0) + ((s2.cl ?? 0) - (s1.cl ?? 0)) * k;
      hs.ce = Number.isFinite(s2.ce) ? (s1.ce ?? s2.ce) + (s2.ce - (s1.ce ?? s2.ce)) * k : undefined;
      hs.w = s2.w ?? 'smg';
      hs.sp = (s1.sp ?? 0) + ((s2.sp ?? 0) - (s1.sp ?? 0)) * k;
      // entrada al estado del SNAPSHOT (no al dibujado, que un evento de fuego
      // puede sustituir): de aquí sale la fase de dive/mantle/flip del volumen
      if (hs.st !== this._hsPrev) {
        this._hsPrev = hs.st;
        this._hsEntry = s1 !== s2 ? Math.max(t, (s1.rt + s2.rt) / 2) : t;
        this._hsFlip = null;
      }
      hs.since = Math.max(0, t - (this._hsEntry ?? t));
      hs.t = t;
      if (hs.st === 'flip' && !this._hsFlip && b[b.length - 1].rt >= this._hsEntry + 0.16) {
        const first = b.find((q) => q.rt > this._hsEntry && q.st === 'flip');
        this._hsFlip = this._flipAt(this._hsEntry, fin(first?.yaw, this.yaw) + fin(first?.ae));
      }
      this.sp = s2.sp ?? 0;
      this.inv = !!s2.inv; // protección de spawn
      const w = s2.w ?? 'smg';
      if (!holdFirePose) {
        if (this._lastW && w !== this._lastW) this._swapShown = now;
        this._lastW = w;
        this.rig.setWeapon(w);
      }
      // velocidad real (la del cuerpo, no la del cuadro): pasos laterales en
      // cover, dirección de la marcha y fases del salto
      this._reloadAt(t, s1, s2, b);
      const v = this._velocity(t - VEL_WINDOW / 2, t + VEL_WINDOW / 2, this._sA);
      this.vx = v.x; this.vz = v.z; this.vy = v.y;
    }
    const dash = this.alive ? s2?.dash : null;
    if (dash) {
      dodgeCues(dash, t - dash.start, this.x, this.y, this.z, dash.dx, dash.dz, this.team, this.onDodgeCue, false);
    } else if (this._shownDash && this.alive && b.length && this._shownDash.end) {
      const d = this._shownDash, end = d.end;
      dodgeCues(d, end.dg, end.x, end.y, end.z, d.dx, d.dz, this.team, this.onDodgeCue, true);
    }
    this._shownDash = dash;
    // fases por tiempo desde la entrada al estado (tiempo de pantalla)
    if (this.st !== this._stPrev) {
      // el estado se dibuja desde que empieza el par (s1 → s2), pero empezó
      // entre ambos snapshots: la fase cuenta desde el punto medio
      if (s2) this._enterState(this.st, s1 !== s2 ? Math.max(t, (s1.rt + s2.rt) / 2) : t, s1 !== s2 ? s1 : null, s2);
      else this.stEntry = t;
      this._stPrev = this.st;
    }
    const since = Math.max(0, t - this.stEntry);
    if (this.st === 'flip' && !this.flipInfo && b.length && b[b.length - 1].rt >= this.stEntry + 0.16) {
      this.flipInfo = this._flipAt(this.stEntry, this._flipCam ?? this.yaw);
    }
    this.firePoseT = Math.max(0, (this.firePoseT ?? 0) - dt);
    this.firing = Math.max(0, this.firing - dt);
    this.throwT = Math.max(0, this.throwT - dt);
    // Cambio de arma: el modelo cambia a mitad del gesto. El buffer va unos
    // 0,12 s por delante de lo dibujado: si ya trae otra arma, el gesto
    // empieza ahora, y sigue media duración después del cambio visible.
    // Eventos de acción (`ev` del snapshot, una vez): se aplican cuando su
    // snapshot llega al instante dibujado. Con eventos, el cambio de arma ya
    // no se infiere por `w`.
    const events = [];
    for (const q of b) {
      if (q.rt > t || q._evDone || !Array.isArray(q.ev)) continue;
      q._evDone = true;
      for (const e of q.ev) { if (Array.isArray(e)) { events.push(e); this._onEvent(e[0], e[1], now); } }
    }
    let swapAhead = false;
    if (!this._evSeen) for (let j = b.length - 1; j >= 0 && b[j].rt > t; j--) {
      if (b[j].rt <= t + SWAP_HALF && (b[j].w ?? 'smg') !== this._lastW) { swapAhead = true; break; }
    }
    this.swapAnim = swapAhead || (this._swapShown && now - this._swapShown < SWAP_HALF) ? 1 : 0;
    this.flipT = this.st === 'flip' ? Math.min(1, since / (this.flipInfo?.dur ?? WALL_FLIP_DUR)) : 0;
    this.evadePhase = this.st === 'dive' ? Math.min(1, since / TUNING.evade.diveTime) : 0;
    // mantle: si el buffer ya muestra el final, la fase llega a 1 justo ahí
    // (lo dibujado dura lo que duraron los snapshots, ±50 ms de 0,42 s)
    this.mantlePhase = this.st === 'mantle' ? this._mantlePhaseAt(this.stEntry, t) : 0;
    const ml = TUNING.melee;
    // La confirmación se oye ya, aunque las poses se dibujen desde el búfer.
    // En ese mismo cuadro la suela llega al blanco y aguanta el hit-stop.
    const confirmed = this.st === 'melee' && Number.isFinite(this._meleeHitAt) &&
      this._meleeHitAt >= this.stEntry && now - this._meleeHitAt < ml.time;
    const meleeEnd = confirmed ? ml.hitAt + ml.hitRecovery : ml.time;
    const elapsed = confirmed ? ml.hitAt + Math.max(0, now - this._meleeHitAt - ml.hitStop) : since;
    this.meleePhase = this.st === 'melee' ? Math.min(1, elapsed / meleeEnd) : 0;
    this.rig.setTransform(this.x, this.z, this.yaw, this.y ?? 0);
    const targetAimSide = this.aim && Math.abs(this.coverLean) > 0.1
      ? this.coverLean : 1;
    this.aimSide += (targetAimSide - this.aimSide) * (1 - Math.exp(-9 * dt));
    let aimLineOrigin = null, aimLineDir = null;
    if (this.aim) {
      // Reconstruir la misma línea óptica ideal del jugador observado. El
      // snapshot lleva yaw relativo, pitch y hombro de cover; con eso el rig
      // remoto puede adoptar la misma pose física aunque su cámara no exista
      // en este cliente.
      const cameraYaw = this.yaw + this.aimErr;
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const cy = Math.cos(cameraYaw), sy = Math.sin(cameraYaw);
      const side = this.aimSide;
      aimLineDir = this.aimLineDir.set(-sy * cp, sp, -cy * cp).normalize();
      aimLineOrigin = this.aimLineOrigin.set(
        this.x + sy * cp * TUNING.cam.aimDist + cy * TUNING.cam.aimShoulder * side,
        (this.y ?? 0) + TUNING.cam.aimHeight * 0.92 - sp * TUNING.cam.aimDist + 0.12,
        this.z + cy * cp * TUNING.cam.aimDist - sy * TUNING.cam.aimShoulder * side,
      );
    }
    // dirección de la marcha respecto al cuerpo, como animParams() del
    // controller: con la velocidad real, no con el salto de un cuadro
    const hs = Math.hypot(this.vx, this.vz);
    if (s2?.dash) {
      this.moveForward = -s2.dash.dx * Math.sin(this.yaw) - s2.dash.dz * Math.cos(this.yaw);
      this.moveSide = s2.dash.dx * Math.cos(this.yaw) - s2.dash.dz * Math.sin(this.yaw);
    } else if (hs > 0.05) {
      this.moveForward = (-this.vx * Math.sin(this.yaw) - this.vz * Math.cos(this.yaw)) / hs;
      this.moveSide = (this.vx * Math.cos(this.yaw) - this.vz * Math.sin(this.yaw)) / hs;
    } else if (Math.hypot(this.x - oldX, this.z - oldZ) < 1e-4) {
      this.moveForward = 1; this.moveSide = 0;
    }
    // paso lateral en cover: velocidad a lo largo del cuerpo / coverStrafe
    const inCover = this.st.startsWith('cover_') || this.st.startsWith('blind_');
    const latMove = inCover
      ? clamp((this.vx * Math.cos(this.yaw) - this.vz * Math.sin(this.yaw)) / TUNING.move.coverStrafe, -1, 1)
      : 0;
    // torso hacia la cámara sin apuntar (controller: twist = cam.yaw − yaw)
    const twist = !this.aim && (this.st === 'idle' || this.st === 'run') ? clamp(this.aimErr, -0.9, 0.9) : 0;
    const grounded = this.st === 'idle' || this.st === 'run' || this.st === 'roadie';
    const pitchTarget = grounded ? groundPitchTarget(this.rig.groundFn, this.x, this.z, this.yaw, this.y) : 0;
    this.groundPitch += (pitchTarget - this.groundPitch) * (1 - Math.exp(-TUNING.move.groundPitchLerp * dt));
    const g = TUNING.weapons.grenade;
    // `crouch` (FPS): altura de cabeza en coverAimExposure (= ce, también sin
    // apuntar) e inclinación en coverLean (= cl). Mientras el rig no tenga la
    // pose propia (supportsState), se dibuja la de cobertura baja, que agacha
    // igual y sube con `ce` al apuntar.
    const rigState = this.st === 'crouch' && !this.rig.supportsState?.('crouch') ? 'cover_low' : this.st;
    const prep = s2?.prepare;
    const brace = prep ? clamp(1 - (prep.start - t) / DODGE_PREP, 0, 1) : 0;
    this.anim = {
      dodgeBrace: brace,
      state: this.alive ? rigState : 'dead',
      speed: this.sp,
      moveForward: this.moveForward ?? 1,
      moveSide: this.moveSide ?? 0,
      latMove,
      vy: this.vy,
      groundPitch: this.groundPitch,
      twist,
      aim: this.aim,
      aimPitch: this.pitch,
      aimYawErr: this.aimErr,
      coverLean: this.coverLean,
      coverAimExposure: this.coverExposure,
      coverKind: this.coverKind,
      aimLineOrigin,
      aimLineDir,
      firing: this.firing > 0 && (this.aim || !this.st.startsWith('cover_')),
      flipT: this.flipT,
      flipDir: this.flipInfo?.dir ?? 1,
      flipAxis: this.flipInfo?.axis ?? 'z',
      evadePhase: this.st === 'dodge' ? this.dodgePhase : this.evadePhase,
      mantlePhase: this.mantlePhase,
      meleePhase: this.st === 'melee' ? this.meleePhase : undefined,
      meleeEnd,
      meleeTackle: this.st === 'melee' && this.meleeTackle,
      swapping: this.swapAnim > 0,
      throwT: this.throwT,
      throwTotal: g.throwTime,
      throwReleased: this.throwT > 0,
      reloading: this.reloading,
      reloadT: this.reloadT,
      // ce/cl ya vienen interpolados del flujo de snapshots (lo mismo que el
      // volumen): el rig no los vuelve a filtrar y mezcla los cambios de
      // estado con la MISMA transición que el volumen (ganchos/rig.md)
      interpolated: true,
      poseTr: this._poseTr(),
      // eventos de este cuadro, una vez (ganchos/red.md "Para RIG")
      events,
    };
    this.rig.update(dt, this.anim);
    // protección de spawn: highlight sutil del color del equipo
    this.rig.setProtected(!!this.inv);
  }

  // Pose para hit-pose.js: SOLO el estado de impacto derivado de snapshots
  // (ver _hitSnap en update); sin snapshots aún, nada que impactar distinto
  // de la regla de siempre (de pie).
  hitPoseInput() {
    const hs = this._hitSnap;
    if (!hs) return { st: this.alive ? 'idle' : 'dead' };
    const st = this.alive ? (typeof hs.st === 'string' ? hs.st : 'idle') : 'dead';
    // transición de estado (hit-pose.js transitionOf): la misma regla que el
    // servidor sobre el mismo flujo de snapshots (tiempo de recepción)
    const tr = this._poseTr();
    return { st, aim: hs.aim, ce: hs.ce, cl: hs.cl, pitch: hs.pitch, phase: this._hitPhase(st),
      flipDir: this._hsFlip?.dir ?? 1, flipAxis: this._hsFlip?.axis ?? 'z', wep: hs.w, sp: hs.sp, ...(tr || {}) };
  }

  // transición de estado en curso (hit-pose.js transitionOf) sobre el buffer,
  // la misma para el volumen y para el rig
  _poseTr() {
    const hs = this._hitSnap;
    if (!hs || !this.alive || this.buf.length < 2) return null;
    const cur = poseAt(this.buf, hs.t);
    return cur ? transitionOf(this.buf, cur.i, hs.t) : null;
  }

  // fase de la acción para el volumen, desde la entrada del estado del snapshot
  _hitPhase(st) {
    const hs = this._hitSnap, since = hs.since ?? 0;
    if (st === 'dive') return Math.min(1, since / TUNING.evade.diveTime);
    if (st === 'mantle') return this._mantlePhaseAt(this._hsEntry ?? hs.t, hs.t);
    if (st === 'flip') return Math.min(1, since / (this._hsFlip?.dur ?? WALL_FLIP_DUR));
    return undefined;
  }

  dispose(scene) { this.rig.dispose(scene); }
}
