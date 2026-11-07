---
name: poketech-pack-conformance
description: Verify that a PokeTech game pack actually satisfies the seam contracts before it is called supported - per-seam checks, two-game isolation, save migration, cache and packaging, and honest evidence. Use when finishing a port, reviewing a pack, changing shared shell code, or deciding whether a game can be listed as supported.
---

# Pack conformance

The seatbelt for the seam model. Any pack can look fine until a second pack exists, a save
migrates, or a cache is cold. This skill defines the checks that make "a fixed set of
hookup points" a test result instead of a hope.

Related: [onboarding](../../../docs/game-packs/onboarding.md),
[integration approaches](../../../docs/game-packs/integration-approaches.md).

## Current state — do not invent commands

`node tools/validate_game_packs.mjs` validates the checked-in index/manifests, adapter
paths and evidence links. `node tools/build_game_packs.mjs` assembles versioned packs with
real digests, and `node tools/validate_packaged_packs.mjs` verifies the packaged dist.
Pack schema/loader/save-store/scene/world tests exist under `pokeemerald-3d/web/`. A hidden
`test-emerald` fixture boots the reference module under a second save namespace. The
existing 4-client presence E2E passes against Emerald with canonical save keys. A full
two-game selector/switch E2E is still planned.

Runnable today:

```text
node tools/validate_game_packs.mjs
node --test pokeemerald-3d/web/packs/*.test.mjs pokeemerald-3d/web/packs/shared/*.test.mjs
node --test pokeemerald-3d/web/save-store.test.mjs
node deploy/build-dist.mjs
node tools/validate_packaged_packs.mjs
```

Planned gate shape:

```text
node tools/game_packs_e2e.mjs --no-build
```

## Per-seam conformance

Each seam has one shared test file that every pack runs against its own adapter. The test
owns the contract; the pack supplies fixtures.

| Seam | What the shared test asserts |
|---|---|
| Manifest | Schema validity, ID matches directory, capabilities agree with sections, every evidence link exists |
| Runtime | Required exports present, ABI matches, boot reaches a frame, one step equals one frame, dispose leaves no timers or sockets |
| Scene | Declared modes only, buffers valid for the frame, no retention across frames, mode switch does not present stale data |
| Saves | Validate/normalize/migrate on fixtures, export round-trip, corrupt and wrong-size rejection, no overwrite of existing destination |
| World | Footpoint correctness, epoch increments on the listed events, invalid state fails closed, `worldKey` stable and collision-free |
| Presence | Two clients see each other on a compatible world, incompatible content rejected, unsupported area hides actors |
| Rules | Gates block only where safe, observations are idempotent, unsupported clauses absent |
| Run | 2–4 member links, encounter/dupe clauses, area-void releases, shared death at safe point, all-ready reset, randomizer species/level contract, level/Candy cap, quick-start/save isolation, tracker map coverage |
| UI | Panels appear only with the capability and disappear cleanly |

A capability without a passing test is reported as unproven, not as working.

## Cross-pack checks

These cannot be done with one game installed:

1. **Isolation** — install two games, use the same profile label, confirm separate records
   and separate locks. A second tab on the same game/profile is blocked.
2. **Selection** — a bad game ID, a digest mismatch and an unknown schema version each
   produce a named error, not Emerald.
3. **Switch** — leaving game A flushes its save, leaves its presence room and discards
   resume state before game B boots.
4. **Laziness** — loading game A downloads none of game B's resources.
5. **Cache** — cold load, warm load, cancelled load, partial download, quota failure, and a
   failed update that leaves the previous release selectable.
6. **Cache versus saves** — clearing assets never deletes a save.
7. **Packaging** — the packaged artifact loads with no repository-root dependencies and no
   missing modules.

The last one currently fails for Emerald: `pokeemerald-3d/tools/build_wrangler_site.mjs`
copies only five files while the page imports presence modules, save-profile modules and
avatar PNGs. Verify before trusting any deployment.

## Evidence format

Record, per check:

```text
check: <seam or cross-pack check>
result: pass | fail | unverified
command: <exact command>
artifact: <screenshot, summary.json, digest, log path>
notes: <limitations, environment, flakiness>
```

Rules:

- `unverified` is a valid result. Never infer a pass from a related pass.
- A pass on one map, one battle and one save is not a pass for the game.
- Behaviour claims need the reference build's digest next to them.
- Report counts where they exist (`63 browser tests`, `27 server tests`) rather than
  "tests pass".

## Review order for a finished pack

1. Reference build digest and pinned source.
2. Manifest and capabilities.
3. Boot and deterministic step.
4. Scene in every declared mode.
5. Save fixtures and migration.
6. World identity and one two-client session.
7. Rules level, if any.
8. Cross-pack checks.
9. Deployment artifact.
10. Known limits written down.

## Stop conditions

- Any declared capability fails or is unverified: lower the capability or delay "supported".
- Isolation fails: stop; a shared save namespace can destroy user progress.
- Packaging is incomplete: the pack works in development and is not shippable.
- Evidence depends on a mutable branch or "latest": pin it, then re-test.
