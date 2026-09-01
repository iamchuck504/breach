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
  mapFromSnapshot, serializeMap, parseMapFile,
} from '../world/map-data.js';
import { BLOCK } from '../world/block-heights.js';
// El Rig REAL del juego como personaje de referencia: mismas proporciones y
// altura que en gameplay. El editor entero es un chunk DEV (import dinámico
// en main.js), así que esto no toca el bundle de producción.
import { Rig } from '../player/rig.js';
import { t } from '../core/i18n.js';

// Alturas de la cápsula de impactos (ballistics): cuerpo hasta 1.30, cabeza
// hasta 1.74. Junto a LOW/MID/HIGH forman la regla de escala del personaje.
const CHAR_EYE = 1.3;
const CHAR_HEAD = 1.74;

const DEG = Math.PI / 180;
const SNAP_POS = [0, 0.25, 0.5, 1, 2];
const SNAP_ROT = [0, 15, 30, 45, 90];
const RECOVERY_KEY = 'breach.editor.recovery.v1';

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
    this.lastSavedAt = null;
    this.pathTest = null;        // { a, b, route }
    this.status = '';

    // cámara de edición (orbital-libre sobre el plano)
    this.cam = { x: 0, y: 26, z: 34, yaw: 0, pitch: -0.75, speed: 26 };
    this.keys = new Set();
    this.drag = null;

    this.overlay = new THREE.Group();
    this.overlay.name = 'editor-overlay';
    // personajes de referencia: pool por id (construir un Rig es caro y el
    // rebuild corre en cada frame de un arrastre)
    this._charRigs = new Map();
    this.showCharRefs = true;
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
    this._flushRecovery();
    this.scene.remove(this.overlay);
  }

  discardDraft() {
    if (this.map?.id) unstageMap(this.map.id);
  }

  // Reconstruye el mundo REAL desde los datos (una sola fuente de verdad)
  rebuild() {
    this._upgradeBaseDecor();
    stageMap(this.map);                      // borrador en memoria, no persistencia
    this.world.setLayout(mapLayoutId(this.map), true); // force: mismo id, datos nuevos
    this.refreshOverlay();
    if (this.dirty) this._scheduleRecovery();
  }

  // Migración transparente de clones guardados antes de que los assets base
  // fueran editables. Conserva la posición actual de cada collider y le
  // adjunta su carrocería; el usuario no tiene que borrar ni volver a clonar.
  _upgradeBaseDecor() {
    const previousVersion = this.map?.decorCaptureVersion ?? 0;
    if (!this.map?.base || previousVersion >= 9) return false;
    const template = mapFromSnapshot(this.map.base, this.world.snapshotLayout(this.map.base));
    const isBox = (o) => paletteById(o.p)?.t === 'box';
    // v5/v6 (auditoría de hitboxes 2026-08-31): la física de vehículos, bus,
    // kioscos, paradas y farolas se re-derivó de las siluetas MEDIDAS de los
    // meshes (v6 afina kioscos con paneles completos + repisa del hotdog y
    // vehículos con pisos desplazados) — todo clon anterior reemplaza esas
    // cajas por las nuevas.
    const revisedPhysics = new Set(['urban:streetlight', 'urban:busShelter',
      'urban:suvMinivan', 'street:vehicle', 'street:truck', 'street:bus',
      'street:kiosk']);
    const physicalAssets = new Set(['urban:streetlight', 'urban:fireHydrant',
      'urban:busShelter', 'urban:suvMinivan', 'street:vehicle', 'street:truck',
      'street:bus', 'street:kiosk']);

    // Quitar las cajas viejas de las familias revisadas antes de importar la
    // física nueva evita colliders fantasma en clones ya guardados (v3 tenía
    // además el pivot del poste equivocado y la parada cerrada de una pieza).
    {
      const assets = this.map.objects.filter((o) => o.baseDecor && revisedPhysics.has(o.p));
      const obsoleteLinks = new Set(assets.map((o) => o.link).filter(Boolean));
      this.map.objects = this.map.objects.filter((o) =>
        !(isBox(o) && o.link && obsoleteLinks.has(o.link)));
      for (const asset of assets) delete asset.link;
    }

    const sourceBoxes = template.objects.filter(isBox);
    const targetBoxes = this.map.objects.filter(isBox);
    const sourceDecor = template.objects.filter((o) => o.baseDecor);
    const physicalLinks = new Set(sourceDecor
      .filter((o) => physicalAssets.has(o.p)).map((o) => o.link).filter(Boolean));
    const newLinks = new Map();
    const freshLink = (sourceLink) => {
      if (!newLinks.has(sourceLink)) {
        newLinks.set(sourceLink, 'link-' + Math.random().toString(36).slice(2, 9));
      }
      return newLinks.get(sourceLink);
    };

    // v3/v4 añaden y refinan la física del mobiliario urbano. Una parada usa
    // tres cajas con cover y un poste/hidrante usa una caja sin cover.
    for (const source of sourceBoxes.filter((o) => o.link && physicalLinks.has(o.link))) {
      const exists = targetBoxes.some((o) => o.visual === false &&
        Math.hypot(o.x - source.x, o.z - source.z) < 0.08 &&
        Math.abs((o.w ?? 0) - (source.w ?? 0)) < 0.08 &&
        Math.abs((o.d ?? 0) - (source.d ?? 0)) < 0.08);
      if (exists) continue;
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = 'o' + Math.random().toString(36).slice(2, 9);
      if (source.link) {
        copy.link = freshLink(source.link);
        const sourceAsset = sourceDecor.find((o) => o.link === source.link);
        if (sourceAsset) {
          const peers = sourceDecor.filter((o) => o.p === sourceAsset.p);
          const targetPeers = this.map.objects.filter((o) => o.baseDecor && o.p === sourceAsset.p);
          const ordinal = peers.indexOf(sourceAsset);
          const targetAsset = targetPeers.find((o) =>
            Math.hypot(o.x - sourceAsset.x, o.z - sourceAsset.z) < 0.15) ?? targetPeers[ordinal];
          if (targetAsset) {
            targetAsset.link = copy.link;
            const ratio = (targetAsset.scale ?? 1) / (sourceAsset.scale ?? 1);
            const angle = ((targetAsset.rot ?? 0) - (sourceAsset.rot ?? 0)) * DEG;
            const dx = (source.x - sourceAsset.x) * ratio;
            const dz = (source.z - sourceAsset.z) * ratio;
            copy.x = +(targetAsset.x + dx * Math.cos(angle) + dz * Math.sin(angle)).toFixed(4);
            copy.z = +(targetAsset.z - dx * Math.sin(angle) + dz * Math.cos(angle)).toFixed(4);
            copy.w = +(copy.w * ratio).toFixed(4);
            copy.d = +(copy.d * ratio).toFixed(4);
            copy.h = +(copy.h * ratio).toFixed(4);
            const turns = Math.abs(Math.round(((targetAsset.rot ?? 0) - (sourceAsset.rot ?? 0)) / 90)) % 2;
            if (turns) [copy.w, copy.d] = [copy.d, copy.w];
          }
        }
      }
      this.map.objects.push(copy);
      targetBoxes.push(copy);
    }

    for (const source of sourceDecor) {
      // v1 ya tenía GLBs/vehículos; v2 ya tenía además las pieles de cover.
      // Cada migración agrega únicamente las familias introducidas después.
      if (previousVersion >= 3) continue;
      if (previousVersion >= 2 && source.p !== 'street:building') continue;
      if (previousVersion === 1 && paletteById(source.p)?.t !== 'baseDecor') continue;
      const copy = JSON.parse(JSON.stringify(source));
      copy.id = 'o' + Math.random().toString(36).slice(2, 9);
      if (source.link) {
        const sourceIndex = sourceBoxes.findIndex((o) => o.link === source.link);
        const linked = newLinks.get(source.link);
        const target = targetBoxes.find((o) => linked && o.link === linked) ?? targetBoxes[sourceIndex];
        if (!target) continue;
        copy.link = freshLink(source.link);
        target.link = copy.link;
        // Si el collider ya se movió en el clon antiguo, recuperar el visual
        // directamente sobre su posición actual, no sobre la original.
        if (!physicalAssets.has(source.p)) {
          copy.x = target.x;
          copy.z = target.z;
        }
      }
      this.map.objects.push(copy);
    }
    this.map.decorCaptured = true;
    this.map.decorCaptureVersion = 9;
    return true;
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
    this._scheduleRecovery();
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

  // Recuperación local independiente del guardado normal. Nunca publica ni
  // altera el mapa persistido: solo conserva el último borrador por si el
  // navegador o el servidor local se cierran inesperadamente.
  _scheduleRecovery() {
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer = setTimeout(() => this._flushRecovery(), 220);
  }

  _flushRecovery() {
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer = null;
    if (!this.dirty || !this.map) return;
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        map: this.map,
      }));
    } catch { /* almacenamiento privado/lleno: el editor sigue funcionando */ }
  }

  recovery() {
    try {
      const value = JSON.parse(localStorage.getItem(RECOVERY_KEY) || 'null');
      return value?.version === 1 && value?.map?.objects ? value : null;
    } catch { return null; }
  }

  restoreRecovery() {
    const value = this.recovery();
    if (!value) return false;
    if (this.map?.id) unstageMap(this.map.id);
    this.map = JSON.parse(JSON.stringify(value.map));
    this.selection.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = true;
    this.rebuild();
    this.frameCamera();
    this.setStatus(t('editor.status.recovered'));
    return true;
  }

  clearRecovery() {
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer = null;
    try { localStorage.removeItem(RECOVERY_KEY); } catch { /* ok */ }
  }

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

  linkedSelection(o) {
    if (!o?.link) return [o?.id].filter(Boolean);
    return this.map.objects.filter((x) => x.link === o.link).map((x) => x.id);
  }

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
    const links = new Map();
    for (const o of sel) {
      const copy = JSON.parse(JSON.stringify(o));
      copy.id = 'o' + Math.random().toString(36).slice(2, 9);
      if (copy.link) {
        if (!links.has(copy.link)) links.set(copy.link, 'link-' + Math.random().toString(36).slice(2, 9));
        copy.link = links.get(copy.link);
      }
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

  // Movimiento discreto de teclado. A diferencia del drag, conserva el
  // offset actual respecto a la cuadrícula: una pieza en X=-2.5 avanza a
  // -1.5 con un paso de 1, sin saltar primero a un entero.
  nudgeSelection(dx, dz) {
    const sel = this.selected();
    if (!sel.length) return;
    for (const o of sel) {
      o.x = +(o.x + dx).toFixed(4);
      o.z = +(o.z + dz).toFixed(4);
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
      if (['urban', 'street', 'baseDecor'].includes(paletteById(o.p)?.t)) {
        o.scale = Math.max(0.1, Math.min(8, +((o.scale ?? 1) * f).toFixed(2)));
        continue;
      }
      if (o.w === undefined) continue;
      o.w = Math.max(0.3, +(o.w * f).toFixed(2));
      o.d = Math.max(0.3, +(o.d * f).toFixed(2));
    }
    this.rebuild();
  }

  // Edición numérica exacta desde el panel de propiedades
  setField(field, value, { record = true } = {}) {
    const sel = this.selected();
    if (!sel.length) return;
    if (record) this.pushUndo('propiedad');
    for (const o of sel) {
      if (field === 'h' && paletteById(o.p)?.t === 'box') {
        // altura jugable: SOLO las tres alturas legales del juego
        o.h = value;
      } else o[field] = value;
      if (field === 'rot' && paletteById(o.p)?.t === 'spawn') o.yaw = value * DEG;
    }
    this.rebuild();
  }

  selectObjects(ids, { focus = false } = {}) {
    const known = new Set(this.map.objects.map((o) => o.id));
    this.selection = new Set((ids || []).filter((id) => known.has(id)));
    this.refreshOverlay();
    if (focus) this.focusSelection();
    this.onChange?.();
  }

  focusSelection() {
    const sel = this.selected();
    if (!sel.length) return this.setStatus(t('editor.status.focusNeedsSelection'));
    const boxes = sel.map((o) => this.objectBox(o));
    const center = {
      x: boxes.reduce((n, b) => n + (b.minx + b.maxx) / 2, 0) / boxes.length,
      y: boxes.reduce((n, b) => n + (b.miny + b.maxy) / 2, 0) / boxes.length,
      z: boxes.reduce((n, b) => n + (b.minz + b.maxz) / 2, 0) / boxes.length,
    };
    const span = Math.max(2,
      ...boxes.map((b) => Math.max(b.maxx - b.minx, b.maxz - b.minz, b.maxy - b.miny)));
    const dir = this._camDir();
    const distance = Math.max(5, span * 3.2);
    this.cam.x = center.x - dir.x * distance;
    this.cam.z = center.z - dir.z * distance;
    this.cam.y = Math.max(1.8, center.y - dir.y * distance);
    this.setStatus(t('editor.status.focused', { count: sel.length }));
  }

  insertBrushAtView() {
    const g = this.groundPoint(0, 0);
    if (!g) return this.setStatus(t('editor.status.insertUnavailable'));
    this.place(g.x, g.z);
    this.setTool('move');
    this.focusSelection();
  }

  handleEscape() {
    if (this.drag?.kind === 'move' && this.drag.moved && this.drag.before) {
      this.restore(this.drag.before);
      if (this.undoStack.at(-1)?.data === this.drag.before) this.undoStack.pop();
      this.dirty = this.drag.dirtyBefore;
      this.drag = null;
      this.rebuild();
      this.setStatus(t('editor.status.transformCancelled'));
      return true;
    }
    if (this.pathTest) {
      this.clearPathTest();
      this.setStatus(t('editor.status.routeCleared'));
      return true;
    }
    if (this.selection.size) {
      this.selection.clear();
      this.refreshOverlay();
      this.onChange?.();
      return true;
    }
    return false;
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
      if (o.p === 'charRef' && !this.showCharRefs) continue;
      if (o.baseDecor && this.map.decor === false) continue;
      const box = this.objectBox(o);
      const t = rayBox(ray, box);
      if (t !== null && (!best || t < best.t)) best = { t, o };
    }
    return best?.o ?? null;
  }

  objectBox(o) {
    const piece = paletteById(o.p);
    const marker = piece && (piece.t === 'spawn' || piece.t === 'crate' || piece.t === 'special');
    // el personaje de referencia se pickea por su cápsula real de gameplay
    const editableAsset = ['urban', 'street', 'baseDecor'].includes(piece?.t);
    const assetFootprint = footprint({
      w: (o.w ?? piece?.w ?? 2.2) * (o.scale ?? 1),
      d: (o.d ?? piece?.d ?? 2.2) * (o.scale ?? 1), rot: o.rot ?? 0,
    });
    const fp = piece?.t === 'charRef' ? { w: 0.8, d: 0.8 }
      : editableAsset ? assetFootprint
      : marker ? { w: 1.1, d: 1.1 } : footprint(o);
    const h = piece?.t === 'charRef' ? CHAR_HEAD
      : editableAsset ? (o.h ?? piece?.h ?? 3) * (o.scale ?? 1)
      : marker ? 1.6 : (o.h ?? 1);
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
    this.charRefGroup = new THREE.Group();
    this.overlay.add(this.selBox, this.markerGroup, this.coverGroup, this.navGroup, this.pathGroup, this.charRefGroup);
    this._matSel = new THREE.LineBasicMaterial({ color: 0xffb057 });
    this._matSelFill = new THREE.MeshBasicMaterial({
      color: 0xff8b42, transparent: true, opacity: 0.11, depthWrite: false,
    });
    this._matGizmoX = new THREE.MeshBasicMaterial({ color: 0xe95b52, depthTest: false });
    this._matGizmoZ = new THREE.MeshBasicMaterial({ color: 0x4fa9e8, depthTest: false });
    this._matGizmoTool = new THREE.MeshBasicMaterial({ color: 0xffc45d, depthTest: false });
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
    this._refreshCharRefs();
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
    const selected = this.selected();
    const centers = [];
    for (const o of selected) {
      const b = this.objectBox(o);
      const geo = new THREE.BoxGeometry(b.maxx - b.minx, b.maxy - b.miny, b.maxz - b.minz);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), this._matSel);
      edges.position.set((b.minx + b.maxx) / 2, (b.miny + b.maxy) / 2, (b.minz + b.maxz) / 2);
      const fill = new THREE.Mesh(geo, this._matSelFill);
      fill.position.copy(edges.position);
      this.selBox.add(fill, edges);
      centers.push(edges.position.clone());
    }
    if (!centers.length || this.tool === 'select') return;
    const center = centers.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / centers.length);
    center.y = Math.max(...centers.map((p) => p.y)) + 0.18;
    const size = 1.35;
    if (this.tool === 'rotate') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(size, 0.055, 8, 40), this._matGizmoTool);
      ring.rotation.x = Math.PI / 2;
      ring.position.copy(center);
      ring.renderOrder = 30;
      this.selBox.add(ring);
      return;
    }
    const axis = (x, z, mat) => {
      const length = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x) || 0.055, 0.055, Math.abs(z) || 0.055), mat);
      length.position.set(center.x + x / 2, center.y, center.z + z / 2);
      length.renderOrder = 30;
      const handleGeo = this.tool === 'scale'
        ? new THREE.BoxGeometry(0.22, 0.22, 0.22)
        : new THREE.ConeGeometry(0.13, 0.34, 10);
      const handle = new THREE.Mesh(handleGeo, mat);
      handle.position.set(center.x + x, center.y, center.z + z);
      if (this.tool !== 'scale') {
        handle.rotation.z = z ? 0 : -Math.PI / 2;
        if (z) handle.rotation.x = z > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      handle.renderOrder = 30;
      this.selBox.add(length, handle);
    };
    axis(size, 0, this._matGizmoX);
    axis(0, size, this._matGizmoZ);
  }

  // Personajes de referencia: el Rig REAL del juego (mismas proporciones que
  // en gameplay) + regla de alturas. Viven en el overlay del editor: jamás
  // aparecen en partida y el export los elimina.
  _refreshCharRefs() {
    const wanted = new Map();
    for (const o of this.map.objects) {
      if (paletteById(o.p)?.t === 'charRef') wanted.set(o.id, o);
    }
    for (const [id, entry] of [...this._charRigs]) {
      if (wanted.has(id)) continue;
      entry.rig.dispose(this.charRefGroup);
      this.charRefGroup.remove(entry.ruler);
      this._disposeRuler(entry.ruler);
      this._charRigs.delete(id);
    }
    for (const [id, o] of wanted) {
      let entry = this._charRigs.get(id);
      if (!entry) {
        const rig = new Rig(this.charRefGroup, 'red', null, this._charRigs.size % 5);
        rig.setWeapon('smg');
        const ruler = this._buildRuler();
        this.charRefGroup.add(ruler);
        entry = { rig, ruler };
        this._charRigs.set(id, entry);
      }
      const yaw = (o.rot ?? 0) * DEG;
      entry.rig.setTransform(o.x, o.z, yaw);
      entry.ruler.position.set(o.x, 0, o.z);
      entry.ruler.rotation.y = yaw;
    }
    this.charRefGroup.visible = this.showCharRefs;
  }

  // Regla de escala junto al personaje: las tres alturas de bloque del juego
  // más ojos y coronilla de la cápsula de impactos.
  _buildRuler() {
    const g = new THREE.Group();
    const marks = [
      [BLOCK.LOW, 0x6ce0a0, 'LOW 1.1'],
      [CHAR_EYE, 0x9fc2e8, 'OJOS 1.3'],
      [CHAR_HEAD, 0xffffff, 'CABEZA 1.74'],
      [BLOCK.MID, 0xffd166, 'MID 1.9'],
      [BLOCK.HIGH, 0xe0566c, 'HIGH 3.0'],
    ];
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, BLOCK.HIGH, 0.045),
      new THREE.MeshBasicMaterial({ color: 0x71808d, transparent: true, opacity: 0.85 }),
    );
    post.position.set(0.85, BLOCK.HIGH / 2, 0);
    g.add(post);
    for (const [h, color, text] of marks) {
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.028, 0.028),
        new THREE.MeshBasicMaterial({ color }),
      );
      tick.position.set(0.6, h, 0);
      g.add(tick);
      const label = this._textSprite(text, color);
      label.position.set(1.75, h, 0);
      g.add(label);
    }
    return g;
  }

  _textSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 56;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 30px monospace';
    ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 6, 28);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false,
    }));
    sprite.scale.set(1.7, 0.37, 1);
    return sprite;
  }

  _disposeRuler(ruler) {
    ruler.traverse((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
    });
  }

  toggleCharRefs() {
    this.showCharRefs = !this.showCharRefs;
    this.charRefGroup.visible = this.showCharRefs;
    this.onChange?.();
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
    const spawnIds = this.map.objects.filter((o) => o.p === 'spawnRed' || o.p === 'spawnBlue').map((o) => o.id);
    if (conn === true) report.push({ level: 'ok', key: 'nav', msg: 'Rojo y azul conectados', objectIds: spawnIds, i18nKey: 'editor.validation.nav.ok' });
    else if (conn === false) report.push({ level: 'error', key: 'nav', msg: 'Los spawns NO están conectados', objectIds: spawnIds, i18nKey: 'editor.validation.nav.error' });
    return report;
  }

  playable() { return validationOk(this.validate()); }

  // -------------------------------------------------------------- archivo
  newMap() {
    if (this.map?.id) unstageMap(this.map.id);
    this.clearRecovery();
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
    this.clearRecovery();
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
    this.lastSavedAt = Date.now();
    this.clearRecovery();
    this.setStatus(t('editor.status.saved', { name: this.map.name }));
  }
  saveAs(name) {
    this.map = JSON.parse(JSON.stringify(this.map));
    this.map.id = 'map-' + Math.random().toString(36).slice(2, 8);
    this.map.name = name || (this.map.name + ' COPIA');
    saveMap(this.map);
    this.rebuild();
    this.dirty = false;
    this.lastSavedAt = Date.now();
    this.clearRecovery();
    this.setStatus(t('editor.status.savedAs', { name: this.map.name }));
  }
  duplicate() { const d = duplicateMap(this.map.id); if (d) this.setStatus(t('editor.status.duplicateMap', { name: d.name })); }
  remove(id) { deleteMap(id); this.setStatus(t('editor.status.deleted')); }
  maps() { return listMaps(); }

  // ------------------------------------------------- clonado de mapas reales
  // El original JAMÁS se toca: la radiografía lo reconstruye tal cual y el
  // clon nace como mapa nuevo con id propio. Conserva TODO — cada caja con su
  // color/cover/collider invisible/material, spawns con orientación, munición,
  // especial con altura — y `base` mantiene la decoración original intacta.
  cloneLayout(layout, name = null) {
    const snap = this.world.snapshotLayout(layout);
    if (this.map?.id) unstageMap(this.map.id);
    this.map = mapFromSnapshot(layout, snap, name);
    this.selection.clear();
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.dirty = true;
    this.rebuild();
    this.frameCamera();
    this.setStatus(t('editor.status.cloned', { name: this.map.name, count: snap.boxes.length }));
    return this.map;
  }

  // Decoración del mapa base (fachadas, GLBs, helipuerto). Apagarla deja la
  // geometría jugable desnuda: los colliders invisibles se vuelven visibles.
  setDecor(on) {
    if (!this.map.base) return;
    this.pushUndo('decor');
    if (on) delete this.map.decor; else this.map.decor = false;
    this.rebuild();
  }

  // ------------------------------------------------------- fichero externo
  // El JSON exportado ES el formato del juego (sin charRef). La validación
  // acompaña el export para avisar — nunca bloquea ni destruye cambios.
  exportFile() {
    const report = this.validate();
    const slug = String(this.map.name || 'mapa').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mapa';
    return {
      json: serializeMap(this.map),
      filename: slug + '.breachmap.json',
      report, ok: validationOk(report),
    };
  }

  importFile(text) {
    const parsed = parseMapFile(text);
    if (parsed.error) {
      this.setStatus(t('editor.status.importError', { error: parsed.error }));
      return null;
    }
    if (this.map?.id) unstageMap(this.map.id);
    this.map = parsed.map;
    this.selection.clear();
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.dirty = true;
    this.rebuild();
    this.frameCamera();
    this.setStatus(parsed.unknownPieces
      ? t('editor.status.importedUnknown', { name: this.map.name, count: parsed.unknownPieces })
      : t('editor.status.imported', { name: this.map.name }));
    return parsed;
  }

  // ---------------------------------------------------------------- input
  _bindInput() {
    this._onKey = (e) => {
      if (!this.active) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (e.ctrlKey && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.ctrlKey && k === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
      if (e.ctrlKey && e.shiftKey && k === 's') { e.preventDefault(); this.onSaveAsRequest?.(); return; }
      if (e.ctrlKey && k === 's') { e.preventDefault(); this.save(); return; }
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); (this.onDeleteRequest ?? (() => this.deleteSelection()))(); return; }
      // La salida global del editor consulta handleEscape() antes de cerrar.
      // Aquí solo evitamos que el navegador interprete Esc por su cuenta.
      if (k === 'escape') { e.preventDefault(); return; }
      const arrows = {
        arrowleft: [-1, 0], arrowright: [1, 0],
        arrowup: [0, -1], arrowdown: [0, 1],
      };
      if (arrows[k] && this.selection.size) {
        e.preventDefault();
        // Mantener la tecla repite el movimiento, pero todo el gesto se
        // revierte con un solo Ctrl+Z. Shift permite recorrer 5 pasos.
        if (!e.repeat) this.pushUndo('mover con flechas');
        const step = (this.snapPos || 0.25) * (e.shiftKey ? 5 : 1);
        this.nudgeSelection(arrows[k][0] * step, arrows[k][1] * step);
        return;
      }
      if (k === 'q') this.setTool('select');
      if (k === 'w') this.setTool('move');
      if (k === 'e') this.setTool('rotate');
      if (k === 'r' && !e.ctrlKey) this.setTool('scale');
      if (k === 'f') this.focusSelection();
      if (k === 'g') { this.showGrid = !this.showGrid; this._refreshGrid(); this.onChange?.(); }
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
    this._onBeforeUnload = (e) => {
      if (!this.active || !this.dirty) return;
      this._flushRecovery();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);
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
      const linked = this.linkedSelection(hit);
      if (shift) {
        const remove = linked.every((id) => this.selection.has(id));
        for (const id of linked) {
          if (remove) this.selection.delete(id);
          else this.selection.add(id);
        }
      } else if (!this.selection.has(hit.id)) {
        this.selection = new Set(linked);
      }
      const g = this.groundPoint(nx, ny);
      // Snapshot del estado inicial: rotar/escalar aplican un delta ABSOLUTO
      // desde aquí (un solo undo por gesto y sin deriva acumulada).
      this.drag = {
        kind: 'move', last: g, moved: false, acc: 0,
        before: this.snapshot(), dirtyBefore: this.dirty,
        start: this.selected().map((o) => ({ id: o.id, rot: o.rot ?? 0, w: o.w, d: o.d, scale: o.scale })),
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
        if (!o) continue;
        if (['urban', 'street', 'baseDecor'].includes(paletteById(o.p)?.t)) {
          o.scale = Math.max(0.1, Math.min(8, +((s.scale ?? 1) * f).toFixed(2)));
          continue;
        }
        if (s.w === undefined) continue;
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

  setTool(t) { this.tool = t; this._refreshSelection(); this.onChange?.(); }

  // Cámara de edición: WASD + Espacio/C para subir/bajar, Shift acelera
  update(dt) {
    if (!this.active) return;
    const dir = this._camDir();
    const right = { x: Math.cos(this.cam.yaw), z: -Math.sin(this.cam.yaw) };
    let mx = 0, mz = 0, my = 0;
    if (this.keys.has('KeyW')) mz += 1;
    if (this.keys.has('KeyS')) mz -= 1;
    if (this.keys.has('KeyA')) mx -= 1;
    if (this.keys.has('KeyD')) mx += 1;
    if (this.keys.has('Space')) my += 1;
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
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    clearTimeout(this._recoveryTimer);
    for (const entry of this._charRigs.values()) {
      entry.rig.dispose(this.charRefGroup);
      this._disposeRuler(entry.ruler);
    }
    this._charRigs.clear();
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
