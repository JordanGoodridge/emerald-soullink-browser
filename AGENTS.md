# PokeTech Agent Guide & Fast Codebase Map

Use this guide to solve tasks and produce `/plan` artifacts in **4–8 targeted `read_file` calls** instead of scanning dozens of files.

---

## 1. Execution, Search & `/plan` Guardrails (Critical for Speed)

- **Hard Read Budget for `/plan` (Target $\le 8$ `read_file` calls):**
  - **NEVER read `.test.mjs` files during `/plan`** unless the user specifically asks about a failing test.
  - **NEVER guess file paths with `read_file`:** Every file in `web/`, `server/`, `game-packs/`, and `src/wasm_*.c` is listed in the inventory below. Guessing nonexistent paths (`server/src/room.mjs`, `run-room.mjs`, etc.) wastes turns.
  - **NEVER page through 5,000–10,000 line decomp `.c` files in 500-line chunks:** `grep_search` and `find_by_name` are not built-in tools in this harness. For decomp C files (`pokemon.c`, `battle_script_commands.c`, `party_menu.c`, `pokemon_storage_system.c`, `overworld.c`), first check Section 4 (`#if WASM` Hook Line Index) below; if you need a vanilla C symbol not listed there, run **one single batched `git grep -n "SymbolA\|SymbolB" pokeemerald-3d/src/`** via `run_command` (allowed during `/plan`!) to get the exact line numbers before calling `read_file` on a tight 50-line window.
- **Do NOT call `AgbMain()` in Node/CLI scripts:** Calling `e.AgbMain()` directly in `node -e` enters the GBA's infinite `for (;;)` loop and hangs until command timeout. Always use existing unit tests (`node --test --test-reporter=dot ...`) or bounded `WasmInit()` + `WasmRunFrame()` loops if headless stepping is required.
- **Only load `.agents/skills/*/SKILL.md` when relevant:** Only read a specific skill when implementing a new game pack or touching that exact adapter seam. Do not read skills for routine UI, run-setting, or bug fixes.

---

## 2. Auto-Wired Architecture Contracts (Do NOT Read Pass-Through Files!)

Before reading adapter or server files, know that these four seams are **100% auto-wired**:

1. **C $\rightarrow$ JS WASM Exports (`WasmRun*` functions in `pokeemerald-3d/src/wasm_*.c`):**
   - `make wasm` exports all non-static C functions automatically onto `instance.exports`.
   - Adding a C function only requires implementing it in `pokeemerald-3d/src/wasm_run.c` (or `wasm_run_debug.c`) and declaring it in `pokeemerald-3d/include/wasm/run.h`.
   - **Do NOT read or edit** `Makefile`, `build-wasm.ps1`, `manifest.json`, `runtime-wasm.mjs`, `emerald-compat.mjs`, or `composition.mjs`.
2. **C $\leftarrow$ JS WASM Imports (`extern u32 WasmRun*` in C):**
   - `pokeemerald-3d/web/packs/shared/runtime-wasm.mjs` (`createImports`, line 263) **automatically intercepts every C import starting with `WasmRun*`** and dispatches it to `createRunEngineHooks` in `pokeemerald-3d/web/run/engine-adapter.mjs` (defaulting to `0` when unimplemented).
   - **Do NOT read or edit** `runtime-wasm.mjs`, `emerald-compat.mjs`, `composition.mjs`, or `manifest.json` when adding a `WasmRun*` hook.
3. **Run & Lobby Settings (`DEFAULT_RUN_SETTINGS` in `pokeemerald-3d/web/run/run-settings.mjs`):**
   - `pokeemerald-3d/web/run/run-protocol.mjs` (`run.start`) and `server/src/run-core.mjs` accept `options` as an open object and normalize it via `normalizeRunSettings()` in `pokeemerald-3d/web/run/run-settings.mjs`.
   - **Do NOT read or edit** `server/src/*`, `run-protocol.mjs`, or `client.mjs` when adding a boolean/numeric run or lobby setting.
4. **Static Bundle (`deploy/build-dist.mjs`):**
   - Recursively copies all `.js`, `.mjs`, `.css`, and `.html` under `pokeemerald-3d/web/` automatically.

---

## 3. Vertical Slice Playbooks (Read Only These Files)

- **Adding/Editing a Run or Lobby Setting (e.g., level sync, money preset, randomizer toggle, PC boxing):**
  1. `pokeemerald-3d/web/run/run-settings.mjs` (106L) — `DEFAULT_RUN_SETTINGS`, `MODE_DEFAULTS`, `normalizeRunSettings`
  2. `pokeemerald-3d/web/index.html` (`L350–495`) — `#presence-run-settings` & `#standard-lobby-settings` checkboxes/inputs
  3. `pokeemerald-3d/web/run/run-setup-coordinator.mjs` (420L) — `renderRunSetup`, `startSelectedSoulLinkRun`
  4. `pokeemerald-3d/web/run/engine-adapter.mjs` (222L) — `createRunEngineHooks` (`WasmRun*` JS callbacks)
  5. `game-packs/emerald/adapter/run.mjs` (172L) — `quickStartFromBase` (if applied at run quick-start)
  6. `pokeemerald-3d/src/wasm_run.c` (773L) & `pokeemerald-3d/include/wasm/run.h` (82L) — C implementation
- **Modifying Multiplayer Lobby Save Sync, Slot Claiming, or Standard Co-Op Lobby:**
  1. `pokeemerald-3d/web/run/lobby-coordinator.mjs` (570L) — all lobby transfers, replica sync, slot takeover, backup/import, and Standard lobby screen
  2. `pokeemerald-3d/web/run/lobby-store.mjs` (616L) — IndexedDB lobby checkpoint store
  3. `pokeemerald-3d/web/ui/saved-lobbies-view.mjs` (195L) — saved lobby list DOM rendering
- **Modifying In-Game Sheets (Party Panel, Move Relearner, Run Tracker, People Map):**
  1. `pokeemerald-3d/web/ui/gameplay-sheets-controller.mjs` (260L) — sheet coordinator in the shell
  2. The specific view file in `pokeemerald-3d/web/ui/` (`party-panel.mjs`, `move-relearner-view.mjs`, `run-tracker.mjs`, `people-map-view.mjs`)

---

## 4. Exact `#if WASM` Hook Line Index in `pokeemerald-3d/src/`

All production WASM files fit in a single `read_file` call (`<800` lines):
- `pokeemerald-3d/include/wasm/run.h` (82L) — all `WasmRun*` C declarations
- `pokeemerald-3d/src/wasm_run.c` (773L) — production run hooks:
  - `L28–167`: `WasmRunMapSection`, `WasmRunSpeciesCount`/`At`, `WasmRunTrainerKind`, `WasmRunGymAceLevel`, `WasmRunHighestLivingPartyLevel`, `WasmRunGymBadgeCount`, `WasmRunGymLevelCap`
  - `L169–301`: Rare Candy & party auto-leveling (`WasmRunRareCandy*`, `WasmRunTeachMovesForLevel`, `WasmRunAutoLevelMonToCeiling`, `WasmRunAutoLevelCaughtMon`, `WasmRunSyncPartyLevels`)
  - `L303–466`: Party & Move Relearner accessors (`WasmRunParty*`, `WasmRunRelearnableMoveCount`/`At`, `WasmRunSetPartyMove`, `WasmRunPokeballCount`, `WasmRunIsCaught`, `WasmRunEnemyParty*`)
  - `L468–634`: Release, Quick-Start & Base Save (`WasmRunReleasePid`, `WasmRunApplyPostStarterFlags`, `WasmRunQuickStart`, `WasmRunLoadBaseSave`, `WasmRunReplaceStarter`, `WasmRunQuickStartSave`, `WasmCanSaveGame`, `WasmRunGiveStarterPokeballs`)
  - `L636–773`: Safe-point faint/release processing (`WasmRunProcessSafePoint`, `WasmRunFlushPendingReleases`)
  - `L775–850`: Player sprite & palette customization (`WasmPlayerPaletteBuffer`, `WasmPlayerReflectionPaletteBuffer`, `WasmPlayerNormalPicBuffer`, `WasmPlayerRunningPicBuffer`, `WasmApplyPlayerCustomization`)
- `pokeemerald-3d/src/wasm_run_debug.c` (128L) — `WasmRunDebug*` test helpers
- `pokeemerald-3d/src/wasm_presence.c` (265L) — overworld presence state exports (`WasmPresence*`)
- `pokeemerald-3d/src/wasm_display.c` (620L) — HD-2D & classic scene extraction buffers

**Decomp C Files with `#if WASM` Hooks (Read ONLY the 40-line window around these lines):**
- `pokeemerald-3d/src/battle_script_commands.c` (10,250L):
  - `L3016–3030`, `L3264–3275`, `L3312–3345`, `L3404–3470`: Battle EXP gain, Gym level-cap clamping, and `WasmRunSyncPartyLevels()` after level-up
  - `L9979–10005`: Ball throw capture gate (`WasmRunAllowCapture`) & blocked-ball refund
  - `L10142–10245`: Wild capture completion (`WasmRunOnCapture`, `WasmRunAutoLevelCaughtMon`, `WasmRunDebugTryBlockedBallThrow`)
- `pokeemerald-3d/src/battle_main.c` (5,315L):
  - `L1963–2121`: Trainer party species randomization (`GetTrainerPokemonSpecies`, `CreateNPCTrainerParty`, `WasmRunRandomSpecies`)
- `pokeemerald-3d/src/pokemon.c` (7,212L):
  - `L4082–4125`: Item effect gate (`WasmRunAllowItemEffect`: Rare Candy level ceiling, revives on dead mons)
  - `L4832–4850`: `GiveMoveToMon` / move learning hooks
- `pokeemerald-3d/src/party_menu.c` (5,500L):
  - `L746–765`: Party menu item use gate
  - `L4995–5025`: Rare Candy infinite refill (`WasmRunRefillRareCandy`) & party level sync after Rare Candy use
- `pokeemerald-3d/src/pokemon_storage_system.c` (6,550L):
  - `L1994–2010`, `L6389–6425`: PC deposit/move gate for linked SoulLink Pokémon (`WasmRunAllowPcBoxing`) & auto-leveling
- `pokeemerald-3d/src/overworld.c` (3,000L):
  - `L364–405`: Wally tutorial party backup/restore guard (`IsWallyTutorialPartyActive`, `GetWallyTutorialSavedSlot0`)
  - `L1568–1680`: Overworld frame hook & post-battle safe point (`WasmRunProcessSafePoint`, `WasmRunFlushPendingReleases`)
- `pokeemerald-3d/src/wild_encounter.c` (1,100L):
  - `L385–455`: Wild encounter species randomization (`WasmRunRandomSpecies`) & encounter claim hook (`WasmRunOnEncounter`)
- `pokeemerald-3d/src/script_pokemon_util.c` (350L):
  - `L77–125`: Gift Pokémon randomization & claim hook (`WasmRunOnGift`, `WasmRunAutoLevelCaughtMon`)
- `pokeemerald-3d/src/field_poison.c` (160L):
  - `L108–125`: Overworld poison faint hook (`WasmRunOnFaint`, `WasmRunProcessSafePoint`)

---

## 5. Modular Frontend & Server File Inventory (`<800` Lines per Module)

### Shell & Controllers (`pokeemerald-3d/web/`)
- `pokeemerald-3d/web/index.html` (538L) — Library (`L48–87`), Run Mode Dialog (`L89–102`), Play Shell (`L104–217`), Settings Dialog (`L219–285`), Save Dialog (`L287–312`), Presence & SoulLink/Standard Lobbies (`L314–493`), Starter Choice (`L495–507`), Group Wipe (`L509–522`), Move Relearner (`L524–536`)
- `pokeemerald-3d/web/app.js` (1,170L — Thin Shell Coordinator):
  - `L1–285`: Imports, DOM refs, state declarations
  - `L286–550`: Controller wiring (`flashSaveController`, `lobbyCoordinator`, `runSetupCoordinator`, `gameplaySheetsController`, `visualModeController`)
  - `L551–800`: Library navigation, save profile dialog, `render()`, overworld peer chrome, input listeners
  - `L801–1170`: WebGPU presenter recovery, `boot()`, `runFrames()`, `createShellAutomation()`, `tick()`, `start()`
- `pokeemerald-3d/web/saves/flash-save-controller.mjs` (325L) — `loadFlashSave`, `saveFlashIfChanged`, `saveCurrentGameNow`, `.sav`/`.ptnuzlocke` download/upload, speed controls
- `pokeemerald-3d/web/settings/visual-mode-controller.mjs` (305L) — HD-2D/Classic transitions, `setVisualSettings`, `setRenderScale`, `openSettingsDialog`, `applyCapabilities`
- `pokeemerald-3d/web/settings/settings-store.mjs` (95L), `settings-schema.mjs` (75L), `keymap.mjs` (145L)
- `pokeemerald-3d/web/automation-probes.mjs` (798L) & `automation-api.mjs` (115L) — E2E automation probes

### Run Mode & Multiplayer Lobbies (`pokeemerald-3d/web/run/`)
- `pokeemerald-3d/web/run/lobby-coordinator.mjs` (570L) — Lobby transfers, replica sync, slot claim/takeover, backup/import, Standard lobby screen
- `pokeemerald-3d/web/run/run-setup-coordinator.mjs` (420L) — `renderRunSetup`, `updateRunConnection`, `chooseStarterForPlayer`, `quickStartSoulRun`, SoulLink pregame lifecycle
- `pokeemerald-3d/web/run/runtime.mjs` (440L) — `createRunRuntime` coordinator & rules enforcement
- `pokeemerald-3d/web/run/run-state.mjs` (390L) — Pure run state reducer (claims, captures, dupes, links, deaths, wipes)
- `pokeemerald-3d/web/run/engine-adapter.mjs` (222L) — `createRunEngineHooks` (`WasmRun*` JS implementations)
- `pokeemerald-3d/web/run/run-settings.mjs` (106L) — `DEFAULT_RUN_SETTINGS`, `normalizeRunSettings`
- `pokeemerald-3d/web/run/lobby-store.mjs` (616L) — IndexedDB lobby save & checkpoint store
- `pokeemerald-3d/web/run/lobby-transfer.mjs` (145L), `lobby-broadcast.mjs` (45L), `lobby-screen-policy.mjs` (65L)
- `pokeemerald-3d/web/run/client.mjs` (230L) & `run-protocol.mjs` (111L) — WebSocket `/run` client & wire validation
- `pokeemerald-3d/web/run/randomizer.mjs` (135L), `soul-link.mjs` (115L), `starter-choices.mjs` (60L), `tracker-model.mjs` (215L), `notice-model.mjs` (155L), `move-relearner.mjs` (70L), `move-history.mjs` (95L), `nuzlocke-bundle.mjs` (140L)

### Character Customization (`pokeemerald-3d/web/customization/`)
- `pokeemerald-3d/web/customization/character-catalog.mjs` (245L) — Protagonist rig registry (`gen3-brendan`), semantic color ramps, modular clothing slots (`head`, `top`, `bottom`), and multi-game extension (`extendCharacterRigForGame`, `registerCharacterRig`)
- `pokeemerald-3d/web/customization/character-compositor.mjs` (295L) — 4bpp GBA tile + 15-bit BGR555 palette + RGBA sprite-sheet compositor
- `pokeemerald-3d/web/customization/character-store.mjs` (165L) — `localStorage` persistence & subscriber store for character customization
- `pokeemerald-3d/web/customization/brendan-sheets-data.mjs` (20L) — 4bpp walking & running base sheets and default palette for Brendan

### UI Views (`pokeemerald-3d/web/ui/`)
- `pokeemerald-3d/web/ui/gameplay-sheets-controller.mjs` (260L) — Coordinator for People Map, Party Panel, Move Relearner, Run Tracker, and Run Notices
- `pokeemerald-3d/web/ui/character-customizer-view.mjs` (285L) — Main Menu (`#library`) Character Customizer dialog controller & live sprite preview
- `pokeemerald-3d/web/ui/party-panel.mjs` (285L), `run-tracker.mjs` (185L), `move-relearner-view.mjs` (125L), `people-map-view.mjs` (185L), `saved-lobbies-view.mjs` (195L), `starter-picker.mjs` (80L), `overworld-peer-dom.mjs` (190L), `game-library.mjs` (275L), `library-model.mjs` (210L), `game-menu.mjs` (130L)

### CSS Stylesheets (`pokeemerald-3d/web/styles/`)
> Edit the focused module directly (`style.css` and `library.css` are `@import` entrypoints):
- **Base Shell (`style.css`):** `base-shell.css` (643L), `presence-and-dialogs-base.css` (319L), `overworld-overlays.css` (108L), `sheets-and-map.css` (382L)
- **Library & Framed Pixel Theme (`library.css`):** `library-core.css` (965L), `library-framed-theme.css` (1,080L), `library-sheets.css` (493L), `library-friends-and-lobbies.css` (1,051L)

### Presence, Packs & Server (`pokeemerald-3d/web/presence/`, `packs/`, `server/src/`)
- **Presence (`pokeemerald-3d/web/presence/`):** `runtime.mjs` (496L), `presence-client.mjs` (543L), `remote-actors.mjs` (426L), `protocol.mjs` (393L), `lobby.mjs` (335L), `peer-overlay-model.mjs` (235L), `party-panel-model.mjs` (215L)
- **Game Packs (`game-packs/emerald/`, `game-packs/emerald-kaizo/`, & `pokeemerald-3d/web/packs/`):** `game-packs/emerald/adapter/run.mjs` (205L), `rules.mjs` (105L), `party.mjs` (45L), `runtime.mjs` (25L); `game-packs/emerald-kaizo/adapter/run.mjs`, `rules.mjs`, `party.mjs`, `runtime.mjs`, `build/build.mjs`; `web/packs/emerald-compat.mjs` (139L), `shared/runtime-wasm.mjs` (297L), `shared/party-emerald.mjs` (225L), `shared/save-codec-emerald.mjs` (375L), `shared/scene-emerald.mjs` (255L), `shared/world-emerald.mjs` (175L)
- **Server (`server/src/` — ONLY 3 files exist):** `server/src/server.mjs` (645L — HTTP/WS relay), `server/src/room-core.mjs` (441L — presence rooms), `server/src/run-core.mjs` (345L — SoulLink run state authority)

---

## 6. Fast, Quiet Commands Reference

- **Fast surgical search across C decomp files (use 1 batched call instead of multi-chunk `read_file`):**
  `git grep -n "PatternA\|PatternB" pokeemerald-3d/src/ pokeemerald-3d/include/`
- **Run fast unit tests quietly (~1.5s, dot reporter avoids TAP log spam):**
  `node --test --test-reporter=dot pokeemerald-3d/web/customization/*.test.mjs pokeemerald-3d/web/ui/*.test.mjs pokeemerald-3d/web/run/*.test.mjs game-packs/emerald/adapter/*.test.mjs server/test/*.test.mjs pokeemerald-3d/tools/*.test.mjs`
- **Run 3D terrain & building renderer regression tests (<1s):**
  `node pokeemerald-3d/tools/test_building_rendering.mjs`
- **Assemble static `dist` bundle quietly (~1s):**
  `node deploy/build-dist.mjs`
- **Rebuild WASM in parallel across all cores (builds both Emerald and Emerald Kaizo):**
  `.\build-wasm.ps1`
- **Save upstream C/Makefile modifications into `patches/pokeemerald-wasm.patch` and `patches/emerald-kaizo-wasm.patch`:**
  `node tools/save-upstream-patch.mjs`
