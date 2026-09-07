# Gameplay tuning — 2026-09-06

## Changes
- Ground weapons: compatible ammo only on contact; primary replacement requires the bound cover/interact button. Prompt names both weapons. Partial claims leave remaining ammo in the drop, subject to its existing lifetime.
- Server validates ownership, distance, height, slot and expected replacement; ammo claims are serialized and capped against its authoritative remaining budget.
- Respawn: strict next 10-second boundary, anchored to the start of each round. Offline and online use the same boundary function. Reserved lives count toward round survival; no active-round processing after round end.
- Wheel: four unclipped panels, magazine/reserve counts, whole-panel red for empty, amber for reload, disabled empty slot. Existing single-instance 0.5-second timer retained.
- Cover: remove blindfire hold after input release, faster protective pose recovery, no buffered-fire exposure hold. Remote resting cover ignores trailing fire FX timers.
- Evasion: preserve displacement/cooldowns; sweep the player volume before selecting cover entry. Open-space dodge has compression/extension/recovery with both hands supporting the weapon; cover retains its feet-first slide and attachment.

## Passed
- `check-gameplay-tuning`: wave boundaries, reserved lives, ammo conservation/caps, special ammo exclusion, replacement policy, blocked/reachable cover selection.
- `check-gameplay-ui`: dry/reload visual states, manual pickup, partial ammo, reassigned keyboard/controller prompt labels, no page errors. Screenshots inspected under `artifacts/gameplay-tuning/`.
- `check-online-fire`: four WebSocket peers, two partial claims on one drop, duplicate manual replacement rejected, no automatic replacement, shared wave for two deaths, existing shot authority checks.
- `check-cover-fire`: low/high left/right/over release, return exposure below threshold within 150 ms, re-aim cancellation, existing railing and muzzle-clearance tests.
- `check-movement`, `check-round-flow`, `check-online-map-items`, `check-online-flow-authority`, `check-server-guards`, `check-weapon-wheel`, `check-i18n`, production build.

## Limits / deployment
- Automated checks do not replace a physical-controller playtest or latency/jitter stress session. The dodge's subjective animation feel still benefits from in-game review.
- Publish the client and restart/update the online server together: drop messages now carry ammo amounts and explicit replacement intent.
- Build retains the existing large-bundle warning.
