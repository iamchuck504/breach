# Blender art with original game animations

The Blender character and all six refined weapons remain the browser default.
`?soldier=legacy` is available for comparison with the original character art.

## Animation rollback — 2026-09-06

The native Blender clip adapter was removed after playtest feedback: it caused
unnatural motion, spring-like running and skinning artifacts. The game no longer
loads or samples `soldier-native.glb`, performs a second body IK solve, or adjusts
the chest separately from the original animation rig.

The same approved character artwork is loaded from `soldier-blender-body.glb`
as 19 rigid visual segments attached directly to the game's existing joints.
These segments were exported from the approved cover-ready soldier and fitted
to the original limb lengths. No skinning, blended root motion or new poses are
applied. Running, aiming, cover, blindfire, reload and death use the original game
animation code. All body materials are opaque with depth writing enabled.

## Preserved

Five cosmetic variants now use the existing selector/network IDs:

| ID | Skin | Visual identity |
| --- | --- | --- |
| 0 | Recruit | Original approved graphite armor |
| 1 | Sentinel | Riot helmet, T visor, central crest, rimmed shoulder guards |
| 2 | Scout | Flight helmet, asymmetric rangefinder, compact shoulder caps |
| 3 | Heavy | Welding helmet, twin filters, stacked shoulder armor |
| 4 | Ghost | Tapered mask, continuous visor, pointed shoulder plates |

All five use the Recruit's exact material instances, including added details.
There are no skin-specific palettes; gray armor, team accents and small unit
markings remain consistent. `soldier-skins.js` replaces helmet/pauldron shells
with joint-bound geometry; hidden original shells are excluded from outlines.
Anatomy, joint transforms and weapon sockets remain unchanged. Team shoulders,
knees and LEDs retain red/blue identification. No stats or abilities vary.
Run `npm run check:skins` with Vite on port 5200 to test all ten team/skin pairs
against their original joint/muzzle transforms and generate front/back lineups.

- Blender character design, red/blue armor and helmet accents.
- Six refined Blender weapons, equipped/stowed/dropped and special pickups.
- Editor character references and character previews.
- Existing right-hand trigger / left-hand support joints.
- Functional muzzle, flash alignment, shot direction, camera and collision.
- Spawn protection, contextual death visibility and respawn restoration.
- Shared geometry/material cache and safe fallback if loading fails.

The native animation source/exporter remains archived, but is not active.

## Re-export

Character visual segments (Blender 5.2, approved soldier blend open):

```text
blender -b /path/to/breach-soldier-smg-cover-ready.blend --python scripts/blender/export-soldier-body.py -- public/assets/characters/blender
```

The exporter uses a separate scene and never saves over the source blend.

## Checks

With Vite on port 5200, run `npm run check:blender`. It loads a practice match
and compares original/new joint matrices frame by frame across six weapons,
idle/running/sprint/aim/cover/blindfire/evade/mantle/melee/death/respawn.
It also checks opaque non-skinned body meshes, muzzle and visual grip alignment,
protection, death restoration and loading failure. Captures are written to
`artifacts/blender-soldier` (or `BREACH_CAPTURE_DIR`).

Additional checks: `check:fire-direction`, `check:reticle` and production build.
