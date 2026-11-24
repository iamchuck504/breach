// Banco anatómico en metros de cámara. Ejecuta el mismo modelo y los mismos
// sucesos que la vista del jugador. Los extremos de cada fila son por fase.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Euler, PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createViewModel } from '../src/view/fp/viewmodel.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import { apoyosDelArma, costadoSMG, distanciaYema, holguraBlindaje } from './lib-fps-anatomical-hand.mjs';
import { dodgeFX } from '../src/view/fp/dodge-fx.js';
import { SWAP_TIME } from '../src/combat/weapons.js';
import { TUNING } from '../src/config/tuning.js';
import { viewModelUniforms } from '../src/render/pipeline.js';
import { updateViewModelProjection } from '../src/view/fp/material.js';
import { SOLDIER_SURFACE_KIND } from '../src/player/soldier-bake.js';
import { silhouette } from '../src/view/fp/silhouette.js';
import { medirDedos } from './lib-fps-finger-angles.mjs';
import { surfaces, prepare, clearance } from './lib-fps-hand-geometry.mjs';

import { checkSoldierTriangles } from './lib-fps-soldier-parity.mjs';

checkSoldierTriangles();
assert.equal(Object.keys(PROFILES).length, 8, 'Se esperan ocho armas en el banco');
const assets = {};
for (const key of ['arms', 'kick-leg', ...Object.keys(PROFILES)]) {
  const bytes = await readFile(new URL('../public/assets/fp/' + key + '.glb', import.meta.url));
  assets[key] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
}
const camera = new PerspectiveCamera(72, 16 / 9);
const vm = createViewModel({ scene: new Scene(), camera, assets });
await vm.ready;
let glove, apoyos, costado, punos, lomoTrasero;
const rad = 180 / Math.PI;
assert.ok(vm.armsMesh.skeleton.bones.every(b => !b.name.startsWith('fp_upper_')), 'La manga usa la articulación del codo');
const fingers = ['index', 'middle', 'ring', 'pinky', 'thumb'];
const rows = new Map();
const framing = [];
let row, hz, frame, failures = 0;
function measure(name, value, low, high, strict = false) {
  let m = row.get(name);
  if (!m) { m = { min: Infinity, max: -Infinity, bad: '' }; row.set(name, m); }
  m.min = Math.min(m.min, value); m.max = Math.max(m.max, value);
  if (!m.bad && (!Number.isFinite(value) || value > high || (strict ? value <= low : value < low))) {
    m.bad = hz + 'Hz/' + frame + '=' + value.toFixed(3);
    failures++;
  }
}
const xyz = (x, y, z) => new Vector3(x, y, z);
const largas = new Set(['smg', 'shotgun', 'sniper', 'bazooka']);
function lomoDeLaBazuca(w) {
  // Caras traseras de la empuñadura del GLB, medidas respecto a su ancla.
  // El tubo pertenece al mismo hueso, por lo que la distancia al cuerpo entero
  // permitiría apoyar la palma en el tubo y dejar la empuñadura en el aire.
  const cuerpo = w.partBones.body.bone, centro = new Vector3(...w.anchors.grip);
  const caja = new Box3(centro.clone().add(xyz(-.05, -.105, -.065)),
    centro.clone().add(xyz(.05, .073, .065)));
  return surfaces(w.mesh, b => b === cuerpo, t =>
    [t.a, t.b, t.c].every(v => caja.containsPoint(v)) &&
    (t.a.z + t.b.z + t.c.z) / 3 > centro.z + .035).get(cuerpo);
}
function inspectSmgSight(w) {
  const P = viewModelUniforms.uVMProj.value;
  const { width, height, owner, names, gun } = silhouette(vm, P, 1280, 720);
  const marco = names.indexOf(w.partBones.sight_rear.bone.name);
  const cx = width / 2, cy = height / 2;
  // Dos cortes junto al punto evitan contar el emisor como parte del marco.
  function corte(lado, inicio, paso, limite) {
    let i = inicio;
    while (i !== limite && owner[i] === 0) i += paso;
    const interior = i;
    while (i !== limite && owner[i] === marco) i += paso;
    measure('réflex.espesor.' + lado + '.px', Math.abs((i - interior) / paso), 16, 18);
    return Math.abs((interior - inicio) / paso);
  }
  const horizontal = (cy - 10) * width + cx, vertical = cy * width + cx + 20;
  const izq = corte('izquierdo', horizontal, -1, horizontal - cx);
  const der = corte('derecho', horizontal, 1, horizontal + cx - 1);
  const arriba = corte('superior', vertical, -width, cx + 20);
  // Bajo la ventana, el pie y el riel ocupan la vertical central.
  let abajo = 0;
  while (cy + abajo < height && !owner[vertical + abajo * width]) abajo++;
  measure('réflex.ventana útil.ancho.px', izq + der - 1, 145, 155);
  measure('réflex.ventana útil.alto.px', arriba + abajo - 1, 96, 104);
  measure('réflex.descentrado vertical.px', Math.abs(abajo - arriba) / 2, 0, 1);
  measure('punto en la retícula', Number(owner[cy * width + cx] === marco), 1, 1);
  let obstruccion = 0;
  for (let y = cy - arriba + 1; y < cy + abajo; y++) {
    for (let x = cx - izq + 1; x < cx + der; x++) {
      const id = owner[y * width + x];
      const punto = id === marco && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= 5;
      if (id && !punto) obstruccion++;
    }
  }
  measure('obstrucción dentro de la ventana.px', obstruccion, 0, 0);
  const pomo = names.indexOf(w.partBones.bolt.bone.name);
  const derecha = names.map(n => /^fp_(hand_R|fore_R|R_)/.test(n));
  let area = 0, cuerpo = 0, guanteEnMira = 0, saliente = 0;
  const mount = names.indexOf(w.partBones.sight_mount.bone.name);
  const piezas = names.map((n, i) => n.startsWith('fp_smg_') && i !== marco && i !== mount);
  for (let y = cy; y < height; y++) {
    let x0 = width, x1 = -1;
    for (let x = 0; x < width; x++) {
      const i = y * width + x, id = owner[i];
      area += gun[i];
      if (derecha[id] && y <= cy + abajo && x >= cx - izq && x <= cx + der) guanteEnMira++;
      if (id === pomo) saliente++;
      if (piezas[id]) { x0 = Math.min(x, x0); x1 = Math.max(x, x1); }
    }
    cuerpo = Math.max(cuerpo, x1 - x0 + 1);
  }
  // El centro de la montura ha de llegar sin huecos desde el cristal al cajón.
  let pie = cy + abajo;
  while (pie < height && [marco, mount].includes(owner[pie * width + cx])) pie++;
  measure('réflex.carcasa bajo la ventana.px', pie - cy - abajo, 10, Infinity);
  measure('montura en contacto con el cajón', Number(piezas[owner[pie * width + cx]]), 1, 1);
  w.mesh.visible = false;
  const sinArma = silhouette(vm, P, width, height);
  w.mesh.visible = true;
  const izquierda = n => n.startsWith('fp_L_');
  const visible = owner.reduce((n,id) => n + Number(izquierda(names[id])), 0);
  const total = sinArma.owner.reduce((n,id) => n + Number(izquierda(sinArma.names[id])), 0);
  measure('guante oculto por el arma en ADS.%', 100 * (1 - visible / total), 50, 100);
  // Antes se ocultaba toda la derecha al apuntar. El agarre visible aprobado
  // puede asomar bajo el cajón, pero debe dejar libre el réflex hasta su borde.
  measure('guante derecho sobre el réflex.px', guanteEnMira, 0, 0);
  measure('pomo visible al apuntar.px', saliente, 0, 0);
  const [bocaX] = projectionOf(vm.anchorCam('muzzle', new Vector3()));
  measure('eje lateral del cañón.px', Math.abs(bocaX * width - cx), 0, 1e-6);
  measure('arma bajo el punto.% del cuadro', 100 * area / owner.length, 0, 9);
  measure('cuerpo bajo el punto.px', cuerpo, 1, 190);
  const sides = owner.subarray(horizontal - cx, horizontal + cx);
  measure('marco más ancho que el cajón.px', Math.max(0, sides.lastIndexOf(marco) -
    sides.indexOf(marco) + 1 - cuerpo), 0, 0);
  for (const anchor of ['sight_front', 'sight_rear']) {
    const [u, v] = projectionOf(vm.anchorCam(anchor, new Vector3()));
    measure(anchor + '.error óptico.px', Math.hypot(u * width - cx, v * height - cy), 0, 1e-6);
  }
}
let weaponGeo, piel, ringGap, ringPulled, pinzaAntes;

// La distancia al hueso no distingue un guante detrás de la carcasa de un
// brazal delante de ella. Se cuentan muestras visibles con profundidad.
function visibleWeapon(w, phase, label) {
  const mask = silhouette(vm, viewModelUniforms.uVMProj.value, Math.round(360 * camera.aspect), 360);
  const weaponBones = new Set(Object.values(w.partBones).map(p => p.bone.name));
  let total = 0, covered = 0, wrongSleeve = 0, leftHand = 0, rightHand = 0;
  for (let i = 0; i < mask.owner.length; i++) {
    const name = mask.names[mask.owner[i]];
    if (mask.gun[i]) {
      total++;
      if (!weaponBones.has(name)) covered++;
    }
    if (i % mask.width < mask.width / 2 && name === 'fp_fore_R') wrongSleeve++;
    if (name === 'fp_hand_L' || name.startsWith('fp_L_')) leftHand++;
    if (name === 'fp_hand_R' || name.startsWith('fp_R_')) rightHand++;
  }
  if (phase === 'cadera') {
    // En las armas compactas, la mano cubre parte del objeto por diseño.
    const compact = w.prof.thrown || w.prof.grips.left.pose === 'libre';
    measure('arma tapada.% ' + label, 100 * covered / total, 0, w.prof.thrown ? 50 : compact ? 45 : 25);
    if (w.key === 'bazooka') {
      // La manga cabía dentro del porcentaje global aunque cruzara la boca trasera.
      const center = projectionOf(vm.anchorCam('backblast', new Vector3()));
      const x = Math.round(center[0] * (mask.width - 1)), y = Math.round(center[1] * (mask.height - 1));
      if (x >= 2 && x < mask.width - 2 && y >= 2 && y < mask.height - 2) {
        let sleevePixels = 0;
        for (let j = y - 2; j <= y + 2; j++) for (let i = x - 2; i <= x + 2; i++) {
          if (mask.names[mask.owner[j * mask.width + i]] === 'fp_fore_R') sleevePixels++;
        }
        measure('manga en la abertura trasera.píxeles ' + label, sleevePixels, 0, 0);
      }
    }
    if (w.prof.thrown) measure('guante derecho visible.píxeles ' + label, rightHand, 1, Infinity);
    if (!w.prof.thrown) measure('guante derecho visible.% del cuadro ' + label, 100 * rightHand / mask.owner.length, 0, 5);
    if (w.prof.targets.forend.anchor && w.prof.grips.left.pose !== 'libre') measure('guante izquierdo visible.píxeles ' + label, leftHand, 1, Infinity);
  }
  // Comprobar la corredera en su propia silueta al apuntar.
  const cortaADS = phase === 'ADS' && w.prof.grips.left.pose === 'libre';
  if (cortaADS) {
    vm.armsMesh.visible = false;
    const sola = silhouette(vm, viewModelUniforms.uVMProj.value, mask.width, mask.height);
    vm.armsMesh.visible = true;
    const corredera = w.partBones.slide.bone.name;
    let proyectada = 0, despejada = 0;
    for (let i = 0; i < sola.owner.length; i++) {
      if (sola.names[sola.owner[i]] !== corredera) continue;
      proyectada++;
      if (mask.names[mask.owner[i]] === corredera) despejada++;
    }
    measure('corredera visible en ADS.%', 100 * despejada / proyectada, 99, 100);
  }
  measure('arma.visible.%', 100 * (total - covered) / total, w.prof.thrown ? 100 / 3 : cortaADS ? 45 : 50, 100);
  measure('manga derecha en mitad izquierda.%', 100 * wrongSleeve / mask.owner.length, 0, 0.1);
  if (!w.prof.targets.forend.anchor || w.prof.grips.left.pose === 'libre') measure('mano libre visible en reposo.píxeles', leftHand, 0, 0);
  if (phase === 'ADS' && !w.prof.thrown && camera.aspect === 16 / 9) {
    measure('guante derecho al apuntar.% del cuadro', 100 * rightHand / mask.owner.length, 0, 5);
  }
}

function projectionOf(v) {
  const p = v.clone().applyMatrix4(viewModelUniforms.uVMProj.value);
  return [(1 + p.x) / 2, (1 - p.y) / 2];
}

// La máscara clasifica sólo los píxeles que llegan al jugador tras la oclusión.
function medirRecarga(w, mask, tiempoOculta, dt) {
  const { width, height, owner, names } = mask;
  const arma = names.map(n => n.startsWith('fp_' + w.key + '_'));
  const derecha = names.map(n => /^(fp_R_|fp_hand_R)/.test(n));
  const manga = names.indexOf('fp_fore_R'), pieza = names.indexOf(w.roles.mag?.bone.name);
  const izquierda = names.map(n => /^(fp_L_|fp_hand_L)/.test(n));
  let metal = 0, guante = 0, brazal = 0, borde = 0, bordeGuante = 0, x = 0, y = 0, municion = 0, dedos = 0;
  for (let i = 0; i < owner.length; i++) {
    const id = owner[i];
    if (!id) continue;
    if (arma[id]) { metal++; x += i % width + .5; y += Math.floor(i / width) + .5; }
    if (derecha[id]) guante++;
    if (id === manga) brazal++;
    if (i >= width*(height-1) || i < width || i%width === width-1 || i%width === 0) {
      if (id === manga) borde++;
      if (derecha[id]) bordeGuante++;
    }
    if (id === pieza) municion++;
    if (izquierda[id]) dedos++;
  }
  const area = 100 * metal / owner.length;
  measure('arma visible.% del cuadro', area, 0, 100);
  const oculta = metal ? 0 : tiempoOculta + dt;
  measure('desaparición continua.s', oculta, 0, .15);
  // En las cortas la carcasa sola puede ocupar menos del 3 %. También allí
  // comprobamos que el conjunto siga encuadrado y que se lea el agarre.
  if (metal > 0) {
    measure('derecha visible.px', guante + brazal, w.key === 'smg' ? 2500 : 600, Infinity);
    measure('dedos o palma derechos visibles.px', guante, 1, Infinity);
    // Al alzar el cerrojo, la muñeca puede cruzar el borde antes de que
    // entre el brazal. En ambos casos el brazo visible debe llegar al borde.
    measure('brazo derecho en borde.px', brazal ? borde : bordeGuante, 1, Infinity);
    measure('centro del arma.x', x / metal / width, 2/3, 1);
    measure('centro del arma.y', y / metal / height, 2/3, 1);
  }
  // Aunque el arma oculte la última fila, una manga visible no puede terminar en el aire.
  if (largas.has(w.key) && owner.includes(names.indexOf('fp_fore_L'))) {
    const mangaL = vm.arms.seg.L.fore;
    let alcance = 0;
    for (const punto of glove.get(mangaL).points) {
      const [x, y] = projectionOf(vm.root.worldToLocal(mangaL.localToWorld(punto.clone())));
      alcance = Math.max(alcance, Math.abs(2*x - 1), Math.abs(2*y - 1));
    }
    measure('manga izquierda hasta el borde del cuadro', alcance, 1, Infinity);
  }
  measure('alabeo absoluto.°', Math.abs(vm.anim.out.gun[5]) * rad, 0, 35);
  if (w.key === 'smg') {
    for (const [i, eje] of ['cabeceo', 'guiñada', 'alabeo'].entries()) {
      measure(eje + ' desde cadera.°', Math.abs(vm.anim.out.gun[3+i] - w.prof.hip.rot[i]) * rad, 0, 35);
    }
  }
  if (vm.anim.out.mag >= .98 && !vm.anim.out.magHide && municion > 0) {
    measure('guante izquierdo con pieza visible.px', dedos, 1, Infinity);
    piezaEnMano = Math.max(piezaEnMano, Math.min(municion, dedos));
  }
  return oculta;
}

// El cono de dispersión de la escopeta debe quedar libre hasta el último bombeo.
function inspectReload(w) {
  if (w.key !== 'shotgun') return;
  const mask = silhouette(vm, viewModelUniforms.uVMProj.value, 320, 180);
  const cx = mask.width / 2, cy = mask.height / 2;
  const r = cy * Math.tan(TUNING.weapons.shotgun.spreadHip / rad) / Math.tan(camera.fov / (2 * rad));
  let covered = 0;
  for (let y = Math.floor(cy - r); y < cy + r; y++) for (let x = Math.floor(cx - r); x < cx + r; x++) {
    if (mask.owner[y * mask.width + x] && Math.hypot(x + .5 - cx, y + .5 - cy) <= r) covered++;
  }
  measure('superposición con el cono de cadera.px', covered, 0, 0);
}

// Ancho perpendicular de la silueta en el borde y en la fila de la muñeca.
function inspectSupport(mask, side) {
  const { names, owner, width, height } = mask;
  const arm = vm.arms.rig.out[side], wrist = projectionOf(arm.wrist), elbow = projectionOf(arm.elbow);
  const dx = width * (elbow[0] - wrist[0]), dy = height * (elbow[1] - wrist[1]);
  const cosine = dy / Math.hypot(dx, dy), fore = names.indexOf('fp_fore_' + side);
  const corte = y => owner.subarray(y * width, (y + 1) * width).reduce((n, id) => n + Number(id === fore), 0) * cosine;
  measure(side + '.brazal en borde.px', corte(height - 1), .09 * width, .11 * width);
  // El puño original puede tapar por completo la boca estrecha del brazal.
  // Si la muñeca queda fuera del cuadro, su unión física se comprueba en 3D.
  // En pantalla debe leerse el mismo brazo hasta la última fila visible.
  const fila = Math.min(height - 1, Math.max(0, Math.round(height * wrist[1])));
  const union = names.map(n => n === 'fp_fore_' + side || n === 'fp_' + side + '_wrist');
  measure(side + '.unión visible en muñeca.px',
    owner.subarray(fila * width, (fila + 1) * width).filter(id => union[id]).length, 1, Infinity);
  const bone = vm.arms.seg[side].fore;
  const extent = Math.max(...glove.get(bone).points.map(v => projectionOf(vm.root.worldToLocal(bone.localToWorld(v.clone())))[1]));
  measure(side + '.continuación bajo el borde.px', (extent - 1) * height, 1, Infinity);
}

// Clasificación por articulación de la piel, después de la oclusión por el arma.
function inspectGlove(w, { names, owner, width, height, face, gun }, side) {
  const prefijo = "fp_" + side + "_", larga = largas.has(w.key);
  const areas = names.map(() => 0);
  for (const id of owner) areas[id]++;
  const contar = regla => areas.reduce((n, area, i) => n + (regla.test(names[i]) ? area : 0), 0);
  const total = contar(new RegExp('^' + prefijo));
  if (larga) {
    const esMano = names.map(n => n.startsWith(prefijo));
    let x0 = width, x1 = -1, y0 = height, y1 = -1;
    for (let i = 0; i < owner.length; i++) if (esMano[owner[i]]) {
      x0 = Math.min(x0,i%width); x1 = Math.max(x1,i%width);
      y0 = Math.min(y0,Math.floor(i/width)); y1 = Math.max(y1,Math.floor(i/width));
    }
    measure('mano visible.ancho.px', x1-x0+1, 95, Infinity);
    measure('mano visible.alto.px', y1-y0+1, 110, Infinity);
  }
  const dedos = contar(new RegExp('^' + prefijo + '.*-finger-phalanx-'));
  // El límite anterior escondía los dedos del apoyo antiguo. La palma y el
  // pulgar deben dominar la silueta, con las cuatro yemas en la cara lejana.
  if (larga) measure('palma y pulgar predominan.% del guante', 100 * (total - dedos) / total, 50, 100);
  const articulacion = parte => {
    const hueso = vm.arms.anatomy[side].joints.find(b => b.name === prefijo + 'thumb-' + parte);
    return w.model.worldToLocal(hueso.getWorldPosition(new Vector3()));
  };
  const punta = articulacion('tip');
  const proy = p => projectionOf(vm.root.worldToLocal(w.model.localToWorld(p)));
  const base = articulacion('metacarpal');
  const uv = p => { const [u,v] = proy(p.clone()); return [width*u, height*v]; };
  const [bx,by] = uv(base), [tx,ty] = uv(punta);
  const largo = Math.hypot(tx-bx, ty-by), dx = (tx-bx)/largo, dy = (ty-by)/largo;
  const [fx,fy] = uv(base.clone().add(xyz(0,0,-.1)));
  const angulo = Math.atan2(Math.abs(dx*(fy-by)-dy*(fx-bx)), dx*(fx-bx)+dy*(fy-by));
  if (larga || w.prof.grips.left.pose === 'libre') {
    measure(side + '.pulgar respecto al arma en el modelo.°', punta.clone().sub(base).angleTo(xyz(0,0,-1))*rad, 0, 30);
    if (larga) measure('pulgar respecto al arma en pantalla.°', angulo*rad, 0, 30);
  }
  // Cortes de un píxel normales al pulgar. La mediana del tramo central
  // excluye las tapas redondas y solo cuenta muestras visibles del blindaje.
  const pulgar = names.map(n => n.startsWith(prefijo + 'thumb-'));
  const distal = names.indexOf(prefijo + 'thumb-phalanx-distal'), cortes = new Map();
  const muneca = names.indexOf(prefijo + 'wrist'), detalle = vm.armsMesh.geometry.attributes.aDetail;
  const bordePulgar = new Int32Array(height).fill(-1);
  let placa = 0, apoyada = 0;
  for (let i = 0; i < owner.length; i++) {
    const id = owner[i];
    if (id === muneca && detalle.array[face[i] * 2] === SOLDIER_SURFACE_KIND.webbing) placa++;
    if (!pulgar[id]) continue;
    const u = Math.round((i%width+.5-bx)*dx + (Math.floor(i/width)+.5-by)*dy);
    bordePulgar[Math.floor(i / width)] = i;
    cortes.set(u, (cortes.get(u) ?? 0) + 1);
    if (id === distal && gun[i]) apoyada++;
  }
  let hueco = 0;
  for (const i of bordePulgar) {
    if (i < 0 || !names[owner[i]].startsWith('fp_L_thumb-phalanx')) continue;
    // Seguir la silueta hacia el arma: la palma también puede cerrar el hueco.
    let j = i + 1;
    const finFila = (Math.floor(i / width) + 1) * width;
    while (j < finFila && !owner[j]) j++;
    if (j < finFila && gun[j]) hueco = Math.max(hueco, j - i - 1);
  }
  if (w.key === 'smg') measure('fondo entre falanges y guardamanos.px', hueco, 0, 0);
  if (larga) {
    // El cañón, el visor y las alzas pueden ocupar la misma fila mucho más
    // atrás. Comparar la yema con la cara que recibe su apoyo en profundidad.
    const distancia = distanciaYema(vm, side, 'thumb', apoyos(side, 'thumb'), viewModelUniforms.uVMProj.value);
    measure('separación de la yema y su apoyo.px', Math.round(distancia), 0, 0);
  }
  function dimensiones(muestras) {
    const minimo = Math.min(...muestras.keys()), maximo = Math.max(...muestras.keys());
    const largo = maximo - minimo + 1, anchos = [];
    for (let u = Math.ceil(minimo + .25*largo); u <= minimo + .75*largo; u++) anchos.push(muestras.get(u) ?? 0);
    anchos.sort((a,b) => a-b);
    return { largo, ancho: anchos[Math.floor(anchos.length/2)] ?? 0 };
  }
  const visible = dimensiones(cortes);
  let largoMinimo = larga ? 80 : 1, anchoMinimo = larga ? Math.floor(38 * 19.77 / 29.7) : 1;
  if (w.key === 'smg') {
    // El puño grueso se comprobaba con una plantilla fija de 80 × 38 px.
    // En el agarre lateral se debe ver al menos el 95 % de ambas dimensiones
    // del pulgar del soldado, proyectado en esta misma pose sin la camisa.
    w.mesh.visible = false;
    const sola = silhouette(vm, viewModelUniforms.uVMProj.value, width, height);
    w.mesh.visible = true;
    const ids = sola.names.map(n => n.startsWith(prefijo + 'thumb-')), secciones = new Map();
    for (let i = 0; i < sola.owner.length; i++) if (ids[sola.owner[i]]) {
      const u = Math.round((i%width+.5-bx)*dx + (Math.floor(i/width)+.5-by)*dy);
      secciones.set(u, (secciones.get(u) ?? 0) + 1);
    }
    const entera = dimensiones(secciones);
    largoMinimo = Math.max(1, Math.ceil(.95 * entera.largo));
    anchoMinimo = Math.max(1, Math.ceil(.95 * entera.ancho));
  }
  measure(side + '.pulgar ancho visible.px', visible.ancho, anchoMinimo, Infinity);
  measure(side + '.pulgar largo visible.px', visible.largo, largoMinimo, Infinity);
  // El antiguo guante enseñaba la placa textil completa. Con el apoyo lateral
  // puede verse de canto. La silueta de la muñeca debe seguir siendo legible.
  if (larga) measure(side + '.dorso o puño visible.px', areas[muneca], 1, Infinity);
  else measure(side + '.placa dorsal visible.px', placa, 1, Infinity);
  if (larga) {
    measure('falange distal sobre el guardamanos.px', apoyada, 1, Infinity);
  }
}

// Una isla de brazo sobre fondo sólo puede sostenerse saliendo del cuadro o
// continuando detrás del arma. Se recorren también los huecos entre falanges.
function inspectFragments(w, mask) {
  const { owner, names, width, height } = mask;
  const brazo = names.map(n => /^fp_(?:[LR]_|fore_[LR])/.test(n));
  const arma = names.map(n => n.startsWith('fp_' + w.key + '_') || n === 'fp_grenade' || n.startsWith('fp_kick_'));
  const visto = new Uint8Array(owner.length), cola = [];
  let mayor = 0;
  for (let i = 0; i < owner.length; i++) {
    if (visto[i] || !brazo[owner[i]]) continue;
    let unido = false;
    cola.length = 0;
    cola.push(i); visto[i] = 1;
    for (let j = 0; j < cola.length; j++) {
      const u = cola[j], x = u % width;
      if (x === 0 || x === width - 1 || u < width || u >= width * (height - 1)) unido = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx < 0 || x + dx >= width) continue;
        const k = u + dy * width + dx;
        if (arma[owner[k]]) unido = true;
        if (brazo[owner[k]] && !visto[k]) { visto[k] = 1; cola.push(k); }
      }
    }
    if (!unido) mayor = Math.max(mayor, cola.length);
  }
  measure('mayor fragmento aislado.px', mayor, 0, 0);
}

function inspectHip(w) {
  const P = viewModelUniforms.uVMProj.value;
  const mask = silhouette(vm, P, 1280, 720, true);
  for (const lado of ['L','R']) {
    const antebrazo = vm.arms.seg[lado].fore;
    const puntos = glove.get(antebrazo).points;
    const extremo = Math.min(...puntos.map(v => v.y));
    const cara = new Box3().setFromPoints(puntos.filter(v => v.y < extremo + .0006));
    const brazo = lado === 'L' ? w.prof.supportArm : w.prof.triggerArm;
    const centro = cara.getCenter(new Vector3()), boca = new Vector3(...brazo.boca);
    measure(lado + '.descentrado de collar.mm', 1000 * Math.hypot(centro.x-boca.x, centro.z-boca.z) * brazo.sleeveScale, 0, 1);
  }
  if (w.prof.thrown) {
    const nudillo = vm.arms.anatomy.R.joints.find(b => b.name.endsWith('middle-finger-phalanx-proximal'));
    const [, yNudillo] = projectionOf(vm.root.worldToLocal(nudillo.getWorldPosition(new Vector3())));
    const [, yMuneca] = projectionOf(vm.arms.rig.out.R.wrist);
    measure('nudillos por encima de la muñeca.px', (yMuneca - yNudillo) * mask.height, 1, Infinity);
  }
  const lados = largas.has(w.key) ? ['L'] : ['R'];
  for (const side of lados) {
    inspectSupport(mask, side);
    inspectGlove(w, mask, side);
  }
  if (w.key === 'smg') {
    const { width, height, owner, names } = mask;
    const marco = names.indexOf(w.partBones.sight_rear.bone.name);
    let left = width, right = -1, top = height, bottom = -1;
    for (let i = 0; i < owner.length; i++) if (owner[i] === marco) {
      const x = i % width, y = Math.floor(i / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    measure('marco exterior en cadera.ancho.px', right - left + 1, 100, 120);
    measure('marco exterior en cadera.alto.px', bottom - top + 1, 81, 91);
    const y = (top + bottom) >> 1;
    const scan = owner.subarray(y * width, (y + 1) * width);
    let x = scan.indexOf(marco), start = x;
    while (scan[x] === marco) x++;
    measure('marco en cadera.espesor lateral.px', x - start, 9, 13);
  }
  const { width, height, gun, owner, names } = mask;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let i = 0; i < gun.length; i++) if (gun[i]) {
    const x = i % width, y = Math.floor(i / width);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
  }
  const rect = [x0 / width, y0 / height, x1 / width, y1 / height];
  const e = new Euler().setFromQuaternion(vm.arms.rig.gunQuat, 'YXZ');
  const front = vm.anchorCam('sight_front', new Vector3());
  const axis = front.sub(vm.anchorCam('sight_rear', new Vector3())).normalize();
  const angles = [Math.atan2(-axis.x, -axis.z), Math.asin(axis.y), e.z].map(r => r * rad);
  // Triángulos de los tres modelos originales, sin guantes, a 1280×720
  // con la cámara de viewScene (50°). Orden: izquierda, arriba, derecha, abajo.
  const vulcan = { rect: [0.555, 0.575, 1, 1], angles: [5.73, 2.29, -1.72], wrist: [0.5624, 0.7358], exit: 0.467 };
  const vesper = { rect: [0.598, 0.633, 0.837, 1], angles: [9.17, 2.86, 0] };
  const reaper = { rect: [0.464, 0.560, 1, 1], angles: [21.77, 2.86, -2.86], wrist: [0.5647, 0.8099], exit: 0.492 };
  // El borde superior de v3 correspondía al réflex sobredimensionado.
  // La boca conserva una referencia independiente del tamaño del colimador.
  const smg = { rect: [700 / width, null, 1220 / width, 1], angles: [0.187 * rad, 0.088 * rad, 0.02 * rad] };
  if (w.key === 'smg') {
    const [u, v] = projectionOf(vm.anchorCam('muzzle', new Vector3()));
    measure('desplazamiento de la boca.x.px', Math.abs(u * width - 717.28), 0, width * .06);
    measure('desplazamiento de la boca.y.px', Math.abs(v * height - 438.12), 0, height * .06);
    const pivot = projectionOf(vm.arms.rig.gunPos), v3 = projectionOf(xyz(.121, -.129, -.337));
    measure('traslación del agarre.x.px', Math.abs(pivot[0] - v3[0]) * width, 0, width * .06);
    measure('traslación del agarre.y.px', Math.abs(pivot[1] - v3[1]) * height, 0, height * .06);
  }
  const ref = { smg, sniper: vulcan, bazooka: vulcan, pistol: vesper, stun: vesper, shotgun: reaper }[w.key];
  // En el brazal esculpido la codera sobresale del pivote. Medir su
  // silueta visible en el borde, igual que en las capturas de referencia.
  const lastRow = owner.subarray(-width), fore = names.indexOf('fp_fore_L');
  const first = lastRow.indexOf(fore), last = lastRow.lastIndexOf(fore);
  const left = first < 0 ? NaN : (first + last + 1) / (2 * width);
  // En las armas largas se conserva la orientación de cadera del modelo.
  if (ref) angles.forEach((v, i) => measure('error de orientación.' + i, Math.abs(v-ref.angles[i]), 0, w.key === 'smg' ? 12 : 4));
  const result = { arma: w.key, bordes: rect.map(v => v.toFixed(3)).join(' '),
    'guiñada / cabeceo / alabeo': angles.map(v => v.toFixed(2)).join(' '),
    'entrada izq.': Number.isFinite(left) ? left.toFixed(3) : 'fuera' };
  framing.push(result);
}

function inspectFrame(w, phase) {
  for (const fov of [60, 72, 100]) for (const [width, height] of [[4, 3], [16, 9], [21, 9]]) {
    camera.fov = fov;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    updateViewModelProjection(camera);
    const label = fov + '° ' + width + '/' + height;
    visibleWeapon(w, phase, label);
  }
  camera.fov = 72;
  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();
  updateViewModelProjection(camera);
}

const lectores = Object.fromEntries(['L', 'R'].map(l => [l, medirDedos(vm.arms.anatomy[l], l)]));
const baseIndice = new Map();
function inspeccionarDedos(w, fase, vista) {
  const recarga = fase.startsWith('recarga/') || fase.startsWith('vacía/');
  const gesto = fase === 'disparo' || w.prof.thrown && fase === 'preparación';
  const comprobarAgarre = !recarga && (gesto || fase === 'cadera' || fase === 'ADS');
  if (w.key === 'bazooka' && comprobarAgarre) {
    prepare(lomoTrasero);
    const palma = piel.R.find(p => p.bone.name === 'fp_R_wrist');
    measure('R.palma asentada en la empuñadura trasera.mm', clearance(palma, [lomoTrasero]), 0, 1);
  }
  const larga = largas.has(w.key);
  const eje = xyz(0, 0, -1), pulgares = {};
  const puntos = (lado, dedo) => vm.arms.anatomy[lado].joints
    .filter(b => b.name.startsWith('fp_' + lado + '_' + dedo + '-'))
    .map(b => w.model.worldToLocal(b.getWorldPosition(new Vector3())));
  for (const lado of ['L', 'R']) {
    const flexiones = [], separaciones = [];
    const piezas = piel[lado].filter(p => !p.bone.name.endsWith('wrist'));
    piezas.forEach(prepare);
    let cruce = 0;
    for (const a of piezas) for (const b of piezas) {
      if (a.bone.name.split('-')[0] === b.bone.name.split('-')[0]) continue;
      cruce = Math.max(cruce, -clearance(a, [b], 0));
    }
    measure(lado + '.cruce entre dedos.mm', cruce, 0, .01);
    for (const dedo of fingers) {
      const valores = lectores[lado](dedo), pulgar = dedo === 'thumb';
      const prefijo = lado + '.' + dedo + '.';
      const agarreC = comprobarAgarre && larga && lado === 'L';
      for (const [junta, valor] of Object.entries(valores)) {
        let min = junta === 'abd' ? -12 : 0, max = junta === 'abd' ? 12 : 180;
        if (agarreC && junta !== 'abd' && junta !== 'cmc') {
          [min, max] = pulgar ? (junta === 'mcp' ? [0, 20] : [0, 15])
            : { mcp: [50, 70], pip: [60, 90], dip: [20, 45] }[junta];
        }
        measure(prefijo + junta + '.°', valor, min - .001, max + .001);
      }
      if (!pulgar && agarreC) { flexiones.push(valores); separaciones.push(valores.abd); }
      if (!comprobarAgarre) continue;
      const cadena = puntos(lado, dedo), punta = cadena.at(-1);
      if (pulgar) {
        pulgares[lado] = { punta, eje: punta.clone().sub(cadena[0]).normalize() };
        if (agarreC) {
          const apoyosPulgar = w.key === 'smg' ? [costado] : apoyos(lado, dedo);
          for (const p of apoyosPulgar) prepare(p);
          for (const p of piezas.filter(p => p.bone.name.includes('_thumb-'))) {
            measure(p.bone.name + '.costado.mm', clearance(p, apoyosPulgar), -.01, 1);
          }
        }
        if (!w.prof.thrown && lado === 'R') {
          measure('R.pulgar hacia la boca.°', pulgares.R.eje.angleTo(eje)*rad, 0, 30);
          measure('R.pulgar al lado izquierdo del lomo', punta.x - w.anchors.grip[0], -Infinity, 0);
          // La horquilla nace entre las dos articulaciones metacarpofalángicas.
          // La base del primer metacarpiano pertenece al carpo y baja al extender el pulgar.
          const horquilla = cadena[larga ? 1 : 0].clone().lerp(puntos('R', 'index')[1], .5);
          measure('R.horquilla sobre el centro de la empuñadura.mm', (horquilla.y - w.anchors.grip[1])*1000*w.prof.scale, 0, Infinity);
        } else if (w.prof.thrown && lado === 'R' && (vm.anim.out.rOpen ?? 0) < .001) {
          measure('R.pulgar sobre la palanca.mm', 1000*distanciaYema(vm, 'R', dedo, apoyos(lado, dedo)), 0, 1);
        }
      } else if (agarreC) {
        measure(prefijo + 'yema por el lado lejano', punta.x - w.anchors.forend[0], 0, Infinity);
      } else if (w.prof.thrown && lado === 'R' && (vm.anim.out.rOpen ?? 0) < .001) {
        // La palanca define el frente del bote. Los segmentos que abrazan
        // el cuerpo deben llegar al otro lado del plano radial de la palanca.
        const centro = new Vector3(...w.anchors.grip);
        const frente = new Vector3(...w.anchors.lever).sub(centro).setY(0).normalize();
        measure(prefijo + 'envuelve el bote', Math.min(...cadena.slice(1).map(p =>
          p.clone().sub(centro).dot(frente))), -Infinity, 0);
      } else if (!w.prof.thrown && lado === 'R') {
        if (lado === 'R' && dedo === 'index') {
          if (fase === 'cadera') baseIndice.set(w.key, valores);
          if (!gesto) for (const j of ['mcp', 'pip', 'dip']) measure(prefijo + j + ' extendida.°', valores[j], -.001, 12.001);
          if (gesto) for (const j of ['mcp', 'abd']) measure(prefijo + j + ' fija.°', Math.abs(valores[j] - baseIndice.get(w.key)[j]), 0, .01);
        } else {
          const banda = punta.clone().sub(cadena[1]).normalize();
          measure(prefijo + 'inclinación de banda.°', Math.asin(Math.abs(banda.y))*rad, 0, 12);
        }
      }
    }
    if (separaciones.length) {
      measure('separación de los cuatro dedos.°', Math.max(...separaciones)-Math.min(...separaciones), 0, 4.001);
      for (let i = 1; i < flexiones.length; i++) for (const j of ['mcp','pip','dip']) {
        measure('progresión de ' + j + '.°', flexiones[i][j] - flexiones[i-1][j], -.001, Infinity);
      }
    }
  }
  if (comprobarAgarre && larga) {
    const pp = puntos('L', 'thumb');
    const pantalla = p => {
      const [x,y] = projectionOf(vm.root.worldToLocal(w.model.localToWorld(p.clone())));
      return xyz(x*vista.width, y*vista.height, 0);
    };
    const direccion = pantalla(pp.at(-1)).sub(pantalla(pp[0])).normalize();
    const boca = new Vector3(...w.anchors.muzzle);
    const canon = pantalla(boca).sub(pantalla(boca.clone().sub(eje)));

    const ids = vista.names.map(n => n.startsWith('fp_L_thumb-'));
    const cortes = new Map();
    for (let i = 0; i < vista.owner.length; i++) {
      if (!ids[vista.owner[i]]) continue;
      const u = Math.round((i%vista.width)*direccion.x + Math.floor(i/vista.width)*direccion.y);
      cortes.set(u, (cortes.get(u) ?? 0) + 1);
    }
    const anchos = [...cortes.values()].sort((a,b) => a-b);
    // Antes se exigía una silueta lateral incluso tras el cajón en ADS.
    // Aceptar la oclusión sólo si el arma cubre efectivamente todo el pulgar.
    let oculto = false;
    if (fase === 'ADS' && !anchos.length) {
      w.mesh.visible = false;
      const sola = silhouette(vm, viewModelUniforms.uVMProj.value, vista.width, vista.height);
      w.mesh.visible = true;
      const pulgar = sola.names.map(n => n.startsWith('fp_L_thumb-'));
      let muestras = 0, cubiertas = 0;
      for (let i = 0; i < sola.owner.length; i++) if (pulgar[sola.owner[i]]) {
        muestras++;
        if (vista.gun[i]) cubiertas++;
      }
      oculto = muestras > 0 && muestras === cubiertas;
    }
    // Con el ocular al ojo, el campo circular pertenece al escenario. La
    // proporción lateral sigue siendo exigible cuando se ve parte del pulgar.
    if (fase === 'ADS' && vm.ocular.matte.visible && !anchos.length) {
      const centro = (vista.height >> 1) * vista.width + (vista.width >> 1);
      measure('centro del ocular despejado', vista.owner[centro], 0, 0);
      oculto = true;
    }
    if (!oculto) {
      if (canon.length() > .01) measure('pulgar y cañón en pantalla.°', direccion.angleTo(canon)*rad, 0, 20);
      measure('pulgar visible.largo/ancho', anchos.length ? cortes.size / anchos[anchos.length >> 1] : 0, 2.5, Infinity);
    }
  }
}

let tiempoOculta = 0, piezaEnMano = 0, distanciaPalma = Infinity;
function inspect(key, phase) {
  const id = key + ' ' + phase;
  if (!rows.has(id)) rows.set(id, new Map());
  row = rows.get(id);
  const w = vm.weapons[key], a = vm.anim.out;
  const stable = phase === 'cadera' || phase === 'ADS';
  if (stable && hz === 30) inspectFrame(w, phase);
  if (phase === 'cadera' && hz === 60) inspectHip(w);
  const P = viewModelUniforms.uVMProj.value;
  if (phase === 'ADS') {
    if (key === 'smg') inspectSmgSight(w);
    for (const name of ['sight_front', 'sight_rear']) {
      const [x, y] = projectionOf(vm.anchorCam(name, new Vector3()));
      measure(name + '.error óptico.px', Math.hypot((x-.5)*1280,(y-.5)*720), 0, 1e-6);
    }
  }
  for (const lado of ['L', 'R']) {
    const r = vm.arms.rig.out[lado], brazal = glove.get(vm.arms.seg[lado].fore);
    const eje = xyz(0, 1, 0).applyQuaternion(r.fore.quat);
    measure(lado + '.muñeca.°', eje.angleTo(xyz(0,0,1).applyQuaternion(r.hand.quat)) * rad, 0, 15);
    prepare(brazal);
    const puno = punos[lado];
    prepare(puno);
    measure(lado + '.unión del collar.mm', Math.min(clearance(puno, [brazal]), clearance(brazal, [puno])), -Infinity, 0);
  }
  const vista = silhouette(vm, P, 1280, 720);
  if (phase.startsWith('recarga/') || phase.startsWith('vacía/')) {
    if (!phase.endsWith('/regreso') && !phase.endsWith('/pump')) tiempoOculta = medirRecarga(w, vista, tiempoOculta, 1/hz);
  } else tiempoOculta = 0;
  if (w.prof.grips.left.pose === 'libre' && (stable || phase === 'disparo')) {
    const izquierda = vista.names.map(n => /^fp_(?:L_|fore_L$|hand_L$)/.test(n));
    measure('izquierda en cuadro.px', vista.owner.reduce((n,id) => n + izquierda[id], 0), 0, 0);
    if (stable) {
      const derecha = vista.names.map(n => /^fp_(?:R_|fore_R$|hand_R$)/.test(n));
      measure('mano y antebrazo derechos visibles.%', 100 * vista.owner.reduce((n,id) => n + derecha[id], 0) / vista.owner.length, 3, 100);
    }
  }
  inspeccionarDedos(w, phase, vista);
  inspectFragments(w, vista);
  let triangulos = 0, llamadas = 0;
  vm.root.traverseVisible(o => {
    if (!o.isMesh) return;
    triangulos += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
    llamadas += Array.isArray(o.material) ? o.geometry.groups.length : 1;
  });
  measure('triángulos dibujados', triangulos, 0, 45000);
  measure('llamadas de dibujo', llamadas, 0, 12);
  if (w.mesh.visible) {
    const piezas = [...weaponGeo.values()];
    piezas.forEach(prepare);
    for (const lado of ['L','R']) {
      let intrusion = 0, intrusionDedos = 0;
      for (const placa of piel[lado]) {
        const profundidad = -clearance(placa, piezas, 0);
        intrusion = Math.max(intrusion, profundidad);
        if (!placa.bone.name.endsWith('wrist')) intrusionDedos = Math.max(intrusionDedos, profundidad);
      }
      measure(lado + '.penetración máxima.mm', intrusion, 0, largas.has(key) ? 0 : 1);
      measure(lado + '.penetración de falanges.mm', intrusionDedos, 0, largas.has(key) ? 0 : .01);
    }
  }
  if (w.prof.grips.left.pose === 'libre') {
    // La mano que entra a por la pieza debe librar la dominante en ambos sentidos.
    piel.L.forEach(prepare);
    piel.R.forEach(prepare);
    let cruce = 0;
    for (const placa of piel.L) cruce = Math.max(cruce, -clearance(placa, piel.R, 0));
    for (const placa of piel.R) cruce = Math.max(cruce, -clearance(placa, piel.L, 0));
    measure('cruce entre guantes.mm', cruce, 0, 0);
  }
  if (w.prof.grips.left.pose === 'libre' && a.action === 'reload' && a.left[3] > .98 && a.mag === 0) {
    const palma = piel.L.find(p => p.bone.name === 'fp_L_wrist');
    distanciaPalma = Math.min(distanciaPalma, Math.abs(clearance(palma, [weaponGeo.get(w.roles.mag.bone)])));
  }
  if (stable && key === 'smg' && hz === 60) {
    const cuerpo = weaponGeo.get(w.partBones.body.bone);
    measure('yema sobre el costado.mm', 1000*distanciaYema(vm, 'L', 'thumb', [costado]), 0, 1);
    measure('hueco proyectado de la yema.px', Math.round(distanciaYema(vm, 'L', 'thumb', [costado], P)), 0, 0);
    for (const parte of ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal']) {
      measure('holgura.' + parte + '.mm', holguraBlindaje(vm, cuerpo, parte), -.01, parte.endsWith('distal') || parte === 'wrist' ? 1 : Infinity);
    }
  }
  // Una pieza rígida sigue siendo el apoyo durante el retroceso, el bombeo
  // y los movimientos de cámara. Durante una entrega sólo se exige contacto
  // a la mano que conserva su agarre.
  const movimiento = ['entrada ADS', 'salida ADS', 'esquiva', 'cambio', 'entrada del cambio', 'golpe', 'disparo'].includes(phase);
  const recarga = phase.startsWith('recarga/') || phase.startsWith('vacía/');
  for (const lado of ['L', 'R']) {
    if (lado === 'L' && (!w.prof.targets.forend.anchor || w.prof.grips.left.pose === 'libre')) continue;
    const conserva = movimiento || (recarga && (lado === 'L' ? w.prof.scope : !w.prof.scope))
      || (['preparación', 'suelta'].includes(phase) && lado === 'R' && (a.rOpen < .00001 || w.prof.grips.left.pose === 'libre') && w.mesh.visible);
    if (!stable && !conserva) continue;
    for (const dedo of fingers) {
      if (lado === 'R' && dedo === 'index' && w.roles.trigger && a.trigger > .00001) continue;
      measure(lado + '.' + dedo + '.contacto.mm', 1000*distanciaYema(vm,lado,dedo,apoyos(lado,dedo)), 0, 1);
    }
  }
  if (w.roles.trigger && phase === 'disparo' && a.trigger > .99) {
    measure('índice en el gatillo.mm', 1000 * distanciaYema(vm, 'R', 'index', [weaponGeo.get(w.roles.trigger.bone)]), 0, 1);
  }
  if (a.mag > .98 && !a.magHide && w.roles.mag) for (const dedo of ['index', 'thumb']) {
    measure('pinza.' + dedo + '.cargador.mm', 1000 * distanciaYema(vm, 'L', dedo, [weaponGeo.get(w.roles.mag.bone)]), 0, 1);
  }
  if (w.prof.scope && a.boltHand > .999) {
    for (const dedo of ['index','thumb']) measure('pinza.' + dedo + '.cerrojo.mm',
      1000 * distanciaYema(vm, 'R', dedo, [weaponGeo.get(w.roles.bolt.bone)]), 0, 1);
  }
  if (w.ring && a.action === 'throw' && a.left[3] > .99999 && !w.ring.seated) {
    pinzaAntes = true;
    for (const dedo of ['index', 'thumb']) measure('anilla antes de tirar.' + dedo + '.mm',
      1000 * distanciaYema(vm, 'L', dedo, [weaponGeo.get(w.partBones.pin.bone)]), 0, 1);
  }
  if (w.prof.thrown && a.rOpen > .99999) {
    const { joints, poses } = vm.arms.anatomy.R;
    measure('suelta con la mano abierta.°', Math.max(...joints.map((b,i) =>
      b.quaternion.angleTo(poses.abierta[i]) * rad)), 0, .05);
  }
  if (w.ring?.held) {
    ringPulled = true;
    for (const dedo of ['index','thumb']) {
      const d = distanciaYema(vm, 'L', dedo, [weaponGeo.get(w.partBones.pin.bone)]) * 1000;
      ringGap = Math.min(ringGap, d);
      measure('anilla.' + dedo + '.mm', d, 0, 1);
    }
  }
}

function run(key, rate) {
  hz = rate;
  const dt = 1 / hz, state = { speed: 0, bob: 0, shake: 0, aim01: 0, reloadT: 0, fireHeld: false };
  function reset() {
    vm.key = null; vm.anim = null; vm.setWeapon(key);
    Object.assign(state, { aim01: 0, reloadT: 0, fireHeld: false });
    for (let i = 0; i < hz; i++) vm.update(dt, state);
  }
  function sample(total, phase, before, after) {
    const n = Math.ceil(total * hz);
    for (frame = 1; frame <= n; frame++) {
      const label = before?.((frame - 1) / n, frame / n);
      vm.update(dt, state); inspect(key, label || phase);
      after?.(frame / n);
    }
  }
  reset(); frame = 0; inspect(key, 'cadera');
  state.aim01 = 1;
  sample(.45, 'entrada ADS');
  for (let i = 0; i < 3 * hz; i++) vm.update(dt, state);
  if (vm.prof.scope && vm.scopeIn01() >= .98) vm.update(0, state, 'scope');
  inspect(key, 'ADS');
  state.aim01 = 0; sample(.45, 'salida ADS');
  reset(); sample(.35, 'esquiva', t => { state.dodge = dodgeFX({ t: t*.35, x: 1, z: 0 }, 0, { bob: 1, shake: 1 }); });
  state.dodge = null;
  const tuning = TUNING.weapons[key], p = PROFILES[key];
  if (!p.thrown) {
    reset(); vm.event('fire'); state.fireHeld = true;
    sample(0.65, 'disparo', (_, u) => { state.fireHeld = u < 0.55; });
    const casos = ['cadera', 'ADS'];
    if (p.reloadEmpty && key !== 'stun') casos.push('vacía');
    for (const caso of casos) {
      reset();
      const empty = caso === 'vacía';
      if (caso === 'ADS') {
        state.aim01 = 1;
        for (let i = 0; i < 2*hz; i++) vm.update(dt, state);
      }
      if (empty) { vm.event('fire', { empty: true }); for (let i = 0; i < hz; i++) vm.update(dt, state); }
      const total = tuning.reloadTime, steps = (empty ? p.reloadEmpty : p.reload).steps || [];
      const prefix = empty ? 'vacía/' : caso === 'ADS' ? 'recarga/ADS/' : 'recarga/';
      const celda = key === 'stun', automatica = tuning.mag === 1;
      if (automatica) {
        vm.event('fire', { empty: true });
        vm.update(dt, { ...state, fireHeld: true });
      }
      if (celda) vm.event('fire', { recambio: 60/tuning.rpm });
      else vm.event('reloadStart', { total });
      for (let shell = 0; shell < (p.reload.perShell ? 2 : 1); shell++) {
        piezaEnMano = 0;
        distanciaPalma = Infinity;
        let stage = p.reload.perShell ? 'cartucho' + (shell + 1) : 'inicio';
        sample(total, '', (prev, t) => {
          state.reloadT = celda ? 0 : t;
          state.fireHeld = (automatica || celda) && t*total < .13;
          for (const s of steps) if (prev < s.t && t >= s.t) { if (!celda) vm.event('reloadStep', { name: s.step }); stage = s.step; }
          return prefix + stage;
        }, hz === 60 ? () => inspectReload(vm.weapons[key]) : undefined);
        if (p.grips.left.pose === 'libre') measure('golpe de palma sobre la tapa.mm', distanciaPalma, 0, 1);
        if (key !== 'sniper') measure('pieza y mano visibles durante el transporte.px', piezaEnMano, 128, Infinity);
      }
      if (p.reload.perShell) vm.event('reloadStep', { name: 'pump' });
      if (!celda) vm.event('reloadEnd');
      state.reloadT = 0;
      sample(0.45, prefix + (p.reload.perShell ? 'pump' : 'regreso'), undefined,
        hz === 60 && p.reload.perShell ? () => inspectReload(vm.weapons[key]) : undefined);
    }
  }
  function comprobarRegreso() {
    for (let i = 0; i < hz; i++) vm.update(dt, state);
    for (const lado of p.targets.forend.anchor && p.grips.left.pose !== 'libre' ? ['L','R'] : ['R']) for (const dedo of fingers) {
      measure('regreso.' + lado + '.' + dedo + '.mm', 1000*distanciaYema(vm,lado,dedo,apoyos(lado,dedo)), 0, 1);
    }
  }
  comprobarRegreso();
  reset(); vm.event('swapStart', { total: 0.55 }); sample(0.55, 'cambio');
  comprobarRegreso();
  // En swapMid el adaptador equipa el modelo nuevo antes de subirlo.
  vm.setWeapon(key === 'smg' ? 'pistol' : 'smg');
  vm.update(dt, state);
  vm.setWeapon(key);
  vm.event('swapStart', { total: SWAP_TIME, draw: true });
  sample(SWAP_TIME/2, 'entrada del cambio', (_, u) => { state.swapping = .5 + u/2; });
  state.swapping = 0;
  reset(); vm.event('meleeStart', { total: 0.6, hitAt: 0.38 }); sample(0.6, 'golpe');
  comprobarRegreso();
  reset();
  const total = tuning.throwTime ?? 0.8, rel = p.thrown ? tuning.throwRelease / total : p.throw.releaseAt;
  vm.event('throwStart', { total, release: rel });
  ringGap = Infinity;
  ringPulled = false;
  pinzaAntes = false;
  sample(total, 'lanzamiento', (prev, t) => {
    if (prev < rel && t >= rel) vm.event('throwRelease');
    return t < rel ? 'preparación' : 'suelta';
  });
  comprobarRegreso();
  if (p.thrown) {
    row = rows.get(key + ' preparación');
    measure('L.contacto efectivo con la anilla.mm', ringGap, -1, 2);
    measure('pinza estable antes de extraer la anilla', Number(pinzaAntes), 1, 1);
    measure('L.anilla acompañó al índice', Number(ringPulled), 1, 1);
  }
}

const seleccion = process.argv.slice(2);
for (const key of seleccion.length ? seleccion : Object.keys(PROFILES)) {
  assert.ok(PROFILES[key], 'Arma desconocida: ' + key);
  vm.setWeapon(key);
  glove = surfaces(vm.armsMesh, b => b.name.startsWith('fp_fore_'));
  weaponGeo = surfaces(vm.weapons[key].mesh);
  piel = Object.fromEntries(['L','R'].map(lado => [lado, [...surfaces(vm.armsMesh,
    b => b.name.startsWith('fp_' + lado + '_'), undefined, true).values()]]));
  {
    apoyos = apoyosDelArma(vm, vm.weapons[key], weaponGeo);
    if (key === 'smg') costado = costadoSMG(vm.weapons[key]);
    if (key === 'bazooka') lomoTrasero = lomoDeLaBazuca(vm.weapons[key]);
    punos = {};
    for (const lado of ['L', 'R']) {
      const mano = assets.arms.getObjectByName('anatomica_' + lado);
      const geo = mano.children[mano.userData.primitivaPuno].geometry.toNonIndexed();
      geo.setAttribute('skinIndex', geo.attributes._fp_joints);
      const hueso = vm.arms.seg[lado].hand;
      punos[lado] = surfaces({ geometry: geo, skeleton: { bones: [hueso] } }).get(hueso);
    }
  }
  for (const rate of [30, 60, 144]) run(key, rate);
  for (const [id, metrics] of rows) {
    console.log('\n' + id + ' · 30/60/144 Hz\nmedida\tmínimo\tmáximo\tprimer fallo (Hz/cuadro=valor)');
    for (const [name, m] of metrics) console.log([name, m.min.toFixed(3), m.max.toFixed(3), m.bad || 'OK'].join('\t'));
  }
  rows.clear();
}
console.table(framing);
console.log('\ncheck-fps-hands · ' + failures + ' incumplimientos por arma, fase y medida');
process.exitCode = failures ? 1 : 0;
