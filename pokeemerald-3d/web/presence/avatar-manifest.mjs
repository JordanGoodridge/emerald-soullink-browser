// Avatar sheet manifest and atlas packer.
//
// Pokeemerald's overworld walking PNGs are 144x32 palette images with nine
// 16x32 frames. Palette index 0 is the transparency key (green in the
// checked-in sheets), not a PNG alpha channel, so the loader keys that exact
// colour out while packing frames into the presenter's 64x64 texture array.

export const AVATAR_CELL_WIDTH = 16;
export const AVATAR_CELL_HEIGHT = 32;
export const AVATAR_SHEET_WIDTH = AVATAR_CELL_WIDTH * 9;
export const AVATAR_SHEET_HEIGHT = AVATAR_CELL_HEIGHT;
export const AVATAR_LAYER_SIZE = 64;
export const AVATAR_LAYER_CAPACITY = 72;
export const AVATAR_GHOST_ALPHA = 0.45;
export const AVATAR_LAYERS_PER_SHEET = 9;

export const AVATAR_SHEETS = Object.freeze([
  Object.freeze({
    appearance: 'brendan.on-foot',
    url: '/graphics/object_events/pics/people/brendan/walking.png',
    transparent: Object.freeze([115, 197, 164]),
  }),
  Object.freeze({
    appearance: 'may.on-foot',
    url: '/graphics/object_events/pics/people/may/walking.png',
    transparent: Object.freeze([115, 197, 164]),
  }),
]);

export function createAvatarAtlas() {
  return {
    pixels: new Uint8Array(AVATAR_LAYER_CAPACITY * AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4),
    layers: new Map(),
    layerCount: 0,
    ghostOffset: 0,
    solidLayerCount: 0,
    revision: 0,
  };
}

// Battle markers reuse the trainer sheets as translucent silhouettes. Duplicating
// every solid layer once keeps the GPU path unchanged: a marker simply requests a
// ghost layer instead of a solid one.
export function finalizeAvatarAtlas(atlas) {
  if (atlas.solidLayerCount) return atlas;
  const solid = atlas.layerCount;
  if (!solid) return atlas;
  if (solid * 2 > AVATAR_LAYER_CAPACITY) {
    throw new Error('avatar atlas ghost capacity exceeded');
  }

  const layerBytes = AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4;
  const source = atlas.pixels.slice(0, solid * layerBytes);
  atlas.pixels.set(source, solid * layerBytes);
  for (let offset = solid * layerBytes; offset < solid * layerBytes * 2; offset += 4) {
    const alpha = atlas.pixels[offset + 3];
    atlas.pixels[offset + 3] = alpha === 0 ? 0 : Math.max(1, Math.round(alpha * AVATAR_GHOST_ALPHA));
  }

  atlas.ghostOffset = solid;
  atlas.solidLayerCount = solid;
  atlas.layerCount = solid * 2;
  atlas.revision++;
  return atlas;
}

export function ghostLayerFor(atlas, layer) {
  if (!atlas?.ghostOffset) return layer;
  if (!Number.isInteger(layer) || layer < 0 || layer >= atlas.ghostOffset) return layer;
  return layer + atlas.ghostOffset;
}

function keyedOut(pixels, offset, transparent) {
  if (pixels[offset + 3] === 0) return true;
  return pixels[offset] === transparent[0]
    && pixels[offset + 1] === transparent[1]
    && pixels[offset + 2] === transparent[2];
}

/**
 * Pack one 144x32 RGBA sheet into consecutive 64x64 layers.
 * Returns the layer offset assigned to the sheet.
 */
export function packAvatarSheet(atlas, appearance, rgba, transparent) {
  if (rgba.length !== AVATAR_SHEET_WIDTH * AVATAR_SHEET_HEIGHT * 4) {
    throw new Error(`avatar sheet must be ${AVATAR_SHEET_WIDTH}x${AVATAR_SHEET_HEIGHT} RGBA`);
  }
  if (atlas.layerCount + AVATAR_LAYERS_PER_SHEET > AVATAR_LAYER_CAPACITY) {
    throw new Error('avatar atlas layer capacity exceeded');
  }

  const offset = atlas.layerCount;
  for (let frame = 0; frame < AVATAR_LAYERS_PER_SHEET; frame++) {
    const layerBase = (offset + frame) * AVATAR_LAYER_SIZE * AVATAR_LAYER_SIZE * 4;
    for (let y = 0; y < AVATAR_CELL_HEIGHT; y++) {
      for (let x = 0; x < AVATAR_CELL_WIDTH; x++) {
        const src = (y * AVATAR_SHEET_WIDTH + frame * AVATAR_CELL_WIDTH + x) * 4;
        const dst = layerBase + (y * AVATAR_LAYER_SIZE + x) * 4;
        if (keyedOut(rgba, src, transparent)) continue;
        atlas.pixels[dst] = rgba[src];
        atlas.pixels[dst + 1] = rgba[src + 1];
        atlas.pixels[dst + 2] = rgba[src + 2];
        atlas.pixels[dst + 3] = 255;
      }
    }
  }

  atlas.layers.set(appearance, { offset, frames: AVATAR_LAYERS_PER_SHEET });
  atlas.layerCount += AVATAR_LAYERS_PER_SHEET;
  atlas.revision++;
  return offset;
}

export function avatarLayerFor(atlas, appearance, frame) {
  if (!atlas || !appearance) return -1;
  const sheet = atlas.layers.get(appearance);
  if (!sheet) return -1;
  const index = Number.isFinite(frame) ? Math.max(0, Math.min(sheet.frames - 1, Math.round(frame))) : 0;
  return sheet.offset + index;
}

async function readSheetRgba(url, { fetchImpl, createImageBitmapImpl, canvasFactory }) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`avatar sheet request failed: ${response.status} ${url}`);
  const bitmap = await createImageBitmapImpl(await response.blob());
  const canvas = canvasFactory(AVATAR_SHEET_WIDTH, AVATAR_SHEET_HEIGHT);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas context unavailable for avatar sheet');
  context.clearRect(0, 0, AVATAR_SHEET_WIDTH, AVATAR_SHEET_HEIGHT);
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return context.getImageData(0, 0, AVATAR_SHEET_WIDTH, AVATAR_SHEET_HEIGHT).data;
}

export async function loadAvatarAtlas({
  sheets = AVATAR_SHEETS,
  fetchImpl = (url) => fetch(url, { cache: 'no-store' }),
  createImageBitmapImpl = (blob) => createImageBitmap(blob),
  canvasFactory = (width, height) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
} = {}) {
  const atlas = createAvatarAtlas();
  for (const sheet of sheets) {
    const rgba = await readSheetRgba(sheet.url, {
      fetchImpl,
      createImageBitmapImpl,
      canvasFactory,
    });
    packAvatarSheet(atlas, sheet.appearance, rgba, sheet.transparent);
  }
  return finalizeAvatarAtlas(atlas);
}
