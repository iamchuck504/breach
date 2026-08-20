import { t } from '../core/i18n.js';

const UI = 'button:not(:disabled), select:not(:disabled), input:not(:disabled)';
const PAD = Object.freeze({ A: 0, B: 1, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 });
const DIRS = Object.freeze({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });

const visible = (el) => {
  if (!el?.isConnected || el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' &&
    Number(style.opacity || 1) > 0 && el.getClientRects().length > 0;
};

const center = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
};

// Navegación geométrica: la jerarquía visual del menú es la jerarquía de
// control. Favorece elementos alineados en la dirección pedida y evita saltos
// diagonales hacia controles que casualmente se crearon antes en el DOM.
export function directionalTarget(current, candidates, direction) {
  const [dx, dy] = DIRS[direction] || [0, 0];
  if (!current || (!dx && !dy)) return null;
  const a = center(current);
  let best = null, bestScore = Infinity;
  for (const el of candidates) {
    if (el === current) continue;
    const b = center(el);
    const vx = b.x - a.x, vy = b.y - a.y;
    const forward = vx * dx + vy * dy;
    if (forward < 4) continue;
    const side = Math.abs(vx * dy - vy * dx);
    const aligned = dx ? overlap(a.r.top, a.r.bottom, b.r.top, b.r.bottom)
      : overlap(a.r.left, a.r.right, b.r.left, b.r.right);
    const score = forward + side * (aligned ? 0.28 : 0.72);
    if (score < bestScore) { best = el; bestScore = score; }
  }
  return best;
}

function overlap(a0, a1, b0, b1) { return Math.min(a1, b1) >= Math.max(a0, b0); }

function focusKey(el) {
  return el?.dataset?.navKey || el?.id ||
    [el?.dataset?.action, el?.dataset?.id, el?.dataset?.team, el?.dataset?.setting]
      .filter(Boolean).join(':');
}

function actionLabel(el) {
  if (!el) return t('nav.select');
  if (el.matches('select, input[type="range"]')) return t('nav.change');
  if (el.matches('input[type="checkbox"]')) return t('nav.toggle');
  if (el.matches('input:not([type]), input[type="text"]')) return t('nav.edit');
  return (el.querySelector?.('.btn-copy')?.textContent || el.textContent || t('nav.select'))
    .replace(/\s+/g, ' ').trim().slice(0, 34);
}

export class MenuControllerNavigator {
  constructor({ menu, splash, prompts, onMove, onBack }) {
    this.menu = menu;
    this.splash = splash;
    this.prompts = prompts;
    this.onMove = onMove;
    this.onBack = onBack;
    this.mode = 'keyboard';
    this.focused = null;
    this.saved = new Map();
    this.scopeId = '';
    this.stickDir = null;
    this.repeatT = 0;

    document.addEventListener('pointermove', () => this.setMode('keyboard'), { passive: true });
    document.addEventListener('mousedown', () => this.setMode('keyboard'), { passive: true });
    document.addEventListener('keydown', (e) => this._key(e), true);
    document.addEventListener('focusin', (e) => {
      if (e.target?.matches?.(UI)) this._setFocus(e.target, false);
    });
  }

  active() { return visible(this.splash) || visible(this.menu); }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    document.body.classList.toggle('using-controller', mode === 'controller');
    document.body.classList.toggle('using-keyboard', mode !== 'controller');
    this._renderPrompts();
  }

  poll(pad, dt, suspended = false) {
    if (!this.active()) { this._clearFocus(); this.prompts.classList.remove('on'); return; }
    const padActivity = pad.connected && (pad.justPressed.size ||
      Math.abs(pad.moveX) > .58 || Math.abs(pad.moveZ) > .58);
    if (padActivity) this.setMode('controller');
    this.prompts.classList.add('on');
    if (suspended || !pad.connected || this.mode !== 'controller') {
      this._ensureFocus(false);
      return;
    }

    this._ensureFocus(true);
    if (pad.justPressed.has(PAD.B)) { this.back(); return; }
    if (pad.justPressed.has(PAD.A)) { this.confirm(); return; }

    let dir = null;
    if (pad.justPressed.has(PAD.UP)) dir = 'up';
    else if (pad.justPressed.has(PAD.DOWN)) dir = 'down';
    else if (pad.justPressed.has(PAD.LEFT)) dir = 'left';
    else if (pad.justPressed.has(PAD.RIGHT)) dir = 'right';
    const stickDir = Math.abs(pad.moveX) > Math.abs(pad.moveZ)
      ? (pad.moveX > .62 ? 'right' : pad.moveX < -.62 ? 'left' : null)
      : (pad.moveZ > .62 ? 'up' : pad.moveZ < -.62 ? 'down' : null);
    if (dir) {
      this.stickDir = null; this.repeatT = 0;
      this.move(dir);
    } else if (stickDir) {
      if (stickDir !== this.stickDir) {
        this.stickDir = stickDir; this.repeatT = .38; this.move(stickDir);
      } else {
        this.repeatT -= dt;
        if (this.repeatT <= 0) { this.repeatT = .12; this.move(stickDir); }
      }
    } else { this.stickDir = null; this.repeatT = 0; }
  }

  back() {
    if (!this.active()) return false;
    const handled = this.onBack?.() !== false;
    if (handled) {
      this.onMove?.();
      queueMicrotask(() => this._ensureFocus(this.mode === 'controller', true));
    }
    return handled;
  }

  refreshPrompts() { this._renderPrompts(); }

  confirm() {
    const el = this._ensureFocus(true);
    if (!el) return;
    if (el.matches('select')) { this._adjust(el, 1); return; }
    if (el.matches('input[type="checkbox"]')) { el.click(); return; }
    if (el.matches('input[type="range"]')) { this._adjust(el, 1); return; }
    if (el.matches('input')) { el.focus(); return; }
    el.click();
    queueMicrotask(() => this._ensureFocus(true, true));
  }

  move(direction) {
    const el = this._ensureFocus(true);
    if (!el) return;
    if ((direction === 'left' || direction === 'right') &&
        el.matches('select, input[type="range"]')) {
      this._adjust(el, direction === 'right' ? 1 : -1);
      return;
    }
    const next = directionalTarget(el, this._items(), direction);
    if (next) { this._setFocus(next, true); this.onMove?.(); }
  }

  _adjust(el, delta) {
    if (el.matches('select')) {
      const enabled = [...el.options].map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
      const at = enabled.findIndex(({ i }) => i === el.selectedIndex);
      const next = enabled[Math.max(0, Math.min(enabled.length - 1, at + delta))];
      if (!next || next.i === el.selectedIndex) return;
      el.selectedIndex = next.i;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const step = Number(el.step) || 1, min = Number(el.min) || 0, max = Number(el.max) || 100;
      const value = Math.max(min, Math.min(max, Number(el.value) + step * delta));
      if (value === Number(el.value)) return;
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.onMove?.();
    queueMicrotask(() => this._ensureFocus(true, true));
  }

  _scope() {
    if (visible(this.splash)) return this.splash;
    const cards = [...this.menu.querySelectorAll('.menu-card')].filter(visible);
    return cards[0] || this.menu;
  }

  _items() { return [...this._scope().querySelectorAll(UI)].filter(visible); }

  _ensureFocus(force, changed = false) {
    const scope = this._scope();
    const id = scope.id || 'menu';
    if (id !== this.scopeId) { this.scopeId = id; changed = true; }
    if (visible(this.focused) && scope.contains(this.focused) && !changed) return this.focused;
    const items = this._items();
    if (!items.length) { this._clearFocus(); return null; }
    const wanted = this.saved.get(id);
    const next = items.find((el) => focusKey(el) === wanted) ||
      items.find((el) => el.hasAttribute('data-nav-default')) || items[0];
    if (force || this.mode === 'controller') this._setFocus(next, true);
    else this._setFocus(document.activeElement && items.includes(document.activeElement)
      ? document.activeElement : next, false);
    return this.focused;
  }

  _setFocus(el, nativeFocus) {
    if (!el || !visible(el)) return;
    this.focused?.classList.remove('menu-nav-focus');
    this.focused = el;
    el.classList.add('menu-nav-focus');
    this.saved.set(this.scopeId || this._scope().id || 'menu', focusKey(el));
    if (nativeFocus) {
      try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      requestAnimationFrame(() => {
        if (!visible(el) || !visible(this.menu)) return;
        const r = el.getBoundingClientRect();
        const top = 14, bottom = innerHeight - (this.mode === 'controller' ? 62 : 14);
        if (r.bottom > bottom) this.menu.scrollTop += r.bottom - bottom + 10;
        else if (r.top < top) this.menu.scrollTop -= top - r.top + 10;
      });
    }
    this._renderPrompts();
  }

  _clearFocus() {
    this.focused?.classList.remove('menu-nav-focus');
    this.focused = null;
  }

  _renderPrompts() {
    if (!this.prompts) return;
    const controller = this.mode === 'controller';
    const pieces = controller
      ? [['A', actionLabel(this.focused)], ['B', t('nav.back')], ['✚ / LS', t('nav.navigate')]]
      : [['↵', actionLabel(this.focused)], ['ESC', t('nav.back')], ['↑↓←→', t('nav.navigate')]];
    this.prompts.replaceChildren(...pieces.map(([key, label]) => {
      const item = document.createElement('span'); item.className = 'menu-prompt';
      const badge = document.createElement('b'); badge.textContent = key;
      item.append(badge, document.createTextNode(label)); return item;
    }));
  }

  _key(e) {
    if (!this.active() || e.altKey || e.ctrlKey || e.metaKey) return;
    this.setMode('keyboard');
    if (e.target?.matches?.('input:not([type="range"]), select')) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[e.key]) { e.preventDefault(); this._ensureFocus(true); this.move(map[e.key]); }
  }
}
