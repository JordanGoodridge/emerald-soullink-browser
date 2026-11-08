# Emerald Kaizo Pack (`emerald-kaizo`)

Difficulty-hack game pack for **Emerald SoulLink Browser** with full 3D/HD-2D + Classic 2D rendering, WebAudio sound, 4-player overworld presence, character sprite customization, and full Nuzlocke / SoulLink enforcement.

| Field | Value |
|---|---|
| Game ID | `emerald-kaizo` |
| Source | `https://github.com/CreamElDudJafar/Pokemon-Emerald-Kaizo` (`33d21d6f1141a98da84f52b2b661089555e8e480`) |
| Upstream patch | `patches/emerald-kaizo-wasm.patch` |
| Hydration | `node tools/install-upstream.mjs` (or `.\install.ps1`) |
| Build recipe | `node game-packs/emerald-kaizo/build/build.mjs` (automatically invoked by `.\build-wasm.ps1`) |
| Runtime module | `dist/pokeemeraldkaizo.wasm` |
| Save format | `emerald-kaizo-flash-128k` (128 KiB Flash) |
| Quick-start base save | `resources/soullink-base.sav` (Route 101 post-starter save with National Dex unlocked) |
| Presence version | `emerald-kaizo-presence-v1` |
| Modes | `standard`, `nuzlocke`, `soullink` (randomizer disabled; Kaizo's handcrafted encounters, rosters, and starters are preserved) |

## Install & Rebuild Workflow

1. **Hydrate & patch source tree** into `.build/kaizo-worktree/pokeemerald-3d/`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
2. **Build WASM runtime & pack metadata** (`dist/pokeemeraldkaizo.wasm`, `dist/map-names.json`, `dist/region-map.json`, `dist/build-info.json`):
   ```powershell
   node game-packs/emerald-kaizo/build/build.mjs
   ```
3. **Save upstream C/Makefile modifications** back to `patches/emerald-kaizo-wasm.patch`:
   ```powershell
   node tools/save-upstream-patch.mjs
   ```
