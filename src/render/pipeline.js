// CADENA DE IMAGEN. La escena se dibuja a un buffer HDR (media precisión,
// MSAA) y un único pase final la lleva a pantalla: bloom, exposición, curva
// de tono, gradación por mapa, viñeta y dither. Sin ella el juego recortaba
// todo lo que pasara de blanco y no tenía ningún control de "look".
//
// La curva es la Khronos PBR Neutral: deja intactos los tonos medios (la
// iluminación del juego se afinó sin tone mapping) y solo enrolla las altas
// luces. El carácter de cada mapa sale de la gradación, no de la curva.
//
// Niveles de calidad: cada uno fija MSAA, bloom y un TOPE DE PÍXELES; si la
// ventana lo supera, baja la resolución interna en vez de los cuadros.
// 'off' = render directo clásico (también el respaldo si algo falla).
import * as THREE from 'three';

export const QUALITY = Object.freeze({
  off:    { post: false, msaa: 0, bloom: 0, budget: Infinity },
  low:    { post: true,  msaa: 2, bloom: 0, budget: 1.0e6 },
  medium: { post: true,  msaa: 2, bloom: 4, budget: 1.6e6 },
  high:   { post: true,  msaa: 4, bloom: 5, budget: 2.6e6 },
  ultra:  { post: true,  msaa: 4, bloom: 5, budget: Infinity },
});

// Gradación por ambiente. tint* multiplican en espacio de pantalla: sombras
// hacia un lado, luces hacia el otro (split tone). Valores contenidos a
// propósito: en un competitivo la silueta del enemigo manda.
const N = [1, 1, 1];
export const GRADES = Object.freeze({
  default:   { exposure: 1.00, bloom: 0.35, threshold: 1.00, shadows: [0.97, 1.00, 1.04], highs: [1.03, 1.00, 0.97], contrast: 0.14, pivot: 0.40, saturation: 1.06, vignette: 0.16 },
  fortaleza: { exposure: 1.04, bloom: 0.40, threshold: 1.00, shadows: [0.95, 1.00, 1.07], highs: [1.05, 1.01, 0.94], contrast: 0.16, pivot: 0.36, saturation: 1.10, vignette: 0.18 },
  azoteas:   { exposure: 1.10, bloom: 0.80, threshold: 0.55, shadows: [0.95, 0.99, 1.08], highs: [1.05, 1.00, 0.96], contrast: 0.16, pivot: 0.20, saturation: 1.12, vignette: 0.20 },
  calle:     { exposure: 1.10, bloom: 0.80, threshold: 0.55, shadows: [0.94, 1.00, 1.07], highs: [1.07, 1.01, 0.93], contrast: 0.16, pivot: 0.22, saturation: 1.08, vignette: 0.20 },
  metro:     { exposure: 1.06, bloom: 0.60, threshold: 0.65, shadows: [0.96, 1.02, 1.00], highs: [1.02, 1.02, 0.97], contrast: 0.15, pivot: 0.24, saturation: 1.02, vignette: 0.22 },
  prision:   { exposure: 1.00, bloom: 0.30, threshold: 1.00, shadows: [0.97, 1.00, 1.04], highs: N, contrast: 0.16, pivot: 0.42, saturation: 0.96, vignette: 0.16 },
  pueblo:    { exposure: 1.02, bloom: 0.35, threshold: 1.00, shadows: [0.96, 1.00, 1.05], highs: [1.05, 1.01, 0.94], contrast: 0.14, pivot: 0.40, saturation: 1.06, vignette: 0.16 },
});

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Primer descenso del bloom: umbral con rodilla suave + promedio de Karis
// (pesa menos los texeles muy brillantes) para que un destello no parpadee.
const PREFILTER = /* glsl */`
uniform sampler2D tMap; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec3 sum = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -1.0 : 1.0, i < 2 ? -1.0 : 1.0) * uTexel;
    vec3 c = min(texture2D(tMap, vUv + o).rgb, vec3(24.0));
    float w = 1.0 / (1.0 + luma(c));
    sum += c * w; wsum += w;
  }
  vec3 c = sum / wsum;
  float l = luma(c), knee = uThreshold * 0.5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  gl_FragColor = vec4(c * max(soft, l - uThreshold) / max(l, 1e-4), 1.0);
}`;
const DOWN = /* glsl */`
uniform sampler2D tMap; uniform vec2 uTexel; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb * 4.0;
  c += texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tMap, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture2D(tMap, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture2D(tMap, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;
// Ascenso: carpa 3x3 del nivel inferior + el nivel propio.
const UP = /* glsl */`
uniform sampler2D tMap; uniform sampler2D tAdd; uniform vec2 uTexel; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tMap, vUv).rgb * 4.0;
  c += (texture2D(tMap, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(1.0, 0.0)).rgb
      + texture2D(tMap, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(0.0, 1.0)).rgb) * 2.0;
  c += texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb
     + texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 16.0 + texture2D(tAdd, vUv).rgb, 1.0);
}`;
const FINAL = /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform float uPivot, uBloom, uBloomScale, uExposure, uContrast, uSaturation, uVignette, uAspect;
uniform vec3 uShadows, uHighs;
varying vec2 vUv;
vec3 neutral(vec3 c) {
  const float start = 0.76, desat = 0.15;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(c, vec3(newPeak), g);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  // el bloom ya viene sin lo que queda bajo el umbral: solo suma destello
  if (uBloom > 0.0) c = mix(c, c + texture2D(tBloom, vUv).rgb * uBloomScale, uBloom);
  c = neutral(max(c, 0.0) * uExposure);
  // a espacio de pantalla (sRGB): la gradación se juzga como se ve
  c = clamp(c, 0.0, 1.0);
  c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(uShadows, uHighs, smoothstep(0.08, 0.78, l));
  // contraste con pivote propio del mapa: una S centrada en 0.5 hundiria
  // los mapas nocturnos, que viven casi enteros por debajo
  vec3 lo = uPivot * pow(c / uPivot, vec3(1.0 + uContrast));
  vec3 hi = 1.0 - (1.0 - uPivot) * pow((1.0 - c) / (1.0 - uPivot), vec3(1.0 + uContrast));
  c = mix(lo, hi, step(uPivot, c));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  vec2 q = (vUv - 0.5) * vec2(min(uAspect, 1.9), 1.0);
  c *= 1.0 - uVignette * smoothstep(0.42, 1.12, length(q) * 1.25);
  // dither: sin él los degradados del cielo forman bandas en 8 bits
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

export class ImagePipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.quality = QUALITY.off;
    this.qualityName = 'off';
    this.failed = false;
    this.size = new THREE.Vector2();
    this.sceneRT = null;
    this.down = []; this.up = [];
    this.cam = new THREE.Camera();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(tri, null);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    const mat = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const tex = () => ({ value: null }), texel = () => ({ value: new THREE.Vector2() });
    this.mPre = mat(PREFILTER, { tMap: tex(), uTexel: texel(), uThreshold: { value: 1 } });
    this.mDown = mat(DOWN, { tMap: tex(), uTexel: texel() });
    this.mUp = mat(UP, { tMap: tex(), tAdd: tex(), uTexel: texel() });
    this.mFinal = mat(FINAL, {
      tScene: tex(), tBloom: tex(), uBloom: { value: 0 }, uBloomScale: { value: 1 }, uPivot: { value: 0.4 }, uExposure: { value: 1 }, uContrast: { value: 0 },
      uSaturation: { value: 1 }, uVignette: { value: 0 }, uAspect: { value: 1 },
      uShadows: { value: new THREE.Vector3(1, 1, 1) }, uHighs: { value: new THREE.Vector3(1, 1, 1) },
    });
  }

  get active() { return this.quality.post && !this.failed; }

  setQuality(name) {
    this.qualityName = QUALITY[name] ? name : 'off';
    this.quality = QUALITY[this.qualityName];
    // Un buffer flotante que la GPU no puede dibujar no lanza error: deja la
    // pantalla en negro. Se comprueba antes de usarlo.
    const r = this.renderer;
    this.failed = !(r.capabilities.isWebGL2 !== false && r.extensions.has('EXT_color_buffer_float'));
    this._dispose();
  }

  // Sin GPU real (render por software) la cadena cuesta más de lo que aporta.
  static softwareRenderer(renderer) {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch { return false; }
  }

  // Relación de píxeles efectiva: la pedida, recortada al tope del nivel.
  pixelRatio(base, cssW, cssH) {
    const px = cssW * cssH * base * base;
    return px > this.quality.budget ? base * Math.sqrt(this.quality.budget / px) : base;
  }

  _dispose() {
    this.sceneRT?.dispose(); this.sceneRT = null;
    for (const rt of [...this.down, ...this.up]) rt.dispose();
    this.down = []; this.up = [];
  }

  _ensure() {
    const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.sceneRT && s.equals(this.size)) return;
    this._dispose();
    this.size.copy(s);
    const q = this.quality;
    this.sceneRT = new THREE.WebGLRenderTarget(s.x, s.y, {
      type: THREE.HalfFloatType, samples: q.msaa, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    let w = s.x, h = s.y;
    for (let i = 0; i < q.bloom; i++) {
      w = Math.max(2, w >> 1); h = Math.max(2, h >> 1);
      const make = () => new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      this.down.push(make());
      if (i < q.bloom - 1) this.up.push(make());
    }
  }

  // Destino contra el que hay que precompilar los materiales de la escena.
  compileTarget() {
    if (!this.active) return null;
    this._ensure();
    return this.sceneRT;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.cam);
  }

  render(scene, camera, gradeName) {
    const r = this.renderer;
    if (!this.active) { r.setRenderTarget(null); r.render(scene, camera); return; }
    try {
      this._ensure();
      const g = GRADES[gradeName] || GRADES.default;
      r.setRenderTarget(this.sceneRT);
      r.render(scene, camera);

      const n = this.down.length;
      if (n) {
        const texel = (u, rt) => u.value.set(1 / rt.width, 1 / rt.height);
        this.mPre.uniforms.tMap.value = this.sceneRT.texture;
        texel(this.mPre.uniforms.uTexel, this.sceneRT);
        this.mPre.uniforms.uThreshold.value = g.threshold;
        this._pass(this.mPre, this.down[0]);
        for (let i = 1; i < n; i++) {
          this.mDown.uniforms.tMap.value = this.down[i - 1].texture;
          texel(this.mDown.uniforms.uTexel, this.down[i - 1]);
          this._pass(this.mDown, this.down[i]);
        }
        let src = this.down[n - 1];
        for (let i = n - 2; i >= 0; i--) {
          this.mUp.uniforms.tMap.value = src.texture;
          this.mUp.uniforms.tAdd.value = this.down[i].texture;
          texel(this.mUp.uniforms.uTexel, src);
          this._pass(this.mUp, this.up[i]);
          src = this.up[i];
        }
        this.mFinal.uniforms.tBloom.value = src.texture;
      }
      const u = this.mFinal.uniforms;
      u.tScene.value = this.sceneRT.texture;
      // la suma de niveles crece con su número: se normaliza para que el
      // mismo valor de gradación dé el mismo bloom en cualquier calidad
      u.uBloom.value = n ? g.bloom : 0;
      u.uBloomScale.value = 1 / Math.max(1, n);
      u.uExposure.value = g.exposure;
      u.uContrast.value = g.contrast;
      u.uPivot.value = g.pivot;
      u.uSaturation.value = g.saturation;
      u.uVignette.value = g.vignette;
      u.uAspect.value = this.size.x / Math.max(1, this.size.y);
      u.uShadows.value.fromArray(g.shadows);
      u.uHighs.value.fromArray(g.highs);
      this._pass(this.mFinal, null);
    } catch (err) {
      // Nunca dejar al jugador sin imagen: se vuelve al render directo.
      console.warn('[render] cadena de imagen desactivada:', err);
      this.failed = true;
      this._dispose();
      r.setRenderTarget(null);
      r.render(scene, camera);
    }
  }
}
