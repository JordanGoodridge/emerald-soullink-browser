import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildColorRamp,
  extendCharacterRigForGame,
  registerCharacterRig,
  registerClothingItem,
  registerColorSwatch,
  resolveCharacterSchema,
} from './character-catalog.mjs';
import {
  compileCharacterCustomization,
  decodeGba4bppSheet,
  encodeGba4bppSheet,
  gba15ToRgb,
  rgbToGba15,
} from './character-compositor.mjs';
import {
  createCharacterStore,
  defaultCustomizationForSchema,
  isDefaultCustomization,
} from './character-store.mjs';
import { applyEmeraldCharacterCustomization } from '../packs/emerald-compat.mjs';
import { createWasmHelpers } from '../packs/shared/runtime-wasm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../build/wasm/pokeemerald.wasm');

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('default gen3-brendan compilation matches vanilla GBA 4bpp sheets and palette', () => {
  const schema = resolveCharacterSchema({ gameId: 'emerald' });
  const defaults = defaultCustomizationForSchema(schema);
  assert.equal(isDefaultCustomization(defaults, schema), true);

  const compiled = compileCharacterCustomization(defaults, { gameId: 'emerald' });
  assert.equal(compiled.rigId, 'gen3-brendan');
  assert.equal(compiled.walking4bpp.byteLength, 2304);
  assert.equal(compiled.running4bpp.byteLength, 2304);
  assert.equal(compiled.walkingRgba.byteLength, 144 * 32 * 4);
  assert.equal(compiled.gbaPalette16.length, 16);

  // Round-trip 4bpp decode -> encode is byte-identical.
  const roundTripped = encodeGba4bppSheet(decodeGba4bppSheet(compiled.walking4bpp));
  assert.deepEqual(roundTripped, compiled.walking4bpp);

  // Default shirt highlight (index 12) is Emerald red [255, 98, 90].
  assert.deepEqual(compiled.paletteRgb[12], [255, 98, 90]);
  // Default bandana highlight (index 10) is Emerald green [115, 205, 115].
  assert.deepEqual(compiled.paletteRgb[10], [115, 205, 115]);
});

test('changing a color aspect updates only its mapped palette indices and generates valid GBA BGR555 stops', () => {
  const base = compileCharacterCustomization({}, { gameId: 'emerald' });
  const custom = compileCharacterCustomization({
    colors: {
      top: '#4a8cff', // Sapphire Blue
    },
  }, { gameId: 'emerald' });

  // Shirt indices (12, 13) changed:
  assert.notEqual(custom.gbaPalette16[12], base.gbaPalette16[12]);
  assert.notEqual(custom.gbaPalette16[13], base.gbaPalette16[13]);

  // Bandana (10, 11), Hat (9, 14), Pants (5, 6, 7), Skin (1..4) untouched:
  for (const idx of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15]) {
    assert.equal(custom.gbaPalette16[idx], base.gbaPalette16[idx], `palette index ${idx} should not change`);
  }

  // Custom arbitrary hex color builds a descending brightness ramp:
  const ramp = buildColorRamp('#30c090', 3);
  assert.equal(ramp.length, 3);
  assert.ok(ramp[0][1] >= ramp[1][1] && ramp[1][1] >= ramp[2][1]);
  const gbaWord = rgbToGba15(ramp[0]);
  assert.deepEqual(gba15ToRgb(gbaWord), ramp[0]);
});

test('changing a single clothing slot modifies only that slot vertical region across frames', () => {
  const vanilla = compileCharacterCustomization({}, { gameId: 'emerald' });
  const withJacket = compileCharacterCustomization({
    equipped: {
      head: 'emerald-hat',
      top: 'rs-jacket',
      bottom: 'emerald-pants',
    },
  }, { gameId: 'emerald' });

  const sheetWidth = 144;
  // Head rows (0..21) and Bottom rows (28..31) must be 100% identical to vanilla Emerald:
  for (let y = 0; y <= 21; y++) {
    for (let x = 0; x < sheetWidth; x++) {
      assert.equal(withJacket.walkingIndexed[y * sheetWidth + x], vanilla.walkingIndexed[y * sheetWidth + x]);
    }
  }
  for (let y = 28; y <= 31; y++) {
    for (let x = 0; x < sheetWidth; x++) {
      assert.equal(withJacket.walkingIndexed[y * sheetWidth + x], vanilla.walkingIndexed[y * sheetWidth + x]);
    }
  }

  // Torso rows (22..27) must differ where the R/S jacket replaces short sleeves:
  let torsoDiffs = 0;
  for (let y = 22; y <= 27; y++) {
    for (let x = 0; x < sheetWidth; x++) {
      if (withJacket.walkingIndexed[y * sheetWidth + x] !== vanilla.walkingIndexed[y * sheetWidth + x]) {
        torsoDiffs++;
      }
    }
  }
  assert.ok(torsoDiffs > 0, 'expected R/S jacket to modify torso pixels');

  // Sleeveless vest transform also modifies only torso rows (22..26):
  const withVest = compileCharacterCustomization({
    equipped: { top: 'sleeveless-vest' },
  }, { gameId: 'emerald' });
  let vestDiffs = 0;
  for (let y = 22; y <= 26; y++) {
    for (let x = 0; x < sheetWidth; x++) {
      if (withVest.walkingIndexed[y * sheetWidth + x] !== vanilla.walkingIndexed[y * sheetWidth + x]) {
        vestDiffs++;
      }
    }
  }
  assert.ok(vestDiffs > 0, 'expected sleeveless vest to modify sleeve pixels');
});

test('multi-game catalog supports per-game clothing extensions and new protagonist rigs', () => {
  // Extend gen3-brendan specifically for emerald-kaizo without polluting vanilla emerald:
  extendCharacterRigForGame('emerald-kaizo', 'gen3-brendan', {
    clothingItemsBySlot: {
      top: [
        {
          id: 'kaizo-champion-top',
          label: 'Kaizo Champion Tunic',
          sourceSheet: 'rs',
        },
      ],
    },
  });

  const emeraldSchema = resolveCharacterSchema({ gameId: 'emerald' });
  const kaizoSchema = resolveCharacterSchema({ gameId: 'emerald-kaizo' });

  const emeraldTopIds = emeraldSchema.clothingSlots.find((s) => s.id === 'top').items.map((i) => i.id);
  const kaizoTopIds = kaizoSchema.clothingSlots.find((s) => s.id === 'top').items.map((i) => i.id);

  assert.equal(emeraldTopIds.includes('kaizo-champion-top'), false);
  assert.equal(kaizoTopIds.includes('kaizo-champion-top'), true);

  // Register a custom protagonist rig for a new game pack:
  registerCharacterRig({
    id: 'test-custom-protagonist',
    label: 'Custom Hero',
    gender: 'male',
    appearanceKey: 'hero.on-foot',
    frameWidth: 16,
    frameHeight: 32,
    frameCount: 9,
    basePalette: emeraldSchema.basePalette,
    reflectionPalette: emeraldSchema.reflectionPalette,
    sheets: emeraldSchema.sheets,
    clothingSlots: [
      {
        id: 'cape',
        label: 'Cape',
        yRange: [22, 30],
        defaultItemId: 'starter-cape',
        items: [{ id: 'starter-cape', label: 'Starter Cape', sourceSheet: 'emerald' }],
      },
    ],
    colorAspects: [
      {
        id: 'cape',
        label: 'Cape Color',
        paletteIndices: [12, 13],
        defaultHex: '#8040e0',
        swatches: [{ id: 'royal', label: 'Royal Purple', hex: '#8040e0' }],
      },
    ],
  });

  registerClothingItem('cape', { id: 'drake-cape', label: 'Drake Cape', sourceSheet: 'rs' }, {
    rigId: 'test-custom-protagonist',
  });
  registerColorSwatch('cape', { id: 'gold-cape', label: 'Gold Cape', hex: '#f0c030' }, {
    rigId: 'test-custom-protagonist',
  });

  const customSchema = resolveCharacterSchema({
    gameId: 'dragon-hack',
    manifest: { customization: { rigId: 'test-custom-protagonist' } },
  });
  assert.equal(customSchema.id, 'test-custom-protagonist');
  assert.equal(customSchema.clothingSlots[0].items.length, 2);
  assert.equal(customSchema.colorAspects[0].swatches.length, 2);

  // Store persists per rig and game:
  const store = createCharacterStore({ storage: createMemoryStorage() });
  store.save({
    equipped: { cape: 'drake-cape' },
    colors: { cape: '#f0c030' },
  }, { gameId: 'dragon-hack', rigId: 'test-custom-protagonist' });

  const loaded = store.load({ gameId: 'dragon-hack', rigId: 'test-custom-protagonist' });
  assert.equal(loaded.equipped.cape, 'drake-cape');
  assert.equal(loaded.colors.cape, '#f0c030');
});

test('WASM integration: applyEmeraldCharacterCustomization writes palette and 4bpp tiles into pokeemerald.wasm', async () => {
  const bytes = readFileSync(wasmPath);
  const module = await WebAssembly.compile(bytes);
  let u8;
  let u16;
  let u32;
  const helpers = createWasmHelpers(() => ({ u8, u16, u32 }));
  const instance = await WebAssembly.instantiate(module, helpers.createImports(module));
  const { exports } = instance;
  u8 = new Uint8Array(exports.memory.buffer);
  u16 = new Uint16Array(exports.memory.buffer);
  u32 = new Uint32Array(exports.memory.buffer);

  const palPtr = exports.WasmPlayerPaletteBuffer() >>> 0;
  const normalPicPtr = exports.WasmPlayerNormalPicBuffer() >>> 0;
  const runningPicPtr = exports.WasmPlayerRunningPicBuffer() >>> 0;
  assert.ok(palPtr > 0);
  assert.ok(normalPicPtr > 0);
  assert.ok(runningPicPtr > 0);

  // Verify the built-in default compiled 4bpp walking sheet matches WASM memory byte-for-byte!
  const defaultCompiled = compileCharacterCustomization({}, { gameId: 'emerald' });
  assert.deepEqual(
    u8.subarray(normalPicPtr, normalPicPtr + 2304),
    defaultCompiled.walking4bpp,
  );
  assert.deepEqual(
    u16.subarray(palPtr >>> 1, (palPtr >>> 1) + 16),
    defaultCompiled.gbaPalette16,
  );

  // Now apply a customized outfit (R/S Jacket + Sapphire Blue shirt) and verify WASM buffers update:
  const customized = compileCharacterCustomization({
    equipped: { top: 'rs-jacket' },
    colors: { top: '#4a8cff' },
  }, { gameId: 'emerald' });

  const applied = applyEmeraldCharacterCustomization(exports, { u8, u16, u32 }, customized);
  assert.equal(applied, true);
  assert.deepEqual(
    u16.subarray(palPtr >>> 1, (palPtr >>> 1) + 16),
    customized.gbaPalette16,
  );
  assert.deepEqual(
    u8.subarray(normalPicPtr, normalPicPtr + 2304),
    customized.walking4bpp,
  );
});
