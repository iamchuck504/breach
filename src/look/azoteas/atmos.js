// Capa de vida "atmos" del look de Azoteas (contrato en ../index.js): el
// VAPOR de la noche. Sale de chimeneas reales: las de los techos vecinos
// (fuera del campo) y la del generador, desde más de 5 m de altura: nunca
// cruza una línea de tiro, ni siquiera desde las entreplantas.
// Una llamada de dibujo (cuadros instanciados); sin presupuesto de
// partículas (nivel 'off') no hay vapor.
import { FOG_GLSL, NOISE, lin, inst, instMesh, shaderMat } from './shared.js';
import { planCity } from './city-plan.js';

const STEAM_VERT = /* glsl */`
uniform float uLookTime; uniform vec3 uLookWind;
attribute vec4 aS; // x, y base, z, altura de subida
attribute vec2 aK; // fase, tamaño
attribute vec3 aTint;
varying vec2 vUv; varying float vA; varying float vDist; varying float vSeed; varying vec3 vTint;
void main() {
  float life = 7.0;
  float t = fract(uLookTime / life + aK.x);
  float rise = t * aS.w;
  vec3 c = vec3(aS.x, aS.y + rise, aS.z) + vec3(uLookWind.x, 0.0, uLookWind.z) * t * 3.0 * (0.6 + uLookWind.y);
  float size = aK.y * (0.45 + 1.7 * t);
  vec3 toCam = normalize(cameraPosition - c);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-4, 0.0, 0.0));
  vec3 up = cross(toCam, right);
  vec3 w = c + (right * position.x + up * position.y) * size;
  vUv = position.xy + 0.5;
  vSeed = aK.x * 37.0;
  vTint = aTint;
  vA = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.4, 1.0, t));
  vec4 mv = viewMatrix * vec4(w, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const STEAM_FRAG = /* glsl */`
uniform vec3 uLit, uShade;
varying vec2 vUv; varying float vA; varying float vDist; varying float vSeed; varying vec3 vTint;
${NOISE}${FOG_GLSL}
void main() {
  vec2 p = vUv - 0.5;
  float n = lkNoise(vUv * 3.0 + vSeed) * 0.6 + lkNoise(vUv * 7.0 - vSeed) * 0.4;
  float a = (1.0 - smoothstep(0.12, 0.5, length(p) + (n - 0.5) * 0.28)) * vA * 0.42;
  vec3 c = mix(uShade, uLit, vUv.y) + vTint * (0.6 - vUv.y * 0.3);
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, azFogColor(), azFog(vDist));
}`;

export function build(ctx) {
  const { THREE, group, budget } = ctx;
  if ((budget.particles | 0) <= 0) return {};
  const rnd = ctx.rng('steam');
  const none = { r: 0, g: 0, b: 0 };
  // chimeneas de los edificios vecinos (./city-plan.js) y la del generador
  const src = planCity().stacks.map(([x, y, z]) => [x, y, z, 8, 2.2, none]);
  src.push([25.48, 5.45, 6.45, 6, 1.1, none]);

  const count = Math.round(28 + 40 * budget.detail);
  const S = new Float32Array(count * 4), K = new Float32Array(count * 2), T = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = src[i % src.length];
    S.set([s[0] + (rnd() - 0.5) * 0.6, s[1], s[2] + (rnd() - 0.5) * 0.6, s[3]], i * 4);
    K.set([rnd(), s[4]], i * 2);
    T.set([s[5].r, s[5].g, s[5].b], i * 3);
  }
  const geo = new THREE.PlaneGeometry(1, 1);
  inst(THREE, geo, 'aS', S, 4); inst(THREE, geo, 'aK', K, 2); inst(THREE, geo, 'aTint', T, 3);
  const mat = shaderMat(THREE, ctx, {
    vertexShader: STEAM_VERT, fragmentShader: STEAM_FRAG, transparent: true, side: THREE.DoubleSide,
    uniforms: { uLit: { value: lin(THREE, 0x9aa3b4) }, uShade: { value: lin(THREE, 0x3e4552) } },
  });
  group.add(instMesh(THREE, geo, mat, count, 'atmos-steam', 2));
  return {};
}
