// Capa de vida "cloth" del look (ver el contrato en ../index.js).
// La HERÁLDICA de un castillo en uso: pocos estandartes largos donde un
// castillo los cuelga (torreones, galerías), banderas en lo alto de las
// torres, escudos planos en el muro ciego de las galerías y lona vieja sobre
// la fragua y el establo, con la chimenea de la fragua. Cada pieza lleva el
// color del equipo que nace de ese lado (rojo en z negativo, azul en z
// positivo) y el emblema de la casa: la torre del sello de la fortaleza.
// Una sola malla fusionada (1 llamada de dibujo): colores por vértice y el
// viento por atributo, así un material sirve para todo.
//
// Atributos por vértice:
//   aWind = (peso, fase, nx, nz)  peso 0 = anclado, crece hacia el extremo
//           libre; (nx, nz) es la normal horizontal de la tela (dirección de
//           su ondulación). Varas, herrajes y piedra llevan n = 0.
//   aMode = (tela, muro)  tela=1 recibe la translucidez a contraluz; muro=1
//           impide que el viento la empuje hacia dentro de la pared.
import { patch, WIND } from '../glsl.js';
import { shedRoofs, forgeChimneys, CHIMNEY_TOP } from './sheds.js';

const MIN_Y = 3.3;  // nada de tela por debajo dentro del campo: no debe leerse como cobertura
const HIGH_Y = 5.0; // patio interior y junto a galerías: por encima de la línea de tiro
// puertas de las galerías [x, z, radio, cara] (cuadrante +x; se reflejan).
// cara: 0 = del lado del patio (x < 23.7), 1 = del lado de la liza. El muro
// separa: una puerta del patio no afecta a la cara de la liza ni al revés.
// La de la liza en planta baja (25.8, 17) solo pide un radio corto.
const GALLERY_DOORS = [[21.4, 16.9, 6.5, 0], [23.7, 8.8, 6.5, 0], [25.8, 17, 3, 1], [26.5, 0, 6.5, 1]];
// altura mínima de cualquier tela en (x,z): desde la galería (ojos a ~4.5 m)
// se dispara hacia el patio y desde la escalera exterior hacia la liza
function floorAt(x, z) {
  if (Math.abs(x) <= 21.5 && Math.abs(z) <= 27) return HIGH_Y;
  const ax = Math.abs(x), az = Math.abs(z);
  const face = ax > 23.7 ? 1 : 0;
  for (const [dx, dz, r, f] of GALLERY_DOORS) if (f === face && Math.hypot(ax - dx, az - dz) < r) return HIGH_Y;
  // rampa y rellano de la escalera exterior: este en z -11..2.5, oeste espejado
  const sz = x > 0 ? -z : z;
  if (ax > 25 && ax < 29.5 && sz > -3.5 && sz < 12) return HIGH_Y;
  return MIN_Y;
}

export function build(ctx) {
  if (ctx.theme !== 'fortaleza') return null;
  const { THREE, palette } = ctx;
  const rng = ctx.rng('cloth');

  // --- colores (lineales; THREE.Color convierte desde sRGB)
  const col = (hex) => new THREE.Color(hex);
  const C = palette.cloth;
  const linen = col(C.linen), gold = col(C.gold), canvas = col(C.canvas), hem = col(C.trim);
  const bronze = col(palette.metal.bronze), iron = col(palette.metal.iron);
  const pole = col(palette.wood.dark);
  const rope = col(palette.wood.oak).lerp(canvas, 0.5);
  // tinte de equipo algo envejecido: sigue leyéndose como rojo o azul
  const team = { red: col(palette.team.red).multiplyScalar(0.86), blue: col(palette.team.blue).multiplyScalar(0.86) };
  const teamAt = (z) => (z < 0 ? team.red : team.blue); // rojo nace en z negativo
  const stoneA = col(palette.stone.base), stoneB = col(palette.stone.plinth), soot = col(palette.fire.smoke).multiplyScalar(0.55);
  const tint = new THREE.Color();
  // variación de un paño: valor ±, sin cambiar el tono
  const aged = (c, k, r = rng) => tint.copy(c).multiplyScalar(k * (0.95 + r() * 0.08)).clone();

  // cara real de un muro, leída de los colliders: el x más saliente (dir=+1)
  // o más entrante (dir=-1) de los bloques cerca de xGuess que cubren (z, y)
  const wallFace = (xGuess, dir, zs, ys) => {
    let face = null;
    for (const c of ctx.world.colliders) {
      if (c.moveOnly || c.maxx < xGuess - 0.8 || c.minx > xGuess + 0.8) continue;
      const hit = zs.some((z) => z >= c.minz && z <= c.maxz) && ys.some((y) => y >= (c.minY ?? 0) && y <= c.h);
      if (!hit) continue;
      const x = dir > 0 ? c.maxx : c.minx;
      face = face == null ? x : dir > 0 ? Math.max(face, x) : Math.min(face, x);
    }
    return face ?? xGuess;
  };

  // --- acumulador de geometría no indexada
  const P = [], CO = [], W = [], M = [];
  const cur = { ph: 0, nx: 0, nz: 0, cloth: 0, wall: 0 };
  const vtx = (p, c) => {
    P.push(p[0], p[1], p[2]); CO.push(c.r, c.g, c.b);
    W.push(p[3] ?? 0, cur.ph, cur.nx, cur.nz); M.push(cur.cloth, cur.wall);
  };
  const tri = (a, b, c, color) => { vtx(a, color); vtx(b, color); vtx(c, color); };
  const quad = (a, b, c, d, color) => { tri(a, b, c, color); tri(a, c, d, color); };
  const set = (o) => Object.assign(cur, { ph: 0, nx: 0, nz: 0, cloth: 0, wall: 0 }, o);

  // prisma entre dos puntos (mástiles, varas, herrajes); wa/wb = peso de viento en cada punta
  const prism = (a, b, r, color, sides = 4, wa = 0, wb = 0) => {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(d, up).normalize(), v = new THREE.Vector3().crossVectors(d, u);
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const ang = (i / sides) * Math.PI * 2 + Math.PI / sides;
      ring.push([0, 1, 2].map((k) => (u.getComponent(k) * Math.cos(ang) + v.getComponent(k) * Math.sin(ang)) * r));
    }
    for (let i = 0; i < sides; i++) {
      const o0 = ring[i], o1 = ring[(i + 1) % sides];
      quad([a[0] + o0[0], a[1] + o0[1], a[2] + o0[2], wa], [a[0] + o1[0], a[1] + o1[1], a[2] + o1[2], wa],
        [b[0] + o1[0], b[1] + o1[1], b[2] + o1[2], wb], [b[0] + o0[0], b[1] + o0[1], b[2] + o0[2], wb], color);
    }
  };
  // caja alineada a los ejes (sillares de la chimenea); sin cara de abajo
  const box = (x0, y0, z0, x1, y1, z1, c) => {
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], c);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], c);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], c);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], c);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], c);
  };

  // red de seguridad: ninguna pieza de tela baja de lo permitido en su sitio
  const below = (pts) => pts.some(([x, y, z]) => y < floorAt(x, z));

  // ---------------------------------------------------------------- ESTANDARTE
  // Paño largo colgado de una vara de hierro con dos escuadras al muro. Campo
  // del color del equipo, orla y dobladillo ocre, la torre del sello en lino
  // y la tela más sucia hacia abajo. (x,y,z) = centro de la vara; (nx,nz) =
  // normal hacia fuera del muro.
  const banner = (x, y, z, nx, nz, { w = 1.1, len = 4, main, tail = 'swallow', off = 0.08, embed = 0 }) => {
    const tx = -nz, tz = nx;
    const bx = x + nx * off, bz = z + nz * off;
    const tailLen = tail === 'none' ? 0 : w * 0.45;
    const body = len - tailLen;
    if (below([[bx, y - len, bz], [bx + tx * w / 2, y - len, bz + tz * w / 2], [bx - tx * w / 2, y - len, bz - tz * w / 2]])) return false;
    const wt = (v) => 0.4 * Math.pow(Math.min(1, v / len), 1.25);
    const pt = (u, v) => [bx + tx * u * w, y - v, bz + tz * u * w, wt(v)];
    // vara y escuadras
    set({});
    prism([bx + nx * 0.02 - tx * (w / 2 + 0.12), y + 0.03, bz + nz * 0.02 - tz * (w / 2 + 0.12)],
      [bx + nx * 0.02 + tx * (w / 2 + 0.12), y + 0.03, bz + nz * 0.02 + tz * (w / 2 + 0.12)], 0.03, iron, 4);
    for (const s of [-1, 1]) {
      const ex = bx + tx * s * (w / 2 + 0.12), ez = bz + tz * s * (w / 2 + 0.12);
      prism([ex - nx * (off + embed), y + 0.03, ez - nz * (off + embed)], [ex, y + 0.03, ez], 0.022, iron, 4);
      prism([ex - nx * 0.01, y + 0.03, ez - nz * 0.01], [ex + tx * s * 0.07, y + 0.03, ez + tz * s * 0.07], 0.04, bronze, 4);
    }
    // emblema: almenas, cuerpo de la torre y su puerta (medidas en w)
    const m0 = 0.22 + w * 0.32, m1 = m0 + w * 0.12, t1 = m1 + w * 0.42, d0 = t1 - w * 0.2;
    const colsU = [-0.5, -0.43, -0.2, -0.1, -0.05, 0.05, 0.1, 0.2, 0.43, 0.5];
    const rowsV = [0, 0.07, m0, m1, d0, t1];
    for (let v = t1 + 0.3; v < body - 0.12; v += 0.32) rowsV.push(v);
    rowsV.push(body);
    const sr = ctx.rng(`banner-${x.toFixed(1)}-${z.toFixed(1)}-${y.toFixed(1)}`);
    set({ ph: sr(), nx, nz, cloth: 1, wall: 1 });
    const fieldAt = (uc, vc) => {
      if (vc < 0.07) return gold;                                        // dobladillo de arriba
      if (Math.abs(uc) > 0.43) return gold;                              // orla
      const merlon = vc > m0 && vc < m1 && (Math.abs(uc) < 0.05 || (Math.abs(uc) > 0.1 && Math.abs(uc) < 0.2));
      const towerB = vc > m1 && vc < t1 && Math.abs(uc) < 0.2 && !(vc > d0 && Math.abs(uc) < 0.05);
      return merlon || towerB ? linen : main;
    };
    for (let r = 0; r < rowsV.length - 1; r++) {
      const v0 = rowsV[r], v1 = rowsV[r + 1], vc = (v0 + v1) / 2;
      // suciedad hacia abajo, algo desteñido arriba
      const k = (1 - 0.2 * Math.min(1, Math.max(0, (vc - len * 0.55) / (len * 0.45)))) * (vc < 0.6 ? 1.04 : 1);
      for (let c = 0; c < colsU.length - 1; c++) {
        const u0 = colsU[c], u1 = colsU[c + 1];
        quad(pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1), aged(fieldAt((u0 + u1) / 2, vc), k, sr));
      }
    }
    // remate: cola de golondrina, punta o recto
    const tc = aged(main, 0.8, sr);
    if (tail === 'swallow') {
      quad(pt(-0.5, body), pt(0, body), pt(0, body + tailLen * 0.35), pt(-0.5, len), tc);
      quad(pt(0, body), pt(0.5, body), pt(0.5, len), pt(0, body + tailLen * 0.35), tc);
    } else if (tail === 'point') {
      tri(pt(-0.5, body), pt(0.5, body), pt(0, len), tc);
    }
    return true;
  };

  // ---------------------------------------------------------------- BANDERA
  // En mástil, se extiende a sotavento y ondea. Paño del equipo con la
  // franja del asta en ocre; `pennon` = gallardete largo que se afina.
  const wind = ctx.uniforms.uLookWind.value;
  const wl = Math.hypot(wind.x, wind.z) || 1, wdx = wind.x / wl, wdz = wind.z / wl;
  const flag = (x, y0, y1, z, { L = 1.4, H = 0.85, main, pennon = false }) => {
    set({});
    prism([x, y0, z], [x, y1 + 0.1, z], 0.05, pole, 4);
    prism([x, y1 + 0.1, z], [x, y1 + 0.22, z], 0.07, bronze, 4);
    set({ ph: rng(), nx: -wdz, nz: wdx, cloth: 1 });
    const nu = 7, nv = 3;
    const pt = (u, v) => {
      const hh = pennon ? H * (1 - u * 0.88) : H;
      const yy = y1 - (H - hh) / 2 - v * hh;
      return [x + wdx * u * L, yy, z + wdz * u * L, 0.45 * u];
    };
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
        const c = i === 0 ? gold : aged(main, 1 - u0 * 0.15);
        quad(pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1), c);
      }
    }
  };

  // ---------------------------------------------------------------- ESCUDO
  // Escudo de armas plano contra el muro (no es tela: no se mueve). Campo del
  // equipo, orla ocre y una faja de lino. (x,y,z) = centro; n = normal fuera.
  const shield = (x, y, z, nx, nz, size, main) => {
    const tx = -nz, tz = nx, off = 0.035;
    const at = (u, v) => [x + tx * u * size + nx * off, y + v * size, z + tz * u * size + nz * off];
    // contorno del escudo de punta (u -0.5..0.5, v 0.55 arriba .. -0.65 punta)
    const outline = (k) => {
      const pts = [];
      pts.push([-0.5 * k, 0.55 * k + (1 - k) * 0.0]);
      pts.push([0.5 * k, 0.55 * k]);
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * (Math.PI / 2);
        pts.push([0.5 * k * Math.cos(a), -0.05 * k - Math.sin(a) * 0.6 * k]);
      }
      for (let i = 5; i >= 0; i--) {
        const a = (i / 6) * (Math.PI / 2);
        pts.push([-0.5 * k * Math.cos(a), -0.05 * k - Math.sin(a) * 0.6 * k]);
      }
      return pts;
    };
    set({});
    const o = outline(1), inn = outline(0.84);
    // orla: anillo entre los dos contornos
    for (let i = 0; i < o.length; i++) {
      const j = (i + 1) % o.length;
      quad(at(...o[i]), at(...o[j]), at(...inn[j]).map((v, k) => v + [nx, 0, nz][k] * 0.004), at(...inn[i]).map((v, k) => v + [nx, 0, nz][k] * 0.004), aged(gold, 0.9));
    }
    // campo
    const lift = (p) => p.map((v, k) => v + [nx, 0, nz][k] * 0.004);
    const c0 = lift(at(0, 0));
    const fc = aged(main, 0.95);
    for (let i = 0; i < inn.length; i++) tri(c0, lift(at(...inn[(i + 1) % inn.length])), lift(at(...inn[i])), fc);
    // faja horizontal de lino
    const lf = (p) => p.map((v, k) => v + [nx, 0, nz][k] * 0.008);
    quad(lf(at(-0.42, 0.06)), lf(at(-0.42, 0.2)), lf(at(0.42, 0.2)), lf(at(0.42, 0.06)), aged(linen, 0.92));
  };

  // ---------------------------------------------------------------- LONA
  // Lona vieja tendida sobre el tejado de tablas de un cobertizo y caída por
  // los bordes libres; manchas de hollín y algún remiendo. c = collider del tejado.
  const tarp = (c, wallX) => {
    const top = c.h + 0.025;
    const x0 = c.minx - 0.1, x1 = c.maxx + 0.1, z0 = c.minz - 0.12, z1 = c.maxz + 0.12;
    const freeX = wallX > 0 ? x0 : x1; // borde hacia la liza (el otro toca la muralla)
    const nxs = 8, nzs = Math.max(6, Math.round((z1 - z0) / 0.8));
    const sr = ctx.rng(`tarp-${c.minx.toFixed(1)}-${c.minz.toFixed(1)}`);
    set({ ph: sr(), nx: 0, nz: 0, cloth: 1 });
    const hy = (i, j) => {
      // lomos suaves entre los listones y bolsas de agua secas
      const u = i / nxs, v = j / nzs;
      const y = top + 0.05 * Math.sin(v * Math.PI * nzs / 2) * Math.sin(u * Math.PI) + (sr() - 0.5) * 0.02;
      // La lona reposa sobre las tablas incluso en el mínimo de la ondulación.
      return Math.max(c.h + 0.008, y);
    };
    const grid = [];
    for (let j = 0; j <= nzs; j++) for (let i = 0; i <= nxs; i++) grid.push([x0 + (x1 - x0) * i / nxs, hy(i, j), z0 + (z1 - z0) * j / nzs, 0.01]);
    const G = (i, j) => grid[j * (nxs + 1) + i];
    const spot = (x, z) => {
      const s = Math.sin(x * 1.7 + z * 0.9) * Math.sin(z * 1.3 - x * 0.4);
      return s > 0.55 ? 0.72 : s < -0.7 ? 1.08 : 0.93 + sr() * 0.08;
    };
    for (let j = 0; j < nzs; j++) for (let i = 0; i < nxs; i++) {
      const a = G(i, j), cc = (a[0] + G(i + 1, j + 1)[0]) / 2, zz = (a[2] + G(i + 1, j + 1)[2]) / 2;
      quad(a, G(i, j + 1), G(i + 1, j + 1), G(i + 1, j), aged(canvas, spot(cc, zz), sr));
    }
    // faldones: borde libre largo y los dos testeros
    const drop = Math.min(0.42, top - MIN_Y - 0.06);
    const skirt = (A, B, nx, nz) => {
      set({ ph: sr(), nx, nz, cloth: 1 });
      const n = Math.max(2, Math.round(Math.hypot(B[0] - A[0], B[2] - A[2]) / 0.6));
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const p = (t, yy, w) => [A[0] + (B[0] - A[0]) * t + nx * 0.03, yy, A[2] + (B[2] - A[2]) * t + nz * 0.03, w];
        const d0 = drop * (0.82 + 0.18 * Math.sin(t0 * 9 + A[2])), d1 = drop * (0.82 + 0.18 * Math.sin(t1 * 9 + A[2]));
        quad(p(t0, top, 0.01), p(t1, top, 0.01), p(t1, top - d1, 0.09), p(t0, top - d0, 0.09), aged(canvas, 0.82, sr));
      }
    };
    const fx = freeX, nfx = wallX > 0 ? -1 : 1;
    skirt([fx, 0, z0], [fx, 0, z1], nfx, 0);
    skirt([x1, 0, z0], [x0, 0, z0], 0, -1);
    skirt([x0, 0, z1], [x1, 0, z1], 0, 1);
    // cuerdas de amarre por encima de la lona
    set({});
    for (const zz of [z0 + (z1 - z0) * 0.3, z0 + (z1 - z0) * 0.7]) prism([x0, top + 0.06, zz], [x1, top + 0.06, zz], 0.014, rope, 3);
  };

  // ---------------------------------------------------------------- CHIMENEA
  // Chimenea de la fragua pegada a la muralla: sillares, boca ennegrecida.
  // El humo y las pavesas los pone la capa de aire en su boca.
  const chimney = (x, z, y0, y1) => {
    set({});
    const hw = 0.42, rows = Math.round((y1 - y0) / 0.38), sr = ctx.rng(`chimney-${x}`);
    for (let r = 0; r < rows; r++) {
      const a = y0 + (y1 - y0) * r / rows, b = y0 + (y1 - y0) * (r + 1) / rows - 0.02;
      const c = tint.copy(stoneA).lerp(stoneB, sr() * 0.5).lerp(soot, Math.max(0, (r - rows + 3) / 3) * 0.6).multiplyScalar(0.92 + sr() * 0.1).clone();
      box(x - hw, a, z - hw, x + hw, b + 0.02, z + hw, c);
    }
    // corona volada y boca negra
    box(x - hw - 0.07, y1, z - hw - 0.07, x + hw + 0.07, y1 + 0.14, z + hw + 0.07, tint.copy(stoneA).lerp(soot, 0.55).clone());
    quad([x - hw + 0.08, y1 + 0.145, z - hw + 0.08], [x - hw + 0.08, y1 + 0.145, z + hw - 0.08], [x + hw - 0.08, y1 + 0.145, z + hw - 0.08], [x + hw - 0.08, y1 + 0.145, z - hw + 0.08], soot.clone().multiplyScalar(0.3));
  };

  // ======================= COMPOSICIÓN =======================
  // El mapa tiene simetría rotacional (x,z)->(-x,-z): se compone medio mapa
  // (s=+1) y se gira; el color de equipo sale de la z final.
  const keepTop = 7.4;
  const TOWER = [23.6, 29.2];
  const OUTER_TOWER = [41.5, 37.5];
  for (const s of [1, -1]) {
    const X = (x) => s * x, Z = (z) => s * z;

    // torre del homenaje: un mástil en la esquina de cada equipo con su gallardete
    set({});
    flag(X(4.6), 3.0, keepTop, Z(4.6), { L: 2.4, H: 0.75, main: teamAt(Z(4.6)), pennon: true });

    // torreones del recinto interior: un estandarte hacia el patio y otro
    // hacia el patio de armas de su equipo
    for (const sx of [-1, 1]) {
      const cx = s * sx * TOWER[0], cz = s * TOWER[1];
      for (const [tx, tz] of [[0, 0], [cx, cz * 1.5]]) {
        const ax = tx - cx, az = tz - cz, l = Math.hypot(ax, az);
        const nx = ax / l, nz = az / l;
        banner(cx + nx * 2.28, 7.75, cz + nz * 2.28, nx, nz, { w: 1.2, len: 4.2, main: teamAt(cz), off: 0.16, embed: 0.47 });
      }
    }

    // galería, cara a la liza (muro ciego): un estandarte de cada equipo,
    // lejos de las puertas, del rótulo, de los escudos de la armería y de la
    // escalera exterior (esta va por z -11..2.5 en el lado este)
    for (const z of [13, -13]) {
      const zw = Z(z), w = 1.0;
      const x = wallFace(X(25.8), s, [zw - w / 2, zw, zw + w / 2], [3.5, 5.9]);
      banner(x, 5.9, zw, s, 0, { w, len: 2.5, main: teamAt(zw), tail: 'point', off: 0.03 });
    }
    // galería, cara al patio: escudos planos en el muro ciego (|z| > 8), por
    // encima de 5 m: desde la galería se dispara por las ventanas de al lado
    for (const z of [11, 14]) {
      for (const zs of [1, -1]) {
        const zw = zs * Z(z);
        const x = wallFace(X(21.4), -s, [zw - 0.4, zw, zw + 0.4], [5.2, 5.6]);
        shield(x, 5.53, zw, -s, 0, 0.74, teamAt(zw));
      }
    }

    // torreones exteriores: estandarte hacia el campo y bandera en el tejado
    for (const sx of [-1, 1]) {
      const cx = s * sx * OUTER_TOWER[0], cz = s * OUTER_TOWER[1];
      const l = Math.hypot(cx, cz), nx = -cx / l, nz = -cz / l;
      banner(cx + nx * 2.2, 6.7, cz + nz * 2.2, nx, nz, { w: 1.2, len: 3.2, main: teamAt(cz), off: 0.12 });
      flag(cx, 9.3, 11.4, cz, { main: teamAt(cz) });
    }
  }

  // --- cobertizos de la liza (establo y fragua): tejado de tablas plano
  // (losa fina a ~3.8-4.05 m pegada a la muralla, leída de los colliders)
  for (const c of shedRoofs(ctx.world.colliders)) tarp(c, c.minx > 0 ? 1 : -1);
  for (const f of forgeChimneys(ctx.world.colliders)) chimney(f.x, f.z, 3.85, CHIMNEY_TOP);

  // torreones lejanos: la bandera del lado que guardan (silueta en la panorámica)
  for (const [x, z, r, h] of [[-52, -24, 3.4, 11], [54, 13, 4, 13], [-49, 33, 3, 9], [50, -36, 3.6, 10]]) {
    const apex = h - 0.5 + r * 0.6 + r * 0.65;
    flag(x, apex - 0.2, apex + 2.2, z, { L: 2.3, H: 1.3, main: teamAt(z) });
  }

  // --- malla
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(CO, 3));
  geo.setAttribute('aWind', new THREE.Float32BufferAttribute(W, 4));
  geo.setAttribute('aMode', new THREE.Float32BufferAttribute(M, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const sunCol = col(palette.light.sun);
  const uniforms = {
    ...ctx.uniforms,
    uClothSun: { value: ctx.sunDir.clone().normalize() },
    uClothSunCol: { value: new THREE.Vector3(sunCol.r, sunCol.g, sunCol.b) },
  };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  patch(mat, {
    key: 'cloth',
    uniforms,
    vertexPars: `${WIND}
      attribute vec4 aWind; attribute vec2 aMode;
      uniform vec3 uClothSun;
      varying float vLkGlow;`,
    vertex: `{
      vec3 lkW = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vec3 d = lkWind(lkW, aWind.x, aWind.y);
      vec2 n = aWind.zw;
      // ondulación a lo largo de la normal de la tela; la onda viaja hacia el extremo libre
      float rip = sin(uLookTime * 4.3 + aWind.y * 17.0 - aWind.x * 14.0 + (lkW.x + lkW.z) * 0.6)
                + 0.5 * sin(uLookTime * 7.1 + aWind.y * 5.0 - aWind.x * 23.0);
      d.xz += n * rip * aWind.x * (0.24 + 0.2 * uLookWind.y);
      // pegada a un muro: el viento la despega, nunca la mete en la pared
      if (aMode.y > 0.5) {
        d.xz -= n * min(dot(d.xz, n), 0.0);
        // y casi sin vaivén a lo largo del muro: no invade ventanas ni puertas
        vec2 lkT = vec2(-n.y, n.x);
        d.xz -= lkT * dot(d.xz, lkT) * 0.8;
      }
      transformed += d;
      vec3 lkV = normalize(lkW - cameraPosition);
      vLkGlow = aMode.x * (0.08 + pow(max(dot(lkV, uClothSun), 0.0), 2.0));
    }`,
    fragmentPars: `uniform vec3 uClothSun; uniform vec3 uClothSunCol; varying float vLkGlow;`,
    // contraluz: si el sol pega en la cara que no vemos, la tela se enciende
    emissive: `{
      vec3 lkSunV = normalize((viewMatrix * vec4(uClothSun, 0.0)).xyz);
      float lkBack = 1.0 - smoothstep(-0.4, 0.05, dot(normal, lkSunV));
      totalEmissiveRadiance += diffuseColor.rgb * uClothSunCol * (vLkGlow * lkBack * 0.7);
    }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'look-cloth';
  mesh.receiveShadow = true;
  mesh.castShadow = false; // el viento no llega al mapa de sombras: una sombra quieta delataría la tela
  mesh.frustumCulled = false; // el viento la saca un poco de su esfera
  ctx.group.add(mesh);
  return null;
}
