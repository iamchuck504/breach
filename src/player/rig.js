// Personaje 100% procedural: proporciones compactas estilo Ratchet & Clank
// (torso grande, piernas cortas, antebrazos/manos grandes, silueta clara).
//
// Sujeción del arma: el arma vive en un "gunMount" (hijo del aimRig, a la
// altura del pecho). Cada estado define la POSTURA del mount (moderada en
// hipfire/blindfire, pronunciada en ADS, vertical en cover, baja en roadie)
// y las manos se colocan sobre las anclas del arma (grip / forend) con IK
// analítico de dos huesos — ambas manos siempre en contacto, sin poses
// robóticas. El pitch de la cámara inclina el aimRig completo (brazos+arma).
import * as THREE from 'three';
import { attachBlenderSoldier, attachBlenderWeapon, blenderSoldierEnabled } from './blender-soldier.js';
import { bakeSoldierBody, bakeSoldierGun, soldierCorpseMaterial, soldierOutlineMaterial, SOLDIER_TEAM } from './soldier-bake.js';
import { TUNING } from '../config/tuning.js';
import { coverAimPose, coverBlindPose } from '../combat/cover-fire.js';
import { isSniperHeadshotDeath, rocketDeathLevel } from '../combat/death-reactions.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const monotonicSeconds = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;

function extrudedPlate(points, bevel = 0.065) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: bevel,
    bevelThickness: bevel,
  });
  geometry.center();
  return geometry;
}

// Prisma definido por el perfil lateral (z/y). Permite que culatas,
// receptores y cargadores tengan una silueta reconocible sin subir demasiado
// el conteo de polígonos ni depender de assets externos por arma.
function extrudedProfile(points, bevel = 0.045) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1, steps: 1, bevelEnabled: true, bevelSegments: 1,
    bevelSize: bevel, bevelThickness: bevel,
  });
  geometry.center();
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

const TEAM_COLORS = { red: 0xd94f3f, blue: 0x4f8de0 };
// Paleta Vanguard V2: grafito profundo + placas gunmetal. El color de equipo
// funciona como identificación luminosa, no como una masa de plástico rojo/azul.
const DARK = 0x171b20;
const MID = 0x343e48;
const PLATE = 0x596774;
const METAL = 0x7d8991;
const RUBBER = 0x0d1014;
const COPPER = 0x895b3c;
const VISOR = 0x07090c;

// Primitivas y materiales compartidos por TODOS los rigs. Antes cada pieza de
// cada personaje creaba su propio geometry/material: mucha memoria, uploads y
// compilaciones repetidas para objetos visualmente idénticos.
// Un solo segmento de bisel mantiene el perfil redondeado/chunky y evita gastar
// polígonos en superficies pequeñas que nunca ocupan muchos píxeles en pantalla.
const BOX_GEO = new RoundedBoxGeometry(1, 1, 1, 1, 0.12);
// Las masas principales usan un bisel adicional; las piezas pequeñas siguen
// usando BOX_GEO para que el detalle no se convierta en geometría desperdiciada.
const ARMOR_GEO = new RoundedBoxGeometry(1, 1, 1, 2, 0.16);
// Siluetas nuevas de Vanguard V3. Ya no son cajas disfrazadas: cada placa
// tiene un contorno propio y bisel PBR, aunque el esqueleto siga siendo igual.
const CHEST_GEO = extrudedPlate([[-0.34, -0.5], [0.34, -0.5], [0.5, 0.5], [-0.5, 0.5]]);
const SHIELD_GEO = extrudedPlate([[-0.46, 0.5], [0.46, 0.5], [0.38, -0.18], [0, -0.5], [-0.38, -0.18]]);
const PAULDRON_GEO = extrudedPlate([
  [-0.42, 0.34], [-0.5, -0.08], [-0.3, -0.5], [0.3, -0.46],
  [0.5, -0.08], [0.42, 0.34], [0.2, 0.5], [-0.2, 0.5],
]);
const LIMB_GEO = extrudedPlate([[-0.38, 0.5], [0.38, 0.5], [0.5, -0.5], [-0.5, -0.5]], 0.05);
const GUN_RECEIVER_GEO = extrudedProfile([
  [-0.5, 0.28], [0.33, 0.28], [0.5, 0.08], [0.4, -0.28], [-0.43, -0.28],
]);
const GUN_STOCK_GEO = extrudedProfile([
  [-0.5, 0.28], [0.25, 0.22], [0.5, -0.05], [0.35, -0.34], [-0.48, -0.24],
]);
const GUN_MAG_GEO = extrudedProfile([
  [-0.42, 0.5], [0.42, 0.42], [0.5, -0.44], [-0.24, -0.5], [-0.5, -0.18],
], 0.035);
const BALL_GEO = new THREE.SphereGeometry(1, 14, 10);
const CAPSULE_GEO = new THREE.CapsuleGeometry(0.25, 0.5, 4, 8);
const CYLINDER_GEO = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const GRENADE_RING_GEO = new THREE.TorusGeometry(0.035, 0.007, 5, 12);
for (const g of [
  BOX_GEO, ARMOR_GEO, CHEST_GEO, SHIELD_GEO, PAULDRON_GEO, LIMB_GEO,
  GUN_RECEIVER_GEO, GUN_STOCK_GEO, GUN_MAG_GEO,
  BALL_GEO, CAPSULE_GEO, CYLINDER_GEO, GRENADE_RING_GEO,
]) g.userData.shared = true;

// Seis pasos suaves: conserva el sombreado estilizado, pero recupera el detalle
// de las placas oscuras y sus biseles en lugar de aplastarlos casi a negro.
const TOON_GRADIENT = new THREE.DataTexture(new Uint8Array([
  88, 88, 88, 255,
  118, 118, 118, 255,
  150, 150, 150, 255,
  184, 184, 184, 255,
  220, 220, 220, 255,
  255, 255, 255, 255,
]), 6, 1, THREE.RGBAFormat);
TOON_GRADIENT.minFilter = TOON_GRADIENT.magFilter = THREE.NearestFilter;
TOON_GRADIENT.needsUpdate = true;
TOON_GRADIENT.userData.cached = true;

const MATERIALS = new Map();
function toonMaterial(color) {
  let mat = MATERIALS.get(color);
  if (!mat) {
    mat = new THREE.MeshToonMaterial({ color, gradientMap: TOON_GRADIENT });
    mat.userData.shared = true;
    MATERIALS.set(color, mat);
  }
  return mat;
}

const PLATED_MATERIALS = new Map();
function platedMaterial(color) {
  let mat = PLATED_MATERIALS.get(color);
  if (!mat) {
    const isRubber = color === RUBBER || color === VISOR;
    mat = new THREE.MeshStandardMaterial({
      color,
      roughness: isRubber ? 0.88 : (color === METAL ? 0.34 : 0.55),
      metalness: isRubber ? 0.02 : (color === METAL ? 0.58 : 0.26),
    });
    mat.userData.shared = true;
    PLATED_MATERIALS.set(color, mat);
  }
  return mat;
}

// Los visores no crean luces reales: MeshBasicMaterial les da lectura nocturna
// a coste constante y todos los rigs comparten únicamente dos materiales.
const GLOW_MATERIALS = new Map();
function glowMaterial(color) {
  let mat = GLOW_MATERIALS.get(color);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    mat.userData.shared = true;
    GLOW_MATERIALS.set(color, mat);
  }
  return mat;
}

// Vanguard: cinco armaduras sobre EXACTAMENTE el mismo cuerpo, rig e hitbox.
// La identidad de clase vive en accesorios desmontables (casco, peto, mochila,
// hombreras y faldón), nunca en la escala de huesos o extremidades.
// Radio exclusivo del cadáver: la armadura bulky ocupa más que el círculo de
// gameplay del jugador vivo. El callback acepta un radio menor para el probe
// de torso usado mientras el cuerpo cae.
export const RAGDOLL_R = 0.58;

const L1 = 0.28, L2 = 0.36; // largo húmero / antebrazo (pivotes)

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(BOX_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = true;
  return m;
}
function armorBox(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(ARMOR_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = true;
  return m;
}
function gunBox(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(ARMOR_GEO, platedMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = true;
  return m;
}
function gunProfile(geometry, w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, platedMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = true;
  return m;
}
function armorPlate(geometry, w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, platedMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = true;
  return m;
}
function ball(r, color, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(BALL_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(r * sx, r * sy, r * sz);
  m.castShadow = true;
  return m;
}
function capsule(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(CAPSULE_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w / 0.5, h, d / 0.5);
  m.castShadow = true;
  return m;
}
function tube(r, len, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(CYLINDER_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(r * 2, len, r * 2);
  m.rotation.x = Math.PI / 2;
  m.castShadow = true;
  return m;
}
function gunTube(r, len, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(CYLINDER_GEO, platedMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(r * 2, len, r * 2);
  m.rotation.x = Math.PI / 2;
  m.castShadow = true;
  return m;
}
function rod(r, len, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(CYLINDER_GEO, toonMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(r * 2, len, r * 2);
  m.castShadow = true;
  return m;
}
function glowBox(w, h, d, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(BOX_GEO, glowMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  return m;
}
function glowTube(r, len, color, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(CYLINDER_GEO, glowMaterial(color));
  m.position.set(x, y, z);
  m.scale.set(r * 2, len, r * 2);
  m.rotation.x = Math.PI / 2;
  return m;
}
function anchor(parent, x, y, z) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

// Fusiona únicamente meshes hermanos e inmóviles que usan el mismo material.
// Huesos, anclas, armas y grupos animados conservan su jerarquía intacta.
function mergeDirectMeshes(group) {
  const batches = new Map();
  for (const child of [...group.children]) {
    if (!child.isMesh) continue;
    let materialBatches = batches.get(child.material);
    if (!materialBatches) batches.set(child.material, materialBatches = new Map());
    const geometry = child.geometry;
    const signature = `${geometry.index ? 'indexed' : 'plain'}|${Object.keys(geometry.attributes)
      .sort()
      .map((name) => {
        const a = geometry.attributes[name];
        return `${name}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}`;
      }).join(',')}`;
    let batch = materialBatches.get(signature);
    if (!batch) materialBatches.set(signature, batch = []);
    batch.push(child);
  }
  for (const [material, materialBatches] of batches) {
    for (const meshes of materialBatches.values()) {
      if (meshes.length < 2) continue;
      const sources = meshes.map((mesh) => {
        mesh.updateMatrix();
        return mesh.geometry.clone().applyMatrix4(mesh.matrix);
      });
      const geometry = mergeGeometries(sources, false);
      for (const source of sources) source.dispose();
      if (!geometry) continue;
      const merged = new THREE.Mesh(geometry, material);
      merged.castShadow = meshes.some((mesh) => mesh.castShadow);
      for (const mesh of meshes) group.remove(mesh);
      group.add(merged);
    }
  }
}

// METRALLETA: PDW compacto con receptor escalonado, guardamanos ventilado,
// cargador curvo y culata esqueletizada. La silueta queda corta/vertical.
export function buildSMG(teamColor) {
  const g = new THREE.Group();
  g.add(gunProfile(GUN_RECEIVER_GEO, 0.15, 0.19, 0.36, DARK, 0, 0.015, -0.07));
  g.add(gunBox(0.13, 0.075, 0.31, MID, 0, 0.085, -0.1));
  g.add(gunBox(0.14, 0.12, 0.23, PLATE, 0, 0.01, -0.31));       // guardamanos
  for (const x of [-0.073, 0.073]) for (const z of [-0.37, -0.3, -0.23]) {
    g.add(gunBox(0.012, 0.045, 0.035, RUBBER, x, 0.025, z));    // respiraderos laterales
  }
  g.add(gunTube(0.027, 0.17, METAL, 0, 0.025, -0.5));
  g.add(gunTube(0.052, 0.085, DARK, 0, 0.025, -0.625));
  g.add(gunBox(0.105, 0.025, 0.34, METAL, 0, 0.145, -0.12));   // riel
  g.add(gunBox(0.07, 0.065, 0.045, MID, 0, 0.17, -0.34));
  g.add(glowBox(0.018, 0.022, 0.016, teamColor, 0, 0.205, -0.36));
  const mag = gunProfile(GUN_MAG_GEO, 0.09, 0.24, 0.12, MID, 0, -0.19, -0.015);
  mag.rotation.x = -0.18;
  g.add(mag);
  g.add(gunBox(0.095, 0.045, 0.115, RUBBER, 0, -0.315, 0.02));
  const grip = gunProfile(GUN_MAG_GEO, 0.075, 0.16, 0.085, RUBBER, 0, -0.11, 0.105);
  grip.rotation.x = -0.22;
  g.add(grip);
  g.add(gunBox(0.075, 0.04, 0.1, DARK, 0, -0.07, 0.015));      // guardamonte
  for (const x of [-0.045, 0.045]) g.add(gunBox(0.018, 0.025, 0.29, METAL, x, 0.035, 0.25));
  g.add(gunBox(0.12, 0.16, 0.055, RUBBER, 0, 0.015, 0.41));    // cantonera
  g.add(gunBox(0.012, 0.11, 0.18, teamColor, 0.081, 0.02, -0.08));
  g.add(glowBox(0.014, 0.03, 0.09, teamColor, 0.09, 0.02, -0.09));
  g.userData.muzzle = anchor(g, 0, 0.025, -0.67);
  g.userData.grip = anchor(g, 0, -0.09, 0.085);
  g.userData.forend = anchor(g, 0, -0.055, -0.28);
  g.userData.mag = anchor(g, 0, -0.29, 0.01);
  return g;
}

// ESCOPETA: pump-action pesada con doble línea cañón/tubo, bomba acanalada,
// receptor de carga visible y culata maciza con cantonera de goma.
export function buildShotgun(teamColor) {
  const g = new THREE.Group();
  g.add(gunProfile(GUN_RECEIVER_GEO, 0.16, 0.2, 0.36, DARK, 0, 0.015, 0.02));
  g.add(gunBox(0.14, 0.08, 0.3, MID, 0, 0.1, -0.015));
  g.add(gunBox(0.012, 0.065, 0.18, COPPER, 0.088, -0.015, 0)); // puerto de carga
  g.add(gunTube(0.034, 0.61, METAL, 0, 0.08, -0.48));
  g.add(gunTube(0.031, 0.55, DARK, 0, -0.015, -0.44));
  g.add(gunTube(0.053, 0.09, RUBBER, 0, 0.08, -0.815));
  g.add(gunBox(0.15, 0.125, 0.23, COPPER, 0, -0.02, -0.38));
  for (const z of [-0.47, -0.425, -0.38, -0.335, -0.29]) {
    g.add(gunBox(0.158, 0.022, 0.018, RUBBER, 0, -0.02, z));
  }
  const stock = gunProfile(GUN_STOCK_GEO, 0.14, 0.2, 0.34, MID, 0, -0.005, 0.34);
  stock.rotation.x = -0.08;
  g.add(stock);
  g.add(gunBox(0.145, 0.2, 0.055, RUBBER, 0, -0.025, 0.53));
  const grip = gunProfile(GUN_MAG_GEO, 0.075, 0.145, 0.08, RUBBER, 0, -0.115, 0.105);
  grip.rotation.x = -0.2;
  g.add(grip);
  g.add(gunBox(0.09, 0.025, 0.48, METAL, 0, 0.16, -0.24));    // banda superior
  g.add(glowBox(0.018, 0.018, 0.018, teamColor, 0, 0.18, -0.68));
  g.add(gunBox(0.012, 0.1, 0.17, teamColor, 0.088, 0.015, 0.03));
  g.userData.muzzle = anchor(g, 0, 0.08, -0.86);
  g.userData.grip = anchor(g, 0, -0.09, 0.09);
  g.userData.forend = anchor(g, 0, -0.02, -0.39);
  g.userData.mag = anchor(g, 0.09, -0.04, -0.01);
  return g;
}

// PISTOLA: corredera facetada, ventana de expulsión, miras independientes,
// guardamonte y grip inclinado. Sigue siendo inequívocamente de una mano.
export function buildPistol(teamColor) {
  const g = new THREE.Group();
  g.add(gunProfile(GUN_RECEIVER_GEO, 0.1, 0.115, 0.29, MID, 0, 0.055, -0.07));
  g.add(gunBox(0.095, 0.045, 0.25, METAL, 0, 0.125, -0.075)); // corredera
  g.add(gunBox(0.012, 0.042, 0.09, DARK, 0.056, 0.128, -0.035));
  g.add(gunTube(0.028, 0.055, RUBBER, 0, 0.067, -0.245));
  g.add(gunBox(0.075, 0.032, 0.03, DARK, 0, 0.17, 0.025));
  g.add(gunBox(0.045, 0.035, 0.025, DARK, 0, 0.17, -0.19));
  g.add(glowBox(0.014, 0.014, 0.012, teamColor, 0, 0.19, -0.202));
  const grip = gunProfile(GUN_MAG_GEO, 0.082, 0.18, 0.1, RUBBER, 0, -0.075, 0.065);
  grip.rotation.x = -0.25;
  g.add(grip);
  g.add(gunBox(0.086, 0.045, 0.1, DARK, 0, -0.02, -0.055));   // guardamonte
  g.add(gunBox(0.012, 0.085, 0.11, teamColor, 0.049, -0.07, 0.07));
  g.add(glowBox(0.012, 0.05, 0.055, teamColor, 0.057, -0.07, 0.065));
  g.add(gunBox(0.09, 0.028, 0.09, METAL, 0, -0.18, 0.085));   // base cargador
  g.userData.muzzle = anchor(g, 0, 0.065, -0.28);
  g.userData.grip = anchor(g, 0, -0.07, 0.055);
  // La pistola permanece de una mano en hip, pero ADS usa este apoyo cercano
  // al grip para una postura estabilizada de dos manos.
  g.userData.aimSupport = anchor(g, -0.045, -0.045, -0.005);
  g.userData.mag = anchor(g, 0, -0.17, 0.085);
  g.userData.oneHand = true;
  return g;
}

// GRANADA DE HUMO: canister táctico con dos tapas, nervios, palanca y anilla.
export function buildGrenade(teamColor) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(CYLINDER_GEO, platedMaterial(MID)));
  const body = g.children[0]; body.scale.set(0.115, 0.19, 0.115); body.castShadow = true;
  g.add(rod(0.061, 0.032, DARK, 0, 0.105, 0));
  g.add(rod(0.058, 0.025, RUBBER, 0, -0.108, 0));
  for (const y of [-0.055, 0.015, 0.075]) g.add(rod(0.061, 0.012, METAL, 0, y, 0));
  g.add(gunBox(0.038, 0.05, 0.038, PLATE, 0, 0.14, 0));
  const lever = gunBox(0.052, 0.022, 0.095, METAL, 0.032, 0.13, 0.02);
  lever.rotation.z = -0.12; g.add(lever);
  const ring = new THREE.Mesh(GRENADE_RING_GEO, platedMaterial(METAL));
  ring.position.set(-0.052, 0.15, 0); ring.rotation.y = Math.PI / 2; ring.castShadow = true; g.add(ring);
  g.add(glowTube(0.061, 0.025, teamColor, 0, -0.045, 0));
  g.userData.muzzle = anchor(g, 0, 0.14, 0);
  g.userData.grip = anchor(g, 0, -0.01, 0.02);
  g.userData.mag = anchor(g, 0, -0.1, 0);
  g.userData.oneHand = true;
  g.userData.thrown = true;
  return g;
}

// FRANCOTIRADOR: receptor angular, cañón flotante, freno perforado, óptica
// completa, bolt handle, cargador y culata con cheek rest.
export function buildSniper(teamColor) {
  const g = new THREE.Group();
  g.add(gunProfile(GUN_RECEIVER_GEO, 0.145, 0.19, 0.46, DARK, 0, 0.015, 0));
  g.add(gunBox(0.12, 0.075, 0.42, MID, 0, 0.105, -0.08));
  g.add(gunBox(0.13, 0.1, 0.3, PLATE, 0, 0.02, -0.37));
  g.add(gunTube(0.028, 0.62, METAL, 0, 0.065, -0.66));
  g.add(gunTube(0.052, 0.13, DARK, 0, 0.065, -1.025));
  for (const x of [-0.055, 0.055]) for (const z of [-1.06, -1.01, -0.96]) {
    g.add(gunBox(0.016, 0.035, 0.025, METAL, x, 0.065, z));
  }
  g.add(gunTube(0.052, 0.34, DARK, 0, 0.225, -0.065));
  g.add(gunTube(0.06, 0.065, RUBBER, 0, 0.225, 0.135));
  g.add(gunTube(0.068, 0.075, MID, 0, 0.225, -0.265));
  g.add(glowTube(0.047, 0.012, teamColor, 0, 0.225, -0.307));
  for (const z of [-0.16, 0.045]) g.add(gunBox(0.055, 0.075, 0.04, METAL, 0, 0.16, z));
  const mag = gunProfile(GUN_MAG_GEO, 0.09, 0.2, 0.12, MID, 0, -0.145, -0.01);
  mag.rotation.x = -0.1; g.add(mag);
  const stock = gunProfile(GUN_STOCK_GEO, 0.135, 0.21, 0.4, MID, 0, -0.005, 0.42);
  g.add(stock);
  g.add(gunBox(0.12, 0.085, 0.23, RUBBER, 0, 0.12, 0.38));    // cheek rest
  g.add(gunBox(0.145, 0.22, 0.055, RUBBER, 0, -0.015, 0.64));
  g.add(gunTube(0.026, 0.07, METAL, -0.09, 0.065, 0.11));     // bolt handle
  g.add(ball(0.035, RUBBER, -0.09, 0.065, 0.16));
  g.add(gunBox(0.012, 0.12, 0.22, teamColor, 0.084, 0.015, 0.03));
  g.userData.muzzle = anchor(g, 0, 0.065, -1.1);
  g.userData.grip = anchor(g, 0, -0.08, 0.14);
  g.userData.forend = anchor(g, 0, -0.045, -0.39);
  g.userData.mag = anchor(g, 0, -0.23, -0.01);
  return g;
}

// BAZOOKA: tubo de lanzamiento escalonado con collares, bloque óptico,
// empuñaduras reales, apoyo de hombro y lectura clara de frente/escape.
export function buildBazooka(teamColor) {
  const g = new THREE.Group();
  g.add(gunTube(0.09, 0.92, DARK, 0, 0.04, -0.07));
  g.add(gunTube(0.112, 0.15, MID, 0, 0.04, -0.58));            // campana frontal
  g.add(gunTube(0.13, 0.055, RUBBER, 0, 0.04, -0.67));
  g.add(gunTube(0.105, 0.14, MID, 0, 0.04, 0.43));             // escape
  g.add(gunTube(0.125, 0.05, METAL, 0, 0.04, 0.515));
  for (const z of [-0.38, -0.16, 0.08, 0.28]) g.add(gunTube(0.098, 0.035, PLATE, 0, 0.04, z));
  g.add(gunBox(0.12, 0.13, 0.25, PLATE, 0, 0.2, -0.08));      // unidad óptica
  g.add(gunBox(0.09, 0.065, 0.13, DARK, 0, 0.29, -0.13));
  g.add(glowBox(0.055, 0.04, 0.018, teamColor, 0, 0.29, -0.205));
  const grip = gunProfile(GUN_MAG_GEO, 0.075, 0.16, 0.085, RUBBER, 0, -0.095, 0.08);
  grip.rotation.x = -0.18; g.add(grip);
  const frontGrip = gunProfile(GUN_MAG_GEO, 0.07, 0.14, 0.075, RUBBER, 0, -0.09, -0.28);
  frontGrip.rotation.x = -0.08; g.add(frontGrip);
  g.add(gunBox(0.14, 0.1, 0.17, RUBBER, 0, -0.02, 0.34));     // hombro
  g.add(gunBox(0.012, 0.13, 0.24, teamColor, 0.105, 0.04, 0.04));
  for (const z of [-0.01, 0.05, 0.11]) g.add(glowBox(0.012, 0.025, 0.025, teamColor, 0.113, 0.04, z));
  g.userData.muzzle = anchor(g, 0, 0.04, -0.71);
  g.userData.grip = anchor(g, 0, -0.075, 0.08);
  g.userData.forend = anchor(g, 0, -0.075, -0.28);
  g.userData.mag = anchor(g, 0, -0.05, 0.16);
  return g;
}

// Registro central de constructores + escalas de presentación (silueta
// legible desde atrás). drops.js y el rig montan modelos desde aquí.
export function buildFrag(teamColor){
  const g=buildGrenade(teamColor);
  g.children[0].material=platedMaterial(0x3f512d);
  g.children[0].scale.set(.16,.17,.16);
  for(const y of [-.055,0,.055])g.add(rod(.084,.016,DARK,0,y,0));
  g.add(glowBox(.025,.025,.022,0xffa52f,0,.14,-.028));
  return g;
}
export function buildStun(teamColor){
  const g=buildPistol(teamColor);
  for(const z of [-.14,-.19,-.24])g.add(glowTube(.035,.016,0x65dfff,0,.067,z));
  g.add(gunBox(.13,.08,.12,DARK,0,.08,-.12));
  for(const x of [-.07,.07])g.add(glowBox(.012,.038,.10,0x65dfff,x,.08,-.12));
  return g;
}
export const WEAPON_BUILDERS = {
  smg: buildSMG, shotgun: buildShotgun, pistol: buildPistol,
  grenade: buildGrenade, frag:buildFrag, stun:buildStun, sniper: buildSniper, bazooka: buildBazooka,
};
export const WEAPON_SCALES = {
  smg: [1.24, 1.24, 1.24], shotgun: [1.24, 1.24, 1.24], pistol: [1.22, 1.22, 1.22],
  grenade: [1.16, 1.16, 1.16],frag:[1.16,1.16,1.16],stun:[1.22,1.22,1.22], sniper: [1.18, 1.18, 1.18], bazooka: [1.22, 1.22, 1.22],
};

// El root del arma es funcional: contiene el muzzle que alimenta disparos,
// flash y clearance de cover. La reducción de escala debe vivir únicamente
// en esta capa visual para no desplazar la trayectoria ni los sockets de red.
// En armas de fuego conservamos Z (longitud cañón/culata) y reducimos 20% el
// volumen transversal, que es lo que las hacía verse grandes contra el torso.
// La granada sí admite escala uniforme porque su muzzle es el punto de suelta.
export const EQUIPPED_WEAPON_VISUAL_SCALE = 0.8;

// fwd: el arma avanza hacia la mano (m) hasta que la culata queda en el
// hombro en vez de atravesar pecho y hombrera. blade: el pecho se perfila
// (hombro derecho atrás) como al encarar un arma; el cañón no cambia de eje.
export const ADS_WEAPON_POSES = Object.freeze({
  // ADS no se obtiene acercando la cámara a la espalda. Cada pose desplaza
  // físicamente arma y manos desde el low-ready lateral hacia la línea de
  // visión, manteniendo la cámara sobre el hombro con espacio libre delante.
  pistol:  { damp: 18, center: 0.15, mount: [0.045, 0.10, -0.42], torsoPitch: -0.07, head: 0.30, fwd: 0, blade: 0 },
  smg:     { damp: 16, center: 0.14, mount: [0.10, 0.055, -0.10], torsoPitch: -0.12, head: 0.25, fwd: 0.25, blade: 0.7 },
  shotgun: { damp: 13.5, center: 0.15, mount: [0.11, 0.045, 0.00], torsoPitch: -0.15, head: 0.22, fwd: 0.45, blade: 0.7 },
  sniper:  { damp: 12.5, center: 0.16, mount: [0.12, 0.085, 0.00], torsoPitch: -0.17, head: 0.18, fwd: 0.5, blade: 0.7 },
  bazooka: { damp: 11.5, center: 0.10, mount: [0.17, 0.15, 0.02], torsoPitch: -0.19, head: 0.13, fwd: 0, blade: 0 },
  grenade: { damp: 17, center: 0.12, mount: [0.06, 0.08, -0.38], torsoPitch: -0.09, head: 0.28, fwd: 0, blade: 0 },
});

export function applyEquippedWeaponVisualScale(group, weapon) {
  if (group.userData.equippedVisual) return group.userData.equippedVisual;

  const muzzle = group.userData.muzzle;
  const sx = EQUIPPED_WEAPON_VISUAL_SCALE;
  const sy = EQUIPPED_WEAPON_VISUAL_SCALE;
  const sz = weapon === 'grenade' ? EQUIPPED_WEAPON_VISUAL_SCALE : 1;
  const pivot = muzzle?.position ?? new THREE.Vector3();
  const visual = new THREE.Group();
  visual.name = 'equipped-weapon-visual';

  // Los builders también se usan para pickups. Solo los meshes del modelo
  // montado en el rig se trasladan aquí; las anclas lógicas permanecen fuera.
  for (const child of [...group.children]) {
    if (child.isMesh) visual.add(child);
  }
  visual.scale.set(sx, sy, sz);
  visual.position.set(
    pivot.x * (1 - sx),
    pivot.y * (1 - sy),
    pivot.z * (1 - sz),
  );
  group.add(visual);

  // Grip/forend/mag son sockets exclusivamente visuales del IK. Se mueven
  // con el mesh para que las manos sigan tocando la geometría reducida.
  for (const key of ['grip', 'forend', 'aimSupport', 'mag']) {
    const socket = group.userData[key];
    if (!socket) continue;
    socket.position.set(
      pivot.x + (socket.position.x - pivot.x) * sx,
      pivot.y + (socket.position.y - pivot.y) * sy,
      pivot.z + (socket.position.z - pivot.z) * sz,
    );
  }

  group.userData.equippedVisual = visual;
  group.userData.equippedVisualScale = { x: sx, y: sy, z: sz };
  return visual;
}

// temporales del IK
const IK_S = new THREE.Vector3(), IK_V = new THREE.Vector3(), IK_POLE = new THREE.Vector3();
const IK_N = new THREE.Vector3(), IK_U = new THREE.Vector3();
const IK_X = new THREE.Vector3(), IK_Y = new THREE.Vector3(), IK_Z = new THREE.Vector3();
const IK_T1 = new THREE.Vector3(), IK_T2 = new THREE.Vector3(), IK_H = new THREE.Vector3();
const IK_M = new THREE.Matrix4(), IK_Q = new THREE.Quaternion(), IK_QE = new THREE.Quaternion();
const IK_BQ = new THREE.Quaternion(), IK_E = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const TMP_A = new THREE.Vector3(), TMP_B = new THREE.Vector3();
const BLIND_DIRECTION_Q = new THREE.Quaternion();
const BLIND_EULER = new THREE.Euler();
const BLIND_Q = new THREE.Quaternion(), BLIND_YAW_Q = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
// Blindfire lateral: la pelvis (y con ella las piernas) gira hacia la abertura
// en vez de mirar hacia donde va el tiro. Antes la raíz seguía a la cámara y
// el pecho contrarrotaba 63-80°: rodillas contra el bloque y la cintura
// retorcida. El pecho, los brazos y el arma conservan su pose en mundo.
export const BLIND_PELVIS = Object.freeze({ low: 1.4, high: 1.4 });
// Giro del pecho respecto del tiro (rad) e inclinación del agachado: valores
// de siempre (afinados para la protección); ahora la pelvis lo acompaña.
export const BLIND_CHEST = Object.freeze({ low: 1.40, high: 1.10, lowLean: -0.42 });
// Blindfire por encima: el cuerpo se agacha tras el bloque (cabeza bajo el
// borde) y el brazo derecho alza el arma; la palma izquierda en el borde.
export const BLIND_OVER = Object.freeze({
  drop: 0.26, lean: -0.12, rise: 0.26,
  // palma izquierda apoyada en el borde del bloque (cover bajo de 1,1 m)
  palm: [-0.2, 1.12, -0.44],
});
// Euler (XYZ) de una rotación local del torso que, bajo una pelvis girada
// pelvisYaw, deja al pecho con la orientación (x, y, z) relativa a la raíz.
function torsoUnderPelvis(x, y, z, pelvisYaw, out) {
  BLIND_Q.setFromEuler(BLIND_EULER.set(x, y, z));
  BLIND_YAW_Q.setFromAxisAngle(AXIS_Y, -pelvisYaw).multiply(BLIND_Q);
  return out.setFromQuaternion(BLIND_YAW_Q);
}
const TORSO_E = new THREE.Euler();
const AREF_Q = new THREE.Quaternion(), AREF_D = new THREE.Quaternion(), AREF_E = new THREE.Euler(), AREF_V = new THREE.Vector3();
// Postura de cadera (idle/trote): el pecho se perfila (hombro derecho atrás)
// para que la mano izquierda llegue al arma; el montaje compensa el giro y
// el arma queda exactamente donde estaba (mismo muzzle y eje a pitch 0).
export const HIP_BLADE = 0.8;
// armas guardadas (marco del torso / muslo; ver _placeStowed)
// centro algo a la izquierda: el extremo bajo (derecha) no invade el centro de la pantalla
export const STOW_BACK_X = -0.08, STOW_BACK_Y = 0.42, STOW_BACK_TOP = 0.92, STOW_GAP = 0.004;
export const STOW_HOLSTER = [-0.17, 0.06], STOW_HOLSTER_TILT = 0.2;
const HIP_MOUNT = [0.245, -0.15, -0.40], HIP_YAW = 0.18;
const RAG_P = { x: 0, z: 0 }; // punto mutable para la colisión del cadáver
// RECARGAS POR FASES (reloadT 0→1). Los instantes son los de los sonidos de
// src/fx/audio.js (reload: smg mag_out 0.15 / mag_in 0.62; pistola 0.12 /
// 0.55; sniper bolt_open 0.08 / round_in 0.5; bazooka tube_slide 0.25) y el
// último sonido (rack, slide_release, bolt_close, tube_lock) suena en
// reloadDone, cuando weapons.js da la munición: la mano cierra la acción al
// llegar a 1. La escopeta repite el ciclo por cartucho (reloadT vuelve a 0 en
// cada uno; shellIn suena al cerrarlo, en 1) y bombea al terminar.
// Puntos: nombre de anclaje del arma (grip/forend/mag) o del cuerpo
// ('pouch', marco del torso) + desplazamiento en el marco del arma (sin
// escalar). tilt: [t, giro x (boca abajo −), alabeo z (hacia la izquierda +)].
const RELOAD_POINTS = {
  pouch: [-0.12, 0.14, -0.3],      // portacargadores delante, izquierda del cinturón
  hipPouch: [-0.3, 0.06, -0.08],   // bolsa en la cadera izquierda (cohete)
};
export const RELOAD_GESTURES = Object.freeze({
  smg: {
    tilt: [[0, 0, 0], [0.1, -0.12, 0.38], [0.66, -0.12, 0.38], [0.8, 0, 0.12], [1, 0, 0.12]],
    left: [[0, 'forend'], [0.1, 'mag'], [0.15, 'mag'], [0.27, 'mag', 0, -0.22, 0.05], [0.4, 'pouch'],
      [0.54, 'mag', 0, -0.16, 0], [0.62, 'mag'], [0.68, 'mag'], [0.82, 'grip', -0.07, 0.2, -0.05], [0.93, 'grip', -0.07, 0.2, 0.06], [1, 'grip', -0.07, 0.2, 0.02]],
  },
  pistol: {
    tilt: [[0, 0, 0], [0.1, 0.2, 0.45], [0.6, 0.2, 0.45], [0.75, 0.05, 0.25], [1, 0.05, 0.25]],
    left: [[0, 'aimSupport'], [0.12, 'pouch'], [0.3, 'pouch'], [0.46, 'mag', 0, -0.14, 0], [0.55, 'mag'], [0.62, 'mag'],
      [0.78, 'grip', 0, 0.17, 0.02], [0.93, 'grip', 0, 0.17, 0.1], [1, 'grip', 0, 0.17, 0.04]],
  },
  sniper: {
    tilt: [[0, 0, 0], [0.06, -0.05, 0.3], [0.85, -0.05, 0.3], [1, 0, 0.1]],
    left: [[0, 'forend'], [0.1, 'forend'], [0.24, 'pouch'], [0.4, 'grip', -0.02, 0.24, -0.16], [0.5, 'grip', -0.02, 0.14, -0.14],
      [0.58, 'grip', -0.02, 0.18, -0.16], [0.75, 'forend'], [1, 'forend']],
    // la derecha deja el grip para el cerrojo (lado derecho del cajón)
    right: [[0, 'grip'], [0.05, 'grip', 0.06, 0.12, -0.04], [0.08, 'grip', 0.07, 0.15, 0.06], [0.82, 'grip', 0.07, 0.15, 0.06],
      [0.95, 'grip', 0.06, 0.12, -0.04], [1, 'grip', 0.05, 0.1, -0.04]],
  },
  bazooka: {
    tilt: [[0, 0, 0], [0.12, 0.18, 0.3], [0.85, 0.18, 0.3], [1, 0.05, 0.1]],
    left: [[0, 'forend'], [0.12, 'hipPouch'], [0.2, 'mag', 0, 0.06, 0.3], [0.25, 'mag', 0, 0.06, 0.3], [0.45, 'mag', 0, 0.06, 0.12],
      [0.6, 'mag', -0.08, 0.12, 0.05], [0.9, 'mag', -0.08, 0.12, 0.05], [0.96, 'mag', -0.08, 0.09, 0.05], [1, 'mag', -0.08, 0.12, 0.05]],
  },
  // un cartucho: de la recámara a la cartuchera y vuelta, empuje al cerrar
  shotgun: {
    tilt: [[0, -0.1, 0.5], [1, -0.1, 0.5]],
    left: [[0, 'mag', 0, -0.06, 0], [0.12, 'mag', 0, -0.08, 0.02], [0.38, 'pouch'], [0.62, 'mag', 0, -0.17, 0.04],
      [0.84, 'mag', 0, -0.07, 0.02], [0.94, 'mag', 0, -0.05, 0], [1, 'mag', 0, -0.06, 0]],
  },
});
const THROW_WHIP_YAW = -0.1;
const PUMP_TIME = 0.34; // bombeo tras recargar la escopeta (pump suena 0,08 s después)
// interpolación suave entre fotogramas clave [t, a, b]
const reloadKey = (keys, t) => {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const u = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 1, e = u * u * (3 - 2 * u);
  RELOAD_K[0] = a[1] + (b[1] - a[1]) * e; RELOAD_K[1] = a[2] + (b[2] - a[2]) * e;
  return RELOAD_K;
};
const RELOAD_K = [0, 0];
const PUMP_KEYS = [[0, 'forend'], [1, 'forend', 0, 0, 0.13]]; // giro del pecho al final del latigazo (de frente)
const SWAP_HALF = 0.275; // mitad de SWAP_TIME (src/combat/weapons.js)
const SWAP_FRONT = new THREE.Vector3(0.3, -0.12, -0.3); // inicio del gesto de cambio (aimRig)
// paso del gesto de cambio por fuera del hombro derecho, arma vertical
const SWAP_SIDE = [0.62, -0.1, 0.02, 1.2, 0.9, 0.15];
const clamp01 = (v) => Math.min(1, Math.max(-1, v));

// PIERNAS. La suela real se mide sobre el avatar dibujado (_calibrateLegs):
// el resolvedor supuso durante mucho tiempo una suela a 0,375 m bajo la
// rodilla, pero la bota del modelo Blender llega a 0,449 m y el soldado
// pisaba 9 cm bajo el suelo de pie (30 cm agachado). Valores del avatar
// procedural; la cadera (y con ella torso y cabeza) no se mueve nunca.
const LEG_PROC = Object.freeze({ up: 0.32, ankle: [0, -0.29, 0] });
// (el modelo Blender acorta muslo y tibia: BLENDER_LEG_SCALE en blender-soldier.js)
const legCal = (src) => ({ up: src.up, h: 0.085, pts: Float32Array.of(-0.09, -0.085, -0.21, 0.09, -0.085, -0.21, -0.09, -0.085, 0.065, 0.09, -0.085, 0.065) });
// direcciones (marco del tobillo) en las que se busca el punto más bajo de la bota
const SOLE_DIRS = [];
for (let a = -1.52; a <= 1.521; a += 0.19) for (const r of [-0.3, 0, 0.3]) {
  SOLE_DIRS.push([Math.sin(r), -Math.cos(a) * Math.cos(r), Math.sin(a) * Math.cos(r)]);
}
// límites del tobillo respecto de la tibia (rad): punta arriba / abajo, giro
const ANKLE_UP = 0.9, ANKLE_DOWN = 1.0, ANKLE_ROLL = 0.22, ANKLE_TWIST = 0.3;
const LEG_RATE = 14;          // entrada/salida del apoyo (1/s)
const FLOOR_RATE = 24;        // seguimiento del suelo bajo cada pie (1/s), como la raíz
// temporales del apoyo de piernas
const GL_H = new THREE.Vector3(), GL_A = new THREE.Vector3(), GL_K = new THREE.Vector3();
const GL_T = new THREE.Vector3(), GL_P = new THREE.Vector3(), GL_C = new THREE.Vector3();
const GL_V = new THREE.Vector3(), GL_W = new THREE.Vector3(), GL_F = new THREE.Vector3();
const GL_B1 = new THREE.Vector3(), GL_B2 = new THREE.Vector3(), GL_B3 = new THREE.Vector3();
const GL_A1 = new THREE.Vector3(), GL_A2 = new THREE.Vector3(), GL_A3 = new THREE.Vector3();
const GL_MA = new THREE.Matrix4(), GL_MB = new THREE.Matrix4(), GL_MI = new THREE.Matrix4();
const GL_Q = new THREE.Quaternion(), GL_Q2 = new THREE.Quaternion(), GL_QF = new THREE.Quaternion();
const GL_QK = new THREE.Quaternion(), GL_QP = new THREE.Quaternion(), GL_QC = new THREE.Quaternion();
const GL_E = new THREE.Euler(0, 0, 0, 'YXZ');
// peso de apoyo suavizado (un valor inválido se reinicia al objetivo)
const dampW = (w, key, t, k) => { const v = w[key]; w[key] = v === undefined || !Number.isFinite(v) ? t : v + (t - v) * k; };


export class Rig {
  constructor(scene, team, name = null, variant = 0) {
    this.team = team;
    this.variant = variant = Math.min(4, Math.max(0, variant | 0));
    const tc = TEAM_COLORS[team];

    this.root = new THREE.Group();
    scene.add(this.root);

    // --- jerarquía
    this.hips = new THREE.Group();
    this.hips.position.y = 0.66;
    this.root.add(this.hips);

    this.torso = new THREE.Group();
    this.hips.add(this.torso);
    this.torso.add(box(0.46, 0.15, 0.3, RUBBER, 0, 0.02, 0.015));   // cinturón/pelvis
    this.torso.add(armorPlate(CHEST_GEO, 0.49, 0.3, 0.31, MID, 0, 0.2, 0));
    this.torso.add(armorPlate(LIMB_GEO, 0.35, 0.13, 0.045, PLATE, 0, 0.2, -0.18));
    this.torso.add(box(0.12, 0.09, 0.055, DARK, -0.16, 0.1, -0.18)); // bolsas de cinturón
    this.torso.add(box(0.12, 0.09, 0.055, DARK, 0.16, 0.1, -0.18));
    this.torso.add(box(0.045, 0.025, 0.018, COPPER, -0.16, 0.12, -0.215));
    this.torso.add(box(0.045, 0.025, 0.018, COPPER, 0.16, 0.12, -0.215));
    this.torso.add(armorPlate(CHEST_GEO, 0.68, 0.37, 0.4, DARK, 0, 0.46, 0));
    this.torso.add(armorPlate(CHEST_GEO, 0.57, 0.27, 0.065, MID, 0, 0.47, -0.225));
    this.torso.add(armorPlate(SHIELD_GEO, 0.39, 0.16, 0.04, PLATE, 0, 0.49, -0.275));
    this.torso.add(box(0.52, 0.075, 0.42, MID, 0, 0.635, 0));       // collar común
    this.torso.add(box(0.055, 0.2, 0.04, METAL, -0.24, 0.48, -0.285));
    this.torso.add(box(0.055, 0.2, 0.04, METAL, 0.24, 0.48, -0.285));
    this.torso.add(box(0.25, 0.085, 0.035, tc, 0, 0.5, -0.31));    // placa de equipo
    this.torso.add(glowBox(0.13, 0.022, 0.02, tc, 0, 0.5, -0.333));
    this.torso.add(box(0.3, 0.045, 0.025, VISOR, 0, 0.405, -0.31)); // respiradero

    // La cámara jugable ve principalmente la espalda: placa dorsal en capas,
    // columna de energía y cierres del cinturón bajo el arma secundaria.
    this.torso.add(armorBox(0.46, 0.24, 0.055, MID, 0, 0.46, 0.225));
    this.torso.add(armorBox(0.31, 0.13, 0.035, DARK, 0, 0.47, 0.265));
    this.torso.add(box(0.07, 0.16, 0.025, PLATE, 0, 0.47, 0.293));
    this.torso.add(glowBox(0.025, 0.12, 0.018, tc, 0, 0.47, 0.312));
    this.torso.add(box(0.11, 0.075, 0.05, DARK, -0.18, 0.16, 0.185));
    this.torso.add(box(0.11, 0.075, 0.05, DARK, 0.18, 0.16, 0.185));
    this.torso.add(box(0.055, 0.025, 0.018, tc, -0.18, 0.17, 0.22));
    this.torso.add(box(0.055, 0.025, 0.018, tc, 0.18, 0.17, 0.22));

    this.head = new THREE.Group();
    this.head.position.set(0, 0.66, 0);
    this.torso.add(this.head);
    this._buildHead(tc, variant);

    // aimRig: pivote a la altura del pecho; contiene brazos + arma para
    // inclinar todo el conjunto con el pitch de la cámara.
    this.aimRig = new THREE.Group();
    this.aimRig.position.set(0, 0.5, 0);
    this.torso.add(this.aimRig);

    const mkArm = (side) => {
      const s = side === 'L' ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.name = `shoulder-${side}`;
      shoulder.position.set(s * 0.36, 0, 0);
      this.aimRig.add(shoulder);
      // Toda la hombrera pertenece al pivote del brazo. Así acompaña el gesto
      // de guardar/sacar el arma en vez de quedarse clavada al torso y cortarlo.
      shoulder.add(ball(0.145, DARK, s * 0.02, 0.04, 0, 1, 1, 1));
      const pauldron = armorPlate(PAULDRON_GEO, 0.36, 0.25, 0.34, tc, s * 0.04, 0.08, -0.015);
      pauldron.name = `pauldron-${side}`;
      pauldron.rotation.z = s * 0.09;
      shoulder.add(pauldron);
      shoulder.add(armorPlate(LIMB_GEO, 0.24, 0.06, 0.2, DARK, s * 0.04, 0.14, -0.025));
      shoulder.add(box(0.16, 0.035, 0.035, PLATE, s * 0.02, 0.08, -0.155));
      shoulder.add(glowBox(0.105, 0.018, 0.02, tc, s * 0.02, 0.08, -0.18));
      shoulder.add(capsule(0.15, 0.28, 0.15, MID, 0, -0.14, 0));    // bíceps común
      shoulder.add(box(0.11, 0.18, 0.035, PLATE, 0, -0.14, -0.09));
      const elbow = new THREE.Group();
      elbow.position.set(0, -L1, 0);
      shoulder.add(elbow);
      elbow.add(armorPlate(LIMB_GEO, 0.19, 0.33, 0.18, DARK, 0, -0.16, 0));
      elbow.add(armorPlate(LIMB_GEO, 0.13, 0.21, 0.035, MID, 0, -0.14, -0.105));
      elbow.add(armorPlate(LIMB_GEO, 0.11, 0.15, 0.028, tc, 0, -0.14, -0.13));
      elbow.add(glowBox(0.055, 0.018, 0.018, tc, 0, -0.14, -0.151));
      const hand = new THREE.Group();
      hand.position.set(0, -L2, 0);
      elbow.add(hand);
      hand.add(ball(0.115, RUBBER, 0, -0.01, 0, 1.05, 0.9, 1.05));// mano común
      return { shoulder, elbow, hand };
    };
    this.armL = mkArm('L');
    this.armR = mkArm('R');

    const mkLeg = (side) => {
      const s = side === 'L' ? -1 : 1;
      const hip = new THREE.Group();
      hip.position.set(s * 0.15, 0.02, 0);
      this.hips.add(hip);
      hip.add(capsule(0.21, 0.31, 0.22, MID, 0, -0.155, 0));        // muslo común
      hip.add(armorPlate(LIMB_GEO, 0.145, 0.21, 0.04, PLATE, 0, -0.15, -0.135));
      const knee = new THREE.Group();
      knee.position.set(0, -0.32, 0);
      hip.add(knee);
      knee.add(armorPlate(LIMB_GEO, 0.19, 0.26, 0.2, DARK, 0, -0.12, 0));
      knee.add(armorPlate(LIMB_GEO, 0.135, 0.14, 0.04, MID, 0, -0.15, -0.125));
      knee.add(armorPlate(SHIELD_GEO, 0.16, 0.11, 0.04, tc, 0, -0.04, -0.13));
      knee.add(glowBox(0.075, 0.018, 0.018, tc, 0, -0.04, -0.155));
      // TOBILLO: la bota cuelga de él para apoyarse plana en el suelo aunque
      // la tibia se incline (antes iba rígida con la tibia y se hundía)
      const ankle = new THREE.Group();
      ankle.position.set(LEG_PROC.ankle[0] * s, LEG_PROC.ankle[1], LEG_PROC.ankle[2]);
      knee.add(ankle);
      const ay = -LEG_PROC.ankle[1];
      ankle.add(armorBox(0.23, 0.13, 0.34, DARK, 0, ay - 0.31, -0.075));// bota común
      ankle.add(box(0.19, 0.055, 0.07, MID, 0, ay - 0.29, -0.25));      // puntera reforzada
      ankle.add(box(0.13, 0.04, 0.035, tc, 0, ay - 0.29, -0.29));
      ankle.add(glowBox(0.065, 0.015, 0.018, tc, 0, ay - 0.29, -0.314));
      return { hip, knee, ankle, side: s, cal: legCal(LEG_PROC) };
    };
    this.legL = mkLeg('L');
    this.legR = mkLeg('R');
    this._variantExtras(tc, variant);

    // arma activa montada al pecho (las manos la alcanzan por IK);
    // la primaria guardada va cargada a la ESPALDA en diagonal y la pistola
    // enfundada en la parte baja de la espalda; cada arma se coloca según su propia
    // geometría y la del cuerpo dibujado (_placeStowed)
    this.gunMount = new THREE.Group();
    this.aimRig.add(this.gunMount);
    this.backMount = new THREE.Group();
    this.torso.add(this.backMount);
    this.holsterMount = new THREE.Group();
    this.torso.add(this.holsterMount);
    // Los detalles se conservan, pero quedan agrupados por material dentro de
    // cada pieza animada: menos draw calls sin congelar brazos, piernas o armas.
    for (const group of [
      this.torso, this.head,
      this.armL.shoulder, this.armL.elbow, this.armL.hand,
      this.armR.shoulder, this.armR.elbow, this.armR.hand,
      this.legL.hip, this.legL.knee, this.legR.hip, this.legR.knee,
      this.legL.ankle, this.legR.ankle,
    ]) mergeDirectMeshes(group);
    // Modelos de arma bajo demanda (_gunModel): todos los rigs llevan smg,
    // escopeta y pistola de fábrica; granada/especiales se crean al usarse.
    this._teamHex = tc;
    this.guns = {};
    this._gunModel('smg');
    this._gunModel('shotgun');
    this._gunModel('pistol');
    this._wep = null;
    this._backWep = null;
    this.setWeapon('smg');

    if (name) this._addNameTag(name, tc);
    this._calibrateLegs();
    // Avatar de respaldo (antes de que cargue el GLB) también en una llamada.
    bakeSoldierBody(this);
    // las armas guardadas se colocan sobre el cuerpo YA fusionado (setWeapon
    // corrió antes, sin cuerpo: la escopeta del explorador quedaba 21 cm dentro)
    this._placeStowed();

    this.phase = 0;
    this._recoil = 0;
    this._deadT = 0;
    this._meleeT = 0;
    this._hitReact = null;
    this.rag = null; // estado del ragdoll de muerte
    this.groundFn = null;  // (x,z,y)->alturaSuelo — lo inyecta quien tiene el world
    this.collideFn = null; // (p,y)->muta p fuera de los AABBs (colisión del cadáver)
    this._deathCtx = null; // contexto físico de la muerte (setDeathContext)
    this._corpseVisual = null; // clones de material SOLO mientras este rig está muerto
    this._deathHidden = [];   // piezas ocultas por daño fuerte; se restauran al respawn
    if (blenderSoldierEnabled()) {
      this.visualReady = attachBlenderSoldier(this).catch(error => {
        console.warn('Blender soldier unavailable; keeping original avatar.', error);
        return false;
      });
    }
  }

  // Mismo volumen craneal para las cinco variantes. Todo lo que cambia es
  // casco/equipamiento superpuesto; nunca se escala this.head ni el esqueleto.
  _buildHead(tc, v) {
    const h = this.head;
    h.add(ball(0.12, DARK, 0, -0.015, 0.015, 1, 0.68, 1));        // cuello común
    h.add(ball(0.19, DARK, 0, 0.14, 0, 1.02, 1.02, 1));           // cabeza común

    if (v === 1) {          // CENTINELA: carcasa torre + visor vertical
      h.add(armorBox(0.38, 0.5, 0.38, DARK, 0, 0.23, 0));
      h.add(armorBox(0.3, 0.42, 0.045, MID, 0, 0.23, -0.215));
      h.add(box(0.115, 0.31, 0.025, PLATE, 0, 0.24, -0.245));
      h.add(glowBox(0.038, 0.24, 0.02, tc, 0, 0.24, -0.267));
      h.add(ball(0.065, METAL, -0.22, 0.17, 0, 0.72, 1, 1));
      h.add(ball(0.065, METAL, 0.22, 0.17, 0, 0.72, 1, 1));
      h.add(box(0.24, 0.06, 0.06, RUBBER, 0, -0.015, -0.19));
      h.add(box(0.18, 0.045, 0.21, PLATE, 0, 0.49, 0));
    } else if (v === 2) {   // EXPLORADOR: casco compacto + goggles dobles
      h.add(ball(0.202, MID, 0, 0.14, 0, 1.03, 1.03, 1.02));
      h.add(box(0.1, 0.075, 0.25, PLATE, 0, 0.33, 0));
      h.add(glowBox(0.045, 0.03, 0.06, tc, 0, 0.37, -0.11));
      h.add(tube(0.105, 0.055, RUBBER, -0.105, 0.16, -0.2));
      h.add(tube(0.105, 0.055, RUBBER, 0.105, 0.16, -0.2));
      h.add(glowTube(0.066, 0.025, tc, -0.105, 0.16, -0.24));
      h.add(glowTube(0.066, 0.025, tc, 0.105, 0.16, -0.24));
      h.add(box(0.08, 0.04, 0.04, METAL, 0, 0.16, -0.25));
      h.add(box(0.31, 0.065, 0.075, DARK, 0, 0.015, -0.18));       // pañuelo
      h.add(glowBox(0.12, 0.025, 0.02, tc, 0, 0.015, -0.225));
      h.add(ball(0.055, METAL, -0.205, 0.15, 0, 0.75, 1, 1));
      h.add(ball(0.055, METAL, 0.205, 0.15, 0, 0.75, 1, 1));
    } else if (v === 3) {   // PESADO: casco cerrado; cuerpo interno idéntico
      h.add(ball(0.205, MID, 0, 0.14, 0, 1.06, 1.03, 1.04));
      h.add(armorBox(0.31, 0.13, 0.075, RUBBER, 0, 0.16, -0.205));
      h.add(box(0.25, 0.07, 0.025, VISOR, 0, 0.17, -0.25));
      h.add(glowBox(0.19, 0.025, 0.02, tc, 0, 0.18, -0.275));
      h.add(box(0.09, 0.19, 0.2, DARK, -0.2, 0.12, 0));
      h.add(box(0.09, 0.19, 0.2, DARK, 0.2, 0.12, 0));
      h.add(box(0.055, 0.12, 0.19, PLATE, -0.215, 0.12, -0.015));
      h.add(box(0.055, 0.12, 0.19, PLATE, 0.215, 0.12, -0.015));
      h.add(box(0.22, 0.09, 0.075, RUBBER, 0, 0.015, -0.19));
      h.add(box(0.1, 0.055, 0.22, PLATE, 0, 0.34, 0));
      h.add(glowBox(0.045, 0.02, 0.08, tc, 0, 0.375, -0.06));
    } else if (v === 4) {   // FANTASMA: capucha facetada + respirador
      const hoodL = armorBox(0.18, 0.42, 0.38, DARK, -0.13, 0.18, 0.025);
      const hoodR = armorBox(0.18, 0.42, 0.38, DARK, 0.13, 0.18, 0.025);
      hoodL.rotation.z = -0.16;
      hoodR.rotation.z = 0.16;
      h.add(hoodL, hoodR);
      h.add(box(0.11, 0.16, 0.34, MID, 0, 0.37, 0.015));           // cumbrera
      h.add(box(0.25, 0.09, 0.055, VISOR, 0, 0.18, -0.205));
      h.add(glowBox(0.085, 0.035, 0.02, tc, -0.065, 0.18, -0.24)); // ojos
      h.add(glowBox(0.085, 0.035, 0.02, tc, 0.065, 0.18, -0.24));
      h.add(armorBox(0.18, 0.13, 0.075, RUBBER, 0, 0.055, -0.205));
      h.add(tube(0.055, 0.05, METAL, -0.11, 0.045, -0.22));
      h.add(tube(0.055, 0.05, METAL, 0.11, 0.045, -0.22));
      h.add(box(0.045, 0.08, 0.035, COPPER, 0, 0.04, -0.25));
    } else {                // RECLUTA: casco redondo + visor panorámico
      h.add(ball(0.205, MID, 0, 0.14, 0, 1.04, 1.03, 1.04));
      h.add(armorBox(0.33, 0.17, 0.075, RUBBER, 0, 0.15, -0.205));
      h.add(box(0.28, 0.12, 0.025, VISOR, 0, 0.15, -0.25));
      h.add(glowBox(0.23, 0.075, 0.02, tc, 0, 0.15, -0.275));
      h.add(box(0.085, 0.08, 0.24, PLATE, 0, 0.34, 0));             // cresta
      h.add(glowBox(0.035, 0.025, 0.08, tc, 0, 0.38, -0.06));
      h.add(ball(0.065, METAL, -0.205, 0.15, 0, 0.7, 1, 1));
      h.add(ball(0.065, METAL, 0.205, 0.15, 0, 0.7, 1, 1));
      h.add(box(0.2, 0.065, 0.065, RUBBER, 0, 0.02, -0.19));
    }
  }

  // Accesorios por variante. Las posiciones de huesos y las dimensiones de las
  // piezas anatómicas son idénticas para todas las variantes.
  _variantExtras(tc, v) {
    const t = this.torso;
    if (v === 1) {
      t.add(armorPlate(SHIELD_GEO, 0.4, 0.3, 0.06, PLATE, 0, 0.46, -0.3));
      t.add(box(0.055, 0.25, 0.025, METAL, -0.18, 0.46, -0.34));
      t.add(box(0.055, 0.25, 0.025, METAL, 0.18, 0.46, -0.34));
      t.add(box(0.23, 0.14, 0.025, DARK, 0, 0.47, -0.345));
      t.add(box(0.075, 0.115, 0.02, tc, 0, 0.47, -0.37));
      t.add(glowBox(0.025, 0.085, 0.016, tc, 0, 0.47, -0.388));
      const chevronL = box(0.11, 0.035, 0.02, tc, -0.045, 0.405, -0.372);
      const chevronR = box(0.11, 0.035, 0.02, tc, 0.045, 0.405, -0.372);
      chevronL.rotation.z = -0.55;
      chevronR.rotation.z = 0.55;
      t.add(chevronL, chevronR);
    } else if (v === 2) {
      const strap = box(0.07, 0.45, 0.035, RUBBER, 0, 0.43, -0.315);// correa cruzada
      strap.rotation.z = 0.65;
      t.add(strap);
      t.add(armorBox(0.14, 0.13, 0.05, MID, -0.16, 0.34, -0.34));  // bolsa frontal
      t.add(box(0.085, 0.055, 0.025, tc, -0.16, 0.36, -0.375));
      t.add(box(0.045, 0.02, 0.015, COPPER, -0.16, 0.36, -0.394));
      t.add(box(0.3, 0.34, 0.14, DARK, 0, 0.42, 0.24));            // mochila
      t.add(box(0.1, 0.22, 0.12, PLATE, 0.12, 0.43, 0.33));
      t.add(glowBox(0.04, 0.12, 0.02, tc, 0.12, 0.43, 0.4));
      t.add(rod(0.018, 0.35, METAL, 0.24, 0.76, 0.25));            // antena
      t.add(glowBox(0.045, 0.045, 0.045, tc, 0.24, 0.95, 0.25));
      const scoutPauldron = armorPlate(PAULDRON_GEO, 0.25, 0.14, 0.13, DARK, -0.07, 0.09, -0.03);
      scoutPauldron.rotation.z = -0.12;
      this.armL.shoulder.add(scoutPauldron);
    } else if (v === 3) {
      t.add(armorPlate(CHEST_GEO, 0.59, 0.18, 0.08, PLATE, 0, 0.54, -0.31));
      t.add(armorPlate(SHIELD_GEO, 0.32, 0.19, 0.055, tc, 0, 0.39, -0.335));
      t.add(box(0.19, 0.09, 0.025, DARK, 0, 0.39, -0.372));
      t.add(glowBox(0.12, 0.022, 0.016, tc, 0, 0.39, -0.39));
      const heavyPauldronL = armorPlate(PAULDRON_GEO, 0.44, 0.3, 0.39, tc, -0.07, 0.09, -0.01);
      const heavyPauldronR = armorPlate(PAULDRON_GEO, 0.44, 0.3, 0.39, tc, 0.07, 0.09, -0.01);
      heavyPauldronL.rotation.z = -0.1;
      heavyPauldronR.rotation.z = 0.1;
      this.armL.shoulder.add(heavyPauldronL);
      this.armR.shoulder.add(heavyPauldronR);
      this.armL.shoulder.add(armorPlate(LIMB_GEO, 0.3, 0.075, 0.22, DARK, -0.07, 0.16, -0.04));
      this.armR.shoulder.add(armorPlate(LIMB_GEO, 0.3, 0.075, 0.22, DARK, 0.07, 0.16, -0.04));
      this.armL.shoulder.add(box(0.17, 0.035, 0.025, PLATE, -0.07, 0.09, -0.17));
      this.armR.shoulder.add(box(0.17, 0.035, 0.025, PLATE, 0.07, 0.09, -0.17));
      this.armL.shoulder.add(glowBox(0.1, 0.016, 0.016, tc, -0.07, 0.09, -0.19));
      this.armR.shoulder.add(glowBox(0.1, 0.016, 0.016, tc, 0.07, 0.09, -0.19));
      this.armL.elbow.add(armorPlate(LIMB_GEO, 0.24, 0.3, 0.23, PLATE, 0, -0.16, 0));
      this.armR.elbow.add(armorPlate(LIMB_GEO, 0.24, 0.3, 0.23, PLATE, 0, -0.16, 0));
      this.armL.elbow.add(glowBox(0.1, 0.025, 0.02, tc, 0, -0.14, -0.145));
      this.armR.elbow.add(glowBox(0.1, 0.025, 0.02, tc, 0, -0.14, -0.145));
    } else if (v === 4) {
      t.add(box(0.4, 0.06, 0.05, MID, 0, 0.64, -0.18));            // cuello de capucha
      const skirtL = box(0.2, 0.38, 0.075, DARK, -0.13, -0.12, -0.1);
      const skirtR = box(0.2, 0.38, 0.075, DARK, 0.13, -0.12, -0.1);
      skirtL.rotation.z = -0.06;
      skirtR.rotation.z = 0.06;
      t.add(skirtL, skirtR);
      t.add(box(0.25, 0.045, 0.035, RUBBER, 0, 0.33, -0.35));
      t.add(box(0.16, 0.035, 0.025, tc, 0, 0.33, -0.38));
      t.add(box(0.09, 0.07, 0.025, COPPER, 0, 0.02, -0.18));
      this.armR.shoulder.add(armorPlate(PAULDRON_GEO, 0.18, 0.09, 0.17, PLATE, 0, -0.09, 0));
      this.armR.shoulder.add(glowBox(0.09, 0.022, 0.02, tc, 0, -0.09, -0.095));
    } else {
      t.add(armorPlate(SHIELD_GEO, 0.36, 0.19, 0.055, PLATE, 0, 0.46, -0.32));
      t.add(box(0.17, 0.085, 0.025, tc, 0, 0.47, -0.355));
      t.add(box(0.09, 0.04, 0.018, DARK, 0, 0.47, -0.376));
      t.add(glowBox(0.055, 0.014, 0.014, tc, 0, 0.47, -0.39));
      t.add(box(0.075, 0.065, 0.025, METAL, -0.17, 0.53, -0.355));
      t.add(box(0.075, 0.065, 0.025, METAL, 0.17, 0.53, -0.355));
    }
  }

  // Impulso y pose de desparrame aleatorios para esta muerte.
  // ANCLA la posición de muerte: el cadáver se queda ahí (desliza <40cm),
  // peso muerto — nada de salir volando.
  // La muerte usa CONTEXTO físico: dirección y potencia del impacto final,
  // velocidad y estado previos del personaje. Lo setea quien conoce el tiro
  // (main / botmatch / handler de red) justo antes de matar al rig — la
  // variación entre muertes viene del contexto, no de aleatoriedad pura.
  setDeathContext(ctx) { this._deathCtx = ctx; }

  _prepareCorpseVisual() {
    if (this._corpseVisual) return;
    const excluded = new Set(this._outlines || []);
    const entries = [];
    const visit = (node) => {
      // Las armas caen por separado y el nametag desaparece: ninguno debe
      // contaminar la lectura/material del cuerpo asentado.
      if (node === this.gunMount || node === this.backMount ||
          node === this.nameTag || excluded.has(node)) return;
      if (node.isMesh && node.material) {
        const originals = Array.isArray(node.material) ? node.material : [node.material];
        const clones = originals.map((original) => {
          // Material del soldado: copia con su propio uniform de cadáver
          // (mismo programa); la desaturación la hace el shader.
          if (original.userData.soldierLook) {
            const material = soldierCorpseMaterial(original);
            return { material, corpse: material.userData.soldierUniforms.uCorpse, base: null };
          }
          const material = original.clone();
          material.userData = { ...material.userData, shared: false, corpseClone: true };
          const base = material.color?.clone() ?? null;
          let muted = null;
          if (base) {
            const hsl = {};
            base.getHSL(hsl);
            muted = new THREE.Color().setHSL(
              hsl.h,
              hsl.s * 0.24,
              Math.max(0.025, hsl.l * 0.62),
            );
          }
          return {
            material, base, muted,
            roughness: material.roughness,
            metalness: material.metalness,
          };
        });
        node.material = Array.isArray(node.material)
          ? clones.map((c) => c.material)
          : clones[0].material;
        entries.push({ node, originals, clones });
      }
      for (const child of node.children) visit(child);
    };
    visit(this.root);
    this._corpseVisual = { entries, amount: -1 };
  }

  _updateCorpseVisual(t) {
    this._prepareCorpseVisual();
    // El impacto conserva color un instante; al asentarse, el cuerpo pierde
    // saturación, contraste y el brillo de equipo sin volverse gris artificial.
    const x = Math.min(1, Math.max(0, (t - 0.18) / 0.82));
    const amount = x * x * (3 - 2 * x);
    if (Math.abs(amount - this._corpseVisual.amount) < 0.015) return;
    this._corpseVisual.amount = amount;
    for (const entry of this._corpseVisual.entries) {
      for (const c of entry.clones) {
        if (c.corpse) { c.corpse.value = amount; continue; }
        if (c.base) c.material.color.copy(c.base).lerp(c.muted, amount);
        if (typeof c.roughness === 'number') {
          c.material.roughness = c.roughness + (0.9 - c.roughness) * amount;
        }
        if (typeof c.metalness === 'number') {
          c.material.metalness = c.metalness * (1 - amount * 0.42);
        }
      }
    }
  }

  _hideDeathPart(node) {
    if (!node || this._deathHidden.includes(node)) return;
    node.visible = false;
    this._deathHidden.push(node);
  }

  _applyContextualDamage(ctx, impactSide) {
    const explosiveLevel = rocketDeathLevel(ctx);
    if (explosiveLevel >= 2) {
      // Destrucción total: la física del ragdoll sigue existiendo para
      // mantener estado/cámara, pero la silueta corporal la reemplazan los
      // restos físicos del efecto. El arma caída vive en su pickup separado.
      this._hideDeathPart(this.torso);
      this._hideDeathPart(this.legL.hip);
      this._hideDeathPart(this.legR.hip);
      this._hideDeathPart(this.holsterMount);
      return;
    }
    if (explosiveLevel === 1) {
      // Splash letal cercano: daño parcial ligado al lado de la onda, no la
      // misma destrucción total reservada al impacto directo.
      const blastFromLeft = impactSide >= 0;
      this._hideDeathPart(blastFromLeft ? this.armL.shoulder : this.armR.shoulder);
      this._hideDeathPart(blastFromLeft ? this.legR.knee : this.legL.knee);
      return;
    }
    // El sniper solo entrega este contexto cuando el impacto de cabeza ya fue
    // confirmado como letal (localmente o por el servidor). Ocultar el grupo
    // completo conserva exactamente la misma hitbox/esqueleto del ragdoll,
    // pero elimina casco, visor y cabeza como una sola pieza coherente.
    if (isSniperHeadshotDeath(ctx)) {
      this._hideDeathPart(this.head);
      return;
    }
    const strongShotgun = !!ctx.gib && (!ctx.weapon || ctx.weapon === 'shotgun');
    if (!strongShotgun) return;
    const part = ctx.part === 'head' ? 'head' : 'body';
    const distance = Number.isFinite(ctx.distance) ? ctx.distance : 3;
    const damage = Number.isFinite(ctx.damage) ? ctx.damage : 75;
    if (part === 'head') {
      this._hideDeathPart(this.head);
      return;
    }
    // La balística actual distingue cabeza/cuerpo. Dentro del cuerpo usamos
    // el lado real de entrada del tiro para elegir qué extremidad pierde,
    // manteniendo el resultado estable y relacionado con el impacto.
    const enteringFromLeft = impactSide >= 0;
    this._hideDeathPart(enteringFromLeft ? this.armL.shoulder : this.armR.shoulder);
    // Solo un remate verdaderamente extremo añade una segunda lesión. Una
    // escopeta en el borde de su rango de gib nunca desarma medio cuerpo.
    if (distance <= 1.8 && damage >= 85) {
      this._hideDeathPart(enteringFromLeft ? this.legR.knee : this.legL.knee);
    }
  }

  _restoreDeathVisuals() {
    if (this._corpseVisual) {
      const disposed = new Set();
      for (const entry of this._corpseVisual.entries) {
        entry.node.material = Array.isArray(entry.node.material)
          ? entry.originals
          : entry.originals[0];
        for (const c of entry.clones) {
          if (!disposed.has(c.material)) { disposed.add(c.material); c.material.dispose(); }
        }
      }
      this._corpseVisual = null;
    }
    for (const node of this._deathHidden) node.visible = true;
    this._deathHidden.length = 0;
    if (this.nameTag) this.nameTag.visible = true;
    for (const k in this.guns) this.guns[k].visible = true;
  }

  _startRagdoll() {
    const yaw = this.root.rotation.y;
    const back = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const rnd = (a, b) => a + Math.random() * (b - a);
    const ctx = this._deathCtx || {};
    this._deathCtx = null;
    const vel = ctx.vel || { x: 0, z: 0 };
    const power = Math.min(1, Math.max(0.2, ctx.power ?? 0.4));
    let imp = ctx.impact || null;
    if (imp) {
      const il = Math.hypot(imp.x, imp.z);
      imp = il > 0.01 ? { x: imp.x / il, z: imp.z / il } : null;
    }
    const st = ctx.state || 'idle';
    const inCover = st === 'cover_low' || st === 'cover_high' || st.startsWith('blind_');
    const evading = st === 'dive' || st === 'slide';
    const side = imp ? imp.x * right.x + imp.z * right.z : rnd(-0.5, 0.5);
    const front = imp ? imp.x * back.x + imp.z * back.z : 1;

    if (this.nameTag) this.nameTag.visible = false;
    this.setProtected(false);
    this._prepareCorpseVisual();
    this._applyContextualDamage(ctx, side);

    // impulso inicial: el momentum que TRAÍA + el empuje del arma (potencia y
    // dirección del tiro). Con tope — nadie "sale disparado"; cubierto casi
    // no se desplaza: se desploma en el sitio, contra su cover.
    let vx = vel.x * (evading ? 0.75 : 0.5) + (imp ? imp.x : back.x) * (0.55 + power * 2.1);
    let vz = vel.z * (evading ? 0.75 : 0.5) + (imp ? imp.z : back.z) * (0.55 + power * 2.1);
    if (inCover) {
      // No queda sentado contra la pared como un jugador aún cubierto: pierde
      // el apoyo y resbala tangencialmente antes de terminar tendido.
      const slip = (side >= 0 ? 1 : -1) * (0.48 + power * 0.34);
      vx = vx * 0.18 + right.x * slip;
      vz = vz * 0.18 + right.z * slip;
    }
    const vm = Math.hypot(vx, vz);
    if (vm > 4.2) { vx *= 4.2 / vm; vz *= 4.2 / vm; }

    // dirección del desplome según el contexto: tiro de costado → rueda hacia
    // ese lado; iba lanzado (roadie/evasión) → cae de bruces con su momentum;
    // tiro frontal → se va de espaldas
    const fwdMom = vel.x * -back.x + vel.z * -back.z;
    let axis, angTarget;
    if (Math.abs(side) > Math.abs(front) + 0.25) {
      axis = 'z';
      angTarget = (side > 0 ? -1 : 1) * (Math.PI / 2) * rnd(0.9, 1.05);
    } else if (fwdMom > 3.4 && !inCover) {
      axis = 'x';
      angTarget = -(Math.PI / 2) * rnd(0.9, 1.05);
    } else {
      axis = 'x';
      angTarget = (front >= 0 ? 1 : -1) * (Math.PI / 2) * rnd(0.9, 1.05);
    }
    if (inCover) angTarget *= rnd(0.92, 1.02); // termina tendido, no sentado/crouched

    this.rag = {
      t: 0,
      // El tratamiento visual es PRESENTACIÓN, no física. Mantener un reloj
      // monotónico evita que un hitch o una pestaña ralentizada deje durante
      // varios segundos un cadáver con los colores de un jugador vivo.
      visualStartedAt: monotonicSeconds(),
      // reacción al impacto ANTES de perder el cuerpo: el golpe se "encaja"
      // un instante (más potencia = más encaje) mientras el paso trastabilla
      reactT: 0.09 + power * 0.09,
      impactSide: side, impactFront: front, impactPower: power,
      startHipY: this.hips.position.y,
      bx: this.root.position.x, bz: this.root.position.z, byaw: yaw,
      by: this.root.position.y, vyy: 0, // caída vertical real (muerte en el aire)
      // suelo REAL bajo el cadáver: clavar a y=0 enterraba el cuerpo dentro
      // del bloque si moría parado sobre uno (groundFn lo inyecta quien
      // tiene el world: main / botmatch / addRemote)
      floorY: this.groundFn
        ? this.groundFn(this.root.position.x, this.root.position.z, this.root.position.y)
        : 0,
      ox: 0, oz: 0, oy: 0,
      vx, vz, vy: 0,
      // (el clamp by>=floorY se aplica abajo: morir a mitad de un mantle con
      // el cuerpo ya dentro de la huella del bloque lo dejaba incrustado)
      ang: 0,
      hit: false, flopT: 0, // impacto contra el suelo → flop de extremidades
      // flop contenido: flexible pero con masa (nada de muñeco de goma)
      fl: [rnd(0.12, 0.34), rnd(0.12, 0.34), rnd(0.08, 0.26), rnd(0.08, 0.26), rnd(0.2, 0.42), rnd(0.4, 0.8)],
      axis, angTarget,
      tilt: (imp ? side * 0.3 : rnd(-0.3, 0.3)) + rnd(-0.08, 0.08),
      spin: evading ? rnd(-0.9, 0.9) : imp ? -side * rnd(0.25, 0.5) : rnd(-0.4, 0.4),
      severe: !!ctx.gib || isSniperHeadshotDeath(ctx) || rocketDeathLevel(ctx) > 0,
      pose: [
        rnd(-0.08, 0.16), rnd(-0.22, 0.22), rnd(0.34, 0.66), rnd(-0.58, 0.58),
        rnd(0.08, 0.42), rnd(0.38, 0.72), rnd(0.36, 0.72),
        rnd(0.08, 0.42), rnd(0.38, 0.72), rnd(0.36, 0.72),
        rnd(-0.08, 0.22), rnd(0.25, 0.48), rnd(-0.38, -0.12),
        rnd(-0.04, 0.28), rnd(-0.42, -0.14),
      ],
    };
    if (this.rag.by < this.rag.floorY) this.rag.by = this.rag.floorY;
  }

  _addNameTag(name, tc) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = '600 30px "Geist Mono", monospace';
    g.textAlign = 'center';
    g.fillStyle = '#' + new THREE.Color(tc).getHexString();
    g.fillText(name.slice(0, 14), 128, 42);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(1.5, 0.38, 1);
    sp.position.y = 2.05;
    this.root.add(sp);
    this.nameTag = sp;
  }

  // La etiqueta de un COMPAÑERO se ve a través de las paredes (saber dónde
  // está tu escuadra); la de un ENEMIGO no: dibujarla sin prueba de
  // profundidad delataba su posición detrás de cualquier muro.
  setNameTagThroughWalls(on) {
    if (!this.nameTag) return;
    this.nameTag.material.depthTest = !on;
    this.nameTag.material.needsUpdate = true;
  }

  // construye (y cachea) el modelo de un arma con su merge y escala
  _gunModel(wep) {
    let g = this.guns[wep];
    if (!g) {
      const build = WEAPON_BUILDERS[wep] ?? buildSMG;
      g = build(this._teamHex);
      const visual = applyEquippedWeaponVisualScale(g, wep);
      mergeDirectMeshes(visual);
      const s = WEAPON_SCALES[wep] ?? [1.3, 1.3, 1.3];
      g.scale.set(s[0], s[1], s[2]);
      this.guns[wep] = g;
      attachBlenderWeapon(this,g,wep);
      bakeSoldierGun(this, g, wep);
    }
    return g;
  }

  // backWep: qué arma mostrar cargada a la espalda. null = regla por defecto
  // (la primaria de fábrica que no está en mano); main pasa la real cuando
  // una especial ocupa un slot.
  setWeapon(wep, backWep = null) {
    const back = backWep ?? (wep === 'shotgun' ? 'smg' : 'shotgun');
    if (this._wep === wep && this._backWep === back) return;
    this._wep = wep;
    this._backWep = back;
    const act = this._gunModel(wep);
    // desmontar todo y recolocar: mano, espalda y funda de la cadera
    for (const k in this.guns) {
      const g = this.guns[k];
      if (g.parent) g.parent.remove(g);
    }
    this.gunMount.add(act);
    act.position.set(0, 0, 0);
    act.rotation.set(0, 0, 0);
    if (back && back !== wep) this.backMount.add(this._gunModel(back));
    const pistol = this.guns.pistol;
    if (pistol && !pistol.parent) this.holsterMount.add(pistol);
    this._placeStowed();
    // solo el arma en mano proyecta sombra; las guardadas no la necesitan
    for (const k in this.guns) {
      const baked = this.guns[k].userData.bakedMesh;
      if (baked) baked.castShadow = this.guns[k].parent === this.gunMount;
    }
  }

  // ARMAS GUARDADAS. Antes la de la espalda giraba sobre su propio cañón
  // (rotation z con orden XYZ): en vez de cruzar la espalda se clavaba en la
  // placa dorsal por un extremo, flotaba por el otro y la boca asomaba sobre
  // el casco; la pistola iba boca arriba dentro de la cadera. Ahora:
  //  · espalda: plana contra las placas (el costado del arma hacia el
  //    cuerpo), en diagonal con la boca arriba a la IZQUIERDA (lejos de la
  //    retícula, que queda a la derecha del personaje), por debajo del casco y
  //    separada lo justo del punto más saliente de la espalda bajo su huella;
  //  · pistola: funda horizontal en la parte baja de la espalda (izquierda),
  //    con la empuñadura hacia la mano derecha.
  _placeStowed() {
    const pts = this._stowBodyPoints();
    for (const k in this.guns) {
      const g = this.guns[k];
      if (g.parent === this.backMount) this._stowOnBack(g, pts.back, Math.min(STOW_BACK_TOP, pts.headTop - 0.14));
      else if (g.parent === this.holsterMount) this._stowInHolster(g, pts.back);
    }
  }

  // Caja del arma en su marco local, ya escalada (el modelo visible fusionado).
  _gunBox(g) {
    const m = g.userData.bakedMesh;
    const box = (g.userData._stowBox ??= new THREE.Box3());
    if (m) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.copy(m.geometry.boundingBox);
    } else box.setFromCenterAndSize(TMP_A.set(0, 0, 0), TMP_B.set(0.1, 0.2, 0.8));
    box.min.multiply(g.scale); box.max.multiply(g.scale);
    return box;
  }

  // Puntos de la espalda dibujada (marco del torso, sin cabeza ni brazos).
  // Se recalculan solo cuando cambia el cuerpo fusionado.
  _stowBodyPoints() {
    const body = this._bodyMesh;
    if (this._stowPts && this._stowPts.body === body) return this._stowPts;
    const back = [];
    let headTop = 1.14;
    if (body) {
      this.root.updateMatrixWorld(true);
      const pos = body.geometry.attributes.position, si = body.geometry.attributes.skinIndex;
      const torsoInv = new THREE.Matrix4().copy(this.torso.matrixWorld).invert();
      const rel = body.skeleton.bones.map((b) => {
        for (let n = b; n && n !== this.root; n = n.parent) {
          if (n === this.head) return { head: new THREE.Matrix4().multiplyMatrices(torsoInv, b.matrixWorld) };
          if (n === this.aimRig) return null;
          if (n === this.torso) return new THREE.Matrix4().multiplyMatrices(torsoInv, b.matrixWorld);
        }
        return null;
      });
      headTop = -Infinity;
      for (let i = 0; i < pos.count; i += 2) {
        const m = rel[si.getX(i)];
        if (!m) continue;
        if (m.head) { headTop = Math.max(headTop, GL_V.fromBufferAttribute(pos, i).applyMatrix4(m.head).y); continue; }
        GL_V.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (GL_V.z > 0.12) back.push(GL_V.x, GL_V.y, GL_V.z);
      }
    }
    return (this._stowPts = { body, back, headTop });
  }

  _stowOnBack(g, back, top = STOW_BACK_TOP, out = g) {
    const box = this._gunBox(g);
    const len = box.max.z - box.min.z;
    // inclinación desde la vertical: la boca no pasa de 1,0 m sobre la pelvis
    // (≈1,66 m del suelo) ni de 14 cm bajo lo alto del casco; nunca más
    // vertical que 43°
    const tilt = Math.max(0.75, Math.acos(Math.min(1, (top - STOW_BACK_Y) / (len / 2))));
    const s = Math.sin(tilt), c = Math.cos(tilt);
    // ejes del arma en el torso: +z (culata) abajo-derecha, +y (miras)
    // arriba-derecha, +x (costado derecho) hacia el cuerpo
    this._stowFlat(g, box, back, GL_A1.set(0, 0, -1), GL_A2.set(c, s, 0), GL_A3.set(s, -c, 0), STOW_BACK_X, STOW_BACK_Y, out);
  }

  // Coloca el arma con sus ejes (marco del torso) de modo que el centro de su
  // caja caiga en (x, y) sobre la espalda y su costado quede a STOW_GAP del
  // punto más saliente del cuerpo bajo su huella. El costado derecho del arma
  // (+x) mira al cuerpo (−z).
  _stowFlat(g, box, back, ax, ay, az, x, y, out = g, gap = STOW_GAP) {
    IK_M.makeBasis(ax, ay, az);
    out.quaternion.setFromRotationMatrix(IK_M);
    const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2, cz = (box.min.z + box.max.z) / 2;
    const ox = x - (cx * ax.x + cy * ay.x + cz * az.x);
    const oy = y - (cx * ax.y + cy * ay.y + cz * az.y);
    let maxZ = 0.2;
    for (let i = 0; i < back.length; i += 3) {
      const dx = back[i] - ox, dy = back[i + 1] - oy;
      const gy = dx * ay.x + dy * ay.y, gz = dx * az.x + dy * az.y;
      if (gy < box.min.y - 0.01 || gy > box.max.y + 0.01 || gz < box.min.z - 0.01 || gz > box.max.z + 0.01) continue;
      if (back[i + 2] > maxZ) maxZ = back[i + 2];
    }
    // z en el torso de un punto local del arma = oz − x
    out.position.set(ox, oy, maxZ + box.max.x + gap);
  }

  // Pistola: funda horizontal en la parte baja de la espalda, a la izquierda
  // (empuñadura hacia la mano derecha, boca a la izquierda y algo abajo). En
  // el muslo la atravesaban el brazo y la bota al agacharse en cobertura.
  _stowInHolster(g, back, out = g) {
    const box = this._gunBox(g), a = STOW_HOLSTER_TILT;
    this._stowFlat(g, box, back, GL_A1.set(0, 0, -1), GL_A2.set(-Math.sin(a), Math.cos(a), 0),
      GL_A3.set(Math.cos(a), Math.sin(a), 0), STOW_HOLSTER[0], STOW_HOLSTER[1], out, 0.015);
  }

  // Punto del gesto de recarga en el instante t (marco del aimRig): entre dos
  // fotogramas clave, cada uno un anclaje del arma o del cuerpo + desplazamiento.
  _reloadTarget(gun, keys, t, out) {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
    const u = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 1, e = u * u * (3 - 2 * u);
    this._reloadPoint(gun, a, out);
    this._reloadPoint(gun, b, GL_W);
    return out.lerp(GL_W, e);
  }

  _reloadPoint(gun, key, out) {
    const body = RELOAD_POINTS[key[1]];
    if (body) {
      out.set(body[0], body[1], body[2]);
      this.torso.localToWorld(out);
    } else {
      const sock = gun.userData[key[1]] ?? gun.userData.grip;
      out.copy(sock.position).add(GL_C.set(key[2] ?? 0, key[3] ?? 0, key[4] ?? 0));
      gun.localToWorld(out);
    }
    return this.aimRig.worldToLocal(out);
  }

  // Postura del gunMount (marco del aimRig) que lleva el arma en mano hacia
  // donde va guardada (espalda o funda), hasta donde llega el brazo derecho:
  // el gesto de cambio la deja / la toma de su sitio.
  _swapPose(out) {
    const g = this.activeGun;
    const pts = this._stowBodyPoints();
    const key = g.userData.oneHand ? 'holster' : 'back';
    let c = g.userData._swapStow;
    if (!c || c.body !== pts.body || c.key !== key) {
      c = g.userData._swapStow = { body: pts.body, key, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
      if (key === 'holster') this._stowInHolster(g, pts.back, c);
      else this._stowOnBack(g, pts.back, Math.min(STOW_BACK_TOP, pts.headTop - 0.14), c);
    }
    // del torso al aimRig (el aimRig va sin giro durante el gesto)
    this.root.updateMatrixWorld(true);
    GL_MA.compose(c.position, c.quaternion, GL_V.set(1, 1, 1));
    GL_MB.copy(this.aimRig.matrixWorld).invert().multiply(this.torso.matrixWorld).multiply(GL_MA);
    GL_MB.decompose(GL_T, GL_Q, GL_V);
    // posición al alcance: el grip a menos de un brazo del hombro derecho
    const grip = g.userData.grip.position, sh = this.armR.shoulder.position;
    let f = 1;
    for (let it = 0; it < 8; it++) {
      GL_C.copy(grip).multiply(g.scale).applyQuaternion(GL_Q).add(GL_P.copy(GL_T).multiplyScalar(f)).add(GL_W.copy(SWAP_FRONT).multiplyScalar(1 - f));
      if (GL_C.distanceTo(sh) <= L1 + L2 - 0.05) break;
      f -= 0.1;
    }
    GL_T.multiplyScalar(f).add(GL_W.copy(SWAP_FRONT).multiplyScalar(1 - f));
    return out.setFromQuaternion(GL_Q, 'XYZ');
  }

  get activeGun() { return this.guns[this._wep] ?? this.guns.smg; }

  muzzleWorld(out) {
    this.root.updateWorldMatrix(true, true);
    return this.activeGun.userData.muzzle.getWorldPosition(out);
  }

  gunForward(out) {
    this.root.updateWorldMatrix(true, true);
    const q = IK_Q;
    this.activeGun.userData.muzzle.getWorldQuaternion(q);
    return out.set(0, 0, -1).applyQuaternion(q);
  }

  kick(amount) { this._recoil = Math.min(1.2, this._recoil + amount); }

  // Reacción no letal independiente de la locomoción. Se suma a la pose
  // actual (run/aim/cover), de modo que recibir melee no teletransporta al
  // personaje a una animación genérica ni le roba su estado de gameplay.
  hitReact(direction = 0, strength = 1, kind = 'shot', fromBehind = false) {
    this._hitReact = {
      t: 0,
      dur: kind === 'kick' ? 0.62 : kind === 'melee' ? 0.29 : 0.18,
      back: !!fromBehind,
      side: Math.max(-1, Math.min(1, Number(direction) || 0)),
      strength: Math.max(0.25, Math.min(1.25, Number(strength) || 1)),
      kind,
    };
  }

  // IK analítico de dos huesos en espacio del aimRig. Prueba las dos
  // soluciones de codo y elige la que alcanza el target con el codo
  // hacia abajo/afuera (vector polo).
  _ikArm(arm, side, target, shouldered = false, w = 1) {
    IK_S.copy(arm.shoulder.position);
    IK_V.copy(target).sub(IK_S);
    let d = IK_V.length();
    d = Math.min(L1 + L2 - 0.02, Math.max(0.12, d));
    IK_V.normalize();
    // A shouldered rifle hangs the upper arms down from the chest, rather
    // than folding both elbows forward alongside the receiver.
    // el polo del codo se mezcla: al apuntar ya no cambia de golpe
    const sh = typeof shouldered === 'number' ? shouldered : (shouldered ? 1 : 0);
    IK_POLE.set(side * (.7 + .55 * sh), -.75 + .1 * sh, -.4 + .58 * sh).normalize();
    IK_N.crossVectors(IK_V, IK_POLE);
    if (IK_N.lengthSq() < 1e-5) IK_N.set(0, 0, -side);
    IK_N.normalize();
    const a = Math.acos(clamp01((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const bend = Math.PI - Math.acos(clamp01((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)));

    let bestErr = Infinity, bestBend = 0;
    for (const sa of [1, -1]) {
      IK_U.copy(IK_V).applyAxisAngle(IK_N, a * sa); // dirección del húmero
      IK_Y.copy(IK_U).negate();
      IK_Z.crossVectors(IK_N, IK_Y).normalize();
      IK_X.crossVectors(IK_Y, IK_Z).normalize();
      IK_M.makeBasis(IK_X, IK_Y, IK_Z);
      IK_Q.setFromRotationMatrix(IK_M);
      for (const sb of [1, -1]) {
        IK_T1.set(0, -L1, 0).applyQuaternion(IK_Q);
        IK_QE.setFromAxisAngle(AXIS_X, bend * sb);
        IK_T2.set(0, -L2, 0).applyQuaternion(IK_QE).applyQuaternion(IK_Q);
        IK_H.copy(IK_S).add(IK_T1).add(IK_T2);
        const err = IK_H.distanceTo(target) - IK_T1.dot(IK_POLE) * 0.03;
        if (err < bestErr) {
          bestErr = err;
          IK_BQ.copy(IK_Q);
          bestBend = bend * sb;
        }
      }
    }
    // Entrada suave: cuando la mano vuelve al arma (tras superar un obstáculo,
    // lanzar, deslizarse, esprintar) el brazo viaja hasta ella en vez de
    // aparecer ya colocado. Con w = 1 es la solución exacta de siempre.
    if (w >= 1) {
      arm.shoulder.quaternion.copy(IK_BQ);
      arm.elbow.rotation.set(bestBend, 0, 0);
    } else {
      arm.shoulder.quaternion.slerp(IK_BQ, w);
      arm.elbow.rotation.set(arm.elbow.rotation.x + (bestBend - arm.elbow.rotation.x) * w, 0, 0);
    }
  }

  // Mide la suela real bajo cada tobillo con las piezas que cuelgan de él:
  // altura tobillo→suela y huella de apoyo (vértices a <1,2 cm del fondo).
  // Sirve para ambos avatares; se llama antes de fusionar el cuerpo.
  _calibrateLegs() {
    this.root.updateMatrixWorld(true);
    for (const leg of [this.legL, this.legR]) {
      GL_MI.copy(leg.ankle.matrixWorld).invert();
      let minY = Infinity;
      const meshes = [];
      leg.ankle.traverse((o) => { if (o.isMesh && o.visible !== false && o.geometry?.attributes.position) meshes.push(o); });
      for (const o of meshes) {
        GL_MA.multiplyMatrices(GL_MI, o.matrixWorld);
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const y = GL_V.fromBufferAttribute(pos, i).applyMatrix4(GL_MA).y;
          if (y < minY) minY = y;
        }
      }
      if (!Number.isFinite(minY)) continue;
      // puntos de apoyo: el vértice más bajo de la bota para cada inclinación
      // que el tobillo admite (punta, talón, cantos redondeados incluidos)
      const best = SOLE_DIRS.map(() => [-Infinity, 0, 0, 0]);
      for (const o of meshes) {
        GL_MA.multiplyMatrices(GL_MI, o.matrixWorld);
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          GL_V.fromBufferAttribute(pos, i).applyMatrix4(GL_MA);
          for (let k = 0; k < SOLE_DIRS.length; k++) {
            const d = SOLE_DIRS[k], v = GL_V.x * d[0] + GL_V.y * d[1] + GL_V.z * d[2];
            if (v > best[k][0]) { best[k][0] = v; best[k][1] = GL_V.x; best[k][2] = GL_V.y; best[k][3] = GL_V.z; }
          }
        }
      }
      const pts = [];
      for (const b of best) {
        if (pts.some((q) => Math.abs(q[0] - b[1]) + Math.abs(q[1] - b[2]) + Math.abs(q[2] - b[3]) < 0.004)) continue;
        pts.push([b[1], b[2], b[3]]);
      }
      leg.cal = { up: -leg.knee.position.y, h: -minY, pts: Float32Array.from(pts.flat()) };
    }
  }

  // Cadera→rodilla→tobillo hacia `target` (mundo). `pole` (mundo): hacia dónde
  // debe salir la rodilla respecto de la línea cadera-tobillo. La rodilla es
  // una bisagra (x ≤ 0): nunca se hiperextiende, y cerca de la extensión
  // completa el alcance se suaviza para que no dé un tirón.
  _solveLeg(leg, H, target, pole) {
    const L1 = leg.cal.up, o = leg.ankle.position, ax = o.x, ay = o.y;
    const dMax = Math.hypot(ax, L1 - ay), soft = 0.01;
    let d = GL_T.copy(target).sub(H).length();
    if (d > dMax - soft) d = dMax - soft + soft * (1 - Math.exp(-(d - dMax + soft) / soft));
    const c = (ax * ax + L1 * L1 + ay * ay - d * d) / (2 * L1 * ay);
    const th = -Math.min(2.75, Math.max(0.02, Math.acos(Math.max(-1, Math.min(1, c)))));
    // marco del muslo: tobillo resultante y dirección en que sobresale la rodilla
    GL_A1.set(ax, -L1 + ay * Math.cos(th), ay * Math.sin(th)).normalize();
    GL_V.set(0, -L1 + ay * Math.cos(th), ay * Math.sin(th)).normalize();
    GL_A2.set(0, -GL_V.z, GL_V.y);
    GL_A2.addScaledVector(GL_A1, -GL_A2.dot(GL_A1)).normalize();
    GL_A3.crossVectors(GL_A1, GL_A2);
    // mismo marco en el mundo: hacia el objetivo, rodilla hacia el polo
    GL_B1.copy(GL_T).normalize();
    GL_B2.copy(pole).addScaledVector(GL_B1, -pole.dot(GL_B1));
    if (GL_B2.lengthSq() < 1e-8) { GL_B2.set(-Math.sin(this.root.rotation.y), 0, -Math.cos(this.root.rotation.y)); GL_B2.addScaledVector(GL_B1, -GL_B2.dot(GL_B1)); }
    GL_B2.normalize();
    GL_B3.crossVectors(GL_B1, GL_B2);
    GL_MA.makeBasis(GL_A1, GL_A2, GL_A3).transpose();
    GL_MB.makeBasis(GL_B1, GL_B2, GL_B3).multiply(GL_MA);
    GL_Q.setFromRotationMatrix(GL_MB);
    leg.hip.parent.getWorldQuaternion(GL_Q2);
    leg.hip.quaternion.copy(GL_Q2.invert().multiply(GL_Q));
    leg.knee.rotation.set(th, 0, 0);
    leg.hip.updateMatrixWorld(true);
  }

  // Punto más bajo de la suela con el pie orientado `q` y el tobillo en `A`,
  // respecto de un suelo a altura g con pendiente `slope` en la dirección `fwd`.
  // Devuelve la altura (A.y + desplazamiento − suelo) y, si root, la del plano
  // de la raíz (para la marcha).
  _soleLow(leg, A, q, g, slope, fwd, rootInv = null) {
    const pts = leg.cal.pts;
    let low = Infinity, lowRoot = Infinity;
    for (let k = 0; k < pts.length; k += 3) {
      GL_C.set(pts[k], pts[k + 1], pts[k + 2]).applyQuaternion(q);
      const h = A.y + GL_C.y - (g + slope * (GL_C.x * fwd.x + GL_C.z * fwd.z));
      if (h < low) low = h;
      if (rootInv) { GL_C.add(A).applyMatrix4(rootInv); if (GL_C.y < lowRoot) lowRoot = GL_C.y; }
    }
    this._lowRoot = lowRoot;
    return low;
  }

  // Suela de una pierna en el mundo: centro de la huella (lowest=false) o su
  // punto más bajo. Lo usan las métricas y las pruebas de apoyo.
  soleWorld(leg, out, lowest = false) {
    const pts = leg.cal.pts;
    leg.ankle.updateWorldMatrix(true, false);
    if (!lowest) {
      let x = 0, z = 0, n = 0;
      for (let k = 0; k < pts.length; k += 3) { x += pts[k]; z += pts[k + 2]; n++; }
      return out.set(x / n, -leg.cal.h, z / n).applyMatrix4(leg.ankle.matrixWorld);
    }
    let best = Infinity;
    for (let k = 0; k < pts.length; k += 3) {
      GL_C.set(pts[k], pts[k + 1], pts[k + 2]).applyMatrix4(leg.ankle.matrixWorld);
      if (GL_C.y < best) { best = GL_C.y; out.copy(GL_C); }
    }
    return out;
  }

  // Orientación del pie limitada a lo que el tobillo admite sobre la tibia.
  _clampFoot(qKnee, q, out) {
    GL_QC.copy(qKnee).invert().multiply(q);
    GL_E.setFromQuaternion(GL_QC, 'YXZ');
    GL_E.set(Math.max(-ANKLE_DOWN, Math.min(ANKLE_UP, GL_E.x)),
      Math.max(-ANKLE_TWIST, Math.min(ANKLE_TWIST, GL_E.y)),
      Math.max(-ANKLE_ROLL, Math.min(ANKLE_ROLL, GL_E.z)), 'YXZ');
    GL_QC.setFromEuler(GL_E);
    return out.copy(qKnee).multiply(GL_QC);
  }

  // APOYO DE PIERNAS, después de toda la pose (suavizado, vuelta, ragdoll).
  // plant: la pierna pisa (suela en el suelo real, pie paralelo a él);
  // gait: conserva la alzada del paso medida sobre el suelo local; clamp: una
  // pierna libre (salto, patada, esquiva) no atraviesa el suelo. Los pesos
  // entran y salen con la misma constante a cualquier frecuencia de cuadro.
  _groundLegs(dt, plantL, plantR, gaitT, clampT, groundPitch, classic = 0) {
    const kW = this._legW ? 1 - Math.exp(-LEG_RATE * dt) : 1;
    const W = this._legW ??= [{}, {}];
    let active = false;
    // (sin arrays ni closures por cuadro: corre para cada soldado)
    for (let i = 0; i < 2; i++) {
      const w = W[i], pt = i ? plantR : plantL;
      dampW(w, 'plant', pt, kW); dampW(w, 'gait', gaitT, kW); dampW(w, 'clamp', clampT, kW); dampW(w, 'orient', Math.max(pt, gaitT), kW);
      active ||= w.plant > 1e-3 || w.gait > 1e-3 || w.clamp > 1e-3 || w.orient > 1e-3;
    }
    if (!active) {
      for (const leg of [this.legL, this.legR]) leg.ankle.quaternion.identity();
      return;
    }
    this.root.updateMatrixWorld(true);
    GL_MI.copy(this.root.matrixWorld).invert();
    const yaw = this.root.rotation.y;
    GL_F.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const slope = Math.tan(groundPitch || 0);
    const footY = this._footY ?? this.root.position.y;
    const kF = 1 - Math.exp(-FLOOR_RATE * dt);
    [this.legL, this.legR].forEach((leg, i) => {
      const w = W[i];
      leg.ankle.quaternion.identity();
      leg.ankle.updateMatrixWorld(true);
      GL_H.setFromMatrixPosition(leg.hip.matrixWorld);
      GL_A.setFromMatrixPosition(leg.ankle.matrixWorld);
      leg.knee.getWorldQuaternion(GL_QK);
      // polo: el lado hacia el que sobresale la rodilla en la pose de partida
      const th0 = leg.knee.rotation.x, L1 = leg.cal.up, ay = leg.ankle.position.y;
      GL_V.set(0, -L1 + ay * Math.cos(th0), ay * Math.sin(th0)).normalize();
      GL_P.set(0, -GL_V.z, GL_V.y);
      if (GL_P.lengthSq() < 1e-6) GL_P.set(0, 0, -1);
      leg.hip.getWorldQuaternion(GL_Q2);
      GL_P.applyQuaternion(GL_Q2);
      // suelo bajo el pie (seguido como la raíz: un peldaño no es un salto)
      // una muestra inválida (NaN/undefined) conserva el último suelo válido
      // en vez de envenenar el apoyo de ese pie para siempre
      let g0 = this.groundFn ? this.groundFn(GL_A.x, GL_A.z, footY) : footY;
      if (!Number.isFinite(g0)) g0 = Number.isFinite(leg._floorRaw) ? leg._floorRaw : (Number.isFinite(footY) ? footY : 0);
      if (!Number.isFinite(leg._floorOff)) leg._floorOff = 0;
      if (!Number.isFinite(leg._pen)) leg._pen = 0;
      // las rampas se siguen exactas; un desnivel brusco (peldaño, borde de
      // un bloque) se reparte en ~0,1 s como hace la raíz
      if (!Number.isFinite(leg._floorRaw) || Math.abs(g0 - leg._floorRaw) > 1.2) leg._floorOff = 0;
      else if (Math.abs(g0 - leg._floorRaw) > 0.04) leg._floorOff += leg._floorRaw - g0;
      leg._floorRaw = g0;
      leg._floorOff *= 1 - kF;
      const g = g0 + leg._floorOff;
      // pie: rígido con la tibia (libre) → paralelo al suelo (apoyado)
      GL_W.set(0, 0, -1).applyQuaternion(GL_QK);
      const footYaw = GL_W.x * GL_W.x + GL_W.z * GL_W.z > 1e-4 ? Math.atan2(-GL_W.x, -GL_W.z) : yaw;
      const pitchF = Math.atan(slope * Math.cos(footYaw - yaw));
      GL_QF.setFromEuler(GL_E.set(pitchF, footYaw, 0, 'YXZ'));
      GL_QP.copy(GL_QK).slerp(GL_QF, w.orient);
      this._clampFoot(GL_QK, GL_QP, GL_QP);
      // altura buscada para el punto más bajo de la suela, medida en la pose
      // de partida; luego se itera (secante): con el tobillo en su tope, el
      // pie cambia de inclinación al moverse la tibia y un paso fijo oscila
      const hAct0 = this._soleLow(leg, GL_A, GL_QP, g, slope, GL_F, GL_MI);
      const hInt = hAct0 + (this._lowRoot - hAct0) * w.gait;
      // carrera clásica (zancada por tiempo): la pierna se sube entera lo que
      // su arco se hundía en el último ciclo, en vez de aplanar el arco contra
      // el suelo (eso arrastraba la suela durante media zancada)
      leg._pen = Math.max(-hInt, (leg._pen ?? 0) * Math.exp(-dt / 2.5), 0);
      const lifted = hInt + leg._pen * w.gait;
      const clamped = hInt + (Math.max(0, hInt) - hInt) * w.clamp;
      const want = (1 - w.plant) * (clamped + (Math.max(clamped, lifted) - clamped) * classic);
      let y = GL_A.y, r = hAct0 - want, rate = 1;
      for (let pass = 0; pass < 4 && Math.abs(r) > 0.0005; pass++) {
        const y1 = y - r / rate;
        GL_A.y = y1;
        this._solveLeg(leg, GL_H, GL_A, GL_P);
        leg.knee.getWorldQuaternion(GL_QK);
        GL_QP.copy(GL_QK).slerp(GL_QF, w.orient);
        this._clampFoot(GL_QK, GL_QP, GL_QP);
        const r1 = this._soleLow(leg, GL_A, GL_QP, g, slope, GL_F) - want;
        if (Math.abs(y1 - y) > 1e-5) rate = Math.max(0.5, Math.min(4, (r1 - r) / (y1 - y)));
        y = y1; r = r1;
      }
      // fuera de alcance (cadera alta sobre cobertura baja): de puntillas
      leg.ankle.updateMatrixWorld(true);
      GL_K.setFromMatrixPosition(leg.ankle.matrixWorld);
      const short = (GL_K.y - GL_A.y) * w.plant;
      if (short > 0.004) {
        const base = this._soleLow(leg, GL_K, GL_QP, g, slope, GL_F);
        let lo = 0, hi = ANKLE_DOWN;
        for (let it = 0; it < 10; it++) {
          const mid = (lo + hi) / 2;
          GL_Q.copy(GL_QP).multiply(GL_Q2.setFromAxisAngle(AXIS_X, -mid));
          this._clampFoot(GL_QK, GL_Q, GL_Q);
          if (this._soleLow(leg, GL_K, GL_Q, g, slope, GL_F) > base - short) lo = mid; else hi = mid;
        }
        GL_QP.multiply(GL_Q2.setFromAxisAngle(AXIS_X, -hi));
        this._clampFoot(GL_QK, GL_QP, GL_QP);
      }
      leg.ankle.quaternion.copy(GL_QK.invert().multiply(GL_QP));
    });
  }

  // MARCO DE REFERENCIA DEL ARMA. Hip fire y blindfire disparan por el eje
  // físico del cañón, así que perfilar el pecho (cadera, ADS) o agacharse en
  // blind_over no puede moverlo. El aimRig (brazos+arma) cuelga del pecho
  // visible; aquí se re-expresa respecto del pecho "de siempre" (el visible
  // más la diferencia amortiguada) y, en altura, de la pelvis de siempre. La
  // pose lógica se guarda y se restaura al empezar el cuadro siguiente.
  // Referencia absoluta: scripts/fixtures/fire-reference.json.
  _aimRef(dPitch, dYaw, dRoll, dLift, k) {
    const R = this._aimRefD ??= { x: 0, y: 0, z: 0, h: 0 };
    R.x += (dPitch - R.x) * k; R.y += (dYaw - R.y) * k; R.z += (dRoll - R.z) * k; R.h += (dLift - R.h) * k;
    const S = this._aimRefState ??= { rot: new THREE.Euler(), pos: new THREE.Vector3(), written: new THREE.Quaternion() };
    S.rot.copy(this.aimRig.rotation); S.pos.copy(this.aimRig.position);
    if (Math.abs(R.x) + Math.abs(R.y) + Math.abs(R.z) + Math.abs(R.h) > 1e-6) {
      const t = this.torso.rotation;
      // D = pecho⁻¹ · pecho_de_referencia
      AREF_Q.setFromEuler(AREF_E.set(t.x + R.x, t.y + R.y, t.z + R.z, t.order));
      AREF_D.copy(this.torso.quaternion).invert().multiply(AREF_Q);
      this.aimRig.quaternion.premultiply(AREF_D);
      this.aimRig.position.applyQuaternion(AREF_D);
      // la pelvis de referencia está R.h más arriba (en el marco del pecho)
      AREF_V.set(0, R.h, 0).applyQuaternion(AREF_Q.copy(this.torso.quaternion).invert());
      this.aimRig.position.add(AREF_V);
    }
    S.written.copy(this.aimRig.quaternion);
  }

  // p: {state, speed, aim, aimPitch, twist}
  update(dt, p) {
    // el aimRig parte de su pose lógica (sin el marco de referencia aplicado)
    const AR = this._aimRefState;
    if (AR && this.aimRig.quaternion.equals(AR.written)) {
      this.aimRig.rotation.copy(AR.rot); this.aimRig.position.copy(AR.pos);
    }
    // las piernas parten de su pose propia (sin el apoyo del cuadro anterior)
    if (this._legFK) {
      const F = this._legFK;
      [this.legL, this.legR].forEach((leg, i) => {
        leg.hip.rotation.set(F[i * 6], F[i * 6 + 1], F[i * 6 + 2]);
        leg.knee.rotation.set(F[i * 6 + 3], F[i * 6 + 4], F[i * 6 + 5]);
      });
    }
    // seguimiento de altura (ver setTransform): solo con los pies en el suelo
    this._ySnap = p.state === 'jump' || p.state === 'flip' || p.state === 'dead' || p.state === 'mantle' || !!this.rag;
    if (!this._ySnap && this._footY !== undefined && this._visY !== undefined) {
      this._visY += (this._footY - this._visY) * (1 - Math.exp(-24 * dt));
      this.root.position.y = this._visY;
    }
    if(this.stunned&&p.state!=='dead')p={...p,aim:false,speed:0,state:String(p.state).includes('cover')?p.state:'idle'};
    if (p.state !== 'dead' && !this.rag) this._pendingBlenderSoldier?.();
    // Convenciones (el personaje mira a -Z local):
    //   torso.x: − adelante, + atrás   |   head.x: + mirar arriba
    //   shoulder/elbow.x: + brazo hacia adelante   |   knee.x: − doblar rodilla
    const T = new Map();
    const set = (o, k, v) => {
      let e = T.get(o);
      if (!e) { e = {}; T.set(o, e); }
      e[k] = v;
    };
    const R = (grp, x = 0, y = 0, z = 0) => {
      set(grp.rotation, 'x', x); set(grp.rotation, 'y', y); set(grp.rotation, 'z', z);
    };
    const add = (o, k, v) => {
      let e = T.get(o);
      if (!e) { e = {}; T.set(o, e); }
      e[k] = (e[k] ?? 0) + v;
    };
    // postura del arma: posición/rotación del mount (relativo al pecho)
    const M = (x, y, z, rx = 0, ry = 0, rz = 0) => {
      set(this.gunMount.position, 'x', x);
      set(this.gunMount.position, 'y', y);
      set(this.gunMount.position, 'z', z);
      R(this.gunMount, rx, ry, rz);
    };

    let hipsY = 0.66, aimRigX = 0, aimRigY = 0.5, rootRotX = 0, damp = 12;
    // apoyo por pierna [izq, der] (1 = pisa) y si una pierna libre puede
    // atravesar el suelo (0 en vuelta, mantle y muerte)
    let plantL = 1, plantR = 1, legClamp = 1;
    // giro de pelvis propio del rig (solo blindfire lateral lo usa)
    set(this.hips.rotation, 'y', 0);
    let leftOnGun = false, ikArms = true, adsBody = false, hipHold = false;
    // diferencia entre el pecho visible y el "de referencia" al que se ata el
    // arma (perfil de cadera/ADS, agachado de blind_over): ver _aimRef
    let refYaw = 0, refPitch = 0, refRoll = 0, refLift = 0;
    // Visual cadence follows acceleration without changing movement, aiming or
    // weapon timing. Keep the phase continuous when releasing/reapplying input.
    const gaitTarget = ['run','roadie'].includes(p.state) ? Math.min(1,Math.max(0,p.speed??0)) : 0;
    this._gaitSpeed = (this._gaitSpeed??0) + (gaitTarget-(this._gaitSpeed??0))*(1-Math.exp(-14*dt));
    this._strideWeight = (this._strideWeight??0) + ((gaitTarget>.02?1:0)-(this._strideWeight??0))*(1-Math.exp(-18*dt));
    const sp = this._gaitSpeed;
    // MARCHA POR DISTANCIA. La fase del paso avanza con los metros que recorre
    // el cuerpo, no con el reloj: a cualquier velocidad, acelerando o frenando,
    // el pie apoyado retrocede exactamente lo que el cuerpo avanza. Antes la
    // cadencia iba por tiempo y la zancada era fija: los pies patinaban.
    const gv = gaitTarget * 7.6;                       // m/s reales
    const gFwd = p.moveForward ?? 1, gSide = p.moveSide ?? 0;
    const gLen = Math.hypot(gFwd, gSide) || 1;
    const sideness = Math.min(1, Math.abs(gSide) / gLen), backness = Math.max(0, -gFwd / gLen);
    // metros por ciclo (dos pasos): crece con la velocidad; de lado y hacia
    // atrás los pasos son más cortos
    const gaitCycle = (0.95 + 0.36 * gv) * (1 - 0.38 * sideness) * (1 - 0.22 * backness);
    const coverStep = String(p.state).startsWith('cover_') ? Math.abs(p.latMove ?? 0) * 3.5 / 0.9 : 0;
    // CARRERA CLÁSICA. Correr de frente sin apuntar conserva la zancada
    // original (amplia, por tiempo, rodilla alta): se prefirió a la resuelta
    // por distancia, aunque el pie patine algo. La marcha por distancia queda
    // para apuntar, ir de lado y retroceder, donde la original cruzaba piernas.
    const classicT = (p.aim ? 0 : 1) * Math.max(0, Math.min(1, (gFwd / gLen - 0.5) / 0.3));
    this._classic = (this._classic ?? classicT) + (classicT - (this._classic ?? classicT)) * (1 - Math.exp(-10 * dt));
    const classic = this._classic;
    this.phase += (1 - classic) * Math.PI * 2 * dt * (gv / gaitCycle + coverStep)
      + classic * dt * ((4.5 + sp * 8.5) * this._strideWeight + Math.PI * 2 * coverStep);
    const ph = this.phase;
    const cSwing = Math.sin(ph);                         // vaivén de la carrera clásica
    const swing = Math.cos(ph), swing2 = -swing;       // +1: pie izquierdo delante
    const bob = .5 + .5*Math.cos(ph*2); // smooth footfall, no abs() cusp at each contact
    const pitch = p.aimPitch ?? 0;
    this._idleT = (this._idleT ?? 0) + dt;             // respiración: reloj propio
    const breath = Math.sin(this._idleT * 1.7);
    // INERCIA DEL CUERPO: aceleración y giro medidos sobre lo que el rig recibe
    const vF = gv * gFwd / gLen, vS = gv * gSide / gLen;
    const safeDt = Math.max(dt, 1e-4);
    const kA = 1 - Math.exp(-9 * dt);
    this._accF = (this._accF ?? 0) + (((vF - (this._vF ?? vF)) / safeDt) - (this._accF ?? 0)) * kA;
    this._accS = (this._accS ?? 0) + (((vS - (this._vS ?? vS)) / safeDt) - (this._accS ?? 0)) * kA;
    this._vF = vF; this._vS = vS;
    let dYaw = this.root.rotation.y - (this._yawPrev ?? this.root.rotation.y);
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    this._yawPrev = this.root.rotation.y;
    this._yawRate = (this._yawRate ?? 0) + ((dYaw / safeDt) - (this._yawRate ?? 0)) * kA;
    // con el arma en uso el torso no se ladea: la inercia nunca mueve la mira
    this._calm = (this._calm ?? 1) + (((p.aim || p.firing) ? 0 : 1) - (this._calm ?? 1)) * (1 - Math.exp(-16 * dt));
    const calm = this._calm;
    const leanAcc = Math.max(-0.13, Math.min(0.13, -this._accF * 0.0075)) * calm;   // − = hacia delante
    const leanSide = Math.max(-0.12, Math.min(0.12, -this._accS * 0.006 - this._yawRate * gaitTarget * 0.045)) * calm;

    const locomotionState = p.state === 'roadie' && (p.moveForward ?? 1) < 0.5 ? 'run' : p.state;
    switch (locomotionState) {
      case 'roadie': {
        damp = 10;
        rootRotX = (p.groundPitch ?? 0) * 0.58;
        // el torso se echa adelante, contrarrota con las piernas y se ladea al girar
        R(this.torso, -0.55 + leanAcc, swing * 0.07 * (1 - classic), (swing * 0.035 + leanSide * 1.2) * (1 - classic) + Math.sin(ph * 0.5) * 0.04 * classic);
        R(this.head, 0.42 - leanAcc * 0.5, -swing * 0.05, -leanSide * 0.6);
        // (las piernas las coloca el resolvedor de marcha, tras el suavizado)
        R(this.armL.shoulder, (swing2 * 0.85) * (1 - classic) - cSwing * 0.9 * classic + 0.2, 0, -0.2); R(this.armL.elbow, (1.15 + Math.max(0, swing) * 0.25) * (1 - classic) + 1.25 * classic, 0, 0);
        // arma baja al costado, una mano
        M(0.19, -0.34, -0.22, -0.5, 0.05, 0);
        R(this.aimRig, 0, 0, 0);
        hipsY = (0.585 - bob * 0.035 * this._strideWeight) * (1 - classic) + (0.58 + bob * 0.06 * this._strideWeight) * classic;
        break;
      }
      case 'run': case 'idle': default: { // default: estados desconocidos (red) caen a idle
        const m = this._strideWeight;
        const forward = p.moveForward ?? 1;
        const side = p.moveSide ?? 0;
        const tw = p.twist ?? 0; // torso/cabeza giran hacia la cámara
        rootRotX = (p.groundPitch ?? 0) * 0.72;
        // La postura relajada nace de brazos/arma al frente; el torso conserva
        // su movilidad natural y no adopta todavía la rigidez de ADS.
        // Inclinación según la velocidad y el sentido de la marcha, respiración
        // en reposo, y la inercia de arrancar, frenar y girar. El torso
        // contrarrota apenas con las piernas; con el arma en uso, nada de esto.
        const lean = -(0.05 + 0.09 * sp) * m * (forward >= 0 ? 1 : -0.45);
        // (la respiración casi no mueve el torso: el arma en reposo y al
        // disparar comparten boca de cañón; respiran la cabeza y la pelvis)
        R(this.torso, (lean + leanAcc) * (1 - classic) + (-0.1 * m + Math.sin(ph * 0.4) * 0.015 + leanAcc * 0.5) * classic + breath * 0.004 * (1 - m),
          tw * 0.55 - HIP_BLADE + swing * 0.03 * m * calm * (1 - classic),
          (swing * 0.035 * m * calm + leanSide - side * 0.05 * m * calm) * (1 - classic) + (cSwing * 0.04 * m + leanSide * 0.5) * classic);
        // la cabeza se queda nivelada y acompaña la mirada vertical
        R(this.head, 0.05 * m - leanAcc * 0.6 + pitch * 0.3 * calm + breath * 0.02 * (1 - m), tw * 0.35 + HIP_BLADE, -leanSide * 0.7);
        // (las piernas las coloca el resolvedor de marcha, tras el suavizado)
        leftOnGun = true;
        // El arma permanece al frente, sostenida por ambas manos y apenas por
        // debajo de ADS. Así la silueta comunica la dirección del hip fire sin
        // apuntar ópticamente. El target es idéntico antes/durante fire: no hay
        // elevación súbita del muzzle ni salto de retícula al primer click.
        damp = p.firing ? 18 : 14;
        M(HIP_MOUNT[0], HIP_MOUNT[1], HIP_MOUNT[2], 0, HIP_YAW, 0);
        refYaw = HIP_BLADE; // el arma ignora el perfil del pecho (ver _aimRef)
        hipHold = true;
        // la pelvis baja en el apoyo y sube en el vuelo; en reposo respira
        hipsY = 0.66 - bob * (0.018 + 0.022 * sp) * m * (1 - classic) + bob * 0.045 * m * classic + breath * 0.004 * (1 - m);
        break;
      }
      case 'jump': {
        // SALTO con fases: impulso (piernas estiradas hacia atrás), recogida en
        // lo alto y piernas buscando el suelo al caer. Lo marca la velocidad
        // vertical real; sin ella queda la pose recogida de siempre.
        damp = 16;
        const vy = p.vy ?? 0;
        const rise = Math.max(0, Math.min(1, vy / 5)), fall = Math.max(0, Math.min(1, -vy / 6));
        const tuck = 1 - Math.max(rise, fall);            // 1 en lo alto del salto
        R(this.torso, -0.12 - 0.1 * tuck + 0.08 * fall, 0, 0.03 * tuck);
        R(this.head, 0.1 + 0.12 * fall, 0, 0);
        R(this.legL.hip, 0.2 + 0.5 * tuck - 0.25 * rise + 0.25 * fall, 0, 0.04);
        R(this.legL.knee, -0.35 - 0.8 * tuck - 0.1 * fall, 0, 0);
        R(this.legR.hip, -0.25 * rise + 0.25 * tuck + 0.1 * fall, 0, -0.04);
        R(this.legR.knee, -0.25 - 0.45 * tuck - 0.35 * rise - 0.15 * fall, 0, 0);
        leftOnGun = true;
        M(0.16, -0.14 - 0.03 * fall, -0.34, 0, 0, 0);
        hipsY = 0.66 + 0.02 * rise;
        this._airVy = vy;
        plantL = plantR = 0;
        break;
      }
      case 'mantle': {
        // vault corto sobre cover bajo: torso volcado, ambas manos al borde,
        // pierna de apoyo arriba — el arma va pegada al pecho
        damp = 20;
        // Tres tiempos sobre el progreso real del salto: manos al borde y
        // cuerpo volcado, pierna que pasa por encima, y salida ya erguido.
        const mk = Math.max(0, Math.min(1, p.mantlePhase ?? 0.5));
        const over = Math.sin(Math.PI * Math.min(1, mk / 0.8));       // volcado
        const out = Math.max(0, (mk - 0.7) / 0.3);                    // salida
        R(this.torso, -0.25 - 0.6 * over + 0.2 * out, 0, 0.06 * over);
        R(this.head, 0.2 + 0.3 * over, 0, 0);
        R(this.armL.shoulder, 0.6 + 0.75 * over, 0, -0.25); R(this.armL.elbow, 0.25 + 0.5 * out, 0, 0);
        R(this.armR.shoulder, 0.5 + 0.7 * over, 0, 0.2); R(this.armR.elbow, 0.3 + 0.5 * out, 0, 0);
        R(this.legL.hip, 0.4 + 1.1 * over, 0, 0.1); R(this.legL.knee, -0.6 - 1.3 * over, 0, 0);
        R(this.legR.hip, 0.35 * over + 0.5 * out, 0, -0.05); R(this.legR.knee, -0.5 - 0.5 * out, 0, 0);
        // la izquierda al borde (pose propia); la derecha no suelta el arma:
        // antes las dos iban al borde y el arma quedaba a 0,5 m de la mano
        M(0.14, -0.05, -0.2, 0.9 * over, 0, 0.15 * over);
        R(this.aimRig, 0, 0, 0);
        hipsY = 0.62 - 0.12 * over;
        plantL = plantR = 0; legClamp = 0; // cruza el bloque: el suelo bajo el pie salta
        break;
      }

      case 'flip': {
        // patada de pared Matrix: giro LATERAL con piernas semi-recogidas,
        // arma al frente en ambas manos para disparar en el aire
        damp = 20;
        R(this.torso, -0.2, 0, 0);
        R(this.head, 0.05, 0, 0);
        R(this.legL.hip, 1.25, 0, 0.15); R(this.legL.knee, -1.7, 0, 0);
        R(this.legR.hip, 1.05, 0, -0.15); R(this.legR.knee, -1.5, 0, 0);
        leftOnGun = true;
        M(0.14, -0.1, -0.36, 0, 0, 0);
        set(this.aimRig.rotation, 'x', pitch); // apunta con la cámara en el aire
        set(this.aimRig.rotation, 'y', p.aimYawErr ?? 0);
        hipsY = 0.72;
        plantL = plantR = 0; legClamp = 0;
        break;
      }
      case 'dive': {
        damp = 22;
        const evade = Math.sin(Math.PI * Math.max(0, Math.min(1, p.evadePhase ?? 0.5)));
        // Low forward dodge: compress, extend, recover. Unlike the feet-first
        // cover slide, both hands retain the weapon and the torso leads.
        R(this.torso, -0.2 - 0.65 * evade, 0, -0.12 * evade);
        R(this.head, 0.3, 0, 0);
        R(this.legL.hip, 0.35 + 0.65 * evade, 0, 0); R(this.legL.knee, -0.4 - evade, 0, 0);
        R(this.legR.hip, -0.9 * evade, 0, 0); R(this.legR.knee, -0.3 - 0.9 * evade, 0, 0); // la de atrás, con el pie en el aire
        leftOnGun = true;
        M(0.12, -0.22, -0.28, -0.3, 0, 0);
        hipsY = 0.62 - 0.23 * evade;
        plantR = 1 - evade; // la pierna izquierda apoya; la derecha va en el aire
        break;
      }
      case 'slide': {
        damp = 16;
        R(this.torso, 0.2, 0, 0.1);
        R(this.head, -0.05, 0, 0);
        R(this.legL.hip, 1.2, 0, 0); R(this.legL.knee, -0.3, 0, 0);   // pierna extendida
        // pierna doblada: rodilla arriba y bota plana delante de la cadera (con
        // la pelvis a 0,38 m el muslo apenas sube; antes la bota se hundía 41 cm)
        R(this.legR.hip, 1.85, 0, 0); R(this.legR.knee, -1.85, 0, 0);
        // la izquierda sujeta el guardamanos: el "brazo atrás" quedaba a 1,2 m
        // del arma y a ~0,3 m del suelo (con el pecho erguido no lo alcanza)
        leftOnGun = true;
        M(0.12, -0.15, -0.32, 0.05, 0, 0);
        hipsY = 0.38;
        break;
      }
      case 'cover_low': case 'cover_high': {
        damp = 32; // protection recovery begins on input release
        const low = p.state === 'cover_low';
        const lat = p.latMove ?? 0;         // -1..1: paso lateral
        const stepping = Math.abs(lat) > 0.12;
        const stepSw = stepping ? Math.sin(ph * 1.5) : 0;
        leftOnGun = true;
        if (low) {
          // agachado PROFUNDO de espaldas al bloque: la cabeza queda bajo el borde
          R(this.torso, -0.72 + (stepping ? Math.abs(stepSw) * 0.04 : 0), lat * 0.18, -lat * 0.1);
          R(this.head, 0.55, lat * 0.35, 0);
          R(this.legL.hip, 1.85 + stepSw * 0.3 * lat, 0, lat * 0.2);
          R(this.legL.knee, -2.35, 0, 0);
          R(this.legR.hip, 1.7 - stepSw * 0.3 * lat, 0, lat * 0.2);
          R(this.legR.knee, -2.25, 0, 0);
          hipsY = 0.18 + (stepping ? Math.abs(Math.cos(ph * 1.5)) * 0.02 : 0);
        } else {
          // de pie con la espalda apoyada en la pared
          R(this.torso, 0.14, lat * 0.15, -lat * 0.07);
          R(this.head, 0.02, lat * 0.45, 0);
          R(this.legL.hip, -0.05 + stepSw * 0.35 * lat, 0, 0.06 + lat * 0.15);
          R(this.legL.knee, -0.2 - Math.max(0, stepSw * lat) * 0.4, 0, 0);
          R(this.legR.hip, 0.05 - stepSw * 0.35 * lat, 0, -0.06 + lat * 0.15);
          R(this.legR.knee, -0.15 - Math.max(0, -stepSw * lat) * 0.4, 0, 0);
          hipsY = 0.62 + (stepping ? Math.abs(Math.cos(ph * 1.5)) * 0.02 : 0);
        }
        // arma al pecho: vertical relajada, o al frente si está disparando
        // (el pitch/yaw del tiro lo aplica el bloque post-switch del aimRig)
        if (p.firing) {
          damp = 16;
          M(0.15, -0.08, -0.38, 0, 0, 0);
        } else {
          M(0.1, -0.04, -0.32, 1.25, 0, 0.06);
        }
        break;
      }
      case 'blind_over': {
        damp = 15;
        const blindPose = coverBlindPose({ kind: p.coverKind, h: 1.1 }, pitch);
        // Disparo a ciegas por encima: agachado TRAS el bloque con la cabeza
        // bajo el borde, el brazo derecho alza el arma por encima y la palma
        // izquierda se apoya en el bloque. Antes se arrodillaba con casco y
        // hombros por encima del borde y la izquierda suelta junto al pecho
        // (un brazo de 0,64 m no alcanza a sostener el arma con las dos manos
        // por encima de la cabeza sin dejarla sobre el casco). El arma y su
        // eje son los de siempre: el marco de referencia del arma (_aimRef)
        // deshace la bajada, la inclinación y el ladeo del cuerpo; solo el
        // ajuste de alcance del brazo la acerca al hombro (≤6 cm apuntando
        // abajo, ≤22 cm nivelado/arriba; check-fire-direction).
        const down = Math.max(0, Math.min(1, -pitch / 0.55));
        refPitch = -0.05 - BLIND_OVER.lean; refRoll = 0.04;
        refLift = BLIND_OVER.drop - down * BLIND_OVER.rise;
        R(this.torso, BLIND_OVER.lean, 0, -0.04);
        R(this.head, 0.12, 0.1, 0);
        R(this.legL.hip, 1.7, 0, 0.14); R(this.legL.knee, -2.25, 0, 0);
        R(this.legR.hip, 1.55, 0, -0.1); R(this.legR.knee, -2.15, 0, 0);
        M(0.06, 0.28, -0.32 - blindPose.gunForward, 0, 0, 0);
        hipsY = blindPose.hipsY - BLIND_OVER.drop + down * BLIND_OVER.rise;
        aimRigY = blindPose.aimRigY;
        break;
      }
      case 'blind_low_left': case 'blind_low_right':
      case 'blind_high_left': case 'blind_high_right': {
        damp = 26;
        leftOnGun = true;
        const low = p.state.startsWith('blind_low_');
        const side = p.state.endsWith('_right') ? 1 : -1;
        const down = Math.max(0, Math.min(1, -pitch / 0.55));
        const pelvis = -side * (low ? BLIND_PELVIS.low : BLIND_PELVIS.high);
        set(this.hips.rotation, 'y', pelvis);
        if (low) {
          torsoUnderPelvis(BLIND_CHEST.lowLean, -side * BLIND_CHEST.low, side * 0.08, pelvis, TORSO_E);
          R(this.torso, TORSO_E.x, TORSO_E.y, TORSO_E.z);
          R(this.head, 0.36, 0, side * 0.04);
          R(this.legL.hip, 1.82, 0, 0); R(this.legL.knee, -2.3, 0, 0);
          R(this.legR.hip, 1.72, 0, 0); R(this.legR.knee, -2.25, 0, 0);
          hipsY = 0.14;
          aimRigY = 0.68 + down * 0.08;
        } else {
          torsoUnderPelvis(0.05, -side * BLIND_CHEST.high, side * 0.08, pelvis, TORSO_E);
          R(this.torso, TORSO_E.x, TORSO_E.y, TORSO_E.z);
          R(this.head, 0.08, 0.12, 0);
          R(this.legL.hip, -0.04, 0, 0.08); R(this.legL.knee, -0.18, 0, 0);
          R(this.legR.hip, 0.04, 0, -0.08); R(this.legR.knee, -0.16, 0, 0);
          hipsY = 0.62;
          aimRigY = 0.52 + down * 0.06;
        }
        const longGun = this._wep === 'shotgun' ? 0.06
          : (this._wep === 'sniper' || this._wep === 'bazooka') ? 0.1 : 0;
        aimRigX = side * (low ? 0.27 : 0.26);
        // High cover: keep the grip between the shoulders rather than beyond
        // the opposite arm's reach. Low-cover clearance uses its own pose.
        M(side * (low ? 0.60 : 0.52), low ? 0.25 : 0.04,
          -0.08 - longGun, 0, 0, -side * 0.04);
        break;
      }
      case 'melee': {
        // Fases corporales reales. Local usa el progreso del controller para
        // conservar el hit-stop; remotos/bots recurren al reloj interno.
        this._meleeT += dt;
        damp = 30;
        const localPhase = Number.isFinite(p.meleePhase) ? p.meleePhase : null;
        const ph = Math.min(1, localPhase ?? this._meleeT / TUNING.melee.time);
        const compact = ['pistol','grenade','frag','stun'].includes(this._wep);
        const heavy = this._wep === 'bazooka' || this._wep === 'sniper';
        const contact = ph < 0.27 ? ph / 0.27
          : ph < 0.5 ? 1
          : Math.max(0, 1 - (ph - 0.5) / 0.5);
        // PATADA FRONTAL. Recoge la rodilla (preparación), estira la pierna
        // a la altura del pecho (contacto) y la vuelve a bajar. En sprint es
        // una patada en salto: el cuerpo se eleva y la pierna de apoyo se recoge.
        const fly = p.meleeTackle ? 1 : 0;
        // k: 0→1 recoger · e: 0→1 estirar · r: 0→1 volver
        const kUp = Math.min(1, ph / 0.27);
        const ext = ph < 0.2 ? 0 : ph < 0.3 ? (ph - 0.2) / 0.1 : ph < 0.5 ? 1 : Math.max(0, 1 - (ph - 0.5) / 0.3);
        const back = ph < 0.5 ? 0 : Math.min(1, (ph - 0.5) / 0.5);
        const up = kUp * (1 - back);                       // cuánto está arriba la pierna
        hipsY = 0.64 - up * 0.03 + fly * up * 0.2;
        rootRotX = (p.groundPitch ?? 0) * 0.35 + up * 0.05;
        // el tronco se echa atrás para contrapesar y gira un poco con la cadera
        R(this.torso, 0.1 * kUp * (1 - back) + 0.2 * ext + fly * 0.12 * up, -0.22 * up, 0.05 * up);
        R(this.head, -0.12 * up - 0.1 * ext, 0.12 * up, 0);
        // pierna que golpea (derecha): muslo arriba, rodilla recogida → estirada
        R(this.legR.hip, up * (1.3 + 0.38 * ext), 0, -0.05 * up);
        R(this.legR.knee, -up * 1.55 * (1 - ext) - 0.06, 0, 0);
        // pierna de apoyo (izquierda): algo flexionada y atrás; en salto, recogida
        R(this.legL.hip, up * (-0.2 + fly * 0.75), 0, 0.08 * up);
        R(this.legL.knee, -(0.22 + fly * 1.1) * up - 0.08, 0, 0);
        plantR = 1 - up; plantL = 1 - fly * up;
        // el arma se queda pegada al pecho, cruzada, mientras patea
        M(0.2, -0.1, -0.3, 0.05 + 0.2 * up, 0.28 * up, 0.12 * up);
        R(this.armL.shoulder, 0.55 + up * 0.2, 0, -0.2);
        R(this.armL.elbow, 0.75, 0, 0);
        R(this.armR.shoulder, 0.5 + up * 0.15, 0, 0.18);
        R(this.armR.elbow, 0.6, 0, 0);
        set(this.aimRig.rotation, 'x', 0);
        set(this.aimRig.rotation, 'y', 0);
        break;
      }

      case 'dead': {
        // ragdoll de PESO MUERTO en dos fases: rodillas que ceden y caída
        // ACELERADA por gravedad (tope seco), y al impactar un flop de
        // extremidades amortiguado (flexible, pero se apaga rápido = peso)
        if (!this.rag) this._startRagdoll();
        // (la visibilidad del arma la maneja la física del ragdoll: se le
        // cae de las manos ~0.22s después del impacto, no al instante)
        damp = this.rag.t < this.rag.reactT ? 18 : this.rag.hit ? 5 : 7;
        ikArms = false;
        const rg = this.rag;
        const rp = rg.pose;
        // Short directional impact, then asymmetric loss of knee support.
        // This is corpse presentation only; living aim and hitboxes stay intact.
        const shock=Math.sin(Math.PI*Math.min(1,rg.t/rg.reactT))*(.12+rg.impactPower*.16);
        const buckle=Math.sin(Math.PI*Math.min(1,rg.ang));
        // flop al impactar: oscilación amortiguada, coeficiente por miembro
        const flop = rg.hit ? Math.sin(rg.flopT * 24) * Math.exp(-rg.flopT * 8) : 0;
        R(this.torso, rp[0] + flop * rg.fl[5] * 0.4 + shock*rg.impactFront, rp[1], -shock*rg.impactSide);
        R(this.head, rp[2] + flop * rg.fl[4] - shock*.55*rg.impactFront, 0, rp[3]+shock*.3*rg.impactSide);
        R(this.armL.shoulder, rp[4] + flop * rg.fl[0], 0, -Math.abs(rp[5]));
        R(this.armL.elbow, rp[6] + flop * rg.fl[0] * 0.7, 0, 0);
        R(this.armR.shoulder, rp[7] + flop * rg.fl[1], 0, Math.abs(rp[8]));
        R(this.armR.elbow, rp[9] + flop * rg.fl[1] * 0.7, 0, 0);
        R(this.legL.hip, rp[10] + flop * rg.fl[2], 0, rp[11]);
        R(this.legL.knee, rp[12]-.55*buckle, 0, 0);
        R(this.legR.hip, rp[13] + flop * rg.fl[3], 0, -rp[11]);
        R(this.legR.knee, rp[14]-.35*buckle, 0, 0);
        R(this.aimRig, 0, 0, 0);
        M(0.12, -0.18, -0.14, 0.4, 0, 0.2);
        plantL = plantR = 0; legClamp = 0;
        break;
      }
    }
    if (p.state !== 'dead') this._deadT = 0;
    if (p.state !== 'melee') this._meleeT = 0;

    // ADS: postura pronunciada y específica por familia. La posición cambia
    // cómo se sostiene el modelo, pero gunMount queda sin yaw/pitch local: la
    // orientación funcional vive exclusivamente en aimRig y coincide con la
    // intención de cámara.
    // roadie/blind_over excluidos: su brazo izq. es pose Euler y el IK de
    // aquí peleaba con ella (temblor) si un remoto llegaba con st+aim juntos
    if (p.aim && p.state !== 'dead' && p.state !== 'dive' && p.state !== 'slide' &&
        p.state !== 'roadie' && p.state !== 'blind_over' && p.state !== 'melee') {
      const poseKey=this._wep==='stun'?'pistol':this._wep==='frag'?'grenade':this._wep;
      const adsPose = ADS_WEAPON_POSES[poseKey] ?? ADS_WEAPON_POSES.smg;
      damp = adsPose.damp;
      leftOnGun = true;
      // Trasladar el conjunto completo (hombros, brazos y arma), no solo el
      // gunMount. Así el gesto se acerca a la línea óptica sin estirar el IK
      // ni separar las manos de grip/forend.
      aimRigX = adsPose.center;
      const lean = p.coverLean ?? 0; // asomarse en la orilla de pared alta
      const aimingFromCover=p.state==='cover_high'||p.state==='cover_low';
      if(aimingFromCover)aimRigX += lean * .12;
      const coverPose = p.state === 'cover_low'
        ? (lean ? {hipsY:.18,aimRigY:.68,gunForward:0,torsoLean:0}
          : coverAimPose({ kind: p.coverKind, h: 1.1 }, pitch,
            p.coverAimExposure ?? 1))
        : null;
      const torsoPitch = adsPose.torsoPitch - (coverPose?.torsoLean ?? 0);
      // Compensar inclinación de root+torso: el cañón visual conserva el pitch
      // de cámara en vez de sumar accidentalmente la postura inclinada.
      // ADS perfilado solo en campo abierto y con armas largas al hombro; el
      // cover conserva su pose (afinada para la protección) y pistola/bazooka
      // ya sostenían el arma sin atravesar el pecho
      adsBody = !aimingFromCover && (adsPose.blade ?? 0) > 0;
      const chestYaw=aimingFromCover?-.35:0;
      // ADS sustituye a la postura de cadera: su perfil ya no cuenta
      refYaw = adsBody ? adsPose.blade : 0; hipHold = false;
      R(this.aimRig, pitch - rootRotX - torsoPitch, (p.aimYawErr ?? 0)-chestYaw, lean * 0.1);
      R(this.torso, torsoPitch, chestYaw - (adsBody ? adsPose.blade : 0), -lean * 0.22);
      R(this.head, pitch * adsPose.head, 0, lean * 0.08);
      // Pistola extendida, armas largas apoyadas y bazooka alta al hombro.
      // Cero rotación local evita que el modelo prometa otra dirección.
      // Left-edge support: move the two-handed grip slightly toward the
      // opening, not the barrel axis toward the wall. IK still limits reach.
      M(adsPose.mount[0] - (aimingFromCover&&lean<0?.035:0), adsPose.mount[1] - (aimingFromCover&&poseKey!=='bazooka'?.12:0),
        adsPose.mount[2] - (coverPose?.gunForward ?? 0) - (aimingFromCover&&poseKey!=='pistol'&&poseKey!=='bazooka'?.32:(adsBody?adsPose.fwd:0)), 0, 0, 0);
      if (coverPose) {
        hipsY = coverPose.hipsY;
        aimRigY = coverPose.aimRigY;
      }
      // aim-over: alzada del conjunto completo (hombros+brazos+arma) para
      // librar un borde cercano que tapa el cañón. La intención de cámara no
      // cambia: sube el origen físico de la bala, no el punto prometido.
      aimRigY += p.aimLift ?? 0;
      if (lean) {
        // piernas plantadas hacia la pared, torso fuera de la esquina
        const crouched=p.state==='cover_low';
        R(this.legL.hip, crouched?1.7:0, 0, -0.1);
        R(this.legR.hip, crouched?1.7:0, 0, 0.1);
        if(crouched){R(this.legL.knee,-2.2,0,0);R(this.legR.knee,-2.2,0,0);}
      }
    } else if (p.state !== 'dead') {
      // Sin ADS no existe intención óptica central. El cañón conserva la pose
      // física de hip/blindfire y la HUD proyecta ese eje real. Mantener una
      // sola orientación antes/durante el disparo evita el antiguo salto sin
      // convertir hip fire en ADS oculto.
      const yawErr = p.aimYawErr ?? 0;
      if (p.state.startsWith('blind_')) {
        // Side blindfire compensates the actual chest once, after pose
        // interpolation below. The existing over-cover gesture stays intact.
        if(p.state==='blind_over'){
          set(this.aimRig.rotation, 'x', pitch + .05);
          set(this.aimRig.rotation, 'y', yawErr);
        }
      } else if (p.state === 'cover_low' || p.state === 'cover_high') {
        set(this.aimRig.rotation, 'x', p.firing ? pitch : 0);
        set(this.aimRig.rotation, 'y', p.firing ? yawErr : 0);
      } else if (p.state === 'dive' || p.state === 'slide') {
        // sin target explícito, dive/slide heredaban el pitch/yaw del frame
        // anterior y el arma quedaba apuntando al cielo mientras ruedas
        set(this.aimRig.rotation, 'x', 0);
        set(this.aimRig.rotation, 'y', 0);
      } else if (p.state !== 'roadie' && p.state !== 'flip' && p.state !== 'mantle' &&
                 p.state !== 'melee') {
        // (roadie, flip, mantle y melee fijan su propio aimRig dentro del switch)
        // Low-ready acompaña solo parte del pitch y permanece ligado al cuerpo.
        // No cambia al apretar fire: muzzle, retícula y primer tiro ya estaban
        // alineados con esta misma trayectoria física en el frame anterior.
        set(this.aimRig.rotation, 'x', pitch * 0.85);
        set(this.aimRig.rotation, 'y', 0);
      }
      // el roll del lean de ADS no debe quedarse pegado en hipfire
      if(!/^blind_(high|low)_/.test(p.state))set(this.aimRig.rotation, 'z', 0);
    }

    // recarga solo en posturas con el arma al frente (en dive/slide/roadie/
    // blind_over el gunMount/brazo izq. tienen pose propia: pisarla inclinaba
    // el arma fuera de la mano) — misma whitelist que el IK de recarga
    const reloadPose = p.reloading &&
      (p.state === 'idle' || p.state === 'run' || p.state === 'jump' ||
       p.state === 'cover_low' || p.state === 'cover_high');

    // cambio de arma: el arma barre hacia el hombro/espalda y regresa
    // (el modelo se intercambia a mitad del gesto, en Weapons.update)
    // Progreso real del cambio: un reloj desde el flanco de `swapping` (main,
    // remotos y bots solo envían el booleano; dura SWAP_TIME de weapons.js) y
    // la mitad la marca el cambio REAL de modelo: hasta que llega se guarda
    // el arma que sale, después se saca la que entra. Encadenado (cola de
    // Weapons) = un ciclo nuevo; soltado (melee, muerte) = vuelve a su pose.
    if (!p.swapping || p.state === 'dead') { this._swapClock = undefined; this._swapPhase = null; }
    if (p.swapping && p.state !== 'dead') {
      // el arma va (y vuelve) de donde se guarda: espalda en diagonal o funda
      // en la parte baja de la espalda; el modelo se cambia a mitad del gesto.
      // Pasa por FUERA del hombro derecho: directo atravesaba pecho y brazo.
      if (!Number.isFinite(this._swapClock) ||
          (this._swapPhase === 'in' && this._swapClock - this._swapSwitch >= SWAP_HALF)) {
        this._swapClock = 0; this._swapFrom = this._wep; this._swapPhase = 'out';
      }
      this._swapClock += Math.max(0, dt || 0);
      if (this._swapPhase === 'out' && this._wep !== this._swapFrom) { this._swapPhase = 'in'; this._swapSwitch = this._swapClock; }
      const out = this._swapPhase === 'out';
      const f = out ? this._swapClock / SWAP_HALF : (this._swapClock - this._swapSwitch) / SWAP_HALF;
      if (out ? f < 0.4 : f > 0.45) M(SWAP_SIDE[0], SWAP_SIDE[1], SWAP_SIDE[2], SWAP_SIDE[3], SWAP_SIDE[4], SWAP_SIDE[5]);
      else {
        const e = this._swapPose(GL_E);
        M(GL_T.x, GL_T.y, GL_T.z, e.x, e.y, e.z);
      }
      set(this.aimRig.rotation, 'x', 0);
      set(this.aimRig.rotation, 'y', 0); // sin guiño lateral heredado del latch de tiro
    }

    // LANZAMIENTO de granada: overlay (se puede lanzar corriendo). Brazo
    // atrás por encima del hombro y latigazo al frente; el bote sale en el
    // punto de release que controla main, así la mano y el proyectil
    // coinciden.
    this._throwExact = null;
    if (p.throwT > 0 && p.state !== 'dead') {
      const total = p.throwTotal || 0.5;
      let ph = 1 - Math.max(0, Math.min(1, p.throwT / total)); // 0→1
      // En el cuadro de la suelta la mano se evalúa EXACTAMENTE en la fase de
      // suelta: main la decide en el primer cuadro que la cruza y a 30 Hz ese
      // cuadro llegaba hasta 33 ms más tarde (mano ~10 cm más abajo que a 60).
      const def = TUNING.weapons[this._wep]?.throwRelease ? TUNING.weapons[this._wep] : TUNING.weapons.grenade;
      const relPh = def.throwRelease / (def.throwTime || total);
      // La diferencia se recupera en ~0,1 s (sin parar el gesto en seco).
      if (p.throwReleased && !this._throwWasReleased && ph >= relPh && ph < relPh + 0.2) this._throwLag = ph - relPh;
      else this._throwLag = (this._throwLag ?? 0) * Math.exp(-dt / 0.04);
      ph -= this._throwLag;
      // Tres tiempos CONTINUOS y con curva: armar (0→0.36), latigazo
      // (0.36→0.66, el bote sale a ~0.56 con el brazo ya al frente) y
      // acompañamiento, que devuelve el cuerpo a su pose base mezclando en
      // vez de soltarla de golpe. Antes el torso saltaba a mitad del gesto y
      // el bote salía con el brazo todavía atrás.
      const ease = (x) => x * x * (3 - 2 * x);
      const wind = ease(Math.min(1, ph / 0.36));
      const whip = ph < 0.36 ? 0 : ease(Math.min(1, (ph - 0.36) / 0.30));
      const weight = ph < 0.66 ? ease(Math.min(1, ph / 0.24)) : 1 - ease((ph - 0.66) / 0.34);
      // Pose del gesto sin suavizado: la mezcla con la base ya es continua y
      // así la mano está en el mismo sitio a 30, 60 o 144 Hz.
      // mapas propios reutilizados (antes uno nuevo por cuadro)
      const exact = this._throwExact = this._throwExactMap ??= new Map();
      for (const keys of exact.values()) keys.clear();
      const kb = 1 - Math.exp(-Math.max(damp, 30) * dt);
      const B = this._throwBase ??= new Map();
      const blend = (o, key, v, rel = false) => {
        // base: la pose de siempre, suavizada aparte (sin el gesto encima)
        const target = T.get(o)?.[key] ?? o[key];
        let store = B.get(o);
        if (!store) B.set(o, store = {});
        const base = store[key] = (store[key] ?? o[key]) + (target - (store[key] ?? o[key])) * kb;
        set(o, key, rel ? base + v * weight : base + (v - base) * weight);
        let keys = exact.get(o);
        if (!keys) exact.set(o, keys = new Set());
        keys.add(key);
      };
      blend(this.torso.rotation, 'x', -0.06 * wind + 0.22 * whip);
      // giro del pecho: al armar se perfila un poco MÁS desde su postura
      // (hombro derecho atrás; antes iba a un giro absoluto y desde la
      // perfilada de cadera, HIP_BLADE, saltaba 0,24 rad por cuadro) y el
      // latigazo lo trae de frente
      {
        const base = B.get(this.torso.rotation)?.y ?? this.torso.rotation.y;
        blend(this.torso.rotation, 'y', -0.25 * wind + (THROW_WHIP_YAW - (base - 0.25)) * whip, true);
      }
      blend(this.torso.rotation, 'z', 0);
      blend(this.gunMount.position, 'x', 0.3 + 0.08 * wind - 0.3 * whip);
      blend(this.gunMount.position, 'y', 0.28 + 0.22 * wind - 0.6 * whip);
      blend(this.gunMount.position, 'z', 0.22 * wind - 0.7 * whip);
      blend(this.gunMount.rotation, 'x', -1.5 * wind + 2.2 * whip);
      blend(this.gunMount.rotation, 'y', -0.5 * wind + 0.7 * whip);
      blend(this.gunMount.rotation, 'z', 0);
      // el brazo debe SEGUIR la curva: con el suavizado normal de la pose
      // llegaba tarde al latigazo
      damp = Math.max(damp, 30);
      blend(this.aimRig.rotation, 'x', 0);
      blend(this.aimRig.rotation, 'y', 0);
      leftOnGun = false;
      // el brazo libre equilibra el gesto (antes se quedaba congelado donde estuviera)
      blend(this.armL.shoulder.rotation, 'x', 0.55 - 0.5 * whip);
      blend(this.armL.shoulder.rotation, 'y', 0);
      blend(this.armL.shoulder.rotation, 'z', -0.35);
      blend(this.armL.elbow.rotation, 'x', 0.9);
      // el bote ya voló: la mano queda vacía el resto del gesto
      if (this.activeGun.userData.thrown) this.activeGun.visible = !p.throwReleased;
    } else if (this.activeGun.userData.thrown && !this.rag) {
      this.activeGun.visible = true;
    }
    this._throwWasReleased = p.throwT > 0 && !!p.throwReleased;
    if (!(p.throwT > 0)) { this._throwLag = 0; this._throwBase?.clear(); }

    // recarga: el arma gira hacia la mano izquierda según la fase de cada
    // arma (RELOAD_GESTURES); el bombeo de la escopeta tras el último cartucho
    const gesture = RELOAD_GESTURES[this._wep === 'stun' ? 'pistol' : this._wep];
    // Bombeo solo si la recarga TERMINÓ: lo que le faltaba en el cuadro
    // anterior cabía en este (weapons.js mete el último cartucho y suelta
    // `reloading`). Cancelar (disparo, melee, cambio) la corta antes.
    if (this._wep === 'shotgun' && this._reloadWas && !p.reloading && p.state !== 'dead' &&
        (1 - (this._reloadLastT ?? 0)) * TUNING.weapons.shotgun.reloadTime <= dt + 1e-4) this._pumpT = 0;
    this._reloadWas = !!p.reloading && reloadPose;
    this._reloadLastT = p.reloadT ?? 0;
    if (this._pumpT !== undefined) {
      this._pumpT += dt;
      if (this._pumpT > PUMP_TIME || p.state === 'dead' || p.reloading || p.swapping || this._wep !== 'shotgun') this._pumpT = undefined;
    }
    if (reloadPose && gesture && p.state !== 'dead') {
      const k = reloadKey(gesture.tilt, p.reloadT ?? 0);
      set(this.gunMount.rotation, 'x', k[0]);
      set(this.gunMount.rotation, 'z', k[1]);
    }

    // Encaje direccional del impacto sobre la pose que ya tenía la víctima.
    // En melee dura más y compromete hombros/cadera; un disparo conserva una
    // reacción menor. Nunca sustituye locomoción, cover ni aiming.
    if (this._hitReact && p.state !== 'dead') {
      const r = this._hitReact;
      r.t += dt;
      const q = Math.min(1, r.t / r.dur);
      if (r.kind === 'kick') {
        // PATADA RECIBIDA. De frente: el cuerpo se dobla sobre el vientre, la
        // cabeza cae, los brazos se abren y la pelvis se hunde; luego se
        // recompone tambaleándose. Por la espalda: se arquea hacia atrás.
        const env = (q < 0.16 ? Math.sin(q / 0.16 * Math.PI / 2) : Math.pow(Math.cos((q - 0.16) / 0.84 * Math.PI / 2), 1.4)) * r.strength;
        const dirS = r.back ? 0.6 : -1;
        const wob = Math.sin(q * 15) * (1 - q) * r.strength;
        add(this.torso.rotation, 'x', dirS * 0.62 * env);
        add(this.torso.rotation, 'y', -r.side * 0.3 * env);
        add(this.torso.rotation, 'z', wob * 0.09);
        add(this.head.rotation, 'x', dirS * 0.34 * env);
        add(this.head.rotation, 'z', -wob * 0.1);
        add(this.armL.shoulder.rotation, 'x', 0.5 * env); add(this.armL.shoulder.rotation, 'z', -0.42 * env);
        add(this.armR.shoulder.rotation, 'x', 0.42 * env); add(this.armR.shoulder.rotation, 'z', 0.36 * env);
        add(this.armL.elbow.rotation, 'x', 0.3 * env);
        hipsY -= 0.085 * env;
        rootRotX += (r.back ? -0.1 : 0.12) * env;         // todo el cuerpo cede hacia donde lo empujan
        if (q >= 1) this._hitReact = null;
      }
      const wave = r.kind === 'kick' ? 0 : Math.sin(Math.PI * q) * r.strength;
      const melee = r.kind === 'melee';
      const side = Math.abs(r.side) > 0.12 ? r.side : 0.35;
      add(this.torso.rotation, 'x', (melee ? 0.24 : 0.1) * wave);
      add(this.torso.rotation, 'y', -side * (melee ? 0.38 : 0.16) * wave);
      add(this.torso.rotation, 'z', side * (melee ? 0.15 : 0.07) * wave);
      add(this.head.rotation, 'x', (melee ? 0.2 : 0.08) * wave);
      add(this.head.rotation, 'y', side * (melee ? 0.28 : 0.12) * wave);
      add(this.armL.shoulder.rotation, 'x', (melee ? 0.18 : 0.08) * wave);
      add(this.armR.shoulder.rotation, 'x', (melee ? 0.22 : 0.08) * wave);
      if (q >= 1) this._hitReact = null;
    }

    if(this.stunned&&p.state!=='dead'){
      this._stunPhase=(this._stunPhase??0)+dt;
      add(this.torso.rotation,'z',Math.sin(this._stunPhase*26)*.025);
      add(this.head.rotation,'x',.08+Math.sin(this._stunPhase*22)*.025);
    }
    // recoil: empuja el conjunto brazos+arma hacia atrás
    this._recoil = Math.max(0, this._recoil - dt * 6);
    this.aimRig.position.z = this._recoil * 0.06;
    set(this.aimRig.position, 'x', aimRigX);
    set(this.aimRig.position, 'y', aimRigY);

    // A planted standing firing stance: outward thighs, staggered knees and
    // level shins/boots. Never inherit the resting-cover knee rotation while
    // replacing just the hips (that pinched the knees and tipped the soles).
    const standingCoverFire = (p.aim && p.state === 'cover_high') ||
      p.state === 'blind_high_left' || p.state === 'blind_high_right';
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]]) {
      set(leg.hip.position, 'y', .02);
      if (standingCoverFire) {
        const bend = side < 0 ? .48 : .14;
        const spread = side * .20;
        R(leg.hip, bend, 0, spread);
        // rodilla algo flexionada: el apoyo (_groundLegs) lleva cada suela al
        // suelo y deja el pie plano, sin mover pelvis, arma ni holgura del tiro
        R(leg.knee, -0.3, 0, 0);
      }
    }

    // Fast trigger entry is not a fast lateral transfer. While ADS remains
    // held, crossing edge/over/edge changes pelvis height and arm targets;
    // the fire-entry rate used to finish 80% of that change in one frame.
    const coverAds = !!p.aim && p.state.startsWith('cover_');
    const coverSection = p.coverLean ?? 0;
    if (coverAds && this._previousCoverAds && coverSection !== this._previousCoverSection) {
      this._coverTransferTime = .24;
    }
    if (!coverAds) this._coverTransferTime = 0;
    const transferringCover = coverAds && (this._coverTransferTime ?? 0) > 0;
    this._coverTransferTime = Math.max(0, (this._coverTransferTime ?? 0) - dt);
    this._previousCoverAds = coverAds;
    this._previousCoverSection = coverSection;
    // aplicar targets con damping
    if ((p.aim && p.state.startsWith('cover_')) || p.state.startsWith('blind_')) {
      damp = Math.max(damp, TUNING.cover.firePoseRate);
    }
    if (transferringCover) damp = 14;
    // ATERRIZAJE: al tocar suelo la pelvis cede y se recupera, más cuanto más
    // rápida era la caída. Las piernas se doblan solas: las coloca la marcha.
    const airNow = p.state === 'jump' || p.state === 'flip';
    if (this._wasAir && !airNow && p.state !== 'dead' && p.state !== 'mantle') {
      this._land = { t: 0, amp: Math.min(1, Math.max(0.25, -(this._airVy ?? -4) / 7)) };
    }
    this._wasAir = airNow;
    let landDrop = 0;
    if (this._land) {
      this._land.t += dt;
      const q = this._land.t / 0.26;
      if (q >= 1) this._land = null;
      else landDrop = Math.sin(Math.PI * Math.sqrt(q)) * 0.11 * this._land.amp; // baja rápido, sube despacio
    }
    hipsY -= landDrop;
    if (landDrop) add(this.torso.rotation, 'x', -landDrop * 1.4);
    const k = 1 - Math.exp(-damp * dt);
    const exact = this._throwExact;
    for (const [o, props] of T) {
      const keys = exact?.get(o);
      for (const prop in props) o[prop] += (props[prop] - o[prop]) * (keys?.has(prop) ? 1 : k);
    }
    this._aimRef(refPitch, refYaw, refRoll, refLift, k);
    // desplazamiento lateral de cadera al asomarse (lean)
    const hipsX = p.aim && p.coverLean ? -p.coverLean * 0.02 : 0;
    this.hips.position.x += (hipsX - this.hips.position.x) * k;
    // el aterrizaje no espera al suavizado de la pose: es un golpe
    this.hips.position.y += (hipsY - this.hips.position.y) * (landDrop ? Math.max(k, 1 - Math.exp(-34 * dt)) : k);
    this.root.rotation.x += (rootRotX - this.root.rotation.x) * (1 - Math.exp(-10 * dt));

    // RESOLVEDOR DE MARCHA: coloca cada pie donde le toca y resuelve la pierna
    // por cinemática inversa. En el apoyo el pie retrocede a la velocidad del
    // cuerpo (no patina); en el vuelo vuelve adelante levantándose. Los pasos
    // van en la dirección real del movimiento: de lado y hacia atrás también.
    const walking = (locomotionState === 'run' || locomotionState === 'idle' || locomotionState === 'roadie') && !standingCoverFire;
    this._legBlend = walking ? Math.min(1, (this._legBlend ?? 0) + dt / 0.12) : 0;
    if (walking) {
      // peso del paso: entra y sale más despacio que la cadencia, para que al
      // parar el pie en vuelo baje a su sitio en vez de saltar a él
      this._gaitW = (this._gaitW ?? 0) + ((gaitTarget > .02 ? 1 : 0) - (this._gaitW ?? 0)) * (1 - Math.exp(-8 * dt));
      const m = this._gaitW;
      const sprint = locomotionState === 'roadie';
      const dirX = gSide / gLen, dirZ = -gFwd / gLen;             // el cuerpo mira a -z
      // largo del apoyo: lo que el pie puede barrer sin despegarse del suelo
      const reach = (sprint ? 0.70 : 0.60) * (1 - 0.34 * sideness) * (1 - 0.12 * backness);
      const stance = Math.min(reach, gv * 0.2);
      const duty = Math.min(0.62, stance / gaitCycle + 1e-4);
      const liftH = (0.07 + 0.2 * sp) * (sprint ? 1.2 : 1);
      const hipDrop = (sprint ? 0.02 : 0.05) * m * Math.min(1, sp * 1.6) * (1 - classic);
      // carrera clásica: ángulos directos con el suavizado general de la pose
      const cw = this._strideWeight, cAmp = sprint ? 1.05 : 0.75, cKnee = sprint ? 1.5 : 1.1, cBase = sprint ? 0.2 : 0.1;
      this._cls ??= [0, 0, 0, 0];
      const kl = 1 - Math.exp(-(18 + 72 * this._legBlend) * dt);
      const g0 = ph / (Math.PI * 2);
      for (const [leg, side, off] of [[this.legL, -1, 0], [this.legR, 1, 0.5]]) {
        const ci = side < 0 ? 0 : 2, cs = side < 0 ? cSwing : -cSwing;
        this._cls[ci] += (cs * cAmp * cw - this._cls[ci]) * k;
        this._cls[ci + 1] += (-(Math.max(0, -cs) * cKnee + cBase) * cw - this._cls[ci + 1]) * k;
        const u = (((g0 + off) % 1) + 1) % 1;
        let s, lift = 0;
        if (u < duty) s = stance * (0.5 - u / duty);              // apoyo
        else {
          const w = (u - duty) / (1 - duty), e = w * w * (3 - 2 * w);
          s = stance * (e - 0.5);
          lift = Math.sin(Math.PI * w) * liftH;                    // vuelo
        }
        // posición de reposo (pies algo abiertos y escalonados) → paso
        const restX = side * 0.17, restZ = side * 0.05;
        const fx = restX * (1 - 0.25 * m * (1 - sideness)) + dirX * s * m;
        const fz = restZ * (1 - m) + dirZ * s * m;
        const fy = lift * m;
        leg.hip.position.y += ((0.02 - hipDrop) - leg.hip.position.y) * kl;
        // vector cadera → tobillo (suela + altura medida de la bota), en el
        // marco de la pelvis; muslo y tibia medidos sobre el avatar
        const LEG_UP = leg.cal.up, LEG_LOW = Math.hypot(leg.ankle.position.y, leg.ankle.position.z);
        let vx = fx - (side * 0.15 + this.hips.position.x + leg.ankle.position.x), vy = fy + leg.cal.h - (this.hips.position.y + leg.hip.position.y), vz = fz;
        let d = Math.hypot(vx, vy, vz);
        const maxD = LEG_UP + LEG_LOW - 0.012;
        if (d > maxD) { const c = maxD / d; vx *= c; vy *= c; vz *= c; d = maxD; }
        d = Math.max(0.2, d);
        const knee = -(Math.PI - Math.acos(Math.max(-1, Math.min(1, (LEG_UP * LEG_UP + LEG_LOW * LEG_LOW - d * d) / (2 * LEG_UP * LEG_LOW)))));
        const a = -(LEG_UP + LEG_LOW * Math.cos(knee)), b = -LEG_LOW * Math.sin(knee);
        const rz = Math.asin(Math.max(-1, Math.min(1, vx / -a))) * (1 - classic);
        let rx = Math.atan2(vz, vy) - Math.atan2(b, a * Math.cos(rz));
        rx = Math.atan2(Math.sin(rx), Math.cos(rx)) * (1 - classic) + this._cls[ci] * classic;
        const kneeX = knee * (1 - classic) + this._cls[ci + 1] * classic;
        leg.hip.rotation.x += (rx - leg.hip.rotation.x) * kl;
        leg.hip.rotation.y += (0 - leg.hip.rotation.y) * kl;
        leg.hip.rotation.z += (rz - leg.hip.rotation.z) * kl;
        leg.knee.rotation.x += (kneeX - leg.knee.rotation.x) * kl;
        leg.knee.rotation.y += (0 - leg.knee.rotation.y) * kl;
        leg.knee.rotation.z += (0 - leg.knee.rotation.z) * kl;
      }
    }

    // vuelta en el aire alrededor de la cadera: eje según la dirección
    // ('z' = giro lateral Matrix, 'x' = backflip/frontflip)
    if (p.state === 'flip') {
      const ang = (p.flipT ?? 0) * Math.PI * 2;
      if ((p.flipAxis ?? 'z') === 'x') {
        this.hips.rotation.x = (p.flipDir ?? 1) * ang;
        this.hips.rotation.z = 0;
      } else {
        this.hips.rotation.z = -(p.flipDir ?? 1) * ang;
        this.hips.rotation.x = 0;
      }
    } else if (p.state !== 'dead') {
      // 2π ≡ 0: una vuelta completa aterriza limpia. Una vuelta CORTADA (se
      // aterriza antes de terminarla) ya no salta a cero: se recoge por el
      // camino corto.
      const settle = Math.exp(-11 * dt);
      for (const axis of ['x', 'z']) {
        const a = Math.atan2(Math.sin(this.hips.rotation[axis]), Math.cos(this.hips.rotation[axis]));
        this.hips.rotation[axis] = Math.abs(a) < 1e-3 ? 0 : a * settle;
      }
    }

    // física del ragdoll: peso muerto anclado al lugar de la muerte.
    // La rotación de caída ACELERA (gravedad) y para en seco contra el
    // suelo; ahí dispara el flop de extremidades del case 'dead'.
    if (p.state === 'dead' && this.rag) {
      const r = this.rag;
      const previousT=r.t;
      r.t += dt;
      this._updateCorpseVisual(Math.max(r.t, monotonicSeconds() - r.visualStartedAt));
      const fr = Math.exp(-6 * dt);
      // Integrate drag analytically: the death must carry the same momentum
      // at 30/60/144 Hz, not travel farther on a faster rendering client.
      r.ox += r.vx * (1-fr)/6; r.oz += r.vz * (1-fr)/6;
      r.vx *= fr; r.vz *= fr;
      // el cadáver COLISIONA: contra una pared choca, se frena y se apoya —
      // ya no la atraviesa deslizándose (collideFn lo inyecta quien tiene
      // el world, igual que groundFn)
      if (this.collideFn) {
        RAG_P.x = r.bx + r.ox; RAG_P.z = r.bz + r.oz;
        const px0 = RAG_P.x, pz0 = RAG_P.z;
        this.collideFn(RAG_P, r.by, RAGDOLL_R);
        if (RAG_P.x !== px0 || RAG_P.z !== pz0) { r.vx *= 0.35; r.vz *= 0.35; }
        r.ox = RAG_P.x - r.bx; r.oz = RAG_P.z - r.bz;
      }
      // el desplome de rodillas solo progresa CERCA del suelo, y NUNCA antes
      // de la reacción al impacto (r.reactT): primero el cuerpo encaja el
      // golpe con un paso trastabillado, DESPUÉS pierde el control
      const onGround = r.by <= r.floorY + 0.08;
      if (r.ang < 1) {
        if (onGround && r.t > r.reactT) {
          const fallDt=r.t-Math.max(previousT,r.reactT);
          r.ang = Math.min(1, (r.ang+.12)*Math.exp(7.5*fallDt)-.12);
          if (r.ang >= 1 && !r.hit) {
            r.hit = true; r.flopT = 0;
            r.vx *= 0.5; r.vz *= 0.5; // el golpe contra el suelo absorbe el arrastre
          }
        } else if (!onGround) {
          r.ang = Math.min(0.35, r.ang + dt * 0.6);
        }
      } else if (r.hit) {
        r.flopT += dt;
      }
      const fall = r.ang * r.ang; // ease-in: el desplome gana velocidad
      const a = fall * r.angTarget;
      if (r.axis === 'x') { this.hips.rotation.x = a; this.hips.rotation.z = r.tilt * fall; }
      else { this.hips.rotation.z = a; this.hips.rotation.x = r.tilt * fall; }
      // rodillas que ceden: la cadera baja con la caída (golpe, no flotación)
      this.hips.position.y = r.startHipY + (.29-r.startHipY)*fall;
      // gravedad hasta el suelo REAL bajo el cadáver (bloques incluidos)
      if (r.by > r.floorY) {
        r.vyy -= 22 * dt;
        r.by = Math.max(r.floorY, r.by + r.vyy * dt);
      }
      // Segundo probe sobre torso/cabeza. El círculo raíz evita que los pies
      // crucen paredes, pero una caída de 90° podía meter media armadura y el
      // arma en la geometría. Al corregir este punto desplazamos el cadáver
      // completo sin simular cada extremidad por separado.
      if (this.collideFn && fall > 0.04) {
        const deadYaw = r.byaw + r.spin * fall;
        const sign = Math.sign(a) || 1;
        let fx, fz;
        if (r.axis === 'x') {
          fx = Math.sin(deadYaw) * sign;
          fz = Math.cos(deadYaw) * sign;
        } else {
          fx = -Math.cos(deadYaw) * sign;
          fz = Math.sin(deadYaw) * sign;
        }
        const extent = 0.72 * fall;
        const wantX = r.bx + r.ox + fx * extent;
        const wantZ = r.bz + r.oz + fz * extent;
        RAG_P.x = wantX; RAG_P.z = wantZ;
        this.collideFn(RAG_P, r.by, 0.22);
        const cx = RAG_P.x - wantX, cz = RAG_P.z - wantZ;
        if (Math.abs(cx) + Math.abs(cz) > 1e-5) {
          r.ox += cx; r.oz += cz;
          r.vx *= 0.35; r.vz *= 0.35;
          // asegurar que la corrección del torso no empuje la raíz dentro de
          // otra pared en pasillos estrechos.
          RAG_P.x = r.bx + r.ox; RAG_P.z = r.bz + r.oz;
          this.collideFn(RAG_P, r.by, RAGDOLL_R);
          r.ox = RAG_P.x - r.bx; r.oz = RAG_P.z - r.bz;
        }
      }
      this.root.position.set(r.bx + r.ox, r.by, r.bz + r.oz);
      this.root.rotation.y = r.byaw + r.spin * fall;
      // Las armas en mano/espalda abandonan la silueta corporal; el pickup
      // separado queda junto al cadáver y comunica que ya no puede combatir.
      // La pistola enfundada se queda con el cuerpo (es parte de la silueta).
      for (const k in this.guns) {
        const g = this.guns[k];
        if (g.parent !== this.holsterMount) g.visible = r.t < 0.22;
      }
    } else if (p.state !== 'dead') {
      if (this.rag) {
        this.rag = null;
        this._restoreDeathVisuals();
        this.hips.position.y = 0.66; // sin "brotar" del suelo al revivir
        this._gaitSpeed=0;this._strideWeight=0;
      }
    }

    // De espaldas contra la cobertura alta el pecho se echa atrás y gira con
    // el paso lateral: el arma de la espalda (que va con el pecho) metía sus
    // extremos en la pared. Ahí se queda paralela al muro: deshace el giro
    // del pecho sobre el centro de la espalda.
    const bm = this.backMount;
    if (p.state === 'cover_high') GL_Q.copy(this.torso.quaternion).invert();
    else GL_Q.identity();
    bm.quaternion.slerp(GL_Q, 1 - Math.exp(-12 * dt));
    GL_V.set(STOW_BACK_X, STOW_BACK_Y, 0.45);
    bm.position.copy(GL_V).sub(GL_C.copy(GL_V).applyQuaternion(bm.quaternion));

    // apoyo de piernas: se guarda la pose propia y se ajusta al suelo real
    const F = this._legFK ??= new Float32Array(12);
    [this.legL, this.legR].forEach((leg, i) => {
      F[i * 6] = leg.hip.rotation.x; F[i * 6 + 1] = leg.hip.rotation.y; F[i * 6 + 2] = leg.hip.rotation.z;
      F[i * 6 + 3] = leg.knee.rotation.x; F[i * 6 + 4] = leg.knee.rotation.y; F[i * 6 + 5] = leg.knee.rotation.z;
    });
    const gaitOn = walking && p.state !== 'dead' ? 1 : 0;
    this._groundLegs(dt, gaitOn ? 0 : plantL, gaitOn ? 0 : plantR, gaitOn, legClamp, p.groundPitch ?? 0, gaitOn ? classic * (this._gaitW ?? 0) : 0);

    // IK: manos sobre el arma (después del damping, sobre la pose ya aplicada)
    // Keep the approved shoulder/barrel clearance while tucking the pelvis
    // and feet behind it. The torso, not detached arm sockets, carries lean.
    const supportedLean=p.aim&&p.state.startsWith('cover_')?(p.coverLean??0)*.12:0;
    this.torso.position.x+=(supportedLean-this.torso.position.x)*(1-Math.exp(-(transferringCover?14:TUNING.cover.firePoseRate)*dt));
    if (ikArms) {
      if(/^blind_(high|low)_/.test(p.state)){
        // Counter-rotate the actual interpolated chest, not its future target.
        // Independently damping both rotations left a one-frame inward shot
        // when the body finished turning from its back-to-wall resting pose.
        BLIND_DIRECTION_Q.setFromEuler(BLIND_EULER.set(pitch,p.aimYawErr??0,0));
        // (pelvis·pecho)⁻¹: la dirección del tiro sigue relativa a la raíz
        this.aimRig.quaternion.copy(this.hips.quaternion).multiply(this.torso.quaternion).invert().multiply(BLIND_DIRECTION_Q);
      }
      this.root.updateWorldMatrix(true, true);
      const gun = this.activeGun;
      let blindSupport=null;
      if(/^blind_(high|low)_/.test(p.state)){
        // Near-receiver support in blindfire, instead of the long ADS forend
        // reach which pulled the far shoulder and head out of cover.
        blindSupport=gun.userData.blindSupport;
        if(!blindSupport){blindSupport=new THREE.Group();gun.add(blindSupport);gun.userData.blindSupport=blindSupport;}
        gun.userData.grip.getWorldPosition(TMP_A);
        (gun.userData.forend??gun.userData.aimSupport??gun.userData.grip).getWorldPosition(TMP_B);
        TMP_A.lerp(TMP_B,.25);gun.worldToLocal(TMP_A);blindSupport.position.copy(TMP_A);
        this.root.updateWorldMatrix(true,true);
      }
      const coverPoseActive=p.state.startsWith('cover_')||p.state.startsWith('blind_');
      // ADS también ancla los hombros al pecho: desplazar el aimRig ya no
      // separa la hombrera derecha del torso ni hunde la izquierda en él.
      const anchored=coverPoseActive||adsBody;
      // The aim pivot may move/rotate the gun, never detach the shoulder
      // sockets from the chest. Express fixed chest sockets in aim space.
      // al entrar/salir de ADS el anclaje se mezcla (cover/blind: inmediato)
      // (la cadera perfilada también: el aimRig ya no gira con el pecho)
      // (primer cuadro: arranca anclado, sin hombros sueltos al construir el rig)
      const anchorT=adsBody||hipHold?1:0;
      this._anchorW=coverPoseActive?1:(this._anchorW??anchorT)+(anchorT-(this._anchorW??anchorT))*(1-Math.exp(-16*dt));
      for(const [arm,side] of [[this.armL,-1],[this.armR,1]]){
        if(this._anchorW>1e-3){
          TMP_A.set(side*.36,.5,0);
          this.torso.localToWorld(TMP_A);
          this.aimRig.worldToLocal(TMP_A);
          arm.shoulder.position.set(side*.36,0,0).lerp(TMP_A,this._anchorW);
        }else arm.shoulder.position.set(side*.36,0,0);
      }
      // ADS con arma larga: la izquierda sujeta el punto más adelantado del
      // arma (grip→guardamanos) que el brazo alcanza. Antes el guardamanos
      // fuera de alcance arrastraba el arma hacia atrás y la culata cruzaba
      // pecho y hombrera.
      let adsSupport=null;
      if((adsBody||(hipHold&&!p.aim)||p.state==='slide')&&leftOnGun&&!gun.userData.oneHand&&gun.userData.forend&&!reloadPose){
        adsSupport=gun.userData.adsSupportNode;
        if(!adsSupport){adsSupport=new THREE.Group();gun.add(adsSupport);gun.userData.adsSupportNode=adsSupport;}
        this.root.updateWorldMatrix(true,true);
        gun.userData.grip.getWorldPosition(TMP_A);this.aimRig.worldToLocal(TMP_A);
        gun.userData.forend.getWorldPosition(TMP_B);this.aimRig.worldToLocal(TMP_B);
        const reach=L1+L2-.05,sh=this.armL.shoulder.position;
        let best=0;
        for(let q=20;q>=0;q--){const f=q/20;IK_E.copy(TMP_A).lerp(TMP_B,f);if(IK_E.distanceTo(sh)<=reach){best=f;break;}}
        // el asidero se desliza suave (sin saltos de un cuadro a otro)
        this._adsS=this._adsGun===gun?(this._adsS??best)+(best-(this._adsS??best))*(1-Math.exp(-14*dt)):best;
        this._adsGun=gun;
        gun.userData.grip.getWorldPosition(TMP_A);gun.userData.forend.getWorldPosition(TMP_B);
        TMP_A.lerp(TMP_B,this._adsS);gun.worldToLocal(TMP_A);adsSupport.position.copy(TMP_A);
        this.root.updateWorldMatrix(true,true);
      }
      // expuesto solo mientras la mano lo usa (diagnóstico/pruebas)
      gun.userData.adsSupport=adsSupport??undefined;
      if(anchored){
        if(blindSupport){
          // A side-on torso lets both hands reach around the edge while the
          // head stays inside it. Position the real grip, not a guessed mount.
          const side=p.state.endsWith('_left')?-1:1;
          const crouched=p.state.startsWith('blind_low_');
          TMP_A.set(side*.46,crouched?.46:.50,(side<0?0:.04)-(crouched?.18:0));
          // el punto era de la pelvis sin girar: deshacer su giro lo deja igual en mundo
          TMP_A.applyAxisAngle(AXIS_Y,-this.hips.rotation.y);this.hips.localToWorld(TMP_A);
          this.aimRig.worldToLocal(TMP_A);
          gun.userData.grip.getWorldPosition(TMP_B);this.aimRig.worldToLocal(TMP_B);
          this.gunMount.position.add(TMP_A.sub(TMP_B));
          this.root.updateWorldMatrix(true,true);
        }
        // Fit the weapon to both arms instead of stretching an arm toward an
        // unreachable grip. Translation preserves the physical barrel axis.
        const grips=[[this.armR,gun.userData.grip],
          ...(leftOnGun&&(!gun.userData.oneHand||blindSupport)?[[this.armL,blindSupport??adsSupport??gun.userData.forend]]:[])];
        for(let pass=0;pass<8;pass++)for(const [arm,anchor] of grips){
          if(!anchor)continue;
          this.root.updateWorldMatrix(true,true);
          anchor.getWorldPosition(TMP_A);this.aimRig.worldToLocal(TMP_A);
          TMP_B.copy(TMP_A).sub(arm.shoulder.position);
          const distance=TMP_B.length(),reach=L1+L2-(blindSupport?.025:.04);
          if(distance>reach)this.gunMount.position.addScaledVector(TMP_B,(reach-distance)/distance);
        }
        this.root.updateWorldMatrix(true,true);
      }
      // peso de entrada del IK por brazo: 0 al reengancharse, exacto a los 0,14 s
      this._shoulderW = (this._shoulderW ?? 0) + ((p.aim ? 1 : 0) - (this._shoulderW ?? 0)) * (1 - Math.exp(-16 * dt));
      this._ikR = Math.min(1, (this._ikR ?? 1) + dt / 0.14);
      const blendIn = (t) => t >= 1 ? 1 : 1 - Math.exp(-26 * dt);
      gun.userData.grip.getWorldPosition(TMP_A);
      this.aimRig.worldToLocal(TMP_A);
      // la derecha sale del grip solo en el cerrojo del sniper; vuelve suave
      const rightGesture = reloadPose && gesture?.right;
      this._rReload = (this._rReload ?? 0) + ((rightGesture ? 1 : 0) - (this._rReload ?? 0)) * (1 - Math.exp(-22 * dt));
      if (this._rReload > 1e-3 && RELOAD_GESTURES.sniper.right) {
        this._reloadTarget(gun, RELOAD_GESTURES.sniper.right, rightGesture ? (p.reloadT ?? 0) : 0, TMP_B);
        TMP_A.lerp(TMP_B, this._rReload);
      }
      this._ikArm(this.armR, 1, TMP_A, coverPoseActive ? (p.aim ? 1 : 0) : this._shoulderW, blendIn(this._ikR));
      // el gesto de recarga solo aplica en posturas con el arma al frente
      // (misma whitelist que reloadPose, calculada arriba). Las armas de una
      // mano (granada) no lleva la izquierda al arma; la pistola sí usa apoyo
      // de dos manos únicamente al apuntar.
      const reloadIk = reloadPose && !!gesture;
      const pumping = this._pumpT !== undefined && !reloadIk && !gun.userData.oneHand;
      const oneHand = !!gun.userData.oneHand;
      const pistolAimSupport = p.aim ? gun.userData.aimSupport : null;
      if ((leftOnGun && (!oneHand || pistolAimSupport || blindSupport)) || reloadIk || pumping) {
        // recarga y bombeo: un asidero propio que recorre las fases del gesto
        const live = reloadIk || pumping ? (gun.userData.reloadHand ??= anchor(gun, 0, 0, 0)) : null;
        const a = live ?? (blindSupport ?? pistolAimSupport ?? adsSupport ?? gun.userData.forend);
        let tgt;
        if (live) {
          if (reloadIk) this._reloadTarget(gun, gesture.left, p.reloadT ?? 0, TMP_B);
          else {
            // bombeo: el guardamanos atrás y adelante
            const q = Math.sin(Math.PI * Math.min(1, this._pumpT / PUMP_TIME));
            this._reloadTarget(gun, PUMP_KEYS, q, TMP_B);
          }
          tgt = TMP_B;
        } else {
          a.getWorldPosition(TMP_B);
          tgt = this.aimRig.worldToLocal(TMP_B);
        }
        // cambiar de asidero (guardamanos ↔ cargador ↔ apoyo de pistola) también entra suave
        if (a !== this._ikLAnchor) { this._ikLAnchor = a; this._ikL = 0; }
        this._ikL = Math.min(1, (this._ikL ?? 1) + dt / 0.14);
        this._ikArm(this.armL, -1, tgt, reloadIk ? 0 : (coverPoseActive ? (p.aim ? 1 : 0) : this._shoulderW), blendIn(this._ikL));
      } else if (p.state === 'blind_over') {
        // palma izquierda sobre el borde del bloque (entra suave como un asidero)
        const P0 = BLIND_OVER.palm;
        TMP_B.set(P0[0], P0[1], P0[2]); this.root.localToWorld(TMP_B);
        const tgt = this.aimRig.worldToLocal(TMP_B);
        if (this._ikLAnchor !== 'palm') { this._ikLAnchor = 'palm'; this._ikL = 0; }
        this._ikL = Math.min(1, (this._ikL ?? 1) + dt / 0.14);
        this._ikArm(this.armL, -1, tgt, 0, blendIn(this._ikL));
      } else {
        this._ikL = 0;
        // Brazo libre (pistola/granada en la cadera, al soltar el apoyo de
        // ADS): sin pose propia el brazo se quedaba con la mano ahuecada
        // donde estuvo el arma. Cuelga relajado y acompaña el paso.
        if (!T.has(this.armL.shoulder.rotation)) {
          const kf = 1 - Math.exp(-10 * dt), sw = this._strideWeight ?? 0;
          GL_Q.setFromEuler(GL_E.set(0.12 + Math.cos(this.phase) * 0.35 * sw, 0, -0.14, 'XYZ'));
          this.armL.shoulder.quaternion.slerp(GL_Q, kf);
          this.armL.elbow.rotation.set(this.armL.elbow.rotation.x + (0.35 + 0.25 * sw - this.armL.elbow.rotation.x) * kf, 0, 0);
        }
      }
    } else {
      this._ikR = 0; this._ikL = 0;
      // Sin IK (muerte, ragdoll) los hombros siguen en su encaje del pecho:
      // anclados en cadera/ADS, al girar luego el aimRig se quedaban 26 cm
      // detrás y la hombrera atravesaba el arma de la espalda.
      if ((this._anchorW ?? 0) > 1e-3) {
        this.root.updateWorldMatrix(true, true);
        for (const [arm, side] of [[this.armL, -1], [this.armR, 1]]) {
          TMP_A.set(side * .36, .5, 0);
          this.torso.localToWorld(TMP_A);
          this.aimRig.worldToLocal(TMP_A);
          arm.shoulder.position.set(side * .36, 0, 0).lerp(TMP_A, this._anchorW);
        }
      }
    }
  }

  setTransform(x, z, yaw, y = 0) {
    // La altura se sigue con un suavizado corto mientras se pisa suelo: un
    // escalón de 16 cm ya no es un salto de un cuadro en la figura. Saltos,
    // caídas, muerte y recolocaciones grandes van sin suavizar.
    this._footY = y;
    const snap = this._ySnap || this._visY === undefined || Math.abs(y - this._visY) > 0.3;
    if (snap) this._visY = y;
    this.root.position.set(x, this._visY, z);
    this.root.rotation.y = yaw;
  }

  setVisible(v) { this.root.visible = v; }

  // Spawn protection: OUTLINE sutil del color del equipo — silueta de
  // contorno (backface escalado), no cubre el cuerpo
  setProtected(on) {
    if (this._prot === on) return;
    this._prot = on;
    if (on && !this._outlines) this._buildOutline();
    if (this._outlines) for (const o of this._outlines) o.visible = on;
  }

  _buildOutline() {
    // Cuerpo fusionado: UN contorno que comparte geometría y esqueleto.
    const body = this._bodyMesh;
    if (body) {
      this._outlineMat = soldierOutlineMaterial(SOLDIER_TEAM[this.team]);
      const o = new THREE.SkinnedMesh(body.geometry, this._outlineMat);
      o.name = 'soldier-outline';
      o.bind(body.skeleton, body.bindMatrix);
      o.boundingSphere = body.boundingSphere;
      o.visible = false;
      this.root.add(o);
      this._outlines = [o];
      return;
    }
    this._outlineMat = new THREE.MeshBasicMaterial({
      color: TEAM_COLORS[this.team],
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.45,
    });
    const pairs = [];
    const collect = (node) => {
      if (node.userData.blenderSourceHidden) return;
      if (node === this.gunMount || node === this.backMount || node === this.nameTag) return;
      if (node.isMesh) pairs.push(node);
      for (const c of node.children) collect(c);
    };
    collect(this.root);
    this._outlines = pairs.map((mesh) => {
      const o = mesh.isSkinnedMesh
        ? new THREE.SkinnedMesh(mesh.geometry,this._outlineMat)
        : new THREE.Mesh(mesh.geometry, this._outlineMat);
      if(mesh.isSkinnedMesh){o.bind(mesh.skeleton,mesh.bindMatrix);o.frustumCulled=false;}
      o.position.copy(mesh.position);
      o.rotation.copy(mesh.rotation);
      o.scale.copy(mesh.scale).multiplyScalar(1.05);
      o.visible = false;
      mesh.parent.add(o);
      return o;
    });
  }

  dispose(scene) {
    this._disposed = true;
    this._restoreDeathVisuals();
    scene.remove(this.root);
    const geos = new Set(), mats = new Set(), maps = new Set();
    this.root.traverse((o) => {
      if (o.geometry && !o.geometry.userData.shared) geos.add(o.geometry);
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m.userData.shared) return;
          if (m.map && !m.map.userData.cached) maps.add(m.map);
          mats.add(m);
        });
      }
    });
    for (const g of geos) g.dispose();
    for (const t of maps) t.dispose(); // CanvasTexture única del nametag
    for (const m of mats) m.dispose();
    this._bodyMesh?.skeleton.dispose(); // textura de huesos propia del rig
  }
}
