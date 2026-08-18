// HUD sobre DOM. La retícula de blindfire/hipfire se proyecta desde el cañón
// (shoot from the barrel): #barrel-dot sigue el punto real de impacto del arma.
export class HUD {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      crosshair: document.getElementById('crosshair'),
      barrel: document.getElementById('barrel-dot'),
      vignette: document.getElementById('vignette'),
      hitmarker: document.getElementById('hitmarker'),
      scoreRed: document.getElementById('score-red'),
      scoreBlue: document.getElementById('score-blue'),
      wepName: document.getElementById('wep-name'),
      wepMag: document.getElementById('wep-mag'),
      wepRes: document.getElementById('wep-res'),
      wepMsg: document.getElementById('wep-msg'),
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
    this.el.wepMsg.textContent = w.reloading ? 'RECARGANDO' : (w.st.mag === 0 ? 'SIN MUNICIÓN — R' : '');
  }

  score(r, b) {
    this.el.scoreRed.textContent = r;
    this.el.scoreBlue.textContent = b;
  }

  health(pct) {
    this.el.vignette.style.opacity = pct < 0.99 ? String((1 - pct) * 0.95) : '0';
  }

  hitmarker() {
    this.el.hitmarker.classList.remove('pop');
    void this.el.hitmarker.offsetWidth;
    this.el.hitmarker.classList.add('pop');
  }

  // aiming: cruz central. hip/blind: punto proyectado del cañón.
  reticle(aiming, barrelXY) {
    this.el.crosshair.classList.toggle('aim', aiming);
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
  centerOff() { clearTimeout(this._centerT); this.el.center.classList.remove('on'); }

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
