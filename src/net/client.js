// Cliente WebSocket. Protocolo JSON simple; el server es autoridad de
// hp / muertes / respawn / marcador. Posición client-authoritative (slice).
import { TUNING } from '../config/tuning.js';
import { t } from '../core/i18n.js';

function packedFirePose(player) {
  if (!player) return null;
  const anim = typeof player.animParams === 'function' ? player.animParams() : null;
  const state = typeof player.animState === 'function' ? player.animState() : 'idle';
  const pitch = player.cam?.pitch ?? player.aimPitch ?? 0;
  return {
    st: state, a: player.aim ? 1 : 0,
    p: +pitch.toFixed(3), ae: +(anim?.aimYawErr || 0).toFixed(3),
    cl: +(player.coverLeanAnim || 0).toFixed(2),
    ce: +(player.coverAimExposure || 0).toFixed(2),
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

  connect(url, name, variant = 0, action = 'join') {
    return new Promise((resolve, reject) => {
      let settled = false;
      try { this.ws = new WebSocket(url); }
      catch (e) { reject(e); return; }
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; this.ws.close(); reject(new Error(t('network.timeout'))); }
      }, 6000);
      this.ws.onopen = () => {
        this.send({ t: 'join', action, name, v: variant });
      };
      this.ws.onmessage = (ev) => {
        if (this.dead) return; // sesión desechada: los mensajes bufereados
        let msg;               // no deben ejecutar closures de la partida vieja
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome' && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.id = msg.id;
          this.team = msg.team;
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
  tickState(dt, player, wep) {
    if (!this.connected) return;
    this._sendAcc += dt;
    const interval = 1 / TUNING.net.sendHz;
    if (this._sendAcc < interval) return;
    this._sendAcc %= interval;
    const visualAimMax = TUNING.combat.visualAimMaxDeg * Math.PI / 180;
    const aimErr = Math.max(-visualAimMax,
      Math.min(visualAimMax, player.cameraYawError()));
    this.send({
      t: 's',
      x: +player.pos.x.toFixed(3), z: +player.pos.z.toFixed(3),
      y: +player.y.toFixed(2),
      yaw: +player.yaw.toFixed(3),
      st: player.animState(),
      aim: player.aim ? 1 : 0,
      p: +player.cam.pitch.toFixed(3),
      ae: +aimErr.toFixed(3),
      cl: +(player.coverLeanAnim || 0).toFixed(2),
      ce: +(player.coverAimExposure || 0).toFixed(2),
      ck: player.cover?.kind || null,
      w: wep.cur,
      am: wep.st.mag, ar: wep.st.reserve, // para el drop del arma al morir
      sp: +Math.min(1, player.speed / TUNING.move.roadieSpeed).toFixed(2),
    });
  }

  fire(origin, point, wep, impacts = [], player = null) {
    const pack = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
    const fp = packedFirePose(player);
    this.send({ t: 'fire', o: pack(origin), p: pack(point), w: wep,
      d: impacts.slice(0, 8).map(pack), ...(fp ? { fp } : {}) });
  }

  rocket(origin, direction, cid = null, player = null, bot = null) {
    const pack = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
    const fp = packedFirePose(player);
    this.send({ t: 'rocket', o: pack(origin), d: pack(direction),
      ...(bot ? { bot } : {}), ...(cid ? { cid } : {}), ...(fp ? { fp } : {}) });
  }

  hit(targetId, dmg, part, gib, point = null, meta = null) {
    const p = point ? [+point.x.toFixed(2), +point.y.toFixed(2), +point.z.toFixed(2)] : undefined;
    this.send({
      t: 'hit', target: targetId, dmg: Math.round(dmg), part,
      gib: gib ? 1 : 0, ...(p ? { p } : {}),
      ...(meta?.pellets ? { pellets: Math.round(meta.pellets) } : {}),
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
      id: b.id, x: +b.pos.x.toFixed(3), z: +b.pos.z.toFixed(3), y: +b.y.toFixed(2),
      yaw: +b.yaw.toFixed(3), st: b.animState(), aim: b.aim ? 1 : 0,
      p: +(b.aimPitch || 0).toFixed(3), ae: 0, cl: 0, ce: 1,
      w: b.wep, sp: +Math.min(1, Math.hypot(b.velX || 0, b.velZ || 0) / TUNING.move.roadieSpeed).toFixed(2),
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
