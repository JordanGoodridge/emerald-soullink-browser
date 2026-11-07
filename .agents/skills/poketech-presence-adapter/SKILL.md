---
name: poketech-presence-adapter
description: Wire a PokeTech game pack into the existing four-player presence system - content compatibility string, avatar sheets, adapter injection, room lifecycle on game switch and fail-closed presentation. Use when a second game needs multiplayer, when players from different games or builds can see each other, when avatars are missing or wrong, or when switching games leaves a stale room or resume state.
---

# Presence adapter

Presence is visual-only and contract-first. The protocol, coordinates, epochs and
visibility rules are already specified; a pack supplies readings and identity, not new
semantics.

Read first:
[docs/multiplayer-contracts.md](../../../docs/multiplayer-contracts.md) and
`.agents/skills/poketech-presence-maintainer/SKILL.md`.

## Current state

`CONTENT_VERSION` remains the default `emerald-presence-v2` in
`pokeemerald-3d/web/presence/protocol.mjs`, but `web/presence/runtime.mjs` now accepts
`configure({ contentVersion, avatarSheets, mapNameFor })`. `app.js` injects the selected
manifest's content version and avatar descriptors and loads `dist/map-names.json` into the
lobby. The default Emerald avatar sheets remain the fallback. The room service compares
whatever content string the handshake carries, so per-pack values need no protocol
change — only injection.

## What the pack supplies

- `multiplayer.contentVersion` — exact compatibility string.
- `multiplayer.adapter` — the world model module.
- Avatar descriptors: appearance ID, resource, transparency key, cell dimensions.
- `worldIdentity` fields and an `instanceSupport` statement.

## Content version rules

- Use a new value for any game whose maps, layouts, avatars or presence ABI differ.
- Reuse an existing value only when content is genuinely interchangeable, and say why.
- Never derive it from a UI build label or a pack version that changes for cosmetic updates.
- Changing the world model's meaning requires a new value, because old and new clients would
  otherwise misinterpret each other.

## Procedure

1. Confirm the pack has a working world model. Without one, presence is `none`.
2. Choose the content version and record the reason in the pack README.
3. Move avatar data into the manifest; load sheets through the shared atlas loader.
4. Inject the pack's adapter, avatars and content version into the presence runtime instead
   of the module defaults.
5. Ensure no network I/O occurs when no room is joined and presence is not opened.
6. On a game switch: leave the room, discard resume credentials, clear remote actors and
   interpolation, then boot the next game in a new connection generation.
7. Verify mixed-version rooms are rejected with the existing `incompatible_version` error.

## Fail-closed checklist

- [ ] Unsupported activity hides the actor but keeps roster membership.
- [ ] Unknown map or instance hides the actor.
- [ ] Missing avatar sheet uses the neutral fallback plus a diagnostic.
- [ ] Peers on incompatible content never share a room.
- [ ] Return from `away` publishes fresh state instead of replaying hidden frames.

## What not to put in presence

Party, inventory, battle results, saves, trade payloads, rule state or anything a peer could
use to affect local gameplay. Those need separate authoritative contracts.

## Stop conditions

- The game has no stable world identity for its main loop: declare presence `none` for it.
- Presence would require changing wire fields or coordinate meaning: revise
  `docs/multiplayer-contracts.md` first, then the code.
- A feature would let remote players affect local state: stop; that is not presence.

## Evidence

Two clients in the same area, one in an unsupported area, one mixed-version rejection, one
game-switch teardown, and the avatar sheets actually loaded.
