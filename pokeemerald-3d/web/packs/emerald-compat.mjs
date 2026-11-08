// Temporary bridge between the generic shell composition and the current
// Emerald implementation. Keep game-specific helpers behind this module so
// app.js only passes an injected dependency set; other packs may ignore it.

import {
  FLASH_BASE,
  SAVE_BLOCK2_TRAINER_ID_OFFSET,
  createEmeraldSaveCodec,
} from './shared/save-codec-emerald.mjs';
import { createEmeraldScene } from './shared/scene-emerald.mjs';
import { createEmeraldWorldModel } from './shared/world-emerald.mjs';
import { createEmeraldPartyModel } from './shared/party-emerald.mjs';

const KEY_INPUT_OFFSET = 0x04000130 >> 1;
const KEY_MASK = 0x03ff;
const BUTTON_MASKS = Object.freeze({
  a: 1 << 0,
  b: 1 << 1,
  select: 1 << 2,
  start: 1 << 3,
  right: 1 << 4,
  left: 1 << 5,
  up: 1 << 6,
  down: 1 << 7,
  r: 1 << 8,
  l: 1 << 9,
});

export function createEmeraldCompatibilityContext() {
  return {
    createEmeraldSaveCodec,
    createEmeraldScene,
    createEmeraldWorldModel,
    createEmeraldPartyModel,
    createEmeraldRuntime(context) {
      const actualAbiVersion = context.manifest?.runtime?.abiVersion;
      if (actualAbiVersion !== 1) {
        throw new Error(`Emerald runtime adapter ABI mismatch: expected 1, got ${actualAbiVersion ?? 'missing'}`);
      }
      const runtime = context.shared.createWasmRuntime(context);
      return {
        ...runtime,
        abiVersion: 1,
        saveView(byteLength) {
          if (typeof context.getMemoryView !== 'function') {
            throw new Error('Emerald runtime requires the current memory-view provider');
          }
          return emeraldFlashView(context.getMemoryView(), byteLength);
        },
        setButtons(buttons = []) {
          let mask = 0;
          for (const button of buttons) mask |= BUTTON_MASKS[button] ?? 0;
          return writeInputMask(context, mask);
        },
        setInputMask(mask) {
          return writeInputMask(context, mask);
        },
        saveGame() {
          return context.shared.emeraldSaveGame(runtime.exports, context.getMemoryViews?.());
        },
        applyCharacterCustomization(compiled) {
          return applyEmeraldCharacterCustomization(runtime.exports, context.getMemoryViews?.(), compiled);
        },
      };
    },
    emeraldFlashView,
    emeraldTrainerId,
    emeraldSaveGame,
    applyEmeraldCharacterCustomization,
    legacyRunSettings(gameId, storage, legacyKey) {
      return gameId === 'emerald' ? storage.getItem(legacyKey) : null;
    },
  };
}

function writeInputMask(context, mask) {
  if (typeof context.getInputView !== 'function') {
    throw new Error('Emerald runtime requires the current input-memory view provider');
  }
  const inputView = context.getInputView();
  if (!inputView) throw new Error('Emerald input-memory view is unavailable');
  inputView[KEY_INPUT_OFFSET] = KEY_MASK ^ mask;
  return KEY_MASK ^ mask;
}

export function emeraldFlashView(memoryView, byteLength) {
  return memoryView.subarray(FLASH_BASE, FLASH_BASE + byteLength);
}

export function emeraldTrainerId(memoryView, saveBlock2) {
  return memoryView[(saveBlock2 + SAVE_BLOCK2_TRAINER_ID_OFFSET) >> 1];
}

export function emeraldSaveGame(exports, views) {
  if (!exports?.gSaveBlock1Ptr || !views?.u8 || typeof exports.TrySavingData !== 'function') return 0;
  if (typeof exports.WasmCanSaveGame === 'function' && !exports.WasmCanSaveGame()) return 0;
  const saveBlock1 = exports.gSaveBlock1Ptr.value;
  for (let i = 0; i < 8; i++) {
    views.u8[saveBlock1 + 0x0c + i] = views.u8[saveBlock1 + 0x04 + i];
  }
  return exports.TrySavingData(0);
}

export function applyEmeraldCharacterCustomization(exports, views, compiled) {
  if (!exports || !views?.u8 || !views?.u16 || !compiled) return false;
  let applied = false;
  if (compiled.gbaPalette16?.length === 16 && typeof exports.WasmPlayerPaletteBuffer === 'function') {
    const ptr = exports.WasmPlayerPaletteBuffer() >>> 0;
    if (ptr) {
      views.u16.set(compiled.gbaPalette16, ptr >>> 1);
      applied = true;
    }
  }
  if (compiled.gbaReflectionPalette16?.length === 16 && typeof exports.WasmPlayerReflectionPaletteBuffer === 'function') {
    const ptr = exports.WasmPlayerReflectionPaletteBuffer() >>> 0;
    if (ptr) {
      views.u16.set(compiled.gbaReflectionPalette16, ptr >>> 1);
      applied = true;
    }
  }
  if (compiled.walking4bpp?.byteLength === 2304 && typeof exports.WasmPlayerNormalPicBuffer === 'function') {
    const ptr = exports.WasmPlayerNormalPicBuffer() >>> 0;
    if (ptr) {
      views.u8.set(compiled.walking4bpp, ptr);
      applied = true;
    }
  }
  if (compiled.running4bpp?.byteLength === 2304 && typeof exports.WasmPlayerRunningPicBuffer === 'function') {
    const ptr = exports.WasmPlayerRunningPicBuffer() >>> 0;
    if (ptr) {
      views.u8.set(compiled.running4bpp, ptr);
      applied = true;
    }
  }
  if (applied && typeof exports.WasmApplyPlayerCustomization === 'function') {
    exports.WasmApplyPlayerCustomization();
  }
  return applied;
}
