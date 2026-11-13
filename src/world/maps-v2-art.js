// Arte de las piezas nuevas de los mapas v2. Todo sale de las mismas listas
// que la colisión (plataformas y rampas en collision-layouts.js): lo que se
// dibuja aquí es exactamente lo que detiene al jugador y a las balas.
import * as THREE from 'three';
import { decksFor, rampsFor, RAMP_LANDING } from './collision-layouts.js';
import { CALLE_2_V2 } from './calle-expansion.js';

// Cuña maciza: base w × len, sube de 0 a h a lo largo de +z local y termina
// en un rellano plano (el mismo tramo que usa la física de la rampa).
function wedgeGeometry(w, len, h) {
  const x = w / 2, z = len / 2, k = z - RAMP_LANDING;
  const v = {
    a: [-x, 0, -z], b: [x, 0, -z], c: [x, 0, z], d: [-x, 0, z], e: [-x, h, z], f: [x, h, z],
    g: [-x, h, k], i: [x, h, k],
  };
  const tris = [
    'a', 'g', 'i', 'a', 'i', 'b', // rampa
    'g', 'e', 'f', 'g', 'f', 'i', // rellano
    'd', 'c', 'f', 'd', 'f', 'e', // respaldo
    'a', 'd', 'e', 'a', 'e', 'g', // costado -x
    'b', 'f', 'c', 'b', 'i', 'f', // costado +x
    'a', 'b', 'c', 'a', 'c', 'd', // base
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flatMap((k) => v[k]), 3));
  g.computeVertexNormals();
  return g;
}

// SALIDAS DEL SPAWN: el jugador aparece mirando al escudo que lo protege.
// Flechas pintadas en el suelo le dicen por dónde se sale sin tener que
// girar la cámara para averiguarlo. [x, z, rumbo] en el lado rojo; rumbo 0 =
// hacia el campo (+z), ±90° = hacia un costado. El espejo crea las azules.
const SPAWN_EXITS = {
  fortaleza: [[-8.4, -22.4, 0], [8.4, -22.4, 0], [-11.9, -25.1, -90], [11.9, -25.1, 90]],
  azoteas: [[7.4, -33.2, 0], [-11.6, -37.6, -90], [11.6, -37.6, 90]],
  calle2: [[-7.6, -36.6, 0], [7.6, -36.6, 0]],
};
function arrowTexture() {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 192;
  const g = cv.getContext('2d');
  g.strokeStyle = '#f2d98a'; g.lineWidth = 16; g.lineCap = 'square'; g.lineJoin = 'miter';
  for (const y of [70, 122, 174]) { g.beginPath(); g.moveTo(22, y); g.lineTo(64, y - 46); g.lineTo(106, y); g.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

const LOOKS = {
  // Azoteas: entreplanta técnica de rejilla con canto de seguridad
  mezzanine: { ramp: 0x66727e, edge: 0xd9a441, metalness: 0.45, roughness: 0.6 },
  // Calle: remolque de plataforma con rampas de carga
  trailer: { ramp: 0x3a4248, edge: 0xc5974e, metalness: 0.55, roughness: 0.55 },
};

export function decorateMapV2(world, layout) {
  const root = new THREE.Group();
  root.name = 'maps-v2';
  world.mapGroup.add(root);
  const add = (mesh, name) => { mesh.name = name; mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); return mesh; };
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  const cube = (name, x, y, z, w, h, d, material) => {
    const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material), name);
    m.position.set(x, y, z);
    return m;
  };

  // ---------- flechas de salida del spawn ----------
  const exits = SPAWN_EXITS[layout] ?? [];
  if (exits.length) {
    const paint = new THREE.MeshBasicMaterial({ map: arrowTexture(), transparent: true, opacity: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const [x, z, heading] of exits) for (const side of [1, -1]) {
      const arrow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.65), paint);
      arrow.name = 'v2-spawn-exit';
      arrow.rotation.x = -Math.PI / 2;
      // la punta del dibujo mira a -z con rotación 0: se gira hacia el campo
      arrow.rotation.z = (side > 0 ? Math.PI : 0) - heading * Math.PI / 180;
      arrow.position.set(x * side, 0.022, z * side);
      arrow.renderOrder = 2;
      root.add(arrow);
    }
  }

  // ---------- rampas ----------
  const mats = new Map();
  const lookMat = (kind, key) => {
    const id = kind + key;
    if (!mats.has(id)) {
      const look = LOOKS[kind] ?? LOOKS.mezzanine;
      mats.set(id, std(look[key], { metalness: look.metalness, roughness: look.roughness }));
    }
    return mats.get(id);
  };
  for (const r of rampsFor(layout)) {
    const alongZ = r.axis === 'z';
    const len = alongZ ? r.d : r.w, wide = alongZ ? r.w : r.d;
    const mesh = add(new THREE.Mesh(wedgeGeometry(wide, len, r.h), lookMat(r.kind, 'ramp')), 'v2-ramp');
    mesh.position.set(r.x, 0, r.z);
    // la cuña sube hacia +z local: se gira hacia el eje y sentido de la rampa
    mesh.rotation.y = alongZ ? (r.dir > 0 ? 0 : Math.PI) : (r.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    // cantos de seguridad pintados: marcan el borde sin añadir obstáculo
    const slopeLen = len - RAMP_LANDING;
    const slope = Math.atan2(r.h, slopeLen), run = Math.hypot(slopeLen, r.h);
    for (const s of [-1, 1]) {
      const strip = add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, run), lookMat(r.kind, 'edge')), 'v2-ramp-edge');
      strip.castShadow = false;
      const holder = new THREE.Group();
      holder.position.copy(mesh.position); holder.rotation.y = mesh.rotation.y;
      strip.position.set(s * (wide / 2 - 0.06), r.h / 2 + 0.012, -RAMP_LANDING / 2);
      strip.rotation.x = -slope;
      holder.add(strip); root.add(holder);
    }
  }

  // ---------- Azoteas: entreplantas técnicas ----------
  if (layout === 'azoteas') {
    const grate = std(0x55616c, { metalness: 0.5, roughness: 0.55 });
    const hazard = std(0xd9a441, { roughness: 0.6 });
    const lampOn = new THREE.MeshBasicMaterial({ color: 0x8fe3ff });
    for (const d of decksFor(layout)) for (const side of d.mirror ? [1, -1] : [1]) {
      const x = d.x * side, z = d.z * side;
      // piso de rejilla y franja de seguridad en el perímetro
      cube('v2-deck-floor', x, d.h + 0.012, z, d.w - 0.5, 0.024, d.d - 0.5, grate).castShadow = false;
      for (const s of [-1, 1]) {
        cube('v2-deck-stripe', x, d.h + 0.026, z + s * (d.d / 2 - 0.42), d.w - 0.9, 0.012, 0.12, hazard).castShadow = false;
        cube('v2-deck-stripe', x + s * (d.w / 2 - 0.42), d.h + 0.026, z, 0.12, 0.012, d.d - 0.9, hazard).castShadow = false;
      }
      // pasamanos sobre la baranda maciza y balizas en las esquinas: se
      // reconoce la plataforma de lejos sin tapar a quien está arriba
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        cube('v2-deck-post', x + sx * (d.w / 2 - 0.1), d.h + 0.62, z + sz * (d.d / 2 - 0.1), 0.14, 1.24, 0.14, grate);
        cube('v2-deck-beacon', x + sx * (d.w / 2 - 0.1), d.h + 1.28, z + sz * (d.d / 2 - 0.1), 0.1, 0.08, 0.1, lampOn).castShadow = false;
      }
      // puertas de servicio en el cuerpo: es un cuarto técnico, no un cubo
      for (const sx of [-1, 1]) {
        cube('v2-deck-door', x + sx * (d.w / 2 + 0.012), 0.92, z, 0.03, 1.72, 0.9, std(0x3b4650, { metalness: 0.4 })).castShadow = false;
        cube('v2-deck-louver', x + sx * (d.w / 2 + 0.014), 1.2, z + 1.9, 0.03, 0.7, 1.2, std(0x2c343c, { metalness: 0.5 })).castShadow = false;
      }
    }
  }

  // ---------- Calle Cerrada ----------
  if (layout === 'calle2') {
    const steel = std(0x30383d, { metalness: 0.6, roughness: 0.5 });
    const bed = std(0x5b4a37, { roughness: 0.85 });
    const rubber = std(0x08090a, { roughness: 0.95 });
    const yellow = std(0xc5974e, { roughness: 0.6 });
    const reflector = new THREE.MeshBasicMaterial({ color: 0xff5a3c });
    for (const d of decksFor(layout)) for (const side of d.mirror ? [1, -1] : [1]) {
      const x = d.x * side, z = d.z * side;
      // REMOLQUE: bastidor, tarima de madera, ejes y ruedas bajo la caja
      cube('v2-trailer-frame', x, d.h - 0.2, z, d.w, 0.28, d.d, steel);
      cube('v2-trailer-bed', x, d.h - 0.03, z, d.w - 0.12, 0.06, d.d - 0.08, bed);
      cube('v2-trailer-skirt', x, 0.52, z, d.w - 0.5, 0.74, d.d - 0.6, steel);
      for (const s of [-1, 1]) {
        cube('v2-trailer-rail', x + s * (d.w / 2 - 0.04), d.h - 0.01, z, 0.08, 0.1, d.d, yellow).castShadow = false;
        for (const az of [-1.25, 1.25]) {
          const wheel = add(new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.3, 14), rubber), 'v2-trailer-wheel');
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(x + s * (d.w / 2 - 0.16), 0.46, z + az);
        }
        cube('v2-trailer-reflector', x + s * (d.w / 2 + 0.006), d.h - 0.2, z + 1.9, 0.012, 0.1, 0.5, reflector).castShadow = false;
        cube('v2-trailer-reflector', x + s * (d.w / 2 + 0.006), d.h - 0.2, z - 1.9, 0.012, 0.1, 0.5, reflector).castShadow = false;
      }
    }
    // PANEL PUBLICITARIO de acera: corta la línea de tiro de punta a punta
    const posterCanvas = (title, sub, bg, fg) => {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 384;
      const g = cv.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, 256, 384);
      g.fillStyle = fg; g.globalAlpha = 0.18; for (let i = 0; i < 7; i++) g.fillRect(-40 + i * 46, 0, 20, 384); g.globalAlpha = 1;
      g.font = 'bold 44px sans-serif'; g.textAlign = 'center';
      title.split('\n').forEach((line, i) => g.fillText(line, 128, 150 + i * 50));
      g.font = '20px sans-serif'; g.fillText(sub, 128, 300);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return t;
    };
    const posters = [
      posterCanvas('NIGHT\nLINE', 'METRO · 24 H', '#16323c', '#bfe9f2'),
      posterCanvas('CITY\nRADIO', '98.5 FM', '#3c2030', '#f2c6d6'),
    ];
    for (const p of CALLE_2_V2.adPanels) for (const side of [1, -1]) {
      const x = p.x * side, z = p.z * side;
      cube('v2-ad-frame', x, p.h / 2, z, p.w, p.h, p.d, steel);
      cube('v2-ad-foot', x, 0.08, z, p.w + 0.3, 0.16, p.d + 0.3, steel);
      posters.forEach((tex, i) => {
        const face = add(new THREE.Mesh(new THREE.PlaneGeometry(p.w - 0.3, p.h - 0.9),
          new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.4 })), 'v2-ad-poster');
        face.castShadow = false;
        const s = (i ? -1 : 1) * side;
        face.position.set(x, p.h / 2 + 0.2, z + s * (p.d / 2 + 0.006));
        if (s < 0) face.rotation.y = Math.PI;
      });
    }
  }
  return root;
}
