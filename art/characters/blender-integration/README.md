# Blender soldier: playable visual preview

Open the game with `?soldier=blender` (add `&nolock=1` for mouse-free inspection).
All locally rendered players and bots use the new red/blue body in this preview.
Without that query, all five existing characters remain unchanged. The preview
does not add a network character ID or change hitboxes, weapons or shot logic.
Other clients must open the same preview URL to see this experimental body.

## What is integrated

- Approved anatomical soldier body from `breach-soldier-smg-cover-ready.blend`.
- 19 rigid visual segments, grouped by material, ~1.75 MB GLB.
- Existing gameplay animation/IK, all weapons, cover, reload, melee and ragdoll.
- Red/blue material variants, existing protection outline and death visibility.
- Shared geometry/material cache; failed loading keeps the original avatar.
- Right-hand visual on the right-hand gameplay joint; left on support joint.

## Deliberately not represented as finished

This is **not** the final Blender animation integration. The ten authored clips
remain in the source artwork: study clips need state-held/reversible cover and
aim transitions, in-place locomotion and compatible reload/melee/death states.
The runtime preview uses the existing game animations and existing weapon models.
Limb lengths and attachments are fitted to that rig, so this is not a pixel-exact
reproduction of the Blender animation renders. Do not enable it by default until
that visual fit and the final animation adapter are approved in gameplay.

## Re-export

Run Blender in background on the approved cover-ready blend with
`--python scripts/blender/export-soldier-body.py -- public/assets/characters/blender`.
The exporter creates a separate scene, never saves over the source blend and
exports only the runtime scene (not the art workbench or other scene objects).

## Checks

With a local Vite server on port 5200, run `node scripts/check-blender-soldier.mjs`.
It loads a real practice match and compares original/new rigs across six weapons,
aim/hip/cover/blindfire/movement/death/respawn. Camera and projectile code are not
modified. Ragdoll randomness is fixed for the paired comparison.
Captures go to `artifacts/blender-soldier` or `BREACH_CAPTURE_DIR`.
This does not replace a two-machine multiplayer or exhaustive clipping playtest.
