import { t, getLanguage } from '../core/i18n.js';

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
      score: document.getElementById('score'),
      scoreRed: document.getElementById('score-red'),
      scoreBlue: document.getElementById('score-blue'),
      scoreSep: document.getElementById('score-sep'),
      scoreUnits: document.querySelectorAll('#score .score-unit'),
      roundPips: document.getElementById('round-pips'),
      scoreboard: document.getElementById('scoreboard'),
      matchFlow: document.getElementById('match-flow'),
      spectator: document.getElementById('spectator'),
      sbRed: document.getElementById('sb-red'),
      sbBlue: document.getElementById('sb-blue'),
      weapon: document.getElementById('weapon'),
      wepName: document.getElementById('wep-name'),
      wepMag: document.getElementById('wep-mag'),
      wepRes: document.getElementById('wep-res'),
      wepMsg: document.getElementById('wep-msg'),
      wepBar: document.getElementById('wep-bar'),
      wepSlots: document.getElementById('wep-slots'),
      feed: document.getElementById('feed'),
      center: document.getElementById('center-msg'),
      hint: document.getElementById('context-hint'),
      menu: document.getElementById('menu'),
    };
    this._centerT = null;
    this._hintT = null;
  }

  _pulse(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  show(on) { this.el.hud.classList.toggle('on', on); }
  showMenu(on) { this.el.menu.classList.toggle('off', !on); }

  invalidateLanguage() {
    this._scoreboardKey = null;
    this._presentationKey = null;
    this._spectatorKey = null;
    this._resp = null;
    clearTimeout(this._centerT);
    clearTimeout(this._hintT);
    this.el.center.textContent = '';
    this.el.center.classList.remove('on', 'big');
    this.el.hint.textContent = '';
    this.el.hint.classList.remove('on');
    if (this._scoreUnitKey) for (const el of this.el.scoreUnits) el.textContent = t(this._scoreUnitKey);
  }

  ammo(w) {
    const weaponChanged = this._lastWep !== undefined && this._lastWep !== w.cur;
    const ammoChanged = !weaponChanged && this._lastMag !== undefined && this._lastMag !== w.st.mag;
    if (weaponChanged) this._pulse(this.el.weapon, 'weapon-change');
    if (ammoChanged) this._pulse(this.el.weapon, 'ammo-change');
    this.el.weapon.dataset.weapon = w.cur;
    this.el.wepName.textContent = t(w.def.nameKey);
    this.el.wepMag.textContent = w.st.mag;
    this.el.wepRes.textContent = w.st.reserve;
    this.el.wepMsg.textContent = w.swapping ? t('hud.switching')
      : w.reloading ? t('hud.reloading')
      : (w.st.mag === 0 && w.st.reserve === 0 ? t('hud.noAmmo') : '');
    this.el.weapon.classList.toggle('reloading', w.reloading);
    this.el.weapon.classList.toggle('low-ammo', !w.reloading &&
      w.st.mag <= Math.max(2, Math.ceil(w.def.mag * 0.2)));
    this._lastWep = w.cur;
    this._lastMag = w.st.mag;

    // Cargadores chicos = bloques discretos,
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
    // barra de slots (1-4): nombre corto por arma, el actual resaltado,
    // atenuado si se quedó completamente sin munición
    const sig = w.slots.join(',');
    if (this._slotSig !== sig) {
      this._slotSig = sig;
      this.el.wepSlots.innerHTML = '';
      for (let i = 0; i < w.slots.length; i++) {
        const chip = document.createElement('div');
        chip.className = 'slot';
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = i + 1;
        const label = document.createElement('span');
        label.className = 'w';
        chip.append(k, label);
        this.el.wepSlots.append(chip);
      }
    }
    const chips = this.el.wepSlots.children;
    for (let i = 0; i < chips.length; i++) {
      const k = w.slots[i], st = w.state[k];
      chips[i].lastChild.textContent = t('weapon.' + k + 'Short');
      chips[i].classList.toggle('cur', k === w.cur);
      chips[i].classList.toggle('dry', !!st && st.mag <= 0 && st.reserve <= 0);
    }

    const rel = w.reloading ? 1 - w.st.reload / w.def.reloadTime : null;
    bar.classList.toggle('reloading', w.reloading);
    if (cap <= 12) {
      // En per-shell solo se encienden cartuchos ya insertados; la animación
      // por sí sola nunca debe representar munición todavía inutilizable.
      const filled = w.def.perShell ? w.st.mag : (rel !== null ? Math.round(rel * cap) : w.st.mag);
      const segs = bar.children;
      for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('on', i < filled);
    } else {
      const fill = bar.querySelector('.fill');
      if (fill) fill.style.width = (((rel !== null ? rel : w.st.mag / cap)) * 100).toFixed(1) + '%';
    }
  }

  score(r, b, unit = 'hud.eliminations') {
    if (this._scoreR !== undefined && r !== this._scoreR) this._pulse(this.el.scoreRed, 'score-bump');
    if (this._scoreB !== undefined && b !== this._scoreB) this._pulse(this.el.scoreBlue, 'score-bump');
    this.el.scoreRed.textContent = r;
    this.el.scoreBlue.textContent = b;
    this._scoreUnitKey = unit;
    for (const el of this.el.scoreUnits) el.textContent = t(unit);
    this._scoreR = r;
    this._scoreB = b;
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
    const key = winsR + ':' + winsB;
    if (this._roundKey === key) return;
    this._roundKey = key;
    let html = '';
    for (let i = 0; i < 2; i++) html += `<div class="pip${i < winsR ? ' red' : ''}"></div>`;
    for (let i = 0; i < 2; i++) html += `<div class="pip${i < winsB ? ' blue' : ''}"></div>`;
    this.el.roundPips.innerHTML = html;
  }

  // scoreboard (Tab / VIEW): rows ordenadas por puntaje, null → ocultar
  scoreboard(rows, localId = 'player') {
    this.el.scoreboard.classList.toggle('on', !!rows);
    if (!rows) { this._scoreboardKey = null; return; }
    const key = getLanguage() + '|' + localId + '|' + rows.map((r) => `${r.id}:${r.kills}:${r.deaths}:${r.score}`).join('|');
    if (this._scoreboardKey === key) return;
    this._scoreboardKey = key;
    const head = `<div class="sb-row sb-cols-head"><span>${esc(t('hud.name'))}</span><span>K</span><span>D</span><span>${esc(t('hud.points'))}</span></div>`;
    for (const team of ['red', 'blue']) {
      const el = team === 'red' ? this.el.sbRed : this.el.sbBlue;
      const title = el.querySelector('.sb-title').outerHTML;
      el.innerHTML = title + head + rows
        .filter((r) => r.team === team)
        .map((r) =>
          `<div class="sb-row${r.id === localId ? ' me' : ''}">` +
          `<span>${esc(r.name)}</span><span>${r.kills}</span><span>${r.deaths}</span><span>${r.score}</span></div>`)
        .join('');
    }
  }

  // Secuencia de presentación de partida. Recibe únicamente información que
  // ya existe en el modo activo; no inventa métricas para llenar el panel.
  presentation(view) {
    const root = this.el.matchFlow;
    if (!view) {
      root.className = '';
      root.innerHTML = '';
      this._presentationKey = null;
      return;
    }
    const rows = view.rows || [];
    const count = view.count ?? '';
    const key = [getLanguage(), view.phase, view.title, view.sub, count, view.red, view.blue,
      rows.map((r) => `${r.id}:${r.kills ?? ''}:${r.deaths ?? ''}:${r.score ?? ''}`).join('|')].join('~');
    root.className = `on ${view.phase}`;
    if (this._presentationKey === key) {
      const bar = root.querySelector('.mf-progress span');
      if (bar && view.progress !== undefined) bar.style.width = `${Math.max(0, Math.min(100, view.progress * 100))}%`;
      return;
    }
    this._presentationKey = key;

    if (view.phase === 'intro') {
      root.innerHTML = `
        <section class="mf-card">
          <div class="mf-kicker">${esc(view.kicker || t('hud.deployment'))}</div>
          <div class="mf-title">${esc(view.title)}</div>
          <div class="mf-sub">${esc(view.sub || '')}</div>
          <div class="mf-meta">${(view.meta || []).map((m) => `<span class="mf-chip">${esc(m)}</span>`).join('')}</div>
          ${flowTeams(rows, view.localId, false)}
          <div class="mf-progress"><span style="width:${Math.max(0, Math.min(100, (view.progress ?? 0) * 100))}%"></span></div>
          <div class="mf-wait">${esc(view.wait || t('hud.preparingCombat'))}</div>
        </section>`;
      return;
    }

    if (view.phase === 'countdown') {
      root.innerHTML = `<div><div class="mf-count">${esc(count)}</div><div class="mf-count-label">${esc(view.sub || t('hud.getReady'))}</div></div>`;
      return;
    }

    if (view.phase === 'mvp') {
      const m = view.mvp || {};
      root.innerHTML = `
        <section class="mf-result-card mf-mvp">
          <div class="mf-portrait"><img alt="${esc(m.name || 'MVP')}"></div>
          <div>
            <div class="mf-result-label">${esc(t('hud.matchMvp'))}</div>
            <div class="mf-result-title">${esc(m.name || '—')}</div>
            <div class="mf-sub ${esc(m.team || '')}">${esc(m.team === 'blue' ? t('hud.teamBlue') : t('hud.teamRed'))}</div>
            <div class="mf-mvp-stats">
              ${flowStat(m.kills ?? 0, t('hud.kills'))}${flowStat(m.deaths ?? 0, t('hud.deaths'))}${flowStat(m.score ?? 0, t('hud.points'))}
            </div>
          </div>
        </section>`;
      const img = root.querySelector('.mf-portrait img');
      if (img && view.portrait) img.src = view.portrait;
      return;
    }

    root.innerHTML = `
      <section class="mf-result-card">
        <div class="mf-result-top">
          <div><div class="mf-result-label">${esc(view.kicker || t('hud.result'))}</div><div class="mf-result-title">${esc(view.title)}</div><div class="mf-sub">${esc(view.sub || '')}</div></div>
          <div class="mf-result-score"><span class="red">${view.red ?? 0}</span><span> — </span><span class="blue">${view.blue ?? 0}</span></div>
        </div>
        ${view.phase === 'final-score' ? flowTeams(rows, view.localId, true) : ''}
      </section>`;
  }

  spectator(view) {
    const root = this.el.spectator;
    this.el.hud.classList.toggle('spectating', !!view);
    root.classList.toggle('on', !!view);
    if (!view) {
      root.innerHTML = '';
      this._spectatorKey = null;
      return;
    }
    const key = [getLanguage(), view.name, view.controls, view.respawn, view.waiting].join('|');
    if (key === this._spectatorKey) return;
    this._spectatorKey = key;
    root.innerHTML = `<div class="spec-card">
      <div class="spec-kicker">${esc(t('hud.spectating'))}</div>
      <div class="spec-name">${esc(view.name || t('hud.waitingTeammate'))}</div>
      <div class="spec-meta">
        <span>${esc(view.controls || '')}</span>
        ${view.respawn ? `<span class="spec-respawn${view.ready ? ' ready' : ''}">${esc(view.respawn)}</span>` : ''}
      </div>
    </div>`;
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
    // center() manda: suelta el estado del countdown de respawn (comparten
    // #center-msg — sin esto, respawnTick(null) del mismo frame borraba
    // "SIN VIDAS"/"DERROTA" recién pintados, y la clase 'big' quedaba pegada)
    this._resp = false;
    this.el.center.classList.remove('big');
    this.el.center.innerHTML = esc(text) + (sub ? `<div class="sub">${esc(sub)}</div>` : '');
    this.el.center.classList.add('on');
    clearTimeout(this._centerT);
    if (ms > 0) this._centerT = setTimeout(() => this.el.center.classList.remove('on'), ms);
  }
  centerOff() { clearTimeout(this._centerT); this._resp = false; this.el.center.classList.remove('on', 'big'); }

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
    this.el.center.innerHTML = sec + `<div class="sub">${esc(t('hud.respawning'))}</div>`;
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

function flowTeams(rows, localId, stats) {
  return `<div class="mf-teams">${['red', 'blue'].map((team) => {
    const teamRows = rows.filter((r) => r.team === team);
    const head = stats
      ? `<span class="mf-stat-head">K&nbsp;&nbsp;D&nbsp;&nbsp;&nbsp;${esc(t('hud.points'))}</span>`
      : `<span>${teamRows.length}/4</span>`;
    const body = teamRows.length ? teamRows.map((r) => stats
      ? `<div class="mf-player${r.id === localId ? ' me' : ''}"><span>${esc(r.name)}</span><span>${r.kills ?? 0}</span><span>${r.deaths ?? 0}</span><span>${r.score ?? 0}</span></div>`
      : `<div class="mf-player roster${r.id === localId ? ' me' : ''}"><span>${esc(r.name)}</span><span>${r.id === localId ? esc(t('hud.you')) : ''}</span></div>`).join('')
      : `<div class="mf-player roster"><span>${esc(t('hud.waitingPlayers'))}</span><span>—</span></div>`;
    return `<div class="mf-team ${team}"><div class="mf-team-head"><span>${esc(team === 'red' ? t('hud.teamRed') : t('hud.teamBlue'))}</span>${head}</div>${body}</div>`;
  }).join('')}</div>`;
}

function flowStat(value, label) {
  return `<div class="mf-mvp-stat"><b>${value}</b><span>${label}</span></div>`;
}
