// Capa de vida "city" del look de Azoteas (contrato en ../index.js): la
// CIUDAD alrededor, levantada sobre la cuadrícula de ./city-plan.js.
//   · edificios: cajas alineadas a los ejes que comparten medianeras y dan a
//     la calle, con la misma fachada que restila ./surfaces.js (plantas,
//     pilastras, escalera, locales en planta baja, ventanas reales)
//   · lo que hay en sus techos: casetas de escalera, enfriadoras, tanques de
//     agua sobre patas, chimeneas, mástiles
//   · balizas rojas de obstrucción en las torres y un avión lejano
// Tres llamadas de dibujo. update() no hace nada: lo que se mueve va en el
// sombreador con uLookTime.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lin, shaderMat } from './shared.js';
import { planCity, STREET_Y } from './city-plan.js';

function buildBlocks(ctx, plan) {
  const { THREE } = ctx;
  if (!ctx.azFacade) return null;
  const geos = plan.buildings.map((b) => {
    const g = new THREE.BoxGeometry(b.x1 - b.x0, b.top - STREET_Y, b.z1 - b.z0);
    g.translate((b.x0 + b.x1) / 2, (b.top + STREET_Y) / 2, (b.z0 + b.z1) / 2);
    g.deleteAttribute('uv');
    // semilla del edificio: su ritmo de ventanas y su tono (./surfaces.js)
    g.setAttribute('aLot', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(0.02 + b.seed * 0.96), 1));
    return g;
  });
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(geo, ctx.azFacade());
  mesh.name = 'city-blocks';
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// Equipos de techo de los edificios vecinos (iluminados por la luna).
function buildRoofs(ctx, plan) {
  const { THREE } = ctx;
  const rnd = ctx.rng('city-roofs');
  const geos = [], col = new THREE.Color();
  const paint = (g, hex) => {
    g.deleteAttribute('uv');
    col.setHex(hex);
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    geos.push(g);
  };
  const box = (x, y, z, w, h, d, hex) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); paint(g, hex); };
  const near = ctx.budget.detail > 0.5 ? 140 : 95;
  for (const b of plan.buildings) {
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, w = b.x1 - b.x0, d = b.z1 - b.z0;
    if (Math.max(Math.abs(cx), Math.abs(cz)) > near) continue;
    const y = b.top - 0.9; // losa del techo (el pretil sube 0.9)
    // caseta de escalera
    const sx = cx + (rnd() - 0.5) * w * 0.4, sz = cz + (rnd() - 0.5) * d * 0.4;
    box(sx, y + 1.3, sz, 2.6, 2.6, 3.2, 0x6f7174);
    // enfriadora o unidades de aire
    if (rnd() < 0.7) box(cx + (rnd() - 0.5) * w * 0.5, y + 0.6, cz + (rnd() - 0.5) * d * 0.5, 2.2 + rnd() * 2, 1.2, 1.4 + rnd(), 0x8a8e8e);
    // tanque de agua sobre patas (edificios viejos y medianos)
    if (b.kind !== 'tower' && rnd() < 0.3) {
      const tx = cx + (rnd() - 0.5) * w * 0.4, tz = cz + (rnd() - 0.5) * d * 0.4;
      const t = new THREE.CylinderGeometry(1.2, 1.2, 2.2, 10); t.translate(tx, y + 2.9, tz); paint(t, 0x6d6157);
      for (const [ox, oz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) box(tx + ox, y + 0.9, tz + oz, 0.14, 1.8, 0.14, 0x3a3c3f);
    }
    // corona técnica de las torres
    if (b.kind === 'tower') box(cx, y + 2.2, cz, w * 0.5, 4.4, d * 0.5, 0x2a2d32);
  }
  // chimeneas de las que sale el vapor (./atmos.js)
  for (const [x, y, z] of plan.stacks) {
    const g = new THREE.CylinderGeometry(0.35, 0.42, 3.2, 8); g.translate(x, y - 1.6, z); paint(g, 0x4a4b4d);
  }
  // mástiles en los techos más altos de cerca
  for (const m of masts(plan)) box(m[0], m[1] + m[3] / 2, m[2], 0.12, m[3], 0.12, 0x6d7277);
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.2 }));
  mesh.name = 'city-roofs';
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// mástiles: [x, base, z, alto] en los edificios cercanos más altos
function masts(plan) {
  return plan.buildings
    .filter((b) => !b.host && b.kind !== 'tower' && b.floors >= 5 && Math.max(Math.abs((b.x0 + b.x1) / 2), Math.abs((b.z0 + b.z1) / 2)) < 100 && b.seed > 0.82)
    .map((b) => [b.x0 + 2, b.top - 0.9, b.z0 + 2, 5]);
}

// ---------------------------------------------------------------- BALIZAS Y AVIÓN
const LIGHT_VERT = /* glsl */`
uniform float uLookTime; uniform float uScale;
attribute vec4 aB; // frecuencia, fase, tamaño, tipo (0 baliza, 1 estrobo de avión, 2 luz de posición)
attribute vec3 aCol;
varying vec3 vCol; varying float vOn;
void main() {
  vec3 p = position;
  float t = uLookTime;
  if (aB.w > 0.5) {
    // avión: cruza en línea recta a 90 m de altura y vuelve a empezar
    float k = fract(t * 0.0105 + 0.37);
    vec3 dir = normalize(vec3(0.83, 0.0, 0.56));
    p = vec3(-dir.x * 165.0, position.y, -dir.z * 165.0) + dir * 330.0 * k + vec3(dir.z, 0.0, -dir.x) * position.x;
  }
  float ph = fract(t * aB.x + aB.y);
  // baliza: destello de medio segundo; estrobo: doble destello corto
  float beacon = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.2, 0.32, ph));
  float strobe = step(ph, 0.04) + step(0.1, ph) * step(ph, 0.14);
  vOn = aB.w < 0.5 ? 0.12 + beacon : aB.w < 1.5 ? strobe : 0.7;
  vCol = aCol;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(aB.z * uScale / max(1.0, -mv.z), 1.5, 9.0) * (0.7 + 0.3 * vOn);
  gl_Position = projectionMatrix * mv;
}`;
const LIGHT_FRAG = /* glsl */`
varying vec3 vCol; varying float vOn;
void main() {
  float a = 1.0 - smoothstep(0.1, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vCol * a * vOn * 1.8, 1.0);
  #include <colorspace_fragment>
}`;

function buildLights(ctx, plan) {
  const { THREE, palette: P } = ctx;
  const pos = [], B = [], C = [];
  const red = lin(THREE, P.lamp.beacon), white = lin(THREE, P.lamp.white);
  const add = (x, y, z, rate, phase, size, type, c) => { pos.push(x, y, z); B.push(rate, phase, size, type); C.push(c.r, c.g, c.b); };
  // torres: baliza en las esquinas de la corona, todas sincronizadas
  for (const b of plan.buildings) {
    if (b.kind !== 'tower') continue;
    const y = b.top + 3.6;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, hw = (b.x1 - b.x0) * 0.24, hd = (b.z1 - b.z0) * 0.24;
    add(cx - hw, y, cz - hd, 0.5, 0, 30, 0, red);
    add(cx + hw, y, cz + hd, 0.5, 0, 30, 0, red);
  }
  for (const [x, y0, z, h] of masts(plan)) add(x, y0 + h + 0.15, z, 0.5, 0.02, 14, 0, red);
  // avión: estroboscópica blanca y luz roja de posición a su lado
  add(0, 92, 0, 1.0, 0.0, 30, 1, white);
  add(1.4, 92, 0, 0.0, 0.0, 16, 2, red);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aB', new THREE.Float32BufferAttribute(B, 4));
  geo.setAttribute('aCol', new THREE.Float32BufferAttribute(C, 3));
  const mat = shaderMat(THREE, ctx, {
    vertexShader: LIGHT_VERT, fragmentShader: LIGHT_FRAG, additive: true, fog: false,
    uniforms: { uScale: { value: 30 } },
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'city-lights';
  pts.frustumCulled = false;
  pts.renderOrder = 2; // nunca por encima del humo de las granadas (orden 3)
  return pts;
}

export function build(ctx) {
  const plan = planCity();
  const blocks = buildBlocks(ctx, plan);
  if (blocks) ctx.group.add(blocks);
  ctx.group.add(buildRoofs(ctx, plan));
  ctx.group.add(buildLights(ctx, plan));
  return {};
}
