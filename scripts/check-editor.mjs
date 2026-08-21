// Editor de mapas: construir un mapa desde cero por la API del editor,
// validarlo, comprobar que el mundo REAL lo construye (colisión + cover +
// spawns + pickups), hacer playtest y volver sin perder nada.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Users\\iamch\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe';

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8786', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

await page.goto('http://localhost:8786/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });

// 1) abrir el editor desde el menú
await page.evaluate(() => document.getElementById('btn-editor').click());
await page.waitForTimeout(700);
let s = await page.evaluate(() => ({
  mode: window.BREACH.mode,
  ui: document.getElementById('editor-ui')?.classList.contains('on'),
  lib: document.querySelectorAll('#ed-lib [data-piece]').length,
  fullscreen: !!document.fullscreenElement,
  pointerLocked: !!document.pointerLockElement,
}));
check('el editor abre desde el menú', s.mode === 'editor' && s.ui === true, JSON.stringify(s));
check('biblioteca con piezas', s.lib >= 10, `piezas=${s.lib}`);
check('el editor abre windowed y con cursor libre', !s.fullscreen && !s.pointerLocked, JSON.stringify(s));

// 2) construir un mapa completo por la API del editor
const built = await page.evaluate(async () => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  ed.map.name = 'TEST ARENA';
  ed.map.theme = 'metro';
  ed.map.fx = 16; ed.map.fz = 22;
  // cobertura en la mitad roja (luego se refleja)
  ed.brush = 'coverLow'; ed.place(-6, -8); ed.place(0, -6); ed.place(6, -9);
  ed.brush = 'coverMid'; ed.place(-3, -2);
  ed.brush = 'wall'; ed.place(9, -4);
  ed.brush = 'pillar'; ed.place(0, 0);
  // markers
  ed.brush = 'spawnRed';
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ed.place(x, -19);
  ed.brush = 'spawnBlue';
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ed.place(x, 19);
  ed.brush = 'ammo'; ed.place(-11, 0); ed.place(11, 0);
  ed.brush = 'special'; ed.place(5, 0);
  ed.rebuild();
  return { objects: ed.map.objects.length, theme: ed.world.theme, fx: ed.world.fx };
});
check('mapa construido por la API', built.objects === 17, JSON.stringify(built));
check('el mundo adopta tema y dimensiones', built.theme === 'metro' && built.fx === 16,
  JSON.stringify(built));

// 3) el mundo REAL tiene la geometría: colisión y cover generados
const worldState = await page.evaluate(() => {
  const W = window.BREACH_WORLD;
  const probe = { x: 0, z: 0 };
  W.resolveCircle(probe, 0.38, 0);
  return {
    colliders: W.colliders.length,
    faces: W.faces.length,
    pillarSolid: Math.hypot(probe.x, probe.z) > 0.05, // el pilar empuja
    crates: W.cratePos?.length ?? 0,
    special: W.specialSpot,
    spawnsRed: W.spawns.red.length, spawnsBlue: W.spawns.blue.length,
  };
});
check('la geometría genera colisión real', worldState.pillarSolid && worldState.colliders > 6,
  JSON.stringify(worldState));
check('genera caras de cover', worldState.faces > 20, `faces=${worldState.faces}`);
check('pickups y especial llegan al mundo',
  worldState.crates === 2 && worldState.special?.x === 5, JSON.stringify(worldState));
check('4 spawns por equipo desde los marcadores',
  worldState.spawnsRed === 4 && worldState.spawnsBlue === 4, JSON.stringify(worldState));

// 4) validación: debe reportar JUGABLE y detectar conexión entre spawns
const valid = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const report = ed.validate();
  return {
    playable: ed.playable(),
    errors: report.filter((r) => r.level === 'error').map((r) => r.msg),
    nav: report.find((r) => r.key === 'nav')?.level,
    connected: ed.spawnsConnected(),
  };
});
check('el mapa valida como JUGABLE', valid.playable === true, JSON.stringify(valid));
check('spawns conectados (ruta real)', valid.connected === true && valid.nav === 'ok',
  JSON.stringify(valid));

// 5) validación detecta un mapa roto: pickup dentro de un muro
const broken = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.brush = 'ammo';
  ed.place(9, -4); // encima de la pared colocada antes
  const report = ed.validate();
  const bad = report.filter((r) => r.level === 'error').map((r) => r.key);
  ed.undo(); // deshacer para seguir con el mapa bueno
  return { bad, playableAfterUndo: ed.playable() };
});
check('detecta pickup dentro de geometría', broken.bad.includes('pickupClear'),
  JSON.stringify(broken));
check('undo restaura el mapa jugable', broken.playableAfterUndo === true, JSON.stringify(broken));

// 6) herramientas: espejo, duplicar, mover, borrar, undo/redo
const tools = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const before = ed.map.objects.length;
  // espejo de TODO (sin selección): duplica el mapa reflejado en Z
  ed.mirror('z');
  const mirrored = ed.map.objects.length;
  const reds = ed.map.objects.filter((o) => o.p === 'spawnRed').length;
  const blues = ed.map.objects.filter((o) => o.p === 'spawnBlue').length;
  ed.undo();
  const afterUndo = ed.map.objects.length;
  // duplicar una selección
  const first = ed.map.objects.find((o) => o.p === 'coverLow');
  ed.selection = new Set([first.id]);
  ed.duplicateSelection();
  const dup = ed.map.objects.length;
  // mover la copia y comprobar snapping
  const copy = ed.selected()[0];
  ed.snapPos = 1;
  ed.moveSelection(0.4, 0.4);
  const snapped = Number.isInteger(copy.x) && Number.isInteger(copy.z);
  ed.deleteSelection();
  const afterDelete = ed.map.objects.length;
  ed.redo();
  return { before, mirrored, reds, blues, afterUndo, dup, snapped, afterDelete };
});
check('espejo Z duplica el mapa', tools.mirrored === tools.before * 2, JSON.stringify(tools));
check('el espejo cambia el bando de los spawns', tools.reds === tools.blues,
  JSON.stringify(tools));
check('undo revierte el espejo', tools.afterUndo === tools.before, JSON.stringify(tools));
check('duplicar y borrar selección', tools.dup === tools.before + 1 && tools.afterDelete === tools.before,
  JSON.stringify(tools));
check('el movimiento respeta el snap', tools.snapped === true, JSON.stringify(tools));

// 7) rotación de geometría jugable: pasos de 90° que intercambian W/D
const rot = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const o = ed.map.objects.find((x) => x.p === 'coverLow');
  ed.selection = new Set([o.id]);
  const w0 = o.w, d0 = o.d;
  ed.rotateSelection(90);
  const fp = window.BREACH_MAPDATA.footprint(o);
  return { rot: o.rot, w0, d0, fpw: fp.w, fpd: fp.d };
});
check('rotar 90° intercambia el footprint AABB',
  rot.rot === 90 && rot.fpw === rot.d0 && rot.fpd === rot.w0, JSON.stringify(rot));

// 8) navegación: grid y ruta A→B, y detección de zona inaccesible
const nav = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const g = ed.navGrid();
  const walkable = g.cells.reduce((a, b) => a + b, 0);
  const route = ed.findPath({ x: 0, z: -19 }, { x: 0, z: 19 });
  // encerrar una zona con paredes y comprobar que NO hay ruta
  ed.brush = 'wall';
  const before = ed.map.objects.length;
  for (const [x, z, r] of [[13, 13, 0], [13, 17, 0], [10, 15, 90], [16, 15, 90]]) {
    ed.place(x, z);
    const last = ed.map.objects[ed.map.objects.length - 1];
    last.rot = r; last.w = 4.2; last.d = 1.2;
  }
  ed.rebuild();
  const walled = ed.findPath({ x: 0, z: -19 }, { x: 13, z: 15 });
  ed.map.objects.length = before;
  ed.rebuild();
  return { walkable, total: g.cells.length, route: route?.length ?? 0, walled: walled?.length ?? 0 };
});
check('grid de navegación con zona transitable', nav.walkable > nav.total * 0.4,
  JSON.stringify(nav));
check('ruta A→B entre spawns', nav.route > 4, JSON.stringify(nav));
check('detecta zona encerrada (sin ruta)', nav.walled === 0, JSON.stringify(nav));

// 9) overlays de cover y navegación
const overlays = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.showCover = true; ed._refreshCover();
  ed.showNav = true; ed._refreshNav();
  const cover = ed.coverGroup.children.length, navCells = ed.navGroup.children.length;
  ed.showCover = false; ed._refreshCover();
  ed.showNav = false; ed._refreshNav();
  return { cover, navCells, afterCover: ed.coverGroup.visible };
});
check('overlay de cover dibuja las caras reales', overlays.cover > 20, JSON.stringify(overlays));
check('overlay de navegación usa instancing (máximo dos draw calls)',
  overlays.navCells > 0 && overlays.navCells <= 2, JSON.stringify(overlays));

// 10) guardar / cargar / duplicar
const files = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.save();
  const id = ed.map.id, n = ed.map.objects.length;
  ed.duplicate();
  const list = ed.maps();
  ed.newMap();
  const emptied = ed.map.objects.length;
  ed.load(id);
  return { saved: list.length, emptied, restored: ed.map.objects.length, same: ed.map.id === id, n };
});
check('guardar, duplicar y listar mapas', files.saved >= 2, JSON.stringify(files));
check('cargar restaura el mapa exacto',
  files.same && files.restored === files.n && files.emptied === 0, JSON.stringify(files));

// 11) PLAYTEST: entrar a jugar el mapa y volver al editor intacto
await page.evaluate(() => window.BREACH_EDITOR_PLAYTEST());
await page.waitForTimeout(1800);
const play = await page.evaluate(() => ({
  mode: window.BREACH.mode,
  layout: window.BREACH_WORLD.layout,
  custom: !!window.BREACH_WORLD.customMap,
  playerOnMap: !!window.BREACH.player,
  editorUI: document.getElementById('editor-ui').classList.contains('on'),
  fullscreen: !!document.fullscreenElement,
}));
check('playtest arranca en el mapa editado',
  play.mode === 'practice' && play.custom === true && play.playerOnMap, JSON.stringify(play));
check('la UI del editor se oculta durante el playtest', play.editorUI === false,
  JSON.stringify(play));
check('el playtest del editor no fuerza fullscreen', play.fullscreen === false,
  JSON.stringify(play));

await page.keyboard.press('Escape');
await page.waitForTimeout(900);
const back = await page.evaluate(() => ({
  mode: window.BREACH.mode,
  ui: document.getElementById('editor-ui').classList.contains('on'),
  objects: window.BREACH_EDITOR.map.objects.length,
  name: window.BREACH_EDITOR.map.name,
  fullscreen: !!document.fullscreenElement,
  pointerLocked: !!document.pointerLockElement,
}));
check('Esc vuelve al editor', back.mode === 'editor' && back.ui === true, JSON.stringify(back));
check('el mapa sigue intacto al volver',
  back.objects === files.n && back.name === 'TEST ARENA', JSON.stringify(back));
check('volver del playtest restaura cursor libre y modo windowed',
  !back.fullscreen && !back.pointerLocked, JSON.stringify(back));

// 12) el mapa aparece como jugable para el juego (mismo formato)
const playable = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const layout = window.BREACH_MAPDATA.mapLayoutId(ed.map);
  window.BREACH_WORLD.setLayout(layout);
  const W = window.BREACH_WORLD;
  return {
    layout, custom: !!W.customMap, faces: W.faces.length,
    spawns: W.spawns.red.length + W.spawns.blue.length,
  };
});
check('el juego carga el mapa del editor por su id',
  playable.custom && playable.faces > 20 && playable.spawns === 8, JSON.stringify(playable));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nEDITOR: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nEDITOR: todo verde');
