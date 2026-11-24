# Arma en primera persona — cómo añadir un arma

Ejemplo de referencia: la SMG (`scripts/viewmodel-art/smg.mjs`, `src/view/fp/profiles/smg.js`).
Cada arma es autocontenida: **dos archivos tuyos y una línea en el índice**. No toques
`common.js`, `rig.js` ni el arte de los brazos (son de VISTA).

## 1. Arte: `scripts/viewmodel-art/<arma>.mjs`
Exporta por defecto `({ sockets }) => spec` (`sockets` = anclas del GLB original,
`public/assets/characters/blender/weapons.json`). Coordenadas del MODELO (m): x derecha,
y arriba, **-z hacia la boca**.

```js
export default ({ sockets }) => ({
  sculpt(piece, anchors) { /* piezas del kit en coordenadas del modelo */ },
  rules: [                          // isla → pieza; gana la primera; el resto es `body`
    { part: 'mag', from: 'mag', box: [[-0.08, 0.08], [-0.06, 0.16], [-0.2, 0.05]] },
    { part: 'bolt', from: 'grip', absX: true, box: [[0.08, 0.11], [0.1, 0.13], [-0.22, -0.16]] },
    { part: 'sight_rear', from: 'grip', box: [...], drop: true },   // se sustituye por una construida
  ],
  build: [ ['sight_rear', 'graphite', [xmin, ymin, zmin], [xmax, ymax, zmax], bisel] ],
  pivots: { body: [0, 0, 0], mag: [...], bolt: [...], trigger: [...], ... },  // un nodo por pieza
  anchors: { muzzle, grip, forend, mag, sight_rear, sight_front, eject, ... },
});
```
- `sculpt` recibe un `Builder` por pieza mediante `piece(nombre)`. Los acabados se agrupan al generar el GLB. Con `replace: true` toda la geometría sale del kit, como en la SMG. El resto conserva la resolución del GLB de autor. El máximo conjunto es de 45 000 triángulos y 12 llamadas de dibujo.
- `box` compara el CENTRO de la caja de cada isla **relativo al socket `from`**. `absX` usa |x|;
  `mat` filtra por nombre de material (`'machined'`, `'rubber'`…).
- Para ver las islas: `node /Users/chuck/Library/Caches/breach-overhaul/run6/vista-work/islands.mjs <arma>`
  (lista centro, caja y material de cada una).
- Anclas obligatorias: `muzzle`, `grip`, `forend` (o el apoyo que uses), `mag`, `eject`,
  **`sight_rear` y `sight_front` a la misma altura y en x=0** (si el arma trae mira óptica,
  el centro de la lente delante y detrás). Las que quieras para las manos (p. ej. `bolt`, `pump`).
- Generar solo tu arma: `node scripts/build-viewmodel-art.mjs <arma>` (no toca las demás).
  Comprobar: `node scripts/check-fps-art.mjs` (piezas, anclas, presupuesto, bytes estables).

## 2. Perfil: `src/view/fp/profiles/<arma>.js` + una línea en `profiles.js`
Espacio de CÁMARA: x derecha, y arriba, -z delante, **metros reales**. Rotaciones Euler
YXZ en radianes (x cabeceo +boca arriba, y guiñada +boca a la izquierda, z alabeo).
Las posturas dicen dónde va el ancla `grip` y el arma gira alrededor de ella.

| campo | qué es |
|---|---|
| `model` | nombre del GLB en `public/assets/fp/` |
| `scale` | Conversión del arma al marco de las curvas. El montaje lleva el conjunto a metros del soldado, con el guante y el brazal a escala natural. |
| `hip` `{pos, rot}` | postura de cadera. Debe caber en la zona del HUD (abajo a la derecha ~30 %×40 %) |
| `ads` `{relief, roll}` | **la ADS no se ajusta a mano**: `anim.deriveAds` pone la línea alza→guion en el eje óptico con el alza a `relief` m del ojo. Vale para cualquier FOV y aspecto |
| `sprint`, `crouch`, `lower` (trepar), `slide`, `wall` | posturas ADITIVAS `{pos, rot}` |
| `mass` (kg), `adsTime` (s) | rigidez de los resortes y entrada a ADS |
| `recoil` `{kick m, rise rad, yaw rad, roll rad, ads factor}` | impulso por disparo |
| `parts` | piezas móviles: `mag`, `bolt`, `trigger`, `boltAxis`, `boltTravel` (m modelo), `triggerTravel` (rad), `stockFold`, `stockHidden` |
| `targets` | marcos de mano: `{anchor, axis, palm, off}` en el arma o `{cam, axis, palm}` en cámara. `axis` = meñique→índice, `palm` = normal exterior del dorso, `off` en m del modelo |
| `grips` | El perfil elige la pieza que recibe cada mano. `profiles/contactos.js` contiene el marco del agarre y las rotaciones de los dedos sobre la geometría publicada. El constructor hornea esas poses del módulo `hand/` en `arms.glb`. |
| `reload` | `{ steps: [{t, step}], tail, tracks }` — `t` normalizado a `reloadTime` |
| `swap`, `melee`, `throw` | vienen de `COMMON`; sobrescríbelos si el arma lo pide |

Pistas (`tracks`): `[[u, valores…], …]`, Catmull-Rom. Canales: `gun [u,px,py,pz,rx,ry,rz]`
(aditivo), `left [u, …pesos de LEFT_CHANNELS]`, `lOff [u,dx,dy,dz]`, `lCurl [u, …pesos de
CURL_CHANNELS]`, `bolt [u, 0..1]`, `nade [u, 0..1]`.

**Pasos de recarga** = los de `RELOAD_TIMELINES` de `src/combat/weapons.js` y las piezas de
`src/fx/audio.js` (o llama `setReloadTimeline(arma, perfil.reload.steps)`). La munición la
cambia la lógica, nunca una curva: los pasos solo mueven piezas (`magOut`, `magIn`,
`boltRelease`, `shellIn`, `pump`, `rocketIn`, …).

## 3. Eventos y capas
Eventos (emisor de `Weapons`, CONTRATO §4): `fire`, `dry`, `reloadStart {total}`,
`reloadStep {name}`, `reloadEnd`, `reloadCancel`, `swapStart`, `swapMid`, `swapEnd`,
`meleeStart`, `throwStart {total, release}`, `throwRelease`; además `land`, `hurt`, `draw`.
Capas (`anim.js`, puro): base cadera↔ADS + posturas → locomoción aditiva → acción exclusiva
con prioridad y fundido → resorte por masa con gobernador de velocidad (≤1.15 m/s) →
resortes con rebote (balanceo, retroceso, aterrizaje, golpe). En `rig.js` el agarre fija el guante.
El antebrazo nace en la muñeca y se extiende hacia abajo y atrás hasta salir del encuadre.

### Agarres por arma
La mano derecha siempre va a `targets[grips.right.target]`; la izquierda mezcla los canales
`LEFT_CHANNELS`. Declara en `targets` los marcos que tu arma necesite:
- En la pistola y la aturdidora, la derecha permanece en `grip`. La izquierda queda fuera de cuadro y entra por abajo para extraer la pieza, insertarla y asentarla con la palma.
- escopeta: `forend` = la corredera (`anchor: 'pump'`), la mano sigue el recorrido efectivo de la pieza
- francotirador: `bolt` (la derecha acciona el cerrojo y la izquierda sostiene el guardamanos)
- bazuca: `grip` + `forend` con el tubo al hombro (`hip.pos` alto y a la derecha)
- humo y fragmentación: derecha alrededor del cuerpo y pulgar sobre la palanca, izquierda en pinza para extraer la anilla

## 4. Ver y medir (siempre con el candado, un navegador a la vez)
```sh
C=/Users/chuck/Library/Caches/breach-overhaul/run6/con-navegador.sh
W=/Users/chuck/Library/Caches/breach-overhaul/run6/vista-work
node scripts/check-fps-anim.mjs                      # continuidad y pasos de las animaciones
node scripts/check-fps-hands.mjs                     # piel, contactos, silueta y presupuesto en Node
node scripts/check-fps-view.mjs                      # encuadre y alineación óptica
node $W/rect.mjs                                     # rectángulo proyectado (cadera, sprint, recarga, retroceso)
node $W/pose-view.mjs out.png '{}' 1500 grip         # manos sobre el arma, sin navegador
cd $W && $C node bench-shot.mjs bench s-strips.mjs 640x360   # banco: tiras de animación
cd $W && $C node vista-game.mjs fortaleza <dir> hip,ads,fire,reload,wall,flash   # en el juego
```
El banco es `http://127.0.0.1:5210/src/view/fp/bench.html` (`window.BENCH`).
