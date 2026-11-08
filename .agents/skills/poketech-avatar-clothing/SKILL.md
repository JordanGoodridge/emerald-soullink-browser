---
name: poketech-avatar-clothing
description: Design, pixel-map, color-isolate, and audit new avatar clothing, headwear, and accessories for PokeTech's 4bpp GBA protagonist sprite compositor. Use whenever adding or modifying hats, shirts, jackets, pants, shorts, glasses, masks, halos, scarves, or customizer color channels in character-catalog.mjs and character-compositor.mjs.
---

# PokeTech Avatar Clothing & Sprite Compositor Guide

Use this skill whenever adding or modifying protagonist clothing, headwear, accessories, or color channels in:
- `pokeemerald-3d/web/customization/character-catalog.mjs`
- `pokeemerald-3d/web/customization/character-compositor.mjs`
- `pokeemerald-3d/web/ui/character-customizer-view.mjs`

Every visual bug we previously hit came from three root causes:
1. **Guessing row/column coordinates without auditing the 9 walking + 9 running frames** (vanilla Brendan's top crown actually starts at `y = 10` on idle walk Frame `0`, shifts down by `eyeDy = +1..+3` on step/run frames, and shifts left by `dx = -2` on running West frames `2, 7, 8`).
2. **Vanilla GBA palette sharing across body parts** (e.g. hat outline sharing index `5` with pants, inner tunic chest using `8, 13`, R/S jacket sleeves using bandana green `10, 11`, shoe shading using skin outline `4`, or backpack strap buckles using hat white `14`).
3. **Leaving headband remnants on rows `15..19`** when replacing the cap with non-bandana headwear (`kitten-ears`, `wizard-hat`, `royal-crown`, `dojo-headband`).

---

## 1. Exact 16-Color GBA Palette & Semantic Color Aspects (`gen3-brendan`)

In `pokeemerald-3d/web/customization/character-catalog.mjs` (`BRENDAN_BASE_PALETTE` and `colorAspects`), each hex digit `0..F` maps to a specific palette slot and semantic `aspectId`:

| Hex (`Dec`) | `aspectId` | Default RGB / Role | Rules & Color-Isolation Guardrails |
| :--- | :--- | :--- | :--- |
| `0` (`0`) | *(Transparent)* | `[115, 197, 164]` key | Transparent background. Use `.` in `stampFrameRow(..., { clearDots: true })` to erase existing pixels to `0`. |
| `1, 2, 3, 4` (`1..4`) | `skin` (**Skin Tone**) | `[highlight, mid, shadow, warm-outline]` | Face (`y = 18..21`), hands (`y = 24..26`), bare arms (`sleeveless-vest`). **Gotcha:** Vanilla Brendan uses index `4` on hip/belt (`y = 26..27`) and shoes (`y = 29..30`). `isolateTorsoShirtPixels` and `applyPantsAndShoesTransform` remap those to `8` / `13` when `skin` or `bottom` is customized so changing Skin Tone never recolors shoes or belt! |
| `5` (`5`) | `bottom` (**Pants**) | `[57, 74, 123]` navy | Used for pants (`y = 28`). **Gotcha 1:** Vanilla Brendan uses `5` as the top hat outline (`y = 10..17`); headwear transforms must remap `5 -> 8` on `y <= 21` so Pants color never bleeds into the hat! **Gotcha 2:** Vanilla row `28` pant legs mostly use `4` and interior `15`; `applyPantsAndShoesTransform` maps interior `4`/`15` pixels on row `28` to `5` when a custom `bottom` color is active. |
| `6, 7` (`6, 7`) | `trim` (**2nd Color / Trim**) | `[highlight, shadow]` sakura/gold | Dedicated **secondary color channel** for two-tone items: R/S cap emblem & band, inner kitten ears, wizard hatband & clasp, crown gem & rim, dojo headband wrap, kitty nose, and halo inner glow. Note: `isCustomTrimActive()` in `character-compositor.mjs` activates `6, 7` palette overrides whenever a non-default item or trim color is active. |
| `8` (`8`) | *(Fixed Dark Hair / Outline)* | `[16, 32, 57]` dark navy-black | Fixed dark structural outline, eye pupils (`y = 19..20`), and exposed dark hair (`y = 15..19`). **Never** bind `8` to a customizable aspect or eyes and outlines will change color. |
| `9, E` (`9, 14`) | `head` (**Hat / Hair**) | `[14 = highlight, 9 = shadow]` | Primary color for all headwear (`emerald-hat`, `rs-cap`, `kitten-ears` outer ears, `wizard-hat` spire, `royal-crown` metal, `dojo-headband` spiky hair) and `angel-halo` ring. **Gotcha:** Vanilla Brendan has `E` (`14`) on 6 backpack buckle pixels on `y = 24..25`; `isolateTorsoShirtPixels` remaps `14 -> 10` on `y = 22..27` when `head` is customized. |
| `A, B` (`10, 11`) | `accent` (**Bandana & Bag**) | `[10 = highlight, 11 = shadow]` green | Used for Emerald bandana (`y = 15..17`), backpack (`y = 23..26`), sleeveless shoulder trim, Squirtle shades glint, and `hero-scarf`. **Gotcha:** On the `rs` sheet (`rs-jacket`), the long jacket sleeves use `10, 11`! `applyRsJacketTransform` remaps non-backpack `10, 11 -> 12, 13` on `y = 23..27` so the jacket sleeves match the jacket body (`top`). |
| `C, D` (`12, 13`) | `top` (**Shirt & Shoes**) | `[12 = highlight, 13 = shadow]` red-orange | Used for shirt/jacket/vest (`y = 22..27`) and running shoe accents (`y = 29..30`). **Gotcha:** Vanilla Emerald tunic's center chest (`x = 5..10`, `y = 24..26`) uses `13` and `8`; `isolateTorsoShirtPixels` remaps those to `12` and `13` when `top` is customized so the entire shirt changes color instead of only the sleeves. |
| `F` (`15`) | *(Fixed Black Outline)* | `[0, 0, 0]` black | Outer silhouette outline on lower head, torso, pants, and shoes. |

---

## 2. Exact Frame Layout & Vertical Anatomy (`144 × 32`, 9 Frames of `16 × 32`)

Both `walkingIndexed` and `runningIndexed` sheets contain `9` frames (`f = 0..8`), each `16 × 32` pixels.
`getFrameHeadMetrics(frameIndex, kind)` in `character-catalog.mjs` computes the exact directional and bob offsets for every frame:

- **Direction (`dir`):**
  - `'down'` (South / front): frames `0, 3, 4`
  - `'up'` (North / back): frames `1, 5, 6`
  - `'left'` (West / profile — East is hardware-flipped from West): frames `2, 7, 8`
- **Vertical & Horizontal Offsets (`topDy`, `eyeDy`, `dx`):**
  - `isStep = frameIndex >= 3` (`+1` vertical bob on step frames `3..8`)
  - `isRun = kind === 'runningIndexed'` (`+1` vertical bob on all running frames, plus an extra `+1` on `eyeDy` when `isRun && dir === 'down'`)
  - `dx = isRun && dir === 'left' ? -2 : 0` (running West frames `2, 7, 8` lean `2px` left!)

### Vertical Body Zones on Walking Frame `0` (`eyeDy = 0, dx = 0`)

| Row Range (`y`) | Body Zone | Key Landmarks on Idle Walk Frame `0` |
| :--- | :--- | :--- |
| `y = 0..9` | Above-Head Air | Empty (`0`) in vanilla Brendan. Used by tall spires (`wizard-hat` starts at `y = 8`, `angel-halo` at `y = 7` or `y = 3` above wizard spire). |
| `y = 10..14` | Upper Cap / Crown | Vanilla white cap dome (`E = 14` highlight, `9` shadow, `5` outline). |
| `y = 15..17` | Bandana / Forehead | Vanilla green headband (`A = 10`, `B = 11`) and white/shadow emblem (`E = 14`, `9`). **CRITICAL:** Any headwear that removes the cap/bandana (`kitten-ears`, `wizard-hat`, `royal-crown`, `dojo-headband`) MUST overwrite rows `9..17` (and `18..19` on `'up'`/`'left'` frames) with `clearDots: true` and replace headband rows `15..17` with sleek dark hair (`F8888888888F`) so zero green `A/B` pixels survive! |
| `y = 18..21` | Face, Eyes & Cheeks | Eyes are at `y = 19..20`, `x = 6` and `x = 9` (`8` pupil) on `'down'` frames, and at `x = 5` on `'left'` frames. Nose/mouth area is `y = 20..21`, `x = 7..8`. |
| `y = 22..27` | Neck, Torso, Arms & Bag | Collar (`y = 22..23`), sleeves & hands (`x = 1..4` and `11..14`, `y = 23..26`), chest (`x = 5..10`, `y = 23..26`), belt/hips (`y = 26..27`). |
| `y = 28` | Pants / Legs | Pant legs (`y = 28`, mapped to `5` by `applyPantsAndShoesTransform`). |
| `y = 29..30` | Shoes / Boots | Shoe uppers (`C = 12`, `D = 13`), green/grey tongue (`A = 10`), and black sole (`F = 15`). |
| `y = 31` | Ground Baseline | Step frames drop 1px onto `y = 31` (`F = 15`). |

---

## 3. Contextual Per-Item Color Channels (`colorChannels`)

Every item in `clothingSlots` (`head`, `top`, `bottom`, `accessory`) in `pokeemerald-3d/web/customization/character-catalog.mjs` MUST define a `colorChannels` array:

```js
{
  id: 'kitten-ears',
  label: 'Kitten Ears',
  description: 'Perked-up neko ears headband with pink inner ear tufts',
  sourceSheet: 'emerald',
  transform: applyKittenEarsTransform,
  colorChannels: [
    { aspectId: 'head', label: 'Outer Ears' },
    { aspectId: 'trim', label: 'Inner Ears' },
  ],
}
```

- `character-customizer-view.mjs` reads `item.colorChannels` for the currently equipped item in the active category tab and renders **only** those color tabs with their item-specific `label` (e.g. `Outer Ears` + `Inner Ears`, `Wizard Hat` + `Hatband & Clasp`, `Crown Metal` + `Crown Gem & Rim`).
- Always use `trim` (`[6, 7]`) for an item's secondary/detail color so it stays 100% independent of `top` (`[12, 13]`), `bottom` (`[5]`), and `accent` (`[10, 11]`).

---

## 4. Step-by-Step Workflow & CLI Audit

1. **Inspect existing sprite pixels and zone histograms** using the bundled CLI script:
   ```powershell
   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs --slot head --item kitten-ears
   ```
   Pass `--sheet running` or `--frames 9` to inspect all 9 walking or running frames.
2. **Author the pixel transform in `pokeemerald-3d/web/customization/character-catalog.mjs`:**
   - For headwear or accessories that stamp pixel art across frames, use `stampDirectionalRows(indexed, width, height, kind, { down: [...], up: [...], left: [...] }, { clearDots: true })`.
   - In 16-character pattern strings:
     - `.` = clear to transparent `0` (when `clearDots: true`) or skip (when `clearDots: false`)
     - `' '` (space) = preserve existing underlying sprite pixel
     - `'0'..'F'` = write hex palette index (`E`/`9` for `head`, `6`/`7` for `trim`, `C`/`D` for `top`, `A`/`B` for `accent`, `5` for `bottom`, `1..4` for `skin`, `8`/`F` for dark hair/outline)
3. **Register the item and its `colorChannels`** in `createGen3BrendanRig()` inside `pokeemerald-3d/web/customization/character-catalog.mjs`.
4. **Audit the new item with `audit-sprite.mjs`:**
   ```powershell
   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs --slot <slot> --item <new-item-id> --frames 9
   node .agents/skills/poketech-avatar-clothing/scripts/audit-sprite.mjs --slot <slot> --item <new-item-id> --sheet running --frames 9
   ```
   Verify in the `Frame 0 Palette Index Histogram by Vertical Zone` output that:
   - `headZone_y0_21` has **zero** stray `A(10)` / `B(11)` headband pixels if the item replaces the bandana, and **zero** `C(12)` / `D(13)` shirt pixels or `5` pants pixels.
   - `torsoZone_y22_27` and `legsZone_y28` only use their intended palette indices.
5. **Run the unit test suite:**
   ```powershell
   node --test --test-reporter=dot pokeemerald-3d/web/customization/*.test.mjs pokeemerald-3d/web/ui/*.test.mjs
   ```
