---
name: poketech-pack-manifest
description: Author, review or validate the manifest for a PokeTech game pack - identity, build provenance, runtime and ABI, resources, rendering modes, save format and capability claims. Use when adding or updating a game pack's manifest, declaring what a build supports, generating digests, or fixing a pack that fails to load or reports the wrong features.
---

# Pack manifest

The manifest is the only place the shell learns what a game is and what it may enable.
It contains data and references, never code.

Normative field tables and the Emerald example:
[docs/game-packs/manifest-and-contracts.md](../../../docs/game-packs/manifest-and-contracts.md).

## Current state

The schema and validator now exist in
`pokeemerald-3d/web/packs/manifest-schema.mjs`, with CLIs at
`tools/validate_game_packs.mjs` and `tools/validate_packaged_packs.mjs`. The Emerald
manifest is `game-packs/emerald/manifest.json`; it uses `pending` digests in source mode
until `tools/build_game_packs.mjs` writes real hashes into `pokeemerald-3d/dist`.

Use the schema and validator before filling a second pack. If a required field is missing,
extend the schema first rather than letting the second pack invent its own shape.

## Sections and what belongs in each

| Section | Fill from | Do not guess |
|---|---|---|
| `game` | Chosen stable ID, display title, pack release version | Do not reuse an ID for a different game |
| `build` | Pinned commit/tag or patch digest, real build command, toolchain | Never write "latest" |
| `runtime` | Module resource, entry symbols, required and optional exports, ABI version | Do not list exports you have not observed in the built module |
| `rendering` | Scene formats the build actually produces, default mode, logical size | Do not claim `hd2d` without scene buffers |
| `resources` | External files only; embedded content declared, not enumerated | Digests are generated at package time |
| `saves` | Format identity, exact byte size, codec path, legacy keys, migrations | A different game does not share a `formatId` |
| `multiplayer` | Protocol version, exact content string, adapter, avatars, world identity | Never copy another game's content string |
| `nuzlocke` | Support level, area mapping, required hooks | `enforce` requires synchronous gates |
| `capabilities` | What was demonstrated | Must agree with the sections above |
| `verification` | Evidence paths that exist | No placeholder links |

## Procedure

1. Pin the build. Record how the artifact was produced and its digest.
2. Derive `runtime.requiredExports` from the built module, not from documentation.
   Inspect exports and imports before writing them down.
3. Declare `rendering` only for formats the build can genuinely present. A build with no
   scene buffers is `classic` only.
4. List external resources with `group` (`boot`, `presence`, `optional`). Anything compiled
   into the engine is `embedded: true` and is not listed file by file.
5. Choose `saves.formatId` after reading the actual save bytes. If the layout differs from
   Emerald's, it is a new format even if the size matches.
6. Fill `multiplayer` only if a world model exists. Set `contentVersion` to a new value
   unless content is genuinely interchangeable with an existing pack.
7. Set `capabilities` last, from what steps 2-6 support.
8. Run the validator once it exists; until then, check every field against the built
   artifact by hand and record what you checked.

## Capability rules

- `rendering` values must match `modes`; `defaultMode` must be one of them.
- `presence` requires a `multiplayer` section plus a working `WorldModel`.
- `rules: enforce` requires every `requiredHooks` entry to exist in the build.
- A declared capability whose optional exports are missing is a startup error, not a
  downgrade.
- Lowering a capability is always acceptable. Raising it requires evidence.

## Failure messages

Name the pack, the field and the expectation:

- `pack emerald-rogue: runtime.requiredExports missing WasmPresenceRefresh`
- `pack run-and-bun: saves.bytes expected 131072, manifest says 0`
- `pack emerald-kaizo: capabilities.presence set but multiplayer.contentVersion missing`

Never `failed to load game`.

## Checklist

- [ ] `schemaVersion` present and known.
- [ ] ID matches the pack directory name.
- [ ] Build revision pinned and digest recorded.
- [ ] Exports verified against the real module.
- [ ] Modes and scene formats agree.
- [ ] External resources have digests; embedded content declared.
- [ ] Save format reviewed against real bytes.
- [ ] Content version unique unless compatibility is proven.
- [ ] Capabilities match demonstrated behaviour.
- [ ] Evidence links resolve.
- [ ] Manifest contains no scripts, ROM data or credentials.
