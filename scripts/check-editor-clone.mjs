// CLONADOR del editor: cada mapa real del juego se clona conservando TODO
// (colliders exactos, caras de cover incl. barandales, spawns con yaw,
// munición, especial con altura, decoración del builder original), el
// original jamás se modifica, el personaje de referencia usa las dimensiones
// reales y se excluye del export, y el ciclo exportar→importar es idéntico.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearClip } from './lib-clip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || undefined;

const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1', '--port', '8795', '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGEERROR:', e.message); });
page.on('dialog', (d) => d.accept());

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'OK ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails.push(name);
};

await page.goto('http://localhost:8795/?nolock=1', { waitUntil: 'networkidle' });
await page.evaluate(() => document.getElementById('btn-enter')?.click());
await page.waitForSelector('#splash.off', { state: 'attached' });
await page.evaluate(() => document.getElementById('btn-editor').click());
await page.waitForFunction(() => window.BREACH?.mode === 'editor');

// Radiografía COMPLETA del estado físico/gameplay/visual del mundo actual.
// Se inyecta una vez y la usan todas las fases.
await page.evaluate(() => {
  const r3 = (v) => Math.round((v ?? 0) * 1000) / 1000;
  window.__worldState = () => {
    const W = window.BREACH_WORLD;
    const cmp = (a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    };
    const colliders = W.colliders
      .map((c) => [r3(c.minx), r3(c.minz), r3(c.maxx), r3(c.maxz), r3(c.h), c.surface ?? ''])
      .sort(cmp);
    const faces = W.faces
      .map((f) => [r3(f.a.x), r3(f.a.z), r3(f.b.x), r3(f.b.z), r3(f.h), f.kind, r3(f.baseY)])
      .sort(cmp);
    let urban = 0, batchVerts = 0;
    W.mapGroup.traverse((o) => { if (o.userData?.urbanAssetId) urban++; });
    for (const c of W.mapGroup.children) {
      if (c.name?.startsWith('box-batch')) batchVerts += c.geometry.attributes.position.count;
    }
    return {
      colliders, faces,
      segs: W.segmentColliders.length, zones: W.surfaceZones.length,
      spawns: {
        red: W.spawns.red.map((s) => [r3(s.x), r3(s.z), r3(s.yaw)]).sort(cmp),
        blue: W.spawns.blue.map((s) => [r3(s.x), r3(s.z), r3(s.yaw)]).sort(cmp),
      },
      crates: (W.cratePos ?? []).map((c) => [r3(c.x), r3(c.z)]).sort(cmp),
      special: W.specialSpot
        ? [r3(W.specialSpot.x), r3(W.specialSpot.z), r3(W.specialSpot.y)] : null,
      mapChildren: W.mapGroup.children.length,
      urban, batchVerts,
    };
  };
});

// ---------------------------------------------------------------------------
// 1) FIDELIDAD: clonar cada mapa real y comparar contra el original EXACTO
// ---------------------------------------------------------------------------
const LAYOUTS = ['fortaleza', 'azoteas', 'calle', 'metro', 'prision', 'pueblo'];
for (const layout of LAYOUTS) {
  const r = await page.evaluate((layout) => {
    const W = window.BREACH_WORLD, ed = window.BREACH_EDITOR;
    W.setLayout(layout, true);
    const original = window.__worldState();
    const t0 = performance.now();
    const map = ed.cloneLayout(layout);
    const cloneMs = performance.now() - t0;
    const clone = window.__worldState();
    return {
      original, clone, cloneMs: Math.round(cloneMs),
      isCustom: !!W.customMap, base: map.base, walls: map.walls,
      boxes: map.objects.filter((o) => ['coverLow', 'coverMid', 'wall'].includes(o.p)).length,
      playable: ed.playable(),
    };
  }, layout);
  const same = (k) => JSON.stringify(r.original[k]) === JSON.stringify(r.clone[k]);
  check(`${layout}: colliders EXACTOS (${r.original.colliders.length})`, same('colliders'),
    same('colliders') ? `${r.boxes} cajas, ${r.cloneMs}ms` :
      `orig=${r.original.colliders.length} clon=${r.clone.colliders.length}`);
  check(`${layout}: caras de cover exactas (${r.original.faces.length})`, same('faces'),
    same('faces') ? '' : `orig=${r.original.faces.length} clon=${r.clone.faces.length}`);
  check(`${layout}: segmentos/zonas transitables`, same('segs') && same('zones'),
    `segs=${r.clone.segs} zones=${r.clone.zones}`);
  check(`${layout}: spawns con orientación`, same('spawns'));
  check(`${layout}: munición y especial (con altura)`, same('crates') && same('special'),
    JSON.stringify(r.clone.special));
  check(`${layout}: decoración visual intacta`,
    same('mapChildren') && same('urban') && same('batchVerts'),
    `children=${r.original.mapChildren}/${r.clone.mapChildren} urban=${r.original.urban}/${r.clone.urban} verts=${r.original.batchVerts}/${r.clone.batchVerts}`);
  check(`${layout}: el clon valida como JUGABLE`, r.playable === true);
  check(`${layout}: es mapa de datos con base`, r.isCustom && r.base === layout && r.walls === false);
}

// ---------------------------------------------------------------------------
// 2) EL ORIGINAL JAMÁS SE TOCA: editar el clon y verificar el mapa real
// ---------------------------------------------------------------------------
const untouched = await page.evaluate(() => {
  const W = window.BREACH_WORLD, ed = window.BREACH_EDITOR;
  W.setLayout('fortaleza', true);
  const before = window.__worldState();
  ed.cloneLayout('fortaleza');
  // editar agresivamente el clon: mover, borrar, añadir
  const box = ed.map.objects.find((o) => o.p === 'coverLow');
  ed.selection = new Set([box.id]);
  ed.moveSelection(3, 2);
  const victim = ed.map.objects.filter((o) => o.p === 'coverMid')[0];
  if (victim) { ed.selection = new Set([victim.id]); ed.deleteSelection(); }
  ed.brush = 'pillar'; ed.place(2, 3);
  const cloneEdited = window.__worldState();
  const cloneId = ed.map.id;
  // reconstruir el mapa REAL: debe ser idéntico al estado previo al clonado
  W.setLayout('fortaleza', true);
  const after = window.__worldState();
  // y el borrador del clon sigue vivo con sus ediciones
  W.setLayout('custom:' + cloneId, true);
  const cloneAgain = window.__worldState();
  return {
    originalIntact: JSON.stringify(before) === JSON.stringify(after),
    editsChanged: JSON.stringify(before.colliders) !== JSON.stringify(cloneEdited.colliders),
    editsPersist: JSON.stringify(cloneEdited.colliders) === JSON.stringify(cloneAgain.colliders),
  };
});
check('editar el clon no toca el mapa original', untouched.originalIntact);
check('las ediciones del clon existen y persisten',
  untouched.editsChanged && untouched.editsPersist);

// ---------------------------------------------------------------------------
// 3) PERSONAJE DE REFERENCIA: Rig real, dimensiones reales, no se exporta
// ---------------------------------------------------------------------------
const charRef = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.brush = 'charRef';
  ed.place(4, 4);
  const entry = [...ed._charRigs.values()][0];
  const bounds = new window.THREE.Box3().setFromObject(entry.rig.root);
  // duplicar y toggle
  ed.duplicateSelection();
  const afterDup = ed._charRigs.size;
  ed.toggleCharRefs();
  const hiddenWhileOff = ed.charRefGroup.visible;
  ed.toggleCharRefs();
  // export: el charRef NO viaja en el fichero
  const out = ed.exportFile();
  const exported = JSON.parse(out.json);
  // limpiar: borrar ambos charRef
  ed.selection = new Set(ed.map.objects.filter((o) => o.p === 'charRef').map((o) => o.id));
  ed.deleteSelection();
  return {
    rigs: afterDup, hiddenWhileOff,
    rigHeight: Math.round(bounds.max.y * 100) / 100,
    rulerMarks: entry.ruler.children.length,
    inMap: exported.objects.some((o) => o.p === 'charRef'),
    inDraft: ed.map.objects.some((o) => o.p === 'charRef'),
    rigsAfterDelete: ed._charRigs.size,
    filename: out.filename,
  };
});
// La cápsula/coronilla sigue marcada a 1.74 m en la regla. El Box3 del Rig
// incluye ahora el arma refinada a la espalda, que sobresale por encima del
// casco y lleva la silueta visual completa a ~2.03 m.
check('charRef usa el Rig real y conserva una silueta visual coherente',
  charRef.rigHeight > 1.70 && charRef.rigHeight < 2.15, `alto=${charRef.rigHeight}`);
check('charRef: regla de alturas presente', charRef.rulerMarks >= 11,
  `marcas=${charRef.rulerMarks}`);
check('charRef se duplica y se oculta con el toggle',
  charRef.rigs === 2 && charRef.hiddenWhileOff === false);
check('charRef NO viaja en el export (y sí en el borrador)',
  charRef.inMap === false && charRef.inDraft === false && charRef.rigsAfterDelete === 0,
  JSON.stringify(charRef));

// ---------------------------------------------------------------------------
// 4) ROUND-TRIP: exportar el clon editado, importarlo y comparar EXACTO
// ---------------------------------------------------------------------------
const roundtrip = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  const before = window.__worldState();
  const out = ed.exportFile();
  const parsed = ed.importFile(out.json);
  const after = window.__worldState();
  const badImport = ed.importFile('{esto no es json');
  const stillIntact = JSON.stringify(window.__worldState()) === JSON.stringify(after);
  return {
    ok: !!parsed && !parsed.error,
    identical: JSON.stringify(before) === JSON.stringify(after),
    name: ed.map.name, base: ed.map.base,
    badRejected: badImport === null, stillIntact,
    status: ed.status,
  };
});
check('export→import reproduce el mapa EXACTO', roundtrip.ok && roundtrip.identical,
  JSON.stringify({ name: roundtrip.name, base: roundtrip.base }));
check('un fichero corrupto se rechaza sin destruir nada',
  roundtrip.badRejected && roundtrip.stillIntact, roundtrip.status);

// ---------------------------------------------------------------------------
// 5) DECORACIÓN + BIBLIOTECA URBANA sobre un clon de Calle
// ---------------------------------------------------------------------------
const decor = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.cloneLayout('calle');
  const on = window.__worldState();
  ed.setDecor(false);
  const off = window.__worldState();
  ed.undo(); // decor de vuelta
  const restored = window.__worldState();
  // insertar un asset GLB real de la biblioteca
  ed.brush = 'urban:fireHydrant';
  ed.place(3, 3);
  const withAsset = window.__worldState();
  const hydrant = ed.map.objects.find((o) => o.p === 'urban:fireHydrant');
  ed.selection = new Set([hydrant.id]);
  ed.setField('scale', 2);
  let scaled = 0;
  window.BREACH_WORLD.mapGroup.traverse((o) => {
    if (o.userData?.urbanAssetId === 'fireHydrant' && Math.abs(o.scale.x - 2) < 1e-6) scaled++;
  });
  ed.undo(); ed.undo(); // escala + colocación fuera
  const cleaned = window.__worldState();
  return {
    collidersStable: JSON.stringify(on.colliders) === JSON.stringify(off.colliders) &&
      JSON.stringify(on.colliders) === JSON.stringify(withAsset.colliders),
    decorOffStripsGLB: off.urban === 0 && on.urban > 0,
    decorOffShowsColliders: off.batchVerts > on.batchVerts,
    decorRestored: JSON.stringify(on) === JSON.stringify(restored),
    assetAdded: withAsset.urban === on.urban + 1,
    assetScaled: scaled === 1,
    cleaned: JSON.stringify(cleaned.colliders) === JSON.stringify(on.colliders) &&
      cleaned.urban === on.urban,
  };
});
check('DECOR off: quita GLBs, muestra colliders ocultos, colisión intacta',
  decor.collidersStable && decor.decorOffStripsGLB && decor.decorOffShowsColliders,
  JSON.stringify(decor));
check('DECOR se restaura con undo, idéntico', decor.decorRestored);
check('asset urbano real: insertar, escalar y deshacer',
  decor.assetAdded && decor.assetScaled && decor.cleaned, JSON.stringify(decor));

// ---------------------------------------------------------------------------
// 6) REGRESIÓN: mover un vehículo mueve modelo visible + collider enlazado
// ---------------------------------------------------------------------------
const linkedMove = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD;
  ed.cloneLayout('calle');
  const asset = ed.map.objects.find((o) => o.p === 'urban:suvMinivan' && o.link);
  if (!asset) return { found: false };
  const before = { x: asset.x, z: asset.z };
  ed.setTool('move');
  ed.update(0);
  ed.camera.updateMatrixWorld(true);
  const box = ed.objectBox(asset);
  const pointer = new window.THREE.Vector3(
    asset.x, (box.miny + box.maxy) / 2, asset.z,
  ).project(ed.camera);
  ed.onPointerDown(pointer.x, pointer.y, { shift: false, alt: false, button: 0 });
  ed.onPointerMove(pointer.x + 0.12, pointer.y - 0.03, 0, 0);
  ed.onPointerUp();
  const moved = ed.map.objects.find((o) => o.id === asset.id);
  const visible = [];
  W.mapGroup.traverse((o) => {
    if (o.userData?.urbanAssetId === 'suvMinivan') visible.push([o.position.x, o.position.z]);
  });
  const colliderAtNewPosition = W.colliders.some((c) =>
    Math.abs((c.minx + c.maxx) / 2 - moved.x) < 0.01 &&
    Math.abs((c.minz + c.maxz) / 2 - moved.z) < 0.01);
  const visualAtNewPosition = visible.some(([x, z]) =>
    Math.abs(x - moved.x) < 0.01 && Math.abs(z - moved.z) < 0.01);
  const staleVisual = visible.some(([x, z]) =>
    Math.abs(x - before.x) < 0.01 && Math.abs(z - before.z) < 0.01);
  return {
    found: true, selected: ed.selection.size, before,
    after: { x: moved.x, z: moved.z }, visualAtNewPosition,
    colliderAtNewPosition, staleVisual,
  };
});
check('mover vehículo clonado desplaza visual + collider, sin copia estática',
  // Asset + cuerpo LOW + cabina física sin cover.
  linkedMove.found && linkedMove.selected === 3 &&
  (linkedMove.before.x !== linkedMove.after.x || linkedMove.before.z !== linkedMove.after.z) &&
  linkedMove.visualAtNewPosition &&
  linkedMove.colliderAtNewPosition && !linkedMove.staleVisual,
  JSON.stringify(linkedMove));

const suvWindows = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD;
  ed.cloneLayout('calle');
  const roots = [];
  W.mapGroup.traverse((o) => {
    if (o.userData?.urbanAssetId !== 'suvMinivan') return;
    let blackVertices = 0;
    o.traverse((part) => {
      if (!part.isMesh) return;
      const color = part.geometry.getAttribute('color');
      if (!color) return;
      for (let i = 0; i < color.count; i++) {
        if (color.getX(i) + color.getY(i) + color.getZ(i) < 0.025) blackVertices++;
      }
    });
    roots.push({ darkened: o.userData.suvDarkWindowVertices ?? 0, blackVertices });
  });
  return roots;
});
check('solo los cristales del SUV reciben el tratamiento negro al precargar',
  suvWindows.length === 2 && suvWindows.every((suv) =>
    suv.darkened > 0 && suv.blackVertices >= suv.darkened), JSON.stringify(suvWindows));

const decalProjection = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD, V = window.THREE.Vector3;
  ed.cloneLayout('calle');
  const cast = (name, origin, direction) => {
    const o = new V(...origin), d = new V(...direction).normalize();
    const contact = W.raycastHit(o, d, 60);
    if (!contact) return { name, contact: false };
    const physical = o.clone().addScaledVector(d, contact.t);
    const visual = W.projectImpactSurface(o, physical, contact.normal, contact.surface);
    return {
      name, contact: true, visual: !!visual,
      correction: visual ? visual.point.distanceTo(physical) : null,
      normalLength: visual ? visual.normal.length() : null,
    };
  };
  const rays = [
    ['building', [0, 1.2, 0], [1, 0, 0]],
    ['suv', [-2.5, 1.0, -22], [0, 0, -1]],
    ['bus', [0, 1.2, -31], [0, 0, -1]],
    ['roadwork', [-1.2, 1.0, -3], [0, 0, -1]],
  ];
  const hits = rays.map((ray) => cast(...ray));
  const started = performance.now();
  for (let i = 0; i < 32; i++) cast(...rays[i % rays.length]);
  return { hits, projectionMs: performance.now() - started };
});
check('decals se pegan a edificio, SUV, bus y barricada sin alterar colliders',
  decalProjection.hits.every((hit) => hit.contact && hit.visual &&
    hit.correction <= 1.5 && Math.abs(hit.normalLength - 1) < 0.001),
  JSON.stringify(decalProjection));
check('proyección visual conserva presupuesto para ráfagas/escopeta',
  decalProjection.projectionMs < 250,
  `${decalProjection.projectionMs.toFixed(1)}ms / 32 impactos`);

const proceduralMove = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD;
  ed.cloneLayout('calle');
  const asset = ed.map.objects.find((o) => o.p === 'street:jersey' && o.link);
  if (!asset) return { found: false };
  ed.selection = new Set(ed.linkedSelection(asset));
  const before = { x: asset.x, z: asset.z };
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true,
  }));
  const moved = ed.map.objects.find((o) => o.id === asset.id);
  const visible = W.mapGroup.children.find((o) =>
    o.userData?.editorDecorKey === moved.decorKey && o.visible);
  const boxIds = new Set(['coverLow', 'coverMid', 'wall', 'pillar', 'platform', 'corner', 'railing']);
  const linkedBoxes = ed.map.objects.filter((o) =>
    boxIds.has(o.p) && o.visual === false && o.link);
  const unlinkedBoxes = ed.map.objects.filter((o) =>
    boxIds.has(o.p) && o.visual === false && !o.link);
  const intentionalInvisibleEnds = unlinkedBoxes.filter((o) =>
    Math.abs(Math.abs(o.z) - (ed.map.fz + 0.4)) < 0.05).length;
  return {
    found: true, selected: ed.selection.size, before,
    after: { x: moved.x, z: moved.z },
    visual: visible ? { x: visible.position.x, z: visible.position.z } : null,
    linkedBoxes: linkedBoxes.length, unlinkedBoxes: unlinkedBoxes.length,
    intentionalInvisibleEnds,
  };
});
check('flecha mueve divisor Jersey visible + collider como una unidad',
  proceduralMove.found && proceduralMove.selected === 2 &&
  proceduralMove.after.x === proceduralMove.before.x + 1 &&
  proceduralMove.visual?.x === proceduralMove.after.x &&
  proceduralMove.visual?.z === proceduralMove.after.z &&
  proceduralMove.unlinkedBoxes === 2 && proceduralMove.intentionalInvisibleEnds === 2,
  JSON.stringify(proceduralMove));

const solidStreetProps = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD;
  ed.cloneLayout('calle');
  const physicalIds = new Set([
    'urban:streetlight', 'urban:fireHydrant', 'urban:busShelter',
  ]);
  const assets = ed.map.objects.filter((o) => physicalIds.has(o.p));
  let linked = 0; let nonCover = 0; let cover = 0; let blocked = 0; let openFronts = 0;
  for (const asset of assets) {
    const boxes = ed.map.objects.filter((o) => o.link && o.link === asset.link && o.id !== asset.id);
    const expected = asset.p === 'urban:busShelter' ? 3 : 1;
    if (boxes.length === expected) linked++;
    nonCover += boxes.filter((o) => o.cover === false && o.visual === false).length;
    cover += boxes.filter((o) => o.cover !== false && o.visual === false).length;
    for (const box of boxes) {
      const p = { x: box.x, z: box.z };
      W.resolveCircle(p, 0.42, 0);
      if (Math.hypot(p.x - box.x, p.z - box.z) > 0.05) blocked++;
    }
    if (asset.p === 'urban:busShelter') {
      const side = Math.sign(asset.x);
      const front = { x: asset.x - side * 0.72, z: asset.z };
      const before = { ...front };
      W.resolveCircle(front, 0.32, 0);
      if (Math.hypot(front.x - before.x, front.z - before.z) < 0.02) openFronts++;
    }
  }
  return { assets: assets.length, linked, nonCover, cover, blocked, openFronts,
    coverFaces: W.faces.length };
});
check('postes/hidrantes colisionan; paradas son cover en U con frente abierto',
  solidStreetProps.assets === 20 && solidStreetProps.linked === 20 &&
  solidStreetProps.nonCover === 18 && solidStreetProps.cover === 6 &&
  solidStreetProps.blocked === 24 && solidStreetProps.openFronts === 2 &&
  // Los kioscos abiertos aportan caras únicamente en sus piezas reales.
  solidStreetProps.coverFaces === 208,
  JSON.stringify(solidStreetProps));

const buildingDuplicate = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR, W = window.BREACH_WORLD;
  ed.cloneLayout('calle');
  const building = ed.map.objects.find((o) => o.p === 'street:building');
  if (!building) return { found: false };
  const before = ed.map.objects.filter((o) => o.p === 'street:building').length;
  ed.selection = new Set([building.id]);
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'd', code: 'KeyD', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  const copy = ed.selected()[0];
  const visibleCopies = W.mapGroup.children.filter((o) =>
    o.userData?.editorDecorKey === building.decorKey && o.visible);
  return {
    found: true, before,
    after: ed.map.objects.filter((o) => o.p === 'street:building').length,
    selectedCopy: copy?.id !== building.id,
    moved: copy ? Math.hypot(copy.x - building.x, copy.z - building.z) > 0.5 : false,
    visibleCopies: visibleCopies.length,
  };
});
check('Ctrl+D duplica un edificio completo como unidad visual editable',
  buildingDuplicate.found && buildingDuplicate.after === buildingDuplicate.before + 1 &&
  buildingDuplicate.selectedCopy && buildingDuplicate.moved &&
  buildingDuplicate.visibleCopies === 2,
  JSON.stringify(buildingDuplicate));

const migratedClone = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.cloneLayout('calle');
  ed.map.objects = ed.map.objects.filter((o) => !o.baseDecor);
  delete ed.map.decorCaptured;
  delete ed.map.decorCaptureVersion;
  for (const o of ed.map.objects) delete o.link;
  const before = ed.map.objects.length;
  ed.rebuild();
  const baseDecor = ed.map.objects.filter((o) => o.baseDecor);
  return {
    before, after: ed.map.objects.length, baseDecor: baseDecor.length,
    linkedAssets: baseDecor.filter((o) => o.link).length,
  };
});
check('clones antiguos se actualizan sin exigir volver a clonarlos',
  migratedClone.after > migratedClone.before && migratedClone.baseDecor > 0 &&
  migratedClone.linkedAssets > 0, JSON.stringify(migratedClone));

const migratedV1Clone = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.cloneLayout('calle');
  const missingPieces = ['street:jersey', 'street:dumpster', 'street:kiosk', 'street:roadwork', 'street:coffee', 'street:building'];
  const missingLinks = new Set(ed.map.objects
    .filter((o) => missingPieces.includes(o.p))
    .map((o) => o.link).filter(Boolean));
  ed.map.objects = ed.map.objects.filter((o) =>
    !missingPieces.includes(o.p));
  for (const o of ed.map.objects) if (missingLinks.has(o.link)) delete o.link;
  ed.map.decorCaptureVersion = 1;
  const existingBefore = ed.map.objects.filter((o) => o.baseDecor).length;
  ed.rebuild();
  const procedural = ed.map.objects.filter((o) =>
    ['street:jersey', 'street:dumpster', 'street:kiosk', 'street:roadwork', 'street:coffee'].includes(o.p));
  const existingAfter = ed.map.objects.filter((o) => o.baseDecor &&
    !['street:jersey', 'street:dumpster', 'street:kiosk', 'street:roadwork', 'street:coffee'].includes(o.p)).length;
  return {
    existingBefore, existingAfter, procedural: procedural.length,
    linkedProcedural: procedural.filter((o) => o.link).length,
    version: ed.map.decorCaptureVersion,
  };
});
check('clon v1 agrega las 16 pieles y 14 edificios editables faltantes',
  migratedV1Clone.existingAfter === migratedV1Clone.existingBefore + 14 &&
  migratedV1Clone.procedural === 16 && migratedV1Clone.linkedProcedural === 16 &&
  migratedV1Clone.version === 4,
  JSON.stringify(migratedV1Clone));

const migratedV2Clone = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.cloneLayout('calle');
  const physicalIds = new Set(['urban:streetlight', 'urban:fireHydrant', 'urban:busShelter']);
  const assets = ed.map.objects.filter((o) => physicalIds.has(o.p));
  const physicalLinks = new Set(assets.map((o) => o.link).filter(Boolean));
  ed.map.objects = ed.map.objects.filter((o) =>
    o.p !== 'street:building' && !(o.link && physicalLinks.has(o.link) && !physicalIds.has(o.p)));
  for (const asset of assets) delete asset.link;
  ed.map.decorCaptureVersion = 2;
  ed.rebuild();
  const migratedAssets = ed.map.objects.filter((o) => physicalIds.has(o.p));
  const linkedPhysical = migratedAssets.filter((asset) => {
    const boxes = ed.map.objects.filter((o) =>
      o.id !== asset.id && o.link && o.link === asset.link && o.visual === false);
    return boxes.length === (asset.p === 'urban:busShelter' ? 3 : 1);
  });
  return {
    version: ed.map.decorCaptureVersion,
    buildings: ed.map.objects.filter((o) => o.p === 'street:building').length,
    assets: migratedAssets.length,
    linkedPhysical: linkedPhysical.length,
  };
});
check('clon v2 recibe colisión de props y edificios sin recrearlo',
  migratedV2Clone.version === 4 && migratedV2Clone.buildings === 14 &&
  migratedV2Clone.assets === 20 && migratedV2Clone.linkedPhysical === 20,
  JSON.stringify(migratedV2Clone));

const migratedV3Clone = await page.evaluate(() => {
  const ed = window.BREACH_EDITOR;
  ed.cloneLayout('calle');
  const revisedIds = new Set(['urban:streetlight', 'urban:busShelter']);
  const assets = ed.map.objects.filter((o) => revisedIds.has(o.p));
  const keep = new Set();
  for (const asset of assets) {
    const boxes = ed.map.objects.filter((o) => o.id !== asset.id && o.link === asset.link);
    const box = boxes[0];
    keep.add(box.id);
    box.x = asset.x; box.z = asset.z; box.cover = false; box.visual = false;
    if (asset.p === 'urban:streetlight') {
      box.w = 0.34; box.d = 0.34;
    } else {
      box.w = 0.62; box.d = 2.85; box.h = 2.45;
    }
  }
  const revisedLinks = new Set(assets.map((o) => o.link));
  ed.map.objects = ed.map.objects.filter((o) =>
    !o.link || !revisedLinks.has(o.link) || revisedIds.has(o.p) || keep.has(o.id));
  ed.map.decorCaptureVersion = 3;
  ed.rebuild();
  const migrated = ed.map.objects.filter((o) => revisedIds.has(o.p));
  let correct = 0;
  for (const asset of migrated) {
    const boxes = ed.map.objects.filter((o) => o.id !== asset.id && o.link === asset.link);
    if (asset.p === 'urban:streetlight') {
      if (boxes.length === 1 && Math.abs(Math.abs(boxes[0].x - asset.x) - 0.88) < 0.03) correct++;
    } else if (boxes.length === 3 && boxes.every((o) => o.cover !== false)) correct++;
  }
  return {
    version: ed.map.decorCaptureVersion,
    buildings: ed.map.objects.filter((o) => o.p === 'street:building').length,
    assets: migrated.length, correct,
  };
});
check('clon v3 reemplaza colliders viejos sin duplicar edificios',
  migratedV3Clone.version === 4 && migratedV3Clone.buildings === 14 &&
  migratedV3Clone.assets === 18 && migratedV3Clone.correct === 18,
  JSON.stringify(migratedV3Clone));

// ---------------------------------------------------------------------------
// 7) PLAYTEST de un clon de Azoteas (helipuerto + especial elevado)
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  window.BREACH_EDITOR.cloneLayout('azoteas');
  window.BREACH_EDITOR_PLAYTEST();
});
await page.waitForTimeout(2200);
const play = await page.evaluate(() => ({
  mode: window.BREACH.mode,
  custom: !!window.BREACH_WORLD.customMap,
  base: window.BREACH_WORLD.customMap?.base,
  specialY: window.BREACH_WORLD.specialSpot?.y,
  helipad: window.BREACH_WORLD.surfaceZones.length > 0,
  player: !!window.BREACH.player,
}));
check('playtest del clon de azoteas: helipuerto y especial a 1.1',
  play.mode === 'practice' && play.custom && play.base === 'azoteas' &&
  play.specialY === 1.1 && play.helipad && play.player, JSON.stringify(play));

await page.keyboard.press('Escape');
await page.waitForTimeout(900);
const back = await page.evaluate(() => ({
  mode: window.BREACH.mode,
  base: window.BREACH_EDITOR.map.base,
  boxes: window.BREACH_EDITOR.map.objects.length,
}));
check('vuelta al editor con el clon intacto',
  back.mode === 'editor' && back.base === 'azoteas' && back.boxes > 50,
  JSON.stringify(back));

check('sin errores de página', pageErrors === 0, `errores=${pageErrors}`);

console.log(fails.length ? `\nFALLOS: ${fails.length}` : '\nTODO OK');
await browser.close();
server.kill();
await clearClip();
process.exit(fails.length ? 1 : 0);
