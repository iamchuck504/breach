// Cliente WebSocket. Protocolo JSON simple; el server es autoridad de
// hp / muertes / respawn / marcador. Posición client-authoritative (slice).
import { TUNING } from '../config/tuning.js';

export class NetClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.team = null;
    this.handlers = {};
    this._sendAcc = 0;
    this.connected = false;
    this.dead = false; // tras close(): ni un mensaje más toca los handlers
  }

  on(type, cb) { this.handlers[type] = cb; }

  connect(url, name, variant = 0) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try { this.ws = new WebSocket(url); }
      catch (e) { reject(e); return; }
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; this.ws.close(); reject(new Error('timeout')); }
      }, 6000);
      this.ws.onopen = () => {
        this.send({ t: 'join', name, v: variant });
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
        this.handlers[msg.t]?.(msg);
      };
      this.ws.onerror = () => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('no se pudo conectar')); }
      };
      this.ws.onclose = () => {
        this.connected = false;
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('conexión cerrada')); }
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
    this.send({
      t: 's',
      x: +player.pos.x.toFixed(3), z: +player.pos.z.toFixed(3),
      y: +player.y.toFixed(2),
      yaw: +player.yaw.toFixed(3),
      st: player.animState(),
      aim: player.aim ? 1 : 0,
      p: +player.cam.pitch.toFixed(3),
      w: wep.cur,
      am: wep.st.mag, ar: wep.st.reserve, // para el drop del arma al morir
      sp: +Math.min(1, player.speed / TUNING.move.roadieSpeed).toFixed(2),
    });
  }

  fire(origin, point, wep, impacts = []) {
    const pack = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
    this.send({ t: 'fire', o: pack(origin), p: pack(point), w: wep, d: impacts.slice(0, 8).map(pack) });
  }

  hit(targetId, dmg, part, gib, point = null) {
    const p = point ? [+point.x.toFixed(2), +point.y.toFixed(2), +point.z.toFixed(2)] : undefined;
    this.send({
      t: 'hit', target: targetId, dmg: Math.round(dmg), part,
      gib: gib ? 1 : 0, ...(p ? { p } : {}),
    });
  }

  close() { this.dead = true; this.ws?.close(); }
}
