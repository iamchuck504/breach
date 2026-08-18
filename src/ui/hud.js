// HUD sobre DOM. La retícula de blindfire/hipfire se proyecta desde el cañón
// (shoot from the barrel): #barrel-dot sigue el punto real de impacto del arma.
export class HUD {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      crosshair: document.getElementById('crosshair'),
      crossRing: document.getElementById('cross-ring'),
      barrel: document.getElementById('barrel-dot'),
      vignette: document.getElementById('vignette'),
      hitmarker: document.getElementById('hitmarker'),
      scoreRed: document.getElementById('score-red'),
      scoreBlue: document.getElementById('score-blue'),
      scoreSep: document.getElementById('score-sep'),
      roundPips: document.getElementById('round-pips'),
      scoreboard: document.getElementById('scoreboard'),
      sbRed: document.getElementById('sb-red'),
      sbBlue: document.getElementById('sb-blue'),
      wepName: document.getElementById('wep-name'),
      wepMag: document.getElementById('wep-mag'),
      wepRes: document.getElementById('wep-res'),
      wepMsg: document.getElementById('wep-msg'),
      wepBar: document.getElementById('wep-bar'),
      feed: document.getElementById('feed'),
      center: document.getElementById('center-msg'),
      hint: document.getElementById('context-hint'),
      menu: document.getElementById('menu'),
    };
    this._centerT = null;
    this._hintT = null;
  }

  show(on) { this.el.hud.classList.toggle('on', on); }
  showMenu(on) { this.el.menu.classList.toggle('off', !on); }

  ammo(w) {
    this.el.wepName.textContent = w.def.name;
    this.el.wepMag.textContent = w.st.mag;
    this.el.wepRes.textContent = w.st.reserve;
    this.el.wepMsg.textContent = w.reloading ? 'RECARGANDO'
      : (w.st.mag === 0 && w.st.reserve === 0 ? 'SIN MUNICIÓN' : '');

    // barra de segmentos (ref. Gears): cargadores chicos = bloques discretos,
    // grandes = barra continua; en recarga barre en naranja
    const cap = w.def.mag;
    const bar = this.el.wepBar;
    if (this._barWep !== w.cur) {
      this._barWep = w.cur;
      bar.innerHTML = '';
      if (cap <= 12) {
        for (let i = 0; i < cap; i++) {
          const s = document.createElement('div');
          s.className = 'seg';
          bar.append(s);
        }
      } else {
        bar.innerHTML = '<div class="cont"><div class="fill"></div></div>';
      }
    }
    const rel = w.reloading ? 1 - w.st.reload / w.def.reloadTime : null;
    bar.classList.toggle('reloading', w.reloading);
    if (cap <= 12) {
      const filled = rel !== null ? Math.round(rel * cap) : w.st.mag;
      const segs = bar.children;
      for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('on', i < filled);
    } else {
      const fill = bar.querySelector('.fill');
      if (fill) fill.style.width = (((rel !== null ? rel : w.st.mag / cap)) * 100).toFixed(1) + '%';
    }
  }

  score(r, b) {
    this.el.scoreRed.textContent = r;
    this.el.scoreBlue.textContent = b;
  }

  // temporizador de ronda en el separador central (m:ss); null → "VS"
  timer(sec) {
    if (sec === null) { this.el.scoreSep.textContent = 'VS'; return; }
    const s = Math.max(0, Math.ceil(sec));
    this.el.scoreSep.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // pips de rondas ganadas (mejor de 3)
  roundPips(winsR, winsB) {
    if (winsR === null) { this.el.roundPips.innerHTML = ''; return; }
    let html = '';
    for (let i = 0; i < 2; i++) html += `<div class="pip${i < winsR ? ' red' : ''}"></div>`;
    for (let i = 0; i < 2; i++) html += `<div class="pip${i < winsB ? ' blue' : ''}"></div>`;
    this.el.roundPips.innerHTML = html;
  }

  // scoreboard (Tab / VIEW): rows ordenadas por puntaje, null → ocultar
  scoreboard(rows) {
    this.el.scoreboard.classList.toggle('on', !!rows);
    if (!rows) return;
    const head = '<div class="sb-row sb-cols-head"><span>NOMBRE</span><span>K</span><span>D</span><span>PTS</span></div>';
    for (const team of ['red', 'blue']) {
      const el = team === 'red' ? this.el.sbRed : this.el.sbBlue;
      const title = el.querySelector('.sb-title').outerHTML;
      el.innerHTML = title + head + rows
        .filter((r) => r.team === team)
        .map((r) =>
          `<div class="sb-row${r.id === 'player' ? ' me' : ''}">` +
          `<span>${esc(r.name)}</span><span>${r.kills}</span><span>${r.deaths}</span><span>${r.score}</span></div>`)
        .join('');
    }
  }

  health(pct) {
    this.el.vignette.style.opacity = pct < 0.99 ? String((1 - pct) * 0.95) : '0';
  }

  hitmarker() {
    this.el.hitmarker.classList.remove('pop');
    void this.el.hitmarker.offsetWidth;
    this.el.hitmarker.classList.add('pop');
  }

  // aiming: anillo dimensionado por el spread/rango del arma.
  // hip/blind: punto proyectado del cañón.
  reticle(aiming, barrelXY, aimInfo = null) {
    this.el.crosshair.classList.toggle('aim', aiming);
    if (aiming && aimInfo) {
      this.el.crossRing.setAttribute('r', Math.max(5, aimInfo.r).toFixed(1));
      // fuera del rango efectivo del arma: el anillo se atenúa
      this.el.crossRing.setAttribute('stroke-opacity', aimInfo.inRange ? '0.9' : '0.28');
    }
    if (!aiming && barrelXY) {
      this.el.barrel.classList.add('on');
      this.el.barrel.style.left = barrelXY.x + 'px';
      this.el.barrel.style.top = barrelXY.y + 'px';
    } else {
      this.el.barrel.classList.remove('on');
    }
  }

  kill(killerName, killerTeam, victimName, victimTeam) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      `<span class="${killerTeam}">${esc(killerName)}</span>` +
      `<svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="#8b8e98" stroke-width="1.5">` +
      `<path d="M1 5h8M9 2v6M12 1v8"/></svg>` +
      `<span class="${victimTeam}">${esc(victimName)}</span>`;
    this.el.feed.prepend(row);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
    setTimeout(() => row.remove(), 5200);
  }

  center(text, sub = '', ms = 2200) {
    this.el.center.innerHTML = esc(text) + (sub ? `<div class="sub">${esc(sub)}</div>` : '');
    this.el.center.classList.add('on');
    clearTimeout(this._centerT);
    if (ms > 0) this._centerT = setTimeout(() => this.el.center.classList.remove('on'), ms);
  }
  centerOff() { clearTimeout(this._centerT); this.el.center.classList.remove('on', 'big'); }

  clearFeed() { this.el.feed.innerHTML = ''; }

  // countdown grande de respawn: sec entero, o null para ocultarlo
  respawnTick(sec) {
    if (sec === null) {
      if (this._resp) {
        this._resp = false;
        this.el.center.classList.remove('big', 'on');
      }
      return;
    }
    if (this._resp === sec) return;
    this._resp = sec;
    clearTimeout(this._centerT);
    this.el.center.classList.add('big', 'on');
    this.el.center.innerHTML = sec + '<div class="sub">REAPARECIENDO</div>';
  }

  hint(text, ms = 1600) {
    this.el.hint.textContent = text;
    this.el.hint.classList.add('on');
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => this.el.hint.classList.remove('on'), ms);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
