---
name: poketech-run-adapter
description: Implement the per-game RunAdapter for PokeTech Nuzlocke/SoulLink, randomizer, level caps, quick-start and route tracking. Use whenever a game pack adds run modes, encounter-area mapping, capture/faint/revive hooks, randomized encounters/trainers, gym caps, gifts/starters or run-tracker map data—even when the shared run core already exists.
---

# PokeTech run adapter

The run system has two layers: shared policy in `pokeemerald-3d/web/run/`, and game facts/interception in `game-packs/<id>/adapter/run.mjs` plus the existing rules adapter. Never copy the shared reducer, run socket, tracker model or randomizer into a pack. Implement the adapter for the selected game and prove each declared capability.

Read:

- [SoulLink implementation and current capability status](../../../docs/soul-link.md)
- [Run and rules seam contracts](../../../docs/game-packs/manifest-and-contracts.md)
- [Rules adapter procedure](../poketech-rules-adapter/SKILL.md)
- [Pack conformance gates](../poketech-pack-conformance/SKILL.md)

## Adapter responsibilities

Implement `adapter/run.mjs` facts for only the selected pack:

- Stable area identity and readable label. Use the same identity as the visible world/map; don't assume map numbers are globally unique or use camera/render coordinates.
- Encounter method/slot semantics; static, starter, gift and egg keys when supported.
- Region section/map layout resource and section lookup; use generated source data when possible.
- Species eligibility/table and trainer category (regular, gym, Elite Four, Champion/boss).
- Gym ace progression, level-cap facts, quick-start table/macro, save slot, and precedence with game-owned rules.
- Explicit engine hook support and capability declarations.

Keep Emerald-specific IDs, flag values, trainer IDs, species lists and map coordinates in its adapter/generated data or WASM accessors, never in shared policy.

## Enforcement levels

- `enforce`: a synchronous pre-action gate or safe-point mutation is present and tested.
- `observe`: event is reported after the fact only; never present it as enforcement.
- `none`: unavailable or unverified.

SoulLink cannot be claimed if encounter/capture enforcement is absent. A blocked capture must not spend a ball, set caught Pokédex state, or partially add the Pokémon. Faint/death requires a safe point that runs before healing and covers party and PC storage. Test revive, reload and box paths.

## Randomizer policy for this product

The requested Emerald mode is **unrestricted true random**: any eligible species (including legends) can replace any supported wild/trainer/gym/boss/starter species. Preserve the authored level. Do not silently add BST similarity, type/theme, evolution-stage, legendary bans, or stat scaling. The shared randomizer is deterministic by seed/context; pack adapters supply current build species data and trainer categories.

If a future game has different species availability or trainer structures, supply its data and classification. Do not claim that Emerald's random pool applies to that game.

## Quick-start and caps

- Quick-start data is per pack. Prefer a verified post-intro state table; use a recorded macro only as a documented fallback. Verify start map, player, starter, Pokédex, items and valid save after reload.
- The current Emerald rule uses next undefeated Gym Leader ace as cap. A pack may use different gym progression but must state it explicitly.
- Rare Candy quantity/refill and Candy cap are separate claims. Prove the cap applies to the target Pokémon and cannot exceed the highest living party level or the pack's current ace cap.

## Conformance evidence

Before setting any manifest capability above `none`, provide:

1. Hook inventory: actual timing and source call sites for encounter, capture, faint, revive, EXP/Candy and gifts.
2. Area mapping coverage: representative routes, caves, water, submaps/instances and starter/gift cases.
3. Tests for no-ball-consumption capture block; dupe/species-clause skip; area void releases all caught linked members; faint safe-point release; Center/revive/PC/reload bypasses.
4. Randomizer tests for every declared encounter/trainer class and preservation of authored levels/party size.
5. Quick-start/restart/save isolation evidence, including a run save distinct from the standard save.
6. 2–4-client E2E for run state/reconnect/readiness/deaths, plus tracker model checks.
7. Game-owned-vs-PokeTech precedence and honest limitations.

If a hook or path cannot be proven, keep that capability at `observe` or `none`; do not patch around missing evidence with a shell game-ID branch.
