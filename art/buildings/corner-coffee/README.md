# Corner Coffee — approved Blender sample

The original sample is the east building at z=-24 in Calle Cerrada #2. Its
approved construction is now also used by 13 business-specific district variants.
Original Calle remains procedural. Failed asset loading retains the old facade.

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

## District family

Run `blender --background --python art/buildings/corner-coffee/export-district.py`
to rebuild all 13 additional GLBs from `source.blend`. The script opens the source
in a disposable background process for each shop; it never overwrites it.
`district-manifest.json` records exact dimensions, themes and mesh batches.
Optional installed Georgia/Bahnschrift fonts are converted into geometry;
no font files are shipped or required by the game.

Businesses: two pharmacies (capsule/RX motif, no green crosses), two bakeries,
garage, electronics, hardware, barber, laundry, stationery, market, deli and
night cafe. Existing names, ground-floor door bays, spans and heights remain.
West-side storefront components are repositioned, never negatively scaled, so
lettering is not mirrored. Wide buildings add window bays rather than enlarging
individual windows or doors. Text and bevels are converted then batched by material.
Continuation buildings clone these same facades using existing placement/dimming.

The expanded `check-calle2.mjs` checks all 14 facades are present, dimensional
parity, door position/height, signage/roof clearance, unchanged original map,
collision parity and navigation plus a seven-bot match. It also renders every
shop. `check-facade-gallery.mjs` assembles six screenshots for review.

Measured street QA view: approximately 422k triangles / 1490 draw calls versus
54k / 2302 before the district rollout. Geometry cost increases while submission
cost drops; this is not a hardware-independent FPS guarantee. Long multiplayer
and low-end GPU stress tests have not been performed.
