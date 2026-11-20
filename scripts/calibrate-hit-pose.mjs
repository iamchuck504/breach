// Calibra la tabla de src/combat/hit-pose.js contra el rig REAL (modelos
// Blender): para cada postura mide el casco y el torso dibujados y los
// expresa en el marco del personaje (adelante, lado, altura).
//   BASE=http://127.0.0.1:5200 node scripts/calibrate-hit-pose.mjs [--write]
// Sin --write imprime la tabla; con --write la sustituye entre los
// marcadores de hit-pose.js. Repetir si cambia una pose de rig.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { CHROME } from './lib-chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:5200';

// Posturas medidas. `cover` = se asienta con un Controller real contra una
// cara (como en partida); `p` = parámetros directos del rig.
export const STANCES = {
  idle: { p: {} },
  crouch: { cover: { h: 1.1, side: 0, aim: false, fire: false } },
  low_aim: { cover: { h: 1.1, side: 0, aim: true, fire: false, pitch: 0 } },
  low_aim_down: { cover: { h: 1.1, side: 0, aim: true, fire: false, pitch: -0.55 } },
  low_lean_r: { cover: { h: 1.1, side: 1, aim: true, fire: false } },
  low_lean_l: { cover: { h: 1.1, side: -1, aim: true, fire: false } },
  high_lean_r: { cover: { h: 3, side: 1, aim: true, fire: false } },
  high_lean_l: { cover: { h: 3, side: -1, aim: true, fire: false } },
  blind_over: { cover: { h: 1.1, side: 0, aim: false, fire: true, pitch: 0 } },
  blind_over_down: { cover: { h: 1.1, side: 0, aim: false, fire: true, pitch: -0.55 } },
  // ADS en abierto: cada arma tiene su pose (rig.js ADS_WEAPON_POSES)
  ads_pistol: { wep: 'pistol', p: { aim: true } },
  ads_smg: { wep: 'smg', p: { aim: true } },
  ads_shotgun: { wep: 'shotgun', p: { aim: true } },
  ads_sniper: { wep: 'sniper', p: { aim: true } },
  ads_bazooka: { wep: 'bazooka', p: { aim: true } },
  ads_grenade: { wep: 'grenade', p: { aim: true } },
  ...Object.fromEntries(['pistol', 'smg', 'shotgun', 'sniper', 'bazooka', 'grenade']
    .map((w) => [`ads_${w}_down`, { wep: w, p: { aim: true, aimPitch: -0.55 } }])),
  roadie: { p: { state: 'roadie', speed: 1 } },
  dive_2: { p: { state: 'dive', evadePhase: 0.2 } },
  dive_5: { p: { state: 'dive', evadePhase: 0.5 } },
  dive_8: { p: { state: 'dive', evadePhase: 0.8 } },
  slide: { p: { state: 'slide' } },
  mantle_2: { p: { state: 'mantle', mantlePhase: 0.2 } },
  mantle_4: { p: { state: 'mantle', mantlePhase: 0.4 } },
  mantle_5: { p: { state: 'mantle', mantlePhase: 0.5 } },
  mantle_8: { p: { state: 'mantle', mantlePhase: 0.8 } },
  flip_0: { p: { state: 'flip', flipT: 0 } },
  flip_2: { p: { state: 'flip', flipT: 0.2 } },
  flip_5: { p: { state: 'flip', flipT: 0.5 } },
  flip_8: { p: { state: 'flip', flipT: 0.8 } },
};

// Entra en práctica como un jugador: así el rig usa los modelos de partida.
export async function openPractice(page) {
  await page.goto(`${BASE}/?nolock=1&gfx=high`, { waitUntil: "load" });
  await page.click('#btn-enter');
  await page.waitForSelector('#splash.off', { state: 'attached' });
  await page.click('#btn-practice');
  await page.waitForFunction(() => window.BREACH?.player && window.BREACH_RIG && window.THREE, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
}

export async function measureStances(page, stances = STANCES) {
  return page.evaluate(async (stances) => {
    // mismo Rig y modelos que la partida (la práctica ya cargó los GLB)
    const T = window.THREE, Rig = window.BREACH_RIG;
    const { Controller } = await import('/src/player/controller.js');
    const { World } = await import('/src/world/world.js');
    const scene = new T.Scene();
    const rig = new Rig(scene, 'red', null, 0);
    rig.groundFn = () => 0;
    await rig.visualReady;
    const BASE_P = { state: 'idle', speed: 0, aim: false, aimPitch: 0, aimYawErr: 0, twist: 0, firing: false, moveForward: 1, moveSide: 0,
      flipT: 0, flipDir: 1, flipAxis: 'z', coverLean: 0, coverAimExposure: 0, blindPoseExposure: 0, latMove: 0, groundPitch: 0, vy: 0,
      mantlePhase: 0, evadePhase: 0, meleePhase: 0, swapping: false, throwT: 0, throwTotal: 0.55, throwReleased: false, reloading: false, reloadT: 0, aimLift: 0 };
    const V = new T.Vector3();
    const settleCover = (c) => {
      const box = { minx: -2, maxx: 2, minz: -2, maxz: 0, h: c.h };
      const face = { a: { x: -2, z: 0 }, b: { x: 2, z: 0 }, n: { x: 0, z: 1 }, h: c.h, topY: c.h, kind: c.h < 2 ? 'low' : 'high', collider: box };
      const w = Object.create(World.prototype);
      w.colliders = [box]; w.segmentColliders = []; w.surfaceZones = []; w.raycastHit = null; w.faces = [face];
      w.groundHeight = () => 0; w.ceilingHeight = () => Infinity;
      const cam = { yaw: 0, pitch: c.pitch ?? 0, flatForward: () => ({ x: 0, z: -1 }), flatRight: () => ({ x: 1, z: 0 }) };
      const p = new Controller(w, cam); p.pos = { x: c.side * 1.5, z: 0.38 }; p.state = 'cover'; p.cover = face; p.yaw = 0;
      const input = { moveVec: () => ({ x: 0, z: 0 }), aimHeld: c.aim, sprintHeld: false, meleePressed: false, evadePressed: false, jumpPressed: false };
      for (let i = 0; i < 150; i++) { p.update(1 / 60, input, c.fire); rig.setTransform(p.pos.x, p.pos.z, p.yaw, p.y); rig.update(1 / 60, { ...BASE_P, ...p.animParams() }); }
      return { ox: p.pos.x, oz: p.pos.z, st: p.animState(), cl: p.coverLeanAnim || 0, ce: p.coverAimExposure };
    };
    const out = {};
    for (const [key, s] of Object.entries(stances)) {
      rig.setWeapon(s.wep || 'smg', s.wep && s.wep !== 'smg' ? 'smg' : 'shotgun');
      let ox = 0, oz = 0, info = {};
      if (s.cover) ({ ox, oz, ...info } = settleCover(s.cover));
      else {
        rig.setTransform(0, 0, 0, 0);
        for (let i = 0; i < 40; i++) rig.update(1 / 60, { ...BASE_P });
        for (let i = 0; i < 80; i++) rig.update(1 / 60, { ...BASE_P, ...s.p });
      }
      // el cuerpo se re-fusiona (setWeapon, detalles de skin): leerlo al medir
      const mesh = rig._bodyMesh, bones = mesh.skeleton.bones;
      const headSet = new Set(bones.map((b, i) => (b === rig.head || b.userData?.runtimeTarget === 'head' ? i : -1)).filter((i) => i >= 0));
      const idx = (nm) => bones.findIndex((b) => b.name === nm || b.userData?.name === nm);
      const pelvis = idx('segment_pelvis'), chest = idx('segment_chest');

      const skin = mesh.geometry.attributes.skinIndex, n = mesh.geometry.attributes.position.count;
      rig.root.updateMatrixWorld(true); mesh.skeleton.update?.();
      // marco local con yaw 0: adelante = -z, lado (derecha) = +x
      const visorB = bones.indexOf(rig.head), vs = [0, 0, 0, 0];
      const hb = { mn: [9, 9, 9], mx: [-9, -9, -9] }, acc = { [pelvis]: [0, 0, 0, 0], [chest]: [0, 0, 0, 0] };
      const hL = idx('segment_hand_L'), hR = idx('segment_hand_R'); acc[hL] = [0, 0, 0, 0]; acc[hR] = [0, 0, 0, 0];
      let top = -9;
      for (let i = 0; i < n; i++) {
        mesh.getVertexPosition(i, V); V.applyMatrix4(mesh.matrixWorld);
        const l = [-(V.z - oz), V.x - ox, V.y], b = skin.getX(i);
        if (l[2] > top) top = l[2];
        if (b === visorB) { vs[0] += l[0]; vs[1] += l[1]; vs[2] += l[2]; vs[3]++; }
        if (headSet.has(b)) for (let a = 0; a < 3; a++) { hb.mn[a] = Math.min(hb.mn[a], l[a]); hb.mx[a] = Math.max(hb.mx[a], l[a]); }
        const c = acc[b]; if (c) { c[0] += l[0]; c[1] += l[1]; c[2] += l[2]; c[3]++; }
      }
      const cen = (c) => [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
      // centro de cabeza = punto medio entre el centro del casco y el visor:
      // con la cabeza girada (ADS perfilado) el visor se aparta del casco y
      // una esfera centrada solo en el casco dejaba la cara fuera
      const hc = hb.mn.map((v, a) => (v + hb.mx[a]) / 2), vc = vs.slice(0, 3).map((v) => v / vs[3]);
      out[key] = { ...info, head: hc.map((v, a) => (v + vc[a]) / 2), helmet: hc, visor: vc, headMin: hb.mn, headMax: hb.mx,
        pelvis: cen(acc[pelvis]), chest: cen(acc[chest]), hands: [cen(acc[hL]), cen(acc[hR])], top };
    }
    return out;
  }, stances);
}

// Volumen legado de pie (ballistics): la postura idle se ancla a él para que
// la tabla solo mueva lo que la pose dibujada mueve respecto a estar de pie.
const LEGACY = { h: [0, 0, 1.52], a: [0, 0, 0.35], b: [0, 0, 1.3] };
const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// rotación mínima que lleva u0 a u1 (Rodrigues), aplicada a v
function rotate(u0, u1, v) {
  const k = cross(u0, u1), s = Math.hypot(...k), c = dot(u0, u1);
  if (s < 1e-6) return c > 0 ? v : v.map((x) => -x);
  const kk = k.map((x) => x / s), kv = cross(kk, v), kd = dot(kk, v);
  return v.map((x, i) => x * c + kv[i] * s + kk[i] * kd * (1 - c));
}

export function fitTable(m) {
  // Cápsula: el extremo de hombros (b) sigue al pecho y gira con el tronco;
  // el de piernas (a) cuelga en vertical bajo la cadera (las piernas apoyan
  // o cuelgan; girarlo con el tronco lo mandaba detrás del cuerpo).
  const i0 = m.idle, u0 = norm(sub(i0.chest, i0.pelvis));
  const oa = sub(LEGACY.a, i0.pelvis), ob = sub(LEGACY.b, i0.chest), oh = sub(LEGACY.h, i0.head);
  const r3 = (a) => a.map((v) => +v.toFixed(2));
  const table = {};
  for (const [k, s] of Object.entries(m)) {
    if (k === 'idle') continue;
    const u = norm(sub(s.chest, s.pelvis));
    table[k] = { h: r3(add(s.head, oh)), a: r3(add(s.pelvis, oa)), b: r3(add(s.chest, rotate(u0, u, ob))) };
  }
  // pivote del giro: punto medio entre la cabeza a 0° y a 180°
  table.flip_pivot = r3(m.flip_0.head.map((v, i) => (v + m.flip_5.head[i]) / 2));
  return table;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const page = await browser.newPage();
    await openPractice(page);
    const m = await measureStances(page);
    const table = fitTable(m);
    if (process.argv.includes('--raw')) console.log(JSON.stringify(m, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v), 1));
    const body = Object.entries(table).map(([k, v]) => `  ${k}: ${JSON.stringify(v).replace(/"/g, '')},`).join('\n');
    if (process.argv.includes('--write')) {
      const file = path.join(root, 'src/combat/hit-pose.js');
      const src = fs.readFileSync(file, 'utf8');
      const re = /(\/\/ <calibrado>\n)[\s\S]*?([ \t]*\/\/ <\/calibrado>)/;
      if (!re.test(src)) throw new Error('marcadores <calibrado> no encontrados en hit-pose.js');
      fs.writeFileSync(file, src.replace(re, `$1${body}\n$2`));
      console.log('tabla escrita en src/combat/hit-pose.js');
    } else console.log(body);
  } finally { await browser.close(); }
}
