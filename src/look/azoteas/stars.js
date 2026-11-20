// Capa de vida "stars" del look de Azoteas (contrato en ../index.js): una
// noche DESPEJADA. Estrellas de magnitudes muy distintas (muchas débiles,
// pocas brillantes, algunas cálidas y otras azuladas), una banda tenue de la
// galaxia (más estrellas, débiles) que cruza en diagonal y un centelleo leve que crece cerca del
// horizonte. Una sola llamada de puntos, a 170 m alrededor de la cámara
// (dentro del plano lejano de 200 m) y detrás de todo: los edificios la
// tapan por profundidad. La bruma baja del horizonte la apaga.
import { shaderMat } from './shared.js';

const RADIUS = 170;

const VERT = /* glsl */`
uniform float uLookTime;
attribute vec4 aStar; // brillo, temperatura (0 azul, 1 cálida), fase, tamaño en px
varying vec3 vCol; varying float vA;
void main() {
  vec3 dir = position; // unitario
  vec3 w = cameraPosition + dir * ${RADIUS.toFixed(1)};
  float low = 1.0 - smoothstep(0.1, 0.6, dir.y);
  float tw = 1.0 + (0.18 + 0.4 * low) * sin(uLookTime * (1.7 + aStar.z * 4.0) + aStar.z * 40.0) * sin(uLookTime * 0.61 + aStar.z * 13.0);
  vA = aStar.x * tw * smoothstep(0.03, 0.26, dir.y);
  vCol = mix(vec3(0.74, 0.84, 1.0), vec3(1.0, 0.86, 0.68), aStar.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  gl_PointSize = aStar.w;
}`;
const FRAG = /* glsl */`
varying vec3 vCol; varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.12, 0.5, r);
  gl_FragColor = vec4(vCol * vA * a, 1.0);
  #include <colorspace_fragment>
}`;

export function build(ctx) {
  const { THREE, group, budget } = ctx;
  const rnd = ctx.rng('stars');
  const k = 0.45 + 0.55 * budget.detail;
  const nStars = Math.round(2400 * k), nBand = Math.round(2600 * k);
  const pos = [], att = [];
  const v = new THREE.Vector3();
  // la banda: un gran círculo inclinado que cruza el cielo
  const bn = new THREE.Vector3(0.42, 0.5, 0.76).normalize();
  const b1 = new THREE.Vector3().crossVectors(bn, new THREE.Vector3(0, 1, 0)).normalize();
  const b2 = new THREE.Vector3().crossVectors(bn, b1).normalize();
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const push = (d, bright, warm, size) => {
    pos.push(d.x, d.y, d.z);
    att.push(bright, warm, rnd(), size);
  };
  for (let i = 0; i < nStars; i++) {
    // dirección uniforme en el hemisferio de arriba
    do { v.set(rnd() * 2 - 1, rnd(), rnd() * 2 - 1); } while (v.lengthSq() > 1 || v.lengthSq() < 0.01 || v.y < 0.03 * v.length());
    v.normalize();
    const m = Math.pow(rnd(), 5.5); // casi todas débiles
    push(v, 0.16 + 1.5 * m, rnd() < 0.25 ? 0.6 + rnd() * 0.4 : rnd() * 0.35, 1.3 + 2.4 * m);
  }
  const onBand = (spread) => {
    const a = rnd() * Math.PI * 2, off = gauss() * spread;
    return v.copy(b1).multiplyScalar(Math.cos(a)).addScaledVector(b2, Math.sin(a)).addScaledVector(bn, off).normalize();
  };
  for (let i = 0; i < nBand; i++) {
    onBand(0.12);
    if (v.y < 0.03) { i--; continue; }
    push(v, 0.1 + 0.3 * Math.pow(rnd(), 3), rnd() * 0.5, 1.2 + rnd() * 0.7);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aStar', new THREE.Float32BufferAttribute(att, 4));
  const mat = shaderMat(THREE, ctx, { vertexShader: VERT, fragmentShader: FRAG, additive: true, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'stars';
  pts.frustumCulled = false;
  pts.renderOrder = -5; // primero entre lo transparente: todo lo demás va encima
  pts.matrixAutoUpdate = false;
  group.add(pts);
  return {};
}
