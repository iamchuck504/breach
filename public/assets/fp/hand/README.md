# Mano anatómica de primera persona

Los archivos originales `left.glb` y `right.glb` corresponden al perfil
`generic-hand` de `@webxr-input-profiles/assets`. Cada archivo contiene una
malla con piel y 25 articulaciones en metros. La jerarquía anatómica y el
acabado del guante se generan al cargarla.

© 2019 Amazon. Distribuido bajo la [licencia MIT](./LICENSE.md).
[Proyecto de origen, WebXR Input Profiles](https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/assets).

## Uso en el banco

La entrada es `src/view/fp/hand/index.js`. Las funciones de pose devuelven
ángulos en grados. El diámetro se expresa en metros, ya a escala final.
`inflado` se expresa en metros antes de aplicar la escala global.

```js
import { cargarMano, interpolar } from '/src/view/fp/hand/index.js';

const mano = await cargarMano({ mano: 'left', equipo: 'red', escala: 1.25, inflado: 0.002 });
escena.add(mano.grupo);
const inicio = mano.poses.relajada();
const destino = mano.poses.puñoCilindro(0.05);
mano.aplicar(interpolar(inicio, destino, t));
```

`aplicar` también acepta poses parciales, por ejemplo
`{ index: { pip: 90 }, wrist: { flex: 10 } }`. Los canales ausentes valen cero.
`poses.cilindro(d)` devuelve el centro, el eje unitario y el radio en el
espacio local de `grupo`. Un diámetro inalcanzable produce un `RangeError`.
En el banco, `gatillo=1` selecciona la segunda variante de `empuñadura`.
