// Capa de vida "cordon" del look de Calle (ver el contrato en ../index.js).
// Lo que sigue funcionando del operativo policial: el destello de las barras
// de las patrullas, los rotativos de los camiones, los pilotos ámbar de las
// barricadas de obra, las bengalas y las brasas de los autos quemados.
// Las fuentes y su animación son de sources.js (ctx.calle, lo prepara
// surfaces): aquí solo se dibujan los halos, con la MISMA intensidad que
// lava las superficies. Una llamada de dibujo.
import { patch } from '../glsl.js';

export function build(ctx) {
  if (ctx.theme !== 'calle' || !ctx.calle) return null;
  const { THREE } = ctx;
  const S = ctx.calle.sources, list = S.list;
  if (!list.length) return null;
  const N = S.I.length;
    const dot = new THREE.CanvasTexture(glowDot());
  dot.colorSpace = THREE.SRGBColorSpace;

  // --- halos: un núcleo pequeño y un halo ancho por fuente. Aditivos, sin
  // escribir profundidad; el halo se apaga del todo entre destellos, el
  // núcleo nunca (la lente se ve aunque no destelle).
  {
    const pos = [], col = [], src = [], size = [];
    list.forEach((s, i) => {
      const core = { flare: 0.16, amber: 0.26, beacon: 0.3, ember: 0.22 }[s.kind] ?? 0.32;
      const halo = { flare: 1.0, amber: 1.9, beacon: 2.6, ember: 0.9 }[s.kind] ?? 3.2;
      const y = s.kind === 'flare' ? 0.07 : s.pos.y;
      for (const [sz, k] of [[core, 1], [halo, 0]]) {
        pos.push(s.pos.x, y, s.pos.z);
        col.push(s.color.r, s.color.g, s.color.b);
        src.push(i + k * 0.5); // .5 = núcleo
        size.push(sz);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aSrc', new THREE.Float32BufferAttribute(src, 1));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    const mat = new THREE.PointsMaterial({
      map: dot, vertexColors: true, size: 1, sizeAttenuation: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    patch(mat, {
      uniforms: { uLkSrcI: { value: S.I } },
      vertexPars: `attribute float aSrc; attribute float aSize; uniform float uLkSrcI[${N}]; varying float vLkK; varying float vLkCore;`,
      vertex: `{
  int i = int(floor(aSrc));
  vLkCore = fract(aSrc) > 0.25 ? 1.0 : 0.0;
  float k = uLkSrcI[i];
  // núcleo siempre algo encendido; halo solo con el destello
  vLkK = vLkCore > 0.5 ? 0.35 + 2.0 * k : k * k * 1.5;
}`,
      fragmentPars: 'varying float vLkK; varying float vLkCore;',
      fragment: 'diffuseColor.rgb *= vLkK * (1.0 + vLkCore * 1.5); diffuseColor.rgb += vec3(vLkCore * vLkK * 0.35) * diffuseColor.a;',
      key: 'calle-halos',
    });
    mat.onBeforeCompile = ((prev) => (shader, r) => {
      prev(shader, r);
      shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', 'gl_PointSize *= aSize;\n// de lejos no se encogen del todo: la barra se ve de punta a punta de la avenida\ngl_PointSize = max(gl_PointSize, vLkCore > 0.5 ? 4.0 : step(1.5, aSize) * 34.0 * min(vLkK, 1.0));\n#include <fog_vertex>');
    })(mat.onBeforeCompile);
    const pts = new THREE.Points(geo, mat);
    pts.name = 'cordon-halos';
    pts.frustumCulled = false;
    pts.renderOrder = 2;
    ctx.group.add(pts);
  }

  // (los cartuchos de bengala son una calcomanía de ruina.js y su humo, de
  // la nube de partículas de atmos.js)
  return null;
}

function glowDot() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.18, 'rgba(255,255,255,.8)');
  grad.addColorStop(0.45, 'rgba(255,255,255,.22)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return cv;
}
