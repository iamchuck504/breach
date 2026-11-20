// Capa de vida "signs" del look de Azoteas (contrato en ../index.js): los
// CUATRO letreros legibles de la ciudad, cada uno sobre un edificio de la
// cuadrícula (./city-plan.js, ./signage.js) y mirando a una calle:
//   · VELARDE: letras de neón ámbar sobre bastidor de acero, en una azotea
//     al otro lado de la avenida este
//   · CAFÉ ORIENTE: valla en bastidor sobre una azotea de la calle sur,
//     iluminada por sus propios reflectores
//   · HOTEL CASSIA: bandera vertical en la fachada alta de la calle norte
//     (zumba de vez en cuando)
//   · MERIDIANO: rótulo de letras blancas en el remate de unas oficinas,
//     avenida oeste
// Dos llamadas de dibujo: la estructura (bastidores, ménsulas, reflectores)
// y las caras luminosas (un atlas pintado una vez en un canvas, suma
// aditiva, HDR en el núcleo de los tubos). El parpadeo es el mismo que el de
// su luz en ./surfaces.js.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FOG_GLSL, shaderMat } from './shared.js';
import { SPILL, MAX_SPILL, signSpots } from './signage.js';

const AW = 2048, AH = 1024;
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const NARROW = '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

// Regiones [x, y, ancho, alto] en píxeles (proporción = la del letrero en m)
const R = {
  hotel: [0, 0, 150, 1020],
  velarde: [160, 0, 1100, 260],
  billboard: [160, 270, 1000, 400],
  meridiano: [160, 680, 1200, 130],
};

function hot(hex, k) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const m = (c) => Math.round(c + (255 - c) * k);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
function fitFont(g, text, weight, family, size, maxW) {
  g.font = `${weight} ${size}px ${family}`;
  const w = g.measureText(text).width;
  if (w > maxW) { size = Math.floor(size * maxW / w); g.font = `${weight} ${size}px ${family}`; }
  return size;
}
// tubo de neón: halo, tubo de color y núcleo casi blanco
function tube(g, draw, hex, lw, { halo = 24, core = 0.72 } = {}) {
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = css(hex); g.shadowColor = css(hex);
  g.globalAlpha = 0.55; g.shadowBlur = halo; g.lineWidth = lw * 1.6; draw();
  g.globalAlpha = 1; g.shadowBlur = halo * 0.4; g.lineWidth = lw; draw();
  g.shadowBlur = 0; g.strokeStyle = hot(hex, core); g.lineWidth = lw * 0.38; draw();
  g.restore();
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function paintAtlas(THREE, P) {
  const cv = document.createElement('canvas');
  cv.width = AW; cv.height = AH;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, AW, AH);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const N = P.neon;

  { // HOTEL CASSIA: letras apiladas blanco cálido, marco ámbar
    const [x, y, w, h] = R.hotel;
    tube(g, () => { roundRect(g, x + 18, y + 18, w - 36, h - 36, 22); g.stroke(); }, N.amber, 7);
    g.font = `500 108px ${SANS}`;
    [...'HOTEL'].forEach((ch, i) => tube(g, () => g.strokeText(ch, x + w / 2, y + 100 + i * 125), N.warm, 8, { core: 0.8 }));
    g.save(); g.translate(x + w / 2, y + h - 150); g.rotate(-Math.PI / 2);
    fitFont(g, 'CASSIA', 500, SANS, 60, 200);
    tube(g, () => g.strokeText('CASSIA', 0, 0), N.amber, 5, { halo: 14 });
    g.restore();
  }
  { // VELARDE: letras de canal con tubo expuesto, ámbar
    const [x, y, w, h] = R.velarde;
    fitFont(g, 'VELARDE', 800, NARROW, 230, w - 60);
    g.save(); g.shadowColor = css(N.amber); g.shadowBlur = 28; g.fillStyle = css(N.amber);
    g.globalAlpha = 0.8; g.fillText('VELARDE', x + w / 2, y + h / 2 + 6); g.restore();
    g.save(); g.strokeStyle = hot(N.amber, 0.75); g.lineWidth = 4; g.lineJoin = 'round';
    g.strokeText('VELARDE', x + w / 2, y + h / 2 + 6); g.restore();
  }
  { // valla impresa CAFÉ ORIENTE, más clara arriba (los reflectores están ahí)
    const [x, y, w, h] = R.billboard;
    g.fillStyle = '#d9cdb4'; g.fillRect(x, y, w, h);
    g.fillStyle = '#2f4a3a'; g.fillRect(x, y + h * 0.72, w, h * 0.28);
    // taza: silueta simple
    g.fillStyle = '#4a2f22';
    g.beginPath(); g.moveTo(x + 120, y + 120); g.lineTo(x + 300, y + 120); g.lineTo(x + 280, y + 260); g.lineTo(x + 140, y + 260); g.closePath(); g.fill();
    g.lineWidth = 16; g.strokeStyle = '#4a2f22'; g.beginPath(); g.arc(x + 305, y + 175, 34, -1.2, 1.2); g.stroke();
    g.fillStyle = '#4a2f22'; g.fillRect(x + 100, y + 262, 220, 10);
    g.fillStyle = '#3a2a20'; g.textAlign = 'left';
    fitFont(g, 'CAFÉ ORIENTE', 700, SERIF, 110, w - 430);
    g.fillText('CAFÉ ORIENTE', x + 380, y + 150);
    fitFont(g, 'tostado desde 1952', 400, SERIF, 46, w - 430);
    g.fillText('tostado desde 1952', x + 384, y + 230);
    g.fillStyle = '#e9e1cf';
    fitFont(g, 'oriente.cafe', 500, SANS, 40, 400);
    g.fillText('oriente.cafe', x + 40, y + h * 0.86);
    g.textAlign = 'center';
    // luz de los reflectores: fuerte arriba, cae hacia abajo
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = grad; g.fillRect(x, y, w, h);
  }
  { // MERIDIANO: letras blancas retroiluminadas, sin caja
    const [x, y, w, h] = R.meridiano;
    fitFont(g, 'MERIDIANO', 600, SANS, 110, w - 40);
    g.save(); g.shadowColor = '#dfe8ff'; g.shadowBlur = 18; g.fillStyle = '#f2f6ff';
    g.fillText('MERIDIANO', x + w / 2, y + h / 2 + 4); g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const uvRect = ([x, y, w, h]) => [x / AW, 1 - (y + h) / AH, (x + w) / AW, 1 - y / AH];

function faces(S) {
  const i = (id) => SPILL.findIndex((s) => s.id === id);
  const out = [];
  if (S.hotel) {
    const { x, y, z, w, h } = S.hotel;
    out.push({ s: i('hotel'), r: R.hotel, c: [x + 0.2, y, z], n: [1, 0, 0], w, h, gain: 2.6, base: 1.1 });
    out.push({ s: i('hotel'), r: R.hotel, c: [x - 0.2, y, z], n: [-1, 0, 0], w, h, gain: 2.6, base: 1.1 });
  }
  if (S.velarde) { const { x, y, z, w, h } = S.velarde; out.push({ s: i('velarde'), r: R.velarde, c: [x, y, z], n: [-1, 0, 0], w, h, gain: 2.2, base: 1.2 }); }
  if (S.billboard) { const { x, y, z, w, h } = S.billboard; out.push({ s: i('billboard'), r: R.billboard, c: [x, y, z + 0.02], n: [0, 0, 1], w, h, gain: 0, base: 0.55 }); }
  if (S.meridiano) { const { x, y, z, w, h } = S.meridiano; out.push({ s: i('meridiano'), r: R.meridiano, c: [x, y, z], n: [1, 0, 0], w, h, gain: 0.6, base: 1.1 }); }
  return out;
}

const VERT = /* glsl */`
attribute vec2 aS; // letrero, ganancia del núcleo
attribute float aBase;
varying vec2 vUv; varying vec3 vS; varying float vDist;
void main() {
  vUv = uv; vS = vec3(aS, aBase);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
uniform sampler2D uAtlas;
uniform float uLkSpillK[${MAX_SPILL}];
varying vec2 vUv; varying vec3 vS; varying float vDist;
${FOG_GLSL}
void main() {
  vec3 c = texture2D(uAtlas, vUv).rgb;
  float k = 1.0;
  for (int j = 0; j < ${MAX_SPILL}; j++) k = abs(float(j) - vS.x) < 0.5 ? uLkSpillK[j] : k;
  // núcleo casi blanco -> por encima de 1 (florece con la cadena de imagen;
  // sin ella se satura a blanco y el halo pintado sigue ahí)
  float core = smoothstep(0.55, 0.95, min(min(c.r, c.g), c.b));
  vec3 e = c * k * (vS.z + vS.y * core);
  e *= 1.0 - azFog(vDist) * 0.6;
  gl_FragColor = vec4(e, 1.0);
  #include <colorspace_fragment>
}`;

function buildFaces(ctx, tex, S) {
  const { THREE } = ctx;
  const pos = [], uv = [], aS = [], aBase = [], idx = [];
  for (const f of faces(S)) {
    const [cx, cy, cz] = f.c, [nx, , nz] = f.n;
    const rx = nz, rz = -nx; // derecha = arriba × normal
    const [u0, v0, u1, v1] = uvRect(f.r);
    const base = pos.length / 3;
    for (const [sx, sy, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]]) {
      pos.push(cx + rx * sx * f.w / 2, cy + sy * f.h / 2, cz + rz * sx * f.w / 2);
      uv.push(u, v); aS.push(f.s, f.gain); aBase.push(f.base);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 2));
  geo.setAttribute('aBase', new THREE.Float32BufferAttribute(aBase, 1));
  geo.setIndex(idx);
  const mat = shaderMat(THREE, ctx, { vertexShader: VERT, fragmentShader: FRAG, additive: true, uniforms: { uAtlas: { value: tex } } });
  // misma referencia que las superficies: el parpadeo llega solo
  mat.uniforms.uLkSpillK = ctx.azSpill?.uLkSpillK ?? { value: new Array(MAX_SPILL).fill(1) };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'signs-faces';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function buildStructure(ctx, S) {
  const { THREE } = ctx;
  const geos = [], col = new THREE.Color();
  const box = (x, y, z, w, h, d, hex, rz = 0, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    g.deleteAttribute('uv');
    col.setHex(hex);
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    geos.push(g);
  };
  const DARK = 0x2a2c30, ALU = 0x7a7f83, RUST = 0x4a3e36, LAMP = 0xc9c6bd;
  if (S.velarde) { // bastidor: postes, largueros, tornapuntas y pasarela
    const { x, y, z, w, h, roof } = S.velarde;
    const hTop = y + h / 2 + 0.3;
    for (let k = -w / 2 + 0.3; k <= w / 2; k += 1.5) {
      box(x + 0.25, (roof + hTop) / 2, z + k, 0.12, hTop - roof, 0.12, RUST);
      box(x + 1.1, roof + (hTop - roof) * 0.45, z + k, 0.1, (hTop - roof) * 0.95, 0.1, RUST, -0.5);
    }
    for (const yy of [y - h / 2 + 0.2, y + h / 2 - 0.2]) box(x + 0.25, yy, z, 0.1, 0.1, w + 0.4, RUST);
    box(x + 0.7, roof + 0.4, z, 1.2, 0.06, w, ALU);
  }
  if (S.billboard) { // valla: patas al techo, marco, pasarela y tres reflectores
    const { x, y, z, w, h, roof } = S.billboard;
    box(x, y, z - 0.12, w + 0.3, h + 0.3, 0.2, DARK);
    for (const k of [-w * 0.35, 0, w * 0.35]) {
      box(x + k, (roof + y - h / 2) / 2, z - 0.6, 0.22, y - h / 2 - roof, 0.22, RUST);
      box(x + k, (roof + y) / 2, z - 1.6, 0.12, y - roof, 0.12, RUST, 0, 0.35);
      // reflector arriba, en brazo, apuntando a la cara
      box(x + k, y + h / 2 + 0.35, z + 0.55, 0.08, 0.08, 1.0, ALU);
      box(x + k, y + h / 2 + 0.3, z + 1.05, 0.5, 0.26, 0.3, LAMP);
    }
    box(x, y - h / 2 - 0.25, z + 0.35, w, 0.06, 0.8, ALU);
  }
  if (S.hotel) { // bandera y sus ménsulas
    const { x, y, z, w, h, face } = S.hotel;
    box(x, y, z, 0.36, h + 0.1, w + 0.1, DARK);
    for (const yy of [y - h * 0.35, y + h * 0.35]) box(x, yy, (z + face) / 2 + 0.3, 0.12, 0.12, face - z, ALU);
  }
  if (!geos.length) return null;
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.35 }));
  mesh.name = 'signs-structure';
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function build(ctx) {
  const S = signSpots();
  const tex = paintAtlas(ctx.THREE, ctx.palette);
  const st = buildStructure(ctx, S);
  if (st) ctx.group.add(st);
  ctx.group.add(buildFaces(ctx, tex, S));
  // la textura vive en un uniforme: el gestor no la ve al liberar la capa
  return { dispose() { tex.dispose(); } };
}
