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
          },
          {
            id: 'rs-cap',
            label: 'Ruby / Sapphire Cap',
            description: 'Classic Hoenn emblem cap without bandana wrap',
            sourceSheet: 'rs',
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
    ],
    colorAspects: [
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
        ],
      },
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
        ],
      },
      {
        id: 'bottom',
        label: 'Pants',
        paletteIndices: [5, 6, 7],
        defaultHex: '#394a7b',
        swatches: [
          { id: 'classic-navy', label: 'Classic Navy', hex: '#394a7b', ramp: [[57, 74, 123], [41, 57, 98], [24, 41, 82]] },
          { id: 'jet-black', label: 'Jet Black', hex: '#313942', ramp: [[49, 57, 66], [33, 41, 49], [16, 24, 33]] },
          { id: 'khaki-tan', label: 'Ranger Khaki', hex: '#b59c6b', ramp: [[181, 156, 107], [148, 123, 82], [107, 90, 57]] },
          { id: 'forest-cargo', label: 'Forest Olive', hex: '#4a7352', ramp: [[74, 115, 82], [57, 90, 65], [33, 65, 41]] },
          { id: 'maroon-denim', label: 'Maroon Denim', hex: '#8c4252', ramp: [[140, 66, 82], [107, 49, 65], [74, 33, 41]] },
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
