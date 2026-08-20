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

// Respaldo para controles nuevos que todavía no tengan ruta semántica. Los
// menús actuales usan el grafo explícito de navigationGraph().
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

function navMap() { return new Map(); }

function setRoute(graph, from, direction, to, overwrite = true) {
  if (!from || !to || from === to) return;
  const key = focusKey(from);
  if (!key) return;
  const routes = graph.get(key) || {};
  if (overwrite || !routes[direction]) routes[direction] = to;
  graph.set(key, routes);
}

function link(graph, a, direction, b) {
  const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' }[direction];
  setRoute(graph, a, direction, b);
  setRoute(graph, b, opposite, a);
}

function linkLine(graph, elements, direction) {
  const list = elements.filter(visible);
  for (let i = 0; i < list.length - 1; i++) link(graph, list[i], direction, list[i + 1]);
}

function query(scope, selector) { return scope.querySelector(selector); }
function queryAll(scope, selector) { return [...scope.querySelectorAll(selector)].filter(visible); }

function mapIndex(source, target, index) {
  if (!target.length) return null;
  if (source.length <= 1) return target[0];
  return target[Math.round(index * (target.length - 1) / (source.length - 1))];
}

function mainGraph(scope) {
  const graph = navMap();
  if (scope.classList.contains('in-match')) {
    linkLine(graph, ['#btn-resume', '#btn-pause-controls', '#btn-pause-fullscreen', '#btn-leave-match']
      .map((s) => query(scope, s)), 'down');
    return graph;
  }

  const modes = ['#btn-bots', '#btn-practice', '#btn-online'].map((s) => query(scope, s));
  const name = query(scope, '#in-name'), map = query(scope, '#btn-map');
  const server = query(scope, '#in-server'), create = query(scope, '#btn-lobby-create');
  const join = query(scope, '#btn-lobby-join'), character = query(scope, '#btn-character');
  const options = query(scope, '#btn-options'), fullscreen = query(scope, '#btn-fullscreen');
  linkLine(graph, modes, 'down');
  linkLine(graph, [name, map, server, create, character], 'down');
  link(graph, create, 'right', join);
  link(graph, character, 'right', options);
  link(graph, options, 'right', fullscreen);
  setRoute(graph, join, 'up', server); setRoute(graph, join, 'down', options);
  setRoute(graph, fullscreen, 'up', join);
  [[modes[0], name], [modes[1], map], [modes[2], server]].forEach(([a, b]) => link(graph, a, 'right', b));
  setRoute(graph, create, 'left', modes[2]);
  setRoute(graph, character, 'left', modes[2]);
  return graph;
}

function characterGraph(scope) {
  const graph = navMap();
  const slots = queryAll(scope, '.char-slot');
  const back = query(scope, '#btn-char-back');
  linkLine(graph, slots, 'right');
  for (const slot of slots) setRoute(graph, slot, 'down', back);
  const selected = slots.find((el) => el.classList.contains('sel')) || slots[0];
  setRoute(graph, back, 'up', selected);
  return graph;
}

function controlsGraph(scope) {
  const graph = navMap();
  const kb = queryAll(scope, '[data-nav-column="keyboard"]');
  const pad = queryAll(scope, '[data-nav-column="controller"]');
  linkLine(graph, kb, 'down'); linkLine(graph, pad, 'down');
  const count = Math.max(kb.length, pad.length);
  for (let i = 0; i < count; i++) {
    const a = kb[Math.min(i, kb.length - 1)], b = pad[Math.min(i, pad.length - 1)];
    if (a && b) link(graph, a, 'right', b);
  }

  // volumen e idioma viven ahora en sus propios cards de Opciones (Audio /
  // Idioma); aquí solo quedan sensibilidades e inversión de eje
  const mouse = query(scope, '#sl-mouse'), stick = query(scope, '#sl-pad');
  const invertMouse = query(scope, '#chk-invert'), invertPad = query(scope, '#chk-invert-pad');
  const reset = query(scope, '#btn-reset-binds'), back = query(scope, '#btn-back');
  if (kb.length) link(graph, kb.at(-1), 'down', mouse);
  if (pad.length) setRoute(graph, pad.at(-1), 'down', stick);
  // Izquierda/derecha en sliders y selectores modifica el valor, por eso el
  // cambio de columna sucede verticalmente y nunca roba un ajuste.
  linkLine(graph, [mouse, stick], 'down');
  setRoute(graph, stick, 'down', invertMouse);
  link(graph, invertMouse, 'right', invertPad);
  setRoute(graph, invertMouse, 'up', stick); setRoute(graph, invertPad, 'up', stick);
  setRoute(graph, invertMouse, 'down', reset); setRoute(graph, invertPad, 'down', back);
  link(graph, reset, 'right', back);
  setRoute(graph, reset, 'up', invertMouse); setRoute(graph, back, 'up', invertPad);
  return graph;
}

function teamRows(team) {
  const rows = queryAll(team, '.lobby-slot-actions').map((row) => queryAll(row, UI));
  for (const el of [...team.children]) {
    if (el.matches?.('button:not(:disabled)')) rows.push([el]);
  }
  return rows.filter((row) => row.length);
}

function linkRows(graph, rows) {
  for (const row of rows) linkLine(graph, row, 'right');
  for (let i = 0; i < rows.length - 1; i++) {
    for (let col = 0; col < rows[i].length; col++) {
      const down = rows[i + 1][Math.min(col, rows[i + 1].length - 1)];
      setRoute(graph, rows[i][col], 'down', down);
    }
    for (let col = 0; col < rows[i + 1].length; col++) {
      const up = rows[i][Math.min(col, rows[i].length - 1)];
      setRoute(graph, rows[i + 1][col], 'up', up);
    }
  }
}

function lobbyGraph(scope) {
  const graph = navMap();
  const redRows = teamRows(query(scope, '#lobby-red'));
  const blueRows = teamRows(query(scope, '#lobby-blue'));
  const settingRows = queryAll(scope, '#lobby-settings select').map((el) => [el]);
  linkRows(graph, redRows); linkRows(graph, settingRows); linkRows(graph, blueRows);
  const red = redRows.flat(), settings = settingRows.flat(), blue = blueRows.flat();

  red.forEach((el, i) => setRoute(graph, el, 'right', mapIndex(red, settings, i), false));
  settings.forEach((el, i) => {
    setRoute(graph, el, 'left', mapIndex(settings, red, i));
    setRoute(graph, el, 'right', mapIndex(settings, blue, i));
  });
  blue.forEach((el, i) => setRoute(graph, el, 'left', mapIndex(blue, settings, i), false));

  const leave = query(scope, '#btn-lobby-leave'), start = query(scope, '#btn-lobby-start');
  link(graph, leave, 'right', start);
  if (red.length) { setRoute(graph, red.at(-1), 'down', leave); setRoute(graph, leave, 'up', red.at(-1)); }
  if (settings.length) setRoute(graph, settings.at(-1), 'down', start);
  if (blue.length) setRoute(graph, blue.at(-1), 'down', start);
  setRoute(graph, start, 'up', settings.at(-1) || blue.at(-1) || red.at(-1));
  return graph;
}

function navigationGraph(scope) {
  if (scope.id === 'main-card') return mainGraph(scope);
  if (scope.id === 'controls-card') return controlsGraph(scope);
  if (scope.id === 'char-card') return characterGraph(scope);
  if (scope.id === 'lobby-card') return lobbyGraph(scope);
  return navMap();
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
    this.stickLatched = false;
    this.repeatT = 0;
    this.pointer = null;
    this.lastMoveAt = 0;
    this.lastMoveDirection = null;
    this.lastMoveSource = null;

    document.addEventListener('pointermove', (e) => this._pointerMove(e), { passive: true });
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
    if (mode === 'controller') this._ensureFocus(true);
    this._renderPrompts();
  }

  poll(pad, dt, suspended = false) {
    if (!this.active()) { this._clearFocus(); this.prompts.classList.remove('on'); return; }
    const magnitude = Math.hypot(pad.moveX || 0, pad.moveZ || 0);
    const padActivity = pad.connected && (pad.justPressed.size || magnitude >= .67);
    if (padActivity) this.setMode('controller');
    this.prompts.classList.add('on');
    if (suspended || !pad.connected || this.mode !== 'controller') {
      this._ensureFocus(false);
      return;
    }

    this._ensureFocus(true);
    if (pad.justPressed.has(PAD.B)) { this._blockStick(magnitude); this.back(); return; }
    if (pad.justPressed.has(PAD.A)) { this._blockStick(magnitude); this.confirm(); return; }

    let dpad = null;
    if (pad.justPressed.has(PAD.UP)) dpad = 'up';
    else if (pad.justPressed.has(PAD.DOWN)) dpad = 'down';
    else if (pad.justPressed.has(PAD.LEFT)) dpad = 'left';
    else if (pad.justPressed.has(PAD.RIGHT)) dpad = 'right';
    if (dpad) {
      this._blockStick(magnitude);
      this.move(dpad, 'gamepad'); // exactamente un paso por flanco del botón
      return;
    }

    // Histeresis: una inclinación no puede cambiar de eje a mitad del gesto.
    // Hay que volver a neutral antes de iniciar otra dirección.
    if (this.stickLatched) {
      if (magnitude <= .34) {
        this.stickLatched = false; this.stickDir = null; this.repeatT = 0;
        return;
      }
      if (!this.stickDir) return;
      this.repeatT -= dt;
      if (this.repeatT <= 0) {
        this.repeatT = .18;
        this.move(this.stickDir, 'gamepad');
      }
      return;
    }
    if (magnitude < .67) return;
    this.stickDir = Math.abs(pad.moveX) >= Math.abs(pad.moveZ)
      ? (pad.moveX > 0 ? 'right' : 'left')
      : (pad.moveZ > 0 ? 'up' : 'down');
    this.stickLatched = true;
    this.repeatT = .46;
    this.move(this.stickDir, 'gamepad');
  }

  _blockStick(magnitude) {
    if (magnitude <= .34) return;
    this.stickLatched = true;
    this.stickDir = null;
    this.repeatT = 0;
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

  move(direction, source = 'programmatic') {
    const el = this._ensureFocus(true);
    if (!el) return;
    const now = performance.now();
    // Steam Input y algunos drivers presentan el mismo D-pad/stick como
    // Gamepad API + flecha de teclado. La segunda señal del mismo gesto no
    // puede mover el foco otra vez.
    if (source !== this.lastMoveSource && direction === this.lastMoveDirection &&
        now - this.lastMoveAt < 90) return;
    this.lastMoveAt = now;
    this.lastMoveDirection = direction;
    this.lastMoveSource = source;
    if ((direction === 'left' || direction === 'right') &&
        el.matches('select, input[type="range"]')) {
      this._adjust(el, direction === 'right' ? 1 : -1);
      return;
    }
    const scope = this._scope();
    const routes = navigationGraph(scope).get(focusKey(el));
    // Un elemento conocido se queda quieto si esa dirección no tiene salida.
    // Solo los controles futuros sin entrada explícita usan geometría.
    const explicit = routes?.[direction];
    const next = visible(explicit) ? explicit
      : routes ? null : directionalTarget(el, this._items(), direction);
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

  _default(items, scope) {
    if (scope.id === 'char-card') return items.find((el) => el.classList.contains('sel')) || items[0];
    if (scope.id === 'lobby-card') return query(scope, '#btn-lobby-start:not(:disabled)') ||
      items.find((el) => el.dataset.action === 'team') || items.find((el) => el.dataset.setting) || items[0];
    if (scope.id === 'controls-card') return items.find((el) => el.dataset.navColumn === 'keyboard') || items[0];
    return items.find((el) => el.hasAttribute('data-nav-default')) || items[0];
  }

  _ensureFocus(force, changed = false) {
    const scope = this._scope();
    const id = scope.id || 'menu';
    if (id !== this.scopeId) {
      this.scopeId = id; changed = true;
      // Una inclinación que nació en la pantalla anterior no debe repetir en
      // la recién abierta. Permanece bloqueada hasta volver a neutral.
      if (this.stickLatched) { this.stickDir = null; this.repeatT = 0; }
      this.lastMoveAt = 0;
    }
    if (visible(this.focused) && scope.contains(this.focused) && !changed) return this.focused;
    const items = this._items();
    if (!items.length) { this._clearFocus(); return null; }
    const wanted = this.saved.get(id);
    const next = items.find((el) => focusKey(el) === wanted) || this._default(items, scope);
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

  _pointerMove(e) {
    const p = { x: e.clientX, y: e.clientY };
    if (!this.pointer) { this.pointer = p; this.setMode('keyboard'); return; }
    const moved = Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y);
    this.pointer = p;
    if (moved >= 2) this.setMode('keyboard');
  }

  _key(e) {
    if (!this.active() || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.repeat) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const direction = map[e.key];
    if (direction && this._padDirectionHeld(direction)) { e.preventDefault(); return; }
    this.setMode('keyboard');
    if (e.target?.matches?.('input:not([type="range"]), select')) return;
    if (direction) {
      e.preventDefault();
      this._ensureFocus(true);
      this.move(direction, 'keyboard');
    }
  }

  _padDirectionHeld(direction) {
    const pads = navigator.getGamepads?.() || [];
    const button = { up: PAD.UP, down: PAD.DOWN, left: PAD.LEFT, right: PAD.RIGHT }[direction];
    for (const gp of pads) {
      if (!gp?.connected) continue;
      if (gp.buttons?.[button]?.pressed || gp.buttons?.[button]?.value > .5) return true;
      const x = gp.axes?.[0] || 0, y = gp.axes?.[1] || 0;
      if (direction === 'left' && x < -.62 || direction === 'right' && x > .62 ||
          direction === 'up' && y < -.62 || direction === 'down' && y > .62) return true;
    }
    return false;
  }
}
