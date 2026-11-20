// SOLDADO EN UNA LLAMADA DE DIBUJO. El rig sigue siendo la jerarquía de
// piezas que anima la pose procedural (caderas, torso, cabeza, brazos,
// piernas y los segmentos del GLB colgados de ellas); nada de eso cambia.
// Lo que cambia es CÓMO se dibuja: todas las piezas visibles del cuerpo se
// fusionan en un único SkinnedMesh con skinning RÍGIDO (cada vértice pesa 1
// sobre la pieza de la que salió) y el esqueleto son esos mismos Object3D.
// Antes cada soldado eran ~200 meshes: ~330 llamadas entre color y sombra.
//
// Cada arma visible (mano, espalda, cadera) se fusiona igual, en un Mesh
// por arma; solo la de la mano proyecta sombra.
//
// Un material por equipo sirve a cuerpo y armas: el color, rugosidad,
// metal, brillo y "zona de equipo" de cada pieza viajan por vértice, y el
// shader añade costuras de panel, desgaste y un borde fresnel del color del
// equipo. Las texturas no hacen falta.
import * as THREE from 'three';
import { patch, NOISE } from '../look/glsl.js';

// Colores exactos de equipo del overhaul (también en las paletas de mapa).
export const SOLDIER_TEAM = Object.freeze({ red: 0xe8402f, blue: 0x2f7fe8 });
// Colores de equipo del avatar procedural de respaldo (rig.js TEAM_COLORS):
// solo sirven para reconocer qué piezas eran "de equipo" al fusionar.
const LEGACY_TEAM = [0xd94f3f, 0x4f8de0];

const TEAM_ZONES = ['head', 'chest', 'pauldron', 'thigh'];
const KIND = { suit: 0, armor: 1, metal: 2, webbing: 3, mark: 4, visor: 5, glow: 6 };
const IDENTITY = new THREE.Matrix4();
const lin = (r, g, b) => new THREE.Color(r, g, b);

// Tono neutro de la armadura por variante: con el casco y la silueta, es lo
// que separa a las cinco variantes de un mismo equipo. Ninguno es rojo ni
// azul saturado (esos colores son solo de los equipos).
const VARIANT_ARMOR = [
  lin(0.30, 0.31, 0.31),   // Recruit: cerámica gris clara
  lin(0.34, 0.28, 0.19),   // Sentinel: arena
  lin(0.15, 0.18, 0.10),   // Scout: oliva
  lin(0.10, 0.105, 0.11),  // Heavy: gunmetal oscuro
  lin(0.50, 0.50, 0.47),   // Ghost: marfil
];

// Superficie lógica de cada material del GLB, por nombre. `team`:
// 0 = neutro, 0.5 = panel de equipo (tono profundo), 1 = acento de equipo.
// `glow` = intensidad emisiva HDR (>1 florece con la cadena de imagen).
function namedSurface(name, region, variant) {
  const n = name.toLowerCase();
  if (n.includes('led')) return { color: lin(1, 0.2, 0.1), rough: 0.3, metal: 0.1, glow: 3.2, team: 1, kind: KIND.glow };
  // Grandes superficies de equipo: casco, pecho, hombros y muslos. El resto
  // de la armadura lleva el tono neutro de la variante (valor legible).
  const teamZone = TEAM_ZONES.includes(region);
  if (n.includes('painted red')) return { color: lin(0.3, 0.05, 0.04), rough: 0.5, metal: 0.12, glow: 0, team: 1, kind: KIND.armor };
  if (n.includes('team red armor') || n.includes('slate ceramic')) {
    const accent = n.includes('team red armor');
    return {
      color: VARIANT_ARMOR[variant] ?? VARIANT_ARMOR[0], rough: accent ? 0.5 : 0.58, metal: accent ? 0.12 : 0.08, glow: 0,
      team: teamZone ? (accent ? 1 : 0.5) : 0, kind: KIND.armor,
    };
  }
  if (n.includes('undersuit')) return { color: lin(0.045, 0.05, 0.055), rough: 0.9, metal: 0, glow: 0, team: 0, kind: KIND.suit };
  if (n.includes('rubber')) return { color: lin(0.03, 0.034, 0.04), rough: 0.82, metal: 0, glow: 0, team: 0, kind: KIND.suit };
  if (n.includes('skin matte black')) return { color: lin(0.022, 0.024, 0.027), rough: 0.95, metal: 0, glow: 0, team: 0, kind: KIND.suit };
  if (n.includes('edge gunmetal') || n.includes('machined')) return { color: lin(0.24, 0.25, 0.26), rough: 0.34, metal: 0.6, glow: 0, team: 0, kind: KIND.metal };
  if (n.includes('graphite')) return { color: lin(0.07, 0.075, 0.08), rough: 0.66, metal: 0.12, glow: 0, team: 0, kind: KIND.webbing };
  if (n.includes('slate metal')) return { color: lin(0.11, 0.12, 0.135), rough: 0.42, metal: 0.55, glow: 0, team: 0, kind: KIND.metal };
  if (n.includes('unit markings')) return { color: lin(0.62, 0.6, 0.52), rough: 0.6, metal: 0.05, glow: 0, team: 0, kind: KIND.mark };
  // El visor ahumado se enciende levemente del color del equipo.
  if (n.includes('visor')) return { color: lin(0.02, 0.025, 0.03), rough: 0.15, metal: 0.6, glow: 0.9, team: 1, kind: KIND.visor };
  if (n.includes('optic')) return { color: lin(0.02, 0.05, 0.065), rough: 0.17, metal: 0.6, glow: 0, team: 0, kind: KIND.visor };
  return null;
}

// Cualquier otro material (avatar procedural, cobre, etc.): se respeta su
// color y PBR; los MeshBasic eran luces planas y pasan a emisivos.
function genericSurface(material) {
  const color = material.color ? material.color.clone() : lin(0.5, 0.5, 0.5);
  const hex = material.color?.getHex();
  const team = LEGACY_TEAM.includes(hex) ? 1 : 0;
  if (material.isMeshBasicMaterial) return { color, rough: 0.4, metal: 0, glow: 2.4, team, kind: KIND.glow };
  return {
    color, rough: material.roughness ?? 0.7, metal: material.metalness ?? 0.1, glow: 0,
    team: team ? 0.5 : 0, kind: team ? KIND.armor : KIND.metal,
  };
}

// Zona del cuerpo de una pieza: segmento del GLB o, para los detalles de la
// variante, la articulación de la que cuelgan.
function regionOf(mesh, rig) {
  for (let n = mesh; n && n !== rig.root; n = n.parent) {
    const name = n.name || '';
    if (name.startsWith('segment_')) {
      const s = name.slice(8);
      if (s === 'chest') return 'chest';
      if (s === 'head') return 'head';
      if (s.startsWith('pauldron')) return 'pauldron';
      if (s.startsWith('thigh')) return 'thigh';
      return s;
    }
    if (n === rig.head) return 'head';
    if (n === rig.torso) return 'chest';
    if (n === rig.armL?.shoulder || n === rig.armR?.shoulder) return 'pauldron';
    if (n === rig.legL?.hip || n === rig.legR?.hip) return 'thigh';
  }
  return 'other';
}

function surfaceFor(material, mesh, rig) {
  return (material.name && namedSurface(material.name, rig ? regionOf(mesh, rig) : 'other', rig?.variant ?? 0)) ||
    genericSurface(material);
}

// ---------- material compartido ----------
const SHADER = {
  vertexPars: /* glsl */`
attribute vec4 aSurf; attribute vec2 aDetail;
varying vec4 vSurf; varying vec2 vDetail; varying vec3 vBind; varying vec3 vBindN;`,
  vertex: /* glsl */`
vSurf = aSurf; vDetail = aDetail; vBind = position; vBindN = normal;`,
  fragmentPars: /* glsl */`
uniform vec3 uTeam; uniform float uCorpse; uniform float uRim;
varying vec4 vSurf; varying vec2 vDetail; varying vec3 vBind; varying vec3 vBindN;
${NOISE}`,
  // diffuseColor ya trae el color por vértice (lineal)
  fragment: /* glsl */`
{
  float sKind = floor(vDetail.x * 255.0 + 0.5);
  float sSeed = vDetail.y * 17.0;
  float sTeamOn = step(0.02, vSurf.w);
  float sAccent = step(0.75, vSurf.w);
  vec3 sAlb = diffuseColor.rgb;
  // zona de equipo: acento brillante o panel profundo del color exacto
  sAlb = mix(sAlb, uTeam * mix(0.46, 0.86, sAccent), sTeamOn);
  float sArmor = 1.0 - step(0.5, abs(sKind - 1.0));
  float sWeb = 1.0 - step(0.5, abs(sKind - 3.0));
  float sSuit = 1.0 - step(0.5, sKind);
  // costuras de panel en la armadura: rejilla en el espacio de la pieza,
  // solo en los ejes que recorren la superficie y apagada a distancia
  vec3 q = vBind * vec3(4.5, 8.5, 4.5) + sSeed;
  vec3 aw = fwidth(q);
  vec3 f = abs(fract(q) - 0.5);
  vec3 seam = smoothstep(vec3(0.5) - aw * 1.5 - 0.02, vec3(0.5), f);
  vec3 an = abs(normalize(vBindN + vec3(1e-5)));
  seam *= 1.0 - smoothstep(0.55, 0.85, an);
  float sFade = 1.0 - smoothstep(0.18, 0.45, max(aw.x, max(aw.y, aw.z)));
  float sLine = max(seam.x, max(seam.y, seam.z)) * sFade * sArmor;
  sAlb *= 1.0 - 0.34 * sLine;
  // desgaste: desconchones claros en pintura y cerámica
  float sWear = smoothstep(0.82, 0.96, lkNoise(vBind.xy * 52.0 + vBind.z * 37.0 + sSeed)) * sArmor * sFade;
  sAlb = mix(sAlb, vec3(0.34, 0.34, 0.32), sWear * 0.3);
  // cinchas y tejido: trama tenue y variación de lote
  float sWeave = 0.5 + 0.5 * sin((vBind.x + vBind.y * 1.7 + vBind.z) * 160.0);
  sAlb *= 1.0 - (sWeb * 0.16 * sWeave + (sWeb + sSuit) * 0.18 * lkNoise(vBind.xz * 9.0 + sSeed)) * sFade;
  // cadáver: pierde saturación y valor al asentarse
  float sL = dot(sAlb, vec3(0.2126, 0.7152, 0.0722));
  sAlb = mix(sAlb, vec3(sL) * 0.6, uCorpse * 0.82);
  diffuseColor.rgb = sAlb;
}`,
  rough: /* glsl */`roughnessFactor = mix(vSurf.x, 0.92, uCorpse);`,
  // metalnessFactor ya existe aquí (metalnessmap_fragment va antes)
  normal: /* glsl */`metalnessFactor = vSurf.y * (1.0 - 0.42 * uCorpse);`,
  emissive: /* glsl */`
{
  float sTeamOn = step(0.02, vSurf.w);
  vec3 sGlow = mix(vColor.rgb, uTeam, sTeamOn) * vSurf.z * 8.0;
  vec3 sV = normalize(vViewPosition + vec3(0.0, 0.0, 1e-5));
  float sFacing = clamp(dot(normalize(normal), sV), 0.0, 1.0);
  float sRim = pow(1.0 - sFacing, 4.0) * uRim;
  // las superficies de equipo nunca caen a negro: de noche y a 40 m el
  // color del equipo sigue leyéndose (piso de autoiluminación tenue)
  float sSelf = sTeamOn * mix(0.07, 0.15, step(0.75, vSurf.w));
  totalEmissiveRadiance += (sGlow + uTeam * (sRim + sSelf)) * (1.0 - uCorpse);
}`,
};

const MATERIALS = new Map();
function makeMaterial(team, corpse) {
  const material = new THREE.MeshStandardMaterial({ name: 'soldier look', vertexColors: true, roughness: 1, metalness: 1 });
  const uniforms = {
    uTeam: { value: new THREE.Color(SOLDIER_TEAM[team] ?? SOLDIER_TEAM.red) },
    uCorpse: { value: 0 },
    uRim: { value: 0.5 },
  };
  patch(material, { ...SHADER, uniforms, key: 'soldier-v1' });
  material.userData.soldierLook = team;
  material.userData.soldierUniforms = uniforms;
  if (!corpse) material.userData.shared = true;
  return material;
}
// Un material por equipo, compartido por todos los rigs vivos.
export function soldierMaterial(team) {
  if (!MATERIALS.has(team)) MATERIALS.set(team, makeMaterial(team, false));
  return MATERIALS.get(team);
}
// Copia propia de un cadáver (su desaturación es por rig). Mismo programa.
export function soldierCorpseMaterial(source) {
  return makeMaterial(source.userData.soldierLook, true);
}

// Contorno de la protección de spawn: la misma geometría y el mismo
// esqueleto, empujada por la normal y dibujada por la cara trasera.
export function soldierOutlineMaterial(color) {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: true, opacity: 0.45 });
  return patch(material, { vertex: 'transformed += normal * 0.028;', key: 'soldier-outline' });
}

// ---------- fusión ----------
function localMatrix(mesh, stop, out) {
  out.identity();
  for (let n = mesh; n && n !== stop; n = n.parent) {
    n.updateMatrix();
    out.premultiply(n.matrix);
  }
  return out;
}

// sources: [{ mesh, matrix, bone }]. Devuelve BufferGeometry no indexada
// por grupo de material: posición, normal, color, aSurf, aDetail (+ skin).
const c8 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
function mergeSources(sources, rig, skinned) {
  const parts = [];
  let total = 0;
  for (const s of sources) {
    const g = s.mesh.geometry;
    const pos = g.attributes.position;
    if (!pos) continue;
    let normal = g.attributes.normal;
    if (!normal) { const c = g.clone(); c.computeVertexNormals(); normal = c.attributes.normal; }
    const index = g.index;
    const mats = Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material];
    const groups = Array.isArray(s.mesh.material) && g.groups.length
      ? g.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    for (const grp of groups) {
      const material = mats[grp.materialIndex ?? 0];
      if (!material || material.visible === false) continue;
      const count = Math.min(grp.count, (index ? index.count : pos.count) - grp.start);
      parts.push({ s, pos, normal, index, start: grp.start, count, surf: surfaceFor(material, s.mesh, rig) });
      total += count;
    }
  }
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), C = new Uint8Array(total * 3);
  const S = new Uint8Array(total * 4), D = new Uint8Array(total * 2);
  const SI = skinned ? new Uint8Array(total * 4) : null, SW = skinned ? new Uint8Array(total * 4) : null;
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  let o = 0;
  for (const part of parts) {
    const { s, pos, normal, index, surf } = part;
    nm.getNormalMatrix(s.matrix);
    // semilla estable por pieza: las costuras no se alinean entre piezas
    const seed = (part.s.order * 37 + 11) % 251;
    const flip = s.matrix.determinant() < 0;
    for (let k = 0; k < part.count; k++) {
      // escala negativa invierte el orden: se restaura para no voltear caras
      const kk = flip ? (k - (k % 3)) + (2 - (k % 3)) : k;
      const i = index ? index.getX(part.start + kk) : part.start + kk;
      v.fromBufferAttribute(pos, i).applyMatrix4(s.matrix);
      P[o * 3] = v.x; P[o * 3 + 1] = v.y; P[o * 3 + 2] = v.z;
      v.fromBufferAttribute(normal, i).applyMatrix3(nm).normalize();
      N[o * 3] = v.x; N[o * 3 + 1] = v.y; N[o * 3 + 2] = v.z;
      C[o * 3] = c8(surf.color.r); C[o * 3 + 1] = c8(surf.color.g); C[o * 3 + 2] = c8(surf.color.b);
      S[o * 4] = Math.round(Math.min(1, surf.rough) * 255);
      S[o * 4 + 1] = Math.round(Math.min(1, surf.metal) * 255);
      S[o * 4 + 2] = Math.round(Math.min(1, surf.glow / 8) * 255);
      S[o * 4 + 3] = Math.round(surf.team * 255);
      D[o * 2] = surf.kind; D[o * 2 + 1] = seed;
      if (skinned) { SI[o * 4] = s.bone; SW[o * 4] = 255; }
      o++;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(C, 3, true));
  geometry.setAttribute('aSurf', new THREE.BufferAttribute(S, 4, true));
  geometry.setAttribute('aDetail', new THREE.BufferAttribute(D, 2, true));
  if (skinned) {
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4, true));
  }
  geometry.computeBoundingSphere();
  geometry.userData.shared = true; // cacheada: ningún rig la libera
  return geometry;
}

// Esqueleto cuyos huesos son las piezas del rig. Una pieza oculta (muerte
// por cohete, headshot de sniper, escopeta) colapsa sus vértices: el cuerpo
// fusionado respeta las mismas banderas `visible` que antes veía cada mesh.
class RigSkeleton extends THREE.Skeleton {
  constructor(bones, stop) {
    super(bones, bones.map(() => new THREE.Matrix4()));
    this.stop = stop;
  }
  update() {
    super.update();
    const bones = this.bones, m = this.boneMatrices;
    for (let i = 0; i < bones.length; i++) {
      for (let n = bones[i]; n && n !== this.stop; n = n.parent) {
        if (!n.visible) { m.fill(0, i * 16, i * 16 + 16); break; }
      }
    }
  }
}

const visibleBelow = (node, stop) => {
  for (let n = node; n && n !== stop; n = n.parent) if (!n.visible) return false;
  return true;
};
const disposeSource = (mesh) => {
  mesh.removeFromParent();
  if (mesh.geometry && !mesh.geometry.userData.shared) mesh.geometry.dispose();
};

const BODY_CACHE = new Map(), GUN_CACHE = new Map();
const BODY_SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.6);

/** Fusiona el cuerpo del rig. Reemplaza meshes, nunca toca la jerarquía. */
export function bakeSoldierBody(rig) {
  const old = rig._bodyMesh;
  const protectedState = rig._prot;
  const skip = new Set([rig.gunMount, rig.backMount, rig.holsterMount, rig.nameTag, old, ...(rig._outlines ?? [])]);
  const meshes = [];
  const visit = (node) => {
    if (skip.has(node)) return;
    if (node.isMesh) meshes.push(node);
    for (const child of node.children) visit(child);
  };
  for (const child of rig.root.children) visit(child);
  const sources = [], bones = [], boneIndex = new Map();
  for (const mesh of meshes) {
    if (!visibleBelow(mesh, rig.root)) continue;
    const bone = mesh.parent;
    if (!boneIndex.has(bone)) { boneIndex.set(bone, bones.length); bones.push(bone); }
    sources.push({ mesh, bone: boneIndex.get(bone), matrix: localMatrix(mesh, bone, new THREE.Matrix4()), order: sources.length });
  }
  // sin piezas nuevas: el cuerpo ya fusionado sigue siendo el válido
  if (!sources.length && old) return old;
  if (old) { old.removeFromParent(); old.skeleton?.dispose(); rig._bodyMesh = null; }
  if (rig._outlines) {
    for (const o of rig._outlines) o.removeFromParent();
    rig._outlineMat?.dispose();
    rig._outlines = null;
  }
  const key = `${rig.blenderSoldier ? 'b' : 'p'}:${rig.variant}`;
  const signature = sources.map((s) => `${s.bone}:${s.mesh.geometry.attributes.position?.count}`).join(',');
  let cached = BODY_CACHE.get(key);
  if (!cached || cached.signature !== signature) {
    cached = { signature, geometry: mergeSources(sources, rig, true) };
    if (!BODY_CACHE.has(key)) BODY_CACHE.set(key, cached);
  }
  for (const mesh of meshes) disposeSource(mesh);
  const body = new THREE.SkinnedMesh(cached.geometry, soldierMaterial(rig.team));
  body.name = 'soldier-body';
  body.userData.blenderSoldier = !!rig.blenderSoldier;
  body.userData.soldierBody = true;
  body.castShadow = body.receiveShadow = true;
  body.bind(new RigSkeleton(bones, rig.root), IDENTITY);
  // la pose cambia (ragdoll, dive): esfera fija holgada en vez de la del bind
  body.boundingSphere = BODY_SPHERE.clone();
  rig.root.add(body);
  rig._bodyMesh = body;
  if (protectedState) { rig._prot = undefined; rig.setProtected(true); }
  return body;
}

/** Fusiona el modelo visible de un arma en un Mesh hijo del arma. */
export function bakeSoldierGun(rig, gun, key) {
  const old = gun.userData.bakedMesh;
  const meshes = [];
  gun.traverse((o) => { if (o.isMesh && o !== old) meshes.push(o); });
  const sources = [];
  for (const mesh of meshes) {
    if (!visibleBelow(mesh, gun)) continue;
    sources.push({ mesh, bone: 0, matrix: localMatrix(mesh, gun, new THREE.Matrix4()), order: sources.length });
  }
  // Nada nuevo que fusionar (p. ej. frag/stun sin plantilla GLB): el modelo
  // ya fusionado se queda. Nunca se desmonta nada sin tener reemplazo.
  if (!sources.length) return old ?? null;
  if (old) { old.removeFromParent(); gun.userData.bakedMesh = null; }
  const cacheKey = `${key}:${gun.userData.blenderVisual ? 'b' : 'p'}`;
  const signature = sources.map((s) => s.mesh.geometry.attributes.position?.count).join(',');
  let cached = GUN_CACHE.get(cacheKey);
  if (!cached || cached.signature !== signature) {
    cached = { signature, geometry: mergeSources(sources, null, false) };
    if (!GUN_CACHE.has(cacheKey)) GUN_CACHE.set(cacheKey, cached);
  }
  for (const mesh of meshes) disposeSource(mesh);
  const baked = new THREE.Mesh(cached.geometry, soldierMaterial(rig.team));
  baked.name = 'soldier-weapon';
  baked.receiveShadow = true;
  baked.castShadow = gun.parent === rig.gunMount;
  gun.add(baked);
  gun.userData.bakedMesh = baked;
  return baked;
}
