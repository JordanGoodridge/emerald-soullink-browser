import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVATAR_LAYER_CAPACITY,
  AVATAR_LAYER_SIZE,
  AVATAR_LAYERS_PER_SHEET,
  AVATAR_SHEET_HEIGHT,
  AVATAR_SHEET_WIDTH,
  avatarLayerFor,
  createAvatarAtlas,
  finalizeAvatarAtlas,
  ghostLayerFor,
  packAvatarSheet,
  playerAppearanceKey,
  replaceAvatarSheetInAtlas,
} from './avatar-manifest.mjs';
import { compileCharacterCustomization } from '../customization/character-compositor.mjs';

const KEY = [115, 197, 164];

function syntheticSheet() {
  const rgba = new Uint8ClampedArray(AVATAR_SHEET_WIDTH * AVATAR_SHEET_HEIGHT * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = KEY[0]; rgba[i + 1] = KEY[1]; rgba[i + 2] = KEY[2]; rgba[i + 3] = 255;
  }
  for (let frame = 0; frame < AVATAR_LAYERS_PER_SHEET; frame++) {
    for (let y = 0; y < 32; y++) {
      const src = (y * AVATAR_SHEET_WIDTH + frame * 16) * 4;
      rgba[src] = frame * 20;
      rgba[src + 1] = 50;
      rgba[src + 2] = 90;
      rgba[src + 3] = 255;
    }
  }
  return rgba;
}

test('packs nine frames into 64x64 layers and keys out the palette zero colour', () => {
  const atlas = createAvatarAtlas();
  const offset = packAvatarSheet(atlas, 'brendan.on-foot', syntheticSheet(), KEY);
  assert.equal(offset, 0);
  assert.equal(atlas.layerCount, 9);
  assert.equal(atlas.layers.get('brendan.on-foot').frames, 9);
  for (let frame = 0; frame < 9; frame++) {
    const base = (offset + frame) * AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4;
    assert.equal(atlas.pixels[base], frame * 20);
    assert.equal(atlas.pixels[base + 3], 255);
    // A pixel outside the 16x32 frame stays fully transparent.
    const empty = base + (AVATAR_LAYER_SIZE - 1) * AVATAR_LAYER_SIZE * 4;
    assert.equal(atlas.pixels[empty + 3], 0);
  }
});

test('maps appearances and clamps frame numbers', () => {
  const atlas = createAvatarAtlas();
  packAvatarSheet(atlas, 'brendan.on-foot', syntheticSheet(), KEY);
  packAvatarSheet(atlas, 'may.on-foot', syntheticSheet(), KEY);
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 0), 0);
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 8), 8);
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 99), 8);
  assert.equal(avatarLayerFor(atlas, 'may.on-foot', 3), 12);
  assert.equal(avatarLayerFor(atlas, 'unknown', 3), -1);
});

test('rejects malformed sheets and atlas overflow', () => {
  const atlas = createAvatarAtlas();
  assert.throws(() => packAvatarSheet(atlas, 'x', new Uint8Array(4), KEY), /144x32/);
  let sheets = 0;
  while (atlas.layerCount + AVATAR_LAYERS_PER_SHEET <= AVATAR_LAYER_CAPACITY) {
    packAvatarSheet(atlas, `sheet${sheets++}`, syntheticSheet(), KEY);
  }
  assert.throws(() => packAvatarSheet(atlas, 'overflow', syntheticSheet(), KEY), /capacity/);
});

test('finalize doubles the atlas into translucent ghost layers', async () => {
  const atlas = createAvatarAtlas();
  packAvatarSheet(atlas, 'brendan.on-foot', syntheticSheet(), KEY);
  finalizeAvatarAtlas(atlas);

  assert.equal(atlas.solidLayerCount, 9);
  assert.equal(atlas.layerCount, 18);
  assert.equal(atlas.ghostOffset, 9);
  assert.equal(ghostLayerFor(atlas, 3), 12);
  assert.equal(ghostLayerFor(atlas, 99), 99);

  const layerBytes = AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4;
  let index = 0;
  for (; index < layerBytes; index += 4) {
    if (atlas.pixels[index + 3] === 255) break;
  }
  assert.ok(index < layerBytes, 'synthetic sheet has an opaque pixel');
  const ghostAlpha = atlas.pixels[atlas.ghostOffset * layerBytes + index + 3];
  assert.ok(ghostAlpha > 0 && ghostAlpha < 255, ghostAlpha);

  finalizeAvatarAtlas(atlas);
  assert.equal(atlas.layerCount, 18);
});

test('replaceAvatarSheetInAtlas preserves black outline pixels (palette index 15 = [0, 0, 0])', () => {
  const atlas = createAvatarAtlas();
  packAvatarSheet(atlas, 'brendan.on-foot', syntheticSheet(), KEY);
  finalizeAvatarAtlas(atlas);

  const compiled = compileCharacterCustomization({}, { gameId: 'emerald' });
  const replaced = replaceAvatarSheetInAtlas(atlas, 'brendan.on-foot', compiled.walkingRgba);
  assert.equal(replaced, true);

  // Verify every pixel with alpha=255 in compiled.walkingRgba (including [0, 0, 0] outlines)
  // is preserved with alpha=255 in the packed atlas layers and translucent in ghost layers.
  const layerBytes = AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4;
  let blackOutlineCount = 0;
  for (let frame = 0; frame < AVATAR_LAYERS_PER_SHEET; frame++) {
    const layerBase = frame * layerBytes;
    const ghostBase = (atlas.ghostOffset + frame) * layerBytes;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 16; x++) {
        const src = (y * AVATAR_SHEET_WIDTH + frame * 16 + x) * 4;
        const dst = layerBase + (y * AVATAR_LAYER_SIZE + x) * 4;
        const ghostDst = ghostBase + (y * AVATAR_LAYER_SIZE + x) * 4;
        const expectedAlpha = compiled.walkingRgba[src + 3];
        assert.equal(atlas.pixels[dst + 3], expectedAlpha, `frame ${frame} (${x},${y}) alpha mismatch`);
        if (expectedAlpha === 255
            && compiled.walkingRgba[src] === 0
            && compiled.walkingRgba[src + 1] === 0
            && compiled.walkingRgba[src + 2] === 0) {
          blackOutlineCount++;
          assert.equal(atlas.pixels[dst], 0);
          assert.equal(atlas.pixels[dst + 1], 0);
          assert.equal(atlas.pixels[dst + 2], 0);
          assert.ok(atlas.pixels[ghostDst + 3] > 0 && atlas.pixels[ghostDst + 3] < 255);
        }
      }
    }
  }
  assert.ok(blackOutlineCount > 0, 'expected compiled sheet to contain black [0, 0, 0] outline pixels');
});

test('allocates per-player custom avatar layers without overwriting the base appearance or other peers', () => {
  const atlas = createAvatarAtlas();
  packAvatarSheet(atlas, 'brendan.on-foot', syntheticSheet(), KEY);
  finalizeAvatarAtlas(atlas);
  assert.equal(atlas.solidLayerCount, 9);
  assert.equal(atlas.layerCount, 18);

  const peer1Compiled = compileCharacterCustomization({
    equipped: { head: 'wizard-hat' },
    colors: { top: '#4a8cff' },
  }, { gameId: 'emerald' });
  const peer2Compiled = compileCharacterCustomization({
    equipped: { head: 'kitten-ears' },
    colors: { top: '#ff94c2' },
  }, { gameId: 'emerald' });

  assert.equal(
    replaceAvatarSheetInAtlas(atlas, playerAppearanceKey('p1', 'brendan.on-foot'), peer1Compiled.walkingRgba),
    true,
  );
  assert.equal(
    replaceAvatarSheetInAtlas(atlas, playerAppearanceKey('p2', 'brendan.on-foot'), peer2Compiled.walkingRgba),
    true,
  );

  // Base brendan.on-foot stays at layers 0..8, p1 gets 9..17, p2 gets 18..26,
  // and ghost layers shift cleanly to start at 27.
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 0), 0);
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 0, 'p1'), 9);
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 0, 'p2'), 18);
  assert.equal(avatarLayerFor(atlas, 'brendan.on-foot', 0, 'unknown-peer'), 0);
  assert.equal(atlas.solidLayerCount, 27);
  assert.equal(atlas.ghostOffset, 27);
  assert.equal(atlas.layerCount, 54);
  assert.equal(ghostLayerFor(atlas, avatarLayerFor(atlas, 'brendan.on-foot', 3, 'p2')), 27 + 18 + 3);
});
