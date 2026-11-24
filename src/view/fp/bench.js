// Banco del arma en primera persona: escena neutra, tiempo controlado.
// window.BENCH = { vm, set(state), event(name, data), step(seconds, state), measureAds(), render() }
// Parámetros: ?fov=72&team=red&bg=wall
import * as THREE from 'three';
import { createViewModel } from './viewmodel.js';
import { silhouette } from './silhouette.js';
import { ARMS } from './profiles.js';
import { viewModelUniforms, updateViewModelProjection, setViewModelFov } from '../../render/pipeline.js';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fa6b8);
const camera = new THREE.PerspectiveCamera(+(q.get('fov') ?? 72), innerWidth / innerHeight, 0.04, 400);
camera.position.set(0, 1.48, 0);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a4a3a, 1.2));
const sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
sun.position.set(-4, 9, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x8a7f70, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 0.4), new THREE.MeshStandardMaterial({ color: 0xb8a890, roughness: 0.85 }));
wall.position.set(0, 1.5, -6); wall.castShadow = wall.receiveShadow = true; scene.add(wall);
// marca en el centro de la pantalla (para ver la mira)
const ret = document.createElement('div');
ret.style.cssText = 'position:fixed;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border:1px solid #0f0;border-radius:50%;pointer-events:none;display:none';
document.body.appendChild(ret);

const aviso = document.createElement('div');
aviso.style.cssText = 'position:fixed;bottom:12px;left:12px;color:white;background:#15171bee;padding:8px 12px;font:16px system-ui;display:none';
document.body.appendChild(aviso);
const vm = createViewModel({ scene, camera, team: q.get('team') ?? 'red' });
let state = { aim01: 0, speed: 0 };
const B = {
  vm, scene, camera, renderer, ARMS,
  ready: vm.ready.then(() => { vm.setWeapon('smg'); B.step(0.5); return true; }),
  set(s) { state = { ...state, ...s }; },
  event(name, data) { vm.event(name, data); },
  // avanza `sec` en pasos de 1/60 y dibuja
  step(sec = 1 / 60, s = null) {
    aviso.style.display = 'none';
    if (s) B.set(s);
    const n = Math.max(1, Math.round(sec * 60));
    for (let i = 0; i < n; i++) vm.update(1 / 60, state);
    renderer.render(scene, camera);
  },
  // vista de inspección: cámara en órbita alrededor del arma (marco de la
  // cámara de juego), para ver manos y brazos desde fuera
  inspect(yawDeg = 60, pitchDeg = 10, dist = 0.7, target = [0.05, -0.2, -0.35], fov = 40) {
    const cam2 = B._cam2 ??= new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.01, 50);
    cam2.fov = fov; cam2.aspect = innerWidth / innerHeight; cam2.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const t = vm.root.localToWorld(new THREE.Vector3(...target));
    const yaw = yawDeg * Math.PI / 180, pitch = pitchDeg * Math.PI / 180;
    const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist * vm.root.scale.x);
    cam2.position.copy(t).add(off.applyQuaternion(camera.quaternion));
    cam2.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    cam2.lookAt(t);
    cam2.updateMatrixWorld();
    setViewModelFov(fov); updateViewModelProjection(cam2);
    renderer.render(scene, cam2);
    setViewModelFov(null); updateViewModelProjection(camera);
  },
  // Desplaza la ventana de proyección conservando el ojo, el gesto y la perspectiva.
  detalle(tipo) {
    const P = viewModelUniforms.uVMProj.value;
    const mask = silhouette(vm, P);
    const bounds = new THREE.Box2(), pt = new THREE.Vector2();
    const sides = tipo === 'manos' ? ['L', 'R'] : [tipo];
    const selected = mask.names.map(name => tipo === 'indice'
      ? name.startsWith('fp_L_index-finger-') || name === 'fp_' + vm.key + '_pin'
      : tipo === 'brazal' ? name === 'fp_fore_L' || name === 'fp_L_wrist'
      : tipo === 'mira'
      ? name.endsWith('_sight_front') || name.endsWith('_sight_rear')
      : sides.some(side => name.startsWith('fp_' + side + '_')));
    for (let i = 0; i < mask.owner.length; i++) {
      if (!selected[mask.owner[i]]) continue;
      bounds.expandByPoint(pt.set(2 * ((i % mask.width) + 0.5) / mask.width - 1,
        1 - 2 * (Math.floor(i / mask.width) + 0.5) / mask.height));
    }
    aviso.style.display = 'none';
    if (bounds.isEmpty() && tipo !== 'manos') {
      // Una mano detrás del tubo o bajo el borde no tiene primer plano desde el ojo.
      aviso.textContent = ({ R: 'Mano derecha', L: 'Mano izquierda', brazal: 'Brazal', mira: 'Mira', indice: 'Índice y anilla' })[tipo] + ' fuera de vista desde el ojo';
      aviso.style.display = 'block';
      renderer.render(scene, camera);
      return;
    }
    if (bounds.isEmpty()) bounds.set(pt.set(-0.5, -1), new THREE.Vector2(0.5, 0));
    const size = bounds.getSize(new THREE.Vector2());
    const zoom = tipo === 'manos' ? 2 : THREE.MathUtils.clamp(1.78 / Math.max(size.x, size.y), 1, 10);
    const c = bounds.getCenter(new THREE.Vector2()).clampScalar(-1 + 1 / zoom, 1 - 1 / zoom);
    const crop = new THREE.Matrix4().makeScale(zoom, zoom, 1).setPosition(-zoom * c.x, -zoom * c.y, 0);
    const original = P.clone();
    try {
      P.premultiply(crop);
      camera.projectionMatrix.premultiply(crop);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.render(scene, camera);
    } finally {
      P.copy(original);
      camera.updateProjectionMatrix();
    }
  },
  setFov(fov) { camera.fov = fov; camera.updateProjectionMatrix(); },
  setTeam(t) { vm.setTeam(t); },
  showRet(on) { ret.style.display = on ? 'block' : 'none'; },
  // proyecta las miras (marco de cámara) con la proyección del arma → px
  measureAds() {
    const out = {};
    const P = viewModelUniforms.uVMProj.value;
    for (const name of ['sight_rear', 'sight_front']) {
      const v = vm.anchorCam(name, new THREE.Vector3()).applyMatrix4(P);
      out[name] = [(v.x * 0.5 + 0.5) * innerWidth - innerWidth / 2, (-v.y * 0.5 + 0.5) * innerHeight - innerHeight / 2];
    }
    return out;
  },
};
window.BENCH = B;
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});
