// Piezas comunes de las capas de vida de Azoteas: niebla en sombreadores
// propios, atributos por instancia y el material aditivo de las luces.
import { NOISE } from '../glsl.js';

// Misma niebla que la escena (FogExp2) para ShaderMaterial con fog: true.
// Como en los materiales de Three, se mezcla DESPUÉS de <colorspace_fragment>:
// el uniforme fogColor llega ya en el espacio de color de la salida.
export const FOG_GLSL = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor; uniform float fogDensity; uniform float fogNear; uniform float fogFar;
  float azFog(float d) {
    #ifdef FOG_EXP2
      return 1.0 - exp(-fogDensity * fogDensity * d * d);
    #else
      return smoothstep(fogNear, fogFar, d);
    #endif
  }
  vec3 azFogColor() { return fogColor; }
#else
  float azFog(float d) { return 0.0; }
  vec3 azFogColor() { return vec3(0.0); }
#endif
`;
export { NOISE };

export const lin = (THREE, hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);

export function inst(THREE, geo, name, arr, size) {
  geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
}

// Malla instanciada cuya posición real sale del sombreador
export function instMesh(THREE, geo, mat, count, name, order = 0) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.name = name;
  m.frustumCulled = false;
  m.castShadow = m.receiveShadow = false;
  m.renderOrder = order;
  m.matrixAutoUpdate = false;
  return m;
}

// ShaderMaterial con niebla de escena y el tiempo compartido del look.
// additive: luz que se suma (premultiplicada: gl_FragColor.rgb ya lleva alfa)
export function shaderMat(THREE, ctx, { vertexShader, fragmentShader, uniforms = {}, additive = false, transparent = additive, fog = true, side, depthWrite }) {
  const mat = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    transparent, fog, toneMapped: false,
    depthWrite: depthWrite ?? !transparent,
    side: side ?? THREE.FrontSide,
    ...(additive ? {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    } : {}),
  });
  // merge clona: las referencias compartidas se reponen después
  mat.uniforms.uLookTime = ctx.uniforms.uLookTime;
  mat.uniforms.uLookWind = ctx.uniforms.uLookWind;
  return mat;
}
