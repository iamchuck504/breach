// GLSL compartido por el look y sus capas de vida.
import * as THREE from 'three';

export const NOISE = /* glsl */`
float lkHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float lkHash21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 lkHash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float lkNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lkHash21(i), lkHash21(i + vec2(1.0, 0.0)), f.x), mix(lkHash21(i + vec2(0.0, 1.0)), lkHash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float lkFbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * lkNoise(p); p = p * 2.03 + 17.7; a *= 0.5; } return s; }
`;

// Solo para fragmentos: integra una raya periódica sobre la huella del píxel.
// En la distancia converge a su cobertura media en vez de alternar claro/oscuro.
export const FILTERED_DETAIL = /* glsl */`
float lkStripeIntegral(float x, float duty) {
  return floor(x)*duty + min(fract(x), duty);
}
float lkStripe(float phase, float duty) {
  float w = max(fwidth(phase), 0.001);
  float x = phase + duty*0.5;
  return clamp((lkStripeIntegral(x+w*0.5,duty)-lkStripeIntegral(x-w*0.5,duty))/w,0.0,1.0);
}
float lkDetail(vec2 p) {
  vec2 w = fwidth(p);
  return mix(lkNoise(p), 0.5, smoothstep(0.25,1.0,max(w.x,w.y)));
}
`;

// Viento: desplazamiento en mundo para algo anclado. `weight` 0 = anclado,
// 1 = extremo libre; `phase` desfasa cada pieza. Usa uLookTime y uLookWind
// (xz = dirección * fuerza, y = racha 0..1), que el contexto ya entrega.
export const WIND = /* glsl */`
uniform float uLookTime; uniform vec3 uLookWind;
vec3 lkWind(vec3 worldPos, float weight, float phase) {
  float t = uLookTime;
  float gust = 0.6 + 0.4 * sin(t * 0.37 + worldPos.x * 0.05 + worldPos.z * 0.04) + uLookWind.y * 0.5;
  float a = sin(t * 1.9 + phase * 6.283 + worldPos.x * 0.35 + worldPos.z * 0.27);
  float b = sin(t * 3.7 + phase * 11.0 + worldPos.z * 0.9);
  vec2 dir = uLookWind.xz;
  vec2 side = vec2(-dir.y, dir.x);
  vec2 d = dir * (0.55 + 0.45 * a) * gust + side * b * 0.22;
  return vec3(d.x, -abs(a) * 0.12 * length(dir), d.y) * weight;
}
`;

// Inserta código en un material estándar de Three (Lambert/Standard/Basic)
// sin perder luces, sombras, niebla ni el buffer HDR. Encadena con un
// onBeforeCompile anterior si lo hay.
//   uniforms      objeto { nombre: { value } }  (compartir la MISMA referencia entre materiales)
//   vertexPars    declaraciones del vértice
//   vertex        tras <begin_vertex>: puede modificar `transformed` (espacio local)
//   fragmentPars  declaraciones del fragmento
//   fragment      tras <color_fragment>: puede modificar `diffuseColor`
//   normal        tras <normal_fragment_maps>: puede modificar `normal` (espacio de vista)
//   emissive      tras <emissivemap_fragment>: puede modificar `totalEmissiveRadiance`
//   rough         tras <roughnessmap_fragment>: puede modificar `roughnessFactor`
//   key           identifica la variante (obligatorio: comparte programa entre materiales iguales)
// Solo para Standard y Lambert cuando el código use `objectNormal` (Basic no
// siempre la declara). En GLSL, smoothstep(a, b, x) exige a < b: para una
// rampa descendente, 1.0 - smoothstep(...).
export function patch(material, { uniforms = {}, vertexPars = '', vertex = '', fragmentPars = '', fragment = '', normal = '', emissive = '', rough = '', key }) {
  // Un gancho anterior (el de _applyMacroVariation u otro patch) se conserva:
  // primero corre él, luego este; y su clave entra en la nuestra.
  const own = (k) => Object.prototype.hasOwnProperty.call(material, k);
  const prev = own('onBeforeCompile') ? material.onBeforeCompile : null;
  const prevKey = own('customProgramCacheKey') ? material.customProgramCacheKey : null;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    const ins = (src, anchor, code) => (code ? src.replace(anchor, `${anchor}\n${code}`) : src);
    let v = shader.vertexShader, f = shader.fragmentShader;
    v = ins(v, '#include <common>', vertexPars);
    v = ins(v, '#include <begin_vertex>', vertex);
    f = ins(f, '#include <common>', fragmentPars);
    f = ins(f, '#include <color_fragment>', fragment);
    f = ins(f, '#include <normal_fragment_maps>', normal);
    f = ins(f, '#include <emissivemap_fragment>', emissive);
    f = ins(f, '#include <roughnessmap_fragment>', rough);
    shader.vertexShader = v; shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|look:${key}`;
  material.userData.lookPatched = true;
  material.needsUpdate = true;
  return material;
}

export const linear = (hex) => new THREE.Color(hex);
