// Capa de vida "ruina" del look de Calle (ver el contrato en ../index.js).
// Meses de abandono sobre la avenida acordonada, todo PLANO y pegado a lo que
// ya existe (nada que se lea como cobertura ni cambie una silueta):
//  - en las paredes: tags y pintadas rápidas de espray (avisos de quien se
//    quedó: HELP, NO FOOD, flechas, cuentas de días), carteles de evacuación
//    rotos, hollín, y una X de espray sobre los carteles oficiales;
//  - escaparates tapiados con tablones;
//  - en el suelo: quemaduras, manchas de aceite, grietas con hierbajos,
//    basura y vidrio roto (planos, ≤ 3 cm; hierbajos ≤ 0.25 m), escaso;
//  - cinta policial colgando floja A LO LARGO de las barreras existentes;
//  - un rótulo de bandera desprendido que se mece, por encima de 5 m.
// Las posiciones se encuentran con rayos contra el mapa (se pegan a la
// superficie real); las elecciones salen de ctx.rng (iguales en todos los
// clientes). Todo con un atlas pintado en un canvas: tres llamadas.
import { patch } from '../glsl.js';
import { WASH_VERT, washFrag, washPars } from './sources.js';

const COLS = 8, ROWS = 4, CELL = 256;
const CELLS = {
  tag: [0, 1, 2, 3, 4, 5, 6, 7], poster: [8, 9, 10], xmark: 11, scorch: [12, 13], stain: [14, 15],
  crack: [16, 17], litter: [18, 19, 20, 21], glass: [22, 23], board: 24, tape: 25, weed: [26, 27],
  sign: 28, arrow: 29, tally: 30, skid: 31,
};

export function build(ctx) {
  if (ctx.theme !== 'calle') return null;
  const { THREE, world } = ctx;
  const detail = ctx.budget?.detail ?? 1;
  const rng = ctx.rng('ruina');
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const tex = new THREE.CanvasTexture(paintAtlas(rng));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  // ---------------------------------------------------------------- rayos
  // Solo contra las mallas cuya caja toca el segmento (el mapa fusionado tiene
  // mallas de decenas de miles de triángulos).
  const meshes = [];
  world.mapGroup.updateWorldMatrix(true, true);
  world.mapGroup.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh && o.name === 'calle2-light-pools') return;
    for (let p = o; p; p = p.parent) if (p.visible === false) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.transparent || m.isShaderMaterial) return;
    const box = new THREE.Box3().setFromObject(o);
    if (!box.isEmpty()) meshes.push({ o, box });
  });
  const ray = new THREE.Raycaster();
  const segBox = new THREE.Box3(), tmp = new THREE.Vector3();
  const cast = (from, dir, far) => {
    segBox.makeEmpty().expandByPoint(from).expandByPoint(tmp.copy(dir).multiplyScalar(far).add(from));
    const cands = meshes.filter((e) => e.box.intersectsBox(segBox)).map((e) => e.o);
    if (!cands.length) return null;
    ray.set(from, dir); ray.far = far;
    const hit = ray.intersectObjects(cands, false)[0];
    if (!hit?.face) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.dot(dir) > 0) n.negate();
    return { p: hit.point.clone(), n, d: hit.distance };
  };
  // pared plana bajo un rectángulo w×h: centro y cuatro bordes a la misma
  // distancia y con la misma normal
  const wallAt = (from, dir, w, h, accept) => {
    const c = cast(from, dir, 8);
    if (!c || Math.abs(c.n.y) > 0.1 || !accept(c.p)) return null;
    const right = new THREE.Vector3(c.n.z, 0, -c.n.x);
    // un borde puede caer en una moldura: se tolera uno, no dos
    let bad = 0;
    for (const [a, b] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
      const o = from.clone().addScaledVector(right, a * w).add(new THREE.Vector3(0, b * h, 0));
      const e = cast(o, dir, 8);
      if (!e || Math.abs(e.d - c.d) > 0.06 || e.n.dot(c.n) < 0.98) bad++;
    }
    return bad > 1 ? null : c;
  };

  // ---------------------------------------------------------------- quads
  const blend = { p: [], n: [], uv: [] }, cut = { p: [], n: [], uv: [] };
  const uvOf = (cell, u0 = 0, v0 = 0, u1 = 1, v1 = 1) => {
    const cu = (cell % COLS) / COLS, cv = 1 - (Math.floor(cell / COLS) + 1) / ROWS;
    return [cu + u0 / COLS, cv + v0 / ROWS, cu + u1 / COLS, cv + v1 / ROWS];
  };
  // centro c, ejes unitarios r (derecha) y u (arriba); normal = r × u
  const stamps = [];
  const quad = (B, c, r, u, w, h, uv) => {
    const [a0, b0, a1, b1] = uv;
    const n = new THREE.Vector3().crossVectors(r, u).normalize();
    if (B===blend || B===cut) {
      // Dos impresiones del atlas pueden coincidir en la misma pared o losa.
      // Solo apilamos las que comparten superficie e interior en proyección.
      const dx=r.clone().multiplyScalar(w/2), dy=u.clone().multiplyScalar(h/2);
      const depths=[];
      for (const stamp of stamps) {
        if (Math.abs(n.dot(stamp.n))<.999999) continue;
        const delta=stamp.c.clone().sub(c);
        const depth=n.dot(delta);
        if (Math.abs(depth)>.04) continue;
        const axes=[dx,dy,stamp.dx,stamp.dy];
        const touches=axes.every(edge=>{
          const axis=new THREE.Vector3().crossVectors(n,edge).normalize();
          const reach=axes.reduce((sum,v)=>sum+Math.abs(axis.dot(v)),0);
          return Math.abs(axis.dot(delta))<reach-.00001;
        });
        if(touches)depths.push(depth);
      }
      let offset=0;
      for(const depth of depths.sort((a,b)=>a-b))if(Math.abs(offset-depth)<.003)offset=depth+.0035;
      c=c.clone().addScaledVector(n,offset);
      stamps.push({c,n,dx,dy});
    }
    const P = (sx, sy) => c.clone().addScaledVector(r, sx * w / 2).addScaledVector(u, sy * h / 2);
    const vs = [[P(-1, -1), a0, b0], [P(1, -1), a1, b0], [P(1, 1), a1, b1], [P(-1, -1), a0, b0], [P(1, 1), a1, b1], [P(-1, 1), a0, b1]];
    for (const [p, s, t] of vs) { B.p.push(p.x, p.y, p.z); B.n.push(n.x, n.y, n.z); B.uv.push(s, t); }
  };
  const UP = new THREE.Vector3(0, 1, 0);
  const onWall = (B, hit, w, h, cell, roll = 0, lift = 0.014) => {
    const r = new THREE.Vector3(hit.n.z, 0, -hit.n.x).applyAxisAngle(hit.n, roll);
    const u = UP.clone().applyAxisAngle(hit.n, roll);
    quad(B, hit.p.clone().addScaledVector(hit.n, lift), r, u, w, h, uvOf(cell));
  };
  const onGround = (B, x, y, z, w, h, cell, yaw, uv = null) => {
    const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const u = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    quad(B, new THREE.Vector3(x, y, z), r, u, w, h, uv ?? uvOf(cell));
  };
  // suelo: calzada (0), acera (+1.4 cm) o callejón; nunca bajo un collider
  const groundY = (x, z) => {
    const ax = Math.abs(x);
    if (ax < 11.3) return 0.03;
    if (ax > 11.9 && ax < 16.0) return 0.04;
    if (ax > 21.9 && ax < 28.6) return 0.04;
    return -1;
  };
  const free = (x, z, r) => !ctx.blocked(x, z, r) && ctx.inField(x, z, 0.4);

  // ---------------------------------------------------------------- paredes
  const wallTags = [];
  const tryWall = (from, dir, w, h, cell, accept, roll = 0) => {
    const hit = wallAt(from, dir, w, h, accept);
    if (!hit) return false;
    onWall(blend, hit, w, h, cell, roll);
    wallTags.push(hit.p);
    return true;
  };
  const near = (p) => wallTags.some((q) => q.distanceTo(p) < 1.2);
  const density = 0.55 + 0.45 * detail;
  // fachadas de la avenida (planta baja)
  for (const s of [-1, 1]) for (let z = -38; z <= 38; z += 1.3) {
    if (rng() > 0.8 * density) continue;
    const zz = z + (rng() - 0.5) * 1.6, y = 0.75 + rng() * 1.5;
    const poster = rng() < 0.3;
    const w = poster ? 0.55 + rng() * 0.25 : 0.9 + rng() * 0.9, h = poster ? w * 1.35 : w * (0.45 + rng() * 0.25);
    const from = new THREE.Vector3(s * 12.6, y, zz);
    if (near(from.clone().setX(s * 16))) continue;
    tryWall(from, new THREE.Vector3(s, 0, 0), w, h, poster ? pick(CELLS.poster) : pick(CELLS.tag),
      (p) => Math.abs(p.x) > 15.5 && Math.abs(p.x) < 17.3, (rng() - 0.5) * (poster ? 0.12 : 0.2));
  }
  // muros de cierre (tras los autobuses) y portones
  for (const d of [-1, 1]) for (let x = -15; x <= 15; x += 3.1) {
    if (rng() > 0.62 * density) continue;
    const y = 0.8 + rng() * 1.6, w = 1.0 + rng() * 1.1;
    tryWall(new THREE.Vector3(x + (rng() - 0.5), y, d * 36.5), new THREE.Vector3(0, 0, d), w, w * 0.55,
      pick([...CELLS.tag, CELLS.tally, CELLS.arrow]), (p) => Math.abs(p.z) > 40.3 && Math.abs(p.z) < 42.5, (rng() - 0.5) * 0.15);
  }
  // callejón de servicio y taller: muros de ladrillo de los lados
  for (const s of [-1, 1]) for (const wx of [21.6, 28.95]) for (let z = -19; z <= 19; z += 1.8) {
    if (rng() > 0.7 * density) continue;
    const y = 0.7 + rng() * 1.5, w = 0.9 + rng() * 0.9;
    const dir = new THREE.Vector3(wx < 25 ? -s : s, 0, 0);
    tryWall(new THREE.Vector3(s * 25.2, y, z + (rng() - 0.5) * 2), dir, w, w * 0.55,
      pick([...CELLS.tag, CELLS.arrow, ...CELLS.poster]), (p) => Math.abs(Math.abs(p.x) - wx) < 0.5, (rng() - 0.5) * 0.2);
  }
  // hollín sobre la pared junto a una quemadura del suelo (ver más abajo)
  const scorchWall = (x, z, dir) => {
    const hit = wallAt(new THREE.Vector3(x, 1.3, z), dir, 1.6, 2.2, (p) => Math.abs(p.x) > 15.5 || Math.abs(p.z) > 40);
    if (hit) onWall(blend, hit, 1.6, 2.2, CELLS.scorch[1], 0, 0.016);
  };
  // carteles oficiales tachados con espray: el de evacuación y el del cordón
  const signs = [];
  world.mapGroup.traverse((o) => { if (/^map-sign:[^:]*:(EVACUATION|POLICE CORDON|DELIVERIES)$/.test(o.name)) signs.push(o); });
  signs.forEach((sg) => {
    if (rng() > 0.55) return;
    const b = new THREE.Box3().setFromObject(sg), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const n = sg.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const w = Math.max(size.x, size.z) * 0.9, h = size.y * 1.1;
    onWall(blend, { p: c.addScaledVector(n, 0.045), n }, w, h, CELLS.xmark, (rng() - 0.5) * 0.2, 0);
  });

  // ---------------------------------------------------------------- tapiados
  // cuatro escaparates (dos por acera) con tablones clavados encima
  const shops = [];
  world.mapGroup.traverse((o) => { if (o.name === 'calle2-shop-display') shops.push(o); });
  shops.sort((a, b) => a.getWorldPosition(new THREE.Vector3()).z - b.getWorldPosition(new THREE.Vector3()).z);
  for (const s of [-1, 1]) {
    const row = shops.filter((o) => Math.sign(o.getWorldPosition(new THREE.Vector3()).x) === s);
    const picks = new Set();
    while (picks.size < Math.min(2, row.length)) picks.add(row[Math.floor(rng() * row.length)]);
    for (const shop of picks) {
    const c = shop.getWorldPosition(new THREE.Vector3());
    const n = new THREE.Vector3(0, 0, 1).transformDirection(shop.matrixWorld).setY(0).normalize();
    const g = shop.geometry.parameters ?? { width: 3, height: 2 };
    const r = new THREE.Vector3(n.z, 0, -n.x);
    const planks = Math.max(3, Math.round(g.height / 0.42));
    for (let i = 0; i < planks; i++) {
      const y = (i + 0.5) / planks - 0.5;
      const pc = c.clone().addScaledVector(UP, y * g.height).addScaledVector(n, 0.02 + i * 0.002);
      const roll = (rng() - 0.5) * 0.08;
      quad(cut, pc, r.clone().applyAxisAngle(n, roll), UP.clone().applyAxisAngle(n, roll), g.width * (1.02 + rng() * 0.06), g.height / planks * 0.92, uvOf(CELLS.board, 0, 0.06 + (i % 4) * 0.22, 1, 0.24 + (i % 4) * 0.22));
    }
    // un tablón cruzado en diagonal
    quad(cut, c.clone().addScaledVector(n, 0.035), r.clone().applyAxisAngle(n, 0.5), UP.clone().applyAxisAngle(n, 0.5), g.width * 1.05, 0.34, uvOf(CELLS.board, 0, 0.5, 1, 0.66));
    // y encima de los tablones, una pintada grande
    quad(blend, c.clone().addScaledVector(n, 0.05).addScaledVector(UP, 0.1), r, UP, g.width * 0.95, g.width * 0.5, uvOf(pick(CELLS.tag)));
    }
  }

  // cartuchos de bengala tumbados junto a su llama (sources.js): una tira roja
  // plana del rótulo del atlas
  for (const f of ctx.calle?.sources?.list ?? []) {
    if (f.kind !== 'flare') continue;
    onGround(cut, f.pos.x - Math.cos(f.yaw) * 0.13, 0.034, f.pos.z + Math.sin(f.yaw) * 0.13, 0.24, 0.045, -1, f.yaw, uvOf(CELLS.sign, 0.094, 0.14, 0.156, 0.22));
  }

  // ---------------------------------------------------------------- a escala
  // Lo que se lee a 30-40 m: pintadas grandes en persianas, portones y
  // paredes ciegas; huellas largas de frenazo y de fuego en la calzada;
  // basura amontonada contra el bordillo; un rótulo caído en la acera.
  for (const s of [-1, 1]) for (let z = -36; z <= 36; z += 4.2) {
    if (rng() > 0.5) continue;
    const w = 2.2 + rng() * 1.3, h = w * (0.42 + rng() * 0.15);
    tryWall(new THREE.Vector3(s * 12.6, 1.35 + rng() * 0.4, z + (rng() - 0.5) * 2), new THREE.Vector3(s, 0, 0), w, h,
      pick(CELLS.tag), (p) => Math.abs(p.x) > 15.5 && Math.abs(p.x) < 17.3, (rng() - 0.5) * 0.12);
  }
  for (const d of [-1, 1]) {
    // el portón de servicio del muro de cierre: una pintada que lo cruza
    tryWall(new THREE.Vector3(d * 0.6, 1.9, d * 36.5), new THREE.Vector3(0, 0, d), 4.6, 2.1, CELLS.tag[d < 0 ? 0 : 4], (p) => Math.abs(p.z) > 40.3, d * 0.05);
  }
  for (const s of [-1, 1]) {
    // frenazos largos (dos ruedas) y una estela de quemado hacia el auto ardido
    for (const [x0, z0, len, yaw] of [[-4.6, -19, 11, 0.12], [2.2, -31.5, 8, -0.2], [7.2, -6, 9, 0.35]]) {
      const x = s * x0, z = s * z0;
      onGround(blend, x, 0.031, z, 1.1, len, CELLS.skid, yaw + (s < 0 ? 0 : Math.PI));
    }
    const sx = s * 4.4, sz = -s * 10.2;
    onGround(blend, sx, 0.032, sz, 2.2, 7.5, CELLS.scorch[0], 0.15 + (s < 0 ? 0 : Math.PI));
  }
  // basura contra el bordillo: montones de 6-10 piezas en la cuneta
  for (let k = 0; k < Math.round(14 * detail); k++) {
    const s = rng() < 0.5 ? -1 : 1, z = (rng() - 0.5) * 76;
    if (ctx.blocked(s * 11.2, z, 1.0)) continue;
    const n = 6 + Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      const x = s * (11.38 - rng() * rng() * 0.9), zz = z + (rng() - 0.5) * 1.8;
      onGround(cut, x, 0.035 + i * 0.0015, zz, 0.24 + rng() * 0.2, 0.2 + rng() * 0.2, pick(CELLS.litter), rng() * 6.28);
    }
    onGround(blend, s * 11.0, 0.032, z, 1.0, 2.4, CELLS.stain[1], 0);
  }
  // rótulo de bandera caído en la acera (plano: 2 cm), con su soporte
  for (const s of [-1, 1]) {
    for (let k = 0; k < 10; k++) {
      const x = s * (13.0 + rng() * 2.2), z = s * (-6 - rng() * 20);
      if (!free(x, z, 0.8)) continue;
      const yaw = rng() * Math.PI;
      onGround(cut, x, 0.045, z, 0.95, 0.62, CELLS.sign, yaw);
      onGround(cut, x + Math.cos(yaw) * 0.75, 0.04, z - Math.sin(yaw) * 0.75, 0.9, 0.05, CELLS.tape - 1, yaw);
      onGround(blend, x, 0.033, z, 1.6, 1.4, CELLS.glass[0], yaw + 1);
      break;
    }
  }

  // ---------------------------------------------------------------- suelo
  const groundAt = (B, x, z, w, h, cell, extra = 0) => {
    const y = groundY(x, z);
    if (y < 0 || !free(x, z, Math.max(w, h) * 0.5)) return false;
    onGround(B, x, y + extra, z, w, h, cell, rng() * Math.PI * 2);
    return true;
  };
  // quemaduras: donde ardió algo (junto a las patrullas y al pie de un muro)
  const S = ctx.calle?.sources?.list ?? [];
  const cars = [];
  world.mapGroup.children.forEach((o) => { if (o.userData?.police) cars.push(o); });
  for (const car of cars) {
    const p = car.localToWorld(new THREE.Vector3(2.6, 0, -1.2));
    groundAt(blend, p.x, p.z, 2.6, 2.6, CELLS.scorch[0], 0.002);
    const q = car.localToWorld(new THREE.Vector3(-0.6, 0, 5.5));
    groundAt(blend, q.x, q.z, 1.2, 3.6, CELLS.skid, 0.001);
  }
  // bajo los sedanes quemados (surfaces los reconoce por el mismo color)
  world.mapGroup.children.forEach((o) => {
    if (o.userData?.callePolish !== 'sedan') return;
    let burnt = false;
    o.traverse((m) => {
      const mt = m.material;
      if (mt && !Array.isArray(mt) && mt.map && mt.bumpMap && Math.abs(mt.color.getHex() - 0x815e4f) < 0x030303) burnt = true;
    });
    if (burnt) onGround(blend, o.position.x, 0.033, o.position.z, 3.8, 6.0, CELLS.scorch[0], o.rotation.y);
  });
  for (const s of [-1, 1]) {
    groundAt(blend, s * 14.9, s * 21.5, 1.8, 1.8, CELLS.scorch[1], 0.002);
    scorchWall(s * 13, s * 21.5, new THREE.Vector3(s, 0, 0));
  }
  const scatter = (count, area, cells, size, B, extra) => {
    let n = 0;
    for (let k = 0; k < count * 6 && n < count; k++) {
      const [x, z] = area();
      if (groundAt(B, x, z, size[0] + rng() * size[1], size[0] + rng() * size[1], pick(cells), extra)) n++;
    }
  };
  const curb = () => { const s = rng() < 0.5 ? -1 : 1; return [s * (10.4 + rng() * 0.8), (rng() - 0.5) * 80]; };
  const walk = () => { const s = rng() < 0.5 ? -1 : 1; return [s * (12.2 + rng() * 3.6), (rng() - 0.5) * 80]; };
  const road = () => [(rng() - 0.5) * 21, (rng() - 0.5) * 78];
  const alley = () => { const s = rng() < 0.5 ? -1 : 1; return [s * (22.4 + rng() * 6), (rng() - 0.5) * 38]; };
  const D = (n) => Math.max(1, Math.round(n * detail));
  scatter(D(12), road, CELLS.stain, [0.9, 1.2], blend, 0.001);
  scatter(D(8), walk, CELLS.stain, [0.6, 0.6], blend, 0.001);
  scatter(D(9), () => (rng() < 0.6 ? curb() : road()), CELLS.crack, [1.0, 1.0], blend, 0.0015);
  scatter(D(9), alley, [...CELLS.stain, ...CELLS.crack], [1.0, 0.9], blend, 0.001);
  // basura y vidrio: recortado (no se ordena), pegado al suelo
  scatter(D(34), () => (rng() < 0.5 ? curb() : walk()), CELLS.litter, [0.3, 0.22], cut, 0.006);
  scatter(D(14), road, CELLS.litter, [0.3, 0.2], cut, 0.006);
  scatter(D(16), alley, CELLS.litter, [0.3, 0.22], cut, 0.006);
  // vidrio roto bajo escaparates y junto a los autos
  for (const shop of shops) {
    if (rng() > 0.45) continue;
    const c = shop.getWorldPosition(new THREE.Vector3());
    const n = new THREE.Vector3(0, 0, 1).transformDirection(shop.matrixWorld).setY(0).normalize();
    const p = c.addScaledVector(n, 0.5 + rng() * 0.4);
    groundAt(cut, p.x + (rng() - 0.5) * 0.8, p.z + (rng() - 0.5) * 1.2, 0.8, 0.8, pick(CELLS.glass), 0.004);
  }
  world.mapGroup.children.forEach((o) => {
    if (o.userData?.callePolish !== 'sedan' || rng() > 0.5) return;
    const p = o.localToWorld(new THREE.Vector3((rng() < 0.5 ? -1 : 1) * 1.55, 0, (rng() - 0.5) * 2));
    groundAt(cut, p.x, p.z, 0.7, 0.7, pick(CELLS.glass), 0.004);
  });

  // hierbajos en las grietas y al pie de bordillos y muros: dos planos
  // cruzados, ≤ 0.25 m, escasos
  const weeds = (x, z) => {
    const y = groundY(x, z);
    if (y < 0 || !free(x, z, 0.3)) return;
    const h = 0.12 + rng() * 0.13, w = h * (1.1 + rng() * 0.5), yaw = rng() * Math.PI, cell = pick(CELLS.weed);
    for (const a of [yaw, yaw + Math.PI / 2]) {
      const r = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      quad(cut, new THREE.Vector3(x, y - 0.02 + h / 2, z), r, UP, w, h, uvOf(cell));
    }
  };
  for (let k = 0; k < D(26); k++) {
    const s = rng() < 0.5 ? -1 : 1, t = rng();
    if (t < 0.45) weeds(s * (11.95 + rng() * 0.15), (rng() - 0.5) * 80);        // junto al bordillo, en la acera
    else if (t < 0.7) weeds(s * (15.6 + rng() * 0.3), (rng() - 0.5) * 80);      // al pie de las fachadas
    else if (t < 0.85) weeds(s * (22.0 + rng() * 0.2), (rng() - 0.5) * 38);     // callejón
    else weeds(s * (10.8 + rng() * 0.3), (rng() - 0.5) * 78);                  // cuneta
  }

  // ---------------------------------------------------------------- cinta
  // Floja, colgando a lo largo de la cara de las barreras que ya estaban
  // (nunca cruzando un paso), y algún trozo arrancado en el suelo.
  const tapeHeight = 0.07, tapeBottom = 0.4, tapeTop = 0.6;
  // La celda es cuadrada: usamos todo su ancho y solo un quinto de su altura.
  const period = tapeHeight / (tapeTop - tapeBottom);
  const tapeStrip = (start, r, u, length, offset = 0) => {
    for (let pos = 0; pos < length - 1e-8;) {
      const cycles = (pos + offset) / period;
      const u0 = Math.max(0, cycles - Math.floor(cycles + 1e-8));
      const width = Math.min(length - pos, (1 - u0) * period);
      const uv = uvOf(CELLS.tape, u0, tapeBottom, u0 + width / period, tapeTop);
      quad(cut, start.clone().addScaledVector(r, pos + width / 2), r, u, width, tapeHeight, uv);
      pos += width;
    }
  };
  const ribbon = (A, B, sag, n, segs = 10) => {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push(A.clone().lerp(B, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0)).addScaledVector(n, 0.025));
    }
    let traveled = 0;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[i + 1];
      const r = b.clone().sub(a), len = r.length();
      r.normalize();
      // Los tramos de una misma cinta comparten sus dos vértices del empalme.
      tapeStrip(a, r, UP, len, traveled);
      traveled += len;
    }
  };
  const barriers = [];
  world.mapGroup.children.forEach((o) => { const k = o.userData?.blenderProp; if (k === 'jersey' || k === 'roadwork') barriers.push(o); });
  barriers.forEach((b) => {
    const bb = new THREE.Box3().setFromObject(b), c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
    const long = size.x >= size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const across = new THREE.Vector3(long.z, 0, long.x);
    // la cara que mira al centro de la avenida (o la del lado del cordón)
    const face = c.clone().setY(0).dot(across) > 0 ? across.clone().negate() : across.clone();
    if (Math.abs(c.x) < 0.5 && Math.abs(c.z) < 0.5) face.copy(across);
    // la cinta va atada a media altura de la cara (la barrera Jersey se
    // estrecha arriba: más alto quedaría flotando delante del perfil)
    const jersey = b.userData.blenderProp === 'jersey';
    const hit = cast(c.clone().setY(jersey ? 0.62 : 0.95).addScaledVector(face, 2), face.clone().negate(), 3);
    if (!hit) return;
    const half = (long.x ? size.x : size.z) / 2 - 0.12;
    const base = hit.p.clone().setY(jersey ? 0.76 : 1.22);
    const A = base.clone().addScaledVector(long, -half), Bp = base.clone().addScaledVector(long, half * (0.2 + rng() * 0.5));
    ribbon(A, Bp, jersey ? 0.16 + rng() * 0.08 : 0.22 + rng() * 0.12, hit.n);
    // el resto arrancado, en el suelo al pie
    const g = hit.p.clone().addScaledVector(hit.n, 0.35 + rng() * 0.3).addScaledVector(long, half * 0.6);
    const yaw = Math.atan2(-long.z, long.x) + (rng() - 0.5) * 0.6;
    if (groundY(g.x, g.z) >= 0 && !ctx.blocked(g.x, g.z, 0.05)) {
      const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const start = new THREE.Vector3(g.x, groundY(g.x, g.z) + 0.004, g.z).addScaledVector(r, -0.6);
      tapeStrip(start, r, new THREE.Vector3(r.z, 0, -r.x), 1.2);
    }
  });

  // ---------------------------------------------------------------- mallas
  const U = { uLookTime: ctx.uniforms.uLookTime };
  const NS = S.length;
  if (NS && ctx.calle) Object.assign(U, { uLkSrcP: { value: ctx.calle.sources.P }, uLkSrcC: { value: ctx.calle.sources.C } });
  const wash = (m, key) => {
    if (!NS) return m;
    return patch(m, { uniforms: U, vertexPars: 'varying vec3 vLkSW;', vertex: WASH_VERT, fragmentPars: washPars(NS), emissive: washFrag(NS), key: `calle-ruina-${key}-${NS}` });
  };
  const mesh = (B, mat, name, order) => {
    if (!B.p.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(B.n, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.name = name; m.renderOrder = order; m.receiveShadow = true;
    ctx.group.add(m);
  };
  mesh(blend, wash(new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 0.92, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }), 'b'), 'ruina-decals', 1);
  mesh(cut, wash(new THREE.MeshStandardMaterial({
    map: tex, alphaTest: 0.5, side: 2, roughness: 0.8, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }), 'c'), 'ruina-clutter', 0);

  // ---------------------------------------------------------------- rótulo
  // Rótulo de bandera desprendido de un soporte: cuelga de UNA cadena y se
  // mece con el viento. Uno por acera, alto (todo por encima de 5 m).
  const sp = { p: [], n: [], uv: [], piv: [], ph: [] };
  for (const s of [-1, 1]) {
    const z = s * (6 + rng() * 10);
    const hit = cast(new THREE.Vector3(s * 12.5, 6.2, z), new THREE.Vector3(s, 0, 0), 6);
    if (!hit || Math.abs(hit.p.x) < 15.4 || Math.abs(hit.n.y) > 0.1) continue;
    const out = hit.n.clone(), pivot = hit.p.clone().addScaledVector(out, 0.78).setY(6.25);
    const n0 = sp.p.length;
    // brazo del soporte (fijo) y el rótulo, plano en el plano normal-arriba
    const along = new THREE.Vector3(out.z, 0, -out.x);
    quad(sp, hit.p.clone().addScaledVector(out, 0.42).setY(6.3), out, UP, 0.84, 0.05, uvOf(CELLS.sign, 0.02, 0.02, 0.1, 0.1));
    const tilt = 0.62, w = 0.72, h = 0.46;
    const r = out.clone().negate().applyAxisAngle(along, -tilt), u = UP.clone().applyAxisAngle(along, -tilt);
    const center = pivot.clone().addScaledVector(r, w / 2).addScaledVector(u, -h / 2 - 0.08);
    const normal = new THREE.Vector3().crossVectors(r,u).normalize();
    // Anverso y reverso impresos sobre una placa de 6 mm.
    quad(sp, center.clone().addScaledVector(normal,.003), r, u, w, h, uvOf(CELLS.sign, 0.04, 0.12, 0.96, 0.88));
    quad(sp, center.clone().addScaledVector(normal,-.003), r.clone().negate(), u, w, h, uvOf(CELLS.sign, 0.04, 0.12, 0.96, 0.88)); // la otra cara
    // cadena: una tira fina del soporte a la esquina
    quad(sp, pivot.clone().addScaledVector(UP, -0.04), along, UP, 0.025, 0.1, uvOf(CELLS.sign, 0.02, 0.02, 0.1, 0.1));
    const ph = rng() * 6.28;
    for (let i = n0 / 3; i < sp.p.length / 3; i++) {
      const brace = i < n0 / 3 + 6;
      sp.piv.push(pivot.x, pivot.y, pivot.z, brace ? 0 : along.x, 0, brace ? 0 : along.z);
      sp.ph.push(ph);
    }
  }
  if (sp.p.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(sp.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(sp.n, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(sp.uv, 2));
    const pv = new Float32Array(sp.piv);
    geo.setAttribute('aPivot', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(pv, 6), 3, 0));
    geo.setAttribute('aAxis', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(pv, 6), 3, 3));
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(sp.ph, 1));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: 2, roughness: 0.7, metalness: 0.3 });
    patch(mat, {
      uniforms: { uLookTime: ctx.uniforms.uLookTime, uLookWind: ctx.uniforms.uLookWind },
      vertexPars: 'attribute vec3 aPivot; attribute vec3 aAxis; attribute float aPhase; uniform float uLookTime; uniform vec3 uLookWind;',
      vertex: `{
  // péndulo con racha: gira alrededor del eje de la cadena (Rodrigues)
  float a = (0.12 + 0.1 * uLookWind.y) * sin(uLookTime * 1.25 + aPhase) + 0.04 * sin(uLookTime * 3.1 + aPhase * 2.0);
  vec3 k = aAxis; float on = step(0.5, dot(k, k));
  vec3 p = transformed - aPivot;
  vec3 rp = p * cos(a) + cross(k, p) * sin(a) + k * dot(k, p) * (1.0 - cos(a));
  transformed = aPivot + mix(p, rp, on);
}`,
      key: 'calle-swing-sign',
    });
    const m = new THREE.Mesh(geo, mat);
    m.name = 'ruina-swinging-sign';
    m.frustumCulled = false;
    ctx.group.add(m);
  }
  return null;
}

// ---------------------------------------------------------------- atlas
// Todo pintado a mano en un canvas, con el mismo rng: igual en cada carga.
function paintAtlas(rng) {
  const cv = document.createElement('canvas');
  cv.width = COLS * CELL; cv.height = ROWS * CELL;
  const g = cv.getContext('2d');
  const at = (cell, fn) => {
    g.save();
    g.translate((cell % COLS) * CELL, Math.floor(cell / COLS) * CELL);
    g.beginPath(); g.rect(0, 0, CELL, CELL); g.clip();
    fn(g);
    g.restore();
  };
  // espray: tinta con canto difuso, motas alrededor y chorreones
  const SPRAY = ['#e9e5d6', '#151515', '#d0a12e', '#9cc23c', '#b9bdc2', '#c4602c', '#e9e5d6', '#151515'];
  const spray = (c, col, width, path) => {
    c.strokeStyle = col; c.fillStyle = col; c.lineCap = 'round'; c.lineJoin = 'round';
    c.shadowColor = col; c.shadowBlur = width * 0.8;
    c.lineWidth = width; c.globalAlpha = 0.92;
    c.beginPath(); path(c); c.stroke();
    c.shadowBlur = 0;
    for (let i = 0; i < 70; i++) { c.globalAlpha = 0.25 * rng(); c.fillRect(rng() * CELL, rng() * CELL, 1.5, 1.5); }
    c.globalAlpha = 1;
  };
  const drips = (c, col, n, y0, y1) => {
    c.strokeStyle = col; c.lineWidth = 2;
    for (let i = 0; i < n; i++) {
      const x = 30 + rng() * 196, y = y0 + rng() * (y1 - y0);
      c.globalAlpha = 0.8; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rng() - 0.5) * 2, y + 10 + rng() * 34); c.stroke();
    }
    c.globalAlpha = 1;
  };
  const sprayText = (c, text, col, size, rot = 0) => {
    c.save(); c.translate(128, 132); c.rotate(rot);
    c.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = col; c.shadowBlur = 6; c.fillStyle = col; c.globalAlpha = 0.9;
    // dos pasadas algo corridas: el pulso de quien pinta deprisa
    c.fillText(text, 0, 0, 236); c.globalAlpha = 0.5; c.fillText(text, 2, -2, 236);
    c.restore(); c.globalAlpha = 1;
  };
  // tags: letras de firma, avisos de supervivientes, símbolos
  const tagFns = [
    (c) => { sprayText(c, 'HELP', SPRAY[0], 96, -0.06); drips(c, SPRAY[0], 6, 160, 175); },
    (c) => { sprayText(c, 'NO FOOD', SPRAY[2], 58, 0.04); drips(c, SPRAY[2], 4, 150, 160); },
    (c) => { sprayText(c, 'THEY LIED', SPRAY[4], 46, -0.03); drips(c, SPRAY[4], 4, 150, 160); },
    (c) => { // firma: trazos enlazados con contorno
      const pts = Array.from({ length: 7 }, (_, i) => [30 + i * 33 + rng() * 10, 90 + rng() * 80]);
      const path = (k) => { k.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) k.quadraticCurveTo(pts[i][0] - 20, pts[i - 1][1] - 40 + rng() * 80, pts[i][0], pts[i][1]); };
      spray(c, SPRAY[1], 22, path); spray(c, SPRAY[4], 12, path); drips(c, SPRAY[4], 5, 120, 170);
    },
    (c) => { sprayText(c, 'GONE NORTH', SPRAY[5], 40, 0.05); spray(c, SPRAY[5], 8, (k) => { k.moveTo(40, 190); k.lineTo(210, 190); k.moveTo(190, 176); k.lineTo(212, 190); k.lineTo(190, 204); }); },
    (c) => { // círculo tachado y "STAY OUT"
      spray(c, SPRAY[0], 12, (k) => { k.arc(128, 105, 62, 0, Math.PI * 2); k.moveTo(84, 61); k.lineTo(172, 149); });
      c.save(); c.translate(0, 85); sprayText(c, 'STAY OUT', SPRAY[0], 34); c.restore();
    },
    (c) => { sprayText(c, 'KR0Z', SPRAY[3], 110, -0.12); spray(c, SPRAY[1], 5, (k) => { k.moveTo(20, 200); k.lineTo(236, 186); }); },
    (c) => { // marca de registro de casa: X con fecha y cuenta
      spray(c, SPRAY[5], 10, (k) => { k.moveTo(48, 40); k.lineTo(208, 216); k.moveTo(208, 40); k.lineTo(48, 216); });
      c.fillStyle = SPRAY[5]; c.font = '700 26px sans-serif'; c.textAlign = 'center';
      c.fillText('9/14', 128, 70); c.fillText('0', 70, 136); c.fillText('2', 186, 136); c.fillText('NG', 128, 205);
    },
  ];
  tagFns.forEach((fn, i) => at(CELLS.tag[i], fn));
  // carteles de aviso pegados y arrancados
  const poster = (c, title, lines, tint) => {
    c.save();
    c.beginPath(); c.moveTo(34, 10);
    for (let x = 34; x <= 222; x += 12) c.lineTo(x, 8 + rng() * 6);
    for (let y = 10; y <= 250; y += 14) c.lineTo(222 + rng() * 5, y);
    // desgarro diagonal abajo
    c.lineTo(150, 248); c.lineTo(120, 210 + rng() * 20); c.lineTo(90, 240); c.lineTo(34, 244);
    c.closePath(); c.clip();
    c.fillStyle = tint; c.fillRect(0, 0, CELL, CELL);
    c.fillStyle = '#2b2a27'; c.font = '900 30px "Arial Black", sans-serif'; c.textAlign = 'center';
    c.fillText(title, 128, 52, 176);
    c.fillRect(54, 64, 148, 4);
    c.font = '15px sans-serif';
    lines.forEach((l, i) => c.fillText(l, 128, 92 + i * 20, 170));
    for (let i = 0; i < 6; i++) { c.fillStyle = 'rgba(40,36,30,.5)'; c.fillRect(54, 160 + i * 12, 60 + rng() * 88, 4); }
    // sol y agua: el papel se ha ido
    const fade = c.createLinearGradient(0, 0, 0, CELL);
    fade.addColorStop(0, 'rgba(90,80,64,.3)'); fade.addColorStop(1, 'rgba(50,42,34,.6)');
    c.fillStyle = fade; c.fillRect(0, 0, CELL, CELL);
    c.restore();
    c.fillStyle = '#777'; c.fillRect(40, 16, 6, 3); c.fillRect(210, 18, 6, 3);
  };
  at(CELLS.poster[0], (c) => poster(c, 'EVACUATION', ['ORDER No. 7', 'REPORT TO', 'SHELTER B'], '#b8b09a'));
  at(CELLS.poster[1], (c) => { poster(c, 'MISSING', ['HAVE YOU SEEN', 'ANNA R.'], '#bfb8a2'); });
  at(CELLS.poster[2], (c) => poster(c, 'CURFEW', ['20:00 - 06:00', 'BY ORDER OF', 'THE DISTRICT'], '#aaa38c'));
  at(CELLS.xmark, (c) => spray(c, SPRAY[1], 22, (k) => { k.moveTo(24, 30); k.lineTo(232, 226); k.moveTo(230, 34); k.lineTo(26, 222); }));
  const blotch = (c, inner, outer, r0, noise) => {
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2, d = rng() * noise, r = r0 * (0.35 + rng() * 0.5);
      const x = 128 + Math.cos(a) * d, y = 128 + Math.sin(a) * d;
      const gr = c.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, inner); gr.addColorStop(1, outer);
      c.fillStyle = gr; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
  };
  at(CELLS.scorch[0], (c) => { blotch(c, 'rgba(10,8,7,.55)', 'rgba(10,8,7,0)', 90, 50); blotch(c, 'rgba(30,22,16,.35)', 'rgba(30,22,16,0)', 40, 30); });
  at(CELLS.scorch[1], (c) => { // hollín de pared: sube y se abre
    for (let i = 0; i < 30; i++) {
      const y = 250 - rng() * 230, x = 128 + (rng() - 0.5) * (40 + (250 - y) * 0.7), r = 20 + (250 - y) * 0.25 * rng();
      const gr = c.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(12,10,9,.42)'); gr.addColorStop(1, 'rgba(12,10,9,0)');
      c.fillStyle = gr; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
  });
  at(CELLS.stain[0], (c) => blotch(c, 'rgba(6,6,5,.5)', 'rgba(6,6,5,0)', 70, 40));
  at(CELLS.stain[1], (c) => { blotch(c, 'rgba(20,16,10,.45)', 'rgba(20,16,10,0)', 55, 70); blotch(c, 'rgba(40,52,48,.12)', 'rgba(40,52,48,0)', 40, 30); });
  const crack = (c, weedy) => {
    c.strokeStyle = 'rgba(8,8,8,.85)'; c.lineCap = 'round';
    const branch = (x, y, a, len, w) => {
      if (len < 10 || w < 0.6) return;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      c.lineWidth = w; c.beginPath(); c.moveTo(x, y); c.lineTo(x2, y2); c.stroke();
      if (weedy && rng() < 0.35) weedBlades(c, x2, y2, 6 + rng() * 10, 4);
      branch(x2, y2, a + (rng() - 0.5) * 0.9, len * 0.8, w * 0.8);
      if (rng() < 0.35) branch(x2, y2, a + (rng() < 0.5 ? 1 : -1) * (0.6 + rng() * 0.6), len * 0.55, w * 0.6);
    };
    branch(10, 128 + (rng() - 0.5) * 60, (rng() - 0.5) * 0.4, 40, 4.5);
  };
  const weedBlades = (c, x, y, h, n) => {
    for (let i = 0; i < n; i++) {
      c.strokeStyle = ['#4f5a2c', '#5e6a33', '#6d6a3a', '#3f4a26'][i % 4]; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + (rng() - 0.5) * h, y - h * 0.6, x + (rng() - 0.5) * h * 1.2, y - h * (0.6 + rng() * 0.5)); c.stroke();
    }
  };
  at(CELLS.crack[0], (c) => crack(c, false));
  at(CELLS.crack[1], (c) => crack(c, true));
  // basura: papel, periódico, lata aplastada, cartón (opacos, canto recortado)
  at(CELLS.litter[0], (c) => {
    c.translate(128, 128); c.rotate(0.3);
    c.fillStyle = '#cfc9b8'; c.beginPath(); c.moveTo(-70, -90); c.lineTo(66, -84); c.lineTo(74, 86); c.lineTo(-62, 92); c.closePath(); c.fill();
    c.fillStyle = 'rgba(0,0,0,.15)'; c.beginPath(); c.moveTo(-70, -90); c.lineTo(10, 0); c.lineTo(-62, 92); c.fill();
    c.fillStyle = 'rgba(60,60,60,.5)'; for (let i = 0; i < 9; i++) c.fillRect(-50, -60 + i * 16, 80 + rng() * 20, 3);
  });
  at(CELLS.litter[1], (c) => {
    c.translate(128, 128); c.rotate(-0.5);
    c.fillStyle = '#a9a69c'; c.fillRect(-96, -66, 192, 132);
    c.fillStyle = '#c3c0b5'; c.fillRect(-90, -60, 86, 120);
    c.fillStyle = '#2d2d2b'; c.font = '900 20px serif'; c.fillText('THE DAILY', -84, -38);
    c.fillStyle = 'rgba(40,40,40,.55)'; for (let i = 0; i < 6; i++) { c.fillRect(-84, -22 + i * 12, 70, 3); c.fillRect(6, -54 + i * 18, 80, 3); }
  });
  at(CELLS.litter[2], (c) => {
    c.translate(128, 128); c.rotate(0.9);
    c.fillStyle = '#7c7f82'; c.beginPath(); c.ellipse(0, 0, 70, 34, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#8f2f25'; c.beginPath(); c.ellipse(-8, 0, 46, 30, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#c8c8c8'; c.fillRect(48, -18, 8, 36);
  });
  at(CELLS.litter[3], (c) => {
    c.translate(128, 128); c.rotate(-0.2);
    c.fillStyle = '#8b6d48'; c.fillRect(-100, -80, 200, 160);
    c.strokeStyle = '#6e5536'; c.lineWidth = 4; c.strokeRect(-100, -80, 200, 160); c.beginPath(); c.moveTo(-100, 0); c.lineTo(100, 0); c.stroke();
    c.fillStyle = 'rgba(30,24,16,.4)'; c.fillRect(-40, -60, 80, 20);
  });
  const shards = (c, n) => {
    for (let i = 0; i < n; i++) {
      const x = 30 + rng() * 196, y = 30 + rng() * 196, r = 4 + rng() * 14 * (1 - Math.hypot(x - 128, y - 128) / 180);
      c.fillStyle = rng() < 0.3 ? '#e8f2f6' : '#9fb7c2';
      c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r * 0.8, y + r * 0.3); c.lineTo(x - r * 0.5, y + r * 0.7); c.closePath(); c.fill();
    }
  };
  at(CELLS.glass[0], (c) => shards(c, 70));
  at(CELLS.glass[1], (c) => shards(c, 40));
  at(CELLS.board, (c) => { // contrachapado en vetas, cuatro tablas por celda
    for (let k = 0; k < 4; k++) {
      const y = 256 - (k + 1) * 0.22 * 256 - 0.06 * 256 + 4, h = 0.18 * 256 - 4;
      c.fillStyle = ['#9a7b55', '#8c6f4b', '#a5865e', '#836748'][k]; c.fillRect(0, y, 256, h);
      c.strokeStyle = 'rgba(60,40,20,.35)'; c.lineWidth = 1.5;
      for (let i = 0; i < 7; i++) { c.beginPath(); c.moveTo(0, y + 4 + i * 6); c.bezierCurveTo(80, y + rng() * h, 170, y + rng() * h, 256, y + 4 + i * 6); c.stroke(); }
      c.fillStyle = '#3a3836'; for (const x of [10, 246]) { c.fillRect(x, y + 6, 3, 3); c.fillRect(x, y + h - 9, 3, 3); }
      c.fillStyle = 'rgba(20,14,8,.35)'; c.fillRect(0, y, 256, 3); c.fillRect(0, y + h - 3, 256, 3);
    }
    c.save(); c.globalAlpha = 0.85; c.font = '900 40px Impact, sans-serif'; c.fillStyle = '#e9e5d6'; c.textAlign = 'center';
    c.fillText('KEEP OUT', 128, 120); c.restore();
  });
  at(CELLS.tape, (c) => {
    c.fillStyle = '#e2b62a'; c.fillRect(0, 103, 256, 50);
    c.fillStyle = '#141414'; c.font = '900 22px "Arial Black", sans-serif'; c.textBaseline = 'middle';
    c.fillText('POLICE LINE', 6, 128); c.fillText('DO NOT', 168, 128);
    c.fillRect(0, 105, 256, 3); c.fillRect(0, 148, 256, 3);
  });
  at(CELLS.weed[0], (c) => { for (let i = 0; i < 14; i++) weedBlades(c, 100 + rng() * 56, 254, 120 + rng() * 120, 1); });
  at(CELLS.weed[1], (c) => {
    for (let i = 0; i < 9; i++) weedBlades(c, 90 + rng() * 76, 254, 90 + rng() * 90, 1);
    c.fillStyle = '#6b6a3c'; for (let i = 0; i < 12; i++) { c.beginPath(); c.ellipse(80 + rng() * 96, 120 + rng() * 100, 10, 5, rng() * 3, 0, Math.PI * 2); c.fill(); }
  });
  at(CELLS.sign, (c) => {
    c.fillStyle = '#3c3a36'; c.fillRect(0, 0, 256, 256);
    c.fillStyle = '#7d2f24'; c.fillRect(10, 30, 236, 196);
    c.strokeStyle = '#b39a5c'; c.lineWidth = 6; c.strokeRect(18, 38, 220, 180);
    c.fillStyle = '#d9c99a'; c.font = '900 64px Georgia, serif'; c.textAlign = 'center'; c.fillText('PAWN', 128, 128);
    c.font = '700 22px Georgia, serif'; c.fillText('GOLD · LOANS', 128, 172);
    c.fillStyle = 'rgba(30,20,12,.45)'; for (let i = 0; i < 40; i++) c.fillRect(rng() * 256, 30 + rng() * 196, 4 + rng() * 14, 2 + rng() * 6);
  });
  at(CELLS.arrow, (c) => spray(c, SPRAY[0], 14, (k) => { k.moveTo(28, 150); k.quadraticCurveTo(110, 120, 200, 128); k.moveTo(168, 96); k.lineTo(206, 128); k.lineTo(166, 162); }));
  at(CELLS.tally, (c) => {
    c.strokeStyle = SPRAY[0]; c.lineWidth = 6; c.globalAlpha = 0.85;
    for (let gI = 0; gI < 5; gI++) {
      const x0 = 18 + gI * 46;
      for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(x0 + i * 9, 60); c.lineTo(x0 + i * 9 + (rng() - 0.5) * 4, 120); c.stroke(); }
      c.beginPath(); c.moveTo(x0 - 4, 110); c.lineTo(x0 + 34, 68); c.stroke();
    }
    c.globalAlpha = 1; c.fillStyle = SPRAY[0]; c.font = '900 40px Impact, sans-serif'; c.fillText('DAY 25', 40, 190);
  });
  at(CELLS.skid, (c) => {
    for (const x of [70, 186]) {
      const gr = c.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, 'rgba(8,8,8,0)'); gr.addColorStop(0.2, 'rgba(8,8,8,.5)'); gr.addColorStop(1, 'rgba(8,8,8,.25)');
      c.fillStyle = gr; c.beginPath(); c.moveTo(x - 20, 0); c.quadraticCurveTo(x - 30, 128, x - 10, 256); c.lineTo(x + 26, 256); c.quadraticCurveTo(x - 4, 128, x + 14, 0); c.fill();
    }
  });
  return cv;
}
