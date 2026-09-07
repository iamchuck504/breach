# Fortaleza — galerías laterales

Ampliación simétrica del mapa existente. No se ha reorganizado el patio.

- Dos galerías exteriores de 3.8 m de ancho, piso superior a 3 m.
- Galerías acortadas de 48 a 36 m: terminan en z ±18, unos 5 m antes del spawn.
- Cuatro escaleras: comienzan en z ±15.8, delante de los spawns en ±23.4;
  ascienden hacia el centro hasta ±8. No hay escaleras desde el centro ni
  vuelos que suban hacia atrás del spawn.
- Accesos laterales z 15.8–18.0; cinco ventanas abiertas por galería.
- Antepechos de 1.1 m respecto al piso superior; dinteles y tejados sólidos.
- Se conservan coberturas, escudos, pilares, munición, especial y spawns.
  Solo se abren cuatro huecos en las murallas largas. Dos macizos vegetales
  no utilizables como cover se apartan hacia atrás de los accesos; los árboles
  exteriores se alejan de las nuevas paredes para que no las atraviesen.

## Fuente editable y reproducción

`fortaleza-galleries.blend` es la fuente editable. El GLB se agrupa en cinco
materiales; no se exportan miles de objetos independientes.

Desde la raíz del repositorio:

```sh
node scripts/build-fort-galleries.mjs
```

`BLENDER_EXE` permite cambiar la ruta del ejecutable. El script regenera
`layout.json` desde `src/world/fortaleza-galleries.js`, guarda el `.blend`
y exporta `public/assets/calle/fortaleza-galleries.glb`.

La altura de suelo interpolada evita escalones bruscos en locomoción; los
raycasts sí ven los peldaños físicos. `minY` permite ventanas, dinteles y
tejados con huecos reales, compartidos con el servidor. Los snapshots del
editor conservan `minY`, `walkSurface` y `coverBase`.

Benchmark previo al recorte (no equivale a FPS de una partida): vista de patio
116 llamadas / 96,175 triángulos / mediana 1.7 ms; vista aérea 190 llamadas /
97,900 triángulos / 1.8 ms. Construcción de escena ~249 ms. La ampliación
añade geometría real, no imágenes planas que simulen un segundo piso.

## Validación de esta pasada

- Build de producción.
- `check-fort-galleries`: cuatro recorridos de jugador y de bot, subida y
  bajada, retorno al suelo, sin rodeos al spawn enemigo, sin saltos de bots;
  10 ventanas abiertas y cobertura superior que conserva y=3 al apuntar.
- `check-map-authority`: colliders cliente/servidor idénticos, pose elevada
  sincronizada, daño a través de ventana abierta, tracer recortado y daño
  rechazado al disparar contra un pilar; pruebas anteriores de LOS/rewind.
- `check-cover-fire`, `check-cover-lean-collision`, `check-impacts`.
- `check-bot-stuck`: recuperación de obstáculos con grafo desactivado para
  aislar ese mecanismo; navegación activa cubierta por check-fort-galleries.
- Capturas inspeccionadas desde entrada, escaleras, galería, patio y aérea.
  Solo la aérea de inspección desactiva niebla; el juego conserva su ambiente.

El test amplio `check-editor-clone` conserva colisión, cobertura, spawns,
pickups y export/import. Sigue reportando dos diferencias visuales anteriores
a esta ampliación: el polish arquitectónico de Fortaleza/Azoteas se aplica a
mapas oficiales, no a sus clones. No se altera ese sistema en esta pasada.
La galería nueva sí se conserva en el clon. No se da por cerrado el balance
competitivo sin partidas humanas prolongadas en los nuevos pasillos.
