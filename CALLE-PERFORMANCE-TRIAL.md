# Calle #2 — bounded performance trial

Change: cache identical clipped upper-facade geometry during map construction.
Instance clipped parts in two-building chunks. No textures, detail, lighting,
colliders or editor-authored transforms were replaced or reduced.

Measured with `node scripts/bench-calle2.mjs <tag>`: headless Chrome, 1280x720,
fixed cameras, shadows enabled, eight warmups and median of 15 renders with
`gl.finish()`. This measures synchronized static rendering, NOT gameplay FPS.

| Metric | Before | Final two-building chunks |
| --- | ---: | ---: |
| Upper-facade batches | 126 | 66 |
| Renderer geometry count | 1886 | 1786 |
| Map construction ms (single sample) | 1106.8 | 464.8 |
| Street draw calls | 1596 | 1569 |
| Alley draw calls | 345 | 325 |
| Aerial draw calls | 2296 | 2236 |
| Street triangles submitted | 459604 | 471310 |
| Alley triangles submitted | 196600 | 196600 |
| Aerial triangles submitted | 685678 | 685678 |
| Street render ms | 18.9 | 20.5 |
| Alley render ms | 9.5 | 9.5 |
| Aerial render ms | 25.5 | 24.9 |

An intermediate avenue-wide batch reached 26 batches, but submitted 517486
street triangles / 219688 alley triangles. The final version trades some of
that draw reduction for better culling. The final sample does NOT establish
an FPS improvement; street timing was worse. Repeated, controlled real-game
CPU/GPU profiling is required before promising a frame-rate gain. The reliable
benefit here is less duplicated geometry and fewer repeated clipping operations.

Generated textures vary between builds, so image hashes are recorded but are
not a pixel-equivalence assertion. Before/after alley views were inspected;
window geometry and signs remain intact. All 216 colliders remain identical.
Map sanity, seven-bot navigation/play, clipping unit test and build pass.
