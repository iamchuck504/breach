import {
  Box3, CylinderGeometry, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial,
  OrthographicCamera, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import smg from '../profiles/smg.js';
import { cargarMano } from './index.js';
import { montarAntebrazo } from './antebrazo.js';

async function dibujar() {
  const url = new URLSearchParams(location.search);
  const mano = url.get('mano') ?? 'left', vista = url.get('vista') ?? 'tres-cuartos';
  const escala = Number(url.get('escala') ?? 1), d = Number(url.get('d') ?? 0.05);
  const equipo = url.get('equipo') ?? 'red', pose = url.get('pose') ?? 'relajada';
  const variante = Number(url.get('variante') ?? 0), conAntebrazo = url.get('antebrazo') === '1';
  const montajeSMG = conAntebrazo && mano === 'left' ? {
    ...smg.anatomia, diametroMontaje: smg.anatomia.diametro * escala, avancePulgar: smg.anatomia.avancePulgar * escala,
  } : {};
  const modelo = await cargarMano({ mano, escala, equipo, variante, ...montajeSMG });
  const { grupo, rig, poses, aplicar } = modelo;
  if (conAntebrazo) {
    const soldado = await new GLTFLoader().loadAsync('/assets/characters/blender/soldier-blender-body.glb');
    montarAntebrazo(modelo, soldado.scene, mano, equipo, variante, smg.supportArm.sleeveScale / smg.supportArm.scale);
  }
  const opciones = {
    relajada: poses.relajada, abierta: poses.abierta, pinza: poses.pinza,
    puñoCilindro: () => poses.puñoCilindro(d),
    empuñadura: () => poses.empuñadura(url.get('gatillo') === '1'),
  };
  if (!Object.hasOwn(opciones, pose)) throw new Error('Pose desconocida');
  aplicar(opciones[pose]());
  const escena = new Scene();
  escena.add(grupo);
  const jugador = vista === 'jugador';
  const c = jugador || url.get('cilindro') === '1' ? poses.cilindro(d) : null;
  if (url.get('cilindro') === '1') {
    // El cilindro de inspección deja ver ambos extremos junto a los dedos.
    const longitud = jugador ? .30 / escala : .14;
    const tubo = new Mesh(new CylinderGeometry(c.radio, c.radio, longitud, 80),
      new MeshStandardMaterial({ color: 0x81878b, roughness: .72, metalness: .12 }));
    tubo.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), c.eje);
    tubo.position.copy(c.centro);
    if (jugador) tubo.position.addScaledVector(c.eje, -.078 / escala);
    grupo.add(tubo);
  }
  const camara = jugador ? new PerspectiveCamera(conAntebrazo ? 22 : 43, 1, .01, 4) : new OrthographicCamera(-1, 1, 1, -1, .01, 4);
  const arriba = new Vector3(0, 1, 0);
  let puntos;
  if (jugador) {
    // Del meñique hacia el índice se mira hacia delante; la muñeca queda
    // por debajo del tubo. Su eje permanece horizontal al darle la guiñada.
    const atras = new Vector3(0, 0, 1);
    grupo.quaternion.setFromUnitVectors(c.eje, atras);
    const palma = rig.palmar.clone().applyQuaternion(grupo.quaternion);
    const inclinacion = (mano === 'left' ? 1 : -1) * .56;
    const giro = Math.PI / 2 + inclinacion - Math.atan2(palma.y, palma.x);
    grupo.quaternion.premultiply(new Quaternion().setFromAxisAngle(atras, giro));
    grupo.quaternion.premultiply(new Quaternion().setFromAxisAngle(arriba, .23));
    const apoyo = new Vector3(.057, -.046, -.45);
    grupo.position.copy(apoyo).sub(c.centro.clone().multiplyScalar(escala).applyQuaternion(grupo.quaternion));
    if (conAntebrazo) {
      // Abrir la vista hacia el dorso deja ver los dos lados del collar.
      camara.position.set(0, 0, 1).addScaledVector(rig.palmar.clone().applyQuaternion(grupo.quaternion), -.72);
      camara.lookAt(0, 0, 0);
    }
  } else {
    const { palmar, ancho, largo } = rig;
    const miradas = {
      dorso: palmar.clone().negate(), palma: palmar.clone(),
      pulgar: ancho.clone().negate().addScaledVector(palmar, .08),
      'tres-cuartos': palmar.clone().negate().addScaledVector(ancho, conAntebrazo ? -.48 : -.85).addScaledVector(largo, .26),
    };
    if (!Object.hasOwn(miradas, vista)) throw new Error('Vista desconocida');
    camara.up.copy(largo);
    camara.position.copy(miradas[vista]).normalize();
    camara.lookAt(0, 0, 0);
  }
  if (!jugador || conAntebrazo) {
    escena.updateMatrixWorld(true);
    puntos = [];
    grupo.traverseVisible(o => {
      if (!o.isMesh) return;
      for (let i = 0; i < o.geometry.attributes.position.count; i++) {
        puntos.push(o.localToWorld(o.getVertexPosition(i, new Vector3())));
      }
    });
  }
  const renderer = new WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  escena.add(camara, new HemisphereLight(0xf5f8ff, 0xb7a496, 1.65));
  // Luz principal, relleno y recorte fijos en coordenadas de cámara.
  for (const [x, y, z, fuerza, color] of [
    [-.6, .95, .85, 2.6, 0xfff1df], [.9, .3, .6, .9, 0xe3edff], [.5, .65, -.9, 2.1, 0xf5faff],
  ]) {
    const luz = new DirectionalLight(color, fuerza);
    luz.position.set(x, y, z);
    camara.add(luz, luz.target);
  }
  function encuadrar() {
    const w = innerWidth, h = innerHeight, aspecto = w / h;
    renderer.setSize(w, h, false);
    if (jugador) {
      camara.aspect = aspecto;
      if (conAntebrazo) {
        // Encuadrar los vértices en los ejes de la vista evita que la caja
        // del codo agrande los márgenes o haga parecer pequeña la mano.
        const inversa = camara.quaternion.clone().invert();
        const locales = puntos.map(p => p.clone().applyQuaternion(inversa));
        const caja = new Box3().setFromPoints(locales);
        const centro = caja.getCenter(new Vector3()), tangente = Math.tan(camara.fov * Math.PI / 360);
        let distancia = 0;
        for (const p of locales) {
          const semialto = Math.max(Math.abs(p.y - centro.y), Math.abs(p.x - centro.x) / aspecto);
          distancia = Math.max(distancia, p.z - centro.z + 1.15 * semialto / tangente);
        }
        camara.far = distancia + caja.max.z - caja.min.z + 1;
        camara.position.copy(centro);
        camara.position.z += distancia;
        camara.position.applyQuaternion(camara.quaternion);
      }
    }
    else {
      const inversa = camara.quaternion.clone().invert();
      const coords = puntos.map(p => p.clone().applyQuaternion(inversa));
      const xs = coords.map(p => p.x), ys = coords.map(p => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const alto = Math.max(y1 - y0, (x1 - x0) / aspecto) * .62;
      camara.left = (x1 + x0) / 2 - alto * aspecto;
      camara.right = (x1 + x0) / 2 + alto * aspecto;
      camara.top = (y1 + y0) / 2 + alto;
      camara.bottom = (y1 + y0) / 2 - alto;
    }
    camara.updateProjectionMatrix();
    renderer.render(escena, camara);
  }
  encuadrar();
  addEventListener('resize', encuadrar);
  requestAnimationFrame(() => { window.MANO_LISTA = true; });
}
window.MANO_LISTA = false;
dibujar().catch(error => {
  document.getElementById('error').textContent = error.message;
  console.error(error);
});
