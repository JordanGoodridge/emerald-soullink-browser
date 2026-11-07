---
name: poketech-world-model
description: Implement the world seam for a PokeTech game pack - map and instance identity, ground-footpoint coordinates, activity classification, and epoch fencing for saves, warps and world resets. Use when wiring a new game's overworld readings, when presence shows the wrong map or position, when procedural or generated areas must be excluded, or when extracting Emerald's presence adapter.
---

# World model

Supplies read-only world readings to presence and future area-based rules. It never
writes gameplay or save data.

Semantics are owned by [docs/multiplayer-contracts.md](../../../docs/multiplayer-contracts.md).
Do not redefine coordinates, epochs or visibility here or in the pack.

Contract:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md#5-worldmodel).

## Current state

Emerald's C reader is `src/wasm_presence.c`; the JS model is extracted to
`web/packs/shared/world-emerald.mjs` and re-exported by
`web/presence/game-adapter.mjs` for compatibility. It reads typed exports
(`WasmPresence*`), integrates sub-tile movement, and marks secret-base instances
`variant: 'dynamic'`. `createEmeraldWorldModel({ appearanceFor })` now accepts a pack
appearance mapping; the default remains Brendan/May by gender.

## Non-negotiables

- **Publish the ground footpoint**, `(16*x + 8, 16*y + 16)` for tile `(x, y)`. Never camera
  space, never sprite centre.
- **World identity is exact**: map group, map number, layout and variant all participate.
  `layoutId` is a content identifier, not an address.
- **Epochs fence history**: increment on warp, layout or variant change, teleport, save
  load, new game, world reset, and validity loss followed by restoration. Never reset an
  epoch inside a connected session generation.
- **Fail closed**: unknown state means `activity: 'unsupported'`, `pose: null`, while the
  member stays on the roster.

## Procedure

1. Inventory what the build can actually answer: map identity, tile position, sub-tile
   movement, facing, motion, animation frame, elevation, jump height, player appearance.
2. Prefer typed accessors over raw addresses. A symbol map alone does not establish struct
   layouts or when it is safe to read them.
3. Implement `sample()` to return an owned snapshot, never a live memory view.
4. Implement `worldKey()` so that two players on the same world produce the same string —
   and two different worlds never collide.
5. Classify activity from engine state, not from a UI or scene flag alone.
6. Map appearances from data supplied by the manifest, not from a hardcoded list.
7. Test: standing, mid-step, warp, save load, invalid state, and a generated instance.

## Instance identity (the hard case)

Procedural and instanced areas — Rogue-style runs, secret bases, dynamic rooms — reuse map
IDs for different content. Options, in order of preference:

1. A stable instance identifier exists in engine state: include it in `worldKey`.
2. The instance can be derived deterministically from run state: include that, and version
   it, because changing the derivation changes compatibility.
3. Neither: declare the area class unsupported and hide remote actors there.

Never fall back to map ID alone for generated content. Two players in different runs would
appear to each other in the same place.

## Coordinate checklist

- [ ] Standing tile maps to the canonical footpoint.
- [ ] Mid-step position is smooth and resyncs on settle.
- [ ] Camera-clamped map edges do not shift wire coordinates.
- [ ] Jump height is separate from ground Y.
- [ ] Elevation is the discrete engine layer, not a pixel height.
- [ ] Large same-epoch displacement clears history rather than sliding.

## Stop conditions

- Required state can only be read at an unsafe moment (mid-transition, during a battle
  setup): return invalid instead of sampling early.
- The build exposes no reliable player identity: presence must be declared `none`.
- Instance identity is unknowable: mark those areas unsupported and say so in the pack
  README.

## Evidence

Unit tests for the adapter, a two-client screenshot on the same map, a warp sequence showing
epoch changes, and one deliberately unsupported area with no remote actor.
