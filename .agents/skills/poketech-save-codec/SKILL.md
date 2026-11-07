---
name: poketech-save-codec
description: Implement the save seam for a PokeTech game pack - save format identity, validation, normalization and repair, version migration, raw export and import. Use when wiring a new game's saves, when saves fail to load or are rejected, when a pack update changes saved data, or when migrating legacy Emerald storage keys.
---

# Save codec

The codec only converts and validates bytes. The shared store owns keys, profiles, locks,
flushing and the switch gate.

Contract:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md#4-savecodec)
and [save namespacing](../../../docs/game-packs/manifest-and-contracts.md#save-namespacing).
Emerald's current behaviour:
[docs/game-packs/games/emerald.md](../../../docs/game-packs/games/emerald.md#save-seam-current-implementation).

## Current state

Emerald's codec is extracted to
`pokeemerald-3d/web/packs/shared/save-codec-emerald.mjs`: flash constants, sector
checksums, two legacy layout migrations and a stale-bag encryption repair.
`pokeemerald-3d/web/save-store.mjs` owns namespaced records
(`pokeemerald.save.v2/<gameId>/<formatId>/<version>/<profile>/main`), one-way legacy
migration, flush gating and quota reporting. Locks use `pokeemerald.save-profile:` with the
canonical record key. The 4-client presence E2E reports the new keys; migration and
isolation have unit coverage.

## Rules that prevent data loss

1. **Never overwrite a destination record.** If it exists, it wins.
2. **Never delete the legacy key automatically.** Keep it as recovery material.
3. **Never guess a format from byte size alone.** Emerald-shaped saves from different hacks
   can be the same length and incompatible.
4. **Migration is one-way.** Record completion; do not keep dual-writing.
5. **Validate before normalize.** Repair only known-bad patterns, and document each one.
6. **A failed migration returns `null`.** Offer the original bytes for export instead of
   writing something plausible.

## Procedure

1. Obtain a real save from the reference build. Record its size and digest.
2. Identify the format: sectoring, signatures, checksum algorithm, block sizes, encryption.
   If any of these differ from Emerald, it is a new `formatId`.
3. Implement `validate` first, with precise reasons.
4. Add `normalize` only for byte patterns you have actually observed from earlier PokeTech
   builds. Each rule needs a fixture.
5. Add `migrate` for older versions of this format, in order, with tests.
6. Implement export as a byte-for-byte pass-through unless the game requires a header.
7. Confirm the shared store locks the profile before boot and awaits a write before a game
   switch.
8. Test the legacy Emerald migration under both old and new locks, including a conflicting
   destination.

## Fixtures to keep

- Empty / never-saved.
- Fresh save from the reference build.
- Save with a full party, items and a completed event flag.
- Each legacy layout the codec claims to migrate.
- A deliberately corrupt sector (bad checksum).
- A wrong-size file.

Fixtures live with the pack, are small, and contain no personal player data.

## Cross-game checklist

- [ ] Two games with the same profile name do not see each other's saves.
- [ ] Same game, two tabs: second is blocked before reading or writing.
- [ ] Cache deletion does not delete saves.
- [ ] Export/import round-trips and rejects wrong sizes with a useful message.
- [ ] Update with a compatible format preserves progress.
- [ ] Update with an incompatible format either migrates or fails visibly.
- [ ] A failed flush blocks the game switch.

## Stop conditions

- The format cannot be validated with available information: treat it as opaque bytes,
  refuse to normalize, and say so.
- Repair rules would change legitimate saves: remove them.
- Migration would require the game itself to re-save (post-load fixups): document the
  behaviour instead of fabricating bytes.

## Evidence

Fixture list, test names and results, and a recorded migration run showing before/after
digests and the untouched legacy key.
