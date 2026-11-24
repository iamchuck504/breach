import assert from 'node:assert/strict';
import * as T from 'three';

export function checkFortalezaOpenings(world) {
  // Sondeos dentro del vano: detectan tanto una cara duplicada como una
  // superficie suprimida por error al recortar el encuentro con otra pieza.
  const architecture = [];
  world.mapGroup.traverseVisible(o => {
    if (o.isMesh && !o.material.transparent && !o.material.alphaTest) architecture.push(o);
  });
  function surface(origin, direction, distance) {
    const ray = new T.Raycaster(new T.Vector3(...origin),new T.Vector3(...direction),0,distance+.01);
    const hits = ray.intersectObjects(architecture,false);
    const label = origin.join(',')+' hacia '+direction.join(',');
    assert(hits.length && Math.abs(hits[0].distance-distance)<.0001,'Cara ausente o desplazada en '+label);
    for (const hit of hits.slice(1)) {
      if (hit.distance-hits[0].distance >= .002) break;
      // Un rayo sobre la diagonal puede tocar los dos triángulos del mismo rectángulo.
      if (hit.object === hits[0].object && hit.face.normal.dot(hits[0].face.normal)>.999 &&
          [hit.face.a,hit.face.b,hit.face.c].some(i =>
            [hits[0].face.a,hits[0].face.b,hits[0].face.c].includes(i))) continue;
      assert.fail('Dos superficies a menos de 2 mm en '+label);
    }
  }
  for (const side of [-1,1]) {
    for (const x of [25.63,25.81,25.97]) {
      const p=[side*x,4.36,.137];
      surface(p,[0,1,0],5.25-p[1]);
      surface(p,[0,-1,0],p[1]-3);
      for (const end of [-1,1]) surface(p,[0,0,end],1.2-end*p[2]);
    }
    for (const end of [-1,1]) {
      for (const [x,z,y,lintel,from,to] of [[25.81,17.13,1.36,2.4,16,18],[21.42,16.86,1.38,3,15.8475,17.9425]]) {
        const p=[side*x,y,end*z];
        surface(p,[0,1,0],lintel-y);
        surface(p,[0,0,end],to-z);
        surface(p,[0,0,-end],z-from);
      }
    }
    for (let z=-6;z<=6;z+=3) {
      const p=[side*21.43,4.86,z+.129];
      surface(p,[0,1,0],5.555-p[1]);surface(p,[0,-1,0],p[1]-4.135);
      for (const end of [-1,1]) surface(p,[0,0,end],1.1625-end*.129);
    }
    for (const x of [-16,0,16]) surface([x+.157,1.5,side*27.11],[0,1,0],.95);
  }
}
