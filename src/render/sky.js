// CIELO. El fondo clásico es un degradado pegado a la pantalla: no gira con
// la cámara ni ilumina nada. Con la cadena de imagen activa lo sustituye una
// cúpula que se evalúa por dirección de vista (mismo degradado del tema, de
// cenit a horizonte), con disco y halo del sol o la luna en la dirección real
// de la luz, y estrellas de noche. De esa misma cúpula sale el mapa de
// entorno: los materiales reciben luz y reflejo del cielo que se ve.
//
// En Clásico no se toca nada: queda el degradado de siempre.
import * as THREE from 'three';

const MAX_STOPS = 5;
const ENV_INTENSITY = 0.35;

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // siempre al fondo
}`;
const FRAG = /* glsl */`
uniform vec3 uStops[${MAX_STOPS}]; uniform float uAt[${MAX_STOPS}];
uniform vec3 uGround, uSunDir, uSunColor;
uniform float uSunDisc, uSunSize, uGlow, uStars;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  // cenit = primer color, horizonte = último
  float t = 1.0 - pow(clamp(d.y, 0.0, 1.0), 0.6);
  vec3 c = uStops[0];
  for (int i = 1; i < ${MAX_STOPS}; i++) c = mix(c, uStops[i], smoothstep(uAt[i - 1], uAt[i] + 1e-4, t));
  // bajo el horizonte: el color de la niebla, para empalmar con lo lejano
  c = mix(c, uGround, smoothstep(0.02, -0.10, d.y));
  float sd = max(dot(d, uSunDir), 0.0);
  float above = smoothstep(-0.04, 0.03, d.y);
  c += uSunColor * (pow(sd, 120.0) * 0.30 + pow(sd, 14.0) * 0.05) * uGlow * above;
  // disco por distancia angular (el coseno pierde precisión tan cerca de 1)
  float ang = length(cross(d, uSunDir));
  c += mix(uSunColor, vec3(1.0), 0.5) * smoothstep(uSunSize, uSunSize * 0.82, ang) * step(0.0, dot(d, uSunDir)) * uSunDisc * above;
  if (uStars > 0.0) {
    vec3 g = d * 190.0, cell = floor(g);
    float h = hash(cell);
    float star = step(0.9965, h) * smoothstep(0.42, 0.05, length(fract(g) - 0.5));
    c += vec3(0.85, 0.92, 1.0) * star * uStars * (0.4 + 0.6 * fract(h * 91.7)) * smoothstep(0.03, 0.30, d.y);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export class SkyEnvironment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.key = '';
    this.envRT = null;
    this.pmrem = null;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide,
      depthWrite: false, depthTest: true, fog: false, toneMapped: false,
      uniforms: {
        uStops: { value: Array.from({ length: MAX_STOPS }, () => new THREE.Color()) },
        uAt: { value: new Array(MAX_STOPS).fill(1) },
        uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uSunDisc: { value: 0 }, uSunSize: { value: 0.02 }, uGlow: { value: 1 }, uStars: { value: 0 },
      },
    });
    const geo = new THREE.SphereGeometry(1, 32, 16);
    this.dome = new THREE.Mesh(geo, this.material);
    this.dome.name = 'sky-dome';
    this.dome.scale.setScalar(150);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000; // al final de los opacos: solo pinta lo que quedó libre
    this.dome.matrixAutoUpdate = true;
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(geo, this.material);
    this.envDome.scale.setScalar(50);
    this.envScene.add(this.envDome);
  }

  // Una vez por cuadro, antes de dibujar. Reconstruye solo si cambió el cielo
  // del mapa o si la cadena se activó o desactivó.
  update(world, camera, active) {
    const key = `${active ? 1 : 0}:${world.skyVersion ?? 0}`;
    if (key !== this.key) {
      this.key = key;
      if (active && world.skyStops) this._enable(world);
      else this._disable(world);
    }
    if (this.dome.parent) this.dome.position.copy(camera.position);
  }

  _enable(world) {
    const u = this.material.uniforms;
    const stops = world.skyStops.slice(0, MAX_STOPS);
    for (let i = 0; i < MAX_STOPS; i++) {
      const [at, color] = stops[Math.min(i, stops.length - 1)];
      u.uStops.value[i].set(color);
      u.uAt.value[i] = i < stops.length ? at : 1;
    }
    const top = u.uStops.value[0];
    const night = (top.r * 0.2126 + top.g * 0.7152 + top.b * 0.0722) < 0.03;
    const fog = this.scene.fog;
    u.uGround.value.copy(fog ? fog.color : u.uStops.value[MAX_STOPS - 1]);
    // Fortaleza y Azoteas ya traen su sol o su luna como objeto del mapa: el
    // halo va ahí y la cúpula no dibuja un segundo disco. Sin ese objeto, el
    // disco sale en la dirección real de la luz.
    const body = world.mapGroup?.getObjectByName('sky-body') ?? null;
    this._restoreBody();
    if (body) {
      u.uSunDir.value.copy(body.position).normalize();
      // en HDR el astro brilla por encima de blanco y el bloom le da halo
      this.body = body;
      this.bodyColor = body.material.color.clone();
      body.material.color.multiplyScalar(night ? 1.8 : 3.2);
    } else u.uSunDir.value.copy(world.sun.position).normalize();
    u.uSunColor.value.copy(world.sun.color);
    u.uSunSize.value = night ? 0.016 : 0.022;
    u.uGlow.value = night ? 0.35 : 1.0;
    u.uStars.value = night ? 1.6 : 0;

    // entorno: sin el disco (un punto tan brillante da chispas en el reflejo)
    u.uSunDisc.value = 0;
    try {
      this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
      const prev = this.envRT;
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
      prev?.dispose();
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = ENV_INTENSITY;
    } catch (err) {
      console.warn('[render] entorno de cielo no disponible:', err);
      this.scene.environment = null;
    }
    u.uSunDisc.value = body ? 0 : night ? 2.2 : 7.0;
    this.scene.background = null;
    this.scene.add(this.dome);
  }

  _restoreBody() {
    if (this.body) this.body.material.color.copy(this.bodyColor);
    this.body = null;
  }

  _disable(world) {
    this._restoreBody();
    this.scene.remove(this.dome);
    this.scene.environment = null;
    this.scene.environmentIntensity = 1;
    if (world._skyTex) this.scene.background = world._skyTex;
    this.envRT?.dispose(); this.envRT = null;
  }
}
