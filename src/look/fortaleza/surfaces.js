// LOOK DE FORTALEZA: castillo militar en uso, a la hora dorada. Piedra
// gastada de una sola familia, teja, madera y hierro; campo alrededor.
// Solo cambia materiales, luz, cielo y niebla de lo que ya construyó el mapa:
// ni una caja se mueve. Todo el dibujo es procedural en coordenadas de mundo
// (o del bloque), así que no hay texturas que se repitan ni que se estiren.
import * as THREE from 'three';
import { NOISE, patch } from '../glsl.js';

export function surfaces(ctx) {
  const { world, palette: P } = ctx;
  applyEnvironment(world, P);
  const U = paletteUniforms(P);
  // Ruido amplio: la textura que World ya tiene (dos canales, se repite).
  // Leerla cuesta mucho menos por píxel que sumar octavas en el sombreador.
  U.uLkMacro = { value: world._macroNoiseTexture() };
  restyle(ctx, U);
  if (ctx.real) addRidges(ctx, U);
  return { grade: P.grade };
}

function applyEnvironment(world, P) {
  const L = P.light;
  world.hemi.color.setHex(L.hemiSky);
  world.hemi.groundColor.setHex(L.hemiGround);
  world.hemi.intensity = L.hemiIntensity;
  world.amb.color.setHex(L.amb);
  world.amb.intensity = L.ambIntensity;
  world.sun.color.setHex(L.sun);
  world.sun.intensity = L.sunIntensity;
  world._setSky(P.sky.stops);
  // Exponencial y del color del horizonte: casi nada dentro del patio, y lo
  // lejano se funde con el cielo en vez de recortarse contra él.
  world.scene.fog = new THREE.FogExp2(L.fog, L.fogDensity);
}

// Los mismos objetos uniform para todos los materiales del look.
function paletteUniforms(P) {
  const c = (hex) => ({ value: new THREE.Color(hex) });
  const s = P.stone, g = P.ground, r = P.roof;
  return {
    uLkBase: c(s.base), uLkLight: c(s.light), uLkWarm: c(s.warm), uLkGrey: c(s.grey),
    uLkCope: c(s.cope), uLkPlinth: c(s.plinth), uLkMortar: c(s.mortar), uLkDamp: c(s.damp),
    uLkMoss: c(P.moss), uLkLichen: c(P.lichen),
    uLkGrass: c(g.grass), uLkGrassDeep: c(g.grassDeep), uLkGrassDry: c(g.grassDry), uLkDirt: c(g.dirt), uLkEarth: c(g.earth),
    uLkFlag: c(g.flag), uLkFlagWarm: c(g.flagWarm),
    uLkTile: c(r.tile), uLkTileDark: c(r.tileDark), uLkTileOld: c(r.tileOld),
    uLkFar: c(P.sky.far), uLkFarWarm: c(P.sky.farWarm),
  };
}

// ---------------------------------------------------------------- GLSL
const VARY_V = /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
`;
const WORLD_V = /* glsl */`
{
  vec4 lkP = vec4(transformed, 1.0); vec3 lkN = objectNormal;
  #ifdef USE_INSTANCING
    lkP = instanceMatrix * lkP; lkN = mat3(instanceMatrix) * lkN;
  #endif
  vLkPos = (modelMatrix * lkP).xyz;
  vLkN = normalize(mat3(modelMatrix) * lkN);
}`;
const MACRO = /* glsl */`
uniform sampler2D uLkMacro;
float lkMacro(vec2 p) { return texture2D(uLkMacro, p).r; }
float lkMid(vec2 p) { return texture2D(uLkMacro, p).g; }
`;
// La huella procede de coordenadas continuas, antes de floor/fract y de las bifurcaciones.
const FILTER = /* glsl */`
float lkDetail(vec2 footprint) {
  return 1.0 - smoothstep(0.35, 1.0, max(footprint.x, footprint.y));
}
float lkFineNoise(vec2 p, vec2 footprint) {
  return mix(0.5, lkNoise(p), lkDetail(footprint));
}
`;
const STONE_F = /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkBase, uLkLight, uLkWarm, uLkGrey, uLkCope, uLkPlinth, uLkMortar, uLkDamp, uLkMoss, uLkLichen;
${NOISE}${MACRO}${FILTER}
vec3 lkBump = vec3(0.0);
`;
const BUMP_N = /* glsl */`
normal = normalize(normal + (viewMatrix * vec4(lkBump, 0.0)).xyz);
`;

// SILLERÍA de un bloque de cobertura. aBox = (u, v, ancho, alto) de la cara en
// metros: las hiladas y las juntas se reparten para caer EXACTAS en las
// esquinas del bloque, con una hilada de remate arriba y un zócalo abajo. La
// lectura de altura del mapa (tapas claras, muros de fondo oscuros) llega en
// el color por vértice y se conserva como tono.
const MASONRY = {
  vertexPars: `attribute vec4 aBox; attribute vec2 aBoxMeta; varying vec4 vLkBox; varying vec2 vLkMeta;${VARY_V}`,
  vertex: `vLkBox = aBox; vLkMeta = aBoxMeta;${WORLD_V}`,
  fragmentPars: `varying vec4 vLkBox; varying vec2 vLkMeta;${STONE_F}`,
  fragment: /* glsl */`
{
  vec3 N = normalize(vLkN);
  bool top = abs(N.y) > 0.62;
  vec3 T = top ? vec3(1.0, 0.0, 0.0) : normalize(cross(N, vec3(0.0, 1.0, 0.0)));
  vec3 B = top ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  float u = vLkBox.x, v = vLkBox.y, W = max(vLkBox.z, 0.05), H = max(vLkBox.w, 0.05);
  float seed = dot(N, vec3(1.7, 0.0, 3.1)) + vLkMeta.x * 57.0;
  float tone = clamp(dot(diffuseColor.rgb, vec3(0.3333)) / (top ? 0.66 : 0.52), 0.62, 1.22);
  vec2 wp = vec2(dot(vLkPos, T), top ? vLkPos.z : vLkPos.y * 1.3);
  float macro = lkMacro(wp * 0.031 + 0.37), spot = lkMid(wp * 0.11 + seed * 0.13);
  vec2 footprint = fwidth(vec2(u, v));
  float grain = lkFineNoise(vec2(u, v) * 9.0 + seed, footprint * 9.0) * 0.6 + lkFineNoise(vec2(u, v) * 23.0 + seed, footprint * 23.0) * 0.4;
  vec3 col; float edge, su, sv, mossK;
  if (!top) {
    float cope = min(0.24, H * 0.3);
    float fromTop = H - v;
    float rows = max(1.0, floor((H - cope) / 0.44 + 0.5));
    float rowH = (H - cope) / rows;
    bool isCope = fromTop < cope;
    float rowF = (fromTop - cope) / rowH;
    float row = isCope ? -1.0 : floor(rowF);
    float fv = isCope ? fromTop / cope : fract(rowF);
    float ch = isCope ? cope : rowH;
    float n = max(1.0, floor(W / (isCope ? 1.3 : 0.86) + 0.5));
    float bw = W / n;
    float bu = u / bw + (isCope ? 0.0 : mod(row, 2.0) * 0.5);
    float fu = fract(bu);
    vec2 cell = vec2(floor(bu), row) + seed * vec2(13.0, 7.0);
    float h1 = lkHash21(cell), h2 = lkHash21(cell + 19.3), h3 = lkHash21(cell + 41.7);
    float du = min(fu, 1.0 - fu) * bw, dv = min(fv, 1.0 - fv) * ch;
    edge = min(du, dv);
    // una sola caliza: cada sillar varía en valor y calidez, alguno sale de
    // otra veta (más ocre o más gris), ninguno de otro color
    col = mix(uLkBase, uLkLight, smoothstep(0.15, 0.85, h1) * 0.55);
    col = mix(col, uLkWarm, step(0.80, h2) * 0.55);
    col = mix(col, uLkGrey, step(0.86, h3) * 0.55);
    col *= 0.86 + 0.24 * h2;
    col *= mix(1.05, 0.92, fv);                                  // cada sillar, algo más oscuro hacia abajo
    if (isCope) col = uLkCope * (0.95 + 0.08 * h1);
    float base = (1.0 - smoothstep(rowH * 0.94, rowH * 1.02, v)) * step(1.5, rows);
    col = mix(col, uLkPlinth * (0.9 + 0.2 * h1), base * 0.7);
    // esquinas gastadas: piedra viva más clara donde roza la gente
    float wear = (1.0 - smoothstep(0.0, 0.10, min(u, W - u) + (grain - 0.5) * 0.08)) * (1.0 - base);
    col = mix(col, uLkLight, wear * 0.4);
    // chorreones: el agua que escurre de la albardilla oscurece franjas
    float run = smoothstep(0.55, 0.85, lkNoise(vec2(wp.x * 1.9, seed * 3.0)) * 0.7 + lkNoise(vec2(wp.x * 7.0, 1.3 + seed)) * 0.3);
    if (!isCope) col *= 1.0 - run * 0.20 * (1.0 - smoothstep(0.0, 0.6 + 1.6 * macro, fromTop - cope));
    // humedad al pie: la piedra chupa agua del suelo
    float damp = 1.0 - smoothstep(0.0, 0.7, v + (macro - 0.5) * 0.5 + (grain - 0.5) * 0.12);
    col = mix(col, uLkDamp, damp * 0.42);
    mossK = (1.0 - smoothstep(0.0, 0.80, v + (macro - 0.5) * 1.0)) * smoothstep(0.30, 0.62, macro);
    su = (fu < 0.5 ? -1.0 : 1.0) * (1.0 - smoothstep(0.0, 0.065, du));
    sv = (fv < 0.5 ? 1.0 : -1.0) * (1.0 - smoothstep(0.0, 0.065, dv));
  } else {
    // tapa: cenefa de remate y losas dentro
    float bd = min(min(u, W - u), min(v, H - v)), band = min(0.18, min(W, H) * 0.25);
    float n1 = max(1.0, floor(W / 0.72 + 0.5)), n2 = max(1.0, floor(H / 0.72 + 0.5));
    vec2 size = vec2(W / n1, H / n2), g = vec2(u, v) / size, gf = fract(g);
    vec2 cell = floor(g) + seed * vec2(11.0, 5.0);
    float h1 = lkHash21(cell), h2 = lkHash21(cell + 7.7);
    float du = min(gf.x, 1.0 - gf.x) * size.x, dv = min(gf.y, 1.0 - gf.y) * size.y;
    edge = min(min(du, dv), abs(bd - band));
    col = mix(uLkLight, uLkBase, h1 * 0.5) * (0.94 + 0.12 * h2);
    col = mix(col, uLkCope * (0.97 + 0.06 * h1), step(bd, band));
    mossK = smoothstep(0.58, 0.82, macro) * 0.55;
    su = (gf.x < 0.5 ? -1.0 : 1.0) * (1.0 - smoothstep(0.0, 0.045, du));
    sv = (gf.y < 0.5 ? -1.0 : 1.0) * (1.0 - smoothstep(0.0, 0.045, dv));
  }
  // labra: rayas de cincel a lo largo de la hilada y picaduras sueltas
  float tool = lkFineNoise(vec2(u * 2.6, v * 41.0) + seed * 5.0, footprint * vec2(2.6, 41.0));
  float pit = smoothstep(0.80, 0.92, lkFineNoise(vec2(u, v) * 33.0 + seed * 9.0, footprint * 33.0));
  col *= mix(0.86, 1.10, macro) * mix(0.88, 1.09, grain) * mix(0.965, 1.03, tool) * (1.0 - pit * 0.09);
  float aa = max(0.010, 0.5 * max(footprint.x, footprint.y));
  float mortar = (1.0 - smoothstep(0.024 - aa, 0.024 + aa, edge)) * min(1.0, 0.024 / aa);
  col = mix(col, uLkMortar, mortar * 0.9);
  col *= mix(0.80, 1.0, smoothstep(0.0, 0.085, edge));
  col = mix(col, uLkMoss * (0.7 + 0.5 * grain), clamp(mossK * (0.5 + mortar * 0.7), 0.0, 0.85));
  float lichen = smoothstep(0.66, 0.82, spot) * smoothstep(0.45, 0.7, grain);
  col = mix(col, uLkLichen, lichen * 0.32);
  diffuseColor.rgb = col * tone;
  lkBump = (T * su + B * sv) * lkDetail(footprint / 0.10) * 0.85 * (1.0 - mortar * 0.6) + (T * (grain - 0.5) + B * (tool - 0.5)) * 0.22;
}`,
  normal: BUMP_N,
};

// PIEDRA LABRADA sin juntas dibujadas: para piezas cuya sillería ya está
// modelada (kit de Blender, galerías, marcos del pulido). Vetas de la misma
// caliza a gran escala (más ocre, más gris), grano fino, humedad y musgo al pie.
//   LK_TINT 0 = muro · 1 = remate (más claro) · 2 = llaga (oscuro)
const dressed = (tint) => ({
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: STONE_F,
  fragment: /* glsl */`
{
  vec3 N = normalize(vLkN);
  bool top = abs(N.y) > 0.62;
  vec3 T = top ? vec3(1.0, 0.0, 0.0) : normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec2 p = vec2(dot(vLkPos, T), top ? vLkPos.z : vLkPos.y * 1.3);
  float tone = dot(diffuseColor.rgb, vec3(0.3333));
  float macro = lkMacro(p * 0.031 + 0.37), mid = lkMid(p * 0.10 + 0.11);
  vec2 footprint = fwidth(p);
  float grain = lkFineNoise(p * 9.0, footprint * 9.0) * 0.6 + lkFineNoise(p * 23.0, footprint * 23.0) * 0.4;
  vec3 col = ${tint === 1 ? 'mix(uLkCope, uLkLight, mid * 0.6)' : tint === 2 ? 'uLkMortar * 0.8' : 'mix(uLkBase, uLkLight, smoothstep(0.3, 0.75, mid) * 0.5)'};
  ${tint === 0 ? 'col = mix(col, uLkWarm, smoothstep(0.62, 0.78, lkMid(p * 0.047 + 0.23)) * 0.4); col = mix(col, uLkGrey, smoothstep(0.66, 0.8, lkMacro(p * 0.041 + 0.51)) * 0.35);' : ''}
  float tool = lkFineNoise(p * vec2(2.6, 41.0), footprint * vec2(2.6, 41.0));
  float pit = smoothstep(0.80, 0.92, lkFineNoise(p * 33.0 + 7.0, footprint * 33.0));
  col *= mix(0.86, 1.10, macro) * mix(0.88, 1.09, grain) * mix(0.965, 1.03, tool) * (1.0 - pit * 0.08);
  if (!top) col = mix(col, uLkDamp, (1.0 - smoothstep(0.0, 0.7, vLkPos.y + (macro - 0.5) * 0.5)) * 0.38);
  float mossK = top ? smoothstep(0.60, 0.84, macro) * 0.45 : (1.0 - smoothstep(0.0, 0.85, vLkPos.y + (macro - 0.5) * 1.0)) * smoothstep(0.32, 0.62, macro);
  col = mix(col, uLkMoss * (0.7 + 0.5 * grain), clamp(mossK, 0.0, 0.8) * ${tint === 2 ? '0.9' : '0.6'});
  diffuseColor.rgb = col * tone;
  lkBump = (T * (grain - 0.5) + vec3(0.0, top ? 0.0 : 1.0, top ? 1.0 : 0.0) * (mid - 0.5)) * 0.14;
}`,
  normal: BUMP_N,
});

// TEJA: hiladas solapadas; cada pieza con su tono de barro, alguna vieja y
// parda, musgo y liquen donde el tejado guarda humedad.
const TILES = {
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkTile, uLkTileDark, uLkTileOld, uLkMoss, uLkLichen;
${NOISE}${MACRO}${FILTER}`,
  fragment: /* glsl */`
{
  vec3 N = normalize(vLkN);
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  float slope = vLkPos.y / max(0.25, sqrt(max(0.0, 1.0 - N.y * N.y)));
  float rowF = slope / 0.36, row = floor(rowF), fv = fract(rowF);
  float cu = dot(vLkPos, T) / 0.30 + mod(row, 2.0) * 0.5, fu = fract(cu);
  vec2 cell = vec2(floor(cu), row);
  float h1 = lkHash21(cell), h2 = lkHash21(cell + 31.0);
  vec3 col = mix(uLkTile, uLkTileDark, h1 * 0.75);
  col = mix(col, uLkTileOld, step(0.86, h2) * 0.7);
  col *= mix(0.60, 1.06, 1.0 - smoothstep(0.72, 1.0, fv));    // sombra bajo la hilada de arriba
  col *= 1.0 - 0.30 * smoothstep(0.40, 0.5, abs(fu - 0.5));    // canal entre tejas
  float moss = smoothstep(0.62, 0.82, lkMacro(vLkPos.xz * 0.07 + 0.9));
  col = mix(col, uLkMoss * 0.8, moss * 0.35);
  float lich = smoothstep(0.72, 0.9, lkNoise(vLkPos.xz * 1.7 + 3.0)) * step(0.5, lkHash21(cell + 5.0));
  col = mix(col, uLkLichen, lich * 0.35);
  diffuseColor.rgb = col * dot(diffuseColor.rgb, vec3(0.3333));
}`,
};

// MADERA: veta a lo largo de la pieza.
const WOOD = {
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: `varying vec3 vLkPos; varying vec3 vLkN;${NOISE}${FILTER}`,
  fragment: /* glsl */`
{
  vec3 N = normalize(vLkN);
  vec3 T = abs(N.y) > 0.62 ? vec3(1.0, 0.0, 0.0) : normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec2 p = vec2(dot(vLkPos, T), abs(N.y) > 0.62 ? vLkPos.z : vLkPos.y);
  vec2 footprint = fwidth(p);
  float vein = lkFineNoise(p * vec2(1.3, 17.0), footprint * vec2(1.3, 17.0)) * 0.65
    + lkFineNoise(p * vec2(4.0, 43.0), footprint * vec2(4.0, 43.0)) * 0.35;
  diffuseColor.rgb *= mix(0.72, 1.18, vein);
}`,
};

// SUELO del campo: losas de piedra en el patio interior; en el anillo
// exterior (patios de armas y lizas) tierra apisonada con grava, hierba a
// manchas donde no se pisa y el camino de ronda con sus rodadas.
// design = false (mapa de datos con este tema): todo losa, sin calzada.
const GROUND = (courtX, courtZ, design) => ({
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkWarm, uLkGrey, uLkMortar, uLkMoss, uLkFlag, uLkFlagWarm;
uniform vec3 uLkGrass, uLkGrassDeep, uLkGrassDry, uLkDirt, uLkEarth;
${NOISE}${MACRO}${FILTER}
vec3 lkBump = vec3(0.0);
float lkRough = -1.0;
vec3 lkPaving(vec2 p, float setts, vec2 footprint, float macro, float mid, float grain, float pit, out vec3 bump) {
  float rh = mix(0.64, 0.30, setts);
  float rowF = p.y / rh, row = floor(rowF), fv = fract(rowF);
  float bw = mix(0.62 + 0.55 * lkHash11(row * 7.13), 0.30, setts);
  float cu = p.x / bw + lkHash11(row * 3.71) * 5.0 + setts * mod(row, 2.0) * 0.5, fu = fract(cu);
  vec2 cell = vec2(floor(cu), row);
  float h1 = lkHash21(cell), h2 = lkHash21(cell + 23.0), h3 = lkHash21(cell + 57.0);
  float du = min(fu, 1.0 - fu) * bw, dv = min(fv, 1.0 - fv) * rh;
  float edge = min(du, dv);
  // la misma caliza de los muros; el adoquín, canto más oscuro y gastado
  vec3 stone = mix(uLkFlag, uLkFlagWarm, smoothstep(0.2, 0.8, h1));
  stone = mix(stone, uLkWarm, step(0.86, h2) * 0.30);
  stone = mix(stone, uLkGrey, step(0.88, h3) * 0.35);
  stone = mix(stone, mix(uLkGrey, uLkWarm, h1 * 0.6) * 0.80, setts * 0.85);
  stone *= (0.86 + 0.24 * h2) * mix(0.84, 1.10, macro) * mix(0.88, 1.08, grain) * (1.0 - pit * 0.14);
  vec2 aa = max(0.5 * footprint, vec2(0.012));
  vec2 jointAxis = (1.0 - smoothstep(vec2(0.024) - aa, vec2(0.024) + aa, vec2(du, dv))) * min(vec2(1.0), 0.024 / aa);
  jointAxis = mix(jointAxis, 0.048 / vec2(bw, rh), smoothstep(vec2(0.35), vec2(1.0), footprint / vec2(bw, rh)));
  float joint = max(jointAxis.x, jointAxis.y);
  stone = mix(stone, uLkMortar, joint * 0.8);
  float relief = 1.0 - smoothstep(0.024, 0.12, max(footprint.x, footprint.y));
  stone *= 1.0 - 0.12 * relief * (1.0 - smoothstep(0.0, 0.09, edge));
  // hierba que sale de las juntas, a manchas
  float weeds = smoothstep(0.52, 0.72, mid) * smoothstep(0.42, 0.62, macro);
  vec3 col = mix(stone, uLkMoss * (0.42 + 0.3 * grain), clamp(weeds * (0.10 + joint * 0.55), 0.0, 0.7));
  bump = (vec3(1.0, 0.0, 0.0) * (fu < 0.5 ? -1.0 : 1.0) * (1.0 - smoothstep(0.0, 0.06, du)) + vec3(0.0, 0.0, 1.0) * (fv < 0.5 ? -1.0 : 1.0) * (1.0 - smoothstep(0.0, 0.06, dv))) * 0.6 * (1.0 - joint * 0.5)
    + vec3(grain - 0.5, 0.0, mid - 0.5) * 0.10;
  bump *= relief;
  return col;
}`,
  fragment: /* glsl */`
{
  vec2 p = vLkPos.xz;
  // las lecturas de textura van antes de bifurcar (dentro, sus derivadas no están definidas)
  float macro = lkMacro(p * 0.014 + 0.05), mid = lkMid(p * 0.09 + 0.37);
  float worn = lkMid(p * 0.05 + 0.31), meadow = lkMacro(p * 0.03 + 0.71);
  vec2 footprint = fwidth(p);
  float grain = lkFineNoise(p * 9.0, footprint * 9.0) * 0.6 + lkFineNoise(p * 27.0, footprint * 27.0) * 0.4;
  float tone = dot(diffuseColor.rgb, vec3(0.3333));
  vec3 col;
  // dentro del patio viejo, losa; fuera, tierra (la muralla tapa la costura)
  if (abs(p.x) < ${courtX.toFixed(2)} && abs(p.y) < ${courtZ.toFixed(2)}) {
    // Dibujo del patio: una calzada de adoquín de puerta a puerta por el eje
    // y un anillo alrededor de la torre del homenaje. El resto, losa grande.
    float border = min(abs(length(p) - 9.3) - 0.45, max(abs(p.x) - 1.685, 5.6 - abs(p.y)));
    float aa = clamp(0.5 * max(footprint.x, footprint.y), 0.001, 0.012);
    float setts = ${design ? '1.0 - smoothstep(-aa, aa, border)' : '0.0'};
    float pit = smoothstep(0.80, 0.92, lkFineNoise(p * 31.0, footprint * 31.0));
    // Cada aparejo conserva su paso; solo la transición evalúa los dos.
    if (setts < 1.0) col = lkPaving(p, 0.0, footprint, macro, mid, grain, pit, lkBump);
    if (setts > 0.0) {
      vec3 bump;
      vec3 cobbles = lkPaving(p, 1.0, footprint, macro, mid, grain, pit, bump);
      if (setts >= 1.0) { col = cobbles; lkBump = bump; }
      else { col = mix(col, cobbles, setts); lkBump = mix(lkBump, bump, setts); }
    }
    lkRough = 0.82;
  } else {
    // tierra apisonada de un patio de armas: ocre y pardo, con grava suelta
    vec3 earth = mix(uLkEarth, uLkDirt, smoothstep(0.3, 0.7, mid)) * mix(0.84, 1.08, grain);
    vec2 pc = floor(p * 9.0), pf = fract(p * 9.0) - 0.5 - (lkHash22(pc) - 0.5) * 0.3;
    float pebble = step(0.90, lkHash21(pc)) * (1.0 - smoothstep(0.16, 0.30, length(pf))) * step(0.4, lkNoise(p * 2.0));
    earth = mix(earth, uLkGrey * 0.9, pebble * lkDetail(footprint * 9.0) * 0.28);
    // hierba: tres verdes apagados, a manchas donde no pisa nadie
    vec3 grass = mix(uLkGrassDeep, uLkGrass, smoothstep(0.25, 0.7, mid));
    grass = mix(grass, uLkGrassDry, smoothstep(0.50, 0.85, macro) * 0.6);
    float blades = lkFineNoise(vec2(p.x * 1.4 + p.y * 0.8, (p.y - p.x * 0.6) * 13.0), vec2(dot(footprint, vec2(1.4, 0.8)), dot(footprint, vec2(7.8, 13.0)))) * 0.6 + lkFineNoise(p * 17.0, footprint * 17.0) * 0.4;
    grass *= mix(0.78, 1.12, blades) * mix(0.9, 1.06, grain);
    // camino de ronda: el anillo por donde pasan carros y caballos
    float ring = min(abs(abs(p.x) - ${((courtX + 39.6) / 2).toFixed(2)}), abs(abs(p.y) - ${((courtZ + 35.6) / 2).toFixed(2)}));
    float path = clamp((1.0 - smoothstep(0.8, 2.6, ring + (mid - 0.5) * 2.0)) + smoothstep(0.62, 0.8, worn) * 0.5, 0.0, 1.0);
    float ruts = (1.0 - smoothstep(0.06, 0.22, abs(ring - 0.8 + (grain - 0.5) * 0.08))) * (1.0 - smoothstep(0.5, 1.2, ring - 0.8));
    earth *= 1.0 - ruts * 0.22;
    float grassK = smoothstep(0.40, 0.66, meadow + (blades - 0.5) * 0.25) * (1.0 - path);
    col = mix(earth, grass, grassK);
    lkBump = mix(vec3(grain - 0.5, 0.0, mid - 0.5) * 0.22, vec3(grain - 0.5, 0.0, blades - 0.5) * 0.30, grassK);
    lkRough = 0.96;
  }
  diffuseColor.rgb = col * tone;
}`,
  normal: BUMP_N,
  rough: 'if (lkRough > 0.0) roughnessFactor = lkRough;',
});

// CAMPIÑA fuera de la muralla: pradera cerca, y a lo lejos el mosaico de
// cultivos del señorío (trigo, barbecho, labrado, pasto) con sus surcos.
const MEADOW = {
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: /* glsl */`
varying vec3 vLkPos; varying vec3 vLkN;
uniform vec3 uLkGrass, uLkGrassDeep, uLkGrassDry, uLkDirt;
${NOISE}${MACRO}${FILTER}`,
  fragment: /* glsl */`
{
  vec2 p = vLkPos.xz;
  float macro = lkMacro(p * 0.0045 + 0.5), mid = lkMid(p * 0.026 + 0.13), grain = lkNoise(p * 2.3);
  float warp = lkMid(p * 0.0026 + 0.2) - 0.5;
  vec3 grass = mix(uLkGrassDeep, uLkGrass, smoothstep(0.25, 0.7, mid));
  grass = mix(grass, uLkGrassDry, smoothstep(0.52, 0.8, macro) * 0.6);
  grass *= mix(0.9, 1.05, grain);
  // cultivos: parcelas giradas, cada una con su cosecha y sus surcos
  vec2 q = mat2(0.86, -0.5, 0.5, 0.86) * p / 26.0;
  vec2 ci = floor(q + warp * 0.5);
  float crop = lkHash21(ci + 3.0), ang = lkHash21(ci + 11.0) * 3.1416;
  float rows = 0.5 + 0.5 * sin(dot(p, vec2(cos(ang), sin(ang))) * 2.6);
  vec3 field = crop < 0.34 ? uLkGrassDry * 1.08 : crop < 0.50 ? uLkDirt * 0.86 : crop < 0.78 ? uLkGrass * 0.95 : mix(uLkDirt, uLkGrassDry, 0.45);
  field *= mix(crop >= 0.34 && crop < 0.5 ? 0.72 : 0.84, 1.06, rows);
  vec2 qf = fract(q + warp * 0.5);
  field = mix(uLkGrassDeep * 0.85, field, smoothstep(0.0, 0.05, min(min(qf.x, 1.0 - qf.x), min(qf.y, 1.0 - qf.y))));
  float far = smoothstep(52.0, 70.0, length(p) + (mid - 0.5) * 16.0);
  vec3 col = mix(grass, field, far);
  diffuseColor.rgb = col * mix(0.88, 1.08, macro);
}`,
};

// MONTAÑAS: bosque al pie, roca violeta, cumbre encendida por el sol bajo.
//   near = colinas boscosas cercanas; si no, la cordillera lejana.
const mountain = (near) => ({
  vertexPars: VARY_V,
  vertex: WORLD_V,
  fragmentPars: `varying vec3 vLkPos; varying vec3 vLkN; uniform vec3 uLkFar, uLkFarWarm, uLkGrassDeep, uLkGrass;${MACRO}`,
  fragment: /* glsl */`
{
  float n = lkMacro(vLkPos.xz * 0.011 + 0.3);
  float h = vLkPos.y + (n - 0.5) * 6.0;
  ${near
    ? 'vec3 col = mix(uLkGrassDeep * 0.85, mix(uLkGrass, uLkFar, 0.35), smoothstep(0.0, 9.0, h)); col = mix(col, mix(uLkGrassDeep, uLkFar, 0.6), smoothstep(0.45, 0.7, n) * 0.6);'
    : 'vec3 col = mix(mix(uLkGrassDeep, uLkFar, 0.7), uLkFar, smoothstep(2.0, 10.0, h)); col = mix(col, uLkFarWarm, smoothstep(15.0, 26.0, h)); col = mix(col, vec3(1.0, 0.93, 0.88), smoothstep(25.0, 31.0, h) * 0.8);'}
  diffuseColor.rgb = col;
}`,
});

// Cordilleras de fondo: dos anillos de crestas alrededor del valle. Sustituyen
// a los icosaedros del horizonte, que de cerca eran burbujas. Van en el grupo
// del look (fuera de mapGroup) y dentro del plano lejano de la cámara (200 m).
function addRidges(ctx, U) {
  const rnd = ctx.rng('ridges');
  const ring = (name, R, depth, hMin, hMax, seg, near) => {
    const pos = [], idx = [];
    const phase = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const wob = Math.sin(a * 3 + phase[0]) * 0.5 + Math.sin(a * 7 + phase[1]) * 0.3 + Math.sin(a * 17 + phase[2]) * 0.2;
      const jag = i === seg ? 0 : rnd();
      const h = i === seg ? null : hMin + (hMax - hMin) * Math.max(0, 0.5 + wob * 0.5) * (0.55 + 0.45 * jag);
      const r = R + wob * depth * 0.4;
      const cx = Math.cos(a), cz = Math.sin(a);
      pos.push(cx * (r - depth), -2, cz * (r - depth), cx * r, h ?? pos[4], cz * r, cx * (r + depth), -2, cz * (r + depth));
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 3, b = a + 3;
      idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    patch(m, { ...mountain(near), uniforms: pick(U, ['uLkFar', 'uLkFarWarm', 'uLkGrassDeep', 'uLkGrass', 'uLkMacro']), key: `mountain${near ? 'N' : 'F'}` });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    ctx.group.add(mesh);
  };
  ring('look-hills', 104, 13, 4, 13, 72, true);
  ring('look-range', 142, 15, 12, 34, 96, false);
}

// ---------------------------------------------------------------- reparto
const hexOf = (m) => (m.color ? m.color.getHex() : -1);
const isNear = (hex, target, tol = 10) => {
  const d = (s) => Math.abs(((hex >> s) & 255) - ((target >> s) & 255));
  return d(16) <= tol && d(8) <= tol && d(0) <= tol;
};

function restyle(ctx, U) {
  const { world, palette: P } = ctx;
  const stoneU = pick(U, ['uLkBase', 'uLkLight', 'uLkWarm', 'uLkGrey', 'uLkCope', 'uLkPlinth', 'uLkMortar', 'uLkDamp', 'uLkMoss', 'uLkLichen', 'uLkMacro']);
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
  // los sombreadores leen objectNormal: solo materiales que la declaran siempre
  const lit = (m) => m.isMeshStandardMaterial || m.isMeshLambertMaterial;
  const done = (m) => { m.userData.lookStyled = true; return m; };
  const stone = (m, tint, k = 1) => {
    if (m.userData.lookStyled || !lit(m)) return;
    done(m).color.setScalar(k);
    if (m.map) { m.map = null; m.bumpMap = null; }
    patch(m, { ...dressed(tint), uniforms: stoneU, key: `dressed${tint}` });
  };
  const tiles = (m, k = 1) => {
    if (m.userData.lookStyled || !lit(m)) return;
    done(m).color.setScalar(k);
    patch(m, { ...TILES, uniforms: pick(U, ['uLkTile', 'uLkTileDark', 'uLkTileOld', 'uLkMoss', 'uLkLichen', 'uLkMacro']), key: 'tiles' });
  };
  const wood = (m, hex) => {
    if (m.userData.lookStyled || !lit(m)) return;
    done(m).color.setHex(hex);
    patch(m, { ...WOOD, key: 'wood' });
  };
  const enamel = (m, hex) => { done(m).color.setHex(hex); m.emissive.setHex(hex); m.emissiveIntensity = 0.25; };

  const courtX = 21, courtZ = 26.6;
  // la capa de aire trae sus propias llamas: los conos fijos sobran
  const liveFire = ctx.layers.has('atmos');
  world.mapGroup.traverse((o) => {
    if (!o.isMesh) return;
    let top = o;
    while (top.parent && top.parent !== world.mapGroup) top = top.parent;
    const owner = top.name || '';

    // --- bloques de cobertura: sillería que casa con cada bloque
    if (o.name === 'box-batch-sides' || o.name === 'box-batch-tops') {
      const old = o.material;
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: old.roughness, metalness: 0.0 });
      patch(m, { ...MASONRY, uniforms: stoneU, key: 'masonry' });
      old.dispose();
      o.material = m;
      return;
    }
    if (o.name === 'map-floor') {
      const old = o.material;
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.84, metalness: 0.0 });
      // un mapa de datos no tiene el patio de Fortaleza: todo losa, sin dibujo
      patch(m, {
        ...(ctx.real ? GROUND(courtX + 0.15, courtZ + 0.15, true) : GROUND(1e4, 1e4, false)),
        uniforms: pick(U, ['uLkWarm', 'uLkGrey', 'uLkMortar', 'uLkMoss', 'uLkFlag', 'uLkFlagWarm', 'uLkMacro',
          'uLkGrass', 'uLkGrassDeep', 'uLkGrassDry', 'uLkDirt', 'uLkEarth']),
        key: ctx.real ? 'ground' : 'ground-flat',
      });
      old.dispose();
      o.material = m;
      return;
    }
    if (o.name === 'contact-shadows') { o.material.color.setHex(0x262a32); return; } // sombra fría, no parda
    if (o.name === 'sky-body') return;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const src of mats) {
      if (!src) continue;
      // un material ya visto puede servir a varias mallas: la decisión de ocultar es por malla
      if (src.userData.lookHide) { o.visible = false; continue; }
      if (src.userData.lookStyled) continue;
      const name = src.name || '', hex = hexOf(src);
      const basicFlat = src.isMeshBasicMaterial && !src.map && !src.transparent;
      const lambertFlat = src.isMeshLambertMaterial && !src.map;
      // Blender: kit del castillo y galerías
      if (owner === 'maps-v2' && name === 'fortress-stair-stone') stone(own(o, src), 0, 0.92);
      else if (/^Limestone$|Aged fortress limestone/.test(name)) stone(own(o, src), 0, 0.92);
      else if (/Carved pale stone|Dressed window stone|Honed limestone/.test(name)) stone(own(o, src), 1, 1.0);
      else if (/Recessed mortar/.test(name)) stone(own(o, src), 2, 0.9);
      else if (/Weathered terracotta/.test(name)) tiles(own(o, src));
      else if (/oak/i.test(name)) wood(own(o, src), /Dark/.test(name) ? P.wood.dark : P.wood.oak);
      else if (/Crimson enamel/.test(name) && src.isMeshStandardMaterial) enamel(own(o, src), P.team.red);
      else if (/Cobalt enamel/.test(name) && src.isMeshStandardMaterial) enamel(own(o, src), P.team.blue);
      else if (/brass/i.test(name) && src.isMeshStandardMaterial) { const m = done(own(o, src)); m.color.setHex(P.metal.bronze); m.metalness = 0.6; m.roughness = 0.5; } // bronce viejo y mate
      else if (/Amber embers/.test(name) && src.isMeshStandardMaterial) { const m = done(own(o, src)); m.emissive.setHex(P.fire.flame); m.emissiveIntensity = 3.2; }
      else if (/iron/i.test(name)) done(own(o, src)).color.setHex(P.metal.iron);
      // pulido de arquitectura: marcos y remates sobre los bloques
      else if (owner === 'fortaleza-architectural-polish' && src.isMeshStandardMaterial && isNear(hex, 0xa89b80)) stone(own(o, src), 1, 0.97);
      else if (owner === 'fortaleza-architectural-polish' && src.isMeshStandardMaterial && isNear(hex, 0x645b4d)) stone(own(o, src), 0, 0.74);
      else if (owner === 'fortaleza-architectural-polish' && src.isMeshStandardMaterial && isNear(hex, 0x746a56)) stone(own(o, src), 2, 1.0);
      // piezas con la textura de piedra de siempre: se quedan con su dibujo de
      // sillares y solo ganan color (merlones, torreones, caserío)
      else if (src.isMeshStandardMaterial && src.map && src.bumpMap) done(own(o, src)).color.copy(new THREE.Color(P.stone.base).lerp(new THREE.Color(P.stone.light), 0.35));
      else if (src.isMeshStandardMaterial && !src.map && isNear(hex, 0x7a3f26)) tiles(own(o, src));
      else if (lambertFlat && isNear(hex, 0x704632)) tiles(own(o, src));
      else if (lambertFlat && isNear(hex, 0x687153, 4) && o.geometry.type === 'PlaneGeometry') {
        const m = done(own(o, src));
        m.color.setHex(0xffffff);
        patch(m, { ...MEADOW, uniforms: pick(U, ['uLkGrass', 'uLkGrassDeep', 'uLkGrassDry', 'uLkDirt', 'uLkMacro']), key: 'meadow' });
      }
      // las burbujas del horizonte: las relevan las crestas
      else if (lambertFlat && isNear(hex, 0x596a72, 4) && ctx.real) { o.visible = false; done(own(o, src)); }
      // llamas y faroles sin luz propia: por encima de blanco, el bloom hace el resto
      else if (basicFlat && (isNear(hex, 0xff8a3d, 6) || isNear(hex, 0xffa63d, 6))) {
        if (liveFire && o.geometry.type === 'ConeGeometry') o.visible = false;
        done(own(o, src)).color.setHex(P.fire.flame).multiplyScalar(2.6);
      }
      else if (basicFlat && [0xffe0a0, 0xffe291, 0xffc57e, 0xffbe6f].some((h) => isNear(hex, h, 8))) {
        if (liveFire && o.geometry.type === 'ConeGeometry') o.visible = false;
        done(own(o, src)).color.setHex(P.fire.core).multiplyScalar(2.2);
      }
      // la hiedra plana de antes: la releva la de la capa de flora
      else if (src.isMeshLambertMaterial && src.map && src.alphaTest === 0.5 && o.geometry.type === 'PlaneGeometry' && !o.isInstancedMesh) {
        const m = done(own(o, src));
        if (ctx.layers.has('flora')) { m.userData.lookHide = true; o.visible = false; }
      }
      // estandartes de la casa en la torre del homenaje (eran naranja de acento): ocre teñido
      else if (src.isMeshLambertMaterial && src.map && isNear(hex, 0xff8a3d, 4)) done(own(o, src)).color.setHex(P.cloth.gold);
      // estandartes de equipo
      else if (src.isMeshLambertMaterial && src.map && isNear(hex, 0xd94f3f, 4)) done(own(o, src)).color.setHex(P.team.red);
      else if (src.isMeshLambertMaterial && src.map && isNear(hex, 0x4f8de0, 4)) done(own(o, src)).color.setHex(P.team.blue);
      // madera suelta (cajas, vigas, andamio, troncos) y follaje de los árboles
      else if (lambertFlat && WOOD_HEX.some((h) => isNear(hex, h, 8))) wood(own(o, src), isNear(hex, 0x4a4038, 8) ? P.wood.dark : P.wood.oak);
      else if (lambertFlat && FOLIAGE_HEX.some((h) => isNear(hex, h, 6))) {
        const i = FOLIAGE_HEX.findIndex((h) => isNear(hex, h, 6));
        done(own(o, src)).color.setHex(P.foliage[i % 3]); // los tres verdes; los tonos de otoño son de la capa de flora
      }
    }
  });
}

const WOOD_HEX = [0x735239, 0x6e5138, 0x8a6a48, 0x604633, 0x5d4431, 0x624733, 0x4a4038];
const FOLIAGE_HEX = [0x557a3e, 0x648a47, 0x6c8a4d, 0x5d7a44];

function pick(all, names) {
  const out = {};
  for (const n of names) out[n] = all[n];
  return out;
}
