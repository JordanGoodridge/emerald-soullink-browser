---
name: poketech-game-port
description: Plan and execute bringing a new Emerald-family game or ROM hack into PokeTech as a game pack by filling a fixed set of integration seams. Use whenever the user wants to add, port, swap, or support another Pokémon game (Emerald Rogue, Kaizo, Run & Bun, other decomp hacks), asks where a new game hooks into the shell, or asks how to make game selection work — even if they never say "game pack".
---

# PokeTech game port (umbrella)

A port is not "replace the WASM URL". It is filling a known set of seams so the shared
shell keeps working unchanged.

Read [docs/game-packs/README.md](../../../docs/game-packs/README.md) first. The normative
seam shapes are in
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md).
The shared multi-game architecture, P0/P1/P2 scope, 2B link-spike coexistence and interior
contract are in
[docs/game-packs/architecture-redesign.md](../../../docs/game-packs/architecture-redesign.md).

## Current state — read this before planning

**Foundation in progress.** `game-packs/index.json`, the manifest schema/validator, the
registry, the loader, the shared game selector, the namespaced save store, the Emerald
save codec and the shared runtime/scene/world helpers exist. Pack-aware packaging and
digest validation exist. The composition root still contains the render/presence
composition, and the pack adapters are deliberately thin placeholders until the remaining
wiring lands. There is still no second real game build (only a hidden test fixture).

So there are two kinds of tasks:

1. **Foundation work** — finish extracting the seams and wire the pack adapters without
   changing Emerald behaviour.
2. **Pack work** — after the foundation exists, add a game by filling the seams.

Do not write code that calls loader APIs from the specs as if they exist. If the task
needs one, build it as part of the task and say so.

## The seams

| # | Seam | Skill | Required |
|---|---|---|---|
| 1 | Manifest | `poketech-pack-manifest` | always |
| 2 | Runtime adapter | `poketech-runtime-adapter` | always |
| 3 | Scene source | `poketech-scene-source` | always |
| 4 | Save codec | `poketech-save-codec` | always |
| 5 | World model | `poketech-world-model` | when presence or area rules are claimed |
| 6 | Presence adapter | `poketech-presence-adapter` | optional |
| 7 | Rules adapter | `poketech-rules-adapter` | optional |
| 8 | Pack UI | `poketech-pack-ui` | optional |
| 9 | Run adapter | `poketech-run-adapter` | required only when claiming Nuzlocke/SoulLink, randomizer, quick-start or route-tracker support |
| — | Verification | `poketech-pack-conformance` | before calling it supported |

Skills live in `.agents/skills/<name>/SKILL.md`.

## Order of work

1. Pin the target and its inputs; write `docs/game-packs/games/<id>.md` from the existing
   target template.
2. Get the game building as WASM and reaching a stable first frame. Nothing else is
   meaningful before this.
3. Manifest, then runtime, then scene, then saves. Each constrains the next.
4. World model only after the game actually runs and you can observe its state.
5. Presence, rules and pack UI last, each gated by a declared capability.
6. Verify before claiming support.

## Invariants that apply to every seam

- **No shell branch on game ID.** If the shell needs to know which game is running, the
  seam set is incomplete.
- **Capabilities are claims.** Declaring `hd2d`, presence or rules means it was
  demonstrated. Undeclared is better than overstated.
- **No baked addresses or map IDs in shared code.** They belong in the pack adapter or
  generated data.
- **Generated artifacts stay out of git.** Digests, symbol maps and ABI metadata are build
  outputs.
- **Fail closed.** A missing export or unverifiable world must hide the feature, not guess.
- **Preserve what works.** Emerald's automation API, save repairs and presence behaviour
  are existing contracts; extraction must not silently change them.
- **Reload to switch.** The engine holds a fixed 256 MiB of WASM memory; release it rather
  than keeping multiple engines alive.

## Choosing the integration approach

Use [docs/game-packs/integration-approaches.md](../../../docs/game-packs/integration-approaches.md).
Do not rank approaches by reputation or assume a difficulty. Either cite measured evidence
or record the approach as unverified.

A target may mix approaches (for example: reconstruction for content, shared engine
components for systems).

## Definition of done

A reproducible pinned build; every declared capability demonstrated; save isolation and
migration verified; reference-build comparison recorded including mismatches; presence
identity verified or explicitly unsupported per area class; deployment artifact validated;
known limits written down.

"Boots to the title screen" is step 2, not done.

## Stop conditions

Stop and re-plan when:

- the game requires a second shell or a parallel save system;
- a seam cannot express the game's behaviour without leaking game specifics into shared
  code;
- a capability can only be claimed by guessing;
- the reference build cannot be obtained, so no comparison is possible.

Report the blocker instead of approximating it.
