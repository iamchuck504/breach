// Capa de vida "atmos" del look de Calle (ver el contrato en ../index.js).
// El aire de una ciudad muerta: vapor que sigue saliendo de la alcantarilla,
// ceniza fina que baja de algún incendio, hojas de papel que el viento
// arrastra por el asfalto, y arriba nubes rotas que tiñen los incendios del
// horizonte, más dos columnas de humo (y el humo de bengalas y autos
// quemados, que vienen de sources.js). Cinco llamadas; nada de esto
// detiene una bala ni tapa a nadie.
import { NOISE, patch } from '../glsl.js';

export function build(ctx) {
  if (ctx.theme !== 'calle') return null;
  const { THREE, palette: P } = ctx;
  const detail = ctx.budget?.detail ?? 1;
  const rng = ctx.rng('atmos');
  const T = { uLookTime: ctx.uniforms.uLookTime, uLookWind: ctx.uniforms.uLookWind };
  const parts = ctx.budget.particles;

  // --- aire: UNA nube de partículas para todo lo que flota (una llamada):
  //   0 humo de bengala (nace rojo), 1 columna fina de los autos quemados
  //   (nace por encima de la cabeza de quien se cubra tras el auto: no tapa
  //   el asomarse), 2 vapor de la alcantarilla central, 3 ceniza que baja.
  if (parts > 0) {
    const src = ctx.calle?.sources?.list ?? [];
    const pos = [], seed = [], kind = [], col = [];
    const C = [new THREE.Color(0x8a7f7a), new THREE.Color(0x4a4440), new THREE.Color(P.steam), new THREE.Color(P.ash)];
    const put = (x, y, z, k) => { pos.push(x, y, z); seed.push(rng(), rng(), rng()); kind.push(k); col.push(C[k].r, C[k].g, C[k].b); };
    const per = Math.max(5, Math.round(12 * detail));
    for (const f of src) {
      if (f.kind === 'flare') for (let i = 0; i < per; i++) put(f.pos.x, 0.08, f.pos.z, 0);
      if (f.kind === 'ember') for (let i = 0; i < per * 2; i++) put(f.pos.x + (rng() - 0.5) * 0.5, f.pos.y + 1.0, f.pos.z + (rng() - 0.5) * 0.5, 1);
    }
    for (let i = 0; i < Math.max(8, Math.round(18 * detail)); i++) put((rng() - 0.5) * 0.7, 0.05, (rng() - 0.5) * 0.7, 2);
    for (let i = 0; i < Math.round(parts * 0.16); i++) put((rng() - 0.5) * 34, 0, (rng() - 0.5) * 84, 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 3));
    geo.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      map: new THREE.CanvasTexture(softDot()), vertexColors: true, size: 1, sizeAttenuation: true,
      transparent: true, depthWrite: false, fog: true,
    });
    patch(mat, {
      uniforms: T,
      vertexPars: 'attribute vec3 aSeed; attribute float aKind; uniform float uLookTime; uniform vec3 uLookWind; varying float vLkLife; varying float vLkKind; varying float vLkA; varying float vLkSz;',
      vertex: `{
  vLkKind = aKind;
  if (aKind > 2.5) {
    // ceniza: baja muy despacio y deriva
    float fall = fract(uLookTime * (0.012 + aSeed.x * 0.01) + aSeed.y);
    transformed.y = 10.0 - fall * 10.2;
    float t = uLookTime * (0.5 + aSeed.z * 0.6) + aSeed.y * 30.0;
    transformed.xz += vec2(sin(t), cos(t * 0.7)) * 0.4 + uLookWind.xz * fall * 3.0;
    vLkLife = 0.5; vLkA = 0.6; vLkSz = 0.05;
  } else {
    float tall = aKind > 0.5 && aKind < 1.5 ? 2.6 : 1.0;
    float speed = aKind > 1.5 ? 0.13 + aSeed.x * 0.07 : (0.22 + aSeed.x * 0.1) / tall;
    float drift = aKind > 1.5 ? 1.1 : 1.4 * tall;
    float life = fract(uLookTime * speed + aSeed.y);
    vLkLife = life;
    transformed += vec3(uLookWind.x * life * drift + sin(life * 7.0 + aSeed.z * 9.0) * 0.1 * tall, life * 2.6 * tall, uLookWind.z * life * drift);
    vLkA = aKind > 1.5 ? 0.085 : aKind > 0.5 ? 0.13 : 0.11;
    vLkSz = (aKind > 1.5 ? 1.0 : aKind > 0.5 ? 1.0 : 0.55) * (0.5 + life * 1.8);
  }
}`,
      fragmentPars: 'varying float vLkLife; varying float vLkKind; varying float vLkA;',
      fragment: `{
  float fade = vLkKind > 2.5 ? 1.0 : smoothstep(0.0, 0.12, vLkLife) * (1.0 - smoothstep(0.4, 1.0, vLkLife));
  diffuseColor.a *= vLkA * fade;
  // la bengala tiñe su humo al nacer
  if (vLkKind < 0.5) diffuseColor.rgb = mix(vec3(1.0, 0.35, 0.18), diffuseColor.rgb, smoothstep(0.0, 0.3, vLkLife));
}`,
      key: 'calle-air',
    });
    grow(mat, 'gl_PointSize *= vLkSz;');
    const pts = new THREE.Points(geo, mat);
    pts.name = 'atmos-air';
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    ctx.group.add(pts);
  }

  // --- papeles que el viento arrastra: a saltos por la cuneta y la acera,
  // planos (como mucho 15 cm del suelo), en tramos libres de colliders
  {
    const paths = [];
    for (let k = 0; k < 40 && paths.length < Math.max(2, Math.round(5 * detail)); k++) {
      const s = rng() < 0.5 ? -1 : 1;
      const x = s * (rng() < 0.6 ? 10.6 + rng() * 0.5 : 12.4 + rng() * 2.8), z0 = (rng() - 0.5) * 70;
      const len = 6 + rng() * 5, dir = rng() < 0.5 ? -1 : 1;
      let ok = true;
      for (let i = 0; i <= 6 && ok; i++) if (ctx.blocked(x, z0 + dir * len * i / 6, 0.3)) ok = false;
      if (ok) paths.push([x, z0, dir * len, rng()]);
    }
    if (paths.length) {
      const geo = new THREE.PlaneGeometry(0.26, 0.2);
      geo.rotateX(-Math.PI / 2);
      const path = new Float32Array(paths.length * 4);
      paths.forEach((p, i) => path.set(p, i * 4));
      geo.setAttribute('aPath', new THREE.InstancedBufferAttribute(path, 4));
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48;
      const g = cv.getContext('2d');
      g.fillStyle = '#d4cfbf'; g.fillRect(0, 0, 64, 48);
      g.fillStyle = 'rgba(50,50,50,.5)'; for (let i = 0; i < 6; i++) g.fillRect(8, 8 + i * 6, 30 + (i * 13) % 18, 2);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 });
      patch(mat, {
        uniforms: T,
        vertexPars: 'attribute vec4 aPath; uniform float uLookTime; uniform vec3 uLookWind;',
        vertex: `{
  // avanza a rachas: se para, salta, gira y vuelve a caer
  float u = uLookTime * 0.06 + aPath.w * 7.0;
  float p = fract(u);
  float gust = smoothstep(0.0, 0.25, fract(u * 5.0)) * (1.0 - smoothstep(0.45, 0.7, fract(u * 5.0)));
  float s = p + 0.03 * sin(p * 31.4);
  float hop = gust * 0.12 * abs(sin(uLookTime * 4.0 + aPath.w * 20.0));
  float spin = uLookTime * 0.9 * gust + aPath.w * 6.0 + p * 9.0;
  float tumble = gust * 0.6 * sin(uLookTime * 5.0 + aPath.w * 4.0);
  vec3 q = transformed * (smoothstep(0.0, 0.04, p) * (1.0 - smoothstep(0.96, 1.0, p)));
  q = vec3(q.x, q.y * cos(tumble) - q.z * sin(tumble), q.y * sin(tumble) + q.z * cos(tumble));
  q = vec3(q.x * cos(spin) - q.z * sin(spin), q.y, q.x * sin(spin) + q.z * cos(spin));
  transformed = vec3(aPath.x, 0.045 + hop, aPath.y + aPath.z * s) + q;
}`,
        key: 'calle-paper',
      });
      const mesh = new THREE.InstancedMesh(geo, mat, paths.length);
      mesh.name = 'atmos-paper';
      mesh.frustumCulled = false;
      ctx.group.add(mesh);
    }
  }

  // --- horizonte: la ciudad arde en alguna parte. Un resplandor fuerte al
  // noreste y otro más débil al suroeste (cada mitad del mapa mira uno), que
  // tiñen las nubes bajas y recortan los tejados. Lejos y sin niebla.
  // (a ~110 m: todo el cartel queda dentro del plano lejano de la cámara, 200 m)
  const FIRES = [[52, 100, 1.0], [-50, -100, 0.55]];
  {
    const pos = [], uv = [], col = [];
    for (const [x, z, k] of FIRES) {
      const c = new THREE.Vector3(x, 0, z), right = new THREE.Vector3(-z, 0, x).normalize();
      const W = 130 * (0.6 + 0.4 * k), H = 55 * (0.6 + 0.4 * k);
      const P = (sx, y) => c.clone().addScaledVector(right, sx * W / 2).setY(-6 + y * H);
      const quad = [[P(-1, 0), 0, 0], [P(1, 0), 1, 0], [P(1, 1), 1, 1], [P(-1, 0), 0, 0], [P(1, 1), 1, 1], [P(-1, 1), 0, 1]];
      for (const [p, u, v] of quad) { pos.push(p.x, p.y, p.z); uv.push(u, v); col.push(k, k, k); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({ color: P.fire, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    patch(mat, {
      uniforms: T,
      vertexPars: 'varying vec2 vLkUv;',
      vertex: 'vLkUv = uv;',
      fragmentPars: `uniform float uLookTime; varying vec2 vLkUv; ${NOISE}`,
      fragment: `{
  vec2 q = vLkUv - vec2(0.5, 0.0);
  float glow = exp(-q.x * q.x * 10.0) * exp(-vLkUv.y * 3.0) * (1.0 - smoothstep(0.3, 0.5, abs(q.x))) * (1.0 - smoothstep(0.55, 1.0, vLkUv.y));
  float breathe = 0.8 + 0.2 * lkNoise(vec2(uLookTime * 0.3, vLkUv.x * 4.0));
  diffuseColor.rgb *= glow * breathe * 1.5;
}`,
      key: 'calle-fireglow',
    });
    const glow = new THREE.Mesh(geo, mat);
    glow.name = 'atmos-fire-glow';
    glow.frustumCulled = false;
    glow.renderOrder = 2;
    ctx.group.add(glow);
  }
  // --- nubes rotas a 55 m: la luna las platea por los bordes y los
  // incendios las tiñen por debajo. Un plano que se desvanece antes del
  // plano lejano de la cámara.
  {
    const geo = new THREE.PlaneGeometry(420, 420, 1, 1);
    geo.rotateX(Math.PI / 2); // mira hacia abajo
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    patch(mat, {
      uniforms: { ...T, uLkFires: { value: FIRES.map(([x, z, k]) => new THREE.Vector3(x, z, k)) } },
      vertexPars: 'varying vec3 vLkW;',
      vertex: 'vLkW = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      fragmentPars: `uniform float uLookTime; uniform vec3 uLookWind; uniform vec3 uLkFires[2]; varying vec3 vLkW; ${NOISE}`,
      fragment: `{
  vec2 p = vLkW.xz * 0.011 + uLookWind.xz * uLookTime * 0.004;
  float n = lkFbm(p) * 0.75 + lkFbm(p * 3.1 + 7.0) * 0.25;
  float dens = smoothstep(0.42, 0.68, n);
  vec3 c = vec3(0.075, 0.085, 0.11);                                 // vientre gris azulado
  c += vec3(0.32, 0.36, 0.44) * (1.0 - smoothstep(0.42, 0.56, n)) * 0.55; // borde plateado por la luna
  for (int i = 0; i < 2; i++) {
    vec3 f = uLkFires[i];
    float d = length(vLkW.xz - f.xy);
    c += vec3(0.9, 0.32, 0.09) * f.z * exp(-d / 70.0) * 0.42;          // el incendio las ilumina por debajo
  }
  float far = 1.0 - smoothstep(120.0, 175.0, length(vLkW.xz - cameraPosition.xz));
  diffuseColor = vec4(c, dens * 0.9 * far);
}`,
      key: 'calle-clouds',
    });
    const clouds = new THREE.Mesh(geo, mat);
    clouds.name = 'atmos-clouds';
    clouds.position.y = 55;
    clouds.frustumCulled = false;
    clouds.renderOrder = 1;
    ctx.group.add(clouds);
  }
  {
    // columnas de humo más cerca (a ~100 m), vientre naranja por el fuego;
    // cada una es un cartel vertical que gira hacia la cámara sobre su eje
    const cols = [[40, 86, 1], [-44, -86, 0.6]];
    const pos = [], uv = [], cen = [], fire = [];
    for (const [x, z, f] of cols) {
      const corners = [[-0.5, 0, 0, 0], [0.5, 0, 1, 0], [0.5, 1, 1, 1], [-0.5, 0, 0, 0], [0.5, 1, 1, 1], [-0.5, 1, 0, 1]];
      for (const [cx, cy, u, v] of corners) { pos.push(cx * 30, cy * 95, 0); uv.push(u, v); cen.push(x, -2, z); fire.push(f); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(cen, 3));
    geo.setAttribute('aFire', new THREE.Float32BufferAttribute(fire, 1));
    const mat = new THREE.MeshBasicMaterial({ color: 0x100d0b, transparent: true, depthWrite: false, fog: false });
    patch(mat, {
      uniforms: T,
      vertexPars: 'attribute vec3 aCenter; attribute float aFire; uniform vec3 uLookWind; varying vec2 vLkUv; varying float vLkFire;',
      vertex: `{
  vec3 toCam = vec3(cameraPosition.x - aCenter.x, 0.0, cameraPosition.z - aCenter.z);
  toCam /= max(length(toCam), 1e-3);
  vec3 right = vec3(toCam.z, 0.0, -toCam.x);
  // arriba se la lleva el viento
  float lean = position.y / 95.0;
  transformed = aCenter + right * position.x + vec3(uLookWind.x, 0.0, uLookWind.z) * lean * lean * 40.0 + vec3(0.0, position.y, 0.0);
  vLkUv = uv; vLkFire = aFire;
}`,
      fragmentPars: `uniform float uLookTime; varying vec2 vLkUv; varying float vLkFire; ${NOISE}`,
      fragment: `{
  float y = vLkUv.y;
  float w = mix(0.12, 0.48, pow(y, 0.6));                    // fina abajo, se abre arriba
  vec2 q = vec2((vLkUv.x - 0.5) / w, y * 4.0 - uLookTime * 0.035);
  float n = lkFbm(q * vec2(1.3, 1.0) + vec2(0.0, -uLookTime * 0.02));
  float body = (1.0 - smoothstep(0.1, 1.0, abs(vLkUv.x - 0.5) / w + (n - 0.5) * 0.9)) * smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.6, 1.0, y));
  diffuseColor.a *= body * (0.6 + 0.4 * n) * (1.0 - smoothstep(0.4, 0.85, y));
  // el vientre, encendido por el fuego que la alimenta (más hacia abajo y
  // en los huecos del humo)
  float under = (1.0 - smoothstep(0.0, 0.38, y)) * (0.6 + 0.6 * (1.0 - n));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.26, 0.06), clamp(vLkFire * under, 0.0, 1.0));
}`,
      key: 'calle-smoke-columns',
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'atmos-smoke-columns';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    ctx.group.add(mesh);
  }
  return null;
}

// el tamaño del punto crece con la vida (gl_PointSize ya está escrito)
function grow(mat, code) {
  mat.onBeforeCompile = ((prev) => (shader, r) => {
    prev(shader, r);
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `${code}\n#include <fog_vertex>`);
  })(mat.onBeforeCompile);
}

function softDot() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.5, 'rgba(255,255,255,.45)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return cv;
}
