# PokeTech Agent Guide & Fast Codebase Map

Solve tasks and produce `/plan` artifacts in **4–8 targeted `read_file` calls** using this map.

---

## 1. Execution, Search & `/plan` Guardrails

- **Hard Read Budget for `/plan` (Target $\le 8$ `read_file` calls):**
  - **NEVER read `.test.mjs` files during `/plan`** unless debugging a specific test failure.
  - **NEVER guess file paths:** Every file in `web/`, `server/`, `game-packs/`, and `src/wasm_*.c` is listed below.
  - **NEVER page through 5,000–10,000L decomp `.c` files in chunks:** Check Section 3 (`#if WASM` Hook Line Index) first. For unlisted vanilla C symbols, run **one batched `git grep -n "SymbolA\|SymbolB" pokeemerald-3d/src/ pokeemerald-3d/include/`** via `run_command` to get exact line numbers, then `read_file` a tight 50-line window.
- **Batch Parallel Tool Calls:** Always emit independent `read_file` and `edit_file` calls in the **same turn** rather than sequentially across turns.
- **Do NOT call `AgbMain()` in Node/CLI scripts:** `AgbMain()` enters an infinite `for (;;)` loop and hangs. Use unit tests or bounded `WasmInit()` + `WasmRunFrame()` loops.
- **Load `.agents/skills/*/SKILL.md` only when relevant:** Only read a skill when touching that specific seam (e.g., `poketech-avatar-clothing` for sprites, `poketech-game-port` for new ROM hacks).

---

## 2. Auto-Wired Seams (Do NOT Read Pass-Through Files!)

1. **C $\rightarrow$ JS WASM Exports (`WasmRun*` in `pokeemerald-3d/src/wasm_*.c`):**
   - All non-static C functions export automatically onto `instance.exports`. Only edit `pokeemerald-3d/src/wasm_run.c` (or `wasm_run_debug.c`) and `pokeemerald-3d/include/wasm/run.h`.
   - **Skip:** `Makefile`, `build-wasm.ps1`, `manifest.json`, `runtime-wasm.mjs`, `emerald-compat.mjs`, `composition.mjs`.
2. **C $\leftarrow$ JS WASM Imports (`extern u32 WasmRun*` in C):**
   - `runtime-wasm.mjs` auto-intercepts every `WasmRun*` import and routes it to `createRunEngineHooks` in `pokeemerald-3d/web/run/engine-adapter.mjs` (defaulting to `0`).
   - **Skip:** `runtime-wasm.mjs`, `emerald-compat.mjs`, `composition.mjs`, `manifest.json`.
3. **Run & Lobby Settings (`DEFAULT_RUN_SETTINGS` in `pokeemerald-3d/web/run/run-settings.mjs`):**
   - `run-protocol.mjs` and `server/src/run-core.mjs` pass `options` through `normalizeRunSettings()` automatically.
   - **Skip:** `server/src/*`, `run-protocol.mjs`, `client.mjs` when adding boolean/numeric settings.
   - **Vertical slice for a setting:** `run-settings.mjs` $\rightarrow$ `index.html` (`L350–495`) $\rightarrow$ `run-setup-coordinator.mjs` $\rightarrow$ `engine-adapter.mjs` $\rightarrow$ `game-packs/emerald/adapter/run.mjs` (if quick-start) $\rightarrow$ `wasm_run.c` & `run.h`.
4. **Static Bundle (`deploy/build-dist.mjs`):** Recursively copies all `.js`, `.mjs`, `.css`, and `.html` under `pokeemerald-3d/web/`.

---

## 3. `#if WASM` Hook Line Index (`pokeemerald-3d/src/`)

**Dedicated WASM C Files (`<850L` each — single `read_file`):**
- `pokeemerald-3d/include/wasm/run.h` (82L) — all `WasmRun*` declarations
- `pokeemerald-3d/src/wasm_run.c` (850L):
  - `L28–167`: `WasmRunMapSection`, `WasmRunSpeciesCount`/`At`, `WasmRunTrainerKind`, `WasmRunGymAceLevel`, `WasmRunHighestLivingPartyLevel`, `WasmRunGymBadgeCount`, `WasmRunGymLevelCap`
  - `L169–301`: Rare Candy & party auto-leveling (`WasmRunRareCandy*`, `WasmRunTeachMovesForLevel`, `WasmRunAutoLevelMonToCeiling`, `WasmRunAutoLevelCaughtMon`, `WasmRunSyncPartyLevels`)
  - `L303–466`: Party & Move Relearner (`WasmRunParty*`, `WasmRunRelearnableMoveCount`/`At`, `WasmRunSetPartyMove`, `WasmRunPokeballCount`, `WasmRunIsCaught`, `WasmRunEnemyParty*`)
  - `L468–634`: Release, Quick-Start & Base Save (`WasmRunReleasePid`, `WasmRunApplyPostStarterFlags`, `WasmRunQuickStart`, `WasmRunLoadBaseSave`, `WasmRunReplaceStarter`, `WasmRunQuickStartSave`, `WasmCanSaveGame`, `WasmRunGiveStarterPokeballs`)
  - `L636–773`: Safe-point faint/release processing (`WasmRunProcessSafePoint`, `WasmRunFlushPendingReleases`)
  - `L775–850`: Player sprite & palette customization (`WasmPlayer*Buffer`, `WasmApplyPlayerCustomization`)
- `pokeemerald-3d/src/wasm_run_debug.c` (128L) — `WasmRunDebug*` test helpers
- `pokeemerald-3d/src/wasm_presence.c` (265L) — overworld presence exports (`WasmPresence*`)
- `pokeemerald-3d/src/wasm_display.c` (620L) — HD-2D & classic scene extraction buffers

**Decomp C Files with `#if WASM` Hooks (Read ONLY a 40-line window around these lines):**
- `battle_script_commands.c`: `L3016–3030`, `L3264–3275`, `L3312–3345`, `L3404–3470` (EXP gain, level-cap clamp, `WasmRunSyncPartyLevels`); `L9979–10005` (`WasmRunAllowCapture` & ball refund); `L10142–10245` (`WasmRunOnCapture`, `WasmRunAutoLevelCaughtMon`)
- `battle_main.c`: `L1963–2121` (`GetTrainerPokemonSpecies`, `CreateNPCTrainerParty`, `WasmRunRandomSpecies`)
- `pokemon.c`: `L4082–4125` (`WasmRunAllowItemEffect`); `L4832–4850` (`GiveMoveToMon`)
- `party_menu.c`: `L746–765` (party menu item gate); `L4995–5025` (`WasmRunRefillRareCandy` & party level sync)
- `pokemon_storage_system.c`: `L1994–2010`, `L6389–6425` (`WasmRunAllowPcBoxing` & auto-leveling)
- `overworld.c`: `L364–405` (Wally party guard); `L1568–1680` (`WasmRunProcessSafePoint`, `WasmRunFlushPendingReleases`)
- `wild_encounter.c`: `L385–455` (`WasmRunRandomSpecies`, `WasmRunOnEncounter`)
- `script_pokemon_util.c`: `L77–125` (`WasmRunOnGift`, `WasmRunAutoLevelCaughtMon`)
- `field_poison.c`: `L108–125` (`WasmRunOnFaint`, `WasmRunProcessSafePoint`)

---

## 4. Frontend, Packs & Server File Inventory

- **Shell (`pokeemerald-3d/web/`):**
  - `index.html` (538L) — Library (`L48–87`), Run Mode (`L89–102`), Play Shell (`L104–217`), Settings (`L219–285`), Save (`L287–312`), Presence & Lobbies (`L314–493`), Starter (`L495–507`), Wipe (`L509–522`), Relearner (`L524–536`)
  - `app.js` (1,170L) — Imports/state (`L1–285`), controller wiring (`L286–550`), library/dialogs/`render()` (`L551–800`), WebGPU/`boot()`/`runFrames()`/automation (`L801–1170`)
  - `saves/flash-save-controller.mjs` (325L), `settings/visual-mode-controller.mjs` (305L), `settings/settings-store.mjs` (95L), `settings/settings-schema.mjs` (75L), `settings/keymap.mjs` (145L), `automation-probes.mjs` (798L), `automation-api.mjs` (115L)
- **Run & Lobbies (`pokeemerald-3d/web/run/`):**
  - `lobby-coordinator.mjs` (570L — transfers, replica sync, slot takeover, backup/import, Standard lobby), `lobby-store.mjs` (616L — IndexedDB checkpoints), `lobby-transfer.mjs` (145L), `lobby-broadcast.mjs` (45L), `lobby-screen-policy.mjs` (65L)
  - `run-setup-coordinator.mjs` (420L — setup UI, starters, quick-start), `runtime.mjs` (440L — run coordinator), `run-state.mjs` (390L — pure reducer), `engine-adapter.mjs` (222L — `WasmRun*` hooks), `run-settings.mjs` (106L)
  - `client.mjs` (230L), `run-protocol.mjs` (111L), `randomizer.mjs` (135L), `soul-link.mjs` (115L), `starter-choices.mjs` (60L), `tracker-model.mjs` (215L), `notice-model.mjs` (155L), `move-relearner.mjs` (70L), `move-history.mjs` (95L), `nuzlocke-bundle.mjs` (140L)
- **Customization (`pokeemerald-3d/web/customization/`):**
  - `character-catalog.mjs` (245L), `character-compositor.mjs` (295L), `character-store.mjs` (165L), `brendan-sheets-data.mjs` (20L). *(Read `.agents/skills/poketech-avatar-clothing/SKILL.md` before editing sprites/palettes.)*
- **UI Views (`pokeemerald-3d/web/ui/`):**
  - `gameplay-sheets-controller.mjs` (260L), `character-customizer-view.mjs` (285L), `party-panel.mjs` (285L), `run-tracker.mjs` (185L), `move-relearner-view.mjs` (125L), `people-map-view.mjs` (185L), `saved-lobbies-view.mjs` (195L), `starter-picker.mjs` (80L), `overworld-peer-dom.mjs` (190L), `game-library.mjs` (275L), `library-model.mjs` (210L), `game-menu.mjs` (130L)
- **Styles (`pokeemerald-3d/web/styles/` — scoped rules in `styles/AGENTS.md`):**
  - `base-shell.css`, `presence-and-dialogs-base.css`, `overworld-overlays.css`, `sheets-and-map.css`, `library-core.css`, `library-framed-theme.css`, `library-sheets.css`, `library-friends-and-lobbies.css` (Light ivory `#f8f5e8` & sage-green `#e4f3df` theme only; never dark navy backgrounds).
- **Presence, Packs & Server:**
  - `pokeemerald-3d/web/presence/`: `runtime.mjs` (496L), `presence-client.mjs` (543L), `remote-actors.mjs` (426L), `protocol.mjs` (393L), `lobby.mjs` (335L), `peer-overlay-model.mjs` (235L), `party-panel-model.mjs` (215L)
  - `game-packs/`: `emerald/adapter/{run,rules,party,runtime}.mjs`, `emerald-kaizo/adapter/{run,rules,party,runtime}.mjs`, `emerald-kaizo/build/build.mjs`
  - `pokeemerald-3d/web/packs/`: `emerald-compat.mjs` (139L), `shared/{runtime-wasm,party-emerald,save-codec-emerald,scene-emerald,world-emerald}.mjs`
  - `server/src/` (only 3 files): `server.mjs` (645L), `room-core.mjs` (441L), `run-core.mjs` (345L)

---

## 5. Fast, Quiet Commands

- **Surgical C symbol search:** `git grep -n "PatternA\|PatternB" pokeemerald-3d/src/ pokeemerald-3d/include/`
- **Fast unit tests (~1.5s):** `node --test --test-reporter=dot pokeemerald-3d/web/customization/*.test.mjs pokeemerald-3d/web/ui/*.test.mjs pokeemerald-3d/web/run/*.test.mjs game-packs/emerald/adapter/*.test.mjs server/test/*.test.mjs pokeemerald-3d/tools/*.test.mjs`
- **3D renderer regression test (<1s):** `node pokeemerald-3d/tools/test_building_rendering.mjs`
- **Build static `dist` (~1s):** `node deploy/build-dist.mjs`
- **Parallel WASM build (Emerald + Kaizo):** `.\build-wasm.ps1`
- **Save upstream C patches:** `node tools/save-upstream-patch.mjs`
