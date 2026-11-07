---
name: poketech-rules-adapter
description: Design and implement the rules seam for a PokeTech game pack - Nuzlocke observation versus enforcement, synchronous gates for captures, faints and encounters, area mapping and precedence with a hack's own rules. Use when adding Nuzlocke support to a game, when a rule cannot be enforced from outside the engine, or when a hack already modifies fainting, items or encounters.
---

# Rules adapter

Milestone 3 work layered on a pack. The rule engine is future implementation; this seam is
how a game proves it can be observed or enforced.

Contract:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md#7-rulesadapter).
Milestone scope: [docs/milestone-3-nuzlocke.md](../../../docs/milestone-3-nuzlocke.md).

## Current state

Shared run policy, deterministic randomizer, tracker model and Emerald run adapter are
implemented. The Emerald manifest declares `run.support: enforce` for `soullink` only,
based on blocked-capture/no-consumption, safe-point party/PC release, Gym/Candy/EXP,
quick-start and four-client E2E evidence. Its separate Nuzlocke/rules claim remains
`none`; other packs remain unsupported. Never infer support from the shared core alone.

Use [`poketech-run-adapter`](../poketech-run-adapter/SKILL.md) for pack-specific area,
randomizer, quick-start, cap and tracker facts. This skill remains authoritative for
actual interception timing, safe gates, and `observe` versus `enforce`.

## Two levels, never blurred

- **`observe`** — events are reported after the fact. The engine may log a capture or a
  faint, but cannot block anything. Present it as tracking, never as enforcement.
- **`enforce`** — synchronous gates run before the action and may return `block`. Requires
  a real interception point, not a post-frame check.

If the only available point is after the fact, the honest answer is `observe`.

## Procedure

1. Identify the engine's actual decision points: encounter start, capture attempt result,
   faint resolution, party/box mutation, healing, save load.
2. For each, decide whether a synchronous pre-action point exists. Record why.
3. Implement observations first, with stable event IDs so duplicates are idempotent.
4. Add a gate only where blocking is safe: a blocked action must leave the game in a
   consistent state, not half-applied.
5. Bind area identity to the world model's world key so encounters are attributed to the
   same area a player sees.
6. Map clauses to real actions. Unsupported clauses must be absent, not silently ignored.
7. Test the bypass paths: reload, healing, box deposit, trade, day care, scripted gifts.

## Enforcement checklist

- [ ] A fainted Pokémon cannot be restored by healing, reload or PC operations.
- [ ] A blocked capture leaves no partial state (no ball consumed, no Pokédex entry).
- [ ] Area attribution matches the visible map, including instance areas.
- [ ] Duplicate events do not double-count.
- [ ] The event log explains every death and capture with an engine-sourced reason.
- [ ] Disabling the run restores normal behaviour without corrupted saves.

## Precedence with the hack's own rules

Some targets already change the rules — Kaizo removes battle items and EV gain, Run & Bun
enforces level caps, Rogue has its own run structure. A PokeTech Nuzlocke layer must not
contradict them silently. Decide explicitly, per pack:

1. Which rules come from the game and are left alone.
2. Which rules PokeTech adds.
3. Which conflict, and which wins.

Write that table in the pack README. If the game already owns "run state" (as a roguelike
might), treat its model as authoritative instead of layering a second one.

## Stop conditions

- No safe synchronous interception exists: declare `observe`, or `none`.
- A rule would require editing gameplay source beyond a narrow guarded hook: escalate; do
  not fork the engine as a side effect of a pack.
- Saves would need a new format to hold run state and no migration exists: stop and design
  the format before shipping the feature.

## Evidence

Hook inventory with timing, tests for each blocked path, a run log excerpt, and the
precedence table.
