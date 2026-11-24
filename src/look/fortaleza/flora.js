// Capa de vida "flora" del look (ver el contrato en ../index.js).
//
// Lo que crece solo en un castillo del norte, en cuatro mallas fusionadas (4 llamadas):
//   1. suelo del campo: matas, malas hierbas y alguna flor silvestre al pie
//      de los muros, NUNCA más altas de 0.28 m (un jugador agachado jamás
//      queda oculto tras una planta);
//   2. hiedra plana sobre muros ALTOS y torreones, a ≤ 6 cm de la piedra: no
//      cambia cómo se lee una cobertura;
//   3. pradera exterior: hierba alta, alguna flor silvestre y trigales;
//   4. robles, cipreses y setos fuera de la muralla (los únicos que dan sombra).
// Un solo material por tipo de cara: el color va por vértice y el viento en el
// sombreador de vértices (atributo aLk = peso, fase, clase).
// Colores naturales: ningún tono está aquí "para que haya color".
import { patch, WIND, NOISE } from '../glsl.js';

// clases de vértice (aLk.z)
const K_FREE = 0;   // planta: el viento la mueve libre
const K_WALL = 1;   // trepadora: el viento solo la mueve en el plano del muro
const K_WHEAT = 3;  // techo del trigal: olas de viento en el fragmento
const K_LEAFY = 4;  // copas y setos: moteado de hojas en el fragmento
const K_STALK = 5;  // faldón del trigal: rayas verticales de cañas

// Acumulador de geometría: arrays planos, una BufferGeometry al final.
class Batch {
  constructor() { this.p = []; this.n = []; this.c = []; this.k = []; this.i = []; this.count = 0; this.maxSway = 0; }
  v(x, y, z, nx, ny, nz, col, w = 0, ph = 0, kind = K_FREE) {
    this.maxSway = Math.max(this.maxSway, w);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.p.push(x, y, z); this.n.push(nx / l, ny / l, nz / l);
    this.c.push(col.r, col.g, col.b); this.k.push(w, ph, kind);
    return this.count++;
  }
  t(a, b, c) { this.i.push(a, b, c); }
  get tris() { return this.i.length / 3; }
  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aLk', new THREE.Float32BufferAttribute(this.k, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    // lkWind alcanza menos de 1,6 veces el peso con la racha máxima.
    g.boundingSphere.radius += 1.6 * this.maxSway;
    return g;
  }
}

// Ruido de valor determinista en JS (para agrupar plantas en manchas).
function hash2(x, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z, s = 0) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let fx = x - xi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi, s), b = hash2(xi + 1, zi, s), c = hash2(xi, zi + 1, s), d = hash2(xi + 1, zi + 1, s);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
const fbm = (x, z, s) => 0.55 * vnoise(x, z, s) + 0.3 * vnoise(x * 2.1 + 5.3, z * 2.1 - 1.7, s + 1) + 0.15 * vnoise(x * 4.3, z * 4.3, s + 2);

export function build(ctx) {
  const { THREE, world, palette: P, budget } = ctx;
  // También en la primera carga, antes del primer render de Three.
  world.mapGroup.updateWorldMatrix(true, true);
  const D = budget.detail;
  // Q: densidad de lo pequeño y numeroso, cae más rápido que D (en 'off'
  // ronda 0.13): la hierba y las hojas son lo primero que sobra en un equipo lento
  const Q = Math.max(0.12, (D - 0.25) / 0.75);
  const C = (hex) => new THREE.Color(hex);
  const mix = (a, b, t) => a.clone().lerp(b, t);

  // ---------- colores (todos de la paleta; los derivados van marcados)
  const G = P.ground;
  const grass = C(G.grass), grassDeep = C(G.grassDeep), grassDry = C(G.grassDry);
  const ivy = C(P.ivy), moss = C(P.moss), lichen = C(P.lichen);
  const fol = P.foliage.map(C);
  const flowers = P.flowers.map(C);
  // silvestres: manzanilla, diente de león, centaura apagada y alguna amapola
  const [fWhite, fYellow, fPurple, fPoppy] = flowers;
  // derivados: verde ciprés (follaje profundo apagado), raíz (pasto en sombra)
  const cypress = fol[2].clone().offsetHSL(0.02, -0.08, -0.1);
  const root = grassDeep.clone().multiplyScalar(0.7);
  const stem = mix(grassDeep, ivy, 0.5);
  const bark = C(P.wood.oak), barkDark = C(P.wood.dark);
  const wheat = mix(grassDry, fYellow, 0.3), wheatLight = mix(wheat, fWhite, 0.3);
  const sun = ctx.sunDir;

  // ---------- material compartido (viento + clases)
  const uniforms = { ...ctx.uniforms };
  const decorate = (m, key) => patch(m, {
    key, uniforms,
    vertexPars: `${WIND}\nattribute vec3 aLk;\nvarying vec3 vLkW;\nvarying vec2 vLk;`,
    vertex: `
      vec4 lkW = modelMatrix * vec4(transformed, 1.0);
      // las raíces y lo anclado (peso 0) no pagan las senoides del viento
      vec3 lkD = vec3(0.0);
      if (aLk.x > 0.0) {
        lkD = lkWind(lkW.xyz, aLk.x, aLk.y);
        // trepadoras: sin componente normal, nunca entran ni salen del muro
        if (aLk.z > 0.5 && aLk.z < 1.5) lkD -= objectNormal * dot(lkD, objectNormal);
      }
      transformed += lkD;
      vLkW = lkW.xyz + lkD; vLk = aLk.yz;`,
    fragmentPars: `${NOISE}\nuniform float uLookTime; uniform vec3 uLookWind;\nvarying vec3 vLkW;\nvarying vec2 vLk;`,
    fragment: `
      int lkK = int(vLk.y + 0.5);
      if (lkK == 3) {
        // trigal: ondas que corren con el viento y grano fino de espigas
        vec2 lkQ = vLkW.xz;
        float lkWave = lkNoise(lkQ * 0.23 - uLookWind.xz * uLookTime * 0.55);
        float lkGrain = lkHash21(floor(lkQ * 12.0)) - 0.5;
        float lkFar = clamp(1.6 - length(fwidth(lkQ)) * 12.0, 0.0, 1.0);
        diffuseColor.rgb *= 0.72 + 0.5 * lkWave + 0.3 * lkGrain * lkFar;
      } else if (lkK == 4) {
        // follaje: moteado de hojas en 3D (se apaga de lejos para no centellear)
        vec3 lkQ = vLkW * 4.5;
        float lkAmp = clamp(1.6 - length(fwidth(lkQ)), 0.0, 1.0);
        vec3 lkI = floor(lkQ);
        float lkH = lkHash21(lkI.xz + lkI.y * vec2(17.1, 31.7));
        diffuseColor.rgb *= 1.0 + lkAmp * 0.42 * (lkH - 0.5);
      } else if (lkK == 5) {
        // cañas del trigal vistas de lado
        float lkA = (vLkW.x + vLkW.z) * 16.0;
        float lkAmp = clamp(1.6 - fwidth(lkA), 0.0, 1.0);
        diffuseColor.rgb *= 1.0 + lkAmp * 0.45 * (lkHash11(floor(lkA)) - 0.5);
      }`,
    // doble cara: la cara trasera usa la misma normal que la delantera (las
    // hojas y briznas se iluminan igual por ambos lados)
    normal: m.side === THREE.DoubleSide ? 'normal *= faceDirection;' : '',
  });
  const plantMat = decorate(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'flora-plant');
  const treeMat = decorate(new THREE.MeshLambertMaterial({ vertexColors: true }), 'flora-tree');

  // ---------- piezas
  const tmpC = new THREE.Color();
  // Caja local de una geometría AJENA (solo lectura): si no trae la suya se
  // calcula en una caja propia, nunca se guarda en la geometría prestada
  // (parte se comparte con la caché de recursos). Las matrices del mapa ya
  // están resueltas cuando el gestor nos llama.
  const scratchBox = new THREE.Box3();
  const localBox = (g) => g.boundingBox ?? scratchBox.setFromBufferAttribute(g.attributes.position);

  // brizna: un triángulo inclinado, raíz oscura y punta clara
  function blade(B, x, y0, z, h, w, rot, lean, leanDir, cBase, cTip, sway, ph) {
    const cx = Math.cos(rot) * w * 0.5, cz = Math.sin(rot) * w * 0.5;
    const dx = Math.cos(leanDir), dz = Math.sin(leanDir);
    const nx = dx * 0.3, nz = dz * 0.3;
    const a = B.v(x - cx, y0, z - cz, nx, 1, nz, cBase, 0, ph);
    const b = B.v(x + cx, y0, z + cz, nx, 1, nz, cBase, 0, ph);
    const c = B.v(x + dx * lean * h, y0 + h, z + dz * lean * h, nx, 1, nz, cTip, sway, ph);
    B.t(a, b, c);
  }
  function tuft(B, r, x, z, y0, n, hMin, hMax, colTip, sway) {
    const ph = r();
    for (let i = 0; i < n; i++) {
      const h = hMin + (hMax - hMin) * Math.pow(r(), 0.7);
      const ang = r() * Math.PI * 2;
      const ox = Math.cos(ang) * r() * 0.05 * (hMax / 0.25), oz = Math.sin(ang) * r() * 0.05 * (hMax / 0.25);
      const tip = tmpC.copy(colTip).offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.08).clone();
      blade(B, x + ox, y0, z + oz, h, 0.022 + r() * 0.02 * (hMax / 0.25), ang + Math.PI / 2, 0.15 + r() * 0.35, ang,
        root, tip, sway * (h / hMax), ph);
    }
  }
  // flor: tallo + corola de 5 pétalos (abanico, centro más claro)
  function flower(B, r, x, z, y0, h, rad, col, sway) {
    const ph = r();
    const lean = (r() - 0.5) * 0.25, leanDir = r() * Math.PI * 2;
    const hx = x + Math.cos(leanDir) * lean * h, hz = z + Math.sin(leanDir) * lean * h, hy = y0 + h;
    const sw = 0.006 + rad * 0.12, rot = r() * Math.PI;
    const s0 = B.v(x - Math.cos(rot) * sw, y0, z - Math.sin(rot) * sw, 0, 1, 0, stem, 0, ph);
    const s1 = B.v(x + Math.cos(rot) * sw, y0, z + Math.sin(rot) * sw, 0, 1, 0, stem, 0, ph);
    const s2 = B.v(hx, hy, hz, 0, 1, 0, stem, sway, ph);
    B.t(s0, s1, s2);
    const center = mix(col, fYellow, col === fYellow ? 0.2 : 0.65);
    const tx = (r() - 0.5) * 0.5, tz = (r() - 0.5) * 0.5; // corola inclinada
    const c = B.v(hx, hy + 0.004, hz, tx, 1, tz, center, sway, ph);
    const a0 = r() * Math.PI * 2, rim = [];
    for (let i = 0; i < 5; i++) {
      const a = a0 + (i / 5) * Math.PI * 2;
      const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;
      rim.push(B.v(hx + px, hy + px * tx + pz * tz, hz + pz, tx, 1, tz, col, sway, ph));
    }
    for (let i = 0; i < 5; i++) B.t(c, rim[i], rim[(i + 1) % 5]);
  }
  // roseta: hojas planas a ras de suelo (diente de león, llantén)
  function rosette(B, r, x, z, y0, size, col) {
    const ph = r(), n = 4 + Math.floor(r() * 3), a0 = r() * 6.28;
    const c = B.v(x, y0 + 0.012, z, 0, 1, 0, tmpC.copy(col).multiplyScalar(0.7).clone(), 0, ph);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2 + (r() - 0.5) * 0.4, L = size * (0.6 + r() * 0.5);
      const tip = B.v(x + Math.cos(a) * L, y0 + 0.03, z + Math.sin(a) * L, 0, 1, 0, col, 0.02, ph);
      const s1 = B.v(x + Math.cos(a + 0.35) * L * 0.5, y0 + 0.02, z + Math.sin(a + 0.35) * L * 0.5, 0, 1, 0, col, 0.01, ph);
      const s2 = B.v(x + Math.cos(a - 0.35) * L * 0.5, y0 + 0.02, z + Math.sin(a - 0.35) * L * 0.5, 0, 1, 0, col, 0.01, ph);
      B.t(c, s1, tip); B.t(c, tip, s2);
    }
  }

  // Aristas de los colliders apoyados en el suelo, con su normal hacia fuera.
  // (world.faces solo trae las caras de cobertura; aquí entran también los
  // muros de 6 m de las galerías y los pies de escalera.) Las aristas internas
  // de un muro hecho de varias cajas se descartan al mirar si delante hay otro
  // collider.
  const solids = world.colliders.filter(c => !c.moveOnly);
  const edges = [];
  for (const c of world.colliders) {
    if ((c.minY ?? 0) > 0.05 || c.moveOnly) continue;
    for (const [ax, az, bx, bz, nx, nz] of [
      [c.minx, c.minz, c.maxx, c.minz, 0, -1], [c.maxx, c.minz, c.maxx, c.maxz, 1, 0],
      [c.maxx, c.maxz, c.minx, c.maxz, 0, 1], [c.minx, c.maxz, c.minx, c.minz, -1, 0]]) {
      const len = Math.hypot(bx - ax, bz - az);
      if (len > 0.05) edges.push({ a: { x: ax, z: az }, b: { x: bx, z: bz }, n: { x: nx, z: nz }, h: c.h, len });
    }
  }

  // =====================================================================
  // 1. SUELO DEL CAMPO (todo ≤ 0.28 m)
  // =====================================================================
  const field = new Batch();
  {
    const r = ctx.rng('flora-field');
    const FX = world.fx, FZ = world.fz;
    const outerRing = (x, z) => Math.abs(x) > 21.8 || Math.abs(z) > 27.4;
    const free = (x, z, m = 0.03) => ctx.inField(x, z, 0.08) && !ctx.blocked(x, z, m);
    const MAXH = 0.27;
    const fieldFlowers = [fWhite, fYellow, fWhite, fPurple, fYellow];
    const plantAt = (x, z, lush) => {
      // Cabe la planta entera, incluidas las flores laterales. Desplazarla el
      // mínimo hacia suelo libre conserva la distribución sembrada del muro.
      let plants = field;
      const margin = lush ? 0.21 : 0.14;
      const near = solids.filter(c => (c.minY ?? 0) < MAXH && x > c.minx-margin && x < c.maxx+margin &&
        z > c.minz-margin && z < c.maxz+margin);
      if (near.length) {
        const options = near.flatMap(c => [[c.minx-margin-.001,z], [c.maxx+margin+.001,z],
          [x,c.minz-margin-.001], [x,c.maxz+margin+.001]]);
        options.sort((a,b) => Math.hypot(a[0]-x,a[1]-z) - Math.hypot(b[0]-x,b[1]-z));
        const site = options.find(([px,pz]) => Math.hypot(px-x,pz-z) < 2*margin && free(px,pz,margin));
        if (site) [x,z] = site;
        else plants = new Batch(); // consumir la misma semilla sin plantar en piedra
      }
      const t = r();
      if (lush) {
        if (t < 0.68) tuft(plants, r, x, z, 0.001, 4 + Math.floor(r() * 4), 0.08, MAXH - r() * 0.08, mix(grass, grassDry, r() * 0.6), 0.075);
        else if (t < 0.84) {
          // ramillete: 2-4 flores del mismo color + algo de hierba
          const col = fieldFlowers[Math.floor(vnoise(x * 0.25, z * 0.25, 9) * fieldFlowers.length * 0.999)];
          const n = 2 + Math.floor(r() * 2);
          for (let i = 0; i < n; i++) flower(plants, r, x + (r() - 0.5) * 0.18, z + (r() - 0.5) * 0.18, 0.001, 0.09 + r() * 0.15, 0.022 + r() * 0.018, col, 0.06);
          tuft(plants, r, x, z, 0.001, 3, 0.06, 0.16, grass, 0.06);
        } else rosette(plants, r, x, z, 0.001, 0.09 + r() * 0.08, mix(grassDeep, moss, r()));
      } else {
        // patio empedrado: briznas cortas, musgo y alguna flor entre juntas
        if (t < 0.6) tuft(plants, r, x, z, 0.001, 3 + Math.floor(r() * 3), 0.04, 0.14, mix(moss, grassDry, r() * 0.5), 0.06);
        else if (t < 0.85) rosette(plants, r, x, z, 0.001, 0.05 + r() * 0.05, mix(moss, lichen, r() * 0.4));
        else flower(plants, r, x, z, 0.001, 0.05 + r() * 0.07, 0.016 + r() * 0.01, r() < 0.5 ? fWhite : fYellow, 0.05);
      }
    };

    // a) pie de muros y bloques: siguen cada cara de cobertura a ras de suelo
    for (const f of edges) {
      const len = f.len;
      if (len < 0.3 || f.h < 0.25) continue;
      const tx = (f.b.x - f.a.x) / len, tz = (f.b.z - f.a.z) / len;
      const mx = (f.a.x + f.b.x) / 2, mz = (f.a.z + f.b.z) / 2;
      const lush = outerRing(mx + f.n.x * 0.3, mz + f.n.z * 0.3);
      const step = (lush ? 0.42 : 1.3) / Q;
      for (let s = r() * step; s < len; s += step * (0.6 + r() * 0.8)) {
        // manchas: el ruido decide dónde la base del muro está "invadida"
        const bx = f.a.x + tx * s, bz = f.a.z + tz * s;
        const clump = fbm(bx * 0.35, bz * 0.35, 3);
        if (r() > (lush ? 0.3 + clump * 0.8 : clump * 0.6)) continue;
        const d = 0.05 + Math.pow(r(), 2) * (lush ? 0.45 : 0.18);
        const x = bx + f.n.x * d, z = bz + f.n.z * d;
        if (!free(x, z)) continue;
        plantAt(x, z, lush);
      }
    }

    // b) manchas de pradera en el anillo exterior (guardas y lizas)
    const cell = 2.0 / Math.sqrt(Q);
    for (let gx = -FX; gx < FX; gx += cell) {
      for (let gz = -FZ; gz < FZ; gz += cell) {
        const x = gx + r() * cell, z = gz + r() * cell;
        if (!outerRing(x, z)) continue;
        const n = fbm(x * 0.12, z * 0.12, 7);
        if (n < 0.5 || r() > (n - 0.5) * 3.2) continue;
        if (!free(x, z, 0.08)) continue;
        plantAt(x, z, true);
      }
    }

    // c) patio: alguna junta suelta lejos de los muros (muy escaso)
    for (let i = 0; i < 70 * Q; i++) {
      const x = (r() * 2 - 1) * 20.5, z = (r() * 2 - 1) * 26;
      if (!free(x, z, 0.1)) continue;
      plantAt(x, z, false);
    }
  }

  // =====================================================================
  // 2. TREPADORAS (solo caras ALTAS, planas contra la piedra)
  // =====================================================================
  const climb = new Batch();
  {
    const r = ctx.rng('flora-climb');
    const ivyCols = [ivy, fol[2], mix(ivy, moss, 0.4), fol[0]];
    // hoja-rombo en el plano del muro (n), a `off` metros de la piedra
    const leafBox = new THREE.Box3(), corner = new THREE.Vector3();
    const leaf = (cx, y, cz, tx, tz, nx, nz, off, ang, L, W, col, sway, ph) => {
      const dx = Math.cos(ang), dy = Math.sin(ang);       // eje de la hoja (en el plano)
      const px = -dy, py = dx;                              // perpendicular
      const P = (u, v, o) => [cx + tx * u + nx * o, y + v, cz + tz * u + nz * o];
      const ox = nx + (r() - 0.5) * 0.4, oy = 0.25 + (r() - 0.5) * 0.3, oz = nz + (r() - 0.5) * 0.4;
      const pts = [P(-dx * L * 0.5, -dy * L * 0.5, off), P(px * W * 0.5 + dx * L * 0.05, py * W * 0.5 + dy * L * 0.05, off + 0.006),
        P(dx * L * 0.5, dy * L * 0.5, off + 0.012), P(-px * W * 0.5 + dx * L * 0.05, -py * W * 0.5 + dy * L * 0.05, off + 0.006)];
      for (const p of pts) p[1] = Math.max(0.005, p[1]);
      // En las esquinas, la envolvente escalonada del torreón puede envolver
      // una hoja aunque su centro esté sobre la circunferencia teórica.
      leafBox.makeEmpty();
      for (const p of pts) leafBox.expandByPoint(corner.fromArray(p));
      const {min, max} = leafBox;
      if (solids.some(c => max.x > c.minx && min.x < c.maxx && max.z > c.minz &&
        min.z < c.maxz && max.y > (c.minY ?? 0) && min.y < c.h)) return;
      const id = pts.map(([x, yy, z], i) => climb.v(x, yy, z, ox, oy, oz, i === 0 ? tmpC.copy(col).multiplyScalar(0.8) : col, sway, ph, K_WALL));
      climb.t(id[0], id[1], id[2]); climb.t(id[0], id[2], id[3]);
    };
    // mancha de trepadora sobre un tramo de cara [u0,u1]. Un fondo continuo
    // (franja oscura pegada a la piedra) da la masa por pocos triángulos; las
    // hojas encima rompen el contorno y dan textura.
    //   kind: 'ivy' sube del suelo · 'hang' cae desde la albardilla (raíz en
    //   el adarve) · 'autumn' sube y ya enrojece alguna hoja (un toque, no más)
    const patchOn = (o, u0, u1, kind, top, dens) => {
      const W = u1 - u0, uc = (u0 + u1) / 2;
      const ph0 = r(), seed = Math.floor(r() * 1e6);
      const blossom = kind === 'autumn' ? [fol[4], fol[4], fol[3]] : null;
      const bloomP = kind === 'autumn' ? 0.18 : 0;
      const env = (u) => Math.max(0, 1 - Math.pow(Math.abs(u - uc) / (W / 2), 2)); // 1 centro, 0 bordes
      const rising = kind !== 'hang';
      const H = rising ? Math.min(top - 0.05, 1.3 + r() * 1.7) : Math.min(top - 0.3, 1.0 + r() * 1.4);
      const lo = rising ? () => 0.0
        : (u) => top - H * (0.2 + 0.8 * env(u)) * (0.45 + 0.55 * vnoise(u * 2.4, 0.5, seed + 3));
      const hi = rising ? (u) => H * (0.35 + 0.65 * Math.sqrt(env(u))) * (0.7 + 0.5 * vnoise(u * 1.6, 0.5, seed))
        : () => top;
      const swayAt = (y) => rising ? 0.006 + 0.012 * y / H : 0.006 + 0.016 * (top - y) / H;
      // fondo
      const back = tmpC.copy(ivy).multiplyScalar(0.52).clone();
      const backTop = tmpC.copy(back).multiplyScalar(1.3).clone();
      const N = Math.max(2, Math.ceil(W / 0.16));
      let prev = null;
      for (let k = 0; k <= N; k++) {
        const u = u0 + 0.1 + (W - 0.2) * (k / N);
        let y0 = lo(u) + 0.07, y1 = hi(u) - 0.07;
        if (y1 < y0) y0 = y1 = (y0 + y1) / 2;
        const [bx, bz] = o.at(u);
        const P = (y, c) => climb.v(bx + o.nx * 0.008, y, bz + o.nz * 0.008, o.nx, 0.2, o.nz, c, swayAt(y), ph0, K_WALL);
        const cur = [P(Math.max(y0, 0.0), back), P(y1, backTop)];
        if (prev) { climb.t(prev[0], cur[0], cur[1]); climb.t(prev[0], cur[1], prev[1]); }
        prev = cur;
      }
      const put = (u, y, big) => {
        if (u < u0 || u > u1 || y < 0.02 || y > top) return;
        const [bx, bz] = o.at(u);
        const sway = swayAt(y) * (big ? 1 : 1.6);
        if (!big && r() < bloomP) {
          const col = blossom[Math.floor(r() * blossom.length)];
          const s = 0.12 + r() * 0.06;
          leaf(bx, y, bz, o.tx, o.tz, o.nx, o.nz, 0.034 + r() * 0.016, r() * 6.28, s, s * 0.95, tmpC.copy(col).offsetHSL(0, 0, (r() - 0.5) * 0.1).clone(), sway, ph0 + r() * 0.2);
        } else {
          const col = tmpC.copy(ivyCols[Math.floor(r() * ivyCols.length)]).multiplyScalar(big ? 0.7 + r() * 0.25 : 0.95 + r() * 0.3).clone();
          const L = big ? 0.2 + r() * 0.1 : 0.13 + r() * 0.06;
          // hojas casi siempre hacia abajo (cuelgan de su tallo)
          leaf(bx, y, bz, o.tx, o.tz, o.nx, o.nz, big ? 0.014 + r() * 0.012 : 0.026 + r() * 0.012, -Math.PI / 2 + (r() - 0.5) * 2.2, L, L * 0.75, col, sway, ph0 + r() * 0.2);
        }
      };
      // contorno: hojas a caballo del borde (lo que más se ve)
      for (let u = u0 + 0.05; u < u1 - 0.05; u += 0.11 / Math.sqrt(dens)) {
        const edgeY = rising ? hi(u) : lo(u);
        put(u + (r() - 0.5) * 0.06, edgeY + (r() - 0.5) * 0.12, true);
        if (r() < 0.6) put(u + (r() - 0.5) * 0.08, edgeY - (rising ? 1 : -1) * (0.08 + r() * 0.08), false);
      }
      for (const ue of [u0 + 0.08, u1 - 0.08]) {
        const ya = lo(ue), yb = hi(ue);
        for (let y = ya + 0.05; y < yb; y += 0.14) put(ue + (r() - 0.5) * 0.12, y, r() < 0.6);
      }
      // interior: textura y flores
      let area = 0;
      for (let k = 0; k < 8; k++) { const u = u0 + W * (k + 0.5) / 8; area += Math.max(0, hi(u) - lo(u)) * W / 8; }
      const nIn = Math.floor(area * 15 * Math.sqrt(Q) * dens);
      for (let i = 0; i < nIn; i++) {
        const u = u0 + r() * W, y = lo(u) + r() * Math.max(0, hi(u) - lo(u));
        put(u, y, r() < 0.45);
      }
      // zarcillos: hileras de hojas que se escapan de la mancha
      const strands = Math.floor(W * 1.2 * Q * dens);
      for (let s = 0; s < strands; s++) {
        let u = u0 + 0.1 + r() * (W - 0.2);
        let y = rising ? hi(u) - 0.05 : lo(u) + 0.05;
        const dir = rising ? 1 : -1;
        const n = 3 + Math.floor(r() * 6);
        for (let i = 0; i < n; i++) {
          y += dir * (0.08 + r() * 0.04);
          u += (r() - 0.5) * 0.06;
          if (y > top || y < 0.05 || u < u0 || u > u1) break;
          const [bx, bz] = o.at(u);
          const col = blossom && r() < 0.15 ? blossom[0] : ivyCols[Math.floor(r() * 2)];
          leaf(bx, y, bz, o.tx, o.tz, o.nx, o.nz, 0.02 + r() * 0.015, -Math.PI / 2 + (r() - 0.5) * 2, 0.11 + r() * 0.04, 0.08, col, 0.03, ph0 + r() * 0.2);
        }
      }
    };

    // caras planas: tramos libres (nada delante, ni pasos, ni portones)
    const spans = [];
    // Planos pegados a los muros (estandartes, escudos, portones, grietas): la
    // trepadora nunca los tapa. Se reconocen por tener geometría plana; las
    // cajas de sillería no lo son. Lo oculto no cuenta: la hiedra plana vieja
    // la apaga surfaces.js cuando esta capa está activa, y su muro queda libre.
    const decals = [];
    {
      const box = new THREE.Box3(), m4 = new THREE.Matrix4();
      world.mapGroup.traverse((o) => {
        if (!o.isMesh || !o.visible || o.name === 'fort-grass' || !o.geometry?.attributes.position) return;
        const gb = localBox(o.geometry);
        if (Math.min(gb.max.x - gb.min.x, gb.max.y - gb.min.y, gb.max.z - gb.min.z) > 1e-3) return;
        const n = o.isInstancedMesh ? Math.min(o.count, 400) : 1;
        for (let i = 0; i < n; i++) {
          if (o.isInstancedMesh) { o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld); } else m4.copy(o.matrixWorld);
          box.copy(gb).applyMatrix4(m4);
          if (box.max.y - box.min.y < 0.2 || box.min.y > 4) continue; // suelos y remates altos
          decals.push([box.min.x - 0.3, box.max.x + 0.3, box.min.z - 0.3, box.max.z + 0.3]);
        }
      });
    }
    const onDecal = (x, z) => decals.some(([x0, x1, z0, z1]) => x > x0 && x < x1 && z > z0 && z < z1);
    const gateGap = (x, z) => (Math.abs(z) > 19.5 && Math.abs(z) < 22.2 && Math.abs(x) < 4.2) // portones de spawn y sus escudos
      // estandartes de tela (capa cloth) en ambas caras de las galerías
      || (Math.abs(x) > 20.4 && Math.abs(x) < 26.6 && [11, 14.6, 15].some((bz) => Math.abs(Math.abs(z) - bz) < 0.95));
    for (const f of edges) {
      // solo muros altos (≥ 2.9 m); los torreones de 8.5 m son pilas de cajas
      // que imitan un cilindro: ahí una cara plana flotaría
      if (f.h < 2.9 || f.h > 6.5 || f.len < 1.4) continue;
      const len = f.len, top = f.h > 3.2 ? 3.4 : f.h - 0.08;
      const tx = (f.b.x - f.a.x) / len, tz = (f.b.z - f.a.z) / len;
      // El sillar sobresale 14 mm y la moldura hasta 24 mm. La banda
      // continua y las hojas arrancan delante de esa piel, incluso con viento.
      const o = { tx, tz, nx: f.n.x, nz: f.n.z, at: (u) =>
        [f.a.x + tx * u + f.n.x * 0.026, f.a.z + tz * u + f.n.z * 0.026] };
      const ok = (u) => {
        const [x, z] = o.at(u);
        const fx = x + f.n.x * 0.35, fz = z + f.n.z * 0.35;
        if (ctx.blocked(x, z, 0.005)) return false;
        if (gateGap(fx, fz) || onDecal(x, z)) return false;
        // nada pegado delante (otro muro, escalera, pasarela); fuera del campo vale
        return !ctx.blocked(fx, fz, 0.1);
      };
      // lado del muro: exterior de la muralla (pradera), anillo exterior o patio
      const mx = (f.a.x + f.b.x) / 2 + f.n.x * 0.4, mz = (f.a.z + f.b.z) / 2 + f.n.z * 0.4;
      const outside = !ctx.inField(mx, mz, -0.1);
      const ring = Math.abs(mx) > 21.8 || Math.abs(mz) > 27.4;
      const chance = outside ? 0.35 : ring ? 0.55 : 0.8, dens = outside ? 0.5 : 1;
      let u = 0.3 + r() * 2;
      while (u < len - 1.2) {
        const W = 1.1 + r() * (outside ? 3.2 : 2.3);
        const u1 = Math.min(u + W, len - 0.3);
        let clear = true;
        for (let s = u; s <= u1; s += 0.2) if (!ok(s)) { clear = false; break; }
        if (clear && u1 - u > 0.9 && r() < chance) {
          // candidato; el orden de construcción lo da la prioridad del sitio
          spans.push({ o, u0: u, u1, top, dens, key: r() / (outside ? 0.6 : ring ? 1.3 : 2.4), cat: outside ? 'out' : ring ? 'ring' : 'court' });
          u = u1 + 1.5 + r() * 5;
        } else u += 0.8 + r() * 2.5;
      }
    }

    // hasta agotar el presupuesto: primero el patio (donde más se juega),
    // luego el anillo exterior y por último la cara exterior de la muralla
    // (solo se ve de lejos)
    spans.sort((a, b) => a.key - b.key);
    const climbBudget = 11500 * Q;
    for (const sp of spans) {
      if (climb.tris > climbBudget) break;
      // en muros de 6 m la cascada nacería a media pared: ahí solo trepa
      const t = r();
      patchOn(sp.o, sp.u0, sp.u1, sp.top > 3.2 ? (t < 0.85 ? 'ivy' : 'autumn') : t < 0.6 ? 'ivy' : t < 0.88 ? 'hang' : 'autumn', sp.top, sp.dens);
    }

    // torreones (cilindros): hiedra que trepa por la cara que mira afuera
    const cylPatch = (cx, cz, rBottom, rTop, y0, y1, a0, a1) => {
      const ph0 = r(), seed = Math.floor(r() * 1e6);
      const rad = (y) => rBottom + (rTop - rBottom) * ((y - y0) / (y1 - y0));
      const H = y1 - y0, arc = (a1 - a0) * rBottom;
      const n = Math.floor(arc * H * 18 * Q);
      for (let i = 0; i < n; i++) {
        const a = a0 + r() * (a1 - a0);
        const e = Math.abs((a - (a0 + a1) / 2) / ((a1 - a0) / 2));
        const y = y0 + Math.pow(r(), 0.85) * H;
        if ((y - y0) > H * (1 - e * e * 0.8) * (0.7 + 0.5 * vnoise(a * 4, y, seed))) continue;
        const nx = Math.cos(a), nz = Math.sin(a), R = rad(y);
        const big = r() < 0.65;
        const bloom = !big && r() < 0.06; // hoja que ya enrojece
        const col = bloom ? fol[4] : tmpC.copy(ivyCols[Math.floor(r() * 4)]).multiplyScalar(big ? 0.75 + r() * 0.2 : 1 + r() * 0.2).clone();
        const L = bloom ? 0.1 : big ? 0.24 + r() * 0.1 : 0.15;
        leaf(cx + nx * R, y, cz + nz * R, -nz, nx, nx, nz, big ? 0.015 : 0.035, -Math.PI / 2 + (r() - 0.5) * 2.2, L, L * 0.8, col, 0.015, ph0);
      }
    };
    // muralla exterior: torreones de esquina (radio 2.4 → 2.1 entre y -0.5 y 6.9)
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = sx * (world.fx + 1.9), cz = sz * (world.fz + 1.9);
      const out = Math.atan2(sz, sx);
      const rb = (y) => 2.4 - 0.3 * (y + 0.5) / 7.4;
      cylPatch(cx, cz, rb(0) + 0.005, rb(4.5) + 0.005, 0, 4.5 + r() * 1.5, out - 0.9 - r() * 0.4, out + 0.3 + r() * 0.5);
    }
    // torreones del recinto interior (los dibuja el kit: r 2.35 abajo, se
    // afinan hacia 2.05): la hiedra sube por la cara que da al patio de armas
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = sx * 23.6, cz = sz * 29.2;
      const out = Math.atan2(sz, 0.35 * sx);
      const rb = (y) => 2.35 - 0.3 * (y + 0.5) / 8.5;
      cylPatch(cx, cz, rb(0) + 0.01, rb(6) + 0.01, 0, 5 + r() * 1.5, out - 0.7 - r() * 0.3, out + 0.5 + r() * 0.4);
    }
  }

  // =====================================================================
  // 3 y 4. EXTERIOR: pradera, trigales, setos y árboles
  // =====================================================================
  const meadow = new Batch(), trees = new Batch();
  {
    const r = ctx.rng('flora-out');
    const WX = world.fx + 0.8, WZ = world.fz + 0.8;  // cara exterior de la muralla
    const LAND = -0.04;
    // distancia (fuera) al rectángulo de la muralla
    const wallDist = (x, z) => {
      const dx = Math.max(Math.abs(x) - WX, 0), dz = Math.max(Math.abs(z) - WZ, 0);
      return Math.abs(x) < WX && Math.abs(z) < WZ ? -1 : Math.hypot(dx, dz);
    };
    // lo que ya hay fuera (torreones, casas, árboles del mapa): no plantar encima
    const keepOut = [];
    {
      const box = new THREE.Box3(), m4 = new THREE.Matrix4(), v = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
      world.mapGroup.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes.position) return;
        if (o.isInstancedMesh) {
          if (!/settlement/.test(o.name)) return;
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, m4); m4.premultiply(o.matrixWorld); m4.decompose(v, q, sc);
            keepOut.push([v.x, v.z, Math.hypot(sc.x, sc.z) * 0.5 + 2]);
          }
          return;
        }
        box.copy(localBox(o.geometry)).applyMatrix4(o.matrixWorld);
        const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
        if (w > 24 || d > 24) return;
        const outside = box.min.x > WX - 0.5 || box.max.x < -WX + 0.5 || box.min.z > WZ - 0.5 || box.max.z < -WZ + 0.5;
        if (!outside) return;
        keepOut.push([(box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2, Math.hypot(w, d) * 0.5 + 0.8]);
      });
    }
    const clearOf = (x, z, rad) => keepOut.every(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) > kr + rad);

    const ico = [0, 1].map((d) => { const g = new THREE.IcosahedronGeometry(1, d), a = g.attributes.position.array; g.dispose(); return a; });
    const ICO = D >= 0.6 ? 1 : 0; // copas de 80 o de 20 triángulos según la calidad
    // tono por vértice: abajo y dentro más oscuro, cara al sol más cálida
    const shadeCol = (base, ux, uy, uz, jitter) => {
      const lit = Math.max(0, ux * sun.x + uy * sun.y + uz * sun.z);
      const k = (0.62 + 0.3 * (uy * 0.5 + 0.5) + 0.12 * lit) * (1 + (jitter - 0.5) * 0.18);
      return tmpC.copy(base).multiplyScalar(k).clone();
    };
    // ---- trigales: rectángulos dorados rodeados de seto
    const fields = [];
    const fieldSpecs = [[-22, -55, 16, 10, 0.1], [26, -56, 12, 9, -0.15], [-63, 4, 9, 15, 0.08], [64, -20, 10, 14, -0.1]];
    for (const [x, z, w, d, rot] of fieldSpecs) for (const s of [1, -1]) fields.push([x * s, z * s, w, d, rot]);
    const inWheat = (x, z, pad = 0) => fields.some(([fx, fz, w, d, rot]) => {
      const c = Math.cos(rot), s = Math.sin(rot), lx = (x - fx) * c + (z - fz) * s, lz = -(x - fx) * s + (z - fz) * c;
      return Math.abs(lx) < w / 2 + pad && Math.abs(lz) < d / 2 + pad;
    });
    for (const [fx, fz, w, d, rot] of fields) {
      if (!clearOf(fx, fz, Math.max(w, d) * 0.45)) continue;
      const c = Math.cos(rot), s = Math.sin(rot);
      const W = (lx, lz) => [fx + lx * c - lz * s, fz + lx * s + lz * c];
      const topY = 0.82 + r() * 0.14;
      // techo: rejilla con lomas suaves y borde mellado
      const nx = Math.max(2, Math.ceil(w / 1.5)), nz = Math.max(2, Math.ceil(d / 1.5));
      const grid = [];
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const edge = i === 0 || j === 0 || i === nx || j === nz;
        let lx = -w / 2 + (w * i) / nx, lz = -d / 2 + (d * j) / nz;
        if (edge) { lx += (i === 0 ? -1 : i === nx ? 1 : 0) * (r() - 0.5) * 0.6; lz += (j === 0 ? -1 : j === nz ? 1 : 0) * (r() - 0.5) * 0.6; }
        else { lx += (r() - 0.5) * 0.5; lz += (r() - 0.5) * 0.5; }
        const y = edge ? topY - 0.08 : topY + (r() - 0.5) * 0.18;
        const col = mix(wheat, r() < 0.3 ? grassDry : wheatLight, r() * 0.45);
        const [x, z] = W(lx, lz);
        grid.push({ lx, lz, x, z, y, id: meadow.v(x, y, z, (r() - 0.5) * 0.2, 1, (r() - 0.5) * 0.2, col, edge ? 0.025 : 0.018, r(), K_WHEAT) });
      }
      const G = (i, j) => grid[j * (nx + 1) + i];
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        meadow.t(G(i, j).id, G(i, j + 1).id, G(i + 1, j + 1).id); meadow.t(G(i, j).id, G(i + 1, j + 1).id, G(i + 1, j).id);
      }
      // contorno en orden (para el faldón y los flecos)
      const ring = [];
      for (let i = 0; i < nx; i++) ring.push(G(i, 0));
      for (let j = 0; j < nz; j++) ring.push(G(nx, j));
      for (let i = nx; i > 0; i--) ring.push(G(i, nz));
      for (let j = nz; j > 0; j--) ring.push(G(0, j));
      const skirtLo = tmpC.copy(wheat).multiplyScalar(0.4).clone(), skirtHi = tmpC.copy(wheat).multiplyScalar(0.85).clone();
      for (let i = 0; i < ring.length; i++) {
        const A = ring[i], B2 = ring[(i + 1) % ring.length];
        const ex = B2.x - A.x, ez = B2.z - A.z, ox = ez, oz = -ex; // normal hacia fuera (contorno antihorario)
        const a0 = meadow.v(A.x, LAND, A.z, ox, 0.6, oz, skirtLo, 0, 0, K_STALK), b0 = meadow.v(B2.x, LAND, B2.z, ox, 0.6, oz, skirtLo, 0, 0, K_STALK);
        const a1 = meadow.v(A.x, A.y, A.z, ox, 0.6, oz, skirtHi, 0.025, 0.3, K_STALK), b1 = meadow.v(B2.x, B2.y, B2.z, ox, 0.6, oz, skirtHi, 0.025, 0.3, K_STALK);
        meadow.t(a0, b1, b0); meadow.t(a0, a1, b1);
        // flecos: espigas sueltas que rompen el borde (tallo + espiga)
        const L = Math.hypot(ex, ez), n = Math.floor((L / 0.24) * Q);
        const len = Math.hypot(ox, oz) || 1;
        for (let k = 0; k < n; k++) {
          const t = r(), out = 0.04 + r() * 0.25;
          const x = A.x + ex * t + (ox / len) * out, z = A.z + ez * t + (oz / len) * out;
          const h = (A.y + (B2.y - A.y) * t) * (0.9 + r() * 0.2), ph = r();
          const lean = (r() - 0.3) * 0.2, ld = Math.atan2(oz, ox);
          const tx = x + Math.cos(ld) * lean, tz = z + Math.sin(ld) * lean;
          blade(meadow, x, LAND, z, h - 0.12, 0.022, r() * 6.28, lean / h, ld, skirtLo, wheat, 0.07, ph);
          const eh = 0.13, ew = 0.025, rot = r() * 3.14, cx = Math.cos(rot) * ew, cz = Math.sin(rot) * ew;
          const e0 = meadow.v(tx, h - 0.14, tz, 0, 1, 0, wheat, 0.07, ph);
          const e1 = meadow.v(tx + cx, h - 0.07, tz + cz, 0, 1, 0, wheatLight, 0.08, ph);
          const e2 = meadow.v(tx + Math.cos(ld) * 0.02, h, tz + Math.sin(ld) * 0.02, 0, 1, 0, wheatLight, 0.09, ph);
          const e3 = meadow.v(tx - cx, h - 0.07, tz - cz, 0, 1, 0, wheatLight, 0.08, ph);
          meadow.t(e0, e1, e2); meadow.t(e0, e2, e3);
        }
      }
      // seto en uno de los lados largos, con un hueco de paso
      const side = r() < 0.5 ? -1 : 1, gapAt = (r() - 0.5) * w * 0.5;
      hedgeRow([W(-w / 2 - 0.6, side * (d / 2 + 1.3)), W(gapAt - 1.4, side * (d / 2 + 1.3))]);
      hedgeRow([W(gapAt + 1.4, side * (d / 2 + 1.3)), W(w / 2 + 0.6, side * (d / 2 + 1.3))]);
    }

    // ---- blobs (icosaedros deformados): copas, setos
    function blob(B, cx, cy, cz, rx, ry, rz, detail, colFn, swayFn, seed, taper = 0) {
      const a = ico[detail], ph = hash2(cx * 10, cz * 10, 5);
      for (let i = 0; i < a.length; i += 9) {
        const id = [];
        for (let j = 0; j < 3; j++) {
          let ux = a[i + j * 3], uy = a[i + j * 3 + 1], uz = a[i + j * 3 + 2];
          // deformación función de la posición: vértices compartidos coinciden
          const dsp = 1 + 0.16 * Math.sin(ux * 3.1 + seed) * Math.sin(uy * 2.7 + seed * 1.3) * Math.sin(uz * 3.3 + seed * 0.7) + 0.08 * Math.sin(ux * 7 + uz * 5 + seed);
          const tp = taper ? 1 - taper * Math.max(uy, 0) : 1;
          const x = cx + ux * rx * dsp * tp, y = Math.max(LAND, cy + uy * ry * dsp), z = cz + uz * rz * dsp * tp;
          id.push(B.v(x, y, z, ux / rx, uy / ry + 0.15, uz / rz, colFn(ux, uy, uz, x, y, z), swayFn(y), ph, K_LEAFY));
        }
        B.t(id[0], id[1], id[2]);
      }
    }
    // seto: perfil de media elipse barrido a lo largo de una polilínea, con
    // lomos irregulares (continuo: una fila de bolas parecía de piedras)
    function hedgeRow(pts) {
      const base = r() < 0.5 ? fol[2] : mix(grassDeep, fol[2], 0.5);
      const seed = Math.floor(r() * 1e5), PROF = 7;
      let prev = null, run = 0;
      const flush = () => { prev = null; };
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 0.7));
        const sx = -(bz - az) / L, sz = (bx - ax) / L; // lateral
        for (let k = 0; k <= n; k++) {
          if (i > 0 && k === 0) continue;
          const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const dist = run + L * t, cap = Math.sqrt(Math.min(1, dist / 0.8, (total - dist) / 0.8));
          if (!clearOf(x, z, 0.6) || wallDist(x, z) < 1.5) { flush(); continue; }
          const lump = vnoise((x + z) * 1.4, 0.5, seed);
          const hh = (0.9 + 0.5 * lump) * (0.3 + 0.7 * cap), ww = (0.6 + 0.25 * vnoise((x - z) * 1.7, 2.5, seed)) * (0.4 + 0.6 * cap);
          const cur = [];
          for (let j = 0; j <= PROF; j++) {
            const a = Math.PI * (j / PROF);                 // 0 = un lado, π = el otro
            const ca = Math.cos(a), sa = Math.sin(a);
            const bump = 1 + 0.16 * (hash2(Math.round(x * 7 + z * 7), j, seed) - 0.5) * sa;
            const px = x + sx * ca * ww * bump, pz = z + sz * ca * ww * bump, py = LAND + sa * hh * bump;
            const col = shadeCol(base, ca * sx, sa, ca * sz, hash2(Math.round(x * 7 + z * 7), j + 9, seed));
            cur.push(trees.v(px, py, pz, sx * ca, sa + 0.2, sz * ca, col, sa * 0.012, lump, K_LEAFY));
          }
          if (prev) for (let j = 0; j < PROF; j++) { trees.t(prev[j], cur[j], cur[j + 1]); trees.t(prev[j], cur[j + 1], prev[j + 1]); }
          prev = cur;
        }
        run += L;
      }
    }
    // setos que bordean caminos desde las puertas lejanas (norte y sur)
    hedgeRow([[-4.5, -44], [-5, -60], [-7, -78]]); hedgeRow([[4.5, -44], [5, -60], [7, -78]]);
    hedgeRow([[4.5, 44], [5, 60], [7, 78]]); hedgeRow([[-4.5, 44], [-5, 60], [-7, 78]]);

    // ---- árboles
    const treesAt = [];
    const canPlant = (x, z, rad, minWall) => wallDist(x, z) > minWall + rad && clearOf(x, z, rad) && !inWheat(x, z, rad + 1)
      && Math.abs(x) < 115 && Math.abs(z) < 115 && treesAt.every(([tx, tz, tr]) => Math.hypot(x - tx, z - tz) > (tr + rad) * 0.85)
      && !(Math.abs(x) < 9 && Math.abs(z) > 40); // caminos norte y sur despejados
    function broadleaf(x, z, H, R, base, kind) {
      const y0 = LAND, crown = H - R * 0.9;
      // tronco: cilindro de 6 lados que se afina
      const tr = 0.16 + R * 0.06, segs = 6;
      const trunkTop = crown + R * 0.1;
      const ring = (y, rad, col, w) => Array.from({ length: segs }, (_, i) => {
        const a = (i / segs) * Math.PI * 2;
        return trees.v(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad, Math.cos(a), 0, Math.sin(a), col, w, 0);
      });
      const lo = ring(y0, tr * 1.25, barkDark, 0), hi = ring(trunkTop, tr * 0.6, bark, 0.006);
      for (let i = 0; i < segs; i++) { const j = (i + 1) % segs; trees.t(lo[i], hi[j], lo[j]); trees.t(lo[i], hi[i], hi[j]); }
      // copa: 3-5 masas alrededor del centro
      const n = 3 + Math.floor(r() * 2), seed = r() * 100;
      const masses = [[0, crown + R * 0.15, 0, R]];
      for (let i = 1; i < n; i++) {
        const a = r() * Math.PI * 2, d = R * (0.45 + r() * 0.3);
        masses.push([Math.cos(a) * d, crown - R * 0.1 + r() * R * 0.4, Math.sin(a) * d, R * (0.55 + r() * 0.25)]);
      }
      for (const [ox, oy, oz, rr] of masses) {
        blob(trees, x + ox, oy, z + oz, rr, rr * 0.82, rr, ICO, (ux, uy, uz, wx, wy, wz) => {
          const j = hash2(wx * 7, wz * 7 + wy * 3, 2);
          // otoño: solo una parte de la copa vira a ocre o a herrumbre
          if (kind === 'autumn' && j > 0.72) return shadeCol(j > 0.9 ? fol[4] : fol[3], ux, uy, uz, j);
          return shadeCol(base, ux, uy, uz, j);
        }, (y) => 0.004 + 0.03 * Math.max(0, (y - crown + R) / (2 * R)), seed + ox * 3);
      }
      treesAt.push([x, z, R]);
    }
    function cypressAt(x, z, H, R) {
      const base = r() < 0.6 ? cypress : mix(cypress, fol[0], 0.3);
      blob(trees, x, LAND + H * 0.5, z, R, H * 0.5, R, ICO, (ux, uy, uz, wx, wy, wz) => shadeCol(base, ux, uy, uz, hash2(wx * 9, wy * 9, wz)),
        (y) => 0.03 * Math.max(0, y / H), r() * 50, 0.55);
      treesAt.push([x, z, R]);
    }

    const target = Math.round(36 * D);
    // a) primer anillo: copas que asoman sobre la muralla desde el campo
    let tries = 0, made = 0;
    while (made < target * 0.55 && tries++ < 3000) {
      const side = Math.floor(r() * 4);
      const along = (r() * 2 - 1);
      const out = 7 + Math.pow(r(), 1.5) * 26;
      const x = side < 2 ? (side ? 1 : -1) * (WX + out) : along * (WX + 20);
      const z = side < 2 ? along * (WZ + 20) : (side === 2 ? 1 : -1) * (WZ + out);
      const R = 2.3 + r() * 1.6, H = R * 2 + 3 + r() * 3;
      if (!canPlant(x, z, R, 4)) continue;
      const t = r();
      if (t < 0.22) { const cr = 0.9 + r() * 0.5; if (canPlant(x, z, cr, 4)) cypressAt(x, z, 8 + r() * 6, cr); }
      else broadleaf(x, z, H, R, fol[Math.floor(r() * 3)], t < 0.32 ? 'autumn' : 'green');
      made++;
    }
    // b) más lejos: arboledas sueltas que llenan el horizonte
    tries = 0;
    while (made < target && tries++ < 3000) {
      const a = r() * Math.PI * 2, d = 50 + r() * 50;
      const x = Math.cos(a) * d * 1.05, z = Math.sin(a) * d;
      const R = 3 + r() * 2.2;
      if (!canPlant(x, z, R, 4)) continue;
      const t = r();
      if (t < 0.25) cypressAt(x, z, 10 + r() * 6, 1.1 + r() * 0.5);
      else broadleaf(x, z, R * 2 + 3.5 + r() * 3, R, fol[Math.floor(r() * 3)], t < 0.4 ? 'autumn' : 'green');
      made++;
    }
    // c) avenidas de cipreses a los lados de los caminos norte y sur
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) {
      const x = sx * (11 + (k % 2) * 0.6), z = sz * (46 + k * 9);
      if (wallDist(x, z) > 5.5 && clearOf(x, z, 1.2) && !inWheat(x, z, 1.5)) cypressAt(x, z, 9 + ((k * 7 + (sx + 2) * 3) % 5), 1.05);
    }

    // ---- pradera: hierba alta y flores 3D (más densas junto a la muralla)
    const nTufts = Math.round(750 * Q);
    for (let i = 0; i < nTufts; i++) {
      const near = r() < 0.6;
      const side = Math.floor(r() * 4), along = r() * 2 - 1;
      const out = near ? Math.pow(r(), 1.8) * 14 : 4 + r() * 40;
      const x = side < 2 ? (side ? 1 : -1) * (WX + out + 0.1) : along * (WX + out + 2);
      const z = side < 2 ? along * (WZ + out + 2) : (side === 2 ? 1 : -1) * (WZ + out + 0.1);
      if (wallDist(x, z) < 0.60 || inWheat(x, z, 0.2) || !clearOf(x, z, 0.2)) continue;
      const n = fbm(x * 0.09, z * 0.09, 11);
      if (r() < 0.86) {
        tuft(meadow, r, x, z, LAND, 6 + Math.floor(r() * 5), 0.2, 0.4 + n * 0.45, mix(grass, grassDry, Math.pow(r(), 2) * 0.8), 0.13);
      } else {
        const col = n > 0.66 ? fPoppy : n > 0.5 ? fYellow : n > 0.4 ? fPurple : fWhite;
        const k = 2 + Math.floor(r() * 3);
        for (let j = 0; j < k; j++) flower(meadow, r, x + (r() - 0.5) * 0.5, z + (r() - 0.5) * 0.5, LAND, 0.25 + r() * 0.35, 0.05 + r() * 0.035, col, 0.1);
      }
    }
  }

  // ---------- mallas
  const add = (B, mat, name, shadow) => {
    if (!B.count) return null;
    const m = new THREE.Mesh(B.build(THREE), mat);
    m.name = name;
    m.matrixAutoUpdate = false; m.updateMatrix();
    m.receiveShadow = true;
    m.castShadow = !!shadow;
    ctx.group.add(m);
    return m;
  };
  add(field, plantMat, 'flora-field');
  add(climb, plantMat, 'flora-climbers');
  add(meadow, plantMat, 'flora-meadow');
  add(trees, treeMat, 'flora-trees', true);
  return null;
}
