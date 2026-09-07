# Map decoration refresh — 2026-09-07

Editable Blender 5.2 sources and exported GLBs use Breach's existing `urban-assets` cache, cloning and disposal pipeline. No second loader or collision representation was introduced.

## Rebuild

1. Run the development server on port 5200.
2. `node scripts/export-visual-assets.mjs` exports the original decoration through GLTFExporter to `input/` and renders the six real weapon models into HUD PNGs.
3. Run Blender in background with `--python art/map-refresh/refine.py` from this repository. The script resolves paths relative to itself.
4. `npm run build`.

The input snapshots intentionally bypass the refined decoration so a second export does not recursively bake the output back into itself. Original procedural methods remain a loading-failure fallback. The `.blend` sources are unbatched and include packed textures; export joins compatible material groups. World transforms and UVs are retained.

## Outputs

- `refined-metro`: original train/station decoration, softened construction edges, end glazing, gaskets, wipers, maintenance panels and ticket slots.
- `refined-prision`: original prison decoration, watch-cabin glazing/mullions and cell lock housings.
- `refined-pueblo`: original ruins decoration, softened eligible pieces and timber boards attached to existing openings.
- `refined-roof-tank`: reservoir body, rolled bands, conical cap, inspection hatch and support shoes. Original functional envelope, approximately 2.2 m wide by 2.1 m tall.

Scale follows existing world meters and structural envelopes; no character, collider, cover or navigation dimensions were changed. These are targeted refinements, not complete architectural rebuilds of the inactive maps. See `VISUAL-UX-REPORT.md` for remaining limitations.
