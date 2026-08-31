// UI del editor de mapas: barra superior, biblioteca (izquierda), propiedades
// y validación (derecha). Se construye por JS y vive en su propio overlay,
// así el HTML del juego no carga con paneles que solo existen en el editor.
import { PALETTE, THEMES, SNAP_POS, SNAP_ROT } from './editor.js';
import { paletteById } from '../world/map-data.js';
import { t, onLanguageChange } from '../core/i18n.js';

const et = (key, vars) => t(`editor.${key}`, vars);
const pieceName = (piece) => piece ? t(piece.labelKey ?? '') || piece.label : '—';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const themeName = (themeId) => {
  const translated = t(`map.${themeId}`);
  return translated === `map.${themeId}` ? themeId.toUpperCase() : translated.toUpperCase();
};

const CSS = `
#editor-ui { --ed-left-w:260px; --ed-right-w:310px; --ed-bottom-h:34px;
  position: fixed; inset: 0; pointer-events: none; z-index: 40;
  font-family: var(--mono, monospace); color: #dfe4e8; display: none; }
#editor-ui.on { display: block; }
#editor-ui, #editor-ui * { box-sizing: border-box; }
#editor-ui * { scrollbar-width:thin; scrollbar-color:#42505b #11171c; }
#editor-ui *::-webkit-scrollbar { width:8px; height:8px; }
#editor-ui *::-webkit-scrollbar-track { background:#11171c; }
#editor-ui *::-webkit-scrollbar-thumb { background:#42505b; border:2px solid #11171c; }
#editor-ui .panel { position: absolute; pointer-events: auto;
  background:linear-gradient(180deg,rgba(14,19,24,.98),rgba(8,12,16,.96));
  border:1px solid #303a44; box-shadow:0 12px 30px rgba(0,0,0,.25); backdrop-filter:blur(9px); }
#ed-top { top:0; left:0; right:0; min-height:52px; display:flex; gap:7px 10px; align-items:center;
  padding:7px 10px; flex-wrap:wrap; overflow-x:hidden; border-bottom:2px solid #6e91aa !important; }
.ed-brand { min-width:145px; padding-right:10px; border-right:1px solid #34414c; }
.ed-brand strong { display:block; font-size:13px; letter-spacing:.16em; color:#f5f7f8; }
.ed-brand small { display:block; margin-top:3px; color:#7e8d99; font-size:8px; letter-spacing:.1em; }
.ed-tools { display:flex; align-items:center; gap:4px; padding-right:10px; border-right:1px solid #2d3740; white-space:nowrap; }
.ed-tools:last-child { border-right:0; margin-left:auto; }
.ed-tool-label { color:#71808c; font-size:8px; letter-spacing:.13em; margin-right:3px; }
#editor-ui button { background: #1a2027; color: #cfd6dc; border: 1px solid #323b45;
  min-height: 29px; padding: 5px 9px; font: inherit; font-size: 11px; letter-spacing: .05em; cursor: pointer; }
#editor-ui button:hover { background: #26313a; border-color: #566572; }
#editor-ui button:focus-visible { outline: 2px solid #ffd199; outline-offset: 1px; }
#editor-ui button:disabled { opacity:.35; cursor:not-allowed; filter:saturate(.3); }
#editor-ui button.on { background: #ffad58; color: #14181c; border-color: #ffc27f;
  box-shadow: inset 0 -2px 0 rgba(126,53,0,.28), 0 0 0 1px rgba(255,176,87,.18); }
#ed-playtest { background: #d86e2d !important; color: #fff5e9 !important; border-color: #ff9c57 !important; }
#editor-ui button.danger:hover { background: #7a2f2f; border-color: #b45a5a; }
#editor-ui select, #editor-ui input { background: #12171c; color: #cfd6dc;
  border: 1px solid #36424c; font: inherit; font-size: 11px; min-height: 29px; padding: 4px 6px; }
#editor-ui input:focus, #editor-ui select:focus { outline:1px solid #ffad58; border-color:#ffad58; }
#editor-ui select:disabled, #editor-ui input:disabled { opacity: .45; cursor: not-allowed; }
#ed-left { left:0; top:var(--ed-top-h,58px); bottom:var(--ed-bottom-h); width:var(--ed-left-w);
  overflow-y:auto; overflow-x:hidden; padding:11px; }
#ed-right { right:0; top:var(--ed-top-h,58px); bottom:var(--ed-bottom-h); width:var(--ed-right-w);
  overflow-y:auto; overflow-x:hidden; padding:11px; }
#editor-ui h4 { margin: 12px 0 6px; font-size: 10px; letter-spacing: .16em;
  color: #7d8894; font-weight: 600; }
#editor-ui h4:first-child { margin-top: 0; }
#ed-search { width:100%; padding-left:28px !important; }
.ed-search-wrap { position:relative; margin-bottom:7px; }
.ed-search-wrap::before { content:'⌕'; position:absolute; left:9px; top:5px; color:#82909c; z-index:1; }
#ed-categories { display:flex; flex-wrap:wrap; gap:4px; padding-bottom:6px; }
#ed-categories button { min-height:25px; padding:3px 7px; font-size:8px; }
#ed-left .lib { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
#ed-left .lib button { display:grid; grid-template-columns:28px 1fr; align-items:center;
  text-align:left; padding:6px; min-height:49px; min-width:0; width:100%; }
.piece-icon { grid-row:1 / span 2; display:grid; place-items:center; width:24px; height:24px;
  border:1px solid #46525e; background:#10151a; color:#ffb057; font-size:15px; }
.piece-name { color:#e4e9ed; font-size:9.5px; line-height:1.15; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.piece-meta { color:#73808b; font-size:7px; line-height:1.2; letter-spacing:.04em; margin-top:2px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#ed-left .lib button.on .piece-icon { background:#161b20; border-color:#8a4a18; color:#ff7e3c; }
#ed-left .lib button.on .piece-name { color:#14181c; }
#ed-left .lib button.on .piece-meta { color:#5b3a21; }
.ed-insert-row { display:grid; grid-template-columns:1fr auto; gap:5px; margin:7px 0 10px; }
#ed-insert { background:#263948 !important; border-color:#527087 !important; }
.ed-section { border-top:1px solid #27323b; padding-top:9px; margin-top:11px; }
.ed-collapsible summary { cursor:pointer; color:#8e9aa4; font-size:9px; letter-spacing:.12em; margin-bottom:7px; }
.field-label { display:block; color:#7d8994; font-size:9px; letter-spacing:.12em; margin:7px 0 4px; }
#ed-props .row { display: grid; grid-template-columns: 22px 1fr; gap: 6px;
  align-items: center; margin-bottom: 5px; }
#ed-props .row label { font-size: 10px; color: #7d8894; }
#ed-selection-summary { display:flex; justify-content:space-between; align-items:center; padding:8px;
  background:#10161b; border:1px solid #2f3a43; margin-bottom:8px; font-size:10px; }
.valid-group { margin-bottom:8px; border:1px solid #29343d; background:#10151a; }
.valid-head { display:flex; justify-content:space-between; padding:6px 7px; font-size:9px; letter-spacing:.1em; }
.valid-item { display:block; width:100%; text-align:left; border:0 !important; border-top:1px solid #222c34 !important;
  background:transparent !important; min-height:27px !important; padding:5px 7px !important; font-size:9px !important; }
.valid-item.ok { color:#7bd88f; }.valid-item.warn { color:#ffd166; }.valid-item.error { color:#ff8585; }
.valid-item[data-focusable="true"]::after { content:' ↗'; color:#8396a4; }
.ed-resize { position:absolute; top:var(--ed-top-h,58px); bottom:var(--ed-bottom-h); width:7px;
  pointer-events:auto; cursor:ew-resize; z-index:3; }
#ed-resize-left { left:calc(var(--ed-left-w) - 3px); }
#ed-resize-right { right:calc(var(--ed-right-w) - 3px); }
#ed-bottom { position:absolute; left:0; right:0; bottom:0; height:var(--ed-bottom-h); pointer-events:auto;
  background:rgba(8,12,16,.96); border-top:1px solid #33414c; display:flex; align-items:center;
  gap:14px; padding:0 10px; font-size:9px; color:#9daab4; }
#ed-status { color:#d2d9de; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#ed-map-state.dirty { color:#ffb057; }
#ed-hint { color:#7e8c97; white-space:nowrap; }
#ed-recovery { position:absolute; top:calc(var(--ed-top-h,58px) + 12px); left:50%; transform:translateX(-50%);
  pointer-events:auto; z-index:5; width:min(560px,calc(100vw - 40px)); padding:11px 13px; display:none;
  background:#241d14; border:1px solid #c18444; box-shadow:0 12px 32px #000a; }
#ed-recovery.on { display:flex; gap:10px; align-items:center; }
#ed-recovery .copy { flex:1; font-size:10px; line-height:1.4; }
.ed-modal { position:absolute; inset:0; display:none; place-items:center; pointer-events:auto; background:#05080bb8; z-index:10; }
.ed-modal.on { display:grid; }
.ed-dialog { width:min(720px,calc(100vw - 30px)); max-height:80vh; overflow:auto; padding:18px;
  background:#10161b; border:1px solid #566a79; box-shadow:0 24px 70px #000d; }
.shortcut-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px 18px; margin:12px 0; }
.shortcut-grid div { display:flex; justify-content:space-between; gap:10px; border-bottom:1px solid #26313a; padding:5px 0; font-size:10px; }
kbd { color:#ffbc78; background:#1e252b; border:1px solid #45515b; padding:2px 5px; }
.ed-panel-toggle { display:none; }
@media (max-width:1180px) { #editor-ui { --ed-left-w:225px; --ed-right-w:270px; }
  .ed-brand { min-width:112px; }.ed-tool-label { display:none; }.piece-meta { display:none; }
  .ed-tools:last-child { margin-left:0; } }
@media (max-width:820px) {
  #editor-ui { --ed-left-w:min(82vw,300px); --ed-right-w:min(82vw,310px); }
  #ed-left, #ed-right { transition:transform .18s ease; z-index:4; }
  #editor-ui.left-closed #ed-left { transform:translateX(-105%); }
  #editor-ui.right-closed #ed-right { transform:translateX(105%); }
  .ed-resize { display:none; }.ed-panel-toggle { display:inline-block; }
  #ed-hint { display:none; }.ed-brand small { display:none; }
}
`;

export class EditorUI {
  constructor(editor, { onPlaytest, onExit }) {
    this.ed = editor;
    this.onPlaytest = onPlaytest;
    this.onExit = onExit;
    this.category = 'all';
    this.search = '';
    this._uiState = this._loadUIState();
    this.category = this._uiState.category || 'all';
    this._build();
    editor.onChange = () => this.refresh();
    this._offLanguage = onLanguageChange(() => this.refresh());
  }

  _loadUIState() {
    try { return JSON.parse(localStorage.getItem('breach.editor.ui.v1') || '{}'); }
    catch { return {}; }
  }

  _saveUIState() {
    try { localStorage.setItem('breach.editor.ui.v1', JSON.stringify(this._uiState)); }
    catch { /* preferencias opcionales */ }
  }

  _build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    const root = document.createElement('div');
    root.id = 'editor-ui';
    root.innerHTML = `
      <div class="panel" id="ed-top">
        <div class="ed-brand"><strong>BREACH</strong><small data-ed-key="offlineEditor">${et('offlineEditor')}</small></div>
        <div class="ed-tools"><span class="ed-tool-label" data-ed-key="file">${et('file')}</span>
          <button id="ed-new" data-ed-key="new">${et('new')}</button>
          <button id="ed-save" data-ed-key="save">${et('save')}</button>
          <button id="ed-saveas" data-ed-key="saveAs">${et('saveAs')}</button>
          <button id="ed-export" data-ed-key="export">${et('export')}</button>
          <button id="ed-import" data-ed-key="import">${et('import')}</button>
          <input type="file" id="ed-import-file" accept=".json,application/json" hidden>
        </div>
        <div class="ed-tools"><span class="ed-tool-label" data-ed-key="tools">${et('tools')}</span>
          <button data-tool="select" data-ed-key="select">${et('select')}</button>
          <button data-tool="move" data-ed-key="move">${et('move')}</button>
          <button data-tool="rotate" data-ed-key="rotate">${et('rotate')}</button>
          <button data-tool="scale" data-ed-key="scale">${et('scale')}</button>
          <button id="ed-focus" data-ed-key="focus">${et('focus')}</button>
        </div>
        <div class="ed-tools"><span class="ed-tool-label" data-ed-key="history">${et('history')}</span>
          <button id="ed-undo" data-ed-key="undo">${et('undo')}</button>
          <button id="ed-redo" data-ed-key="redo">${et('redo')}</button>
          <button id="ed-dup" data-ed-key="duplicate">${et('duplicate')}</button>
          <button id="ed-del" data-ed-key="delete">${et('delete')}</button>
        </div>
        <div class="ed-tools"><span class="ed-tool-label" data-ed-key="view">${et('view')}</span>
          <button id="ed-grid" data-ed-key="grid">${et('grid')}</button>
          <button id="ed-cover" data-ed-key="cover">${et('cover')}</button>
          <button id="ed-nav" data-ed-key="nav">${et('nav')}</button>
          <button id="ed-charref" data-ed-key="charRefs">${et('charRefs')}</button>
          <button id="ed-top-view" data-ed-key="topView">${et('topView')}</button>
        </div>
        <div class="ed-tools">
          <button class="ed-panel-toggle" id="ed-toggle-left">☰</button>
          <button class="ed-panel-toggle" id="ed-toggle-right">☷</button>
          <button id="ed-help">?</button>
          <button id="ed-validate" data-ed-key="validate">${et('validate')}</button>
          <button id="ed-playtest" data-ed-key="playtest">${et('playtest')}</button>
          <button id="ed-exit" data-ed-key="exit">${et('exit')}</button>
        </div>
      </div>
      <div class="panel" id="ed-left">
        <h4 data-ed-key="library">${et('library')}</h4>
        <div class="ed-search-wrap"><input id="ed-search" type="search" autocomplete="off"></div>
        <div id="ed-categories"></div>
        <div class="ed-insert-row"><button id="ed-insert" data-ed-key="insert">${et('insert')}</button>
          <span id="ed-lib-count" style="align-self:center;color:#75838e;font-size:8px"></span></div>
        <div class="lib" id="ed-lib"></div>
        <details class="ed-collapsible ed-section" open>
          <summary data-ed-key="savedMaps">${et('savedMaps')}</summary>
          <select id="ed-maps" style="width:100%"></select>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:5px">
            <button id="ed-open" data-ed-key="open">${et('open')}</button>
            <button id="ed-delmap" data-ed-key="delete" class="danger">${et('delete')}</button>
          </div>
        </details>
        <details class="ed-collapsible ed-section">
          <summary data-ed-key="cloneMap">${et('cloneMap')}</summary>
          <select id="ed-clone-src" style="width:100%"></select>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:5px">
            <button id="ed-clone" data-ed-key="clone">${et('clone')}</button>
            <button id="ed-decor" data-ed-key="decor">${et('decor')}</button>
          </div>
          <div id="ed-base-note" style="font-size:9px;color:#73808b;margin-top:6px;display:none"></div>
        </details>
      </div>
      <div class="panel" id="ed-right">
        <h4 data-ed-key="selection">${et('selection')}</h4>
        <div id="ed-selection-summary"><span id="ed-selection-name">—</span><span id="ed-selection-count">0</span></div>
        <h4 data-ed-key="properties">${et('properties')}</h4>
        <div id="ed-props"></div>
        <details class="ed-collapsible ed-section" open>
          <summary data-ed-key="mapSettings">${et('mapSettings')}</summary>
          <label class="field-label" data-ed-key="name">${et('name')}</label>
          <input id="ed-name" style="width:100%">
          <select id="ed-theme" style="width:100%;margin-top:5px"></select>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px">
            <label class="field-label" data-ed-key="halfWidth">${et('halfWidth')}</label>
            <label class="field-label" data-ed-key="halfLength">${et('halfLength')}</label>
            <input id="ed-fx" type="number" step="0.5"><input id="ed-fz" type="number" step="0.5">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:7px">
            <button id="ed-mirx" data-ed-key="mirrorX">${et('mirrorX')}</button>
            <button id="ed-mirz" data-ed-key="mirrorZ">${et('mirrorZ')}</button>
          </div>
        </details>
        <details class="ed-collapsible ed-section" open>
          <summary data-ed-key="placement">${et('placement')}</summary>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">
            <select id="ed-snap"></select><select id="ed-snaprot"></select>
          </div>
          <button id="ed-path" data-ed-key="route" style="width:100%;margin-top:5px">${et('route')}</button>
        </details>
        <h4 data-ed-key="validation">${et('validation')}</h4>
        <div id="ed-valid"></div>
      </div>
      <div class="ed-resize" id="ed-resize-left"></div><div class="ed-resize" id="ed-resize-right"></div>
      <div id="ed-bottom"><span id="ed-map-state"></span><span id="ed-tool-state"></span>
        <span id="ed-selection-state"></span><span id="ed-status"></span>
        <span id="ed-hint">WASD · Q/W/E/R · F · Ctrl+S · ?</span></div>
      <div id="ed-recovery"><div class="copy" id="ed-recovery-copy"></div>
        <button id="ed-restore" data-ed-key="restore">${et('restore')}</button>
        <button id="ed-discard-recovery" data-ed-key="discard">${et('discard')}</button></div>
      <div class="ed-modal" id="ed-help-modal"><div class="ed-dialog">
        <h3 style="margin-top:0" data-ed-key="helpTitle">${et('helpTitle')}</h3>
        <div data-ed-key="helpIntro" style="font-size:11px;color:#aab5bd">${et('helpIntro')}</div>
        <div class="shortcut-grid" id="ed-shortcuts"></div>
        <button id="ed-help-close" data-ed-key="close">${et('close')}</button>
      </div></div>`;
    document.body.append(root);
    this.root = root;
    if (this._uiState.leftWidth) root.style.setProperty('--ed-left-w', `${this._uiState.leftWidth}px`);
    if (this._uiState.rightWidth) root.style.setProperty('--ed-right-w', `${this._uiState.rightWidth}px`);
    root.classList.toggle('left-closed', !!this._uiState.leftClosed);
    root.classList.toggle('right-closed', !!this._uiState.rightClosed);
    this._manualPanelChoice = false;
    this._syncResponsive = () => {
      if (innerWidth <= 820 && !this._manualPanelChoice) root.classList.add('right-closed');
      else if (innerWidth > 820 && !this._uiState.rightClosed) root.classList.remove('right-closed');
    };
    window.addEventListener('resize', this._syncResponsive);
    this._syncResponsive();
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
    ed.onSaveAsRequest = () => this._saveAs();
    ed.onDeleteRequest = () => this._deleteSelection();

    for (const b of this.root.querySelectorAll('[data-tool]')) {
      b.addEventListener('click', () => ed.setTool(b.dataset.tool));
    }
    $('ed-focus').addEventListener('click', () => ed.focusSelection());
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
    $('ed-del').addEventListener('click', () => this._deleteSelection());
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
    $('ed-saveas').addEventListener('click', () => this._saveAs());
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

    // clonar mapas reales del juego (los 6 layouts, incluidos los no públicos)
    const cloneSrc = $('ed-clone-src');
    cloneSrc.innerHTML = THEMES.map((id) => `<option value="${id}">${themeName(id)}</option>`).join('');
    $('ed-clone').addEventListener('click', () => {
      if (ed.dirty && !confirm(et('unsavedOpen'))) return;
      const original = themeName(cloneSrc.value);
      const name = prompt(et('cloneNamePrompt', { name: original }), `${original} ${et('copy')}`);
      if (!name) return;
      ed.cloneLayout(cloneSrc.value, name);
      this.refresh();
    });
    $('ed-decor').addEventListener('click', () => {
      ed.setDecor(ed.map.decor === false);
      this.refresh();
    });
    $('ed-charref').addEventListener('click', () => { ed.toggleCharRefs(); this.refresh(); });
    $('ed-insert').addEventListener('click', () => ed.insertBrushAtView());
    $('ed-validate').addEventListener('click', () => {
      this._renderValidation();
      $('ed-right').scrollTo({ top: $('ed-valid').offsetTop - 12, behavior: 'smooth' });
      ed.setStatus(et('status.validationComplete'));
    });

    // export/import a fichero: el JSON ES el formato del juego
    $('ed-export').addEventListener('click', () => {
      const out = ed.exportFile();
      const errors = out.report.filter((r) => r.level === 'error').length;
      const warnings = out.report.filter((r) => r.level === 'warn').length;
      if (errors) {
        ed.setStatus(et('status.exportBlocked', { count: errors }));
        this._renderValidation();
        $('ed-right').scrollTop = $('ed-valid').offsetTop;
        return;
      }
      if (warnings && !confirm(et('exportWarnings', { count: warnings }))) return;
      const blob = new Blob([out.json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = out.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ed.setStatus(et('status.exported', { filename: out.filename }));
    });
    $('ed-import').addEventListener('click', () => $('ed-import-file').click());
    $('ed-import-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (ed.dirty && !confirm(et('unsavedOpen'))) return;
      ed.importFile(await file.text());
      this.refresh();
    });

    $('ed-search').addEventListener('input', (e) => {
      this.search = e.target.value.trim().toLocaleLowerCase();
      this._renderLibrary();
    });
    const categories = [
      ['all', 'all'], ['gameplay', 'gameplay'], ['env', 'environment'],
      ['assets', 'assets'], ['editor', 'reference'], ['marker', 'markers'],
    ];
    for (const [id, key] of categories) {
      const button = document.createElement('button');
      button.dataset.category = id;
      button.dataset.categoryKey = key;
      button.textContent = et(key);
      button.addEventListener('click', () => {
        this.category = id;
        this._uiState.category = id;
        this._saveUIState();
        this._renderLibrary();
      });
      $('ed-categories').append(button);
    }

    $('ed-help').addEventListener('click', () => this._showHelp(true));
    $('ed-help-close').addEventListener('click', () => this._showHelp(false));
    $('ed-help-modal').addEventListener('click', (e) => {
      if (e.target === $('ed-help-modal')) this._showHelp(false);
    });
    $('ed-toggle-left').addEventListener('click', () => this._togglePanel('left'));
    $('ed-toggle-right').addEventListener('click', () => this._togglePanel('right'));
    this._wireResize($('ed-resize-left'), 'left');
    this._wireResize($('ed-resize-right'), 'right');

    $('ed-restore').addEventListener('click', () => {
      if (ed.dirty && !confirm(et('unsavedOpen'))) return;
      if (ed.restoreRecovery()) {
        $('ed-recovery').classList.remove('on');
        this.refresh();
      }
    });
    $('ed-discard-recovery').addEventListener('click', () => {
      ed.clearRecovery();
      $('ed-recovery').classList.remove('on');
    });

    this._setTooltips();
    this._renderLibrary();
  }

  _saveAs() {
    const name = prompt(et('newMapName'), this.ed.map.name + ' ' + et('copy'));
    if (name?.trim()) { this.ed.saveAs(name.trim()); this.refresh(); }
  }

  _deleteSelection() {
    const count = this.ed.selection.size;
    if (!count) return;
    if (!confirm(et('deleteObjectsConfirm', { count }))) return;
    this.ed.deleteSelection();
  }

  _renderLibrary() {
    const lib = this.$?.('ed-lib');
    if (!lib) return;
    const matches = PALETTE.filter((piece) => {
      const inCategory = this.category === 'assets'
        ? piece.group === 'assets' || piece.group === 'internal'
        : piece.group === this.category;
      if (this.category !== 'all' && !inCategory) return false;
      const haystack = [piece.id, pieceName(piece), piece.metaKey ? t(piece.metaKey) : '']
        .join(' ').toLocaleLowerCase();
      return !this.search || haystack.includes(this.search);
    });
    lib.replaceChildren();
    for (const piece of matches) {
      const button = document.createElement('button');
      button.dataset.piece = piece.id;
      button.title = et('assetTooltip', { name: pieceName(piece) });
      button.setAttribute('aria-label', pieceName(piece));
      button.innerHTML = `<span class="piece-icon">${esc(piece.icon ?? '◇')}</span>` +
        `<span class="piece-name">${esc(pieceName(piece))}</span>` +
        `<span class="piece-meta">${esc(piece.metaKey ? t(piece.metaKey) : '')}</span>`;
      button.addEventListener('click', () => {
        this.ed.brush = piece.id;
        this._renderLibrary();
        this.refresh();
      });
      button.addEventListener('dblclick', () => this.ed.insertBrushAtView());
      button.classList.toggle('on', piece.id === this.ed.brush);
      lib.append(button);
    }
    for (const button of this.$('ed-categories').querySelectorAll('[data-category]')) {
      button.classList.toggle('on', button.dataset.category === this.category);
      button.textContent = et(button.dataset.categoryKey);
    }
    this.$('ed-lib-count').textContent = et('assetCount', { count: matches.length });
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'grid-column:1/-1;color:#7f8b94;font-size:10px;padding:14px 4px';
      empty.textContent = et('noAssets');
      lib.append(empty);
    }
  }

  _showHelp(on) {
    const modal = this.$('ed-help-modal');
    modal.classList.toggle('on', on);
    if (!on) return;
    const shortcuts = [
      ['Q / W / E / R', et('shortcutTools')], ['Ctrl+S', et('shortcutSave')],
      ['Ctrl+Shift+S', et('shortcutSaveAs')], ['Ctrl+Z / Ctrl+Y', et('shortcutHistory')],
      ['Ctrl+D', et('shortcutDuplicate')], ['Delete', et('shortcutDelete')],
      ['F', et('shortcutFocus')], ['Escape', et('shortcutEscape')],
      ['Alt+Click', et('shortcutPlace')], ['Shift+Click', et('shortcutMulti')],
      ['Arrows', et('shortcutNudge')], ['WASD / Space / C', et('shortcutCamera')],
    ];
    this.$('ed-shortcuts').innerHTML = shortcuts.map(([key, label]) =>
      `<div><span>${esc(label)}</span><kbd>${esc(key)}</kbd></div>`).join('');
    this.$('ed-help-close').focus();
  }

  _togglePanel(side) {
    this._manualPanelChoice = true;
    const key = `${side}Closed`;
    this._uiState[key] = !this.root.classList.contains(`${side}-closed`);
    this.root.classList.toggle(`${side}-closed`, this._uiState[key]);
    this._saveUIState();
  }

  _wireResize(handle, side) {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const move = (e) => {
        const raw = side === 'left' ? e.clientX : innerWidth - e.clientX;
        const width = Math.max(205, Math.min(430, raw));
        this.root.style.setProperty(`--ed-${side}-w`, `${width}px`);
        this._uiState[`${side}Width`] = width;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this._saveUIState();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    });
  }

  _setTooltips() {
    const tips = {
      'ed-new': 'tipNew', 'ed-save': 'tipSave', 'ed-saveas': 'tipSaveAs',
      'ed-export': 'tipExport', 'ed-import': 'tipImport', 'ed-focus': 'tipFocus',
      'ed-undo': 'tipUndo', 'ed-redo': 'tipRedo', 'ed-dup': 'tipDuplicate',
      'ed-del': 'tipDelete', 'ed-grid': 'tipGrid', 'ed-cover': 'tipCover',
      'ed-nav': 'tipNav', 'ed-charref': 'tipCharRef', 'ed-top-view': 'tipTop',
      'ed-validate': 'tipValidate', 'ed-playtest': 'tipPlaytest', 'ed-exit': 'tipExit',
      'ed-insert': 'tipInsert', 'ed-path': 'tipRoute', 'ed-help': 'tipHelp',
    };
    for (const [id, key] of Object.entries(tips)) {
      const el = this.$(id);
      if (el) { el.title = et(key); el.setAttribute('aria-label', et(key)); }
    }
    const toolKeys = { select: 'tipSelect', move: 'tipMove', rotate: 'tipRotate', scale: 'tipScale' };
    for (const button of this.root.querySelectorAll('[data-tool]')) {
      button.title = et(toolKeys[button.dataset.tool]);
    }
    this.$('ed-search').placeholder = et('searchAssets');
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
    this._setTooltips();
    $('ed-snap').innerHTML = SNAP_POS.map((v) => `<option value="${v}">${et('snap')} ${v || et('off')}</option>`).join('');
    $('ed-snap').value = String(ed.snapPos);
    $('ed-snaprot').innerHTML = SNAP_ROT.map((v) => `<option value="${v}">${et('rotation')} ${v || et('free')}${v ? '°' : ''}</option>`).join('');
    $('ed-snaprot').value = String(ed.snapRot);
    for (const b of this.root.querySelectorAll('[data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === ed.tool);
    }
    this._renderLibrary();
    $('ed-grid').classList.toggle('on', ed.showGrid);
    $('ed-cover').classList.toggle('on', ed.showCover);
    $('ed-nav').classList.toggle('on', ed.showNav);
    $('ed-path').classList.toggle('on', !!ed.pathTest);
    $('ed-charref').classList.toggle('on', ed.showCharRefs);
    $('ed-name').value = ed.map.name;
    for (const option of $('ed-theme').options) option.textContent = `${et('theme')}: ${themeName(option.value)}`;
    for (const option of $('ed-clone-src').options) option.textContent = themeName(option.value);
    $('ed-theme').value = ed.map.theme;
    $('ed-fx').value = ed.map.fx;
    $('ed-fz').value = ed.map.fz;
    // clon de un mapa real: tamaño y tema van atados al mapa base; DECOR
    // enciende/apaga la decoración del builder original
    const base = ed.map.base;
    $('ed-fx').disabled = !!base;
    $('ed-fz').disabled = !!base;
    $('ed-theme').disabled = !!base;
    $('ed-decor').style.display = base ? '' : 'none';
    $('ed-decor').classList.toggle('on', !!base && ed.map.decor !== false);
    const note = $('ed-base-note');
    note.style.display = base ? '' : 'none';
    if (base) note.textContent = et('baseLocked', { base: themeName(base) });
    const selected = ed.selected();
    $('ed-selection-name').textContent = selected.length ? pieceName(paletteById(selected[0].p)) : et('noSelectionShort');
    $('ed-selection-count').textContent = selected.length ? `×${selected.length}` : '0';
    $('ed-map-state').textContent = `${ed.map.name} ${ed.dirty ? '●' : '✓'}`;
    $('ed-map-state').classList.toggle('dirty', ed.dirty);
    $('ed-tool-state').textContent = `${et('tool')}: ${et(ed.tool)}`;
    $('ed-selection-state').textContent = `${et('selection')}: ${selected.length}`;
    $('ed-status').textContent = ed.status || (ed.dirty ? et('unsaved') : et('ready'));
    $('ed-name').placeholder = et('name');
    $('ed-fx').title = et('halfWidth'); $('ed-fz').title = et('halfLength');

    const maps = ed.maps();
    const sel = $('ed-maps');
    const prev = sel.value;
    sel.innerHTML = maps.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    if (maps.some((m) => m.id === prev)) sel.value = prev;

    $('ed-undo').disabled = !ed.undoStack.length;
    $('ed-redo').disabled = !ed.redoStack.length;
    $('ed-dup').disabled = !selected.length;
    $('ed-del').disabled = !selected.length;
    $('ed-focus').disabled = !selected.length;
    $('ed-mirx').disabled = !ed.map.objects.length;
    $('ed-mirz').disabled = !ed.map.objects.length;
    $('ed-open').disabled = !maps.length;
    $('ed-delmap').disabled = !maps.length;

    const recovery = ed.recovery();
    const showRecovery = !!recovery && recovery.map?.id !== ed.map.id;
    $('ed-recovery').classList.toggle('on', showRecovery);
    if (showRecovery) {
      const when = new Date(recovery.savedAt).toLocaleString();
      $('ed-recovery-copy').textContent = et('recoveryFound', { name: recovery.map.name, time: when });
    }

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
      ${piece?.metaKey ? `<div style="margin-top:3px;color:${piece.group === 'env' ? '#ffb057' : '#91b6cf'}">${t(piece.metaKey)}</div>` : ''}
      <div style="margin-top:4px;color:#687783;font-size:8px">${et('type')}: ${esc(piece?.t ?? 'unknown')} · ${et('material')}: ${esc(o.surface ?? 'default')}</div></div>`;
    html += num('X', 'x') + num('Z', 'z');
    if (o.w !== undefined) html += num('W', 'w') + num('D', 'd');
    if (o.h !== undefined && piece?.t === 'box') {
      html += `<div class="row"><label>H</label><select data-field="h">
        <option value="1.1">1.1 ${et('heightLow')}</option><option value="1.9">1.9 ${et('heightMid')}</option>
        <option value="3">3.0 ${et('heightHigh')}</option></select></div>`;
    } else if (o.h !== undefined) html += num('H', 'h');
    if (['urban', 'street', 'baseDecor'].includes(piece?.t)) html += num('ESC', 'scale', 0.1) + num('Y', 'y');
    if (piece?.t === 'special') html += num('Y', 'y');
    html += num('ROT', 'rot', piece?.t === 'box' ? 90 : (ed.snapRot || 15));
    if (piece?.t === 'box') {
      html += `<div style="font-size:10px;color:#6f7a85;margin-top:4px">
        ${et('collisionNote')}</div>`;
    }
    box.innerHTML = html;
    for (const input of box.querySelectorAll('[data-field]')) {
      if (input.dataset.field === 'h' && input.tagName === 'SELECT') input.value = String(o.h);
      let recorded = false;
      const apply = (e) => {
        const value = +e.target.value;
        if (!Number.isFinite(value)) return;
        if (!recorded) { ed.pushUndo('propiedad'); recorded = true; }
        ed.setField(e.target.dataset.field, value, { record: false });
      };
      if (input.tagName === 'SELECT') input.addEventListener('change', (e) => { apply(e); this.refresh(); });
      else {
        input.addEventListener('input', apply);
        input.addEventListener('change', () => this.refresh());
        input.addEventListener('blur', () => { recorded = false; });
      }
    }
  }

  _renderValidation() {
    const box = this.$('ed-valid');
    const report = this.ed.validate();
    const playable = !report.some((r) => r.level === 'error');
    box.replaceChildren();
    const headline = document.createElement('div');
    headline.style.cssText = `margin-bottom:8px;padding:7px;color:${playable ? '#7bd88f' : '#ff8080'};background:#10151a;border:1px solid #2b3740`;
    headline.innerHTML = `<b>${playable ? et('playable') : et('notPlayable')}</b>`;
    box.append(headline);
    const labels = { error: et('errors'), warn: et('warnings'), ok: et('passed') };
    for (const level of ['error', 'warn', 'ok']) {
      const items = report.filter((r) => r.level === level);
      if (!items.length) continue;
      const group = document.createElement('div');
      group.className = 'valid-group';
      group.innerHTML = `<div class="valid-head"><span>${esc(labels[level])}</span><b>${items.length}</b></div>`;
      for (const issue of items) {
        const button = document.createElement('button');
        button.className = `valid-item ${level}`;
        button.dataset.focusable = String(!!issue.objectIds?.length);
        button.textContent = issue.i18nKey ? t(issue.i18nKey, issue.vars) : issue.msg;
        if (issue.objectIds?.length) {
          button.title = et('focusIssue');
          button.addEventListener('click', () => this.ed.selectObjects(issue.objectIds, { focus: true }));
        } else button.disabled = true;
        group.append(button);
      }
      box.append(group);
    }
  }
}
