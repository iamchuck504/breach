import { BufferGeometryLoader } from 'three';
import moldes from './punos.json' with { type: 'json' };

// El constructor del arte extrae estos dos moldes del GLB del soldado.
// El banco síncrono y las manos publicadas reciben los mismos triángulos.
const plantillas = new WeakMap();
export function moldePuno(lado, datos = moldes[lado]) {
  if (!plantillas.has(datos)) {
    const geo = new BufferGeometryLoader().parse({ data: datos });
    geo.computeBoundingBox();
    plantillas.set(datos, geo);
  }
  return plantillas.get(datos);
}
