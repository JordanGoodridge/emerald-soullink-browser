---
name: poketech-pack-ui
description: Add game-specific UI to a PokeTech game pack without branching the shared shell - panels, actions, run summaries or settings gated by declared capabilities. Use when a new game needs its own controls or readouts, when the shell starts accumulating game-specific conditionals, or when deciding whether something belongs in the pack or the shared UI.
---

# Pack UI

The last seam, and the easiest one to abuse. Its purpose is to keep game-specific extras
out of the shared shell, not to let each pack invent a UI framework.

Contract:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md#8-packui).

## Current state

Nothing exists. Emerald has no pack UI; all controls are shared and hardcoded in
`pokeemerald-3d/web/index.html` and `web/app.js`.

## Decide before writing

Ask in this order:

1. **Does the shared UI already cover it?** Save profiles, speed, render scale, view mode,
   fullscreen and presence all do. Do not duplicate them.
2. **Is it a capability toggle?** Then it belongs in shared settings, hidden by capability.
3. **Is it genuinely game-specific?** A run seed, a route summary, a game's own menu
   shortcut. Then it is pack UI.

If more than one pack would need the same panel, it is shared UI with a capability gate.

## Rules

- Panels are declared as descriptors; the shared shell renders them with shared components.
- Every panel is gated by a manifest capability. No capability, no panel.
- No pack may import another pack, write another pack's saves or read another pack's state.
- Pack UI reads through the same accessors as the other seams. It does not poke memory
  directly or hold live views.
- Accessibility, keyboard focus and mobile layout are shell responsibilities; the pack
  supplies content, not markup conventions.
- Nothing in pack UI may mutate save bytes except through the shared store.

## Procedure

1. Confirm the need is not already covered by shared UI or a capability toggle.
2. Add the capability to the manifest and to the shell's capability checks.
3. Define the descriptor: ID, title, fields, read-only or action, and the data source.
4. Implement the data source on the pack adapter, returning plain values.
5. Verify it disappears cleanly when the capability is absent.
6. Confirm a second pack could not accidentally show it.

## Stop conditions

- The panel starts encoding game rules: that belongs in the rules seam.
- The panel needs a new shared component per game: raise it as a shell change instead.
- The panel only exists to expose internals for debugging: use diagnostics, not product UI.

## Evidence

Screenshots with the capability on and off, plus confirmation that other packs render
without it.
