---
name: multi-client-browser-game-e2e
description: Design and run end-to-end tests with multiple independent browser clients for web games, WASM/WebGPU apps, and realtime multiplayer. Use when verifying presence, rooms, matchmaking, synchronized movement, reconnects, per-profile storage, or any behavior that needs several real pages against real servers — even if the user asks for "Playwright tests", a "multiplayer test", or a "browser smoke test".
---

# Multi-client browser game E2E

Use this skill when a feature only becomes trustworthy with several real browser
clients talking to a real server. The goal is not to mock the integration; it is to
reproduce the smallest honest version of production and assert behavior at every
layer you can observe.

## What good looks like

A useful multi-client test:

- launches real browser clients with isolated storage;
- starts the real static server and realtime service on ephemeral ports;
- drives the game through an explicit automation API, not guessed clicks;
- waits on state predicates instead of arbitrary sleeps;
- checks protocol/state, storage, rendering and visible output;
- includes negative cases such as capacity rejection, room isolation and reconnects;
- writes machine-readable evidence plus screenshots and logs;
- cleans up processes and temporary profiles on success and failure;
- states what the run does **not** prove.

Do not replace the browser, server or network with mocks unless the goal is a
component test. A single page with a mocked socket is not a multi-client E2E.

## First inspect the existing harness

Before writing a new runner, look for one:

- `tools/*e2e*.mjs`, `tests/e2e/`, `playwright.config.*`, `cypress.config.*`
- app automation hooks such as `window.app.automation`, `window.__test`, or query
  parameters like `?automate=1`
- scripts that launch Chrome with `--remote-debugging-port`
- existing static and realtime server entrypoints
- git-ignored output folders and screenshot conventions

Extend the existing harness when it already launches real servers and pages. Do not
rewrite a working CDP runner just to use a different framework. In this repository,
`pokeemerald-3d/tools/presence_e2e.mjs` is the working reference.

## Architecture

```text
Orchestrator (Node)
├── static web server        ephemeral port, readiness parsed from output
├── realtime/room service    ephemeral port, private room namespace
├── browser process          one process or several, temp profile dirs
│   ├── client A page        isolated storage/profile
│   ├── client B page
│   ├── client C page
│   └── client D page
└── evidence                 summary.json, screenshots, console/errors
```

Prefer **one browser process with independent contexts/pages** when the browser
supports storage isolation and the test needs shared GPU resources. Use separate
processes or separate `--user-data-dir` profiles when the application keys saves by
profile, when `localStorage`/IndexedDB must not be shared, or when one client's GPU
loss must not affect the others.

## Isolation rules

- **Storage isolation:** a new browser context is not automatically the same as a
  separate on-disk profile. Verify the actual key. If saves are keyed by profile,
  give each client a distinct profile name or user-data directory.
- **Server isolation:** use a private relay/service instance for the test. Do not
  point at a developer's running service.
- **Room isolation:** use one room for the main scenario and a second room for a
  cross-room leakage check.
- **Port isolation:** bind ephemeral ports (`0`) and parse the chosen port from the
  server's readiness message. Never hardcode `8787` or `3000` in an E2E runner.
- **Build isolation:** rebuild when native/WASM/C++ code changed. `--no-build` is
  only for reusing a known-fresh artifact.

## Drive the game deterministically

Expose a small automation API from the app, for example:

```js
window.app.automation = {
  ready,                 // promise resolved after boot and assets
  state(),               // current frame, map, player, draw counts
  runToFrame(frame),     // advance emulated frames
  warp(group, map, x, y),
  screenshot(),          // data URL
  press(button, down),   // optional
};
```

Rules:

- Prefer emulated/game frames over wall-clock time for game behavior.
- Use a `waitFor(predicate, label, timeout)` helper with a short polling interval.
- Keep a visible-page keepalive if the game loop stops in background tabs.
- Assert intermediate states when smoothness matters, not only the final position.
- A screenshot is evidence, not a substitute for a state assertion.
- Fail with the last observed state and a screenshot, not just "timeout".

See `scripts/cdp-session.mjs` for a dependency-free Chrome/CDP session helper.

## Orchestration pattern

1. Create a temp directory for browser profiles and artifacts.
2. Start the realtime service on port `0`; wait for its actual port.
3. Start the static server on port `0`; wait for its URL.
4. Launch the browser with a temp profile and debugging port `0`.
5. Open one page per client and attach console/exception listeners.
6. Wait for each app's `automation.ready`.
7. Drive clients into the same room/map using the app's real join flow.
8. Run assertions and capture evidence.
9. In `finally`, close pages, kill child process trees, and remove temp profiles.
10. Exit nonzero on failure; preserve or summarize artifacts for diagnosis.

Do not use `sleep(5000)` as readiness. Parse server output, poll predicates, and
apply bounded timeouts. If a negative test expects no event, wait for a positive
counter-signal (for example, a stable roster plus a rejected fifth client) before
concluding success.

## What to assert

Use the acceptance matrix in `references/acceptance-matrix.md` as a starting point.
At minimum, cover:

- **Membership:** every client sees the expected roster and self mapping.
- **World/state:** clients agree on the compatible world and hide mismatches.
- **Motion:** positions change in the expected direction and interpolate smoothly.
- **Visibility:** unsupported activities hide actors but retain membership.
- **Transitions:** epoch changes, hiding during loading, and restoration without
  sliding or duplicate actors.
- **Negative capacity:** fifth client is rejected, existing clients remain healthy.
- **Room isolation:** a second room receives no cross-room presence.
- **Storage isolation:** distinct save keys/profile data; one client's writes do not
  appear in another client's storage.
- **Recovery:** reconnect/resume and renderer/GPU recreation do not lose identity.
- **Opt-out:** the feature-disabled path still boots and plays normally.

For each check, record a name, boolean result and useful detail. A summary that only
says "passed" is not enough.

## Evidence and failure reporting

Write to a git-ignored output directory:

- `summary.json` with timestamps, options, steps, checks and screenshot paths;
- `screenshots/*.png` at meaningful checkpoints;
- `console.log` and page exceptions;
- optionally a trace, HAR or video for flaky failures.

The final report should include:

- exact command run;
- checks passed/total and screenshot count;
- what environment was used (headless Chrome, loopback, one process, etc.);
- known gaps such as no latency/jitter, no soak, no separate-network run, or no
  mobile coverage.

Never claim a browser E2E proves production networking. Loopback, one machine and
one browser process are still useful, but they are not a two-network soak.

## Common pitfalls

- **Shared save state:** all pages inherit the same profile unless isolated; tests
  pass locally then fail when profiles collide.
- **Background throttling:** headless pages may stop or slow the game loop. Use the
  relevant Chrome flags and a keepalive if needed.
- **WebGPU/WebGL availability:** supply the needed headless GPU flags; handle an
  expected device-loss event explicitly instead of treating every logged error as a
  failure.
- **Stale build:** `--no-build` against an old WASM bundle produces misleading
  results.
- **Port collisions:** ephemeral ports prevent fighting a local dev server.
- **Zombie processes:** kill the browser and servers in `finally`; on Windows use a
  process-tree kill.
- **Room leakage:** a "fifth client rejected" check is meaningless if the second
  room accidentally uses the same code.
- **Unstable predicates:** assert stable signals, not transient animation frames.
- **Screenshot-only proof:** a pretty image can hide a disconnected or stale client.

## Change workflow

1. Define the acceptance matrix and the smallest scenario that would fail today.
2. Add or extend the app automation API only as needed for observability.
3. Add the runner and private servers; make ports and profiles configurable.
4. Add one positive scenario, then negative/isolation scenarios.
5. Add evidence capture and cleanup.
6. Run the narrowest scenario, then the full suite.
7. Report exact results and remaining limitations.

If the app lacks an automation API, add a minimal one behind a test flag or query
parameter. Keep it read-only where possible; expose commands only when the real
user flow cannot be driven reliably.

## Stop conditions

Pause and reconsider if you are about to:

- mock the socket, server or storage layer that the test is meant to verify;
- hardcode a developer port, room code or profile path;
- make a test pass by changing game behavior rather than fixing the integration;
- rely on a fixed sleep or a single screenshot;
- mark a soak/network/reconnect gate complete without actually running it.
