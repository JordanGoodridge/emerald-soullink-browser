# Toy Console architecture fixture

This hidden test pack is a tiny synthetic source-WASM game used to prove that the
application can boot a pack whose runtime, scene and save codec are not Emerald
implementations. Its runtime module is a minimal valid WASM module embedded in the
fixture adapter. It is not a playable game and is excluded from normal packaged
distributions (`hidden: true`).

The fixture deliberately declares classic rendering and no presence, rules, run or
party support. Its save bytes and save identity are synthetic. It must never be listed
as supported product content.
