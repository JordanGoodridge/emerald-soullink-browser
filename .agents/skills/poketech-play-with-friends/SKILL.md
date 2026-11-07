---
name: poketech-play-with-friends
description: Launch an interactive PokeTech multiplayer session with 2-4 real Chrome tabs, each a separate player, against a private local presence relay. Use when the user wants to play with friends locally, open multiple game tabs, see multiple players, demo four-player overworld presence, or launch a hands-on session rather than the automated E2E.
---

# PokeTech Play With Friends

Launch a hands-on PokeTech presence session: one command starts a private room
relay and static server, opens real Chrome tabs with isolated save profiles,
creates a room, joins every tab, and (by default) puts all players on Route 103
so they can immediately walk around and see each other.

This is the **interactive** counterpart to `tools/presence_e2e.mjs`. The E2E is
automated, headless and assertion-driven; this launcher is for humans.

## Run it

From `pokeemerald-3d/`:

```powershell
node tools/presence_launcher.mjs
```

That opens 4 players: Ash, Misty, Brock and Gary. Switch tabs to control each one.

Common variants:

```powershell
node tools/presence_launcher.mjs --count 2
node tools/presence_launcher.mjs --count 3 --names "Red,Blue,Green"
node tools/presence_launcher.mjs --profile-dir "$env:LOCALAPPDATA\PokeTech\play-profile" --no-demo
node tools/presence_launcher.mjs --build
```

Press **Ctrl+C** to stop the relay, web server and browser. The launcher owns
all three; do not point it at a developer relay.

## What it does

1. Rebuilds WASM only when it is missing, unless `--build` is passed.
2. Starts the room relay on an ephemeral loopback port.
3. Starts the WASM static server on an ephemeral port.
4. Starts one Chrome/Chromium/Edge process with a temporary or explicit profile.
5. Opens a host tab, creates a room, and reads the room code from the app state.
6. Opens the remaining tabs, each with a distinct `saveProfile`, and joins them.
7. Unless `--no-demo` is set, starts a new game in every tab and warps each player
   to a different Route 103 tile.
8. Waits until every tab sees `count - 1` remote actors, then prints the room code.

## Options

| Option | Meaning |
|---|---|
| `--count N` | Players to launch, 2-4. The protocol room limit is 4. |
| `--names A,B,C` | Display names; defaults to Ash, Misty, Brock, Gary. |
| `--profile-prefix P` | Save-profile prefix, default `play-`; profiles become `play-1`... |
| `--profile-dir DIR` | Persistent Chrome profile so saves survive restarts. |
| `--no-demo` | Join only; leave each tab at the title screen to load a save. |
| `--build` / `--no-build` | Force a WASM build / fail instead of building when missing. |
| `--headless` | Headless Chrome, for verification only. |
| `--smoke` | Verify the session, print a pass, then exit 0. |

With `--profile-dir` and no explicit `--demo`, demo mode defaults to off so an
existing save is not replaced.

## Verify the launcher itself

```powershell
node tools/presence_launcher.mjs --count 4 --headless --smoke --no-build
```

Expected: four clients join one room, all reach Route 103, and the process exits 0.
Run this after changing the launcher, presence runtime, room service or WASM.

## What to expect in the session

- Presence is **visual only**. Remote players do not collide, trigger scripts or
  share story, NPCs, encounters or inventory.
- The launcher forces every tab to be treated as visible, because only one tab can be
  foregrounded in a one-window demo. Background tabs therefore do not publish `away`.
  Use a second machine or the E2E to observe the away path.
- Remote actors only render in a clean HD-2D exterior frame with the local player
  on foot. Bikes, surfing, indoor/classic views and battles hide the actor while
  keeping the player in the roster. This is intentional fail-closed behavior.
- Every tab needs a distinct `saveProfile`; the launcher handles that. Do not open
  two tabs with the same profile: the save-profile ownership lock blocks the second
  tab before it can write.
- The default temporary browser profile is deleted on exit. Use `--profile-dir`
  to keep a session.
- Demo mode calls the automation new-game/warp exports. It is meant for disposable
  profiles; with a persistent profile, a later save can replace that profile's save.
- Loopback, one machine and one browser process are **not** the separate-network
  acceptance gate. This proves the interactive local session only.

## Troubleshooting

- **Chrome not found**: set `CHROME_BIN` to `chrome.exe`, `msedge.exe` or Chromium.
- **"This save profile is already open in another tab"**: close the other tab or
  launch with a different `--profile-prefix` / `saveProfile`.
- **Missing WASM**: run `.\build-wasm.ps1` from the repository root, or pass `--build`.
- **Timeout waiting for Route 103**: run the smoke command above; if it fails, run
  `node tools/presence_e2e.mjs --no-build` to separate launcher issues from
  presence regressions.
- **Ports**: the launcher uses ephemeral ports, so a running `serve-local.ps1` or
  `server/npm start` is not a conflict.
- **Slow machine**: 4 WebGPU tabs are heavy. Use `--count 2` first.

## Do not

- Do not use this launcher as evidence for public hosting, separate networks,
  latency/jitter or soak acceptance.
- Do not raise `--count` above 4; the fifth client is rejected by design.
- Do not make bike, surf or indoor states visible to "fix" a missing actor.
