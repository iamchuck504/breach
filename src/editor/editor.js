// EDITOR DE MAPAS de Breach (blockout / level design).
//
// Principio: el editor NO tiene su propio motor. Cada cambio reconstruye el
// mapa con world.setLayout() sobre los datos, así que la geometría que ves
// es exactamente la que el juego simula (mismos colliders, mismas faces de
// cover, misma navegación). Encima se dibujan overlays que solo existen aquí.
//
// Selección y picking son ANALÍTICOS (ray vs AABB sobre los datos): la
// geometría real está batcheada en dos meshes y no se puede pickear.
import * as THREE from 'three';
import {
  PALETTE, paletteById, newMap, makeObject, footprint, THEMES,
  listMaps, getMap, saveMap, deleteMap, duplicateMap, mapLayoutId,
  spawnsOf, validateMap, validationOk, stageMap, unstageMap,
} from '../world/map-data.js';
import { t } from '../core/i18n.js';

const DEG = Math.PI / 180;
const SNAP_POS = [0, 0.25, 0.5, 1, 2];
const SNAP_ROT = [0, 15, 30, 45, 90];

export class MapEditor {
  constructor({ scene, camera, renderer, world, canvas, onPlaytest, onExit }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.world = world;
    this.canvas = canvas;
    this.onPlaytest = onPlaytest;
    this.onExit = onExit;

    this.active = false;
    this.map = newMap();
    this.selection = new Set();
    this.tool = 'select';        // select | move | rotate | scale
    this.snapPos = 1;
    this.snapRot = 90;
    this.showGrid = true;
    this.showCover = false;
    this.showNav = false;
    this.undoStack = [];
    this.redoStack = [];
    this.brush = 'coverLow';     // pieza activa de la biblioteca
    this.dirty = false;
    this.pathTest = null;        // { a, b, route }
    this.status = '';

    // cámara de edición (orbital-libre sobre el plano)
    this.cam = { x: 0, y: 26, z: 34, yaw: 0, pitch: -0.75, speed: 26 };
    this.keys = new Set();
    this.drag = null;

    this.overlay = new THREE.Group();
    this.overlay.name = 'editor-overlay';
    this._buildOverlayResources();
    this._bindInput();
  }

  // ---------------------------------------------------------------- ciclo
  open(map = null) {
    if (map) this.map = JSON.parse(JSON.stringify(map));
    this.active = true;
    this.scene.add(this.overlay);
    this.rebuild();
    this.frameCamera();
  }

  close() {
    this.active = false;
    this.scene.remove(this.overlay);
  }

  discardDraft() {
    if (this.map?.id) unstageMap(this.map.id);
  }

  // Reconstruye el mundo REAL desde los datos (una sola fuente de verdad)
  rebuild() {
    stageMap(this.map);                      // borrador en memoria, no persistencia
    this.world.setLayout(mapLayoutId(this.map), true); // force: mismo id, datos nuevos
    this.refreshOverlay();
  }

  frameCamera() {
    this.cam.x = 0;
    this.cam.z = this.map.fz * 1.15;
    this.cam.y = Math.max(this.map.fx, this.map.fz) * 0.95;
    this.cam.yaw = 0;
    this.cam.pitch = -0.8;
  }

  topView() {
    this.cam.x = 0; this.cam.z = 0.01;
    this.cam.y = Math.max(this.map.fx, this.map.fz) * 2.1;
    this.cam.yaw = 0;
    this.cam.pitch = -Math.PI / 2 + 0.001;
  }

  // ------------------------------------------------------------- historial
  snapshot() { return JSON.stringify(this.map); }
  restore(data) { this.map = JSON.parse(data); }
  pushUndo(label = '') {
    this.undoStack.push({ label, data: this.snapshot() });
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.dirty = true;
  }
  undo() {
    if (!this.undoStack.length) return this.setStatus(t('editor.status.nothingUndo'));
    this.redoStack.push({ data: this.snapshot() });
    const s = this.undoStack.pop();
    this.restore(s.data);
    this.selection.clear();
    this.dirty = true;
    this.rebuild();
    this.setStatus(t('editor.status.undone'));
  }
  redo() {
    if (!this.redoStack.length) return this.setStatus(t('editor.status.nothingRedo'));
    this.undoStack.push({ data: this.snapshot() });
    this.restore(this.redoStack.pop().data);
    this.selection.clear();
    this.dirty = true;
    this.rebuild();
    this.setStatus(t('editor.status.redone'));
  }

  setStatus(msg) { this.status = msg; this.onChange?.(); }

  // ------------------------------------------------------------- edición
  place(x, z) {
    const piece = paletteById(this.brush);
    if (!piece) return;
    // marcadores únicos: el arma especial es una sola por mapa
    if (piece.t === 'special') {
      this.map.objects = this.map.objects.filter((o) => o.p !== 'special');
    }
    this.pushUndo('colocar');
    const o = makeObject(this.brush, this.snap(x), this.snap(z));
    this.map.objects.push(o);
    this.selection.clear();
    this.selection.add(o.id);
    this.rebuild();
  }

  snap(v) { return this.snapPos > 0 ? Math.round(v / this.snapPos) * this.snapPos : v; }

  selected() { return this.map.objects.filter((o) => this.selection.has(o.id)); }

  deleteSelection() {
    if (!this.selection.size) return;
    this.pushUndo('borrar');
    this.map.objects = this.map.objects.filter((o) => !this.selection.has(o.id));
    this.selection.clear();
    this.rebuild();
  }

  duplicateSelection(offset = true) {
    const sel = this.selected();
    if (!sel.length) return;
    this.pushUndo('duplicar');
    const ids = [];
    for (const o of sel) {
      const copy = JSON.parse(JSON.stringify(o));
      copy.id = 'o' + Math.random().toString(36).slice(2, 9);
      if (offset) { copy.x += this.snapPos || 1; copy.z += this.snapPos || 1; }
      this.map.objects.push(copy);
      ids.push(copy.id);
    }
    this.selection = new Set(ids);
    this.rebuild();
    this.setStatus(t('editor.status.duplicated', { count: sel.length }));
  }

  moveSelection(dx, dz, dy = 0) {
    const sel = this.selected();
    if (!sel.length) return;
    for (const o of sel) {
      o.x = this.snap(o.x + dx);
      o.z = this.snap(o.z + dz);
      if (dy && o.h !== undefined) o.h = Math.max(0.2, o.h + dy);
    }
    this.rebuild();
  }

  rotateSelection(deg) {
    const sel = this.selected();
    if (!sel.length) return;
    this.pushUndo('rotar');
    for (const o of sel) {
      const piece = paletteById(o.p);
      // La colisión del juego es AABB: la geometría jugable solo puede rotar
      // en pasos de 90° (intercambia ancho/fondo). Los props sí giran libre.
      const step = piece?.t === 'box' ? 90 : (this.snapRot || deg);
      const amount = piece?.t === 'box' ? (deg >= 0 ? step : -step) : deg;
      o.rot = ((o.rot ?? 0) + amount + 360) % 360;
      if (piece?.t === 'spawn') o.yaw = (o.rot ?? 0) * DEG;
    }
    this.rebuild();
  }

  scaleSelection(f) {
    const sel = this.selected();
    if (!sel.length) return;
    this.pushUndo('escalar');
    for (const o of sel) {
      if (o.w === undefined) continue;
      o.w = Math.max(0.3, +(o.w * f).toFixed(2));
      o.d = Math.max(0.3, +(o.d * f).toFixed(2));
    }
    this.rebuild();
  }

  // Edición numérica exacta desde el panel de propiedades
  setField(field, value) {
    const sel = this.selected();
    if (!sel.length) return;
    this.pushUndo('propiedad');
    for (const o of sel) {
      if (field === 'h' && paletteById(o.p)?.t === 'box') {
        // altura jugable: SOLO las tres alturas legales del juego
        o.h = value;
      } else o[field] = value;
      if (field === 'rot' && paletteById(o.p)?.t === 'spawn') o.yaw = value * DEG;
    }
    this.rebuild();
  }

  // Espejo sobre un eje: crea la mitad reflejada respetando rotación y yaw
  mirror(axis = 'x') {
    const sel = this.selected();
    const src = sel.length ? sel : this.map.objects.slice();
    if (!src.length) return;
    this.pushUndo('espejo');
    const ids = [];
    for (const o of src) {
      const copy = JSON.parse(JSON.stringify(o));
      copy.id = 'o' + Math.random().toString(36).slice(2, 9);
      if (axis === 'x') copy.x = -o.x; else copy.z = -o.z;
      const piece = paletteById(o.p);
      if (piece?.t === 'prop') {
        copy.rot = axis === 'x' ? (360 - (o.rot ?? 0)) % 360 : (180 - (o.rot ?? 0) + 360) % 360;
      }
      if (piece?.t === 'spawn') {
        // el espejo de un spawn es del BANDO contrario y mira al revés
        copy.p = o.p === 'spawnRed' ? 'spawnBlue' : 'spawnRed';
        copy.yaw = axis === 'z' ? (o.yaw ?? 0) + Math.PI : -(o.yaw ?? 0);
      }
      this.map.objects.push(copy);
      ids.push(copy.id);
    }
    this.selection = new Set(ids);
    this.rebuild();
    this.setStatus(t('editor.status.mirrored', { axis: axis.toUpperCase(), count: src.length }));
  }

  // ------------------------------------------------------------- picking
  // Ray del cursor contra el plano Y=0 (colocación) y contra AABBs (selección)
  screenRay(nx, ny) {
    const ndc = new THREE.Vector2(nx, ny);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray.ray;
  }

  groundPoint(nx, ny) {
    const ray = this.screenRay(nx, ny);
    if (Math.abs(ray.direction.y) < 1e-5) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t <= 0) return null;
    return {
      x: ray.origin.x + ray.direction.x * t,
      z: ray.origin.z + ray.direction.z * t,
    };
  }

  pick(nx, ny) {
    const ray = this.screenRay(nx, ny);
    let best = null;
    for (const o of this.map.objects) {
      const box = this.objectBox(o);
      const t = rayBox(ray, box);
      if (t !== null && (!best || t < best.t)) best = { t, o };
    }
    return best?.o ?? null;
  }

  objectBox(o) {
    const piece = paletteById(o.p);
    const marker = piece && (piece.t === 'spawn' || piece.t === 'crate' || piece.t === 'special');
    const fp = marker ? { w: 1.1, d: 1.1 } : footprint(o);
    const h = marker ? 1.6 : (o.h ?? 1);
    return {
      minx: o.x - fp.w / 2, maxx: o.x + fp.w / 2,
      minz: o.z - fp.d / 2, maxz: o.z + fp.d / 2,
      miny: 0, maxy: h,
    };
  }

  // ------------------------------------------------------------- overlays
  _buildOverlayResources() {
    this.gridHelper = null;
    this.selBox = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.coverGroup = new THREE.Group();
    this.navGroup = new THREE.Group();
    this.pathGroup = new THREE.Group();
    this.ghost = null;
    this.overlay.add(this.selBox, this.markerGroup, this.coverGroup, this.navGroup, this.pathGroup);
    this._matSel = new THREE.LineBasicMaterial({ color: 0xffb057 });
    this._matSelFill = new THREE.MeshBasicMaterial({
      color: 0xff8b42, transparent: true, opacity: 0.11, depthWrite: false,
    });
    this._matTeam = {
      red: new THREE.MeshBasicMaterial({ color: 0xd94f3f, transparent: true, opacity: 0.75 }),
      blue: new THREE.MeshBasicMaterial({ color: 0x4f8de0, transparent: true, opacity: 0.75 }),
      ammo: new THREE.MeshBasicMaterial({ color: 0x7bd88f, transparent: true, opacity: 0.75 }),
      special: new THREE.MeshBasicMaterial({ color: 0xffb057, transparent: true, opacity: 0.8 }),
    };
    this._matCover = {
      low: new THREE.MeshBasicMaterial({ color: 0x6ce0a0, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      medium: new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      high: new THREE.MeshBasicMaterial({ color: 0xe0566c, transparent: true, opacity: 0.3, side: THREE.DoubleSide }),
    };
  }

  refreshOverlay() {
    this._refreshGrid();
    this._refreshMarkers();
    this._refreshSelection();
    this._refreshCover();
    this._refreshNav();
    this.onChange?.();
  }

  _refreshGrid() {
    if (this.gridHelper) {
      this.overlay.remove(this.gridHelper);
      this.gridHelper.traverse((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
      });
    }
    if (!this.showGrid) { this.gridHelper = null; return; }
    const size = Math.max(this.map.fx, this.map.fz) * 2;
    const group = new THREE.Group();
    const minorStep = Math.max(2, this.snapPos || 1);
    const minor = new THREE.GridHelper(size, Math.min(Math.round(size / minorStep), 160), 0x3b4854, 0x26313b);
    const major = new THREE.GridHelper(size, Math.min(Math.round(size / 8), 48), 0x71808d, 0x46535f);
    minor.material.transparent = true; minor.material.opacity = 0.22;
    major.material.transparent = true; major.material.opacity = 0.42;
    group.add(minor, major);
    this.gridHelper = group;
    this.gridHelper.position.y = 0.02;
    this.overlay.add(this.gridHelper);
  }

  _clear(group, disposeMaterial = false) {
    for (const c of [...group.children]) {
      group.remove(c);
      c.geometry?.dispose?.();
      if (disposeMaterial) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose?.());
        else c.material?.dispose?.();
      }
    }
  }

  _refreshMarkers() {
    this._clear(this.markerGroup);
    for (const o of this.map.objects) {
      const piece = paletteById(o.p);
      if (!piece || (piece.t !== 'spawn' && piece.t !== 'crate' && piece.t !== 'special')) continue;
      const mat = piece.t === 'spawn' ? this._matTeam[piece.team]
        : piece.t === 'crate' ? this._matTeam.ammo : this._matTeam.special;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.14, 16), mat);
      m.position.set(o.x, 0.08, o.z);
      this.markerGroup.add(m);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.02, 20), mat);
      ring.rotation.x = -Math.PI / 2; ring.position.set(o.x, 0.035, o.z);
      this.markerGroup.add(ring);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.8, 0.16), mat);
      post.position.set(o.x, 0.9, o.z);
      this.markerGroup.add(post);
      if (piece.t === 'spawn') {
        // flecha de orientación: hacia dónde mira quien nace aquí
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.9, 8), mat);
        const yaw = o.yaw ?? 0;
        arrow.position.set(o.x - Math.sin(yaw) * 1.35, 0.42, o.z - Math.cos(yaw) * 1.35);
        arrow.rotation.set(Math.PI / 2, 0, yaw);
        this.markerGroup.add(arrow);
      }
    }
  }

  _refreshSelection() {
    this._clear(this.selBox);
    for (const o of this.selected()) {
      const b = this.objectBox(o);
      const geo = new THREE.BoxGeometry(b.maxx - b.minx, b.maxy - b.miny, b.maxz - b.minz);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), this._matSel);
      edges.position.set((b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2, (b.minz + b.maxz) / 2);
      const fill = new THREE.Mesh(geo, this._matSelFill);
      fill.position.copy(edges.position);
      this.selBox.add(fill, edges);
    }
  }

  // Cover REAL reconocido por el juego: se lee de world.faces, no de los datos
  _refreshCover() {
    this._clear(this.coverGroup);
    this.coverGroup.visible = this.showCover;
    if (!this.showCover) return;
    for (const f of this.world.faces) {
      const len = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
      if (len < 0.05) continue;
      const mat = this._matCover[f.kind] ?? this._matCover.high;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(len, Math.min(f.h, 3)), mat);
      plane.position.set((f.a.x + f.b.x) / 2, Math.min(f.h, 3) / 2 + 0.02,
        (f.a.z + f.b.z) / 2);
      plane.position.x += f.n.x * 0.04;
      plane.position.z += f.n.z * 0.04;
      plane.rotation.y = Math.atan2(f.n.x, f.n.z);
      this.coverGroup.add(plane);
    }
  }

  // Navegación: celdas transitables según la MISMA física del juego
  _refreshNav() {
    this._clear(this.navGroup, true);
    this.navGroup.visible = this.showNav;
    if (!this.showNav) return;
    const grid = this.navGrid();
    const geo = new THREE.PlaneGeometry(grid.cell * 0.86, grid.cell * 0.86);
    const walk = new THREE.MeshBasicMaterial({ color: 0x4f8de0, transparent: true, opacity: 0.22 });
    const block = new THREE.MeshBasicMaterial({ color: 0xe0566c, transparent: true, opacity: 0.16 });
    const walkCells = [], blockCells = [];
    for (let i = 0; i < grid.w; i++) {
      for (let j = 0; j < grid.h; j++) {
        const walkable = grid.cells[j * grid.w + i];
        (walkable ? walkCells : blockCells).push([grid.x0 + i * grid.cell, grid.z0 + j * grid.cell]);
      }
    }
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const scale = new THREE.Vector3(1, 1, 1);
    const addCells = (cells, mat) => {
      if (!cells.length) { mat.dispose(); return; }
      const mesh = new THREE.InstancedMesh(geo.clone(), mat, cells.length);
      cells.forEach(([x, z], i) => {
        matrix.compose(new THREE.Vector3(x, 0.05, z), quat, scale);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.navGroup.add(mesh);
    };
    addCells(walkCells, walk); addCells(blockCells, block);
    geo.dispose();
  }

  // Grid de navegación derivada de la física real (resolveCircle con el radio
  // del jugador): si el jugador no cabe, la celda no es transitable.
  navGrid(cell = 1.5) {
    const w = Math.max(2, Math.round((this.map.fx * 2) / cell));
    const h = Math.max(2, Math.round((this.map.fz * 2) / cell));
    const x0 = -this.map.fx + cell / 2, z0 = -this.map.fz + cell / 2;
    const cells = new Uint8Array(w * h);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        const p = { x, z };
        this.world.resolveCircle(p, 0.38, 0);
        const free = Math.hypot(p.x - x, p.z - z) < 0.02;
        // un bloque LOW es transitable por encima (se salta/mantle), pero a
        // efectos de ruta a pie cuenta como bloqueado
        cells[j * w + i] = free ? 1 : 0;
      }
    }
    return { w, h, cell, x0, z0, cells };
  }

  // Ruta A→B sobre la grid (BFS): responde "¿un bot puede llegar?" usando la
  // física real del mapa. No sustituye al steering de los bots, pero detecta
  // zonas inaccesibles y rutas imposibles, que es para lo que sirve.
  findPath(a, b) {
    const g = this.navGrid();
    const idx = (i, j) => j * g.w + i;
    const toCell = (p) => ({
      i: Math.round((p.x - g.x0) / g.cell),
      j: Math.round((p.z - g.z0) / g.cell),
    });
    const inside = (i, j) => i >= 0 && j >= 0 && i < g.w && j < g.h;
    const nearestFree = (c) => {
      if (inside(c.i, c.j) && g.cells[idx(c.i, c.j)]) return c;
      for (let r = 1; r < 6; r++) {
        for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
          const i = c.i + di, j = c.j + dj;
          if (inside(i, j) && g.cells[idx(i, j)]) return { i, j };
        }
      }
      return null;
    };
    const start = nearestFree(toCell(a)), goal = nearestFree(toCell(b));
    if (!start || !goal) return null;
    const prev = new Int32Array(g.w * g.h).fill(-1);
    const seen = new Uint8Array(g.w * g.h);
    const queue = [idx(start.i, start.j)];
    seen[queue[0]] = 1;
    const goalIdx = idx(goal.i, goal.j);
    let found = false;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === goalIdx) { found = true; break; }
      const ci = cur % g.w, cj = (cur - ci) / g.w;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (!inside(ni, nj)) continue;
        const n = idx(ni, nj);
        if (seen[n] || !g.cells[n]) continue;
        // en diagonal, exigir que ambos ortogonales estén libres (sin colarse
        // por esquinas donde el jugador no cabe)
        if (di && dj && (!g.cells[idx(ci + di, cj)] || !g.cells[idx(ci, cj + dj)])) continue;
        seen[n] = 1; prev[n] = cur; queue.push(n);
      }
    }
    if (!found) return null;
    const route = [];
    for (let cur = goalIdx; cur !== -1; cur = prev[cur]) {
      const ci = cur % g.w, cj = (cur - ci) / g.w;
      route.push({ x: g.x0 + ci * g.cell, z: g.z0 + cj * g.cell });
      if (cur === idx(start.i, start.j)) break;
    }
    return route.reverse();
  }

  setPathTest(a, b) {
    this.pathTest = { a, b, route: this.findPath(a, b) };
    this._refreshPath();
    return this.pathTest;
  }

  clearPathTest() { this.pathTest = null; this._refreshPath(); }

  _refreshPath() {
    this._clear(this.pathGroup, true);
    const p = this.pathTest;
    if (!p) return;
    const mark = (pt, color) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8),
        new THREE.MeshBasicMaterial({ color }));
      m.position.set(pt.x, 0.5, pt.z);
      this.pathGroup.add(m);
    };
    mark(p.a, 0x7bd88f);
    mark(p.b, 0xe0566c);
    if (!p.route) return;
    const pts = p.route.map((r) => new THREE.Vector3(r.x, 0.35, r.z));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffb057 }),
    );
    this.pathGroup.add(line);
  }

  // Conectividad entre bandos: ¿se puede ir de un spawn rojo a uno azul?
  spawnsConnected() {
    const s = spawnsOf(this.map);
    if (!s.red.length || !s.blue.length) return null;
    const anchor = s.red[0];
    return [...s.red.slice(1), ...s.blue].every((spawn) => !!this.findPath(anchor, spawn));
  }

  validate() {
    const report = validateMap(this.map, this.world);
    const conn = this.spawnsConnected();
    if (conn === true) report.push({ level: 'ok', key: 'nav', msg: 'Rojo y azul conectados', i18nKey: 'editor.validation.nav.ok' });
    else if (conn === false) report.push({ level: 'error', key: 'nav', msg: 'Los spawns NO están conectados', i18nKey: 'editor.validation.nav.error' });
    return report;
  }

  playable() { return validationOk(this.validate()); }

  // -------------------------------------------------------------- archivo
  newMap() {
    if (this.map?.id) unstageMap(this.map.id);
    this.map = newMap();
    this.selection.clear();
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.dirty = false;
    this.rebuild();
    this.frameCamera();
  }
  load(id) {
    const m = getMap(id);
    if (!m) return;
    this.map = JSON.parse(JSON.stringify(m));
    this.selection.clear();
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.dirty = false;
    this.rebuild();
    this.frameCamera();
    this.setStatus(t('editor.status.loaded', { name: m.name }));
  }
  save() {
    saveMap(this.map);
    this.dirty = false;
    this.setStatus(t('editor.status.saved', { name: this.map.name }));
  }
  saveAs(name) {
    this.map = JSON.parse(JSON.stringify(this.map));
    this.map.id = 'map-' + Math.random().toString(36).slice(2, 8);
    this.map.name = name || (this.map.name + ' COPIA');
    saveMap(this.map);
    this.rebuild();
    this.dirty = false;
    this.setStatus(t('editor.status.savedAs', { name: this.map.name }));
  }
  duplicate() { const d = duplicateMap(this.map.id); if (d) this.setStatus(t('editor.status.duplicateMap', { name: d.name })); }
  remove(id) { deleteMap(id); this.setStatus(t('editor.status.deleted')); }
  maps() { return listMaps(); }

  // ---------------------------------------------------------------- input
  _bindInput() {
    this._onKey = (e) => {
      if (!this.active) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (e.ctrlKey && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.ctrlKey && k === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
      if (e.ctrlKey && k === 's') { e.preventDefault(); this.save(); return; }
      if (k === 'delete' || k === 'backspace') { this.deleteSelection(); return; }
      if (k === 'escape') { this.selection.clear(); this.refreshOverlay(); return; }
      if (k === 'q') this.setTool('select');
      if (k === 'w') { /* también movimiento de cámara */ }
      if (k === 'g') { this.showGrid = !this.showGrid; this._refreshGrid(); this.onChange?.(); }
      if (k === 'r' && !e.ctrlKey) this.rotateSelection(this.snapRot || 90);
      if (k === 't') this.topView();
      this.keys.add(e.code);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    // Zoom = avanzar/retroceder a lo largo de la línea de visión. El paso
    // escala con la altura para que acercarse desde lejos sea rápido y el
    // ajuste fino cerca del suelo siga siendo preciso.
    this._onWheel = (e) => {
      if (!this.active) return;
      const dir = this._camDir();
      const step = -Math.sign(e.deltaY) * Math.max(1.5, this.cam.y * 0.22);
      this.cam.x += dir.x * step;
      this.cam.z += dir.z * step;
      this.cam.y = Math.max(1.5, Math.min(240, this.cam.y + dir.y * step));
    };
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
  }

  _camDir() {
    const cp = Math.cos(this.cam.pitch), sp = Math.sin(this.cam.pitch);
    return { x: -Math.sin(this.cam.yaw) * cp, y: sp, z: -Math.cos(this.cam.yaw) * cp };
  }

  // clic izquierdo: seleccionar o colocar; con Shift, multi-selección
  onPointerDown(nx, ny, { shift, alt, button }) {
    if (!this.active) return;
    this._lastPtr = { x: nx * 0.5 * window.innerWidth, y: -ny * 0.5 * window.innerHeight };
    if (button === 2) { this.drag = { kind: 'look' }; return; }
    const hit = this.pick(nx, ny);
    if (alt) {
      const g = this.groundPoint(nx, ny);
      if (g) this.place(g.x, g.z);
      return;
    }
    if (hit) {
      if (shift) {
        if (this.selection.has(hit.id)) this.selection.delete(hit.id);
        else this.selection.add(hit.id);
      } else if (!this.selection.has(hit.id)) {
        this.selection = new Set([hit.id]);
      }
      const g = this.groundPoint(nx, ny);
      // Snapshot del estado inicial: rotar/escalar aplican un delta ABSOLUTO
      // desde aquí (un solo undo por gesto y sin deriva acumulada).
      this.drag = {
        kind: 'move', last: g, moved: false, acc: 0,
        start: this.selected().map((o) => ({ id: o.id, rot: o.rot ?? 0, w: o.w, d: o.d })),
      };
      this.refreshOverlay();
    } else if (!shift) {
      this.selection.clear();
      this.refreshOverlay();
    }
  }

  onPointerMove(nx, ny, mdxRaw = 0, mdyRaw = 0) {
    if (!this.active) return;
    // Delta calculado desde las coordenadas normalizadas: movementX/Y no es
    // fiable (llega en 0 con eventos sintéticos y sin pointer lock), y las
    // herramientas de rotar/escalar dependen del desplazamiento del cursor.
    const px = nx * 0.5 * window.innerWidth, py = -ny * 0.5 * window.innerHeight;
    const last = this._lastPtr ?? { x: px, y: py };
    let dx = px - last.x, dy = py - last.y;
    this._lastPtr = { x: px, y: py };
    if (dx === 0 && dy === 0) { dx = mdxRaw; dy = mdyRaw; }
    if (this.drag?.kind === 'look') {
      this.cam.yaw -= dx * 0.0032;
      this.cam.pitch = Math.max(-1.55, Math.min(-0.05, this.cam.pitch - dy * 0.0032));
      return;
    }
    if (!this.drag || this.drag.kind !== 'move' || this.tool === 'select') return;

    // ROTAR arrastrando en horizontal: el desplazamiento del cursor se
    // convierte en ángulo, con el snap activo (y 90° fijos en geometría AABB).
    if (this.tool === 'rotate') {
      if (!this.drag.moved && Math.abs(dx) < 1) return;
      if (!this.drag.moved) { this.pushUndo('rotar'); this.drag.moved = true; }
      this.drag.acc += dx * 0.45;
      const stepped = this.snapRot > 0
        ? Math.round(this.drag.acc / this.snapRot) * this.snapRot
        : this.drag.acc;
      for (const s of this.drag.start) {
        const o = this.map.objects.find((x) => x.id === s.id);
        if (!o) continue;
        const piece = paletteById(o.p);
        // AABB: la geometría jugable solo admite múltiplos de 90°
        const delta = piece?.t === 'box' ? Math.round(stepped / 90) * 90 : stepped;
        o.rot = ((s.rot + delta) % 360 + 360) % 360;
        if (piece?.t === 'spawn') o.yaw = o.rot * DEG;
      }
      this.rebuild();
      return;
    }

    // ESCALAR arrastrando: derecha/arriba agranda, izquierda/abajo encoge.
    if (this.tool === 'scale') {
      if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!this.drag.moved) { this.pushUndo('escalar'); this.drag.moved = true; }
      this.drag.acc += (dx - dy) * 0.006;
      const f = Math.max(0.15, Math.min(6, 1 + this.drag.acc));
      for (const s of this.drag.start) {
        const o = this.map.objects.find((x) => x.id === s.id);
        if (!o || s.w === undefined) continue;
        o.w = Math.max(0.3, +(s.w * f).toFixed(2));
        o.d = Math.max(0.3, +(s.d * f).toFixed(2));
      }
      this.rebuild();
      return;
    }

    // MOVER: el objeto sigue al cursor sobre el plano del suelo
    const g = this.groundPoint(nx, ny);
    if (!g || !this.drag.last) return;
    const mdx = g.x - this.drag.last.x, mdz = g.z - this.drag.last.z;
    if (!this.drag.moved && Math.hypot(mdx, mdz) > 0.05) {
      this.pushUndo('mover');
      this.drag.moved = true;
    }
    if (this.drag.moved) {
      for (const o of this.selected()) { o.x = this.snap(o.x + mdx); o.z = this.snap(o.z + mdz); }
      this.drag.last = g;
      this.rebuild();
    }
  }

  onPointerUp() { this.drag = null; }

  setTool(t) { this.tool = t; this.onChange?.(); }

  // Cámara de edición: WASD + E/C para subir/bajar, Shift acelera
  update(dt) {
    if (!this.active) return;
    const dir = this._camDir();
    const right = { x: Math.cos(this.cam.yaw), z: -Math.sin(this.cam.yaw) };
    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1;
    if (this.keys.has('KeyS')) mz -= 1;
    if (this.keys.has('KeyA')) mx -= 1;
    if (this.keys.has('KeyD')) mx += 1;
    if (this.keys.has('KeyE') || this.keys.has('Space')) my += 1;
    if (this.keys.has('KeyC') || this.keys.has('ControlLeft')) my -= 1;
    const boost = this.keys.has('ShiftLeft') ? 2.6 : 1;
    const sp = this.cam.speed * boost * dt;
    // avanzar sobre el plano (no hacia el suelo): navegación de editor
    const flat = Math.hypot(dir.x, dir.z) || 1;
    this.cam.x += (dir.x / flat * mz + right.x * mx) * sp;
    this.cam.z += (dir.z / flat * mz + right.z * mx) * sp;
    this.cam.y = Math.max(1.5, this.cam.y + my * sp);

    this.camera.position.set(this.cam.x, this.cam.y, this.cam.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.cam.yaw);
    this.camera.rotateX(this.cam.pitch);
    if (this.camera.fov !== 62) { this.camera.fov = 62; this.camera.updateProjectionMatrix(); }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('wheel', this._onWheel);
  }
}

// Ray vs AABB (slabs). Devuelve t de entrada o null.
function rayBox(ray, b) {
  const o = ray.origin, d = ray.direction;
  let tmin = -Infinity, tmax = Infinity;
  for (const [oi, di, lo, hi] of [
    [o.x, d.x, b.minx, b.maxx], [o.y, d.y, b.miny, b.maxy], [o.z, d.z, b.minz, b.maxz],
  ]) {
    if (Math.abs(di) < 1e-8) { if (oi < lo || oi > hi) return null; continue; }
    let t1 = (lo - oi) / di, t2 = (hi - oi) / di;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin > 0 ? tmin : (tmax > 0 ? tmax : null);
}

export { SNAP_POS, SNAP_ROT, PALETTE, THEMES };
