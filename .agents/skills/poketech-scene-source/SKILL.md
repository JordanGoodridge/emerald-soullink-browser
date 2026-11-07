---
name: poketech-scene-source
description: Implement the scene seam for a PokeTech game pack - deciding between HD-2D and classic presentation, mapping engine framebuffer or scene buffers into the shared presenter, and keeping view settings and presence composition working. Use when a new game renders incorrectly, shows a black screen, needs classic-only mode, or when extracting Emerald's render wiring out of the shell.
---

# Scene source

Answers one question: **what does the presenter draw this frame, in which declared
format?**

Contract:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md#3-scenesource).
Emerald's current buffers and modes:
[docs/game-packs/games/emerald.md](../../../docs/game-packs/games/emerald.md#scene-seam-current-implementation).

## Current state

Emerald's buffer mapping is extracted to
`pokeemerald-3d/web/packs/shared/scene-emerald.mjs`: `createEmeraldFrame()` builds the
typed display/world/object/screen-effect views for one frame, and
`emeraldPresenterOptions()` supplies the presenter dimensions. The HD-2D/classic render
calls and human/remote composition still live in `pokeemerald-3d/web/app.js`; the
presenter remains shared. The pack scene adapter is a thin delegate.

## Two legitimate starting points

- **`hd2d`** — only if the build can produce the Emerald scene buffers with compatible
  meaning. This is a high bar: ground geometry, heights, receivers, facades, layer and
  object ordering.
- **`classic`** — a scaled framebuffer. Honest, lower fidelity, still playable. Most new
  games start here.

Never invent HD-2D data from a flat framebuffer. Guessing geometry produces broken depth
and misleading screenshots.

## Procedure

1. Render one frame of the game with the simplest possible path and confirm pixels arrive.
2. Decide the format from what the engine actually exposes, not from what the game looks
   like.
3. Declare `rendering.modes`, `defaultMode` and `sceneFormat` in the manifest.
4. Hand the presenter current-frame views only. Buffers are borrowed; do not retain them
   across frames.
5. Keep presentation mode switching in shared UI. The pack does not own the control.
6. Keep the presenter free of game IDs. If it needs game knowledge, the seam is wrong.
7. Verify presence composition still works if the pack claims presence: remote actors are
   placed from world coordinates, never camera-space pixels.

## Mapping checklist

- [ ] Logical size matches the manifest.
- [ ] Correct buffer for the selected mode, every frame.
- [ ] No stale buffers after a mode switch or presenter recreation.
- [ ] No buffer retained beyond the frame.
- [ ] Background priority and sprite priority still meaningful (if HD-2D).
- [ ] Screen effects path does not read engine memory it does not own.
- [ ] Remote avatar draw range is cleared when there are no actors.
- [ ] Presenter device loss recovers without losing game state.

## Common failures

| Symptom | Likely cause |
|---|---|
| Black screen, game runs | Wrong buffer, zero size, or mode declared but not produced |
| Flicker on mode switch | Buffers captured before the frame completed |
| Depth looks wrong | Fabricated HD-2D data or mismatched scene format |
| Remote avatars drift | Camera offset applied twice, or world coordinates misused |
| Crash after device loss | Presenter recreated but scene handles cached |

## Stop conditions

- The engine's presentation is stateful in a way the current frame model cannot express:
  document it and consider classic-only before redesigning the presenter.
- HD-2D parity would require rewriting the engine's renderer: that is a separate project,
  not a seam fill.

## Evidence

Screenshots of field, menu and battle in every declared mode, plus a mode-switch sequence
and one presence frame with a remote actor.
