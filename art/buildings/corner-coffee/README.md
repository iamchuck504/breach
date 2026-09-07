# Corner Coffee — approved Blender sample

Only Calle Cerrada #2, east building at z=-24, uses this model. Original Calle
and the other facades remain procedural. Failed asset loading retains the old facade.

`source.blend` is the editable standalone study; it does not contain game scenes.
Export from the repository root:

```sh
blender --background art/buildings/corner-coffee/source.blend --python art/buildings/corner-coffee/export-game.py
```

Exporter converts lettering and bevels to meshes and joins by material (19 mesh
batches). Presentation ground/cameras/lights are excluded from the GLB.
Output: `public/assets/calle/corner-coffee.glb`.

Envelope: 7.6 m frontage, 5.4 m depth, 9.35 m roof cap. Door leaf: 1.29 x 2.46 m;
game soldier reference: 1.63 m. The authored facade has shallow projections and
a canopy above walking height, not new gameplay cover. No collision layouts,
spawns, navigation, weapon logic or entrance routes were changed. The decorative
bench crossing this entrance was omitted; it had no collider.

Verified: `npm run build`, `node scripts/check-calle2.mjs` (asset presence, mesh
budget, roof/sign clearance, server/client collision parity, original-map
preservation, entrances, navigation and a seven-bot match). In-game screenshot:
`artifacts/calle2/cafe.png`. Static screenshots inspected; not a long-duration
flicker or multiplayer stress test. Existing bundle-size warning remains.
