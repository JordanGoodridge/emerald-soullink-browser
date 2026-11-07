---
name: poketech-presence-maintainer
description: Maintain and extend PokeTech's four-player overworld presence (Milestone 2A) without breaking its contracts. Use this skill for any task involving PokeTech presence, remote actors, rooms, avatars, map transitions, presence E2E, reconnect/resume, bike/surf/indoor hiding, or adding trades/battles on top of the existing room service — even when the user does not name the skill.
---

# PokeTech Presence Maintainer

PokeTech presence is a **visual-only, contract-first relay** between independent
Emerald games. It is not shared simulation. Four players can see each other on
compatible exterior maps, but each player's story, NPCs, encounters, inventory and
save remain local.

Milestone 2A is locally verified. Trades, battles, Nuzlocke, shared progression and
cloud saves are not implemented. Do not describe 2A as publicly deployed or
separate-network verified.

## Read these first

Read only what the task needs, but at minimum:

1. `docs/multiplayer-contracts.md` — normative protocol, coordinates, lifecycle,
   visibility and defaults.
2. `docs/milestone-2a-presence.md` — scope, architecture, evidence and known limits.
3. `pokeemerald-3d/AGENTS.md` — repository rules for the WASM port.
4. The relevant colocated `*.test.mjs` files before editing the module.

If code and docs disagree, treat the contract as the intended behavior and find the
root cause. Do not silently redefine the contract to match a bug.

## Non-negotiable invariants

1. **Contract first.** Wire shapes, coordinate semantics, visibility rules and
   compatibility changes go into `web/presence/protocol.mjs`, `fixtures.mjs`,
   tests and the docs before dependent code. Internal helper renames do not need a
   contract change.

2. **Publish the ground footpoint, not camera space.** The canonical standing
   coordinate for tile `(x, y)` is `(16*x + 8, 16*y + 16)`. During a step, the C
   adapter integrates sprite and camera deltas, then resyncs to the tile anchor
   when movement settles. Remote placement is local visual foot anchor plus the
   map-space delta; jump height is applied separately. A camera-clamped map must
   not change wire coordinates.

3. **World identity is exact.** `mapGroup`, `mapNum`, `layoutId` and `variant` all
   participate. Layout is `layout_<hex>` from `gMapHeader.mapLayoutId`; ordinary
   maps use `variant: 'base'`, dynamic secret bases use `'dynamic'`.

4. **Epochs fence history.** Increment on warp, map/layout/variant change,
   teleport, save load, new game, world reset, and loss-then-restoration of
   validity. Never reset an epoch inside one connected session generation. Recreate
   the adapter only with a new connection generation.

5. **Fail closed.** Only a clean HD-2D exterior frame (`WasmDisplaySceneKind() == 1`)
   with an on-foot local avatar may render remote actors. Bike, surf, indoor,
   classic/dynamic interiors and unknown states hide the actor while retaining
   roster membership. Do not guess a shared-world identity.

6. **Network is presentation only.** Remote actors do not collide, trigger scripts,
   occupy NPC slots, mutate party/inventory, or write saves. The relay does not
   validate movement legality.

7. **Presence stays optional.** With no joined room, the game must boot and move
   normally and perform no network I/O. Presence is behind **Play with friends**.

8. **Save profiles stay independent.** Browser save records use
   `pokeemerald.save.v2/<gameId>/<formatId>/<version>/<profileKey>/main`; the legacy
   `pokeemerald.wasm.flash.v1[.<profile>]` key migrates once and remains as recovery
   material. E2E clients use distinct profiles. Prevent two tabs from writing the same
   record.

9. **Protocol has one source of truth.** `web/presence/protocol.mjs` must stay free
   of DOM, WASM, Node and socket imports. The server imports the same module.

10. **Presenter recreation preserves presence.** Rebuilding the WebGPU presenter
    must rebuild the remote avatar atlas, bind group and draw range. Expected
    device loss is not a presence failure.

## Where the layers live

| Layer | Files | Responsibility |
|---|---|---|
| Shared contract | `web/presence/protocol.mjs`, `fixtures.mjs`, docs | Wire validation, limits, shared examples |
| Game adapter | `src/wasm_presence.c`, `web/presence/game-adapter.mjs` | Read-only engine snapshot, map identity, epoch, activity/motion/facing/frame, smooth footpoint |
| Client and lobby | `web/presence/presence-client.mjs`, `lobby.mjs`, `runtime.mjs` | Connection state, resume, coalescing, clock, roster UI, composition |
| Remote store | `web/presence/remote-actors.mjs` | Ordering, epochs, interpolation, stale cleanup, visibility |
| Renderer | `web/presence/avatar-manifest.mjs`, `remote-renderer.mjs`, `web/presenter.js` | Atlas lookup, remote quads, local camera/depth integration |
| Server | `server/src/room-core.mjs`, `server/src/server.mjs` | Transport-free room lifecycle, `ws` transport, health |
| Browser integration | `web/app.js`, `web/index.html`, `web/style.css`, `web/save-profile-lock.mjs` | Optional runtime tick/render hooks, save-profile key and ownership lock, diagnostics |
| Acceptance | `tools/presence_e2e.mjs` | Four-client browser E2E with private servers |

Architecture and data flow are documented in `docs/milestone-2a-presence.md`.
Do not create a second protocol/defaults table in another module.

## Change workflow

1. **Classify the change.** Is it contract, adapter, client/lobby, store, renderer,
   server, integration, or evidence-only?
2. **Read the affected contract section and tests.** Identify which of A/B/C/D in
   `multiplayer-contracts.md` owns the behavior.
3. **Change shared semantics before consumers.** Update protocol, fixtures, docs and
   tests first when a wire shape, coordinate, epoch or visibility rule changes.
4. **Implement at the narrowest layer.** Keep S1/S2/S3/S4/S5 boundaries. Do not make
   the store read WASM, the renderer open sockets, or the adapter write saves.
5. **Add a failing test before the fix** when behavior is testable. Prefer a root
   cause fix that covers the class of maps/actions, not a one-map special case.
6. **Run the narrowest real verification**, then broaden if integration changed.
7. **Record evidence and limits.** Update the milestone/contract docs only with
   measured results. Never upgrade “locally verified” to “publicly complete”
   without the separate-network and soak gates.

## Verification commands

From the repository root on this Windows setup:

```powershell
.\build-wasm.ps1
```

From `pokeemerald-3d/`:

```powershell
node --test web/presence/*.test.mjs web/save-profile-lock.test.mjs
node tools/presence_e2e.mjs --no-build
```

From `server/`:

```powershell
npm test
```

Rules:

- After any C/WASM change, rebuild before E2E. Do not use `--no-build` against a
  stale `build/wasm/pokeemerald.wasm`.
- `presence_e2e.mjs` starts its own room relay and static server on ephemeral ports
  and writes screenshots plus `summary.json` to the git-ignored
  `pokeemerald-3d/presence-e2e-output/`.
- The expected presenter-loss page error is
  `WebGPU device was lost (destroyed): Device was destroyed.` Recovery is proven by
  `presenterRecreations: 1` and the runtime remaining alive.
- Use `.\serve-local.ps1` for manual browser checks. Start `server/` separately;
  `npm start` serves `ws://<hostname>:8787/presence`.

## Common playbooks

### Add or repair an avatar presentation state

1. Check whether the C adapter can identify the state reliably and read-only.
2. Update the activity/motion/facing/frame mapping in `game-adapter.mjs`.
3. Update the avatar manifest only for calibrated sheets. Use the neutral fallback
   for unknown well-formed appearance/frame values.
4. If the state is not calibrated, keep it in the fail-closed set instead of
   rendering a guessed sprite.
5. Add unit tests and extend E2E evidence for visibility, roster retention and
   restoration.

Bike/surf are currently hidden by design. Do not simply flip them visible without
calibrating motion, frames, footpoint and at least one real map scenario.

### Diagnose a remote-position or camera bug

Check in this order:

1. Is `xPx/yPx` the bottom-centre ground footpoint?
2. Is the C integrator cancelling camera motion and resyncing when `moving` clears?
3. Did a warp/map change increment the epoch?
4. Is the remote renderer using the local visual foot anchor plus map-space delta,
   rather than applying a camera offset twice?
5. Is jump height subtracted from the remote ground anchor, not baked into wire Y?
6. Does a same-epoch displacement over 64 px clear history as a safety fallback?

Add a fixture or browser assertion at the layer that failed. Do not patch the
renderer with a per-map pixel offset.

### Add a map or transition case

- Verify all four world fields and the `base`/`dynamic` variant.
- Expect `loading`/`pose:null` during transition and a new epoch on restoration.
- Hide the actor on world mismatch; keep the member in the roster.
- Test outbound, return, and no-slide/no-duplicate restoration.
- Prefer a content-level mapping over hardcoded map names in network code.

### Touch reconnect, resume or clock behavior

- The server owns room membership, player ID, generation and resume token.
- Successful resume rotates the token, increments generation, clears latest state
  and fences the replaced socket.
- New generation starts `seq` at 1; old history must never affect new movement.
- Timestamps use the server monotonic clock. Do not compare browser clocks.
- Interpolation uses `serverNowMs - interpolationDelayMs`, default 150 ms.
- Hide snapshots older than 5 s; do not extrapolate past the newest pose.
- A frozen game can still answer pings; socket liveness and sample freshness are
  different concerns.

### Touch save-profile ownership or tab visibility

- Acquire the exclusive save-profile Web Lock before boot; a blocked tab must not
  read or write the profile. `web/save-profile-lock.mjs` owns this; fail closed if
  Web Locks is unavailable.
- Hold the lock for the document lifetime and release on non-persisted `pagehide`.
- Browser visibility publishes an explicit `away` snapshot (`pose:null`, known world
  retained) and clears interpolation. Returning publishes a fresh snapshot; never
  interpolate across the hidden gap.
- `presence.simulateDrop()` is an automation-only hook for an in-page socket drop. It
  must exercise the resume path, not leave and rejoin.
- The E2E covers duplicate-profile rejection/release, explicit `away`, and simulated
  socket-drop resume.

### Renderer or presenter recreation

- Keep presence state outside the GPU presenter.
- Recreate the remote avatar texture, bind group and draw range with the presenter.
- Empty actor input must remove all remote quads.
- Dispose must release remote resources without touching local NPC/game state.
- Test with injected actors and with a real presenter-loss recovery.

### Add trades, battles or Nuzlocke later

Do not overload `LocalPresence` with party mutations, battle input, full saves or
trusted gameplay results. Those need their own contracts and authority.

Reuse the room identity, generation/token lifecycle, server clock and isolation
patterns where appropriate. Keep link operations authoritative and separate from
the presence relay. A presence room proves connectivity, not native link behavior.

## Evidence and honesty

A good handoff states:

- what changed and which contract layer owns it;
- exact commands run and observed counts/results;
- screenshots or machine-readable summaries when browser behavior changed;
- what was **not** verified.

Still outstanding for 2A unless the task explicitly closes them:

- separate-network HTTPS/WSS hosting;
- 30-minute soak;
- 100–250 ms RTT with jitter and abrupt disconnects;
- real OS/background-tab suspension and timer throttling (explicit `away` is covered);
- frame-time overhead measurement;
- live jump/running/bike/surf calibration;
- indoor and supported dynamic-interior identity;
- classic-view and mobile presence (name tags and edge extender icons now exist for
  renderable peers).

## Stop conditions

Pause and revise the contract before coding if a request would:

- change a wire field, coordinate meaning, epoch rule or visibility rule;
- let remote players affect local gameplay or saves;
- make an uncalibrated state visible;
- put trade/battle/Nuzlocke state into presence snapshots;
- claim a gate passed without the relevant evidence.

For repo-wide WASM rules, also follow `pokeemerald-3d/AGENTS.md`. Keep generated
outputs, screenshots and `.opencode/` local state out of commits.
