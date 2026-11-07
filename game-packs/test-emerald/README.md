# Test Emerald (hidden architecture fixture)

This pack is not a shipped game. It boots the reference Emerald WASM under a second
`gameId` and a separate save format so the architecture can prove:

- the selector and `?game=` path resolve more than one pack;
- saves from the same profile label are isolated by `gameId`/`formatId`;
- the pack loader, manifest validator and runtime module URL work for a second entry.

It is marked `"hidden": true` in `game-packs/index.json`, so it does not appear in the
normal selector. Use `?game=test-emerald` for tests.

Remove or replace this fixture with the real Emerald Kaizo pack once Kaizo exists.
