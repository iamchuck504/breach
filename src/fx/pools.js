// Pools instanciados simulados en GPU (portados de Crashterra, src/fx/pools.ts).
// Cada elemento se escribe UNA vez al nacer (ring buffer: un pool lleno
// recicla el más viejo) y se anima entero en el vertex shader a partir de su
// instante de nacimiento; la CPU solo sube el rango sucio. Un evento nunca
// crea geometría, materiales ni objetos.
//
// Mezcla premultiplicada (ONE, ONE_MINUS_SRC_ALPHA): cada elemento lleva un
// factor "aditivo" m, así energía (m = 1, suma luz) y humo/polvo (m = 0,
// tapa) comparten un único draw call.
//
// Niebla propia por uniforms (no la de three): el mapa cambia entre Fog y
// FogExp2 y eso, con fog:true, crearía un programa nuevo al primer disparo.
import * as THREE from 'three';

// Uniforms compartidos por todos los materiales de efectos.
export function createFxUniforms() {
  return {
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color(0, 0, 0) },
    // x near, y far (lineal), z densidad (exp2; > 0 la activa)
    uFog: { value: new THREE.Vector3(1e5, 1e5 + 1, 0) },
    // 1 con cadena HDR; 0 al lienzo sRGB directo (gfx=off)
    uHdr: { value: 0 },
    // luz ambiente aproximada del mapa para humo y polvo (no emiten luz)
    uAmbient: { value: new THREE.Color(1, 1, 1) },
    // luz de explosión: xyz posición, w intensidad 0..1 (ilumina el humo)
    uBlast: { value: new THREE.Vector4(0, -1000, 0, 0) },
  };
}

const COMMON_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uFog;
uniform float uHdr;
float fxFog(float d) {
  if (uFog.z > 0.0) return 1.0 - exp(-uFog.z * uFog.z * d * d);
  return uFog.y > uFog.x ? smoothstep(uFog.x, uFog.y, d) : 0.0;
}
// Sin cadena HDR el lienzo recorta todo lo > 1: se comprime preservando el
// tono (un tracer rojo sigue siendo rojo con núcleo claro, no amarillo-blanco).
// Se codifica el color RECTO y luego se aplica la cobertura: premultiplicar
// antes de la codificación sRGB aclararía los bordes suaves.
// Sin HDR la energía aditiva se suma y satura a blanco (una bola de fuego
// de 16 lenguas): se baja la exposición de lo aditivo para conservar el color.
vec3 fxLdr(vec3 c, float m) { return uHdr < 0.5 ? c * mix(1.0, 0.38, m) : c; }
vec3 fxOut(vec3 c) {
  c = max(c, vec3(0.0));
  if (uHdr < 0.5) {
    float mx = max(max(c.r, c.g), max(c.b, 1e-4));
    if (mx > 1.0) c = mix(c / mx, vec3(1.0), clamp((mx - 1.0) * 0.09, 0.0, 0.5));
  }
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
`;

const HIDE = 'gl_Position = vec4(0.0, 0.0, -2.0, 1.0);';

function premulMaterial(vs, fs, uniforms, shared, offset = false) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: vs,
    fragmentShader: COMMON_GLSL + fs,
    uniforms: { ...shared, ...uniforms },
    fog: false,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: offset,
    polygonOffsetFactor: offset ? -2 : 0,
    polygonOffsetUnits: offset ? -4 : 0,
  });
  mat.userData.shared = true;
  return mat;
}

// Ring buffer de instancias con n atributos vec4 llamados a0..a{n-1}.
export class GpuPool {
  constructor(cap, nAttr, base, material, lifeAttr, lifeComp) {
    this.cap = cap;
    this.limit = cap; // slots activos (<= cap): baja con el nivel de calidad
    this.material = material;
    this.lifeAttr = lifeAttr;
    this.lifeComp = lifeComp;
    this.cursor = 0;
    this.runs = new Int32Array(16);
    this.nRuns = 0;
    this.runA = -1;
    this.runB = -1;
    this.hi = -1;
    this.until = -1;
    this.i = 0; // slot del último alloc()
    this.o = 0; // offset (i * 4) del último alloc()
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const k of Object.keys(base.attributes)) geo.setAttribute(k, base.attributes[k]);
    geo.instanceCount = 0;
    geo.userData.shared = true;
    this.data = [];
    this.attrs = [];
    for (let a = 0; a < nAttr; a++) {
      const arr = new Float32Array(cap * 4);
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('a' + a, at);
      this.data.push(arr);
      this.attrs.push(at);
    }
    // todo nace muerto (vida 0)
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  alloc() {
    const i = this.cursor;
    this.cursor = i + 1 >= this.limit ? 0 : i + 1;
    this.mark(i);
    this.i = i;
    this.o = i * 4;
    return i;
  }

  // Marca un slot escrito. Las escrituras se agrupan en tramos contiguos:
  // un ring buffer que da la vuelta (1499 y luego 0) sube DOS tramos, no
  // el buffer entero. hi = slot más alto vivo desde el último reposo: el
  // draw solo envía hi + 1 instancias.
  mark(i) {
    if (i > this.hi) this.hi = i;
    if (this.runA < 0) { this.runA = this.runB = i; return; }
    if (i === this.runB + 1) { this.runB = i; return; }
    if (i >= this.runA && i <= this.runB) return;
    this._pushRun();
    this.runA = this.runB = i;
  }

  _pushRun() {
    if (this.runA < 0) return;
    if (this.nRuns < 8) {
      this.runs[this.nRuns * 2] = this.runA;
      this.runs[this.nRuns * 2 + 1] = this.runB;
      this.nRuns++;
    } else {
      // demasiados tramos sueltos: uno que los cubra a todos
      let lo = this.runA, hi = this.runB;
      for (let k = 0; k < this.nRuns; k++) { lo = Math.min(lo, this.runs[k * 2]); hi = Math.max(hi, this.runs[k * 2 + 1]); }
      this.runs[0] = lo; this.runs[1] = hi; this.nRuns = 1;
    }
    this.runA = this.runB = -1;
  }

  flush() {
    this._pushRun();
    if (!this.nRuns) return;
    // three limpia los rangos tras cada subida; si pasan varios ticks sin
    // render se acumulan, y con demasiados se sube el buffer entero.
    for (const at of this.attrs) {
      if (at.updateRanges.length > 24) {
        at.clearUpdateRanges();
        at.addUpdateRange(0, this.cap * 4);
      } else {
        for (let k = 0; k < this.nRuns; k++) {
          const a = this.runs[k * 2];
          at.addUpdateRange(a * 4, (this.runs[k * 2 + 1] - a + 1) * 4);
        }
      }
      at.needsUpdate = true;
    }
    this.nRuns = 0;
  }

  // Resta dt a todos los nacimientos: el reloj de FX vuelve a 0 y el float
  // de 32 bits del shader conserva precisión de sub-frame en sesiones largas.
  rebase(dt) {
    const a0 = this.data[0];
    for (let i = 0; i < this.cap; i++) a0[i * 4 + 3] -= dt;
    this.until -= dt;
    this.runA = this.runB = -1;
    this.runs[0] = 0; this.runs[1] = this.cap - 1; this.nRuns = 1;
  }

  clear() {
    const arr = this.data[this.lifeAttr];
    for (let i = 0; i < this.cap; i++) arr[i * 4 + this.lifeComp] = 0;
    this.cursor = 0;
    this.hi = -1;
    this.runA = this.runB = -1;
    this.runs[0] = 0; this.runs[1] = this.cap - 1; this.nRuns = 1;
  }
}

/* ------------------------------------------------------------- sprites */
/*
 a0: pos.xyz, birth      a1: vel.xyz, life       a2: gravity, drag, floorY, spin
 a3: size0, size1, stretch, cell                  a4: rgb (lineal, puede ser > 1), alpha
 a5: aditivo m, núcleo caliente, inicio del fade-out, fade-in (fracción de vida)
*/
const SPRITE_VS = /* glsl */ `
uniform float uTime;
uniform vec3 uAmbient;
uniform vec4 uBlast;
attribute vec4 a0; attribute vec4 a1; attribute vec4 a2; attribute vec4 a3; attribute vec4 a4; attribute vec4 a5;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vX;
varying float vGround;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  vUv = vec2(0.0); vCol = vec4(0.0); vX = vec3(0.0); vGround = 1.0;
  if (age < 0.0 || age >= life) { ${HIDE} return; }
  float t = age / life;
  float grav = a2.x;
  float drag = a2.y;
  float e = exp(-drag * age);
  float k = drag > 1e-4 ? (1.0 - e) / drag : age;
  vec3 p = a0.xyz + a1.xyz * k;
  p.y += drag > 1e-4 ? grav * (age - k) / drag : 0.5 * grav * age * age;
  vec3 vel = a1.xyz * e;
  vel.y += grav * k;
  float ss = 1.0 - (1.0 - t) * (1.0 - t);
  float size = mix(a3.x, a3.y, ss);
  float landed = 0.0;
  if (p.y < a2.z) { p.y = a2.z + size * 0.3; vel = vec3(0.0); landed = 1.0; }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
  // Ninguna partícula supera ~12 % de la altura de pantalla: nada grande
  // pegado a la lente tapa la retícula (projectionMatrix[1][1] = 1/tan(fov/2)).
  float maxS = 0.24 * max(depth, 0.02) / projectionMatrix[1][1];
  size = min(size, maxS);
  vec2 c = position.xy;
  vec2 off;
  vec3 vv = mat3(viewMatrix) * vel;
  float sp = length(vv.xy);
  if (a3.z > 0.0 && sp > 0.05) {
    vec2 ax = vv.xy / sp;
    float len = min(size + sp * a3.z, maxS);
    off = ax * (c.y * len) + vec2(-ax.y, ax.x) * (c.x * size);
  } else {
    float a = h1(float(gl_InstanceID)) * 6.2832 + a2.w * age;
    float cs = cos(a);
    float sn = sin(a);
    off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
  }
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  // Altura de esta esquina sobre el suelo del nacimiento: intersección suave.
  float wy = p.y + (vec3(off, 0.0) * mat3(viewMatrix)).y;
  vGround = a2.z > -1e4 ? (wy - a2.z) / max(size, 0.01) : 1.0;
  float cell = a3.w;
  vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + c + 0.5) * 0.25;
  float alpha = a4.a * clamp(t / max(a5.w, 1e-3), 0.0, 1.0) * (1.0 - smoothstep(a5.z, 1.0, t));
  // Nada justo delante de la lente: desvanece dentro de ~1.2 m.
  alpha *= smoothstep(0.7, 1.5, depth) * (1.0 - 0.5 * landed);
  // Humo y polvo no emiten: toman la luz del mapa y la de la explosión.
  vec3 bd = p - uBlast.xyz;
  float blast = uBlast.w * 3.0 / (1.0 + dot(bd, bd) * 0.35);
  vec3 lit = uAmbient + vec3(1.0, 0.55, 0.25) * blast;
  vCol = vec4(a4.rgb * mix(lit, vec3(1.0), a5.x), alpha);
  vX = vec3(a5.x, a5.y, depth);
}`;

const SPRITE_FS = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vX;
varying float vGround;
void main() {
  vec4 tx = texture2D(uAtlas, vUv);
  float a = tx.r * vCol.a * smoothstep(-0.05, 0.45, vGround);
  if (a < 0.003) discard;
  vec3 col = vCol.rgb * tx.b + vec3(tx.g * vX.y) * vCol.rgb;
  float f = fxFog(vX.z);
  float m = vX.x;
  col = mix(col, uFogColor * (1.0 - m), f);
  gl_FragColor = vec4(fxOut(fxLdr(col, m)) * a, a * (1.0 - m));
}`;

export function createSpritePool(cap, atlas, shared) {
  const base = new THREE.PlaneGeometry(1, 1);
  const mat = premulMaterial(SPRITE_VS, SPRITE_FS, { uAtlas: { value: atlas } }, shared);
  return new GpuPool(cap, 6, base, mat, 1, 3);
}

/* ------------------------------------------------------------- tracers */
/*
 a0: inicio.xyz, birth    a1: fin.xyz, life     a2: rgb, ancho
 a3: velocidad (0 = haz instantáneo), largo de estela, caliente, alpha
*/
const TRACER_VS = /* glsl */ `
uniform float uTime;
attribute vec4 a0; attribute vec4 a1; attribute vec4 a2; attribute vec4 a3;
varying vec3 vCol;
varying vec3 vP; // lado, a lo largo, alpha
varying float vDepth;
varying float vHot;
void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  vCol = vec3(0.0); vP = vec3(0.0); vDepth = 0.0; vHot = 0.0;
  if (age < 0.0 || age >= life) { ${HIDE} return; }
  float t = age / life;
  vec3 D = a1.xyz - a0.xyz;
  float L = length(D);
  vec3 dir = D / max(L, 1e-4);
  float head;
  float tail;
  float fade;
  if (a3.x > 0.0) {
    head = min(age * a3.x, L);
    tail = clamp(age * a3.x - a3.y, 0.0, L);
    fade = 1.0 - smoothstep(0.75, 1.0, t);
  } else {
    head = L;
    tail = 0.0;
    fade = (1.0 - t) * (1.0 - t);
  }
  float s = mix(tail, head, position.y);
  vec3 P = a0.xyz + dir * s;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  vec3 vd = mat3(viewMatrix) * dir;
  vec3 side = cross(vd, mv.xyz);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
  float depth = -mv.z;
  // piso de ~1.5 px: un tracer lejano sigue leyéndose
  float w = max(a2.w, depth * 0.0021);
  mv.xyz += side * (w * position.x);
  gl_Position = projectionMatrix * mv;
  // Los primeros metros desde el cañón se desvanecen: nunca una franja sobre la lente.
  float near = smoothstep(0.35, 2.2, s) * smoothstep(0.15, 0.8, depth);
  // Un haz lejano y fino conserva su energía: ensanchar al piso de píxel atenúa.
  float thin = clamp(a2.w / w, 0.25, 1.0);
  vP = vec3(position.x, a3.x > 0.0 ? position.y : 1.0, a3.w * fade * near * thin);
  vCol = a2.rgb;
  vDepth = depth;
  vHot = a3.z;
}`;

const TRACER_FS = /* glsl */ `
varying vec3 vCol;
varying vec3 vP;
varying float vDepth;
varying float vHot;
void main() {
  float x = vP.x;
  float prof = exp(-x * x * 3.5);
  float core = exp(-x * x * 26.0);
  float along = 0.25 + 0.75 * vP.y * vP.y;
  float a = vP.z * along * prof;
  if (a < 0.002) discard;
  // sin HDR el núcleo blanco se recorta: más color de equipo, menos blanco
  float hot = uHdr < 0.5 ? 0.3 : 1.0;
  vec3 col = (vCol * prof * (uHdr < 0.5 ? 0.6 : 1.0) + vec3(core * vHot * hot)) * vP.z * along;
  col *= 1.0 - fxFog(vDepth);
  // aditivo puro: alpha 0
  float k = max(max(col.r, col.g), max(col.b, 1e-4));
  float cov = min(k, 1.0);
  gl_FragColor = vec4(fxOut(col / cov) * cov, 0.0);
}`;

export function createTracerPool(cap, shared) {
  // Cinta: 2 columnas (lado -1/1) × filas a lo largo, más densas en la cola.
  const rows = [0, 0.008, 0.02, 0.045, 0.09, 0.17, 0.3, 0.5, 0.75, 1];
  const pos = [];
  const idx = [];
  rows.forEach((y, r) => {
    pos.push(-1, y, 0, 1, y, 0);
    if (r > 0) {
      const a = (r - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  base.setIndex(idx);
  const mat = premulMaterial(TRACER_VS, TRACER_FS, {}, shared);
  return new GpuPool(cap, 4, base, mat, 1, 3);
}

/* --------------------------------------------------------------- rings */
/*
 a0: centro.xyz, birth   a1: normal.xyz (0 = mira a cámara), life
 a2: rgb, alpha           a3: r0, r1, grosor, aditivo m
 a4: relleno interior, semilla, caliente, -
*/
const RING_VS = /* glsl */ `
uniform float uTime;
uniform vec3 uAmbient;
attribute vec4 a0; attribute vec4 a1; attribute vec4 a2; attribute vec4 a3; attribute vec4 a4;
varying vec2 vL;
varying vec4 vCol;
varying vec4 vR; // R, grosor, relleno, semilla
varying vec3 vX; // m, caliente, profundidad
void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  vL = vec2(0.0); vCol = vec4(0.0); vR = vec4(0.0); vX = vec3(0.0);
  if (age < 0.0 || age >= life) { ${HIDE} return; }
  float t = age / life;
  float R = mix(a3.x, a3.y, 1.0 - pow(1.0 - t, 3.0));
  float th = a3.z * (1.0 - 0.5 * t);
  float ext = R + th * 2.5;
  vec2 c = position.xy * 2.0;
  vec4 mv;
  if (dot(a1.xyz, a1.xyz) > 0.01) {
    vec3 n = normalize(a1.xyz);
    vec3 tA = abs(n.y) < 0.95 ? normalize(cross(n, vec3(0.0, 1.0, 0.0))) : normalize(cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 tB = cross(n, tA);
    mv = viewMatrix * vec4(a0.xyz + (tA * c.x + tB * c.y) * ext, 1.0);
  } else {
    mv = viewMatrix * vec4(a0.xyz, 1.0);
    mv.xy += c * ext;
  }
  gl_Position = projectionMatrix * mv;
  vL = c * ext;
  float alpha = a2.a * clamp(t / 0.06, 0.0, 1.0) * pow(1.0 - t, 1.6);
  alpha *= smoothstep(0.7, 1.5, -mv.z);
  vCol = vec4(a2.rgb * mix(uAmbient, vec3(1.0), a3.w), alpha);
  vR = vec4(R, th, a4.x, a4.y);
  vX = vec3(a3.w, a4.z, -mv.z);
}`;

const RING_FS = /* glsl */ `
varying vec2 vL;
varying vec4 vCol;
varying vec4 vR;
varying vec3 vX;
void main() {
  float r = length(vL);
  float R = vR.x;
  float th = max(vR.y, 1e-3);
  float d = (r - R) / th;
  float ring = exp(-d * d * (d < 0.0 ? 1.2 : 3.0));
  float ang = atan(vL.y, vL.x);
  float brk = 0.72 + 0.28 * sin(ang * 7.0 + vR.w) * sin(ang * 3.0 - vR.w * 2.0 + 1.3);
  float inner = vR.z * smoothstep(0.0, R, r) * step(r, R) * 0.6;
  float a = (ring * brk + inner) * vCol.a;
  if (a < 0.003) discard;
  vec3 col = vCol.rgb * (1.0 + vX.y * exp(-d * d * 10.0));
  float f = fxFog(vX.z);
  float m = vX.x;
  col = mix(col, uFogColor * (1.0 - m), f);
  gl_FragColor = vec4(fxOut(fxLdr(col, m)) * a, a * (1.0 - m));
}`;

export function createRingPool(cap, shared) {
  const base = new THREE.PlaneGeometry(1, 1);
  const mat = premulMaterial(RING_VS, RING_FS, {}, shared);
  return new GpuPool(cap, 5, base, mat, 1, 3);
}

/* ------------------------------------------------------- fogonazos */
// Malla de fogonazo: tres planos cruzados a lo largo del cañón (+Z local)
// con el pétalo del atlas. Desde la cámara al hombro se ve de lado, donde
// un sprite plano mirando a cámara no tendría forma.
const FLASH_FS = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec4 uCol; // rgb HDR, alpha
uniform float uCell;
uniform float uM; // 1 aditivo (fuego), 0 cubre (columna de polvo)
varying vec2 vC;
varying float vDepth;
varying float vFace;
void main() {
  vec2 c = vec2(vC.x, vC.y * 2.0 - 1.0) * 0.5;
  vec2 uv = (vec2(mod(uCell, 4.0), floor(uCell / 4.0)) + c + 0.5) * 0.25;
  vec4 tx = texture2D(uAtlas, uv);
  float a = tx.r * uCol.a * smoothstep(0.08, 0.45, vFace) * smoothstep(0.5, 1.2, vDepth);
  if (a < 0.003) discard;
  // bordes naranja, raíz blanca: la forma se lee aunque el centro florezca
  vec3 col = uCol.rgb * (0.45 + 2.2 * tx.g * mix(0.2, 1.0, uM));
  gl_FragColor = vec4(fxOut(fxLdr(col, uM)) * a, a * (1.0 - uM));
}`;

// Tres planos rotados 60° entre sí alrededor del eje Z (el cañón).
export function createFlashCross() {
  const geo = new THREE.BufferGeometry();
  const pos = [], idx = [];
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI;
    const cx = Math.cos(ang), sy = Math.sin(ang);
    const b = k * 4;
    // vértice (u, v): u lateral rotado alrededor del eje, v a lo largo
    for (const [u, v] of [[-0.5, 0], [0.5, 0], [-0.5, 1], [0.5, 1]]) pos.push(u * cx, u * sy, v);
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // uv: x lateral (-0.5..0.5), y a lo largo (0..1)
  const uv = [];
  for (let k = 0; k < 3; k++) uv.push(-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // normal del plano para el desvanecido de canto
  const nrm = [];
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI;
    for (let j = 0; j < 4; j++) nrm.push(-Math.sin(ang), Math.cos(ang), 0);
  }
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.userData.shared = true;
  return geo;
}

const FLASH_CROSS_VS = /* glsl */ `
varying vec2 vC;
varying float vDepth;
varying float vFace;
void main() {
  vC = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFace = abs(dot(n, normalize(-mv.xyz)));
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

// Fogonazos instanciados: un draw call para todos los vivos.
/*
 a0: pos.xyz, birth      a1: dirección.xyz (unitaria), life
 a2: rgb (HDR), alpha     a3: ancho, largo, giro, aditivo m
*/
const FLASH_POOL_VS = /* glsl */ `
uniform float uTime;
attribute vec4 a0; attribute vec4 a1; attribute vec4 a2; attribute vec4 a3;
varying vec2 vC;
varying vec4 vCol;
varying float vM;
varying float vFace;
varying float vDepth;
void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  vC = vec2(0.0); vCol = vec4(0.0); vM = 0.0; vFace = 0.0; vDepth = 0.0;
  if (age < 0.0 || age >= life || dot(a1.xyz, a1.xyz) < 1e-6) { ${HIDE} return; }
  float t = age / life;
  vec3 d = normalize(a1.xyz);
  vec3 up = abs(d.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tA = normalize(cross(d, up));
  vec3 tB = cross(d, tA);
  float cr = cos(a3.z);
  float sr = sin(a3.z);
  vec3 rA = tA * cr + tB * sr;
  vec3 rB = tB * cr - tA * sr;
  float g = 1.0 + 0.35 * t;
  vec3 p = a0.xyz + (rA * position.x + rB * position.y) * a3.x * g + d * position.z * a3.y * (1.0 + 0.55 * t);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec3 n = normalize(mat3(viewMatrix) * (rA * normal.x + rB * normal.y));
  vFace = abs(dot(n, normalize(-mv.xyz)));
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
  vC = uv;
  vCol = vec4(a2.rgb, a2.a * pow(1.0 - t, 1.3));
  vM = a3.w;
}`;
const FLASH_POOL_FS = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vC;
varying vec4 vCol;
varying float vM;
varying float vFace;
varying float vDepth;
void main() {
  vec2 c = vec2(vC.x, vC.y * 2.0 - 1.0) * 0.5;
  vec2 uv = (vec2(2.0, 3.0) + c + 0.5) * 0.25; // celda 14: PETAL
  vec4 tx = texture2D(uAtlas, uv);
  float a = tx.r * vCol.a * smoothstep(0.08, 0.45, vFace) * smoothstep(0.5, 1.2, vDepth);
  if (a < 0.003) discard;
  vec3 col = vCol.rgb * (0.45 + 2.2 * tx.g * mix(0.2, 1.0, vM));
  gl_FragColor = vec4(fxOut(fxLdr(col, vM)) * a, a * (1.0 - vM));
}`;

export function createFlashPool(cap, atlas, shared) {
  const base = createFlashCross();
  const mat = premulMaterial(FLASH_POOL_VS, FLASH_POOL_FS, { uAtlas: { value: atlas } }, shared);
  return new GpuPool(cap, 4, base, mat, 1, 3);
}

export function createFlashMaterial(atlas, shared) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLASH_CROSS_VS,
    fragmentShader: COMMON_GLSL + FLASH_FS,
    uniforms: {
      uHdr: shared.uHdr, uFogColor: shared.uFogColor, uFog: shared.uFog,
      uAtlas: { value: atlas },
      uCol: { value: new THREE.Vector4(1, 1, 1, 1) },
      uCell: { value: 14 },
      uM: { value: 1 },
    },
    fog: false,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  mat.userData.shared = true;
  return mat;
}

/* --------------------------------------------------------------- chunks */
// Restos sólidos (casquillos, lascas, fragmentos de armadura): un
// InstancedMesh iluminado simulado en CPU con gravedad, giro y rebotes.
// Portado de Crashterra (src/fx/chunks.ts); el suelo se consulta al
// mundo de forma escalonada en vez de un heightmap analítico.
export class Chunks {
  constructor(cap, geometry, name, roughness = 0.6, metalness = 0.1) {
    this.cap = cap;
    this.limit = cap;
    this.cursor = 0;
    this.active = 0;
    this.hi = -1; // slot vivo más alto desde el último reposo
    this.colorDirty = -1;
    this.colorMin = Infinity;
    const geo = geometry;
    this.glow = new Float32Array(cap);
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.glowAttr);
    geo.userData.shared = true;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness, flatShading: true });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow;');
    };
    mat.customProgramCacheKey = () => 'fx-chunks';
    mat.userData.shared = true;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.col = new Float32Array(cap * 3).fill(1);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.col, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // por chunk: px py pz vx vy vz ax ay az ang w sx sy sz age life floor next bounce (20)
    this.st = new Float32Array(cap * 20);
    this.alive = new Uint8Array(cap);
    this.rest = new Uint8Array(cap);
    this.collide = new Uint8Array(cap);
    this.mesh.instanceMatrix.array.fill(0);
  }

  spawn(x, y, z, vx, vy, vz, sx, sy, sz, r, g, b, glow, life, floor, bounce = 0.32, collide = 0) {
    const i = this.cursor;
    this.cursor = i + 1 >= this.limit ? 0 : i + 1;
    if (!this.alive[i]) this.active++;
    if (i > this.hi) this.hi = i;
    this.alive[i] = 1;
    this.rest[i] = 0;
    this.collide[i] = collide;
    const s = this.st;
    const o = i * 20;
    s[o] = x; s[o + 1] = y; s[o + 2] = z;
    s[o + 3] = vx; s[o + 4] = vy; s[o + 5] = vz;
    let ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
    const al = Math.hypot(ax, ay, az) || 1;
    s[o + 6] = ax / al; s[o + 7] = ay / al; s[o + 8] = az / al;
    s[o + 9] = Math.random() * 6.28;
    s[o + 10] = (6 + Math.random() * 14) * (Math.random() < 0.5 ? -1 : 1);
    s[o + 11] = sx; s[o + 12] = sy; s[o + 13] = sz;
    s[o + 14] = 0;
    s[o + 15] = life;
    s[o + 16] = floor;
    s[o + 17] = Math.random() * 0.1; // próxima consulta de suelo
    s[o + 18] = bounce;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.glow[i] = glow;
    if (i > this.colorDirty) this.colorDirty = i;
    if (i < this.colorMin) this.colorMin = i;
  }

  // floorAt(x, z, y) → altura del suelo; hitWall(i, st, o, dt) opcional para paredes
  update(dt, floorAt, hitWall) {
    if (this.colorDirty >= 0) {
      const a = this.mesh.instanceColor;
      const g = this.glowAttr;
      if (a.updateRanges.length > 24 || g.updateRanges.length > 24) {
        a.clearUpdateRanges(); g.clearUpdateRanges();
        a.addUpdateRange(0, this.cap * 3); g.addUpdateRange(0, this.cap);
      } else {
        a.addUpdateRange(this.colorMin * 3, (this.colorDirty - this.colorMin + 1) * 3);
        g.addUpdateRange(this.colorMin, this.colorDirty - this.colorMin + 1);
      }
      a.needsUpdate = true;
      g.needsUpdate = true;
      this.colorDirty = -1;
      this.colorMin = Infinity;
    }
    if (this.active === 0) { this.hi = -1; this.cursor = 0; }
    if (this.active === 0 || dt <= 0) return;
    const s = this.st;
    const m = this.mesh.instanceMatrix.array;
    let touched = false;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const o = i * 20;
      s[o + 14] += dt;
      const age = s[o + 14];
      const life = s[o + 15];
      const mo = i * 16;
      if (age >= life) {
        this.alive[i] = 0;
        this.active--;
        for (let k = 0; k < 16; k++) m[mo + k] = 0;
        touched = true;
        continue;
      }
      const sy = s[o + 12];
      if (!this.rest[i]) {
        s[o + 4] -= 16 * dt;
        const damp = Math.exp(-0.4 * dt);
        s[o + 3] *= damp; s[o + 5] *= damp;
        // paredes solo mientras vuela rápido: tras el primer rebote ya no atraviesa nada
        if (this.collide[i] && hitWall && s[o + 3] * s[o + 3] + s[o + 4] * s[o + 4] + s[o + 5] * s[o + 5] > 4) hitWall(s, o, dt);
        s[o] += s[o + 3] * dt;
        s[o + 1] += s[o + 4] * dt;
        s[o + 2] += s[o + 5] * dt;
        s[o + 9] += s[o + 10] * dt;
        // el suelo se reconsulta ~10 veces por segundo: cae de un tejado
        // sin quedarse flotando y sin pagar una consulta por frame
        s[o + 17] -= dt;
        if (s[o + 17] <= 0 && floorAt) {
          s[o + 17] = 0.1;
          s[o + 16] = floorAt(s[o], s[o + 2], s[o + 1]);
        }
        const floor = s[o + 16] + sy * 0.4;
        if (s[o + 1] < floor) {
          s[o + 1] = floor;
          if (s[o + 4] < -1.6) {
            s[o + 4] = -s[o + 4] * s[o + 18];
            s[o + 3] *= 0.55; s[o + 5] *= 0.55;
            s[o + 10] *= 0.6;
          } else {
            this.rest[i] = 1;
            s[o + 3] = s[o + 4] = s[o + 5] = 0;
          }
        }
      } else if (life - age > 0.5) {
        continue; // en reposo y sin fade: matriz sin cambios
      }
      // se va encogiendo en los últimos 0.5 s
      const k = Math.min(1, (life - age) / 0.5);
      const half = s[o + 9] * 0.5;
      const sn = Math.sin(half);
      const qx = s[o + 6] * sn, qy = s[o + 7] * sn, qz = s[o + 8] * sn, qw = Math.cos(half);
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
      const xx = qx * x2, xy = qx * y2, xz = qx * z2;
      const yy = qy * y2, yz = qy * z2, zz = qz * z2;
      const wx = qw * x2, wy = qw * y2, wz = qw * z2;
      const sx = s[o + 11] * k, syk = sy * k, sz = s[o + 13] * k;
      m[mo] = (1 - (yy + zz)) * sx; m[mo + 1] = (xy + wz) * sx; m[mo + 2] = (xz - wy) * sx; m[mo + 3] = 0;
      m[mo + 4] = (xy - wz) * syk; m[mo + 5] = (1 - (xx + zz)) * syk; m[mo + 6] = (yz + wx) * syk; m[mo + 7] = 0;
      m[mo + 8] = (xz + wy) * sz; m[mo + 9] = (yz - wx) * sz; m[mo + 10] = (1 - (xx + yy)) * sz; m[mo + 11] = 0;
      m[mo + 12] = s[o]; m[mo + 13] = s[o + 1]; m[mo + 14] = s[o + 2]; m[mo + 15] = 1;
      touched = true;
    }
    if (touched) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.active = 0;
    this.cursor = 0;
    this.hi = -1;
    this.mesh.instanceMatrix.array.fill(0);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
