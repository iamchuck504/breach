// UI del editor de mapas: barra superior, biblioteca (izquierda), propiedades
// y validación (derecha). Se construye por JS y vive en su propio overlay,
// así el HTML del juego no carga con paneles que solo existen en el editor.
import { PALETTE, THEMES, SNAP_POS, SNAP_ROT } from './editor.js';
import { paletteById } from '../world/map-data.js';
import { t, onLanguageChange } from '../core/i18n.js';

const et = (key, vars) => t(`editor.${key}`, vars);
const pieceName = (piece) => piece ? t(piece.labelKey ?? '') || piece.label : '—';
const themeName = (themeId) => {
  const translated = t(`map.${themeId}`);
  return translated === `map.${themeId}` ? themeId.toUpperCase() : translated.toUpperCase();
};

const CSS = `
#editor-ui { position: fixed; inset: 0; pointer-events: none; z-index: 40;
  font-family: var(--mono, monospace); color: #dfe4e8; display: none; }
#editor-ui.on { display: block; }
#editor-ui, #editor-ui * { box-sizing: border-box; }
#editor-ui .panel { position: absolute; pointer-events: auto;
  background: linear-gradient(180deg, rgba(13,18,23,.97), rgba(9,13,17,.94));
  border: 1px solid #303a44; box-shadow: 0 12px 30px rgba(0,0,0,.24); backdrop-filter: blur(8px); }
#ed-top { top: 0; left: 0; right: 0; display: flex; gap: 6px; align-items: center;
  padding: 7px 10px; flex-wrap: wrap; border-bottom: 2px solid #6e91aa !important; }
#ed-top .sep { width: 1px; height: 20px; background: #2b333c; margin: 0 4px; }
#editor-ui button { background: #1a2027; color: #cfd6dc; border: 1px solid #323b45;
  min-height: 29px; padding: 5px 9px; font: inherit; font-size: 11px; letter-spacing: .05em; cursor: pointer; }
#editor-ui button:hover { background: #26313a; border-color: #566572; }
#editor-ui button:focus-visible { outline: 2px solid #ffd199; outline-offset: 1px; }
#editor-ui button.on { background: #ffad58; color: #14181c; border-color: #ffc27f;
  box-shadow: inset 0 -2px 0 rgba(126,53,0,.28), 0 0 0 1px rgba(255,176,87,.18); }
#ed-playtest { background: #d86e2d !important; color: #fff5e9 !important; border-color: #ff9c57 !important; }
#editor-ui button.danger:hover { background: #7a2f2f; border-color: #b45a5a; }
#editor-ui select, #editor-ui input { background: #12171c; color: #cfd6dc;
  border: 1px solid #36424c; font: inherit; font-size: 11px; min-height: 29px; padding: 4px 6px; }
/* la barra superior puede envolver en pantallas estrechas: los paneles
   arrancan bajo su altura REAL, medida en runtime (--ed-top-h) */
#ed-left { left: 0; top: var(--ed-top-h, 46px); bottom: 0; width: 224px;
  overflow-y: auto; overflow-x: hidden; padding: 10px; }
#ed-right { right: 0; top: var(--ed-top-h, 46px); width: 282px;
  max-height: calc(100vh - var(--ed-top-h, 46px) - 10px); overflow-y: auto; overflow-x:hidden; padding: 10px; }
#editor-ui h4 { margin: 12px 0 6px; font-size: 10px; letter-spacing: .16em;
  color: #7d8894; font-weight: 600; }
#editor-ui h4:first-child { margin-top: 0; }
#ed-left .lib { display: grid; grid-template-columns: 1fr; gap: 4px; }
#ed-left .lib button { display:grid; grid-template-columns:28px 1fr; align-items:center;
  text-align:left; padding:6px 7px; min-height:42px; min-width:0; width:100%; }
.piece-icon { grid-row:1 / span 2; display:grid; place-items:center; width:24px; height:24px;
  border:1px solid #46525e; background:#10151a; color:#ffb057; font-size:15px; }
.piece-name { color:#e4e9ed; font-size:10.5px; line-height:1.15; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.piece-meta { color:#73808b; font-size:8px; line-height:1.2; letter-spacing:.06em; margin-top:2px; }
#ed-left .lib button.on .piece-icon { background:#161b20; border-color:#8a4a18; color:#ff7e3c; }
#ed-left .lib button.on .piece-name { color:#14181c; }
#ed-left .lib button.on .piece-meta { color:#5b3a21; }
.field-label { display:block; color:#7d8994; font-size:9px; letter-spacing:.12em; margin:7px 0 4px; }
#ed-props .row { display: grid; grid-template-columns: 22px 1fr; gap: 6px;
  align-items: center; margin-bottom: 5px; }
#ed-props .row label { font-size: 10px; color: #7d8894; }
#ed-valid div { font-size: 11px; margin-bottom: 4px; line-height: 1.35; }
#ed-valid .ok::before { content: "✓ "; font-weight:700; }
#ed-valid .warn::before { content: "△ "; font-weight:700; }
#ed-valid .error::before { content: "× "; font-weight:700; }
#ed-valid .warn { color: #ffd166; }
#ed-valid .error { color: #ff8080; }
#ed-status { position: absolute; left: 236px; bottom: 12px; pointer-events: none;
  padding:6px 9px; border:1px solid rgba(91,110,126,.45); background:rgba(8,12,16,.8);
  font-size: 10px; color: #c0cad2; text-shadow: 0 1px 2px #000; }
#ed-hint { position: absolute; right: 294px; bottom: 12px; pointer-events: none;
  padding:6px 9px; background:rgba(8,12,16,.72); border-left:2px solid #49667c;
  font-size: 9px; color: #a8b3bc; text-align: right; line-height: 1.5; }
@media (max-width:1150px) {
  #ed-left { width:186px; } #ed-right { width:232px; }
  #ed-status { left:196px; } #ed-hint { right:244px; }
  .piece-meta { display:none; } #ed-left .lib button { min-height:32px; }
}
`;

export class EditorUI {
  constructor(editor, { onPlaytest, onExit }) {
    this.ed = editor;
    this.onPlaytest = onPlaytest;
    this.onExit = onExit;
    this._build();
    editor.onChange = () => this.refresh();
    this._offLanguage = onLanguageChange(() => this.refresh());
  }

  _build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    const root = document.createElement('div');
    root.id = 'editor-ui';
    root.innerHTML = `
      <div class="panel" id="ed-top">
        <button data-tool="select" data-ed-key="select">${et('select')}</button>
        <button data-tool="move" data-ed-key="move">${et('move')}</button>
        <button data-tool="rotate" data-ed-key="rotate">${et('rotate')}</button>
        <button data-tool="scale" data-ed-key="scale">${et('scale')}</button>
        <span class="sep"></span>
        <button id="ed-grid" data-ed-key="grid">${et('grid')}</button>
        <select id="ed-snap" title="Snap de posición"></select>
        <select id="ed-snaprot" title="Snap de rotación"></select>
        <span class="sep"></span>
        <button id="ed-undo" data-ed-key="undo">${et('undo')}</button>
        <button id="ed-redo" data-ed-key="redo">${et('redo')}</button>
        <button id="ed-dup" data-ed-key="duplicate">${et('duplicate')}</button>
        <button id="ed-del" data-ed-key="delete">${et('delete')}</button>
        <span class="sep"></span>
        <button id="ed-mirx" data-ed-key="mirrorX">${et('mirrorX')}</button>
        <button id="ed-mirz" data-ed-key="mirrorZ">${et('mirrorZ')}</button>
        <span class="sep"></span>
        <button id="ed-cover" data-ed-key="cover">${et('cover')}</button>
        <button id="ed-nav" data-ed-key="nav">${et('nav')}</button>
        <button id="ed-path" data-ed-key="route">${et('route')}</button>
        <button id="ed-top-view" data-ed-key="topView">${et('topView')}</button>
        <span class="sep"></span>
        <button id="ed-save" data-ed-key="save">${et('save')}</button>
        <button id="ed-playtest" data-ed-key="playtest">${et('playtest')}</button>
        <button id="ed-exit" data-ed-key="exit">${et('exit')}</button>
      </div>
      <div class="panel" id="ed-left">
        <h4 data-ed-key="map">${et('map')}</h4>
        <label class="field-label" data-ed-key="name">${et('name')}</label>
        <div class="row"><input id="ed-name" /></div>
        <select id="ed-theme" style="width:100%;margin-top:4px"></select>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:7px">
          <span class="field-label" data-ed-key="halfWidth">${et('halfWidth')}</span>
          <span class="field-label" data-ed-key="halfLength">${et('halfLength')}</span>
        </div>
        <div style="display:flex;gap:4px;margin-top:6px">
          <input id="ed-fx" type="number" step="0.5" style="width:50%" />
          <input id="ed-fz" type="number" step="0.5" style="width:50%" />
        </div>
        <div style="display:flex;gap:4px;margin-top:6px">
          <button id="ed-new" data-ed-key="new" style="flex:1">${et('new')}</button>
          <button id="ed-saveas" data-ed-key="saveAs" style="flex:1">${et('saveAs')}</button>
        </div>
        <select id="ed-maps" style="width:100%;margin-top:6px"></select>
        <div style="display:flex;gap:4px;margin-top:4px">
          <button id="ed-open" data-ed-key="open" style="flex:1">${et('open')}</button>
          <button id="ed-delmap" data-ed-key="delete" class="danger" style="flex:1">${et('delete')}</button>
        </div>
        <h4 data-ed-key="library">${et('library')}</h4>
        <div class="lib" id="ed-lib"></div>
      </div>
      <div class="panel" id="ed-right">
        <h4 data-ed-key="properties">${et('properties')}</h4>
        <div id="ed-props"></div>
        <h4 data-ed-key="validation">${et('validation')}</h4>
        <div id="ed-valid"></div>
      </div>
      <div id="ed-status"></div>
      <div id="ed-hint"><span data-ed-key="hint1">${et('hint1')}</span><br>
        <span data-ed-key="hint2">${et('hint2')}</span><br>
        <span data-ed-key="hint3">${et('hint3')}</span></div>`;
    document.body.append(root);
    this.root = root;
    this._wire();
    // altura real de la barra → los paneles nunca quedan tapados
    const top = root.querySelector('#ed-top');
    const syncTop = () => root.style.setProperty('--ed-top-h', `${top.offsetHeight + 6}px`);
    new ResizeObserver(syncTop).observe(top);
    syncTop();
  }

  _wire() {
    const ed = this.ed;
    const $ = (id) => document.getElementById(id);
    this.$ = $;

    for (const b of this.root.querySelectorAll('[data-tool]')) {
      b.addEventListener('click', () => ed.setTool(b.dataset.tool));
    }
    $('ed-grid').addEventListener('click', () => { ed.showGrid = !ed.showGrid; ed._refreshGrid(); this.refresh(); });
    const snap = $('ed-snap');
    snap.innerHTML = SNAP_POS.map((v) => `<option value="${v}">${et('snap')} ${v || et('off')}</option>`).join('');
    snap.value = String(ed.snapPos);
    snap.addEventListener('change', () => { ed.snapPos = +snap.value; ed._refreshGrid(); });
    const srot = $('ed-snaprot');
    srot.innerHTML = SNAP_ROT.map((v) => `<option value="${v}">${et('rotation')} ${v || et('free')}${v ? '°' : ''}</option>`).join('');
    srot.value = String(ed.snapRot);
    srot.addEventListener('change', () => { ed.snapRot = +srot.value; });

    $('ed-undo').addEventListener('click', () => ed.undo());
    $('ed-redo').addEventListener('click', () => ed.redo());
    $('ed-dup').addEventListener('click', () => ed.duplicateSelection());
    $('ed-del').addEventListener('click', () => ed.deleteSelection());
    $('ed-mirx').addEventListener('click', () => ed.mirror('x'));
    $('ed-mirz').addEventListener('click', () => ed.mirror('z'));
    $('ed-cover').addEventListener('click', () => { ed.showCover = !ed.showCover; ed._refreshCover(); this.refresh(); });
    $('ed-nav').addEventListener('click', () => { ed.showNav = !ed.showNav; ed._refreshNav(); this.refresh(); });
    $('ed-top-view').addEventListener('click', () => ed.topView());
    $('ed-path').addEventListener('click', () => this._pathTest());
    $('ed-save').addEventListener('click', () => ed.save());
    $('ed-playtest').addEventListener('click', () => this.onPlaytest?.());
    $('ed-exit').addEventListener('click', () => this.onExit?.());
    $('ed-new').addEventListener('click', () => {
      if (ed.dirty && !confirm(et('unsavedNew'))) return;
      ed.newMap(); this.refresh();
    });
    $('ed-saveas').addEventListener('click', () => {
      const name = prompt(et('newMapName'), ed.map.name + ' ' + et('copy'));
      if (name) { ed.saveAs(name); this.refresh(); }
    });
    $('ed-open').addEventListener('click', () => {
      const id = $('ed-maps').value;
      if (!id) return;
      if (ed.dirty && !confirm(et('unsavedOpen'))) return;
      ed.load(id); this.refresh();
    });
    $('ed-delmap').addEventListener('click', () => {
      const sel = $('ed-maps');
      const id = sel.value;
      const name = sel.options[sel.selectedIndex]?.textContent ?? id;
      if (!id) return;
      // borrar un mapa exige confirmación explícita escribiendo el nombre
      const typed = prompt(et('deleteConfirm', { name }));
      if (typed !== name) return ed.setStatus(et('deleteCancelled'));
      ed.remove(id);
      this.refresh();
    });
    $('ed-name').addEventListener('change', (e) => {
      const next = e.target.value.toUpperCase();
      if (next === ed.map.name) return;
      ed.pushUndo('name'); ed.map.name = next; ed.rebuild();
    });
    const theme = $('ed-theme');
    theme.innerHTML = THEMES.map((themeId) => `<option value="${themeId}">${et('theme')}: ${themeName(themeId)}</option>`).join('');
    theme.addEventListener('change', () => { ed.pushUndo('tema'); ed.map.theme = theme.value; ed.rebuild(); });
    for (const f of ['fx', 'fz']) {
      $('ed-' + f).addEventListener('change', (e) => {
        ed.pushUndo('tamaño');
        ed.map[f] = Math.max(8, +e.target.value || ed.map[f]);
        ed.rebuild(); ed.frameCamera();
      });
    }

    // biblioteca por grupos
    const lib = $('ed-lib');
    const groups = [['gameplay', 'gameplay'], ['env', 'environment'], ['marker', 'markers']];
    for (const [g, labelKey] of groups) {
      const h = document.createElement('h4');
      h.dataset.groupKey = labelKey;
      h.textContent = et(labelKey);
      lib.append(h);
      for (const p of PALETTE.filter((x) => x.group === g)) {
        const b = document.createElement('button');
        b.innerHTML = `<span class="piece-icon">${p.icon ?? '◇'}</span><span class="piece-name"></span><span class="piece-meta"></span>`;
        b.dataset.piece = p.id;
        b.addEventListener('click', () => { ed.brush = p.id; this.refresh(); });
        lib.append(b);
      }
    }
  }

  _pathTest() {
    const ed = this.ed;
    if (ed.pathTest) { ed.clearPathTest(); return this.refresh(); }
    const sel = ed.selected();
    let a, b;
    if (sel.length >= 2) { a = { x: sel[0].x, z: sel[0].z }; b = { x: sel[1].x, z: sel[1].z }; }
    else {
      // por defecto: de spawn rojo a spawn azul (la ruta que importa)
      const s = ed.map.objects.filter((o) => o.p === 'spawnRed' || o.p === 'spawnBlue');
      const red = s.find((o) => o.p === 'spawnRed'), blue = s.find((o) => o.p === 'spawnBlue');
      if (!red || !blue) return ed.setStatus(et('selectRoute'));
      a = { x: red.x, z: red.z }; b = { x: blue.x, z: blue.z };
    }
    const r = ed.setPathTest(a, b);
    ed.setStatus(r.route ? et('routeFound', { count: r.route.length }) : et('noRoute'));
    this.refresh();
  }

  show(on) { this.root.classList.toggle('on', on); if (on) this.refresh(); }

  refresh() {
    const ed = this.ed, $ = this.$;
    if (!this.root.classList.contains('on')) return;
    for (const el of this.root.querySelectorAll('[data-ed-key]')) el.textContent = et(el.dataset.edKey);
    for (const el of this.root.querySelectorAll('[data-group-key]')) el.textContent = et(el.dataset.groupKey);
    $('ed-snap').innerHTML = SNAP_POS.map((v) => `<option value="${v}">${et('snap')} ${v || et('off')}</option>`).join('');
    $('ed-snap').value = String(ed.snapPos);
    $('ed-snaprot').innerHTML = SNAP_ROT.map((v) => `<option value="${v}">${et('rotation')} ${v || et('free')}${v ? '°' : ''}</option>`).join('');
    $('ed-snaprot').value = String(ed.snapRot);
    for (const b of this.root.querySelectorAll('[data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === ed.tool);
    }
    for (const b of this.root.querySelectorAll('[data-piece]')) {
      b.classList.toggle('on', b.dataset.piece === ed.brush);
      const piece = paletteById(b.dataset.piece);
      b.querySelector('.piece-name').textContent = pieceName(piece);
      b.querySelector('.piece-meta').textContent = piece?.metaKey ? t(piece.metaKey) : '';
    }
    $('ed-grid').classList.toggle('on', ed.showGrid);
    $('ed-cover').classList.toggle('on', ed.showCover);
    $('ed-nav').classList.toggle('on', ed.showNav);
    $('ed-path').classList.toggle('on', !!ed.pathTest);
    $('ed-name').value = ed.map.name;
    for (const option of $('ed-theme').options) option.textContent = `${et('theme')}: ${themeName(option.value)}`;
    $('ed-theme').value = ed.map.theme;
    $('ed-fx').value = ed.map.fx;
    $('ed-fz').value = ed.map.fz;
    $('ed-status').textContent = ed.status + (ed.dirty ? ` · ${et('unsaved')}` : '');
    $('ed-name').placeholder = et('name');
    $('ed-fx').title = et('halfWidth'); $('ed-fz').title = et('halfLength');

    const maps = ed.maps();
    const sel = $('ed-maps');
    const prev = sel.value;
    sel.innerHTML = maps.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    if (maps.some((m) => m.id === prev)) sel.value = prev;

    this._renderProps();
    this._renderValidation();
  }

  _renderProps() {
    const ed = this.ed, box = this.$('ed-props');
    const sel = ed.selected();
    if (!sel.length) {
      box.innerHTML = `<div style="font-size:11px;color:#8996a0">${et('noSelection')}<br>
        ${et('activePiece')}: <b>${pieceName(paletteById(ed.brush))}</b><br>
        <span style="color:#ffb057">${et('placeHint')}</span></div>`;
      return;
    }
    const o = sel[0];
    const piece = paletteById(o.p);
    const many = sel.length > 1;
    const num = (label, field, step = 0.25) =>
      `<div class="row"><label>${label}</label>
        <input type="number" step="${step}" data-field="${field}" value="${(o[field] ?? 0)}"></div>`;
    let html = `<div style="font-size:11px;margin-bottom:6px">
      <b>${pieceName(piece)}</b>${many ? ` · ×${sel.length}` : ''}
      ${piece?.metaKey ? `<div style="margin-top:3px;color:${piece.group === 'env' ? '#ffb057' : '#91b6cf'}">${t(piece.metaKey)}</div>` : ''}</div>`;
    html += num('X', 'x') + num('Z', 'z');
    if (o.w !== undefined) html += num('W', 'w') + num('D', 'd');
    if (o.h !== undefined && piece?.t === 'box') {
      html += `<div class="row"><label>H</label><select data-field="h">
        <option value="1.1">1.1 ${et('heightLow')}</option><option value="1.9">1.9 ${et('heightMid')}</option>
        <option value="3">3.0 ${et('heightHigh')}</option></select></div>`;
    } else if (o.h !== undefined) html += num('H', 'h');
    html += num('ROT', 'rot', piece?.t === 'box' ? 90 : (ed.snapRot || 15));
    if (piece?.t === 'box') {
      html += `<div style="font-size:10px;color:#6f7a85;margin-top:4px">
        ${et('collisionNote')}</div>`;
    }
    box.innerHTML = html;
    for (const input of box.querySelectorAll('[data-field]')) {
      if (input.dataset.field === 'h' && input.tagName === 'SELECT') input.value = String(o.h);
      input.addEventListener('change', (e) => {
        ed.setField(e.target.dataset.field, +e.target.value);
        this.refresh();
      });
    }
  }

  _renderValidation() {
    const box = this.$('ed-valid');
    const report = this.ed.validate();
    box.innerHTML = report.map((r) => `<div class="${r.level}">${r.i18nKey ? t(r.i18nKey, r.vars) : r.msg}</div>`).join('');
    const playable = !report.some((r) => r.level === 'error');
    box.insertAdjacentHTML('afterbegin',
      `<div style="margin-bottom:6px;color:${playable ? '#7bd88f' : '#ff8080'}">
        <b>${playable ? et('playable') : et('notPlayable')}</b></div>`);
  }
}
