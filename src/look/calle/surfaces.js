// LOOK DE CALLE CERRADA: la avenida que la policía cerró cuando todo se torció
// y que luego quedó abandonada. Solo cambia materiales, luz, cielo y niebla de
// lo que ya construyó el mapa; la geometría nueva (marcas, cinta, halos) vive
// en las capas de vida.
//  - Los colores de origen se respetan (ladrillo, autos, mobiliario): encima
//    va el abandono, polvo en lo que mira arriba, mugre que sube del suelo y
//    chorretones de hollín, calculado en el shader por posición de mundo.
//  - Casi todo está apagado: ventanas, escaparates, rótulos, faros. Siguen
//    vivas algunas farolas de sodio (dos titilan), un par de rótulos a medio
//    encender, alguna tele y las luces del operativo (sources.js).
//  - Las barras de las patrullas, los pilotos de obra y las bengalas lavan de
//    color lo que tienen cerca (WASH) y se reflejan en el asfalto mojado.
// Las piezas horneadas de Calle 2 (ver optimizeCalle2) se repintan con
// retint() por material de origen, sin sumar llamadas de dibujo.
import * as THREE from 'three';
import { NOISE, patch } from '../glsl.js';
import { retint, tintOf, CALLE_LAMP_HEADS } from '../../world/calle-expansion-art.js';
import { findSources, sourceState, WASH_VERT, washFrag, washPars, MAX_SOURCES } from './sources.js';

// Estado de cada farola de la avenida, por posición (lado, z). Simétrico
// por la rotación de 180° del mapa: cada equipo ve la misma calle.
// 1 viva (sodio), 2/3 titila (con su propio ritmo), 0 muerta.
const LAMP_STATE = { '-1:-35': 1, '1:-25': 2, '1:-15': 1, '-1:-5': 1 };
const lampState = (x, z) => {
  const k = `${Math.sign(x)}:${Math.round(z)}`, m = `${-Math.sign(x)}:${-Math.round(z)}`;
  const s = LAMP_STATE[k] ?? LAMP_STATE[m] ?? 0;
  return s === 2 && LAMP_STATE[m] === 2 ? 3 : s; // la gemela del otro lado titila a su ritmo
};

export function surfaces(ctx) {
  const { world, palette: P } = ctx;
  applyEnvironment(world, P);
  const sources = sourceState(findSources(world, ctx.rng('sources')));
  const NS = Math.min(MAX_SOURCES, sources.list.length);
  const flick = new THREE.Vector2(1, 1);
  // lo comparten las capas de vida (se construyen después, con este ctx)
  ctx.calle = { sources, flick };
  const U = {
    uLookTime: ctx.uniforms.uLookTime,
    uLkMacro: { value: world._macroNoiseTexture() },
    uLkAsphalt: { value: new THREE.Color(P.asphalt) }, uLkAsphaltWarm: { value: new THREE.Color(P.asphaltWarm) },
    uLkPuddle: { value: new THREE.Color(P.puddle) },
    uLkDust: { value: new THREE.Color(P.dust) },
    uLkCrackC: { value: new THREE.Color(P.glass.crack) },
    uLkTv: { value: new THREE.Color(P.glass.tv) },
    uLkFlick: { value: flick },
    uLkBar: { value: new THREE.Vector4() },
    uLkSrcP: { value: sources.P }, uLkSrcC: { value: sources.C },
  };
  const state = { floor: null };
  restyle(ctx, U, NS, state);
  // Reflejos en el agua: farolas vivas y fuentes del operativo (estas con su
  // color animado: la MISMA referencia de Color que el lavado).
  const glows = [];
  const flickGlow = [];
  for (const l of CALLE_LAMP_HEADS) {
    const s = lampState(l.x, l.z);
    if (!s || !world.mapGroup.getObjectByName('calle2-light-pools')) continue;
    const c = new THREE.Color(P.lamp.sodium).multiplyScalar(0.45);
    if (s > 1) flickGlow.push([c, s - 2, c.clone()]);
    glows.push([l.x, l.y, l.z, 0.7, c]);
  }
  sources.list.forEach((src, i) => glows.push([src.pos.x, src.pos.y, src.pos.z, src.kind === 'flare' || src.kind === 'ember' ? 0.25 : 0.4, sources.C[i]]));
  const G = Math.min(glows.length, Math.max(8, Math.round(28 * (ctx.budget?.detail ?? 1))));
  // si la calidad recorta, se quedan las fuentes del operativo (lo vivo)
  const kept = glows.slice(-G);
  U.uLkGlowP = { value: kept.map(([x, y, z, r]) => new THREE.Vector4(x, y, z, r)) };
  U.uLkGlowC = { value: kept.map((g) => g[4]) };
  if (state.floor) {
    const o = state.floor, old = o.material;
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: old.map, roughness: 0.66, metalness: 0.05, envMapIntensity: 0.5 });
    patch(m, { ...floorPatch(kept.length), uniforms: U, key: `calle-floor-${kept.length}` });
    if (NS) patch(m, { uniforms: U, vertexPars: 'varying vec3 vLkSW;', vertex: WASH_VERT, fragmentPars: washPars(NS), emissive: washFrag(NS), key: `calle-wash-${NS}` });
    old.dispose();
    o.material = m;
  }
  return {
    grade: P.grade,
    update(dt, t) {
      sources.update(t);
      U.uLkBar.value.set(sources.bar[0], sources.bar[1], sources.bar[2], sources.bar[3]);
      flick.set(lampDying(t), lampFlicker(t * 1.13, 4.1));
      for (const [c, k, base] of flickGlow) c.copy(base).multiplyScalar(k ? flick.y : flick.x);
    },
  };
}

// Farola que muere: encendida con zumbido y, cada pocos segundos, una racha
// de apagones cortos (nunca se queda oscura mucho rato).
// La que se muere del todo: chispazos, apagones largos y vuelta a medias.
function lampDying(t) {
  const u = t % 9.0;
  if (u > 6.2) return u > 8.6 ? 0.4 : 0.02;
  return Math.sin(t * 13.0) * Math.sin(t * 7.7 + 1.0) * Math.sin(t * 29.0) > -0.12 ? 1.0 : 0.03;
}
function lampFlicker(t, seed) {
  const u = (t * 0.55 + seed) % 6.3;
  if (u < 1.1) return Math.sin(t * 57 + seed) * Math.sin(t * 21.7 + seed * 3) > 0.15 ? 0.95 : 0.06;
  if (u > 5.8) return 0.35 + 0.3 * Math.sin(t * 90);
  return 0.92 + 0.08 * Math.sin(t * 100 + seed);
}

function applyEnvironment(world, P) {
  const L = P.light;
  world.hemi.color.setHex(L.hemiSky);
  world.hemi.groundColor.setHex(L.hemiGround);
  world.hemi.intensity = L.hemiIntensity;
  world.amb.color.setHex(L.amb);
  world.amb.intensity = L.ambIntensity;
  // luna más baja que la del clásico: se ve sobre los tejados al fondo de la
  // avenida y alarga las sombras (misma luz y mismo mapa de sombras)
  world.sun.color.setHex(L.moon);
  world.sun.intensity = L.moonIntensity;
  world.sun.position.set(...L.moonPos);
  world._setSky(P.sky.stops);
  // humo en el aire: más denso a lo lejos, la ciudad se apaga en gris
  world.scene.fog = new THREE.FogExp2(L.fog, L.fogDensity);
}

// ---------------------------------------------------------------- GLSL
// Asfalto mojado con reflejos: espejo plano de cada fuente (farolas vivas,
// barras, pilotos y bengalas). Para el píxel del suelo se refleja la vista y
// se mide a qué distancia pasa ese rayo de cada fuente.
const floorPatch = (GLOWS) => ({
  vertexPars: 'varying vec3 vLkPos;',
  vertex: 'vLkPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
  fragmentPars: /* glsl */`
varying vec3 vLkPos;
uniform sampler2D uLkMacro;
uniform vec3 uLkAsphalt, uLkAsphaltWarm, uLkPuddle;
${GLOWS ? `uniform vec4 uLkGlowP[${GLOWS}];
uniform vec3 uLkGlowC[${GLOWS}];` : ''}
${NOISE}
float lkWet = 0.0; vec3 lkBump = vec3(0.0);`,
  fragment: /* glsl */`
{
  vec2 p = vLkPos.xz;
  float broad = texture2D(uLkMacro, p * 0.045 + 0.13).r, mid = texture2D(uLkMacro, p * 0.21 + 0.61).g;
  float grain = lkNoise(p * 11.0) * 0.55 + lkNoise(p * 37.0) * 0.45;
  float tone = dot(diffuseColor.rgb, vec3(0.3333));                       // grietas y árido de la textura de siempre
  vec3 col = mix(uLkAsphalt, uLkAsphaltWarm, smoothstep(0.35, 0.75, mid));
  col *= mix(0.82, 1.12, broad) * mix(0.86, 1.10, grain) * clamp(tone * 1.6, 0.5, 1.25);
  // parches de asfalto viejo y hollín: la calle lleva meses sin barrer
  float patchy = smoothstep(0.62, 0.7, lkNoise(p * 0.33 + 4.0));
  col *= 1.0 - patchy * 0.18;
  // la cuneta junto al bordillo guarda agua; el centro de la calzada, menos
  float gutter = 1.0 - smoothstep(0.4, 1.6, abs(abs(p.x) - 11.2));
  lkWet = 1.0 - smoothstep(0.27, 0.35, broad + (mid - 0.5) * 0.22 - gutter * 0.22);
  col = mix(col, uLkPuddle, lkWet * 0.6);
  diffuseColor.rgb = col;
  lkBump = vec3(grain - 0.5, 0.0, mid - 0.5) * 0.35 * (1.0 - lkWet);
}`,
  normal: 'normal = normalize(normal + (viewMatrix * vec4(lkBump, 0.0)).xyz);',
  rough: 'roughnessFactor = mix(roughnessFactor, 0.2, lkWet);',
  emissive: !GLOWS ? '' : /* glsl */`
{
  vec3 v = normalize(vLkPos - cameraPosition);
  vec3 r = vec3(v.x, -v.y, v.z);
  vec3 refl = vec3(0.0);
  for (int i = 0; i < ${GLOWS}; i++) {
    vec4 g = uLkGlowP[i];
    vec3 s = vec3(g.x, g.y, g.z) - vLkPos;
    float t = max(dot(s, r), 0.0);
    vec3 d = s - r * t;
    float rad = g.w + t * 0.03;                       // lejos, el reflejo se abre (agua rizada)
    // agua rizada: el reflejo se estira en vertical (estela hacia la cámara)
    vec3 lat = cross(r, vec3(0.0, 1.0, 0.0));
    lat /= max(length(lat), 1e-3);
    float dl = dot(d, lat);
    float dv2 = max(dot(d, d) - dl * dl, 0.0);
    refl += uLkGlowC[i] * exp(-(dl * dl) / (rad * rad) - dv2 / (rad * rad * 20.0)) * step(0.0, g.y);
  }
  totalEmissiveRadiance += refl * (0.05 + 0.95 * lkWet) * 0.5;
}`,
});

// Material horneado (color por vértice): un color por encima de 1 significa
// "brilla". Se separa en albedo y emisión, así funciona igual con la cadena de
// imagen apagada.
const BAKED_GLOW = {
  fragment: 'vec3 lkGlowV = max(vColor.rgb - 1.0, 0.0); diffuseColor.rgb = min(diffuseColor.rgb, vec3(1.0));',
  emissive: 'totalEmissiveRadiance += lkGlowV * 1.4;',
};

// ABANDONO: polvo, mugre y hollín por posición de mundo, más el lavado de las
// fuentes. Extras por material: vidrio roto, tele, rótulo a medio encender,
// lente de la barra de la patrulla.
function wornPatch(NS, { glass = false, tv = false, neon = null, bar = null, burnt = false } = {}) {
  const vertexPars = 'varying vec3 vLkSW; varying vec3 vLkSN;';
  const vertex = `${WASH_VERT}\nvLkSN = inverseTransformDirection(transformedNormal, viewMatrix);`;
  const fragmentPars = `${NS ? washPars(NS) : 'varying vec3 vLkSW;'}
varying vec3 vLkSN;
uniform float uLookTime; uniform vec3 uLkDust, uLkCrackC, uLkTv; uniform vec4 uLkBar;
${NOISE}
float lkCrack = 0.0, lkGone = 0.0;`;
  let fragment = /* glsl */`
{
  vec3 n = normalize(vLkSN + vec3(0.0, 1e-5, 0.0));
  float up = smoothstep(0.5, 0.92, n.y), side = 1.0 - abs(n.y);
  float blot = lkNoise(vLkSW.xz * 1.6 + vLkSW.y * 0.8);
  float streak = lkNoise(vec2(dot(vLkSW.xz, vec2(0.71)) * 2.6, vLkSW.y * 0.3));
  // polvo de meses en techos, capós y tapas: se lee más claro que el asfalto
  diffuseColor.rgb = mix(diffuseColor.rgb, uLkDust * (0.8 + 0.3 * blot), up * (0.22 + 0.38 * blot));
  // mugre que sube del suelo y chorretones de hollín en las caras
  float low = (1.0 - smoothstep(0.05, 1.0, vLkSW.y)) * side;
  float soot = smoothstep(0.58, 0.82, streak) * side * smoothstep(0.6, 2.2, vLkSW.y);
  diffuseColor.rgb *= 1.0 - low * 0.3 - soot * 0.2;
}`;
  if (burnt) {
    // auto quemado: chapa carbonizada con óxido en placas
    fragment += /* glsl */`
{
  float r = lkNoise(vLkSW.xz * 2.3 + vLkSW.y * 3.1) * 0.6 + lkNoise(vLkSW.xy * 7.0) * 0.4;
  diffuseColor.rgb = mix(vec3(0.012, 0.011, 0.01), vec3(0.13, 0.05, 0.02), smoothstep(0.62, 0.8, r));
}`;
  }
  let emissive = NS ? washFrag(NS) : '';
  let rough = '';
  if (glass) {
    // vidrio: algunos paños con un impacto (estrella de grietas radiales y
    // dos anillos) y alguno sin cristal (negro mate). Un paño = celda de 1.3 m.
    fragment += /* glsl */`
{
  vec3 n = abs(vLkSN);
  vec2 q = n.y > 0.6 ? vLkSW.xz : (n.x > n.z ? vLkSW.zy : vLkSW.xy);
  vec2 id = floor(q / 1.3);
  float cell = lkHash21(id + 7.0);
  vec2 d = q - (id + 0.25 + 0.5 * lkHash22(id + 3.0)) * 1.3 + 1e-4;
  float r = length(d);
  float a = atan(d.y, d.x) + 0.25 * (lkNoise(d * 9.0) - 0.5);
  float sp = fract(a * 1.4324 + cell * 7.0);                      // 9 radios
  float arc = min(sp, 1.0 - sp) * 0.698 * r;
  float spokes = (1.0 - smoothstep(0.003, 0.009, arc)) * (1.0 - smoothstep(0.2, 0.55 + 0.4 * cell, r));
  float rings = (1.0 - smoothstep(0.0, 0.007, abs(r - 0.07 - 0.05 * cell))) + (1.0 - smoothstep(0.0, 0.006, abs(r - 0.19 - 0.08 * cell))) * step(0.4, lkNoise(d * 14.0));
  lkCrack = clamp(spokes + rings + (1.0 - smoothstep(0.0, 0.03, r)), 0.0, 1.0) * step(0.5, cell);
  lkGone = step(cell, 0.12);
  diffuseColor.rgb = mix(diffuseColor.rgb, uLkCrackC * 0.6, lkCrack * 0.5);
  diffuseColor.rgb *= 1.0 - lkGone * 0.8;
}`;
    emissive += '\ntotalEmissiveRadiance = totalEmissiveRadiance * (1.0 - lkGone) + uLkCrackC * lkCrack * 0.035;';
    rough = 'roughnessFactor = mix(roughnessFactor, 1.0, lkGone);';
  }
  if (tv) {
    // ventanas: todo a oscuras, salvo alguna tele que nadie apagó
    emissive += /* glsl */`
{
  vec3 cell = floor(vLkSW / vec3(3.0, 2.7, 2.4));
  float h = lkHash21(cell.xz + cell.y * 17.0);
  float f = 0.55 + 0.3 * sin(uLookTime * 5.3 + h * 50.0) * sin(uLookTime * 1.7 + h * 9.0) + 0.25 * step(0.9, fract(uLookTime * 0.6 + h * 3.0));
  totalEmissiveRadiance = uLkTv * f * 0.9 * step(0.025, h) * step(h, 0.07);
  // y en otra, alguien con un farol tras la cortina: luz cálida en pliegues
  float folds = 0.55 + 0.45 * sin((vLkSW.x + vLkSW.z) * 22.0) * sin((vLkSW.x + vLkSW.z) * 7.0 + 1.3);
  totalEmissiveRadiance += vec3(1.0, 0.55, 0.22) * folds * 0.9 * step(h, 0.025);
}`;
  }
  if (neon) {
    // rótulo a medio encender: letras muertas al azar y un zumbido con cortes
    emissive += /* glsl */`
{
  float along = vLkSW.z + vLkSW.x;
  float alive = step(0.42, lkHash11(floor(along * 3.2) + ${neon.seed.toFixed(1)}));
  float buzz = 0.8 + 0.2 * sin(uLookTime * 47.0);
  float cut = step(0.16, fract(sin(floor(uLookTime * 6.0 + ${neon.seed.toFixed(1)}) * 12.989) * 437.585));
  totalEmissiveRadiance += vec3(${neon.color.r.toFixed(3)}, ${neon.color.g.toFixed(3)}, ${neon.color.b.toFixed(3)}) * alive * buzz * cut * 1.6;
}`;
  }
  if (bar) {
    // lente de la barra: la patrulla de z<0 es la primera (índices 0,1)
    const [a, b] = bar === 'red' ? ['x', 'z'] : ['y', 'w'];
    emissive += /* glsl */`
{
  float k = vLkSW.z < 0.0 ? uLkBar.${a} : uLkBar.${b};
  totalEmissiveRadiance = diffuseColor.rgb * (0.15 + 4.0 * k);
}`;
  }
  return { vertexPars, vertex, fragmentPars, fragment, emissive, rough,
    key: `calle-worn-${NS}-${glass ? 'g' : ''}${tv ? 't' : ''}${neon ? `n${neon.seed}` : ''}${bar ?? ''}${burnt ? 'b' : ''}` };
}

// ---------------------------------------------------------------- reparto
const hexOf = (m) => (m.color ? m.color.getHex() : -1);
const isNear = (hex, target, tol = 10) => {
  const d = (s) => Math.abs(((hex >> s) & 255) - ((target >> s) & 255));
  return d(16) <= tol && d(8) <= tol && d(0) <= tol;
};
const C = (hex) => new THREE.Color(hex);
const litMat = (m) => m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial;

function restyle(ctx, U, NS, state) {
  const { world, palette: P } = ctx;
  const map = world.mapGroup;
  // Los materiales de los GLB se comparten con la caché de assets: se trabaja
  // sobre un clon (que sí se libera con el mapa), uno por material de origen.
  const swapped = new Map();
  const own = (mesh, m) => {
    if (!m.userData.urbanAssetShared) return m;
    let c = swapped.get(m);
    if (!c) { c = m.clone(); c.userData = { lookClone: true }; swapped.set(m, c); }
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map((x) => (x === m ? c : x));
    else mesh.material = c;
    return c;
  };
  const worn = (m, opts) => {
    if (m.userData.calleWorn || m.transparent && !opts?.glass || m.isShaderMaterial || !litMat(m)) return;
    m.userData.calleWorn = true;
    patch(m, { ...wornPatch(NS, opts), uniforms: U });
  };

  // Dos rótulos a medio encender, uno por acera (por nombre: igual en todos
  // los clientes). Su material de letras se clona para no encender los demás.
  const facades = map.children.filter((o) => o.userData.blenderFacade)
    .sort((a, b) => a.userData.streetBuilding.name.localeCompare(b.userData.streetBuilding.name) || a.position.z - b.position.z);
  const rng = ctx.rng('neon');
  const neonOf = new Map();
  for (const side of [-1, 1]) {
    const row = facades.filter((f) => Math.sign(f.position.x) === side);
    const f = row[Math.floor(rng() * row.length)];
    const title = f?.getObjectByName('Shop_title');
    if (title && !Array.isArray(title.material)) {
      neonOf.set(title, { seed: Math.round(rng() * 90), color: C(side < 0 ? P.sign.warm : P.sign.cold) });
    }
  }

  // Farolas: la lente de cada una, por cercanía a su cabeza (datos del mapa).
  const lensMats = new Map();
  const lensMat = (src, s) => {
    const k = `${src.uuid}:${s}`;
    if (lensMats.has(k)) return lensMats.get(k);
    const m = src.clone(); m.userData = { lookClone: true };
    if (s === 0) m.color.setHex(P.lamp.dead);
    else {
      m.color.setHex(P.lamp.sodium).multiplyScalar(2.2);
      if (s > 1) patch(m, { uniforms: U, fragmentPars: 'uniform vec2 uLkFlick;', fragment: `diffuseColor.rgb *= uLkFlick.${s === 2 ? 'x' : 'y'};`, key: `calle-lens-${s}` });
    }
    lensMats.set(k, m);
    return m;
  };
  const v = new THREE.Vector3(), box = new THREE.Box3();

  map.traverse((o) => {
    try { restyleOne(o); } catch (err) { console.warn('[look] calle: pieza sin repintar', o.name, err); }
  });

  function restyleOne(o) {
    if (o.isLight && o.name === 'calle2-avenue-fill') { o.color.setHex(P.light.fill); o.intensity = P.light.fillIntensity; return; }
    if (!o.isMesh) return;
    // --- horneado: repintar los tramos por su material de origen
    if (tintOf(o)) {
      retint(o, (m, glow) => bakedColor(m, glow, P));
      const m = o.material;
      if (litMat(m) && m.userData.calleBaked && !m.userData.calleGlow) {
        m.userData.calleGlow = true;
        patch(m, { ...BAKED_GLOW, key: 'calle-baked-glow' });
      }
      worn(m);
      return;
    }
    if (o.name === 'map-floor') { state.floor = o; return; }
    if (o.name === 'sky-body' || o.name === 'contact-shadows') return;
    if (o.name === 'calle2-light-pools') { pools(o); return; }
    if (o.name === 'streetlamp-lit-lens') {
      box.setFromObject(o).getCenter(v);
      let best = null, bd = 4;
      for (const l of CALLE_LAMP_HEADS) { const d = Math.hypot(l.x - v.x, l.z - v.z); if (d < bd) { bd = d; best = l; } }
      // las de la continuación (fuera del campo) están todas muertas
      o.material = lensMat(o.material, best ? lampState(best.x, best.z) : 0);
      return;
    }
    if (o.name === 'v2-ad-poster') {
      // paneles publicitarios de la acera: caja de luz muerta, vidrio roto
      const m = o.material;
      if (!m.userData.calleDead) { m.userData.calleDead = true; m.emissiveIntensity = 0.0; m.color.multiplyScalar(0.5); worn(m, { glass: true }); }
      return;
    }
    if (o.name === 'calle2-shop-display') {
      // escaparates muertos: sin luz dentro, solo lo que entra de la calle
      const m = o.material;
      if (!m.userData.calleDead) { m.userData.calleDead = true; m.emissiveIntensity = 0.02; m.color.multiplyScalar(0.55); worn(m, { glass: true }); }
      return;
    }
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const src of list) {
      if (!src) continue;
      const name = src.name || '', hex = hexOf(src);
      if (neonOf.has(o)) {
        const m = src.clone(); m.userData = { lookClone: true };
        o.material = m; worn(m, { neon: neonOf.get(o) });
        continue;
      }
      if (/occupied window|Occupied room/.test(name)) {
        const m = own(o, src);
        if (!m.userData.calleWorn) { m.color.setHex(P.glass.dark); m.emissive.setHex(0); m.roughness = 0.25; worn(m, { tv: true }); }
        continue;
      }
      if (/glazing|glass/i.test(name) || isNear(hex, 0x0b151b, 4) || isNear(hex, 0x030507, 3) || isNear(hex, 0x101c23, 4)) {
        const m = own(o, src);
        if (!m.userData.calleWorn && m.emissive) { m.emissive.multiplyScalar(0.2); }
        worn(m, { glass: true });
        continue;
      }
      // lentes de la barra de la patrulla (material propio de world.js)
      if (src.emissive && isNear(hex, 0xb92929, 4)) { worn(src, { bar: 'red' }); continue; }
      if (src.emissive && isNear(hex, 0x276aaf, 4)) { worn(src, { bar: 'blue' }); continue; }
      // una pareja de sedanes (la de color teja) ardió: carrocería quemada
      if (src.map && src.bumpMap && isNear(hex, 0x815e4f, 3)) { worn(src, { burnt: true }); src.roughness = 0.95; src.metalness = 0.1; continue; }
      if (!litMat(src) || src.transparent) {
        if (src.isMeshBasicMaterial && !src.userData.calleDead) {
          const dead = deadBasic(src, P);
          if (dead) { const m = own(o, src); m.userData.calleDead = true; m.color.copy(dead); }
        }
        continue;
      }
      worn(own(o, src));
    }
  }

  // Charcos de luz bajo las lámparas: los de farolas muertas se apagan, los
  // de las que titilan siguen su ritmo (atributo por instancia).
  function pools(o) {
    const n = o.count, fl = new Float32Array(n);
    const sodium = C(P.lamp.sodium), off = C(0x000000);
    o.material.color.setHex(0xffffff);
    o.material.opacity = 0.28;
    for (let i = 0; i < n; i++) {
      const l = CALLE_LAMP_HEADS[i];
      const s = l ? lampState(l.x, l.z) : 1;
      o.setColorAt(i, s ? sodium.clone().multiplyScalar(l ? 1 : 0.75) : off);
      fl[i] = s > 1 ? s - 1 : 0;
    }
    o.instanceColor.needsUpdate = true;
    o.geometry.setAttribute('aLkFlick', new THREE.InstancedBufferAttribute(fl, 1));
    patch(o.material, {
      uniforms: U,
      vertexPars: 'attribute float aLkFlick; varying float vLkFl;',
      vertex: 'vLkFl = aLkFlick;',
      fragmentPars: 'uniform vec2 uLkFlick; varying float vLkFl;',
      fragment: 'diffuseColor.rgb *= vLkFl < 0.5 ? 1.0 : (vLkFl < 1.5 ? uLkFlick.x : uLkFlick.y);',
      key: 'calle-pools',
    });
  }
}

// Lámparas, ventanas y faros pintados en Basic (sin luz): casi todo muerto.
function deadBasic(m, P) {
  const hex = hexOf(m);
  if (isNear(hex, 0xd19a61, 8) || isNear(hex, 0xffc47a, 8) || isNear(hex, 0xcbd9dc, 8)) return C(P.lamp.dead); // ventanas y apliques de tienda
  if (isNear(hex, 0xffd6a0, 8) || isNear(hex, 0xffd7a2, 8)) return C(0x3a3934);                       // faros
  if (isNear(hex, 0xa52e26, 8)) return C(0x3a1714);                                                        // pilotos traseros
  if (isNear(hex, 0x76a9b7, 8) || isNear(hex, 0x8fd0e8, 8)) return C(0x1f2a2e);                           // lavandería, cabina
  if (isNear(hex, 0xd8b76a, 8)) return C(0x4a4232);                                                        // parquímetros
  return null;
}

// tramos horneados: lo que brillaba (>1) se decide aquí
function bakedColor(m, glow, P) {
  const hex = hexOf(m);
  const dead = m.isMeshBasicMaterial ? deadBasic(m, P) : null;
  if (dead) return dead;
  // lámparas de pasos laterales y del taller: sodio vivo (tienen su charco)
  if (m.isMeshBasicMaterial && (isNear(hex, 0xffcb88, 10) || isNear(hex, 0xffb566, 10))) return C(P.lamp.sodium).multiplyScalar(2.0);
  // pilotos de obra: ámbar apagado (el destello lo pone cordon.js)
  if (m.isMeshBasicMaterial && isNear(hex, 0xffb34d, 10)) return C(0x6a4a22);
  // continuación de la avenida: ventanas y farolas apagadas
  if (glow) return C(0x0d1014);
  if (/occupied window|Occupied room/.test(m.name || '')) return C(P.glass.dark);
  return null;
}
