// Game-agnostic character sprite compositor.
//
// Takes a resolved protagonist rig schema + customization state and produces:
//   - paletteRgb / reflectionPaletteRgb (16 x [r, g, b])
//   - gbaPalette16 / gbaReflectionPalette16 (Uint16Array(16) in GBA BGR555)
//   - walking4bpp / running4bpp (Uint8Array(2304) in GBA 8x8 4bpp tile order)
//   - walkingRgba / runningRgba (Uint8ClampedArray(144 * 32 * 4) for canvas & WebGPU)

import {
  clampChannel,
  normalizeHexColor,
  resolveAspectColorRamp,
  resolveCharacterSchema,
  snapGbaChannel,
} from './character-catalog.mjs';
import { normalizeCustomization } from './character-store.mjs';

export function rgbToGba15([r, g, b]) {
  const r5 = Math.max(0, Math.min(31, Math.round(clampChannel(r) * 31 / 255)));
  const g5 = Math.max(0, Math.min(31, Math.round(clampChannel(g) * 31 / 255)));
  const b5 = Math.max(0, Math.min(31, Math.round(clampChannel(b) * 31 / 255)));
  return (r5 | (g5 << 5) | (b5 << 10)) >>> 0;
}

export function gba15ToRgb(word) {
  const r5 = word & 31;
  const g5 = (word >>> 5) & 31;
  const b5 = (word >>> 10) & 31;
  return [
    Math.floor((r5 * 255) / 31),
    Math.floor((g5 * 255) / 31),
    Math.floor((b5 * 255) / 31),
  ];
}

export function decodeBase64Bytes(base64) {
  if (!base64) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = globalThis.atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Decodes a GBA 4bpp object-event sheet (-mwidth 2 -mheight 4) into a flat
 * (frameWidth * frameCount) x frameHeight array of palette indices 0..15.
 */
export function decodeGba4bppSheet(bytes4bpp, {
  frameWidth = 16,
  frameHeight = 32,
  frameCount = 9,
} = {}) {
  const sheetWidth = frameWidth * frameCount;
  const indexed = new Uint8Array(sheetWidth * frameHeight);
  const tilesX = Math.floor(frameWidth / 8);
  const tilesY = Math.floor(frameHeight / 8);
  let src = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const frameX = frame * frameWidth;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        for (let py = 0; py < 8; py++) {
          const y = ty * 8 + py;
          const baseX = frameX + tx * 8;
          for (let px = 0; px < 8; px += 2) {
            const byte = bytes4bpp[src++] ?? 0;
            indexed[y * sheetWidth + baseX + px] = byte & 0x0f;
            indexed[y * sheetWidth + baseX + px + 1] = (byte >>> 4) & 0x0f;
          }
        }
      }
    }
  }
  return indexed;
}

/**
 * Encodes a flat (frameWidth * frameCount) x frameHeight array of palette
 * indices 0..15 into GBA 4bpp tile layout (-mwidth 2 -mheight 4).
 */
export function encodeGba4bppSheet(indexed, {
  frameWidth = 16,
  frameHeight = 32,
  frameCount = 9,
} = {}) {
  const sheetWidth = frameWidth * frameCount;
  const tilesX = Math.floor(frameWidth / 8);
  const tilesY = Math.floor(frameHeight / 8);
  const out = new Uint8Array((sheetWidth * frameHeight) >> 1);
  let dst = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const frameX = frame * frameWidth;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        for (let py = 0; py < 8; py++) {
          const y = ty * 8 + py;
          const baseX = frameX + tx * 8;
          for (let px = 0; px < 8; px += 2) {
            const lo = (indexed[y * sheetWidth + baseX + px] ?? 0) & 0x0f;
            const hi = (indexed[y * sheetWidth + baseX + px + 1] ?? 0) & 0x0f;
            out[dst++] = lo | (hi << 4);
          }
        }
      }
    }
  }
  return out;
}

export function renderIndexedSheetToRgba(indexed, paletteRgb, {
  width = 144,
  height = 32,
} = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const colorIndex = indexed[i] & 0x0f;
    const dst = i * 4;
    if (colorIndex === 0) {
      rgba[dst] = 0;
      rgba[dst + 1] = 0;
      rgba[dst + 2] = 0;
      rgba[dst + 3] = 0;
      continue;
    }
    const color = paletteRgb[colorIndex] ?? [0, 0, 0];
    rgba[dst] = color[0];
    rgba[dst + 1] = color[1];
    rgba[dst + 2] = color[2];
    rgba[dst + 3] = 255;
  }
  return rgba;
}

function buildReflectionColor([r, g, b]) {
  return [
    snapGbaChannel(r * 0.62 + 96),
    snapGbaChannel(g * 0.62 + 104),
    snapGbaChannel(b * 0.66 + 114),
  ];
}

function decodeRigSheetCache(schema) {
  const frameWidth = schema.frameWidth ?? 16;
  const frameHeight = schema.frameHeight ?? 32;
  const frameCount = schema.frameCount ?? 9;
  const decoded = new Map();

  for (const [sheetId, sheetDef] of Object.entries(schema.sheets ?? {})) {
    const walkBytes = sheetDef.walking4bpp instanceof Uint8Array
      ? sheetDef.walking4bpp
      : decodeBase64Bytes(sheetDef.walking4bppB64);
    const runBytes = sheetDef.running4bpp instanceof Uint8Array
      ? sheetDef.running4bpp
      : decodeBase64Bytes(sheetDef.running4bppB64);
    decoded.set(sheetId, {
      walkingIndexed: decodeGba4bppSheet(walkBytes, { frameWidth, frameHeight, frameCount }),
      runningIndexed: decodeGba4bppSheet(runBytes, { frameWidth, frameHeight, frameCount }),
    });
  }
  return decoded;
}

function isCustomTrimActive(schema, normalized) {
  const trimAspect = (schema.colorAspects ?? []).find((entry) => entry.id === 'trim');
  if (!trimAspect) return false;
  const currentHex = normalizeHexColor(normalized.colors?.trim, trimAspect.defaultHex);
  const isCustomHex = currentHex !== normalizeHexColor(trimAspect.defaultHex);
  const headSlot = (schema.clothingSlots ?? []).find((entry) => entry.id === 'head');
  const defaultHeadId = headSlot?.defaultItemId ?? 'emerald-hat';
  const equippedHead = normalized.equipped?.head ?? defaultHeadId;
  const equippedAccessory = normalized.equipped?.accessory ?? 'none';
  return isCustomHex || equippedHead !== defaultHeadId || (Boolean(equippedAccessory) && equippedAccessory !== 'none');
}

function compositeIndexedMotionSheet(kind, schema, normalized, sheetCache, customTrimActive = false) {
  const frameWidth = schema.frameWidth ?? 16;
  const frameHeight = schema.frameHeight ?? 32;
  const frameCount = schema.frameCount ?? 9;
  const sheetWidth = frameWidth * frameCount;

  const firstSheet = sheetCache.values().next().value;
  const baseIndexed = firstSheet?.[kind] ?? new Uint8Array(sheetWidth * frameHeight);
  const composited = new Uint8Array(baseIndexed);

  for (const slot of schema.clothingSlots ?? []) {
    const equippedId = normalized.equipped?.[slot.id] ?? slot.defaultItemId;
    const item = (slot.items ?? []).find((entry) => entry.id === equippedId) ?? slot.items?.[0];
    if (!item) continue;

    const source = sheetCache.get(item.sourceSheet)?.[kind];
    const [yStart, yEnd] = slot.yRange ?? [0, frameHeight - 1];
    if (source) {
      const startOffset = Math.max(0, yStart) * sheetWidth;
      const endOffset = Math.min(frameHeight - 1, yEnd + 1) * sheetWidth;
      for (let i = startOffset; i < endOffset; i++) {
        const px = source[i];
        // When custom 2nd Color / Trim (indices 6, 7) is active, remap any stray
        // vanilla index-6 shadow pixels in the base sheet to 8 (dark outline)
        // before running slot transforms so indices 6 and 7 are 100% isolated.
        composited[i] = (customTrimActive && px === 6) ? 8 : px;
      }
    }
    if (typeof item.transform === 'function') {
      item.transform(composited, sheetWidth, frameHeight, kind, normalized, customTrimActive);
    }
  }

  return composited;
}

export function compileCharacterCustomization(customization, {
  gameId = 'emerald',
  rigId = null,
  manifest = null,
  schema: explicitSchema = null,
} = {}) {
  const schema = explicitSchema ?? resolveCharacterSchema({ gameId, rigId, manifest });
  const normalized = normalizeCustomization(customization, schema);
  const frameWidth = schema.frameWidth ?? 16;
  const frameHeight = schema.frameHeight ?? 32;
  const frameCount = schema.frameCount ?? 9;
  const sheetWidth = frameWidth * frameCount;
  const customTrimActive = isCustomTrimActive(schema, normalized);

  const paletteRgb = (schema.basePalette ?? []).map((rgb) => [...rgb]);
  const reflectionPaletteRgb = (schema.reflectionPalette ?? schema.basePalette ?? []).map((rgb) => [...rgb]);

  for (const aspect of schema.colorAspects ?? []) {
    if (aspect.id === 'trim' && !customTrimActive) {
      continue;
    }
    const hex = normalizeHexColor(normalized.colors?.[aspect.id], aspect.defaultHex);
    const ramp = resolveAspectColorRamp(aspect, hex);
    const isDefault = hex === normalizeHexColor(aspect.defaultHex);
    for (let i = 0; i < aspect.paletteIndices.length; i++) {
      const paletteIndex = aspect.paletteIndices[i];
      const stopRgb = ramp[i] ?? ramp.at(-1);
      if (paletteIndex > 0 && paletteIndex < 16 && stopRgb) {
        paletteRgb[paletteIndex] = [...stopRgb];
        if (!isDefault || aspect.id === 'trim') {
          reflectionPaletteRgb[paletteIndex] = buildReflectionColor(stopRgb);
        }
      }
    }
  }

  const gbaPalette16 = new Uint16Array(16);
  const gbaReflectionPalette16 = new Uint16Array(16);
  for (let i = 0; i < 16; i++) {
    gbaPalette16[i] = rgbToGba15(paletteRgb[i] ?? [0, 0, 0]);
    gbaReflectionPalette16[i] = rgbToGba15(reflectionPaletteRgb[i] ?? [0, 0, 0]);
  }

  const sheetCache = decodeRigSheetCache(schema);
  const walkingIndexed = compositeIndexedMotionSheet('walkingIndexed', schema, normalized, sheetCache, customTrimActive);
  const runningIndexed = compositeIndexedMotionSheet('runningIndexed', schema, normalized, sheetCache, customTrimActive);

  const walking4bpp = encodeGba4bppSheet(walkingIndexed, { frameWidth, frameHeight, frameCount });
  const running4bpp = encodeGba4bppSheet(runningIndexed, { frameWidth, frameHeight, frameCount });
  const walkingRgba = renderIndexedSheetToRgba(walkingIndexed, paletteRgb, {
    width: sheetWidth,
    height: frameHeight,
  });
  const runningRgba = renderIndexedSheetToRgba(runningIndexed, paletteRgb, {
    width: sheetWidth,
    height: frameHeight,
  });

  return {
    rigId: schema.id,
    appearanceKey: schema.appearanceKey ?? 'brendan.on-foot',
    frameWidth,
    frameHeight,
    frameCount,
    customization: normalized,
    paletteRgb,
    reflectionPaletteRgb,
    gbaPalette16,
    gbaReflectionPalette16,
    walkingIndexed,
    runningIndexed,
    walking4bpp,
    running4bpp,
    walkingRgba,
    runningRgba,
  };
}
