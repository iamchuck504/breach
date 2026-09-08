# Combat prototypes — 2026-09-07

## Playtest

- Frag pickups are enabled in Fortaleza, Azoteas and Calle Cerrada: two clear-floor pickup locations per map, each holding **2** grenades. They are not an initial-loadout item.
- Manually exchange the equipment/up slot using the displayed interaction binding. Owning frag already allows automatic partial ammo collection, capped at **2**; remaining units stay in the pickup. Empty pickups refill after 45 seconds while the round is active.
- Stun is deliberately absent from the normal sniper/bazooka rotation. For an offline playtest use `?combatPrototype=1` (Practice or VS Bots). It replaces the pistol/down slot manually. For an online test server set `BREACH_EXPERIMENTAL_STUN=1`; the server decides whether the pickup exists. A client URL cannot enable it on a normal server.
- Stun has 4 shots, no reserve or crate refill, 40 RPM, 36 m/s projectiles and 50 m range. Empty stun can be manually replenished from its experimental pickup. Death restores the normal loadout; experimental weapons are not turned into ordinary weapon drops.
- Tuning lives in `src/config/tuning.js`: stun duration **3 s**, post-stun immunity **2 s**. Repeated hits cannot refresh either timer. Friendly targets and spawn-protected targets are excluded.

## Blast behavior

Both weapons use the same continuous smooth falloff and seven weighted body visibility samples against collision geometry. Crouched bodies use lower samples. Full obstruction gives zero damage; partial visibility reduces it. Faraway actors are rejected before ray tests.

| | Frag | Bazooka |
| --- | --- | --- |
| Maximum splash | 110 | 115 |
| Core radius | 0.6 m | 0.8 m |
| Outer radius | 3.3 m | 4.2 m |
| Direct-hit damage | — | 180 |
| Self-damage factor | 100% | 85% |
| Fuse | 2.4 s | Contact |

Damage reaches **zero at the outer boundary**, replacing the old 25% minimum rocket splash. Existing contextual death reactions distinguish close/direct rocket destruction from edge kills; lethal core frag damage can produce partial dismemberment. No projectile or damage ray is allowed to bypass a wall.

Development-only `?combatPrototype=1&blastDebug=1` displays the last explosion's core/high/outer wireframes and per-target visibility/raw damage for two seconds. Raw debug damage is before team/protection policy and is not a promise of lethality. This display cannot be enabled in a production build.

## Authority and lifecycle

`CombatPrototypes` runs locally for offline modes and only on the server online. Pickup claims consume shared units synchronously; origins, ownership, ammo, cooldown, distance and LOS are checked. Clients render bounded snapshots, not their own stun verdicts. Projectiles have bounded substeps and a global cap of 48.

The server clock owns stun duration; timer expiry does not depend on counting nominal ticks. Stun blocks movement and combat messages; the client cancels weapon gestures, zoom, evade/mantle and pending shots while keeping a valid cover anchor. Gravity continues. Bots and practice dummies suspend their movement/combat and show the same small electrical reaction. Death, round end and teardown remove temporary effects and status.

## Cover audit

- Fortaleza: no matching projecting storefront facade case in the sampled active-map facade audit; collision/layout untouched.
- Azoteas: two hut structures needed clearance for the equipped character silhouette. Only their eight reachable outer cover faces receive a 0.82 m stand-off. Their overlapping inner high blocker is not used as the cover surface. Eight full-rig checks pass, with at least 7.9 cm clearance to the decorative envelope.
- Calle Cerrada: the existing six storefront-strip corrections remain intact. All 48 sampled unblocked storefront poses retain positive clearance. Side-alley props detected by the audit are not automatically classified as storefronts and were not given a global offset.
- Collision volumes, bullet blocking and navigation geometry were not enlarged.

## Verification

- `npm test`: full existing regression suite passed (build, controller/Steam input, menus, reload/melee, aim/reticle/camera, cover, impacts, audio, i18n, weapons, pickups, bots, authority, respawn/spectator, map collision).
- `npm run check:combat-prototypes`: pure rules plus two-client server and browser tests. Browser portion uses the running dev server on port 5200.
- `npm run check:storefront-cover` and `npm run check:rooftop-cover`: actual rig/controller clearance and unchanged structural colliders.
- New checks cover capacity/partial and competing claims, launch/fuse, replicated grenade explosion, continuous falloff, full/partial occlusion, direct/self damage, finite practice ammo, stun duration, repeated hits/immunity, wall-blocked stun projectile, frozen target, death/round cleanup.

These are automated local playtests, not an Internet-latency soak test or final competitive balance approval. The stun remains experimental for that reason. Existing large-bundle build warning remains.
