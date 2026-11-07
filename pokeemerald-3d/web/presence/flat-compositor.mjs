// Flat-field compositor for ordinary interiors.
//
// The classic GBA renderer draws a single 240x160 frame; remote players are not
// part of it. This module stamps remote avatar cells onto that frame using the
// engine's per-pixel layer buffer for occlusion:
//
//   * a background layer whose BGxCNT priority is lower (more in front) than the
//     player sprite hides the remote pixel,
//   * a pixel already owned by a local object sprite is left alone,
//   * backdrop and higher-priority layers let the remote pixel through.
//
// It is intentionally pure: callers pass buffers and get a draw count back.

const LAYER_BG = [0x01, 0x02, 0x04, 0x08]; // BG0..BG3
const LAYER_OBJ = 0x10;
const LAYER_BACKDROP = 0x20;

export function compositeFlatActors({
  pixels = null,
  width = 240,
  height = 160,
  layerPixels = null,
  bgPriorities = [3, 3, 3, 3],
  spritePriority = 2,
  actors = [],
  atlasPixels = null,
  atlasLayerSize = 64,
  cellWidth = 16,
  cellHeight = 32,
} = {}) {
  if (!pixels || !layerPixels || !atlasPixels || !actors.length) return 0;
  if (pixels.length < width * height * 4) return 0;
  if (layerPixels.length < width * height) return 0;

  const halfCell = Math.floor(cellWidth / 2);
  let drawn = 0;

  for (const actor of actors) {
    if (!Number.isFinite(actor?.screenX) || !Number.isFinite(actor?.screenY)) continue;
    if (!Number.isInteger(actor.layer) || actor.layer < 0) continue;

    const base = actor.layer * atlasLayerSize * atlasLayerSize * 4;
    if (base + atlasLayerSize * atlasLayerSize * 4 > atlasPixels.length) continue;

    const left = Math.round(actor.screenX) - halfCell;
    const top = Math.round(actor.screenY) - cellHeight;

    for (let y = 0; y < cellHeight; y++) {
      const dy = top + y;
      if (dy < 0 || dy >= height) continue;
      for (let x = 0; x < cellWidth; x++) {
        const dx = left + x;
        if (dx < 0 || dx >= width) continue;

        const sx = actor.hFlip ? cellWidth - 1 - x : x;
        const src = base + (y * atlasLayerSize + sx) * 4;
        if (atlasPixels[src + 3] === 0) continue;

        const index = dy * width + dx;
        const layer = layerPixels[index];
        if (layer === 0 || (layer & LAYER_OBJ) || layer === LAYER_BACKDROP) {
          // Backdrop is empty space, so the remote actor belongs on top. Object
          // pixels belong to a local sprite and are never overwritten.
          if (layer & LAYER_OBJ) continue;
        } else {
          const bg = LAYER_BG.indexOf(layer);
          if (bg >= 0 && (bgPriorities[bg] ?? 3) < spritePriority) continue;
        }

        const dst = index * 4;
        const alpha = atlasPixels[src + 3];
        if (alpha >= 255) {
          pixels[dst] = atlasPixels[src];
          pixels[dst + 1] = atlasPixels[src + 1];
          pixels[dst + 2] = atlasPixels[src + 2];
          pixels[dst + 3] = 255;
        } else {
          // Translucent marker layers blend with the frame underneath.
          const a = alpha / 255;
          pixels[dst] = Math.round(atlasPixels[src] * a + pixels[dst] * (1 - a));
          pixels[dst + 1] = Math.round(atlasPixels[src + 1] * a + pixels[dst + 1] * (1 - a));
          pixels[dst + 2] = Math.round(atlasPixels[src + 2] * a + pixels[dst + 2] * (1 - a));
          pixels[dst + 3] = 255;
        }
      }
    }
    drawn++;
  }
  return drawn;
}
