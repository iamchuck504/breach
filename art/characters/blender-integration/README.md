# Blender runtime integration

The approved Blender soldier and six refined weapons are the browser default
for local players, bots and remote player rendering. `?soldier=legacy` retains
the old visuals for comparison/recovery. No new network character ID is introduced.

## Included artwork

- Original skinned body/skeleton from `breach-soldier-smg-cover-ready.blend`.
- Ten approved 60 fps clips: idle, aim, walk, sprint, left/right/over cover with
  separate aiming and blindfire studies. Guard-to-fire halves are sampled as
  held states; movement and fixture staging offsets are removed.
- SMG, shotgun, pistol, sniper, bazooka and grenade from
  `breach-weapons-refined-v2.blend`, including equipped/stowed/dropped weapons
  and the special pedestal. Team accents switch between red and blue.
- Native anatomy, with final arm IK at the existing grip/support sockets.
  Anatomical right holds the trigger; left supports the weapon.

There are no approved dedicated reload, melee, evade, mantle, death or low-side
blindfire clips in this source. Those states use the existing procedural poses
retargeted to the new skeleton, not newly authored Blender animations.
The older rigid-body preview asset/exporter remains as source history.

## Gameplay boundary

The adapter writes visual skeleton/meshes only. It does not move the gameplay
root, camera, gun mount, functional muzzle, collision or hit detection. Weapon art
is aligned to the unchanged muzzle; cover occlusion still stops bullets.
Each client renders shared state through the same Rig; no protocol changes.
Geometry/materials are shared; skeletons are per instance. Failed loading keeps
the original avatar. Loading during death waits for corpse restoration.

## Re-export

Run Blender 5.2 with the approved soldier blend open:

```text
blender -b /path/to/breach-soldier-smg-cover-ready.blend --python scripts/blender/export-native-runtime.py -- public/assets/characters/blender /path/to/breach-weapons-refined-v2.blend
```

The exporter uses a separate scene and never saves over either source blend.
Source blends stay in the art workspace; only runtime GLBs are published.

## Verification

With Vite on port 5200, run `npm run check:blender`. The browser test loads a real
practice match, compares functional muzzle origin/direction against legacy across
six weapons and movement/aim/cover/death/respawn, checks visual muzzle/grip
alignment, arm reach, protection and loading fallback, and captures poses.
Captures: `artifacts/blender-soldier` or `BREACH_CAPTURE_DIR`.

Additional checks: fire-direction, reticle, cover-fire, sniper, bazooka,
equipped-weapon-scale and production build. These do not replace a two-machine
multiplayer or exhaustive clipping playtest.
