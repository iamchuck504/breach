// Cliente WebSocket. Protocolo JSON simple; el server es autoridad de
// hp / muertes / respawn / marcador. Posición client-authoritative (slice).
import { TUNING } from '../config/tuning.js';
import { t } from '../core/i18n.js';
import { POSE_BLEND_MAX as POSE_BLEND, poseKey, freezePose } from '../combat/hit-pose.js';

// Postura FPS en el cable (CONTRATO §1 + enmienda RED): en `crouch`, `ce` es
// la ALTURA de la cabeza (0 agachado … 1 de pie) y cubre el asomo y también
// la transición agacharse↔levantarse: mientras la cámara no está de pie del
// todo se envía `crouch`, así la cabeza replicada nunca salta (el ojo queda
// dentro de ella). Del controlador FPS: stanceLow (0 de pie … 1 agachado,
// asomo incluido), lean (`cl`). Sin stanceLow (bots, controlador anterior):
// animState() y coverAimExposure/coverLeanAnim como siempre.
const HITSCAN_OR_MELEE = new Set(['smg', 'shotgun', 'pistol', 'sniper', 'melee']);
const UPRIGHT = new Set(['idle', 'run', 'jump']);
const CROUCHABLE = new Set(['idle', 'run', 'jump', 'roadie', 'crouch']);
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
export function postureOf(actor) {
  const st = typeof actor?.animState === 'function' ? actor.animState() : 'idle';
  const cl = Math.max(-1, Math.min(1, Number(actor?.lean ?? actor?.coverLeanAnim) || 0));
  const low = actor?.stanceLow;
  if (Number.isFinite(low)) {
    if (CROUCHABLE.has(st) && (st === 'crouch' || low > 0.005)) return { st: 'crouch', ce: clamp01(1 - low), cl };
    return { st, ce: 1, cl };
  }
  return { st, ce: UPRIGHT.has(st) ? 1 : clamp01(actor?.coverAimExposure), cl };
}
// Solo servidores FPS (decisión 16): sin modo compatible ni `cover_low` en el
// cable. Se conservan los nombres para quien aún los importe.
export const wireState = (st) => st;
// yaw en (−π, π]: el cliente lo acumula al girar; el servidor lo normaliza
// también (antes lo saturaba en ±10 rad y desalineaba la cabeza)
export const wrapAngle = (a) => { a = (Number(a) || 0) % (Math.PI * 2); return a > Math.PI ? a - Math.PI * 2 : a <= -Math.PI ? a + Math.PI * 2 : a; };
function dodgeFields(d) {
  if (!d) return null;
  return { dg: +d.t.toFixed(3), da: +Math.atan2(d.z, d.x).toFixed(4),
    ox: d.ox, oz: d.oz };
}
export const wirePose = (actor) => postureOf(actor);
// Eventos de acción que viajan una vez en `s.ev` (ganchos/red.md, cable 7)
export const ACTION_EVENTS = Object.freeze(['swapStart', 'swapEnd', 'reloadStart', 'reloadEnd', 'reloadCancel', 'throwStart', 'throwRelease', 'throwCancel']);
// Pose del jugador local para hit-pose.js (hitPose / eyeFromPose / hitFields):
// la MISMA que viaja, para que cámara, blancos y servidor coincidan.
// Transición de estado (hit-pose.js POSE_BLEND): el jugador local conoce el
// instante exacto del cambio; servidor y observadores lo reconstruyen de los
// snapshots (transitionOf) con ±25 ms de diferencia.
const TRACK = new WeakMap();
function rawLocalPose(player, wepKey) {
  const ps = wirePose(player);
  const pose = { st: ps.st, aim: !!player.aim, ce: ps.ce, cl: ps.cl, pitch: player.cam?.pitch ?? 0, wep: wepKey,
    // velocidad como viaja (`sp`, 2 decimales): el adelanto de cabeza al trotar
    sp: +Math.min(1, (Number(player.speed) || 0) / TUNING.move.roadieSpeed).toFixed(2) };
  // mantle: su fase (el volumen sube y baja con ella)
  if (ps.st === 'mantle' && typeof player.animParams === 'function') pose.phase = player.animParams().mantlePhase;
  return pose;
}
export function noteLocalPose(player, wepKey, now) {
  noteSentPose(player, rawLocalPose(player, wepKey), now);
}
export function localPose(player, wepKey, now = performance.now() / 1000) {
  const pose = rawLocalPose(player, wepKey);
  if (!player || typeof player !== 'object') return pose;
  return readTransition(player, pose, now);
}
// ---------- mezcla de estados definida por lo ENVIADO (ronda 2, matriz honesta) ----------
// La transición la abre el primer estado/muestra ENVIADO con la clave nueva
// (instante = su `ct`) y parte del último enviado antes (con su propia mezcla
// en su `ct`). El servidor reconstruye exactamente eso con las muestras
// propias recibidas (hit-pose.js shotPose, por `ct`), así que el ojo de la
// muestra coincide en los dos lados a cualquier FPS. Entre envíos, la cámara
// lee esa transición; si la clave ya cambió y aún no se envió (≤ 1 cuadro),
// la transición pendiente empieza ahora desde lo último enviado.
const sentInput = (m, wep) => ({ st: m.st, aim: !!m.aim, ce: m.ce, cl: m.cl, pitch: m.p, wep: wep ?? m.w, sp: m.sp });
function fullOf(tr, at) {
  const since = at - tr.entry;
  return tr.from && since >= 0 && since < POSE_BLEND ? { ...tr.last, from: tr.from, fromTo: tr.fromTo, since } : tr.last;
}
export function noteSentPose(actor, pose, ct) {
  let tr = TRACK.get(actor);
  const key = poseKey(pose);
  if (!tr) { tr = { key, entry: -Infinity, from: null, fromTo: null, last: pose, lastCt: ct }; TRACK.set(actor, tr); return; }
  if (key !== tr.key) {
    tr.from = freezePose(fullOf(tr, tr.lastCt)); tr.fromTo = { ...pose }; tr.entry = ct; tr.key = key;
  }
  tr.last = pose; tr.lastCt = ct;
}
function readTransition(actor, pose, now) {
  const tr = TRACK.get(actor);
  if (!tr) return pose;
  if (poseKey(pose) !== tr.key) return { ...pose, from: freezePose(fullOf(tr, tr.lastCt)), fromTo: { ...pose }, since: 0 };
  const since = now - tr.entry;
  return tr.from && since >= 0 && since < POSE_BLEND ? { ...pose, from: tr.from, fromTo: tr.fromTo, since } : pose;
}
// La mezcla de estados de hit-pose.js para CUALQUIER actor cuya pose se arma
// fuera (bots alojados: botmatch.js _hitFields → hitFields(trackTransition(b,
// pose, t), …)), con el instante exacto del cambio, como el jugador local; el
// servidor la reconstruye de los snapshots con la misma regla.
export function resetTransition(actor) { TRACK.delete(actor); }
export function trackTransition(actor, pose, now = performance.now() / 1000) {
  const player = actor;
  let tr = TRACK.get(player);
  const key = poseKey(pose);
  if (!tr) { tr = { key, entry: -Infinity, from: null, last: pose }; TRACK.set(player, tr); }
  if (key !== tr.key) {
    // lo que había al cambiar, CONGELADO como volumen evaluado (con su propia
    // mezcla de ese instante): la cadena nunca pasa de un eslabón (auditoría:
    // alternar carrera/sprint cada 150 ms dejaba 100 poses que hitPose
    // recorría recursivamente)
    const prev = tr.last, since = now - tr.entry;
    const full = tr.from && since < POSE_BLEND ? { ...prev, from: tr.from, fromTo: tr.fromTo, since } : prev;
    tr.key = key; tr.entry = now; tr.from = freezePose(full); tr.fromTo = { ...pose };
  }
  tr.last = pose;
  const since = now - tr.entry;
  return tr.from && since < POSE_BLEND ? { ...pose, from: tr.from, fromTo: tr.fromTo, since: Math.max(0, since) } : pose;
}
function packedFirePose(player, fps = true) {
  if (!player) return null;
  const anim = typeof player.animParams === 'function' ? player.animParams() : null;
  const ps = postureOf(player);
  const pitch = player.cam?.pitch ?? player.aimPitch ?? 0;
  return {
    st: ps.st, a: player.aim ? 1 : 0,
    p: +pitch.toFixed(3), ae: +(anim?.aimYawErr || 0).toFixed(3),
    cl: +ps.cl.toFixed(2),
    ce: +ps.ce.toFixed(2),
    ...(player.cover?.kind ? { ck: player.cover.kind } : {}),
  };
}

export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.team = null;
    this.handlers = {};
    this._sendAcc = 0;
    this._botSendAcc = 0;
    this.connected = false;
    this.dead = false; // tras close(): ni un mensaje más toca los handlers
  }

  on(type, cb) { this.handlers[type] = cb; }

  // Retener los mensajes (en orden) mientras el cliente prepara la entrada a
  // una partida (modelos del mapa). Al soltar se aplican tal cual llegaron:
  // nada del estado del servidor (cajas, armas, muertes, fases) se pierde y
  // el servidor nunca espera a este cliente.
  hold() { if (!this._held) this._held = []; }
  release() {
    const queue = this._held; this._held = null;
    if (!queue) return;
    for (let i = 0; i < queue.length; i++) {
      if (this.dead) return;
      this.handlers[queue[i].t]?.(queue[i]);
      // un mensaje repetido pidió retener otra vez (otra entrada a partida):
      // el resto espera, en orden, a la nueva suelta
      if (this._held) { this._held.push(...queue.slice(i + 1)); return; }
    }
  }

  connect(url, name, variant = 0, action = 'join') {
    return new Promise((resolve, reject) => {
      let settled = false;
      try { this.ws = new WebSocket(url); }
      catch (e) { reject(e); return; }
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; this.ws.close(); reject(new Error(t('network.timeout'))); }
      }, 6000);
      this.ws.onopen = () => {
        // hp: modelo de impacto por pose (hit-pose.js); fps: cliente en
        // primera persona (DECISIONES §5). Un servidor anterior los ignora.
        this.send({ t: 'join', action, name, v: variant, hp: 2, fps: 1 });
      };
      this.ws.onmessage = (ev) => {
        if (this.dead) return; // sesión desechada: los mensajes bufereados
        let msg;               // no deben ejecutar closures de la partida vieja
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome' && !settled) {
          settled = true;
          clearTimeout(timeout);
          // sin `fps` en el welcome: servidor aún no actualizado. No se juega
          // en modo compatible (decisión 16): se cierra y no se entra.
          // y con el modelo de impacto por pose (R9): sin `hp: 2` tampoco se entra
          if (msg.fps !== 1 || msg.hp !== 2) {
            this.dead = true; this.ws.close();
            const err = new Error(t('net.serverOutdated')); err.code = 'server-outdated';
            this.handlers['server-outdated']?.(err);
            reject(err); return;
          }
          this.id = msg.id;
          this.team = msg.team;
          this.fps = true;
          this.connected = true;
          resolve(msg);
        }
        if (msg.t === 'lobbyError' && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.dead = true;
          this.ws.close();
          reject(new Error(t(`lobby.error.${msg.code}`)));
          return;
        }
        if (this._held) { this._held.push(msg); return; }
        this.handlers[msg.t]?.(msg);
      };
      this.ws.onerror = () => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(t('network.failed'))); }
      };
      this.ws.onclose = () => {
        this.connected = false;
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(t('network.closed'))); }
        else if (!this.dead) this.handlers['close']?.();
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // llamar cada frame; manda estado a sendHz
  // Además, en el cuadro en que cambia el estado de postura (clave de
  // hit-pose.js poseKey) se mandan el estado del cuadro ANTERIOR y el del
  // actual: el servidor tiene así exactamente el `from` y el `fromTo` de la
  // mezcla de estados que usa la cámara local, y reconstruye el mismo ojo.
  tickState(dt, player, wep, now = performance.now() / 1000) {
    if (!this.connected || player.dead) return;
    this._last = { player, wep };
    localPose(player, wep?.cur, now); // el seguimiento de la mezcla, cada cuadro
    const msg = this._packState(player, wep, now);
    const key = poseKey(msg), prev = this._prevFrame;
    this._prevFrame = msg;
    this._sendAcc += dt;
    const interval = 1 / TUNING.net.sendHz;
    if (prev && key !== poseKey(prev)) {
      // el estado del cuadro anterior, solo si nada se envió después de
      // capturarlo (si no, el servidor lo descartaría por `n` y la transición
      // de los dos lados ya no partiría del mismo estado)
      if (this._lastSent !== prev && (this._lastSent?.n ?? -1) < prev.n) this._sendSeq(prev);
      this._sendSeq(msg); this._sendAcc = 0; return;
    }
    if (this._sendAcc < interval && !this._events?.length) return;
    this._sendAcc %= interval;
    this._sendSeq(msg);
  }

  // número de secuencia `n` y eventos pendientes en el momento de ENVIAR (el
  // estado del cuadro anterior se envía después de empaquetado)
  _sendSeq(m) {
    // `n` ya se asignó al CAPTURAR (_packState / _shotSample): un estado
    // capturado antes de un tiro llega con `n` menor y el servidor lo descarta
    if (this._events?.length) { m.ev = this._events.splice(0, 4); }
    this.send(m); this._lastSent = m;
    if (this._last?.player && Number.isFinite(m.ct)) noteSentPose(this._last.player, sentInput(m), m.ct);
  }

  _sendState(player, wep, now = performance.now() / 1000) { this._sendSeq(this._packState(player, wep, now)); }

  // Evento de acción (swap/recarga/lanzamiento): viaja UNA vez en el siguiente
  // estado (`ev`); INTEGRACIÓN lo llama desde weapons.on(...).
  noteEvent(type, weapon) {
    if (!ACTION_EVENTS.includes(type)) return;
    (this._events ||= []).push([type, typeof weapon === 'string' ? weapon : '']);
    if (this._events.length > 8) this._events.splice(0, this._events.length - 8);
  }

  // Nueva vida (reaparición, inicio de ronda): sin `from` de la vida anterior
  // ni estado previo que reenviar (auditoría: _prevFrame persistía)
  resetLife(player = this._last?.player, life = this.life) {
    this.life = life;
    this._prevFrame = null; this._lastSent = null; this._sendAcc = 0; this._events = [];
    if (player) resetTransition(player);
  }

  _packState(player, wep, now = performance.now() / 1000) {
    const ps = postureOf(player);
    const visualAimMax = TUNING.combat.visualAimMaxDeg * Math.PI / 180;
    const aimErr = Math.max(-visualAimMax,
      Math.min(visualAimMax, player.cameraYawError()));
    return {
      t: 's', life: this.life, n: (this._n = (this._n || 0) + 1),
      ...(player.grounded === false ? { air: 1 } : {}),
      x: +player.pos.x.toFixed(3), z: +player.pos.z.toFixed(3),
      y: +player.y.toFixed(2),
      yaw: +wrapAngle(player.yaw).toFixed(3),
      st: ps.st,
      ...dodgeFields(player.dodge),
      ct: +now.toFixed(3), // reloj de simulación (presupuesto de postura del servidor)
      aim: player.aim ? 1 : 0,
      p: +player.cam.pitch.toFixed(3),
      ae: +aimErr.toFixed(3),
      cl: +ps.cl.toFixed(2),
      ce: +ps.ce.toFixed(2),
      ck: player.cover?.kind || null,
      w: wep.cur,
      am: wep.st.mag, ar: wep.st.reserve, // para el drop del arma al morir
      sp: +Math.min(1, player.speed / TUNING.move.roadieSpeed).toFixed(2),
      // progreso de recarga para el rig de los demás (como reloadT del rig
      // local; la escopeta, por cartucho). Solo mientras recarga: 10 bytes.
      ...(wep.reloading ? { rl: +Math.max(0, Math.min(1, 1 - wep.st.reload / wep.def.reloadTime)).toFixed(2) } : {}),
    };
  }

  // shot: la muestra del subpaso del disparo (INTEGRACIÓN, ganchos/red.md):
  // { x, y, z, yaw, ae, pose } con pose = localPose(...) de ese subpaso. Sin
  // ella se toma el estado actual del jugador. Viaja como `fs`: el servidor la
  // acepta como estado propio (mismas guardas), reconstruye SU ojo con
  // eyeWorld y exige el origen a ≤ FPS_EYE_TOL de él.
  fire(origin, point, wep, impacts = [], player = null, shot = null) {
    const pack = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    if (!HITSCAN_OR_MELEE.has(wep)) throw new TypeError('fire requiere un arma hitscan o melee');
    const fs = this._shotSample(player, wep, shot);
    const fp = packedFirePose(player);
    // `sq` creciente: el servidor descarta duplicados y ata cada claim a SU disparo
    this.shotSeq = (this.shotSeq || 0) + 1;
    this.send({ t: 'fire', o: pack(origin), p: pack(point), w: wep,
      d: impacts.slice(0, 8).map(pack), ...(fp ? { fp } : {}), ...(fs ? { fs } : {}), sq: this.shotSeq });
    this._noteSample(player, fs);
  }
  _noteSample(player, fs) {
    if (!fs) return;
    this._lastSent = { n: fs.n };
    const who = player ?? this._last?.player;
    if (who && Number.isFinite(fs.ct)) noteSentPose(who, sentInput(fs, fs.w), fs.ct);
  }

  // para `nade` y `protoFire` que main.js arma a mano: { ..., fs: net.shotSample(player, kind) }
  // (la muestra se da por ENVIADA: main la adjunta al mensaje en el acto)
  shotSample(player, wepKey, shot = null) { const fs = this._shotSample(player, wepKey, shot); this._noteSample(player, fs); return fs; }
  // muestra `fs` (campos del estado `s` + ts = s desde el último cambio de postura)
  _shotSample(player, wepKey, shot = null, now = performance.now() / 1000) {
    if (!player && !shot) return null;
    if (Number.isFinite(shot?.t)) now = shot.t;
    const pose = shot?.pose ?? (player ? localPose(player, wepKey, now) : null);
    if (!pose) return null;
    const x = shot?.x ?? player.pos.x, y = shot?.y ?? player.y, z = shot?.z ?? player.pos.z;
    const yaw = shot?.yaw ?? player.yaw;
    const ae = shot?.ae ?? (typeof player?.cameraYawError === 'function' ? player.cameraYawError() : 0);
    const visualAimMax = TUNING.combat.visualAimMaxDeg * Math.PI / 180;
    return { x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), yaw: +wrapAngle(yaw).toFixed(4),
      // `n`: la secuencia común con los estados `s`; `w`: arma del subpaso
      // `w`: arma EQUIPADA del subpaso (en melee, la que lleva en mano)
      life: this.life, n: (this._n = (this._n || 0) + 1),
      w: wepKey === 'melee' || typeof wepKey !== 'string' ? (shot?.weapon && shot.weapon !== 'melee' ? shot.weapon : this._last?.wep?.cur ?? '') : wepKey,
      ct: +now.toFixed(3),
      ...((shot?.air ?? player?.grounded === false) ? { air: 1 } : {}),
      // C2: el `aim` con que se calculó la DISPERSIÓN (el sniper subiendo la
      // mira dispara con la de cadera): el servidor usa ese mismo valor
      sa: Number(shot?.spreadAim ?? Boolean((shot?.aim ?? pose.aim) && (wepKey !== 'sniper' || (shot?.scoped ?? true)))),
      st: pose.st, aim: pose.aim ? 1 : 0, ce: +(pose.ce ?? 1).toFixed(3), cl: +(pose.cl ?? 0).toFixed(3),
      p: +(pose.pitch ?? 0).toFixed(4), sp: pose.sp ?? 0, ae: +Math.max(-visualAimMax, Math.min(visualAimMax, ae)).toFixed(4),
      ...(Number.isFinite(pose.since) ? { ts: +pose.since.toFixed(3) } : {}) };
  }

  // shot: la muestra del subpaso del lanzamiento (como en fire); sin ella, el
  // estado del jugador al enviar
  rocket(origin, direction, cid = null, player = null, bot = null, shot = null) {
    const pack = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
    const fp = packedFirePose(player);
    // cohete humano: su muestra (el servidor valida ojo → salida)
    const fs = !bot && (player || shot) ? this._shotSample(player, 'bazooka', shot) : null;
    this.send({ t: 'rocket', o: pack(origin), d: pack(direction),
      ...(bot ? { bot } : {}), ...(cid ? { cid } : {}), ...(fp ? { fp } : {}), ...(fs ? { fs } : {}) });
    if (fs) this._noteSample(player, fs);
  }

  hit(targetId, dmg, part, gib, point = null, meta = null) {
    const p = point ? [+point.x.toFixed(2), +point.y.toFixed(2), +point.z.toFixed(2)] : undefined;
    this.send({
      t: 'hit', target: targetId, dmg: Math.round(dmg), part,
      gib: gib ? 1 : 0, ...(p ? { p } : {}),
      ...(meta?.pellets ? { pellets: Math.round(meta.pellets) } : {}),
      ...(this.shotSeq ? { sq: this.shotSeq } : {}),
    });
  }

  lobbySettings(settings) { this.send({ t: 'lobbySettings', settings }); }
  lobbyTeam(team) { this.send({ t: 'lobbyTeam', team }); }
  lobbyAddBot(team) { this.send({ t: 'lobbyBotAdd', team }); }
  lobbyRemoveBot(id) { this.send({ t: 'lobbyBotRemove', id }); }
  lobbyBotTeam(id, team) { this.send({ t: 'lobbyBotTeam', id, team }); }
  lobbyStart() { this.send({ t: 'lobbyStart' }); }

  botState(bots) {
    this.send({ t: 'botState', bots: bots.map((b) => ({
      ...(Number.isFinite(b.simTime) ? { ct: +b.simTime.toFixed(3) } : {}),
      ...dodgeFields(b.dodge),
      id: b.id, x: +b.pos.x.toFixed(3), z: +b.pos.z.toFixed(3), y: +b.y.toFixed(2),
      // lo que DIBUJA el bot alojado (cuerpo, lean/exposición en cover, arma
      // en mano durante los gestos), con los mismos campos que un jugador
      yaw: +wrapAngle(b.rigYaw ?? b.yaw).toFixed(3), st: b.animState(), aim: b.aim ? 1 : 0,
      p: +(b.aimPitch || 0).toFixed(3), ae: +(b.aimYawErr || 0).toFixed(3), cl: +(b.coverLean || 0).toFixed(2),
      // cover_low: exposición del asomo; crouch (FPS): altura de cabeza, 0 sin dato
      ce: b.animState() === 'cover_low' ? (Number.isFinite(b.coverExposure) ? +b.coverExposure.toFixed(2) : 1)
        : b.animState() === 'crouch' ? (Number.isFinite(b.coverExposure) ? +b.coverExposure.toFixed(2) : 0) : 1,
      ...(b.coverKind ? { ck: b.coverKind } : {}),
      w: b.shownWep ?? b.wep, sp: +Math.min(1, Math.hypot(b.velX || 0, b.velZ || 0) / TUNING.move.roadieSpeed).toFixed(2),
      ...(b.reloadT > 0 && b._reloadPhase ? { rl: +b._reloadPhase().toFixed(2) } : {}),
    })) });
  }

  tickBotState(dt, bots) {
    if (!this.connected || !bots?.length) return;
    this._botSendAcc += dt;
    const interval = 1 / TUNING.net.sendHz;
    if (this._botSendAcc < interval) return;
    this._botSendAcc %= interval;
    this.botState(bots);
  }

  botFire(id, origin, point, wep, impacts = [], bot = null) {
    const pack = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
    const fp = packedFirePose(bot);
    this.send({ t: 'botFire', id, o: pack(origin), p: pack(point), w: wep,
      ...(Number.isFinite(bot?.simTime) ? { ct: +bot.simTime.toFixed(3) } : {}),
      d: impacts.slice(0, 8).map(pack), ...(fp ? { fp } : {}) });
  }

  botHit(id, targetId, dmg, part, gib, point = null, meta = null) {
    const p = point ? [+point.x.toFixed(2), +point.y.toFixed(2), +point.z.toFixed(2)] : undefined;
    this.send({ t: 'botHit', id, target: targetId, dmg: Math.round(dmg), part,
      gib: gib ? 1 : 0, ...(p ? { p } : {}),
      ...(meta?.pellets ? { pellets: Math.round(meta.pellets) } : {}) });
  }

  close() { this.dead = true; this.ws?.close(); }
}
