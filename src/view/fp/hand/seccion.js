import { Vector3 } from 'three';

// Sección transversal de una falange a mitad del hueso. Tanto el molde
// anatómico como la placa se miden entre sus dos caras en ese mismo plano.
export function espesorCentral(geometria, posiciones, alSegmento, longitud, pertenece) {
  const indices = geometria.index;
  const centro = longitud / 2;
  let minimo = Infinity, maximo = -Infinity;
  const puntos = Array.from({ length: posiciones.count }, (_, i) =>
    new Vector3().fromBufferAttribute(posiciones, i).applyMatrix4(alSegmento));
  for (let i = 0; i < (indices?.count ?? posiciones.count); i += 3) {
    const cara = [i, i + 1, i + 2].map(j => indices ? indices.getX(j) : j);
    if (pertenece && !cara.some(pertenece)) continue;
    for (let j = 0; j < 3; j++) {
      const a = puntos[cara[j]], b = puntos[cara[(j + 1) % 3]];
      if ((a.z > centro) === (b.z > centro)) continue;
      const y = a.y + (b.y - a.y) * (centro - a.z) / (b.z - a.z);
      minimo = Math.min(minimo, y);
      maximo = Math.max(maximo, y);
    }
  }
  if (!(maximo > minimo)) throw new Error('Sección de falange vacía');
  return { minimo, espesor: maximo - minimo };
}
