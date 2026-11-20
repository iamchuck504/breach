import { t, getLanguage } from '../core/i18n.js';
import { TUNING } from '../config/tuning.js';
import { weaponIconMarkup, feedIconMarkup, HEAD_GLYPH } from './weapon-icons.js';
import {BINDS,keyLabel} from '../core/bindings.js';

function setText(el, value) {
  const text = value == null ? '' : String(value);
  if (el.textContent !== text) el.textContent = text;
}

function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

function setAttribute(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// CSSOM normaliza valores ("100.0%" → "100%"); recordar el valor enviado
// evita escribir cada frame aunque la representación que devuelve sea otra.
const styleValues = new WeakMap();
function setStyle(el, name, value) {
  let values = styleValues.get(el);
  if (!values) { values = {}; styleValues.set(el, values); }
  if (values[name] === value) return;
  values[name] = value;
  if (el.style[name] !== value) el.style[name] = value;
}

function clearChildren(el) {
  if (el.firstChild) el.textContent = '';
}

const wheelArrows = ['▶', '◀', '▼', '▲'];

// Movimiento reducido: la regla CSS global acorta las animaciones CSS, pero
// las de Web Animations no la ven. El feedback de combate sigue apareciendo
// (es información), solo pierde escala/desplazamiento.
const reducedMotionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => !!reducedMotionQuery?.matches;
const now = () => performance.now();

// Rangos del marcador de impacto: en la misma ráfaga, una baja nunca queda
// tapada por un headshot ni un headshot por perdigones al cuerpo.
const HIT_RANK = { body: 1, head: 2, kill: 3 };
// Cuánto tiempo domina cada rango sobre los inferiores (ms) y su duración.
const HIT_HOLD = { body: 0, head: 150, kill: 430 };
const HIT_MS = { body: 220, head: 320, kill: 560 };
const HIT_KF = {
  body: [{ opacity: 1, transform: 'scale(1.35)' }, { opacity: 1, transform: 'scale(1)', offset: 0.3 }, { opacity: 0, transform: 'scale(.96)' }],
  head: [{ opacity: 1, transform: 'scale(1.5)' }, { opacity: 1, transform: 'scale(1)', offset: 0.28 }, { opacity: 0, transform: 'scale(1.02)' }],
  kill: [{ opacity: 1, transform: 'scale(1.7) rotate(-12deg)' }, { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.24 }, { opacity: 1, offset: 0.62 }, { opacity: 0, transform: 'scale(1.08)' }],
};
const FADE_KF = [{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }];

// Indicador de daño entrante: pool fijo de arcos, un atacante = un arco.
const DMG_POOL = 4;
const DMG_LIFE = 1.6; // s
// Vida baja: mismo umbral y tempo que el latido de audio (_updateHeart).
const LOW_HP = 0.3;
const heartPeriod = (hp01) => 60 / (72 + (LOW_HP - hp01) * 160);
const KILL_LINE_MS = 1900;

const PULSES = {
  'weapon-change': { kf: [{ opacity: 0.45, transform: 'translateX(10px)' }, { opacity: 1, transform: 'none' }],
    opt: { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' } },
  'ammo-change': { sel: '.mag', kf: [{ transform: 'translateY(-3px) scale(1.07)' }, { transform: 'none' }],
    opt: { duration: 150, easing: 'ease-out' } },
  'score-bump': { kf: [{ transform: 'scale(1.32)', opacity: 0.7 }, { transform: 'scale(.94)', opacity: 1, offset: 0.55 }, { transform: 'none' }],
    opt: { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' } },
  'pip-in': { kf: [{ transform: 'scaleX(.2)', opacity: 0.3 }, { transform: 'scaleX(1.25)', opacity: 1, offset: 0.6 }, { transform: 'none' }],
    opt: { duration: 460, easing: 'ease-out' } },
  'kill-in': { kf: [{ opacity: 0, transform: 'translate(-50%, 8px) scale(.94)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)' }],
    opt: { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' } },
};

// HUD sobre DOM. Toda retícula permanece en el centro óptico: ADS usa el
// anillo y hip/blind usa #barrel-dot; la balística converge desde el muzzle.
export class HUD {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      crosshair: document.getElementById('crosshair'),
      crossRing: document.getElementById('cross-ring'),
      sniperScope: document.getElementById('sniper-scope'),
      scopeReticle: document.getElementById('scope-reticle'),
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
      wepIcon: document.getElementById('weapon-icon-current'),
      wepWheel: document.getElementById('weapon-wheel'),
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
      dmgDir: document.getElementById('dmg-dir'),
      hurtFlash: document.getElementById('hurt-flash'),
      killLine: document.getElementById('kill-confirm'),
    };
    // feedback de combate: estado mínimo, cero asignaciones por cuadro
    this._hitKind = null;
    this._hitAt = -1e9;
    this._hitAnim = null;
    this._dmg = [];
    for (const node of this.el.dmgDir?.children ?? []) {
      this._dmg.push({ node, x: 0, z: 0, age: DMG_LIFE, k: 0, key: null, lastRot: NaN, lastOp: -1 });
    }
    this._lowOn = false;
    this._beat = -1;
    this._tint = -1;
    this._killT = null;
    this._streak = 0;
    this._streakAt = -1e9;
    this._centerT = null;
    this._hintT = null;
    this._wheelT = null;
    this._wheelLeaveT = null;
    this._wheelIntent = null;
    this._wheelSectors = Array.from(this.el.wepWheel?.querySelectorAll('.wheel-sector') ?? [], sector => ({
      sector, idx: Number(sector.dataset.slot), key: sector.querySelector('.wheel-key'),
      icon: sector.querySelector('.wheel-icon'), label: sector.querySelector('.wheel-label'),
      meta: sector.querySelector('.wheel-meta'),
    }));
  }

  // Pulsos cortos con Web Animations: antes se reiniciaba una clase CSS
  // forzando un reflow (offsetWidth) en CADA disparo; así solo se componen
  // transform/opacity y no se toca el layout.
  _pulse(el, cls) {
    const spec = PULSES[cls];
    if (!el || !spec || reducedMotion()) return;
    const target = spec.sel ? el.querySelector(spec.sel) : el;
    if (!target?.animate) return;
    const prev = this._pulses?.get(target);
    prev?.cancel();
    (this._pulses ??= new WeakMap()).set(target, target.animate(spec.kf, spec.opt));
  }

  show(on) {
    setClass(this.el.hud, 'on', on);
    if (!on) { this.hideWeaponWheel(true); this.pickupPrompt(''); this.clearFeedback(); }
  }
  showMenu(on) { setClass(this.el.menu, 'off', !on); }

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
    if (this._scoreUnitKey) for (const el of this.el.scoreUnits) setText(el, t(this._scoreUnitKey));
  }

  _syncWeaponWheel(w, selected = w.selectionTarget ?? w.cur) {
    if (!this.el.wepWheel) return;
    for (const { sector, idx, key, icon, label, meta } of this._wheelSectors) {
      setText(key, `${wheelArrows[idx]} · ${keyLabel(BINDS.kb[`slot${idx+1}`])}`);
      const weapon = w.slots[idx];
      const st = w.state[weapon];
      const def = TUNING.weapons[weapon];
      const unavailable = !weapon || !st || !def;
      setClass(sector, 'unavailable', unavailable);
      if (unavailable) {
        if (sector.dataset.weapon !== '') sector.dataset.weapon = '';
        clearChildren(icon);
        setText(label, '—');
        setText(meta, '—');
        setClass(sector, 'selected', false);
        setClass(sector, 'dry', false);
        setClass(sector, 'needs-reload', false);
        continue;
      }
      if (sector.dataset.weapon !== weapon) {
        sector.dataset.weapon = weapon;
        icon.innerHTML = weaponIconMarkup(weapon);
      }
      setText(label, t(`weapon.${weapon}Short`));
      setText(meta, def.thrown
        ? `×${st.mag}`
        : `${st.mag} / ${st.reserve}`);
      setClass(sector, 'selected', weapon === selected);
      setClass(sector, 'dry', st.mag <= 0 && st.reserve <= 0);
      setClass(sector, 'needs-reload', st.mag <= 0 && st.reserve > 0);
    }
  }

  pickupPrompt(text) {
    if (!this._pickupPrompt) {
      this._pickupPrompt = document.createElement('div');
      this._pickupPrompt.id = 'pickup-prompt';
      document.body.appendChild(this._pickupPrompt);
    }
    setText(this._pickupPrompt, text);
    if (this._pickupPrompt.hidden !== !text) this._pickupPrompt.hidden = !text;
  }

  // Un solo overlay y un solo TTL. Cada nuevo input actualiza el highlight y
  // reinicia la permanencia, evitando flicker o animaciones superpuestas.
  weaponWheel(w, target = w.selectionTarget ?? w.cur) {
    if (!this.el.wepWheel) return;
    this._wheelIntent = target;
    this._syncWeaponWheel(w, target);
    clearTimeout(this._wheelT);
    clearTimeout(this._wheelLeaveT);
    setClass(this.el.wepWheel, 'leaving', false);
    setClass(this.el.wepWheel, 'on', true);
    this._wheelT = setTimeout(() => {
      setClass(this.el.wepWheel, 'on', false);
      setClass(this.el.wepWheel, 'leaving', true);
      this._wheelLeaveT = setTimeout(() => {
        setClass(this.el.wepWheel, 'leaving', false);
        this._wheelIntent = null;
      }, 230);
    }, 500);
  }

  hideWeaponWheel(immediate = false) {
    if (!this.el.wepWheel) return;
    clearTimeout(this._wheelT);
    clearTimeout(this._wheelLeaveT);
    this._wheelIntent = null;
    setClass(this.el.wepWheel, 'on', false);
    if (immediate) setClass(this.el.wepWheel, 'leaving', false);
    else {
      setClass(this.el.wepWheel, 'leaving', true);
      this._wheelLeaveT = setTimeout(() => setClass(this.el.wepWheel, 'leaving', false), 230);
    }
  }

  ammo(w) {
    const weaponChanged = this._lastWep !== undefined && this._lastWep !== w.cur;
    const ammoChanged = !weaponChanged && this._lastMag !== undefined && this._lastMag !== w.st.mag;
    if (weaponChanged) this._pulse(this.el.weapon, 'weapon-change');
    if (ammoChanged) this._pulse(this.el.weapon, 'ammo-change');
    if (this.el.weapon.dataset.weapon !== w.cur) this.el.weapon.dataset.weapon = w.cur;
    if (this.el.wepIcon?.dataset.weapon !== w.cur) {
      this.el.wepIcon.dataset.weapon = w.cur;
      this.el.wepIcon.innerHTML = weaponIconMarkup(w.cur, 'weapon-current-glyph');
    }
    setText(this.el.wepName, t(w.def.nameKey));
    setText(this.el.wepMag, w.st.mag);
    setText(this.el.wepRes, w.st.reserve);
    setText(this.el.wepMsg, w.swapping ? t('hud.switching')
      : w.reloading ? t('hud.reloading')
      : (w.st.mag === 0 && w.st.reserve === 0 ? t('hud.noAmmo') : ''));
    setClass(this.el.weapon, 'reloading', w.reloading);
    setClass(this.el.weapon, 'empty-ammo', w.st.mag <= 0 && w.st.reserve <= 0);
    setClass(this.el.weapon, 'needs-reload', w.st.mag <= 0 && w.st.reserve > 0);
    setClass(this.el.weapon, 'low-ammo', !w.reloading &&
      w.st.mag <= Math.max(2, Math.ceil(w.def.mag * 0.2)));
    this._lastWep = w.cur;
    this._lastMag = w.st.mag;

    // Cargadores chicos = bloques discretos,
    // grandes = barra continua; en recarga barre en naranja
    const cap = w.def.mag;
    const bar = this.el.wepBar;
    if (this._barWep !== w.cur) {
      this._barWep = w.cur;
      if (cap <= 12) {
        clearChildren(bar);
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
    const slotChanged = this._slotSig !== undefined && this._slotSig !== sig;
    if (this._slotSig !== sig) {
      this._slotSig = sig;
      clearChildren(this.el.wepSlots);
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
      const d = TUNING.weapons[k];
      // Consumibles (granadas) y especiales muestran cuánto QUEDA: son
      // recursos limitados y decidir con ellos exige verlo sin equiparlos.
      // Las primarias no lo muestran (el contador grande ya está arriba).
      const left = d?.thrown ? st?.mag ?? 0 : d?.special ? (st?.mag ?? 0) + (st?.reserve ?? 0) : null;
      setText(chips[i].lastChild, !d ? '—' : left === null
        ? t('weapon.' + k + 'Short')
        : `${t('weapon.' + k + 'Short')} ×${left}`);
      setClass(chips[i], 'cur', k === w.cur);
      setClass(chips[i], 'dry', !!st && st.mag <= 0 && st.reserve <= 0);
      setClass(chips[i], 'unavailable', !d || !st);
      setText(chips[i].firstChild, keyLabel(BINDS.kb[`slot${i+1}`]));
    }
    this._syncWeaponWheel(w, this._wheelIntent ?? w.selectionTarget ?? w.cur);
    // Pickups, drops y reset de loadout cambian slots sin pasar por el input
    // normal. También merecen feedback, pero la carga inicial no abre el wheel.
    if (slotChanged) this.weaponWheel(w, w.cur);

    // progreso real de la recarga normal
    const rel = w.reloading ? w.reloadProgress : null;
    setClass(bar, 'reloading', w.reloading);
    if (cap <= 12) {
      // En per-shell solo se encienden cartuchos ya insertados; la animación
      // por sí sola nunca debe representar munición todavía inutilizable.
      const filled = w.def.perShell ? w.st.mag : (rel !== null ? Math.round(rel * cap) : w.st.mag);
      const segs = bar.children;
      for (let i = 0; i < segs.length; i++) setClass(segs[i], 'on', i < filled);
    } else {
      const fill = bar.querySelector('.fill');
      if (fill) setStyle(fill, 'width', ((rel !== null ? rel : w.st.mag / cap) * 100).toFixed(1) + '%');
    }
  }

  score(r, b, unit = 'hud.eliminations') {
    if (this._scoreR !== undefined && r !== this._scoreR) this._pulse(this.el.scoreRed, 'score-bump');
    if (this._scoreB !== undefined && b !== this._scoreB) this._pulse(this.el.scoreBlue, 'score-bump');
    setText(this.el.scoreRed, r);
    setText(this.el.scoreBlue, b);
    this._scoreUnitKey = unit;
    for (const el of this.el.scoreUnits) setText(el, t(unit));
    this._scoreR = r;
    this._scoreB = b;
  }

  // temporizador de ronda en el separador central (m:ss); null → "VS"
  timer(sec) {
    if (sec === null) { setText(this.el.scoreSep, 'VS'); setClass(this.el.scoreSep, 'urgent', false); return; }
    const s = Math.max(0, Math.ceil(sec));
    setText(this.el.scoreSep, Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
    // últimos 10 s: el reloj cambia de color y late (clase, sin escritura por cuadro)
    setClass(this.el.scoreSep, 'urgent', s > 0 && s <= 10);
  }

  // pips de rondas ganadas (mejor de 3)
  roundPips(winsR, winsB) {
    if (winsR === null) { clearChildren(this.el.roundPips); this._roundKey = null; this._roundWins = null; return; }
    const key = winsR + ':' + winsB;
    if (this._roundKey === key) return;
    const prev = this._roundWins;
    this._roundKey = key;
    this._roundWins = [winsR, winsB];
    let html = '';
    for (let i = 0; i < 2; i++) html += `<div class="pip${i < winsR ? ' red' : ''}"></div>`;
    for (let i = 0; i < 2; i++) html += `<div class="pip${i < winsB ? ' blue' : ''}"></div>`;
    this.el.roundPips.innerHTML = html;
    // la ronda recién ganada se enciende con un pulso (no en la carga inicial)
    if (prev) {
      const pips = this.el.roundPips.children;
      if (winsR > prev[0] && pips[winsR - 1]) this._pulse(pips[winsR - 1], 'pip-in');
      if (winsB > prev[1] && pips[2 + winsB - 1]) this._pulse(pips[2 + winsB - 1], 'pip-in');
    }
  }

  // scoreboard (Tab / VIEW): rows ordenadas por puntaje, null → ocultar
  scoreboard(rows, localId = 'player') {
    setClass(this.el.scoreboard, 'on', !!rows);
    if (!rows) { this._scoreboardKey = null; return; }
    const key = getLanguage() + '|' + localId + '|' + rows.map((r) => `${r.id}:${r.name}:${r.team}:${r.kills}:${r.deaths}:${r.score}`).join('|');
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
    // intro/fin de ronda/fin de partida: nada del combate anterior queda pegado
    if (!!view !== !!this._flowOn) { this._flowOn = !!view; if (view) this.clearFeedback(); }
    if (!view) {
      if (root.className) root.className = '';
      clearChildren(root);
      this._presentationKey = null;
      return;
    }
    const rows = view.rows || [];
    const count = view.count ?? '';
    const key = [getLanguage(), view.phase, view.title, view.sub, count, view.red, view.blue,
      rows.map((r) => `${r.id}:${r.kills ?? ''}:${r.deaths ?? ''}:${r.score ?? ''}`).join('|')].join('~');
    const classes = `on ${view.phase}`;
    if (root.className !== classes) root.className = classes;
    if (this._presentationKey === key) {
      const bar = root.querySelector('.mf-progress span');
      if (bar && view.progress !== undefined) setStyle(bar, 'width', `${Math.max(0, Math.min(100, view.progress * 100))}%`);
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
    // morir → espectar: arcos, línea de baja, racha y vignette no sobreviven
    if (!!view !== !!this._specOn) { this._specOn = !!view; if (view) this.clearFeedback(); }
    setClass(this.el.hud, 'spectating', !!view);
    setClass(root, 'on', !!view);
    if (!view) {
      clearChildren(root);
      this._spectatorKey = null;
      return;
    }
    const key = [getLanguage(), view.name, view.controls, view.respawn, view.waiting,view.ready].join('|');
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

  // Tinte de bordes según la vida + estado de vida baja que "respira" con el
  // tempo del latido de audio. Valores cuantizados: escribe solo al cambiar.
  health(pct) {
    const hp = Math.max(0, Math.min(1, pct));
    const tint = hp < 0.99 ? Math.round((1 - hp) * 0.7 * 20) / 20 : 0;
    if (tint !== this._tint) { this._tint = tint; setStyle(this.el.vignette, 'opacity', String(tint)); }
    const low = hp > 0 && hp < LOW_HP;
    if (low) {
      const beat = Math.round(heartPeriod(hp) * 20); // pasos de 50 ms
      if (beat !== this._beat) {
        this._beat = beat;
        this.el.vignette.style.setProperty('--beat', (beat / 20).toFixed(2) + 's');
      }
    }
    if (low !== this._lowOn) {
      this._lowOn = low;
      setClass(this.el.vignette, 'low', low);
      setClass(this.el.hud, 'low-hp', low);
    }
  }

  // kind: 'body' | 'head' | 'kill'. Varias llamadas en la misma ráfaga
  // (perdigones, bajas encadenadas) se resuelven por rango: nunca se apilan.
  hitmarker(kind = 'body') {
    const el = this.el.hitmarker;
    if (!el) return;
    const k = HIT_RANK[kind] ? kind : 'body';
    const ts = now();
    const cur = this._hitKind;
    if (cur) {
      const age = ts - this._hitAt;
      if (HIT_RANK[k] < HIT_RANK[cur] && age < HIT_HOLD[cur]) return;
      if (k === cur && age < 45) return;
    }
    this._hitKind = k;
    this._hitAt = ts;
    if (el.dataset.k !== k) el.dataset.k = k;
    setStyle(el, 'left', this._aimX != null ? this._aimX + 'px' : '50%');
    setStyle(el, 'top', this._aimY != null ? this._aimY + 'px' : '50%');
    this._hitAnim?.cancel();
    if (!el.animate) return;
    this._hitAnim = el.animate(reducedMotion() ? FADE_KF : HIT_KF[k],
      { duration: HIT_MS[k], easing: 'ease-out' });
  }

  // Daño recibido. from = {x,z} del atacante (mundo) o null si se desconoce.
  // key identifica al atacante: el mismo vuelve a pegar → refresca su arco.
  hurt(from, amount = 10, key = null) {
    this.hurtArc(from, amount, key);
    this.hurtFlash(!!from, amount);
  }

  // Solo el arco (online: la dirección puede confirmarse después del destello).
  hurtArc(from, amount = 10, key = null) {
    const k = Math.min(1, 0.5 + Math.max(0, amount) / 45);
    if (from && Number.isFinite(from.x) && Number.isFinite(from.z) && this._dmg.length) {
      let slot = null;
      if (key != null) for (const d of this._dmg) if (d.age < DMG_LIFE && d.key === key) slot = d;
      if (!slot) {
        slot = this._dmg[0];
        for (const d of this._dmg) if (d.age > slot.age) slot = d;
      }
      slot.k = Math.min(1, Math.max(slot.age < DMG_LIFE ? slot.k : 0, k));
      slot.x = from.x;
      slot.z = from.z;
      slot.age = 0;
      slot.key = key;
    }
  }

  // Solo el destello de bordes; más fuerte si no hay dirección conocida.
  hurtFlash(directional, amount = 10) {
    const flash = this.el.hurtFlash;
    if (!flash?.animate) return;
    this._hurtAnim?.cancel();
    const peak = Math.min(0.6, (directional ? 0.22 : 0.4) + amount / 90);
    this._hurtAnim = flash.animate([{ opacity: peak }, { opacity: 0 }],
      { duration: directional ? 420 : 600, easing: 'ease-out' });
  }

  // Por cuadro: orienta los arcos de daño respecto a la cámara. Solo escribe
  // estilos cuando cambian (rotación en pasos de 0.5°, opacidad en 1/50).
  // ox/oz: posición del jugador. El rumbo se mide desde él (no desde la
  // cámara de hombro: un atacante entre cámara y jugador daría un arco
  // frontal para un tiro por la espalda) y se orienta con el yaw de cámara.
  feedback(dt, camera, ox = null, oz = null) {
    if (!this._dmg.length) return;
    let e = null;
    for (const d of this._dmg) {
      if (d.age >= DMG_LIFE) {
        if (d.lastOp !== 0) { d.lastOp = 0; d.node.style.opacity = '0'; }
        continue;
      }
      d.age += dt;
      const life = Math.max(0, 1 - d.age / DMG_LIFE);
      const op = Math.round(d.k * Math.pow(life, 0.6) * 50) / 50;
      if (op !== d.lastOp) { d.lastOp = op; d.node.style.opacity = String(op); }
      if (!camera) continue;
      e ??= camera.matrixWorld.elements;
      // cámara mira a -Z local: forward = -(col 2); derecha = (-fz, fx)
      const fx = -e[8], fz = -e[10];
      const tx = d.x - (ox ?? e[12]), tz = d.z - (oz ?? e[14]);
      const a = Math.atan2(tx * -fz + tz * fx, tx * fx + tz * fz);
      const deg = Math.round(a * 114.59) / 2; // 0.5°
      if (deg !== d.lastRot) {
        d.lastRot = deg;
        d.node.style.transform = `rotate(${deg}deg)`;
      }
    }
  }

  // Suelta todo lo transitorio (cambio de partida, muerte, menú).
  clearFeedback() {
    this._hitAnim?.cancel();
    this._hurtAnim?.cancel();
    this._hitKind = null;
    for (const d of this._dmg) d.age = DMG_LIFE;
    clearTimeout(this._killT);
    setClass(this.el.killLine, 'on', false);
    this._streak = 0;
    this._streakAt = -1e9;
    // vignette de vida: sin halo pegado hasta el próximo health() real
    this._tint = 0;
    setStyle(this.el.vignette, 'opacity', '0');
    if (this._lowOn) {
      this._lowOn = false;
      setClass(this.el.vignette, 'low', false);
      setClass(this.el.hud, 'low-hp', false);
    }
  }

  // Confirmación de baja junto a la retícula (debajo, sin tapar el centro):
  // víctima, arma y si fue headshot. Bajas seguidas suman racha (×2, ×3…).
  killConfirm(victimName, weapon = null, head = false) {
    const el = this.el.killLine;
    if (!el) return;
    const ts = now();
    this._streak = ts - this._streakAt < 4500 ? this._streak + 1 : 1;
    this._streakAt = ts;
    el.innerHTML =
      `<span class="kc-tag">${esc(t('hud.eliminated'))}</span>` +
      `<span class="kc-name">${esc(victimName || '—')}</span>` +
      (weapon ? `<span class="kc-wep">${feedIconMarkup(weapon)}</span>` : '') +
      (head ? `<span class="kc-head">${HEAD_GLYPH}${esc(t('hud.headshot'))}</span>` : '') +
      (this._streak > 1 ? `<span class="kc-streak">×${this._streak}</span>` : '');
    setClass(el, 'head', !!head);
    setClass(el, 'on', true);
    this._pulse(el, 'kill-in');
    clearTimeout(this._killT);
    this._killT = setTimeout(() => setClass(el, 'on', false), KILL_LINE_MS);
  }

  // ADS usa el centro óptico. Hip/blindfire recibe la proyección física del
  // barrel porque su cañón puede estar fuera de esa línea central.
  reticle(aiming, barrelXY, aimInfo = null) {
    setClass(this.el.crosshair, 'aim', aiming);
    // ADS siempre usa el mismo estado óptico: el daño viaja por el eje de la
    // cámara, así que la cruz nunca necesita avisar de una obstrucción ni
    // saltar o cambiar de color entre frames.
    if (aiming && aimInfo) {
      setAttribute(this.el.crossRing, 'r', Math.max(5, aimInfo.r).toFixed(1));
      // fuera del rango efectivo del arma: el anillo se atenúa
      setAttribute(this.el.crossRing, 'stroke-opacity', aimInfo.inRange ? '0.9' : '0.28');
      setStyle(this.el.crosshair, 'left', '50%');
      setStyle(this.el.crosshair, 'top', '50%');
    }
    setClass(this.el.barrel, 'on', !aiming && barrelXY);
    // el marcador de impacto nace donde el jugador apunta: centro en ADS,
    // punto del cañón en hip/blindfire (solo se lee al haber un impacto)
    this._aimX = !aiming && barrelXY ? barrelXY.x : null;
    this._aimY = !aiming && barrelXY ? barrelXY.y : null;
    if (!aiming && barrelXY) {
      setStyle(this.el.barrel, 'left', barrelXY.x + 'px');
      setStyle(this.el.barrel, 'top', barrelXY.y + 'px');
    }
  }

  // El scope conserva siempre su cruz óptica central y su color base.
  sniperScope(on) {
    const root = this.el.sniperScope;
    const reticle = this.el.scopeReticle;
    if (!root || !reticle) return;
    setClass(root, 'on', !!on);
    setAttribute(root, 'aria-hidden', on ? 'false' : 'true');
    setClass(this.el.hud, 'scoped', !!on);
    setClass(reticle, 'out-range', false);
    setStyle(reticle, 'left', '50%');
    setStyle(reticle, 'top', '50%');
  }

  // Kill feed: asesino · icono real del arma · [headshot] · víctima.
  // opts.local = 'killer' | 'victim' resalta las filas que involucran al jugador.
  kill(killerName, killerTeam, victimName, victimTeam, opts = null) {
    const row = document.createElement('div');
    const local = opts?.local;
    row.className = 'row' + (local === 'killer' ? ' mine' : local === 'victim' ? ' died' : '');
    const team = (x) => (x === 'red' || x === 'blue' ? x : '');
    row.innerHTML =
      `<span class="kf-name ${team(killerTeam)}">${esc(killerName)}</span>` +
      `<span class="kf-wep">${feedIconMarkup(opts?.weapon)}</span>` +
      (opts?.head ? `<span class="kf-head" title="${esc(t('hud.headshot'))}">${HEAD_GLYPH}</span>` : '') +
      `<span class="kf-name ${team(victimTeam)}">${esc(victimName)}</span>`;
    this.el.feed.prepend(row);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
    setTimeout(() => row.remove(), local ? 6500 : 5200);
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

  clearFeed() { this.el.feed.innerHTML = ''; this.clearFeedback(); }

  // countdown grande de respawn: sec entero, o null para ocultarlo
  respawnTick(sec) {
    if (sec === null) {
      if (this._resp) {
        this._resp = false;
        setClass(this.el.center, 'big', false);
        setClass(this.el.center, 'on', false);
      }
      return;
    }
    if (this._resp === sec) return;
    this._resp = sec;
    clearTimeout(this._centerT);
    setClass(this.el.center, 'big', true);
    setClass(this.el.center, 'on', true);
    this.el.center.innerHTML = sec + `<div class="sub">${esc(t('hud.respawning'))}</div>`;
  }

  hint(text, ms = 1600) {
    setText(this.el.hint, text);
    setClass(this.el.hint, 'on', true);
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
