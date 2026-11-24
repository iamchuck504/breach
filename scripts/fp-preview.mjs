// Vista de taller sin WebGL. La oclusión, la piel y la proyección se comparten con las pruebas.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateSync, crc32 } from 'node:zlib';
import { Color, Matrix3, Matrix4, PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createViewModel } from '../src/view/fp/viewmodel.js';
import { PROFILES } from '../src/view/fp/profiles.js';
import { silhouette } from '../src/view/fp/silhouette.js';
import { viewModelUniforms } from '../src/render/pipeline.js';
import { TUNING } from '../src/config/tuning.js';
import { SWAP_TIME } from '../src/combat/weapons.js';
import { palette } from '../src/look/fortaleza/palette.js';

const armas = ['smg', 'shotgun', 'sniper', 'bazooka', 'pistol', 'stun', 'grenade', 'frag'];
const ancho = 1280, alto = 720;

export async function crearBanco() {
  const assets = {};
  for (const id of ['arms', 'kick-leg', ...armas]) {
    const bytes = await readFile(new URL('../public/assets/fp/' + id + '.glb', import.meta.url));
    assets[id] = (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '')).scene;
  }
  const camera = new PerspectiveCamera(72, ancho / alto, .03, 500);
  const vm = createViewModel({ scene: new Scene(), camera, assets, team: 'red' });
  await vm.ready;
  return vm;
}
export function posar(vm, arma, pose) {
  const match = /^(cadera|ads|disparo|bombeo|suelta|recarga|lanzar|cambio)(?::(\d+(?:\.\d+)?|\.\d+))?$/.exec(pose);
  if (!match) throw Error('Pose desconocida: ' + pose);
  let [, gesto, fase] = match;
  if (['recarga', 'lanzar', 'cambio'].includes(gesto) !== (fase !== undefined) || Number(fase) > 1) throw Error('Fase inválida: ' + pose);
  vm.key = vm.anim = null;
  if (!vm.setWeapon(arma)) throw Error('Arma desconocida: ' + arma);
  const s = { speed: 0, aim01: Number(gesto === 'ads'), reloadT: 0, wallNear: 0 };
  for (let i = 0; i < 90; i++) vm.update(1/60, s);
  if (gesto === 'ads' && vm.prof.scope && vm.scopeIn01() >= .98) vm.update(0, s, 'scope');
  if (gesto === 'cadera' || gesto === 'ads') return;
  const def = TUNING.weapons[arma];
  const bomba = gesto === 'bombeo', inicioBote = gesto === 'disparo' && def.thrown;
  if (bomba) {
    if (arma !== 'shotgun') throw Error('El bombeo requiere la escopeta');
    gesto = 'disparo';
  }
  if (gesto === 'suelta') {
    if (!def.thrown) throw Error('La suelta requiere un arma arrojadiza');
    gesto = 'lanzar';
    fase = def.throwRelease / def.throwTime;
  }
  // El disparador de un bote inicia su lanzamiento. En la hoja de recarga
  // se muestra sujeto, pues estas dos armas carecen de esa acción.
  if (PROFILES[arma].thrown) {
    if (gesto === 'recarga') return;
    if (gesto === 'disparo') { gesto = 'lanzar'; fase = .05 / def.throwTime; }
  }
  s.fireHeld = gesto === 'disparo';
  const total = gesto === 'cambio' ? SWAP_TIME : gesto === 'recarga' ? TUNING.weapons[arma].reloadTime || 1 : TUNING.weapons[arma].throwTime || .8;
  const evento = { disparo: 'fire', recarga: 'reloadStart', lanzar: 'throwStart', cambio: 'swapStart' }[gesto];
  const release = (TUNING.weapons[arma].throwRelease ?? total * (PROFILES[arma].throw.releaseAt ?? .6)) / total;
  const automatica = gesto === 'recarga' && def.mag === 1;
  if (automatica) {
    vm.event('fire', { empty: true });
    vm.update(1/60, { ...s, fireHeld: true });
  }
  const celda = arma === 'stun' && (gesto === 'recarga' || gesto === 'disparo');
  vm.event(celda ? 'fire' : evento, { total, release, empty: gesto === 'disparo' && def.mag === 1, recambio: celda ? 60 / def.rpm : 0 });
  const ciclo = PROFILES[arma].cycle;
  const tiempo = bomba ? ciclo.delay + .44 * ciclo.dur : gesto === 'disparo' || inicioBote ? .05 : fase * total;
  const pasos = Math.max(1, Math.ceil(tiempo * 60));
  for (let i = 1; i <= pasos; i++) {
    const u = i * tiempo / pasos / total, previo = (i - 1) * tiempo / pasos / total;
    if (gesto === 'disparo') {
      const transcurrido = i * tiempo / pasos;
      s.fireHeld = transcurrido < .13;
      // La siguiente actualización de Weapons inicia la recarga automática.
      if (def.mag === 1 && i >= 2) {
        if (i === 2) vm.event('reloadStart', { total: def.reloadTime });
        s.reloadT = (transcurrido - tiempo / pasos) / def.reloadTime;
      }
    }
    if (gesto === 'recarga' && (celda || automatica)) s.fireHeld = u * total < .13;
    if (gesto === 'cambio') s.swapping = u;
    if (gesto === 'recarga' && !celda) {
      s.reloadT = u;
      for (const paso of PROFILES[arma].reload.steps ?? []) if (previo < paso.t && u >= paso.t) vm.event('reloadStep', { name: paso.step });
    }
    if (gesto === 'lanzar' && previo < release && u + 1e-9 >= release) vm.event('throwRelease');
    vm.update(tiempo / pasos, s);
  }
}
export function dibujar(vm) {
  // En Fortaleza el sol está en (−18, 20, −11). Desde el punto de salida
  // rojo la cámara mira hacia +Z del mundo.
  const sol = new Vector3(18, 20, 11).normalize();
  const { light, grade } = palette;
  const cielo = new Color(light.hemiSky), suelo = new Color(light.hemiGround);
  const directa = new Color(light.sun), ambiente = new Color(light.amb);
  const rebote = cielo.clone().add(suelo).multiplyScalar(light.hemiIntensity / 2)
    .add(ambiente.clone().multiplyScalar(light.ambIntensity));
  const luma = (r, g, b) => .2126*r + .7152*g + .0722*b;
  const l = luma(rebote.r, rebote.g, rebote.b);
  rebote.multiplyScalar(Math.max(.045, Math.min(.10, .20*l)) / l);
  const normal = new Vector3(), local = new Vector3(), medio = new Vector3(), ojo = new Vector3(), reflejo = new Vector3();
  const inversa = vm.root.matrixWorld.clone().invert(), marcos = new WeakMap();
  const limitar = v => Math.max(0, Math.min(1, v));
  const suave = (a, b, x) => { const t = limitar((x-a)/(b-a)); return t*t*(3-2*t); };
  const srgb = v => v <= .00313 ? 12.92*v : 1.055*v**(1/2.4)-.055;
  const canales = ['r', 'g', 'b'], colorFinal = [0, 0, 0], clip = viewModelUniforms.uVMProj.value.elements;
  // Mismo orden que la composición del juego: exposición, curva neutra,
  // sRGB, tinte de sombras, contraste, saturación y viñeta.
  function graduar(rgb, p) {
    const pico = Math.max(...rgb);
    if (pico >= .76) {
      const cima = 1 - .24**2 / (pico + .24 - .76), g = 1 - 1/(1 + .15*(pico-cima));
      for (let k = 0; k < 3; k++) rgb[k] = (1-g)*rgb[k]*cima/pico + g*cima;
    }
    for (let k = 0; k < 3; k++) rgb[k] = srgb(limitar(rgb[k]));
    const t = suave(.08,.78,luma(...rgb));
    for (let k = 0; k < 3; k++) {
      const v = limitar(rgb[k]*(grade.shadows[k]*(1-t) + grade.highs[k]*t)), piv = grade.pivot;
      rgb[k] = v < piv ? piv*(v/piv)**(1+grade.contrast) : 1-(1-piv)*((1-v)/(1-piv))**(1+grade.contrast);
    }
    const luz = luma(...rgb), radio = .625 * Math.hypot(p.x*clip[0]*ancho/alto, p.y*clip[5]) / Math.max(.001,-p.z);
    const vineta = 1-grade.vignette*suave(.42,1.12,radio);
    let salida = 0xff000000;
    for (let k = 0; k < 3; k++) salida |= Math.round(255*limitar(vineta*(luz+(rgb[k]-luz)*grade.saturation))) << (8*k);
    return salida;
  }
  // Aproximación hemisférica del entorno prefiltrado de Fortaleza. La captura
  // de referencia se toma en la sombra de la muralla, frente al patio.
  const cenit = new Color(palette.sky.stops[0][1]);
  const horizonte = new Color(palette.sky.stops[2][1]);
  const tierra = new Color(light.fog);
  function entorno(c, y) {
    const boveda = horizonte[c] + (cenit[c] - horizonte[c]) * suave(0, .85, y);
    return tierra[c] + (boveda - tierra[c]) * suave(-.16, .16, y);
  }
  function iluminar(mesh, primero, puntos) {
    const { color, aSurf, skinIndex, skinWeight } = mesh.geometry.attributes;
    if (!marcos.has(mesh)) {
      marcos.set(mesh, mesh.skeleton.bones.map((hueso, i) => {
        const m = new Matrix4().multiplyMatrices(inversa, hueso.matrixWorld).multiply(mesh.skeleton.boneInverses[i]);
        return new Matrix3().getNormalMatrix(m);
      }));
    }
    const matrices = marcos.get(mesh), uniformes = mesh.material.userData.fpUniforms;
    const equipo = uniformes.uTeam.value;
    return puntos.map((punto, j) => {
      const i = primero + j;
      normal.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const peso = skinWeight.getComponent(i, k);
        if (!peso) continue;
        local.fromBufferAttribute(mesh.geometry.attributes.normal, i).applyMatrix3(matrices[skinIndex.getComponent(i, k)]);
        normal.addScaledVector(local, peso);
      }
      normal.normalize();
      const hemisferio = .5 + .5 * normal.y;
      // Fracción de sol y contribuciones difusa/especular del cielo ajustadas
      // contra píxeles interiores de las capturas v4/v5, antes de la gradación.
      const lambert = .035 * Math.max(0, normal.dot(sol));
      ojo.copy(punto).normalize().negate();
      medio.copy(ojo).add(sol).normalize();
      const rugosidad = aSurf.getX(i), metal = aSurf.getY(i);
      const brillo = Math.pow(Math.max(0, normal.dot(medio)), 7 + (1 - rugosidad) * 38);
      const t = aSurf.getW(i), frente = limitar(normal.dot(ojo)), canto = (1-frente)**4;
      const cieloReflejado = suave(-.3-rugosidad*.4,.45+rugosidad*.4,reflejo.copy(ojo).negate().reflect(normal).y);
      for (const [k, c] of canales.entries()) {
        const base = t > .02 ? equipo[c] * (t > .75 ? .86 : .46) : color.getComponent(i, k);
        const indirecta = (suelo[c] + hemisferio*(cielo[c]-suelo[c]))*light.hemiIntensity + ambiente[c]*light.ambIntensity;
        const difusa = (indirecta + directa[c]*light.sunIntensity*lambert) * base*(1-metal)/Math.PI;
        const tinte = .04*(1-metal) + base*metal;
        const relleno = rebote[c]*(base*(.45+.65*frente) + (tinte*(1-canto)+.85*canto)*(.18+1.8*cieloReflejado));
        const difusoEntorno = (tierra[c] + (horizonte[c] - tierra[c]) * hemisferio) * base * (1-metal);
        const especularEntorno = entorno(c, reflejo.y) * (tinte + (1-tinte)*canto);
        const entornoMapa = .14 * difusoEntorno + .20 * especularEntorno;
        const filo = equipo[c] * canto * (uniformes.uRim?.value ?? 0);
        colorFinal[k] = grade.exposure*(difusa + entornoMapa + relleno + filo + brillo*tinte*lambert + (t > .02 ? equipo[c] : base)*aSurf.getZ(i)*8);
      }
      return graduar(colorFinal, punto);
    });
  }
  return silhouette(vm, viewModelUniforms.uVMProj.value, ancho, alto, false, iluminar);
}
function png(ancho, alto, rgb) {
  function bloque(nombre, datos) {
    const salida = Buffer.alloc(12 + datos.length);
    salida.writeUInt32BE(datos.length);
    salida.write(nombre, 4);
    datos.copy(salida, 8);
    salida.writeUInt32BE(crc32(salida.subarray(4, -4)), salida.length - 4);
    return salida;
  }
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8;
  cabecera[9] = 2;
  // El primer byte de cada fila selecciona el filtro PNG sin predicción.
  const fila = ancho * 3, datos = Buffer.alloc(alto * (fila + 1));
  for (let y = 0; y < alto; y++) rgb.copy(datos, y * (fila + 1) + 1, y * fila, (y + 1) * fila);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloque('IHDR', cabecera), bloque('IDAT', deflateSync(datos)), bloque('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pose: { type: 'string', default: 'cadera' },
      zoom: { type: 'string' },
      mano: { type: 'string' },
      out: { type: 'string', default: 'fp-preview.png' },
      hoja: { type: 'boolean' },
    },
  });
  if (positionals.length > 1 || (positionals.length && !armas.includes(positionals[0]))) throw Error('Arma inválida');
  const ids = values.hoja ? armas : [positionals[0] ?? 'smg'];
  const vm = await crearBanco();
  let mano;
  if (values.mano) {
    if (!['L','R','ambas'].includes(values.mano) || values.hoja || values.zoom) throw Error('Indica una mano y un arma para el recorte automático');
    posar(vm, ids[0], values.pose);
    const lados = values.mano === 'ambas' ? ['L','R'] : [values.mano];
    const { x, y, width, height } = vm.handScreenRect(lados, ancho, alto);
    mano = [x, y, width, height];
  }
  const recorte = mano ?? (values.zoom ? values.zoom.split(',').map(Number) : [0, 0, ancho, alto]);
  const [x0, y0, w, h] = recorte;
  if (recorte.length !== 4 || !recorte.every(Number.isInteger) || x0 < 0 || y0 < 0 ||
      w < 1 || h < 1 || x0 + w > ancho || y0 + h > alto) throw Error('Recorte fuera del cuadro');
  const escala = mano || values.zoom ? 3 : 1, columnas = values.hoja ? 2 : 1;
  const celdaX = w * escala, celdaY = h * escala;
  const totalX = columnas * celdaX, totalY = ids.length / columnas * celdaY;
  const rgb = Buffer.alloc(totalX * totalY * 3);
  for (const [n, id] of ids.entries()) {
    if (!mano) posar(vm, id, values.pose);
    const { rgba } = dibujar(vm);
    const origenX = (n % columnas) * celdaX, origenY = Math.floor(n / columnas) * celdaY;
    for (let y = 0; y < celdaY; y++) {
      const fila = (y0 + Math.floor(y / escala)) * ancho + x0;
      for (let x = 0; x < celdaX; x++) {
        const c = rgba[fila + Math.floor(x / escala)] || 0x8195a6;
        const i = ((origenY + y) * totalX + origenX + x) * 3;
        rgb[i] = c;
        rgb[i + 1] = c >>> 8;
        rgb[i + 2] = c >>> 16;
      }
    }
  }
  await writeFile(values.out, png(totalX, totalY, rgb));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
