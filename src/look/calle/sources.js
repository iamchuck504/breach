// FUENTES DE LUZ VIVAS de Calle Cerrada: las barras de las patrullas que
// siguen girando, los destellos ámbar de las barricadas de obra y las
// bengalas tiradas en el asfalto. No son luces de three: cada fuente es una
// posición + un color que la CPU anima una vez por cuadro, y que leen
//   - el lavado de color de superficies (WASH, en los materiales del mapa),
//   - los reflejos del asfalto mojado (surfaces.js),
//   - los halos (cordon.js).
// Todo sale de los DATOS del mapa (las patrullas y las barricadas que haya),
// así un clon del editor recibe las suyas o ninguna.
import * as THREE from 'three';

export const MAX_SOURCES = 18;

// Patrones: el de la patrulla es un doble destello rojo y luego azul (como
// una barra LED real), con un resto encendido muy bajo para que la barra se
// lea viva. El ámbar alterna izquierda/derecha. La bengala arde irregular.
const pulse = (u, a, b) => {
  const k = 0.012;
  return Math.min(1, Math.max(0, (u - a) / k)) * Math.min(1, Math.max(0, (b - u) / k));
};
function intensity(kind, t, phase) {
  if (kind === 'red' || kind === 'blue') {
    const u = ((t + phase) / 1.2) % 1;
    const o = kind === 'red' ? 0 : 0.5;
    return 0.1 + 0.9 * Math.max(pulse(u, o, o + 0.16), pulse(u, o + 0.24, o + 0.42));
  }
  if (kind === 'amber') {
    const u = ((t + phase) / 1.1) % 1;
    return 0.04 + 0.96 * pulse(u, 0.02, 0.4);
  }
  if (kind === 'beacon') {
    // rotativo de grúa: el espejo pasa por delante dos veces por vuelta
    const c = Math.cos(((t + phase) / 0.85) * Math.PI * 2);
    return 0.06 + 0.94 * Math.pow(Math.max(0, c), 6);
  }
  if (kind === 'ember') {
    // brasas: respiran despacio, con algún avivón
    const s = t + phase * 10;
    return 0.55 + 0.25 * Math.sin(s * 1.7) * Math.sin(s * 0.63) + 0.2 * Math.max(0, Math.sin(s * 5.1) * Math.sin(s * 2.3));
  }
  // bengala: llama nerviosa, nunca se apaga
  const s = t * 1.0 + phase * 10;
  return 0.78 + 0.13 * Math.sin(s * 23.0) * Math.sin(s * 7.3) + 0.09 * Math.sin(s * 41.0 + 1.7);
}

// Color de la fuente y cuánto lava alrededor (radio y ganancia moderados:
// tiñe el asfalto, las fachadas de enfrente y los autos de alrededor).
const LOOK = {
  red: { color: 0xff2a1a, radius: 13.0, gain: 4.2 },
  blue: { color: 0x2a5cff, radius: 13.0, gain: 5.4 },
  amber: { color: 0xffa22e, radius: 5.5, gain: 3.0 },
  beacon: { color: 0xff9a1e, radius: 7.5, gain: 3.2 },
  ember: { color: 0xff5a1a, radius: 3.6, gain: 2.4 },
  flare: { color: 0xff4a1c, radius: 3.6, gain: 3.2 },
};

// Busca en el mapa ya construido lo que emite. Determinista: el orden es el
// de mapGroup, que es el orden de construcción.
export function findSources(world, rng) {
  const out = [];
  const box = new THREE.Box3(), v = new THREE.Vector3();
  const add = (kind, pos, phase, extra = {}) => {
    if (out.length >= MAX_SOURCES) return;
    const L = LOOK[kind];
    out.push({ kind, pos: pos.clone(), phase, color: new THREE.Color(L.color), radius: L.radius, gain: L.gain, ...extra });
  };
  const cars = [], works = [], trucks = [], burnt = [];
  for (const o of world.mapGroup.children) {
    if (o.userData?.police) cars.push(o);
    else if (o.userData?.blenderProp === 'roadwork' || o.userData?.decorKind === 'roadwork') works.push(o);
    else if (o.userData?.callePolish === 'truck') trucks.push(o);
    else if (o.userData?.callePolish === 'sedan' && isBurnt(o)) burnt.push(o);
  }
  cars.forEach((car, i) => {
    car.updateWorldMatrix(true, true);
    box.setFromObject(car);
    const top = box.max.y - car.position.y;
    const ph = i * 0.37;
    // mitades de la barra: roja a la izquierda, azul a la derecha (ver world.js)
    add('red', car.localToWorld(v.set(-0.34, top + 0.06, 0.12)), ph, { car: i, side: -1 });
    add('blue', car.localToWorld(v.set(0.34, top + 0.06, 0.12)), ph, { car: i, side: 1 });
  });
  works.forEach((w, i) => {
    w.updateWorldMatrix(true, true);
    box.setFromObject(w);
    const top = box.max.y - w.position.y;
    // los dos pilotos ámbar de las esquinas de arriba, alternados
    for (const sx of [-1, 1]) add('amber', w.localToWorld(v.set(sx * 1.3, top + 0.02, 0)), (sx > 0 ? 0.55 : 0) + i * 0.21);
  });
  // los camiones de servicio dejaron el rotativo ámbar girando (uno por
  // mitad del mapa)
  trucks.forEach((tr, i) => {
    tr.updateWorldMatrix(true, true);
    for (const sx of [-1, 1]) add('beacon', tr.localToWorld(v.set(sx * 0.42, 2.66, -2.05)), (sx > 0 ? 0.42 : 0) + i * 0.3);
  });
  // brasas en el vano del motor de los autos quemados
  burnt.forEach((b, i) => add('ember', b.localToWorld(v.set(0, 0.98, -1.35)), i * 0.7));
  // bengalas: tiradas en el asfalto alrededor de cada patrulla, en el lado de
  // la calzada, nunca dentro de un collider
  const spots = [[-1.75, -3.3], [1.6, 3.4]];
  cars.forEach((car) => {
    for (const [lx, lz] of spots) {
      const p = car.localToWorld(v.set(lx + (rng() - 0.5) * 0.4, 0.04, lz + (rng() - 0.5) * 0.4));
      p.y = 0.04;
      let free = true;
      for (const c of world.colliders) if (p.x > c.minx - 0.25 && p.x < c.maxx + 0.25 && p.z > c.minz - 0.25 && p.z < c.maxz + 0.25) { free = false; break; }
      if (free) add('flare', p, rng() * 10, { yaw: rng() * Math.PI });
    }
  });
  return out;
}

// Sedán quemado: la pareja de color teja (surfaces.js la carboniza).
export function isBurnt(o) {
  let hit = false;
  o.traverse((m) => {
    const mt = m.material;
    if (mt && !Array.isArray(mt) && mt.map && mt.bumpMap && Math.abs(mt.color.getHex() - 0x815e4f) < 0x030303) hit = true;
  });
  return hit;
}

// Estado animado: arrays que se comparten como uniforms (mismas referencias
// para todos los materiales) y un update() sin asignaciones.
export function sourceState(list) {
  const n = Math.max(1, list.length);
  const state = {
    list,
    I: new Float32Array(n),                                       // 0..1 por fuente (halos)
    P: Array.from({ length: n }, (_, i) => {
      const s = list[i];
      return s ? new THREE.Vector4(s.pos.x, s.pos.y, s.pos.z, s.radius) : new THREE.Vector4(0, -100, 0, 0.01);
    }),
    C: Array.from({ length: n }, () => new THREE.Color(0, 0, 0)),  // color × intensidad × ganancia
    bar: new Float32Array(4),                                     // [rojo A, azul A, rojo B, azul B] para las lentes
    update(t) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i], k = intensity(s.kind, t, s.phase);
        state.I[i] = k;
        state.C[i].copy(s.color).multiplyScalar(k * s.gain);
        if (s.car != null && s.car < 2) state.bar[s.car * 2 + (s.side > 0 ? 1 : 0)] = k;
      }
    },
  };
  state.update(0);
  return state;
}

// Lavado de color de las fuentes sobre una superficie iluminada (Standard o
// Lambert): suma al emisivo el albedo por el color de cada fuente, con caída
// suave y un poco de orientación hacia la fuente (para que barra las caras).
export const WASH_VERT = /* glsl */`
{
  vec4 lkSW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  lkSW = instanceMatrix * lkSW;
  #endif
  vLkSW = (modelMatrix * lkSW).xyz;
}`;
export const washFrag = (N) => /* glsl */`
{
  vec3 lkN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 lkWash = vec3(0.0);
  for (int i = 0; i < ${N}; i++) {
    vec4 s = uLkSrcP[i];
    vec3 L = s.xyz - vLkSW;
    float d2 = dot(L, L);
    float f = max(1.0 - d2 / (s.w * s.w), 0.0);
    lkWash += uLkSrcC[i] * (f * f) * (0.3 + 0.7 * max(dot(lkN, L * inversesqrt(d2 + 1e-3)), 0.0));
  }
  totalEmissiveRadiance += diffuseColor.rgb * lkWash;
}`;
export const washPars = (N) => `varying vec3 vLkSW; uniform vec4 uLkSrcP[${N}]; uniform vec3 uLkSrcC[${N}];`;
