---
name: poketech-runtime-adapter
description: Implement the runtime seam for a PokeTech game pack - module loading, imports and shims, ABI and export validation, frame stepping, input masking, suspend and disposal. Use when booting a new game build in the browser, extracting Emerald's runtime code out of the shell, fixing boot or export errors, or making frame stepping deterministic for tests.
---

# Runtime adapter

Owns the engine lifecycle. Everything else in a pack assumes this works.

Contract:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md#2-runtimeadapter).
Current Emerald implementation to preserve:
[docs/game-packs/games/emerald.md](../../../docs/game-packs/games/emerald.md#runtime-seam-current-implementation).

## Current state

The shared WASM runtime helpers now live in
`pokeemerald-3d/web/packs/shared/runtime-wasm.mjs`: module loading/caching, the explicit
BIOS/graphics import map, and signed memory helpers. The app resolves the module URL from
the selected pack manifest, but `boot()`, `tick()`, `runFrames()`, ABI validation and the
disposal path still live in `pokeemerald-3d/web/app.js`. Extraction is foundation work,
not pack work.

## What the adapter owns

- Fetching and compiling the module resource (shared loader does fetching; the adapter
  declares what it needs).
- Building the import object, including WASM shims for BIOS/graphics helpers.
- Validating required exports and ABI version before gameplay starts.
- `AgbMain()` plus the per-frame step.
- Input: writing the 10-bit mask the engine reads.
- Suspend and dispose: no timers, listeners or network activity left behind.

It does **not** own: save storage, network connections, the presenter, DOM chrome, or
game-specific state readers (those belong to the world/rules seams).

## Procedure

1. Build the module and list its imports and exports. Use the real artifact:
   `WebAssembly.Module.imports()` / `.exports()`.
2. Group imports: implemented shims, intentionally unused stubs, and anything that must
   fail loudly. A silent `return 0` for an unknown import hides bugs; keep the current
   Emerald stub list explicit rather than a blanket default for new games.
3. Record `abiVersion`, `requiredExports` and `optionalExports` in the manifest.
4. Implement boot: instantiate, validate, initialise shared systems, then start the loop.
5. Implement step so one call equals one emulated game frame regardless of display rate.
6. Keep the automation surface working: `window.pokeemerald` with instance, memory and
   frame stepping, plus `?automate=1`. Replay tooling depends on it.
7. Implement suspend for a save flush and dispose for a game switch.
8. Test boot failure paths: missing export, wrong ABI, digest mismatch, memory too small.

## Source-fork notes

- Add WASM glue at the boundary: build flags, `#if WASM` guards, shims under
  `include/wasm/`, generators under `tools/`.
- Do not rewrite gameplay logic to make the port compile. Follow
  `pokeemerald-3d/AGENTS.md`.
- Record every deviation from the fork's own build in the pack README.
- Reuse Emerald's generators only where the fork's data still matches their assumptions;
  verify with a real map and a real battle, not a single asset.

## Determinism checklist

- [ ] Same inputs produce the same frame sequence.
- [ ] Stepping does not depend on `requestAnimationFrame` count.
- [ ] No `Date.now()` or wall-clock dependence inside a step.
- [ ] Input is cleared at the right boundary (Emerald clears after `runFrames`).
- [ ] Speed and unlimited mode still route through the same step function.

## Stop conditions

- The engine needs heap growth beyond the declared memory: fix the linkage or declare the
  limit; do not silently raise it per game.
- A required import has no honest implementation: report it as a blocker.
- Boot only works with a specific browser quirk: document it, do not paper over it.

## Evidence

Boot log, export/import inventory, a deterministic replay run, and the failure-path
messages you actually saw.
