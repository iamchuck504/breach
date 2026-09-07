# Fortaleza / Azoteas — architectural polish

First visual pass on the existing built-in layouts, September 2026.

## Art and scope

- Fortaleza: dressed stone caps, corner courses, plinths, arrow-slit details,
  tower bands, existing brazier cages, closed arched timber gates with stone
  voussoirs and ironwork. The old flat gate artwork is hidden when its GLB loads.
- Azoteas: sheet-metal equipment casings, louvred ventilation faces, electrical
  cabinets, human-scale access doors (2.32 m frame versus 1.63 m soldier),
  maintenance labels, mounted warm task lights. Glass skylights are preserved.
- Four editable Blender sources and their generated GLBs are included. Run
  `blender -b --python art/map-polish/build.py` from the repository root.
  Sources keep individual components; exports batch meshes by material. Runtime
  instances the exported components and shares their geometry/materials.
- No new floors or expanded playable areas in this pass: existing routes and
  helipad elevation already provide the tactical structure. No cover heights,
  spawns, pickups, navigation, weapon logic or authoritative geometry changed.
- Dressing currently applies to built-in Fortaleza/Azoteas only. Custom editor
  layouts are deliberately not decorated from fixed original coordinates.

## Verification

Passed build, `check-map-authority`, `check-cover-lean-collision`,
`check-bot-stuck`, `check-impacts`, and `check-architecture-polish`.
The new test checks asset loading, finite instance transforms, repeated map
switches, unchanged shared colliders, hidden fallback gates, a clear helipad,
and physical backing within 8 cm behind both gate/access-door approaches.
Visual review covered ground-level, spawn architecture and aerial views.
This is not a full long-duration multiplayer playtest or exhaustive camera sweep.

## Reproducible rendering comparison

`node scripts/bench-calle2.mjs <tag> fortaleza` (or `azoteas`).
Local Chrome, 1280×720, Three.js render + `gl.finish`, median of 15 static frames
after 8 warmup frames. This is not total gameplay frame time or a promised FPS.
Randomized base textures mean images are not pixel-identical between runs.

| Map / view | Draw calls before → after | Triangles before → after | Median ms before → after |
| --- | ---: | ---: | ---: |
| Fortaleza / ground | 100 → 108 | 5,655 → 31,019 | 1.6 → 1.7 |
| Fortaleza / architecture | 44 → 51 | 4,575 → 28,979 | 1.0 → 1.0 |
| Fortaleza / aerial | 165 → 173 | 7,264 → 32,628 | 1.9 → 1.8 |
| Azoteas / ground | 129 → 155 | 6,414 → 91,318 | 1.8 → 1.9 |
| Azoteas / architecture | 53 → 71 | 4,056 → 88,904 | 0.8 → 1.2 |
| Azoteas / aerial | 205 → 235 | 7,914 → 92,846 | 1.8 → 2.3 |

Collider counts remain 76 / 66. Added instancing batches: 9 / 18.
Geometry cost is higher, especially for the repeated roof louvres. Static render
cost remains modest in this local sample; integrated-GPU and long-session
performance remain to be measured. No claim of performance improvement.
