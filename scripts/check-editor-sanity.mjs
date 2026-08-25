// Sanity AGRESIVO del editor de mapas: casos límite que la suite básica no
// cubre — persistencia entre recargas, mapas rotos/vacíos, props que NO
// deben colisionar, ciclos repetidos de playtest, fugas de escena en
// rebuilds, partida con BOTS sobre un mapa creado, y rendimiento.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8782', '--strictPort'], { stdio: 'ignore' });
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
const openEditor = async () => {
  await page.evaluate(() => document.getElementById('btn-enter')?.click());
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.evaluate(() => document.getElementById('btn-editor').click());
  await page.waitForTimeout(500);
};

await page.goto('http://localhost:8782/?nolock=1', { waitUntil: 'networkidle' });
await openEditor();

// -------------------------------------- 0. interacción REAL de mouse
// Las herramientas se probaron antes por API y parecían correctas mientras
// los botones ROTAR/ESCALAR no hacían nada al arrastrar. Aquí se usan
// eventos de mouse auténticos.
await page.evaluate(() => { const ed = window.BREACH_EDITOR; ed.newMap(); ed.topView(); ed.brush = 'coverLow'; });
await page.waitForTimeout(300);
const screenOf = () => page.evaluate(() => {
  const ed = window.BREACH_EDITOR, T = window.THREE;
  const o = ed.map.objects[0];
  const v = new T.Vector3(o.x, (o.h ?? 1) / 2, o.z).project(ed.camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
});
await page.keyboard.down('Alt');
await page.mouse.click(700, 400);
await page.keyboard.up('Alt');
await page.waitForTimeout(250);
const mousePlace = await page.evaluate(() => window.BREACH_EDITOR.map.objects.length);
check('ALT+CLIC coloca una pieza', mousePlace === 1, `objetos=${mousePlace}`);

await page.evaluate(() => window.BREACH_EDITOR.selection.clear());
let pt = await screenOf();
await page.mouse.click(pt.x, pt.y);
await page.waitForTimeout(200);
check('CLIC selecciona la pieza',
  (await page.evaluate(() => window.BREACH_EDITOR.selection.size)) === 1);

await page.evaluate(() => window.BREACH_EDITOR.setTool('move'));
const mv0 = await page.evaluate(() => ({ ...window.BREACH_EDITOR.map.objects[0] }));
pt = await screenOf();
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
await page.mouse.move(pt.x + 90, pt.y + 70, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const mv1 = await page.evaluate(() => ({ ...window.BREACH_EDITOR.map.objects[0] }));
check('arrastrar con MOVER desplaza la pieza',
  mv1.x !== mv0.x || mv1.z !== mv0.z, JSON.stringify({ from: [mv0.x, mv0.z], to: [mv1.x, mv1.z] }));

await page.evaluate(() => window.BREACH_EDITOR.setTool('scale'));
const sc0 = await page.evaluate(() => window.BREACH_EDITOR.map.objects[0].w);
pt = await screenOf();
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
await page.mouse.move(pt.x + 120, pt.y + 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const sc1 = await page.evaluate(() => window.BREACH_EDITOR.map.objects[0].w);
check('arrastrar con ESCALAR cambia el tamaño', sc1 > sc0, `w ${sc0} → ${sc1}`);

await page.evaluate(() => window.BREACH_EDITOR.setTool('rotate'));
const rt0 = await page.evaluate(() => window.BREACH_EDITOR.map.objects[0].rot);
pt = await screenOf();
await page.mouse.move(pt.x, pt.y);
await page.mouse.down();
await page.mouse.move(pt.x + 260, pt.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(250);
const rt1 = await page.evaluate(() => window.BREACH_EDITOR.map.objects[0].rot);
check('arrastrar con ROTAR gira en pasos de 90°',
  rt1 !== rt0 && rt1 % 90 === 0, `rot ${rt0} → ${rt1}`);

const zoom = await page.evaluate(() => window.BREACH_EDITOR.cam.y);
await page.mouse.move(700, 400);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(200);
const zoom2 = await page.evaluate(() => window.BREACH_EDITOR.cam.y);
check('la rueda hace zoom perceptible', zoom - zoom2 > 5, `y ${zoom.toFixed(1)} → ${zoom2.toFixed(1)}`);
await page.evaluate(() => window.BREACH_EDITOR.setTool('select'));

// ---------------------------------------------------------------- 1. vacíos
const empty = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  const W = window.BREACH_WORLD;
  const report = ed.validate();
  return {
    objects: ed.map.objects.length,
    colliders: W.colliders.length,          // solo el perímetro
    spawnsRed: W.spawns.red.length,          // fallback por defecto
    playable: ed.playable(),
    errors: report.filter((r) => r.level === 'error').length,
  };
});
check('mapa vacío no rompe el mundo (perímetro + spawns de respaldo)',
  empty.colliders === 4 && empty.spawnsRed === 4, JSON.stringify(empty));
check('mapa vacío se marca NO jugable', empty.playable === false && empty.errors >= 2,
  JSON.stringify(empty));

// ------------------------------------------------- 2. props NO colisionan
const props = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD;
  ed.brush = 'tank'; ed.place(0, 0);
  ed.brush = 'vehicle'; ed.place(4, 0);
  const before = W.colliders.length;
  const p = { x: 0, z: 0 };
  W.resolveCircle(p, 0.38, 0);
  const pushed = Math.hypot(p.x, p.z) > 0.02;
  ed.brush = 'pillar'; ed.place(-6, 0);
  const q = { x: -6, z: 0 };
  W.resolveCircle(q, 0.38, 0);
  const pillarPushes = Math.hypot(q.x + 6, q.z) > 0.02;
  return { before, colliders: W.colliders.length, pushed, pillarPushes };
});
check('los props decorativos NO colisionan', props.pushed === false && props.before === 4,
  JSON.stringify(props));
check('la geometría jugable SÍ colisiona', props.pillarPushes === true, JSON.stringify(props));

// ----------------------------------------- 3. objetos fuera de los límites
const oob = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.brush = 'coverLow';
  ed.place(ed.map.fx + 8, 0);
  const report = ed.validate();
  const bad = report.find((r) => r.key === 'bounds');
  ed.undo();
  return { level: bad?.level, msg: bad?.msg, afterUndo: ed.validate().find((r) => r.key === 'bounds')?.level };
});
check('detecta objetos fuera de los límites', oob.level === 'error', JSON.stringify(oob));
check('undo limpia el error de límites', oob.afterUndo === 'ok', JSON.stringify(oob));

const footprintBounds = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.brush = 'wall';
  ed.place(ed.map.fx - 1, 0);
  const wall = ed.selected()[0];
  wall.w = 10;
  ed.rebuild();
  const bounds = ed.validate().find((r) => r.key === 'bounds');
  ed.undo();
  return { level: bounds?.level, x: wall.x, w: wall.w, fx: ed.map.fx };
});
check('los límites consideran el volumen completo, no solo el centro',
  footprintBounds.level === 'error', JSON.stringify(footprintBounds));

// ------------------------------------------- 4. sin fugas al reconstruir
const leak = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, S = window.BREACH_WORLD.scene ?? null;
  const scene = window.BREACH_EDITOR.scene;
  const count = () => { let n = 0; scene.traverse(() => n++); return n; };
  ed.brush = 'coverLow'; ed.place(2, 2);
  const base = count();
  for (let i = 0; i < 25; i++) ed.rebuild();
  const after = count();
  return { base, after, delta: after - base };
});
check('rebuild repetido no acumula objetos en la escena', Math.abs(leak.delta) <= 2,
  JSON.stringify(leak));

// -------------------------------------------------- 5. undo/redo profundo
const history = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  ed.brush = 'coverLow';
  for (let i = 0; i < 30; i++) ed.place(-10 + i * 0.5, -5);
  const placed = ed.map.objects.length;
  for (let i = 0; i < 30; i++) ed.undo();
  const undone = ed.map.objects.length;
  for (let i = 0; i < 30; i++) ed.redo();
  const redone = ed.map.objects.length;
  return { placed, undone, redone, stack: ed.undoStack.length };
});
check('undo/redo profundo (30 pasos) es reversible',
  history.placed === 30 && history.undone === 0 && history.redone === 30,
  JSON.stringify(history));

const fullHistory = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  const original = ed.map.theme;
  ed.pushUndo('theme');
  ed.map.theme = 'metro';
  ed.rebuild();
  ed.undo();
  return { original, afterUndo: ed.map.theme };
});
check('undo restaura propiedades completas del mapa, incluido el tema',
  fullHistory.afterUndo === fullHistory.original, JSON.stringify(fullHistory));

const draftOnly = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  const id = ed.map.id;
  ed.map.name = 'BORRADOR NO GUARDADO';
  ed.brush = 'coverLow'; ed.place(0, 0);
  return { id, listed: ed.maps().some((m) => m.id === id), dirty: ed.dirty };
});
check('un borrador no aparece como mapa guardado',
  draftOnly.dirty && !draftOnly.listed, JSON.stringify(draftOnly));

// -------------------------------------- 6. persistencia entre RECARGAS
const saved = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  ed.map.name = 'PERSISTENTE';
  ed.map.theme = 'prision';
  ed.brush = 'coverMid'; ed.place(3, 3);
  ed.brush = 'spawnRed';
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ed.place(x, -18);
  ed.brush = 'spawnBlue';
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ed.place(x, 18);
  ed.save();
  return { id: ed.map.id, objects: ed.map.objects.length };
});
await page.reload({ waitUntil: 'networkidle' });
await openEditor();
const afterReload = await page.evaluate((id) => {
  const ed = window.BREACH_EDITOR;
  const list = ed.maps().map((m) => m.id);
  ed.load(id);
  return {
    listed: list.includes(id), name: ed.map.name, theme: ed.map.theme,
    objects: ed.map.objects.length, worldTheme: window.BREACH_WORLD.theme,
  };
}, saved.id);
check('los mapas sobreviven a una recarga completa',
  afterReload.listed && afterReload.name === 'PERSISTENTE' &&
  afterReload.objects === saved.objects, JSON.stringify(afterReload));
check('el tema se restaura en el mundo', afterReload.worldTheme === 'prision',
  JSON.stringify(afterReload));

// ------------------------------------------ 7. spawn: orientación real
const spawnYaw = await page.evaluate(async () => {
  const ed = window.BREACH_EDITOR;
  const red = ed.map.objects.find((o) => o.p === 'spawnRed');
  ed.selection = new Set([red.id]);
  ed.setField('rot', 90);
  ed.rebuild();
  const W = window.BREACH_WORLD;
  return { yawObj: +red.yaw.toFixed(3), yawWorld: +W.spawns.red[0].yaw.toFixed(3) };
});
check('la rotación del spawn llega al mundo',
  Math.abs(spawnYaw.yawObj - spawnYaw.yawWorld) < 0.01 && spawnYaw.yawWorld > 1.5,
  JSON.stringify(spawnYaw));

// ------------------------------------- 8. ciclo repetido de playtest
let cycleOk = true, cycleInfo = [];
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.BREACH_EDITOR_PLAYTEST());
  await page.waitForTimeout(1200);
  const inGame = await page.evaluate(() => ({
    mode: window.BREACH.mode, custom: !!window.BREACH_WORLD.customMap,
  }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const back = await page.evaluate(() => ({
    mode: window.BREACH.mode,
    ui: document.getElementById('editor-ui').classList.contains('on'),
    objects: window.BREACH_EDITOR.map.objects.length,
    overlay: window.BREACH_EDITOR.overlay.parent !== null,
  }));
  cycleInfo.push({ i, inGame, back });
  if (inGame.mode !== 'practice' || back.mode !== 'editor' || !back.ui || !back.overlay) cycleOk = false;
}
check('3 ciclos editor→playtest→editor sin degradarse', cycleOk, JSON.stringify(cycleInfo.at(-1)));

// -------------------------- 9. partida con BOTS sobre el mapa del editor
const botGame = await page.evaluate(async () => {
  const ed = window.BREACH_EDITOR;
  // mapa mínimo pero jugable
  ed.newMap();
  ed.map.name = 'BOT ARENA'; ed.map.fx = 18; ed.map.fz = 24;
  ed.brush = 'coverLow';
  for (const [x, z] of [[-6, -8], [6, -8], [0, -3], [-6, 8], [6, 8], [0, 3]]) ed.place(x, z);
  ed.brush = 'spawnRed';
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ed.place(x, -20);
  ed.brush = 'spawnBlue';
  for (const x of [-4.5, -1.5, 1.5, 4.5]) ed.place(x, 20);
  ed.brush = 'ammo'; ed.place(-10, 0); ed.place(10, 0);
  ed.brush = 'special'; ed.place(6, 0);
  ed.save();
  window.BREACH.mapChoice = window.BREACH_MAPDATA.mapLayoutId(ed.map);
  return { id: ed.map.id, playable: ed.playable() };
});
check('el mapa de prueba es jugable', botGame.playable === true, JSON.stringify(botGame));

await page.evaluate(() => document.getElementById('ed-exit').click());
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById('btn-bots').click());
await page.waitForTimeout(600);
const lobbyMap = await page.evaluate(() => {
  const sel = document.querySelector('[data-setting="map"]');
  return {
    value: sel?.value,
    hasCustom: [...(sel?.options ?? [])].some((o) => o.value.startsWith('custom:')),
    label: [...(sel?.options ?? [])].find((o) => o.value.startsWith('custom:'))?.textContent,
  };
});
check('el mapa del editor aparece en el lobby local',
  lobbyMap.hasCustom && lobbyMap.value?.startsWith('custom:'), JSON.stringify(lobbyMap));

await page.evaluate(() => document.getElementById('btn-lobby-start').click());
await page.waitForFunction(
  () => window.BREACH.botMatch && !window.BREACH.botMatch.controlsLocked(),
  null, { timeout: 30000 },
);
await page.waitForTimeout(4000);
const play = await page.evaluate(() => {
  const M = window.BREACH.botMatch, W = window.BREACH_WORLD;
  return {
    custom: !!W.customMap, bots: M.bots.length,
    alive: M.bots.filter((b) => b.alive).length,
    moved: M.bots.filter((b) => Math.hypot(b.pos.x, b.pos.z) > 1).length,
    inBounds: M.bots.every((b) => Math.abs(b.pos.x) <= W.fx + 1 && Math.abs(b.pos.z) <= W.fz + 1),
    crates: window.BREACH.crates?.crates?.length ?? 0,
    special: window.BREACH_SPECIALS.active?.wep ?? null,
    markersInGame: document.getElementById('editor-ui').classList.contains('on'),
  };
});
check('partida con bots corre en el mapa creado',
  play.custom && play.bots === 7 && play.alive > 0, JSON.stringify(play));
check('los bots se mueven y no salen del mapa', play.moved >= 5 && play.inBounds,
  JSON.stringify(play));
check('cajas y pedestal del editor funcionan en partida',
  play.crates === 2 && play.special === 'sniper', JSON.stringify(play));
check('la UI del editor no aparece en partida', play.markersInGame === false,
  JSON.stringify(play));

// ------------------------------------------------------ 10. rendimiento
await page.evaluate(() => { window.BREACH.editorReturn = null; });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.evaluate(() => {
  const b = document.getElementById('btn-leave-match');
  if (b && b.offsetParent !== null) b.click();
});
await page.waitForTimeout(600);
await page.evaluate(() => document.getElementById('btn-editor').click());
await page.waitForTimeout(500);
const perf = await page.evaluate(async () => {
  const ed = window.BREACH_EDITOR;
  ed.newMap();
  ed.map.fx = 30; ed.map.fz = 36;
  ed.brush = 'coverLow';
  const t0 = performance.now();
  for (let i = 0; i < 150; i++) {
    // colocar SIN reconstruir cada vez (medimos el rebuild aparte)
    const o = window.BREACH_MAPDATA_MAKE
      ? null : null;
    ed.map.objects.push({ id: 'p' + i, p: 'coverLow', x: -25 + (i % 20) * 2.5, z: -30 + Math.floor(i / 20) * 8, rot: 0, w: 2.6, d: 0.9, h: 1.1 });
  }
  const tPlace = performance.now() - t0;
  const t1 = performance.now();
  ed.rebuild();
  const tRebuild = performance.now() - t1;
  const t2 = performance.now();
  const grid = ed.navGrid();
  const tNav = performance.now() - t2;
  const t3 = performance.now();
  const route = ed.findPath({ x: -25, z: -30 }, { x: 25, z: 30 });
  const tPath = performance.now() - t3;
  return {
    objects: ed.map.objects.length,
    tRebuild: +tRebuild.toFixed(1), tNav: +tNav.toFixed(1), tPath: +tPath.toFixed(1),
    cells: grid.cells.length, route: route?.length ?? 0,
    faces: window.BREACH_WORLD.faces.length,
  };
});
console.log('PERF:', JSON.stringify(perf));
check('rebuild de 150 objetos por debajo de 250ms', perf.tRebuild < 250, `${perf.tRebuild}ms`);
check('navGrid + ruta por debajo de 400ms', perf.tNav + perf.tPath < 400,
  `nav=${perf.tNav}ms path=${perf.tPath}ms`);
check('el mapa grande genera cover', perf.faces > 300, `faces=${perf.faces}`);

// ------------------------------------------- 11. borrar mapa (sin prompt)
const del = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const before = ed.maps().length;
  const dup = ed.maps()[0];
  ed.remove(dup.id);
  const after = ed.maps().length;
  return { before, after, removed: dup.id, stillThere: ed.maps().some((m) => m.id === dup.id) };
});
check('borrar un mapa lo quita del almacén',
  del.after === del.before - 1 && !del.stillThere, JSON.stringify(del));

// ----------------------------------------------- 12. salida limpia
await page.evaluate(() => document.getElementById('ed-exit').click());
await page.waitForTimeout(500);
const exited = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  return {
    mode: window.BREACH.mode,
    ui: document.getElementById('editor-ui').classList.contains('on'),
    overlayInScene: ed.overlay.parent !== null,
    menuVisible: !document.getElementById('menu').classList.contains('off'),
  };
});
check('salir del editor deja el menú limpio',
  exited.mode === null && !exited.ui && !exited.overlayInScene && exited.menuVisible,
  JSON.stringify(exited));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

await browser.close();
server.kill();
await clearClip();
if (fails.length) {
  console.log(`\nEDITOR-SANITY: ${fails.length} fallos → ${fails.join(' | ')}`);
  process.exit(1);
}
console.log('\nEDITOR-SANITY: todo verde');
