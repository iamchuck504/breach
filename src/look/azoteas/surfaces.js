// LOOK DE AZOTEAS: techos de la ciudad en una noche despejada.
// Solo cambia materiales, luz, cielo y niebla de lo que ya construyó el mapa:
// ni una caja se mueve. Los techos son de materiales reales (concreto,
// grava, membrana, chapa galvanizada, esmalte gris); el color llega de los
// letreros de los edificios vecinos: cada superficie suma la luz que le
// derraman (./signage.js), sin luces dinámicas.
//
// Regla de valor de noche: remates y bordes de cobertura CLAROS, cuerpos de
// valor medio, piso medio-oscuro y de poco contraste.
import * as THREE from 'three';
import { FILTERED_DETAIL, NOISE, patch } from '../glsl.js';
import { collisionBoxesFor } from '../../world/collision-layouts.js';
import { SPILL, SPILL_GLSL, spillUniforms, flicker } from './signage.js';

export function surfaces(ctx) {
  const { world, palette: P } = ctx;
  applyEnvironment(world, P);
  const U = paletteUniforms(P);
  U.uLkMacro = { value: world._macroNoiseTexture() };
  U.uLookTime = ctx.uniforms.uLookTime;
  U.uLkMoonDir = { value: ctx.sunDir.clone() };
  // la luz de los letreros solo existe donde están los letreros: el mapa
  // hecho a mano (un clon del editor no los tiene)
  const S = spillUniforms(THREE, P, ctx.real && ctx.layers.has('signs'));
  Object.assign(U, S);
  ctx.azSpill = S; // ./signs.js lee el mismo parpadeo
  const blink = restyle(ctx, U);
  // los edificios de ./city.js usan la misma fachada
  ctx.azFacade = () => {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
    return patch(m, { ...FACADE(0x101217, false), uniforms: pick(U, Object.keys(U)), key: 'az2-facade' });
  };
  const K = S.uLkSpillK.value, on = ctx.real && ctx.layers.has('signs');
  return {
    grade: P.grade,
    update(dt, t) {
      // balizas de obstrucción: destello lento, todas a la vez (como en un
      // techo real, sincronizadas)
      for (const b of blink) {
        const ph = (t * b.rate + b.phase) % 1;
        const f = ph < 0.18 ? Math.sin((ph / 0.18) * Math.PI) : 0;
        b.mat.color.copy(b.base).multiplyScalar(0.18 + f * b.gain);
      }
      if (!on) return;
      for (let i = 0; i < SPILL.length; i++) K[i] = flicker(SPILL[i].flick, t, i + 1);
    },
  };
}

function applyEnvironment(world, P) {
  const L = P.light;
  world.hemi.color.setHex(L.hemiSky);
  world.hemi.groundColor.setHex(L.hemiGround);
  world.hemi.intensity = L.hemiIntensity;
  world.amb.color.setHex(L.amb);
  world.amb.intensity = L.ambIntensity;
  world.sun.color.setHex(L.moon);
  world.sun.intensity = L.moonIntensity;
  world._setSky(P.sky.stops);
  // Exponencial: dentro del campo apenas se nota; la ciudad lejana se funde
  // en la bruma baja del horizonte.
  world.scene.fog = new THREE.FogExp2(L.fog, L.fogDensity);
}

function paletteUniforms(P) {
  const c = (hex) => ({ value: new THREE.Color(hex) });
  const k = P.concrete, f = P.floor, t = P.top, w = P.windows, l = P.lamp;
  return {
    uLkBody: c(k.body), uLkDark: c(k.dark), uLkCope: c(k.cope), uLkPlinth: c(k.plinth), uLkStain: c(k.stain),
    uLkTopAc: c(t.ac), uLkTopVent: c(t.vent), uLkTopHut: c(t.hut), uLkTopDeck: c(t.deck),
    uLkDuct: c(P.duct.metal), uLkSeam: c(P.duct.seam),
    uLkSteel: c(P.steel.mid), uLkSteelDark: c(P.steel.dark), uLkSteelLight: c(P.steel.light),
    uLkHazard: c(P.hazard),
    uLkMembrane: c(f.membrane), uLkPaver: c(f.paver), uLkJoint: c(f.joint), uLkWest: c(f.westRoof), uLkEast: c(f.eastRoof), uLkGravel: c(f.gravel),
    uLkWarm: c(l.warm), uLkAmber: c(l.amber),
    uLkWinWarm: c(w.warm), uLkWinCool: c(w.cool), uLkWinTv: c(w.tv), uLkWinGlass: c(w.glass),
    uLkStreet: c(P.sky.street),
  };
}

// ---------------------------------------------------------------- GLSL
const VARY_V = /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
`;
// Posición y normal en mundo (instanciado o no). Solo Standard y Lambert:
// declaran objectNormal siempre.
const WORLD_V = /* glsl */`
{
  vec4 lkP = vec4(transformed, 1.0); vec3 lkN = objectNormal;
  #ifdef USE_INSTANCING
    lkP = instanceMatrix * lkP; lkN = mat3(instanceMatrix) * lkN;
  #endif
  vLkPos = (modelMatrix * lkP).xyz;
  vLkN = normalize(mat3(modelMatrix) * lkN);
}`;
// Variante sin normal (MeshBasic no declara objectNormal)
const POS_V = /* glsl */`
{
  vec4 lkP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    lkP = instanceMatrix * lkP;
  #endif
  vLkPos = (modelMatrix * lkP).xyz;
}`;
const MACRO = /* glsl */`
uniform sampler2D uLkMacro;
float lkMacro(vec2 p) { return texture2D(uLkMacro, p).r; }
float lkMid(vec2 p) { return texture2D(uLkMacro, p).g; }
`;
const BUMP_N = /* glsl */`
normal = normalize(normal + (viewMatrix * vec4(lkBump, 0.0)).xyz);
`;
// La luz de los letreros entra como emisión multiplicada por el albedo: se
// comporta como luz difusa y no depende de luces de la escena.
const SPILL_E = /* glsl */`
totalEmissiveRadiance += lkGlow + diffuseColor.rgb * lkSpill(vLkPos, normalize(vLkN), 0.45);
`;

// TAPAS DE LOS BLOQUES. aBox = (u, v, ancho, fondo) en metros. La familia
// del bloque (A/C, ducto, caseta, muro, entreplanta, claraboya) llega en el
// color por vértice que World ya pone: se reconoce por su valor y por la
// proporción azul/rojo (el brillo aleatorio por bloque no la cambia).
// Todas llevan un canto claro (chapa de remate o albardilla): el borde de la
// cobertura se lee de noche aunque el cuerpo quede en sombra.
const TOPS = {
  vertexPars: `attribute vec4 aBox; attribute vec2 aBoxMeta; varying vec4 vLkBox; varying vec2 vLkMeta;${VARY_V}`,
  vertex: `vLkBox = aBox; vLkMeta = aBoxMeta;${WORLD_V}`,
  fragmentPars: /* glsl */`
varying vec4 vLkBox; varying vec2 vLkMeta;
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkCope, uLkStain, uLkSeam, uLkSteelDark, uLkSteel, uLkHazard, uLkWarm;
uniform vec3 uLkTopAc, uLkTopVent, uLkTopHut, uLkTopDeck;
${NOISE}${FILTERED_DETAIL}${MACRO}${SPILL_GLSL}
vec3 lkBump = vec3(0.0);
vec3 lkGlow = vec3(0.0);
float lkRough = -1.0;`,
  fragment: /* glsl */`
{
  vec3 c = diffuseColor.rgb;
  float lum = dot(c, vec3(0.3333)), rb = c.b / max(c.r, 1e-3);
  float u = vLkBox.x, v = vLkBox.y, W = max(vLkBox.z, 0.05), D = max(vLkBox.w, 0.05);
  float seed = vLkMeta.x * 91.0;
  vec2 wp = vLkPos.xz;
  float macro = lkMacro(wp * 0.04 + 0.21), mid = lkMid(wp * 0.13 + seed * 0.1);
  float grain = lkDetail(wp * 7.0 + seed) * 0.6 + lkDetail(wp * 19.0) * 0.4;
  float bd = min(min(u, W - u), min(v, D - v));
  float band = min(0.15, min(W, D) * 0.2);
  bool glass = rb > 3.0;
  float kind = glass ? 5.0 : lum > 0.50 ? 0.0 : lum > 0.41 ? 1.0 : lum > 0.31 ? 2.0 : lum > 0.17 ? 3.0 : 4.0;
  vec3 col;
  float edgePaint = 0.0;
  if (kind < 0.5) {
    // enfriadora: tapa de chapa esmaltada en paneles atornillados
    col = uLkTopAc * (0.93 + 0.08 * mid);
    col = mix(col, uLkSeam, lkStripe(u/1.2,.021) * 0.55);
    lkRough = 0.5;
  } else if (kind < 1.5) {
    // ducto: galvanizado con costuras cada 1.2 m y algo de "flor" del zinc
    col = uLkTopVent * (0.88 + 0.12 * lkHash11(floor(u / 1.2) + seed)) * (0.95 + 0.08 * grain);
    col = mix(col, uLkSeam, lkStripe(u/1.2,.025) * 0.8);
    lkRough = 0.42;
  } else if (kind < 2.5) {
    // caseta: grava de lastre sobre la losa, en manchas
    float peb = lkDetail(wp * 13.0 + seed) * 0.5 + lkDetail(wp * 31.0) * 0.5;
    col = uLkTopHut * (0.8 + 0.3 * peb) * (0.94 + 0.1 * mid);
    lkRough = 0.95;
    lkBump += vec3(peb - 0.5, 0.0, grain - 0.5) * 0.25;
  } else if (kind < 3.5) {
    // muro / pretil: albardilla de concreto prefabricado en piezas de 1 m
    float joint = lkStripe(max(u, v), .012);
    col = uLkCope * (0.86 + 0.12 * mid) * (0.95 + 0.05 * grain);
    col *= 1.0 - joint * 0.3;
    lkRough = 0.9;
  } else if (kind < 4.5) {
    // entreplanta: chapa estriada de acero; borde pintado de seguridad
    vec2 g = fract(wp * 2.6);
    float stud = 1.0 - smoothstep(0.08, 0.16, abs(g.x - g.y * 0.6 - 0.2));
    col = uLkTopDeck * (0.9 + 0.1 * mid);
    stud = mix(stud, .24, smoothstep(.18, .85, 2.6*max(fwidth(wp.x),fwidth(wp.y))));
    col = mix(col, col * 1.3, stud * 0.35);
    edgePaint = 1.0;
    lkRough = 0.55;
  } else {
    // claraboya: vidrio armado en retícula; abajo hay oficinas con la luz
    // de guardia encendida (blanco cálido, tenue)
    float bar = max(lkStripe(u/.6,.12),lkStripe(v/.6,.12));
    col = mix(uLkSteelDark * 0.6, uLkSteel, bar);
    lkGlow = uLkWarm * (1.0 - bar) * (0.012 + 0.02 * mid);
    lkRough = 0.15;
  }
  // canto claro perimetral (chapa de remate / albardilla)
  float cope = 1.0 - smoothstep(band - 0.01, band + 0.01, bd);
  col = mix(col, uLkCope * (0.95 + 0.08 * grain), cope * step(kind, 4.5) * (kind > 2.5 && kind < 3.5 ? 0.4 : 1.0));
  // franja de seguridad amarilla solo en el borde de las entreplantas
  float stripe = (1.0 - smoothstep(0.1, 0.12, bd)) * edgePaint;
  float hatch = lkStripe((u+v)*2.2+.25, .5);
  col = mix(col, mix(uLkHazard, uLkSteelDark, hatch * 0.85), stripe * 0.9);
  // mugre de lluvia en el centro de la tapa, nunca en el borde
  col *= mix(0.9, 1.05, macro) * mix(0.95, 1.04, grain);
  col = mix(col, uLkStain, smoothstep(0.55, 0.85, macro) * (1.0 - cope) * 0.22);
  diffuseColor.rgb = col;
  lkBump += vec3(grain - 0.5, 0.0, mid - 0.5) * 0.12;
}`,
  normal: BUMP_N,
  emissive: SPILL_E,
  rough: 'if (lkRough > 0.0) roughnessFactor = lkRough;',
};

// CARAS DE LOS BLOQUES que quedan a la vista: muros perimetrales y pretiles
// (concreto de encofrado, zócalo oscuro, albardilla clara y chorreo bajo
// ella), el pabellón de vidrio y los marcos de claraboya. El resto queda tras
// el forro de chapa del pulido.
const SIDES = {
  vertexPars: `attribute vec4 aBox; attribute vec2 aBoxMeta; varying vec4 vLkBox; varying vec2 vLkMeta;${VARY_V}`,
  vertex: `vLkBox = aBox; vLkMeta = aBoxMeta;${WORLD_V}`,
  fragmentPars: /* glsl */`
varying vec4 vLkBox; varying vec2 vLkMeta;
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkBody, uLkDark, uLkCope, uLkPlinth, uLkStain, uLkSteel, uLkSteelDark, uLkSteelLight, uLkWarm;
${NOISE}${FILTERED_DETAIL}${MACRO}${SPILL_GLSL}
vec3 lkBump = vec3(0.0);
vec3 lkGlow = vec3(0.0);`,
  fragment: /* glsl */`
{
  float u = vLkBox.x, v = vLkBox.y, W = max(vLkBox.z, 0.05), H = max(vLkBox.w, 0.05);
  vec3 c = diffuseColor.rgb / mix(0.74, 1.07, clamp(v / H, 0.0, 1.0));
  float rb = c.b / max(c.r, 1e-3);
  float seed = vLkMeta.x * 57.0;
  vec3 N = normalize(vLkN);
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec2 wp = vec2(dot(vLkPos, T), vLkPos.y);
  float macro = lkMacro(wp * 0.035 + 0.43), mid = lkMid(wp * 0.11 + seed * 0.07);
  float grain = lkDetail(wp * 8.0 + seed) * 0.6 + lkDetail(wp * 23.0) * 0.4;
  vec3 col;
  if (rb > 3.0) {
    if (H > 2.0) {
      // pabellón de vidrio: montantes de aluminio y paños oscuros que
      // reflejan el cielo; alguno deja ver la luz de guardia de adentro
      vec2 g = vec2(u / 1.25, (v - 0.25) / 1.4), gf = fract(g);
      float bar = max(lkStripe(g.x,.095/1.25),lkStripe(g.y,.095/1.4));
      float hp = lkHash21(floor(g) + seed);
      col = mix(vec3(0.05, 0.06, 0.075), uLkSteelLight, bar);
      float sheen = smoothstep(0.82, 0.95, fract((u + v) * 0.35 + hp)) * 0.3;
      col = mix(col, uLkSteelLight, sheen * (1.0 - bar));
      lkGlow = uLkWarm * (1.0 - bar) * step(0.8, hp) * step(0.25, v) * 0.05;
    } else {
      // marco de claraboya: acero galvanizado
      col = mix(uLkSteel, uLkSteelLight, 0.35 + 0.3 * grain);
    }
  } else {
    // concreto de encofrado: paneles de 2.4 x 1.2 con sus pasadores
    float pw = W / max(1.0, floor(W / 2.4 + 0.5));
    vec2 pg = vec2(u / pw, v / 1.2), pf = fract(pg);
    float h1 = lkHash21(floor(pg) + seed);
    col = mix(uLkBody, uLkDark, 0.3 + 0.3 * h1) * (0.92 + 0.1 * mid);
    float joint = max(lkStripe(pg.x,.026/pw), lkStripe(pg.y,.026/1.2));
    vec2 tie = abs(fract(vec2(u / pw * 2.0, v / 0.6)) - 0.5);
    float hole = 1.0 - smoothstep(0.03, 0.05, length(tie * vec2(pw * 0.5, 0.6)));
    col *= 1.0 - joint * 0.3 - hole * 0.35;
    // albardilla clara arriba, zócalo de impermeabilizante abajo
    float cope = 1.0 - smoothstep(0.14, 0.16, H - v);
    col = mix(col, uLkCope * (0.9 + 0.08 * grain), cope);
    col = mix(col, uLkPlinth, (1.0 - smoothstep(0.22, 0.26, v)) * 0.85);
    // chorreo de lluvia bajo la albardilla
    float streak = smoothstep(0.55, 0.85, lkDetail(vec2(u * 3.1, v * 0.25) + seed)) * smoothstep(H * 0.3, H, v) * (1.0 - cope);
    col = mix(col, uLkStain, streak * 0.35);
    lkBump = T * (grain - 0.5) * 0.2 + vec3(0.0, 1.0, 0.0) * (1.0 - smoothstep(0.0, 0.02, abs(H - v - 0.15))) * 0.6;
  }
  col *= mix(0.9, 1.06, macro);
  diffuseColor.rgb = col;
}`,
  normal: BUMP_N,
  emissive: SPILL_E,
};

// FORRO DE CHAPA de los equipos (el "skin" del pulido, una caja fina por
// cara). La escala de cada instancia da el tamaño de la cara: así las
// costillas y las costuras caen exactas. El color llega por instancia: uno
// por FAMILIA de equipo (./palette.js skin), con un matiz de desgaste.
const SKIN = {
  vertexPars: `varying vec4 vLkFace;${VARY_V}`,
  vertex: /* glsl */`
{
  float lkW = 1.0, lkH = 1.0;
  #ifdef USE_INSTANCING
    lkW = length(instanceMatrix[0].xyz); lkH = length(instanceMatrix[1].xyz);
  #endif
  vLkFace = vec4((position.x + 0.5) * lkW, (position.y + 0.5) * lkH, lkW, lkH);
}${WORLD_V}`,
  fragmentPars: /* glsl */`
varying vec4 vLkFace;
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkStain, uLkCope, uLkSeam;
${NOISE}${FILTERED_DETAIL}${MACRO}${SPILL_GLSL}
vec3 lkBump = vec3(0.0);
vec3 lkGlow = vec3(0.0);`,
  fragment: /* glsl */`
{
  float u = vLkFace.x, v = vLkFace.y, W = vLkFace.z, H = vLkFace.w;
  vec3 N = normalize(vLkN);
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec2 wp = vec2(dot(vLkPos, T), vLkPos.y);
  float macro = lkMacro(wp * 0.05 + 0.17), mid = lkMid(wp * 0.15 + 0.6);
  float grain = lkDetail(wp * 9.0) * 0.6 + lkDetail(wp * 27.0) * 0.4;
  vec3 col = diffuseColor.rgb;
  // chapa ondulada: costillas cada 12 cm
  float resolved = 1.0 - smoothstep(0.25, 1.0, fwidth(u) / 0.12);
  float rib = 0.5 + 0.5 * sin(u * 52.36) * resolved;
  col *= 0.9 + 0.1 * rib;
  float seamK = step(1.5, H) * (1.0 - smoothstep(0.012, 0.03, abs(v - H * 0.5)));
  col = mix(col, uLkSeam, seamK * 0.7);
  // óxido y polvo al pie, chorreo desde arriba, cantos gastados más claros
  float foot = 1.0 - smoothstep(0.0, 0.4 + macro * 0.3, v);
  col = mix(col, uLkStain, foot * 0.4);
  float streak = smoothstep(0.6, 0.9, lkDetail(vec2(u * 2.3, v * 0.2) + 3.0)) * smoothstep(H * 0.2, H, v);
  col = mix(col, uLkStain, streak * 0.2);
  float wear = 1.0 - smoothstep(0.0, 0.07, min(u, W - u) + (grain - 0.5) * 0.04);
  col = mix(col, uLkCope, wear * 0.3);
  col *= mix(0.9, 1.06, macro) * mix(0.95, 1.04, grain);
  diffuseColor.rgb = col;
  lkBump = T * cos(u * 52.36) * 0.35 * resolved + vec3(0.0, 1.0, 0.0) * seamK * 0.4;
}`,
  normal: BUMP_N,
  emissive: SPILL_E,
};

// PISO: losetas de concreto sobre plots en la azotea principal (tono que
// cambia apenas de una a otra) y membrana con grava suelta en las vecinas.
// Charcos poco profundos: más oscuros y casi espejo, recogen el neón de
// enfrente. Bajo contraste a propósito: el piso no compite con la cobertura.
const FLOOR = (mainX) => ({
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkMembrane, uLkPaver, uLkJoint, uLkWest, uLkEast, uLkGravel, uLkStain;
${NOISE}${FILTERED_DETAIL}${MACRO}${SPILL_GLSL}
vec3 lkBump = vec3(0.0);
vec3 lkGlow = vec3(0.0);
float lkWet = 0.0;`,
  fragment: /* glsl */`
{
  vec2 p = vLkPos.xz;
  float macro = lkMacro(p * 0.017 + 0.11), mid = lkMid(p * 0.07 + 0.53);
  float pool = lkMid(p * 0.045 + 0.61) * 0.6 + macro * 0.4;
  float grain = lkDetail(p * 6.0) * 0.6 + lkDetail(p * 21.0) * 0.4;
  vec3 col;
  if (abs(p.x) < ${mainX.toFixed(2)}) {
    vec2 g = p / 1.2, gf = fract(g), cell = floor(g);
    float h1 = lkHash21(cell), h2 = lkHash21(cell + 13.0);
    col = mix(uLkMembrane, uLkPaver, 0.6 + 0.3 * h1) * (0.96 + 0.06 * h2);
    float joint = max(lkStripe(g.x, .033), lkStripe(g.y, .033));
    col = mix(col, uLkJoint, joint * 0.6);
    lkBump = (vec3(gf.x < 0.5 ? -1.0 : 1.0, 0.0, 0.0) * (1.0 - smoothstep(0.0, 0.04, min(gf.x, 1.0 - gf.x) * 1.2))
            + vec3(0.0, 0.0, gf.y < 0.5 ? -1.0 : 1.0) * (1.0 - smoothstep(0.0, 0.04, min(gf.y, 1.0 - gf.y) * 1.2))) * 0.45 * (1.0-smoothstep(.02,.14,max(fwidth(p.x),fwidth(p.y))));
  } else {
    // membrana de rollos a lo largo de z, con grava suelta encima
    float r = fract(p.x / 1.0);
    vec3 roofC = p.x < 0.0 ? uLkWest : uLkEast;
    col = roofC * (0.94 + 0.06 * lkHash11(floor(p.x)));
    float lap = lkStripe(p.x, .03);
    col *= 1.0 - lap * 0.2;
    float peb = lkDetail(p * 9.0) * 0.55 + lkDetail(p * 23.0) * 0.45;
    col = mix(col, uLkGravel, smoothstep(0.4, 0.85, peb) * 0.3);
    lkBump = vec3(1.0, 0.0, 0.0) * lap * (r < 0.5 ? -0.5 : 0.5) + vec3(peb - 0.5, 0.0, grain - 0.5) * 0.3;
  }
  col *= mix(0.9, 1.06, macro) * mix(0.95, 1.04, grain);
  // manchas de humedad y charcos
  lkWet = (1.0 - smoothstep(0.36, 0.46, pool)) * 0.85;
  col = mix(col, col * 0.5, lkWet);
  col = mix(col, uLkStain, smoothstep(0.6, 0.85, mid) * 0.15);
  diffuseColor.rgb = col;
  // el relieve se apaga antes de que el charco sea espejo: sin filo brillante
  lkBump *= 1.0 - smoothstep(0.0, 0.3, lkWet);
}`,
  normal: BUMP_N,
  // el charco refleja el letrero (sin depender del albedo oscuro del charco)
  emissive: /* glsl */`
{
  vec3 lkS = lkSpill(vLkPos, vec3(0.0, 1.0, 0.0), 0.2);
  totalEmissiveRadiance += diffuseColor.rgb * lkS + lkS * lkWet * 0.28;
}`,
  rough: 'roughnessFactor = mix(roughnessFactor, 0.3, smoothstep(0.6, 0.85, lkWet));',
});

// FACHADAS de los edificios vecinos y de la ciudad: hormigón oscuro con
// estructura (pilastras cada cuatro vanos, cantos de losa, montantes), pocas
// ventanas encendidas (blanco cálido de vivienda, blanco frío de oficina,
// algún televisor), persianas, pisos enteros apagados y una columna de
// escalera con su luz de guardia. La cara que mira a la luna es más clara.
// Alrededor de cada letrero la pared toma su color. MeshBasic: se ve igual
// sin bloom.
export const FACADE = (roofHex, far) => ({
  // aLot: semilla del edificio (los de ./city.js la traen; si falta vale 0)
  vertexPars: 'attribute float aLot; varying vec3 vLkPos; varying float vLkLot;',
  vertex: `vLkLot = aLot;${POS_V}`,
  fragmentPars: /* glsl */`
varying vec3 vLkPos; varying float vLkLot;
uniform vec3 uLkWinWarm, uLkWinCool, uLkWinTv, uLkWinGlass, uLkMoonDir;
uniform float uLookTime;
${NOISE}${FILTERED_DETAIL}${SPILL_GLSL}`,
  fragment: /* glsl */`
{
  vec3 N = normalize(cross(dFdx(vLkPos), dFdy(vLkPos)) + vec3(0.0, 1e-5, 0.0));
  vec3 col;
  if (abs(N.y) > 0.6) {
    col = vec3(${new THREE.Color(roofHex).toArray().map((x) => x.toFixed(4)).join(', ')});
    col += lkSpill(vLkPos, vec3(0.0, 1.0, 0.0), 0.3) * 0.05;
  } else {
    vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    float u = dot(vLkPos, T), y = vLkPos.y + 8.0;
    // cada edificio (por su posición) tiene su ritmo de ventanas y su tono
    float bld = vLkLot > 0.0 ? vLkLot : lkHash21(floor(vLkPos.xz / 24.0) + 3.0);
    float cw = mix(1.5, 2.2, fract(bld * 7.3)), ch = mix(3.0, 3.5, fract(bld * 3.1));
    vec2 g = vec2(u / cw, y / ch), cell = floor(g), f = fract(g);
    float hw = lkHash21(cell + bld * 17.0), tone = lkHash21(cell * 1.3 + 5.0);
    float floorOn = step(0.3, lkHash21(vec2(cell.y, bld * 9.0)));
    float lit = step(${far ? '0.86' : '0.8'} - bld * 0.1, hw) * floorOn;
    // estructura: pilastra cada cuatro vanos (sin ventana), canto de losa
    float bay = mod(cell.x + floor(bld * 7.0), 4.0);
    float pil = step(bay, 0.5);
    float slab = 1.0 - smoothstep(0.1, 0.14, f.y);
    float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.3, f.y) * step(f.y, 0.86) * (1.0 - pil);
    // montante central en las ventanas anchas
    float mull = (1.0 - smoothstep(0.015, 0.035, abs(f.x - 0.5))) * step(1.8, cw);
    // escalera: una columna de ventanas estrechas, medio piso desfasadas, con
    // la luz fría de guardia siempre encendida
    float stair = step(abs(mod(cell.x + floor(bld * 13.0), 11.0) - 5.0), 0.5) * (1.0 - pil);
    float sf = fract(g.y + 0.5);
    float stairWin = stair * step(0.38, f.x) * step(f.x, 0.62) * step(0.25, sf) * step(sf, 0.75);
    vec3 light = tone < 0.68 ? uLkWinWarm : tone < 0.95 ? uLkWinCool : uLkWinTv;
    // persiana a medio bajar en algunas; televisor que cambia de plano
    float blind = step(0.55, fract(tone * 13.0)) * step(mix(0.45, 0.8, fract(tone * 7.0)), f.y);
    float tv = tone >= 0.95 ? 0.65 + 0.35 * step(0.5, fract(uLookTime * (0.21 + tone * 0.3) + hw)) : 1.0;
    light *= (0.45 + 0.4 * hw) * mix(1.0, 0.35, blind) * tv * mix(0.7, 1.0, f.y) * 0.75;
    // pared: más clara la cara que mira a la luna y hacia arriba (cielo)
    float moon = 0.7 + 0.75 * max(dot(N, uLkMoonDir), 0.0);
    vec3 wall = vec3(0.026, 0.028, 0.034) * (0.7 + 0.7 * bld) * moon * mix(0.75, 1.15, smoothstep(-8.0, 30.0, vLkPos.y));
    wall *= 1.0 + 0.45 * slab + 0.22 * pil;
    vec3 glass = uLkWinGlass + vec3(0.006, 0.008, 0.014) * f.y;
    win *= 1.0 - stair;
    col = mix(wall, mix(glass, light, lit) * (1.0 - mull * 0.85), win);
    col = mix(col, uLkWinCool * 0.22, stairWin);
    // planta baja: locales con escaparate (algunos abiertos, el resto con la
    // persiana metálica bajada) y portales
    float ground = 1.0 - step(3.6, y);
    float shop = step(0.08, fract(u / 6.0)) * step(fract(u / 6.0), 0.92) * step(0.25, y) * step(y, 3.0);
    float sh = lkHash21(vec2(floor(u / 6.0), bld * 31.0));
    vec3 shopC = sh > 0.62 ? uLkWinWarm * 0.55 : vec3(0.05, 0.05, 0.055) * (0.8 + 0.4 * step(0.5, fract(y * 6.0)));
    col = mix(col, mix(wall * 1.3, shopC, shop), ground);
    // a lo lejos, algún letrero diminuto: una mota de color, nada legible
    float dist = length(vLkPos.xz);
    float speck = step(0.997, lkHash21(cell * 0.71 + bld * 5.0)) * step(130.0, dist) * win * step(30.0, vLkPos.y);
    vec3 sc = fract(bld * 9.1) < 0.33 ? vec3(1.0, 0.35, 0.6) : fract(bld * 9.1) < 0.66 ? vec3(0.3, 1.0, 0.8) : vec3(1.0, 0.65, 0.2);
    col = mix(col, sc * 0.9, speck);
    // la luz de los letreros sobre su pared
    // (con tope: la pared justo detrás del tubo no se vuelve un cartel)
    vec3 lkW = lkSpill(vLkPos, N, 0.5) * 0.045;
    col += lkW / (1.0 + dot(lkW, vec3(1.2))) * (1.0 - win * lit);
  }
  diffuseColor.rgb = col;
}`,
});

// CALLES de abajo (se ven por el vacío entre azoteas, por encima de los
// pretiles y desde lo alto): la cuadrícula de ./city-plan.js. Calzada de
// asfalto, aceras de hormigón, línea central discontinua, pasos de cebra
// junto a los cruces, charcos de luz de sodio cada 24 m y una fila de
// tráfico en cada sentido (faros que alumbran delante, pilotos detrás). En
// nuestra manzana: el callejón de cada vacío y un estacionamiento en las
// esquinas que dejan libres las azoteas vecinas.
const STREET = {
  vertexPars: 'varying vec3 vLkPos;',
  vertex: POS_V,
  fragmentPars: /* glsl */`
varying vec3 vLkPos;
uniform vec3 uLkStreet, uLkAmber, uLkWarm;
uniform float uLookTime;
${NOISE}${FILTERED_DETAIL}
// un coche por celda de 24 m (si toca): lat = desvío del eje del carril,
// s = distancia a lo largo del sentido de marcha (ya con el tiempo)
vec3 lkCar(float lat, float s, float seed, inout float body) {
  float cell = floor(s / 24.0), f = s - cell * 24.0;
  float on = step(0.5, lkHash11(cell * 1.7 + seed));
  body += on * step(abs(lat), 0.9) * step(f, 4.4);
  float beam = (1.0 - smoothstep(0.4, 1.8, abs(lat))) * smoothstep(4.4, 5.0, f) * (1.0 - smoothstep(5.0, 13.0, f));
  float head = step(abs(abs(lat) - 0.6), 0.2) * step(4.15, f) * step(f, 4.45);
  float tail = step(abs(abs(lat) - 0.65), 0.15) * step(f, 0.22);
  return on * (vec3(1.0, 0.93, 0.8) * (beam * 0.22 + head * 2.5) + vec3(1.0, 0.08, 0.04) * tail * 0.9);
}`,
  fragment: /* glsl */`
{
  vec2 p = vLkPos.xz;
  float ax = abs(p.x), az = abs(p.y);
  float t = uLookTime;
  // distancia con signo al borde de cada vía (< 0: dentro)
  float dA1 = abs(ax - 64.2) - 11.0, dA2 = abs(ax - 133.0) - 8.0;
  float dS1 = abs(az - 48.8) - 8.0, dS2 = abs(az - 118.0) - 8.0;
  float dAv = min(dA1, dA2), dSt = min(dS1, dS2);
  float avenue = step(dAv, 0.0), street = step(dSt, 0.0), road = max(avenue, street);
  float cross = avenue * street;
  float side = max(avenue * step(-3.0, dAv) * (1.0 - street), street * step(-3.0, dSt) * (1.0 - avenue));
  float alley = step(32.3, ax) * step(ax, 36.9) * step(az, 40.8);
  float yard = step(36.9, ax) * step(ax, 53.2) * step(26.8, az) * step(az, 40.8);
  float grain = lkDetail(p * 0.7) * 0.5 + 0.75;
  vec3 asphalt = uLkStreet * grain;
  vec3 col = asphalt * 0.8;                                      // patios interiores
  col = mix(col, asphalt, max(road, max(alley, yard)));
  col = mix(col, uLkStreet * 3.2 * grain, side);                  // aceras
  // línea central discontinua en avenidas y calles
  float dash = step(0.5, fract(p.y / 6.0)) * step(abs(abs(ax - 64.2)), 0.12) * avenue * (1.0 - street)
             + step(0.5, fract(p.x / 6.0)) * step(abs(az - 48.8), 0.12) * street * (1.0 - avenue);
  // pasos de cebra a la entrada de cada cruce
  float zebraA = avenue * step(-3.0, dAv) * 0.0 + avenue * (1.0 - street) * step(0.5, dSt) * step(dSt, 4.0) * step(dAv, -3.0) * step(0.5, fract(p.x / 1.1));
  float zebraS = street * (1.0 - avenue) * step(0.5, dAv) * step(dAv, 4.0) * step(dSt, -3.0) * step(0.5, fract(p.y / 1.1));
  col += vec3(0.05) * (dash + zebraA + zebraS);
  // estacionamiento en las esquinas libres de nuestra manzana
  col += vec3(0.035) * yard * step(abs(fract(az / 2.6) - 0.5), 0.03) * step(ax, 47.0);
  // farolas de sodio en las aceras, cada 24 m
  float lzA = mod(p.y, 24.0) - 12.0, lzS = mod(p.x, 24.0) - 12.0;
  float lamp = avenue * (1.0 - street) * (1.0 - smoothstep(0.0, 4.5, length(vec2(lzA, abs(abs(ax - 64.2) - 9.0)))))
             + street * (1.0 - avenue) * (1.0 - smoothstep(0.0, 4.0, length(vec2(lzS, abs(abs(az - 48.8) - 6.5)))))
             + alley * (1.0 - smoothstep(0.0, 3.0, length(vec2(mod(p.y, 16.0) - 8.0, ax - 34.6)))) * 0.6
             + avenue * street * 0.08;
  col += uLkAmber * lamp * lamp * 0.16;
  // tráfico: dos carriles por sentido en la avenida, uno en las calles
  float body = 0.0;
  vec3 light = vec3(0.0);
  {
    float rel = ax - 64.2;
    float dir = sign(rel + 1e-4) * sign(p.x);
    float lc = sign(rel) * (abs(rel) < 3.75 ? 2.0 : 5.5);
    light += lkCar(rel - lc, p.y * dir + t * 9.0, lc * 3.1 + sign(p.x) * 11.0, body) * avenue * step(dAv, -3.0);
  }
  {
    float rel = az - 48.8;
    float dir = sign(rel + 1e-4) * sign(p.y);
    float lc = sign(rel) * 2.5;
    light += lkCar(rel - lc, -p.x * dir + t * 7.0, lc * 5.3 + sign(p.y) * 23.0, body) * street * step(dSt, -3.0);
  }
  col = mix(col, vec3(0.012, 0.013, 0.016), min(body, 1.0) * road);
  col += light;
  diffuseColor.rgb = col;
}`,
};

// CHARCOS sueltos del mapa: casi espejo oscuro que recoge cielo y neón.
const PUDDLE = {
  vertexPars: 'varying vec3 vLkPos;',
  vertex: POS_V,
  fragmentPars: `varying vec3 vLkPos;${SPILL_GLSL}`,
  fragment: /* glsl */`
{
  vec3 sp = lkSpill(vLkPos, vec3(0.0, 1.0, 0.0), 0.0);
  float grazing = 1.0 - clamp(normalize(cameraPosition - vLkPos).y, 0.0, 1.0);
  diffuseColor.rgb = mix(vec3(.010, .016, .028), vec3(.068, .092, .145), grazing * grazing) + sp * 1.2;
}`,
};

// PINTURA GENÉRICA para piezas sueltas (acero, chapa, tanques): conserva el
// color asignado y le agrega desgaste en mundo y la luz de los letreros.
const WORN = {
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: `varying vec3 vLkPos; varying vec3 vLkN; uniform vec3 uLkStain; vec3 lkGlow = vec3(0.0);${NOISE}${FILTERED_DETAIL}${MACRO}${SPILL_GLSL}`,
  fragment: /* glsl */`
{
  vec3 N = normalize(vLkN);
  vec2 p = abs(N.y) > 0.6 ? vLkPos.xz : vec2(vLkPos.x + vLkPos.z, vLkPos.y);
  float macro = lkMacro(p * 0.06 + 0.3), grain = lkDetail(p * 11.0);
  vec3 col = diffuseColor.rgb * mix(0.88, 1.06, macro) * mix(0.94, 1.05, grain);
  col = mix(col, uLkStain, smoothstep(0.62, 0.9, macro) * 0.22);
  diffuseColor.rgb = col;
}`,
  emissive: SPILL_E,
};

// ---------------------------------------------------------------- reparto
const hexOf = (m) => (m.color ? m.color.getHex() : -1);
const isNear = (hex, target, tol = 4) => {
  const d = (s) => Math.abs(((hex >> s) & 255) - ((target >> s) & 255));
  return d(16) <= tol && d(8) <= tol && d(0) <= tol;
};
const anyNear = (hex, list, tol = 4) => list.some((h) => isNear(hex, h, tol));

const STEEL_DARK = [0x1d2933, 0x2c343c, 0x263541, 0x263641, 0x18252e, 0x232b36, 0x2b333e, 0x3a3f46, 0x314753, 0x141b28, 0x202934];
const STEEL_MID = [0x4a5661, 0x465967, 0x405865, 0x435763, 0x536b78, 0x495969, 0x536675, 0x55616c, 0x3b4650, 0x566873, 0x647785, 0x66727e, 0x526273, 0x26313d];
const CANOPY = [0x6f7e8c, 0x707f8d, 0x717f8d, 0x71808e, 0x72818f, 0x728190, 0x738391, 0x6e7d8b, 0x707e8c, 0x738291, 0x728290];
const HAZARD = [0xd9a441, 0xd99a37, 0x9b7040];
const BEACON = [0xff5544, 0xff4444, 0xff5749];

function restyle(ctx, U) {
  const { world, palette: P } = ctx;
  const all = Object.keys(U);
  const uni = pick(U, all);
  const swapped = new Map();
  // Los materiales de los GLB se comparten con la caché de assets: jamás se
  // tocan. Se trabaja sobre un clon (que sí se libera con el mapa).
  const own = (mesh, m) => {
    if (!m.userData.urbanAssetShared) return m;
    let c = swapped.get(m);
    if (!c) { c = m.clone(); c.userData = { lookClone: true }; swapped.set(m, c); }
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((x) => (x === m ? c : x));
    else mesh.material = c;
    return c;
  };
  const lit = (m) => m.isMeshStandardMaterial || m.isMeshLambertMaterial;
  const done = (m) => { m.userData.lookStyled = true; return m; };
  const worn = (m, hex) => {
    done(m).color.setHex(hex);
    if (lit(m)) patch(m, { ...WORN, uniforms: uni, key: 'az2-worn' });
  };
  const glowHex = (m, hex, k) => { done(m).color.setHex(hex).multiplyScalar(k); };
  const blink = [];
  const beacon = (m) => {
    done(m).color.setHex(P.lamp.beacon);
    blink.push({ mat: m, base: new THREE.Color(P.lamp.beacon), rate: 0.55, phase: 0, gain: 2.6 });
  };
  // la ciudad de ./city.js reemplaza a los edificios sueltos del mapa
  const newCity = ctx.real && ctx.layers.has('city');

  world.mapGroup.traverse((o) => {
    if (!o.isMesh) return;
    let top = o;
    while (top.parent && top.parent !== world.mapGroup) top = top.parent;
    const owner = top.name || '';

    // --- bloques: tapas y caras a la vista
    if (o.name === 'box-batch-sides' || o.name === 'box-batch-tops') {
      const old = o.material;
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.02 });
      const tops = o.name === 'box-batch-tops';
      patch(m, { ...(tops ? TOPS : SIDES), uniforms: uni, key: tops ? 'az2-tops' : 'az2-sides' });
      old.dispose();
      o.material = done(m);
      return;
    }
    if (o.name === 'map-floor') {
      const old = o.material;
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.02 });
      patch(m, { ...FLOOR(ctx.real ? 32.3 : 1e4), uniforms: uni, key: ctx.real ? 'az2-floor' : 'az2-floor-flat' });
      old.dispose();
      o.material = done(m);
      return;
    }
    if (o.name === 'contact-shadows') { o.material.color.setHex(0x0e1014); return; }
    if (o.name === 'sky-body') { o.material.color.setHex(P.sky.moon); o.scale.setScalar(0.55); return; }

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    // Los edificios sueltos del mapa (en ángulos y sitios arbitrarios, sin
    // calles) y su anillo lejano no encajan en la cuadrícula: la ciudad de
    // ./city.js los sustituye. Se ocultan, no se tocan.
    if (newCity && (owner === 'periphery-azoteas-far-skyline'
      || mats.some((m) => m?.isMeshBasicMaterial && m.map && isNear(hexOf(m), 0xa7b4c5))
      || (o.isInstancedMesh && mats[0]?.isMeshBasicMaterial && isNear(hexOf(mats[0]), 0x141b28)))) {
      o.visible = false;
      return;
    }
    // fachadas con la textura de ventanas: ventanas procedurales
    if (mats.some((m) => m?.isMeshBasicMaterial && m.map && (isNear(hexOf(m), 0xa7b4c5) || isNear(hexOf(m), 0x8e9db0) || isNear(hexOf(m), 0x273140)))) {
      const far = owner === 'periphery-azoteas-far-skyline';
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
      patch(m, { ...FACADE(far ? 0x0c0e13 : 0x101217, far), uniforms: uni, key: far ? 'az2-facade-far' : 'az2-facade' });
      for (const x of mats) if (!x.userData.urbanAssetShared) x.dispose();
      o.material = done(m);
      return;
    }
    // el anuncio NOVA colgaba de uno de esos edificios sueltos
    if (newCity && mats[0]?.isMeshBasicMaterial && mats[0].map && Math.abs(o.position.x - 61.9) < 0.2 && Math.abs(o.position.z - 18) < 0.2) {
      o.visible = false;
      return;
    }
    // luces de borde de la azotea (una malla, color por instancia): las
    // turquesas de los flancos pasan a lámparas de borde ámbar tenues; las
    // de las bases conservan el color de su equipo
    if (o.name === 'azoteas-edge-lights' && o.isInstancedMesh && o.instanceColor) {
      const c = new THREE.Color(), amber = new THREE.Color(P.lamp.amber).multiplyScalar(0.7);
      for (let i = 0; i < o.count; i++) {
        o.getColorAt(i, c);
        if (c.g > c.r * 1.5 && c.b > c.r * 1.5 && Math.abs(c.g - c.b) < 0.25) o.setColorAt(i, amber);
      }
      o.instanceColor.needsUpdate = true;
      done(mats[0]);
      return;
    }

    for (const src of mats) {
      if (!src || src.userData.lookStyled) continue;
      if (swapped.get(src)?.userData.lookStyled) { own(o, src); continue; }
      const name = src.name || '', hex = hexOf(src);
      const basic = src.isMeshBasicMaterial && !src.map;
      // --- forro de chapa del pulido: un material por familia de equipo
      if (owner === 'azoteas-architectural-polish' && o.isInstancedMesh && isNear(hex, 0x4e626c)) {
        styleSkins(o, P);
        const m = done(own(o, src));
        m.color.setHex(0xffffff); m.metalness = 0.3; m.roughness = 0.55;
        patch(m, { ...SKIN, uniforms: uni, key: 'az2-skin' });
      }
      // remates del forro: chapa de remate clara, marca el canto alto
      else if (owner === 'azoteas-architectural-polish' && isNear(hex, 0x738692)) { const m = done(own(o, src)); m.color.setHex(P.concrete.cope); m.metalness = 0.25; m.roughness = 0.5; }
      else if (owner === 'azoteas-architectural-polish' && isNear(hex, 0x273943)) done(own(o, src)).color.setHex(P.concrete.plinth);
      // kit de Blender: rejillas, gabinetes, acceso
      else if (/Slate enamel/.test(name)) { const m = done(own(o, src)); m.color.setHex(0xa6abab); m.roughness = 0.5; }
      else if (/Graphite steel/.test(name)) done(own(o, src)).color.setHex(P.steel.dark);
      else if (/Brushed zinc|Dull zinc/.test(name)) done(own(o, src)).color.setHex(P.duct.metal);
      else if (/Recess and gasket/.test(name)) done(own(o, src)).color.setHex(0x18191c);
      else if (/Warm luminaire/.test(name)) { const m = done(own(o, src)); m.color.setHex(P.lamp.warm); m.emissive.setHex(P.lamp.warm); m.emissiveIntensity = 2.4; }
      else if (/Weathered painted steel/.test(name)) worn(own(o, src), 0x7f8781);
      else if (/Band steel/.test(name)) worn(own(o, src), P.steel.dark);
      // luces del techo
      else if (basic && anyNear(hex, BEACON)) beacon(own(o, src));
      else if (basic && isNear(hex, 0x55d5df)) glowHex(own(o, src), P.lamp.helipad, 1.5);     // perímetro del helipuerto
      else if (basic && isNear(hex, 0x9cbbbb)) glowHex(own(o, src), P.lamp.white, 1.2);       // marcas del área de toma
      else if (basic && isNear(hex, 0x8fe3ff)) glowHex(own(o, src), P.lamp.amber, 1.4);       // balizas de puente
      else if (basic && (isNear(hex, 0x4ed8e4) || isNear(hex, 0x54d9e4))) glowHex(own(o, src), P.lamp.helipad, 0.9); // pilotos de equipo
      else if (basic && isNear(hex, 0xffdfa8)) glowHex(own(o, src), P.lamp.warm, 2.0);
      else if (basic && isNear(hex, 0x9fc4ff)) { const m = done(own(o, src)); m.color.setHex(P.lamp.warm).multiplyScalar(0.4); m.opacity = 0.1; }
      // neones y estandartes de equipo: los colores exactos de los equipos
      else if (basic && (isNear(hex, 0xd94f3f) || isNear(hex, 0xe05545))) done(own(o, src)).color.setHex(P.team.red);
      else if (basic && isNear(hex, 0x4f8de0)) done(own(o, src)).color.setHex(P.team.blue);
      // calle de abajo y techos lejanos
      else if (basic && isNear(hex, 0x0a0c12)) {
        const m = done(own(o, src));
        m.color.setHex(0xffffff);
        patch(m, { ...STREET, uniforms: uni, key: 'az2-street' });
      }
      else if (o.name === 'azoteas-puddles') {
        const m = done(own(o, src));
        m.color.setHex(0xffffff);
        patch(m, { ...PUDDLE, uniforms: uni, key: 'az2-puddle' });
      }
      else if (basic && (isNear(hex, 0x111826) || isNear(hex, 0x0d121b))) done(own(o, src)).color.setHex(0x0f1116);
      else if (basic && anyNear(hex, HAZARD)) done(own(o, src)).color.setHex(P.hazard).multiplyScalar(0.8);
      else if (basic && isNear(hex, 0x26313d)) done(own(o, src)).color.setHex(0x1b1d20);   // aro de ventilador
      else if (basic && isNear(hex, 0x526273)) done(own(o, src)).color.setHex(0x5b6064);   // aspas
      else if (basic && anyNear(hex, STEEL_DARK)) done(own(o, src)).color.setHex(P.steel.dark);
      else if (basic && anyNear(hex, STEEL_MID)) done(own(o, src)).color.setHex(P.steel.mid);
      else if (!lit(src)) continue;
      // acero, chapa y franjas de seguridad
      else if (isNear(hex, 0xd9a51c)) worn(own(o, src), 0xc9961f);                       // grúa: amarillo de obra
      else if (anyNear(hex, HAZARD)) {
        const m = done(own(o, src)); m.color.setHex(P.hazard);
        if (m.emissive) m.emissive.setHex(0x000000);
      }
      else if (isNear(hex, 0x4c525c)) worn(own(o, src), P.duct.metal);                    // tanques
      else if (isNear(hex, 0x8298a3)) { const m = own(o, src); worn(m, 0xa9afb1); m.metalness = 0.5; } // barandas galvanizadas
      else if (isNear(hex, 0x173b55)) { const m = done(own(o, src)); m.color.setHex(0x182230); m.emissive.setHex(0x000000); m.roughness = 0.25; } // paneles solares
      else if (isNear(hex, 0x38687d) || isNear(hex, 0x39697e) || isNear(hex, 0x38677c) || isNear(hex, 0x37667a) || isNear(hex, 0x37667b)) worn(own(o, src), 0x2c3540); // vidrio y marcos
      else if (anyNear(hex, CANOPY)) worn(own(o, src), P.skin.vent);
      else if (anyNear(hex, STEEL_DARK)) worn(own(o, src), P.steel.dark);
      else if (anyNear(hex, STEEL_MID)) worn(own(o, src), P.steel.mid);
      else if (isNear(hex, 0x202428)) done(own(o, src)).color.setHex(P.steel.dark);
    }
  });
  return blink;
}

// Forro de chapa: un color por FAMILIA de equipo (enfriadora, ducto,
// caseta, entreplanta) con un matiz de ±6 % por bloque, como piezas del
// mismo fabricante con distinta edad. Cada instancia se asigna al bloque
// del manifiesto que tiene detrás (se busca medio palmo hacia adentro).
function styleSkins(mesh, P) {
  const boxes = [];
  for (const b of collisionBoxesFor('azoteas')) {
    if (b.visual === false) continue;
    boxes.push(b);
    if (b.mirror !== false && (b.x || b.z)) boxes.push({ ...b, x: -b.x, z: -b.z });
  }
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), n = new THREE.Vector3(), col = new THREE.Color();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m4);
    pos.setFromMatrixPosition(m4);
    n.setFromMatrixColumn(m4, 2).normalize();
    const px = pos.x - n.x * 0.15, pz = pos.z - n.z * 0.15;
    const b = boxes.find((q) => Math.abs(px - q.x) <= q.w / 2 && Math.abs(pz - q.z) <= q.d / 2);
    const h = b ? Math.abs(Math.sin(b.x * 12.9898 + b.z * 78.233) * 43758.5453) % 1 : 0.5;
    col.setHex(P.skin[b?.style] ?? P.skin.ac).multiplyScalar(0.94 + 0.12 * h);
    mesh.setColorAt(i, col);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function pick(all, names) {
  const out = {};
  for (const n of names) out[n] = all[n];
  return out;
}
