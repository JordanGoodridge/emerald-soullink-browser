// Plug-and-play character customization catalog & multi-game rig registry.
//
// Each protagonist rig ('gen3-brendan', 'gen3-red', etc.) declares:
//   - basePalette: 16 RGB triples ([r, g, b]) matching the engine's 4bpp palette
//   - reflectionPalette: 16 RGB triples for water/pond reflections
//   - sheets: named 4bpp sprite sheet sources (base64 or external PNG URLs)
//   - colorAspects: colorable sprite regions mapped to specific palette indices
//   - clothingSlots: equippable clothing slots ('head', 'top', 'bottom', etc.)
//
// Game packs can share a base rig (e.g. Emerald and Emerald Kaizo both use
// 'gen3-brendan') or extend a rig with game-exclusive clothing pieces and
// color swatches via extendCharacterRigForGame().

import {
  BRENDAN_EMERALD_RUN_4BPP_B64,
  BRENDAN_EMERALD_WALK_4BPP_B64,
  BRENDAN_RS_RUN_4BPP_B64,
  BRENDAN_RS_WALK_4BPP_B64,
} from './brendan-sheets-data.mjs';

export const DEFAULT_RIG_ID = 'gen3-brendan';

const BRENDAN_BASE_PALETTE = Object.freeze([
  Object.freeze([115, 197, 164]), // 0: Transparency key
  Object.freeze([255, 213, 180]), // 1: Skin highlight
  Object.freeze([255, 197, 148]), // 2: Skin midtone
  Object.freeze([222, 148, 115]), // 3: Skin shadow
  Object.freeze([123, 65, 65]),   // 4: Skin / face warm outline
  Object.freeze([57, 74, 123]),   // 5: Pants / underlayer highlight
  Object.freeze([41, 57, 98]),    // 6: Pants / underlayer midtone
  Object.freeze([24, 41, 82]),    // 7: Pants / underlayer shadow
  Object.freeze([16, 32, 57]),    // 8: Structural dark outline
  Object.freeze([222, 230, 238]), // 9: Hat shadow
  Object.freeze([115, 205, 115]), // 10: Bandana / bag / accent highlight
  Object.freeze([74, 148, 82]),   // 11: Bandana / bag / accent shadow
  Object.freeze([255, 98, 90]),   // 12: Shirt / top & shoes highlight
  Object.freeze([197, 65, 65]),   // 13: Shirt / top & shoes shadow
  Object.freeze([255, 255, 255]), // 14: Hat highlight / white
  Object.freeze([0, 0, 0]),       // 15: Black outline
]);

const BRENDAN_REFLECTION_PALETTE = Object.freeze([
  Object.freeze([148, 230, 230]),
  Object.freeze([255, 238, 213]),
  Object.freeze([255, 213, 213]),
  Object.freeze([238, 180, 180]),
  Object.freeze([172, 156, 164]),
  Object.freeze([164, 164, 180]),
  Object.freeze([106, 123, 148]),
  Object.freeze([106, 123, 148]),
  Object.freeze([123, 131, 131]),
  Object.freeze([238, 238, 255]),
  Object.freeze([164, 246, 156]),
  Object.freeze([123, 205, 123]),
  Object.freeze([255, 156, 156]),
  Object.freeze([230, 123, 139]),
  Object.freeze([255, 255, 255]),
  Object.freeze([106, 115, 106]),
]);

export function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

export function snapGbaChannel(value) {
  const c5 = Math.max(0, Math.min(31, Math.round(clampChannel(value) * 31 / 255)));
  return Math.round((c5 * 255) / 31);
}

export function hexToRgb(hex) {
  const text = String(hex ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return [
    Number.parseInt(text.slice(0, 2), 16),
    Number.parseInt(text.slice(2, 4), 16),
    Number.parseInt(text.slice(4, 6), 16),
  ];
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => clampChannel(v).toString(16).padStart(2, '0')).join('')}`;
}

export function normalizeHexColor(hex, fallback = '#ff625a') {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : fallback.toLowerCase();
}

/**
 * Generates a pixel-art shading ramp ([highlight, midtone, shadow, ...]) from a
 * single hex color, snapping each stop to GBA 5-bit color steps.
 */
export function buildColorRamp(hex, stops = 2, {
  factors = null,
} = {}) {
  const base = hexToRgb(hex) ?? [255, 98, 90];
  const count = Math.max(1, Number(stops) || 2);
  const defaultFactors = count === 1
    ? [[1, 0]]
    : count === 2
      ? [[1.0, 0], [0.74, -8]]
      : count === 3
        ? [[1.0, 0], [0.78, -4], [0.56, -10]]
        : [[1.06, 10], [1.0, 0], [0.84, -10], [0.48, -20]];
  const activeFactors = Array.isArray(factors) && factors.length === count ? factors : defaultFactors;
  return activeFactors.map(([mul, add = 0]) => [
    snapGbaChannel(base[0] * mul + add),
    snapGbaChannel(base[1] * mul + add),
    snapGbaChannel(base[2] * mul + add),
  ]);
}

// Sleeveless vest pixel transform: converts the outer short-sleeve shirt pixels
// (indices 12, 13) on the torso rows into bare arms (skin indices 1, 2) while
// adding an accent trim (index 10) at the vest shoulder edge.
function applySleevelessVestTransform(indexed, width = 144, height = 32) {
  const frames = Math.floor(width / 16);
  for (let f = 0; f < frames; f++) {
    const fx = f * 16;
    for (let y = 22; y <= 26 && y < height; y++) {
      for (let x = 0; x < 16; x++) {
        const idx = y * width + fx + x;
        const val = indexed[idx];
        const isOuterArm = x <= 4 || x >= 11;
        if (isOuterArm && (val === 12 || val === 13)) {
          indexed[idx] = val === 12 ? 1 : 2;
        } else if ((x === 5 || x === 10) && y === 23 && (val === 12 || val === 13)) {
          indexed[idx] = 10;
        }
      }
    }
  }
}

function getFrameHeadMetrics(frameIndex, kind = 'walkingIndexed') {
  const dir = (frameIndex === 0 || frameIndex === 3 || frameIndex === 4)
    ? 'down'
    : (frameIndex === 1 || frameIndex === 5 || frameIndex === 6)
      ? 'up'
      : 'left';
  const isStep = frameIndex >= 3;
  const isRun = kind === 'runningIndexed';
  const topDy = (isRun ? 1 : 0) + (isStep ? 1 : 0);
  const eyeDy = topDy + (isRun && dir === 'down' ? 1 : 0);
  const dx = isRun && dir === 'left' ? -2 : 0;
  return { dir, isStep, isRun, topDy, eyeDy, dx };
}

// Stamps a 16-char pattern string ('.' = transparent/clear when clearDots=true,
// space ' ' = leave existing pixel untouched, '0'..'F' = hex palette index)
// onto a specific row of a 16x32 frame with horizontal shift dx.
function stampFrameRow(indexed, width, height, frameIndex, y, pattern, {
  dx = 0,
  clearDots = false,
} = {}) {
  if (y < 0 || y >= height) return;
  const fx = frameIndex * 16;
  for (let x = 0; x < 16 && x < pattern.length; x++) {
    const ch = pattern[x];
    if (ch === ' ') continue;
    const dstX = x + dx;
    if (dstX < 0 || dstX >= 16) continue;
    if (ch === '.') {
      if (clearDots) indexed[y * width + fx + dstX] = 0;
      continue;
    }
    const colorIndex = Number.parseInt(ch, 16);
    if (!Number.isNaN(colorIndex)) {
      indexed[y * width + fx + dstX] = colorIndex & 0x0f;
    }
  }
}

function stampDirectionalRows(indexed, width, height, kind, rowsByDir, {
  clearDots = true,
} = {}) {
  const frames = Math.floor(width / 16);
  for (let f = 0; f < frames; f++) {
    const { dir, eyeDy, dx } = getFrameHeadMetrics(f, kind);
    const rows = rowsByDir[dir] ?? rowsByDir.down ?? [];
    for (const [baseY, pattern] of rows) {
      stampFrameRow(indexed, width, height, f, baseY + eyeDy, pattern, {
        dx,
        clearDots,
      });
    }
  }
}

// Emerald Bandana Hat transform: when the player picks a custom 2nd Color / Trim,
// remaps the head bandana pixels (10/11) to trim indices (6/7) on head rows so
// the bandana can be recolored independently of the backpack.
function applyEmeraldHatTransform(indexed, width = 144, height = 32, _kind = 'walkingIndexed', normalized = null) {
  const trimHex = normalizeHexColor(normalized?.colors?.trim, '#ff94c2');
  if (trimHex === '#ff94c2') return;
  const maxOffset = Math.min(height, 22) * width;
  for (let i = 0; i < maxOffset; i++) {
    if (indexed[i] === 10) indexed[i] = 6;
    else if (indexed[i] === 11) indexed[i] = 7;
  }
}

// Ruby / Sapphire Cap transform: remaps the front cap emblem pixels (12/13) on
// the head rows to trim indices (6/7) so Shirt & Shoes never bleeds into the cap
// and 2nd Color / Trim controls the emblem color.
function applyRsCapTransform(indexed, width = 144, height = 32) {
  const maxOffset = Math.min(height, 22) * width;
  for (let i = 0; i < maxOffset; i++) {
    if (indexed[i] === 12) indexed[i] = 6;
    else if (indexed[i] === 13) indexed[i] = 7;
  }
}

// Kitten Ears transform: removes the bulky white cap and green headband,
// lowering the crown roof to row 14 so two tall, unmistakable 4px triangular
// cat ears rise cleanly above sleek dark hair (index 8) and parted bangs.
// Uses F/8 (fixed dark outlines/hair), E/9 (Hat / Hair 1st color), and 6/7
// (2nd Color / Trim for inner ear tufts) so Shirt & Shoes (C/D) never bleed in.
function applyKittenEarsTransform(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  stampDirectionalRows(indexed, width, height, kind, {
    down: [
      [9,  '................'],
      [10, '..88........88..'],
      [11, '.8EE8......8EE8.'],
      [12, '.8E6E8....8E6E8.'],
      [13, '.8E67E8888E76E8.'],
      [14, '..89EEEEEEEE98..'],
      [15, '..F8888888888F..'],
      [16, '..F8888888888F..'],
      [17, '.43888111188834.'],
    ],
    up: [
      [9,  '................'],
      [10, '..88........88..'],
      [11, '.8EE8......8EE8.'],
      [12, '.8E9E8....8E9E8.'],
      [13, '.8999E8888E9998.'],
      [14, '..899EEEEEE998..'],
      [15, '..F8888888888F..'],
      [16, '..F8888888888F..'],
      [17, '..F8888888888F..'],
      [18, '.43F88888888F34.'],
      [19, '.43488888888434.'],
    ],
    left: [
      [9,  '................'],
      [10, '...88...88......'],
      [11, '..8EE8.8EE8.....'],
      [12, '..8E68.8E6E8....'],
      [13, '..89988E67E98...'],
      [14, '..89EEEEEEEE98..'],
      [15, '..F8888888888F..'],
      [16, '..F8888888888F..'],
      [17, '..48888888888F..'],
    ],
  }, { clearDots: true });
}

// Mystic Wizard Hat transform: tall curved spellcaster spire (E/9 Hat color),
// 2nd Color / Trim ribbon band (6/7) with a center clasp, and a wide
// 16px flared brim using fixed dark outlines (8/F) instead of Pants index 5.
function applyWizardHatTransform(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  stampDirectionalRows(indexed, width, height, kind, {
    down: [
      [6,  '.........88.....'],
      [7,  '........8EE8....'],
      [8,  '.......8EEE98...'],
      [9,  '......8EEEE98...'],
      [10, '.....8EEEEE98...'],
      [11, '....8EEEEEE998..'],
      [12, '...8EEEEEEE998..'],
      [13, '...89999999998..'],
      [14, '..86667EE76668..'],
      [15, '..87777EE77778..'],
      [16, '.F8EEEEEEEEEE8F.'],
      [17, 'FF9999EEEE9999FF'],
    ],
    up: [
      [6,  '.....88.........'],
      [7,  '....8EE8........'],
      [8,  '...89EEE8.......'],
      [9,  '...89EEEE8......'],
      [10, '...89EEEEE8.....'],
      [11, '..899EEEEEE8....'],
      [12, '..899EEEEEEE8...'],
      [13, '..89999999998...'],
      [14, '..866666666668..'],
      [15, '..877777777778..'],
      [16, '.F899EEEEEE998F.'],
      [17, 'FF999999999999FF'],
    ],
    left: [
      [6,  '..........88....'],
      [7,  '........88EE8...'],
      [8,  '.......8EEEE8...'],
      [9,  '......8EEEEE98..'],
      [10, '.....8EEEEEE98..'],
      [11, '....8EEEEEEE998.'],
      [12, '...8EEEEEEEE998.'],
      [13, '...899999999998.'],
      [14, '..8666666666668.'],
      [15, '..8777777777778.'],
      [16, '.F8EEEEEEEEEEE8F'],
      [17, 'FF999999999999FF'],
    ],
  }, { clearDots: true });
}

// Champion Crown transform: three-spiked royal coronet colored by Hat / Hair (E/9)
// with a 2nd Color / Trim center jewel and base rim (6/7) atop natural dark hair (8/F).
function applyRoyalCrownTransform(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  stampDirectionalRows(indexed, width, height, kind, {
    down: [
      [9,  '................'],
      [10, '................'],
      [11, '..8....88....8..'],
      [12, '.8E8..8EE8..8E8.'],
      [13, '.8EE88EEEE88EE8.'],
      [14, '..899E6666E998..'],
      [15, '..F7777777777F..'],
      [16, '..F8888888888F..'],
      [17, '.43888111188834.'],
    ],
    up: [
      [9,  '................'],
      [10, '................'],
      [11, '..8....88....8..'],
      [12, '.8E8..8EE8..8E8.'],
      [13, '.8EE88EEEE88EE8.'],
      [14, '..899EEEEEE998..'],
      [15, '..F7777777777F..'],
      [16, '..F8888888888F..'],
      [17, '..F8888888888F..'],
      [18, '.43F88888888F34.'],
      [19, '.43488888888434.'],
    ],
    left: [
      [9,  '................'],
      [10, '................'],
      [11, '..8...8....8....'],
      [12, '.8E8.8E8..8E8...'],
      [13, '.8EE8EEE88EE8...'],
      [14, '..8E6EEEEEE98...'],
      [15, '..F777777777F...'],
      [16, '..F8888888888F..'],
      [17, '..48888888888F..'],
    ],
  }, { clearDots: true });
}

// Dojo Headband transform: spiky hair colored by Hat / Hair (E/9) with dark
// outlines (8/F) and a 2-row tied martial-arts headband colored by 2nd Color / Trim (6/7).
function applyDojoHeadbandTransform(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  stampDirectionalRows(indexed, width, height, kind, {
    down: [
      [9,  '................'],
      [10, '................'],
      [11, '.....88..88.....'],
      [12, '...88EE88EE88...'],
      [13, '..8EE9EEEE9EE8..'],
      [14, '..899999999998..'],
      [15, '..F6666666666F..'],
      [16, '..F7777777777F..'],
      [17, '.43888111188834.'],
    ],
    up: [
      [9,  '................'],
      [10, '................'],
      [11, '.....88..88.....'],
      [12, '...88EE88EE88...'],
      [13, '..8EE9EEEE9EE8..'],
      [14, '..899999999998..'],
      [15, '..F6666FF6666F..'],
      [16, '..F7777667777F..'],
      [17, '..F8887667888F..'],
      [18, '.43F88788788F34.'],
      [19, '.43488888888434.'],
    ],
    left: [
      [9,  '................'],
      [10, '................'],
      [11, '....88..88......'],
      [12, '..88EE88EE88....'],
      [13, '..8EE9EEEEEE8...'],
      [14, '..89999999998...'],
      [15, '..F6666666666868'],
      [16, '..F7777777777878'],
      [17, '..48888888888F..'],
    ],
  }, { clearDots: true });
}

// Kitty Nose & Whiskers accessory overlay: places a 2px button nose (index 6,
// 2nd Color / Trim) between the eyes (x=7..8) and dark whisker ticks (F) on the cheeks.
function applyCatWhiskersAccessory(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  const frames = Math.floor(width / 16);
  for (let f = 0; f < frames; f++) {
    const { dir, isRun, topDy, dx } = getFrameHeadMetrics(f, kind);
    if (dir === 'down') {
      stampFrameRow(indexed, width, height, f, 20 + topDy, '  F    66    F  ', { dx, clearDots: false });
      if (isRun) {
        stampFrameRow(indexed, width, height, f, 21 + topDy, '      2  2      ', { dx, clearDots: false });
      }
    } else if (dir === 'left') {
      stampFrameRow(indexed, width, height, f, 20 + topDy, '  6   F         ', { dx, clearDots: false });
    }
  }
}

// Squirtle Squad Shades accessory overlay: sleek 2-row sunglasses across the eye
// rows with a visible nose bridge (11), white lens glint (E), and 2nd Color / Trim lens tint (7).
function applyCoolShadesAccessory(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  const frames = Math.floor(width / 16);
  for (let f = 0; f < frames; f++) {
    const { dir, isRun, topDy, dx } = getFrameHeadMetrics(f, kind);
    if (dir === 'down') {
      stampFrameRow(indexed, width, height, f, 19 + topDy, '  FFFFFFFFFFFF  ', { dx, clearDots: false });
      stampFrameRow(indexed, width, height, f, 20 + topDy, '   FE7F11FE7F   ', { dx, clearDots: false });
      if (isRun) {
        stampFrameRow(indexed, width, height, f, 21 + topDy, '      2  2      ', { dx, clearDots: false });
      }
    } else if (dir === 'left') {
      stampFrameRow(indexed, width, height, f, 19 + topDy, '  FFFFFFF       ', { dx, clearDots: false });
      stampFrameRow(indexed, width, height, f, 20 + topDy, '  FE7F          ', { dx, clearDots: false });
    }
  }
}

// Floating Halo accessory overlay: delicate 2-row luminous ring hovering just
// above the head (outer ring E, inner glow 6 from 2nd Color / Trim).
function applyAngelHaloAccessory(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  const frames = Math.floor(width / 16);
  for (let f = 0; f < frames; f++) {
    const { dir, eyeDy, dx } = getFrameHeadMetrics(f, kind);
    const fx = f * 16;
    let hasTallSpire = false;
    const checkY = 8 + eyeDy;
    if (checkY >= 0 && checkY < height) {
      for (let x = 4; x < 12; x++) {
        if (indexed[checkY * width + fx + x] !== 0) {
          hasTallSpire = true;
          break;
        }
      }
    }
    const baseY = (hasTallSpire ? 3 : 7) + eyeDy;
    const shiftX = dx + (dir === 'left' ? -1 : 0);
    stampFrameRow(indexed, width, height, f, baseY, '    8EEEEEE8    ', { dx: shiftX, clearDots: true });
    stampFrameRow(indexed, width, height, f, baseY + 1, '   8E66..66E8   ', { dx: shiftX, clearDots: true });
  }
}

// Champion Scarf accessory overlay: wraps a 2nd Color / Trim scarf (6/7) with
// fixed dark outline (8) around the neck and collar.
function applyHeroScarfAccessory(indexed, width = 144, height = 32, kind = 'walkingIndexed') {
  stampDirectionalRows(indexed, width, height, kind, {
    down: [
      [22, '   8666666668   '],
      [23, '   8777766678   '],
      [24, '        8678    '],
    ],
    up: [
      [22, '   8666666668   '],
      [23, '   8777766678   '],
      [24, '       86678    '],
    ],
    left: [
      [22, '   866666668    '],
      [23, '    8777766678  '],
      [24, '         866778 '],
    ],
  }, { clearDots: false });
}

function createGen3BrendanRig() {
  return {
    id: 'gen3-brendan',
    label: 'Brendan',
    gender: 'male',
    appearanceKey: 'brendan.on-foot',
    frameWidth: 16,
    frameHeight: 32,
    frameCount: 9,
    basePalette: BRENDAN_BASE_PALETTE.map((c) => [...c]),
    reflectionPalette: BRENDAN_REFLECTION_PALETTE.map((c) => [...c]),
    sheets: {
      emerald: {
        walking4bppB64: BRENDAN_EMERALD_WALK_4BPP_B64,
        running4bppB64: BRENDAN_EMERALD_RUN_4BPP_B64,
        walkingUrl: '/graphics/object_events/pics/people/brendan/walking.png',
        runningUrl: '/graphics/object_events/pics/people/brendan/running.png',
      },
      rs: {
        walking4bppB64: BRENDAN_RS_WALK_4BPP_B64,
        running4bppB64: BRENDAN_RS_RUN_4BPP_B64,
        walkingUrl: '/graphics/object_events/pics/people/ruby_sapphire_brendan/walking.png',
        runningUrl: '/graphics/object_events/pics/people/ruby_sapphire_brendan/running.png',
      },
    },
    clothingSlots: [
      {
        id: 'head',
        label: 'Headwear',
        yRange: [0, 21],
        defaultItemId: 'emerald-hat',
        items: [
          {
            id: 'emerald-hat',
            label: 'Emerald Bandana Hat',
            description: 'Default Emerald white cap with headband wrap',
            sourceSheet: 'emerald',
            transform: applyEmeraldHatTransform,
          },
          {
            id: 'rs-cap',
            label: 'Ruby / Sapphire Cap',
            description: 'Classic Hoenn emblem cap without bandana wrap',
            sourceSheet: 'rs',
            transform: applyRsCapTransform,
          },
          {
            id: 'kitten-ears',
            label: 'Kitten Ears',
            description: 'Perked-up neko ears headband with pink inner ear tufts',
            sourceSheet: 'emerald',
            transform: applyKittenEarsTransform,
          },
          {
            id: 'wizard-hat',
            label: 'Mystic Wizard Hat',
            description: 'Tall pointed spellcaster spire with wide brim and clasp',
            sourceSheet: 'emerald',
            transform: applyWizardHatTransform,
          },
          {
            id: 'royal-crown',
            label: 'Champion Crown',
            description: 'Three-spiked royal coronet with a jeweled emblem crest',
            sourceSheet: 'emerald',
            transform: applyRoyalCrownTransform,
          },
          {
            id: 'dojo-headband',
            label: 'Dojo Headband',
            description: 'Sleek bare-crown hair with a tied martial-arts headband',
            sourceSheet: 'emerald',
            transform: applyDojoHeadbandTransform,
          },
        ],
      },
      {
        id: 'top',
        label: 'Top / Shirt',
        yRange: [22, 27],
        defaultItemId: 'emerald-tunic',
        items: [
          {
            id: 'emerald-tunic',
            label: 'Emerald Short-Sleeve',
            description: 'Default Emerald layered short-sleeve tunic',
            sourceSheet: 'emerald',
          },
          {
            id: 'rs-jacket',
            label: 'Ruby / Sapphire Jacket',
            description: 'Long-sleeve zip track jacket with accent cuffs',
            sourceSheet: 'rs',
          },
          {
            id: 'sleeveless-vest',
            label: 'Sleeveless Vest',
            description: 'Sleeveless battle vest with accent shoulder trim',
            sourceSheet: 'emerald',
            transform: applySleevelessVestTransform,
          },
        ],
      },
      {
        id: 'bottom',
        label: 'Pants & Shoes',
        yRange: [28, 31],
        defaultItemId: 'emerald-pants',
        items: [
          {
            id: 'emerald-pants',
            label: 'Emerald Cargo & Sneakers',
            description: 'Default Emerald pants and accent-trim running shoes',
            sourceSheet: 'emerald',
          },
          {
            id: 'rs-boots',
            label: 'Ruby / Sapphire Boots',
            description: 'Classic Hoenn trousers with solid two-tone boots',
            sourceSheet: 'rs',
          },
        ],
      },
      {
        id: 'accessory',
        label: 'Accessories',
        yRange: [0, 31],
        defaultItemId: 'none',
        items: [
          {
            id: 'none',
            label: 'None',
            description: 'Standard look with no extra accessory equipped',
            sourceSheet: null,
          },
          {
            id: 'cat-whiskers',
            label: 'Kitty Nose & Whiskers',
            description: 'Cute pink button nose and cheek whiskers for a neko look',
            sourceSheet: null,
            transform: applyCatWhiskersAccessory,
          },
          {
            id: 'cool-shades',
            label: 'Squirtle Squad Shades',
            description: 'Sharp dark sunglasses with a bright lens glint',
            sourceSheet: null,
            transform: applyCoolShadesAccessory,
          },
          {
            id: 'angel-halo',
            label: 'Floating Halo',
            description: 'Luminous ring hovering above your trainer head',
            sourceSheet: null,
            transform: applyAngelHaloAccessory,
          },
          {
            id: 'hero-scarf',
            label: 'Champion Scarf',
            description: 'Flowing accent scarf wrapped around the collar',
            sourceSheet: null,
            transform: applyHeroScarfAccessory,
          },
        ],
      },
    ],
    colorAspects: [
      {
        id: 'head',
        label: 'Hat / Hair',
        paletteIndices: [14, 9],
        defaultHex: '#ffffff',
        swatches: [
          { id: 'classic-white', label: 'Classic White', hex: '#ffffff', ramp: [[255, 255, 255], [222, 230, 238]] },
          { id: 'midnight-black', label: 'Midnight Black', hex: '#4a5263', ramp: [[74, 82, 99], [41, 49, 65]] },
          { id: 'ash-red', label: 'League Red', hex: '#ff635a', ramp: [[255, 99, 90], [197, 57, 57]] },
          { id: 'sky-blue', label: 'Sky Blue', hex: '#73b5ff', ramp: [[115, 181, 255], [74, 131, 205]] },
          { id: 'sand-gold', label: 'Sand Blonde', hex: '#ffe69c', ramp: [[255, 230, 156], [213, 180, 106]] },
          { id: 'mint-cap', label: 'Mint Green', hex: '#8ce6b5', ramp: [[140, 230, 181], [90, 172, 131]] },
          { id: 'sakura-pink', label: 'Sakura Pink', hex: '#ff94c2', ramp: [[255, 148, 194], [213, 107, 156]] },
          { id: 'calico-orange', label: 'Calico Orange', hex: '#ff9c4a', ramp: [[255, 156, 74], [205, 107, 41]] },
        ],
      },
      {
        id: 'trim',
        label: '2nd Color / Trim',
        paletteIndices: [6, 7],
        defaultHex: '#ff94c2',
        swatches: [
          { id: 'trim-sakura', label: 'Sakura Pink', hex: '#ff94c2', ramp: [[255, 148, 194], [197, 98, 148]] },
          { id: 'trim-crimson', label: 'Crimson Red', hex: '#ff5a52', ramp: [[255, 90, 82], [189, 49, 49]] },
          { id: 'trim-gold', label: 'Ruby Gold', hex: '#ffc55a', ramp: [[255, 197, 90], [189, 131, 41]] },
          { id: 'trim-emerald', label: 'Emerald Green', hex: '#73cd73', ramp: [[115, 205, 115], [74, 148, 82]] },
          { id: 'trim-cobalt', label: 'Cobalt Blue', hex: '#529cff', ramp: [[82, 156, 255], [49, 98, 189]] },
          { id: 'trim-amethyst', label: 'Amethyst', hex: '#b573ff', ramp: [[181, 115, 255], [123, 65, 189]] },
          { id: 'trim-frost', label: 'Frost White', hex: '#e6eef7', ramp: [[230, 238, 247], [164, 180, 197]] },
          { id: 'trim-obsidian', label: 'Obsidian', hex: '#313942', ramp: [[65, 74, 90], [24, 33, 49]] },
        ],
      },
      {
        id: 'top',
        label: 'Shirt & Shoes',
        paletteIndices: [12, 13],
        defaultHex: '#ff625a',
        swatches: [
          { id: 'emerald-red', label: 'Emerald Red', hex: '#ff625a', ramp: [[255, 98, 90], [197, 65, 65]] },
          { id: 'sapphire-blue', label: 'Sapphire Blue', hex: '#4a8cff', ramp: [[74, 140, 255], [41, 90, 189]] },
          { id: 'rayquaza-green', label: 'Rayquaza Green', hex: '#42b573', ramp: [[66, 181, 115], [33, 123, 74]] },
          { id: 'pikachu-gold', label: 'Thunder Gold', hex: '#ffbd39', ramp: [[255, 189, 57], [197, 131, 24]] },
          { id: 'gengar-violet', label: 'Shadow Violet', hex: '#9c63f7', ramp: [[156, 99, 247], [107, 57, 181]] },
          { id: 'obsidian', label: 'Stealth Charcoal', hex: '#525a6b', ramp: [[82, 90, 107], [49, 57, 74]] },
          { id: 'cyan-wave', label: 'Aqua Cyan', hex: '#31c6de', ramp: [[49, 198, 222], [24, 131, 156]] },
          { id: 'blossom-pink', label: 'Coral Pink', hex: '#ff73b5', ramp: [[255, 115, 181], [197, 65, 123]] },
        ],
      },
      {
        id: 'accent',
        label: 'Bandana & Bag',
        paletteIndices: [10, 11],
        defaultHex: '#73cd73',
        swatches: [
          { id: 'emerald-green', label: 'Emerald Green', hex: '#73cd73', ramp: [[115, 205, 115], [74, 148, 82]] },
          { id: 'rs-gold', label: 'Ruby Gold', hex: '#ffc55a', ramp: [[255, 197, 90], [189, 156, 90]] },
          { id: 'crimson-band', label: 'Crimson', hex: '#ff5a52', ramp: [[255, 90, 82], [189, 49, 49]] },
          { id: 'cobalt-band', label: 'Cobalt', hex: '#529cff', ramp: [[82, 156, 255], [49, 98, 189]] },
          { id: 'amethyst-band', label: 'Amethyst', hex: '#b573ff', ramp: [[181, 115, 255], [123, 65, 189]] },
          { id: 'frost-white', label: 'Frost White', hex: '#e6eef7', ramp: [[230, 238, 247], [164, 180, 197]] },
          { id: 'sakura-band', label: 'Sakura Pink', hex: '#ff94c2', ramp: [[255, 148, 194], [197, 98, 148]] },
          { id: 'calico-band', label: 'Calico Orange', hex: '#ff9c4a', ramp: [[255, 156, 74], [197, 107, 41]] },
        ],
      },
      {
        id: 'bottom',
        label: 'Pants',
        paletteIndices: [5],
        defaultHex: '#394a7b',
        swatches: [
          { id: 'classic-navy', label: 'Classic Navy', hex: '#394a7b', ramp: [[57, 74, 123]] },
          { id: 'jet-black', label: 'Jet Black', hex: '#313942', ramp: [[49, 57, 66]] },
          { id: 'khaki-tan', label: 'Ranger Khaki', hex: '#b59c6b', ramp: [[181, 156, 107]] },
          { id: 'forest-cargo', label: 'Forest Olive', hex: '#4a7352', ramp: [[74, 115, 82]] },
          { id: 'maroon-denim', label: 'Maroon Denim', hex: '#8c4252', ramp: [[140, 66, 82]] },
        ],
      },
      {
        id: 'skin',
        label: 'Skin Tone',
        paletteIndices: [1, 2, 3, 4],
        defaultHex: '#ffc594',
        swatches: [
          {
            id: 'warm-light',
            label: 'Warm Light',
            hex: '#ffc594',
            ramp: [[255, 213, 180], [255, 197, 148], [222, 148, 115], [123, 65, 65]],
          },
          {
            id: 'fair-peach',
            label: 'Fair Peach',
            hex: '#ffd6ba',
            ramp: [[255, 230, 205], [255, 214, 186], [230, 172, 140], [131, 74, 74]],
          },
          {
            id: 'golden-tan',
            label: 'Golden Tan',
            hex: '#e6a56b',
            ramp: [[247, 189, 139], [230, 165, 107], [189, 123, 74], [107, 57, 49]],
          },
          {
            id: 'warm-amber',
            label: 'Warm Amber',
            hex: '#bd7b4a',
            ramp: [[213, 156, 106], [189, 123, 74], [148, 90, 49], [82, 41, 33]],
          },
          {
            id: 'deep-umber',
            label: 'Deep Umber',
            hex: '#8c5231',
            ramp: [[164, 106, 74], [140, 82, 49], [106, 57, 33], [57, 24, 16]],
          },
        ],
      },
    ],
  };
}

const rigRegistry = new Map();
const gameRigMap = new Map([
  ['emerald', DEFAULT_RIG_ID],
  ['emerald-kaizo', DEFAULT_RIG_ID],
  ['test-emerald', DEFAULT_RIG_ID],
]);
const gameRigExtensions = new Map();

function cloneSlot(slot) {
  return {
    ...slot,
    yRange: [...slot.yRange],
    items: slot.items.map((item) => ({ ...item })),
  };
}

function cloneAspect(aspect) {
  return {
    ...aspect,
    paletteIndices: [...aspect.paletteIndices],
    swatches: aspect.swatches.map((swatch) => ({
      ...swatch,
      ramp: swatch.ramp ? swatch.ramp.map((c) => [...c]) : undefined,
    })),
  };
}

function cloneRig(rig) {
  return {
    ...rig,
    basePalette: rig.basePalette.map((c) => [...c]),
    reflectionPalette: rig.reflectionPalette.map((c) => [...c]),
    sheets: Object.fromEntries(
      Object.entries(rig.sheets ?? {}).map(([k, v]) => [k, { ...v }]),
    ),
    clothingSlots: (rig.clothingSlots ?? []).map(cloneSlot),
    colorAspects: (rig.colorAspects ?? []).map(cloneAspect),
  };
}

export function registerCharacterRig(rigSchema) {
  if (!rigSchema?.id || typeof rigSchema.id !== 'string') {
    throw new Error('Character rig requires a string id');
  }
  rigRegistry.set(rigSchema.id, cloneRig(rigSchema));
  return rigSchema.id;
}

export function setGameCharacterRig(gameId, rigId) {
  if (!gameId || !rigId) throw new Error('gameId and rigId are required');
  gameRigMap.set(gameId, rigId);
}

/**
 * Allows a game pack to extend a base rig with game-exclusive clothing pieces,
 * sheets, or color swatches without mutating other games using the same rig.
 */
export function extendCharacterRigForGame(gameId, rigId, extensions = {}) {
  if (!gameId || !rigId) throw new Error('gameId and rigId are required');
  const key = `${gameId}::${rigId}`;
  const current = gameRigExtensions.get(key) ?? {
    sheets: {},
    clothingItemsBySlot: {},
    colorSwatchesByAspect: {},
  };
  if (extensions.sheets && typeof extensions.sheets === 'object') {
    Object.assign(current.sheets, extensions.sheets);
  }
  if (extensions.clothingItemsBySlot && typeof extensions.clothingItemsBySlot === 'object') {
    for (const [slotId, items] of Object.entries(extensions.clothingItemsBySlot)) {
      if (!Array.isArray(items)) continue;
      const list = current.clothingItemsBySlot[slotId] ?? [];
      for (const item of items) {
        if (!item?.id) continue;
        const idx = list.findIndex((entry) => entry.id === item.id);
        if (idx >= 0) list[idx] = { ...item };
        else list.push({ ...item });
      }
      current.clothingItemsBySlot[slotId] = list;
    }
  }
  if (extensions.colorSwatchesByAspect && typeof extensions.colorSwatchesByAspect === 'object') {
    for (const [aspectId, swatches] of Object.entries(extensions.colorSwatchesByAspect)) {
      if (!Array.isArray(swatches)) continue;
      const list = current.colorSwatchesByAspect[aspectId] ?? [];
      for (const swatch of swatches) {
        if (!swatch?.id) continue;
        const idx = list.findIndex((entry) => entry.id === swatch.id);
        if (idx >= 0) list[idx] = { ...swatch };
        else list.push({ ...swatch });
      }
      current.colorSwatchesByAspect[aspectId] = list;
    }
  }
  gameRigExtensions.set(key, current);
}

export function registerClothingItem(slotId, item, {
  rigId = DEFAULT_RIG_ID,
  gameId = null,
} = {}) {
  if (!slotId || !item?.id) throw new Error('slotId and item.id are required');
  if (gameId) {
    extendCharacterRigForGame(gameId, rigId, {
      clothingItemsBySlot: { [slotId]: [item] },
    });
    return;
  }
  const rig = rigRegistry.get(rigId);
  if (!rig) throw new Error(`Unknown character rig: ${rigId}`);
  const slot = rig.clothingSlots.find((entry) => entry.id === slotId);
  if (!slot) throw new Error(`Unknown clothing slot "${slotId}" on rig "${rigId}"`);
  const existingIdx = slot.items.findIndex((entry) => entry.id === item.id);
  if (existingIdx >= 0) slot.items[existingIdx] = { ...item };
  else slot.items.push({ ...item });
}

export function registerColorSwatch(aspectId, swatch, {
  rigId = DEFAULT_RIG_ID,
  gameId = null,
} = {}) {
  if (!aspectId || !swatch?.id || !swatch?.hex) {
    throw new Error('aspectId, swatch.id, and swatch.hex are required');
  }
  if (gameId) {
    extendCharacterRigForGame(gameId, rigId, {
      colorSwatchesByAspect: { [aspectId]: [swatch] },
    });
    return;
  }
  const rig = rigRegistry.get(rigId);
  if (!rig) throw new Error(`Unknown character rig: ${rigId}`);
  const aspect = rig.colorAspects.find((entry) => entry.id === aspectId);
  if (!aspect) throw new Error(`Unknown color aspect "${aspectId}" on rig "${rigId}"`);
  const existingIdx = aspect.swatches.findIndex((entry) => entry.id === swatch.id);
  if (existingIdx >= 0) aspect.swatches[existingIdx] = { ...swatch };
  else aspect.swatches.push({ ...swatch });
}

export function resolveCharacterSchema({
  gameId = 'emerald',
  rigId = null,
  manifest = null,
} = {}) {
  const manifestRigId = manifest?.customization?.rigId ?? null;
  const resolvedRigId = rigId ?? manifestRigId ?? gameRigMap.get(gameId) ?? DEFAULT_RIG_ID;
  const baseRig = rigRegistry.get(resolvedRigId) ?? rigRegistry.get(DEFAULT_RIG_ID);
  const schema = cloneRig(baseRig);
  schema.gameId = gameId;

  const mergeExtension = (ext) => {
    if (!ext) return;
    if (ext.sheets && typeof ext.sheets === 'object') {
      for (const [sheetId, sheetDef] of Object.entries(ext.sheets)) {
        schema.sheets[sheetId] = { ...(schema.sheets[sheetId] ?? {}), ...sheetDef };
      }
    }
    if (ext.clothingItemsBySlot && typeof ext.clothingItemsBySlot === 'object') {
      for (const [slotId, items] of Object.entries(ext.clothingItemsBySlot)) {
        const slot = schema.clothingSlots.find((entry) => entry.id === slotId);
        if (!slot || !Array.isArray(items)) continue;
        for (const item of items) {
          if (!item?.id) continue;
          const idx = slot.items.findIndex((entry) => entry.id === item.id);
          if (idx >= 0) slot.items[idx] = { ...item };
          else slot.items.push({ ...item });
        }
      }
    }
    if (ext.colorSwatchesByAspect && typeof ext.colorSwatchesByAspect === 'object') {
      for (const [aspectId, swatches] of Object.entries(ext.colorSwatchesByAspect)) {
        const aspect = schema.colorAspects.find((entry) => entry.id === aspectId);
        if (!aspect || !Array.isArray(swatches)) continue;
        for (const swatch of swatches) {
          if (!swatch?.id) continue;
          const idx = aspect.swatches.findIndex((entry) => entry.id === swatch.id);
          if (idx >= 0) aspect.swatches[idx] = { ...swatch };
          else aspect.swatches.push({ ...swatch });
        }
      }
    }
  };

  mergeExtension(gameRigExtensions.get(`${gameId}::${schema.id}`));
  if (manifest?.customization) mergeExtension(manifest.customization);
  return schema;
}

export function resolveAspectColorRamp(aspect, hexColor) {
  const normalized = normalizeHexColor(hexColor, aspect.defaultHex);
  const matchingSwatch = (aspect.swatches ?? []).find(
    (swatch) => normalizeHexColor(swatch.hex, '') === normalized && Array.isArray(swatch.ramp),
  );
  if (matchingSwatch) {
    return matchingSwatch.ramp.map((rgb) => [...rgb]);
  }
  return buildColorRamp(normalized, aspect.paletteIndices.length);
}

// Register the default Gen 3 Brendan rig on module load.
registerCharacterRig(createGen3BrendanRig());
