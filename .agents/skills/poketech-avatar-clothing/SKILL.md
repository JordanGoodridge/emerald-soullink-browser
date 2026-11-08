---
name: poketech-avatar-clothing
description: Design, pixel-map, color-isolate, and audit new avatar clothing, headwear, and accessories for PokeTech's 4bpp GBA protagonist sprite compositor. Use whenever adding or modifying hats, shirts, jackets, pants, shorts, glasses, masks, halos, scarves, or customizer color channels in character-catalog.mjs and character-compositor.mjs.
---

# PokeTech Avatar Clothing & Sprite Compositor Guide

Use this skill whenever adding or modifying protagonist clothing, headwear, accessories, or color channels in:
- `pokeemerald-3d/web/customization/character-catalog.mjs`
- `pokeemerald-3d/web/customization/character-compositor.mjs`
- `pokeemerald-3d/web/ui/character-customizer-view.mjs`

Every mistake we previously hit came from three traps:
1. **Guessing row/column coordinates without auditing the 9 walking + 9 running frames** (running frames shift the head down by `dy = +1` or `+2` and shift the face horizontally on side frames).
2. **Reusing shared GBA palette indices across unrelated body parts** (e.g. putting inner kitten ears on shirt orange `8`, or leaving upper sleeves on hat indices `10/11`, or leaving headband side pixels on `4/5`).
3. **Forgetting to declare contextual `colorChannels` on the catalog item**, leaving the UI with missing or generic color pickers.

---

## 1. The 16-Color GBA Palette & Semantic Color Aspects (`gen3-brendan`)

The GBA protagonist sprite uses a single 16-color (4bpp) palette where index `0` is transparent. Because vanilla Brendan shares several colors across body parts, `preIsolateSheetColors()` in `character-compositor.mjs` runs **before** any clothing transform to separate vanilla shared colors.

### Exact Palette Index Map (Post-Isolation)

| Palette Indices | Semantic Aspect (`colorAspects`) | Default BGR555 / Usage | Rules & Guardrails |
| :--- | :--- | :--- | :--- |
| `0` | *(Transparent)* | Transparent background | Never draw opaque pixels with `0`. |
| `1, 2` | `skin` (**Skin Tone**) | `[light, shadow]` peach skin | **Strictly skin** (face, hands, bare legs, neck). `preIsolateSheetColors` remaps hat/shoe highlights off `1, 2` onto `12` (`WHITE_ACCENT`). |
| `3` | *(Fixed Dark Brown)* | Hair / eyebrows / backpack strap | Use for dark hair, eyebrows, or dark visor rims when `15` is too harsh. |
| `4, 5` | `bottom` (**Pants & Shorts**) | `[mid, dark]` teal-grey | Used for pants (`y: 23..28`) and shorts. **Gotcha:** Vanilla Brendan also uses `4, 5` for his dark headband on rows `9..16`! Headwear transforms that replace the headband MUST erase `4, 5` on rows `9..16`. |
| `6, 7` | `trim` (**2nd Color / Trim**) | `[light, shadow]` gold/amber | Dedicated **secondary color channel** for two-tone items: inner kitten ears, wizard hatband/buckle, crown jewels, headband tie/sun, glasses lenses, scarf fringe, jacket collar/hem, cargo pockets. |
| `8, 9` | `top` (**Shirt & Shoes**) | `[light, shadow]` red-orange | Used for torso shirt (`y: 17..23`), upper sleeves (`y: 17..19`), and shoe accents (`y: 27..31`). |
| `10, 11` | `hat` (**Hat / Hair / Ears**) | `[light, shadow]` white/silver | Primary color for headwear (`head` slot) and primary color for single-color accessories when appropriate (or pair with `6, 7`). **Gotcha:** `preIsolateSheetColors` remaps shoe soles (`y >= 26`) off `10, 11` to `12, 13` so hat colors never bleed into shoes. |
| `12` | *(Fixed Pure White)* | `WHITE_ACCENT` | Used for eye sclera (`y: 13..16`), headband emblem, and shoe sole highlights (`y >= 26`). Do **not** bind `12` to a customizable aspect or eyes will change color! |
| `13, 14` | *(Fixed Mid/Light Grey)* | Neutral grey shading | Safe neutral greys for shoe soles (`y >= 26`) or metallic accents that should stay fixed. |
| `15` | `outline` (**Outline**) | Near-black (`#182820`) | Sprite silhouette outline and eye pupils. |

---

## 2. Frame Layout & Anatomy Map (`144 × 32`, 9 Frames of `16 × 32`)

Both `walking` and `running` sheets are `144 × 32` (`9` frames × `16 × 32` pixels):

| Frame Index | Pose | Facing Direction | Head Bob (`dy`) vs Frame 0 | Horizontal Face Shift (`dx`) |
| :--- | :--- | :--- | :--- | :--- |
| **Walking `0`** | Idle South | `south` (front) | `dy = 0` | `dx = 0` |
| **Walking `1`** | Idle North | `north` (back) | `dy = 0` | `dx = 0` |
| **Walking `2`** | Idle West | `west` (left profile) | `dy = 0` | `dx = 0` |
| **Walking `3, 4`** | Step South 1 & 2 | `south` (front) | `dy = +1` | `dx = 0` |
| **Walking `5, 6`** | Step North 1 & 2 | `north` (back) | `dy = +1` | `dx = 0` |
| **Walking `7, 8`** | Step West 1 & 2 | `west` (left profile) | `dy = +1` | `dx = 0` |
| **Running `0`** | Run Idle South | `south` (front) | `dy = +1` | `dx = 0` |
| **Running `1`** | Run Idle North | `north` (back) | `dy = +1` | `dx = 0` |
| **Running `2`** | Run Idle West | `west` (left profile) | `dy = +1` | `dx = -1` (head leans left!) |
| **Running `3, 4`** | Run Step South | `south` (front) | `dy = +2` | `dx = 0` |
| **Running `5, 6`** | Run Step North | `north` (back) | `dy = +1` (`f5`), `+2` (`f6`) | `dx = 0` |
| **Running `7, 8`** | Run Step West | `west` (left profile) | `dy = +2` | `dx = -1` (head leans left!) |

*(East-facing sprites are generated automatically by hardware horizontal flip of the West frames `2, 7, 8`.)*

### Dynamic Anchor Helpers in `character-compositor.mjs`
**NEVER hardcode fixed `y` rows across all 9 frames for headwear or face accessories.** Always use the dynamic frame helpers in `character-compositor.mjs`:
- `findTopCrownRow(indices, frameIndex)`: Scans `y = 2..14` for the topmost non-transparent row of the head in that specific frame (`topY = 4` in walk idle, `5` in walk step / run idle, `6` in run step).
- `findEyeRow(indices, frameIndex)`: Scans `y = 11..17` for the row with eye sclera (`12`) + pupil (`15`), accurately tracking the eye level across every walk/run frame.
- `getFrameFacing(frameIndex)`: Returns `'south'` (`0, 3, 4`), `'north'` (`1, 5, 6`), or `'west'` (`2, 7, 8`).

### Vertical Body Zones (Relative to Idle Walk Frame `0`, `topY = 4`)
- **Rows `0..3`:** Above-head clearance (used by tall hats like `wizard-hat`, `halo`, `kitten-ears` tips).
- **Rows `4..8` (`topY .. topY + 4`):** Hat crown / hair tuft (`10, 11`, outlined in `15`).
- **Rows `9..12` (`topY + 5 .. topY + 8`):** Forehead & headband (`4, 5, 12`).
  - **CRITICAL HEADWEAR RULE:** Any `head` transform that removes or replaces Brendan's headband (`hair-tuft`, `kitten-ears`, `crown`, `wizard-hat`) MUST call `stripHeadbandAndLowerCap(indices, frameIndex, topY)` so dark headband pixels (`4, 5`) on rows `topY + 5 .. topY + 11` (including sideburn/ear-level pixels on rows `13..15`) are converted to hair (`3`) or skin (`1, 2`) instead of changing color when the player changes their **Pants (`4, 5`)**!
- **Rows `13..16` (`eyeY .. eyeY + 2`):** Eyes (`12` sclera, `15` pupil), nose/cheeks (`1, 2`), and side ears.
  - On `south` frames (`0, 3, 4`), eyes are at `x = 5..6` and `x = 9..10`, nose bridge is `x = 7..8`.
  - On `west` frames (`2, 7, 8`), the face points left (`x = 3..7` on walk, `x = 2..6` on run). Never draw front-facing symmetrical glasses/whiskers on `west` or `north` frames!
- **Rows `17..23`:** Torso, shoulders, and arms (`top` slot).
  - Center shirt/zipper is on `8, 9` and `4, 5, 15`, while **upper sleeves (`y = 17..19`, `x = 2..4` and `11..13`)** use `10, 11` in vanilla Brendan so his sleeves match his white hat crest.
  - **CRITICAL TOP RULE:** Any `top` transform (`shirt`, `rs-jacket`, `hoodie`, `sleeveless`) must recolor or remap those upper sleeve pixels (`10, 11` on `y = 17..20`) onto `8, 9` (or `1, 2` skin for `sleeveless`, or `6, 7` trim for `rs-jacket`) so changing the **Hat (`10, 11`)** does not recolor the player's sleeves!
- **Rows `23..28`:** Legs / pants / shorts (`bottom` slot, `4, 5`).
  - **CRITICAL BOTTOM RULE:** Include down to `y = 28` (`y >= 23 && y <= 28`) when transforming pants/cuffs (`pants`, `shorts`, `cargo`)—stopping at `y = 26` leaves row `27..28` cuff pixels stuck on default teal-grey.
- **Rows `28..31`:** Running shoes (`8, 9` uppers, `12, 13` soles).

---

## 3. Contextual Color Channels (`colorChannels` in `character-catalog.mjs`)

Every clothing item in `slots.head.items`, `slots.top.items`, `slots.bottom.items`, and `slots.accessory.items` MUST declare its own `colorChannels` array in `pokeemerald-3d/web/customization/character-catalog.mjs`:

```js
{
  id: 'kitten-ears',
  label: 'Kitten Ears',
  transform: 'kitten-ears',
  colorChannels: [
    { aspectId: 'hat', label: 'Outer Ears' },
    { aspectId: 'trim', label: 'Inner Ears' },
  ],
}
```

### Rules for `colorChannels`:
1. **1-color items** declare `[{ aspectId: '...', label: '...' }]` (e.g. `Classic Shirt` $\rightarrow$ `[{ aspectId: 'top', label: 'Shirt & Shoes' }]`). The UI automatically shows a single contextual swatch palette for that item.
2. **2-color items** use their primary slot aspect (`hat`, `top`, or `bottom`) for the main body and `trim` (`[6, 7]`) for the secondary accent/lining/lenses, with item-specific labels (e.g. `Wizard Hat` + `Hatband & Clasp`, `Jacket Body` + `Collar & Trim`, `Frames` + `Lens Tint`).
3. **0-color items** (like `accessory: 'none'`) declare `colorChannels: []`, and the UI falls back to `Skin Tone` + `Outline`.

---

## 4. Step-by-Step Procedure for Adding a New Clothing Item

1. **Inspect the base frames first** using the audit script:
   ```powershell
   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs
   ```
2. **Pick the slot & palette channels:**
   - Primary pixels $\rightarrow$ `10, 11` (`hat`), `8, 9` (`top`), or `4, 5` (`bottom`).
   - Secondary / trim pixels $\rightarrow$ `6, 7` (`trim`).
   - Outline pixels $\rightarrow$ `15` (`outline`).
3. **Write the transform in `pokeemerald-3d/web/customization/character-compositor.mjs`:**
   - Branch by `facing = getFrameFacing(frameIndex)` (`south`, `north`, `west`) so front details (faces, buckles, ties, glasses) only appear on the appropriate side(s) and West frames align with the profile (`dx = -1` on running West frames `2, 7, 8`).
   - Anchor vertical coordinates to `findTopCrownRow(indices, frameIndex)` or `findEyeRow(indices, frameIndex)` instead of fixed `y` numbers.
   - If it's a `head` item replacing the cap/headband, call `stripHeadbandAndLowerCap(indices, frameIndex, topY)` first.
4. **Register the item and its `colorChannels` in `pokeemerald-3d/web/customization/character-catalog.mjs`.**
5. **Run the automated pixel & color-isolation audit script** on your new item ID to verify:
   - Every frame (`0..8` walk and `0..8` run) has clean silhouettes in ASCII dump.
   - Changing `hat`, `top`, `bottom`, `trim`, `skin`, and `outline` only affects the intended pixels of that item and never leaks into unrelated body parts.
6. **Add a unit test** in `pokeemerald-3d/web/customization/character-compositor.test.mjs` and run:
   ```powershell
   node --test --test-reporter=dot pokeemerald-3d/web/customization/*.test.mjs pokeemerald-3d/web/ui/*.test.mjs
   ```
