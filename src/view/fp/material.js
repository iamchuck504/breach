// MATERIALES EN PRIMERA PERSONA. El arma lleva desgaste propio. Los
// brazos usan la paleta y el shader del cuerpo del soldado.
//
// Mismo lenguaje que el soldado (soldier-bake.js): color, rugosidad, metal,
// brillo y zona de equipo viajan por vértice; el shader añade detalle sin
// texturas (no hay UV). Lo propio del primer plano:
//  · desgaste en aristas convexas (atributo `_wear` horneado por
//    scripts/build-viewmodel-art.mjs) con ruido: la pintura y el polímero
//    se pelan en los cantos y dejan ver metal;
//  · variación de rugosidad por ruido en el espacio de la pieza (no "nada"
//    al moverse) — de cerca, una superficie con rugosidad uniforme parece
//    plástico de juguete;
//  · PROYECCIÓN PROPIA: FOV vertical fijo y profundidad comprimida en
//    [0, VM_DEPTH] del buffer (parche de pipeline.js). Se dibuja en la misma
//    pasada que el mapa (luz, sombra, niebla, bloom y gradación del mapa) y
//    nunca se mete en una pared.
import * as THREE from 'three';
import { patch, NOISE } from '../../look/glsl.js';
import { SOLDIER_TEAM, soldierMaterial, soldierSurface } from '../../player/soldier-bake.js';
import { patchViewModelMaterial, VIEWMODEL_FOV } from '../../render/pipeline.js';

// La proyección y la profundidad comprimida son las de la cadena de imagen
// (src/render/pipeline.js, INTEGRACIÓN): mismos uniformes, mismo rango que
// ignora el AO. FOV del arma = ajuste `fovWeapon` (50°, como la cámara de CRASHTERRA).
export { VIEWMODEL_DEPTH as VM_DEPTH, viewModelFov, updateViewModelProjection, viewModelToMainView } from '../../render/pipeline.js';
export const VM_FOV = VIEWMODEL_FOV;

export const TEAM_HEX = SOLDIER_TEAM;
const lin = (r, g, b) => new THREE.Color(r, g, b);
export const KIND = { suit: 0, armor: 1, metal: 2, polymer: 3, mark: 4, glow: 5, rubber: 6, paint: 7, webbing: 8 };
// Superficie por nombre de material del GLB. `team`: 0 neutro, 0.5 panel de
// equipo (tono profundo), 1 acento. `glow`: emisivo HDR. `region`: 'gun' o 'arm'.
export function surfaceOf(name, region, variant = 0) {
  const n = String(name).toLowerCase();
  if (region !== 'gun') {
    const s = soldierSurface(n, region, variant);
    if (s) return s;
  }
  if (n.includes('led')) return { color: lin(1, 0.2, 0.1), rough: 0.3, metal: 0.1, glow: 2.6, team: 1, kind: KIND.glow };
  if (n.includes('painted red')) return { color: lin(0.3, 0.05, 0.04), rough: 0.42, metal: 0.18, glow: 0, team: 1, kind: KIND.paint };
  if (n.includes('rubber')) return { color: lin(0.03, 0.034, 0.04), rough: 0.84, metal: 0, glow: 0, team: 0, kind: KIND.rubber };
  if (n.includes('edge gunmetal') || n.includes('machined')) return { color: lin(0.26, 0.27, 0.28), rough: 0.3, metal: 0.78, glow: 0, team: 0, kind: KIND.metal };
  if (n.includes('graphite')) return { color: lin(0.075, 0.08, 0.088), rough: 0.58, metal: 0.06, glow: 0, team: 0, kind: KIND.polymer };
  if (n.includes('slate metal')) return { color: lin(0.13, 0.14, 0.16), rough: 0.4, metal: 0.62, glow: 0, team: 0, kind: KIND.metal };
  if (n.includes('unit markings')) return { color: lin(0.62, 0.6, 0.52), rough: 0.6, metal: 0.05, glow: 0, team: 0, kind: KIND.mark };
  if (n.includes('optic')) return { color: lin(0.02, 0.05, 0.065), rough: 0.17, metal: 0.6, glow: 0, team: 0, kind: KIND.metal };
  if (n.includes('copper')) return { color: lin(0.55, 0.3, 0.16), rough: 0.35, metal: 0.85, glow: 0, team: 0, kind: KIND.metal };
  return { color: lin(0.2, 0.2, 0.2), rough: 0.6, metal: 0.2, glow: 0, team: 0, kind: KIND.polymer };
}

// Relleno del arma ligado al ambiente del mapa (no es otra luz): lo pone
// el viewmodel cada cuadro con el hemisferio + ambiente del mundo. Sin él,
// de noche el arma era una silueta negra.
export const VM_FILL = { uVmFill: { value: new THREE.Color(0.06, 0.06, 0.065) } };

const RELLENO_AMBIENTAL = /* glsl */`
  // relleno desde el ojo + borde suave, en el color del ambiente del mapa
  vec3 vV = normalize(vViewPosition + vec3(0.0, 0.0, 1e-5));
  float vFace = clamp(dot(normal, vV), 0.0, 1.0);
  vec3 reflected = inverseTransformDirection(reflect(-vV, normal), viewMatrix);
  float sky = smoothstep(-0.3 - roughnessFactor * 0.4, 0.45 + roughnessFactor * 0.4, reflected.y);
  float grazing = pow(1.0 - vFace, 4.0);
  vec3 specularTint = mix(vec3(0.04), diffuseColor.rgb, metalnessFactor);
  totalEmissiveRadiance += uVmFill * (diffuseColor.rgb * (0.45 + 0.65 * vFace)
    + mix(specularTint, vec3(0.85), grazing) * (0.18 + 1.8 * sky));
`;

const SHADER = {
  vertexPars: /* glsl */`
attribute vec4 aSurf; attribute vec2 aDetail; attribute float aWear;
varying vec4 vSurf; varying vec2 vDetail; varying vec3 vLoc; varying vec3 vLocN; varying float vWear;`,
  vertex: /* glsl */`
vSurf = aSurf; vDetail = aDetail; vLoc = position; vLocN = normal; vWear = aWear;`,
  fragmentPars: /* glsl */`
uniform vec3 uTeam; uniform vec3 uVmFill;
varying vec4 vSurf; varying vec2 vDetail; varying vec3 vLoc; varying vec3 vLocN; varying float vWear;
${NOISE}
// ruido "triplanar" barato en el espacio de la pieza
float vmTri(vec3 p, vec3 n) {
  vec3 w = abs(n) + 1e-4; w /= (w.x + w.y + w.z);
  return lkNoise(p.yz) * w.x + lkNoise(p.xz + 7.1) * w.y + lkNoise(p.xy + 3.7) * w.z;
}`,
  fragment: /* glsl */`
{
  float vKind = floor(vDetail.x * 255.0 + 0.5);
  float vSeed = vDetail.y * 17.0;
  float vTeamOn = step(0.02, vSurf.w);
  float vAccent = step(0.75, vSurf.w);
  vec3 alb = diffuseColor.rgb;
  alb = mix(alb, uTeam * mix(0.46, 0.86, vAccent), vTeamOn);
  float isPaint = 1.0 - step(0.5, abs(vKind - 7.0));
  float isPoly = 1.0 - step(0.5, abs(vKind - 3.0));
  float isArmor = 1.0 - step(0.5, abs(vKind - 1.0));
  float isMetal = 1.0 - step(0.5, abs(vKind - 2.0));
  float isRub = 1.0 - step(0.5, abs(vKind - 6.0));
  float isSuit = 1.0 - step(0.5, vKind);
  vec3 q = vLoc * 38.0 + vSeed;
  float aw = length(fwidth(q));
  float fade = 1.0 - smoothstep(0.6, 2.5, aw);       // el detalle fino se apaga lejos
  // desgaste en cantos: máscara de ruido sobre la arista horneada
  float chip = vmTri(vLoc * 90.0 + vSeed, vLocN) * 0.65 + vmTri(vLoc * 23.0 - vSeed, vLocN) * 0.35;
  float edge = smoothstep(0.15, 0.75, vWear);
  float wear = smoothstep(0.42, 0.72, edge * (0.6 + 0.6 * chip)) * fade;
  // pintura y cerámica dejan ver metal claro; polímero y goma se aclaran
  vec3 bare = vec3(0.36, 0.36, 0.37);
  alb = mix(alb, bare, wear * (isPaint + isArmor) * 0.85);
  alb = mix(alb, alb * 1.9 + 0.025, wear * (isPoly + isRub + isSuit) * 0.55);
  alb = mix(alb, alb * 1.35 + 0.02, wear * isMetal * 0.6);
  // mugre suave lejos de los cantos y variación de lote
  float lot = vmTri(vLoc * 6.0 + vSeed, vLocN);
  alb *= 1.0 - 0.18 * (1.0 - edge) * lot * fade;
  // trama de tejido y textura de goma (pequeñísima, solo de cerca)
  float weave = 0.5 + 0.5 * sin((vLoc.x + vLoc.y * 1.7 + vLoc.z) * 900.0);
  float weaveFade = 1.0 - smoothstep(1.0, 3.0, fwidth((vLoc.x + vLoc.y * 1.7 + vLoc.z) * 900.0));
  alb *= 1.0 - (isSuit * 0.065 * weave) * weaveFade;
  float webbing = 1.0 - step(0.5, abs(vKind - 8.0));
  float rib = 0.5 + 0.5 * cos((vLoc.x + 1.7 * vLoc.y + vLoc.z) * 160.0);
  alb *= 1.0 - webbing * fade * (0.16 * rib + 0.12 * lot);
  diffuseColor.rgb = alb;
  vWearF = wear; vLotF = lot;
}`,
  rough: /* glsl */`
{
  float vKindR = floor(vDetail.x * 255.0 + 0.5);
  float vBareR = (1.0 - step(0.5, abs(vKindR - 7.0))) + (1.0 - step(0.5, abs(vKindR - 1.0)));
  float r = vSurf.x + (vLotF - 0.5) * 0.18;
  r = mix(r, 0.32, vWearF * clamp(vBareR, 0.0, 1.0));     // metal pulido por el roce
  r = mix(r, r * 0.8, vWearF * (1.0 - clamp(vBareR, 0.0, 1.0)));
  roughnessFactor = clamp(r, 0.08, 1.0);
}`,
  normal: /* glsl */`
{
  float vKindM = floor(vDetail.x * 255.0 + 0.5);
  float vBareM = (1.0 - step(0.5, abs(vKindM - 7.0))) + (1.0 - step(0.5, abs(vKindM - 1.0)));
  metalnessFactor = mix(vSurf.y, 0.85, vWearF * clamp(vBareM, 0.0, 1.0));
}`,
  emissive: /* glsl */`
{
  float vTeamOnE = step(0.02, vSurf.w);
  vec3 vGlow = mix(vColor.rgb, uTeam, vTeamOnE) * vSurf.z * 8.0;
  // La pintura de las placas del soldado recibe sólo iluminación de superficie.
  float vSelf = step(0.5, abs(vDetail.x * 255.0 - 1.0)) * vTeamOnE * mix(0.035, 0.08, step(0.75, vSurf.w));
  totalEmissiveRadiance += vGlow + uTeam * vSelf;
${RELLENO_AMBIENTAL}
}`,
};

const MATERIALS = new Map();
// Brazos y pierna comparten el acabado del soldado y la proyección del visor.
const LIMBS = new Map();
export function limbMaterial(team, conRelleno = false) {
  const color = team === 'blue' ? 'blue' : 'red';
  const key = conRelleno ? color + '-brazos' : color;
  if (!LIMBS.has(key)) {
    const source = soldierMaterial(color);
    const material = source.clone();
    material.name = 'fp soldado ' + key;
    material.onBeforeCompile = source.onBeforeCompile;
    material.customProgramCacheKey = source.customProgramCacheKey;
    material.userData = { fpViewModel: true, fpUniforms: source.userData.soldierUniforms };
    if (conRelleno) {
      material.userData.fpUniforms = { ...source.userData.soldierUniforms, ...VM_FILL };
      patch(material, { uniforms: VM_FILL, fragmentPars: 'uniform vec3 uVmFill;',
        emissive: RELLENO_AMBIENTAL, key: 'relleno-ambiental' });
    }
    LIMBS.set(key, patchViewModelMaterial(material));
  }
  return LIMBS.get(key);
}

/** Acabado de las armas en primera persona. */
export function vmMaterial(team) {
  const key = team === 'blue' ? 'blue' : 'red';
  if (MATERIALS.has(key)) return MATERIALS.get(key);
  const material = new THREE.MeshStandardMaterial({ name: `fp viewmodel ${key}`, vertexColors: true, roughness: 1, metalness: 1 });
  const uniforms = { uTeam: { value: new THREE.Color(TEAM_HEX[key]) }, ...VM_FILL };
  // variables que pasan del bloque de color a los de rugosidad/metal
  const fragmentPars = `${SHADER.fragmentPars}\nfloat vWearF = 0.0; float vLotF = 0.5;`;
  patch(material, { ...SHADER, fragmentPars, uniforms, key: 'fp-viewmodel-v2' });
  // proyección propia y profundidad comprimida (la de la cadena de imagen)
  patchViewModelMaterial(material);
  material.userData.fpViewModel = true;
  material.userData.fpUniforms = uniforms;
  MATERIALS.set(key, material);
  return material;
}
