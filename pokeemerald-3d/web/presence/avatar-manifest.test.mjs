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
} from './avatar-manifest.mjs';

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
