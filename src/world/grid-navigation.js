// NAVEGACIÓN GENÉRICA DE BOTS. Sustituye a los grafos escritos a mano por
// mapa: rellena desde los spawns una rejilla de celdas transitables con la
// MISMA física del juego (radio de cuerpo, escalón máximo, rampas, galerías,
// plataformas, techos) y busca rutas sobre ella. Un sector nuevo, una rampa o
// un interior quedan cubiertos sin tocar este archivo.
//
// El mapa es 2,5D: cada celda tiene una sola altura transitable. Sobre una
// caja se puede estar si se llega andando (rampa) o cayendo desde algo más
// alto; nada pasa por debajo de un suelo transitable.
//
// Fuente: { colliders, segments, fx, fz, seeds, baseGround(p, r) }. World la
// cumple en el cliente; scripts/ la construyen desde la geometría compartida.
const CELL = 0.5, BUCKET = 4;
const STEP_UP = 0.16;   // TUNING.move.maxStepUp
const DROP = 1.25;      // caída que un bot acepta: un cover bajo, no una galería
const BODY = 1.63;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// distancia de p al tramo a-b
const segDist = (p, a, b) => {
  const tx = b.x - a.x, tz = b.z - a.z, l2 = tx * tx + tz * tz;
  const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * tx + (p.z - a.z) * tz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + tx * u), p.z - (a.z + tz * u));
};

export class GridNavigation {
  constructor(source, { radius = 0.48 } = {}) {
    this.source = source;
    this.radius = radius;
    this.cache = new WeakMap();
    this.fx = source.fx; this.fz = source.fz;
    this.nx = Math.ceil(this.fx * 2 / CELL); this.nz = Math.ceil(this.fz * 2 / CELL);
    this._bucketBoxes();
    this._flood(source.seeds);
    this._clearance();
    // nodos gruesos (cada 3 m) para quien solo necesita "un punto transitable cerca"
    this.nodes = [];
    for (let j = 1; j < this.nz; j += 6) for (let i = 1; i < this.nx; i += 6) {
      if (!Number.isNaN(this.height[j * this.nx + i])) this.nodes.push(this._centre(i, j));
    }
  }

  // ---------- geometría ----------
  _bucketBoxes() {
    this.bx = Math.ceil(this.fx * 2 / BUCKET) + 2; this.bz = Math.ceil(this.fz * 2 / BUCKET) + 2;
    this.buckets = Array.from({ length: this.bx * this.bz }, () => []);
    const reach = this.radius + 0.1;
    const put = (item, minx, maxx, minz, maxz) => {
      const i0 = Math.max(0, Math.floor((minx - reach + this.fx) / BUCKET) + 1), i1 = Math.min(this.bx - 1, Math.floor((maxx + reach + this.fx) / BUCKET) + 1);
      const j0 = Math.max(0, Math.floor((minz - reach + this.fz) / BUCKET) + 1), j1 = Math.min(this.bz - 1, Math.floor((maxz + reach + this.fz) / BUCKET) + 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.buckets[j * this.bx + i].push(item);
    };
    for (const c of this.source.colliders) { if (!c.walkSurface) put(c, c.minx, c.maxx, c.minz, c.maxz); }
    for (const s of this.source.segments ?? []) {
      put({ segment: s }, Math.min(s.a.x, s.b.x) - s.half, Math.max(s.a.x, s.b.x) + s.half, Math.min(s.a.z, s.b.z) - s.half, Math.max(s.a.z, s.b.z) + s.half);
    }
  }
  _near(x, z) {
    const i = Math.floor((x + this.fx) / BUCKET) + 1, j = Math.floor((z + this.fz) / BUCKET) + 1;
    if (i < 0 || j < 0 || i >= this.bx || j >= this.bz) return null;
    return this.buckets[j * this.bx + i];
  }
  // ¿cabe el cuerpo con los pies a la altura y?
  blocked(x, z, y, r = this.radius) {
    if (Math.abs(x) > this.fx - r || Math.abs(z) > this.fz - r) return true;
    const list = this._near(x, z);
    if (!list) return true;
    for (const c of list) {
      if (c.segment) {
        const s = c.segment;
        if (y >= s.h - 0.05) continue;
        const tx = s.b.x - s.a.x, tz = s.b.z - s.a.z, len2 = tx * tx + tz * tz;
        const u = Math.max(0, Math.min(1, ((x - s.a.x) * tx + (z - s.a.z) * tz) / len2));
        const dx = x - (s.a.x + tx * u), dz = z - (s.a.z + tz * u), rr = r + s.half;
        if (dx * dx + dz * dz < rr * rr) return true;
        continue;
      }
      if (y >= c.h - 0.05) continue;
      if (c.minY !== undefined && y + BODY <= c.minY + 0.02) continue;
      const dx = x - Math.max(c.minx, Math.min(c.maxx, x)), dz = z - Math.max(c.minz, Math.min(c.maxz, z));
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }
  // ¿pasa un cuerpo delgado (0.12 m) en línea recta de a a b a la altura y?
  _lineFree(ax, az, bx, bz, y) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.1));
    for (let i = 1; i <= n; i++) {
      if (this.blocked(ax + (bx - ax) * i / n, az + (bz - az) * i / n, y, 0.12)) return false;
    }
    return true;
  }
  // misma regla que World.groundHeight, con el radio real del cuerpo
  ground(x, z, y) {
    const p = { x, z };
    let g = this.source.baseGround(p, 0.38);
    const m = 0.19, list = this._near(x, z);
    if (list) for (const c of list) {
      if (c.segment || c.h > y + 0.25 || c.h <= g) continue;
      if (x + m < c.minx || x - m > c.maxx || z + m < c.minz || z - m > c.maxz) continue;
      g = c.h;
    }
    return g;
  }
  // Camina de (ax,az,ay) a (bx,bz) en pasos cortos. Devuelve la altura de
  // llegada o NaN si algo lo impide.
  walk(ax, az, ay, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(dist / 0.125));
    let y = ay;
    for (let i = 1; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      if (this.blocked(x, z, y)) return NaN;
      const g = this.ground(x, z, y);
      if (g - y > STEP_UP || y - g > DROP) return NaN;
      if (g !== y && this.blocked(x, z, g)) return NaN;
      y = g;
    }
    return y;
  }

  // ---------- rejilla ----------
  _centre(i, j) { return { x: -this.fx + (i + 0.5) * CELL, z: -this.fz + (j + 0.5) * CELL }; }
  _cell(x, z) { return [Math.floor((x + this.fx) / CELL), Math.floor((z + this.fz) / CELL)]; }
  _flood(seeds) {
    const n = this.nx * this.nz;
    this.height = new Float32Array(n).fill(NaN);
    this.links = new Uint8Array(n);   // bit d: se puede pasar a la vecina DIRS[d]
    const stack = [];
    for (const s of seeds) {
      const [i, j] = this._cell(s.x, s.z);
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
      const k = j * this.nx + i, c = this._centre(i, j);
      if (!Number.isNaN(this.height[k])) continue;
      const y = this.ground(c.x, c.z, 0);
      if (this.blocked(c.x, c.z, y)) continue;
      this.height[k] = y; stack.push(k);
    }
    // 1) alturas: se propaga por los 4 vecinos ortogonales
    while (stack.length) {
      const k = stack.pop(), i = k % this.nx, j = (k - i) / this.nx, y = this.height[k], a = this._centre(i, j);
      for (let d = 0; d < 8; d += 2) {
        const i2 = i + DIRS[d][0], j2 = j + DIRS[d][1];
        if (i2 < 0 || j2 < 0 || i2 >= this.nx || j2 >= this.nz) continue;
        const k2 = j2 * this.nx + i2;
        if (!Number.isNaN(this.height[k2])) continue;
        const b = this._centre(i2, j2), y2 = this.walk(a.x, a.z, y, b.x, b.z);
        if (Number.isNaN(y2)) continue;
        this.height[k2] = y2; stack.push(k2);
      }
    }
    // 2) enlaces dirigidos entre celdas ya alcanzadas (incluye diagonales)
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const k = j * this.nx + i, y = this.height[k];
      if (Number.isNaN(y)) continue;
      const a = this._centre(i, j);
      let bits = 0;
      for (let d = 0; d < 8; d++) {
        const i2 = i + DIRS[d][0], j2 = j + DIRS[d][1];
        if (i2 < 0 || j2 < 0 || i2 >= this.nx || j2 >= this.nz) continue;
        const y2 = this.height[j2 * this.nx + i2];
        if (Number.isNaN(y2)) continue;
        const b = this._centre(i2, j2), got = this.walk(a.x, a.z, y, b.x, b.z);
        if (!Number.isNaN(got) && Math.abs(got - y2) < 0.02) bits |= 1 << d;
      }
      this.links[k] = bits;
    }
  }
  // coste extra junto a paredes: las rutas van por el centro de los pasos
  _clearance() {
    this.cost = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const k = j * this.nx + i;
      if (Number.isNaN(this.height[k])) continue;
      const open = this.links[k];
      let missing = 0;
      for (let d = 0; d < 8; d++) if (!(open & (1 << d))) missing++;
      this.cost[k] = missing ? 0.35 + missing * 0.12 : 0;
    }
  }
  // celda transitable más cercana a p (hasta 4 m)
  // Con y: solo celdas de ESE piso (un bot empujado contra el costado de una
  // rampa está a y=0 aunque la celda de encima esté a 0.4: desde ahí la
  // ruta no puede empezar en la rampa).
  _snap(p, y) {
    const [ci, cj] = this._cell(p.x, p.z);
    let best = -1, bestD = Infinity;
    if (y !== undefined) {
      for (let ring = 0; ring <= 4 && best < 0; ring++) {
        for (let j = cj - ring; j <= cj + ring; j++) for (let i = ci - ring; i <= ci + ring; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
          const k = j * this.nx + i, h = this.height[k];
          if (Number.isNaN(h) || Math.abs(h - y) > 0.22) continue;
          const c = this._centre(i, j), d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
          // la celda más cercana puede estar al otro lado de un muro delgado:
          // desde ahí la ruta empujaría al bot contra el muro
          if (d < bestD && this._lineFree(p.x, p.z, c.x, c.z, h)) { bestD = d; best = k; }
        }
      }
      if (best >= 0) return best;
    }
    for (let ring = 0; ring <= 8 && best < 0; ring++) {
      for (let j = cj - ring; j <= cj + ring; j++) for (let i = ci - ring; i <= ci + ring; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        const k = j * this.nx + i;
        if (Number.isNaN(this.height[k])) continue;
        const c = this._centre(i, j), d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best;
  }

  // ---------- consultas ----------
  distance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
  heightAt(p) {
    const k = this._snap(p);
    return k < 0 ? 0 : this.height[k];
  }
  walkable(p) {
    const [i, j] = this._cell(p.x, p.z);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false;
    const y = this.height[j * this.nx + i];
    return !Number.isNaN(y) && !this.blocked(p.x, p.z, this.ground(p.x, p.z, y));
  }
  // ¿cabe el cuerpo de pie en p a la altura y (celda alcanzada, mismo piso)?
  // Más barato que clear(): sirve para sondear pasos cortos de movimiento local.
  standable(p, y) {
    const [i, j] = this._cell(p.x, p.z);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false;
    const h = this.height[j * this.nx + i];
    return !Number.isNaN(h) && Math.abs(h - y) < 0.22 && !this.blocked(p.x, p.z, h);
  }
  nearest(p, y) {
    const k = this._snap(p, y);
    if (k < 0) return null;
    const i = k % this.nx;
    return this._centre(i, (k - i) / this.nx);
  }
  // ¿se puede ir andando en línea recta de a a b?
  clear(a, b, ay) {
    const k = this._snap(a, ay);
    if (k < 0) return false;
    const y0 = this.ground(a.x, a.z, this.height[k]);
    const y = this.walk(a.x, a.z, y0, b.x, b.z);
    if (Number.isNaN(y)) return false;
    const kb = this._snap(b);
    return kb >= 0 && Math.abs(this.height[kb] - y) < 0.6;
  }
  path(from, goal, fromY) {
    const start = this._snap(from, fromY), end = this._snap(goal);
    if (start < 0 || end < 0) return [];
    const nx = this.nx, n = nx * this.nz;
    const g = this._g ?? (this._g = new Float32Array(n)), came = this._came ?? (this._came = new Int32Array(n));
    const stamp = this._stamp ?? (this._stamp = new Uint32Array(n));
    const run = this._run = (this._run ?? 0) + 1;
    const ei = end % nx, ej = (end - ei) / nx;
    const h = (k) => { const i = k % nx, j = (k - i) / nx, dx = Math.abs(i - ei), dz = Math.abs(j - ej); return (Math.max(dx, dz) + 0.4142 * Math.min(dx, dz)) * CELL; };
    const heap = [], push = (k, f) => { heap.push([f, k]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let p = 0; for (;;) { let c = p * 2 + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; p = c; } } return top; };
    g[start] = 0; came[start] = -1; stamp[start] = run; push(start, h(start));
    let found = false;
    while (heap.length) {
      const [f, k] = pop();
      if (k === end) { found = true; break; }
      if (f > g[k] + h(k) + 1e-4) continue;
      const i = k % nx, j = (k - i) / nx, open = this.links[k];
      for (let d = 0; d < 8; d++) {
        if (!(open & (1 << d))) continue;
        // una diagonal no recorta la esquina de un obstáculo
        if (d & 1 && (!(open & (1 << ((d + 7) & 7))) || !(open & (1 << ((d + 1) & 7))))) continue;
        const k2 = (j + DIRS[d][1]) * nx + i + DIRS[d][0];
        const cost = g[k] + (d & 1 ? 1.4142 : 1) * CELL * (1 + this.cost[k2]);
        if (stamp[k2] === run && cost >= g[k2]) continue;
        g[k2] = cost; came[k2] = k; stamp[k2] = run; push(k2, cost + h(k2));
      }
    }
    if (!found) return [];
    const cells = [];
    for (let k = end; k >= 0; k = came[k]) cells.push(k);
    cells.reverse();
    // estirar la cuerda: saltarse celdas mientras el tramo recto sea andable
    const pts = cells.map((k) => { const i = k % nx; return this._centre(i, (k - i) / nx); });
    const goalOk = this.walkable(goal) && this.distance(pts[pts.length - 1], goal) < 1 && this.clear(pts[pts.length - 1], goal);
    if (goalOk) pts.push({ x: goal.x, z: goal.z });
    const out = [];
    let at = { x: from.x, z: from.z }, i = 0;
    while (i < pts.length) {
      let far = i;
      for (let step = Math.min(pts.length - 1, i + 24); step > i; step--) {
        if (this.clear(at, pts[step], at === from ? fromY : undefined)) { far = step; break; }
      }
      out.push(pts[far]); at = pts[far]; i = far + 1;
    }
    return out;
  }
  // Siguiente punto de la ruta de owner hacia goal. La ruta se sigue punto a
  // punto sin volver a comprobar cada cuadro que el tramo desde la posición
  // exacta sea recto y holgado: junto a una esquina esa comprobación (radio
  // 0.48 frente a los 0.38 del cuerpo) fallaba un cuadro sí y otro no, y el
  // bot alternaba entre la ruta y el rodeo a ciegas sin moverse del sitio.
  // Se rehace solo si el destino cambió o si el bot quedó lejos de su tramo.
  next(from, goal, owner) {
    if (!goal) return null;
    const fy = owner?.y;
    let saved = this.cache.get(owner);
    // un blanco que se mueve (persecución) tolera 1.5 m antes de rehacer la
    // ruta; un destino fijo nuevo, aunque esté cerca del anterior, no: su ruta
    // (y si es parcial) es otra
    const tol = goal.id !== undefined ? 1.5 : 0.25;
    let stale = !saved || this.distance(saved.goal, goal) > tol || !saved.path.length;
    if (!stale && segDist(from, saved.prev, saved.path[0]) > 1.6) stale = true;
    if (stale) {
      const path = this.path(from, goal, fy);
      // ruta PARCIAL: el destino cae donde no cabe un cuerpo y la ruta acaba
      // en la celda más cercana. Quien la sigue debe saber que no llegará.
      const end = path[path.length - 1];
      const partial = !end || this.distance(end, goal) > 1.2;
      const g = saved?.goal ?? { x: 0, z: 0 };
      g.x = goal.x; g.z = goal.z;
      const prev = saved?.prev ?? { x: 0, z: 0 };
      prev.x = from.x; prev.z = from.z;
      saved = { goal: g, prev, path, partial };
      this.cache.set(owner, saved);
    }
    // Pasar al siguiente punto al llegar a él (quien sigue la ruta no se pasa
    // del punto: ver reach en botmatch), o antes si el tramo siguiente ya es
    // recto desde aquí. Saltarse una esquina sin haber llegado metía al bot
    // en diagonal contra ella.
    while (saved.path.length > 1) {
      const d = this.distance(from, saved.path[0]);
      if (d < 0.15 || (d < 1.5 && this.clear(from, saved.path[1], fy))) {
        const p = saved.path.shift();
        saved.prev.x = p.x; saved.prev.z = p.z;
      } else break;
    }
    return saved.path[0] ?? null;
  }
  // ¿la ruta en curso de owner termina lejos de su destino y ya llegó a su
  // último punto? (destino inalcanzable: hay que elegir otro)
  stranded(owner, from) {
    const saved = this.cache.get(owner);
    return !!saved && saved.partial && saved.path.length <= 1 &&
      (!saved.path.length || this.distance(from, saved.path[0]) < 0.6);
  }
  // longitud de la ruta andando (para análisis de tiempos de llegada)
  routeLength(from, goal) {
    const path = this.path(from, goal);
    if (!path.length) return Infinity;
    let d = 0, at = from;
    for (const p of path) { d += this.distance(at, p); at = p; }
    return d;
  }
}
