// Recuperar las bisagras de las matrices de enlace del GLB publicado. La
// lectura usa la rotación local dibujada, también en medio de una transición.
import { Matrix4, Quaternion, Vector3 } from 'three';

const grados = 180 / Math.PI;
const v = (x, y, z) => new Vector3(x, y, z);
export function medirDedos(anatomia, lado) {
  const signo = lado === 'L' ? 1 : -1;
  const palmar = v(0, -1, 0), ancho = v(-signo, 0, 0);
  const cadenas = {};
  for (const nombre of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
    const prefijo = nombre + (nombre === 'thumb' ? '-' : '-finger-');
    const cadena = anatomia.bones.flatMap((b, i) => {
      if (!b.name.startsWith(prefijo)) return [];
      const enlace = new Matrix4().fromArray(b.inv).invert();
      return [{ hueso: anatomia.joints[i], origen: new Vector3().setFromMatrixPosition(enlace),
        inicial: new Quaternion().fromArray(b.rot).invert(), marco: new Quaternion().setFromRotationMatrix(enlace).invert() }];
    });
    for (const [i, tramo] of cadena.slice(0, -1).entries()) {
      const eje = cadena[i+1].origen.clone().sub(tramo.origen).normalize();
      tramo.direccion = eje.clone().applyQuaternion(tramo.marco);
      tramo.flex = eje.clone().cross(nombre === 'thumb' ? ancho : palmar).normalize().applyQuaternion(tramo.marco);
      tramo.abd = (nombre === 'thumb' ? eje.clone().cross(palmar).normalize() : palmar.clone().multiplyScalar(signo))
        .applyQuaternion(tramo.marco);
    }
    cadenas[nombre] = cadena;
  }
  const q = new Quaternion();
  function giro(tramo, eje) {
    q.copy(tramo.inicial).multiply(tramo.hueso.quaternion);
    const rotacion = 2 * Math.atan2(q.x*eje.x + q.y*eje.y + q.z*eje.z, q.w) * grados;
    return (rotacion + 540) % 360 - 180;
  }
  return nombre => {
    const c = cadenas[nombre];
    if (nombre === 'thumb') {
      // La oposición gira también la pieza sobre su eje. Usar la dirección
      // del segmento elimina ese giro al descomponer la flexión y la abducción.
      const { direccion, flex, abd, inicial, hueso } = c[0];
      const actual = direccion.clone().applyQuaternion(q.copy(inicial).multiply(hueso.quaternion));
      const seno = actual.dot(abd) / flex.clone().cross(direccion).dot(abd);
      const cmc = Math.asin(Math.max(-1, Math.min(1, seno)));
      const referencia = direccion.clone().applyAxisAngle(flex, cmc).projectOnPlane(abd);
      actual.projectOnPlane(abd);
      const apertura = Math.atan2(abd.dot(referencia.clone().cross(actual)), referencia.dot(actual));
      return { cmc: cmc * grados, abd: apertura * grados, mcp: giro(c[1], c[1].flex), ip: giro(c[2], c[2].flex) };
    }
    return { mcp: giro(c[1], c[1].flex), pip: giro(c[2], c[2].flex),
      dip: giro(c[3], c[3].flex), abd: giro(c[1], c[1].abd) };
  };
}
