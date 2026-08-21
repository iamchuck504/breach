// UI del editor de mapas: barra superior, biblioteca (izquierda), propiedades
// y validación (derecha). Se construye por JS y vive en su propio overlay,
// así el HTML del juego no carga con paneles que solo existen en el editor.
import { PALETTE, THEMES, SNAP_POS, SNAP_ROT } from './editor.js';
import { paletteById } from '../world/map-data.js';

const CSS = `
#editor-ui { position: fixed; inset: 0; pointer-events: none; z-index: 40;
  font-family: var(--mono, monospace); color: #dfe4e8; display: none; }
#editor-ui.on { display: block; }
#editor-ui .panel { position: absolute; pointer-events: auto;
  background: rgba(12, 16, 20, .93); border: 1px solid #2b333c; }
#ed-top { top: 0; left: 0; right: 0; display: flex; gap: 6px; align-items: center;
  padding: 7px 10px; flex-wrap: wrap; }
#ed-top .sep { width: 1px; height: 20px; background: #2b333c; margin: 0 4px; }
#editor-ui button { background: #1a2027; color: #cfd6dc; border: 1px solid #323b45;
  padding: 5px 9px; font: inherit; font-size: 11px; letter-spacing: .05em; cursor: pointer; }
#editor-ui button:hover { background: #232b34; }
#editor-ui button.on { background: #ffb057; color: #14181c; border-color: #ffb057; }
#editor-ui button.danger:hover { background: #7a2f2f; border-color: #b45a5a; }
#editor-ui select, #editor-ui input { background: #12171c; color: #cfd6dc;
  border: 1px solid #323b45; font: inherit; font-size: 11px; padding: 4px 6px; }
/* la barra superior puede envolver en pantallas estrechas: los paneles
   arrancan bajo su altura REAL, medida en runtime (--ed-top-h) */
#ed-left { left: 0; top: var(--ed-top-h, 46px); bottom: 0; width: 186px;
  overflow-y: auto; padding: 10px; }
#ed-right { right: 0; top: var(--ed-top-h, 46px); width: 232px;
  max-height: calc(100vh - var(--ed-top-h, 46px) - 10px); overflow-y: auto; padding: 10px; }
#editor-ui h4 { margin: 12px 0 6px; font-size: 10px; letter-spacing: .16em;
  color: #7d8894; font-weight: 600; }
#editor-ui h4:first-child { margin-top: 0; }
#ed-left .lib { display: grid; grid-template-columns: 1fr; gap: 4px; }
#ed-left .lib button { text-align: left; }
#ed-props .row { display: grid; grid-template-columns: 22px 1fr; gap: 6px;
  align-items: center; margin-bottom: 5px; }
#ed-props .row label { font-size: 10px; color: #7d8894; }
#ed-valid div { font-size: 11px; margin-bottom: 4px; line-height: 1.35; }
#ed-valid .ok::before { content: "✅ "; }
#ed-valid .warn::before { content: "⚠ "; }
#ed-valid .error::before { content: "❌ "; }
#ed-valid .warn { color: #ffd166; }
#ed-valid .error { color: #ff8080; }
#ed-status { position: absolute; left: 196px; bottom: 10px; pointer-events: none;
  font-size: 11px; color: #9aa4ae; text-shadow: 0 1px 2px #000; }
#ed-hint { position: absolute; right: 244px; bottom: 10px; pointer-events: none;
  font-size: 10px; color: #6f7a85; text-align: right; line-height: 1.5; }
`;

export class EditorUI {
  constructor(editor, { onPlaytest, onExit }) {
    this.ed = editor;
    this.onPlaytest = onPlaytest;
    this.onExit = onExit;
    this._build();
    editor.onChange = () => this.refresh();
  }

  _build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    const root = document.createElement('div');
    root.id = 'editor-ui';
    root.innerHTML = `
      <div class="panel" id="ed-top">
        <button data-tool="select">SELECCIONAR</button>
        <button data-tool="move">MOVER</button>
        <button data-tool="rotate">ROTAR</button>
        <button data-tool="scale">ESCALAR</button>
        <span class="sep"></span>
        <button id="ed-grid">GRID</button>
        <select id="ed-snap" title="Snap de posición"></select>
        <select id="ed-snaprot" title="Snap de rotación"></select>
        <span class="sep"></span>
        <button id="ed-undo">DESHACER</button>
        <button id="ed-redo">REHACER</button>
        <button id="ed-dup">DUPLICAR</button>
        <button id="ed-del">BORRAR</button>
        <span class="sep"></span>
        <button id="ed-mirx">ESPEJO X</button>
        <button id="ed-mirz">ESPEJO Z</button>
        <span class="sep"></span>
        <button id="ed-cover">COVER</button>
        <button id="ed-nav">NAV</button>
        <button id="ed-path">RUTA A→B</button>
        <button id="ed-top-view">VISTA SUP.</button>
        <span class="sep"></span>
        <button id="ed-save">GUARDAR</button>
        <button id="ed-playtest" class="on">PLAYTEST</button>
        <button id="ed-exit">SALIR</button>
      </div>
      <div class="panel" id="ed-left">
        <h4>MAPA</h4>
        <div class="row"><input id="ed-name" placeholder="nombre" /></div>
        <select id="ed-theme" style="width:100%;margin-top:4px"></select>
        <div style="display:flex;gap:4px;margin-top:6px">
          <input id="ed-fx" type="number" step="0.5" style="width:50%" title="semiancho" />
          <input id="ed-fz" type="number" step="0.5" style="width:50%" title="semilargo" />
        </div>
        <div style="display:flex;gap:4px;margin-top:6px">
          <button id="ed-new" style="flex:1">NUEVO</button>
          <button id="ed-saveas" style="flex:1">GUARDAR COMO</button>
        </div>
        <select id="ed-maps" style="width:100%;margin-top:6px"></select>
        <div style="display:flex;gap:4px;margin-top:4px">
          <button id="ed-open" style="flex:1">ABRIR</button>
          <button id="ed-delmap" class="danger" style="flex:1">BORRAR</button>
        </div>
        <h4>BIBLIOTECA</h4>
        <div class="lib" id="ed-lib"></div>
      </div>
      <div class="panel" id="ed-right">
        <h4>PROPIEDADES</h4>
        <div id="ed-props"></div>
        <h4>VALIDACIÓN</h4>
        <div id="ed-valid"></div>
      </div>
      <div id="ed-status"></div>
      <div id="ed-hint">
        WASD mover · E/C subir-bajar · CLIC DER. mirar · RUEDA zoom<br>
        ALT+CLIC colocar · CLIC seleccionar · SHIFT+CLIC multi · CTRL+D duplicar<br>
        R rotar · SUPR borrar · CTRL+Z deshacer · T vista superior
      </div>`;
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
    snap.innerHTML = SNAP_POS.map((v) => `<option value="${v}">SNAP ${v || 'OFF'}</option>`).join('');
    snap.value = String(ed.snapPos);
    snap.addEventListener('change', () => { ed.snapPos = +snap.value; ed._refreshGrid(); });
    const srot = $('ed-snaprot');
    srot.innerHTML = SNAP_ROT.map((v) => `<option value="${v}">ROT ${v || 'LIBRE'}°</option>`).join('');
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
      if (ed.dirty && !confirm('Hay cambios sin guardar. ¿Crear un mapa nuevo?')) return;
      ed.newMap(); this.refresh();
    });
    $('ed-saveas').addEventListener('click', () => {
      const name = prompt('Nombre del mapa nuevo:', ed.map.name + ' COPIA');
      if (name) { ed.saveAs(name); this.refresh(); }
    });
    $('ed-open').addEventListener('click', () => {
      const id = $('ed-maps').value;
      if (!id) return;
      if (ed.dirty && !confirm('Hay cambios sin guardar. ¿Abrir otro mapa?')) return;
      ed.load(id); this.refresh();
    });
    $('ed-delmap').addEventListener('click', () => {
      const sel = $('ed-maps');
      const id = sel.value;
      const name = sel.options[sel.selectedIndex]?.textContent ?? id;
      if (!id) return;
      // borrar un mapa exige confirmación explícita escribiendo el nombre
      const typed = prompt(`Esto BORRA "${name}" definitivamente.\nEscribe el nombre para confirmar:`);
      if (typed !== name) return ed.setStatus('Borrado cancelado');
      ed.remove(id);
      this.refresh();
    });
    $('ed-name').addEventListener('change', (e) => { ed.map.name = e.target.value.toUpperCase(); ed.dirty = true; this.refresh(); });
    const theme = $('ed-theme');
    theme.innerHTML = THEMES.map((t) => `<option value="${t}">TEMA: ${t.toUpperCase()}</option>`).join('');
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
    const groups = [['gameplay', 'GAMEPLAY'], ['env', 'ENTORNO'], ['marker', 'MARCADORES']];
    for (const [g, label] of groups) {
      const h = document.createElement('h4');
      h.textContent = label;
      lib.append(h);
      for (const p of PALETTE.filter((x) => x.group === g)) {
        const b = document.createElement('button');
        b.textContent = p.label;
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
      if (!red || !blue) return ed.setStatus('Selecciona 2 objetos o coloca ambos spawns');
      a = { x: red.x, z: red.z }; b = { x: blue.x, z: blue.z };
    }
    const r = ed.setPathTest(a, b);
    ed.setStatus(r.route ? `Ruta encontrada (${r.route.length} pasos)` : 'SIN RUTA: zona inaccesible');
    this.refresh();
  }

  show(on) { this.root.classList.toggle('on', on); if (on) this.refresh(); }

  refresh() {
    const ed = this.ed, $ = this.$;
    if (!this.root.classList.contains('on')) return;
    for (const b of this.root.querySelectorAll('[data-tool]')) {
      b.classList.toggle('on', b.dataset.tool === ed.tool);
    }
    for (const b of this.root.querySelectorAll('[data-piece]')) {
      b.classList.toggle('on', b.dataset.piece === ed.brush);
    }
    $('ed-grid').classList.toggle('on', ed.showGrid);
    $('ed-cover').classList.toggle('on', ed.showCover);
    $('ed-nav').classList.toggle('on', ed.showNav);
    $('ed-path').classList.toggle('on', !!ed.pathTest);
    $('ed-name').value = ed.map.name;
    $('ed-theme').value = ed.map.theme;
    $('ed-fx').value = ed.map.fx;
    $('ed-fz').value = ed.map.fz;
    $('ed-status').textContent = ed.status + (ed.dirty ? ' · sin guardar' : '');

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
      box.innerHTML = `<div style="font-size:11px;color:#6f7a85">Sin selección.<br>
        Pieza activa: <b>${paletteById(ed.brush)?.label ?? '—'}</b><br>
        ALT+CLIC para colocarla.</div>`;
      return;
    }
    const o = sel[0];
    const piece = paletteById(o.p);
    const many = sel.length > 1;
    const num = (label, field, step = 0.25) =>
      `<div class="row"><label>${label}</label>
        <input type="number" step="${step}" data-field="${field}" value="${(o[field] ?? 0)}"></div>`;
    let html = `<div style="font-size:11px;margin-bottom:6px">
      <b>${piece?.label ?? o.p}</b>${many ? ` · ${sel.length} seleccionados` : ''}</div>`;
    html += num('X', 'x') + num('Z', 'z');
    if (o.w !== undefined) html += num('W', 'w') + num('D', 'd');
    if (o.h !== undefined && piece?.t === 'box') {
      html += `<div class="row"><label>H</label><select data-field="h">
        <option value="1.1">1.1 BAJO</option><option value="1.9">1.9 MEDIO</option>
        <option value="3">3.0 ALTO</option></select></div>`;
    } else if (o.h !== undefined) html += num('H', 'h');
    html += num('ROT', 'rot', piece?.t === 'box' ? 90 : (ed.snapRot || 15));
    if (piece?.t === 'box') {
      html += `<div style="font-size:10px;color:#6f7a85;margin-top:4px">
        La colisión del juego es AABB: la geometría jugable rota en pasos de 90°.</div>`;
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
    box.innerHTML = report.map((r) => `<div class="${r.level}">${r.msg}</div>`).join('');
    const playable = !report.some((r) => r.level === 'error');
    box.insertAdjacentHTML('afterbegin',
      `<div style="margin-bottom:6px;color:${playable ? '#7bd88f' : '#ff8080'}">
        <b>${playable ? 'JUGABLE' : 'NO JUGABLE'}</b></div>`);
  }
}
