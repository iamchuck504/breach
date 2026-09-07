# Fortaleza castle kit

Build: `node scripts/build-fortress-kit.mjs` (Blender 5.2).

`fortress-kit.blend` is the editable source with named components. The exported
GLB is baked and batched into eight material meshes, not rebuilt at runtime.
Includes four masonry towers, original wall merlons, faction shields, four
brazier baskets, gallery lintel carving and dressed courtyard cover surfaces.

The shared collider manifest supplies cover dimensions. Relief is shallow;
stairs, entrances, window openings, spawns, cover heights and navigation are
unchanged. Existing large-scale terrain, distant scenery and collision meshes
remain generated in the game. This is not a conversion of the entire map.

Original primitive towers, merlons, banners and braziers are fallback only when
the GLB is unavailable. Old tower windows and extra iron cages are suppressed
when the kit is loaded, avoiding overlapping versions.

Validation: `node scripts/check-fort-galleries.mjs` and
`node scripts/check-architecture-polish.mjs`. The first includes actual player
and bot stair traversal, cover, open-window rays, asset budgets and screenshots.

Verified 2026-09-07: 8 material meshes / 51,520 triangles in the kit; GLB
3.64 MB. Inspection courtyard: 82 draw calls / 129,285 triangles versus the
previous 87 / 80,953. Fewer calls does not imply higher FPS: geometry increased;
no hardware FPS claim is made. Gallery traversal, ten clear window rays,
unchanged collider manifests and server authority checks pass.
