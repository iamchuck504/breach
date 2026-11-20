// LETREROS DE LA CIUDAD: solo cuatro, de los que de verdad existen a esa
// altura, cada uno sobre un edificio de la cuadrícula (./city-plan.js) y
// mirando a una calle o avenida. Lo leen dos partes del look:
//   · ./signs.js los dibuja (tubos, cajas, bastidores, reflectores)
//   · ./surfaces.js pinta su luz, que solo alcanza como un brillo tenue el
//     pretil y la albardilla de enfrente (sin luces dinámicas)
// Nombres inventados.
import { planCity } from './city-plan.js';

export const MAX_SPILL = 4;

// Geometría de cada letrero, derivada del edificio que lo sostiene.
export function signSpots() {
  const { hosts: H } = planCity();
  const mid = (a, b) => (a + b) / 2;
  const out = {};
  if (H.velarde) { // letras de neón sobre bastidor, en la azotea, mirando a la avenida este
    const b = H.velarde, w = Math.min(b.z1 - b.z0 - 2, 11);
    out.velarde = { x: b.x0 + 1.2, y: b.top + 1.7, z: mid(b.z0, b.z1), w, h: 2.6, roof: b.top - 0.9 };
  }
  if (H.billboard) { // valla en bastidor sobre la azotea, mirando a la calle sur
    const b = H.billboard;
    out.billboard = { x: mid(b.x0, b.x1), y: b.top + 3.2, z: b.z1 - 1.6, w: 10, h: 4, roof: b.top - 0.9 };
  }
  if (H.hotel) { // bandera vertical en la fachada alta, sobre la calle norte
    const b = H.hotel;
    out.hotel = { x: b.x1 - 1.4, y: b.top - 8.5, z: b.z0 - 1.05, w: 1.4, h: 9.5, face: b.z0 };
  }
  if (H.meridiano) { // rótulo de oficinas en el remate, mirando a la avenida oeste
    const b = H.meridiano;
    out.meridiano = { x: b.x1 + 0.04, y: b.top - 1.7, z: mid(b.z0, b.z1), w: 12, h: 1.3 };
  }
  return out;
}

// Fuentes de luz: p = centro emisor, f = hacia dónde mira (0 = a ambos lados
// de una bandera), r = alcance (m), k = intensidad. El alcance es corto: lo
// que está al otro lado de la avenida apenas recibe un reflejo.
const S0 = signSpots();
export const SPILL = [
  S0.velarde && { id: 'velarde', p: [S0.velarde.x - 0.5, S0.velarde.y, S0.velarde.z], f: [-1, 0, 0], r: 8, k: 2.6, color: 'amber', flick: 'steady' },
  S0.billboard && { id: 'billboard', p: [S0.billboard.x, S0.billboard.y, S0.billboard.z + 0.6], f: [0, 0, 1], r: 8, k: 1.4, color: 'box', flick: 'steady' },
  S0.hotel && { id: 'hotel', p: [S0.hotel.x, S0.hotel.y, S0.hotel.z], f: [0, 0, 0], r: 7, k: 2.0, color: 'warm', flick: 'buzz' },
  S0.meridiano && { id: 'meridiano', p: [S0.meridiano.x + 0.5, S0.meridiano.y, S0.meridiano.z], f: [1, 0, 0], r: 6, k: 1.2, color: 'white', flick: 'steady' },
].filter(Boolean);

// color lineal de la luz que derrama cada letrero
export function spillColor(THREE, P, name) {
  return new THREE.Color(P.neon[name]);
}

// Uniformes compartidos (MISMA referencia en todos los materiales). k lleva
// el parpadeo: lo escribe update() de las superficies y lo leen también los
// tubos de ./signs.js, así letrero y reflejo se apagan juntos.
export function spillUniforms(THREE, P, on) {
  const pos = [], col = [], dir = [], k = new Array(MAX_SPILL).fill(on ? 1 : 0);
  for (let i = 0; i < MAX_SPILL; i++) {
    const s = SPILL[i];
    pos.push(s ? new THREE.Vector4(s.p[0], s.p[1], s.p[2], s.r) : new THREE.Vector4(0, -500, 0, 1));
    col.push(s ? spillColor(THREE, P, s.color).multiplyScalar(s.k) : new THREE.Color(0, 0, 0));
    dir.push(s ? new THREE.Vector3(...s.f) : new THREE.Vector3());
  }
  return {
    uLkSpillP: { value: pos }, uLkSpillC: { value: col }, uLkSpillF: { value: dir },
    uLkSpillK: { value: k },
    // tramo de un letrero que falla (sin uso hoy: ninguno tiene letra rota)
    uLkSignPart: { value: 1 },
  };
}

// La suma en GLSL. P y N en mundo. Atenuación suave que se corta del todo
// a cuatro alcances, luz envolvente (wrap: las caras de lado también
// se tiñen) y solo hacia el semiespacio al que mira el letrero.
export const SPILL_GLSL = /* glsl */`
uniform vec4 uLkSpillP[${MAX_SPILL}];
uniform vec3 uLkSpillC[${MAX_SPILL}];
uniform vec3 uLkSpillF[${MAX_SPILL}];
uniform float uLkSpillK[${MAX_SPILL}];
vec3 lkSpill(vec3 P, vec3 N, float wrap) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < ${MAX_SPILL}; i++) {
    vec3 d = uLkSpillP[i].xyz - P;
    float r2 = max(dot(d, d), 1e-3);
    float R = uLkSpillP[i].w;
    vec3 L = d * inversesqrt(r2);
    float ndl = clamp((dot(N, L) + wrap) / (1.0 + wrap), 0.0, 1.0);
    float att = R * R / (R * R + r2);
    att *= 1.0 - smoothstep(R * 2.5, R * 4.0, sqrt(r2));
    vec3 F = uLkSpillF[i];
    float front = dot(F, F) > 0.5 ? smoothstep(-0.05, 0.25, -dot(L, F)) : 1.0;
    s += uLkSpillC[i] * (uLkSpillK[i] * att * sqrt(att) * ndl * front);
  }
  return s;
}
`;

// PARPADEO (en JS: el mismo valor va al tubo y a su reflejo). Sin memoria
// nueva por cuadro.
const fract = (x) => x - Math.floor(x);
const h1 = (n) => fract(Math.sin(n * 12.9898) * 43758.5453);
export function flicker(mode, t, seed) {
  if (mode === 'breathe') return 0.82 + 0.18 * Math.sin(t * 1.3 + seed); // cruz de farmacia: respira
  if (mode === 'buzz') {
    // casi siempre estable; cada tanto un tartamudeo de un segundo
    const ep = Math.floor(t / 8.5), local = t - ep * 8.5;
    if (h1(ep + seed * 7.1) > 0.5 || local > 1.1) return 1;
    return h1(Math.floor(t * 19) + seed) > 0.42 ? 1 : 0.12;
  }
  return 1;
}
// una letra que muere: largos tramos rota, a ratos se recupera
export function dyingPart(t, seed) {
  const ep = Math.floor(t / 4.2);
  if (h1(ep + seed * 3.3) < 0.28) return 1;
  const fast = h1(Math.floor(t * 13) + seed);
  return fast > 0.62 ? 0.95 : fast > 0.5 ? 0.35 : 0.04;
}
