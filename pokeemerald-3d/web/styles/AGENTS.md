# PokeTech CSS & Theme Rules (`pokeemerald-3d/web/styles/`)

## 1. Module Structure (`@import` Entrypoints)
Edit the focused stylesheet module directly (`style.css` and `library.css` are `@import` entrypoints):
- **Base Shell (`style.css`):**
  - `base-shell.css` — Top-level shell layout, top bar, viewport frame, controls
  - `presence-and-dialogs-base.css` — Base dialogs, modals, and presence chrome
  - `overworld-overlays.css` — Overworld peer labels, badges, and HUD overlays
  - `sheets-and-map.css` — In-game slide-over sheets (Party, Tracker, Map, Move Relearner)
- **Library & Framed Pixel Theme (`library.css`):**
  - `library-core.css` — Main menu / Library layout, game cards, and typography
  - `library-framed-theme.css` — Warm ivory & sage-green `.pixel-frame` theme tokens and surfaces
  - `library-sheets.css` — Character Customizer, Settings, and Save dialogs in the framed theme
  - `library-friends-and-lobbies.css` — SoulLink & Standard Lobby setup cards, slot pickers, and saved lobbies

## 2. UI Theme Guardrail (Light Ivory & Sage-Green Only)
All dialogs, sheets, cards, and active states use the warm ivory & sage-green pixel-framed palette:
- **Dialog / Sheet surface:** `#f8f5e8` (`var(--frame-surface)`)
- **Section cards:** `#f5f4e4` (`var(--frame-card)`)
- **Inset trays /wells:** `#ecebd9` (`var(--frame-inset)`)
- **Buttons & inputs:** `#fffdf1`
- **Active / selected state (`.is-active`, `.is-selected`):** `#e4f3df` background with `var(--lib-green)` border/accent
- **Strictly Forbidden:** **NEVER** use `--frame-navy` (`#152540`) or dark navy/black fills (`#1a2840`, `#121d30`, `#07110f`, `#ffffff0a`) as card, section, input, or active-button backgrounds. `--frame-navy` is strictly reserved for text ink, structural borders, and the outer `.pixel-frame` border.
