// Campo del ocular en fracciones del lado corto, como la cruz del HUD.
// La máscara se dibuja entre el escenario y la profundidad reservada al arma.
import { Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { VIEWMODEL_DEPTH, viewModelFov } from '../../render/pipeline.js';

export const RADIO_VISOR = .46;

export function crearOcular() {
  const aspecto = { value: new Vector2(1, 1) }, aumento = { value: 1 }, abierto = { value: 0 };
  const radio = { value: 2 * RADIO_VISOR };
  const matte = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms: { aspecto, radio },
    vertexShader: `uniform vec2 aspecto; varying vec2 punto;
      void main() { punto = position.xy * aspecto; gl_Position = vec4(position.xy, ${2 * VIEWMODEL_DEPTH - 1}, 1.); }`,
    fragmentShader: `uniform float radio; varying vec2 punto;
      void main() { if (length(punto) < radio) discard; gl_FragColor = vec4(.002,.003,.004,1.); }`,
  }));
  matte.frustumCulled = false;
  matte.visible = false;
  const materiales = new Map();
  return {
    matte, aumento,
    material(base) {
      if (!materiales.has(base)) {
        const m = base.clone();
        m.userData.fpUniforms = base.userData.fpUniforms;
        m.onBeforeCompile = (shader, renderer) => {
          base.onBeforeCompile(shader, renderer);
          Object.assign(shader.uniforms, { aspecto, aumento, abierto, radio });
          shader.vertexShader = 'uniform vec2 aspecto; uniform float aumento; varying vec3 vOcular;\n' +
            shader.vertexShader.replace('gl_Position = uVMProj * mvPosition;', `gl_Position = uVMProj * mvPosition;
              gl_Position.xy *= aumento;
              vOcular = vec3(gl_Position.xy * aspecto, gl_Position.w);`);
          shader.fragmentShader = 'uniform float abierto, radio; varying vec3 vOcular;\n' +
            shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
              if (abierto > .5 && length(vOcular.xy) < radio * vOcular.z) discard;`);
        };
        m.customProgramCacheKey = () => base.customProgramCacheKey() + '|ocular';
        materiales.set(base, m);
      }
      return materiales.get(base);
    },
    actualizar(aspect, perfil, entrada, enMira) {
      aspecto.value.set(Math.max(1, aspect), Math.max(1, 1 / aspect));
      // Llevar el radio físico de la lente al del HUD mientras el ojo se acerca.
      const radioProyectado = perfil.scopeRadius * perfil.scale * aspecto.value.y /
        (2 * perfil.ads.relief * Math.tan(viewModelFov() * Math.PI / 360));
      aumento.value = 1 + (RADIO_VISOR / radioProyectado - 1) * entrada;
      matte.visible = enMira;
      abierto.value = Number(enMira);
    },
    dispose() {
      matte.geometry.dispose();
      matte.material.dispose();
      for (const m of materiales.values()) m.dispose();
    },
  };
}
