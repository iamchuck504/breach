# Calle #2 — Blender street props

These are refinements of the actual in-game models, not independently scaled replacements.

`input/*.glb` preserves the exported baseline. `refine.py` imports it into Blender,
adds functional details and small edge bevels, packs textures, saves one editable
`.blend` per prop, and exports material-batched `public/assets/calle/prop-*.glb`.
Run with Blender 5.2 in background mode. Do not re-export the live map as a new
baseline after integration: that would recursively bake the replacements.

Included: coffee cart (espresso machine, grinder, cups and panel trim), hot-dog
kiosk (roller grill, food tray and rear menu), news kiosk (magazine shelves,
papers and till), dumpster (lift pockets, ribs, lid hardware), concrete jersey,
roadwork barrier, bus shelter. Shelter changes are intentionally lighter:
manufactured edge bevels/material finish, without enclosing its open front.

Original Calle is unchanged. Calle #2 and its editor derivatives load these
assets; missing assets fall back to the original procedural models. Replaced
procedural meshes remain in a hidden subgroup so normal map disposal still
owns their resources. They do not render or receive visual bullet raycasts.
Editor keys, placements and shared collision definitions are unchanged.
The service-alley dumpster also uses the new model fitted to its existing box.

Validation: build; `check-map-authority.mjs`; `check-calle2.mjs` including precise
vertex bounds against the originals (8cm maximum decorative extension), asset
presence, hidden fallback, unchanged spawns/routes/collision, and seven-bot play.
Screenshots cover coffee, hot dogs, news and dumpster inside the map.
Representative frame: 443,916 triangles / 1,532 draws (previous 411,538 / 1,585).
This is not a low-end GPU benchmark or a long multiplayer soak test.
