// Capa de vida "atmos" del look (ver el contrato en ../index.js): el AIRE
// de un castillo en uso. Nubes, cuervos sobre la torre del homenaje, fuego
// de los braseros, humo (fragua, braseros y las casas del campo), pavesas,
// motas de sol en el patio y alguna hoja seca que arrastra el viento.
// Todo se anima en el vértice con uLookTime y se ancla a cameraPosition
// dentro del sombreador: update() no hace nada y nada se asigna por cuadro.
//
// Llamadas de dibujo (seis, una por InstancedMesh):
//   nubes · aves · llamas · humo · chispas+motas (aditivo) · hojas
import { NOISE, patch } from '../glsl.js';
import { forgeChimneys, CHIMNEY_TOP } from './sheds.js';

// Braseros: [x, base de la llama, z, escala]. Los cuatro de flanco son del
// kit de Blender (montón de "Amber embers" de r≈0.24 que acaba en y≈3.64);
// el del homenaje es el cuenco de world.js (borde en y≈3.98).
const BRAZIERS = [
  [7, 3.34, -6, 1], [-7, 3.34, 6, 1], [-11, 3.34, -5, 1], [11, 3.34, 5, 1],
  [0, 3.92, 0, 1.4],
];

// Caja de motas alrededor de la cámara (envuelta: densidad constante)
const MOTE_BOX = 26, MOTE_BOXY = 9;
// Volumen por donde cruzan las hojas secas (patio, patios de armas y lizas)
const LEAF_MIN = [-38, 0.15, -34], LEAF_SIZE = [76, 7, 68];

const lin = (THREE, hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);

// Atributo por instancia
function inst(THREE, geo, name, arr, size) {
  geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
}

// Malla instanciada sin matrices propias (todo sale del sombreador)
function instMesh(THREE, geo, mat, count, name, order) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.name = name;
  m.frustumCulled = false; // la posición real se calcula en el vértice
  m.castShadow = m.receiveShadow = false;
  m.renderOrder = order;
  m.matrixAutoUpdate = false;
  return m;
}

const FOG_GLSL = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor; uniform float fogDensity; uniform float fogNear; uniform float fogFar;
  float atFog(float d) {
    #ifdef FOG_EXP2
      return 1.0 - exp(-fogDensity * fogDensity * d * d);
    #else
      return smoothstep(fogNear, fogFar, d);
    #endif
  }
  vec3 atFogColor() { return fogColor; }
#else
  float atFog(float d) { return 0.0; }
  vec3 atFogColor() { return vec3(0.0); }
#endif
`;

// ---------------------------------------------------------------- NUBES
// Cada nube es un cartel que mira a la cámara, en un anillo de 95-140 m que
// sigue a la cámara en horizontal (delante de la cúpula a 150 m, dentro del
// plano lejano). La forma sale del fragmento: lóbulos + fbm, base plana en
// los cúmulos y bandas estiradas en los estratos. Se dibujan de la más
// lejana a la más cercana (orden de instancias) y así no hay saltos de orden.
const CLOUD_VERT = /* glsl */`
uniform float uLookTime; uniform vec3 uSun; uniform vec3 uSunBody;
attribute vec4 aA; // azimut, radio, altura, ancho
attribute vec4 aB; // alto/ancho, semilla, tipo, opacidad
attribute float aSpeed;
varying vec2 vUv; varying vec4 vB; varying vec3 vW; varying vec2 vL; varying float vFacing; varying float vSunFade;
void main() {
  float az = aA.x + uLookTime * aSpeed;
  vec3 c = vec3(cameraPosition.x + sin(az) * aA.y, aA.z, cameraPosition.z + cos(az) * aA.y);
  vec3 toCam = normalize(cameraPosition - c);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  vec3 w = c + right * position.x * aA.w + up * position.y * aA.w * aB.x;
  vUv = position.xy + 0.5;
  vB = aB;
  vW = w;
  // dirección del sol en el plano del cartel (para la autosombra)
  vL = vec2(dot(uSun, right), dot(uSun, up));
  vFacing = dot(-toCam, uSun); // 1 = nube a contraluz
  // el disco del sol es opaco y está más cerca: la nube que le pasa por
  // detrás se desvanece (tarda minutos en cruzar, no se nota)
  float ang = acos(clamp(dot(-toCam, uSunBody), -1.0, 1.0));
  vSunFade = smoothstep(0.12 + aA.w * 0.4 / aA.y, 0.30 + aA.w * 0.5 / aA.y, ang);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const CLOUD_FRAG = /* glsl */`
uniform float uLookTime;
uniform vec3 uLit, uShade, uRim, uHorizon;
varying vec2 vUv; varying vec4 vB; varying vec3 vW; varying vec2 vL; varying float vFacing; varying float vSunFade;
${NOISE}
// calidades bajas: una octava de ruido y una sola evaluación de densidad
#ifdef CLOUD_CHEAP
  #define CFBM lkNoise
#else
  #define CFBM lkFbm
#endif
// densidad 0..1 en coordenadas del cartel (x 0..1, y 0..asp)
float dens(vec2 q, float asp, float seed, float kind, float t) {
  vec2 nq = q * vec2(5.0, 5.0) + vec2(seed * 17.0 + t * 0.010, seed * 7.0 - t * 0.006);
  float n = CFBM(nq);
  if (kind < 0.5) {
    // cúmulo: lóbulos sobre una base plana, más altos al centro
    float base = asp * 0.24;
    float d = -1.0;
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float hx = lkHash11(seed * 13.1 + fi * 7.31);
      float hr = lkHash11(seed * 5.73 + fi * 3.17);
      float x = 0.18 + 0.64 * (fi + 0.2 + hx * 0.6) / 7.0;
      float mid = 1.0 - abs(x - 0.5) * 1.5;
      float r = (0.09 + 0.10 * hr) * (0.55 + 0.6 * mid) * min(1.0, asp * 2.2);
      vec2 cc = vec2(x, base + r * (0.35 + 0.5 * mid * hr));
      d = max(d, 1.0 - length((q - cc) * vec2(1.0, 1.08)) / r);
    }
    float fine = lkNoise(q * 22.0 + seed * 31.0 + t * 0.02);
    d += (n - 0.5) * 0.85 + (fine - 0.5) * 0.28 * (1.0 - clamp(d, 0.0, 1.0));
    // la base: corte suave pero recto
    d *= smoothstep(base - 0.015, base + 0.05, q.y + (n - 0.5) * 0.03);
    return clamp(d, 0.0, 1.0);
  }
  if (kind > 1.5) {
    // velo alto: vetas finas peinadas por el viento, sin volumen
    vec2 uv = vec2(q.x, q.y / asp);
    float warp = lkFbm(vec2(uv.x * 2.0 + seed * 5.0, uv.y * 2.0 + t * 0.01));
    float streak = lkFbm(vec2(uv.x * 1.6 + seed * 3.0 + t * 0.006, (uv.y + (warp - 0.5) * 0.7) * 7.0));
    float env = smoothstep(0.0, 0.3, uv.x) * (1.0 - smoothstep(0.7, 1.0, uv.x)) * smoothstep(0.0, 0.35, uv.y) * (1.0 - smoothstep(0.65, 1.0, uv.y));
    return smoothstep(0.42, 0.78, streak) * env * 0.75;
  }
  // estrato: banda estirada con vetas
  float s = lkFbm(vec2(q.x * 3.0 + seed * 9.0 + t * 0.008, q.y * 22.0 / max(asp * 6.0, 1.0) + seed));
  float mid = asp * 0.5 + (s - 0.5) * asp * 0.5;
  float band = 1.0 - abs(q.y - mid) / (asp * 0.42);
  float ends = smoothstep(0.0, 0.25, q.x) * (1.0 - smoothstep(0.75, 1.0, q.x));
  float d = band * ends + (n - 0.5) * 0.7 - 0.05;
  return clamp(d, 0.0, 1.0);
}
void main() {
  float asp = vB.x, seed = vB.y, kind = vB.z;
  float t = uLookTime;
  vec2 q = vec2(vUv.x, vUv.y * asp);
  float d = dens(q, asp, seed, kind, t);
  if (d <= 0.002) discard;
#ifdef CLOUD_CHEAP
  // sin autosombra: el núcleo denso hace de sombra
  float light = 1.0 - 0.45 * d;
#else
  // autosombra: dos muestras hacia el sol en el plano del cartel
  vec2 L = length(vL) > 1e-3 ? normalize(vL) : vec2(0.0, 1.0);
  float k = kind < 0.5 ? 0.045 : 0.03;
  float occl = dens(q + L * k, asp, seed, kind, t) + dens(q + L * k * 2.4, asp, seed, kind, t);
  float light = exp(-occl * 1.5);
#endif
  float front = clamp(-vFacing, 0.0, 1.0);
  light = mix(light, 1.0, front * 0.45);
  if (kind < 0.5) light *= mix(0.62, 1.0, smoothstep(asp * 0.2, asp * 0.55, q.y)); // vientre en sombra
  else light = mix(light, 1.0, kind > 1.5 ? 0.7 : 0.35);
  vec3 col = mix(uShade, uLit, clamp(light, 0.0, 1.0));
  // borde plateado: el filo fino de la nube brilla, más a contraluz
  float edge = 1.0 - smoothstep(0.0, 0.32, d);
  col += uRim * edge * (0.25 + 1.3 * pow(max(vFacing, 0.0), 3.0)) * 0.7;
  float a = smoothstep(0.0, 0.28, d) * vB.w * vSunFade;
  // niebla propia: hacia el horizonte la nube se funde con su color
  float dirY = normalize(vW - cameraPosition).y;
  float haze = 1.0 - smoothstep(0.015, 0.30, dirY);
  col = mix(col, uHorizon, haze * 0.72);
  a *= smoothstep(-0.01, 0.05, dirY);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

function buildClouds(ctx, sunBody) {
  const { THREE, palette: P, budget } = ctx;
  const rng = ctx.rng('atmos-clouds');
  const r = (a, b) => a + (b - a) * rng();
  const sunAz = Math.atan2(sunBody.x, sunBody.z);
  const list = [];
  const cheap = budget.detail < 0.5;
  const nCum = cheap ? 4 : Math.max(5, Math.round(12 * budget.detail));
  // cúmulos: repartidos alrededor, un poco más donde da el sol
  for (let i = 0; i < nCum; i++) {
    const az = (i + r(0.15, 0.85)) / nCum * Math.PI * 2;
    const w = r(30, 48);
    list.push([az, r(112, 138), r(19, 33), w, r(0.42, 0.58), rng(), 0, r(0.85, 1), r(0.0022, 0.0032)]);
  }
  // estratos bajos sobre el horizonte, en la zona del ocaso y enfrente
  const nStr = cheap ? 1 : Math.max(2, Math.round(5 * budget.detail));
  for (let i = 0; i < nStr; i++) {
    const az = sunAz + (i % 2 ? Math.PI : 0) + r(-0.9, 0.9);
    list.push([az, r(128, 142), r(10, 15), r(70, 100), r(0.10, 0.15), rng(), 1, r(0.7, 0.9), r(0.0012, 0.0018)]);
  }
  // velos altos: casi encima, finos
  const nHi = cheap ? 0 : Math.max(1, Math.round(3 * budget.detail));
  for (let i = 0; i < nHi; i++) {
    list.push([r(0, Math.PI * 2), r(85, 100), r(58, 68), r(70, 95), r(0.22, 0.3), rng(), 2, r(0.35, 0.5), r(0.0015, 0.0025)]);
  }
  // de la más lejana a la más cercana: el orden de instancias es el de dibujo
  list.sort((a, b) => Math.hypot(b[1], b[2]) - Math.hypot(a[1], a[2]));
  const n = list.length;
  const A = new Float32Array(n * 4), B = new Float32Array(n * 4), S = new Float32Array(n);
  list.forEach((c, i) => { A.set(c.slice(0, 4), i * 4); B.set(c.slice(4, 8), i * 4); S[i] = c[8]; });
  const geo = new THREE.PlaneGeometry(1, 1);
  inst(THREE, geo, 'aA', A, 4); inst(THREE, geo, 'aB', B, 4); inst(THREE, geo, 'aSpeed', S, 1);
  const sky = P.sky;
  const mat = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
    uniforms: {
      uLookTime: ctx.uniforms.uLookTime,
      uSun: { value: sunBody.clone() }, // nubes y motas se alinean con el sol que se VE
      uSunBody: { value: sunBody.clone() },
      uLit: { value: lin(THREE, sky.cloudLit, 1.02) },
      uShade: { value: lin(THREE, sky.cloudShade, 0.92) },
      uRim: { value: lin(THREE, sky.cloudRim, 1.0) },
      uHorizon: { value: lin(THREE, sky.horizon) },
    },
    defines: cheap ? { CLOUD_CHEAP: '' } : {},
    transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
  });
  // antes que cualquier transparente del mundo
  return instMesh(THREE, geo, mat, n, 'atmos-clouds', -100);
}

// ---------------------------------------------------------------- AVES
// Silueta plana (cuerpo, cola y dos alas de dos tramos). El vértice calcula
// la trayectoria, la orientación (derivada numérica del camino), el alabeo
// y el aleteo. Bandada que gira sobre la ciudadela + planeadores lejanos.
function birdGeometry(THREE) {
  const P = [], W = [];
  const tri = (a, b, c) => { for (const v of [a, b, c]) { P.push(v[0], v[1], v[2]); W.push(v[3]); } };
  // [x, y, z, peso del ala] (0 cuerpo, 1 tramo interior, 2 punta)
  const nose = [0, 0, 0.26, 0], tail = [0, 0, -0.22, 0], bl = [-0.05, 0, 0.02, 0], br = [0.05, 0, 0.02, 0];
  tri(nose, bl, tail); tri(nose, tail, br);
  tri(tail, [-0.09, 0, -0.36, 0], [0.09, 0, -0.36, 0]);
  for (const s of [-1, 1]) {
    const rf = [0.03 * s, 0, 0.10, 0], rb = [0.03 * s, 0, -0.06, 0];
    const mf = [0.30 * s, 0, 0.08, 1], mb = [0.30 * s, 0, -0.10, 1];
    const tip = [0.58 * s, 0, -0.14, 2];
    tri(rf, rb, mf); tri(mf, rb, mb); tri(mf, mb, tip);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  return g;
}

const BIRD_VERT_PARS = /* glsl */`
uniform float uLookTime;
attribute float aWing;
attribute vec4 aBirdA; // radio, altura, ángulo inicial, velocidad angular (con signo)
attribute vec4 aBirdB; // semilla, centro x, centro z, tipo (0 bandada, 1 planeador)
attribute float aBirdS; // escala
vec3 atBirdPath(float t) {
  float ang = aBirdA.z + t * aBirdA.w;
  float r = aBirdA.x * (1.0 + 0.10 * sin(t * 0.23 + aBirdB.x * 6.28));
  vec2 c = aBirdB.yz + vec2(sin(t * 0.031), cos(t * 0.027)) * (aBirdB.w > 0.5 ? 8.0 : 5.0);
  return vec3(c.x + cos(ang) * r, aBirdA.y + sin(t * 0.31 + aBirdB.x * 9.0) * 1.8, c.y + sin(ang) * r);
}
`;
const BIRD_VERT = /* glsl */`
{
  float t = uLookTime;
  vec3 p0 = atBirdPath(t), p1 = atBirdPath(t + 0.12);
  vec3 fwd = normalize(p1 - p0);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, side);
  // alabeo hacia dentro del giro
  float bank = -sign(aBirdA.w) * (aBirdB.w > 0.5 ? 0.22 : 0.42);
  vec3 s2 = side * cos(bank) + up * sin(bank);
  vec3 u2 = cross(fwd, s2);
  // aleteo a ráfagas: tramos de aleteo y de planeo
  float flapOn = aBirdB.w > 0.5 ? 0.0 : smoothstep(0.1, 0.6, sin(t * 0.55 + aBirdB.x * 17.0));
  float ph = t * (5.5 + aBirdB.x * 1.5) + aBirdB.x * 40.0;
  float a = mix(0.12, sin(ph) * 0.75 + 0.12, flapOn);
  float ax = abs(position.x);
  vec3 lp = position;
  lp.x = sign(position.x) * ax * cos(a);
  lp.y = ax * sin(a);
  if (aWing > 1.5) { float b = a * 0.8; lp.y += (ax - 0.30) * sin(b); lp.x -= sign(position.x) * (ax - 0.30) * (1.0 - cos(b)); }
  lp *= aBirdS;
  transformed = p0 + s2 * lp.x + u2 * lp.y + fwd * lp.z;
}
`;

function buildBirds(ctx) {
  const { THREE, palette: P, budget, uniforms } = ctx;
  const rng = ctx.rng('atmos-birds');
  const r = (a, b) => a + (b - a) * rng();
  // cuervos: pocos, grandes y de aleteo lento
  const flock = Math.max(5, Math.round(12 * budget.detail));
  const gliders = 3;
  const n = flock + gliders;
  const A = new Float32Array(n * 4), B = new Float32Array(n * 4), S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < flock) {
      // dos grupos que giran en sentido contrario, juntos en arco
      const g = i % 2, dir = g ? 1 : -1;
      const R = r(10, 21);
      A.set([R, r(15, 26) + g * 3, (g ? 0 : 2.6) + r(-0.7, 0.7), dir * r(0.30, 0.33)], i * 4);
      B.set([rng(), g ? 4 : -5, g ? -3 : 4, 0], i * 4);
      S[i] = r(1.15, 1.45);
    } else {
      const k = i - flock;
      A.set([r(70, 92), r(32, 42), k * 2.1 + r(0, 1), (k % 2 ? 1 : -1) * r(0.045, 0.06)], i * 4);
      B.set([rng(), r(-15, 15), r(-15, 15), 1], i * 4);
      S[i] = r(2.2, 2.8);
    }
  }
  const geo = birdGeometry(THREE);
  inst(THREE, geo, 'aBirdA', A, 4); inst(THREE, geo, 'aBirdB', B, 4); inst(THREE, geo, 'aBirdS', S, 1);
  // cuervo: casi negro (no hay color de ave en la paleta: hierro apagado)
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.metal.iron).multiplyScalar(0.45), side: THREE.DoubleSide });
  patch(mat, { uniforms: { uLookTime: uniforms.uLookTime }, vertexPars: BIRD_VERT_PARS, vertex: BIRD_VERT, key: 'atmos-birds' });
  return instMesh(THREE, geo, mat, n, 'atmos-birds', 0);
}

// ---------------------------------------------------------------- LLAMAS
// Carteles cilíndricos (giran solo en vertical) con una llama procedural:
// perfil que se estrecha, ruido que sube y lenguas que se desprenden. Mezcla
// aditiva en HDR: el núcleo pasa de 1 y el bloom le pone el halo.
const FLAME_VERT = /* glsl */`
uniform float uLookTime; uniform vec3 uLookWind;
attribute vec4 aF; // x, base, z, alto
attribute vec4 aG; // ancho, semilla, capa, desplazamiento lateral
varying vec2 vUv; varying vec4 vG; varying float vFlick;
void main() {
  vec3 base = aF.xyz;
  vec3 toCam = cameraPosition - base; toCam.y = 0.0;
  toCam = length(toCam) > 1e-3 ? normalize(toCam) : vec3(0.0, 0.0, 1.0);
  vec3 right = vec3(toCam.z, 0.0, -toCam.x);
  float v = position.y + 0.5;
  float t = uLookTime;
  // la punta se inclina con el viento y baila
  vec2 lean = uLookWind.xz * (0.10 + 0.08 * uLookWind.y) + vec2(sin(t * 2.3 + aG.y * 7.0), cos(t * 1.9 + aG.y * 5.0)) * 0.05;
  vec3 w = base + right * (position.x * aG.x + aG.w) + vec3(0.0, v * aF.w, 0.0);
  w.xz += lean * v * v * aF.w;
  vUv = vec2(position.x + 0.5, v);
  vG = aG;
  // parpadeo del brasero entero (lento + rápido)
  vFlick = 0.82 + 0.10 * sin(t * 7.3 + aG.y * 11.0) + 0.08 * sin(t * 17.1 + aG.y * 3.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const FLAME_FRAG = /* glsl */`
uniform float uLookTime; uniform vec3 uCore, uFlame, uEmber;
varying vec2 vUv; varying vec4 vG; varying float vFlick;
${NOISE}
void main() {
  float t = uLookTime, seed = vG.y;
  float y = vUv.y;
  float x = vUv.x - 0.5;
  float n = lkFbm(vec2(x * 2.6 + seed * 7.0, y * 2.2 - t * 2.4));
  float n2 = lkNoise(vec2(x * 6.0 - seed * 3.0, y * 4.5 - t * 4.2));
  // el humo caliente arrastra la llama: más desplazamiento arriba
  x += (n - 0.5) * 0.30 * y + (n2 - 0.5) * 0.10 * y;
  // lágrima: base redonda, punta suave (máximo ancho hacia y≈0.3)
  float w = 1.13 * 0.42 * sqrt(max(y + 0.02, 0.0)) * pow(max(1.0 - y, 0.0), 1.1);
  float f = w - abs(x);
  // lenguas: el ruido recorta un poco la parte alta
  f -= smoothstep(0.4, 1.0, y) * n2 * 0.12;
  float I = smoothstep(0.0, 0.12, f);
  // núcleo pequeño y bajo; cuerpo naranja; puntas hacia la ascua
  float core = smoothstep(0.07, 0.2, f) * (1.0 - smoothstep(0.12, 0.42, y));
  vec3 col = mix(uFlame, uEmber, clamp(smoothstep(0.4, 0.95, y) + (1.0 - smoothstep(0.0, 0.1, f)) * 0.35, 0.0, 1.0));
  col = mix(col, uCore, core * (vG.z > 0.5 ? 0.9 : 0.5));
  I *= smoothstep(0.0, 0.05, y) * vFlick;
  // premultiplicado con cobertura alta: las capas se tapan en vez de sumarse
  // (sumadas acababan en blanco) y la llama sigue naranja contra el cielo
  // primero se codifica el color recto (en el lienzo sRGB de 'off'; en HDR
  // no hace nada) y después se aplica la cobertura
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * I, I * 0.85);
}`;

function buildFlames(ctx) {
  const { THREE, palette: P, uniforms } = ctx;
  const rng = ctx.rng('atmos-flames');
  // por brasero: llama exterior, una lengua lateral y el núcleo (último: va encima)
  const layers = [[1.0, 1.0, 0, 0], [0.78, 0.6, 0, 1], [0.7, 0.62, 1, 0]];
  const n = BRAZIERS.length * layers.length;
  const F = new Float32Array(n * 4), G = new Float32Array(n * 4);
  let i = 0;
  for (const [x, y, z, s] of BRAZIERS) {
    for (const [h, w, core, off] of layers) {
      F.set([x, y - 0.05, z, h * 0.62 * s], i * 4);
      G.set([w * 0.78 * s, rng() * 10, core, off ? (rng() < 0.5 ? -1 : 1) * 0.08 * s : 0], i * 4);
      i++;
    }
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  inst(THREE, geo, 'aF', F, 4); inst(THREE, geo, 'aG', G, 4);
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    uniforms: {
      uLookTime: uniforms.uLookTime, uLookWind: uniforms.uLookWind,
      uCore: { value: lin(THREE, P.fire.core, 2.8) },
      uFlame: { value: lin(THREE, P.fire.flame, 1.75) },
      uEmber: { value: lin(THREE, P.fire.ember, 1.5) },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return instMesh(THREE, geo, mat, n, 'atmos-flames', 1);
}

// ---------------------------------------------------------------- CHISPAS Y MOTAS
// Una sola malla de cuadritos (mezcla premultiplicada: las motas solo suman luz,
// las chispas además cubren un poco) que miran a la cámara:
//   tipo 0 = mota de sol/polen en una caja envuelta alrededor de la cámara
//            (brilla más mirando hacia el sol, como el polvo a contraluz)
//   tipo 1 = chispa que sube de un brasero, se enfría y se apaga
const SPARK_VERT = /* glsl */`
uniform float uLookTime; uniform vec3 uLookWind; uniform vec3 uSun;
uniform vec3 uMote, uCore, uEmber;
attribute vec4 aP; // x, y, z, tipo
attribute vec4 aQ; // semilla, tamaño, velocidad, fase
varying vec2 vUv; varying vec3 vCol; varying float vCov;
void main() {
  float t = uLookTime, seed = aQ.x;
  vCov = 0.0;
  vec3 wp; float size; vec3 col;
  if (aP.w < 0.5) {
    vec3 box = vec3(${MOTE_BOX.toFixed(1)}, ${MOTE_BOXY.toFixed(1)}, ${MOTE_BOX.toFixed(1)});
    vec3 drift = vec3(uLookWind.x, 0.04, uLookWind.z) * t * 0.35
      + vec3(sin(t * 0.31 + seed * 6.0), sin(t * 0.23 + seed * 9.0) * 0.6, cos(t * 0.27 + seed * 4.0)) * 0.7;
    vec3 rel = mod(aP.xyz + drift - cameraPosition + box * 0.5, box) - box * 0.5;
    wp = cameraPosition + rel;
    float dist = length(rel);
    // llega a cero antes de cada cara de la caja: al envolver no salta nada
    float fade = smoothstep(0.9, 2.6, dist) * (1.0 - smoothstep(box.x * 0.30, box.x * 0.46, length(rel.xz)))
      * (1.0 - smoothstep(box.y * 0.28, box.y * 0.46, abs(rel.y)));
    vec3 vd = rel / max(dist, 1e-3);
    float glint = 0.3 + 4.0 * pow(max(dot(vd, uSun), 0.0), 4.0);
    float tw = 0.6 + 0.4 * sin(t * (1.3 + aQ.w * 2.0) + seed * 30.0);
    col = uMote * glint * tw * fade;
    size = aQ.y;
  } else {
    float life = fract(t * aQ.z + aQ.w);
    float k = floor(t * aQ.z + aQ.w); // cada vuelta sale por otro sitio
    float h1 = lkHash11(seed * 31.0 + k * 1.7), h2 = lkHash11(seed * 17.0 + k * 3.1);
    vec2 off = (vec2(h1, h2) - 0.5) * 0.36 * aP.w;
    float rise = life * (1.5 + 1.6 * h1) * min(aP.w, 1.3);
    vec2 swirl = vec2(sin(t * 3.1 + seed * 20.0 + life * 6.0), cos(t * 2.7 + seed * 13.0 + life * 5.0)) * 0.16 * life;
    wp = aP.xyz + vec3(off.x + swirl.x, rise, off.y + swirl.y);
    wp.xz += uLookWind.xz * (0.5 + uLookWind.y) * life * life * 1.2;
    float tw = 0.65 + 0.35 * sin(t * 23.0 + seed * 50.0);
    col = mix(uCore, uEmber, smoothstep(0.0, 0.45, life)) * (1.0 - smoothstep(0.55, 1.0, life)) * smoothstep(0.0, 0.05, life) * tw;
    size = aQ.y * mix(1.0, 0.45, life);
    vCov = (1.0 - smoothstep(0.55, 1.0, life)) * 0.9; // tapa el cielo: la chispa se ve naranja, no rosa
  }
  vCol = col;
  vUv = position.xy + 0.5;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vCov;
void main() {
  float a = 1.0 - smoothstep(0.0, 0.5, length(vUv - 0.5));
  a *= a;
  gl_FragColor = vec4(vCol, 1.0);
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, vCov * a);
}`;

function buildSparks(ctx, nMotes, nSparks, sunBody, sources) {
  const { THREE, palette: P, uniforms } = ctx;
  const rng = ctx.rng('atmos-sparks');
  const r = (a, b) => a + (b - a) * rng();
  const n = nMotes + nSparks;
  const A = new Float32Array(n * 4), Q = new Float32Array(n * 4);
  for (let i = 0; i < nMotes; i++) {
    A.set([r(0, MOTE_BOX), r(0, MOTE_BOXY), r(0, MOTE_BOX), 0], i * 4);
    Q.set([rng() * 10, r(0.03, 0.06), 0, rng()], i * 4);
  }
  // el brasero del homenaje, más grande, se lleva más chispas; las chimeneas
  // de la fragua sueltan pavesas sueltas
  const weights = sources.map((b) => b[4]), wsum = weights.reduce((a, b) => a + b, 0);
  let b = 0, acc = weights[0] / wsum;
  for (let j = 0; j < nSparks; j++) {
    while ((j + 0.5) / nSparks > acc && b < sources.length - 1) acc += weights[++b] / wsum;
    const [x, y, z, s] = sources[b];
    A.set([x, y + 0.1 * s, z, s], (nMotes + j) * 4);
    Q.set([rng() * 10, r(0.035, 0.06) * Math.sqrt(s), r(0.35, 0.7), rng()], (nMotes + j) * 4);
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  inst(THREE, geo, 'aP', A, 4); inst(THREE, geo, 'aQ', Q, 4);
  const mat = new THREE.ShaderMaterial({
    vertexShader: NOISE + SPARK_VERT, fragmentShader: SPARK_FRAG,
    uniforms: {
      uLookTime: uniforms.uLookTime, uLookWind: uniforms.uLookWind,
      uSun: { value: sunBody.clone() },
      uMote: { value: lin(THREE, P.sky.cloudRim, 0.8) },
      uCore: { value: lin(THREE, P.fire.core, 3.2) },
      // brasa que se enfría: entre llama y ascua (la ascua pura sobre el cielo azul daba rosa)
      uEmber: { value: lin(THREE, P.fire.flame).lerp(lin(THREE, P.fire.ember), 0.5).multiplyScalar(2.2) },
    },
    transparent: true, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  return instMesh(THREE, geo, mat, n, 'atmos-sparks', 2);
}

// ---------------------------------------------------------------- HOJAS SECAS
// Pocas hojas secas que cruzan los patios con el viento, cayendo despacio y
// girando sobre sí mismas (el reverso más oscuro hace que "parpadeen").
const LEAF_VERT = /* glsl */`
uniform float uLookTime; uniform vec3 uLookWind; uniform vec3 uSun;
uniform vec3 uBoxMin, uBoxSize;
attribute vec4 aP; // x, y, z, semilla
attribute vec4 aC; // color rgb, tamaño
varying vec2 vUv; varying vec3 vCol; varying float vA; varying float vFogDepth;
void main() {
  float t = uLookTime, seed = aP.w;
  vec3 p = aP.xyz;
  p.xz += uLookWind.xz * t * (0.9 + 0.5 * fract(seed * 7.3)) + vec2(sin(t * 0.7 + seed * 9.0), cos(t * 0.6 + seed * 5.0)) * 0.8;
  p.y -= t * (0.12 + 0.12 * fract(seed * 3.7));
  p.y += sin(t * 1.1 + seed * 20.0) * 0.25;
  p = mod(p - uBoxMin, uBoxSize) + uBoxMin;
  // al borde de la caja aparecen y desaparecen poco a poco
  vec3 e = min(p - uBoxMin, uBoxMin + uBoxSize - p);
  float a = smoothstep(0.0, 3.0, min(e.x, e.z)) * smoothstep(0.0, 0.6, e.y);
  // giro alrededor de un eje propio
  float ang = t * (2.0 + 3.0 * fract(seed * 11.0)) + seed * 40.0;
  vec3 ax = normalize(vec3(sin(seed * 13.0), 0.6, cos(seed * 17.0)));
  float c = cos(ang), s = sin(ang);
  vec3 lp = vec3(position.x * aC.w, position.y * aC.w * 0.62, 0.0);
  lp = lp * c + cross(ax, lp) * s + ax * dot(ax, lp) * (1.0 - c);
  vec3 nrm = vec3(0.0, 0.0, 1.0);
  nrm = nrm * c + cross(ax, nrm) * s + ax * dot(ax, nrm) * (1.0 - c);
  vec3 wp = p + lp;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  // nunca pegados a la cara
  a *= smoothstep(2.0, 4.5, dist);
  float lit = 0.55 + 0.6 * abs(dot(nrm, uSun));
  vCol = aC.rgb * lit;
  vA = a;
  vUv = position.xy + 0.5;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const LEAF_FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vA; varying float vFogDepth;
${FOG_GLSL}
void main() {
  vec2 q = vUv - 0.5;
  float shape = 1.0 - smoothstep(0.36, 0.5, length(q * vec2(1.0, 1.0 + q.x)));
  float a = shape * vA * 0.85;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol, a);
  #include <colorspace_fragment>
  // niebla después de la conversión, como hacen los materiales de three
  // (antes, en 'off' el color de niebla se convertía dos veces)
  gl_FragColor.rgb = mix(gl_FragColor.rgb, atFogColor(), atFog(vFogDepth));
}`;

function buildLeaves(ctx, count) {
  const { THREE, palette: P, uniforms } = ctx;
  const rng = ctx.rng('atmos-leaves');
  // hoja de roble seca: ocre, herrumbre, paja y alguna aún verde
  const cols = [P.foliage[3], P.foliage[4], P.ground.grassDry, P.wood.oak, P.foliage[0]].map((h) => new THREE.Color(h).multiplyScalar(0.85));
  const A = new Float32Array(count * 4), C = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    A.set([LEAF_MIN[0] + rng() * LEAF_SIZE[0], LEAF_MIN[1] + rng() * LEAF_SIZE[1], LEAF_MIN[2] + rng() * LEAF_SIZE[2], rng() * 10], i * 4);
    const c = cols[Math.floor(rng() * cols.length)];
    C.set([c.r, c.g, c.b, 0.06 + rng() * 0.025], i * 4);
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  inst(THREE, geo, 'aP', A, 4); inst(THREE, geo, 'aC', C, 4);
  const mat = new THREE.ShaderMaterial({
    vertexShader: LEAF_VERT, fragmentShader: LEAF_FRAG,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uSun: { value: ctx.sunDir.clone() },
      uBoxMin: { value: new THREE.Vector3(...LEAF_MIN) },
      uBoxSize: { value: new THREE.Vector3(...LEAF_SIZE) },
    }]),
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true, toneMapped: false,
  });
  // merge clona: las referencias compartidas se reponen después
  mat.uniforms.uLookTime = uniforms.uLookTime;
  mat.uniforms.uLookWind = uniforms.uLookWind;
  return instMesh(THREE, geo, mat, count, 'atmos-leaves', 2);
}

// ---------------------------------------------------------------- HUMO
// Columnas de humo blando: la chimenea de la fragua (denso y oscuro), un
// hilo sobre cada brasero (empieza por encima de 5 m: nunca cruza la línea
// de tiro de las galerías) y el de las casas del campo, a lo lejos. Cada
// bocanada es un cartel que sube, engorda, se tumba con el viento y se
// deshace; al terminar su ciclo vuelve a salir con otra forma.
const SMOKE_VERT = /* glsl */`
uniform float uLookTime; uniform vec3 uLookWind; uniform vec3 uSun;
attribute vec4 aS; // x, y, z de la boca, semilla
attribute vec4 aK; // periodo (s), subida (m), tamaño inicial, tamaño final
attribute vec4 aA; // opacidad, oscuridad, fase, -
varying vec2 vUv; varying float vLife; varying float vAlpha; varying float vSeed; varying float vLit; varying float vDark; varying float vFogDepth;
void main() {
  float t = uLookTime;
  float cyc = t / aK.x + aA.z;
  float life = fract(cyc);
  vec3 p = aS.xyz;
  // el viento la tumba más cuanto más sube; un remolino lento la deshilacha
  p.xz += uLookWind.xz * (0.6 + 0.6 * uLookWind.y) * pow(life, 1.4) * aK.y * 0.55;
  p.xz += vec2(sin(t * 0.7 + aS.w * 7.0 + life * 4.0), cos(t * 0.6 + aS.w * 5.0 + life * 3.0)) * 0.22 * life * aK.w;
  p.y += life * aK.y;
  float size = mix(aK.z, aK.w, sqrt(life));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float ang = aS.w * 6.283 + floor(cyc) * 2.1 + life * (fract(aS.w * 3.7) - 0.5);
  vec2 q = vec2(position.x * cos(ang) - position.y * sin(ang), position.x * sin(ang) + position.y * cos(ang));
  mv.xy += q * size;
  vUv = position.xy + 0.5;
  vLife = life;
  vSeed = aS.w + floor(cyc) * 1.37;
  vAlpha = aA.x * smoothstep(0.0, 0.14, life) * (1.0 - smoothstep(0.4, 1.0, life));
  vLit = pow(max(dot(normalize(p - cameraPosition), uSun), 0.0), 3.0); // a contraluz se enciende
  vDark = aA.y;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const SMOKE_FRAG = /* glsl */`
uniform vec3 uSmoke, uSmokeLit, uSunCol;
varying vec2 vUv; varying float vLife; varying float vAlpha; varying float vSeed; varying float vLit; varying float vDark; varying float vFogDepth;
${NOISE}
${FOG_GLSL}
void main() {
  vec2 q = vUv - 0.5;
  float n = lkNoise(vUv * 3.0 + vSeed * 13.0) * 0.6 + lkNoise(vUv * 7.0 - vSeed * 5.0) * 0.4;
  float d = 1.0 - smoothstep(0.3, 1.0, length(q) * 2.0 + (n - 0.5) * 0.6);
  float a = d * vAlpha;
  if (a < 0.004) discard;
  vec3 col = mix(uSmoke, uSmokeLit, clamp(0.3 + 0.4 * n + vLife * 0.45 - vDark * 0.35, 0.0, 1.0));
  col += uSunCol * vLit * 0.3 * (1.0 - d * 0.5);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, atFogColor(), atFog(vFogDepth));
}`;

function buildSmoke(ctx, sunBody, chimneys) {
  const { THREE, palette: P, uniforms, world, budget } = ctx;
  const rng = ctx.rng('atmos-smoke');
  const r = (a, b) => a + (b - a) * rng();
  const k = Math.max(0.5, budget.detail);
  // [x, y, z, bocanadas, periodo, subida, tamaño0, tamaño1, opacidad, oscuridad]
  const src = [];
  for (const c of chimneys) src.push([c.x, CHIMNEY_TOP + 0.25, c.z, Math.round(16 * k), 9, 7.5, 0.55, 2.8, 0.55, 0.8]);
  for (const [x, y, z, s] of BRAZIERS) src.push([x, y + 1.55 * s, z, Math.round(6 * k), 7, 4.5 * s, 0.22 * s, 1.3 * s, 0.26, 0.3]);
  // casas del campo: una de cada dos con la lumbre encendida
  const houses = world.mapGroup.getObjectByName('periphery-fortaleza-settlement');
  if (houses?.isInstancedMesh) {
    const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), off = new THREE.Vector3();
    for (let i = 0; i < houses.count; i += 2) {
      houses.getMatrixAt(i, m4); m4.premultiply(houses.matrixWorld); m4.decompose(pos, q, sc);
      const rise = Math.min(sc.x, sc.z) * 0.42;
      off.set(sc.x * 0.26, 0, sc.z * 0.18).applyQuaternion(q);
      src.push([pos.x + off.x, pos.y + sc.y / 2 + rise * 0.7, pos.z + off.z, Math.round(10 * k), 13, 12, 0.9, 4.6, 0.32, 0.1]);
    }
  }
  const n = src.reduce((a, s) => a + s[3], 0);
  const S = new Float32Array(n * 4), K = new Float32Array(n * 4), A = new Float32Array(n * 4);
  let i = 0;
  for (const [x, y, z, count, period, rise, s0, s1, alpha, dark] of src) {
    for (let j = 0; j < count; j++, i++) {
      S.set([x + r(-0.1, 0.1), y, z + r(-0.1, 0.1), rng() * 10], i * 4);
      K.set([period * r(0.85, 1.15), rise * r(0.85, 1.1), s0 * r(0.8, 1.2), s1 * r(0.8, 1.2)], i * 4);
      A.set([alpha * r(0.75, 1), dark, (j + rng() * 0.6) / count, 0], i * 4);
    }
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  inst(THREE, geo, 'aS', S, 4); inst(THREE, geo, 'aK', K, 4); inst(THREE, geo, 'aA', A, 4);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uSun: { value: sunBody.clone() },
      uSmoke: { value: lin(THREE, P.fire.smoke) },
      uSmokeLit: { value: lin(THREE, P.fire.smokeLit) },
      uSunCol: { value: lin(THREE, P.light.sun) },
    }]),
    transparent: true, depthWrite: false, fog: true, toneMapped: false,
  });
  // merge clona: las referencias compartidas se reponen después
  mat.uniforms.uLookTime = uniforms.uLookTime;
  mat.uniforms.uLookWind = uniforms.uLookWind;
  return instMesh(THREE, geo, mat, n, 'atmos-smoke', 2);
}

export function build(ctx) {
  const { THREE, budget, group, world } = ctx;
  const body = world.mapGroup?.getObjectByName('sky-body');
  const sunBody = body ? body.position.clone().normalize() : ctx.sunDir.clone();
  const chimneys = forgeChimneys(world.colliders);

  group.add(buildClouds(ctx, sunBody));
  group.add(buildBirds(ctx));
  group.add(buildFlames(ctx));
  group.add(buildSmoke(ctx, sunBody, chimneys));
  const parts = budget.particles | 0;
  if (parts > 0) {
    const nSparks = Math.round(parts * 0.22), nLeaves = Math.round(parts * 0.05);
    // [x, y, z, escala, peso]: braseros y la boca de cada chimenea de la fragua
    const sources = [...BRAZIERS.map(([x, y, z, s]) => [x, y, z, s, s]), ...chimneys.map((c) => [c.x, CHIMNEY_TOP + 0.2, c.z, 0.7, 0.45])];
    group.add(buildSparks(ctx, parts - nSparks - nLeaves, nSparks, sunBody, sources));
    group.add(buildLeaves(ctx, nLeaves));
  }
  return {};
}
