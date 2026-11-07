import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeFlatActors } from './flat-compositor.mjs';

const WIDTH = 8;
const HEIGHT = 8;
const LAYER_SIZE = 64;

function solidAtlas(layer, rgba) {
  const pixels = new Uint8Array(4 * LAYER_SIZE * LAYER_SIZE * 4);
  const base = layer * LAYER_SIZE * LAYER_SIZE * 4;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 16; x++) {
      const offset = base + (y * LAYER_SIZE + x) * 4;
      pixels.set(rgba, offset);
    }
  }
  return pixels;
}

function scene(layerValue = 0x20, priority = 3) {
  return {
    pixels: new Uint8Array(WIDTH * HEIGHT * 4),
    layerPixels: new Uint8Array(WIDTH * HEIGHT).fill(layerValue),
    bgPriorities: [priority, priority, priority, priority],
  };
}

const actor = { screenX: 4, screenY: 6, layer: 0, hFlip: false };

test('stamps a remote cell over the backdrop', () => {
  const { pixels, layerPixels, bgPriorities } = scene();
  const drawn = compositeFlatActors({
    pixels, width: WIDTH, height: HEIGHT, layerPixels, bgPriorities,
    actors: [actor], atlasPixels: solidAtlas(0, [255, 0, 0, 255]),
  });
  assert.equal(drawn, 1);
  const offset = (5 * WIDTH + 4) * 4; // inside the cell, below the footpoint
  assert.deepEqual([...pixels.slice(offset, offset + 4)], [255, 0, 0, 255]);
});

test('a foreground background layer occludes the remote player', () => {
  const { pixels, layerPixels, bgPriorities } = scene(0x02, 1); // BG1 priority 1
  compositeFlatActors({
    pixels, width: WIDTH, height: HEIGHT, layerPixels, bgPriorities, spritePriority: 2,
    actors: [actor], atlasPixels: solidAtlas(0, [255, 0, 0, 255]),
  });
  assert.ok(pixels.every((value) => value === 0));
});

test('a background layer behind the player does not occlude', () => {
  const { pixels, layerPixels, bgPriorities } = scene(0x04, 3); // BG2 priority 3
  const drawn = compositeFlatActors({
    pixels, width: WIDTH, height: HEIGHT, layerPixels, bgPriorities, spritePriority: 2,
    actors: [actor], atlasPixels: solidAtlas(0, [255, 0, 0, 255]),
  });
  assert.equal(drawn, 1);
});

test('local object pixels are never overwritten', () => {
  const { pixels, layerPixels, bgPriorities } = scene(0x10, 3);
  compositeFlatActors({
    pixels, width: WIDTH, height: HEIGHT, layerPixels, bgPriorities,
    actors: [actor], atlasPixels: solidAtlas(0, [255, 0, 0, 255]),
  });
  assert.ok(pixels.every((value) => value === 0));
});

test('flipped actors mirror the source cell', () => {
  const w = 24;
  const h = 32;
  const pixels = new Uint8Array(w * h * 4);
  const layerPixels = new Uint8Array(w * h).fill(0x20);
  const atlas = solidAtlas(0, [0, 0, 0, 0]);
  atlas.set([10, 20, 30, 255], 0);
  atlas.set([40, 50, 60, 255], 15 * 4);

  compositeFlatActors({
    pixels, width: w, height: h, layerPixels, bgPriorities: [3, 3, 3, 3],
    actors: [{ screenX: 12, screenY: 32, layer: 0, hFlip: true }], atlasPixels: atlas,
  });

  const leftDest = (0 * w + 4) * 4;
  const rightDest = (0 * w + 19) * 4;
  assert.deepEqual([...pixels.slice(leftDest, leftDest + 4)], [40, 50, 60, 255]);
  assert.deepEqual([...pixels.slice(rightDest, rightDest + 4)], [10, 20, 30, 255]);
});

test('missing buffers are a no-op', () => {
  assert.equal(compositeFlatActors({}), 0);
  assert.equal(compositeFlatActors({ pixels: new Uint8Array(4), layerPixels: null }), 0);
});

test('translucent cells blend with the frame underneath', () => {
  const { pixels, layerPixels, bgPriorities } = scene();
  const offset = (5 * WIDTH + 4) * 4;
  pixels[offset] = 0; pixels[offset + 1] = 255; pixels[offset + 2] = 0; pixels[offset + 3] = 255;
  compositeFlatActors({
    pixels, width: WIDTH, height: HEIGHT, layerPixels, bgPriorities,
    actors: [actor], atlasPixels: solidAtlas(0, [255, 0, 0, 128]),
  });
  assert.ok(Math.abs(pixels[offset] - 128) <= 1, pixels[offset]);
  assert.ok(Math.abs(pixels[offset + 1] - 127) <= 1, pixels[offset + 1]);
  assert.equal(pixels[offset + 3], 255);
});
