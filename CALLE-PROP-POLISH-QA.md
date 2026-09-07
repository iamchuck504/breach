# Calle Cerrada #2 — vehicle/environment polish

Visual-only pass over existing models, not a replacement or a scale change.
Original Calle is unchanged; editor maps based on Calle #2 inherit the polish.

- Sedans: inset gray hub hardware, grille detail, front/rear plates, restrained
  paint roughness. Existing glazing, mirrors, doors, tire dimensions and police
  livery retained.
- Trucks/buses: hub hardware, fleet markings, small reflectors, cargo/rear
  hardware and ventilation details mounted on the existing surfaces.
- SUVs, shelters, hydrants and streetlights: local cloned material adjustments;
  shared GLB geometry, cache materials and window vertex colors unchanged.
- Dumpsters: softened main-body corners, waste labels, small hinge/edge details.
- Jersey barriers: reflectors/markings, old protruding stain blocks aligned to
  their waist surface instead of reading as floating pieces.
- Kiosks/carts: menu/news signage, ventilation, edging and small cooking tray.
  Openings, countertops, current main signs and human proportions retained.

Implementation: `src/world/calle-prop-polish.js`, invoked by the existing prop
builders. Attachments are parent-local and idempotent, batched by material.
No new point lights, audio, particles, animation, colliders, cover faces, pickup
locations or navigation changes. Source game meshes are kept; this pass does
not require new Blender exports.

QA: `npm run build`, `node scripts/check-map-authority.mjs`,
`node scripts/check-calle2.mjs`. Checks include prop coverage, parent transforms,
attachment silhouette tolerance (4 cm max), original-map isolation, server/client
collider parity, LOS/decals/rewind, routes/cover/spawns and seven moving bots.
Inspected close-up captures under `artifacts/calle2/polish-*.png`.

Street QA view: around 428k triangles / 1567 draw calls (previous facade pass:
422k / 1490). Existing bundle-size warning persists. No physical controller,
extended multiplayer, low-end GPU or long-duration flicker stress test performed.
